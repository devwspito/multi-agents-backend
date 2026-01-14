import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { ITeamMember } from '../../models/Task';
import { DependencyResolver } from '../dependencies/DependencyResolver';
import { ConservativeDependencyPolicy } from '../dependencies/ConservativeDependencyPolicy';
import { LogService } from '../logging/LogService';
import { HookService } from '../HookService';
import { safeGitExecSync, fixGitRemoteAuth } from '../../utils/safeGitExecution';
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';
import { ProactiveIssueDetector } from '../ProactiveIssueDetector';

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

  constructor(
    private executeDeveloperFn: Function,
    private executeAgentFn?: Function // For Judge execution (optional for backward compatibility)
  ) {
    super();
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
   * Skip if developers already completed all stories (ONLY for recovery, NOT for continuations)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute to implement new stories
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [Developers] This is a CONTINUATION - will re-execute to implement new stories`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    const team = context.task.orchestration.team || [];
    // Get stories from Project Manager (not epics from Tech Lead)
    const stories = context.task.orchestration.projectManager?.stories || [];
    const epics = stories; // Alias for backward compatibility

    // If team exists and has members, AND all epics/stories are completed, skip
    if (team.length > 0 && epics.length > 0) {
      const allEpicsCompleted = epics.every((epic: any) => epic.status === 'completed');

      if (allEpicsCompleted) {
        console.log(`[SKIP] Developers already completed - all ${epics.length} stories done (recovery mode)`);

        // Restore phase data
        context.setData('developmentTeam', team);
        context.setData('developmentComplete', true);
        context.setData('epicExecutionOrder', epics.map((e: any) => e.id));

        return true;
      }
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // Initialize cost tracking
    let totalDeveloperCost = 0;
    let totalJudgeCost = 0;
    let totalConflictResolutionCost = 0;
    let totalDeveloperTokens = { input: 0, output: 0 };
    let totalJudgeTokens = { input: 0, output: 0 };
    let totalConflictResolutionTokens = { input: 0, output: 0 };

    // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
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

    try {
      // 🔥 EVENT SOURCING: Rebuild state from events
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task._id as any);

      console.log(`📝 [Developers] Rebuilt state from events: ${state.epics.length} epics, ${state.stories.length} stories`);

      // Validate state
      const validation = await eventStore.validateState(task._id as any);
      if (!validation.valid) {
        console.error('❌ CRITICAL: State validation failed:');
        validation.errors.forEach(err => console.error(`  - ${err}`));

        // 🔥 CRITICAL: Emit completion event to prevent infinite loop
        await eventStore.append({
          taskId: task._id as any,
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
        await eventStore.append({
          taskId: task._id as any,
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

        // Mark task as failed
        const Task = require('../../models/Task').Task;
        const dbTask = await Task.findById(task._id);
        if (dbTask) {
          dbTask.status = 'failed';
          dbTask.orchestration.developers = {
            status: 'failed',
            error: `${invalidEpics.length} epic(s) have no targetRepository - cannot determine which repo to work in`,
            humanRequired: true,
            invalidEpics: invalidEpics.map((e: any) => ({ id: e.id, name: e.name })),
          };
          await dbTask.save();
        }

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
          epicId: epic.id,
          epicName: epic.name,
          metadata: { executionOrder: i + 1, targetRepo: repo },
        });
      }

      // Build team
      const team: ITeamMember[] = [];
      // const allStories = epics.flatMap((e: any) =>
      //   e.stories.map((storyId: string) => ({ storyId, epicId: e.id }))
      // ); // unused

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

      // Save team to task (skip in multi-team mode to avoid version conflicts)
      if (!multiTeamMode) {
        task.orchestration.team = team;
        await task.save();
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
        await LogService.info(`Epic execution started: ${epic.name}`, {
          taskId,
          category: 'epic',
          phase: 'development',
          epicId: epic.id,
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
        console.log(`\n🔍 [DEBUG] Epic "${epic.name}" (${epic.id}):`);
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
            epicId: epic.id,
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
          epicId: epic.id,
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

            console.log(`\n${'='.repeat(80)}`);
            console.log(`🚀 [STORY ${storyNumber}/${totalStories}] Starting pipeline: ${story.title}`);
            console.log(`   Story ID: ${storyId}`);
            console.log(`   Developer: ${member.instanceId}`);
            console.log(`   Epic: ${epic.name}`);
            console.log(`   Branch strategy: Story will start from epic branch (includes ${storyNumber - 1} previous stories)`);
            console.log(`${'='.repeat(80)}`);

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

            // Accumulate costs and tokens
            if (costs) {
              totalDeveloperCost += costs.developerCost;
              totalJudgeCost += costs.judgeCost;
              totalConflictResolutionCost += costs.conflictResolutionCost || 0;
              totalDeveloperTokens.input += costs.developerTokens?.input || 0;
              totalDeveloperTokens.output += costs.developerTokens?.output || 0;
              totalJudgeTokens.input += costs.judgeTokens?.input || 0;
              totalJudgeTokens.output += costs.judgeTokens?.output || 0;
              totalConflictResolutionTokens.input += costs.conflictResolutionUsage?.input_tokens || 0;
              totalConflictResolutionTokens.output += costs.conflictResolutionUsage?.output_tokens || 0;

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
          epicId: epic.id,
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

      // 🔥 EVENT SOURCING: Emit completion event (SUCCESS CASE)
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'DevelopersCompleted',
        agentName: 'developer',
        payload: {
          developersCount: team.length,
          storiesImplemented: team.reduce((sum, m) => sum + m.assignedStories.length, 0),
          epicsCount: orderedEpics.length,
        },
      });

      console.log(`📝 [Developers] Emitted DevelopersCompleted event (success)`);

      // Log cost summary
      console.log(`\n💰 Development Phase Cost Summary:`);
      console.log(`   Developers total: $${totalDeveloperCost.toFixed(4)} (${totalDeveloperTokens.input + totalDeveloperTokens.output} tokens)`);
      console.log(`   Judge total: $${totalJudgeCost.toFixed(4)} (${totalJudgeTokens.input + totalJudgeTokens.output} tokens)`);
      if (totalConflictResolutionCost > 0) {
        console.log(`   Conflict Resolution: $${totalConflictResolutionCost.toFixed(4)} (${totalConflictResolutionTokens.input + totalConflictResolutionTokens.output} tokens)`);
      }
      console.log(`   Phase total: $${(totalDeveloperCost + totalJudgeCost + totalConflictResolutionCost).toFixed(4)}`);

      // 🔥 COST TRACKING: Save costs to task.orchestration (for handleOrchestrationComplete)
      if (!multiTeamMode) {
        // Update team with costs (members already have cost_usd/usage from loop above)
        task.orchestration.team = team;

        // Initialize judge if not exists
        if (!task.orchestration.judge) {
          task.orchestration.judge = {
            agent: 'judge',
            status: 'completed',
            evaluations: [],
          } as any;
        }
        task.orchestration.judge!.cost_usd = totalJudgeCost;
        task.orchestration.judge!.usage = {
          input_tokens: totalJudgeTokens.input,
          output_tokens: totalJudgeTokens.output,
        };

        // Accumulate to total cost (includes conflict resolution)
        task.orchestration.totalCost = (task.orchestration.totalCost || 0) + totalDeveloperCost + totalJudgeCost + totalConflictResolutionCost;

        await task.save();
        console.log(`✅ [Developers] Costs saved to task.orchestration`);
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
          cost: totalDeveloperCost,  // Main phase cost (developers)
          judgeCost: totalJudgeCost,  // Additional judge cost to track separately
          input_tokens: totalDeveloperTokens.input,
          output_tokens: totalDeveloperTokens.output,
          judge_input_tokens: totalJudgeTokens.input,
          judge_output_tokens: totalJudgeTokens.output,
        },
      };
    } catch (error: any) {
      console.error(`❌ [Developers] Critical error: ${error.message}`);
      console.error(error.stack);

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
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
    const taskId = (task._id as any).toString();
    const fs = require('fs');
    const { execSync } = require('child_process');

    // 🔥🔥🔥 ISOLATED STORY WORKSPACE 🔥🔥🔥
    // Each DEV+JUDGE pair gets its own copy of the repository
    // This prevents git conflicts when multiple stories are worked on in parallel
    const storyWorkspacePath = workspacePath ? `${workspacePath}/story-${story.id}` : null;

    if (storyWorkspacePath && epic.targetRepository) {
      const isolatedRepoPath = `${storyWorkspacePath}/${epic.targetRepository}`;
      const sourceRepoPath = `${workspacePath}/${epic.targetRepository}`;

      console.log(`\n🔒🔒🔒 [Story ${story.id}] CREATING ISOLATED WORKSPACE 🔒🔒🔒`);
      console.log(`   📁 Source repo: ${sourceRepoPath}`);
      console.log(`   📁 Story workspace: ${storyWorkspacePath}`);
      console.log(`   📁 Isolated repo: ${isolatedRepoPath}`);
      console.log(`   👨‍💻 Developer: ${developer.instanceId}`);
      console.log(`   ⚖️  Judge will review in SAME isolated workspace`);

      // Create story workspace directory
      if (!fs.existsSync(storyWorkspacePath)) {
        fs.mkdirSync(storyWorkspacePath, { recursive: true });
        console.log(`   ✅ Created story workspace directory`);
      }

      // Copy repository to isolated workspace (if not already copied)
      if (!fs.existsSync(isolatedRepoPath)) {
        if (!fs.existsSync(sourceRepoPath)) {
          console.error(`   ❌ Source repository not found: ${sourceRepoPath}`);
          throw new Error(`Source repository not found for story ${story.id}: ${sourceRepoPath}`);
        }

        console.log(`   📋 Copying repository to isolated workspace...`);
        execSync(`cp -r "${sourceRepoPath}" "${isolatedRepoPath}"`, { encoding: 'utf8' });
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
      } else {
        console.log(`   ℹ️  Isolated workspace already exists`);
      }

      console.log(`🔒🔒🔒 [Story ${story.id}] ISOLATED WORKSPACE READY 🔒🔒🔒\n`);
    }

    // 🔥 Use isolated story workspace for ALL operations in this pipeline
    const effectiveWorkspacePath = storyWorkspacePath || workspacePath;

    // 🔥 CRITICAL VALIDATION: Epic MUST have targetRepository
    if (!epic.targetRepository) {
      console.error(`\n❌❌❌ [PIPELINE] CRITICAL ERROR: Epic has NO targetRepository!`);
      console.error(`   Epic: ${epic.name}`);
      console.error(`   Epic ID: ${epic.id}`);
      console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THIS EPIC BELONGS TO`);
      console.error(`   💀 CANNOT EXECUTE DEVELOPER - WOULD BE ARBITRARY`);
      console.error(`\n   🛑 STOPPING PIPELINE - HUMAN INTERVENTION REQUIRED`);

      // Mark task as FAILED
      const Task = require('../../models/Task').Task;
      const dbTask = await Task.findById(task._id);
      if (dbTask) {
        dbTask.status = 'failed';
        dbTask.orchestration.developers = {
          status: 'failed',
          error: `Epic ${epic.id} has no targetRepository - cannot determine which repo to work in`,
          humanRequired: true,
        };
        await dbTask.save();
      }

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

      // Mark task as FAILED
      const Task = require('../../models/Task').Task;
      const dbTask = await Task.findById(task._id);
      if (dbTask) {
        dbTask.status = 'failed';
        dbTask.orchestration.developers = {
          status: 'failed',
          error: `Story ${story.id} has no targetRepository - data integrity issue`,
          humanRequired: true,
        };
        await dbTask.save();
      }

      throw new Error(`HUMAN_REQUIRED: Story ${story.id} has no targetRepository`);
    }

    // 🔥 SUCCESS: We know EXACTLY where to work
    console.log(`✅ [PIPELINE] Repository assignment validated:`);
    console.log(`   Epic: ${epic.name} → ${epic.targetRepository}`);
    console.log(`   Story: ${story.title} → ${story.targetRepository}`);

    try {
      // STEP 1: Developer implements story
      console.log(`\n👨‍💻 [STEP 1/3] Developer ${developer.instanceId} implementing story...`);

      // 🔥 CRITICAL: Get epic branch name from context (created by TeamOrchestrationPhase)
      const epicBranchName = context.getData<string>('epicBranch');
      console.log(`📂 [DevelopersPhase] Passing epic branch to developer: ${epicBranchName || 'not specified'}`);

      // 🔐 Get devAuth from context (for testing authenticated endpoints)
      const devAuth = context.getData<any>('devAuth');

      // 🏗️ Get architectureBrief from context (patterns, conventions, models from PlanningPhase)
      const architectureBrief = context.getData<any>('architectureBrief');
      if (architectureBrief) {
        console.log(`🏗️ [DevelopersPhase] Architecture brief available - developer will follow project patterns`);
      }

      // 🔧 Get environmentCommands from context (test, lint, typecheck, etc. from TechLead)
      const environmentCommands = context.getData<any>('environmentCommands');
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
        (task._id as any).toString(),
        'info',
        `👨‍💻 Developer ${developer.instanceId} starting: "${story.title}"`
      );

      // 🔄 CHECKPOINT: Create rollback point before developer execution
      const { rollbackService } = await import('../RollbackService');
      const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      const checkpoint = await rollbackService.createCheckpoint(
        repoPath,
        (task._id as any).toString(),
        `Before ${developer.instanceId}: ${story.title}`,
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: developer.instanceId,
          storyId: story.id,
          storyTitle: story.title,
          epicId: epic.id,
          epicName: epic.name,
        }
      );
      if (checkpoint) {
        console.log(`🔄 [CHECKPOINT] Created: ${checkpoint.id} (${checkpoint.commitHash.substring(0, 7)})`);
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
        environmentCommands // 🔧 Environment commands from TechLead (dynamic verification)
      );

      // Track developer cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };
      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)} (${developerTokens.input + developerTokens.output} tokens)`);
        NotificationService.emitConsoleLog(
          (task._id as any).toString(),
          'info',
          `✅ Developer ${developer.instanceId} finished: "${story.title}" ($${developerCost.toFixed(4)})`
        );
      }

      // 🔥 CRITICAL: Wait for git push to fully complete on remote
      // Developer agent may have finished but push still propagating
      console.log(`⏳ [PIPELINE] Waiting 3 seconds for git push to propagate to remote...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(`✅ [PIPELINE] Wait complete - proceeding to verification`);

      // Verify story has branch
      const updatedState = await (await import('../EventStore')).eventStore.getCurrentState(task._id as any);
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
      // Instead: Check git FIRST - if commits exist, ACCEPT the work
      const developerOutput = developerResult?.output || '';

      // Check for explicit failure marker (this is the ONLY marker we strictly require)
      const explicitlyFailed = hasMarker(developerOutput, COMMON_MARKERS.FAILED);

      if (explicitlyFailed) {
        console.error(`❌ [PIPELINE] Developer explicitly reported FAILURE`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Developer output (last 500 chars):\n${developerOutput.slice(-500)}`);
        return {
          developerCost,
          judgeCost: 0,
          conflictResolutionCost: 0,
          developerTokens,
          judgeTokens: { input: 0, output: 0 },
          conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
        };
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
              timeout: 90000
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

          // 🔥🔥🔥 FORCE PUSH VERIFICATION: Ensure commit is on remote 🔥🔥🔥
          // Developer MUST push their work - this is mandatory, not optional
          console.log(`\n📤 [FORCE PUSH CHECK] Verifying commit ${commitSHA.substring(0, 8)} is on remote...`);
          try {
            const branchOnRemote = safeGitExecSync(
              `git ls-remote origin refs/heads/${storyBranch}`,
              { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
            );

            if (!branchOnRemote || branchOnRemote.trim() === '') {
              // Branch not on remote - FORCE PUSH IT
              console.log(`   ⚠️ Branch ${storyBranch} NOT on remote - pushing now...`);
              safeGitExecSync(`git push -u origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: 60000 });
              console.log(`   ✅ Branch pushed to remote`);
            } else {
              // Branch on remote - verify commit is there
              const remoteCommit = branchOnRemote.split('\t')[0];
              if (remoteCommit === commitSHA) {
                console.log(`   ✅ Commit ${commitSHA.substring(0, 8)} confirmed on remote`);
              } else {
                console.log(`   ⚠️ Remote has different commit (${remoteCommit.substring(0, 8)}) - pushing latest...`);
                safeGitExecSync(`git push origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: 60000 });
                console.log(`   ✅ Latest commit pushed to remote`);
              }
            }
          } catch (pushCheckErr: any) {
            console.warn(`   ⚠️ Push verification failed: ${pushCheckErr.message}`);
            console.warn(`   Attempting force push...`);
            try {
              safeGitExecSync(`git push -u origin ${storyBranch} --force-with-lease`, { cwd: repoPath, encoding: 'utf8', timeout: 60000 });
              console.log(`   ✅ Force push succeeded`);
            } catch (forcePushErr: any) {
              console.error(`   ❌ Force push failed: ${forcePushErr.message}`);
              // Continue anyway - Judge will try to fetch
            }
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
          console.error(`\n❌ [PIPELINE] Developer did NOT complete work!`);
          console.error(`   Story: ${story.title}`);
          console.error(`   NO commits found on git AND no FINISHED marker in output`);
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
            { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
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

          // Fetch all branches from remote
          console.log(`   [1/3] Fetching from remote...`);
          safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: 90000 });
          console.log(`   ✅ Fetched latest refs from remote`);

          // 🔥 NEW: Verify branch exists on remote BEFORE attempting checkout
          console.log(`\n🔍 [PRE-CHECKOUT] Verifying branch exists on remote...`);
          console.log(`   Branch: ${updatedStory.branchName}`);
          console.log(`   This is the EXACT branch Developer worked on`);

          const lsRemoteBranches = safeGitExecSync(
            `git ls-remote --heads origin ${updatedStory.branchName}`,
            { cwd: repoPath, encoding: 'utf8', timeout: 10000 }
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
                // Re-fetch to get latest refs
                safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: 90000 });
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
        await this.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId);

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
                timeout: 15000 // 15 seconds timeout
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
      } else {
        // Judge REJECTED - keep branch for investigation
        console.error(`❌ [STEP ${iteration}/${maxRetries}] Judge REJECTED story: ${story.title}`);
        console.error(`   Feedback: ${judgeResult.data?.feedback || judgeResult.error}`);
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
        const taskId = (task._id as any).toString();
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Story rejected by Judge: ${story.title}\nBranch: ${updatedStory.branchName}\nFeedback: ${feedback}`
        );
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

  /**
   * Review a story branch with Judge
   * Returns true if approved, false if changes requested
   * @deprecated - Not currently used, retained for future functionality
   */
  // @ts-ignore - Unused method retained for future functionality
  private async _reviewStoryBranch(
    story: any,
    task: any,
    workspacePath: string | null,
    context: OrchestrationContext
  ): Promise<boolean> {
    console.log(`\n⚖️  [Judge] Reviewing story branch: ${story.branchName}`);
    console.log(`   Story: ${story.title}`);

    try {
      // 🔥 CRITICAL: Checkout story branch so Judge can see the developer's code
      if (workspacePath && story.branchName) {
        const repositories = context.repositories;
        const targetRepo = repositories.length > 0 ? repositories[0] : null;
        if (targetRepo) {
          const repoPath = `${workspacePath}/${targetRepo.name}`;
          console.log(`🔀 [Judge] Checking out branch ${story.branchName} in ${repoPath}`);

          try {
            safeGitExecSync(`git checkout ${story.branchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [Judge] Successfully checked out ${story.branchName}`);
          } catch (error: any) {
            console.error(`❌ [Judge] Failed to checkout ${story.branchName}: ${error.message}`);
            // Continue anyway - Judge might still be on correct branch
          }
        }
      }

      // Import JudgePhase
      const { JudgePhase } = await import('./JudgePhase');
      const { NotificationService } = await import('../NotificationService');

      // Create isolated context for Judge with only this story
      const judgeContext = new OrchestrationContext(
        task,
        context.repositories,
        workspacePath
      );

      // Pass only this story for review
      judgeContext.setData('storyToReview', story);
      judgeContext.setData('reviewMode', 'single-story'); // Signal Judge to review one story

      // 🔥 CRITICAL: Pass development team so Judge can find the developer who worked on this story
      judgeContext.setData('developmentTeam', context.getData('developmentTeam'));

      // 🔥 CRITICAL: Pass executeDeveloperFn so Judge can retry failed stories
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);

      // Execute Judge phase
      if (!this.executeAgentFn) {
        throw new Error('executeAgentFn is required for Judge evaluation');
      }

      const judgePhase = new JudgePhase(this.executeAgentFn); // Judge needs executeAgent, not executeDeveloper
      const result = await judgePhase.execute(judgeContext);

      if (result.success && result.data?.status === 'approved') {
        console.log(`✅ [Judge] Story ${story.id} APPROVED`);
        NotificationService.emitConsoleLog(
          (task._id as any).toString(),
          'info',
          `✅ Judge APPROVED story: ${story.title}`
        );
        return true;
      } else {
        console.log(`❌ [Judge] Story ${story.id} REJECTED`);
        console.log(`   Feedback: ${result.data?.feedback || result.error || 'No feedback provided'}`);
        NotificationService.emitConsoleLog(
          (task._id as any).toString(),
          'warn',
          `❌ Judge REJECTED story: ${story.title}\nFeedback: ${result.data?.feedback || result.error}`
        );
        return false;
      }
    } catch (error: any) {
      console.error(`❌ [Judge] Error reviewing story ${story.id}: ${error.message}`);
      return false; // On error, don't merge
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
    taskId: string
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
      console.log(`\n[STEP 2/4] Pulling latest changes from remote...`);
      try {
        const pullOutput = safeGitExecSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, {
          encoding: 'utf8',
          timeout: 90000, // 90 seconds for pull (network operation)
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
              timeout: 90000 // 90 seconds (network operation)
            }
          );
          console.log(`✅ [Merge] PUSH SUCCESSFUL: ${epicBranch} pushed to remote`);
          console.log(`   Git push output:\n${pushOutput}`);
          pushSucceeded = true;
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
                    conflictedFiles
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
    conflictedFiles: string[]
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
          timeout: 180000,    // 3 minutes
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
