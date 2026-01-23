/**
 * State Checker - Unified state validation across all state systems
 *
 * PROBLEM SOLVED:
 * Previously, the codebase had 4 different state systems (EventStore, UnifiedMemory,
 * GranularMemory, context flags) that were checked inconsistently, leading to:
 * - Race conditions when systems disagreed
 * - Redundant code checking the same state multiple ways
 * - Confusing logic about which source to trust
 *
 * SOLUTION:
 * This module establishes a clear hierarchy:
 * 1. EventStore - PRIMARY source of truth (event-sourced, recoverable)
 * 2. UnifiedMemory - SECONDARY for recovery scenarios
 * 3. In-memory flags - FAST PATH optimization only
 *
 * GranularMemoryService is intentionally NOT included - it's redundant with UnifiedMemory.
 */

import { unifiedMemoryService } from '../../UnifiedMemoryService';

/**
 * Result of checking if a story is complete
 */
export interface StoryCompletionStatus {
  isComplete: boolean;
  source: 'eventstore' | 'unified_memory' | 'merged_flag' | 'not_complete';
  details?: string;
}

/**
 * Result of checking if an epic is complete
 */
export interface EpicCompletionStatus {
  isComplete: boolean;
  source: 'eventstore' | 'unified_memory' | 'not_complete';
  completedStories: string[];
  totalStories: number;
}

/**
 * Cached completion data to avoid repeated async calls
 */
export interface CompletionCache {
  unifiedMemoryStories: string[];
  unifiedMemoryEpics: string[];
  loadedAt: number;
}

/**
 * Check if a story is complete using the hierarchical state system
 *
 * Hierarchy (first match wins):
 * 1. EventStore status === 'completed' → Complete
 * 2. story.mergedToEpic === true → Complete (fast path)
 * 3. UnifiedMemory completedStories includes storyId → Complete
 * 4. None of the above → Not complete
 *
 * @param story - The story object from EventStore
 * @param storyId - Normalized story ID
 * @param unifiedMemoryCompletedStories - Pre-loaded list from UnifiedMemory (for batch efficiency)
 * @returns Completion status with source information
 */
export function isStoryComplete(
  story: { status?: string; mergedToEpic?: boolean },
  storyId: string,
  unifiedMemoryCompletedStories: string[] = []
): StoryCompletionStatus {
  // 1. EventStore is PRIMARY - if it says complete, it's complete
  if (story.status === 'completed') {
    return {
      isComplete: true,
      source: 'eventstore',
      details: 'Story marked as completed in EventStore',
    };
  }

  // 2. Fast path - in-memory flag from previous execution
  if (story.mergedToEpic === true) {
    return {
      isComplete: true,
      source: 'merged_flag',
      details: 'Story has mergedToEpic flag set',
    };
  }

  // 3. UnifiedMemory - for recovery scenarios
  if (unifiedMemoryCompletedStories.includes(storyId)) {
    return {
      isComplete: true,
      source: 'unified_memory',
      details: 'Story found in UnifiedMemory completedStories',
    };
  }

  // 4. Not complete in any source
  return {
    isComplete: false,
    source: 'not_complete',
  };
}

/**
 * Load completed stories from UnifiedMemory for a task
 * This should be called once per task and cached for batch checking
 *
 * @param taskId - The task ID
 * @returns Array of completed story IDs
 */
export async function loadUnifiedMemoryCompletedStories(taskId: string): Promise<string[]> {
  try {
    const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
    if (resumption && resumption.completedStories && resumption.completedStories.length > 0) {
      console.log(`💾 [StateChecker] UnifiedMemory: ${resumption.completedStories.length} completed stories`);
      return resumption.completedStories;
    }
    return [];
  } catch (error: any) {
    console.warn(`⚠️ [StateChecker] Failed to load UnifiedMemory: ${error.message}`);
    return [];
  }
}

/**
 * Load completed epics from UnifiedMemory for a task
 *
 * @param taskId - The task ID
 * @returns Array of completed epic IDs
 */
export async function loadUnifiedMemoryCompletedEpics(taskId: string): Promise<string[]> {
  try {
    const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
    if (resumption && resumption.completedEpics && resumption.completedEpics.length > 0) {
      console.log(`💾 [StateChecker] UnifiedMemory: ${resumption.completedEpics.length} completed epics`);
      return resumption.completedEpics;
    }
    return [];
  } catch (error: any) {
    console.warn(`⚠️ [StateChecker] Failed to load UnifiedMemory epics: ${error.message}`);
    return [];
  }
}

/**
 * Log completion status in a consistent format
 *
 * @param storyTitle - Story title for logging
 * @param storyId - Story ID
 * @param status - Completion status from isStoryComplete
 */
export function logStorySkip(
  storyTitle: string,
  storyId: string,
  status: StoryCompletionStatus
): void {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`⏭️ [STORY SKIP] Already completed: ${storyTitle}`);
  console.log(`   Story ID: ${storyId}`);
  console.log(`   Source: ${formatSource(status.source)}`);
  if (status.details) {
    console.log(`   Details: ${status.details}`);
  }
  console.log(`${'='.repeat(80)}`);
}

/**
 * Format source name for logging
 */
function formatSource(source: string): string {
  const formats: Record<string, string> = {
    eventstore: '✅ EventStore (primary)',
    unified_memory: '✅ UnifiedMemory (recovery)',
    merged_flag: '✅ Merged flag (fast path)',
    not_complete: '❌ Not complete',
  };
  return formats[source] || source;
}

/**
 * Mark a story as complete in all relevant state systems
 * This ensures consistency across systems when a story completes
 *
 * @param taskId - The task ID
 * @param epicId - The epic ID
 * @param storyId - The story ID
 * @param commitSHA - The commit SHA (optional)
 */
export async function markStoryComplete(
  taskId: string,
  epicId: string,
  storyId: string,
  commitSHA?: string
): Promise<void> {
  // 1. EventStore - emit StoryCompleted event
  try {
    const { eventStore } = await import('../../EventStore');
    await eventStore.safeAppend({
      taskId: taskId as any,
      eventType: 'StoryCompleted',
      agentName: 'system',
      payload: {
        storyId,
        epicId,
        commitSHA,
        completedAt: new Date().toISOString(),
      },
    });
    console.log(`📝 [StateChecker] EventStore: StoryCompleted emitted`);
  } catch (error: any) {
    console.error(`❌ [StateChecker] Failed to emit StoryCompleted: ${error.message}`);
  }

  // 2. UnifiedMemory - save story progress as completed
  try {
    await unifiedMemoryService.saveStoryProgress(taskId, epicId, storyId, 'completed', {
      commitHash: commitSHA,
    });
    console.log(`💾 [StateChecker] UnifiedMemory: Story marked as completed`);
  } catch (error: any) {
    console.warn(`⚠️ [StateChecker] Failed to update UnifiedMemory: ${error.message}`);
  }
}

/**
 * Mark an epic as complete in all relevant state systems
 *
 * @param taskId - The task ID
 * @param epicId - The epic ID
 * @param branchName - The epic branch name (optional)
 */
export async function markEpicComplete(
  taskId: string,
  epicId: string,
  _branchName?: string
): Promise<void> {
  // 1. EventStore - emit DevelopersCompleted event (used for epic completion)
  try {
    const { eventStore } = await import('../../EventStore');
    await eventStore.safeAppend({
      taskId: taskId as any,
      eventType: 'DevelopersCompleted',
      agentName: 'system',
      payload: {
        epicId,
        completedAt: new Date().toISOString(),
        success: true,
      },
    });
    console.log(`📝 [StateChecker] EventStore: DevelopersCompleted emitted for epic`);
  } catch (error: any) {
    console.error(`❌ [StateChecker] Failed to emit DevelopersCompleted: ${error.message}`);
  }

  // Note: UnifiedMemory epic completion is handled via the execution map epics array
  // The caller should update the epic status in the execution map directly
}
