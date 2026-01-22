/**
 * Task CRUD Router
 *
 * Basic CRUD operations for tasks:
 * - GET /          - List tasks
 * - GET /:id       - Get single task
 * - POST /         - Create task
 * - DELETE /:id    - Delete task
 */

import {
  Router,
  z,
  authenticate,
  AuthRequest,
  Task,
  Repository,
  createTaskSchema,
} from './shared';

const router = Router();

/**
 * GET /api/tasks
 * Get all tasks for the authenticated user
 */
router.get('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { status, priority, projectId, repositoryId } = req.query;

    if (!req.user || !req.user.id) {
      console.error('No user found in request after authentication');
      return res.status(401).json({
        success: false,
        message: 'User not authenticated properly'
      });
    }

    const filter: any = { userId: req.user.id };

    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (projectId) filter.projectId = projectId;
    if (repositoryId) {
      filter.repositoryIds = repositoryId;
    }

    console.log('Tasks filter:', filter);

    let tasks = [];
    try {
      const query = Task.find(filter)
        .select('_id title description status priority projectId repositoryIds tags createdAt updatedAt')
        .sort({ updatedAt: -1 })
        .limit(50)
        .lean();

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), 10000)
      );

      tasks = await Promise.race([query.exec(), timeoutPromise]) as any[];
      console.log(`Tasks query successful: Found ${tasks?.length || 0} tasks`);
    } catch (dbError: any) {
      console.error('Tasks database error:', dbError);
      tasks = [];
    }

    return res.json({
      success: true,
      data: {
        tasks: tasks || [],
        pagination: {
          total: tasks?.length || 0,
          page: 1,
          limit: 50
        }
      },
      count: tasks?.length || 0,
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch tasks',
    });
  }
});

/**
 * GET /api/tasks/:id
 * Get a specific task
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
 * Create a new task
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const validatedData = createTaskSchema.parse(req.body);

    let repositoryIds: any[] = validatedData.repositoryIds || [];

    if (repositoryIds.length === 0) {
      console.log(`⚠️ Task created without repository selection`);
    } else {
      console.log(`✅ Task created with ${repositoryIds.length} selected repositories:`, repositoryIds);

      const validRepos = await Repository.find({
        _id: { $in: repositoryIds },
        isActive: true,
      }).select('_id name githubRepoName');

      if (validRepos.length !== repositoryIds.length) {
        console.warn(`⚠️ Some selected repositories not found or inactive`);
        console.warn(`   Requested: ${repositoryIds.length}, Found: ${validRepos.length}`);
      }

      validRepos.forEach(repo => {
        console.log(`   - ${repo.name} (${repo.githubRepoName})`);
      });
    }

    const task = await Task.create({
      ...validatedData,
      repositoryIds,
      userId: req.user!.id,
      status: 'pending',
      orchestration: {
        pipeline: [],
        totalCost: 0,
        totalTokens: 0,
        modelConfig: {
          preset: validatedData.modelConfig || 'standard',
        },
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
 * DELETE /api/tasks/:id
 * Delete a task
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
