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
  emitApproval(taskId: string, phase: string, approved: boolean, feedback?: string): void {
    const eventName = `approval:${taskId}:${phase}`;
    console.log(`📡 [Event] Emitting approval event: ${eventName} (approved: ${approved}, feedback: ${feedback ? 'yes' : 'no'})`);
    this.emit(eventName, { approved, feedback, timestamp: new Date() });
  }

  /**
   * Wait for approval event with timeout
   *
   * Called by ApprovalPhase to wait for user approval
   * Returns Promise that resolves when user approves/rejects
   *
   * @param taskId - Task ID
   * @param phase - Phase name (e.g., 'Planning', 'TechLead', 'TeamOrchestration')
   * @param timeoutMs - Max wait time in milliseconds (default: 24 hours)
   * @returns Promise<{ approved: boolean, feedback?: string }> - approval result with optional feedback
   * @throws Error if timeout exceeded
   */
  waitForApproval(taskId: string, phase: string, timeoutMs: number): Promise<{ approved: boolean; feedback?: string }> {
    const eventName = `approval:${taskId}:${phase}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener(eventName, handler);
        // 🔥 IMPORTANT: Clean up to prevent memory leak
        this.removeAllListeners(eventName);
        reject(new Error(`Approval timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (data: { approved: boolean; feedback?: string; timestamp: Date }) => {
        clearTimeout(timeout);
        // 🔥 IMPORTANT: Clean up to prevent memory leak
        this.removeAllListeners(eventName);
        resolve({ approved: data.approved, feedback: data.feedback });
      };

      this.once(eventName, handler);
    });
  }

  /**
   * Clean up all listeners for a specific task
   * Should be called when a task completes or is cancelled
   */
  cleanupTask(taskId: string): void {
    // Remove all listeners for this task
    const eventNames = this.eventNames();
    for (const eventName of eventNames) {
      if (typeof eventName === 'string' && eventName.startsWith(`approval:${taskId}:`)) {
        this.removeAllListeners(eventName);
        console.log(`🧹 Cleaned up approval listeners for: ${eventName}`);
      }
    }
  }
}

/**
 * Export singleton instance
 */
export const approvalEvents = ApprovalEventEmitter.getInstance();
