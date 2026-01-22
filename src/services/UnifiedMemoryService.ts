/**
 * UnifiedMemoryService - Unified interface for agent memory
 *
 * Delegates all operations to GranularMemoryService which uses local file storage.
 * Provides in-memory execution tracking for orchestration phases.
 */

import { granularMemoryService, GranularMemory, GranularMemoryType } from './GranularMemoryService';

/**
 * Execution map for tracking agent progress
 */
export interface ExecutionMap {
  taskId: string;
  status?: 'in_progress' | 'completed' | 'failed';
  phases: Map<string, PhaseExecution>;
  stories: Map<string, StoryExecution>;
  epics?: Map<string, EpicExecution>;
  epicBranches?: Map<string, string>;
  storyBranches?: Map<string, string>;
  epicPRs?: Map<string, any>;
  teamCompositions?: Map<string, any>;
  storyAssignments?: Map<string, any>;
  storyProgress?: Map<string, StoryProgress>;
  totalCost?: number;
  currentPhase?: string;
  currentStory?: string;
}

export interface PhaseExecution {
  phaseType: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'waiting_approval' | 'approved';
  startedAt?: Date;
  completedAt?: Date;
  output?: any;
  error?: string;
}

export interface StoryExecution {
  storyId: string;
  epicId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  output?: any;
  retryCount: number;
}

export interface EpicExecution {
  epicId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  techLeadCompleted?: boolean;
  startedAt?: Date;
  completedAt?: Date;
  cost?: number;
}

export interface StoryProgress {
  storyId: string;
  epicId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  stage?: string;
  retryCount?: number;
  lastUpdated?: Date;
  metadata?: any;
  commitHash?: string;
  sdkSessionId?: string;
}

export interface ResumptionPoint {
  phase?: string;
  epicId?: string;
  storyId?: string;
  completedPhases?: string[];
  completedEpics?: string[];
  completedStories?: string[];
  pendingEpics?: any[];
  pendingStories?: any[];
  shouldResume?: boolean;
  resumeFromPhase?: string;
  resumeFromEpic?: string;
  resumeFromStory?: string;
  executionMap?: {
    epics?: any[];
    stories?: any[];
    phases?: Record<string, PhaseExecution>;
  };
}

class UnifiedMemoryServiceClass {
  // In-memory execution maps (non-persistent)
  private executionMaps: Map<string, ExecutionMap> = new Map();

  /**
   * Get or create execution map for a task
   */
  getExecutionMap(taskId: string): ExecutionMap {
    if (!this.executionMaps.has(taskId)) {
      this.executionMaps.set(taskId, {
        taskId,
        status: 'in_progress',
        phases: new Map(),
        stories: new Map(),
        epics: new Map(),
        epicBranches: new Map(),
        storyBranches: new Map(),
        epicPRs: new Map(),
        teamCompositions: new Map(),
        storyAssignments: new Map(),
        storyProgress: new Map(),
        totalCost: 0,
      });
    }
    return this.executionMaps.get(taskId)!;
  }

  /**
   * Update execution map
   */
  updateExecutionMap(taskId: string, updates: Partial<ExecutionMap>): void {
    const map = this.getExecutionMap(taskId);
    Object.assign(map, updates);
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize execution tracking for a task
   * Accepts either a string taskId or an object with taskId
   */
  initializeExecution(
    taskIdOrOptions: string | {
      taskId: string;
      projectId?: string;
      targetRepository?: string;
      workspacePath?: string;
      taskTitle?: string;
      [key: string]: any;
    },
    _projectId?: string
  ): ExecutionMap {
    const taskId = typeof taskIdOrOptions === 'string' ? taskIdOrOptions : taskIdOrOptions.taskId;
    return this.getExecutionMap(taskId);
  }

  // ==================== PHASE MANAGEMENT ====================

  /**
   * Mark phase as started
   */
  markPhaseStarted(taskId: string, phaseType: string): void {
    const map = this.getExecutionMap(taskId);
    map.phases.set(phaseType, {
      phaseType,
      status: 'in_progress',
      startedAt: new Date(),
    });
    map.currentPhase = phaseType;
  }

  /**
   * Mark phase as completed
   */
  markPhaseCompleted(taskId: string, phaseType: string, output?: any): void {
    const map = this.getExecutionMap(taskId);
    const existing = map.phases.get(phaseType) || { phaseType, status: 'pending' };
    map.phases.set(phaseType, {
      ...existing,
      status: 'completed',
      completedAt: new Date(),
      output,
    });
  }

  /**
   * Mark phase as failed
   */
  markPhaseFailed(taskId: string, phaseType: string, error?: string): void {
    const map = this.getExecutionMap(taskId);
    const existing = map.phases.get(phaseType) || { phaseType, status: 'pending' };
    map.phases.set(phaseType, {
      ...existing,
      status: 'failed',
      completedAt: new Date(),
      error,
    });
  }

  /**
   * Mark phase as waiting for approval
   */
  markPhaseWaitingApproval(taskId: string, phaseType: string): void {
    const map = this.getExecutionMap(taskId);
    const existing = map.phases.get(phaseType) || { phaseType, status: 'pending' };
    map.phases.set(phaseType, {
      ...existing,
      status: 'waiting_approval',
    });
  }

  /**
   * Mark phase as approved
   */
  markPhaseApproved(taskId: string, phaseType: string, _approvedBy?: string): void {
    const map = this.getExecutionMap(taskId);
    const existing = map.phases.get(phaseType) || { phaseType, status: 'pending' };
    map.phases.set(phaseType, {
      ...existing,
      status: 'approved',
    });
  }

  /**
   * Check if phase should be skipped
   */
  shouldSkipPhase(taskId: string, phaseType: string): boolean {
    const map = this.getExecutionMap(taskId);
    const phase = map.phases.get(phaseType);
    return phase?.status === 'completed' || phase?.status === 'approved';
  }

  /**
   * Check if phase is completed
   */
  isPhaseCompleted(taskId: string, phaseType: string): boolean {
    const map = this.getExecutionMap(taskId);
    const exec = map.phases.get(phaseType);
    return exec?.status === 'completed';
  }

  /**
   * Get completed phases
   */
  getCompletedPhases(taskId: string): string[] {
    const map = this.getExecutionMap(taskId);
    return Array.from(map.phases.entries())
      .filter(([_, exec]) => exec.status === 'completed')
      .map(([phase]) => phase);
  }

  // ==================== EPIC MANAGEMENT ====================

  /**
   * Register epics for tracking
   */
  registerEpics(taskId: string, epics: Array<{ id: string; [key: string]: any }>): void {
    const map = this.getExecutionMap(taskId);
    if (!map.epics) map.epics = new Map();
    for (const epic of epics) {
      map.epics.set(epic.id, {
        epicId: epic.id,
        status: 'pending',
      });
    }
  }

  /**
   * Check if epic should be skipped
   */
  shouldSkipEpic(taskId: string, epicId: string): boolean {
    const map = this.getExecutionMap(taskId);
    const epic = map.epics?.get(epicId);
    return epic?.status === 'completed';
  }

  /**
   * Mark epic tech lead as completed
   */
  markEpicTechLeadCompleted(taskId: string, epicId: string): void {
    const map = this.getExecutionMap(taskId);
    if (!map.epics) map.epics = new Map();
    const existing = map.epics.get(epicId) || { epicId, status: 'pending' };
    map.epics.set(epicId, {
      ...existing,
      techLeadCompleted: true,
    });
  }

  /**
   * Save epic branch name
   */
  saveEpicBranch(taskId: string, epicId: string, branchName: string, _targetRepository?: string): void {
    const map = this.getExecutionMap(taskId);
    if (!map.epicBranches) map.epicBranches = new Map();
    map.epicBranches.set(epicId, branchName);
  }

  /**
   * Get epic branch name
   */
  getEpicBranch(taskId: string, epicId: string): string | null {
    const map = this.getExecutionMap(taskId);
    return map.epicBranches?.get(epicId) || null;
  }

  /**
   * Save story branch name
   * CRITICAL: Must be called BEFORE developer starts working
   */
  saveStoryBranch(taskId: string, storyId: string, branchName: string): void {
    const map = this.getExecutionMap(taskId);
    if (!map.storyBranches) map.storyBranches = new Map();
    map.storyBranches.set(storyId, branchName);
  }

  /**
   * Get story branch name
   */
  getStoryBranch(taskId: string, storyId: string): string | null {
    const map = this.getExecutionMap(taskId);
    return map.storyBranches?.get(storyId) || null;
  }

  /**
   * Save epic PR
   */
  saveEpicPR(taskId: string, epicId: string, prUrl: string, prNumber?: number): void {
    const map = this.getExecutionMap(taskId);
    if (!map.epicPRs) map.epicPRs = new Map();
    map.epicPRs.set(epicId, { url: prUrl, number: prNumber });
  }

  /**
   * Get epic PR
   */
  getEpicPR(taskId: string, epicId: string): any | null {
    const map = this.getExecutionMap(taskId);
    return map.epicPRs?.get(epicId) || null;
  }

  /**
   * Add cost to epic
   */
  addEpicCost(taskId: string, epicId: string, cost: number): void {
    const map = this.getExecutionMap(taskId);
    if (!map.epics) map.epics = new Map();
    const existing = map.epics.get(epicId) || { epicId, status: 'pending' };
    map.epics.set(epicId, {
      ...existing,
      cost: (existing.cost || 0) + cost,
    });
  }

  // ==================== STORY MANAGEMENT ====================

  /**
   * Register stories for tracking
   */
  registerStories(taskId: string, epicId: string, stories: Array<{ id: string; [key: string]: any }>): void {
    const map = this.getExecutionMap(taskId);
    for (const story of stories) {
      map.stories.set(story.id, {
        storyId: story.id,
        epicId,
        status: 'pending',
        retryCount: 0,
      });
    }
  }

  /**
   * Check if story should be skipped
   */
  shouldSkipStory(taskId: string, storyId: string): boolean {
    const map = this.getExecutionMap(taskId);
    const story = map.stories.get(storyId);
    return story?.status === 'completed';
  }

  /**
   * Mark story as completed
   * @param taskId - Task ID
   * @param epicId - Epic ID
   * @param storyId - Story ID
   * @param verdict - Verdict (optional)
   * @param branch - Branch name (optional)
   * @param prUrl - PR URL (optional)
   */
  markStoryCompleted(
    taskId: string,
    epicId: string,
    storyId: string,
    verdict?: string,
    branch?: string,
    prUrl?: string
  ): void {
    const map = this.getExecutionMap(taskId);
    const existing = map.stories.get(storyId) || { storyId, epicId, status: 'pending', retryCount: 0 };
    map.stories.set(storyId, {
      ...existing,
      epicId,
      status: 'completed',
      completedAt: new Date(),
      output: { verdict, branch, prUrl },
    });
  }

  /**
   * Check if story is completed
   */
  isStoryCompleted(taskId: string, storyId: string): boolean {
    const map = this.getExecutionMap(taskId);
    const exec = map.stories.get(storyId);
    return exec?.status === 'completed';
  }

  /**
   * Get completed stories for an epic
   */
  getCompletedStories(taskId: string, epicId: string): string[] {
    // Check in-memory first
    const map = this.getExecutionMap(taskId);
    const inMemory = Array.from(map.stories.entries())
      .filter(([_, exec]) => exec.epicId === epicId && exec.status === 'completed')
      .map(([storyId]) => storyId);

    if (inMemory.length > 0) return inMemory;

    // Fall back to local storage
    return granularMemoryService.getCompletedStories({ projectId: '', taskId, epicId });
  }

  /**
   * Save story progress
   * @param taskId - Task ID
   * @param epicId - Epic ID
   * @param storyId - Story ID
   * @param stage - Progress stage (e.g., 'code_generating', 'pushed', 'completed')
   * @param metadata - Optional metadata
   */
  saveStoryProgress(
    taskId: string,
    epicId: string,
    storyId: string,
    stage: string,
    metadata?: Record<string, any>
  ): void {
    const map = this.getExecutionMap(taskId);
    if (!map.storyProgress) map.storyProgress = new Map();
    const existing = map.storyProgress.get(storyId) || { storyId, epicId, status: 'pending' };
    map.storyProgress.set(storyId, {
      ...existing,
      epicId,
      stage,
      status: stage === 'completed' ? 'completed' : 'in_progress',
      lastUpdated: new Date(),
      metadata: { ...existing.metadata, ...metadata },
      ...(metadata?.commitHash && { commitHash: metadata.commitHash }),
      ...(metadata?.sdkSessionId && { sdkSessionId: metadata.sdkSessionId }),
    });
  }

  /**
   * Get story progress
   * @param taskId - Task ID
   * @param epicId - Epic ID (optional, for compatibility)
   * @param storyId - Story ID
   */
  getStoryProgress(taskId: string, epicIdOrStoryId: string, storyId?: string): StoryProgress | null {
    const map = this.getExecutionMap(taskId);
    const actualStoryId = storyId || epicIdOrStoryId;
    return map.storyProgress?.get(actualStoryId) || null;
  }

  // ==================== TEAM/ASSIGNMENT MANAGEMENT ====================

  /**
   * Save team composition
   * epicId is optional - if not provided, saves as 'all' (overall task composition)
   */
  saveTeamComposition(taskId: string, epicIdOrComposition: string | any, composition?: any): void {
    const map = this.getExecutionMap(taskId);
    if (!map.teamCompositions) map.teamCompositions = new Map();

    if (typeof epicIdOrComposition === 'string') {
      // Called with (taskId, epicId, composition)
      map.teamCompositions.set(epicIdOrComposition, composition);
    } else {
      // Called with (taskId, composition) - save as 'all'
      map.teamCompositions.set('all', epicIdOrComposition);
    }
  }

  /**
   * Get team composition
   * epicId is optional - if not provided, returns 'all' entry
   */
  getTeamComposition(taskId: string, epicId?: string): any | null {
    const map = this.getExecutionMap(taskId);
    const key = epicId || 'all';
    return map.teamCompositions?.get(key) || null;
  }

  /**
   * Save story assignments
   * epicId is optional - if not provided, saves as 'all' (overall task assignments)
   */
  saveStoryAssignments(taskId: string, epicIdOrAssignments: string | any, assignments?: any): void {
    const map = this.getExecutionMap(taskId);
    if (!map.storyAssignments) map.storyAssignments = new Map();

    if (typeof epicIdOrAssignments === 'string') {
      // Called with (taskId, epicId, assignments)
      map.storyAssignments.set(epicIdOrAssignments, assignments);
    } else {
      // Called with (taskId, assignments) - save as 'all'
      map.storyAssignments.set('all', epicIdOrAssignments);
    }
  }

  /**
   * Get story assignments
   * epicId is optional - if not provided, returns 'all' entry or combined array
   */
  getStoryAssignments(taskId: string, epicId?: string): any[] {
    const map = this.getExecutionMap(taskId);
    if (epicId) {
      return map.storyAssignments?.get(epicId) || [];
    }
    // Return 'all' entry or combine all values
    const allEntry = map.storyAssignments?.get('all');
    if (allEntry) return allEntry;
    // Combine all epic assignments
    const allAssignments: any[] = [];
    map.storyAssignments?.forEach((val) => {
      if (Array.isArray(val)) allAssignments.push(...val);
    });
    return allAssignments;
  }

  // ==================== COST TRACKING ====================

  /**
   * Add cost to task
   */
  addCost(taskId: string, cost: number, _tokens?: number): void {
    const map = this.getExecutionMap(taskId);
    map.totalCost = (map.totalCost || 0) + cost;
  }

  // ==================== RESUMPTION ====================

  /**
   * Get resumption point for task
   */
  getResumptionPoint(taskId: string): ResumptionPoint | null {
    const map = this.getExecutionMap(taskId);

    const completedPhases = Array.from(map.phases.entries())
      .filter(([_, p]) => p.status === 'completed' || p.status === 'approved')
      .map(([name]) => name);

    const completedEpics = map.epics
      ? Array.from(map.epics.entries())
          .filter(([_, e]) => e.status === 'completed')
          .map(([id]) => id)
      : [];

    const completedStories = Array.from(map.stories.entries())
      .filter(([_, s]) => s.status === 'completed')
      .map(([id]) => id);

    const pendingEpics = map.epics
      ? Array.from(map.epics.entries())
          .filter(([_, e]) => e.status === 'pending' || e.status === 'in_progress')
          .map(([id, e]) => ({ id, ...e }))
      : [];

    const pendingStories = Array.from(map.stories.entries())
      .filter(([_, s]) => s.status === 'pending' || s.status === 'in_progress')
      .map(([id, s]) => ({ id, ...s }));

    // Find current resumption points
    const inProgressPhase = Array.from(map.phases.entries())
      .find(([_, p]) => p.status === 'in_progress');
    const inProgressEpic = map.epics
      ? Array.from(map.epics.entries()).find(([_, e]) => e.status === 'in_progress')
      : undefined;
    const inProgressStory = Array.from(map.stories.entries())
      .find(([_, s]) => s.status === 'in_progress');

    // Build execution map structures for compatibility
    const epicsArray = map.epics
      ? Array.from(map.epics.entries()).map(([id, e]) => ({ id, ...e }))
      : [];
    const storiesArray = Array.from(map.stories.entries())
      .map(([id, s]) => ({ id, ...s }));

    // Build phases as object with phase names as keys
    const phasesObject: Record<string, PhaseExecution> = {};
    for (const [name, phase] of map.phases.entries()) {
      phasesObject[name] = phase;
    }

    const shouldResume = completedPhases.length > 0 || completedStories.length > 0;

    if (!shouldResume) {
      return null;
    }

    return {
      phase: map.currentPhase,
      completedPhases,
      completedEpics,
      completedStories,
      pendingEpics,
      pendingStories,
      shouldResume,
      resumeFromPhase: inProgressPhase?.[0],
      resumeFromEpic: inProgressEpic?.[0],
      resumeFromStory: inProgressStory?.[0],
      executionMap: {
        epics: epicsArray,
        stories: storiesArray,
        phases: phasesObject,
      },
    };
  }

  // ==================== MONGODB SYNC STUBS (NO-OP) ====================
  // These methods were for MongoDB sync which has been removed.
  // They return stub data for API compatibility.

  /**
   * Stub - MongoDB sync is removed
   */
  syncAllLocalToMongoDB(): { synced: number; errors: number; tasks: number } {
    // No-op: MongoDB sync is removed, data is only local now
    return { synced: 0, errors: 0, tasks: 0 };
  }

  /**
   * Stub - MongoDB sync is removed
   */
  syncLocalToMongoDB(_taskId: string): { synced: number; errors: number } {
    // No-op: MongoDB sync is removed, data is only local now
    return { synced: 0, errors: 0 };
  }

  // ==================== UPDATE METHODS ====================

  /**
   * Update phase execution status
   */
  updatePhaseExecution(taskId: string, phaseType: string, update: Partial<PhaseExecution>): void {
    const map = this.getExecutionMap(taskId);
    const current = map.phases.get(phaseType) || { phaseType, status: 'pending' };
    map.phases.set(phaseType, { ...current, ...update });
    map.currentPhase = phaseType;
  }

  /**
   * Update story execution status
   */
  updateStoryExecution(taskId: string, storyId: string, epicId: string, update: Partial<StoryExecution>): void {
    const map = this.getExecutionMap(taskId);
    const current = map.stories.get(storyId) || { storyId, epicId, status: 'pending', retryCount: 0 };
    map.stories.set(storyId, { ...current, ...update });
    map.currentStory = storyId;
  }

  // ==================== DELEGATE TO GRANULAR MEMORY ====================

  storeDecision(params: Parameters<typeof granularMemoryService.storeDecision>[0]): GranularMemory {
    return granularMemoryService.storeDecision(params);
  }

  storeAction(params: Parameters<typeof granularMemoryService.storeAction>[0]): GranularMemory {
    return granularMemoryService.storeAction(params);
  }

  storeProgress(params: Parameters<typeof granularMemoryService.storeProgress>[0]): GranularMemory {
    return granularMemoryService.storeProgress(params);
  }

  storeError(params: Parameters<typeof granularMemoryService.storeError>[0]): GranularMemory {
    return granularMemoryService.storeError(params);
  }

  storeFileChange(params: Parameters<typeof granularMemoryService.storeFileChange>[0]): GranularMemory {
    return granularMemoryService.storeFileChange(params);
  }

  storeCheckpoint(params: Parameters<typeof granularMemoryService.storeCheckpoint>[0]): GranularMemory {
    return granularMemoryService.storeCheckpoint(params);
  }

  storePattern(params: Parameters<typeof granularMemoryService.storePattern>[0]): GranularMemory {
    return granularMemoryService.storePattern(params);
  }

  storeConvention(params: Parameters<typeof granularMemoryService.storeConvention>[0]): GranularMemory {
    return granularMemoryService.storeConvention(params);
  }

  storeLearning(params: Parameters<typeof granularMemoryService.storeLearning>[0]): GranularMemory {
    return granularMemoryService.storeLearning(params);
  }

  getCheckpoint(params: Parameters<typeof granularMemoryService.getCheckpoint>[0]): GranularMemory | null {
    return granularMemoryService.getCheckpoint(params);
  }

  getPhaseMemories(params: Parameters<typeof granularMemoryService.getPhaseMemories>[0]): GranularMemory[] {
    return granularMemoryService.getPhaseMemories(params);
  }

  getErrorsToAvoid(params: Parameters<typeof granularMemoryService.getErrorsToAvoid>[0]): GranularMemory[] {
    return granularMemoryService.getErrorsToAvoid(params);
  }

  getPatternsAndConventions(params: Parameters<typeof granularMemoryService.getPatternsAndConventions>[0]): GranularMemory[] {
    return granularMemoryService.getPatternsAndConventions(params);
  }

  getFileChanges(params: Parameters<typeof granularMemoryService.getFileChanges>[0]): GranularMemory[] {
    return granularMemoryService.getFileChanges(params);
  }

  getTaskCache(params: Parameters<typeof granularMemoryService.getTaskCache>[0]): GranularMemory | null {
    return granularMemoryService.getTaskCache(params);
  }

  getTaskCaches(params: Parameters<typeof granularMemoryService.getTaskCaches>[0]): GranularMemory[] {
    return granularMemoryService.getTaskCaches(params);
  }

  formatForPrompt(memories: GranularMemory[], title?: string): string {
    return granularMemoryService.formatForPrompt(memories, title);
  }

  loadFromLocal(taskId: string, type?: GranularMemoryType): GranularMemory[] {
    return granularMemoryService.loadFromLocal(taskId, type);
  }

  /**
   * Clear execution map for a task
   */
  clearExecutionMap(taskId: string): void {
    this.executionMaps.delete(taskId);
  }
}

export const unifiedMemoryService = new UnifiedMemoryServiceClass();
export { GranularMemory, GranularMemoryType };
