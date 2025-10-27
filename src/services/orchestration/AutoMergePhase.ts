import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { PRManagementService } from '../github/PRManagementService';
import { GitHubService } from '../GitHubService';

/**
 * Auto Merge Phase
 *
 * Automatically merges all PRs to main after QA approval.
 *
 * Flow:
 * 1. QA completes successfully
 * 2. Auto-Merge Phase runs
 * 3. For each PR:
 *    a. Detect conflicts
 *    b. Auto-resolve simple conflicts
 *    c. Run tests
 *    d. Merge to main if all checks pass
 *    e. Clean up branches
 * 4. Report results (merged PRs, PRs needing human review)
 *
 * Based on AITMPL patterns:
 * - cli-tool/components/commands/git/finish.md
 * - cli-tool/components/agents/git/git-flow-manager.md
 */
export class AutoMergePhase extends BasePhase {
  readonly name = 'AutoMerge';
  readonly description = 'Automatically merging PRs to main';

  constructor(
    private githubService: GitHubService,
    private workspaceDir: string
  ) {
    super();
  }

  /**
   * Skip if auto-merge is disabled or no PRs exist
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Check if AutoMerge step exists and is completed
    const autoMerge = (context.task.orchestration as any).autoMerge;
    if (autoMerge?.status === 'completed') {
      console.log(`[SKIP] AutoMerge already completed`);
      return true;
    }

    // Check if auto-merge is disabled
    const autoMergeEnabled = context.getData<boolean>('autoMergeEnabled') ?? true;
    if (!autoMergeEnabled) {
      console.log(`[SKIP] Auto-merge is disabled`);
      return true;
    }

    // Check if QA completed successfully
    const qaStatus = context.task.orchestration.qaEngineer?.status;
    if (qaStatus !== 'completed') {
      console.log(`[SKIP] QA must complete before auto-merge`);
      return true;
    }

    // Check if there are PRs to merge
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const epics = state.epics || [];
    const epicsWithPRs = epics.filter((epic: any) => epic.pullRequestNumber);

    if (epicsWithPRs.length === 0) {
      console.log(`[SKIP] No PRs found to merge`);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();

    // Initialize autoMerge in task model
    if (!(context.task.orchestration as any).autoMerge) {
      (context.task.orchestration as any).autoMerge = {
        status: 'in_progress',
        startedAt: new Date(),
        results: [],
      };
    }

    const startTime = new Date();
    (context.task.orchestration as any).autoMerge.status = 'in_progress';
    (context.task.orchestration as any).autoMerge.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Auto-Merge');

    await LogService.agentStarted('auto-merge', taskId, {
      phase: 'auto-merge',
    });

    try {
      // Get repositories and workspace path
      const repositories = context.getData<any[]>('repositories') || [];
      const workspacePath = context.getData<string>('workspacePath');

      if (repositories.length === 0 || !workspacePath) {
        throw new Error('No repositories or workspace path available');
      }

      console.log(`\n${'='.repeat(80)}`);
      console.log(`🚀 AUTO-MERGE PHASE STARTED`);
      console.log(`${'='.repeat(80)}\n`);

      // Create PRManagementService instance
      const prManagementService = new PRManagementService(this.githubService);

      // Attempt auto-merge for all PRs
      const mergeResults = await prManagementService.autoMergePRsToMain(
        task,
        repositories,
        workspacePath,
        taskId
      );

      // Store results in task
      (context.task.orchestration as any).autoMerge.results = mergeResults;
      (context.task.orchestration as any).autoMerge.status = 'completed';
      (context.task.orchestration as any).autoMerge.completedAt = new Date();
      await task.save();

      // Analyze results
      const successfulMerges = mergeResults.filter((r) => r.merged);
      const needsReview = mergeResults.filter((r) => r.needsHumanReview);
      const failed = mergeResults.filter((r) => !r.merged && !r.needsHumanReview);

      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ AUTO-MERGE PHASE COMPLETE`);
      console.log(`   Merged: ${successfulMerges.length}/${mergeResults.length}`);
      console.log(`   Needs review: ${needsReview.length}`);
      console.log(`   Failed: ${failed.length}`);
      console.log(`${'='.repeat(80)}\n`);

      NotificationService.emitAgentCompleted(taskId, 'Auto-Merge', `Merged ${successfulMerges.length} PRs`);

      await LogService.agentCompleted('auto-merge', taskId, {
        phase: 'auto-merge',
        metadata: {
          totalPRs: mergeResults.length,
          merged: successfulMerges.length,
          needsReview: needsReview.length,
          failed: failed.length,
        },
      });

      // If any PRs need human review, notify
      if (needsReview.length > 0) {
        const message = `⚠️  ${needsReview.length} PR(s) need human review due to complex conflicts or test failures`;
        NotificationService.emitConsoleLog(taskId, 'warn', message);

        await LogService.warn('PRs need human review', {
          taskId,
          category: 'auto_merge',
          metadata: {
            count: needsReview.length,
            prs: needsReview.map((r) => ({
              error: r.error,
              conflicts: r.conflictsDetected.length,
            })),
          },
        });
      }

      return {
        success: true,
        data: {
          mergeResults,
          merged: successfulMerges.length,
          needsReview: needsReview.length,
          failed: failed.length,
        },
      };
    } catch (error: any) {
      console.error(`\n❌ AUTO-MERGE PHASE FAILED: ${error.message}\n`);

      (context.task.orchestration as any).autoMerge.status = 'failed';
      (context.task.orchestration as any).autoMerge.error = error.message;
      await task.save();

      NotificationService.emitAgentError(taskId, 'Auto-Merge', error.message);

      await LogService.error('Auto-Merge phase failed', {
        taskId,
        category: 'auto_merge',
        error,
        metadata: {
          errorMessage: error.message,
        },
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
