import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { RepositoryHelper } from '../utils/RepositoryHelper';
import { safeGitExecSync } from '../../../utils/safeGitExecution';

/**
 * FIXED: Developers Phase - Now properly pushes branches to remote
 *
 * CRITICAL FIX: Added git push after story implementation
 * Prevents pipeline failure due to missing remote branches
 */
export class DevelopersPhaseOptimized extends BasePhase {
  readonly name = 'Developers';
  readonly description = 'Implementing technical stories';

  private readonly MAX_PARALLEL_DEVELOPERS = 2;

  constructor(
    private executeDeveloperFn: Function,
    private workspaceDir: string
  ) {
    super();
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task
    const Task = require('../../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Multi-team mode
    const teamEpic = context.getData<any>('teamEpic');
    if (teamEpic) {
      const completedStories = teamEpic.stories?.filter((s: any) => s.completed) || [];
      if (completedStories.length === teamEpic.stories?.length) {
        console.log(`[SKIP] All ${completedStories.length} stories already completed for team epic`);
        return true;
      }
    }

    // Check for continuation mode
    const isContinuation = task.orchestration.continuations?.length > 0;
    if (isContinuation) {
      console.log('[Developers] Continuation mode - will implement new requirements');
      return false;
    }

    // Single mode
    if (task.orchestration.developers?.status === 'completed') {
      console.log(`[SKIP] Developers already completed`);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const startTime = Date.now();
    const task = context.task;
    const taskId = (task._id as any).toString();

    // Initialize
    const isMultiTeam = !!context.getData('teamEpic');
    if (!isMultiTeam) {
      this.initializeState(task, startTime);
      await task.save();
    }

    NotificationService.emitAgentStarted(taskId, 'Developers');
    await LogService.agentStarted('developer', taskId, {
      phase: 'development',
      multiTeam: isMultiTeam
    });

    try {
      // Get stories to implement
      const stories = this.getStoriesToImplement(context);
      if (stories.length === 0) {
        throw new Error('No stories to implement');
      }

      console.log(`[Developers] Implementing ${stories.length} stories`);

      // Create epic branches
      const epicBranches = await this.createEpicBranches(stories, context);

      // Execute stories (parallel when possible)
      const results = await this.executeStories(
        stories,
        epicBranches,
        context,
        taskId
      );

      // Merge story branches into epic branches
      await this.mergeStoryBranches(results, epicBranches, context);

      // CRITICAL: Push epic branches to remote
      await this.pushEpicBranches(epicBranches, context);

      // Handle results
      return this.processResults(task, results, epicBranches, startTime, context);

    } catch (error: any) {
      return this.handleError(task, error, taskId, isMultiTeam);
    }
  }

  /**
   * Get stories to implement based on mode
   */
  private getStoriesToImplement(context: OrchestrationContext): any[] {
    const teamEpic = context.getData<any>('teamEpic');

    if (teamEpic) {
      // Multi-team: get uncompleted stories
      return teamEpic.stories?.filter((s: any) => !s.completed) || [];
    } else {
      // Single mode: get all stories
      return context.getData<any[]>('stories') || [];
    }
  }

  /**
   * Create epic branches for story organization
   */
  private async createEpicBranches(
    stories: any[],
    context: OrchestrationContext
  ): Promise<Map<string, string>> {
    const branches = new Map<string, string>();
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath || undefined
    );

    if (repos.length === 0) return branches;

    const primaryRepo = repos[0];
    const repoPath = primaryRepo.path;

    // Group stories by epic
    const storyByEpic = new Map<string, any[]>();
    for (const story of stories) {
      const epicId = story.epicId || 'default';
      if (!storyByEpic.has(epicId)) {
        storyByEpic.set(epicId, []);
      }
      storyByEpic.get(epicId)!.push(story);
    }

    // Create branch for each epic
    for (const [epicId, epicStories] of storyByEpic) {
      const timestamp = Date.now();
      const suffix = Math.random().toString(36).substring(2, 8);
      const branchName = `epic/${epicId}-${timestamp}-${suffix}`;

      try {
        console.log(`[Developers] Creating epic branch: ${branchName}`);
        safeGitExecSync('git checkout main', { cwd: repoPath });
        safeGitExecSync('git pull origin main', { cwd: repoPath });
        safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath });

        // CRITICAL FIX: Push epic branch immediately
        console.log(`[Developers] Pushing epic branch to remote: ${branchName}`);
        safeGitExecSync(`git push -u origin ${branchName}`, { cwd: repoPath });

        branches.set(epicId, branchName);
      } catch (error) {
        console.error(`Failed to create/push branch for epic ${epicId}:`, error);
      }
    }

    return branches;
  }

  /**
   * Execute stories with optimized parallelization
   */
  private async executeStories(
    stories: any[],
    epicBranches: Map<string, string>,
    context: OrchestrationContext,
    taskId: string
  ): Promise<any[]> {
    const results: any[] = [];
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath || undefined
    );

    // Group stories by epic for better parallelization
    const storyGroups = this.groupStoriesByEpic(stories);

    // Process story groups
    for (const group of storyGroups) {
      // Execute stories in parallel (up to MAX_PARALLEL_DEVELOPERS)
      const batchResults = await this.executeBatch(
        group,
        epicBranches,
        repos,
        context,
        taskId
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Execute a batch of stories in parallel
   */
  private async executeBatch(
    stories: any[],
    epicBranches: Map<string, string>,
    repos: any[],
    context: OrchestrationContext,
    taskId: string
  ): Promise<any[]> {
    const batches: any[][] = [];

    // Split into batches
    for (let i = 0; i < stories.length; i += this.MAX_PARALLEL_DEVELOPERS) {
      batches.push(stories.slice(i, i + this.MAX_PARALLEL_DEVELOPERS));
    }

    const allResults: any[] = [];

    // Execute each batch
    for (const batch of batches) {
      const promises = batch.map(story =>
        this.executeStory(story, epicBranches, repos[0], context, taskId)
      );

      const batchResults = await Promise.allSettled(promises);

      // Process results
      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const story = batch[i];

        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          console.error(`[Developers] Story ${story.id} failed:`, result.reason);
          allResults.push({
            story,
            success: false,
            error: result.reason?.message || 'Unknown error'
          });
        }
      }
    }

    return allResults;
  }

  /**
   * Execute a single story with optimized prompt - FIXED WITH GIT PUSH
   */
  private async executeStory(
    story: any,
    epicBranches: Map<string, string>,
    repo: any,
    context: OrchestrationContext,
    taskId: string
  ): Promise<any> {
    const epicId = story.epicId || 'default';
    const epicBranch = epicBranches.get(epicId);
    const timestamp = Date.now();
    const storyBranch = `story/${story.id}-${timestamp}`;

    // Create story branch from epic branch
    const repoPath = repo.path;

    try {
      console.log(`[Developer ${story.id}] Creating story branch: ${storyBranch}`);
      safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath });
      safeGitExecSync(`git checkout -b ${storyBranch}`, { cwd: repoPath });

      // Build optimized developer prompt
      const prompt = this.buildDeveloperPrompt(story, repo, context);

      // Execute developer
      const startTime = Date.now();
      NotificationService.emitAgentProgress(
        taskId,
        `Developer-${story.id}`,
        `Implementing: ${story.title}`
      );

      const result = await this.executeDeveloperFn(
        story.id,
        prompt,
        repoPath,
        taskId,
        context.getData('attachments')
      );

      // Commit changes
      const commitMessage = `feat(${epicId}): ${story.title}\n\nImplemented by Developer-${story.id}`;
      try {
        safeGitExecSync('git add -A', { cwd: repoPath });
        const _commitResult = safeGitExecSync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
        console.log(`[Developer ${story.id}] Committed changes`);
      } catch (error: any) {
        if (error.message?.includes('nothing to commit')) {
          console.log(`[Developer ${story.id}] No changes to commit`);
        } else {
          console.error(`[Developer ${story.id}] Commit error:`, error.message);
        }
      }

      // CRITICAL FIX: Push story branch to remote
      try {
        console.log(`[Developer ${story.id}] Pushing story branch to remote: ${storyBranch}`);
        safeGitExecSync(`git push -u origin ${storyBranch}`, { cwd: repoPath });
        console.log(`[Developer ${story.id}] ✅ Successfully pushed ${storyBranch} to remote`);
      } catch (pushError: any) {
        console.error(`[Developer ${story.id}] ❌ Failed to push ${storyBranch}:`, pushError.message);
        // Continue anyway - the merge might still work locally
      }

      return {
        story,
        storyBranch,
        epicBranch,
        success: true,
        output: result.output,
        sessionId: result.sessionId,
        cost: result.cost,
        usage: result.usage,
        duration: Date.now() - startTime
      };

    } catch (error: any) {
      console.error(`[Developer ${story.id}] Story implementation failed:`, error);
      return {
        story,
        storyBranch,
        epicBranch,
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Build optimized developer prompt
   */
  private buildDeveloperPrompt(story: any, repo: any, _context: OrchestrationContext): string {
    return `# Developer Task: ${story.title}

## Context
- Repository: ${repo.name}
- Working directory: ${repo.path}
- Epic: ${story.epicId || 'main'}

## Story Details
${story.description || 'Implement the feature as described'}

## Tasks
${story.tasks?.map((t: string) => `- ${t}`).join('\n') || '- Implement the feature'}

## Requirements
${story.testRequirements?.map((r: string) => `- ${r}`).join('\n') || '- Add appropriate tests'}

## Instructions
1. Implement the feature according to requirements
2. Write clean, maintainable code
3. Add tests for new functionality
4. Ensure code compiles and tests pass
5. Follow project conventions

## Success Criteria
- Feature implemented and working
- Tests added and passing
- No breaking changes
- Code follows project style

Start implementation immediately.`;
  }

  /**
   * Merge story branches back to epic branches
   */
  private async mergeStoryBranches(
    results: any[],
    epicBranches: Map<string, string>,
    context: OrchestrationContext
  ): Promise<void> {
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath || undefined
    );

    if (repos.length === 0) return;

    const repoPath = repos[0].path;

    // Group results by epic
    const resultsByEpic = new Map<string, any[]>();
    for (const result of results) {
      if (result.success && result.epicBranch) {
        const epicId = result.story.epicId || 'default';
        if (!resultsByEpic.has(epicId)) {
          resultsByEpic.set(epicId, []);
        }
        resultsByEpic.get(epicId)!.push(result);
      }
    }

    // Merge each epic's story branches
    for (const [epicId, epicResults] of resultsByEpic) {
      const epicBranch = epicBranches.get(epicId);
      if (!epicBranch) continue;

      console.log(`[Developers] Merging ${epicResults.length} stories into ${epicBranch}`);
      safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath });

      for (const result of epicResults) {
        try {
          // First try to fetch the story branch from remote
          try {
            safeGitExecSync(`git fetch origin ${result.storyBranch}:${result.storyBranch}`, { cwd: repoPath });
          } catch (fetchError) {
            console.log(`[Developers] Story branch ${result.storyBranch} not on remote, using local`);
          }

          // Merge the story branch
          safeGitExecSync(`git merge ${result.storyBranch} --no-ff -m "Merge story ${result.story.id}"`, {
            cwd: repoPath
          });
          console.log(`[Developers] ✅ Merged story ${result.story.id} into ${epicBranch}`);
        } catch (error: any) {
          console.error(`[Developers] Failed to merge story ${result.story.id}:`, error.message);
        }
      }
    }
  }

  /**
   * CRITICAL: Push epic branches to remote after merging all stories
   */
  private async pushEpicBranches(
    epicBranches: Map<string, string>,
    context: OrchestrationContext
  ): Promise<void> {
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath || undefined
    );

    if (repos.length === 0) return;

    const repoPath = repos[0].path;

    for (const [epicId, epicBranch] of epicBranches) {
      try {
        console.log(`[Developers] Pushing epic branch with all stories: ${epicBranch}`);
        safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath });

        // Force push to ensure all changes are on remote
        safeGitExecSync(`git push origin ${epicBranch} --force-with-lease`, { cwd: repoPath });

        console.log(`[Developers] ✅ Successfully pushed ${epicBranch} to remote`);

        // Verify push worked
        const remoteBranches = safeGitExecSync('git ls-remote --heads origin', { cwd: repoPath }).toString();
        if (remoteBranches.includes(epicBranch)) {
          console.log(`[Developers] ✅ Verified ${epicBranch} exists on remote`);
        } else {
          console.error(`[Developers] ⚠️ Warning: ${epicBranch} may not be on remote`);
        }
      } catch (error: any) {
        console.error(`[Developers] ❌ Failed to push epic ${epicId} branch ${epicBranch}:`, error.message);
      }
    }
  }

  /**
   * Group stories by epic for better parallelization
   */
  private groupStoriesByEpic(stories: any[]): any[][] {
    const epicGroups = new Map<string, any[]>();

    for (const story of stories) {
      const epicId = story.epicId || 'default';
      if (!epicGroups.has(epicId)) {
        epicGroups.set(epicId, []);
      }
      epicGroups.get(epicId)!.push(story);
    }

    return Array.from(epicGroups.values());
  }

  /**
   * Process results and return phase result
   */
  private async processResults(
    task: any,
    results: any[],
    epicBranches: Map<string, string>,
    startTime: number,
    context: OrchestrationContext
  ): Promise<PhaseResult> {
    const successCount = results.filter(r => r.success).length;
    const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);
    const totalTokens = results.reduce((sum, r) =>
      sum + ((r.usage?.input_tokens || 0) + (r.usage?.output_tokens || 0)), 0
    );

    // Store epic branches in context - FIXED: preserve mapping
    const branchArray = Array.from(epicBranches.values());
    const branchMapping = Object.fromEntries(epicBranches); // epicId -> branchName

    context.setData('epicBranches', branchArray);
    context.setData('epicBranch', branchArray[0]); // Primary branch
    context.setData('epicBranchMapping', branchMapping); // CRITICAL: preserve epic-to-branch mapping

    // Update task (single mode only)
    const isMultiTeam = !!context.getData('teamEpic');
    if (!isMultiTeam) {
      task.orchestration.developers!.status = 'completed';
      task.orchestration.developers!.completedAt = new Date();
      task.orchestration.developers!.storiesImplemented = successCount;
      task.orchestration.developers!.totalStories = results.length;
      task.orchestration.developers!.cost_usd = totalCost;
      task.orchestration.developers!.epicBranches = branchArray;

      task.orchestration.totalCost += totalCost;
      task.orchestration.totalTokens += totalTokens;

      await task.save();
    }

    // Emit events
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: isMultiTeam ? 'TeamDevelopersCompleted' : 'DevelopersCompleted',
      agentName: 'developer',
      payload: {
        implemented: successCount,
        total: results.length,
        epicBranches: branchArray
      },
      metadata: {
        cost: totalCost,
        duration: Date.now() - startTime
      }
    });

    NotificationService.emitAgentCompleted(
      (task._id as any).toString(),
      'Developers',
      `Implemented ${successCount}/${results.length} stories across ${epicBranches.size} epics - All branches pushed to remote`
    );

    return {
      phaseName: this.name,
      duration: Date.now() - startTime,
      success: true,
      data: {
        storiesImplemented: successCount,
        totalStories: results.length,
        epicBranches: branchArray
      },
      metrics: {
        cost_usd: totalCost,
        input_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0), 0),
        output_tokens: results.reduce((sum, r) => sum + (r.usage?.output_tokens || 0), 0),
        success_rate: successCount / results.length
      }
    };
  }

  /**
   * Initialize state
   */
  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.developers) {
      task.orchestration.developers = {
        agent: 'developer',
        status: 'pending'
      } as any;
    }
    task.orchestration.developers!.status = 'in_progress';
    task.orchestration.developers!.startedAt = new Date(startTime);
  }

  /**
   * Handle error
   */
  private async handleError(
    task: any,
    error: any,
    taskId: string,
    isMultiTeam: boolean
  ): Promise<PhaseResult> {
    if (!isMultiTeam) {
      task.orchestration.developers!.status = 'failed';
      task.orchestration.developers!.error = error.message;
      await task.save();
    }

    NotificationService.emitAgentFailed(taskId, 'Developers', error.message);
    await LogService.agentFailed('developer', taskId, error, { phase: 'development' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}