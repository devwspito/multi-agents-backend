/**
 * Safe Git Execution Utilities
 *
 * Provides OPTIONAL timeout protection for Git operations.
 * Timeouts are OPT-IN via environment variable to avoid breaking working operations.
 *
 * Set GIT_ENABLE_TIMEOUTS=true to enable timeouts (use only if you have hanging issues)
 */

import { exec, execSync as nodeExecSync } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Normalize repository name by removing .git suffix
 * Ensures consistent naming across cloning, path resolution, and git operations
 *
 * @example
 * normalizeRepoName("v2_backend.git") // "v2_backend"
 * normalizeRepoName("v2_backend") // "v2_backend"
 */
export function normalizeRepoName(name: string): string {
  return name.replace(/\.git$/, '');
}

// Timeouts are OPT-IN - only used if GIT_ENABLE_TIMEOUTS=true
const TIMEOUTS_ENABLED = process.env.GIT_ENABLE_TIMEOUTS === 'true';

// Generous timeouts for large repositories and slow connections
const GIT_TIMEOUTS = {
  FETCH: 120000,    // 2 minutes for fetch
  PUSH: 180000,     // 3 minutes for push
  PULL: 180000,     // 3 minutes for pull
  CLONE: 300000,    // 5 minutes for clone
  LS_REMOTE: 30000, // 30 seconds for ls-remote
  DEFAULT: 120000,  // 2 minutes default
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
  // Only use timeout if explicitly enabled or explicitly provided
  const useTimeout = TIMEOUTS_ENABLED || options.timeout !== undefined;

  if (!useTimeout) {
    // No timeout - let git operation complete naturally
    return await execAsync(command, {
      cwd: options.cwd,
      env: options.env || process.env,
    });
  }

  // Determine timeout based on command type (only when enabled)
  let timeout = options.timeout || GIT_TIMEOUTS.DEFAULT;

  if (command.includes('push')) timeout = options.timeout || GIT_TIMEOUTS.PUSH;
  else if (command.includes('pull')) timeout = options.timeout || GIT_TIMEOUTS.PULL;
  else if (command.includes('fetch')) timeout = options.timeout || GIT_TIMEOUTS.FETCH;
  else if (command.includes('clone')) timeout = options.timeout || GIT_TIMEOUTS.CLONE;
  else if (command.includes('ls-remote')) timeout = options.timeout || GIT_TIMEOUTS.LS_REMOTE;

  const timeoutSeconds = Math.ceil(timeout / 1000);
  console.log(`⏱️  [Git] Executing with ${timeoutSeconds}s timeout: ${command.substring(0, 50)}...`);

  try {
    const result = await execAsync(command, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: timeout,
    });

    return result;
  } catch (error: any) {
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.killed) {
      console.error(`❌ [Git] Command timed out after ${timeoutSeconds}s: ${command.substring(0, 50)}...`);
      throw new Error(`Git operation timed out after ${timeoutSeconds} seconds`);
    }
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
  // Only use timeout if explicitly enabled or explicitly provided
  const useTimeout = TIMEOUTS_ENABLED || options.timeout !== undefined;

  if (!useTimeout) {
    // No timeout - let git operation complete naturally
    try {
      return nodeExecSync(command, {
        cwd: options.cwd,
        encoding: options.encoding || 'utf8',
      }) as string;
    } catch (error: any) {
      // Enhance error message with context
      if (error.code === 'ENOENT' || error.message?.includes('ENOENT')) {
        throw new Error(
          `Failed to execute git command (directory not found or invalid): ${command}\n` +
          `  Working directory: ${options.cwd || process.cwd()}\n` +
          `  Error: ${error.message}`
        );
      }
      throw error;
    }
  }

  // Determine timeout based on command type (only when enabled)
  let timeout = options.timeout || GIT_TIMEOUTS.DEFAULT;

  if (command.includes('push')) timeout = options.timeout || GIT_TIMEOUTS.PUSH;
  else if (command.includes('pull')) timeout = options.timeout || GIT_TIMEOUTS.PULL;
  else if (command.includes('fetch')) timeout = options.timeout || GIT_TIMEOUTS.FETCH;
  else if (command.includes('clone')) timeout = options.timeout || GIT_TIMEOUTS.CLONE;
  else if (command.includes('ls-remote')) timeout = options.timeout || GIT_TIMEOUTS.LS_REMOTE;

  const timeoutSeconds = Math.ceil(timeout / 1000);
  console.log(`⏱️  [Git] Executing sync with ${timeoutSeconds}s timeout: ${command.substring(0, 50)}...`);

  try {
    const result = nodeExecSync(command, {
      cwd: options.cwd,
      encoding: options.encoding || 'utf8',
      timeout: timeout,
    });

    return result as string;
  } catch (error: any) {
    if (error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM' || error.message.includes('ETIMEDOUT')) {
      console.error(`❌ [Git] Command timed out after ${timeoutSeconds}s: ${command.substring(0, 50)}...`);
      throw new Error(`Git operation timed out after ${timeoutSeconds} seconds`);
    }
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

/**
 * Fix git remote URL to remove embedded token and use credential helper
 *
 * Removes expired/invalid tokens from remote URLs that cause authentication failures.
 * Replaces `https://TOKEN@github.com/user/repo` with `https://github.com/user/repo`
 * so git uses the system credential helper (GitHub CLI, osxkeychain, etc.)
 *
 * @param repoPath - Path to the git repository
 * @returns true if remote was fixed, false if no fix needed
 */
export function fixGitRemoteAuth(repoPath: string): boolean {
  try {
    // Get current remote URL
    const currentRemote = nodeExecSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000
    }).trim();

    // Check if remote has embedded token
    if (currentRemote.includes('@github.com') && !currentRemote.startsWith('git@')) {
      console.log(`🔧 [Git] Fixing remote URL to use credential helper...`);
      console.log(`   Old remote: ${currentRemote.replace(/\/\/.*@/, '//*****@')}`); // Mask token

      // Extract repo path (user/repo)
      const repoMatch = currentRemote.match(/github\.com\/(.+?)(?:\.git)?$/);
      if (repoMatch) {
        const githubRepoPath = repoMatch[1].replace(/\.git$/, '');
        const newRemote = `https://github.com/${githubRepoPath}`;

        nodeExecSync(`git remote set-url origin ${newRemote}`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: 5000
        });

        console.log(`   ✅ Remote URL updated to: ${newRemote}`);
        return true;
      }
    }

    return false; // No fix needed
  } catch (error: any) {
    console.warn(`⚠️  [Git] Could not fix remote URL: ${error.message}`);
    return false;
  }
}