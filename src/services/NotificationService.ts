import { Server as SocketServer } from 'socket.io';

export interface OrchestrationEvent {
  taskId: string;
  agentType: 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'qa-engineer' | 'merge-coordinator' | 'judge' | 'fixer' | 'auto-merge' | 'e2e-tester' | 'e2e-fixer';
  status: 'started' | 'in-progress' | 'completed' | 'failed';
  message: string;
  timestamp: Date;
  metadata?: {
    agentId?: string;
    progress?: number;
    branchName?: string;
    prUrl?: string;
    error?: string;
    logs?: string[];
  };
}

export interface MergeConflictEvent {
  taskId: string;
  conflictType: 'merge' | 'pr-conflict';
  message: string;
  branches: string[];
  affectedFiles: string[];
  timestamp: Date;
}

/**
 * Servicio de notificaciones en tiempo real usando WebSocket
 */
export class NotificationService {
  private static getIO(): SocketServer | null {
    return (global as any).io || null;
  }

  /**
   * Emitir evento de orquestación a clientes conectados
   */
  static emitOrchestrationEvent(event: OrchestrationEvent): void {
    const io = this.getIO();
    if (!io) {
      console.warn('⚠️ Socket.IO not initialized, skipping notification');
      return;
    }

    // Emitir a la room específica de la tarea
    io.to(`task:${event.taskId}`).emit('orchestration:update', event);

    // Log para debugging
    console.log(`📡 [WebSocket] Orchestration event emitted:`, {
      taskId: event.taskId,
      agentType: event.agentType,
      status: event.status,
    });
  }

  /**
   * Emitir evento de conflicto de merge
   */
  static emitMergeConflict(event: MergeConflictEvent): void {
    const io = this.getIO();
    if (!io) {
      console.warn('⚠️ Socket.IO not initialized, skipping notification');
      return;
    }

    // Emitir a la room específica de la tarea
    io.to(`task:${event.taskId}`).emit('merge:conflict', event);

    console.log(`⚠️ [WebSocket] Merge conflict event emitted:`, {
      taskId: event.taskId,
      conflictType: event.conflictType,
      branches: event.branches,
    });
  }

  /**
   * Emitir actualización de progreso general
   */
  static emitProgressUpdate(taskId: string, progress: {
    completedAgents: number;
    totalAgents: number;
    currentAgent: string;
    percentage: number;
  }): void {
    const io = this.getIO();
    if (!io) return;

    io.to(`task:${taskId}`).emit('task:progress', {
      taskId,
      ...progress,
      timestamp: new Date(),
    });

    console.log(`📊 [WebSocket] Progress update:`, {
      taskId,
      percentage: progress.percentage,
      currentAgent: progress.currentAgent,
    });
  }

  /**
   * Emitir logs en tiempo real
   */
  static emitLogs(taskId: string, logs: string[], level: 'info' | 'error' | 'warning' = 'info'): void {
    const io = this.getIO();
    if (!io) return;

    io.to(`task:${taskId}`).emit('task:logs', {
      taskId,
      logs,
      level,
      timestamp: new Date(),
    });
  }

  /**
   * Emitir evento de tarea completada
   */
  static emitTaskCompleted(taskId: string, result: {
    success: boolean;
    duration: number;
    agentsExecuted: string[];
    prsCreated: number;
    message: string;
  }): void {
    const io = this.getIO();
    if (!io) return;

    io.to(`task:${taskId}`).emit('task:completed', {
      taskId,
      ...result,
      timestamp: new Date(),
    });

    console.log(`✅ [WebSocket] Task completed event emitted:`, {
      taskId,
      success: result.success,
      duration: result.duration,
    });
  }

  /**
   * Emitir notificación formateada para el frontend
   * Compatible con el formato que espera el WebSocketContext
   */
  static emitNotification(taskId: string, notificationType: string, data: any): void {
    const io = this.getIO();
    if (!io) return;

    const notification = {
      type: 'notification',
      notification: {
        type: notificationType,
        data: {
          ...data,
          timestamp: new Date(),
        },
      },
    };

    // Emit the full notification object (not just notification.notification)
    // This matches what the frontend expects in ConsoleViewer and WebSocketContext
    io.to(`task:${taskId}`).emit('notification', notification);

    console.log(`📬 [WebSocket] Notification emitted:`, {
      taskId,
      type: notificationType,
    });
  }

  /**
   * Helpers para eventos comunes de agentes
   */
  static emitAgentStarted(taskId: string, agentName: string): void {
    this.emitNotification(taskId, 'agent_started', {
      agentName,
    });
  }

  static emitAgentProgress(taskId: string, agentName: string, message: string): void {
    this.emitNotification(taskId, 'agent_progress', {
      agentName,
      message,
    });
  }

  static emitAgentCompleted(taskId: string, agentName: string, result?: string): void {
    this.emitNotification(taskId, 'agent_completed', {
      agentName,
      result,
    });
  }

  static emitAgentMessage(taskId: string, agentName: string, message: string): void {
    this.emitNotification(taskId, 'agent_message', {
      agentName,
      message,
    });
  }

  static emitAgentFailed(taskId: string, agentName: string, error: string): void {
    this.emitNotification(taskId, 'agent_failed', {
      agentName,
      error,
    });
  }

  static emitAgentError(taskId: string, agentName: string, error: string): void {
    // Alias for emitAgentFailed
    this.emitAgentFailed(taskId, agentName, error);
  }

  static emitOrchestrationStarted(taskId: string): void {
    this.emitNotification(taskId, 'orchestration_started', {});
  }

  static emitOrchestrationCompleted(taskId: string, costSummary?: {
    totalCost: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    breakdown?: {
      phase: string;
      cost: number;
      inputTokens: number;
      outputTokens: number;
    }[];
  }): void {
    this.emitNotification(taskId, 'orchestration_completed', costSummary || {});
  }

  static emitOrchestrationFailed(taskId: string, error: string): void {
    this.emitNotification(taskId, 'orchestration_failed', { error });
  }

  /**
   * Emitir evento de PR creado
   */
  static emitPRCreated(taskId: string, prData: {
    agentType: string;
    prUrl: string;
    branchName: string;
    title: string;
  }): void {
    const io = this.getIO();
    if (!io) return;

    io.to(`task:${taskId}`).emit('pr:created', {
      taskId,
      ...prData,
      timestamp: new Date(),
    });

    console.log(`🔀 [WebSocket] PR created event emitted:`, {
      taskId,
      agentType: prData.agentType,
      prUrl: prData.prUrl,
    });
  }

  /**
   * Emitir solicitud de aprobación (Human-in-loop)
   * Compatible con ConsoleViewer frontend
   */
  static emitApprovalRequired(taskId: string, approvalData: {
    phase: string;
    phaseName: string;
    agentName: string;
    approvalType?: 'planning' | 'code_change' | 'test_results' | 'evaluation' | 'merge';
    agentOutput?: any;
  }): void {
    this.emitNotification(taskId, 'approval_required', {
      phase: approvalData.phase,
      phaseName: approvalData.phaseName,
      agentName: approvalData.agentName,
      approvalType: approvalData.approvalType || 'planning',
      agentOutput: approvalData.agentOutput || {},
    });

    console.log(`⏸️ [WebSocket] Approval required emitted:`, {
      taskId,
      phase: approvalData.phase,
      phaseName: approvalData.phaseName,
    });
  }

  /**
   * Emitir aprobación concedida
   */
  static emitApprovalGranted(taskId: string, phase: string, phaseName: string): void {
    this.emitNotification(taskId, 'approval_granted', {
      phase,
      phaseName,
    });

    console.log(`✅ [WebSocket] Approval granted emitted:`, {
      taskId,
      phase,
    });
  }

  /**
   * Emitir evento de tarea iniciada (orchestration started)
   */
  static emitTaskStarted(taskId: string, data?: any): void {
    this.emitNotification(taskId, 'task_started', {
      ...data,
    });

    console.log(`🚀 [WebSocket] Task started emitted:`, {
      taskId,
      data,
    });
  }

  /**
   * Emitir evento de tarea fallida
   */
  static emitTaskFailed(taskId: string, data?: any): void {
    this.emitNotification(taskId, 'task_failed', {
      ...data,
    });

    console.log(`❌ [WebSocket] Task failed emitted:`, {
      taskId,
      error: data?.error,
    });
  }

  /**
   * Emitir log de consola al frontend
   *
   * Este método envía logs del backend al ConsoleViewer del frontend
   * para mostrar la ejecución en tiempo real.
   *
   * IMPORTANTE: También persiste el log en la base de datos para que sobreviva
   * al refresh del frontend.
   *
   * @param taskId - ID de la tarea
   * @param level - Nivel del log (log, info, warn, error)
   * @param message - Mensaje del log
   */
  static async emitConsoleLog(
    taskId: string,
    level: 'log' | 'info' | 'warn' | 'error',
    message: string
  ): Promise<void> {
    const io = this.getIO();
    const timestamp = new Date();

    const logData = {
      level,
      message,
      timestamp: timestamp.toISOString(),
    };

    // 1. Emitir al evento específico que espera ConsoleViewer (tiempo real)
    if (io) {
      io.to(`task:${taskId}`).emit('console:log', logData);
    }

    // 2. Persistir en base de datos para sobrevivir refresh
    try {
      // Validate taskId is a valid ObjectId (24 hex chars)
      const mongoose = await import('mongoose');
      if (!mongoose.default.Types.ObjectId.isValid(taskId)) {
        // Skip DB persistence for invalid IDs (e.g., "system", "unknown")
        return;
      }

      const { Task } = await import('../models/Task');
      await Task.findByIdAndUpdate(
        taskId,
        {
          $push: {
            logs: {
              level,
              message,
              timestamp,
            },
          },
        },
        { new: false } // No necesitamos retornar el documento
      );
    } catch (error) {
      console.error(`❌ Error persisting log to DB:`, error);
      // No lanzar error - los logs no deben romper la orquestación
    }
  }
}
