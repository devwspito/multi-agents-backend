/**
 * BranchCleanupService - Automatic branch cleanup after epic merge
 *
 * Problem: After orchestration completes, GitHub has dozens of story branches
 * that are no longer needed (epic/*, story/*). This creates clutter and confusion.
 *
 * Solution: Track epic → story branch relationships, then clean up systematically:
 * 1. When epic PR is merged → delete all story branches for that epic
 * 2. After merge confirmation → delete the epic branch itself
 * 3. Keep only main branch clean
 */

import { GitHubService } from '../GitHubService';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

export interface EpicBranchMapping {
  epicId: string;
  epicBranch: string;
  epicPullRequestNumber?: number;
  storyBranches: Array<{
    storyId: string;
    branchName: string;
    pullRequestNumber?: number;
    merged: boolean;
  }>;
  targetRepository: string;
}

export class BranchCleanupService {
  constructor(private githubService: GitHubService) {}

  /**
   * Track which story branches belong to an epic
   * Called by DevelopersPhase when creating story branches
   */
  static trackStoryBranch(
    taskId: string,
    epicId: string,
    epicBranch: string,
    storyId: string,
    storyBranch: string,
    targetRepository: string
  ): void {
    // Store in Task model under (task.orchestration as any).branchMappings
    console.log(`📝 [BranchCleanup] Tracking: ${storyBranch} belongs to epic ${epicBranch}`);
  }

  /**
   * Clean up all story branches after epic PR is merged
   * Called by QA phase after successful epic merge
   */
  async cleanupStoriesAfterEpicMerge(
    taskId: string,
    epicId: string,
    epicBranch: string,
    targetRepository: string,
    mapping: EpicBranchMapping
  ): Promise<{
    deleted: string[];
    failed: string[];
  }> {
    console.log(`\n🧹 [BranchCleanup] Starting cleanup for epic: ${epicBranch}`);
    console.log(`   Repository: ${targetRepository}`);
    console.log(`   Story branches to delete: ${mapping.storyBranches.length}`);

    const deleted: string[] = [];
    const failed: string[] = [];

    // Delete all story branches that were merged into this epic
    for (const story of mapping.storyBranches) {
      try {
        console.log(`   🗑️  Deleting story branch: ${story.branchName}`);

        await this.githubService.deleteBranch(
          targetRepository,
          story.branchName
        );

        deleted.push(story.branchName);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Deleted story branch: ${story.branchName}`
        );

        await LogService.info(`Deleted story branch ${story.branchName}`, {
          taskId,
          category: 'branch_cleanup',
          epicId,
          storyId: story.storyId,
          metadata: {
            branchName: story.branchName,
            epicBranch,
            repository: targetRepository,
          },
        });
      } catch (error: any) {
        console.error(`   ❌ Failed to delete ${story.branchName}: ${error.message}`);
        failed.push(story.branchName);

        await LogService.error(
          `Failed to delete story branch ${story.branchName}`,
          {
            taskId,
            category: 'branch_cleanup',
            epicId,
            storyId: story.storyId,
            error,
            metadata: {
              branchName: story.branchName,
              errorMessage: error.message,
            },
          }
        );
      }
    }

    console.log(`\n✅ [BranchCleanup] Cleanup complete for epic ${epicBranch}`);
    console.log(`   Deleted: ${deleted.length} branches`);
    console.log(`   Failed: ${failed.length} branches`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🧹 Cleanup: ${deleted.length} story branches deleted, ${failed.length} failed`
    );

    return { deleted, failed };
  }

  /**
   * Delete epic branch after PR is merged and confirmed
   * Called after all story branches are cleaned up
   */
  async cleanupEpicBranch(
    taskId: string,
    epicId: string,
    epicBranch: string,
    targetRepository: string
  ): Promise<boolean> {
    try {
      console.log(`\n🗑️  [BranchCleanup] Deleting epic branch: ${epicBranch}`);

      await this.githubService.deleteBranch(targetRepository, epicBranch);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ Epic branch deleted: ${epicBranch}`
      );

      await LogService.info(`Deleted epic branch ${epicBranch}`, {
        taskId,
        category: 'branch_cleanup',
        epicId,
        metadata: {
          branchName: epicBranch,
          repository: targetRepository,
        },
      });

      console.log(`✅ [BranchCleanup] Epic branch ${epicBranch} deleted successfully`);
      return true;
    } catch (error: any) {
      console.error(`❌ [BranchCleanup] Failed to delete epic branch ${epicBranch}: ${error.message}`);

      await LogService.error(`Failed to delete epic branch ${epicBranch}`, {
        taskId,
        category: 'branch_cleanup',
        epicId,
        error,
        metadata: {
          branchName: epicBranch,
          errorMessage: error.message,
        },
      });

      return false;
    }
  }

  /**
   * Full cleanup: Delete all branches (stories + epic) after epic merge
   * This is the main entry point called by QA phase
   */
  async cleanupAllBranchesForEpic(
    taskId: string,
    epicId: string,
    mapping: EpicBranchMapping
  ): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧹 STARTING FULL BRANCH CLEANUP FOR EPIC`);
    console.log(`Epic: ${mapping.epicBranch}`);
    console.log(`Repository: ${mapping.targetRepository}`);
    console.log(`Story branches: ${mapping.storyBranches.length}`);
    console.log(`${'='.repeat(80)}\n`);

    // Step 1: Delete all story branches
    const storyCleanup = await this.cleanupStoriesAfterEpicMerge(
      taskId,
      epicId,
      mapping.epicBranch,
      mapping.targetRepository,
      mapping
    );

    // Step 2: Delete epic branch
    const epicDeleted = await this.cleanupEpicBranch(
      taskId,
      epicId,
      mapping.epicBranch,
      mapping.targetRepository
    );

    // Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧹 CLEANUP SUMMARY`);
    console.log(`Story branches deleted: ${storyCleanup.deleted.length}`);
    console.log(`Story branches failed: ${storyCleanup.failed.length}`);
    console.log(`Epic branch deleted: ${epicDeleted ? 'YES' : 'NO'}`);
    console.log(`${'='.repeat(80)}\n`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🧹 Full cleanup complete: ${storyCleanup.deleted.length + (epicDeleted ? 1 : 0)} branches deleted`
    );
  }

  /**
   * Get branch mappings from task model
   */
  static getBranchMappingsFromTask(task: any): Map<string, EpicBranchMapping> {
    const mappings = new Map<string, EpicBranchMapping>();

    // Extract from (task.orchestration as any).branchMappings
    const branchMappings = (task.orchestration as any)?.branchMappings || [];

    for (const mapping of branchMappings) {
      mappings.set(mapping.epicId, mapping);
    }

    return mappings;
  }

  /**
   * Build branch mapping from task orchestration data
   * Reconstructs epic → story relationships from TeamOrchestration data
   */
  static buildBranchMappingsFromTask(task: any): Map<string, EpicBranchMapping> {
    const mappings = new Map<string, EpicBranchMapping>();

    const teamOrch = (task.orchestration as any)?.teamOrchestration;
    if (!teamOrch || !teamOrch.teams) {
      return mappings;
    }

    // Each team represents an epic
    for (const team of teamOrch.teams) {
      const epic = team.epic;
      if (!epic) continue;

      const mapping: EpicBranchMapping = {
        epicId: epic.id,
        epicBranch: epic.branchName,
        epicPullRequestNumber: epic.pullRequestNumber,
        storyBranches: [],
        targetRepository: epic.targetRepository || 'unknown',
      };

      // Collect all story branches from TechLead stories
      if (team.techLead?.stories) {
        for (const story of team.techLead.stories) {
          if (story.branchName) {
            mapping.storyBranches.push({
              storyId: story.id,
              branchName: story.branchName,
              pullRequestNumber: story.pullRequestNumber,
              merged: story.status === 'completed',
            });
          }
        }
      }

      mappings.set(epic.id, mapping);
    }

    console.log(`📋 [BranchCleanup] Built mappings for ${mappings.size} epic(s)`);
    return mappings;
  }
}
