import fs from 'fs';
import path from 'path';

/**
 * Hook Event Types
 */
export type HookEvent =
  | 'user-prompt-submit'
  | 'tool-use'
  | 'agent-start'
  | 'agent-complete';

/**
 * Hook Context - Data passed to hooks
 */
export interface IHookContext {
  event: HookEvent;
  data: any;
  timestamp: Date;
}

/**
 * Hook Result - Result from hook execution
 */
export interface IHookResult {
  allowed: boolean;
  modified?: boolean;
  data?: any;
  message?: string;
}

/**
 * Hook Configuration
 */
interface IHookConfig {
  enabled: boolean;
  description: string;
}

/**
 * Settings Configuration
 */
interface ISettings {
  hooks?: Record<string, IHookConfig>;
  features?: Record<string, boolean>;
  limits?: Record<string, any>;
}

/**
 * Hook Service
 *
 * Implements custom hook system for event-driven agent control.
 * Hooks allow intercepting and modifying agent behavior at key points.
 *
 * Best Practice: "Custom hooks in ./.claude/settings.json"
 */
export class HookService {
  private settings: ISettings;
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
    this.settings = this.loadSettings();
  }

  /**
   * Load settings from .claude/settings.json
   */
  private loadSettings(): ISettings {
    try {
      const settingsPath = path.join(this.projectRoot, '.claude', 'settings.json');

      if (fs.existsSync(settingsPath)) {
        const settingsContent = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        console.log('✅ [HookService] Loaded settings from:', settingsPath);
        return settings;
      } else {
        console.log('⚠️ [HookService] No settings.json found, using defaults');
        return {};
      }
    } catch (error: any) {
      console.error('❌ [HookService] Error loading settings:', error.message);
      return {};
    }
  }

  /**
   * Check if a hook is enabled
   */
  isHookEnabled(event: HookEvent): boolean {
    if (!this.settings.hooks) return false;

    const hook = this.settings.hooks[event];
    return hook ? hook.enabled : false;
  }

  /**
   * Execute a hook
   *
   * Hooks can:
   * - Validate data (return allowed: false to block)
   * - Transform data (return modified: true with new data)
   * - Log/monitor (return allowed: true)
   */
  async executeHook(event: HookEvent, data: any): Promise<IHookResult> {
    if (!this.isHookEnabled(event)) {
      // Hook disabled, allow by default
      return { allowed: true };
    }

    // Commented - too verbose
    // console.log(`🪝 [Hook] Executing hook: ${event}`);

    const context: IHookContext = {
      event,
      data,
      timestamp: new Date(),
    };

    try {
      // Execute hook logic based on event type
      switch (event) {
        case 'user-prompt-submit':
          return await this.executeUserPromptSubmitHook(context);

        case 'tool-use':
          return await this.executeToolUseHook(context);

        case 'agent-start':
          return await this.executeAgentStartHook(context);

        case 'agent-complete':
          return await this.executeAgentCompleteHook(context);

        default:
          return { allowed: true };
      }
    } catch (error: any) {
      console.error(`❌ [Hook] Error executing ${event} hook:`, error.message);
      // On error, allow by default (fail-open)
      return { allowed: true, message: `Hook error: ${error.message}` };
    }
  }

  /**
   * User Prompt Submit Hook
   *
   * Validates and transforms user prompts before submission
   */
  private async executeUserPromptSubmitHook(context: IHookContext): Promise<IHookResult> {
    const { prompt, agentType } = context.data;

    // Example validation: Check prompt length
    if (prompt && prompt.length > 100000) {
      console.log(`⚠️ [Hook] Prompt too long (${prompt.length} chars), truncating...`);

      return {
        allowed: true,
        modified: true,
        data: {
          prompt: prompt.substring(0, 100000) + '\n\n[Prompt truncated by hook]',
          agentType,
        },
        message: 'Prompt truncated to 100k characters',
      };
    }

    // Example validation: Block empty prompts
    if (!prompt || prompt.trim().length === 0) {
      console.log('❌ [Hook] Empty prompt blocked');
      return {
        allowed: false,
        message: 'Empty prompt not allowed',
      };
    }

    // Example transformation: Add timestamp
    console.log(`✅ [Hook] Prompt validated for agent: ${agentType}`);
    return { allowed: true };
  }

  /**
   * Tool Use Hook
   *
   * Monitors and validates tool usage
   */
  private async executeToolUseHook(context: IHookContext): Promise<IHookResult> {
    const { toolName, toolInput, phase } = context.data;

    if (phase === 'before') {
      console.log(`🛠️ [Hook] Tool about to be used: ${toolName}`);

      // Example: Block dangerous operations
      if (toolName === 'Bash' && toolInput?.command?.includes('rm -rf /')) {
        console.log('❌ [Hook] Dangerous command blocked');
        return {
          allowed: false,
          message: 'Dangerous bash command blocked by hook',
        };
      }
    } else if (phase === 'after') {
      console.log(`✅ [Hook] Tool completed: ${toolName}`);
    }

    return { allowed: true };
  }

  /**
   * Agent Start Hook
   *
   * Runs when an agent starts execution
   */
  private async executeAgentStartHook(context: IHookContext): Promise<IHookResult> {
    const { agentType, taskId } = context.data;

    console.log(`🚀 [Hook] Agent starting: ${agentType} (task: ${taskId})`);

    // Example: Log agent start for analytics
    // Could also check rate limits, validate permissions, etc.

    return { allowed: true };
  }

  /**
   * Agent Complete Hook
   *
   * Runs when an agent completes execution
   */
  private async executeAgentCompleteHook(context: IHookContext): Promise<IHookResult> {
    const { agentType, taskId, cost } = context.data;

    console.log(`✅ [Hook] Agent completed: ${agentType} (task: ${taskId}, cost: $${cost.toFixed(4)})`);

    // Example: Log completion metrics
    // Could also trigger post-processing, notifications, etc.

    return { allowed: true };
  }

  /**
   * Get setting value
   */
  getSetting(category: 'features' | 'limits', key: string): any {
    return this.settings[category]?.[key];
  }

  /**
   * Check if a feature is enabled
   */
  isFeatureEnabled(feature: string): boolean {
    return this.settings.features?.[feature] === true;
  }

  /**
   * Get limit value
   */
  getLimit(limit: string): any {
    return this.settings.limits?.[limit];
  }
}
