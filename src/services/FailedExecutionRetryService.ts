import { FailedExecutionRepository, IFailedExecution } from '../database/repositories/FailedExecutionRepository.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { NotificationService } from './NotificationService';

/**
 * FailedExecutionRetryService
 *
 * Handles automatic and manual retry of failed agent executions.
 * Works in conjunction with the FailedExecution model to:
 * 1. Find executions ready for retry
 * 2. Re-execute them with the same or upgraded parameters
 * 3. Update status and history
 */
export class FailedExecutionRetryService {
  private static isProcessing = false;
  private static processInterval: NodeJS.Timeout | null = null;

  /**
   * Start background processing of retryable executions
   * Call this on server startup
   */
  static startBackgroundProcessor(intervalMs: number = 60000): void {
    if (this.processInterval) {
      console.log('[FailedExecutionRetry] Background processor already running');
      return;
    }

    console.log(`[FailedExecutionRetry] Starting background processor (interval: ${intervalMs}ms)`);

    this.processInterval = setInterval(async () => {
      await this.processRetryQueue();
    }, intervalMs);

    // Also run immediately on startup
    this.processRetryQueue();
  }

  /**
   * Stop background processing
   */
  static stopBackgroundProcessor(): void {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      console.log('[FailedExecutionRetry] Background processor stopped');
    }
  }

  /**
   * Process all executions ready for retry
   */
  static async processRetryQueue(): Promise<number> {
    if (this.isProcessing) {
      console.log('[FailedExecutionRetry] Already processing, skipping...');
      return 0;
    }

    this.isProcessing = true;
    let processed = 0;

    try {
      // Find executions ready for retry (limit to 5)
      const retryable = FailedExecutionRepository.findRetryable().slice(0, 5);

      if (retryable.length === 0) {
        return 0;
      }

      console.log(`[FailedExecutionRetry] Found ${retryable.length} executions to check`);

      // Pre-filter: Get task IDs and check which are still active
      const taskIds = retryable.map(e => e.taskId).filter(Boolean) as string[];
      const tasks = TaskRepository.findByIds(taskIds);
      const activeTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
      const activeTaskIds = new Set(activeTasks.map(t => t.id));

      // Mark executions for completed/failed tasks as abandoned
      for (const execution of retryable) {
        const taskIdStr = execution.taskId;
        if (taskIdStr && !activeTaskIds.has(taskIdStr)) {
          console.log(`⏹️  [FailedExecutionRetry] Task ${taskIdStr} is completed/failed, abandoning execution ${execution.id}`);
          FailedExecutionRepository.recordRetryAttempt(execution.id, {
            attemptedAt: new Date(),
            modelId: execution.modelId,
            result: 'failed',
            errorMessage: 'Task is completed or failed - no retry needed',
            durationMs: 0
          });
          FailedExecutionRepository.abandon(execution.id);
          continue;
        }

        try {
          await this.retryExecution(execution);
          processed++;
        } catch (error: any) {
          console.error(`[FailedExecutionRetry] Error retrying ${execution.id}:`, error.message);
        }
      }

      return processed;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Retry a specific failed execution
   */
  static async retryExecution(execution: IFailedExecution): Promise<boolean> {
    const startTime = Date.now();
    const execId = execution.id;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 [FailedExecutionRetry] Retrying execution: ${execId}`);
    console.log(`   Agent: ${execution.agentType}`);
    console.log(`   Failure: ${execution.failureType}`);
    console.log(`   Attempt: ${execution.retryCount + 1}/${execution.maxRetries}`);
    console.log(`${'='.repeat(60)}`);

    // Mark as retrying
    FailedExecutionRepository.markRetrying(execution.id);

    // Notify if we have a taskId
    if (execution.taskId) {
      NotificationService.emitConsoleLog(
        execution.taskId,
        'info',
        `🔄 Retrying failed ${execution.agentType} execution (attempt ${execution.retryCount + 1})`
      );
    }

    try {
      // Get the OrchestrationCoordinator
      const { OrchestrationCoordinator } = await import('./orchestration/OrchestrationCoordinator');

      // Get the task to create context
      const task = TaskRepository.findById(execution.taskId || '');
      if (!task) {
        throw new Error(`Task ${execution.taskId} not found`);
      }

      // DON'T retry if task is already completed or failed
      if (task.status === 'completed' || task.status === 'failed') {
        console.log(`⏹️  [FailedExecutionRetry] Task ${execution.taskId} is ${task.status}, skipping retry`);
        FailedExecutionRepository.recordRetryAttempt(execution.id, {
          attemptedAt: new Date(),
          modelId: execution.modelId,
          result: 'failed',
          errorMessage: `Task is ${task.status} - no retry needed`,
          durationMs: 0
        });
        FailedExecutionRepository.abandon(execution.id);
        return false;
      }

      // Create coordinator and execute
      const coordinator = new OrchestrationCoordinator();

      // For retry, we might want to upgrade the model
      const retryModel = this.getRetryModel(execution);

      console.log(`   Using model: ${retryModel} (original: ${execution.modelId})`);

      // 🔥 INJECT RECOVERY INSTRUCTIONS based on failure type
      const { getRecoveryInstructions } = await import('./orchestration/RecoveryInstructions');

      const recoveryInstructions = getRecoveryInstructions({
        failureType: execution.failureType,
        turnsCompleted: execution.turnsCompleted,
        messagesReceived: execution.messagesReceived,
        lastMessageTypes: execution.lastMessageTypes,
        filesModified: [], // Could track this in checkpoint
        retryCount: execution.retryCount
      });

      // Prepend recovery instructions to the original prompt
      const enhancedPrompt = `${recoveryInstructions}\n\n---\n\n## ORIGINAL TASK\n\n${execution.prompt}`;

      console.log(`   📋 Injected recovery instructions for: ${execution.failureType}`);

      // Execute the agent with enhanced prompt
      await coordinator.executeAgent(
        execution.agentType,
        enhancedPrompt,
        execution.workspacePath,
        execution.taskId?.toString(),
        execution.agentName,
        undefined, // sessionId
        undefined, // fork
        undefined, // attachments
        undefined, // options
        undefined, // contextOverride
        true, // skipOptimization - use specified model
        execution.permissionMode as any
      );

      // Success!
      const durationMs = Date.now() - startTime;

      FailedExecutionRepository.recordRetryAttempt(execution.id, {
        attemptedAt: new Date(),
        modelId: retryModel,
        result: 'success',
        durationMs
      });

      console.log(`✅ [FailedExecutionRetry] Retry succeeded for ${execId} in ${durationMs}ms`);

      if (execution.taskId) {
        NotificationService.emitConsoleLog(
          execution.taskId,
          'info',
          `✅ Retry succeeded for ${execution.agentType}`
        );
      }

      return true;
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      // Record the failed retry attempt
      FailedExecutionRepository.recordRetryAttempt(execution.id, {
        attemptedAt: new Date(),
        modelId: this.getRetryModel(execution),
        result: 'failed',
        errorMessage: error.message,
        durationMs
      });

      // Check if we've exhausted retries - recordRetryAttempt handles the status
      const updatedExecution = FailedExecutionRepository.findById(execution.id);
      if (updatedExecution && updatedExecution.retryStatus !== 'abandoned') {
        // Schedule next retry with exponential backoff
        const backoffMs = Math.min(
          30 * 60 * 1000, // Max 30 minutes
          60 * 1000 * Math.pow(2, updatedExecution.retryCount) // 1min, 2min, 4min, 8min...
        );
        FailedExecutionRepository.scheduleRetry(execution.id, new Date(Date.now() + backoffMs));
        console.log(`⏰ [FailedExecutionRetry] Scheduling retry in ${backoffMs / 1000}s`);
      } else {
        console.error(`❌ [FailedExecutionRetry] Max retries reached for ${execId}, abandoning`);
      }

      console.error(`❌ [FailedExecutionRetry] Retry failed for ${execId}:`, error.message);

      if (execution.taskId) {
        NotificationService.emitConsoleLog(
          execution.taskId,
          'error',
          `❌ Retry failed for ${execution.agentType}: ${error.message}`
        );
      }

      return false;
    }
  }

  /**
   * Get model to use for retry (potentially upgraded)
   */
  private static getRetryModel(execution: IFailedExecution): string {
    // For timeout failures, try with same model first
    // For loop detection, try with upgraded model
    if (execution.failureType === 'loop_detection' && execution.retryCount > 0) {
      // Upgrade to next tier
      if (execution.modelId?.includes('haiku')) {
        return execution.modelId.replace('haiku', 'sonnet');
      } else if (execution.modelId?.includes('sonnet')) {
        return execution.modelId.replace('sonnet', 'opus');
      }
    }
    return execution.modelId;
  }

  /**
   * Manual retry of a specific execution by ID
   */
  static async retryById(executionId: string): Promise<{ success: boolean; message: string }> {
    const execution = FailedExecutionRepository.findById(executionId);
    if (!execution) {
      return { success: false, message: 'Execution not found' };
    }

    if (execution.retryStatus === 'succeeded') {
      return { success: false, message: 'Execution already succeeded' };
    }

    if (execution.retryStatus === 'retrying') {
      return { success: false, message: 'Execution is currently being retried' };
    }

    // Reset retry status for manual retry
    FailedExecutionRepository.scheduleRetry(executionId, new Date());

    const result = await this.retryExecution(execution);
    return {
      success: result,
      message: result ? 'Retry succeeded' : 'Retry failed'
    };
  }

  /**
   * Abandon a failed execution (stop retrying)
   */
  static async abandonExecution(executionId: string): Promise<boolean> {
    return FailedExecutionRepository.abandon(executionId);
  }

  /**
   * Get failed execution stats for a task
   */
  static async getStats(taskId?: string): Promise<{
    total: number;
    pending: number;
    retrying: number;
    succeeded: number;
    abandoned: number;
    byFailureType: Record<string, number>;
  }> {
    // Get all executions for this task
    const executions = taskId
      ? FailedExecutionRepository.findByTaskId(taskId)
      : FailedExecutionRepository.findAll();

    const stats = {
      total: executions.length,
      pending: 0,
      retrying: 0,
      succeeded: 0,
      abandoned: 0,
      byFailureType: {} as Record<string, number>
    };

    for (const exec of executions) {
      // Count by status
      if (exec.retryStatus === 'pending') stats.pending++;
      else if (exec.retryStatus === 'retrying') stats.retrying++;
      else if (exec.retryStatus === 'succeeded') stats.succeeded++;
      else if (exec.retryStatus === 'abandoned') stats.abandoned++;

      // Count by failure type
      stats.byFailureType[exec.failureType] = (stats.byFailureType[exec.failureType] || 0) + 1;
    }

    return stats;
  }

  /**
   * Get recent failed executions for a task
   */
  static async getRecentForTask(taskId: string, limit: number = 10): Promise<IFailedExecution[]> {
    const executions = FailedExecutionRepository.findByTaskId(taskId);
    return executions.slice(0, limit);
  }

  /**
   * Cleanup old resolved executions (older than 7 days)
   */
  static async cleanupOld(daysOld: number = 7): Promise<number> {
    const deleted = FailedExecutionRepository.cleanupOld(daysOld);
    console.log(`[FailedExecutionRetry] Cleaned up ${deleted} old executions`);
    return deleted;
  }
}
