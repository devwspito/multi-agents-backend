/**
 * AgentActivityService - Real-time Agent Activity Streaming
 *
 * Captures granular tool calls from Claude SDK and emits them
 * to the frontend for OpenCode-style real-time display.
 *
 * Events emitted:
 * - activity:read - File read with content preview
 * - activity:edit - File edit with diff
 * - activity:write - New file created
 * - activity:bash - Command execution with output
 * - activity:think - Agent reasoning/thinking
 * - activity:tool - Other tool usage
 */

import { Server as SocketServer } from 'socket.io';
import { NotificationService } from './NotificationService';

export interface ActivityEvent {
  taskId: string;
  agentName: string;
  type: 'read' | 'edit' | 'write' | 'bash' | 'think' | 'tool' | 'error' | 'message';
  timestamp: Date;
  file?: string;
  content?: string;
  diff?: DiffInfo;
  command?: string;
  output?: string;
  toolName?: string;
  toolInput?: any;
  duration?: number;
}

export interface DiffInfo {
  oldContent?: string;
  newContent?: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  oldNum?: number;
  newNum?: number;
}

/**
 * Service for emitting real-time agent activity events
 */
export class AgentActivityService {
  private static getIO(): SocketServer | null {
    return (global as any).io || null;
  }

  /**
   * Emit a file read activity
   */
  static emitRead(
    taskId: string,
    agentName: string,
    file: string,
    contentPreview?: string
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'read',
      timestamp: new Date(),
      file,
      content: contentPreview ? this.truncateContent(contentPreview, 500) : undefined,
    };

    this.emitActivity(taskId, activity);

    // Also emit console log for backwards compatibility
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `📖 [${agentName}] Read: ${file}`
    );
  }

  /**
   * Emit a file edit activity with diff
   */
  static emitEdit(
    taskId: string,
    agentName: string,
    file: string,
    oldContent: string,
    newContent: string
  ): void {
    const diff = this.computeDiff(oldContent, newContent);

    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'edit',
      timestamp: new Date(),
      file,
      diff,
    };

    this.emitActivity(taskId, activity);

    // Count changes for log
    const additions = diff.lines.filter(l => l.type === 'add').length;
    const deletions = diff.lines.filter(l => l.type === 'remove').length;

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `✏️ [${agentName}] Edit: ${file} (+${additions}/-${deletions})`
    );
  }

  /**
   * Emit a new file write activity
   */
  static emitWrite(
    taskId: string,
    agentName: string,
    file: string,
    contentPreview?: string
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'write',
      timestamp: new Date(),
      file,
      content: contentPreview ? this.truncateContent(contentPreview, 500) : undefined,
    };

    this.emitActivity(taskId, activity);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `📝 [${agentName}] Write: ${file}`
    );
  }

  /**
   * Emit a bash command execution activity
   */
  static emitBash(
    taskId: string,
    agentName: string,
    command: string,
    output?: string,
    exitCode?: number
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'bash',
      timestamp: new Date(),
      command,
      output: output ? this.truncateContent(output, 1000) : undefined,
    };

    this.emitActivity(taskId, activity);

    const statusIcon = exitCode === 0 ? '✅' : exitCode ? '❌' : '⚡';
    NotificationService.emitConsoleLog(
      taskId,
      exitCode === 0 ? 'info' : exitCode ? 'error' : 'info',
      `${statusIcon} [${agentName}] $ ${this.truncateContent(command, 100)}`
    );
  }

  /**
   * Emit agent thinking/reasoning
   */
  static emitThinking(
    taskId: string,
    agentName: string,
    thought: string
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'think',
      timestamp: new Date(),
      content: this.truncateContent(thought, 500),
    };

    this.emitActivity(taskId, activity);
  }

  /**
   * Emit generic tool usage
   */
  static emitToolUse(
    taskId: string,
    agentName: string,
    toolName: string,
    toolInput: any
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'tool',
      timestamp: new Date(),
      toolName,
      toolInput: this.sanitizeToolInput(toolInput),
    };

    this.emitActivity(taskId, activity);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🔧 [${agentName}] Tool: ${toolName}`
    );
  }

  /**
   * Emit error activity
   */
  static emitError(
    taskId: string,
    agentName: string,
    error: string
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'error',
      timestamp: new Date(),
      content: error,
    };

    this.emitActivity(taskId, activity);
  }

  /**
   * Emit a text message from agent
   */
  static emitMessage(
    taskId: string,
    agentName: string,
    message: string
  ): void {
    const activity: ActivityEvent = {
      taskId,
      agentName,
      type: 'message',
      timestamp: new Date(),
      content: message,
    };

    this.emitActivity(taskId, activity);
  }

  /**
   * Parse Claude SDK stream events and emit appropriate activities
   *
   * This should be called from the agent execution code to capture
   * real-time events from the SDK.
   */
  static parseSDKEvent(
    taskId: string,
    agentName: string,
    event: any
  ): void {
    if (!event) return;

    // Handle different event types from Claude SDK
    switch (event.type) {
      case 'content_block_start':
        if (event.content_block?.type === 'tool_use') {
          // Tool call starting
          const toolName = event.content_block.name;
          this.emitToolUse(taskId, agentName, toolName, {});
        }
        break;

      case 'content_block_delta':
        if (event.delta?.type === 'text_delta') {
          // Streaming text - could be thinking or response
          // Don't emit every delta, batch them
        } else if (event.delta?.type === 'input_json_delta') {
          // Tool input being streamed
        }
        break;

      case 'content_block_stop':
        // Content block finished
        break;

      case 'message_delta':
        // Message-level updates
        break;

      case 'message_stop':
        // Message completed
        break;
    }
  }

  /**
   * Process a completed tool call result
   */
  static processToolResult(
    taskId: string,
    agentName: string,
    toolName: string,
    toolInput: any,
    toolOutput: any
  ): void {
    // Emit specific activity based on tool name
    switch (toolName) {
      case 'Read':
      case 'read':
        this.emitRead(
          taskId,
          agentName,
          toolInput.file_path || toolInput.path,
          typeof toolOutput === 'string' ? toolOutput : toolOutput?.content
        );
        break;

      case 'Edit':
      case 'edit':
        this.emitEdit(
          taskId,
          agentName,
          toolInput.file_path || toolInput.path,
          toolInput.old_string || '',
          toolInput.new_string || ''
        );
        break;

      case 'Write':
      case 'write':
        this.emitWrite(
          taskId,
          agentName,
          toolInput.file_path || toolInput.path,
          toolInput.content
        );
        break;

      case 'Bash':
      case 'bash':
      case 'execute_command':
        this.emitBash(
          taskId,
          agentName,
          toolInput.command,
          typeof toolOutput === 'string' ? toolOutput : toolOutput?.output,
          toolOutput?.exit_code
        );
        break;

      case 'Glob':
      case 'glob':
        this.emitToolUse(taskId, agentName, 'Glob', {
          pattern: toolInput.pattern,
          results: Array.isArray(toolOutput) ? toolOutput.length : 0
        });
        break;

      case 'Grep':
      case 'grep':
        this.emitToolUse(taskId, agentName, 'Grep', {
          pattern: toolInput.pattern,
          results: Array.isArray(toolOutput) ? toolOutput.length : 0
        });
        break;

      default:
        this.emitToolUse(taskId, agentName, toolName, toolInput);
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private static async emitActivity(taskId: string, activity: ActivityEvent): Promise<void> {
    const io = this.getIO();
    if (!io) {
      console.warn(`⚠️ [AgentActivityService] Socket.IO not available, cannot emit activity`);
      return;
    }

    // Emit to task room (real-time)
    console.log(`📡 [AgentActivityService] Emitting ${activity.type} activity for ${activity.agentName} to task:${taskId}`);
    io.to(`task:${taskId}`).emit('agent:activity', activity);

    // Persist to database (survive refresh)
    try {
      const mongoose = await import('mongoose');
      if (!mongoose.default.Types.ObjectId.isValid(taskId)) {
        return; // Skip persistence for invalid IDs
      }

      const { Task } = await import('../models/Task');
      await Task.findByIdAndUpdate(
        taskId,
        {
          $push: {
            activities: {
              agentName: activity.agentName,
              type: activity.type,
              timestamp: activity.timestamp,
              file: activity.file,
              content: activity.content,
              command: activity.command,
              output: activity.output,
              toolName: activity.toolName,
              toolInput: activity.toolInput,
              diff: activity.diff,
            },
          },
        },
        { new: false }
      );
    } catch (error) {
      console.error(`❌ [AgentActivityService] Error persisting activity to DB:`, error);
      // Don't throw - activity emission shouldn't break orchestration
    }
  }

  private static truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  }

  private static sanitizeToolInput(input: any): any {
    if (!input) return {};

    // Remove potentially large or sensitive fields
    const sanitized = { ...input };

    // Truncate long strings
    for (const key of Object.keys(sanitized)) {
      if (typeof sanitized[key] === 'string' && sanitized[key].length > 200) {
        sanitized[key] = sanitized[key].substring(0, 200) + '...';
      }
    }

    return sanitized;
  }

  /**
   * Compute a simple line-by-line diff
   */
  private static computeDiff(oldContent: string, newContent: string): DiffInfo {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    const diffLines: DiffLine[] = [];

    // Simple LCS-based diff
    const lcs = this.longestCommonSubsequence(oldLines, newLines);

    let oldIdx = 0;
    let newIdx = 0;
    let lcsIdx = 0;
    let oldNum = 1;
    let newNum = 1;

    while (oldIdx < oldLines.length || newIdx < newLines.length) {
      if (lcsIdx < lcs.length && oldIdx < oldLines.length && oldLines[oldIdx] === lcs[lcsIdx]) {
        if (newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
          // Context line (unchanged)
          diffLines.push({
            type: 'context',
            content: oldLines[oldIdx],
            oldNum: oldNum++,
            newNum: newNum++,
          });
          oldIdx++;
          newIdx++;
          lcsIdx++;
        } else {
          // Line added in new
          diffLines.push({
            type: 'add',
            content: newLines[newIdx],
            newNum: newNum++,
          });
          newIdx++;
        }
      } else if (lcsIdx < lcs.length && newIdx < newLines.length && newLines[newIdx] === lcs[lcsIdx]) {
        // Line removed from old
        diffLines.push({
          type: 'remove',
          content: oldLines[oldIdx],
          oldNum: oldNum++,
        });
        oldIdx++;
      } else if (oldIdx < oldLines.length) {
        // Line removed
        diffLines.push({
          type: 'remove',
          content: oldLines[oldIdx],
          oldNum: oldNum++,
        });
        oldIdx++;
      } else if (newIdx < newLines.length) {
        // Line added
        diffLines.push({
          type: 'add',
          content: newLines[newIdx],
          newNum: newNum++,
        });
        newIdx++;
      }
    }

    // Limit diff lines for display, but ALWAYS include full content for editing
    const maxLines = 50;
    let displayLines = diffLines;

    if (diffLines.length > maxLines) {
      const half = Math.floor(maxLines / 2);
      displayLines = [
        ...diffLines.slice(0, half),
        { type: 'context', content: `... ${diffLines.length - maxLines} more lines ...` },
        ...diffLines.slice(-half),
      ];
    }

    // ALWAYS include full content for Human-in-the-Loop code editing
    return {
      oldContent: oldContent,
      newContent: newContent,
      lines: displayLines,
    };
  }

  /**
   * Compute Longest Common Subsequence for diff
   */
  private static longestCommonSubsequence(a: string[], b: string[]): string[] {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    // Backtrack to get LCS
    const lcs: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        lcs.unshift(a[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return lcs;
  }
}

export default AgentActivityService;
