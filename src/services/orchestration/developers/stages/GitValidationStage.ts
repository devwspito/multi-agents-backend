/**
 * GitValidationStage - Validates git commits and pushes to remote
 *
 * Responsibilities:
 * - Verify commits exist on story branch
 * - Fetch from remote with retries
 * - Auto-commit if developer forgot
 * - Push to remote and verify
 * - Save checkpoint markers
 */

import { safeGitExecSync } from '../../../../utils/safeGitExecution';
import { GIT_TIMEOUTS } from '../../constants/Timeouts';
import { unifiedMemoryService } from '../../../UnifiedMemoryService';
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from '../../utils/MarkerValidator';
import { StoryPipelineContext, GitValidationStageResult } from '../types';
import { DeveloperStageExecutor } from './DeveloperStage';

export class GitValidationStageExecutor {
  constructor(private developerStageExecutor: DeveloperStageExecutor) {}

  /**
   * Execute git validation stage - verify commits and push to remote
   */
  async execute(
    pipelineCtx: StoryPipelineContext,
    developerOutput: string
  ): Promise<GitValidationStageResult> {
    const {
      task, story, epic,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId,
    } = pipelineCtx;

    console.log(`\n🔍 [GIT VALIDATION STAGE] Starting for story: ${story.title}`);

    try {
      // Wait for git push to propagate
      console.log(`⏳ Waiting 3 seconds for git push to propagate...`);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Get updated story with branch info
      const { eventStore } = await import('../../../EventStore');
      const updatedState = await eventStore.getCurrentState(task._id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      if (!updatedStory || !updatedStory.branchName) {
        console.error(`❌ Story ${story.id} has no branch after developer`);
        return {
          success: false,
          commitSHA: null,
          storyBranch: null,
          gitValidationPassed: false,
          error: 'Story has no branch after developer execution',
        };
      }

      // Check for explicit failure marker
      const explicitlyFailed = hasMarker(developerOutput, COMMON_MARKERS.FAILED);
      if (explicitlyFailed) {
        console.error(`❌ Developer explicitly reported FAILURE`);
        return {
          success: false,
          commitSHA: null,
          storyBranch: updatedStory.branchName,
          gitValidationPassed: false,
          error: 'Developer reported explicit failure',
        };
      }

      const storyBranch = story.branchName || updatedStory?.branchName;
      let commitSHA: string | null = null;
      let gitValidationPassed = false;

      console.log(`   Story: ${story.title}`);
      console.log(`   Branch: ${storyBranch || 'unknown'}`);

      if (storyBranch && effectiveWorkspacePath && epic.targetRepository) {
        const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;

        // Fetch with retries
        await this.fetchWithRetries(repoPath);

        // Verify commits exist
        const gitVerification = await this.developerStageExecutor.verifyDeveloperWorkFromGit(
          effectiveWorkspacePath,
          epic.targetRepository,
          storyBranch,
          story.id
        );

        if (gitVerification?.hasCommits && gitVerification.commitSHA) {
          console.log(`✅ Developer made ${gitVerification.commitCount} commits!`);
          console.log(`   Latest commit: ${gitVerification.commitSHA.substring(0, 8)}`);
          commitSHA = gitVerification.commitSHA;
          gitValidationPassed = true;

          // Ensure commit is on remote
          await this.ensureCommitOnRemote(repoPath, storyBranch, commitSHA);

          // Checkpoint: Mark as pushed
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'pushed', {
            commitHash: commitSHA,
          });
          console.log(`📍 [CHECKPOINT] Story progress: pushed (commit: ${commitSHA.substring(0, 8)})`);

          // Verify push on GitHub
          try {
            const { eventStore: es } = await import('../../../EventStore');
            await es.verifyStoryPush({
              taskId: task._id as any,
              storyId: story.id,
              branchName: storyBranch,
              repoPath,
            });
          } catch (verifyErr: any) {
            console.warn(`⚠️ [PushVerify] Could not verify push: ${verifyErr.message}`);
          }

        } else {
          // Try auto-commit
          console.log(`⚠️ No commits found, trying auto-commit...`);
          const autoCommitResult = await this.tryAutoCommit(repoPath, story.title, storyBranch);

          if (autoCommitResult.success && autoCommitResult.commitSHA) {
            console.log(`✅ Auto-commit recovered work: ${autoCommitResult.commitSHA.substring(0, 8)}`);
            commitSHA = autoCommitResult.commitSHA;
            gitValidationPassed = true;
          }
        }
      }

      // Fallback to marker validation
      if (!gitValidationPassed) {
        const finishedMarker = hasMarker(developerOutput, COMMON_MARKERS.DEVELOPER_FINISHED) ||
                               hasMarker(developerOutput, COMMON_MARKERS.FINISHED);
        if (!finishedMarker) {
          console.error(`❌ No commits and no FINISHED marker`);
          return {
            success: false,
            commitSHA: null,
            storyBranch,
            gitValidationPassed: false,
            error: 'No commits found and no finish marker',
          };
        }
        commitSHA = extractMarkerValue(developerOutput, COMMON_MARKERS.COMMIT_SHA);
        console.log(`✅ Developer finished (marker present)`);
      }

      if (!commitSHA) {
        console.error(`❌ Could not determine commit SHA`);
        return {
          success: false,
          commitSHA: null,
          storyBranch,
          gitValidationPassed: false,
          error: 'Could not determine commit SHA',
        };
      }

      console.log(`✅ [GIT VALIDATION STAGE] Complete: commit ${commitSHA}`);

      return {
        success: true,
        commitSHA,
        storyBranch,
        gitValidationPassed,
      };

    } catch (error: any) {
      console.error(`❌ [GIT VALIDATION STAGE] Failed: ${error.message}`);
      return {
        success: false,
        commitSHA: null,
        storyBranch: null,
        gitValidationPassed: false,
        error: error.message,
      };
    }
  }

  /**
   * Fetch from remote with exponential backoff
   */
  private async fetchWithRetries(repoPath: string, maxRetries = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`   📡 Fetching from remote (attempt ${attempt}/${maxRetries})...`);
        safeGitExecSync(`git fetch origin --prune`, {
          cwd: repoPath,
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.FETCH
        });
        console.log(`   ✅ Fetch succeeded`);
        return;
      } catch (fetchErr: any) {
        const waitMs = 2000 * Math.pow(2, attempt - 1);
        if (attempt < maxRetries) {
          console.warn(`   ⚠️ Fetch failed: ${fetchErr.message}, retrying in ${waitMs/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
        } else {
          console.error(`   ❌ Fetch FAILED after ${maxRetries} attempts`);
        }
      }
    }
  }

  /**
   * Ensure commit is pushed to remote
   */
  private async ensureCommitOnRemote(repoPath: string, storyBranch: string, commitSHA: string): Promise<void> {
    console.log(`\n📤 Verifying commit is on remote...`);
    try {
      const branchOnRemote = safeGitExecSync(
        `git ls-remote origin refs/heads/${storyBranch}`,
        { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.STATUS }
      );

      if (!branchOnRemote || branchOnRemote.trim() === '') {
        console.log(`   ⚠️ Branch not on remote - pushing...`);
        safeGitExecSync(`git push -u origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
        console.log(`   ✅ Branch pushed`);
        this.syncLocalWithRemote(repoPath, storyBranch);
      } else {
        const remoteCommit = branchOnRemote.split('\t')[0];
        if (remoteCommit !== commitSHA) {
          console.log(`   ⚠️ Remote has different commit - pushing latest...`);
          safeGitExecSync(`git push origin ${storyBranch}`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
          this.syncLocalWithRemote(repoPath, storyBranch);
        }
        console.log(`   ✅ Commit confirmed on remote`);
      }
    } catch (pushErr: any) {
      console.warn(`   ⚠️ Push verification failed: ${pushErr.message}`);
      try {
        safeGitExecSync(`git push -u origin ${storyBranch} --force-with-lease`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.PUSH });
        console.log(`   ✅ Force push succeeded`);
        this.syncLocalWithRemote(repoPath, storyBranch);
      } catch (forcePushErr: any) {
        console.error(`   ❌ Force push failed: ${forcePushErr.message}`);
      }
    }
  }

  /**
   * Sync local branch with remote after push
   */
  private syncLocalWithRemote(repoPath: string, branch: string): void {
    try {
      safeGitExecSync(`git pull origin ${branch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
    } catch (_pullErr) {
      // Already up to date
    }
  }

  /**
   * Try auto-commit if developer forgot
   */
  private async tryAutoCommit(
    repoPath: string,
    storyTitle: string,
    storyBranch: string
  ): Promise<{ success: boolean; commitSHA?: string }> {
    try {
      const { autoCommitDeveloperWork } = await import('../../utils/GitCommitHelper');
      return await autoCommitDeveloperWork(repoPath, storyTitle, storyBranch);
    } catch (error: any) {
      console.warn(`⚠️ Auto-commit failed: ${error.message}`);
      return { success: false };
    }
  }
}
