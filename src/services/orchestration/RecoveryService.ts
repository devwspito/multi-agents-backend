/**
 * Recovery Service
 *
 * Handles failure recovery logic for the story pipeline.
 * Extracted from StoryPipelineService for maintainability.
 */

import { NotificationService } from '../NotificationService';
import { unifiedMemoryService } from '../UnifiedMemoryService';
import {
  classifyFailure,
  logFailureAnalysis,
  isTerminalFailure,
  getTerminalFailureReason,
  type FailureContext,
  type FailureAnalysis,
} from './utils/FailureClassifier';
import {
  detectWorkInWorkspace,
  comprehensiveWorkRecovery,
  autoCommitDeveloperWork,
} from './utils/GitCommitHelper';
import { gitVerificationService, GitVerificationResult } from './GitVerificationService';
import { StoryPipelineContext, JudgeStageResult, MergeStageResult } from './developers/types';

export interface RecoveryContext {
  taskId: string;
  story: any;
  epic: any;
  workspacePath: string | null;
  storyBranch: string | null;
  error: Error;
}

export interface RecoveryResult {
  recovered: boolean;
  developerCost: number;
  judgeCost: number;
  conflictResolutionCost: number;
  developerTokens: { input: number; output: number };
  judgeTokens: { input: number; output: number };
  conflictResolutionUsage: { input_tokens: number; output_tokens: number };
}

const ZERO_RESULT: RecoveryResult = {
  recovered: false,
  developerCost: 0,
  judgeCost: 0,
  conflictResolutionCost: 0,
  developerTokens: { input: 0, output: 0 },
  judgeTokens: { input: 0, output: 0 },
  conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
};

export class RecoveryService {
  constructor(
    private executeJudgeStageFn: (ctx: StoryPipelineContext, commitSHA: string, branch: string) => Promise<JudgeStageResult>,
    private executeMergeStageFn: (ctx: StoryPipelineContext, commitSHA: string) => Promise<MergeStageResult>
  ) {}

  /**
   * Attempt to recover from a pipeline failure.
   * Analyzes the failure, detects any salvageable work, and attempts recovery.
   */
  async attemptRecovery(
    recoveryCtx: RecoveryContext,
    pipelineCtx: StoryPipelineContext
  ): Promise<RecoveryResult> {
    const { taskId, story, epic, workspacePath, storyBranch, error } = recoveryCtx;

    console.error(`[PIPELINE] Story pipeline failed for ${story.id}: ${error.message}`);

    const repoPath = workspacePath && epic.targetRepository
      ? `${workspacePath}/${epic.targetRepository}`
      : null;

    // Step 1: Detect work in workspace (files, not just git history)
    const workspaceDetection = repoPath
      ? detectWorkInWorkspace(repoPath, undefined)
      : undefined;

    // Step 2: Check for commits on branch
    const gitVerification = await this.verifyBranchCommits(
      storyBranch,
      workspacePath,
      epic.targetRepository
    );

    // Step 3: Classify the failure
    const failureAnalysis = this.classifyAndLogFailure(
      taskId,
      story,
      error,
      workspaceDetection,
      gitVerification?.hasCommits || false
    );

    // Step 4: Check if we can recover
    if (!storyBranch || !workspacePath || !epic.targetRepository) {
      console.log(`   [RECOVERY] Cannot verify git work - missing branch (${storyBranch}) or workspace`);
      this.logTerminalStatus(story.id, failureAnalysis);
      return ZERO_RESULT;
    }

    // Step 5: Execute recovery strategy
    try {
      const result = await this.executeRecoveryStrategy(
        failureAnalysis,
        gitVerification,
        repoPath!,
        storyBranch,
        story,
        pipelineCtx,
        error
      );

      if (result) {
        return result;
      }
    } catch (recoveryError: any) {
      console.error(`   [RECOVERY] Recovery check failed: ${recoveryError.message}`);
    }

    this.logTerminalStatus(story.id, failureAnalysis);
    return ZERO_RESULT;
  }

  /**
   * Verify if there are commits on the story branch.
   */
  private async verifyBranchCommits(
    storyBranch: string | null,
    workspacePath: string | null,
    targetRepository: string | null
  ): Promise<GitVerificationResult | null> {
    if (!storyBranch || !workspacePath || !targetRepository) {
      return null;
    }

    try {
      return await gitVerificationService.verifyDeveloperWork(
        workspacePath,
        targetRepository,
        storyBranch
      );
    } catch {
      return null;
    }
  }

  /**
   * Classify the failure and emit analysis to frontend.
   */
  private classifyAndLogFailure(
    taskId: string,
    story: any,
    error: Error,
    workspaceDetection: any,
    hasCommitsOnBranch: boolean
  ): FailureAnalysis {
    const failureContext: FailureContext = {
      error,
      retriesAttempted: 0,
      maxRetries: 3,
      developerOutput: undefined,
      workspaceDetection,
      hasCommitsOnBranch,
      phase: 'developer',
    };

    const failureAnalysis = classifyFailure(failureContext);
    logFailureAnalysis(story.title, story.id, failureAnalysis);

    // Emit failure analysis to frontend dashboard
    NotificationService.emitFailureAnalysis(taskId, {
      storyId: story.id,
      storyTitle: story.title,
      category: failureAnalysis.category,
      strategy: failureAnalysis.strategy,
      isTerminal: failureAnalysis.isTerminal,
      shouldRetry: failureAnalysis.shouldRetry,
      shouldCallJudge: failureAnalysis.shouldCallJudge,
      evidence: failureAnalysis.evidence,
      recommendations: failureAnalysis.recommendations,
      maxAdditionalRetries: failureAnalysis.maxAdditionalRetries,
      retryDelay: failureAnalysis.retryDelay,
      message: error.message,
    });

    return failureAnalysis;
  }

  /**
   * Execute the appropriate recovery strategy based on failure analysis.
   */
  private async executeRecoveryStrategy(
    failureAnalysis: FailureAnalysis,
    gitVerification: GitVerificationResult | null,
    repoPath: string,
    storyBranch: string,
    story: any,
    pipelineCtx: StoryPipelineContext,
    originalError: Error
  ): Promise<RecoveryResult | null> {
    // STRATEGY: SALVAGE_AND_JUDGE - Try to recover work and send to Judge
    if (failureAnalysis.shouldCallJudge) {
      console.log(`\n[RECOVERY] Strategy: ${failureAnalysis.strategy}`);

      const recoveryResult = await comprehensiveWorkRecovery(
        repoPath,
        story.title,
        storyBranch,
        undefined
      );

      const commitSHA = recoveryResult.commitSHA || gitVerification?.commitSHA;

      if (commitSHA) {
        console.log(`\n[RECOVERY] Work found! Commit: ${commitSHA.substring(0, 8)}`);
        console.log(`   Detection: ${recoveryResult.workspaceDetection.detectionMethod}`);
        console.log(`   Files changed: ${recoveryResult.workspaceDetection.totalChanges}`);

        if (!gitVerification?.hasCommits && recoveryResult.commitSHA) {
          gitVerification = {
            hasCommits: true,
            commitCount: 1,
            commitSHA: recoveryResult.commitSHA,
            commitMessage: `Auto-recovered: ${story.title}`,
          };
        }
      } else {
        console.log(`\n[RECOVERY] No work to salvage despite shouldCallJudge=true`);
      }
    } else if (failureAnalysis.shouldRetry) {
      console.log(`\n[RECOVERY] Transient error detected - should retry`);
      console.log(`   Category: ${failureAnalysis.category}`);
      console.log(`   Recommended delay: ${failureAnalysis.retryDelay}ms`);
    }

    // If we have commits, proceed to Judge
    if (gitVerification?.hasCommits && gitVerification.commitSHA) {
      return await this.executeRecoveryJudge(
        gitVerification,
        storyBranch,
        story,
        pipelineCtx,
        originalError,
        'git_verification'
      );
    }

    // AGGRESSIVE RECOVERY: No commits, but maybe files exist
    console.log(`   No commits found - attempting aggressive file recovery...`);
    const autoCommitResult = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

    if (autoCommitResult.success && autoCommitResult.commitSHA) {
      console.log(`\n[AGGRESSIVE RECOVERY] Found and committed uncommitted work!`);
      console.log(`   Commit: ${autoCommitResult.commitSHA.substring(0, 8)}`);
      console.log(`   Action: ${autoCommitResult.action}`);

      const aggressiveVerification: GitVerificationResult = {
        hasCommits: true,
        commitCount: 1,
        commitSHA: autoCommitResult.commitSHA,
        commitMessage: `Auto-recovered uncommitted: ${story.title}`,
      };

      return await this.executeRecoveryJudge(
        aggressiveVerification,
        storyBranch,
        story,
        pipelineCtx,
        originalError,
        'auto_commit_uncommitted_work'
      );
    }

    console.log(`   No uncommitted files to recover: ${autoCommitResult.message}`);
    return null;
  }

  /**
   * Execute Judge and Merge stages for recovered work.
   */
  private async executeRecoveryJudge(
    gitVerification: GitVerificationResult,
    storyBranch: string,
    story: any,
    pipelineCtx: StoryPipelineContext,
    originalError: Error,
    recoveryMethod: string
  ): Promise<RecoveryResult | null> {
    const { task, taskId, normalizedEpicId, normalizedStoryId } = pipelineCtx;

    console.log(`\n[RECOVERY] FOUND DEVELOPER WORK!`);
    console.log(`   Commits: ${gitVerification.commitCount}`);
    console.log(`   Latest: ${gitVerification.commitSHA!.substring(0, 8)}`);
    console.log(`   Proceeding to JUDGE`);

    const judgeResult = await this.executeJudgeStageFn(
      pipelineCtx,
      gitVerification.commitSHA!,
      storyBranch
    );

    if (judgeResult.success && judgeResult.approved) {
      console.log(`\n[RECOVERY-JUDGE] APPROVED! Proceeding to merge...`);

      const mergeResult = await this.executeMergeStageFn(
        pipelineCtx,
        gitVerification.commitSHA!
      );

      if (mergeResult.success) {
        console.log(`\n[RECOVERY] SUCCESS! Story recovered from failure!`);

        // Emit story recovered to frontend dashboard
        NotificationService.emitStoryRecovered(taskId, {
          storyId: story.id,
          storyTitle: story.title,
          recoveryMethod,
          commitSHA: gitVerification.commitSHA || undefined,
        });

        // Emit StoryCompleted event
        const { eventStore } = await import('../EventStore');
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'StoryCompleted',
          agentName: 'developer',
          payload: {
            storyId: story.id,
            epicId: normalizedEpicId,
            title: story.title,
            recoveredFromFailure: true,
            originalError: originalError.message,
          },
        });

        await unifiedMemoryService.markStoryCompleted(
          taskId,
          normalizedEpicId,
          normalizedStoryId,
          'approved',
          storyBranch,
          undefined
        );

        return {
          recovered: true,
          developerCost: 0,
          judgeCost: judgeResult.judgeCost,
          conflictResolutionCost: mergeResult.conflictResolutionCost,
          developerTokens: { input: 0, output: 0 },
          judgeTokens: judgeResult.judgeTokens,
          conflictResolutionUsage: mergeResult.conflictResolutionUsage,
        };
      }

      console.log(`\n[RECOVERY-MERGE] Merge failed: ${mergeResult.error}`);
    } else if (judgeResult.success && !judgeResult.approved) {
      console.log(`\n[RECOVERY-JUDGE] REJECTED: ${judgeResult.feedback}`);

      const { eventStore } = await import('../EventStore');
      await eventStore.safeAppend({
        taskId: task.id as any,
        eventType: 'StoryFailed',
        agentName: 'developer',
        payload: {
          storyId: story.id,
          epicId: normalizedEpicId,
          title: story.title,
          recoveredButRejected: true,
          feedback: judgeResult.feedback,
        },
      });
    } else {
      console.log(`\n[RECOVERY-JUDGE] Judge stage failed: ${judgeResult.error}`);
    }

    return null;
  }

  /**
   * Log terminal failure status.
   */
  private logTerminalStatus(storyId: string, failureAnalysis: FailureAnalysis): void {
    if (isTerminalFailure(failureAnalysis)) {
      const reason = getTerminalFailureReason(failureAnalysis);
      console.log(`\n[TERMINAL FAILURE] Story ${storyId} failed legitimately`);
      console.log(`   Reason: ${reason}`);
      console.log(`   Category: ${failureAnalysis.category}`);
    } else {
      console.log(`\n[UNEXPECTED FAILURE] Story ${storyId} failed but recovery was possible`);
      console.log(`   Category: ${failureAnalysis.category}`);
      console.log(`   Strategy: ${failureAnalysis.strategy}`);
      console.log(`   Should have retried: ${failureAnalysis.shouldRetry}`);
      console.log(`   Max retries remaining: ${failureAnalysis.maxAdditionalRetries || 0}`);
    }
  }
}
