/**
 * Console Interceptor
 *
 * Intercepts all console.log, console.info, console.warn, console.error calls
 * and emits them to the WebSocket for real-time frontend display in ConsoleViewer
 */

import { NotificationService } from '../services/NotificationService';

// Store original console methods
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
};

// Regular expression to extract task ID from log messages
const TASK_ID_REGEX = /task[:\s]+([a-f0-9]{24})|taskId[:\s]+([a-f0-9]{24})|📌.*task room: ([a-f0-9]{24})/i;

/**
 * Extract task ID from message or arguments
 */
function extractTaskId(args: any[]): string | null {
  for (const arg of args) {
    if (typeof arg === 'string') {
      const match = arg.match(TASK_ID_REGEX);
      if (match) {
        return match[1] || match[2] || match[3];
      }
    } else if (typeof arg === 'object' && arg !== null) {
      // Check if object has taskId property
      if (arg.taskId && typeof arg.taskId === 'string' && arg.taskId.length === 24) {
        return arg.taskId;
      }
      // Check nested properties
      if (arg.task && arg.task._id) {
        const id = arg.task._id.toString();
        if (id.length === 24) return id;
      }
    }
  }
  return null;
}

/**
 * Format arguments into a single message string
 */
function formatMessage(args: any[]): string {
  return args.map(arg => {
    if (typeof arg === 'object') {
      try {
        return JSON.stringify(arg, null, 2);
      } catch {
        return String(arg);
      }
    }
    return String(arg);
  }).join(' ');
}

/**
 * Intercept console method
 */
function interceptConsoleMethod(
  method: 'log' | 'info' | 'warn' | 'error',
  originalMethod: (...args: any[]) => void
) {
  return function(...args: any[]) {
    // Always call original console method
    originalMethod.apply(console, args);

    // Try to extract task ID and emit to WebSocket
    try {
      const taskId = extractTaskId(args);
      if (taskId) {
        const message = formatMessage(args);

        // Emit to WebSocket asynchronously (don't block console)
        NotificationService.emitConsoleLog(taskId, method, message).catch(() => {
          // Silent fail - don't disrupt console logging
        });
      }
    } catch (error) {
      // Silent fail - don't disrupt console logging
    }
  };
}

/**
 * Setup console interceptor
 * Call this once during server initialization
 */
export function setupConsoleInterceptor(): void {
  console.log = interceptConsoleMethod('log', originalConsole.log);
  console.info = interceptConsoleMethod('info', originalConsole.info);
  console.warn = interceptConsoleMethod('warn', originalConsole.warn);
  console.error = interceptConsoleMethod('error', originalConsole.error);

  originalConsole.log('✅ Console interceptor initialized - logs will be emitted to WebSocket');
}

/**
 * Restore original console methods (for testing)
 */
export function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}