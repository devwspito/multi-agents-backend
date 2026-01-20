/**
 * Centralized timeout constants for orchestration operations
 *
 * Replaces magic numbers like 90000, 60000, 30000 scattered throughout the codebase.
 * All values are in milliseconds.
 */

// Git operation timeouts
export const GIT_TIMEOUTS = {
  /** Git fetch from remote (network dependent) */
  FETCH: 90_000,
  /** Git push to remote */
  PUSH: 60_000,
  /** Git clone repository */
  CLONE: 120_000,
  /** Git status check (local) */
  STATUS: 10_000,
  /** Git log query */
  LOG: 5_000,
  /** Git diff operation */
  DIFF: 10_000,
  /** Git checkout branch */
  CHECKOUT: 30_000,
  /** Git merge operation */
  MERGE: 60_000,
  /** Git ls-remote check */
  LS_REMOTE: 30_000,
} as const;

// Agent execution timeouts
export const AGENT_TIMEOUTS = {
  /** Default agent execution timeout */
  DEFAULT: 300_000, // 5 minutes
  /** Planning phase agent timeout */
  PLANNING: 600_000, // 10 minutes
  /** TechLead agent timeout */
  TECH_LEAD: 600_000, // 10 minutes
  /** Developer agent timeout */
  DEVELOPER: 900_000, // 15 minutes
  /** Judge agent timeout */
  JUDGE: 300_000, // 5 minutes
  /** Quick operations (lint, format) */
  QUICK: 60_000, // 1 minute
  /** 🔥 TOTAL TIMEOUT: Maximum agent execution time regardless of activity */
  /** Prevents infinite loops where agent keeps sending messages but makes no real progress */
  TOTAL_MAX: 30 * 60 * 1000, // 30 minutes absolute maximum
} as const;

// Retry configuration
export const RETRY_CONFIG = {
  /** Initial delay for exponential backoff */
  INITIAL_DELAY_MS: 2_000,
  /** Maximum delay between retries */
  MAX_DELAY_MS: 30_000,
  /** Backoff multiplier */
  BACKOFF_MULTIPLIER: 2,
  /** Default max retries */
  DEFAULT_MAX_RETRIES: 3,
  /** Git fetch max retries */
  GIT_FETCH_MAX_RETRIES: 3,
} as const;

// Approval timeouts
export const APPROVAL_TIMEOUTS = {
  /** TechLead approval wait time */
  TECH_LEAD_APPROVAL: 60 * 60 * 1000, // 1 hour
  /** General human approval timeout */
  HUMAN_APPROVAL: 24 * 60 * 60 * 1000, // 24 hours
} as const;

// Polling intervals
export const POLLING_INTERVALS = {
  /** Cancellation check interval */
  CANCELLATION_CHECK: 5_000,
  /** Progress update interval */
  PROGRESS_UPDATE: 10_000,
  /** Health check interval */
  HEALTH_CHECK: 30_000,
} as const;

// File system timeouts
export const FS_TIMEOUTS = {
  /** Lock file acquisition timeout */
  LOCK_ACQUIRE: 30_000,
  /** Lock retry delay */
  LOCK_RETRY_DELAY: 500,
  /** Stale lock age (files older than this are considered stale) */
  STALE_LOCK_AGE: 300_000, // 5 minutes
} as const;

/**
 * Calculate exponential backoff delay
 * Moved from inline Math.pow calculations
 */
export function calculateBackoffDelay(
  attempt: number,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  } = {}
): number {
  const {
    initialDelayMs = RETRY_CONFIG.INITIAL_DELAY_MS,
    maxDelayMs = RETRY_CONFIG.MAX_DELAY_MS,
    backoffMultiplier = RETRY_CONFIG.BACKOFF_MULTIPLIER,
  } = options;

  const delay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  return Math.min(delay, maxDelayMs);
}
