/**
 * Real-Time Logger Service
 *
 * Captura y muestra TODO lo que hacen los agentes en tiempo real:
 * - Código que escriben
 * - Archivos que modifican
 * - Comandos que ejecutan
 * - Decisiones que toman
 */

import * as fs from 'fs';
import * as path from 'path';
import { NotificationService } from './NotificationService';

interface LogEntry {
  timestamp: Date;
  taskId: string;
  agent: string;
  type: 'tool_use' | 'file_write' | 'file_edit' | 'command' | 'decision' | 'code' | 'error' | 'git';
  content: any;
  metadata?: any;
}

class RealTimeLogger {
  private logDir: string;
  private currentLogs: Map<string, LogEntry[]> = new Map();

  constructor() {
    this.logDir = path.join(process.cwd(), 'agent-logs');
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * Log a tool use (Write, Edit, Bash, etc.)
   */
  logToolUse(taskId: string, agent: string, toolName: string, input: any, result?: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'tool_use',
      content: {
        tool: toolName,
        input,
        result: result || 'pending'
      }
    };

    this.addLog(taskId, entry);
    this.emitRealTime(taskId, agent, entry);

    // Special handling for file operations
    if (toolName === 'Write' || toolName === 'Edit') {
      this.logFileOperation(taskId, agent, toolName, input);
    } else if (toolName === 'Bash') {
      this.logCommand(taskId, agent, input.command, result);
    }
  }

  /**
   * Log file write/edit operations with FULL CONTENT
   */
  private logFileOperation(taskId: string, agent: string, operation: string, input: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: operation === 'Write' ? 'file_write' : 'file_edit',
      content: {
        file: input.file_path || input.path,
        operation,
        content: input.content || input.new_string,
        oldContent: input.old_string
      }
    };

    this.addLog(taskId, entry);

    // Emit the ACTUAL CODE being written
    NotificationService.emitAgentMessage(
      taskId,
      agent,
      `📝 **${operation} File:** \`${entry.content.file}\`
\`\`\`${this.getLanguageFromFile(entry.content.file)}
${entry.content.content ? entry.content.content.substring(0, 1000) : 'No content'}
\`\`\`
${entry.content.content?.length > 1000 ? '... (truncated)' : ''}`
    );
  }

  /**
   * Log bash commands and their output
   */
  private logCommand(taskId: string, agent: string, command: string, output: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'command',
      content: {
        command,
        output: output?.stdout || output?.stderr || output
      }
    };

    this.addLog(taskId, entry);

    // Special handling for git commands
    if (command.includes('git')) {
      this.logGitOperation(taskId, agent, command, output);
    }

    NotificationService.emitAgentMessage(
      taskId,
      agent,
      `💻 **Command:** \`${command}\`
\`\`\`bash
${entry.content.output ? String(entry.content.output).substring(0, 500) : 'No output'}
\`\`\``
    );
  }

  /**
   * Log git operations (branch creation, commits, pushes)
   */
  logGitOperation(taskId: string, agent: string, command: string, output: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'git',
      content: {
        command,
        output
      }
    };

    this.addLog(taskId, entry);

    // Parse git command for important operations
    if (command.includes('checkout -b')) {
      const branch = command.match(/checkout -b ([\w\-\/]+)/)?.[1];
      NotificationService.emitAgentMessage(
        taskId,
        agent,
        `🌿 **Created Branch:** ${branch}`
      );
    } else if (command.includes('push')) {
      const branch = command.match(/push.*origin ([\w\-\/]+)/)?.[1] || 'current';
      NotificationService.emitAgentMessage(
        taskId,
        agent,
        `📤 **Pushed to GitHub:** ${branch}`
      );
    } else if (command.includes('commit')) {
      NotificationService.emitAgentMessage(
        taskId,
        agent,
        `💾 **Committed Changes**`
      );
    }
  }

  /**
   * Log agent decisions and reasoning
   */
  logDecision(taskId: string, agent: string, decision: string, reasoning: string) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'decision',
      content: {
        decision,
        reasoning
      }
    };

    this.addLog(taskId, entry);

    NotificationService.emitAgentMessage(
      taskId,
      agent,
      `🎯 **Decision:** ${decision}
💭 **Reasoning:** ${reasoning}`
    );
  }

  /**
   * Log actual code being generated
   */
  logCode(taskId: string, agent: string, language: string, code: string, description: string) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'code',
      content: {
        language,
        code,
        description
      }
    };

    this.addLog(taskId, entry);

    NotificationService.emitAgentMessage(
      taskId,
      agent,
      `🔨 **Generated ${language} Code:** ${description}
\`\`\`${language}
${code.substring(0, 1000)}
\`\`\`
${code.length > 1000 ? '... (truncated)' : ''}`
    );
  }

  /**
   * Log errors
   */
  logError(taskId: string, agent: string, error: string, context?: any) {
    const entry: LogEntry = {
      timestamp: new Date(),
      taskId,
      agent,
      type: 'error',
      content: {
        error,
        context
      }
    };

    this.addLog(taskId, entry);

    NotificationService.emitAgentMessage(
      taskId,
      agent,
      `❌ **Error:** ${error}
${context ? `Context: ${JSON.stringify(context, null, 2)}` : ''}`
    );
  }

  /**
   * Get all logs for a task
   */
  getTaskLogs(taskId: string): LogEntry[] {
    return this.currentLogs.get(taskId) || [];
  }

  /**
   * Save logs to file for persistence
   */
  saveLogsToFile(taskId: string) {
    const logs = this.getTaskLogs(taskId);
    const filePath = path.join(this.logDir, `${taskId}.json`);

    fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));

    // Also create a human-readable version
    const readableFile = path.join(this.logDir, `${taskId}.md`);
    const markdown = this.logsToMarkdown(logs);
    fs.writeFileSync(readableFile, markdown);

    console.log(`📁 Logs saved to: ${filePath}`);
    console.log(`📖 Readable logs: ${readableFile}`);
  }

  /**
   * Convert logs to readable markdown
   */
  private logsToMarkdown(logs: LogEntry[]): string {
    let md = '# Agent Activity Log\n\n';

    for (const log of logs) {
      md += `## ${log.timestamp.toISOString()} - ${log.agent}\n\n`;

      switch (log.type) {
        case 'file_write':
        case 'file_edit':
          md += `**${log.type === 'file_write' ? 'Created' : 'Edited'} File:** \`${log.content.file}\`\n\n`;
          md += '```' + this.getLanguageFromFile(log.content.file) + '\n';
          md += (log.content.content || '').substring(0, 2000) + '\n';
          md += '```\n\n';
          break;

        case 'command':
          md += `**Command:** \`${log.content.command}\`\n\n`;
          md += '```bash\n' + (log.content.output || '') + '\n```\n\n';
          break;

        case 'git':
          md += `**Git Operation:** \`${log.content.command}\`\n\n`;
          break;

        case 'code':
          md += `**Generated Code:** ${log.content.description}\n\n`;
          md += '```' + log.content.language + '\n';
          md += log.content.code + '\n';
          md += '```\n\n';
          break;

        case 'decision':
          md += `**Decision:** ${log.content.decision}\n\n`;
          md += `**Reasoning:** ${log.content.reasoning}\n\n`;
          break;

        case 'error':
          md += `**❌ Error:** ${log.content.error}\n\n`;
          break;
      }

      md += '---\n\n';
    }

    return md;
  }

  private addLog(taskId: string, entry: LogEntry) {
    if (!this.currentLogs.has(taskId)) {
      this.currentLogs.set(taskId, []);
    }
    this.currentLogs.get(taskId)!.push(entry);
  }

  private emitRealTime(taskId: string, agent: string, entry: LogEntry) {
    // This would emit via WebSocket for real-time viewing
    // Implementation depends on your WebSocket setup
  }

  private getLanguageFromFile(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const langMap: { [key: string]: string } = {
      '.ts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'jsx',
      '.tsx': 'tsx',
      '.py': 'python',
      '.java': 'java',
      '.cpp': 'cpp',
      '.c': 'c',
      '.cs': 'csharp',
      '.go': 'go',
      '.rs': 'rust',
      '.php': 'php',
      '.rb': 'ruby',
      '.swift': 'swift',
      '.kt': 'kotlin',
      '.scala': 'scala',
      '.r': 'r',
      '.sql': 'sql',
      '.sh': 'bash',
      '.yml': 'yaml',
      '.yaml': 'yaml',
      '.json': 'json',
      '.xml': 'xml',
      '.html': 'html',
      '.css': 'css',
      '.scss': 'scss',
      '.sass': 'sass',
      '.less': 'less',
      '.md': 'markdown',
      '.vue': 'vue',
      '.svelte': 'svelte',
    };

    return langMap[ext] || 'text';
  }

  /**
   * Create a real-time dashboard URL
   */
  getDashboardUrl(taskId: string): string {
    return `http://localhost:3001/dashboard/${taskId}`;
  }
}

export default new RealTimeLogger();