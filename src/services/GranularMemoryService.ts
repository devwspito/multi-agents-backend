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
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

  // ==================== LOCAL FILE STORAGE ====================

  /**
   * Get workspace path for a task
   */
  private getWorkspacePath(taskId: string): string {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    return path.join(workspaceDir, `task-${taskId}`);
  }

  /**
   * Get memory directory for a task
   * 🔥 IMPORTANT: Saves OUTSIDE client repos to avoid polluting their codebase
   * Location: {workspacePath}/.agent-memory/granular/ (not inside cloned repos)
   */
  private getMemoryDir(taskId: string): string | null {
    const taskDir = this.getWorkspacePath(taskId);
    if (!fs.existsSync(taskDir)) return null;

    // 🔥 Save in workspace root, NOT inside client repos
    return path.join(taskDir, '.agent-memory', 'granular');
  }

  /**
   * Ensure memory directory exists
   */
  private ensureMemoryDir(taskId: string): string | null {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir) return null;

    try {
      if (!fs.existsSync(memDir)) {
        fs.mkdirSync(memDir, { recursive: true });
        console.log(`📁 [GranularMemory] Created local memory dir: ${memDir}`);
      }
      return memDir;
    } catch (error) {
      console.warn(`⚠️ [GranularMemory] Failed to create memory dir: ${error}`);
      return null;
    }
  }

  /**
   * 🔥 TRIPLE REDUNDANCY: Save memory to local file
   *
   * Local storage structure:
   * .granular-memory/
   *   - memories.jsonl (append-only log of ALL memories)
   *   - checkpoints/
   *     - {phaseType}-{epicId}-{storyId}.json (latest checkpoint per scope)
   *   - by-type/
   *     - decisions.jsonl
   *     - actions.jsonl
   *     - progress.jsonl
   *     - errors.jsonl
   *     - etc.
   */
  private async saveToLocal(memory: GranularMemory, taskId: string): Promise<void> {
    if (!taskId) return;

    const memDir = this.ensureMemoryDir(taskId);
    if (!memDir) {
      // No local workspace yet - that's OK for early phases
      return;
    }

    try {
      // 1️⃣ Append to main log (memories.jsonl)
      const mainLogPath = path.join(memDir, 'memories.jsonl');
      const logEntry = JSON.stringify({
        ...memory,
        _localSavedAt: new Date().toISOString(),
      }) + '\n';
      fs.appendFileSync(mainLogPath, logEntry);

      // 2️⃣ Save by type for easier querying
      const byTypeDir = path.join(memDir, 'by-type');
      if (!fs.existsSync(byTypeDir)) {
        fs.mkdirSync(byTypeDir, { recursive: true });
      }
      const typeLogPath = path.join(byTypeDir, `${memory.type}s.jsonl`);
      fs.appendFileSync(typeLogPath, logEntry);

      // 3️⃣ For checkpoints, also save latest as JSON for quick access
      if (memory.type === 'checkpoint') {
        const checkpointDir = path.join(memDir, 'checkpoints');
        if (!fs.existsSync(checkpointDir)) {
          fs.mkdirSync(checkpointDir, { recursive: true });
        }
        const checkpointName = [
          memory.phaseType || 'unknown',
          memory.epicId || '',
          memory.storyId || '',
        ].filter(Boolean).join('-');
        const checkpointPath = path.join(checkpointDir, `${checkpointName}.json`);
        fs.writeFileSync(checkpointPath, JSON.stringify(memory, null, 2));
        console.log(`💾 [GranularMemory] Saved checkpoint locally: ${checkpointPath}`);
      }

      // 4️⃣ Update summary index
      await this.updateLocalIndex(memDir, memory);

    } catch (error) {
      console.warn(`⚠️ [GranularMemory] Failed to save locally: ${error}`);
      // Don't throw - Local is primary, but we continue even if local fails
    }
  }

  /**
   * Update local index file with summary
   */
  private async updateLocalIndex(memDir: string, memory: GranularMemory): Promise<void> {
    const indexPath = path.join(memDir, 'index.json');
    let index: any = { lastUpdated: null, counts: {}, latestByType: {} };

    try {
      if (fs.existsSync(indexPath)) {
        index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      }
    } catch {
      // Start fresh
    }

    index.lastUpdated = new Date().toISOString();
    index.counts[memory.type] = (index.counts[memory.type] || 0) + 1;
    index.latestByType[memory.type] = {
      title: memory.title,
      timestamp: new Date().toISOString(),
    };

    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }

  /**
   * 🔥 Load memories from local files (fallback when MongoDB unavailable)
   */
  async loadFromLocal(taskId: string, type?: GranularMemoryType): Promise<GranularMemory[]> {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir || !fs.existsSync(memDir)) return [];

    const memories: GranularMemory[] = [];

    try {
      let logPath: string;
      if (type) {
        logPath = path.join(memDir, 'by-type', `${type}s.jsonl`);
      } else {
        logPath = path.join(memDir, 'memories.jsonl');
      }

      if (!fs.existsSync(logPath)) return [];

      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const memory = JSON.parse(line) as GranularMemory;
          memories.push(memory);
        } catch {
          // Skip malformed lines
        }
      }

      console.log(`📂 [GranularMemory] Loaded ${memories.length} memories from local (type: ${type || 'all'})`);
    } catch (error) {
      console.warn(`⚠️ [GranularMemory] Failed to load from local: ${error}`);
    }

    return memories;
  }

  /**
   * 🔥 Load latest checkpoint from local files
   */
  async loadCheckpointFromLocal(taskId: string, phaseType: string, epicId?: string, storyId?: string): Promise<GranularMemory | null> {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir || !fs.existsSync(memDir)) return null;

    try {
      const checkpointDir = path.join(memDir, 'checkpoints');
      if (!fs.existsSync(checkpointDir)) return null;

      const checkpointName = [phaseType, epicId || '', storyId || ''].filter(Boolean).join('-');
      const checkpointPath = path.join(checkpointDir, `${checkpointName}.json`);

      if (!fs.existsSync(checkpointPath)) return null;

      const content = fs.readFileSync(checkpointPath, 'utf8');
      const checkpoint = JSON.parse(content) as GranularMemory;
      console.log(`📂 [GranularMemory] Loaded checkpoint from local: ${checkpointPath}`);
      return checkpoint;
    } catch (error) {
      console.warn(`⚠️ [GranularMemory] Failed to load checkpoint from local: ${error}`);
      return null;
    }
  }

  /**
   * 🔥 Sync ALL local memories to MongoDB (for disaster recovery)
   */
  async syncLocalToMongoDB(taskId: string): Promise<{ synced: number; errors: number }> {
    const memories = await this.loadFromLocal(taskId);
    let synced = 0;
    let errors = 0;

    for (const memory of memories) {
      try {
        // Check if already exists in MongoDB
        const existing = await GranularMemoryModel.findOne({
          taskId: memory.taskId,
          type: memory.type,
          title: memory.title,
          createdAt: memory.createdAt,
        });

        if (!existing) {
          await GranularMemoryModel.create(memory);
          synced++;
        }
      } catch (error) {
        errors++;
      }
    }

    console.log(`🔄 [GranularMemory] Synced local to MongoDB: ${synced} new, ${errors} errors`);
    return { synced, errors };
  }

  /**
   * 🔥 Sync ALL local memories from multiple tasks to MongoDB
   */
  async syncAllLocalToMongoDB(): Promise<{ tasks: number; synced: number; errors: number }> {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    let totalSynced = 0;
    let totalErrors = 0;
    let taskCount = 0;

    if (!fs.existsSync(workspaceDir)) {
      return { tasks: 0, synced: 0, errors: 0 };
    }

    const entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('task-')) {
        const taskId = entry.name.replace('task-', '');
        const result = await this.syncLocalToMongoDB(taskId);
        totalSynced += result.synced;
        totalErrors += result.errors;
        taskCount++;
      }
    }

    console.log(`🔄 [GranularMemory] Synced ${taskCount} tasks: ${totalSynced} memories, ${totalErrors} errors`);
    return { tasks: taskCount, synced: totalSynced, errors: totalErrors };
  }

  // ==================== OBJECTID VALIDATION HELPERS ====================

  /**
   * Check if a string is a valid MongoDB ObjectId (24-character hex)
   */
  private isValidObjectId(id: string | undefined | null): boolean {
    if (!id || typeof id !== 'string') return false;
    return /^[a-fA-F0-9]{24}$/.test(id.trim());
  }

  /**
   * Safely create an ObjectId from a string, returns undefined if invalid
   */
  private safeObjectId(id: string | undefined | null): mongoose.Types.ObjectId | undefined {
    if (!this.isValidObjectId(id)) return undefined;
    return new mongoose.Types.ObjectId(id!.trim());
  }

  // ==================== WRITE OPERATIONS ====================

  /**
   * Store a memory (generic)
   *
   * 🔥 TRIPLE REDUNDANCY: Saves to Local Disk (immediate) + MongoDB (background or awaited)
   *
   * @param memory - The memory to store
   * @param options - { fireAndForget: true } to save to local immediately and MongoDB in background
   */
  async store(
    memory: Omit<GranularMemory, '_id' | 'usageCount' | 'createdAt' | 'updatedAt' | 'archived'>,
    options?: { fireAndForget?: boolean }
  ): Promise<GranularMemory> {
    const taskIdStr = memory.taskId?.toString();

    // 1️⃣ Save to Local Disk FIRST (immediate, synchronous, fast)
    // This ensures we never lose data even if MongoDB is slow/down
    const localMemory = {
      ...memory,
      _id: new mongoose.Types.ObjectId(),
      usageCount: 0,
      archived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as GranularMemory;

    if (taskIdStr) {
      try {
        await this.saveToLocal(localMemory, taskIdStr);
      } catch (localErr) {
        console.warn(`⚠️ [Memory] Local save failed (continuing): ${localErr}`);
      }
    }

    // 2️⃣ Save to MongoDB
    if (options?.fireAndForget) {
      // 🚀 FIRE-AND-FORGET: Don't block, save in background
      GranularMemoryModel.create({
        ...memory,
        usageCount: 0,
        archived: false,
      }).then(() => {
        console.log(`🧠 [Memory] Background saved: [${memory.type}] ${memory.title}`);
      }).catch((err: Error) => {
        console.warn(`⚠️ [Memory] Background MongoDB save failed (local backup exists): ${err.message}`);
      });

      console.log(`⚡ [Memory] Fire-and-forget: [${memory.type}] ${memory.title} (local saved)`);
      return localMemory;
    } else {
      // ⏳ AWAITED: Block until MongoDB saves (for critical operations)
      const doc = await GranularMemoryModel.create({
        ...memory,
        usageCount: 0,
        archived: false,
      });

      const savedMemory = doc.toObject() as GranularMemory;
      console.log(`🧠 [Memory] Stored: [${memory.type}] ${memory.title} (scope: ${memory.scope}) [MongoDB + Local]`);
      return savedMemory;
    }
  }

  /**
   * 🚀 Fire-and-forget store - saves locally immediately, MongoDB in background
   * Use this for non-critical operations (progress updates, learnings, patterns)
   */
  storeFireAndForget(memory: Omit<GranularMemory, '_id' | 'usageCount' | 'createdAt' | 'updatedAt' | 'archived'>): void {
    this.store(memory, { fireAndForget: true }).catch((err) => {
      console.warn(`⚠️ [Memory] Fire-and-forget failed: ${err.message}`);
    });
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
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storeDecision skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    return this.store({
      projectId: projectOid,
      taskId: this.safeObjectId(params.taskId),
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
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storeAction skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    return this.store({
      projectId: projectOid,
      taskId: this.safeObjectId(params.taskId),
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
   * 🚀 FIRE-AND-FORGET: Progress updates are non-critical, don't block execution
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
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      console.warn(`⚠️ [GranularMemory] storeProgress skipped - invalid IDs: projectId=${params.projectId}, taskId=${params.taskId}`);
      return {} as GranularMemory;
    }

    // 🚀 Fire-and-forget - local save is immediate, MongoDB in background
    return this.store({
      projectId: projectOid,
      taskId: taskOid,
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
    }, { fireAndForget: true });
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
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storeError skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    return this.store({
      projectId: projectOid,
      taskId: this.safeObjectId(params.taskId),
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
   * 🚀 FIRE-AND-FORGET: File changes can be reconstructed from git, non-blocking
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
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      console.warn(`⚠️ [GranularMemory] storeFileChange skipped - invalid IDs: projectId=${params.projectId}, taskId=${params.taskId}`);
      return {} as GranularMemory;
    }

    // 🚀 Fire-and-forget - local save is immediate, MongoDB in background
    return this.store({
      projectId: projectOid,
      taskId: taskOid,
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
    }, { fireAndForget: true });
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
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      console.warn(`⚠️ [GranularMemory] storeCheckpoint skipped - invalid IDs: projectId=${params.projectId}, taskId=${params.taskId}`);
      return {} as GranularMemory;
    }

    // Upsert to replace previous checkpoint at same scope
    const filter = {
      projectId: projectOid,
      taskId: taskOid,
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

    // 1️⃣ Save to MongoDB (primary)
    const doc = await GranularMemoryModel.findOneAndUpdate(filter, update, { upsert: true, new: true });
    const savedCheckpoint = doc.toObject() as GranularMemory;

    // 2️⃣ Save to Local Disk (backup)
    await this.saveToLocal(savedCheckpoint, params.taskId);

    console.log(`📍 [Checkpoint] Saved: ${params.phaseType}${params.epicId ? `/${params.epicId}` : ''}${params.storyId ? `/${params.storyId}` : ''} [MongoDB + Local]`);
    console.log(`   Completed: ${params.completedActions.length}, Pending: ${params.pendingActions.length}`);

    return savedCheckpoint;
  }

  /**
   * Store a pattern discovered in codebase
   * 🚀 FIRE-AND-FORGET: Patterns are nice-to-have, non-blocking
   */
  async storePattern(params: {
    projectId: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<GranularMemory> {
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storePattern skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    // 🚀 Fire-and-forget - local save is immediate, MongoDB in background
    return this.store({
      projectId: projectOid,
      scope: 'project', // Patterns are project-wide
      type: 'pattern',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.85,
    }, { fireAndForget: true });
  }

  /**
   * Store a convention to follow
   * 🚀 FIRE-AND-FORGET: Conventions are nice-to-have, non-blocking
   */
  async storeConvention(params: {
    projectId: string;
    title: string;
    content: string;
  }): Promise<GranularMemory> {
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storeConvention skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    // 🚀 Fire-and-forget - local save is immediate, MongoDB in background
    return this.store({
      projectId: projectOid,
      scope: 'project',
      type: 'convention',
      title: params.title,
      content: params.content,
      importance: 'high',
      confidence: 0.95,
    }, { fireAndForget: true });
  }

  /**
   * Store a learning for future runs
   * 🚀 FIRE-AND-FORGET: Learnings are nice-to-have, non-blocking
   */
  async storeLearning(params: {
    projectId: string;
    taskId?: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): Promise<GranularMemory> {
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] storeLearning skipped - invalid projectId: ${params.projectId}`);
      return {} as GranularMemory;
    }

    // 🚀 Fire-and-forget - local save is immediate, MongoDB in background
    return this.store({
      projectId: projectOid,
      taskId: this.safeObjectId(params.taskId),
      scope: params.taskId ? 'task' : 'project',
      type: 'learning',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.8,
    }, { fireAndForget: true });
  }

  // ==================== READ OPERATIONS ====================

  /**
   * Get checkpoint for exact resumption
   *
   * 🔥 DUAL SOURCE: Tries MongoDB first, then falls back to local files
   */
  async getCheckpoint(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
  }): Promise<GranularMemory | null> {
    // taskId is required for checkpoint lookup
    const taskOid = this.safeObjectId(params.taskId);
    if (!taskOid) {
      // Don't log warning - caller will handle fallback
      return null;
    }

    // Build filter with validated ObjectIds
    const filter: any = {
      taskId: taskOid,
      phaseType: params.phaseType,
      type: 'checkpoint',
      archived: false,
    };

    // Only add projectId if valid (can be empty string when searching by taskId only)
    const projectOid = this.safeObjectId(params.projectId);
    if (projectOid) {
      filter.projectId = projectOid;
    }

    if (params.storyId) {
      filter.storyId = params.storyId;
    } else if (params.epicId) {
      filter.epicId = params.epicId;
      filter.storyId = { $exists: false };
    }

    // 1️⃣ LOCAL FIRST (primary source of truth)
    const localCheckpoint = await this.loadCheckpointFromLocal(
      params.taskId,
      params.phaseType,
      params.epicId,
      params.storyId
    );

    if (localCheckpoint) {
      console.log(`📂 [Checkpoint] Found in LOCAL (primary): ${params.phaseType}${params.epicId ? `/${params.epicId}` : ''}${params.storyId ? `/${params.storyId}` : ''}`);
      return localCheckpoint;
    }

    // 2️⃣ FALLBACK to MongoDB only if local is empty
    console.log(`📂 [Checkpoint] LOCAL empty, checking MongoDB fallback...`);
    let checkpoint: GranularMemory | null = null;
    try {
      checkpoint = await GranularMemoryModel.findOne(filter).sort({ updatedAt: -1 }).lean() as GranularMemory | null;
    } catch (mongoErr: any) {
      console.warn(`⚠️ [Checkpoint] MongoDB fallback failed: ${mongoErr.message}`);
    }

    if (checkpoint) {
      console.log(`☁️ [Checkpoint] Found in MongoDB (fallback): ${params.phaseType}${params.epicId ? `/${params.epicId}` : ''}${params.storyId ? `/${params.storyId}` : ''}`);
    }

    return checkpoint;
  }

  /**
   * Get all memories for a phase (for context injection)
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getPhaseMemories(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const limit = params.limit || 50;

    // 1️⃣ LOCAL FIRST (primary source)
    const localMemories = await this.loadFromLocal(params.taskId);
    if (localMemories.length > 0) {
      // Filter locally
      const filtered = localMemories.filter(m => {
        // Include project-wide, task-specific, phase-specific memories
        if (m.scope === 'project') return true;
        if (m.taskId?.toString() === params.taskId) return true;
        if (params.phaseType && m.phaseType === params.phaseType) return true;
        if (params.epicId && m.epicId === params.epicId) return true;
        return false;
      });

      // Sort by importance and recency
      const importanceOrder = { critical: 4, high: 3, medium: 2, low: 1 };
      filtered.sort((a, b) => {
        const impDiff = (importanceOrder[b.importance] || 0) - (importanceOrder[a.importance] || 0);
        if (impDiff !== 0) return impDiff;
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      });

      const result = filtered.slice(0, limit);
      console.log(`📂 [GranularMemory] Loaded ${result.length} phase memories from LOCAL (primary)`);
      return result;
    }

    // 2️⃣ FALLBACK to MongoDB only if local is empty
    console.log(`📂 [GranularMemory] LOCAL empty, checking MongoDB fallback...`);

    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      return [];
    }

    const filter: any = {
      projectId: projectOid,
      archived: false,
      $or: [
        { scope: 'project' },
        { taskId: taskOid },
      ],
    };

    if (params.phaseType) {
      filter.$or.push({ phaseType: params.phaseType });
    }

    if (params.epicId) {
      filter.$or.push({ epicId: params.epicId });
    }

    try {
      const memories = await GranularMemoryModel.find(filter)
        .sort({ importance: -1, updatedAt: -1 })
        .limit(limit)
        .lean();

      if (memories.length > 0) {
        console.log(`☁️ [GranularMemory] Loaded ${memories.length} phase memories from MongoDB (fallback)`);
        // Update usage count (non-blocking)
        GranularMemoryModel.updateMany(
          { _id: { $in: memories.map(m => m._id) } },
          { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
        ).catch(() => {});
      }

      return memories as unknown as GranularMemory[];
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
  }

  /**
   * Get completed stories for an epic (to avoid re-doing work)
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getCompletedStories(params: {
    projectId: string;
    taskId: string;
    epicId: string;
  }): Promise<string[]> {
    // 1️⃣ LOCAL FIRST (primary source)
    const localMemories = await this.loadFromLocal(params.taskId, 'progress');
    if (localMemories.length > 0) {
      const completed = localMemories
        .filter(m =>
          m.epicId === params.epicId &&
          m.title?.startsWith('COMPLETED:') &&
          !m.archived
        )
        .map(m => m.storyId)
        .filter(Boolean) as string[];

      if (completed.length > 0) {
        console.log(`📂 [GranularMemory] Found ${completed.length} completed stories from LOCAL (primary)`);
        return completed;
      }
    }

    // 2️⃣ FALLBACK to MongoDB only if local is empty
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      return [];
    }

    try {
      const completedProgress = await GranularMemoryModel.find({
        projectId: projectOid,
        taskId: taskOid,
        epicId: params.epicId,
        type: 'progress',
        title: { $regex: /^COMPLETED:/ },
        archived: false,
      }).lean();

      const result = completedProgress.map((m: any) => m.storyId).filter(Boolean);
      if (result.length > 0) {
        console.log(`☁️ [GranularMemory] Found ${result.length} completed stories from MongoDB (fallback)`);
      }
      return result;
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
  }

  /**
   * Get errors to avoid
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getErrorsToAvoid(params: {
    projectId: string;
    taskId?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const limit = params.limit || 10;

    // 1️⃣ LOCAL FIRST (if taskId provided)
    if (params.taskId) {
      const localMemories = await this.loadFromLocal(params.taskId, 'error');
      if (localMemories.length > 0) {
        const filtered = localMemories.filter(m => !m.archived);
        const importanceOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        filtered.sort((a, b) => (importanceOrder[b.importance] || 0) - (importanceOrder[a.importance] || 0));
        console.log(`📂 [GranularMemory] Found ${Math.min(filtered.length, limit)} errors from LOCAL (primary)`);
        return filtered.slice(0, limit);
      }
    }

    // 2️⃣ FALLBACK to MongoDB
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      return [];
    }

    const filter: any = {
      projectId: projectOid,
      type: 'error',
      archived: false,
    };

    const taskOid = this.safeObjectId(params.taskId);
    if (taskOid) {
      filter.$or = [
        { taskId: taskOid },
        { scope: 'project' },
      ];
    }

    try {
      const results = await GranularMemoryModel.find(filter)
        .sort({ importance: -1, createdAt: -1 })
        .limit(limit)
        .lean();
      if (results.length > 0) {
        console.log(`☁️ [GranularMemory] Found ${results.length} errors from MongoDB (fallback)`);
      }
      return results as unknown as GranularMemory[];
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
  }

  /**
   * Get patterns and conventions
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getPatternsAndConventions(params: {
    projectId: string;
    taskId?: string; // Added for local-first
    limit?: number;
  }): Promise<GranularMemory[]> {
    const limit = params.limit || 20;

    // 1️⃣ LOCAL FIRST (if taskId provided)
    if (params.taskId) {
      const localMemories = await this.loadFromLocal(params.taskId);
      if (localMemories.length > 0) {
        const filtered = localMemories.filter(m =>
          (m.type === 'pattern' || m.type === 'convention') && !m.archived
        );
        const importanceOrder = { critical: 4, high: 3, medium: 2, low: 1 };
        filtered.sort((a, b) => {
          const impDiff = (importanceOrder[b.importance] || 0) - (importanceOrder[a.importance] || 0);
          if (impDiff !== 0) return impDiff;
          return (b.confidence || 0) - (a.confidence || 0);
        });
        if (filtered.length > 0) {
          console.log(`📂 [GranularMemory] Found ${Math.min(filtered.length, limit)} patterns/conventions from LOCAL (primary)`);
          return filtered.slice(0, limit);
        }
      }
    }

    // 2️⃣ FALLBACK to MongoDB
    const projectOid = this.safeObjectId(params.projectId);
    if (!projectOid) {
      return [];
    }

    try {
      const results = await GranularMemoryModel.find({
        projectId: projectOid,
        type: { $in: ['pattern', 'convention'] },
        archived: false,
      })
        .sort({ importance: -1, confidence: -1 })
        .limit(limit)
        .lean();
      if (results.length > 0) {
        console.log(`☁️ [GranularMemory] Found ${results.length} patterns/conventions from MongoDB (fallback)`);
      }
      return results as unknown as GranularMemory[];
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
  }

  /**
   * Get file changes for a story (to know what was already modified)
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getFileChanges(params: {
    projectId: string;
    taskId: string;
    epicId?: string;
    storyId?: string;
  }): Promise<GranularMemory[]> {
    // 1️⃣ LOCAL FIRST
    const localMemories = await this.loadFromLocal(params.taskId, 'file_change');
    if (localMemories.length > 0) {
      let filtered = localMemories.filter(m => !m.archived);
      if (params.storyId) {
        filtered = filtered.filter(m => m.storyId === params.storyId);
      } else if (params.epicId) {
        filtered = filtered.filter(m => m.epicId === params.epicId);
      }
      filtered.sort((a, b) => {
        const aTime = new Date(a.createdAt || 0).getTime();
        const bTime = new Date(b.createdAt || 0).getTime();
        return bTime - aTime;
      });
      if (filtered.length > 0) {
        console.log(`📂 [GranularMemory] Found ${filtered.length} file changes from LOCAL (primary)`);
        return filtered;
      }
    }

    // 2️⃣ FALLBACK to MongoDB
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      return [];
    }

    const filter: any = {
      projectId: projectOid,
      taskId: taskOid,
      type: 'file_change',
      archived: false,
    };

    if (params.storyId) {
      filter.storyId = params.storyId;
    } else if (params.epicId) {
      filter.epicId = params.epicId;
    }

    try {
      const results = await GranularMemoryModel.find(filter)
        .sort({ createdAt: -1 })
        .lean();
      if (results.length > 0) {
        console.log(`☁️ [GranularMemory] Found ${results.length} file changes from MongoDB (fallback)`);
      }
      return results as unknown as GranularMemory[];
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
  }

  /**
   * 🔥 STRICT TASK CACHE: Get cache entries ONLY for this specific task
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
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
    // 1️⃣ LOCAL FIRST
    const localMemories = await this.loadFromLocal(params.taskId, 'context');
    if (localMemories.length > 0) {
      const found = localMemories.find(m =>
        m.phaseType === params.phaseType &&
        m.title === params.cacheTitle &&
        !m.archived
      );
      if (found) {
        console.log(`📂 [GranularMemory] Found task cache "${params.cacheTitle}" from LOCAL (primary)`);
        return found;
      }
    }

    // 2️⃣ FALLBACK to MongoDB
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      return null;
    }

    try {
      const result = await GranularMemoryModel.findOne({
        projectId: projectOid,
        taskId: taskOid,
        phaseType: params.phaseType,
        type: 'context',
        title: params.cacheTitle,
        archived: false,
      }).lean() as any;

      if (result) {
        console.log(`☁️ [GranularMemory] Found task cache "${params.cacheTitle}" from MongoDB (fallback)`);
        // Update usage stats (non-blocking)
        if (result._id) {
          GranularMemoryModel.updateOne(
            { _id: result._id },
            { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
          ).catch(() => {});
        }
      }

      return result as GranularMemory | null;
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return null;
    }
  }

  /**
   * 🔥 STRICT TASK CACHE: Get multiple cache entries for this specific task
   * 🔥 LOCAL-FIRST: Reads local files first, MongoDB as fallback
   */
  async getTaskCaches(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    cacheTitlePrefix?: string;
    limit?: number;
  }): Promise<GranularMemory[]> {
    const limit = params.limit || 10;

    // 1️⃣ LOCAL FIRST
    const localMemories = await this.loadFromLocal(params.taskId, 'context');
    if (localMemories.length > 0) {
      let filtered = localMemories.filter(m =>
        m.phaseType === params.phaseType && !m.archived
      );
      if (params.cacheTitlePrefix) {
        filtered = filtered.filter(m => m.title?.startsWith(params.cacheTitlePrefix!));
      }
      filtered.sort((a, b) => {
        const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return bTime - aTime;
      });
      if (filtered.length > 0) {
        console.log(`📂 [GranularMemory] Found ${Math.min(filtered.length, limit)} task caches from LOCAL (primary)`);
        return filtered.slice(0, limit);
      }
    }

    // 2️⃣ FALLBACK to MongoDB
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      return [];
    }

    const filter: any = {
      projectId: projectOid,
      taskId: taskOid,
      phaseType: params.phaseType,
      type: 'context',
      archived: false,
    };

    if (params.cacheTitlePrefix) {
      filter.title = { $regex: new RegExp(`^${params.cacheTitlePrefix}`) };
    }

    try {
      const results = await GranularMemoryModel.find(filter)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      if (results.length > 0) {
        console.log(`☁️ [GranularMemory] Found ${results.length} task caches from MongoDB (fallback)`);
        // Update usage stats (non-blocking fire-and-forget)
        GranularMemoryModel.updateMany(
          { _id: { $in: results.map(r => r._id) } },
          { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date() } }
        ).catch(() => {});
      }

      return results as unknown as GranularMemory[];
    } catch (mongoErr: any) {
      console.warn(`⚠️ [GranularMemory] MongoDB fallback failed: ${mongoErr.message}`);
      return [];
    }
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

  // ==================== GIT COMMITS ====================

  /**
   * 🔥 TRIPLE REDUNDANCY: Commit agent action to git
   *
   * This creates a git commit for agent actions, providing:
   * - Full audit trail in git history
   * - Ability to rollback to any agent action
   * - Clear visibility of what each agent did
   */
  async commitAgentAction(params: {
    taskId: string;
    agentType: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
    actionTitle: string;
    actionDetails: string;
    filePaths?: string[];
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    const memDir = this.getMemoryDir(params.taskId);
    if (!memDir) {
      return { success: false, error: 'No workspace found' };
    }

    // Get the repo directory (parent of .granular-memory)
    const repoDir = path.dirname(memDir);

    try {
      const { execSync } = require('child_process');

      // Check if there are changes to commit
      const status = execSync('git status --porcelain', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 30000,
      }).trim();

      if (!status) {
        console.log(`📝 [Git] No changes to commit for ${params.agentType}`);
        return { success: true, commitSha: 'no-changes' };
      }

      // Stage all changes (or specific files if provided)
      if (params.filePaths && params.filePaths.length > 0) {
        for (const filePath of params.filePaths) {
          execSync(`git add "${filePath}"`, { cwd: repoDir, timeout: 30000 });
        }
      } else {
        execSync('git add -A', { cwd: repoDir, timeout: 30000 });
      }

      // Create commit message
      const scope = [params.epicId, params.storyId].filter(Boolean).join('/');
      const commitMessage = [
        `[${params.agentType}] ${params.actionTitle}`,
        '',
        `Phase: ${params.phaseType}`,
        scope ? `Scope: ${scope}` : '',
        '',
        params.actionDetails,
        '',
        `🤖 Auto-committed by ${params.agentType} agent`,
      ].filter(Boolean).join('\n');

      // Commit
      execSync(
        `git commit -m "${commitMessage.replace(/"/g, '\\"')}"`,
        { cwd: repoDir, encoding: 'utf8', timeout: 30000 }
      );

      // Get commit SHA
      const commitSha = execSync('git rev-parse HEAD', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      console.log(`📝 [Git] Committed: ${commitSha.substring(0, 7)} - ${params.actionTitle}`);

      // Store the commit info as a memory too
      await this.storeAction({
        projectId: '', // Will be filled if available
        taskId: params.taskId,
        phaseType: params.phaseType,
        agentType: params.agentType,
        epicId: params.epicId,
        storyId: params.storyId,
        title: `Git Commit: ${commitSha.substring(0, 7)}`,
        content: `Committed: ${params.actionTitle}\nSHA: ${commitSha}\nFiles: ${params.filePaths?.join(', ') || 'all changes'}`,
      });

      return { success: true, commitSha };
    } catch (error: any) {
      console.warn(`⚠️ [Git] Failed to commit: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🔥 Push all commits to remote
   */
  async pushToRemote(params: {
    taskId: string;
    branch?: string;
    force?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const memDir = this.getMemoryDir(params.taskId);
    if (!memDir) {
      return { success: false, error: 'No workspace found' };
    }

    const repoDir = path.dirname(memDir);

    try {
      const { execSync } = require('child_process');

      // Get current branch if not specified
      const branch = params.branch || execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      // Push to remote
      const forceFlag = params.force ? '--force' : '';
      execSync(`git push origin ${branch} ${forceFlag}`.trim(), {
        cwd: repoDir,
        timeout: 120000, // 2 minutes for push
      });

      console.log(`🚀 [Git] Pushed to origin/${branch}`);
      return { success: true };
    } catch (error: any) {
      console.warn(`⚠️ [Git] Failed to push: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 🔥 Commit and push in one operation
   */
  async commitAndPush(params: {
    taskId: string;
    agentType: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
    actionTitle: string;
    actionDetails: string;
    filePaths?: string[];
    branch?: string;
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    // First commit
    const commitResult = await this.commitAgentAction(params);
    if (!commitResult.success || commitResult.commitSha === 'no-changes') {
      return commitResult;
    }

    // Then push
    const pushResult = await this.pushToRemote({
      taskId: params.taskId,
      branch: params.branch,
    });

    if (!pushResult.success) {
      return { success: true, commitSha: commitResult.commitSha, error: `Committed but push failed: ${pushResult.error}` };
    }

    return { success: true, commitSha: commitResult.commitSha };
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
    const projectOid = this.safeObjectId(projectId);
    if (!projectOid) {
      console.warn(`⚠️ [GranularMemory] cleanup skipped - invalid projectId: ${projectId}`);
      return 0;
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await GranularMemoryModel.updateMany(
      {
        projectId: projectOid,
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
    const taskOid = this.safeObjectId(taskId);
    if (!taskOid) {
      console.warn(`⚠️ [GranularMemory] deleteTaskMemories skipped - invalid taskId: ${taskId}`);
      return 0;
    }

    const filter: any = {
      taskId: taskOid,
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
