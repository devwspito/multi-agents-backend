/**
 * LogService - Centralized Structured Logging System
 *
 * Replaces scattered console.log statements with structured, queryable logs
 * Stores logs in MongoDB for frontend consumption and debugging
 * Provides human-readable console output with colors and emojis
 * Includes automatic secrets sanitization for security
 */

import mongoose from 'mongoose';
import { TaskLog, LogLevel, LogCategory } from '../../models/TaskLog';
import { SecretsSanitizer } from '../../utils/secretsSanitizer';

/**
 * Log Context - Everything you might want to include in a log
 */
export interface LogContext {
  taskId: string | mongoose.Types.ObjectId;
  level?: LogLevel;
  category?: LogCategory;
  phase?: 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'auto-merge' | 'e2e' | 'contract-testing' | 'completed' | 'multi-team' | 'error-resolution';
  agentType?: 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'test-creator' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'team-orchestration' | 'auto-merge' | 'e2e-tester' | 'contract-fixer' | 'contract-tester' | 'error-detective' | 'story-merge-agent' | 'git-flow-manager';
  agentInstanceId?: string;
  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;
  multiTeam?: boolean;
  metadata?: Record<string, any>;
  sessionId?: string;
  error?: Error | { message: string; stack?: string; code?: string };
  validationError?: boolean;
}

/**
 * Console Colors for better readability
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  // Text colors
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

/**
 * Emojis for visual clarity
 */
const emojis = {
  INFO: 'ℹ️',
  SUCCESS: '✅',
  WARN: '⚠️',
  ERROR: '❌',
  DEBUG: '🔍',
  // Context
  agent: '🤖',
  developer: '👨‍💻',
  story: '📝',
  epic: '📦',
  judge: '⚖️',
  git: '🔀',
  pr: '🔀',
  quality: '💎',
};

export class LogService {
  /**
   * Log INFO level message
   */
  static async info(message: string, context: LogContext): Promise<void> {
    await this.log(message, { ...context, level: 'INFO', category: context.category || 'system' });
  }

  /**
   * Log SUCCESS level message
   */
  static async success(message: string, context: LogContext): Promise<void> {
    await this.log(message, { ...context, level: 'SUCCESS', category: context.category || 'system' });
  }

  /**
   * Log WARN level message
   */
  static async warn(message: string, context: LogContext): Promise<void> {
    await this.log(message, { ...context, level: 'WARN', category: context.category || 'system' });
  }

  /**
   * Log ERROR level message
   */
  static async error(message: string, context: LogContext, error?: Error): Promise<void> {
    const errorContext = error
      ? {
          error: {
            message: error.message,
            stack: error.stack,
            code: (error as any).code,
          },
        }
      : context.error
      ? {
          error:
            context.error instanceof Error
              ? {
                  message: context.error.message,
                  stack: context.error.stack,
                  code: (context.error as any).code,
                }
              : context.error,
        }
      : {};

    await this.log(message, {
      ...context,
      level: 'ERROR',
      category: context.category || 'error',
      ...errorContext,
    });
  }

  /**
   * Log DEBUG level message (only in development)
   */
  static async debug(message: string, context: LogContext): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      await this.log(message, { ...context, level: 'DEBUG', category: context.category || 'system' });
    }
  }

  /**
   * Core logging function with automatic secrets sanitization
   */
  private static async log(message: string, context: LogContext & { level: LogLevel; category: LogCategory }): Promise<void> {
    const timestamp = new Date();

    // SECURITY: Sanitize message and context before any output
    const sanitizedMessage = SecretsSanitizer.sanitize(message);
    const sanitizedContext = SecretsSanitizer.sanitizeObject(context);

    // Detect if secrets were found (for security audit)
    const detectedSecrets = SecretsSanitizer.detectSecrets(message);
    if (detectedSecrets.length > 0) {
      console.warn(`⚠️  [LogService] Sanitized ${detectedSecrets.length} secret(s) in log: ${detectedSecrets.join(', ')}`);
    }

    // 1. Format and print to console
    this.logToConsole(sanitizedMessage, sanitizedContext, timestamp);

    // 2. Store in MongoDB (async, don't block)
    this.storeInDatabase(sanitizedMessage, sanitizedContext, timestamp).catch((err) => {
      console.error('[LogService] Failed to store log:', err.message);
    });

    // 3. Emit to WebSocket for real-time frontend updates
    this.emitToWebSocket(sanitizedMessage, sanitizedContext, timestamp).catch((err) => {
      // Silent fail - don't disrupt logging if socket fails
      console.error('[LogService] Failed to emit to WebSocket:', err.message);
    });
  }

  /**
   * Format log for console output with colors and emojis
   */
  private static logToConsole(message: string, context: LogContext & { level: LogLevel; category: LogCategory }, timestamp: Date): void {
    const time = timestamp.toISOString().substring(11, 23); // HH:MM:SS.mmm
    const emoji = emojis[context.level];
    const categoryEmoji = emojis[context.category as keyof typeof emojis] || '';

    // Color based on level
    let color = colors.white;
    switch (context.level) {
      case 'ERROR':
        color = colors.red;
        break;
      case 'WARN':
        color = colors.yellow;
        break;
      case 'SUCCESS':
        color = colors.green;
        break;
      case 'INFO':
        color = colors.blue;
        break;
      case 'DEBUG':
        color = colors.gray;
        break;
    }

    // Build context string
    const contextParts: string[] = [];
    if (context.phase) contextParts.push(`Phase: ${context.phase}`);
    if (context.agentType) contextParts.push(`Agent: ${context.agentInstanceId || context.agentType}`);
    if (context.epicName) contextParts.push(`Epic: ${context.epicName}`);
    if (context.storyTitle) contextParts.push(`Story: ${context.storyTitle}`);

    const contextStr = contextParts.length > 0 ? colors.dim + ` [${contextParts.join(' | ')}]` + colors.reset : '';

    // Build metadata string
    let metadataStr = '';
    if (context.metadata && Object.keys(context.metadata).length > 0) {
      const metaParts = [];
      if (context.metadata.score !== undefined) metaParts.push(`score: ${context.metadata.score}/100`);
      if (context.metadata.cost !== undefined) metaParts.push(`cost: $${context.metadata.cost.toFixed(4)}`);
      if (context.metadata.duration !== undefined) metaParts.push(`duration: ${context.metadata.duration}ms`);
      if (context.metadata.retryCount !== undefined) metaParts.push(`retry: ${context.metadata.retryCount}/3`);

      if (metaParts.length > 0) {
        metadataStr = colors.dim + ` {${metaParts.join(', ')}}` + colors.reset;
      }
    }

    // Format final message
    const categoryTag = categoryEmoji ? `${categoryEmoji} [${context.category.toUpperCase()}]` : `[${context.category.toUpperCase()}]`;
    const levelTag = `${emoji} ${context.level}`;

    console.log(`${colors.gray}[${time}]${colors.reset} ${color}${levelTag}${colors.reset} ${categoryTag} ${message}${contextStr}${metadataStr}`);

    // If error, print stack trace
    if (context.error && context.error.stack) {
      console.log(colors.red + context.error.stack + colors.reset);
    }
  }

  /**
   * Store log in MongoDB
   */
  private static async storeInDatabase(
    message: string,
    context: LogContext & { level: LogLevel; category: LogCategory },
    timestamp: Date
  ): Promise<void> {
    try {
      await TaskLog.create({
        taskId: context.taskId,
        timestamp,
        level: context.level,
        category: context.category,
        message,
        phase: context.phase,
        agentType: context.agentType,
        agentInstanceId: context.agentInstanceId,
        epicId: context.epicId,
        epicName: context.epicName,
        storyId: context.storyId,
        storyTitle: context.storyTitle,
        metadata: context.metadata,
        error: context.error as any,
        sessionId: context.sessionId,
      });
    } catch (err) {
      // Fallback to console if DB fails
      console.error('[LogService] Failed to store in DB:', err);
    }
  }

  /**
   * Emit log to WebSocket for real-time frontend updates
   */
  private static async emitToWebSocket(
    message: string,
    context: LogContext & { level: LogLevel; category: LogCategory },
    _timestamp: Date
  ): Promise<void> {
    // Import NotificationService dynamically to avoid circular dependencies
    const { NotificationService } = await import('../NotificationService');

    // Convert taskId to string if it's an ObjectId
    const taskIdStr = context.taskId.toString();

    // Map LogLevel to console levels
    let consoleLevel: 'log' | 'info' | 'warn' | 'error' = 'log';
    switch (context.level) {
      case 'ERROR':
        consoleLevel = 'error';
        break;
      case 'WARN':
        consoleLevel = 'warn';
        break;
      case 'INFO':
      case 'SUCCESS':
        consoleLevel = 'info';
        break;
      case 'DEBUG':
      default:
        consoleLevel = 'log';
        break;
    }

    // Format message with context for frontend display
    let formattedMessage = message;

    // Add agent context if present
    if (context.agentType) {
      const agentName = context.agentInstanceId || context.agentType;
      formattedMessage = `[${agentName}] ${message}`;
    }

    // Add phase context if present
    if (context.phase) {
      formattedMessage = `[${context.phase.toUpperCase()}] ${formattedMessage}`;
    }

    // Add epic/story context if present
    if (context.epicName) {
      formattedMessage += ` (Epic: ${context.epicName})`;
    }
    if (context.storyTitle) {
      formattedMessage += ` (Story: ${context.storyTitle})`;
    }

    // Emit using NotificationService
    await NotificationService.emitConsoleLog(taskIdStr, consoleLevel, formattedMessage);
  }

  /**
   * Convenience: Log agent started
   */
  static async agentStarted(
    agentType: 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'test-creator' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'team-orchestration' | 'auto-merge' | 'e2e-tester' | 'contract-fixer' | 'contract-tester',
    taskId: string,
    context?: Partial<LogContext>
  ): Promise<void> {
    await this.info(`${agentType.replace('-', ' ').toUpperCase()} started`, {
      taskId,
      category: 'agent',
      agentType,
      ...context,
    });
  }

  /**
   * Convenience: Log agent completed
   */
  static async agentCompleted(
    agentType: 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'test-creator' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'team-orchestration' | 'auto-merge' | 'e2e-tester' | 'contract-fixer' | 'contract-tester',
    taskId: string,
    context?: Partial<LogContext>
  ): Promise<void> {
    await this.success(`${agentType.replace('-', ' ').toUpperCase()} completed`, {
      taskId,
      category: 'agent',
      agentType,
      ...context,
    });
  }

  /**
   * Convenience: Log agent failed
   */
  static async agentFailed(
    agentType: 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'test-creator' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'team-orchestration' | 'auto-merge' | 'e2e-tester' | 'contract-fixer' | 'contract-tester',
    taskId: string,
    error: Error | string,
    context?: Partial<LogContext>
  ): Promise<void> {
    await this.error(
      `${agentType.replace('-', ' ').toUpperCase()} failed`,
      {
        taskId,
        category: 'agent',
        agentType,
        error: typeof error === 'string' ? { message: error } : error,
        ...context,
      },
      typeof error === 'string' ? undefined : error
    );
  }

  /**
   * Convenience: Log story started
   */
  static async storyStarted(taskId: string, storyId: string, storyTitle: string, context?: Partial<LogContext>): Promise<void> {
    await this.info(`Story started: ${storyTitle}`, {
      taskId,
      category: 'story',
      storyId,
      storyTitle,
      ...context,
    });
  }

  /**
   * Convenience: Log story completed
   */
  static async storyCompleted(taskId: string, storyId: string, storyTitle: string, context?: Partial<LogContext>): Promise<void> {
    await this.success(`Story completed: ${storyTitle}`, {
      taskId,
      category: 'story',
      storyId,
      storyTitle,
      ...context,
    });
  }

  /**
   * Convenience: Log story failed
   */
  static async storyFailed(taskId: string, storyId: string, storyTitle: string, reason: string, context?: Partial<LogContext>): Promise<void> {
    await this.error(`Story failed: ${storyTitle} (${reason})`, {
      taskId,
      category: 'story',
      storyId,
      storyTitle,
      metadata: { reason },
      ...context,
    });
  }

  /**
   * Convenience: Log Judge evaluation
   */
  static async judgeEvaluation(
    taskId: string,
    score: number,
    verdict: string,
    approved: boolean,
    context?: Partial<LogContext>
  ): Promise<void> {
    const method = approved ? this.success : score < 50 ? this.error : this.warn;

    await method(`Judge evaluation: ${score}/100 (${verdict}) ${approved ? '✅' : '❌'}`, {
      taskId,
      category: 'judge',
      agentType: 'judge',
      metadata: { score, verdict, approved },
      ...context,
    });
  }

  /**
   * Convenience: Log PR created
   */
  static async prCreated(taskId: string, prNumber: number, prUrl: string, epicName: string, context?: Partial<LogContext>): Promise<void> {
    await this.success(`PR created: #${prNumber} for ${epicName}`, {
      taskId,
      category: 'pr',
      epicName,
      metadata: { prNumber, prUrl },
      ...context,
    });
  }

  /**
   * Query logs for a task
   */
  static async getTaskLogs(
    taskId: string,
    filters?: {
      level?: LogLevel;
      category?: LogCategory;
      agentType?: string;
      epicId?: string;
      storyId?: string;
      limit?: number;
      startDate?: Date;
      endDate?: Date;
    }
  ) {
    const query: any = { taskId: new mongoose.Types.ObjectId(taskId) };

    if (filters?.level) query.level = filters.level;
    if (filters?.category) query.category = filters.category;
    if (filters?.agentType) query.agentType = filters.agentType;
    if (filters?.epicId) query.epicId = filters.epicId;
    if (filters?.storyId) query.storyId = filters.storyId;

    if (filters?.startDate || filters?.endDate) {
      query.timestamp = {};
      if (filters.startDate) query.timestamp.$gte = filters.startDate;
      if (filters.endDate) query.timestamp.$lte = filters.endDate;
    }

    return await TaskLog.find(query)
      .sort({ timestamp: -1 })
      .limit(filters?.limit || 1000)
      .lean();
  }

  /**
   * Get activity timeline for a task (human-readable)
   */
  static async getActivityTimeline(taskId: string) {
    const logs = await this.getTaskLogs(taskId, {
      category: 'agent', // Focus on major milestones
      limit: 100,
    });

    return logs.reverse().map((log) => ({
      timestamp: log.timestamp,
      message: log.message,
      level: log.level,
      agent: log.agentType,
      phase: log.phase,
      metadata: log.metadata,
    }));
  }
}
