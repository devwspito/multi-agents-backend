/**
 * ResumeService - Centralized Resume Logic
 *
 * SINGLE SOURCE OF TRUTH for all resume operations.
 * Eliminates scattered isResume flags and ensures consistent state management.
 *
 * Usage:
 *   import { ResumeService } from '../services/ResumeService';
 *
 *   // Resume a task
 *   const result = ResumeService.resumeTask(taskId, orchestrator, { reason: 'user_action' });
 *
 *   // Check if task can be resumed
 *   const canResume = ResumeService.canResume(taskId);
 *
 *   // Build resume options for SDK
 *   const options = ResumeService.buildResumeOptions(taskId, checkpoint);
 */

import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { NotificationService } from './NotificationService.js';

export type ResumeReason =
  | 'user_action'           // User clicked resume
  | 'billing_recovery'      // Credits recharged after billing error
  | 'human_intervention'    // Human resolved an intervention request
  | 'auto_recovery'         // System auto-recovery
  | 'checkpoint_restore'    // Restoring from checkpoint
  | 'failed_retry';         // Retrying after failure

export interface ResumeResult {
  success: boolean;
  message: string;
  taskId: string;
  previousStatus?: string;
  currentPhase?: string;
}

export interface ResumeOptions {
  reason: ResumeReason;
  /** Custom message for logs/notifications */
  message?: string;
  /** Don't emit notifications (for internal resume) */
  silent?: boolean;
  /** Don't start orchestration (just update state) */
  stateOnly?: boolean;
}

/**
 * Resume options for SDK session continuation
 */
export interface SDKResumeOptions {
  resumeSessionId?: string;
  resumeAtMessage?: string;
  isResume: true;
}

/**
 * Centralized Resume Service
 */
export class ResumeService {
  /**
   * Check if a task can be resumed
   */
  static canResume(taskId: string): { canResume: boolean; reason?: string } {
    const task = TaskRepository.findById(taskId);

    if (!task) {
      return { canResume: false, reason: 'Task not found' };
    }

    // Can resume if paused
    if (task.orchestration?.paused === true) {
      return { canResume: true };
    }

    // Can resume if status is paused (includes billing pause)
    if (task.status === 'paused') {
      return { canResume: true };
    }

    // Can resume if awaiting human intervention
    if ((task.orchestration as any)?.humanIntervention?.required === true) {
      return { canResume: true };
    }

    // Can resume if has pending approval
    if (task.orchestration?.pendingApproval) {
      return { canResume: true };
    }

    // Cannot resume completed tasks
    if (task.status === 'completed') {
      return { canResume: false, reason: 'Task is already completed' };
    }

    // Cannot resume cancelled tasks
    if (task.status === 'cancelled') {
      return { canResume: false, reason: 'Task was cancelled' };
    }

    // Can resume failed tasks
    if (task.status === 'failed') {
      return { canResume: true };
    }

    // Already running
    if (task.status === 'in_progress') {
      return { canResume: false, reason: 'Task is already running' };
    }

    return { canResume: true };
  }

  /**
   * Prepare task state for resume (clear paused flags, update status)
   * This is the SINGLE place where resume state changes happen.
   */
  static prepareForResume(taskId: string, options: ResumeOptions): ResumeResult {
    const task = TaskRepository.findById(taskId);

    if (!task) {
      return {
        success: false,
        message: 'Task not found',
        taskId,
      };
    }

    const previousStatus = task.status;

    // 1. Clear paused flags in orchestration
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      const updated: any = {
        ...orch,
        paused: false,
        pausedAt: undefined,
        pausedBy: undefined,
      };

      // Clear billing pause if this is billing recovery
      if (options.reason === 'billing_recovery') {
        updated.billingPausedAt = undefined;
      }

      // Clear human intervention if resolved
      if (options.reason === 'human_intervention' && updated.humanIntervention) {
        updated.humanIntervention = {
          ...updated.humanIntervention,
          required: false,
        };
      }

      return updated;
    });

    // 2. Update task status to in_progress
    TaskRepository.update(taskId, { status: 'in_progress' });

    // 3. Log the resume
    const logMessage = this.getResumeLogMessage(options.reason, options.message);
    console.log(`▶️  [ResumeService] ${logMessage} for task ${taskId}`);

    // 4. Emit notification (unless silent)
    if (!options.silent) {
      const emoji = this.getResumeEmoji(options.reason);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `${emoji} ${logMessage}`
      );
    }

    // 5. Refresh task to get updated state
    const updatedTask = TaskRepository.findById(taskId);

    return {
      success: true,
      message: logMessage,
      taskId,
      previousStatus,
      currentPhase: updatedTask?.orchestration?.currentPhase,
    };
  }

  /**
   * Resume a task - prepares state and optionally starts orchestration
   */
  static async resumeTask(
    taskId: string,
    orchestrator: { orchestrateTask: (id: string) => Promise<void> },
    options: ResumeOptions
  ): Promise<ResumeResult> {
    // Check if can resume
    const { canResume, reason } = this.canResume(taskId);
    if (!canResume) {
      return {
        success: false,
        message: reason || 'Cannot resume task',
        taskId,
      };
    }

    // Prepare state for resume
    const prepareResult = this.prepareForResume(taskId, options);
    if (!prepareResult.success) {
      return prepareResult;
    }

    // Start orchestration (unless stateOnly)
    if (!options.stateOnly) {
      // Fire and forget - don't await
      orchestrator.orchestrateTask(taskId).catch((error) => {
        console.error(`❌ [ResumeService] Error resuming task ${taskId}:`, error);
      });
    }

    return prepareResult;
  }

  /**
   * Build SDK resume options from a checkpoint
   */
  static buildSDKResumeOptions(
    sessionId?: string,
    lastMessageUuid?: string
  ): SDKResumeOptions | undefined {
    if (!sessionId) {
      return undefined;
    }

    return {
      resumeSessionId: sessionId,
      resumeAtMessage: lastMessageUuid,
      isResume: true,
    };
  }

  /**
   * Get appropriate log message for resume reason
   */
  private static getResumeLogMessage(reason: ResumeReason, customMessage?: string): string {
    if (customMessage) {
      return customMessage;
    }

    switch (reason) {
      case 'billing_recovery':
        return 'Credits recharged! Resuming orchestration';
      case 'human_intervention':
        return 'Human intervention resolved - resuming orchestration';
      case 'auto_recovery':
        return 'Auto-recovery - resuming orchestration';
      case 'checkpoint_restore':
        return 'Restoring from checkpoint - resuming orchestration';
      case 'failed_retry':
        return 'Retrying after failure - resuming orchestration';
      case 'user_action':
      default:
        return 'Orchestration resuming';
    }
  }

  /**
   * Get emoji for resume reason
   */
  private static getResumeEmoji(reason: ResumeReason): string {
    switch (reason) {
      case 'billing_recovery':
        return '💰';
      case 'human_intervention':
        return '👤';
      case 'auto_recovery':
        return '🔄';
      case 'checkpoint_restore':
        return '📍';
      case 'failed_retry':
        return '🔁';
      case 'user_action':
      default:
        return '▶️';
    }
  }

  /**
   * Record resume in history (for audit trail)
   */
  static recordResume(taskId: string, reason: ResumeReason, metadata?: Record<string, any>): void {
    const task = TaskRepository.findById(taskId);
    if (!task) return;

    const resumeRecord = {
      timestamp: new Date().toISOString(),
      reason,
      previousStatus: task.status,
      currentPhase: task.orchestration?.currentPhase,
      ...metadata,
    };

    TaskRepository.modifyOrchestration(taskId, (orch) => {
      const history = (orch as any).resumeHistory || [];
      return {
        ...orch,
        resumeHistory: [...history, resumeRecord],
        lastResumedAt: resumeRecord.timestamp,
        lastResumeReason: reason,
      };
    });

    console.log(`📝 [ResumeService] Recorded resume for task ${taskId}: ${reason}`);
  }
}

// Export for convenience
export const resumeTask = ResumeService.resumeTask.bind(ResumeService);
export const canResume = ResumeService.canResume.bind(ResumeService);
export const prepareForResume = ResumeService.prepareForResume.bind(ResumeService);
