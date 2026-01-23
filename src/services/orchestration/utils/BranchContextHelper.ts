/**
 * BranchContextHelper
 *
 * Enriches branch names with semantic context for better agent inference.
 * Inspired by BrainGrid's git branch auto-detection pattern.
 *
 * Branch naming convention:
 * - Epic: epic/{taskShortId}-{epicSlug}-{repoType}
 * - Story: story/{epicId}-{storyNum}-{storySlug}
 *
 * Example:
 * - epic/abc123-user-auth-backend
 * - story/epic-auth-1-add-login-endpoint
 */

export interface BranchContext {
  type: 'epic' | 'story';
  taskId?: string;
  epicId?: string;
  storyId?: string;
  storyNum?: number;
  slug: string;
  repoType?: 'backend' | 'frontend' | 'mobile' | 'shared';
  raw: string;
}

/**
 * Generate enriched epic branch name
 */
export function generateEpicBranchName(
  taskShortId: string,
  epicTitle: string,
  repoType?: string
): string {
  const slug = slugify(epicTitle);
  const typeTag = repoType ? `-${repoType}` : '';
  return `epic/${taskShortId}-${slug}${typeTag}`;
}

/**
 * Generate enriched story branch name
 */
export function generateStoryBranchName(
  epicId: string,
  storyNum: number,
  storyTitle: string
): string {
  const slug = slugify(storyTitle);
  return `story/${epicId}-${storyNum}-${slug}`;
}

/**
 * Parse branch name to extract context
 */
export function parseBranchName(branchName: string): BranchContext | null {
  if (!branchName) return null;

  // Epic branch: epic/{taskId}-{slug}-{repoType?}
  const epicMatch = branchName.match(/^epic\/([a-z0-9]+)-(.+?)(?:-(backend|frontend|mobile|shared))?$/i);
  if (epicMatch) {
    return {
      type: 'epic',
      taskId: epicMatch[1],
      slug: epicMatch[2],
      repoType: epicMatch[3] as BranchContext['repoType'],
      raw: branchName,
    };
  }

  // Story branch: story/{epicId}-{num}-{slug}
  const storyMatch = branchName.match(/^story\/(.+?)-(\d+)-(.+)$/i);
  if (storyMatch) {
    return {
      type: 'story',
      epicId: storyMatch[1],
      storyNum: parseInt(storyMatch[2], 10),
      slug: storyMatch[3],
      raw: branchName,
    };
  }

  // Legacy epic format: epic/{epicId}
  const legacyEpicMatch = branchName.match(/^epic\/(.+)$/i);
  if (legacyEpicMatch) {
    return {
      type: 'epic',
      epicId: legacyEpicMatch[1],
      slug: legacyEpicMatch[1],
      raw: branchName,
    };
  }

  // Legacy story format: {epicId}-story-{num}
  const legacyStoryMatch = branchName.match(/^(.+)-story-(\d+)$/i);
  if (legacyStoryMatch) {
    return {
      type: 'story',
      epicId: legacyStoryMatch[1],
      storyNum: parseInt(legacyStoryMatch[2], 10),
      slug: `story-${legacyStoryMatch[2]}`,
      raw: branchName,
    };
  }

  return null;
}

/**
 * Extract semantic info from branch for prompt injection
 */
export function getBranchContextForPrompt(branchName: string): string {
  const ctx = parseBranchName(branchName);
  if (!ctx) return '';

  if (ctx.type === 'epic') {
    const parts = [`Epic branch: ${branchName}`];
    if (ctx.repoType) parts.push(`Repository type: ${ctx.repoType.toUpperCase()}`);
    if (ctx.slug) parts.push(`Feature: ${ctx.slug.replace(/-/g, ' ')}`);
    return parts.join('\n');
  }

  if (ctx.type === 'story') {
    const parts = [`Story branch: ${branchName}`];
    if (ctx.epicId) parts.push(`Parent epic: ${ctx.epicId}`);
    if (ctx.storyNum) parts.push(`Story number: ${ctx.storyNum}`);
    if (ctx.slug) parts.push(`Task: ${ctx.slug.replace(/-/g, ' ')}`);
    return parts.join('\n');
  }

  return '';
}

/**
 * Convert title to URL-safe slug
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-')         // Spaces to hyphens
    .replace(/-+/g, '-')          // Collapse multiple hyphens
    .replace(/^-|-$/g, '')        // Trim hyphens
    .slice(0, 30);                // Limit length
}

/**
 * Check if branch name follows enriched convention
 */
export function isEnrichedBranchName(branchName: string): boolean {
  const ctx = parseBranchName(branchName);
  if (!ctx) return false;

  // Check if it has slug (not just ID)
  return ctx.slug.length > 5 && ctx.slug.includes('-');
}
