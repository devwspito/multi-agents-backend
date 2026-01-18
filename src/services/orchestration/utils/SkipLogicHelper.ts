/**
 * Skip Logic Helper - Centralized phase skip determination
 *
 * Consolidates the repeated pattern found in 8+ phases:
 * 1. Log check message
 * 2. Check continuation mode (never skip)
 * 3. Check multi-team mode (epic-specific skip)
 * 4. Check unified memory
 * 5. Log and return result
 *
 * Usage in phases:
 *   const { shouldSkip, reason } = await checkPhaseSkip(context, 'Planning');
 *   if (shouldSkip) return true;
 */

import { OrchestrationContext } from '../Phase';
import { unifiedMemoryService } from '../../UnifiedMemoryService';
import { logPhaseSkip, logSection } from './LogHelpers';

/**
 * Result of skip check
 */
export interface SkipCheckResult {
  shouldSkip: boolean;
  reason?: string;
  fromMemory?: boolean;
  epicId?: string;
}

/**
 * Options for skip check
 */
export interface SkipCheckOptions {
  /** Check for continuation mode (defaults to true) */
  checkContinuation?: boolean;

  /** Phase name for logging */
  phaseName: string;

  /** Epic ID for multi-team mode */
  epicId?: string;

  /** Custom check before memory check */
  customPreCheck?: () => Promise<{ skip: boolean; reason?: string } | null>;
}

/**
 * Get task ID as string from context
 */
function getTaskIdFromContext(context: OrchestrationContext): string {
  return (context.task._id as any)?.toString() || '';
}

/**
 * Check if this is a continuation run (should never skip)
 */
function isContinuation(context: OrchestrationContext): boolean {
  const continuations = context.task.orchestration.continuations;
  return Array.isArray(continuations) && continuations.length > 0;
}

/**
 * Get epic ID from context for multi-team mode
 */
function getTeamEpicId(context: OrchestrationContext): string | null {
  const teamEpic = context.getData<any>('teamEpic');
  return teamEpic?.epicId || teamEpic?.id || null;
}

/**
 * Main skip check function
 *
 * Performs standard skip logic that's consistent across all phases:
 * 1. Check continuation mode (never skip continuations)
 * 2. Run custom pre-check if provided
 * 3. Check multi-team mode (epic-specific)
 * 4. Check unified memory
 *
 * @example
 * ```typescript
 * async shouldSkip(context: OrchestrationContext): Promise<boolean> {
 *   const result = await checkPhaseSkip(context, { phaseName: 'Planning' });
 *   return result.shouldSkip;
 * }
 * ```
 */
export async function checkPhaseSkip(
  context: OrchestrationContext,
  options: SkipCheckOptions
): Promise<SkipCheckResult> {
  const { phaseName, checkContinuation = true, epicId, customPreCheck } = options;
  const taskId = getTaskIdFromContext(context);

  // Log start of check
  console.log(`\n🎯 [${phaseName}.shouldSkip] Checking UNIFIED MEMORY for phase completion...`);

  // 1. Check continuation mode (NEVER skip continuations)
  if (checkContinuation && isContinuation(context)) {
    console.log(`🔄 [${phaseName}] CONTINUATION detected - NOT skipping (re-executing with new context)`);
    return { shouldSkip: false, reason: 'continuation mode' };
  }

  // 2. Run custom pre-check if provided
  if (customPreCheck) {
    const customResult = await customPreCheck();
    if (customResult) {
      return { shouldSkip: customResult.skip, reason: customResult.reason };
    }
  }

  // 3. Detect multi-team mode
  const teamEpicId = epicId || getTeamEpicId(context);

  if (teamEpicId) {
    // Multi-team mode: check epic-specific completion in unified memory
    const result = await checkMultiTeamSkip(taskId, phaseName, teamEpicId);
    if (result.shouldSkip) {
      logPhaseSkip(phaseName, `already COMPLETED for epic ${teamEpicId}`);
      return result;
    }
    // Not skipped for this epic - continue to check global phase status
    return { shouldSkip: false, epicId: teamEpicId };
  }

  // 4. Standard mode: check unified memory
  const shouldSkipFromMemory = await unifiedMemoryService.shouldSkipPhase(taskId, phaseName);

  if (shouldSkipFromMemory) {
    logSection(`🎯 [UNIFIED MEMORY] ${phaseName} phase already COMPLETED`);
    return { shouldSkip: true, reason: 'completed in unified memory', fromMemory: true };
  }

  return { shouldSkip: false };
}

/**
 * Check skip for multi-team mode (epic-specific)
 *
 * In multi-team mode, we check if the specific epic has been completed.
 * This uses shouldSkipEpic which checks completedEpics array.
 */
export async function checkMultiTeamSkip(
  taskId: string,
  phaseName: string,
  epicId: string
): Promise<SkipCheckResult> {
  console.log(`🔍 [${phaseName}] Multi-team mode detected - epicId: ${epicId}`);
  console.log(`   Checking UNIFIED MEMORY for EPIC completion...`);

  // Check if this specific epic is completed
  // Note: In multi-team mode, epic completion implies its phases are done
  const shouldSkip = await unifiedMemoryService.shouldSkipEpic(taskId, epicId);

  if (shouldSkip) {
    return {
      shouldSkip: true,
      reason: `epic ${epicId} already completed`,
      fromMemory: true,
      epicId,
    };
  }

  return { shouldSkip: false, epicId };
}

/**
 * Simple synchronous skip check for phases that don't need async
 */
export function checkBasicSkipConditions(
  context: OrchestrationContext,
  phaseName: string
): { shouldSkip: boolean; reason?: string } | null {
  // Check continuation
  if (isContinuation(context)) {
    console.log(`🔄 [${phaseName}] CONTINUATION - not skipping`);
    return { shouldSkip: false, reason: 'continuation' };
  }

  return null; // Continue with async checks
}

/**
 * Log skip decision with standard formatting
 */
export function logSkipResult(
  phaseName: string,
  result: SkipCheckResult
): void {
  if (result.shouldSkip) {
    const epicInfo = result.epicId ? ` (epic: ${result.epicId})` : '';
    const sourceInfo = result.fromMemory ? ' [from unified memory]' : '';
    console.log(`⏭️  [${phaseName}] SKIPPING${epicInfo}${sourceInfo}`);
    if (result.reason) {
      console.log(`   Reason: ${result.reason}`);
    }
  } else {
    console.log(`✅ [${phaseName}] Not skipping - will execute`);
  }
}

/**
 * Create a standard shouldSkip function for simple phases
 *
 * For phases that only need unified memory check:
 * ```typescript
 * readonly shouldSkip = createSimpleSkipFn('PlanningPhase');
 * ```
 */
export function createSimpleSkipFn(phaseName: string) {
  return async (context: OrchestrationContext): Promise<boolean> => {
    const result = await checkPhaseSkip(context, { phaseName });
    return result.shouldSkip;
  };
}
