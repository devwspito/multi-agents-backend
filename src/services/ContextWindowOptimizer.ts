/**
 * ContextWindowOptimizer
 *
 * Intelligent context window management to prevent overflow and optimize token usage.
 * Monitors context size and automatically summarizes/prunes when approaching limits.
 *
 * Key behaviors:
 * 1. Track context size in real-time
 * 2. Prioritize recent and relevant content
 * 3. Summarize older content when needed
 * 4. Preserve critical information (errors, decisions, code)
 */

export interface ContextChunk {
  id: string;
  type: 'code' | 'output' | 'instruction' | 'error' | 'decision' | 'summary';
  content: string;
  tokens: number;
  timestamp: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  metadata?: {
    file?: string;
    phase?: string;
    isError?: boolean;
    isDecision?: boolean;
  };
}

export interface ContextState {
  totalTokens: number;
  maxTokens: number;
  usagePercent: number;
  chunks: ContextChunk[];
  summarized: ContextChunk[];
  pruned: number;
}

export interface OptimizationResult {
  action: 'none' | 'summarize' | 'prune' | 'compact';
  tokensSaved: number;
  chunksAffected: number;
  newState: ContextState;
}

export interface ContextConfig {
  maxTokens: number;
  warningThreshold: number; // 0.7 = 70%
  criticalThreshold: number; // 0.85 = 85%
  preserveLastN: number; // Always keep last N chunks
  summaryMaxTokens: number; // Max tokens for summaries
}

const DEFAULT_CONFIG: ContextConfig = {
  maxTokens: 200000, // Claude's context window
  warningThreshold: 0.7,
  criticalThreshold: 0.85,
  preserveLastN: 10,
  summaryMaxTokens: 2000,
};

export class ContextWindowOptimizer {
  private config: ContextConfig;
  private state: ContextState;

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = {
      totalTokens: 0,
      maxTokens: this.config.maxTokens,
      usagePercent: 0,
      chunks: [],
      summarized: [],
      pruned: 0,
    };
  }

  /**
   * Add content to context with automatic optimization
   */
  addContent(
    content: string,
    type: ContextChunk['type'],
    priority: ContextChunk['priority'] = 'medium',
    metadata?: ContextChunk['metadata']
  ): OptimizationResult {
    const tokens = this.estimateTokens(content);

    const chunk: ContextChunk = {
      id: `chunk-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      content,
      tokens,
      timestamp: Date.now(),
      priority,
      metadata,
    };

    this.state.chunks.push(chunk);
    this.state.totalTokens += tokens;
    this.state.usagePercent = this.state.totalTokens / this.state.maxTokens;

    // Check if optimization is needed
    return this.optimizeIfNeeded();
  }

  /**
   * Optimize context if thresholds are exceeded
   */
  private optimizeIfNeeded(): OptimizationResult {
    const result: OptimizationResult = {
      action: 'none',
      tokensSaved: 0,
      chunksAffected: 0,
      newState: this.state,
    };

    // Critical threshold - aggressive pruning
    if (this.state.usagePercent >= this.config.criticalThreshold) {
      return this.compactContext();
    }

    // Warning threshold - summarize old content
    if (this.state.usagePercent >= this.config.warningThreshold) {
      return this.summarizeOldContent();
    }

    return result;
  }

  /**
   * Summarize older, lower-priority content
   */
  private summarizeOldContent(): OptimizationResult {
    const chunks = [...this.state.chunks];
    const candidates = chunks.slice(0, -this.config.preserveLastN);

    // Group candidates by priority
    const lowPriority = candidates.filter(c => c.priority === 'low');
    const mediumPriority = candidates.filter(c => c.priority === 'medium');

    let tokensSaved = 0;
    let chunksAffected = 0;

    // Summarize low priority first
    for (const chunk of lowPriority) {
      if (chunk.type === 'output' || chunk.type === 'code') {
        const summary = this.createSummary(chunk);
        tokensSaved += chunk.tokens - summary.tokens;
        chunksAffected++;

        // Replace chunk with summary
        const index = this.state.chunks.findIndex(c => c.id === chunk.id);
        if (index >= 0) {
          this.state.summarized.push(chunk);
          this.state.chunks[index] = summary;
        }
      }
    }

    // If still above threshold, summarize medium priority
    this.state.totalTokens -= tokensSaved;
    this.state.usagePercent = this.state.totalTokens / this.state.maxTokens;

    if (this.state.usagePercent >= this.config.warningThreshold) {
      for (const chunk of mediumPriority) {
        if (chunk.type !== 'error' && chunk.type !== 'decision') {
          const summary = this.createSummary(chunk);
          tokensSaved += chunk.tokens - summary.tokens;
          chunksAffected++;

          const index = this.state.chunks.findIndex(c => c.id === chunk.id);
          if (index >= 0) {
            this.state.summarized.push(chunk);
            this.state.chunks[index] = summary;
          }
        }
      }
    }

    this.state.totalTokens -= tokensSaved;
    this.state.usagePercent = this.state.totalTokens / this.state.maxTokens;

    return {
      action: 'summarize',
      tokensSaved,
      chunksAffected,
      newState: this.state,
    };
  }

  /**
   * Aggressively compact context when critical
   */
  private compactContext(): OptimizationResult {
    const chunks = [...this.state.chunks];
    const candidates = chunks.slice(0, -this.config.preserveLastN);

    let tokensSaved = 0;
    let chunksAffected = 0;

    // Remove low priority non-essential content
    const toRemove = candidates.filter(c =>
      c.priority === 'low' &&
      c.type !== 'error' &&
      c.type !== 'decision'
    );

    for (const chunk of toRemove) {
      tokensSaved += chunk.tokens;
      chunksAffected++;
      this.state.pruned++;
    }

    // Remove the pruned chunks
    this.state.chunks = this.state.chunks.filter(c =>
      !toRemove.some(r => r.id === c.id)
    );

    // Summarize remaining candidates
    const remaining = this.state.chunks.slice(0, -this.config.preserveLastN);
    for (const chunk of remaining) {
      if (chunk.type !== 'summary' && chunk.priority !== 'critical') {
        const summary = this.createSummary(chunk);
        tokensSaved += chunk.tokens - summary.tokens;

        const index = this.state.chunks.findIndex(c => c.id === chunk.id);
        if (index >= 0) {
          this.state.summarized.push(chunk);
          this.state.chunks[index] = summary;
          chunksAffected++;
        }
      }
    }

    this.state.totalTokens -= tokensSaved;
    this.state.usagePercent = this.state.totalTokens / this.state.maxTokens;

    return {
      action: 'compact',
      tokensSaved,
      chunksAffected,
      newState: this.state,
    };
  }

  /**
   * Create a summary of a chunk
   */
  private createSummary(chunk: ContextChunk): ContextChunk {
    let summaryContent: string;

    switch (chunk.type) {
      case 'code':
        summaryContent = this.summarizeCode(chunk.content, chunk.metadata?.file);
        break;
      case 'output':
        summaryContent = this.summarizeOutput(chunk.content);
        break;
      default:
        summaryContent = this.summarizeGeneric(chunk.content);
    }

    return {
      id: `summary-${chunk.id}`,
      type: 'summary',
      content: summaryContent,
      tokens: this.estimateTokens(summaryContent),
      timestamp: chunk.timestamp,
      priority: 'low',
      metadata: {
        ...chunk.metadata,
        originalType: chunk.type as any,
        originalTokens: chunk.tokens,
      } as any,
    };
  }

  /**
   * Summarize code content
   */
  private summarizeCode(code: string, file?: string): string {
    const lines = code.split('\n');
    const functions = code.match(/(?:function|const|class)\s+(\w+)/g) || [];
    const exports = code.match(/export\s+(?:default\s+)?(?:function|const|class|interface)\s+(\w+)/g) || [];

    return `[Code Summary${file ? ` - ${file}` : ''}]
Lines: ${lines.length}
Functions/Classes: ${functions.slice(0, 5).join(', ')}${functions.length > 5 ? ` (+${functions.length - 5} more)` : ''}
Exports: ${exports.slice(0, 3).join(', ')}${exports.length > 3 ? ` (+${exports.length - 3} more)` : ''}`;
  }

  /**
   * Summarize output content
   */
  private summarizeOutput(output: string): string {
    const lines = output.split('\n');
    const errors = lines.filter(l => l.toLowerCase().includes('error'));
    const warnings = lines.filter(l => l.toLowerCase().includes('warning'));

    if (errors.length > 0) {
      return `[Output Summary]
Total lines: ${lines.length}
Errors: ${errors.length}
Key errors: ${errors.slice(0, 3).join('\n')}`;
    }

    return `[Output Summary]
Total lines: ${lines.length}
Warnings: ${warnings.length}
First line: ${lines[0]?.substring(0, 100) || 'empty'}
Last line: ${lines[lines.length - 1]?.substring(0, 100) || 'empty'}`;
  }

  /**
   * Generic content summary
   */
  private summarizeGeneric(content: string): string {
    const words = content.split(/\s+/).length;
    const preview = content.substring(0, 200);

    return `[Summary - ${words} words]
${preview}${content.length > 200 ? '...' : ''}`;
  }

  /**
   * Estimate token count (rough approximation)
   */
  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Get current context state
   */
  getState(): ContextState {
    return { ...this.state };
  }

  /**
   * Get optimization recommendations
   */
  getRecommendations(): string[] {
    const recommendations: string[] = [];

    if (this.state.usagePercent >= this.config.criticalThreshold) {
      recommendations.push('🚨 CRITICAL: Context at ' + Math.round(this.state.usagePercent * 100) + '% - immediate action needed');
      recommendations.push('Consider: Complete current task and start fresh conversation');
    } else if (this.state.usagePercent >= this.config.warningThreshold) {
      recommendations.push('⚠️ WARNING: Context at ' + Math.round(this.state.usagePercent * 100) + '%');
      recommendations.push('Consider: Focus on essential files, avoid unnecessary reads');
    }

    const largeChunks = this.state.chunks.filter(c => c.tokens > 5000);
    if (largeChunks.length > 0) {
      recommendations.push(`${largeChunks.length} large content chunks detected - consider reading specific sections`);
    }

    return recommendations;
  }

  /**
   * Format context status for prompt
   */
  formatStatus(): string {
    const percent = Math.round(this.state.usagePercent * 100);
    const icon = percent >= 85 ? '🚨' : percent >= 70 ? '⚠️' : '✅';

    return `${icon} Context: ${percent}% (${this.state.totalTokens.toLocaleString()}/${this.state.maxTokens.toLocaleString()} tokens)`;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📊 CONTEXT WINDOW MANAGEMENT

Your context window is limited. Manage it wisely:

### Best Practices:

1. **Read Specific Sections**
   - Use \`offset\` and \`limit\` for large files
   - Don't read entire files if you only need a function

2. **Avoid Redundant Reads**
   - Don't re-read files you've already seen
   - Reference previous context instead

3. **Summarize Decisions**
   - When making architectural decisions, state them clearly
   - Future reference: "We decided to use JWT, not sessions"

4. **Clean Up**
   - Don't keep large code blocks in conversation
   - Summarize results: "Tests passed (5/5)"

### Warning Signs:

- 🟢 0-70%: Normal operation
- 🟡 70-85%: Be efficient, avoid unnecessary reads
- 🔴 85%+: Critical - complete task quickly

### If Context is Running Low:

1. Focus on immediate task only
2. Use grep/glob instead of reading files
3. Reference previous decisions without re-explaining
4. Complete current task before starting new ones
`;
  }
}
