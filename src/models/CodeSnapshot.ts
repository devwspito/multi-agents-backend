import mongoose, { Document, Schema } from 'mongoose';

/**
 * File Change Type
 */
export type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

/**
 * File Change Entry
 */
export interface IFileChange {
  path: string;
  changeType: ChangeType;
  linesAdded: number;
  linesDeleted: number;
  diff?: string; // Git diff output (optional, can be large)
  content?: string; // Full file content after change (optional)
}

/**
 * Code Snapshot
 *
 * Captures code changes made by developers during story implementation
 * Provides visibility into what code is being generated
 */
export interface ICodeSnapshot extends Document {
  // Core identification
  taskId: mongoose.Types.ObjectId;
  timestamp: Date;

  // Context
  phase: 'development' | 'qa' | 'merge' | 'auto-merge';
  agentType: 'developer' | 'qa-engineer' | 'merge-coordinator' | 'auto-merge';
  agentInstanceId: string; // "dev-1", "dev-2", etc.

  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;

  // Repository info
  repositoryName: string;
  branchName: string;
  commitHash?: string;
  commitMessage?: string;

  // Code changes
  fileChanges: IFileChange[];

  // Statistics
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;

  // Session tracking
  sessionId?: string;

  createdAt: Date;
  updatedAt: Date;
}

const fileChangeSchema = new Schema<IFileChange>(
  {
    path: {
      type: String,
      required: true,
    },
    changeType: {
      type: String,
      enum: ['created', 'modified', 'deleted', 'renamed'],
      required: true,
    },
    linesAdded: {
      type: Number,
      default: 0,
    },
    linesDeleted: {
      type: Number,
      default: 0,
    },
    diff: String,
    content: String,
  },
  { _id: false }
);

const codeSnapshotSchema = new Schema<ICodeSnapshot>(
  {
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
    phase: {
      type: String,
      enum: ['development', 'qa', 'merge', 'auto-merge'],
      required: true,
    },
    agentType: {
      type: String,
      enum: ['developer', 'qa-engineer', 'merge-coordinator', 'auto-merge'],
      required: true,
    },
    agentInstanceId: {
      type: String,
      required: true,
    },
    epicId: String,
    epicName: String,
    storyId: String,
    storyTitle: String,
    repositoryName: {
      type: String,
      required: true,
    },
    branchName: {
      type: String,
      required: true,
    },
    commitHash: String,
    commitMessage: String,
    fileChanges: [fileChangeSchema],
    totalFilesChanged: {
      type: Number,
      default: 0,
    },
    totalLinesAdded: {
      type: Number,
      default: 0,
    },
    totalLinesDeleted: {
      type: Number,
      default: 0,
    },
    sessionId: String,
  },
  {
    timestamps: true,
  }
);

// Compound indexes for common queries
codeSnapshotSchema.index({ taskId: 1, timestamp: -1 }); // Get snapshots for task ordered by time
codeSnapshotSchema.index({ taskId: 1, agentInstanceId: 1 }); // Get snapshots by agent
codeSnapshotSchema.index({ taskId: 1, epicId: 1 }); // Get snapshots for specific epic
codeSnapshotSchema.index({ taskId: 1, storyId: 1 }); // Get snapshots for specific story

export const CodeSnapshot = mongoose.model<ICodeSnapshot>('CodeSnapshot', codeSnapshotSchema);
