/**
 * EmbeddingService - Generate vector embeddings for semantic search
 *
 * Supports multiple providers:
 * - Voyage AI (recommended by Anthropic)
 * - OpenAI (text-embedding-3-small)
 * - Fallback to no embeddings (text search only)
 *
 * Usage:
 *   const embedding = await embeddingService.embed("Some text to embed");
 *   const embeddings = await embeddingService.embedBatch(["text1", "text2"]);
 */

export type EmbeddingProvider = 'voyage' | 'openai' | 'none';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

class EmbeddingService {
  private provider: EmbeddingProvider;
  private voyageApiKey?: string;
  private openaiApiKey?: string;

  // Model configurations
  private readonly VOYAGE_MODEL = 'voyage-code-2'; // Best for code
  private readonly VOYAGE_DIMENSIONS = 1536;
  private readonly OPENAI_MODEL = 'text-embedding-3-small';
  private readonly OPENAI_DIMENSIONS = 1536;

  constructor() {
    this.voyageApiKey = process.env.VOYAGE_API_KEY;
    this.openaiApiKey = process.env.OPENAI_API_KEY;

    // Auto-detect provider based on available API keys
    if (this.voyageApiKey) {
      this.provider = 'voyage';
      console.log('🧠 [EmbeddingService] Using Voyage AI for embeddings');
    } else if (this.openaiApiKey) {
      this.provider = 'openai';
      console.log('🧠 [EmbeddingService] Using OpenAI for embeddings');
    } else {
      this.provider = 'none';
      console.warn('⚠️  [EmbeddingService] No embedding API key found. Using text search fallback.');
      console.warn('   Set VOYAGE_API_KEY or OPENAI_API_KEY for semantic search.');
    }
  }

  /**
   * Get the current provider
   */
  getProvider(): EmbeddingProvider {
    return this.provider;
  }

  /**
   * Get embedding dimensions for current provider
   */
  getDimensions(): number {
    switch (this.provider) {
      case 'voyage':
        return this.VOYAGE_DIMENSIONS;
      case 'openai':
        return this.OPENAI_DIMENSIONS;
      default:
        return 0;
    }
  }

  /**
   * Check if embeddings are available
   */
  isAvailable(): boolean {
    return this.provider !== 'none';
  }

  /**
   * Generate embedding for a single text
   */
  async embed(text: string): Promise<EmbeddingResult | null> {
    if (!this.isAvailable()) {
      return null;
    }

    const results = await this.embedBatch([text]);
    return results[0] || null;
  }

  /**
   * Generate embeddings for multiple texts (more efficient)
   */
  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    if (!this.isAvailable() || texts.length === 0) {
      return texts.map(() => null);
    }

    // Clean and truncate texts
    const cleanedTexts = texts.map(text => this.prepareText(text));

    try {
      switch (this.provider) {
        case 'voyage':
          return await this.embedWithVoyage(cleanedTexts);
        case 'openai':
          return await this.embedWithOpenAI(cleanedTexts);
        default:
          return texts.map(() => null);
      }
    } catch (error: any) {
      console.error(`❌ [EmbeddingService] Error generating embeddings:`, error.message);
      return texts.map(() => null);
    }
  }

  /**
   * Prepare text for embedding (clean, truncate)
   */
  private prepareText(text: string): string {
    // Remove excessive whitespace
    let cleaned = text.replace(/\s+/g, ' ').trim();

    // Truncate to max tokens (roughly 4 chars per token, max ~8000 tokens)
    const maxChars = 30000;
    if (cleaned.length > maxChars) {
      cleaned = cleaned.substring(0, maxChars) + '...';
    }

    return cleaned;
  }

  /**
   * Generate embeddings using Voyage AI
   */
  private async embedWithVoyage(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.voyageApiKey}`,
      },
      body: JSON.stringify({
        model: this.VOYAGE_MODEL,
        input: texts,
        input_type: 'document', // Use 'query' for search queries
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage API error: ${response.status} - ${error}`);
    }

    const data: any = await response.json();

    return data.data.map((item: any) => ({
      embedding: item.embedding,
      model: this.VOYAGE_MODEL,
      dimensions: this.VOYAGE_DIMENSIONS,
    }));
  }

  /**
   * Generate embeddings using OpenAI
   */
  private async embedWithOpenAI(texts: string[]): Promise<EmbeddingResult[]> {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: this.OPENAI_MODEL,
        input: texts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data: any = await response.json();

    return data.data.map((item: any) => ({
      embedding: item.embedding,
      model: this.OPENAI_MODEL,
      dimensions: this.OPENAI_DIMENSIONS,
    }));
  }

  /**
   * Calculate cosine similarity between two embeddings
   * Useful for local similarity checks without DB
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Embeddings must have the same dimensions');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

// Singleton instance
export const embeddingService = new EmbeddingService();
