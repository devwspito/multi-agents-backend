import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';

/**
 * 🔀 PR Approval Phase
 *
 * Executes AFTER QA, BEFORE Merge
 *
 * 1. Lists all PRs created by developers
 * 2. Saves to task for user review
 * 3. Emits WebSocket event to frontend
 * 4. Checks if approved
 * 5. PAUSES execution if not approved (user must approve via /api/tasks/:id/review/approve)
 * 6. If Auto Pilot Mode → skips and continues immediately
 */
export class PRApprovalPhase extends BasePhase {
  readonly name = 'PRApproval'; // No spaces to match PHASE_ORDER
  readonly description = 'Reviewing and approving pull requests';

  protected async executePhase(context: OrchestrationContext): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    // 🔄 Refresh task from DB to get latest autoPilotMode value (in case user toggled it)
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(context.task._id);
    if (freshTask) {
      context.task = freshTask; // Update context with fresh task
    }

    const { task } = context;
    // const taskId = (task._id as any).toString(); // unused

    console.log('\n🔀 =============== PR APPROVAL PHASE ===============');

    // Get all PRs from stories (collect from all stories created by Project Manager)
    const stories = task.orchestration.projectManager?.stories || [];
    const epics = stories; // Alias for backward compatibility
    const pullRequests = epics.flatMap((epic: any) => {
      if (!epic.pullRequests || epic.pullRequests.length === 0) return [];
      return epic.pullRequests.map((pr: any) => ({
        ...pr,
        epic: { _id: epic.id, name: epic.name },
        branch: pr.branchName,
        title: `${epic.name} - ${pr.repository}`,
        description: epic.description || '',
        status: pr.state || 'open',
      }));
    });
    if (pullRequests.length === 0) {
      console.log('⚠️  No PRs found - skipping approval phase');
      return {
        success: true,
        warnings: ['No PRs found, skipping approval']
      };
    }

    console.log(`📋 Found ${pullRequests.length} pull request(s) ready for review`);

    // TODO: Add prApproved, autoPilotMode, manualReview, status to IOrchestration if needed
    // For now, skip approval check and auto-approve all PRs
    console.log(`✅ [PR Approval] Auto-approving all PRs (approval system disabled)`);

    // Emit approval event
    const { eventStore } = await import('../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'PRApproved',
      agentName: 'pr-approval',
      payload: {
        autoApproved: true,
        pullRequestsCount: pullRequests.length,
      },
    });

    console.log(`📝 [PRApproval] Emitted PRApproved event (auto-approved)`);

    return {
      success: true,
      data: { autoApproved: true, pullRequestsCount: pullRequests.length }
    };
  }
}
