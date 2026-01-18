import mongoose, { Schema, Document } from 'mongoose';

/**
 * Agent Execution Record
 */
export interface IAgentExecution {
  taskId: string;
  agentType: string;
  status: 'success' | 'failure' | 'retry';
  startedAt: Date;
  completedAt: Date;
  duration: number; // milliseconds
  cost: number; // USD
  tokens: {
    input: number;
    output: number;
    cached: number;
  };
  errorMessage?: string;
  retryCount?: number;
  verificationPassed?: boolean;
  judgeScore?: number;
  metadata?: any;
}

interface IAgentExecutionDocument extends IAgentExecution, Document {}

const AgentExecutionSchema = new Schema<IAgentExecutionDocument>(
  {
    taskId: { type: String, required: true, index: true },
    agentType: { type: String, required: true, index: true },
    status: { type: String, enum: ['success', 'failure', 'retry'], required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
    duration: { type: Number, required: true },
    cost: { type: Number, required: true },
    tokens: {
      input: { type: Number, required: true },
      output: { type: Number, required: true },
      cached: { type: Number, default: 0 },
    },
    errorMessage: { type: String },
    retryCount: { type: Number, default: 0 },
    verificationPassed: { type: Boolean },
    judgeScore: { type: Number },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

const AgentExecutionModel = mongoose.model<IAgentExecutionDocument>('AgentExecution', AgentExecutionSchema);

/**
 * Agent Metrics (aggregated)
 */
export interface IAgentMetrics {
  agentType: string;
  period: 'hour' | 'day' | 'week' | 'month' | 'all';
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  retriedExecutions: number;
  successRate: number; // percentage
  averageCost: number; // USD
  totalCost: number; // USD
  averageDuration: number; // milliseconds
  averageTokens: number;
  averageJudgeScore?: number;
  verificationPassRate?: number; // percentage
  commonFailures: Array<{
    error: string;
    count: number;
  }>;
  slowestExecutions: Array<{
    taskId: string;
    duration: number;
  }>;
  mostExpensiveExecutions: Array<{
    taskId: string;
    cost: number;
  }>;
}

/**
 * Analytics Service
 *
 * Implements continuous improvement best practice:
 * - Tracks agent performance metrics
 * - Analyzes failure patterns
 * - Identifies optimization opportunities
 * - Provides dashboards for monitoring
 */
export class AnalyticsService {
  /**
   * Record an agent execution
   */
  async recordExecution(execution: IAgentExecution): Promise<void> {
    try {
      await AgentExecutionModel.create(execution);
      // Commented - too verbose
      // console.log(`📊 [Analytics] Recorded execution: ${execution.agentType} (${execution.status})`);
    } catch (error: any) {
      console.error(`❌ [Analytics] Failed to record execution:`, error.message);
    }
  }

  /**
   * Get metrics for a specific agent type
   */
  async getAgentMetrics(
    agentType: string,
    period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'
  ): Promise<IAgentMetrics> {
    const startDate = this.getStartDate(period);

    const executions = await AgentExecutionModel.find({
      agentType,
      ...(startDate && { completedAt: { $gte: startDate } }),
    }).sort({ completedAt: -1 });

    const totalExecutions = executions.length;
    const successfulExecutions = executions.filter((e) => e.status === 'success').length;
    const failedExecutions = executions.filter((e) => e.status === 'failure').length;
    const retriedExecutions = executions.filter((e) => e.status === 'retry').length;

    const successRate = totalExecutions > 0 ? (successfulExecutions / totalExecutions) * 100 : 0;

    const totalCost = executions.reduce((sum, e) => sum + e.cost, 0);
    const averageCost = totalExecutions > 0 ? totalCost / totalExecutions : 0;

    const totalDuration = executions.reduce((sum, e) => sum + e.duration, 0);
    const averageDuration = totalExecutions > 0 ? totalDuration / totalExecutions : 0;

    const totalTokens = executions.reduce((sum, e) => sum + e.tokens.input + e.tokens.output, 0);
    const averageTokens = totalExecutions > 0 ? totalTokens / totalExecutions : 0;

    // Judge scores
    const judgeScores = executions.filter((e) => e.judgeScore !== undefined).map((e) => e.judgeScore!);
    const averageJudgeScore =
      judgeScores.length > 0 ? judgeScores.reduce((sum, s) => sum + s, 0) / judgeScores.length : undefined;

    // Verification pass rate
    const verifiedExecutions = executions.filter((e) => e.verificationPassed !== undefined);
    const passedVerifications = verifiedExecutions.filter((e) => e.verificationPassed === true).length;
    const verificationPassRate =
      verifiedExecutions.length > 0 ? (passedVerifications / verifiedExecutions.length) * 100 : undefined;

    // Common failures
    const failureMap = new Map<string, number>();
    executions
      .filter((e) => e.errorMessage)
      .forEach((e) => {
        const error = e.errorMessage!;
        failureMap.set(error, (failureMap.get(error) || 0) + 1);
      });

    const commonFailures = Array.from(failureMap.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Slowest executions
    const slowestExecutions = executions
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5)
      .map((e) => ({
        taskId: e.taskId,
        duration: e.duration,
      }));

    // Most expensive executions
    const mostExpensiveExecutions = executions
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 5)
      .map((e) => ({
        taskId: e.taskId,
        cost: e.cost,
      }));

    return {
      agentType,
      period,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      retriedExecutions,
      successRate,
      averageCost,
      totalCost,
      averageDuration,
      averageTokens,
      averageJudgeScore,
      verificationPassRate,
      commonFailures,
      slowestExecutions,
      mostExpensiveExecutions,
    };
  }

  /**
   * Get metrics for all agent types
   */
  async getAllAgentMetrics(period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'): Promise<IAgentMetrics[]> {
    const agentTypes = ['planning-agent', 'tech-lead', 'developer', 'judge', 'verification-fixer', 'recovery-analyst', 'auto-merge', 'story-merge-agent', 'git-flow-manager', 'conflict-resolver'];

    const metricsPromises = agentTypes.map((agentType) => this.getAgentMetrics(agentType, period));

    return Promise.all(metricsPromises);
  }

  /**
   * Get system-wide analytics dashboard
   */
  async getDashboard(period: 'hour' | 'day' | 'week' | 'month' | 'all' = 'day'): Promise<{
    period: string;
    totalExecutions: number;
    totalCost: number;
    averageSuccessRate: number;
    agentMetrics: IAgentMetrics[];
    topFailures: Array<{ error: string; count: number }>;
    recommendations: string[];
  }> {
    const allMetrics = await this.getAllAgentMetrics(period);

    const totalExecutions = allMetrics.reduce((sum, m) => sum + m.totalExecutions, 0);
    const totalCost = allMetrics.reduce((sum, m) => sum + m.totalCost, 0);
    const averageSuccessRate =
      allMetrics.length > 0
        ? allMetrics.reduce((sum, m) => sum + m.successRate, 0) / allMetrics.length
        : 0;

    // Aggregate all failures
    const allFailures = new Map<string, number>();
    allMetrics.forEach((metrics) => {
      metrics.commonFailures.forEach(({ error, count }) => {
        allFailures.set(error, (allFailures.get(error) || 0) + count);
      });
    });

    const topFailures = Array.from(allFailures.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Generate recommendations
    const recommendations = this.generateRecommendations(allMetrics, topFailures);

    return {
      period,
      totalExecutions,
      totalCost,
      averageSuccessRate,
      agentMetrics: allMetrics,
      topFailures,
      recommendations,
    };
  }

  /**
   * Generate optimization recommendations
   */
  private generateRecommendations(metrics: IAgentMetrics[], topFailures: Array<{ error: string; count: number }>): string[] {
    const recommendations: string[] = [];

    // Success rate recommendations
    metrics.forEach((m) => {
      if (m.successRate < 70) {
        recommendations.push(`⚠️ ${m.agentType}: Low success rate (${m.successRate.toFixed(1)}%) - investigate failures`);
      }
    });

    // Cost recommendations
    const highCostAgents = metrics.filter((m) => m.averageCost > 1.0);
    if (highCostAgents.length > 0) {
      recommendations.push(
        `💰 High cost agents: ${highCostAgents.map((m) => m.agentType).join(', ')} - consider optimizing prompts or using smaller models`
      );
    }

    // Duration recommendations
    const slowAgents = metrics.filter((m) => m.averageDuration > 120000); // 2 minutes
    if (slowAgents.length > 0) {
      recommendations.push(
        `🐢 Slow agents: ${slowAgents.map((m) => m.agentType).join(', ')} - average duration > 2 minutes`
      );
    }

    // Failure pattern recommendations
    if (topFailures.length > 0) {
      recommendations.push(`🔍 Top failure: "${topFailures[0].error}" (${topFailures[0].count} occurrences) - needs investigation`);
    }

    // Verification recommendations
    metrics.forEach((m) => {
      if (m.verificationPassRate !== undefined && m.verificationPassRate < 50) {
        recommendations.push(`❌ ${m.agentType}: Low verification pass rate (${m.verificationPassRate.toFixed(1)}%) - improve code quality`);
      }
    });

    // Judge score recommendations
    metrics.forEach((m) => {
      if (m.averageJudgeScore !== undefined && m.averageJudgeScore < 70) {
        recommendations.push(`📉 ${m.agentType}: Low judge score (${m.averageJudgeScore.toFixed(1)}) - review prompt instructions`);
      }
    });

    if (recommendations.length === 0) {
      recommendations.push('✅ All metrics look healthy!');
    }

    return recommendations;
  }

  /**
   * Get start date for period
   */
  private getStartDate(period: 'hour' | 'day' | 'week' | 'month' | 'all'): Date | null {
    if (period === 'all') return null;

    const now = new Date();
    switch (period) {
      case 'hour':
        return new Date(now.getTime() - 60 * 60 * 1000);
      case 'day':
        return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case 'week':
        return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case 'month':
        return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
  }

  /**
   * Clear old analytics data (cleanup)
   */
  async cleanupOldData(daysToKeep: number = 90): Promise<number> {
    const cutoffDate = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

    const result = await AgentExecutionModel.deleteMany({
      completedAt: { $lt: cutoffDate },
    });

    console.log(`🧹 [Analytics] Cleaned up ${result.deletedCount} old execution records`);

    return result.deletedCount || 0;
  }
}

// Export model for direct access if needed
export { AgentExecutionModel };
