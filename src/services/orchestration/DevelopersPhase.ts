import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { ITeamMember } from '../../models/Task';
import { DependencyResolver } from '../dependencies/DependencyResolver';
import { ConservativeDependencyPolicy } from '../dependencies/ConservativeDependencyPolicy';
import { LogService } from '../logging/LogService';

/**
 * Developers Phase
 *
 * Manages development team execution with multi-repo support
 * - Applies conservative dependency policy for cross-repo safety
 * - Resolves epic execution order based on dependencies
 * - Spawns multiple developers based on team composition
 * - Executes epics in dependency order (sequential for cross-repo safety)
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
   * Skip if developers already completed all stories
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const team = context.task.orchestration.team || [];
    // Get stories from Project Manager (not epics from Tech Lead)
    const stories = context.task.orchestration.projectManager?.stories || [];
    const epics = stories; // Alias for backward compatibility

    // If team exists and has members, AND all epics/stories are completed, skip
    if (team.length > 0 && epics.length > 0) {
      const allEpicsCompleted = epics.every((epic: any) => epic.status === 'completed');

      if (allEpicsCompleted) {
        console.log(`[SKIP] Developers already completed - all ${epics.length} stories done`);

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
    let totalDeveloperTokens = { input: 0, output: 0 };
    let totalJudgeTokens = { input: 0, output: 0 };

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

    await LogService.info('Development Team phase started - Spawning team members', {
      taskId,
      category: 'orchestration',
      phase: 'development',
    });

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
            targetRepo: e.targetRepository || repositories[0]?.full_name || repositories[0]?.name || 'default',
          })),
        },
      });

      // Log each epic in execution order
      for (let i = 0; i < orderedEpics.length; i++) {
        const epic = orderedEpics[i];
        const repo = epic.targetRepository || repositories[0]?.full_name || repositories[0]?.name || 'default';
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

        team.push({
          agentType,
          instanceId,
          assignedStories,
          status: 'idle',
          pullRequests: [],
        });
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

            // Execute complete isolated story pipeline
            const costs = await this.executeIsolatedStoryPipeline(
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
            );

            // Accumulate costs and tokens
            if (costs) {
              totalDeveloperCost += costs.developerCost;
              totalJudgeCost += costs.judgeCost;
              totalDeveloperTokens.input += costs.developerTokens?.input || 0;
              totalDeveloperTokens.output += costs.developerTokens?.output || 0;
              totalJudgeTokens.input += costs.judgeTokens?.input || 0;
              totalJudgeTokens.output += costs.judgeTokens?.output || 0;
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
      console.log(`   Phase total: $${(totalDeveloperCost + totalJudgeCost).toFixed(4)}`);

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
   * Execute isolated story pipeline: 1 Story = 1 Dev + 1 Judge + 1 QA + 1 Fixer
   * Each story works in the SAME workspace (no checkout conflicts)
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
    developerTokens: { input: number; output: number };
    judgeTokens: { input: number; output: number };
  }> {
    const taskId = (task._id as any).toString();

    try {
      // STEP 1: Developer implements story
      console.log(`\n👨‍💻 [STEP 1/3] Developer ${developer.instanceId} implementing story...`);

      // 🔥 CRITICAL: Get epic branch name from context (created by TeamOrchestrationPhase)
      const epicBranchName = context.getData<string>('epicBranch');
      console.log(`📂 [DevelopersPhase] Passing epic branch to developer: ${epicBranchName || 'not specified'}`);

      const developerResult = await this.executeDeveloperFn(
        task,
        developer,
        repositories,
        workspacePath,
        workspaceStructure,
        attachments,
        state.stories,
        state.epics,
        undefined, // judgeFeedback
        epicBranchName // Epic branch name from TeamOrchestrationPhase
      );

      // Track developer cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };
      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)} (${developerTokens.input + developerTokens.output} tokens)`);
      }

      // Verify story has branch
      const updatedState = await (await import('../EventStore')).eventStore.getCurrentState(task._id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      if (!updatedStory || !updatedStory.branchName) {
        console.error(`❌ [PIPELINE] Story ${story.id} has no branch after developer - FAILED`);
        return {
          developerCost: 0,
          judgeCost: 0,
          developerTokens: { input: 0, output: 0 },
          judgeTokens: { input: 0, output: 0 }
        };
      }

      // 🔥 CRITICAL FIX: Extract commit SHA from Developer's output
      // Following Anthropic best practice: "subagents should verify details"
      // Developer REPORTS their commit SHA, we don't guess it
      let commitSHA: string | null = null;

      if (developerResult?.output) {
        // Look for pattern: "📍 Commit SHA: abc123def456..."
        const commitMatch = developerResult.output.match(/📍\s*Commit SHA:\s*([a-f0-9]{40})/i);
        if (commitMatch && commitMatch[1]) {
          commitSHA = commitMatch[1];
          console.log(`✅ [PIPELINE] Developer reported commit SHA: ${commitSHA}`);
          console.log(`   Branch: ${updatedStory.branchName}`);
          console.log(`   This is the EXACT code Judge will review`);
        } else {
          console.warn(`⚠️  [PIPELINE] Developer did NOT report commit SHA in output`);
          console.warn(`   Developer output length: ${developerResult.output.length} chars`);
          console.warn(`   Searching output for commit SHA...`);
        }
      }

      // Fallback: Try to get commit SHA from git (old way - not recommended)
      if (!commitSHA) {
        console.warn(`⚠️  [PIPELINE] Falling back to git rev-parse HEAD (NOT RECOMMENDED)`);
        const { execSync } = require('child_process');
        const targetRepo = repositories.length > 0 ? repositories[0] : null;
        if (!targetRepo || !workspacePath) {
          console.error(`❌ [PIPELINE] No repository or workspace for commit verification`);
          console.error(`   Judge CANNOT review without commit SHA - STOPPING`);
          return {
            developerCost: 0,
            judgeCost: 0,
            developerTokens: { input: 0, output: 0 },
            judgeTokens: { input: 0, output: 0 }
          };
        }

        const repoPath = `${workspacePath}/${targetRepo.name}`;
        try {
          commitSHA = execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
          console.log(`📍 [PIPELINE] Fallback commit SHA from git: ${commitSHA}`);
        } catch (error: any) {
          console.error(`❌ [PIPELINE] Failed to get commit SHA: ${error.message}`);
          console.error(`   Judge CANNOT review without commit SHA - STOPPING`);
          return {
            developerCost: 0,
            judgeCost: 0,
            developerTokens: { input: 0, output: 0 },
            judgeTokens: { input: 0, output: 0 }
          };
        }
      }

      // STEP 2: Judge reviews code (in SAME workspace, SAME branch, EXACT commit)
      console.log(`\n⚖️  [STEP 2/3] Judge reviewing EXACT commit:`);
      console.log(`   Commit SHA: ${commitSHA}`);
      console.log(`   Branch: ${updatedStory.branchName}`);
      console.log(`   Workspace: ${workspacePath}`);
      console.log(`   If Judge fails to access this commit → Pipeline STOPS`);

      // Create isolated context for Judge
      const judgeContext = new OrchestrationContext(task, repositories, workspacePath);
      judgeContext.setData('storyToReview', updatedStory);
      judgeContext.setData('reviewMode', 'single-story');
      judgeContext.setData('developmentTeam', [developer]); // Only this developer
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);
      judgeContext.setData('commitSHA', commitSHA); // 🔥 CRITICAL: Exact commit to review

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

      if (judgeResult.success && judgeResult.data?.status === 'approved') {
        console.log(`✅ [STEP 2/3] Judge APPROVED story: ${story.title}`);

        // STEP 3: Merge to epic branch
        console.log(`\n🔀 [STEP 3/3] Merging approved story to epic branch...`);
        await this.mergeStoryToEpic(updatedStory, epic, workspacePath, repositories);

        // 🧹 CLEANUP: Delete story branch after successful merge
        // ✅ ONLY if Judge APPROVED - rejected stories keep their branches for investigation
        // Story is now part of epic branch, no need to keep individual story branch
        if (workspacePath && repositories.length > 0) {
          try {
            const { execSync } = require('child_process');
            const targetRepo = repositories[0];
            const repoPath = `${workspacePath}/${targetRepo.name || targetRepo.full_name}`;
            const storyBranch = updatedStory.branchName;

            execSync(`cd "${repoPath}" && git branch -D ${storyBranch}`, { encoding: 'utf8' });
            console.log(`🧹 Cleaned up story branch: ${storyBranch} (already merged to epic)`);
          } catch (cleanupError: any) {
            // Non-critical error - branch might not exist or already deleted
            console.warn(`⚠️  Could not cleanup story branch: ${cleanupError.message}`);
          }
        }

        console.log(`✅ [PIPELINE] Story pipeline completed successfully: ${story.title}`);
      } else {
        // Judge REJECTED - keep branch for investigation
        console.error(`❌ [STEP 2/3] Judge REJECTED story: ${story.title}`);
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

      return {
        developerCost,
        judgeCost,
        developerTokens,
        judgeTokens
      };

    } catch (error: any) {
      console.error(`❌ [PIPELINE] Story pipeline failed for ${story.id}: ${error.message}`);
      return {
        developerCost: 0,
        judgeCost: 0,
        developerTokens: { input: 0, output: 0 },
        judgeTokens: { input: 0, output: 0 }
      };
    }
  }

  /**
   * Review a story branch with Judge
   * Returns true if approved, false if changes requested
   */
  private async reviewStoryBranch(
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
          const { execSync } = require('child_process');
          const repoPath = `${workspacePath}/${targetRepo.name}`;
          console.log(`🔀 [Judge] Checking out branch ${story.branchName} in ${repoPath}`);

          try {
            execSync(`git checkout ${story.branchName}`, { cwd: repoPath, encoding: 'utf8' });
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
    repositories: any[]
  ): Promise<void> {
    console.log(`\n🔀 [Merge] Merging story branch → epic branch`);
    console.log(`   From: ${story.branchName}`);
    console.log(`   To: epic/${epic.id}`);

    if (!workspacePath) {
      console.error(`❌ [Merge] No workspace path available`);
      throw new Error('Workspace path required for merge');
    }

    try {
      const { execSync } = require('child_process');
      const { NotificationService } = await import('../NotificationService');

      // Get target repository
      const targetRepo = epic.targetRepository || repositories[0]?.name || repositories[0]?.full_name;
      const repoPath = `${workspacePath}/${targetRepo}`;
      // 🔥 CRITICAL: Use the unique branch name from epic, NOT a generic one
      const epicBranch = epic.branchName || `epic/${epic.id}-fallback`;

      console.log(`📂 [Merge] Repository: ${targetRepo}`);
      console.log(`📂 [Merge] Path: ${repoPath}`);

      // 1. Checkout epic branch
      execSync(`cd "${repoPath}" && git checkout ${epicBranch}`, { encoding: 'utf8' });
      console.log(`✅ [Merge] Checked out ${epicBranch}`);

      // 2. Pull latest changes from epic branch
      try {
        execSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, { encoding: 'utf8' });
        console.log(`✅ [Merge] Pulled latest changes from ${epicBranch}`);
      } catch (pullError) {
        console.warn(`⚠️  [Merge] Pull failed (branch might not exist on remote yet)`);
      }

      // 3. Merge story branch
      const mergeOutput = execSync(
        `cd "${repoPath}" && git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`,
        { encoding: 'utf8' }
      );
      console.log(`✅ [Merge] Merged ${story.branchName} → ${epicBranch}`);
      console.log(`   Output: ${mergeOutput.substring(0, 200)}...`);

      // 4. Push epic branch
      execSync(`cd "${repoPath}" && git push origin ${epicBranch}`, { encoding: 'utf8' });
      console.log(`✅ [Merge] Pushed ${epicBranch} to remote`);

      NotificationService.emitConsoleLog(
        'system', // No task ID in this context
        'info',
        `🔀 Merged story ${story.title} → ${epicBranch}`
      );

      // 5. Update story status
      story.mergedToEpic = true;
      story.mergedAt = new Date();

      console.log(`\n✅ [Merge] Story ${story.id} successfully merged to epic branch!\n`);
    } catch (error: any) {
      console.error(`❌ [Merge] Failed to merge story ${story.id}: ${error.message}`);

      // Check if it's a merge conflict
      if (error.message.includes('CONFLICT') || error.message.includes('Recorded preimage')) {
        console.error(`🔥 [Merge] MERGE CONFLICT detected!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Branch: ${story.branchName}`);
        console.error(`   Epic: epic/${epic.id}`);
        console.error(`\n   📋 ACTION REQUIRED:`);
        console.error(`   1. This story modifies files that were changed in another story`);
        console.error(`   2. Aborting merge and marking story for manual resolution`);
        console.error(`   3. Story will NOT block other stories in the epic`);

        // Abort the conflicted merge
        try {
          const { execSync } = require('child_process');
          const targetRepo = epic.targetRepository || repositories[0]?.name || repositories[0]?.full_name;
          const repoPath = `${workspacePath}/${targetRepo}`;
          execSync(`cd "${repoPath}" && git merge --abort`, { encoding: 'utf8' });
          console.log(`✅ [Merge] Aborted conflicted merge`);
        } catch (abortError) {
          console.error(`⚠️  Could not abort merge: ${abortError}`);
        }

        // Mark story as having conflict (don't throw - let other stories continue)
        story.mergeConflict = true;
        story.mergeConflictDetails = error.message;

        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          'system',
          'warn',
          `⚠️  Story "${story.title}" has merge conflicts - marked for manual resolution`
        );

        return; // Don't throw - let pipeline continue with other stories
      }

      throw error; // Re-throw non-conflict errors
    }
  }
}
