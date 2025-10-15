import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { Task } from '../models/Task';
import { TeamOrchestrator } from '../services/TeamOrchestrator';
import { z } from 'zod';

const router = Router();
const teamOrchestrator = new TeamOrchestrator();

// Validación schemas con Zod
const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(), // Opcional - se define en el chat
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  projectId: z.string().optional(),
  repositoryIds: z.array(z.string()).optional(), // Array de repository IDs
  tags: z.array(z.string()).optional(),
});

const startTaskSchema = z.object({
  description: z.string().min(1).optional(), // Descripción de la tarea desde el chat
  content: z.string().min(1).optional(), // Compatibilidad con mensajes
  instructions: z.string().optional(),
}).refine((data) => data.description || data.content, {
  message: "Either 'description' or 'content' must be provided",
  path: ['description'],
});

/**
 * GET /api/tasks
 * Obtener todas las tareas del usuario
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, priority, projectId, repositoryId } = req.query;

    const filter: any = { userId: req.user!.id };

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (projectId) filter.projectId = projectId;
    // Soporte para filtro por repositorio (singular o dentro del array)
    if (repositoryId) {
      filter.repositoryIds = repositoryId; // Mongoose busca automáticamente en el array
    }

    const tasks = await Task.find(filter)
      .populate('repositoryIds', 'name githubRepoName')
      .populate('projectId', 'name')
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
      data: {
        task: task,
      },
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
 * Recibe la descripción desde el primer mensaje del chat
 */
router.post('/:id/start', authenticate, async (req: AuthRequest, res) => {
  try {
    console.log('🔍 [START] Received body:', JSON.stringify(req.body, null, 2));
    console.log('🔍 [START] Task ID:', req.params.id);
    console.log('🔍 [START] description field:', req.body.description);
    console.log('🔍 [START] content field:', req.body.content);
    const validatedData = startTaskSchema.parse(req.body);

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

    // Actualizar descripción desde el chat y estado
    // Usar description si existe, si no usar content (compatibilidad)
    task.description = validatedData.description || validatedData.content || '';
    task.status = 'in_progress';
    await task.save();

    console.log(`🚀 Starting orchestration for task: ${task._id}`);
    console.log(`📝 Task description: ${task.description}`);

    // Iniciar orquestación con team building dinámico
    teamOrchestrator
      .orchestrateTask((task._id as any).toString())
      .catch((error) => {
        console.error('❌ Orchestration error:', error);
      });

    res.json({
      success: true,
      message: 'Dynamic team orchestration started',
      data: {
        taskId: (task._id as any).toString(),
        status: task.status,
        description: task.description,
        info: 'Team will be built dynamically based on task complexity',
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('🔍 [START] Validation error:', error.errors);
      res.status(400).json({
        success: false,
        message: 'Invalid start data - either description or content is required',
        errors: error.errors,
      });
      return;
    }

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
        currentPhase: task.orchestration.currentPhase,

        // Phase statuses
        productManager: task.orchestration.productManager?.status || 'pending',
        projectManager: task.orchestration.projectManager?.status || 'pending',
        techLead: task.orchestration.techLead?.status || 'pending',
        qaEngineer: task.orchestration.qaEngineer?.status || 'pending',
        mergeCoordinator: task.orchestration.mergeCoordinator?.status || 'pending',

        // Team info
        teamSize: task.orchestration.team?.length || 0,
        storiesCount: task.orchestration.projectManager?.totalStories || 0,

        // Metrics
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
