/**
 * AutoApprovalService
 *
 * CENTRALIZED auto-approval logic. ALL auto-approval checks should go through this service.
 * This prevents bugs from scattered checks reading stale data.
 *
 * Usage:
 *   import { AutoApprovalService } from '../services/AutoApprovalService';
 *
 *   // Check if auto-approval is enabled (always reads fresh from DB)
 *   if (AutoApprovalService.isEnabled(taskId)) {
 *     // Skip approval
 *   }
 *
 *   // Enable/disable auto-approval
 *   AutoApprovalService.setEnabled(taskId, true);
 */

import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { NotificationService } from './NotificationService.js';
import { approvalEvents } from './ApprovalEvents.js';

export class AutoApprovalService {
  /**
   * Check if auto-approval is enabled for a task.
   * ALWAYS reads fresh from database to avoid stale data.
   *
   * @param taskId - Task ID to check
   * @returns true if auto-approval is enabled
   */
  static isEnabled(taskId: string): boolean {
    const task = TaskRepository.findById(taskId);
    return task?.orchestration?.autoApprovalEnabled === true;
  }

  /**
   * Enable or disable auto-approval for a task.
   * Also handles releasing any pending approval if enabling.
   *
   * @param taskId - Task ID
   * @param enabled - Whether to enable auto-approval
   * @param options - Additional options
   */
  static setEnabled(
    taskId: string,
    enabled: boolean,
    options?: {
      approvedBy?: string;
      releasePendingApproval?: boolean;
    }
  ): { success: boolean; message: string } {
    const task = TaskRepository.findById(taskId);

    if (!task) {
      return { success: false, message: 'Task not found' };
    }

    // Update auto-approval setting
    TaskRepository.updateAutoApproval(taskId, enabled);

    console.log(`${enabled ? '🤖' : '👤'} [AutoApproval] ${enabled ? 'Enabled' : 'Disabled'} for task ${taskId}`);

    // If enabling and there's a pending approval, release it
    if (enabled && options?.releasePendingApproval !== false) {
      const pendingApproval = task.orchestration?.pendingApproval;

      if (pendingApproval?.phase) {
        console.log(`✅ [AutoApproval] Auto-releasing pending approval for phase: ${pendingApproval.phase}`);

        // Clear pending approval from DB
        TaskRepository.modifyOrchestration(taskId, (orch) => ({
          ...orch,
          pendingApproval: undefined,
        }));

        // Log in approval history
        const now = new Date();
        TaskRepository.modifyOrchestration(taskId, (orch) => {
          const history = (orch as any).approvalHistory || [];
          history.push({
            phase: pendingApproval.phase,
            approved: true,
            approvedBy: options?.approvedBy || 'system',
            approvedAt: now,
            method: 'auto-approval-enabled',
          });
          return {
            ...orch,
            approvalHistory: history,
          };
        });

        // Emit approval event to release any waiting orchestrator
        approvalEvents.emit(`approval:${taskId}:${pendingApproval.phase}`, {
          approved: true,
          feedback: '',
          userId: options?.approvedBy || 'system',
        });

        // Also emit for common phase names (belt and suspenders)
        const commonPhases = ['planning', 'tech-lead', 'team-orchestration', 'verification'];
        for (const phase of commonPhases) {
          if (phase !== pendingApproval.phase) {
            approvalEvents.emit(`approval:${taskId}:${phase}`, {
              approved: true,
              feedback: '',
              userId: options?.approvedBy || 'system',
            });
          }
        }

        // Notify frontend
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🤖 Auto-approval enabled - pending ${pendingApproval.phase} approval released`
        );
      }
    }

    return {
      success: true,
      message: enabled
        ? 'Auto-approval enabled - all future approvals will be automatic'
        : 'Auto-approval disabled - manual approval required',
    };
  }

  /**
   * Check if a specific phase should be auto-approved.
   * Some phases might have different rules in the future.
   *
   * @param taskId - Task ID
   * @param phase - Phase name
   * @returns true if the phase should be auto-approved
   */
  static shouldAutoApprovePhase(taskId: string, _phase: string): boolean {
    // For now, all phases follow the global setting
    // In the future, we could have per-phase settings
    return this.isEnabled(taskId);
  }

  /**
   * Record an auto-approval in the history.
   *
   * @param taskId - Task ID
   * @param phase - Phase that was auto-approved
   */
  static recordAutoApproval(taskId: string, phase: string): void {
    const now = new Date();
    TaskRepository.modifyOrchestration(taskId, (orch) => {
      const history = (orch as any).approvalHistory || [];
      history.push({
        phase,
        approved: true,
        approvedBy: 'auto-approval',
        approvedAt: now,
        method: 'autonomous-mode',
      });
      return {
        ...orch,
        approvalHistory: history,
      };
    });

    console.log(`🤖 [AutoApproval] Recorded auto-approval for phase: ${phase}`);
  }
}

export default AutoApprovalService;
