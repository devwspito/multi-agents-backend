import { ExecutionCheckpointRepository, IExecutionCheckpoint } from '../database/repositories/ExecutionCheckpointRepository.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { NotificationService } from './NotificationService';
import { safeGitExecSync } from '../utils/safeGitExecution';

/**
 * ExecutionCheckpointService
 *
 * Manages checkpoints for agent executions to enable recovery after
 * server restart or crash.
 *
 * Usage:
 * 1. Call createCheckpoint() when starting an agent execution
 * 2. Call updateCheckpoint() periodically during execution (every N turns)
 * 3. Call completeCheckpoint() when execution finishes
 * 4. On server restart, call recoverActiveExecutions()
 */
export class ExecutionCheckpointService {
  private static readonly CHECKPOINT_INTERVAL_TURNS = 5; // Save every 5 turns
  private static readonly CHECKPOINT_INTERVAL_MS = 30000; // Or every 30 seconds

  /**
   * Create a new checkpoint when starting an execution
   */
  static async createCheckpoint(params: {
    taskId: string;
    agentType: string;
    agentName?: string;
    phaseName?: string;
    workspacePath: string;
    modelId: string;
    prompt: string;
    context?: any;
  }): Promise<IExecutionCheckpoint> {
    // Get project ID from task
    let projectId;
    try {
      const task = TaskRepository.findById(params.taskId);
      projectId = task?.projectId;
    } catch {
      // Ignore
    }

    // Get git state
    const gitState = await this.getGitState(params.workspacePath);

    const checkpoint = ExecutionCheckpointRepository.create({
      taskId: params.taskId,
      projectId,
      agentType: params.agentType,
      agentName: params.agentName,
      phaseName: params.phaseName,
      workspacePath: params.workspacePath,
      modelId: params.modelId,
      originalPrompt: params.prompt.substring(0, 100000), // Limit size
      contextSnapshot: params.context ? {
        epics: params.context.getData?.('epics')?.slice(0, 10),
        stories: params.context.getData?.('stories')?.slice(0, 20),
      } : undefined,
      gitState,
    });

    console.log(`💾 [Checkpoint] Created for ${params.agentType} (${checkpoint.id})`);

    return checkpoint;
  }

  /**
   * Update checkpoint during execution
   * Call this periodically (every N turns or N seconds)
   */
  static async updateCheckpoint(
    checkpointId: string,
    updates: {
      turnsCompleted?: number;
      messagesReceived?: number;
      filesModified?: string[];
    }
  ): Promise<void> {
    try {
      const checkpoint = ExecutionCheckpointRepository.findById(checkpointId);
      if (!checkpoint || checkpoint.status !== 'active') {
        return;
      }

      // Get updated git state
      const gitState = await this.getGitState(checkpoint.workspacePath);

      // Update progress using repository method
      ExecutionCheckpointRepository.updateProgress(checkpointId, {
        turnsCompleted: updates.turnsCompleted,
        messagesReceived: updates.messagesReceived,
        filesModified: updates.filesModified,
        gitState,
      });

      const updated = ExecutionCheckpointRepository.findById(checkpointId);
      console.log(`💾 [Checkpoint] Updated ${checkpointId}: turn ${updated?.turnsCompleted || 0}, ${updated?.filesModified.length || 0} files`);
    } catch (error: any) {
      console.error(`❌ [Checkpoint] Failed to update ${checkpointId}:`, error.message);
    }
  }

  /**
   * Mark checkpoint as completed when execution finishes successfully
   */
  static async completeCheckpoint(checkpointId: string): Promise<void> {
    try {
      ExecutionCheckpointRepository.markCompleted(checkpointId);
      console.log(`✅ [Checkpoint] Completed ${checkpointId}`);
    } catch (error: any) {
      console.error(`❌ [Checkpoint] Failed to complete ${checkpointId}:`, error.message);
    }
  }

  /**
   * Mark checkpoint as failed when execution fails
   */
  static async failCheckpoint(checkpointId: string, _error?: string): Promise<void> {
    try {
      ExecutionCheckpointRepository.markFailed(checkpointId);
      console.log(`❌ [Checkpoint] Failed ${checkpointId}`);
    } catch (err: any) {
      console.error(`❌ [Checkpoint] Failed to mark as failed ${checkpointId}:`, err.message);
    }
  }

  /**
   * Abandon checkpoint (e.g., when starting a new execution for same agent)
   */
  static async abandonCheckpoint(checkpointId: string): Promise<void> {
    try {
      ExecutionCheckpointRepository.abandon(checkpointId);
      console.log(`🗑️ [Checkpoint] Abandoned ${checkpointId}`);
    } catch (error: any) {
      console.error(`❌ [Checkpoint] Failed to abandon ${checkpointId}:`, error.message);
    }
  }

  /**
   * Find active checkpoints that need recovery (called on server restart)
   */
  static async findActiveCheckpoints(): Promise<IExecutionCheckpoint[]> {
    return ExecutionCheckpointRepository.findActiveForRecovery();
  }

  /**
   * Recover active executions on server restart
   *
   * This is called from index.ts on startup to find and resume
   * any executions that were interrupted by a server restart.
   */
  static async recoverActiveExecutions(): Promise<number> {
    console.log('\n🔄 [Checkpoint] Checking for active executions to recover...');

    const activeCheckpoints = await this.findActiveCheckpoints();

    if (activeCheckpoints.length === 0) {
      console.log('✅ [Checkpoint] No active executions to recover');
      return 0;
    }

    console.log(`📋 [Checkpoint] Found ${activeCheckpoints.length} active execution(s) to recover:`);

    let recovered = 0;

    for (const checkpoint of activeCheckpoints) {
      try {
        console.log(`\n🔄 [Checkpoint] Recovering: ${checkpoint.agentType} (task: ${checkpoint.taskId})`);
        console.log(`   Turns completed: ${checkpoint.turnsCompleted}`);
        console.log(`   Files modified: ${checkpoint.filesModified.length}`);
        console.log(`   Last checkpoint: ${checkpoint.lastCheckpointAt.toISOString()}`);

        // Check if task still exists and is valid for recovery
        const task = TaskRepository.findById(checkpoint.taskId?.toString() || '');
        if (!task) {
          console.log(`   ⚠️ Task not found, abandoning checkpoint`);
          await this.abandonCheckpoint(checkpoint.id || '');
          continue;
        }

        if (task.status === 'completed' || task.status === 'cancelled') {
          console.log(`   ⚠️ Task already ${task.status}, abandoning checkpoint`);
          await this.abandonCheckpoint(checkpoint.id || '');
          continue;
        }

        // Resume the task (this will restart from the current phase)
        // The task's orchestration state tells us where to resume
        const { OrchestrationRecoveryService } = await import('./orchestration/OrchestrationRecoveryService');
        const recoveryService = new OrchestrationRecoveryService();

        // Mark task for recovery
        task.status = 'pending';
        TaskRepository.update(task.id, { status: 'pending' });

        // Mark checkpoint as abandoned (new execution will create new checkpoint)
        await this.abandonCheckpoint(checkpoint.id || '');

        // Resume orchestration
        recoveryService.resumeFailedTask(checkpoint.taskId.toString()).catch((error) => {
          console.error(`❌ [Checkpoint] Recovery failed for ${checkpoint.taskId}:`, error.message);
        });

        NotificationService.emitConsoleLog(
          checkpoint.taskId.toString(),
          'info',
          `🔄 Server restarted - Resuming execution (was at turn ${checkpoint.turnsCompleted})`
        );

        recovered++;
      } catch (error: any) {
        console.error(`❌ [Checkpoint] Failed to recover ${checkpoint.id}:`, error.message);
        await this.abandonCheckpoint(checkpoint.id);
      }
    }

    console.log(`\n✅ [Checkpoint] Recovered ${recovered}/${activeCheckpoints.length} active executions`);
    return recovered;
  }

  /**
   * Get current git state for a workspace
   */
  private static async getGitState(workspacePath: string): Promise<{
    branch: string;
    lastCommitSha?: string;
    uncommittedChanges: boolean;
  }> {
    try {
      const branch = safeGitExecSync('git branch --show-current', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000
      }).trim();

      const lastCommitSha = safeGitExecSync('git rev-parse HEAD', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000
      }).trim();

      const status = safeGitExecSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000
      });

      return {
        branch,
        lastCommitSha,
        uncommittedChanges: status.trim().length > 0
      };
    } catch {
      return {
        branch: 'unknown',
        uncommittedChanges: false
      };
    }
  }

  /**
   * Check if checkpoint should be updated based on turns or time
   */
  static shouldUpdateCheckpoint(
    lastCheckpointTurn: number,
    currentTurn: number,
    lastCheckpointTime: Date
  ): boolean {
    // Update every N turns
    if (currentTurn - lastCheckpointTurn >= this.CHECKPOINT_INTERVAL_TURNS) {
      return true;
    }

    // Or every N milliseconds
    if (Date.now() - lastCheckpointTime.getTime() >= this.CHECKPOINT_INTERVAL_MS) {
      return true;
    }

    return false;
  }

  /**
   * Cleanup old checkpoints (call periodically)
   */
  static async cleanupOld(daysOld: number = 1): Promise<number> {
    const deleted = ExecutionCheckpointRepository.cleanupOld(daysOld);
    console.log(`🗑️ [Checkpoint] Cleaned up ${deleted} old checkpoints`);
    return deleted;
  }
}
