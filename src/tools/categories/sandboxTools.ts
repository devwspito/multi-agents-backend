/**
 * Sandbox Tools - Execute commands inside Docker containers
 *
 * These tools ensure ALL agent commands run inside isolated Docker containers
 * with the correct environment (Flutter, Node, Python, etc. installed).
 *
 * Architecture:
 * - Agent calls sandbox_bash with command
 * - Tool looks up the active sandbox for the current task
 * - Command executes inside Docker container
 * - Output returned to agent
 *
 * This replaces direct host execution for safety and environment consistency.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { sandboxService } from '../../services/SandboxService';

// Global context for current task (set by AgentExecutorService before each agent run)
let currentTaskContext: {
  taskId: string;
  sandboxId: string;
  workspacePath: string;
  repoName?: string;
} | null = null;

/**
 * Set the current task context for sandbox tools.
 * Called by AgentExecutorService before executing each agent.
 */
export function setSandboxContext(context: {
  taskId: string;
  sandboxId: string;
  workspacePath: string;
  repoName?: string;
}): void {
  currentTaskContext = context;
  console.log(`[SandboxTools] Context set: taskId=${context.taskId}, sandboxId=${context.sandboxId}`);
}

/**
 * Clear the sandbox context (called after agent execution completes).
 */
export function clearSandboxContext(): void {
  currentTaskContext = null;
}

/**
 * Get the current sandbox context.
 */
export function getSandboxContext() {
  return currentTaskContext;
}

/**
 * sandbox_bash - Execute bash commands inside Docker container
 *
 * This tool MUST be used instead of direct Bash execution to ensure
 * commands run in the correct environment with all dependencies available.
 *
 * Examples:
 * - flutter pub get, flutter build, flutter test
 * - npm install, npm run build, npm test
 * - python -m pytest, pip install
 * - go build, go test
 */
export const sandboxBashTool = tool(
  'sandbox_bash',
  `Execute bash commands inside the isolated Docker sandbox environment.

🚨 IMPORTANT: ALWAYS use this tool instead of regular Bash for:
- Flutter commands (flutter pub get, flutter build, flutter test, dart analyze)
- Node.js commands (npm install, npm run build, npm test)
- Python commands (pip install, python -m pytest)
- Go commands (go build, go test)
- Any build/test/run commands

The sandbox has all required SDKs and tools pre-installed:
- Flutter SDK (for Flutter/Dart projects)
- Node.js 20 (for JavaScript/TypeScript projects)
- Python 3.12 (for Python projects)

Commands execute in /workspace which is the project root directory.

Example usage:
- sandbox_bash(command="flutter pub get")
- sandbox_bash(command="npm run build")
- sandbox_bash(command="dart analyze lib/")
- sandbox_bash(command="npm test", timeout=300000)`,
  {
    command: z.string().describe('The bash command to execute inside the sandbox'),
    cwd: z.string().optional().describe('Working directory inside container (relative to /workspace). Default: /workspace'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000 = 5 minutes)'),
    env: z.record(z.string()).optional().describe('Additional environment variables'),
  },
  async (args) => {
    const startTime = Date.now();

    try {
      // 🔒 CRITICAL: sandbox_bash MUST use the current task's sandbox ONLY
      // NEVER fall back to a different task's sandbox - that causes cross-contamination
      const taskId = currentTaskContext?.taskId;

      if (!taskId) {
        const status = sandboxService.getStatus();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'No task context set. sandbox_bash requires setSandboxContext to be called first.',
              suggestion: 'This is a bug - AgentExecutorService should set sandbox context before agent runs.',
              executedIn: 'none',
              debug: {
                currentTaskContext,
                activeSandboxes: status.activeSandboxes,
                sandboxIds: Array.from(status.sandboxes.keys()),
              },
            }, null, 2),
          }],
        };
      }

      // Find sandbox for THIS task only - no fallbacks
      const found = sandboxService.findSandboxForTask(taskId);

      if (!found) {
        const status = sandboxService.getStatus();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `No sandbox found for task ${taskId}. Each task has ONE unique sandbox.`,
              suggestion: 'Sandbox must be created before executing commands. Check SandboxPhase.',
              executedIn: 'none',
              debug: {
                taskId,
                activeSandboxes: status.activeSandboxes,
                sandboxIds: Array.from(status.sandboxes.keys()),
              },
            }, null, 2),
          }],
        };
      }

      const { sandboxId } = found;
      console.log(`[sandbox_bash] ✅ Using sandbox for task ${taskId}: ${sandboxId}`);

      // 🔥 FIX: Determine working directory - use repoName if available
      // The project is at /workspace/<repoName>/, NOT directly at /workspace/
      const defaultWorkDir = currentTaskContext?.repoName
        ? `/workspace/${currentTaskContext.repoName}`
        : '/workspace';

      const workDir = args.cwd
        ? (args.cwd.startsWith('/') ? args.cwd : `/workspace/${args.cwd}`)
        : defaultWorkDir;

      console.log(`\n🐳 [sandbox_bash] Executing in sandbox ${sandboxId}:`);
      console.log(`   Command: ${args.command}`);
      console.log(`   WorkDir: ${workDir}`);

      // Execute command in sandbox
      const result = await sandboxService.exec(
        sandboxId,
        args.command,
        {
          cwd: workDir,
          timeout: args.timeout || 300000, // 5 minutes default
          env: args.env,
        }
      );

      const duration = Date.now() - startTime;

      // Log result summary
      if (result.exitCode === 0) {
        console.log(`   ✅ Success (${result.executedIn}, ${duration}ms)`);
      } else {
        console.log(`   ❌ Failed with exit code ${result.exitCode} (${result.executedIn}, ${duration}ms)`);
      }

      // Return structured result
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout.substring(0, 10000), // Limit output size
            stderr: result.stderr.substring(0, 5000),
            duration: result.duration,
            executedIn: result.executedIn,
            command: args.command,
            workDir,
          }, null, 2),
        }],
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[sandbox_bash] Error: ${error.message}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            duration,
            executedIn: 'error',
            suggestion: 'Check if Docker is running and sandbox is properly initialized.',
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * sandbox_status - Check sandbox status and availability
 */
export const sandboxStatusTool = tool(
  'sandbox_status',
  `Check the status of the Docker sandbox environment.

Use this to verify:
- If Docker is available
- If sandbox is running for current task
- What tools/SDKs are available in the sandbox`,
  {},
  async () => {
    try {
      const status = sandboxService.getStatus();
      const dockerInfo = sandboxService.getDockerInfo();

      const sandboxList = Array.from(status.sandboxes.entries()).map(([id, sandbox]) => ({
        id,
        containerName: sandbox.containerName,
        image: sandbox.image,
        status: sandbox.status,
        createdAt: sandbox.createdAt,
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            dockerAvailable: status.dockerAvailable,
            dockerVersion: status.dockerVersion,
            platform: dockerInfo.platform,
            activeSandboxes: status.activeSandboxes,
            sandboxes: sandboxList,
            currentContext: currentTaskContext,
          }, null, 2),
        }],
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * sandbox_file_sync - Sync files between host and sandbox
 * (Future: for when we need to copy files that aren't in mounted volume)
 */
export const sandboxFileSyncTool = tool(
  'sandbox_file_sync',
  `Sync files between host filesystem and sandbox container.

Use this when you need to:
- Copy a file from host to sandbox
- Copy output files from sandbox to host

Note: The /workspace directory is already mounted, so most files are automatically synced.
Only use this for files outside the workspace directory.`,
  {
    action: z.enum(['to_sandbox', 'from_sandbox']).describe('Direction of sync'),
    sourcePath: z.string().describe('Source file path'),
    destPath: z.string().describe('Destination file path'),
  },
  async (args) => {
    try {
      if (!currentTaskContext) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: 'No active sandbox context',
            }, null, 2),
          }],
        };
      }

      const { sandboxId } = currentTaskContext;
      const sandbox = sandboxService.getSandbox(sandboxId);

      if (!sandbox) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Sandbox ${sandboxId} not found`,
            }, null, 2),
          }],
        };
      }

      // Use docker cp for file transfer
      const { execSync } = await import('child_process');

      if (args.action === 'to_sandbox') {
        execSync(`docker cp "${args.sourcePath}" ${sandbox.containerName}:"${args.destPath}"`, {
          encoding: 'utf-8',
        });
      } else {
        execSync(`docker cp ${sandbox.containerName}:"${args.sourcePath}" "${args.destPath}"`, {
          encoding: 'utf-8',
        });
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            action: args.action,
            source: args.sourcePath,
            destination: args.destPath,
          }, null, 2),
        }],
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);
