/**
 * IntegrationPhase
 *
 * NOTE: This phase is DISABLED. Integration is handled manually or via AutoMergePhase.
 *
 * The phase is kept for backwards compatibility with the orchestrator flow,
 * but always returns skipped=true.
 *
 * If you need to re-enable this phase, refer to git history for the original
 * implementation which included:
 * - Branch analysis and merge ordering
 * - Conflict resolution strategies (barrel files, routes, config)
 * - Build validation and auto-fix
 */

import {
  BasePhase,
  OrchestrationContext,
  PhaseResult,
} from './Phase';

export class IntegrationPhase extends BasePhase {
  readonly name = 'IntegrationPhase';
  readonly description = 'Integrates all epic branches into main (DISABLED - handled by AutoMergePhase)';

  /**
   * Main phase execution - DISABLED
   * Always returns skipped=true as integration is handled by AutoMergePhase
   */
  protected async executePhase(
    _context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    console.log(`\n⏭️  [IntegrationPhase] SKIPPED - Phase disabled, integration handled by AutoMergePhase`);
    return {
      success: true,
      data: { skipped: true, reason: 'IntegrationPhase disabled - integration handled manually or via AutoMerge' },
    };
  }

  /**
   * Check if phase should be skipped
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    // Check if integration was already completed
    const existingResult = context.getPhaseResult('IntegrationPhase');
    if (existingResult?.success) {
      this.logSkipDecision(true, 'Integration already completed');
      return true;
    }

    // Check if there are any epic branches to merge
    const epics = context.getData<any[]>('epics') || [];
    if (epics.length === 0) {
      this.logSkipDecision(true, 'No epics to integrate');
      return true;
    }

    return false;
  }
}

export default IntegrationPhase;
