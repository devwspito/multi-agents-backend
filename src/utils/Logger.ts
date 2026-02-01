/**
 * Logger
 *
 * Centralized logging utility with consistent formatting.
 * Replaces scattered console.log patterns across the codebase.
 *
 * Usage:
 *   import { Logger } from '../utils/Logger';
 *
 *   const log = Logger.create('MyService');
 *   log.info('Operation completed');
 *   log.error('Operation failed', error);
 *   log.debug('Debug info', { data });
 *
 * Format:
 *   [LEVEL] [Prefix] message
 *   Examples:
 *     [INFO] [MyService] Operation completed
 *     [ERROR] [MyService] Operation failed: error message
 */

import { AppConfig } from '../config/AppConfig.js';

/**
 * Log levels in order of severity
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Emoji icons for log levels
 */
const LOG_ICONS: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️ ',
  warn: '⚠️ ',
  error: '❌',
};

/**
 * Common operation emojis for consistent logging
 */
export const LogEmoji = {
  // Status
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  debug: '🔍',

  // Operations
  start: '🚀',
  complete: '✅',
  failed: '❌',
  pending: '⏳',
  skip: '⏭️',
  retry: '🔄',

  // Git
  git: '📦',
  branch: '🌿',
  merge: '🔀',
  commit: '💾',
  push: '📤',
  pull: '📥',

  // Agents
  agent: '🤖',
  thinking: '💭',
  tool: '🔧',

  // Files
  read: '📖',
  write: '✏️',
  edit: '📝',
  delete: '🗑️',

  // Docker/Sandbox
  docker: '🐳',
  sandbox: '📦',
  container: '📦',

  // Network
  network: '🌐',
  websocket: '📡',
  api: '🔌',

  // Cost/Budget
  cost: '💰',
  budget: '💵',

  // Time
  time: '⏱️',
  checkpoint: '🔄',

  // Other
  phase: '📍',
  story: '📖',
  epic: '📚',
  approval: '👍',
  preview: '👁️',
} as const;

/**
 * Logger instance for a specific prefix
 */
export class LoggerInstance {
  constructor(
    private prefix: string,
    private minLevel: LogLevel = 'info'
  ) {}

  /**
   * Check if a log level should be output
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.minLevel];
  }

  /**
   * Format a log message
   */
  private format(level: LogLevel, message: string, useEmoji: boolean = true): string {
    const timestamp = AppConfig.logging.includeTimestamps
      ? `[${new Date().toISOString()}] `
      : '';
    const icon = useEmoji ? `${LOG_ICONS[level]} ` : '';
    return `${timestamp}${icon}[${this.prefix}] ${message}`;
  }

  /**
   * Log a debug message
   */
  debug(message: string, data?: any): void {
    if (!this.shouldLog('debug')) return;

    console.log(this.format('debug', message));
    if (data !== undefined) {
      console.log('   ', data);
    }
  }

  /**
   * Log an info message
   */
  info(message: string, data?: any): void {
    if (!this.shouldLog('info')) return;

    console.log(this.format('info', message));
    if (data !== undefined) {
      console.log('   ', data);
    }
  }

  /**
   * Log a warning message
   */
  warn(message: string, data?: any): void {
    if (!this.shouldLog('warn')) return;

    console.warn(this.format('warn', message));
    if (data !== undefined) {
      console.warn('   ', data);
    }
  }

  /**
   * Log an error message
   */
  error(message: string, error?: Error | any): void {
    if (!this.shouldLog('error')) return;

    const errorMsg = error
      ? `${message}: ${error.message || error}`
      : message;
    console.error(this.format('error', errorMsg));

    if (error?.stack && AppConfig.logging.isDebug) {
      console.error('   Stack:', error.stack.split('\n').slice(1, 4).join('\n   '));
    }
  }

  /**
   * Log a success message (alias for info with success emoji)
   */
  success(message: string, data?: any): void {
    if (!this.shouldLog('info')) return;
    console.log(`${LogEmoji.success} [${this.prefix}] ${message}`);
    if (data !== undefined) {
      console.log('   ', data);
    }
  }

  /**
   * Log operation start
   */
  start(operation: string): void {
    if (!this.shouldLog('info')) return;
    console.log(`${LogEmoji.start} [${this.prefix}] ${operation} started`);
  }

  /**
   * Log operation complete
   */
  complete(operation: string, duration?: number): void {
    if (!this.shouldLog('info')) return;
    const durationStr = duration ? ` (${duration}ms)` : '';
    console.log(`${LogEmoji.complete} [${this.prefix}] ${operation} completed${durationStr}`);
  }

  /**
   * Log operation failed
   */
  failed(operation: string, error?: Error | string): void {
    if (!this.shouldLog('error')) return;
    const errorMsg = error
      ? typeof error === 'string' ? error : error.message
      : 'unknown error';
    console.error(`${LogEmoji.failed} [${this.prefix}] ${operation} failed: ${errorMsg}`);
  }

  /**
   * Log a phase/step
   */
  phase(name: string, status: 'start' | 'complete' | 'skip' = 'start'): void {
    if (!this.shouldLog('info')) return;
    const emoji = status === 'start' ? LogEmoji.phase
      : status === 'complete' ? LogEmoji.complete
      : LogEmoji.skip;
    const verb = status === 'start' ? 'Starting'
      : status === 'complete' ? 'Completed'
      : 'Skipping';
    console.log(`${emoji} [${this.prefix}] ${verb} ${name}`);
  }

  /**
   * Log with custom emoji
   */
  custom(emoji: string, message: string, data?: any): void {
    if (!this.shouldLog('info')) return;
    console.log(`${emoji} [${this.prefix}] ${message}`);
    if (data !== undefined) {
      console.log('   ', data);
    }
  }

  /**
   * Create a child logger with extended prefix
   */
  child(childPrefix: string): LoggerInstance {
    return new LoggerInstance(`${this.prefix}:${childPrefix}`, this.minLevel);
  }

  /**
   * Time an async operation and log duration
   */
  async timed<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    const startTime = Date.now();
    this.start(operation);

    try {
      const result = await fn();
      this.complete(operation, Date.now() - startTime);
      return result;
    } catch (error: any) {
      this.failed(operation, error);
      throw error;
    }
  }

  /**
   * Time a sync operation and log duration
   */
  timedSync<T>(operation: string, fn: () => T): T {
    const startTime = Date.now();
    this.start(operation);

    try {
      const result = fn();
      this.complete(operation, Date.now() - startTime);
      return result;
    } catch (error: any) {
      this.failed(operation, error);
      throw error;
    }
  }
}

/**
 * Logger factory
 */
export class Logger {
  private static instances: Map<string, LoggerInstance> = new Map();
  private static globalLevel: LogLevel = 'info';

  /**
   * Set the global log level
   */
  static setLevel(level: LogLevel): void {
    this.globalLevel = level;
  }

  /**
   * Create or get a logger instance for a prefix
   */
  static create(prefix: string, level?: LogLevel): LoggerInstance {
    const key = `${prefix}:${level || this.globalLevel}`;

    if (!this.instances.has(key)) {
      this.instances.set(key, new LoggerInstance(prefix, level || this.globalLevel));
    }

    return this.instances.get(key)!;
  }

  /**
   * Quick log methods without creating an instance
   */
  static debug(prefix: string, message: string, data?: any): void {
    this.create(prefix).debug(message, data);
  }

  static info(prefix: string, message: string, data?: any): void {
    this.create(prefix).info(message, data);
  }

  static warn(prefix: string, message: string, data?: any): void {
    this.create(prefix).warn(message, data);
  }

  static error(prefix: string, message: string, error?: Error | any): void {
    this.create(prefix).error(message, error);
  }

  static success(prefix: string, message: string, data?: any): void {
    this.create(prefix).success(message, data);
  }
}

// Export convenience factory
export const createLogger = Logger.create.bind(Logger);

// Export common emojis for direct use
export const Emoji = LogEmoji;

export default Logger;
