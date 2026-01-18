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

/**
 * Billing Error - Special error for API credit/billing issues
 *
 * This error type is EXCLUDED from Circuit Breaker calculations
 * because it's not a code/logic error - it's a billing issue.
 * The user can fix this by recharging their API credits.
 */
export class BillingError extends Error {
  constructor(
    public readonly originalError: string,
    public readonly agentType?: string
  ) {
    super(`Billing error: ${originalError}`);
    this.name = 'BillingError';
  }
}

/**
 * Check if an error is a billing/credit error
 * These errors should NOT be counted in Circuit Breaker
 */
export function isBillingError(error: any): boolean {
  const errorMessage = error?.message || error?.toString() || '';
  const errorType = error?.error || '';

  const billingPatterns = [
    'Credit balance is too low',
    'billing_error',
    'insufficient_credits',
    'payment_required',
    'credit_limit',
    'quota_exceeded',
    'rate_limit_exceeded',
    'account_suspended',
  ];

  return billingPatterns.some(pattern =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase()) ||
    errorType.toLowerCase().includes(pattern.toLowerCase())
  );
}

/**
 * Wrap an error as BillingError if it matches billing patterns
 */
export function wrapAsBillingErrorIfApplicable(error: any, agentType?: string): Error {
  if (isBillingError(error)) {
    return new BillingError(error.message || error.toString(), agentType);
  }
  return error;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔥 STRUCTURED ERROR TYPES: For better error classification and recovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enumeration of all possible error types in the orchestration system.
 * This enables type-safe error classification instead of fragile string matching.
 */
export enum OrchestrationErrorType {
  /** API billing/credit issues - recoverable by user */
  BILLING = 'billing',
  /** Agent timeout - may retry with different model */
  TIMEOUT = 'timeout',
  /** Git operation failed - may retry or need manual fix */
  GIT_ERROR = 'git_error',
  /** Validation failure - data/context issue */
  VALIDATION = 'validation',
  /** Network/API connection issue - transient, retry */
  NETWORK = 'network',
  /** Agent execution failed - code/logic error */
  EXECUTION = 'execution',
  /** Cost budget exceeded */
  BUDGET_EXCEEDED = 'budget_exceeded',
  /** Circuit breaker tripped */
  CIRCUIT_BREAKER = 'circuit_breaker',
  /** Unknown error type */
  UNKNOWN = 'unknown',
}

/**
 * Structured result for Promise.allSettled that includes error classification
 */
export interface ClassifiedResult<T> {
  success: boolean;
  data?: T;
  errorType?: OrchestrationErrorType;
  errorMessage?: string;
  retryable: boolean;
}

/**
 * Classify an error into a structured type.
 * Use this instead of ad-hoc string matching throughout the codebase.
 */
export function classifyError(error: any): { type: OrchestrationErrorType; retryable: boolean } {
  if (!error) {
    return { type: OrchestrationErrorType.UNKNOWN, retryable: false };
  }

  // Check error name first (for typed errors)
  const errorName = error?.name || '';
  if (errorName === 'BillingError') {
    return { type: OrchestrationErrorType.BILLING, retryable: false };
  }
  if (errorName === 'CostBudgetExceededError') {
    return { type: OrchestrationErrorType.BUDGET_EXCEEDED, retryable: false };
  }
  if (errorName === 'CircuitBreakerError') {
    return { type: OrchestrationErrorType.CIRCUIT_BREAKER, retryable: false };
  }

  const errorMessage = (error?.message || error?.toString() || '').toLowerCase();

  // Billing errors (user-recoverable)
  if (isBillingError(error)) {
    return { type: OrchestrationErrorType.BILLING, retryable: false };
  }

  // Timeout errors (may retry with stronger model)
  const timeoutPatterns = ['timeout', 'timed out', 'deadline exceeded', 'execution timeout'];
  if (timeoutPatterns.some(p => errorMessage.includes(p))) {
    return { type: OrchestrationErrorType.TIMEOUT, retryable: true };
  }

  // Git errors (may need manual fix)
  const gitPatterns = ['git', 'repository', 'branch', 'merge conflict', 'not a git repository'];
  if (gitPatterns.some(p => errorMessage.includes(p))) {
    return { type: OrchestrationErrorType.GIT_ERROR, retryable: false };
  }

  // Network errors (transient, should retry)
  const networkPatterns = ['econnreset', 'enotfound', 'etimedout', 'socket hang up', 'network', 'connection refused'];
  if (networkPatterns.some(p => errorMessage.includes(p))) {
    return { type: OrchestrationErrorType.NETWORK, retryable: true };
  }

  // Validation errors (data/context issue)
  const validationPatterns = ['validation', 'invalid', 'required', 'missing', 'undefined', 'null'];
  if (validationPatterns.some(p => errorMessage.includes(p))) {
    return { type: OrchestrationErrorType.VALIDATION, retryable: false };
  }

  // Default to execution error
  return { type: OrchestrationErrorType.EXECUTION, retryable: true };
}

/**
 * Wrap a Promise.allSettled result array into ClassifiedResults.
 * This standardizes error handling across all parallel execution.
 */
export function classifySettledResults<T>(
  results: PromiseSettledResult<T>[]
): ClassifiedResult<T>[] {
  return results.map(result => {
    if (result.status === 'fulfilled') {
      // Check if the fulfilled value indicates failure (some functions return { success: false })
      const value = result.value as any;
      if (value && typeof value === 'object' && 'success' in value && !value.success) {
        const classification = classifyError(value.error || value.errorMessage);
        return {
          success: false,
          data: result.value,
          errorType: classification.type,
          errorMessage: value.error || value.errorMessage,
          retryable: classification.retryable,
        };
      }
      return {
        success: true,
        data: result.value,
        retryable: false,
      };
    } else {
      const classification = classifyError(result.reason);
      return {
        success: false,
        errorType: classification.type,
        errorMessage: result.reason?.message || String(result.reason),
        retryable: classification.retryable,
      };
    }
  });
}