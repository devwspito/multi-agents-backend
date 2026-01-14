/**
 * AgentPerformanceTracker
 *
 * Tracks performance metrics for all agents to identify bottlenecks
 * and optimize configuration.
 *
 * Key behaviors:
 * 1. Track execution time per agent/phase
 * 2. Monitor token usage and costs
 * 3. Track success/failure rates
 * 4. Identify slow/expensive operations
 */

import * as fs from 'fs';
import * as path from 'path';

export interface AgentExecution {
  id: string;
  agentType: string;
  phase: string;
  model: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  cost: number;
  status: 'running' | 'success' | 'failure' | 'timeout';
  error?: string;
  toolCalls: number;
  retries: number;
  metadata?: Record<string, any>;
}

export interface AgentStats {
  agentType: string;
  totalExecutions: number;
  successRate: number;
  avgDuration: number;
  avgTokens: number;
  avgCost: number;
  totalCost: number;
  p50Duration: number;
  p90Duration: number;
  failureReasons: { reason: string; count: number }[];
}

export interface PhaseStats {
  phase: string;
  executions: number;
  avgDuration: number;
  totalCost: number;
  successRate: number;
  bottleneck: boolean;
}

export interface PerformanceReport {
  period: { start: number; end: number };
  totalExecutions: number;
  totalCost: number;
  totalTokens: number;
  avgCostPerTask: number;
  byAgent: AgentStats[];
  byPhase: PhaseStats[];
  recommendations: string[];
  slowestAgents: string[];
  mostExpensive: string[];
}

export class AgentPerformanceTracker {
  private static executions: AgentExecution[] = [];
  private static metricsPath: string | null = null;
  private static activeExecutions: Map<string, AgentExecution> = new Map();

  /**
   * Initialize tracker
   */
  static async initialize(workspacePath: string): Promise<void> {
    this.metricsPath = path.join(workspacePath, '.agent-metrics.json');

    if (fs.existsSync(this.metricsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.metricsPath, 'utf8'));
        this.executions = data.executions || [];

        // Keep only last 30 days of data
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        this.executions = this.executions.filter(e => e.startTime > thirtyDaysAgo);

        console.log(`📊 [PerformanceTracker] Loaded ${this.executions.length} execution records`);
      } catch {
        this.executions = [];
      }
    }
  }

  /**
   * Save metrics to disk
   */
  private static save(): void {
    if (this.metricsPath) {
      try {
        fs.writeFileSync(this.metricsPath, JSON.stringify({ executions: this.executions }, null, 2));
      } catch {
        // Ignore write errors
      }
    }
  }

  /**
   * Start tracking an execution
   */
  static startExecution(
    agentType: string,
    phase: string,
    model: string,
    metadata?: Record<string, any>
  ): string {
    const id = `exec-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const execution: AgentExecution = {
      id,
      agentType,
      phase,
      model,
      startTime: Date.now(),
      tokens: { input: 0, output: 0, total: 0 },
      cost: 0,
      status: 'running',
      toolCalls: 0,
      retries: 0,
      metadata,
    };

    this.activeExecutions.set(id, execution);
    return id;
  }

  /**
   * Update execution with tool call
   */
  static recordToolCall(executionId: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.toolCalls++;
    }
  }

  /**
   * Update execution tokens
   */
  static recordTokens(executionId: string, input: number, output: number): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.tokens.input += input;
      execution.tokens.output += output;
      execution.tokens.total = execution.tokens.input + execution.tokens.output;
    }
  }

  /**
   * Record retry attempt
   */
  static recordRetry(executionId: string): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.retries++;
    }
  }

  /**
   * End execution successfully
   */
  static endExecution(executionId: string, cost: number): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      execution.cost = cost;
      execution.status = 'success';

      this.executions.push(execution);
      this.activeExecutions.delete(executionId);
      this.save();
    }
  }

  /**
   * End execution with failure
   */
  static failExecution(executionId: string, error: string, cost: number = 0): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      execution.cost = cost;
      execution.status = 'failure';
      execution.error = error;

      this.executions.push(execution);
      this.activeExecutions.delete(executionId);
      this.save();
    }
  }

  /**
   * Timeout execution
   */
  static timeoutExecution(executionId: string, cost: number = 0): void {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.endTime = Date.now();
      execution.duration = execution.endTime - execution.startTime;
      execution.cost = cost;
      execution.status = 'timeout';
      execution.error = 'Execution timeout';

      this.executions.push(execution);
      this.activeExecutions.delete(executionId);
      this.save();
    }
  }

  /**
   * Get stats for an agent type
   */
  static getAgentStats(agentType: string): AgentStats {
    const agentExecutions = this.executions.filter(e => e.agentType === agentType);

    if (agentExecutions.length === 0) {
      return {
        agentType,
        totalExecutions: 0,
        successRate: 0,
        avgDuration: 0,
        avgTokens: 0,
        avgCost: 0,
        totalCost: 0,
        p50Duration: 0,
        p90Duration: 0,
        failureReasons: [],
      };
    }

    const successful = agentExecutions.filter(e => e.status === 'success');
    const durations = agentExecutions
      .filter(e => e.duration)
      .map(e => e.duration!)
      .sort((a, b) => a - b);

    const failureReasons: Record<string, number> = {};
    for (const exec of agentExecutions.filter(e => e.status === 'failure')) {
      const reason = exec.error || 'Unknown';
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }

    return {
      agentType,
      totalExecutions: agentExecutions.length,
      successRate: successful.length / agentExecutions.length,
      avgDuration: durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0,
      avgTokens: agentExecutions.reduce((sum, e) => sum + e.tokens.total, 0) / agentExecutions.length,
      avgCost: agentExecutions.reduce((sum, e) => sum + e.cost, 0) / agentExecutions.length,
      totalCost: agentExecutions.reduce((sum, e) => sum + e.cost, 0),
      p50Duration: durations[Math.floor(durations.length * 0.5)] || 0,
      p90Duration: durations[Math.floor(durations.length * 0.9)] || 0,
      failureReasons: Object.entries(failureReasons)
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Get stats by phase
   */
  static getPhaseStats(phase: string): PhaseStats {
    const phaseExecutions = this.executions.filter(e => e.phase === phase);

    if (phaseExecutions.length === 0) {
      return {
        phase,
        executions: 0,
        avgDuration: 0,
        totalCost: 0,
        successRate: 0,
        bottleneck: false,
      };
    }

    const successful = phaseExecutions.filter(e => e.status === 'success');
    const avgDuration = phaseExecutions
      .filter(e => e.duration)
      .reduce((sum, e) => sum + e.duration!, 0) / phaseExecutions.length;

    // Check if this phase is a bottleneck (avg duration > 2x overall average)
    const overallAvg = this.executions
      .filter(e => e.duration)
      .reduce((sum, e) => sum + e.duration!, 0) / Math.max(this.executions.length, 1);

    return {
      phase,
      executions: phaseExecutions.length,
      avgDuration,
      totalCost: phaseExecutions.reduce((sum, e) => sum + e.cost, 0),
      successRate: successful.length / phaseExecutions.length,
      bottleneck: avgDuration > overallAvg * 2,
    };
  }

  /**
   * Generate performance report
   */
  static generateReport(periodDays: number = 7): PerformanceReport {
    const startTime = Date.now() - periodDays * 24 * 60 * 60 * 1000;
    const periodExecutions = this.executions.filter(e => e.startTime >= startTime);

    // Get unique agent types and phases
    const agentTypes = [...new Set(periodExecutions.map(e => e.agentType))];
    const phases = [...new Set(periodExecutions.map(e => e.phase))];

    const byAgent = agentTypes.map(type => this.getAgentStats(type));
    const byPhase = phases.map(phase => this.getPhaseStats(phase));

    // Find slowest and most expensive
    const slowestAgents = byAgent
      .sort((a, b) => b.avgDuration - a.avgDuration)
      .slice(0, 3)
      .map(a => a.agentType);

    const mostExpensive = byAgent
      .sort((a, b) => b.avgCost - a.avgCost)
      .slice(0, 3)
      .map(a => a.agentType);

    // Generate recommendations
    const recommendations: string[] = [];

    for (const agent of byAgent) {
      if (agent.successRate < 0.8) {
        recommendations.push(`⚠️ ${agent.agentType} has ${Math.round(agent.successRate * 100)}% success rate - investigate failures`);
      }
      if (agent.avgDuration > 60000) {
        recommendations.push(`⏱️ ${agent.agentType} is slow (avg ${Math.round(agent.avgDuration / 1000)}s) - consider optimization`);
      }
      if (agent.avgCost > 1) {
        recommendations.push(`💰 ${agent.agentType} is expensive ($${agent.avgCost.toFixed(2)}/exec) - consider model downgrade`);
      }
    }

    for (const phase of byPhase) {
      if (phase.bottleneck) {
        recommendations.push(`🔴 ${phase.phase} is a bottleneck - optimize or parallelize`);
      }
    }

    return {
      period: { start: startTime, end: Date.now() },
      totalExecutions: periodExecutions.length,
      totalCost: periodExecutions.reduce((sum, e) => sum + e.cost, 0),
      totalTokens: periodExecutions.reduce((sum, e) => sum + e.tokens.total, 0),
      avgCostPerTask: periodExecutions.length > 0
        ? periodExecutions.reduce((sum, e) => sum + e.cost, 0) / periodExecutions.length
        : 0,
      byAgent,
      byPhase,
      recommendations,
      slowestAgents,
      mostExpensive,
    };
  }

  /**
   * Format report for prompt/display
   */
  static formatReport(report: PerformanceReport): string {
    return `
## 📊 Agent Performance Report

**Period**: ${new Date(report.period.start).toLocaleDateString()} - ${new Date(report.period.end).toLocaleDateString()}

### Summary
- **Total Executions**: ${report.totalExecutions}
- **Total Cost**: $${report.totalCost.toFixed(2)}
- **Total Tokens**: ${report.totalTokens.toLocaleString()}
- **Avg Cost/Task**: $${report.avgCostPerTask.toFixed(4)}

### By Agent Type
| Agent | Executions | Success Rate | Avg Duration | Avg Cost |
|-------|------------|--------------|--------------|----------|
${report.byAgent.map(a =>
  `| ${a.agentType} | ${a.totalExecutions} | ${Math.round(a.successRate * 100)}% | ${Math.round(a.avgDuration / 1000)}s | $${a.avgCost.toFixed(4)} |`
).join('\n')}

### By Phase
| Phase | Executions | Success Rate | Bottleneck |
|-------|------------|--------------|------------|
${report.byPhase.map(p =>
  `| ${p.phase} | ${p.executions} | ${Math.round(p.successRate * 100)}% | ${p.bottleneck ? '🔴 Yes' : '✅ No'} |`
).join('\n')}

### Recommendations
${report.recommendations.map(r => `- ${r}`).join('\n') || '✅ No issues detected'}

### Attention Areas
- **Slowest**: ${report.slowestAgents.join(', ') || 'None'}
- **Most Expensive**: ${report.mostExpensive.join(', ') || 'None'}
`;
  }

  /**
   * Get quick stats
   */
  static getQuickStats(): string {
    const last24h = this.executions.filter(e => e.startTime > Date.now() - 24 * 60 * 60 * 1000);
    const successRate = last24h.length > 0
      ? last24h.filter(e => e.status === 'success').length / last24h.length
      : 1;
    const totalCost = last24h.reduce((sum, e) => sum + e.cost, 0);

    return `📊 Last 24h: ${last24h.length} executions | ${Math.round(successRate * 100)}% success | $${totalCost.toFixed(2)} cost`;
  }
}
