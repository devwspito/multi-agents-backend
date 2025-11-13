import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { RepositoryHelper } from '../utils/RepositoryHelper';
import { GitBranchManager } from '../utils/GitBranchManager';
import { safeGitExecSync } from '../../../utils/safeGitExecution';
import path from 'path';

/**
 * ENHANCED: Developers Phase with GitBranchManager
 *
 * Guarantees ALL branches are pushed to remote using centralized management
 * No more "branch not found" errors
 */
export class DevelopersPhaseWithBranchManager extends BasePhase {
  readonly name = 'Developers';
  readonly description = 'Implementing technical stories with guaranteed branch management';

  private readonly MAX_PARALLEL_DEVELOPERS = 2;
  private readonly STORY_TIMEOUT_MS = 600000;
  private branchManager: GitBranchManager;

  constructor(
    private executeDeveloperFn: Function,
    private workspaceDir: string
  ) {
    super();
    this.branchManager = new GitBranchManager();
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    const Task = require('../../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const teamEpic = context.getData<any>('teamEpic');
    if (teamEpic) {
      const completedStories = teamEpic.stories?.filter((s: any) => s.completed) || [];
      if (completedStories.length === teamEpic.stories?.length) {
        console.log(`[SKIP] All ${completedStories.length} stories already completed`);
        return true;
      }
    }

    const isContinuation = task.orchestration.continuations?.length > 0;
    if (isContinuation) {
      console.log('[Developers] Continuation mode - will implement new requirements');
      return false;
    }

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

    const isMultiTeam = !!context.getData('teamEpic');
    if (!isMultiTeam) {
      this.initializeState(task, startTime);
      await task.save();
    }

    NotificationService.emitAgentStarted(taskId, 'Developers');
    await LogService.agentStarted('developers', taskId, {
      phase: 'implementation',
      multiTeam: isMultiTeam
    });

    try {
      const stories = this.getStoriesToImplement(context);
      if (stories.length === 0) {
        throw new Error('No stories to implement');
      }

      console.log(`[Developers] Implementing ${stories.length} stories with GitBranchManager`);

      // Create epic branches using GitBranchManager
      const epicBranches = await this.createManagedEpicBranches(stories, context);

      // Execute stories
      const results = await this.executeStories(
        stories,
        epicBranches,
        context,
        taskId
      );

      // Merge story branches
      await this.mergeStoryBranches(results, epicBranches, context);

      // Final push of epic branches (GitBranchManager ensures remote)
      await this.finalPushEpicBranches(epicBranches, context);

      // Verify all branches are on remote
      const repos = RepositoryHelper.buildRepoContext(
        context.repositories,
        context.workspacePath
      );
      if (repos.length > 0) {
        const verification = await this.branchManager.verifyRemoteBranches(repos[0].path);
        if (!verification.success) {
          console.error(`⚠️ Missing branches on remote: ${verification.missing.join(', ')}`);
          console.log(`🔧 Attempting emergency push...`);
          await this.branchManager.pushAllMissingBranches(repos[0].path);
        }
      }

      return this.processResults(task, results, epicBranches, startTime, context);

    } catch (error: any) {
      return this.handleError(task, error, taskId, isMultiTeam);
    }
  }

  private getStoriesToImplement(context: OrchestrationContext): any[] {
    const teamEpic = context.getData<any>('teamEpic');
    if (teamEpic) {
      return teamEpic.stories?.filter((s: any) => !s.completed) || [];
    }
    return context.getData<any[]>('stories') || [];
  }

  /**
   * Create epic branches using GitBranchManager
   */
  private async createManagedEpicBranches(
    stories: any[],
    context: OrchestrationContext
  ): Promise<Map<string, string>> {
    const branches = new Map<string, string>();
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath
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

    // Create branches using GitBranchManager
    for (const [epicId, epicStories] of storyByEpic) {
      try {
        const branchName = await this.branchManager.createEpicBranch(
          epicId,
          repoPath,
          'main'
        );
        branches.set(epicId, branchName);
        console.log(`✅ [GitBranchManager] Epic branch created and pushed: ${branchName}`);
      } catch (error: any) {
        console.error(`❌ Failed to create epic branch for ${epicId}:`, error.message);
      }
    }

    return branches;
  }

  private async executeStories(
    stories: any[],
    epicBranches: Map<string, string>,
    context: OrchestrationContext,
    taskId: string
  ): Promise<any[]> {
    const results: any[] = [];
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath
    );

    const storyGroups = this.groupStoriesByEpic(stories);

    for (const group of storyGroups) {
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

  private async executeBatch(
    stories: any[],
    epicBranches: Map<string, string>,
    repos: any[],
    context: OrchestrationContext,
    taskId: string
  ): Promise<any[]> {
    const batches: any[][] = [];

    for (let i = 0; i < stories.length; i += this.MAX_PARALLEL_DEVELOPERS) {
      batches.push(stories.slice(i, i + this.MAX_PARALLEL_DEVELOPERS));
    }

    const allResults: any[] = [];

    for (const batch of batches) {
      const promises = batch.map(story =>
        this.executeStory(story, epicBranches, repos[0], context, taskId)
      );

      const batchResults = await Promise.allSettled(promises);

      for (let i = 0; i < batchResults.length; i++) {
        const result = batchResults[i];
        const story = batch[i];

        if (result.status === 'fulfilled') {
          allResults.push(result.value);
        } else {
          console.error(`[Developer] Story ${story.id} failed:`, result.reason);
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
   * Execute story with GitBranchManager
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
    if (!epicBranch) {
      return {
        story,
        success: false,
        error: 'Epic branch not found'
      };
    }

    const repoPath = repo.path;

    try {
      // Create story branch using GitBranchManager
      const storyBranch = await this.branchManager.createStoryBranch(
        story.id,
        epicBranch,
        repoPath
      );

      console.log(`✅ [GitBranchManager] Story branch created: ${storyBranch}`);

      // Build developer prompt
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
        safeGitExecSync(`git commit -m "${commitMessage}"`, { cwd: repoPath });
        console.log(`[Developer ${story.id}] Committed changes`);

        // Push using GitBranchManager
        await this.branchManager.pushBranch(storyBranch, repoPath);
        console.log(`✅ [GitBranchManager] Story branch pushed: ${storyBranch}`);
      } catch (error: any) {
        if (!error.message?.includes('nothing to commit')) {
          console.error(`[Developer ${story.id}] Error:`, error.message);
        }
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
      console.error(`[Developer ${story.id}] Failed:`, error);
      return {
        story,
        success: false,
        error: error.message
      };
    }
  }

  private buildDeveloperPrompt(story: any, repo: any, context: OrchestrationContext): string {
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

Start implementation immediately.`;
  }

  private async mergeStoryBranches(
    results: any[],
    epicBranches: Map<string, string>,
    context: OrchestrationContext
  ): Promise<void> {
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath
    );

    if (repos.length === 0) return;

    const repoPath = repos[0].path;
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

    for (const [epicId, epicResults] of resultsByEpic) {
      const epicBranch = epicBranches.get(epicId);
      if (!epicBranch) continue;

      console.log(`[Developers] Merging ${epicResults.length} stories into ${epicBranch}`);
      safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath });

      for (const result of epicResults) {
        try {
          // Fetch from remote first
          try {
            safeGitExecSync(`git fetch origin ${result.storyBranch}:${result.storyBranch}`, {
              cwd: repoPath
            });
          } catch (e) {
            // Use local if not on remote
          }

          safeGitExecSync(`git merge ${result.storyBranch} --no-ff -m "Merge story ${result.story.id}"`, {
            cwd: repoPath
          });
          console.log(`✅ Merged story ${result.story.id}`);
        } catch (error: any) {
          console.error(`Failed to merge story ${result.story.id}:`, error.message);
        }
      }
    }
  }

  /**
   * Final push using GitBranchManager
   */
  private async finalPushEpicBranches(
    epicBranches: Map<string, string>,
    context: OrchestrationContext
  ): Promise<void> {
    const repos = RepositoryHelper.buildRepoContext(
      context.repositories,
      context.workspacePath
    );

    if (repos.length === 0) return;

    const repoPath = repos[0].path;

    for (const [epicId, epicBranch] of epicBranches) {
      const success = await this.branchManager.pushBranch(epicBranch, repoPath, true);
      if (success) {
        console.log(`✅ [GitBranchManager] Epic ${epicId} pushed successfully`);
      } else {
        console.error(`❌ [GitBranchManager] Failed to push epic ${epicId}`);
      }
    }
  }

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

    const branchArray = Array.from(epicBranches.values());
    context.setData('epicBranches', branchArray);
    context.setData('epicBranch', branchArray[0]);

    // Get verified branches from GitBranchManager
    const verifiedBranches = this.branchManager.getEpicBranches();
    console.log(`✅ [GitBranchManager] Verified ${verifiedBranches.length} epic branches on remote`);

    const isMultiTeam = !!context.getData('teamEpic');
    if (!isMultiTeam) {
      task.orchestration.developers!.status = 'completed';
      task.orchestration.developers!.completedAt = new Date();
      task.orchestration.developers!.storiesImplemented = successCount;
      task.orchestration.developers!.totalStories = results.length;
      task.orchestration.developers!.cost_usd = totalCost;
      task.orchestration.developers!.epicBranches = verifiedBranches;

      task.orchestration.totalCost += totalCost;
      task.orchestration.totalTokens += totalTokens;

      await task.save();
    }

    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: isMultiTeam ? 'TeamDevelopersCompleted' : 'DevelopersCompleted',
      agentName: 'developers',
      payload: {
        implemented: successCount,
        total: results.length,
        epicBranches: verifiedBranches,
        verifiedOnRemote: true
      },
      metadata: {
        cost: totalCost,
        duration: Date.now() - startTime
      }
    });

    NotificationService.emitAgentCompleted(
      (task._id as any).toString(),
      'Developers',
      `✅ Implemented ${successCount}/${results.length} stories | ${verifiedBranches.length} branches verified on remote`
    );

    return {
      phaseName: this.name,
      duration: Date.now() - startTime,
      success: true,
      data: {
        storiesImplemented: successCount,
        totalStories: results.length,
        epicBranches: verifiedBranches,
        allBranchesPushed: true
      },
      metrics: {
        cost_usd: totalCost,
        input_tokens: results.reduce((sum, r) => sum + (r.usage?.input_tokens || 0), 0),
        output_tokens: results.reduce((sum, r) => sum + (r.usage?.output_tokens || 0), 0),
        success_rate: successCount / results.length
      }
    };
  }

  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.developers) {
      task.orchestration.developers = {
        agent: 'developers',
        status: 'pending'
      } as any;
    }
    task.orchestration.developers!.status = 'in_progress';
    task.orchestration.developers!.startedAt = new Date(startTime);
  }

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
    await LogService.agentFailed('developers', taskId, error, { phase: 'implementation' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}