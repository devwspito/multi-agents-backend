/**
 * Robustness Utilities
 *
 * Core utilities for fault-tolerant operations:
 * - Result types (no throwing, explicit error handling)
 * - Branded types (compile-time validation)
 * - Circuit breaker pattern
 * - Retry with exponential backoff
 * - Atomic file operations
 * - Validation helpers
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// RESULT TYPE - No more throwing, explicit error handling
// ============================================================================

export type Result<T, E = Error> =
  | { success: true; data: T }
  | { success: false; error: E; message: string };

export function ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

export function err<E = Error>(error: E, message?: string): Result<never, E> {
  const msg = message || (error instanceof Error ? error.message : String(error));
  return { success: false, error, message: msg };
}

export function isOk<T, E>(result: Result<T, E>): result is { success: true; data: T } {
  return result.success;
}

export function isErr<T, E>(result: Result<T, E>): result is { success: false; error: E; message: string } {
  return !result.success;
}

// Unwrap with default value
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.success ? result.data : defaultValue;
}

// Map over successful results
export function mapResult<T, U, E>(result: Result<T, E>, fn: (data: T) => U): Result<U, E> {
  if (result.success) {
    return ok(fn(result.data));
  }
  return result;
}

// ============================================================================
// BRANDED TYPES - Compile-time validation for critical paths
// ============================================================================

declare const __brand: unique symbol;
type Brand<B> = { [__brand]: B };

/** Validated workspace path that exists and is writable */
export type ValidWorkspacePath = string & Brand<'ValidWorkspacePath'>;

/** Validated task ID (MongoDB ObjectId format) */
export type ValidTaskId = string & Brand<'ValidTaskId'>;

/** Validated repository name */
export type ValidRepoName = string & Brand<'ValidRepoName'>;

// Validation functions that return branded types
export function validateWorkspacePath(p: string | null | undefined): Result<ValidWorkspacePath> {
  if (!p || typeof p !== 'string') {
    return err(new Error('Workspace path is null or undefined'), 'INVALID_WORKSPACE_PATH_NULL');
  }

  if (p.length === 0) {
    return err(new Error('Workspace path is empty'), 'INVALID_WORKSPACE_PATH_EMPTY');
  }

  if (!path.isAbsolute(p)) {
    return err(new Error(`Workspace path is not absolute: ${p}`), 'INVALID_WORKSPACE_PATH_RELATIVE');
  }

  if (!fs.existsSync(p)) {
    return err(new Error(`Workspace path does not exist: ${p}`), 'INVALID_WORKSPACE_PATH_NOT_EXISTS');
  }

  try {
    fs.accessSync(p, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    return err(new Error(`Workspace path is not readable/writable: ${p}`), 'INVALID_WORKSPACE_PATH_NO_ACCESS');
  }

  return ok(p as ValidWorkspacePath);
}

export function validateTaskId(id: string | null | undefined): Result<ValidTaskId> {
  if (!id || typeof id !== 'string') {
    return err(new Error('Task ID is null or undefined'), 'INVALID_TASK_ID_NULL');
  }

  // MongoDB ObjectId is 24 hex characters
  const objectIdRegex = /^[a-f\d]{24}$/i;
  if (!objectIdRegex.test(id)) {
    return err(new Error(`Task ID is not a valid ObjectId: ${id}`), 'INVALID_TASK_ID_FORMAT');
  }

  return ok(id as ValidTaskId);
}

export function validateRepoName(name: string | null | undefined): Result<ValidRepoName> {
  if (!name || typeof name !== 'string') {
    return err(new Error('Repository name is null or undefined'), 'INVALID_REPO_NAME_NULL');
  }

  if (name.length === 0) {
    return err(new Error('Repository name is empty'), 'INVALID_REPO_NAME_EMPTY');
  }

  // Basic validation - no path separators or special chars
  if (/[\/\\:*?"<>|]/.test(name)) {
    return err(new Error(`Repository name contains invalid characters: ${name}`), 'INVALID_REPO_NAME_CHARS');
  }

  return ok(name as ValidRepoName);
}

// ============================================================================
// CIRCUIT BREAKER - Prevent cascading failures
// ============================================================================

interface CircuitBreakerState {
  failures: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

interface CircuitBreakerOptions {
  failureThreshold?: number;  // Number of failures before opening
  resetTimeout?: number;      // Time in ms before trying again
  name: string;               // Identifier for this circuit
}

export async function withCircuitBreaker<T>(
  options: CircuitBreakerOptions,
  fn: () => Promise<T>
): Promise<Result<T>> {
  const {
    name,
    failureThreshold = 5,
    resetTimeout = 30000
  } = options;

  let state = circuitBreakers.get(name);
  if (!state) {
    state = { failures: 0, lastFailure: 0, state: 'closed' };
    circuitBreakers.set(name, state);
  }

  // Check if circuit is open
  if (state.state === 'open') {
    const timeSinceLastFailure = Date.now() - state.lastFailure;
    if (timeSinceLastFailure < resetTimeout) {
      return err(
        new Error(`Circuit breaker '${name}' is open`),
        `CIRCUIT_OPEN: ${name} - wait ${Math.ceil((resetTimeout - timeSinceLastFailure) / 1000)}s`
      );
    }
    // Try half-open
    state.state = 'half-open';
  }

  try {
    const result = await fn();

    // Success - reset circuit
    state.failures = 0;
    state.state = 'closed';

    return ok(result);
  } catch (error: any) {
    state.failures++;
    state.lastFailure = Date.now();

    if (state.failures >= failureThreshold) {
      state.state = 'open';
      console.error(`🔴 Circuit breaker '${name}' OPENED after ${state.failures} failures`);
    }

    return err(error, `Circuit '${name}' failure #${state.failures}: ${error.message}`);
  }
}

// Reset a specific circuit breaker
export function resetCircuitBreaker(name: string): void {
  circuitBreakers.delete(name);
}

// Get circuit breaker status
export function getCircuitBreakerStatus(name: string): CircuitBreakerState | undefined {
  return circuitBreakers.get(name);
}

// ============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// ============================================================================

interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;  // ms
  maxDelay?: number;      // ms
  backoffFactor?: number;
  retryIf?: (error: any) => boolean;  // Only retry if this returns true
  onRetry?: (attempt: number, error: any, delay: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<Result<T>> {
  const {
    maxAttempts = 3,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffFactor = 2,
    retryIf = () => true,
    onRetry,
  } = options;

  let lastError: any;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn();
      return ok(result);
    } catch (error: any) {
      lastError = error;

      // Check if we should retry
      if (attempt === maxAttempts || !retryIf(error)) {
        break;
      }

      // Call onRetry callback
      if (onRetry) {
        onRetry(attempt, error, delay);
      }

      // Wait before retrying
      await sleep(delay);

      // Increase delay with exponential backoff
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  return err(lastError, `Failed after ${maxAttempts} attempts: ${lastError?.message}`);
}

// ============================================================================
// ATOMIC FILE OPERATIONS
// ============================================================================

/**
 * Atomically write to a file using temp file + rename pattern
 * This prevents partial writes on crash
 */
export function atomicWriteFileSync(filePath: string, content: string): Result<void> {
  const tempPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;

  try {
    // Ensure directory exists
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file
    fs.writeFileSync(tempPath, content, 'utf8');

    // Sync to ensure data is on disk
    const fd = fs.openSync(tempPath, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);

    // Atomic rename
    fs.renameSync(tempPath, filePath);

    return ok(undefined);
  } catch (error: any) {
    // Clean up temp file if it exists
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    return err(error, `Atomic write failed for ${filePath}: ${error.message}`);
  }
}

/**
 * Atomically write JSON to a file
 */
export function atomicWriteJsonSync<T>(filePath: string, data: T): Result<void> {
  try {
    const content = JSON.stringify(data, null, 2);
    return atomicWriteFileSync(filePath, content);
  } catch (error: any) {
    return err(error, `JSON serialization failed: ${error.message}`);
  }
}

/**
 * Safely read JSON file with validation
 */
export function safeReadJsonSync<T>(filePath: string): Result<T> {
  try {
    if (!fs.existsSync(filePath)) {
      return err(new Error('File not found'), `FILE_NOT_FOUND: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content) as T;

    return ok(data);
  } catch (error: any) {
    return err(error, `Failed to read JSON from ${filePath}: ${error.message}`);
  }
}

// ============================================================================
// CHECKPOINTING - Save and restore state
// ============================================================================

interface Checkpoint<T> {
  version: number;
  timestamp: number;
  data: T;
  checksum: string;
}

function simpleChecksum(data: string): string {
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

export function saveCheckpoint<T>(basePath: string, name: string, data: T): Result<void> {
  const checkpointDir = path.join(basePath, '.checkpoints');
  const checkpointPath = path.join(checkpointDir, `${name}.json`);
  const backupPath = path.join(checkpointDir, `${name}.backup.json`);

  try {
    // Ensure checkpoint directory exists
    if (!fs.existsSync(checkpointDir)) {
      fs.mkdirSync(checkpointDir, { recursive: true });
    }

    // Read existing checkpoint for version
    let version = 1;
    if (fs.existsSync(checkpointPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as Checkpoint<T>;
        version = existing.version + 1;

        // Create backup of previous checkpoint
        fs.copyFileSync(checkpointPath, backupPath);
      } catch {
        // Ignore errors reading old checkpoint
      }
    }

    const serialized = JSON.stringify(data);
    const checkpoint: Checkpoint<T> = {
      version,
      timestamp: Date.now(),
      data,
      checksum: simpleChecksum(serialized),
    };

    return atomicWriteJsonSync(checkpointPath, checkpoint);
  } catch (error: any) {
    return err(error, `Failed to save checkpoint ${name}: ${error.message}`);
  }
}

export function loadCheckpoint<T>(basePath: string, name: string): Result<T> {
  const checkpointDir = path.join(basePath, '.checkpoints');
  const checkpointPath = path.join(checkpointDir, `${name}.json`);
  const backupPath = path.join(checkpointDir, `${name}.backup.json`);

  // Try main checkpoint first
  const mainResult = tryLoadCheckpoint<T>(checkpointPath);
  if (mainResult.success) {
    return mainResult;
  }

  // Try backup if main fails
  console.warn(`⚠️ Main checkpoint ${name} corrupted, trying backup...`);
  const backupResult = tryLoadCheckpoint<T>(backupPath);
  if (backupResult.success) {
    // Restore backup to main
    try {
      fs.copyFileSync(backupPath, checkpointPath);
    } catch {
      // Ignore restore errors
    }
    return backupResult;
  }

  return err(new Error('Both main and backup checkpoints failed'), `CHECKPOINT_LOAD_FAILED: ${name}`);
}

function tryLoadCheckpoint<T>(filePath: string): Result<T> {
  try {
    if (!fs.existsSync(filePath)) {
      return err(new Error('Checkpoint not found'), 'CHECKPOINT_NOT_FOUND');
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const checkpoint = JSON.parse(content) as Checkpoint<T>;

    // Verify checksum
    const serialized = JSON.stringify(checkpoint.data);
    const expectedChecksum = simpleChecksum(serialized);

    if (checkpoint.checksum !== expectedChecksum) {
      return err(new Error('Checksum mismatch'), 'CHECKPOINT_CORRUPTED');
    }

    return ok(checkpoint.data);
  } catch (error: any) {
    return err(error, `Checkpoint load failed: ${error.message}`);
  }
}

// ============================================================================
// HELPER UTILITIES
// ============================================================================

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run an async function with a timeout
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage?: string
): Promise<Result<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(err(
        new Error(timeoutMessage || 'Operation timed out'),
        `TIMEOUT after ${timeoutMs}ms`
      ));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(ok(result));
      })
      .catch((error) => {
        clearTimeout(timer);
        resolve(err(error, error.message));
      });
  });
}

/**
 * Execute multiple operations and collect all results
 * Unlike Promise.all, this doesn't fail fast - it collects all results
 */
export async function collectResults<T>(
  operations: Array<() => Promise<Result<T>>>
): Promise<{ successes: T[]; failures: Array<{ index: number; error: string }> }> {
  const results = await Promise.all(operations.map(op => op()));

  const successes: T[] = [];
  const failures: Array<{ index: number; error: string }> = [];

  results.forEach((result, index) => {
    if (result.success) {
      successes.push(result.data);
    } else {
      failures.push({ index, error: result.message });
    }
  });

  return { successes, failures };
}

/**
 * Ensure a value is not null/undefined, with a custom error message
 */
export function ensureNotNull<T>(
  value: T | null | undefined,
  errorMessage: string
): Result<T> {
  if (value === null || value === undefined) {
    return err(new Error(errorMessage), errorMessage);
  }
  return ok(value);
}

/**
 * Safe JSON parse
 */
export function safeJsonParse<T>(json: string): Result<T> {
  try {
    return ok(JSON.parse(json) as T);
  } catch (error: any) {
    return err(error, `JSON parse failed: ${error.message}`);
  }
}

// ============================================================================
// LOGGING UTILITIES
// ============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function logResult<T>(
  result: Result<T>,
  context: string,
  level: LogLevel = 'error'
): void {
  if (!result.success) {
    const logFn = level === 'debug' ? console.debug :
                  level === 'info' ? console.info :
                  level === 'warn' ? console.warn : console.error;

    logFn(`❌ [${context}] ${result.message}`);
  }
}
