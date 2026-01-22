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
  TaskRepository,
  RepositoryRepository,
  IRepository,
  createTaskSchema,
} from './shared';
import { ITask } from '../../database/repositories/TaskRepository.js';

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

    console.log('Tasks filter:', { userId: req.user.id, status, priority, projectId, repositoryId });

    // Get tasks for user with filters
    let tasks: ITask[] = TaskRepository.findByUserId(req.user.id);

    // Apply filters
    if (status && typeof status === 'string') {
      tasks = tasks.filter((t: ITask) => t.status === status);
    }
    if (priority && typeof priority === 'string') {
      tasks = tasks.filter((t: ITask) => t.priority === priority);
    }
    if (projectId && typeof projectId === 'string') {
      tasks = tasks.filter((t: ITask) => t.projectId === projectId);
    }
    if (repositoryId && typeof repositoryId === 'string') {
      tasks = tasks.filter((t: ITask) => t.repositoryIds?.includes(repositoryId));
    }

    // Sort by updatedAt descending and limit
    tasks = tasks
      .sort((a: ITask, b: ITask) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 50);

    console.log(`Tasks query successful: Found ${tasks.length} tasks`);

    return res.json({
      success: true,
      data: {
        tasks: tasks,
        pagination: {
          total: tasks.length,
          page: 1,
          limit: 50
        }
      },
      count: tasks.length,
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

    let repositoryIds: string[] = validatedData.repositoryIds || [];

    if (repositoryIds.length === 0) {
      console.log(`Task created without repository selection`);
    } else {
      console.log(`Task created with ${repositoryIds.length} selected repositories:`, repositoryIds);

      const validRepos = RepositoryRepository.findByIds(repositoryIds).filter(
        (repo: IRepository) => repo.isActive
      );

      if (validRepos.length !== repositoryIds.length) {
        console.warn(`Some selected repositories not found or inactive`);
        console.warn(`   Requested: ${repositoryIds.length}, Found: ${validRepos.length}`);
      }

      validRepos.forEach((repo: IRepository) => {
        console.log(`   - ${repo.name} (${repo.githubRepoName})`);
      });
    }

    const task = TaskRepository.create({
      ...validatedData,
      repositoryIds,
      userId: req.user!.id,
      orchestration: {
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
    const task = TaskRepository.findByIdAndUser(req.params.id, req.user!.id);

    if (!task) {
      res.status(404).json({
        success: false,
        message: 'Task not found',
      });
      return;
    }

    TaskRepository.delete(req.params.id);

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
