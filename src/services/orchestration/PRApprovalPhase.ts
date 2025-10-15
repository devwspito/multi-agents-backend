import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';

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
    const taskId = (task._id as any).toString();

    console.log('\n🔀 =============== PR APPROVAL PHASE ===============');

    // Get all PRs from epics (collect from all epics)
    const epics = task.orchestration.techLead.epics || [];
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

    // 🔥 Check if already approved using simple boolean flag (Mongoose persists reliably)
    if (task.orchestration.prApproved === true) {
      console.log(`✅ [PR Approval] Already approved (flag set) - continuing to merge`);
      return {
        success: true,
        data: { alreadyApproved: true }
      };
    }

    // 🚁 Check if auto-pilot mode is enabled
    if (task.orchestration.autoPilotMode) {
      console.log(`🚁 [Auto Pilot] Skipping PR approval - auto-approving all PRs`);
      console.log(`   ${pullRequests.length} PR(s) will be merged automatically`);

      // Mark as approved automatically
      task.orchestration.manualReview = {
        status: 'approved',
        approvedAt: new Date(),
        approvedBy: task.userId as any,
        reason: 'Auto-approved by Auto Pilot Mode'
      };

      // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists reliably)
      task.orchestration.prApproved = true;
      task.markModified('orchestration');

      await task.save();

      // 🔥 EVENT SOURCING: Emit approval event
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

      console.log(`📝 [PRApproval] Emitted PRApproved event (auto-pilot)`);

      return {
        success: true,
        data: { autoApproved: true, pullRequestsCount: pullRequests.length }
      };
    }

    // NOT APPROVED YET - PAUSE EXECUTION
    task.orchestration.status = 'pending_approval';
    await task.save();

    console.log(`⏸️  [PR Approval] Waiting for user to review and approve PRs...`);
    console.log(`💡 User must approve via POST /api/tasks/${taskId}/review/approve`);

    // Prepare PR data for frontend
    const prData = pullRequests.map((pr: any) => ({
      number: pr.number,
      title: pr.title,
      description: pr.description || '',
      url: pr.url,
      status: pr.status,
      branch: pr.branch,
      epic: pr.epic ? {
        id: pr.epic._id,
        name: pr.epic.name
      } : null,
      commits: pr.commits?.length || 0,
      filesChanged: pr.filesChanged || 0,
      additions: pr.additions || 0,
      deletions: pr.deletions || 0,
      files: pr.files || []
    }));

    // Log PR summary
    prData.forEach((pr: any, index: number) => {
      console.log(`   ${index + 1}. PR #${pr.number}: ${pr.title}`);
      console.log(`      Branch: ${pr.branch}`);
      console.log(`      Stats: ${pr.filesChanged} files, +${pr.additions}/-${pr.deletions}`);
      if (pr.url) {
        console.log(`      URL: ${pr.url}`);
      }
    });

    // Emit WebSocket event to frontend
    NotificationService.notifyTaskUpdate(taskId, {
      type: 'pr_approval_required',
      data: {
        pullRequests: prData
      }
    });

    console.log(`\n⏸️  [PR Approval] PAUSED - waiting for user approval`);
    console.log(`   This is NOT an error - orchestration will resume after user approves\n`);

    // Return PhaseResult indicating we need approval (pause pipeline cleanly)
    // When user approves, /review/approve endpoint will call orchestrateTask again
    // and this time manualReview.status will be 'approved', so it will continue
    return {
      success: true, // Not a failure - just paused
      needsApproval: true, // THIS FLAG TELLS PIPELINE TO PAUSE
      data: {
        pullRequestsCount: pullRequests.length,
        pullRequests: prData,
        status: 'awaiting_approval'
      }
    };
  }
}
