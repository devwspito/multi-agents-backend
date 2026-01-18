import { Task, ITask } from '../../models/Task';
import { OrchestrationCoordinator } from './OrchestrationCoordinator';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { eventStore } from '../EventStore';
import { AgentArtifactService } from '../AgentArtifactService';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * OrchestrationRecoveryService
 *
 * Recupera y reanuda orquestaciones interrumpidas cuando el servidor se reinicia.
 *
 * Estrategia de recuperación:
 * 1. Buscar tasks con status='in_progress' al iniciar servidor
 * 2. Verificar integridad de workspace y repositorios
 * 3. Reconstruir contexto desde MongoDB, Local y EventStore (con fallback)
 * 4. Reanudar desde la última fase completada
 *
 * Fuentes de datos (en orden de prioridad):
 * - MongoDB: Principal y en tiempo real
 * - Local: Fallback si MongoDB está vacío/incompleto
 * - GitHub: Último recurso (clone del repo con .agents/)
 *
 * Manejo de fases:
 * - Fases completadas: Skip (ya tienen output en DB)
 * - Fase en progreso: Re-ejecutar desde el inicio
 * - Fases pendientes: Ejecutar normalmente
 */
export class OrchestrationRecoveryService {
  private isRecoveryInProgress: boolean = false;
  private recoveredTasks: Set<string> = new Set(); // Track recovered tasks to avoid duplicates

  constructor() {
    // Don't create a shared orchestrator - create one per task
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
      // Explicitly exclude cancelled tasks for safety
      const interruptedTasksRaw = await Task.find({
        status: 'in_progress',
        'orchestration.paused': { $ne: true }, // Excluir tasks pausadas manualmente
        'orchestration.cancelRequested': { $ne: true }, // Excluir tasks canceladas
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

      // 🔥 CRITICAL: Recover tasks with controlled concurrency
      // This ensures each task gets its own orchestrator instance
      // But we add a small delay between each to avoid overwhelming the system
      const recoveryPromises = interruptedTasksRaw.map(async (taskRaw, index) => {
        const taskId = taskRaw._id.toString();

        // Add a small delay between task recoveries to prevent overwhelming
        if (index > 0) {
          const delay = index * 2000; // 2 seconds between each task
          console.log(`⏱️  [Recovery] Waiting ${delay}ms before recovering task ${index + 1}/${interruptedTasksRaw.length}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Prevent duplicate recovery
        if (this.recoveredTasks.has(taskId)) {
          console.log(`⏭️  [Recovery] Task ${taskId} already being recovered, skipping`);
          return;
        }
        this.recoveredTasks.add(taskId);

        try {
          // Convertir a documento de Mongoose solo para recoverTask
          const task = await Task.findById(taskRaw._id);
          if (!task) {
            console.log(`⚠️  [Recovery] Task ${taskId} not found, skipping`);
            return;
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

          NotificationService.emitTaskFailed(taskId, {
            error: `Recovery failed: ${error.message}`,
          });
        } finally {
          // Clean up from recovered set after processing
          this.recoveredTasks.delete(taskId);
        }
      });

      // Wait for all recoveries to complete
      await Promise.allSettled(recoveryPromises);

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
      const workspaceInfo = await this.getWorkspaceInfo(task);

      if (!workspaceInfo.exists) {
        console.log(`⚠️  [Recovery] Workspace missing for task ${taskId} - will re-clone`);
      } else {
        // 🔄 LOCAL FALLBACK: Sync events from Local to MongoDB if MongoDB is empty
        console.log(`📦 [Recovery] Checking for Local backup data...`);
        await this.syncFromLocalIfNeeded(taskId, workspaceInfo.path, workspaceInfo.primaryRepo);
      }

      console.log(`✅ [Recovery] Starting orchestration for task ${taskId}`);

      // 🔥 CRITICAL: Create a NEW orchestrator instance for each task
      // This prevents conflicts when multiple tasks are recovered
      const taskOrchestrator = new OrchestrationCoordinator();

      // Reanudar orquestación (el coordinador detectará qué fases ya completaron)
      await taskOrchestrator.orchestrateTask(taskId);

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
   * Get workspace information including path and primary repository
   */
  private async getWorkspaceInfo(task: ITask): Promise<{
    exists: boolean;
    path: string;
    primaryRepo: string | null;
  }> {
    try {
      const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
      const taskWorkspace = path.join(workspaceDir, `task-${task._id}`);

      const exists = fs.existsSync(taskWorkspace);

      // Find primary repository (first repo in the workspace)
      let primaryRepo: string | null = null;
      if (exists) {
        const contents = fs.readdirSync(taskWorkspace);
        // Look for directories that could be repos (exclude hidden folders)
        for (const item of contents) {
          const itemPath = path.join(taskWorkspace, item);
          if (fs.statSync(itemPath).isDirectory() && !item.startsWith('.')) {
            // Check if it's a git repo
            if (fs.existsSync(path.join(itemPath, '.git'))) {
              primaryRepo = item;
              break;
            }
          }
        }
      }

      return { exists, path: taskWorkspace, primaryRepo };
    } catch (error: any) {
      // 🔥 FIX: Log error instead of silently swallowing
      console.warn(`⚠️ [Recovery] Error checking workspace for task ${task._id}: ${error.message}`);
      return { exists: false, path: '', primaryRepo: null };
    }
  }

  /**
   * Sync data from Local files to MongoDB if MongoDB is empty
   * This is the Local → MongoDB fallback for recovery
   */
  private async syncFromLocalIfNeeded(
    taskId: string,
    workspacePath: string,
    primaryRepo: string | null
  ): Promise<void> {
    if (!primaryRepo) {
      console.log(`⚠️ [Recovery] No repository found in workspace, skipping Local sync`);
      return;
    }

    try {
      // 1. Sync EventStore events from Local to MongoDB
      const eventSyncResult = await eventStore.syncFromLocal(taskId, workspacePath, primaryRepo);
      if (eventSyncResult.eventsRestored > 0) {
        console.log(`✅ [Recovery] Restored ${eventSyncResult.eventsRestored} events from Local`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📦 Restored ${eventSyncResult.eventsRestored} events from Local backup`
        );
      }

      // 2. Load orchestration timeline from Local and log info
      const timeline = AgentArtifactService.loadOrchestrationTimeline(workspacePath, primaryRepo);
      if (timeline) {
        console.log(`📦 [Recovery] Found Local timeline:`);
        console.log(`   - Last phase: ${timeline.data?.currentPhase || 'unknown'}`);
        console.log(`   - Phases completed: ${timeline.data?.phasesCompleted?.length || 0}`);
        console.log(`   - Epics: ${timeline.data?.epics?.length || 0}`);
        console.log(`   - Last updated: ${timeline._metadata?.savedAt || 'unknown'}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📦 Local timeline: ${timeline.data?.phasesCompleted?.length || 0} phases completed, last phase: ${timeline.data?.currentPhase || 'unknown'}`
        );
      }

      // 3. Check for agent artifacts (epics, architecture, etc.)
      const planningArtifacts = AgentArtifactService.listArtifacts(workspacePath, primaryRepo, 'planning');
      const techleadArtifacts = AgentArtifactService.listArtifacts(workspacePath, primaryRepo, 'techlead');
      const judgeArtifacts = AgentArtifactService.listArtifacts(workspacePath, primaryRepo, 'judge');

      if (planningArtifacts.length > 0 || techleadArtifacts.length > 0 || judgeArtifacts.length > 0) {
        console.log(`📦 [Recovery] Found Local artifacts:`);
        console.log(`   - Planning: ${planningArtifacts.length} files`);
        console.log(`   - TechLead: ${techleadArtifacts.length} files`);
        console.log(`   - Judge: ${judgeArtifacts.length} files`);
      }

    } catch (error: any) {
      console.warn(`⚠️ [Recovery] Local sync failed (non-blocking): ${error.message}`);
    }
  }

  /**
   * Resume a failed task from where it left off
   *
   * This allows manually restarting a task that failed due to:
   * - Server crash/restart
   * - Agent timeout
   * - SDK errors
   * - etc.
   *
   * The orchestrator will detect completed phases and skip them.
   */
  async resumeFailedTask(taskId: string): Promise<{
    success: boolean;
    message: string;
    task?: ITask;
  }> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔄 [Recovery] Attempting to resume failed task: ${taskId}`);
    console.log(`${'='.repeat(60)}`);

    try {
      // Find the task
      const task = await Task.findById(taskId);
      if (!task) {
        return { success: false, message: 'Task not found' };
      }

      // Check current status
      if (task.status === 'completed') {
        return { success: false, message: 'Task is already completed' };
      }

      if (task.status === 'in_progress') {
        return { success: false, message: 'Task is already in progress' };
      }

      if (task.status === 'cancelled') {
        return { success: false, message: 'Task was cancelled and cannot be resumed' };
      }

      // Allow resuming 'failed' or 'pending' tasks
      if (task.status !== 'failed' && task.status !== 'pending') {
        return { success: false, message: `Cannot resume task with status: ${task.status}` };
      }

      console.log(`📋 [Recovery] Task details:`);
      console.log(`   Title: ${task.title}`);
      console.log(`   Status: ${task.status}`);
      console.log(`   Current Phase: ${task.orchestration.currentPhase}`);

      // Reset status to pending so orchestrator picks it up
      task.status = 'pending';
      task.orchestration.cancelRequested = false;

      // If it failed during a phase, we'll restart from that phase
      // The orchestrator will skip already completed phases
      await task.save();

      console.log(`✅ [Recovery] Task status reset to pending`);

      // Notify frontend
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔄 Resuming failed task from phase: ${task.orchestration.currentPhase}`
      );

      // Create new orchestrator and resume
      const taskOrchestrator = new OrchestrationCoordinator();

      // Run orchestration in background (don't block)
      taskOrchestrator.orchestrateTask(taskId).catch((error) => {
        console.error(`❌ [Recovery] Resume failed for task ${taskId}:`, error.message);
        NotificationService.emitTaskFailed(taskId, {
          error: `Resume failed: ${error.message}`,
        });
      });

      console.log(`✅ [Recovery] Task ${taskId} resume initiated`);

      return {
        success: true,
        message: `Task resume initiated from phase: ${task.orchestration.currentPhase}`,
        task: await Task.findById(taskId) as ITask
      };
    } catch (error: any) {
      console.error(`❌ [Recovery] Error resuming task ${taskId}:`, error.message);
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Get list of failed tasks that can be resumed
   */
  async getResumableTasks(): Promise<any[]> {
    return Task.find({
      status: { $in: ['failed', 'pending'] },
      'orchestration.paused': { $ne: true },
    })
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();
  }
}
