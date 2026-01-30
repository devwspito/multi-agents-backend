/**
 * Centralized Status Enums
 *
 * CRITICAL: All status values MUST use these enums for data integrity.
 * This ensures consistent training data for AI models.
 *
 * Usage:
 *   import { StoryStatus, PhaseStatus, TaskStatus } from '../types/status';
 *
 *   const story: { status: StoryStatus } = { status: 'completed' };
 */

// ============================================================================
// BASE STATUS (Core states shared by most entities)
// ============================================================================

/**
 * Base status values used across the system.
 * These are the fundamental states any work item can be in.
 */
export type BaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// ============================================================================
// STORY STATUS
// ============================================================================

/**
 * Status values for individual stories.
 * Stories can also be 'skipped' if determined unnecessary.
 */
export type StoryStatus = BaseStatus | 'skipped';

/**
 * Story progress stages (checkpoints within execution).
 * Used by UnifiedMemoryService.saveStoryProgress()
 */
export type StoryProgressStage =
  | 'started'
  | 'branch_created'
  | 'developed'
  | 'committed'
  | 'pushed'
  | 'reviewed'
  | 'approved'
  | 'completed'
  | 'failed';

// ============================================================================
// PHASE STATUS
// ============================================================================

/**
 * Status values for orchestration phases.
 * Phases have additional states for approval workflows.
 */
export type PhaseStatus =
  | BaseStatus
  | 'skipped'
  | 'waiting_approval'
  | 'approved';

// ============================================================================
// TASK STATUS
// ============================================================================

/**
 * Status values for top-level tasks.
 * Tasks can be paused or cancelled by users.
 */
export type TaskStatus =
  | BaseStatus
  | 'cancelled'
  | 'paused'
  | 'interrupted';

// ============================================================================
// JUDGE VERDICT
// ============================================================================

/**
 * Judge agent review verdicts.
 * Note: 'changes_requested' is distinct from 'rejected' -
 * it means code needs fixes but is salvageable.
 */
export type JudgeVerdict =
  | 'approved'
  | 'changes_requested'
  | 'rejected';

// ============================================================================
// PULL REQUEST STATE
// ============================================================================

/**
 * GitHub Pull Request states.
 */
export type PRState = 'open' | 'merged' | 'closed';

// ============================================================================
// BACKGROUND TASK STATUS
// ============================================================================

/**
 * Status for background/async tasks.
 * Uses 'running' instead of 'in_progress' for clarity.
 */
export type BackgroundTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a status indicates the entity is finished (success or failure).
 */
export function isTerminalStatus(status: BaseStatus | StoryStatus | PhaseStatus): boolean {
  return ['completed', 'failed', 'skipped'].includes(status);
}

/**
 * Check if a status indicates success.
 */
export function isSuccessStatus(status: BaseStatus | StoryStatus | PhaseStatus | JudgeVerdict): boolean {
  return ['completed', 'approved'].includes(status);
}

/**
 * Check if a status indicates failure.
 */
export function isFailureStatus(status: BaseStatus | StoryStatus | PhaseStatus | JudgeVerdict): boolean {
  return ['failed', 'rejected', 'changes_requested'].includes(status);
}

/**
 * Check if a status indicates the entity is active/running.
 */
export function isActiveStatus(status: BaseStatus | StoryStatus | PhaseStatus | TaskStatus): boolean {
  return status === 'in_progress';
}

/**
 * Normalize legacy status values to standard values.
 * Use this when reading from external sources or old data.
 */
export function normalizeStatus(status: string): BaseStatus {
  const normalized = status.toLowerCase().trim();

  // Map legacy values
  const mappings: Record<string, BaseStatus> = {
    'running': 'in_progress',
    'active': 'in_progress',
    'done': 'completed',
    'finished': 'completed',
    'success': 'completed',
    'error': 'failed',
    'failure': 'failed',
  };

  if (mappings[normalized]) {
    return mappings[normalized];
  }

  // Return as-is if it's already a valid status
  if (['pending', 'in_progress', 'completed', 'failed'].includes(normalized)) {
    return normalized as BaseStatus;
  }

  // Default to pending for unknown values
  console.warn(`[Status] Unknown status value "${status}", defaulting to "pending"`);
  return 'pending';
}

// ============================================================================
// CONSTANTS FOR VALIDATION
// ============================================================================

export const VALID_BASE_STATUSES: readonly BaseStatus[] = ['pending', 'in_progress', 'completed', 'failed'];
export const VALID_STORY_STATUSES: readonly StoryStatus[] = [...VALID_BASE_STATUSES, 'skipped'];
export const VALID_PHASE_STATUSES: readonly PhaseStatus[] = [...VALID_STORY_STATUSES, 'waiting_approval', 'approved'];
export const VALID_TASK_STATUSES: readonly TaskStatus[] = [...VALID_BASE_STATUSES, 'cancelled', 'paused', 'interrupted'];
export const VALID_JUDGE_VERDICTS: readonly JudgeVerdict[] = ['approved', 'changes_requested', 'rejected'];
export const VALID_PR_STATES: readonly PRState[] = ['open', 'merged', 'closed'];
