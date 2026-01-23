/**
 * UnifiedMemoryService - SQLite-backed unified interface for agent memory
 *
 * ALL DATA IS PERSISTED TO SQLITE via TaskRepository.
 * This ensures recovery works after server restart.
 *
 * Key principle: task.orchestration IS the single source of truth.
 * This service provides a convenient interface to read/write that data.
 */

import { TaskRepository, ITask } from '../database/repositories/TaskRepository.js';
import { eventStore } from './EventStore.js';

/**
 * Types for execution tracking
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
  filesModified?: string[];  // Files edited during execution
  filesCreated?: string[];   // Files created from scratch
  toolsUsed?: string[];
  cost_usd?: number;
}

export interface ResumptionPoint {
  phase?: string;
  epicId?: string;
  storyId?: string;
  completedPhases?: string[];
  approvedPhases?: string[]; // 🔥 NEW: Phases that have been approved by user
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

// Helper functions removed - not needed with direct SQLite access

class UnifiedMemoryServiceClass {
  /**
   * Get task from SQLite (private helper)
   */
  private getTask(taskId: string): ITask | null {
    return TaskRepository.findById(taskId);
  }

  /**
   * Update task orchestration in SQLite (private helper)
   */
  private updateOrchestration(taskId: string, modifier: (orch: any) => any): boolean {
    return TaskRepository.modifyOrchestration(taskId, modifier);
  }

  // ==================== EXECUTION MAP (for backward compatibility) ====================

  /**
   * Get execution map - builds from SQLite data
   */
  getExecutionMap(taskId: string): ExecutionMap {
    const task = this.getTask(taskId);
    if (!task) {
      return this.createEmptyExecutionMap(taskId);
    }

    const orch = task.orchestration as any;
    const map: ExecutionMap = {
      taskId,
      status: task.status as any,
      phases: new Map(),
      stories: new Map(),
      epics: new Map(),
      epicBranches: new Map(),
      storyBranches: new Map(),
      epicPRs: new Map(),
      teamCompositions: new Map(),
      storyAssignments: new Map(),
      storyProgress: new Map(),
      totalCost: orch.totalCost || 0,
      currentPhase: orch.currentPhase,
    };

    // Build phases map from orchestration
    const phaseNames = ['planning', 'techLead', 'teamOrchestration', 'judge', 'recovery', 'integration', 'autoMerge'];
    for (const name of phaseNames) {
      if (orch[name]?.status) {
        map.phases.set(name, {
          phaseType: name,
          status: orch[name].status,
          startedAt: orch[name].startedAt,
          completedAt: orch[name].completedAt,
          output: orch[name].output,
          error: orch[name].error,
        });
      }
    }

    // Build epics map
    const epics = orch.planning?.epics || orch.epics || [];
    for (const epic of epics) {
      const epicId = epic.id || epic._id;
      if (epicId) {
        map.epics!.set(epicId, {
          epicId,
          status: epic.status || 'pending',
          techLeadCompleted: epic.techLeadCompleted,
          cost: epic.cost_usd,
        });
        if (epic.branchName) {
          map.epicBranches!.set(epicId, epic.branchName);
        }
        if (epic.pullRequestNumber) {
          map.epicPRs!.set(epicId, {
            number: epic.pullRequestNumber,
            url: epic.pullRequestUrl,
          });
        }

        // Build stories map from epic
        for (const story of epic.stories || []) {
          const storyId = story.id || story._id;
          if (storyId) {
            map.stories.set(storyId, {
              storyId,
              epicId,
              status: story.status || 'pending',
              retryCount: story.judgeIterations || 0,
              output: story.output,
            });
            if (story.branchName) {
              map.storyBranches!.set(storyId, story.branchName);
            }
            // Build story progress
            map.storyProgress!.set(`${epicId}:${storyId}`, {
              storyId,
              epicId,
              status: story.status || 'pending',
              stage: story.stage,
              retryCount: story.judgeIterations,
              metadata: story.metadata,
              filesModified: story.filesModified,
              toolsUsed: story.toolsUsed,
              cost_usd: story.cost_usd,
            });
          }
        }
      }
    }

    // Team composition
    if (orch.teamComposition) {
      map.teamCompositions!.set(taskId, orch.teamComposition);
    }

    // Story assignments
    if (orch.storyAssignments) {
      map.storyAssignments!.set(taskId, orch.storyAssignments);
    }

    return map;
  }

  private createEmptyExecutionMap(taskId: string): ExecutionMap {
    return {
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
    };
  }

  /**
   * Update execution map (backward compatibility - updates SQLite)
   */
  updateExecutionMap(taskId: string, updates: Partial<ExecutionMap>): void {
    // This is a no-op for most updates since individual methods handle persistence
    if (updates.totalCost !== undefined) {
      this.updateOrchestration(taskId, (orch) => ({
        ...orch,
        totalCost: updates.totalCost,
      }));
    }
  }

  // ==================== INITIALIZATION ====================

  /**
   * Initialize execution tracking (backward compatibility)
   */
  initializeExecution(
    taskIdOrOptions: string | { taskId: string; [key: string]: any }
  ): ExecutionMap {
    const taskId = typeof taskIdOrOptions === 'string' ? taskIdOrOptions : taskIdOrOptions.taskId;
    return this.getExecutionMap(taskId);
  }

  // ==================== PHASE MANAGEMENT ====================

  markPhaseStarted(taskId: string, phaseType: string): void {
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    this.updateOrchestration(taskId, (orch) => {
      const phase = orch[phaseName] || { agent: phaseName, status: 'pending' };
      return {
        ...orch,
        [phaseName]: { ...phase, status: 'in_progress', startedAt: new Date() },
        currentPhase: phaseName,
      };
    });
  }

  markPhaseCompleted(taskId: string, phaseType: string, output?: any): void {
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    this.updateOrchestration(taskId, (orch) => {
      const phase = orch[phaseName] || { agent: phaseName, status: 'pending' };
      return {
        ...orch,
        [phaseName]: { ...phase, status: 'completed', completedAt: new Date(), output },
      };
    });
  }

  markPhaseFailed(taskId: string, phaseType: string, error?: string): void {
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    this.updateOrchestration(taskId, (orch) => {
      const phase = orch[phaseName] || { agent: phaseName, status: 'pending' };
      return {
        ...orch,
        [phaseName]: { ...phase, status: 'failed', completedAt: new Date(), error },
      };
    });
  }

  markPhaseWaitingApproval(taskId: string, phaseType: string): void {
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    this.updateOrchestration(taskId, (orch) => {
      const phase = orch[phaseName] || { agent: phaseName, status: 'pending' };
      return {
        ...orch,
        [phaseName]: { ...phase, status: 'waiting_approval' },
      };
    });
  }

  markPhaseApproved(taskId: string, phaseType: string, _approvedBy?: string): void {
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    this.updateOrchestration(taskId, (orch) => {
      const phase = orch[phaseName] || { agent: phaseName, status: 'pending' };
      return {
        ...orch,
        [phaseName]: { ...phase, status: 'approved' },
      };
    });
  }

  shouldSkipPhase(taskId: string, phaseType: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    const status = (task.orchestration as any)[phaseName]?.status;
    return status === 'completed' || status === 'approved';
  }

  isPhaseCompleted(taskId: string, phaseType: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const phaseName = this.normalizePhaseNameForDb(phaseType);
    return (task.orchestration as any)[phaseName]?.status === 'completed';
  }

  getCompletedPhases(taskId: string): string[] {
    const task = this.getTask(taskId);
    if (!task) return [];
    const completed: string[] = [];
    const phaseNames = ['planning', 'techLead', 'teamOrchestration', 'judge', 'recovery', 'integration', 'autoMerge'];
    for (const name of phaseNames) {
      if ((task.orchestration as any)[name]?.status === 'completed') {
        completed.push(name);
      }
    }
    return completed;
  }

  private normalizePhaseNameForDb(phaseType: string): string {
    const mapping: Record<string, string> = {
      'Planning': 'planning',
      'TechLead': 'techLead',
      'TeamOrchestration': 'teamOrchestration',
      'Developers': 'development',
      'Development': 'development',
      'Judge': 'judge',
      'Recovery': 'recovery',
      'Integration': 'integration',
      'AutoMerge': 'autoMerge',
      'Approval': 'approval',
    };
    return mapping[phaseType] || phaseType.toLowerCase();
  }

  // ==================== EPIC MANAGEMENT ====================

  registerEpics(taskId: string, epics: Array<{ id: string; [key: string]: any }>): void {
    this.updateOrchestration(taskId, (orch) => {
      const existingEpics = orch.planning?.epics || [];
      const epicIds = existingEpics.map((e: any) => e.id);
      const newEpics = epics.filter(e => !epicIds.includes(e.id));
      return {
        ...orch,
        planning: {
          ...orch.planning,
          epics: [...existingEpics, ...newEpics.map(e => ({ ...e, status: e.status || 'pending' }))],
        },
      };
    });
  }

  shouldSkipEpic(taskId: string, epicId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const epics = (task.orchestration as any).planning?.epics || [];
    const epic = epics.find((e: any) => e.id === epicId);
    return epic?.status === 'completed';
  }

  markEpicTechLeadCompleted(taskId: string, epicId: string): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) =>
        e.id === epicId ? { ...e, techLeadCompleted: true } : e
      );
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  markEpicCompleted(taskId: string, epicId: string): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) =>
        e.id === epicId ? { ...e, status: 'completed', completedAt: new Date() } : e
      );
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  saveEpicBranch(taskId: string, epicId: string, branchName: string, _targetRepository?: string): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) =>
        e.id === epicId ? { ...e, branchName } : e
      );
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  getEpicBranch(taskId: string, epicId: string): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const epics = (task.orchestration as any).planning?.epics || [];
    const epic = epics.find((e: any) => e.id === epicId);
    return epic?.branchName || null;
  }

  /**
   * Save epic PR info
   * Supports both old 4-arg (taskId, epicId, prUrl, prNumber) and new 3-arg (taskId, epicId, prData) calls
   */
  saveEpicPR(taskId: string, epicId: string, prUrlOrData: any, prNumber?: number): void {
    let prData: { url?: string; number?: number; state?: string };

    if (typeof prUrlOrData === 'string') {
      // Old 4-arg format: (taskId, epicId, prUrl, prNumber)
      prData = { url: prUrlOrData, number: prNumber, state: 'open' };
    } else {
      // New 3-arg format: (taskId, epicId, prData)
      prData = prUrlOrData;
    }

    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) =>
        e.id === epicId ? {
          ...e,
          pullRequestNumber: prData.number,
          pullRequestUrl: prData.url,
          pullRequestState: prData.state || 'open',
        } : e
      );
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  getEpicPR(taskId: string, epicId: string): any | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const epics = (task.orchestration as any).planning?.epics || [];
    const epic = epics.find((e: any) => e.id === epicId);
    if (!epic?.pullRequestNumber) return null;
    return {
      number: epic.pullRequestNumber,
      url: epic.pullRequestUrl,
      state: epic.pullRequestState,
    };
  }

  addEpicCost(taskId: string, epicId: string, cost: number): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) =>
        e.id === epicId ? { ...e, cost_usd: (e.cost_usd || 0) + cost } : e
      );
      const newTotalCost = (orch.totalCost || 0) + cost;
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics }, totalCost: newTotalCost };
    });
  }

  // ==================== STORY MANAGEMENT ====================

  registerStories(taskId: string, epicId: string, stories: Array<{ id: string; [key: string]: any }>): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) => {
        if (e.id !== epicId) return e;
        const existingStories = e.stories || [];
        const storyIds = existingStories.map((s: any) => s.id);
        const newStories = stories.filter(s => !storyIds.includes(s.id));
        return { ...e, stories: [...existingStories, ...newStories.map(s => ({ ...s, status: s.status || 'pending' }))] };
      });
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  /**
   * Check if story should be skipped
   * Supports both 2-arg (taskId, storyId) and 3-arg (taskId, epicId, storyId) calls
   */
  shouldSkipStory(taskId: string, epicIdOrStoryId: string, storyId?: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const epics = (task.orchestration as any).planning?.epics || [];

    // If 3 arguments: epicId is epicIdOrStoryId, storyId is storyId
    // If 2 arguments: storyId is epicIdOrStoryId, search all epics
    const targetStoryId = storyId ?? epicIdOrStoryId;
    const targetEpicId = storyId ? epicIdOrStoryId : null;

    if (targetEpicId) {
      const epic = epics.find((e: any) => e.id === targetEpicId);
      if (!epic) return false;
      const story = (epic.stories || []).find((s: any) => s.id === targetStoryId);
      return story?.status === 'completed';
    }

    // Search all epics for the story
    for (const epic of epics) {
      const story = (epic.stories || []).find((s: any) => s.id === targetStoryId);
      if (story?.status === 'completed') return true;
    }
    return false;
  }

  markStoryStarted(taskId: string, storyId: string): void {
    this.updateStoryInAllEpics(taskId, storyId, (story) => ({
      ...story,
      status: 'in_progress',
      startedAt: new Date(),
    }));
  }

  markStoryCompleted(
    taskId: string,
    epicId: string,
    storyId: string,
    statusOrOutput?: any,
    branchName?: string,
    _extra?: any
  ): void {
    this.updateStoryInEpic(taskId, epicId, storyId, (story) => ({
      ...story,
      status: 'completed',
      completedAt: new Date(),
      output: statusOrOutput,
      ...(branchName ? { branchName } : {}),
    }));
  }

  markStoryFailed(taskId: string, storyId: string, error?: string): void {
    this.updateStoryInAllEpics(taskId, storyId, (story) => ({
      ...story,
      status: 'failed',
      completedAt: new Date(),
      error,
    }));
  }

  saveStoryBranch(taskId: string, storyId: string, branchName: string): void {
    this.updateStoryInAllEpics(taskId, storyId, (story) => ({
      ...story,
      branchName,
    }));
  }

  getStoryBranch(taskId: string, storyId: string): string | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const epics = (task.orchestration as any).planning?.epics || [];
    for (const epic of epics) {
      const story = (epic.stories || []).find((s: any) => s.id === storyId);
      if (story?.branchName) return story.branchName;
    }
    return null;
  }

  saveStoryProgress(
    taskId: string,
    epicId: string,
    storyId: string,
    stage: string,
    metadata?: any
  ): void {
    this.updateStoryInEpic(taskId, epicId, storyId, (story) => ({
      ...story,
      stage,
      lastUpdated: new Date(),
      ...(metadata ? { metadata: { ...(story.metadata || {}), ...metadata } } : {}),
      ...(metadata?.filesModified ? { filesModified: metadata.filesModified } : {}),
      ...(metadata?.filesCreated ? { filesCreated: metadata.filesCreated } : {}),
      ...(metadata?.toolsUsed ? { toolsUsed: metadata.toolsUsed } : {}),
      ...(metadata?.commitHash ? { commitHash: metadata.commitHash } : {}),
      ...(metadata?.cost_usd ? { cost_usd: (story.cost_usd || 0) + metadata.cost_usd } : {}),
    }));
  }

  getStoryProgress(taskId: string, epicId: string, storyId: string): StoryProgress | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const epics = (task.orchestration as any).planning?.epics || [];
    const epic = epics.find((e: any) => e.id === epicId);
    if (!epic) return null;
    const story = (epic.stories || []).find((s: any) => s.id === storyId);
    if (!story) return null;
    return {
      storyId: story.id,
      epicId,
      status: story.status || 'pending',
      stage: story.stage,
      retryCount: story.judgeIterations,
      metadata: story.metadata,
      filesModified: story.filesModified,
      filesCreated: story.filesCreated,
      toolsUsed: story.toolsUsed,
      cost_usd: story.cost_usd,
    };
  }

  incrementStoryRetry(taskId: string, _epicId: string, storyId: string): number {
    let newCount = 0;
    this.updateStoryInAllEpics(taskId, storyId, (story) => {
      newCount = (story.judgeIterations || 0) + 1;
      return { ...story, judgeIterations: newCount };
    });
    return newCount;
  }

  private updateStoryInEpic(
    taskId: string,
    epicId: string,
    storyId: string,
    modifier: (story: any) => any
  ): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) => {
        if (e.id !== epicId) return e;
        const stories = (e.stories || []).map((s: any) =>
          s.id === storyId ? modifier(s) : s
        );
        return { ...e, stories };
      });
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  private updateStoryInAllEpics(taskId: string, storyId: string, modifier: (story: any) => any): void {
    this.updateOrchestration(taskId, (orch) => {
      const epics = orch.planning?.epics || [];
      const updatedEpics = epics.map((e: any) => {
        const stories = (e.stories || []).map((s: any) =>
          s.id === storyId ? modifier(s) : s
        );
        return { ...e, stories };
      });
      return { ...orch, planning: { ...orch.planning, epics: updatedEpics } };
    });
  }

  // ==================== TEAM MANAGEMENT ====================

  saveTeamComposition(taskId: string, teamComposition: any): void {
    this.updateOrchestration(taskId, (orch) => ({
      ...orch,
      teamComposition,
    }));
  }

  getTeamComposition(taskId: string): any | null {
    const task = this.getTask(taskId);
    return (task?.orchestration as any)?.teamComposition || null;
  }

  saveStoryAssignments(taskId: string, storyAssignments: any): void {
    this.updateOrchestration(taskId, (orch) => ({
      ...orch,
      storyAssignments,
    }));
  }

  getStoryAssignments(taskId: string): any | null {
    const task = this.getTask(taskId);
    return (task?.orchestration as any)?.storyAssignments || null;
  }

  // ==================== RESUMPTION POINT ====================

  /**
   * Get resumption point for retry/resume operations
   *
   * 🔥 CRITICAL: EventStore is the SOURCE OF TRUTH
   * This ensures that even if orchestration gets corrupted, retry always works
   * because events are immutable and append-only.
   */
  getResumptionPoint(taskId: string): ResumptionPoint {
    // 🔥 STEP 1: Try to rebuild state from EventStore (immutable source of truth)
    const eventState = this.buildResumptionPointFromEvents(taskId);
    if (eventState) {
      console.log(`✅ [UnifiedMemory] Built resumption point from EventStore (${eventState.completedStories?.length || 0} stories completed)`);
      return eventState;
    }

    // 🔥 STEP 2: Fallback to orchestration (legacy or no events)
    console.log(`⚠️ [UnifiedMemory] No events found, falling back to orchestration`);
    return this.buildResumptionPointFromOrchestration(taskId);
  }

  /**
   * Build resumption point from EventStore (primary source of truth)
   * Returns null if no events exist for the task
   */
  private buildResumptionPointFromEvents(taskId: string): ResumptionPoint | null {
    try {
      // Get events synchronously from EventRepository
      const { EventRepository } = require('../database/repositories/EventRepository.js');
      const events = EventRepository.findByTaskId(taskId);

      if (!events || events.length === 0) {
        return null;
      }

      // Build state from events
      const state = eventStore.buildState(events);

      const completedPhases: string[] = [];
      // 🔥 CRITICAL: Check BOTH completed AND approved states
      // A phase is truly "done" only when completed AND approved (for phases requiring approval)
      if (state.planningCompleted) completedPhases.push('planning');
      if (state.techLeadCompleted) completedPhases.push('techLead');
      if (state.developersCompleted) completedPhases.push('developers');
      if (state.mergeCompleted) completedPhases.push('merge');

      // 🔥 NEW: Track approval states for phases that require user approval
      const approvedPhases: string[] = [];
      if (state.planningApproved) approvedPhases.push('planning');
      if (state.techLeadApproved) approvedPhases.push('techLead');
      if (state.prApproved) approvedPhases.push('autoMerge');

      console.log(`📋 [Resumption] Completed phases: ${completedPhases.join(', ') || 'none'}`);
      console.log(`📋 [Resumption] Approved phases: ${approvedPhases.join(', ') || 'none'}`);

      const completedEpics: string[] = [];
      const completedStories: string[] = [];
      const pendingEpics: any[] = [];
      const pendingStories: any[] = [];

      // Analyze epics from event state
      for (const epic of state.epics) {
        const epicStories = state.stories.filter(s => s.epicId === epic.id);
        const allStoriesCompleted = epicStories.length > 0 &&
          epicStories.every(s => s.status === 'completed');

        if (allStoriesCompleted) {
          completedEpics.push(epic.id);
        } else {
          pendingEpics.push(epic);
        }
      }

      // Analyze stories from event state
      for (const story of state.stories) {
        if (story.status === 'completed') {
          completedStories.push(story.id);
        } else if (story.status !== 'failed') {
          pendingStories.push(story);
        }
      }

      const shouldResume = completedPhases.length > 0 ||
                          completedEpics.length > 0 ||
                          completedStories.length > 0;

      // Build executionMap from event state
      const executionMapEpics = state.epics.map((epic) => ({
        epicId: epic.id,
        epicName: epic.name,
        techLeadCompleted: epic.techLeadCompleted || false,
        status: epic.status || 'pending',
        stories: state.stories
          .filter(s => s.epicId === epic.id)
          .map(s => ({
            storyId: s.id,
            title: s.title,
            status: s.status,
            developerId: s.assignedTo,
          })),
      }));

      console.log(`📊 [EventStore→Resumption] Epics: ${state.epics.length}, Stories: ${state.stories.length}`);
      console.log(`   TechLead completed per epic: ${state.epics.map(e => `${e.id.substring(0,20)}=${e.techLeadCompleted}`).join(', ')}`);

      return {
        shouldResume,
        completedPhases,
        approvedPhases, // 🔥 NEW: Include approval states
        completedEpics,
        completedStories,
        pendingEpics,
        pendingStories,
        resumeFromPhase: state.currentPhase,
        phase: state.currentPhase,
        executionMap: {
          epics: executionMapEpics,
          stories: completedStories.map((id: string) => ({ storyId: id })),
          phases: {},
        },
      };
    } catch (error: any) {
      console.error(`❌ [UnifiedMemory] Failed to build from events: ${error.message}`);
      return null;
    }
  }

  /**
   * Build resumption point from orchestration (fallback)
   */
  private buildResumptionPointFromOrchestration(taskId: string): ResumptionPoint {
    const task = this.getTask(taskId);
    if (!task) {
      return { shouldResume: false, completedPhases: [], completedEpics: [], completedStories: [] };
    }

    const orch = task.orchestration as any;
    const completedPhases = this.getCompletedPhases(taskId);
    const completedEpics: string[] = [];
    const completedStories: string[] = [];
    const pendingEpics: any[] = [];
    const pendingStories: any[] = [];

    // Analyze epics and stories
    const epics = orch.planning?.epics || [];
    for (const epic of epics) {
      if (epic.status === 'completed') {
        completedEpics.push(epic.id);
      } else {
        pendingEpics.push(epic);
      }
      for (const story of epic.stories || []) {
        if (story.status === 'completed') {
          completedStories.push(story.id);
        } else if (story.status !== 'skipped') {
          pendingStories.push(story);
        }
      }
    }

    const shouldResume = completedPhases.length > 0 || completedEpics.length > 0 || completedStories.length > 0;

    // Build executionMap with epic-level tracking
    const executionMapEpics = epics.map((epic: any) => ({
      epicId: epic.id,
      epicName: epic.name || epic.title,
      techLeadCompleted: epic.techLeadCompleted || false,
      status: epic.status,
      stories: (epic.stories || []).map((s: any) => ({
        storyId: s.id,
        title: s.title,
        status: s.status,
        developerId: s.developerId,
      })),
    }));

    return {
      shouldResume,
      completedPhases,
      completedEpics,
      completedStories,
      pendingEpics,
      pendingStories,
      resumeFromPhase: orch.currentPhase,
      phase: orch.currentPhase,
      executionMap: {
        epics: executionMapEpics,
        stories: completedStories.map((id: string) => ({ storyId: id })),
        phases: {},
      },
    };
  }

  // ==================== COST TRACKING ====================

  /**
   * Add cost to task total (OPUS 4.5 pricing: $15/MTok input, $75/MTok output)
   * For simplicity, we use blended rate: ~$45/MTok average
   */
  addCost(taskId: string, cost: number, tokens: number): void {
    this.updateOrchestration(taskId, (orch) => ({
      ...orch,
      totalCost: (orch.totalCost || 0) + cost,
      totalTokens: (orch.totalTokens || 0) + tokens,
    }));
  }

  // ==================== BACKWARD COMPATIBILITY STUBS ====================

  /**
   * These methods exist for backward compatibility but don't need to do anything
   * since all data is already in SQLite
   */
  async syncAllLocalToMongoDB(): Promise<{ synced: number; errors: number }> {
    // All data is in SQLite now - return success with 0 synced (nothing to sync)
    return { synced: 0, errors: 0 };
  }

  async syncToMongoDB(_taskId: string): Promise<void> {
    // No-op - data is already in SQLite
  }

  clearExecutionMap(_taskId: string): void {
    // No-op - clearing would lose data
  }

  // ==================== WORKSPACE INFO FOR LIVEPREVIEW ====================

  /**
   * Get workspace info for a task
   *
   * Used by LivePreview to find the workspace path even for completed tasks.
   * Reconstructs workspace path from taskId and target repository info.
   *
   * @returns Workspace info or null if not found
   */
  getWorkspaceForTask(taskId: string): {
    workspacePath: string | null;
    epicName: string | null;
    storyTitle: string | null;
    targetRepository: string | null;
  } | null {
    try {
      const { EventRepository } = require('../database/repositories/EventRepository.js');
      const events = EventRepository.findByTaskId(taskId);

      if (!events || events.length === 0) {
        return null;
      }

      // Build state from events
      const state = eventStore.buildState(events);

      if (state.epics.length === 0) {
        return null;
      }

      // Find an epic with a target repository
      const epicWithRepo = state.epics.find(e => e.targetRepository);
      if (!epicWithRepo) {
        return null;
      }

      // Construct workspace path
      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || '/tmp/agent-workspace';
      const repoName = epicWithRepo.targetRepository?.split('/').pop() || 'project';
      const epicSlug = epicWithRepo.name?.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().substring(0, 50) || 'epic';

      // Try to find the workspace - could be in different locations
      const taskDir = `${workspaceDir}/task-${taskId}`;
      const possiblePaths = [
        // New naming: team-{number}-{epicSlug}
        `${taskDir}/team-1-${epicSlug}/${repoName}`,
        // Legacy naming (team-1)
        `${taskDir}/team-1/story-${epicWithRepo.name}/project-${repoName}`,
        `${taskDir}/team-1/${repoName}`,
        // Direct paths
        `${taskDir}/${repoName}`,
        `${taskDir}`,
      ];

      const fs = require('fs');
      let foundPath: string | null = null;

      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          foundPath = p;
          break;
        }
      }

      // If not found in specific paths, search for any team-*-* directory
      if (!foundPath && fs.existsSync(taskDir)) {
        try {
          const entries = fs.readdirSync(taskDir);
          const teamDir = entries.find((e: string) => e.startsWith('team-'));
          if (teamDir) {
            const teamPath = `${taskDir}/${teamDir}/${repoName}`;
            if (fs.existsSync(teamPath)) {
              foundPath = teamPath;
            } else {
              foundPath = `${taskDir}/${teamDir}`;
            }
          }
        } catch (err: any) {
          console.warn(`[UnifiedMemory] Could not scan task directory: ${err.message}`);
        }
      }

      // Get latest story title
      const latestStory = state.stories.length > 0
        ? state.stories[state.stories.length - 1]
        : null;

      return {
        workspacePath: foundPath,
        epicName: epicWithRepo.name,
        storyTitle: latestStory?.title || null,
        targetRepository: epicWithRepo.targetRepository || null,
      };
    } catch (error: any) {
      console.error(`[UnifiedMemory] Error getting workspace for task ${taskId}:`, error.message);
      return null;
    }
  }
}

// Export singleton instance
export const unifiedMemoryService = new UnifiedMemoryServiceClass();
export default unifiedMemoryService;

// Also export types used by GranularMemoryService for compatibility
export interface GranularMemory {
  id?: string;
  taskId: string;
  projectId: string;
  type: string;
  key: string;
  value: any;
  metadata?: any;
  createdAt?: Date;
  updatedAt?: Date;
}

export type GranularMemoryType = 'epic' | 'story' | 'context' | 'decision' | 'error' | 'checkpoint';
