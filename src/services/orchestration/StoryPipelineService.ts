/**
 * Story Pipeline Service
 *
 * Handles the execution of individual story pipelines:
 * Developer implements → Judge reviews → Merge to epic
 *
 * Extracted from DevelopersPhase for maintainability.
 */

import { OrchestrationContext, updateTaskFireAndForget } from './Phase';
import { NotificationService } from '../NotificationService';
import { safeGitExecSync, smartGitFetch } from '../../utils/safeGitExecution';
import { sandboxService } from '../SandboxService.js';
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';
import { ProjectRadiography } from '../ProjectRadiographyService';
import { sessionCheckpointService } from '../SessionCheckpointService';
import { unifiedMemoryService } from '../UnifiedMemoryService';
import { getEpicId, getStoryId } from './utils/IdNormalizer';
import { GIT_TIMEOUTS } from './constants/Timeouts';
import {
  StoryPipelineContext,
  JudgeStageResult,
  MergeStageResult,
} from './developers/types';
import { MergeService } from './MergeService';
import { gitVerificationService } from './GitVerificationService';
import { RecoveryService } from './RecoveryService';

export interface StoryPipelineResult {
  developerCost: number;
  judgeCost: number;
  conflictResolutionCost: number;
  developerTokens: { input: number; output: number };
  judgeTokens: { input: number; output: number };
  conflictResolutionUsage: { input_tokens: number; output_tokens: number };
}

export class StoryPipelineService {
  private mergeService: MergeService;
  private recoveryService: RecoveryService;

  constructor(
    private executeDeveloperFn: Function,
    private executeAgentFn?: Function
  ) {
    this.mergeService = new MergeService(executeAgentFn);
    this.recoveryService = new RecoveryService(
      this.executeJudgeStage.bind(this),
      this.executeMergeStage.bind(this)
    );
  }

  async execute(
    task: any,
    story: any,
    developer: any,
    epic: any,
    repositories: any[],
    workspacePath: string | null,
    workspaceStructure: string,
    attachments: any[],
    state: any,
    context: OrchestrationContext
  ): Promise<{
    developerCost: number;
    judgeCost: number;
    conflictResolutionCost: number;
    developerTokens: { input: number; output: number };
    judgeTokens: { input: number; output: number };
    conflictResolutionUsage: { input_tokens: number; output_tokens: number };
  }> {
    const taskId = (task.id as any).toString();

    // 🐳 SANDBOX: Get sandbox ID for Docker execution
    const pipelineSandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const pipelineSandboxId = pipelineSandboxMap?.get(epic.targetRepository);

    // All developers share the same workspace (sequential execution)
    const effectiveWorkspacePath = workspacePath;

    if (!effectiveWorkspacePath) {
      throw new Error(
        `HUMAN_REQUIRED: Story pipeline cannot execute without workspace. ` +
        `Story "${story.title}" (${story.id}) aborted.`
      );
    }

    // 🔥 Emit workspace ready notification for LivePreview
    if (epic.targetRepository) {
      const fullRepoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      NotificationService.emitStoryWorkspaceReady(
        taskId,
        fullRepoPath,
        epic.targetRepository,
        epic.name,
        story.title
      );
    }

    // Epic MUST have targetRepository
    if (!epic.targetRepository) {
      console.error(`[PIPELINE] Epic ${epic.id} has no targetRepository`);
      updateTaskFireAndForget(task.id, {
        $set: {
          status: 'failed',
          'orchestration.developers': {
            status: 'failed',
            error: `Epic ${epic.id} has no targetRepository - cannot determine which repo to work in`,
            humanRequired: true,
          },
        },
      }, 'epic no targetRepository');

      throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository`);
    }

    // Story MUST have targetRepository (inherited from epic)
    if (!story.targetRepository) {
      console.error(`[PIPELINE] Story ${story.id} has no targetRepository`);
      updateTaskFireAndForget(task.id, {
        $set: {
          status: 'failed',
          'orchestration.developers': {
            status: 'failed',
            error: `Story ${story.id} has no targetRepository - data integrity issue`,
            humanRequired: true,
          },
        },
      }, 'story no targetRepository');

      throw new Error(`HUMAN_REQUIRED: Story ${story.id} has no targetRepository`);
    }

    console.log(`[PIPELINE] ${story.title} → ${story.targetRepository}`);

    // 🔥 RECOVERY-READY: Declare key variables OUTSIDE try block so catch can access them
    const epicBranchName = context.getData<string>('epicBranch');
    const normalizedEpicId = getEpicId(epic);
    const normalizedStoryId = getStoryId(story);
    const devAuth = context.getData<any>('devAuth');
    const architectureBrief = context.getData<any>('architectureBrief');
    const environmentCommands = context.getData<any>('environmentCommands');
    const projectRadiographies = context.getData<Map<string, ProjectRadiography>>('projectRadiographies');

    // 🐳 SANDBOX: Get sandbox map from context (created by PlanningPhase)
    const sandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const sandboxId = sandboxMap?.get(epic.targetRepository);
    if (sandboxId) {
      console.log(`🐳 [DevelopersPhase] Using sandbox ${sandboxId} for repo ${epic.targetRepository}`);
    } else {
      console.log(`⚠️  [DevelopersPhase] No sandbox found for repo ${epic.targetRepository} - using host`);
    }

    try {
      // STEP 1: Developer implements story
      console.log(`\n👨‍💻 [STEP 1/3] Developer ${developer.instanceId} implementing story...`);

      if (!epicBranchName) {
        throw new Error(`Epic branch name missing from context for story "${story.title}"`);
      }

      // Validate workspace path type
      if (typeof effectiveWorkspacePath !== 'string' && effectiveWorkspacePath !== null) {
        throw new Error(`effectiveWorkspacePath must be string, got ${typeof effectiveWorkspacePath}`);
      }

      // 🔔 Emit to frontend so user sees developer starting work
      const { NotificationService } = await import('../NotificationService');
      NotificationService.emitConsoleLog(
        (task.id as any).toString(),
        'info',
        `👨‍💻 Developer ${developer.instanceId} starting: "${story.title}"`
      );

      // 🔥 MID-STORY RECOVERY: Check if we can skip to a later stage
      // normalizedEpicId and normalizedStoryId are declared outside try block for recovery access
      const existingProgress = await unifiedMemoryService.getStoryProgress(taskId, normalizedEpicId, normalizedStoryId);

      if (existingProgress && existingProgress.stage !== 'not_started') {
        console.log(`[RECOVERY] Story "${story.title}" at stage: ${existingProgress.stage}`);

        // If already merged/completed, skip
        if (existingProgress.stage === 'merged_to_epic' || existingProgress.stage === 'completed') {
          console.log(`[RECOVERY] Story already completed - skipping`);
          // Ensure it's marked as fully completed
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
            commitHash: existingProgress.commitHash,
          });

          // Return zero costs since we didn't execute anything
          return {
            developerCost: 0,
            judgeCost: 0,
            conflictResolutionCost: 0,
            developerTokens: { input: 0, output: 0 },
            judgeTokens: { input: 0, output: 0 },
            conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
          };
        }

        // If code pushed, skip to Judge
        if (existingProgress.stage === 'pushed' || existingProgress.stage === 'judge_evaluating') {
          console.log(`[RECOVERY] Story code pushed - direct to Judge`);
          const commitSHA = existingProgress.commitHash;
          const storyBranch = story.branchName;

          if (!commitSHA || !storyBranch) {
            console.error(`Cannot direct-to-judge: missing commitSHA or storyBranch`);
          } else {
            // Create pipeline context for stage methods
            const pipelineCtx: StoryPipelineContext = {
              task,
              story,
              developer,
              epic,
              repositories,
              effectiveWorkspacePath,
              workspaceStructure,
              attachments,
              state,
              context,
              taskId,
              normalizedEpicId,
              normalizedStoryId,
              epicBranchName,
              devAuth: context.getData<any>('devAuth'),
              architectureBrief: context.getData<any>('architectureBrief'),
              environmentCommands: context.getData<any>('environmentCommands'),
              projectRadiographies: context.getData<Map<string, ProjectRadiography>>('projectRadiographies'),
              sandboxId, // 🐳 Explicit sandbox ID for Docker execution
            };

            // 🔥 JUMP DIRECTLY TO JUDGE
            console.log(`\n⚖️ [DIRECT-TO-JUDGE] Executing Judge stage...`);
            const judgeResult = await this.executeJudgeStage(pipelineCtx, commitSHA, storyBranch);

            if (!judgeResult.success) {
              console.error(`❌ Judge stage failed: ${judgeResult.error}`);
              return {
                developerCost: 0,
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: 0,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
              };
            }

            if (judgeResult.approved) {
              // 🔥 MERGE STAGE
              console.log(`\n🔀 [DIRECT-TO-JUDGE] Judge approved - executing Merge stage...`);
              const mergeResult = await this.executeMergeStage(pipelineCtx, commitSHA);

              // Emit completion events
              const { eventStore } = await import('../EventStore');
              await eventStore.safeAppend({
                taskId: task.id as any,
                eventType: 'StoryCompleted',
                agentName: 'developer',
                payload: {
                  storyId: story.id,
                  epicId: (story as any).epicId,
                  title: story.title,
                  completedBy: (story as any).assignedTo,
                  directToJudge: true,
                },
              });

              // 🔥 FIX: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
              await unifiedMemoryService.markStoryCompleted(
                taskId,
                normalizedEpicId,
                normalizedStoryId,
                'approved',
                storyBranch,
                undefined
              );

              await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
                commitHash: commitSHA,
              });

              console.log(`✅ [DIRECT-TO-JUDGE] Story pipeline completed via direct-to-judge!`);

              return {
                developerCost: 0, // Skipped developer
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: mergeResult.conflictResolutionCost,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: mergeResult.conflictResolutionUsage,
              };
            } else {
              // Judge rejected - log feedback
              console.error(`❌ [DIRECT-TO-JUDGE] Judge REJECTED story`);
              console.error(`   Feedback: ${judgeResult.feedback}`);

              // 🔥 FIX: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
              await unifiedMemoryService.markStoryCompleted(
                taskId,
                normalizedEpicId,
                normalizedStoryId,
                'rejected',
                storyBranch,
                undefined
              );

              return {
                developerCost: 0,
                judgeCost: judgeResult.judgeCost,
                conflictResolutionCost: 0,
                developerTokens: { input: 0, output: 0 },
                judgeTokens: judgeResult.judgeTokens,
                conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
              };
            }
          }
        }
      }

      // 🔥 CHECKPOINT 1: Mark story as "code_generating"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_generating');

      // 🔥🔥🔥 STORY BRANCH: TechLead already created it, Developer just checks out 🔥🔥🔥
      const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      const storyBranchName = story.branchName || unifiedMemoryService.getStoryBranch(taskId, normalizedStoryId);

      if (!storyBranchName) {
        throw new Error(`HUMAN_REQUIRED: Story "${story.title}" has no branchName`);
      }

      console.log(`[Branch] Checking out ${storyBranchName} in ${repoPath}`);

      try {
        // 🔥 Developer just does: git fetch + git checkout (branch already exists)
        safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.FETCH });

        // Try to checkout the branch
        try {
          safeGitExecSync(`git checkout ${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
          console.log(`✅ [DevelopersPhase] Checked out story branch: ${storyBranchName}`);
        } catch {
          // Branch might not exist locally, try tracking remote
          try {
            safeGitExecSync(`git checkout -b ${storyBranchName} origin/${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [DevelopersPhase] Created local tracking branch: ${storyBranchName}`);
          } catch {
            // Branch doesn't exist on remote either - create from epic branch
            // This is for first developer to work on the story
            console.log(`   ℹ️ Branch not on remote yet, creating from epic branch...`);
            safeGitExecSync(`git checkout ${epicBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            safeGitExecSync(`git checkout -b ${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [DevelopersPhase] Created story branch from epic: ${storyBranchName}`);
          }
        }

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🌿 Developer ${developer.instanceId}: Working on branch ${storyBranchName}`
        );
      } catch (gitError: any) {
        console.error(`❌ [DevelopersPhase] Failed to checkout story branch: ${gitError.message}`);
        throw new Error(`Git checkout failed for ${storyBranchName}: ${gitError.message}`);
      }

      // 🔄 CHECKPOINT: Create rollback point before developer execution
      const { rollbackService } = await import('../RollbackService');
      const checkpoint = await rollbackService.createCheckpoint(
        repoPath,
        (task.id as any).toString(),
        `Before ${developer.instanceId}: ${story.title}`,
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: developer.instanceId,
          storyId: getStoryId(story), // 🔥 CENTRALIZED: Use IdNormalizer
          storyTitle: story.title,
          epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          epicName: epic.name,
        }
      );
      if (checkpoint) {
        console.log(`🔄 [CHECKPOINT] Created: ${checkpoint.id} (${checkpoint.commitHash.substring(0, 7)})`);
      }

      // 🔄 SESSION RESUME: Check for existing session checkpoint for this story
      const existingSessionCheckpoint = await sessionCheckpointService.loadCheckpoint(
        taskId,
        'developer',
        story.id // Use storyId as entityId for per-story resume
      );
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingSessionCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [Developer ${developer.instanceId}] RESUMING story "${story.title}" from previous session...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Developer ${developer.instanceId}: Resuming story "${story.title}" from checkpoint`
        );
      }

      const developerResult = await this.executeDeveloperFn(
        task,
        developer,
        repositories,
        effectiveWorkspacePath,  // 🔥 ISOLATED per story!
        workspaceStructure,
        attachments,
        [story],  // 🔥🔥🔥 CRITICAL: ONLY this story, NOT state.stories (1 Dev = 1 Story)
        state.epics,
        undefined, // judgeFeedback
        epicBranchName, // Epic branch name from TeamOrchestrationPhase
        undefined, // forceTopModel
        devAuth, // 🔐 Developer authentication for testing endpoints
        architectureBrief, // 🏗️ Architecture patterns from PlanningPhase
        environmentCommands, // 🔧 Environment commands from TechLead (dynamic verification)
        projectRadiographies, // 🔬 Language-agnostic project analysis from PlanningPhase
        resumeOptions, // 🔄 Session resume options
        sandboxId // 🐳 Explicit sandbox ID for Docker execution
      );

      // 🔄 Save session checkpoint after developer starts (for mid-execution recovery)
      if (developerResult?.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'developer',
          developerResult.sdkSessionId,
          getStoryId(story), // Use storyId as entityId - 🔥 CENTRALIZED: Use IdNormalizer
          developerResult.lastMessageUuid,
          {
            developerId: developer.instanceId,
            storyTitle: story.title,
            epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
          }
        );
      }

      // Track developer cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };
      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)} (${developerTokens.input + developerTokens.output} tokens)`);
        NotificationService.emitConsoleLog(
          (task.id as any).toString(),
          'info',
          `✅ Developer ${developer.instanceId} finished: "${story.title}" ($${developerCost.toFixed(4)})`
        );
      }

      // 🔥 CHECKPOINT 2: Mark story as "code_written" with SDK session for potential resume
      // 🔥 NEW: Save granular tracking for recovery (files modified, created, tools used, cost)
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_written', {
        sdkSessionId: developerResult?.sdkSessionId,
        filesModified: developerResult?.filesModified || [],
        filesCreated: developerResult?.filesCreated || [],
        toolsUsed: developerResult?.toolsUsed || [],
        cost_usd: developerResult?.cost || 0,
      });

      // 🔥 CRITICAL: Wait for git push to fully complete on remote
      // Developer agent may have finished but push still propagating
      console.log(`⏳ [PIPELINE] Waiting 3 seconds for git push to propagate to remote...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(`✅ [PIPELINE] Wait complete - proceeding to verification`);

      // Verify story has branch
      const updatedState = await (await import('../EventStore')).eventStore.getCurrentState(task.id as any);
      // 🔥 FIX: Use getStoryId() for consistent ID normalization
      const targetStoryId = getStoryId(story);
      const updatedStory = updatedState.stories.find((s: any) => {
        try { return getStoryId(s) === targetStoryId; } catch { return false; }
      });

      if (!updatedStory || !updatedStory.branchName) {
        console.error(`❌ [PIPELINE] Story ${targetStoryId} has no branch after developer - FAILED`);
        return {
          developerCost: 0,
          judgeCost: 0,
          conflictResolutionCost: 0,
          developerTokens: { input: 0, output: 0 },
          judgeTokens: { input: 0, output: 0 },
          conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
        };
      }

      // 🔥🔥🔥 DEFINITIVE FIX: GIT IS THE SOURCE OF TRUTH, NOT MARKERS 🔥🔥🔥
      // Developer output can be truncated (50k char limit) which cuts off markers
      // Instead: Check git FIRST - if commits exist, ACCEPT the work and FORCE to Judge
      const developerOutput = developerResult?.output || '';

      // Check for explicit failure marker (but DON'T return early - verify git first!)
      const explicitlyFailed = hasMarker(developerOutput, COMMON_MARKERS.FAILED);

      if (explicitlyFailed) {
        console.warn(`⚠️ [PIPELINE] Developer reported FAILURE marker - but will verify git first!`);
        console.warn(`   Story: ${story.title}`);
        // 🔥 FIX: Don't return early! Check git for commits and proceed to Judge if found
      }

      // GIT-FIRST VALIDATION: Git commits are the SOURCE OF TRUTH
      const storyBranch = story.branchName || updatedStory?.branchName;
      let commitSHA: string | null = null;
      let gitValidationPassed = false;

      if (storyBranch && effectiveWorkspacePath && epic.targetRepository) {
        const repoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;

        // Fetch from remote first
        await gitVerificationService.fetchWithRetry(repoPath);

        // Verify developer work
        const gitVerification = await gitVerificationService.verifyDeveloperWork(
          effectiveWorkspacePath,
          epic.targetRepository,
          storyBranch
        );

        if (gitVerification?.hasCommits && gitVerification.commitSHA) {
          console.log(`[GIT] ${gitVerification.commitCount} commits, latest: ${gitVerification.commitSHA.substring(0, 8)}`);
          commitSHA = gitVerification.commitSHA;
          gitValidationPassed = true;

          // Ensure branch is pushed
          await gitVerificationService.ensureBranchPushed(repoPath, storyBranch, commitSHA);

          // Save checkpoint
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'pushed', {
            commitHash: commitSHA,
          });

          // Verify push on GitHub
          try {
            const { eventStore } = await import('../EventStore');
            await eventStore.verifyStoryPush({
              taskId: task.id as any,
              storyId: story.id,
              branchName: storyBranch,
              repoPath,
            });
          } catch (_) { /* Non-blocking */ }
        } else {
          // No commits - try auto-commit recovery
          const { autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
          const autoCommitResult = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

          if (autoCommitResult.success && autoCommitResult.commitSHA) {
            console.log(`[AUTO-COMMIT] Recovered: ${autoCommitResult.commitSHA.substring(0, 8)}`);
            commitSHA = autoCommitResult.commitSHA;
            gitValidationPassed = true;
          }
        }
      } else {
        console.warn(`[GIT] Cannot verify - missing: ${!storyBranch ? 'branch' : ''} ${!effectiveWorkspacePath ? 'workspace' : ''} ${!epic.targetRepository ? 'repo' : ''}`);
      }

      // 🔥 FALLBACK: Only check markers if git validation failed
      // This handles edge cases where git check doesn't work
      const requiredMarkers = {
        typecheckPassed: hasMarker(developerOutput, COMMON_MARKERS.TYPECHECK_PASSED),
        testsPassed: hasMarker(developerOutput, COMMON_MARKERS.TESTS_PASSED),
        lintPassed: hasMarker(developerOutput, COMMON_MARKERS.LINT_PASSED),
        finishedSuccessfully: hasMarker(developerOutput, COMMON_MARKERS.DEVELOPER_FINISHED) ||
                               hasMarker(developerOutput, COMMON_MARKERS.FINISHED),
        failed: false, // Already checked above
      };

      // 🔥🔥🔥 SIMPLIFIED VALIDATION LOGIC 🔥🔥🔥
      // Git validation already happened above. If gitValidationPassed is true, we're good!
      // Only fail if git shows NO commits AND no success markers

      if (!gitValidationPassed) {
        // Git validation failed - check markers as fallback
        console.log(`[MARKERS] typecheck:${requiredMarkers.typecheckPassed} tests:${requiredMarkers.testsPassed} lint:${requiredMarkers.lintPassed} finished:${requiredMarkers.finishedSuccessfully}`);

        if (!requiredMarkers.finishedSuccessfully) {
          // Heuristic: check if output shows work was done despite no marker
          const { detectUncommittedWork, autoCommitDeveloperWork } = await import('./utils/GitCommitHelper');
          const outputShowsWork = detectUncommittedWork(developerOutput);

          if (outputShowsWork) {
            console.warn(`[RECOVERY] Output shows work done, attempting aggressive recovery...`);
            const aggressiveCommit = await autoCommitDeveloperWork(repoPath, story.title, storyBranch);

            if (aggressiveCommit.success && aggressiveCommit.commitSHA) {
              console.log(`[RECOVERY] Recovered: ${aggressiveCommit.commitSHA.substring(0, 8)}`);
              commitSHA = aggressiveCommit.commitSHA;
              gitValidationPassed = true;
            } else {
              // Use current HEAD as checkpoint
              try {
                const checkpointSHA = safeGitExecSync(`cd "${repoPath}" && git rev-parse HEAD`, { encoding: 'utf8' }).trim();
                if (checkpointSHA) {
                  commitSHA = checkpointSHA;
                  gitValidationPassed = true;
                }
              } catch (_) { /* proceed without */ }
            }
          } else {
            console.error(`[PIPELINE] Developer did NOT complete work for ${story.title}`);
            return {
              developerCost,
              judgeCost: 0,
              conflictResolutionCost: 0,
              developerTokens,
              judgeTokens: { input: 0, output: 0 },
              conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
            };
          }
        }

        // Marker validation passed - try to get commit SHA from output
        commitSHA = extractMarkerValue(developerOutput, COMMON_MARKERS.COMMIT_SHA);
      }

      if (!commitSHA) {
        console.error(`[PIPELINE] No commit SHA for ${story.title}`);
        return {
          developerCost,
          judgeCost: 0,
          conflictResolutionCost: 0,
          developerTokens,
          judgeTokens: { input: 0, output: 0 },
          conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
        };
      }

      console.log(`[PIPELINE] Developer done: ${commitSHA.substring(0, 8)} on ${storyBranch}`);

      // Automatic build verification
      const { BuildVerificationService } = await import('../BuildVerificationService');
      const verificationRepoPath = `${effectiveWorkspacePath}/${epic.targetRepository}`;
      const verificationReport = await BuildVerificationService.verifyBuild(verificationRepoPath, taskId);

      if (!verificationReport.overall) {
        console.error(`[BUILD] Failed: ${verificationReport.totalErrors} errors`);
        NotificationService.emitConsoleLog(taskId, 'error', `Build failed: ${verificationReport.totalErrors} errors`);
        context.setData('lastVerificationFailure', {
          storyId: story.id,
          errors: verificationReport.totalErrors,
          feedback: verificationReport.feedbackForAgent,
          timestamp: new Date(),
        });
      } else {
        NotificationService.emitConsoleLog(taskId, 'info', `Build passed for "${story.title}"`);
      }

      // Verify commit exists on remote and sync workspace before Judge
      if (effectiveWorkspacePath && repositories.length > 0 && epic.targetRepository) {
        const targetRepo = gitVerificationService.findTargetRepo(repositories, epic.targetRepository);
        if (!targetRepo) throw new Error(`Repository ${epic.targetRepository} not found`);

        const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;

        // Verify commit on remote
        if (!gitVerificationService.verifyCommitOnRemote(repoPath, commitSHA!)) {
          console.error(`[PRE-JUDGE] Commit ${commitSHA} not on remote`);
          return {
            developerCost,
            judgeCost: 0,
            conflictResolutionCost: 0,
            developerTokens,
            judgeTokens: { input: 0, output: 0 },
            conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
          };
        }

        // Sync workspace to branch
        if (updatedStory.branchName) {
          const syncResult = await gitVerificationService.syncWorkspaceToRemote(
            repoPath,
            updatedStory.branchName,
            commitSHA!
          );
          if (syncResult.success && syncResult.currentSHA) {
            commitSHA = syncResult.currentSHA;
          } else if (!syncResult.success) {
            return {
              developerCost,
              judgeCost: 0,
              conflictResolutionCost: 0,
              developerTokens,
              judgeTokens: { input: 0, output: 0 },
              conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 }
            };
          }
        }
      }

      // STEP 2: Judge reviews code
      console.log(`[STEP 2/3] Judge reviewing ${commitSHA?.substring(0, 8)} on ${updatedStory.branchName}`);

      // Create isolated context for Judge - SAME ISOLATED WORKSPACE as Developer
      // 🔥🔥🔥 CRITICAL: Judge uses SAME isolated workspace as Developer 🔥🔥🔥
      const judgeContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
      judgeContext.setData('storyToReview', updatedStory);
      judgeContext.setData('reviewMode', 'single-story');
      judgeContext.setData('developmentTeam', [developer]); // Only this developer
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);
      judgeContext.setData('commitSHA', commitSHA); // 🔥 CRITICAL: Exact commit to review
      judgeContext.setData('storyBranchName', updatedStory.branchName); // 🔥 CRITICAL: LITERAL branch name from Developer
      judgeContext.setData('isolatedWorkspacePath', effectiveWorkspacePath); // 🔥 Pass isolated path explicitly

      // 🔥 CHECKPOINT 4: Mark story as "judge_evaluating" before Judge starts
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'judge_evaluating', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress saved: judge_evaluating`);

      // ⚖️ JUDGE: AI validates the actual code changes
      console.log(`\n⚖️ [STEP 2/3] Running Judge validation...`);

      const { JudgePhase } = await import('./JudgePhase');

      // Use executeAgentFn for Judge (NOT executeDeveloperFn)
      if (!this.executeAgentFn) {
        throw new Error('executeAgentFn is required for Judge evaluation');
      }

      const judgePhase = new JudgePhase(this.executeAgentFn);
      const judgeResult = await judgePhase.execute(judgeContext);

      // Track judge cost and tokens
      const judgeCost = judgeResult.metadata?.cost || 0;
      const judgeTokens = {
        input: Number(judgeResult.metadata?.input_tokens || judgeResult.metrics?.input_tokens || 0),
        output: Number(judgeResult.metadata?.output_tokens || judgeResult.metrics?.output_tokens || 0),
      };
      if (judgeCost > 0) {
        console.log(`💰 [Judge] Cost: $${judgeCost.toFixed(4)} (${judgeTokens.input + judgeTokens.output} tokens)`);
      }

      // Judge returns status in data object
      const judgeStatus = judgeResult.data?.status;
      const isApproved = judgeResult.success && judgeStatus === 'approved';
      console.log(`[JUDGE] Verdict: ${isApproved ? 'APPROVED' : 'REJECTED'}`);

      // Get iteration info for rejection messages
      const iteration = judgeResult.data?.iteration || 1;
      const maxRetries = judgeResult.data?.maxRetries || 3;

      if (isApproved) {
        // Merge to epic branch
        console.log(`[STEP 3/3] Merging ${story.title} to epic branch...`);
        await this.mergeService.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, pipelineSandboxId);

        await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
          commitHash: commitSHA,
        });

        // Cleanup story branch after successful merge
        if (effectiveWorkspacePath && epic.targetRepository && updatedStory.branchName) {
          const targetRepo = gitVerificationService.findTargetRepo(repositories, epic.targetRepository);
          if (targetRepo) {
            const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;
            await gitVerificationService.deleteBranch(repoPath, updatedStory.branchName);
          }
        }

        console.log(`[PIPELINE] Completed: ${story.title}`);

        // 🔥 HOT RESTART: Rebuild and restart dev server after story completion
        // For Flutter: rebuild web assets then restart http server
        // For Node.js: just restart the process
        try {
          const sandboxConfig = context.getData<any>('sandboxConfig');
          const environmentConfig = context.getData<any>('environmentConfig');
          if (sandboxConfig && pipelineSandboxId && epic.targetRepository) {
            // 🔥 FIX: Get devCmd from environmentConfig (per-repo) or sandboxConfig.commands.dev (global)
            const envRepoConfig = environmentConfig?.[epic.targetRepository];
            const devCmd = envRepoConfig?.runCommand || sandboxConfig.commands?.dev;
            // 🔥 100% AGNOSTIC: Use containerWorkDir from SandboxPhase (SINGLE SOURCE OF TRUTH)
            const containerWorkDir = sandboxConfig.containerWorkDir || '/workspace';
            const repoDir = `${containerWorkDir}/${epic.targetRepository}`;

            if (devCmd) {
              console.log(`\n🔄 [HOT RESTART] Rebuilding and restarting for ${epic.targetRepository}...`);
              NotificationService.emitConsoleLog(taskId, 'info', `🔄 Rebuilding and restarting preview...`);

              // Kill existing server process (python http.server, flutter, node, etc.)
              const killCmd = `pkill -f "http.server" 2>/dev/null || pkill -f "flutter" 2>/dev/null || pkill -f "${epic.targetRepository}" 2>/dev/null || true`;
              await sandboxService.exec(pipelineSandboxId, killCmd, { cwd: repoDir, timeout: 10000 });

              // Wait for process to die
              await new Promise(resolve => setTimeout(resolve, 1000));

              // 🔥 AGNOSTIC: If Flutter/Dart, rebuild before serving
              // devCmd already contains "flutter build web && python3 -m http.server..."
              // Just run it again to rebuild and serve
              const logFile = `/tmp/${epic.targetRepository}-server.log`;
              const startCmd = `setsid bash -c 'cd ${repoDir} && ${devCmd}' > ${logFile} 2>&1 &`;

              console.log(`   📦 Running: ${devCmd.substring(0, 80)}...`);
              await sandboxService.exec(pipelineSandboxId, startCmd, { cwd: repoDir, timeout: 300000 }); // 5 min for rebuild

              console.log(`   ✅ Rebuild complete - preview shows latest code`);
              NotificationService.emitConsoleLog(taskId, 'info', `✅ Preview rebuilt with latest code!`);
            }
          }
        } catch (hotRestartError: any) {
          console.warn(`⚠️  [HOT RESTART] Could not rebuild/restart: ${hotRestartError.message}`);
          // Non-critical - preview might show stale code but development continues
        }

        // 🔄 GRANULAR RECOVERY: Persist story completion via EventStore
        // EventStore is the source of truth for story completion
        try {
          const taskId = (task.id as any).toString();

          // Update story status in-memory
          story.status = 'completed';
          (story as any).mergedToEpic = true;
          (story as any).completedAt = new Date();

          // 🔥 EVENT SOURCING: Emit StoryCompleted event for recovery tracking
          // This is CRITICAL - EventStore.buildState() uses this to mark stories as completed
          const { eventStore } = await import('../EventStore');
          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryCompleted',
            agentName: 'developer',
            payload: {
              storyId: story.id,
              epicId: (story as any).epicId,
              title: story.title,
              completedBy: (story as any).assignedTo,
            },
          });
          console.log(`📝 [EventStore] Emitted StoryCompleted for: ${story.title}`);

          // 🔥 CRITICAL FIX: Mark story as completed in Unified Memory for recovery tracking
          // This was missing! Without this, getResumptionPoint() returns completedStories: 0
          // 🔥 FIX #2: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
          await unifiedMemoryService.markStoryCompleted(
            taskId,
            normalizedEpicId,
            normalizedStoryId,
            'approved',
            updatedStory.branchName,
            undefined // PR URL not available yet
          );
          console.log(`✅ [UnifiedMemory] Marked story "${story.title}" as completed (epicId=${normalizedEpicId}, storyId=${normalizedStoryId})`);

          // 🔥 CHECKPOINT 6 (FINAL): Mark story progress as "completed"
          await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'completed', {
            commitHash: commitSHA,
          });
          console.log(`📍 [CHECKPOINT] Story progress saved: completed ✅`);

          // 🔄 Mark session checkpoint as completed (no resume needed for this story)
          await sessionCheckpointService.markCompleted(taskId, 'developer', story.id);

          // 🔥 REMOVED: granularMemoryService calls - SQLite tracks files via unifiedMemoryService.saveStoryProgress

          // Emit activity for visibility
          const { AgentActivityService } = await import('../AgentActivityService');
          AgentActivityService.emitMessage(
            taskId,
            'System',
            `💾 Story checkpoint saved: "${story.title}" marked as completed`
          );
        } catch (persistError: any) {
          console.error(`⚠️ [RECOVERY] Failed to persist story status: ${persistError.message}`);
          // Non-critical - don't fail the pipeline, just log warning
        }
      } else {
        // Judge REJECTED - check if specialist can help before giving up
        console.error(`❌ [STEP ${iteration}/${maxRetries}] Judge REJECTED story: ${story.title}`);
        console.error(`   Feedback: ${judgeResult.data?.feedback || judgeResult.error}`);

        // 🔥 SPECIALIST ROUTING: Check if rejection can be handled by a specialist
        const rejectReason = judgeResult.data?.rejectReason;
        console.log(`📋 [SPECIALIST ROUTING] Rejection reason: ${rejectReason || 'unknown'}`);

        // 🔧 CONFLICTS: Route to ConflictResolver specialist
        if (rejectReason === 'conflicts') {
          console.log(`\n🔧 [SPECIALIST] Routing to ConflictResolver for merge conflict resolution...`);
          try {
            // Import and call ConflictResolverPhase
            const { ConflictResolverPhase } = await import('./ConflictResolverPhase');
            const conflictResolver = new ConflictResolverPhase(this.executeAgentFn);

            // Create context for conflict resolution
            const conflictContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
            conflictContext.setData('story', updatedStory);
            conflictContext.setData('epic', epic);
            conflictContext.setData('storyBranchName', updatedStory.branchName);
            conflictContext.setData('commitSHA', commitSHA);
            conflictContext.setData('targetRepository', epic.targetRepository);
            conflictContext.setData('judgeFeedback', judgeResult.data?.feedback);
            if (pipelineSandboxId) {
              conflictContext.setData('sandboxId', pipelineSandboxId);
            }

            // Execute conflict resolution
            const conflictResult = await conflictResolver.execute(conflictContext);

            if (conflictResult.success) {
              console.log(`✅ [SPECIALIST] ConflictResolver resolved the conflicts`);

              // 🔄 RE-EVALUATE: Run Judge again after conflict resolution
              console.log(`\n⚖️ [RE-EVALUATION] Running Judge again after conflict resolution...`);
              const reEvalJudgePhase = new JudgePhase(this.executeAgentFn);
              const reEvalJudgeResult = await reEvalJudgePhase.execute(judgeContext);

              const reEvalApproved = reEvalJudgeResult.success && reEvalJudgeResult.data?.status === 'approved';

              if (reEvalApproved) {
                console.log(`✅ [RE-EVALUATION] Judge APPROVED after conflict resolution!`);

                // Continue with merge stage
                console.log(`\n🔀 [MERGE] Proceeding to merge approved story...`);
                await this.mergeService.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, pipelineSandboxId);

                // Mark story as completed
                await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
                  commitHash: commitSHA,
                });

                story.status = 'completed';
                (story as any).mergedToEpic = true;
                (story as any).completedAt = new Date();
                (story as any).resolvedBySpecialist = 'ConflictResolver';

                const { eventStore } = await import('../EventStore');
                await eventStore.safeAppend({
                  taskId: task.id as any,
                  eventType: 'StoryCompleted',
                  agentName: 'conflict-resolver',
                  payload: {
                    storyId: story.id,
                    epicId: (story as any).epicId,
                    title: story.title,
                    completedBy: 'ConflictResolver',
                    resolvedConflicts: true,
                  },
                });

                await unifiedMemoryService.markStoryCompleted(
                  taskId,
                  normalizedEpicId,
                  normalizedStoryId,
                  'approved',
                  updatedStory.branchName,
                  undefined
                );

                console.log(`✅ [PIPELINE] Story completed via ConflictResolver specialist`);

                // Return early - story is completed
                return {
                  developerCost,
                  judgeCost: judgeCost + (reEvalJudgeResult.metadata?.cost || 0),
                  conflictResolutionCost: conflictResult.metadata?.cost || 0,
                  developerTokens,
                  judgeTokens: {
                    input: judgeTokens.input + Number(reEvalJudgeResult.metadata?.input_tokens || 0),
                    output: judgeTokens.output + Number(reEvalJudgeResult.metadata?.output_tokens || 0),
                  },
                  conflictResolutionUsage: {
                    input_tokens: conflictResult.metadata?.input_tokens || 0,
                    output_tokens: conflictResult.metadata?.output_tokens || 0,
                  },
                };
              } else {
                console.warn(`⚠️ [RE-EVALUATION] Judge still rejected after conflict resolution`);
                console.warn(`   New feedback: ${reEvalJudgeResult.data?.feedback}`);
                // Fall through to normal rejection flow
              }
            } else {
              console.warn(`⚠️ [SPECIALIST] ConflictResolver could not resolve conflicts`);
              console.warn(`   Error: ${conflictResult.error || 'Unknown error'}`);
              // Fall through to normal rejection flow
            }
          } catch (specialistError: any) {
            console.error(`❌ [SPECIALIST] ConflictResolver failed: ${specialistError.message}`);
            // Fall through to normal rejection flow
          }
        }

        // Normal rejection flow - mark as failed
        console.error(`❌ [PIPELINE] Story pipeline FAILED - NOT merging`);

        // 📋 IMPORTANT: Branch preserved for investigation
        console.log(`\n📋 [REJECTED STORY] Branch preserved for investigation:`);
        console.log(`   Branch: ${updatedStory.branchName}`);
        console.log(`   Story: ${story.title}`);
        console.log(`   Judge Feedback:`);
        const feedback = judgeResult.data?.feedback || judgeResult.error || 'No feedback provided';
        console.log(`   ${feedback}`);
        console.log(`\n💡 Next steps:`);
        console.log(`   1. Review the code in branch: ${updatedStory.branchName}`);
        console.log(`   2. Fix issues based on Judge feedback`);
        console.log(`   3. Re-run orchestration or manually fix and merge`);

        // Emit notification so user sees this in the UI
        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          taskId, // taskId is already defined at function scope
          'error',
          `❌ Story rejected by Judge: ${story.title}\nBranch: ${updatedStory.branchName}\nFeedback: ${feedback}`
        );

        // 🔄 GRANULAR RECOVERY: Persist rejected status via EventStore
        try {
          story.status = 'failed';
          (story as any).error = feedback;

          // 🔥 EVENT SOURCING: Emit StoryFailed event for recovery tracking
          const { eventStore } = await import('../EventStore');
          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryFailed',
            agentName: 'developer',
            payload: {
              storyId: story.id,
              epicId: (story as any).epicId,
              title: story.title,
              error: feedback,
            },
          });
          console.log(`📝 [EventStore] Emitted StoryFailed for: ${story.title}`);

          // 🔥 CRITICAL FIX: Mark story as completed (rejected) in Unified Memory for recovery tracking
          // Even rejected stories need tracking so recovery knows not to re-process them
          // 🔥 FIX #2: Use normalizedEpicId/normalizedStoryId for consistency with recovery checks
          await unifiedMemoryService.markStoryCompleted(
            taskId,
            normalizedEpicId,
            normalizedStoryId,
            'rejected',
            updatedStory.branchName,
            undefined
          );
          console.log(`❌ [UnifiedMemory] Marked story "${story.title}" as rejected (epicId=${normalizedEpicId}, storyId=${normalizedStoryId})`);

          // 🔄 Mark session checkpoint as failed (keep checkpoint for potential retry)
          await sessionCheckpointService.markFailed(taskId, 'developer', story.id, feedback);

          // 🔥 REMOVED: granularMemoryService.storeError - SQLite tracks errors via task.orchestration
        } catch (persistError: any) {
          console.error(`⚠️ [RECOVERY] Failed to persist story failure status: ${persistError.message}`);
        }
      }

      // 🔥 COST TRACKING: Include conflict resolution cost from merge operation
      // Cast to any since conflictResolutionCost is dynamically added in mergeStoryToEpic
      const conflictResolutionCost = (updatedStory as any).conflictResolutionCost || 0;
      const conflictResolutionUsage = (updatedStory as any).conflictResolutionUsage || { input_tokens: 0, output_tokens: 0 };

      return {
        developerCost,
        judgeCost,
        conflictResolutionCost,
        developerTokens,
        judgeTokens,
        conflictResolutionUsage
      };

    } catch (error: any) {
      // Delegate recovery to RecoveryService
      const pipelineCtx: StoryPipelineContext = {
        task,
        story,
        developer,
        epic,
        repositories,
        effectiveWorkspacePath: workspacePath,
        workspaceStructure,
        attachments,
        state,
        context,
        taskId,
        normalizedEpicId,
        normalizedStoryId,
        epicBranchName: epicBranchName || `epic/${normalizedEpicId}`,
        devAuth,
        architectureBrief,
        environmentCommands,
        projectRadiographies,
        sandboxId,
      };

      const recoveryResult = await this.recoveryService.attemptRecovery(
        {
          taskId,
          story,
          epic,
          workspacePath,
          storyBranch: story.branchName,
          error,
        },
        pipelineCtx
      );

      return {
        developerCost: recoveryResult.developerCost,
        judgeCost: recoveryResult.judgeCost,
        conflictResolutionCost: recoveryResult.conflictResolutionCost,
        developerTokens: recoveryResult.developerTokens,
        judgeTokens: recoveryResult.judgeTokens,
        conflictResolutionUsage: recoveryResult.conflictResolutionUsage,
      };
    }
  }

  /**
   * 🔥 JUDGE STAGE: Run Judge evaluation on the committed code.
   *
   * This stage:
   * 1. Syncs workspace with remote
   * 2. Checkouts the story branch
   * 3. Saves 'judge_evaluating' checkpoint
   * 4. Creates Judge context
   * 5. Runs JudgePhase
   * 6. Returns verdict
   *
   * @returns JudgeStageResult with verdict, cost, and feedback
   */
  async executeJudgeStage(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string,
    storyBranch: string
  ): Promise<JudgeStageResult> {
    const {
      task, story, developer, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId, context: _context,
    } = pipelineCtx;

    console.log(`\n⚖️ [JUDGE STAGE] Starting for story: ${story.title}`);
    console.log(`   Commit: ${commitSHA}`);
    console.log(`   Branch: ${storyBranch}`);

    try {
      // Get updated story
      const { eventStore } = await import('../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      // 🔥 FIX: Use getStoryId() for consistent ID normalization
      const targetStoryId = getStoryId(story);
      const updatedStory = updatedState.stories.find((s: any) => {
        try { return getStoryId(s) === targetStoryId; } catch { return false; }
      });

      // Sync workspace with remote
      if (effectiveWorkspacePath && repositories.length > 0) {
        const targetRepo = repositories.find((r: any) =>
          r.name === epic.targetRepository ||
          r.full_name === epic.targetRepository ||
          r.githubRepoName === epic.targetRepository
        );

        if (targetRepo) {
          const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;

          console.log(`   🔄 Syncing workspace...`);
          try {
            // Use cached fetch to avoid redundant network calls
            smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });

            // Checkout story branch
            let branchExistsLocally = false;
            try {
              safeGitExecSync(`git show-ref --verify --quiet refs/heads/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
              branchExistsLocally = true;
            } catch { /* Branch doesn't exist locally */ }

            if (branchExistsLocally) {
              safeGitExecSync(`git checkout ${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            } else {
              safeGitExecSync(`git checkout -b ${storyBranch} origin/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            }

            // Reset to remote
            safeGitExecSync(`git reset --hard origin/${storyBranch}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`   ✅ Workspace synced`);
          } catch (syncErr: any) {
            console.warn(`   ⚠️ Sync failed: ${syncErr.message}`);
          }
        }
      }

      // 🔥 CHECKPOINT: Mark as judge_evaluating
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'judge_evaluating', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress: judge_evaluating`);

      // Create Judge context
      const judgeContext = new OrchestrationContext(task, repositories, effectiveWorkspacePath);
      judgeContext.setData('storyToReview', updatedStory);
      judgeContext.setData('reviewMode', 'single-story');
      judgeContext.setData('developmentTeam', [developer]);
      judgeContext.setData('executeDeveloperFn', this.executeDeveloperFn);
      judgeContext.setData('commitSHA', commitSHA);
      judgeContext.setData('storyBranchName', storyBranch);
      judgeContext.setData('isolatedWorkspacePath', effectiveWorkspacePath);

      // Run Judge
      const { JudgePhase } = await import('./JudgePhase');

      if (!this.executeAgentFn) {
        throw new Error('executeAgentFn is required for Judge evaluation');
      }

      const judgePhase = new JudgePhase(this.executeAgentFn);
      const judgeResult = await judgePhase.execute(judgeContext);

      // Track cost and tokens
      const judgeCost = judgeResult.metadata?.cost || 0;
      const judgeTokens = {
        input: Number(judgeResult.metadata?.input_tokens || judgeResult.metrics?.input_tokens || 0),
        output: Number(judgeResult.metadata?.output_tokens || judgeResult.metrics?.output_tokens || 0),
      };

      if (judgeCost > 0) {
        console.log(`💰 [Judge] Cost: $${judgeCost.toFixed(4)}`);
      }

      // Determine verdict
      const judgeStatus = judgeResult.data?.status;
      const isApproved = judgeResult.success && judgeStatus === 'approved';

      console.log(`✅ [JUDGE STAGE] Verdict: ${isApproved ? 'APPROVED ✅' : 'REJECTED ❌'}`);

      // 🔥 SPECIALIST ROUTING: Extract rejectReason for routing decision
      const rejectReason = judgeResult.data?.rejectReason;
      if (!isApproved && rejectReason) {
        console.log(`📋 [JUDGE STAGE] Rejection reason: ${rejectReason}`);
      }

      return {
        success: true,
        approved: isApproved,
        judgeCost,
        judgeTokens,
        feedback: judgeResult.data?.feedback || judgeResult.error,
        iteration: judgeResult.data?.iteration || 1,
        maxRetries: judgeResult.data?.maxRetries || 3,
        rejectReason,
      };

    } catch (error: any) {
      console.error(`❌ [JUDGE STAGE] Failed: ${error.message}`);
      return {
        success: false,
        approved: false,
        judgeCost: 0,
        judgeTokens: { input: 0, output: 0 },
        error: error.message,
      };
    }
  }

  /**
   * 🔥 MERGE STAGE: Merge approved story to epic branch.
   *
   * This stage:
   * 1. Calls mergeStoryToEpic
   * 2. Saves 'merged_to_epic' checkpoint
   * 3. Cleans up story branch
   * 4. Emits events
   *
   * @returns MergeStageResult with conflict resolution costs
   */
  async executeMergeStage(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string
  ): Promise<MergeStageResult> {
    const {
      task, story, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId, context: _context,
      sandboxId, // 🐳 Explicit sandbox ID for Docker execution
    } = pipelineCtx;

    console.log(`\n🔀 [MERGE STAGE] Merging story to epic branch: ${story.title}`);

    try {
      // Get updated story
      const { eventStore } = await import('../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      // 🔥 FIX: Use getStoryId() for consistent ID normalization
      const targetStoryId = getStoryId(story);
      const updatedStory = updatedState.stories.find((s: any) => {
        try { return getStoryId(s) === targetStoryId; } catch { return false; }
      });

      // Merge to epic branch
      await this.mergeService.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, sandboxId);

      // 🔥 CHECKPOINT: Mark as merged_to_epic
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress: merged_to_epic`);

      // 🔥 AUTO-REBUILD: Trigger rebuild for frameworks using static builds (Flutter, etc.)
      await this.triggerAutoRebuild(taskId, sandboxId, effectiveWorkspacePath, repositories, epic);

      // Cleanup story branch
      if (effectiveWorkspacePath && repositories.length > 0 && epic.targetRepository) {
        try {
          const targetRepo = repositories.find((r: any) =>
            r.name === epic.targetRepository ||
            r.full_name === epic.targetRepository ||
            r.githubRepoName === epic.targetRepository
          );

          if (targetRepo && updatedStory?.branchName) {
            const repoPath = `${effectiveWorkspacePath}/${targetRepo.name || targetRepo.full_name}`;
            const storyBranch = updatedStory.branchName;

            // Delete local branch
            try {
              safeGitExecSync(`cd "${repoPath}" && git branch -D ${storyBranch}`, { encoding: 'utf8' });
              console.log(`🧹 Cleaned up LOCAL story branch: ${storyBranch}`);
            } catch { /* Branch might not exist */ }

            // Delete remote branch
            try {
              safeGitExecSync(`cd "${repoPath}" && git push origin --delete ${storyBranch}`, {
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.CLONE
              });
              console.log(`🧹 Cleaned up REMOTE story branch: ${storyBranch}`);
            } catch { /* Branch might not exist on remote */ }
          }
        } catch (cleanupErr: any) {
          console.warn(`⚠️ Branch cleanup failed: ${cleanupErr.message}`);
        }
      }

      // Get conflict resolution costs from story (use updatedStory if available, fall back to original)
      const storyForCosts = updatedStory || story;
      const conflictResolutionCost = (storyForCosts as any).conflictResolutionCost || 0;
      const conflictResolutionUsage = (storyForCosts as any).conflictResolutionUsage || { input_tokens: 0, output_tokens: 0 };

      console.log(`✅ [MERGE STAGE] Complete`);

      return {
        success: true,
        conflictResolutionCost,
        conflictResolutionUsage,
      };

    } catch (error: any) {
      console.error(`❌ [MERGE STAGE] Failed: ${error.message}`);
      return {
        success: false,
        conflictResolutionCost: 0,
        conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
        error: error.message,
      };
    }
  }

  /**
   * 🔥 AUTO-REBUILD: Automatically rebuild after merge for frameworks using static builds
   *
   * This is AGNOSTIC - it reads rebuildCmd from EventStore's environmentConfig,
   * which was set by LanguageDetectionService based on LLM analysis.
   *
   * For frameworks with HMR (hot module replacement), rebuildCmd will be "echo 'HMR handles rebuild'"
   * which we skip. For static builds (Flutter Web), rebuildCmd will be "flutter build web".
   */
  async triggerAutoRebuild(
    taskId: string,
    _sandboxId: string | undefined,
    _workspacePath: string | null,
    repositories: any[],
    epic: any
  ): Promise<void> {
    // Check if sandbox is running using SandboxService (which uses taskId for lookup)
    const sandbox = sandboxService.getSandbox(taskId);
    if (!sandbox) {
      console.log(`   ⚠️ [AutoRebuild] No sandbox running for task ${taskId} - skipping auto-rebuild`);
      return;
    }

    // Find target repo name
    const targetRepoObj = repositories.find((r: any) =>
      r.name === epic.targetRepository ||
      r.full_name === epic.targetRepository ||
      r.githubRepoName === epic.targetRepository
    );

    if (!targetRepoObj) {
      console.log(`   ⚠️ [AutoRebuild] Could not find target repo - skipping`);
      return;
    }

    const repoName = targetRepoObj.name || targetRepoObj.full_name;

    // 🔥 AGNOSTIC: Get rebuildCmd from EventStore's environmentConfig
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(taskId as any);
    const envConfig = state.environmentConfig || {};
    const repoConfig = envConfig[repoName];

    if (!repoConfig) {
      console.log(`   ⚠️ [AutoRebuild] No environmentConfig for repo "${repoName}" - skipping`);
      return;
    }

    const rebuildCmd = repoConfig.rebuildCmd;
    const framework = repoConfig.framework || repoConfig.language || 'unknown';

    // Skip if no rebuildCmd or if it's just an echo (HMR handles rebuild)
    if (!rebuildCmd || rebuildCmd.startsWith("echo ")) {
      console.log(`   ℹ️ [AutoRebuild] Repo "${repoName}" uses HMR or has no rebuildCmd - skipping`);
      return;
    }

    console.log(`\n🔨 [AutoRebuild] Detected ${framework} project - triggering rebuild...`);
    console.log(`   Command: ${rebuildCmd}`);
    console.log(`   Repository: ${repoName}`);

    // Notify frontend that rebuild is starting
    NotificationService.emitNotification(taskId, 'rebuild_started', {
      framework,
      message: `Rebuilding ${framework} after merge...`,
    });

    try {
      const startTime = Date.now();

      // 🔥 FIX: Execute in the correct repo directory, NOT /workspace root
      const repoWorkDir = `/workspace/${repoName}`;
      const result = await sandboxService.exec(taskId, rebuildCmd, {
        cwd: repoWorkDir,
        timeout: 300000, // 5 minutes for builds
      });

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (result.exitCode === 0) {
        console.log(`   ✅ [AutoRebuild] ${framework} rebuild completed in ${duration}s`);

        // Notify frontend to refresh iframe
        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: true,
          duration,
          message: `${framework} rebuild complete! Refreshing preview...`,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 [AutoRebuild] ${framework} rebuilt after merge - preview updated`
        );
      } else {
        console.warn(`   ⚠️ [AutoRebuild] ${framework} rebuild failed (exit ${result.exitCode})`);
        console.warn(`      stderr: ${result.stderr?.substring(0, 300)}`);

        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: false,
          error: result.stderr?.substring(0, 200) || 'Build failed',
          message: `${framework} rebuild failed - manual refresh may be needed`,
        });
      }
    } catch (rebuildError: any) {
      console.error(`   ❌ [AutoRebuild] Error: ${rebuildError.message}`);

      NotificationService.emitNotification(taskId, 'rebuild_complete', {
        framework,
        success: false,
        error: rebuildError.message,
      });
    }
  }
}
