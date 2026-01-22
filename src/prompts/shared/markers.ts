/**
 * Shared Markers and Output Formats
 *
 * Standard markers that agents use to signal completion status.
 * Parsed by the orchestration system to determine workflow transitions.
 */

/**
 * Completion markers for different agent types
 */
export const COMPLETION_MARKERS = {
  // Developer completion markers
  DEVELOPER_SUCCESS: '✅ DEVELOPER_FINISHED_SUCCESSFULLY',
  DEVELOPER_FAILED: '❌ DEVELOPER_FAILED',

  // Judge completion markers
  JUDGE_APPROVED: '✅ APPROVED',
  JUDGE_NEEDS_CHANGES: '🔄 NEEDS_CHANGES',
  JUDGE_REJECTED: '❌ REJECTED',

  // Planning completion markers
  ARCHITECTURE_COMPLETE: '✅ ARCHITECTURE_COMPLETE',
  PATTERNS_DISCOVERED: '✅ PATTERNS_DISCOVERED',

  // General markers
  TASK_COMPLETE: '✅ TASK_COMPLETE',
  ERROR_OCCURRED: '❌ ERROR',
} as const;

/**
 * Required markers that must be present in developer output
 */
export const DEVELOPER_REQUIRED_MARKERS = `
## 📍 REQUIRED OUTPUT MARKERS

You MUST include these markers in your final output for the orchestration system:

### On Success:
\`\`\`
✅ DEVELOPER_FINISHED_SUCCESSFULLY
📍 Commit SHA: <actual-commit-sha>
🌿 Branch: <branch-name>
📁 Files Modified: <list of files>
\`\`\`

### On Failure:
\`\`\`
❌ DEVELOPER_FAILED
Reason: <why it failed>
Blocked By: <what's blocking completion>
\`\`\`

⚠️ WITHOUT THESE MARKERS, the system cannot track your progress!
`;

/**
 * Required markers for judge output
 */
export const JUDGE_REQUIRED_MARKERS = `
## 📍 REQUIRED OUTPUT FORMAT

Your review MUST end with one of these verdicts:

### If code is good:
\`\`\`
✅ APPROVED
Reason: <brief summary of why code is acceptable>
\`\`\`

### If code needs changes:
\`\`\`
🔄 NEEDS_CHANGES
Issues:
1. <issue 1>
2. <issue 2>
Required Fixes:
- <specific fix needed>
\`\`\`

### If code is fundamentally broken:
\`\`\`
❌ REJECTED
Critical Issues:
- <major problem>
Recommendation: <what Developer should do>
\`\`\`
`;
