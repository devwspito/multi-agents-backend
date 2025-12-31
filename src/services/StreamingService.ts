/**
 * StreamingService - Claude Code Style Real-Time Streaming
 *
 * Provides enhanced real-time streaming capabilities:
 * - Token-by-token agent response streaming
 * - Tool execution streaming with progress indicators
 * - File change streaming in real-time
 * - Thinking/reasoning indicators
 * - Progress spinners for long operations
 *
 * This enables Claude Code-like real-time feedback in the UI.
 */

import { Server as SocketServer } from 'socket.io';
import { EventEmitter } from 'events';

/**
 * Stream types
 */
export type StreamType =
  | 'token'           // Token-by-token text
  | 'thinking'        // Agent thinking/reasoning
  | 'tool_start'      // Tool execution started
  | 'tool_progress'   // Tool execution progress
  | 'tool_complete'   // Tool execution completed
  | 'file_change'     // File was modified
  | 'command_output'  // Shell command output
  | 'progress'        // Progress indicator
  | 'status';         // Status update

/**
 * Stream event data
 */
export interface StreamEvent {
  type: StreamType;
  taskId: string;
  agentType?: string;
  timestamp: Date;
  data: StreamData;
}

export interface StreamData {
  // Token streaming
  token?: string;
  isComplete?: boolean;

  // Tool streaming
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, any>;
  toolOutput?: any;
  toolDuration?: number;
  toolProgress?: number; // 0-100

  // File changes
  filePath?: string;
  changeType?: 'created' | 'modified' | 'deleted';
  diff?: string;
  lineCount?: number;

  // Command output
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;

  // Progress
  current?: number;
  total?: number;
  percentage?: number;
  message?: string;

  // Thinking
  thinkingText?: string;

  // Status
  status?: 'running' | 'paused' | 'completed' | 'failed';
}

/**
 * Active stream state
 */
interface ActiveStream {
  taskId: string;
  agentType: string;
  startedAt: Date;
  tokenBuffer: string[];
  lastActivity: Date;
  status: 'active' | 'paused' | 'completed';
}

class StreamingServiceClass extends EventEmitter {
  private activeStreams: Map<string, ActiveStream> = new Map();
  private tokenBufferFlushInterval = 50; // ms between token flushes
  private bufferFlushTimers: Map<string, NodeJS.Timeout> = new Map();

  private getIO(): SocketServer | null {
    return (global as any).io || null;
  }

  /**
   * Start a new streaming session for an agent
   */
  startStream(taskId: string, agentType: string): string {
    const streamId = `${taskId}:${agentType}:${Date.now()}`;

    this.activeStreams.set(streamId, {
      taskId,
      agentType,
      startedAt: new Date(),
      tokenBuffer: [],
      lastActivity: new Date(),
      status: 'active',
    });

    this.emit('stream:start', { streamId, taskId, agentType });

    // Emit to frontend
    this.emitStreamEvent({
      type: 'status',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        status: 'running',
        message: `${agentType} started`,
      },
    });

    return streamId;
  }

  /**
   * End a streaming session
   */
  endStream(streamId: string): void {
    const stream = this.activeStreams.get(streamId);
    if (!stream) return;

    // Flush any remaining tokens
    this.flushTokenBuffer(streamId);

    stream.status = 'completed';

    this.emitStreamEvent({
      type: 'status',
      taskId: stream.taskId,
      agentType: stream.agentType,
      timestamp: new Date(),
      data: {
        status: 'completed',
        message: `${stream.agentType} completed`,
      },
    });

    // Cleanup
    const timer = this.bufferFlushTimers.get(streamId);
    if (timer) {
      clearInterval(timer);
      this.bufferFlushTimers.delete(streamId);
    }

    this.activeStreams.delete(streamId);
    this.emit('stream:end', { streamId });
  }

  /**
   * Stream a token (character or word)
   */
  streamToken(streamId: string, token: string): void {
    const stream = this.activeStreams.get(streamId);
    if (!stream || stream.status !== 'active') return;

    stream.tokenBuffer.push(token);
    stream.lastActivity = new Date();

    // Set up buffer flush if not already running
    if (!this.bufferFlushTimers.has(streamId)) {
      const timer = setInterval(
        () => this.flushTokenBuffer(streamId),
        this.tokenBufferFlushInterval
      );
      this.bufferFlushTimers.set(streamId, timer);
    }
  }

  /**
   * Flush accumulated tokens to frontend
   */
  private flushTokenBuffer(streamId: string): void {
    const stream = this.activeStreams.get(streamId);
    if (!stream || stream.tokenBuffer.length === 0) return;

    const tokens = stream.tokenBuffer.join('');
    stream.tokenBuffer = [];

    this.emitStreamEvent({
      type: 'token',
      taskId: stream.taskId,
      agentType: stream.agentType,
      timestamp: new Date(),
      data: {
        token: tokens,
        isComplete: false,
      },
    });
  }

  /**
   * Stream agent's thinking/reasoning
   */
  streamThinking(taskId: string, agentType: string, thinkingText: string): void {
    this.emitStreamEvent({
      type: 'thinking',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        thinkingText,
      },
    });
  }

  /**
   * Stream tool execution start
   */
  streamToolStart(
    taskId: string,
    agentType: string,
    toolName: string,
    toolId: string,
    input: Record<string, any>
  ): void {
    this.emitStreamEvent({
      type: 'tool_start',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        toolName,
        toolId,
        toolInput: this.sanitizeToolInput(input),
        message: `Executing ${toolName}...`,
      },
    });
  }

  /**
   * Stream tool execution progress
   */
  streamToolProgress(
    taskId: string,
    agentType: string,
    toolName: string,
    toolId: string,
    progress: number,
    message?: string
  ): void {
    this.emitStreamEvent({
      type: 'tool_progress',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        toolName,
        toolId,
        toolProgress: progress,
        percentage: progress,
        message: message || `${toolName}: ${progress}%`,
      },
    });
  }

  /**
   * Stream tool execution completion
   */
  streamToolComplete(
    taskId: string,
    agentType: string,
    toolName: string,
    toolId: string,
    output: any,
    duration: number,
    success: boolean
  ): void {
    this.emitStreamEvent({
      type: 'tool_complete',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        toolName,
        toolId,
        toolOutput: this.truncateOutput(output),
        toolDuration: duration,
        status: success ? 'completed' : 'failed',
        message: success
          ? `${toolName} completed in ${duration}ms`
          : `${toolName} failed after ${duration}ms`,
      },
    });
  }

  /**
   * Stream file change event
   */
  streamFileChange(
    taskId: string,
    agentType: string,
    filePath: string,
    changeType: 'created' | 'modified' | 'deleted',
    diff?: string,
    lineCount?: number
  ): void {
    this.emitStreamEvent({
      type: 'file_change',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        filePath,
        changeType,
        diff: diff ? this.truncateDiff(diff) : undefined,
        lineCount,
        message: `${changeType}: ${filePath}`,
      },
    });
  }

  /**
   * Stream command output (for Bash tool)
   */
  streamCommandOutput(
    taskId: string,
    agentType: string,
    command: string,
    output: { stdout?: string; stderr?: string; exitCode?: number }
  ): void {
    this.emitStreamEvent({
      type: 'command_output',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        command: this.truncateCommand(command),
        stdout: output.stdout ? this.truncateOutput(output.stdout) : undefined,
        stderr: output.stderr ? this.truncateOutput(output.stderr) : undefined,
        exitCode: output.exitCode,
        status: output.exitCode === 0 ? 'completed' : 'failed',
      },
    });
  }

  /**
   * Stream progress update for long operations
   */
  streamProgress(
    taskId: string,
    agentType: string,
    current: number,
    total: number,
    message: string
  ): void {
    const percentage = Math.round((current / total) * 100);

    this.emitStreamEvent({
      type: 'progress',
      taskId,
      agentType,
      timestamp: new Date(),
      data: {
        current,
        total,
        percentage,
        message,
      },
    });
  }

  /**
   * Core method to emit stream events to WebSocket
   */
  private emitStreamEvent(event: StreamEvent): void {
    const io = this.getIO();
    if (!io) {
      // Fallback to internal event emitter
      this.emit('stream:event', event);
      return;
    }

    // Emit to task room
    io.to(`task:${event.taskId}`).emit('stream:event', event);

    // Also emit on specific channel for the event type
    io.to(`task:${event.taskId}`).emit(`stream:${event.type}`, event);

    // Emit internal event for hooks
    this.emit('stream:event', event);
  }

  /**
   * Sanitize tool input (remove sensitive data)
   */
  private sanitizeToolInput(input: Record<string, any>): Record<string, any> {
    const sanitized = { ...input };

    // Truncate large content
    if (sanitized.content && typeof sanitized.content === 'string') {
      if (sanitized.content.length > 500) {
        sanitized.content = sanitized.content.substring(0, 500) + '... [truncated]';
      }
    }

    // Hide sensitive fields
    const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      }
    }

    return sanitized;
  }

  /**
   * Truncate large outputs for streaming
   */
  private truncateOutput(output: any): string {
    if (output === null || output === undefined) return '';

    const str = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    const maxLength = 2000;

    if (str.length > maxLength) {
      return str.substring(0, maxLength) + `\n... [${str.length - maxLength} more characters]`;
    }

    return str;
  }

  /**
   * Truncate diff for streaming
   */
  private truncateDiff(diff: string): string {
    const maxLines = 50;
    const lines = diff.split('\n');

    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n... [${lines.length - maxLines} more lines]`;
    }

    return diff;
  }

  /**
   * Truncate command for display
   */
  private truncateCommand(command: string): string {
    const maxLength = 200;

    if (command.length > maxLength) {
      return command.substring(0, maxLength) + '...';
    }

    return command;
  }

  /**
   * Get active streams for a task
   */
  getActiveStreams(taskId: string): Array<{
    streamId: string;
    agentType: string;
    startedAt: Date;
    status: string;
  }> {
    const streams: Array<{
      streamId: string;
      agentType: string;
      startedAt: Date;
      status: string;
    }> = [];

    for (const [streamId, stream] of this.activeStreams.entries()) {
      if (stream.taskId === taskId) {
        streams.push({
          streamId,
          agentType: stream.agentType,
          startedAt: stream.startedAt,
          status: stream.status,
        });
      }
    }

    return streams;
  }

  /**
   * Check if any streams are active for a task
   */
  hasActiveStreams(taskId: string): boolean {
    for (const stream of this.activeStreams.values()) {
      if (stream.taskId === taskId && stream.status === 'active') {
        return true;
      }
    }
    return false;
  }

  /**
   * Pause all streams for a task (e.g., waiting for approval)
   */
  pauseStreams(taskId: string): void {
    for (const [streamId, stream] of this.activeStreams.entries()) {
      if (stream.taskId === taskId && stream.status === 'active') {
        stream.status = 'paused';
        this.flushTokenBuffer(streamId);

        this.emitStreamEvent({
          type: 'status',
          taskId,
          agentType: stream.agentType,
          timestamp: new Date(),
          data: {
            status: 'paused',
            message: 'Waiting for approval...',
          },
        });
      }
    }
  }

  /**
   * Resume paused streams
   */
  resumeStreams(taskId: string): void {
    for (const stream of this.activeStreams.values()) {
      if (stream.taskId === taskId && stream.status === 'paused') {
        stream.status = 'active';

        this.emitStreamEvent({
          type: 'status',
          taskId,
          agentType: stream.agentType,
          timestamp: new Date(),
          data: {
            status: 'running',
            message: 'Resuming...',
          },
        });
      }
    }
  }

  /**
   * Cleanup all streams (e.g., on server shutdown)
   */
  cleanup(): void {
    for (const [streamId, timer] of this.bufferFlushTimers.entries()) {
      clearInterval(timer);
      this.bufferFlushTimers.delete(streamId);
    }

    this.activeStreams.clear();
  }
}

// Singleton instance
export const StreamingService = new StreamingServiceClass();
