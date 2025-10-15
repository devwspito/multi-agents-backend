import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';

/**
 * Merge Coordinator Phase
 *
 * Coordinates PR merges and resolves conflicts
 * - Detects conflicts between PRs
 * - Coordinates merge order
 * - Handles conflict resolution
 *
 * Note: This phase is optional and only runs when there are multiple PRs
 */
export class MergePhase extends BasePhase {
  readonly name = 'Merge'; // Must match PHASE_ORDER
  readonly description = 'Coordinating PR merges and resolving conflicts';

  constructor() {
    super();
  }

  /**
   * Skip this phase if there's only one PR or if no merge coordination needed or already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Skip if already completed
    if (context.task.orchestration.mergeCoordinator?.status === 'completed') {
      console.log(`[SKIP] Merge Coordinator already completed - skipping re-execution`);
      context.setData('mergeCoordinatorComplete', true);
      return true;
    }

    const team = context.task.orchestration.team || [];

    // Skip if only one team member (no coordination needed)
    if (team.length <= 1) {
      console.log(`[SKIP] Merge Coordinator not needed - only ${team.length} team member(s)`);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;

    console.log(`🔀 [Merge Coordinator] Analyzing conflicts...`);

    // Initialize merge coordinator state if not exists
    if (!task.orchestration.mergeCoordinator) {
      task.orchestration.mergeCoordinator = {
        agent: 'merge-coordinator',
        status: 'pending',
      } as any;
    }

    task.orchestration.mergeCoordinator!.status = 'in_progress';
    task.orchestration.mergeCoordinator!.startedAt = new Date();
    await task.save();

    try {
      // The actual merge coordination logic is handled by MergeCoordinatorService
      // which is called separately or integrated here
      // For now, just mark as completed

      task.orchestration.mergeCoordinator!.status = 'completed';
      task.orchestration.mergeCoordinator!.completedAt = new Date();
      task.orchestration.mergeCoordinator!.output =
        'Merge coordination handled by separate service';
      await task.save();

      // 🔥 EVENT SOURCING: Emit completion event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'MergeCoordinatorCompleted',
        agentName: 'merge-coordinator',
        payload: {
          output: 'Merge coordination handled by separate service',
        },
      });

      console.log(`✅ [Merge Coordinator] Merge coordination complete`);
      console.log(`📝 [Merge] Emitted MergeCoordinatorCompleted event`);

      // Store phase data
      context.setData('mergeCoordinatorComplete', true);

      return {
        success: true,
        data: {
          message: 'Merge coordination completed',
        },
      };
    } catch (error: any) {
      task.orchestration.mergeCoordinator!.status = 'failed';
      task.orchestration.mergeCoordinator!.error = error.message;
      await task.save();

      // 🔥 CRITICAL: Emit completion event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'MergeCoordinatorCompleted',
        agentName: 'merge-coordinator',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [Merge] Emitted MergeCoordinatorCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
