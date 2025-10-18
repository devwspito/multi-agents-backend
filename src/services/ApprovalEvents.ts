import { EventEmitter } from 'events';

/**
 * Approval Event Emitter
 *
 * Global event emitter for approval events.
 * Allows approval endpoint to notify waiting orchestrators without polling.
 *
 * This is a CRITICAL component for event-based approval flow.
 * NO POLLING - uses Node.js EventEmitter for instant notifications.
 *
 * Usage:
 * - OrchestrationCoordinator waits: `await approvalEvents.waitForApproval(taskId, phase, timeout)`
 * - Route emits approval: `approvalEvents.emitApproval(taskId, phase, approved)`
 * - Orchestration resumes instantly (<100ms latency)
 */
class ApprovalEventEmitter extends EventEmitter {
  private static instance: ApprovalEventEmitter;

  private constructor() {
    super();
    this.setMaxListeners(100); // Support multiple concurrent tasks
  }

  /**
   * Get singleton instance
   */
  static getInstance(): ApprovalEventEmitter {
    if (!ApprovalEventEmitter.instance) {
      ApprovalEventEmitter.instance = new ApprovalEventEmitter();
    }
    return ApprovalEventEmitter.instance;
  }

  /**
   * Emit approval event for a specific task and phase
   *
   * Called by approval route (/api/tasks/:id/approve/:phase) when user approves/rejects
   */
  emitApproval(taskId: string, phase: string, approved: boolean): void {
    const eventName = `approval:${taskId}:${phase}`;
    console.log(`📡 [Event] Emitting approval event: ${eventName} (approved: ${approved})`);
    this.emit(eventName, { approved, timestamp: new Date() });
  }

  /**
   * Wait for approval event with timeout
   *
   * Called by ApprovalPhase to wait for user approval
   * Returns Promise that resolves when user approves/rejects
   *
   * @param taskId - Task ID
   * @param phase - Phase name (e.g., 'ProductManager', 'TechLead')
   * @param timeoutMs - Max wait time in milliseconds (default: 24 hours)
   * @returns Promise<boolean> - true if approved, false if rejected
   * @throws Error if timeout exceeded
   */
  waitForApproval(taskId: string, phase: string, timeoutMs: number): Promise<boolean> {
    const eventName = `approval:${taskId}:${phase}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(eventName, handler);
        reject(new Error(`Approval timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (data: { approved: boolean; timestamp: Date }) => {
        clearTimeout(timeout);
        resolve(data.approved);
      };

      this.once(eventName, handler);
    });
  }
}

/**
 * Export singleton instance
 */
export const approvalEvents = ApprovalEventEmitter.getInstance();
