import mongoose, { Document, Schema } from 'mongoose';

/**
 * Event Types - All possible events in the orchestration flow
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

  // Product Manager events
  | 'ProductManagerStarted'
  | 'ProductManagerCompleted'
  | 'ProductManagerFailed'
  | 'ProductManagerApproved'
  | 'ProductManagerRejected'

  // Project Manager events
  | 'ProjectManagerStarted'
  | 'ProjectManagerCompleted'
  | 'ProjectManagerFailed'
  | 'ProjectManagerApproved'
  | 'ProjectManagerRejected'

  // Tech Lead events
  | 'TechLeadStarted'
  | 'TechLeadCompleted'
  | 'TechLeadFailed'
  | 'TechLeadApproved'
  | 'TechLeadRejected'
  | 'EpicCreated'
  | 'StoryCreated'
  | 'TeamCompositionDefined'

  // Branch setup events (DEPRECATED - BranchSetupPhase removed, incompatible with IStory)
  // | 'BranchSetupStarted'
  // | 'BranchCreated'
  // | 'BranchPushed'
  // | 'BranchSetupCompleted'
  // | 'BranchSetupFailed'

  // Developer events
  | 'DeveloperStarted'
  | 'StoryStarted'
  | 'StoryCompleted'
  | 'StoryFailed'
  | 'DevelopersCompleted'

  // QA events
  | 'QAStarted'
  | 'QACompleted'
  | 'QAFailed'
  | 'QAApproved'
  | 'QARejected'

  // PR events
  | 'PRCreated'
  | 'PRApprovalRequested'
  | 'PRApproved'
  | 'PRRejected'
  | 'PRMerged'

  // Merge events
  | 'MergeCoordinatorStarted'
  | 'MergeCoordinatorCompleted'
  | 'MergeCoordinatorFailed';

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
