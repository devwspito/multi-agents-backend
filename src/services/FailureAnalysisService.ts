/**
 * Failure Analysis Service
 *
 * Implements Anthropic best practice: "Analyze agent failures systematically"
 * https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
 *
 * Key Questions (from Anthropic):
 * - Is the agent missing critical information?
 * - Can you add formal rules to identify/fix failures?
 * - Are the tools sufficiently creative and flexible?
 *
 * Tracks failure patterns and provides diagnostic insights.
 */

import { LogService } from './logging/LogService';
import { AgentType } from '../models/Task';

export interface AgentFailure {
  taskId: string;
  agentType: AgentType;
  phase: string;
  timestamp: Date;
  error: {
    message: string;
    stack?: string;
    code?: string;
  };
  context: {
    turnCount?: number;
    tokensUsed?: number;
    lastMessages?: any[];
    prompt?: string;
  };
  classification: FailureClassification;
  diagnostic: FailureDiagnostic;
}

export interface FailureClassification {
  category: 'missing_information' | 'tool_limitation' | 'network_error' | 'api_error' | 'logic_error' | 'unknown';
  severity: 'critical' | 'high' | 'medium' | 'low';
  recoverable: boolean;
}

export interface FailureDiagnostic {
  possibleCauses: string[];
  missingInformation?: string[];
  toolLimitations?: string[];
  suggestedFixes: string[];
}

export class FailureAnalysisService {
  private failures: AgentFailure[] = [];
  private readonly MAX_STORED_FAILURES = 100;

  /**
   * Log a failure with structured analysis
   */
  async logFailure(
    taskId: string,
    agentType: string,
    phase: string,
    error: Error,
    context?: {
      turnCount?: number;
      tokensUsed?: number;
      lastMessages?: any[];
      prompt?: string;
    }
  ): Promise<AgentFailure> {
    const failure: AgentFailure = {
      taskId,
      agentType: agentType as AgentType,
      phase,
      timestamp: new Date(),
      error: {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      },
      context: context || {},
      classification: this.classifyFailure(error, context),
      diagnostic: this.diagnoseFailure(error, agentType, context),
    };

    // Store failure
    this.failures.push(failure);
    if (this.failures.length > this.MAX_STORED_FAILURES) {
      this.failures.shift(); // Remove oldest
    }

    // Log to LogService
    await LogService.error(
      `Agent ${agentType} failed in ${phase}`,
      {
        taskId,
        category: 'agent-failure',
        phase: phase as any,
        agentType: failure.agentType,
        metadata: {
          classification: failure.classification,
          severity: failure.classification.severity
        }
      }
    );

    // Log structured analysis to console
    this.printFailureAnalysis(failure);

    return failure;
  }

  /**
   * Classify failure type
   */
  private classifyFailure(error: Error, _context?: any): FailureClassification {
    const message = error.message.toLowerCase();
    const code = (error as any).code;

    // Network/API errors
    if (
      code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      message.includes('network') ||
      message.includes('connection')
    ) {
      return {
        category: 'network_error',
        severity: 'high',
        recoverable: true,
      };
    }

    // API errors (Anthropic API)
    if (
      message.includes('api') ||
      message.includes('rate limit') ||
      message.includes('quota') ||
      code === 429 ||
      code === 500
    ) {
      return {
        category: 'api_error',
        severity: 'medium',
        recoverable: true,
      };
    }

    // Missing information (agent couldn't complete task)
    if (
      message.includes('not found') ||
      message.includes('missing') ||
      message.includes('undefined') ||
      message.includes('cannot find')
    ) {
      return {
        category: 'missing_information',
        severity: 'medium',
        recoverable: true,
      };
    }

    // Tool limitations
    if (
      message.includes('permission') ||
      message.includes('access denied') ||
      message.includes('not allowed') ||
      message.includes('tool')
    ) {
      return {
        category: 'tool_limitation',
        severity: 'low',
        recoverable: true,
      };
    }

    // Logic errors
    if (
      message.includes('syntax') ||
      message.includes('invalid') ||
      message.includes('unexpected')
    ) {
      return {
        category: 'logic_error',
        severity: 'critical',
        recoverable: false,
      };
    }

    // Unknown
    return {
      category: 'unknown',
      severity: 'medium',
      recoverable: true,
    };
  }

  /**
   * Diagnose failure (Anthropic's diagnostic questions)
   */
  private diagnoseFailure(error: Error, agentType: string, context?: any): FailureDiagnostic {
    const classification = this.classifyFailure(error, context);
    const diagnostic: FailureDiagnostic = {
      possibleCauses: [],
      missingInformation: [],
      toolLimitations: [],
      suggestedFixes: [],
    };

    const message = error.message.toLowerCase();

    // Anthropic Question 1: "Is the agent missing critical information?"
    if (classification.category === 'missing_information') {
      if (message.includes('file')) {
        diagnostic.missingInformation?.push('File not found or inaccessible');
        diagnostic.suggestedFixes.push('Verify file paths exist');
        diagnostic.suggestedFixes.push('Check workspace structure');
      }
      if (message.includes('repository')) {
        diagnostic.missingInformation?.push('Repository information incomplete');
        diagnostic.suggestedFixes.push('Ensure repository is cloned');
        diagnostic.suggestedFixes.push('Verify GitHub credentials');
      }
      if (message.includes('context')) {
        diagnostic.missingInformation?.push('Insufficient context provided');
        diagnostic.suggestedFixes.push('Add more detailed requirements');
        diagnostic.suggestedFixes.push('Include relevant documentation');
      }
    }

    // Anthropic Question 2: "Can you add formal rules to identify/fix failures?"
    if (classification.category === 'tool_limitation') {
      diagnostic.toolLimitations?.push('Tool permissions or capabilities insufficient');
      diagnostic.suggestedFixes.push('Review tool permissions');
      diagnostic.suggestedFixes.push('Add new tool capabilities');
      diagnostic.suggestedFixes.push('Modify tool restrictions');
    }

    // Anthropic Question 3: "Are the tools sufficiently creative and flexible?"
    if (classification.category === 'logic_error') {
      diagnostic.possibleCauses.push('Agent logic or reasoning failed');
      diagnostic.possibleCauses.push('Unexpected code path');
      diagnostic.suggestedFixes.push('Review agent prompts');
      diagnostic.suggestedFixes.push('Improve error handling');
      diagnostic.suggestedFixes.push('Add validation rules');
    }

    // Network/API specific
    if (classification.category === 'network_error') {
      diagnostic.possibleCauses.push('Network connectivity issue');
      diagnostic.possibleCauses.push('Remote service unavailable');
      diagnostic.suggestedFixes.push('Retry with backoff');
      diagnostic.suggestedFixes.push('Check network connection');
      diagnostic.suggestedFixes.push('Verify service status');
    }

    if (classification.category === 'api_error') {
      diagnostic.possibleCauses.push('API rate limit exceeded');
      diagnostic.possibleCauses.push('API quota exhausted');
      diagnostic.suggestedFixes.push('Implement rate limiting');
      diagnostic.suggestedFixes.push('Add request throttling');
      diagnostic.suggestedFixes.push('Check API key validity');
    }

    // Agent-specific diagnostics
    if (agentType === 'developer' && context?.turnCount && context.turnCount > 50) {
      diagnostic.possibleCauses.push('Too many iterations - agent may be stuck in loop');
      diagnostic.suggestedFixes.push('Review agent prompt for clarity');
      diagnostic.suggestedFixes.push('Add explicit success criteria');
    }

    if (!diagnostic.possibleCauses.length) {
      diagnostic.possibleCauses.push('Unknown cause - requires manual investigation');
    }

    if (!diagnostic.suggestedFixes.length) {
      diagnostic.suggestedFixes.push('Review error details and context');
      diagnostic.suggestedFixes.push('Check logs for more information');
    }

    return diagnostic;
  }

  /**
   * Print failure analysis to console (structured)
   */
  private printFailureAnalysis(failure: AgentFailure): void {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`🔥 AGENT FAILURE ANALYSIS`);
    console.error(`${'='.repeat(80)}`);
    console.error(`Agent: ${failure.agentType}`);
    console.error(`Phase: ${failure.phase}`);
    console.error(`Task ID: ${failure.taskId}`);
    console.error(`Timestamp: ${failure.timestamp.toISOString()}`);
    console.error(`\n--- ERROR ---`);
    console.error(`Message: ${failure.error.message}`);
    if (failure.error.code) {
      console.error(`Code: ${failure.error.code}`);
    }
    console.error(`\n--- CLASSIFICATION ---`);
    console.error(`Category: ${failure.classification.category}`);
    console.error(`Severity: ${failure.classification.severity}`);
    console.error(`Recoverable: ${failure.classification.recoverable ? 'YES' : 'NO'}`);

    if (failure.context.turnCount) {
      console.error(`\n--- CONTEXT ---`);
      console.error(`Turn Count: ${failure.context.turnCount}`);
      if (failure.context.tokensUsed) {
        console.error(`Tokens Used: ${failure.context.tokensUsed}`);
      }
    }

    console.error(`\n--- DIAGNOSTIC (Anthropic Best Practices) ---`);
    if (failure.diagnostic.possibleCauses.length > 0) {
      console.error(`\nPossible Causes:`);
      failure.diagnostic.possibleCauses.forEach((cause) => console.error(`  • ${cause}`));
    }
    if (failure.diagnostic.missingInformation && failure.diagnostic.missingInformation.length > 0) {
      console.error(`\nMissing Information:`);
      failure.diagnostic.missingInformation.forEach((info) => console.error(`  • ${info}`));
    }
    if (failure.diagnostic.toolLimitations && failure.diagnostic.toolLimitations.length > 0) {
      console.error(`\nTool Limitations:`);
      failure.diagnostic.toolLimitations.forEach((limit) => console.error(`  • ${limit}`));
    }
    console.error(`\nSuggested Fixes:`);
    failure.diagnostic.suggestedFixes.forEach((fix) => console.error(`  ✓ ${fix}`));

    console.error(`${'='.repeat(80)}\n`);
  }

  /**
   * Get failure statistics
   */
  getStatistics(): {
    total: number;
    byCategory: Record<string, number>;
    bySeverity: Record<string, number>;
    byAgent: Record<string, number>;
    recoverableRate: number;
  } {
    const stats = {
      total: this.failures.length,
      byCategory: {} as Record<string, number>,
      bySeverity: {} as Record<string, number>,
      byAgent: {} as Record<string, number>,
      recoverableRate: 0,
    };

    let recoverableCount = 0;

    for (const failure of this.failures) {
      // By category
      stats.byCategory[failure.classification.category] =
        (stats.byCategory[failure.classification.category] || 0) + 1;

      // By severity
      stats.bySeverity[failure.classification.severity] =
        (stats.bySeverity[failure.classification.severity] || 0) + 1;

      // By agent
      stats.byAgent[failure.agentType] = (stats.byAgent[failure.agentType] || 0) + 1;

      // Recoverable count
      if (failure.classification.recoverable) {
        recoverableCount++;
      }
    }

    stats.recoverableRate = stats.total > 0 ? (recoverableCount / stats.total) * 100 : 0;

    return stats;
  }

  /**
   * Get recent failures
   */
  getRecentFailures(count: number = 10): AgentFailure[] {
    return this.failures.slice(-count).reverse();
  }

  /**
   * Clear stored failures
   */
  clear(): void {
    this.failures = [];
  }
}

// Singleton instance
export const failureAnalysisService = new FailureAnalysisService();
