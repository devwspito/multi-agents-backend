/**
 * Error Constants - Standardized error classification and creation
 *
 * Consolidates scattered error prefixes like:
 * - "HUMAN_REQUIRED: ..." (15+ occurrences)
 * - "CRITICAL: ..." (5+ occurrences)
 * - Various unclassified errors
 *
 * Benefits:
 * - Consistent error classification
 * - Easier error recovery logic
 * - Standardized logging
 */

/**
 * Error type prefixes for classification
 */
export const ERROR_TYPES = {
  /** Requires manual human intervention - cannot auto-recover */
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',

  /** Critical system error - unrecoverable */
  CRITICAL: 'CRITICAL',

  /** Can be retried automatically */
  RETRYABLE: 'RETRYABLE',

  /** Operation timed out */
  TIMEOUT: 'TIMEOUT',

  /** Input validation failed */
  VALIDATION: 'VALIDATION',

  /** Git operation failed */
  GIT_ERROR: 'GIT_ERROR',

  /** Network/API error */
  NETWORK: 'NETWORK',

  /** Budget/billing limit exceeded */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',

  /** Configuration error */
  CONFIG: 'CONFIG',

  /** Phase execution error */
  PHASE_ERROR: 'PHASE_ERROR',
} as const;

export type ErrorType = keyof typeof ERROR_TYPES;

/**
 * Create a typed error with standard prefix
 */
export function createTypedError(type: ErrorType, message: string): Error {
  return new Error(`${ERROR_TYPES[type]}: ${message}`);
}

/**
 * Check if an error is of a specific type
 */
export function isErrorType(error: Error | string, type: ErrorType): boolean {
  const message = typeof error === 'string' ? error : error.message;
  return message.startsWith(`${ERROR_TYPES[type]}:`);
}

/**
 * Extract the error type from an error message
 */
export function getErrorType(error: Error | string): ErrorType | null {
  const message = typeof error === 'string' ? error : error.message;

  for (const [key, prefix] of Object.entries(ERROR_TYPES)) {
    if (message.startsWith(`${prefix}:`)) {
      return key as ErrorType;
    }
  }

  return null;
}

/**
 * Check if an error requires human intervention
 */
export function requiresHumanIntervention(error: Error | string): boolean {
  const type = getErrorType(error);
  return type === 'HUMAN_REQUIRED' || type === 'CRITICAL';
}

/**
 * Check if an error is retryable
 */
export function isRetryable(error: Error | string): boolean {
  const type = getErrorType(error);
  return type === 'RETRYABLE' || type === 'TIMEOUT' || type === 'NETWORK';
}

/**
 * Common error messages - for consistency
 */
export const ERROR_MESSAGES = {
  WORKSPACE_NOT_FOUND: 'Workspace path is null or invalid',
  REPOSITORY_NOT_FOUND: 'Repository not found in workspace',
  EPIC_BRANCH_MISSING: 'Epic branch name not specified',
  STORY_BRANCH_MISSING: 'Story branch name not specified',
  NO_EPICS_FOUND: 'No epics found from Planning phase',
  NO_STORIES_FOUND: 'No stories found for development',
  JUDGE_REJECTED: 'Code rejected by Judge',
  MAX_RETRIES_EXCEEDED: 'Maximum retry attempts exceeded',
  BUDGET_EXCEEDED: 'Cost budget exceeded',
  TIMEOUT: 'Operation timed out',
  GIT_PUSH_FAILED: 'Failed to push to remote repository',
  GIT_FETCH_FAILED: 'Failed to fetch from remote repository',
  MERGE_CONFLICT: 'Merge conflict detected',
} as const;

/**
 * Create common errors with standard messages
 */
export const createError = {
  workspaceNotFound: (context: string) =>
    createTypedError('CRITICAL', `${ERROR_MESSAGES.WORKSPACE_NOT_FOUND} in ${context}`),

  repositoryNotFound: (repoName: string) =>
    createTypedError('CRITICAL', `${ERROR_MESSAGES.REPOSITORY_NOT_FOUND}: ${repoName}`),

  epicBranchMissing: (epicId: string) =>
    createTypedError('VALIDATION', `${ERROR_MESSAGES.EPIC_BRANCH_MISSING} for epic ${epicId}`),

  noEpicsFound: () =>
    createTypedError('HUMAN_REQUIRED', ERROR_MESSAGES.NO_EPICS_FOUND),

  noStoriesFound: (epicId: string) =>
    createTypedError('HUMAN_REQUIRED', `${ERROR_MESSAGES.NO_STORIES_FOUND} for epic ${epicId}`),

  judgeRejected: (reason: string) =>
    createTypedError('RETRYABLE', `${ERROR_MESSAGES.JUDGE_REJECTED}: ${reason}`),

  maxRetriesExceeded: (operation: string, attempts: number) =>
    createTypedError('HUMAN_REQUIRED', `${ERROR_MESSAGES.MAX_RETRIES_EXCEEDED} for ${operation} after ${attempts} attempts`),

  budgetExceeded: (spent: number, limit: number) =>
    createTypedError('BUDGET_EXCEEDED', `${ERROR_MESSAGES.BUDGET_EXCEEDED}: $${spent.toFixed(2)} / $${limit.toFixed(2)}`),

  timeout: (operation: string, timeoutMs: number) =>
    createTypedError('TIMEOUT', `${ERROR_MESSAGES.TIMEOUT}: ${operation} after ${timeoutMs}ms`),

  gitPushFailed: (branch: string, reason: string) =>
    createTypedError('GIT_ERROR', `${ERROR_MESSAGES.GIT_PUSH_FAILED} for ${branch}: ${reason}`),

  gitFetchFailed: (reason: string) =>
    createTypedError('RETRYABLE', `${ERROR_MESSAGES.GIT_FETCH_FAILED}: ${reason}`),
};
