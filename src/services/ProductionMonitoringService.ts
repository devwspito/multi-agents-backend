/**
 * Production Monitoring Service
 *
 * Tracks key metrics for a $5000/month production service:
 * - Cost tracking with alerts
 * - Task success/failure rates
 * - Service health monitoring
 * - Circuit breaker for external services
 */

import { Task } from '../models/Task';
import { NotificationService } from './NotificationService';
import { LogService } from './logging/LogService';

interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  lastCheck: Date;
  consecutiveFailures: number;
  circuitOpen: boolean;
}

interface DailyMetrics {
  date: string;
  tasksStarted: number;
  tasksCompleted: number;
  tasksFailed: number;
  totalCostUSD: number;
  avgTaskCostUSD: number;
  avgTaskDurationMinutes: number;
}

interface CostAlert {
  type: 'daily_limit' | 'task_limit' | 'spike_detected';
  threshold: number;
  current: number;
  message: string;
  timestamp: Date;
}

class ProductionMonitoringService {
  private serviceHealth: Map<string, ServiceHealth> = new Map();
  private costAlerts: CostAlert[] = [];
  private dailyMetricsCache: DailyMetrics | null = null;
  private dailyMetricsCacheTime: Date | null = null;

  // Configuration
  private readonly DAILY_COST_LIMIT = parseFloat(process.env.DAILY_COST_LIMIT_USD || '500');
  private readonly TASK_COST_LIMIT = parseFloat(process.env.MAX_COST_PER_TASK || '50');
  private readonly CIRCUIT_BREAKER_THRESHOLD = 3; // failures before opening circuit

  constructor() {
    // Initialize service health tracking
    const services = ['mongodb', 'redis', 'firebase', 'anthropic', 'voyage', 'github'];
    services.forEach(name => {
      this.serviceHealth.set(name, {
        name,
        status: 'healthy',
        lastCheck: new Date(),
        consecutiveFailures: 0,
        circuitOpen: false,
      });
    });

    // Start periodic monitoring
    this.startPeriodicMonitoring();
  }

  /**
   * Start periodic monitoring tasks
   */
  private startPeriodicMonitoring(): void {
    // Check daily costs every 5 minutes
    setInterval(() => this.checkDailyCosts(), 5 * 60 * 1000);

    // Check for stuck tasks every 10 minutes
    setInterval(() => this.checkStuckTasks(), 10 * 60 * 1000);

    console.log('📊 [Monitoring] Production monitoring started');
  }

  /**
   * Record a service check result
   */
  recordServiceCheck(serviceName: string, success: boolean, _latencyMs?: number): void {
    const health = this.serviceHealth.get(serviceName);
    if (!health) return;

    health.lastCheck = new Date();

    if (success) {
      health.consecutiveFailures = 0;
      health.status = 'healthy';

      // Reset circuit breaker if it was open
      if (health.circuitOpen) {
        health.circuitOpen = false;
        console.log(`✅ [Circuit Breaker] ${serviceName} circuit CLOSED - service recovered`);
      }
    } else {
      health.consecutiveFailures++;

      if (health.consecutiveFailures >= this.CIRCUIT_BREAKER_THRESHOLD) {
        health.status = 'down';
        if (!health.circuitOpen) {
          health.circuitOpen = true;
          console.error(`🔴 [Circuit Breaker] ${serviceName} circuit OPENED after ${health.consecutiveFailures} failures`);

          // Log critical error
          LogService.error(`Circuit breaker opened for ${serviceName}`, {
            taskId: 'system',
            category: 'system',
            metadata: {
              service: serviceName,
              consecutiveFailures: health.consecutiveFailures,
            },
          });
        }
      } else {
        health.status = 'degraded';
      }
    }

    this.serviceHealth.set(serviceName, health);
  }

  /**
   * Check if a service circuit is open (should skip calls)
   */
  isCircuitOpen(serviceName: string): boolean {
    const health = this.serviceHealth.get(serviceName);
    return health?.circuitOpen ?? false;
  }

  /**
   * Check daily costs and emit alerts
   */
  private async checkDailyCosts(): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const result = await Task.aggregate([
        {
          $match: {
            createdAt: { $gte: today },
          },
        },
        {
          $group: {
            _id: null,
            totalCost: { $sum: '$orchestration.totalCost' },
            taskCount: { $sum: 1 },
          },
        },
      ]);

      const dailyCost = result[0]?.totalCost || 0;
      const taskCount = result[0]?.taskCount || 0;

      // Check daily limit
      if (dailyCost >= this.DAILY_COST_LIMIT * 0.8) {
        const alert: CostAlert = {
          type: 'daily_limit',
          threshold: this.DAILY_COST_LIMIT,
          current: dailyCost,
          message: `Daily cost at ${((dailyCost / this.DAILY_COST_LIMIT) * 100).toFixed(1)}% of limit`,
          timestamp: new Date(),
        };
        this.costAlerts.push(alert);

        console.warn(`⚠️ [Cost Alert] Daily spending: $${dailyCost.toFixed(2)} / $${this.DAILY_COST_LIMIT.toFixed(2)}`);

        if (dailyCost >= this.DAILY_COST_LIMIT) {
          await LogService.error('Daily cost limit exceeded', {
            taskId: 'system',
            category: 'system',
            metadata: { dailyCost, limit: this.DAILY_COST_LIMIT, taskCount },
          });
        }
      }

      // Update cache
      this.dailyMetricsCache = {
        date: today.toISOString().split('T')[0],
        tasksStarted: taskCount,
        tasksCompleted: 0, // Would need separate query
        tasksFailed: 0,
        totalCostUSD: dailyCost,
        avgTaskCostUSD: taskCount > 0 ? dailyCost / taskCount : 0,
        avgTaskDurationMinutes: 0,
      };
      this.dailyMetricsCacheTime = new Date();
    } catch (error: any) {
      console.error('❌ [Monitoring] Failed to check daily costs:', error.message);
    }
  }

  /**
   * Check for stuck tasks (in_progress for too long)
   */
  private async checkStuckTasks(): Promise<void> {
    try {
      const stuckThreshold = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours

      const stuckTasks = await Task.find({
        status: 'in_progress',
        updatedAt: { $lt: stuckThreshold },
      }).select('_id title updatedAt').lean();

      if (stuckTasks.length > 0) {
        console.warn(`⚠️ [Monitoring] Found ${stuckTasks.length} potentially stuck task(s)`);

        for (const task of stuckTasks) {
          const hoursStuck = Math.floor((Date.now() - new Date(task.updatedAt).getTime()) / (60 * 60 * 1000));
          console.warn(`   - Task ${task._id}: "${task.title}" (stuck for ${hoursStuck}h)`);

          NotificationService.emitConsoleLog(
            (task._id as any).toString(),
            'warn',
            `⚠️ Task appears stuck (no update for ${hoursStuck}h)`
          );
        }
      }
    } catch (error: any) {
      console.error('❌ [Monitoring] Failed to check stuck tasks:', error.message);
    }
  }

  /**
   * Record task cost and check for alerts
   */
  async recordTaskCost(taskId: string, cost: number, phaseName: string): Promise<void> {
    // Check individual task limit
    if (cost >= this.TASK_COST_LIMIT * 0.8) {
      console.warn(`⚠️ [Cost Alert] Task ${taskId} at $${cost.toFixed(2)} (${((cost / this.TASK_COST_LIMIT) * 100).toFixed(1)}% of limit)`);
    }

    // Log for analytics
    await LogService.info(`Task cost: $${cost.toFixed(4)}`, {
      taskId,
      category: 'orchestration',
      phase: phaseName as any,
      metadata: { cost, limit: this.TASK_COST_LIMIT },
    });
  }

  /**
   * Get current metrics summary
   */
  async getMetricsSummary(): Promise<{
    services: Record<string, ServiceHealth>;
    costs: { daily: number; limit: number; percentage: number };
    alerts: CostAlert[];
    uptime: number;
  }> {
    // Ensure fresh daily metrics
    if (!this.dailyMetricsCacheTime || Date.now() - this.dailyMetricsCacheTime.getTime() > 60000) {
      await this.checkDailyCosts();
    }

    const services: Record<string, ServiceHealth> = {};
    this.serviceHealth.forEach((health, name) => {
      services[name] = health;
    });

    return {
      services,
      costs: {
        daily: this.dailyMetricsCache?.totalCostUSD || 0,
        limit: this.DAILY_COST_LIMIT,
        percentage: ((this.dailyMetricsCache?.totalCostUSD || 0) / this.DAILY_COST_LIMIT) * 100,
      },
      alerts: this.costAlerts.slice(-10), // Last 10 alerts
      uptime: process.uptime(),
    };
  }

  /**
   * Get service health for all services
   */
  getAllServiceHealth(): Map<string, ServiceHealth> {
    return new Map(this.serviceHealth);
  }

  /**
   * Clear old alerts (older than 24h)
   */
  cleanupOldAlerts(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.costAlerts = this.costAlerts.filter(a => a.timestamp.getTime() > cutoff);
  }
}

// Singleton instance
export const productionMonitoring = new ProductionMonitoringService();
export default productionMonitoring;
