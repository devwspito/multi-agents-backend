/**
 * AutoRebuildService
 *
 * Centralized service for triggering rebuilds after code changes.
 * Used by both:
 * - StoryPipelineService (orchestrator flow - after merge)
 * - QuickDevService (Team-Lite - after developer completes)
 *
 * Framework agnostic - gets all config from EventStore/repo config.
 */

import { sandboxService } from './SandboxService.js';
import { eventStore } from './EventStore.js';
import { NotificationService } from './NotificationService.js';

export interface RebuildConfig {
  taskId: string;
  repoName: string;
  // Optional overrides (if not provided, fetched from EventStore)
  rebuildCmd?: string;
  devCmd?: string;
  devPort?: number;
  framework?: string;
}

export interface RebuildResult {
  success: boolean;
  skipped: boolean;
  reason?: string;
  duration?: number;
  serverRestarted?: boolean;
  error?: string;
}

export class AutoRebuildService {
  private static instance: AutoRebuildService;

  private constructor() {}

  static getInstance(): AutoRebuildService {
    if (!AutoRebuildService.instance) {
      AutoRebuildService.instance = new AutoRebuildService();
    }
    return AutoRebuildService.instance;
  }

  /**
   * Trigger a rebuild for the specified repository.
   *
   * This method:
   * 1. Validates sandbox is running
   * 2. Gets rebuild config from EventStore (or uses overrides)
   * 3. Skips if HMR (no rebuild needed)
   * 4. Executes rebuild command
   * 5. Restarts server for static builds
   * 6. Notifies frontend
   */
  async triggerRebuild(config: RebuildConfig): Promise<RebuildResult> {
    const { taskId, repoName } = config;

    console.log(`\n🔨 [AutoRebuild] Starting rebuild for ${repoName}...`);

    // 1. Validate sandbox
    const sandboxResult = sandboxService.findSandboxForTask(taskId);
    if (!sandboxResult || sandboxResult.instance.status !== 'running') {
      console.log(`   ⚠️ [AutoRebuild] No running sandbox for task ${taskId} - skipping`);
      return { success: false, skipped: true, reason: 'No running sandbox' };
    }

    // 2. Get config from EventStore (or use overrides)
    let rebuildCmd = config.rebuildCmd;
    let devCmd = config.devCmd;
    let devPort = config.devPort;
    let framework = config.framework;

    if (!rebuildCmd) {
      const repoConfig = await this.getRepoConfig(taskId, repoName);
      if (!repoConfig) {
        console.log(`   ⚠️ [AutoRebuild] No config for "${repoName}" - skipping`);
        return { success: false, skipped: true, reason: `No config for repo: ${repoName}` };
      }

      rebuildCmd = repoConfig.rebuildCmd;
      devCmd = repoConfig.devCmd || devCmd;
      devPort = repoConfig.devPort || devPort || 8080;
      framework = repoConfig.framework || repoConfig.language || 'unknown';
    }

    // 3. Skip if HMR handles rebuild
    if (!rebuildCmd || rebuildCmd.startsWith('echo ')) {
      console.log(`   ℹ️ [AutoRebuild] "${repoName}" uses HMR - skipping rebuild`);
      return { success: true, skipped: true, reason: 'HMR handles rebuild' };
    }

    console.log(`   Framework: ${framework}`);
    console.log(`   Command: ${rebuildCmd}`);

    // Notify frontend
    NotificationService.emitNotification(taskId, 'rebuild_started', {
      framework,
      repoName,
      message: `Rebuilding ${framework}...`,
    });

    try {
      const startTime = Date.now();
      const repoWorkDir = `/workspace/${repoName}`;

      // 4. Execute rebuild
      const result = await sandboxService.exec(taskId, rebuildCmd, {
        cwd: repoWorkDir,
        timeout: 300000, // 5 minutes
      });

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (result.exitCode !== 0) {
        console.warn(`   ⚠️ [AutoRebuild] Build failed (exit ${result.exitCode})`);
        console.warn(`      stderr: ${result.stderr?.substring(0, 300)}`);

        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          repoName,
          success: false,
          error: result.stderr?.substring(0, 200) || 'Build failed',
          message: `${framework} rebuild failed`,
        });

        return {
          success: false,
          skipped: false,
          duration,
          error: result.stderr?.substring(0, 200),
        };
      }

      console.log(`   ✅ [AutoRebuild] Build completed in ${duration}s`);

      // 5. Restart server for static builds
      let serverRestarted = false;
      if (this.isStaticBuild(devCmd || '', framework || '')) {
        serverRestarted = await this.restartServer(taskId, repoName, repoWorkDir, devCmd || '', devPort || 8080);
      }

      // 6. Notify frontend
      NotificationService.emitNotification(taskId, 'rebuild_complete', {
        framework,
        repoName,
        success: true,
        duration,
        serverRestarted,
        message: `${framework} rebuilt successfully!`,
      });

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔄 [AutoRebuild] ${framework} rebuilt - preview updated`
      );

      return {
        success: true,
        skipped: false,
        duration,
        serverRestarted,
      };

    } catch (error: any) {
      console.error(`   ❌ [AutoRebuild] Error: ${error.message}`);

      NotificationService.emitNotification(taskId, 'rebuild_complete', {
        framework,
        repoName,
        success: false,
        error: error.message,
      });

      return {
        success: false,
        skipped: false,
        error: error.message,
      };
    }
  }

  /**
   * Get repo configuration from EventStore
   */
  private async getRepoConfig(taskId: string, repoName: string): Promise<{
    rebuildCmd?: string;
    devCmd?: string;
    devPort?: number;
    framework?: string;
    language?: string;
  } | null> {
    try {
      const state = await eventStore.getCurrentState(taskId as any);
      const envConfig = state.environmentConfig || {};
      return envConfig[repoName] || null;
    } catch (error) {
      console.warn(`[AutoRebuild] Error getting repo config:`, error);
      return null;
    }
  }

  /**
   * Check if this is a static build framework (needs server restart)
   */
  private isStaticBuild(devCmd: string, framework: string): boolean {
    return (
      devCmd.includes('http.server') ||
      devCmd.includes('python3 -m http') ||
      devCmd.includes('serve ') ||
      framework?.toLowerCase().includes('flutter')
    );
  }

  /**
   * Restart the dev server for static builds
   */
  private async restartServer(
    taskId: string,
    repoName: string,
    repoWorkDir: string,
    devCmd: string,
    devPort: number
  ): Promise<boolean> {
    console.log(`   🔄 [AutoRebuild] Restarting server on port ${devPort}...`);

    try {
      // Extract server command from devCmd
      let serverCmd = this.extractServerCommand(devCmd, repoWorkDir);

      if (!serverCmd) {
        console.warn(`   ⚠️ [AutoRebuild] Could not extract server command`);
        return false;
      }

      // Kill existing server
      await sandboxService.exec(taskId, `fuser -k ${devPort}/tcp 2>/dev/null || true`, {
        cwd: repoWorkDir,
        timeout: 5000,
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      // Start new server in background
      const serverLogFile = `/tmp/${repoName}-server.log`;
      const backgroundCmd = `nohup ${serverCmd} > ${serverLogFile} 2>&1 &`;

      console.log(`   📋 [AutoRebuild] Server: ${serverCmd}`);

      await sandboxService.exec(taskId, backgroundCmd, {
        cwd: repoWorkDir,
        timeout: 5000,
      });

      console.log(`   ✅ [AutoRebuild] Server restarted`);
      return true;

    } catch (error: any) {
      console.warn(`   ⚠️ [AutoRebuild] Server restart failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Extract the server command from devCmd
   *
   * devCmd formats:
   * - "flutter build web && python3 -m http.server 8080 --directory build/web --bind 0.0.0.0"
   * - "npm run build && serve -s build -l 3000"
   * - "python3 -m http.server 8080"
   */
  private extractServerCommand(devCmd: string, repoWorkDir: string): string | null {
    let serverCmd = '';

    if (devCmd.includes('&&')) {
      // Extract server portion (last command after &&)
      const parts = devCmd.split('&&').map(p => p.trim());
      serverCmd = parts[parts.length - 1];
    } else {
      serverCmd = devCmd;
    }

    // Make paths absolute
    if (serverCmd.includes('http.server')) {
      // Handle --directory with relative paths
      serverCmd = serverCmd
        .replace(/--directory\s+(\S+)/g, (_, dir) => {
          // Don't double-prefix if already absolute
          if (dir.startsWith('/')) return `--directory "${dir}"`;
          return `--directory "${repoWorkDir}/${dir}"`;
        });

      // If no --directory, try to add one based on common patterns
      if (!serverCmd.includes('--directory')) {
        // Check for common build output directories
        const buildDirs = ['build/web', 'build', 'dist', 'out', 'public'];
        for (const dir of buildDirs) {
          serverCmd = serverCmd.replace(
            /(python3?\s+-m\s+http\.server\s+\d+)/,
            `$1 --directory "${repoWorkDir}/${dir}"`
          );
          break; // Only add once
        }
      }
    }

    if (serverCmd.includes('serve ')) {
      // Handle serve command paths
      serverCmd = serverCmd.replace(
        /serve\s+-s\s+(\S+)/,
        (_, dir) => {
          if (dir.startsWith('/')) return `serve -s "${dir}"`;
          return `serve -s "${repoWorkDir}/${dir}"`;
        }
      );
    }

    return serverCmd || null;
  }

  /**
   * Trigger rebuild for all changed files
   *
   * Convenience method that detects which repo was changed based on file paths.
   */
  async triggerRebuildForChangedFiles(
    taskId: string,
    changedFiles: string[]
  ): Promise<RebuildResult[]> {
    // Group files by repo
    const repoMap = new Map<string, string[]>();

    for (const file of changedFiles) {
      // Extract repo name from path like /workspace/my-repo/src/file.dart
      const match = file.match(/^\/workspace\/([^/]+)/);
      if (match) {
        const repoName = match[1];
        if (!repoMap.has(repoName)) {
          repoMap.set(repoName, []);
        }
        repoMap.get(repoName)!.push(file);
      }
    }

    // Trigger rebuild for each affected repo
    const results: RebuildResult[] = [];

    for (const [repoName, files] of repoMap) {
      console.log(`[AutoRebuild] Repo "${repoName}" has ${files.length} changed files`);
      const result = await this.triggerRebuild({ taskId, repoName });
      results.push(result);
    }

    return results;
  }
}

// Export singleton
export const autoRebuildService = AutoRebuildService.getInstance();
