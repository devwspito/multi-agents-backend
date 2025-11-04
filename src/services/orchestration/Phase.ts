import { ITask } from '../../models/Task';

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
