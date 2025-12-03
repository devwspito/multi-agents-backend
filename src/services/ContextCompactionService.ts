/**
 * Context Compaction Service
 *
 * Implements Anthropic best practice: "Automatically summarize previous messages near context limits"
 * https://www.anthropic.com/engineering/context-management
 *
 * Monitors token usage and compacts conversation history when approaching limits
 * to prevent context overflow errors in long-running agent sessions.
 *
 * Uses Claude itself to create intelligent summaries of conversation history.
 */
export class ContextCompactionService {
  private anthropic: any;

  // Model context limits (Claude 4.5 models)
  private readonly CONTEXT_LIMITS: Record<string, number> = {
    'claude-sonnet-4-5-20250929': 200000,
    'claude-haiku-4-5-20251001': 200000,
    'claude-opus-4-5-20251101': 200000,
    default: 200000,
  };

  // Threshold to trigger compaction (80% of limit)
  private readonly COMPACTION_THRESHOLD = 0.8;

  constructor() {
    // Initialize Anthropic client for summarization
    const Anthropic = require('@anthropic-ai/sdk');
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Check if context should be compacted
   */
  shouldCompact(usage: any, model?: string): boolean {
    if (!usage) return false;

    const totalTokens =
      (usage.input_tokens || 0) +
      (usage.output_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);

    const limit = this.getContextLimit(model);
    const threshold = limit * this.COMPACTION_THRESHOLD;

    const shouldCompact = totalTokens >= threshold;

    if (shouldCompact) {
      console.log(
        `⚠️ [Context Compaction] Token usage ${totalTokens}/${limit} (${((totalTokens / limit) * 100).toFixed(1)}%) - Compaction recommended`
      );
    }

    return shouldCompact;
  }

  /**
   * Get context limit for a model
   */
  private getContextLimit(model?: string): number {
    if (!model) return this.CONTEXT_LIMITS.default;

    const modelKey = Object.keys(this.CONTEXT_LIMITS).find((key) => model.includes(key));
    return modelKey ? this.CONTEXT_LIMITS[modelKey as keyof typeof this.CONTEXT_LIMITS] : this.CONTEXT_LIMITS.default;
  }

  /**
   * Compact conversation history
   *
   * Strategies:
   * 1. Summarize old messages
   * 2. Keep recent messages intact
   * 3. Preserve critical context (requirements, architecture decisions)
   */
  compactHistory(conversationHistory: string[], preserveCount: number = 10): {
    compacted: string[];
    summary: string;
  } {
    console.log(`🗜️ [Context Compaction] Compacting conversation history...`);
    console.log(`  Original messages: ${conversationHistory.length}`);
    console.log(`  Preserving last ${preserveCount} messages`);

    if (conversationHistory.length <= preserveCount) {
      // No compaction needed
      return {
        compacted: conversationHistory,
        summary: 'No compaction needed - history within limits',
      };
    }

    // Split into old (to be summarized) and recent (to be preserved)
    const cutoffIndex = conversationHistory.length - preserveCount;
    const oldMessages = conversationHistory.slice(0, cutoffIndex);
    const recentMessages = conversationHistory.slice(cutoffIndex);

    // Create summary of old messages
    const summary = this.summarizeMessages(oldMessages);

    // Combine summary with recent messages
    const compacted = [
      '--- CONVERSATION HISTORY SUMMARY ---',
      summary,
      '--- END SUMMARY ---',
      '',
      '--- RECENT MESSAGES ---',
      ...recentMessages,
    ];

    console.log(`✅ [Context Compaction] Compaction complete`);
    console.log(`  Compacted messages: ${compacted.length}`);
    console.log(`  Reduction: ${((1 - compacted.length / conversationHistory.length) * 100).toFixed(1)}%`);

    return {
      compacted,
      summary: `Compacted ${oldMessages.length} old messages into summary`,
    };
  }

  /**
   * Compact conversation history using Claude for intelligent summarization
   *
   * Following Anthropic best practice: Use Claude to summarize conversation history
   * https://www.anthropic.com/engineering/context-management
   */
  async compactWithClaude(
    conversationHistory: any[],
    preserveCount: number = 10
  ): Promise<{ compacted: any[]; summary: string }> {
    console.log(`🤖 [Context Compaction] Using Claude for intelligent summarization...`);
    console.log(`  Original messages: ${conversationHistory.length}`);
    console.log(`  Preserving last ${preserveCount} messages`);

    if (conversationHistory.length <= preserveCount) {
      return {
        compacted: conversationHistory,
        summary: 'No compaction needed - history within limits',
      };
    }

    // Split into old (to be summarized) and recent (to be preserved)
    const cutoffIndex = conversationHistory.length - preserveCount;
    const oldMessages = conversationHistory.slice(0, cutoffIndex);
    const recentMessages = conversationHistory.slice(cutoffIndex);

    // Ask Claude to summarize the old messages
    try {
      const messagesToSummarize = oldMessages
        .map((msg: any, idx: number) => {
          const role = msg.role || 'unknown';
          const content = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content).substring(0, 500);
          return `[${idx + 1}] ${role}: ${content}`;
        })
        .join('\n\n');

      const response = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', // Use Haiku for cost efficiency
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `Summarize this conversation history concisely. Focus on:
- Key requirements and decisions
- Important technical details
- Actions taken and their outcomes
- Any errors or issues encountered

Keep the summary under 500 words but capture all critical information.

CONVERSATION HISTORY:
${messagesToSummarize}

Provide a structured summary:`
        }]
      });

      const summary = response.content[0].type === 'text'
        ? response.content[0].text
        : 'Summary generation failed';

      // Create compacted history with Claude's summary
      const compactedHistory = [
        {
          role: 'user',
          content: `--- CONVERSATION HISTORY SUMMARY (${oldMessages.length} messages) ---\n${summary}\n--- END SUMMARY ---`
        },
        ...recentMessages
      ];

      console.log(`✅ [Context Compaction] Claude summarization complete`);
      console.log(`  Compacted messages: ${compactedHistory.length} (from ${conversationHistory.length})`);
      console.log(`  Reduction: ${((1 - compactedHistory.length / conversationHistory.length) * 100).toFixed(1)}%`);

      return {
        compacted: compactedHistory,
        summary: `Claude summarized ${oldMessages.length} messages`
      };
    } catch (error: any) {
      console.error(`❌ [Context Compaction] Claude summarization failed:`, error.message);
      // Fallback to simple summarization
      return this.compactHistory(
        conversationHistory.map((msg: any) => JSON.stringify(msg)),
        preserveCount
      );
    }
  }

  /**
   * Summarize a list of messages (simple fallback method)
   */
  private summarizeMessages(messages: string[]): string {
    // Simple summarization strategy:
    // - Extract key information (requirements, decisions, errors)
    // - Remove verbose details
    // - Keep action items and outcomes

    const summary: string[] = [];

    // Analyze message content
    const requirements: string[] = [];
    const decisions: string[] = [];
    const errors: string[] = [];
    const actions: string[] = [];

    for (const message of messages) {
      // Extract requirements
      if (message.toLowerCase().includes('requirement') || message.toLowerCase().includes('must')) {
        requirements.push(message);
      }

      // Extract technical decisions
      if (
        message.toLowerCase().includes('decision:') ||
        message.toLowerCase().includes('architecture:') ||
        message.toLowerCase().includes('design:')
      ) {
        decisions.push(message);
      }

      // Extract errors
      if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
        errors.push(message);
      }

      // Extract completed actions
      if (message.toLowerCase().includes('completed') || message.toLowerCase().includes('implemented')) {
        actions.push(message);
      }
    }

    // Build summary
    summary.push(`**Conversation Summary** (${messages.length} messages compacted)`);
    summary.push('');

    if (requirements.length > 0) {
      summary.push('**Key Requirements:**');
      requirements.slice(0, 5).forEach((req) => summary.push(`- ${this.truncate(req, 200)}`));
      if (requirements.length > 5) summary.push(`- ... and ${requirements.length - 5} more`);
      summary.push('');
    }

    if (decisions.length > 0) {
      summary.push('**Technical Decisions:**');
      decisions.slice(0, 5).forEach((dec) => summary.push(`- ${this.truncate(dec, 200)}`));
      if (decisions.length > 5) summary.push(`- ... and ${decisions.length - 5} more`);
      summary.push('');
    }

    if (actions.length > 0) {
      summary.push('**Completed Actions:**');
      actions.slice(0, 10).forEach((act) => summary.push(`- ${this.truncate(act, 200)}`));
      if (actions.length > 10) summary.push(`- ... and ${actions.length - 10} more`);
      summary.push('');
    }

    if (errors.length > 0) {
      summary.push('**Errors/Issues:**');
      errors.slice(0, 5).forEach((err) => summary.push(`- ${this.truncate(err, 200)}`));
      if (errors.length > 5) summary.push(`- ... and ${errors.length - 5} more`);
      summary.push('');
    }

    return summary.join('\n');
  }

  /**
   * Truncate a string to a maximum length
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
  }

  /**
   * Estimate token count (rough approximation)
   * 1 token ≈ 4 characters for English text
   */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Check if compaction is needed based on conversation history
   */
  needsCompaction(conversationHistory: string[], model?: string): boolean {
    // Estimate total tokens in conversation
    const totalText = conversationHistory.join('\n');
    const estimatedTokens = this.estimateTokens(totalText);

    const limit = this.getContextLimit(model);
    const threshold = limit * this.COMPACTION_THRESHOLD;

    return estimatedTokens >= threshold;
  }
}
