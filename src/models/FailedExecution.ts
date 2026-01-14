import mongoose, { Document, Schema } from 'mongoose';

/**
 * Failure type classification for retry strategy
 */
export type FailureType =
  | 'timeout'           // Stream timeout (30min exceeded)
  | 'history_overflow'  // Too many history messages without agent starting
  | 'loop_detection'    // Agent stuck in loop without tool activity
  | 'sdk_error'         // SDK query failed
  | 'api_error'         // Anthropic API error
  | 'git_error'         // Git operation failed
  | 'unknown';          // Uncategorized error

/**
 * Retry status for failed executions
 */
export type RetryStatus =
  | 'pending'           // Ready to retry
  | 'scheduled'         // Scheduled for retry
  | 'retrying'          // Currently retrying
  | 'succeeded'         // Retry succeeded
  | 'abandoned';        // Max retries exceeded or manually abandoned

/**
 * Failed Execution - Persists failed agent executions for retry
 *
 * When an agent execution fails (timeout, loop, overflow), we save all
 * the context needed to retry it later. This enables:
 * 1. Automatic retry with different model/settings
 * 2. Manual retry after fixing issues
 * 3. Analysis of failure patterns
 */
export interface IFailedExecution extends Document {
  // Identification
  taskId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;

  // Agent context
  agentType: string;
  agentName?: string;
  phaseName?: string;

  // Execution context
  prompt: string;
  workspacePath: string;
  modelId: string;
  permissionMode?: string;

  // Failure details
  failureType: FailureType;
  errorMessage: string;
  errorStack?: string;

  // Stream diagnostics
  messagesReceived: number;
  historyMessages: number;
  turnsCompleted: number;
  lastMessageTypes: string[];  // Last 10 message types for debugging
  streamDurationMs: number;

  // Retry tracking
  retryStatus: RetryStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastRetryAt?: Date;
  retryHistory: Array<{
    attemptedAt: Date;
    modelId: string;
    result: 'success' | 'failed';
    errorMessage?: string;
    durationMs: number;
  }>;

  // Context for retry
  contextSnapshot?: {
    epics?: any[];
    stories?: any[];
    currentPhase?: string;
    phaseResults?: Record<string, any>;
  };

  // Metadata
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
}

const FailedExecutionSchema = new Schema<IFailedExecution>({
  // Identification
  taskId: { type: Schema.Types.ObjectId, ref: 'Task', required: true, index: true },
  projectId: { type: Schema.Types.ObjectId, ref: 'Project', index: true },

  // Agent context
  agentType: { type: String, required: true, index: true },
  agentName: { type: String },
  phaseName: { type: String, index: true },

  // Execution context
  prompt: { type: String, required: true },
  workspacePath: { type: String, required: true },
  modelId: { type: String, required: true },
  permissionMode: { type: String, default: 'bypassPermissions' },

  // Failure details
  failureType: {
    type: String,
    enum: ['timeout', 'history_overflow', 'loop_detection', 'sdk_error', 'api_error', 'git_error', 'unknown'],
    required: true,
    index: true
  },
  errorMessage: { type: String, required: true },
  errorStack: { type: String },

  // Stream diagnostics
  messagesReceived: { type: Number, default: 0 },
  historyMessages: { type: Number, default: 0 },
  turnsCompleted: { type: Number, default: 0 },
  lastMessageTypes: [{ type: String }],
  streamDurationMs: { type: Number, default: 0 },

  // Retry tracking
  retryStatus: {
    type: String,
    enum: ['pending', 'scheduled', 'retrying', 'succeeded', 'abandoned'],
    default: 'pending',
    index: true
  },
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },
  nextRetryAt: { type: Date },
  lastRetryAt: { type: Date },
  retryHistory: [{
    attemptedAt: { type: Date, required: true },
    modelId: { type: String, required: true },
    result: { type: String, enum: ['success', 'failed'], required: true },
    errorMessage: { type: String },
    durationMs: { type: Number, required: true }
  }],

  // Context for retry
  contextSnapshot: { type: Schema.Types.Mixed },

  // Metadata
  resolvedAt: { type: Date }
}, {
  timestamps: true, // Adds createdAt and updatedAt
  collection: 'failed_executions'
});

// Compound index for finding retryable executions
FailedExecutionSchema.index({ retryStatus: 1, nextRetryAt: 1 });

// Index for failure analysis
FailedExecutionSchema.index({ failureType: 1, createdAt: -1 });

/**
 * Static method to find executions ready for retry
 */
FailedExecutionSchema.statics.findRetryable = function() {
  return this.find({
    retryStatus: 'pending',
    $expr: { $lt: ['$retryCount', '$maxRetries'] }, // Compare fields
    $or: [
      { nextRetryAt: { $exists: false } },
      { nextRetryAt: { $lte: new Date() } }
    ]
  }).sort({ createdAt: 1 }); // Oldest first
};

/**
 * Static method to get failure statistics
 */
FailedExecutionSchema.statics.getFailureStats = async function(taskId?: string) {
  const match = taskId ? { taskId: new mongoose.Types.ObjectId(taskId) } : {};

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$failureType',
        count: { $sum: 1 },
        avgDurationMs: { $avg: '$streamDurationMs' },
        avgMessagesReceived: { $avg: '$messagesReceived' },
        retrySuccessRate: {
          $avg: { $cond: [{ $eq: ['$retryStatus', 'succeeded'] }, 1, 0] }
        }
      }
    },
    { $sort: { count: -1 } }
  ]);
};

export const FailedExecution = mongoose.model<IFailedExecution>('FailedExecution', FailedExecutionSchema);
