import { exec } from 'child_process';
import { promisify } from 'util';
import { ITask, IEpic } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { GitHubService } from '../GitHubService';
import { NotificationService } from '../NotificationService';
import { AutoMergeService, IMergeResult } from './AutoMergeService';
import { BranchCleanupService } from '../cleanup/BranchCleanupService';

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
  mergeResult?: IMergeResult; // Auto-merge result if attempted
}

/**
 * PR Management Service
 *
 * Handles all Pull Request creation and management logic
 * - Creates PRs after all developers complete
 * - Validates changes exist
 * - Searches for existing PRs
 * - Auto-merges PRs to main after verification
 * Note: Auto-healing feature temporarily disabled
 */
export class PRManagementService {
  private autoMergeService: AutoMergeService;

  constructor(private githubService: GitHubService) {
    this.autoMergeService = new AutoMergeService();
  }

  /**
   * Create PRs for all completed epics (Multi-Repo Support)
   *
   * This should be called AFTER verification completes
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

    // 🔥 EVENT SOURCING: Rebuild epics from events instead of reading from task model
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const epics = state.epics || [];

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

      // Build comprehensive PR description
      const prDescription = this.buildPRDescription(epic, task);

      const pr = await this.githubService.createPullRequest(
        repoDoc,
        (task.userId as any)._id.toString(),
        {
          title: `[Epic] ${epic.name}`,
          description: prDescription,
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
    _primaryRepo: any,
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

    // AUTO-HEALING DISABLED: Feature temporarily disabled
    // The auto-healing service was removed during cleanup
    console.log(`  ⚠️ Auto-healing disabled. PR creation failed for epic "${epic.name}"`);

    return {
      success: false,
      error: 'PR creation failed. Auto-healing feature is temporarily disabled.',
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

  /**
   * Attempt automatic merge for all open PRs to main
   *
   * This should be called AFTER all PRs are created and verification passes
   * Will automatically merge PRs that:
   * - Have no complex conflicts
   * - Pass all tests
   * - Pass verification checks
   *
   * @param task - Task with epics containing PR information
   * @param repositories - Repository objects with owner/name
   * @param workspacePath - Path to workspace with cloned repositories
   * @param taskId - Task ID for logging
   * @returns Array of merge results for each PR
   */
  async autoMergePRsToMain(
    task: ITask,
    repositories: any[],
    workspacePath: string | null,
    taskId: string
  ): Promise<IMergeResult[]> {
    console.log(`\n🚀 [Auto-Merge] Attempting automatic merge to main for all PRs...`);

    if (repositories.length === 0 || !workspacePath) {
      console.log(`  ⚠️ No repository or workspace available for auto-merge`);
      return [];
    }

    // Rebuild epics from events (event sourcing)
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const epics = state.epics || [];

    const results: IMergeResult[] = [];

    for (const epic of epics) {
      // Skip if no PR was created
      if (!epic.pullRequestNumber || !epic.prCreated) {
        console.log(`  ⏭️  Epic "${epic.name}" has no PR, skipping auto-merge`);
        continue;
      }

      // Find target repository
      const targetRepo = this.findTargetRepository(epic, repositories);
      if (!targetRepo) {
        console.log(`  ⚠️ Epic "${epic.name}" has invalid targetRepository, skipping`);
        continue;
      }

      const targetRepoPath = `${workspacePath}/${targetRepo.name}`;

      // Extract owner and repo name from repository
      const [repoOwner, repoName] = this.getOwnerAndRepo(targetRepo);

      console.log(`\n  🔀 [Auto-Merge] Epic: ${epic.name}`);
      console.log(`     PR #${epic.pullRequestNumber}`);
      console.log(`     Repository: ${repoOwner}/${repoName}`);

      // Attempt auto-merge
      const mergeResult = await this.autoMergeService.mergePRToMain(
        epic.pullRequestNumber,
        targetRepoPath,
        repoOwner,
        repoName,
        taskId
      );

      results.push(mergeResult);

      // Update epic with merge status
      if (mergeResult.merged) {
        (epic as any).pullRequestState = 'merged';
        (epic as any).mergedAt = new Date();
        (epic as any).mergeCommitSha = mergeResult.mergeCommitSha;

        // Clean up epic branch after successful merge
        if (epic.branchName) {
          await this.autoMergeService.deletePRBranch(
            epic.branchName,
            targetRepoPath,
            taskId
          );
        }

        // 🧹 CLEANUP: Delete all story branches that belong to this epic
        await this.cleanupStoryBranchesForEpic(task, epic, taskId);

        console.log(`     ✅ Successfully merged and cleaned up`);
      } else if (mergeResult.needsHumanReview) {
        console.log(`     ⚠️  Requires human review: ${mergeResult.error}`);

        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  PR #${epic.pullRequestNumber} needs human review: ${mergeResult.error}`
        );
      } else {
        console.log(`     ❌ Merge failed: ${mergeResult.error}`);
      }
    }

    // Save epic updates
    task.markModified('orchestration.techLead.epics');
    await task.save();

    const successfulMerges = results.filter((r) => r.merged).length;
    const needsReview = results.filter((r) => r.needsHumanReview).length;

    console.log(`\n✅ [Auto-Merge] Complete:`);
    console.log(`   Merged: ${successfulMerges}/${epics.length}`);
    console.log(`   Needs review: ${needsReview}`);

    return results;
  }

  /**
   * Clean up all story branches that belong to an epic after successful epic merge
   *
   * @param task - Task containing orchestration data
   * @param epic - Epic that was merged
   * @param taskId - Task ID for logging
   */
  private async cleanupStoryBranchesForEpic(
    task: ITask,
    epic: any,
    taskId: string
  ): Promise<void> {
    try {
      console.log(`\n🧹 [Cleanup] Cleaning story branches for epic: ${epic.branchName}`);

      // Build branch mappings from task orchestration data
      const mappings = BranchCleanupService.buildBranchMappingsFromTask(task);
      const mapping = mappings.get(epic.id);

      if (!mapping || mapping.storyBranches.length === 0) {
        console.log(`   ⏭️  No story branches found for epic ${epic.id}`);
        return;
      }

      console.log(`   Found ${mapping.storyBranches.length} story branch(es) to clean up`);

      // Create cleanup service instance
      const cleanupService = new BranchCleanupService(this.githubService);

      // Clean up only story branches (epic branch already deleted by deletePRBranch above)
      const result = await cleanupService.cleanupStoriesAfterEpicMerge(
        taskId,
        epic.id,
        epic.branchName,
        epic.targetRepository,
        mapping
      );

      console.log(`   ✅ Cleanup complete: ${result.deleted.length} deleted, ${result.failed.length} failed`);
    } catch (error: any) {
      console.error(`   ⚠️  Story branch cleanup failed: ${error.message}`);
      // Don't throw - cleanup failure shouldn't block the merge success
    }
  }

  /**
   * Build comprehensive PR description following best practices
   *
   * Template includes:
   * - Summary of changes
   * - Stories implemented with acceptance criteria
   * - Test plan
   * - Definition of Done checklist
   */
  private buildPRDescription(epic: IEpic, task: ITask): string {
    const stories = epic.stories || [];
    const storyList = stories.map((s: any, i: number) => {
      const status = s.status === 'approved' ? '✅' : s.status === 'rejected' ? '❌' : '⏳';
      return `${i + 1}. ${status} **${s.title}**\n   - ${s.description || 'No description'}`;
    }).join('\n');

    // Build acceptance criteria from stories
    const acceptanceCriteria = stories
      .filter((s: any) => s.acceptanceCriteria && s.acceptanceCriteria.length > 0)
      .map((s: any) => `**${s.title}**:\n${s.acceptanceCriteria.map((ac: string) => `  - [ ] ${ac}`).join('\n')}`)
      .join('\n\n');

    const description = `## 📋 Summary
${epic.description || 'No description provided'}

## 📖 Stories Implemented
${storyList || 'No stories defined'}

## ✅ Acceptance Criteria
${acceptanceCriteria || 'No acceptance criteria defined'}

## 🧪 Test Plan
- [ ] All unit tests pass
- [ ] Integration tests pass (if applicable)
- [ ] Manual testing completed
- [ ] Edge cases verified

## 📝 Definition of Done
- [ ] Code compiles without errors (\`npm run build\`)
- [ ] All tests pass (\`npm test\`)
- [ ] No linting errors (\`npm run lint\`)
- [ ] Code reviewed by Judge agent
- [ ] Security scan passed (no vulnerabilities)
- [ ] Documentation updated (if needed)

## 📊 Metadata
- **Epic ID**: ${epic.id}
- **Task**: ${task.title || 'Unnamed task'}
- **Stories**: ${stories.length} total
- **Branch**: \`${epic.branchName}\`

---
🤖 Generated by Multi-Agent Development Platform`;

    return description;
  }

  /**
   * Extract owner and repo name from repository object
   */
  private getOwnerAndRepo(repo: any): [string, string] {
    // Try to extract from full_name (e.g., "luiscorrea/backend")
    if (repo.full_name && repo.full_name.includes('/')) {
      const parts = repo.full_name.split('/');
      return [parts[0], parts[1]];
    }

    // Fallback: use repo name and try to get owner from other fields
    const repoName = repo.name || 'unknown';
    const repoOwner = repo.owner || repo.user || 'unknown';

    return [repoOwner, repoName];
  }
}
