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

  private readonly MAX_RETRIES = 3;

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

    // 🔥 EVENT SOURCING: Get stories from EventStore (same as DevelopersPhase)
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);
    const stories = state.stories || [];

    console.log(`📋 [Judge] Retrieved ${stories.length} stories from EventStore`);

    if (stories.length === 0) {
      console.warn('⚠️ [Judge] No stories found in EventStore - TechLead may not have created stories');
      return {
        success: false,
        error: 'No stories to evaluate - TechLead phase may have failed',
      };
    }

    // Initialize judge step in task
    if (!task.orchestration.judge) {
      task.orchestration.judge = {
        agent: 'judge',
        status: 'in_progress',
        startedAt: new Date(),
        evaluations: [],
      } as any;
    }

    task.orchestration.judge.status = 'in_progress';
    task.orchestration.judge.startedAt = new Date();
    await task.save();

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

    for (const story of stories) {
      console.log(`\n📋 [Judge] Evaluating story: ${story.title}`);

      const result = await this.evaluateStoryWithRetry(
        task,
        story,
        workspacePath,
        context
      );

      if (result.status === 'approved') {
        totalApproved++;
        console.log(`✅ [Judge] Story "${story.title}" APPROVED`);
      } else {
        totalFailed++;
        console.error(`❌ [Judge] Story "${story.title}" FAILED after ${this.MAX_RETRIES} attempts`);
      }
    }

    // === JUDGE VERDICT ===
    const allPassed = totalFailed === 0;

    task.orchestration.judge.status = allPassed ? 'completed' : 'failed';
    task.orchestration.judge.completedAt = new Date();
    await task.save();

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
    context: OrchestrationContext
  ): Promise<{ status: 'approved' | 'failed'; feedback?: string }> {

    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      console.log(`🔍 [Judge] Story "${story.title}" - Evaluation attempt ${attempt}/${this.MAX_RETRIES}`);

      // Get developer who worked on this story
      const developer = task.orchestration.team?.find((m: any) =>
        m.assignedStories.includes(story.id)
      );

      if (!developer) {
        console.warn(`⚠️  No developer assigned to story ${story.id}`);
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

      task.markModified('orchestration.judge.evaluations');
      await task.save();

      // === CHECK RESULT ===
      if (evaluation.status === 'approved') {
        // ✅ CODE PASSED - move to next story
        story.judgeStatus = 'approved';
        story.status = 'completed';
        await task.save();

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
        await task.save();

        NotificationService.emitAgentMessage(
          (task._id as any).toString(),
          'Judge',
          `🔄 Story **"${story.title}"** needs changes (attempt ${attempt}/${this.MAX_RETRIES}):\n\n${evaluation.feedback}`
        );

        if (attempt < this.MAX_RETRIES) {
          // RETRY: Execute developer again with feedback
          console.log(`🔄 [Judge] Requesting developer retry with feedback...`);

          const developmentPhase = new (require('./DevelopersPhase').DevelopersPhase)(
            context.getData('executeDeveloperFn')
          );

          // Execute developer for this specific story again
          await this.retryDeveloperWork(task, developer, story, context, evaluation.feedback);
        } else {
          // MAX RETRIES REACHED
          story.status = 'failed';
          story.judgeStatus = 'changes_requested';
          await task.save();

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

    const prompt = this.buildJudgePrompt(task, story, developer, workspacePath);

    // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
    // This ensures ALL agents receive the same multimedia context
    const attachments = context.getData<any[]>('attachments') || [];

    const taskId = (task._id as any).toString();
    if (attachments.length > 0) {
      console.log(`📎 [Judge] Using ${attachments.length} attachment(s) from context`);
      const { NotificationService } = await import('../NotificationService');
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `📎 Judge: Received ${attachments.length} image(s) from context for evaluation`
      );
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
    workspacePath: string | null
  ): string {
    const techLeadInstructions = task.orchestration.techLead?.output || '';

    return `You are a Judge evaluating developer code for correctness and quality.

## Story to Evaluate:
**Title**: ${story.title}
**Description**: ${story.description}

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
    const workspacePath = context.workspacePath;

    // Get executeDeveloperFn from context
    const executeDeveloperFn = context.getData<Function>('executeDeveloperFn');
    if (!executeDeveloperFn || typeof executeDeveloperFn !== 'function') {
      console.error('❌ [Judge] executeDeveloperFn not found in context or not a function');
      return;
    }

    NotificationService.emitAgentMessage(
      taskId,
      'Judge',
      `🔄 Requesting ${developer.instanceId} to retry with feedback:\n\n${judgeFeedback}`
    );

    // Execute developer again with Judge feedback
    const repositories = context.repositories;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';
    const attachments = context.getData<any[]>('attachments') || [];

    // Get EventStore state for stories and epics
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(task._id as any);

    try {
      await executeDeveloperFn(
        task,
        developer,
        repositories,
        workspacePath,
        workspaceStructure,
        attachments,
        state.stories,
        state.epics,
        judgeFeedback // Pass Judge feedback for retry
      );

      console.log(`✅ [Judge] Developer ${developer.instanceId} completed retry for story "${story.title}"`);
    } catch (error: any) {
      console.error(`❌ [Judge] Developer retry failed: ${error.message}`);
    }
  }
}
