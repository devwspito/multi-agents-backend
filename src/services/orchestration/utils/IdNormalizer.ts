/**
 * ID Normalizer - Centralized ID extraction for epics and stories
 *
 * CRITICAL: This module ensures ID consistency across the entire orchestration flow.
 * All code that needs an epicId or storyId MUST use these functions.
 *
 * The problem this solves:
 * - Different files used different fallback patterns:
 *   - `e.id || e.title`
 *   - `e.id || e.epicId`
 *   - `epic.id || epic.epicId`
 *   - `epic.id` directly
 * - This caused ID mismatches between registration and lookup, breaking recovery.
 *
 * Now there is ONE source of truth for ID extraction.
 */

/**
 * Extract a consistent epic ID from any epic-like object.
 *
 * Priority order:
 * 1. epic.id (most common, from planning output)
 * 2. epic.epicId (from execution map)
 * 3. epic.title (last resort fallback)
 *
 * @throws Error if no valid ID can be extracted (fail-fast, don't silently return garbage)
 */
export function getEpicId(epic: any): string {
  if (!epic) {
    throw new Error('[IdNormalizer] CRITICAL: Cannot extract epicId from null/undefined epic');
  }

  const id = epic.id || epic.epicId || epic.title;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      `[IdNormalizer] CRITICAL: Cannot extract epicId from epic. ` +
        `Object has: id=${epic.id}, epicId=${epic.epicId}, title=${epic.title}`
    );
  }

  return id.trim();
}

/**
 * Extract a consistent story ID from any story-like object.
 *
 * Priority order:
 * 1. story.id (most common, from tech lead output)
 * 2. story.storyId (from execution map)
 * 3. story.title (last resort fallback)
 *
 * @throws Error if no valid ID can be extracted (fail-fast, don't silently return garbage)
 */
export function getStoryId(story: any): string {
  if (!story) {
    throw new Error('[IdNormalizer] CRITICAL: Cannot extract storyId from null/undefined story');
  }

  const id = story.id || story.storyId || story.title;

  if (!id || typeof id !== 'string' || id.trim() === '') {
    throw new Error(
      `[IdNormalizer] CRITICAL: Cannot extract storyId from story. ` +
        `Object has: id=${story.id}, storyId=${story.storyId}, title=${story.title}`
    );
  }

  return id.trim();
}

/**
 * Safely get epic ID with a default value instead of throwing.
 * Use this only in logging/display contexts, NOT for registration/lookup.
 */
export function getEpicIdSafe(epic: any, defaultValue = 'unknown-epic'): string {
  try {
    return getEpicId(epic);
  } catch {
    return defaultValue;
  }
}

/**
 * Safely get story ID with a default value instead of throwing.
 * Use this only in logging/display contexts, NOT for registration/lookup.
 */
export function getStoryIdSafe(story: any, defaultValue = 'unknown-story'): string {
  try {
    return getStoryId(story);
  } catch {
    return defaultValue;
  }
}

/**
 * Validate that an array of epics all have extractable IDs.
 * Call this early in the flow to fail fast if data is malformed.
 */
export function validateEpicIds(epics: any[]): void {
  if (!Array.isArray(epics)) {
    throw new Error('[IdNormalizer] CRITICAL: epics is not an array');
  }

  for (let i = 0; i < epics.length; i++) {
    try {
      getEpicId(epics[i]);
    } catch (error: any) {
      throw new Error(
        `[IdNormalizer] CRITICAL: Epic at index ${i} has no valid ID. ${error.message}`
      );
    }
  }
}

/**
 * Validate that an array of stories all have extractable IDs.
 * Call this early in the flow to fail fast if data is malformed.
 */
export function validateStoryIds(stories: any[]): void {
  if (!Array.isArray(stories)) {
    throw new Error('[IdNormalizer] CRITICAL: stories is not an array');
  }

  for (let i = 0; i < stories.length; i++) {
    try {
      getStoryId(stories[i]);
    } catch (error: any) {
      throw new Error(
        `[IdNormalizer] CRITICAL: Story at index ${i} has no valid ID. ${error.message}`
      );
    }
  }
}
