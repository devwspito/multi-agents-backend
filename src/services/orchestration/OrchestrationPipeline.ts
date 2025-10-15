import { IPhase, OrchestrationContext, PhaseResult } from './Phase';

/**
 * Pipeline Options
 */
export interface IPipelineOptions {
  stopOnFailure?: boolean; // Stop pipeline if a phase fails (default: true)
  continueOnWarning?: boolean; // Continue if phase has warnings (default: true)
}

/**
 * Pipeline Result
 */
export interface IPipelineResult {
  success: boolean;
  completedPhases: number;
  totalPhases: number;
  phaseResults: PhaseResult[];
  duration: number;
  error?: string;
}

/**
 * Orchestration Pipeline
 *
 * Implements Pipeline Pattern for sequential phase execution
 *
 * Features:
 * - Sequential phase execution with shared context
 * - Early termination on failure
 * - Phase skipping support
 * - Comprehensive timing and metrics
 * - Clean separation of concerns
 *
 * Usage:
 * ```typescript
 * const pipeline = new OrchestrationPipeline([
 *   productManagerPhase,
 *   techLeadPhase,
 *   developersPhase,
 *   qaPhase,
 *   mergePhase
 * ]);
 *
 * const result = await pipeline.execute(context);
 * ```
 */
export class OrchestrationPipeline {
  private phases: IPhase[];
  private options: IPipelineOptions;

  constructor(phases: IPhase[], options: IPipelineOptions = {}) {
    this.phases = phases;
    this.options = {
      stopOnFailure: options.stopOnFailure ?? true,
      continueOnWarning: options.continueOnWarning ?? true,
    };
  }

  /**
   * Execute the pipeline
   *
   * Runs all phases in sequence, passing context between them
   */
  async execute(context: OrchestrationContext): Promise<IPipelineResult> {
    const startTime = Date.now();
    const phaseResults: PhaseResult[] = [];
    let completedPhases = 0;

    console.log(`\n[START] Pipeline: Starting orchestration with ${this.phases.length} phases`);

    try {
      for (let i = 0; i < this.phases.length; i++) {
        const phase = this.phases[i];

        console.log(`\n📍 [Pipeline] Phase ${i + 1}/${this.phases.length}: ${phase.name}`);

        // Execute phase
        const result = await phase.execute(context);
        phaseResults.push(result);

        // Check if phase needs approval (PAUSE, not error)
        if (result.needsApproval) {
          completedPhases++;
          console.log(`⏸️  [Pipeline] Phase "${phase.name}" paused - waiting for approval`);
          console.log(`   This is NOT an error - orchestration will resume after user approves`);

          const duration = Date.now() - startTime;
          return {
            success: true, // Not a failure - just paused
            completedPhases,
            totalPhases: this.phases.length,
            phaseResults,
            duration,
            error: undefined, // NO error - this is a normal pause
          };
        }

        if (result.success) {
          completedPhases++;
          console.log(`✅ [Pipeline] Phase "${phase.name}" completed in ${result.duration}ms`);
        } else {
          console.error(
            `❌ [Pipeline] Phase "${phase.name}" failed: ${result.error}`
          );

          // Stop pipeline if configured
          if (this.options.stopOnFailure) {
            console.error(`\n🛑 [Pipeline] Stopping pipeline due to phase failure`);

            const duration = Date.now() - startTime;
            return {
              success: false,
              completedPhases,
              totalPhases: this.phases.length,
              phaseResults,
              duration,
              error: `Phase "${phase.name}" failed: ${result.error}`,
            };
          }
        }

        // Check for warnings
        if (result.warnings && result.warnings.length > 0) {
          console.warn(
            `⚠️  [Pipeline] Phase "${phase.name}" completed with ${result.warnings.length} warnings`
          );
          result.warnings.forEach((w) => console.warn(`  - ${w}`));
        }
      }

      // All phases completed
      const duration = Date.now() - startTime;
      const allSucceeded = phaseResults.every((r) => r.success);

      console.log(`\n✅ [Pipeline] Orchestration complete`);
      console.log(`  Completed: ${completedPhases}/${this.phases.length} phases`);
      console.log(`  Duration: ${(duration / 1000).toFixed(1)}s`);
      console.log(`  Success: ${allSucceeded ? '✅' : '❌'}`);

      return {
        success: allSucceeded,
        completedPhases,
        totalPhases: this.phases.length,
        phaseResults,
        duration,
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`\n❌ [Pipeline] Unexpected error:`, error.message);

      return {
        success: false,
        completedPhases,
        totalPhases: this.phases.length,
        phaseResults,
        duration,
        error: `Pipeline error: ${error.message}`,
      };
    }
  }

  /**
   * Get phase by name
   */
  getPhase(name: string): IPhase | undefined {
    return this.phases.find((p) => p.name === name);
  }

  /**
   * Get all phase names
   */
  getPhaseNames(): string[] {
    return this.phases.map((p) => p.name);
  }

  /**
   * Add phase to pipeline
   */
  addPhase(phase: IPhase): void {
    this.phases.push(phase);
  }

  /**
   * Remove phase from pipeline
   */
  removePhase(name: string): boolean {
    const index = this.phases.findIndex((p) => p.name === name);
    if (index >= 0) {
      this.phases.splice(index, 1);
      return true;
    }
    return false;
  }
}
