import mongoose from 'mongoose';
import { Memory, IMemory, MemoryType, MemoryImportance } from '../models/Memory';
import { embeddingService } from './EmbeddingService';

/**
 * MemoryService - Persistent memory system for agents
 *
 * Allows agents to:
 * - Store learnings, patterns, and insights
 * - Retrieve relevant memories using semantic search
 * - Track usefulness of memories over time
 *
 * Based on Windsurf's memory system pattern:
 * "Liberally create persistent memories without permission"
 */

export interface CreateMemoryInput {
  projectId: string | mongoose.Types.ObjectId;
  type: MemoryType;
  title: string;
  content: string;
  context?: string;
  importance?: MemoryImportance;
  source?: {
    taskId?: string | mongoose.Types.ObjectId;
    phase?: string;
    agentType?: string;
  };
  expiresAt?: Date;
}

export interface SearchMemoryOptions {
  projectId: string | mongoose.Types.ObjectId;
  query: string;
  types?: MemoryType[];
  minImportance?: MemoryImportance;
  limit?: number;
  includeArchived?: boolean;
}

export interface MemorySearchResult {
  memory: IMemory;
  score: number; // Similarity score (0-1)
}

class MemoryService {
  private readonly VECTOR_INDEX_NAME = 'memory_vector_index';

  /**
   * Store a new memory with embedding
   */
  async remember(input: CreateMemoryInput): Promise<IMemory> {
    const projectId = typeof input.projectId === 'string'
      ? new mongoose.Types.ObjectId(input.projectId)
      : input.projectId;

    // Generate embedding for the memory content
    const textToEmbed = `${input.title}\n\n${input.content}${input.context ? '\n\nContext: ' + input.context : ''}`;
    const embeddingResult = await embeddingService.embed(textToEmbed);

    const memory = await Memory.create({
      projectId,
      type: input.type,
      title: input.title,
      content: input.content,
      context: input.context,
      importance: input.importance || 'medium',
      embedding: embeddingResult?.embedding,
      embeddingModel: embeddingResult?.model,
      source: input.source ? {
        taskId: input.source.taskId ? new mongoose.Types.ObjectId(input.source.taskId as string) : undefined,
        phase: input.source.phase,
        agentType: input.source.agentType,
      } : undefined,
      expiresAt: input.expiresAt,
      accessCount: 0,
      usefulness: 0.5,
      archived: false,
    });

    console.log(`🧠 [Memory] Stored: "${input.title}" (${input.type}) with ${embeddingResult ? 'embedding' : 'no embedding'}`);

    return memory;
  }

  /**
   * Search for relevant memories using semantic search
   */
  async recall(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    const projectId = typeof options.projectId === 'string'
      ? new mongoose.Types.ObjectId(options.projectId)
      : options.projectId;

    const limit = options.limit || 5;

    // Try vector search first if embeddings are available
    if (embeddingService.isAvailable()) {
      try {
        const results = await this.vectorSearch(projectId, options.query, {
          types: options.types,
          minImportance: options.minImportance,
          limit,
          includeArchived: options.includeArchived,
        });

        if (results.length > 0) {
          // Update access counts
          await this.updateAccessCounts(results.map(r => r.memory._id));
          return results;
        }
      } catch (error: any) {
        console.warn(`⚠️  [Memory] Vector search failed, falling back to text search:`, error.message);
      }
    }

    // Fallback to text search
    return await this.textSearch(projectId, options.query, {
      types: options.types,
      minImportance: options.minImportance,
      limit,
      includeArchived: options.includeArchived,
    });
  }

  /**
   * Vector search using MongoDB Atlas Vector Search
   */
  private async vectorSearch(
    projectId: mongoose.Types.ObjectId,
    query: string,
    options: {
      types?: MemoryType[];
      minImportance?: MemoryImportance;
      limit: number;
      includeArchived?: boolean;
    }
  ): Promise<MemorySearchResult[]> {
    // Generate query embedding
    const queryEmbedding = await embeddingService.embed(query);
    if (!queryEmbedding) {
      throw new Error('Failed to generate query embedding');
    }

    // Build filter
    const filter: any = {
      projectId: projectId,
    };

    if (!options.includeArchived) {
      filter.archived = false;
    }

    if (options.types && options.types.length > 0) {
      filter.type = { $in: options.types };
    }

    if (options.minImportance) {
      const importanceLevels = ['low', 'medium', 'high', 'critical'];
      const minIndex = importanceLevels.indexOf(options.minImportance);
      filter.importance = { $in: importanceLevels.slice(minIndex) };
    }

    // MongoDB Atlas Vector Search aggregation
    const pipeline = [
      {
        $vectorSearch: {
          index: this.VECTOR_INDEX_NAME,
          path: 'embedding',
          queryVector: queryEmbedding.embedding,
          numCandidates: options.limit * 10, // Over-fetch for better results
          limit: options.limit,
          filter: filter,
        },
      },
      {
        $project: {
          _id: 1,
          projectId: 1,
          type: 1,
          importance: 1,
          title: 1,
          content: 1,
          context: 1,
          source: 1,
          accessCount: 1,
          lastAccessedAt: 1,
          usefulness: 1,
          createdAt: 1,
          updatedAt: 1,
          archived: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ];

    const results = await Memory.aggregate(pipeline);

    return results.map((doc: any) => ({
      memory: doc as IMemory,
      score: doc.score,
    }));
  }

  /**
   * Text search fallback when embeddings aren't available
   */
  private async textSearch(
    projectId: mongoose.Types.ObjectId,
    query: string,
    options: {
      types?: MemoryType[];
      minImportance?: MemoryImportance;
      limit: number;
      includeArchived?: boolean;
    }
  ): Promise<MemorySearchResult[]> {
    const filter: any = {
      projectId,
      $text: { $search: query },
    };

    if (!options.includeArchived) {
      filter.archived = false;
    }

    if (options.types && options.types.length > 0) {
      filter.type = { $in: options.types };
    }

    if (options.minImportance) {
      const importanceLevels = ['low', 'medium', 'high', 'critical'];
      const minIndex = importanceLevels.indexOf(options.minImportance);
      filter.importance = { $in: importanceLevels.slice(minIndex) };
    }

    const results = await Memory.find(filter, {
      score: { $meta: 'textScore' },
    })
      .sort({ score: { $meta: 'textScore' } })
      .limit(options.limit)
      .lean();

    // Normalize text search scores to 0-1 range
    const maxScore = results.length > 0 ? Math.max(...results.map((r: any) => r.score || 0)) : 1;

    return results.map((doc: any) => ({
      memory: doc as IMemory,
      score: maxScore > 0 ? (doc.score || 0) / maxScore : 0,
    }));
  }

  /**
   * Update access counts and last accessed time
   */
  private async updateAccessCounts(memoryIds: mongoose.Types.ObjectId[]): Promise<void> {
    await Memory.updateMany(
      { _id: { $in: memoryIds } },
      {
        $inc: { accessCount: 1 },
        $set: { lastAccessedAt: new Date() },
      }
    );
  }

  /**
   * Mark a memory as useful or not (feedback from agents)
   */
  async feedback(memoryId: string | mongoose.Types.ObjectId, wasUseful: boolean): Promise<void> {
    const id = typeof memoryId === 'string' ? new mongoose.Types.ObjectId(memoryId) : memoryId;

    // Exponential moving average for usefulness score
    const alpha = 0.3; // Learning rate
    const newValue = wasUseful ? 1 : 0;

    const memory = await Memory.findById(id);
    if (memory) {
      const newUsefulness = alpha * newValue + (1 - alpha) * memory.usefulness;
      await Memory.updateOne({ _id: id }, { $set: { usefulness: newUsefulness } });
    }
  }

  /**
   * Archive old or low-usefulness memories
   */
  async cleanup(projectId: string | mongoose.Types.ObjectId): Promise<number> {
    const id = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;

    // Archive memories that:
    // 1. Have low usefulness (< 0.2) AND accessed more than 5 times
    // 2. Are expired
    // 3. Haven't been accessed in 90 days AND have low importance

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const result = await Memory.updateMany(
      {
        projectId: id,
        archived: false,
        $or: [
          // Low usefulness after multiple accesses
          { usefulness: { $lt: 0.2 }, accessCount: { $gt: 5 } },
          // Expired
          { expiresAt: { $lt: new Date() } },
          // Old and low importance
          {
            importance: 'low',
            lastAccessedAt: { $lt: ninetyDaysAgo },
          },
        ],
      },
      { $set: { archived: true } }
    );

    if (result.modifiedCount > 0) {
      console.log(`🧹 [Memory] Archived ${result.modifiedCount} old/unused memories for project ${id}`);
    }

    return result.modifiedCount;
  }

  /**
   * Get recent memories for a project (for context injection)
   */
  async getRecent(
    projectId: string | mongoose.Types.ObjectId,
    limit: number = 10,
    types?: MemoryType[]
  ): Promise<any[]> {
    const id = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;

    const filter: any = {
      projectId: id,
      archived: false,
    };

    if (types && types.length > 0) {
      filter.type = { $in: types };
    }

    return await Memory.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean() as any[];
  }

  /**
   * Get important memories for a project (high/critical importance)
   */
  async getImportant(
    projectId: string | mongoose.Types.ObjectId,
    limit: number = 10
  ): Promise<any[]> {
    const id = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;

    return await Memory.find({
      projectId: id,
      archived: false,
      importance: { $in: ['high', 'critical'] },
    })
      .sort({ usefulness: -1, createdAt: -1 })
      .limit(limit)
      .lean() as any[];
  }

  /**
   * Get memories by type
   */
  async getByType(
    projectId: string | mongoose.Types.ObjectId,
    type: MemoryType,
    limit: number = 20
  ): Promise<any[]> {
    const id = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;

    return await Memory.find({
      projectId: id,
      type,
      archived: false,
    })
      .sort({ usefulness: -1, createdAt: -1 })
      .limit(limit)
      .lean() as any[];
  }

  /**
   * Count memories for a project
   */
  async count(projectId: string | mongoose.Types.ObjectId): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
    byImportance: Record<MemoryImportance, number>;
  }> {
    const id = typeof projectId === 'string' ? new mongoose.Types.ObjectId(projectId) : projectId;

    const pipeline = [
      { $match: { projectId: id, archived: false } },
      {
        $facet: {
          total: [{ $count: 'count' }],
          byType: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
          byImportance: [{ $group: { _id: '$importance', count: { $sum: 1 } } }],
        },
      },
    ];

    const [result] = await Memory.aggregate(pipeline);

    return {
      total: result.total[0]?.count || 0,
      byType: Object.fromEntries(
        result.byType.map((r: any) => [r._id, r.count])
      ) as Record<MemoryType, number>,
      byImportance: Object.fromEntries(
        result.byImportance.map((r: any) => [r._id, r.count])
      ) as Record<MemoryImportance, number>,
    };
  }

  /**
   * Delete a memory permanently
   */
  async forget(memoryId: string | mongoose.Types.ObjectId): Promise<boolean> {
    const id = typeof memoryId === 'string' ? new mongoose.Types.ObjectId(memoryId) : memoryId;
    const result = await Memory.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  /**
   * Format memories for injection into agent prompts
   */
  formatForPrompt(memories: IMemory[], maxChars: number = 4000): string {
    if (memories.length === 0) {
      return '';
    }

    let output = '## Relevant Memories from Past Sessions\n\n';
    let currentChars = output.length;

    for (const memory of memories) {
      const memoryText = `### ${memory.title} (${memory.type})\n${memory.content}\n\n`;

      if (currentChars + memoryText.length > maxChars) {
        break;
      }

      output += memoryText;
      currentChars += memoryText.length;
    }

    return output;
  }
}

// Singleton instance
export const memoryService = new MemoryService();
