/**
 * Story Overlap Validator - Simplified
 *
 * Checks if stories have overlapping files that would cause merge conflicts.
 */

export interface StoryForValidation {
  id: string;
  title: string;
  filesToModify: string[];
  filesToCreate: string[];
  filesToRead: string[];
}

export interface OverlapResult {
  canRunInParallel: boolean;
  hasOverlap: boolean;
  conflicts: Array<{ file: string; stories: string[] }>;
}

export function validateStoryOverlap(stories: StoryForValidation[]): OverlapResult {
  const fileUsage: Map<string, string[]> = new Map();

  // Track which stories modify/create each file
  for (const story of stories) {
    const allFiles = [...(story.filesToModify || []), ...(story.filesToCreate || [])];
    for (const file of allFiles) {
      const existing = fileUsage.get(file) || [];
      existing.push(story.id);
      fileUsage.set(file, existing);
    }
  }

  // Find conflicts (files used by multiple stories)
  const conflicts: Array<{ file: string; stories: string[] }> = [];
  for (const [file, storyIds] of fileUsage) {
    if (storyIds.length > 1) {
      conflicts.push({ file, stories: storyIds });
    }
  }

  return {
    canRunInParallel: conflicts.length === 0,
    hasOverlap: conflicts.length > 0,
    conflicts,
  };
}

export function logOverlapValidation(result: OverlapResult, taskId: string): void {
  if (result.hasOverlap) {
    console.log(`\n⚠️  [StoryOverlap] Task ${taskId}: Found ${result.conflicts.length} file conflicts`);
    for (const conflict of result.conflicts.slice(0, 5)) {
      console.log(`   - ${conflict.file}: ${conflict.stories.join(', ')}`);
    }
  } else {
    console.log(`\n✅ [StoryOverlap] Task ${taskId}: No file overlaps, parallel execution safe`);
  }
}
