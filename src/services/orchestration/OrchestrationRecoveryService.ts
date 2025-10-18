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

      // Buscar tasks interrumpidas usando lean() para evitar validación de esquema
      const interruptedTasksRaw = await Task.find({
        status: 'in_progress',
        'orchestration.paused': { $ne: true }, // Excluir tasks pausadas manualmente
      })
        .lean()
        .exec();

      if (interruptedTasksRaw.length === 0) {
        console.log('✅ [Recovery] No interrupted orchestrations found');
        return;
      }

      console.log(`📋 [Recovery] Found ${interruptedTasksRaw.length} interrupted task(s):`);
      interruptedTasksRaw.forEach((task: any) => {
        console.log(`  - Task ${task._id}: ${task.title} (Phase: ${task.orchestration.currentPhase})`);
      });

      // Recuperar cada task (secuencialmente para evitar sobrecarga)
      for (const taskRaw of interruptedTasksRaw) {
        try {
          // Convertir a documento de Mongoose solo para recoverTask
          const task = await Task.findById(taskRaw._id);
          if (!task) {
            console.log(`⚠️  [Recovery] Task ${taskRaw._id} not found, skipping`);
            continue;
          }

          await this.recoverTask(task);
        } catch (error: any) {
          console.error(`❌ [Recovery] Failed to recover task ${taskRaw._id}:`, error.message);

          // Marcar como fallida directamente en la DB (sin save que valida)
          const mongoose = require('mongoose');
          await mongoose.connection.collection('tasks').updateOne(
            { _id: taskRaw._id },
            {
              $set: {
                status: 'failed',
                'orchestration.currentPhase': 'completed',
                updatedAt: new Date(),
              },
            }
          );

          await LogService.error(`Failed to recover task after server restart`, {
            taskId: taskRaw._id.toString(),
            category: 'orchestration',
            error,
          });

          NotificationService.emitTaskFailed(taskRaw._id.toString(), {
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

    try {
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
    } catch (error: any) {
      // Manejar errores de validación de esquema (ej: attachments legacy)
      if (error.name === 'ValidationError' && error.errors) {
        console.error(`⚠️  [Recovery] Schema validation error for task ${taskId}:`, error.message);
        console.log(`📝 [Recovery] Attempting to fix schema issues...`);

        // Marcar como failed directamente en la DB sin usar save() (que valida)
        const mongoose = require('mongoose');
        await mongoose.connection.collection('tasks').updateOne(
          { _id: task._id },
          {
            $set: {
              status: 'failed',
              'orchestration.currentPhase': 'completed',
              updatedAt: new Date(),
            },
          }
        );

        console.log(`✅ [Recovery] Task ${taskId} marked as failed due to schema issues`);

        await LogService.error(`Recovery failed due to schema validation`, {
          taskId,
          category: 'orchestration',
          error,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Task recovery failed: Schema validation error. Please check the task data.`
        );
      } else {
        // Re-throw otros errores para que sean manejados por el caller
        throw error;
      }
    }
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
