/**
 * DockerBashHook - SDK PreToolUse Hook for redirecting Bash to Docker
 *
 * This hook intercepts ALL Bash tool calls and redirects development commands
 * (flutter, npm, dart, python, etc.) to execute inside the Docker sandbox.
 *
 * How it works:
 * 1. Agent calls Bash(command: "flutter test")
 * 2. Hook intercepts BEFORE execution
 * 3. Hook checks if dependencies are installed, if not prepends install command
 * 4. Hook modifies command to: "docker exec -w /workspace container_name bash -c 'flutter test'"
 * 5. SDK executes the modified command
 * 6. Agent receives output as if it ran normally
 *
 * The agent never knows the difference - it's completely transparent.
 */

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { execSync } from 'child_process';
import { sandboxService } from './SandboxService';
import { NotificationService } from './NotificationService';

/**
 * Commands that MUST run in Docker (development commands)
 * These require specific SDKs installed in the container
 */
const DOCKER_REQUIRED_COMMANDS = [
  // Flutter/Dart
  'flutter',
  'dart',
  'pub',
  // Node.js
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'node',
  // Python
  'pip',
  'pip3',
  'python',
  'python3',
  'pytest',
  // Build tools
  'make',
  'cmake',
  'cargo',
  'go',
  'gradle',
  'mvn',
  // Package managers
  'brew',
  'apt',
  'apt-get',
];

/**
 * Commands that should ALWAYS run on host (git, file operations)
 */
const HOST_ONLY_COMMANDS = [
  'git',
  'gh',
  'cd',
  'pwd',
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'find',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'chmod',
  'chown',
  'echo',
  'touch',
  'which',
  'whereis',
  'env',
  'export',
];

/**
 * Check if a command should run in Docker
 */
function shouldRunInDocker(command: string): boolean {
  const trimmedCmd = command.trim();
  const firstWord = trimmedCmd.split(/\s+/)[0];

  // Check if it's a host-only command
  if (HOST_ONLY_COMMANDS.some(cmd => firstWord === cmd || firstWord.endsWith(`/${cmd}`))) {
    return false;
  }

  // Check if it requires Docker
  if (DOCKER_REQUIRED_COMMANDS.some(cmd => firstWord === cmd || firstWord.endsWith(`/${cmd}`))) {
    return true;
  }

  // Check for common patterns in piped/chained commands
  const dockerPatterns = [
    /flutter\s+/,
    /dart\s+/,
    /npm\s+/,
    /npx\s+/,
    /yarn\s+/,
    /pip\s+/,
    /pip3\s+/,
    /python\s+/,
    /python3\s+/,
    /pytest/,
    /cargo\s+/,
    /go\s+(build|test|run|mod|get)/,
  ];

  for (const pattern of dockerPatterns) {
    if (pattern.test(trimmedCmd)) {
      return true;
    }
  }

  return false;
}

/**
 * Escape a command for safe inclusion in docker exec bash -c "..."
 */
function escapeForDockerExec(command: string): string {
  // Escape single quotes by ending the quote, adding escaped quote, and reopening
  // 'hello'world' -> 'hello'\''world'
  return command.replace(/'/g, "'\\''");
}

/**
 * Dependency configuration for each language/tool
 */
interface DependencyConfig {
  checkCommand: string;     // Command to check if deps exist (runs in Docker)
  installCommand: string;   // Command to install deps
  description: string;      // Human-readable description
}

const DEPENDENCY_CONFIGS: Record<string, DependencyConfig> = {
  npm: {
    checkCommand: '[ -d node_modules ]',
    installCommand: 'npm install',
    description: 'Node.js dependencies',
  },
  npx: {
    checkCommand: '[ -d node_modules ]',
    installCommand: 'npm install',
    description: 'Node.js dependencies',
  },
  yarn: {
    checkCommand: '[ -d node_modules ]',
    installCommand: 'yarn install',
    description: 'Node.js dependencies',
  },
  pnpm: {
    checkCommand: '[ -d node_modules ]',
    installCommand: 'pnpm install',
    description: 'Node.js dependencies',
  },
  flutter: {
    checkCommand: '[ -d .dart_tool ]',
    installCommand: 'flutter pub get',
    description: 'Flutter dependencies',
  },
  dart: {
    checkCommand: '[ -d .dart_tool ]',
    installCommand: 'dart pub get',
    description: 'Dart dependencies',
  },
  pip: {
    checkCommand: '[ -d .venv ] || [ -d venv ]',
    installCommand: 'pip install -r requirements.txt 2>/dev/null || true',
    description: 'Python dependencies',
  },
  pip3: {
    checkCommand: '[ -d .venv ] || [ -d venv ]',
    installCommand: 'pip3 install -r requirements.txt 2>/dev/null || true',
    description: 'Python dependencies',
  },
  python: {
    checkCommand: '[ -d .venv ] || [ -d venv ] || [ -f requirements.txt ]',
    installCommand: 'pip install -r requirements.txt 2>/dev/null || true',
    description: 'Python dependencies',
  },
  pytest: {
    checkCommand: '[ -d .venv ] || [ -d venv ]',
    installCommand: 'pip install -r requirements.txt 2>/dev/null || pip install pytest',
    description: 'Python test dependencies',
  },
  cargo: {
    checkCommand: '[ -f Cargo.lock ]',
    installCommand: 'cargo build 2>/dev/null || true',
    description: 'Rust dependencies',
  },
  go: {
    checkCommand: '[ -f go.sum ]',
    installCommand: 'go mod download',
    description: 'Go dependencies',
  },
};

/**
 * Commands that are dependency installation commands (skip dep check for these)
 */
const INSTALL_COMMANDS = [
  'npm install',
  'npm i',
  'npm ci',
  'yarn install',
  'yarn',
  'pnpm install',
  'flutter pub get',
  'dart pub get',
  'pip install',
  'pip3 install',
  'cargo build',
  'go mod download',
  'go get',
];

/**
 * Check if a command is itself an install command
 */
function isInstallCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return INSTALL_COMMANDS.some(install => trimmed.startsWith(install));
}

/**
 * Get the tool type from a command (npm, flutter, etc.)
 */
function getToolType(command: string): string | null {
  const trimmed = command.trim();
  const firstWord = trimmed.split(/\s+/)[0];

  // Direct match
  if (DEPENDENCY_CONFIGS[firstWord]) {
    return firstWord;
  }

  // Check for path-based command (e.g., /usr/bin/npm)
  const basename = firstWord.split('/').pop();
  if (basename && DEPENDENCY_CONFIGS[basename]) {
    return basename;
  }

  return null;
}

/**
 * Check if dependencies are installed in Docker container
 */
function checkDepsInDocker(containerName: string, workspacePath: string, checkCommand: string): boolean {
  try {
    execSync(
      `docker exec -w ${workspacePath} ${containerName} bash -c '${checkCommand}'`,
      { encoding: 'utf-8', stdio: 'pipe' }
    );
    return true; // Check command succeeded, deps exist
  } catch {
    return false; // Check command failed, deps don't exist
  }
}

/**
 * Tracks which containers have had deps installed this session
 * to avoid redundant installs
 */
const installedDepsCache = new Map<string, Set<string>>();

/**
 * Mark that deps have been installed for a tool in a container
 */
function markDepsInstalled(containerName: string, toolType: string): void {
  if (!installedDepsCache.has(containerName)) {
    installedDepsCache.set(containerName, new Set());
  }
  installedDepsCache.get(containerName)!.add(toolType);
}

/**
 * Check if deps were already installed for a tool in this session
 */
function wereDepsInstalled(containerName: string, toolType: string): boolean {
  return installedDepsCache.get(containerName)?.has(toolType) || false;
}

/**
 * Context for the current sandbox (set before agent execution)
 */
interface SandboxContext {
  taskId: string;
  containerName: string;
  workspacePath: string;
}

let currentSandboxContext: SandboxContext | null = null;

/**
 * Set the sandbox context for the hook to use
 * Called by AgentExecutorService before executing an agent
 */
export function setDockerHookContext(context: SandboxContext | null): void {
  currentSandboxContext = context;
  if (context) {
    console.log(`🐳 [DockerBashHook] Context set: container=${context.containerName}`);
  } else {
    console.log(`🐳 [DockerBashHook] Context cleared`);
  }
}

/**
 * Get the current sandbox context
 */
export function getDockerHookContext(): SandboxContext | null {
  return currentSandboxContext;
}

/**
 * Create the PreToolUse hook for Bash redirection
 *
 * @param taskId - The task ID for logging/notifications
 * @returns HookCallback that intercepts Bash and redirects to Docker
 */
export function createDockerBashHook(taskId: string): HookCallback {
  return async (input, _toolUseID, _options) => {
    // Only handle PreToolUse events
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const preToolInput = input as {
      hook_event_name: 'PreToolUse';
      tool_name: string;
      tool_input: unknown;
      tool_use_id: string;
      session_id: string;
      transcript_path: string;
      cwd: string;
    };

    // Only intercept Bash tool
    if (preToolInput.tool_name !== 'Bash') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow' as const,
        },
      };
    }

    const toolInput = preToolInput.tool_input as { command?: string; timeout?: number; description?: string };
    const originalCommand = toolInput.command || '';

    // Check if this command should run in Docker
    if (!shouldRunInDocker(originalCommand)) {
      console.log(`💻 [DockerBashHook] Host execution: ${originalCommand.substring(0, 50)}...`);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow' as const,
        },
      };
    }

    // Get sandbox context
    if (!currentSandboxContext) {
      // Try to find a running sandbox for this task
      const sandbox = sandboxService.getSandbox(taskId);
      if (sandbox && sandbox.status === 'running') {
        currentSandboxContext = {
          taskId,
          containerName: sandbox.containerName,
          workspacePath: '/workspace',
        };
      } else {
        // Check for setup sandboxes
        const allSandboxes = sandboxService.getAllSandboxes();
        for (const [sandboxId, sb] of allSandboxes) {
          if (sandboxId.startsWith(`${taskId}-setup-`) && sb.status === 'running') {
            currentSandboxContext = {
              taskId,
              containerName: sb.containerName,
              workspacePath: '/workspace',
            };
            break;
          }
        }
      }
    }

    if (!currentSandboxContext) {
      console.warn(`⚠️ [DockerBashHook] No sandbox available, running on host: ${originalCommand.substring(0, 50)}...`);
      NotificationService.emitConsoleLog(
        taskId,
        'warn',
        `⚠️ No Docker sandbox available, executing on host: ${originalCommand.substring(0, 50)}...`
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow' as const,
        },
      };
    }

    // Build the docker exec command
    const { containerName, workspacePath } = currentSandboxContext;

    // 📦 AUTO-DEPENDENCY INSTALL: Check if deps are needed and prepend install
    let finalCommand = originalCommand;
    const toolType = getToolType(originalCommand);

    if (toolType && !isInstallCommand(originalCommand)) {
      const depConfig = DEPENDENCY_CONFIGS[toolType];

      if (depConfig && !wereDepsInstalled(containerName, toolType)) {
        // Check if deps exist in container
        const depsExist = checkDepsInDocker(containerName, workspacePath, depConfig.checkCommand);

        if (!depsExist) {
          console.log(`📦 [DockerBashHook] Dependencies not found, installing ${depConfig.description}...`);
          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `📦 Auto-installing ${depConfig.description} before execution...`
          );

          // Prepend install command
          finalCommand = `${depConfig.installCommand} && ${originalCommand}`;
          markDepsInstalled(containerName, toolType);
        } else {
          // Mark as installed so we don't check again
          markDepsInstalled(containerName, toolType);
        }
      }
    }

    const escapedCommand = escapeForDockerExec(finalCommand);
    const dockerCommand = `docker exec -w ${workspacePath} ${containerName} bash -c '${escapedCommand}'`;

    console.log(`🐳 [DockerBashHook] Redirecting to Docker:`);
    console.log(`   Original: ${originalCommand.substring(0, 80)}...`);
    if (finalCommand !== originalCommand) {
      console.log(`   With deps: ${finalCommand.substring(0, 80)}...`);
    }
    console.log(`   Docker:   docker exec -w ${workspacePath} ${containerName} ...`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🐳 Executing in Docker: ${originalCommand.substring(0, 60)}...`
    );

    // Return updated input with the docker command
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow' as const,
        updatedInput: {
          ...toolInput,
          command: dockerCommand,
        },
      },
    };
  };
}

/**
 * Create hooks configuration for SDK query options
 *
 * @param taskId - The task ID
 * @returns Hooks configuration object for query options
 */
export function createDockerHooksConfig(taskId: string): {
  PreToolUse: Array<{ hooks: HookCallback[]; timeout?: number }>;
} {
  return {
    PreToolUse: [
      {
        hooks: [createDockerBashHook(taskId)],
        timeout: 30, // 30 seconds timeout for hook execution
      },
    ],
  };
}

export const dockerBashHook = {
  setContext: setDockerHookContext,
  getContext: getDockerHookContext,
  createHook: createDockerBashHook,
  createHooksConfig: createDockerHooksConfig,
  shouldRunInDocker,
};
