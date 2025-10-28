import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { LogService } from './logging/LogService';

const execAsync = promisify(exec);

/**
 * Hook Execution Result
 */
export interface IHookResult {
  success: boolean;
  hookName: string;
  stdout: string;
  stderr: string;
  executionTime: number;
  error?: string;
}

/**
 * Hook Type
 */
export type HookType =
  | 'auto-test'
  | 'auto-format'
  | 'auto-build'
  | 'security-scan'
  | 'file-protection'
  | 'git-auto-add'
  | 'load-task-context'
  | 'auto-backup'
  | 'tool-activity-logger';

/**
 * Hook Service
 *
 * Executes bash hooks from .claude/hooks/ directory
 *
 * Hooks are executed at key points in the orchestration:
 * - auto-test.sh: Before QA phase
 * - auto-format.sh: Before git commits
 * - security-scan.sh: After development phase
 * - file-protection.sh: Before modifying critical files
 * - auto-build.sh: Before deployment
 */
export class HookService {
  private static hooksDir = path.join(process.cwd(), '.claude', 'hooks');

  /**
   * Execute a hook
   *
   * @param hookName - Name of the hook (without .sh extension)
   * @param args - Arguments to pass to the hook
   * @param cwd - Working directory (defaults to project root)
   * @param taskId - Task ID for logging
   * @returns Hook execution result
   */
  static async executeHook(
    hookName: HookType,
    args: string[] = [],
    cwd?: string,
    taskId?: string
  ): Promise<IHookResult> {
    const startTime = Date.now();
    const hookPath = path.join(this.hooksDir, `${hookName}.sh`);

    // Check if hook exists
    if (!fs.existsSync(hookPath)) {
      const error = `Hook not found: ${hookPath}`;
      await LogService.warn(error, {
        taskId: taskId as any,
        category: 'orchestration',
        metadata: { hookName, hookPath },
      });

      return {
        success: false,
        hookName,
        stdout: '',
        stderr: error,
        executionTime: 0,
        error,
      };
    }

    // Check if hook is executable
    try {
      await execAsync(`test -x "${hookPath}"`);
    } catch {
      // Make it executable
      await execAsync(`chmod +x "${hookPath}"`);
    }

    console.log(`\n🪝 [HookService] Executing hook: ${hookName}`);
    if (args.length > 0) {
      console.log(`   Args: ${args.join(' ')}`);
    }

    try {
      const command = `"${hookPath}" ${args.join(' ')}`;
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd || process.cwd(),
        timeout: 300000, // 5 minutes
        env: {
          ...process.env,
          TASK_ID: taskId || '',
        },
      });

      const executionTime = Date.now() - startTime;

      console.log(`   ✅ Hook completed in ${executionTime}ms`);
      if (stdout) {
        console.log(`   Output: ${stdout.slice(0, 200)}${stdout.length > 200 ? '...' : ''}`);
      }

      await LogService.info(`Hook executed: ${hookName}`, {
        taskId: taskId as any,
        category: 'orchestration',
        metadata: {
          hookName,
          executionTime,
          hasOutput: !!stdout,
        },
      });

      return {
        success: true,
        hookName,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        executionTime,
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      console.error(`   ❌ Hook failed: ${error.message}`);

      await LogService.error(`Hook failed: ${hookName}`, {
        taskId: taskId as any,
        category: 'orchestration',
        error,
        metadata: {
          hookName,
          executionTime,
        },
      });

      return {
        success: false,
        hookName,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        executionTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute auto-test hook
   * Runs tests before QA phase
   */
  static async executeAutoTest(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('auto-test', [repoPath], repoPath, taskId);
  }

  /**
   * Execute auto-format hook
   * Formats code before commits
   */
  static async executeAutoFormat(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('auto-format', [repoPath], repoPath, taskId);
  }

  /**
   * Execute auto-build hook
   * Builds project before deployment
   */
  static async executeAutoBuild(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('auto-build', [repoPath], repoPath, taskId);
  }

  /**
   * Execute security-scan hook
   * Scans for security vulnerabilities
   */
  static async executeSecurityScan(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('security-scan', [repoPath], repoPath, taskId);
  }

  /**
   * Execute file-protection hook
   * Checks if critical files can be modified
   */
  static async executeFileProtection(
    filePaths: string[],
    taskId?: string
  ): Promise<IHookResult> {
    return this.executeHook('file-protection', filePaths, undefined, taskId);
  }

  /**
   * Execute git-auto-add hook
   * Automatically stages files for commit
   */
  static async executeGitAutoAdd(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('git-auto-add', [repoPath], repoPath, taskId);
  }

  /**
   * Execute load-task-context hook
   * Loads task context for agent execution
   */
  static async executeLoadTaskContext(taskId: string): Promise<IHookResult> {
    return this.executeHook('load-task-context', [taskId], undefined, taskId);
  }

  /**
   * Execute auto-backup hook
   * Creates backup before major operations
   */
  static async executeAutoBackup(repoPath: string, taskId?: string): Promise<IHookResult> {
    return this.executeHook('auto-backup', [repoPath], repoPath, taskId);
  }

  /**
   * Execute tool-activity-logger hook
   * Logs tool usage for analytics
   */
  static async executeToolActivityLogger(
    toolName: string,
    taskId?: string
  ): Promise<IHookResult> {
    return this.executeHook('tool-activity-logger', [toolName], undefined, taskId);
  }

  /**
   * Check if a hook exists
   */
  static hookExists(hookName: HookType): boolean {
    const hookPath = path.join(this.hooksDir, `${hookName}.sh`);
    return fs.existsSync(hookPath);
  }

  /**
   * Get all available hooks
   */
  static getAvailableHooks(): HookType[] {
    if (!fs.existsSync(this.hooksDir)) {
      return [];
    }

    const files = fs.readdirSync(this.hooksDir);
    return files
      .filter((file) => file.endsWith('.sh'))
      .map((file) => file.replace('.sh', '') as HookType);
  }
}
