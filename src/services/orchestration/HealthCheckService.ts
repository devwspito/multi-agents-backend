/**
 * HealthCheckService - System Health Monitoring and Auto-Recovery
 *
 * Provides:
 * - Periodic health checks for running tasks
 * - Auto-recovery for stuck/failed tasks
 * - Circuit breaker monitoring
 * - Resource usage tracking
 * - Alerting for critical issues
 *
 * 🔒 ROBUSTNESS: Designed to catch issues before they cause failures
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import db from '../../database/index.js';
import { NotificationService } from '../NotificationService';
import { unifiedMemoryService } from '../UnifiedMemoryService';
import {
  Result,
  ok,
  err,
  isOk,
  getCircuitBreakerStatus,
  validateWorkspacePath,
} from '../../utils/robustness';

// ============================================================================
// TYPES
// ============================================================================

export interface HealthStatus {
  healthy: boolean;
  timestamp: Date;
  checks: {
    database: CheckResult;
    filesystem: CheckResult;
    memory: CheckResult;
    circuitBreakers: CheckResult;
    runningTasks: CheckResult;
  };
  issues: HealthIssue[];
  recommendations: string[];
}

export interface CheckResult {
  status: 'ok' | 'warning' | 'error';
  message: string;
  details?: any;
}

export interface HealthIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  message: string;
  taskId?: string;
  suggestion: string;
}

export interface TaskHealthStatus {
  taskId: string;
  healthy: boolean;
  status: string;
  phase: string;
  lastUpdate: Date | null;
  stuckDuration: number | null; // ms since last update
  issues: string[];
  recoverable: boolean;
}

// ============================================================================
// SERVICE
// ============================================================================

class HealthCheckServiceImpl {
  private readonly workspaceDir: string;
  private lastHealthCheck: HealthStatus | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Thresholds
  private readonly STUCK_TASK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes without update
  private readonly MEMORY_WARNING_PERCENT = 80;
  private readonly MEMORY_CRITICAL_PERCENT = 95;
  private readonly DISK_WARNING_PERCENT = 85;
  private readonly DISK_CRITICAL_PERCENT = 95;

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
  }

  // ============================================================================
  // MAIN HEALTH CHECK
  // ============================================================================

  /**
   * Run comprehensive health check
   */
  async runHealthCheck(): Promise<HealthStatus> {
    const issues: HealthIssue[] = [];
    const recommendations: string[] = [];

    // Run all checks in parallel
    const [database, filesystem, memory, circuitBreakers, runningTasks] = await Promise.all([
      this.checkDatabase(),
      this.checkFilesystem(),
      this.checkMemory(),
      this.checkCircuitBreakers(),
      this.checkRunningTasks(),
    ]);

    // Collect issues from each check
    if (database.status === 'error') {
      issues.push({
        severity: 'critical',
        category: 'database',
        message: database.message,
        suggestion: 'Check SQLite database file and permissions',
      });
    }

    if (filesystem.status === 'error') {
      issues.push({
        severity: 'critical',
        category: 'filesystem',
        message: filesystem.message,
        suggestion: 'Check disk space and permissions',
      });
    } else if (filesystem.status === 'warning') {
      issues.push({
        severity: 'high',
        category: 'filesystem',
        message: filesystem.message,
        suggestion: 'Free up disk space soon',
      });
    }

    if (memory.status === 'error') {
      issues.push({
        severity: 'critical',
        category: 'memory',
        message: memory.message,
        suggestion: 'Restart service or reduce concurrent tasks',
      });
    } else if (memory.status === 'warning') {
      issues.push({
        severity: 'medium',
        category: 'memory',
        message: memory.message,
        suggestion: 'Consider reducing concurrent tasks',
      });
    }

    if (circuitBreakers.status === 'warning' || circuitBreakers.status === 'error') {
      issues.push({
        severity: circuitBreakers.status === 'error' ? 'high' : 'medium',
        category: 'circuit_breakers',
        message: circuitBreakers.message,
        suggestion: 'Check external service health (GitHub, Anthropic)',
      });
    }

    // Add task-specific issues
    if (runningTasks.details?.stuckTasks) {
      for (const stuckTask of runningTasks.details.stuckTasks) {
        issues.push({
          severity: 'high',
          category: 'stuck_task',
          message: `Task ${stuckTask.taskId} stuck for ${Math.round(stuckTask.stuckDuration / 60000)} minutes`,
          taskId: stuckTask.taskId,
          suggestion: 'Consider resuming or cancelling the task',
        });
      }
    }

    // Generate recommendations based on issues
    if (issues.some(i => i.category === 'memory' && i.severity === 'critical')) {
      recommendations.push('URGENT: Restart the service to free memory');
    }
    if (issues.some(i => i.category === 'stuck_task')) {
      recommendations.push('Review stuck tasks and decide whether to resume or cancel');
    }
    if (issues.some(i => i.category === 'circuit_breakers')) {
      recommendations.push('Wait for external services to recover before starting new tasks');
    }

    const healthy = issues.filter(i => i.severity === 'critical').length === 0;

    const status: HealthStatus = {
      healthy,
      timestamp: new Date(),
      checks: {
        database,
        filesystem,
        memory,
        circuitBreakers,
        runningTasks,
      },
      issues,
      recommendations,
    };

    this.lastHealthCheck = status;
    return status;
  }

  /**
   * Get last health check result without running a new check
   */
  getLastHealthCheck(): HealthStatus | null {
    return this.lastHealthCheck;
  }

  // ============================================================================
  // INDIVIDUAL CHECKS
  // ============================================================================

  private async checkDatabase(): Promise<CheckResult> {
    try {
      // SQLite is always "connected" if the db object exists
      // Verify with a simple query
      const result = db.prepare('SELECT 1 as test').get() as { test: number } | undefined;
      if (result && result.test === 1) {
        return { status: 'ok', message: 'SQLite database connected and responsive' };
      }
      return { status: 'error', message: 'SQLite database not responding' };
    } catch (error: any) {
      return { status: 'error', message: `SQLite error: ${error.message}` };
    }
  }

  private async checkFilesystem(): Promise<CheckResult> {
    try {
      // Check workspace directory exists and is writable
      if (!fs.existsSync(this.workspaceDir)) {
        return { status: 'error', message: `Workspace directory does not exist: ${this.workspaceDir}` };
      }

      // Test write access
      const testFile = path.join(this.workspaceDir, '.health-check-test');
      try {
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
      } catch (e: any) {
        return { status: 'error', message: `Workspace not writable: ${e.message}` };
      }

      // Check disk space (platform-specific)
      const diskUsage = this.getDiskUsage();
      if (diskUsage) {
        if (diskUsage.percentUsed >= this.DISK_CRITICAL_PERCENT) {
          return {
            status: 'error',
            message: `Disk almost full: ${diskUsage.percentUsed.toFixed(1)}% used`,
            details: diskUsage,
          };
        } else if (diskUsage.percentUsed >= this.DISK_WARNING_PERCENT) {
          return {
            status: 'warning',
            message: `Disk space low: ${diskUsage.percentUsed.toFixed(1)}% used`,
            details: diskUsage,
          };
        }
      }

      return { status: 'ok', message: 'Filesystem healthy' };
    } catch (error: any) {
      return { status: 'error', message: `Filesystem error: ${error.message}` };
    }
  }

  private checkMemory(): Promise<CheckResult> {
    return Promise.resolve(this.checkMemorySync());
  }

  private checkMemorySync(): CheckResult {
    try {
      const used = process.memoryUsage();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
      const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);

      const details = {
        heapUsedMB,
        heapTotalMB,
        systemUsedPercent: usedPercent.toFixed(1),
        rssMB: Math.round(used.rss / 1024 / 1024),
      };

      if (usedPercent >= this.MEMORY_CRITICAL_PERCENT) {
        return {
          status: 'error',
          message: `System memory critical: ${usedPercent.toFixed(1)}% used`,
          details,
        };
      } else if (usedPercent >= this.MEMORY_WARNING_PERCENT) {
        return {
          status: 'warning',
          message: `System memory high: ${usedPercent.toFixed(1)}% used`,
          details,
        };
      }

      return {
        status: 'ok',
        message: `Memory OK: Heap ${heapUsedMB}/${heapTotalMB}MB, System ${usedPercent.toFixed(1)}%`,
        details,
      };
    } catch (error: any) {
      return { status: 'error', message: `Memory check error: ${error.message}` };
    }
  }

  private async checkCircuitBreakers(): Promise<CheckResult> {
    // Check known circuit breakers
    const knownBreakers = ['anthropic-api', 'github-api', 'database-write'];
    const openBreakers: string[] = [];

    for (const name of knownBreakers) {
      const status = getCircuitBreakerStatus(name);
      if (status && status.state === 'open') {
        openBreakers.push(name);
      }
    }

    if (openBreakers.length > 0) {
      return {
        status: openBreakers.length >= 2 ? 'error' : 'warning',
        message: `Circuit breakers open: ${openBreakers.join(', ')}`,
        details: { openBreakers },
      };
    }

    return { status: 'ok', message: 'All circuit breakers closed' };
  }

  private async checkRunningTasks(): Promise<CheckResult> {
    try {
      const runningTasks = TaskRepository.findAll({ status: 'in_progress' });

      const now = Date.now();
      const stuckTasks: Array<{ taskId: string; stuckDuration: number }> = [];

      for (const task of runningTasks) {
        // Use task updatedAt since orchestration may not have lastUpdatedAt
        const lastUpdate = task.updatedAt;
        if (lastUpdate) {
          const stuckDuration = now - new Date(lastUpdate).getTime();
          if (stuckDuration > this.STUCK_TASK_THRESHOLD_MS) {
            stuckTasks.push({
              taskId: task.id,
              stuckDuration,
            });
          }
        }
      }

      const details = {
        total: runningTasks.length,
        stuckTasks,
      };

      if (stuckTasks.length > 0) {
        return {
          status: 'warning',
          message: `${stuckTasks.length} task(s) appear stuck`,
          details,
        };
      }

      return {
        status: 'ok',
        message: `${runningTasks.length} task(s) running`,
        details,
      };
    } catch (error: any) {
      return { status: 'error', message: `Task check error: ${error.message}` };
    }
  }

  // ============================================================================
  // TASK-SPECIFIC HEALTH CHECK
  // ============================================================================

  /**
   * Check health of a specific task
   */
  async checkTaskHealth(taskId: string): Promise<TaskHealthStatus> {
    try {
      const task = TaskRepository.findById(taskId);
      if (!task) {
        return {
          taskId,
          healthy: false,
          status: 'not_found',
          phase: 'unknown',
          lastUpdate: null,
          stuckDuration: null,
          issues: ['Task not found in database'],
          recoverable: false,
        };
      }

      const issues: string[] = [];
      let recoverable = true;

      // Check last update time
      const lastUpdate = (task.orchestration as any)?.lastUpdatedAt || task.updatedAt;
      const stuckDuration = lastUpdate ? Date.now() - new Date(lastUpdate).getTime() : null;

      if (stuckDuration && stuckDuration > this.STUCK_TASK_THRESHOLD_MS) {
        issues.push(`No updates for ${Math.round(stuckDuration / 60000)} minutes`);
      }

      // Check workspace exists
      const workspacePath = path.join(this.workspaceDir, `task-${taskId}`);
      const workspaceValidation = validateWorkspacePath(workspacePath);
      if (!isOk(workspaceValidation)) {
        issues.push(`Workspace invalid: ${workspaceValidation.message}`);
        // Still might be recoverable if we can recreate workspace
      }

      // Check unified memory has execution map
      const executionMap = await unifiedMemoryService.getExecutionMap(taskId);
      if (!executionMap) {
        issues.push('No execution map found in unified memory');
        // Might still be recoverable from MongoDB or events
      }

      // Check for error state
      if (task.status === 'failed') {
        issues.push('Task is in failed state');
      }

      // Determine if recoverable
      if (task.status === 'cancelled') {
        recoverable = false;
        issues.push('Task was cancelled');
      }

      return {
        taskId,
        healthy: issues.length === 0,
        status: task.status,
        phase: (task.orchestration as any)?.currentPhase || 'unknown',
        lastUpdate: lastUpdate ? new Date(lastUpdate) : null,
        stuckDuration,
        issues,
        recoverable,
      };
    } catch (error: any) {
      return {
        taskId,
        healthy: false,
        status: 'error',
        phase: 'unknown',
        lastUpdate: null,
        stuckDuration: null,
        issues: [`Health check error: ${error.message}`],
        recoverable: true,
      };
    }
  }

  // ============================================================================
  // AUTO-RECOVERY
  // ============================================================================

  /**
   * Attempt auto-recovery for stuck tasks
   */
  async attemptAutoRecovery(taskId: string): Promise<Result<void>> {
    console.log(`🔧 [HealthCheck] Attempting auto-recovery for task ${taskId}`);

    const healthStatus = await this.checkTaskHealth(taskId);

    if (!healthStatus.recoverable) {
      return err(new Error('Task is not recoverable'), `Task ${taskId} cannot be auto-recovered`);
    }

    try {
      // Try to resume using OrchestrationRecoveryService
      const { OrchestrationRecoveryService } = await import('./OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      const result = await recoveryService.resumeFailedTask(taskId);

      if (result.success) {
        console.log(`✅ [HealthCheck] Auto-recovery initiated for task ${taskId}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          '🔧 Auto-recovery initiated by health check'
        );
        return ok(undefined);
      } else {
        return err(new Error(result.message), result.message);
      }
    } catch (error: any) {
      console.error(`❌ [HealthCheck] Auto-recovery failed for task ${taskId}:`, error.message);
      return err(error, `Auto-recovery failed: ${error.message}`);
    }
  }

  // ============================================================================
  // PERIODIC MONITORING
  // ============================================================================

  /**
   * Start periodic health monitoring
   */
  startPeriodicMonitoring(intervalMs: number = 60000): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    console.log(`🏥 [HealthCheck] Starting periodic monitoring (interval: ${intervalMs}ms)`);

    this.healthCheckInterval = setInterval(async () => {
      try {
        const health = await this.runHealthCheck();

        // Log critical issues
        const criticalIssues = health.issues.filter(i => i.severity === 'critical');
        if (criticalIssues.length > 0) {
          console.error(`🚨 [HealthCheck] ${criticalIssues.length} CRITICAL issues detected!`);
          criticalIssues.forEach(issue => {
            console.error(`   ❌ ${issue.category}: ${issue.message}`);
          });
        }

        // 🚫 AUTO-RECOVERY DISABLED BY DESIGN
        // Stuck tasks are logged but NOT automatically recovered
        // User must manually resume via frontend or API
        const stuckTasks = health.checks.runningTasks.details?.stuckTasks || [];
        if (stuckTasks.length > 0) {
          console.log(`⚠️  [HealthCheck] ${stuckTasks.length} stuck task(s) detected - manual resume required`);
          stuckTasks.forEach((t: { taskId: string; stuckDuration: number }) => {
            console.log(`   📌 Task ${t.taskId} stuck for ${Math.round(t.stuckDuration / 60000)} minutes`);
          });
        }
      } catch (error: any) {
        console.error(`❌ [HealthCheck] Monitoring error:`, error.message);
      }
    }, intervalMs);
  }

  /**
   * Stop periodic monitoring
   */
  stopPeriodicMonitoring(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      console.log(`🏥 [HealthCheck] Periodic monitoring stopped`);
    }
  }

  // ============================================================================
  // HELPERS
  // ============================================================================

  private getDiskUsage(): { total: number; free: number; percentUsed: number } | null {
    try {
      // This is platform-specific and may not work on all systems
      const stats = fs.statfsSync?.(this.workspaceDir);
      if (stats) {
        const total = stats.bsize * stats.blocks;
        const free = stats.bsize * stats.bfree;
        const used = total - free;
        return {
          total,
          free,
          percentUsed: (used / total) * 100,
        };
      }
    } catch {
      // statfsSync not available on this platform
    }
    return null;
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const healthCheckService = new HealthCheckServiceImpl();
