/**
 * ContextCheckpointService
 *
 * Persists OrchestrationContext state to SQLite for crash recovery.
 *
 * Architecture:
 * - Saves checkpoint after EACH phase completion
 * - Restores checkpoint at orchestration START
 * - Uses task.orchestration.checkpoint (SQLite JSON field)
 *
 * Priority for restoration:
 * 1. EventStore (rebuild state from events - most reliable)
 * 2. task.orchestration.checkpoint (fast snapshot)
 * 3. task.orchestration.branchRegistry (legacy)
 */

import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { eventStore } from '../EventStore.js';
import type { OrchestrationContext, BranchInfo } from './Phase.js';

// ============================================================================
// Types
// ============================================================================

export interface RestoreResult {
  restored: boolean;
  source: 'events' | 'checkpoint' | 'legacy' | 'none';
  details: string;
  branchCount?: number;
  epicCount?: number;
  storyCount?: number;
}

// ============================================================================
// ContextCheckpointService Class
// ============================================================================

class ContextCheckpointService {
  /**
   * Save context checkpoint to SQLite
   * Called after each phase completes
   */
  saveCheckpoint(taskId: string, context: OrchestrationContext): void {
    try {
      const checkpoint = context.toCheckpoint();

      TaskRepository.modifyOrchestration(taskId, (orch) => ({
        ...orch,
        checkpoint: {
          ...checkpoint,
          savedAt: new Date(),
        },
      }));

      console.log(`💾 [Checkpoint] Saved: ${checkpoint.branchRegistry.length} branches, ${checkpoint.phaseResults?.length || 0} phases`);
    } catch (error: any) {
      console.error(`❌ [Checkpoint] Save failed: ${error.message}`);
      // Don't throw - checkpoint is non-critical
    }
  }

  /**
   * Restore context from checkpoint OR EventStore
   * Called at orchestration start
   *
   * Priority:
   * 1. EventStore (rebuild state from events - most reliable)
   * 2. task.orchestration.checkpoint (fast snapshot)
   * 3. task.orchestration.branchRegistry (legacy)
   */
  async restoreContext(taskId: string, context: OrchestrationContext): Promise<RestoreResult> {
    // 🔥 PRIORITY 1: Rebuild from EventStore (most reliable)
    try {
      const eventState = await eventStore.getCurrentState(taskId);

      if (eventState && eventState.epics && eventState.epics.length > 0) {
        let branchCount = 0;

        // Restore branches from event state
        for (const epic of eventState.epics) {
          if (epic.branchName) {
            context.registerBranch({
              name: epic.branchName,
              type: 'epic',
              epicId: epic.id,
              repository: epic.targetRepository || '',
              createdAt: new Date(),
            });
            branchCount++;
          }
        }

        for (const story of eventState.stories || []) {
          if (story.branchName) {
            context.registerBranch({
              name: story.branchName,
              type: 'story',
              epicId: story.epicId,
              storyId: story.id,
              repository: story.targetRepository || '',
              createdAt: new Date(),
            });
            branchCount++;
          }
        }

        // Restore shared data from events
        if (eventState.epics.length > 0) {
          context.setData('epics', eventState.epics);
        }
        if (eventState.stories && eventState.stories.length > 0) {
          context.setData('stories', eventState.stories);
        }
        if (eventState.teamComposition) {
          context.setData('teamComposition', eventState.teamComposition);
        }
        if (eventState.environmentConfig) {
          context.setData('environmentConfig', eventState.environmentConfig);
        }

        console.log(`🔄 [Checkpoint] Restored from EventStore: ${branchCount} branches, ${eventState.epics.length} epics, ${eventState.stories?.length || 0} stories`);

        return {
          restored: true,
          source: 'events',
          details: `${branchCount} branches, ${eventState.epics.length} epics`,
          branchCount,
          epicCount: eventState.epics.length,
          storyCount: eventState.stories?.length || 0,
        };
      }
    } catch (error: any) {
      console.warn(`⚠️ [Checkpoint] EventStore restore failed: ${error.message}`);
    }

    // 🔥 PRIORITY 2: Restore from checkpoint snapshot
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return { restored: false, source: 'none', details: 'Task not found' };
    }

    const checkpoint = (task.orchestration as any)?.checkpoint;
    if (checkpoint?.branchRegistry?.length > 0) {
      try {
        context.restoreFromCheckpoint(checkpoint);

        return {
          restored: true,
          source: 'checkpoint',
          details: `${checkpoint.branchRegistry.length} branches from snapshot`,
          branchCount: checkpoint.branchRegistry.length,
        };
      } catch (error: any) {
        console.warn(`⚠️ [Checkpoint] Snapshot restore failed: ${error.message}`);
      }
    }

    // 🔥 PRIORITY 3: Legacy - restore from branchRegistry array
    const legacyBranches = (task.orchestration as any)?.branchRegistry;
    if (Array.isArray(legacyBranches) && legacyBranches.length > 0) {
      let restoredCount = 0;
      for (const branch of legacyBranches) {
        if (branch.name && !context.branchRegistry.has(branch.name)) {
          context.registerBranch(branch as BranchInfo);
          restoredCount++;
        }
      }

      console.log(`🔄 [Checkpoint] Restored from legacy branchRegistry: ${restoredCount} branches`);
      return {
        restored: true,
        source: 'legacy',
        details: `${restoredCount} branches from legacy format`,
        branchCount: restoredCount,
      };
    }

    return { restored: false, source: 'none', details: 'No checkpoint data found' };
  }

  /**
   * Clear checkpoint (called when task completes/fails)
   */
  clearCheckpoint(taskId: string): void {
    try {
      TaskRepository.modifyOrchestration(taskId, (orch) => {
        if (!orch) return orch;
        const { checkpoint, ...rest } = orch as any;
        return rest;
      });
      console.log(`🧹 [Checkpoint] Cleared for task ${taskId}`);
    } catch (error: any) {
      console.warn(`⚠️ [Checkpoint] Clear failed: ${error.message}`);
    }
  }

  /**
   * Check if a checkpoint exists for a task
   */
  hasCheckpoint(taskId: string): boolean {
    const task = TaskRepository.findById(taskId);
    if (!task) return false;
    const checkpoint = (task.orchestration as any)?.checkpoint;
    return checkpoint?.branchRegistry?.length > 0 || checkpoint?.savedAt != null;
  }

  /**
   * Get checkpoint info without restoring
   */
  getCheckpointInfo(taskId: string): {
    exists: boolean;
    branchCount: number;
    phaseCount: number;
    savedAt: Date | null;
  } {
    const task = TaskRepository.findById(taskId);
    if (!task) {
      return { exists: false, branchCount: 0, phaseCount: 0, savedAt: null };
    }

    const checkpoint = (task.orchestration as any)?.checkpoint;
    if (!checkpoint) {
      return { exists: false, branchCount: 0, phaseCount: 0, savedAt: null };
    }

    return {
      exists: true,
      branchCount: checkpoint.branchRegistry?.length || 0,
      phaseCount: checkpoint.phaseResults?.length || 0,
      savedAt: checkpoint.savedAt ? new Date(checkpoint.savedAt) : null,
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const contextCheckpointService = new ContextCheckpointService();
export default contextCheckpointService;
