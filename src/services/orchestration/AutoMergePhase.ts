import { BasePhase, OrchestrationContext, PhaseResult, saveTaskFireAndForget } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { PRManagementService } from '../github/PRManagementService';
import { GitHubService } from '../GitHubService';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { isEmpty, isNotEmpty } from './utils/ArrayHelpers';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';

/**
 * Auto Merge Phase
 *
 * Automatically merges all PRs to main after verification passes.
 *
 * Flow:
 * 1. Verification completes successfully
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
    private githubService: GitHubService
  ) {
    super();
  }

  /**
   * 🎯 UNIFIED MEMORY: Skip if auto-merge is disabled, already completed, or no PRs exist
   *
   * Uses SkipLogicHelper for consistent skip behavior.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Use centralized skip logic first
    const skipResult = await checkPhaseSkip(context, { phaseName: 'AutoMerge' });
    if (skipResult.shouldSkip) {
      return true;
    }

    // Check if auto-merge is disabled
    const autoMergeEnabled = context.getData<boolean>('autoMergeEnabled') ?? true;
    if (!autoMergeEnabled) {
      console.log(`   ⏭️ Auto-merge is disabled`);
      return true;
    }

    // Check if TeamOrchestration completed (prerequisite)
    const teamOrchStatus = (context.task.orchestration as any).teamOrchestration?.status;
    if (teamOrchStatus !== 'completed' && teamOrchStatus !== 'partial') {
      console.log(`   ⏭️ TeamOrchestration must complete before auto-merge (current: ${teamOrchStatus || 'not started'})`);
      return true;
    }

    // Check if there are PRs to merge
    // 🔥 RECOVERY: Check BOTH EventStore and UnifiedMemory for PR info
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task.id as any);
    const epics = state.epics || [];
    const taskId = (task.id as any).toString();

    // Type for epic with PR info
    interface EpicWithPR {
      id: string;
      pullRequestNumber?: number;
      pullRequestUrl?: string;
      source?: string;
    }

    // Collect all epics with PRs
    const epicsWithPRs: EpicWithPR[] = [];

    // First, add EventStore epics that have PRs
    for (const epic of epics) {
      if (epic.pullRequestNumber) {
        epicsWithPRs.push({
          id: epic.id,
          pullRequestNumber: epic.pullRequestNumber,
          pullRequestUrl: epic.pullRequestUrl,
          source: 'EventStore',
        });
      }
    }

    // 🔥 UNIFIED MEMORY FALLBACK: If EventStore has no PRs, check UnifiedMemory
    if (isEmpty(epicsWithPRs)) {
      console.log(`   🔄 [AutoMerge] EventStore has no PRs - checking UnifiedMemory...`);
      try {
        const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
        if (resumption && resumption.completedEpics && resumption.completedEpics.length > 0) {
          // For each completed epic, check if we have PR info in UnifiedMemory
          for (const epicId of resumption.completedEpics) {
            const prInfo = await unifiedMemoryService.getEpicPR(taskId, epicId);
            if (prInfo?.prUrl && prInfo?.prNumber) {
              // Add to epics array with PR info for merge processing
              (epicsWithPRs as EpicWithPR[]).push({
                id: epicId,
                pullRequestNumber: prInfo.prNumber,
                pullRequestUrl: prInfo.prUrl,
                source: 'UnifiedMemory',
              });
              console.log(`   🔄 [AutoMerge] Restored PR from UnifiedMemory: Epic ${epicId} -> PR #${prInfo.prNumber}`);
            }
          }
        }
      } catch (error: any) {
        console.log(`   ⚠️ [AutoMerge] UnifiedMemory PR recovery failed: ${error.message}`);
      }
    }

    if (isEmpty(epicsWithPRs)) {
      console.log(`   ⏭️ No PRs found to merge`);
      return true;
    }

    // 🔥 Store recovered PRs in context for executePhase to use
    if (epicsWithPRs.some((e) => e.source === 'UnifiedMemory')) {
      context.setData('recoveredEpicsWithPRs', epicsWithPRs);
      console.log(`   ✅ [AutoMerge] Recovered ${epicsWithPRs.length} PR(s) total`);
    }

    console.log(`   ⏳ Phase pending - AutoMerge must execute`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();

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
    saveTaskFireAndForget(task, 'autoMerge in_progress');

    NotificationService.emitAgentStarted(taskId, 'Auto-Merge');

    await LogService.agentStarted('auto-merge', taskId, {
      phase: 'auto-merge',
    });

    try {
      // Get repositories and workspace path from context properties
      const repositories = context.repositories || [];
      const workspacePath = context.workspacePath;

      if (isEmpty(repositories) || !workspacePath) {
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
      saveTaskFireAndForget(task, 'autoMerge completed');

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
      if (isNotEmpty(needsReview)) {
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

      // 🔌 INTEGRATION TASK PATTERN: Create follow-up task if needed
      const pendingIntegration = (task.orchestration as any).pendingIntegrationTask;
      if (pendingIntegration && pendingIntegration.status === 'pending') {
        const allMergedSuccessfully = successfulMerges.length === mergeResults.length && isEmpty(failed);

        if (allMergedSuccessfully) {
          // ✅ All PRs merged - Create Integration Task automatically
          console.log(`\n${'🔌'.repeat(40)}`);
          console.log(`🔌 INTEGRATION TASK PATTERN: All PRs merged successfully!`);
          console.log(`🔌 Creating follow-up Integration Task...`);
          console.log(`${'🔌'.repeat(40)}\n`);

          try {
            const { TaskRepository: TaskRepo } = await import('../../database/repositories/TaskRepository.js');

            // Get the target repository
            const targetRepoName = pendingIntegration.targetRepository;
            const repos = context.repositories || [];
            const targetRepo = repos.find((r: any) =>
              r.name === targetRepoName ||
              r.githubRepoName === targetRepoName ||
              r.full_name?.includes(targetRepoName)
            );

            const integrationTask = TaskRepo.create({
              title: `[AUTO] ${pendingIntegration.title}`,
              description: pendingIntegration.description +
                `\n\n---\n**Auto-generated Integration Task**\n\n` +
                `**Integration Points:**\n${pendingIntegration.integrationPoints.map((p: string) => `- ${p}`).join('\n')}\n\n` +
                `**Files to Create:**\n${pendingIntegration.filesToCreate.map((f: string) => `- ${f}`).join('\n')}`,
              userId: task.userId,
              projectId: task.projectId,
              repositoryIds: targetRepo ? [targetRepo.id] : task.repositoryIds,
              priority: 'high',
              orchestration: {
                totalCost: 0,
                totalTokens: 0,
              },
              tags: ['auto-generated', 'integration'],
            });

            // Update pending integration status
            (task.orchestration as any).pendingIntegrationTask.status = 'created';
            (task.orchestration as any).pendingIntegrationTask.createdTaskId = integrationTask.id;
            saveTaskFireAndForget(task, 'integration task created');

            console.log(`✅ Integration Task created: ${integrationTask.id}`);
            console.log(`   Title: ${integrationTask.title}`);
            console.log(`   Target Repo: ${targetRepoName}`);

            NotificationService.emitConsoleLog(
              taskId,
              'info',
              `🔌 Integration Task created automatically!\n` +
              `   ID: ${integrationTask.id}\n` +
              `   Title: ${integrationTask.title}\n` +
              `   Status: Ready to start`
            );

            // Emit special event for frontend
            NotificationService.emitNotification(taskId, 'integration_task_created', {
              integrationTaskId: integrationTask.id,
              title: integrationTask.title,
              message: 'Integration task created and ready to start',
            });

          } catch (createError: any) {
            console.error(`❌ Failed to create Integration Task: ${createError.message}`);
            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `Failed to create Integration Task: ${createError.message}`
            );
          }
        } else {
          // ❌ Some PRs failed or need review - Notify user
          console.log(`\n⚠️ [AutoMerge] Not all PRs merged. Integration Task NOT created.`);
          console.log(`   Merged: ${successfulMerges.length}/${mergeResults.length}`);
          console.log(`   Failed: ${failed.length}`);
          console.log(`   Needs Review: ${needsReview.length}`);

          // Mark as notified but not created
          (task.orchestration as any).pendingIntegrationTask.userNotified = true;
          saveTaskFireAndForget(task, 'integration task notified');

          const integrationTaskDefinition = `
📋 INTEGRATION TASK (Create manually after resolving PRs):
Title: ${pendingIntegration.title}
Description: ${pendingIntegration.description}
Target Repository: ${pendingIntegration.targetRepository}

Integration Points:
${pendingIntegration.integrationPoints.map((p: string) => `- ${p}`).join('\n')}

Files to Create:
${pendingIntegration.filesToCreate.map((f: string) => `- ${f}`).join('\n')}
`;

          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️ PRs need manual resolution before Integration Task can be created.\n\n` +
            `After merging PRs manually, create a new task with:\n${integrationTaskDefinition}`
          );

          // Emit special event for frontend
          NotificationService.emitNotification(taskId, 'integration_task_pending', {
            message: 'Integration task pending - manual merge required',
            taskDefinition: pendingIntegration,
          });
        }
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
      saveTaskFireAndForget(task, 'autoMerge failed');

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
