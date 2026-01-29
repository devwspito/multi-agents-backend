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
import { SandboxRepository } from '../database/repositories/SandboxRepository.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { SandboxPhase } from '../services/orchestration/SandboxPhase.js';
import { OrchestrationContext } from '../services/orchestration/Phase.js';
import { agentExecutorService } from '../services/orchestration/AgentExecutorService.js';

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
 * 🔥 EXECUTES SandboxPhase.execute() DIRECTLY - SAME AS ORCHESTRATOR
 */
router.post('/relaunch/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[Sandbox API] 🔄 Relaunch via SandboxPhase.execute() for ${taskId}`);

    // 1. Check if sandbox already running
    const existing = sandboxService.findSandboxForTask(taskId);
    if (existing?.instance.status === 'running') {
      return res.json({ success: true, reused: true, sandbox: existing.instance });
    }

    // 2. Check SQLite for persisted sandbox
    const savedSandbox = SandboxRepository.findByTaskId(taskId);
    if (savedSandbox) {
      const recovered = await sandboxService.findOrStartExistingSandbox(taskId, savedSandbox.workspacePath);
      if (recovered?.status === 'running') {
        return res.json({ success: true, reused: true, recovered: true, sandbox: recovered });
      }
    }

    // 3. Get task and create context - SAME AS ORCHESTRATOR
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    // Get workspace path from task.orchestration
    const workspacePath = (task.orchestration as any)?.workspacePath ||
      path.join(process.env.AGENT_WORKSPACE_PATH || os.homedir(), `task-${taskId}`);

    if (!fs.existsSync(workspacePath)) {
      return res.status(404).json({ success: false, error: `Workspace not found: ${workspacePath}` });
    }

    // Get repositories from task
    const repositories = (task.orchestration as any)?.repositories || [];

    // 4. Create OrchestrationContext - SAME AS ORCHESTRATOR
    const context = new OrchestrationContext(task, repositories, workspacePath);

    // 5. Create executeAgent wrapper - SAME AS ORCHESTRATOR
    const executeAgentWithContext = (
      agentType: string, prompt: string, agentWorkspacePath: string,
      agentTaskId?: string, agentName?: string, sessionId?: string,
      fork?: boolean, attachments?: any[], options?: any
    ) => agentExecutorService.executeAgent(
      agentType, prompt, agentWorkspacePath, agentTaskId,
      agentName, sessionId, fork, attachments, options, context
    );

    // 6. Create and execute SandboxPhase - SAME AS ORCHESTRATOR
    const sandboxPhase = new SandboxPhase(executeAgentWithContext);
    const result = await sandboxPhase.execute(context);

    if (result.success) {
      return res.json({
        success: true,
        reused: false,
        sandbox: { taskId, workspacePath, status: 'running' },
        servers: context.getData('devServerResults'),
      });
    } else {
      return res.status(500).json({ success: false, error: result.error });
    }

  } catch (error: any) {
    console.error('[Sandbox API] Error:', error);
    return res.status(500).json({ success: false, error: error.message });
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
    const { command, enableJudge, model, mode } = req.body;

    // 🔍 DEBUG: Log incoming request
    console.log(`[Sandbox API] 📥 Quick task request received`);
    console.log(`[Sandbox API]   taskId: ${taskId}`);
    console.log(`[Sandbox API]   body: ${JSON.stringify(req.body)}`);
    console.log(`[Sandbox API]   command: "${command}"`);

    // Validate required field
    if (!command || typeof command !== 'string' || command.trim().length === 0) {
      console.log(`[Sandbox API] ❌ Validation failed: command is missing or invalid`);
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "command" field. Provide the task description.',
      });
    }

    // Validate model if provided
    const validModels = ['opus', 'sonnet', 'haiku'];
    const selectedModel = validModels.includes(model) ? model : 'sonnet';

    // Validate mode if provided (Claude Code style modes)
    const validModes = ['code', 'explore', 'ask', 'plan'];
    const selectedMode = validModes.includes(mode) ? mode : 'code';

    console.log(`[Sandbox API] Quick task for ${taskId}: "${command.substring(0, 50)}..." | Model: ${selectedModel} | Mode: ${selectedMode}`);

    // Import QuickDevService dynamically to avoid circular dependencies
    const { quickDevService } = await import('../services/QuickDevService.js');

    // Execute the quick task (runs async, streams via WebSocket)
    // Don't await - return immediately and let WebSocket handle streaming
    quickDevService.executeQuickTask({
      taskId,
      command: command.trim(),
      enableJudge: enableJudge === true,
      model: selectedModel,
      mode: selectedMode as 'code' | 'explore' | 'ask' | 'plan',
    }).then(result => {
      console.log(`[Sandbox API] Quick task completed: success=${result.success}, model=${selectedModel}, mode=${selectedMode}`);
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
