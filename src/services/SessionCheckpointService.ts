/**
 * SessionCheckpointService - Mid-Execution Recovery for ALL Phases
 *
 * Enables any phase to save and restore SDK session state for exact resumption.
 * When a phase crashes mid-execution, we can resume from the exact point
 * instead of re-running from the beginning.
 *
 * Key Features:
 * - Save SDK sessionId and lastMessageUuid after agent starts
 * - Load checkpoint data when resuming interrupted phases
 * - Works with EventStore for persistence
 *
 * Usage:
 * 1. Before executeAgent: Check for existing checkpoint
 * 2. If found: Pass resumeOptions to executeAgent
 * 3. After executeAgent starts: Save checkpoint with session data
 */

import mongoose from 'mongoose';

/**
 * Session checkpoint data structure
 */
export interface SessionCheckpoint {
  taskId: string;
  phaseType: string;           // 'planning' | 'tech-lead' | 'developer' | etc.
  entityId?: string;           // Story ID, Epic ID, or phase-specific identifier
  sdkSessionId: string;        // SDK session ID for resume
  lastMessageUuid?: string;    // Last processed message UUID
  status: 'active' | 'completed' | 'failed';
  startedAt: Date;
  updatedAt: Date;
  context?: Record<string, any>; // Additional context for recovery
}

/**
 * MongoDB Schema for session checkpoints
 */
const sessionCheckpointSchema = new mongoose.Schema({
  taskId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  phaseType: { type: String, required: true, index: true },
  entityId: { type: String, index: true },
  sdkSessionId: { type: String, required: true },
  lastMessageUuid: { type: String },
  status: { type: String, enum: ['active', 'completed', 'failed'], default: 'active' },
  startedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  context: { type: mongoose.Schema.Types.Mixed },
}, {
  timestamps: true,
});

// Compound index for efficient lookup
sessionCheckpointSchema.index({ taskId: 1, phaseType: 1, entityId: 1 });

// Only create model if it doesn't exist (prevents OverwriteModelError)
const SessionCheckpointModel = mongoose.models.SessionCheckpoint ||
  mongoose.model('SessionCheckpoint', sessionCheckpointSchema);

/**
 * SessionCheckpointService - Singleton for managing session checkpoints
 */
export class SessionCheckpointService {
  private static instance: SessionCheckpointService;

  private constructor() {}

  static getInstance(): SessionCheckpointService {
    if (!SessionCheckpointService.instance) {
      SessionCheckpointService.instance = new SessionCheckpointService();
    }
    return SessionCheckpointService.instance;
  }

  /**
   * Save a session checkpoint after agent execution starts
   *
   * @param taskId - Task ID
   * @param phaseType - Phase type (e.g., 'planning', 'tech-lead', 'developer')
   * @param sdkSessionId - SDK session ID from executeAgent result
   * @param entityId - Optional entity ID (story ID, epic ID, etc.)
   * @param lastMessageUuid - Optional last message UUID
   * @param context - Optional additional context
   */
  async saveCheckpoint(
    taskId: string,
    phaseType: string,
    sdkSessionId: string,
    entityId?: string,
    lastMessageUuid?: string,
    context?: Record<string, any>
  ): Promise<SessionCheckpoint | null> {
    try {
      // Upsert to update existing checkpoint or create new one
      const checkpoint = await SessionCheckpointModel.findOneAndUpdate(
        {
          taskId: new mongoose.Types.ObjectId(taskId),
          phaseType,
          ...(entityId && { entityId }),
        },
        {
          $set: {
            sdkSessionId,
            lastMessageUuid,
            status: 'active',
            updatedAt: new Date(),
            context,
          },
          $setOnInsert: {
            startedAt: new Date(),
          },
        },
        { upsert: true, new: true }
      ).lean();

      console.log(`💾 [SessionCheckpoint] Saved: ${phaseType}${entityId ? `/${entityId}` : ''} → ${sdkSessionId.substring(0, 20)}...`);

      return checkpoint as unknown as SessionCheckpoint;
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to save: ${error.message}`);
      return null;
    }
  }

  /**
   * Load an existing session checkpoint for resume
   *
   * @param taskId - Task ID
   * @param phaseType - Phase type
   * @param entityId - Optional entity ID
   * @returns Checkpoint data if exists and is active, null otherwise
   */
  async loadCheckpoint(
    taskId: string,
    phaseType: string,
    entityId?: string
  ): Promise<SessionCheckpoint | null> {
    try {
      const checkpoint = await SessionCheckpointModel.findOne({
        taskId: new mongoose.Types.ObjectId(taskId),
        phaseType,
        ...(entityId && { entityId }),
        status: 'active', // Only load active checkpoints
      }).lean();

      if (checkpoint) {
        console.log(`🔄 [SessionCheckpoint] Loaded: ${phaseType}${entityId ? `/${entityId}` : ''} → ${(checkpoint as any).sdkSessionId?.substring(0, 20)}...`);
        return checkpoint as unknown as SessionCheckpoint;
      }

      return null;
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to load: ${error.message}`);
      return null;
    }
  }

  /**
   * Mark a checkpoint as completed (no resume needed)
   */
  async markCompleted(
    taskId: string,
    phaseType: string,
    entityId?: string
  ): Promise<void> {
    try {
      await SessionCheckpointModel.updateOne(
        {
          taskId: new mongoose.Types.ObjectId(taskId),
          phaseType,
          ...(entityId && { entityId }),
        },
        {
          $set: {
            status: 'completed',
            updatedAt: new Date(),
          },
        }
      );

      console.log(`✅ [SessionCheckpoint] Marked completed: ${phaseType}${entityId ? `/${entityId}` : ''}`);
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to mark completed: ${error.message}`);
    }
  }

  /**
   * Mark a checkpoint as failed
   */
  async markFailed(
    taskId: string,
    phaseType: string,
    entityId?: string,
    error?: string
  ): Promise<void> {
    try {
      await SessionCheckpointModel.updateOne(
        {
          taskId: new mongoose.Types.ObjectId(taskId),
          phaseType,
          ...(entityId && { entityId }),
        },
        {
          $set: {
            status: 'failed',
            updatedAt: new Date(),
            'context.error': error,
          },
        }
      );

      console.log(`❌ [SessionCheckpoint] Marked failed: ${phaseType}${entityId ? `/${entityId}` : ''}`);
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to mark failed: ${error.message}`);
    }
  }

  /**
   * Update last message UUID for precise resumption point
   */
  async updateLastMessage(
    taskId: string,
    phaseType: string,
    lastMessageUuid: string,
    entityId?: string
  ): Promise<void> {
    try {
      await SessionCheckpointModel.updateOne(
        {
          taskId: new mongoose.Types.ObjectId(taskId),
          phaseType,
          ...(entityId && { entityId }),
        },
        {
          $set: {
            lastMessageUuid,
            updatedAt: new Date(),
          },
        }
      );
    } catch (error: any) {
      // Non-critical - just log
      console.warn(`⚠️ [SessionCheckpoint] Failed to update lastMessageUuid: ${error.message}`);
    }
  }

  /**
   * Get all active checkpoints for a task (for debugging/monitoring)
   */
  async getActiveCheckpoints(taskId: string): Promise<SessionCheckpoint[]> {
    try {
      const checkpoints = await SessionCheckpointModel.find({
        taskId: new mongoose.Types.ObjectId(taskId),
        status: 'active',
      }).lean();

      return checkpoints as unknown as SessionCheckpoint[];
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to get active checkpoints: ${error.message}`);
      return [];
    }
  }

  /**
   * Delete all checkpoints for a task (cleanup after task completes)
   */
  async deleteAllForTask(taskId: string): Promise<void> {
    try {
      const result = await SessionCheckpointModel.deleteMany({
        taskId: new mongoose.Types.ObjectId(taskId),
      });

      console.log(`🗑️ [SessionCheckpoint] Deleted ${result.deletedCount} checkpoints for task ${taskId}`);
    } catch (error: any) {
      console.error(`❌ [SessionCheckpoint] Failed to delete checkpoints: ${error.message}`);
    }
  }

  /**
   * Build resume options from a checkpoint
   */
  buildResumeOptions(checkpoint: SessionCheckpoint | null): {
    resumeSessionId?: string;
    resumeAtMessage?: string;
    isResume?: boolean;
  } | undefined {
    if (!checkpoint || !checkpoint.sdkSessionId) {
      return undefined;
    }

    return {
      resumeSessionId: checkpoint.sdkSessionId,
      resumeAtMessage: checkpoint.lastMessageUuid,
      isResume: true,
    };
  }
}

// Export singleton instance
export const sessionCheckpointService = SessionCheckpointService.getInstance();
