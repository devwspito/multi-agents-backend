import { TaskRepository, ITask } from '../../database/repositories/TaskRepository.js';

/**
 * Orchestration Checkpoint
 *
 * Serializable snapshot of OrchestrationContext state for crash recovery.
 * Saved to SQLite after each phase completes.
 */
export interface OrchestrationCheckpoint {
  branchRegistry: Array<[string, BranchInfo]>;
  sharedData: Record<string, any>;
  phaseResults?: PhaseResult[];
  timestamp: Date;
}

/**
 * Branch Registry Entry
 *
 * Stores branch information for Git operations
 */
export interface BranchInfo {
  name: string;           // Full branch name (e.g., 'epic/xxx' or 'story/xxx')
  type: 'epic' | 'story' | 'feature' | 'hotfix'; // Branch type
  epicId?: string;        // Epic ID if story branch
  storyId?: string;       // Story ID if story branch
  repository: string;     // Repository name
  baseBranch?: string;    // Base branch (usually 'main' or epic branch name)
  createdAt?: Date;       // When branch was created (for persistence)
  created?: boolean;      // Whether branch was created successfully (legacy)
  pushed?: boolean;       // Whether branch was pushed to remote
  merged?: boolean;       // Whether branch was merged to base
}

/**
 * Orchestration Context
 *
 * Shared state passed between phases in the pipeline.
 * Each phase can read from and write to this context.
 */
export class OrchestrationContext {
  task: ITask;
  repositories: any[];
  workspacePath: string | null;
  phaseResults: Map<string, PhaseResult>;
  sharedData: Map<string, any>;
  conversationHistory: any[]; // For context compaction

  // 🌿 Branch Registry - Central source of truth for all Git branches
  branchRegistry: Map<string, BranchInfo>; // key: branch name, value: branch info

  constructor(
    task: ITask,
    repositories: any[] = [],
    workspacePath: string | null = null
  ) {
    this.task = task;
    this.repositories = repositories;
    this.workspacePath = workspacePath;
    this.phaseResults = new Map();
    this.sharedData = new Map();
    this.conversationHistory = []; // Initialize empty conversation history
    this.branchRegistry = new Map(); // Initialize branch registry
  }

  /**
   * Store data to be shared between phases
   */
  setData(key: string, value: any): void {
    this.sharedData.set(key, value);
  }

  /**
   * Retrieve shared data
   */
  getData<T>(key: string): T | undefined {
    return this.sharedData.get(key) as T;
  }

  /**
   * Store phase result
   */
  setPhaseResult(phaseName: string, result: PhaseResult): void {
    this.phaseResults.set(phaseName, result);
  }

  /**
   * Get result from a specific phase
   */
  getPhaseResult(phaseName: string): PhaseResult | undefined {
    return this.phaseResults.get(phaseName);
  }

  /**
   * Check if all phases passed
   */
  allPhasesPassed(): boolean {
    return Array.from(this.phaseResults.values()).every((r) => r.success);
  }

  /**
   * Register a branch in the registry
   */
  registerBranch(branchInfo: BranchInfo): void {
    this.branchRegistry.set(branchInfo.name, branchInfo);
    console.log(`🌿 [Branch Registry] Registered: ${branchInfo.name} (${branchInfo.type}, repo: ${branchInfo.repository})`);
  }

  /**
   * Get branch info by name
   */
  getBranch(branchName: string): BranchInfo | undefined {
    return this.branchRegistry.get(branchName);
  }

  /**
   * Query branches matching a predicate
   */
  private queryBranches(predicate: (b: BranchInfo) => boolean): BranchInfo[] {
    return Array.from(this.branchRegistry.values()).filter(predicate);
  }

  /**
   * Get epic branch for a repository
   */
  getEpicBranch(repository: string): BranchInfo | undefined {
    return this.queryBranches(b => b.type === 'epic' && b.repository === repository)[0];
  }

  /**
   * Get all story branches for an epic
   */
  getStoryBranches(epicId: string, repository?: string): BranchInfo[] {
    return this.queryBranches(b =>
      b.type === 'story' &&
      b.epicId === epicId &&
      (!repository || b.repository === repository)
    );
  }

  /**
   * Mark branch as pushed
   */
  markBranchPushed(branchName: string): void {
    const branch = this.branchRegistry.get(branchName);
    if (branch) {
      branch.pushed = true;
      console.log(`✅ [Branch Registry] Marked ${branchName} as pushed`);
    }
  }

  /**
   * Mark branch as merged
   */
  markBranchMerged(branchName: string): void {
    const branch = this.branchRegistry.get(branchName);
    if (branch) {
      branch.merged = true;
      console.log(`✅ [Branch Registry] Marked ${branchName} as merged`);
    }
  }

  /**
   * Get formatted directives block for inclusion in agent prompts
   *
   * Call this from phases to incorporate user-injected directives
   * into the agent's system prompt.
   *
   * @param agentType - Optional filter for agent-specific directives
   * @returns Formatted markdown block or empty string if no directives
   */
  getDirectivesBlock(agentType?: string): string {
    const directives = this.getData<Array<{ id: string; content: string; priority: string }>>('injectedDirectives');

    if (!directives || directives.length === 0) {
      return '';
    }

    // Filter by agentType if specified
    const filtered = agentType
      ? directives.filter(d => {
          const directive = d as any;
          return !directive.targetAgent || directive.targetAgent === agentType;
        })
      : directives;

    if (filtered.length === 0) {
      return '';
    }

    // Format as markdown block with priority indicators
    const priorityEmoji: Record<string, string> = {
      'critical': '🚨',
      'high': '⚠️',
      'normal': '💡',
      'suggestion': '💭',
    };

    const formattedDirectives = filtered.map(d => {
      const emoji = priorityEmoji[d.priority] || '💡';
      return `${emoji} **[${d.priority.toUpperCase()}]** ${d.content}`;
    }).join('\n\n');

    return `
## 💡 USER DIRECTIVES (PRIORITIZE THESE)

The following instructions were injected by the user mid-execution.
**You MUST prioritize these directives** and incorporate them into your work.

${formattedDirectives}

---

`;
  }

  // ==================== CHECKPOINT METHODS ====================

  /**
   * Keys that are safe to serialize to checkpoint
   * (non-function, non-circular references)
   */
  private static readonly SERIALIZABLE_KEYS = [
    'epics',
    'stories',
    'teamComposition',
    'storyAssignments',
    'architectureDesign',
    'injectedDirectives',
    'environmentConfig',
    'planApproved',
    'planData',
  ];

  /**
   * Serialize context to checkpoint (for persistence)
   * Called after each phase completes
   */
  toCheckpoint(): OrchestrationCheckpoint {
    return {
      branchRegistry: Array.from(this.branchRegistry.entries()),
      sharedData: this.serializeSharedData(),
      phaseResults: Array.from(this.phaseResults.entries()).map(([phaseName, result]) => ({
        ...result,
        phaseName,
      })),
      timestamp: new Date(),
    };
  }

  /**
   * Restore context from checkpoint
   * Called at orchestration start for crash recovery
   */
  restoreFromCheckpoint(checkpoint: OrchestrationCheckpoint): void {
    // Restore branchRegistry
    if (checkpoint.branchRegistry && Array.isArray(checkpoint.branchRegistry)) {
      this.branchRegistry = new Map(checkpoint.branchRegistry);
      console.log(`🔄 [Context] Restored ${this.branchRegistry.size} branches from checkpoint`);
    }

    // Restore phaseResults
    if (checkpoint.phaseResults && Array.isArray(checkpoint.phaseResults)) {
      for (const result of checkpoint.phaseResults) {
        if (result.phaseName) {
          this.phaseResults.set(result.phaseName, result);
        }
      }
      console.log(`🔄 [Context] Restored ${this.phaseResults.size} phase results from checkpoint`);
    }

    // Restore sharedData (only serializable keys)
    this.restoreSharedData(checkpoint.sharedData);

    console.log(`🔄 [Context] Checkpoint restoration complete`);
  }

  /**
   * Serialize sharedData to JSON-safe format
   * Only includes keys that are safe to serialize
   */
  private serializeSharedData(): Record<string, any> {
    const serializable: Record<string, any> = {};

    for (const key of OrchestrationContext.SERIALIZABLE_KEYS) {
      if (this.sharedData.has(key)) {
        const value = this.sharedData.get(key);
        // Only serialize if it's not a function or has circular refs
        try {
          JSON.stringify(value); // Test if serializable
          serializable[key] = value;
        } catch {
          console.warn(`⚠️ [Context] Skipping non-serializable key: ${key}`);
        }
      }
    }

    return serializable;
  }

  /**
   * Restore sharedData from checkpoint
   */
  private restoreSharedData(data: Record<string, any>): void {
    if (!data || typeof data !== 'object') return;

    let restoredCount = 0;
    for (const [key, value] of Object.entries(data)) {
      // Only restore if it's a known serializable key
      if (OrchestrationContext.SERIALIZABLE_KEYS.includes(key)) {
        this.sharedData.set(key, value);
        restoredCount++;
      }
    }

    if (restoredCount > 0) {
      console.log(`🔄 [Context] Restored ${restoredCount} shared data entries from checkpoint`);
    }
  }
}

/**
 * Phase Result
 *
 * Standardized result format returned by each phase
 */
export interface PhaseResult {
  success: boolean;
  phaseName: string;
  duration: number; // milliseconds
  needsApproval?: boolean; // Phase is paused waiting for user approval (NOT an error)
  error?: string;
  warnings?: string[];
  data?: any; // Phase-specific data
  metrics?: {
    [key: string]: number | string;
  };
  metadata?: {
    cost?: number;
    judgeCost?: number;
    input_tokens?: number;
    output_tokens?: number;
    judge_input_tokens?: number;
    judge_output_tokens?: number;
    [key: string]: any;
  };
}

// ==================== PhaseResult Helpers ====================

/**
 * Create a successful phase result
 */
export function createSuccessResult(
  phaseName: string,
  startTime: number,
  data?: any,
  options?: {
    warnings?: string[];
    metrics?: Record<string, number | string>;
    metadata?: Record<string, any>;
  }
): PhaseResult {
  return {
    success: true,
    phaseName,
    duration: Date.now() - startTime,
    data,
    warnings: options?.warnings,
    metrics: options?.metrics,
    metadata: options?.metadata,
  };
}

/**
 * Create a failed phase result
 */
export function createErrorResult(
  phaseName: string,
  startTime: number,
  error: string | Error,
  data?: any
): PhaseResult {
  return {
    success: false,
    phaseName,
    duration: Date.now() - startTime,
    error: typeof error === 'string' ? error : error.message,
    data,
  };
}

/**
 * Create a skipped phase result
 */
export function createSkippedResult(
  phaseName: string,
  startTime: number,
  reason?: string
): PhaseResult {
  return {
    success: true,
    phaseName,
    duration: Date.now() - startTime,
    warnings: [`Phase was skipped${reason ? `: ${reason}` : ''}`],
    data: null,
  };
}

/**
 * Create a phase result that needs approval
 */
export function createApprovalResult(
  phaseName: string,
  startTime: number,
  data?: any
): PhaseResult {
  return {
    success: true,
    phaseName,
    duration: Date.now() - startTime,
    needsApproval: true,
    data,
  };
}

/**
 * Phase Interface
 *
 * Contract that all orchestration phases must implement
 */
export interface IPhase {
  readonly name: string;
  readonly description: string;

  /**
   * Execute the phase
   *
   * @param context - Orchestration context with shared state
   * @returns PhaseResult with execution details
   */
  execute(context: OrchestrationContext): Promise<PhaseResult>;

  /**
   * Check if phase should be skipped
   *
   * @param context - Orchestration context
   * @returns true if phase should be skipped
   */
  shouldSkip?(context: OrchestrationContext): Promise<boolean>;

  /**
   * Cleanup resources after phase execution
   *
   * @param context - Orchestration context
   */
  cleanup?(context: OrchestrationContext): Promise<void>;
}

/**
 * Base Phase
 *
 * Abstract base class providing common functionality for all phases
 */
export abstract class BasePhase implements IPhase {
  abstract readonly name: string;
  abstract readonly description: string;

  /**
   * Check if this is a continuation (requires re-execution)
   * Common helper for shouldSkip implementations
   */
  protected isContinuation(context: OrchestrationContext): boolean {
    const continuations = context.task.orchestration.continuations;
    return !!(continuations && continuations.length > 0);
  }

  /**
   * Get task ID as string (common pattern)
   */
  protected getTaskIdString(context: OrchestrationContext): string {
    return (context.task.id as any).toString();
  }

  /**
   * Log phase skip decision
   * Common helper for shouldSkip implementations
   */
  protected logSkipDecision(skipped: boolean, reason?: string): void {
    if (skipped) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`🎯 [UNIFIED MEMORY] ${this.name} phase already COMPLETED`);
      if (reason) console.log(`   ${reason}`);
      console.log(`${'='.repeat(80)}\n`);
    } else {
      console.log(`   ⏳ Phase pending - ${this.name} must execute`);
    }
  }

  /**
   * Execute the phase with timing and error handling
   */
  async execute(context: OrchestrationContext): Promise<PhaseResult> {
    const startTime = Date.now();

    console.log(`\n🚀 [${this.name}] Starting phase...`);
    console.log(`   ${this.description}`);

    try {
      // 🛑 CHECK FOR CANCELLATION BEFORE EXECUTING PHASE
      const task = TaskRepository.findById(context.task.id);
      if (task?.orchestration?.cancelRequested) {
        const duration = Date.now() - startTime;
        console.log(`🛑 [${this.name}] Task cancelled - aborting phase execution`);
        return {
          success: false,
          phaseName: this.name,
          duration,
          error: 'Task cancelled by user',
        };
      }

      // Check if phase should be skipped
      if (this.shouldSkip && (await this.shouldSkip(context))) {
        const duration = Date.now() - startTime;
        console.log(`⏭️  [${this.name}] Phase skipped`);

        // 🔧 FIX: Sync skipped phase status to MongoDB for downstream validation
        // TeamOrchestrationPhase checks task.orchestration.planning.status
        // When phases are skipped on recovery, this field must also be set
        await this.syncSkippedPhaseToDb(context);

        return {
          success: true,
          phaseName: this.name,
          duration,
          warnings: ['Phase was skipped'],
        };
      }

      // Execute the phase with cancellation polling
      const result = await this.executePhaseWithCancellationCheck(context, startTime);

      const duration = Date.now() - startTime;
      const finalResult: PhaseResult = {
        ...result,
        phaseName: this.name,
        duration,
      };

      // Store result in context
      context.setPhaseResult(this.name, finalResult);

      if (finalResult.success) {
        console.log(`✅ [${this.name}] Phase completed successfully in ${duration}ms`);
      } else {
        console.error(`❌ [${this.name}] Phase failed: ${finalResult.error}`);
      }

      // Cleanup if defined
      if (this.cleanup) {
        await this.cleanup(context);
      }

      return finalResult;
    } catch (error: any) {
      return this.createErrorResult(error, Date.now() - startTime, context);
    }
  }

  /**
   * Create a standardized error result for phase failures
   */
  private createErrorResult(
    error: any,
    duration: number,
    context: OrchestrationContext
  ): PhaseResult {
    console.error(`❌ [${this.name}] Phase error: ${error.message}`);

    const errorResult: PhaseResult = {
      success: false,
      phaseName: this.name,
      duration,
      error: error.message,
    };

    context.setPhaseResult(this.name, errorResult);
    return errorResult;
  }

  /**
   * 🔧 FIX: Sync skipped phase status to MongoDB
   *
   * When a phase is skipped (because Unified Memory says it's completed),
   * we must also update the task.orchestration.[phase] field in MongoDB.
   * This is necessary because downstream phases (like TeamOrchestration)
   * validate phase completion by checking MongoDB, not Unified Memory.
   */
  private async syncSkippedPhaseToDb(context: OrchestrationContext): Promise<void> {
    const taskId = context.task.id;

    // Map phase names to their orchestration fields
    const phaseMap: Record<string, string> = {
      'Sandbox': 'sandbox',
      'Planning': 'planning',
      'Approval': 'approval',
      'TechLead': 'techLead',
      'TeamOrchestration': 'teamOrchestration',
      'Development': 'development',
      'Judge': 'judge',
      'AutoMerge': 'autoMerge',
    };

    const phaseField = phaseMap[this.name];
    if (!phaseField) {
      console.log(`   ℹ️ No field mapping for phase: ${this.name}`);
      return;
    }

    try {
      // Update the phase status in database
      TaskRepository.modifyOrchestration(taskId, (orch) => {
        const phase = (orch as any)[phaseField] || {};
        (orch as any)[phaseField] = {
          ...phase,
          status: 'completed',
          skippedOnRecovery: true,
          skippedAt: new Date(),
        };
        return orch;
      });

      console.log(`   ✅ [${this.name}] Synced skipped phase status to DB: ${phaseField}.status = 'completed'`);

      // 🌿 BRANCH REGISTRY RESTORATION: Restore branches from DB on recovery
      // When phases are skipped, the branchRegistry is empty but DB may have branch info
      const task = TaskRepository.findById(taskId);
      if (task?.orchestration?.branchRegistry) {
        const storedBranches = task.orchestration.branchRegistry as BranchInfo[];
        if (Array.isArray(storedBranches) && storedBranches.length > 0) {
          for (const branch of storedBranches) {
            if (branch.name && !context.branchRegistry.has(branch.name)) {
              context.registerBranch(branch);
            }
          }
          console.log(`   🌿 [${this.name}] Restored ${storedBranches.length} branch(es) from DB to registry`);
        }
      }
    } catch (error: any) {
      console.warn(`   ⚠️ [${this.name}] Failed to sync skipped phase to DB:`, error.message);
      // Don't throw - this is a best-effort sync
    }
  }

  /**
   * Execute phase with periodic cancellation checks
   *
   * Uses a single polling mechanism (configurable interval) to check for cancellation.
   * Optimized to reduce database queries while maintaining responsiveness.
   */
  private async executePhaseWithCancellationCheck(
    context: OrchestrationContext,
    _startTime: number
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    // Configurable polling interval (default 5s, can be overridden via env)
    const CANCELLATION_CHECK_INTERVAL_MS = parseInt(process.env.CANCELLATION_CHECK_INTERVAL_MS || '5000', 10);

    let cancelled = false;
    let checkInterval: NodeJS.Timeout | null = null;

    // Single polling mechanism - check cancellation at configured interval
    const startCancellationChecker = () => {
      checkInterval = setInterval(() => {
        try {
          const task = TaskRepository.findById(context.task.id);
          if (task?.orchestration?.cancelRequested) {
            cancelled = true;
            console.log(`🛑 [${this.name}] Cancellation detected during phase execution`);
            if (checkInterval) clearInterval(checkInterval);
          }
        } catch (err) {
          // Log but don't crash - cancellation check is non-critical
          console.warn(`[${this.name}] Error checking cancellation (non-critical):`, err);
        }
      }, CANCELLATION_CHECK_INTERVAL_MS);
    };

    // Cleanup function to stop the cancellation checker
    const cleanup = () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
    };

    try {
      // Start cancellation checker
      startCancellationChecker();

      // Execute the phase - no additional polling loop needed
      const result = await this.executePhase(context);

      // Check one final time if cancelled during execution
      if (cancelled) {
        await cleanup();
        throw new Error('Task cancelled by user during phase execution');
      }

      await cleanup();
      return result;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  /**
   * Main phase logic - to be implemented by subclasses
   */
  protected abstract executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>>;

  /**
   * Optional: Check if phase should be skipped
   */
  async shouldSkip?(context: OrchestrationContext): Promise<boolean>;

  /**
   * Optional: Cleanup resources
   */
  async cleanup?(context: OrchestrationContext): Promise<void>;
}

// ==================== FIRE-AND-FORGET UTILITIES ====================

/**
 * Fire-and-forget Task update
 *
 * LOCAL-FIRST pattern: Database writes are synchronous but wrapped in try-catch.
 *
 * Use this for non-critical updates like:
 * - Model config changes
 * - Progress updates
 * - Cost/token updates
 *
 * For critical status changes (completed, failed), consider using saveTaskCritical()
 */
export function saveTaskFireAndForget(task: ITask, context?: string): void {
  const taskId = task.id?.toString() || 'unknown';
  try {
    // 🔍 DIAGNOSTIC: Log what we're saving
    const planningStatus = (task.orchestration as any)?.planning?.status;
    const techLeadStatus = (task.orchestration as any)?.techLead?.status;
    console.log(`[Task ${taskId}] Saving orchestration - planning.status=${planningStatus}, techLead.status=${techLeadStatus} (${context || 'no context'})`);

    // SQLite is synchronous, just update the task
    TaskRepository.update(taskId, task);
    console.log(`[Task] Background save OK${context ? ` (${context})` : ''}`);
  } catch (err: any) {
    console.warn(`[Task ${taskId}] Background save failed${context ? ` (${context})` : ''}: ${err.message}`);
  }
}

/**
 * Fire-and-forget Task update by ID
 *
 * Same as saveTaskFireAndForget but for partial updates.
 * Use this when you don't need the updated document back.
 *
 * Supports both direct updates and MongoDB-style operators for backwards compatibility:
 * - $set: Set field values
 * - $unset: Remove fields
 * - $inc: Increment numeric fields
 * - $addToSet: Add to array if not exists
 * - $push: Push to array
 */
export function updateTaskFireAndForget(
  taskId: string,
  update: Partial<ITask> | Record<string, any>,
  context?: string
): void {
  try {
    const hasMongoOperators = '$set' in update || '$unset' in update ||
                               '$inc' in update || '$addToSet' in update ||
                               '$push' in update;

    if (hasMongoOperators) {
      const mongoUpdate = update as Record<string, any>;
      const task = TaskRepository.findById(taskId);
      if (!task) {
        console.warn(`[Task ${taskId}] Not found for update${context ? ` (${context})` : ''}`);
        return;
      }

      // Handle $set - convert dot notation paths to nested updates
      if (mongoUpdate.$set) {
        for (const [path, value] of Object.entries(mongoUpdate.$set)) {
          setNestedValue(task, path, value);
        }
      }

      // Handle $unset - remove properties
      if (mongoUpdate.$unset) {
        for (const path of Object.keys(mongoUpdate.$unset)) {
          setNestedValue(task, path, undefined);
        }
      }

      // Handle $inc - increment values
      if (mongoUpdate.$inc) {
        for (const [path, value] of Object.entries(mongoUpdate.$inc)) {
          const current = getNestedValue(task, path) || 0;
          setNestedValue(task, path, current + (value as number));
        }
      }

      // Handle $addToSet - add to array if not exists
      if (mongoUpdate.$addToSet) {
        for (const [path, value] of Object.entries(mongoUpdate.$addToSet)) {
          const arr = getNestedValue(task, path) || [];
          if (!Array.isArray(arr)) continue;
          if (!arr.includes(value)) {
            arr.push(value);
            setNestedValue(task, path, arr);
          }
        }
      }

      // Handle $push - push to array
      if (mongoUpdate.$push) {
        for (const [path, value] of Object.entries(mongoUpdate.$push)) {
          const arr = getNestedValue(task, path) || [];
          if (!Array.isArray(arr)) continue;
          arr.push(value);
          setNestedValue(task, path, arr);
        }
      }

      TaskRepository.update(taskId, task);
    } else {
      TaskRepository.update(taskId, update as Partial<ITask>);
    }
    console.log(`[Task] Background update OK${context ? ` (${context})` : ''}`);
  } catch (err: any) {
    console.warn(`[Task ${taskId}] Background update failed${context ? ` (${context})` : ''}: ${err.message}`);
  }
}

/**
 * Helper to set a value at a dot-notation path
 */
function setNestedValue(obj: any, path: string, value: any): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] === undefined) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  if (value === undefined) {
    delete current[parts[parts.length - 1]];
  } else {
    current[parts[parts.length - 1]] = value;
  }
}

/**
 * Helper to get a value at a dot-notation path
 */
function getNestedValue(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Critical Task save with error handling
 *
 * Use this for critical status changes where you need to know if it failed,
 * but still don't want to crash the system.
 *
 * Returns true if save succeeded, false if failed.
 */
export async function saveTaskCritical(task: ITask, context?: string): Promise<boolean> {
  const taskId = task.id?.toString() || 'unknown';
  try {
    TaskRepository.update(taskId, task);
    console.log(`[Task] Critical save OK${context ? ` (${context})` : ''}`);
    return true;
  } catch (err: any) {
    console.error(`[Task ${taskId}] Critical save FAILED${context ? ` (${context})` : ''}: ${err.message}`);
    return false;
  }
}
