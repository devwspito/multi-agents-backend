/**
 * PhaseRunner - Simplified phase execution helper
 *
 * Extracts common pre-execution and post-execution logic from OrchestrationCoordinator:
 * - Budget checking
 * - Directive injection
 * - Skip checking (via SkipLogicHelper)
 * - Unified memory updates
 * - Error handling and recovery
 *
 * This provides the benefits of PhaseExecutor extraction without the risk
 * of refactoring the entire orchestration loop.
 */

import { IPhase, PhaseResult, OrchestrationContext } from '../Phase';
import { CostBudgetService } from '../CostBudgetService';
import { RetryService } from '../RetryService';
import { unifiedMemoryService } from '../../UnifiedMemoryService';
import { NotificationService } from '../../NotificationService';
import { Task, ITask } from '../../../models/Task';
// Logging helpers are used inline to avoid circular dependencies
import { checkPhaseSkip, SkipCheckResult } from './SkipLogicHelper';

/**
 * Result of phase execution with metadata
 */
export interface PhaseRunResult {
  result: PhaseResult;
  skipped: boolean;
  skipReason?: string;
  duration: number;
  budgetWarning?: string;
}

/**
 * Options for running a phase
 */
export interface PhaseRunOptions {
  /** Phase name for logging */
  phaseName: string;

  /** Task ID for tracking */
  taskId: string;

  /** Max retries for transient failures */
  maxRetries?: number;

  /** Callback when retry happens */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;

  /** Skip unified memory check (for phases that handle it internally) */
  skipMemoryCheck?: boolean;

  /** Skip budget check */
  skipBudgetCheck?: boolean;
}

/**
 * Pre-execution checks and setup
 *
 * Runs before phase.execute():
 * 1. Budget check
 * 2. Directive injection
 * 3. Skip check (unified memory)
 *
 * @returns null if should proceed, or result if should skip/stop
 */
export async function preExecutionChecks(
  task: ITask,
  context: OrchestrationContext,
  options: PhaseRunOptions
): Promise<{ shouldProceed: boolean; skipResult?: SkipCheckResult; budgetWarning?: string }> {
  const { phaseName, taskId, skipMemoryCheck, skipBudgetCheck } = options;

  // 1. Budget check
  let budgetWarning: string | undefined;
  if (!skipBudgetCheck) {
    const budgetCheck = await CostBudgetService.checkBudgetBeforePhase(
      task,
      phaseName,
      CostBudgetService.getPhaseEstimate(phaseName)
    );

    if (!budgetCheck.allowed) {
      console.error(`❌ [BUDGET] ${budgetCheck.reason}`);
      NotificationService.emitConsoleLog(taskId, 'error', `❌ ${budgetCheck.reason}`);
      throw new Error(budgetCheck.reason);
    }

    if (budgetCheck.warning) {
      budgetWarning = budgetCheck.warning;
      console.warn(`⚠️ [BUDGET] ${budgetCheck.warning}`);
      NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ ${budgetCheck.warning}`);
    }
  }

  // 2. Skip check from unified memory
  if (!skipMemoryCheck) {
    const skipResult = await checkPhaseSkip(context, { phaseName });

    if (skipResult.shouldSkip) {
      return { shouldProceed: false, skipResult, budgetWarning };
    }
  }

  return { shouldProceed: true, budgetWarning };
}

/**
 * Post-execution updates
 *
 * Runs after phase.execute():
 * 1. Update unified memory (completed/failed)
 * 2. Emit notifications
 * 3. Handle approval requests
 */
export async function postExecutionUpdates(
  result: PhaseResult,
  taskId: string,
  phaseName: string
): Promise<void> {
  if (!result.success) {
    // Phase failed
    await unifiedMemoryService.markPhaseFailed(taskId, phaseName, result.error || 'Unknown error');
    NotificationService.emitConsoleLog(taskId, 'error', `❌ Phase ${phaseName} failed: ${result.error}`);
    return;
  }

  if (result.needsApproval) {
    // Phase needs approval
    await unifiedMemoryService.markPhaseWaitingApproval(taskId, phaseName);
    console.log(`⏸️  [${phaseName}] Paused - waiting for human approval`);
    NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Phase ${phaseName} paused - waiting for human approval`);
    return;
  }

  // Phase succeeded
  const wasSkipped = result.warnings?.includes('Phase was skipped');

  if (!wasSkipped) {
    await unifiedMemoryService.markPhaseCompleted(taskId, phaseName, result.data);
    console.log(`✅ [${phaseName}] Completed successfully`);
    NotificationService.emitConsoleLog(taskId, 'info', `✅ Phase ${phaseName} completed successfully`);
  } else {
    console.log(`⏭️  [${phaseName}] Skipped`);
    NotificationService.emitConsoleLog(taskId, 'info', `⏭️  Phase ${phaseName} skipped`);
  }
}

/**
 * Run a phase with standard handling
 *
 * Wraps phase execution with:
 * - Pre-execution checks (budget, directives, skip)
 * - Retry logic for transient failures
 * - Post-execution updates (memory, notifications)
 * - Error handling
 *
 * @example
 * ```typescript
 * const runResult = await runPhase(phase, context, {
 *   phaseName: 'Planning',
 *   taskId: task._id.toString(),
 * });
 *
 * if (runResult.skipped) {
 *   continue; // Next phase
 * }
 *
 * if (!runResult.result.success) {
 *   return; // Stop orchestration
 * }
 * ```
 */
export async function runPhase(
  phase: IPhase,
  context: OrchestrationContext,
  options: PhaseRunOptions
): Promise<PhaseRunResult> {
  const { phaseName, taskId, maxRetries = 3, onRetry } = options;
  const startTime = Date.now();

  // 1. Pre-execution checks
  const preCheck = await preExecutionChecks(context.task, context, options);

  if (!preCheck.shouldProceed) {
    return {
      result: {
        success: true,
        phaseName,
        data: null,
        duration: Date.now() - startTime,
        warnings: ['Phase was skipped'],
      },
      skipped: true,
      skipReason: preCheck.skipResult?.reason,
      duration: Date.now() - startTime,
      budgetWarning: preCheck.budgetWarning,
    };
  }

  // 2. Mark phase as started in unified memory
  await unifiedMemoryService.markPhaseStarted(taskId, phaseName);
  NotificationService.emitConsoleLog(taskId, 'info', `🚀 Starting phase: ${phaseName}`);

  // 3. Execute phase with retry logic
  let result: PhaseResult;
  try {
    result = await RetryService.executeWithRetry(
      () => phase.execute(context),
      {
        maxRetries,
        onRetry: (attempt, error, delayMs) => {
          console.warn(`⚠️ [${phaseName}] Retry attempt ${attempt} after ${delayMs}ms. Error: ${error.message}`);
          if (onRetry) {
            onRetry(attempt, error, delayMs);
          }
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️ Retrying ${phaseName} (attempt ${attempt}) after transient error: ${error.message}`
          );
        },
      }
    );
  } catch (error: any) {
    result = {
      success: false,
      phaseName,
      data: null,
      error: error.message,
      duration: Date.now() - startTime,
    };
  }

  const duration = Date.now() - startTime;
  result.duration = duration;

  // 4. Post-execution updates
  await postExecutionUpdates(result, taskId, phaseName);

  return {
    result,
    skipped: false,
    duration,
    budgetWarning: preCheck.budgetWarning,
  };
}

/**
 * Check if orchestration should stop (pause/cancel requested)
 */
export async function shouldStopOrchestration(taskId: string): Promise<{
  stop: boolean;
  reason?: 'paused' | 'cancelled';
}> {
  const task = await Task.findById(taskId);
  if (!task) {
    return { stop: true, reason: 'cancelled' };
  }

  if (task.orchestration.paused) {
    console.log(`⏸️  [Orchestration] Task paused by user`);
    NotificationService.emitConsoleLog(taskId, 'warn', `⏸️  Orchestration paused by user`);
    return { stop: true, reason: 'paused' };
  }

  if (task.orchestration.cancelRequested) {
    console.log(`🛑 [Orchestration] Task cancellation requested`);
    return { stop: true, reason: 'cancelled' };
  }

  return { stop: false };
}

/**
 * Handle task cancellation
 */
export async function handleCancellation(taskId: string): Promise<void> {
  await Task.findByIdAndUpdate(taskId, {
    $set: {
      status: 'cancelled',
      'orchestration.currentPhase': 'completed',
      'orchestration.cancelledAt': new Date(),
    },
  });

  NotificationService.emitConsoleLog(taskId, 'error', `🛑 Task cancelled by user`);
  NotificationService.emitTaskFailed(taskId, { error: 'Task cancelled by user' });

  // Cleanup resources
  CostBudgetService.cleanupTaskConfig(taskId);
  const { approvalEvents } = await import('../../ApprovalEvents');
  approvalEvents.cleanupTask(taskId);

  console.log(`🧹 Cleaned up resources for cancelled task ${taskId}`);
}

/**
 * Sync skipped phase to MongoDB
 *
 * When a phase is skipped via unified memory, sync to MongoDB for
 * downstream phases that validate via MongoDB.
 */
export async function syncSkippedPhaseToDb(taskId: string, phaseName: string): Promise<void> {
  // Map phase names to MongoDB field paths
  const phaseFieldMap: Record<string, string> = {
    Planning: 'orchestration.planning',
    Approval: 'orchestration.approval',
    TechLead: 'orchestration.techLead',
    TeamOrchestration: 'orchestration.teamOrchestration',
    Development: 'orchestration.development',
    Developers: 'orchestration.development',
    Judge: 'orchestration.judge',
    AutoMerge: 'orchestration.autoMerge',
    Merge: 'orchestration.merge',
    Verification: 'orchestration.verification',
  };

  const fieldPath = phaseFieldMap[phaseName];
  if (!fieldPath) {
    console.log(`   ℹ️ No MongoDB field mapping for phase: ${phaseName}`);
    return;
  }

  try {
    const updateObj: Record<string, any> = {};
    updateObj[`${fieldPath}.status`] = 'completed';
    updateObj[`${fieldPath}.skippedOnRecovery`] = true;
    updateObj[`${fieldPath}.skippedAt`] = new Date();

    await Task.findByIdAndUpdate(taskId, { $set: updateObj });

    console.log(`   ✅ [${phaseName}] Synced skipped phase to MongoDB: ${fieldPath}.status = 'completed'`);
  } catch (error: any) {
    console.warn(`   ⚠️ [${phaseName}] Failed to sync skipped phase to DB:`, error.message);
  }
}
