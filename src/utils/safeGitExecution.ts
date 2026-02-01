/**
 * Safe Git Execution Utilities
 *
 * Provides OPTIONAL timeout protection for Git operations.
 * Timeouts are OPT-IN via environment variable to avoid breaking working operations.
 *
 * Set GIT_ENABLE_TIMEOUTS=true to enable timeouts (use only if you have hanging issues)
 *
 * 🚀 PERFORMANCE: Includes fetch caching to avoid redundant git fetch operations
 *
 * 🔥 CRITICAL: Git commands ALWAYS execute on the HOST, never in Docker sandbox.
 * Reason: Docker containers have different file ownership (UID mapping),
 * causing "dubious ownership" errors when git runs inside the container.
 *
 * Sandbox is for: build, dev server, tests
 * Host is for: git operations, file writes (via Claude SDK tools)
 */

import { exec, execSync as nodeExecSync } from 'child_process';
import { promisify } from 'util';
import { GIT_TIMEOUTS } from '../services/orchestration/constants/Timeouts.js';

const execAsync = promisify(exec);

// ==================== GIT FETCH CACHE ====================
// Prevents redundant git fetch operations within a short time window

interface FetchCacheEntry {
  lastFetch: number;
  success: boolean;
}

// Map of repoPath -> last fetch timestamp
const gitFetchCache = new Map<string, FetchCacheEntry>();

// Cache duration: 60 seconds (don't refetch within this window)
const FETCH_CACHE_DURATION_MS = 60000;

/**
 * Check if we need to fetch or can use cached result
 * @param repoPath - Repository path
 * @returns true if we should skip fetch (already fetched recently)
 */
export function shouldSkipFetch(repoPath: string): boolean {
  const cached = gitFetchCache.get(repoPath);
  if (!cached) return false;

  const age = Date.now() - cached.lastFetch;
  if (age < FETCH_CACHE_DURATION_MS) {
    console.log(`⚡ [GitCache] Skipping fetch for ${repoPath} (fetched ${Math.round(age / 1000)}s ago)`);
    return true;
  }

  return false;
}

/**
 * Record a successful fetch for caching
 * @param repoPath - Repository path
 */
export function recordFetch(repoPath: string): void {
  gitFetchCache.set(repoPath, {
    lastFetch: Date.now(),
    success: true,
  });
}

/**
 * Clear fetch cache for a repository (use after push/pull to ensure fresh data)
 * @param repoPath - Repository path
 */
export function clearFetchCache(repoPath: string): void {
  gitFetchCache.delete(repoPath);
}

/**
 * Clear all fetch caches (use at phase boundaries)
 */
export function clearAllFetchCaches(): void {
  gitFetchCache.clear();
}

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
// GIT_TIMEOUTS imported from centralized constants (Timeouts.ts)

/**
 * Execute a git command with timeout protection (async)
 *
 * 🔥 CRITICAL: Git commands ALWAYS execute on the HOST, never in sandbox.
 * Reason: Docker containers have different file ownership (UID mapping),
 * causing "dubious ownership" errors when git runs inside the container
 * on files created/cloned by the host user.
 *
 * The sandbox is for: build, dev server, tests
 * NOT for: git operations (clone, checkout, commit, push, etc.)
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
  // 🔥 GIT ALWAYS RUNS ON HOST - Never in sandbox
  // This avoids "dubious ownership" errors from UID mismatch between host and container

  // Host execution
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
 * 🔥 CRITICAL: Git commands ALWAYS execute on the HOST, never in sandbox.
 * Reason: Docker containers have different file ownership (UID mapping),
 * causing "dubious ownership" errors when git runs inside the container
 * on files created/cloned by the host user.
 *
 * The sandbox is for: build, dev server, tests
 * NOT for: git operations (clone, checkout, commit, push, etc.)
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
  // 🔥 GIT ALWAYS RUNS ON HOST - Never in sandbox
  // This avoids "dubious ownership" errors from UID mismatch between host and container

  // Host execution
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
 * 🚀 Smart git fetch that uses caching to avoid redundant fetches
 *
 * @param repoPath - Repository path
 * @param options - Execution options
 * @returns Command output
 */
export function smartGitFetch(
  repoPath: string,
  options: {
    timeout?: number;
    force?: boolean;  // Force fetch even if cached
  } = {}
): string {
  // Check cache (unless force is specified)
  if (!options.force && shouldSkipFetch(repoPath)) {
    return ''; // Already fetched recently
  }

  try {
    const result = safeGitExecSync(`git fetch origin`, {
      cwd: repoPath,
      timeout: options.timeout || 90000,
    });

    // Record successful fetch
    recordFetch(repoPath);
    console.log(`✅ [GitCache] Fetched and cached for ${repoPath}`);

    return result;
  } catch (error) {
    console.warn(`⚠️ [GitCache] Fetch failed for ${repoPath}: ${error}`);
    throw error;
  }
}

/**
 * 🚀 Smart git fetch (async version) that uses caching
 *
 * @param repoPath - Repository path
 * @param options - Execution options
 * @returns Promise with command output
 */
export async function smartGitFetchAsync(
  repoPath: string,
  options: {
    timeout?: number;
    force?: boolean;
  } = {}
): Promise<string> {
  // Check cache (unless force is specified)
  if (!options.force && shouldSkipFetch(repoPath)) {
    return ''; // Already fetched recently
  }

  try {
    const result = await safeGitExec(`git fetch origin`, {
      cwd: repoPath,
      timeout: options.timeout || 90000,
    });

    // Record successful fetch
    recordFetch(repoPath);
    console.log(`✅ [GitCache] Async fetched and cached for ${repoPath}`);

    return result.stdout;
  } catch (error) {
    console.warn(`⚠️ [GitCache] Async fetch failed for ${repoPath}: ${error}`);
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
 * Validate git remote URL for security
 *
 * Validates that git remote URLs match expected patterns to prevent:
 * - Pushing to wrong organization/account
 * - Accidentally exposing code to unauthorized repos
 * - Security breaches via malicious remote URLs
 *
 * @param repoPath - Path to the git repository
 * @param options - Validation options
 * @returns Validation result with details
 */
export function validateGitRemoteUrl(
  repoPath: string,
  options: {
    allowedHosts?: string[];
    allowedOrganizations?: string[];
    requireHttps?: boolean;
  } = {}
): { valid: boolean; reason?: string; remoteUrl?: string } {
  try {
    // Get current remote URL
    const remoteUrl = nodeExecSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    console.log(`\n🔍 [Git] Validating remote URL for security...`);
    console.log(`   Repository path: ${repoPath}`);
    console.log(`   Remote URL: ${remoteUrl}`);

    // Default allowed hosts (GitHub, GitLab, Bitbucket, self-hosted)
    const allowedHosts = options.allowedHosts || [
      'github.com',
      'gitlab.com',
      'bitbucket.org',
    ];

    // Check 1: HTTPS requirement (security best practice)
    if (options.requireHttps !== false) {
      if (!remoteUrl.startsWith('https://') && !remoteUrl.startsWith('git@')) {
        console.error(`   ❌ Remote URL does NOT use HTTPS or SSH`);
        return {
          valid: false,
          reason: `Remote URL must use HTTPS or SSH protocol for security. Current: ${remoteUrl.split(':')[0]}://`,
          remoteUrl,
        };
      }
    }

    // Check 2: Allowed hosts (prevent push to unauthorized servers)
    let hostMatch = false;
    for (const allowedHost of allowedHosts) {
      if (remoteUrl.includes(allowedHost)) {
        hostMatch = true;
        console.log(`   ✅ Host matches allowed list: ${allowedHost}`);
        break;
      }
    }

    if (!hostMatch) {
      console.error(`   ❌ Host NOT in allowed list: ${allowedHosts.join(', ')}`);
      return {
        valid: false,
        reason: `Remote host not in allowed list. Allowed: ${allowedHosts.join(', ')}. Current URL: ${remoteUrl}`,
        remoteUrl,
      };
    }

    // Check 3: Organization/user validation (if specified)
    if (options.allowedOrganizations && options.allowedOrganizations.length > 0) {
      let orgMatch = false;

      for (const org of options.allowedOrganizations) {
        // Match patterns: github.com/ORG/repo or github.com:ORG/repo
        if (remoteUrl.includes(`/${org}/`) || remoteUrl.includes(`:${org}/`)) {
          orgMatch = true;
          console.log(`   ✅ Organization matches allowed list: ${org}`);
          break;
        }
      }

      if (!orgMatch) {
        console.error(`   ❌ Organization NOT in allowed list: ${options.allowedOrganizations.join(', ')}`);
        return {
          valid: false,
          reason: `Repository organization not in allowed list. Allowed: ${options.allowedOrganizations.join(', ')}. Current URL: ${remoteUrl}`,
          remoteUrl,
        };
      }
    }

    // Check 4: Detect suspicious patterns (embedded credentials, IP addresses, etc.)
    const suspiciousPatterns = [
      { pattern: /\/\/[^@]+:[^@]+@/, name: 'embedded credentials (user:pass@)' },
      { pattern: /\/\/\d+\.\d+\.\d+\.\d+/, name: 'IP address instead of domain' },
      { pattern: /localhost|127\.0\.0\.1/, name: 'localhost reference' },
    ];

    for (const { pattern, name } of suspiciousPatterns) {
      if (pattern.test(remoteUrl)) {
        console.warn(`   ⚠️  Suspicious pattern detected: ${name}`);
        console.warn(`   🔒 This may be a security risk - please review`);
        return {
          valid: false,
          reason: `Suspicious pattern detected in remote URL: ${name}. URL: ${remoteUrl}`,
          remoteUrl,
        };
      }
    }

    console.log(`   ✅ Remote URL passed all security validation checks`);

    return {
      valid: true,
      remoteUrl,
    };
  } catch (error: any) {
    console.error(`   ❌ Failed to validate remote URL: ${error.message}`);
    return {
      valid: false,
      reason: `Failed to get remote URL: ${error.message}`,
    };
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

/**
 * 🔥 Safe checkout or create branch - handles resume scenarios
 *
 * This function handles the common pattern where we need to checkout a branch
 * but it might already exist (from a previous run or resume scenario).
 *
 * Strategy:
 * 1. Try to create branch with -b (new branch)
 * 2. If fails because "already exists", checkout existing branch
 * 3. If local checkout fails, try tracking from remote
 *
 * @param branchName - Name of the branch to checkout/create
 * @param repoPath - Repository path
 * @param options - Options for the operation
 * @returns Object with success status and whether branch was created or checked out
 */
export function safeCheckoutBranch(
  branchName: string,
  repoPath: string,
  options: {
    createFrom?: string; // Base branch to create from (e.g., "main", "origin/main")
    pullAfterCheckout?: boolean; // Pull latest after checkout
    timeout?: number;
  } = {}
): { success: boolean; created: boolean; error?: string } {
  const timeout = options.timeout || GIT_TIMEOUTS.DEFAULT;

  try {
    // STEP 1: Try to create new branch
    try {
      const createCmd = options.createFrom
        ? `git checkout -b ${branchName} ${options.createFrom}`
        : `git checkout -b ${branchName}`;

      nodeExecSync(createCmd, {
        cwd: repoPath,
        encoding: 'utf8',
        timeout,
      });

      console.log(`✅ [Git] Created new branch: ${branchName}`);
      return { success: true, created: true };
    } catch (createErr: any) {
      // Check if branch already exists
      if (createErr.message.includes('already exists')) {
        console.log(`   ℹ️ [Git] Branch ${branchName} already exists, checking out...`);

        // STEP 2: Try to checkout existing local branch
        try {
          nodeExecSync(`git checkout ${branchName}`, {
            cwd: repoPath,
            encoding: 'utf8',
            timeout,
          });

          // Optionally pull latest
          if (options.pullAfterCheckout) {
            try {
              nodeExecSync(`git pull origin ${branchName} --rebase`, {
                cwd: repoPath,
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.PULL,
              });
              console.log(`   ✅ [Git] Pulled latest from remote`);
            } catch (pullErr: any) {
              console.log(`   ℹ️ [Git] Pull skipped: ${pullErr.message.split('\n')[0]}`);
            }
          }

          console.log(`✅ [Git] Checked out existing branch: ${branchName}`);
          return { success: true, created: false };
        } catch (checkoutErr: any) {
          // STEP 3: Try tracking from remote
          console.log(`   ℹ️ [Git] Local checkout failed, trying remote tracking...`);
          try {
            nodeExecSync(`git checkout -b ${branchName} origin/${branchName}`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout,
            });

            console.log(`✅ [Git] Checked out branch from remote: ${branchName}`);
            return { success: true, created: false };
          } catch (trackErr: any) {
            throw new Error(`Failed to checkout ${branchName}: ${trackErr.message}`);
          }
        }
      } else {
        // Different error, not "already exists"
        throw createErr;
      }
    }
  } catch (error: any) {
    console.error(`❌ [Git] Branch operation failed for ${branchName}: ${error.message}`);
    return { success: false, created: false, error: error.message };
  }
}

/**
 * Async version of safeCheckoutBranch
 */
export async function safeCheckoutBranchAsync(
  branchName: string,
  repoPath: string,
  options: {
    createFrom?: string;
    pullAfterCheckout?: boolean;
    timeout?: number;
  } = {}
): Promise<{ success: boolean; created: boolean; error?: string }> {
  // Use the sync version wrapped in a promise for now
  // This could be refactored to use async git operations if needed
  return new Promise((resolve) => {
    const result = safeCheckoutBranch(branchName, repoPath, options);
    resolve(result);
  });
}