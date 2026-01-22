import mongoose from 'mongoose';
import { execSync } from 'child_process';
import { Event, EventType, IEvent } from '../models/Event';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteFileSync, isOk } from '../utils/robustness';

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
  // Agent completion flags (active phases)
  planningCompleted: boolean;
  planningApproved: boolean;
  techLeadCompleted: boolean;
  techLeadApproved: boolean;
  branchSetupCompleted: boolean;
  developersCompleted: boolean;
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
    targetRepository?: string; // 🔥 CRITICAL: Inherited from epic
    completedBy?: string;
    completedAt?: Date;
    error?: string;
    // 🔥 NEW: Push verification
    pushVerified?: boolean;           // True only after verifying branch exists on GitHub
    pushVerifiedAt?: Date;            // When push was verified
    commitSha?: string;               // SHA of the pushed commit
  }>;

  // Team composition
  teamComposition?: {
    developers: number;
    reasoning: string;
  };

  // Current phase
  currentPhase: string;

  // Agent outputs (for chat display)
  planningOutput?: string;
  techLeadOutput?: string;

  // Costs
  totalCost: number;
}

/**
 * EventStore - Append-only event storage with state reconstruction
 *
 * 🔥 LOCAL-FIRST ARCHITECTURE:
 * - All events are saved to LOCAL JSONL file FIRST (primary)
 * - MongoDB is used as BACKUP (secondary)
 * - This ensures events survive MongoDB crashes
 * - Events are synced from local to MongoDB on recovery
 */
export class EventStore {
  /**
   * Get local events file path for a task
   * Location: {workspaceDir}/task-{taskId}/.agent-memory/events.jsonl
   */
  private getLocalEventsPath(taskId: string): string {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanTaskId = taskId.toString().replace(/^task-/, '');
    return path.join(workspaceDir, `task-${cleanTaskId}`, '.agent-memory', 'events.jsonl');
  }

  /**
   * Get local version counter path
   */
  private getLocalVersionPath(taskId: string): string {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanTaskId = taskId.toString().replace(/^task-/, '');
    return path.join(workspaceDir, `task-${cleanTaskId}`, '.agent-memory', 'event-version.json');
  }

  /**
   * Append event to local JSONL file
   * Returns the version number used
   *
   * 🔒 ROBUSTNESS: Uses atomic writes for version counter to prevent race conditions
   */
  private appendToLocal(taskId: string, event: any): number {
    const lockPath = this.getLocalVersionPath(taskId) + '.lock';

    try {
      const eventsPath = this.getLocalEventsPath(taskId);
      const versionPath = this.getLocalVersionPath(taskId);
      const dir = path.dirname(eventsPath);

      // Ensure directory exists
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // 🔒 ATOMIC VERSION INCREMENT with simple file lock
      // This prevents race conditions when multiple processes write events
      let version = 1;
      const maxRetries = 10;
      let lockAcquired = false;

      for (let retry = 0; retry < maxRetries; retry++) {
        try {
          // Try to acquire lock (atomic create)
          fs.writeFileSync(lockPath, process.pid.toString(), { flag: 'wx' });
          lockAcquired = true;
          break;
        } catch {
          // Lock exists, wait a bit and retry
          const waitMs = Math.floor(Math.random() * 50) + 10;
          const start = Date.now();
          while (Date.now() - start < waitMs) {
            // Busy wait (short duration)
          }
        }
      }

      // Read current version
      if (fs.existsSync(versionPath)) {
        try {
          const versionData = JSON.parse(fs.readFileSync(versionPath, 'utf8'));
          version = (versionData.sequence || 0) + 1;
        } catch (e) {
          // File corrupted, try to recover from events
          const events = this.readFromLocal(taskId);
          version = events.length > 0 ? Math.max(...events.map(e => e.version || 0)) + 1 : 1;
          console.warn(`⚠️ [EventStore] Version file corrupted, recovered version: ${version}`);
        }
      }

      // 🔒 ATOMIC WRITE: Save version counter atomically
      const versionContent = JSON.stringify({ sequence: version, lastUpdated: Date.now(), pid: process.pid });
      const writeResult = atomicWriteFileSync(versionPath, versionContent);
      if (!isOk(writeResult)) {
        // Fallback to direct write
        fs.writeFileSync(versionPath, versionContent, 'utf8');
      }

      // Release lock
      if (lockAcquired) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore lock cleanup errors
        }
      }

      // Append event to JSONL
      const eventWithVersion = { ...event, version, savedAt: new Date().toISOString() };
      fs.appendFileSync(eventsPath, JSON.stringify(eventWithVersion) + '\n', 'utf8');

      return version;
    } catch (error: any) {
      console.error(`❌ [EventStore] Failed to save to local: ${error.message}`);
      throw error; // Local is primary, so this is critical
    }
  }

  /**
   * Read events from local JSONL file
   *
   * 🔒 ROBUSTNESS: Reports corrupted lines and attempts to salvage valid events
   */
  private readFromLocal(taskId: string): any[] {
    try {
      const eventsPath = this.getLocalEventsPath(taskId);
      if (!fs.existsSync(eventsPath)) {
        return [];
      }

      const content = fs.readFileSync(eventsPath, 'utf8');
      const lines = content.split('\n').filter(line => line.trim());
      const events: any[] = [];
      const corruptedLines: number[] = [];

      lines.forEach((line, index) => {
        try {
          const event = JSON.parse(line);
          events.push(event);
        } catch (e) {
          corruptedLines.push(index + 1);
        }
      });

      // Report corrupted lines
      if (corruptedLines.length > 0) {
        console.warn(
          `⚠️ [EventStore] Task ${taskId}: ${corruptedLines.length} corrupted event lines (lines: ${corruptedLines.slice(0, 5).join(', ')}${corruptedLines.length > 5 ? '...' : ''})`
        );

        // If more than 10% corrupted, this is serious
        const corruptionRate = corruptedLines.length / lines.length;
        if (corruptionRate > 0.1) {
          console.error(
            `❌ [EventStore] CRITICAL: ${(corruptionRate * 100).toFixed(1)}% of events corrupted for task ${taskId}`
          );
        }
      }

      // Sort by version
      events.sort((a, b) => (a.version || 0) - (b.version || 0));

      return events;
    } catch (error: any) {
      console.warn(`⚠️ [EventStore] Failed to read local events: ${error.message}`);
      return [];
    }
  }

  /**
   * Append a new event
   * 🔥 LOCAL-FIRST: Saves to local file FIRST, then MongoDB as backup
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
    const taskIdStr = data.taskId.toString();
    const taskId = typeof data.taskId === 'string'
      ? new mongoose.Types.ObjectId(data.taskId)
      : data.taskId;

    // 1️⃣ SAVE TO LOCAL FIRST (primary)
    const eventData = {
      taskId: taskIdStr,
      eventType: data.eventType,
      payload: data.payload,
      userId: data.userId?.toString(),
      agentName: data.agentName,
      metadata: data.metadata,
      timestamp: new Date().toISOString(),
    };

    const localVersion = this.appendToLocal(taskIdStr, eventData);
    console.log(`💾 [EventStore] Saved to local: Event ${localVersion}: ${data.eventType}`);

    // 2️⃣ BACKUP TO MONGODB (secondary, non-blocking)
    let mongoEvent: IEvent | null = null;
    try {
      // Get next version number from MongoDB (may differ from local if out of sync)
      const mongoVersion = await this.getNextVersion(taskId);

      // Create event in MongoDB
      mongoEvent = await Event.create({
        taskId,
        eventType: data.eventType,
        payload: data.payload,
        version: mongoVersion,
        userId: data.userId,
        agentName: data.agentName,
        metadata: data.metadata,
        timestamp: new Date(),
      });

      console.log(`☁️ [EventStore] Backed up to MongoDB: Event ${mongoVersion}: ${data.eventType}`);
    } catch (mongoError: any) {
      console.warn(`⚠️ [EventStore] MongoDB backup failed (non-critical): ${mongoError.message}`);
      // Don't throw - local is primary, MongoDB is just backup
    }

    // Return a pseudo-event object if MongoDB failed
    if (!mongoEvent) {
      return {
        _id: new mongoose.Types.ObjectId(),
        taskId,
        eventType: data.eventType,
        payload: data.payload,
        version: localVersion,
        userId: data.userId,
        agentName: data.agentName,
        metadata: data.metadata,
        timestamp: new Date(),
      } as IEvent;
    }

    return mongoEvent;
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
   * 🔥 LOCAL-FIRST: Reads from LOCAL first (primary), MongoDB as backup
   * LOCAL -> MongoDB, NEVER MongoDB -> LOCAL
   */
  async getEvents(taskId: mongoose.Types.ObjectId | string): Promise<any[]> {
    const taskIdStr = taskId.toString();
    const id = typeof taskId === 'string'
      ? new mongoose.Types.ObjectId(taskId)
      : taskId;

    // 1️⃣ LOCAL FIRST (primary source of truth)
    const localEvents = this.readFromLocal(taskIdStr);

    // 2️⃣ If local has events, use them as primary
    if (localEvents.length > 0) {
      console.log(`📂 [EventStore] Using ${localEvents.length} events from LOCAL (primary)`);

      // 3️⃣ Optionally check MongoDB for any events we might have missed during recovery
      // (e.g., events from another server instance)
      try {
        const mongoEvents = await Event.find({ taskId: id })
          .sort({ version: 1 })
          .lean();

        if (mongoEvents.length > localEvents.length) {
          // MongoDB has more events - merge them (rare case: another instance wrote)
          console.log(`🔄 [EventStore] MongoDB has ${mongoEvents.length - localEvents.length} extra events, merging...`);
          const localVersions = new Set(localEvents.map(e => e.version));
          const mongoOnlyEvents = mongoEvents.filter(e => !localVersions.has(e.version));
          if (mongoOnlyEvents.length > 0) {
            console.log(`   Adding ${mongoOnlyEvents.length} MongoDB-only events to result`);
            return [...localEvents, ...mongoOnlyEvents].sort((a, b) => (a.version || 0) - (b.version || 0));
          }
        }
      } catch (mongoError: any) {
        // MongoDB failed - that's OK, we have local data
        console.warn(`⚠️ [EventStore] MongoDB read failed (using local): ${mongoError.message}`);
      }

      return localEvents;
    }

    // 4️⃣ LOCAL is empty - try MongoDB as fallback (recovery scenario)
    console.log(`📂 [EventStore] LOCAL is empty, checking MongoDB as fallback...`);
    try {
      const mongoEvents = await Event.find({ taskId: id })
        .sort({ version: 1 })
        .lean();

      if (mongoEvents.length > 0) {
        console.log(`☁️ [EventStore] Found ${mongoEvents.length} events in MongoDB (recovery mode)`);
        return mongoEvents;
      }
    } catch (mongoError: any) {
      console.warn(`⚠️ [EventStore] MongoDB fallback failed: ${mongoError.message}`);
    }

    // 5️⃣ Both empty - return empty array
    return [];
  }

  /**
   * Get events since a specific version
   * 🔥 LOCAL-FIRST: Same pattern as getEvents()
   */
  async getEventsSince(
    taskId: mongoose.Types.ObjectId | string,
    sinceVersion: number
  ): Promise<any[]> {
    const taskIdStr = taskId.toString();

    // 1️⃣ LOCAL FIRST
    const localEvents = this.readFromLocal(taskIdStr);
    const filteredLocal = localEvents.filter(e => (e.version || 0) > sinceVersion);

    if (filteredLocal.length > 0) {
      return filteredLocal;
    }

    // 2️⃣ Fallback to MongoDB only if local is empty
    const id = typeof taskId === 'string'
      ? new mongoose.Types.ObjectId(taskId)
      : taskId;

    try {
      return await Event.find({
        taskId: id,
        version: { $gt: sinceVersion }
      })
        .sort({ version: 1 })
        .lean();
    } catch (mongoError: any) {
      console.warn(`⚠️ [EventStore] MongoDB getEventsSince failed: ${mongoError.message}`);
      return [];
    }
  }

  /**
   * 🔥 Sync local events to MongoDB
   * Call this when MongoDB comes back online after a crash
   */
  async syncLocalToMongoDB(taskId: mongoose.Types.ObjectId | string): Promise<{ synced: number; skipped: number }> {
    const taskIdStr = taskId.toString();
    const id = typeof taskId === 'string'
      ? new mongoose.Types.ObjectId(taskId)
      : taskId;

    const localEvents = this.readFromLocal(taskIdStr);
    if (localEvents.length === 0) {
      return { synced: 0, skipped: 0 };
    }

    // Get existing MongoDB events
    let mongoEvents: any[] = [];
    try {
      mongoEvents = await Event.find({ taskId: id }).lean();
    } catch (e) {
      console.error(`❌ [EventStore] Cannot sync - MongoDB unavailable`);
      return { synced: 0, skipped: localEvents.length };
    }

    const mongoEventKeys = new Set(mongoEvents.map(e => `${e.eventType}-${e.payload?.storyId || ''}-${e.payload?.epicId || ''}`));

    let synced = 0;
    let skipped = 0;

    for (const localEvent of localEvents) {
      const key = `${localEvent.eventType}-${localEvent.payload?.storyId || ''}-${localEvent.payload?.epicId || ''}`;
      if (mongoEventKeys.has(key)) {
        skipped++;
        continue;
      }

      try {
        await Event.create({
          taskId: id,
          eventType: localEvent.eventType,
          payload: localEvent.payload,
          version: localEvent.version,
          userId: localEvent.userId ? new mongoose.Types.ObjectId(localEvent.userId) : undefined,
          agentName: localEvent.agentName,
          metadata: localEvent.metadata,
          timestamp: new Date(localEvent.timestamp),
        });
        synced++;
      } catch (e) {
        // Duplicate or error, skip
        skipped++;
      }
    }

    console.log(`🔄 [EventStore] Synced ${synced} events from local to MongoDB (${skipped} skipped)`);
    return { synced, skipped };
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
      planningCompleted: false,
      planningApproved: false,
      techLeadCompleted: false,
      techLeadApproved: false,
      branchSetupCompleted: false,
      developersCompleted: false,
      prApproved: false,
      mergeCompleted: false,
      epics: [],
      stories: [],
      currentPhase: 'planning',
      totalCost: 0,
    };

    return events.reduce((state, event) => {
      const { eventType, payload, metadata } = event;

      // Add cost
      if (metadata?.cost) {
        state.totalCost += metadata.cost;
      }

      switch (eventType) {
        // Planning (new unified phase)
        case 'PlanningCompleted':
          state.planningCompleted = true;
          state.planningOutput = payload.output;
          state.currentPhase = 'planning';
          break;

        case 'PlanningApproved':
          state.planningApproved = true;
          break;

        case 'PlanningRejected':
          state.planningApproved = false;
          break;

        // Legacy ProductManager/ProjectManager events → map to planning
        case 'ProductManagerCompleted':
        case 'ProjectManagerCompleted':
          state.planningCompleted = true;
          state.planningOutput = payload.output;
          state.currentPhase = 'planning';
          break;

        case 'ProductManagerApproved':
        case 'ProjectManagerApproved':
          state.planningApproved = true;
          break;

        case 'ProductManagerRejected':
        case 'ProjectManagerRejected':
          state.planningApproved = false;
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
          // 🔥 CRITICAL VALIDATION: targetRepository MUST exist
          if (!payload.targetRepository) {
            console.error(`\n❌❌❌ [EventStore] CRITICAL ERROR: EpicCreated event missing targetRepository!`);
            console.error(`   Epic ID: ${payload.id}`);
            console.error(`   Epic Name: ${payload.name}`);
            console.error(`   Branch: ${payload.branchName}`);
            console.error(`   Event payload:`, JSON.stringify(payload, null, 2));
            console.error(`   🔥 THIS IS A DATA INTEGRITY VIOLATION`);
            console.error(`   🔥 ALL EPICS MUST HAVE targetRepository ASSIGNED BY TECHLEAD/PROJECTMANAGER`);
            throw new Error(`CRITICAL: EpicCreated event for ${payload.id} has no targetRepository - stopping server to prevent catastrophic failure`);
          }

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
          // 🔥 CRITICAL VALIDATION: targetRepository MUST exist
          if (!payload.targetRepository) {
            console.error(`\n❌❌❌ [EventStore] CRITICAL ERROR: StoryCreated event missing targetRepository!`);
            console.error(`   Story ID: ${payload.id}`);
            console.error(`   Epic ID: ${payload.epicId}`);
            console.error(`   Title: ${payload.title}`);
            console.error(`   Event payload:`, JSON.stringify(payload, null, 2));
            console.error(`   🔥 THIS IS A DATA INTEGRITY VIOLATION`);
            console.error(`   🔥 ALL STORIES MUST HAVE targetRepository ASSIGNED BY TECHLEAD`);
            throw new Error(`CRITICAL: StoryCreated event for ${payload.id} has no targetRepository - stopping server to prevent catastrophic failure`);
          }

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
            targetRepository: payload.targetRepository, // 🔥 CRITICAL: Inherit from epic
          });
          break;

        case 'StoryBranchCreated':
          const storyWithBranch = state.stories.find((s: any) => s.id === payload.storyId);
          if (storyWithBranch) {
            storyWithBranch.branchName = payload.branchName;
          }
          break;

        case 'EpicBranchCreated':
          // Update epic with the actual branch name created by TeamOrchestrationPhase
          const epicWithBranch = state.epics.find((e: any) => e.id === payload.epicId);
          if (epicWithBranch) {
            epicWithBranch.branchName = payload.branchName;
            console.log(`📝 [EventStore] Updated epic ${payload.epicId} with branch: ${payload.branchName}`);
          }
          break;

        case 'TeamCompositionDefined':
          state.teamComposition = payload;
          break;

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

        case 'StoryPushVerified':
          // 🔥 CRITICAL: This confirms the branch actually exists on GitHub
          const verifiedStory = state.stories.find((s: any) => s.id === payload.storyId);
          if (verifiedStory) {
            verifiedStory.pushVerified = true;
            verifiedStory.pushVerifiedAt = payload.verifiedAt || new Date();
            verifiedStory.commitSha = payload.commitSha;
            console.log(`✅ [EventStore] Story ${payload.storyId} push VERIFIED on GitHub`);
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
          state.currentPhase = 'merge';
          break;

        // Legacy QA events (no longer active, but kept for reading old events)
        case 'QACompleted':
        case 'QAApproved':
        case 'QARejected':
          // Legacy events - ignored in new state
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
    if (state.mergeCompleted && !state.developersCompleted) {
      errors.push('Merge completed but Developers never completed');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // ============================================================================
  // 📦 LOCAL BACKUP - Save events to local file system
  // ============================================================================

  private static readonly EVENTS_DIR = '.agents/events';

  /**
   * Save all events for a task to a local file
   * Called after each phase to maintain a local backup of MongoDB events
   * Format: JSONL (one JSON object per line) for easy append and read
   */
  async saveEventsToLocal(
    taskId: mongoose.Types.ObjectId | string,
    workspacePath: string,
    targetRepository: string
  ): Promise<{ success: boolean; filePath: string; eventsCount: number }> {
    try {
      const events = await this.getEvents(taskId);

      if (events.length === 0) {
        return { success: true, filePath: '', eventsCount: 0 };
      }

      // Build paths
      const repoPath = path.join(workspacePath, targetRepository);
      const eventsDir = path.join(repoPath, EventStore.EVENTS_DIR);
      const taskIdStr = typeof taskId === 'string' ? taskId : taskId.toString();
      const filePath = path.join(eventsDir, `task-${taskIdStr}-events.jsonl`);

      // Ensure directory exists
      if (!fs.existsSync(eventsDir)) {
        fs.mkdirSync(eventsDir, { recursive: true });
      }

      // Convert events to JSONL format
      const jsonlContent = events.map(event => JSON.stringify({
        version: event.version,
        eventType: event.eventType,
        payload: event.payload,
        agentName: event.agentName,
        metadata: event.metadata,
        timestamp: event.timestamp,
      })).join('\n');

      // Write to file (overwrite to ensure consistency)
      fs.writeFileSync(filePath, jsonlContent, 'utf8');

      console.log(`📦 [EventStore] Saved ${events.length} events to local: ${filePath}`);

      return { success: true, filePath, eventsCount: events.length };
    } catch (error: any) {
      console.warn(`⚠️ [EventStore] Failed to save events to local: ${error.message}`);
      return { success: false, filePath: '', eventsCount: 0 };
    }
  }

  /**
   * Load events from local file (for recovery)
   * Returns events in chronological order
   */
  loadEventsFromLocal(
    taskId: string,
    workspacePath: string,
    targetRepository: string
  ): any[] | null {
    try {
      const repoPath = path.join(workspacePath, targetRepository);
      const filePath = path.join(repoPath, EventStore.EVENTS_DIR, `task-${taskId}-events.jsonl`);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const events = content.split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => JSON.parse(line));

      console.log(`📦 [EventStore] Loaded ${events.length} events from local`);
      return events;
    } catch (error: any) {
      console.warn(`⚠️ [EventStore] Failed to load events from local: ${error.message}`);
      return null;
    }
  }

  /**
   * Push events file to GitHub
   * Called after saving events to local
   */
  async pushEventsToGitHub(
    workspacePath: string,
    targetRepository: string,
    taskId: string
  ): Promise<boolean> {
    try {
      const { execSync } = require('child_process');
      const repoPath = path.join(workspacePath, targetRepository);
      const filePath = path.join(repoPath, EventStore.EVENTS_DIR, `task-${taskId}-events.jsonl`);

      if (!fs.existsSync(filePath)) {
        return false;
      }

      // Git add, commit, push (generous timeouts for large projects)
      execSync(`git add "${filePath}"`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 120000 }); // 2 min

      const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8', timeout: 120000 }); // 2 min
      if (status.trim().length > 0) {
        execSync(`git commit -m "[EventStore] Backup events for task ${taskId}"`, {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 300000 // 5 min for hooks
        });

        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: 30000 // 30 sec
        }).trim();

        execSync(`git push origin ${currentBranch}`, {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 600000 // 10 min for large repos
        });

        console.log(`📦 [EventStore] Events pushed to GitHub`);
      }

      return true;
    } catch (error: any) {
      console.warn(`⚠️ [EventStore] Failed to push events to GitHub: ${error.message}`);
      return false;
    }
  }

  /**
   * Full backup: Save to local + push to GitHub
   * Convenience method that does both operations
   */
  async backupEvents(
    taskId: mongoose.Types.ObjectId | string,
    workspacePath: string,
    targetRepository: string
  ): Promise<{ success: boolean; filePath: string; eventsCount: number }> {
    const taskIdStr = typeof taskId === 'string' ? taskId : taskId.toString();

    // Save to local
    const result = await this.saveEventsToLocal(taskId, workspacePath, targetRepository);

    if (result.success && result.eventsCount > 0) {
      // Push to GitHub (non-blocking failure)
      await this.pushEventsToGitHub(workspacePath, targetRepository, taskIdStr);
    }

    return result;
  }

  // ============================================================================
  // 🔄 RECOVERY: Restore events from Local to MongoDB
  // ============================================================================

  /**
   * Sync events from local file to MongoDB
   * Used for recovery when MongoDB is empty but Local has events
   *
   * @returns Number of events restored, or -1 if local file not found
   */
  async syncFromLocal(
    taskId: string,
    workspacePath: string,
    targetRepository: string
  ): Promise<{ success: boolean; eventsRestored: number; error?: string }> {
    try {
      console.log(`🔄 [EventStore] Attempting to sync events from Local to MongoDB for task ${taskId}`);

      // Check if MongoDB already has events
      const existingEvents = await this.getEvents(taskId);
      if (existingEvents.length > 0) {
        console.log(`✅ [EventStore] MongoDB already has ${existingEvents.length} events, skipping sync`);
        return { success: true, eventsRestored: 0 };
      }

      // Load events from local
      const localEvents = this.loadEventsFromLocal(taskId, workspacePath, targetRepository);
      if (!localEvents || localEvents.length === 0) {
        console.log(`⚠️ [EventStore] No local events found for task ${taskId}`);
        return { success: false, eventsRestored: -1, error: 'No local events found' };
      }

      console.log(`📦 [EventStore] Found ${localEvents.length} events in local, restoring to MongoDB...`);

      // Restore each event to MongoDB
      let restored = 0;
      for (const event of localEvents) {
        try {
          await this.append({
            taskId,
            eventType: event.eventType,
            payload: event.payload,
            agentName: event.agentName,
            metadata: event.metadata,
          });
          restored++;
        } catch (err: any) {
          console.warn(`⚠️ [EventStore] Failed to restore event ${event.eventType}: ${err.message}`);
        }
      }

      console.log(`✅ [EventStore] Restored ${restored}/${localEvents.length} events from Local to MongoDB`);
      return { success: true, eventsRestored: restored };

    } catch (error: any) {
      console.error(`❌ [EventStore] syncFromLocal failed: ${error.message}`);
      return { success: false, eventsRestored: 0, error: error.message };
    }
  }

  /**
   * Get state with Local fallback
   * First tries MongoDB, if empty tries to sync from Local
   */
  async getCurrentStateWithLocalFallback(
    taskId: string,
    workspacePath?: string,
    targetRepository?: string
  ): Promise<TaskState> {
    // First try MongoDB
    const mongoEvents = await this.getEvents(taskId);

    if (mongoEvents.length > 0) {
      return this.buildState(mongoEvents);
    }

    // MongoDB empty - try Local fallback if workspace info provided
    if (workspacePath && targetRepository) {
      console.log(`⚠️ [EventStore] MongoDB empty for task ${taskId}, trying Local fallback...`);

      const syncResult = await this.syncFromLocal(taskId, workspacePath, targetRepository);

      if (syncResult.success && syncResult.eventsRestored > 0) {
        // Re-fetch from MongoDB after sync
        const restoredEvents = await this.getEvents(taskId);
        return this.buildState(restoredEvents);
      }
    }

    // No events found anywhere - return initial state
    console.log(`⚠️ [EventStore] No events found for task ${taskId} in MongoDB or Local`);
    return this.buildState([]);
  }

  // ============================================================================
  // 🔥 PUSH VERIFICATION: Verify stories actually exist on GitHub
  // ============================================================================

  /**
   * Verify a story's branch exists on GitHub and emit StoryPushVerified event
   * This is the CRITICAL step to ensure Local state matches GitHub reality
   */
  async verifyStoryPush(params: {
    taskId: mongoose.Types.ObjectId | string;
    storyId: string;
    branchName: string;
    repoPath: string;
  }): Promise<{ verified: boolean; commitSha?: string; error?: string }> {
    const { taskId, storyId, branchName, repoPath } = params;

    try {
      // Check if branch exists on remote
      const lsRemoteOutput = execSync(
        `git ls-remote --heads origin ${branchName}`,
        { cwd: repoPath, encoding: 'utf8', timeout: 30000 }
      );

      if (!lsRemoteOutput || lsRemoteOutput.trim().length === 0) {
        console.error(`❌ [EventStore] Story ${storyId} branch NOT found on GitHub: ${branchName}`);
        return { verified: false, error: `Branch ${branchName} not found on remote` };
      }

      // Extract commit SHA from ls-remote output
      const commitSha = lsRemoteOutput.split('\t')[0]?.trim();

      // Emit StoryPushVerified event
      await this.append({
        taskId,
        eventType: 'StoryPushVerified',
        payload: {
          storyId,
          branchName,
          commitSha,
          verifiedAt: new Date(),
        },
        agentName: 'EventStore',
      });

      console.log(`✅ [EventStore] Story ${storyId} push VERIFIED: ${branchName} (${commitSha?.substring(0, 7)})`);
      return { verified: true, commitSha };

    } catch (error: any) {
      console.error(`❌ [EventStore] Failed to verify push for story ${storyId}: ${error.message}`);
      return { verified: false, error: error.message };
    }
  }

  /**
   * Get all stories that are marked completed but NOT push-verified
   * These are potential "lost" stories that never made it to GitHub
   */
  async getUnverifiedStories(taskId: mongoose.Types.ObjectId | string): Promise<Array<{
    storyId: string;
    branchName?: string;
    status: string;
  }>> {
    const state = await this.getCurrentState(taskId);

    return state.stories
      .filter((s: any) => s.status === 'completed' && !s.pushVerified)
      .map((s: any) => ({
        storyId: s.id,
        branchName: s.branchName,
        status: s.status,
      }));
  }

  /**
   * Verify all completed stories in a task against GitHub
   * Returns summary of verification results
   */
  async verifyAllPushes(params: {
    taskId: mongoose.Types.ObjectId | string;
    repoPath: string;
  }): Promise<{
    total: number;
    verified: number;
    failed: number;
    alreadyVerified: number;
    failures: Array<{ storyId: string; branchName?: string; error: string }>;
  }> {
    const { taskId, repoPath } = params;
    const state = await this.getCurrentState(taskId);

    const completedStories = state.stories.filter((s: any) => s.status === 'completed');
    const results = {
      total: completedStories.length,
      verified: 0,
      failed: 0,
      alreadyVerified: 0,
      failures: [] as Array<{ storyId: string; branchName?: string; error: string }>,
    };

    console.log(`\n🔍 [EventStore] Verifying ${completedStories.length} completed stories against GitHub...`);

    for (const story of completedStories) {
      // Skip if already verified
      if (story.pushVerified) {
        results.alreadyVerified++;
        continue;
      }

      // Skip if no branch name
      if (!story.branchName) {
        results.failed++;
        results.failures.push({
          storyId: story.id,
          branchName: undefined,
          error: 'No branch name defined',
        });
        continue;
      }

      // Verify push
      const verifyResult = await this.verifyStoryPush({
        taskId,
        storyId: story.id,
        branchName: story.branchName,
        repoPath,
      });

      if (verifyResult.verified) {
        results.verified++;
      } else {
        results.failed++;
        results.failures.push({
          storyId: story.id,
          branchName: story.branchName,
          error: verifyResult.error || 'Unknown error',
        });
      }
    }

    console.log(`\n📊 [EventStore] Verification Summary:`);
    console.log(`   Total: ${results.total}`);
    console.log(`   Already Verified: ${results.alreadyVerified}`);
    console.log(`   Newly Verified: ${results.verified}`);
    console.log(`   Failed: ${results.failed}`);

    if (results.failures.length > 0) {
      console.log(`\n⚠️ Failed stories (NOT on GitHub):`);
      for (const failure of results.failures) {
        console.log(`   - ${failure.storyId}: ${failure.branchName || 'no branch'} - ${failure.error}`);
      }
    }

    return results;
  }
}

// Singleton instance
export const eventStore = new EventStore();
