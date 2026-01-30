/**
 * Git Commit Helper - Automatic recovery when Developer forgets to commit/push
 *
 * USER REQUEST: "Tienes que forzar que los developers hagan commit si o si, y push no puede pasar eso"
 *
 * This helper detects when a Developer completed their work but forgot to commit/push,
 * and automatically executes the commit/push workflow for them.
 *
 * @see GIT_DEFENSE_SYSTEM.md for overall git safety strategy
 */

import { safeGitExecSync } from '../../../utils/safeGitExecution';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// MULTI-REPO SUPPORT: Scan all repos in workspace for changes
// ============================================================================

export interface RepoChangeInfo {
  repoName: string;
  repoPath: string;
  hasChanges: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  totalChanges: number;
}

/**
 * 🔥 MULTI-REPO: Scan ALL repositories in workspace for changes
 *
 * Instead of assuming one targetRepository, this scans the entire workspace
 * and returns which repos have uncommitted changes.
 *
 * @param workspacePath - Root workspace path (contains multiple repo directories)
 * @returns Array of repos with change info
 */
export function scanWorkspaceForChanges(workspacePath: string): RepoChangeInfo[] {
  const results: RepoChangeInfo[] = [];

  if (!fs.existsSync(workspacePath)) {
    console.warn(`⚠️ [scanWorkspaceForChanges] Workspace not found: ${workspacePath}`);
    return results;
  }

  const entries = fs.readdirSync(workspacePath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip non-directories and hidden files
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('team-')) {
      continue;
    }

    const repoPath = path.join(workspacePath, entry.name);
    const gitDir = path.join(repoPath, '.git');

    // Only process directories with .git (actual repos)
    if (!fs.existsSync(gitDir)) {
      continue;
    }

    // Check for changes in this repo
    try {
      const statusOutput = safeGitExecSync(`git status --porcelain`, {
        cwd: repoPath,
        encoding: 'utf8',
      });

      const modifiedFiles: string[] = [];
      const untrackedFiles: string[] = [];

      if (statusOutput && statusOutput.trim().length > 0) {
        const lines = statusOutput.trim().split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          const status = line.substring(0, 2);
          const file = line.substring(3).trim();

          if (status === '??') {
            untrackedFiles.push(file);
          } else {
            modifiedFiles.push(file);
          }
        }
      }

      const hasChanges = modifiedFiles.length > 0 || untrackedFiles.length > 0;

      results.push({
        repoName: entry.name,
        repoPath,
        hasChanges,
        modifiedFiles,
        untrackedFiles,
        totalChanges: modifiedFiles.length + untrackedFiles.length,
      });

      if (hasChanges) {
        console.log(`📦 [scanWorkspaceForChanges] ${entry.name}: ${modifiedFiles.length} modified, ${untrackedFiles.length} untracked`);
      }
    } catch (err: any) {
      console.warn(`⚠️ [scanWorkspaceForChanges] Error scanning ${entry.name}: ${err.message}`);
    }
  }

  const reposWithChanges = results.filter(r => r.hasChanges);
  console.log(`🔍 [scanWorkspaceForChanges] Scanned ${results.length} repos, ${reposWithChanges.length} have changes`);

  return results;
}

/**
 * 🔥 MULTI-REPO: Auto-commit changes in ALL repos that have modifications
 *
 * @param workspacePath - Root workspace path
 * @param commitMessage - Message for all commits
 * @param branchName - Branch to commit on (must exist in each repo)
 * @returns Array of commit results per repo
 */
export async function autoCommitAllRepos(
  workspacePath: string,
  commitMessage: string,
  branchName: string
): Promise<{ repoName: string; result: CommitRecoveryResult }[]> {
  const repos = scanWorkspaceForChanges(workspacePath);
  const reposWithChanges = repos.filter(r => r.hasChanges);

  if (reposWithChanges.length === 0) {
    console.log(`ℹ️ [autoCommitAllRepos] No repos have uncommitted changes`);
    return [];
  }

  console.log(`🔄 [autoCommitAllRepos] Committing changes in ${reposWithChanges.length} repo(s)...`);

  const results: { repoName: string; result: CommitRecoveryResult }[] = [];

  for (const repo of reposWithChanges) {
    console.log(`   📦 Committing: ${repo.repoName} (${repo.totalChanges} changes)`);
    const result = await autoCommitDeveloperWork(repo.repoPath, commitMessage, branchName);
    results.push({ repoName: repo.repoName, result });
  }

  return results;
}

// ============================================================================

export interface CommitRecoveryResult {
  success: boolean;
  commitSHA?: string;
  pushed?: boolean;
  error?: string;
  action: 'no_changes' | 'already_committed' | 'auto_committed' | 'failed';
  message: string;
}

/**
 * Auto-commit and push uncommitted changes when Developer forgets
 *
 * This is a SAFETY NET - we prefer Developers do it themselves, but if they forget,
 * we don't want to lose their work.
 *
 * @param repoPath - Path to the repository
 * @param storyTitle - Story title for commit message
 * @param branchName - Current branch name
 * @returns Result of commit/push operation
 *
 * @example
 * ```typescript
 * const result = await autoCommitDeveloperWork(
 *   '/path/to/repo',
 *   'Implement user authentication',
 *   'story/auth-123'
 * );
 *
 * if (result.success) {
 *   console.log(`✅ Auto-committed: ${result.commitSHA}`);
 * }
 * ```
 */
export async function autoCommitDeveloperWork(
  repoPath: string,
  storyTitle: string,
  branchName: string
): Promise<CommitRecoveryResult> {
  try {
    // Step 1: Check if there are uncommitted changes
    const statusOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, {
      encoding: 'utf8',
    });

    if (!statusOutput || statusOutput.trim().length === 0) {
      // No uncommitted changes - check if last commit exists and is pushed
      try {
        const localSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, {
          encoding: 'utf8',
        }).trim();

        // Check if commit exists on remote
        const lsRemote = safeGitExecSync(`cd "${repoPath}" && git ls-remote origin ${branchName}`, {
          encoding: 'utf8',
          timeout: 120000, // 2 minutes for git operations
        });

        if (lsRemote.includes(localSHA)) {
          return {
            success: true,
            commitSHA: localSHA,
            pushed: true,
            action: 'already_committed',
            message: 'Work already committed and pushed - no action needed',
          };
        } else {
          // Commit exists locally but not pushed - push it
          safeGitExecSync(`cd "${repoPath}" && git push origin HEAD`, {
            encoding: 'utf8',
            timeout: 60000,
          });
          // FIX: Sync local with remote after push
          try {
            safeGitExecSync(`cd "${repoPath}" && git pull origin HEAD --ff-only`, { encoding: 'utf8', timeout: 30000 });
          } catch (_pullErr) { /* already up to date */ }

          return {
            success: true,
            commitSHA: localSHA,
            pushed: true,
            action: 'already_committed',
            message: 'Commit exists locally - pushed to remote',
          };
        }
      } catch (error: any) {
        return {
          success: false,
          action: 'no_changes',
          error: error.message,
          message: 'No changes to commit and unable to verify existing commit',
        };
      }
    }

    console.log(`\n🔧 [AUTO-COMMIT] Developer forgot to commit - recovering work automatically...`);
    console.log(`   📂 Repository: ${repoPath}`);
    console.log(`   🌿 Branch: ${branchName}`);
    console.log(`   📝 Uncommitted files:\n${statusOutput}`);

    // Step 2: Stage all changes
    try {
      safeGitExecSync(`cd "${repoPath}" && git add .`, {
        encoding: 'utf8',
      });
      console.log(`   ✅ Staged all changes`);
    } catch (addError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to stage changes: ${addError.message}`,
        message: 'Could not stage changes for commit',
      };
    }

    // Step 3: Create commit with Conventional Commits format
    const commitMessage = `feat(story): ${storyTitle}

🔧 AUTO-COMMIT: Developer completed work but forgot to commit
Automatically committed by GitCommitHelper to preserve work.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>`;

    try {
      // Use heredoc for proper multi-line commit message formatting
      const commitCommand = `cd "${repoPath}" && git commit -m "$(cat <<'EOF'
${commitMessage}
EOF
)"`;

      safeGitExecSync(commitCommand, {
        encoding: 'utf8',
      });

      console.log(`   ✅ Created commit`);
    } catch (commitError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to commit: ${commitError.message}`,
        message: 'Could not create commit',
      };
    }

    // Step 4: Get commit SHA
    let commitSHA: string;
    try {
      commitSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, {
        encoding: 'utf8',
      }).trim();

      console.log(`   📍 Commit SHA: ${commitSHA}`);
    } catch (shaError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to get commit SHA: ${shaError.message}`,
        message: 'Commit created but unable to retrieve SHA',
      };
    }

    // Step 5: Push to remote
    try {
      safeGitExecSync(`cd "${repoPath}" && git push origin HEAD`, {
        encoding: 'utf8',
        timeout: 60000, // 60s timeout for push
      });
      // FIX: Sync local with remote after push
      try {
        safeGitExecSync(`cd "${repoPath}" && git pull origin HEAD --ff-only`, { encoding: 'utf8', timeout: 30000 });
      } catch (_pullErr) { /* already up to date */ }

      console.log(`   ✅ Pushed to remote`);
    } catch (pushError: any) {
      return {
        success: false,
        commitSHA,
        pushed: false,
        action: 'failed',
        error: `Failed to push: ${pushError.message}`,
        message: 'Commit created locally but push failed - commit is preserved',
      };
    }

    console.log(`\n✅ [AUTO-COMMIT] Successfully recovered Developer's work!`);
    console.log(`   📍 Commit SHA: ${commitSHA}`);
    console.log(`   🚀 Pushed to: ${branchName}`);

    return {
      success: true,
      commitSHA,
      pushed: true,
      action: 'auto_committed',
      message: `Auto-committed and pushed Developer's work to preserve changes`,
    };
  } catch (error: any) {
    return {
      success: false,
      action: 'failed',
      error: error.message,
      message: 'Unexpected error during auto-commit recovery',
    };
  }
}

/**
 * Detect if Developer output looks like work was done but not committed
 *
 * Heuristics:
 * - Has code changes (Edit/Write tool used)
 * - Missing FINISHED_SUCCESSFULLY marker
 * - Missing Commit SHA marker
 * - No git commit/push commands in output
 *
 * @param developerOutput - Raw output from Developer agent
 * @returns true if work appears done but not committed
 */
export function detectUncommittedWork(developerOutput: string): boolean {
  if (!developerOutput) return false;

  const output = developerOutput.toLowerCase();

  // Positive signals: work was done
  const hasCodeChanges =
    output.includes('edit(') ||
    output.includes('write(') ||
    output.includes('modified') ||
    output.includes('created file');

  // Negative signals: work was NOT committed
  const hasFinishedMarker = output.includes('✅ finished_successfully') || output.includes('✅ developer_finished_successfully');
  const hasCommitSHA = output.includes('📍 commit sha:') || /[a-f0-9]{40}/.test(output);
  const hasGitCommands = output.includes('git commit') || output.includes('git push');

  // Work done but not committed
  return hasCodeChanges && (!hasFinishedMarker || !hasCommitSHA || !hasGitCommands);
}

// ============================================================================
// WORKSPACE DETECTION - Check actual files, not just output
// ============================================================================

export interface WorkspaceDetectionResult {
  hasUncommittedFiles: boolean;
  hasUntrackedFiles: boolean;
  hasStagedFiles: boolean;
  modifiedFiles: string[];
  untrackedFiles: string[];
  totalChanges: number;
  detectionMethod: 'git_status' | 'output_heuristic' | 'both' | 'none';
}

/**
 * 🔥 IMPROVED DETECTION: Check workspace for actual changes
 *
 * This solves the problem where:
 * 1. Developer works but forgets to commit
 * 2. Developer doesn't output markers
 * 3. Git has no commits
 * 4. BUT workspace has modified files!
 *
 * @param repoPath - Path to the repository
 * @param developerOutput - Optional developer output for additional heuristics
 * @returns Detection result with details about found changes
 */
export function detectWorkInWorkspace(
  repoPath: string,
  developerOutput?: string
): WorkspaceDetectionResult {
  const result: WorkspaceDetectionResult = {
    hasUncommittedFiles: false,
    hasUntrackedFiles: false,
    hasStagedFiles: false,
    modifiedFiles: [],
    untrackedFiles: [],
    totalChanges: 0,
    detectionMethod: 'none',
  };

  // 1. Check git status for actual workspace state
  try {
    const statusOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, {
      encoding: 'utf8',
    });

    if (statusOutput && statusOutput.trim().length > 0) {
      const lines = statusOutput.trim().split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;

        const status = line.substring(0, 2);
        const file = line.substring(3).trim();

        // M = modified, A = added, D = deleted, R = renamed, C = copied
        if (status.includes('M') || status.includes('A') || status.includes('D') || status.includes('R') || status.includes('C')) {
          result.modifiedFiles.push(file);
          result.hasUncommittedFiles = true;
        }

        // ?? = untracked
        if (status === '??') {
          result.untrackedFiles.push(file);
          result.hasUntrackedFiles = true;
        }

        // First character is index status (staged)
        if (status[0] !== ' ' && status[0] !== '?') {
          result.hasStagedFiles = true;
        }
      }

      result.totalChanges = result.modifiedFiles.length + result.untrackedFiles.length;
      result.detectionMethod = 'git_status';

      console.log(`🔍 [WorkspaceDetection] Found changes in workspace:`);
      console.log(`   Modified files: ${result.modifiedFiles.length}`);
      console.log(`   Untracked files: ${result.untrackedFiles.length}`);
      console.log(`   Total changes: ${result.totalChanges}`);
    }
  } catch (error: any) {
    console.warn(`⚠️ [WorkspaceDetection] git status failed: ${error.message}`);
  }

  // 2. Also check developer output as fallback/additional signal
  if (developerOutput) {
    const outputShowsWork = detectUncommittedWork(developerOutput);
    if (outputShowsWork) {
      if (result.detectionMethod === 'git_status') {
        result.detectionMethod = 'both';
      } else {
        result.detectionMethod = 'output_heuristic';
        // Even if git status showed nothing, output suggests work was done
        // This handles cases where files were modified but then reverted
        result.hasUncommittedFiles = true;
      }
    }
  }

  return result;
}

/**
 * 🔥 COMPREHENSIVE RECOVERY: Detect and recover any work in workspace
 *
 * Combines all detection methods and attempts recovery:
 * 1. Check git status for uncommitted files
 * 2. Check developer output for Edit/Write calls
 * 3. Auto-commit and push if any work found
 * 4. Return result indicating if recovery to Judge is possible
 *
 * @param repoPath - Path to the repository
 * @param storyTitle - Story title for commit message
 * @param branchName - Branch name for push
 * @param developerOutput - Developer output for heuristic detection
 * @returns Recovery result with commit SHA if successful
 */
export async function comprehensiveWorkRecovery(
  repoPath: string,
  storyTitle: string,
  branchName: string,
  developerOutput?: string
): Promise<CommitRecoveryResult & { workspaceDetection: WorkspaceDetectionResult }> {
  console.log(`\n🔍 [COMPREHENSIVE RECOVERY] Starting work detection...`);
  console.log(`   Repository: ${repoPath}`);
  console.log(`   Branch: ${branchName}`);

  // Step 1: Detect work in workspace
  const detection = detectWorkInWorkspace(repoPath, developerOutput);

  // Step 2: If any work detected, attempt recovery
  if (detection.hasUncommittedFiles || detection.hasUntrackedFiles || detection.detectionMethod === 'output_heuristic') {
    console.log(`\n✅ [COMPREHENSIVE RECOVERY] Work detected! Attempting auto-commit...`);
    console.log(`   Detection method: ${detection.detectionMethod}`);
    console.log(`   Files found: ${detection.totalChanges}`);

    const commitResult = await autoCommitDeveloperWork(repoPath, storyTitle, branchName);

    return {
      ...commitResult,
      workspaceDetection: detection,
    };
  }

  // Step 3: No work detected
  console.log(`\n⚠️ [COMPREHENSIVE RECOVERY] No work detected in workspace`);
  console.log(`   Detection method: ${detection.detectionMethod}`);

  return {
    success: false,
    action: 'no_changes',
    message: 'No uncommitted work detected in workspace',
    workspaceDetection: detection,
  };
}

// ============================================================================
// GIT FETCH WITH RETRY - Exponential backoff for network operations
// ============================================================================

import { GIT_TIMEOUTS, RETRY_CONFIG, calculateBackoffDelay } from '../constants/Timeouts';

export interface GitFetchResult {
  success: boolean;
  attempt: number;
  error?: string;
}

/**
 * Git fetch with exponential backoff retry
 *
 * Replaces scattered retry logic in DevelopersPhase, JudgePhase, etc.
 */
export async function gitFetchWithRetry(
  repoPath: string,
  options: {
    maxRetries?: number;
    timeout?: number;
    prune?: boolean;
  } = {}
): Promise<GitFetchResult> {
  const {
    maxRetries = RETRY_CONFIG.GIT_FETCH_MAX_RETRIES,
    timeout = GIT_TIMEOUTS.FETCH,
    prune = true,
  } = options;

  const fetchCommand = prune ? 'git fetch origin --prune' : 'git fetch origin';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      safeGitExecSync(`cd "${repoPath}" && ${fetchCommand}`, {
        encoding: 'utf8',
        timeout,
      });

      return { success: true, attempt };
    } catch (error: any) {
      console.warn(`⚠️ [Git Fetch] Attempt ${attempt}/${maxRetries} failed: ${error.message}`);

      if (attempt < maxRetries) {
        const waitMs = calculateBackoffDelay(attempt);
        console.log(`   ⏳ Waiting ${waitMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      } else {
        return {
          success: false,
          attempt,
          error: `Git fetch failed after ${maxRetries} attempts: ${error.message}`,
        };
      }
    }
  }

  return { success: false, attempt: maxRetries, error: 'Unexpected exit from retry loop' };
}

// ============================================================================
// ENSURE BRANCH ON REMOTE - Push and verify branch exists
// ============================================================================

export interface EnsureBranchResult {
  success: boolean;
  existed: boolean;
  pushed: boolean;
  error?: string;
}

/**
 * Ensure branch exists on remote, pushing if necessary
 *
 * Replaces verbose multi-step branch verification logic in DevelopersPhase
 */
export async function ensureBranchOnRemote(
  repoPath: string,
  branchName: string,
  options: {
    force?: boolean;
    setUpstream?: boolean;
    timeout?: number;
  } = {}
): Promise<EnsureBranchResult> {
  const {
    force = false,
    setUpstream = true,
    timeout = GIT_TIMEOUTS.PUSH,
  } = options;

  try {
    // Check if branch exists on remote
    let existed = false;
    try {
      safeGitExecSync(`cd "${repoPath}" && git ls-remote --heads origin ${branchName}`, {
        encoding: 'utf8',
        timeout: GIT_TIMEOUTS.LS_REMOTE,
      });
      existed = true;
      console.log(`   📌 Branch ${branchName} already exists on remote`);
    } catch {
      console.log(`   📌 Branch ${branchName} not on remote - will push`);
    }

    // Push branch
    const forceFlag = force ? '--force' : '';
    const upstreamFlag = setUpstream ? '-u' : '';
    const pushCommand = `cd "${repoPath}" && git push ${forceFlag} ${upstreamFlag} origin ${branchName}`.replace(/\s+/g, ' ');

    safeGitExecSync(pushCommand, {
      encoding: 'utf8',
      timeout,
    });

    console.log(`   ✅ Branch ${branchName} pushed to remote`);

    return {
      success: true,
      existed,
      pushed: true,
    };
  } catch (error: any) {
    return {
      success: false,
      existed: false,
      pushed: false,
      error: `Failed to ensure branch on remote: ${error.message}`,
    };
  }
}

/**
 * Get current branch name
 */
export function getCurrentBranch(repoPath: string): string | null {
  try {
    return safeGitExecSync(`cd "${repoPath}" && git rev-parse --abbrev-ref HEAD`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get current commit SHA
 */
export function getCurrentCommitSHA(repoPath: string): string | null {
  try {
    return safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
