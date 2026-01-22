import { MemoryRepository, IMemory, MemoryType, MemoryImportance } from '../database/repositories/MemoryRepository.js';
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
  projectId: string;
  type: MemoryType;
  title: string;
  content: string;
  context?: string;
  importance?: MemoryImportance;
  source?: {
    taskId?: string;
    phase?: string;
    agentType?: string;
  };
  expiresAt?: Date;
}

export interface SearchMemoryOptions {
  projectId: string;
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
  /**
   * Store a new memory with embedding
   */
  async remember(input: CreateMemoryInput): Promise<IMemory> {
    // Generate embedding for the memory content
    const textToEmbed = `${input.title}\n\n${input.content}${input.context ? '\n\nContext: ' + input.context : ''}`;
    const embeddingResult = await embeddingService.embed(textToEmbed);

    const memory = MemoryRepository.create({
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      content: input.content,
      context: input.context,
      importance: input.importance || 'medium',
      embedding: embeddingResult?.embedding,
      embeddingModel: embeddingResult?.model,
      source: input.source ? {
        taskId: input.source.taskId,
        phase: input.source.phase,
        agentType: input.source.agentType,
      } : undefined,
      expiresAt: input.expiresAt,
    });

    console.log(`🧠 [Memory] Stored: "${input.title}" (${input.type}) with ${embeddingResult ? 'embedding' : 'no embedding'}`);

    return memory;
  }

  /**
   * Search for relevant memories using text search
   * Note: Vector search removed as SQLite doesn't support it natively.
   * For vector search, consider integrating with a dedicated vector DB.
   */
  async recall(options: SearchMemoryOptions): Promise<MemorySearchResult[]> {
    const limit = options.limit || 5;

    // Use text search
    const results = await this.textSearch(options.projectId, options.query, {
      types: options.types,
      minImportance: options.minImportance,
      limit,
      includeArchived: options.includeArchived,
    });

    // Update access counts
    for (const result of results) {
      MemoryRepository.incrementAccess(result.memory.id);
    }

    return results;
  }

  /**
   * Text search using SQLite LIKE
   */
  private async textSearch(
    projectId: string,
    query: string,
    options: {
      types?: MemoryType[];
      minImportance?: MemoryImportance;
      limit: number;
      includeArchived?: boolean;
    }
  ): Promise<MemorySearchResult[]> {
    // Get memories matching the search query
    const memories = MemoryRepository.search(projectId, query, options.limit);

    // Filter by type if specified
    let filtered = memories;
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter(m => options.types!.includes(m.type));
    }

    // Filter by importance if specified
    if (options.minImportance) {
      const importanceLevels: MemoryImportance[] = ['low', 'medium', 'high', 'critical'];
      const minIndex = importanceLevels.indexOf(options.minImportance);
      filtered = filtered.filter(m => importanceLevels.indexOf(m.importance) >= minIndex);
    }

    // Filter archived if not included
    if (!options.includeArchived) {
      filtered = filtered.filter(m => !m.archived);
    }

    // Return with normalized scores (simple text match doesn't have scores)
    return filtered.slice(0, options.limit).map((memory, index) => ({
      memory,
      score: 1 - (index * 0.1), // Decreasing score by position
    }));
  }

  /**
   * Mark a memory as useful or not (feedback from agents)
   */
  async feedback(memoryId: string, wasUseful: boolean): Promise<void> {
    const memory = MemoryRepository.findById(memoryId);
    if (memory) {
      // Exponential moving average for usefulness score
      const alpha = 0.3; // Learning rate
      const newValue = wasUseful ? 1 : 0;
      const newUsefulness = alpha * newValue + (1 - alpha) * memory.usefulness;
      MemoryRepository.update(memoryId, { usefulness: newUsefulness });
    }
  }

  /**
   * Archive old or low-usefulness memories
   */
  async cleanup(projectId: string): Promise<number> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    // Get all non-archived memories for the project
    const memories = MemoryRepository.findByProjectId(projectId, { archived: false });

    let archivedCount = 0;

    for (const memory of memories) {
      const shouldArchive =
        // Low usefulness after multiple accesses
        (memory.usefulness < 0.2 && memory.accessCount > 5) ||
        // Expired
        (memory.expiresAt && memory.expiresAt < new Date()) ||
        // Old and low importance
        (memory.importance === 'low' && memory.lastAccessedAt && memory.lastAccessedAt < ninetyDaysAgo);

      if (shouldArchive) {
        MemoryRepository.archive(memory.id);
        archivedCount++;
      }
    }

    if (archivedCount > 0) {
      console.log(`🧹 [Memory] Archived ${archivedCount} old/unused memories for project ${projectId}`);
    }

    return archivedCount;
  }

  /**
   * Get recent memories for a project (for context injection)
   */
  async getRecent(
    projectId: string,
    limit: number = 10,
    types?: MemoryType[]
  ): Promise<IMemory[]> {
    if (types && types.length > 0) {
      // Get memories for each type and combine
      const allMemories: IMemory[] = [];
      for (const type of types) {
        const memories = MemoryRepository.findByProjectId(projectId, {
          type,
          archived: false,
          limit: limit * types.length, // Over-fetch to account for filtering
        });
        allMemories.push(...memories);
      }
      // Sort by createdAt and return top limit
      return allMemories
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit);
    }

    return MemoryRepository.findByProjectId(projectId, {
      archived: false,
      limit,
    });
  }

  /**
   * Get important memories for a project (high/critical importance)
   */
  async getImportant(
    projectId: string,
    limit: number = 10
  ): Promise<IMemory[]> {
    const highMemories = MemoryRepository.findByProjectId(projectId, {
      importance: 'high',
      archived: false,
      limit,
    });

    const criticalMemories = MemoryRepository.findByProjectId(projectId, {
      importance: 'critical',
      archived: false,
      limit,
    });

    // Combine and sort by usefulness
    const combined = [...criticalMemories, ...highMemories];
    return combined
      .sort((a, b) => b.usefulness - a.usefulness)
      .slice(0, limit);
  }

  /**
   * Get memories by type
   */
  async getByType(
    projectId: string,
    type: MemoryType,
    limit: number = 20
  ): Promise<IMemory[]> {
    return MemoryRepository.findByProjectId(projectId, {
      type,
      archived: false,
      limit,
    });
  }

  /**
   * Count memories for a project
   */
  async count(projectId: string): Promise<{
    total: number;
    byType: Record<MemoryType, number>;
    byImportance: Record<MemoryImportance, number>;
  }> {
    const memories = MemoryRepository.findByProjectId(projectId, { archived: false });

    const byType: Record<MemoryType, number> = {
      codebase_pattern: 0,
      error_resolution: 0,
      user_preference: 0,
      architecture_decision: 0,
      api_contract: 0,
      test_pattern: 0,
      dependency_info: 0,
      workflow_learned: 0,
      agent_insight: 0,
    };

    const byImportance: Record<MemoryImportance, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] || 0) + 1;
      byImportance[memory.importance] = (byImportance[memory.importance] || 0) + 1;
    }

    return {
      total: memories.length,
      byType,
      byImportance,
    };
  }

  /**
   * Delete a memory permanently
   */
  async forget(memoryId: string): Promise<boolean> {
    return MemoryRepository.delete(memoryId);
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
