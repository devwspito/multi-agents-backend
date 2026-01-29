/**
 * Training Export Service
 *
 * Aggregates all execution data and security findings into a clean
 * JSON format ready for ML training on NVIDIA DGX Spark.
 *
 * Output format:
 * {
 *   success: { execution, turns, toolCalls },
 *   securityTestsFailed: [...],
 *   vulnerabilities: [...],
 *   recommendations: [...]
 * }
 */

import { AgentExecutionRepository, IAgentExecution } from '../../database/repositories/AgentExecutionRepository';
import { AgentTurnRepository, IAgentTurn } from '../../database/repositories/AgentTurnRepository';
import { ToolCallRepository, IToolCall } from '../../database/repositories/ToolCallRepository';
import { SecurityObservationRepository } from '../../database/repositories/SecurityObservationRepository';
import { securityAgentService } from '../security/SecurityAgentService';

/**
 * Training data structure for a single task
 * This is what gets sent to the DGX for training
 */
export interface TrainingDataRecord {
  // Metadata
  id: string;
  taskId: string;
  exportedAt: string;
  version: string;

  // Success path - everything that was done
  success: {
    // Overall execution summary
    summary: {
      totalExecutions: number;
      totalTurns: number;
      totalToolCalls: number;
      totalCost: number;
      totalTokens: number;
      totalDurationMs: number;
      status: 'completed' | 'partial' | 'failed';
    };

    // Each agent execution
    executions: Array<{
      id: string;
      agentType: string;
      modelId: string;
      phaseName: string;
      prompt: string;
      finalOutput?: string;
      status: string;
      durationMs?: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number;
      turnsCompleted: number;
    }>;

    // Each turn of each execution
    turns: Array<{
      id: string;
      executionId: string;
      turnNumber: number;
      turnType: string;
      messageContent?: string;
      hasToolCalls: boolean;
      toolCallsCount: number;
      inputTokens: number;
      outputTokens: number;
    }>;

    // Each tool call
    toolCalls: Array<{
      id: string;
      executionId: string;
      turnId: string;
      toolName: string;
      toolInput: any;
      toolInputSummary?: string;
      toolOutput?: string;
      toolSuccess: boolean;
      toolError?: string;
      filePath?: string;
      bashCommand?: string;
      bashExitCode?: number;
      durationMs?: number;
      callOrder: number;
    }>;
  };

  // Security test failures from dev phase
  securityTestsFailed: Array<{
    testName: string;
    testType: string;
    filePath?: string;
    errorMessage: string;
    timestamp: string;
  }>;

  // All vulnerabilities detected by SecurityAgent
  vulnerabilities: Array<{
    id: string;
    category: string;
    severity: string;
    description: string;
    filePath?: string;
    lineNumber?: number;
    codeSnippet?: string;
    owaspCategory?: string;
    cweId?: string;
    detectedAt: string;
    falsePositive: boolean;
  }>;

  // Prioritized recommendations
  recommendations: string[];
}

/**
 * Batch export options
 */
export interface ExportOptions {
  startDate?: string;
  endDate?: string;
  status?: 'completed' | 'failed' | 'all';
  minVulnerabilities?: number;
  excludeFalsePositives?: boolean;
  limit?: number;
  offset?: number;
}

class TrainingExportServiceClass {
  private readonly VERSION = '1.0.0';

  /**
   * Export training data for a single task
   */
  async exportTask(taskId: string): Promise<TrainingDataRecord> {
    // Get all data for the task
    const executions = AgentExecutionRepository.findByTaskId(taskId);
    const turns = AgentTurnRepository.findByTaskId(taskId);
    const toolCalls = ToolCallRepository.findByTaskId(taskId);
    const observations = SecurityObservationRepository.findByTaskId(taskId);

    // Wait for any pending security analyses
    await securityAgentService.waitForPendingAnalyses();

    // Generate security report for recommendations
    const securityReport = await securityAgentService.generateReport(taskId);

    // Calculate summary statistics
    const summary = this.calculateSummary(executions, turns, toolCalls);

    // Extract security test failures (toolCalls with security-related failures)
    const securityTestsFailed = this.extractSecurityTestFailures(toolCalls);

    return {
      id: this.generateExportId(),
      taskId,
      exportedAt: new Date().toISOString(),
      version: this.VERSION,

      success: {
        summary,
        executions: executions.map(e => this.mapExecution(e)),
        turns: turns.map(t => this.mapTurn(t)),
        toolCalls: toolCalls.map(tc => this.mapToolCall(tc)),
      },

      securityTestsFailed,

      vulnerabilities: observations.map(obs => ({
        id: obs.id,
        category: obs.category,
        severity: obs.severity,
        description: obs.description,
        filePath: obs.filePath,
        lineNumber: obs.lineNumber,
        codeSnippet: obs.codeSnippet,
        owaspCategory: obs.owaspCategory,
        cweId: obs.cweId,
        detectedAt: obs.detectedAt.toISOString(),
        falsePositive: obs.falsePositive,
      })),

      recommendations: securityReport.recommendations,
    };
  }

  /**
   * Batch export multiple tasks for training
   */
  async exportBatch(options: ExportOptions = {}): Promise<TrainingDataRecord[]> {
    // Get executions matching criteria
    const executions = AgentExecutionRepository.findForTraining({
      startDate: options.startDate,
      endDate: options.endDate,
      status: options.status === 'all' ? undefined : options.status,
      limit: options.limit,
      offset: options.offset,
    });

    // Group by taskId
    const taskIds = new Set(executions.map(e => e.taskId));
    const records: TrainingDataRecord[] = [];

    for (const taskId of taskIds) {
      try {
        const record = await this.exportTask(taskId);

        // Apply filters
        if (options.minVulnerabilities !== undefined) {
          const vulnCount = options.excludeFalsePositives
            ? record.vulnerabilities.filter(v => !v.falsePositive).length
            : record.vulnerabilities.length;

          if (vulnCount < options.minVulnerabilities) {
            continue;
          }
        }

        records.push(record);
      } catch (error: any) {
        console.warn(`[TrainingExport] Failed to export task ${taskId}: ${error.message}`);
      }
    }

    return records;
  }

  /**
   * Export as JSONL (JSON Lines) format for streaming to DGX
   */
  async exportAsJSONL(options: ExportOptions = {}): Promise<string> {
    const records = await this.exportBatch(options);
    return records.map(r => JSON.stringify(r)).join('\n');
  }

  /**
   * Get export statistics
   */
  async getExportStats(options: { startDate?: string; endDate?: string } = {}): Promise<{
    totalTasks: number;
    totalExecutions: number;
    totalTurns: number;
    totalToolCalls: number;
    totalVulnerabilities: number;
    vulnerabilitiesBySeverity: Record<string, number>;
    vulnerabilitiesByCategory: Record<string, number>;
  }> {
    const executions = AgentExecutionRepository.findForTraining({
      startDate: options.startDate,
      endDate: options.endDate,
    });

    const taskIds = new Set(executions.map(e => e.taskId));
    let totalTurns = 0;
    let totalToolCalls = 0;
    let totalVulnerabilities = 0;
    const vulnerabilitiesBySeverity: Record<string, number> = {};
    const vulnerabilitiesByCategory: Record<string, number> = {};

    for (const taskId of taskIds) {
      const turns = AgentTurnRepository.findByTaskId(taskId);
      const toolCalls = ToolCallRepository.findByTaskId(taskId);
      const observations = SecurityObservationRepository.findByTaskId(taskId);

      totalTurns += turns.length;
      totalToolCalls += toolCalls.length;
      totalVulnerabilities += observations.length;

      for (const obs of observations) {
        vulnerabilitiesBySeverity[obs.severity] = (vulnerabilitiesBySeverity[obs.severity] || 0) + 1;
        vulnerabilitiesByCategory[obs.category] = (vulnerabilitiesByCategory[obs.category] || 0) + 1;
      }
    }

    return {
      totalTasks: taskIds.size,
      totalExecutions: executions.length,
      totalTurns,
      totalToolCalls,
      totalVulnerabilities,
      vulnerabilitiesBySeverity,
      vulnerabilitiesByCategory,
    };
  }

  // ==================== Private Helpers ====================

  private calculateSummary(
    executions: IAgentExecution[],
    turns: IAgentTurn[],
    toolCalls: IToolCall[]
  ): TrainingDataRecord['success']['summary'] {
    const totalCost = executions.reduce((sum, e) => sum + e.costUsd, 0);
    const totalTokens = executions.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0);
    const totalDurationMs = executions.reduce((sum, e) => sum + (e.durationMs || 0), 0);

    const hasCompleted = executions.some(e => e.status === 'completed');
    const hasFailed = executions.some(e => e.status === 'failed');

    let status: 'completed' | 'partial' | 'failed';
    if (hasCompleted && !hasFailed) {
      status = 'completed';
    } else if (hasCompleted && hasFailed) {
      status = 'partial';
    } else {
      status = 'failed';
    }

    return {
      totalExecutions: executions.length,
      totalTurns: turns.length,
      totalToolCalls: toolCalls.length,
      totalCost,
      totalTokens,
      totalDurationMs,
      status,
    };
  }

  private mapExecution(e: IAgentExecution) {
    return {
      id: e.id,
      agentType: e.agentType,
      modelId: e.modelId,
      phaseName: e.phaseName,
      prompt: e.prompt,
      finalOutput: e.finalOutput,
      status: e.status,
      durationMs: e.durationMs,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      costUsd: e.costUsd,
      turnsCompleted: e.turnsCompleted,
    };
  }

  private mapTurn(t: IAgentTurn) {
    return {
      id: t.id,
      executionId: t.executionId,
      turnNumber: t.turnNumber,
      turnType: t.turnType,
      messageContent: t.messageContent,
      hasToolCalls: t.hasToolCalls,
      toolCallsCount: t.toolCallsCount,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
    };
  }

  private mapToolCall(tc: IToolCall) {
    return {
      id: tc.id,
      executionId: tc.executionId,
      turnId: tc.turnId,
      toolName: tc.toolName,
      toolInput: tc.toolInput,
      toolInputSummary: tc.toolInputSummary,
      toolOutput: tc.toolOutput,
      toolSuccess: tc.toolSuccess,
      toolError: tc.toolError,
      filePath: tc.filePath,
      bashCommand: tc.bashCommand,
      bashExitCode: tc.bashExitCode,
      durationMs: tc.durationMs,
      callOrder: tc.callOrder,
    };
  }

  private extractSecurityTestFailures(toolCalls: IToolCall[]): TrainingDataRecord['securityTestsFailed'] {
    const failures: TrainingDataRecord['securityTestsFailed'] = [];

    for (const tc of toolCalls) {
      // Check for security-related tool failures
      if (!tc.toolSuccess && tc.toolName.toLowerCase().includes('security')) {
        failures.push({
          testName: tc.toolName,
          testType: 'security_tool',
          filePath: tc.filePath,
          errorMessage: tc.toolError || 'Unknown error',
          timestamp: tc.startedAt.toISOString(),
        });
      }

      // Check for failed security validations in Bash
      if (tc.toolName === 'Bash' && tc.bashCommand) {
        const cmd = tc.bashCommand.toLowerCase();
        if (
          (cmd.includes('npm audit') || cmd.includes('yarn audit')) &&
          tc.bashExitCode !== 0
        ) {
          failures.push({
            testName: 'npm_audit',
            testType: 'dependency_scan',
            errorMessage: tc.toolOutput?.substring(0, 500) || 'Audit failed',
            timestamp: tc.startedAt.toISOString(),
          });
        }

        if (cmd.includes('eslint') && cmd.includes('security') && tc.bashExitCode !== 0) {
          failures.push({
            testName: 'eslint_security',
            testType: 'static_analysis',
            errorMessage: tc.toolOutput?.substring(0, 500) || 'ESLint security check failed',
            timestamp: tc.startedAt.toISOString(),
          });
        }
      }
    }

    return failures;
  }

  private generateExportId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    return `exp_${timestamp}_${random}`;
  }
}

// Export singleton
export const trainingExportService = new TrainingExportServiceClass();
export default trainingExportService;
