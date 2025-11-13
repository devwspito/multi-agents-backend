/**
 * Centralized Git Branch Manager
 * Ensures ALL branches are properly created and pushed to remote
 * PREVENTS the "branch not found on remote" error
 */

import { safeGitExecSync } from '../../../utils/safeGitExecution';
import { LogService } from '../../logging/LogService';

export interface BranchInfo {
  name: string;
  type: 'epic' | 'story' | 'integration';
  epicId?: string;
  storyId?: string;
  exists: boolean;
  pushedToRemote: boolean;
}

export class GitBranchManager {
  private branches: Map<string, BranchInfo> = new Map();

  /**
   * Create and push an epic branch to remote
   */
  async createEpicBranch(
    epicId: string,
    repoPath: string,
    baseBranch: string = 'main'
  ): Promise<string> {
    const timestamp = Date.now();
    const suffix = Math.random().toString(36).substring(2, 8);
    const branchName = `epic/${epicId}-${timestamp}-${suffix}`;

    console.log(`[GitBranchManager] Creating epic branch: ${branchName}`);

    try {
      // Ensure we're on base branch
      safeGitExecSync(`git checkout ${baseBranch}`, { cwd: repoPath });
      safeGitExecSync(`git pull origin ${baseBranch}`, { cwd: repoPath });

      // Create branch
      safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath });

      // CRITICAL: Push to remote immediately
      console.log(`[GitBranchManager] Pushing ${branchName} to remote...`);
      safeGitExecSync(`git push -u origin ${branchName}`, { cwd: repoPath });

      // Verify it exists on remote
      const remoteBranches = safeGitExecSync('git ls-remote --heads origin', { cwd: repoPath }).toString();
      const pushedToRemote = remoteBranches.includes(branchName);

      if (!pushedToRemote) {
        throw new Error(`Failed to push ${branchName} to remote`);
      }

      console.log(`[GitBranchManager] ✅ Successfully created and pushed ${branchName}`);

      // Track branch
      this.branches.set(branchName, {
        name: branchName,
        type: 'epic',
        epicId,
        exists: true,
        pushedToRemote: true
      });

      return branchName;

    } catch (error: any) {
      console.error(`[GitBranchManager] ❌ Failed to create epic branch: ${error.message}`);
      throw error;
    }
  }

  /**
   * Create and push a story branch to remote
   */
  async createStoryBranch(
    storyId: string,
    epicBranch: string,
    repoPath: string
  ): Promise<string> {
    const timestamp = Date.now();
    const branchName = `story/${storyId}-${timestamp}`;

    console.log(`[GitBranchManager] Creating story branch: ${branchName} from ${epicBranch}`);

    try {
      // Checkout epic branch
      safeGitExecSync(`git checkout ${epicBranch}`, { cwd: repoPath });

      // Pull latest changes
      try {
        safeGitExecSync(`git pull origin ${epicBranch}`, { cwd: repoPath });
      } catch (e) {
        console.log(`[GitBranchManager] No remote tracking for ${epicBranch} yet`);
      }

      // Create story branch
      safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath });

      // CRITICAL: Push to remote immediately
      console.log(`[GitBranchManager] Pushing ${branchName} to remote...`);
      safeGitExecSync(`git push -u origin ${branchName}`, { cwd: repoPath });

      console.log(`[GitBranchManager] ✅ Successfully created and pushed ${branchName}`);

      // Track branch
      this.branches.set(branchName, {
        name: branchName,
        type: 'story',
        storyId,
        exists: true,
        pushedToRemote: true
      });

      return branchName;

    } catch (error: any) {
      console.error(`[GitBranchManager] ❌ Failed to create story branch: ${error.message}`);
      throw error;
    }
  }

  /**
   * Push changes to remote
   */
  async pushBranch(branchName: string, repoPath: string, force: boolean = false): Promise<boolean> {
    try {
      console.log(`[GitBranchManager] Pushing ${branchName} to remote...`);

      // Checkout branch
      safeGitExecSync(`git checkout ${branchName}`, { cwd: repoPath });

      // Push
      const pushCommand = force
        ? `git push origin ${branchName} --force-with-lease`
        : `git push origin ${branchName}`;

      safeGitExecSync(pushCommand, { cwd: repoPath });

      // Verify
      const remoteBranches = safeGitExecSync('git ls-remote --heads origin', { cwd: repoPath }).toString();
      const exists = remoteBranches.includes(branchName);

      if (exists) {
        console.log(`[GitBranchManager] ✅ Successfully pushed ${branchName}`);
        if (this.branches.has(branchName)) {
          this.branches.get(branchName)!.pushedToRemote = true;
        }
      } else {
        console.error(`[GitBranchManager] ⚠️ Branch ${branchName} not found on remote after push`);
      }

      return exists;

    } catch (error: any) {
      console.error(`[GitBranchManager] ❌ Failed to push ${branchName}: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify all branches exist on remote
   */
  async verifyRemoteBranches(repoPath: string): Promise<{
    success: boolean;
    missing: string[];
  }> {
    try {
      const remoteBranches = safeGitExecSync('git ls-remote --heads origin', { cwd: repoPath }).toString();
      const missing: string[] = [];

      for (const [branchName, info] of this.branches) {
        if (!remoteBranches.includes(branchName)) {
          missing.push(branchName);
          info.pushedToRemote = false;
          console.error(`[GitBranchManager] ❌ Branch ${branchName} NOT found on remote`);
        } else {
          info.pushedToRemote = true;
          console.log(`[GitBranchManager] ✅ Branch ${branchName} exists on remote`);
        }
      }

      return {
        success: missing.length === 0,
        missing
      };

    } catch (error: any) {
      console.error(`[GitBranchManager] Failed to verify branches: ${error.message}`);
      return {
        success: false,
        missing: Array.from(this.branches.keys())
      };
    }
  }

  /**
   * Get all tracked branches
   */
  getBranches(): BranchInfo[] {
    return Array.from(this.branches.values());
  }

  /**
   * Get epic branches only
   */
  getEpicBranches(): string[] {
    return Array.from(this.branches.values())
      .filter(b => b.type === 'epic' && b.pushedToRemote)
      .map(b => b.name);
  }

  /**
   * Cleanup: Delete local and remote branches
   */
  async cleanupBranches(repoPath: string, keepBranches: string[] = []): Promise<void> {
    for (const [branchName, info] of this.branches) {
      if (keepBranches.includes(branchName)) continue;

      try {
        // Delete remote branch
        if (info.pushedToRemote) {
          safeGitExecSync(`git push origin --delete ${branchName}`, { cwd: repoPath });
          console.log(`[GitBranchManager] Deleted remote branch: ${branchName}`);
        }

        // Delete local branch
        safeGitExecSync(`git branch -D ${branchName}`, { cwd: repoPath });
        console.log(`[GitBranchManager] Deleted local branch: ${branchName}`);

        this.branches.delete(branchName);

      } catch (error) {
        console.error(`[GitBranchManager] Failed to cleanup ${branchName}:`, error);
      }
    }
  }

  /**
   * Emergency fix: Push all local branches to remote
   */
  async pushAllMissingBranches(repoPath: string): Promise<number> {
    const { missing } = await this.verifyRemoteBranches(repoPath);
    let pushed = 0;

    for (const branchName of missing) {
      const success = await this.pushBranch(branchName, repoPath, true);
      if (success) pushed++;
    }

    console.log(`[GitBranchManager] Emergency push complete: ${pushed}/${missing.length} branches pushed`);
    return pushed;
  }
}