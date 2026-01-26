/**
 * AgentHooksService - Claude Code Style Agent Hooks
 *
 * Implements the hook system from Claude Agent SDK:
 * - Pre-tool hooks: Execute BEFORE a tool runs
 * - Post-tool hooks: Execute AFTER a tool completes
 * - On-error hooks: Execute when a tool fails
 * - Tool validation hooks: Validate tool inputs before execution
 *
 * This enables:
 * - Automatic logging of all tool activity
 * - Custom validation before dangerous operations
 * - Automatic cleanup after operations
 * - Analytics and monitoring
 *
 * Reference: https://docs.claude.com/en/agent-sdk/hooks
 */

import { LogService } from './logging/LogService';
import { NotificationService } from './NotificationService';

/**
 * Tool call information passed to hooks
 */
export interface ToolCallInfo {
  toolName: string;
  toolId: string;
  input: Record<string, any>;
  agentType: string;
  taskId: string;
  timestamp: Date;
}

/**
 * Tool result information passed to post-hooks
 */
export interface ToolResultInfo extends ToolCallInfo {
  output: any;
  success: boolean;
  duration: number;
  error?: string;
}

/**
 * Hook function types
 */
export type PreToolHook = (info: ToolCallInfo) => Promise<{
  allow: boolean;
  reason?: string;
  modifiedInput?: Record<string, any>;
}>;

export type PostToolHook = (info: ToolResultInfo) => Promise<void>;

export type OnErrorHook = (info: ToolResultInfo) => Promise<{
  retry: boolean;
  modifiedInput?: Record<string, any>;
}>;

/**
 * Registered hooks storage
 */
interface RegisteredHooks {
  preTool: Map<string, PreToolHook[]>; // toolName -> hooks
  postTool: Map<string, PostToolHook[]>;
  onError: Map<string, OnErrorHook[]>;
  global: {
    preTool: PreToolHook[];
    postTool: PostToolHook[];
    onError: OnErrorHook[];
  };
}

class AgentHooksServiceClass {
  private hooks: RegisteredHooks = {
    preTool: new Map(),
    postTool: new Map(),
    onError: new Map(),
    global: {
      preTool: [],
      postTool: [],
      onError: [],
    },
  };

  private toolStats: Map<string, {
    calls: number;
    totalDuration: number;
    failures: number;
    lastCalled: Date;
  }> = new Map();

  constructor() {
    // Register default hooks
    this.registerDefaultHooks();
  }

  /**
   * Register default hooks for common patterns
   */
  private registerDefaultHooks(): void {
    // Global logging hook
    this.registerGlobalPreToolHook(async (info) => {
      console.log(`🔧 [Tool] ${info.agentType} calling ${info.toolName}`);
      return { allow: true };
    });

    // Global post-tool stats tracking
    this.registerGlobalPostToolHook(async (info) => {
      this.updateToolStats(info);
    });

    // Dangerous command protection
    this.registerPreToolHook('Bash', async (info) => {
      const command = info.input.command || '';
      const dangerous = [
        'rm -rf /',
        'rm -rf ~',
        'sudo rm',
        'sudo docker',  // Docker doesn't need sudo if user is in docker group
        ':(){:|:&};:',  // Fork bomb
        'dd if=/dev/zero',
        '> /dev/sda',
        'mkfs.',
        'chmod -R 777 /',
      ];

      for (const pattern of dangerous) {
        if (command.includes(pattern)) {
          await LogService.error(`Blocked dangerous command: ${command}`, {
            taskId: info.taskId,
            category: 'security',
            metadata: { command, pattern },
          });
          return {
            allow: false,
            reason: `Dangerous command blocked: contains "${pattern}"`,
          };
        }
      }

      return { allow: true };
    });

    // File protection hook
    this.registerPreToolHook('Write', async (info) => {
      const filePath = info.input.file_path || '';
      const protectedPaths = [
        '/etc/',
        '/usr/',
        '/bin/',
        '/sbin/',
        '.env',
        'credentials',
        'secrets',
        '.ssh/',
      ];

      for (const protected_ of protectedPaths) {
        if (filePath.includes(protected_)) {
          await LogService.warn(`Attempted to write to protected path: ${filePath}`, {
            taskId: info.taskId,
            category: 'security',
          });
          // Allow but log warning
          NotificationService.emitConsoleLog(
            info.taskId,
            'warn',
            `⚠️ Writing to potentially sensitive path: ${filePath}`
          );
        }
      }

      return { allow: true };
    });

    // Edit validation hook
    this.registerPreToolHook('Edit', async (info) => {
      const oldString = info.input.old_string || '';
      const newString = info.input.new_string || '';

      // Warn if replacing with empty
      if (oldString.length > 0 && newString.length === 0) {
        NotificationService.emitConsoleLog(
          info.taskId,
          'warn',
          `⚠️ Deleting code block in ${info.input.file_path}`
        );
      }

      return { allow: true };
    });

    // Git operation logging
    this.registerPostToolHook('Bash', async (info) => {
      const command = info.input.command || '';
      if (command.includes('git push') || command.includes('git commit')) {
        await LogService.info(`Git operation: ${command}`, {
          taskId: info.taskId,
          category: 'git',
          metadata: {
            success: info.success,
            duration: info.duration,
          },
        });
      }
    });
  }

  /**
   * Register a pre-tool hook for a specific tool
   */
  registerPreToolHook(toolName: string, hook: PreToolHook): void {
    if (!this.hooks.preTool.has(toolName)) {
      this.hooks.preTool.set(toolName, []);
    }
    this.hooks.preTool.get(toolName)!.push(hook);
  }

  /**
   * Register a post-tool hook for a specific tool
   */
  registerPostToolHook(toolName: string, hook: PostToolHook): void {
    if (!this.hooks.postTool.has(toolName)) {
      this.hooks.postTool.set(toolName, []);
    }
    this.hooks.postTool.get(toolName)!.push(hook);
  }

  /**
   * Register an on-error hook for a specific tool
   */
  registerOnErrorHook(toolName: string, hook: OnErrorHook): void {
    if (!this.hooks.onError.has(toolName)) {
      this.hooks.onError.set(toolName, []);
    }
    this.hooks.onError.get(toolName)!.push(hook);
  }

  /**
   * Register a global pre-tool hook (runs for ALL tools)
   */
  registerGlobalPreToolHook(hook: PreToolHook): void {
    this.hooks.global.preTool.push(hook);
  }

  /**
   * Register a global post-tool hook
   */
  registerGlobalPostToolHook(hook: PostToolHook): void {
    this.hooks.global.postTool.push(hook);
  }

  /**
   * Register a global on-error hook
   */
  registerGlobalOnErrorHook(hook: OnErrorHook): void {
    this.hooks.global.onError.push(hook);
  }

  /**
   * Execute pre-tool hooks
   * Returns whether the tool should be allowed to run
   */
  async executePreToolHooks(info: ToolCallInfo): Promise<{
    allow: boolean;
    reason?: string;
    modifiedInput?: Record<string, any>;
  }> {
    let currentInput = { ...info.input };

    // Execute global hooks first
    for (const hook of this.hooks.global.preTool) {
      try {
        const result = await hook({ ...info, input: currentInput });
        if (!result.allow) {
          return result;
        }
        if (result.modifiedInput) {
          currentInput = result.modifiedInput;
        }
      } catch (error: any) {
        console.error(`[AgentHooks] Global pre-hook error:`, error.message);
      }
    }

    // Execute tool-specific hooks
    const toolHooks = this.hooks.preTool.get(info.toolName) || [];
    for (const hook of toolHooks) {
      try {
        const result = await hook({ ...info, input: currentInput });
        if (!result.allow) {
          return result;
        }
        if (result.modifiedInput) {
          currentInput = result.modifiedInput;
        }
      } catch (error: any) {
        console.error(`[AgentHooks] Pre-hook error for ${info.toolName}:`, error.message);
      }
    }

    return { allow: true, modifiedInput: currentInput };
  }

  /**
   * Execute post-tool hooks
   */
  async executePostToolHooks(info: ToolResultInfo): Promise<void> {
    // Execute global hooks
    for (const hook of this.hooks.global.postTool) {
      try {
        await hook(info);
      } catch (error: any) {
        console.error(`[AgentHooks] Global post-hook error:`, error.message);
      }
    }

    // Execute tool-specific hooks
    const toolHooks = this.hooks.postTool.get(info.toolName) || [];
    for (const hook of toolHooks) {
      try {
        await hook(info);
      } catch (error: any) {
        console.error(`[AgentHooks] Post-hook error for ${info.toolName}:`, error.message);
      }
    }
  }

  /**
   * Execute on-error hooks
   * Returns whether to retry the tool
   */
  async executeOnErrorHooks(info: ToolResultInfo): Promise<{
    retry: boolean;
    modifiedInput?: Record<string, any>;
  }> {
    let shouldRetry = false;
    let modifiedInput: Record<string, any> | undefined;

    // Execute global hooks
    for (const hook of this.hooks.global.onError) {
      try {
        const result = await hook(info);
        if (result.retry) {
          shouldRetry = true;
          modifiedInput = result.modifiedInput || modifiedInput;
        }
      } catch (error: any) {
        console.error(`[AgentHooks] Global on-error hook error:`, error.message);
      }
    }

    // Execute tool-specific hooks
    const toolHooks = this.hooks.onError.get(info.toolName) || [];
    for (const hook of toolHooks) {
      try {
        const result = await hook(info);
        if (result.retry) {
          shouldRetry = true;
          modifiedInput = result.modifiedInput || modifiedInput;
        }
      } catch (error: any) {
        console.error(`[AgentHooks] On-error hook error for ${info.toolName}:`, error.message);
      }
    }

    return { retry: shouldRetry, modifiedInput };
  }

  /**
   * Update tool statistics
   */
  private updateToolStats(info: ToolResultInfo): void {
    const existing = this.toolStats.get(info.toolName) || {
      calls: 0,
      totalDuration: 0,
      failures: 0,
      lastCalled: new Date(),
    };

    this.toolStats.set(info.toolName, {
      calls: existing.calls + 1,
      totalDuration: existing.totalDuration + info.duration,
      failures: existing.failures + (info.success ? 0 : 1),
      lastCalled: new Date(),
    });
  }

  /**
   * Get tool statistics
   */
  getToolStats(): Record<string, {
    calls: number;
    avgDuration: number;
    failureRate: number;
    lastCalled: Date;
  }> {
    const stats: Record<string, any> = {};

    for (const [tool, data] of this.toolStats.entries()) {
      stats[tool] = {
        calls: data.calls,
        avgDuration: data.calls > 0 ? Math.round(data.totalDuration / data.calls) : 0,
        failureRate: data.calls > 0 ? Math.round((data.failures / data.calls) * 100) : 0,
        lastCalled: data.lastCalled,
      };
    }

    return stats;
  }

  /**
   * Get most used tools
   */
  getMostUsedTools(limit: number = 10): Array<{ tool: string; calls: number }> {
    return Array.from(this.toolStats.entries())
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, limit)
      .map(([tool, data]) => ({ tool, calls: data.calls }));
  }

  /**
   * Clear all hooks (for testing)
   */
  clearAllHooks(): void {
    this.hooks.preTool.clear();
    this.hooks.postTool.clear();
    this.hooks.onError.clear();
    this.hooks.global = {
      preTool: [],
      postTool: [],
      onError: [],
    };
    // Re-register defaults
    this.registerDefaultHooks();
  }

  /**
   * Clear tool statistics
   */
  clearStats(): void {
    this.toolStats.clear();
  }

  // ========== AGENT EXECUTION HOOKS ==========
  // These hooks run before/after entire agent executions (not individual tools)

  private agentStats: Map<string, {
    executions: number;
    totalDuration: number;
    totalCost: number;
    totalTokens: number;
    failures: number;
    lastExecution: Date;
  }> = new Map();

  /**
   * Run pre-execution hooks before an agent starts
   */
  async runPreExecutionHooks(params: {
    agentType: string;
    taskId: string;
    workspacePath: string;
    prompt: string;
  }): Promise<{
    blocked: boolean;
    reason?: string;
    warnings: string[];
  }> {
    const warnings: string[] = [];

    // Check for dangerous patterns in prompt
    const dangerousPatterns = [
      'delete all',
      'drop database',
      'rm -rf',
      'format disk',
    ];

    for (const pattern of dangerousPatterns) {
      if (params.prompt.toLowerCase().includes(pattern)) {
        warnings.push(`Prompt contains potentially dangerous pattern: "${pattern}"`);
      }
    }

    // Log execution start
    console.log(`🚀 [AgentHooks] Pre-execution: ${params.agentType} starting for task ${params.taskId}`);

    // Could add more validation here:
    // - Check workspace exists
    // - Validate agent permissions
    // - Check rate limits
    // - etc.

    return {
      blocked: false,
      warnings,
    };
  }

  /**
   * Run post-execution hooks after an agent completes
   */
  async runPostExecutionHooks(params: {
    agentType: string;
    taskId: string;
    workspacePath: string;
    success: boolean;
    output: string;
    duration: number;
    cost: number;
    tokens: number;
  }): Promise<void> {
    // Log execution end
    const status = params.success ? '✅' : '❌';
    console.log(`${status} [AgentHooks] Post-execution: ${params.agentType} completed in ${Math.round(params.duration / 1000)}s, cost: $${params.cost.toFixed(4)}`);

    // Emit notification for tracking
    NotificationService.emitConsoleLog(
      params.taskId,
      params.success ? 'info' : 'error',
      `Agent ${params.agentType} completed: ${params.success ? 'success' : 'failed'} (${Math.round(params.duration / 1000)}s, $${params.cost.toFixed(4)})`
    );

    // Could add more post-processing:
    // - Send webhooks
    // - Update dashboards
    // - Trigger alerts on failures
    // - etc.
  }

  /**
   * Record execution statistics for an agent
   */
  recordExecution(params: {
    agentType: string;
    duration: number;
    success: boolean;
    cost: number;
    tokens: number;
  }): void {
    const existing = this.agentStats.get(params.agentType) || {
      executions: 0,
      totalDuration: 0,
      totalCost: 0,
      totalTokens: 0,
      failures: 0,
      lastExecution: new Date(),
    };

    this.agentStats.set(params.agentType, {
      executions: existing.executions + 1,
      totalDuration: existing.totalDuration + params.duration,
      totalCost: existing.totalCost + params.cost,
      totalTokens: existing.totalTokens + params.tokens,
      failures: existing.failures + (params.success ? 0 : 1),
      lastExecution: new Date(),
    });
  }

  /**
   * Get agent execution statistics
   */
  getAgentStats(): Record<string, {
    executions: number;
    avgDuration: number;
    totalCost: number;
    avgCost: number;
    totalTokens: number;
    failureRate: number;
    lastExecution: Date;
  }> {
    const stats: Record<string, any> = {};

    for (const [agent, data] of this.agentStats.entries()) {
      stats[agent] = {
        executions: data.executions,
        avgDuration: data.executions > 0 ? Math.round(data.totalDuration / data.executions) : 0,
        totalCost: Math.round(data.totalCost * 10000) / 10000,
        avgCost: data.executions > 0 ? Math.round((data.totalCost / data.executions) * 10000) / 10000 : 0,
        totalTokens: data.totalTokens,
        failureRate: data.executions > 0 ? Math.round((data.failures / data.executions) * 100) : 0,
        lastExecution: data.lastExecution,
      };
    }

    return stats;
  }

  /**
   * Get most expensive agents by total cost
   */
  getMostExpensiveAgents(limit: number = 10): Array<{ agent: string; totalCost: number; executions: number }> {
    return Array.from(this.agentStats.entries())
      .sort((a, b) => b[1].totalCost - a[1].totalCost)
      .slice(0, limit)
      .map(([agent, data]) => ({
        agent,
        totalCost: Math.round(data.totalCost * 10000) / 10000,
        executions: data.executions,
      }));
  }

  /**
   * Clear agent statistics
   */
  clearAgentStats(): void {
    this.agentStats.clear();
  }
}

// Singleton instance
export const AgentHooksService = new AgentHooksServiceClass();
