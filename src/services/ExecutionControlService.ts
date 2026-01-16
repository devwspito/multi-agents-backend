/**
 * ExecutionControlService - Mid-Execution Intervention System
 *
 * Allows supervisor to:
 * 1. Pause execution mid-turn (not just between phases)
 * 2. Inject directives during execution
 * 3. Request immediate abort
 * 4. Monitor real-time execution state
 *
 * Claude Code/OpenCode level feature for proactive supervision
 */

import { EventEmitter } from 'events';
import { NotificationService } from './NotificationService';
import { AgentActivityService } from './AgentActivityService';

export type InterventionType = 'pause' | 'abort' | 'directive' | 'warning';

export interface InterventionRequest {
  type: InterventionType;
  reason: string;
  directive?: string;
  urgency: 'immediate' | 'after_turn' | 'after_tool';
  requestedBy: 'supervisor' | 'user' | 'system';
  timestamp: Date;
}

export interface ExecutionState {
  taskId: string;
  agentType: string;
  phase: string;
  turnCount: number;
  lastToolName?: string;
  lastToolTime?: Date;
  isStreaming: boolean;
  isPaused: boolean;
  hasAbortRequest: boolean;
  pendingDirectives: string[];
  interventionHistory: InterventionRequest[];
}

class ExecutionControlServiceClass extends EventEmitter {
  // Track execution state per task
  private executionStates: Map<string, ExecutionState> = new Map();

  // Abort controllers per task
  private abortControllers: Map<string, AbortController> = new Map();

  // Pending directives to inject
  private pendingDirectives: Map<string, string[]> = new Map();

  /**
   * Initialize execution tracking for a task
   */
  startExecution(taskId: string, agentType: string, phase: string): AbortSignal {
    // Create abort controller for this execution
    const abortController = new AbortController();
    this.abortControllers.set(taskId, abortController);

    // Initialize execution state
    const state: ExecutionState = {
      taskId,
      agentType,
      phase,
      turnCount: 0,
      isStreaming: true,
      isPaused: false,
      hasAbortRequest: false,
      pendingDirectives: [],
      interventionHistory: [],
    };

    this.executionStates.set(taskId, state);
    this.pendingDirectives.set(taskId, []);

    console.log(`🎮 [ExecutionControl] Started tracking: ${agentType} in ${phase}`);

    return abortController.signal;
  }

  /**
   * End execution tracking
   */
  endExecution(taskId: string): void {
    this.executionStates.delete(taskId);
    this.abortControllers.delete(taskId);
    this.pendingDirectives.delete(taskId);

    console.log(`🎮 [ExecutionControl] Ended tracking for task ${taskId}`);
  }

  /**
   * Update execution state (called from stream loop)
   */
  updateState(taskId: string, updates: Partial<ExecutionState>): void {
    const state = this.executionStates.get(taskId);
    if (state) {
      Object.assign(state, updates);
      this.emit('state_updated', { taskId, state });
    }
  }

  /**
   * Record tool execution
   */
  recordToolExecution(taskId: string, toolName: string): void {
    const state = this.executionStates.get(taskId);
    if (state) {
      state.lastToolName = toolName;
      state.lastToolTime = new Date();
    }
  }

  /**
   * Request immediate pause (mid-turn)
   */
  requestPause(taskId: string, reason: string, requestedBy: 'supervisor' | 'user' | 'system' = 'user'): boolean {
    const state = this.executionStates.get(taskId);
    if (!state) {
      console.warn(`⚠️ [ExecutionControl] Cannot pause - no active execution for ${taskId}`);
      return false;
    }

    const intervention: InterventionRequest = {
      type: 'pause',
      reason,
      urgency: 'after_tool',
      requestedBy,
      timestamp: new Date(),
    };

    state.isPaused = true;
    state.interventionHistory.push(intervention);

    console.log(`⏸️ [ExecutionControl] Pause requested: ${reason}`);
    NotificationService.emitConsoleLog(taskId, 'warn', `⏸️ Execution paused: ${reason}`);
    AgentActivityService.emitMessage(taskId, 'Supervisor', `⏸️ Execution paused: ${reason}`);

    this.emit('pause_requested', { taskId, reason, requestedBy });
    return true;
  }

  /**
   * Resume paused execution
   */
  resume(taskId: string): boolean {
    const state = this.executionStates.get(taskId);
    if (!state) return false;

    state.isPaused = false;

    console.log(`▶️ [ExecutionControl] Execution resumed`);
    NotificationService.emitConsoleLog(taskId, 'info', `▶️ Execution resumed`);

    this.emit('resumed', { taskId });
    return true;
  }

  /**
   * Request immediate abort
   */
  requestAbort(taskId: string, reason: string, requestedBy: 'supervisor' | 'user' | 'system' = 'user'): boolean {
    const state = this.executionStates.get(taskId);
    const abortController = this.abortControllers.get(taskId);

    if (!state || !abortController) {
      console.warn(`⚠️ [ExecutionControl] Cannot abort - no active execution for ${taskId}`);
      return false;
    }

    const intervention: InterventionRequest = {
      type: 'abort',
      reason,
      urgency: 'immediate',
      requestedBy,
      timestamp: new Date(),
    };

    state.hasAbortRequest = true;
    state.interventionHistory.push(intervention);

    // Signal abort
    abortController.abort(reason);

    console.log(`🛑 [ExecutionControl] Abort requested: ${reason}`);
    NotificationService.emitConsoleLog(taskId, 'error', `🛑 Execution aborted: ${reason}`);
    AgentActivityService.emitError(taskId, 'Supervisor', `Execution aborted: ${reason}`);

    this.emit('abort_requested', { taskId, reason, requestedBy });
    return true;
  }

  /**
   * Inject a directive mid-execution
   * The directive will be included in the next turn's context
   */
  injectDirective(
    taskId: string,
    directive: string,
    urgency: 'immediate' | 'after_turn' | 'after_tool' = 'after_tool',
    requestedBy: 'supervisor' | 'user' | 'system' = 'supervisor'
  ): boolean {
    const state = this.executionStates.get(taskId);
    const directives = this.pendingDirectives.get(taskId);

    if (!state || !directives) {
      console.warn(`⚠️ [ExecutionControl] Cannot inject directive - no active execution for ${taskId}`);
      return false;
    }

    const intervention: InterventionRequest = {
      type: 'directive',
      reason: 'Directive injection',
      directive,
      urgency,
      requestedBy,
      timestamp: new Date(),
    };

    state.pendingDirectives.push(directive);
    state.interventionHistory.push(intervention);
    directives.push(directive);

    console.log(`📝 [ExecutionControl] Directive injected: ${directive.substring(0, 100)}...`);
    NotificationService.emitConsoleLog(taskId, 'info', `📝 New directive: ${directive.substring(0, 50)}...`);
    AgentActivityService.emitMessage(taskId, 'Supervisor', `📝 Directive: ${directive}`);

    this.emit('directive_injected', { taskId, directive, urgency, requestedBy });
    return true;
  }

  /**
   * Send a warning to the agent (non-blocking)
   */
  sendWarning(taskId: string, warning: string, requestedBy: 'supervisor' | 'user' | 'system' = 'supervisor'): boolean {
    const state = this.executionStates.get(taskId);
    if (!state) return false;

    const intervention: InterventionRequest = {
      type: 'warning',
      reason: warning,
      urgency: 'after_tool',
      requestedBy,
      timestamp: new Date(),
    };

    state.interventionHistory.push(intervention);

    console.log(`⚠️ [ExecutionControl] Warning sent: ${warning}`);
    NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ Supervisor warning: ${warning}`);
    AgentActivityService.emitMessage(taskId, 'Supervisor', `⚠️ Warning: ${warning}`);

    this.emit('warning_sent', { taskId, warning, requestedBy });
    return true;
  }

  /**
   * Get pending directives and clear them
   */
  consumeDirectives(taskId: string): string[] {
    const directives = this.pendingDirectives.get(taskId) || [];
    this.pendingDirectives.set(taskId, []);

    const state = this.executionStates.get(taskId);
    if (state) {
      state.pendingDirectives = [];
    }

    return directives;
  }

  /**
   * Check if execution should pause (called from stream loop)
   */
  shouldPause(taskId: string): boolean {
    const state = this.executionStates.get(taskId);
    return state?.isPaused || false;
  }

  /**
   * Check if execution should abort (called from stream loop)
   */
  shouldAbort(taskId: string): boolean {
    const state = this.executionStates.get(taskId);
    const abortController = this.abortControllers.get(taskId);
    return state?.hasAbortRequest || abortController?.signal.aborted || false;
  }

  /**
   * Check if there are pending directives
   */
  hasDirectives(taskId: string): boolean {
    const directives = this.pendingDirectives.get(taskId);
    return (directives?.length || 0) > 0;
  }

  /**
   * Get current execution state
   */
  getState(taskId: string): ExecutionState | undefined {
    return this.executionStates.get(taskId);
  }

  /**
   * Get all active executions
   */
  getActiveExecutions(): ExecutionState[] {
    return Array.from(this.executionStates.values());
  }

  /**
   * Wait for pause to be lifted
   */
  async waitForResume(taskId: string, checkIntervalMs: number = 1000): Promise<void> {
    const state = this.executionStates.get(taskId);
    if (!state?.isPaused) return;

    console.log(`⏸️ [ExecutionControl] Waiting for resume...`);

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const currentState = this.executionStates.get(taskId);
        if (!currentState?.isPaused || currentState.hasAbortRequest) {
          clearInterval(checkInterval);
          resolve();
        }
      }, checkIntervalMs);

      // Also listen for resume event
      const onResume = () => {
        clearInterval(checkInterval);
        resolve();
      };
      this.once('resumed', onResume);

      // Cleanup on abort
      const onAbort = () => {
        clearInterval(checkInterval);
        this.off('resumed', onResume);
        resolve();
      };
      this.once('abort_requested', onAbort);
    });
  }
}

export const ExecutionControlService = new ExecutionControlServiceClass();
export default ExecutionControlService;
