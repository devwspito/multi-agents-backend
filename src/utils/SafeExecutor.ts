/**
 * SafeExecutor
 *
 * Centralized utility for safe execution with consistent error handling.
 * Replaces duplicated try-catch-log patterns across the codebase.
 *
 * Features:
 * - Consistent error logging format
 * - Optional retry logic with exponential backoff
 * - Type-safe result handling (success/failure)
 * - Async and sync function support
 * - Context-aware logging (operation name, metadata)
 *
 * Usage:
 *   // Simple execution with logging
 *   const result = await SafeExecutor.execute(
 *     () => fetchData(),
 *     { operation: 'fetchData', context: 'UserService' }
 *   );
 *
 *   // With retry
 *   const result = await SafeExecutor.executeWithRetry(
 *     () => unreliableOperation(),
 *     { operation: 'unreliableOp', maxRetries: 3 }
 *   );
 *
 *   // Sync execution
 *   const result = SafeExecutor.executeSync(
 *     () => parseConfig(),
 *     { operation: 'parseConfig' }
 *   );
 */

import { calculateBackoffDelay, RETRY_CONFIG } from '../services/orchestration/constants/Timeouts.js';

/**
 * Result type for safe execution - always returns success status
 */
export interface ExecutionResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  errorMessage?: string;
  duration?: number;
  retries?: number;
}

/**
 * Options for safe execution
 */
export interface ExecutionOptions {
  /** Operation name for logging */
  operation: string;
  /** Additional context (e.g., service name, function name) */
  context?: string;
  /** Whether to log errors (default: true) */
  logErrors?: boolean;
  /** Log level for errors (default: 'error') */
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  /** Additional metadata for logging */
  metadata?: Record<string, any>;
  /** Whether to rethrow errors after logging (default: false) */
  rethrow?: boolean;
  /** Custom error handler */
  onError?: (error: Error, options: ExecutionOptions) => void;
}

/**
 * Options for retry execution
 */
export interface RetryOptions extends ExecutionOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Initial delay in ms (default: 2000) */
  initialDelayMs?: number;
  /** Maximum delay in ms (default: 30000) */
  maxDelayMs?: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;
  /** Function to determine if error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Callback before each retry */
  onRetry?: (attempt: number, error: Error) => void;
}

export class SafeExecutor {
  /**
   * Execute an async function with error handling
   */
  static async execute<T>(
    fn: () => Promise<T>,
    options: ExecutionOptions
  ): Promise<ExecutionResult<T>> {
    const startTime = Date.now();
    const prefix = options.context ? `[${options.context}]` : '';

    try {
      const data = await fn();
      return {
        success: true,
        data,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      const errorResult: ExecutionResult<T> = {
        success: false,
        error,
        errorMessage: error.message || String(error),
        duration: Date.now() - startTime,
      };

      // Log error if enabled (default: true)
      if (options.logErrors !== false) {
        this.logError(error, options, prefix);
      }

      // Call custom error handler if provided
      if (options.onError) {
        options.onError(error, options);
      }

      // Rethrow if requested
      if (options.rethrow) {
        throw error;
      }

      return errorResult;
    }
  }

  /**
   * Execute a sync function with error handling
   */
  static executeSync<T>(
    fn: () => T,
    options: ExecutionOptions
  ): ExecutionResult<T> {
    const startTime = Date.now();
    const prefix = options.context ? `[${options.context}]` : '';

    try {
      const data = fn();
      return {
        success: true,
        data,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      const errorResult: ExecutionResult<T> = {
        success: false,
        error,
        errorMessage: error.message || String(error),
        duration: Date.now() - startTime,
      };

      // Log error if enabled (default: true)
      if (options.logErrors !== false) {
        this.logError(error, options, prefix);
      }

      // Call custom error handler if provided
      if (options.onError) {
        options.onError(error, options);
      }

      // Rethrow if requested
      if (options.rethrow) {
        throw error;
      }

      return errorResult;
    }
  }

  /**
   * Execute with automatic retry and exponential backoff
   */
  static async executeWithRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions
  ): Promise<ExecutionResult<T>> {
    const maxRetries = options.maxRetries ?? RETRY_CONFIG.DEFAULT_MAX_RETRIES;
    const prefix = options.context ? `[${options.context}]` : '';

    let lastError: Error | undefined;
    let totalDuration = 0;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const startTime = Date.now();

      try {
        const data = await fn();
        return {
          success: true,
          data,
          duration: totalDuration + (Date.now() - startTime),
          retries: attempt - 1,
        };
      } catch (error: any) {
        lastError = error;
        totalDuration += Date.now() - startTime;

        // Check if error is retryable
        const isRetryable = options.isRetryable?.(error) ?? true;

        if (attempt <= maxRetries && isRetryable) {
          const delay = calculateBackoffDelay(attempt, {
            initialDelayMs: options.initialDelayMs,
            maxDelayMs: options.maxDelayMs,
            backoffMultiplier: options.backoffMultiplier,
          });

          if (options.logLevel !== 'debug') {
            console.warn(
              `${prefix} ${options.operation} failed (attempt ${attempt}/${maxRetries + 1}): ${error.message}`
            );
            console.log(`${prefix} Retrying in ${delay}ms...`);
          }

          // Call retry callback if provided
          if (options.onRetry) {
            options.onRetry(attempt, error);
          }

          await this.sleep(delay);
        } else {
          // No more retries or error not retryable
          if (options.logErrors !== false) {
            this.logError(error, options, prefix, attempt, maxRetries + 1);
          }
          break;
        }
      }
    }

    const errorResult: ExecutionResult<T> = {
      success: false,
      error: lastError,
      errorMessage: lastError?.message || 'Unknown error',
      duration: totalDuration,
      retries: maxRetries,
    };

    // Call custom error handler if provided
    if (options.onError && lastError) {
      options.onError(lastError, options);
    }

    // Rethrow if requested
    if (options.rethrow && lastError) {
      throw lastError;
    }

    return errorResult;
  }

  /**
   * Execute multiple async functions in parallel with error handling
   */
  static async executeAll<T>(
    fns: Array<() => Promise<T>>,
    options: ExecutionOptions
  ): Promise<ExecutionResult<T>[]> {
    return Promise.all(
      fns.map((fn, index) =>
        this.execute(fn, {
          ...options,
          operation: `${options.operation}[${index}]`,
        })
      )
    );
  }

  /**
   * Execute with timeout
   */
  static async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    options: ExecutionOptions
  ): Promise<ExecutionResult<T>> {
    return this.execute(
      () => {
        return new Promise<T>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error(`Operation timed out after ${timeoutMs}ms`));
          }, timeoutMs);

          fn()
            .then((result) => {
              clearTimeout(timeoutId);
              resolve(result);
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              reject(error);
            });
        });
      },
      options
    );
  }

  /**
   * Log error with consistent format
   */
  private static logError(
    error: Error,
    options: ExecutionOptions,
    prefix: string,
    attempt?: number,
    maxAttempts?: number
  ): void {
    const level = options.logLevel ?? 'error';
    const attemptStr = attempt && maxAttempts
      ? ` (attempt ${attempt}/${maxAttempts})`
      : '';

    const message = `${prefix} ${options.operation} failed${attemptStr}: ${error.message}`;

    switch (level) {
      case 'warn':
        console.warn(message);
        break;
      case 'info':
        console.log(message);
        break;
      case 'debug':
        // Only log in debug mode if DEBUG env is set
        if (process.env.DEBUG) {
          console.log(`[DEBUG] ${message}`);
        }
        break;
      default:
        console.error(message);
    }

    // Log metadata if provided
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      console.log(`   Metadata: ${JSON.stringify(options.metadata)}`);
    }

    // Log stack trace for errors (not for warn/info)
    if (level === 'error' && error.stack && process.env.DEBUG) {
      console.error(`   Stack: ${error.stack.split('\n').slice(1, 4).join('\n   ')}`);
    }
  }

  /**
   * Sleep helper
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a wrapper function that automatically uses SafeExecutor
   */
  static wrap<T, Args extends any[]>(
    fn: (...args: Args) => Promise<T>,
    options: Omit<ExecutionOptions, 'operation'> & { operation?: string }
  ): (...args: Args) => Promise<ExecutionResult<T>> {
    return async (...args: Args) => {
      return this.execute(
        () => fn(...args),
        {
          operation: options.operation || fn.name || 'wrapped-function',
          ...options,
        }
      );
    };
  }
}

// Convenience functions for common patterns
export const safeExecute = SafeExecutor.execute.bind(SafeExecutor);
export const safeExecuteSync = SafeExecutor.executeSync.bind(SafeExecutor);
export const safeExecuteWithRetry = SafeExecutor.executeWithRetry.bind(SafeExecutor);
export const safeExecuteWithTimeout = SafeExecutor.executeWithTimeout.bind(SafeExecutor);

export default SafeExecutor;
