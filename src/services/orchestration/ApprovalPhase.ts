import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';

/**
 * Approval Phase (Generic)
 *
 * Pauses execution for user approval after agent completion
 *
 * Checks autoPilotMode flag:
 * - If autoPilotMode = true: Skip approval, continue immediately
 * - If autoPilotMode = false: Pause and wait for user approval
 *
 * This phase is used after Product Manager, Project Manager, and Tech Lead
 * to allow human review before proceeding to the next phase.
 */
export class ApprovalPhase extends BasePhase {
  readonly name: string;
  readonly description: string;
  private agentName: string;
  private agentPath: string;

  constructor(agentName: string, agentPath: string) {
    super();
    // Use agentName without spaces to match the switch case names
    // e.g., "Product Manager" -> "ProductManagerApproval"
    this.name = `${agentName.replace(/\s+/g, '')}Approval`;
    this.description = `Waiting for ${agentName.toLowerCase()} approval`;
    this.agentName = agentName;
    this.agentPath = agentPath;
  }

  protected async executePhase(context: OrchestrationContext): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    // 🔄 Refresh task from DB to get latest autoPilotMode value
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(context.task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const { task } = context;
    const taskId = (task._id as any).toString();

    console.log(`\n✋ =============== ${this.agentName.toUpperCase()} APPROVAL ===============`);

    // Navigate to agent data using agentPath
    let agent: any = task;
    const pathParts = this.agentPath.split('.');
    for (const part of pathParts) {
      agent = agent[part];
      if (!agent) {
        return {
          success: false,
          error: `Agent path not found: ${this.agentPath}`
        };
      }
    }

    // 🔥 Check if already approved using simple boolean flag (Mongoose persists reliably)
    if (agent.approved === true) {
      console.log(`✅ [${this.agentName} Approval] Already approved (flag set) - continuing`);
      return {
        success: true,
        data: { alreadyApproved: true }
      };
    }

    // 🚁 Check if auto-pilot mode is enabled (currently disabled - manual approval only)
    const autoPilotMode = false; // TODO: Add autoPilotMode to IOrchestration if needed
    if (autoPilotMode) {
      console.log(`🚁 [Auto Pilot] Skipping ${this.agentName} approval`);
      console.log(`   Auto-approved - continuing to next phase`);

      // Mark as approved automatically
      if (!agent.approval) {
        agent.approval = {};
      }
      agent.approval.status = 'approved';
      agent.approval.approvedAt = new Date();
      agent.approval.approvedBy = task.userId as any;

      // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists reliably)
      agent.approved = true;

      // 🔥 CRITICAL: Mark nested object as modified for Mongoose
      task.markModified(this.agentPath);

      await task.save();

      // 🔥 EVENT SOURCING: Emit approval event
      const { eventStore } = await import('../EventStore');
      const eventType = `${this.agentName.replace(' ', '')}Approved` as any;
      await eventStore.append({
        taskId: task._id as any,
        eventType,
        agentName: this.agentName.toLowerCase().replace(' ', '-'),
        payload: {
          autoApproved: true,
        },
      });

      console.log(`📝 [${this.agentName}] Emitted ${eventType} event (auto-pilot)`);

      return {
        success: true,
        data: { autoApproved: true }
      };
    }

    // NOT AUTO-PILOT - PAUSE FOR APPROVAL
    console.log(`⏸️  [${this.agentName} Approval] Waiting for user approval...`);
    console.log(`👤 User must approve via POST /api/tasks/${taskId}/approve`);

    // Mark as pending approval
    if (!agent.approval) {
      agent.approval = {};
    }
    agent.approval.status = 'pending';
    agent.approval.requestedAt = new Date();

    // TODO: Add status and awaitingApproval fields to interfaces if needed
    // task.orchestration.status = 'pending_approval';
    // task.awaitingApproval = { ... };

    // Set task status to pending while waiting for approval
    // Note: 'paused' is not in TaskStatus type, using 'pending' instead
    task.status = 'pending';

    // 🔥 CRITICAL: Mark nested object as modified for Mongoose
    task.markModified(this.agentPath);

    await task.save();

    // Debug: Log agent output length
    console.log(`📝 [${this.agentName}] Output length: ${agent.output?.length || 0} characters`);
    if (agent.output) {
      console.log(`📝 [${this.agentName}] Output preview: ${agent.output.substring(0, 200)}...`);
    } else {
      console.warn(`⚠️  [${this.agentName}] NO OUTPUT FOUND - agent.output is empty!`);
    }

    // 🔥 CRITICAL: Prepare approval data with ALL required fields
    const approvalData = {
      agentName: this.agentName,
      approvalType: 'planning',
      agentPath: this.agentPath,
      taskId: taskId,
      // Frontend expects structured agentOutput object
      agentOutput: {
        fullResponse: agent.output || 'No output available',
        prompt: `Analyze requirements and define product specifications for: ${task.title}`,
        // Add additional fields if available
        reasoning: agent.reasoning || undefined,
        proposal: agent.proposal || undefined,
      },
    };

    console.log(`\n🔔 [${this.agentName}] Emitting approval_required event with data:`, {
      agentName: approvalData.agentName,
      approvalType: approvalData.approvalType,
      hasOutput: !!approvalData.agentOutput.fullResponse,
      outputLength: approvalData.agentOutput.fullResponse?.length,
    });

    // Emit WebSocket notification with structured output for frontend
    // TODO: Add notifyTaskUpdate method to NotificationService if needed
    // NotificationService.notifyTaskUpdate(taskId, { type: 'approval_required', data: approvalData });

    console.log(`\n⏸️  [${this.agentName} Approval] PAUSED - waiting for user approval`);
    console.log(`   This is NOT an error - orchestration will resume after approval\n`);

    // Return PhaseResult indicating we need approval (this will pause the pipeline cleanly)
    // When user approves, /approve endpoint will call orchestrateTask again
    // and this time approval.approvedAt will exist, so it will continue
    return {
      success: true, // Not a failure - just paused
      needsApproval: true, // THIS FLAG TELLS PIPELINE TO PAUSE
      data: {
        agentName: this.agentName,
        status: 'awaiting_approval'
      }
    };
  }

  async rollback(_context: OrchestrationContext): Promise<void> {
    console.log(`⏪ [${this.agentName} Approval] Rollback (no-op)`);
  }
}
