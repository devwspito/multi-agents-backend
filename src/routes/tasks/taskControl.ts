/**
 * Task Control Router
 *
 * Task lifecycle control endpoints:
 * - POST /:id/compact - Compact conversation history
 * - POST /:id/pause   - Pause orchestration
 * - POST /:id/resume  - Resume paused/failed orchestration
 * - POST /:id/cancel  - Cancel orchestration
 */

import {
  Router,
  authenticate,
  AuthRequest,
  TaskRepository,
  orchestrationCoordinator,
  isValidObjectId,
} from './shared';
import { ResumeService } from '../../services/ResumeService.js';

const router = Router();

/**
 * POST /api/tasks/:id/compact
 * Compact conversation history using SDK native /compact
 */
router.post('/:id/compact', authenticate, async (req: AuthRequest, res) => {
  try {
    const taskId = req.params.id;

    if (!isValidObjectId(taskId)) {
      res.status(400).json({
        success: false,
        message: 'Invalid task ID',
      });
      return;
    }

    const task = TaskRepository.findById(taskId);
    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    console.log(`🗜️  [Compact] Using SDK native /compact for task ${taskId}`);

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    let compacted = false;
    for await (const message of query({
      prompt: '/compact',
      options: { maxTurns: 1 }
    })) {
      if (message.type === 'system' && (message as any).subtype === 'compact_boundary') {
        compacted = true;
        console.log('✅ [Compact] SDK compaction completed');
      }
    }

    res.json({
      success: true,
      message: 'Conversation history compacted using SDK native /compact',
      data: {
        compacted,
        method: 'SDK native /compact command'
      },
    });
  } catch (error) {
    console.error('Error compacting:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to compact conversation history',
    });
  }
});

/**
 * POST /api/tasks/:id/pause
 * Pause a running orchestration (graceful - waits for current phase)
 */
router.post('/:id/pause', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    if (task.status !== 'in_progress') {
      res.status(400).json({
        success: false,
        message: `Cannot pause task with status: ${task.status}`,
      });
      return;
    }

    if (task.orchestration.paused) {
      res.status(400).json({
        success: false,
        message: 'Task is already paused',
      });
      return;
    }

    TaskRepository.modifyOrchestration(task.id, (orch) => ({
      ...orch,
      paused: true,
      pausedAt: new Date(),
      pausedBy: req.user!.id,
    }));

    // Also update task.status so frontend can sync properly
    TaskRepository.updateStatus(task.id, 'paused');

    console.log(`⏸️  [Pause] Task ${req.params.id} paused by user ${req.user!.id}`);

    const { NotificationService } = await import('../../services/NotificationService');
    NotificationService.emitConsoleLog(
      req.params.id,
      'warn',
      '⏸️  Orchestration will pause after current phase completes'
    );

    res.json({
      success: true,
      message: 'Task will pause after current phase completes',
      data: {
        taskId: req.params.id,
        pausedAt: task.orchestration.pausedAt,
        currentPhase: task.orchestration.currentPhase,
      },
    });
  } catch (error) {
    console.error('Error pausing task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to pause task',
    });
  }
});

/**
 * POST /api/tasks/:id/resume
 * Resume a paused or failed orchestration
 */
router.post('/:id/resume', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    const isManuallyPaused = task.orchestration.paused === true;
    const isBillingPaused = task.status === 'paused';
    const isFailed = task.status === 'failed';
    const isInterrupted = task.status === 'interrupted';
    const teamOrch = (task.orchestration as any).teamOrchestration;
    const isBillingError = teamOrch?.pauseReason === 'billing_error';

    if (!isManuallyPaused && !isBillingPaused && !isFailed && !isInterrupted) {
      res.status(400).json({
        success: false,
        message: `Task cannot be resumed (status: ${task.status})`,
      });
      return;
    }

    // Handle failed/interrupted task resume
    if (isFailed || isInterrupted) {
      console.log(`\n🔄 [Resume] Resuming ${isFailed ? 'FAILED' : 'INTERRUPTED'} task ${req.params.id}`);

      const { OrchestrationRecoveryService } = await import('../../services/orchestration/OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      const result = await recoveryService.resumeFailedTask(req.params.id);

      if (!result.success) {
        res.status(400).json({
          success: false,
          message: result.message,
        });
        return;
      }

      res.json({
        success: true,
        message: result.message,
        data: {
          taskId: req.params.id,
          currentPhase: task.orchestration.currentPhase,
          resumeType: isFailed ? 'failed_task_recovery' : 'interrupted_task_recovery',
        },
      });
      return;
    }

    // 🔥 CENTRALIZED: Use ResumeService for all resume logic
    const resumeReason = isBillingError ? 'billing_recovery' : 'user_action';

    // Also clear team orchestration pause if needed
    if (teamOrch) {
      TaskRepository.modifyOrchestration(task.id, (orch) => ({
        ...orch,
        teamOrchestration: {
          ...(orch as any).teamOrchestration,
          status: 'in_progress',
          pauseReason: undefined,
          pausedAt: undefined,
        },
      }));
    }

    // Resume task via centralized service
    const resumeResult = await ResumeService.resumeTask(
      req.params.id,
      orchestrationCoordinator,
      { reason: resumeReason }
    );

    if (!resumeResult.success) {
      res.status(400).json({
        success: false,
        message: resumeResult.message,
      });
      return;
    }

    res.json({
      success: true,
      message: resumeResult.message,
      data: {
        taskId: req.params.id,
        currentPhase: resumeResult.currentPhase,
        billingRecovery: isBillingError,
        pendingEpics: teamOrch?.pendingEpicIds || [],
      },
    });
  } catch (error) {
    console.error('Error resuming task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resume task',
    });
  }
});

/**
 * POST /api/tasks/:id/cancel
 * Cancel an orchestration immediately (force stop)
 */
router.post('/:id/cancel', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    // 🔥 FIX: Allow canceling any task except completed/cancelled
    const nonCancellableStatuses = ['completed', 'cancelled'];
    if (nonCancellableStatuses.includes(task.status)) {
      res.status(400).json({
        success: false,
        message: `Cannot cancel task with status: ${task.status}`,
      });
      return;
    }

    TaskRepository.update(task.id, { status: 'cancelled' });
    TaskRepository.modifyOrchestration(task.id, (orch) => ({
      ...orch,
      cancelRequested: true,
      cancelRequestedAt: new Date(),
      cancelRequestedBy: req.user!.id,
      currentPhase: 'completed',
    }));

    console.log(`🛑 [Cancel] Task ${req.params.id} cancelled`);

    const { NotificationService } = await import('../../services/NotificationService');
    NotificationService.emitTaskFailed(req.params.id, {
      error: 'Task cancelled by user',
    });

    res.json({
      success: true,
      message: 'Task cancelled successfully',
      data: {
        taskId: req.params.id,
        cancelledAt: task.orchestration.cancelRequestedAt,
      },
    });
  } catch (error) {
    console.error('Error cancelling task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel task',
    });
  }
});

export default router;
