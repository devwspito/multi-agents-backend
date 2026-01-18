/**
 * DynamicModelRouter - Intelligent Model Selection at Runtime
 *
 * Instead of static per-agent model assignment, this service analyzes
 * task complexity in real-time and selects the optimal model:
 *
 * - Haiku: Fast, cheap tasks (simple queries, basic operations)
 * - Sonnet: Balanced tasks (standard development, reviews)
 * - Opus: Complex tasks (architecture, security, difficult bugs)
 *
 * Benefits:
 * - Cost reduction (use Haiku when possible)
 * - Quality improvement (use Opus for critical decisions)
 * - Automatic adaptation to task requirements
 */

import { EventEmitter } from 'events';
import { ExtendedThinkingService, ComplexityAnalysis } from './ExtendedThinkingService';

/**
 * Model tiers available
 */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/**
 * Model selection result
 */
export interface ModelSelection {
  tier: ModelTier;
  modelId: string;
  reason: string;
  complexity: number;
  estimatedCost: {
    inputPer1k: number;
    outputPer1k: number;
  };
}

/**
 * Routing configuration
 */
export interface RoutingConfig {
  enabled: boolean;
  preferCostSaving: boolean;     // Bias toward cheaper models when possible
  preferQuality: boolean;        // Bias toward better models
  minComplexityForSonnet: number; // 0-1
  minComplexityForOpus: number;   // 0-1
  forceModel?: ModelTier;        // Override all routing
}

/**
 * Agent-specific overrides
 */
interface AgentOverride {
  minTier?: ModelTier;  // Minimum tier for this agent
  maxTier?: ModelTier;  // Maximum tier for this agent
  forceComplexity?: number; // Force a specific complexity score
}

class DynamicModelRouterClass extends EventEmitter {
  private defaultConfig: RoutingConfig = {
    enabled: true,
    preferCostSaving: false,
    preferQuality: false,
    minComplexityForSonnet: 0.3,
    minComplexityForOpus: 0.7,
  };

  private taskConfigs: Map<string, RoutingConfig> = new Map();
  private agentOverrides: Map<string, AgentOverride> = new Map();

  // Model IDs (latest 4.5 versions) - MUST match ModelConfigurations.ts
  private readonly MODEL_IDS: Record<ModelTier, string> = {
    haiku: 'claude-haiku-4-5-20251001',   // Haiku 4.5 - fastest
    sonnet: 'claude-sonnet-4-5-20250929', // Sonnet 4.5 - balanced
    opus: 'claude-opus-4-5-20251101',     // Opus 4.5 - max intelligence
  };

  // Cost per 1K tokens (input/output)
  private readonly MODEL_COSTS: Record<ModelTier, { input: number; output: number }> = {
    haiku: { input: 0.001, output: 0.005 },   // $1/$5 per MTok
    sonnet: { input: 0.003, output: 0.015 },  // $3/$15 per MTok
    opus: { input: 0.015, output: 0.075 },    // $15/$75 per MTok
  };

  // Agent minimum tiers (some agents should never use Haiku)
  private readonly AGENT_MIN_TIERS: Record<string, ModelTier> = {
    'planning-agent': 'sonnet',
    'tech-lead': 'sonnet',
    'judge': 'sonnet',
    'verification-fixer': 'sonnet',
    'recovery-analyst': 'sonnet',
  };

  // Agents that can use Haiku for simple tasks
  private readonly HAIKU_ELIGIBLE_AGENTS = [
    'developer',      // Simple file operations
    'auto-merge',     // Git operations
  ];

  constructor() {
    super();

    // Set default overrides
    for (const [agent, minTier] of Object.entries(this.AGENT_MIN_TIERS)) {
      this.agentOverrides.set(agent, { minTier });
    }
  }

  /**
   * Select optimal model for a task
   */
  selectModel(
    taskId: string | undefined,
    agentType: string,
    prompt: string,
    context?: {
      filesInvolved?: number;
      previousErrors?: number;
      retryCount?: number;
      budgetRemaining?: number;
      forceTopModel?: boolean;
    }
  ): ModelSelection {
    const config = taskId ? this.taskConfigs.get(taskId) || this.defaultConfig : this.defaultConfig;

    // Check for force override
    if (config.forceModel) {
      return this.createSelection(config.forceModel, 0.5, `Forced to ${config.forceModel}`);
    }

    // Force top model on retry
    if (context?.forceTopModel) {
      return this.createSelection('opus', 1.0, 'Force top model (retry scenario)');
    }

    // Get complexity analysis from ExtendedThinkingService
    const complexity = ExtendedThinkingService.analyzeComplexity(prompt, agentType, context);

    // Get agent override
    const override = this.agentOverrides.get(agentType);

    // Determine tier based on complexity
    let tier = this.determineTier(complexity, config, agentType);

    // Apply agent minimum tier
    if (override?.minTier) {
      const tierOrder: ModelTier[] = ['haiku', 'sonnet', 'opus'];
      const minIndex = tierOrder.indexOf(override.minTier);
      const currentIndex = tierOrder.indexOf(tier);
      if (currentIndex < minIndex) {
        tier = override.minTier;
      }
    }

    // Apply agent maximum tier
    if (override?.maxTier) {
      const tierOrder: ModelTier[] = ['haiku', 'sonnet', 'opus'];
      const maxIndex = tierOrder.indexOf(override.maxTier);
      const currentIndex = tierOrder.indexOf(tier);
      if (currentIndex > maxIndex) {
        tier = override.maxTier;
      }
    }

    // Budget consideration - downgrade if low budget
    if (context?.budgetRemaining !== undefined && context.budgetRemaining < 1.0) {
      if (tier === 'opus') {
        tier = 'sonnet';
        console.log(`💰 [ModelRouter] Budget low ($${context.budgetRemaining.toFixed(2)}) - downgrading from Opus to Sonnet`);
      }
    }

    const reason = this.buildReason(tier, complexity, agentType, config);
    const selection = this.createSelection(tier, complexity.score, reason);

    console.log(`🎯 [ModelRouter] ${agentType} → ${tier.toUpperCase()} (complexity: ${complexity.score})`);
    console.log(`   Reason: ${reason}`);

    this.emit('model:selected', {
      taskId,
      agentType,
      selection,
      complexity,
    });

    return selection;
  }

  /**
   * Determine tier based on complexity and config
   */
  private determineTier(
    complexity: ComplexityAnalysis,
    config: RoutingConfig,
    agentType: string
  ): ModelTier {
    const score = complexity.score;

    // Adjust thresholds based on preferences
    let sonnetThreshold = config.minComplexityForSonnet;
    let opusThreshold = config.minComplexityForOpus;

    if (config.preferCostSaving) {
      // Raise thresholds to use cheaper models more often
      sonnetThreshold += 0.1;
      opusThreshold += 0.1;
    }

    if (config.preferQuality) {
      // Lower thresholds to use better models more often
      sonnetThreshold -= 0.1;
      opusThreshold -= 0.1;
    }

    // Check if Haiku is allowed for this agent
    const haikuAllowed = this.HAIKU_ELIGIBLE_AGENTS.includes(agentType);

    // Select tier
    if (score >= opusThreshold) {
      return 'opus';
    } else if (score >= sonnetThreshold) {
      return 'sonnet';
    } else if (haikuAllowed) {
      return 'haiku';
    } else {
      return 'sonnet'; // Default to Sonnet if Haiku not allowed
    }
  }

  /**
   * Build human-readable reason for selection
   */
  private buildReason(
    tier: ModelTier,
    complexity: ComplexityAnalysis,
    agentType: string,
    config: RoutingConfig
  ): string {
    const reasons: string[] = [];

    reasons.push(`Complexity: ${(complexity.score * 100).toFixed(0)}%`);

    if (tier === 'opus') {
      reasons.push('High complexity requires deep reasoning');
    } else if (tier === 'haiku' && this.HAIKU_ELIGIBLE_AGENTS.includes(agentType)) {
      reasons.push('Simple task, Haiku sufficient');
    } else if (tier === 'sonnet') {
      reasons.push('Standard complexity, Sonnet optimal');
    }

    if (config.preferCostSaving) {
      reasons.push('Cost-saving mode active');
    }
    if (config.preferQuality) {
      reasons.push('Quality-focused mode active');
    }

    if (complexity.factors.length > 0) {
      reasons.push(`Factors: ${complexity.factors.slice(0, 2).join(', ')}`);
    }

    return reasons.join(' | ');
  }

  /**
   * Create selection result object
   */
  private createSelection(tier: ModelTier, complexity: number, reason: string): ModelSelection {
    return {
      tier,
      modelId: this.MODEL_IDS[tier],
      reason,
      complexity,
      estimatedCost: {
        inputPer1k: this.MODEL_COSTS[tier].input,
        outputPer1k: this.MODEL_COSTS[tier].output,
      },
    };
  }

  /**
   * Get model ID for a tier
   */
  getModelId(tier: ModelTier): string {
    return this.MODEL_IDS[tier];
  }

  /**
   * Set task-specific routing configuration
   */
  setTaskConfig(taskId: string, config: Partial<RoutingConfig>): void {
    const existing = this.taskConfigs.get(taskId) || this.defaultConfig;
    this.taskConfigs.set(taskId, { ...existing, ...config });
  }

  /**
   * Get task routing configuration
   */
  getTaskConfig(taskId: string): RoutingConfig {
    return this.taskConfigs.get(taskId) || this.defaultConfig;
  }

  /**
   * Clear task configuration
   */
  clearTaskConfig(taskId: string): void {
    this.taskConfigs.delete(taskId);
  }

  /**
   * Set agent-specific override
   */
  setAgentOverride(agentType: string, override: AgentOverride): void {
    this.agentOverrides.set(agentType, override);
  }

  /**
   * Get agent override
   */
  getAgentOverride(agentType: string): AgentOverride | undefined {
    return this.agentOverrides.get(agentType);
  }

  /**
   * Update default configuration
   */
  setDefaultConfig(config: Partial<RoutingConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(): RoutingConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Check if dynamic routing is enabled
   */
  isEnabled(): boolean {
    return this.defaultConfig.enabled;
  }

  /**
   * Enable/disable dynamic routing
   */
  setEnabled(enabled: boolean): void {
    this.defaultConfig.enabled = enabled;
    this.emit('config:changed', { enabled });
  }

  /**
   * Force a specific model for all tasks
   */
  forceModel(tier: ModelTier | undefined): void {
    this.defaultConfig.forceModel = tier;
  }

  /**
   * Get cost estimates for different tiers
   */
  getCostEstimates(estimatedInputTokens: number, estimatedOutputTokens: number): Record<ModelTier, number> {
    const estimates: Record<ModelTier, number> = {} as any;

    for (const tier of ['haiku', 'sonnet', 'opus'] as ModelTier[]) {
      const cost = this.MODEL_COSTS[tier];
      estimates[tier] =
        (estimatedInputTokens / 1000) * cost.input +
        (estimatedOutputTokens / 1000) * cost.output;
    }

    return estimates;
  }
}

// Singleton export
export const DynamicModelRouter = new DynamicModelRouterClass();
export default DynamicModelRouter;
