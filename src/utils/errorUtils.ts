/**
 * Error Utilities
 *
 * Helper functions for type-safe error handling.
 */

/**
 * Extract error message from unknown error type
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Extract error stack from unknown error type
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * Check if error has a specific code (e.g., ENOENT)
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Ensure error is an Error instance
 */
export function ensureError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(getErrorMessage(error));
}
