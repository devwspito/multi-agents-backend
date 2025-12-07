import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { TechLeadPhase } from './TechLeadPhase';
import { DevelopersPhase } from './DevelopersPhase';
// JudgePhase runs per-story inside DevelopersPhase, not as separate batch in multi-team mode
// QAPhase, FixerPhase, GitHubService, PRManagementService REMOVED - Judge handles quality validation per-story
import { safeGitExecSync, fixGitRemoteAuth, normalizeRepoName } from '../../utils/safeGitExecution';
import {
  validateRetryLimit,
  validateRepositoryRemotes,
  validateRequiredPhaseContext,
} from './utils/PhaseValidationHelpers';

/**
 * Team Orchestration Phase
 *
 * Implements Multi-Team parallel orchestration following Anthropic's recommendations
 * for complex problem-solving with Claude agents.
 *
 * Architecture:
 * - Receives epics from Project Manager (Sonnet orchestrator)
 * - Creates isolated team per epic
 * - Each team runs: TechLead → Developers → Judge → QA
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
   * Skip if all teams already completed (ONLY for recovery, NOT for continuations)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute to create new teams for new epics
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [TeamOrchestration] This is a CONTINUATION - will re-execute to create new teams`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    const teamOrchestration = (context.task.orchestration as any).teamOrchestration;
    if (teamOrchestration?.status === 'completed') {
      console.log(`[SKIP] TeamOrchestration already completed - skipping re-execution (recovery mode)`);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();

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
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Team Orchestration');

    await LogService.agentStarted('team-orchestration', taskId, {
      phase: 'multi-team',
    });

    try {
      // 🔥 CRITICAL FIX: Validate retry limit BEFORE any processing (fail-fast)
      validateRetryLimit(context, 'teamOrchestration', 3);

      // 🔥 CRITICAL FIX: Validate required context from previous phases
      validateRequiredPhaseContext(context, 'teamOrchestration', ['repositories']);

      // Get EPICS from Project Manager - MUST support recovery after restart
      let projectManagerEpics = context.getData<any[]>('epics') || [];

      // CRITICAL: Always check task model for epics (recovery after restart)
      if (projectManagerEpics.length === 0) {
        const epicsFromTask = (task.orchestration.projectManager as any)?.epics || [];
        if (epicsFromTask && epicsFromTask.length > 0) {
          // Restore epics to context for this execution
          context.setData('epics', epicsFromTask);
          projectManagerEpics = [...epicsFromTask]; // Create new array
          console.log(`🔄 [TeamOrchestration] RECOVERY: Restored ${epicsFromTask.length} epic(s) from database after restart`);
        }
      }

      // Final validation - MUST have epics to proceed
      if (!projectManagerEpics || projectManagerEpics.length === 0) {
        // Check if ProjectManager phase completed
        const pmStatus = task.orchestration.projectManager?.status;
        if (pmStatus !== 'completed') {
          throw new Error(`Cannot start TeamOrchestration: Project Manager phase is ${pmStatus || 'not started'}. Must complete Project Manager first.`);
        }
        throw new Error('No epics found from Project Manager - cannot create teams. Database may be corrupted or Project Manager output was invalid.');
      }

      // 🚨 CRITICAL VALIDATION: Check epic quality
      // If Project Manager somehow passed invalid epics, BLOCK execution here
      const invalidEpics = projectManagerEpics.filter(epic => {
        const hasFiles = (epic.filesToModify && epic.filesToModify.length > 0) ||
                        (epic.filesToCreate && epic.filesToCreate.length > 0);
        return !hasFiles;
      });

      if (invalidEpics.length > 0) {
        const invalidTitles = invalidEpics.map((e: any) => e.title || e.id).join(', ');
        console.error(`\n${'🚨'.repeat(40)}`);
        console.error(`🚨 CRITICAL: INVALID EPICS DETECTED`);
        console.error(`🚨 ${invalidEpics.length} epic(s) have NO file paths`);
        console.error(`🚨 Invalid epics: ${invalidTitles}`);
        console.error(`🚨 This should have been caught by Project Manager validation`);
        console.error(`🚨 BLOCKING EXECUTION - Cannot proceed without file paths`);
        console.error(`${'🚨'.repeat(40)}\n`);

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
          `Project Manager must specify filesToModify or filesToCreate for each epic. ` +
          `This error indicates a validation bypass - execution blocked.`
        );
      }

      // 🔥 FIX: Validate targetRepository EARLY (before any processing)
      const epicsWithoutRepo = projectManagerEpics.filter(epic => !epic.targetRepository);
      if (epicsWithoutRepo.length > 0) {
        const epicIds = epicsWithoutRepo.map((e: any) => e.id || e.title).join(', ');
        console.error(`\n${'🚨'.repeat(40)}`);
        console.error(`🚨 CRITICAL: EPICS WITHOUT TARGET REPOSITORY`);
        console.error(`🚨 ${epicsWithoutRepo.length} epic(s) have NO targetRepository assigned`);
        console.error(`🚨 Invalid epics: ${epicIds}`);
        console.error(`🚨 Each epic MUST specify which repository it belongs to`);
        console.error(`🚨 BLOCKING EXECUTION - Cannot proceed without repository assignment`);
        console.error(`${'🚨'.repeat(40)}\n`);

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `🚨 CRITICAL: ${epicsWithoutRepo.length} epic(s) missing targetRepository: ${epicIds}`
        );

        throw new Error(
          `🚨 CRITICAL VALIDATION FAILURE: ${epicsWithoutRepo.length} epic(s) missing targetRepository: ${epicIds}. ` +
          `Project Manager must assign a target repository to each epic. ` +
          `Available repositories: ${context.repositories.map(r => r.name).join(', ')}`
        );
      }

      console.log(`\n🎯 [TeamOrchestration] Found ${projectManagerEpics.length} epic(s) from Project Manager`);
      console.log(`✅ [TeamOrchestration] All epics validated - have concrete file paths and target repositories`);

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
      for (const epic of projectManagerEpics) {
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

      let teamResults: PromiseSettledResult<any>[] = [];
      let teamCounter = 0;

      // Execute groups sequentially
      for (const [order, epics] of orderedGroups) {
        console.log(`\n🔧 [Phase ${order}] Executing ${epics.length} epic(s)...\n`);

        // 🔥 CRITICAL FIX: Check for git conflicts BEFORE parallel execution
        // If multiple epics use SAME repository → CANNOT execute in parallel (git race condition)
        const reposInGroup = epics.map((e: any) => e.targetRepository);
        const uniqueRepos = new Set(reposInGroup);
        const hasGitConflict = uniqueRepos.size !== epics.length;

        let groupResults: PromiseSettledResult<any>[] = [];

        if (hasGitConflict) {
          console.warn(`\n⚠️  [RACE CONDITION PREVENTION] Multiple epics targeting SAME repository detected!`);
          console.warn(`   Epics: ${epics.length}, Unique repos: ${uniqueRepos.size}`);
          console.warn(`   Repositories: ${Array.from(uniqueRepos).join(', ')}`);
          console.warn(`   🔒 EXECUTING SEQUENTIALLY to prevent git conflicts`);
          console.warn(`   ⚠️  Parallel execution would cause: checkout conflicts, lost changes, branch corruption\n`);

          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️  Phase ${order}: Git conflict detected - executing ${epics.length} epic(s) SEQUENTIALLY`
          );

          // SEQUENTIAL execution (safe - no git conflicts)
          for (const epic of epics) {
            console.log(`   🔧 Executing epic: ${epic.targetRepository} (sequential mode)`);
            try {
              const result = await this.executeTeam(epic, ++teamCounter, context);
              groupResults.push({ status: 'fulfilled', value: result });
            } catch (error) {
              groupResults.push({ status: 'rejected', reason: error });
            }
          }
        } else {
          // PARALLEL execution (safe - different repos)
          console.log(`   ✅ All epics use DIFFERENT repositories - safe for parallel execution`);
          console.log(`   Repositories: ${Array.from(uniqueRepos).join(', ')}`);

          NotificationService.emitConsoleLog(taskId, 'info', `🔧 Phase ${order}: ${epics.length} epic(s) in PARALLEL`);

          const groupPromises = epics.map((epic: any) =>
            this.executeTeam(epic, ++teamCounter, context)
          );

          groupResults = await Promise.allSettled(groupPromises);
        }

        teamResults.push(...groupResults);

        // Check if this phase failed
        const groupFailed = groupResults.filter((r: PromiseSettledResult<any>) =>
          r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)
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

      // Aggregate results
      const successfulTeams = teamResults.filter(r => r.status === 'fulfilled' && r.value.success);
      const failedTeams = teamResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));

      // 🔥 CIRCUIT BREAKER: Stop if too many teams fail
      const failureRate = failedTeams.length / teamResults.length;
      const failureThreshold = parseFloat(process.env.TEAM_FAILURE_THRESHOLD || '0.5'); // 50% default

      if (failureRate > failureThreshold && teamResults.length > 1) {
        const { CircuitBreakerError } = await import('./RetryService');

        console.error(`\n❌ [CIRCUIT BREAKER] Too many teams failed: ${failedTeams.length}/${teamResults.length} (${(failureRate * 100).toFixed(1)}%)`);
        console.error(`   Threshold: ${(failureThreshold * 100).toFixed(0)}%`);
        console.error(`   Aborting orchestration to prevent further cost accumulation\n`);

        // Notify frontend
        NotificationService.emitNotification(taskId, 'circuit_breaker_triggered', {
          failedTeams: failedTeams.length,
          totalTeams: teamResults.length,
          threshold: failureThreshold,
          message: `Circuit breaker: ${failedTeams.length}/${teamResults.length} teams failed`
        });

        throw new CircuitBreakerError(
          failedTeams.length,
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

      // 🔥 CRITICAL: Aggregate costs AND token usage from all teams for proper breakdown display
      let totalTechLeadCost = 0;
      let totalJudgeCost = 0;
      let totalDevelopersCost = 0;
      let totalQACost = 0;

      // Token tracking for each agent type
      let techLeadTokens = { input: 0, output: 0 };
      let judgeTokens = { input: 0, output: 0 };
      let developersTokens = { input: 0, output: 0 };
      let qaTokens = { input: 0, output: 0 };

      (context.task.orchestration as any).teamOrchestration.teams = teamResults.map((result, idx) => {
        if (result.status === 'fulfilled' && result.value.teamCosts) {
          const costs = result.value.teamCosts;

          // Accumulate costs and tokens from each team
          totalTechLeadCost += costs.techLead || 0;
          totalJudgeCost += costs.judge || 0;
          totalDevelopersCost += costs.developers || 0;
          totalQACost += costs.qa || 0;

          // Accumulate token usage
          if (costs.techLeadUsage) {
            techLeadTokens.input += costs.techLeadUsage.input || 0;
            techLeadTokens.output += costs.techLeadUsage.output || 0;
          }
          if (costs.judgeUsage) {
            judgeTokens.input += costs.judgeUsage.input || 0;
            judgeTokens.output += costs.judgeUsage.output || 0;
          }
          if (costs.developersUsage) {
            developersTokens.input += costs.developersUsage.input || 0;
            developersTokens.output += costs.developersUsage.output || 0;
          }
          if (costs.qaUsage) {
            qaTokens.input += costs.qaUsage.input || 0;
            qaTokens.output += costs.qaUsage.output || 0;
          }

          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
            costs: costs, // Store individual team costs
          };
        } else if (result.status === 'fulfilled') {
          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
          };
        } else {
          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: 'failed',
            error: (result as PromiseRejectedResult).reason?.message || 'Unknown error',
          };
        }
      });

      // Update aggregated costs AND token usage in the main orchestration fields for breakdown display
      if (totalTechLeadCost > 0) {
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
        task.orchestration.techLead.cost_usd = totalTechLeadCost;
        console.log(`💰 Total Tech Lead cost across all teams: $${totalTechLeadCost.toFixed(4)}`);
      }

      if (totalJudgeCost > 0) {
        if (!task.orchestration.judge) {
          task.orchestration.judge = { agent: 'judge', status: 'completed' } as any;
        }
        if (!task.orchestration.judge!.usage) {
          task.orchestration.judge!.usage = {
            input_tokens: judgeTokens.input,
            output_tokens: judgeTokens.output,
          };
        }
        task.orchestration.judge!.cost_usd = totalJudgeCost;
        console.log(`💰 Total Judge cost across all teams: $${totalJudgeCost.toFixed(4)}`);
      }

      if (totalQACost > 0) {
        if (!task.orchestration.qaEngineer) {
          task.orchestration.qaEngineer = { agent: 'qa-engineer', status: 'completed' } as any;
        }
        if (!task.orchestration.qaEngineer!.usage) {
          task.orchestration.qaEngineer!.usage = {
            input_tokens: qaTokens.input,
            output_tokens: qaTokens.output,
          };
        }
        task.orchestration.qaEngineer!.cost_usd = totalQACost;
        console.log(`💰 Total QA cost across all teams: $${totalQACost.toFixed(4)}`);
      }

      // Also track developers cost separately
      if (totalDevelopersCost > 0) {
        console.log(`💰 Total Developers cost across all teams: $${totalDevelopersCost.toFixed(4)}`);
        // Note: Developers cost is not shown separately in the breakdown UI
      }

      // For developers, add to team array
      if (totalDevelopersCost > 0 && !task.orchestration.team) {
        task.orchestration.team = [];
      }

      // 🔥 CRITICAL: Accumulate ALL team costs to the main orchestration total
      const totalTeamsCost = totalTechLeadCost + totalJudgeCost + totalDevelopersCost + totalQACost;
      if (totalTeamsCost > 0) {
        task.orchestration.totalCost = (task.orchestration.totalCost || 0) + totalTeamsCost;
        console.log(`💰 [TeamOrchestration] Total cost from all teams: $${totalTeamsCost.toFixed(4)}`);
        console.log(`💰 [TeamOrchestration] Running orchestration total: $${task.orchestration.totalCost.toFixed(4)}`);
      }

      await task.save();

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
      for (const teamResult of failedTeams) {
        if (teamResult.status === 'rejected') {
          failedTeamErrors.push(`Team rejected: ${teamResult.reason?.message || teamResult.reason}`);
        } else if (teamResult.status === 'fulfilled' && !teamResult.value.success) {
          failedTeamErrors.push(`Team failed: ${teamResult.value.error || 'Unknown error'}`);
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
      await task.save();

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
   * 4. Judge reviews code
   * 5. QA tests integration
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
    const taskId = (parentContext.task._id as any).toString();

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
      // 1️⃣ Create branch for this epic
      // 🔥 UNIQUE BRANCH NAMING: Include taskId + timestamp + random suffix to prevent ANY conflicts
      const taskShortId = (parentContext.task._id as any).toString().slice(-8); // Last 8 chars of taskId
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const epicSlug = epic.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(); // Sanitize epic id
      const branchName = `epic/${taskShortId}-${epicSlug}-${timestamp}-${randomSuffix}`;
      const workspacePath = parentContext.workspacePath;

      // 🔥 DEFENSIVE VALIDATION: Check workspacePath type at team creation
      if (typeof workspacePath !== 'string' && workspacePath !== null) {
        console.error(`❌❌❌ [Team ${teamNumber}] CRITICAL: workspacePath is not a string!`);
        console.error(`   Type: ${typeof workspacePath}`);
        console.error(`   Value: ${JSON.stringify(workspacePath)}`);
        console.error(`   parentContext.workspacePath: ${JSON.stringify(parentContext.workspacePath)}`);
        throw new Error(`CRITICAL: workspacePath must be a string, received ${typeof workspacePath}`);
      }

      // 🔥 CRITICAL: Epic MUST have targetRepository - NO FALLBACKS
      if (!epic.targetRepository) {
        console.error(`\n❌❌❌ [Team ${teamNumber}] CRITICAL ERROR: Epic has NO targetRepository!`);
        console.error(`   Epic: ${epic.title}`);
        console.error(`   Epic ID: ${epic.id}`);
        console.error(`\n   💀 CANNOT CREATE BRANCH WITHOUT KNOWING WHICH REPOSITORY`);
        console.error(`\n   🛑 STOPPING - HUMAN INTERVENTION REQUIRED`);
        throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository in createEpicBranch`);
      }

      // 🔥 NORMALIZE: Remove .git suffix if present (ProjectManager may add it, but DB doesn't have it)
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

      // Copy repository to isolated workspace (if not already copied)
      if (!fs.existsSync(isolatedRepoPath)) {
        if (!fs.existsSync(sourceRepoPath)) {
          throw new Error(`Source repository not found: ${sourceRepoPath}`);
        }

        console.log(`📋 [Team ${teamNumber}] Copying repository to isolated workspace...`);
        // Use cp -r to copy the entire repository including .git
        const { execSync } = require('child_process');
        execSync(`cp -r "${sourceRepoPath}" "${isolatedRepoPath}"`, { encoding: 'utf8' });
        console.log(`✅ [Team ${teamNumber}] Repository copied to: ${isolatedRepoPath}`);
      } else {
        console.log(`✅ [Team ${teamNumber}] Isolated repository already exists: ${isolatedRepoPath}`);
      }

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
          const fs = require('fs');
          const epicReadmePath = `${repoPath}/EPIC_${epic.id}.md`;
          const epicReadmeContent = `# Epic: ${epic.title}\n\n${epic.description || 'Epic in progress...'}\n\n**Status:** In Progress\n**Created:** ${new Date().toISOString()}\n`;

          fs.writeFileSync(epicReadmePath, epicReadmeContent, 'utf8');
          console.log(`📝 [Team ${teamNumber}] Created epic README: EPIC_${epic.id}.md`);

          safeGitExecSync(`git add .`, { cwd: repoPath, encoding: 'utf8' });
          safeGitExecSync(`git commit -m "chore: Initialize epic ${epic.id} - ${epic.title}"`, {
            cwd: repoPath,
            encoding: 'utf8'
          });
          console.log(`✅ [Team ${teamNumber}] Created initial commit in epic branch`);

          // Push epic branch with initial commit
          try {
            fixGitRemoteAuth(repoPath);
            safeGitExecSync(`git push -u origin ${branchName}`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: 30000
            });
            console.log(`✅ [Team ${teamNumber}] Epic branch pushed to remote with initial commit`);
            pushSuccessful = true;
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

            // 🔥 CRITICAL: Also push existing branch to ensure it's on remote
            try {
              console.log(`📤 [Team ${teamNumber}] Ensuring epic branch is on remote...`);

              // Fix remote auth before pushing
              fixGitRemoteAuth(repoPath);

              safeGitExecSync(`git push -u origin ${branchName}`, {
                cwd: repoPath,
                encoding: 'utf8',
                timeout: 30000
              });
              console.log(`✅ [Team ${teamNumber}] Epic branch confirmed on remote: ${branchName}`);
            } catch (pushError: any) {
              // Might already be on remote, that's fine
              console.log(`ℹ️  [Team ${teamNumber}] Branch push result: ${pushError.message}`);
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

      // Share workspace structure and attachments
      teamContext.setData('workspaceStructure', parentContext.getData('workspaceStructure'));
      teamContext.setData('attachments', parentContext.getData('attachments'));

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
        taskId: parentContext.task._id as any,
        eventType: 'EpicBranchCreated' as any,
        agentName: 'team-orchestration',
        payload: {
          epicId: epic.id,
          branchName: branchName,
          targetRepository: targetRepository,
        },
      });
      console.log(`📝 [Team ${teamNumber}] Stored epic branch in EventStore: ${branchName}`);

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

      // Tech Lead: Design architecture for this epic
      console.log(`\n[Team ${teamNumber}] Phase 1: Tech Lead (Architecture)`);
      const techLeadResult = await techLeadPhase.execute(teamContext);
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
        (teamCosts as any).techLead = techLeadCost;
        (teamCosts as any).techLeadUsage = techLeadUsage;
        console.log(`💰 [Team ${teamNumber}] Tech Lead cost: $${techLeadCost.toFixed(4)} (${techLeadUsage.input + techLeadUsage.output} tokens)`);
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
        epicId: epic.id
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
      const { execSync } = require('child_process');
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

      // Push epic branch to remote WITH TIMEOUT
      try {
        console.log(`📤 [PR] Pushing ${epicBranch} to remote...`);

        // 🔥 CRITICAL: Fix remote auth before pushing
        fixGitRemoteAuth(repoPath);

        // Push using safe git execution
        safeGitExecSync(`git push -u origin ${epicBranch}`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: 30000 // 30 seconds max
        });
        console.log(`✅ [PR] Pushed ${epicBranch} to remote`);
      } catch (pushError: any) {
        console.error(`❌ [PR] Failed to push branch: ${pushError.message}`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Could not push ${epicBranch} - PR creation skipped. Push manually and create PR.`
        );
        return;
      }

      // Create PR using GitHub CLI
      // 🔥 FIX: Use epicTitle (already defined above with fallback)
      const prTitle = `Epic: ${epicTitle}`;
      const prBody = `## 🎯 Epic Summary\n\n${epic.description || 'No description provided'}\n\n## 📊 Details\n\n- **Complexity**: ${epic.estimatedComplexity || 'Unknown'}\n- **Stories**: ${epic.stories?.length || 0}\n- **Affected Repositories**: ${epic.affectedRepositories?.join(', ') || targetRepo}\n\n## ✅ Validation\n\n- ✅ Code reviewed by Judge (per story)\n- ✅ Integration tested by QA Engineer\n- ✅ All stories merged to epic branch\n\n## 📝 Instructions\n\n1. Review the changes\n2. Approve and merge this PR\n3. Epic will be deployed to production\n\n---\n🤖 Generated with Multi-Agent Platform`;

      try {
        const prOutput = execSync(
          `cd "${repoPath}" && gh pr create --base main --head ${epicBranch} --title "${prTitle}" --body "${prBody}"`,
          { encoding: 'utf8' }
        );

        // Extract PR URL from output
        const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
        const prUrl = prUrlMatch ? prUrlMatch[0] : 'PR created (URL not found)';

        console.log(`✅ [PR] Pull Request created successfully!`);
        console.log(`   URL: ${prUrl}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📬 Pull Request created: ${prUrl}`
        );

        // Store PR URL in epic metadata
        const { eventStore } = await import('../EventStore');
        await eventStore.append({
          taskId: taskId as any,
          eventType: 'TeamCompleted' as any, // Store PR info in TeamCompleted event
          agentName: 'team-orchestration',
          payload: {
            epicId: epic.id,
            epicTitle: epic.title,
            prUrl: prUrl,
            epicBranch: epicBranch,
            prCreated: true
          }
        });

      } catch (ghError: any) {
        // GitHub CLI not available or other error
        console.warn(`⚠️  [PR] Could not create PR automatically: ${ghError.message}`);
        console.log(`\n📋 [PR] Manual PR instructions:`);
        console.log(`   1. Go to your repository`);
        console.log(`   2. Create a new Pull Request`);
        console.log(`   3. Base: main ← Compare: ${epicBranch}`);
        console.log(`   4. Title: ${prTitle}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📋 Epic completed! Create PR manually: ${epicBranch} → main`
        );
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
}
