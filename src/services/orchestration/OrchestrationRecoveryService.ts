import { TaskRepository, ITask } from '../../database/repositories/TaskRepository.js';
import { OrchestrationCoordinator } from './OrchestrationCoordinator';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
// ⚡ OPTIMIZATION: Removed eventStore and AgentArtifactService imports
// Recovery now delegates to orchestrator which handles it more efficiently
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * 🔥 AUTO-RECOVERY DISABLED BY DEFAULT
 * Recovery is now MANUAL by default. Use "Resume" or "Retry" from frontend.
 *
 * To enable automatic recovery on startup, set:
 *   ENABLE_AUTO_RECOVERY=true
 *
 * Even with auto-recovery enabled, only projects with autoRecoveryEnabled=true
 * will have their tasks automatically recovered.
 */
const AUTO_RECOVERY_ENABLED = process.env.ENABLE_AUTO_RECOVERY === 'true';

/**
 * OrchestrationRecoveryService
 *
 * Recupera y reanuda orquestaciones interrumpidas cuando el servidor se reinicia.
 *
 * Estrategia de recuperación (LOCAL-FIRST):
 * 1. 🔥 PRIMERO: Escanear workspaces locales para `.agent-memory/execution-summary.md`
 * 2. Buscar tasks con status='in_progress' en MongoDB como FALLBACK
 * 3. Verificar integridad de workspace y repositorios
 * 4. Reconstruir contexto desde Local EventStore (fuente primaria)
 * 5. Reanudar desde la última fase completada
 *
 * Fuentes de datos (en orden de prioridad):
 * - Local: 🔥 PRIMARIO - `.agent-memory/` es la fuente de verdad
 * - MongoDB: FALLBACK si local no tiene datos
 * - GitHub: Último recurso (clone del repo con .agents/)
 *
 * Manejo de fases:
 * - Fases completadas: Skip (ya tienen output en Local/DB)
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
   * 🔥 LOCAL-FIRST: Escanea workspaces locales para encontrar tasks interrumpidas
   * Busca en agent-workspace-prod/task-* directorios con .agent-memory/execution-summary.md
   *
   * 🔧 OPTIMIZED: Uses async file operations to avoid blocking event loop
   */
  private async scanLocalWorkspacesForInterruptedTasks(): Promise<Array<{ taskId: string; workspacePath: string; phase: string; title: string }>> {
    const interruptedTasks: Array<{ taskId: string; workspacePath: string; phase: string; title: string }> = [];

    // Get workspace base path from env or default
    const workspaceBase = process.env.AGENT_WORKSPACE_PATH || path.join(os.homedir(), 'agent-workspace-prod');

    try {
      await fsPromises.access(workspaceBase);
    } catch {
      console.log(`📂 [Recovery] Workspace base not found: ${workspaceBase}`);
      return interruptedTasks;
    }

    console.log(`📂 [Recovery] Scanning local workspaces in: ${workspaceBase}`);

    try {
      // 🔧 ASYNC: Use async readdir instead of sync
      const entries = await fsPromises.readdir(workspaceBase, { withFileTypes: true });

      // 🔧 PARALLEL: Check all task directories in parallel (with limit)
      const taskChecks = entries
        .filter(entry => entry.isDirectory() && entry.name.startsWith('task-'))
        .slice(0, 20) // Limit to 20 most recent tasks to avoid overwhelming
        .map(async (entry) => {
          const taskId = entry.name.replace('task-', '');
          const taskWorkspace = path.join(workspaceBase, entry.name);
          const summaryPath = path.join(taskWorkspace, '.agent-memory', 'execution-summary.md');

          try {
            // 🔧 ASYNC: Use async readFile
            const summaryContent = await fsPromises.readFile(summaryPath, 'utf8');

            // Parse status from markdown
            const statusMatch = summaryContent.match(/\*\*Status:\*\*\s*(\w+)/);
            const phaseMatch = summaryContent.match(/\*\*Current Phase:\*\*\s*(\w+)/);
            const titleMatch = summaryContent.match(/^#\s+(.+)$/m) || ['', 'Unknown Task'];

            const status = statusMatch ? statusMatch[1] : 'unknown';
            const phase = phaseMatch ? phaseMatch[1] : 'unknown';

            if (status === 'in_progress') {
              console.log(`   📍 Found in_progress task locally: ${taskId} (Phase: ${phase})`);
              return {
                taskId,
                workspacePath: taskWorkspace,
                phase,
                title: titleMatch[1] || 'Unknown',
              };
            }
          } catch {
            // File doesn't exist or can't be read - skip silently
          }
          return null;
        });

      // Wait for all checks to complete
      const results = await Promise.all(taskChecks);

      // Filter out nulls and add to result
      for (const result of results) {
        if (result) {
          interruptedTasks.push(result);
        }
      }
    } catch (scanError: any) {
      console.error(`❌ [Recovery] Error scanning workspaces: ${scanError.message}`);
    }

    return interruptedTasks;
  }

  /**
   * Recupera TODAS las orquestaciones interrumpidas al iniciar servidor
   *
   * 🔥 DISABLED BY DEFAULT - Recovery is now MANUAL
   * Enable with ENABLE_AUTO_RECOVERY=true environment variable
   */
  async recoverAllInterruptedOrchestrations(): Promise<void> {
    // 🔧 AUTO-RECOVERY: Disabled by default
    if (!AUTO_RECOVERY_ENABLED) {
      console.log('⏭️  [Recovery] Auto-recovery DISABLED (use frontend to Resume/Retry tasks)');
      // 🔥 Mark all in_progress tasks as 'interrupted' so frontend shows Resume button
      await this.markInProgressTasksAsInterrupted();
      return;
    }

    if (this.isRecoveryInProgress) {
      console.log('⏭️  [Recovery] Recovery already in progress, skipping');
      return;
    }

    this.isRecoveryInProgress = true;

    try {
      console.log('🔄 [Recovery] Starting orchestration recovery (LOCAL-FIRST)...');

      // 🔥 STEP 1: Scan LOCAL workspaces first (PRIMARY source)
      console.log('\n📂 [Recovery] STEP 1: Scanning LOCAL workspaces...');
      const localInterruptedTasks = await this.scanLocalWorkspacesForInterruptedTasks();

      let interruptedTasksRaw: any[] = [];

      if (localInterruptedTasks.length > 0) {
        console.log(`[Recovery] Found ${localInterruptedTasks.length} interrupted task(s) LOCALLY`);

        // For local tasks, we need to either find them in database or create minimal task objects
        for (const localTask of localInterruptedTasks) {
          // Try to find in database first
          const dbTask = TaskRepository.findById(localTask.taskId);

          if (dbTask) {
            // CHECK STATUS: Skip cancelled/completed tasks
            if (dbTask.status === 'cancelled' || dbTask.status === 'completed') {
              console.log(`   Task ${localTask.taskId}: SKIPPED (status: ${dbTask.status})`);
              continue;
            }
            console.log(`   Task ${localTask.taskId}: Found in database (status: ${dbTask.status})`);
            interruptedTasksRaw.push(dbTask);
          } else {
            // Task exists locally but not in database - reconstruct from local EventStore
            console.log(`   Task ${localTask.taskId}: NOT in database, will recover from LOCAL EventStore`);

            // Create minimal task object for recovery
            // The actual state will be loaded from local EventStore
            const minimalTask = {
              id: localTask.taskId,
              title: localTask.title,
              status: 'in_progress',
              orchestration: {
                currentPhase: localTask.phase,
                paused: false,
                cancelRequested: false,
              },
              _recoverySource: 'local', // Mark that this came from local
              _workspacePath: localTask.workspacePath,
            };
            interruptedTasksRaw.push(minimalTask);
          }
        }
      } else {
        // STEP 2: FALLBACK to database only if LOCAL found nothing
        console.log('\n[Recovery] STEP 2: No local tasks found, checking database as FALLBACK...');

        // Filter in JS for SQLite
        interruptedTasksRaw = TaskRepository.findAll().filter((t: ITask) =>
          t.status === 'in_progress' &&
          t.orchestration?.paused !== true &&
          t.orchestration?.cancelRequested !== true
        );
      }

      if (interruptedTasksRaw.length === 0) {
        console.log('✅ [Recovery] No interrupted orchestrations found (checked LOCAL + MongoDB)');
        return;
      }

      console.log(`📋 [Recovery] Found ${interruptedTasksRaw.length} interrupted task(s):`);
      interruptedTasksRaw.forEach((task: any) => {
        console.log(`  - Task ${task.id}: ${task.title} (Phase: ${task.orchestration.currentPhase})`);
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
          // ⚡ OPTIMIZATION: Use taskRaw directly, convert to proper type
          // Skip the redundant Task.findById() query
          await this.recoverTask(taskRaw as unknown as ITask);
        } catch (error: any) {
          console.error(`❌ [Recovery] Failed to recover task ${taskRaw._id}:`, error.message);

          // Mark as failed using TaskRepository
          TaskRepository.update(taskId, { status: 'failed' });
          TaskRepository.modifyOrchestration(taskId, (orch) => ({
            ...orch,
            currentPhase: 'completed',
          }));

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
   * ⚡ OPTIMIZED: Minimal I/O, skip unnecessary checks
   */
  private async recoverTask(task: ITask): Promise<void> {
    const taskId = (task.id as any).toString();

    console.log(`🔄 [Recovery] Recovering task ${taskId}: ${task.title}`);

    try {
      // ⚡ OPTIMIZATION: Skip LogService.info() - it's a DB write we don't need
      // The console.log above is enough for debugging

      // Notify frontend (non-blocking emit)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔄 Auto-recovering from phase: ${task.orchestration.currentPhase}`
      );

      // ⚡ FAST workspace check - just verify it exists
      const workspaceInfo = this.getWorkspaceInfoFast(task);

      if (!workspaceInfo.exists) {
        console.log(`⚠️  [Recovery] Workspace missing - will re-clone`);
      }
      // ⚡ OPTIMIZATION: Skip syncFromLocalIfNeeded - orchestrator handles recovery
      // The unified memory service will detect completed phases

      console.log(`⚡ [Recovery] Starting orchestration for task ${taskId}`);

      // 🔥 CRITICAL: Create a NEW orchestrator instance for each task
      // This prevents conflicts when multiple tasks are recovered
      const taskOrchestrator = new OrchestrationCoordinator();

      // Reanudar orquestación (el coordinador detectará qué fases ya completaron)
      // Pass isResume: true to prevent paused flag race condition
      await taskOrchestrator.orchestrateTask(taskId, { isResume: true });

      console.log(`✅ [Recovery] Task ${taskId} recovered successfully`);
    } catch (error: any) {
      // Manejar errores de validación de esquema (ej: attachments legacy)
      if (error.name === 'ValidationError' && error.errors) {
        console.error(`⚠️  [Recovery] Schema validation error for task ${taskId}:`, error.message);
        console.log(`📝 [Recovery] Attempting to fix schema issues...`);

        // Mark as failed using TaskRepository
        TaskRepository.update(taskId, { status: 'failed' });
        TaskRepository.modifyOrchestration(taskId, (orch) => ({
          ...orch,
          currentPhase: 'completed',
        }));

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
   * ⚡ FAST workspace check - synchronous, minimal I/O
   * Only checks if workspace directory exists
   */
  private getWorkspaceInfoFast(task: ITask): { exists: boolean; path: string; primaryRepo: string | null } {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const taskWorkspace = path.join(workspaceDir, `task-${task.id}`);
    const exists = fs.existsSync(taskWorkspace);
    // ⚡ Skip repo scanning - orchestrator will handle it
    return { exists, path: taskWorkspace, primaryRepo: null };
  }

  // ⚡ OPTIMIZATION: Removed deprecated _getWorkspaceInfo and _syncFromLocalIfNeeded
  // The orchestrator handles all recovery logic via UnifiedMemory and cached phase statuses

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
      const task = TaskRepository.findById(taskId);
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

      // Allow resuming 'failed', 'pending', or 'interrupted' tasks
      if (task.status !== 'failed' && task.status !== 'pending' && task.status !== 'interrupted') {
        return { success: false, message: `Cannot resume task with status: ${task.status}` };
      }

      console.log(`[Recovery] Task details:`);
      console.log(`   Title: ${task.title}`);
      console.log(`   Status: ${task.status}`);
      console.log(`   Current Phase: ${task.orchestration.currentPhase}`);

      // Reset status to pending so orchestrator picks it up
      TaskRepository.update(taskId, { status: 'pending' });
      TaskRepository.modifyOrchestration(taskId, (orch) => ({
        ...orch,
        cancelRequested: false,
      }));

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
      // Pass isResume: true to prevent paused flag race condition
      taskOrchestrator.orchestrateTask(taskId, { isResume: true }).catch((error) => {
        console.error(`❌ [Recovery] Resume failed for task ${taskId}:`, error.message);
        NotificationService.emitTaskFailed(taskId, {
          error: `Resume failed: ${error.message}`,
        });
      });

      console.log(`[Recovery] Task ${taskId} resume initiated`);

      return {
        success: true,
        message: `Task resume initiated from phase: ${task.orchestration.currentPhase}`,
        task: TaskRepository.findById(taskId) as ITask
      };
    } catch (error: any) {
      console.error(`[Recovery] Error resuming task ${taskId}:`, error.message);
      return { success: false, message: `Error: ${error.message}` };
    }
  }

  /**
   * Get list of failed tasks that can be resumed
   */
  async getResumableTasks(): Promise<any[]> {
    return TaskRepository.findAll()
      .filter((t: ITask) =>
        (t.status === 'failed' || t.status === 'pending') &&
        t.orchestration?.paused !== true
      )
      .sort((a: ITask, b: ITask) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
      .slice(0, 20);
  }

  /**
   * Mark all in_progress tasks as 'interrupted' on server startup
   * This is called when auto-recovery is disabled, so users can manually Resume from frontend
   */
  private async markInProgressTasksAsInterrupted(): Promise<void> {
    try {
      // Find all tasks that are in_progress (they were running when server stopped)
      const inProgressTasks = TaskRepository.findAll().filter(
        (t: ITask) => t.status === 'in_progress'
      );

      if (inProgressTasks.length === 0) {
        console.log('[Recovery] No in_progress tasks to mark as interrupted');
        return;
      }

      console.log(`[Recovery] Marking ${inProgressTasks.length} in_progress task(s) as 'interrupted'...`);

      for (const task of inProgressTasks) {
        const taskId = task.id;

        // Update status to 'interrupted'
        TaskRepository.update(taskId, { status: 'interrupted' });
        TaskRepository.modifyOrchestration(taskId, (orch) => ({
          ...orch,
          interruptedAt: new Date(),
          interruptReason: 'server_restart',
        }));

        console.log(`   Task ${taskId}: marked as 'interrupted' (was: in_progress)`);
      }

      console.log(`[Recovery] ${inProgressTasks.length} task(s) marked as 'interrupted' - users can Resume from frontend`);
    } catch (error: any) {
      console.error(`[Recovery] Error marking tasks as interrupted: ${error.message}`);
    }
  }
}
