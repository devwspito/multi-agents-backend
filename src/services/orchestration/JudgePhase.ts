import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { IStory } from '../../models/Task';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';
import {
  initializeJudgeOrchestration,
  addOrUpdateJudgeEvaluation,
  updateJudgeStatus,
} from '../../utils/atomicTaskOperations';
import {
  getDataRequired,
  getDataOptional,
  getDataArray,
} from './utils/ContextHelpers';

/**
 * Judge Phase
 *
 * Evaluates developer implementations for code quality and requirements compliance.
 * Implements retry mechanism: if code doesn't pass, developer gets feedback and retries.
 *
 * CRITICAL EVALUATION CRITERIA (ALL MUST PASS):
 * 1. ✅ CODE EXISTS - Actual code written (not just documentation)
 * 2. ✅ CODE IS COMPLETE - No stubs, TODOs, or placeholders
 * 3. ✅ REQUIREMENTS MET - Implements the story requirements fully
 * 4. ✅ FOLLOWS PATTERNS - Uses existing codebase patterns
 * 5. ✅ QUALITY STANDARDS - No obvious bugs, proper error handling
 *
 * RETRY MECHANISM:
 * - Max 3 attempts per story
 * - Judge provides clear, actionable feedback
 * - Developer receives feedback and retries
 * - If all attempts fail, story marked as failed
 *
 * SDK COMPLIANCE:
 * ✅ Verification step (core agent loop: take action → verify work)
 * ✅ Judge model evaluates work (Anthropic best practice)
 * ✅ Clear feedback loop to prevent infinite loops
 * ✅ Context-aware evaluation (reads actual code changes)
 */
export class JudgePhase extends BasePhase {
  readonly name = 'Judge';
  readonly description = 'Evaluating developer code quality and requirements compliance';

  private readonly MAX_RETRIES = 3; // Developer gets 3 attempts to fix Judge feedback

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Judge already evaluated all stories (ONLY for recovery, NOT for continuations)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute to evaluate new code
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [Judge] This is a CONTINUATION - will re-execute to evaluate new code`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    const judgeEvaluations = context.task.orchestration.judge?.evaluations || [];

    // 🔥 EVENT SOURCING: Get stories from EventStore
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const stories = state.stories || [];

    console.log(`\n🔍 [Judge.shouldSkip] Checking if Judge already reviewed code...`);
    console.log(`   Total stories: ${stories.length}`);
    console.log(`   Total Judge evaluations: ${judgeEvaluations.length}`);

    if (judgeEvaluations.length === 0 || stories.length === 0) {
      console.log(`   ❌ No evaluations yet OR no stories - Judge MUST run`);
      return false;
    }

    // Check if all stories have approved evaluations
    console.log(`\n📋 [Judge.shouldSkip] Checking each story's evaluation status:`);

    const evaluationStatus = stories.map((story: any) => {
      const evaluation = judgeEvaluations.find((e: any) => e.storyId === story.id);
      const hasEval = !!evaluation;
      const status = evaluation?.status || 'NOT_EVALUATED';

      console.log(`   📝 Story: ${story.title || story.id}`);
      console.log(`      Story ID: ${story.id}`);
      console.log(`      Has evaluation: ${hasEval ? '✅ YES' : '❌ NO'}`);
      if (hasEval) {
        console.log(`      Status: ${status === 'approved' ? '✅ APPROVED' : '❌ ' + status}`);
        console.log(`      Developer: ${evaluation.developerId || 'unknown'}`);
        console.log(`      Iteration: ${evaluation.iteration || 1}`);
        const timestamp = (evaluation as any).timestamp;
        console.log(`      Timestamp: ${timestamp ? new Date(timestamp).toISOString() : 'unknown'}`);
      }

      return { story, hasEval, status };
    });

    const allStoriesApproved = evaluationStatus.every(s => s.hasEval && s.status === 'approved');

    if (allStoriesApproved) {
      console.log(`\n✅ [SKIP] Judge already approved ALL ${stories.length} stories`);
      console.log(`✅ All stories were reviewed during development (per-story mode)`);
      console.log(`✅ No need to re-evaluate - skipping Judge phase`);
      context.setData('judgeComplete', true);
      return true;
    } else {
      const unevaluated = evaluationStatus.filter(s => !s.hasEval || s.status !== 'approved');
      console.log(`\n❌ [NO SKIP] Judge has NOT approved all stories yet`);
      console.log(`❌ Stories needing evaluation: ${unevaluated.length}`);
      unevaluated.forEach(s => {
        console.log(`   - ${s.story.title || s.story.id}: ${s.hasEval ? s.status : 'NOT_EVALUATED'}`);
      });
      return false;
    }
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;

    // 🔥 CHECK REVIEW MODE: Single story or all stories?
    const reviewMode = context.getData<string>('reviewMode');
    const multiTeamMode = reviewMode === 'single-story'; // Called from DevelopersPhase per-story
    const storyToReview = context.getData<IStory>('storyToReview');

    // Determine which stories to evaluate
    let stories: IStory[];

    if (multiTeamMode && storyToReview) {
      // Single-story review mode (called from DevelopersPhase after story completion)
      stories = [storyToReview];
      console.log(`📋 [Judge] Single-story review mode: ${storyToReview.title}`);
    } else {
      // Full batch review mode (called from orchestration)
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task._id as any);
      stories = (state.stories || []) as any;
      console.log(`📋 [Judge] Batch review mode: Retrieved ${stories.length} stories from EventStore`);
    }

    if (stories.length === 0) {
      console.warn('⚠️ [Judge] No stories found to evaluate');
      return {
        success: false,
        error: 'No stories to evaluate',
      };
    }

    // 🔥 ATOMIC FIX: Initialize judge orchestration atomically to prevent race conditions
    // Use $setOnInsert to only create if doesn't exist (multiple phases may try simultaneously)
    if (!multiTeamMode) {
      await initializeJudgeOrchestration(taskId);

      // Update status to in_progress (this is idempotent)
      await updateJudgeStatus(taskId, 'in_progress');
    }

    NotificationService.emitAgentStarted(taskId, 'Judge');

    await LogService.agentStarted('judge', taskId, {
      phase: 'qa', // Judge is part of QA phase (quality assurance)
      metadata: {
        storiesCount: stories.length,
      },
    });

    // === EVALUATE EACH STORY WITH RETRY MECHANISM ===
    let totalApproved = 0;
    let totalFailed = 0;
    let lastFeedback: string | undefined;
    let lastIteration: number | undefined;

    for (const story of stories) {
      console.log(`\n📋 [Judge] Evaluating story: ${story.title}`);

      const result = await this.evaluateStoryWithRetry(
        task,
        story,
        workspacePath,
        context,
        multiTeamMode
      );

      if (result.status === 'approved') {
        totalApproved++;
        console.log(`✅ [Judge] Story "${story.title}" APPROVED`);
      } else {
        totalFailed++;
        lastFeedback = result.feedback; // Store feedback for single-story mode
        lastIteration = result.iteration; // Store iteration number
        console.error(`❌ [Judge] Story "${story.title}" FAILED after ${this.MAX_RETRIES} attempts`);
      }
    }

    // === JUDGE VERDICT ===
    const allPassed = totalFailed === 0;

    // 🔥 ATOMIC FIX: Update judge status atomically
    if (!multiTeamMode) {
      await updateJudgeStatus(
        taskId,
        allPassed ? 'completed' : 'failed',
        new Date() // completedAt
      );
      console.log(`✅ [Judge] Status updated atomically: ${allPassed ? 'completed' : 'failed'}`);
    }

    // Log final verdict
    console.log(`📊 [Judge] Verdict: ${allPassed ? 'All stories approved' : `${totalFailed} stories failed`}`);

    // 🔥 SINGLE-STORY MODE: Return simple approval status
    if (multiTeamMode && storyToReview) {
      const storyStatus = allPassed ? 'approved' : 'rejected';
      console.log(`⚖️ [Judge] Single-story verdict: ${storyStatus.toUpperCase()}`);

      return {
        success: true,
        data: {
          status: storyStatus,
          approved: totalApproved,
          failed: totalFailed,
          feedback: lastFeedback, // Include feedback for rejected stories
          iteration: lastIteration, // Include iteration number
          maxRetries: this.MAX_RETRIES, // Include max retries
        },
      };
    }

    // 🔥 BATCH MODE: Return full verdict
    if (allPassed) {
      NotificationService.emitAgentCompleted(
        taskId,
        'Judge',
        `All ${totalApproved} stories approved`
      );

      await LogService.agentCompleted('judge', taskId, {
        phase: 'qa',
        metadata: {
          approved: totalApproved,
          verdict: 'all_stories_approved',
        },
      });

      return {
        success: true,
        data: {
          approved: totalApproved,
          failed: totalFailed,
        },
        metrics: {
          totalStories: stories.length,
          approvalRate: (totalApproved / stories.length) * 100,
        },
      };
    } else {
      NotificationService.emitAgentMessage(
        taskId,
        'Judge',
        `⚠️ ${totalFailed} stories FAILED quality review after maximum retries. Review developer feedback and retry orchestration.`
      );

      await LogService.agentFailed('judge', taskId, new Error(`${totalFailed} stories failed evaluation`), {
        phase: 'qa',
        metadata: {
          approved: totalApproved,
          failed: totalFailed,
        },
      });

      return {
        success: false,
        error: `${totalFailed} stories failed quality evaluation`,
        data: {
          approved: totalApproved,
          failed: totalFailed,
        },
      };
    }
  }

  /**
   * Evaluate a single story with retry mechanism
   *
   * Flow:
   * 1. Developer implements story (attempt 1)
   * 2. Judge evaluates → APPROVED or CHANGES_REQUESTED
   * 3. If CHANGES_REQUESTED:
   *    - Judge provides clear feedback
   *    - Developer retries with feedback (attempt 2)
   *    - Repeat up to MAX_RETRIES
   * 4. If still failing after MAX_RETRIES → FAILED
   */
  private async evaluateStoryWithRetry(
    task: any,
    story: IStory,
    workspacePath: string | null,
    context: OrchestrationContext,
    multiTeamMode: boolean
  ): Promise<{ status: 'approved' | 'failed'; feedback?: string; iteration?: number }> {

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      console.log(`🔍 [Judge] Story "${story.title}" - Evaluation attempt ${attempt}/${this.MAX_RETRIES}`);

      // Get developer who worked on this story
      // In multi-team mode, read from context instead of task
      const team = multiTeamMode
        ? context.getData<any[]>('developmentTeam') || []
        : task.orchestration.team || [];

      const developer = team.find((m: any) =>
        m.assignedStories.includes(story.id)
      );

      if (!developer) {
        console.warn(`⚠️  No developer assigned to story ${story.id}`);
        console.warn(`   Team size: ${team.length}, Story ID: ${story.id}`);
        if (team.length > 0) {
          console.warn(`   Available developers: ${team.map((m: any) => `${m.instanceId} (${m.assignedStories.join(',')})`).join(', ')}`);
        }
        continue;
      }

      // === EVALUATE CODE ===
      const evaluation = await this.evaluateCode(
        task,
        story,
        developer,
        workspacePath,
        context
      );

      // 🔥 ATOMIC FIX: Store evaluation atomically to prevent race conditions
      // Use addOrUpdateJudgeEvaluation instead of direct array manipulation
      if (!multiTeamMode) {
        const taskIdStr = (task._id as any).toString();
        await addOrUpdateJudgeEvaluation(taskIdStr, {
          storyId: story.id,
          developerId: developer.instanceId,
          status: evaluation.status,
          feedback: evaluation.feedback,
          iteration: attempt,
          timestamp: new Date(),
        });

        console.log(`✅ [Judge] Evaluation saved atomically for story ${story.id}`);
      } else {
        // Multi-team mode: still need local update for in-memory consistency
        const existingEvalIndex = task.orchestration.judge.evaluations.findIndex(
          (e: any) => e.storyId === story.id && e.developerId === developer.instanceId
        );

        const evaluationRecord = {
          storyId: story.id,
          developerId: developer.instanceId,
          status: evaluation.status,
          feedback: evaluation.feedback,
          iteration: attempt,
          timestamp: new Date(),
        };

        if (existingEvalIndex >= 0) {
          task.orchestration.judge.evaluations[existingEvalIndex] = evaluationRecord;
        } else {
          task.orchestration.judge.evaluations.push(evaluationRecord);
        }
      }

      // === CHECK RESULT ===
      if (evaluation.status === 'approved') {
        // ✅ CODE PASSED - move to next story
        story.judgeStatus = 'approved';
        story.status = 'completed';
        if (!multiTeamMode) {
          await task.save();
        }

        NotificationService.emitAgentMessage(
          (task._id as any).toString(),
          'Judge',
          `✅ Story **"${story.title}"** approved by Judge`
        );

        return { status: 'approved', iteration: attempt };
      } else {
        // ❌ CODE NEEDS CHANGES
        story.judgeStatus = 'changes_requested';
        story.judgeComments = evaluation.feedback;
        if (!multiTeamMode) {
          await task.save();
        }

        NotificationService.emitAgentMessage(
          (task._id as any).toString(),
          'Judge',
          `🔄 Story **"${story.title}"** needs changes (attempt ${attempt}/${this.MAX_RETRIES}):\n\n${evaluation.feedback}`
        );

        if (attempt < this.MAX_RETRIES) {
          // 🔥 CRITICAL FIX: Validate retry limit BEFORE attempting retry
          const nextIteration = attempt + 1;

          console.log(`\n🔍 [Judge] Retry Limit Validation:`);
          console.log(`   Current iteration: ${attempt}`);
          console.log(`   Next iteration would be: ${nextIteration}`);
          console.log(`   Maximum allowed: ${this.MAX_RETRIES}`);
          console.log(`   Retries remaining: ${this.MAX_RETRIES - attempt}`);

          // Safety check: Prevent infinite loops
          if (nextIteration > this.MAX_RETRIES) {
            console.error(`\n❌❌❌ [Judge] RETRY LIMIT EXCEEDED - SAFETY CHECK TRIGGERED!`);
            console.error(`   Story: ${story.title}`);
            console.error(`   Story ID: ${story.id}`);
            console.error(`   Developer: ${developer.instanceId}`);
            console.error(`   Iterations completed: ${attempt}`);
            console.error(`   Maximum allowed: ${this.MAX_RETRIES}`);
            console.error(`\n   🛑 STOPPING RETRY LOOP - This should NOT happen (for loop should prevent this)`);
            console.error(`   🛑 If you see this, there's a logic error in the retry mechanism`);

            throw new Error(
              `HUMAN_REQUIRED: Story ${story.id} exceeded retry limit ` +
              `(${attempt}/${this.MAX_RETRIES}) - manual intervention needed`
            );
          }

          console.log(`✅ [Judge] Retry limit check passed - proceeding with retry ${nextIteration}/${this.MAX_RETRIES}`);

          // 🔄 RETRY: Developer gets another attempt with Judge feedback
          console.log(`🔄 [Judge] Story failed evaluation - Developer will retry (attempt ${nextIteration}/${this.MAX_RETRIES})`);

          // Execute developer retry with Judge feedback
          try {
            await this.retryDeveloperWork(task, developer, story, context, evaluation.feedback);
            // Continue to next iteration (Judge will re-evaluate)
            continue;
          } catch (retryError: any) {
            // 🔥 Retry failed catastrophically - mark story as failed and stop retrying
            console.error(`❌ [Judge] Developer retry failed catastrophically: ${retryError.message}`);
            NotificationService.emitAgentMessage(
              (task._id as any).toString(),
              'Judge',
              `❌ Story **"${story.title}"** retry FAILED: ${retryError.message}`
            );
            return {
              status: 'failed',
              feedback: `Retry failed: ${retryError.message}`,
              iteration: attempt,
            };
          }
        } else {
          // MAX RETRIES REACHED
          story.status = 'failed';
          story.judgeStatus = 'changes_requested';
          if (!multiTeamMode) {
            await task.save();
          }

          NotificationService.emitAgentMessage(
            (task._id as any).toString(),
            'Judge',
            `❌ Story **"${story.title}"** FAILED after ${this.MAX_RETRIES} attempts. Last feedback:\n\n${evaluation.feedback}`
          );

          return {
            status: 'failed',
            feedback: `Failed after ${this.MAX_RETRIES} attempts. Last feedback: ${evaluation.feedback}`,
            iteration: attempt,
          };
        }
      }
    }

    return { status: 'failed', feedback: 'Max retries exceeded', iteration: this.MAX_RETRIES };
  }

  /**
   * Evaluate code changes for a story
   *
   * Uses Judge agent to read code and evaluate against criteria
   */
  private async evaluateCode(
    task: any,
    story: IStory,
    developer: any,
    workspacePath: string | null,
    context: OrchestrationContext
  ): Promise<{ status: 'approved' | 'changes_requested'; feedback: string }> {

    // 🔍 DETAILED LOGGING: Show exactly what Judge is about to review
    console.log(`\n${'='.repeat(80)}`);
    console.log(`⚖️  [JUDGE] STARTING CODE REVIEW`);
    console.log(`${'='.repeat(80)}`);
    console.log(`📋 Story: ${story.title}`);
    console.log(`🆔 Story ID: ${story.id}`);
    console.log(`👤 Developer: ${developer?.instanceId || 'UNKNOWN'}`);
    console.log(`📝 Description: ${story.description || 'No description'}`);

    // Validate critical inputs
    if (!task?._id) {
      throw new Error(`Invalid task object - missing _id field`);
    }
    if (!developer?.instanceId) {
      throw new Error(`Invalid developer object - missing instanceId field`);
    }

    // 🔥 SAFE CONTEXT ACCESS: Use getDataRequired to validate commitSHA exists
    console.log(`\n🔍 [Judge] Code Location Details:`);
    let commitSHA: string;
    try {
      commitSHA = getDataRequired<string>(context, 'commitSHA');
      console.log(`   📍 Commit SHA: ${commitSHA}`);
      console.log(`   ✅ Will review EXACT commit that developer created`);
    } catch (error: any) {
      // getDataRequired throws clear error if missing
      console.error(`\n❌❌❌ [Judge] CRITICAL ERROR: ${error.message}`);
      console.error(`   Story: ${story.title}`);
      console.error(`   Story ID: ${story.id}`);
      console.error(`   Developer: ${developer?.instanceId}`);
      console.error(`\n   💀 WITHOUT COMMIT SHA, WE DON'T KNOW WHAT CODE TO REVIEW`);
      console.error(`   💀 Reviewing HEAD would be ARBITRARY and DANGEROUS`);
      console.error(`   💀 Different commit = different code = incorrect review`);
      console.error(`\n   🛑 STOPPING REVIEW - HUMAN INTERVENTION REQUIRED`);
      throw new Error(`HUMAN_REQUIRED: No commit SHA for story ${story.id} - cannot determine which code to review`);
    }

    // 🔥 SAFE CONTEXT ACCESS: Get branch name with fallback to story.branchName
    const storyBranchName = getDataOptional<string>(context, 'storyBranchName') || story.branchName;
    if (storyBranchName) {
      console.log(`   🔀 Branch: ${storyBranchName}`);
      console.log(`   ✅ Will review code on EXACT branch developer worked on`);
    } else {
      console.error(`   ❌ No branch name - cannot verify correct branch!`);
    }

    // 🔥 SAFE CONTEXT ACCESS: Get target repository (optional - may come from epic)
    let targetRepository = getDataOptional<string>(context, 'targetRepository');
    if (!targetRepository && (story as any).epicId) {
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task._id as any);
      const epic = state.epics?.find((e: any) => e.id === (story as any).epicId);

      if (!epic) {
        console.error(`\n❌ [Judge] CRITICAL: Cannot find epic for story!`);
        throw new Error(`HUMAN_REQUIRED: Cannot find epic ${(story as any).epicId} for story ${story.id}`);
      }

      if (!epic.targetRepository) {
        console.error(`\n❌ [Judge] CRITICAL: Epic has NO targetRepository!`);
        throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository in Judge phase`);
      }

      targetRepository = epic.targetRepository;
    }

    if (!targetRepository) {
      console.error(`\n❌ [Judge] CRITICAL: No targetRepository found!`);
      throw new Error(`HUMAN_REQUIRED: No targetRepository for story ${story.id} in Judge phase`);
    }

    console.log(`   📂 Repository: ${targetRepository}`);
    console.log(`   📁 Workspace: ${workspacePath || 'NOT SET'}`);

    // Show files that should have been modified/created
    console.log(`\n📝 [Judge] Expected File Changes:`);
    const filesToModify = (story as any).filesToModify || [];
    const filesToCreate = (story as any).filesToCreate || [];

    if (filesToModify.length > 0) {
      console.log(`   ✏️  Files to MODIFY (${filesToModify.length}):`);
      filesToModify.forEach((f: string) => console.log(`      - ${f}`));
    } else {
      console.log(`   ⚠️  No files marked to MODIFY`);
    }

    if (filesToCreate.length > 0) {
      console.log(`   ➕ Files to CREATE (${filesToCreate.length}):`);
      filesToCreate.forEach((f: string) => console.log(`      - ${f}`));
    } else {
      console.log(`   ⚠️  No files marked to CREATE`);
    }

    const totalExpectedFiles = filesToModify.length + filesToCreate.length;
    console.log(`   📊 Total expected file changes: ${totalExpectedFiles}`);

    if (totalExpectedFiles === 0) {
      console.warn(`   ⚠️  WARNING: No expected file changes listed - Judge may have limited context`);
    }

    const prompt = this.buildJudgePrompt(task, story, developer, workspacePath, commitSHA, targetRepository, storyBranchName);

    // 🔥 SAFE CONTEXT ACCESS: Retrieve processed attachments (optional - defaults to empty array)
    // This ensures ALL agents receive the same multimedia context
    const attachments = getDataArray<any>(context, 'attachments');

    // Convert taskId with extra safety
    let taskId: string;
    try {
      console.log(`🔍 [Judge] About to convert task._id to string...`);
      console.log(`   task._id type: ${typeof task._id}`);
      console.log(`   task._id value: ${task._id}`);
      taskId = task._id ? task._id.toString() : 'unknown-task';
      console.log(`✅ [Judge] taskId converted: ${taskId}`);
    } catch (conversionError: any) {
      console.error(`❌ [Judge] Failed to convert task._id: ${conversionError.message}`);
      throw new Error(`Cannot convert task._id to string: ${conversionError.message}`);
    }
    if (attachments.length > 0) {
      console.log(`📎 [Judge] Using ${attachments.length} attachment(s) from context`);
      const { NotificationService } = await import('../NotificationService');
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `📎 Judge: Received ${attachments.length} image(s) from context for evaluation`
      );
    }

    // 🔥 CRITICAL: Log workspace BEFORE executing Judge
    console.log(`\n🔍 [Judge] About to execute Judge agent with:`);
    console.log(`   Workspace: ${workspacePath}`);
    console.log(`   Task ID: ${taskId}`);
    console.log(`   Story: ${story.title}`);
    console.log(`   Commit SHA: ${commitSHA || 'NOT PROVIDED'}`);
    console.log(`   Developer: ${developer.instanceId}`);
    console.log(`   If this fails, problem is in executeAgentFn SDK call`);

    // 🔥 DEBUG: Show workspace contents to verify files exist
    if (workspacePath) {
      try {
        const { execSync } = require('child_process');
        const lsOutput = execSync(`ls -la "${workspacePath}"`, { encoding: 'utf8' });
        console.log(`\n📂 [Judge] Workspace contents:\n${lsOutput}`);

        // Also show repository subdirectories
        const repos = execSync(`ls -d "${workspacePath}"/*/ 2>/dev/null || echo "no subdirectories"`, { encoding: 'utf8' });
        console.log(`\n📂 [Judge] Repository directories:\n${repos}`);

        const { NotificationService: NS } = await import('../NotificationService');
        NS.emitConsoleLog(
          taskId,
          'info',
          `📂 Judge workspace: ${workspacePath}\n\nContents:\n${lsOutput}\n\nRepositories:\n${repos}`
        );
      } catch (lsError: any) {
        console.error(`⚠️  Could not list workspace: ${lsError.message}`);
      }
    }

    try {
      const result = await this.executeAgentFn(
        'judge',
        prompt,
        workspacePath,
        taskId, // taskId parameter
        'Judge', // agentName parameter
        undefined, // sessionId
        undefined, // fork
        attachments.length > 0 ? attachments : undefined, // attachments parameter
        {
          maxIterations: 5,
          timeout: 300000, // 5 minutes
        }
      );

      console.log(`\n✅ [Judge] Judge agent execution completed successfully`);
      console.log(`   📊 Output length: ${result.output?.length || 0} chars`);
      console.log(`   💰 Cost: $${result.cost?.toFixed(4) || 0}`);
      console.log(`   📈 Tokens: ${(result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0)}`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      const { NotificationService: NS } = await import('../NotificationService');
      NS.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n⚖️ JUDGE - FULL OUTPUT (Story: ${story.title})\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Parse judge output
      console.log(`\n🔍 [Judge] Parsing Judge's decision...`);
      const parsed = this.parseJudgeOutput(result.output);

      // Log the verdict clearly
      console.log(`\n${'='.repeat(80)}`);
      console.log(`⚖️  [JUDGE] VERDICT FOR STORY: ${story.title}`);
      console.log(`${'='.repeat(80)}`);
      console.log(`📋 Story ID: ${story.id}`);
      console.log(`👤 Developer: ${developer.instanceId}`);
      console.log(`📍 Commit: ${commitSHA || 'HEAD'}`);
      console.log(`🔀 Branch: ${storyBranchName || 'unknown'}`);

      if (parsed.status === 'approved') {
        console.log(`\n✅ VERDICT: APPROVED`);
        console.log(`✅ Code meets all quality standards`);
        if (parsed.feedback && parsed.feedback !== 'Code approved - meets all quality standards') {
          console.log(`📝 Notes from Judge:`);
          console.log(`   ${parsed.feedback}`);
        }
      } else {
        console.log(`\n❌ VERDICT: CHANGES REQUESTED`);
        console.log(`❌ Code does NOT meet quality standards`);
        console.log(`\n📋 Feedback from Judge:`);
        const feedbackLines = parsed.feedback.split('\n');
        feedbackLines.forEach(line => {
          if (line.trim()) console.log(`   ${line}`);
        });
      }
      console.log(`${'='.repeat(80)}\n`);

      return {
        status: parsed.status === 'approved' ? 'approved' : 'changes_requested',
        feedback: parsed.feedback,
      };

    } catch (error: any) {
      console.error(`❌ [Judge] Evaluation error:`, error.message);

      return {
        status: 'changes_requested',
        feedback: `Evaluation failed: ${error.message}. Please review the code manually.`,
      };
    }
  }

  /**
   * Build evaluation prompt for Judge agent
   */
  private buildJudgePrompt(
    _task: any,
    story: any,
    developer: any,
    _workspacePath: string | null,
    commitSHA?: string,
    targetRepository?: string,
    storyBranchName?: string
  ): string {
    return `# Judge - Code Review

## Story: ${story.title}
Developer: ${developer.instanceId}
${targetRepository ? `Repository: ${targetRepository}` : ''}
${storyBranchName ? `Branch: ${storyBranchName}` : ''}
${commitSHA ? `Commit: ${commitSHA}` : ''}

Files to check:
- Modify: ${story.filesToModify?.join(', ') || 'none'}
- Create: ${story.filesToCreate?.join(', ') || 'none'}

## 🎯 EVALUATION (All must pass):
1. ✅ CODE EXISTS - Not just docs/comments
2. ✅ COMPLETE - No TODOs/stubs
3. ✅ REQUIREMENTS MET - Story fully implemented
4. ✅ PATTERNS - Follows codebase conventions
5. ✅ QUALITY - No obvious bugs, has error handling

## INSTRUCTIONS (Be efficient):
1. Read the modified/created files
2. Check for TODOs/placeholders
3. Verify requirements met
4. Evaluate code quality

## OUTPUT (JSON only):
{
  "status": "approved" | "changes_requested",
  "feedback": "Detailed feedback explaining what passed/failed and specific improvements needed",
  "criteria": {
    "codeExists": true/false,
    "codeComplete": true/false,
    "requirementsMet": true/false,
    "followsPatterns": true/false,
    "qualityStandards": true/false
  }
}

**CRITICAL**: If ANY criterion fails, status MUST be "changes_requested" with specific feedback.

**Review Guidelines**:
- Focus on the files that were supposed to be modified according to the story
- Verify the most critical aspects first: code exists, requirements met, no obvious bugs
- If the changeset is large (>10 files), prioritize reviewing the core changes
- You don't need to verify every edge case - focus on main functionality and obvious issues`;
  }

  /**
   * Parse Judge agent output - Uses plain text markers
   * Following Anthropic SDK best practices
   */
  private parseJudgeOutput(output: string): { status: string; feedback: string } {
    console.log(`🔍 [Judge] Parsing output (length: ${output.length} chars)...`);

    // Check for approval/rejection markers
    const approved = hasMarker(output, COMMON_MARKERS.APPROVED);
    const rejected = hasMarker(output, COMMON_MARKERS.REJECTED);

    if (approved && !rejected) {
      console.log(`✅ [Judge] APPROVED marker found`);

      // Extract feedback if present (even for approved code)
      const feedback = extractMarkerValue(output, '📍 Feedback:') ||
                      extractMarkerValue(output, '📍 Notes:') ||
                      'Code approved - meets all quality standards';

      return {
        status: 'approved',
        feedback: feedback,
      };
    } else if (rejected || !approved) {
      console.log(`❌ [Judge] REJECTED marker found or no approval`);

      // Extract detailed feedback
      const reason = extractMarkerValue(output, '📍 Reason:') || '';
      const requiredChanges = extractMarkerValue(output, '📍 Required Changes:') || '';

      // Build comprehensive feedback
      let feedback = '';
      if (reason) {
        feedback += `Reason: ${reason}\n`;
      }
      if (requiredChanges) {
        feedback += `Required Changes: ${requiredChanges}\n`;
      }

      // If no structured feedback, use full output
      if (!feedback) {
        feedback = output;
      }

      return {
        status: 'changes_requested',
        feedback: feedback,
      };
    }

    // Fallback: No clear markers found
    console.warn(`⚠️  [Judge] No clear approval/rejection markers found`);
    return {
      status: 'changes_requested',
      feedback: 'Judge output unclear - please review manually:\n\n' + output,
    };
  }

  /**
   * Retry developer work with Judge feedback
   */
  private async retryDeveloperWork(
    task: any,
    developer: any,
    story: any,
    context: OrchestrationContext,
    judgeFeedback: string
  ): Promise<void> {
    console.log(`🔄 [Judge] Developer ${developer.instanceId} retrying story "${story.title}" with feedback`);

    const taskId = (task._id as any).toString();

    // 🔥 CRITICAL: Use ORIGINAL workspace path, NOT Judge's worktree
    // Judge's context.workspacePath is the worktree (IS the repo directly)
    // Developer expects parent workspace with repo subdirectories inside
    // e.g., Judge worktree: /tmp/judge-123-v2_frontend (IS the repo)
    //       Developer expects: /tmp/workspace (with /tmp/workspace/v2_frontend inside)
    const workspacePath = context.getData<string>('originalWorkspacePath') || context.workspacePath;

    console.log(`📂 [Judge Retry] Using workspace for developer: ${workspacePath}`);
    console.log(`   Original context.workspacePath (Judge worktree): ${context.workspacePath}`);
    console.log(`   Using originalWorkspacePath for developer: ${context.getData<string>('originalWorkspacePath') || 'NOT SET - falling back'}`);

    if (workspacePath === context.workspacePath && context.workspacePath?.includes('judge-')) {
      console.warn(`⚠️  [Judge Retry] WARNING: Using Judge worktree as developer workspace!`);
      console.warn(`   This may cause "No such file or directory" errors`);
      console.warn(`   Developer will try to access ${workspacePath}/<repoName> but it IS the repo`);
    }

    // Get executeDeveloperFn from context
    const executeDeveloperFn = context.getData<Function>('executeDeveloperFn');
    if (!executeDeveloperFn || typeof executeDeveloperFn !== 'function') {
      console.error('❌ [Judge] executeDeveloperFn not found in context or not a function');
      throw new Error('executeDeveloperFn not available - cannot retry developer');
    }

    // 🔥 CRITICAL: Format feedback for Developer to understand clearly
    const formattedFeedback = `🚨 CODE REVIEW FAILED - CHANGES REQUIRED 🚨

${judgeFeedback}

⚠️ CRITICAL INSTRUCTIONS:
1. Read the feedback above carefully
2. Make ALL required changes
3. Test your changes
4. Commit with descriptive message
5. Report commit SHA with marker: 📍 Commit SHA: <your-sha-here>

❌ DO NOT mark as complete until ALL feedback items are addressed.`;
    console.log(`✅ [Judge] Formatted feedback for Developer`);

    NotificationService.emitAgentMessage(
      taskId,
      'Judge',
      `🔄 Requesting ${developer.instanceId} to retry with feedback:\n\n${formattedFeedback}`
    );

    // Execute developer again with Judge feedback
    const repositories = context.repositories;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';
    const attachments = context.getData<any[]>('attachments') || [];

    // Get EventStore state for stories and epics
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);

    // 🔥 CRITICAL: Verify story has branchName before retry
    const storyFromEventStore = state.stories.find((s: any) => s.id === story.id);
    if (storyFromEventStore?.branchName) {
      console.log(`✅ [Judge] Story has branchName for retry: ${storyFromEventStore.branchName}`);
    } else {
      console.warn(`⚠️  [Judge] Story does NOT have branchName - retry may create new branch!`);
      console.warn(`   Story ID: ${story.id}`);
      console.warn(`   Stories in EventStore: ${state.stories.length}`);
    }

    // 🔥 CRITICAL: Get epic branch name from context (created by TeamOrchestrationPhase)
    const epicBranchName = context.getData<string>('epicBranch');
    console.log(`📂 [Judge] Passing epic branch to developer for retry: ${epicBranchName || 'not specified'}`);

    try {
      console.log(`🚀 [Judge] Executing developer retry with topModel upgrade`);
      console.log(`   Stories passed to developer: ${state.stories.length}`);
      console.log(`   Story "${story.id}" branchName: ${storyFromEventStore?.branchName || 'NOT SET'}`);
      await executeDeveloperFn(
        task,
        developer,
        repositories,
        workspacePath,
        workspaceStructure,
        attachments,
        state.stories,
        state.epics,
        formattedFeedback, // Pass FORMATTED Judge feedback for retry (structured and clear)
        epicBranchName, // Epic branch name from TeamOrchestrationPhase
        true // 🚀 forceTopModel: Use best model for retry (Judge rejected the code)
      );

      console.log(`✅ [Judge] Developer ${developer.instanceId} completed retry for story "${story.title}"`);

      // 🔥 CRITICAL: Get updated story from EventStore after developer retry
      // Developer may have updated branchName or other fields
      // Use exponential backoff retry in case EventStore has lag
      let updatedStory: any = null;
      const maxRetries = 3;
      const baseDelay = 500; // 500ms

      for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
        try {
          const updatedState = await eventStore.getCurrentState(task._id as any);
          updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

          if (updatedStory && updatedStory.branchName) {
            console.log(`✅ [POST-RETRY SYNC] Retrieved story from EventStore (attempt ${retryAttempt + 1}/${maxRetries})`);
            break;
          } else {
            console.warn(`⚠️  [POST-RETRY SYNC] Story ${story.id} not found or incomplete in EventStore (attempt ${retryAttempt + 1}/${maxRetries})`);
            if (retryAttempt < maxRetries - 1) {
              const delay = baseDelay * Math.pow(2, retryAttempt); // Exponential backoff
              console.log(`⏳ [POST-RETRY SYNC] Waiting ${delay}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          }
        } catch (eventStoreError: any) {
          console.error(`❌ [POST-RETRY SYNC] EventStore error (attempt ${retryAttempt + 1}/${maxRetries}): ${eventStoreError.message}`);
          if (retryAttempt < maxRetries - 1) {
            const delay = baseDelay * Math.pow(2, retryAttempt);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
      }

      if (!updatedStory) {
        console.error(`❌ [POST-RETRY SYNC] Could not find story ${story.id} in EventStore after ${maxRetries} attempts`);
        console.error(`   This is a critical error - cannot continue retry loop without updated story`);
        // 🔥 FIX: Throw error instead of silent return - this will stop the retry loop
        throw new Error(`POST-RETRY SYNC: Story ${story.id} not found in EventStore after developer retry`);
      }

      // 🔥 CRITICAL: Update story reference for next evaluation
      Object.assign(story, updatedStory);
      console.log(`✅ [POST-RETRY SYNC] Updated story from EventStore:`);
      console.log(`   Branch: ${story.branchName}`);
      console.log(`   Status: ${story.status}`);

      // 🔥 CRITICAL: Sync Judge's workspace after developer retry BEFORE next Judge review
      // Developer pushed new commits, Judge needs to see them
      const judgeUsingWorktree = context.getData<boolean>('judgeUsingWorktree') ?? false;

      console.log(`📍 [POST-RETRY SYNC] Configuration:`);
      console.log(`   Mode: ${judgeUsingWorktree ? 'WORKTREE' : 'FALLBACK (main repo)'}`);
      console.log(`   Context workspace: ${context.workspacePath || 'NOT SET'}`);
      console.log(`   Story branch: ${story.branchName || 'NOT SET'}`);

      // Validate we have required data
      if (!context.workspacePath) {
        console.error(`❌ [POST-RETRY SYNC] CRITICAL: context.workspacePath is null!`);
        throw new Error(`POST-RETRY SYNC: No workspace path in context`);
      }

      if (story.branchName) {
        try {
          // 🔥 SIMPLIFIED: context.workspacePath is ALWAYS the repo path now
          // - Worktree mode: judgeWorktreePath (IS the repo directly)
          // - Fallback mode: judgeRepoPath (also the repo - ${workspacePath}/${repoName})
          // Both point to the actual git repository, not the parent workspace
          const repoPath = context.workspacePath!;

          if (!repoPath) {
            throw new Error('POST-RETRY SYNC: context.workspacePath is null');
          }

          console.log(`\n🔄 [POST-RETRY SYNC] Syncing Judge workspace with developer's latest commits...`);
          console.log(`   Mode: ${judgeUsingWorktree ? 'ISOLATED WORKTREE' : 'FALLBACK (main repo)'}`);
          console.log(`   Repository path: ${repoPath}`);
          console.log(`   Branch to sync: ${story.branchName}`);

          // Fetch and pull latest commits
          const { safeGitExecSync } = await import('../../utils/safeGitExecution');
          safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: 30000 });

          // 🔥 FIX: Stash any unstaged changes before checkout
          // Developer might have left uncommitted changes
          try {
            const statusOutput = safeGitExecSync(`git status --porcelain`, { cwd: repoPath, encoding: 'utf8' });
            if (statusOutput.trim().length > 0) {
              console.log(`⚠️  [POST-RETRY SYNC] Detected unstaged changes, attempting to stash...`);

              try {
                // First try: Normal stash
                safeGitExecSync(`git stash push -u -m "Judge auto-stash before retry sync"`, {
                  cwd: repoPath,
                  encoding: 'utf8'
                });
                console.log(`✅ [POST-RETRY SYNC] Successfully stashed unstaged changes`);
              } catch (stashError: any) {
                console.warn(`⚠️  [POST-RETRY SYNC] Stash failed: ${stashError.message}`);
                console.log(`🔧 [POST-RETRY SYNC] Attempting hard reset to clean workspace...`);

                try {
                  // Fallback: Hard reset to HEAD (DANGEROUS but necessary to continue)
                  safeGitExecSync(`git reset --hard HEAD`, {
                    cwd: repoPath,
                    encoding: 'utf8'
                  });
                  // Also clean untracked files
                  safeGitExecSync(`git clean -fd`, {
                    cwd: repoPath,
                    encoding: 'utf8'
                  });
                  console.log(`✅ [POST-RETRY SYNC] Hard reset successful - workspace is clean`);
                  console.warn(`⚠️  [POST-RETRY SYNC] WARNING: Uncommitted changes were DISCARDED`);
                } catch (resetError: any) {
                  console.error(`❌ [POST-RETRY SYNC] Hard reset failed: ${resetError.message}`);
                  console.error(`   Cannot clean workspace - git operations may fail`);
                  // Continue anyway - let subsequent git commands fail if needed
                }
              }
            }
          } catch (statusError: any) {
            console.warn(`⚠️  [POST-RETRY SYNC] Could not check git status: ${statusError.message}`);
            // Continue anyway
          }

          // Get latest remote commit
          const latestRemoteCommit = safeGitExecSync(
            `git rev-parse origin/${story.branchName}`,
            { cwd: repoPath, encoding: 'utf8' }
          ).trim();

          console.log(`   Latest remote commit: ${latestRemoteCommit.substring(0, 8)}`);

          if (judgeUsingWorktree) {
            // 🔥 Judge worktree is DETACHED HEAD - we can't checkout a branch
            // Reset the detached HEAD to the latest remote commit
            safeGitExecSync(`git reset --hard ${latestRemoteCommit}`, {
              cwd: repoPath,
              encoding: 'utf8'
            });
            console.log(`✅ [POST-RETRY SYNC] Judge worktree updated (DETACHED HEAD reset)`);
          } else {
            // Fallback: normal branch checkout and pull
            safeGitExecSync(`git checkout ${story.branchName}`, { cwd: repoPath, encoding: 'utf8' });
            safeGitExecSync(`git pull origin ${story.branchName}`, {
              cwd: repoPath,
              encoding: 'utf8',
              timeout: 30000
            });
            console.log(`✅ [POST-RETRY SYNC] Main repo updated (checkout + pull)`);
          }

          // 🔥 CRITICAL: Update commitSHA in context for next Judge evaluation
          // Developer created a NEW commit during retry - Judge must evaluate the NEW code
          const newCommitSHA = safeGitExecSync('git rev-parse HEAD', {
            cwd: repoPath,
            encoding: 'utf8'
          }).trim();

          const oldCommitSHA = context.getData<string>('commitSHA');
          context.setData('commitSHA', newCommitSHA);

          console.log(`📍 [POST-RETRY SYNC] Updated commitSHA for next evaluation:`);
          console.log(`   Previous: ${oldCommitSHA || 'none'}`);
          console.log(`   Current:  ${newCommitSHA}`);
        } catch (syncError: any) {
          console.error(`❌ [POST-RETRY SYNC] Failed to sync: ${syncError.message}`);
          // 🔥 FIX: Propagate sync error - Judge cannot evaluate without updated code
          throw new Error(`POST-RETRY SYNC failed: ${syncError.message}. Judge cannot evaluate outdated code.`);
        }
      } else {
        console.warn(`⚠️  [POST-RETRY SYNC] No branch name on story - cannot sync`);
      }
    } catch (error: any) {
      console.error(`❌ [Judge] Developer retry failed: ${error.message}`);
      // 🔥 FIX: Re-throw to stop the retry loop - don't silently continue with broken state
      throw error;
    }
  }
}
