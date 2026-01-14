/**
 * TUIOrchestrationHook - Integration between TUI and Orchestrator
 *
 * Automatically captures and displays agent activities in the TUI:
 * - File operations (read, edit, write)
 * - Tool usage
 * - Phase transitions
 * - Context updates
 * - Todo list changes
 */

import { TUIManager, getTUI, TodoItem, MCPServer, LSPServer } from './TUIManager';
import { DiffViewer } from './DiffViewer';

// ==================== TYPES ====================

export interface OrchestrationEvent {
  type: 'phase_start' | 'phase_end' | 'tool_call' | 'tool_result' | 'file_read' | 'file_edit' | 'file_write' | 'bash' | 'message' | 'error' | 'context_update' | 'todo_update';
  phase?: string;
  tool?: string;
  file?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  command?: string;
  output?: string;
  tokens?: number;
  cost?: number;
  todos?: Array<{ content: string; status: string }>;
  error?: string;
}

// ==================== HOOK ====================

export class TUIOrchestrationHook {
  private static instance: TUIOrchestrationHook;

  private tui: TUIManager;
  private diffViewer: DiffViewer;
  private enabled: boolean = false;
  private fileContents: Map<string, string> = new Map();

  private constructor() {
    this.tui = getTUI({
      title: 'Multi-Agent Orchestrator',
      showSidebar: true,
      showStatusBar: true
    });
    this.diffViewer = new DiffViewer({
      mode: 'unified',
      context: 3,
      syntaxHighlight: true,
      showLineNumbers: true
    });
  }

  /**
   * Get the diff viewer for advanced diff generation
   */
  getDiffViewer(): DiffViewer {
    return this.diffViewer;
  }

  static getInstance(): TUIOrchestrationHook {
    if (!TUIOrchestrationHook.instance) {
      TUIOrchestrationHook.instance = new TUIOrchestrationHook();
    }
    return TUIOrchestrationHook.instance;
  }

  /**
   * Enable the TUI
   */
  enable(): void {
    if (this.enabled) return;

    this.tui.initialize();
    this.enabled = true;

    // Set default MCP servers
    this.tui.setMCPServers([
      { name: 'custom-dev-tools', status: 'connected' },
      { name: 'extra-tools', status: 'connected' },
      { name: 'exploratory-tools', status: 'connected' }
    ]);
  }

  /**
   * Disable the TUI
   */
  disable(): void {
    if (!this.enabled) return;
    this.tui.shutdown();
    this.enabled = false;
  }

  /**
   * Check if TUI is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Process an orchestration event
   */
  processEvent(event: OrchestrationEvent): void {
    if (!this.enabled) return;

    switch (event.type) {
      case 'phase_start':
        this.handlePhaseStart(event);
        break;

      case 'phase_end':
        this.handlePhaseEnd(event);
        break;

      case 'tool_call':
        this.handleToolCall(event);
        break;

      case 'tool_result':
        this.handleToolResult(event);
        break;

      case 'file_read':
        this.handleFileRead(event);
        break;

      case 'file_edit':
        this.handleFileEdit(event);
        break;

      case 'file_write':
        this.handleFileWrite(event);
        break;

      case 'bash':
        this.handleBash(event);
        break;

      case 'message':
        this.handleMessage(event);
        break;

      case 'error':
        this.handleError(event);
        break;

      case 'context_update':
        this.handleContextUpdate(event);
        break;

      case 'todo_update':
        this.handleTodoUpdate(event);
        break;
    }
  }

  /**
   * Set current task
   */
  setTask(task: string): void {
    if (!this.enabled) return;
    this.tui.setCurrentTask(task);
  }

  /**
   * Update MCP servers
   */
  updateMCPServers(servers: MCPServer[]): void {
    if (!this.enabled) return;
    this.tui.setMCPServers(servers);
  }

  /**
   * Update LSP servers
   */
  updateLSPServers(servers: LSPServer[]): void {
    if (!this.enabled) return;
    this.tui.setLSPServers(servers);
  }

  /**
   * Log a custom message
   */
  log(message: string, level: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
    if (!this.enabled) return;
    this.tui.logMessage(message, level);
  }

  // ==================== EVENT HANDLERS ====================

  private handlePhaseStart(event: OrchestrationEvent): void {
    if (event.phase) {
      this.tui.setAgentPhase(event.phase);
      this.tui.logMessage(`\n━━━ Starting: ${event.phase} ━━━\n`, 'info');
    }
  }

  private handlePhaseEnd(event: OrchestrationEvent): void {
    if (event.phase) {
      this.tui.logMessage(`✓ Completed: ${event.phase}\n`, 'success');
    }
  }

  private handleToolCall(event: OrchestrationEvent): void {
    if (event.tool && event.content) {
      this.tui.logToolUse(event.tool, event.content);
    }
  }

  private handleToolResult(event: OrchestrationEvent): void {
    // Tool results are usually handled by specific handlers (file_read, file_edit, etc.)
    if (event.content) {
      this.tui.logMessage(event.content.substring(0, 200), 'info');
    }
  }

  private handleFileRead(event: OrchestrationEvent): void {
    if (event.file) {
      this.tui.logFileRead(event.file);

      // Store content for potential later diff
      if (event.content) {
        this.fileContents.set(event.file, event.content);
      }
    }
  }

  private handleFileEdit(event: OrchestrationEvent): void {
    if (event.file) {
      const oldContent = event.oldContent || this.fileContents.get(event.file) || '';
      const newContent = event.newContent || '';

      this.tui.logFileEdit(event.file, oldContent, newContent);

      // Update stored content
      this.fileContents.set(event.file, newContent);
    }
  }

  private handleFileWrite(event: OrchestrationEvent): void {
    if (event.file) {
      this.tui.logActivity({
        type: 'write',
        content: `Created ${event.file}`,
        file: event.file,
        timestamp: new Date()
      });

      if (event.content) {
        this.fileContents.set(event.file, event.content);
      }
    }
  }

  private handleBash(event: OrchestrationEvent): void {
    if (event.command) {
      this.tui.logBashCommand(event.command, event.output);
    }
  }

  private handleMessage(event: OrchestrationEvent): void {
    if (event.content) {
      this.tui.logMessage(event.content, 'info');
    }
  }

  private handleError(event: OrchestrationEvent): void {
    if (event.error) {
      this.tui.logMessage(`Error: ${event.error}`, 'error');
    }
  }

  private handleContextUpdate(event: OrchestrationEvent): void {
    this.tui.updateContext({
      tokensUsed: event.tokens,
      costSpent: event.cost
    });
  }

  private handleTodoUpdate(event: OrchestrationEvent): void {
    if (event.todos) {
      const todos: TodoItem[] = event.todos.map(t => ({
        text: t.content,
        completed: t.status === 'completed',
        active: t.status === 'in_progress'
      }));
      this.tui.setTodos(todos);
    }
  }
}

// Export singleton getter
export function getTUIHook(): TUIOrchestrationHook {
  return TUIOrchestrationHook.getInstance();
}

// ==================== HELPER FUNCTIONS ====================

/**
 * Create a TUI-enabled wrapper for the orchestrator
 */
export function wrapWithTUI<T extends (...args: any[]) => any>(
  fn: T,
  taskDescription: string
): T {
  return (async (...args: Parameters<T>) => {
    const hook = getTUIHook();
    hook.enable();
    hook.setTask(taskDescription);

    try {
      const result = await fn(...args);
      return result;
    } finally {
      // Don't disable - let user quit manually
    }
  }) as T;
}

/**
 * Create event emitter integration
 */
export function createTUIEventListener(): (event: OrchestrationEvent) => void {
  const hook = getTUIHook();
  return (event: OrchestrationEvent) => hook.processEvent(event);
}
