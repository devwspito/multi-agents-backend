/**
 * Safe Git Execution Utilities
 *
 * Provides timeout-protected wrappers for Git operations to prevent hanging
 * on network issues, credential prompts, or other blocking operations.
 *
 * CRITICAL: All git operations that interact with remotes MUST use these wrappers
 * to prevent the entire application from hanging.
 */

import { exec, execSync as nodeExecSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Default timeouts for different git operations
const GIT_TIMEOUTS = {
  FETCH: 15000,    // 15 seconds for fetch
  PUSH: 30000,     // 30 seconds for push
  PULL: 30000,     // 30 seconds for pull
  CLONE: 60000,    // 60 seconds for clone
  LS_REMOTE: 10000, // 10 seconds for ls-remote
  DEFAULT: 20000,   // 20 seconds default
};

/**
 * Execute a git command with timeout protection (async)
 *
 * @param command - Git command to execute
 * @param options - Execution options
 * @returns Promise with command output
 * @throws Error if command fails or times out
 */
export async function safeGitExec(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<{ stdout: string; stderr: string }> {
  // Determine timeout based on command type
  let timeout = options.timeout || GIT_TIMEOUTS.DEFAULT;

  if (command.includes('push')) timeout = options.timeout || GIT_TIMEOUTS.PUSH;
  else if (command.includes('pull')) timeout = options.timeout || GIT_TIMEOUTS.PULL;
  else if (command.includes('fetch')) timeout = options.timeout || GIT_TIMEOUTS.FETCH;
  else if (command.includes('clone')) timeout = options.timeout || GIT_TIMEOUTS.CLONE;
  else if (command.includes('ls-remote')) timeout = options.timeout || GIT_TIMEOUTS.LS_REMOTE;

  // Wrap command with timeout utility (works on Unix systems)
  const timeoutSeconds = Math.ceil(timeout / 1000);
  const safeCommand = `timeout ${timeoutSeconds} ${command}`;

  console.log(`⏱️  [Git] Executing with ${timeoutSeconds}s timeout: ${command.substring(0, 50)}...`);

  try {
    const result = await Promise.race([
      execAsync(safeCommand, {
        cwd: options.cwd,
        env: options.env || process.env,
        timeout: timeout + 1000, // Node timeout slightly higher than shell timeout
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Git command timed out after ${timeoutSeconds}s: ${command}`)), timeout)
      ),
    ]);

    return result;
  } catch (error: any) {
    // Check if it's a timeout error
    if (error.message.includes('timed out') || error.code === 124) {
      console.error(`❌ [Git] Command timed out after ${timeoutSeconds}s: ${command.substring(0, 50)}...`);
      throw new Error(`Git operation timed out after ${timeoutSeconds} seconds. This usually means:
- Network connectivity issues
- Git is waiting for credentials (check your auth setup)
- Remote repository is not responding
- The operation is taking longer than expected

Command: ${command}`);
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Execute a git command with timeout protection (sync)
 *
 * @param command - Git command to execute
 * @param options - Execution options
 * @returns Command output string
 * @throws Error if command fails or times out
 */
export function safeGitExecSync(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    encoding?: BufferEncoding;
  } = {}
): string {
  // Determine timeout based on command type
  let timeout = options.timeout || GIT_TIMEOUTS.DEFAULT;

  if (command.includes('push')) timeout = options.timeout || GIT_TIMEOUTS.PUSH;
  else if (command.includes('pull')) timeout = options.timeout || GIT_TIMEOUTS.PULL;
  else if (command.includes('fetch')) timeout = options.timeout || GIT_TIMEOUTS.FETCH;
  else if (command.includes('clone')) timeout = options.timeout || GIT_TIMEOUTS.CLONE;
  else if (command.includes('ls-remote')) timeout = options.timeout || GIT_TIMEOUTS.LS_REMOTE;

  // Wrap command with timeout utility
  const timeoutSeconds = Math.ceil(timeout / 1000);
  const safeCommand = `timeout ${timeoutSeconds} ${command} 2>&1 || echo "GIT_TIMEOUT_ERROR:$?"`;

  console.log(`⏱️  [Git] Executing sync with ${timeoutSeconds}s timeout: ${command.substring(0, 50)}...`);

  try {
    const result = nodeExecSync(safeCommand, {
      cwd: options.cwd,
      encoding: options.encoding || 'utf8',
      timeout: timeout + 1000, // Node timeout slightly higher
    });

    // Check if command timed out
    if (result.includes('GIT_TIMEOUT_ERROR:124')) {
      throw new Error(`Git operation timed out after ${timeoutSeconds} seconds`);
    }

    return result as string;
  } catch (error: any) {
    // Check if it's a timeout error
    if (error.message.includes('timed out') || error.message.includes('GIT_TIMEOUT_ERROR')) {
      console.error(`❌ [Git] Command timed out after ${timeoutSeconds}s: ${command.substring(0, 50)}...`);
      throw new Error(`Git operation timed out after ${timeoutSeconds} seconds. Check network/auth.`);
    }

    // Re-throw other errors
    throw error;
  }
}

/**
 * Safely verify if a branch exists on remote
 *
 * @param repoPath - Repository path
 * @param branchName - Branch name to check
 * @returns True if branch exists, false otherwise
 */
export async function safeVerifyRemoteBranch(
  repoPath: string,
  branchName: string
): Promise<boolean> {
  try {
    const result = await safeGitExec(
      `git ls-remote --heads origin ${branchName}`,
      {
        cwd: repoPath,
        timeout: GIT_TIMEOUTS.LS_REMOTE,
      }
    );

    return result.stdout.includes(branchName);
  } catch (error: any) {
    console.warn(`⚠️  [Git] Could not verify remote branch ${branchName}: ${error.message}`);
    return false; // Assume branch doesn't exist if we can't check
  }
}

/**
 * Safely push a branch to remote
 *
 * @param repoPath - Repository path
 * @param branchName - Branch name to push
 * @param options - Additional options
 * @returns True if push succeeded, false otherwise
 */
export async function safePushBranch(
  repoPath: string,
  branchName: string,
  options: {
    setUpstream?: boolean;
    force?: boolean;
    timeout?: number;
  } = {}
): Promise<boolean> {
  try {
    const pushFlags = [];
    if (options.setUpstream) pushFlags.push('-u');
    if (options.force) pushFlags.push('--force-with-lease');

    const pushCommand = `git push ${pushFlags.join(' ')} origin ${branchName}`.trim();

    await safeGitExec(pushCommand, {
      cwd: repoPath,
      timeout: options.timeout || GIT_TIMEOUTS.PUSH,
    });

    console.log(`✅ [Git] Successfully pushed ${branchName}`);
    return true;
  } catch (error: any) {
    console.error(`❌ [Git] Failed to push ${branchName}: ${error.message}`);
    return false;
  }
}

/**
 * Safely fetch from remote
 *
 * @param repoPath - Repository path
 * @param options - Fetch options
 * @returns True if fetch succeeded, false otherwise
 */
export async function safeFetch(
  repoPath: string,
  options: {
    all?: boolean;
    prune?: boolean;
    timeout?: number;
  } = {}
): Promise<boolean> {
  try {
    const fetchFlags = [];
    if (options.all) fetchFlags.push('--all');
    if (options.prune) fetchFlags.push('--prune');

    const fetchCommand = `git fetch ${fetchFlags.join(' ')}`.trim();

    await safeGitExec(fetchCommand, {
      cwd: repoPath,
      timeout: options.timeout || GIT_TIMEOUTS.FETCH,
    });

    console.log(`✅ [Git] Successfully fetched from remote`);
    return true;
  } catch (error: any) {
    console.error(`❌ [Git] Failed to fetch: ${error.message}`);
    return false;
  }
}

/**
 * Safe wrapper for git pull
 *
 * @param repoPath - Repository path
 * @param options - Pull options
 * @returns True if pull succeeded, false otherwise
 */
export async function safePull(
  repoPath: string,
  options: {
    rebase?: boolean;
    timeout?: number;
  } = {}
): Promise<boolean> {
  try {
    const pullFlags = [];
    if (options.rebase) pullFlags.push('--rebase');

    const pullCommand = `git pull ${pullFlags.join(' ')}`.trim();

    await safeGitExec(pullCommand, {
      cwd: repoPath,
      timeout: options.timeout || GIT_TIMEOUTS.PULL,
    });

    console.log(`✅ [Git] Successfully pulled from remote`);
    return true;
  } catch (error: any) {
    console.error(`❌ [Git] Failed to pull: ${error.message}`);
    return false;
  }
}