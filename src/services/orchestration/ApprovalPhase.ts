import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { approvalEvents } from '../ApprovalEvents'; // Event-based approval system
import { NotificationService } from '../NotificationService';

/**
 * Approval Phase
 *
 * Implements human-in-the-loop approval between phases.
 * Uses event-based system (no polling) following SDK best practices.
 *
 * FLOW:
 * 1. Previous phase completes successfully
 * 2. ApprovalPhase pauses orchestration
 * 3. Frontend displays approval UI (Approve/Reject buttons)
 * 4. User approves → emits approval event → orchestration continues
 * 5. User rejects → marks task as failed → orchestration stops
 *
 * SDK COMPLIANCE:
 * ✅ Human feedback loop (core agent pattern)
 * ✅ Event-based (no polling, prevents infinite loops)
 * ✅ Clear verification step before next phase
 * ✅ Graceful failure handling
 *
 * INTEGRATION WITH EXISTING SYSTEM:
 * - Uses approvalEvents from TeamOrchestrator (already implemented)
 * - Frontend already has ApprovalPhase UI (ConsoleViewer.jsx)
 * - Backend routes already emit approval events (/api/tasks/:id/approve/:phase)
 */
export class ApprovalPhase extends BasePhase {
  readonly name = 'Approval';
  readonly description = 'Waiting for human approval before proceeding';

  private readonly MAX_WAIT_TIME_MS = 1 * 60 * 60 * 1000; // 1 hour (reduced from 24 hours for better CI/CD compatibility)

  constructor() {
    super();
  }

  /**
   * Skip if auto-approval is enabled for previous phase
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Get previous phase from context
    const previousPhase = context.getData<string>('currentPhaseName');
    if (!previousPhase) {
      console.log(`[SKIP] No previous phase specified, skipping approval`);
      return true;
    }

    // Check if auto-approval is enabled
    const autoApprovalEnabled = context.task.orchestration.autoApprovalEnabled;
    const autoApprovalPhases = context.task.orchestration.autoApprovalPhases || [];

    // Normalize phase name for comparison (ProductManager -> product-manager)
    const normalizedPhaseName = this.normalizePhase(previousPhase);

    if (autoApprovalEnabled && autoApprovalPhases.includes(normalizedPhaseName as any)) {
      console.log(`✅ [SKIP] Auto-approval enabled for phase: ${previousPhase} (normalized: ${normalizedPhaseName})`);

      const taskId = (context.task._id as any).toString();
      NotificationService.emitConsoleLog(taskId, 'info', `✅ Auto-approval enabled for ${previousPhase} - continuing without human approval`);

      // Log auto-approval in history
      if (!context.task.orchestration.approvalHistory) {
        context.task.orchestration.approvalHistory = [];
      }

      context.task.orchestration.approvalHistory.push({
        phase: previousPhase,
        phaseName: this.getPhaseName(previousPhase),
        approved: true,
        approvedAt: new Date(),
        comments: 'Auto-approved',
        autoApproved: true,
      });

      await context.task.save();

      return true; // Skip human approval
    }

    return false; // Require human approval
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const previousPhase = context.getData<string>('currentPhaseName');

    if (!previousPhase) {
      return {
        success: false,
        error: 'No previous phase specified for approval',
      };
    }

    const phaseName = this.getPhaseName(previousPhase);
    const normalizedPhase = this.normalizePhase(previousPhase); // product-manager

    // Debug logging to understand the mapping
    console.log(`📋 [Approval] Phase mapping: "${previousPhase}" → "${normalizedPhase}" (human: ${phaseName})`);

    console.log(`⏸️  [Approval] Waiting for human approval of: ${phaseName}`);
    NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Waiting for human approval of: ${phaseName}`);

    // Marcar que hay aprobación pendiente para re-emit en join-task
    context.setData('approvalPending', true);

    // Emit WebSocket notification to frontend
    NotificationService.emitApprovalRequired(taskId, {
      phase: normalizedPhase, // Send kebab-case for frontend API call
      phaseName: phaseName,
      agentName: phaseName, // Use human-readable name
      approvalType: 'planning',
      agentOutput: context.getPhaseResult(previousPhase)?.data || {},
    });

    // === WAIT FOR APPROVAL EVENT (event-based, no polling) ===
    try {
      console.log(`📡 [Event] Waiting for approval event: approval:${taskId}:${normalizedPhase}`);

      const approved = await approvalEvents.waitForApproval(
        taskId,
        normalizedPhase, // Use kebab-case to match route emission
        this.MAX_WAIT_TIME_MS
      );

      // Refresh task to get updated state after approval
      const Task = require('../../models/Task').Task;
      const freshTask = await Task.findById(task._id);
      if (freshTask) {
        Object.assign(task, freshTask);
        context.task = freshTask;
      }

      // Limpiar flag de aprobación pendiente
      context.setData('approvalPending', false);

      if (approved) {
        console.log(`✅ [Approval] ${phaseName} approved by user (via event)`);
        NotificationService.emitConsoleLog(taskId, 'info', `✅ ${phaseName} approved by user - continuing orchestration`);

        NotificationService.emitApprovalGranted(taskId, normalizedPhase, phaseName);

        return {
          success: true,
          data: {
            phase: previousPhase,
            approved: true,
          },
        };
      } else {
        console.log(`❌ [Approval] ${phaseName} rejected by user (via event)`);
        NotificationService.emitConsoleLog(taskId, 'error', `❌ ${phaseName} rejected by user - stopping orchestration`);

        return {
          success: false,
          error: `${phaseName} was rejected by user`,
          data: {
            phase: previousPhase,
            approved: false,
          },
        };
      }
    } catch (error: any) {
      // Limpiar flag de aprobación pendiente también en timeout
      context.setData('approvalPending', false);

      console.log(`⏱️  [Approval] Timeout waiting for ${phaseName} approval (24h exceeded)`);
      NotificationService.emitConsoleLog(taskId, 'error', `⏱️ Approval timeout for ${phaseName} (24h exceeded) - task marked as failed`);

      NotificationService.emitAgentMessage(
        taskId,
        'System',
        `⚠️ Approval timeout for **${phaseName}**. Task will be marked as failed.`
      );

      return {
        success: false,
        error: `Approval timeout after 24 hours`,
        data: {
          phase: previousPhase,
          timeout: true,
        },
      };
    }
  }

  /**
   * Normalize phase name from PascalCase to kebab-case
   *
   * Active phases from PHASE_ORDER:
   * Planning → Approval → TeamOrchestration → Verification → AutoMerge
   *
   * Sub-phases within TeamOrchestration:
   * TechLead → Developers → Judge → Fixer
   */
  private normalizePhase(phase: string): string {
    // Map PascalCase to kebab-case for API routes
    const phaseMappings: Record<string, string> = {
      // Main phases from PHASE_ORDER
      'Planning': 'planning',
      'Approval': 'approval',
      'TeamOrchestration': 'team-orchestration',
      'Verification': 'verification',
      'AutoMerge': 'auto-merge',
      // Sub-phases within TeamOrchestration
      'TechLead': 'tech-lead',
      'Developers': 'development',
      'Judge': 'judge',
      'Fixer': 'fixer',
    };

    if (phaseMappings[phase]) {
      return phaseMappings[phase];
    }

    // Default: PascalCase to kebab-case
    return phase
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');
  }

  /**
   * Get human-readable phase name
   *
   * Active phases from PHASE_ORDER:
   * Planning → Approval → TeamOrchestration → Verification → AutoMerge
   */
  private getPhaseName(phase: string): string {
    const phaseNames: Record<string, string> = {
      // Main phases from PHASE_ORDER
      'Planning': 'Planning (Analysis + Epics + Stories)',
      'Approval': 'Approval Gate',
      'TeamOrchestration': 'Team Orchestration',
      'Verification': 'Verification',
      'AutoMerge': 'Auto-Merge',
      // Sub-phases within TeamOrchestration
      'TechLead': 'Tech Lead',
      'Developers': 'Development Team',
      'Judge': 'Judge Evaluation',
      'Fixer': 'Bug Fixer',
    };

    return phaseNames[phase] || phase;
  }
}
