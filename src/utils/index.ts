/**
 * Centralized Utilities Index
 *
 * This file exports all centralized utilities for easy imports.
 * Instead of importing from individual files:
 *   import { GitStatusParser } from '../utils/GitStatusParser';
 *   import { SafeExecutor } from '../utils/SafeExecutor';
 *
 * You can import from the index:
 *   import { GitStatusParser, SafeExecutor, ValidationUtils, StringUtils } from '../utils';
 *
 * Or import specific functions:
 *   import { truncate, requireString, safeExecute } from '../utils';
 */

// Git Status Parsing
export { GitStatusParser, type GitStatusEntry, type ParsedGitStatus } from './GitStatusParser.js';

// Safe Execution with Error Handling
export {
  SafeExecutor,
  safeExecute,
  safeExecuteSync,
  safeExecuteWithRetry,
  safeExecuteWithTimeout,
  type ExecutionResult,
  type ExecutionOptions,
  type RetryOptions,
} from './SafeExecutor.js';

// Validation Utilities
export {
  ValidationUtils,
  requireString,
  requireTaskId,
  requirePath,
  requireNumber,
  requireArray,
  requireFields,
  requireOneOf,
  requirePattern,
  type ValidationError,
} from './ValidationUtils.js';

// String Utilities
export {
  StringUtils,
  truncate,
  shortCommitSha,
  shortContainerId,
  formatDuration,
  formatFileSize,
  formatCost,
  mask,
} from './StringUtils.js';

// Re-export safe git execution utilities (already centralized)
export {
  safeGitExec,
  safeGitExecSync,
  smartGitFetch,
  fixGitRemoteAuth,
  normalizeRepoName,
  validateGitRemoteUrl,
} from './safeGitExecution.js';

// API Response Utilities
export {
  ApiResponse,
  success,
  error,
  notFound,
  badRequest,
  validationError,
  internalError,
  HttpStatus,
  ErrorCodes,
  type SuccessResponse,
  type ErrorResponse,
  type ValidationErrorDetail,
  type ErrorCode,
} from './ApiResponse.js';

// Centralized Logger
export {
  Logger,
  LoggerInstance,
  createLogger,
  LogEmoji,
  Emoji,
  type LogLevel,
} from './Logger.js';

// App Configuration (re-export from config)
export { AppConfig, type AppConfigType } from '../config/AppConfig.js';
