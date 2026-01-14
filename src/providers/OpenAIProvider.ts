/**
 * OpenAIProvider - GPT API Implementation
 *
 * Fallback AI provider with good quality.
 * Implements the AIProvider interface for OpenAI's GPT models.
 */

import OpenAI from 'openai';
import {
  AIProvider,
  ProviderConfig,
  Message,
  QueryOptions,
  CompletionResult,
  StreamEvent,
  OPENAI_MODELS,
  ContentBlock,
  ToolCall
} from './AIProvider';

export class OpenAIProvider extends AIProvider {
  readonly name = 'openai' as const;
  readonly displayName = 'OpenAI (GPT)';
  readonly models = OPENAI_MODELS;

  private client: OpenAI;

  constructor(config: ProviderConfig = {}) {
    super({
      defaultModel: 'gpt-4o',
      ...config
    });

    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      ...(config.baseUrl && { baseURL: config.baseUrl })
    });
  }

  /**
   * Complete a prompt (non-streaming)
   */
  async complete(messages: Message[], options: QueryOptions = {}): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = options.model || this.config.defaultModel || 'gpt-4o';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const openaiMessages = this.convertMessages(messages, options.systemPrompt);

      const response = await this.client.chat.completions.create({
        model,
        max_tokens: options.maxTokens || modelInfo.maxOutputTokens,
        messages: openaiMessages,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && { tools: this.convertTools(options.tools) })
      });

      const latencyMs = Date.now() - startTime;
      this.updateStatus(true, latencyMs);

      const choice = response.choices[0];
      const content = choice.message.content || '';

      // Extract tool calls
      const toolCalls: ToolCall[] = [];
      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if (tc.type === 'function') {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments || '{}')
            });
          }
        }
      }

      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;

      return {
        content,
        model,
        provider: 'openai',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        cost: this.calculateCost(modelInfo, inputTokens, outputTokens),
        finishReason: this.mapFinishReason(choice.finish_reason),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        latencyMs
      };
    } catch (error: any) {
      this.updateStatus(false);
      throw new Error(`OpenAI API error: ${error.message}`);
    }
  }

  /**
   * Stream a completion
   */
  async *stream(messages: Message[], options: QueryOptions = {}): AsyncGenerator<StreamEvent> {
    const model = options.model || this.config.defaultModel || 'gpt-4o';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const openaiMessages = this.convertMessages(messages, options.systemPrompt);

      const stream = await this.client.chat.completions.create({
        model,
        max_tokens: options.maxTokens || modelInfo.maxOutputTokens,
        messages: openaiMessages,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.tools && { tools: this.convertTools(options.tools) }),
        stream: true
      });

      const toolCallAccumulator: Map<number, { id: string; name: string; arguments: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (delta?.content) {
          yield {
            type: 'text',
            text: delta.content,
            partial: true
          };
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;

            if (!toolCallAccumulator.has(index)) {
              toolCallAccumulator.set(index, {
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: ''
              });
            }

            const accumulated = toolCallAccumulator.get(index)!;

            if (tc.id) accumulated.id = tc.id;
            if (tc.function?.name) accumulated.name = tc.function.name;
            if (tc.function?.arguments) accumulated.arguments += tc.function.arguments;
          }
        }

        if (chunk.choices[0]?.finish_reason === 'tool_calls') {
          // Emit accumulated tool calls
          for (const [_index, tc] of toolCallAccumulator) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: tc.id,
                name: tc.name,
                arguments: JSON.parse(tc.arguments || '{}')
              }
            };
          }
        }

        if (chunk.choices[0]?.finish_reason) {
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
      await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
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

  private convertMessages(
    messages: Message[],
    systemPrompt?: string
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    // Add system messages from input
    const systemMessages = messages.filter(m => m.role === 'system');
    for (const msg of systemMessages) {
      if (typeof msg.content === 'string') {
        result.push({ role: 'system', content: msg.content });
      }
    }

    // Convert other messages
    for (const msg of messages.filter(m => m.role !== 'system')) {
      if (msg.role === 'tool' && msg.toolResults) {
        // Tool results
        for (const tr of msg.toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.toolCallId,
            content: tr.content
          });
        }
        continue;
      }

      if (typeof msg.content === 'string') {
        if (msg.role === 'assistant' && msg.toolCalls) {
          result.push({
            role: 'assistant',
            content: msg.content || null,
            tool_calls: msg.toolCalls.map(tc => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments)
              }
            }))
          });
        } else {
          result.push({
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          });
        }
      } else {
        // Handle content blocks
        const contentParts: OpenAI.ChatCompletionContentPart[] = [];

        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text' && block.text) {
            contentParts.push({ type: 'text', text: block.text });
          } else if (block.type === 'image' && block.image) {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${block.image.mediaType};base64,${block.image.data}`
              }
            });
          }
        }

        if (contentParts.length > 0) {
          // Only user messages support content parts array
          if (msg.role === 'user') {
            result.push({
              role: 'user',
              content: contentParts
            });
          } else {
            // For assistant, convert to text
            const textContent = contentParts
              .filter(p => p.type === 'text')
              .map(p => (p as { type: 'text'; text: string }).text)
              .join('');
            result.push({
              role: 'assistant',
              content: textContent
            });
          }
        }
      }
    }

    return result;
  }

  private convertTools(tools: QueryOptions['tools']): OpenAI.ChatCompletionTool[] {
    if (!tools) return [];

    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  private mapFinishReason(reason: string | null): CompletionResult['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      default:
        return 'stop';
    }
  }
}

// Export factory function
export function createOpenAIProvider(config?: ProviderConfig): OpenAIProvider {
  return new OpenAIProvider(config);
}
