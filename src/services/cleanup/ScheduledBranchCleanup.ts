/**
 * Scheduled Branch Cleanup Service
 *
 * Automatically cleans up old merged branches on a schedule
 * Runs daily to keep GitHub repositories clean
 */

import * as cron from 'node-cron';
import { TaskRepository, ITask } from '../../database/repositories/TaskRepository.js';
import { GitHubService } from '../GitHubService';
import { BranchCleanupService } from './BranchCleanupService';
import { LogService } from '../logging/LogService';
import path from 'path';
import os from 'os';

export class ScheduledBranchCleanupService {
  private static instance: ScheduledBranchCleanupService;
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;

  private constructor() {}

  static getInstance(): ScheduledBranchCleanupService {
    if (!ScheduledBranchCleanupService.instance) {
      ScheduledBranchCleanupService.instance = new ScheduledBranchCleanupService();
    }
    return ScheduledBranchCleanupService.instance;
  }

  /**
   * Start the cleanup scheduler
   * Runs daily at 2 AM
   */
  start(): void {
    if (this.cronJob) {
      console.log('Scheduled cleanup is already running');
      return;
    }

    // Run every day at 2 AM
    // Cron format: minute hour day month weekday
    // '0 2 * * *' = At 02:00 AM every day
    this.cronJob = cron.schedule('0 2 * * *', async () => {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`SCHEDULED CLEANUP STARTED`);
      console.log(`Time: ${new Date().toISOString()}`);
      console.log(`${'='.repeat(80)}\n`);

      await this.runCleanup();
    });

    console.log('Scheduled branch cleanup started (runs daily at 2 AM)');
  }

  /**
   * Stop the cleanup scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      console.log('Scheduled branch cleanup stopped');
    }
  }

  /**
   * Run cleanup manually (for testing or on-demand execution)
   */
  async runCleanup(): Promise<{
    tasksProcessed: number;
    branchesDeleted: number;
    errors: number;
  }> {
    if (this.isRunning) {
      console.log('Cleanup already running, skipping...');
      return { tasksProcessed: 0, branchesDeleted: 0, errors: 0 };
    }

    this.isRunning = true;

    try {
      console.log('Finding completed tasks with mergeable branches...');

      // Find completed tasks from last 30 days that haven't been cleaned up
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Get all completed tasks and filter in JS
      const allTasks = TaskRepository.findAll();
      const tasks = allTasks.filter((task: ITask) => {
        if (task.status !== 'completed') return false;
        if (!task.completedAt || new Date(task.completedAt) < thirtyDaysAgo) return false;
        if (task.orchestration?.currentPhase !== 'completed') return false;
        if (task.orchestration?.cancelRequested === true) return false;
        return true;
      }).slice(0, 100); // Process max 100 tasks per run

      console.log(`Found ${tasks.length} completed task(s) to check`);

      if (tasks.length === 0) {
        console.log('No tasks to clean up');
        return { tasksProcessed: 0, branchesDeleted: 0, errors: 0 };
      }

      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
      const githubService = new GitHubService(workspaceDir);
      const cleanupService = new BranchCleanupService(githubService);

      let tasksProcessed = 0;
      let branchesDeleted = 0;
      let errors = 0;

      for (const task of tasks) {
        const taskId = task.id;

        try {
          // Double-check: Verify task is really completed before cleanup
          const currentTask = TaskRepository.findById(taskId);
          if (!currentTask || currentTask.status !== 'completed' ||
              currentTask.orchestration.currentPhase !== 'completed') {
            console.log(`Skipping task ${taskId} - not fully completed`);
            continue;
          }

          console.log(`\nProcessing task: ${taskId}`);
          console.log(`   Title: ${task.title}`);
          console.log(`   Completed: ${task.completedAt?.toISOString?.() || 'unknown'}`);

          // Build branch mappings
          const mappings = BranchCleanupService.buildBranchMappingsFromTask(task);

          if (mappings.size === 0) {
            console.log(`   No branches to clean up`);
            continue;
          }

          console.log(`   Found ${mappings.size} epic(s) with branches`);

          // Clean up each epic
          for (const [epicId, mapping] of mappings.entries()) {
            try {
              console.log(`   Cleaning epic: ${mapping.epicBranch}`);

              await cleanupService.cleanupAllBranchesForEpic(taskId, epicId, mapping);

              const branchCount = mapping.storyBranches.length + 1;
              branchesDeleted += branchCount;

              console.log(`   Deleted ${branchCount} branch(es)`);

              await LogService.info(`Scheduled cleanup: deleted branches for epic`, {
                taskId,
                category: 'scheduled_cleanup',
                epicId,
                metadata: {
                  epicBranch: mapping.epicBranch,
                  branchesDeleted: branchCount,
                },
              });
            } catch (error: any) {
              console.error(`   Failed to clean epic ${mapping.epicBranch}: ${error.message}`);
              errors++;

              await LogService.error(`Scheduled cleanup: failed to clean epic`, {
                taskId,
                category: 'scheduled_cleanup',
                epicId,
                error,
                metadata: {
                  epicBranch: mapping.epicBranch,
                  errorMessage: error.message,
                },
              });
            }
          }

          tasksProcessed++;

        } catch (error: any) {
          console.error(`Error processing task ${taskId}: ${error.message}`);
          errors++;

          await LogService.error(`Scheduled cleanup: task processing failed`, {
            taskId,
            category: 'scheduled_cleanup',
            error,
            metadata: {
              errorMessage: error.message,
            },
          });
        }
      }

      console.log(`\n${'='.repeat(80)}`);
      console.log(`SCHEDULED CLEANUP COMPLETE`);
      console.log(`   Tasks processed: ${tasksProcessed}`);
      console.log(`   Branches deleted: ${branchesDeleted}`);
      console.log(`   Errors: ${errors}`);
      console.log(`${'='.repeat(80)}\n`);

      await LogService.success(`Scheduled cleanup completed`, {
        taskId: 'system',
        category: 'scheduled_cleanup',
        metadata: {
          tasksProcessed,
          branchesDeleted,
          errors,
        },
      });

      return { tasksProcessed, branchesDeleted, errors };

    } catch (error: any) {
      console.error('Scheduled cleanup failed:', error);

      await LogService.error(`Scheduled cleanup system error`, {
        taskId: 'system',
        category: 'scheduled_cleanup',
        error,
        metadata: {
          errorMessage: error.message,
        },
      });

      return { tasksProcessed: 0, branchesDeleted: 0, errors: 1 };

    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get cleanup status
   */
  getStatus(): {
    isRunning: boolean;
    schedulerActive: boolean;
    nextRun: string | null;
  } {
    return {
      isRunning: this.isRunning,
      schedulerActive: this.cronJob !== null,
      nextRun: this.cronJob ? 'Daily at 2:00 AM' : null,
    };
  }
}

// Export singleton instance
export const scheduledCleanup = ScheduledBranchCleanupService.getInstance();
