import * as path from 'path';
import { BasePhase, OrchestrationContext, PhaseResult, updateTaskFireAndForget } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { TechLeadPhase } from './TechLeadPhase';
import { DevelopersPhase } from './DevelopersPhase';
import { approvalEvents } from '../ApprovalEvents';
// JudgePhase runs per-story inside DevelopersPhase, not as separate batch in multi-team mode
// QAPhase, FixerPhase, GitHubService, PRManagementService REMOVED - Judge handles quality validation per-story
import { safeGitExecSync, fixGitRemoteAuth, normalizeRepoName, smartGitFetch } from '../../utils/safeGitExecution';
import {
  validateRetryLimit,
  validateRepositoryRemotes,
  validateRequiredPhaseContext,
} from './utils/PhaseValidationHelpers';
import { isBillingError, BillingError } from './RetryService';
import { logCheckpointRecovery, logCriticalError } from './utils/LogHelpers';
import { assertValidWorkspacePath } from './utils/WorkspaceValidator';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 📦 Centralized skip logic
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { CostAccumulator } from './utils/CostAccumulator';
import { getEpicId, getEpicIdSafe, validateEpicIds } from './utils/IdNormalizer';
// ⏱️ Centralized timeout constants
import { GIT_TIMEOUTS, APPROVAL_TIMEOUTS } from './constants/Timeouts';
// 📦 SQLite Repository
import { TaskRepository } from '../../database/repositories/TaskRepository';

// TechLead approval timeout - use centralized constant
const TECH_LEAD_APPROVAL_TIMEOUT_MS = APPROVAL_TIMEOUTS.TECH_LEAD_APPROVAL;

/**
 * Team Orchestration Phase
 *
 * Implements Multi-Team parallel orchestration following Anthropic's recommendations
 * for complex problem-solving with Claude agents.
 *
 * Architecture:
 * - Receives epics from Planning phase (Sonnet orchestrator)
 * - Creates isolated team per epic
 * - Each team runs: TechLead → Developers → Judge
 * - All teams execute in parallel (Promise.allSettled)
 * - Aggregates results from all teams
 *
 * Benefits:
 * - Avoids token limits by splitting work across teams
 * - Enables parallel execution for faster completion
 * - Each team focuses on single epic (reduces complexity)
 * - Better cost optimization (Haiku for execution)
 */
export class TeamOrchestrationPhase extends BasePhase {
  readonly name = 'TeamOrchestration';
  readonly description = 'Coordinating parallel teams for each epic';

  constructor(
    private executeAgentFn: Function,
    private executeDeveloperFn: Function
    // githubService, prManagementService, workspaceDir REMOVED - were only used by QAPhase
  ) {
    super();
  }

  /**
   * 🎯 SINGLE SOURCE OF TRUTH: Get completed epic IDs from all sources
   *
   * This is THE ONLY method that should be used to read completed epics.
   * It reads from:
   * 1. UnifiedMemory (primary source)
   * 2. MongoDB (backup/fast access)
   * 3. Context (in-memory cache for current execution)
   *
   * Returns a deduplicated, merged list of all completed epic IDs.
   */
  private async getCompletedEpicIds(
    taskIdStr: string,
    task: any,
    context?: OrchestrationContext
  ): Promise<string[]> {
    const sources: { name: string; ids: string[] }[] = [];

    // 1️⃣ UnifiedMemory (primary)
    try {
      const resumption = await unifiedMemoryService.getResumptionPoint(taskIdStr);
      if (resumption && resumption.completedEpics && resumption.completedEpics.length > 0) {
        sources.push({ name: 'UnifiedMemory', ids: resumption.completedEpics });
      }
    } catch (error: any) {
      console.warn(`⚠️ [CHECKPOINT] Failed to read UnifiedMemory: ${error.message}`);
    }

    // 2️⃣ MongoDB (backup)
    const mongoCompleted = (task.orchestration as any)?.teamOrchestration?.completedEpicIds || [];
    if (mongoCompleted.length > 0) {
      sources.push({ name: 'MongoDB', ids: mongoCompleted });
    }

    // 3️⃣ Context (in-memory, if available)
    if (context) {
      const contextCompleted = context.getData<string[]>('completedEpicIds') || [];
      if (contextCompleted.length > 0) {
        sources.push({ name: 'Context', ids: contextCompleted });
      }
    }

    // Merge all sources (deduplicated)
    const allIds = sources.flatMap(s => s.ids);
    const merged = [...new Set(allIds)];

    // Log if sources differ (indicates sync issue)
    if (sources.length > 1) {
      const allSame = sources.every(s =>
        s.ids.length === merged.length &&
        s.ids.every(id => merged.includes(id))
      );
      if (!allSame) {
        console.log(`🔧 [CHECKPOINT] Merged completed epics from ${sources.length} sources:`);
        for (const source of sources) {
          console.log(`   ${source.name}: [${source.ids.join(', ')}]`);
        }
        console.log(`   Merged result: [${merged.join(', ')}]`);
      }
    }

    return merged;
  }

  /**
   * 🎯 UNIFIED MEMORY: Skip if all teams already completed
   *
   * Uses checkPhaseSkip helper for centralized skip logic.
   * Also tracks which epics are already completed for partial recovery.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;
    const taskId = (task.id as any).toString();

    // Use centralized skip logic (handles continuation check + unified memory)
    const skipResult = await checkPhaseSkip(context, { phaseName: 'TeamOrchestration' });
    if (skipResult.shouldSkip) {
      return true;
    }

    // 🔥 CHECKPOINT RECOVERY: Use SINGLE SOURCE OF TRUTH for completed epics
    // Even if phase is not skipped, we may have partial progress
    const completedEpicIds = await this.getCompletedEpicIds(taskId, task, context);

    if (completedEpicIds.length > 0) {
      logCheckpointRecovery('epic', completedEpicIds.length, completedEpicIds);
      // Store in context for executePhase to use
      context.setData('completedEpicIds', completedEpicIds);
    }

    console.log(`   ❌ Phase not completed - TeamOrchestration must execute`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();

    // Initialize teamOrchestration in task model
    if (!(context.task.orchestration as any).teamOrchestration) {
      (context.task.orchestration as any).teamOrchestration = {
        status: 'in_progress',
        startedAt: new Date(),
        teams: [],
      };
    }

    const startTime = new Date();
    (context.task.orchestration as any).teamOrchestration.status = 'in_progress';
    (context.task.orchestration as any).teamOrchestration.startedAt = startTime;

    // 🔥 FIRE-AND-FORGET: Non-blocking update to avoid MongoDB bottleneck
    updateTaskFireAndForget(task.id, {
      $set: {
        'orchestration.teamOrchestration.status': 'in_progress',
        'orchestration.teamOrchestration.startedAt': startTime,
      },
    }, 'teamOrch in_progress');

    NotificationService.emitAgentStarted(taskId, 'Team Orchestration');

    await LogService.agentStarted('team-orchestration', taskId, {
      phase: 'multi-team',
    });

    try {
      // 🔥 CRITICAL FIX: Validate retry limit BEFORE any processing (fail-fast)
      validateRetryLimit(context, 'teamOrchestration', 3);

      // 🔥 CRITICAL FIX: Validate required context from previous phases
      validateRequiredPhaseContext(context, 'teamOrchestration', ['repositories']);

      // Get EPICS from Planning phase - MUST support recovery after restart
      let planningEpics = context.getData<any[]>('epics') || [];

      // CRITICAL: Always check task model for epics (recovery after restart)
      if (planningEpics.length === 0) {
        const epicsFromTask = (task.orchestration.planning as any)?.epics || [];
        if (epicsFromTask && epicsFromTask.length > 0) {
          // Restore epics to context for this execution
          context.setData('epics', epicsFromTask);
          planningEpics = [...epicsFromTask]; // Create new array
          console.log(`🔄 [TeamOrchestration] RECOVERY: Restored ${epicsFromTask.length} epic(s) from database after restart`);
        }
      }

      // Final validation - MUST have epics to proceed
      if (!planningEpics || planningEpics.length === 0) {
        const planningStatus = task.orchestration.planning?.status;

        // 🔧 FIX: Also check Unified Memory (the source of truth for recovery scenarios)
        // MongoDB might not have planning.status set if the phase was skipped on recovery
        const planningCompletedInMemory = await unifiedMemoryService.shouldSkipPhase(taskId, 'Planning');

        if (planningStatus !== 'completed' && !planningCompletedInMemory) {
          throw new Error(`Cannot start TeamOrchestration: Planning phase is ${planningStatus || 'not started'}. Must complete Planning first.`);
        }

        // If Planning is completed but no epics, try to restore from Unified Memory
        if (planningCompletedInMemory) {
          console.log(`🔄 [TeamOrchestration] Planning completed in Unified Memory but no epics in context - attempting recovery...`);
          const resumption = await unifiedMemoryService.getResumptionPoint(taskId);

          if (resumption) {
            // 🔥 FIX: Epics are stored in phases.Planning.output.epics, NOT in executionMap.epics
            // executionMap.epics is for tracking epic execution status (EpicExecution[])
            // phases.Planning.output.epics contains the ORIGINAL epic data from Planning phase
            const planningOutput = resumption.executionMap?.phases?.Planning?.output;
            const planningEpicsFromMemory = planningOutput?.epics || [];

            if (planningEpicsFromMemory.length > 0) {
              planningEpics = planningEpicsFromMemory.map((e: any) => ({
                id: getEpicId(e), // 🔥 CENTRALIZED: Use IdNormalizer for consistent ID extraction
                title: e.title,
                ...e, // Keep all epic data (filesToModify, filesToCreate, targetRepository, etc.)
              }));
              context.setData('epics', planningEpics);
              console.log(`   ✅ Restored ${planningEpics.length} epics from Unified Memory (phases.Planning.output)`);

              // Also restore to task model for consistency (fire-and-forget)
              updateTaskFireAndForget(task.id, {
                $set: {
                  'orchestration.planning.epics': planningEpics,
                  'orchestration.planning.restoredFromUnifiedMemory': true,
                  'orchestration.planning.restoredAt': new Date(),
                },
              }, 'restore epics from unified memory');
              console.log(`   💾 Synced restored epics to task model (fire-and-forget)`);
            } else {
              // Fallback: Check if executionMap.epics has data (for backwards compatibility)
              if (resumption.executionMap?.epics && resumption.executionMap.epics.length > 0) {
                planningEpics = resumption.executionMap.epics.map((e: any) => ({
                  id: getEpicId(e), // 🔥 CENTRALIZED: Use IdNormalizer for consistent ID extraction
                  title: e.title,
                  ...e,
                }));
                context.setData('epics', planningEpics);
                console.log(`   ✅ Restored ${planningEpics.length} epics from Unified Memory (executionMap.epics fallback)`);
              }
            }
          }
        }

        // Final check after recovery attempt
        if (!planningEpics || planningEpics.length === 0) {
          throw new Error('No epics found from Planning phase - cannot create teams. Database may be corrupted or Planning output was invalid.');
        }
      }

      // 🚨 CRITICAL VALIDATION: Check epic quality
      // If Planning somehow passed invalid epics, BLOCK execution here
      const invalidEpics = planningEpics.filter(epic => {
        const hasFiles = (epic.filesToModify && epic.filesToModify.length > 0) ||
                        (epic.filesToCreate && epic.filesToCreate.length > 0);
        return !hasFiles;
      });

      if (invalidEpics.length > 0) {
        const invalidTitles = invalidEpics.map((e: any) => e.title || e.id).join(', ');
        logCriticalError('INVALID EPICS DETECTED', [
          `${invalidEpics.length} epic(s) have NO file paths`,
          `Invalid epics: ${invalidTitles}`,
          `This should have been caught by Planning validation`,
          `BLOCKING EXECUTION - Cannot proceed without file paths`,
        ]);

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `🚨 CRITICAL: Found ${invalidEpics.length} invalid epic(s) without file paths`
        );
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `⛔ EXECUTION BLOCKED - Cannot proceed to Tech Lead without concrete file paths`
        );

        throw new Error(
          `🚨 CRITICAL VALIDATION FAILURE: ${invalidEpics.length} epic(s) missing file paths: ${invalidTitles}. ` +
          `Planning must specify filesToModify or filesToCreate for each epic. ` +
          `This error indicates a validation bypass - execution blocked.`
        );
      }

      // 🔥 FIX: Validate targetRepository EARLY (before any processing)
      const epicsWithoutRepo = planningEpics.filter(epic => !epic.targetRepository);
      if (epicsWithoutRepo.length > 0) {
        const epicIds = epicsWithoutRepo.map((e: any) => getEpicIdSafe(e)).join(', ');
        logCriticalError('EPICS WITHOUT TARGET REPOSITORY', [
          `${epicsWithoutRepo.length} epic(s) have NO targetRepository assigned`,
          `Invalid epics: ${epicIds}`,
          `Each epic MUST specify which repository it belongs to`,
          `BLOCKING EXECUTION - Cannot proceed without repository assignment`,
        ]);

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `🚨 CRITICAL: ${epicsWithoutRepo.length} epic(s) missing targetRepository: ${epicIds}`
        );

        throw new Error(
          `🚨 CRITICAL VALIDATION FAILURE: ${epicsWithoutRepo.length} epic(s) missing targetRepository: ${epicIds}. ` +
          `Planning must assign a target repository to each epic. ` +
          `Available repositories: ${context.repositories.map(r => r.name).join(', ')}`
        );
      }

      console.log(`\n🎯 [TeamOrchestration] Found ${planningEpics.length} epic(s) from Planning`);
      console.log(`✅ [TeamOrchestration] All epics validated - have concrete file paths and target repositories`);

      // 🔥 CRITICAL FIX: Register epics in Unified Memory for recovery tracking
      // This was missing! Without this call, getResumptionPoint() returns empty completedEpics
      // because the epics array in execution map was never populated.
      // 🔥 VALIDATE FIRST: Fail fast if any epic has no extractable ID
      validateEpicIds(planningEpics);
      await unifiedMemoryService.registerEpics(
        taskId,
        planningEpics.map((e: any) => ({
          id: getEpicId(e), // 🔥 CENTRALIZED: Use IdNormalizer for consistent ID extraction
          title: e.title,
        }))
      );
      console.log(`📋 [TeamOrchestration] Registered ${planningEpics.length} epics in Unified Memory for recovery tracking`);

      // 🔥🔥🔥 CHECKPOINT RECOVERY: Use SINGLE SOURCE OF TRUTH for completed epics 🔥🔥🔥
      const completedEpicIds = await this.getCompletedEpicIds(taskId, task, context);

      if (completedEpicIds.length > 0) {
        const originalCount = planningEpics.length;
        planningEpics = planningEpics.filter((epic: any) => {
          const epicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer
          const alreadyCompleted = completedEpicIds.includes(epicId);
          if (alreadyCompleted) {
            console.log(`   ⏭️  SKIPPING epic "${epicId}" - already completed (checkpoint recovery)`);
          }
          return !alreadyCompleted;
        });

        console.log(`\n${'🔄'.repeat(30)}`);
        console.log(`🔄 [CHECKPOINT RECOVERY] Filtered epics: ${originalCount} → ${planningEpics.length} remaining`);
        console.log(`   Skipped: ${completedEpicIds.length} already completed epic(s)`);
        console.log(`   Remaining: ${planningEpics.map((e: any) => getEpicIdSafe(e)).join(', ') || 'none'}`);
        console.log(`${'🔄'.repeat(30)}\n`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 CHECKPOINT RECOVERY: Skipping ${completedEpicIds.length} completed epic(s), processing ${planningEpics.length} remaining`
        );

        // If all epics already completed, return success
        if (planningEpics.length === 0) {
          console.log(`✅ [TeamOrchestration] ALL EPICS ALREADY COMPLETED - nothing to do`);
          return {
            success: true,
            data: { message: 'All epics already completed (checkpoint recovery)', completedEpicIds },
          };
        }
      }

      // 🔥 CRITICAL FIX: Validate all repositories have valid git remotes BEFORE spawning teams
      // This prevents ALL team git operations from failing with unclear errors
      await validateRepositoryRemotes(
        context.repositories,
        'teamOrchestration',
        {
          allowedHosts: ['github.com', 'gitlab.com', 'bitbucket.org'],
          requireHttps: true,
        }
      );

      // 🔥 SEQUENTIAL EXECUTION BY EXECUTION ORDER
      // Group epics by executionOrder
      const epicsByOrder = new Map<number, any[]>();
      for (const epic of planningEpics) {
        const order = epic.executionOrder || 1;
        if (!epicsByOrder.has(order)) {
          epicsByOrder.set(order, []);
        }
        epicsByOrder.get(order)!.push(epic);
      }

      // Sort execution groups by order
      const orderedGroups = Array.from(epicsByOrder.entries()).sort((a, b) => a[0] - b[0]);

      console.log(`📋 [TeamOrchestration] Execution plan:`);
      for (const [order, epics] of orderedGroups) {
        console.log(`   Order ${order}: ${epics.length} epic(s) - ${epics.map((e: any) => e.targetRepository || 'unknown').join(', ')}`);
      }
      console.log(`   Strategy: Sequential by order, parallel within same order\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🎯 Sequential multi-repo execution: ${orderedGroups.length} phase(s)`
      );

      // 🔥 FIX: Wrapper type to carry epic info with result (prevents index mismatch)
      interface TeamResultWithEpic {
        result: PromiseSettledResult<any>;
        epicId: string;
        epicTitle: string;
        targetRepository: string;
      }
      let teamResults: TeamResultWithEpic[] = [];
      let teamCounter = 0;

      // Execute groups sequentially
      for (const [order, epics] of orderedGroups) {
        console.log(`\n🔧 [Phase ${order}] Executing ${epics.length} epic(s)...\n`);

        // 🔥🔥🔥 SIMPLIFICATION: ALWAYS SEQUENTIAL EXECUTION 🔥🔥🔥
        // Parallel execution was causing:
        // - Race conditions even with different repos
        // - Difficult debugging (interleaved logs)
        // - State divergence between EventStore/MongoDB
        // - 60%+ failure rate
        //
        // Sequential execution provides:
        // - Predictable, traceable execution
        // - Easy debugging (one epic at a time)
        // - Clear checkpoints between epics
        // - Better recovery (know exactly where we stopped)
        const reposInGroup = epics.map((e: any) => e.targetRepository);
        const uniqueRepos = new Set(reposInGroup);

        console.log(`\n🔒 [SEQUENTIAL MODE] Executing ${epics.length} epic(s) ONE AT A TIME`);
        console.log(`   Repositories: ${Array.from(uniqueRepos).join(', ')}`);
        console.log(`   ⚡ This ensures reliable, traceable execution\n`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔧 Phase ${order}: ${epics.length} epic(s) SEQUENTIAL (reliable mode)`
        );

        // SEQUENTIAL execution - one epic at a time, with checkpoint after each
        for (let epicIndex = 0; epicIndex < epics.length; epicIndex++) {
          const epic = epics[epicIndex];
          const epicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer

          console.log(`\n${'='.repeat(60)}`);
          console.log(`📦 [Epic ${epicIndex + 1}/${epics.length}] Starting: ${epic.title || epicId}`);
          console.log(`   Repository: ${epic.targetRepository}`);
          console.log(`   Epic ID: ${epicId}`);
          console.log(`${'='.repeat(60)}`);

          try {
            const result = await this.executeTeam(epic, ++teamCounter, context);

            // 🔥 FIX: Wrap result with epic info to prevent index mismatch
            teamResults.push({
              result: { status: 'fulfilled', value: result },
              epicId: epicId,
              epicTitle: epic.title || epicId,
              targetRepository: epic.targetRepository,
            });

            // 🔥🔥🔥 CHECKPOINT: Save epic completion IMMEDIATELY after success 🔥🔥🔥
            if (result.success) {
              await this.saveEpicCheckpoint(task.id, epicId, taskId);
              console.log(`✅ [Epic ${epicIndex + 1}/${epics.length}] COMPLETED: ${epic.title || epicId}`);
              console.log(`   📍 Checkpoint saved - safe to resume from here`);
            } else {
              console.warn(`⚠️ [Epic ${epicIndex + 1}/${epics.length}] FAILED: ${epic.title || epicId}`);
              console.warn(`   Error: ${result.error || 'Unknown error'}`);
            }
          } catch (error: any) {
            // 🔥 FIX: Wrap error with epic info
            teamResults.push({
              result: { status: 'rejected', reason: error },
              epicId: epicId,
              epicTitle: epic.title || epicId,
              targetRepository: epic.targetRepository,
            });

            console.error(`❌ [Epic ${epicIndex + 1}/${epics.length}] EXCEPTION: ${epic.title || epicId}`);
            console.error(`   Error: ${error.message || error}`);
          }
        }

        // Check if this phase failed (use wrapped results)
        const groupFailed = teamResults.slice(-epics.length).filter((r) =>
          r.result.status === 'rejected' || (r.result.status === 'fulfilled' && !r.result.value.success)
        ).length;

        if (groupFailed > 0) {
          console.log(`\n⚠️  [Phase ${order}] ${groupFailed}/${epics.length} epic(s) failed`);
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️  ${groupFailed} epic(s) failed in phase ${order} - continuing with next phase...`
          );
        } else {
          console.log(`\n✅ [Phase ${order}] All ${epics.length} epic(s) completed successfully`);
        }
      }

      // Aggregate results (use wrapped .result for status checks)
      const successfulTeams = teamResults.filter(r => r.result.status === 'fulfilled' && r.result.value.success);
      const failedTeams = teamResults.filter(r => r.result.status === 'rejected' || (r.result.status === 'fulfilled' && !r.result.value.success));

      // 🔥 BILLING ERROR DETECTION: Check if any failures are billing-related
      // Billing errors should NOT trigger Circuit Breaker - they're recoverable
      const billingFailedTeams: typeof teamResults = [];
      const actualFailedTeams: typeof teamResults = [];

      for (const wrappedResult of failedTeams) {
        const errorMessage = wrappedResult.result.status === 'rejected'
          ? (wrappedResult.result as PromiseRejectedResult).reason?.message || (wrappedResult.result as PromiseRejectedResult).reason
          : wrappedResult.result.value?.error || '';

        if (isBillingError({ message: errorMessage })) {
          billingFailedTeams.push(wrappedResult);
        } else {
          actualFailedTeams.push(wrappedResult);
        }
      }

      // 💰 BILLING ERROR PAUSE: If ANY team failed due to billing, pause for recovery
      if (billingFailedTeams.length > 0) {
        console.warn(`\n💰💰💰 BILLING ERROR DETECTED 💰💰💰`);
        console.warn(`   ${billingFailedTeams.length} team(s) failed due to billing/credit issues`);
        console.warn(`   ${actualFailedTeams.length} team(s) failed due to other errors`);
        console.warn(`   ${successfulTeams.length} team(s) completed successfully`);
        console.warn(`\n   🔄 PAUSING TASK - User can resume after recharging API credits`);
        console.warn(`💰💰💰💰💰💰💰💰💰💰💰💰💰💰💰\n`);

        // Update task status to paused_billing
        (context.task.orchestration as any).teamOrchestration.status = 'paused_billing';
        (context.task.orchestration as any).teamOrchestration.pausedAt = new Date();
        (context.task.orchestration as any).teamOrchestration.pauseReason = 'billing_error';
        (context.task.orchestration as any).teamOrchestration.completedTeams = successfulTeams.length;
        (context.task.orchestration as any).teamOrchestration.pendingTeams = billingFailedTeams.length;

        // 🔥 FIX: Use epicId directly from wrapped result instead of indexOf()
        const pendingEpicIds = billingFailedTeams.map((wrappedResult) => wrappedResult.epicId);
        (context.task.orchestration as any).teamOrchestration.pendingEpicIds = pendingEpicIds;

        task.status = 'paused';
        // 🔥 FIRE-AND-FORGET: Persist pause status without blocking
        updateTaskFireAndForget(task.id, {
          $set: {
            status: 'paused',
            'orchestration.teamOrchestration.pendingEpicIds': pendingEpicIds,
          },
        }, 'billing pause');

        // Notify frontend about billing pause
        NotificationService.emitNotification(taskId, 'billing_error_pause', {
          billingErrors: billingFailedTeams.length,
          completedTeams: successfulTeams.length,
          pendingTeams: billingFailedTeams.length,
          message: `⚠️ API credits exhausted. ${successfulTeams.length} teams completed. Recharge credits and resume.`,
          pendingEpicIds: pendingEpicIds,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `💰 BILLING PAUSE: ${billingFailedTeams.length} team(s) waiting. Recharge API credits and click "Resume" to continue.`
        );

        // Throw BillingError (special handling - can be resumed)
        throw new BillingError(
          `${billingFailedTeams.length} team(s) failed due to insufficient API credits. Task paused for recovery.`,
          'team-orchestration'
        );
      }

      // 🔥 CIRCUIT BREAKER: Stop if too many teams fail (EXCLUDING billing errors)
      const failureRate = actualFailedTeams.length / teamResults.length;
      const failureThreshold = parseFloat(process.env.TEAM_FAILURE_THRESHOLD || '0.5'); // 50% default

      if (failureRate > failureThreshold && teamResults.length > 1) {
        const { CircuitBreakerError } = await import('./RetryService');

        console.error(`\n❌ [CIRCUIT BREAKER] Too many teams failed: ${actualFailedTeams.length}/${teamResults.length} (${(failureRate * 100).toFixed(1)}%)`);
        console.error(`   Threshold: ${(failureThreshold * 100).toFixed(0)}%`);
        console.error(`   Note: ${billingFailedTeams.length} billing error(s) excluded from calculation`);
        console.error(`   Aborting orchestration to prevent further cost accumulation\n`);

        // Notify frontend
        NotificationService.emitNotification(taskId, 'circuit_breaker_triggered', {
          failedTeams: actualFailedTeams.length,
          totalTeams: teamResults.length,
          threshold: failureThreshold,
          billingErrorsExcluded: billingFailedTeams.length,
          message: `Circuit breaker: ${actualFailedTeams.length}/${teamResults.length} teams failed`
        });

        throw new CircuitBreakerError(
          actualFailedTeams.length,
          teamResults.length,
          failureThreshold
        );
      }

      console.log(`\n✅ [TeamOrchestration] ${successfulTeams.length}/${teamResults.length} team(s) completed successfully`);
      if (failedTeams.length > 0) {
        console.log(`❌ [TeamOrchestration] ${failedTeams.length} team(s) failed`);
      }

      // Store results in task
      (context.task.orchestration as any).teamOrchestration.status = failedTeams.length === 0 ? 'completed' : 'partial';
      (context.task.orchestration as any).teamOrchestration.completedAt = new Date();

      // 🔥 CRITICAL: Aggregate costs AND token usage from all teams using CostAccumulator
      const teamCostsAccum = new CostAccumulator();

      // 🔥 FIX: Use epicId/epicTitle from wrapped result instead of planningEpics[idx]
      // This prevents index mismatch when epics are filtered during checkpoint recovery
      (context.task.orchestration as any).teamOrchestration.teams = teamResults.map((wrappedResult) => {
        const { result, epicId, epicTitle } = wrappedResult;

        if (result.status === 'fulfilled' && result.value.teamCosts) {
          const costs = result.value.teamCosts;

          // Accumulate costs and tokens from each team using CostAccumulator
          teamCostsAccum.add('techLead', costs.techLead || 0, costs.techLeadUsage);
          teamCostsAccum.add('judge', costs.judge || 0, costs.judgeUsage);
          teamCostsAccum.add('developer', costs.developers || 0, costs.developersUsage);

          return {
            epicId: epicId,
            epicTitle: epicTitle,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
            costs: costs, // Store individual team costs
          };
        } else if (result.status === 'fulfilled') {
          return {
            epicId: epicId,
            epicTitle: epicTitle,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
          };
        } else {
          return {
            epicId: epicId,
            epicTitle: epicTitle,
            status: 'failed',
            error: (result as PromiseRejectedResult).reason?.message || 'Unknown error',
          };
        }
      });

      // Update aggregated costs AND token usage in the main orchestration fields for breakdown display
      const techLeadCost = teamCostsAccum.getCost('techLead');
      const judgeCost = teamCostsAccum.getCost('judge');
      const developersCost = teamCostsAccum.getCost('developer');
      const techLeadTokens = teamCostsAccum.getTokens('techLead');
      const judgeTokens = teamCostsAccum.getTokens('judge');

      if (techLeadCost > 0) {
        if (!task.orchestration.techLead) {
          task.orchestration.techLead = { agent: 'tech-lead', status: 'completed' } as any;
        }
        // Preserve existing usage data if it exists, or create new
        if (!task.orchestration.techLead.usage) {
          task.orchestration.techLead.usage = {
            input_tokens: techLeadTokens.input,
            output_tokens: techLeadTokens.output,
          };
        }
        task.orchestration.techLead.cost_usd = techLeadCost;
        console.log(`💰 Total Tech Lead cost across all teams: ${CostAccumulator.formatCost(techLeadCost)}`);
      }

      if (judgeCost > 0) {
        if (!task.orchestration.judge) {
          task.orchestration.judge = { agent: 'judge', status: 'completed' } as any;
        }
        if (!task.orchestration.judge!.usage) {
          task.orchestration.judge!.usage = {
            input_tokens: judgeTokens.input,
            output_tokens: judgeTokens.output,
          };
        }
        task.orchestration.judge!.cost_usd = judgeCost;
        console.log(`💰 Total Judge cost across all teams: ${CostAccumulator.formatCost(judgeCost)}`);
      }

      // Track developers cost separately
      if (developersCost > 0) {
        console.log(`💰 Total Developers cost across all teams: ${CostAccumulator.formatCost(developersCost)}`);
        // Note: Developers cost is not shown separately in the breakdown UI
      }

      // For developers, add to team array
      if (developersCost > 0 && !task.orchestration.team) {
        task.orchestration.team = [];
      }

      // 🔥 FIRE-AND-FORGET: Accumulate ALL team costs using ATOMIC operation
      // When multiple teams run in parallel, using $inc ensures no lost updates
      const totalTeamsCost = teamCostsAccum.getTotalCost();
      if (totalTeamsCost > 0) {
        // Update local estimate (fire-and-forget to DB)
        const estimatedTotal = (task.orchestration.totalCost || 0) + totalTeamsCost;
        task.orchestration.totalCost = estimatedTotal;

        // 🔥 FIRE-AND-FORGET: Non-blocking cost update
        updateTaskFireAndForget(task.id, {
            $inc: { 'orchestration.totalCost': totalTeamsCost },
            $set: {
              'orchestration.teamOrchestration.status': (context.task.orchestration as any).teamOrchestration.status,
              'orchestration.teamOrchestration.completedAt': (context.task.orchestration as any).teamOrchestration.completedAt,
              'orchestration.teamOrchestration.teams': (context.task.orchestration as any).teamOrchestration.teams,
              // Update agent costs
              ...(techLeadCost > 0 ? { 'orchestration.techLead.cost_usd': techLeadCost } : {}),
              ...(judgeCost > 0 ? { 'orchestration.judge.cost_usd': judgeCost } : {}),
            }
          }, 'teamOrch costs');

        console.log(`💰 [TeamOrchestration] Total cost from all teams: ${CostAccumulator.formatCost(totalTeamsCost)} (fire-and-forget)`);
        console.log(`💰 [TeamOrchestration] Running orchestration total: $${estimatedTotal.toFixed(4)} (estimated)`);
      } else {
        // 🔥 FIRE-AND-FORGET: Save status without blocking
        updateTaskFireAndForget(task.id, {
          $set: {
            'orchestration.teamOrchestration.status': (context.task.orchestration as any).teamOrchestration.status,
            'orchestration.teamOrchestration.completedAt': (context.task.orchestration as any).teamOrchestration.completedAt,
            'orchestration.teamOrchestration.teams': (context.task.orchestration as any).teamOrchestration.teams,
          },
        }, 'teamOrch completed (no cost)');
      }

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Team Orchestration',
        `${successfulTeams.length}/${teamResults.length} teams completed successfully`
      );

      await LogService.agentCompleted('team-orchestration', taskId, {
        phase: 'multi-team',
        metadata: {
          totalTeams: teamResults.length,
          successfulTeams: successfulTeams.length,
          failedTeams: failedTeams.length,
        },
      });

      // Collect error messages from failed teams
      const failedTeamErrors: string[] = [];
      for (const wrappedResult of failedTeams) {
        const teamResult = wrappedResult.result;
        if (teamResult.status === 'rejected') {
          failedTeamErrors.push(`Team [${wrappedResult.epicId}] rejected: ${teamResult.reason?.message || teamResult.reason}`);
        } else if (teamResult.status === 'fulfilled' && !teamResult.value.success) {
          failedTeamErrors.push(`Team [${wrappedResult.epicId}] failed: ${teamResult.value.error || 'Unknown error'}`);
        }
      }

      return {
        success: failedTeams.length === 0,
        error: failedTeams.length > 0 ? failedTeamErrors.join('; ') : undefined,
        data: {
          totalTeams: teamResults.length,
          successfulTeams: successfulTeams.length,
          failedTeams: failedTeams.length,
          teamResults: teamResults,
        },
        warnings: failedTeams.length > 0 ? [`${failedTeams.length} teams failed`] : undefined,
      };
    } catch (error: any) {
      (context.task.orchestration as any).teamOrchestration.status = 'failed';
      (context.task.orchestration as any).teamOrchestration.error = error.message;

      // 🔥 FIRE-AND-FORGET: Save error status without blocking
      updateTaskFireAndForget(task.id, {
        $set: {
          'orchestration.teamOrchestration.status': 'failed',
          'orchestration.teamOrchestration.error': error.message,
        },
      }, 'teamOrch failed');

      NotificationService.emitAgentFailed(taskId, 'Team Orchestration', error.message);

      await LogService.agentFailed('team-orchestration', taskId, error, {
        phase: 'multi-team',
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute a single team for one epic
   *
   * Team pipeline:
   * 1. Create branch for epic
   * 2. TechLead divides epic into stories + assigns devs
   * 3. Developers implement (each dev works on 1 story)
   * 4. Judge reviews code and validates quality
   */
  private async executeTeam(
    epic: any,
    teamNumber: number,
    parentContext: OrchestrationContext
  ): Promise<{
    success: boolean;
    error?: string;
    teamCosts?: {
      techLead: number;
      developers: number;
      judge: number;
      total: number;
      techLeadUsage?: { input: number; output: number };
      developersUsage?: { input: number; output: number };
      judgeUsage?: { input: number; output: number };
    };
    epicId?: string;
  }> {
    const taskId = (parentContext.task.id as any).toString();

    // 🔥 CRITICAL: Check MongoDB connection before starting team
    const { isMongoConnected, waitForMongoConnection } = require('../../config/database');
    if (!isMongoConnected()) {
      console.warn(`⚠️  [Team ${teamNumber}] MongoDB disconnected - waiting for reconnection...`);
      const reconnected = await waitForMongoConnection(30000); // Wait up to 30 seconds
      if (!reconnected) {
        throw new Error(`MongoDB connection lost - cannot proceed with team ${teamNumber} execution`);
      }
      console.log(`✅ [Team ${teamNumber}] MongoDB reconnected - proceeding with execution`);
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🏃 [Team ${teamNumber}] Starting execution for EPIC: ${epic.id}`);
    console.log(`   Epic: ${epic.title}`);
    console.log(`   Complexity: ${epic.estimatedComplexity}`);
    console.log(`   Repositories: ${epic.affectedRepositories?.join(', ') || 'Not specified'}`);
    console.log(`${'='.repeat(80)}\n`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `\n🏃 Team ${teamNumber} starting epic: ${epic.title}\n`
    );

    try {
      // 1️⃣ Get or create branch for this epic
      // Priority: epic.branchName (if already set) > UnifiedMemory > generate DETERMINISTIC name
      // 🔥 CRITICAL: Branch names must be DETERMINISTIC for predictable recovery
      // Using only taskId + epicId (no Date.now() or Math.random())
      let branchName: string;

      // 🔥 RECOVERY: Try to restore branch from UnifiedMemory if not on epic object
      if (!epic.branchName) {
        try {
          const epicId = getEpicId(epic);
          const unifiedBranch = await unifiedMemoryService.getEpicBranch(taskId, epicId);
          if (unifiedBranch) {
            epic.branchName = unifiedBranch; // getEpicBranch returns the branch name string directly
            console.log(`   🔄 [Team ${teamNumber}] Restored epic branch from UnifiedMemory: ${epic.branchName}`);
          }
        } catch (error: any) {
          console.log(`   ⚠️ [Team ${teamNumber}] UnifiedMemory branch recovery failed: ${error.message}`);
        }
      }

      if (epic.branchName) {
        // Use existing branch name from EventStore/context/UnifiedMemory
        branchName = epic.branchName;
        console.log(`   📌 [Team ${teamNumber}] Using EXISTING epic branch: ${branchName}`);
      } else {
        // Generate DETERMINISTIC branch name (same inputs = same branch name)
        const taskShortId = (parentContext.task.id as any).toString().slice(-8);
        const epicSlug = epic.id.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
        // Use simple hash of epicId for uniqueness without randomness
        const epicHash = epic.id.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString(36).slice(-6);
        branchName = `epic/${taskShortId}-${epicSlug}-${epicHash}`;
        console.log(`   📌 [Team ${teamNumber}] Creating DETERMINISTIC epic branch: ${branchName}`);
      }
      const workspacePath = parentContext.workspacePath;

      // 🔥 CRITICAL VALIDATION: workspacePath MUST be valid for team operations
      assertValidWorkspacePath(workspacePath, `Team ${teamNumber}`);
      console.log(`   ✅ [Team ${teamNumber}] Workspace path valid: ${workspacePath}`);

      // 🔥 CRITICAL: Epic MUST have targetRepository - NO FALLBACKS
      if (!epic.targetRepository) {
        console.error(`\n❌❌❌ [Team ${teamNumber}] CRITICAL ERROR: Epic has NO targetRepository!`);
        console.error(`   Epic: ${epic.title}`);
        console.error(`   Epic ID: ${epic.id}`);
        console.error(`\n   💀 CANNOT CREATE BRANCH WITHOUT KNOWING WHICH REPOSITORY`);
        console.error(`\n   🛑 STOPPING - HUMAN INTERVENTION REQUIRED`);
        throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository in createEpicBranch`);
      }

      // 🔥 NORMALIZE: Remove .git suffix if present (Planning may add it, but DB doesn't have it)
      const targetRepository = normalizeRepoName(epic.targetRepository);
      let pushSuccessful = false;

      // 🔥🔥🔥 ISOLATED WORKSPACE: Each team gets its own copy of the repository
      // This prevents git conflicts when multiple teams work in parallel on the same repo
      const fs = require('fs');

      const teamWorkspacePath = `${workspacePath}/team-${teamNumber}`;
      const isolatedRepoPath = `${teamWorkspacePath}/${targetRepository}`;
      const sourceRepoPath = `${workspacePath}/${targetRepository}`;

      console.log(`\n🔒 [Team ${teamNumber}] Creating ISOLATED workspace...`);
      console.log(`   Source repo: ${sourceRepoPath}`);
      console.log(`   Isolated workspace: ${teamWorkspacePath}`);

      // Create team directory
      if (!fs.existsSync(teamWorkspacePath)) {
        fs.mkdirSync(teamWorkspacePath, { recursive: true });
        console.log(`✅ [Team ${teamNumber}] Created team directory: ${teamWorkspacePath}`);
      }

      // 🔥 FIX: Remove stale isolated workspace before copying
      // This prevents the "nested folder" bug where cp -r copies INTO existing directory
      // instead of replacing it, creating: repo/repo/src instead of repo/src
      if (fs.existsSync(isolatedRepoPath)) {
        console.log(`⚠️  [Team ${teamNumber}] Removing stale isolated workspace: ${isolatedRepoPath}`);
        fs.rmSync(isolatedRepoPath, { recursive: true, force: true });
      }

      // Copy repository to isolated workspace
      if (!fs.existsSync(sourceRepoPath)) {
        throw new Error(`Source repository not found: ${sourceRepoPath}`);
      }

      console.log(`📋 [Team ${teamNumber}] Copying repository to isolated workspace...`);
      // Use cp -r to copy the entire repository including .git
      const { execSync } = require('child_process');
      execSync(`cp -r "${sourceRepoPath}" "${isolatedRepoPath}"`, { encoding: 'utf8' });
      console.log(`✅ [Team ${teamNumber}] Repository copied to: ${isolatedRepoPath}`);

      if (workspacePath && targetRepository) {
        console.log(`\n🌿 [Team ${teamNumber}] Creating branch: ${branchName}`);
        console.log(`   Repository: ${targetRepository}`);
        console.log(`   Isolated path: ${isolatedRepoPath}`);

        // 🔥 USE ISOLATED REPO PATH instead of shared workspace
        const repoPath = isolatedRepoPath;

        // 🔥 CRITICAL: Verify repository directory exists
        const fs = require('fs');
        if (!fs.existsSync(repoPath)) {
          console.error(`❌ [Team ${teamNumber}] Repository directory does not exist: ${repoPath}`);
          console.error(`   Workspace: ${workspacePath}`);
          console.error(`   Target repo: ${targetRepository}`);
          console.error(`   Available repos: ${parentContext.repositories.map((r: any) => r.name || r.full_name).join(', ')}`);
          throw new Error(`Repository directory not found: ${repoPath}`);
        }

        console.log(`✅ [Team ${teamNumber}] Repository directory verified: ${repoPath}`);

        try {
          // Create epic branch LOCALLY (will be pushed later with commits)
          // Epic branch should be created from current HEAD (main or whatever is checked out)
          // but NOT pushed until it has actual commits from work
          console.log(`🌿 [Team ${teamNumber}] Creating epic branch locally: ${branchName}`);

          // Ensure we start from a clean state
          try {
            safeGitExecSync(`git checkout main`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [Team ${teamNumber}] Checked out main branch as base`);
          } catch (mainError: any) {
            console.warn(`⚠️  [Team ${teamNumber}] Could not checkout main: ${mainError.message}`);
            // Continue - use current branch as base
          }

          safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          console.log(`✅ [Team ${teamNumber}] Epic branch created locally: ${branchName}`);

          // 🔥 CRITICAL: Create initial commit in epic branch
          // This ensures epic branch has a base for story branches to branch from
          // NOTE: Using --allow-empty to avoid creating EPIC_*.md tracking files
          // that would pollute the production repository when merged
          safeGitExecSync(`git commit --allow-empty -m "chore: Initialize epic ${epic.id} - ${epic.title}"`, {
            cwd: repoPath,
            encoding: 'utf8'
          });
          console.log(`✅ [Team ${teamNumber}] Created initial empty commit in epic branch`);

          // Push epic branch with initial commit
          try {
            fixGitRemoteAuth(repoPath);
            safeGitExecSync(`git push -u origin ${branchName}`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: GIT_TIMEOUTS.FETCH
            });
            console.log(`✅ [Team ${teamNumber}] Epic branch pushed to remote with initial commit`);
            pushSuccessful = true;

            // FIX: Sync local with remote after push
            try {
              safeGitExecSync(`git pull origin ${branchName} --ff-only`, {
                cwd: repoPath,
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.CHECKOUT
              });
              console.log(`✅ [Team ${teamNumber}] Local synced with remote`);
            } catch (pullError: any) {
              console.log(`   ℹ️ [Team ${teamNumber}] Pull skipped (already up to date)`);
            }
          } catch (pushError: any) {
            console.error(`❌ [Team ${teamNumber}] Failed to push epic branch: ${pushError.message}`);
            pushSuccessful = false;
            throw new Error(`Cannot proceed without epic branch on remote: ${pushError.message}`);
          }

          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `✅ Team ${teamNumber}: Created and pushed branch ${branchName} in ${targetRepository}`
          );
        } catch (gitError: any) {
          // Branch might already exist
          console.log(`⚠️  [Team ${teamNumber}] Branch might already exist: ${gitError.message}`);
          try {
            safeGitExecSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [Team ${teamNumber}] Checked out existing branch: ${branchName}`);

            // 🔥 CRITICAL: Sync with remote before pushing (handles resume scenarios)
            try {
              console.log(`📤 [Team ${teamNumber}] Ensuring epic branch is synced with remote...`);

              // Fix remote auth before any remote operations
              fixGitRemoteAuth(repoPath);

              // 🔄 PULL FIRST: Get any commits from remote that we don't have locally
              // This is critical for resume scenarios where remote has work from previous runs
              try {
                safeGitExecSync(`git pull origin ${branchName} --rebase`, {
                  cwd: repoPath,
                  encoding: 'utf8',
                  timeout: GIT_TIMEOUTS.FETCH
                });
                console.log(`✅ [Team ${teamNumber}] Pulled latest from remote`);
              } catch (pullError: any) {
                // Branch might not exist on remote yet, that's fine
                console.log(`   ℹ️ [Team ${teamNumber}] Pull skipped: ${pullError.message.split('\n')[0]}`);
              }

              // Now push (should succeed since we pulled first)
              safeGitExecSync(`git push -u origin ${branchName}`, {
                cwd: repoPath,
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.FETCH
              });
              console.log(`✅ [Team ${teamNumber}] Epic branch confirmed on remote: ${branchName}`);
            } catch (pushError: any) {
              // If push still fails, try force-with-lease as last resort
              console.log(`⚠️  [Team ${teamNumber}] Normal push failed, trying force-with-lease...`);
              try {
                safeGitExecSync(`git push -u origin ${branchName} --force-with-lease`, {
                  cwd: repoPath,
                  encoding: 'utf8',
                  timeout: GIT_TIMEOUTS.FETCH
                });
                console.log(`✅ [Team ${teamNumber}] Epic branch force-pushed to remote`);
              } catch (forceError: any) {
                console.log(`ℹ️  [Team ${teamNumber}] Branch push result: ${forceError.message.split('\n')[0]}`);
              }
            }
          } catch (checkoutError: any) {
            console.error(`❌ [Team ${teamNumber}] Failed to create/checkout branch: ${checkoutError.message}`);
          }
        }
      }

      // 2️⃣ Create isolated context for this team
      // 🔥🔥🔥 USE ISOLATED WORKSPACE PATH - each team has its own copy of the repo
      const teamContext = new OrchestrationContext(
        parentContext.task,
        parentContext.repositories,
        teamWorkspacePath  // 🔥 ISOLATED workspace, not shared!
      );

      // Share workspace structure, attachments, and devAuth
      teamContext.setData('workspaceStructure', parentContext.getData('workspaceStructure'));
      teamContext.setData('attachments', parentContext.getData('attachments'));

      // 🔐 CRITICAL: Pass devAuth to team context (for testing authenticated endpoints)
      const devAuth = parentContext.getData<any>('devAuth');
      if (devAuth) {
        teamContext.setData('devAuth', devAuth);
        console.log(`🔐 [Team ${teamNumber}] DevAuth passed to team context: method=${devAuth.method}`);
      }

      // Store epic for this team to work on (Tech Lead will divide into stories)
      // 🔥 CRITICAL: Add the unique branchName to the epic object
      const epicWithBranch = { ...epic, branchName: branchName };
      teamContext.setData('teamEpic', epicWithBranch);
      teamContext.setData('epicBranch', branchName);
      teamContext.setData('targetRepository', targetRepository); // 🔥 Pass repository name to team
      teamContext.setData('isolatedWorkspacePath', teamWorkspacePath); // 🔥 Store isolated path for reference

      // 🌿 REGISTER EPIC BRANCH IN CENTRAL REGISTRY
      teamContext.registerBranch({
        name: branchName,
        type: 'epic',
        repository: targetRepository,
        baseBranch: 'main',
        created: true,
        pushed: pushSuccessful,
        merged: false,
      });
      console.log(`🌿 [Team ${teamNumber}] Registered epic branch: ${branchName} → ${targetRepository} (pushed: ${pushSuccessful})`);

      // 🔥 CRITICAL: Update EventStore with the actual branch name
      // This allows all downstream phases (Developers, Judge, QA) to access the correct branch
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: parentContext.task.id as any,
        eventType: 'EpicBranchCreated' as any,
        agentName: 'team-orchestration',
        payload: {
          epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          branchName: branchName,
          targetRepository: targetRepository,
        },
      });
      console.log(`📝 [Team ${teamNumber}] Stored epic branch in EventStore: ${branchName}`);

      // 🔥 CRITICAL FOR RECOVERY: Save epic branch to Unified Memory
      // This ensures Developers phase knows which branch to work on after restart
      await unifiedMemoryService.saveEpicBranch(
        this.getTaskIdString(parentContext),
        getEpicId(epic),
        branchName,
        targetRepository
      );
      console.log(`💾 [Team ${teamNumber}] Saved epic branch to Unified Memory: ${branchName}`);

      // Execute team pipeline
      // SIMPLIFIED: TechLead → Developers (includes Judge per-story) → PR
      // QA and Fixer phases REMOVED - Judge handles quality validation per-story
      const techLeadPhase = new TechLeadPhase(this.executeAgentFn);
      const developersPhase = new DevelopersPhase(
        this.executeDeveloperFn,
        this.executeAgentFn // For Judge execution inside DevelopersPhase
      );

      // Initialize cost tracking for this team
      const teamCosts = {
        techLead: 0,
        developers: 0,
        judge: 0,
        total: 0
      };

      // 🔄 TECH LEAD EXECUTION + APPROVAL LOOP
      // User can review and provide feedback on architecture before developers start
      // If rejected with feedback, re-execute TechLead with feedback as directive
      const autoApprovalEnabled = parentContext.task.orchestration.autoApprovalEnabled;
      const autoApprovalPhases = parentContext.task.orchestration.autoApprovalPhases || [];
      const techLeadAutoApproved = autoApprovalEnabled && autoApprovalPhases.includes('tech-lead' as any);

      const MAX_TECH_LEAD_RETRIES = 3;
      let techLeadRetryCount = 0;
      let techLeadResult: any = null;
      let techLeadApproved = false; // 🔥 FIX: Start as false, execute TechLead first, THEN check approval

      // 🔥 FIX: Use do-while pattern to ensure TechLead executes at least once
      // Previous bug: when auto-approval enabled, while(!true) never executed
      do {
        // Tech Lead: Design architecture for this epic
        console.log(`\n[Team ${teamNumber}] Phase 1: Tech Lead (Architecture)${techLeadRetryCount > 0 ? ` - Attempt ${techLeadRetryCount + 1}/${MAX_TECH_LEAD_RETRIES}` : ''}`);

        if (techLeadRetryCount > 0) {
          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `🔄 [Team ${teamNumber}] Re-executing Tech Lead with user feedback (attempt ${techLeadRetryCount + 1}/${MAX_TECH_LEAD_RETRIES})`
          );
        }

        techLeadResult = await techLeadPhase.execute(teamContext);
        if (!techLeadResult.success) {
          throw new Error(`Tech Lead failed: ${techLeadResult.error}`);
        }

        // Track Tech Lead cost and tokens (check both metadata and metrics)
        const techLeadCost = Number(techLeadResult.metadata?.cost || techLeadResult.metrics?.cost_usd || 0);
        const techLeadUsage = {
          input: Number(techLeadResult.metadata?.input_tokens || techLeadResult.metrics?.input_tokens || 0),
          output: Number(techLeadResult.metadata?.output_tokens || techLeadResult.metrics?.output_tokens || 0),
        };
        if (techLeadCost > 0) {
          (teamCosts as any).techLead = ((teamCosts as any).techLead || 0) + techLeadCost;
          (teamCosts as any).techLeadUsage = techLeadUsage;
          console.log(`💰 [Team ${teamNumber}] Tech Lead cost: $${techLeadCost.toFixed(4)} (${techLeadUsage.input + techLeadUsage.output} tokens)`);
        }

        // 🔥 FIX: If TechLead was SKIPPED (already completed), don't require approval
        // Phase was skipped = already approved in a previous run
        if (techLeadResult.warnings?.includes('Phase was skipped')) {
          console.log(`✅ [Team ${teamNumber}] Tech Lead was skipped (already completed) - no approval needed`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Tech Lead skipped (already completed) for epic: ${epic.title}`);
          techLeadApproved = true;
          break; // Exit loop - no need to wait for approval
        }

        // 🛑 TECH LEAD APPROVAL GATE - Check auto-approval AFTER execution
        if (techLeadAutoApproved) {
          console.log(`✅ [Team ${teamNumber}] Tech Lead auto-approved (configured)`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Tech Lead auto-approved for epic: ${epic.title}`);
          techLeadApproved = true;
          break; // Exit loop - no need to wait for manual approval
        }

        console.log(`\n⏸️  [Team ${teamNumber}] Waiting for Tech Lead approval...`);

        // 🔥 CRITICAL: Persist pendingApproval to DB so bypass endpoint can find it
        const currentTask = TaskRepository.findById(parentContext.task.id);
        if (currentTask) {
          const orchestration = currentTask.orchestration || {};
          orchestration.pendingApproval = {
            phase: 'tech-lead',
            phaseName: `Tech Lead Architecture (Epic: ${epic.title})`,
            agentOutput: techLeadResult.data || {},
            retryCount: techLeadRetryCount,
            timestamp: new Date(),
          };
          TaskRepository.update(parentContext.task.id, { orchestration });
        }
        console.log(`📝 [Team ${teamNumber}] Persisted pendingApproval to DB for bypass support`);

        // Emit approval required notification
        NotificationService.emitApprovalRequired(taskId, {
          phase: 'tech-lead',
          phaseName: `Tech Lead Architecture (Epic: ${epic.title})`,
          agentName: 'Tech Lead',
          approvalType: 'planning',
          agentOutput: techLeadResult.data || {},
          retryCount: techLeadRetryCount,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `⏸️ [Team ${teamNumber}] Waiting for Tech Lead architecture approval for epic: ${epic.title}`
        );

        try {
          const approvalResult = await approvalEvents.waitForApproval(
            taskId,
            'tech-lead',
            TECH_LEAD_APPROVAL_TIMEOUT_MS
          );

          // 🔥 FIRE-AND-FORGET: Clear pendingApproval from DB after processing
          updateTaskFireAndForget(parentContext.task.id, {
            $unset: { 'orchestration.pendingApproval': 1 },
          }, 'clear pendingApproval');
          console.log(`📝 [Team ${teamNumber}] Cleared pendingApproval from DB (fire-and-forget)`);

          if (approvalResult.approved) {
            console.log(`✅ [Team ${teamNumber}] Tech Lead architecture approved`);
            NotificationService.emitConsoleLog(taskId, 'info', `✅ Tech Lead architecture approved - continuing to development`);

            // Emit approval granted for frontend
            NotificationService.emitApprovalGranted(taskId, {
              phase: 'tech-lead',
              approved: true,
            });

            techLeadApproved = true;
          } else {
            // Rejected - check if there's feedback for re-execution
            techLeadRetryCount++;

            if (approvalResult.feedback && techLeadRetryCount < MAX_TECH_LEAD_RETRIES) {
              console.log(`🔄 [Team ${teamNumber}] Tech Lead rejected with feedback - will re-execute`);
              console.log(`   Feedback: ${approvalResult.feedback}`);
              NotificationService.emitConsoleLog(
                taskId,
                'warn',
                `🔄 Tech Lead rejected with feedback. Re-executing (${techLeadRetryCount}/${MAX_TECH_LEAD_RETRIES})...`
              );

              // Inject user feedback as directive for re-execution
              const existingDirectives = teamContext.getData<any[]>('injectedDirectives') || [];
              teamContext.setData('injectedDirectives', [
                ...existingDirectives,
                {
                  id: `user-feedback-${Date.now()}`,
                  content: `🚨 USER FEEDBACK (CRITICAL - ADDRESS THIS!):\n${approvalResult.feedback}`,
                  priority: 'critical',
                  targetAgent: 'tech-lead',
                  source: 'user-rejection',
                },
              ]);

              // Emit rejection notification (not approval_granted)
              NotificationService.emitApprovalGranted(taskId, {
                phase: 'tech-lead',
                approved: false,
                feedback: approvalResult.feedback,
                willRetry: true,
              });

              // Continue loop to re-execute TechLead
            } else if (!approvalResult.feedback) {
              console.log(`❌ [Team ${teamNumber}] Tech Lead rejected without feedback - cannot re-execute`);
              NotificationService.emitConsoleLog(taskId, 'error', `❌ Tech Lead rejected without feedback - task failed`);

              NotificationService.emitApprovalGranted(taskId, {
                phase: 'tech-lead',
                approved: false,
              });

              throw new Error('Tech Lead architecture rejected by user without feedback');
            } else {
              console.log(`❌ [Team ${teamNumber}] Tech Lead rejected - max retries (${MAX_TECH_LEAD_RETRIES}) reached`);
              NotificationService.emitConsoleLog(taskId, 'error', `❌ Tech Lead max retries reached - task failed`);

              NotificationService.emitApprovalGranted(taskId, {
                phase: 'tech-lead',
                approved: false,
                maxRetriesReached: true,
              });

              throw new Error(`Tech Lead architecture rejected after ${MAX_TECH_LEAD_RETRIES} attempts`);
            }
          }
        } catch (error: any) {
          if (error.message.includes('timeout')) {
            console.log(`⏱️  [Team ${teamNumber}] Tech Lead approval timeout - auto-continuing`);
            NotificationService.emitConsoleLog(taskId, 'warn', `⏱️ Tech Lead approval timeout - auto-continuing`);
            techLeadApproved = true; // Continue on timeout
          } else {
            throw error;
          }
        }
      } while (!techLeadApproved && techLeadRetryCount < MAX_TECH_LEAD_RETRIES);

      // Ensure techLeadResult is available after the loop
      if (!techLeadResult) {
        throw new Error('Tech Lead did not produce a result');
      }

      // 🐳 Apply TechLead environment configuration if available
      // Sources (in priority order):
      // 1. EnvironmentConfigDefined event
      // 2. task.orchestration.environmentConfig (persisted in DB)
      try {
        let envConfig: any = null;
        const teamRepoName = epic.targetRepository;

        // Try event store first
        const { eventStore } = await import('../EventStore');
        const allEvents = await eventStore.getEvents(parentContext.task.id as any);
        const envConfigEvents = allEvents.filter((e: any) => e.eventType === 'EnvironmentConfigDefined');

        if (envConfigEvents.length > 0) {
          envConfig = envConfigEvents[envConfigEvents.length - 1].payload;
          console.log(`\n🐳 [Team ${teamNumber}] Found environment config from event store`);
        }

        // Fallback: Read from task.orchestration.environmentConfig (DB persistence)
        if (!envConfig && parentContext.task.orchestration?.environmentConfig) {
          envConfig = parentContext.task.orchestration.environmentConfig;
          console.log(`\n🐳 [Team ${teamNumber}] Found environment config from task DB`);
        }

        if (envConfig) {
          console.log(`   🔧 [Team ${teamNumber}] Applying TechLead environment configuration...`);

          // Handle two config formats:
          // 1. Per-repo: { "repoName": { installCommand, testCommand, ... } }
          // 2. Global: { installCommand, testCommand, ... }
          const teamRepoConfig = envConfig[teamRepoName] || envConfig;

          // Determine if this is a valid config (has at least one command)
          const hasCommands = teamRepoConfig.installCommand || teamRepoConfig.runCommand ||
                             teamRepoConfig.buildCommand || teamRepoConfig.testCommand;

          if (hasCommands) {
            const matchedRepo = parentContext.repositories.find((r: any) =>
              r.name === teamRepoName || r.githubRepoName === teamRepoName
            );
            const repoPath = matchedRepo?.localPath || (workspacePath ? path.join(workspacePath, teamRepoName) : null);

            // Log environment configuration
            if (repoPath && path.isAbsolute(repoPath)) {
              console.log(`   📦 [Team ${teamNumber}] Configuring ${teamRepoName}: ${teamRepoConfig.language || 'unknown'}/${teamRepoConfig.framework || 'unknown'}`);
            } else {
              console.warn(`   ⚠️  [Team ${teamNumber}] Invalid repo path: ${repoPath}`);
            }

            // Store ALL commands in context for developers (including lint and typecheck)
            // These are used to build dynamic verification markers in developer prompt
            teamContext.setData('environmentCommands', {
              install: teamRepoConfig.installCommand,
              run: teamRepoConfig.runCommand,
              build: teamRepoConfig.buildCommand,
              test: teamRepoConfig.testCommand,
              lint: teamRepoConfig.lintCommand,        // 🔧 NEW: lint command for dynamic markers
              typecheck: teamRepoConfig.typecheckCommand, // 🔧 NEW: typecheck command for dynamic markers
              port: teamRepoConfig.defaultPort,
              language: teamRepoConfig.language,
              framework: teamRepoConfig.framework,
            });

            console.log(`   🏃 Commands configured:`);
            console.log(`      Install: ${teamRepoConfig.installCommand || '(not specified)'}`);
            console.log(`      Test: ${teamRepoConfig.testCommand || '(not specified)'}`);
            console.log(`      Lint: ${teamRepoConfig.lintCommand || '(not specified)'}`);
            console.log(`      Typecheck: ${teamRepoConfig.typecheckCommand || '(not specified)'}`);
            console.log(`      Build: ${teamRepoConfig.buildCommand || '(not specified)'}`);
          } else {
            console.warn(`   ⚠️  [Team ${teamNumber}] No commands found in environment config for ${teamRepoName}`);
          }
        } else {
          console.log(`\n⚠️  [Team ${teamNumber}] No environment config available - using defaults`);
        }
      } catch (envError: any) {
        console.warn(`⚠️  [Team ${teamNumber}] Could not apply environment config: ${envError.message}`);
      }

      // Developers: Implement the epic
      console.log(`\n[Team ${teamNumber}] Phase 2: Developers (Implementation)`);
      const developersResult = await developersPhase.execute(teamContext);
      if (!developersResult.success) {
        throw new Error(`Developers failed: ${developersResult.error}`);
      }
      // Track Developers cost and tokens (includes individual developer costs)
      if (developersResult.metadata?.cost) {
        (teamCosts as any).developers = developersResult.metadata.cost;
        (teamCosts as any).developersUsage = {
          input: Number(developersResult.metadata?.input_tokens || 0),
          output: Number(developersResult.metadata?.output_tokens || 0),
        };
        console.log(`💰 [Team ${teamNumber}] Developers cost: $${developersResult.metadata.cost.toFixed(4)}`);
      }
      // Track Judge costs and tokens (from within DevelopersPhase)
      if (developersResult.metadata?.judgeCost) {
        (teamCosts as any).judge = developersResult.metadata.judgeCost;
        (teamCosts as any).judgeUsage = {
          input: Number(developersResult.metadata?.judge_input_tokens || 0),
          output: Number(developersResult.metadata?.judge_output_tokens || 0),
        };
        console.log(`💰 [Team ${teamNumber}] Judge cost: $${developersResult.metadata.judgeCost.toFixed(4)}`);
      }

      // ✅ Judge review already done per-story in DevelopersPhase
      // Each story was reviewed by Judge immediately after developer completed it
      // Only approved stories were merged to epic branch
      // QA and Fixer phases REMOVED - Judge handles all quality validation

      // Calculate total team cost
      teamCosts.total = teamCosts.techLead + teamCosts.developers + teamCosts.judge;
      console.log(`💰 [Team ${teamNumber}] Total team cost: $${teamCosts.total.toFixed(4)}`);

      // 🔥🔥🔥 CRITICAL VERIFICATION: ALL STORIES MUST BE COMPLETED 🔥🔥🔥
      // Check that every story in the epic was actually completed
      const epicStories = epic.stories || [];
      const totalStories = epicStories.length;

      // Get completed stories from Unified Memory (most reliable source)
      const executionMap = await unifiedMemoryService.getExecutionMap(taskId);
      const epicId = getEpicId(epic);

      // Get completed stories from stories map, filtering by this epic
      const completedInMemory: string[] = [];
      executionMap.stories.forEach((story, storyId) => {
        if (story.epicId === epicId && story.status === 'completed') {
          completedInMemory.push(storyId);
        }
      });
      const completedCount = completedInMemory.length;

      console.log(`\n📊 [Team ${teamNumber}] Story completion check:`);
      console.log(`   Total stories: ${totalStories}`);
      console.log(`   Completed: ${completedCount}`);

      if (completedCount < totalStories) {
        const missingStories = epicStories
          .filter((s: any) => !completedInMemory.includes(s.id))
          .map((s: any) => s.id);

        console.error(`\n❌❌❌ [Team ${teamNumber}] NOT ALL STORIES COMPLETED! ❌❌❌`);
        console.error(`   Missing stories: ${missingStories.join(', ')}`);
        console.error(`   Completed: ${completedCount}/${totalStories}`);

        throw new Error(
          `Team ${teamNumber} incomplete: ${completedCount}/${totalStories} stories finished. ` +
          `Missing: ${missingStories.join(', ')}`
        );
      }

      console.log(`   ✅ All ${totalStories} stories verified as completed`);

      // 🔥 CRITICAL FOR RECOVERY: Save cost to Unified Memory
      // This ensures cost tracking is persisted for recovery and reporting
      await unifiedMemoryService.addEpicCost(
        taskId,
        getEpicId(epic),
        teamCosts.total
      );

      console.log(`\n✅ [Team ${teamNumber}] Completed successfully for epic: ${epic.title}!\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ Team ${teamNumber} completed epic: ${epic.title}`
      );

      // 🚀 AUTO-CREATE PULL REQUEST
      // Now that epic is complete, create a PR for user to review and merge
      await this.createPullRequest(epic, branchName, workspacePath, parentContext.repositories, taskId);

      return {
        success: true,
        teamCosts: teamCosts,
        epicId: getEpicId(epic) // 🔥 CENTRALIZED: Use IdNormalizer
      };
    } catch (error: any) {
      console.error(`\n❌ [Team ${teamNumber}] Failed for epic ${epic.title}: ${error.message}\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'error',
        `❌ Team ${teamNumber} failed (epic: ${epic.title}): ${error.message}`
      );

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create Pull Request for completed epic
   *
   * Automatically creates a PR from epic branch to main branch
   * so user just needs to review and merge (no manual branch management)
   */
  private async createPullRequest(
    epic: any,
    epicBranch: string,
    workspacePath: string | null,
    repositories: any[],
    taskId: string
  ): Promise<void> {
    if (!workspacePath || repositories.length === 0) {
      console.log(`⚠️  [PR] No workspace/repository - skipping PR creation`);
      return;
    }

    try {
      const { NotificationService } = await import('../NotificationService');

      // 🔥 CRITICAL: Epic MUST have targetRepository - NO FALLBACKS
      if (!epic.targetRepository) {
        console.error(`\n❌❌❌ [PR] CRITICAL ERROR: Epic has NO targetRepository!`);
        console.error(`   Epic: ${epic.title}`);
        console.error(`   Epic ID: ${epic.id}`);
        console.error(`\n   💀 CANNOT CREATE PR WITHOUT KNOWING WHICH REPOSITORY`);
        console.error(`\n   🛑 STOPPING - HUMAN INTERVENTION REQUIRED`);
        throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository in createEpicPullRequest`);
      }

      const targetRepo = epic.targetRepository;
      const repoPath = `${workspacePath}/${targetRepo}`;

      // 🔥 FIX: Use epic.title with fallback to epic.id to avoid undefined
      const epicTitle = epic.title || epic.name || epic.id || 'Untitled Epic';

      console.log(`\n📬 [PR] Creating Pull Request for epic: ${epicTitle}`);
      console.log(`   Branch: ${epicBranch} → main`);
      console.log(`   Repository: ${targetRepo}`);

      // Check if GitHub CLI is available (and install if needed)
      const ghAvailable = await this.ensureGitHubCLI();
      if (!ghAvailable) {
        console.log(`⚠️  [PR] GitHub CLI not available - showing manual instructions`);
        const prTitle = `Epic: ${epicTitle}`;
        console.log(`\n📋 [PR] Manual PR instructions:`);
        console.log(`   1. Push branch: git push -u origin ${epicBranch}`);
        console.log(`   2. Go to your repository on GitHub`);
        console.log(`   3. Create a new Pull Request`);
        console.log(`   4. Base: main ← Compare: ${epicBranch}`);
        console.log(`   5. Title: ${prTitle}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📋 Epic completed! Create PR manually: ${epicBranch} → main`
        );
        return;
      }

      // 🔥 TWO-STEP APPROACH: Normal push first, then agent recovery if failed
      const prTitle = `Epic: ${epicTitle}`;
      const prBody = `## 🎯 Epic Summary

${epic.description || 'No description provided'}

## 📊 Details

- **Complexity**: ${epic.estimatedComplexity || 'Unknown'}
- **Stories**: ${epic.stories?.length || 0}
- **Affected Repositories**: ${epic.affectedRepositories?.join(', ') || targetRepo}

## ✅ Validation

- ✅ Code reviewed by Judge (per story)
- ✅ All stories merged to epic branch

## 📝 Instructions

1. Review the changes
2. Approve and merge this PR
3. Epic will be deployed to production

---
🤖 Generated with Multi-Agent Platform`;

      let prUrl: string | null = null;
      let prNumber: number | null = null;
      let firstAttemptError: string | null = null;

      // ═══════════════════════════════════════════════════════════════════
      // STEP 0: Ensure epic branch exists and has story branches merged
      // ═══════════════════════════════════════════════════════════════════
      console.log(`\n🔧 [PR] STEP 0: Ensuring epic branch exists with merged stories...`);
      try {
        const { execSync } = require('child_process');
        const { safeGitExecSync } = await import('../../utils/safeGitExecution');

        // Check if epic branch exists locally
        let epicBranchExists = false;
        try {
          execSync(`git rev-parse --verify ${epicBranch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUTS.CHECKOUT });
          epicBranchExists = true;
          console.log(`   ✅ Epic branch exists locally: ${epicBranch}`);
        } catch {
          console.log(`   ⚠️  Epic branch does NOT exist locally: ${epicBranch}`);
        }

        // Check if epic branch exists on remote
        let epicBranchExistsRemote = false;
        try {
          // Use cached fetch to avoid redundant network calls
          smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });
          execSync(`git rev-parse --verify origin/${epicBranch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUTS.CHECKOUT });
          epicBranchExistsRemote = true;
          console.log(`   ✅ Epic branch exists on remote: origin/${epicBranch}`);
        } catch {
          console.log(`   ⚠️  Epic branch does NOT exist on remote`);
        }

        if (!epicBranchExists && !epicBranchExistsRemote) {
          // Create epic branch from main
          console.log(`   🔨 Creating epic branch from main...`);
          safeGitExecSync('git checkout main', { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
          safeGitExecSync('git pull origin main', { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
          safeGitExecSync(`git checkout -b ${epicBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
          console.log(`   ✅ Created epic branch: ${epicBranch}`);
        } else if (epicBranchExistsRemote && !epicBranchExists) {
          // Checkout existing remote epic branch
          console.log(`   🔨 Checking out remote epic branch...`);
          safeGitExecSync(`git checkout -b ${epicBranch} origin/${epicBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
          console.log(`   ✅ Checked out epic branch from remote`);
        } else {
          // Epic branch exists locally, just checkout
          safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
          console.log(`   ✅ Checked out existing epic branch`);
        }

        // Get story branches that belong to this epic and merge them
        // FIX: Don't use incorrect fallback - only use branchName if it exists
        // If branchName is missing, try to find it from execution-map or git remote
        const storyBranches: string[] = [];
        for (const s of (epic.stories || [])) {
          if (s.branchName) {
            storyBranches.push(s.branchName);
          } else {
            // Try to find branch from git remote that matches this story
            try {
              const remoteBranches = safeGitExecSync(`git branch -r`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
              // Look for pattern: story/{taskId}-{epicId}-story-{N} or story-{epicId}-story-{N}
              const storyNumber = s.id?.match(/story-(\d+)/)?.[1] || s.number || '1';
              const matchingBranch = remoteBranches.split('\n')
                .map((b: string) => b.trim().replace('origin/', ''))
                .find((b: string) => b.includes(epic.id) && b.includes(`story-${storyNumber}`));

              if (matchingBranch) {
                console.log(`   🔍 Found branch for story ${s.id}: ${matchingBranch}`);
                storyBranches.push(matchingBranch);
              } else {
                console.warn(`   ⚠️ No branch found for story ${s.id} (no fallback used)`);
              }
            } catch (searchError: any) {
              console.warn(`   ⚠️ Could not search for story ${s.id} branch: ${searchError.message}`);
            }
          }
        }
        console.log(`   📋 Story branches to merge: ${storyBranches.length}`);

        for (const storyBranch of storyBranches) {
          if (!storyBranch) continue;
          try {
            // Check if story branch exists
            execSync(`git rev-parse --verify origin/${storyBranch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: GIT_TIMEOUTS.CHECKOUT });
            console.log(`   🔀 Merging ${storyBranch}...`);
            safeGitExecSync(`git merge origin/${storyBranch} --no-edit -m "Merge ${storyBranch} into epic"`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: GIT_TIMEOUTS.PUSH
            });
            console.log(`      ✅ Merged ${storyBranch}`);
          } catch (mergeError: any) {
            if (mergeError.message?.includes('Already up to date')) {
              console.log(`      ℹ️  ${storyBranch} already merged`);
            } else if (mergeError.message?.includes('does not match any')) {
              console.log(`      ⚠️  ${storyBranch} not found on remote, skipping`);
            } else {
              console.warn(`      ⚠️  Could not merge ${storyBranch}: ${mergeError.message}`);
            }
          }
        }

        console.log(`   ✅ Epic branch ready: ${epicBranch}`);

      } catch (step0Error: any) {
        console.error(`   ❌ STEP 0 failed: ${step0Error.message}`);
        // Continue anyway - ATTEMPT 1 or 2 might still work
      }

      // ═══════════════════════════════════════════════════════════════════
      // ATTEMPT 1: Normal push + PR creation (fast, no agent cost)
      // ═══════════════════════════════════════════════════════════════════
      console.log(`\n📤 [PR] ATTEMPT 1: Normal push + PR creation...`);
      try {
        const { execSync } = require('child_process');
        const { fixGitRemoteAuth, safeGitExecSync } = await import('../../utils/safeGitExecution');

        // Fix auth and push
        fixGitRemoteAuth(repoPath);
        safeGitExecSync(`git push -u origin ${epicBranch}`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.PUSH // 60 seconds
        });
        console.log(`✅ [PR] Push succeeded`);

        // FIX: Sync local with remote after push to keep workspace updated
        try {
          safeGitExecSync(`git pull origin ${epicBranch} --ff-only`, {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.CHECKOUT
          });
          console.log(`✅ [PR] Local synced with remote`);
        } catch (pullError: any) {
          console.log(`   ℹ️ [PR] Pull skipped (already up to date or no remote changes)`);
        }

        // Create PR
        const prOutput = execSync(
          `gh pr create --base main --head "${epicBranch}" --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`,
          { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT }
        );

        // Extract PR URL
        const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
        prUrl = prUrlMatch ? prUrlMatch[0] : null;
        const prNumberMatch = prUrl?.match(/\/pull\/(\d+)/);
        prNumber = prNumberMatch ? parseInt(prNumberMatch[1]) : null;

        console.log(`✅ [PR] PR created: ${prUrl}`);

      } catch (attempt1Error: any) {
        firstAttemptError = attempt1Error.message;
        console.warn(`⚠️  [PR] Attempt 1 failed: ${firstAttemptError}`);

        // Check if PR already exists
        if (firstAttemptError && firstAttemptError.includes('already exists')) {
          try {
            const { execSync } = require('child_process');
            const existingPR = execSync(`gh pr view ${epicBranch} --json url,number`, {
              cwd: repoPath,
              encoding: 'utf8'
            });
            const prData = JSON.parse(existingPR);
            prUrl = prData.url;
            prNumber = prData.number;
            console.log(`✅ [PR] PR already exists: ${prUrl}`);
          } catch (error: any) {
            // 🔥 FIX: Log instead of silent swallow - helps debugging
            console.log(`   ℹ️ [PR] No existing PR found for ${epicBranch} (expected if new): ${error.message?.slice(0, 50)}`);
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // ATTEMPT 2: Spawn git-flow-manager agent for recovery
      // ═══════════════════════════════════════════════════════════════════
      if (!prUrl && firstAttemptError) {
        console.log(`\n🤖 [PR] ATTEMPT 2: Spawning git-flow-manager agent for recovery...`);
        console.log(`   Error from attempt 1: ${firstAttemptError}`);

        try {
          const { getAgentDefinition } = await import('./AgentDefinitions');

          const agentDef = getAgentDefinition('git-flow-manager');
          if (!agentDef) {
            throw new Error('git-flow-manager agent not found in AgentDefinitions');
          }

          const recoveryPrompt = `## 🚨 GIT FLOW RECOVERY REQUIRED

A normal push + PR creation FAILED. Your job is to diagnose and fix the issue.

### Context
- **Repository Path**: ${repoPath}
- **Branch to Push**: ${epicBranch}
- **Target Branch**: main
- **PR Title**: ${prTitle}
- **Error Message**: ${firstAttemptError}

### PR Body (use this when creating PR):
${prBody}

### What Failed
The normal \`git push\` or \`gh pr create\` failed with the error above.

### Your Task
1. Diagnose why it failed (auth? branch exists? network?)
2. Apply the appropriate fix
3. Push the branch to origin
4. Create the Pull Request
5. Report the PR URL

### Expected Output
End your response with:
\`\`\`
✅ GIT_FLOW_SUCCESS
📍 PR URL: <the PR URL>
📍 PR Number: <the PR number>
📍 Diagnosis: <what was wrong>
📍 Fix Applied: <what you did>
\`\`\`

Or if you cannot fix it:
\`\`\`
❌ GIT_FLOW_FAILED
📍 Error: <description>
📍 Action Required: <what human needs to do>
\`\`\``;

          // Use the executeAgentFn passed to this phase
          // Signature: (agentType, prompt, workspacePath, taskId, agentName, sessionId, fork, attachments, options)
          const agentResult = await this.executeAgentFn(
            'git-flow-manager',
            recoveryPrompt,
            repoPath,        // workspacePath as STRING (3rd param)
            taskId,          // taskId
            'git-flow-manager', // agentName
            undefined,       // sessionId
            undefined,       // fork
            undefined,       // attachments
            { maxIterations: 20 } // options
          );

          // Parse agent output for PR URL
          const output = agentResult?.output || '';
          if (output.includes('GIT_FLOW_SUCCESS')) {
            const urlMatch = output.match(/📍 PR URL:\s*(https:\/\/github\.com\/[^\s]+)/);
            const numMatch = output.match(/📍 PR Number:\s*(\d+)/);
            prUrl = urlMatch ? urlMatch[1] : null;
            prNumber = numMatch ? parseInt(numMatch[1]) : null;
            console.log(`✅ [PR] Agent recovery succeeded: ${prUrl}`);
          } else if (output.includes('GIT_FLOW_FAILED')) {
            console.error(`❌ [PR] Agent recovery failed`);
            const actionMatch = output.match(/📍 Action Required:\s*(.+)/);
            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `❌ Git flow recovery failed. ${actionMatch ? actionMatch[1] : 'Manual intervention required.'}`
            );
          }

        } catch (agentError: any) {
          console.error(`❌ [PR] Agent recovery error: ${agentError.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // FINAL: Report result
      // ═══════════════════════════════════════════════════════════════════
      if (!prUrl) {
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Could not create PR for ${epicBranch}. Push manually and create PR.`
        );
        return;
      }

      // ✅ Success - PR was created

      console.log(`✅ [PR] Pull Request created successfully!`);
      console.log(`   URL: ${prUrl}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `📬 Pull Request created: ${prUrl}`
      );

      // Store PR in EventStore so AutoMerge can find it
      // MUST use 'PRCreated' event type - EventStore.getCurrentState() looks for this
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: taskId as any,
        eventType: 'PRCreated' as any,  // <-- EventStore expects this, NOT 'TeamCompleted'
        agentName: 'team-orchestration',
        payload: {
          epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          epicTitle: epic.title,
          prUrl: prUrl,
          prNumber: prNumber,
          epicBranch: epicBranch
        }
      });

      // 🔥 CRITICAL FOR RECOVERY: Save PR info to Unified Memory
      // This ensures AutoMerge phase knows which PR to merge after restart
      if (prUrl && prNumber) {
        await unifiedMemoryService.saveEpicPR(
          taskId,
          getEpicId(epic),
          prUrl,
          prNumber
        );
        console.log(`💾 [PR] Saved PR info to Unified Memory: ${prUrl} (#${prNumber})`);
      }

    } catch (error: any) {
      console.error(`❌ [PR] Unexpected error creating PR: ${error.message}`);
      // Non-critical - don't fail the whole epic
    }
  }

  /**
   * Ensure GitHub CLI is available
   *
   * Checks if gh is installed, and attempts to install it if not
   * Returns true if gh is available, false otherwise
   */
  private async ensureGitHubCLI(): Promise<boolean> {
    try {
      const { execSync } = require('child_process');

      // Check if gh is already installed
      try {
        execSync('gh --version', { encoding: 'utf8', stdio: 'pipe' });
        console.log(`✅ [PR] GitHub CLI (gh) is available`);
        return true;
      } catch (checkError) {
        console.log(`⚠️  [PR] GitHub CLI (gh) not found - attempting to install...`);
      }

      // Attempt to install based on OS
      const platform = process.platform;

      if (platform === 'darwin') {
        // macOS - use Homebrew
        console.log(`📦 [PR] Installing GitHub CLI via Homebrew...`);
        try {
          execSync('brew install gh', { encoding: 'utf8', stdio: 'inherit' });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] Homebrew not available or installation failed`);
        }
      } else if (platform === 'linux') {
        // Linux - try apt-get (Debian/Ubuntu)
        console.log(`📦 [PR] Installing GitHub CLI via apt-get...`);
        try {
          execSync('sudo apt-get update && sudo apt-get install -y gh', {
            encoding: 'utf8',
            stdio: 'inherit'
          });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] apt-get not available or installation failed`);
        }
      } else if (platform === 'win32') {
        // Windows - use winget
        console.log(`📦 [PR] Installing GitHub CLI via winget...`);
        try {
          execSync('winget install --id GitHub.cli', { encoding: 'utf8', stdio: 'inherit' });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] winget not available or installation failed`);
        }
      }

      // Installation failed or unsupported platform
      console.log(`⚠️  [PR] Could not auto-install GitHub CLI`);
      console.log(`💡 [PR] Install manually: https://cli.github.com/manual/installation`);
      return false;

    } catch (error: any) {
      console.error(`❌ [PR] Error checking/installing GitHub CLI: ${error.message}`);
      return false;
    }
  }

  /**
   * 🔥 CHECKPOINT: Save epic completion to DB AND UnifiedMemory for recovery
   * This allows resuming from exactly where we left off instead of re-executing all epics
   *
   * Saves to BOTH:
   * 1. MongoDB (task.orchestration.teamOrchestration.completedEpicIds) - fast access
   * 2. UnifiedMemory (executionMap.epics[].status) - single source of truth for recovery
   */
  private async saveEpicCheckpoint(taskId: any, epicId: string, taskIdStr: string): Promise<void> {
    try {
      // 1️⃣ Save to MongoDB (fire-and-forget checkpoint)
      updateTaskFireAndForget(taskId, {
        $addToSet: {
          'orchestration.teamOrchestration.completedEpicIds': epicId,
        },
        $set: {
          'orchestration.teamOrchestration.lastCheckpoint': new Date(),
          'orchestration.teamOrchestration.lastCompletedEpicId': epicId,
        },
      }, `checkpoint epic ${epicId}`);

      // 2️⃣ Also update UnifiedMemory for recovery consistency
      // This ensures getResumptionPoint() returns accurate completedEpics
      try {
        const map = await unifiedMemoryService.getExecutionMap(taskIdStr);
        if (map && map.epics) {
          const epicExecution = map.epics.get(epicId);
          if (epicExecution) {
            epicExecution.status = 'completed';
            console.log(`   🧠 [UNIFIED MEMORY] Epic "${epicId}" marked as completed`);
          }
        }
      } catch (memError: any) {
        // Non-critical - MongoDB is primary
        console.warn(`   ⚠️  [UNIFIED MEMORY] Could not update: ${memError.message}`);
      }

      console.log(`   💾 [CHECKPOINT] Epic "${epicId}" saved to DB - can resume from here if interrupted`);

      // Note: Git commits for memory are no longer needed
      // Memory is stored in Local + MongoDB (not in client repos)
      // Git is only for actual code work by developers

      NotificationService.emitConsoleLog(
        taskIdStr,
        'info',
        `💾 CHECKPOINT: Epic "${epicId}" completed and saved [Local + MongoDB]`
      );
    } catch (error: any) {
      console.error(`   ⚠️  [CHECKPOINT] Failed to save checkpoint for epic "${epicId}": ${error.message}`);
      // Don't throw - checkpoint failure shouldn't stop execution
    }
  }
}
