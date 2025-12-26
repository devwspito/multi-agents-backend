/**
 * Structured Logger - Production-grade logging utility
 *
 * Provides a drop-in replacement for console.log that:
 * - Integrates with LogService for structured logs
 * - Sanitizes secrets automatically
 * - Maintains backward compatibility with console API
 * - Can be gradually adopted file by file
 *
 * Usage:
 *   import { logger } from '../utils/structuredLogger';
 *
 *   // Instead of: console.log('Processing task', taskId);
 *   logger.info('Processing task', { taskId });
 *
 *   // For orchestration with context:
 *   const log = logger.forTask(taskId, 'development', 'developer');
 *   log.info('Starting development');
 *   log.success('Development complete');
 *   log.error('Failed', error);
 */

import { LogService, LogContext } from '../services/logging/LogService';
import { SecretsSanitizer } from './secretsSanitizer';

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error';

interface StructuredLoggerOptions {
  taskId?: string;
  phase?: LogContext['phase'];
  agentType?: LogContext['agentType'];
  agentInstanceId?: string;
  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;
}

class StructuredLogger {
  private defaultContext: StructuredLoggerOptions = {};

  /**
   * Create a logger with pre-set context (for orchestration phases)
   */
  forTask(
    taskId: string,
    phase?: LogContext['phase'],
    agentType?: LogContext['agentType']
  ): StructuredLogger {
    const contextLogger = new StructuredLogger();
    contextLogger.defaultContext = {
      taskId,
      phase,
      agentType,
    };
    return contextLogger;
  }

  /**
   * Create a logger for a specific story
   */
  forStory(
    taskId: string,
    storyId: string,
    storyTitle: string,
    agentInstanceId?: string
  ): StructuredLogger {
    const contextLogger = new StructuredLogger();
    contextLogger.defaultContext = {
      taskId,
      storyId,
      storyTitle,
      agentInstanceId,
      phase: 'development',
      agentType: 'developer',
    };
    return contextLogger;
  }

  /**
   * Log at DEBUG level (only in development)
   */
  debug(message: string, metadata?: Record<string, any>): void {
    this.log('debug', message, metadata);
  }

  /**
   * Log at INFO level
   */
  info(message: string, metadata?: Record<string, any>): void {
    this.log('info', message, metadata);
  }

  /**
   * Log at SUCCESS level
   */
  success(message: string, metadata?: Record<string, any>): void {
    this.log('success', message, metadata);
  }

  /**
   * Log at WARN level
   */
  warn(message: string, metadata?: Record<string, any>): void {
    this.log('warn', message, metadata);
  }

  /**
   * Log at ERROR level
   */
  error(message: string, error?: Error | Record<string, any>): void {
    const metadata = error instanceof Error
      ? { error: { message: error.message, stack: error.stack } }
      : error;
    this.log('error', message, metadata);
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, metadata?: Record<string, any>): void {
    // Sanitize message and metadata
    const sanitizedMessage = SecretsSanitizer.sanitize(message);
    const sanitizedMetadata = metadata ? SecretsSanitizer.sanitizeObject(metadata) : undefined;

    // If we have a taskId, use LogService for structured logging
    if (this.defaultContext.taskId) {
      const context: LogContext = {
        taskId: this.defaultContext.taskId,
        category: this.getCategoryFromLevel(level),
        phase: this.defaultContext.phase,
        agentType: this.defaultContext.agentType,
        agentInstanceId: this.defaultContext.agentInstanceId,
        epicId: this.defaultContext.epicId,
        epicName: this.defaultContext.epicName,
        storyId: this.defaultContext.storyId,
        storyTitle: this.defaultContext.storyTitle,
        metadata: sanitizedMetadata,
      };

      // Fire and forget - don't await
      this.logToService(level, sanitizedMessage, context);
    }

    // Always log to console for immediate visibility
    this.logToConsole(level, sanitizedMessage, sanitizedMetadata);
  }

  /**
   * Log to LogService asynchronously
   */
  private async logToService(level: LogLevel, message: string, context: LogContext): Promise<void> {
    try {
      switch (level) {
        case 'debug':
          await LogService.debug(message, context);
          break;
        case 'info':
          await LogService.info(message, context);
          break;
        case 'success':
          await LogService.success(message, context);
          break;
        case 'warn':
          await LogService.warn(message, context);
          break;
        case 'error':
          await LogService.error(message, context);
          break;
      }
    } catch (err) {
      // Silent fail - don't break execution if logging fails
      console.error('[StructuredLogger] Failed to log to service:', err);
    }
  }

  /**
   * Log to console with formatting
   */
  private logToConsole(level: LogLevel, message: string, metadata?: Record<string, any>): void {
    const timestamp = new Date().toISOString().substring(11, 23);
    const prefix = this.getPrefix(level);
    const metaStr = metadata && Object.keys(metadata).length > 0
      ? ` ${JSON.stringify(metadata)}`
      : '';

    const fullMessage = `[${timestamp}] ${prefix} ${message}${metaStr}`;

    switch (level) {
      case 'error':
        console.error(fullMessage);
        break;
      case 'warn':
        console.warn(fullMessage);
        break;
      default:
        console.log(fullMessage);
    }
  }

  /**
   * Get emoji prefix for log level
   */
  private getPrefix(level: LogLevel): string {
    switch (level) {
      case 'debug':
        return '🔍';
      case 'info':
        return 'ℹ️';
      case 'success':
        return '✅';
      case 'warn':
        return '⚠️';
      case 'error':
        return '❌';
      default:
        return '📝';
    }
  }

  /**
   * Map log level to LogService category
   */
  private getCategoryFromLevel(level: LogLevel): LogContext['category'] {
    switch (level) {
      case 'error':
        return 'error';
      default:
        return 'system';
    }
  }
}

// Singleton instance
export const logger = new StructuredLogger();

/**
 * Quick migration helper - wraps console for a specific taskId
 *
 * Usage in orchestration phases:
 *   const log = createTaskLogger(taskId, 'development', 'developer');
 *   log.info('Starting...');
 */
export function createTaskLogger(
  taskId: string,
  phase?: LogContext['phase'],
  agentType?: LogContext['agentType']
): StructuredLogger {
  return logger.forTask(taskId, phase, agentType);
}

/**
 * Quick migration helper for story-level logging
 */
export function createStoryLogger(
  taskId: string,
  storyId: string,
  storyTitle: string,
  agentInstanceId?: string
): StructuredLogger {
  return logger.forStory(taskId, storyId, storyTitle, agentInstanceId);
}
