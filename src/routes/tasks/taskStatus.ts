/**
 * Task Status Router
 *
 * Status and monitoring endpoints:
 * - GET /:id/status        - Get task status
 * - GET /:id/logs          - Get task logs
 * - GET /:id/orchestration - Get orchestration details
 */

import {
  Router,
  authenticate,
  AuthRequest,
  TaskRepository,
} from './shared';

const router = Router();

/**
 * GET /api/tasks/:id/status
 * Get task execution status
 */
router.get('/:id/status', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        status: task.status,
        currentPhase: task.orchestration.currentPhase,
        planning: task.orchestration.planning?.status || 'pending',
        techLead: task.orchestration.techLead?.status || 'pending',
        judge: task.orchestration.judge?.status || 'pending',
        autoMerge: task.orchestration.autoMerge?.status || 'pending',
        teamSize: task.orchestration.team?.length || 0,
        epicsCount: task.orchestration.planning?.epics?.length || 0,
        totalCost: task.orchestration.totalCost,
        totalTokens: task.orchestration.totalTokens,
      },
    });
  } catch (error) {
    console.error('Error fetching task status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task status',
    });
  }
});

/**
 * GET /api/tasks/:id/logs
 * Get historical logs for the task
 */
router.get('/:id/logs', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        logs: task.logs || [],
      },
    });
  } catch (error) {
    console.error('Error fetching task logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task logs',
    });
  }
});

/**
 * GET /api/tasks/:id/orchestration
 * Get full orchestration details
 */
router.get('/:id/orchestration', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: task.orchestration,
    });
  } catch (error) {
    console.error('Error fetching orchestration:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch orchestration details',
    });
  }
});

export default router;
