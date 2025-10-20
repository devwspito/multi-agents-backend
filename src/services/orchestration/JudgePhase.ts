import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { IStory } from '../../models/Task';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

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

  private readonly MAX_RETRIES = 1; // Disabled auto-retry to prevent infinite loops

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Judge already evaluated all stories
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const judgeEvaluations = context.task.orchestration.judge?.evaluations || [];

    // 🔥 EVENT SOURCING: Get stories from EventStore
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const stories = state.stories || [];

    if (judgeEvaluations.length === 0 || stories.length === 0) {
      return false;
    }

    // Check if all stories have approved evaluations
    const allStoriesApproved = stories.every((story: any) => {
      const evaluation = judgeEvaluations.find((e: any) => e.storyId === story.id);
      return evaluation && evaluation.status === 'approved';
    });

    if (allStoriesApproved) {
      console.log(`[SKIP] Judge already approved all stories`);
      context.setData('judgeComplete', true);
      return true;
    }

    return false;
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
      const rawStories = state.stories || [];
      // Ensure stories have proper complexity enum type
      stories = rawStories.map((s: any) => ({
        ...s,
        estimatedComplexity: s.complexity || s.estimatedComplexity || 'medium'
      })) as IStory[];
      console.log(`📋 [Judge] Batch review mode: Retrieved ${stories.length} stories from EventStore`);
    }

    if (stories.length === 0) {
      console.warn('⚠️ [Judge] No stories found to evaluate');
      return {
        success: false,
        error: 'No stories to evaluate',
      };
    }

    // Initialize judge step in task (skip in multi-team mode to avoid conflicts)
    if (!multiTeamMode) {
      if (!task.orchestration.judge) {
        task.orchestration.judge = {
          agent: 'judge',
          status: 'in_progress',
          startedAt: new Date(),
          evaluations: [],
        } as any;
      }

      task.orchestration.judge!.status = 'in_progress';
      task.orchestration.judge!.startedAt = new Date();
      await task.save();
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
        console.error(`❌ [Judge] Story "${story.title}" FAILED after ${this.MAX_RETRIES} attempts`);
      }
    }

    // === JUDGE VERDICT ===
    const allPassed = totalFailed === 0;

    // Save results (skip in multi-team mode to avoid conflicts)
    if (!multiTeamMode) {
      task.orchestration.judge!.status = allPassed ? 'completed' : 'failed';
      task.orchestration.judge!.completedAt = new Date();
      await task.save();
    }

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
  ): Promise<{ status: 'approved' | 'failed'; feedback?: string }> {

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

      // Store evaluation in task
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

      // Save evaluation (skip in multi-team mode to avoid conflicts)
      if (!multiTeamMode) {
        task.markModified('orchestration.judge.evaluations');
        await task.save();
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

        return { status: 'approved' };
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
          // 🔥 DISABLED: Automatic retry causes infinite loops
          // Developer is still working when Judge re-evaluates
          // Instead: fail immediately and let user re-run task manually
          console.log(`⚠️ [Judge] Story failed evaluation - retry disabled to prevent infinite loops`);

          // Fall through to return failed status
        }

        if (true) { // Always fail on first rejection to avoid loops
          // MAX RETRIES REACHED
          story.status = 'failed';
          story.judgeStatus = 'changes_requested';
          if (!multiTeamMode) {
            await task.save();
          }

          return {
            status: 'failed',
            feedback: `Failed after ${this.MAX_RETRIES} attempts. Last feedback: ${evaluation.feedback}`,
          };
        }
      }
    }

    return { status: 'failed', feedback: 'Max retries exceeded' };
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

    // Validate inputs with detailed logging
    console.log(`🔍 [Judge.evaluateCode] Validating inputs...`);
    console.log(`   task: ${task ? 'exists' : 'MISSING'}`);
    console.log(`   task._id: ${task?._id ? task._id : 'MISSING'}`);
    console.log(`   developer: ${developer ? 'exists' : 'MISSING'}`);
    console.log(`   developer.instanceId: ${developer?.instanceId ? developer.instanceId : 'MISSING'}`);
    console.log(`   story: ${story ? 'exists' : 'MISSING'}`);
    console.log(`   story.id: ${story?.id ? story.id : 'MISSING'}`);

    if (!task?._id) {
      throw new Error(`Invalid task object - missing _id field`);
    }
    if (!developer?.instanceId) {
      throw new Error(`Invalid developer object - missing instanceId field`);
    }

    // Get commit SHA if available
    const commitSHA = context.getData<string>('commitSHA');
    if (commitSHA) {
      console.log(`📍 [Judge] Will review EXACT commit: ${commitSHA}`);
    } else {
      console.warn(`⚠️  [Judge] No commit SHA provided - will review current HEAD`);
    }

    const prompt = this.buildJudgePrompt(task, story, developer, workspacePath, commitSHA);

    // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
    // This ensures ALL agents receive the same multimedia context
    const attachments = context.getData<any[]>('attachments') || [];

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

      console.log(`✅ [Judge] executeAgentFn completed successfully`);
      console.log(`   Output length: ${result.output?.length || 0} chars`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      const { NotificationService: NS } = await import('../NotificationService');
      NS.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n⚖️ JUDGE - FULL OUTPUT (Story: ${story.title})\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Parse judge output (expecting JSON with status and feedback)
      const parsed = this.parseJudgeOutput(result.output);

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
    task: any,
    story: any, // Using 'any' because EventStore stories have more fields than IStory model
    developer: any,
    _workspacePath: string | null,
    commitSHA?: string
  ): string {
    const techLeadInstructions = task.orchestration.techLead?.output || '';

    return `You are a Judge evaluating developer code for correctness and quality.

## Story to Evaluate:
**Title**: ${story.title}
**Description**: ${story.description}
**Developer**: ${developer.instanceId}
**Branch**: ${story.branchName || 'unknown'}
${commitSHA ? `**Commit SHA**: ${commitSHA} (EXACT commit you must review)` : ''}

## Tech Lead Instructions:
${techLeadInstructions}

## Developer Assignment:
- Developer: ${developer.instanceId}
- Files to modify: ${story.filesToModify?.join(', ') || 'Not specified'}
- Files to read: ${story.filesToRead?.join(', ') || 'Not specified'}
- Files to create: ${story.filesToCreate?.join(', ') || 'None'}

## Your Task:
Evaluate if the developer's implementation meets ALL 5 criteria:

1. ✅ **CODE EXISTS** - Actual code was written (not just documentation)
2. ✅ **CODE IS COMPLETE** - No stubs, TODOs, or placeholder functions
3. ✅ **REQUIREMENTS MET** - All story requirements implemented
4. ✅ **FOLLOWS PATTERNS** - Uses existing codebase patterns and conventions
5. ✅ **QUALITY STANDARDS** - No obvious bugs, proper error handling, tests if needed

## Instructions:
1. Use Read() to read the files that were supposed to be modified
2. Use Grep() to search for TODO, STUB, PLACEHOLDER markers
3. Verify the code implements the story requirements
4. Check code quality and patterns

## Output Format (JSON):
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

**CRITICAL**: If ANY criterion fails, status MUST be "changes_requested" with specific feedback.`;
  }

  /**
   * Parse Judge agent output
   */
  private parseJudgeOutput(output: string): { status: string; feedback: string } {
    try {
      // Try to extract JSON from output
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          status: parsed.status,
          feedback: parsed.feedback || 'No feedback provided',
        };
      }
    } catch (error) {
      console.warn(`⚠️  Failed to parse Judge output as JSON, using fallback`);
    }

    // Fallback: analyze output text
    const approved = output.toLowerCase().includes('approved') && !output.toLowerCase().includes('changes_requested');

    return {
      status: approved ? 'approved' : 'changes_requested',
      feedback: output,
    };
  }

  /**
   * Retry developer work with Judge feedback
   * NOTE: Currently unused - Judge feedback is handled by DevelopersPhase
   */
  // @ts-expect-error - Method reserved for future use
  private async _retryDeveloperWork(
    _task: any,
    _developer: any,
    _story: any,
    _context: OrchestrationContext,
    _judgeFeedback: string
  ): Promise<void> {
    // This method is reserved for future use when retry mechanism is implemented
    // Currently, developer feedback is provided through NotificationService
  }
}
