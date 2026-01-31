import { BasePhase, OrchestrationContext, PhaseResult, updateTaskFireAndForget } from './Phase';
import { ITeamMember, TaskRepository } from '../../database/repositories/TaskRepository.js';
import { DependencyResolver } from '../dependencies/DependencyResolver';
import { ConservativeDependencyPolicy } from '../dependencies/ConservativeDependencyPolicy';
import { LogService } from '../logging/LogService';
import { HookService } from '../HookService';
import { AgentActivityService } from '../AgentActivityService';
import { NotificationService } from '../NotificationService';
import { ProactiveIssueDetector } from '../ProactiveIssueDetector';
import { unifiedMemoryService } from '../UnifiedMemoryService';
import { assertValidWorkspacePath } from './utils/WorkspaceValidator';
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { logSection } from './utils/LogHelpers';
import { isEmpty } from './utils/ArrayHelpers';
import { CostAccumulator } from './utils/CostAccumulator';
import { getEpicId, getStoryId } from './utils/IdNormalizer';
import { isStoryComplete, loadUnifiedMemoryCompletedStories, logStorySkip } from './utils/StateChecker';
import { StoryPipelineService } from './StoryPipelineService';

// 🔥 Types imported from developers module (extracted for modularity)
import {
  DeveloperOutput,
  JudgeInput,
  JudgeResult,
  StoryPipelineContext,
  DeveloperStageResult,
  GitValidationStageResult,
  JudgeStageResult,
  MergeStageResult,
  createJudgeInput,
} from './developers/types';

// Re-export for backward compatibility
export {
  DeveloperOutput,
  JudgeInput,
  JudgeResult,
  StoryPipelineContext,
  DeveloperStageResult,
  GitValidationStageResult,
  JudgeStageResult,
  MergeStageResult,
  createJudgeInput,
};

/**
 * Developers Phase
 *
 * Manages development team execution with multi-repo support
 * - Applies conservative dependency policy for cross-repo safety
 * - Resolves epic execution order based on dependencies
 * - Spawns multiple developers based on team composition
 * - Executes epics in depenAdency order (sequential for cross-repo safety)
 * - Each epic works on its targetRepository
 * - Includes work verification and quality checks
 * - Commits and pushes changes to epic branches
 *
 * Note: This phase contains complex logic including:
 * - Dependency resolution and policy application
 * - Work verification with retry
 * - Judge evaluation
 * - No-changes detection
 * - Git operations (branch creation, commits, pushes)
 */
export class DevelopersPhase extends BasePhase {
  readonly name = 'Developers'; // Must match PHASE_ORDER
  readonly description = 'Implementing features with production-ready code';

  private storyPipeline: StoryPipelineService;

  constructor(executeDeveloperFn: Function, executeAgentFn?: Function) {
    super();
    this.storyPipeline = new StoryPipelineService(executeDeveloperFn, executeAgentFn);
  }


  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const taskId = this.getTaskIdString(context);
    const teamEpic = context.getData<any>('teamEpic');

    // Multi-team mode: check epic-specific completion
    if (teamEpic) {
      return this.shouldSkipMultiTeam(context, taskId, teamEpic);
    }

    // Single-team mode: use centralized skip logic
    const skipResult = await checkPhaseSkip(context, { phaseName: 'Developers' });

    if (skipResult.shouldSkip) {
      this.restoreDevContextOnSkip(context);
      return true;
    }

    console.log(`   ⏳ Phase pending - Developers must execute`);
    return false;
  }

  /**
   * Check skip for multi-team mode (epic-specific)
   */
  private async shouldSkipMultiTeam(
    context: OrchestrationContext,
    taskId: string,
    teamEpic: any
  ): Promise<boolean> {
    console.log(`\n🎯 [Developers.shouldSkip] Multi-team mode - Epic: ${teamEpic.id}`);

    // CONTINUATION: Never skip
    if (this.isContinuation(context)) {
      console.log(`   ↪️ CONTINUATION - will re-execute to implement new stories`);
      return false;
    }

    const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
    if (!resumption) return false;

    const epic = resumption.executionMap?.epics?.find((e: any) => e.epicId === teamEpic.id);

    // Check if ALL stories for THIS EPIC are completed
    if (epic && epic.status === 'completed') {
      logSection(`🎯 [UNIFIED MEMORY] Development for epic ${teamEpic.id} already COMPLETED`);
      console.log(`   Stories: ${epic.stories?.length || 0} total`);
      this.restoreDevContextOnSkip(context);
      return true;
    }

    // Check partial recovery (some stories done, some pending)
    if (epic && !isEmpty(epic.stories)) {
      const completedStories = epic.stories!.filter((s: any) => s.status === 'completed');
      const totalStories = epic.stories!.length;

      if (completedStories.length > 0 && completedStories.length < totalStories) {
        console.log(`\n🔄 [PARTIAL RECOVERY] ${completedStories.length}/${totalStories} stories completed`);
        console.log(`   → Will resume from incomplete stories`);
        return false; // Don't skip phase, but individual stories will be skipped
      }
    }

    console.log(`   ❌ Epic development not completed - must execute`);
    return false;
  }

  /**
   * Restore development context when skipping
   */
  private restoreDevContextOnSkip(context: OrchestrationContext): void {
    const team = context.task.orchestration.team || [];
    context.setData('developmentTeam', team);
    context.setData('developmentComplete', true);
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // 🔥 CRITICAL VALIDATION: workspacePath MUST exist for Developers+Judge to work correctly
    assertValidWorkspacePath(workspacePath, 'DevelopersPhase');
    console.log(`   ✅ Workspace path valid: ${workspacePath}`);

    // Initialize cost tracking with CostAccumulator
    const phaseCosts = new CostAccumulator();

    // 🔥 CRITICAL: Retrieve processed attachments from context (shared from Planning phase)
    const attachments = context.getData<any[]>('attachments') || [];
    if (attachments.length > 0) {
      console.log(`📎 [Developers] Using ${attachments.length} attachment(s) from context`);
      const { NotificationService } = await import('../NotificationService');
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `📎 Developers: Received ${attachments.length} image(s) from context for implementation`
      );
    }

    // 🔐 Retrieve devAuth from context (for testing authenticated endpoints)
    const devAuth = context.getData<any>('devAuth');
    if (devAuth && devAuth.method !== 'none') {
      console.log(`🔐 [Developers] DevAuth configured: method=${devAuth.method}`);
    }

    await LogService.info('Development Team phase started - Spawning team members', {
      taskId,
      category: 'orchestration',
      phase: 'development',
    });

    // 🪝 HOOK: Execute security scan before development
    if (HookService.hookExists('security-scan') && repositories.length > 0) {
      console.log(`\n🪝 [Developers] Running security-scan hook before development...`);
      const securityResult = await HookService.executeSecurityScan(
        repositories[0].localPath,
        taskId
      );
      if (!securityResult.success) {
        console.warn(`   ⚠️  Security scan completed with warnings`);
      }
    }

    // 🔍 PROACTIVE ISSUE DETECTION: Check for potential issues before development
    if (repositories.length > 0 && workspacePath) {
      console.log(`\n🔍 [Developers] Running proactive issue detection...`);
      const stories = context.getData<any[]>('stories') || [];
      const allFilesToModify = stories.flatMap((s: any) => s.filesToModify || []);
      const allFilesToCreate = stories.flatMap((s: any) => s.filesToCreate || []);
      const allFilesToRead = stories.flatMap((s: any) => s.filesToRead || []);

      const preflightResult = await ProactiveIssueDetector.runPreflightChecks({
        workspacePath: repositories[0].localPath,
        filesToModify: allFilesToModify,
        filesToCreate: allFilesToCreate,
        filesToRead: allFilesToRead,
      });

      if (!preflightResult.canProceed) {
        console.warn(`   ⚠️  Preflight check found ${preflightResult.issues.length} blocking issues`);
        for (const issue of preflightResult.issues.filter(i => i.severity === 'blocker')) {
          console.warn(`      ❌ ${issue.category}: ${issue.message}`);
        }
        // Store issues in context for Developer to see
        context.setData('preflightIssues', preflightResult.issues);
      } else {
        console.log(`   ✅ Preflight checks passed`);
        if (preflightResult.recommendations.length > 0) {
          context.setData('preflightRecommendations', preflightResult.recommendations);
        }
      }
    }

    // 🔥 MULTI-TEAM MODE: Check if we're in team mode and use context data
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    // Get composition and assignments (from context in multi-team mode, from task otherwise)
    const composition = multiTeamMode
      ? context.getData<any>('teamComposition')
      : task.orchestration.techLead.teamComposition;

    const assignments = multiTeamMode
      ? context.getData<any[]>('storyAssignments') || []
      : task.orchestration.techLead.storyAssignments || [];

    if (!composition) {
      return {
        success: false,
        error: 'Team composition not defined by Tech Lead',
      };
    }

    if (multiTeamMode) {
      console.log(`🎯 [Developers] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
      console.log(`   Team size: ${composition.developers} developer(s)`);
      console.log(`   Story assignments: ${assignments.length}`);
    }

    // 🎯 ACTIVITY: Emit Developers start for Activity tab
    const developerLabel = multiTeamMode ? `Developer (Epic: ${teamEpic?.id})` : 'Developer';
    AgentActivityService.emitMessage(
      taskId,
      developerLabel,
      `👨‍💻 Starting development${multiTeamMode ? ` for epic: ${teamEpic?.title}` : ''} with ${composition.developers} developer(s)...`
    );
    NotificationService.emitAgentStarted(taskId, developerLabel);

    try {
      // 🔥 EVENT SOURCING: Rebuild state from events
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task.id as any);

      console.log(`📝 [Developers] Rebuilt state from events: ${state.epics.length} epics, ${state.stories.length} stories`);

      // Validate state
      const validation = await eventStore.validateState(task.id as any);
      if (!validation.valid) {
        console.error('❌ CRITICAL: State validation failed:');
        validation.errors.forEach(err => console.error(`  - ${err}`));

        // 🔥 CRITICAL: Emit completion event to prevent infinite loop
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'DevelopersCompleted',
          agentName: 'developer',
          payload: {
            error: `State validation failed: ${validation.errors.join('; ')}`,
            failed: true,
          },
          metadata: {
            error: `State validation failed: ${validation.errors.join('; ')}`,
          },
        });

        console.log(`📝 [Developers] Emitted DevelopersCompleted event (validation failed)`);

        return {
          success: false,
          error: `State validation failed: ${validation.errors.join('; ')}`,
        };
      }

      // 🔥 MULTI-TEAM MODE: Filter to only this team's epic
      let epics = state.epics;
      if (multiTeamMode && teamEpic) {
        // In multi-team mode, only work on the team's assigned epic
        // 🔥 CRITICAL: Use teamEpic from context (has branchName) instead of EventStore epic
        const eventStoreEpic = state.epics.find(e => e.id === teamEpic.id);
        if (eventStoreEpic) {
          // Merge EventStore epic with teamEpic to get both branchName and latest state
          epics = [{ ...eventStoreEpic, branchName: teamEpic.branchName }];
          console.log(`🎯 [Developers] Multi-Team: Using team epic ${teamEpic.id} with branch ${teamEpic.branchName}`);
        } else {
          epics = state.epics.filter(e => e.id === teamEpic.id);
          console.log(`🎯 [Developers] Multi-Team: Filtered to team epic ${teamEpic.id} (was ${state.epics.length} epics, now ${epics.length})`);
        }
      }

      if (epics.length === 0) {
        // 🔥 CRITICAL: Emit completion event to prevent infinite loop
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'DevelopersCompleted',
          agentName: 'developer',
          payload: {
            error: 'No EpicCreated events found - Tech Lead phase incomplete',
            failed: true,
          },
          metadata: {
            error: 'No EpicCreated events found',
          },
        });

        console.log(`📝 [Developers] Emitted DevelopersCompleted event (no epics found)`);

        return {
          success: false,
          error: 'No EpicCreated events found - Tech Lead phase incomplete',
        };
      }

      console.log(`✅ [Developers] State validated: ${epics.length} epics with ${state.stories.length} total stories`);

      // 🔥 CRITICAL FIX: Validate ALL epics have targetRepository BEFORE processing
      // Fail fast to avoid wasting cost on developer execution with invalid epics
      console.log(`\n🔍 [Developers] Validating epic targetRepository fields...`);
      const invalidEpics = epics.filter((epic: any) => !epic.targetRepository);

      if (invalidEpics.length > 0) {
        console.error(`\n❌❌❌ [Developers] CRITICAL VALIDATION ERROR!`);
        console.error(`   ${invalidEpics.length}/${epics.length} epic(s) have NO targetRepository`);
        console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THESE EPICS BELONG TO`);
        console.error(`   💀 CANNOT EXECUTE DEVELOPERS - WOULD BE ARBITRARY`);
        console.error(`\n   📋 Invalid epics:`);
        invalidEpics.forEach((epic: any) => {
          console.error(`      - Epic: ${epic.name || epic.id}`);
          console.error(`        ID: ${epic.id}`);
          console.error(`        targetRepository: ${epic.targetRepository || 'MISSING'}`);
        });
        console.error(`\n   🛑 STOPPING PHASE - HUMAN INTERVENTION REQUIRED`);

        // Mark task as failed (fire-and-forget - error thrown after)
        updateTaskFireAndForget(task.id, {
          $set: {
            status: 'failed',
            'orchestration.developers': {
              status: 'failed',
              error: `${invalidEpics.length} epic(s) have no targetRepository - cannot determine which repo to work in`,
              humanRequired: true,
              invalidEpics: invalidEpics.map((e: any) => ({ id: e.id, name: e.name })),
            },
          },
        }, 'developers failed - no targetRepository');

        throw new Error(
          `HUMAN_REQUIRED: ${invalidEpics.length} epic(s) have no targetRepository - Tech Lead phase incomplete`
        );
      }

      console.log(`✅ [Developers] All ${epics.length} epic(s) have valid targetRepository`);

      await LogService.info(`Processing ${epics.length} epics across ${repositories.length} repositories`, {
        taskId,
        category: 'orchestration',
        phase: 'development',
        metadata: { epicsCount: epics.length, reposCount: repositories.length },
      });

      // Step 1: Apply Conservative Dependency Policy
      const policy = new ConservativeDependencyPolicy();
      const policyResult = policy.apply(epics as any, repositories);

      if (policyResult.policyApplied) {
        await LogService.success('Conservative Dependency Policy applied for cross-repo safety', {
          taskId,
          category: 'orchestration',
          phase: 'development',
          metadata: {
            dependenciesAdded: policyResult.addedDependencies.length,
            affectedEpics: policyResult.addedDependencies.map(d => d.epicName),
          },
        });

        // Log each added dependency for transparency
        for (const dep of policyResult.addedDependencies) {
          await LogService.info(`Dependency added: ${dep.epicName} - ${dep.reason}`, {
            taskId,
            category: 'orchestration',
            phase: 'development',
            epicName: dep.epicName,
            epicId: dep.epicId,
          });
        }
      } else {
        await LogService.info('Conservative Policy not applied (single repository)', {
          taskId,
          category: 'orchestration',
          phase: 'development',
        });
      }

      // Use modified epics with added dependencies
      const epicsWithPolicy = policyResult.modifiedEpics;

      // Step 2: Resolve execution order using DependencyResolver
      const resolver = new DependencyResolver();
      const resolutionResult = resolver.resolve(epicsWithPolicy);

      if (!resolutionResult.success) {
        return {
          success: false,
          error: `Dependency resolution failed: ${resolutionResult.error}`,
        };
      }

      const orderedEpics = resolutionResult.executionOrder;

      await LogService.success('Dependency resolution complete - Execution order established', {
        taskId,
        category: 'orchestration',
        phase: 'development',
        metadata: {
          epicsCount: orderedEpics.length,
          executionOrder: orderedEpics.map((e, i) => ({
            order: i + 1,
            epicName: e.name,
            targetRepo: e.targetRepository || 'MISSING', // 🔥 No fallback - should fail if missing
          })),
        },
      });

      // Log each epic in execution order
      for (let i = 0; i < orderedEpics.length; i++) {
        const epic = orderedEpics[i];
        const repo = epic.targetRepository || 'MISSING'; // 🔥 No fallback
        await LogService.info(`Execution order ${i + 1}: ${epic.name} → ${repo}`, {
          taskId,
          category: 'epic',
          phase: 'development',
          epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          epicName: epic.name,
          metadata: { executionOrder: i + 1, targetRepo: repo },
        });
      }

      // Build team
      const team: ITeamMember[] = [];

      // Create developers (unified - no senior/junior distinction)
      const totalDevelopers = composition?.developers || 1;
      for (let i = 0; i < totalDevelopers; i++) {
        const instanceId = `dev-${i + 1}`;
        const agentType = 'developer'; // Unified developer type

        const assignedStories = assignments
          .filter((a) => a.assignedTo === instanceId)
          .map((a) => a.storyId);

        // 🔥🔥🔥 STRICT VALIDATION: 1 DEVELOPER = 1 STORY (NEVER MORE) 🔥🔥🔥
        if (assignedStories.length > 1) {
          console.error(`❌❌❌ [CRITICAL VIOLATION] Developer ${instanceId} has ${assignedStories.length} stories assigned!`);
          console.error(`   Stories: ${assignedStories.join(', ')}`);
          console.error(`   RULE: 1 Developer = 1 Story. ALWAYS.`);
          console.error(`   This is a TechLead bug - fix storyAssignments to have 1 story per dev.`);
          throw new Error(
            `CRITICAL: Developer ${instanceId} assigned ${assignedStories.length} stories. ` +
            `Rule violation: 1 Developer = 1 Story. TechLead must create more developers.`
          );
        }

        team.push({
          agentType,
          instanceId,
          assignedStories,
          status: 'idle',
          pullRequests: [],
        });
      }

      // 🔥 Additional validation: Total developers must equal total stories
      const totalStoriesAssigned = team.reduce((sum, dev) => sum + dev.assignedStories.length, 0);
      const expectedStories = assignments.length;
      if (totalStoriesAssigned !== expectedStories) {
        console.warn(`⚠️  [DevelopersPhase] Story count mismatch: ${totalStoriesAssigned} assigned vs ${expectedStories} expected`);
      }

      // Save team to task (fire-and-forget)
      if (!multiTeamMode) {
        updateTaskFireAndForget(task.id, {
          $set: { 'orchestration.team': team },
        }, 'save team');
      }

      await LogService.success(`Development team spawned: ${team.length} developers`, {
        taskId,
        category: 'orchestration',
        phase: 'development',
        metadata: {
          developersCount: team.length,
          developers: team.map(t => ({ id: t.instanceId, type: t.agentType, storiesCount: t.assignedStories.length })),
        },
      });

      // Step 3: Execute epics in dependency order
      await LogService.info('Starting epic-by-epic execution (respecting dependencies)', {
        taskId,
        category: 'orchestration',
        phase: 'development',
        metadata: { epicsToExecute: orderedEpics.length },
      });

      for (const epic of orderedEpics) {
        // 🔥 CENTRALIZED: Normalize epicId ONCE at the top of the loop
        const normalizedEpicId = getEpicId(epic);

        await LogService.info(`Epic execution started: ${epic.name}`, {
          taskId,
          category: 'epic',
          phase: 'development',
          epicId: normalizedEpicId,
          epicName: epic.name,
          metadata: {
            targetRepo: epic.targetRepository,
            storiesCount: epic.stories.length,
          },
        });

        // Get developers assigned to this epic (by checking if they have stories from this epic)
        const epicStoryIds = epic.stories || [];
        const epicDevelopers = team.filter((member) =>
          member.assignedStories.some(storyId => epicStoryIds.includes(storyId))
        );

        // 🔥 DEBUG: Log what we found
        console.log(`\n🔍 [DEBUG] Epic "${epic.name}" (${normalizedEpicId}):`);
        console.log(`   Epic stories (${epicStoryIds.length}): ${epicStoryIds.join(', ')}`);
        console.log(`   Total team members: ${team.length}`);
        team.forEach(m => {
          console.log(`   - ${m.instanceId}: assigned ${m.assignedStories.length} stories: ${m.assignedStories.join(', ')}`);
        });
        console.log(`   Developers matched for this epic: ${epicDevelopers.length}`);

        if (epicDevelopers.length === 0) {
          await LogService.warn(`Epic skipped - No developers assigned: ${epic.name}`, {
            taskId,
            category: 'epic',
            phase: 'development',
            epicId: normalizedEpicId,
            epicName: epic.name,
          });
          console.error(`\n❌ [CRITICAL] No developers assigned to epic "${epic.name}"!`);
          console.error(`   This means story IDs don't match between epic.stories and team.assignedStories`);
          continue;
        }

        await LogService.info(`Developers assigned to ${epic.name}: ${epicDevelopers.map((d) => d.instanceId).join(', ')}`, {
          taskId,
          category: 'epic',
          phase: 'development',
          epicId: normalizedEpicId,
          epicName: epic.name,
          metadata: {
            developersCount: epicDevelopers.length,
            developers: epicDevelopers.map(d => d.instanceId),
          },
        });

        // 🔥 SEQUENTIAL EXECUTION: Stories execute one-by-one within epic
        // This prevents merge conflicts when multiple stories modify the same files
        // Each story starts from the LATEST epic branch (includes previous stories' changes)
        console.log(`\n📦 [EPIC] Starting SEQUENTIAL story execution for epic: ${epic.name}`);
        console.log(`   Stories will execute one at a time to avoid conflicts`);
        console.log(`   Each story will include changes from all previous stories`);

        // 🔄 UNIFIED STATE CHECK: Load completed stories from UnifiedMemory
        // Hierarchy: EventStore (primary) > UnifiedMemory (recovery) > merged flag (fast path)
        // GranularMemory removed - redundant with UnifiedMemory
        const unifiedMemoryCompletedStories = await loadUnifiedMemoryCompletedStories(taskId);

        let storyNumber = 0;
        const totalStories = epicDevelopers.reduce((sum, dev) => sum + (dev.assignedStories?.length || 0), 0);

        for (const member of epicDevelopers) {
          const assignedStories = member.assignedStories || [];

          for (const storyId of assignedStories) {
            storyNumber++;
            // 🔥 FIX: Use getStoryId() for consistent ID normalization across all sources
            const story = state.stories.find((s: any) => {
              try { return getStoryId(s) === storyId; } catch { return false; }
            });
            if (!story) {
              console.warn(`⚠️  Story ${storyId} not found in EventStore`);
              continue;
            }

            // 🔄 UNIFIED STATE CHECK: Skip stories that are already completed
            // Uses hierarchical check: EventStore > UnifiedMemory > merged flag
            const completionStatus = isStoryComplete(
              { status: story.status, mergedToEpic: (story as any).mergedToEpic },
              storyId,
              unifiedMemoryCompletedStories
            );

            if (completionStatus.isComplete) {
              logStorySkip(story.title, storyId, completionStatus);
              continue;
            }

            console.log(`\n${'='.repeat(80)}`);
            console.log(`🚀 [STORY ${storyNumber}/${totalStories}] Starting pipeline: ${story.title}`);
            console.log(`   Story ID: ${storyId}`);
            console.log(`   Developer: ${member.instanceId}`);
            console.log(`   Epic: ${epic.name}`);
            console.log(`   Branch strategy: Story will start from epic branch (includes ${storyNumber - 1} previous stories)`);
            console.log(`${'='.repeat(80)}`);

            // 🔥 EVENT SOURCING: Emit StoryStarted event for recovery tracking
            const { eventStore } = await import('../EventStore');

            // Get target repository info for this story
            const storyRepo = repositories.find(r =>
              r.repository?.fullName === epic.targetRepository ||
              r.repository?.name === epic.targetRepository?.split('/').pop()
            );
            const repoLocalPath = storyRepo?.localPath || workspacePath;

            await eventStore.safeAppend({
              taskId: task.id as any,
              eventType: 'StoryStarted',
              agentName: 'developer',
              payload: {
                storyId: getStoryId(story), // 🔥 CENTRALIZED: Use IdNormalizer
                epicId: normalizedEpicId, // 🔥 CENTRALIZED: Use normalized epicId
                title: story.title,
                developer: member.instanceId,
                // 🔥 NEW: Include workspace info for LivePreview
                workspacePath: workspacePath,
                repoLocalPath: repoLocalPath,
                targetRepository: epic.targetRepository,
                branchName: story.branchName || `story/${getStoryId(story)}`,
              },
            });
            console.log(`📝 [EventStore] Emitted StoryStarted for: ${story.title}`);
            console.log(`   📂 Workspace: ${workspacePath}`);
            console.log(`   📁 Repo path: ${repoLocalPath}`);

            // 🔥 RETRY LOGIC: Execute story pipeline with retry for transient errors
            const { RetryService } = await import('./RetryService');
            const MAX_STORY_RETRIES = parseInt(process.env.MAX_STORY_RETRIES || '3', 10);

            const costs = await RetryService.executeWithRetry(
              async () => this.storyPipeline.execute(
                task,
                story,
                member,
                epic,
                repositories,
                workspacePath,
                workspaceStructure,
                attachments,
                state,
                context
              ),
              {
                maxRetries: MAX_STORY_RETRIES,
                initialDelayMs: 2000,
                maxDelayMs: 30000,
                retryableErrors: [
                  'rate_limit',
                  'timeout',
                  'ECONNRESET',
                  'ETIMEDOUT',
                  '429',
                  '503',
                  'Credit balance is too low',
                ],
                onRetry: (attempt, error, delayMs) => {
                  console.log(`\n🔄 [STORY RETRY] Attempt ${attempt}/${MAX_STORY_RETRIES} for story: ${story.title}`);
                  console.log(`   Error: ${error?.message?.substring(0, 100) || 'Unknown'}`);
                  console.log(`   Waiting ${Math.round(delayMs / 1000)}s before retry...`);
                },
              }
            );

            // Accumulate costs and tokens using CostAccumulator
            if (costs) {
              phaseCosts.add('developer', costs.developerCost || 0, costs.developerTokens);
              phaseCosts.add('judge', costs.judgeCost || 0, costs.judgeTokens);
              phaseCosts.add('conflictResolution', costs.conflictResolutionCost || 0, {
                input: costs.conflictResolutionUsage?.input_tokens || 0,
                output: costs.conflictResolutionUsage?.output_tokens || 0,
              });

              // 🔥 COST TRACKING: Update member with accumulated costs
              // This ensures task.orchestration.team[] has accurate cost data
              member.cost_usd = (member.cost_usd || 0) + (costs.developerCost || 0);
              if (!member.usage) {
                member.usage = { input_tokens: 0, output_tokens: 0 };
              }
              member.usage.input_tokens += costs.developerTokens?.input || 0;
              member.usage.output_tokens += costs.developerTokens?.output || 0;
            }
          }
        }

        await LogService.success(`Epic completed: ${epic.name}`, {
          taskId,
          category: 'epic',
          phase: 'development',
          epicId: normalizedEpicId,
          epicName: epic.name,
        });
      }

      await LogService.success('All epics implemented in dependency order', {
        taskId,
        category: 'orchestration',
        phase: 'development',
        metadata: {
          epicsCount: orderedEpics.length,
          developersCount: team.length,
        },
      });

      // Store phase data
      context.setData('developmentTeam', team);
      context.setData('developmentComplete', true);
      context.setData('epicExecutionOrder', orderedEpics.map((e) => e.id));
      context.setData('dependencyResolution', resolutionResult);

      // 🔥🔥🔥 BUG-004 FIX: Verify stories were ACTUALLY completed before emitting success 🔥🔥🔥
      // Count ASSIGNED stories (what we planned to do)
      const assignedStoriesCount = team.reduce((sum, m) => sum + m.assignedStories.length, 0);

      // Count ACTUALLY COMPLETED stories (from EventStore - source of truth)
      const allEvents = await eventStore.getEvents(task.id as any);
      const storyCompletedEvents = allEvents.filter((e: any) => e.eventType === 'StoryCompleted');
      const actuallyCompletedCount = storyCompletedEvents.length;

      console.log(`\n📊 [BUG-004 CHECK] Story Execution Verification:`);
      console.log(`   Assigned stories: ${assignedStoriesCount}`);
      console.log(`   Actually completed (StoryCompleted events): ${actuallyCompletedCount}`);

      // 🛡️ GUARD: If no stories were actually completed, this is a failure (BUG-004)
      if (actuallyCompletedCount === 0 && assignedStoriesCount > 0) {
        console.error(`[BUG-004] DevelopersPhase: 0/${assignedStoriesCount} stories executed`);
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'DevelopersCompleted',
          agentName: 'developer',
          payload: {
            developersCount: team.length,
            storiesImplemented: 0,
            storiesAssigned: assignedStoriesCount,
            epicsCount: orderedEpics.length,
            failed: true,
            error: 'BUG-004: No stories were actually completed despite having assigned stories',
          },
        });

        console.log(`📝 [Developers] Emitted DevelopersCompleted event (BUG-004 - no stories executed)`);
      } else {
        // 🔥 EVENT SOURCING: Emit completion event (TRUE SUCCESS CASE)
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'DevelopersCompleted',
          agentName: 'developer',
          payload: {
            developersCount: team.length,
            storiesImplemented: actuallyCompletedCount, // Use ACTUAL count, not assigned
            storiesAssigned: assignedStoriesCount,
            epicsCount: orderedEpics.length,
          },
        });

        console.log(`📝 [Developers] Emitted DevelopersCompleted event (success: ${actuallyCompletedCount}/${assignedStoriesCount} stories)`);
      }

      // 🔥 REMOVED: granularMemoryService.storeProgress - SQLite tracks this via task.orchestration

      // 🎯 ACTIVITY: Emit Developers completion for Activity tab
      AgentActivityService.emitToolUse(taskId, developerLabel, 'Development', {
        developers: team.length,
        stories: actuallyCompletedCount,
        storiesAssigned: assignedStoriesCount,
        epics: orderedEpics.length,
      });
      AgentActivityService.emitMessage(
        taskId,
        developerLabel,
        `✅ Development complete: ${actuallyCompletedCount}/${assignedStoriesCount} stories implemented by ${team.length} developer(s)`
      );
      NotificationService.emitAgentCompleted(taskId, developerLabel, `${actuallyCompletedCount}/${assignedStoriesCount} stories implemented`);

      // Log cost summary using CostAccumulator
      const devTokens = phaseCosts.getTokens('developer');
      const judgeTokens = phaseCosts.getTokens('judge');
      const crTokens = phaseCosts.getTokens('conflictResolution');

      console.log(`\n💰 Development Phase Cost Summary:`);
      console.log(`   Developers total: ${CostAccumulator.formatCost(phaseCosts.getCost('developer'))} (${CostAccumulator.formatTokens(devTokens)})`);
      console.log(`   Judge total: ${CostAccumulator.formatCost(phaseCosts.getCost('judge'))} (${CostAccumulator.formatTokens(judgeTokens)})`);
      if (phaseCosts.getCost('conflictResolution') > 0) {
        console.log(`   Conflict Resolution: ${CostAccumulator.formatCost(phaseCosts.getCost('conflictResolution'))} (${CostAccumulator.formatTokens(crTokens)})`);
      }
      console.log(`   Phase total: ${CostAccumulator.formatCost(phaseCosts.getTotalCost())}`);

      // 🔥 COST TRACKING: Save costs to task.orchestration (atomic update to avoid version conflicts)
      if (!multiTeamMode) {
        // ⚡ OPTIMIZATION: Fetch current task to get totalCost
        const currentTask = TaskRepository.findById(task.id);
        const currentTotalCost = currentTask?.orchestration?.totalCost || 0;

        updateTaskFireAndForget(task.id, {
          $set: {
            'orchestration.team': team,
            'orchestration.judge': {
              agent: 'judge',
              status: 'completed',
              evaluations: [],
              cost_usd: phaseCosts.getCost('judge'),
              usage: {
                input_tokens: judgeTokens.input,
                output_tokens: judgeTokens.output,
              },
            },
            'orchestration.totalCost': currentTotalCost + phaseCosts.getTotalCost(),
          },
        }, 'developers costs update');
        console.log(`✅ [Developers] Costs saved (fire-and-forget)`);
      }

      return {
        success: true,
        data: {
          team,
          developersCount: team.length,
          storiesImplemented: team.reduce(
            (sum, m) => sum + m.assignedStories.length,
            0
          ),
          epicExecutionOrder: orderedEpics.map((e) => ({ id: e.id, name: e.name })),
          policyApplied: policyResult.policyApplied,
        },
        metrics: {
          developers_count: team.length,
          stories_count: team.reduce((sum, m) => sum + m.assignedStories.length, 0),
          epics_count: orderedEpics.length,
          dependencies_added: policyResult.addedDependencies.length,
        },
        metadata: {
          cost: phaseCosts.getCost('developer'),  // Main phase cost (developers)
          judgeCost: phaseCosts.getCost('judge'),  // Additional judge cost to track separately
          input_tokens: devTokens.input,
          output_tokens: devTokens.output,
          judge_input_tokens: judgeTokens.input,
          judge_output_tokens: judgeTokens.output,
        },
      };
    } catch (error: any) {
      console.error(`❌ [Developers] Critical error: ${error.message}`);
      console.error(error.stack);

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.safeAppend({
        taskId: task.id as any,
        eventType: 'DevelopersCompleted', // Mark as completed even on error
        agentName: 'developer',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [Developers] Emitted DevelopersCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
