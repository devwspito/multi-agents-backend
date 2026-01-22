/**
 * Branch Cleanup Routes
 *
 * Manual cleanup endpoints to delete story/epic branches after PR merge
 * AND workspace cleanup for corrupted tasks
 */

import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../database/repositories/RepositoryRepository.js';
import { GitHubService } from '../services/GitHubService';
import { BranchCleanupService } from '../services/cleanup/BranchCleanupService';
import { WorkspaceCleanupService } from '../services/cleanup/WorkspaceCleanupService';
import path from 'path';
import os from 'os';

const router = Router();

/**
 * POST /api/cleanup/task/:taskId
 *
 * Clean up all branches (epic + stories) for a completed task
 * User should call this AFTER merging all epic PRs
 */
router.post('/task/:taskId', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { taskId } = req.params;
    const userId = (req as any).user.userId;

    // Get task
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Security check
    if (task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to clean up this task' });
    }

    // Check if task is completed
    if (task.status !== 'completed') {
      return res.status(400).json({
        error: 'Task is not completed yet',
        hint: 'Only completed tasks with merged PRs can be cleaned up',
      });
    }

    // Get repositories
    const repositories = RepositoryRepository.findByIds(task.repositoryIds || []);

    if (repositories.length === 0) {
      return res.status(400).json({ error: 'No repositories found for this task' });
    }

    // Setup GitHubService
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const githubService = new GitHubService(workspaceDir);
    const cleanupService = new BranchCleanupService(githubService);

    // Build branch mappings from task data
    const mappings = BranchCleanupService.buildBranchMappingsFromTask(task);

    if (mappings.size === 0) {
      return res.status(400).json({
        error: 'No branch mappings found',
        hint: 'Task may not have created any branches, or orchestration data is missing',
      });
    }

    console.log(`\n🧹 Starting cleanup for task ${taskId}`);
    console.log(`   Epics to clean: ${mappings.size}`);
    console.log(`   Repositories: ${repositories.map(r => r.name).join(', ')}`);

    const results = [];

    // Clean up each epic's branches
    for (const [epicId, mapping] of mappings.entries()) {
      console.log(`\n🧹 Cleaning epic: ${mapping.epicBranch}`);

      try {
        await cleanupService.cleanupAllBranchesForEpic(taskId, epicId, mapping);

        results.push({
          epicId,
          epicBranch: mapping.epicBranch,
          success: true,
          storyBranchesDeleted: mapping.storyBranches.length,
        });
      } catch (error: any) {
        console.error(`❌ Failed to clean epic ${mapping.epicBranch}: ${error.message}`);
        results.push({
          epicId,
          epicBranch: mapping.epicBranch,
          success: false,
          error: error.message,
        });
      }
    }

    const successfulCleanups = results.filter(r => r.success).length;
    const totalBranchesDeleted = results
      .filter(r => r.success)
      .reduce((sum, r: any) => sum + r.storyBranchesDeleted + 1, 0); // +1 for epic branch

    console.log(`\n✅ Cleanup complete for task ${taskId}`);
    console.log(`   Successful: ${successfulCleanups}/${results.length} epics`);
    console.log(`   Total branches deleted: ${totalBranchesDeleted}`);

    res.json({
      success: true,
      message: `Cleanup complete: ${totalBranchesDeleted} branches deleted`,
      results,
      summary: {
        totalEpics: mappings.size,
        successfulCleanups,
        failedCleanups: results.length - successfulCleanups,
        totalBranchesDeleted,
      },
    });
  } catch (error: any) {
    console.error('❌ Cleanup error:', error);
    res.status(500).json({
      error: 'Failed to clean up branches',
      message: error.message,
    });
  }
});

/**
 * POST /api/cleanup/epic/:taskId/:epicId
 *
 * Clean up branches for a specific epic only
 * Useful when you want to clean up one epic at a time
 */
router.post('/epic/:taskId/:epicId', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { taskId, epicId } = req.params;
    const userId = (req as any).user.userId;

    // Get task
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Security check
    if (task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to clean up this task' });
    }

    // Setup GitHubService
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const githubService = new GitHubService(workspaceDir);
    const cleanupService = new BranchCleanupService(githubService);

    // Build branch mappings
    const mappings = BranchCleanupService.buildBranchMappingsFromTask(task);
    const mapping = mappings.get(epicId);

    if (!mapping) {
      return res.status(404).json({
        error: 'Epic not found',
        hint: `No branch mapping found for epic ${epicId}`,
      });
    }

    console.log(`\n🧹 Cleaning epic: ${mapping.epicBranch}`);

    await cleanupService.cleanupAllBranchesForEpic(taskId, epicId, mapping);

    const totalBranchesDeleted = mapping.storyBranches.length + 1; // +1 for epic branch

    return res.json({
      success: true,
      message: `Cleanup complete: ${totalBranchesDeleted} branches deleted`,
      epicId,
      epicBranch: mapping.epicBranch,
      storyBranchesDeleted: mapping.storyBranches.length,
      totalBranchesDeleted,
    });
  } catch (error: any) {
    console.error('❌ Cleanup error:', error);
    return res.status(500).json({
      error: 'Failed to clean up epic branches',
      message: error.message,
    });
  }
});

/**
 * GET /api/cleanup/preview/:taskId
 *
 * Preview what branches would be deleted without actually deleting them
 * Useful to check before running cleanup
 */
router.get('/preview/:taskId', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { taskId } = req.params;
    const userId = (req as any).user.userId;

    // Get task
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Security check
    if (task.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized to view this task' });
    }

    // Build branch mappings
    const mappings = BranchCleanupService.buildBranchMappingsFromTask(task);

    if (mappings.size === 0) {
      return res.json({
        message: 'No branches to clean up',
        epics: [],
        totalBranches: 0,
      });
    }

    const preview = [];
    let totalBranches = 0;

    for (const [epicId, mapping] of mappings.entries()) {
      const epicPreview = {
        epicId,
        epicBranch: mapping.epicBranch,
        repository: mapping.targetRepository,
        pullRequestNumber: mapping.epicPullRequestNumber,
        storyBranches: mapping.storyBranches.map(s => ({
          storyId: s.storyId,
          branchName: s.branchName,
          pullRequestNumber: s.pullRequestNumber,
          merged: s.merged,
        })),
        branchesToDelete: [
          mapping.epicBranch,
          ...mapping.storyBranches.map(s => s.branchName),
        ],
        totalBranchCount: mapping.storyBranches.length + 1,
      };

      preview.push(epicPreview);
      totalBranches += epicPreview.totalBranchCount;
    }

    return res.json({
      message: `Preview: ${totalBranches} branches would be deleted across ${mappings.size} epic(s)`,
      taskId,
      taskStatus: task.status,
      epics: preview,
      totalBranches,
      summary: {
        totalEpics: mappings.size,
        totalStoryBranches: totalBranches - mappings.size,
        totalEpicBranches: mappings.size,
      },
    });
  } catch (error: any) {
    console.error('❌ Preview error:', error);
    return res.status(500).json({
      error: 'Failed to preview cleanup',
      message: error.message,
    });
  }
});

/**
 * POST /api/cleanup/scheduled/run
 *
 * Manually trigger scheduled cleanup (for testing or on-demand cleanup)
 * Admin only
 */
router.post('/scheduled/run', authenticate, async (_req: Request, res: Response): Promise<any> => {
  try {
    const { scheduledCleanup } = await import('../services/cleanup/ScheduledBranchCleanup');

    console.log('🧹 Manual cleanup triggered');

    // Run in background
    setImmediate(async () => {
      try {
        const result = await scheduledCleanup.runCleanup();
        console.log(`✅ Manual cleanup complete: ${result.branchesDeleted} branches deleted`);
      } catch (error) {
        console.error('❌ Manual cleanup failed:', error);
      }
    });

    res.json({
      message: 'Scheduled cleanup started in background',
      info: 'Check server logs for progress',
    });
  } catch (error: any) {
    console.error('❌ Failed to start cleanup:', error);
    res.status(500).json({
      error: 'Failed to start scheduled cleanup',
      message: error.message,
    });
  }
});

/**
 * GET /api/cleanup/scheduled/status
 *
 * Get status of scheduled cleanup
 */
router.get('/scheduled/status', authenticate, async (_req: Request, res: Response): Promise<any> => {
  try {
    const { scheduledCleanup } = await import('../services/cleanup/ScheduledBranchCleanup');
    const status = scheduledCleanup.getStatus();

    res.json({
      ...status,
      info: 'Scheduled cleanup runs daily at 2:00 AM to clean up old branches',
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get cleanup status',
      message: error.message,
    });
  }
});

// ============================================================================
// WORKSPACE CLEANUP ROUTES
// ============================================================================

/**
 * GET /api/cleanup/workspaces/scan
 *
 * Scan for corrupted workspaces (tasks with system repositories assigned)
 * Returns list of corrupted tasks without making any changes
 */
router.get('/workspaces/scan', authenticate, async (_req: Request, res: Response): Promise<any> => {
  try {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanupService = new WorkspaceCleanupService(workspaceDir);

    console.log('\n🔍 Starting workspace corruption scan...');

    const corruptedTasks = await cleanupService.findCorruptedWorkspaces();

    res.json({
      success: true,
      message: `Found ${corruptedTasks.length} corrupted workspace(s)`,
      corruptedTasksCount: corruptedTasks.length,
      corruptedTasks: corruptedTasks.map(task => ({
        taskId: task.taskId,
        title: task.title,
        status: task.status,
        corruptedRepos: task.corruptedRepos,
        workspacePath: task.workspacePath,
        createdAt: task.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('❌ Workspace scan error:', error);
    res.status(500).json({
      error: 'Failed to scan for corrupted workspaces',
      message: error.message,
    });
  }
});

/**
 * POST /api/cleanup/workspaces/cleanup
 *
 * Clean up all corrupted workspaces (deletes workspace directories)
 * Query params:
 *   - dryRun=true: Preview what would be deleted without actually deleting
 */
router.post('/workspaces/cleanup', authenticate, async (req: Request, res: Response) => {
  try {
    const dryRun = req.query.dryRun === 'true';

    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanupService = new WorkspaceCleanupService(workspaceDir);

    console.log(`\n🧹 Starting workspace cleanup (dryRun: ${dryRun})...`);

    const result = await cleanupService.cleanupAllCorruptedWorkspaces(dryRun);

    res.json({
      success: true,
      dryRun,
      message: dryRun
        ? `DRY RUN: ${result.corruptedTasksFound} workspace(s) would be deleted`
        : `Cleanup complete: ${result.workspacesDeleted} workspace(s) deleted`,
      result: {
        totalTasksScanned: result.totalTasksScanned,
        corruptedTasksFound: result.corruptedTasksFound,
        workspacesDeleted: result.workspacesDeleted,
        errors: result.errors,
        corruptedTasks: result.corruptedTasks.map(task => ({
          taskId: task.taskId,
          title: task.title,
          status: task.status,
          corruptedRepos: task.corruptedRepos,
        })),
      },
    });
  } catch (error: any) {
    console.error('❌ Workspace cleanup error:', error);
    res.status(500).json({
      error: 'Failed to clean up corrupted workspaces',
      message: error.message,
    });
  }
});

/**
 * POST /api/cleanup/workspaces/validate
 *
 * Validate that repository IDs don't point to system repositories
 * Use this before creating a task to prevent corruption
 *
 * Body: { repositoryIds: string[] }
 */
router.post('/workspaces/validate', authenticate, async (req: Request, res: Response): Promise<any> => {
  try {
    const { repositoryIds } = req.body;

    if (!repositoryIds || !Array.isArray(repositoryIds)) {
      return res.status(400).json({
        error: 'repositoryIds must be an array',
      });
    }

    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanupService = new WorkspaceCleanupService(workspaceDir);

    const validation = await cleanupService.validateRepositoryIds(repositoryIds);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        valid: false,
        error: 'System repositories detected',
        message: `Cannot use system repositories: ${validation.invalidRepos.join(', ')}`,
        invalidRepos: validation.invalidRepos,
        hint: 'System repositories (multi-agents-backend, mult-agents-frontend) cannot be used in tasks',
      });
    }

    return res.json({
      success: true,
      valid: true,
      message: 'Repository IDs are valid',
    });
  } catch (error: any) {
    console.error('❌ Validation error:', error);
    return res.status(500).json({
      error: 'Failed to validate repository IDs',
      message: error.message,
    });
  }
});

export default router;
