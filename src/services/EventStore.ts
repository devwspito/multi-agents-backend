import { execSync } from 'child_process';
import crypto from 'crypto';

// 🔥 SQLite is the SINGLE SOURCE OF TRUTH
import { EventRepository, EventType, IEvent } from '../database/repositories/EventRepository.js';
export { EventType, IEvent };

// ============================================================================
// 🔥🔥🔥 EVENT VALIDATION SCHEMAS - BULLETPROOF DATA INTEGRITY 🔥🔥🔥
// ============================================================================

/**
 * Required fields per event type
 * If an event doesn't have ALL required fields, it WILL NOT be stored
 */
const EVENT_REQUIRED_FIELDS: Record<string, string[]> = {
  // Epic events
  EpicCreated: ['id', 'name', 'targetRepository'],
  EpicBranchCreated: ['epicId', 'branchName'],

  // Story events
  StoryCreated: ['id', 'epicId', 'title', 'targetRepository'],
  StoryStarted: ['storyId'],
  StoryCompleted: ['storyId'],
  StoryFailed: ['storyId'],
  StoryBranchCreated: ['storyId', 'branchName'],
  StoryPushVerified: ['storyId', 'branchName'],

  // TechLead events
  TechLeadCompleted: ['epicId'],

  // PR events
  PRCreated: ['epicId', 'prNumber', 'prUrl'],

  // Team events
  TeamCompositionDefined: ['developers'],
};

/**
 * Generate checksum for payload
 */
function generateChecksum(payload: any): string {
  const str = JSON.stringify(payload, Object.keys(payload).sort());
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
}

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
    // 🔥 NEW: Per-epic TechLead tracking for resume/retry
    techLeadCompleted?: boolean;
    status?: 'pending' | 'in_progress' | 'completed';
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
    // 🔥 NEW: Workspace info for LivePreview
    workspacePath?: string;           // Full workspace path
    repoLocalPath?: string;           // Path to repo within workspace
  }>;

  // 🔥 NEW: All workspaces for LivePreview (multiple repos per task)
  workspaces?: Array<{
    workspacePath: string;
    repoLocalPath?: string;
    targetRepository: string;
    epicId: string;
    storyId?: string;
    storyTitle?: string;
    startedAt: Date;
  }>;

  // Team composition
  teamComposition?: {
    developers: number;
    reasoning: string;
  };

  // 🔥 NEW: Environment config (from TechLead - includes SDK/framework info)
  environmentConfig?: {
    [repoKey: string]: {
      language?: string;
      framework?: string;
      installCommand?: string;
      runCommand?: string;
      buildCommand?: string;
      testCommand?: string;
      lintCommand?: string;
      typecheckCommand?: string;
      requiredServices?: string[];
      rebuildCmd?: string; // 🔥 AGNOSTIC: Command to rebuild after code changes (for static builds)
    };
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
 * 🔥 SQLITE-ONLY ARCHITECTURE (No disk persistence):
 * - All events are saved DIRECTLY to SQLite via EventRepository
 * - SQLite is the SINGLE SOURCE OF TRUTH
 * - No local JSONL files, no MongoDB backup
 * - Simpler, more reliable, survives server restarts
 */
export class EventStore {
  // 🔥 REMOVED: getLocalEventsPath, getLocalVersionPath, appendToLocal, readFromLocal
  // All filesystem operations removed - SQLite is the only storage

  /**
   * Append a new event
   *
   * 🔥🔥🔥 BULLETPROOF EVENT STORAGE 🔥🔥🔥
   *
   * 1. VALIDATES all required fields per event type
   * 2. GENERATES checksum for integrity verification
   * 3. CHECKS for duplicate events (idempotency)
   * 4. NEVER fails silently - throws on validation errors
   */
  async append(data: {
    taskId: string;
    eventType: EventType;
    payload: any;
    userId?: string;
    agentName?: string;
    metadata?: {
      cost?: number;
      duration?: number;
      error?: string;
    };
  }): Promise<IEvent> {
    const taskIdStr = data.taskId.toString();

    // =========================================================================
    // 🔥 STEP 1: VALIDATE REQUIRED FIELDS
    // =========================================================================
    const requiredFields = EVENT_REQUIRED_FIELDS[data.eventType];
    if (requiredFields) {
      const missingFields: string[] = [];
      for (const field of requiredFields) {
        if (data.payload[field] === undefined || data.payload[field] === null) {
          missingFields.push(field);
        }
      }
      if (missingFields.length > 0) {
        const errorMsg = `🔥 [EventStore] VALIDATION ERROR: ${data.eventType} missing required fields: ${missingFields.join(', ')}`;
        console.error(errorMsg);
        console.error(`   Payload received:`, JSON.stringify(data.payload, null, 2));
        throw new Error(errorMsg);
      }
    }

    // =========================================================================
    // 🔥 STEP 2: VALIDATE taskId
    // =========================================================================
    if (!taskIdStr || taskIdStr === 'undefined' || taskIdStr === 'null') {
      throw new Error(`🔥 [EventStore] CRITICAL: Invalid taskId: ${taskIdStr}`);
    }

    // =========================================================================
    // 🔥 STEP 3: GENERATE CHECKSUM
    // =========================================================================
    const checksum = generateChecksum(data.payload);

    // =========================================================================
    // 🔥 STEP 4: CHECK FOR DUPLICATE EVENTS (Idempotency)
    // =========================================================================
    const recentEvents = EventRepository.findByTaskIdDesc(taskIdStr, 10);
    const isDuplicate = recentEvents.some(e =>
      e.eventType === data.eventType &&
      e.metadata?.checksum === checksum &&
      (Date.now() - new Date(e.timestamp).getTime()) < 5000 // Within 5 seconds
    );

    if (isDuplicate) {
      console.warn(`⚠️ [EventStore] Duplicate event detected, skipping: ${data.eventType}`);
      // Return the existing event instead of creating a new one
      const existing = recentEvents.find(e =>
        e.eventType === data.eventType && e.metadata?.checksum === checksum
      );
      return existing!;
    }

    // =========================================================================
    // 🔥 STEP 5: STORE EVENT WITH CHECKSUM
    // =========================================================================
    const event = EventRepository.append({
      taskId: taskIdStr,
      eventType: data.eventType,
      payload: data.payload,
      userId: data.userId,
      agentName: data.agentName,
      metadata: {
        ...data.metadata,
        checksum, // 🔥 Store checksum for integrity verification
      },
    });

    console.log(`💾 [EventStore] Saved event ${event.version}: ${data.eventType} [${checksum}]`);
    return event;
  }

  /**
   * Safe append - NEVER throws, returns null on failure
   *
   * Use this when you want the system to continue even if event storage fails.
   * The error is logged but not propagated.
   *
   * @returns The event if saved, or null if failed
   */
  async safeAppend(data: {
    taskId: string;
    eventType: EventType;
    payload: any;
    userId?: string;
    agentName?: string;
    metadata?: {
      cost?: number;
      duration?: number;
      error?: string;
    };
  }): Promise<IEvent | null> {
    try {
      return await this.append(data);
    } catch (error: any) {
      console.error(`\n🔥🔥🔥 [EventStore] SAFE APPEND FAILED 🔥🔥🔥`);
      console.error(`   Event Type: ${data.eventType}`);
      console.error(`   Task ID: ${data.taskId}`);
      console.error(`   Error: ${error.message}`);
      console.error(`   Payload:`, JSON.stringify(data.payload, null, 2));
      console.error(`   ⚠️ Event was NOT saved but system continues\n`);

      // Log to a diagnostic array for later retrieval
      if (!this._failedEvents) {
        this._failedEvents = [];
      }
      this._failedEvents.push({
        timestamp: new Date(),
        eventType: data.eventType,
        taskId: data.taskId,
        error: error.message,
        payload: data.payload,
      });

      // Keep only last 100 failed events in memory
      if (this._failedEvents.length > 100) {
        this._failedEvents = this._failedEvents.slice(-100);
      }

      return null;
    }
  }

  // Storage for failed events (for diagnostics)
  private _failedEvents: Array<{
    timestamp: Date;
    eventType: string;
    taskId: string;
    error: string;
    payload: any;
  }> = [];

  /**
   * Get failed events for diagnostics
   */
  getFailedEvents(): Array<{
    timestamp: Date;
    eventType: string;
    taskId: string;
    error: string;
    payload: any;
  }> {
    return [...this._failedEvents];
  }

  /**
   * Clear failed events log
   */
  clearFailedEvents(): void {
    this._failedEvents = [];
  }

  /**
   * Validate an event BEFORE attempting to append
   *
   * Use this for pre-flight checks when you want to verify
   * an event would be valid before building expensive payloads.
   *
   * @returns { valid: true } or { valid: false, errors: string[] }
   */
  validateEvent(data: {
    taskId: string;
    eventType: EventType;
    payload: any;
  }): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];

    // Check taskId
    const taskIdStr = data.taskId?.toString();
    if (!taskIdStr || taskIdStr === 'undefined' || taskIdStr === 'null') {
      errors.push(`Invalid taskId: ${data.taskId}`);
    }

    // Check required fields
    const requiredFields = EVENT_REQUIRED_FIELDS[data.eventType];
    if (requiredFields) {
      for (const field of requiredFields) {
        if (data.payload?.[field] === undefined || data.payload?.[field] === null) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true };
  }

  /**
   * Get all events for a task (ordered by version)
   * 🔥 Reads from SQLite (EventRepository)
   */
  async getEvents(taskId: string): Promise<IEvent[]> {
    const taskIdStr = taskId.toString();
    const events = EventRepository.findByTaskId(taskIdStr);

    if (events.length > 0) {
      console.log(`📂 [EventStore] Using ${events.length} events from SQLite`);
    }

    return events;
  }

  /**
   * Get events since a specific version
   * 🔥 Uses SQLite (EventRepository)
   */
  async getEventsSince(
    taskId: string,
    sinceVersion: number
  ): Promise<IEvent[]> {
    const taskIdStr = taskId.toString();
    // Use EventRepository.replay with fromVersion
    return EventRepository.replay(taskIdStr, sinceVersion);
  }

  /**
   * Rebuild current state from all events
   */
  async getCurrentState(taskId: string): Promise<TaskState> {
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
          // 🔥 NEW: Mark specific epic as techLeadCompleted for per-epic tracking
          if (payload.epicId) {
            const epicForTechLead = state.epics.find((e: any) => e.id === payload.epicId);
            if (epicForTechLead) {
              epicForTechLead.techLeadCompleted = true;
              console.log(`📝 [EventStore] Marked epic ${payload.epicId} techLeadCompleted=true`);
            }
          }
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
            techLeadCompleted: false, // 🔥 NEW: Per-epic TechLead tracking
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
            branchName: payload.branchName, // 🔥 CRITICAL: Branch assigned by TechLead
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

        // 🔥 NEW: Environment config from TechLead (SDK/framework info for LivePreview)
        case 'EnvironmentConfigDefined':
          state.environmentConfig = payload;
          console.log(`📝 [EventStore] Stored environmentConfig:`, Object.keys(payload));
          break;

        // Developers
        case 'StoryStarted':
          const story = state.stories.find((s: any) => s.id === payload.storyId);
          if (story) {
            story.status = 'in_progress';
            // 🔥 NEW: Store workspace info for LivePreview
            story.workspacePath = payload.workspacePath;
            story.repoLocalPath = payload.repoLocalPath;
            story.targetRepository = payload.targetRepository || story.targetRepository;
            story.branchName = payload.branchName || story.branchName;

            // Update epic status to in_progress if it's still pending
            const epicForStartedStory = state.epics.find((e: any) => e.id === story.epicId);
            if (epicForStartedStory && epicForStartedStory.status === 'pending') {
              epicForStartedStory.status = 'in_progress';
              // 🔥 NEW: Store workspace info on epic too
              if (payload.workspacePath && !epicForStartedStory.workspacePath) {
                epicForStartedStory.workspacePath = payload.workspacePath;
              }
            }
          }

          // 🔥 NEW: Track all workspaces for LivePreview
          if (payload.workspacePath) {
            if (!state.workspaces) {
              state.workspaces = [];
            }
            const existingWs = state.workspaces.find((w: any) =>
              w.targetRepository === payload.targetRepository
            );
            if (!existingWs) {
              state.workspaces.push({
                workspacePath: payload.workspacePath,
                repoLocalPath: payload.repoLocalPath,
                targetRepository: payload.targetRepository,
                epicId: payload.epicId,
                storyId: payload.storyId,
                storyTitle: payload.title,
                startedAt: event.timestamp,
              });
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
          // If push is verified, the story is definitively COMPLETED regardless of previous status
          const verifiedStory = state.stories.find((s: any) => s.id === payload.storyId);
          if (verifiedStory) {
            verifiedStory.pushVerified = true;
            verifiedStory.pushVerifiedAt = payload.verifiedAt || new Date();
            verifiedStory.commitSha = payload.commitSha;
            // 🔥 OVERRIDE: PushVerified means completed, even if previously marked failed
            verifiedStory.status = 'completed';
            console.log(`✅ [EventStore] Story ${payload.storyId} push VERIFIED on GitHub → status=completed`);
          }
          break;

        case 'StoryFailed':
          const failedStory = state.stories.find((s: any) => s.id === payload.storyId);
          if (failedStory) {
            // 🔥 CRITICAL: Don't mark as failed if push was already verified
            // PushVerified is definitive proof the code made it to GitHub
            if (!failedStory.pushVerified) {
              failedStory.status = 'failed';
              failedStory.error = payload.error;
            } else {
              console.log(`⚠️ [EventStore] Ignoring StoryFailed for ${payload.storyId} - already push-verified`);
            }
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
  async getEventHistory(taskId: string): Promise<string[]> {
    const events = await this.getEvents(taskId);
    return events.map(e => `${e.version}: ${e.eventType} - ${JSON.stringify(e.payload).substring(0, 50)}`);
  }

  /**
   * Validate state integrity (for debugging)
   */
  async validateState(taskId: string): Promise<{
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
  // 🔥 REMOVED: LOCAL BACKUP - SQLite is the SINGLE SOURCE OF TRUTH
  // ============================================================================
  // The following methods are kept as stubs for API compatibility but are no-ops:
  // - saveEventsToLocal
  // - loadEventsFromLocal
  // - pushEventsToGitHub
  // - backupEvents
  // - syncFromLocal
  // - getCurrentStateWithLocalFallback

  /**
   * 🔥 NO-OP: SQLite is the source of truth, no local backup needed
   */
  async saveEventsToLocal(
    _taskId: string,
    _workspacePath: string,
    _targetRepository: string
  ): Promise<{ success: boolean; filePath: string; eventsCount: number }> {
    // 🔥 NO-OP: SQLite is the source of truth
    console.log(`📦 [EventStore] saveEventsToLocal is NO-OP - SQLite is source of truth`);
    return { success: true, filePath: '', eventsCount: 0 };
  }

  /**
   * 🔥 NO-OP: SQLite is the source of truth
   */
  loadEventsFromLocal(
    _taskId: string,
    _workspacePath: string,
    _targetRepository: string
  ): any[] | null {
    // 🔥 NO-OP: SQLite is the source of truth
    console.log(`📦 [EventStore] loadEventsFromLocal is NO-OP - SQLite is source of truth`);
    return null;
  }

  /**
   * 🔥 NO-OP: No local files to push
   */
  async pushEventsToGitHub(
    _workspacePath: string,
    _targetRepository: string,
    _taskId: string
  ): Promise<boolean> {
    // 🔥 NO-OP: SQLite is the source of truth
    console.log(`📦 [EventStore] pushEventsToGitHub is NO-OP - SQLite is source of truth`);
    return true;
  }

  /**
   * 🔥 NO-OP: SQLite is the source of truth
   */
  async backupEvents(
    _taskId: string,
    _workspacePath: string,
    _targetRepository: string
  ): Promise<{ success: boolean; filePath: string; eventsCount: number }> {
    // 🔥 NO-OP: SQLite is the source of truth
    console.log(`📦 [EventStore] backupEvents is NO-OP - SQLite is source of truth`);
    return { success: true, filePath: '', eventsCount: 0 };
  }

  /**
   * 🔥 NO-OP: SQLite is the source of truth, no local files to sync
   */
  async syncFromLocal(
    _taskId: string,
    _workspacePath: string,
    _targetRepository: string
  ): Promise<{ success: boolean; eventsRestored: number; error?: string }> {
    // 🔥 NO-OP: SQLite is the source of truth
    console.log(`📦 [EventStore] syncFromLocal is NO-OP - SQLite is source of truth`);
    return { success: true, eventsRestored: 0 };
  }

  /**
   * 🔥 SIMPLIFIED: Just get state from SQLite (no local fallback needed)
   */
  async getCurrentStateWithLocalFallback(
    taskId: string,
    _workspacePath?: string,
    _targetRepository?: string
  ): Promise<TaskState> {
    // 🔥 SQLite is the SINGLE SOURCE OF TRUTH - just call getCurrentState
    return this.getCurrentState(taskId);
  }

  // ============================================================================
  // 🔥 PUSH VERIFICATION: Verify stories actually exist on GitHub
  // ============================================================================

  /**
   * Verify a story's branch exists on GitHub and emit StoryPushVerified event
   * This is the CRITICAL step to ensure Local state matches GitHub reality
   */
  async verifyStoryPush(params: {
    taskId: string;
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
      await this.safeAppend({
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
  async getUnverifiedStories(taskId: string): Promise<Array<{
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
    taskId: string;
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

  // ============================================================================
  // 🔥🔥🔥 INTEGRITY VERIFICATION - TRUST BUT VERIFY 🔥🔥🔥
  // ============================================================================

  /**
   * Verify integrity of ALL events for a task
   *
   * Checks:
   * 1. All events have valid checksums
   * 2. No missing version numbers
   * 3. All required fields are present
   * 4. Timestamps are in order
   *
   * @returns Integrity report with any issues found
   */
  async verifyIntegrity(taskId: string): Promise<{
    valid: boolean;
    eventsChecked: number;
    issues: Array<{
      eventId: string;
      version: number;
      eventType: string;
      issue: string;
    }>;
  }> {
    const events = await this.getEvents(taskId);
    const issues: Array<{
      eventId: string;
      version: number;
      eventType: string;
      issue: string;
    }> = [];

    let lastVersion = 0;
    let lastTimestamp = new Date(0);

    for (const event of events) {
      // Check version sequence
      if (event.version !== lastVersion + 1) {
        issues.push({
          eventId: event.id,
          version: event.version,
          eventType: event.eventType,
          issue: `Version gap: expected ${lastVersion + 1}, got ${event.version}`,
        });
      }
      lastVersion = event.version;

      // Check timestamp order
      if (event.timestamp < lastTimestamp) {
        issues.push({
          eventId: event.id,
          version: event.version,
          eventType: event.eventType,
          issue: `Timestamp out of order: ${event.timestamp} < ${lastTimestamp}`,
        });
      }
      lastTimestamp = event.timestamp;

      // Verify checksum if present
      if (event.metadata?.checksum) {
        const calculatedChecksum = generateChecksum(event.payload);
        if (calculatedChecksum !== event.metadata.checksum) {
          issues.push({
            eventId: event.id,
            version: event.version,
            eventType: event.eventType,
            issue: `Checksum mismatch: stored=${event.metadata.checksum}, calculated=${calculatedChecksum}`,
          });
        }
      }

      // Verify required fields
      const requiredFields = EVENT_REQUIRED_FIELDS[event.eventType];
      if (requiredFields) {
        for (const field of requiredFields) {
          if (event.payload[field] === undefined || event.payload[field] === null) {
            issues.push({
              eventId: event.id,
              version: event.version,
              eventType: event.eventType,
              issue: `Missing required field: ${field}`,
            });
          }
        }
      }
    }

    const valid = issues.length === 0;

    if (!valid) {
      console.error(`\n❌ [EventStore] INTEGRITY CHECK FAILED for task ${taskId}`);
      console.error(`   Events checked: ${events.length}`);
      console.error(`   Issues found: ${issues.length}`);
      for (const issue of issues.slice(0, 10)) {
        console.error(`   - v${issue.version} ${issue.eventType}: ${issue.issue}`);
      }
      if (issues.length > 10) {
        console.error(`   ... and ${issues.length - 10} more issues`);
      }
    } else {
      console.log(`✅ [EventStore] Integrity check PASSED for task ${taskId} (${events.length} events)`);
    }

    return {
      valid,
      eventsChecked: events.length,
      issues,
    };
  }

  /**
   * Get statistics about events for a task
   */
  async getStatistics(taskId: string): Promise<{
    totalEvents: number;
    eventsByType: Record<string, number>;
    firstEvent: Date | null;
    lastEvent: Date | null;
    totalCost: number;
    storiesCreated: number;
    storiesCompleted: number;
    storiesFailed: number;
    epicsCreated: number;
  }> {
    const events = await this.getEvents(taskId);
    const state = this.buildState(events);

    const eventsByType: Record<string, number> = {};
    let totalCost = 0;

    for (const event of events) {
      eventsByType[event.eventType] = (eventsByType[event.eventType] || 0) + 1;
      if (event.metadata?.cost) {
        totalCost += event.metadata.cost;
      }
    }

    return {
      totalEvents: events.length,
      eventsByType,
      firstEvent: events.length > 0 ? events[0].timestamp : null,
      lastEvent: events.length > 0 ? events[events.length - 1].timestamp : null,
      totalCost,
      storiesCreated: state.stories.length,
      storiesCompleted: state.stories.filter(s => s.status === 'completed').length,
      storiesFailed: state.stories.filter(s => s.status === 'failed').length,
      epicsCreated: state.epics.length,
    };
  }
}

// Singleton instance
export const eventStore = new EventStore();
