/**
 * MarkerValidator - Utility for validating agent output markers
 *
 * Following Anthropic SDK Best Practices:
 * - Agents communicate in natural language (plain text)
 * - Use markers/signals embedded in text, not rigid JSON formats
 * - Be tolerant to markdown formatting variations
 *
 * @see https://skywork.ai/blog/claude-agent-sdk-best-practices-ai-agents-2025/
 * @see PLAIN_TEXT_VS_JSON.md for detailed rationale
 */

/**
 * Check if output contains a marker, with tolerance for markdown formatting
 *
 * Allows all these variations:
 * - "✅ MARKER_NAME" (plain text)
 * - "**✅ MARKER_NAME**" (bold markdown)
 * - "### ✅ MARKER_NAME" (header markdown)
 * - "- ✅ MARKER_NAME" (bullet list)
 * - "#### **✅ MARKER_NAME**" (header + bold)
 *
 * @param output - Agent output text to search
 * @param marker - Exact marker string to find (e.g., "✅ TESTS_PASSED")
 * @returns true if marker is found (with or without markdown)
 *
 * @example
 * ```typescript
 * const output = "### **✅ TESTS_PASSED**\nAll tests succeeded!";
 * hasMarker(output, '✅ TESTS_PASSED'); // → true
 * ```
 */
export function hasMarker(output: string, marker: string): boolean {
  if (!output) return false;

  // Remove markdown formatting characters for matching
  // This makes validation robust against formatting variations
  const cleanOutput = output.replace(/[*#\-_`]/g, '');

  return cleanOutput.includes(marker);
}

/**
 * Validate multiple required markers are all present
 *
 * @param output - Agent output text
 * @param markers - Array of required marker strings
 * @returns Object with validation result and details
 *
 * @example
 * ```typescript
 * const result = validateMarkers(output, [
 *   '✅ TYPECHECK_PASSED',
 *   '✅ TESTS_PASSED',
 *   '✅ LINT_PASSED'
 * ]);
 *
 * if (!result.allPresent) {
 *   console.error('Missing markers:', result.missing);
 * }
 * ```
 */
export function validateMarkers(
  output: string,
  markers: string[]
): {
  allPresent: boolean;
  present: string[];
  missing: string[];
  results: Record<string, boolean>;
} {
  const results: Record<string, boolean> = {};
  const present: string[] = [];
  const missing: string[] = [];

  for (const marker of markers) {
    const found = hasMarker(output, marker);
    results[marker] = found;

    if (found) {
      present.push(marker);
    } else {
      missing.push(marker);
    }
  }

  return {
    allPresent: missing.length === 0,
    present,
    missing,
    results,
  };
}

/**
 * Extract value after a marker pattern
 *
 * Useful for extracting data like:
 * - "📍 Commit SHA: abc123def456..."
 * - "📊 Test Count: 25"
 * - "⏱️ Duration: 5.3s"
 *
 * @param output - Agent output text
 * @param markerPrefix - Marker prefix (e.g., "📍 Commit SHA:")
 * @returns Extracted value or null if not found
 *
 * @example
 * ```typescript
 * const sha = extractMarkerValue(output, '📍 Commit SHA:');
 * // Returns: "abc123def456789..."
 * ```
 */
export function extractMarkerValue(
  output: string,
  markerPrefix: string
): string | null {
  if (!output) return null;

  // Clean markdown from the marker prefix for flexible matching
  const cleanPrefix = markerPrefix.replace(/[*#\-_`]/g, '');
  const cleanOutput = output.replace(/[*#\-_`]/g, '');

  const regex = new RegExp(`${escapeRegex(cleanPrefix)}\\s*([^\\s\\n]+)`, 'i');
  const match = cleanOutput.match(regex);

  return match ? match[1].trim() : null;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Common marker patterns used across phases
 * Centralized here for consistency
 */
export const COMMON_MARKERS = {
  // Development
  TYPECHECK_PASSED: '✅ TYPECHECK_PASSED',
  TESTS_PASSED: '✅ TESTS_PASSED',
  LINT_PASSED: '✅ LINT_PASSED',
  BUILD_PASSED: '✅ BUILD_PASSED',

  // Status
  SUCCESS: '✅ SUCCESS',
  FINISHED: '✅ FINISHED_SUCCESSFULLY',
  DEVELOPER_FINISHED: '✅ DEVELOPER_FINISHED_SUCCESSFULLY', // Developer-specific marker
  FAILED: '❌ FAILED',
  APPROVED: '✅ APPROVED',
  REJECTED: '❌ REJECTED',

  // Code Review (Judge)
  JUDGE_APPROVED: '✅ APPROVED',
  JUDGE_REJECTED: '❌ REJECTED',
  JUDGE_NEEDS_CHANGES: '⚠️ NEEDS_CHANGES',

  // Testing (QA)
  QA_PASSED: '✅ QA_PASSED',
  QA_FAILED: '❌ QA_FAILED',
  INTEGRATION_TESTS_PASSED: '✅ INTEGRATION_TESTS_PASSED',

  // Fixing
  FIX_APPLIED: '✅ FIX_APPLIED',
  FIX_VERIFIED: '✅ FIX_VERIFIED',

  // Data markers
  COMMIT_SHA: '📍 Commit SHA:',
  PR_NUMBER: '📍 PR Number:',
  BRANCH_NAME: '📍 Branch:',
} as const;
