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
}

/**
 * Premium Configuration (Opus + Sonnet)
 *
 * - Maximum quality and capabilities
 * - Best for complex, critical projects
 * - Estimated cost: $15-20 per session
 *
 * Strategy:
 * - Opus for critical thinking phases (PM, Tech Lead, Judge)
 * - Sonnet for implementation phases
 */
export const PREMIUM_CONFIG: AgentModelConfig = {
  productManager: 'claude-3-opus-20240229',      // Critical: Requirements analysis
  projectManager: 'claude-3-5-sonnet-20241022',  // Task breakdown
  techLead: 'claude-3-opus-20240229',           // Critical: Architecture design
  seniorDeveloper: 'claude-3-5-sonnet-20241022', // Complex implementation
  juniorDeveloper: 'claude-3-5-sonnet-20241022', // Simple implementation
  judge: 'claude-3-opus-20240229',              // Critical: Code review
  qaEngineer: 'claude-3-5-sonnet-20241022',     // Testing
  fixer: 'claude-3-5-sonnet-20241022',          // Bug fixes
  mergeCoordinator: 'claude-3-5-sonnet-20241022', // PR coordination
  autoMerge: 'claude-3-5-haiku-20241022',       // Automated merge (fast, simple)
};

/**
 * Standard Configuration (Sonnet + Haiku)
 *
 * - Good balance of quality and cost
 * - Suitable for most projects
 * - Estimated cost: $5-7 per session
 *
 * Strategy:
 * - Sonnet for critical thinking phases
 * - Haiku for implementation and routine tasks
 */
export const STANDARD_CONFIG: AgentModelConfig = {
  productManager: 'claude-3-5-sonnet-20241022',  // Critical: Requirements
  projectManager: 'claude-3-5-sonnet-20241022',  // Planning
  techLead: 'claude-3-5-sonnet-20241022',       // Critical: Architecture
  seniorDeveloper: 'claude-3-5-haiku-20241022',  // Implementation
  juniorDeveloper: 'claude-3-5-haiku-20241022',  // Simple tasks
  judge: 'claude-3-5-sonnet-20241022',          // Important: Code review
  qaEngineer: 'claude-3-5-haiku-20241022',      // Testing
  fixer: 'claude-3-5-haiku-20241022',           // Bug fixes
  mergeCoordinator: 'claude-3-5-haiku-20241022', // Routine coordination
  autoMerge: 'claude-3-5-haiku-20241022',       // Automated merge
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
};

/**
 * Get model for a specific agent type
 */
export function getAgentModel(
  agentType: string,
  config: AgentModelConfig = STANDARD_CONFIG
): ClaudeModel {
  switch (agentType) {
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