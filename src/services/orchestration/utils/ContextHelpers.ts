/**
 * Context Helpers
 *
 * Utilities for safe OrchestrationContext data access with validation.
 *
 * PROBLEM: context.getData() can return undefined without validation,
 * leading to silent bugs like "using branch: undefined" in logs.
 *
 * SOLUTION: Provide helpers that validate data exists and throw clear errors.
 */

import { OrchestrationContext } from '../Phase';

/**
 * Get required data from context with validation
 * Throws clear error if data is missing
 *
 * @example
 * const commitSHA = getDataRequired<string>(context, 'commitSHA');
 * // Throws: "Required context data missing: commitSHA"
 */
export function getDataRequired<T>(context: OrchestrationContext, key: string): T {
  const value = context.getData<T>(key);

  if (value === undefined || value === null) {
    throw new Error(
      `Required context data missing: ${key}\n` +
        `Context keys available: ${getAvailableContextKeys(context).join(', ')}\n` +
        `This is a programming error - ensure ${key} is set before use`
    );
  }

  return value;
}

/**
 * Get data with fallback value (safe optional access)
 *
 * @example
 * const workspaceStructure = getDataWithDefault(context, 'workspaceStructure', '');
 * // Returns '' if not set
 */
export function getDataWithDefault<T>(
  context: OrchestrationContext,
  key: string,
  defaultValue: T
): T {
  const value = context.getData<T>(key);
  return value !== undefined && value !== null ? value : defaultValue;
}

/**
 * Get optional data (explicitly allows undefined)
 *
 * @example
 * const epicBranch = getDataOptional<string>(context, 'epicBranch');
 * if (epicBranch) { ... }  // Explicit check required
 */
export function getDataOptional<T>(context: OrchestrationContext, key: string): T | undefined {
  return context.getData<T>(key);
}

/**
 * Validate multiple required keys at once
 * Throws error listing ALL missing keys
 *
 * @example
 * validateRequiredContext(context, ['commitSHA', 'storyBranchName', 'targetRepository']);
 */
export function validateRequiredContext(
  context: OrchestrationContext,
  requiredKeys: string[]
): void {
  const missingKeys: string[] = [];

  for (const key of requiredKeys) {
    const value = context.getData(key);
    if (value === undefined || value === null) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    throw new Error(
      `Required context data missing:\n` +
        `  Missing: ${missingKeys.join(', ')}\n` +
        `  Required: ${requiredKeys.join(', ')}\n` +
        `  Available: ${getAvailableContextKeys(context).join(', ')}`
    );
  }
}

/**
 * Get all available context keys (for debugging)
 */
function getAvailableContextKeys(context: OrchestrationContext): string[] {
  // Try to extract keys from the private data map
  // This is a best-effort debug helper
  try {
    const data = (context as any)._data || (context as any).data || {};
    return Object.keys(data);
  } catch {
    return ['<unable to list keys>'];
  }
}

/**
 * Type-safe context data access with validation
 *
 * Usage patterns:
 * 1. REQUIRED data (will throw if missing):
 *    const commitSHA = getDataRequired<string>(context, 'commitSHA');
 *
 * 2. OPTIONAL data with fallback:
 *    const workspaceStructure = getDataWithDefault(context, 'workspaceStructure', '');
 *
 * 3. OPTIONAL data (explicit undefined handling):
 *    const epicBranch = getDataOptional<string>(context, 'epicBranch');
 *    if (epicBranch) { ... }
 *
 * 4. VALIDATE multiple required keys:
 *    validateRequiredContext(context, ['commitSHA', 'storyBranch', 'repo']);
 */

/**
 * Safe array access with validation
 */
export function getDataArray<T>(context: OrchestrationContext, key: string): T[] {
  const value = context.getData<T[]>(key);
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    console.warn(`[ContextHelpers] Expected array for ${key}, got ${typeof value}`);
    return [];
  }
  return value;
}

/**
 * Check if context has data for key
 */
export function hasContextData(context: OrchestrationContext, key: string): boolean {
  const value = context.getData(key);
  return value !== undefined && value !== null;
}
