/**
 * Dev Server Routes
 *
 * Endpoints for managing development server instances for LivePreview.
 * These are user-initiated actions, separate from agent orchestration.
 */

import { Router, Request, Response } from 'express';
import devServerService from '../services/DevServerService.js';
import { eventStore } from '../services/EventStore.js';
import { unifiedMemoryService } from '../services/UnifiedMemoryService.js';
import { sandboxService } from '../services/SandboxService.js';

const router = Router();

/**
 * POST /api/dev-server/start/:taskId
 * Start a dev server for a specific task's workspace
 */
router.post('/start/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { workspacePath, framework } = req.body;

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'workspacePath is required',
      });
    }

    console.log(`[DevServer API] Starting server for task ${taskId}`);
    console.log(`   Workspace: ${workspacePath}`);

    const result = await devServerService.startServer(taskId, workspacePath, framework);

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Could not start dev server. Framework not detected.',
      });
    }

    return res.json({
      success: true,
      url: result.url,
      framework: result.framework,
      taskId,
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error starting server:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start dev server',
    });
  }
});

/**
 * POST /api/dev-server/stop/:taskId
 * Stop the dev server for a specific task
 */
router.post('/stop/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[DevServer API] Stopping server for task ${taskId}`);

    const stopped = devServerService.stopServer(taskId);

    return res.json({
      success: true,
      stopped,
      taskId,
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error stopping server:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to stop dev server',
    });
  }
});

/**
 * GET /api/dev-server/status/:taskId
 * Get the status of a dev server for a specific task
 */
router.get('/status/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    const status = devServerService.getServerStatus(taskId);

    // 🐳 Also check for sandbox availability (even if no server running)
    const sandbox = sandboxService.findSandboxForTask(taskId);

    if (!status) {
      // No server running, but check if sandbox exists
      if (sandbox && sandbox.instance.status === 'running') {
        return res.json({
          success: true,
          running: false,
          taskId,
          // 🐳 Sandbox info for frontend to enable "Start Preview" button
          sandbox: {
            available: true,
            sandboxId: sandbox.sandboxId,
            containerName: sandbox.instance.containerName,
            status: sandbox.instance.status,
          },
        });
      }

      return res.json({
        success: true,
        running: false,
        taskId,
        sandbox: {
          available: false,
        },
      });
    }

    return res.json({
      success: true,
      running: true,
      taskId,
      url: status.url,
      framework: status.framework,
      port: status.port,
      startedAt: status.startedAt,
      // 🐳 Docker info
      isDocker: status.isDocker || false,
      containerName: status.containerName,
      sandbox: sandbox ? {
        available: true,
        sandboxId: sandbox.sandboxId,
        containerName: sandbox.instance.containerName,
        status: sandbox.instance.status,
      } : { available: false },
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error getting status:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get dev server status',
    });
  }
});

/**
 * GET /api/dev-server/sandboxes/:taskId
 * List all available sandboxes for a task (for preview selection)
 */
router.get('/sandboxes/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    const sandboxes = sandboxService.getAllSandboxesForTask(taskId);

    if (sandboxes.length === 0) {
      return res.json({
        success: true,
        taskId,
        sandboxes: [],
        message: 'No sandboxes found for this task',
      });
    }

    return res.json({
      success: true,
      taskId,
      sandboxes: sandboxes.map(s => ({
        sandboxId: s.sandboxId,
        containerName: s.instance.containerName,
        image: s.instance.image,
        status: s.instance.status,
        type: s.instance.sandboxType || 'unknown',
        repoName: s.instance.repoName || 'unknown',
        mappedPorts: s.instance.mappedPorts || {},
      })),
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error listing sandboxes:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to list sandboxes',
    });
  }
});

/**
 * GET /api/dev-server/detect/:taskId
 * Detect the framework in a workspace without starting the server
 */
router.post('/detect', async (req: Request, res: Response) => {
  try {
    const { workspacePath } = req.body;

    if (!workspacePath) {
      return res.status(400).json({
        success: false,
        error: 'workspacePath is required',
      });
    }

    const detected = devServerService.detectFramework(workspacePath);

    if (!detected) {
      return res.json({
        success: true,
        detected: false,
        message: 'No supported framework detected',
      });
    }

    return res.json({
      success: true,
      detected: true,
      framework: detected.framework,
      command: detected.command,
      port: detected.port,
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error detecting framework:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to detect framework',
    });
  }
});

/**
 * GET /api/dev-server/list
 * List all running dev servers
 */
router.get('/list', async (_req: Request, res: Response) => {
  try {
    const servers = devServerService.getAllServers();

    const serverList = Array.from(servers.entries()).map(([taskId, instance]) => ({
      taskId,
      url: instance.url,
      framework: instance.framework,
      port: instance.port,
      startedAt: instance.startedAt,
    }));

    return res.json({
      success: true,
      count: serverList.length,
      servers: serverList,
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error listing servers:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to list dev servers',
    });
  }
});

/**
 * GET /api/dev-server/workspace/:taskId
 * Get ALL workspace info for a task from EventStore
 *
 * This endpoint allows LivePreview to work even when task is completed,
 * by fetching workspace paths from stored events.
 *
 * Returns multiple workspaces if task has multiple repos (frontend, backend, etc.)
 */
router.get('/workspace/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[DevServer API] Getting workspace info for task ${taskId}`);

    // 1. Get from EventStore (source of truth - persisted)
    const state = await eventStore.getCurrentState(taskId);

    // 🔥 NEW: Return ALL workspaces from EventStore
    if (state && state.workspaces && state.workspaces.length > 0) {
      // Enrich workspaces with epic info and SDK requirements
      const enrichedWorkspaces = state.workspaces.map((ws: any) => {
        const epic = state.epics.find((e: any) => e.id === ws.epicId);
        const story = state.stories.find((s: any) => s.id === ws.storyId);

        // Find SDK/framework info from environmentConfig
        const repoName = ws.targetRepository?.split('/').pop() || 'unknown';
        const envConfig = state.environmentConfig?.[repoName] ||
                         state.environmentConfig?.backend ||
                         state.environmentConfig?.frontend;

        // Check if SDK is available
        const sdkLanguage = envConfig?.language || 'nodejs';
        const sdkCheck = devServerService.checkSdk(sdkLanguage);

        return {
          ...ws,
          epicName: epic?.name || null,
          storyTitle: story?.title || ws.storyTitle || null,
          branchName: epic?.branchName || null,
          status: story?.status || 'unknown',
          // 🔥 NEW: SDK info for LivePreview
          sdk: {
            language: envConfig?.language || null,
            framework: envConfig?.framework || null,
            runCommand: envConfig?.runCommand || null,
            available: sdkCheck.available,
            path: sdkCheck.path || null,
            version: sdkCheck.version || null,
            installInstructions: sdkCheck.installInstructions || null,
          },
        };
      });

      return res.json({
        success: true,
        taskId,
        workspaceCount: enrichedWorkspaces.length,
        workspaces: enrichedWorkspaces,
        // For backwards compatibility, also include first workspace as 'workspace'
        workspace: enrichedWorkspaces[0] || null,
        // 🔥 NEW: Environment config summary
        environmentConfig: state.environmentConfig || null,
        source: 'event_store',
      });
    }

    // 2. Fallback: Build workspaces from stories that have workspacePath
    if (state && state.stories.length > 0) {
      const storiesWithWorkspace = state.stories.filter((s: any) => s.workspacePath);

      if (storiesWithWorkspace.length > 0) {
        // Group by targetRepository to avoid duplicates
        const workspaceMap = new Map<string, any>();
        for (const story of storiesWithWorkspace) {
          const key = story.targetRepository || story.workspacePath || story.id;
          if (key && !workspaceMap.has(key)) {
            const epic = state.epics.find((e: any) => e.id === story.epicId);
            workspaceMap.set(key, {
              workspacePath: story.workspacePath,
              repoLocalPath: story.repoLocalPath,
              targetRepository: story.targetRepository,
              epicId: story.epicId,
              epicName: epic?.name || null,
              storyId: story.id,
              storyTitle: story.title,
              branchName: story.branchName,
              status: story.status,
            });
          }
        }

        const workspaces = Array.from(workspaceMap.values());

        return res.json({
          success: true,
          taskId,
          workspaceCount: workspaces.length,
          workspaces,
          workspace: workspaces[0] || null,
          source: 'event_store_stories',
        });
      }
    }

    // 3. Fallback: Try UnifiedMemoryService (in-memory, may be lost on restart)
    const workspaceInfo = unifiedMemoryService.getWorkspaceForTask(taskId);

    if (workspaceInfo) {
      return res.json({
        success: true,
        taskId,
        workspaceCount: 1,
        workspaces: [workspaceInfo],
        workspace: workspaceInfo,
        source: 'unified_memory',
      });
    }

    // 4. Last resort: Return epic info without workspace path
    if (state && state.epics.length > 0) {
      const epicsWithRepo = state.epics.filter((e: any) => e.targetRepository);

      if (epicsWithRepo.length > 0) {
        const workspaces = epicsWithRepo.map((epic: any) => ({
          workspacePath: null, // Unknown - task may need to be resumed
          targetRepository: epic.targetRepository,
          epicId: epic.id,
          epicName: epic.name,
          branchName: epic.branchName,
          status: epic.status,
          note: 'Workspace path not available - task may need resume to get workspace',
        }));

        return res.json({
          success: true,
          taskId,
          workspaceCount: workspaces.length,
          workspaces,
          workspace: workspaces[0] || null,
          source: 'event_store_epics_only',
          message: 'Workspace paths not yet available - developers have not started',
        });
      }
    }

    // No workspace found
    return res.json({
      success: true,
      taskId,
      workspaceCount: 0,
      workspaces: [],
      workspace: null,
      message: 'No workspace found for this task',
    });

  } catch (error: any) {
    console.error(`[DevServer API] Error getting workspace:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get workspace info',
    });
  }
});

/**
 * 🐳 POST /api/dev-server/start-preview/:taskId
 * Start a preview server directly from Docker sandbox
 *
 * This endpoint:
 * 1. Finds the running Docker sandbox for the task
 * 2. Detects the framework inside /workspace
 * 3. Starts the dev server inside Docker
 * 4. Returns the URL (works with networkMode: 'host')
 *
 * No workspacePath needed - uses the mounted /workspace in container
 */
router.post('/start-preview/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { framework, port, type, repoName } = req.body;  // 🆕 Accept type and repoName

    console.log(`🐳 [DevServer API] Starting preview for task ${taskId}`);
    console.log(`   Requested type: ${type || 'any'}, repoName: ${repoName || 'any'}`);

    // 1. Find the Docker sandbox (by type if specified)
    let sandbox;

    // 🎯 Priority 1: Find by type (frontend/backend)
    if (type) {
      sandbox = sandboxService.findSandboxByType(taskId, type);
      if (sandbox) {
        console.log(`🐳 [DevServer API] Found ${type} sandbox: ${sandbox.sandboxId}`);
      }
    }

    // 🎯 Priority 2: Find by repoName
    if (!sandbox && repoName) {
      const allSandboxes = sandboxService.getAllSandboxesForTask(taskId);
      sandbox = allSandboxes.find(s => s.instance.repoName === repoName);
      if (sandbox) {
        console.log(`🐳 [DevServer API] Found sandbox by repoName: ${sandbox.sandboxId}`);
      }
    }

    // 🎯 Priority 3: Fallback to first available (legacy behavior)
    if (!sandbox) {
      sandbox = sandboxService.findSandboxForTask(taskId);
    }

    if (!sandbox) {
      // List available sandboxes for debugging
      const available = sandboxService.getAllSandboxesForTask(taskId);
      return res.status(404).json({
        success: false,
        error: 'No Docker sandbox found for this task',
        suggestion: 'Make sure the task has an active sandbox running',
        availableSandboxes: available.map(s => ({
          sandboxId: s.sandboxId,
          type: s.instance.sandboxType,
          repoName: s.instance.repoName,
          image: s.instance.image,
        })),
      });
    }

    if (sandbox.instance.status !== 'running') {
      return res.status(400).json({
        success: false,
        error: `Sandbox exists but is not running (status: ${sandbox.instance.status})`,
        sandboxId: sandbox.sandboxId,
      });
    }

    console.log(`🐳 [DevServer API] Found sandbox: ${sandbox.sandboxId} (${sandbox.instance.containerName})`);

    // 2. Detect framework inside container if not provided
    let detectedFramework = framework;
    if (!detectedFramework) {
      // Check what files exist in /workspace using docker exec
      try {
        const { execSync } = await import('child_process');

        // Check for pubspec.yaml (Flutter)
        try {
          execSync(`docker exec ${sandbox.instance.containerName} test -f /workspace/pubspec.yaml`, { encoding: 'utf-8' });
          detectedFramework = 'flutter';
          console.log(`🐳 [DevServer API] Detected Flutter project`);
        } catch {
          // Not Flutter, check for package.json
          try {
            const packageJsonContent = execSync(
              `docker exec ${sandbox.instance.containerName} cat /workspace/package.json 2>/dev/null`,
              { encoding: 'utf-8' }
            );
            const pkg = JSON.parse(packageJsonContent);
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            if (deps.vite) detectedFramework = 'vite';
            else if (deps.next) detectedFramework = 'nextjs';
            else if (deps['react-scripts']) detectedFramework = 'cra';
            else if (deps['@vue/cli-service']) detectedFramework = 'vue';
            else if (deps['@angular/core']) detectedFramework = 'angular';
            else if (pkg.scripts?.dev) detectedFramework = 'node';
            else if (pkg.scripts?.start) detectedFramework = 'node';

            console.log(`🐳 [DevServer API] Detected Node.js project: ${detectedFramework}`);
          } catch {
            // Check for Python
            try {
              const requirements = execSync(
                `docker exec ${sandbox.instance.containerName} cat /workspace/requirements.txt 2>/dev/null`,
                { encoding: 'utf-8' }
              );
              if (requirements.includes('django')) detectedFramework = 'django';
              else if (requirements.includes('flask')) detectedFramework = 'flask';
              else if (requirements.includes('fastapi')) detectedFramework = 'fastapi';
              console.log(`🐳 [DevServer API] Detected Python project: ${detectedFramework}`);
            } catch {
              detectedFramework = 'node'; // Default fallback
            }
          }
        }
      } catch (err: any) {
        console.error(`🐳 [DevServer API] Error detecting framework:`, err.message);
        detectedFramework = 'node'; // Default fallback
      }
    }

    // 3. Determine port (use provided or default based on framework)
    const defaultPorts: Record<string, number> = {
      flutter: 8080,
      vite: 5173,
      nextjs: 3000,
      cra: 3000,
      vue: 8080,
      angular: 4200,
      node: 3000,
      django: 8000,
      flask: 5000,
      fastapi: 8000,
    };

    const serverPort = port || defaultPorts[detectedFramework || 'node'] || 3000;

    // 4. Check if server is already running
    const existingServer = devServerService.getServerStatus(taskId);
    if (existingServer) {
      console.log(`🐳 [DevServer API] Server already running at ${existingServer.url}`);
      return res.json({
        success: true,
        url: existingServer.url,
        framework: existingServer.framework,
        port: existingServer.port,
        alreadyRunning: true,
        isDocker: true,
        sandboxId: sandbox.sandboxId,
      });
    }

    // 5. Start the server inside Docker
    // 🔥 FIX: Pass mappedPorts to use correct host port (e.g., 55111 instead of 3000)
    const result = await devServerService.startServerInDocker(
      taskId,
      sandbox.instance.containerName,
      detectedFramework || 'node',
      serverPort,
      sandbox.instance.mappedPorts  // 🔥 Critical: dynamic port mappings
    );

    if (!result) {
      return res.status(500).json({
        success: false,
        error: 'Failed to start dev server inside Docker',
        framework: detectedFramework,
        sandboxId: sandbox.sandboxId,
      });
    }

    return res.json({
      success: true,
      url: result.url,
      framework: result.framework,
      port: serverPort,
      isDocker: true,
      sandboxId: sandbox.sandboxId,
      containerName: sandbox.instance.containerName,
    });

  } catch (error: any) {
    console.error(`🐳 [DevServer API] Error starting preview:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start preview server',
    });
  }
});

/**
 * GET /api/dev-server/sdk-check
 * Check which SDKs are available on the server
 *
 * This helps LivePreview know if it can start a dev server for a given framework.
 */
router.get('/sdk-check', async (_req: Request, res: Response) => {
  try {
    const sdkStatus = devServerService.checkAllSdks();

    return res.json({
      success: true,
      sdks: sdkStatus,
      summary: {
        nodejs: sdkStatus.nodejs?.available || false,
        flutter: sdkStatus.flutter?.available || false,
        python: sdkStatus.python?.available || false,
      },
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error checking SDKs:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to check SDK availability',
    });
  }
});

/**
 * POST /api/dev-server/sdk-check/:language
 * Check if a specific SDK is available
 */
router.get('/sdk-check/:language', async (req: Request, res: Response) => {
  try {
    const { language } = req.params;

    const sdk = devServerService.checkSdk(language);

    return res.json({
      success: true,
      language,
      ...sdk,
    });
  } catch (error: any) {
    console.error(`[DevServer API] Error checking SDK:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to check SDK availability',
    });
  }
});

/**
 * GET /api/dev-server/servers/:taskId
 * Get all running dev servers for a task
 *
 * This endpoint returns information about all dev servers that are currently
 * running for a task, including those started automatically by SandboxPhase.
 */
router.get('/servers/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[DevServer API] Getting servers for task ${taskId}`);

    // 1. Get server status from DevServerService (in-memory tracking)
    const trackedServer = devServerService.getServerStatus(taskId);

    // 2. Get all sandboxes for this task (may have running servers we don't track)
    const sandboxes = sandboxService.getAllSandboxesForTask(taskId);

    // 3. Get workspace info from EventStore for context
    const state = await eventStore.getCurrentState(taskId);
    const envConfig = state?.environmentConfig || {};

    // Build server list
    const servers: any[] = [];

    // Add tracked server if exists
    if (trackedServer) {
      servers.push({
        taskId,
        url: trackedServer.url,
        framework: trackedServer.framework,
        port: trackedServer.port,
        startedAt: trackedServer.startedAt,
        isDocker: trackedServer.isDocker || false,
        containerName: trackedServer.containerName,
        source: 'tracked',
      });
    }

    // Add servers from running sandboxes (may not be tracked if started by SandboxPhase)
    for (const sandbox of sandboxes) {
      if (sandbox.instance.status !== 'running') continue;

      const repoName = sandbox.instance.repoName || 'unknown';
      const config = envConfig[repoName] || {};
      const serverPort = (config as any).port || (config as any).devPort || 8080;

      // Check if this sandbox's server is already in the list
      const alreadyListed = servers.some(s =>
        s.containerName === sandbox.instance.containerName ||
        s.port === serverPort
      );

      if (!alreadyListed) {
        // Determine URL based on host network mode
        const useHostNetwork = process.env.DOCKER_USE_BRIDGE_MODE !== 'true';
        const url = useHostNetwork
          ? `http://localhost:${serverPort}`
          : sandbox.instance.mappedPorts?.[serverPort]
            ? `http://localhost:${sandbox.instance.mappedPorts[serverPort]}`
            : `http://localhost:${serverPort}`;

        servers.push({
          taskId,
          url,
          framework: config.framework || config.language || 'unknown',
          port: serverPort,
          isDocker: true,
          sandboxId: sandbox.sandboxId,
          containerName: sandbox.instance.containerName,
          repoName,
          sandboxType: sandbox.instance.sandboxType || 'unknown',
          source: 'sandbox',
          // Include environment config for frontend
          envConfig: {
            language: config.language,
            framework: config.framework,
            runCommand: config.runCommand,
          },
        });
      }
    }

    return res.json({
      success: true,
      taskId,
      count: servers.length,
      servers,
      // Also include preview URLs via proxy (more reliable than direct ports)
      previewUrls: servers.map(s => ({
        direct: s.url,
        proxy: `/api/v1/preview/${taskId}/port/${s.port}/`,
        repoName: s.repoName || 'default',
      })),
    });

  } catch (error: any) {
    console.error(`[DevServer API] Error getting servers:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get dev servers',
    });
  }
});

/**
 * POST /api/dev-server/start-all/:taskId
 * Start dev servers for all sandboxes in a task
 *
 * This endpoint is called by LivePreview to start all dev servers
 * when the user wants to preview the project.
 */
router.post('/start-all/:taskId', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;

    console.log(`[DevServer API] Starting all servers for task ${taskId}`);

    // 1. Get all sandboxes for this task
    const sandboxes = sandboxService.getAllSandboxesForTask(taskId);

    if (sandboxes.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No sandboxes found for this task',
        taskId,
      });
    }

    // 2. Get environment config from EventStore
    const state = await eventStore.getCurrentState(taskId);
    const envConfig = state?.environmentConfig || {};

    // 3. Start servers for each running sandbox
    const results: any[] = [];
    let successCount = 0;

    for (const sandbox of sandboxes) {
      if (sandbox.instance.status !== 'running') {
        results.push({
          sandboxId: sandbox.sandboxId,
          repoName: sandbox.instance.repoName,
          success: false,
          error: `Sandbox not running (status: ${sandbox.instance.status})`,
        });
        continue;
      }

      const repoName = sandbox.instance.repoName || 'unknown';
      const config = envConfig[repoName] || {};
      const serverPort = (config as any).port || (config as any).devPort || 8080;
      const framework = config.framework || config.language || 'node';

      try {
        // Check if server already running
        const existingStatus = devServerService.getServerStatus(`${taskId}-${repoName}`);
        if (existingStatus) {
          results.push({
            sandboxId: sandbox.sandboxId,
            repoName,
            success: true,
            alreadyRunning: true,
            url: existingStatus.url,
            port: existingStatus.port,
            framework: existingStatus.framework,
          });
          successCount++;
          continue;
        }

        // Start the dev server inside Docker
        const result = await devServerService.startServerInDocker(
          `${taskId}-${repoName}`,
          sandbox.instance.containerName,
          framework,
          serverPort,
          sandbox.instance.mappedPorts
        );

        if (result) {
          results.push({
            sandboxId: sandbox.sandboxId,
            repoName,
            success: true,
            url: result.url,
            port: serverPort,
            framework: result.framework,
            containerName: sandbox.instance.containerName,
          });
          successCount++;
        } else {
          results.push({
            sandboxId: sandbox.sandboxId,
            repoName,
            success: false,
            error: 'Failed to start server',
          });
        }
      } catch (err: any) {
        results.push({
          sandboxId: sandbox.sandboxId,
          repoName,
          success: false,
          error: err.message,
        });
      }
    }

    return res.json({
      success: successCount > 0,
      taskId,
      totalSandboxes: sandboxes.length,
      serversStarted: successCount,
      results,
      // Include preview URLs
      previewUrls: results
        .filter(r => r.success)
        .map(r => ({
          direct: r.url,
          proxy: `/api/v1/preview/${taskId}/port/${r.port}/`,
          repoName: r.repoName,
        })),
    });

  } catch (error: any) {
    console.error(`[DevServer API] Error starting all servers:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to start dev servers',
    });
  }
});

/**
 * POST /api/dev-server/sdk-install/:language
 * Install an SDK on the server (Flutter, Node.js, Python)
 *
 * ⚠️ WARNING: This runs installation commands on the server.
 * Only use in development/local environments.
 */
router.post('/sdk-install/:language', async (req: Request, res: Response) => {
  try {
    const { language } = req.params;

    console.log(`[DevServer API] Installing SDK: ${language}`);

    // Check if already installed
    const currentStatus = devServerService.checkSdk(language);
    if (currentStatus.available) {
      return res.json({
        success: true,
        alreadyInstalled: true,
        message: `${currentStatus.sdkName} is already installed`,
        version: currentStatus.version,
        path: currentStatus.path,
      });
    }

    // Get install command
    const installInfo = devServerService.getSdkInstallInfo(language);
    if (!installInfo) {
      return res.status(400).json({
        success: false,
        error: `No installation command available for: ${language}`,
      });
    }

    console.log(`[DevServer API] Running: ${installInfo.command}`);

    // Run installation
    const result = await devServerService.installSdk(language);

    if (result.success) {
      // Verify installation
      const newStatus = devServerService.checkSdk(language);

      return res.json({
        success: true,
        installed: true,
        message: `${newStatus.sdkName} installed successfully`,
        version: newStatus.version,
        path: newStatus.path,
        output: result.output,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error || 'Installation failed',
        output: result.output,
        command: installInfo.command,
      });
    }
  } catch (error: any) {
    console.error(`[DevServer API] Error installing SDK:`, error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to install SDK',
    });
  }
});

export default router;
