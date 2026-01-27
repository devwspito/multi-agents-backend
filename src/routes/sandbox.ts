/**
 * Sandbox Routes
 *
 * API endpoints for managing isolated Docker environments per task.
 * Similar to Codex/Devin sandbox architecture.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { sandboxService } from '../services/SandboxService.js';
import { sandboxPoolService } from '../services/SandboxPoolService.js';
import { eventStore } from '../services/EventStore.js';

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
 *
 * Query params:
 * - includeWorkspace: boolean (default: false) - Also delete the task's workspace directory
 */
router.post('/destroy/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const includeWorkspace = req.query.includeWorkspace === 'true';

    console.log(`[Sandbox API] Destroying sandbox for task ${taskId} (includeWorkspace: ${includeWorkspace})`);

    const destroyed = await sandboxService.destroySandbox(taskId);

    let workspaceDeleted = false;

    // Optionally clean up workspace directory
    if (includeWorkspace) {
      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
      const taskWorkspace = path.join(workspaceDir, `task-${taskId}`);

      try {
        if (fs.existsSync(taskWorkspace)) {
          fs.rmSync(taskWorkspace, { recursive: true, force: true });
          workspaceDeleted = true;
          console.log(`   🗑️ Deleted workspace: task-${taskId}`);
        }
      } catch (err: any) {
        console.warn(`   ⚠️ Failed to delete workspace: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      destroyed,
      taskId,
      workspaceDeleted,
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
 * POST /api/sandbox/relaunch/:taskId
 * Re-launch a sandbox for an existing task (even if completed/failed days ago)
 *
 * This allows users to:
 * - Revisit completed projects in IDE + Preview
 * - Make quick changes via Lite Team
 * - Manually edit and commit/push
 *
 * The workspace directory must still exist on disk.
 */
router.post('/relaunch/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { startDevServer = false } = req.body;

    console.log(`[Sandbox API] 🔄 Relaunch requested for task ${taskId}`);

    // 1. Check if sandbox already exists and is running
    const existing = sandboxService.findSandboxForTask(taskId);
    if (existing && existing.instance.status === 'running') {
      console.log(`   ✅ Sandbox already running: ${existing.instance.containerId?.substring(0, 12)}`);
      return res.json({
        success: true,
        reused: true,
        sandbox: {
          taskId,
          containerId: existing.instance.containerId?.substring(0, 12),
          containerName: existing.instance.containerName,
          status: existing.instance.status,
          workspacePath: existing.instance.workspacePath,
          mappedPorts: existing.instance.mappedPorts,
        },
      });
    }

    // 2. Get workspace info from EventStore
    console.log(`   📂 Getting EventStore state for task ${taskId}...`);
    const state = await eventStore.getCurrentState(taskId);
    const workspace = state.workspaces?.[0];
    console.log(`   📂 Workspaces found: ${state.workspaces?.length || 0}`);

    if (!workspace) {
      console.log(`   ❌ No workspace found in EventStore!`);
      return res.status(404).json({
        success: false,
        error: 'No workspace found in EventStore for this task. The task may not have been executed yet.',
      });
    }

    const workspacePath = workspace.repoLocalPath || workspace.workspacePath;
    console.log(`   📁 Workspace path: ${workspacePath}`);

    // 3. Verify workspace directory exists on disk
    if (!fs.existsSync(workspacePath)) {
      console.log(`   ❌ Workspace directory NOT FOUND on disk: ${workspacePath}`);
      return res.status(404).json({
        success: false,
        error: `Workspace directory not found: ${workspacePath}. It may have been deleted.`,
      });
    }

    console.log(`   ✅ Workspace found: ${workspacePath}`);

    // 4. Detect language/framework from workspace
    let language = 'nodejs';
    if (fs.existsSync(path.join(workspacePath, 'pubspec.yaml'))) {
      language = 'flutter';
    } else if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
      language = 'nodejs';
    } else if (fs.existsSync(path.join(workspacePath, 'requirements.txt'))) {
      language = 'python';
    }

    console.log(`   🔧 Detected language: ${language}`);

    // 5. Create new sandbox with existing workspace
    console.log(`   🐳 Creating sandbox for task ${taskId}...`);
    console.log(`      - workspacePath: ${workspacePath}`);
    console.log(`      - language: ${language}`);
    console.log(`      - targetRepository: ${workspace.targetRepository || 'none'}`);

    const instance = await sandboxService.createSandbox(
      taskId,
      workspacePath,
      language,
      undefined, // Use default config
      workspace.targetRepository || undefined
    );

    if (!instance) {
      console.log(`   ❌ createSandbox returned null/undefined!`);
      return res.status(500).json({
        success: false,
        error: 'Failed to create sandbox. Docker may not be available.',
      });
    }

    console.log(`   ✅ Sandbox relaunched successfully!`);
    console.log(`      - containerId: ${instance.containerId?.substring(0, 12)}`);
    console.log(`      - containerName: ${instance.containerName}`);
    console.log(`      - status: ${instance.status}`);

    // 6. Optionally start dev server
    let devServerStarted = false;
    if (startDevServer) {
      try {
        const envConfig = state.environmentConfig || {};
        const firstConfig = Object.values(envConfig)[0] as any;
        const devCmd = firstConfig?.devCmd;

        if (devCmd) {
          console.log(`   🚀 Starting dev server: ${devCmd}`);
          // Run in background (don't await)
          sandboxService.exec(taskId, `cd /workspace && ${devCmd}`, { timeout: 300000 })
            .catch(err => console.warn(`   ⚠️ Dev server error: ${err.message}`));
          devServerStarted = true;
        }
      } catch (err: any) {
        console.warn(`   ⚠️ Could not start dev server: ${err.message}`);
      }
    }

    return res.json({
      success: true,
      reused: false,
      devServerStarted,
      sandbox: {
        taskId,
        containerId: instance.containerId?.substring(0, 12),
        containerName: instance.containerName,
        status: instance.status,
        workspacePath: instance.workspacePath,
        mappedPorts: instance.mappedPorts,
        language,
      },
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error relaunching sandbox:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to relaunch sandbox',
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
 *
 * Query params:
 * - includeWorkspaces: boolean (default: false) - Also delete agent-workspace directories
 */
router.post('/cleanup', async (req: Request, res: Response) => {
  try {
    const includeWorkspaces = req.query.includeWorkspaces === 'true';

    console.log(`[Sandbox API] Cleaning up all sandboxes (includeWorkspaces: ${includeWorkspaces})`);

    // 1. Destroy all Docker containers
    await sandboxService.cleanup();

    const result: {
      containersDestroyed: boolean;
      workspacesDeleted?: number;
      workspaceErrors?: string[];
    } = {
      containersDestroyed: true,
    };

    // 2. Optionally clean up workspaces
    if (includeWorkspaces) {
      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

      try {
        if (fs.existsSync(workspaceDir)) {
          const entries = fs.readdirSync(workspaceDir);
          let deletedCount = 0;
          const errors: string[] = [];

          for (const entry of entries) {
            // Delete task-* directories (all workspaces are task-based)
            // Also delete legacy project-* directories for cleanup
            if (entry.startsWith('task-') || entry.startsWith('project-')) {
              const fullPath = path.join(workspaceDir, entry);
              try {
                fs.rmSync(fullPath, { recursive: true, force: true });
                deletedCount++;
                console.log(`   🗑️ Deleted workspace: ${entry}`);
              } catch (err: any) {
                errors.push(`${entry}: ${err.message}`);
              }
            }
          }

          result.workspacesDeleted = deletedCount;
          result.workspaceErrors = errors.length > 0 ? errors : undefined;
          console.log(`   ✅ Deleted ${deletedCount} workspace(s)`);
        }
      } catch (err: any) {
        result.workspaceErrors = [`Failed to read workspace dir: ${err.message}`];
      }
    }

    return res.json({
      success: true,
      message: includeWorkspaces
        ? `All sandboxes and ${result.workspacesDeleted || 0} workspaces cleaned up`
        : 'All sandboxes cleaned up',
      ...result,
    });
  } catch (error: any) {
    console.error('[Sandbox API] Error cleaning up:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to cleanup sandboxes',
    });
  }
});

/**
 * POST /api/sandbox/quick-task/:taskId
 * Execute a quick developer task in the sandbox (Lite Team feature)
 *
 * This runs OUTSIDE the orchestrator - no epic/story required.
 * The agent will:
 * 1. Execute the user's task (NO commit/push - user does manually)
 * 2. Stream output via WebSocket
 *
 * @body command - Task description (required)
 * @body model - Model to use: 'opus' | 'sonnet' | 'haiku' (default: sonnet)
 * @body enableJudge - Run Judge review after (optional)
 */
router.post('/quick-task/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { command, enableJudge, model } = req.body;

    // Validate required field
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "command" field. Provide the task description.',
      });
    }

    // Validate model if provided
    const validModels = ['opus', 'sonnet', 'haiku'];
    const selectedModel = validModels.includes(model) ? model : 'sonnet';

    console.log(`[Sandbox API] Quick task for ${taskId}: "${command.substring(0, 50)}..." | Model: ${selectedModel}`);

    // Import QuickDevService dynamically to avoid circular dependencies
    const { quickDevService } = await import('../services/QuickDevService.js');

    // Execute the quick task (runs async, streams via WebSocket)
    // Don't await - return immediately and let WebSocket handle streaming
    quickDevService.executeQuickTask({
      taskId,
      command: command.trim(),
      enableJudge: enableJudge === true,
      model: selectedModel,
    }).then(result => {
      console.log(`[Sandbox API] Quick task completed: success=${result.success}, model=${selectedModel}`);
    }).catch(err => {
      console.error(`[Sandbox API] Quick task failed:`, err);
    });

    // Return immediately - output will stream via WebSocket
    return res.json({
      success: true,
      message: 'Quick task started. Output will stream via WebSocket.',
      taskId,
      command: command.trim(),
      model: selectedModel,
    });

  } catch (error: any) {
    console.error('[Sandbox API] Error starting quick task:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start quick task',
    });
  }
});

export default router;
