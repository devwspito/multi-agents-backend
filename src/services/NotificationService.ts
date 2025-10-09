import { Server as SocketServer } from 'socket.io';

export interface OrchestrationEvent {
  taskId: string;
  agentType: 'product-manager' | 'project-manager' | 'tech-lead' | 'senior-developer' | 'junior-developer' | 'qa-engineer';
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

    io.to(`task:${taskId}`).emit('notification', notification.notification);

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

  static emitOrchestrationStarted(taskId: string): void {
    this.emitNotification(taskId, 'orchestration_started', {});
  }

  static emitOrchestrationCompleted(taskId: string): void {
    this.emitNotification(taskId, 'orchestration_completed', {});
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
}
