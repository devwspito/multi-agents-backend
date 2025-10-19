import mongoose from 'mongoose';
import { Event, EventType, IEvent } from '../models/Event';

/**
 * EventCounter - Atomic counter for event versioning
 * Used to prevent duplicate version numbers in concurrent event writes
 */
const eventCounterSchema = new mongoose.Schema({
  taskId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  sequence: { type: Number, default: 0 }
});

// Only create model if it doesn't exist (prevents OverwriteModelError)
const EventCounter = mongoose.models.EventCounter || mongoose.model('EventCounter', eventCounterSchema);

/**
 * Task State - Reconstructed from events
 */
export interface TaskState {
  // Agent completion flags
  productManagerCompleted: boolean;
  productManagerApproved: boolean;
  projectManagerCompleted: boolean;
  projectManagerApproved: boolean;
  techLeadCompleted: boolean;
  techLeadApproved: boolean;
  branchSetupCompleted: boolean;
  developersCompleted: boolean;
  qaCompleted: boolean;
  qaApproved: boolean;
  prApproved: boolean;
  mergeCompleted: boolean;

  // Epics (reconstructed from EpicCreated events)
  epics: Array<{
    id: string;
    name: string;
    description: string;
    branchName: string;
    stories: string[]; // Story IDs
    branchesCreated: boolean;
    prCreated: boolean;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    targetRepository?: string;
  }>;

  // Stories (reconstructed from StoryCreated events)
  stories: Array<{
    id: string;
    epicId: string;
    title: string;
    description: string;
    assignedTo?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    priority: number;
    complexity: string;
    estimatedComplexity?: string;
    branchName?: string;
    filesToRead?: string[];
    filesToModify?: string[];
    filesToCreate?: string[];
    dependencies?: string[];
    completedBy?: string;
    completedAt?: Date;
    error?: string;
  }>;

  // Team composition
  teamComposition?: {
    developers: number;
    reasoning: string;
  };

  // Current phase
  currentPhase: string;

  // Agent outputs (for chat display)
  productManagerOutput?: string;
  projectManagerOutput?: string;
  techLeadOutput?: string;
  qaOutput?: string;

  // Costs
  totalCost: number;
}

/**
 * EventStore - Append-only event storage with state reconstruction
 */
export class EventStore {
  /**
   * Append a new event (guaranteed to succeed if DB is up)
   */
  async append(data: {
    taskId: mongoose.Types.ObjectId | string;
    eventType: EventType;
    payload: any;
    userId?: mongoose.Types.ObjectId | string;
    agentName?: string;
    metadata?: {
      cost?: number;
      duration?: number;
      error?: string;
    };
  }): Promise<IEvent> {
    const taskId = typeof data.taskId === 'string'
      ? new mongoose.Types.ObjectId(data.taskId)
      : data.taskId;

    // Get next version number
    const version = await this.getNextVersion(taskId);

    // Create event (atomic operation)
    const event = await Event.create({
      taskId,
      eventType: data.eventType,
      payload: data.payload,
      version,
      userId: data.userId,
      agentName: data.agentName,
      metadata: data.metadata,
      timestamp: new Date(),
    });

    console.log(`📝 [EventStore] Event ${version}: ${data.eventType}`);

    return event;
  }

  /**
   * Get next version number for a task (atomic using MongoDB counter)
   *
   * Uses findOneAndUpdate with $inc to guarantee atomic version increments
   * even when multiple teams write events concurrently
   */
  private async getNextVersion(taskId: mongoose.Types.ObjectId): Promise<number> {
    // Atomically increment and return new version
    const counter = await EventCounter.findOneAndUpdate(
      { taskId },
      { $inc: { sequence: 1 } },
      { new: true, upsert: true }
    );

    return counter!.sequence;
  }

  /**
   * Get all events for a task (ordered by version)
   */
  async getEvents(taskId: mongoose.Types.ObjectId | string): Promise<any[]> {
    const id = typeof taskId === 'string'
      ? new mongoose.Types.ObjectId(taskId)
      : taskId;

    return await Event.find({ taskId: id })
      .sort({ version: 1 })
      .lean();
  }

  /**
   * Get events since a specific version
   */
  async getEventsSince(
    taskId: mongoose.Types.ObjectId | string,
    sinceVersion: number
  ): Promise<any[]> {
    const id = typeof taskId === 'string'
      ? new mongoose.Types.ObjectId(taskId)
      : taskId;

    return await Event.find({
      taskId: id,
      version: { $gt: sinceVersion }
    })
      .sort({ version: 1 })
      .lean();
  }

  /**
   * Rebuild current state from all events
   */
  async getCurrentState(taskId: mongoose.Types.ObjectId | string): Promise<TaskState> {
    const events = await this.getEvents(taskId);
    return this.buildState(events);
  }

  /**
   * Build state from events (pure function - deterministic)
   */
  buildState(events: any[]): TaskState {
    const initialState: TaskState = {
      productManagerCompleted: false,
      productManagerApproved: false,
      projectManagerCompleted: false,
      projectManagerApproved: false,
      techLeadCompleted: false,
      techLeadApproved: false,
      branchSetupCompleted: false,
      developersCompleted: false,
      qaCompleted: false,
      qaApproved: false,
      prApproved: false,
      mergeCompleted: false,
      epics: [],
      stories: [],
      currentPhase: 'analysis',
      totalCost: 0,
    };

    return events.reduce((state, event) => {
      const { eventType, payload, metadata } = event;

      // Add cost
      if (metadata?.cost) {
        state.totalCost += metadata.cost;
      }

      switch (eventType) {
        // Product Manager
        case 'ProductManagerCompleted':
          state.productManagerCompleted = true;
          state.productManagerOutput = payload.output;
          state.currentPhase = 'planning';
          break;

        case 'ProductManagerApproved':
          state.productManagerApproved = true;
          break;

        case 'ProductManagerRejected':
          state.productManagerApproved = false;
          break;

        // Project Manager
        case 'ProjectManagerCompleted':
          state.projectManagerCompleted = true;
          state.projectManagerOutput = payload.output;
          break;

        case 'ProjectManagerApproved':
          state.projectManagerApproved = true;
          break;

        case 'ProjectManagerRejected':
          state.projectManagerApproved = false;
          break;

        // Tech Lead
        case 'TechLeadCompleted':
          state.techLeadCompleted = true;
          state.techLeadOutput = payload.output;
          state.currentPhase = 'architecture';
          break;

        case 'TechLeadApproved':
          state.techLeadApproved = true;
          break;

        case 'TechLeadRejected':
          state.techLeadApproved = false;
          break;

        case 'EpicCreated':
          state.epics.push({
            id: payload.id,
            name: payload.name,
            description: payload.description,
            branchName: payload.branchName,
            stories: payload.stories || [],
            status: 'pending', // Default status for epic
            branchesCreated: false,
            prCreated: false,
            targetRepository: payload.targetRepository,
          });
          break;

        case 'StoryCreated':
          state.stories.push({
            id: payload.id,
            epicId: payload.epicId,
            title: payload.title,
            description: payload.description,
            assignedTo: payload.assignedTo,
            status: 'pending',
            priority: payload.priority,
            complexity: payload.complexity || payload.estimatedComplexity, // Support both field names
            estimatedComplexity: payload.estimatedComplexity || payload.complexity,
            filesToRead: payload.filesToRead || [],
            filesToModify: payload.filesToModify || [],
            filesToCreate: payload.filesToCreate || [],
            dependencies: payload.dependencies || [],
          });
          break;

        case 'StoryBranchCreated':
          const storyWithBranch = state.stories.find((s: any) => s.id === payload.storyId);
          if (storyWithBranch) {
            storyWithBranch.branchName = payload.branchName;
          }
          break;

        case 'TeamCompositionDefined':
          state.teamComposition = payload;
          break;

        // Branch Setup (DEPRECATED - BranchSetupPhase removed)
        // case 'BranchPushed':
        //   const epic = state.epics.find((e: any) => e.id === payload.epicId);
        //   if (epic) {
        //     epic.branchesCreated = true;
        //   }
        //   break;

        // case 'BranchSetupCompleted':
        //   state.branchSetupCompleted = true;
        //   state.currentPhase = 'development';
        //   break;

        // Developers
        case 'StoryStarted':
          const story = state.stories.find((s: any) => s.id === payload.storyId);
          if (story) {
            story.status = 'in_progress';

            // Update epic status to in_progress if it's still pending
            const epicForStartedStory = state.epics.find((e: any) => e.id === story.epicId);
            if (epicForStartedStory && epicForStartedStory.status === 'pending') {
              epicForStartedStory.status = 'in_progress';
            }
          }
          break;

        case 'StoryCompleted':
          const completedStory = state.stories.find((s: any) => s.id === payload.storyId);
          if (completedStory) {
            completedStory.status = 'completed';

            // Update epic status based on story completion
            const epicForStory = state.epics.find((e: any) => e.id === completedStory.epicId);
            if (epicForStory) {
              const epicStories = state.stories.filter((s: any) => s.epicId === epicForStory.id);
              const allStoriesCompleted = epicStories.every((s: any) => s.status === 'completed');
              if (allStoriesCompleted) {
                epicForStory.status = 'completed';
              } else if (epicStories.some((s: any) => s.status === 'in_progress')) {
                epicForStory.status = 'in_progress';
              }
            }
          }
          break;

        case 'StoryFailed':
          const failedStory = state.stories.find((s: any) => s.id === payload.storyId);
          if (failedStory) {
            failedStory.status = 'failed';
          }
          break;

        case 'DevelopersCompleted':
          state.developersCompleted = true;
          state.currentPhase = 'qa';
          break;

        // QA
        case 'QACompleted':
          state.qaCompleted = true;
          state.qaOutput = payload.output;
          break;

        case 'QAApproved':
          state.qaApproved = true;
          break;

        case 'QARejected':
          state.qaApproved = false;
          break;

        // PR
        case 'PRCreated':
          const epicWithPR = state.epics.find((e: any) => e.id === payload.epicId);
          if (epicWithPR) {
            epicWithPR.prCreated = true;
            epicWithPR.pullRequestNumber = payload.prNumber;
            epicWithPR.pullRequestUrl = payload.prUrl;
          }
          break;

        case 'PRApproved':
          state.prApproved = true;
          state.currentPhase = 'merge';
          break;

        case 'PRRejected':
          state.prApproved = false;
          break;

        // Merge
        case 'MergeCoordinatorCompleted':
          state.mergeCompleted = true;
          state.currentPhase = 'completed';
          break;

        // Task lifecycle
        case 'TaskCompleted':
          state.currentPhase = 'completed';
          break;

        case 'TaskFailed':
          state.currentPhase = 'failed';
          break;
      }

      return state;
    }, initialState);
  }

  /**
   * Get event history for debugging
   */
  async getEventHistory(taskId: mongoose.Types.ObjectId | string): Promise<string[]> {
    const events = await this.getEvents(taskId);
    return events.map(e => `${e.version}: ${e.eventType} - ${JSON.stringify(e.payload).substring(0, 50)}`);
  }

  /**
   * Validate state integrity (for debugging)
   */
  async validateState(taskId: mongoose.Types.ObjectId | string): Promise<{
    valid: boolean;
    errors: string[];
  }> {
    const state = await this.getCurrentState(taskId);
    const errors: string[] = [];

    // Check if Tech Lead completed but no epics
    if (state.techLeadCompleted && state.epics.length === 0) {
      errors.push('Tech Lead completed but no EpicCreated events found');
    }

    // Check if epics have stories
    for (const epic of state.epics) {
      const epicStories = state.stories.filter((s: any) => s.epicId === epic.id);
      if (epic.stories.length > 0 && epicStories.length === 0) {
        errors.push(`Epic ${epic.id} references ${epic.stories.length} stories but no StoryCreated events found`);
      }
    }

    // Check phase progression
    // BranchSetup phase removed - no longer needed
    // if (state.developersCompleted && !state.branchSetupCompleted) {
    //   errors.push('Developers completed but BranchSetup never completed');
    // }

    if (state.qaCompleted && !state.developersCompleted) {
      errors.push('QA completed but Developers never completed');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Singleton instance
export const eventStore = new EventStore();
