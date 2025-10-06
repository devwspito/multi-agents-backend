import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Task } from '../models/Task';
import { AgentService } from '../services/AgentService';
import { z } from 'zod';

const router = Router();
const agentService = new AgentService();

// Validación schemas con Zod
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  projectId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * GET /api/tasks
 * Obtener todas las tareas del usuario
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, priority, projectId } = req.query;

    const filter: any = { userId: req.user!.id };

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (projectId) filter.projectId = projectId;

    const tasks = await Task.find(filter)
      .sort({ createdAt: -1 })
      .select('-__v')
      .lean();

    res.json({
      success: true,
      data: tasks,
      count: tasks.length,
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tasks',
    });
  }
});

/**
 * GET /api/tasks/:id
 * Obtener una tarea específica
 */
router.get('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    }).lean();

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error('Error fetching task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch task',
    });
  }
});

/**
 * POST /api/tasks
 * Crear una nueva tarea
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = createTaskSchema.parse(req.body);

    const task = await Task.create({
      ...validatedData,
      userId: req.user!.id,
      status: 'pending',
      orchestration: {
        pipeline: [],
        totalCost: 0,
        totalTokens: 0,
      },
    });

    res.status(201).json({
      success: true,
      data: task,
      message: 'Task created successfully',
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        message: 'Invalid task data',
        errors: error.errors,
      });
      return;
    }

    console.error('Error creating task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create task',
    });
  }
});

/**
 * POST /api/tasks/:id/start
 * Iniciar la orquestación de agentes para una tarea
 */
router.post('/:id/start', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    if (task.status === 'in_progress') {
      res.status(400).json({
        success: false,
        message: 'Task is already in progress',
      });
      return;
    }

    // Actualizar estado
    task.status = 'in_progress';
    await task.save();

    // Iniciar orquestación en background
    agentService
      .orchestrateTask(task._id.toString())
      .catch((error) => {
        console.error('Orchestration error:', error);
      });

    res.json({
      success: true,
      message: 'Task orchestration started',
      data: {
        taskId: task._id,
        status: task.status,
      },
    });
  } catch (error) {
    console.error('Error starting task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start task',
    });
  }
});

/**
 * GET /api/tasks/:id/status
 * Obtener el estado de la orquestación
 */
router.get('/:id/status', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('status orchestration')
      .lean();

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
        currentAgent: task.orchestration.currentAgent,
        pipeline: task.orchestration.pipeline.map((step) => ({
          agent: step.agent,
          status: step.status,
          startedAt: step.startedAt,
          completedAt: step.completedAt,
        })),
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
 * GET /api/tasks/:id/orchestration
 * Obtener detalles completos de la orquestación
 */
router.get('/:id/orchestration', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOne({
      _id: req.params.id,
      userId: req.user!.id,
    })
      .select('orchestration')
      .lean();

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

/**
 * DELETE /api/tasks/:id
 * Eliminar una tarea
 */
router.delete('/:id', authenticate, async (req: AuthRequest, res) => {
  try {
    const task = await Task.findOneAndDelete({
      _id: req.params.id,
      userId: req.user!.id,
    });

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete task',
    });
  }
});

export default router;
