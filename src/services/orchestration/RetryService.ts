/**
 * Retry Service with Exponential Backoff
 *
 * Implements Anthropic's best practice for handling transient failures
 * in multi-agent systems with automatic retry and backoff strategy.
 */

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: any, delayMs: number) => void;
}

export class RetryService {
  private static readonly DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000,
    backoffMultiplier: 2,
    retryableErrors: [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'rate_limit',
      'timeout',
      'Credit balance is too low',
      '429', // Too Many Requests
      '503', // Service Unavailable
      '504', // Gateway Timeout
    ],
    onRetry: () => {},
  };

  /**
   * Check if an error is retryable
   */
  static isRetryableError(error: any, customErrors?: string[]): boolean {
    const errorMessage = error?.message || error?.toString() || '';
    const errorCode = error?.code || '';

    const retryablePatterns = [
      ...this.DEFAULT_OPTIONS.retryableErrors,
      ...(customErrors || []),
    ];

    return retryablePatterns.some(pattern =>
      errorMessage.includes(pattern) ||
      errorCode.includes(pattern)
    );
  }

  /**
   * Calculate delay for next retry attempt using exponential backoff
   */
  static calculateBackoffDelay(
    attempt: number,
    options: RetryOptions = {}
  ): number {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };

    // Exponential backoff with jitter
    const exponentialDelay = opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1);

    // Add jitter (±25%) to prevent thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() - 0.5);
    const delayWithJitter = exponentialDelay + jitter;

    // Cap at maximum delay
    return Math.min(delayWithJitter, opts.maxDelayMs);
  }

  /**
   * Execute a function with automatic retry on failure
   */
  static async executeWithRetry<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    let lastError: any;

    for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
      try {
        // Attempt execution
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check if we should retry
        if (attempt === opts.maxRetries) {
          // Max retries reached, throw the error
          throw error;
        }

        // Check if error is retryable
        if (!this.isRetryableError(error, opts.retryableErrors)) {
          // Non-retryable error, throw immediately
          throw error;
        }

        // Calculate backoff delay
        const delayMs = this.calculateBackoffDelay(attempt, opts);

        // Notify about retry
        opts.onRetry(attempt, error, delayMs);

        // Wait before next attempt
        await this.delay(delayMs);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw lastError;
  }

  /**
   * Execute multiple operations with retry, returning all results
   * (similar to Promise.allSettled but with retry)
   */
  static async executeAllWithRetry<T>(
    operations: Array<() => Promise<T>>,
    options: RetryOptions = {}
  ): Promise<Array<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: any }>> {
    const promises = operations.map(operation =>
      this.executeWithRetry(operation, options)
        .then(value => ({ status: 'fulfilled' as const, value }))
        .catch(reason => ({ status: 'rejected' as const, reason }))
    );

    return Promise.all(promises);
  }

  /**
   * Utility function to delay execution
   */
  private static delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a retry wrapper for a specific service
   */
  static createRetryWrapper(
    serviceName: string,
    customOptions?: RetryOptions
  ): <T>(fn: () => Promise<T>) => Promise<T> {
    return async <T>(fn: () => Promise<T>): Promise<T> => {
      return this.executeWithRetry(fn, {
        ...customOptions,
        onRetry: (attempt, error, delayMs) => {
          console.log(
            `⚠️ [${serviceName}] Retry attempt ${attempt} after ${delayMs}ms delay. Error: ${error.message}`
          );
          customOptions?.onRetry?.(attempt, error, delayMs);
        },
      });
    };
  }
}

/**
 * Custom error classes for better error handling
 */
export class AgentTimeoutError extends Error {
  constructor(
    public readonly agentType: string,
    public readonly duration: number
  ) {
    super(`Agent ${agentType} timed out after ${duration}ms`);
    this.name = 'AgentTimeoutError';
  }
}

export class AgentValidationError extends Error {
  constructor(
    public readonly agentType: string,
    public readonly validationErrors: string[]
  ) {
    super(`Agent ${agentType} output validation failed: ${validationErrors.join(', ')}`);
    this.name = 'AgentValidationError';
  }
}

export class CostBudgetExceededError extends Error {
  constructor(
    public readonly currentCost: number,
    public readonly maxCost: number
  ) {
    super(`Cost $${currentCost.toFixed(2)} exceeds budget $${maxCost.toFixed(2)}`);
    this.name = 'CostBudgetExceededError';
  }
}

export class CircuitBreakerError extends Error {
  constructor(
    public readonly failedCount: number,
    public readonly totalCount: number,
    public readonly threshold: number
  ) {
    super(`Circuit breaker: ${failedCount}/${totalCount} operations failed (threshold: ${threshold * 100}%)`);
    this.name = 'CircuitBreakerError';
  }
}