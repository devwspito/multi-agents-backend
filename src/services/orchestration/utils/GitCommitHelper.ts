/**
 * Git Commit Helper - Automatic recovery when Developer forgets to commit/push
 *
 * USER REQUEST: "Tienes que forzar que los developers hagan commit si o si, y push no puede pasar eso"
 *
 * This helper detects when a Developer completed their work but forgot to commit/push,
 * and automatically executes the commit/push workflow for them.
 *
 * @see GIT_DEFENSE_SYSTEM.md for overall git safety strategy
 */

import { safeGitExecSync } from '../../../utils/safeGitExecution';

export interface CommitRecoveryResult {
  success: boolean;
  commitSHA?: string;
  pushed?: boolean;
  error?: string;
  action: 'no_changes' | 'already_committed' | 'auto_committed' | 'failed';
  message: string;
}

/**
 * Auto-commit and push uncommitted changes when Developer forgets
 *
 * This is a SAFETY NET - we prefer Developers do it themselves, but if they forget,
 * we don't want to lose their work.
 *
 * @param repoPath - Path to the repository
 * @param storyTitle - Story title for commit message
 * @param branchName - Current branch name
 * @returns Result of commit/push operation
 *
 * @example
 * ```typescript
 * const result = await autoCommitDeveloperWork(
 *   '/path/to/repo',
 *   'Implement user authentication',
 *   'story/auth-123'
 * );
 *
 * if (result.success) {
 *   console.log(`✅ Auto-committed: ${result.commitSHA}`);
 * }
 * ```
 */
export async function autoCommitDeveloperWork(
  repoPath: string,
  storyTitle: string,
  branchName: string
): Promise<CommitRecoveryResult> {
  try {
    // Step 1: Check if there are uncommitted changes
    const statusOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, {
      encoding: 'utf8',
    });

    if (!statusOutput || statusOutput.trim().length === 0) {
      // No uncommitted changes - check if last commit exists and is pushed
      try {
        const localSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, {
          encoding: 'utf8',
        }).trim();

        // Check if commit exists on remote
        const lsRemote = safeGitExecSync(`cd "${repoPath}" && git ls-remote origin ${branchName}`, {
          encoding: 'utf8',
          timeout: 15000,
        });

        if (lsRemote.includes(localSHA)) {
          return {
            success: true,
            commitSHA: localSHA,
            pushed: true,
            action: 'already_committed',
            message: 'Work already committed and pushed - no action needed',
          };
        } else {
          // Commit exists locally but not pushed - push it
          safeGitExecSync(`cd "${repoPath}" && git push origin HEAD`, {
            encoding: 'utf8',
            timeout: 60000,
          });

          return {
            success: true,
            commitSHA: localSHA,
            pushed: true,
            action: 'already_committed',
            message: 'Commit exists locally - pushed to remote',
          };
        }
      } catch (error: any) {
        return {
          success: false,
          action: 'no_changes',
          error: error.message,
          message: 'No changes to commit and unable to verify existing commit',
        };
      }
    }

    console.log(`\n🔧 [AUTO-COMMIT] Developer forgot to commit - recovering work automatically...`);
    console.log(`   📂 Repository: ${repoPath}`);
    console.log(`   🌿 Branch: ${branchName}`);
    console.log(`   📝 Uncommitted files:\n${statusOutput}`);

    // Step 2: Stage all changes
    try {
      safeGitExecSync(`cd "${repoPath}" && git add .`, {
        encoding: 'utf8',
      });
      console.log(`   ✅ Staged all changes`);
    } catch (addError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to stage changes: ${addError.message}`,
        message: 'Could not stage changes for commit',
      };
    }

    // Step 3: Create commit with descriptive message
    const commitMessage = `feat: ${storyTitle}

🔧 AUTO-COMMIT: Developer completed work but forgot to commit
Automatically committed by GitCommitHelper to preserve work.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>`;

    try {
      // Use heredoc for proper multi-line commit message formatting
      const commitCommand = `cd "${repoPath}" && git commit -m "$(cat <<'EOF'
${commitMessage}
EOF
)"`;

      safeGitExecSync(commitCommand, {
        encoding: 'utf8',
      });

      console.log(`   ✅ Created commit`);
    } catch (commitError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to commit: ${commitError.message}`,
        message: 'Could not create commit',
      };
    }

    // Step 4: Get commit SHA
    let commitSHA: string;
    try {
      commitSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, {
        encoding: 'utf8',
      }).trim();

      console.log(`   📍 Commit SHA: ${commitSHA}`);
    } catch (shaError: any) {
      return {
        success: false,
        action: 'failed',
        error: `Failed to get commit SHA: ${shaError.message}`,
        message: 'Commit created but unable to retrieve SHA',
      };
    }

    // Step 5: Push to remote
    try {
      safeGitExecSync(`cd "${repoPath}" && git push origin HEAD`, {
        encoding: 'utf8',
        timeout: 60000, // 60s timeout for push
      });

      console.log(`   ✅ Pushed to remote`);
    } catch (pushError: any) {
      return {
        success: false,
        commitSHA,
        pushed: false,
        action: 'failed',
        error: `Failed to push: ${pushError.message}`,
        message: 'Commit created locally but push failed - commit is preserved',
      };
    }

    console.log(`\n✅ [AUTO-COMMIT] Successfully recovered Developer's work!`);
    console.log(`   📍 Commit SHA: ${commitSHA}`);
    console.log(`   🚀 Pushed to: ${branchName}`);

    return {
      success: true,
      commitSHA,
      pushed: true,
      action: 'auto_committed',
      message: `Auto-committed and pushed Developer's work to preserve changes`,
    };
  } catch (error: any) {
    return {
      success: false,
      action: 'failed',
      error: error.message,
      message: 'Unexpected error during auto-commit recovery',
    };
  }
}

/**
 * Detect if Developer output looks like work was done but not committed
 *
 * Heuristics:
 * - Has code changes (Edit/Write tool used)
 * - Missing FINISHED_SUCCESSFULLY marker
 * - Missing Commit SHA marker
 * - No git commit/push commands in output
 *
 * @param developerOutput - Raw output from Developer agent
 * @returns true if work appears done but not committed
 */
export function detectUncommittedWork(developerOutput: string): boolean {
  if (!developerOutput) return false;

  const output = developerOutput.toLowerCase();

  // Positive signals: work was done
  const hasCodeChanges =
    output.includes('edit(') ||
    output.includes('write(') ||
    output.includes('modified') ||
    output.includes('created file');

  // Negative signals: work was NOT committed
  const hasFinishedMarker = output.includes('✅ finished_successfully') || output.includes('✅ developer_finished_successfully');
  const hasCommitSHA = output.includes('📍 commit sha:') || /[a-f0-9]{40}/.test(output);
  const hasGitCommands = output.includes('git commit') || output.includes('git push');

  // Work done but not committed
  return hasCodeChanges && (!hasFinishedMarker || !hasCommitSHA || !hasGitCommands);
}
