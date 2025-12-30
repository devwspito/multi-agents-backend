import { ITask } from '../../models/Task';

/**
 * Branch Registry Entry
 *
 * Stores branch information for Git operations
 */
export interface BranchInfo {
  name: string;           // Full branch name (e.g., 'epic/xxx' or 'story/xxx')
  type: 'epic' | 'story'; // Branch type
  epicId?: string;        // Epic ID if story branch
  storyId?: string;       // Story ID if story branch
  repository: string;     // Repository name
  baseBranch: string;     // Base branch (usually 'main' or epic branch name)
  created: boolean;       // Whether branch was created successfully
  pushed: boolean;        // Whether branch was pushed to remote
  merged: boolean;        // Whether branch was merged to base
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
   * Get epic branch for a repository
   */
  getEpicBranch(repository: string): BranchInfo | undefined {
    const branches = Array.from(this.branchRegistry.values());
    for (const branch of branches) {
      if (branch.type === 'epic' && branch.repository === repository) {
        return branch;
      }
    }
    return undefined;
  }

  /**
   * Get all story branches for an epic
   */
  getStoryBranches(epicId: string, repository?: string): BranchInfo[] {
    const stories: BranchInfo[] = [];
    const branches = Array.from(this.branchRegistry.values());
    for (const branch of branches) {
      if (branch.type === 'story' && branch.epicId === epicId) {
        if (!repository || branch.repository === repository) {
          stories.push(branch);
        }
      }
    }
    return stories;
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
   * Execute the phase with timing and error handling
   */
  async execute(context: OrchestrationContext): Promise<PhaseResult> {
    const startTime = Date.now();

    console.log(`\n🚀 [${this.name}] Starting phase...`);
    console.log(`   ${this.description}`);

    // Special logging for Fixer phase
    if (this.name === 'Fixer') {
      console.log(`🔧 [BasePhase] Fixer execute() called - checking context:`, {
        qaErrors: context.getData('qaErrors') ? 'present' : 'missing',
        qaErrorType: context.getData('qaErrorType'),
        qaAttempt: context.getData('qaAttempt')
      });
    }

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
      const duration = Date.now() - startTime;
      console.error(`❌ [${this.name}] Phase error:`, error.message);

      const errorResult: PhaseResult = {
        success: false,
        phaseName: this.name,
        duration,
        error: error.message,
      };

      context.setPhaseResult(this.name, errorResult);
      return errorResult;
    }
  }

  /**
   * Execute phase with periodic cancellation checks
   *
   * This wraps executePhase() and polls the database every 5 seconds
   * to check if the user has requested cancellation.
   */
  private async executePhaseWithCancellationCheck(
    context: OrchestrationContext,
    _startTime: number
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const { Task } = await import('../../models/Task');

    // Create a cancellation checker that polls every 5 seconds
    let cancelled = false;
    const cancellationChecker = setInterval(async () => {
      try {
        const task = await Task.findById(context.task._id);
        if (task?.orchestration.cancelRequested) {
          cancelled = true;
          console.log(`🛑 [${this.name}] Cancellation detected during phase execution`);
          clearInterval(cancellationChecker);
        }
      } catch (err) {
        console.error(`[${this.name}] Error checking cancellation:`, err);
      }
    }, 5000); // Check every 5 seconds

    try {
      // Execute the phase
      const resultPromise = this.executePhase(context);

      // Race between phase completion and cancellation detection
      while (true) {
        if (cancelled) {
          clearInterval(cancellationChecker);
          throw new Error('Task cancelled by user during phase execution');
        }

        // Check if phase is done
        const raceResult = await Promise.race([
          resultPromise,
          new Promise(resolve => setTimeout(() => resolve('__polling__'), 1000))
        ]);

        if (raceResult !== '__polling__') {
          clearInterval(cancellationChecker);
          return raceResult as Omit<PhaseResult, 'phaseName' | 'duration'>;
        }

        // Continue polling
      }
    } catch (error) {
      clearInterval(cancellationChecker);
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
