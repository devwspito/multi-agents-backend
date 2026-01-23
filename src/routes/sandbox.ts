/**
 * Sandbox Routes
 *
 * API endpoints for managing isolated Docker environments per task.
 * Similar to Codex/Devin sandbox architecture.
 */

import { Router, Request, Response } from 'express';
import { sandboxService } from '../services/SandboxService.js';
import { sandboxPoolService } from '../services/SandboxPoolService.js';

const router = Router();

/**
 * GET /api/sandbox/status
 * Get overall sandbox service status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    await sandboxService.initialize();
    const status = sandboxService.getStatus();

    // Convert Map to array for JSON serialization
    const sandboxList = Array.from(status.sandboxes.entries()).map(([taskId, instance]) => ({
      taskId,
      containerId: instance.containerId?.substring(0, 12),
      containerName: instance.containerName,
      image: instance.image,
      status: instance.status,
      createdAt: instance.createdAt,
      workspacePath: instance.workspacePath,
      mappedPorts: instance.mappedPorts,
    }));

    return res.json({
      success: true,
      dockerAvailable: status.dockerAvailable,
      dockerVersion: status.dockerVersion,
      activeSandboxes: status.activeSandboxes,
      sandboxes: sandboxList,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error getting status:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get sandbox status',
    });
  }
});

/**
 * POST /api/sandbox/create/:taskId
 * Create a new sandbox for a task
 */
router.post('/create/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { workspacePath, language, config } = req.body;

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'workspacePath is required',
      });
    }

    console.log(`[Sandbox API] Creating sandbox for task ${taskId}`);
    console.log(`   Workspace: ${workspacePath}`);
    console.log(`   Language: ${language || 'nodejs'}`);

    const instance = await sandboxService.createSandbox(
      taskId,
      workspacePath,
      language || 'nodejs',
      config
    );

    if (!instance) {
      return res.status(500).json({
        success: false,
        error: 'Failed to create sandbox. Docker may not be available.',
        dockerAvailable: sandboxService.isDockerAvailable(),
      });
    }

    return res.json({
      success: true,
      taskId,
      containerId: instance.containerId.substring(0, 12),
      containerName: instance.containerName,
      image: instance.image,
      status: instance.status,
      workspacePath: instance.workspacePath,
      mappedPorts: instance.mappedPorts,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error creating sandbox:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create sandbox',
    });
  }
});

/**
 * POST /api/sandbox/destroy/:taskId
 * Destroy a sandbox for a task
 */
router.post('/destroy/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[Sandbox API] Destroying sandbox for task ${taskId}`);

    const destroyed = await sandboxService.destroySandbox(taskId);

    return res.json({
      success: true,
      destroyed,
      taskId,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error destroying sandbox:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to destroy sandbox',
    });
  }
});

/**
 * GET /api/sandbox/:taskId
 * Get sandbox info for a specific task
 * Uses smart lookup to find sandboxes created with different ID patterns
 */
router.get('/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    // 🔍 Use centralized smart lookup from SandboxService
    const found = sandboxService.findSandboxForTask(taskId);

    if (!found) {
      return res.json({
        success: true,
        exists: false,
        taskId,
        message: 'No sandbox exists for this task',
      });
    }

    const { sandboxId: resolvedSandboxId, instance } = found;

    return res.json({
      success: true,
      exists: true,
      taskId,
      sandboxId: resolvedSandboxId, // Actual sandbox ID (may differ from taskId)
      containerId: instance.containerId?.substring(0, 12),
      containerName: instance.containerName,
      image: instance.image,
      status: instance.status,
      createdAt: instance.createdAt,
      workspacePath: instance.workspacePath,
      mappedPorts: instance.mappedPorts,
      config: {
        memoryLimit: instance.config.memoryLimit,
        cpuLimit: instance.config.cpuLimit,
        networkMode: instance.config.networkMode,
      },
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error getting sandbox:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get sandbox info',
    });
  }
});

/**
 * POST /api/sandbox/exec/:taskId
 * Execute a command in a sandbox
 */
router.post('/exec/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { command, cwd, timeout, env } = req.body;

    if (!command) {
      return res.status(400).json({
        success: false,
        error: 'command is required',
      });
    }

    console.log(`[Sandbox API] Executing in task ${taskId}: ${command.substring(0, 50)}...`);

    const result = await sandboxService.exec(taskId, command, {
      cwd,
      timeout,
      env,
    });

    return res.json({
      success: result.exitCode === 0,
      taskId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      duration: result.duration,
      executedIn: result.executedIn,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error executing command:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to execute command',
    });
  }
});

/**
 * POST /api/sandbox/setup/:taskId
 * Setup environment in a sandbox (install deps, configure .env)
 */
router.post('/setup/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { installCommand, envVars, envFilePath, postSetupCommands } = req.body;

    console.log(`[Sandbox API] Setting up environment for task ${taskId}`);

    const result = await sandboxService.setupEnvironment(taskId, {
      installCommand,
      envVars,
      envFilePath,
      postSetupCommands,
    });

    return res.json({
      success: result.success,
      taskId,
      logs: result.logs,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error setting up environment:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to setup environment',
    });
  }
});

/**
 * GET /api/sandbox/pool/:projectId/:repoName
 * Get pool status for a project+repo (useful for UI to show "Preparing environment...")
 */
router.get('/pool/:projectId/:repoName', async (req: Request, res: Response) => {
  try {
    const { projectId, repoName } = req.params;

    const status = sandboxPoolService.getPoolStatus(projectId, repoName);

    if (!status) {
      return res.json({
        success: true,
        exists: false,
        status: 'none',
        message: 'No sandbox pool exists for this project/repo',
      });
    }

    return res.json({
      success: true,
      exists: true,
      status: status.status,
      activeTasks: status.activeTasks,
      sandbox: status.sandbox ? {
        containerId: status.sandbox.containerId?.substring(0, 12),
        containerName: status.sandbox.containerName,
        image: status.sandbox.image,
        status: status.sandbox.status,
      } : null,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error getting pool status:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get pool status',
    });
  }
});

/**
 * POST /api/sandbox/cleanup
 * Cleanup all sandboxes (admin endpoint)
 */
router.post('/cleanup', async (_req: Request, res: Response) => {
  try {
    console.log(`[Sandbox API] Cleaning up all sandboxes`);

    await sandboxService.cleanup();

    return res.json({
      success: true,
      message: 'All sandboxes cleaned up',
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error cleaning up:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to cleanup sandboxes',
    });
  }
});

export default router;
