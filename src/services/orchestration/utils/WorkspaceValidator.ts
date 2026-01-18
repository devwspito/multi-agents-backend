/**
 * Centralized workspace path validation
 *
 * Replaces duplicate validation patterns across phases:
 * - DevelopersPhase.ts
 * - TeamOrchestrationPhase.ts
 * - OrchestrationCoordinator.ts
 * - JudgePhase.ts
 */

import { logCriticalError } from './LogHelpers';

export interface WorkspaceValidationResult {
  valid: boolean;
  path: string;
  error?: string;
}

/**
 * Validate that workspacePath is a valid, non-empty string
 *
 * @param workspacePath - The workspace path to validate
 * @param context - Context string for error messages (e.g., 'DevelopersPhase', 'Team 1')
 * @param options - Additional validation options
 * @returns Validation result with normalized path
 * @throws Error if throwOnInvalid is true and path is invalid
 */
export function validateWorkspacePath(
  workspacePath: string | null | undefined,
  context: string,
  options: { throwOnInvalid?: boolean; logDetails?: Record<string, any> } = {}
): WorkspaceValidationResult {
  const { throwOnInvalid = true, logDetails = {} } = options;

  // Check for null, undefined, or non-string
  if (!workspacePath || typeof workspacePath !== 'string') {
    const error = `workspacePath is ${workspacePath === null ? 'NULL' : workspacePath === undefined ? 'undefined' : typeof workspacePath}`;

    logCriticalError(`Invalid workspacePath in ${context}`, [
      error,
      `Type: ${typeof workspacePath}`,
      `Value: ${JSON.stringify(workspacePath)}`,
      ...Object.entries(logDetails).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      'Task execution cannot proceed without valid workspace',
    ]);

    if (throwOnInvalid) {
      throw new Error(
        `CRITICAL: ${error} in ${context}. ` +
          'Workspace path must be a valid string. Task execution aborted.'
      );
    }

    return { valid: false, path: '', error };
  }

  // Check for empty string
  if (workspacePath.trim().length === 0) {
    const error = 'workspacePath is empty string';

    logCriticalError(`Empty workspacePath in ${context}`, [
      error,
      ...Object.entries(logDetails).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
      'Task execution cannot proceed without valid workspace',
    ]);

    if (throwOnInvalid) {
      throw new Error(
        `CRITICAL: ${error} in ${context}. ` +
          'Workspace path must be a non-empty string. Task execution aborted.'
      );
    }

    return { valid: false, path: '', error };
  }

  // Path is valid
  return { valid: true, path: workspacePath };
}

/**
 * Assert that workspacePath is valid, throwing if not
 * Simpler API for cases where you always want to throw
 */
export function assertValidWorkspacePath(
  workspacePath: string | null | undefined,
  context: string
): string {
  const result = validateWorkspacePath(workspacePath, context, { throwOnInvalid: true });
  return result.path;
}

/**
 * Check if workspacePath is valid without throwing
 * Returns the path if valid, null if invalid
 */
export function getValidWorkspacePath(
  workspacePath: string | null | undefined,
  context: string
): string | null {
  const result = validateWorkspacePath(workspacePath, context, { throwOnInvalid: false });
  return result.valid ? result.path : null;
}
