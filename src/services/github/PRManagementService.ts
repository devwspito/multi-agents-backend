import { exec } from 'child_process';
import { promisify } from 'util';
import { ITask, IEpic } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { GitHubService } from '../GitHubService';
import { AutoHealingService, IHealingContext } from '../quality/AutoHealingService';
import { NotificationService } from '../NotificationService';

const execAsync = promisify(exec);

/**
 * PR Creation Result
 */
export interface IPRCreationResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
  action?: 'created' | 'found_existing' | 'healed' | 'skipped';
}

/**
 * PR Management Service
 *
 * Handles all Pull Request creation and management logic
 * - Creates PRs after all developers complete
 * - Validates changes exist
 * - Handles PR creation failures with auto-healing
 * - Searches for existing PRs
 */
export class PRManagementService {
  private autoHealingService: AutoHealingService;

  constructor(private githubService: GitHubService) {
    this.autoHealingService = new AutoHealingService(githubService);
  }

  /**
   * Create PRs for all completed epics (Multi-Repo Support)
   *
   * This should be called AFTER QA completes
   * Follows: 1 Epic = 1 Team = 1 Branch = 1 PR
   * Each epic creates PR in its targetRepository
   */
  async createEpicPRs(
    task: ITask,
    repositories: any[],
    workspacePath: string | null
  ): Promise<IPRCreationResult[]> {
    const taskId = (task._id as any).toString();
    console.log(`\n🔀 [PR Management] Creating Pull Requests for completed epics (Multi-Repo)...`);

    const epics = task.orchestration.techLead.epics || [];

    if (repositories.length === 0 || !workspacePath) {
      console.log(`  ⚠️ No repository or workspace available for PR creation`);
      return [];
    }

    const results: IPRCreationResult[] = [];

    for (const epic of epics) {
      // Find target repository for this epic (defaults to first repository)
      const targetRepo = this.findTargetRepository(epic, repositories);

      if (!targetRepo) {
        console.log(`  ⚠️ Epic "${epic.name}" has invalid targetRepository, skipping`);
        results.push({
          success: false,
          error: 'Target repository not found',
          action: 'skipped',
        });
        continue;
      }

      const targetRepoPath = `${workspacePath}/${targetRepo.name}`;
      console.log(`  📍 Epic "${epic.name}" → Repository: ${targetRepo.full_name || targetRepo.name}`);

      const result = await this.createEpicPR(
        epic,
        targetRepo,
        targetRepoPath,
        task,
        taskId
      );

      results.push(result);
    }

    console.log(`✅ [PR Management] PR creation complete. Created ${results.filter(r => r.success).length}/${epics.length} PRs\n`);
    return results;
  }

  /**
   * Find target repository for an epic
   * Returns the repository object that matches epic.targetRepository
   * Defaults to first repository if not specified
   */
  private findTargetRepository(epic: IEpic, repositories: any[]): any | null {
    if (!epic.targetRepository) {
      // Default to first repository
      return repositories.length > 0 ? repositories[0] : null;
    }

    // Find repository by name or full_name
    const target = repositories.find(
      (repo) =>
        repo.full_name === epic.targetRepository ||
        repo.name === epic.targetRepository
    );

    // Fallback to first repository if not found
    return target || repositories[0] || null;
  }

  /**
   * Create PR for a single epic
   */
  private async createEpicPR(
    epic: IEpic,
    primaryRepo: any,
    primaryRepoPath: string,
    task: ITask,
    taskId: string
  ): Promise<IPRCreationResult> {
    // 🔥 Skip if already has PR (check simple boolean flag first, it's most reliable)
    if (epic.prCreated === true || epic.pullRequestNumber) {
      console.log(`  ℹ️ Epic "${epic.name}" already has PR #${epic.pullRequestNumber} (prCreated: ${epic.prCreated})`);
      return {
        success: true,
        prNumber: epic.pullRequestNumber,
        prUrl: epic.pullRequestUrl,
        action: 'found_existing',
      };
    }

    const branchName = epic.branchName;
    if (!branchName) {
      console.log(`  ⚠️ Epic "${epic.name}" has no branch name, skipping`);
      return {
        success: false,
        error: 'No branch name',
        action: 'skipped',
      };
    }

    // Verify changes exist
    const hasChanges = await this.verifyChangesExist(primaryRepoPath, branchName);
    if (!hasChanges) {
      console.log(`  ℹ️ Epic "${epic.name}" has no changes vs main, skipping PR`);
      return {
        success: false,
        error: 'No changes',
        action: 'skipped',
      };
    }

    // Attempt PR creation
    console.log(`  🔀 Creating PR for epic: ${epic.name} (branch: ${branchName})`);

    try {
      const repoDoc = await Repository.findById(primaryRepo.id);
      if (!repoDoc) {
        return {
          success: false,
          error: 'Repository document not found',
          action: 'skipped',
        };
      }

      const pr = await this.githubService.createPullRequest(
        repoDoc,
        (task.userId as any)._id.toString(),
        {
          title: `[Epic] ${epic.name}`,
          description: `${epic.description}\n\n**Epic**: ${epic.id}\n**Stories**: ${epic.stories.length}`,
          branch: branchName,
        }
      );

      // Update epic with PR info
      epic.pullRequestNumber = pr.number;
      epic.pullRequestUrl = pr.url;
      epic.pullRequestState = 'open';

      // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists reliably)
      epic.prCreated = true;

      // 🔥 CRITICAL: Mark nested array as modified for Mongoose
      task.markModified('orchestration.techLead.epics');
      await task.save();

      console.log(`  ✅ PR created: #${pr.number} - ${pr.url}`);

      NotificationService.emitPRCreated(taskId, {
        agentType: 'Development Team',
        prUrl: pr.url,
        branchName: branchName,
        title: epic.name,
      });

      return {
        success: true,
        prNumber: pr.number,
        prUrl: pr.url,
        action: 'created',
      };
    } catch (error: any) {
      console.error(`  ❌ Failed to create PR for epic "${epic.name}":`, error.message);

      // Try to recover with auto-healing
      return await this.handlePRCreationFailure(
        error,
        epic,
        branchName,
        primaryRepo,
        primaryRepoPath,
        task,
        taskId
      );
    }
  }

  /**
   * Handle PR creation failure with auto-healing
   */
  private async handlePRCreationFailure(
    error: Error,
    epic: IEpic,
    branchName: string,
    primaryRepo: any,
    primaryRepoPath: string,
    task: ITask,
    taskId: string
  ): Promise<IPRCreationResult> {
    // Check if it's a 422 validation error
    if (!error.message.includes('Validation Failed') && !error.message.includes('422')) {
      return {
        success: false,
        error: error.message,
        action: 'skipped',
      };
    }

    console.log(`  🔧 [PR Management] Attempting auto-healing for epic "${epic.name}"...`);

    // Try to find existing PR first
    const existingPR = await this.findExistingPR(primaryRepoPath, branchName);

    if (existingPR) {
      console.log(`  ✅ Found existing PR #${existingPR.number}`);

      epic.pullRequestNumber = existingPR.number;
      epic.pullRequestUrl = existingPR.url;
      epic.pullRequestState = 'open';

      // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists reliably)
      epic.prCreated = true;

      // 🔥 CRITICAL: Mark nested array as modified for Mongoose
      task.markModified('orchestration.techLead.epics');
      await task.save();

      NotificationService.emitAgentMessage(
        taskId,
        'Development Team',
        `ℹ️ **Using existing PR**: #${existingPR.number} - ${existingPR.title}`
      );

      return {
        success: true,
        prNumber: existingPR.number,
        prUrl: existingPR.url,
        action: 'found_existing',
      };
    }

    // No existing PR, try auto-healing
    const lastStory = epic.stories[epic.stories.length - 1];
    const storiesMap = task.orchestration.techLead.storiesMap || {};
    const storyObj = storiesMap[lastStory];

    const healingContext: IHealingContext = {
      repoPath: primaryRepoPath,
      branchName,
      userId: task.userId.toString(),
      epic,
      story: storyObj,
      repository: primaryRepo,
    };

    const healingResult = await this.autoHealingService.healPRCreationFailure(healingContext);

    if (!healingResult.success || healingResult.action === 'already_merged') {
      console.log(`  ⚠️ Auto-healing could not resolve issue: ${healingResult.details}`);
      return {
        success: false,
        error: healingResult.details,
        action: 'skipped',
      };
    }

    // Healing succeeded, retry PR creation
    if (healingResult.action === 'changes_committed' || healingResult.action === 'branch_synced') {
      console.log(`  🔄 Retrying PR creation after auto-healing...`);

      try {
        const retryRepoDoc = await Repository.findById(primaryRepo.id);
        if (!retryRepoDoc) {
          return {
            success: false,
            error: 'Repository document not found for retry',
            action: 'skipped',
          };
        }

        const retryPR = await this.githubService.createPullRequest(
          retryRepoDoc,
          (task.userId as any)._id.toString(),
          {
            title: `[Epic] ${epic.name}`,
            description: `${epic.description}\n\n**Epic**: ${epic.id}`,
            branch: branchName,
          }
        );

        epic.pullRequestNumber = retryPR.number;
        epic.pullRequestUrl = retryPR.url;
        epic.pullRequestState = 'open';

        // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists reliably)
        epic.prCreated = true;

        // 🔥 CRITICAL: Mark nested array as modified for Mongoose
        task.markModified('orchestration.techLead.epics');
        await task.save();

        console.log(`  ✅ PR created after auto-healing: #${retryPR.number}`);

        NotificationService.emitAgentMessage(
          taskId,
          'Development Team',
          `✅ **PR created after auto-healing**: ${retryPR.url}`
        );

        return {
          success: true,
          prNumber: retryPR.number,
          prUrl: retryPR.url,
          action: 'healed',
        };
      } catch (retryError: any) {
        console.error(`  ❌ PR creation still failed after healing:`, retryError.message);
        return {
          success: false,
          error: retryError.message,
          action: 'skipped',
        };
      }
    }

    return {
      success: false,
      error: 'Healing did not result in actionable fix',
      action: 'skipped',
    };
  }

  /**
   * Verify that changes exist between branch and main
   */
  private async verifyChangesExist(repoPath: string, branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execAsync(
        `git diff origin/main...${branchName} --stat`,
        { cwd: repoPath }
      );

      return stdout.trim().length > 0;
    } catch (error) {
      console.error(`  ⚠️ Error verifying changes:`, error);
      return false;
    }
  }

  /**
   * Find existing PR for a branch using gh CLI
   */
  private async findExistingPR(
    repoPath: string,
    branchName: string
  ): Promise<{ number: number; url: string; title: string } | null> {
    try {
      const { stdout } = await execAsync(
        `cd "${repoPath}" && gh pr list --head ${branchName} --json number,url,title --limit 1`,
        { timeout: 30000 }
      ).catch(() => ({ stdout: '[]' }));

      const existingPRs = JSON.parse(stdout);

      if (existingPRs && existingPRs.length > 0) {
        return existingPRs[0];
      }

      return null;
    } catch (error) {
      console.error(`  ⚠️ Error searching for existing PR:`, error);
      return null;
    }
  }
}
