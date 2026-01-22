/**
 * Cost Budget Service
 *
 * Implements Anthropic's best practice for monitoring and limiting
 * costs in multi-agent orchestration to prevent runaway expenses.
 */

import { ITask } from '../../database/repositories/TaskRepository.js';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

export interface CostBudgetConfig {
  maxTaskCostUSD: number;
  maxPhaseCostUSD: number;
  warningThreshold: number; // 0.0 to 1.0 (e.g., 0.8 = 80%)
  enableHardStop: boolean;
}

export class CostBudgetService {
  // 🔥 IMPORTANT: Per-task configuration to support parallel task execution
  // Each task can have different budget limits without interference
  private static taskConfigs: Map<string, CostBudgetConfig> = new Map();

  // Default configuration for tasks without specific config
  private static defaultConfig: CostBudgetConfig = {
    maxTaskCostUSD: parseFloat(process.env.MAX_TASK_COST_USD || '1000.0'), // Increased from $10 to $1000
    maxPhaseCostUSD: parseFloat(process.env.MAX_PHASE_COST_USD || '200.0'), // Increased from $2 to $200
    warningThreshold: parseFloat(process.env.COST_WARNING_THRESHOLD || '0.8'),
    enableHardStop: process.env.ENABLE_COST_HARD_STOP === 'true',
  };

  /**
   * Get configuration for a specific task
   */
  private static getConfigForTask(taskId: string): CostBudgetConfig {
    return this.taskConfigs.get(taskId) || this.defaultConfig;
  }

  /**
   * Set custom configuration for a specific task
   */
  static setTaskConfig(taskId: string, config: Partial<CostBudgetConfig>): void {
    const currentConfig = this.getConfigForTask(taskId);
    this.taskConfigs.set(taskId, { ...currentConfig, ...config });
  }

  /**
   * Clean up configuration when task is completed
   */
  static cleanupTaskConfig(taskId: string): void {
    this.taskConfigs.delete(taskId);
  }

  /**
   * Check if task is within budget before executing a phase
   */
  static async checkBudgetBeforePhase(
    task: ITask,
    phaseName: string,
    estimatedPhaseCost?: number
  ): Promise<{ allowed: boolean; reason?: string; warning?: string }> {
    const taskId = (task.id as any).toString();
    const config = this.getConfigForTask(taskId);
    const currentCost = task.orchestration.totalCost || 0;

    // Check if task has already exceeded budget
    if (currentCost >= config.maxTaskCostUSD) {
      const message = `Task budget exceeded: $${currentCost.toFixed(2)} >= $${config.maxTaskCostUSD.toFixed(2)}`;

      await LogService.error(message, {
        taskId,
        category: 'orchestration',
        phase: phaseName as any,
        metadata: {
          currentCost,
          maxCost: config.maxTaskCostUSD,
        },
      });

      if (config.enableHardStop) {
        return { allowed: false, reason: message };
      } else {
        return { allowed: true, warning: message };
      }
    }

    // Check if phase would exceed budget (if estimate provided)
    if (estimatedPhaseCost) {
      const projectedCost = currentCost + estimatedPhaseCost;

      if (projectedCost > config.maxTaskCostUSD) {
        const message = `Phase would exceed budget: $${projectedCost.toFixed(2)} > $${config.maxTaskCostUSD.toFixed(2)}`;

        if (config.enableHardStop) {
          return { allowed: false, reason: message };
        } else {
          return { allowed: true, warning: message };
        }
      }
    }

    // Check warning threshold
    const usagePercentage = currentCost / config.maxTaskCostUSD;

    if (usagePercentage >= config.warningThreshold) {
      const warning = `Cost warning: ${(usagePercentage * 100).toFixed(1)}% of budget used ($${currentCost.toFixed(2)}/$${config.maxTaskCostUSD.toFixed(2)})`;

      NotificationService.emitConsoleLog(
        taskId,
        'warn',
        `⚠️ ${warning}`
      );

      await LogService.warn(warning, {
        taskId,
        category: 'orchestration',
        phase: phaseName as any,
        metadata: {
          currentCost,
          maxCost: config.maxTaskCostUSD,
          usagePercentage,
        },
      });

      return { allowed: true, warning };
    }

    return { allowed: true };
  }

  /**
   * Check if individual phase cost is within limits
   */
  static checkPhaseCost(phaseCost: number, phaseName: string, taskId: string): boolean {
    const config = this.getConfigForTask(taskId);
    if (phaseCost > config.maxPhaseCostUSD) {
      console.warn(
        `⚠️ Phase ${phaseName} exceeded individual limit: $${phaseCost.toFixed(2)} > $${config.maxPhaseCostUSD.toFixed(2)}`
      );
      return false;
    }
    return true;
  }

  /**
   * Get cost estimates for different agent types
   * Based on typical token usage patterns
   */
  static getPhaseEstimate(phaseName: string): number {
    // Active phases only (legacy ProductManager, ProjectManager, QA, Fixer removed)
    const estimates: Record<string, number> = {
      'Planning': 0.25,           // ~50k tokens typical (unified planning)
      'TechLead': 0.25,           // ~50k tokens typical
      'Developer': 0.30,          // ~60k tokens typical
      'Judge': 0.10,              // ~20k tokens typical
      'TeamOrchestration': 50.00, // Multiple agents running in parallel
      'AutoMerge': 0.05,          // ~10k tokens typical
    };

    return estimates[phaseName] || 0.25; // Default estimate
  }

  /**
   * Calculate remaining budget
   */
  static getRemainingBudget(task: ITask): number {
    const taskId = (task.id as any).toString();
    const config = this.getConfigForTask(taskId);
    const currentCost = task.orchestration.totalCost || 0;
    return Math.max(0, config.maxTaskCostUSD - currentCost);
  }

  /**
   * Get budget status for UI display
   */
  static getBudgetStatus(task: ITask): {
    used: number;
    limit: number;
    percentage: number;
    status: 'healthy' | 'warning' | 'critical' | 'exceeded';
    remainingUSD: number;
  } {
    const taskId = (task.id as any).toString();
    const config = this.getConfigForTask(taskId);
    const used = task.orchestration.totalCost || 0;
    const limit = config.maxTaskCostUSD;
    const percentage = (used / limit) * 100;

    let status: 'healthy' | 'warning' | 'critical' | 'exceeded';

    if (percentage >= 100) {
      status = 'exceeded';
    } else if (percentage >= 90) {
      status = 'critical';
    } else if (percentage >= config.warningThreshold * 100) {
      status = 'warning';
    } else {
      status = 'healthy';
    }

    return {
      used,
      limit,
      percentage: Math.min(100, percentage),
      status,
      remainingUSD: Math.max(0, limit - used),
    };
  }

  /**
   * Update configuration for ALL tasks (updates the default)
   */
  static updateDefaultConfig(updates: Partial<CostBudgetConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...updates };
    console.log('💰 Default cost budget configuration updated:', this.defaultConfig);
  }

  /**
   * Get default configuration
   */
  static getDefaultConfig(): CostBudgetConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Format cost for display
   */
  static formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Emit budget notification to frontend
   */
  static async emitBudgetUpdate(task: ITask): Promise<void> {
    const taskId = (task.id as any).toString();
    const status = this.getBudgetStatus(task);

    NotificationService.emitNotification(taskId, 'budget_update', {
      ...status,
      message: `Cost: ${this.formatCost(status.used)} / ${this.formatCost(status.limit)}`,
    });

    // Log significant milestones
    if (status.percentage >= 100) {
      await LogService.error(`Task exceeded budget: ${this.formatCost(status.used)}`, {
        taskId,
        category: 'orchestration',
        metadata: status,
      });
    } else if (status.percentage >= 80) {
      await LogService.warn(`Task at ${status.percentage.toFixed(1)}% of budget`, {
        taskId,
        category: 'orchestration',
        metadata: status,
      });
    }
  }
}