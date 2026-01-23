/**
 * SandboxPoolService - Isolated Sandbox Per Task
 *
 * SIMPLIFIED ARCHITECTURE (2026-01-23):
 * - 1 Task = N Sandboxes (one per repository/service)
 * - NO pooling between tasks - completely isolated
 * - NO reuse - fresh sandbox every task
 * - Destroy ALL sandboxes when task completes
 *
 * Why this is better:
 * - No image mismatch bugs (Flutter getting Node image)
 * - No state pollution between tasks
 * - No complex conflict detection
 * - Simpler debugging
 * - 2-5 min extra setup = 0.04% of 2-hour task
 *
 * Multi-service support:
 * ```
 * Task abc123:
 * ├── Sandbox: abc123/backend (Node.js)
 * ├── Sandbox: abc123/frontend (React)
 * └── Sandbox: abc123/mobile (Flutter)
 *
 * Task ends → Destroy all 3 sandboxes
 * Next task → Fresh sandboxes (NO REUSE)
 * ```
 */

import { EventEmitter } from 'events';
import { sandboxService, SandboxInstance } from './SandboxService';
import { projectNetworkService } from './ProjectNetworkService.js';

// ============================================================================
// Types
// ============================================================================

interface TaskSandbox {
  taskId: string;
  repoName: string;
  sandbox: SandboxInstance;
  language: string;
  createdAt: Date;
}

// ============================================================================
// SandboxPoolService Class (Simplified)
// ============================================================================

class SandboxPoolService extends EventEmitter {
  // Map: sandboxKey ({taskId}/{repoName}) -> TaskSandbox
  private sandboxes: Map<string, TaskSandbox> = new Map();

  constructor() {
    super();
  }

  // --------------------------------------------------------------------------
  // Core API: Create Sandbox for Task
  // --------------------------------------------------------------------------

  /**
   * Create a sandbox for a task's repository.
   *
   * 🔥 ARCHITECTURE (2026-01-23): ONE SANDBOX PER TASK
   * - Within a task, ONE sandbox is shared across ALL repos
   * - Each repo is mounted at /workspace/{repo-name}
   * - Uses multi-runtime image (Flutter + Node.js + Python)
   * - Between tasks, sandboxes are NEVER reused (clean slate)
   *
   * @param taskId - Unique task identifier
   * @param projectId - Project ID (for logging)
   * @param repoName - Repository name (or 'unified' for multi-repo sandbox)
   * @param _plannedFiles - Ignored (no conflict detection)
   * @param workspacePath - Path where repo is/will be cloned
   * @param language - Primary language (or 'multi-runtime' for unified)
   * @param customConfig - Additional sandbox configuration including workspaceMounts
   * @param repoType - Repository type for preview selection
   */
  async findOrCreateSandbox(
    taskId: string,
    projectId: string,
    repoName: string,
    _plannedFiles: string[], // Kept for API compatibility, not used
    workspacePath: string,
    language: string,
    customConfig?: any,
    repoType?: 'frontend' | 'backend' | 'mobile' | 'shared' | 'fullstack'
  ): Promise<{ sandbox: SandboxInstance | null; reused: boolean }> {

    // 🔥 For unified sandbox, use taskId as key (one sandbox per task)
    const isUnified = repoName === 'unified' || language === 'multi-runtime';
    const sandboxKey = isUnified ? taskId : this.buildSandboxKey(taskId, repoName);

    // Map repoType to sandboxType for preview
    const sandboxType: 'frontend' | 'backend' | 'fullstack' | undefined =
      repoType === 'fullstack' ? 'fullstack' :
      repoType === 'mobile' || repoType === 'frontend' ? 'frontend' :
      repoType === 'backend' ? 'backend' : undefined;

    console.log(`🐳 [Sandbox] Request: ${sandboxKey}`);
    console.log(`   Project: ${projectId}`);
    console.log(`   Language: ${language}`);
    console.log(`   RepoType: ${repoType || 'unknown'}`);
    console.log(`   Unified: ${isUnified}`);

    // Check if sandbox already exists for THIS task (or task+repo)
    const existing = this.sandboxes.get(sandboxKey);
    if (existing && existing.sandbox.status === 'running') {
      console.log(`♻️ [Sandbox] Reusing existing sandbox for ${sandboxKey}`);
      return { sandbox: existing.sandbox, reused: true };
    }

    // For unified sandbox, also check if ANY sandbox exists for this taskId
    if (isUnified) {
      for (const [_key, entry] of this.sandboxes) {
        if (entry.taskId === taskId && entry.sandbox.status === 'running') {
          console.log(`♻️ [Sandbox] Reusing existing unified sandbox for task ${taskId}`);
          return { sandbox: entry.sandbox, reused: true };
        }
      }
    }

    // Create NEW sandbox (no pooling, no reuse from other tasks)
    console.log(`🆕 [Sandbox] Creating new sandbox for ${sandboxKey}`);

    // For unified sandbox, use just taskId as the sandbox ID
    const sandboxId = isUnified ? taskId : `${taskId}-${repoName}`;

    try {
      const sandbox = await sandboxService.createSandbox(
        sandboxId,
        workspacePath,
        language,
        customConfig,
        isUnified ? 'unified' : repoName,
        sandboxType as 'frontend' | 'backend' | 'fullstack' | undefined
      );

      if (sandbox) {
        this.sandboxes.set(sandboxKey, {
          taskId,
          repoName: isUnified ? 'unified' : repoName,
          sandbox,
          language,
          createdAt: new Date(),
        });

        this.emit('sandbox:created', { taskId, repoName: isUnified ? 'unified' : repoName, sandboxKey });
        console.log(`✅ [Sandbox] Created: ${sandboxKey}`);

        // Log workspace mounts if any
        if (customConfig?.workspaceMounts) {
          console.log(`   📁 Workspace mounts:`);
          for (const [host, container] of Object.entries(customConfig.workspaceMounts)) {
            console.log(`      ${host} → ${container}`);
          }
        }
      }

      return { sandbox, reused: false };
    } catch (error: any) {
      console.error(`❌ [Sandbox] Creation failed: ${error.message}`);
      this.emit('sandbox:error', { taskId, repoName, error: error.message });
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Key Generation
  // --------------------------------------------------------------------------

  private buildSandboxKey(taskId: string, repoName: string): string {
    return `${taskId}/${repoName}`.toLowerCase();
  }

  // --------------------------------------------------------------------------
  // Task Lifecycle (API Compatibility)
  // --------------------------------------------------------------------------

  /**
   * Update planned files for a task (no-op, kept for API compatibility)
   */
  updateTaskFiles(
    _taskId: string,
    _projectId: string,
    _repoName: string,
    _plannedFiles: string[]
  ): void {
    // No-op: We don't track planned files anymore
  }

  /**
   * Mark task as completed (triggers sandbox destruction)
   */
  completeTask(
    taskId: string,
    projectId: string,
    repoName: string,
    _success: boolean = true
  ): void {
    const sandboxKey = this.buildSandboxKey(taskId, repoName);
    const entry = this.sandboxes.get(sandboxKey);

    if (entry) {
      console.log(`✅ [Sandbox] Task completed: ${sandboxKey}`);
      this.emit('task:completed', { taskId, repoName, projectId });
    }
  }

  /**
   * Complete task by ID only (searches all sandboxes)
   */
  completeTaskById(taskId: string, _success: boolean = true): boolean {
    let found = false;
    for (const [_key, entry] of this.sandboxes) {
      if (entry.taskId === taskId) {
        found = true;
        this.emit('task:completed', { taskId, repoName: entry.repoName });
      }
    }
    return found;
  }

  // --------------------------------------------------------------------------
  // Sandbox Management
  // --------------------------------------------------------------------------

  /**
   * Get sandbox for a specific task + repo
   */
  getSandbox(taskId: string, repoName: string): SandboxInstance | null {
    const key = this.buildSandboxKey(taskId, repoName);
    return this.sandboxes.get(key)?.sandbox || null;
  }

  /**
   * Get all sandboxes for a task
   */
  getTaskSandboxes(taskId: string): TaskSandbox[] {
    const results: TaskSandbox[] = [];
    for (const [_key, entry] of this.sandboxes) {
      if (entry.taskId === taskId) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Destroy a specific sandbox
   */
  async destroySandbox(taskId: string, repoName: string): Promise<boolean> {
    const key = this.buildSandboxKey(taskId, repoName);
    const entry = this.sandboxes.get(key);

    if (!entry) {
      return false;
    }

    console.log(`🗑️ [Sandbox] Destroying: ${key}`);

    await sandboxService.destroySandbox(`${taskId}-${repoName}`);
    this.sandboxes.delete(key);

    this.emit('sandbox:destroyed', { taskId, repoName });
    return true;
  }

  /**
   * 🔥 DESTROY ALL sandboxes for a task (called when task completes/fails)
   */
  async destroyTaskSandboxes(taskId: string): Promise<number> {
    let destroyedCount = 0;

    const toDestroy: string[] = [];
    for (const [key, entry] of this.sandboxes) {
      if (entry.taskId === taskId) {
        toDestroy.push(key);
      }
    }

    for (const key of toDestroy) {
      const entry = this.sandboxes.get(key);
      if (entry) {
        console.log(`🗑️ [Sandbox] Destroying: ${key}`);
        await sandboxService.destroySandbox(`${taskId}-${entry.repoName}`);
        this.sandboxes.delete(key);
        destroyedCount++;
      }
    }

    if (destroyedCount > 0) {
      console.log(`🧹 [Sandbox] Destroyed ${destroyedCount} sandbox(es) for task ${taskId}`);
      this.emit('task:cleanup', { taskId, destroyedCount });
    }

    return destroyedCount;
  }

  /**
   * Destroy all sandboxes for a project (called when project is deleted)
   */
  async destroyProjectSandboxes(projectId: string): Promise<number> {
    // Note: We don't track projectId - this is for cleanup when needed
    let destroyedCount = 0;

    // Cleanup project network
    try {
      await projectNetworkService.removeProjectNetwork(projectId);
      console.log(`🌐 [Sandbox] Cleaned up project network for ${projectId}`);
    } catch (error: any) {
      console.warn(`⚠️ [Sandbox] Network cleanup failed: ${error.message}`);
    }

    return destroyedCount;
  }

  // --------------------------------------------------------------------------
  // Compatibility Methods (for existing callers)
  // --------------------------------------------------------------------------

  /**
   * @deprecated Use destroyTaskSandboxes instead
   */
  async destroyPool(_projectId: string, repoName: string): Promise<boolean> {
    for (const [_key, entry] of this.sandboxes) {
      if (entry.repoName === repoName) {
        await this.destroySandbox(entry.taskId, repoName);
        return true;
      }
    }
    return false;
  }

  /**
   * @deprecated Use destroyProjectSandboxes instead
   */
  async destroyProjectPools(projectId: string): Promise<number> {
    return this.destroyProjectSandboxes(projectId);
  }

  /**
   * Get pool status (compatibility method)
   */
  getPoolStatus(_projectId: string, repoName: string): {
    exists: boolean;
    status: 'ready' | 'none';
    activeTasks: number;
    sandbox: SandboxInstance | null;
  } | null {
    for (const [_key, entry] of this.sandboxes) {
      if (entry.repoName === repoName) {
        return {
          exists: true,
          status: 'ready',
          activeTasks: 1,
          sandbox: entry.sandbox,
        };
      }
    }
    return null;
  }

  /**
   * Get pool init status (compatibility method)
   */
  getPoolInitStatus(_projectId: string, _repoName: string): {
    exists: boolean;
    status: 'ready' | 'none';
  } {
    return { exists: false, status: 'none' };
  }

  /**
   * Get all active sandboxes
   */
  getAllSandboxes(): Map<string, TaskSandbox> {
    return this.sandboxes;
  }

  /**
   * Get all pools (compatibility - returns sandboxes formatted as pools)
   */
  getAllPools(): Map<string, {
    projectId: string;
    repoName: string;
    activeTasks: number;
    sandboxId: string;
    createdAt: Date;
    lastUsedAt: Date;
  }> {
    const result = new Map();
    for (const [key, entry] of this.sandboxes) {
      result.set(key, {
        projectId: 'unknown', // We don't track projectId
        repoName: entry.repoName,
        activeTasks: 1,
        sandboxId: entry.sandbox.containerId,
        createdAt: entry.createdAt,
        lastUsedAt: entry.createdAt,
      });
    }
    return result;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalPools: number;
    totalActiveTasks: number;
    poolsByProject: Map<string, { pools: number; activeTasks: number }>;
  } {
    const sandboxesByTask = new Map<string, number>();

    for (const [_key, entry] of this.sandboxes) {
      const current = sandboxesByTask.get(entry.taskId) || 0;
      sandboxesByTask.set(entry.taskId, current + 1);
    }

    return {
      totalPools: this.sandboxes.size,
      totalActiveTasks: sandboxesByTask.size,
      poolsByProject: new Map(), // Not tracked in simplified model
    };
  }

  // --------------------------------------------------------------------------
  // Persistence (No-op - sandboxes are ephemeral)
  // --------------------------------------------------------------------------

  /**
   * @deprecated No persistence in simplified model
   */
  async restoreFromDatabase(): Promise<void> {
    console.log('[Sandbox] No persistence - sandboxes are ephemeral per task');
  }

  /**
   * Cleanup idle sandboxes (compatibility method)
   */
  async cleanupIdleSandboxes(_maxIdleMs: number = 30 * 60 * 1000): Promise<number> {
    // In simplified model, sandboxes are destroyed when task completes
    return 0;
  }

  /**
   * @deprecated Alias for cleanupIdleSandboxes
   */
  async cleanupIdlePools(maxIdleMs: number = 30 * 60 * 1000): Promise<number> {
    return this.cleanupIdleSandboxes(maxIdleMs);
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const sandboxPoolService = new SandboxPoolService();
export default sandboxPoolService;
