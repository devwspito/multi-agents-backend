/**
 * Model Configuration System
 *
 * Allows users to select specific Claude models for each agent
 * Provides optimized presets for different use cases and budgets
 */

export type ClaudeModel =
  | 'claude-sonnet-4-5-20250929'  // Best balance of performance and cost
  | 'claude-haiku-4-5-20251001'   // Fast and economical
  | 'claude-opus-4-1-20250805';   // Most capable, highest cost

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<ClaudeModel, ModelPricing> = {
  'claude-sonnet-4-5-20250929': {
    inputPerMillion: 3,    // $3 per million tokens
    outputPerMillion: 15,   // $15 per million tokens
  },
  'claude-haiku-4-5-20251001': {
    inputPerMillion: 1,     // $1 per million tokens
    outputPerMillion: 5,    // $5 per million tokens
  },
  'claude-opus-4-1-20250805': {
    inputPerMillion: 15,    // $15 per million tokens
    outputPerMillion: 75,   // $75 per million tokens
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
 *
 * - Maximum quality and capabilities
 * - Best for complex, critical projects
 * - Estimated cost: $15-20 per session
 *
 * AUTO-OPTIMIZED Strategy:
 * - Opus → Critical thinking (Problem Analyst, PM, PjM, TL, Judge, QA, Fixers)
 * - Sonnet → Execution (Developers, Merge, E2E Testing)
 */
export const PREMIUM_CONFIG: AgentModelConfig = {
  'problem-analyst': 'claude-opus-4-1-20250805',     // 🧠 Critical: Deep problem analysis
  'product-manager': 'claude-opus-4-1-20250805',      // 🧠 Critical: Requirements analysis
  'project-manager': 'claude-opus-4-1-20250805',      // 🧠 Critical: Task breakdown & planning
  'tech-lead': 'claude-opus-4-1-20250805',           // 🧠 Critical: Architecture design
  'judge': 'claude-opus-4-1-20250805',              // 🧠 Critical: Code review
  'qa-engineer': 'claude-opus-4-1-20250805',         // 🧠 Critical: Error detection
  'fixer': 'claude-opus-4-1-20250805',              // 🧠 Critical: Bug fixes
  'contract-fixer': 'claude-opus-4-1-20250805',      // 🧠 Critical: Contract fixes
  'error-detective': 'claude-opus-4-1-20250805',     // 🧠 Critical: Error analysis
  'developer': 'claude-sonnet-4-5-20250929', // 💨 Execution: Implements architecture
  'merge-coordinator': 'claude-sonnet-4-5-20250929', // 💨 Execution: Git operations
  'auto-merge': 'claude-sonnet-4-5-20250929',       // 💨 Execution: Automated merge
  'test-creator': 'claude-sonnet-4-5-20250929',     // 💨 Execution: Creates comprehensive test suites
  'contract-tester': 'claude-sonnet-4-5-20250929',      // 💨 Execution: Static analysis
};

/**
 * Standard Configuration (Sonnet + Haiku)
 *
 * - Good balance of quality and cost
 * - Suitable for most projects
 * - Estimated cost: $5-7 per session
 *
 * AUTO-OPTIMIZED Strategy:
 * - Sonnet → Critical thinking (Problem Analyst, PM, PjM, TL, Judge, QA, Fixers)
 * - Haiku → Execution (Developers, Merge, E2E Testing)
 */
export const STANDARD_CONFIG: AgentModelConfig = {
  'problem-analyst': 'claude-sonnet-4-5-20250929',  // 🧠 Critical: Deep problem analysis
  'product-manager': 'claude-sonnet-4-5-20250929',  // 🧠 Critical: Requirements
  'project-manager': 'claude-sonnet-4-5-20250929',  // 🧠 Critical: Planning
  'tech-lead': 'claude-sonnet-4-5-20250929',       // 🧠 Critical: Architecture
  'judge': 'claude-sonnet-4-5-20250929',          // 🧠 Critical: Code review
  'qa-engineer': 'claude-sonnet-4-5-20250929',     // 🧠 Critical: Error detection
  'fixer': 'claude-sonnet-4-5-20250929',          // 🧠 Critical: Bug fixes
  'contract-fixer': 'claude-sonnet-4-5-20250929',  // 🧠 Critical: Contract fixes
  'error-detective': 'claude-sonnet-4-5-20250929', // 🧠 Critical: Error analysis
  'developer': 'claude-haiku-4-5-20251001',  // 💨 Execution: Implementation
  'merge-coordinator': 'claude-haiku-4-5-20251001', // 💨 Execution: Git coordination
  'auto-merge': 'claude-haiku-4-5-20251001',       // 💨 Execution: Automated merge
  'test-creator': 'claude-haiku-4-5-20251001',     // 💨 Execution: Test suite creation
  'contract-tester': 'claude-haiku-4-5-20251001',       // 💨 Execution: Static analysis
};

/**
 * Max Configuration (All Opus)
 *
 * - Maximum performance and capabilities
 * - Best for mission-critical projects
 * - Estimated cost: $30-40 per session
 *
 * Note: Highest quality but also highest cost
 */
export const MAX_CONFIG: AgentModelConfig = {
  'problem-analyst': 'claude-opus-4-1-20250805',
  'product-manager': 'claude-opus-4-1-20250805',
  'project-manager': 'claude-opus-4-1-20250805',
  'tech-lead': 'claude-opus-4-1-20250805',
  'developer': 'claude-opus-4-1-20250805',
  'judge': 'claude-opus-4-1-20250805',
  'qa-engineer': 'claude-opus-4-1-20250805',
  'fixer': 'claude-opus-4-1-20250805',
  'merge-coordinator': 'claude-opus-4-1-20250805',
  'auto-merge': 'claude-opus-4-1-20250805',
  'test-creator': 'claude-opus-4-1-20250805',
  'contract-tester': 'claude-opus-4-1-20250805',
  'contract-fixer': 'claude-opus-4-1-20250805',
  'error-detective': 'claude-opus-4-1-20250805',
};

/**
 * Optimize a configuration for best cost-performance ratio
 *
 * Takes any user-selected config and intelligently assigns:
 * - Most capable model (top tier) → Critical thinking agents
 * - Most economical model (bottom tier) → Execution agents
 *
 * Example:
 * - PREMIUM (Opus + Sonnet) → Critics get Opus, Executors get Sonnet
 * - STANDARD (Sonnet + Haiku) → Critics get Sonnet, Executors get Haiku
 * - MAX (All Opus) → No optimization needed, all stay Opus
 */
export function optimizeConfigForBudget(userConfig: AgentModelConfig): AgentModelConfig {
  // Extract unique models from config
  const models = Array.from(new Set(Object.values(userConfig))) as ClaudeModel[];

  // Sort by price (most expensive first)
  const sortedModels = models.sort((a, b) => {
    const priceA = MODEL_PRICING[a].inputPerMillion + MODEL_PRICING[a].outputPerMillion;
    const priceB = MODEL_PRICING[b].inputPerMillion + MODEL_PRICING[b].outputPerMillion;
    return priceB - priceA; // Descending
  });

  const topModel = sortedModels[0]; // Most capable
  const bottomModel = sortedModels[sortedModels.length - 1]; // Most economical

  console.log(`🎯 [ConfigOptimization] Optimizing user config:`, {
    uniqueModels: models,
    sortedByPrice: sortedModels,
    topModel,          // Will be used for critical agents (PM, TL, Judge, etc.)
    bottomModel,       // Will be used for execution agents (Developers, Merge, etc.)
    savingsEstimate: models.length > 1 ? 'Optimized for cost' : 'Single model config'
  });

  return {
    // 🧠 CRITICAL THINKING - Use TOP MODEL (most capable)
    'problem-analyst': topModel,     // Deep problem analysis
    'product-manager': topModel,     // Requirements decisions
    'project-manager': topModel,     // Planning & breakdown
    'tech-lead': topModel,          // Architecture design
    'judge': topModel,             // Code quality evaluation
    'qa-engineer': topModel,        // Error detection
    'fixer': topModel,             // Precise bug fixes
    'contract-fixer': topModel,      // Contract violation fixes
    'error-detective': topModel,     // Error root cause analysis (CRITICAL)

    // 💨 EXECUTION - Use BOTTOM MODEL (economical)
    'developer': bottomModel,      // Code implementation
    'merge-coordinator': bottomModel, // Mechanical git operations
    'auto-merge': bottomModel,       // Simple automation
    'test-creator': bottomModel,     // Test suite generation
    'contract-tester': bottomModel,       // Static analysis
  };
}

/**
 * Convert DB camelCase keys to AgentModelConfig kebab-case keys
 * DB uses: { problemAnalyst, productManager, projectManager, techLead, developer, ... }
 * AgentModelConfig uses: { 'problem-analyst', 'product-manager', 'project-manager', 'tech-lead', 'developer', ... }
 */
export function mapDbConfigToAgentModelConfig(dbConfig: any): AgentModelConfig {
  return {
    'problem-analyst': dbConfig.problemAnalyst || dbConfig['problem-analyst'] || 'claude-sonnet-4-5-20250929',
    'product-manager': dbConfig.productManager || dbConfig['product-manager'] || 'claude-sonnet-4-5-20250929',
    'project-manager': dbConfig.projectManager || dbConfig['project-manager'] || 'claude-sonnet-4-5-20250929',
    'tech-lead': dbConfig.techLead || dbConfig['tech-lead'] || 'claude-sonnet-4-5-20250929',
    'developer': dbConfig.developer || 'claude-haiku-4-5-20251001',
    'judge': dbConfig.judge || 'claude-sonnet-4-5-20250929',
    'qa-engineer': dbConfig.qaEngineer || dbConfig['qa-engineer'] || 'claude-sonnet-4-5-20250929',
    'fixer': dbConfig.fixer || 'claude-sonnet-4-5-20250929',
    'merge-coordinator': dbConfig.mergeCoordinator || dbConfig['merge-coordinator'] || 'claude-haiku-4-5-20251001',
    'auto-merge': dbConfig.autoMerge || dbConfig['auto-merge'] || 'claude-haiku-4-5-20251001',
    'test-creator': dbConfig.testCreator || dbConfig['test-creator'] || 'claude-haiku-4-5-20251001',
    'contract-tester': dbConfig.contractTester || dbConfig['contract-tester'] || 'claude-haiku-4-5-20251001',
    'contract-fixer': dbConfig.contractFixer || dbConfig['contract-fixer'] || 'claude-sonnet-4-5-20250929',
    'error-detective': dbConfig.errorDetective || dbConfig['error-detective'] || 'claude-opus-4-1-20250805', // Default to Opus for critical error analysis
  };
}

/**
 * Get model for a specific agent type
 */
export function getAgentModel(
  agentType: string,
  config: AgentModelConfig = STANDARD_CONFIG
): ClaudeModel {
  const selectedModel = config[agentType as keyof AgentModelConfig];

  if (!selectedModel) {
    console.warn(`⚠️ [getAgentModel] Unknown agent type: ${agentType}, defaulting to SONNET (best model)`);
    return 'claude-sonnet-4-5-20250929'; // Default to best general-purpose model
  }

  console.log(`🎯 [getAgentModel] ${agentType} → ${selectedModel}`);
  return selectedModel;
}

/**
 * Convert full model ID to SDK alias
 * Maps actual Anthropic model IDs to SDK model names
 */
export function getModelAlias(fullModelId: string): string {
  const aliasMap: Record<string, string> = {
    'claude-sonnet-4-5-20250929': 'sonnet',
    'claude-haiku-4-5-20251001': 'haiku',
    'claude-opus-4-1-20250805': 'opus',
  };
  const alias = aliasMap[fullModelId];
  if (!alias) {
    console.warn(`⚠️ [getModelAlias] Unknown model ID: ${fullModelId}, defaulting to SONNET`);
    return 'sonnet'; // Default to best model if unknown
  }
  return alias;
}

/**
 * Calculate estimated cost for a configuration
 */
export function estimateConfigCost(
  config: AgentModelConfig,
  estimatedTokens = {
    input: 500000,   // 500K input tokens average
    output: 200000,  // 200K output tokens average
  }
): number {
  let totalCost = 0;

  Object.values(config).forEach(model => {
    const pricing = MODEL_PRICING[model as ClaudeModel];
    const inputCost = (estimatedTokens.input * pricing.inputPerMillion) / 1_000_000;
    const outputCost = (estimatedTokens.output * pricing.outputPerMillion) / 1_000_000;
    totalCost += inputCost + outputCost;
  });

  return totalCost;
}

/**
 * Validate that a configuration doesn't exceed budget
 */
export function validateBudget(
  config: AgentModelConfig,
  maxBudgetUSD: number
): boolean {
  const estimatedCost = estimateConfigCost(config);
  return estimatedCost <= maxBudgetUSD;
}

/**
 * Get the most powerful (expensive) model from a configuration
 * Used for timeout retries - escalate to the best model available in user's config
 */
export function getTopModelFromConfig(config: AgentModelConfig): ClaudeModel {
  // Get all unique models used in the config
  const modelsUsed = new Set(Object.values(config));

  // Priority order: Opus > Sonnet > Haiku
  if (modelsUsed.has('claude-opus-4-1-20250805')) {
    return 'claude-opus-4-1-20250805';
  }
  if (modelsUsed.has('claude-sonnet-4-5-20250929')) {
    return 'claude-sonnet-4-5-20250929';
  }
  return 'claude-haiku-4-5-20251001'; // Fallback
}

/**
 * Escalate a configuration to use the top model for all agents
 * Used for timeout retries - temporarily boost all agents to best available model
 */
export function escalateConfigToTopModel(config: AgentModelConfig): AgentModelConfig {
  const topModel = getTopModelFromConfig(config);

  // Create new config with all agents using the top model
  const escalatedConfig: AgentModelConfig = {} as AgentModelConfig;

  for (const agent in config) {
    escalatedConfig[agent as keyof AgentModelConfig] = topModel;
  }

  return escalatedConfig;
}