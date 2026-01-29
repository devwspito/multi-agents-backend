/**
 * SandboxServerUtils
 *
 * Reusable server startup logic extracted from SandboxPhase.
 * Used by:
 * - SandboxPhase (with fixer retry on top)
 * - Relaunch endpoint (direct startup)
 *
 * 🔥 SINGLE SOURCE OF TRUTH for server startup - no more duplication!
 */

import { sandboxService } from '../services/SandboxService.js';

export interface ServerStartResult {
  started: boolean;
  verified: boolean;
  url?: string;
  port?: number;
  error?: string;
  compilationLogs?: string;
}

export interface StartServerOptions {
  taskId: string;
  repoName: string;
  repoDir: string;
  devCmd: string;
  devPort: number;
  mappedPorts?: Record<string, string>;
  serviceEnvVars?: Record<string, string>;
  maxWaitMs?: number;  // Default: 420000 (7 minutes)
  pollIntervalMs?: number;  // Default: 10000 (10 seconds)
}

/**
 * Start a dev server and wait for it to be ready.
 *
 * This is the CORE server startup logic used by both:
 * - SandboxPhase.startServerWithFixerRetry()
 * - Relaunch endpoint
 *
 * @returns ServerStartResult with started/verified status and error details
 */
export async function startDevServer(options: StartServerOptions): Promise<ServerStartResult> {
  const {
    taskId,
    repoName,
    repoDir,
    devCmd,
    devPort,
    mappedPorts = {},
    serviceEnvVars = {},
    maxWaitMs = 420000,  // 7 minutes
    pollIntervalMs = 10000,  // 10 seconds
  } = options;

  const hostPort = mappedPorts[devPort.toString()] || devPort;
  const logFile = `/tmp/${repoName}-server.log`;

  try {
    // 1. Kill any previous server process on this port
    await sandboxService.exec(taskId,
      `pkill -f "port.*${devPort}" 2>/dev/null || fuser -k ${devPort}/tcp 2>/dev/null || true`,
      { cwd: '/workspace', timeout: 10000 }
    );

    // Wait a moment for port to be released
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 2. Build environment prefix
    let envPrefix = '';
    if (Object.keys(serviceEnvVars).length > 0) {
      envPrefix = Object.entries(serviceEnvVars)
        .map(([key, value]) => `${key}="${value}"`)
        .join(' ') + ' ';
    }

    // 3. Start server in background (setsid ensures it survives parent exit)
    const startCmd = `setsid bash -c 'cd ${repoDir} && ${envPrefix}${devCmd}' > ${logFile} 2>&1 &`;
    await sandboxService.exec(taskId, startCmd, { cwd: repoDir, timeout: 30000 });

    // 4. Wait for server to be ready (health check loop)
    const startTime = Date.now();
    let serverReady = false;
    let compilationError = false;
    let lastLogs = '';

    console.log(`      🔍 [${repoName}] Waiting for HTTP response on port ${devPort}...`);

    while (Date.now() - startTime < maxWaitMs && !serverReady && !compilationError) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      // Check if server responds
      try {
        const curlCmd = `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 http://localhost:${devPort}/ 2>/dev/null || echo "000"`;
        const curlResult = await sandboxService.exec(taskId, curlCmd, { cwd: '/workspace', timeout: 15000 });
        const statusCode = parseInt(curlResult.stdout.trim()) || 0;

        if (statusCode > 0 && statusCode < 600) {
          serverReady = true;
          console.log(`      ✅ [${repoName}] Server responding on port ${devPort} (HTTP ${statusCode})!`);
        }
      } catch { /* Server not ready */ }

      // Check for fatal errors in logs
      if (!serverReady) {
        try {
          const logsResult = await sandboxService.exec(taskId, `tail -50 ${logFile} 2>/dev/null || echo ""`, {
            cwd: '/workspace', timeout: 5000,
          });
          lastLogs = logsResult.stdout || '';

          // Detect fatal errors
          if (lastLogs.includes('ENOENT') || lastLogs.includes('Cannot find module') ||
              lastLogs.includes('SyntaxError') || lastLogs.includes('MODULE_NOT_FOUND') ||
              lastLogs.includes('pubspec.yaml not found') || lastLogs.includes('Error: Could not find') ||
              lastLogs.includes('FAILURE:') || lastLogs.includes('app crashed') ||
              lastLogs.includes('TypeError') || lastLogs.includes('ReferenceError') ||
              lastLogs.includes('error TS') || lastLogs.includes('Exception:')) {
            compilationError = true;
            console.log(`      ❌ [${repoName}] Fatal error detected in logs`);
          }
        } catch { /* ignore */ }
      }

      // Progress
      if (!serverReady && !compilationError) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`      ⏳ [${repoName}] ${elapsed}s...`);
      }
    }

    // 5. Extract error message if failed
    const errorMatch = lastLogs.match(/Error:.*$/m) || lastLogs.match(/error:.*$/m) ||
                      lastLogs.match(/Cannot find module.*$/m) || lastLogs.match(/Exception:.*$/m) ||
                      lastLogs.match(/SyntaxError:.*$/m) || lastLogs.match(/TypeError:.*$/m);
    const errorMsg = errorMatch ? errorMatch[0].substring(0, 300) : 'Compilation failed or timeout';

    // 6. Return result
    if (serverReady) {
      return {
        started: true,
        verified: true,
        url: `http://localhost:${hostPort}`,
        port: devPort,
      };
    } else {
      return {
        started: false,
        verified: false,
        url: `http://localhost:${hostPort}`,
        port: devPort,
        error: errorMsg,
        compilationLogs: lastLogs.substring(0, 1500),
      };
    }

  } catch (err: any) {
    console.log(`      ❌ [${repoName}] Exception: ${err.message}`);
    return {
      started: false,
      verified: false,
      error: err.message,
    };
  }
}

/**
 * Start all dev servers for a multi-repo workspace.
 *
 * @param taskId - Task ID for sandbox lookup
 * @param envConfig - Environment config from EventStore (per-repo configs)
 * @param mappedPorts - Port mappings from sandbox
 * @param serviceEnvVars - Service environment variables (MongoDB, Redis, etc.)
 * @returns Map of repo name -> server result
 */
export async function startAllDevServers(
  taskId: string,
  envConfig: Record<string, any>,
  mappedPorts: Record<string, string> = {},
  serviceEnvVars: Record<string, string> = {}
): Promise<Record<string, ServerStartResult>> {
  const results: Record<string, ServerStartResult> = {};

  console.log(`   🚀 Starting dev servers for ${Object.keys(envConfig).length} repo(s)...`);

  for (const [repoName, config] of Object.entries(envConfig)) {
    const repoConfig = config as any;
    const devCmd = repoConfig?.runCommand || repoConfig?.devCmd;
    const devPort = repoConfig?.devPort || 3000;

    if (!devCmd) {
      console.log(`      ⚠️ [${repoName}] No devCmd/runCommand - skipping`);
      results[repoName] = { started: false, verified: false, error: 'No runCommand' };
      continue;
    }

    const repoDir = `/workspace/${repoName}`;
    console.log(`      🚀 [${repoName}] Port ${devPort}: ${devCmd.substring(0, 60)}...`);

    const result = await startDevServer({
      taskId,
      repoName,
      repoDir,
      devCmd,
      devPort,
      mappedPorts,
      serviceEnvVars,
    });

    results[repoName] = result;

    if (result.verified) {
      console.log(`      ✅ [${repoName}] Ready at ${result.url}`);
    } else {
      console.log(`      ❌ [${repoName}] Failed: ${result.error?.substring(0, 80)}`);
    }
  }

  // Summary
  const successCount = Object.values(results).filter(r => r.verified).length;
  const failedCount = Object.values(results).filter(r => !r.verified).length;
  console.log(`   📊 Server Results: ${successCount} success, ${failedCount} failed`);

  return results;
}
