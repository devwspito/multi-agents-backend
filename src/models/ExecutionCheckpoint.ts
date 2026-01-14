import mongoose, { Document, Schema } from 'mongoose';

/**
 * ExecutionCheckpoint - Saves periodic state during agent execution
 *
 * This allows resuming an agent execution from where it left off
 * after a server restart or crash.
 *
 * Strategy:
 * 1. Save checkpoint every N turns or N seconds
 * 2. On server restart, find active checkpoints
 * 3. Resume execution using saved state
 */
export interface IExecutionCheckpoint extends Document {
  // Identification
  taskId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;

  // Agent context
  agentType: string;
  agentName?: string;
  phaseName?: string;

  // Execution state
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  workspacePath: string;
  modelId: string;

  // Progress tracking
  turnsCompleted: number;
  messagesReceived: number;
  lastTurnAt: Date;

  // Prompt state (for resume)
  originalPrompt: string;

  // Context snapshot
  contextSnapshot?: {
    epics?: any[];
    stories?: any[];
    currentPhaseData?: any;
  };

  // Git state for recovery
  gitState?: {
    branch: string;
    lastCommitSha?: string;
    uncommittedChanges: boolean;
  };

  // Files modified (for recovery)
  filesModified: string[];

  // Timestamps
  startedAt: Date;
  lastCheckpointAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ExecutionCheckpointSchema = new Schema<IExecutionCheckpoint>({
  // Identification
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },

  // Agent context
  agentType: { type: String, required: true, index: true },
  agentName: { type: String },
  phaseName: { type: String },

  // Execution state
  status: {
    type: String,
    enum: ['active', 'completed', 'failed', 'abandoned'],
    default: 'active',
    index: true
  },
  workspacePath: { type: String, required: true },
  modelId: { type: String, required: true },

  // Progress tracking
  turnsCompleted: { type: Number, default: 0 },
  messagesReceived: { type: Number, default: 0 },
  lastTurnAt: { type: Date, default: Date.now },

  // Prompt state
  originalPrompt: { type: String, required: true },

  // Context snapshot
  contextSnapshot: { type: Schema.Types.Mixed },

  // Git state
  gitState: {
    branch: { type: String },
    lastCommitSha: { type: String },
    uncommittedChanges: { type: Boolean, default: false }
  },

  // Files modified
  filesModified: [{ type: String }],

  // Timestamps
  startedAt: { type: Date, default: Date.now },
  lastCheckpointAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
}, {
  timestamps: true,
  collection: 'execution_checkpoints'
});

// Index for finding active checkpoints
ExecutionCheckpointSchema.index({ status: 1, taskId: 1 });

// Index for cleanup
ExecutionCheckpointSchema.index({ status: 1, completedAt: 1 });

/**
 * Static: Find active checkpoints for recovery
 */
ExecutionCheckpointSchema.statics.findActiveForRecovery = function() {
  return this.find({
    status: 'active',
    // Only recover checkpoints less than 1 hour old
    lastCheckpointAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }
  }).sort({ lastCheckpointAt: -1 });
};

/**
 * Static: Cleanup old completed checkpoints
 */
ExecutionCheckpointSchema.statics.cleanupOld = async function(daysOld: number = 1) {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);

  const result = await this.deleteMany({
    status: { $in: ['completed', 'abandoned'] },
    completedAt: { $lt: cutoff }
  });

  return result.deletedCount;
};

export const ExecutionCheckpoint = mongoose.model<IExecutionCheckpoint>('ExecutionCheckpoint', ExecutionCheckpointSchema);
