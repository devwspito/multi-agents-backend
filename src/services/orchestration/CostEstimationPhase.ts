import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { RealisticCostEstimator } from '../RealisticCostEstimator';

const realisticCostEstimator = new RealisticCostEstimator();

/**
 * Cost Estimation Phase
 *
 * Calculates realistic cost estimates based on repository analysis
 * Saves to task.orchestration.costEstimation (separate from agent steps)
 *
 * This phase ONLY calculates - approval is handled by CostApprovalPhase (generic ApprovalPhase)
 */
export class CostEstimationPhase extends BasePhase {
  readonly name = 'CostEstimation';
  readonly description = 'Calculating cost estimates';

  /**
   * Skip if cost already calculated
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    console.log(`🔍 [CostEstimation shouldSkip] Checking if should skip...`);
    console.log(`   - costEstimation exists: ${!!context.task.orchestration.costEstimation}`);
    console.log(`   - calculatedAt: ${context.task.orchestration.costEstimation?.calculatedAt}`);
    console.log(`   - status: ${context.task.orchestration.costEstimation?.status}`);

    if (context.task.orchestration.costEstimation?.status === 'completed') {
      console.log(`✅ [SKIP] Cost already estimated - status is completed`);
      return true;
    }

    console.log(`❌ [NO SKIP] Cost not yet estimated`);
    return false;
  }

  protected async executePhase(context: OrchestrationContext): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const { task } = context;
    const taskId = (task._id as any).toString();

    console.log('\n💰 =============== COST ESTIMATION PHASE ===============');

    // Get epics from Tech Lead
    const epics = task.orchestration.techLead?.epics || [];
    const totalStories = epics.reduce((sum: number, epic: any) => sum + (epic.stories?.length || 0), 0);

    if (epics.length === 0) {
      console.log('⚠️  No epics found - skipping cost estimation');
      return {
        success: true,
        warnings: ['No epics found, skipping cost estimation']
      };
    }

    console.log(`📊 Analyzing ${epics.length} epics, ${totalStories} stories`);

    // Get repositories and workspace from context
    const repositories = context.repositories || [];
    const workspacePath = context.workspacePath;

    // Calculate REALISTIC cost estimate
    let costEstimate;
    try {
      costEstimate = await realisticCostEstimator.estimateRealistic(
        epics,
        repositories,
        workspacePath
      );
    } catch (error: any) {
      console.error(`❌ [Cost Estimation] Failed:`, error.message);
      console.warn(`⚠️  Using conservative fallback estimate`);

      // Fallback: Conservative estimate
      const conservativeCostPerStory = 0.50;
      const estimatedCost = totalStories * conservativeCostPerStory;

      costEstimate = {
        totalEstimated: estimatedCost,
        totalMinimum: estimatedCost * 0.7,
        totalMaximum: estimatedCost * 1.5,
        breakdown: {
          productManager: 0.05,
          projectManager: 0.05,
          techLead: 0.15,
          developers: estimatedCost * 0.6,
          judge: estimatedCost * 0.1,
          qa: 0.10,
          mergeCoordinator: 0.05
        },
        perStoryEstimate: conservativeCostPerStory,
        storiesCount: totalStories,
        repositoryAnalysis: [],
        historicalData: null,
        estimatedDuration: totalStories * 15,
        confidence: 40,
        warnings: [
          `Cost estimation failed: ${error.message}`,
          'Using conservative fallback estimate',
          'Actual costs may vary significantly'
        ],
        methodology: 'Conservative fallback (estimation service failed)'
      };
    }

    console.log(`\n💵 REALISTIC COST ESTIMATE:`);
    console.log(`   Total: $${costEstimate.totalEstimated.toFixed(2)}`);
    console.log(`   Range: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}`);
    console.log(`   Per story: $${costEstimate.perStoryEstimate.toFixed(2)}`);
    console.log(`   Duration: ${costEstimate.estimatedDuration} minutes`);
    console.log(`   Confidence: ${costEstimate.confidence}%`);
    console.log(`   Methodology: ${costEstimate.methodology}\n`);

    if (costEstimate.warnings.length > 0) {
      console.log(`⚠️  Warnings:`);
      costEstimate.warnings.forEach(w => console.log(`   ${w}`));
      console.log();
    }

    // Initialize costEstimation if not exists
    if (!task.orchestration.costEstimation) {
      task.orchestration.costEstimation = {} as any;
    }

    // Save cost estimation data (like how ProductManagerPhase saves output)
    task.orchestration.costEstimation = {
      status: 'completed',
      calculatedAt: new Date(),
      estimated: costEstimate.totalEstimated,
      minimum: costEstimate.totalMinimum,
      maximum: costEstimate.totalMaximum,
      duration: costEstimate.estimatedDuration,
      confidence: costEstimate.confidence,
      perStory: costEstimate.perStoryEstimate,
      storiesCount: costEstimate.storiesCount,
      methodology: costEstimate.methodology,
      breakdown: costEstimate.breakdown,
      warnings: costEstimate.warnings,
      output: `Cost Estimation Complete\n\nTotal Estimated: $${costEstimate.totalEstimated.toFixed(2)}\nRange: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}\nPer Story: $${costEstimate.perStoryEstimate.toFixed(2)}\nStories: ${costEstimate.storiesCount}\nDuration: ${costEstimate.estimatedDuration} minutes\nConfidence: ${costEstimate.confidence}%\nMethodology: ${costEstimate.methodology}`
    } as any;

    // Mark as modified for Mongoose
    task.markModified('orchestration.costEstimation');

    console.log(`💾 [Debug] About to save costEstimation:`, JSON.stringify({
      status: task.orchestration.costEstimation?.status,
      estimated: task.orchestration.costEstimation?.estimated,
      calculatedAt: task.orchestration.costEstimation?.calculatedAt
    }, null, 2));

    await task.save();

    console.log(`✅ [Cost Estimation] Saved to database`);

    // Verify it was saved
    const TaskModel = require('../../models/Task').Task;
    const verifyTask = await TaskModel.findById(task._id);
    console.log(`🔍 [Verification] costEstimation exists: ${!!verifyTask.orchestration.costEstimation}`);
    if (verifyTask.orchestration.costEstimation) {
      console.log(`🔍 [Verification] status: ${verifyTask.orchestration.costEstimation.status}`);
      console.log(`🔍 [Verification] calculatedAt: ${verifyTask.orchestration.costEstimation.calculatedAt}`);
    } else {
      console.error(`❌ [ERROR] costEstimation was NOT saved to database!`);
    }

    return {
      success: true,
      data: {
        estimated: costEstimate.totalEstimated,
        minimum: costEstimate.totalMinimum,
        maximum: costEstimate.totalMaximum,
        duration: costEstimate.estimatedDuration,
        confidence: costEstimate.confidence
      },
      metrics: {
        cost_estimated: costEstimate.totalEstimated,
        stories_count: costEstimate.storiesCount,
        confidence: costEstimate.confidence
      }
    };
  }
}
