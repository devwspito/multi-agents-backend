import mongoose, { Document, Schema } from 'mongoose';

/**
 * Event Types - All possible events in the orchestration flow
 *
 * NOTE: Legacy event types (ProductManager*, ProjectManager*, QA*, Fixer*, etc.)
 * are kept for backwards compatibility with existing events in the database.
 * New events should use the active types only.
 */
export type EventType =
  // Task lifecycle
  | 'TaskCreated'
  | 'TaskStarted'
  | 'TaskCompleted'
  | 'TaskFailed'
  | 'TaskCancelled'
  | 'TaskPaused'
  | 'TaskResumed'
  | 'OrchestrationFailed'

  // Unified Planning events (ACTIVE)
  | 'PlanningStarted'
  | 'PlanningCompleted'
  | 'PlanningFailed'
  | 'PlanningApproved'
  | 'PlanningRejected'

  // Tech Lead events (ACTIVE)
  | 'TechLeadStarted'
  | 'TechLeadCompleted'
  | 'TechLeadFailed'
  | 'TechLeadApproved'
  | 'TechLeadRejected'
  | 'EpicCreated'
  | 'EpicBranchCreated'
  | 'StoryCreated'
  | 'TeamCompositionDefined'
  | 'EnvironmentConfigDefined'

  // Developer events (ACTIVE)
  | 'DeveloperStarted'
  | 'StoryStarted'
  | 'StoryBranchCreated'
  | 'StoryCompleted'
  | 'StoryPushVerified'   // 🔥 NEW: Confirms branch actually exists on GitHub
  | 'StoryFailed'
  | 'DevelopersCompleted'
  | 'StorySessionCheckpoint'

  // PR events (ACTIVE)
  | 'PRCreated'
  | 'PRApprovalRequested'
  | 'PRApproved'
  | 'PRRejected'
  | 'PRMerged'

  // Auto-Merge events (ACTIVE)
  | 'AutoMergeStarted'
  | 'AutoMergeCompleted'
  | 'AutoMergeFailed'

  // Team/Developer events (ACTIVE - optimized phases)
  | 'TeamDevelopersCompleted'
  | 'TechLeadTeamCompleted'

  // ==== LEGACY EVENT TYPES (kept for backwards compatibility) ====
  // These are no longer created but may exist in the database
  | 'ProductManagerStarted'
  | 'ProductManagerCompleted'
  | 'ProductManagerFailed'
  | 'ProductManagerApproved'
  | 'ProductManagerRejected'
  | 'ProjectManagerStarted'
  | 'ProjectManagerCompleted'
  | 'ProjectManagerFailed'
  | 'ProjectManagerApproved'
  | 'ProjectManagerRejected'
  | 'QAStarted'
  | 'QACompleted'
  | 'QAFailed'
  | 'QAApproved'
  | 'QARejected'
  | 'MergeCoordinatorStarted'
  | 'MergeCoordinatorCompleted'
  | 'MergeCoordinatorFailed'
  | 'FixerStarted'
  | 'FixerCompleted'
  | 'FixerFailed'
  | 'TestCreatorStarted'
  | 'TestCreatorCompleted'
  | 'TestCreatorFailed'
  | 'ErrorDetectiveStarted'
  | 'ErrorDetectiveCompleted'
  | 'ErrorDetectiveFailed';

/**
 * Event - Immutable record of something that happened
 */
export interface IEvent extends Document {
  taskId: mongoose.Types.ObjectId;
  eventType: EventType;
  payload: any; // Event-specific data
  timestamp: Date;
  version: number; // Sequential version for ordering
  userId?: mongoose.Types.ObjectId; // Who triggered this (for approvals)
  agentName?: string; // Which agent emitted this
  metadata?: {
    cost?: number;
    duration?: number;
    error?: string;
    [key: string]: any; // Allow additional properties
  };
}

/**
 * Event Schema
 */
const eventSchema = new Schema<IEvent>(
  {
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      index: true, // Critical for performance
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    payload: {
      type: Schema.Types.Mixed,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      required: true,
    },
    version: {
      type: Number,
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    agentName: String,
    metadata: {
      cost: Number,
      duration: Number,
      error: String,
    },
  },
  {
    timestamps: false, // We use our own timestamp field
  }
);

// Compound index for efficient queries
eventSchema.index({ taskId: 1, version: 1 }, { unique: true });

// Prevent updates/deletes (append-only)
eventSchema.pre('updateOne', function (_next) {
  throw new Error('Events are immutable - updates not allowed');
});

eventSchema.pre('updateMany', function (_next) {
  throw new Error('Events are immutable - updates not allowed');
});

eventSchema.pre('deleteOne', function (_next) {
  throw new Error('Events are immutable - deletes not allowed');
});

eventSchema.pre('deleteMany', function (_next) {
  throw new Error('Events are immutable - deletes not allowed');
});

export const Event = mongoose.model<IEvent>('Event', eventSchema);
