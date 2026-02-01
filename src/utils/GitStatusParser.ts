/**
 * GitStatusParser
 *
 * Centralized utility for parsing git status output.
 * Replaces duplicated parsing logic across 15+ files.
 *
 * Usage:
 *   const status = await safeGitExec('git status --porcelain', { cwd: repoPath });
 *   const parsed = GitStatusParser.parse(status.stdout);
 *   console.log(parsed.modified, parsed.untracked, parsed.hasChanges);
 */

export interface GitStatusEntry {
  /** Two-character git status code (e.g., 'M ', ' M', '??', 'A ', etc.) */
  statusCode: string;
  /** Index status (first char): staged changes */
  indexStatus: string;
  /** Work tree status (second char): unstaged changes */
  workTreeStatus: string;
  /** File path */
  file: string;
  /** Original file path (for renames) */
  originalFile?: string;
}

export interface ParsedGitStatus {
  /** All entries from git status */
  entries: GitStatusEntry[];
  /** Files modified (staged or unstaged) */
  modified: string[];
  /** Untracked files */
  untracked: string[];
  /** Staged files (ready to commit) */
  staged: string[];
  /** Deleted files */
  deleted: string[];
  /** Renamed files */
  renamed: string[];
  /** Added files (new, staged) */
  added: string[];
  /** Conflicted files */
  conflicted: string[];
  /** All changed files (modified + untracked + deleted + renamed + added) */
  allChanges: string[];
  /** Whether there are any changes */
  hasChanges: boolean;
  /** Whether there are staged changes ready to commit */
  hasStaged: boolean;
  /** Whether there are unstaged changes */
  hasUnstaged: boolean;
  /** Whether there are untracked files */
  hasUntracked: boolean;
  /** Whether there are conflicts */
  hasConflicts: boolean;
}

export class GitStatusParser {
  /**
   * Parse git status --porcelain output
   *
   * Format: XY filename
   * Where X = index status, Y = work tree status
   *
   * Common codes:
   * - ' ' = unmodified
   * - M = modified
   * - A = added
   * - D = deleted
   * - R = renamed
   * - C = copied
   * - U = updated but unmerged (conflict)
   * - ? = untracked (both chars are ?)
   * - ! = ignored (both chars are !)
   */
  static parse(output: string | undefined | null): ParsedGitStatus {
    const result: ParsedGitStatus = {
      entries: [],
      modified: [],
      untracked: [],
      staged: [],
      deleted: [],
      renamed: [],
      added: [],
      conflicted: [],
      allChanges: [],
      hasChanges: false,
      hasStaged: false,
      hasUnstaged: false,
      hasUntracked: false,
      hasConflicts: false,
    };

    if (!output || !output.trim()) {
      return result;
    }

    const lines = output.trim().split('\n');

    for (const line of lines) {
      if (line.length < 3) continue;

      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const statusCode = line.substring(0, 2);

      // Handle rename format: R  old -> new
      let file = line.substring(3).trim();
      let originalFile: string | undefined;

      if (file.includes(' -> ')) {
        const parts = file.split(' -> ');
        originalFile = parts[0];
        file = parts[1];
      }

      const entry: GitStatusEntry = {
        statusCode,
        indexStatus,
        workTreeStatus,
        file,
        originalFile,
      };

      result.entries.push(entry);

      // Categorize by status
      if (statusCode === '??') {
        // Untracked
        result.untracked.push(file);
        result.hasUntracked = true;
      } else if (statusCode === '!!') {
        // Ignored - skip
        continue;
      } else {
        // Track conflicts (UU, AA, DD, AU, UA, DU, UD)
        if (indexStatus === 'U' || workTreeStatus === 'U' ||
            (indexStatus === 'A' && workTreeStatus === 'A') ||
            (indexStatus === 'D' && workTreeStatus === 'D')) {
          result.conflicted.push(file);
          result.hasConflicts = true;
        }

        // Track staged changes (index has change)
        if (indexStatus !== ' ' && indexStatus !== '?') {
          result.staged.push(file);
          result.hasStaged = true;

          if (indexStatus === 'A') {
            result.added.push(file);
          } else if (indexStatus === 'D') {
            result.deleted.push(file);
          } else if (indexStatus === 'R') {
            result.renamed.push(file);
          } else if (indexStatus === 'M') {
            result.modified.push(file);
          }
        }

        // Track unstaged changes (work tree has change)
        if (workTreeStatus !== ' ' && workTreeStatus !== '?') {
          result.hasUnstaged = true;

          if (workTreeStatus === 'M' && !result.modified.includes(file)) {
            result.modified.push(file);
          } else if (workTreeStatus === 'D' && !result.deleted.includes(file)) {
            result.deleted.push(file);
          }
        }
      }
    }

    // Build allChanges (deduplicated)
    result.allChanges = [
      ...new Set([
        ...result.modified,
        ...result.untracked,
        ...result.deleted,
        ...result.renamed,
        ...result.added,
      ]),
    ];

    result.hasChanges = result.allChanges.length > 0 || result.hasConflicts;

    return result;
  }

  /**
   * Check if a repo has any uncommitted changes
   * Convenience method for quick checks
   */
  static hasChanges(output: string | undefined | null): boolean {
    if (!output || !output.trim()) return false;
    return output.trim().length > 0;
  }

  /**
   * Get only untracked files from git status output
   */
  static getUntracked(output: string | undefined | null): string[] {
    return this.parse(output).untracked;
  }

  /**
   * Get only modified files from git status output
   */
  static getModified(output: string | undefined | null): string[] {
    return this.parse(output).modified;
  }

  /**
   * Get only staged files from git status output
   */
  static getStaged(output: string | undefined | null): string[] {
    return this.parse(output).staged;
  }

  /**
   * Check if there are conflicts
   */
  static hasConflicts(output: string | undefined | null): boolean {
    return this.parse(output).hasConflicts;
  }

  /**
   * Format a summary string for logging
   */
  static formatSummary(parsed: ParsedGitStatus): string {
    const parts: string[] = [];

    if (parsed.staged.length > 0) {
      parts.push(`${parsed.staged.length} staged`);
    }
    if (parsed.modified.length > 0) {
      parts.push(`${parsed.modified.length} modified`);
    }
    if (parsed.untracked.length > 0) {
      parts.push(`${parsed.untracked.length} untracked`);
    }
    if (parsed.deleted.length > 0) {
      parts.push(`${parsed.deleted.length} deleted`);
    }
    if (parsed.conflicted.length > 0) {
      parts.push(`${parsed.conflicted.length} conflicted`);
    }

    return parts.length > 0 ? parts.join(', ') : 'no changes';
  }
}

// Default export for convenience
export default GitStatusParser;
