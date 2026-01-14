/**
 * AnthropicProvider - Claude API Implementation
 *
 * Primary AI provider with best quality for complex tasks.
 * Implements the AIProvider interface for Anthropic's Claude models.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  AIProvider,
  ProviderConfig,
  Message,
  QueryOptions,
  CompletionResult,
  StreamEvent,
  ANTHROPIC_MODELS,
  ContentBlock,
  ToolCall
} from './AIProvider';

export class AnthropicProvider extends AIProvider {
  readonly name = 'anthropic' as const;
  readonly displayName = 'Anthropic (Claude)';
  readonly models = ANTHROPIC_MODELS;

  private client: Anthropic;

  constructor(config: ProviderConfig = {}) {
    super({
      defaultModel: 'claude-sonnet-4-20250514',
      ...config
    });

    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
      ...(config.baseUrl && { baseURL: config.baseUrl })
    });
  }

  /**
   * Complete a prompt (non-streaming)
   */
  async complete(messages: Message[], options: QueryOptions = {}): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = options.model || this.config.defaultModel || 'claude-sonnet-4-20250514';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const anthropicMessages = this.convertMessages(messages);

      const response = await this.client.messages.create({
        model,
        max_tokens: options.maxTokens || modelInfo.maxOutputTokens,
        messages: anthropicMessages,
        ...(options.systemPrompt && { system: options.systemPrompt }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && { tools: this.convertTools(options.tools) })
      });

      const latencyMs = Date.now() - startTime;
      this.updateStatus(true, latencyMs);

      // Extract text content and tool calls
      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, any>
          });
        }
      }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;

      return {
        content,
        model,
        provider: 'anthropic',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        cost: this.calculateCost(modelInfo, inputTokens, outputTokens),
        finishReason: this.mapStopReason(response.stop_reason),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        latencyMs
      };
    } catch (error: any) {
      this.updateStatus(false);
      throw new Error(`Anthropic API error: ${error.message}`);
    }
  }

  /**
   * Stream a completion
   */
  async *stream(messages: Message[], options: QueryOptions = {}): AsyncGenerator<StreamEvent> {
    const model = options.model || this.config.defaultModel || 'claude-sonnet-4-20250514';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const anthropicMessages = this.convertMessages(messages);

      const stream = this.client.messages.stream({
        model,
        max_tokens: options.maxTokens || modelInfo.maxOutputTokens,
        messages: anthropicMessages,
        ...(options.systemPrompt && { system: options.systemPrompt }),
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && { tools: this.convertTools(options.tools) })
      });

      let currentToolCall: Partial<ToolCall> | null = null;

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'tool_use') {
            currentToolCall = {
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: {}
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield {
              type: 'text',
              text: event.delta.text,
              partial: true
            };
          } else if (event.delta.type === 'input_json_delta' && currentToolCall) {
            // Accumulate JSON for tool arguments
            // This is partial JSON, needs to be accumulated
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolCall && currentToolCall.id) {
            yield {
              type: 'tool_call',
              toolCall: currentToolCall as ToolCall
            };
            currentToolCall = null;
          }
        } else if (event.type === 'message_stop') {
          yield { type: 'done' };
        }
      }

      this.updateStatus(true);
    } catch (error: any) {
      this.updateStatus(false);
      yield {
        type: 'error',
        error: error.message
      };
    }
  }

  /**
   * Check if provider is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Simple completion test
      await this.client.messages.create({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }]
      });
      this.updateStatus(true);
      return true;
    } catch {
      this.updateStatus(false);
      return false;
    }
  }

  // ==================== PRIVATE METHODS ====================

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    return messages
      .filter(m => m.role !== 'system') // System messages handled separately
      .map(m => {
        if (typeof m.content === 'string') {
          return {
            role: m.role as 'user' | 'assistant',
            content: m.content
          };
        }

        // Handle content blocks - use any[] since SDK types vary by version
        const contentBlocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam> = [];

        for (const block of m.content as ContentBlock[]) {
          if (block.type === 'text' && block.text) {
            contentBlocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'image' && block.image) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.image.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: block.image.data
              }
            });
          } else if (block.type === 'tool_use' && block.toolUse) {
            contentBlocks.push({
              type: 'tool_use',
              id: block.toolUse.id,
              name: block.toolUse.name,
              input: block.toolUse.input
            });
          } else if (block.type === 'tool_result' && block.toolResult) {
            contentBlocks.push({
              type: 'tool_result',
              tool_use_id: block.toolResult.toolUseId,
              content: block.toolResult.content
            });
          }
        }

        return {
          role: m.role as 'user' | 'assistant',
          content: contentBlocks
        };
      });
  }

  private convertTools(tools: QueryOptions['tools']): Anthropic.Tool[] {
    if (!tools) return [];

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
    }));
  }

  private mapStopReason(reason: string | null): CompletionResult['finishReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}

// Export factory function
export function createAnthropicProvider(config?: ProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config);
}
