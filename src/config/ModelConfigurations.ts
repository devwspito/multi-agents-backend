/**
 * Model Configuration System
 *
 * SIMPLIFIED: All agents use OPUS by default for maximum code quality.
 * Optional: Switch to Sonnet at project level for cost savings.
 *
 * Latest models (as of Jan 2026):
 * - Claude Opus 4.5 (claude-opus-4-5-20251101) - DEFAULT - Maximum intelligence
 * - Claude Sonnet 4.5 (claude-sonnet-4-5-20250929) - Optional - Good balance
 */

// Model IDs - explicit versions for predictable behavior
export const MODEL_IDS = {
  OPUS: 'claude-opus-4-5-20251101',
  SONNET: 'claude-sonnet-4-5-20250929',
} as const;

// Model alias type
export type ClaudeModel = 'opus' | 'sonnet';

// Convert alias to explicit model ID
export function getExplicitModelId(alias: string): string {
  switch (alias) {
    case 'opus': return MODEL_IDS.OPUS;
    case 'sonnet': return MODEL_IDS.SONNET;
    default:
      console.warn(`[ModelConfig] Unknown alias "${alias}", defaulting to OPUS`);
      return MODEL_IDS.OPUS;
  }
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

// Pricing per million tokens (as of Jan 2026)
export const MODEL_PRICING: Record<ClaudeModel, ModelPricing> = {
  'opus': {
    inputPerMillion: 15,
    outputPerMillion: 75,
  },
  'sonnet': {
    inputPerMillion: 3,
    outputPerMillion: 15,
  },
};

/**
 * Agent types in the orchestration system
 */
export type AgentType =
  | 'planning-agent'
  | 'tech-lead'
  | 'developer'
  | 'judge'
  | 'fixer'              // Sandbox fixer - diagnoses and fixes compilation errors
  | 'explorer'           // Quick Dev - read-only codebase exploration
  | 'assistant'          // Quick Dev - answers questions without actions
  | 'planner'            // Quick Dev - plans changes without execution
  | 'verification-fixer'
  | 'recovery-analyst'
  | 'auto-merge'
  | 'story-merge-agent'
  | 'git-flow-manager'
  | 'conflict-resolver';

/**
 * Get model for any agent
 *
 * @param _agentType - Agent type (ignored - all use same model)
 * @param projectModel - Optional project-level override ('opus' | 'sonnet')
 * @returns Model alias to use
 */
export function getAgentModel(
  _agentType: string,
  projectModel: ClaudeModel = 'opus'
): ClaudeModel {
  return projectModel;
}

/**
 * Calculate cost for token usage
 */
export function calculateCost(
  model: ClaudeModel,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model];
  const inputCost = (inputTokens * pricing.inputPerMillion) / 1_000_000;
  const outputCost = (outputTokens * pricing.outputPerMillion) / 1_000_000;
  return inputCost + outputCost;
}

/**
 * Get display info for a model
 */
export function getModelInfo(model: ClaudeModel): { name: string; description: string } {
  switch (model) {
    case 'opus':
      return {
        name: 'Opus 4.5',
        description: 'Maximum intelligence - best code quality',
      };
    case 'sonnet':
      return {
        name: 'Sonnet 4.5',
        description: 'Good balance of quality and cost',
      };
  }
}
