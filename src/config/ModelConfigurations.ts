/**
 * Model Configuration System
 *
 * Allows users to select specific Claude models for each agent
 * Provides optimized presets for different use cases and budgets
 */

export type ClaudeModel =
  | 'claude-3-5-sonnet-20241022'  // Best balance of performance and cost
  | 'claude-3-5-haiku-20241022'   // Fast and economical
  | 'claude-3-opus-20240229';      // Most capable, highest cost

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const MODEL_PRICING: Record<ClaudeModel, ModelPricing> = {
  'claude-3-5-sonnet-20241022': {
    inputPerMillion: 3,    // $3 per million tokens
    outputPerMillion: 15,   // $15 per million tokens
  },
  'claude-3-5-haiku-20241022': {
    inputPerMillion: 1,     // $1 per million tokens
    outputPerMillion: 5,    // $5 per million tokens
  },
  'claude-3-opus-20240229': {
    inputPerMillion: 15,    // $15 per million tokens
    outputPerMillion: 75,   // $75 per million tokens
  },
};

export interface AgentModelConfig {
  problemAnalyst: ClaudeModel;
  productManager: ClaudeModel;
  projectManager: ClaudeModel;
  techLead: ClaudeModel;
  seniorDeveloper: ClaudeModel;
  juniorDeveloper: ClaudeModel;
  judge: ClaudeModel;
  qaEngineer: ClaudeModel;
  fixer: ClaudeModel;
  mergeCoordinator: ClaudeModel;
  autoMerge: ClaudeModel;
  e2eTester: ClaudeModel;
  e2eFixer: ClaudeModel;
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
  problemAnalyst: 'claude-3-opus-20240229',     // 🧠 Critical: Deep problem analysis
  productManager: 'claude-3-opus-20240229',      // 🧠 Critical: Requirements analysis
  projectManager: 'claude-3-opus-20240229',      // 🧠 Critical: Task breakdown & planning
  techLead: 'claude-3-opus-20240229',           // 🧠 Critical: Architecture design
  judge: 'claude-3-opus-20240229',              // 🧠 Critical: Code review
  qaEngineer: 'claude-3-opus-20240229',         // 🧠 Critical: Error detection
  fixer: 'claude-3-opus-20240229',              // 🧠 Critical: Bug fixes
  e2eFixer: 'claude-3-opus-20240229',           // 🧠 Critical: Integration fixes
  seniorDeveloper: 'claude-3-5-sonnet-20241022', // 💨 Execution: Implements architecture
  juniorDeveloper: 'claude-3-5-sonnet-20241022', // 💨 Execution: Simple tasks
  mergeCoordinator: 'claude-3-5-sonnet-20241022', // 💨 Execution: Git operations
  autoMerge: 'claude-3-5-sonnet-20241022',       // 💨 Execution: Automated merge
  e2eTester: 'claude-3-5-sonnet-20241022',      // 💨 Execution: Script execution
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
  problemAnalyst: 'claude-3-5-sonnet-20241022',  // 🧠 Critical: Deep problem analysis
  productManager: 'claude-3-5-sonnet-20241022',  // 🧠 Critical: Requirements
  projectManager: 'claude-3-5-sonnet-20241022',  // 🧠 Critical: Planning
  techLead: 'claude-3-5-sonnet-20241022',       // 🧠 Critical: Architecture
  judge: 'claude-3-5-sonnet-20241022',          // 🧠 Critical: Code review
  qaEngineer: 'claude-3-5-sonnet-20241022',     // 🧠 Critical: Error detection
  fixer: 'claude-3-5-sonnet-20241022',          // 🧠 Critical: Bug fixes
  e2eFixer: 'claude-3-5-sonnet-20241022',       // 🧠 Critical: Integration fixes
  seniorDeveloper: 'claude-3-5-haiku-20241022',  // 💨 Execution: Implementation
  juniorDeveloper: 'claude-3-5-haiku-20241022',  // 💨 Execution: Simple tasks
  mergeCoordinator: 'claude-3-5-haiku-20241022', // 💨 Execution: Git coordination
  autoMerge: 'claude-3-5-haiku-20241022',       // 💨 Execution: Automated merge
  e2eTester: 'claude-3-5-haiku-20241022',       // 💨 Execution: Script execution
};

/**
 * Balanced Configuration (Strategic Sonnet + Haiku)
 *
 * - Best cost-performance ratio
 * - Sonnet for critical thinking, Haiku for execution
 * - Estimated cost: $4-6 per session (40% less than STANDARD)
 *
 * Strategy:
 * - Sonnet: Orchestration (PM, PjM, TL, ProblemAnalyst), Quality (Judge, QA, Fixers)
 * - Haiku: Execution (Developers), Simple tasks (Merge)
 */
export const BALANCED_CONFIG: AgentModelConfig = {
  problemAnalyst: 'claude-3-5-sonnet-20241022',  // Critical: Deep analysis
  productManager: 'claude-3-5-sonnet-20241022',  // Critical: Requirements
  projectManager: 'claude-3-5-sonnet-20241022',  // Critical: Planning
  techLead: 'claude-3-5-sonnet-20241022',       // Critical: Architecture
  seniorDeveloper: 'claude-3-5-haiku-20241022',  // Execution - Haiku is capable
  juniorDeveloper: 'claude-3-5-haiku-20241022',  // Execution - Haiku is capable
  judge: 'claude-3-5-sonnet-20241022',          // Critical: Code review
  qaEngineer: 'claude-3-5-sonnet-20241022',     // Critical: Error detection
  fixer: 'claude-3-5-sonnet-20241022',          // Critical: Accurate fixes
  mergeCoordinator: 'claude-3-5-haiku-20241022', // Simple coordination
  autoMerge: 'claude-3-5-haiku-20241022',       // Simple automated task
  e2eTester: 'claude-3-5-haiku-20241022',       // Script execution - Haiku sufficient
  e2eFixer: 'claude-3-5-sonnet-20241022',       // Critical: Integration fixes
};

/**
 * Economy Configuration (All Haiku)
 *
 * - Lowest cost option
 * - For simple tasks and prototypes
 * - Estimated cost: $2-3 per session
 *
 * Note: May struggle with complex requirements
 */
export const ECONOMY_CONFIG: AgentModelConfig = {
  problemAnalyst: 'claude-3-5-haiku-20241022',
  productManager: 'claude-3-5-haiku-20241022',
  projectManager: 'claude-3-5-haiku-20241022',
  techLead: 'claude-3-5-haiku-20241022',
  seniorDeveloper: 'claude-3-5-haiku-20241022',
  juniorDeveloper: 'claude-3-5-haiku-20241022',
  judge: 'claude-3-5-haiku-20241022',
  qaEngineer: 'claude-3-5-haiku-20241022',
  fixer: 'claude-3-5-haiku-20241022',
  mergeCoordinator: 'claude-3-5-haiku-20241022',
  autoMerge: 'claude-3-5-haiku-20241022',
  e2eTester: 'claude-3-5-haiku-20241022',
  e2eFixer: 'claude-3-5-haiku-20241022',
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
  problemAnalyst: 'claude-3-opus-20240229',
  productManager: 'claude-3-opus-20240229',
  projectManager: 'claude-3-opus-20240229',
  techLead: 'claude-3-opus-20240229',
  seniorDeveloper: 'claude-3-opus-20240229',
  juniorDeveloper: 'claude-3-opus-20240229',
  judge: 'claude-3-opus-20240229',
  qaEngineer: 'claude-3-opus-20240229',
  fixer: 'claude-3-opus-20240229',
  mergeCoordinator: 'claude-3-opus-20240229',
  autoMerge: 'claude-3-opus-20240229',
  e2eTester: 'claude-3-opus-20240229',
  e2eFixer: 'claude-3-opus-20240229',
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
    topModel,
    bottomModel,
    savingsEstimate: models.length > 1 ? 'Optimized for cost' : 'Single model config'
  });

  return {
    // 🧠 CRITICAL THINKING - Use TOP MODEL (most capable)
    problemAnalyst: topModel,     // Deep problem analysis
    productManager: topModel,     // Requirements decisions
    projectManager: topModel,     // Planning & breakdown
    techLead: topModel,          // Architecture design
    judge: topModel,             // Code quality evaluation
    qaEngineer: topModel,        // Error detection
    fixer: topModel,             // Precise bug fixes
    e2eFixer: topModel,          // Complex integration fixes

    // 💨 EXECUTION - Use BOTTOM MODEL (economical)
    seniorDeveloper: bottomModel, // Executes defined architecture
    juniorDeveloper: bottomModel, // Executes simple tasks
    mergeCoordinator: bottomModel, // Mechanical git operations
    autoMerge: bottomModel,       // Simple automation
    e2eTester: bottomModel,       // Script execution (curl, npm)
  };
}

/**
 * Get model for a specific agent type
 */
export function getAgentModel(
  agentType: string,
  config: AgentModelConfig = STANDARD_CONFIG
): ClaudeModel {
  switch (agentType) {
    case 'problem-analyst':
      return config.problemAnalyst;
    case 'product-manager':
      return config.productManager;
    case 'project-manager':
      return config.projectManager;
    case 'tech-lead':
      return config.techLead;
    case 'senior-developer':
      return config.seniorDeveloper;
    case 'junior-developer':
      return config.juniorDeveloper;
    case 'judge':
      return config.judge;
    case 'qa-engineer':
      return config.qaEngineer;
    case 'fixer':
      return config.fixer;
    case 'merge-coordinator':
      return config.mergeCoordinator;
    case 'auto-merge':
      return config.autoMerge;
    case 'e2e-tester':
      return config.e2eTester;
    case 'e2e-fixer':
      return config.e2eFixer;
    default:
      // Default to Haiku for unknown agents
      return 'claude-3-5-haiku-20241022';
  }
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