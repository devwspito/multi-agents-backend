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

    try {
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

      // Execute the phase
      const result = await this.executePhase(context);

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
