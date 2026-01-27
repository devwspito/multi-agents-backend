import { BasePhase, OrchestrationContext, PhaseResult, updateTaskFireAndForget } from './Phase';
import { ITeamMember, TaskRepository } from '../../database/repositories/TaskRepository.js';
import { DependencyResolver } from '../dependencies/DependencyResolver';
import { ConservativeDependencyPolicy } from '../dependencies/ConservativeDependencyPolicy';
import { LogService } from '../logging/LogService';
import { HookService } from '../HookService';
import { AgentActivityService } from '../AgentActivityService';
import { NotificationService } from '../NotificationService';
import { safeGitExecSync, fixGitRemoteAuth, smartGitFetch } from '../../utils/safeGitExecution';
import { sandboxService } from '../SandboxService.js';
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';
import { ProactiveIssueDetector } from '../ProactiveIssueDetector';
import { ProjectRadiography } from '../ProjectRadiographyService';
import { sessionCheckpointService } from '../SessionCheckpointService';
// 🔥 REMOVED: granularMemoryService - SQLite (UnifiedMemoryService) is the single source of truth
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 📦 Utility helpers
import { assertValidWorkspacePath } from './utils/WorkspaceValidator';
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { logSection } from './utils/LogHelpers';
import { isEmpty } from './utils/ArrayHelpers';
import { CostAccumulator } from './utils/CostAccumulator';
import { getEpicId, getStoryId } from './utils/IdNormalizer';
// ⏱️ Centralized timeout constants (replaces magic numbers)
import { GIT_TIMEOUTS, AGENT_TIMEOUTS } from './constants/Timeouts';
// 🔄 Unified state checking (replaces 4-way state checks)
import { isStoryComplete, loadUnifiedMemoryCompletedStories, logStorySkip } from './utils/StateChecker';
// 🔍 Failure classification (determines retry vs fatal)
import {
  classifyFailure,
  logFailureAnalysis,
  isTerminalFailure,
  getTerminalFailureReason,
  type FailureContext,
} from './utils/FailureClassifier';
// 🔧 Git work recovery helpers
import {
  detectWorkInWorkspace,
  comprehensiveWorkRecovery,
} from './utils/GitCommitHelper';

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

// ═══════════════════════════════════════════════════════════════════════════════
// 🔧 STORY ISOLATION TOGGLE (configurable via .env)
// ═══════════════════════════════════════════════════════════════════════════════
// When FALSE: All developers work on the SAME shared workspace (sequential execution)
//            - dev-2 sees dev-1's changes directly
//            - Simpler flow, no git sync between stories
//            - Required for current sequential execution model
//
// When TRUE: Each story gets an isolated copy of the repository
//            - Enables parallel story execution in the future
//            - Requires git sync to merge changes between stories
//            - More complex but allows true parallelism
//
// Set in .env: ENABLE_STORY_ISOLATION=false (default) or ENABLE_STORY_ISOLATION=true
// ═══════════════════════════════════════════════════════════════════════════════
const ENABLE_STORY_ISOLATION = process.env.ENABLE_STORY_ISOLATION === 'true';

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

  /**
   * 🔥 STAGE METHODS REGISTRY
   * These methods are used for mid-story recovery via direct-to-Judge flow.
   * This property exists to register all stage methods for TypeScript.
   */
  private readonly _stageMethods = {
    developer: this.executeDeveloperStage.bind(this),
    gitValidation: this.executeGitValidationStage.bind(this),
    judge: this.executeJudgeStage.bind(this),
    merge: this.executeMergeStage.bind(this),
  };

  constructor(
    private executeDeveloperFn: Function,
    private executeAgentFn?: Function // For Judge execution (optional for backward compatibility)
  ) {
    super();
    // Reference _stageMethods to satisfy TypeScript's unused check
    void this._stageMethods;
  }

  /**
   * 🔥 SMART RECOVERY: Verify developer work from Git when markers are missing
   *
   * This handles the case where:
   * - Developer completed the work and made commits
   * - But forgot to output the marker in their response
   *
   * We verify by checking git log for recent commits on the story branch.
   * If commits exist, we extract the SHA and continue - don't fail just because
   * the agent forgot to say the magic words!
   *
   * @returns { commitSHA: string, hasCommits: boolean, commitCount: number } or null if error
   */
  private async verifyDeveloperWorkFromGit(
    workspacePath: string | null,
    repoName: string,
    branchName: string,
    storyId: string
  ): Promise<{ commitSHA: string | null; hasCommits: boolean; commitCount: number; commitMessage?: string } | null> {
    if (!workspacePath) {
      console.warn(`⚠️ [GIT_VERIFY] No workspacePath - cannot verify git work`);
      return null;
    }

    const repoPath = `${workspacePath}/${repoName}`;

    try {
      // First, make sure we're on the right branch or it exists
      const checkBranch = safeGitExecSync(`git branch --list "${branchName}"`, { cwd: repoPath });

      if (!checkBranch || checkBranch.trim() === '') {
        // Branch doesn't exist locally, try to fetch it
        console.log(`🔍 [GIT_VERIFY] Branch ${branchName} not found locally, fetching...`);
        safeGitExecSync(`git fetch origin ${branchName}:${branchName} 2>/dev/null || true`, { cwd: repoPath });
      }

      // Get the latest commit on the branch
      // Using --no-walk to just get the HEAD commit
      const gitLogResult = safeGitExecSync(
        `git log ${branchName} --oneline -n 5 2>/dev/null || git log origin/${branchName} --oneline -n 5 2>/dev/null || echo ""`,
        { cwd: repoPath }
      );

      if (!gitLogResult || gitLogResult.trim() === '') {
        console.log(`📭 [GIT_VERIFY] No commits found on branch ${branchName}`);
        return { commitSHA: null, hasCommits: false, commitCount: 0 };
      }

      const commits = gitLogResult.trim().split('\n').filter(Boolean);
      const commitCount = commits.length;

      // Get the full SHA of the latest commit
      const latestCommitLine = commits[0];
      const shortSHA = latestCommitLine.split(' ')[0];

      // Get full SHA
      const fullSHA = safeGitExecSync(
        `git rev-parse ${shortSHA} 2>/dev/null || git rev-parse origin/${branchName} 2>/dev/null`,
        { cwd: repoPath }
      )?.trim();

      // Get commit message
      const commitMessage = latestCommitLine.substring(shortSHA.length + 1).trim();

      console.log(`✅ [GIT_VERIFY] Found ${commitCount} commits on branch ${branchName}`);
      console.log(`   Latest commit: ${fullSHA?.substring(0, 8)} - ${commitMessage}`);
      console.log(`   Story: ${storyId}`);

      return {
        commitSHA: fullSHA || shortSHA,
        hasCommits: true,
        commitCount,
        commitMessage
      };
    } catch (error: any) {
      console.error(`❌ [GIT_VERIFY] Error verifying git work:`, error.message);
      return null;
    }
  }

  /**
   * 🎯 UNIFIED MEMORY: Skip if developers already completed all stories
   *
   * Uses UnifiedMemoryService as THE SINGLE SOURCE OF TRUTH.
   * In multi-team mode, checks story completion per-epic.
   */
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

    console.log(`   ❌ Phase not completed - Developers must execute`);
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
            const story = state.stories.find((s: any) => s.id === storyId);
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
              async () => this.executeIsolatedStoryPipeline(
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
      context.setData('executeDeveloperFn', this.executeDeveloperFn); // Store for Judge retry mechanism

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
        console.error(`\n❌❌❌ [BUG-004] CRITICAL: DevelopersPhase completed but 0 stories were actually executed! ❌❌❌`);
        console.error(`   This indicates DevelopersPhase was skipped or failed silently.`);
        console.error(`   Assigned: ${assignedStoriesCount} stories across ${orderedEpics.length} epics`);
        console.error(`   Completed: 0 stories (NO StoryCompleted events found)`);
        console.error(`   🚨 Emitting DevelopersCompleted with failed=true to prevent false success`);

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

  /**
   * Execute isolated story pipeline: 1 Story = 1 Dev + 1 Judge
   * 🔥🔥🔥 CRITICAL: Each DEV+JUDGE pair works in its OWN ISOLATED WORKSPACE 🔥🔥🔥
   * This prevents git conflicts between parallel story executions.
   *
   * Workspace structure:
   *   team-1/
   *     story-ABC123/
   *       v2_backend/    ← Developer works here
   *                      ← Judge reviews here (same isolated copy)
   *     story-DEF456/
   *       v2_backend/    ← Different DEV+JUDGE pair (no conflicts!)
   */
  private async executeIsolatedStoryPipeline(
    task: any,
    story: any,
    developer: any,
    epic: any,
    repositories: any[],
    workspacePath: string | null,
    workspaceStructure: string,
    attachments: any[],
    state: any,
    context: OrchestrationContext
  ): Promise<{
    developerCost: number;
    judgeCost: number;
    conflictResolutionCost: number;
    developerTokens: { input: number; output: number };
    judgeTokens: { input: number; output: number };
    conflictResolutionUsage: { input_tokens: number; output_tokens: number };
  }> {
    const taskId = (task.id as any).toString();
    const fs = require('fs');
    const { execSync } = require('child_process');

    // 🐳 SANDBOX: Get sandbox ID for Docker execution
    const pipelineSandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const pipelineSandboxId = pipelineSandboxMap?.get(epic.targetRepository);

    // 🔥🔥🔥 ISOLATED STORY WORKSPACE 🔥🔥🔥
    // Each DEV+JUDGE pair gets its own copy of the repository
    // This prevents git conflicts when multiple stories are worked on in parallel
    // 🔧 TOGGLE: Controlled by ENABLE_STORY_ISOLATION constant at top of file
    let storyWorkspacePath: string | null = null;

    if (ENABLE_STORY_ISOLATION) {
      // When enabled: Each story gets isolated workspace
      storyWorkspacePath = workspacePath ? `${workspacePath}/story-${story.id}` : null;
    } else {
      // When disabled: All devs share the same workspace (sequential execution)
      console.log(`\n🔧 [Story ${story.id}] STORY ISOLATION DISABLED - using shared workspace`);
      console.log(`   📁 Shared workspace: ${workspacePath}`);
      console.log(`   👨‍💻 Developer: ${developer.instanceId}`);
      console.log(`   ℹ️  All developers work on the same workspace sequentially\n`);
    }

    if (ENABLE_STORY_ISOLATION && storyWorkspacePath && epic.targetRepository) {
      const isolatedRepoPath = `${storyWorkspacePath}/${epic.targetRepository}`;
      const sourceRepoPath = `${workspacePath}/${epic.targetRepository}`;
      const lockFilePath = `${storyWorkspacePath}/.workspace.lock`;

      console.log(`\n🔒🔒🔒 [Story ${story.id}] CREATING ISOLATED WORKSPACE 🔒🔒🔒`);
      console.log(`   📁 Source repo: ${sourceRepoPath}`);
      console.log(`   📁 Story workspace: ${storyWorkspacePath}`);
      console.log(`   📁 Isolated repo: ${isolatedRepoPath}`);
      console.log(`   👨‍💻 Developer: ${developer.instanceId}`);
      console.log(`   ⚖️  Judge will review in SAME isolated workspace`);

      // 🔒 CRITICAL: Acquire lock before workspace operations to prevent race conditions
      // Multiple parallel stories may try to create workspaces simultaneously
      const acquireLock = async (maxRetries = 30, retryDelayMs = 100): Promise<number | null> => {
        fs.mkdirSync(storyWorkspacePath, { recursive: true });

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Try to create lock file exclusively (O_CREAT | O_EXCL)
            const fd = fs.openSync(lockFilePath, 'wx');
            fs.writeSync(fd, `${process.pid}\n${new Date().toISOString()}`);
            return fd;
          } catch (err: any) {
            if (err.code === 'EEXIST') {
              // Lock exists - check if it's stale (older than 5 minutes)
              try {
                const stat = fs.statSync(lockFilePath);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs > 5 * 60 * 1000) {
                  console.log(`   ⚠️ Removing stale lock (age: ${Math.round(ageMs/1000)}s)`);
                  fs.unlinkSync(lockFilePath);
                  continue;
                }
              } catch { /* Lock was removed by another process */ }

              if (attempt < maxRetries - 1) {
                await new Promise(r => setTimeout(r, retryDelayMs));
                continue;
              }
            }
            throw err;
          }
        }
        return null;
      };

      const releaseLock = (fd: number | null) => {
        try {
          if (fd !== null) fs.closeSync(fd);
          if (fs.existsSync(lockFilePath)) fs.unlinkSync(lockFilePath);
        } catch { /* Ignore cleanup errors */ }
      };

      let lockFd: number | null = null;
      try {
        lockFd = await acquireLock();
        if (lockFd === null) {
          console.warn(`   ⚠️ Could not acquire workspace lock - proceeding without lock`);
        } else {
          console.log(`   🔐 Acquired workspace lock`);
        }

        // Copy repository to isolated workspace (if not already copied)
        if (!fs.existsSync(isolatedRepoPath)) {
          if (!fs.existsSync(sourceRepoPath)) {
            console.error(`   ❌ Source repository not found: ${sourceRepoPath}`);
            throw new Error(`Source repository not found for story ${story.id}: ${sourceRepoPath}`);
          }

          console.log(`   📋 Copying repository to isolated workspace...`);
          // 🔥 Use rsync instead of cp to handle broken symlinks (Flutter .plugin_symlinks)
          try {
            execSync(`rsync -a --ignore-errors "${sourceRepoPath}/" "${isolatedRepoPath}/"`, { encoding: 'utf8', stdio: 'pipe' });
          } catch {
            // Fallback: Delete broken symlinks first, then use cp
            try {
              execSync(`find "${sourceRepoPath}" -type l ! -exec test -e {} \\; -delete 2>/dev/null || true`, { encoding: 'utf8', stdio: 'pipe' });
            } catch { /* ignore */ }
            execSync(`cp -R "${sourceRepoPath}" "${isolatedRepoPath}"`, { encoding: 'utf8' });
          }
          console.log(`   ✅ Repository copied to isolated workspace`);

          // 🔥 CRITICAL: Ensure isolated repo has proper git remote
          // The copied repo should have the same remote as source
          try {
            const remoteUrl = execSync(`git -C "${sourceRepoPath}" remote get-url origin`, { encoding: 'utf8' }).trim();
            execSync(`git -C "${isolatedRepoPath}" remote set-url origin "${remoteUrl}"`, { encoding: 'utf8' });
            console.log(`   ✅ Git remote configured in isolated workspace`);
          } catch (remoteError: any) {
            console.warn(`   ⚠️ Could not set git remote: ${remoteError.message}`);
          }

          // 🔥🔥🔥 SEQUENTIAL SYNC: Pull epic branch to get changes from previous stories 🔥🔥🔥
          // This is CRITICAL for sequential execution - without this, story-2 won't see story-1's changes
          const epicBranch = epic.branchName;
          if (epicBranch) {
            try {
              console.log(`\n   🔄 [SEQUENTIAL SYNC] Syncing with epic branch: ${epicBranch}`);

              // 1. Fetch latest from remote
              execSync(`git -C "${isolatedRepoPath}" fetch origin`, { encoding: 'utf8', timeout: 60000 });
              console.log(`   ✅ Fetched from origin`);

              // 2. Checkout epic branch (or create tracking branch if doesn't exist locally)
              try {
                execSync(`git -C "${isolatedRepoPath}" checkout ${epicBranch}`, { encoding: 'utf8' });
              } catch (checkoutError: any) {
                if (checkoutError.message.includes('did not match any file')) {
                  // Branch doesn't exist locally, create from remote
                  execSync(`git -C "${isolatedRepoPath}" checkout -b ${epicBranch} origin/${epicBranch}`, { encoding: 'utf8' });
                } else {
                  throw checkoutError;
                }
              }
              console.log(`   ✅ Checked out ${epicBranch}`);

              // 3. Pull latest changes (this brings story-1's changes for story-2, etc.)
              const pullOutput = execSync(`git -C "${isolatedRepoPath}" pull origin ${epicBranch}`, { encoding: 'utf8', timeout: 60000 });
              console.log(`   ✅ Pulled latest from ${epicBranch}`);
              if (pullOutput.includes('Already up to date')) {
                console.log(`   ℹ️  No new changes from previous stories`);
              } else {
                console.log(`   📥 Received changes from previous stories`);
              }

              console.log(`   🔄 [SEQUENTIAL SYNC] COMPLETE - workspace has all previous story changes\n`);
            } catch (syncError: any) {
              console.warn(`   ⚠️ [SEQUENTIAL SYNC] Could not sync with epic: ${syncError.message}`);
              // Non-fatal: story can still work, but may have conflicts at merge time
              if (syncError.message.includes("couldn't find remote ref")) {
                console.log(`   ℹ️  Epic branch not on remote yet - this is likely the first story`);
              }
            }
          }
        } else {
          console.log(`   ℹ️  Isolated workspace already exists`);
        }
      } finally {
        releaseLock(lockFd);
        console.log(`   🔓 Released workspace lock`);
      }

      console.log(`🔒🔒🔒 [Story ${story.id}] ISOLATED WORKSPACE READY 🔒🔒🔒\n`);
    }

    // 🔥 Use isolated story workspace for ALL operations in this pipeline
    const effectiveWorkspacePath = storyWorkspacePath || workspacePath;

    // 🔥🔥🔥 CRITICAL VALIDATION: effectiveWorkspacePath MUST be valid for Judge 🔥🔥🔥
    console.log(`\n🔍 [executeIsolatedStoryPipeline] Workspace validation:`);
    console.log(`   workspacePath (param): ${workspacePath || 'NULL ⚠️'}`);
    console.log(`   storyWorkspacePath: ${storyWorkspacePath || 'NULL ⚠️'}`);
    console.log(`   effectiveWorkspacePath: ${effectiveWorkspacePath || 'NULL ⚠️'}`);

    if (!effectiveWorkspacePath) {
      console.error(`\n❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌`);
      console.error(`❌ [executeIsolatedStoryPipeline] CRITICAL: effectiveWorkspacePath is NULL!`);
      console.error(`   Story: ${story.title}`);
      console.error(`   Developer: ${developer.instanceId}`);
      console.error(`   Epic: ${epic.name}`);
      console.error(`\n   🚨 This means:`);
      console.error(`   - Judge will receive NULL workspacePath`);
      console.error(`   - Judge will search in PROJECT directory instead of agent workspace`);
      console.error(`   - Code review will be completely WRONG`);
      console.error(`❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n`);

      throw new Error(
        `HUMAN_REQUIRED: Story pipeline cannot execute without workspace. ` +
        `Story "${story.title}" (${story.id}) aborted. ` +
        `workspacePath=${workspacePath}, storyWorkspacePath=${storyWorkspacePath}`
      );
    }

    console.log(`   ✅ Workspace path valid: ${effectiveWorkspacePath}`);

    // 🔥 Emit workspace ready notification for LivePreview
    if (epic.targetRepository) {
      const fullRepoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      NotificationService.emitStoryWorkspaceReady(
        taskId,
        fullRepoPath,
        epic.targetRepository,
        epic.name,
        story.title
      );
    }

    // 🔥 CRITICAL VALIDATION: Epic MUST have targetRepository
    if (!epic.targetRepository) {
      console.error(`\n❌❌❌ [PIPELINE] CRITICAL ERROR: Epic has NO targetRepository!`);
      console.error(`   Epic: ${epic.name}`);
      console.error(`   Epic ID: ${epic.id}`);
      console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THIS EPIC BELONGS TO`);
      console.error(`   💀 CANNOT EXECUTE DEVELOPER - WOULD BE ARBITRARY`);
      console.error(`\n   🛑 STOPPING PIPELINE - HUMAN INTERVENTION REQUIRED`);

      // Mark task as FAILED (fire-and-forget - error thrown after)
      updateTaskFireAndForget(task.id, {
        $set: {
          status: 'failed',
          'orchestration.developers': {
            status: 'failed',
            error: `Epic ${epic.id} has no targetRepository - cannot determine which repo to work in`,
            humanRequired: true,
          },
        },
      }, 'epic no targetRepository');

      throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository`);
    }

    // 🔥 CRITICAL VALIDATION: Story MUST have targetRepository (inherited from epic)
    if (!story.targetRepository) {
      console.error(`\n❌❌❌ [PIPELINE] CRITICAL ERROR: Story has NO targetRepository!`);
      console.error(`   Story: ${story.title}`);
      console.error(`   Story ID: ${story.id}`);
      console.error(`   Epic: ${epic.name} (targetRepository: ${epic.targetRepository})`);
      console.error(`\n   💀 Story should have inherited targetRepository from epic`);
      console.error(`   💀 This is a DATA INTEGRITY issue`);
      console.error(`\n   🛑 STOPPING PIPELINE - HUMAN INTERVENTION REQUIRED`);

      // Mark task as FAILED (fire-and-forget - error thrown after)
      updateTaskFireAndForget(task.id, {
        $set: {
          status: 'failed',
          'orchestration.developers': {
            status: 'failed',
            error: `Story ${story.id} has no targetRepository - data integrity issue`,
            humanRequired: true,
          },
        },
      }, 'story no targetRepository');

      throw new Error(`HUMAN_REQUIRED: Story ${story.id} has no targetRepository`);
    }

    // 🔥 SUCCESS: We know EXACTLY where to work
    console.log(`✅ [PIPELINE] Repository assignment validated:`);
    console.log(`   Epic: ${epic.name} → ${epic.targetRepository}`);
    console.log(`   Story: ${story.title} → ${story.targetRepository}`);

    // 🔥 RECOVERY-READY: Declare key variables OUTSIDE try block so catch can access them
    const epicBranchName = context.getData<string>('epicBranch');
    const normalizedEpicId = getEpicId(epic);
    const normalizedStoryId = getStoryId(story);
    const devAuth = context.getData<any>('devAuth');
    const architectureBrief = context.getData<any>('architectureBrief');
    const environmentCommands = context.getData<any>('environmentCommands');
    const projectRadiographies = context.getData<Map<string, ProjectRadiography>>('projectRadiographies');

    // 🐳 SANDBOX: Get sandbox map from context (created by PlanningPhase)
    const sandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const sandboxId = sandboxMap?.get(epic.targetRepository);
    if (sandboxId) {
      console.log(`🐳 [DevelopersPhase] Using sandbox ${sandboxId} for repo ${epic.targetRepository}`);
    } else {
      console.log(`⚠️  [DevelopersPhase] No sandbox found for repo ${epic.targetRepository} - using host`);
    }

    try {
      // STEP 1: Developer implements story
      console.log(`\n👨‍💻 [STEP 1/3] Developer ${developer.instanceId} implementing story...`);

      // 🛡️ VALIDATION: Epic branch is required for proper git workflow
      if (!epicBranchName) {
        console.error(`\n❌❌❌ [VALIDATION] CRITICAL: Epic branch name is missing from context!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Epic: ${epic.name}`);
        console.error(`   Developer: ${developer.instanceId}`);
        console.error(`\n   🚨 This means:`);
        console.error(`   - Developer will not know which branch to base work on`);
        console.error(`   - Commits may go to wrong branch or fail`);
        console.error(`   - TeamOrchestrationPhase should have set this in context.setData('epicBranch', ...)`);
        throw new Error(`CRITICAL: Epic branch name missing from context - cannot execute developer for story "${story.title}"`);
      }
      console.log(`📂 [DevelopersPhase] Using epic branch: ${epicBranchName}`);

      // 🔐 devAuth, architectureBrief, environmentCommands, projectRadiographies declared outside try for recovery
      if (architectureBrief) {
        console.log(`🏗️ [DevelopersPhase] Architecture brief available - developer will follow project patterns`);
      }
      if (projectRadiographies) {
        const targetRadiography = projectRadiographies.get(epic.targetRepository);
        if (targetRadiography) {
          console.log(`🔬 [DevelopersPhase] Project radiography available for ${epic.targetRepository}: ${targetRadiography.language.primary}/${targetRadiography.framework.name}`);
        }
      }
      if (environmentCommands) {
        console.log(`🔧 [DevelopersPhase] Environment commands available - developer will use project-specific verification`);
        console.log(`   Test: ${environmentCommands.test || '(not specified)'}`);
        console.log(`   Lint: ${environmentCommands.lint || '(not specified)'}`);
        console.log(`   Typecheck: ${environmentCommands.typecheck || '(not specified)'}`);
      } else {
        console.log(`⚠️  [DevelopersPhase] No environment commands - developer will use default verification`);
      }

      // 🔥 DEFENSIVE VALIDATION: Check effectiveWorkspacePath type before calling executeDeveloperFn
      if (typeof effectiveWorkspacePath !== 'string' && effectiveWorkspacePath !== null) {
        console.error(`❌❌❌ [DevelopersPhase.executeIsolatedStoryPipeline] CRITICAL: effectiveWorkspacePath is not a string!`);
        console.error(`   Type: ${typeof effectiveWorkspacePath}`);
        console.error(`   Value: ${JSON.stringify(effectiveWorkspacePath)}`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Developer: ${developer.instanceId}`);
        throw new Error(`CRITICAL: effectiveWorkspacePath must be a string, received ${typeof effectiveWorkspacePath}: ${JSON.stringify(effectiveWorkspacePath)}`);
      }

      // 🔥🔥🔥 ISOLATED WORKSPACE: Developer works in story-specific workspace 🔥🔥🔥
      console.log(`   📂 Developer workspace: ${effectiveWorkspacePath}/${epic.targetRepository}`);

      // 🔥🔥🔥 CRITICAL: 1 Developer = 1 Story 🔥🔥🔥
      // Developer should NEVER receive multiple stories!
      // Pass ONLY the story this Developer is assigned to work on.
      console.log(`   🎯 Developer ${developer.instanceId} working on SINGLE story: "${story.title}"`);
      console.log(`   📍 Story ID: ${story.id}`);
      console.log(`   ⚠️  Passing 1 story (NOT ${state.stories.length} stories)`);

      // 🔔 Emit to frontend so user sees developer starting work
      const { NotificationService } = await import('../NotificationService');
      NotificationService.emitConsoleLog(
        (task.id as any).toString(),
        'info',
        `👨‍💻 Developer ${developer.instanceId} starting: "${story.title}"`
      );

      // 🔥 MID-STORY RECOVERY: Check if we can skip to a later stage
      // normalizedEpicId and normalizedStoryId are declared outside try block for recovery access
      const existingProgress = await unifiedMemoryService.getStoryProgress(taskId, normalizedEpicId, normalizedStoryId);

      if (existingProgress && existingProgress.stage !== 'not_started') {
        console.log(`\n🔄 [MID-STORY RECOVERY] Found existing progress for story: ${story.title}`);
        console.log(`   Current stage: ${existingProgress.stage}`);
        console.log(`   Commit hash: ${existingProgress.commitHash || 'none'}`);
        console.log(`   SDK session: ${existingProgress.sdkSessionId || 'none'}`);

        // 🔥 SKIP LOGIC: If stage >= merged_to_epic, story is basically done
        if (existingProgress.stage === 'merged_to_epic' || existingProgress.stage === 'completed') {
          console.log(`\n✅ [MID-STORY RECOVERY] Story "${story.title}" already merged/completed - SKIPPING`);
          console.log(`   No need to re-execute developer or judge`);

          // Ensure it's marked as fully completed
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
            commitHash: existingProgress.commitHash,
          });

          // Return zero costs since we didn't execute anything
          return {
            developerCost: 0,
            judgeCost: 0,
            conflictResolutionCost: 0,
            developerTokens: { input: 0, output: 0 },
            judgeTokens: { input: 0, output: 0 },
            conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
          };
        }

        // 🔥 PARTIAL SKIP: If stage >= pushed, we can skip developer and go straight to Judge
        // This means code is committed and pushed, we just need Judge review
        if (existingProgress.stage === 'pushed' || existingProgress.stage === 'judge_evaluating') {
          console.log(`\n🔄 [MID-STORY RECOVERY] Story "${story.title}" code already pushed`);
          console.log(`   🚀 DIRECT-TO-JUDGE: Skipping developer phase entirely!`);
          console.log(`   Using commit: ${existingProgress.commitHash || 'will detect from git'}`);

          // 🔥 DIRECT-TO-JUDGE FLOW: Skip Developer, go straight to Judge and Merge
          const commitSHA = existingProgress.commitHash;
          const storyBranch = story.branchName;

          if (!commitSHA || !storyBranch) {
            console.error(`❌ Cannot direct-to-judge: missing commitSHA or storyBranch`);
            console.log(`   commitSHA: ${commitSHA || 'missing'}`);
            console.log(`   storyBranch: ${storyBranch || 'missing'}`);
            // Fall through to re-run developer
          } else {
            // Create pipeline context for stage methods
            const pipelineCtx: StoryPipelineContext = {
              task,
              story,
              developer,
              epic,
              repositories,
              effectiveWorkspacePath,
              workspaceStructure,
              attachments,
              state,
              context,
              taskId,
              normalizedEpicId,
              normalizedStoryId,
              epicBranchName,
              devAuth: context.getData<any>('devAuth'),
              architectureBrief: context.getData<any>('architectureBrief'),
              environmentCommands: context.getData<any>('environmentCommands'),
              projectRadiographies: context.getData<Map<string, ProjectRadiography>>('projectRadiographies'),
              sandboxId, // 🐳 Explicit sandbox ID for Docker execution
            };

            // 🔥 JUMP DIRECTLY TO JUDGE
            console.log(`\n⚖️ [DIRECT-TO-JUDGE] Executing Judge stage...`);
            const judgeResult = await this.executeJudgeStage(pipelineCtx, commitSHA, storyBranch);

            if (!judgeResult.success) {
              console.error(`❌ Judge stage failed: ${judgeResult.error}`);
              return {
                developerCost: 0,
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: 0,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
              };
            }

            if (judgeResult.approved) {
              // 🔥 MERGE STAGE
              console.log(`\n🔀 [DIRECT-TO-JUDGE] Judge approved - executing Merge stage...`);
              const mergeResult = await this.executeMergeStage(pipelineCtx, commitSHA);

              // Emit completion events
              const { eventStore } = await import('../EventStore');
              await eventStore.safeAppend({
                taskId: task.id as any,
                eventType: 'StoryCompleted',
                agentName: 'developer',
                payload: {
                  storyId: story.id,
                  epicId: (story as any).epicId,
                  title: story.title,
                  completedBy: (story as any).assignedTo,
                  directToJudge: true,
                },
              });

              // 🔥 FIX: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
              await unifiedMemoryService.markStoryCompleted(
                taskId,
                normalizedEpicId,
                normalizedStoryId,
                'approved',
                storyBranch,
                undefined
              );

              await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
                commitHash: commitSHA,
              });

              console.log(`✅ [DIRECT-TO-JUDGE] Story pipeline completed via direct-to-judge!`);

              return {
                developerCost: 0, // Skipped developer
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: mergeResult.conflictResolutionCost,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: mergeResult.conflictResolutionUsage,
              };
            } else {
              // Judge rejected - log feedback
              console.error(`❌ [DIRECT-TO-JUDGE] Judge REJECTED story`);
              console.error(`   Feedback: ${judgeResult.feedback}`);

              // 🔥 FIX: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
              await unifiedMemoryService.markStoryCompleted(
                taskId,
                normalizedEpicId,
                normalizedStoryId,
                'rejected',
                storyBranch,
                undefined
              );

              return {
                developerCost: 0,
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: 0,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
              };
            }
          }
        }
      }

      // 🔥 CHECKPOINT 1: Mark story as "code_generating"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_generating');

      // 🔥🔥🔥 STORY BRANCH: TechLead already created it, Developer just checks out 🔥🔥🔥
      const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      const storyBranchName = story.branchName || unifiedMemoryService.getStoryBranch(taskId, normalizedStoryId);

      if (!storyBranchName) {
        console.error(`\n❌❌❌ [DevelopersPhase] CRITICAL: Story has NO branchName!`);
        console.error(`   Story: ${story.title} (${story.id})`);
        console.error(`   This means TechLead did NOT assign a branch to this story.`);
        console.error(`   🔥 TechLead MUST create story branches when emitting StoryCreated events.`);
        throw new Error(`HUMAN_REQUIRED: Story "${story.title}" has no branchName - TechLead must assign branches`);
      }

      console.log(`\n🌿 [DevelopersPhase] Checking out story branch assigned by TechLead: ${storyBranchName}`);
      console.log(`   Repository: ${repoPath}`);

      try {
        // 🔥 Developer just does: git fetch + git checkout (branch already exists)
        safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.FETCH });

        // Try to checkout the branch
        try {
          safeGitExecSync(`git checkout ${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
          console.log(`✅ [DevelopersPhase] Checked out story branch: ${storyBranchName}`);
        } catch {
          // Branch might not exist locally, try tracking remote
          try {
            safeGitExecSync(`git checkout -b ${storyBranchName} origin/${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [DevelopersPhase] Created local tracking branch: ${storyBranchName}`);
          } catch {
            // Branch doesn't exist on remote either - create from epic branch
            // This is for first developer to work on the story
            console.log(`   ℹ️ Branch not on remote yet, creating from epic branch...`);
            safeGitExecSync(`git checkout ${epicBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            safeGitExecSync(`git checkout -b ${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [DevelopersPhase] Created story branch from epic: ${storyBranchName}`);
          }
        }

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🌿 Developer ${developer.instanceId}: Working on branch ${storyBranchName}`
        );
      } catch (gitError: any) {
        console.error(`❌ [DevelopersPhase] Failed to checkout story branch: ${gitError.message}`);
        throw new Error(`Git checkout failed for ${storyBranchName}: ${gitError.message}`);
      }

      // 🔄 CHECKPOINT: Create rollback point before developer execution
      const { rollbackService } = await import('../RollbackService');
      const checkpoint = await rollbackService.createCheckpoint(
        repoPath,
        (task.id as any).toString(),
        `Before ${developer.instanceId}: ${story.title}`,
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: developer.instanceId,
          storyId: getStoryId(story), // 🔥 CENTRALIZED: Use IdNormalizer
          storyTitle: story.title,
          epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          epicName: epic.name,
        }
      );
      if (checkpoint) {
        console.log(`🔄 [CHECKPOINT] Created: ${checkpoint.id} (${checkpoint.commitHash.substring(0, 7)})`);
      }

      // 🔄 SESSION RESUME: Check for existing session checkpoint for this story
      const existingSessionCheckpoint = await sessionCheckpointService.loadCheckpoint(
        taskId,
        'developer',
        story.id // Use storyId as entityId for per-story resume
      );
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingSessionCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [Developer ${developer.instanceId}] RESUMING story "${story.title}" from previous session...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Developer ${developer.instanceId}: Resuming story "${story.title}" from checkpoint`
        );
      }

      const developerResult = await this.executeDeveloperFn(
        task,
        developer,
        repositories,
        effectiveWorkspacePath,  // 🔥 ISOLATED per story!
        workspaceStructure,
        attachments,
        [story],  // 🔥🔥🔥 CRITICAL: ONLY this story, NOT state.stories (1 Dev = 1 Story)
        state.epics,
        undefined, // judgeFeedback
        epicBranchName, // Epic branch name from TeamOrchestrationPhase
        undefined, // forceTopModel
        devAuth, // 🔐 Developer authentication for testing endpoints
        architectureBrief, // 🏗️ Architecture patterns from PlanningPhase
        environmentCommands, // 🔧 Environment commands from TechLead (dynamic verification)
        projectRadiographies, // 🔬 Language-agnostic project analysis from PlanningPhase
        resumeOptions, // 🔄 Session resume options
        sandboxId // 🐳 Explicit sandbox ID for Docker execution
      );

      // 🔄 Save session checkpoint after developer starts (for mid-execution recovery)
      if (developerResult?.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'developer',
          developerResult.sdkSessionId,
          getStoryId(story), // Use storyId as entityId - 🔥 CENTRALIZED: Use IdNormalizer
          developerResult.lastMessageUuid,
          {
            developerId: developer.instanceId,
            storyTitle: story.title,
            epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          }
        );
      }

      // Track developer cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };
      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)} (${developerTokens.input + developerTokens.output} tokens)`);
        NotificationService.emitConsoleLog(
          (task.id as any).toString(),
          'info',
          `✅ Developer ${developer.instanceId} finished: "${story.title}" ($${developerCost.toFixed(4)})`
        );
      }

      // 🔥 CHECKPOINT 2: Mark story as "code_written" with SDK session for potential resume
      // 🔥 NEW: Save granular tracking for recovery (files modified, created, tools used, cost)
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_written', {
        sdkSessionId: developerResult?.sdkSessionId,
        filesModified: developerResult?.filesModified || [],
        filesCreated: developerResult?.filesCreated || [],
        toolsUsed: developerResult?.toolsUsed || [],
        cost_usd: developerResult?.cost || 0,
      });

      // 🔥 CRITICAL: Wait for git push to fully complete on remote
      // Developer agent may have finished but push still propagating
      console.log(`⏳ [PIPELINE] Waiting 3 seconds for git push to propagate to remote...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(`✅ [PIPELINE] Wait complete - proceeding to verification`);

      // Verify story has branch
      const updatedState = await (await import('../EventStore')).eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      if (!updatedStory || !updatedStory.branchName) {
        console.error(`❌ [PIPELINE] Story ${story.id} has no branch after developer - FAILED`);
        return {
          developerCost: 0,
          judgeCost: 0,
          conflictResolutionCost: 0,
          developerTokens: { input: 0, output: 0 },
          judgeTokens: { input: 0, output: 0 },
          conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
        };
      }

      // 🔥🔥🔥 DEFINITIVE FIX: GIT IS THE SOURCE OF TRUTH, NOT MARKERS 🔥🔥🔥
      // Developer output can be truncated (50k char limit) which cuts off markers
      // Instead: Check git FIRST - if commits exist, ACCEPT the work and FORCE to Judge
      const developerOutput = developerResult?.output || '';

      // Check for explicit failure marker (but DON'T return early - verify git first!)
      const explicitlyFailed = hasMarker(developerOutput, COMMON_MARKERS.FAILED);

      if (explicitlyFailed) {
        console.warn(`⚠️ [PIPELINE] Developer reported FAILURE marker - but will verify git first!`);
        console.warn(`   Story: ${story.title}`);
        // 🔥 FIX: Don't return early! Check git for commits and proceed to Judge if found
      }

      // 🔥🔥🔥 GIT-FIRST VALIDATION: Git commits are the SOURCE OF TRUTH 🔥🔥🔥
      // If developer made commits → they worked, regardless of markers
      // Markers are ONLY a fallback when git verification fails
      const storyBranch = story.branchName || updatedStory?.branchName;
      let commitSHA: string | null = null;
      let gitValidationPassed = false;

      console.log(`\n🔍 [GIT-FIRST VALIDATION] Checking git for actual work...`);
      console.log(`   Story: ${story.title}`);
      console.log(`   Branch: ${storyBranch || 'unknown'}`);

      // 🔥 Use ISOLATED workspace for git verification (where developer actually worked)
      if (storyBranch && effectiveWorkspacePath && epic.targetRepository) {
        // 🔥🔥🔥 CRITICAL: Fetch from remote FIRST to ensure we see all commits
        // Developer may have pushed but local doesn't know about it yet
        const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;

        // 🔥 EXPONENTIAL BACKOFF for git fetch - critical for reliable verification
        const MAX_FETCH_RETRIES = 3;

        for (let fetchAttempt = 1; fetchAttempt <= MAX_FETCH_RETRIES; fetchAttempt++) {
          try {
            console.log(`   📡 Fetching from remote (attempt ${fetchAttempt}/${MAX_FETCH_RETRIES})...`);
            safeGitExecSync(`git fetch origin --prune`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: GIT_TIMEOUTS.FETCH
            });
            console.log(`   ✅ Fetch succeeded on attempt ${fetchAttempt}`);
            break;
          } catch (fetchErr: any) {
            const waitMs = 2000 * Math.pow(2, fetchAttempt - 1); // 2s, 4s, 8s
            if (fetchAttempt < MAX_FETCH_RETRIES) {
              console.warn(`   ⚠️ Fetch attempt ${fetchAttempt} failed: ${fetchErr.message}`);
              console.warn(`   ⏳ Waiting ${waitMs / 1000}s before retry...`);
              await new Promise(resolve => setTimeout(resolve, waitMs));
            } else {
              console.error(`   ❌ Fetch FAILED after ${MAX_FETCH_RETRIES} attempts: ${fetchErr.message}`);
              console.error(`   ⚠️ Proceeding with local state - verification may be incomplete!`);
            }
          }
        }

        const gitVerification = await this.verifyDeveloperWorkFromGit(
          effectiveWorkspacePath,  // 🔥 ISOLATED workspace where dev worked
          epic.targetRepository,
          storyBranch,
          story.id
        );

        if (gitVerification?.hasCommits && gitVerification.commitSHA) {
          console.log(`✅ [GIT-FIRST] Developer made ${gitVerification.commitCount} commits!`);
          console.log(`   Latest commit: ${gitVerification.commitSHA.substring(0, 8)}`);
          console.log(`   Message: ${gitVerification.commitMessage || 'N/A'}`);
          console.log(`   🎯 GIT VALIDATION PASSED - Developer DID work (markers ignored)`);

          commitSHA = gitVerification.commitSHA;
          gitValidationPassed = true;

          // 🔥🔥🔥 FIX: FORCE TO JUDGE even if developer reported FAILED marker 🔥🔥🔥
          // Commits exist = work was done, let Judge evaluate it
          if (explicitlyFailed) {
            console.log(`\n🚀🚀🚀 [FORCE-JUDGE] Developer reported FAILED but commits EXIST! 🚀🚀🚀`);
            console.log(`   Overriding FAILED marker - git commits prove work was done`);
            console.log(`   Proceeding to JUDGE for evaluation (not aborting pipeline)`);
          }

          // 🔥🔥🔥 FORCE PUSH VERIFICATION: Ensure commit is on remote 🔥🔥🔥
          // Developer MUST push their work - this is mandatory, not optional
          console.log(`\n📤 [FORCE PUSH CHECK] Verifying commit ${commitSHA.substring(0, 8)} is on remote...`);
          try {
            const branchOnRemote = safeGitExecSync(
              `git ls-remote origin refs/heads/${storyBranch}`,
              { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
            );

            if (!branchOnRemote || branchOnRemote.trim() === '') {
              // Branch not on remote - FORCE PUSH IT
              console.log(`   ⚠️ Branch ${storyBranch} NOT on remote - pushing now...`);
              safeGitExecSync(`git push -u origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
              console.log(`   ✅ Branch pushed to remote`);
              // FIX: Sync local with remote after push
              try {
                safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
                console.log(`   ✅ Local synced with remote`);
              } catch (_pullErr) {
                console.log(`   ℹ️ Pull skipped (already up to date)`);
              }
            } else {
              // Branch on remote - verify commit is there
              const remoteCommit = branchOnRemote.split('\t')[0];
              if (remoteCommit === commitSHA) {
                console.log(`   ✅ Commit ${commitSHA.substring(0, 8)} confirmed on remote`);
              } else {
                console.log(`   ⚠️ Remote has different commit (${remoteCommit.substring(0, 8)}) - pushing latest...`);
                safeGitExecSync(`git push origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
                console.log(`   ✅ Latest commit pushed to remote`);
                // FIX: Sync local with remote after push
                try {
                  safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
                  console.log(`   ✅ Local synced with remote`);
                } catch (_pullErr) {
                  console.log(`   ℹ️ Pull skipped (already up to date)`);
                }
              }
            }
          } catch (pushCheckErr: any) {
            console.warn(`   ⚠️ Push verification failed: ${pushCheckErr.message}`);
            console.warn(`   Attempting force push...`);
            try {
              safeGitExecSync(`git push -u origin ${storyBranch} --force-with-lease`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
              console.log(`   ✅ Force push succeeded`);
              // FIX: Sync local with remote after force push
              try {
                safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
                console.log(`   ✅ Local synced with remote`);
              } catch (_pullErr) {
                console.log(`   ℹ️ Pull skipped (already up to date)`);
              }
            } catch (forcePushErr: any) {
              console.error(`   ❌ Force push failed: ${forcePushErr.message}`);
              // Continue anyway - Judge will try to fetch
            }
          }

          // 🔥 CHECKPOINT 3: Mark story as "committed" and "pushed" with commit hash
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'pushed', {
            commitHash: commitSHA,
          });
          console.log(`📍 [CHECKPOINT] Story progress saved: pushed (commit: ${commitSHA.substring(0, 8)})`);

          // 🔥 CRITICAL: Verify push on GitHub and emit StoryPushVerified event
          // This ensures Local state matches GitHub reality
          try {
            const { eventStore } = await import('../EventStore');
            await eventStore.verifyStoryPush({
              taskId: task.id as any,
              storyId: story.id,
              branchName: storyBranch,
              repoPath,
            });
          } catch (verifyErr: any) {
            console.warn(`⚠️ [PushVerify] Could not verify push: ${verifyErr.message}`);
            // Non-blocking - verification is for tracking, not blocking the flow
          }
        } else {
          console.warn(`⚠️ [GIT-FIRST] No commits found on branch ${storyBranch}`);

          // 🔥 AUTO-COMMIT: Try to recover developer's work if they forgot to commit
          console.log(`🔧 [AUTO-COMMIT] Checking for uncommitted changes...`);
          const { autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
          const autoCommitResult = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

          if (autoCommitResult.success && autoCommitResult.commitSHA) {
            console.log(`✅ [AUTO-COMMIT] Recovered developer work!`);
            console.log(`   Commit SHA: ${autoCommitResult.commitSHA.substring(0, 8)}`);
            console.log(`   Action: ${autoCommitResult.action}`);
            commitSHA = autoCommitResult.commitSHA;
            gitValidationPassed = true;
          } else {
            console.warn(`   ${autoCommitResult.message}`);
            console.warn(`   Falling back to marker validation...`);
          }
        }
      } else {
        console.warn(`⚠️ [GIT-FIRST] Cannot verify git (missing branch/workspace/repo)`);
        console.warn(`   storyBranch: ${storyBranch || 'missing'}`);
        console.warn(`   effectiveWorkspacePath: ${effectiveWorkspacePath || 'missing'}`);
        console.warn(`   targetRepository: ${epic.targetRepository || 'missing'}`);
        console.warn(`   Falling back to marker validation...`);
      }

      // 🔥 FALLBACK: Only check markers if git validation failed
      // This handles edge cases where git check doesn't work
      const requiredMarkers = {
        typecheckPassed: hasMarker(developerOutput, COMMON_MARKERS.TYPECHECK_PASSED),
        testsPassed: hasMarker(developerOutput, COMMON_MARKERS.TESTS_PASSED),
        lintPassed: hasMarker(developerOutput, COMMON_MARKERS.LINT_PASSED),
        finishedSuccessfully: hasMarker(developerOutput, COMMON_MARKERS.DEVELOPER_FINISHED) ||
                               hasMarker(developerOutput, COMMON_MARKERS.FINISHED),
        failed: false, // Already checked above
      };

      // 🔥🔥🔥 SIMPLIFIED VALIDATION LOGIC 🔥🔥🔥
      // Git validation already happened above. If gitValidationPassed is true, we're good!
      // Only fail if git shows NO commits AND no success markers

      if (!gitValidationPassed) {
        // Git validation failed - check markers as fallback
        console.log(`\n🔍 [MARKER FALLBACK] Git validation failed, checking markers...`);
        console.log(`   ✅ TYPECHECK_PASSED: ${requiredMarkers.typecheckPassed ? '✅' : '⚠️'}`);
        console.log(`   ✅ TESTS_PASSED: ${requiredMarkers.testsPassed ? '✅' : '⚠️'}`);
        console.log(`   ✅ LINT_PASSED: ${requiredMarkers.lintPassed ? '✅' : '⚠️'}`);
        console.log(`   ✅ DEVELOPER_FINISHED_SUCCESSFULLY: ${requiredMarkers.finishedSuccessfully ? '✅' : '❌'}`);

        // Only require the finish marker - let Judge decide code quality
        if (!requiredMarkers.finishedSuccessfully) {
          // 🔥🔥🔥 LAST RESORT: Check if output shows work was done despite no marker 🔥🔥🔥
          // Use heuristics to detect uncommitted work in developer output
          const { detectUncommittedWork } = await import('./utils/GitCommitHelper');
          const outputShowsWork = detectUncommittedWork(developerOutput);

          if (outputShowsWork) {
            console.warn(`\n⚠️ [HEURISTIC DETECTION] Developer output shows work was done!`);
            console.warn(`   Story: ${story.title}`);
            console.warn(`   No commits AND no FINISHED marker, BUT output contains:`);
            console.warn(`   - Edit/Write tool calls (code changes)`);
            console.warn(`   🚀 FORCING TO JUDGE - Let Judge evaluate the workspace files directly`);

            // 🔥 Try one more aggressive auto-commit
            console.log(`\n🔧 [AGGRESSIVE RECOVERY] Attempting to recover any workspace files...`);
            const { autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
            const aggressiveCommit = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

            if (aggressiveCommit.success && aggressiveCommit.commitSHA) {
              console.log(`✅ [AGGRESSIVE RECOVERY] Recovered work!`);
              commitSHA = aggressiveCommit.commitSHA;
              gitValidationPassed = true;
            } else {
              console.warn(`⚠️ [AGGRESSIVE RECOVERY] No files to commit - but proceeding to Judge anyway`);
              // 🔥 Create a "checkpoint" commit so Judge has SOMETHING to review
              // Even if empty, this ensures the pipeline continues
              try {
                const checkpointSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, { encoding: 'utf8' }).trim();
                if (checkpointSHA) {
                  console.log(`   Using current HEAD as checkpoint: ${checkpointSHA.substring(0, 8)}`);
                  commitSHA = checkpointSHA;
                  gitValidationPassed = true;
                }
              } catch (e) {
                console.error(`   Could not get HEAD SHA: ${e}`);
              }
            }
          } else {
            // 🔥 Output doesn't show work either - truly failed
            console.error(`\n❌ [PIPELINE] Developer did NOT complete work!`);
            console.error(`   Story: ${story.title}`);
            console.error(`   NO commits found on git AND no FINISHED marker in output`);
            console.error(`   Heuristic check: output does NOT show Edit/Write tool usage`);
            console.error(`\n   Developer must either:`);
            console.error(`   1. Make commits (git commit + git push) - detected automatically`);
            console.error(`   2. Output ✅ DEVELOPER_FINISHED_SUCCESSFULLY marker`);
            console.error(`\n   Developer output (last 1500 chars):\n${developerOutput.slice(-1500)}`);
            return {
              developerCost,
              judgeCost: 0,
              conflictResolutionCost: 0,
              developerTokens,
              judgeTokens: { input: 0, output: 0 },
              conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
            };
          }
        }

        // Marker validation passed - try to get commit SHA from output
        commitSHA = extractMarkerValue(developerOutput, COMMON_MARKERS.COMMIT_SHA);
        console.log(`✅ [MARKER FALLBACK] Developer finished (marker present)`);
      }

      // Final validation - we need a commit SHA to proceed
      if (!commitSHA) {
        console.error(`\n❌❌❌ [PIPELINE] CRITICAL: Could not determine commit SHA!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Git validation: ${gitValidationPassed ? 'PASSED but no SHA?' : 'FAILED'}`);
        console.error(`   Without a commit SHA, Judge cannot review the code`);
        return {
          developerCost,
          judgeCost: 0,
          conflictResolutionCost: 0,
          developerTokens,
          judgeTokens: { input: 0, output: 0 },
          conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
        };
      }

      console.log(`✅ [PIPELINE] Developer work validated!`);
      console.log(`   Commit SHA: ${commitSHA}`);
      console.log(`   Story: ${story.title}`);
      console.log(`   Branch: ${storyBranch || 'unknown'}`);
      console.log(`   Validation: ${gitValidationPassed ? 'GIT (commits found)' : 'MARKER (finished marker)'}`)

      // 🔧🔧🔧 AUTOMATIC BUILD VERIFICATION (Commercial-Grade) 🔧🔧🔧
      // This is what makes us competitive with Devin/Claude Code:
      // We ENFORCE verification at the orchestration level, not just trust agent output
      console.log(`\n🔧 [BUILD VERIFICATION] Automatically verifying code quality...`);
      console.log(`   This runs INDEPENDENTLY of what developer claimed`);
      console.log(`   Trust but verify: enforcing typecheck/test/lint at orchestration level`);

      const { BuildVerificationService } = await import('../BuildVerificationService');
      const verificationRepoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;

      const verificationReport = await BuildVerificationService.verifyBuild(
        verificationRepoPath,
        taskId
      );

      if (!verificationReport.overall) {
        console.error(`\n❌❌❌ [BUILD VERIFICATION] FAILED!`);
        console.error(`   Total errors: ${verificationReport.totalErrors}`);
        console.error(`   Summary:\n${verificationReport.summary}`);

        // 🔥 CRITICAL: Don't proceed to Judge if code doesn't compile/pass tests
        // This saves Judge cost and provides immediate feedback
        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Build verification failed for story "${story.title}": ${verificationReport.totalErrors} errors`
        );

        // 🔄 TODO: In future, could trigger automatic retry with feedback
        // For now, log detailed feedback for debugging
        console.error(`\n📋 FEEDBACK FOR DEVELOPER:\n${verificationReport.feedbackForAgent}`);

        // Store verification failure in context for potential retry logic
        context.setData('lastVerificationFailure', {
          storyId: story.id,
          errors: verificationReport.totalErrors,
          feedback: verificationReport.feedbackForAgent,
          timestamp: new Date(),
        });

        // Continue anyway for now - Judge will also catch issues
        // But log prominently that we detected problems early
        console.warn(`\n⚠️ [BUILD VERIFICATION] Proceeding to Judge despite failures`);
        console.warn(`   Judge may catch additional issues or reject the code`);
      } else {
        console.log(`✅ [BUILD VERIFICATION] All checks passed!`);
        console.log(`   - Typecheck: ✅`);
        console.log(`   - Tests: ✅`);
        console.log(`   - Lint: ✅ (or N/A)`);

        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Build verification passed for story "${story.title}"`
        );
      }
      // 🔧🔧🔧 END BUILD VERIFICATION 🔧🔧🔧

      // 🔥 CRITICAL: Verify commit exists on remote BEFORE Judge evaluation
      console.log(`\n🔍 [PRE-JUDGE] Verifying commit ${commitSHA} exists on remote...`);
      if (effectiveWorkspacePath && repositories.length > 0) {
        // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
        if (!epic.targetRepository) {
          throw new Error(`Epic ${epic.id} has no targetRepository - cannot verify commit`);
        }

        const targetRepo = repositories.find(r =>
          r.name === epic.targetRepository ||
          r.full_name === epic.targetRepository ||
          r.githubRepoName === epic.targetRepository
        );

        if (!targetRepo) {
          throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
        }

        // 🔥 ISOLATED workspace path for git operations
        const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;

        try {
          // Check if commit exists on remote by grepping ls-remote output
          // NOTE: `git ls-remote origin <SHA>` does NOT work - it only matches refs, not commits
          // We must use `git ls-remote origin | grep <SHA>` to find commits in branch history
          const lsRemote = safeGitExecSync(
            `git ls-remote origin`,
            { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
          );

          // Search for commit SHA in ls-remote output
          const commitFound = lsRemote.includes(commitSHA);

          if (!commitFound) {
            console.error(`❌ [PRE-JUDGE] Commit ${commitSHA} NOT found on remote!`);
            console.error(`   Story: ${story.title}`);
            console.error(`   Story ID: ${story.id}`);
            console.error(`   Branch: ${story.branchName || updatedStory?.branchName || 'unknown'}`);
            console.error(`   Repository: ${epic.targetRepository}`);
            console.error(`   This means Developer did NOT push commits successfully`);
            console.error(`   Judge CANNOT evaluate non-existent commit - STOPPING`);
            console.error(`\n   📋 Remote refs found:\n${lsRemote}`);
            return {
              developerCost,
              judgeCost: 0,
              conflictResolutionCost: 0,
              developerTokens,
              judgeTokens: { input: 0, output: 0 },
              conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
            };
          }

          console.log(`✅ [PRE-JUDGE] Commit ${commitSHA} verified on remote`);
        } catch (verifyError: any) {
          console.warn(`⚠️  [PRE-JUDGE] Could not verify commit on remote: ${verifyError.message}`);
          console.warn(`   Proceeding anyway, but Judge may fail...`);
        }
      }

      // STEP 2: Judge reviews code (in SAME ISOLATED workspace, SAME branch, EXACT commit)
      console.log(`\n⚖️  [STEP 2/3] Judge reviewing EXACT commit:`);
      console.log(`   Commit SHA: ${commitSHA}`);
      console.log(`   Branch: ${updatedStory.branchName}`);
      console.log(`   🔒 ISOLATED Workspace: ${effectiveWorkspacePath}`);  // 🔥 Same isolated workspace as Developer
      console.log(`   If Judge fails to access this commit → Pipeline STOPS`);

      // 🔥 CRITICAL: Sync ISOLATED workspace with remote BEFORE Judge reviews
      // Developer pushed changes to remote, Judge needs to pull them
      if (effectiveWorkspacePath && repositories.length > 0) {
        try {
          console.log(`\n🔄 [PRE-JUDGE SYNC] Syncing workspace with remote...`);

          // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
          if (!epic.targetRepository) {
            throw new Error(`Epic ${epic.id} has no targetRepository - cannot sync workspace`);
          }

          const targetRepo = repositories.find(r =>
            r.name === epic.targetRepository ||
            r.full_name === epic.targetRepository ||
            r.githubRepoName === epic.targetRepository
          );

          if (!targetRepo) {
            throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
          }

          // 🔥 ISOLATED workspace path for Judge sync
          const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;

          // Fetch all branches from remote (uses cache to avoid redundant fetches)
          console.log(`   [1/3] Fetching from remote...`);
          smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });
          console.log(`   ✅ Fetched latest refs from remote`);

          // 🔥 NEW: Verify branch exists on remote BEFORE attempting checkout
          console.log(`\n🔍 [PRE-CHECKOUT] Verifying branch exists on remote...`);
          console.log(`   Branch: ${updatedStory.branchName}`);
          console.log(`   This is the EXACT branch Developer worked on`);

          const lsRemoteBranches = safeGitExecSync(
            `git ls-remote --heads origin ${updatedStory.branchName}`,
            { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
          );

          if (!lsRemoteBranches || lsRemoteBranches.trim().length === 0) {
            console.error(`\n❌ [PRE-CHECKOUT] Branch ${updatedStory.branchName} does NOT exist on remote!`);
            console.error(`   This means Developer did NOT push the branch successfully`);
            console.error(`   Judge CANNOT review non-existent branch - STOPPING`);
            console.error(`\n   📋 Try running: git ls-remote --heads origin`);
            throw new Error(`Branch ${updatedStory.branchName} not found on remote - Developer push failed`);
          }

          console.log(`✅ [PRE-CHECKOUT] Branch verified on remote:`);
          console.log(`   ${lsRemoteBranches.trim()}`);

          // Checkout the story branch WITH RETRY
          console.log(`\n   [2/3] Checking out story branch: ${updatedStory.branchName}`);
          let checkoutSuccess = false;
          const maxCheckoutRetries = 3;

          // 🔥 CRITICAL FIX: Validate branchName exists BEFORE any git operations
          if (!updatedStory.branchName) {
            console.error(`\n❌❌❌ [PRE-JUDGE SYNC] CRITICAL ERROR: Story has NO branchName!`);
            console.error(`   Story: ${story.title}`);
            console.error(`   Story ID: ${story.id}`);
            console.error(`\n   💀 CANNOT CHECKOUT BRANCH - branchName is undefined/null`);
            console.error(`   💀 Git command would be invalid: git checkout undefined`);
            console.error(`\n   🛑 STOPPING SYNC - HUMAN INTERVENTION REQUIRED`);
            throw new Error(`HUMAN_REQUIRED: Story ${story.id} has no branchName - cannot checkout branch for Judge review`);
          }

          console.log(`✅ [PRE-JUDGE SYNC] Validated branchName: ${updatedStory.branchName}`);

          for (let retryAttempt = 0; retryAttempt < maxCheckoutRetries; retryAttempt++) {
            try {
              // 🔥 FIX: Clean working directory BEFORE checkout to avoid conflicts
              try {
                const statusCheck = safeGitExecSync(`git status --porcelain`, { cwd: repoPath, encoding: 'utf8' });
                if (statusCheck.trim().length > 0) {
                  console.log(`   ⚠️  Detected uncommitted changes, cleaning workspace...`);
                  // Stash any changes (safer than hard reset)
                  try {
                    safeGitExecSync(`git stash push -u -m "Auto-stash before checkout (retry ${retryAttempt + 1})"`, {
                      cwd: repoPath,
                      encoding: 'utf8'
                    });
                    console.log(`   ✅ Stashed uncommitted changes`);
                  } catch (stashError: any) {
                    // If stash fails, force clean with reset + clean
                    console.warn(`   ⚠️  Stash failed, forcing clean: ${stashError.message}`);
                    safeGitExecSync(`git reset --hard HEAD`, { cwd: repoPath, encoding: 'utf8' });
                    safeGitExecSync(`git clean -fd`, { cwd: repoPath, encoding: 'utf8' });
                    console.log(`   ✅ Force cleaned workspace`);
                  }
                }
              } catch (cleanError: any) {
                console.warn(`   ⚠️  Could not clean workspace: ${cleanError.message}`);
              }

              // 🔥 FIX: Check if branch exists LOCALLY before trying to create
              let branchExistsLocally = false;
              try {
                safeGitExecSync(`git show-ref --verify --quiet refs/heads/${updatedStory.branchName}`, {
                  cwd: repoPath,
                  encoding: 'utf8'
                });
                branchExistsLocally = true;
                console.log(`   ℹ️  Branch exists locally, will checkout existing branch`);
              } catch (e) {
                console.log(`   ℹ️  Branch does NOT exist locally, will create from remote`);
              }

              if (branchExistsLocally) {
                // Branch exists locally - just checkout
                safeGitExecSync(`git checkout ${updatedStory.branchName}`, { cwd: repoPath, encoding: 'utf8' });
                console.log(`   ✅ Checked out existing local branch (attempt ${retryAttempt + 1}/${maxCheckoutRetries})`);
              } else {
                // Branch does NOT exist locally - create from remote
                safeGitExecSync(`git checkout -b ${updatedStory.branchName} origin/${updatedStory.branchName}`, {
                  cwd: repoPath,
                  encoding: 'utf8'
                });
                console.log(`   ✅ Created and checked out branch from remote (attempt ${retryAttempt + 1}/${maxCheckoutRetries})`);
              }

              checkoutSuccess = true;
              break;
            } catch (checkoutError: any) {
              console.error(`   ❌ Checkout failed (attempt ${retryAttempt + 1}/${maxCheckoutRetries}): ${checkoutError.message}`);

              if (retryAttempt < maxCheckoutRetries - 1) {
                const delay = 2000 * (retryAttempt + 1); // 2s, 4s, 6s
                console.log(`   ⏳ Waiting ${delay}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                // Re-fetch to get latest refs (force fetch on retry to ensure fresh data)
                smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH, force: true });
              }
            }
          }

          if (!checkoutSuccess) {
            console.error(`❌ [PRE-JUDGE SYNC] Failed to checkout branch after ${maxCheckoutRetries} attempts`);
            console.error(`   Branch: ${updatedStory.branchName}`);
            console.error(`   This means branch does NOT exist on remote - Developer failed to push`);
            throw new Error(`Branch ${updatedStory.branchName} not found after ${maxCheckoutRetries} retries`);
          }

          // 🔥 FIX: Use reset instead of pull to avoid rebase conflicts
          // NOTE: No additional fetch needed - we already fetched ALL refs at [1/3]
          console.log(`   [3/3] Resetting to remote HEAD...`);
          try {
            // Reset to remote branch (avoids merge/rebase conflicts)
            // This ensures we're at origin/branch even if local branch was outdated
            safeGitExecSync(`git reset --hard origin/${updatedStory.branchName}`, {
              cwd: repoPath,
              encoding: 'utf8'
            });
            console.log(`   ✅ Synced with remote (hard reset)`);

            // Verify we're on the correct commit
            const currentSHA = safeGitExecSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
            console.log(`\n🔍 [VERIFICATION] Commit sync status:`);
            console.log(`   Expected SHA: ${commitSHA}`);
            console.log(`   Current SHA:  ${currentSHA}`);
            console.log(`   Match: ${currentSHA === commitSHA ? '✅ YES' : '⚠️  NO (different commits)'}`);

            if (currentSHA !== commitSHA) {
              console.warn(`\n⚠️  WARNING: Workspace is on different commit!`);
              console.warn(`   This means Judge will review DIFFERENT code than Developer wrote`);
              console.warn(`   Expected: ${commitSHA}`);
              console.warn(`   Current:  ${currentSHA}`);
              console.warn(`   Proceeding with current commit (${currentSHA})...`);
              // Update commitSHA to match reality
              commitSHA = currentSHA;
            } else {
              console.log(`✅ [SYNC COMPLETE] Judge will review the exact commit Developer created`);
            }
          } catch (syncError: any) {
            console.error(`❌ [SYNC ERROR] Failed to sync workspace: ${syncError.message}`);
            console.error(`   Judge CANNOT review without proper sync - STOPPING`);
            console.error(`   This is a CRITICAL failure - branch or commit not accessible`);

            // 🔥 FAIL HARD: Don't let Judge review if sync fails
            return {
              developerCost,
              judgeCost: 0,
              conflictResolutionCost: 0,
              developerTokens,
              judgeTokens: { input: 0, output: 0 },
              conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
            };
          }
        } catch (outerSyncError: any) {
          console.error(`❌ [PRE-JUDGE SYNC] Failed to sync workspace with remote: ${outerSyncError.message}`);
          console.error(`   Judge CANNOT review without proper workspace sync`);
          // Continue without failing - Judge might still be able to work
        }
      }

      // Create isolated context for Judge - SAME ISOLATED WORKSPACE as Developer
      // 🔥🔥🔥 CRITICAL: Judge uses SAME isolated workspace as Developer 🔥🔥🔥
      const judgeContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
      judgeContext.setData('storyToReview', updatedStory);
      judgeContext.setData('reviewMode', 'single-story');
      judgeContext.setData('developmentTeam', [developer]); // Only this developer
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);
      judgeContext.setData('commitSHA', commitSHA); // 🔥 CRITICAL: Exact commit to review
      judgeContext.setData('storyBranchName', updatedStory.branchName); // 🔥 CRITICAL: LITERAL branch name from Developer
      judgeContext.setData('isolatedWorkspacePath', effectiveWorkspacePath); // 🔥 Pass isolated path explicitly

      // 🔥 CHECKPOINT 4: Mark story as "judge_evaluating" before Judge starts
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'judge_evaluating', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress saved: judge_evaluating`);

      // ⚖️ JUDGE: AI validates the actual code changes
      console.log(`\n⚖️ [STEP 2/3] Running Judge validation...`);

      const { JudgePhase } = await import('./JudgePhase');

      // Use executeAgentFn for Judge (NOT executeDeveloperFn)
      if (!this.executeAgentFn) {
        throw new Error('executeAgentFn is required for Judge evaluation');
      }

      const judgePhase = new JudgePhase(this.executeAgentFn);
      const judgeResult = await judgePhase.execute(judgeContext);

      // Track judge cost and tokens
      const judgeCost = judgeResult.metadata?.cost || 0;
      const judgeTokens = {
        input: Number(judgeResult.metadata?.input_tokens || judgeResult.metrics?.input_tokens || 0),
        output: Number(judgeResult.metadata?.output_tokens || judgeResult.metrics?.output_tokens || 0),
      };
      if (judgeCost > 0) {
        console.log(`💰 [Judge] Cost: $${judgeCost.toFixed(4)} (${judgeTokens.input + judgeTokens.output} tokens)`);
      }

      // 🔥 DEBUG: Log judge result structure to identify merge blocking issue
      console.log(`\n🔍 [DEBUG] Judge result structure:`);
      console.log(`   judgeResult.success: ${judgeResult.success}`);
      console.log(`   judgeResult.data: ${JSON.stringify(judgeResult.data)}`);
      console.log(`   judgeResult.data?.status: ${judgeResult.data?.status}`);
      console.log(`   Checking if: judgeResult.success (${judgeResult.success}) && judgeResult.data?.status ('${judgeResult.data?.status}') === 'approved'`);

      // 🔥 FIX: Judge returns status in data object from JudgePhase:189-192
      const judgeStatus = judgeResult.data?.status;
      const isApproved = judgeResult.success && judgeStatus === 'approved';

      console.log(`✅ [VERDICT] Judge decision: ${isApproved ? 'APPROVED ✅' : 'REJECTED ❌'}`);

      // Get iteration info for rejection messages
      const iteration = judgeResult.data?.iteration || 1;
      const maxRetries = judgeResult.data?.maxRetries || 3;

      if (isApproved) {
        console.log(`✅ [STEP 2/3] Judge APPROVED story: ${story.title}`);

        // STEP 3: Merge to epic branch (from ISOLATED workspace)
        console.log(`\n🔀 [STEP 3/3] Merging approved story to epic branch...`);
        await this.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, pipelineSandboxId);

        // 🔥 CHECKPOINT 5: Mark story as "merged_to_epic" after successful merge
        await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
          commitHash: commitSHA,
        });
        console.log(`📍 [CHECKPOINT] Story progress saved: merged_to_epic`);

        // 🧹 CLEANUP: Delete story branch after successful merge
        // ✅ ONLY if Judge APPROVED - rejected stories keep their branches for investigation
        // Story is now part of epic branch, no need to keep individual story branch
        if (effectiveWorkspacePath && repositories.length > 0) {
          try {
            // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
            if (!epic.targetRepository) {
              throw new Error(`Epic ${epic.id} has no targetRepository - cannot cleanup story branch`);
            }

            const targetRepo = repositories.find(r =>
              r.name === epic.targetRepository ||
              r.full_name === epic.targetRepository ||
              r.githubRepoName === epic.targetRepository
            );

            if (!targetRepo) {
              throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
            }

            // 🔥 ISOLATED workspace for cleanup operations
            const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;
            const storyBranch = updatedStory.branchName;

            // 🗑️ Delete LOCAL branch
            safeGitExecSync(`cd "${repoPath}" && git branch -D ${storyBranch}`, { encoding: 'utf8' });
            console.log(`🧹 Cleaned up LOCAL story branch: ${storyBranch}`);

            // 🗑️ Delete REMOTE branch (GitHub) to prevent clutter
            try {
              safeGitExecSync(`cd "${repoPath}" && git push origin --delete ${storyBranch}`, {
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.CLONE // 2 minutes for remote delete (network operation)
              });
              console.log(`🧹 Cleaned up REMOTE story branch: ${storyBranch} (GitHub)`);
            } catch (remoteDeleteError: any) {
              console.warn(`⚠️  Could not delete remote branch ${storyBranch}: ${remoteDeleteError.message}`);
              // Non-critical - branch might not exist on remote or already deleted
            }
          } catch (cleanupError: any) {
            // Non-critical error - branch might not exist or already deleted
            console.warn(`⚠️  Could not cleanup story branch: ${cleanupError.message}`);
          }
        }

        console.log(`✅ [PIPELINE] Story pipeline completed successfully: ${story.title}`);

        // 🔥 HOT RESTART: Rebuild and restart dev server after story completion
        // For Flutter: rebuild web assets then restart http server
        // For Node.js: just restart the process
        try {
          const sandboxConfig = context.getData<any>('sandboxConfig');
          const environmentConfig = context.getData<any>('environmentConfig');
          if (sandboxConfig && pipelineSandboxId && epic.targetRepository) {
            // 🔥 FIX: Get devCmd from environmentConfig (per-repo) or sandboxConfig.commands.dev (global)
            const envRepoConfig = environmentConfig?.[epic.targetRepository];
            const devCmd = envRepoConfig?.runCommand || sandboxConfig.commands?.dev;
            // 🔥 100% AGNOSTIC: Use containerWorkDir from SandboxPhase (SINGLE SOURCE OF TRUTH)
            const containerWorkDir = sandboxConfig.containerWorkDir || '/workspace';
            const repoDir = `${containerWorkDir}/${epic.targetRepository}`;

            if (devCmd) {
              console.log(`\n🔄 [HOT RESTART] Rebuilding and restarting for ${epic.targetRepository}...`);
              NotificationService.emitConsoleLog(taskId, 'info', `🔄 Rebuilding and restarting preview...`);

              // Kill existing server process (python http.server, flutter, node, etc.)
              const killCmd = `pkill -f "http.server" 2>/dev/null || pkill -f "flutter" 2>/dev/null || pkill -f "${epic.targetRepository}" 2>/dev/null || true`;
              await sandboxService.exec(pipelineSandboxId, killCmd, { cwd: repoDir, timeout: 10000 });

              // Wait for process to die
              await new Promise(resolve => setTimeout(resolve, 1000));

              // 🔥 AGNOSTIC: If Flutter/Dart, rebuild before serving
              // devCmd already contains "flutter build web && python3 -m http.server..."
              // Just run it again to rebuild and serve
              const logFile = `/tmp/${epic.targetRepository}-server.log`;
              const startCmd = `setsid bash -c 'cd ${repoDir} && ${devCmd}' > ${logFile} 2>&1 &`;

              console.log(`   📦 Running: ${devCmd.substring(0, 80)}...`);
              await sandboxService.exec(pipelineSandboxId, startCmd, { cwd: repoDir, timeout: 300000 }); // 5 min for rebuild

              console.log(`   ✅ Rebuild complete - preview shows latest code`);
              NotificationService.emitConsoleLog(taskId, 'info', `✅ Preview rebuilt with latest code!`);
            }
          }
        } catch (hotRestartError: any) {
          console.warn(`⚠️  [HOT RESTART] Could not rebuild/restart: ${hotRestartError.message}`);
          // Non-critical - preview might show stale code but development continues
        }

        // 🔄 GRANULAR RECOVERY: Persist story completion via EventStore
        // EventStore is the source of truth for story completion
        try {
          const taskId = (task.id as any).toString();

          // Update story status in-memory
          story.status = 'completed';
          (story as any).mergedToEpic = true;
          (story as any).completedAt = new Date();

          // 🔥 EVENT SOURCING: Emit StoryCompleted event for recovery tracking
          // This is CRITICAL - EventStore.buildState() uses this to mark stories as completed
          const { eventStore } = await import('../EventStore');
          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryCompleted',
            agentName: 'developer',
            payload: {
              storyId: story.id,
              epicId: (story as any).epicId,
              title: story.title,
              completedBy: (story as any).assignedTo,
            },
          });
          console.log(`📝 [EventStore] Emitted StoryCompleted for: ${story.title}`);

          // 🔥 CRITICAL FIX: Mark story as completed in Unified Memory for recovery tracking
          // This was missing! Without this, getResumptionPoint() returns completedStories: 0
          // 🔥 FIX #2: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
          await unifiedMemoryService.markStoryCompleted(
            taskId,
            normalizedEpicId,
            normalizedStoryId,
            'approved',
            updatedStory.branchName,
            undefined // PR URL not available yet
          );
          console.log(`✅ [UnifiedMemory] Marked story "${story.title}" as completed (epicId=${normalizedEpicId}, storyId=${normalizedStoryId})`);

          // 🔥 CHECKPOINT 6 (FINAL): Mark story progress as "completed"
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
            commitHash: commitSHA,
          });
          console.log(`📍 [CHECKPOINT] Story progress saved: completed ✅`);

          // 🔄 Mark session checkpoint as completed (no resume needed for this story)
          await sessionCheckpointService.markCompleted(taskId, 'developer', story.id);

          // 🔥 REMOVED: granularMemoryService calls - SQLite tracks files via unifiedMemoryService.saveStoryProgress

          // Emit activity for visibility
          const { AgentActivityService } = await import('../AgentActivityService');
          AgentActivityService.emitMessage(
            taskId,
            'System',
            `💾 Story checkpoint saved: "${story.title}" marked as completed`
          );
        } catch (persistError: any) {
          console.error(`⚠️ [RECOVERY] Failed to persist story status: ${persistError.message}`);
          // Non-critical - don't fail the pipeline, just log warning
        }
      } else {
        // Judge REJECTED - check if specialist can help before giving up
        console.error(`❌ [STEP ${iteration}/${maxRetries}] Judge REJECTED story: ${story.title}`);
        console.error(`   Feedback: ${judgeResult.data?.feedback || judgeResult.error}`);

        // 🔥 SPECIALIST ROUTING: Check if rejection can be handled by a specialist
        const rejectReason = judgeResult.data?.rejectReason;
        console.log(`📋 [SPECIALIST ROUTING] Rejection reason: ${rejectReason || 'unknown'}`);

        // 🔧 CONFLICTS: Route to ConflictResolver specialist
        if (rejectReason === 'conflicts') {
          console.log(`\n🔧 [SPECIALIST] Routing to ConflictResolver for merge conflict resolution...`);
          try {
            // Import and call ConflictResolverPhase
            const { ConflictResolverPhase } = await import('./ConflictResolverPhase');
            const conflictResolver = new ConflictResolverPhase(this.executeAgentFn);

            // Create context for conflict resolution
            const conflictContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
            conflictContext.setData('story', updatedStory);
            conflictContext.setData('epic', epic);
            conflictContext.setData('storyBranchName', updatedStory.branchName);
            conflictContext.setData('commitSHA', commitSHA);
            conflictContext.setData('targetRepository', epic.targetRepository);
            conflictContext.setData('judgeFeedback', judgeResult.data?.feedback);
            if (pipelineSandboxId) {
              conflictContext.setData('sandboxId', pipelineSandboxId);
            }

            // Execute conflict resolution
            const conflictResult = await conflictResolver.execute(conflictContext);

            if (conflictResult.success) {
              console.log(`✅ [SPECIALIST] ConflictResolver resolved the conflicts`);

              // 🔄 RE-EVALUATE: Run Judge again after conflict resolution
              console.log(`\n⚖️ [RE-EVALUATION] Running Judge again after conflict resolution...`);
              const reEvalJudgePhase = new JudgePhase(this.executeAgentFn);
              const reEvalJudgeResult = await reEvalJudgePhase.execute(judgeContext);

              const reEvalApproved = reEvalJudgeResult.success && reEvalJudgeResult.data?.status === 'approved';

              if (reEvalApproved) {
                console.log(`✅ [RE-EVALUATION] Judge APPROVED after conflict resolution!`);

                // Continue with merge stage
                console.log(`\n🔀 [MERGE] Proceeding to merge approved story...`);
                await this.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, pipelineSandboxId);

                // Mark story as completed
                await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
                  commitHash: commitSHA,
                });

                story.status = 'completed';
                (story as any).mergedToEpic = true;
                (story as any).completedAt = new Date();
                (story as any).resolvedBySpecialist = 'ConflictResolver';

                const { eventStore } = await import('../EventStore');
                await eventStore.safeAppend({
                  taskId: task.id as any,
                  eventType: 'StoryCompleted',
                  agentName: 'conflict-resolver',
                  payload: {
                    storyId: story.id,
                    epicId: (story as any).epicId,
                    title: story.title,
                    completedBy: 'ConflictResolver',
                    resolvedConflicts: true,
                  },
                });

                await unifiedMemoryService.markStoryCompleted(
                  taskId,
                  normalizedEpicId,
                  normalizedStoryId,
                  'approved',
                  updatedStory.branchName,
                  undefined
                );

                console.log(`✅ [PIPELINE] Story completed via ConflictResolver specialist`);

                // Return early - story is completed
                return {
                  developerCost,
                  judgeCost: judgeCost + (reEvalJudgeResult.metadata?.cost || 0),
                  conflictResolutionCost: conflictResult.metadata?.cost || 0,
                  developerTokens,
                  judgeTokens: {
                    input: judgeTokens.input + Number(reEvalJudgeResult.metadata?.input_tokens || 0),
                    output: judgeTokens.output + Number(reEvalJudgeResult.metadata?.output_tokens || 0),
                  },
                  conflictResolutionUsage: {
                    input_tokens: conflictResult.metadata?.input_tokens || 0,
                    output_tokens: conflictResult.metadata?.output_tokens || 0,
                  },
                };
              } else {
                console.warn(`⚠️ [RE-EVALUATION] Judge still rejected after conflict resolution`);
                console.warn(`   New feedback: ${reEvalJudgeResult.data?.feedback}`);
                // Fall through to normal rejection flow
              }
            } else {
              console.warn(`⚠️ [SPECIALIST] ConflictResolver could not resolve conflicts`);
              console.warn(`   Error: ${conflictResult.error || 'Unknown error'}`);
              // Fall through to normal rejection flow
            }
          } catch (specialistError: any) {
            console.error(`❌ [SPECIALIST] ConflictResolver failed: ${specialistError.message}`);
            // Fall through to normal rejection flow
          }
        }

        // Normal rejection flow - mark as failed
        console.error(`❌ [PIPELINE] Story pipeline FAILED - NOT merging`);

        // 📋 IMPORTANT: Branch preserved for investigation
        console.log(`\n📋 [REJECTED STORY] Branch preserved for investigation:`);
        console.log(`   Branch: ${updatedStory.branchName}`);
        console.log(`   Story: ${story.title}`);
        console.log(`   Judge Feedback:`);
        const feedback = judgeResult.data?.feedback || judgeResult.error || 'No feedback provided';
        console.log(`   ${feedback}`);
        console.log(`\n💡 Next steps:`);
        console.log(`   1. Review the code in branch: ${updatedStory.branchName}`);
        console.log(`   2. Fix issues based on Judge feedback`);
        console.log(`   3. Re-run orchestration or manually fix and merge`);

        // Emit notification so user sees this in the UI
        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          taskId, // taskId is already defined at function scope
          'error',
          `❌ Story rejected by Judge: ${story.title}\nBranch: ${updatedStory.branchName}\nFeedback: ${feedback}`
        );

        // 🔄 GRANULAR RECOVERY: Persist rejected status via EventStore
        try {
          story.status = 'failed';
          (story as any).error = feedback;

          // 🔥 EVENT SOURCING: Emit StoryFailed event for recovery tracking
          const { eventStore } = await import('../EventStore');
          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryFailed',
            agentName: 'developer',
            payload: {
              storyId: story.id,
              epicId: (story as any).epicId,
              title: story.title,
              error: feedback,
            },
          });
          console.log(`📝 [EventStore] Emitted StoryFailed for: ${story.title}`);

          // 🔥 CRITICAL FIX: Mark story as completed (rejected) in Unified Memory for recovery tracking
          // Even rejected stories need tracking so recovery knows not to re-process them
          // 🔥 FIX #2: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
          await unifiedMemoryService.markStoryCompleted(
            taskId,
            normalizedEpicId,
            normalizedStoryId,
            'rejected',
            updatedStory.branchName,
            undefined
          );
          console.log(`❌ [UnifiedMemory] Marked story "${story.title}" as rejected (epicId=${normalizedEpicId}, storyId=${normalizedStoryId})`);

          // 🔄 Mark session checkpoint as failed (keep checkpoint for potential retry)
          await sessionCheckpointService.markFailed(taskId, 'developer', story.id, feedback);

          // 🔥 REMOVED: granularMemoryService.storeError - SQLite tracks errors via task.orchestration
        } catch (persistError: any) {
          console.error(`⚠️ [RECOVERY] Failed to persist story failure status: ${persistError.message}`);
        }
      }

      // 🔥 COST TRACKING: Include conflict resolution cost from merge operation
      // Cast to any since conflictResolutionCost is dynamically added in mergeStoryToEpic
      const conflictResolutionCost = (updatedStory as any).conflictResolutionCost || 0;
      const conflictResolutionUsage = (updatedStory as any).conflictResolutionUsage || { input_tokens: 0, output_tokens: 0 };

      return {
        developerCost,
        judgeCost,
        conflictResolutionCost,
        developerTokens,
        judgeTokens,
        conflictResolutionUsage
      };

    } catch (error: any) {
      console.error(`❌ [PIPELINE] Story pipeline failed for ${story.id}: ${error.message}`);

      // 🔍🔍🔍 FAILURE CLASSIFICATION: Determine recovery strategy 🔍🔍🔍
      const storyBranch = story.branchName;
      // 🔧 Respect ENABLE_STORY_ISOLATION flag - use same logic as main pipeline
      const effectiveWorkspaceForRecovery = ENABLE_STORY_ISOLATION
        ? (workspacePath ? `${workspacePath}/story-${story.id}` : null)
        : workspacePath;
      const repoPath = effectiveWorkspaceForRecovery && epic.targetRepository
        ? `${effectiveWorkspaceForRecovery}/${epic.targetRepository}`
        : null;

      // Step 1: Detect work in workspace (files, not just git history)
      const workspaceDetection = repoPath
        ? detectWorkInWorkspace(repoPath, undefined)
        : undefined;

      // Step 2: Check for commits on branch
      let hasCommitsOnBranch = false;
      let gitVerification: { hasCommits: boolean; commitCount: number; commitSHA: string | null; commitMessage?: string } | null = null;

      if (storyBranch && effectiveWorkspaceForRecovery && epic.targetRepository) {
        try {
          gitVerification = await this.verifyDeveloperWorkFromGit(
            effectiveWorkspaceForRecovery,
            epic.targetRepository,
            storyBranch,
            story.id
          );
          hasCommitsOnBranch = gitVerification?.hasCommits || false;
        } catch {
          // Ignore - will be handled by classifier
        }
      }

      // Step 3: Classify the failure
      const failureContext: FailureContext = {
        error,
        retriesAttempted: 0, // TODO: Track retries in pipeline
        maxRetries: 3,
        developerOutput: undefined, // TODO: Capture developer output
        workspaceDetection,
        hasCommitsOnBranch,
        phase: 'developer',
      };

      const failureAnalysis = classifyFailure(failureContext);
      logFailureAnalysis(story.title, story.id, failureAnalysis);

      // Emit failure analysis to frontend dashboard
      NotificationService.emitFailureAnalysis(taskId, {
        storyId: story.id,
        storyTitle: story.title,
        category: failureAnalysis.category,
        strategy: failureAnalysis.strategy,
        isTerminal: failureAnalysis.isTerminal,
        shouldRetry: failureAnalysis.shouldRetry,
        shouldCallJudge: failureAnalysis.shouldCallJudge,
        evidence: failureAnalysis.evidence,
        recommendations: failureAnalysis.recommendations,
        maxAdditionalRetries: failureAnalysis.maxAdditionalRetries,
        retryDelay: failureAnalysis.retryDelay,
        message: typeof error === 'string' ? error : error.message,
      });

      // Step 4: Execute recovery strategy based on classification
      if (storyBranch && effectiveWorkspaceForRecovery && epic.targetRepository) {
        try {
          // STRATEGY: SALVAGE_AND_JUDGE - Try to recover work and send to Judge
          if (failureAnalysis.shouldCallJudge) {
            console.log(`\n🔧 [RECOVERY] Strategy: ${failureAnalysis.strategy}`);

            // First, try comprehensive recovery (detects files + auto-commits)
            const recoveryResult = await comprehensiveWorkRecovery(
              repoPath!,
              story.title,
              storyBranch,
              undefined
            );

            const commitSHA = recoveryResult.commitSHA || gitVerification?.commitSHA;

            if (commitSHA) {
              console.log(`\n🎉 [RECOVERY] Work found! Commit: ${commitSHA.substring(0, 8)}`);
              console.log(`   Detection: ${recoveryResult.workspaceDetection.detectionMethod}`);
              console.log(`   Files changed: ${recoveryResult.workspaceDetection.totalChanges}`);
              console.log(`   🚀 Proceeding to JUDGE`);

              // Use existing gitVerification if we have it, otherwise use recovery result
              if (!gitVerification?.hasCommits && recoveryResult.commitSHA) {
                gitVerification = {
                  hasCommits: true,
                  commitCount: 1,
                  commitSHA: recoveryResult.commitSHA,
                  commitMessage: `Auto-recovered: ${story.title}`,
                };
              }
            } else {
              console.log(`\n⚠️ [RECOVERY] No work to salvage despite shouldCallJudge=true`);
            }
          }

          // STRATEGY: RETRY_* - Transient error, should retry
          else if (failureAnalysis.shouldRetry) {
            console.log(`\n⏳ [RECOVERY] Transient error detected - should retry`);
            console.log(`   Category: ${failureAnalysis.category}`);
            console.log(`   Strategy: ${failureAnalysis.strategy}`);
            console.log(`   Recommended delay: ${failureAnalysis.retryDelay}ms`);
            console.log(`   Retries remaining: ${failureAnalysis.maxAdditionalRetries}`);
            console.log(`   ⚠️ Retry logic should be handled at higher level - this catch shouldn't be reached!`);
          }

          // No Judge needed and no retry - this shouldn't happen with aggressive recovery
          else if (!failureAnalysis.shouldCallJudge) {
            console.log(`\n⚠️ [RECOVERY] No recovery action available`);
            console.log(`   Category: ${failureAnalysis.category}`);
            console.log(`   Strategy: ${failureAnalysis.strategy}`);
            console.log(`   This is unexpected with aggressive recovery settings!`);
          }

          // If we have a commit SHA (from original verification or recovery), proceed to Judge
          if (gitVerification?.hasCommits && gitVerification.commitSHA) {
            console.log(`\n🎉🎉🎉 [RECOVERY] FOUND DEVELOPER WORK! 🎉🎉🎉`);
            console.log(`   Commits: ${gitVerification.commitCount}`);
            console.log(`   Latest: ${gitVerification.commitSHA.substring(0, 8)}`);
            console.log(`   Message: ${gitVerification.commitMessage || 'N/A'}`);
            console.log(`   🚀 Proceeding directly to JUDGE (skipping failed developer retry)`);

            // Create pipeline context for recovery
            const recoveryPipelineCtx: StoryPipelineContext = {
              task,
              story,
              developer,
              epic,
              repositories,
              effectiveWorkspacePath: effectiveWorkspaceForRecovery,
              workspaceStructure,
              attachments,
              state,
              context,
              taskId,
              normalizedEpicId,
              normalizedStoryId,
              epicBranchName: epicBranchName || `epic/${normalizedEpicId}`,
              devAuth,
              architectureBrief,
              environmentCommands,
              projectRadiographies,
              sandboxId, // 🐳 Explicit sandbox ID for Docker execution
            };

            // Execute Judge stage directly
            console.log(`\n⚖️ [RECOVERY-JUDGE] Evaluating recovered work...`);
            const judgeResult = await this.executeJudgeStage(
              recoveryPipelineCtx,
              gitVerification.commitSHA,
              storyBranch
            );

            if (judgeResult.success && judgeResult.approved) {
              console.log(`\n✅ [RECOVERY-JUDGE] APPROVED! Proceeding to merge...`);

              // Execute Merge stage
              const mergeResult = await this.executeMergeStage(
                recoveryPipelineCtx,
                gitVerification.commitSHA
              );

              if (mergeResult.success) {
                console.log(`\n🎊🎊🎊 [RECOVERY] SUCCESS! Story recovered from failure! 🎊🎊🎊`);

                // Emit story recovered to frontend dashboard
                NotificationService.emitStoryRecovered(taskId, {
                  storyId: story.id,
                  storyTitle: story.title,
                  recoveryMethod: 'git_verification',
                  commitSHA: gitVerification.commitSHA || undefined,
                });

                // Emit StoryCompleted event
                const { eventStore } = await import('../EventStore');
                await eventStore.safeAppend({
                  taskId: task.id as any,
                  eventType: 'StoryCompleted',
                  agentName: 'developer',
                  payload: {
                    storyId: story.id,
                    epicId: normalizedEpicId,
                    title: story.title,
                    recoveredFromFailure: true,
                    originalError: error.message,
                  },
                });

                // Mark story as completed
                await unifiedMemoryService.markStoryCompleted(
                  taskId,
                  normalizedEpicId,
                  normalizedStoryId,
                  'approved',
                  storyBranch,
                  undefined
                );

                // Return costs from recovery
                return {
                  developerCost: 0, // Developer cost was lost due to failure
                  judgeCost: judgeResult.judgeCost,
                  conflictResolutionCost: mergeResult.conflictResolutionCost,
                  developerTokens: { input: 0, output: 0 },
                  judgeTokens: judgeResult.judgeTokens,
                  conflictResolutionUsage: mergeResult.conflictResolutionUsage,
                };
              } else {
                console.log(`\n⚠️ [RECOVERY-MERGE] Merge failed: ${mergeResult.error}`);
              }
            } else if (judgeResult.success && !judgeResult.approved) {
              console.log(`\n❌ [RECOVERY-JUDGE] REJECTED: ${judgeResult.feedback}`);
              // Judge rejected - mark as failed
              const { eventStore } = await import('../EventStore');
              await eventStore.safeAppend({
                taskId: task.id as any,
                eventType: 'StoryFailed',
                agentName: 'developer',
                payload: {
                  storyId: story.id,
                  epicId: normalizedEpicId,
                  title: story.title,
                  recoveredButRejected: true,
                  feedback: judgeResult.feedback,
                },
              });
            } else {
              console.log(`\n⚠️ [RECOVERY-JUDGE] Judge stage failed: ${judgeResult.error}`);
            }
          } else {
            // 🔥🔥🔥 AGGRESSIVE RECOVERY: No commits, but maybe files exist 🔥🔥🔥
            console.log(`   📭 No commits found - attempting aggressive file recovery...`);

            const repoPath = `${effectiveWorkspaceForRecovery}/${epic.targetRepository}`;

            // Try auto-commit to capture any uncommitted work
            const { autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
            const autoCommitResult = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

            if (autoCommitResult.success && autoCommitResult.commitSHA) {
              console.log(`\n🎉 [AGGRESSIVE RECOVERY] Found and committed uncommitted work!`);
              console.log(`   Commit: ${autoCommitResult.commitSHA.substring(0, 8)}`);
              console.log(`   Action: ${autoCommitResult.action}`);
              console.log(`   🚀 Proceeding to JUDGE with recovered work`);

              // Create pipeline context for recovery
              const recoveryPipelineCtx: StoryPipelineContext = {
                task,
                story,
                developer,
                epic,
                repositories,
                effectiveWorkspacePath: effectiveWorkspaceForRecovery,
                workspaceStructure,
                attachments,
                state,
                context,
                taskId,
                normalizedEpicId,
                normalizedStoryId,
                epicBranchName: epicBranchName || `epic/${normalizedEpicId}`,
                devAuth,
                architectureBrief,
                environmentCommands,
                projectRadiographies,
                sandboxId, // 🐳 Explicit sandbox ID for Docker execution
              };

              // Execute Judge stage
              console.log(`\n⚖️ [AGGRESSIVE-JUDGE] Evaluating recovered uncommitted work...`);
              const aggressiveJudgeResult = await this.executeJudgeStage(
                recoveryPipelineCtx,
                autoCommitResult.commitSHA,
                storyBranch
              );

              if (aggressiveJudgeResult.success && aggressiveJudgeResult.approved) {
                console.log(`\n✅ [AGGRESSIVE-JUDGE] APPROVED! Proceeding to merge...`);

                const aggressiveMergeResult = await this.executeMergeStage(
                  recoveryPipelineCtx,
                  autoCommitResult.commitSHA
                );

                if (aggressiveMergeResult.success) {
                  console.log(`\n🎊🎊🎊 [AGGRESSIVE RECOVERY] SUCCESS! Story recovered from uncommitted work! 🎊🎊🎊`);

                  // Emit story recovered to frontend dashboard
                  NotificationService.emitStoryRecovered(taskId, {
                    storyId: story.id,
                    storyTitle: story.title,
                    recoveryMethod: 'auto_commit_uncommitted_work',
                    commitSHA: autoCommitResult.commitSHA,
                  });

                  const { eventStore } = await import('../EventStore');
                  await eventStore.safeAppend({
                    taskId: task.id as any,
                    eventType: 'StoryCompleted',
                    agentName: 'developer',
                    payload: {
                      storyId: story.id,
                      epicId: normalizedEpicId,
                      title: story.title,
                      recoveredFromUncommittedWork: true,
                      originalError: error.message,
                    },
                  });

                  await unifiedMemoryService.markStoryCompleted(
                    taskId,
                    normalizedEpicId,
                    normalizedStoryId,
                    'approved',
                    storyBranch,
                    undefined
                  );

                  return {
                    developerCost: 0,
                    judgeCost: aggressiveJudgeResult.judgeCost,
                    conflictResolutionCost: aggressiveMergeResult.conflictResolutionCost,
                    developerTokens: { input: 0, output: 0 },
                    judgeTokens: aggressiveJudgeResult.judgeTokens,
                    conflictResolutionUsage: aggressiveMergeResult.conflictResolutionUsage,
                  };
                }
              } else if (aggressiveJudgeResult.success && !aggressiveJudgeResult.approved) {
                console.log(`\n❌ [AGGRESSIVE-JUDGE] REJECTED - work incomplete: ${aggressiveJudgeResult.feedback}`);
                // Judge rejected but at least we tried! Log for visibility
              }
            } else {
              console.log(`   ℹ️ No uncommitted files to recover: ${autoCommitResult.message}`);
            }
          }
        } catch (recoveryError: any) {
          console.error(`   ❌ Recovery check failed: ${recoveryError.message}`);
        }
      } else {
        console.log(`   ⚠️ Cannot verify git work - missing branch (${storyBranch}) or workspace`);
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // FINAL CHECK: Is this failure TERMINAL or should we have recovered?
      // ═══════════════════════════════════════════════════════════════════════════
      if (isTerminalFailure(failureAnalysis)) {
        // This is a LEGITIMATE failure (Judge rejected OR Claude API down)
        const reason = getTerminalFailureReason(failureAnalysis);
        console.log(`\n💀 [TERMINAL FAILURE] Story ${story.id} failed legitimately`);
        console.log(`   Reason: ${reason}`);
        console.log(`   Category: ${failureAnalysis.category}`);
      } else {
        // This should NOT have failed - recovery was possible but didn't work
        console.log(`\n⚠️ [UNEXPECTED FAILURE] Story ${story.id} failed but recovery was possible`);
        console.log(`   Category: ${failureAnalysis.category}`);
        console.log(`   Strategy: ${failureAnalysis.strategy}`);
        console.log(`   Should have retried: ${failureAnalysis.shouldRetry}`);
        console.log(`   Max retries remaining: ${failureAnalysis.maxAdditionalRetries || 0}`);
        console.log(`   🚨 This indicates a bug in the recovery logic - this failure should have been prevented!`);
      }

      // Return zero costs - story failed
      return {
        developerCost: 0,
        judgeCost: 0,
        conflictResolutionCost: 0,
        developerTokens: { input: 0, output: 0 },
        judgeTokens: { input: 0, output: 0 },
        conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // 🔥 STAGE METHODS: Extracted for mid-story recovery support
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * 🔥 DEVELOPER STAGE: Execute the developer agent to implement the story.
   *
   * This stage:
   * 1. Saves 'code_generating' checkpoint
   * 2. Creates rollback point
   * 3. Checks for existing SDK session to resume
   * 4. Calls executeDeveloperFn
   * 5. Saves 'code_written' checkpoint
   *
   * @returns DeveloperStageResult with cost, tokens, and session info
   */
  private async executeDeveloperStage(pipelineCtx: StoryPipelineContext): Promise<DeveloperStageResult> {
    const {
      task, story, developer, epic, repositories,
      effectiveWorkspacePath, workspaceStructure, attachments, state, context: _context,
      taskId, normalizedEpicId, normalizedStoryId, epicBranchName,
      devAuth, architectureBrief, environmentCommands, projectRadiographies,
      sandboxId, // 🐳 Explicit sandbox ID for Docker execution
    } = pipelineCtx;

    console.log(`\n👨‍💻 [DEVELOPER STAGE] Starting for story: ${story.title}`);
    console.log(`   Developer: ${developer.instanceId}`);
    console.log(`   Epic Branch: ${epicBranchName}`);

    try {
      // 🔥 CHECKPOINT: Mark story as "code_generating"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_generating');

      // 🔄 CHECKPOINT: Create rollback point before developer execution
      const { rollbackService } = await import('../RollbackService');
      const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      const checkpoint = await rollbackService.createCheckpoint(
        repoPath,
        taskId,
        `Before ${developer.instanceId}: ${story.title}`,
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: developer.instanceId,
          storyId: getStoryId(story),
          storyTitle: story.title,
          epicId: getEpicId(epic),
          epicName: epic.name,
        }
      );
      if (checkpoint) {
        console.log(`🔄 [CHECKPOINT] Created: ${checkpoint.id} (${checkpoint.commitHash.substring(0, 7)})`);
      }

      // 🔄 SESSION RESUME: Check for existing session checkpoint
      const existingSessionCheckpoint = await sessionCheckpointService.loadCheckpoint(
        taskId,
        'developer',
        story.id
      );
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingSessionCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [Developer ${developer.instanceId}] RESUMING from previous session...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Developer ${developer.instanceId}: Resuming story "${story.title}" from checkpoint`
        );
      }

      // 🔔 Emit to frontend
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `👨‍💻 Developer ${developer.instanceId} starting: "${story.title}"`
      );

      // Execute Developer
      const developerResult = await this.executeDeveloperFn(
        task,
        developer,
        repositories,
        effectiveWorkspacePath,
        workspaceStructure,
        attachments,
        [story],  // 🔥 1 Dev = 1 Story
        state.epics,
        undefined, // judgeFeedback
        epicBranchName,
        undefined, // forceTopModel
        devAuth,
        architectureBrief,
        environmentCommands,
        projectRadiographies,
        resumeOptions,
        sandboxId // 🐳 Explicit sandbox ID for Docker execution
      );

      // 🔄 Save session checkpoint
      if (developerResult?.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'developer',
          developerResult.sdkSessionId,
          getStoryId(story),
          developerResult.lastMessageUuid,
          {
            developerId: developer.instanceId,
            storyTitle: story.title,
            epicId: getEpicId(epic),
          }
        );
      }

      // Track cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };

      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Developer ${developer.instanceId} finished: "${story.title}" ($${developerCost.toFixed(4)})`
        );
      }

      // 🔥 CHECKPOINT: Mark story as "code_written"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_written', {
        sdkSessionId: developerResult?.sdkSessionId,
      });

      return {
        success: true,
        developerCost,
        developerTokens,
        sdkSessionId: developerResult?.sdkSessionId,
        output: developerResult?.output || '',
      };

    } catch (error: any) {
      console.error(`❌ [DEVELOPER STAGE] Failed: ${error.message}`);
      return {
        success: false,
        developerCost: 0,
        developerTokens: { input: 0, output: 0 },
        error: error.message,
      };
    }
  }

  /**
   * 🔥 GIT VALIDATION STAGE: Verify commits exist and push if needed.
   *
   * This stage:
   * 1. Waits for git push to propagate
   * 2. Verifies story has a branch
   * 3. Checks for explicit failure markers
   * 4. Fetches from remote with retry
   * 5. Verifies commits on branch
   * 6. Auto-commits if developer forgot
   * 7. Pushes to remote if needed
   * 8. Saves 'pushed' checkpoint
   *
   * @returns GitValidationStageResult with commitSHA and validation status
   */
  private async executeGitValidationStage(
    pipelineCtx: StoryPipelineContext,
    developerOutput: string
  ): Promise<GitValidationStageResult> {
    const {
      task, story, epic, repositories: _repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId,
    } = pipelineCtx;

    console.log(`\n🔍 [GIT VALIDATION STAGE] Starting for story: ${story.title}`);

    try {
      // Wait for git push to propagate
      console.log(`⏳ Waiting 3 seconds for git push to propagate...`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get updated story with branch info
      const { eventStore } = await import('../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      if (!updatedStory || !updatedStory.branchName) {
        console.error(`❌ Story ${story.id} has no branch after developer`);
        return {
          success: false,
          commitSHA: null,
          storyBranch: null,
          gitValidationPassed: false,
          error: 'Story has no branch after developer execution',
        };
      }

      // Check for explicit failure marker
      const explicitlyFailed = hasMarker(developerOutput, COMMON_MARKERS.FAILED);
      if (explicitlyFailed) {
        console.error(`❌ Developer explicitly reported FAILURE`);
        return {
          success: false,
          commitSHA: null,
          storyBranch: updatedStory.branchName,
          gitValidationPassed: false,
          error: 'Developer reported explicit failure',
        };
      }

      const storyBranch = story.branchName || updatedStory?.branchName;
      let commitSHA: string | null = null;
      let gitValidationPassed = false;

      console.log(`   Story: ${story.title}`);
      console.log(`   Branch: ${storyBranch || 'unknown'}`);

      if (storyBranch && effectiveWorkspacePath && epic.targetRepository) {
        const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;

        // Fetch from remote with exponential backoff
        const MAX_FETCH_RETRIES = 3;
        for (let fetchAttempt = 1; fetchAttempt <= MAX_FETCH_RETRIES; fetchAttempt++) {
          try {
            console.log(`   📡 Fetching from remote (attempt ${fetchAttempt}/${MAX_FETCH_RETRIES})...`);
            safeGitExecSync(`git fetch origin --prune`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: GIT_TIMEOUTS.FETCH
            });
            console.log(`   ✅ Fetch succeeded`);
            break;
          } catch (fetchErr: any) {
            const waitMs = 2000 * Math.pow(2, fetchAttempt - 1);
            if (fetchAttempt < MAX_FETCH_RETRIES) {
              console.warn(`   ⚠️ Fetch failed: ${fetchErr.message}, retrying in ${waitMs/1000}s...`);
              await new Promise(resolve => setTimeout(resolve, waitMs));
            } else {
              console.error(`   ❌ Fetch FAILED after ${MAX_FETCH_RETRIES} attempts`);
            }
          }
        }

        // Verify developer work from git
        const gitVerification = await this.verifyDeveloperWorkFromGit(
          effectiveWorkspacePath,
          epic.targetRepository,
          storyBranch,
          story.id
        );

        if (gitVerification?.hasCommits && gitVerification.commitSHA) {
          console.log(`✅ Developer made ${gitVerification.commitCount} commits!`);
          console.log(`   Latest commit: ${gitVerification.commitSHA.substring(0, 8)}`);
          commitSHA = gitVerification.commitSHA;
          gitValidationPassed = true;

          // Ensure commit is on remote
          console.log(`\n📤 Verifying commit is on remote...`);
          try {
            const branchOnRemote = safeGitExecSync(
              `git ls-remote origin refs/heads/${storyBranch}`,
              { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
            );

            if (!branchOnRemote || branchOnRemote.trim() === '') {
              console.log(`   ⚠️ Branch not on remote - pushing...`);
              safeGitExecSync(`git push -u origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
              console.log(`   ✅ Branch pushed`);
              // FIX: Sync local with remote after push
              try {
                safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
              } catch (_pullErr) { /* already up to date */ }
            } else {
              const remoteCommit = branchOnRemote.split('\t')[0];
              if (remoteCommit !== commitSHA) {
                console.log(`   ⚠️ Remote has different commit - pushing latest...`);
                safeGitExecSync(`git push origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
                // FIX: Sync local with remote after push
                try {
                  safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
                } catch (_pullErr) { /* already up to date */ }
              }
              console.log(`   ✅ Commit confirmed on remote`);
            }
          } catch (pushErr: any) {
            console.warn(`   ⚠️ Push verification failed: ${pushErr.message}`);
            try {
              safeGitExecSync(`git push -u origin ${storyBranch} --force-with-lease`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
              console.log(`   ✅ Force push succeeded`);
              // FIX: Sync local with remote after force push
              try {
                safeGitExecSync(`git pull origin ${storyBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
              } catch (_pullErr) { /* already up to date */ }
            } catch (forcePushErr: any) {
              console.error(`   ❌ Force push failed: ${forcePushErr.message}`);
            }
          }

          // 🔥 CHECKPOINT: Mark as pushed
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'pushed', {
            commitHash: commitSHA,
          });
          console.log(`📍 [CHECKPOINT] Story progress: pushed (commit: ${commitSHA.substring(0, 8)})`);

          // 🔥 CRITICAL: Verify push on GitHub and emit StoryPushVerified event
          // This ensures Local state matches GitHub reality
          try {
            const { eventStore } = await import('../EventStore');
            await eventStore.verifyStoryPush({
              taskId: task.id as any,
              storyId: story.id,
              branchName: storyBranch,
              repoPath,
            });
          } catch (verifyErr: any) {
            console.warn(`⚠️ [PushVerify] Could not verify push: ${verifyErr.message}`);
            // Non-blocking - verification is for tracking, not blocking the flow
          }

        } else {
          // Try auto-commit
          console.log(`⚠️ No commits found, trying auto-commit...`);
          const { autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
          const autoCommitResult = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

          if (autoCommitResult.success && autoCommitResult.commitSHA) {
            console.log(`✅ Auto-commit recovered work: ${autoCommitResult.commitSHA.substring(0, 8)}`);
            commitSHA = autoCommitResult.commitSHA;
            gitValidationPassed = true;
          }
        }
      }

      // Fallback to marker validation if git failed
      if (!gitValidationPassed) {
        const finishedMarker = hasMarker(developerOutput, COMMON_MARKERS.DEVELOPER_FINISHED) ||
                               hasMarker(developerOutput, COMMON_MARKERS.FINISHED);
        if (!finishedMarker) {
          console.error(`❌ No commits and no FINISHED marker`);
          return {
            success: false,
            commitSHA: null,
            storyBranch,
            gitValidationPassed: false,
            error: 'No commits found and no finish marker',
          };
        }
        commitSHA = extractMarkerValue(developerOutput, COMMON_MARKERS.COMMIT_SHA);
        console.log(`✅ Developer finished (marker present)`);
      }

      if (!commitSHA) {
        console.error(`❌ Could not determine commit SHA`);
        return {
          success: false,
          commitSHA: null,
          storyBranch,
          gitValidationPassed: false,
          error: 'Could not determine commit SHA',
        };
      }

      console.log(`✅ [GIT VALIDATION STAGE] Complete: commit ${commitSHA}`);

      return {
        success: true,
        commitSHA,
        storyBranch,
        gitValidationPassed,
      };

    } catch (error: any) {
      console.error(`❌ [GIT VALIDATION STAGE] Failed: ${error.message}`);
      return {
        success: false,
        commitSHA: null,
        storyBranch: null,
        gitValidationPassed: false,
        error: error.message,
      };
    }
  }

  /**
   * 🔥 JUDGE STAGE: Run Judge evaluation on the committed code.
   *
   * This stage:
   * 1. Syncs workspace with remote
   * 2. Checkouts the story branch
   * 3. Saves 'judge_evaluating' checkpoint
   * 4. Creates Judge context
   * 5. Runs JudgePhase
   * 6. Returns verdict
   *
   * @returns JudgeStageResult with verdict, cost, and feedback
   */
  private async executeJudgeStage(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string,
    storyBranch: string
  ): Promise<JudgeStageResult> {
    const {
      task, story, developer, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId, context: _context,
    } = pipelineCtx;

    console.log(`\n⚖️ [JUDGE STAGE] Starting for story: ${story.title}`);
    console.log(`   Commit: ${commitSHA}`);
    console.log(`   Branch: ${storyBranch}`);

    try {
      // Get updated story
      const { eventStore } = await import('../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      // Sync workspace with remote
      if (effectiveWorkspacePath && repositories.length > 0) {
        const targetRepo = repositories.find((r: any) =>
          r.name === epic.targetRepository ||
          r.full_name === epic.targetRepository ||
          r.githubRepoName === epic.targetRepository
        );

        if (targetRepo) {
          const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;

          console.log(`   🔄 Syncing workspace...`);
          try {
            // Use cached fetch to avoid redundant network calls
            smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });

            // Checkout story branch
            let branchExistsLocally = false;
            try {
              safeGitExecSync(`git show-ref --verify --quiet refs/heads/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
              branchExistsLocally = true;
            } catch { /* Branch doesn't exist locally */ }

            if (branchExistsLocally) {
              safeGitExecSync(`git checkout ${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            } else {
              safeGitExecSync(`git checkout -b ${storyBranch} origin/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            }

            // Reset to remote
            safeGitExecSync(`git reset --hard origin/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`   ✅ Workspace synced`);
          } catch (syncErr: any) {
            console.warn(`   ⚠️ Sync failed: ${syncErr.message}`);
          }
        }
      }

      // 🔥 CHECKPOINT: Mark as judge_evaluating
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'judge_evaluating', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress: judge_evaluating`);

      // Create Judge context
      const judgeContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
      judgeContext.setData('storyToReview', updatedStory);
      judgeContext.setData('reviewMode', 'single-story');
      judgeContext.setData('developmentTeam', [developer]);
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);
      judgeContext.setData('commitSHA', commitSHA);
      judgeContext.setData('storyBranchName', storyBranch);
      judgeContext.setData('isolatedWorkspacePath', effectiveWorkspacePath);

      // Run Judge
      const { JudgePhase } = await import('./JudgePhase');

      if (!this.executeAgentFn) {
        throw new Error('executeAgentFn is required for Judge evaluation');
      }

      const judgePhase = new JudgePhase(this.executeAgentFn);
      const judgeResult = await judgePhase.execute(judgeContext);

      // Track cost and tokens
      const judgeCost = judgeResult.metadata?.cost || 0;
      const judgeTokens = {
        input: Number(judgeResult.metadata?.input_tokens || judgeResult.metrics?.input_tokens || 0),
        output: Number(judgeResult.metadata?.output_tokens || judgeResult.metrics?.output_tokens || 0),
      };

      if (judgeCost > 0) {
        console.log(`💰 [Judge] Cost: $${judgeCost.toFixed(4)}`);
      }

      // Determine verdict
      const judgeStatus = judgeResult.data?.status;
      const isApproved = judgeResult.success && judgeStatus === 'approved';

      console.log(`✅ [JUDGE STAGE] Verdict: ${isApproved ? 'APPROVED ✅' : 'REJECTED ❌'}`);

      // 🔥 SPECIALIST ROUTING: Extract rejectReason for routing decision
      const rejectReason = judgeResult.data?.rejectReason;
      if (!isApproved && rejectReason) {
        console.log(`📋 [JUDGE STAGE] Rejection reason: ${rejectReason}`);
      }

      return {
        success: true,
        approved: isApproved,
        judgeCost,
        judgeTokens,
        feedback: judgeResult.data?.feedback || judgeResult.error,
        iteration: judgeResult.data?.iteration || 1,
        maxRetries: judgeResult.data?.maxRetries || 3,
        rejectReason,
      };

    } catch (error: any) {
      console.error(`❌ [JUDGE STAGE] Failed: ${error.message}`);
      return {
        success: false,
        approved: false,
        judgeCost: 0,
        judgeTokens: { input: 0, output: 0 },
        error: error.message,
      };
    }
  }

  /**
   * 🔥 MERGE STAGE: Merge approved story to epic branch.
   *
   * This stage:
   * 1. Calls mergeStoryToEpic
   * 2. Saves 'merged_to_epic' checkpoint
   * 3. Cleans up story branch
   * 4. Emits events
   *
   * @returns MergeStageResult with conflict resolution costs
   */
  private async executeMergeStage(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string
  ): Promise<MergeStageResult> {
    const {
      task, story, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId, context: _context,
      sandboxId, // 🐳 Explicit sandbox ID for Docker execution
    } = pipelineCtx;

    console.log(`\n🔀 [MERGE STAGE] Merging story to epic branch: ${story.title}`);

    try {
      // Get updated story
      const { eventStore } = await import('../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      // Merge to epic branch
      await this.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, sandboxId);

      // 🔥 CHECKPOINT: Mark as merged_to_epic
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress: merged_to_epic`);

      // 🔥 AUTO-REBUILD: Trigger rebuild for frameworks using static builds (Flutter, etc.)
      await this.triggerAutoRebuild(taskId, sandboxId, effectiveWorkspacePath, repositories, epic);

      // Cleanup story branch
      if (effectiveWorkspacePath && repositories.length > 0 && epic.targetRepository) {
        try {
          const targetRepo = repositories.find((r: any) =>
            r.name === epic.targetRepository ||
            r.full_name === epic.targetRepository ||
            r.githubRepoName === epic.targetRepository
          );

          if (targetRepo && updatedStory?.branchName) {
            const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;
            const storyBranch = updatedStory.branchName;

            // Delete local branch
            try {
              safeGitExecSync(`cd "${repoPath}" && git branch -D ${storyBranch}`, { encoding: 'utf8' });
              console.log(`🧹 Cleaned up LOCAL story branch: ${storyBranch}`);
            } catch { /* Branch might not exist */ }

            // Delete remote branch
            try {
              safeGitExecSync(`cd "${repoPath}" && git push origin --delete ${storyBranch}`, {
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.CLONE
              });
              console.log(`🧹 Cleaned up REMOTE story branch: ${storyBranch}`);
            } catch { /* Branch might not exist on remote */ }
          }
        } catch (cleanupErr: any) {
          console.warn(`⚠️ Branch cleanup failed: ${cleanupErr.message}`);
        }
      }

      // Get conflict resolution costs from story (use updatedStory if available, fall back to original)
      const storyForCosts = updatedStory || story;
      const conflictResolutionCost = (storyForCosts as any).conflictResolutionCost || 0;
      const conflictResolutionUsage = (storyForCosts as any).conflictResolutionUsage || { input_tokens: 0, output_tokens: 0 };

      console.log(`✅ [MERGE STAGE] Complete`);

      return {
        success: true,
        conflictResolutionCost,
        conflictResolutionUsage,
      };

    } catch (error: any) {
      console.error(`❌ [MERGE STAGE] Failed: ${error.message}`);
      return {
        success: false,
        conflictResolutionCost: 0,
        conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
        error: error.message,
      };
    }
  }

  /**
   * 🔥 AUTO-REBUILD: Automatically rebuild after merge for frameworks using static builds
   *
   * This is AGNOSTIC - it reads rebuildCmd from EventStore's environmentConfig,
   * which was set by LanguageDetectionService based on LLM analysis.
   *
   * For frameworks with HMR (hot module replacement), rebuildCmd will be "echo 'HMR handles rebuild'"
   * which we skip. For static builds (Flutter Web), rebuildCmd will be "flutter build web".
   */
  private async triggerAutoRebuild(
    taskId: string,
    _sandboxId: string | undefined,
    _workspacePath: string | null,
    repositories: any[],
    epic: any
  ): Promise<void> {
    // Check if sandbox is running using SandboxService (which uses taskId for lookup)
    const sandbox = sandboxService.getSandbox(taskId);
    if (!sandbox) {
      console.log(`   ⚠️ [AutoRebuild] No sandbox running for task ${taskId} - skipping auto-rebuild`);
      return;
    }

    // Find target repo name
    const targetRepoObj = repositories.find((r: any) =>
      r.name === epic.targetRepository ||
      r.full_name === epic.targetRepository ||
      r.githubRepoName === epic.targetRepository
    );

    if (!targetRepoObj) {
      console.log(`   ⚠️ [AutoRebuild] Could not find target repo - skipping`);
      return;
    }

    const repoName = targetRepoObj.name || targetRepoObj.full_name;

    // 🔥 AGNOSTIC: Get rebuildCmd from EventStore's environmentConfig
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(taskId as any);
    const envConfig = state.environmentConfig || {};
    const repoConfig = envConfig[repoName];

    if (!repoConfig) {
      console.log(`   ⚠️ [AutoRebuild] No environmentConfig for repo "${repoName}" - skipping`);
      return;
    }

    const rebuildCmd = repoConfig.rebuildCmd;
    const framework = repoConfig.framework || repoConfig.language || 'unknown';

    // Skip if no rebuildCmd or if it's just an echo (HMR handles rebuild)
    if (!rebuildCmd || rebuildCmd.startsWith("echo ")) {
      console.log(`   ℹ️ [AutoRebuild] Repo "${repoName}" uses HMR or has no rebuildCmd - skipping`);
      return;
    }

    console.log(`\n🔨 [AutoRebuild] Detected ${framework} project - triggering rebuild...`);
    console.log(`   Command: ${rebuildCmd}`);

    // Notify frontend that rebuild is starting
    NotificationService.emitNotification(taskId, 'rebuild_started', {
      framework,
      message: `Rebuilding ${framework} after merge...`,
    });

    try {
      const startTime = Date.now();

      // Execute rebuild command in sandbox (sandboxService.exec uses taskId for lookup)
      const result = await sandboxService.exec(taskId, rebuildCmd, {
        cwd: '/workspace',
        timeout: 300000, // 5 minutes for builds
      });

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (result.exitCode === 0) {
        console.log(`   ✅ [AutoRebuild] ${framework} rebuild completed in ${duration}s`);

        // Notify frontend to refresh iframe
        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: true,
          duration,
          message: `${framework} rebuild complete! Refreshing preview...`,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 [AutoRebuild] ${framework} rebuilt after merge - preview updated`
        );
      } else {
        console.warn(`   ⚠️ [AutoRebuild] ${framework} rebuild failed (exit ${result.exitCode})`);
        console.warn(`      stderr: ${result.stderr?.substring(0, 300)}`);

        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: false,
          error: result.stderr?.substring(0, 200) || 'Build failed',
          message: `${framework} rebuild failed - manual refresh may be needed`,
        });
      }
    } catch (rebuildError: any) {
      console.error(`   ❌ [AutoRebuild] Error: ${rebuildError.message}`);

      NotificationService.emitNotification(taskId, 'rebuild_complete', {
        framework,
        success: false,
        error: rebuildError.message,
      });
    }
  }

  /**
   * Merge approved story branch into epic branch
   */
  private async mergeStoryToEpic(
    story: any,
    epic: any,
    workspacePath: string | null,
    repositories: any[],
    taskId: string,
    sandboxId?: string // 🐳 Explicit sandbox ID for Docker execution
  ): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔀 [Merge] STARTING STORY TO EPIC MERGE`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   Story: ${story.title || story.id}`);
    console.log(`   Story Branch: ${story.branchName}`);
    console.log(`   Epic: ${epic.title || epic.id}`);
    console.log(`   Epic Branch: ${epic.branchName || `epic/${epic.id}`}`);
    console.log(`${'='.repeat(80)}\n`);

    if (!workspacePath) {
      console.error(`❌ [Merge] No workspace path available`);
      throw new Error('Workspace path required for merge');
    }

    if (!story.branchName) {
      console.error(`❌ [Merge] Story has no branch name - cannot merge`);
      throw new Error(`Story ${story.id} has no branch`);
    }

    try {
      const { NotificationService } = await import('../NotificationService');

      // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
      if (!epic.targetRepository) {
        throw new Error(`Epic ${epic.id} has no targetRepository - cannot merge to main`);
      }

      const targetRepoObj = repositories.find(r =>
        r.name === epic.targetRepository ||
        r.full_name === epic.targetRepository ||
        r.githubRepoName === epic.targetRepository
      );

      if (!targetRepoObj) {
        throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
      }

      const repoPath = `${workspacePath}/${targetRepoObj.name || targetRepoObj.full_name}`;
      // 🔥 CRITICAL: Use the unique branch name from epic, NOT a generic one
      const epicBranch = epic.branchName;

      if (!epicBranch) {
        throw new Error(`Epic ${epic.id} has no branchName - cannot merge`);
      }

      console.log(`📂 [Merge] Repository: ${epic.targetRepository}`);
      console.log(`📂 [Merge] Workspace Path: ${workspacePath}`);
      console.log(`📂 [Merge] Repo Path: ${repoPath}`);
      console.log(`📂 [Merge] Epic Branch: ${epicBranch}`);

      // 1. Checkout epic branch
      console.log(`\n[STEP 1/4] Checking out epic branch: ${epicBranch}...`);
      const checkoutOutput = safeGitExecSync(`cd "${repoPath}" && git checkout ${epicBranch}`, { encoding: 'utf8' });
      console.log(`✅ [Merge] Checked out ${epicBranch}`);
      console.log(`   Git output: ${checkoutOutput.substring(0, 100)}`);

      // 2. Pull latest changes from epic branch
      console.log(`\n[STEP 2/5] Pulling latest changes from remote...`);
      try {
        const pullOutput = safeGitExecSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, {
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.FETCH, // 90 seconds for pull (network operation)
        });
        console.log(`✅ [Merge] Pulled latest changes from ${epicBranch}`);
        console.log(`   Git output: ${pullOutput.substring(0, 100)}`);
      } catch (pullError: any) {
        console.warn(`⚠️  [Merge] Pull failed: ${pullError.message}`);
        if (pullError.message?.includes('TIMEOUT') || pullError.message?.includes('timed out')) {
          console.warn(`   ℹ️  CAUSE: Network timeout - try increasing timeout or check connection`);
        } else if (pullError.message?.includes('not found') || pullError.message?.includes('couldn\'t find remote ref')) {
          console.warn(`   ℹ️  CAUSE: Branch does not exist on remote yet`);
        } else {
          console.warn(`   ℹ️  CAUSE: Unknown - check network/auth/remote status`);
        }
      }

      // 2.5. Handle untracked files that might block merge
      // This is critical for Flutter/other generators that create files in sandbox
      console.log(`\n[STEP 2.5/5] Checking for untracked files that might block merge...`);
      try {
        const untrackedOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, { encoding: 'utf8' });
        const untrackedFiles = untrackedOutput
          .split('\n')
          .filter((line: string) => line.startsWith('??'))
          .map((line: string) => line.substring(3).trim());

        if (untrackedFiles.length > 0) {
          console.log(`   Found ${untrackedFiles.length} untracked files (e.g., from flutter create)`);
          console.log(`   Files: ${untrackedFiles.slice(0, 5).join(', ')}${untrackedFiles.length > 5 ? '...' : ''}`);

          // Add all untracked files and commit them
          console.log(`   Adding and committing untracked files to prevent merge conflicts...`);
          safeGitExecSync(`cd "${repoPath}" && git add -A`, { encoding: 'utf8' });

          // Check if there's anything to commit
          const statusAfterAdd = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, { encoding: 'utf8' });
          if (statusAfterAdd.trim().length > 0) {
            safeGitExecSync(
              `cd "${repoPath}" && git commit -m "chore: Add generated files before merge (flutter create, etc.)"`,
              { encoding: 'utf8' }
            );
            console.log(`   ✅ Committed ${untrackedFiles.length} generated files`);
          } else {
            console.log(`   No changes to commit after staging`);
          }
        } else {
          console.log(`   No untracked files found, merge should proceed cleanly`);
        }
      } catch (untrackedError: any) {
        console.warn(`⚠️  [Merge] Error handling untracked files: ${untrackedError.message}`);
        // Continue anyway - the merge will fail if there are real conflicts
      }

      // 3. Merge story branch with timeout protection
      console.log(`\n[STEP 3/4] Merging story branch into epic...`);
      console.log(`   Executing: git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`);
      const mergeOutput = safeGitExecSync(
        `cd "${repoPath}" && git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`,
        { encoding: 'utf8' }
      );
      console.log(`✅ [Merge] MERGE SUCCESSFUL: ${story.branchName} → ${epicBranch}`);
      console.log(`   Git merge output:\n${mergeOutput}`);

      // 4. Push epic branch WITH TIMEOUT
      console.log(`\n[STEP 4/4] Pushing epic branch to remote...`);
      console.log(`   Executing: git push origin ${epicBranch}`);

      // 🔥 CRITICAL FIX: Remove token-based auth from remote URL before pushing
      // The remote may have an old/expired token that causes authentication failures
      console.log(`🔧 [Merge] Fixing git remote authentication...`);
      const authFixed = fixGitRemoteAuth(repoPath);
      if (authFixed) {
        console.log(`✅ [Merge] Git remote URL fixed to use credential helper`);
      } else {
        console.log(`ℹ️  [Merge] Git remote URL already clean (no token embedded)`);
      }

      // Verify current remote URL
      try {
        const currentRemote = safeGitExecSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8' });
        console.log(`📋 [Merge] Current remote URL: ${currentRemote.replace(/\/\/.*@/, '//*****@')}`);
      } catch (e) {
        console.warn(`⚠️  [Merge] Could not get current remote URL`);
      }

      // Try to push with retries
      let pushSucceeded = false;
      let lastError: any = null;
      const maxRetries = 3;

      for (let attempt = 1; attempt <= maxRetries && !pushSucceeded; attempt++) {
        try {
          console.log(`📤 [Merge] Push attempt ${attempt}/${maxRetries}...`);
          const pushOutput = safeGitExecSync(
            `git push origin ${epicBranch}`,
            {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: GIT_TIMEOUTS.FETCH // 90 seconds (network operation)
            }
          );
          console.log(`✅ [Merge] PUSH SUCCESSFUL: ${epicBranch} pushed to remote`);
          console.log(`   Git push output:\n${pushOutput}`);
          pushSucceeded = true;
          // FIX: Sync local with remote after push
          try {
            safeGitExecSync(`git pull origin ${epicBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
            console.log(`✅ [Merge] Local synced with remote`);
          } catch (_pullErr) {
            console.log(`   ℹ️ Pull skipped (already up to date)`);
          }
        } catch (pushError: any) {
          lastError = pushError;
          console.error(`❌ [Merge] Push attempt ${attempt} failed: ${pushError.message}`);

          if (attempt < maxRetries) {
            const delay = 2000 * attempt; // 2s, 4s, 6s
            console.log(`⏳ [Merge] Waiting ${delay/1000}s before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (!pushSucceeded) {
        console.error(`❌ [Merge] CRITICAL: All ${maxRetries} push attempts failed!`);
        console.error(`   Epic branch: ${epicBranch}`);
        console.error(`   Repository: ${repoPath}`);
        console.error(`   Last error: ${lastError?.message}`);
        console.error(`   Epic branch has been merged LOCALLY but NOT pushed to remote`);
        console.error(`   This means the code is LOST if we continue`);
        console.error(`\n   🔧 Troubleshooting:`);
        console.error(`   1. Check GitHub authentication: gh auth status`);
        console.error(`   2. Check git credentials: git config --list | grep credential`);
        console.error(`   3. Manual push: cd "${repoPath}" && git push origin ${epicBranch}`);

        // 🔥 CRITICAL: DO NOT continue if push fails
        // Story branch will be deleted and code will be lost forever
        throw new Error(`Failed to push epic branch ${epicBranch} to remote after ${maxRetries} attempts: ${lastError?.message}`);
      }

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔀 Merged story ${story.title} → ${epicBranch}`
      );

      // 5. Update story status
      story.mergedToEpic = true;
      story.mergedAt = new Date();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ [Merge] STORY MERGE COMPLETED SUCCESSFULLY`);
      console.log(`   Story: ${story.title || story.id}`);
      console.log(`   Story Branch: ${story.branchName}`);
      console.log(`   Epic Branch: ${epicBranch}`);
      console.log(`   Merged to Epic: ${story.mergedToEpic}`);
      console.log(`   Merged At: ${story.mergedAt}`);
      console.log(`${'='.repeat(80)}\n`);
    } catch (error: any) {
      console.error(`❌ [Merge] Failed to merge story ${story.id}: ${error.message}`);

      // Check if it's a merge conflict
      if (error.message.includes('CONFLICT') || error.message.includes('Recorded preimage')) {
        console.error(`🔥 [Merge] MERGE CONFLICT detected!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Branch: ${story.branchName}`);
        console.error(`   Epic: epic/${epic.id}`);

        // 🔥 ATTEMPT TO RESOLVE CONFLICT AUTOMATICALLY
        console.log(`\n🤖 [Merge] Attempting automatic conflict resolution...`);

        // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
        if (!epic.targetRepository) {
          throw new Error(`Epic ${epic.id} has no targetRepository - cannot resolve conflict`);
        }

        const targetRepoObj = repositories.find(r =>
          r.name === epic.targetRepository ||
          r.full_name === epic.targetRepository ||
          r.githubRepoName === epic.targetRepository
        );

        if (!targetRepoObj) {
          throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
        }

        const repoPath = `${workspacePath}/${targetRepoObj.name || targetRepoObj.full_name}`;

        // Get list of conflicted files
        let conflictedFiles: string[] = [];
        try {
          const diffOutput = safeGitExecSync(`cd "${repoPath}" && git diff --name-only --diff-filter=U`, {
            encoding: 'utf8',
          });
          conflictedFiles = diffOutput.trim().split('\n').filter(f => f);
          console.log(`   📄 Conflicted files: ${conflictedFiles.join(', ')}`);
        } catch (diffError) {
          console.error(`   ⚠️ Could not get conflicted files: ${diffError}`);
        }

        if (conflictedFiles.length > 0) {
          try {
            // Try simple auto-resolution strategies
            console.log(`   🤖 Attempting simple conflict resolution...`);

            let allResolved = true;
            for (const file of conflictedFiles) {
              try {
                // Read the conflicted file
                const fileContent = safeGitExecSync(`cd "${repoPath}" && cat "${file}"`, {
                  encoding: 'utf8',
                });

                // Check if conflict markers exist
                if (fileContent.includes('<<<<<<<') && fileContent.includes('>>>>>>>')) {
                  // Try to resolve by keeping both changes (for additive conflicts)
                  // This works for imports, new functions, etc.
                  let resolved = fileContent;

                  // Simple resolution: remove conflict markers and keep both versions
                  // This is a basic strategy that works for additive changes
                  const conflictPattern = /<<<<<<< HEAD\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> [^\n]+/g;

                  resolved = resolved.replace(conflictPattern, (_match, head, incoming) => {
                    // Keep both versions (head first, then incoming)
                    // Remove exact duplicates
                    const headLines = head.split('\n').filter((l: string) => l.trim());
                    const incomingLines = incoming.split('\n').filter((l: string) => l.trim());

                    // Combine unique lines
                    const combined = [...headLines];
                    for (const line of incomingLines) {
                      if (!combined.includes(line)) {
                        combined.push(line);
                      }
                    }
                    return combined.join('\n');
                  });

                  // Check if all conflicts were resolved
                  if (!resolved.includes('<<<<<<<') && !resolved.includes('>>>>>>>')) {
                    // Write resolved file
                    const fs = require('fs');
                    fs.writeFileSync(`${repoPath}/${file}`, resolved, 'utf8');
                    console.log(`   ✅ Resolved: ${file}`);
                  } else {
                    console.log(`   ❌ Could not fully resolve: ${file}`);
                    allResolved = false;
                  }
                }
              } catch (fileError: any) {
                console.error(`   ❌ Error resolving ${file}: ${fileError.message}`);
                allResolved = false;
              }
            }

            if (allResolved) {
              console.log(`   ✅ All conflicts resolved automatically!`);

              // Stage resolved files and continue merge
              safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
              safeGitExecSync(
                `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (auto-resolved conflicts)"`,
                { encoding: 'utf8' }
              );

              console.log(`   ✅ Merge completed with auto-resolved conflicts`);

              // Update story status
              story.status = 'completed';
              story.mergedToEpic = true;
              story.mergeConflict = false;
              story.mergeConflictAutoResolved = true;

              const { NotificationService } = await import('../NotificationService');
              NotificationService.emitConsoleLog(
                'system',
                'info',
                `✅ Story "${story.title}" merged with auto-resolved conflicts`
              );

              return; // Success!
            } else {
              console.log(`   ❌ Some conflicts could not be auto-resolved with regex`);
              console.log(`   🤖 Attempting AI-powered conflict resolution...`);

              // 🔥 CALL CONFLICT-RESOLVER AGENT
              if (this.executeAgentFn) {
                try {
                  const aiResolved = await this.resolveConflictsWithAI(
                    taskId,
                    story,
                    epic,
                    repoPath,
                    conflictedFiles,
                    sandboxId // 🐳 Pass sandbox ID for Docker execution
                  );

                  if (aiResolved.success) {
                    console.log(`   ✅ AI resolved all conflicts!`);

                    // Stage and commit
                    safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
                    safeGitExecSync(
                      `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (AI-resolved conflicts)"`,
                      { encoding: 'utf8' }
                    );

                    console.log(`   ✅ Merge completed with AI-resolved conflicts`);

                    story.status = 'completed';
                    story.mergedToEpic = true;
                    story.mergeConflict = false;
                    story.mergeConflictAutoResolved = true;
                    story.mergeConflictResolvedByAI = true;

                    // 🔥 COST TRACKING: Store conflict resolution cost on story
                    story.conflictResolutionCost = aiResolved.cost || 0;
                    story.conflictResolutionUsage = aiResolved.usage || {};

                    const { NotificationService } = await import('../NotificationService');
                    NotificationService.emitConsoleLog(
                      'system',
                      'info',
                      `✅ Story "${story.title}" merged with AI-resolved conflicts (cost: $${aiResolved.cost?.toFixed(4) || 0})`
                    );

                    return; // Success!
                  } else {
                    console.log(`   ❌ AI could not resolve conflicts: ${aiResolved.error}`);
                    // Still track cost even on failure
                    story.conflictResolutionCost = (story.conflictResolutionCost || 0) + (aiResolved.cost || 0);
                  }
                } catch (aiError: any) {
                  console.error(`   ❌ AI resolution failed: ${aiError.message}`);
                }
              } else {
                console.log(`   ⚠️ executeAgentFn not available - cannot use AI resolution`);
              }
            }
          } catch (resolveError: any) {
            console.error(`   ❌ Auto-resolution failed: ${resolveError.message}`);
          }
        }

        // If ALL resolution methods failed, abort merge and mark for manual resolution
        console.log(`   📋 All automatic resolution methods failed - marking for manual resolution...`);
        try {
          safeGitExecSync(`cd "${repoPath}" && git merge --abort`, { encoding: 'utf8' });
          console.log(`   ✅ Aborted conflicted merge`);
        } catch (abortError) {
          console.error(`   ⚠️ Could not abort merge: ${abortError}`);
        }

        // Mark story as having conflict (don't throw - let other stories continue)
        story.mergeConflict = true;
        story.mergeConflictDetails = error.message;
        story.mergeConflictFiles = conflictedFiles;

        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          'system',
          'warn',
          `⚠️  Story "${story.title}" has merge conflicts that require manual resolution`
        );

        return; // Don't throw - let pipeline continue with other stories
      }

      throw error; // Re-throw non-conflict errors
    }
  }

  /**
   * 🤖 Resolve merge conflicts using AI agent
   *
   * Called when simple regex resolution fails. Uses the conflict-resolver agent
   * to intelligently merge conflicting code changes.
   *
   * @returns { success: boolean, cost?: number, usage?: any, error?: string }
   */
  private async resolveConflictsWithAI(
    taskId: string,
    story: any,
    epic: any,
    repoPath: string,
    conflictedFiles: string[],
    sandboxId?: string // 🐳 Explicit sandbox ID for Docker execution
  ): Promise<{ success: boolean; cost?: number; usage?: any; error?: string }> {
    console.log(`\n🤖 [ConflictResolver] Starting AI-powered conflict resolution`);
    console.log(`   Story: ${story.title}`);
    console.log(`   Epic: ${epic.title || epic.id}`);
    console.log(`   Repository: ${repoPath}`);
    console.log(`   Conflicted files: ${conflictedFiles.join(', ')}`);

    if (!this.executeAgentFn) {
      return { success: false, error: 'executeAgentFn not available' };
    }

    // Read the conflicted files to show the agent
    const fs = require('fs');
    const conflictDetails: string[] = [];

    for (const file of conflictedFiles) {
      try {
        const filePath = `${repoPath}/${file}`;
        const content = fs.readFileSync(filePath, 'utf8');
        conflictDetails.push(`\n### File: ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch (readError: any) {
        conflictDetails.push(`\n### File: ${file}\nError reading: ${readError.message}`);
      }
    }

    // Build prompt for conflict-resolver agent
    const prompt = `# Git Merge Conflict Resolution Required

## Context
- **Story**: ${story.title}
- **Story Branch**: ${story.branchName}
- **Epic**: ${epic.title || epic.id}
- **Epic Branch**: ${epic.branchName}
- **Repository Path**: ${repoPath}

## Conflicted Files (${conflictedFiles.length})
${conflictedFiles.map(f => `- ${f}`).join('\n')}

## Current File Contents (with conflict markers)
${conflictDetails.join('\n')}

## Your Task
1. Read each conflicted file carefully
2. Understand what each side (HEAD vs incoming) is trying to do
3. Merge the changes intelligently - keep BOTH sides' functionality when possible
4. Use Edit tool to remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)
5. Ensure the merged code compiles and makes sense

## Important Rules
- KEEP functionality from BOTH sides when possible
- For imports: combine all imports
- For functions: keep both if they have different names, merge if same name
- For types/interfaces: combine fields from both versions
- NEVER leave conflict markers in the file
- Test that the file is valid syntax after resolution

## Output
After resolving ALL conflicts, output:
✅ CONFLICT_RESOLVED

If you cannot resolve a conflict, output:
❌ CONFLICT_UNRESOLVABLE: <reason>`;

    try {
      console.log(`   📝 Calling conflict-resolver agent...`);

      const result = await this.executeAgentFn(
        'conflict-resolver',
        prompt,
        repoPath,  // workspacePath
        taskId,
        'ConflictResolver',
        undefined,  // sessionId
        undefined,  // fork
        undefined,  // attachments
        {
          maxIterations: 10,  // Give it enough iterations to resolve conflicts
          timeout: AGENT_TIMEOUTS.DEFAULT,  // 5 minutes for conflict resolution
          sandboxId, // 🐳 Explicit sandbox ID for Docker execution
        }
      );

      console.log(`   ✅ Agent completed`);
      console.log(`   💰 Cost: $${result.cost?.toFixed(4) || 0}`);
      console.log(`   📊 Tokens: ${(result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0)}`);

      // Check if agent reported success
      const output = result.output || '';
      if (output.includes('CONFLICT_RESOLVED') || output.includes('✅')) {
        // Verify no conflict markers remain in any file
        let allResolved = true;
        for (const file of conflictedFiles) {
          try {
            const filePath = `${repoPath}/${file}`;
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
              console.log(`   ⚠️ File ${file} still has conflict markers`);
              allResolved = false;
            }
          } catch (verifyError) {
            // File might have been deleted/moved, that's OK
          }
        }

        if (allResolved) {
          return {
            success: true,
            cost: result.cost,
            usage: result.usage,
          };
        } else {
          return {
            success: false,
            cost: result.cost,
            usage: result.usage,
            error: 'Agent reported success but conflict markers remain',
          };
        }
      } else if (output.includes('CONFLICT_UNRESOLVABLE') || output.includes('❌')) {
        const reason = output.match(/CONFLICT_UNRESOLVABLE:\s*(.+)/)?.[1] || 'Unknown reason';
        return {
          success: false,
          cost: result.cost,
          usage: result.usage,
          error: reason,
        };
      } else {
        // Ambiguous output - check files directly
        let allResolved = true;
        for (const file of conflictedFiles) {
          try {
            const filePath = `${repoPath}/${file}`;
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
              allResolved = false;
              break;
            }
          } catch (verifyError) {
            // Continue checking other files
          }
        }

        return {
          success: allResolved,
          cost: result.cost,
          usage: result.usage,
          error: allResolved ? undefined : 'Conflict markers still present',
        };
      }
    } catch (agentError: any) {
      console.error(`   ❌ Agent error: ${agentError.message}`);
      return {
        success: false,
        error: agentError.message,
      };
    }
  }
}
