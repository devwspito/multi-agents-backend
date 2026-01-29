import { BasePhase, OrchestrationContext, PhaseResult, updateTaskFireAndForget } from './Phase';
import { approvalEvents } from '../ApprovalEvents'; // Event-based approval system
import { NotificationService } from '../NotificationService';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';

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
   *
   * 🔥 IMPORTANT: If there's a pendingApproval in DB (recovery scenario),
   * we should NOT skip - we need to re-emit and wait for user approval.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task to get latest state
    const freshTask = TaskRepository.findById(task.id);
    if (freshTask) {
      context.task = freshTask;
    }

    const taskId = (context.task.id as any).toString();

    // 🔥 FIX: Phases that NEVER require approval
    const noApprovalPhases = ['Sandbox', 'sandbox'];
    const previousPhaseCheck = context.getData<string>('currentPhaseName');
    if (previousPhaseCheck && noApprovalPhases.includes(previousPhaseCheck)) {
      console.log(`⏭️  [Approval] Skipping - "${previousPhaseCheck}" phase never requires approval`);
      return true;
    }

    // 🔥 FIX: Check for existing pendingApproval in DB (recovery scenario)
    // If there's a pending approval, we MUST NOT skip - re-emit and wait
    const pendingApproval = context.task.orchestration?.pendingApproval;
    if (pendingApproval && pendingApproval.phase) {
      console.log(`🔄 [Approval] Found existing pendingApproval in DB: ${pendingApproval.phase}`);
      console.log(`🔄 [Approval] This is likely a recovery scenario - will re-emit approval_required`);

      // Store in context so executePhase knows to use this
      context.setData('currentPhaseName', this.denormalizePhase(pendingApproval.phase));
      context.setData('recoveredPendingApproval', pendingApproval);

      return false; // Do NOT skip - we need to wait for approval
    }

    // Get previous phase from context
    const previousPhase = context.getData<string>('currentPhaseName');
    if (!previousPhase) {
      console.log(`[SKIP] No previous phase specified and no pendingApproval, skipping approval`);
      return true;
    }

    // Check if auto-approval is enabled
    const autoApprovalEnabled = context.task.orchestration.autoApprovalEnabled;
    const autoApprovalPhases = context.task.orchestration.autoApprovalPhases || [];

    // Normalize phase name for comparison (Planning -> planning, TechLead -> tech-lead)
    const normalizedPhaseName = this.normalizePhase(previousPhase);

    if (autoApprovalEnabled && autoApprovalPhases.includes(normalizedPhaseName as any)) {
      console.log(`✅ [SKIP] Auto-approval enabled for phase: ${previousPhase} (normalized: ${normalizedPhaseName})`);

      NotificationService.emitConsoleLog(taskId, 'info', `✅ Auto-approval enabled for ${previousPhase} - continuing without human approval`);

      // Log auto-approval in history
      if (!context.task.orchestration.approvalHistory) {
        context.task.orchestration.approvalHistory = [];
      }

      context.task.orchestration.approvalHistory.push({
        phase: previousPhase,
        phaseName: this.getPhaseName(previousPhase),
        approved: true,
        approvedBy: 'system',
        approvedAt: new Date(),
        comments: 'Auto-approved',
        autoApproved: true,
      });

      TaskRepository.update(context.task.id, context.task);

      return true; // Skip human approval
    }

    return false; // Require human approval
  }

  /**
   * Convert kebab-case back to PascalCase
   */
  private denormalizePhase(normalizedPhase: string): string {
    const reverseMapping: Record<string, string> = {
      'planning': 'Planning',
      'approval': 'Approval',
      'team-orchestration': 'TeamOrchestration',
      'recovery': 'Recovery',
      'integration': 'Integration',
      'verification': 'Verification',
      'auto-merge': 'AutoMerge',
      'tech-lead': 'TechLead',
      'development': 'Developers',
      'judge': 'Judge',
    };

    return reverseMapping[normalizedPhase] || normalizedPhase;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();
    const previousPhase = context.getData<string>('currentPhaseName');

    // 🔥 FIX: Check if we recovered a pending approval from DB (recovery scenario)
    const recoveredPendingApproval = context.getData<any>('recoveredPendingApproval');

    if (!previousPhase && !recoveredPendingApproval) {
      return {
        success: false,
        error: 'No previous phase specified for approval',
      };
    }

    // Use recovered data or compute from context
    const normalizedPhase = recoveredPendingApproval?.phase || this.normalizePhase(previousPhase!);
    const phaseName = recoveredPendingApproval?.phaseName || this.getPhaseName(previousPhase!);
    const agentOutput = recoveredPendingApproval?.agentOutput || context.getPhaseResult(previousPhase!)?.data || {};

    // Debug logging to understand the mapping
    const isRecovery = !!recoveredPendingApproval;
    console.log(`📋 [Approval] Phase: "${normalizedPhase}" (human: ${phaseName})${isRecovery ? ' [RECOVERED]' : ''}`);

    console.log(`⏸️  [Approval] Waiting for human approval of: ${phaseName}${isRecovery ? ' (re-emitting after recovery)' : ''}`);
    NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Waiting for human approval of: ${phaseName}${isRecovery ? ' (recovered)' : ''}`);

    // Marcar que hay aprobación pendiente para re-emit en join-task
    context.setData('approvalPending', true);

    // 📌 Persist pending approval data for re-emit on socket reconnect
    // Only persist if not already in DB (fresh execution, not recovery)
    if (!isRecovery) {
      const currentTask = TaskRepository.findById(task.id);
      if (currentTask) {
        const orchestration = currentTask.orchestration || {};
        orchestration.pendingApproval = {
          phase: normalizedPhase,
          phaseName: phaseName,
          agentOutput: agentOutput,
          retryCount: 0,
          timestamp: new Date(),
        };
        TaskRepository.update(task.id, { orchestration });
      }
    }

    // Emit WebSocket notification to frontend
    NotificationService.emitApprovalRequired(taskId, {
      phase: normalizedPhase, // Send kebab-case for frontend API call
      phaseName: phaseName,
      agentName: phaseName, // Use human-readable name
      approvalType: 'planning',
      agentOutput: agentOutput,
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
      const freshTask = TaskRepository.findById(task.id);
      if (freshTask) {
        Object.assign(task, freshTask);
        context.task = freshTask;
      }

      // Limpiar flag de aprobación pendiente
      context.setData('approvalPending', false);

      // 📌 Clear persisted pending approval (fire-and-forget)
      updateTaskFireAndForget(task.id, {
        $unset: { 'orchestration.pendingApproval': 1 },
      }, 'clear pendingApproval');

      if (approved) {
        console.log(`✅ [Approval] ${phaseName} approved by user (via event)`);
        NotificationService.emitConsoleLog(taskId, 'info', `✅ ${phaseName} approved by user - continuing orchestration`);

        NotificationService.emitApprovalGranted(taskId, {
          phase: normalizedPhase,
          approved: true,
        });

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

        NotificationService.emitApprovalGranted(taskId, {
          phase: normalizedPhase,
          approved: false,
        });

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
   * Planning → Approval → TeamOrchestration → Recovery → Integration → AutoMerge
   *
   * Sub-phases within TeamOrchestration:
   * TechLead → Developers → Judge
   */
  private normalizePhase(phase: string): string {
    // Map PascalCase to kebab-case for API routes
    const phaseMappings: Record<string, string> = {
      // Main phases from PHASE_ORDER
      'Planning': 'planning',
      'Approval': 'approval',
      'TeamOrchestration': 'team-orchestration',
      'Recovery': 'recovery',
      'Integration': 'integration',
      'Verification': 'verification',
      'AutoMerge': 'auto-merge',
      // Sub-phases within TeamOrchestration
      'TechLead': 'tech-lead',
      'Developers': 'development',
      'Judge': 'judge',
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
   * Planning → Approval → TeamOrchestration → Recovery → Integration → AutoMerge
   */
  private getPhaseName(phase: string): string {
    const phaseNames: Record<string, string> = {
      // Main phases from PHASE_ORDER
      'Planning': 'Planning (Analysis + Epics + Stories)',
      'Approval': 'Approval Gate',
      'TeamOrchestration': 'Team Orchestration',
      'Recovery': 'Recovery (Verify & Complete Work)',
      'Integration': 'Integration (Merge & Resolve Conflicts)',
      'Verification': 'Verification',
      'AutoMerge': 'Auto-Merge',
      // Sub-phases within TeamOrchestration
      'TechLead': 'Tech Lead',
      'Developers': 'Development Team',
      'Judge': 'Judge Evaluation',
    };

    return phaseNames[phase] || phase;
  }
}
