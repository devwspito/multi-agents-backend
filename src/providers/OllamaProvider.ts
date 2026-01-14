/**
 * OllamaProvider - Local LLM Implementation
 *
 * Free local AI provider for development.
 * Implements the AIProvider interface for Ollama's local models.
 *
 * Benefits:
 * - Zero API costs
 * - No internet required
 * - Privacy (data stays local)
 * - Good for development/testing
 */

import {
  AIProvider,
  ProviderConfig,
  Message,
  QueryOptions,
  CompletionResult,
  StreamEvent,
  OLLAMA_MODELS,
  ContentBlock,
  ToolCall
} from './AIProvider';

// Ollama API types
interface OllamaChatResponse {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      function: {
        name: string;
        arguments: Record<string, any>;
      };
    }>;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
}

export class OllamaProvider extends AIProvider {
  readonly name = 'ollama' as const;
  readonly displayName = 'Ollama (Local)';
  readonly models = OLLAMA_MODELS;

  private baseUrl: string;

  constructor(config: ProviderConfig = {}) {
    super({
      defaultModel: 'llama3.1:70b',
      timeout: 300000, // 5 minutes for local models (can be slow)
      ...config
    });

    this.baseUrl = config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  /**
   * Complete a prompt (non-streaming)
   */
  async complete(messages: Message[], options: QueryOptions = {}): Promise<CompletionResult> {
    const startTime = Date.now();
    const model = options.model || this.config.defaultModel || 'llama3.1:70b';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const ollamaMessages = this.convertMessages(messages, options.systemPrompt);

      const response = await this.callOllamaChat(model, ollamaMessages, {
        temperature: options.temperature,
        num_predict: options.maxTokens || modelInfo.maxOutputTokens,
        tools: options.tools ? this.convertTools(options.tools) : undefined
      });

      const latencyMs = Date.now() - startTime;
      this.updateStatus(true, latencyMs);

      const content = response.message.content;

      // Extract tool calls
      const toolCalls: ToolCall[] = [];
      if (response.message.tool_calls) {
        for (let i = 0; i < response.message.tool_calls.length; i++) {
          const tc = response.message.tool_calls[i];
          toolCalls.push({
            id: `ollama_tool_${Date.now()}_${i}`,
            name: tc.function.name,
            arguments: tc.function.arguments
          });
        }
      }

      // Estimate tokens (Ollama provides these in response)
      const inputTokens = response.prompt_eval_count || this.estimateTokens(ollamaMessages);
      const outputTokens = response.eval_count || this.estimateTokens([{ role: 'assistant', content }]);

      return {
        content,
        model,
        provider: 'ollama',
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        cost: 0, // Ollama is free
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        latencyMs
      };
    } catch (error: any) {
      this.updateStatus(false);
      throw new Error(`Ollama API error: ${error.message}`);
    }
  }

  /**
   * Stream a completion
   */
  async *stream(messages: Message[], options: QueryOptions = {}): AsyncGenerator<StreamEvent> {
    const model = options.model || this.config.defaultModel || 'llama3.1:70b';
    const modelInfo = this.getModel(model) || this.models[0];

    try {
      const ollamaMessages = this.convertMessages(messages, options.systemPrompt);

      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: ollamaMessages,
          stream: true,
          options: {
            temperature: options.temperature,
            num_predict: options.maxTokens || modelInfo.maxOutputTokens
          },
          ...(options.tools && { tools: this.convertTools(options.tools) })
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama API returned ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          yield { type: 'done' };
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const chunk: OllamaChatResponse = JSON.parse(line);

            if (chunk.message?.content) {
              yield {
                type: 'text',
                text: chunk.message.content,
                partial: !chunk.done
              };
            }

            if (chunk.message?.tool_calls) {
              for (let i = 0; i < chunk.message.tool_calls.length; i++) {
                const tc = chunk.message.tool_calls[i];
                yield {
                  type: 'tool_call',
                  toolCall: {
                    id: `ollama_tool_${Date.now()}_${i}`,
                    name: tc.function.name,
                    arguments: tc.function.arguments
                  }
                };
              }
            }

            if (chunk.done) {
              yield { type: 'done' };
            }
          } catch {
            // Skip malformed JSON
          }
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
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        this.updateStatus(true);
        return true;
      }

      this.updateStatus(false);
      return false;
    } catch {
      this.updateStatus(false);
      return false;
    }
  }

  /**
   * List available models on local Ollama instance
   */
  async listLocalModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map((m) => m.name) || [];
    } catch {
      return [];
    }
  }

  /**
   * Pull a model from Ollama registry
   */
  async pullModel(modelName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.statusText}`);
    }

    // Wait for pull to complete
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  }

  // ==================== PRIVATE METHODS ====================

  private async callOllamaChat(
    model: string,
    messages: OllamaChatMessage[],
    options: {
      temperature?: number;
      num_predict?: number;
      tools?: any[];
    }
  ): Promise<OllamaChatResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature,
          num_predict: options.num_predict
        },
        ...(options.tools && { tools: options.tools })
      }),
      signal: AbortSignal.timeout(this.config.timeout || 300000)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API error: ${response.status} - ${error}`);
    }

    return response.json() as Promise<OllamaChatResponse>;
  }

  private convertMessages(
    messages: Message[],
    systemPrompt?: string
  ): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [];

    // Add system prompt
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        result.push({
          role: msg.role as OllamaChatMessage['role'],
          content: msg.content,
          ...(msg.toolCalls && {
            tool_calls: msg.toolCalls.map(tc => ({
              function: {
                name: tc.name,
                arguments: tc.arguments
              }
            }))
          })
        });
      } else {
        // Handle content blocks
        let textContent = '';
        const images: string[] = [];

        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'text' && block.text) {
            textContent += block.text;
          } else if (block.type === 'image' && block.image) {
            images.push(block.image.data);
          }
        }

        result.push({
          role: msg.role as OllamaChatMessage['role'],
          content: textContent,
          ...(images.length > 0 && { images })
        });
      }
    }

    return result;
  }

  private convertTools(tools: QueryOptions['tools']): any[] {
    if (!tools) return [];

    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  }

  private estimateTokens(messages: OllamaChatMessage[]): number {
    // Rough estimation: ~4 characters per token
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += msg.content.length;
    }
    return Math.ceil(totalChars / 4);
  }
}

// Export factory function
export function createOllamaProvider(config?: ProviderConfig): OllamaProvider {
  return new OllamaProvider(config);
}
