/**
 * JudgeStage - Handles Judge evaluation of developer work
 *
 * Responsibilities:
 * - Sync workspace with remote
 * - Checkout story branch
 * - Create JudgePhase context
 * - Run Judge evaluation
 * - Return verdict with feedback
 */

import { safeGitExecSync, smartGitFetch } from '../../../../utils/safeGitExecution';
import { GIT_TIMEOUTS } from '../../constants/Timeouts';
import { unifiedMemoryService } from '../../../UnifiedMemoryService';
import { OrchestrationContext } from '../../Phase';
import { StoryPipelineContext, JudgeStageResult } from '../types';
import { ExecuteAgentFn } from './MergeStage';
import { ExecuteDeveloperFn } from './DeveloperStage';

export class JudgeStageExecutor {
  constructor(
    private executeAgentFn: ExecuteAgentFn,
    private executeDeveloperFn: ExecuteDeveloperFn
  ) {}

  /**
   * Execute judge evaluation stage
   */
  async execute(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string,
    storyBranch: string
  ): Promise<JudgeStageResult> {
    const {
      task, story, developer, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId,
    } = pipelineCtx;

    console.log(`\n⚖️ [JUDGE STAGE] Starting for story: ${story.title}`);
    console.log(`   Commit: ${commitSHA}`);
    console.log(`   Branch: ${storyBranch}`);

    try {
      // Get updated story from event store
      const { eventStore } = await import('../../../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      // Sync workspace with remote
      if (effectiveWorkspacePath && repositories.length > 0) {
        await this.syncWorkspace(effectiveWorkspacePath, repositories, epic, storyBranch);
      }

      // Checkpoint: Mark as judge_evaluating
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

      // Run Judge phase
      const { JudgePhase } = await import('../../JudgePhase');
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

      return {
        success: true,
        approved: isApproved,
        judgeCost,
        judgeTokens,
        feedback: judgeResult.data?.feedback || judgeResult.error,
        iteration: judgeResult.data?.iteration || 1,
        maxRetries: judgeResult.data?.maxRetries || 3,
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
   * Sync workspace with remote and checkout story branch
   */
  private async syncWorkspace(
    workspacePath: string,
    repositories: any[],
    epic: any,
    storyBranch: string
  ): Promise<void> {
    const targetRepo = repositories.find((r: any) =>
      r.name === epic.targetRepository ||
      r.full_name === epic.targetRepository ||
      r.githubRepoName === epic.targetRepository
    );

    if (!targetRepo) return;

    const repoPath = `${workspacePath}/${targetRepo.name || targetRepo.full_name}`;

    console.log(`   🔄 Syncing workspace...`);
    try {
      // Use cached fetch
      smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });

      // Check if branch exists locally
      let branchExistsLocally = false;
      try {
        safeGitExecSync(`git show-ref --verify --quiet refs/heads/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
        branchExistsLocally = true;
      } catch { /* Branch doesn't exist locally */ }

      // Checkout story branch
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
