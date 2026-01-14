/**
 * AIProvider - Multi-Provider Abstraction Layer
 *
 * THIS IS A KEY DIFFERENTIATOR - Provider agnostic AI execution.
 *
 * Supports multiple AI providers:
 * - Anthropic (Claude) - Primary, best quality
 * - OpenAI (GPT-4) - Fallback, good quality
 * - Google (Gemini) - Alternative
 * - Ollama (Local) - Free, development mode
 *
 * Benefits:
 * - Cost optimization (use cheaper models for simple tasks)
 * - Redundancy (fallback if primary is down)
 * - Local development (no API costs with Ollama)
 */

// ==================== TYPES ====================

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'ollama' | 'groq';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderName;
  contextWindow: number;
  maxOutputTokens: number;
  costPer1kInput: number;   // USD per 1k input tokens
  costPer1kOutput: number;  // USD per 1k output tokens
  capabilities: ModelCapability[];
  tier: 'economy' | 'standard' | 'premium';
}

export type ModelCapability =
  | 'code'           // Good at coding
  | 'reasoning'      // Complex reasoning
  | 'creative'       // Creative writing
  | 'fast'           // Low latency
  | 'vision'         // Image understanding
  | 'tools'          // Tool/function calling
  | 'long-context';  // Large context window

export interface QueryOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
  stream?: boolean;
  timeout?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  image?: { type: 'base64'; data: string; mediaType: string };
  toolUse?: { id: string; name: string; input: any };
  toolResult?: { toolUseId: string; content: string };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface CompletionResult {
  content: string;
  model: string;
  provider: ProviderName;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: number;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'error';
  toolCalls?: ToolCall[];
  latencyMs: number;
}

export interface StreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: ToolCall;
  error?: string;
  partial?: boolean;
}

export interface ProviderStatus {
  name: ProviderName;
  available: boolean;
  latencyMs?: number;
  lastCheck: Date;
  errorCount: number;
  consecutiveErrors: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  timeout?: number;
  maxRetries?: number;
  enabled?: boolean;
}

// ==================== ABSTRACT PROVIDER ====================

export abstract class AIProvider {
  abstract readonly name: ProviderName;
  abstract readonly displayName: string;
  abstract readonly models: ModelInfo[];

  protected config: ProviderConfig;
  protected _status: ProviderStatus | null = null;

  protected get status(): ProviderStatus {
    if (!this._status) {
      this._status = {
        name: this.name,
        available: true,
        lastCheck: new Date(),
        errorCount: 0,
        consecutiveErrors: 0
      };
    }
    return this._status;
  }

  constructor(config: ProviderConfig = {}) {
    this.config = {
      timeout: 120000,
      maxRetries: 3,
      enabled: true,
      ...config
    };
  }

  /**
   * Complete a prompt (non-streaming)
   */
  abstract complete(
    messages: Message[],
    options?: QueryOptions
  ): Promise<CompletionResult>;

  /**
   * Stream a completion
   */
  abstract stream(
    messages: Message[],
    options?: QueryOptions
  ): AsyncGenerator<StreamEvent>;

  /**
   * Check if provider is available
   */
  abstract healthCheck(): Promise<boolean>;

  /**
   * Get default model for this provider
   */
  getDefaultModel(): ModelInfo {
    return this.models.find(m => m.id === this.config.defaultModel) || this.models[0];
  }

  /**
   * Get model by ID
   */
  getModel(modelId: string): ModelInfo | undefined {
    return this.models.find(m => m.id === modelId);
  }

  /**
   * Get models by capability
   */
  getModelsByCapability(capability: ModelCapability): ModelInfo[] {
    return this.models.filter(m => m.capabilities.includes(capability));
  }

  /**
   * Get models by tier
   */
  getModelsByTier(tier: 'economy' | 'standard' | 'premium'): ModelInfo[] {
    return this.models.filter(m => m.tier === tier);
  }

  /**
   * Calculate cost for tokens
   */
  calculateCost(model: ModelInfo, inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1000) * model.costPer1kInput +
           (outputTokens / 1000) * model.costPer1kOutput;
  }

  /**
   * Get provider status
   */
  getStatus(): ProviderStatus {
    return { ...this.status };
  }

  /**
   * Update status after request
   */
  protected updateStatus(success: boolean, latencyMs?: number): void {
    this.status.lastCheck = new Date();

    if (success) {
      this.status.available = true;
      this.status.consecutiveErrors = 0;
      if (latencyMs) {
        this.status.latencyMs = latencyMs;
      }
    } else {
      this.status.errorCount++;
      this.status.consecutiveErrors++;

      // Mark unavailable after 3 consecutive errors
      if (this.status.consecutiveErrors >= 3) {
        this.status.available = false;
      }
    }
  }

  /**
   * Check if provider is enabled and available
   */
  isAvailable(): boolean {
    return this.config.enabled !== false && this.status.available;
  }
}

// ==================== MODEL DEFINITIONS ====================

export const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-5-20251101',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 32000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.075,
    capabilities: ['code', 'reasoning', 'creative', 'vision', 'tools', 'long-context'],
    tier: 'premium'
  },
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 16000,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.015,
    capabilities: ['code', 'reasoning', 'tools', 'long-context'],
    tier: 'standard'
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    costPer1kInput: 0.0008,
    costPer1kOutput: 0.004,
    capabilities: ['code', 'fast', 'tools'],
    tier: 'economy'
  }
];

export const OPENAI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.005,
    costPer1kOutput: 0.015,
    capabilities: ['code', 'reasoning', 'vision', 'tools'],
    tier: 'premium'
  },
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    costPer1kInput: 0.00015,
    costPer1kOutput: 0.0006,
    capabilities: ['code', 'fast', 'tools'],
    tier: 'economy'
  },
  {
    id: 'o1',
    name: 'OpenAI o1',
    provider: 'openai',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    costPer1kInput: 0.015,
    costPer1kOutput: 0.060,
    capabilities: ['reasoning', 'code'],
    tier: 'premium'
  }
];

export const GOOGLE_MODELS: ModelInfo[] = [
  {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    capabilities: ['code', 'fast', 'vision', 'tools', 'long-context'],
    tier: 'economy'
  },
  {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    provider: 'google',
    contextWindow: 2000000,
    maxOutputTokens: 8192,
    costPer1kInput: 0.00125,
    costPer1kOutput: 0.005,
    capabilities: ['code', 'reasoning', 'vision', 'tools', 'long-context'],
    tier: 'standard'
  }
];

export const OLLAMA_MODELS: ModelInfo[] = [
  {
    id: 'llama3.1:70b',
    name: 'Llama 3.1 70B',
    provider: 'ollama',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ['code', 'reasoning'],
    tier: 'standard'
  },
  {
    id: 'codellama:34b',
    name: 'Code Llama 34B',
    provider: 'ollama',
    contextWindow: 16000,
    maxOutputTokens: 4096,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ['code', 'fast'],
    tier: 'economy'
  },
  {
    id: 'qwen2.5-coder:32b',
    name: 'Qwen 2.5 Coder 32B',
    provider: 'ollama',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    costPer1kInput: 0,
    costPer1kOutput: 0,
    capabilities: ['code', 'reasoning'],
    tier: 'standard'
  }
];

export const ALL_MODELS = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  ...OLLAMA_MODELS
];

/**
 * Get best model for a task type
 */
export function selectBestModel(
  taskType: 'coding' | 'analysis' | 'simple' | 'reasoning' | 'creative',
  preferredProvider?: ProviderName,
  maxCostPer1k?: number
): ModelInfo {
  let candidates = ALL_MODELS;

  // Filter by provider if specified
  if (preferredProvider) {
    candidates = candidates.filter(m => m.provider === preferredProvider);
  }

  // Filter by cost if specified
  if (maxCostPer1k) {
    candidates = candidates.filter(m =>
      (m.costPer1kInput + m.costPer1kOutput) / 2 <= maxCostPer1k
    );
  }

  // Select based on task type
  switch (taskType) {
    case 'coding':
      return candidates.find(m => m.capabilities.includes('code') && m.tier !== 'economy')
        || candidates[0];

    case 'reasoning':
      return candidates.find(m => m.capabilities.includes('reasoning') && m.tier === 'premium')
        || candidates[0];

    case 'simple':
      return candidates.find(m => m.tier === 'economy')
        || candidates[0];

    case 'analysis':
      return candidates.find(m => m.capabilities.includes('long-context'))
        || candidates[0];

    case 'creative':
      return candidates.find(m => m.capabilities.includes('creative') && m.tier === 'premium')
        || candidates[0];

    default:
      return candidates[0];
  }
}
