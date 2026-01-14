/**
 * ProviderOrchestrator - Intelligent Multi-Provider Management
 *
 * THIS IS A KEY DIFFERENTIATOR - Smart provider selection and failover.
 *
 * Features:
 * - Automatic provider selection based on task type
 * - Cost optimization (use cheaper models for simple tasks)
 * - Automatic failover if primary provider fails
 * - Load balancing across providers
 * - Health monitoring
 * - Rate limit handling
 */

import {
  AIProvider,
  ProviderName,
  ModelInfo,
  Message,
  QueryOptions,
  CompletionResult,
  StreamEvent,
  ALL_MODELS,
  selectBestModel
} from './AIProvider';
import { AnthropicProvider } from './AnthropicProvider';
import { OpenAIProvider } from './OpenAIProvider';
import { OllamaProvider } from './OllamaProvider';

// ==================== TYPES ====================

export interface ProviderOrchestratorConfig {
  primaryProvider?: ProviderName;
  fallbackProviders?: ProviderName[];
  maxCostPerRequest?: number;
  enableCostOptimization?: boolean;
  enableFailover?: boolean;
  healthCheckInterval?: number;  // ms
  providers?: {
    anthropic?: { apiKey?: string; enabled?: boolean };
    openai?: { apiKey?: string; enabled?: boolean };
    ollama?: { baseUrl?: string; enabled?: boolean };
  };
}

export interface ProviderStats {
  provider: ProviderName;
  requestCount: number;
  totalTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  errorRate: number;
  lastUsed?: Date;
}

export type TaskType = 'coding' | 'analysis' | 'simple' | 'reasoning' | 'creative';

// ==================== PROVIDER ORCHESTRATOR ====================

export class ProviderOrchestrator {
  private static instance: ProviderOrchestrator;

  private providers: Map<ProviderName, AIProvider> = new Map();
  private config: ProviderOrchestratorConfig;
  private stats: Map<ProviderName, ProviderStats> = new Map();
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  private constructor(config: ProviderOrchestratorConfig = {}) {
    this.config = {
      primaryProvider: 'anthropic',
      fallbackProviders: ['openai', 'ollama'],
      maxCostPerRequest: 1.0,
      enableCostOptimization: true,
      enableFailover: true,
      healthCheckInterval: 60000,
      ...config
    };

    this.initializeProviders();
    this.initializeStats();
  }

  static getInstance(config?: ProviderOrchestratorConfig): ProviderOrchestrator {
    if (!ProviderOrchestrator.instance) {
      ProviderOrchestrator.instance = new ProviderOrchestrator(config);
    }
    return ProviderOrchestrator.instance;
  }

  /**
   * Complete a prompt with automatic provider selection
   */
  async complete(
    messages: Message[],
    options: QueryOptions & { taskType?: TaskType } = {}
  ): Promise<CompletionResult> {
    const { provider, model } = this.selectProviderAndModel(options);

    try {
      const result = await provider.complete(messages, {
        ...options,
        model: model.id
      });

      this.updateStats(provider.name, result);
      return result;
    } catch (error) {
      // Try failover if enabled
      if (this.config.enableFailover) {
        return this.tryFailover(messages, options, provider.name, error);
      }
      throw error;
    }
  }

  /**
   * Stream a completion with automatic provider selection
   */
  async *stream(
    messages: Message[],
    options: QueryOptions & { taskType?: TaskType } = {}
  ): AsyncGenerator<StreamEvent> {
    const { provider, model } = this.selectProviderAndModel(options);

    try {
      const stream = provider.stream(messages, {
        ...options,
        model: model.id
      });

      for await (const event of stream) {
        yield event;
      }
    } catch (error: any) {
      yield {
        type: 'error',
        error: error.message
      };
    }
  }

  /**
   * Complete with a specific provider
   */
  async completeWithProvider(
    providerName: ProviderName,
    messages: Message[],
    options: QueryOptions = {}
  ): Promise<CompletionResult> {
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new Error(`Provider ${providerName} not available`);
    }

    const result = await provider.complete(messages, options);
    this.updateStats(providerName, result);
    return result;
  }

  /**
   * Get all available providers
   */
  getAvailableProviders(): ProviderName[] {
    return Array.from(this.providers.entries())
      .filter(([_, p]) => p.isAvailable())
      .map(([name]) => name);
  }

  /**
   * Get all available models
   */
  getAvailableModels(): ModelInfo[] {
    const models: ModelInfo[] = [];

    for (const provider of this.providers.values()) {
      if (provider.isAvailable()) {
        models.push(...provider.models);
      }
    }

    return models;
  }

  /**
   * Get provider stats
   */
  getStats(): ProviderStats[] {
    return Array.from(this.stats.values());
  }

  /**
   * Get total cost across all providers
   */
  getTotalCost(): number {
    let total = 0;
    for (const stat of this.stats.values()) {
      total += stat.totalCost;
    }
    return total;
  }

  /**
   * Start health checks
   */
  startHealthChecks(): void {
    if (this.healthCheckTimer) return;

    this.healthCheckTimer = setInterval(
      () => this.runHealthChecks(),
      this.config.healthCheckInterval
    );

    // Run immediately
    this.runHealthChecks();
  }

  /**
   * Stop health checks
   */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Check if local Ollama is available
   */
  async isOllamaAvailable(): Promise<boolean> {
    const ollama = this.providers.get('ollama') as OllamaProvider | undefined;
    if (!ollama) return false;
    return ollama.healthCheck();
  }

  /**
   * Get best model for a task type
   */
  getBestModelForTask(taskType: TaskType, maxCost?: number): ModelInfo {
    return selectBestModel(
      taskType,
      this.config.primaryProvider,
      maxCost || this.config.maxCostPerRequest
    );
  }

  // ==================== PRIVATE METHODS ====================

  private initializeProviders(): void {
    const providerConfigs = this.config.providers || {};

    // Anthropic
    if (providerConfigs.anthropic?.enabled !== false) {
      try {
        const anthropic = new AnthropicProvider({
          apiKey: providerConfigs.anthropic?.apiKey
        });
        this.providers.set('anthropic', anthropic);
      } catch (error) {
        console.warn('[ProviderOrchestrator] Failed to initialize Anthropic:', error);
      }
    }

    // OpenAI
    if (providerConfigs.openai?.enabled !== false) {
      try {
        const openai = new OpenAIProvider({
          apiKey: providerConfigs.openai?.apiKey
        });
        this.providers.set('openai', openai);
      } catch (error) {
        console.warn('[ProviderOrchestrator] Failed to initialize OpenAI:', error);
      }
    }

    // Ollama (local)
    if (providerConfigs.ollama?.enabled !== false) {
      try {
        const ollama = new OllamaProvider({
          baseUrl: providerConfigs.ollama?.baseUrl
        });
        this.providers.set('ollama', ollama);
      } catch (error) {
        console.warn('[ProviderOrchestrator] Failed to initialize Ollama:', error);
      }
    }
  }

  private initializeStats(): void {
    for (const name of this.providers.keys()) {
      this.stats.set(name, {
        provider: name,
        requestCount: 0,
        totalTokens: 0,
        totalCost: 0,
        avgLatencyMs: 0,
        errorRate: 0
      });
    }
  }

  private selectProviderAndModel(
    options: QueryOptions & { taskType?: TaskType }
  ): { provider: AIProvider; model: ModelInfo } {
    // If specific model requested, find the provider
    if (options.model) {
      const model = ALL_MODELS.find(m => m.id === options.model);
      if (model) {
        const provider = this.providers.get(model.provider);
        if (provider?.isAvailable()) {
          return { provider, model };
        }
      }
    }

    // Use task type for intelligent selection
    const taskType = options.taskType || 'coding';
    let model: ModelInfo;

    if (this.config.enableCostOptimization) {
      // Select cheaper model for simple tasks
      model = selectBestModel(
        taskType,
        undefined,
        this.config.maxCostPerRequest
      );
    } else {
      // Use primary provider's best model
      model = selectBestModel(taskType, this.config.primaryProvider);
    }

    // Find provider for this model
    let provider = this.providers.get(model.provider);

    // If provider not available, try primary
    if (!provider?.isAvailable()) {
      provider = this.providers.get(this.config.primaryProvider!);

      if (provider?.isAvailable()) {
        model = provider.getDefaultModel();
      }
    }

    // Still not available? Try any available provider
    if (!provider?.isAvailable()) {
      for (const p of this.providers.values()) {
        if (p.isAvailable()) {
          provider = p;
          model = p.getDefaultModel();
          break;
        }
      }
    }

    if (!provider) {
      throw new Error('No AI providers available');
    }

    return { provider, model };
  }

  private async tryFailover(
    messages: Message[],
    options: QueryOptions,
    failedProvider: ProviderName,
    originalError: any
  ): Promise<CompletionResult> {
    const fallbacks = this.config.fallbackProviders || [];

    for (const fallbackName of fallbacks) {
      if (fallbackName === failedProvider) continue;

      const provider = this.providers.get(fallbackName);
      if (!provider?.isAvailable()) continue;

      try {
        console.log(`[ProviderOrchestrator] Failing over to ${fallbackName}`);

        const result = await provider.complete(messages, {
          ...options,
          model: provider.getDefaultModel().id
        });

        this.updateStats(fallbackName, result);
        return result;
      } catch (error) {
        console.warn(`[ProviderOrchestrator] Failover to ${fallbackName} failed:`, error);
      }
    }

    // All failovers failed
    throw originalError;
  }

  private updateStats(providerName: ProviderName, result: CompletionResult): void {
    const stat = this.stats.get(providerName);
    if (!stat) return;

    stat.requestCount++;
    stat.totalTokens += result.usage.totalTokens;
    stat.totalCost += result.cost;
    stat.lastUsed = new Date();

    // Update average latency (rolling average)
    stat.avgLatencyMs = stat.avgLatencyMs === 0
      ? result.latencyMs
      : (stat.avgLatencyMs * 0.9) + (result.latencyMs * 0.1);
  }

  private async runHealthChecks(): Promise<void> {
    for (const [name, provider] of this.providers) {
      try {
        await provider.healthCheck();
      } catch (error) {
        console.warn(`[ProviderOrchestrator] Health check failed for ${name}:`, error);
      }
    }
  }
}

// Export singleton getter
export function getProviderOrchestrator(config?: ProviderOrchestratorConfig): ProviderOrchestrator {
  return ProviderOrchestrator.getInstance(config);
}

// Export convenience functions
export async function completeWithBestProvider(
  messages: Message[],
  taskType: TaskType = 'coding',
  options: QueryOptions = {}
): Promise<CompletionResult> {
  return getProviderOrchestrator().complete(messages, { ...options, taskType });
}

export function getBestModel(taskType: TaskType, maxCost?: number): ModelInfo {
  return getProviderOrchestrator().getBestModelForTask(taskType, maxCost);
}
