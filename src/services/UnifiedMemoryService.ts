/**
 * UnifiedMemoryService - THE Single Source of Truth
 *
 * This service UNIFIES all memory storage into ONE interface:
 * - PRIMARY: Local files in .agent-memory/ (fast, no dependencies)
 * - BACKUP: MongoDB (in case disk is lost)
 *
 * 🔥 IMPORTANT: Memory is stored OUTSIDE client repos
 * Location: {workspacePath}/.agent-memory/ (not inside cloned repos)
 *
 * GitHub is ONLY for actual development work:
 * - Planning → creates epic branch
 * - TechLead → commits plan + creates story branches
 * - Developers → work on stories → merge to epic
 * - Final → PR to main
 *
 * READ ORDER:  Local first → MongoDB fallback
 * WRITE ORDER: Local first → MongoDB backup
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import mongoose from 'mongoose';
import { granularMemoryService } from './GranularMemoryService';
import {
  atomicWriteFileSync,
  atomicWriteJsonSync,
  saveCheckpoint,
  loadCheckpoint,
  isOk,
} from '../utils/robustness';

// ==================== TYPES ====================

export type ExecutionStatus = 'not_started' | 'in_progress' | 'completed' | 'failed' | 'waiting_approval';

export interface PhaseExecution {
  phaseType: string;
  status: ExecutionStatus;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  output?: any;
  approvalRequired?: boolean;
  approvedAt?: Date;
  approvedBy?: string;
}

export interface EpicExecution {
  epicId: string;
  title: string;
  status: ExecutionStatus;
  techLeadCompleted: boolean;
  stories: StoryExecution[];
  // 🔥 CRITICAL FOR RECOVERY: Branch and repository info
  branchName?: string;
  targetRepository?: string;
  // 🔥 CRITICAL FOR RECOVERY: PR info for AutoMerge
  prUrl?: string;
  prNumber?: number;
  // 🔥 CRITICAL FOR RECOVERY: Cost tracking per epic
  cost?: number;
  tokens?: { input: number; output: number };
}

/**
 * 🔥 STORY PROGRESS STAGES - For mid-story recovery
 *
 * This allows recovery to resume from the EXACT stage where execution stopped,
 * not just from the beginning of the story.
 *
 * Flow: not_started → code_generating → code_written → tests_passed → committed → pushed → merged → judge_evaluating → completed
 */
export type StoryProgressStage =
  | 'not_started'       // Story hasn't begun
  | 'code_generating'   // Developer agent is writing code
  | 'code_written'      // Code files have been written to disk
  | 'tests_passed'      // Tests have passed (if applicable)
  | 'committed'         // Changes committed to story branch
  | 'pushed'            // Changes pushed to remote
  | 'merged_to_epic'    // Story branch merged to epic branch
  | 'judge_evaluating'  // Judge is reviewing the code
  | 'completed';        // Story fully done (Judge approved)

export interface StoryExecution {
  storyId: string;
  title: string;
  status: ExecutionStatus;
  developmentCompleted: boolean;
  judgeVerdict?: 'approved' | 'rejected';
  fixAttempts: number;
  branch?: string;
  prUrl?: string;
  // 🔥 CRITICAL FOR RECOVERY: Who is assigned to this story
  assignedTo?: string;
  // 🔥 CRITICAL FOR MID-STORY RECOVERY: Track exact progress stage
  progressStage?: StoryProgressStage;
  // 🔥 Additional recovery data
  lastCommitHash?: string;  // To verify commits exist
  filesModified?: string[]; // To verify code was written
  sdkSessionId?: string;    // To resume agent conversation
}

// ==================== ERROR DETECTIVE TYPES ====================

/**
 * 🔍 Error Classification Codes
 * Based on AITMPL error-detective methodology
 */
export type ErrorCode =
  | 'API_BILLING'          // Payment/credit issues
  | 'API_RATE_LIMIT'       // Rate limiting hit
  | 'API_TIMEOUT'          // Request timeout
  | 'API_AUTHENTICATION'   // Auth failures
  | 'API_OVERLOADED'       // Service overloaded
  | 'GIT_CONFLICT'         // Merge conflicts
  | 'GIT_PUSH_REJECTED'    // Push rejected (permissions, hooks)
  | 'GIT_BRANCH_NOT_FOUND' // Branch doesn't exist
  | 'BUILD_FAILURE'        // Compilation/build failed
  | 'TEST_FAILURE'         // Tests failed
  | 'LINT_FAILURE'         // Linting errors
  | 'VALIDATION_ERROR'     // Schema/data validation
  | 'FILE_NOT_FOUND'       // Missing files
  | 'PERMISSION_DENIED'    // File/resource permissions
  | 'NETWORK_ERROR'        // Network connectivity
  | 'MEMORY_EXCEEDED'      // Out of memory
  | 'CONTEXT_OVERFLOW'     // Agent context too large
  | 'PARSE_ERROR'          // JSON/output parsing failed
  | 'DEPENDENCY_MISSING'   // Missing npm/pip packages
  | 'RUNTIME_ERROR'        // Unexpected runtime error
  | 'UNKNOWN';             // Unclassified error

/**
 * 🔍 Detailed Error Interface - Error Detective
 *
 * Captures comprehensive error information for diagnosis:
 * - What happened (message, originalError)
 * - Where it happened (phase, epicId, storyId)
 * - Why it might have happened (hypothesis, evidence)
 * - What to do about it (suggestedFixes, relatedErrors)
 */
export interface DetailedError {
  // Identification
  id: string;                    // Unique error ID
  timestamp: Date;

  // Location
  phase: string;                 // Which phase failed
  agentType?: string;            // Which agent was running
  epicId?: string;               // If during epic execution
  storyId?: string;              // If during story execution

  // Error details
  errorCode: ErrorCode;          // Classified error type
  message: string;               // Human-readable summary
  originalError?: string;        // Full error message from source
  stack?: string;                // Stack trace if available

  // Context
  context?: {
    lastSuccessfulAction?: string;    // What worked before failure
    currentAction?: string;           // What was being attempted
    inputData?: any;                  // Data that caused the error
    environmentInfo?: {               // System state at failure
      nodeVersion?: string;
      memoryUsage?: number;
      diskSpace?: number;
    };
  };

  // Error Detective Analysis
  hypothesis?: string;           // AI-generated hypothesis for root cause
  evidence?: string[];           // Supporting evidence for hypothesis
  suggestedFixes?: string[];     // Potential remediation steps
  relatedErrors?: string[];      // IDs of similar past errors

  // Severity and impact
  severity: 'critical' | 'high' | 'medium' | 'low';
  recoverable: boolean;          // Can the system auto-recover?
  requiresHumanIntervention: boolean;

  // Resolution tracking
  resolved?: boolean;
  resolvedAt?: Date;
  resolutionNotes?: string;
}

export interface ExecutionMap {
  taskId: string;
  projectId: string;
  targetRepository: string;
  workspacePath: string;

  // Overall status
  status: ExecutionStatus;
  currentPhase: string;
  startedAt: Date;
  lastUpdatedAt: Date;
  completedAt?: Date;

  // Phases executed
  phases: Record<string, PhaseExecution>;

  // Epic/Story execution (for multi-team)
  epics: EpicExecution[];

  // 🔥 CRITICAL FOR RECOVERY: Team composition and assignments
  teamComposition?: {
    developers: number;
    reasoning?: string;
  };
  storyAssignments?: Array<{
    storyId: string;
    assignedTo: string;
  }>;

  // Costs
  totalCost: number;
  totalTokens: number;

  // Errors encountered (simple list for backward compatibility)
  errors: string[];

  // 🔍 Detailed errors for Error Detective analysis
  detailedErrors?: DetailedError[];
}

export interface ResumptionPoint {
  shouldResume: boolean;
  resumeFromPhase?: string;
  resumeFromEpic?: string;
  resumeFromStory?: string;
  completedPhases: string[];
  completedEpics: string[];
  completedStories: string[];
  pendingActions: string[];
  executionMap: ExecutionMap | null;
}

// ==================== SERVICE ====================

export class UnifiedMemoryService {
  private static instance: UnifiedMemoryService;

  private constructor() {}

  static getInstance(): UnifiedMemoryService {
    if (!UnifiedMemoryService.instance) {
      UnifiedMemoryService.instance = new UnifiedMemoryService();
    }
    return UnifiedMemoryService.instance;
  }

  // ==================== OBJECTID VALIDATION HELPERS ====================

  /**
   * Check if a string is a valid MongoDB ObjectId (24-character hex)
   */
  private isValidObjectId(id: string | undefined | null): boolean {
    if (!id || typeof id !== 'string') return false;
    return /^[a-fA-F0-9]{24}$/.test(id.trim());
  }

  /**
   * Safely create an ObjectId from a string, returns undefined if invalid
   */
  private safeObjectId(id: string | undefined | null): mongoose.Types.ObjectId | undefined {
    if (!this.isValidObjectId(id)) return undefined;
    return new mongoose.Types.ObjectId(id!.trim());
  }

  // ==================== EXECUTION MAP MANAGEMENT ====================

  /**
   * Initialize or load execution map for a task
   */
  async initializeExecution(params: {
    taskId: string;
    projectId: string;
    targetRepository: string;
    workspacePath: string;
    taskTitle?: string;
    taskDescription?: string;
  }): Promise<ExecutionMap> {
    // Check if we have an existing execution map
    const existing = await this.getExecutionMap(params.taskId);

    if (existing) {
      console.log(`📍 [UnifiedMemory] Found existing execution map for task ${params.taskId}`);
      console.log(`   Status: ${existing.status}, Current Phase: ${existing.currentPhase}`);
      return existing;
    }

    // Validate ObjectIds before use
    const projectOid = this.safeObjectId(params.projectId);
    const taskOid = this.safeObjectId(params.taskId);
    if (!projectOid || !taskOid) {
      console.warn(`⚠️ [UnifiedMemory] initializeExecution - invalid IDs: projectId=${params.projectId}, taskId=${params.taskId}`);
      throw new Error(`Invalid ObjectId: projectId=${params.projectId}, taskId=${params.taskId}`);
    }

    // Create new execution map
    const executionMap: ExecutionMap = {
      taskId: params.taskId,
      projectId: params.projectId,
      targetRepository: params.targetRepository,
      workspacePath: params.workspacePath,
      status: 'in_progress',
      currentPhase: 'initialization',
      startedAt: new Date(),
      lastUpdatedAt: new Date(),
      phases: {},
      epics: [],
      totalCost: 0,
      totalTokens: 0,
      errors: [],
    };

    // 1️⃣ WRITE TO LOCAL FIRST (primary)
    await this.syncToLocal(params.workspacePath, '', executionMap);
    console.log(`💾 [UnifiedMemory] Saved execution map to local (primary)`);

    // 2️⃣ BACKUP TO MONGODB
    try {
      await granularMemoryService.store({
        projectId: projectOid,
        taskId: taskOid,
        scope: 'task',
        type: 'checkpoint',
        title: 'EXECUTION_MAP',
        content: JSON.stringify(executionMap),
        importance: 'critical',
        confidence: 1.0,
        checkpoint: {
          resumeData: executionMap,
          completedActions: [],
          pendingActions: ['planning', 'tech-lead', 'development', 'merge'],
        },
      });
      console.log(`☁️ [UnifiedMemory] Backed up to MongoDB`);
    } catch (mongoError: any) {
      console.warn(`⚠️ [UnifiedMemory] MongoDB backup failed (non-critical): ${mongoError.message}`);
    }

    console.log(`📍 [UnifiedMemory] Created new execution map for task ${params.taskId}`);
    return executionMap;
  }

  /**
   * Get execution map for a task
   *
   * 🔥 PRIORITY ORDER:
   * 1. Local file (PRIMARY - fast, no dependencies)
   * 2. MongoDB (BACKUP - if local is empty/lost)
   *
   * If found in MongoDB but not local, auto-sync to local
   */
  async getExecutionMap(taskId: string): Promise<ExecutionMap | null> {
    try {
      if (!taskId || typeof taskId !== 'string') {
        console.warn(`⚠️ [UnifiedMemory] Invalid taskId: ${taskId}`);
        return null;
      }

      const cleanTaskId = taskId.trim();

      // Validate ObjectId format
      const isValidObjectId = /^[a-fA-F0-9]{24}$/.test(cleanTaskId);
      if (!isValidObjectId) {
        console.warn(`⚠️ [UnifiedMemory] taskId is not a valid ObjectId: ${cleanTaskId}`);
        return null;
      }

      // 1️⃣ TRY LOCAL FIRST (primary source)
      const localMap = await this.loadFromLocal(cleanTaskId);
      if (localMap) {
        console.log(`📂 [UnifiedMemory] Loaded from local (primary)`);
        return localMap;
      }

      // 2️⃣ FALLBACK TO MONGODB (backup)
      console.log(`🔧 [UnifiedMemory] Local empty - trying MongoDB backup for task ${cleanTaskId}`);

      const memory = await granularMemoryService.getCheckpoint({
        projectId: '',
        taskId: cleanTaskId,
        phaseType: 'execution_map',
      });

      if (memory?.checkpoint?.resumeData) {
        console.log(`✅ [UnifiedMemory] Found in MongoDB backup - restoring to local`);
        const map = memory.checkpoint.resumeData as ExecutionMap;
        // Auto-sync MongoDB data to local
        await this.syncToLocal(map.workspacePath, '', map);
        return map;
      }

      // Try alternate MongoDB query
      const Model = mongoose.model('GranularMemory');
      const doc = await Model.findOne({
        taskId: new mongoose.Types.ObjectId(cleanTaskId),
        title: 'EXECUTION_MAP',
        type: 'checkpoint',
        archived: false,
      }).sort({ updatedAt: -1 }).lean();

      if (doc && (doc as any).checkpoint?.resumeData) {
        const map = (doc as any).checkpoint.resumeData as ExecutionMap;
        console.log(`✅ [UnifiedMemory] Found in MongoDB backup - restoring to local`);
        await this.syncToLocal(map.workspacePath, '', map);
        return map;
      }

      return null;
    } catch (error: any) {
      console.warn(`⚠️ [UnifiedMemory] Failed to get execution map: ${error.message}`);

      // Last resort: try local even on error
      try {
        const localMap = await this.loadFromLocal(taskId);
        if (localMap) return localMap;
      } catch {
        // Ignore
      }

      return null;
    }
  }

  /**
   * 🔥 Load execution map from LOCAL file
   * Used as fallback when MongoDB is empty or unavailable
   * Location: {workspacePath}/.agent-memory/ (NOT inside client repos)
   *
   * 🔒 ROBUSTNESS: Tries main file first, then checkpoint backup
   */
  private async loadFromLocal(taskId: string): Promise<ExecutionMap | null> {
    try {
      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
      const taskDir = path.join(workspaceDir, `task-${taskId}`);

      if (!fs.existsSync(taskDir)) {
        return null;
      }

      // 🔥 Look in .agent-memory/ at workspace root (NOT inside repos)
      const memoryDir = path.join(taskDir, '.agent-memory');
      const mapPath = path.join(memoryDir, 'execution-map.json');

      // 🔒 TRY 1: Main execution-map.json
      if (fs.existsSync(mapPath)) {
        try {
          const content = fs.readFileSync(mapPath, 'utf8');
          const map = JSON.parse(content) as ExecutionMap;

          // Validate taskId matches (extra safety)
          if (map.taskId !== taskId) {
            console.log(`⚠️ [UnifiedMemory] Local file has DIFFERENT taskId: ${map.taskId} (expected: ${taskId}) - IGNORING`);
          } else {
            console.log(`📂 [UnifiedMemory] Loaded from local: ${mapPath}`);
            return map;
          }
        } catch (parseError: any) {
          console.warn(`⚠️ [UnifiedMemory] Main file corrupted: ${parseError.message}, trying checkpoint...`);
        }
      }

      // 🔒 TRY 2: Checkpoint backup (if main file corrupted or missing)
      const checkpointResult = loadCheckpoint<ExecutionMap>(memoryDir, 'execution-map');
      if (isOk(checkpointResult)) {
        const map = checkpointResult.data;

        // Validate taskId
        if (map.taskId !== taskId) {
          console.warn(`⚠️ [UnifiedMemory] Checkpoint has wrong taskId: ${map.taskId}`);
          return null;
        }

        console.log(`🔄 [UnifiedMemory] Recovered from checkpoint: ${memoryDir}`);

        // Restore main file from checkpoint
        try {
          const restoreResult = atomicWriteJsonSync(mapPath, map);
          if (isOk(restoreResult)) {
            console.log(`✅ [UnifiedMemory] Restored main file from checkpoint`);
          }
        } catch {
          // Non-critical - we have the data
        }

        return map;
      }

      return null;
    } catch (error: any) {
      console.warn(`⚠️ [UnifiedMemory] Failed to load from local: ${error.message}`);
      return null;
    }
  }

  /**
   * 🔥 Sync local execution map to MongoDB
   * Used to restore MongoDB from local files after DB reset/crash
   */
  async syncLocalToMongoDB(map: ExecutionMap): Promise<void> {
    try {
      const projectOid = this.safeObjectId(map.projectId);
      const taskOid = this.safeObjectId(map.taskId);

      if (!projectOid || !taskOid) {
        console.warn(`⚠️ [UnifiedMemory] Cannot sync to MongoDB - invalid IDs`);
        return;
      }

      // Check if already exists in MongoDB
      const Model = mongoose.model('GranularMemory');
      const existing = await Model.findOne({
        taskId: taskOid,
        title: 'EXECUTION_MAP',
        type: 'checkpoint',
      });

      if (existing) {
        // Update existing
        await Model.updateOne(
          { _id: existing._id },
          {
            $set: {
              content: JSON.stringify(map),
              'checkpoint.resumeData': map,
              updatedAt: new Date(),
            },
          }
        );
        console.log(`🔄 [UnifiedMemory] Updated MongoDB from local (task ${map.taskId})`);
      } else {
        // Create new
        await granularMemoryService.store({
          projectId: projectOid,
          taskId: taskOid,
          scope: 'task',
          type: 'checkpoint',
          title: 'EXECUTION_MAP',
          content: JSON.stringify(map),
          importance: 'critical',
          confidence: 1.0,
          checkpoint: {
            resumeData: map,
            completedActions: Object.keys(map.phases || {}).filter(p => map.phases[p]?.status === 'completed'),
            pendingActions: [],
          },
        });
        console.log(`✅ [UnifiedMemory] Synced local to MongoDB (task ${map.taskId})`);
      }
    } catch (error: any) {
      console.error(`❌ [UnifiedMemory] Failed to sync to MongoDB: ${error.message}`);
    }
  }

  /**
   * 🔥 Bulk sync ALL local execution maps to MongoDB
   * Use this to restore MongoDB after a database reset
   */
  async syncAllLocalToMongoDB(): Promise<{ synced: number; errors: number }> {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    let synced = 0;
    let errors = 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 [UnifiedMemory] Syncing ALL local execution maps to MongoDB`);
    console.log(`   Workspace: ${workspaceDir}`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      if (!fs.existsSync(workspaceDir)) {
        console.warn(`⚠️ Workspace directory not found: ${workspaceDir}`);
        return { synced: 0, errors: 0 };
      }

      const taskDirs = fs.readdirSync(workspaceDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('task-'))
        .map(d => d.name);

      console.log(`📋 Found ${taskDirs.length} task directories`);

      for (const taskDirName of taskDirs) {
        const taskId = taskDirName.replace('task-', '');
        try {
          const map = await this.loadFromLocal(taskId);
          if (map) {
            await this.syncLocalToMongoDB(map);
            synced++;
            console.log(`   ✅ Synced: ${taskId}`);
          }
        } catch (err: any) {
          errors++;
          console.error(`   ❌ Failed: ${taskId} - ${err.message}`);
        }
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`🎉 Sync complete: ${synced} synced, ${errors} errors`);
      console.log(`${'='.repeat(60)}\n`);

    } catch (error: any) {
      console.error(`❌ [UnifiedMemory] Bulk sync failed: ${error.message}`);
    }

    return { synced, errors };
  }

  /**
   * Update execution map
   *
   * 🔥 WRITE ORDER:
   * 1. Local first (PRIMARY)
   * 2. MongoDB backup
   */
  async updateExecutionMap(
    taskId: string,
    updates: Partial<ExecutionMap>,
    _commitMessage?: string  // No longer used - we don't commit to client repos
  ): Promise<ExecutionMap> {
    const taskOid = this.safeObjectId(taskId);
    if (!taskOid) {
      throw new Error(`Invalid taskId for update: ${taskId}`);
    }

    const current = await this.getExecutionMap(taskId);
    if (!current) {
      throw new Error(`No execution map found for task ${taskId}`);
    }

    const updated: ExecutionMap = {
      ...current,
      ...updates,
      lastUpdatedAt: new Date(),
    };

    // 1️⃣ WRITE TO LOCAL FIRST (primary)
    await this.syncToLocal(current.workspacePath, '', updated);

    // 2️⃣ BACKUP TO MONGODB
    try {
      const Model = mongoose.model('GranularMemory');
      await Model.updateOne(
        {
          taskId: taskOid,
          title: 'EXECUTION_MAP',
          type: 'checkpoint',
        },
        {
          $set: {
            content: JSON.stringify(updated),
            'checkpoint.resumeData': updated,
            updatedAt: new Date(),
          },
        }
      );
    } catch (mongoError: any) {
      console.warn(`⚠️ [UnifiedMemory] MongoDB backup failed (non-critical): ${mongoError.message}`);
      // Don't throw - local is primary, MongoDB is just backup
    }

    return updated;
  }

  // ==================== PHASE TRACKING ====================

  /**
   * Mark a phase as started
   */
  async markPhaseStarted(taskId: string, phaseType: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize phases if not present
    if (!map.phases) map.phases = {};

    const phaseExecution: PhaseExecution = {
      phaseType,
      status: 'in_progress',
      startedAt: new Date(),
    };

    map.phases[phaseType] = phaseExecution;
    map.currentPhase = phaseType;

    await this.updateExecutionMap(taskId, {
      phases: map.phases,
      currentPhase: phaseType,
    });

    // Also store as progress memory
    await granularMemoryService.storeProgress({
      projectId: map.projectId,
      taskId,
      phaseType,
      agentType: phaseType,
      status: 'started',
      details: `Phase ${phaseType} started`,
    });

    console.log(`▶️ [UnifiedMemory] Phase started: ${phaseType}`);
  }

  /**
   * Mark a phase as completed
   */
  async markPhaseCompleted(
    taskId: string,
    phaseType: string,
    output?: any
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize phases if not present
    if (!map.phases) map.phases = {};

    if (!map.phases[phaseType]) {
      map.phases[phaseType] = { phaseType, status: 'completed' };
    }

    map.phases[phaseType].status = 'completed';
    map.phases[phaseType].completedAt = new Date();
    map.phases[phaseType].output = output;

    await this.updateExecutionMap(taskId, {
      phases: map.phases,
    }, `[${phaseType}] Phase completed`);

    // Store progress
    await granularMemoryService.storeProgress({
      projectId: map.projectId,
      taskId,
      phaseType,
      agentType: phaseType,
      status: 'completed',
      details: `Phase ${phaseType} completed successfully`,
    });

    console.log(`✅ [UnifiedMemory] Phase completed: ${phaseType}`);
  }

  /**
   * Mark a phase as waiting for approval
   */
  async markPhaseWaitingApproval(taskId: string, phaseType: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize phases if not present
    if (!map.phases) map.phases = {};

    if (!map.phases[phaseType]) {
      map.phases[phaseType] = { phaseType, status: 'waiting_approval' };
    }

    map.phases[phaseType].status = 'waiting_approval';
    map.phases[phaseType].approvalRequired = true;

    await this.updateExecutionMap(taskId, {
      phases: map.phases,
    }, `[${phaseType}] Waiting for approval`);

    console.log(`⏸️ [UnifiedMemory] Phase waiting approval: ${phaseType}`);
  }

  /**
   * Mark a phase as approved
   */
  async markPhaseApproved(taskId: string, phaseType: string, approvedBy?: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize phases if not present
    if (!map.phases) map.phases = {};

    if (!map.phases[phaseType]) {
      map.phases[phaseType] = { phaseType, status: 'completed' };
    }

    map.phases[phaseType].status = 'completed';
    map.phases[phaseType].approvedAt = new Date();
    map.phases[phaseType].approvedBy = approvedBy;
    map.phases[phaseType].completedAt = new Date();

    await this.updateExecutionMap(taskId, {
      phases: map.phases,
    }, `[${phaseType}] Approved`);

    console.log(`👍 [UnifiedMemory] Phase approved: ${phaseType}`);
  }

  /**
   * Mark a phase as failed
   */
  async markPhaseFailed(taskId: string, phaseType: string, error: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize phases and errors if not present
    if (!map.phases) map.phases = {};
    if (!map.errors) map.errors = [];

    if (!map.phases[phaseType]) {
      map.phases[phaseType] = { phaseType, status: 'failed' };
    }

    map.phases[phaseType].status = 'failed';
    map.phases[phaseType].error = error;
    map.errors.push(`[${phaseType}] ${error}`);

    await this.updateExecutionMap(taskId, {
      phases: map.phases,
      errors: map.errors,
    }, `[${phaseType}] Failed: ${error.substring(0, 50)}`);

    // Store error memory
    await granularMemoryService.storeError({
      projectId: map.projectId,
      taskId,
      phaseType,
      agentType: phaseType,
      errorMessage: error,
    });

    console.log(`❌ [UnifiedMemory] Phase failed: ${phaseType} - ${error}`);
  }

  // ==================== EPIC/STORY TRACKING ====================

  /**
   * Register epics for execution
   */
  async registerEpics(taskId: string, epics: Array<{ id: string; title: string }>): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    map.epics = epics.map(e => ({
      epicId: e.id,
      title: e.title,
      status: 'not_started',
      techLeadCompleted: false,
      stories: [],
    }));

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `Registered ${epics.length} epics`);

    console.log(`📋 [UnifiedMemory] Registered ${epics.length} epics`);
  }

  /**
   * Register stories for an epic
   */
  async registerStories(
    taskId: string,
    epicId: string,
    stories: Array<{ id: string; title: string }>
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] CRITICAL: registerStories() - Epic "${epicId}" NOT FOUND in execution map!`);
      console.error(`   Available epics: [${map.epics.map(e => e.epicId).join(', ')}]`);
      console.error(`   Stories will NOT be registered - recovery will NOT work correctly!`);
      return;
    }

    epic.stories = stories.map(s => ({
      storyId: s.id,
      title: s.title,
      status: 'not_started',
      developmentCompleted: false,
      fixAttempts: 0,
    }));

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    });

    console.log(`📋 [UnifiedMemory] Registered ${stories.length} stories for epic ${epicId}`);
  }

  /**
   * Mark epic tech-lead as completed
   */
  async markEpicTechLeadCompleted(taskId: string, epicId: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] CRITICAL: markEpicTechLeadCompleted() - Epic "${epicId}" NOT FOUND!`);
      console.error(`   Available epics: [${map.epics.map(e => e.epicId).join(', ')}]`);
      console.error(`   TechLead completion will NOT be recorded - recovery will NOT work correctly!`);
      return;
    }

    epic.techLeadCompleted = true;
    epic.status = 'in_progress';

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `[TechLead] Epic ${epicId} architecture completed`);

    console.log(`✅ [UnifiedMemory] Epic ${epicId} tech-lead completed`);
  }

  /**
   * Mark story as completed
   */
  async markStoryCompleted(
    taskId: string,
    epicId: string,
    storyId: string,
    verdict: 'approved' | 'rejected',
    branch?: string,
    prUrl?: string
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] CRITICAL: markStoryCompleted() - Epic "${epicId}" NOT FOUND!`);
      console.error(`   Available epics: [${map.epics.map(e => e.epicId).join(', ')}]`);
      console.error(`   Story "${storyId}" completion will NOT be recorded - recovery will NOT work!`);
      return;
    }

    // Initialize stories if not present
    if (!epic.stories) epic.stories = [];

    const story = epic.stories.find(s => s.storyId === storyId);
    if (!story) {
      console.error(`❌ [UnifiedMemory] CRITICAL: markStoryCompleted() - Story "${storyId}" NOT FOUND in epic "${epicId}"!`);
      console.error(`   Available stories: [${epic.stories.map(s => s.storyId).join(', ')}]`);
      console.error(`   Story completion will NOT be recorded - recovery will NOT work!`);
      return;
    }

    story.status = verdict === 'approved' ? 'completed' : 'failed';
    story.developmentCompleted = true;
    story.judgeVerdict = verdict;
    story.branch = branch;
    story.prUrl = prUrl;

    // Check if all stories are done
    const allDone = epic.stories.every(s => s.status === 'completed' || s.status === 'failed');
    if (allDone) {
      epic.status = 'completed';
    }

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `[Story] ${storyId} ${verdict}`);

    // Store progress
    await granularMemoryService.storeProgress({
      projectId: map.projectId,
      taskId,
      phaseType: 'developer',
      agentType: 'judge',
      epicId,
      storyId,
      status: 'completed',
      details: `Story ${storyId} ${verdict}`,
    });

    console.log(`✅ [UnifiedMemory] Story ${storyId} ${verdict}`);
  }

  // ==================== STORY PROGRESS TRACKING (MID-STORY RECOVERY) ====================

  /**
   * 🔥 CRITICAL FOR MID-STORY RECOVERY: Save story progress stage
   *
   * Call this at each major checkpoint in story execution:
   * - When developer starts generating code
   * - When code is written to disk
   * - When tests pass
   * - When code is committed
   * - When code is pushed
   * - When merged to epic branch
   * - When judge starts evaluating
   *
   * This allows recovery to skip already-completed stages.
   */
  async saveStoryProgress(
    taskId: string,
    epicId: string,
    storyId: string,
    stage: StoryProgressStage,
    metadata?: {
      commitHash?: string;
      filesModified?: string[];
      sdkSessionId?: string;
    }
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] saveStoryProgress() - Epic "${epicId}" NOT FOUND!`);
      return;
    }

    // Initialize stories if not present
    if (!epic.stories) epic.stories = [];

    let story = epic.stories.find(s => s.storyId === storyId);
    if (!story) {
      // Create story entry if not exists
      story = {
        storyId,
        title: storyId, // Will be updated later
        status: 'in_progress',
        developmentCompleted: false,
        fixAttempts: 0,
        progressStage: stage,
      };
      epic.stories.push(story);
    } else {
      story.progressStage = stage;
    }

    // Update metadata if provided
    if (metadata?.commitHash) story.lastCommitHash = metadata.commitHash;
    if (metadata?.filesModified) story.filesModified = metadata.filesModified;
    if (metadata?.sdkSessionId) story.sdkSessionId = metadata.sdkSessionId;

    // Update status based on stage
    if (stage === 'not_started') {
      story.status = 'not_started';
    } else if (stage === 'completed') {
      story.status = 'completed';
      story.developmentCompleted = true;
    } else {
      story.status = 'in_progress';
    }

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `[Story ${storyId}] Progress: ${stage}`);

    console.log(`📍 [UnifiedMemory] Story ${storyId} progress: ${stage}`);
  }

  /**
   * 🔥 CRITICAL FOR RECOVERY: Get story progress for resumption
   *
   * Returns the current progress stage and metadata for a story.
   * Use this to determine what stage to resume from.
   */
  async getStoryProgress(
    taskId: string,
    epicId: string,
    storyId: string
  ): Promise<{
    stage: StoryProgressStage;
    commitHash?: string;
    filesModified?: string[];
    sdkSessionId?: string;
  } | null> {
    const map = await this.getExecutionMap(taskId);
    if (!map?.epics) return null;

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic?.stories) return null;

    const story = epic.stories.find(s => s.storyId === storyId);
    if (!story) return null;

    return {
      stage: story.progressStage || 'not_started',
      commitHash: story.lastCommitHash,
      filesModified: story.filesModified,
      sdkSessionId: story.sdkSessionId,
    };
  }

  /**
   * 🔥 HELPER: Check if a story stage has been completed
   *
   * Use this to determine if we can skip a stage during recovery.
   * Stages are ordered, so 'committed' means 'code_written' is also done.
   */
  isStageCompleted(currentStage: StoryProgressStage, checkStage: StoryProgressStage): boolean {
    const stageOrder: StoryProgressStage[] = [
      'not_started',
      'code_generating',
      'code_written',
      'tests_passed',
      'committed',
      'pushed',
      'merged_to_epic',
      'judge_evaluating',
      'completed',
    ];

    const currentIndex = stageOrder.indexOf(currentStage);
    const checkIndex = stageOrder.indexOf(checkStage);

    return currentIndex >= checkIndex;
  }

  // ==================== TEAM & ASSIGNMENT TRACKING ====================

  /**
   * 🔥 CRITICAL FOR RECOVERY: Save team composition
   * This ensures we know how many developers were created and can recreate the team on restart
   */
  async saveTeamComposition(
    taskId: string,
    teamComposition: { developers: number; reasoning?: string }
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    map.teamComposition = teamComposition;

    await this.updateExecutionMap(taskId, {
      teamComposition: map.teamComposition,
    }, `[TechLead] Team composition saved: ${teamComposition.developers} developers`);

    console.log(`👥 [UnifiedMemory] Team composition saved: ${teamComposition.developers} developers`);
  }

  /**
   * 🔥 CRITICAL FOR RECOVERY: Save story assignments
   * This ensures we know which developer is assigned to which story
   */
  async saveStoryAssignments(
    taskId: string,
    assignments: Array<{ storyId: string; assignedTo: string }>
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    map.storyAssignments = assignments;

    // Also update individual stories with their assignments
    if (map.epics) {
      for (const assignment of assignments) {
        for (const epic of map.epics) {
          const story = epic.stories?.find(s => s.storyId === assignment.storyId);
          if (story) {
            story.assignedTo = assignment.assignedTo;
          }
        }
      }
    }

    await this.updateExecutionMap(taskId, {
      storyAssignments: map.storyAssignments,
      epics: map.epics,
    }, `[TechLead] ${assignments.length} story assignments saved`);

    console.log(`📋 [UnifiedMemory] ${assignments.length} story assignments saved`);
  }

  /**
   * 🔥 CRITICAL FOR RECOVERY: Save epic branch name
   * This ensures Developers phase knows which branch to work on after restart
   */
  async saveEpicBranch(
    taskId: string,
    epicId: string,
    branchName: string,
    targetRepository: string
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] CRITICAL: saveEpicBranch() - Epic "${epicId}" NOT FOUND!`);
      console.error(`   Available epics: [${map.epics.map(e => e.epicId).join(', ')}]`);
      console.error(`   Epic branch will NOT be saved - recovery will NOT work correctly!`);
      return;
    }

    epic.branchName = branchName;
    epic.targetRepository = targetRepository;

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `[Epic ${epicId}] Branch saved: ${branchName}`);

    console.log(`🌿 [UnifiedMemory] Epic ${epicId} branch saved: ${branchName} → ${targetRepository}`);
  }

  /**
   * Get team composition for recovery
   */
  async getTeamComposition(taskId: string): Promise<{ developers: number; reasoning?: string } | null> {
    const map = await this.getExecutionMap(taskId);
    return map?.teamComposition || null;
  }

  /**
   * Get story assignments for recovery
   */
  async getStoryAssignments(taskId: string): Promise<Array<{ storyId: string; assignedTo: string }>> {
    const map = await this.getExecutionMap(taskId);
    return map?.storyAssignments || [];
  }

  /**
   * Get epic branch name for recovery
   */
  async getEpicBranch(taskId: string, epicId: string): Promise<{ branchName?: string; targetRepository?: string } | null> {
    const map = await this.getExecutionMap(taskId);
    if (!map?.epics) return null;

    const epic = map.epics.find(e => e.epicId === epicId);
    return epic ? { branchName: epic.branchName, targetRepository: epic.targetRepository } : null;
  }

  /**
   * 🔥 CRITICAL FOR RECOVERY: Save PR info for an epic
   * This ensures AutoMerge phase knows which PR to merge after restart
   */
  async saveEpicPR(
    taskId: string,
    epicId: string,
    prUrl: string,
    prNumber: number
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      console.error(`❌ [UnifiedMemory] CRITICAL: saveEpicPR() - Epic "${epicId}" NOT FOUND!`);
      console.error(`   Available epics: [${map.epics.map(e => e.epicId).join(', ')}]`);
      console.error(`   PR info will NOT be saved - AutoMerge recovery will NOT work!`);
      return;
    }

    epic.prUrl = prUrl;
    epic.prNumber = prNumber;

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
    }, `[Epic ${epicId}] PR saved: #${prNumber}`);

    console.log(`📬 [UnifiedMemory] Epic ${epicId} PR saved: ${prUrl} (#${prNumber})`);
  }

  /**
   * 🔥 CRITICAL FOR RECOVERY: Add cost to an epic
   * This tracks costs per-epic for accurate reporting
   */
  async addEpicCost(
    taskId: string,
    epicId: string,
    cost: number,
    tokens?: { input: number; output: number }
  ): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    // Initialize epics if not present
    if (!map.epics) map.epics = [];

    const epic = map.epics.find(e => e.epicId === epicId);
    if (!epic) {
      // Epic not found - add to total cost anyway
      console.warn(`⚠️ [UnifiedMemory] addEpicCost() - Epic "${epicId}" not found, adding to total only`);
    } else {
      // Update epic cost
      epic.cost = (epic.cost || 0) + cost;
      if (tokens) {
        if (!epic.tokens) epic.tokens = { input: 0, output: 0 };
        epic.tokens.input += tokens.input;
        epic.tokens.output += tokens.output;
      }
    }

    // Also update total cost
    map.totalCost = (map.totalCost || 0) + cost;
    map.totalTokens = (map.totalTokens || 0) + (tokens?.input || 0) + (tokens?.output || 0);

    await this.updateExecutionMap(taskId, {
      epics: map.epics,
      totalCost: map.totalCost,
      totalTokens: map.totalTokens,
    }, `[Cost] +$${cost.toFixed(4)} (total: $${map.totalCost.toFixed(4)})`);

    console.log(`💰 [UnifiedMemory] Added cost $${cost.toFixed(4)} to epic ${epicId} (total: $${map.totalCost.toFixed(4)})`);
  }

  /**
   * Get PR info for an epic
   */
  async getEpicPR(taskId: string, epicId: string): Promise<{ prUrl?: string; prNumber?: number } | null> {
    const map = await this.getExecutionMap(taskId);
    if (!map?.epics) return null;

    const epic = map.epics.find(e => e.epicId === epicId);
    return epic ? { prUrl: epic.prUrl, prNumber: epic.prNumber } : null;
  }

  // ==================== RESUMPTION LOGIC ====================

  /**
   * THE KEY METHOD: Get exact resumption point for a task
   * This replaces all scattered shouldSkip() logic
   */
  async getResumptionPoint(taskId: string): Promise<ResumptionPoint> {
    const map = await this.getExecutionMap(taskId);

    if (!map) {
      return {
        shouldResume: false,
        completedPhases: [],
        completedEpics: [],
        completedStories: [],
        pendingActions: [],
        executionMap: null,
      };
    }

    // Get completed phases - defensive null check
    const completedPhases = Object.entries(map.phases || {})
      .filter(([_, phase]) => phase?.status === 'completed')
      .map(([name]) => name);

    // Get completed epics - defensive null check
    const completedEpics = (map.epics || [])
      .filter(e => e?.status === 'completed')
      .map(e => e.epicId);

    // Get completed stories - defensive null check on epic.stories
    const completedStories: string[] = [];
    for (const epic of (map.epics || [])) {
      for (const story of (epic?.stories || [])) {
        if (story?.status === 'completed') {
          completedStories.push(story.storyId);
        }
      }
    }

    // Determine resumption point
    let resumeFromPhase: string | undefined;
    let resumeFromEpic: string | undefined;
    let resumeFromStory: string | undefined;

    // Find the first incomplete phase
    const phaseOrder = ['planning', 'tech-lead', 'development', 'judge', 'merge'];
    const phases = map.phases || {};
    for (const phase of phaseOrder) {
      const phaseExec = phases[phase];
      if (!phaseExec || phaseExec.status !== 'completed') {
        resumeFromPhase = phase;
        break;
      }
    }

    // If in development phase, find incomplete epic/story
    if (resumeFromPhase === 'development' || resumeFromPhase === 'judge') {
      for (const epic of (map.epics || [])) {
        if (epic?.status !== 'completed') {
          resumeFromEpic = epic.epicId;

          // Find first incomplete story
          for (const story of (epic.stories || [])) {
            if (story?.status !== 'completed') {
              resumeFromStory = story.storyId;
              break;
            }
          }
          break;
        }
      }
    }

    const pendingActions: string[] = [];
    if (resumeFromPhase) pendingActions.push(`Continue from phase: ${resumeFromPhase}`);
    if (resumeFromEpic) pendingActions.push(`Continue from epic: ${resumeFromEpic}`);
    if (resumeFromStory) pendingActions.push(`Continue from story: ${resumeFromStory}`);

    return {
      shouldResume: completedPhases.length > 0 || completedStories.length > 0,
      resumeFromPhase,
      resumeFromEpic,
      resumeFromStory,
      completedPhases,
      completedEpics,
      completedStories,
      pendingActions,
      executionMap: map,
    };
  }

  /**
   * Check if a specific phase should be skipped
   */
  async shouldSkipPhase(taskId: string, phaseType: string): Promise<boolean> {
    const point = await this.getResumptionPoint(taskId);
    return point.completedPhases.includes(phaseType);
  }

  /**
   * Check if a specific epic should be skipped
   */
  async shouldSkipEpic(taskId: string, epicId: string): Promise<boolean> {
    const point = await this.getResumptionPoint(taskId);
    return point.completedEpics.includes(epicId);
  }

  /**
   * Check if a specific story should be skipped
   */
  async shouldSkipStory(taskId: string, storyId: string): Promise<boolean> {
    const point = await this.getResumptionPoint(taskId);
    return point.completedStories.includes(storyId);
  }

  // ==================== SYNC OPERATIONS ====================

  /**
   * Sync execution map to local file
   * 🔥 IMPORTANT: Saves OUTSIDE the client's repo to avoid polluting their codebase
   * Location: {workspacePath}/.agent-memory/ (not inside the cloned repos)
   *
   * 🔒 ROBUSTNESS: Uses atomic writes + checkpoints for crash recovery
   */
  private async syncToLocal(
    workspacePath: string,
    _targetRepository: string, // No longer used - we save outside repos
    map: ExecutionMap
  ): Promise<void> {
    try {
      // 🔥 Save OUTSIDE the client's repo - in workspace root
      const memoryDir = path.join(workspacePath, '.agent-memory');

      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
      }

      // 🔒 ATOMIC WRITE: Use temp file + rename pattern for crash safety
      const filePath = path.join(memoryDir, 'execution-map.json');
      const writeResult = atomicWriteJsonSync(filePath, map);

      if (!isOk(writeResult)) {
        // Fallback: try direct write if atomic fails
        console.warn(`⚠️ [UnifiedMemory] Atomic write failed, using fallback: ${writeResult.message}`);
        fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf8');
      }

      // 🔒 CHECKPOINT: Save checkpoint for recovery
      const checkpointResult = saveCheckpoint(memoryDir, 'execution-map', map);
      if (!isOk(checkpointResult)) {
        console.warn(`⚠️ [UnifiedMemory] Checkpoint save failed: ${checkpointResult.message}`);
      }

      // Also write a human-readable summary (non-critical, ok if fails)
      const summaryPath = path.join(memoryDir, 'execution-summary.md');
      const summary = this.generateSummary(map);
      const summaryResult = atomicWriteFileSync(summaryPath, summary);
      if (!isOk(summaryResult)) {
        // Silent fail for summary - it's just for debugging
        fs.writeFileSync(summaryPath, summary, 'utf8');
      }

      console.log(`💾 [UnifiedMemory] Saved to local (atomic): ${memoryDir}`);
    } catch (error: any) {
      console.error(`❌ [UnifiedMemory] CRITICAL: Failed to sync to local: ${error.message}`);
      // Re-throw on critical failures - caller needs to know
      throw error;
    }
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(map: ExecutionMap): string {
    const lines: string[] = [];
    lines.push('# Execution Summary');
    lines.push('');
    lines.push(`**Task ID:** ${map.taskId}`);
    lines.push(`**Status:** ${map.status}`);
    lines.push(`**Current Phase:** ${map.currentPhase}`);
    lines.push(`**Started:** ${map.startedAt}`);
    lines.push(`**Last Updated:** ${map.lastUpdatedAt}`);
    lines.push('');

    lines.push('## Phases');
    lines.push('');
    for (const [name, phase] of Object.entries(map.phases || {})) {
      const icon = phase?.status === 'completed' ? '✅' :
                   phase?.status === 'in_progress' ? '🔄' :
                   phase?.status === 'failed' ? '❌' : '⏸️';
      lines.push(`- ${icon} **${name}**: ${phase?.status || 'unknown'}`);
    }
    lines.push('');

    const epics = map.epics || [];
    if (epics.length > 0) {
      lines.push('## Epics');
      lines.push('');
      for (const epic of epics) {
        const icon = epic?.status === 'completed' ? '✅' :
                     epic?.status === 'in_progress' ? '🔄' : '⬜';
        const stories = epic?.stories || [];
        const completed = stories.filter(s => s?.status === 'completed').length;
        lines.push(`### ${icon} ${epic?.title || 'Unknown'} (${epic?.epicId || 'unknown'})`);
        lines.push(`Stories: ${completed}/${stories.length}`);
        lines.push('');
        for (const story of stories) {
          const sIcon = story?.status === 'completed' ? '✅' :
                        story?.status === 'in_progress' ? '🔄' :
                        story?.status === 'failed' ? '❌' : '⬜';
          lines.push(`- ${sIcon} ${story?.title || 'Unknown'} (${story?.storyId || 'unknown'})`);
        }
        lines.push('');
      }
    }

    const errors = map.errors || [];
    if (errors.length > 0) {
      lines.push('## Errors');
      lines.push('');
      for (const error of errors) {
        lines.push(`- ❌ ${error}`);
      }
    }

    lines.push('');
    lines.push(`---`);
    lines.push(`Total Cost: $${(map.totalCost || 0).toFixed(4)}`);
    lines.push(`Total Tokens: ${map.totalTokens || 0}`);

    return lines.join('\n');
  }

  // ==================== COST TRACKING ====================

  /**
   * Add cost and tokens to the execution
   */
  async addCost(taskId: string, cost: number, tokens: number): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map) return;

    await this.updateExecutionMap(taskId, {
      totalCost: map.totalCost + cost,
      totalTokens: map.totalTokens + tokens,
    });
  }

  // ==================== ERROR DETECTIVE ====================

  /**
   * 🔍 Classify an error based on its message and context
   * Uses pattern matching to determine the error code
   */
  classifyError(error: any, _context?: { phase?: string }): ErrorCode {
    const errorStr = String(error?.message || error || '').toLowerCase();

    // API/Service errors
    if (errorStr.includes('billing') || errorStr.includes('payment') || errorStr.includes('credit') || errorStr.includes('402')) {
      return 'API_BILLING';
    }
    if (errorStr.includes('rate limit') || errorStr.includes('rate_limit') || errorStr.includes('429')) {
      return 'API_RATE_LIMIT';
    }
    if (errorStr.includes('timeout') || errorStr.includes('timed out') || errorStr.includes('etimedout')) {
      return 'API_TIMEOUT';
    }
    if (errorStr.includes('unauthorized') || errorStr.includes('authentication') || errorStr.includes('401') || errorStr.includes('api key')) {
      return 'API_AUTHENTICATION';
    }
    if (errorStr.includes('overloaded') || errorStr.includes('503') || errorStr.includes('service unavailable')) {
      return 'API_OVERLOADED';
    }

    // Git errors
    if (errorStr.includes('conflict') || errorStr.includes('merge conflict')) {
      return 'GIT_CONFLICT';
    }
    if (errorStr.includes('push rejected') || errorStr.includes('non-fast-forward') || errorStr.includes('pre-receive hook')) {
      return 'GIT_PUSH_REJECTED';
    }
    if (errorStr.includes('branch') && (errorStr.includes('not found') || errorStr.includes("doesn't exist"))) {
      return 'GIT_BRANCH_NOT_FOUND';
    }

    // Build/Test errors
    if (errorStr.includes('build failed') || errorStr.includes('compilation') || errorStr.includes('tsc') || errorStr.includes('typescript error')) {
      return 'BUILD_FAILURE';
    }
    if (errorStr.includes('test failed') || errorStr.includes('assertion') || errorStr.includes('jest') || errorStr.includes('mocha')) {
      return 'TEST_FAILURE';
    }
    if (errorStr.includes('eslint') || errorStr.includes('lint error') || errorStr.includes('prettier')) {
      return 'LINT_FAILURE';
    }

    // File/System errors
    if (errorStr.includes('enoent') || errorStr.includes('file not found') || errorStr.includes('no such file')) {
      return 'FILE_NOT_FOUND';
    }
    if (errorStr.includes('permission denied') || errorStr.includes('eacces') || errorStr.includes('eperm')) {
      return 'PERMISSION_DENIED';
    }
    if (errorStr.includes('network') || errorStr.includes('econnrefused') || errorStr.includes('enotfound')) {
      return 'NETWORK_ERROR';
    }
    if (errorStr.includes('out of memory') || errorStr.includes('heap') || errorStr.includes('memory')) {
      return 'MEMORY_EXCEEDED';
    }
    if (errorStr.includes('context') && (errorStr.includes('overflow') || errorStr.includes('too large') || errorStr.includes('exceeded'))) {
      return 'CONTEXT_OVERFLOW';
    }

    // Parse/Validation errors
    if (errorStr.includes('json') || errorStr.includes('parse') || errorStr.includes('syntax error')) {
      return 'PARSE_ERROR';
    }
    if (errorStr.includes('validation') || errorStr.includes('schema') || errorStr.includes('invalid')) {
      return 'VALIDATION_ERROR';
    }
    if (errorStr.includes('module not found') || errorStr.includes('cannot find module') || errorStr.includes('npm') || errorStr.includes('package')) {
      return 'DEPENDENCY_MISSING';
    }

    return 'UNKNOWN';
  }

  /**
   * 🔍 Generate hypothesis based on error code
   */
  private generateHypothesis(errorCode: ErrorCode, _context?: { phase?: string; agentType?: string }): string {
    const hypotheses: Record<ErrorCode, string> = {
      'API_BILLING': 'API credits are exhausted or payment method has failed. Check Anthropic billing dashboard.',
      'API_RATE_LIMIT': 'Too many requests sent in a short period. Consider implementing backoff or reducing parallelism.',
      'API_TIMEOUT': 'The request took too long, possibly due to complex prompts or API slowdown.',
      'API_AUTHENTICATION': 'API key is invalid, expired, or lacks required permissions.',
      'API_OVERLOADED': 'The API service is experiencing high load. Retry with exponential backoff.',
      'GIT_CONFLICT': 'Multiple changes to the same files created merge conflicts. Manual resolution may be needed.',
      'GIT_PUSH_REJECTED': 'Remote rejected the push - check branch protection rules, hooks, or if force push is needed.',
      'GIT_BRANCH_NOT_FOUND': 'The target branch does not exist. It may need to be created first.',
      'BUILD_FAILURE': 'Code compilation failed. Check TypeScript/build errors in the output.',
      'TEST_FAILURE': 'One or more tests failed. Review test output for assertion failures.',
      'LINT_FAILURE': 'Code style violations detected. Run linter with --fix or review errors.',
      'VALIDATION_ERROR': 'Input data does not match expected schema. Check data format.',
      'FILE_NOT_FOUND': 'A required file is missing. Check file paths and ensure file exists.',
      'PERMISSION_DENIED': 'Insufficient permissions to access file or resource.',
      'NETWORK_ERROR': 'Network connectivity issue. Check internet connection and firewall.',
      'MEMORY_EXCEEDED': 'Process ran out of memory. Consider increasing heap size or optimizing memory usage.',
      'CONTEXT_OVERFLOW': 'Agent context window exceeded. Use context compaction or split the task.',
      'PARSE_ERROR': 'Failed to parse response or file. Check for malformed JSON or syntax errors.',
      'DEPENDENCY_MISSING': 'Required package not installed. Run npm install or check package.json.',
      'RUNTIME_ERROR': 'Unexpected runtime error occurred during execution.',
      'UNKNOWN': 'Error could not be automatically classified. Manual investigation required.',
    };

    return hypotheses[errorCode] || hypotheses['UNKNOWN'];
  }

  /**
   * 🔍 Determine severity based on error code and context
   */
  private determineSeverity(errorCode: ErrorCode): 'critical' | 'high' | 'medium' | 'low' {
    const criticalErrors: ErrorCode[] = ['API_BILLING', 'API_AUTHENTICATION', 'MEMORY_EXCEEDED'];
    const highErrors: ErrorCode[] = ['API_RATE_LIMIT', 'GIT_CONFLICT', 'BUILD_FAILURE', 'CONTEXT_OVERFLOW'];
    const mediumErrors: ErrorCode[] = ['TEST_FAILURE', 'GIT_PUSH_REJECTED', 'VALIDATION_ERROR', 'DEPENDENCY_MISSING'];

    if (criticalErrors.includes(errorCode)) return 'critical';
    if (highErrors.includes(errorCode)) return 'high';
    if (mediumErrors.includes(errorCode)) return 'medium';
    return 'low';
  }

  /**
   * 🔍 Determine if error is recoverable
   */
  private isRecoverable(errorCode: ErrorCode): boolean {
    const nonRecoverable: ErrorCode[] = ['API_BILLING', 'API_AUTHENTICATION', 'PERMISSION_DENIED'];
    return !nonRecoverable.includes(errorCode);
  }

  /**
   * 🔍 ERROR DETECTIVE: Save a detailed error with full analysis
   *
   * This is the main entry point for recording errors with Error Detective methodology.
   * Automatically classifies errors, generates hypotheses, and suggests fixes.
   */
  async saveDetailedError(
    taskId: string,
    params: {
      phase: string;
      error: any;                     // Original error object
      epicId?: string;
      storyId?: string;
      agentType?: string;
      lastSuccessfulAction?: string;
      currentAction?: string;
      inputData?: any;
      // Optional overrides for auto-generated values
      errorCodeOverride?: ErrorCode;
      hypothesisOverride?: string;
      suggestedFixes?: string[];
    }
  ): Promise<DetailedError | null> {
    const map = await this.getExecutionMap(taskId);
    if (!map) {
      console.warn(`⚠️ [ErrorDetective] Cannot save error - no execution map for task ${taskId}`);
      return null;
    }

    // Extract error info
    const errorMessage = params.error?.message || String(params.error);
    const errorStack = params.error?.stack;

    // Auto-classify if not overridden
    const errorCode = params.errorCodeOverride || this.classifyError(params.error, { phase: params.phase });

    // Generate ID
    const errorId = `err-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    // Build the detailed error
    const detailedError: DetailedError = {
      id: errorId,
      timestamp: new Date(),
      phase: params.phase,
      agentType: params.agentType,
      epicId: params.epicId,
      storyId: params.storyId,
      errorCode,
      message: errorMessage,
      originalError: typeof params.error === 'object' ? JSON.stringify(params.error, null, 2) : String(params.error),
      stack: errorStack,
      context: {
        lastSuccessfulAction: params.lastSuccessfulAction,
        currentAction: params.currentAction,
        inputData: params.inputData,
        environmentInfo: {
          nodeVersion: process.version,
          memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024, // MB
        },
      },
      hypothesis: params.hypothesisOverride || this.generateHypothesis(errorCode, { phase: params.phase, agentType: params.agentType }),
      evidence: this.gatherEvidence(params.error, errorCode),
      suggestedFixes: params.suggestedFixes || this.generateSuggestedFixes(errorCode),
      severity: this.determineSeverity(errorCode),
      recoverable: this.isRecoverable(errorCode),
      requiresHumanIntervention: !this.isRecoverable(errorCode) || this.determineSeverity(errorCode) === 'critical',
      resolved: false,
    };

    // Find similar past errors
    detailedError.relatedErrors = await this.findSimilarErrorIds(taskId, errorCode);

    // Initialize detailedErrors array if not present
    if (!map.detailedErrors) map.detailedErrors = [];

    // Add to detailed errors
    map.detailedErrors.push(detailedError);

    // Also add to simple errors list for backward compatibility
    if (!map.errors) map.errors = [];
    map.errors.push(`[${params.phase}] ${errorCode}: ${errorMessage.substring(0, 100)}`);

    // Save
    await this.updateExecutionMap(taskId, {
      detailedErrors: map.detailedErrors,
      errors: map.errors,
    });

    console.log(`🔍 [ErrorDetective] Saved error ${errorId}: ${errorCode} (${detailedError.severity})`);
    console.log(`   Hypothesis: ${detailedError.hypothesis}`);
    if (detailedError.suggestedFixes?.length) {
      console.log(`   Suggested fixes: ${detailedError.suggestedFixes.join(', ')}`);
    }

    return detailedError;
  }

  /**
   * 🔍 Gather evidence for the error
   */
  private gatherEvidence(error: any, errorCode: ErrorCode): string[] {
    const evidence: string[] = [];

    // Add error-specific evidence
    if (error?.status) evidence.push(`HTTP Status: ${error.status}`);
    if (error?.code) evidence.push(`Error Code: ${error.code}`);
    if (error?.response?.data) evidence.push(`Response: ${JSON.stringify(error.response.data).substring(0, 200)}`);

    // Code-specific evidence
    switch (errorCode) {
      case 'API_BILLING':
        evidence.push('Error contains billing/payment/credit keywords');
        evidence.push('HTTP 402 Payment Required');
        break;
      case 'API_RATE_LIMIT':
        evidence.push('Error contains rate limit keywords');
        evidence.push('HTTP 429 Too Many Requests');
        break;
      case 'BUILD_FAILURE':
        evidence.push('Build command exited with non-zero code');
        break;
      case 'TEST_FAILURE':
        evidence.push('Test runner reported failures');
        break;
    }

    return evidence;
  }

  /**
   * 🔍 Generate suggested fixes based on error code
   */
  private generateSuggestedFixes(errorCode: ErrorCode): string[] {
    const fixes: Record<ErrorCode, string[]> = {
      'API_BILLING': [
        'Check Anthropic billing dashboard',
        'Add credits to account',
        'Verify payment method is valid',
      ],
      'API_RATE_LIMIT': [
        'Implement exponential backoff',
        'Reduce parallel API calls',
        'Wait before retrying',
      ],
      'API_TIMEOUT': [
        'Retry with smaller context',
        'Split task into smaller chunks',
        'Check API status page',
      ],
      'API_AUTHENTICATION': [
        'Verify ANTHROPIC_API_KEY is set',
        'Check API key permissions',
        'Regenerate API key if needed',
      ],
      'API_OVERLOADED': [
        'Retry with exponential backoff',
        'Check Anthropic status page',
        'Wait for service recovery',
      ],
      'GIT_CONFLICT': [
        'Pull latest changes',
        'Resolve conflicts manually',
        'Retry merge after resolution',
      ],
      'GIT_PUSH_REJECTED': [
        'Pull and rebase before pushing',
        'Check branch protection rules',
        'Verify git credentials',
      ],
      'GIT_BRANCH_NOT_FOUND': [
        'Create the branch first',
        'Check branch name spelling',
        'Fetch remote branches',
      ],
      'BUILD_FAILURE': [
        'Review TypeScript errors',
        'Run npm run type-check locally',
        'Fix type errors before retry',
      ],
      'TEST_FAILURE': [
        'Review test output',
        'Fix failing assertions',
        'Run tests locally to debug',
      ],
      'LINT_FAILURE': [
        'Run npm run lint:fix',
        'Fix remaining lint errors manually',
        'Check .eslintrc configuration',
      ],
      'VALIDATION_ERROR': [
        'Check input data format',
        'Verify schema requirements',
        'Review validation error details',
      ],
      'FILE_NOT_FOUND': [
        'Verify file path is correct',
        'Check if file was created',
        'Ensure working directory is correct',
      ],
      'PERMISSION_DENIED': [
        'Check file permissions',
        'Run with appropriate privileges',
        'Verify user has access',
      ],
      'NETWORK_ERROR': [
        'Check internet connection',
        'Verify firewall settings',
        'Try again after connection restored',
      ],
      'MEMORY_EXCEEDED': [
        'Increase Node.js heap size',
        'Optimize memory usage',
        'Process data in smaller chunks',
      ],
      'CONTEXT_OVERFLOW': [
        'Use context compaction',
        'Split task into smaller parts',
        'Reduce context window content',
      ],
      'PARSE_ERROR': [
        'Check JSON syntax',
        'Verify response format',
        'Add error handling for malformed input',
      ],
      'DEPENDENCY_MISSING': [
        'Run npm install',
        'Check package.json dependencies',
        'Verify package name is correct',
      ],
      'RUNTIME_ERROR': [
        'Check error stack trace',
        'Add debugging logs',
        'Review recent code changes',
      ],
      'UNKNOWN': [
        'Review full error message',
        'Check logs for more context',
        'Manual investigation required',
      ],
    };

    return fixes[errorCode] || fixes['UNKNOWN'];
  }

  /**
   * 🔍 Find similar error IDs from past errors
   */
  private async findSimilarErrorIds(taskId: string, errorCode: ErrorCode): Promise<string[]> {
    const map = await this.getExecutionMap(taskId);
    if (!map?.detailedErrors) return [];

    return map.detailedErrors
      .filter(e => e.errorCode === errorCode && e.id)
      .map(e => e.id)
      .slice(-5); // Return last 5 similar errors
  }

  /**
   * 🔍 Get all detailed errors for a task
   */
  async getDetailedErrors(taskId: string): Promise<DetailedError[]> {
    const map = await this.getExecutionMap(taskId);
    return map?.detailedErrors || [];
  }

  /**
   * 🔍 Get errors filtered by severity
   */
  async getErrorsBySeverity(taskId: string, severity: 'critical' | 'high' | 'medium' | 'low'): Promise<DetailedError[]> {
    const errors = await this.getDetailedErrors(taskId);
    return errors.filter(e => e.severity === severity);
  }

  /**
   * 🔍 Get unresolved errors
   */
  async getUnresolvedErrors(taskId: string): Promise<DetailedError[]> {
    const errors = await this.getDetailedErrors(taskId);
    return errors.filter(e => !e.resolved);
  }

  /**
   * 🔍 Mark an error as resolved
   */
  async resolveError(taskId: string, errorId: string, notes?: string): Promise<void> {
    const map = await this.getExecutionMap(taskId);
    if (!map?.detailedErrors) return;

    const error = map.detailedErrors.find(e => e.id === errorId);
    if (error) {
      error.resolved = true;
      error.resolvedAt = new Date();
      error.resolutionNotes = notes;

      await this.updateExecutionMap(taskId, {
        detailedErrors: map.detailedErrors,
      });

      console.log(`✅ [ErrorDetective] Error ${errorId} resolved`);
    }
  }

  /**
   * 🔍 Generate error analysis report
   */
  async generateErrorReport(taskId: string): Promise<string> {
    const errors = await this.getDetailedErrors(taskId);

    if (errors.length === 0) {
      return '# Error Report\n\nNo errors recorded for this task.';
    }

    const lines: string[] = [];
    lines.push('# Error Detective Report');
    lines.push('');
    lines.push(`**Task ID:** ${taskId}`);
    lines.push(`**Total Errors:** ${errors.length}`);
    lines.push(`**Unresolved:** ${errors.filter(e => !e.resolved).length}`);
    lines.push('');

    // By severity
    const bySeverity = {
      critical: errors.filter(e => e.severity === 'critical'),
      high: errors.filter(e => e.severity === 'high'),
      medium: errors.filter(e => e.severity === 'medium'),
      low: errors.filter(e => e.severity === 'low'),
    };

    lines.push('## Summary by Severity');
    lines.push('');
    lines.push(`- 🔴 Critical: ${bySeverity.critical.length}`);
    lines.push(`- 🟠 High: ${bySeverity.high.length}`);
    lines.push(`- 🟡 Medium: ${bySeverity.medium.length}`);
    lines.push(`- 🟢 Low: ${bySeverity.low.length}`);
    lines.push('');

    // Detailed errors
    lines.push('## Error Details');
    lines.push('');

    for (const error of errors) {
      const icon = error.resolved ? '✅' : error.severity === 'critical' ? '🔴' : error.severity === 'high' ? '🟠' : '🟡';
      lines.push(`### ${icon} ${error.errorCode} (${error.id})`);
      lines.push('');
      lines.push(`**Phase:** ${error.phase}`);
      lines.push(`**Time:** ${error.timestamp}`);
      lines.push(`**Severity:** ${error.severity}`);
      lines.push(`**Recoverable:** ${error.recoverable ? 'Yes' : 'No'}`);
      lines.push('');
      lines.push(`**Message:** ${error.message}`);
      lines.push('');
      lines.push(`**Hypothesis:** ${error.hypothesis}`);
      lines.push('');
      if (error.evidence?.length) {
        lines.push('**Evidence:**');
        for (const e of error.evidence) {
          lines.push(`- ${e}`);
        }
        lines.push('');
      }
      if (error.suggestedFixes?.length) {
        lines.push('**Suggested Fixes:**');
        for (const fix of error.suggestedFixes) {
          lines.push(`- ${fix}`);
        }
        lines.push('');
      }
      if (error.resolved) {
        lines.push(`**Resolution:** ${error.resolutionNotes || 'Resolved'}`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }

    return lines.join('\n');
  }

  // ==================== LEGACY BRIDGE ====================

  /**
   * Bridge to granular memory for direct access
   * Use sparingly - prefer the unified methods above
   */
  get granular() {
    return granularMemoryService;
  }
}

// Export singleton
export const unifiedMemoryService = UnifiedMemoryService.getInstance();
