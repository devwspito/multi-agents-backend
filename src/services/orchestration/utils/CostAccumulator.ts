/**
 * Cost Accumulator - Centralized cost and token tracking
 *
 * Replaces scattered variable declarations like:
 *   let totalDeveloperCost = 0;
 *   let totalJudgeCost = 0;
 *   let totalDeveloperTokens = { input: 0, output: 0 };
 *   ...
 *
 * With cleaner usage:
 *   const costs = new CostAccumulator();
 *   costs.add('developer', cost, { input, output });
 */

export interface TokenUsage {
  input: number;
  output: number;
}

export type CostCategory = 'developer' | 'judge' | 'conflictResolution' | 'techLead' | 'planning' | 'other';

interface CategoryData {
  cost: number;
  tokens: TokenUsage;
}

export class CostAccumulator {
  private categories: Map<CostCategory, CategoryData> = new Map();

  constructor() {
    // Initialize all categories to zero
    const defaultCategories: CostCategory[] = ['developer', 'judge', 'conflictResolution', 'techLead', 'planning', 'other'];
    for (const cat of defaultCategories) {
      this.categories.set(cat, { cost: 0, tokens: { input: 0, output: 0 } });
    }
  }

  /**
   * Add cost and tokens to a category
   */
  add(category: CostCategory, cost: number, tokens?: Partial<TokenUsage>): void {
    const data = this.categories.get(category) || { cost: 0, tokens: { input: 0, output: 0 } };
    data.cost += cost;
    if (tokens) {
      data.tokens.input += tokens.input || 0;
      data.tokens.output += tokens.output || 0;
    }
    this.categories.set(category, data);
  }

  /**
   * Get cost for a specific category
   */
  getCost(category: CostCategory): number {
    return this.categories.get(category)?.cost || 0;
  }

  /**
   * Get tokens for a specific category
   */
  getTokens(category: CostCategory): TokenUsage {
    return this.categories.get(category)?.tokens || { input: 0, output: 0 };
  }

  /**
   * Get total cost across all categories
   */
  getTotalCost(): number {
    let total = 0;
    for (const data of this.categories.values()) {
      total += data.cost;
    }
    return total;
  }

  /**
   * Get total tokens across all categories
   */
  getTotalTokens(): TokenUsage {
    const total: TokenUsage = { input: 0, output: 0 };
    for (const data of this.categories.values()) {
      total.input += data.tokens.input;
      total.output += data.tokens.output;
    }
    return total;
  }

  /**
   * Get breakdown by category
   */
  getBreakdown(): Record<CostCategory, { cost: number; tokens: TokenUsage }> {
    const breakdown: Record<string, { cost: number; tokens: TokenUsage }> = {};
    for (const [category, data] of this.categories.entries()) {
      breakdown[category] = { ...data };
    }
    return breakdown as Record<CostCategory, { cost: number; tokens: TokenUsage }>;
  }

  /**
   * Get summary for logging/reporting
   */
  getSummary(): {
    totalCost: number;
    totalTokens: TokenUsage;
    breakdown: Record<CostCategory, { cost: number; tokens: TokenUsage }>;
  } {
    return {
      totalCost: this.getTotalCost(),
      totalTokens: this.getTotalTokens(),
      breakdown: this.getBreakdown(),
    };
  }

  /**
   * Format cost as currency string
   */
  static formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
  }

  /**
   * Format tokens as human-readable string
   */
  static formatTokens(tokens: TokenUsage): string {
    return `${tokens.input.toLocaleString()} in / ${tokens.output.toLocaleString()} out`;
  }
}
