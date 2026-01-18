import { ITask } from '../../models/Task';

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
    return (context.task._id as any).toString();
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
      console.log(`   ❌ Phase not completed - ${this.name} must execute`);
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
      const { Task } = await import('../../models/Task');
      const task = await Task.findById(context.task._id);
      if (task?.orchestration.cancelRequested) {
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
    const { Task } = await import('../../models/Task');
    const taskId = (context.task._id as any).toString();

    // Map phase names to their MongoDB field paths
    const phaseFieldMap: Record<string, string> = {
      'Planning': 'orchestration.planning',
      'Approval': 'orchestration.approval',
      'TechLead': 'orchestration.techLead',
      'TeamOrchestration': 'orchestration.teamOrchestration',
      'Development': 'orchestration.development',
      'Judge': 'orchestration.judge',
      'AutoMerge': 'orchestration.autoMerge',
    };

    const fieldPath = phaseFieldMap[this.name];
    if (!fieldPath) {
      console.log(`   ℹ️ No MongoDB field mapping for phase: ${this.name}`);
      return;
    }

    try {
      // Update the phase status in MongoDB
      const updateObj: Record<string, any> = {};
      updateObj[`${fieldPath}.status`] = 'completed';
      updateObj[`${fieldPath}.skippedOnRecovery`] = true;
      updateObj[`${fieldPath}.skippedAt`] = new Date();

      await Task.findByIdAndUpdate(taskId, { $set: updateObj });

      console.log(`   ✅ [${this.name}] Synced skipped phase status to MongoDB: ${fieldPath}.status = 'completed'`);

      // 🌿 BRANCH REGISTRY RESTORATION: Restore branches from MongoDB on recovery
      // When phases are skipped, the branchRegistry is empty but MongoDB may have branch info
      const task = await Task.findById(taskId);
      if (task?.orchestration?.branchRegistry) {
        const storedBranches = task.orchestration.branchRegistry as BranchInfo[];
        if (Array.isArray(storedBranches) && storedBranches.length > 0) {
          for (const branch of storedBranches) {
            if (branch.name && !context.branchRegistry.has(branch.name)) {
              context.registerBranch(branch);
            }
          }
          console.log(`   🌿 [${this.name}] Restored ${storedBranches.length} branch(es) from MongoDB to registry`);
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
    const { Task } = await import('../../models/Task');

    // Configurable polling interval (default 5s, can be overridden via env)
    const CANCELLATION_CHECK_INTERVAL_MS = parseInt(process.env.CANCELLATION_CHECK_INTERVAL_MS || '5000', 10);

    let cancelled = false;
    let checkInterval: NodeJS.Timeout | null = null;
    let inFlightCheck: Promise<void> | null = null; // 🔥 Track in-flight DB query

    // Single polling mechanism - check cancellation at configured interval
    const startCancellationChecker = () => {
      checkInterval = setInterval(() => {
        // 🔥 FIX: Track the in-flight promise so cleanup can wait for it
        inFlightCheck = (async () => {
          try {
            const task = await Task.findById(context.task._id, { 'orchestration.cancelRequested': 1 }).lean();
            if (task?.orchestration?.cancelRequested) {
              cancelled = true;
              console.log(`🛑 [${this.name}] Cancellation detected during phase execution`);
              if (checkInterval) clearInterval(checkInterval);
            }
          } catch (err) {
            // Log but don't crash - cancellation check is non-critical
            console.warn(`[${this.name}] Error checking cancellation (non-critical):`, err);
          }
        })();
      }, CANCELLATION_CHECK_INTERVAL_MS);
    };

    // 🔥 FIX: Async cleanup that waits for in-flight checks to complete
    const cleanup = async () => {
      if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
      }
      // Wait for any in-flight database query to complete
      if (inFlightCheck) {
        try {
          await inFlightCheck;
        } catch {
          // Ignore errors during cleanup - query may have failed
        }
        inFlightCheck = null;
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
