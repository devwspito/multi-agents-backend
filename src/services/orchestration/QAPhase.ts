import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { GitHubService } from '../GitHubService';
import { PRManagementService } from '../github/PRManagementService';
import { LogService } from '../logging/LogService';
import path from 'path';

/**
 * QA Engineer Phase
 *
 * Final quality gate with comprehensive testing and validation
 * - Creates integration branch
 * - Merges all epic branches locally
 * - Performs integration testing
 * - Creates Pull Requests after successful validation
 *
 * This is the FINAL GATE - nothing goes to production without QA approval
 */
export class QAPhase extends BasePhase {
  readonly name = 'QA'; // Must match PHASE_ORDER
  readonly description = 'Testing integration and creating Pull Requests';

  constructor(
    private executeAgentFn: Function,
    private githubService: GitHubService,
    private prManagementService: PRManagementService,
    private workspaceDir: string
  ) {
    super();
  }

  /**
   * Skip if QA Engineer already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    if (context.task.orchestration.qaEngineer?.status === 'completed') {
      console.log(`[SKIP] QA Engineer already completed - skipping re-execution`);

      // Restore phase data from previous execution
      if (context.task.orchestration.qaEngineer.output) {
        context.setData('qaEngineerOutput', context.task.orchestration.qaEngineer.output);
      }
      context.setData('qaComplete', true);

      return true;
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

    await LogService.info('QA Engineer phase started - Integration testing', {
      taskId,
      category: 'orchestration',
      phase: 'qa',
    });

    // Initialize QA Engineer state if not exists
    if (!task.orchestration.qaEngineer) {
      task.orchestration.qaEngineer = {
        agent: 'qa-engineer',
        status: 'pending',
      } as any;
    }

    const startTime = new Date();
    task.orchestration.qaEngineer!.status = 'in_progress';
    task.orchestration.qaEngineer!.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'QA Engineer');

    await LogService.agentStarted('qa-engineer', taskId, {
      phase: 'qa',
    });

    try {
      // TODO: Add epics to IAgentStep or get from stories
      // For now, use stories from projectManager
      const stories = task.orchestration.projectManager?.stories || [];
      const epics = stories; // Alias for backward compatibility
      const epicBranches = epics.map((e: any) => e.branchName).filter(Boolean) as string[];

      await LogService.info(`Testing integration of ${epicBranches.length} epic branches`, {
        taskId,
        category: 'quality',
        phase: 'qa',
        metadata: {
          epicBranchesCount: epicBranches.length,
          branches: epicBranches,
        },
      });

      // Progress notification
      NotificationService.emitAgentProgress(
        taskId,
        'QA Engineer',
        `Testing integration of ${epicBranches.length} epic branches...`
      );

      // Create integration branch in primary repo
      const primaryRepo = repositories.length > 0 ? repositories[0] : null;
      let mergeSuccess = true;
      let mergeConflicts: string[] = [];

      if (primaryRepo && workspacePath) {
        const integrationBranch = `integration-test-${task._id}`;
        const primaryRepoPath = path.join(workspacePath, primaryRepo.name);

        await this.githubService.createIntegrationBranch(
          primaryRepoPath,
          primaryRepo.branch,
          integrationBranch
        );

        task.orchestration.qaEngineer!.integrationBranch = integrationBranch;

        // Merge all epic branches locally
        const mergeResult = await this.githubService.mergeMultiplePRsLocally(
          primaryRepoPath,
          epicBranches
        );

        if (!mergeResult.success) {
          await LogService.warn(`Conflicts detected in branches`, {
            taskId,
            category: 'git',
            phase: 'qa',
            metadata: {
              conflicts: mergeResult.conflicts,
              conflictCount: mergeResult.conflicts.length,
            },
          });
          mergeSuccess = false;
          mergeConflicts = mergeResult.conflicts;
        }
      }

      // Execute QA agent
      const prompt = `Act as the qa-engineer agent.

# Integration Testing

## Task:
${task.title}

## Epic Branches to Test:
${epicBranches.map((branch) => `- Branch: ${branch}`).join('\n')}

## Your Mission:
Test the integrated solution with all epic branches merged together.

Provide:
1. Integration test results
2. Any bugs or issues found
3. **GO/NO-GO decision**`;

      const result = await this.executeAgentFn(
        'qa-engineer',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'QA Engineer'
      );

      // Store results
      task.orchestration.qaEngineer!.status = 'completed';
      task.orchestration.qaEngineer!.completedAt = new Date();
      task.orchestration.qaEngineer!.output = result.output;
      task.orchestration.qaEngineer!.sessionId = result.sessionId;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.qaEngineer!.canResumeSession = result.canResume;
      task.orchestration.qaEngineer!.usage = result.usage;
      task.orchestration.qaEngineer!.cost_usd = result.cost;
      task.orchestration.qaEngineer!.totalPRsTested = epicBranches.length;

      // if (result.todos) {
      //   task.orchestration.qaEngineer!.todos = result.todos;
      //   task.orchestration.qaEngineer!.lastTodoUpdate = new Date();
      // }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      // 🔥 EVENT SOURCING: Emit completion event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'QACompleted',
        agentName: 'qa-engineer',
        payload: {
          output: result.output,
          epicsBranches: epicBranches.length,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [QA] Emitted QACompleted event`);

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'QA Engineer', result.output);

      // ✅ CRITICAL: Create PRs AFTER QA completes successfully
      await LogService.info('Creating Pull Requests after QA validation', {
        taskId,
        category: 'pr',
        phase: 'qa',
        metadata: {
          epicsCount: epics.length,
        },
      });

      const prResults = await this.prManagementService.createEpicPRs(
        task,
        repositories,
        workspacePath
      );

      const successfulPRs = prResults.filter((r) => r.success).length;
      await LogService.success(`Created ${successfulPRs}/${prResults.length} Pull Requests`, {
        taskId,
        category: 'pr',
        phase: 'qa',
        metadata: {
          successfulPRs,
          totalPRs: prResults.length,
        },
      });

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'QA Engineer',
        `Integration testing complete. Tested ${epicBranches.length} epic branches. Created ${successfulPRs} PRs.`
      );

      await LogService.agentCompleted('qa-engineer', taskId, {
        phase: 'qa',
        metadata: {
          epicBranchesTested: epicBranches.length,
          prsCreated: successfulPRs,
          mergeSuccess,
          conflictsCount: mergeConflicts.length,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data
      context.setData('qaComplete', true);
      context.setData('prResults', prResults);
      context.setData('mergeConflicts', mergeConflicts);

      return {
        success: true,
        data: {
          output: result.output,
          epicBranchesTested: epicBranches.length,
          prsCreated: successfulPRs,
          mergeSuccess,
          conflicts: mergeConflicts,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          prs_created: successfulPRs,
          branches_tested: epicBranches.length,
        },
        warnings: !mergeSuccess ? [`Merge conflicts detected: ${mergeConflicts.join(', ')}`] : undefined,
      };
    } catch (error: any) {
      task.orchestration.qaEngineer!.status = 'failed';
      task.orchestration.qaEngineer!.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'QA Engineer', error.message);

      await LogService.agentFailed('qa-engineer', taskId, error, {
        phase: 'qa',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'QACompleted', // Mark as completed even on error
        agentName: 'qa-engineer',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [QA] Emitted QACompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
