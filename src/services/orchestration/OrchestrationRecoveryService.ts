import { Task, ITask } from '../../models/Task';
import { OrchestrationCoordinator } from './OrchestrationCoordinator';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * OrchestrationRecoveryService
 *
 * Recupera y reanuda orquestaciones interrumpidas cuando el servidor se reinicia.
 *
 * Estrategia de recuperación:
 * 1. Buscar tasks con status='in_progress' al iniciar servidor
 * 2. Verificar integridad de workspace y repositorios
 * 3. Reconstruir contexto desde MongoDB y EventStore
 * 4. Reanudar desde la última fase completada
 *
 * Manejo de fases:
 * - Fases completadas: Skip (ya tienen output en DB)
 * - Fase en progreso: Re-ejecutar desde el inicio
 * - Fases pendientes: Ejecutar normalmente
 */
export class OrchestrationRecoveryService {
  private orchestrator: OrchestrationCoordinator;
  private isRecoveryInProgress: boolean = false;

  constructor() {
    this.orchestrator = new OrchestrationCoordinator();
  }

  /**
   * Recupera TODAS las orquestaciones interrumpidas al iniciar servidor
   */
  async recoverAllInterruptedOrchestrations(): Promise<void> {
    if (this.isRecoveryInProgress) {
      console.log('⏭️  [Recovery] Recovery already in progress, skipping');
      return;
    }

    this.isRecoveryInProgress = true;

    try {
      console.log('🔄 [Recovery] Starting orchestration recovery...');

      // Buscar tasks interrumpidas (in_progress pero NO pausadas manualmente)
      const interruptedTasks = await Task.find({
        status: 'in_progress',
        'orchestration.paused': { $ne: true }, // Excluir tasks pausadas manualmente
      }).populate('userId');

      if (interruptedTasks.length === 0) {
        console.log('✅ [Recovery] No interrupted orchestrations found');
        return;
      }

      console.log(`📋 [Recovery] Found ${interruptedTasks.length} interrupted task(s):`);
      interruptedTasks.forEach((task) => {
        console.log(`  - Task ${task._id}: ${task.title} (Phase: ${task.orchestration.currentPhase})`);
      });

      // Recuperar cada task (secuencialmente para evitar sobrecarga)
      for (const task of interruptedTasks) {
        try {
          await this.recoverTask(task);
        } catch (error: any) {
          console.error(`❌ [Recovery] Failed to recover task ${(task._id as any).toString()}:`, error.message);

          // Marcar como fallida pero NO detener recovery de otras tasks
          task.status = 'failed';
          task.orchestration.currentPhase = 'completed';
          await task.save();

          await LogService.error(`Failed to recover task after server restart`, {
            taskId: (task._id as any).toString(),
            category: 'orchestration',
            error,
          });

          NotificationService.emitTaskFailed((task._id as any).toString(), {
            error: `Recovery failed: ${error.message}`,
          });
        }
      }

      console.log('✅ [Recovery] All interrupted orchestrations processed');
    } catch (error: any) {
      console.error('❌ [Recovery] Critical error during recovery:', error.message);
    } finally {
      this.isRecoveryInProgress = false;
    }
  }

  /**
   * Recupera una task específica
   */
  private async recoverTask(task: ITask): Promise<void> {
    const taskId = (task._id as any).toString();

    console.log(`🔄 [Recovery] Recovering task ${taskId}: ${task.title}`);

    await LogService.info(`Auto-recovering interrupted orchestration`, {
      taskId,
      category: 'orchestration',
      phase: task.orchestration.currentPhase as any,
      metadata: {
        lastPhase: task.orchestration.currentPhase,
      },
    });

    // Notificar al frontend que la task se está recuperando
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🔄 Server restarted - Auto-recovering orchestration from phase: ${task.orchestration.currentPhase}`
    );

    // Verificar integridad del workspace
    const workspaceExists = await this.verifyWorkspace(task);
    if (!workspaceExists) {
      console.log(`⚠️  [Recovery] Workspace missing for task ${taskId} - will re-clone`);
    }

    console.log(`✅ [Recovery] Starting orchestration for task ${taskId}`);

    // Reanudar orquestación (el coordinador detectará qué fases ya completaron)
    await this.orchestrator.orchestrateTask(taskId);

    console.log(`✅ [Recovery] Task ${taskId} recovered successfully`);
  }

  /**
   * Verifica si el workspace aún existe
   */
  private async verifyWorkspace(task: ITask): Promise<boolean> {
    try {
      const fs = require('fs');
      const path = require('path');
      const os = require('os');

      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
      const taskWorkspace = path.join(workspaceDir, `task-${task._id}`);

      return fs.existsSync(taskWorkspace);
    } catch {
      return false;
    }
  }
}
