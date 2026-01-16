/**
 * GranularMemoryService - Core Memory System for Agent Orchestration
 *
 * This is the PRIMARY memory system that enables:
 * 1. Exact resumption - Agent knows exactly where it stopped and what it did
 * 2. Cross-phase knowledge - Later phases benefit from earlier learnings
 * 3. Error avoidance - Don't repeat mistakes from previous runs
 * 4. Pattern replication - Replicate successful approaches
 *
 * Architecture:
 * - Stores memories in MongoDB with full-text search
 * - Each memory has type, content, and rich metadata
 * - Memories are scoped by project, task, phase, and optionally story
 * - Automatic cleanup of old/low-value memories
 *
 * Usage:
 * - WRITE after every significant action (decision, file change, error, completion)
 * - READ at phase/agent start to inject context
 * - CHECKPOINT at granular points for exact resumption
 */

import mongoose from 'mongoose';

// ==================== TYPES ====================

export type GranularMemoryType =
  | 'decision'           // Architectural/design decisions made
  | 'action'             // Significant actions taken (file created, API called)
  | 'progress'           // Progress markers (story started, story completed)
  | 'error'              // Errors encountered and how they were handled
  | 'pattern'            // Patterns discovered in codebase
  | 'convention'         // Conventions to follow
  | 'file_change'        // Files modified/created with summary
  | 'checkpoint'         // Exact resumption points
  | 'learning'           // Learnings for future runs
  | 'context';           // Important context for future agents

export type MemoryScope =
  | 'project'            // Applies to entire project (conventions, patterns)
  | 'task'               // Applies to current task
  | 'phase'              // Applies to specific phase
  | 'epic'               // Applies to specific epic
  | 'story';             // Applies to specific story

export interface GranularMemory {
  _id?: mongoose.Types.ObjectId;
  projectId: mongoose.Types.ObjectId;
  taskId?: mongoose.Types.ObjectId;

  // Scope
  scope: MemoryScope;
  phaseType?: string;    // 'planning', 'tech-lead', 'developer', 'judge', etc.
  epicId?: string;
  storyId?: string;
  agentType?: string;    // Which agent created this memory

  // Content
  type: GranularMemoryType;
  title: string;         // Short summary
  content: string;       // Full content

  // Metadata
  importance: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;    // 0-1, how confident we are this is useful

  // For checkpoints
  checkpoint?: {
    resumeData: any;     // Data needed to resume from this point
    completedActions: string[];  // What was already done
    pendingActions: string[];    // What still needs to be done
  };

  // For file changes
  fileChange?: {
    path: string;
    operation: 'create' | 'modify' | 'delete';
    summary: string;
  };

  // For errors
  error?: {
    message: string;
    solution?: string;
    avoidanceRule?: string;
  };

  // Tracking
  usageCount: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  archived: boolean;
}

// ==================== SCHEMA ====================

const granularMemorySchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, index: true },

  scope: { type: String, enum: ['project', 'task', 'phase', 'epic', 'story'], required: true, index: true },
  phaseType: { type: String, index: true },
  epicId: { type: String, index: true },
  storyId: { type: String, index: true },
  agentType: { type: String, index: true },

  type: {
    type: String,
    enum: ['decision', 'action', 'progress', 'error', 'pattern', 'convention', 'file_change', 'checkpoint', 'learning', 'context'],
    required: true,
    index: true
  },
  title: { type: String, required: true },
  content: { type: String, required: true },

  importance: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
  confidence: { type: Number, default: 0.8, min: 0, max: 1 },

  checkpoint: {
    resumeData: mongoose.Schema.Types.Mixed,
    completedActions: [String],
    pendingActions: [String],
  },

  fileChange: {
    path: String,
    operation: { type: String, enum: ['create', 'modify', 'delete'] },
    summary: String,
  },

  error: {
    message: String,
    solution: String,
    avoidanceRule: String,
  },

  usageCount: { type: Number, default: 0 },
  lastUsedAt: Date,
  expiresAt: Date,
  archived: { type: Boolean, default: false },
}, {
  timestamps: true,
});

// Compound indexes for efficient queries
granularMemorySchema.index({ projectId: 1, scope: 1, type: 1 });
granularMemorySchema.index({ projectId: 1, taskId: 1, phaseType: 1 });
granularMemorySchema.index({ projectId: 1, taskId: 1, storyId: 1 });
granularMemorySchema.index({ projectId: 1, type: 1, importance: 1 });

// Text index for search
granularMemorySchema.index({ title: 'text', content: 'text' });

const GranularMemoryModel = mongoose.models.GranularMemory ||
  mongoose.model('GranularMemory', granularMemorySchema);

// ==================== SERVICE ====================

export class GranularMemoryService {
  private static instance: GranularMemoryService;

  private constructor() {}

  static getInstance(): GranularMemoryService {
    if (!GranularMemoryService.instance) {
      GranularMemoryService.instance = new GranularMemoryService();
    }
    return GranularMemoryService.instance;
  }

  // ==================== WRITE OPERATIONS ====================

  /**
   * Store a memory (generic)
   */
  async store(memory: Omit<GranularMemory, '_id' | 'usageCount' | 'createdAt' | 'updatedAt' | 'archived'>): Promise<GranularMemory> {
    const doc = await GranularMemoryModel.create({
      ...memory,
      usageCount: 0,
      archived: false,
    });

    console.log(`🧠 [Memory] Stored: [${memory.type}] ${memory.title} (scope: ${memory.scope})`);
    return doc.toObject() as GranularMemory;
  }

  /**
   * Store a decision made by an agent
   */
  async storeDecision(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: params.taskId ? new mongoose.Types.ObjectId(params.taskId) : undefined,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'decision',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.9,
    });
  }

  /**
   * Store an action taken by an agent
   */
  async storeAction(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    content: string;
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: params.taskId ? new mongoose.Types.ObjectId(params.taskId) : undefined,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'action',
      title: params.title,
      content: params.content,
      importance: 'medium',
      confidence: 1.0, // Actions are facts
    });
  }

  /**
   * Store a progress marker (story started/completed, etc.)
   */
  async storeProgress(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    status: 'started' | 'in_progress' | 'completed' | 'failed';
    details: string;
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'progress',
      title: `${params.status.toUpperCase()}: ${params.storyId || params.epicId || params.phaseType}`,
      content: params.details,
      importance: params.status === 'completed' ? 'high' : 'medium',
      confidence: 1.0,
    });
  }

  /**
   * Store an error and how it was handled
   */
  async storeError(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    errorMessage: string;
    solution?: string;
    avoidanceRule?: string;
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: params.taskId ? new mongoose.Types.ObjectId(params.taskId) : undefined,
      scope: 'task', // Errors are task-scoped to avoid in future runs
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'error',
      title: `ERROR: ${params.errorMessage.substring(0, 100)}`,
      content: params.errorMessage,
      importance: 'high',
      confidence: 0.95,
      error: {
        message: params.errorMessage,
        solution: params.solution,
        avoidanceRule: params.avoidanceRule,
      },
    });
  }

  /**
   * Store a file change
   */
  async storeFileChange(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    filePath: string;
    operation: 'create' | 'modify' | 'delete';
    summary: string;
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      scope: params.storyId ? 'story' : 'epic',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'file_change',
      title: `${params.operation.toUpperCase()}: ${params.filePath}`,
      content: params.summary,
      importance: 'medium',
      confidence: 1.0,
      fileChange: {
        path: params.filePath,
        operation: params.operation,
        summary: params.summary,
      },
    });
  }

  /**
   * Store a checkpoint for exact resumption
   */
  async storeCheckpoint(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    resumeData: any;
    completedActions: string[];
    pendingActions: string[];
  }): Promise<GranularMemory> {
    // Upsert to replace previous checkpoint at same scope
    const filter = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      phaseType: params.phaseType,
      type: 'checkpoint',
      ...(params.storyId && { storyId: params.storyId }),
      ...(params.epicId && !params.storyId && { epicId: params.epicId }),
    };

    const update = {
      $set: {
        scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
        epicId: params.epicId,
        storyId: params.storyId,
        agentType: params.agentType,
        title: params.title,
        content: `Checkpoint: ${params.completedActions.length} completed, ${params.pendingActions.length} pending`,
        importance: 'critical' as const,
        confidence: 1.0,
        checkpoint: {
          resumeData: params.resumeData,
          completedActions: params.completedActions,
          pendingActions: params.pendingActions,
        },
        updatedAt: new Date(),
        archived: false,
      },
      $setOnInsert: {
        usageCount: 0,
        createdAt: new Date(),
      },
    };

    const doc = await GranularMemoryModel.findOneAndUpdate(filter, update, { upsert: true, new: true });

    console.log(`📍 [Checkpoint] Saved: ${params.phaseType}${params.epicId ? `/${params.epicId}` : ''}${params.storyId ? `/${params.storyId}` : ''}`);
    console.log(`   Completed: ${params.completedActions.length}, Pending: ${params.pendingActions.length}`);

    return doc.toObject() as GranularMemory;
  }

  /**
   * Store a pattern discovered in codebase
   */
  async storePattern(params: {
    projectId: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      scope: 'project', // Patterns are project-wide
      type: 'pattern',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.85,
    });
  }

  /**
   * Store a convention to follow
   */
  async storeConvention(params: {
    projectId: string;
    title: string;
    content: string;
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      scope: 'project',
      type: 'convention',
      title: params.title,
      content: params.content,
      importance: 'high',
      confidence: 0.95,
    });
  }

  /**
   * Store a learning for future runs
   */
  async storeLearning(params: {
    projectId: string;
    taskId?: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<GranularMemory> {
    return this.store({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: params.taskId ? new mongoose.Types.ObjectId(params.taskId) : undefined,
      scope: params.taskId ? 'task' : 'project',
      type: 'learning',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.8,
    });
  }

  // ==================== READ OPERATIONS ====================

  /**
   * Get checkpoint for exact resumption
   */
  async getCheckpoint(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
  }): Promise<GranularMemory | null> {
    const filter: any = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      phaseType: params.phaseType,
      type: 'checkpoint',
      archived: false,
    };

    if (params.storyId) {
      filter.storyId = params.storyId;
    } else if (params.epicId) {
      filter.epicId = params.epicId;
      filter.storyId = { $exists: false };
    }

    const checkpoint = await GranularMemoryModel.findOne(filter).sort({ updatedAt: -1 }).lean();

    if (checkpoint) {
      console.log(`📍 [Checkpoint] Found: ${params.phaseType}${params.epicId ? `/${params.epicId}` : ''}${params.storyId ? `/${params.storyId}` : ''}`);
    }

    return checkpoint as GranularMemory | null;
  }

  /**
   * Get all memories for a phase (for context injection)
   */
  async getPhaseMemories(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const filter: any = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      archived: false,
      $or: [
        { scope: 'project' }, // Always include project-wide memories
        { taskId: new mongoose.Types.ObjectId(params.taskId) }, // Include task memories
      ],
    };

    // Include phase-specific and higher importance
    if (params.phaseType) {
      filter.$or.push({ phaseType: params.phaseType });
    }

    if (params.epicId) {
      filter.$or.push({ epicId: params.epicId });
    }

    const memories = await GranularMemoryModel.find(filter)
      .sort({ importance: -1, updatedAt: -1 })
      .limit(params.limit || 50)
      .lean();

    // Update usage count
    if (memories.length > 0) {
      await GranularMemoryModel.updateMany(
        { _id: { $in: memories.map(m => m._id) } },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
      );
    }

    return memories as unknown as GranularMemory[];
  }

  /**
   * Get completed stories for an epic (to avoid re-doing work)
   */
  async getCompletedStories(params: {
    projectId: string;
    taskId: string;
    epicId: string;
  }): Promise<string[]> {
    const completedProgress = await GranularMemoryModel.find({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      epicId: params.epicId,
      type: 'progress',
      title: { $regex: /^COMPLETED:/ },
      archived: false,
    }).lean();

    return completedProgress.map((m: any) => m.storyId).filter(Boolean);
  }

  /**
   * Get errors to avoid
   */
  async getErrorsToAvoid(params: {
    projectId: string;
    taskId?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const filter: any = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      type: 'error',
      archived: false,
    };

    if (params.taskId) {
      filter.$or = [
        { taskId: new mongoose.Types.ObjectId(params.taskId) },
        { scope: 'project' },
      ];
    }

    const results = await GranularMemoryModel.find(filter)
      .sort({ importance: -1, createdAt: -1 })
      .limit(params.limit || 10)
      .lean();
    return results as unknown as GranularMemory[];
  }

  /**
   * Get patterns and conventions
   */
  async getPatternsAndConventions(params: {
    projectId: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const results = await GranularMemoryModel.find({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      type: { $in: ['pattern', 'convention'] },
      archived: false,
    })
      .sort({ importance: -1, confidence: -1 })
      .limit(params.limit || 20)
      .lean();
    return results as unknown as GranularMemory[];
  }

  /**
   * Get file changes for a story (to know what was already modified)
   */
  async getFileChanges(params: {
    projectId: string;
    taskId: string;
    epicId?: string;
    storyId?: string;
  }): Promise<GranularMemory[]> {
    const filter: any = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId),
      type: 'file_change',
      archived: false,
    };

    if (params.storyId) {
      filter.storyId = params.storyId;
    } else if (params.epicId) {
      filter.epicId = params.epicId;
    }

    const results = await GranularMemoryModel.find(filter)
      .sort({ createdAt: -1 })
      .lean();
    return results as unknown as GranularMemory[];
  }

  /**
   * 🔥 STRICT TASK CACHE: Get cache entries ONLY for this specific task
   *
   * Unlike getPhaseMemories which includes project-wide memories,
   * this method is STRICT - it only returns memories that match the EXACT taskId.
   *
   * Use this for caches that should NOT be shared across tasks:
   * - CodebaseDiscovery (code may have changed between tasks)
   * - ProjectRadiography (same reason)
   * - Any cache that depends on current code state
   */
  async getTaskCache(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    cacheTitle: string;
  }): Promise<GranularMemory | null> {
    const result = await GranularMemoryModel.findOne({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId), // 🔥 STRICT: Must match EXACT taskId
      phaseType: params.phaseType,
      type: 'context',
      title: params.cacheTitle,
      archived: false,
    }).lean() as any;

    if (result && result._id) {
      // Update usage stats
      await GranularMemoryModel.updateOne(
        { _id: result._id },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
      );
    }

    return result as GranularMemory | null;
  }

  /**
   * 🔥 STRICT TASK CACHE: Get multiple cache entries for this specific task
   */
  async getTaskCaches(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    cacheTitlePrefix?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const filter: any = {
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: new mongoose.Types.ObjectId(params.taskId), // 🔥 STRICT: Must match EXACT taskId
      phaseType: params.phaseType,
      type: 'context',
      archived: false,
    };

    if (params.cacheTitlePrefix) {
      filter.title = { $regex: new RegExp(`^${params.cacheTitlePrefix}`) };
    }

    const results = await GranularMemoryModel.find(filter)
      .sort({ updatedAt: -1 })
      .limit(params.limit || 10)
      .lean();

    if (results.length > 0) {
      await GranularMemoryModel.updateMany(
        { _id: { $in: results.map(r => r._id) } },
        { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
      );
    }

    return results as unknown as GranularMemory[];
  }

  // ==================== FORMAT FOR PROMPTS ====================

  /**
   * Format memories for injection into agent prompts
   */
  formatForPrompt(memories: GranularMemory[], title: string = 'AGENT MEMORY'): string {
    if (memories.length === 0) return '';

    const lines: string[] = [];
    lines.push(`\n${'='.repeat(60)}`);
    lines.push(`🧠 ${title}`);
    lines.push(`${'='.repeat(60)}`);

    // Group by type
    const grouped: Record<string, GranularMemory[]> = {};
    for (const mem of memories) {
      if (!grouped[mem.type]) grouped[mem.type] = [];
      grouped[mem.type].push(mem);
    }

    const typeIcons: Record<GranularMemoryType, string> = {
      decision: '⚖️',
      action: '🎯',
      progress: '📊',
      error: '🚫',
      pattern: '🔄',
      convention: '📏',
      file_change: '📝',
      checkpoint: '📍',
      learning: '💡',
      context: 'ℹ️',
    };

    const typePriority: GranularMemoryType[] = [
      'error', 'checkpoint', 'progress', 'decision', 'file_change',
      'convention', 'pattern', 'learning', 'action', 'context'
    ];

    for (const type of typePriority) {
      const entries = grouped[type];
      if (!entries || entries.length === 0) continue;

      const icon = typeIcons[type] || '📝';
      lines.push(`\n${icon} ${type.toUpperCase().replace('_', ' ')}:`);

      for (const entry of entries.slice(0, 5)) {
        lines.push(`   • ${entry.title}`);
        if (entry.content.length < 200) {
          lines.push(`     ${entry.content}`);
        }
        if (entry.error?.avoidanceRule) {
          lines.push(`     ⚠️ AVOID: ${entry.error.avoidanceRule}`);
        }
        if (entry.checkpoint?.completedActions?.length) {
          lines.push(`     ✅ Done: ${entry.checkpoint.completedActions.slice(-3).join(', ')}`);
        }
      }
    }

    lines.push(`${'='.repeat(60)}\n`);
    return lines.join('\n');
  }

  // ==================== CLEANUP ====================

  /**
   * Mark checkpoint as consumed (after successful resume)
   */
  async consumeCheckpoint(checkpointId: mongoose.Types.ObjectId): Promise<void> {
    await GranularMemoryModel.updateOne(
      { _id: checkpointId },
      { $set: { archived: true, updatedAt: new Date() } }
    );
    console.log(`📍 [Checkpoint] Consumed: ${checkpointId}`);
  }

  /**
   * Archive old memories
   */
  async cleanup(projectId: string, olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await GranularMemoryModel.updateMany(
      {
        projectId: new mongoose.Types.ObjectId(projectId),
        archived: false,
        importance: { $in: ['low', 'medium'] },
        updatedAt: { $lt: cutoffDate },
        type: { $nin: ['convention', 'pattern'] }, // Keep conventions and patterns
      },
      { $set: { archived: true } }
    );

    if (result.modifiedCount > 0) {
      console.log(`🧹 [Memory] Archived ${result.modifiedCount} old memories for project ${projectId}`);
    }

    return result.modifiedCount;
  }

  /**
   * Delete all memories for a task (cleanup after task completes successfully)
   */
  async deleteTaskMemories(taskId: string, keepProjectLevel: boolean = true): Promise<number> {
    const filter: any = {
      taskId: new mongoose.Types.ObjectId(taskId),
    };

    if (keepProjectLevel) {
      filter.scope = { $ne: 'project' };
    }

    const result = await GranularMemoryModel.deleteMany(filter);
    console.log(`🗑️ [Memory] Deleted ${result.deletedCount} memories for task ${taskId}`);
    return result.deletedCount;
  }
}

// Export singleton instance
export const granularMemoryService = GranularMemoryService.getInstance();
