/**
 * Git Verification Service
 *
 * Handles all git verification, sync, and push operations for the story pipeline.
 * Extracted from StoryPipelineService for maintainability.
 */

import { safeGitExecSync, smartGitFetch } from '../../utils/safeGitExecution';
import { GIT_TIMEOUTS } from './constants/Timeouts';

export interface GitVerificationResult {
  commitSHA: string | null;
  hasCommits: boolean;
  commitCount: number;
  commitMessage?: string;
}

export interface PushResult {
  success: boolean;
  commitSHA: string | null;
}

export class GitVerificationService {
  /**
   * Verify developer work by checking git commits on branch
   */
  async verifyDeveloperWork(
    workspacePath: string | null,
    repoName: string,
    branchName: string
  ): Promise<GitVerificationResult | null> {
    if (!workspacePath) {
      console.warn(`[GIT_VERIFY] No workspacePath`);
      return null;
    }

    const repoPath = `${workspacePath}/${repoName}`;

    try {
      // Check if branch exists locally, fetch if not
      const checkBranch = safeGitExecSync(`git branch --list "${branchName}"`, { cwd: repoPath });
      if (!checkBranch?.trim()) {
        safeGitExecSync(`git fetch origin ${branchName}:${branchName} 2>/dev/null || true`, { cwd: repoPath });
      }

      // Get commits on branch
      const gitLogResult = safeGitExecSync(
        `git log ${branchName} --oneline -n 5 2>/dev/null || git log origin/${branchName} --oneline -n 5 2>/dev/null || echo ""`,
        { cwd: repoPath }
      );

      if (!gitLogResult?.trim()) {
        return { commitSHA: null, hasCommits: false, commitCount: 0 };
      }

      const commits = gitLogResult.trim().split('\n').filter(Boolean);
      const latestCommitLine = commits[0];
      const shortSHA = latestCommitLine.split(' ')[0];

      const fullSHA = safeGitExecSync(
        `git rev-parse ${shortSHA} 2>/dev/null || git rev-parse origin/${branchName} 2>/dev/null`,
        { cwd: repoPath }
      )?.trim();

      const commitMessage = latestCommitLine.substring(shortSHA.length + 1).trim();

      console.log(`[GIT_VERIFY] ${commits.length} commits on ${branchName}, latest: ${fullSHA?.substring(0, 8)}`);

      return {
        commitSHA: fullSHA || shortSHA,
        hasCommits: true,
        commitCount: commits.length,
        commitMessage
      };
    } catch (error: any) {
      console.error(`[GIT_VERIFY] Error: ${error.message}`);
      return null;
    }
  }

  /**
   * Fetch from remote with exponential backoff retry
   */
  async fetchWithRetry(repoPath: string, maxRetries = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        safeGitExecSync(`git fetch origin --prune`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.FETCH
        });
        return true;
      } catch (err: any) {
        if (attempt < maxRetries) {
          const waitMs = 2000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, waitMs));
        } else {
          console.error(`[GIT] Fetch failed after ${maxRetries} attempts: ${err.message}`);
        }
      }
    }
    return false;
  }

  /**
   * Ensure branch is pushed to remote, sync if needed
   */
  async ensureBranchPushed(
    repoPath: string,
    branchName: string,
    commitSHA: string
  ): Promise<PushResult> {
    const syncLocal = () => {
      try {
        safeGitExecSync(`git pull origin ${branchName} --ff-only`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.CHECKOUT
        });
      } catch (_) { /* Already up to date */ }
    };

    try {
      const branchOnRemote = safeGitExecSync(
        `git ls-remote origin refs/heads/${branchName}`,
        { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
      );

      if (!branchOnRemote?.trim()) {
        console.log(`[GIT] Branch not on remote - pushing...`);
        safeGitExecSync(`git push -u origin ${branchName}`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.PUSH
        });
        syncLocal();
      } else {
        const remoteCommit = branchOnRemote.split('\t')[0];
        if (remoteCommit !== commitSHA) {
          console.log(`[GIT] Remote differs - pushing latest...`);
          safeGitExecSync(`git push origin ${branchName}`, {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.PUSH
          });
          syncLocal();
        }
      }
      return { success: true, commitSHA };
    } catch (pushErr: any) {
      console.warn(`[GIT] Push failed: ${pushErr.message}, trying force push...`);
      try {
        safeGitExecSync(`git push -u origin ${branchName} --force-with-lease`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.PUSH
        });
        syncLocal();
        return { success: true, commitSHA };
      } catch (forceErr: any) {
        console.error(`[GIT] Force push failed: ${forceErr.message}`);
        return { success: false, commitSHA: null };
      }
    }
  }

  /**
   * Verify commit exists on remote
   */
  verifyCommitOnRemote(repoPath: string, commitSHA: string): boolean {
    try {
      const lsRemote = safeGitExecSync(`git ls-remote origin`, {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: GIT_TIMEOUTS.STATUS
      });
      return lsRemote.includes(commitSHA);
    } catch (err: any) {
      console.warn(`[GIT] Verify commit failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Sync workspace to specific branch from remote
   * Returns the current commit SHA after sync
   */
  async syncWorkspaceToRemote(
    repoPath: string,
    branchName: string,
    expectedCommitSHA?: string
  ): Promise<{ success: boolean; currentSHA: string | null }> {
    try {
      smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });

      // Verify branch exists on remote
      const lsRemoteBranches = safeGitExecSync(
        `git ls-remote --heads origin ${branchName}`,
        { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
      );

      if (!lsRemoteBranches?.trim()) {
        throw new Error(`Branch ${branchName} not on remote`);
      }

      // Clean workspace if needed
      const statusCheck = safeGitExecSync(`git status --porcelain`, { cwd: repoPath, encoding: 'utf8' });
      if (statusCheck?.trim()) {
        try {
          safeGitExecSync(`git stash push -u -m "Auto-stash before checkout"`, { cwd: repoPath, encoding: 'utf8' });
        } catch (_) {
          safeGitExecSync(`git reset --hard HEAD`, { cwd: repoPath, encoding: 'utf8' });
          safeGitExecSync(`git clean -fd`, { cwd: repoPath, encoding: 'utf8' });
        }
      }

      // Checkout branch (with retry)
      let checkoutSuccess = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Check if branch exists locally
          let branchExistsLocally = false;
          try {
            safeGitExecSync(`git show-ref --verify --quiet refs/heads/${branchName}`, { cwd: repoPath, encoding: 'utf8' });
            branchExistsLocally = true;
          } catch (_) { /* doesn't exist */ }

          if (branchExistsLocally) {
            safeGitExecSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          } else {
            safeGitExecSync(`git checkout -b ${branchName} origin/${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          }
          checkoutSuccess = true;
          break;
        } catch (_) {
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH, force: true });
          }
        }
      }

      if (!checkoutSuccess) {
        throw new Error(`Failed to checkout ${branchName} after 3 retries`);
      }

      // Reset to remote
      safeGitExecSync(`git reset --hard origin/${branchName}`, { cwd: repoPath, encoding: 'utf8' });
      const currentSHA = safeGitExecSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();

      if (expectedCommitSHA && currentSHA !== expectedCommitSHA) {
        console.warn(`[SYNC] Commit mismatch: expected ${expectedCommitSHA}, got ${currentSHA}`);
      }

      return { success: true, currentSHA };
    } catch (err: any) {
      console.error(`[SYNC] Failed: ${err.message}`);
      return { success: false, currentSHA: null };
    }
  }

  /**
   * Find target repository from list
   */
  findTargetRepo(repositories: any[], targetRepository: string): any | null {
    return repositories.find(r =>
      r.name === targetRepository ||
      r.full_name === targetRepository ||
      r.githubRepoName === targetRepository
    ) || null;
  }

  /**
   * Delete branch (local and remote)
   */
  async deleteBranch(repoPath: string, branchName: string): Promise<void> {
    try {
      safeGitExecSync(`git branch -D ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
      try {
        safeGitExecSync(`git push origin --delete ${branchName}`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.CLONE
        });
      } catch (_) { /* Branch might not exist on remote */ }
    } catch (_) { /* Non-critical */ }
  }
}

// Singleton instance
export const gitVerificationService = new GitVerificationService();
