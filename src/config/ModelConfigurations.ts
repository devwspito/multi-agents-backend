/**
 * Model Configuration System
 *
 * Uses EXPLICIT model IDs to ensure we always use the latest 4.5 versions.
 * SDK aliases might resolve to older models.
 *
 * Latest models (as of Nov 2025):
 * - Claude Haiku 4.5 (claude-haiku-4-5-20251001) - Fastest with near-frontier intelligence
 * - Claude Sonnet 4.5 (claude-sonnet-4-5-20250929) - Smartest for complex agents
 * - Claude Opus 4.5 (claude-opus-4-5-20251101) - Maximum intelligence + performance
 *
 * Source: https://docs.anthropic.com/en/docs/about-claude/models
 */

// Model IDs - explicit versions for predictable behavior
// Source: https://docs.anthropic.com/en/docs/about-claude/models
export const MODEL_IDS = {
  HAIKU: 'claude-haiku-4-5-20251001',      // Haiku 4.5 - fastest model
  SONNET: 'claude-sonnet-4-5-20250929',    // Sonnet 4.5 - smartest for complex agents
  OPUS: 'claude-opus-4-5-20251101',        // Opus 4.5 - maximum intelligence
} as const;

// Keep alias type for backward compatibility, but map to explicit IDs
export type ClaudeModel = 'sonnet' | 'haiku' | 'opus';

// Convert alias to explicit model ID
// THROWS if alias is invalid - no silent defaults
export function getExplicitModelId(alias: string): string {
  switch (alias) {
    case 'haiku': return MODEL_IDS.HAIKU;
    case 'sonnet': return MODEL_IDS.SONNET;
    case 'opus': return MODEL_IDS.OPUS;
    default:
      throw new Error(
        `❌ [getExplicitModelId] Invalid model alias "${alias}". ` +
        `Valid aliases: 'haiku', 'sonnet', 'opus'. ` +
        `Check your model configuration.`
      );
  }
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Pricing per million tokens (as of Nov 2025)
// Source: https://docs.anthropic.com/en/docs/about-claude/models
export const MODEL_PRICING: Record<ClaudeModel, ModelPricing> = {
  'sonnet': {
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
  'haiku': {
    inputPerMillion: 1,
    outputPerMillion: 5,
  },
  'opus': {
    inputPerMillion: 5,
    outputPerMillion: 25,
  },
};

/**
 * Agent Model Configuration Interface
 *
 * Active agents in the current orchestration system:
 * - planning-agent: Unified planning (replaces legacy problem-analyst + product-manager + project-manager)
 * - tech-lead: Architecture design per epic
 * - developer: Code implementation per story
 * - judge: Code review and quality validation
 * - auto-merge: PR creation and merge
 * - story-merge-agent: Story branch merging
 * - git-flow-manager: Git operations
 * - conflict-resolver: Git merge conflict resolution
 * - verification-fixer: Verification issue fixer
 * - recovery-analyst: Deep error analysis for recovery
 */
export interface AgentModelConfig {
  'planning-agent': ClaudeModel;
  'tech-lead': ClaudeModel;
  'developer': ClaudeModel;
  'judge': ClaudeModel;
  'verification-fixer': ClaudeModel;
  'recovery-analyst': ClaudeModel;
  'auto-merge': ClaudeModel;
  'story-merge-agent': ClaudeModel;
  'git-flow-manager': ClaudeModel;
  'conflict-resolver': ClaudeModel;
}

/**
 * Premium Configuration (Opus + Sonnet)
 */
export const PREMIUM_CONFIG: AgentModelConfig = {
  'planning-agent': 'opus',
  'tech-lead': 'opus',
  'developer': 'sonnet',
  'judge': 'opus',
  'verification-fixer': 'sonnet',
  'recovery-analyst': 'opus',
  'auto-merge': 'sonnet',
  'story-merge-agent': 'sonnet',
  'git-flow-manager': 'sonnet',
  'conflict-resolver': 'sonnet',
};

/**
 * Standard Configuration (Sonnet + Haiku)
 * Note: Developer ALWAYS uses Sonnet for code quality
 */
export const STANDARD_CONFIG: AgentModelConfig = {
  'planning-agent': 'sonnet',
  'tech-lead': 'sonnet',
  'developer': 'sonnet',
  'judge': 'sonnet',
  'verification-fixer': 'sonnet',
  'recovery-analyst': 'sonnet',
  'auto-merge': 'haiku',
  'story-merge-agent': 'haiku',
  'git-flow-manager': 'haiku',
  'conflict-resolver': 'haiku',
};

/**
 * 🌟 RECOMMENDED Configuration (Opus + Sonnet + Haiku)
 *
 * OPTIMAL BALANCE: Maximum quality where it matters, cost-effective elsewhere
 *
 * Strategy:
 * - Opus: Strategic decisions (Planning, TechLead)
 * - Sonnet: Code execution (Developer, Judge)
 * - Haiku: Merge operations
 */
export const RECOMMENDED_CONFIG: AgentModelConfig = {
  // 🧠 STRATEGIC - Opus
  'planning-agent': 'opus',
  'tech-lead': 'opus',
  'recovery-analyst': 'opus',

  // ⚡ CODE QUALITY - Sonnet
  'developer': 'sonnet',
  'judge': 'sonnet',
  'verification-fixer': 'sonnet',

  // 💨 MERGE OPERATIONS - Haiku
  'auto-merge': 'haiku',
  'story-merge-agent': 'haiku',
  'git-flow-manager': 'haiku',
  'conflict-resolver': 'haiku',
};

/**
 * Max Configuration (All Opus, except Developer = Sonnet)
 * Note: Developer ALWAYS uses Sonnet for optimal code generation
 */
export const MAX_CONFIG: AgentModelConfig = {
  'planning-agent': 'opus',
  'tech-lead': 'opus',
  'developer': 'sonnet',
  'judge': 'opus',
  'verification-fixer': 'opus',
  'recovery-analyst': 'opus',
  'auto-merge': 'opus',
  'story-merge-agent': 'opus',
  'git-flow-manager': 'opus',
  'conflict-resolver': 'opus',
};

/**
 * 🔥 ALL OPUS Configuration - Maximum intelligence for all agents
 * TEMPORARY: For testing/debugging purposes
 */
export const ALL_OPUS_CONFIG: AgentModelConfig = {
  'planning-agent': 'opus',
  'tech-lead': 'opus',
  'developer': 'opus',
  'judge': 'opus',
  'verification-fixer': 'opus',
  'recovery-analyst': 'opus',
  'auto-merge': 'opus',
  'story-merge-agent': 'opus',
  'git-flow-manager': 'opus',
  'conflict-resolver': 'opus',
};

/**
 * Optimize a configuration for best cost-performance ratio
 * Note: Developer ALWAYS uses Sonnet regardless of optimization
 */
export function optimizeConfigForBudget(userConfig: AgentModelConfig): AgentModelConfig {
  const models = Array.from(new Set(Object.values(userConfig))) as ClaudeModel[];

  // Sort by price (most expensive first): opus > sonnet > haiku
  const priceOrder: Record<ClaudeModel, number> = { 'opus': 3, 'sonnet': 2, 'haiku': 1 };
  const sortedModels = models.sort((a, b) => priceOrder[b] - priceOrder[a]);

  const topModel = sortedModels[0];
  const bottomModel = sortedModels[sortedModels.length - 1];

  return {
    // 🧠 CRITICAL THINKING - Use TOP MODEL
    'planning-agent': topModel,
    'tech-lead': topModel,
    'judge': topModel,
    'recovery-analyst': topModel,

    // 👨‍💻 DEVELOPER & FIXERS - 🔒 ALWAYS Sonnet (never downgrade)
    'developer': 'sonnet',
    'verification-fixer': 'sonnet',

    // 💨 MERGE OPERATIONS - Use BOTTOM MODEL
    'auto-merge': bottomModel,
    'story-merge-agent': bottomModel,
    'git-flow-manager': bottomModel,
    'conflict-resolver': bottomModel,
  };
}

/**
 * Convert DB config to AgentModelConfig
 * 🔥 HARDCODED: All agents use Opus
 */
export function mapDbConfigToAgentModelConfig(_dbConfig: any): AgentModelConfig {
  // 🔥 HARDCODED: Ignore DB config, always use ALL_OPUS_CONFIG
  return ALL_OPUS_CONFIG;
}

/**
 * Get model for a specific agent type
 * THROWS if agent type is not in config - no silent defaults
 * 🔥 HARDCODED: Using ALL_OPUS_CONFIG for maximum intelligence
 */
export function getAgentModel(
  agentType: string,
  config: AgentModelConfig = ALL_OPUS_CONFIG
): ClaudeModel {
  const model = config[agentType as keyof AgentModelConfig];

  if (!model) {
    throw new Error(
      `❌ [getAgentModel] Unknown agent type "${agentType}". ` +
      `Valid types: ${Object.keys(config).join(', ')}. ` +
      `Add this agent to AgentModelConfig if it's new.`
    );
  }

  return model;
}

/**
 * Calculate estimated cost for a configuration
 */
export function estimateConfigCost(
  config: AgentModelConfig,
  estimatedTokens = { input: 500000, output: 200000 }
): number {
  let totalCost = 0;

  Object.values(config).forEach((model: ClaudeModel) => {
    const pricing = MODEL_PRICING[model];
    const inputCost = (estimatedTokens.input * pricing.inputPerMillion) / 1_000_000;
    const outputCost = (estimatedTokens.output * pricing.outputPerMillion) / 1_000_000;
    totalCost += inputCost + outputCost;
  });

  return totalCost;
}

/**
 * Validate that a configuration doesn't exceed budget
 */
export function validateBudget(config: AgentModelConfig, maxBudgetUSD: number): boolean {
  return estimateConfigCost(config) <= maxBudgetUSD;
}

/**
 * Get the most powerful model from a configuration
 */
export function getTopModelFromConfig(config: AgentModelConfig): ClaudeModel {
  const modelsUsed = new Set(Object.values(config));

  if (modelsUsed.has('opus')) return 'opus';
  if (modelsUsed.has('sonnet')) return 'sonnet';
  return 'haiku';
}

/**
 * Escalate all agents to top model
 */
export function escalateConfigToTopModel(config: AgentModelConfig): AgentModelConfig {
  const topModel = getTopModelFromConfig(config);
  const escalated: AgentModelConfig = {} as AgentModelConfig;

  for (const agent in config) {
    escalated[agent as keyof AgentModelConfig] = topModel;
  }

  return escalated;
}
