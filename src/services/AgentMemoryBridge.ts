/**
 * AgentMemoryBridge - Shared Memory System Across All Agents
 *
 * THIS IS A KEY DIFFERENTIATOR vs Claude Code.
 *
 * Provides persistent shared memory that ALL agents can access:
 * - Cross-phase knowledge transfer
 * - Learned patterns and decisions
 * - Error patterns to avoid
 * - Successful approaches to replicate
 * - Project-specific conventions
 *
 * This makes later agents benefit from earlier agent discoveries.
 */

import * as fs from 'fs';
import * as path from 'path';

// ==================== TYPES ====================

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  content: string;
  metadata: {
    phase: string;
    taskId?: string;
    timestamp: number;
    confidence: number;
    usageCount: number;
    lastUsed?: number;
    feedback?: 'positive' | 'negative' | 'neutral';
  };
  tags: string[];
  relatedEntries?: string[];
}

export type MemoryType =
  | 'pattern'          // Code patterns discovered
  | 'decision'         // Architectural/design decisions
  | 'error'            // Error patterns to avoid
  | 'success'          // Successful approaches
  | 'convention'       // Project conventions
  | 'dependency'       // Dependency information
  | 'test'             // Testing insights
  | 'security'         // Security considerations
  | 'performance'      // Performance insights
  | 'context';         // General context

export interface MemoryQuery {
  types?: MemoryType[];
  tags?: string[];
  phase?: string;
  minConfidence?: number;
  limit?: number;
  searchText?: string;
}

export interface MemoryStats {
  totalEntries: number;
  byType: Record<MemoryType, number>;
  byPhase: Record<string, number>;
  avgConfidence: number;
  mostUsedTags: string[];
}

// ==================== IMPLEMENTATION ====================

export class AgentMemoryBridge {
  private static instance: AgentMemoryBridge;
  private memories: Map<string, MemoryEntry> = new Map();
  private tagIndex: Map<string, Set<string>> = new Map();
  private typeIndex: Map<MemoryType, Set<string>> = new Map();
  private persistPath: string | null = null;
  private idCounter: number = 0;

  private constructor() {}

  static getInstance(): AgentMemoryBridge {
    if (!AgentMemoryBridge.instance) {
      AgentMemoryBridge.instance = new AgentMemoryBridge();
    }
    return AgentMemoryBridge.instance;
  }

  /**
   * Initialize with persistence path
   */
  async initialize(workspacePath?: string): Promise<void> {
    if (workspacePath) {
      this.persistPath = path.join(workspacePath, '.agent-memory.json');
      await this.loadFromDisk();
    }
  }

  /**
   * Store a new memory entry
   */
  store(entry: Omit<MemoryEntry, 'id'>): string {
    const id = `mem_${Date.now()}_${++this.idCounter}`;
    const fullEntry: MemoryEntry = {
      ...entry,
      id,
      metadata: {
        ...entry.metadata,
        usageCount: 0
      }
    };

    this.memories.set(id, fullEntry);
    this.indexEntry(fullEntry);
    this.persistAsync();

    return id;
  }

  /**
   * Quick store helpers
   */
  rememberPattern(pattern: string, phase: string, tags: string[] = [], confidence: number = 0.8): string {
    return this.store({
      type: 'pattern',
      content: pattern,
      metadata: { phase, timestamp: Date.now(), confidence, usageCount: 0 },
      tags: ['pattern', ...tags]
    });
  }

  rememberDecision(decision: string, phase: string, tags: string[] = [], confidence: number = 0.9): string {
    return this.store({
      type: 'decision',
      content: decision,
      metadata: { phase, timestamp: Date.now(), confidence, usageCount: 0 },
      tags: ['decision', ...tags]
    });
  }

  rememberError(error: string, phase: string, tags: string[] = [], confidence: number = 0.95): string {
    return this.store({
      type: 'error',
      content: error,
      metadata: { phase, timestamp: Date.now(), confidence, usageCount: 0 },
      tags: ['error', 'avoid', ...tags]
    });
  }

  rememberSuccess(approach: string, phase: string, tags: string[] = [], confidence: number = 0.85): string {
    return this.store({
      type: 'success',
      content: approach,
      metadata: { phase, timestamp: Date.now(), confidence, usageCount: 0 },
      tags: ['success', 'replicate', ...tags]
    });
  }

  rememberConvention(convention: string, phase: string, tags: string[] = [], confidence: number = 0.95): string {
    return this.store({
      type: 'convention',
      content: convention,
      metadata: { phase, timestamp: Date.now(), confidence, usageCount: 0 },
      tags: ['convention', 'follow', ...tags]
    });
  }

  /**
   * Query memories
   */
  query(queryParams: MemoryQuery): MemoryEntry[] {
    let results: MemoryEntry[] = [];

    // Start with type filter if provided
    if (queryParams.types && queryParams.types.length > 0) {
      const matchingIds = new Set<string>();
      for (const type of queryParams.types) {
        const typeIds = this.typeIndex.get(type);
        if (typeIds) {
          for (const id of typeIds) {
            matchingIds.add(id);
          }
        }
      }
      results = Array.from(matchingIds)
        .map(id => this.memories.get(id)!)
        .filter(Boolean);
    } else {
      results = Array.from(this.memories.values());
    }

    // Filter by tags
    if (queryParams.tags && queryParams.tags.length > 0) {
      results = results.filter(entry =>
        queryParams.tags!.some(tag => entry.tags.includes(tag))
      );
    }

    // Filter by phase
    if (queryParams.phase) {
      results = results.filter(entry =>
        entry.metadata.phase === queryParams.phase
      );
    }

    // Filter by confidence
    if (queryParams.minConfidence) {
      results = results.filter(entry =>
        entry.metadata.confidence >= queryParams.minConfidence!
      );
    }

    // Search text
    if (queryParams.searchText) {
      const searchLower = queryParams.searchText.toLowerCase();
      results = results.filter(entry =>
        entry.content.toLowerCase().includes(searchLower) ||
        entry.tags.some(tag => tag.toLowerCase().includes(searchLower))
      );
    }

    // Sort by confidence and recency
    results.sort((a, b) => {
      const scoreA = a.metadata.confidence * 0.6 +
                    (a.metadata.usageCount / 10) * 0.2 +
                    (a.metadata.timestamp / Date.now()) * 0.2;
      const scoreB = b.metadata.confidence * 0.6 +
                    (b.metadata.usageCount / 10) * 0.2 +
                    (b.metadata.timestamp / Date.now()) * 0.2;
      return scoreB - scoreA;
    });

    // Apply limit
    if (queryParams.limit) {
      results = results.slice(0, queryParams.limit);
    }

    // Update usage count
    for (const entry of results) {
      entry.metadata.usageCount++;
      entry.metadata.lastUsed = Date.now();
    }

    return results;
  }

  /**
   * Recall memories for a specific phase
   */
  recallForPhase(phase: string, limit: number = 10): MemoryEntry[] {
    // Get relevant memories for this phase
    const phaseRelevance: Record<string, MemoryType[]> = {
      'problem-analyst': ['pattern', 'context', 'error'],
      'product-manager': ['decision', 'convention', 'context'],
      'project-manager': ['dependency', 'decision'],
      'tech-lead': ['pattern', 'decision', 'security', 'performance'],
      'developer': ['pattern', 'convention', 'error', 'success', 'test'],
      'judge': ['pattern', 'security', 'error', 'convention'],
      'qa-engineer': ['test', 'error', 'pattern'],
      'fixer': ['error', 'success', 'pattern'],
      'auto-merge': ['convention', 'decision']
    };

    const relevantTypes = phaseRelevance[phase] || ['pattern', 'decision', 'error'];

    return this.query({
      types: relevantTypes,
      limit,
      minConfidence: 0.5
    });
  }

  /**
   * Recall all errors to avoid
   */
  recallErrorsToAvoid(limit: number = 5): MemoryEntry[] {
    return this.query({
      types: ['error'],
      minConfidence: 0.7,
      limit
    });
  }

  /**
   * Recall successful approaches
   */
  recallSuccessfulApproaches(tags: string[], limit: number = 5): MemoryEntry[] {
    return this.query({
      types: ['success'],
      tags,
      minConfidence: 0.7,
      limit
    });
  }

  /**
   * Recall project conventions
   */
  recallConventions(limit: number = 10): MemoryEntry[] {
    return this.query({
      types: ['convention'],
      minConfidence: 0.8,
      limit
    });
  }

  /**
   * Provide feedback on a memory
   */
  provideFeedback(id: string, feedback: 'positive' | 'negative' | 'neutral'): void {
    const entry = this.memories.get(id);
    if (entry) {
      entry.metadata.feedback = feedback;

      // Adjust confidence based on feedback
      if (feedback === 'positive') {
        entry.metadata.confidence = Math.min(1, entry.metadata.confidence + 0.05);
      } else if (feedback === 'negative') {
        entry.metadata.confidence = Math.max(0, entry.metadata.confidence - 0.1);
      }

      this.persistAsync();
    }
  }

  /**
   * Get memory by ID
   */
  get(id: string): MemoryEntry | undefined {
    return this.memories.get(id);
  }

  /**
   * Delete a memory
   */
  delete(id: string): boolean {
    const entry = this.memories.get(id);
    if (!entry) return false;

    // Remove from indexes
    for (const tag of entry.tags) {
      this.tagIndex.get(tag)?.delete(id);
    }
    this.typeIndex.get(entry.type)?.delete(id);

    this.memories.delete(id);
    this.persistAsync();

    return true;
  }

  /**
   * Get statistics
   */
  getStats(): MemoryStats {
    const byType: Record<string, number> = {};
    const byPhase: Record<string, number> = {};
    const tagCounts: Map<string, number> = new Map();
    let totalConfidence = 0;

    for (const entry of this.memories.values()) {
      // By type
      byType[entry.type] = (byType[entry.type] || 0) + 1;

      // By phase
      byPhase[entry.metadata.phase] = (byPhase[entry.metadata.phase] || 0) + 1;

      // Confidence
      totalConfidence += entry.metadata.confidence;

      // Tags
      for (const tag of entry.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    // Most used tags
    const mostUsedTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    return {
      totalEntries: this.memories.size,
      byType: byType as Record<MemoryType, number>,
      byPhase,
      avgConfidence: this.memories.size > 0 ? totalConfidence / this.memories.size : 0,
      mostUsedTags
    };
  }

  /**
   * Format memories for prompt injection
   */
  formatForPrompt(memories: MemoryEntry[], title: string = 'SHARED AGENT MEMORY'): string {
    if (memories.length === 0) return '';

    const lines: string[] = [];
    lines.push(`\n📚 ${title}:`);
    lines.push('─'.repeat(50));

    const grouped: Record<string, MemoryEntry[]> = {};
    for (const mem of memories) {
      if (!grouped[mem.type]) grouped[mem.type] = [];
      grouped[mem.type].push(mem);
    }

    const typeIcons: Record<MemoryType, string> = {
      pattern: '🔄',
      decision: '⚖️',
      error: '🚫',
      success: '✅',
      convention: '📏',
      dependency: '🔗',
      test: '🧪',
      security: '🔒',
      performance: '⚡',
      context: 'ℹ️'
    };

    for (const [type, entries] of Object.entries(grouped)) {
      const icon = typeIcons[type as MemoryType] || '📝';
      lines.push(`\n${icon} ${type.toUpperCase()}:`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`   • ${entry.content}`);
        if (entry.tags.length > 0) {
          lines.push(`     Tags: ${entry.tags.slice(0, 3).join(', ')}`);
        }
      }
    }

    lines.push('─'.repeat(50));
    lines.push('');

    return lines.join('\n');
  }

  /**
   * Clear all memories
   */
  clear(): void {
    this.memories.clear();
    this.tagIndex.clear();
    this.typeIndex.clear();
    this.persistAsync();
  }

  // ==================== PRIVATE METHODS ====================

  private indexEntry(entry: MemoryEntry): void {
    // Index by tags
    for (const tag of entry.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set());
      }
      this.tagIndex.get(tag)!.add(entry.id);
    }

    // Index by type
    if (!this.typeIndex.has(entry.type)) {
      this.typeIndex.set(entry.type, new Set());
    }
    this.typeIndex.get(entry.type)!.add(entry.id);
  }

  private async loadFromDisk(): Promise<void> {
    if (!this.persistPath) return;

    try {
      if (fs.existsSync(this.persistPath)) {
        const data = fs.readFileSync(this.persistPath, 'utf-8');
        const parsed = JSON.parse(data);

        for (const entry of parsed.memories || []) {
          this.memories.set(entry.id, entry);
          this.indexEntry(entry);
        }

        this.idCounter = parsed.idCounter || 0;
      }
    } catch (error) {
      console.warn('[AgentMemoryBridge] Failed to load from disk:', error);
    }
  }

  private persistAsync(): void {
    if (!this.persistPath) return;

    // Debounce writes
    setImmediate(() => {
      try {
        const data = {
          memories: Array.from(this.memories.values()),
          idCounter: this.idCounter,
          lastSaved: Date.now()
        };
        fs.writeFileSync(this.persistPath!, JSON.stringify(data, null, 2));
      } catch (error) {
        console.warn('[AgentMemoryBridge] Failed to persist:', error);
      }
    });
  }
}

// Export singleton getter
export function getAgentMemoryBridge(): AgentMemoryBridge {
  return AgentMemoryBridge.getInstance();
}
