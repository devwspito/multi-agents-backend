import mongoose, { Document, Schema } from 'mongoose';

/**
 * Log Level Types
 */
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG';

/**
 * Log Category - helps filter and organize logs
 */
export type LogCategory =
  | 'orchestration'    // General orchestration flow
  | 'agent'           // Agent execution (PM, TL, Dev, QA, MC)
  | 'developer'       // Developer-specific actions
  | 'story'           // Story-level events
  | 'epic'            // Epic-level events
  | 'judge'           // Judge evaluations
  | 'quality'         // Quality checks, auto-healing
  | 'git'             // Git operations
  | 'pr'              // Pull request operations
  | 'notification'    // WebSocket notifications
  | 'system'          // System-level events
  | 'auto_merge'      // Auto-merge operations
  | 'branch_cleanup'  // Branch cleanup after merge
  | 'error';          // Errors and failures

/**
 * Task Log Entry
 *
 * Structured logging system for tasks with complete context
 * Replaces console.log with queryable, filterable logs stored in MongoDB
 */
export interface ITaskLog extends Document {
  // Core identification
  taskId: mongoose.Types.ObjectId;
  timestamp: Date;

  // Log metadata
  level: LogLevel;
  category: LogCategory;
  message: string;

  // Context (optional but recommended)
  phase?: 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'auto-merge' | 'completed' | 'multi-team';
  agentType?: 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'team-orchestration' | 'auto-merge';
  agentInstanceId?: string; // For developers: "dev-1", "dev-2", etc.

  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;

  // Additional data (flexible JSON)
  metadata?: {
    score?: number;
    cost?: number;
    duration?: number;
    fileCount?: number;
    linesChanged?: number;
    retryCount?: number;
    [key: string]: any;
  };

  // Error details (when level = ERROR)
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };

  // Session tracking
  sessionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const taskLogSchema = new Schema<ITaskLog>(
  {
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true, // Fast queries by taskId
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true, // Fast queries by time range
    },
    level: {
      type: String,
      enum: ['INFO', 'SUCCESS', 'WARN', 'ERROR', 'DEBUG'],
      required: true,
      index: true, // Filter by level
    },
    category: {
      type: String,
      enum: [
        'orchestration',
        'agent',
        'developer',
        'story',
        'epic',
        'judge',
        'quality',
        'git',
        'pr',
        'notification',
        'system',
        'auto_merge',
        'error',
      ],
      required: true,
      index: true, // Filter by category
    },
    message: {
      type: String,
      required: true,
    },
    phase: {
      type: String,
      enum: ['analysis', 'planning', 'architecture', 'development', 'qa', 'merge', 'auto-merge', 'completed', 'multi-team'],
    },
    agentType: {
      type: String,
      enum: ['product-manager', 'project-manager', 'tech-lead', 'developer', 'qa-engineer', 'merge-coordinator', 'judge', 'fixer', 'team-orchestration', 'auto-merge'],
    },
    agentInstanceId: String,
    epicId: String,
    epicName: String,
    storyId: String,
    storyTitle: String,
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
    error: {
      message: String,
      stack: String,
      code: String,
    },
    sessionId: String,
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
taskLogSchema.index({ taskId: 1, timestamp: -1 }); // Get logs for task ordered by time
taskLogSchema.index({ taskId: 1, category: 1 }); // Get logs by category for task
taskLogSchema.index({ taskId: 1, level: 1 }); // Get logs by level for task
taskLogSchema.index({ taskId: 1, agentType: 1 }); // Get logs for specific agent
taskLogSchema.index({ taskId: 1, epicId: 1 }); // Get logs for specific epic
taskLogSchema.index({ taskId: 1, storyId: 1 }); // Get logs for specific story

export const TaskLog = mongoose.model<ITaskLog>('TaskLog', taskLogSchema);
