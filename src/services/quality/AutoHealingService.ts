import { exec } from 'child_process';
import { promisify } from 'util';
import { IEpic, IStory } from '../../models/Task';
import { GitHubService } from '../GitHubService';

const execAsync = promisify(exec);

/**
 * Healing Result
 */
export interface IHealingResult {
  success: boolean;
  action: 'changes_committed' | 'branch_synced' | 'already_merged' | 'no_fix_found';
  details: string;
}

/**
 * Healing Context - data needed for healing
 */
export interface IHealingContext {
  repoPath: string;
  branchName: string;
  userId: string;
  epic: IEpic;
  story: IStory;
  repository?: any;
}

/**
 * Healing Strategy Interface
 *
 * Each strategy handles a specific type of PR creation failure
 */
export interface IHealingStrategy {
  name: string;
  canHandle(context: IHealingContext): Promise<boolean>;
  heal(context: IHealingContext, githubService: GitHubService): Promise<IHealingResult>;
}

/**
 * Strategy 1: Uncommitted Changes
 *
 * Detects and commits uncommitted changes that prevent PR creation
 */
export class UncommittedChangesStrategy implements IHealingStrategy {
  name = 'uncommitted-changes';

  async canHandle(context: IHealingContext): Promise<boolean> {
    try {
      const { stdout } = await execAsync('git status --porcelain', {
        cwd: context.repoPath,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async heal(context: IHealingContext, githubService: GitHubService): Promise<IHealingResult> {
    console.log(`    📝 [Auto-Healing] Found uncommitted changes, committing...`);

    try {
      await execAsync('git add .', { cwd: context.repoPath });
      const commitMessage = `Auto-commit by system: ${context.epic.name} - ${context.story.title}`;
      await execAsync(`git commit -m "${commitMessage}"`, { cwd: context.repoPath });

      await githubService.pushBranch(context.branchName, context.repoPath, context.userId);

      console.log(`    ✅ [Auto-Healing] Changes committed and pushed`);
      return {
        success: true,
        action: 'changes_committed',
        details: 'Uncommitted changes were found, committed and pushed',
      };
    } catch (error: any) {
      return {
        success: false,
        action: 'no_fix_found',
        details: `Failed to commit changes: ${error.message}`,
      };
    }
  }
}

/**
 * Strategy 2: Branch Behind Main
 *
 * Syncs branch with main when it's behind
 */
export class BranchBehindMainStrategy implements IHealingStrategy {
  name = 'branch-behind-main';

  async canHandle(context: IHealingContext): Promise<boolean> {
    try {
      await execAsync('git fetch origin', { cwd: context.repoPath });

      const { stdout } = await execAsync(
        `git rev-list --left-right --count origin/main...${context.branchName}`,
        { cwd: context.repoPath }
      ).catch(() => ({ stdout: '0\t0' }));

      const [behind] = stdout.trim().split('\t').map(Number);
      return behind > 0;
    } catch {
      return false;
    }
  }

  async heal(context: IHealingContext, githubService: GitHubService): Promise<IHealingResult> {
    try {
      await execAsync('git fetch origin', { cwd: context.repoPath });

      const { stdout: behindOutput } = await execAsync(
        `git rev-list --left-right --count origin/main...${context.branchName}`,
        { cwd: context.repoPath }
      ).catch(() => ({ stdout: '0\t0' }));

      const [behind, ahead] = behindOutput.trim().split('\t').map(Number);

      // Check if already merged (no unique commits)
      if (behind > 0 && ahead === 0) {
        console.log(`    ⚠️ [Auto-Healing] Branch is ${behind} commits behind main with no unique commits`);
        return {
          success: true,
          action: 'already_merged',
          details: `Branch has no unique commits. Changes may already be in main.`,
        };
      }

      console.log(`    🔄 [Auto-Healing] Branch is ${behind} commits behind, rebasing with main...`);

      // Try rebase first
      try {
        await execAsync(`git rebase origin/main`, { cwd: context.repoPath });
        await githubService.pushBranch(context.branchName, context.repoPath, context.userId);

        console.log(`    ✅ [Auto-Healing] Branch rebased with main and pushed`);
        return {
          success: true,
          action: 'branch_synced',
          details: 'Branch was behind main, rebased successfully',
        };
      } catch (rebaseError: any) {
        // Rebase failed, try merge
        await execAsync('git rebase --abort', { cwd: context.repoPath }).catch(() => {});

        console.log(`    ⚠️ [Auto-Healing] Rebase failed (conflicts), trying merge instead...`);

        try {
          await execAsync(
            `git merge origin/main -m "Auto-merge main into ${context.branchName}"`,
            { cwd: context.repoPath }
          );
          await githubService.pushBranch(context.branchName, context.repoPath, context.userId);

          console.log(`    ✅ [Auto-Healing] Branch merged with main and pushed`);
          return {
            success: true,
            action: 'branch_synced',
            details: 'Branch merged with main (rebase had conflicts)',
          };
        } catch (mergeError: any) {
          console.error(`    ❌ [Auto-Healing] Both rebase and merge failed:`, mergeError.message);
          return {
            success: false,
            action: 'no_fix_found',
            details: `Could not sync with main: ${mergeError.message}`,
          };
        }
      }
    } catch (error: any) {
      return {
        success: false,
        action: 'no_fix_found',
        details: `Error syncing with main: ${error.message}`,
      };
    }
  }
}

/**
 * Strategy 3: Already Merged
 *
 * Detects if changes are already in main
 */
export class AlreadyMergedStrategy implements IHealingStrategy {
  name = 'already-merged';

  async canHandle(context: IHealingContext): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `git diff origin/main...${context.branchName} --stat`,
        { cwd: context.repoPath }
      );
      return stdout.trim().length === 0;
    } catch {
      return false;
    }
  }

  async heal(_context: IHealingContext, _githubService: GitHubService): Promise<IHealingResult> {
    console.log(`    ℹ️ [Auto-Healing] No differences found between branch and main`);
    return {
      success: true,
      action: 'already_merged',
      details: 'No differences between branch and main - changes already merged or empty branch',
    };
  }
}

/**
 * Strategy 4: Remote Out of Sync
 *
 * Forces push when remote is out of sync
 */
export class RemoteOutOfSyncStrategy implements IHealingStrategy {
  name = 'remote-out-of-sync';

  async canHandle(_context: IHealingContext): Promise<boolean> {
    // This is always last resort, so always can handle
    return true;
  }

  async heal(context: IHealingContext, githubService: GitHubService): Promise<IHealingResult> {
    console.log(`    🔍 [Auto-Healing] Trying force-push to sync remote...`);

    try {
      await githubService.pushBranch(context.branchName, context.repoPath, context.userId);
      console.log(`    ✅ [Auto-Healing] Force-push successful`);
      return {
        success: true,
        action: 'branch_synced',
        details: 'Remote branch was out of sync, force-pushed successfully',
      };
    } catch (pushError: any) {
      console.error(`    ❌ [Auto-Healing] Force-push failed:`, pushError.message);
      return {
        success: false,
        action: 'no_fix_found',
        details: `Could not force-push: ${pushError.message}`,
      };
    }
  }
}

/**
 * Auto-Healing Service
 *
 * Implements Strategy Pattern for PR creation failure recovery
 *
 * Strategies are executed in order:
 * 1. UncommittedChangesStrategy - Commit pending changes
 * 2. BranchBehindMainStrategy - Sync with main
 * 3. AlreadyMergedStrategy - Detect if already merged
 * 4. RemoteOutOfSyncStrategy - Force push (last resort)
 */
export class AutoHealingService {
  private strategies: IHealingStrategy[] = [
    new UncommittedChangesStrategy(),
    new BranchBehindMainStrategy(),
    new AlreadyMergedStrategy(),
    new RemoteOutOfSyncStrategy(),
  ];

  constructor(private githubService: GitHubService) {}

  /**
   * Attempt to heal PR creation failure
   *
   * Executes strategies in sequence until one succeeds
   */
  async healPRCreationFailure(context: IHealingContext): Promise<IHealingResult> {
    console.log(`🔧 [Auto-Healing] Starting diagnostic for ${context.branchName}...`);

    try {
      // Try each strategy in order
      for (const strategy of this.strategies) {
        console.log(`  🔍 [Auto-Healing] Trying strategy: ${strategy.name}`);

        const canHandle = await strategy.canHandle(context);

        if (canHandle) {
          console.log(`  ✅ [Auto-Healing] Strategy ${strategy.name} can handle this issue`);
          const result = await strategy.heal(context, this.githubService);

          if (result.success) {
            console.log(`  ✅ [Auto-Healing] Successfully healed with ${strategy.name}`);
            return result;
          } else {
            console.log(`  ⚠️ [Auto-Healing] Strategy ${strategy.name} failed: ${result.details}`);
            // Continue to next strategy
          }
        } else {
          console.log(`  ⏭️ [Auto-Healing] Strategy ${strategy.name} cannot handle this issue`);
        }
      }

      // All strategies failed
      return {
        success: false,
        action: 'no_fix_found',
        details: 'All healing strategies failed',
      };
    } catch (error: any) {
      console.error(`❌ [Auto-Healing] Unexpected error:`, error.message);
      return {
        success: false,
        action: 'no_fix_found',
        details: `Auto-healing error: ${error.message}`,
      };
    }
  }
}
