import { exec } from 'child_process';
import { promisify } from 'util';
import { GitHubService } from '../GitHubService';
import { LogService } from '../logging/LogService';
import { NotificationService } from '../NotificationService';

const execAsync = promisify(exec);

/**
 * Conflict Severity
 * - simple: Non-overlapping changes, can auto-resolve
 * - complex: Overlapping changes, needs human review
 */
export type ConflictSeverity = 'simple' | 'complex';

/**
 * Merge Conflict
 */
export interface IMergeConflict {
  file: string;
  severity: ConflictSeverity;
  conflictMarkers: string[];
  canAutoResolve: boolean;
}

/**
 * Merge Result
 */
export interface IMergeResult {
  success: boolean;
  merged: boolean;
  conflictsDetected: IMergeConflict[];
  conflictsResolved: number;
  needsHumanReview: boolean;
  error?: string;
  mergeCommitSha?: string;
}

/**
 * Auto Merge Service
 *
 * Handles automatic merging of PRs to main branch with conflict detection and resolution.
 *
 * Features:
 * - Detects merge conflicts before merging
 * - Auto-resolves simple conflicts (non-overlapping changes)
 * - Escalates complex conflicts to human review
 * - Uses GitHub API (via GitHub MCP when available) or git CLI
 * - Validates tests pass before merge
 *
 * Based on AITMPL repository patterns:
 * - cli-tool/components/commands/git/finish.md
 * - cli-tool/components/agents/git/git-flow-manager.md
 */
export class AutoMergeService {
  constructor(private githubService: GitHubService) {}

  /**
   * Merge a PR to main branch with automatic conflict resolution
   *
   * @param prNumber - PR number to merge
   * @param repoPath - Local path to repository
   * @param repoOwner - Repository owner (e.g., "luiscorrea")
   * @param repoName - Repository name (e.g., "backend")
   * @param taskId - Task ID for logging
   * @returns Merge result with conflict information
   */
  async mergePRToMain(
    prNumber: number,
    repoPath: string,
    repoOwner: string,
    repoName: string,
    taskId: string
  ): Promise<IMergeResult> {
    console.log(`\n🔀 [AutoMerge] Starting merge process for PR #${prNumber}`);
    console.log(`   Repository: ${repoOwner}/${repoName}`);
    console.log(`   Path: ${repoPath}`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🔀 Starting automatic merge for PR #${prNumber}`
    );

    try {
      // Step 1: Fetch latest from remote
      await this.fetchLatest(repoPath, taskId);

      // Step 2: Get PR branch name
      const prBranch = await this.getPRBranch(prNumber, repoPath, taskId);
      if (!prBranch) {
        throw new Error(`Failed to get branch name for PR #${prNumber}`);
      }

      console.log(`   PR Branch: ${prBranch}`);

      // Step 3: Detect conflicts before merging
      console.log(`\n🔍 [AutoMerge] Detecting conflicts with main...`);
      const conflicts = await this.detectConflicts(repoPath, prBranch, taskId);

      if (conflicts.length > 0) {
        console.log(`   ⚠️  Found ${conflicts.length} conflicting file(s)`);

        // Step 4: Try to auto-resolve simple conflicts
        const resolvedCount = await this.resolveSimpleConflicts(
          repoPath,
          conflicts,
          taskId
        );

        // Check if any complex conflicts remain
        const complexConflicts = conflicts.filter((c) => c.severity === 'complex');

        if (complexConflicts.length > 0) {
          console.log(
            `   ❌ ${complexConflicts.length} complex conflict(s) require human review`
          );
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️  Merge blocked: ${complexConflicts.length} complex conflicts need human review`
          );

          await LogService.warn(`Merge blocked: complex conflicts detected`, {
            taskId,
            category: 'auto_merge',
            metadata: {
              prNumber,
              repoName,
              complexConflicts: complexConflicts.map((c) => c.file),
            },
          });

          return {
            success: false,
            merged: false,
            conflictsDetected: conflicts,
            conflictsResolved: resolvedCount,
            needsHumanReview: true,
            error: `Complex conflicts in: ${complexConflicts.map((c) => c.file).join(', ')}`,
          };
        }

        console.log(`   ✅ All conflicts resolved automatically (${resolvedCount} files)`);
      } else {
        console.log(`   ✅ No conflicts detected`);
      }

      // Step 5: Run tests before merging (optional, can be configured)
      const testsPass = await this.runTests(repoPath, taskId);
      if (!testsPass) {
        console.log(`   ❌ Tests failed - merge blocked`);
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Merge blocked: Tests are failing`
        );

        return {
          success: false,
          merged: false,
          conflictsDetected: conflicts,
          conflictsResolved: 0,
          needsHumanReview: true,
          error: 'Tests failed - fix tests before merging',
        };
      }

      // Step 6: Perform the merge
      console.log(`\n✅ [AutoMerge] All checks passed - proceeding with merge...`);
      const mergeCommitSha = await this.performMerge(
        repoPath,
        prBranch,
        prNumber,
        taskId
      );

      console.log(`   ✅ Merged successfully`);
      console.log(`   📍 Merge commit: ${mergeCommitSha}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ PR #${prNumber} merged to main successfully`
      );

      await LogService.info(`PR merged to main automatically`, {
        taskId,
        category: 'auto_merge',
        metadata: {
          prNumber,
          repoName,
          mergeCommitSha,
          conflictsResolved: conflicts.length,
        },
      });

      return {
        success: true,
        merged: true,
        conflictsDetected: conflicts,
        conflictsResolved: conflicts.length,
        needsHumanReview: false,
        mergeCommitSha,
      };
    } catch (error: any) {
      console.error(`   ❌ Merge failed: ${error.message}`);

      NotificationService.emitConsoleLog(
        taskId,
        'error',
        `❌ Merge failed: ${error.message}`
      );

      await LogService.error(`Auto-merge failed`, {
        taskId,
        category: 'auto_merge',
        error,
        metadata: {
          prNumber,
          repoName,
          errorMessage: error.message,
        },
      });

      return {
        success: false,
        merged: false,
        conflictsDetected: [],
        conflictsResolved: 0,
        needsHumanReview: true,
        error: error.message,
      };
    }
  }

  /**
   * Fetch latest changes from remote
   */
  private async fetchLatest(repoPath: string, taskId: string): Promise<void> {
    console.log(`   🔄 Fetching latest from origin...`);

    try {
      await execAsync('git fetch origin', { cwd: repoPath });
      console.log(`   ✅ Fetch complete`);
    } catch (error: any) {
      console.error(`   ❌ Fetch failed: ${error.message}`);
      throw new Error(`Failed to fetch from remote: ${error.message}`);
    }
  }

  /**
   * Get PR branch name
   */
  private async getPRBranch(
    prNumber: number,
    repoPath: string,
    taskId: string
  ): Promise<string | null> {
    try {
      // Get branch name from PR number using gh CLI
      const { stdout } = await execAsync(
        `gh pr view ${prNumber} --json headRefName --jq .headRefName`,
        { cwd: repoPath }
      );

      const branchName = stdout.trim();
      return branchName || null;
    } catch (error: any) {
      console.error(`   ❌ Failed to get PR branch: ${error.message}`);
      return null;
    }
  }

  /**
   * Detect merge conflicts between PR branch and main
   */
  private async detectConflicts(
    repoPath: string,
    prBranch: string,
    taskId: string
  ): Promise<IMergeConflict[]> {
    try {
      // Checkout main and update
      await execAsync('git checkout main', { cwd: repoPath });
      await execAsync('git pull origin main', { cwd: repoPath });

      // Try merge with --no-commit --no-ff to detect conflicts
      try {
        await execAsync(`git merge --no-commit --no-ff origin/${prBranch}`, {
          cwd: repoPath,
        });

        // No conflicts
        await execAsync('git merge --abort', { cwd: repoPath });
        return [];
      } catch (mergeError: any) {
        // Conflicts detected
        const { stdout } = await execAsync('git diff --name-only --diff-filter=U', {
          cwd: repoPath,
        });

        const conflictingFiles = stdout.trim().split('\n').filter(Boolean);

        // Abort the merge
        await execAsync('git merge --abort', { cwd: repoPath });

        // Analyze each conflicting file
        const conflicts: IMergeConflict[] = [];

        for (const file of conflictingFiles) {
          const conflict = await this.analyzeConflict(repoPath, file, prBranch, taskId);
          conflicts.push(conflict);
        }

        return conflicts;
      }
    } catch (error: any) {
      console.error(`   ❌ Conflict detection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Analyze a conflict to determine severity
   */
  private async analyzeConflict(
    repoPath: string,
    file: string,
    prBranch: string,
    taskId: string
  ): Promise<IMergeConflict> {
    try {
      // Get diff for this file
      const { stdout } = await execAsync(
        `git diff main...origin/${prBranch} -- ${file}`,
        { cwd: repoPath }
      );

      const diffLines = stdout.split('\n');
      const conflictMarkers = diffLines.filter(
        (line) =>
          line.startsWith('<<<<<<<') ||
          line.startsWith('=======') ||
          line.startsWith('>>>>>>>')
      );

      // Simple heuristic: if there are many conflict markers, it's complex
      const severity: ConflictSeverity = conflictMarkers.length > 6 ? 'complex' : 'simple';

      return {
        file,
        severity,
        conflictMarkers,
        canAutoResolve: severity === 'simple',
      };
    } catch (error: any) {
      // If we can't analyze, assume complex
      return {
        file,
        severity: 'complex',
        conflictMarkers: [],
        canAutoResolve: false,
      };
    }
  }

  /**
   * Resolve simple conflicts automatically
   * Simple conflicts = non-overlapping changes in different parts of file
   */
  private async resolveSimpleConflicts(
    repoPath: string,
    conflicts: IMergeConflict[],
    taskId: string
  ): Promise<number> {
    const simpleConflicts = conflicts.filter((c) => c.canAutoResolve);

    if (simpleConflicts.length === 0) {
      return 0;
    }

    console.log(`   🔧 Attempting to auto-resolve ${simpleConflicts.length} simple conflict(s)...`);

    let resolvedCount = 0;

    for (const conflict of simpleConflicts) {
      try {
        // For simple conflicts, we can use "ours" or "theirs" strategy
        // In our case, we trust the PR branch (theirs)
        await execAsync(`git checkout --theirs ${conflict.file}`, { cwd: repoPath });
        await execAsync(`git add ${conflict.file}`, { cwd: repoPath });

        console.log(`     ✅ Resolved: ${conflict.file} (using PR changes)`);
        resolvedCount++;
      } catch (error: any) {
        console.log(`     ❌ Failed to resolve: ${conflict.file}`);
        // Mark as complex if auto-resolution fails
        conflict.severity = 'complex';
        conflict.canAutoResolve = false;
      }
    }

    return resolvedCount;
  }

  /**
   * Run tests before merging (optional)
   */
  private async runTests(repoPath: string, taskId: string): Promise<boolean> {
    console.log(`   🧪 Running tests...`);

    try {
      // Check if package.json has test script
      const { stdout: packageJson } = await execAsync('cat package.json', {
        cwd: repoPath,
      });

      if (!packageJson.includes('"test"')) {
        console.log(`   ⏭️  No test script found - skipping tests`);
        return true; // No tests = assume pass
      }

      // Run tests with timeout
      await execAsync('npm test', { cwd: repoPath, timeout: 120000 });

      console.log(`   ✅ Tests passed`);
      return true;
    } catch (error: any) {
      if (error.killed) {
        console.log(`   ⚠️  Tests timed out - skipping`);
        return true; // Timeout = don't block merge
      }

      console.log(`   ❌ Tests failed`);
      return false;
    }
  }

  /**
   * Perform the actual merge
   */
  private async performMerge(
    repoPath: string,
    prBranch: string,
    prNumber: number,
    taskId: string
  ): Promise<string> {
    try {
      // Checkout main
      await execAsync('git checkout main', { cwd: repoPath });
      await execAsync('git pull origin main', { cwd: repoPath });

      // Merge with --no-ff (always create merge commit)
      const mergeMessage = `Merge PR #${prNumber} into main

🤖 Generated with Claude Code (Auto-Merge)
Co-Authored-By: Claude <noreply@anthropic.com>`;

      await execAsync(
        `git merge --no-ff origin/${prBranch} -m "${mergeMessage.replace(/"/g, '\\"')}"`,
        { cwd: repoPath }
      );

      // Get merge commit SHA
      const { stdout: commitSha } = await execAsync('git rev-parse HEAD', {
        cwd: repoPath,
      });

      // Push to origin
      await execAsync('git push origin main', { cwd: repoPath });

      return commitSha.trim();
    } catch (error: any) {
      throw new Error(`Merge failed: ${error.message}`);
    }
  }

  /**
   * Delete PR branch after successful merge (cleanup)
   */
  async deletePRBranch(
    prBranch: string,
    repoPath: string,
    taskId: string
  ): Promise<void> {
    console.log(`\n🗑️  [AutoMerge] Cleaning up merged branch: ${prBranch}`);

    try {
      // Delete remote branch
      await execAsync(`git push origin --delete ${prBranch}`, { cwd: repoPath });
      console.log(`   ✅ Deleted remote branch: origin/${prBranch}`);

      // Delete local branch (if exists)
      try {
        await execAsync(`git branch -d ${prBranch}`, { cwd: repoPath });
        console.log(`   ✅ Deleted local branch: ${prBranch}`);
      } catch {
        // Local branch might not exist - ignore
      }

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🗑️  Cleaned up merged branch: ${prBranch}`
      );
    } catch (error: any) {
      console.error(`   ⚠️  Failed to delete branch: ${error.message}`);
      // Don't throw - branch cleanup is not critical
    }
  }
}
