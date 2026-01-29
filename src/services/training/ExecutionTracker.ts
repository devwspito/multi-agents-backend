/**
 * ExecutionTracker Service
 *
 * Coordinates granular tracking of agent executions for:
 * 1. Recovery/Resume/Retry - Perfect reconstruction of execution state
 * 2. Training Data - Clean data for ML model training
 *
 * This service provides simple hooks that AgentExecutorService calls at each stage.
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository';
import { AgentTurnRepository, IAgentTurn, TurnType } from '../../database/repositories/AgentTurnRepository';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository';

// Security analysis (lazy import to avoid circular dependency)
let securityAgentService: any = null;
const getSecurityAgent = async () => {
  if (!securityAgentService) {
    const module = await import('../security/SecurityAgentService');
    securityAgentService = module.securityAgentService;
  }
  return securityAgentService;
};

// Tracking state for an active execution
interface ActiveExecution {
  executionId: string;
  taskId: string;
  currentTurnId: string | null;
  currentTurnNumber: number;
  pendingToolCalls: Map<string, string>; // toolUseId -> toolCallId
}

class ExecutionTrackerService {
  // Map of taskId -> active execution tracking
  private activeExecutions: Map<string, ActiveExecution> = new Map();

  /**
   * Start tracking a new agent execution
   * Called at the beginning of AgentExecutorService.execute()
   */
  startExecution(params: {
    taskId: string;
    projectId?: string;
    storyId?: string;
    epicId?: string;
    agentType: string;
    agentInstanceId?: string;
    modelId: string;
    phaseName: string;
    prompt: string;
    workspacePath?: string;
    targetRepository?: string;
    branchName?: string;
    sessionId?: string;
  }): string {
    // Create execution record
    const execution = AgentExecutionRepository.create(params);

    // Track active execution
    this.activeExecutions.set(params.taskId, {
      executionId: execution.id,
      taskId: params.taskId,
      currentTurnId: null,
      currentTurnNumber: 0,
      pendingToolCalls: new Map(),
    });

    console.log(`[ExecutionTracker] Started execution ${execution.id} for task ${params.taskId}`);

    // 🔒 Security: Analyze prompt for injection attempts (async, non-blocking)
    this.analyzePromptAsync(params.taskId, execution.id, params.prompt, params.agentType, params.phaseName);

    return execution.id;
  }

  /**
   * Analyze prompt for AI agent-specific threats
   */
  private async analyzePromptAsync(
    taskId: string,
    executionId: string,
    prompt: string,
    agentType?: string,
    phaseName?: string
  ): Promise<void> {
    try {
      const security = await getSecurityAgent();
      await security.analyzePrompt({
        taskId,
        executionId,
        prompt,
        agentType,
        phaseName,
      });
    } catch (error: any) {
      console.warn(`[ExecutionTracker] Prompt analysis error (non-blocking): ${error.message}`);
    }
  }

  /**
   * Record a new turn starting
   * Called on SDK 'turn_start' message
   */
  startTurn(taskId: string, turnType: TurnType = 'assistant'): string | null {
    const active = this.activeExecutions.get(taskId);
    if (!active) {
      console.warn(`[ExecutionTracker] No active execution for task ${taskId}`);
      return null;
    }

    active.currentTurnNumber++;

    const turn = AgentTurnRepository.create({
      executionId: active.executionId,
      taskId,
      turnNumber: active.currentTurnNumber,
      turnType,
    });

    active.currentTurnId = turn.id;

    // Update execution progress
    AgentExecutionRepository.updateProgress(
      active.executionId,
      active.currentTurnNumber,
      active.currentTurnNumber // messages received = turns for now
    );

    return turn.id;
  }

  /**
   * Update current turn with content
   * Called when assistant message content is received
   */
  updateTurnContent(taskId: string, content: string, tokens?: { input: number; output: number }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) return;

    AgentTurnRepository.updateContent(active.currentTurnId, content, tokens);
  }

  /**
   * Record a tool call starting
   * Called on SDK 'tool_use' content block
   */
  startToolCall(taskId: string, params: {
    toolName: string;
    toolUseId: string;
    toolInput: any;
  }): string | null {
    const active = this.activeExecutions.get(taskId);
    if (!active?.currentTurnId) {
      console.warn(`[ExecutionTracker] No active turn for task ${taskId}`);
      return null;
    }

    const callOrder = ToolCallRepository.getNextCallOrder(active.currentTurnId);

    const toolCall = ToolCallRepository.create({
      executionId: active.executionId,
      turnId: active.currentTurnId,
      taskId,
      toolName: params.toolName,
      toolUseId: params.toolUseId,
      toolInput: params.toolInput,
      callOrder,
    });

    // Track pending tool call
    active.pendingToolCalls.set(params.toolUseId, toolCall.id);

    // Update turn with tool call count
    const currentCount = active.pendingToolCalls.size;
    AgentTurnRepository.updateToolCalls(active.currentTurnId, currentCount);

    return toolCall.id;
  }

  /**
   * Record a tool call completing
   * Called on SDK 'tool_result' message
   */
  completeToolCall(taskId: string, params: {
    toolUseId: string;
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    const toolCallId = active.pendingToolCalls.get(params.toolUseId);
    if (!toolCallId) {
      console.warn(`[ExecutionTracker] Unknown tool_use_id: ${params.toolUseId}`);
      return;
    }

    ToolCallRepository.complete(toolCallId, {
      toolOutput: params.toolOutput,
      toolSuccess: params.toolSuccess,
      toolError: params.toolError,
      bashExitCode: params.bashExitCode,
    });

    // Clear from pending
    active.pendingToolCalls.delete(params.toolUseId);
  }

  /**
   * Complete an execution successfully
   * Called at the end of successful agent execution
   */
  completeExecution(taskId: string, params: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd: number;
  }): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    AgentExecutionRepository.complete(active.executionId, {
      ...params,
      turnsCompleted: active.currentTurnNumber,
      messagesReceived: active.currentTurnNumber,
    });

    // Cleanup
    this.activeExecutions.delete(taskId);

    console.log(`[ExecutionTracker] Completed execution ${active.executionId} - ${active.currentTurnNumber} turns`);
  }

  /**
   * Fail an execution
   * Called when agent execution fails
   */
  failExecution(taskId: string, errorMessage: string, errorType?: string): void {
    const active = this.activeExecutions.get(taskId);
    if (!active) return;

    AgentExecutionRepository.fail(active.executionId, errorMessage, errorType);

    // Cleanup
    this.activeExecutions.delete(taskId);

    console.log(`[ExecutionTracker] Failed execution ${active.executionId}: ${errorMessage}`);
  }

  /**
   * Get the current execution ID for a task
   */
  getExecutionId(taskId: string): string | null {
    return this.activeExecutions.get(taskId)?.executionId || null;
  }

  /**
   * Get the current turn ID for a task
   */
  getCurrentTurnId(taskId: string): string | null {
    return this.activeExecutions.get(taskId)?.currentTurnId || null;
  }

  /**
   * Get execution statistics for a task
   */
  getStats(taskId: string) {
    return {
      executions: AgentExecutionRepository.getStats(taskId),
      toolCalls: ToolCallRepository.getStats(taskId),
    };
  }

  /**
   * Get full execution history for a task (for recovery)
   */
  getExecutionHistory(taskId: string): {
    executions: IAgentExecution[];
    turns: IAgentTurn[];
    toolCalls: IToolCall[];
  } {
    return {
      executions: AgentExecutionRepository.findByTaskId(taskId),
      turns: AgentTurnRepository.findByTaskId(taskId),
      toolCalls: ToolCallRepository.findByTaskId(taskId),
    };
  }

  /**
   * Check if there's an active execution for a task
   */
  hasActiveExecution(taskId: string): boolean {
    return this.activeExecutions.has(taskId);
  }

  /**
   * Cancel/cleanup an active execution (without marking as failed)
   */
  cancelExecution(taskId: string): void {
    const active = this.activeExecutions.get(taskId);
    if (active) {
      AgentExecutionRepository.fail(active.executionId, 'Execution cancelled', 'cancelled');
      this.activeExecutions.delete(taskId);
    }
  }
}

// Export singleton instance
export const executionTracker = new ExecutionTrackerService();
export default executionTracker;
