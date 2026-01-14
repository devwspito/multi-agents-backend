/**
 * TUIManager - Professional Terminal User Interface
 *
 * THIS IS A KEY DIFFERENTIATOR - Beautiful terminal UI like OpenCode.
 *
 * Features:
 * - Split panel layout (main + sidebar)
 * - Real-time agent activity display
 * - Syntax-highlighted code diffs
 * - Todo list with visual progress
 * - Context/cost tracking
 * - MCP/LSP status indicators
 * - Keyboard navigation
 */

import blessed from 'blessed';
import chalk from 'chalk';
import { diffLines } from 'diff';

// ==================== TYPES ====================

export interface TUIConfig {
  title?: string;
  showSidebar?: boolean;
  showStatusBar?: boolean;
  theme?: TUITheme;
}

export interface TUITheme {
  primary: string;
  secondary: string;
  success: string;
  warning: string;
  error: string;
  muted: string;
  border: string;
  background: string;
}

export interface AgentActivity {
  type: 'read' | 'edit' | 'write' | 'bash' | 'think' | 'tool' | 'message';
  content: string;
  file?: string;
  timestamp: Date;
}

export interface ContextInfo {
  tokensUsed: number;
  maxTokens: number;
  costSpent: number;
  model: string;
}

export interface MCPServer {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
}

export interface LSPServer {
  language: string;
  status: 'connected' | 'disconnected' | 'error';
}

export interface TodoItem {
  text: string;
  completed: boolean;
  active?: boolean;
}

// ==================== DEFAULT THEME ====================

const DEFAULT_THEME: TUITheme = {
  primary: '#61afef',
  secondary: '#c678dd',
  success: '#98c379',
  warning: '#e5c07b',
  error: '#e06c75',
  muted: '#5c6370',
  border: '#3e4451',
  background: '#282c34'
};

// ==================== TUI MANAGER ====================

export class TUIManager {
  private static instance: TUIManager;

  private screen: blessed.Widgets.Screen | null = null;
  private mainPanel: blessed.Widgets.BoxElement | null = null;
  private sidebar: blessed.Widgets.BoxElement | null = null;
  private statusBar: blessed.Widgets.BoxElement | null = null;
  private activityLog: blessed.Widgets.Log | null = null;

  private config: TUIConfig;
  private theme: TUITheme;

  // State
  private activities: AgentActivity[] = [];
  private contextInfo: ContextInfo = {
    tokensUsed: 0,
    maxTokens: 200000,
    costSpent: 0,
    model: 'claude-sonnet-4'
  };
  private mcpServers: MCPServer[] = [];
  private lspServers: LSPServer[] = [];
  private todos: TodoItem[] = [];
  private currentTask: string = '';
  private agentPhase: string = '';

  private constructor(config: TUIConfig = {}) {
    this.config = {
      title: 'Multi-Agent Orchestrator',
      showSidebar: true,
      showStatusBar: true,
      ...config
    };
    this.theme = config.theme || DEFAULT_THEME;
  }

  static getInstance(config?: TUIConfig): TUIManager {
    if (!TUIManager.instance) {
      TUIManager.instance = new TUIManager(config);
    }
    return TUIManager.instance;
  }

  /**
   * Initialize the TUI
   */
  initialize(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: this.config.title,
      fullUnicode: true,
      dockBorders: true,
      autoPadding: true
    });

    this.createLayout();
    this.setupKeyBindings();
    this.render();
  }

  /**
   * Create the main layout
   */
  private createLayout(): void {
    if (!this.screen) return;

    const sidebarWidth = this.config.showSidebar ? 35 : 0;
    const statusHeight = this.config.showStatusBar ? 3 : 0;

    // Main Panel (left side)
    this.mainPanel = blessed.box({
      parent: this.screen,
      label: ` ${chalk.bold('Agent Activity')} `,
      top: 0,
      left: 0,
      width: `100%-${sidebarWidth}`,
      height: `100%-${statusHeight}`,
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.border },
        label: { fg: this.theme.primary }
      },
      scrollable: true,
      alwaysScroll: true,
      scrollbar: {
        style: { bg: this.theme.muted }
      }
    });

    // Activity Log inside main panel
    this.activityLog = blessed.log({
      parent: this.mainPanel,
      top: 0,
      left: 0,
      width: '100%-2',
      height: '100%-2',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true
    });

    // Sidebar (right side)
    if (this.config.showSidebar) {
      this.sidebar = blessed.box({
        parent: this.screen,
        top: 0,
        right: 0,
        width: sidebarWidth,
        height: `100%-${statusHeight}`,
        border: { type: 'line' },
        style: {
          border: { fg: this.theme.border }
        }
      });

      this.createSidebarContent();
    }

    // Status Bar (bottom)
    if (this.config.showStatusBar) {
      this.statusBar = blessed.box({
        parent: this.screen,
        bottom: 0,
        left: 0,
        width: '100%',
        height: statusHeight,
        style: {
          bg: this.theme.background
        }
      });

      this.updateStatusBar();
    }
  }

  /**
   * Create sidebar content sections
   */
  private createSidebarContent(): void {
    if (!this.sidebar) return;

    // Current Task Section
    blessed.box({
      parent: this.sidebar,
      top: 0,
      left: 0,
      width: '100%-2',
      height: 5,
      content: this.formatTaskSection(),
      tags: true
    });

    // Context Section
    blessed.box({
      parent: this.sidebar,
      top: 5,
      left: 0,
      width: '100%-2',
      height: 6,
      content: this.formatContextSection(),
      tags: true
    });

    // MCP Section
    blessed.box({
      parent: this.sidebar,
      top: 11,
      left: 0,
      width: '100%-2',
      height: 5,
      content: this.formatMCPSection(),
      tags: true
    });

    // LSP Section
    blessed.box({
      parent: this.sidebar,
      top: 16,
      left: 0,
      width: '100%-2',
      height: 6,
      content: this.formatLSPSection(),
      tags: true
    });

    // Todo Section
    blessed.box({
      parent: this.sidebar,
      top: 22,
      left: 0,
      width: '100%-2',
      height: '100%-24',
      content: this.formatTodoSection(),
      tags: true,
      scrollable: true
    });
  }

  /**
   * Setup keyboard bindings
   */
  private setupKeyBindings(): void {
    if (!this.screen) return;

    // Quit
    this.screen.key(['escape', 'q', 'C-c'], () => {
      this.shutdown();
    });

    // Scroll main panel
    this.screen.key(['up', 'k'], () => {
      this.activityLog?.scroll(-1);
      this.render();
    });

    this.screen.key(['down', 'j'], () => {
      this.activityLog?.scroll(1);
      this.render();
    });

    // Page up/down
    this.screen.key(['pageup'], () => {
      this.activityLog?.scroll(-10);
      this.render();
    });

    this.screen.key(['pagedown'], () => {
      this.activityLog?.scroll(10);
      this.render();
    });

    // Toggle sidebar
    this.screen.key(['s'], () => {
      if (this.sidebar) {
        this.sidebar.toggle();
        this.render();
      }
    });

    // Clear log
    this.screen.key(['c'], () => {
      this.activities = [];
      if (this.activityLog) {
        this.activityLog.setContent('');
      }
      this.render();
    });

    // Help
    this.screen.key(['h', '?'], () => {
      this.showHelp();
    });
  }

  // ==================== PUBLIC API ====================

  /**
   * Log agent activity
   */
  logActivity(activity: AgentActivity): void {
    this.activities.push(activity);

    const formatted = this.formatActivity(activity);
    this.activityLog?.log(formatted);
    this.render();
  }

  /**
   * Log a file read operation
   */
  logFileRead(filePath: string): void {
    this.logActivity({
      type: 'read',
      content: `Read ${filePath}`,
      file: filePath,
      timestamp: new Date()
    });
  }

  /**
   * Log a file edit with diff
   */
  logFileEdit(filePath: string, oldContent: string, newContent: string): void {
    const diffText = this.generateDiff(oldContent, newContent, filePath);
    this.logActivity({
      type: 'edit',
      content: diffText,
      file: filePath,
      timestamp: new Date()
    });
  }

  /**
   * Log a bash command
   */
  logBashCommand(command: string, output?: string): void {
    let content = `$ ${command}`;
    if (output) {
      content += `\n${output}`;
    }
    this.logActivity({
      type: 'bash',
      content,
      timestamp: new Date()
    });
  }

  /**
   * Log agent thinking/reasoning
   */
  logThinking(thought: string): void {
    this.logActivity({
      type: 'think',
      content: thought,
      timestamp: new Date()
    });
  }

  /**
   * Log tool usage
   */
  logToolUse(toolName: string, description: string): void {
    this.logActivity({
      type: 'tool',
      content: `${toolName}: ${description}`,
      timestamp: new Date()
    });
  }

  /**
   * Log a message
   */
  logMessage(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    const colors: Record<string, string> = {
      info: this.theme.primary,
      success: this.theme.success,
      warning: this.theme.warning,
      error: this.theme.error
    };

    this.activityLog?.log(chalk.hex(colors[level])(message));
    this.render();
  }

  /**
   * Update context info
   */
  updateContext(info: Partial<ContextInfo>): void {
    this.contextInfo = { ...this.contextInfo, ...info };
    this.updateSidebar();
  }

  /**
   * Set current task
   */
  setCurrentTask(task: string): void {
    this.currentTask = task;
    this.updateSidebar();
  }

  /**
   * Set agent phase
   */
  setAgentPhase(phase: string): void {
    this.agentPhase = phase;
    this.updateStatusBar();
  }

  /**
   * Update MCP servers
   */
  setMCPServers(servers: MCPServer[]): void {
    this.mcpServers = servers;
    this.updateSidebar();
  }

  /**
   * Update LSP servers
   */
  setLSPServers(servers: LSPServer[]): void {
    this.lspServers = servers;
    this.updateSidebar();
  }

  /**
   * Update todo list
   */
  setTodos(todos: TodoItem[]): void {
    this.todos = todos;
    this.updateSidebar();
  }

  /**
   * Mark todo as complete
   */
  completeTodo(index: number): void {
    if (this.todos[index]) {
      this.todos[index].completed = true;
      this.updateSidebar();
    }
  }

  /**
   * Set active todo
   */
  setActiveTodo(index: number): void {
    this.todos.forEach((t, i) => {
      t.active = i === index;
    });
    this.updateSidebar();
  }

  /**
   * Render the screen
   */
  render(): void {
    this.screen?.render();
  }

  /**
   * Shutdown the TUI
   */
  shutdown(): void {
    if (this.screen) {
      this.screen.destroy();
      this.screen = null;
    }
    process.exit(0);
  }

  // ==================== FORMATTING ====================

  private formatActivity(activity: AgentActivity): string {
    const icons: Record<AgentActivity['type'], string> = {
      read: '{green-fg}+{/green-fg}',
      edit: '{yellow-fg}~{/yellow-fg}',
      write: '{blue-fg}+{/blue-fg}',
      bash: '{cyan-fg}${/cyan-fg}',
      think: '{magenta-fg}>{/magenta-fg}',
      tool: '{white-fg}*{/white-fg}',
      message: '{white-fg}•{/white-fg}'
    };

    const labels: Record<AgentActivity['type'], string> = {
      read: '{green-fg}Read{/green-fg}',
      edit: '{yellow-fg}Edit{/yellow-fg}',
      write: '{blue-fg}Write{/blue-fg}',
      bash: '{cyan-fg}Bash{/cyan-fg}',
      think: '{magenta-fg}Thinking{/magenta-fg}',
      tool: '{white-fg}Tool{/white-fg}',
      message: ''
    };

    const icon = icons[activity.type];
    const label = labels[activity.type];

    if (activity.type === 'message') {
      return activity.content;
    }

    let line = `${icon} ${label}`;

    if (activity.file) {
      line += ` {underline}${activity.file}{/underline}`;
    }

    if (activity.type !== 'edit' && activity.content && !activity.file) {
      line += ` ${activity.content}`;
    }

    // For edits, show the diff below
    if (activity.type === 'edit') {
      line += `\n${activity.content}`;
    }

    return line;
  }

  private formatTaskSection(): string {
    const lines: string[] = [];
    lines.push(chalk.hex(this.theme.primary).bold(this.currentTask || 'No active task'));
    return lines.join('\n');
  }

  private formatContextSection(): string {
    const lines: string[] = [];
    lines.push(chalk.hex(this.theme.muted)('Context'));

    const percentage = Math.round((this.contextInfo.tokensUsed / this.contextInfo.maxTokens) * 100);
    const progressBar = this.createProgressBar(percentage, 20);

    lines.push(`  ${progressBar}`);
    lines.push(`  ${this.formatNumber(this.contextInfo.tokensUsed)} tokens`);
    lines.push(`  ${percentage}% used`);
    lines.push(`  $${this.contextInfo.costSpent.toFixed(2)} spent`);

    return lines.join('\n');
  }

  private formatMCPSection(): string {
    const lines: string[] = [];
    lines.push(chalk.hex(this.theme.muted)('MCP'));

    for (const server of this.mcpServers) {
      const icon = server.status === 'connected'
        ? chalk.hex(this.theme.success)('•')
        : chalk.hex(this.theme.error)('•');
      const status = server.status === 'connected'
        ? chalk.hex(this.theme.muted)('Connected')
        : chalk.hex(this.theme.error)('Disconnected');
      lines.push(`  ${icon} ${chalk.bold(server.name)} ${status}`);
    }

    if (this.mcpServers.length === 0) {
      lines.push(chalk.hex(this.theme.muted)('  No servers'));
    }

    return lines.join('\n');
  }

  private formatLSPSection(): string {
    const lines: string[] = [];
    lines.push(chalk.hex(this.theme.muted)('LSP'));

    for (const server of this.lspServers) {
      const icon = server.status === 'connected'
        ? chalk.hex(this.theme.success)('•')
        : chalk.hex(this.theme.error)('•');
      lines.push(`  ${icon} ${server.language}`);
    }

    if (this.lspServers.length === 0) {
      lines.push(chalk.hex(this.theme.muted)('  No servers'));
    }

    return lines.join('\n');
  }

  private formatTodoSection(): string {
    const lines: string[] = [];
    lines.push(chalk.hex(this.theme.muted)('Todo'));

    for (const todo of this.todos) {
      const checkbox = todo.completed
        ? chalk.hex(this.theme.success)('[✓]')
        : chalk.hex(this.theme.muted)('[ ]');

      let text = todo.text;
      if (todo.active) {
        text = chalk.hex(this.theme.warning)(text);
      } else if (todo.completed) {
        text = chalk.hex(this.theme.muted).strikethrough(text);
      }

      lines.push(`  ${checkbox} ${text}`);
    }

    if (this.todos.length === 0) {
      lines.push(chalk.hex(this.theme.muted)('  No todos'));
    }

    return lines.join('\n');
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return;

    const model = chalk.hex(this.theme.secondary)(this.contextInfo.model);
    const phase = this.agentPhase
      ? chalk.hex(this.theme.primary)(`[${this.agentPhase}]`)
      : '';

    const left = ` ${phase} ${model}`;
    const right = `esc quit | h help | s sidebar | c clear `;

    const width = (this.statusBar.width as number) - 4;
    const padding = width - left.length - right.length;

    this.statusBar.setContent(
      left + ' '.repeat(Math.max(0, padding)) + chalk.hex(this.theme.muted)(right)
    );
  }

  private updateSidebar(): void {
    // Re-create sidebar content
    if (this.sidebar) {
      this.sidebar.children.forEach(child => child.destroy());
      this.createSidebarContent();
    }
    this.render();
  }

  private generateDiff(oldContent: string, newContent: string, _filePath: string): string {
    const changes = diffLines(oldContent, newContent);
    const lines: string[] = [];

    let oldLine = 1;
    let newLine = 1;

    for (const change of changes) {
      const changeLines = change.value.split('\n').filter(l => l !== '');

      for (const line of changeLines) {
        if (change.added) {
          lines.push(chalk.green(`${newLine.toString().padStart(4)} + ${line}`));
          newLine++;
        } else if (change.removed) {
          lines.push(chalk.red(`${oldLine.toString().padStart(4)} - ${line}`));
          oldLine++;
        } else {
          lines.push(chalk.gray(`${oldLine.toString().padStart(4)}   ${line}`));
          oldLine++;
          newLine++;
        }
      }
    }

    return lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n...' : '');
  }

  private createProgressBar(percentage: number, width: number): string {
    const filled = Math.round((percentage / 100) * width);
    const empty = width - filled;

    const color = percentage > 80
      ? this.theme.error
      : percentage > 60
        ? this.theme.warning
        : this.theme.success;

    return chalk.hex(color)('█'.repeat(filled)) +
           chalk.hex(this.theme.muted)('░'.repeat(empty));
  }

  private formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  private showHelp(): void {
    if (!this.screen) return;

    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 15,
      label: ' Help ',
      border: { type: 'line' },
      style: {
        border: { fg: this.theme.primary }
      },
      content: `
  ${chalk.bold('Keyboard Shortcuts')}

  ${chalk.hex(this.theme.primary)('↑/k')}     Scroll up
  ${chalk.hex(this.theme.primary)('↓/j')}     Scroll down
  ${chalk.hex(this.theme.primary)('PgUp')}    Page up
  ${chalk.hex(this.theme.primary)('PgDn')}    Page down
  ${chalk.hex(this.theme.primary)('s')}       Toggle sidebar
  ${chalk.hex(this.theme.primary)('c')}       Clear log
  ${chalk.hex(this.theme.primary)('h/?')}     Show this help
  ${chalk.hex(this.theme.primary)('q/Esc')}   Quit
      `.trim(),
      tags: true
    });

    helpBox.key(['escape', 'q', 'h', '?'], () => {
      helpBox.destroy();
      this.render();
    });

    helpBox.focus();
    this.render();
  }
}

// Export singleton getter
export function getTUI(config?: TUIConfig): TUIManager {
  return TUIManager.getInstance(config);
}
