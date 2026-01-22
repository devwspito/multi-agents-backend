/**
 * AnalyticsService - Agent Execution Analytics (In-Memory)
 */

export interface IAgentExecution {
  taskId: string;
  agentType: string;
  status: 'success' | 'failure' | 'retry';
  startedAt: Date;
  completedAt: Date;
  duration: number;
  cost: number;
  tokens: { input: number; output: number; cached: number; };
  errorMessage?: string;
  retryCount?: number;
  verificationPassed?: boolean;
  judgeScore?: number;
  metadata?: any;
}

export interface IAgentMetrics {
  agentType: string;
  period: 'hour' | 'day' | 'week' | 'month' | 'all';
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  retriedExecutions: number;
  successRate: number;
  averageCost: number;
  totalCost: number;
  averageDuration: number;
  averageTokens: number;
  averageJudgeScore?: number;
  verificationPassRate?: number;
  commonFailures: Array<{ error: string; count: number; }>;
  slowestExecutions: Array<{ taskId: string; duration: number; }>;
  mostExpensiveExecutions: Array<{ taskId: string; cost: number; }>;
}

export class AnalyticsService {
  private executions: IAgentExecution[] = [];

  async recordExecution(execution: IAgentExecution): Promise<void> {
    this.executions.push(execution);
    // Keep only last 10000 executions in memory
    if (this.executions.length > 10000) {
      this.executions = this.executions.slice(-10000);
    }
  }

  private getStartDate(period: 'hour' | 'day' | 'week' | 'month' | 'all'): Date | null {
    if (period === 'all') return null;
    const now = Date.now();
    const ms = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
    return new Date(now - ms[period]);
  }

  async getAgentMetrics(agentType: string, period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'): Promise<IAgentMetrics> {
    const startDate = this.getStartDate(period);
    const filtered = this.executions.filter(e => e.agentType === agentType && (!startDate || e.completedAt >= startDate));

    const total = filtered.length;
    const success = filtered.filter(e => e.status === 'success').length;
    const failed = filtered.filter(e => e.status === 'failure').length;
    const retried = filtered.filter(e => e.status === 'retry').length;
    const totalCost = filtered.reduce((s, e) => s + e.cost, 0);
    const totalDuration = filtered.reduce((s, e) => s + e.duration, 0);
    const totalTokens = filtered.reduce((s, e) => s + e.tokens.input + e.tokens.output, 0);

    const failureMap = new Map<string, number>();
    filtered.filter(e => e.errorMessage).forEach(e => failureMap.set(e.errorMessage!, (failureMap.get(e.errorMessage!) || 0) + 1));

    return {
      agentType,
      period,
      totalExecutions: total,
      successfulExecutions: success,
      failedExecutions: failed,
      retriedExecutions: retried,
      successRate: total > 0 ? (success / total) * 100 : 0,
      averageCost: total > 0 ? totalCost / total : 0,
      totalCost,
      averageDuration: total > 0 ? totalDuration / total : 0,
      averageTokens: total > 0 ? totalTokens / total : 0,
      commonFailures: Array.from(failureMap.entries()).map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count).slice(0, 5),
      slowestExecutions: [...filtered].sort((a, b) => b.duration - a.duration).slice(0, 5).map(e => ({ taskId: e.taskId, duration: e.duration })),
      mostExpensiveExecutions: [...filtered].sort((a, b) => b.cost - a.cost).slice(0, 5).map(e => ({ taskId: e.taskId, cost: e.cost })),
    };
  }

  async getAllAgentMetrics(period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'): Promise<IAgentMetrics[]> {
    const types = ['planning-agent', 'tech-lead', 'developer', 'judge', 'verification-fixer', 'recovery-analyst', 'auto-merge'];
    return Promise.all(types.map(t => this.getAgentMetrics(t, period)));
  }

  async getDashboard(period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'): Promise<{
    period: string; totalExecutions: number; totalCost: number; averageSuccessRate: number;
    agentMetrics: IAgentMetrics[]; topFailures: Array<{ error: string; count: number }>; recommendations: string[];
  }> {
    const allMetrics = await this.getAllAgentMetrics(period);
    const totalExecutions = allMetrics.reduce((s, m) => s + m.totalExecutions, 0);
    const totalCost = allMetrics.reduce((s, m) => s + m.totalCost, 0);
    const avgRate = allMetrics.length > 0 ? allMetrics.reduce((s, m) => s + m.successRate, 0) / allMetrics.length : 0;

    const allFailures = new Map<string, number>();
    allMetrics.forEach(m => m.commonFailures.forEach(f => allFailures.set(f.error, (allFailures.get(f.error) || 0) + f.count)));

    return {
      period,
      totalExecutions,
      totalCost,
      averageSuccessRate: avgRate,
      agentMetrics: allMetrics,
      topFailures: Array.from(allFailures.entries()).map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count).slice(0, 10),
      recommendations: avgRate < 70 ? ['Low success rate detected - investigate failures'] : ['All metrics look healthy'],
    };
  }

  async cleanupOldData(_daysToKeep: number = 90): Promise<number> { return 0; }
}

export const AgentExecutionModel = null; // Stub for compatibility
