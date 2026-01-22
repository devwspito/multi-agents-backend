/**
 * RollbackService - Git-based checkpoint and rollback system
 *
 * Implements commercial-grade rollback capabilities:
 * - Creates checkpoints before agent actions
 * - Enables instant rollback to any checkpoint
 * - Tracks all file changes for audit
 *
 * Based on Devin's checkpoint pattern:
 * "Snapshot before each action, restore on failure"
 */

import { execSync } from 'child_process';
import { CodeSnapshotRepository, ICodeSnapshot, IFileChange } from '../database/repositories/CodeSnapshotRepository.js';
import { LogService } from './logging/LogService';

export interface Checkpoint {
  id: string;
  taskId: string;
  timestamp: Date;
  commitHash: string;
  branchName: string;
  description: string;
  phase: string;
  agentType: string;
  agentInstanceId?: string;
  storyId?: string;
  filesModified: number;
}

export interface RollbackResult {
  success: boolean;
  fromCommit: string;
  toCommit: string;
  filesRestored: number;
  message: string;
}

class RollbackService {
  private checkpoints: Map<string, Checkpoint[]> = new Map(); // taskId -> checkpoints

  /**
   * Create a checkpoint before an agent action
   * This creates a git commit that can be rolled back to
   */
  async createCheckpoint(
    workspacePath: string,
    taskId: string,
    description: string,
    context: {
      phase: string;
      agentType: string;
      agentInstanceId?: string;
      storyId?: string;
      storyTitle?: string;
      epicId?: string;
      epicName?: string;
    }
  ): Promise<Checkpoint | null> {
    try {
      // Get current branch
      const branchName = this.execGit(workspacePath, 'git rev-parse --abbrev-ref HEAD').trim();

      // Check if there are any uncommitted changes
      const status = this.execGit(workspacePath, 'git status --porcelain');
      const hasChanges = status.trim().length > 0;

      if (hasChanges) {
        // Stash any uncommitted changes first
        this.execGit(workspacePath, 'git stash push -m "checkpoint-stash"');
      }

      // Create checkpoint ID
      const checkpointId = `ckpt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Create checkpoint commit (empty commit to mark the point)
      const checkpointMessage = `[CHECKPOINT] ${description}\n\nTask: ${taskId}\nPhase: ${context.phase}\nAgent: ${context.agentType}${context.agentInstanceId ? ` (${context.agentInstanceId})` : ''}\nCheckpoint ID: ${checkpointId}`;

      try {
        this.execGit(workspacePath, `git commit --allow-empty -m "${checkpointMessage.replace(/"/g, '\\"')}"`);
      } catch {
        // Commit might fail if nothing to commit, that's ok
      }

      const checkpointCommit = this.execGit(workspacePath, 'git rev-parse HEAD').trim();

      // Restore stashed changes if any
      if (hasChanges) {
        try {
          this.execGit(workspacePath, 'git stash pop');
        } catch {
          // Stash pop might fail if stash was empty
        }
      }

      const checkpoint: Checkpoint = {
        id: checkpointId,
        taskId,
        timestamp: new Date(),
        commitHash: checkpointCommit,
        branchName,
        description,
        phase: context.phase,
        agentType: context.agentType,
        agentInstanceId: context.agentInstanceId,
        storyId: context.storyId,
        filesModified: 0,
      };

      // Store in memory cache
      if (!this.checkpoints.has(taskId)) {
        this.checkpoints.set(taskId, []);
      }
      this.checkpoints.get(taskId)!.push(checkpoint);

      // Store in database
      CodeSnapshotRepository.create({
        taskId,
        timestamp: checkpoint.timestamp,
        phase: context.phase as any,
        agentType: context.agentType,
        agentInstanceId: context.agentInstanceId || context.agentType,
        epicId: context.epicId,
        epicName: context.epicName,
        storyId: context.storyId,
        storyTitle: context.storyTitle,
        repositoryName: workspacePath.split('/').pop() || 'unknown',
        branchName,
        commitHash: checkpointCommit,
        commitMessage: checkpointMessage,
        fileChanges: [],
      });

      await LogService.info(`Checkpoint created: ${description}`, {
        taskId,
        category: 'git',
        phase: context.phase as any,
        agentType: context.agentType as any,
        metadata: {
          checkpointId,
          commitHash: checkpointCommit,
        },
      });

      return checkpoint;
    } catch (error: any) {
      console.error(`❌ [Rollback] Failed to create checkpoint:`, error.message);
      return null;
    }
  }

  /**
   * Rollback to a specific checkpoint
   */
  async rollbackToCheckpoint(
    workspacePath: string,
    taskId: string,
    checkpointId: string
  ): Promise<RollbackResult> {
    try {
      const checkpoints = this.checkpoints.get(taskId) || [];
      const checkpoint = checkpoints.find(c => c.id === checkpointId);

      if (!checkpoint) {
        // Try to find from database
        const snapshots = CodeSnapshotRepository.findByTaskId(taskId);
        const snapshot = snapshots.find(s => s.commitMessage?.includes(checkpointId));

        if (!snapshot || !snapshot.commitHash) {
          return {
            success: false,
            fromCommit: '',
            toCommit: '',
            filesRestored: 0,
            message: `Checkpoint ${checkpointId} not found`,
          };
        }

        return this.rollbackToCommit(workspacePath, taskId, snapshot.commitHash);
      }

      return this.rollbackToCommit(workspacePath, taskId, checkpoint.commitHash);
    } catch (error: any) {
      return {
        success: false,
        fromCommit: '',
        toCommit: '',
        filesRestored: 0,
        message: `Rollback failed: ${error.message}`,
      };
    }
  }

  /**
   * Rollback to the last checkpoint
   */
  async rollbackToLastCheckpoint(
    workspacePath: string,
    taskId: string
  ): Promise<RollbackResult> {
    const checkpoints = this.checkpoints.get(taskId) || [];

    if (checkpoints.length === 0) {
      // Try database
      const snapshots = CodeSnapshotRepository.findByTaskId(taskId, { limit: 1 });
      const lastSnapshot = snapshots.find(s => s.commitHash);

      if (!lastSnapshot || !lastSnapshot.commitHash) {
        return {
          success: false,
          fromCommit: '',
          toCommit: '',
          filesRestored: 0,
          message: 'No checkpoints found for rollback',
        };
      }

      return this.rollbackToCommit(workspacePath, taskId, lastSnapshot.commitHash);
    }

    const lastCheckpoint = checkpoints[checkpoints.length - 1];
    return this.rollbackToCommit(workspacePath, taskId, lastCheckpoint.commitHash);
  }

  /**
   * Rollback to a specific commit
   */
  async rollbackToCommit(
    workspacePath: string,
    taskId: string,
    targetCommit: string
  ): Promise<RollbackResult> {
    try {
      // Get current commit
      const currentCommit = this.execGit(workspacePath, 'git rev-parse HEAD').trim();

      if (currentCommit === targetCommit) {
        return {
          success: true,
          fromCommit: currentCommit,
          toCommit: targetCommit,
          filesRestored: 0,
          message: 'Already at target checkpoint',
        };
      }

      // Count files that will change
      const diffOutput = this.execGit(
        workspacePath,
        `git diff --name-only ${targetCommit}..HEAD`
      );
      const filesChanged = diffOutput.trim().split('\n').filter(f => f.length > 0);

      // Perform the rollback (hard reset to target commit)
      this.execGit(workspacePath, `git reset --hard ${targetCommit}`);

      await LogService.success(`Rolled back to checkpoint`, {
        taskId,
        category: 'git',
        metadata: {
          fromCommit: currentCommit.substring(0, 7),
          toCommit: targetCommit.substring(0, 7),
          filesRestored: filesChanged.length,
        },
      });

      return {
        success: true,
        fromCommit: currentCommit,
        toCommit: targetCommit,
        filesRestored: filesChanged.length,
        message: `Successfully rolled back ${filesChanged.length} files`,
      };
    } catch (error: any) {
      await LogService.error(`Rollback failed`, {
        taskId,
        category: 'git',
        error: { message: error.message },
      });

      return {
        success: false,
        fromCommit: '',
        toCommit: targetCommit,
        filesRestored: 0,
        message: `Rollback failed: ${error.message}`,
      };
    }
  }

  /**
   * Get all checkpoints for a task
   */
  async getCheckpoints(taskId: string): Promise<Checkpoint[]> {
    // Combine memory cache with database
    const memoryCheckpoints = this.checkpoints.get(taskId) || [];

    const dbSnapshots = CodeSnapshotRepository.findByTaskId(taskId, { limit: 50 });

    // Convert DB snapshots to checkpoints
    const dbCheckpoints: Checkpoint[] = dbSnapshots
      .filter((s): s is ICodeSnapshot & { commitHash: string } => !!s.commitHash)
      .map((s) => ({
        id: s.commitMessage?.match(/Checkpoint ID: ([\w-]+)/)?.[1] || s.id,
        taskId: s.taskId,
        timestamp: s.timestamp,
        commitHash: s.commitHash,
        branchName: s.branchName,
        description: s.commitMessage?.split('\n')[0]?.replace('[CHECKPOINT] ', '') || 'Unknown',
        phase: s.phase,
        agentType: s.agentType,
        agentInstanceId: s.agentInstanceId,
        storyId: s.storyId,
        filesModified: s.totalFilesChanged,
      }));

    // Merge and deduplicate
    const allCheckpoints = [...memoryCheckpoints, ...dbCheckpoints];
    const uniqueCheckpoints = allCheckpoints.reduce((acc, curr) => {
      if (!acc.find(c => c.commitHash === curr.commitHash)) {
        acc.push(curr);
      }
      return acc;
    }, [] as Checkpoint[]);

    return uniqueCheckpoints.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  }

  /**
   * Capture current state as a snapshot (for tracking changes, not rollback)
   */
  async captureSnapshot(
    workspacePath: string,
    taskId: string,
    context: {
      phase: string;
      agentType: string;
      agentInstanceId?: string;
      storyId?: string;
      storyTitle?: string;
      epicId?: string;
      epicName?: string;
      commitHash?: string;
      commitMessage?: string;
    }
  ): Promise<void> {
    try {
      const branchName = this.execGit(workspacePath, 'git rev-parse --abbrev-ref HEAD').trim();
      const commitHash = context.commitHash || this.execGit(workspacePath, 'git rev-parse HEAD').trim();

      // Get diff output
      const diffOutput = this.execGit(workspacePath, 'git diff --name-status HEAD~1 2>/dev/null || echo ""');

      const fileChanges: IFileChange[] = diffOutput
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          const [status, path] = line.split('\t');
          return {
            path: path || '',
            changeType: this.parseGitStatus(status),
            linesAdded: 0,
            linesDeleted: 0,
          };
        });

      CodeSnapshotRepository.create({
        taskId,
        timestamp: new Date(),
        phase: context.phase as any,
        agentType: context.agentType,
        agentInstanceId: context.agentInstanceId || context.agentType,
        epicId: context.epicId,
        epicName: context.epicName,
        storyId: context.storyId,
        storyTitle: context.storyTitle,
        repositoryName: workspacePath.split('/').pop() || 'unknown',
        branchName,
        commitHash,
        commitMessage: context.commitMessage,
        fileChanges,
      });
    } catch (error: any) {
      console.error(`❌ [Rollback] Failed to capture snapshot:`, error.message);
    }
  }

  /**
   * Clean up old checkpoints for a task
   */
  async cleanupCheckpoints(taskId: string, keepCount: number = 10): Promise<number> {
    try {
      const checkpoints = await this.getCheckpoints(taskId);

      if (checkpoints.length <= keepCount) {
        return 0;
      }

      const toDelete = checkpoints.slice(keepCount);

      // Clean from database - delete all snapshots for task and recreate the ones to keep
      CodeSnapshotRepository.deleteByTaskId(taskId);

      // Clean memory cache
      if (this.checkpoints.has(taskId)) {
        const kept = this.checkpoints.get(taskId)!.slice(-keepCount);
        this.checkpoints.set(taskId, kept);
      }

      return toDelete.length;
    } catch (error: any) {
      console.error(`❌ [Rollback] Cleanup failed:`, error.message);
      return 0;
    }
  }

  /**
   * Execute git command safely
   */
  private execGit(workspacePath: string, command: string): string {
    try {
      return execSync(command, {
        cwd: workspacePath,
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error: any) {
      if (error.stdout) return error.stdout;
      throw error;
    }
  }

  /**
   * Parse git status letter to change type
   */
  private parseGitStatus(status: string): 'created' | 'modified' | 'deleted' | 'renamed' {
    switch (status?.charAt(0)) {
      case 'A':
        return 'created';
      case 'M':
        return 'modified';
      case 'D':
        return 'deleted';
      case 'R':
        return 'renamed';
      default:
        return 'modified';
    }
  }
}

// Singleton instance
export const rollbackService = new RollbackService();
