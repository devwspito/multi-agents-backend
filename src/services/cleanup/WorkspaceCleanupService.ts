/**
 * Workspace Cleanup Service
 *
 * Cleans up corrupted workspaces from tasks with wrong repository assignments
 */

import { Task } from '../../models/Task';
import { Repository } from '../../models/Repository';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface CorruptedTask {
  taskId: string;
  title: string;
  status: string;
  corruptedRepos: string[];
  workspacePath: string;
  createdAt: Date;
}

export interface CleanupResult {
  totalTasksScanned: number;
  corruptedTasksFound: number;
  workspacesDeleted: number;
  errors: Array<{ taskId: string; error: string }>;
  corruptedTasks: CorruptedTask[];
}

export class WorkspaceCleanupService {
  private workspaceDir: string;

  // System repositories that should NOT be in user tasks
  private readonly SYSTEM_REPOSITORIES = [
    'multi-agents-backend',
    'mult-agents-frontend',
    'multi-agents-frontend', // typo variant
    'mult-agents-backend', // typo variant
  ];

  constructor(workspaceDir?: string) {
    this.workspaceDir = workspaceDir || process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
  }

  /**
   * Scan all tasks and find those with corrupted workspace (system repos assigned)
   */
  async findCorruptedWorkspaces(): Promise<CorruptedTask[]> {
    const corruptedTasks: CorruptedTask[] = [];

    try {
      // Find all tasks with repositories
      const tasks = await Task.find({
        repositoryIds: { $exists: true, $ne: [] },
      }).select('_id title status repositoryIds createdAt');

      console.log(`\n🔍 Scanning ${tasks.length} tasks for corrupted workspaces...`);

      for (const task of tasks) {
        if (!task.repositoryIds || task.repositoryIds.length === 0) {
          continue;
        }

        // Get repository details
        const repositories = await Repository.find({
          _id: { $in: task.repositoryIds },
        }).select('name');

        // Check if any repository is a system repository
        const corruptedRepos = repositories
          .filter(repo => this.isSystemRepository(repo.name))
          .map(repo => repo.name);

        if (corruptedRepos.length > 0) {
          const workspacePath = path.join(this.workspaceDir, `task-${task._id}`);

          corruptedTasks.push({
            taskId: String(task._id),
            title: task.title,
            status: task.status,
            corruptedRepos,
            workspacePath,
            createdAt: task.createdAt,
          });

          console.log(`   ❌ Found corrupted task: ${task._id}`);
          console.log(`      Title: ${task.title}`);
          console.log(`      System repos: ${corruptedRepos.join(', ')}`);
        }
      }

      console.log(`\n✅ Scan complete: ${corruptedTasks.length} corrupted workspaces found`);

      return corruptedTasks;
    } catch (error: any) {
      console.error('❌ Error scanning for corrupted workspaces:', error);
      throw error;
    }
  }

  /**
   * Clean up a single workspace directory
   */
  async cleanupWorkspace(taskId: string): Promise<boolean> {
    const workspacePath = path.join(this.workspaceDir, `task-${taskId}`);

    try {
      // Check if workspace exists
      await fs.access(workspacePath);

      console.log(`   🧹 Deleting workspace: ${workspacePath}`);

      // Delete the workspace directory
      await fs.rm(workspacePath, { recursive: true, force: true });

      console.log(`   ✅ Workspace deleted successfully`);

      return true;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        console.log(`   ⚠️  Workspace doesn't exist (already clean): ${workspacePath}`);
        return true; // Consider it a success if it doesn't exist
      }

      console.error(`   ❌ Failed to delete workspace: ${error.message}`);
      return false;
    }
  }

  /**
   * Clean up ALL corrupted workspaces
   */
  async cleanupAllCorruptedWorkspaces(dryRun: boolean = false): Promise<CleanupResult> {
    console.log(`\n${'🧹'.repeat(40)}`);
    console.log(`🧹 WORKSPACE CLEANUP ${dryRun ? '(DRY RUN)' : '(ACTUAL)'}`);
    console.log(`${'🧹'.repeat(40)}\n`);

    const result: CleanupResult = {
      totalTasksScanned: 0,
      corruptedTasksFound: 0,
      workspacesDeleted: 0,
      errors: [],
      corruptedTasks: [],
    };

    try {
      // Find all corrupted workspaces
      const corruptedTasks = await this.findCorruptedWorkspaces();

      result.corruptedTasksFound = corruptedTasks.length;
      result.corruptedTasks = corruptedTasks;

      if (corruptedTasks.length === 0) {
        console.log('\n✅ No corrupted workspaces found. System is clean!');
        return result;
      }

      console.log(`\n${'🔥'.repeat(40)}`);
      console.log(`🔥 Found ${corruptedTasks.length} corrupted workspace(s)`);
      console.log(`${'🔥'.repeat(40)}\n`);

      if (dryRun) {
        console.log('⚠️  DRY RUN MODE - No changes will be made\n');

        for (const task of corruptedTasks) {
          console.log(`📋 Task: ${task.taskId} - ${task.title}`);
          console.log(`   Status: ${task.status}`);
          console.log(`   Corrupted repos: ${task.corruptedRepos.join(', ')}`);
          console.log(`   Workspace: ${task.workspacePath}`);
          console.log(`   Would be: DELETED\n`);
        }

        console.log(`\n✅ DRY RUN COMPLETE - ${corruptedTasks.length} workspaces would be deleted`);
        return result;
      }

      // ACTUAL CLEANUP
      console.log('🔥 Starting ACTUAL cleanup...\n');

      for (const task of corruptedTasks) {
        console.log(`\n🧹 Cleaning task: ${task.taskId} - ${task.title}`);

        try {
          const success = await this.cleanupWorkspace(task.taskId);

          if (success) {
            result.workspacesDeleted++;

            // Mark task as requiring reconfiguration
            await Task.findByIdAndUpdate(task.taskId, {
              $set: {
                'metadata.workspaceCorrupted': true,
                'metadata.workspaceCleanedAt': new Date(),
                'metadata.requiresReconfiguration': true,
              },
            });

            console.log(`   ✅ Task marked for reconfiguration`);
          } else {
            result.errors.push({
              taskId: task.taskId,
              error: 'Failed to delete workspace',
            });
          }
        } catch (error: any) {
          console.error(`   ❌ Error cleaning task ${task.taskId}: ${error.message}`);
          result.errors.push({
            taskId: task.taskId,
            error: error.message,
          });
        }
      }

      console.log(`\n${'✅'.repeat(40)}`);
      console.log(`✅ CLEANUP COMPLETE`);
      console.log(`${'✅'.repeat(40)}`);
      console.log(`   Corrupted tasks found: ${result.corruptedTasksFound}`);
      console.log(`   Workspaces deleted: ${result.workspacesDeleted}`);
      console.log(`   Errors: ${result.errors.length}`);
      console.log(`${'✅'.repeat(40)}\n`);

      return result;
    } catch (error: any) {
      console.error('❌ Fatal error during cleanup:', error);
      throw error;
    }
  }

  /**
   * Check if a repository name is a system repository
   */
  private isSystemRepository(repoName: string): boolean {
    return this.SYSTEM_REPOSITORIES.some(systemRepo =>
      repoName.toLowerCase().includes(systemRepo.toLowerCase())
    );
  }

  /**
   * Validate that repository IDs don't point to system repositories
   */
  async validateRepositoryIds(repositoryIds: string[]): Promise<{ valid: boolean; invalidRepos: string[] }> {
    const repositories = await Repository.find({
      _id: { $in: repositoryIds },
    }).select('name');

    const invalidRepos = repositories
      .filter(repo => this.isSystemRepository(repo.name))
      .map(repo => repo.name);

    return {
      valid: invalidRepos.length === 0,
      invalidRepos,
    };
  }
}
