/**
 * Reliable GitHub Service
 *
 * GARANTIZA que las branches se crean en GitHub
 * Con verificación, retry logic, y logging completo
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import RealTimeLogger from './RealTimeLogger';
import { NotificationService } from './NotificationService';

const execAsync = promisify(exec);

interface BranchCreationResult {
  success: boolean;
  branch: string;
  url: string;
  error?: string;
  retries?: number;
}

interface PushResult {
  success: boolean;
  branch: string;
  message?: string;
  error?: string;
}

class ReliableGitHubService {
  private maxRetries = 3;
  private retryDelay = 2000; // 2 seconds

  /**
   * Create a branch and GUARANTEE it exists on GitHub
   */
  async createAndPushBranch(
    branchName: string,
    repoPath: string,
    taskId: string,
    agentName: string = 'GitHub Service'
  ): Promise<BranchCreationResult> {
    console.log(`\n🌿 [GitHub] Creating branch: ${branchName}`);

    let retries = 0;
    let lastError: string = '';

    while (retries < this.maxRetries) {
      try {
        // Step 1: Ensure we're on a clean state
        await this.ensureCleanState(repoPath);

        // Step 2: Fetch latest from remote
        console.log(`  📥 Fetching latest from remote...`);
        await execAsync('git fetch origin', { cwd: repoPath });

        // Step 3: Get the default branch (main or master)
        const defaultBranch = await this.getDefaultBranch(repoPath);
        console.log(`  🎯 Default branch: ${defaultBranch}`);

        // Step 4: Checkout default branch
        await execAsync(`git checkout ${defaultBranch}`, { cwd: repoPath });
        await execAsync(`git pull origin ${defaultBranch}`, { cwd: repoPath });

        // Step 5: Check if branch already exists (local or remote)
        const exists = await this.branchExists(branchName, repoPath);
        if (exists.local || exists.remote) {
          console.log(`  ✅ Branch ${branchName} already exists (local: ${exists.local}, remote: ${exists.remote})`);

          if (exists.remote) {
            const url = await this.getBranchUrl(branchName, repoPath);

            NotificationService.emitAgentMessage(
              taskId,
              agentName,
              `✅ Branch already exists: ${branchName}
🔗 View on GitHub: ${url}`
            );

            return {
              success: true,
              branch: branchName,
              url,
            };
          }
        }

        // Step 6: Create the branch locally
        console.log(`  🔨 Creating branch locally...`);
        await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });

        // Step 7: Make an initial commit (optional but helps with empty branches)
        try {
          const readmePath = path.join(repoPath, '.branch-info.md');
          const content = `# Branch: ${branchName}\n\nCreated: ${new Date().toISOString()}\nPurpose: Development branch for automated tasks\n`;
          await execAsync(`echo "${content}" > "${readmePath}"`, { cwd: repoPath });
          await execAsync(`git add .branch-info.md`, { cwd: repoPath });
          await execAsync(`git commit -m "Initial branch setup for ${branchName}"`, { cwd: repoPath });
        } catch (e) {
          // Ignore if commit fails (might already have commits)
        }

        // Step 8: Push the branch to remote with upstream
        console.log(`  📤 Pushing branch to GitHub...`);
        const pushResult = await this.pushBranchWithVerification(branchName, repoPath, taskId, agentName);

        if (!pushResult.success) {
          throw new Error(pushResult.error || 'Push failed');
        }

        // Step 9: Verify the branch exists on remote
        console.log(`  🔍 Verifying branch exists on GitHub...`);
        const verified = await this.verifyRemoteBranch(branchName, repoPath);

        if (!verified) {
          throw new Error('Branch push succeeded but verification failed');
        }

        // Step 10: Get the GitHub URL
        const url = await this.getBranchUrl(branchName, repoPath);

        console.log(`  ✅ Branch created successfully: ${url}`);

        // Log success
        RealTimeLogger.logGitOperation(
          taskId,
          agentName,
          `git push -u origin ${branchName}`,
          `Branch created: ${url}`
        );

        NotificationService.emitAgentMessage(
          taskId,
          agentName,
          `✅ **Branch created on GitHub:**
🌿 Branch: ${branchName}
🔗 View: ${url}
📝 Status: Ready for development`
        );

        return {
          success: true,
          branch: branchName,
          url,
        };

      } catch (error: any) {
        retries++;
        lastError = error.message;

        console.error(`  ❌ Attempt ${retries}/${this.maxRetries} failed: ${lastError}`);

        RealTimeLogger.logError(
          taskId,
          agentName,
          `Branch creation failed (attempt ${retries}): ${lastError}`
        );

        if (retries < this.maxRetries) {
          console.log(`  ⏳ Waiting ${this.retryDelay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));

          // Clean up for retry
          try {
            await execAsync(`git checkout ${await this.getDefaultBranch(repoPath)}`, { cwd: repoPath });
            await execAsync(`git branch -D ${branchName}`, { cwd: repoPath }).catch(() => {});
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      }
    }

    // All retries failed
    const errorMsg = `Failed to create branch ${branchName} after ${this.maxRetries} attempts: ${lastError}`;

    RealTimeLogger.logError(taskId, agentName, errorMsg);

    NotificationService.emitAgentMessage(
      taskId,
      agentName,
      `❌ **Failed to create branch:**
Branch: ${branchName}
Error: ${lastError}
Attempts: ${this.maxRetries}`
    );

    return {
      success: false,
      branch: branchName,
      url: '',
      error: errorMsg,
      retries: this.maxRetries,
    };
  }

  /**
   * Push a branch with verification
   */
  private async pushBranchWithVerification(
    branchName: string,
    repoPath: string,
    taskId: string,
    agentName: string
  ): Promise<PushResult> {
    try {
      // Try regular push first
      const result = await execAsync(
        `git push -u origin ${branchName}`,
        { cwd: repoPath }
      );

      console.log(`    ✅ Push successful`);

      return {
        success: true,
        branch: branchName,
        message: result.stdout,
      };
    } catch (error: any) {
      // Check if it's an authentication error
      if (error.message.includes('Authentication failed') ||
          error.message.includes('Permission denied')) {

        console.error(`    ❌ Authentication error`);

        // Try to use GitHub token if available
        if (process.env.GITHUB_TOKEN) {
          try {
            const remoteUrl = await this.getRemoteUrl(repoPath);
            const urlWithToken = this.addTokenToUrl(remoteUrl, process.env.GITHUB_TOKEN);

            // Temporarily set remote with token
            await execAsync(`git remote set-url origin ${urlWithToken}`, { cwd: repoPath });

            // Try push again
            await execAsync(
              `git push -u origin ${branchName}`,
              { cwd: repoPath }
            );

            // Reset remote to original (without token in URL)
            await execAsync(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });

            console.log(`    ✅ Push successful with token`);

            return {
              success: true,
              branch: branchName,
              message: 'Pushed with authentication',
            };
          } catch (tokenError: any) {
            return {
              success: false,
              branch: branchName,
              error: `Authentication failed: ${tokenError.message}`,
            };
          }
        }
      }

      // Check if it's a force push situation
      if (error.message.includes('rejected') ||
          error.message.includes('non-fast-forward')) {

        console.log(`    ⚠️ Push rejected, trying force push...`);

        try {
          await execAsync(
            `git push -u origin ${branchName} --force-with-lease`,
            { cwd: repoPath }
          );

          console.log(`    ✅ Force push successful`);

          return {
            success: true,
            branch: branchName,
            message: 'Force pushed',
          };
        } catch (forceError: any) {
          return {
            success: false,
            branch: branchName,
            error: `Force push failed: ${forceError.message}`,
          };
        }
      }

      return {
        success: false,
        branch: branchName,
        error: error.message,
      };
    }
  }

  /**
   * Verify a branch exists on remote
   */
  private async verifyRemoteBranch(branchName: string, repoPath: string): Promise<boolean> {
    try {
      // Fetch latest remote refs
      await execAsync('git fetch origin', { cwd: repoPath });

      // Check if branch exists in remote refs
      const { stdout } = await execAsync('git branch -r', { cwd: repoPath });
      const remoteBranches = stdout.split('\n').map(b => b.trim());

      const exists = remoteBranches.some(b =>
        b === `origin/${branchName}` ||
        b.endsWith(`/${branchName}`)
      );

      console.log(`    ${exists ? '✅' : '❌'} Verification: Branch ${exists ? 'exists' : 'NOT FOUND'} on remote`);

      return exists;
    } catch (error) {
      console.error(`    ❌ Verification failed:`, error);
      return false;
    }
  }

  /**
   * Check if branch exists locally or remotely
   */
  private async branchExists(
    branchName: string,
    repoPath: string
  ): Promise<{ local: boolean; remote: boolean }> {
    let local = false;
    let remote = false;

    try {
      // Check local branches
      const { stdout: localBranches } = await execAsync('git branch', { cwd: repoPath });
      local = localBranches.split('\n').some(b => b.trim() === branchName || b.trim() === `* ${branchName}`);
    } catch (e) {
      // Ignore
    }

    try {
      // Check remote branches
      const { stdout: remoteBranches } = await execAsync('git branch -r', { cwd: repoPath });
      remote = remoteBranches.split('\n').some(b => b.trim() === `origin/${branchName}` || b.includes(`/${branchName}`));
    } catch (e) {
      // Ignore
    }

    return { local, remote };
  }

  /**
   * Get the default branch (main or master)
   */
  private async getDefaultBranch(repoPath: string): Promise<string> {
    try {
      // Try to get the default branch from remote
      const { stdout } = await execAsync(
        'git symbolic-ref refs/remotes/origin/HEAD',
        { cwd: repoPath }
      );
      const branch = stdout.trim().replace('refs/remotes/origin/', '');
      return branch;
    } catch (error) {
      // Fallback: check if main exists
      try {
        await execAsync('git rev-parse --verify main', { cwd: repoPath });
        return 'main';
      } catch (e) {
        // Fallback to master
        return 'master';
      }
    }
  }

  /**
   * Ensure repository is in a clean state
   */
  private async ensureCleanState(repoPath: string): Promise<void> {
    try {
      // Check for uncommitted changes
      const { stdout } = await execAsync('git status --porcelain', { cwd: repoPath });

      if (stdout.trim()) {
        console.log(`  ⚠️ Uncommitted changes detected, stashing...`);
        await execAsync('git stash', { cwd: repoPath });
      }
    } catch (error) {
      console.warn(`  ⚠️ Could not check git status:`, error);
    }
  }

  /**
   * Get GitHub URL for a branch
   */
  private async getBranchUrl(branchName: string, repoPath: string): Promise<string> {
    try {
      const remoteUrl = await this.getRemoteUrl(repoPath);

      // Convert SSH URL to HTTPS if needed
      let httpUrl = remoteUrl;
      if (remoteUrl.startsWith('git@')) {
        httpUrl = remoteUrl
          .replace('git@', 'https://')
          .replace('.com:', '.com/')
          .replace('.git', '');
      } else if (!remoteUrl.startsWith('http')) {
        httpUrl = `https://github.com/${remoteUrl}`;
      }

      // Remove .git suffix if present
      httpUrl = httpUrl.replace(/\.git$/, '');

      return `${httpUrl}/tree/${branchName}`;
    } catch (error) {
      return `https://github.com/[repo]/tree/${branchName}`;
    }
  }

  /**
   * Get remote URL
   */
  private async getRemoteUrl(repoPath: string): Promise<string> {
    const { stdout } = await execAsync('git remote get-url origin', { cwd: repoPath });
    return stdout.trim();
  }

  /**
   * Add token to GitHub URL for authentication
   */
  private addTokenToUrl(url: string, token: string): string {
    if (url.startsWith('https://')) {
      return url.replace('https://', `https://${token}@`);
    } else if (url.startsWith('git@')) {
      // Convert SSH to HTTPS with token
      const httpsUrl = url
        .replace('git@', 'https://')
        .replace('.com:', '.com/')
        .replace('.git', '');
      return httpsUrl.replace('https://', `https://${token}@`);
    }
    return url;
  }

  /**
   * Commit and push changes
   */
  async commitAndPush(
    repoPath: string,
    branchName: string,
    message: string,
    taskId: string,
    agentName: string
  ): Promise<boolean> {
    try {
      console.log(`\n💾 [GitHub] Committing changes...`);

      // Add all changes
      await execAsync('git add -A', { cwd: repoPath });

      // Commit
      await execAsync(`git commit -m "${message}"`, { cwd: repoPath });

      // Push
      const pushResult = await this.pushBranchWithVerification(
        branchName,
        repoPath,
        taskId,
        agentName
      );

      if (pushResult.success) {
        const url = await this.getBranchUrl(branchName, repoPath);

        NotificationService.emitAgentMessage(
          taskId,
          agentName,
          `✅ **Changes pushed to GitHub:**
💾 Commit: ${message.substring(0, 50)}
🌿 Branch: ${branchName}
🔗 View: ${url}`
        );

        return true;
      }

      return false;
    } catch (error: any) {
      console.error(`❌ Commit/push failed:`, error.message);

      if (error.message.includes('nothing to commit')) {
        NotificationService.emitAgentMessage(
          taskId,
          agentName,
          `ℹ️ No changes to commit`
        );
        return true; // Not an error
      }

      RealTimeLogger.logError(taskId, agentName, `Commit/push failed: ${error.message}`);
      return false;
    }
  }
}

export default new ReliableGitHubService();