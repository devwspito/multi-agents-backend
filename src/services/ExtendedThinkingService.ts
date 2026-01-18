/**
 * ExtendedThinkingService - Claude's Native Extended Thinking Mode
 *
 * Enables Claude's internal reasoning capability where the model can
 * "think" before responding, leading to better quality outputs for
 * complex tasks.
 *
 * Extended thinking is especially useful for:
 * - Complex architectural decisions
 * - Multi-step problem solving
 * - Code analysis requiring deep understanding
 * - Planning phases with many constraints
 *
 * Reference: Claude API supports extended thinking via the 'thinking' parameter
 */

import { EventEmitter } from 'events';

/**
 * Configuration for extended thinking
 */
export interface ExtendedThinkingConfig {
  enabled: boolean;
  budgetTokens: number;  // Max tokens for thinking (1024-32768)
  minComplexity: number; // Minimum complexity score to trigger (0-1)
}

/**
 * Complexity analysis result
 */
export interface ComplexityAnalysis {
  score: number;           // 0-1 complexity score
  factors: string[];       // What contributed to complexity
  recommendation: 'none' | 'light' | 'deep';
  suggestedBudget: number; // Suggested thinking budget
}

/**
 * Task indicators for complexity assessment
 */
interface TaskIndicators {
  hasMultipleFiles: boolean;
  hasArchitectureKeywords: boolean;
  hasRefactoringKeywords: boolean;
  hasSecurityKeywords: boolean;
  hasPerformanceKeywords: boolean;
  hasIntegrationKeywords: boolean;
  estimatedScope: 'small' | 'medium' | 'large';
  promptLength: number;
}

class ExtendedThinkingServiceClass extends EventEmitter {
  private defaultConfig: ExtendedThinkingConfig = {
    enabled: true,
    budgetTokens: 10000,  // Default 10K tokens for thinking
    minComplexity: 0.4,   // Trigger at 40% complexity
  };

  private taskConfigs: Map<string, ExtendedThinkingConfig> = new Map();

  // Keywords that indicate complex tasks
  private readonly ARCHITECTURE_KEYWORDS = [
    'architecture', 'design', 'system', 'infrastructure', 'scalab',
    'microservice', 'monolith', 'database', 'schema', 'migration',
    'api design', 'service layer', 'data model', 'entity',
  ];

  private readonly REFACTORING_KEYWORDS = [
    'refactor', 'restructure', 'reorganize', 'modular', 'decouple',
    'abstract', 'pattern', 'solid', 'clean code', 'technical debt',
    'legacy', 'rewrite', 'optimize structure',
  ];

  private readonly SECURITY_KEYWORDS = [
    'security', 'authentication', 'authorization', 'oauth', 'jwt',
    'encrypt', 'hash', 'vulnerability', 'xss', 'csrf', 'injection',
    'sanitize', 'validate', 'permission', 'role', 'access control',
  ];

  private readonly PERFORMANCE_KEYWORDS = [
    'performance', 'optimize', 'cache', 'index', 'query optimization',
    'latency', 'throughput', 'bottleneck', 'profil', 'memory leak',
    'concurrent', 'parallel', 'async', 'batch',
  ];

  private readonly INTEGRATION_KEYWORDS = [
    'integrat', 'third-party', 'external api', 'webhook', 'event',
    'message queue', 'kafka', 'rabbitmq', 'redis', 'elasticsearch',
    'docker', 'kubernetes', 'ci/cd', 'deploy',
  ];

  /**
   * Analyze task complexity to determine if extended thinking should be used
   */
  analyzeComplexity(
    prompt: string,
    agentType: string,
    context?: {
      filesInvolved?: number;
      previousErrors?: number;
      retryCount?: number;
    }
  ): ComplexityAnalysis {
    const promptLower = prompt.toLowerCase();
    const indicators = this.extractIndicators(promptLower, context);
    const factors: string[] = [];
    let score = 0;

    // Agent type weight
    const agentWeights: Record<string, number> = {
      'planning-agent': 0.35,     // Planning needs deep thinking
      'tech-lead': 0.4,           // Architecture decisions
      'developer': 0.25,          // Code complexity varies
      'judge': 0.3,               // Code review needs analysis
      'verification-fixer': 0.35, // Bug fixing needs investigation
      'recovery-analyst': 0.4,    // Error analysis needs deep thinking
      'auto-merge': 0.1,
    };

    const agentWeight = agentWeights[agentType] || 0.2;
    score += agentWeight;
    factors.push(`Agent type: ${agentType} (+${(agentWeight * 100).toFixed(0)}%)`);

    // Keyword analysis
    if (indicators.hasArchitectureKeywords) {
      score += 0.2;
      factors.push('Architecture/design decisions (+20%)');
    }

    if (indicators.hasRefactoringKeywords) {
      score += 0.15;
      factors.push('Refactoring complexity (+15%)');
    }

    if (indicators.hasSecurityKeywords) {
      score += 0.2;
      factors.push('Security considerations (+20%)');
    }

    if (indicators.hasPerformanceKeywords) {
      score += 0.15;
      factors.push('Performance optimization (+15%)');
    }

    if (indicators.hasIntegrationKeywords) {
      score += 0.15;
      factors.push('Integration complexity (+15%)');
    }

    // Scope analysis
    if (indicators.estimatedScope === 'large') {
      score += 0.15;
      factors.push('Large scope (+15%)');
    } else if (indicators.estimatedScope === 'medium') {
      score += 0.08;
      factors.push('Medium scope (+8%)');
    }

    // Multi-file indicator
    if (indicators.hasMultipleFiles || (context?.filesInvolved && context.filesInvolved > 3)) {
      score += 0.1;
      factors.push('Multiple files involved (+10%)');
    }

    // Retry/error context
    if (context?.retryCount && context.retryCount > 0) {
      score += 0.15 * Math.min(context.retryCount, 2);
      factors.push(`Retry attempt ${context.retryCount} (+${15 * Math.min(context.retryCount, 2)}%)`);
    }

    if (context?.previousErrors && context.previousErrors > 0) {
      score += 0.1;
      factors.push('Previous errors in context (+10%)');
    }

    // Prompt length factor (longer prompts often = more complex)
    if (indicators.promptLength > 2000) {
      score += 0.1;
      factors.push('Long prompt (+10%)');
    } else if (indicators.promptLength > 1000) {
      score += 0.05;
      factors.push('Medium prompt (+5%)');
    }

    // Cap at 1.0
    score = Math.min(score, 1.0);

    // Determine recommendation
    let recommendation: 'none' | 'light' | 'deep';
    let suggestedBudget: number;

    if (score >= 0.7) {
      recommendation = 'deep';
      suggestedBudget = 16000; // 16K tokens for deep thinking
    } else if (score >= 0.4) {
      recommendation = 'light';
      suggestedBudget = 8000;  // 8K tokens for light thinking
    } else {
      recommendation = 'none';
      suggestedBudget = 0;
    }

    const analysis: ComplexityAnalysis = {
      score: Math.round(score * 100) / 100,
      factors,
      recommendation,
      suggestedBudget,
    };

    this.emit('complexity:analyzed', { agentType, analysis });

    return analysis;
  }

  /**
   * Extract task indicators from prompt
   */
  private extractIndicators(promptLower: string, _context?: any): TaskIndicators {
    const hasKeywords = (keywords: string[]) =>
      keywords.some(kw => promptLower.includes(kw));

    // Estimate scope based on certain phrases
    let estimatedScope: 'small' | 'medium' | 'large' = 'small';
    if (promptLower.includes('entire') || promptLower.includes('all files') ||
        promptLower.includes('whole system') || promptLower.includes('complete')) {
      estimatedScope = 'large';
    } else if (promptLower.includes('multiple') || promptLower.includes('several') ||
               promptLower.includes('various') || promptLower.includes('across')) {
      estimatedScope = 'medium';
    }

    return {
      hasMultipleFiles: promptLower.includes('files') || promptLower.includes('multiple'),
      hasArchitectureKeywords: hasKeywords(this.ARCHITECTURE_KEYWORDS),
      hasRefactoringKeywords: hasKeywords(this.REFACTORING_KEYWORDS),
      hasSecurityKeywords: hasKeywords(this.SECURITY_KEYWORDS),
      hasPerformanceKeywords: hasKeywords(this.PERFORMANCE_KEYWORDS),
      hasIntegrationKeywords: hasKeywords(this.INTEGRATION_KEYWORDS),
      estimatedScope,
      promptLength: promptLower.length,
    };
  }

  /**
   * Get extended thinking configuration for an agent execution
   * Returns the thinking budget if extended thinking should be enabled, 0 otherwise
   */
  getThinkingBudget(
    taskId: string | undefined,
    agentType: string,
    prompt: string,
    context?: {
      filesInvolved?: number;
      previousErrors?: number;
      retryCount?: number;
    }
  ): number {
    const config = taskId ? this.taskConfigs.get(taskId) || this.defaultConfig : this.defaultConfig;

    if (!config.enabled) {
      return 0;
    }

    const analysis = this.analyzeComplexity(prompt, agentType, context);

    if (analysis.score < config.minComplexity) {
      console.log(`🧠 [ExtendedThinking] Skipping for ${agentType} - complexity ${analysis.score} < threshold ${config.minComplexity}`);
      return 0;
    }

    const budget = Math.min(analysis.suggestedBudget, config.budgetTokens);
    console.log(`🧠 [ExtendedThinking] Enabled for ${agentType} - complexity ${analysis.score}, budget ${budget} tokens`);
    console.log(`   Factors: ${analysis.factors.join(', ')}`);

    this.emit('thinking:enabled', {
      taskId,
      agentType,
      complexity: analysis.score,
      budget,
      factors: analysis.factors,
    });

    return budget;
  }

  /**
   * Set task-specific configuration
   */
  setTaskConfig(taskId: string, config: Partial<ExtendedThinkingConfig>): void {
    const existing = this.taskConfigs.get(taskId) || this.defaultConfig;
    this.taskConfigs.set(taskId, { ...existing, ...config });
  }

  /**
   * Get current configuration for a task
   */
  getTaskConfig(taskId: string): ExtendedThinkingConfig {
    return this.taskConfigs.get(taskId) || this.defaultConfig;
  }

  /**
   * Clear task configuration
   */
  clearTaskConfig(taskId: string): void {
    this.taskConfigs.delete(taskId);
  }

  /**
   * Update default configuration
   */
  setDefaultConfig(config: Partial<ExtendedThinkingConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(): ExtendedThinkingConfig {
    return { ...this.defaultConfig };
  }

  /**
   * Check if extended thinking is globally enabled
   */
  isEnabled(): boolean {
    return this.defaultConfig.enabled;
  }

  /**
   * Enable/disable extended thinking globally
   */
  setEnabled(enabled: boolean): void {
    this.defaultConfig.enabled = enabled;
    this.emit('config:changed', { enabled });
  }
}

// Singleton export
export const ExtendedThinkingService = new ExtendedThinkingServiceClass();
export default ExtendedThinkingService;
