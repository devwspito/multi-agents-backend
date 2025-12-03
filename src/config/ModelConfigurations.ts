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

export interface AgentModelConfig {
  'problem-analyst': ClaudeModel;
  'product-manager': ClaudeModel;
  'project-manager': ClaudeModel;
  'tech-lead': ClaudeModel;
  'developer': ClaudeModel;
  'judge': ClaudeModel;
  'qa-engineer': ClaudeModel;
  'fixer': ClaudeModel;
  'merge-coordinator': ClaudeModel;
  'auto-merge': ClaudeModel;
  'test-creator': ClaudeModel;
  'contract-tester': ClaudeModel;
  'contract-fixer': ClaudeModel;
  'error-detective': ClaudeModel;
}

/**
 * Premium Configuration (Opus + Sonnet)
 */
export const PREMIUM_CONFIG: AgentModelConfig = {
  'problem-analyst': 'opus',
  'product-manager': 'opus',
  'project-manager': 'opus',
  'tech-lead': 'opus',
  'judge': 'opus',
  'qa-engineer': 'opus',
  'fixer': 'opus',
  'contract-fixer': 'opus',
  'error-detective': 'opus',
  'developer': 'sonnet',
  'merge-coordinator': 'sonnet',
  'auto-merge': 'sonnet',
  'test-creator': 'sonnet',
  'contract-tester': 'sonnet',
};

/**
 * Standard Configuration (Sonnet + Haiku)
 */
export const STANDARD_CONFIG: AgentModelConfig = {
  'problem-analyst': 'sonnet',
  'product-manager': 'sonnet',
  'project-manager': 'sonnet',
  'tech-lead': 'sonnet',
  'judge': 'sonnet',
  'qa-engineer': 'sonnet',
  'fixer': 'sonnet',
  'contract-fixer': 'sonnet',
  'error-detective': 'sonnet',
  'developer': 'haiku',
  'merge-coordinator': 'haiku',
  'auto-merge': 'haiku',
  'test-creator': 'haiku',
  'contract-tester': 'haiku',
};

/**
 * 🌟 RECOMMENDED Configuration (Opus + Sonnet + Haiku)
 *
 * OPTIMAL BALANCE: Maximum quality where it matters, cost-effective elsewhere
 *
 * Strategy:
 * - Opus: Strategic decisions (Problem Analyst, PM, PjM, TL, Error Detective)
 * - Sonnet: Quality control (Judge, QA, Fixers)
 * - Haiku: Execution (Developer, Merge, Tests)
 */
export const RECOMMENDED_CONFIG: AgentModelConfig = {
  // 🧠 STRATEGIC - Opus
  'problem-analyst': 'opus',
  'product-manager': 'opus',
  'project-manager': 'opus',
  'tech-lead': 'opus',
  'error-detective': 'opus',

  // ⚡ QUALITY CONTROL - Sonnet
  'judge': 'sonnet',
  'qa-engineer': 'sonnet',
  'fixer': 'sonnet',
  'contract-fixer': 'sonnet',

  // 💨 EXECUTION - Haiku
  'developer': 'haiku',
  'merge-coordinator': 'haiku',
  'auto-merge': 'haiku',
  'test-creator': 'haiku',
  'contract-tester': 'haiku',
};

/**
 * Max Configuration (All Opus)
 */
export const MAX_CONFIG: AgentModelConfig = {
  'problem-analyst': 'opus',
  'product-manager': 'opus',
  'project-manager': 'opus',
  'tech-lead': 'opus',
  'developer': 'opus',
  'judge': 'opus',
  'qa-engineer': 'opus',
  'fixer': 'opus',
  'merge-coordinator': 'opus',
  'auto-merge': 'opus',
  'test-creator': 'opus',
  'contract-tester': 'opus',
  'contract-fixer': 'opus',
  'error-detective': 'opus',
};

/**
 * Optimize a configuration for best cost-performance ratio
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
    'problem-analyst': topModel,
    'product-manager': topModel,
    'project-manager': topModel,
    'tech-lead': topModel,
    'judge': topModel,
    'qa-engineer': topModel,
    'fixer': topModel,
    'contract-fixer': topModel,
    'error-detective': topModel,

    // 💨 EXECUTION - Use BOTTOM MODEL
    'developer': bottomModel,
    'merge-coordinator': bottomModel,
    'auto-merge': bottomModel,
    'test-creator': bottomModel,
    'contract-tester': bottomModel,
  };
}

/**
 * Convert DB config to AgentModelConfig
 */
export function mapDbConfigToAgentModelConfig(dbConfig: any): AgentModelConfig {
  return {
    'problem-analyst': dbConfig.problemAnalyst || dbConfig['problem-analyst'] || RECOMMENDED_CONFIG['problem-analyst'],
    'product-manager': dbConfig.productManager || dbConfig['product-manager'] || RECOMMENDED_CONFIG['product-manager'],
    'project-manager': dbConfig.projectManager || dbConfig['project-manager'] || RECOMMENDED_CONFIG['project-manager'],
    'tech-lead': dbConfig.techLead || dbConfig['tech-lead'] || RECOMMENDED_CONFIG['tech-lead'],
    'developer': dbConfig.developer || RECOMMENDED_CONFIG['developer'],
    'judge': dbConfig.judge || RECOMMENDED_CONFIG['judge'],
    'qa-engineer': dbConfig.qaEngineer || dbConfig['qa-engineer'] || RECOMMENDED_CONFIG['qa-engineer'],
    'fixer': dbConfig.fixer || RECOMMENDED_CONFIG['fixer'],
    'merge-coordinator': dbConfig.mergeCoordinator || dbConfig['merge-coordinator'] || RECOMMENDED_CONFIG['merge-coordinator'],
    'auto-merge': dbConfig.autoMerge || dbConfig['auto-merge'] || RECOMMENDED_CONFIG['auto-merge'],
    'test-creator': dbConfig.testCreator || dbConfig['test-creator'] || RECOMMENDED_CONFIG['test-creator'],
    'contract-tester': dbConfig.contractTester || dbConfig['contract-tester'] || RECOMMENDED_CONFIG['contract-tester'],
    'contract-fixer': dbConfig.contractFixer || dbConfig['contract-fixer'] || RECOMMENDED_CONFIG['contract-fixer'],
    'error-detective': dbConfig.errorDetective || dbConfig['error-detective'] || RECOMMENDED_CONFIG['error-detective'],
  };
}

/**
 * Get model for a specific agent type
 * THROWS if agent type is not in config - no silent defaults
 */
export function getAgentModel(
  agentType: string,
  config: AgentModelConfig = RECOMMENDED_CONFIG
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
