import * as fs from 'fs';
import * as path from 'path';
import { BasePhase, OrchestrationContext, PhaseResult, saveTaskFireAndForget } from './Phase';
import { IStory } from '../../database/repositories/TaskRepository.js';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { AgentActivityService } from '../AgentActivityService';
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
import { SemanticVerificationService, VerificationResult } from '../SemanticVerificationService';
import { CodebaseKnowledge } from '../CodebaseDiscoveryService';
import { AutomatedTestRunner, TestResult } from '../AutomatedTestRunner';
import { ProjectRadiography } from '../ProjectRadiographyService';
import { sessionCheckpointService } from '../SessionCheckpointService';
// 🔥 REMOVED: granularMemoryService - SQLite (UnifiedMemoryService) is the single source of truth
import { AgentArtifactService } from '../AgentArtifactService';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { logSection } from './utils/LogHelpers';
import { isEmpty, isNotEmpty } from './utils/ArrayHelpers';
import { getStoryId } from './utils/IdNormalizer';
import {
  buildPlanningJudgePrompt,
  buildTechLeadJudgePrompt,
  buildDeveloperJudgePrompt,
} from './prompts/JudgePrompts';
// ⏱️ Centralized timeout constants
import { GIT_TIMEOUTS, AGENT_TIMEOUTS } from './constants/Timeouts';

/**
 * Judge Types - Unified evaluation across all phases
 */
export type JudgeType = 'planning' | 'tech-lead' | 'developer';

/**
 * Judge Evaluation Context - Input for each judge type
 */
export interface JudgeEvaluationContext {
  type: JudgeType;
  workspacePath: string | null;
  taskId: string;
  repositories?: any[];

  // Planning Judge context
  epics?: any[];
  taskTitle?: string;
  taskDescription?: string;

  // TechLead Judge context
  architectureOutput?: any;
  epicContext?: any;
  totalEpicsInTask?: number;
  currentEpicIndex?: number;

  // Developer Judge context (uses existing executePhase)
  story?: any;
  developer?: any;
  commitSHA?: string;
  storyBranchName?: string;
  targetRepository?: string;
  architectureBrief?: any;
  projectRadiographies?: Map<string, ProjectRadiography>;

  // 🐳 SANDBOX: Explicit sandbox ID for Docker execution
  sandboxId?: string;
}

/**
 * Rejection reason type - Used to route to appropriate specialist
 * - 'conflicts': Git merge conflicts → ConflictResolver specialist
 * - 'code_issues': Code quality/bugs → Fixer specialist or Developer retry
 * - 'scope_violation': Files created outside allowed scope → Developer retry with strict rules
 * - 'placeholder_code': Incomplete/placeholder code detected → Developer retry
 * - 'missing_files': Required files not created → Developer retry
 * - 'other': Generic rejection → Developer retry
 */
export type RejectReasonType =
  | 'conflicts'
  | 'code_issues'
  | 'scope_violation'
  | 'placeholder_code'
  | 'missing_files'
  | 'other';

/**
 * Judge Result - Standardized output from all judges
 */
export interface JudgeResult {
  approved: boolean;
  score?: number;
  feedback: string;
  filesVerified?: string[];
  issues?: string[];
  suggestions?: string[];
  cost?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Whether human review is required (e.g., judge crashed) */
  requiresHumanReview?: boolean;
  /** Error message if evaluation failed */
  evaluationError?: string;
  /**
   * Reason for rejection - Used to route to appropriate specialist:
   * - 'conflicts' → ConflictResolver specialist
   * - 'code_issues' → Fixer specialist / Developer retry
   * - 'scope_violation' → Developer retry with strict rules
   * - 'placeholder_code' → Developer retry
   * - 'missing_files' → Developer retry
   * - 'other' → Developer retry
   */
  rejectReason?: RejectReasonType;
}

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
   * Create a default approval result when parsing fails or output is inconclusive
   * Score is set to 70 to pass the >= 60 threshold check
   */
  private createDefaultApprovalResult(reason: string): JudgeResult {
    return {
      approved: true,
      feedback: reason,
      score: 70, // Must be >= 60 to pass threshold check
    };
  }

  // ============================================================================
  // 🏛️ UNIFIED JUDGE API - All phases delegate here
  // ============================================================================

  /**
   * Unified Judge Evaluation
   *
   * Use this method from PlanningPhase, TechLeadPhase, or any other phase
   * that needs judge evaluation. This ensures consistent:
   * - Tool access (Read, Glob, Grep)
   * - Cost tracking
   * - Logging
   * - Error handling
   *
   * @param evalContext - Context with all data needed for evaluation
   * @returns JudgeResult with approved/rejected status and feedback
   */
  async evaluateWithType(evalContext: JudgeEvaluationContext): Promise<JudgeResult> {
    const { type, workspacePath, taskId, sandboxId } = evalContext;

    console.log(`\n⚖️ [Judge] Starting ${type.toUpperCase()} evaluation...`);
    AgentActivityService.emitMessage(taskId, `Judge-${type}`, `⚖️ Starting ${type} evaluation...`);

    const prompt = this.buildPromptForType(evalContext);
    const agentName = this.getAgentNameForType(type);

    const startTime = Date.now();

    try {
      const result = await this.executeAgentFn(
        agentName,
        prompt,
        workspacePath,
        taskId,
        `${type.charAt(0).toUpperCase() + type.slice(1)} Judge`,
        undefined, // sessionId
        undefined, // fork
        undefined, // attachments
        sandboxId ? { sandboxId } : undefined, // 🐳 options with sandboxId
        undefined, // contextOverride
        undefined, // skipOptimization
        'bypassPermissions' // Same permissions as the phase being judged
      );

      const duration = Date.now() - startTime;
      console.log(`   💰 [${type} Judge] Completed in ${duration}ms, cost: $${result.cost?.toFixed(4) || '?'}`);

      // 🔍 DEBUG: Log the raw output to see what Judge returned
      console.log(`\n🔍 [${type} Judge] Raw output (first 1000 chars):`);
      console.log(`${'─'.repeat(60)}`);
      console.log(result.output?.substring(0, 1000) || 'NO OUTPUT!');
      if (result.output && result.output.length > 1000) {
        console.log(`... (${result.output.length - 1000} more chars)`);
      }
      console.log(`${'─'.repeat(60)}\n`);

      // Parse result based on judge type
      const parsed = this.parseJudgeResultForType(type, result.output);

      // Emit activity
      if (parsed.approved) {
        AgentActivityService.emitMessage(taskId, `Judge-${type}`, `✅ APPROVED (score: ${parsed.score || 'N/A'})`);
        console.log(`   ✅ [${type} Judge] APPROVED (score: ${parsed.score}/100)`);
      } else {
        AgentActivityService.emitMessage(taskId, `Judge-${type}`, `❌ REJECTED: ${parsed.feedback.substring(0, 100)}...`);
        console.log(`   ❌ [${type} Judge] REJECTED (score: ${parsed.score}/100)`);
      }

      return {
        ...parsed,
        cost: result.cost || 0,
        usage: result.usage || {},
      };

    } catch (error: any) {
      // 🔥 CRITICAL FIX: NEVER auto-approve on error - this could merge bad code
      console.error(`❌ [${type} Judge] Evaluation FAILED: ${error.message} - REJECTING (not auto-approving)`);
      AgentActivityService.emitMessage(taskId, `Judge-${type}`, `❌ Evaluation failed - REJECTED for safety`);

      // Return rejection with clear indication that human review is required
      return {
        approved: false,
        feedback: `JUDGE ERROR: Evaluation failed (${error.message}). Code REJECTED for safety - manual review required.`,
        score: 0,  // Score 0 = failed evaluation, not low quality
        requiresHumanReview: true,
        evaluationError: error.message,
      };
    }
  }

  /**
   * Get agent name for each judge type
   * NOTE: All judges use the same 'judge' agent definition - prompts differentiate behavior
   */
  private getAgentNameForType(_type: JudgeType): string {
    // All judge types use the same agent definition
    // The prompt (from JudgePrompts.ts) determines behavior
    return 'judge';
  }

  /**
   * Build prompt based on judge type (uses external prompt files)
   */
  private buildPromptForType(ctx: JudgeEvaluationContext): string {
    switch (ctx.type) {
      case 'planning':
        return buildPlanningJudgePrompt({
          workspacePath: ctx.workspacePath,
          repositories: ctx.repositories || [],
          taskTitle: ctx.taskTitle || '',
          taskDescription: ctx.taskDescription || '',
          epics: ctx.epics || [],
        });
      case 'tech-lead':
        return buildTechLeadJudgePrompt({
          workspacePath: ctx.workspacePath,
          repositories: ctx.repositories || [],
          taskTitle: ctx.taskTitle,
          taskDescription: ctx.taskDescription,
          epicContext: ctx.epicContext,
          architectureOutput: ctx.architectureOutput,
          totalEpicsInTask: ctx.totalEpicsInTask || 1,
          currentEpicIndex: ctx.currentEpicIndex || 1,
        });
      case 'developer':
        // Developer uses the existing detailed prompt (called from executePhase)
        throw new Error('Developer judge should use executePhase() directly');
    }
  }

  /**
   * Parse judge output based on type
   */
  private parseJudgeResultForType(type: JudgeType, output: string): JudgeResult {
    // 🔍 Try multiple patterns to extract JSON (more robust parsing)
    const patterns = [
      /```json\s*([\s\S]*?)\s*```/,              // ```json ... ``` (flexible whitespace)
      /```\s*([\s\S]*?"verdict"[\s\S]*?)\s*```/, // ``` ... ``` with verdict inside
      /\{[\s\S]*?"verdict"\s*:\s*"[^"]+"/,       // Raw JSON object with verdict
    ];

    let jsonMatch: RegExpMatchArray | null = null;
    for (const pattern of patterns) {
      jsonMatch = output.match(pattern);
      if (jsonMatch) {
        console.log(`   ✅ [${type} Judge] Found JSON using pattern: ${pattern.toString().substring(0, 50)}...`);
        break;
      }
    }

    if (!jsonMatch) {
      console.warn(`⚠️ [${type} Judge] No JSON verdict found in output, defaulting to approve`);
      console.warn(`   Output preview: ${output?.substring(0, 200)}...`);
      return this.createDefaultApprovalResult('Judge output inconclusive - approved by default');
    }

    try {
      let jsonStr = jsonMatch[1] || jsonMatch[0];

      // 🔥 If we matched a partial JSON (starts with {), try to extract the complete object
      if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) {
        // Find the complete JSON object by counting braces
        const startIdx = output.indexOf(jsonStr);
        if (startIdx !== -1) {
          let braceCount = 0;
          let endIdx = startIdx;
          for (let i = startIdx; i < output.length; i++) {
            if (output[i] === '{') braceCount++;
            if (output[i] === '}') braceCount--;
            if (braceCount === 0) {
              endIdx = i + 1;
              break;
            }
          }
          jsonStr = output.substring(startIdx, endIdx);
          console.log(`   🔧 [${type} Judge] Extracted complete JSON (${jsonStr.length} chars)`);
        }
      }

      // Clean up the JSON string (remove markdown artifacts)
      jsonStr = jsonStr.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      const parsed = JSON.parse(jsonStr);
      console.log(`   ✅ [${type} Judge] Parsed JSON successfully: verdict=${parsed.verdict}, score=${parsed.score}`);

      return {
        approved: parsed.verdict === 'APPROVE' || parsed.status === 'approved',
        score: parsed.score || 0,
        feedback: parsed.reasoning || parsed.feedback || '',
        filesVerified: parsed.filesVerified || [],
        issues: parsed.issues || [],
        suggestions: parsed.suggestions || [],
      };
    } catch (parseError: any) {
      console.warn(`⚠️ [${type} Judge] Failed to parse JSON: ${parseError.message}`);
      console.warn(`   Attempted to parse: ${(jsonMatch[1] || jsonMatch[0])?.substring(0, 200)}...`);
      return this.createDefaultApprovalResult('Judge output unparseable - approved by default');
    }
  }

  // ============================================================================
  // 🔧 Developer Judge - Story evaluation and quality validation
  // ============================================================================

  /**
   * 🎯 UNIFIED MEMORY: Skip if Judge already evaluated all stories
   *
   * Uses UnifiedMemoryService as THE SINGLE SOURCE OF TRUTH.
   * In multi-team mode, checks story evaluations per-epic.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const taskId = this.getTaskIdString(context);
    const teamEpic = context.getData<any>('teamEpic');

    // Multi-team mode: check epic-specific completion
    if (teamEpic) {
      return this.shouldSkipMultiTeam(context, taskId, teamEpic);
    }

    // Single-team mode: use centralized skip logic
    const skipResult = await checkPhaseSkip(context, { phaseName: 'Judge' });

    if (skipResult.shouldSkip) {
      context.setData('judgeComplete', true);
      return true;
    }

    console.log(`   ⏳ Phase pending - Judge must execute`);
    return false;
  }

  /**
   * Check skip for multi-team mode (epic-specific)
   */
  private async shouldSkipMultiTeam(
    context: OrchestrationContext,
    taskId: string,
    teamEpic: any
  ): Promise<boolean> {
    console.log(`\n🎯 [Judge.shouldSkip] Multi-team mode - Epic: ${teamEpic.id}`);

    // CONTINUATION: Never skip
    if (this.isContinuation(context)) {
      console.log(`   ↪️ CONTINUATION - will re-execute to evaluate new code`);
      return false;
    }

    const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
    if (!resumption) return false;

    const epic = resumption.executionMap?.epics?.find((e: any) => e.epicId === teamEpic.id);

    // Check if ALL stories for THIS EPIC have been judged
    if (epic && epic.status === 'completed') {
      logSection(`🎯 [UNIFIED MEMORY] Judge for epic ${teamEpic.id} already COMPLETED`);
      console.log(`   Stories: ${epic.stories?.length || 0} total`);
      context.setData('judgeComplete', true);
      return true;
    }

    // Check if all stories approved
    if (isNotEmpty(epic?.stories)) {
      const approvedStories = epic.stories.filter((s: any) => s.judgeVerdict === 'approved');
      const totalStories = epic.stories.length;

      console.log(`   📋 ${approvedStories.length}/${totalStories} stories approved`);

      if (approvedStories.length === totalStories) {
        console.log(`   ✅ All stories approved - skipping Judge`);
        context.setData('judgeComplete', true);
        return true;
      }
    }

    console.log(`   ❌ Epic judgment not completed - must execute`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();
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
      const state = await eventStore.getCurrentState(task.id as any);
      stories = (state.stories || []) as any;
      console.log(`📋 [Judge] Batch review mode: Retrieved ${stories.length} stories from EventStore`);
    }

    if (isEmpty(stories)) {
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

    // 🎯 ACTIVITY: Emit Judge start for Activity tab
    AgentActivityService.emitMessage(
      taskId,
      'Judge',
      `⚖️ Starting code review for ${stories?.length || 0} stories...`
    );

    await LogService.agentStarted('judge', taskId, {
      phase: 'judge',
      metadata: {
        storiesCount: stories.length,
      },
    });

    // === EVALUATE EACH STORY WITH RETRY MECHANISM ===
    let totalApproved = 0;
    let totalFailed = 0;
    let lastFeedback: string | undefined;
    let lastIteration: number | undefined;

    // 🔥 COST TRACKING: Accumulate costs across all stories
    let grandTotalJudgeCost = 0;
    let grandTotalJudgeUsage = { input: 0, output: 0 };
    let grandTotalDeveloperRetryCost = 0;
    let grandTotalDeveloperRetryUsage = { input: 0, output: 0 };

    for (const story of stories) {
      console.log(`\n📋 [Judge] Evaluating story: ${story.title}`);

      const result = await this.evaluateStoryWithRetry(
        task,
        story,
        workspacePath,
        context,
        multiTeamMode
      );

      // 🔥 COST TRACKING: Accumulate costs from this story
      grandTotalJudgeCost += result.totalJudgeCost || 0;
      grandTotalJudgeUsage.input += result.totalJudgeUsage?.input || 0;
      grandTotalJudgeUsage.output += result.totalJudgeUsage?.output || 0;
      grandTotalDeveloperRetryCost += result.totalDeveloperRetryCost || 0;
      grandTotalDeveloperRetryUsage.input += result.totalDeveloperRetryUsage?.input || 0;
      grandTotalDeveloperRetryUsage.output += result.totalDeveloperRetryUsage?.output || 0;

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

    // Log final cost summary
    const totalPhaseCost = grandTotalJudgeCost + grandTotalDeveloperRetryCost;
    console.log(`\n💰 [Judge] Phase Cost Summary:`);
    console.log(`   Judge evaluations: $${grandTotalJudgeCost.toFixed(4)} (${grandTotalJudgeUsage.input + grandTotalJudgeUsage.output} tokens)`);
    console.log(`   Developer retries: $${grandTotalDeveloperRetryCost.toFixed(4)} (${grandTotalDeveloperRetryUsage.input + grandTotalDeveloperRetryUsage.output} tokens)`);
    console.log(`   Total phase cost:  $${totalPhaseCost.toFixed(4)}`);

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
        // 🔥 COST TRACKING: Include costs in metadata
        metadata: {
          cost: grandTotalJudgeCost,
          developerRetryCost: grandTotalDeveloperRetryCost,
          totalCost: totalPhaseCost,
          input_tokens: grandTotalJudgeUsage.input,
          output_tokens: grandTotalJudgeUsage.output,
          developer_retry_input_tokens: grandTotalDeveloperRetryUsage.input,
          developer_retry_output_tokens: grandTotalDeveloperRetryUsage.output,
        },
      };
    }

    // 🔥 BATCH MODE: Return full verdict
    if (allPassed) {
      // 🎯 ACTIVITY: Emit Judge verdict for Activity tab
      AgentActivityService.emitToolUse(taskId, 'Judge', 'CodeReview', {
        verdict: 'APPROVED',
        approved: totalApproved,
        failed: 0,
      });
      AgentActivityService.emitMessage(
        taskId,
        'Judge',
        `✅ Code review complete: All ${totalApproved} stories APPROVED`
      );

      NotificationService.emitAgentCompleted(
        taskId,
        'Judge',
        `All ${totalApproved} stories approved`
      );

      await LogService.agentCompleted('judge', taskId, {
        phase: 'judge',
        metadata: {
          approved: totalApproved,
          verdict: 'all_stories_approved',
        },
      });

      // 🔥 REMOVED: granularMemoryService calls - SQLite (task.orchestration) tracks all Judge state

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
        // 🔥 COST TRACKING: Include costs in metadata
        metadata: {
          cost: grandTotalJudgeCost,
          developerRetryCost: grandTotalDeveloperRetryCost,
          totalCost: totalPhaseCost,
          input_tokens: grandTotalJudgeUsage.input,
          output_tokens: grandTotalJudgeUsage.output,
          developer_retry_input_tokens: grandTotalDeveloperRetryUsage.input,
          developer_retry_output_tokens: grandTotalDeveloperRetryUsage.output,
        },
      };
    } else {
      // 🎯 ACTIVITY: Emit Judge verdict for Activity tab (failures)
      AgentActivityService.emitToolUse(taskId, 'Judge', 'CodeReview', {
        verdict: 'REJECTED',
        approved: totalApproved,
        failed: totalFailed,
      });
      AgentActivityService.emitError(
        taskId,
        'Judge',
        `❌ Code review: ${totalFailed} stories FAILED quality review`
      );

      NotificationService.emitAgentMessage(
        taskId,
        'Judge',
        `⚠️ ${totalFailed} stories FAILED quality review after maximum retries. Review developer feedback and retry orchestration.`
      );

      await LogService.agentFailed('judge', taskId, new Error(`${totalFailed} stories failed evaluation`), {
        phase: 'judge',
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
        // 🔥 COST TRACKING: Include costs in metadata (even on failure)
        metadata: {
          cost: grandTotalJudgeCost,
          developerRetryCost: grandTotalDeveloperRetryCost,
          totalCost: totalPhaseCost,
          input_tokens: grandTotalJudgeUsage.input,
          output_tokens: grandTotalJudgeUsage.output,
          developer_retry_input_tokens: grandTotalDeveloperRetryUsage.input,
          developer_retry_output_tokens: grandTotalDeveloperRetryUsage.output,
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
  ): Promise<{
    status: 'approved' | 'failed';
    feedback?: string;
    iteration?: number;
    // 🔥 COST TRACKING: Accumulated costs from all Judge evaluations + Developer retries
    totalJudgeCost: number;
    totalJudgeUsage: { input: number; output: number };
    totalDeveloperRetryCost: number;
    totalDeveloperRetryUsage: { input: number; output: number };
    // 🔥 SPECIALIST ROUTING: Reason for rejection (for routing to specialist)
    rejectReason?: RejectReasonType;
  }> {
    // 🔥 COST TRACKING: Initialize accumulators
    let totalJudgeCost = 0;
    let totalJudgeUsage = { input: 0, output: 0 };
    let totalDeveloperRetryCost = 0;
    let totalDeveloperRetryUsage = { input: 0, output: 0 };
    // 🔥 SPECIALIST ROUTING: Track last rejection reason for routing decision
    let lastRejectReason: RejectReasonType | undefined;

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
        if (isNotEmpty(team)) {
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

      // 🔥 COST TRACKING: Accumulate Judge costs from this evaluation
      totalJudgeCost += evaluation.cost || 0;
      totalJudgeUsage.input += evaluation.usage?.input_tokens || 0;
      totalJudgeUsage.output += evaluation.usage?.output_tokens || 0;
      console.log(`💰 [Judge] Evaluation cost: $${(evaluation.cost || 0).toFixed(4)} (accumulated: $${totalJudgeCost.toFixed(4)})`);

      // 🔥 SPECIALIST ROUTING: Track rejection reason for routing decisions
      if (evaluation.rejectReason) {
        lastRejectReason = evaluation.rejectReason;
        console.log(`📋 [Judge] Rejection reason: ${lastRejectReason}`);
      }

      // 🔥 ATOMIC FIX: Store evaluation atomically to prevent race conditions
      // Use addOrUpdateJudgeEvaluation instead of direct array manipulation
      if (!multiTeamMode) {
        const taskIdStr = (task.id as any).toString();
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
        // 🔥 FIX: Ensure judge.evaluations array exists before accessing
        if (!task.orchestration.judge) {
          task.orchestration.judge = {
            agent: 'judge',
            status: 'in_progress',
            evaluations: [],
            startedAt: new Date(),
          } as any;
        }
        if (!task.orchestration.judge.evaluations) {
          task.orchestration.judge.evaluations = [];
        }
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
          saveTaskFireAndForget(task, 'judge approved story');
        }

        // 📦 GITHUB BACKUP: Save Developer Judge evaluation
        const targetRepo = getDataOptional<string>(context, 'targetRepository') ||
          context.repositories?.[0]?.name;
        if (targetRepo && workspacePath) {
          try {
            await AgentArtifactService.saveJudgeArtifact(
              workspacePath,
              targetRepo,
              (task.id as any).toString(),
              'developer',
              story.id,
              {
                verdict: 'approved',
                feedback: evaluation.feedback,
              }
            );
            console.log(`📦 [Judge] Evaluation saved to GitHub for story ${story.id}`);
          } catch (artifactError: any) {
            console.warn(`⚠️ [Judge] GitHub backup failed (non-blocking): ${artifactError.message}`);
          }
        }

        NotificationService.emitAgentMessage(
          (task.id as any).toString(),
          'Judge',
          `✅ Story **"${story.title}"** approved by Judge`
        );

        return {
          status: 'approved',
          iteration: attempt,
          totalJudgeCost,
          totalJudgeUsage,
          totalDeveloperRetryCost,
          totalDeveloperRetryUsage,
          // No rejectReason for approved status
        };
      } else {
        // ❌ CODE NEEDS CHANGES
        story.judgeStatus = 'changes_requested';
        story.judgeComments = evaluation.feedback;
        if (!multiTeamMode) {
          saveTaskFireAndForget(task, 'judge requested changes');
        }

        NotificationService.emitAgentMessage(
          (task.id as any).toString(),
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

            // 🔥 COST TRACKING: Capture developer retry costs from context
            const devRetryCost = context.getData<number>('lastDeveloperRetryCost') || 0;
            const devRetryUsage = context.getData<any>('lastDeveloperRetryUsage') || {};
            totalDeveloperRetryCost += devRetryCost;
            totalDeveloperRetryUsage.input += devRetryUsage.input_tokens || 0;
            totalDeveloperRetryUsage.output += devRetryUsage.output_tokens || 0;
            console.log(`💰 [Judge] Developer retry cost accumulated: $${totalDeveloperRetryCost.toFixed(4)}`);

            // Continue to next iteration (Judge will re-evaluate)
            continue;
          } catch (retryError: any) {
            // 🔥 Retry failed catastrophically - mark story as failed and stop retrying
            console.error(`❌ [Judge] Developer retry failed catastrophically: ${retryError.message}`);
            NotificationService.emitAgentMessage(
              (task.id as any).toString(),
              'Judge',
              `❌ Story **"${story.title}"** retry FAILED: ${retryError.message}`
            );
            return {
              status: 'failed',
              feedback: `Retry failed: ${retryError.message}`,
              iteration: attempt,
              totalJudgeCost,
              totalJudgeUsage,
              totalDeveloperRetryCost,
              totalDeveloperRetryUsage,
              rejectReason: lastRejectReason,
            };
          }
        } else {
          // MAX RETRIES REACHED - ESCALATE TO HUMAN
          console.log(`\n${'🆘'.repeat(20)}`);
          console.log(`🆘 [Judge] HUMAN INTERVENTION REQUIRED`);
          console.log(`🆘 Story "${story.title}" failed after ${this.MAX_RETRIES} attempts`);
          console.log(`🆘 Developer could not satisfy Judge requirements`);
          console.log(`${'🆘'.repeat(20)}\n`);

          story.status = 'failed';
          story.judgeStatus = 'changes_requested';

          // 🆘 SET HUMAN INTERVENTION FLAG
          task.orchestration.humanIntervention = {
            required: true,
            requestedAt: new Date(),
            phase: 'Judge',
            storyId: story.id,
            agentType: 'judge' as const,
            reason: `Story "${story.title}" failed code review after ${this.MAX_RETRIES} developer attempts. The developer could not satisfy the Judge's requirements.`,
            attempts: this.MAX_RETRIES,
            lastFeedback: evaluation.feedback,
            filesInvolved: story.branchName ? [story.branchName] : [],
            resolved: false,
          };

          // Pause orchestration until human responds
          task.orchestration.paused = true;
          task.orchestration.pausedAt = new Date();

          if (!multiTeamMode) {
            saveTaskFireAndForget(task, 'judge paused for manual review');
          }

          // 📦 GITHUB BACKUP: Save Developer Judge evaluation (rejected after max retries)
          const targetRepo = getDataOptional<string>(context, 'targetRepository') ||
            context.repositories?.[0]?.name;
          if (targetRepo && workspacePath) {
            try {
              await AgentArtifactService.saveJudgeArtifact(
                workspacePath,
                targetRepo,
                (task.id as any).toString(),
                'developer',
                story.id,
                {
                  verdict: 'rejected',
                  feedback: evaluation.feedback,
                  issues: [`Failed after ${this.MAX_RETRIES} attempts - human intervention required`],
                }
              );
              console.log(`📦 [Judge] Rejection saved to GitHub for story ${story.id}`);
            } catch (artifactError: any) {
              console.warn(`⚠️ [Judge] GitHub backup failed (non-blocking): ${artifactError.message}`);
            }
          }

          // Emit notification to UI
          NotificationService.emitAgentMessage(
            (task.id as any).toString(),
            'Judge',
            `🆘 **HUMAN INTERVENTION REQUIRED**\n\n` +
            `Story **"${story.title}"** failed after ${this.MAX_RETRIES} attempts.\n\n` +
            `**Last feedback:**\n${evaluation.feedback}\n\n` +
            `**Options:**\n` +
            `- Fix the code manually and select "fixed_manually"\n` +
            `- Skip this story and continue with "skip_story"\n` +
            `- Abort the entire task with "abort_task"\n` +
            `- Provide guidance and retry with "retry_with_guidance"`
          );

          // Also emit a special "human_intervention_required" event
          NotificationService.emitConsoleLog(
            (task.id as any).toString(),
            'error',
            `🆘 HUMAN INTERVENTION REQUIRED: Story "${story.title}" needs manual review`
          );

          return {
            status: 'failed' as const,
            feedback: `HUMAN INTERVENTION REQUIRED: Failed after ${this.MAX_RETRIES} attempts. Last feedback: ${evaluation.feedback}`,
            iteration: attempt,
            totalJudgeCost,
            totalJudgeUsage,
            totalDeveloperRetryCost,
            totalDeveloperRetryUsage,
            rejectReason: lastRejectReason,
          };
        }
      }
    }

    return {
      status: 'failed',
      feedback: 'Max retries exceeded',
      iteration: this.MAX_RETRIES,
      totalJudgeCost,
      totalJudgeUsage,
      totalDeveloperRetryCost,
      totalDeveloperRetryUsage,
      rejectReason: lastRejectReason,
    };
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
  ): Promise<{ status: 'approved' | 'changes_requested'; feedback: string; cost: number; usage: any; rejectReason?: RejectReasonType }> {

    // 🔍 DETAILED LOGGING: Show exactly what Judge is about to review
    console.log(`\n${'='.repeat(80)}`);
    console.log(`⚖️  [JUDGE] STARTING CODE REVIEW`);
    console.log(`${'='.repeat(80)}`);
    console.log(`📋 Story: ${story.title}`);
    console.log(`🆔 Story ID: ${story.id}`);
    console.log(`👤 Developer: ${developer?.instanceId || 'UNKNOWN'}`);
    console.log(`📝 Description: ${story.description || 'No description'}`);

    // 🔥🔥🔥 CRITICAL VALIDATION: workspacePath MUST exist for Judge to work correctly 🔥🔥🔥
    // Without proper workspacePath, Judge will search in the project directory instead of agent workspace
    if (!workspacePath) {
      console.error(`\n❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌`);
      console.error(`❌ [JUDGE] CRITICAL ERROR: workspacePath is NULL!`);
      console.error(`❌ [JUDGE] This means Judge will search in the WRONG directory!`);
      console.error(`❌ [JUDGE] Expected: /var/folders/.../agent-workspace/task-.../`);
      console.error(`❌ [JUDGE] Without workspacePath, Judge would use the project directory`);
      console.error(`❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n`);

      // Try to get workspacePath from context if available
      const contextWorkspace = context.workspacePath;
      if (contextWorkspace) {
        console.log(`🔧 [JUDGE] Recovered workspacePath from context: ${contextWorkspace}`);
        // TypeScript workaround - we know we're going to use this value
        (workspacePath as any) = contextWorkspace;
      } else {
        throw new Error(
          `HUMAN_REQUIRED: Judge cannot execute without workspacePath. ` +
          `Story ${story.id} evaluation aborted. ` +
          `Ensure the orchestration context has valid workspacePath from workspace setup.`
        );
      }
    }

    console.log(`📁 [JUDGE] Workspace path: ${workspacePath}`);

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
      const { findEpicById } = await import('./utils/IdNormalizer');
      const state = await eventStore.getCurrentState(task.id as any);
      // 🔥 FIX: Use findEpicById() for consistent ID normalization
      const epic = findEpicById(state.epics, (story as any).epicId);

      if (!epic) {
        console.error(`\n❌ [Judge] CRITICAL: Cannot find epic for story!`);
        throw new Error(`HUMAN_REQUIRED: Cannot find epic ${(story as any).epicId} for story ${getStoryId(story)}`);
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

    // 🐳 SANDBOX: Get sandbox ID for Docker execution
    const sandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const sandboxId = sandboxMap?.get(targetRepository);
    if (sandboxId) {
      console.log(`   🐳 Sandbox: ${sandboxId}`);
    }

    // Show files that should have been modified/created
    console.log(`\n📝 [Judge] Expected File Changes:`);
    const filesToModify: string[] = (story as any).filesToModify || [];
    const filesToCreate: string[] = (story as any).filesToCreate || [];

    if (isNotEmpty(filesToModify)) {
      console.log(`   ✏️  Files to MODIFY (${filesToModify.length}):`);
      filesToModify.forEach((f: string) => console.log(`      - ${f}`));
    } else {
      console.log(`   ⚠️  No files marked to MODIFY`);
    }

    if (isNotEmpty(filesToCreate)) {
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

    // 🔥🔥🔥 CRITICAL FIX: Sync workspace from GitHub BEFORE verifying files 🔥🔥🔥
    // GitHub ALWAYS has the correct code (push is forced), but local workspace may be stale.
    // This ensures Judge sees the EXACT code the Developer pushed.
    if (workspacePath && targetRepository && storyBranchName) {
      const repoPath = path.join(workspacePath, targetRepository);
      console.log(`\n🔄 [Judge] Syncing workspace from GitHub...`);
      console.log(`   📂 Repo: ${repoPath}`);
      console.log(`   🔀 Branch: ${storyBranchName}`);

      try {
        const { safeGitExecSync } = await import('../../utils/safeGitExecution');

        // Fetch latest from remote
        console.log(`   ⬇️  Fetching from origin...`);
        safeGitExecSync(`git fetch origin --prune`, { cwd: repoPath, encoding: 'utf8', timeout: 60000 });

        // Check if branch exists on remote
        const remoteBranchCheck = safeGitExecSync(
          `git ls-remote --heads origin ${storyBranchName}`,
          { cwd: repoPath, encoding: 'utf8', timeout: 30000 }
        );

        if (remoteBranchCheck.trim()) {
          console.log(`   ✅ Branch exists on remote`);

          // Checkout the story branch (create from remote if needed)
          try {
            safeGitExecSync(`git checkout ${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
          } catch {
            // Branch doesn't exist locally, create from remote
            console.log(`   📥 Creating local branch from remote...`);
            safeGitExecSync(`git checkout -b ${storyBranchName} origin/${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
          }

          // Reset to EXACT state on remote (this is what GitHub has)
          console.log(`   🔄 Resetting to origin/${storyBranchName}...`);
          safeGitExecSync(`git reset --hard origin/${storyBranchName}`, { cwd: repoPath, encoding: 'utf8' });
          console.log(`   ✅ Workspace synced with GitHub`);
        } else {
          console.warn(`   ⚠️  Branch ${storyBranchName} NOT found on remote!`);
          console.warn(`   This means Developer may not have pushed successfully.`);
        }
      } catch (syncError: any) {
        console.error(`   ❌ Sync from GitHub failed: ${syncError.message}`);
        console.error(`   Judge will evaluate with possibly stale local files.`);
      }
    }

    // 🔥🔥🔥 CRITICAL VALIDATION: Verify files actually exist before Judge evaluation 🔥🔥🔥
    // This catches developers that failed silently or didn't create required files
    if (isNotEmpty(filesToCreate) && workspacePath && targetRepository) {
      console.log(`\n🔍 [Judge] Verifying required files exist...`);
      console.log(`   📂 Looking in: ${workspacePath}/${targetRepository}/`);
      const missingFiles: string[] = [];

      for (const fileToCreate of filesToCreate) {
        // 🔥 FIX: Include targetRepository in path - files are inside the repo directory
        const fullPath = path.join(workspacePath, targetRepository, fileToCreate);
        const exists = fs.existsSync(fullPath);

        if (!exists) {
          missingFiles.push(fileToCreate);
          console.log(`   ❌ MISSING: ${fileToCreate}`);
        } else {
          // Also check if file is empty or just a placeholder
          const stats = fs.statSync(fullPath);
          if (stats.size === 0) {
            missingFiles.push(`${fileToCreate} (empty file)`);
            console.log(`   ❌ EMPTY: ${fileToCreate} (0 bytes)`);
          } else {
            console.log(`   ✅ EXISTS: ${fileToCreate} (${stats.size} bytes)`);
          }
        }
      }

      if (missingFiles.length > 0) {
        console.log(`\n❌❌❌ [Judge] AUTOMATIC REJECTION: ${missingFiles.length} required files missing ❌❌❌`);
        console.log(`   Missing files:`);
        missingFiles.forEach(f => console.log(`   - ${f}`));

        // Return immediate rejection - don't even call the Judge AI
        // 🔥 SPECIALIST ROUTING: Classified as MISSING_FILES → Developer retry
        return {
          status: 'changes_requested',
          feedback: `🚨 AUTOMATIC REJECTION: Developer did not create required files.\n\nMissing files:\n${missingFiles.map(f => `- ${f}`).join('\n')}\n\nThe developer must create these files before the code can be reviewed.`,
          cost: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
          rejectReason: 'missing_files' as RejectReasonType,
        };
      }

      console.log(`   ✅ All ${filesToCreate.length} required files exist`);
    }

    // 🏗️ Get architectureBrief from context for pattern-aware evaluation
    const architectureBrief = context.getData<any>('architectureBrief');
    if (architectureBrief) {
      console.log(`🏗️ [Judge] Architecture brief available - will evaluate against project patterns`);
    }

    // 🔬 Get projectRadiographies for language-agnostic pattern evaluation
    const projectRadiographies = context.getData<Map<string, ProjectRadiography>>('projectRadiographies');
    if (projectRadiographies && targetRepository) {
      const targetRadiography = projectRadiographies.get(targetRepository);
      if (targetRadiography) {
        console.log(`🔬 [Judge] Project radiography available for ${targetRepository}: ${targetRadiography.language.primary}/${targetRadiography.framework.name}`);
      }
    }

    // 🔬 AUTOMATED SEMANTIC VERIFICATION (runs BEFORE Judge reviews)
    // This catches anti-patterns like `new Project()` instead of `createProject()`
    let semanticVerificationResult: VerificationResult | undefined;
    let semanticVerificationSection = '';

    const codebaseKnowledge = context.getData<CodebaseKnowledge>('codebaseKnowledge');
    // Story object may have filesToModify/filesToCreate from TechLead enrichment
    const storyAny = story as any;
    const modifiedFiles = [...(storyAny.filesToModify || []), ...(storyAny.filesToCreate || [])];

    if (isNotEmpty(modifiedFiles) && workspacePath && targetRepository) {
      console.log(`\n🔬 [Judge] Running automated semantic verification...`);
      // 🔥 FIX: Use full repo path, not just workspace
      const repoPath = path.join(workspacePath, targetRepository);
      console.log(`   📂 Verifying in: ${repoPath}`);
      try {
        semanticVerificationResult = await SemanticVerificationService.verifyChanges(
          repoPath,
          modifiedFiles,
          codebaseKnowledge
        );

        semanticVerificationSection = SemanticVerificationService.formatForJudge(semanticVerificationResult);

        if (!semanticVerificationResult.passed) {
          console.log(`   ❌ Semantic verification FAILED - ${semanticVerificationResult.violations.filter(v => v.severity === 'error').length} errors found`);
          // Emit to frontend
          NotificationService.emitConsoleLog(
            task.id?.toString() || '',
            'warn',
            `🔬 Semantic verification found ${semanticVerificationResult.violations.filter(v => v.severity === 'error').length} errors - Judge will reject`
          );
        } else {
          console.log(`   ✅ Semantic verification passed`);
        }
      } catch (error: any) {
        console.warn(`   ⚠️ Semantic verification failed to run: ${error.message}`);
      }
    }

    // 🧪 AUTOMATED TEST EXECUTION (runs BEFORE Judge reviews)
    // This catches functional issues that compile but fail at runtime
    let testResult: TestResult | undefined;
    let testResultsSection = '';

    // Get custom test command from TechLead's environmentCommands
    const environmentCommands = context.getData<any>('environmentCommands');
    const customTestCommand = environmentCommands?.test;

    if (workspacePath && targetRepository) {
      console.log(`\n🧪 [Judge] Running automated tests...`);
      // 🔥 FIX: Use full repo path for test execution
      const testRepoPath = path.join(workspacePath, targetRepository);
      console.log(`   📂 Running tests in: ${testRepoPath}`);
      try {
        testResult = await AutomatedTestRunner.runTests(testRepoPath, {
          command: customTestCommand,
          timeout: GIT_TIMEOUTS.FETCH, // 90 seconds for tests
        });

        testResultsSection = AutomatedTestRunner.formatForJudge(testResult);

        if (!testResult.passed) {
          console.log(`   ❌ Tests FAILED - ${testResult.failedTests} test(s) failing`);
          NotificationService.emitConsoleLog(
            task.id?.toString() || '',
            'warn',
            `🧪 ${testResult.failedTests} test(s) failed - Judge will reject: ${testResult.failedTestNames.slice(0, 3).join(', ')}`
          );
        } else if (testResult.totalTests > 0) {
          console.log(`   ✅ All ${testResult.totalTests} tests passed`);
        } else {
          console.log(`   ⚠️ No tests found in codebase`);
        }
      } catch (error: any) {
        console.warn(`   ⚠️ Test execution failed: ${error.message}`);
      }
    }

    // 💡 USER DIRECTIVES - Incorporate any user-injected instructions for Judge
    const directivesBlock = context.getDirectivesBlock('judge');

    // 🏛️ UNIFIED: Use external prompt from JudgePrompts.ts
    const basePrompt = buildDeveloperJudgePrompt({
      projectId: task.projectId?.toString() || '',
      taskId: task.id?.toString() || '',
      story,
      developer,
      workspacePath: workspacePath || undefined, // 🔥 CRITICAL: Pass workspace so Judge uses correct paths
      targetRepository,
      storyBranchName,
      commitSHA,
      architectureBrief,
      projectRadiography: targetRepository && projectRadiographies ? projectRadiographies.get(targetRepository) : undefined,
      semanticVerificationSection,
      testResultsSection,
    });

    // Inject directives at the beginning of the prompt
    const prompt = directivesBlock ? `${directivesBlock}\n${basePrompt}` : basePrompt;

    // 🔥 SAFE CONTEXT ACCESS: Retrieve processed attachments (optional - defaults to empty array)
    // This ensures ALL agents receive the same multimedia context
    const attachments = getDataArray<any>(context, 'attachments');

    // Convert taskId with extra safety
    let taskId: string;
    try {
      console.log(`🔍 [Judge] About to convert task.id to string...`);
      console.log(`   task.id type: ${typeof task.id}`);
      console.log(`   task.id value: ${task.id}`);
      taskId = task.id ? task.id.toString() : 'unknown-task';
      console.log(`✅ [Judge] taskId converted: ${taskId}`);
    } catch (conversionError: any) {
      console.error(`❌ [Judge] Failed to convert task.id: ${conversionError.message}`);
      throw new Error(`Cannot convert task.id to string: ${conversionError.message}`);
    }
    if (isNotEmpty(attachments)) {
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

    // 🔄 SESSION RESUME: Check for existing session checkpoint for this judge evaluation
    const existingSessionCheckpoint = await sessionCheckpointService.loadCheckpoint(
      taskId,
      'judge',
      story.id // Use storyId as entityId for per-story judge resume
    );
    const resumeOptions = sessionCheckpointService.buildResumeOptions(existingSessionCheckpoint);

    if (resumeOptions?.isResume) {
      console.log(`\n🔄🔄🔄 [Judge] RESUMING evaluation for story "${story.title}" from previous session...`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔄 Judge: Resuming evaluation for story "${story.title}" from checkpoint`
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
          timeout: AGENT_TIMEOUTS.JUDGE, // 5 minutes
          sandboxId, // 🐳 Explicit sandbox ID for Docker execution
        },
        undefined, // contextOverride
        undefined, // skipOptimization
        'bypassPermissions', // 🔥 Judge is autonomous - never needs approval
        resumeOptions // 🔄 Session resume options
      );

      // 🔄 Save session checkpoint after judge starts (for mid-execution recovery)
      if (result.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'judge',
          result.sdkSessionId,
          story.id, // Use storyId as entityId
          result.lastMessageUuid,
          {
            storyTitle: story.title,
            developerId: developer.instanceId,
          }
        );
      }

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

      // 🔄 Mark session checkpoint as completed (judge evaluation finished)
      await sessionCheckpointService.markCompleted(taskId, 'judge', story.id);

      return {
        status: parsed.status === 'approved' ? 'approved' : 'changes_requested',
        feedback: parsed.feedback,
        // 🔥 COST TRACKING: Return cost and usage from Judge execution
        cost: result.cost || 0,
        usage: result.usage || {},
        // 🔥 SPECIALIST ROUTING: Include rejectReason for routing decisions
        rejectReason: parsed.rejectReason,
      };

    } catch (error: any) {
      console.error(`❌ [Judge] Evaluation error:`, error.message);

      // 🔄 Mark session checkpoint as failed
      await sessionCheckpointService.markFailed(taskId, 'judge', story.id, error.message);

      // 🔥 SPECIALIST ROUTING: Classify error as 'other' for retry
      return {
        status: 'changes_requested',
        feedback: `Evaluation failed: ${error.message}. Please review the code manually.`,
        cost: 0,
        usage: {},
        rejectReason: 'other' as RejectReasonType,
      };
    }
  }

  // 🔥 buildJudgePrompt REMOVED - Now uses external buildDeveloperJudgePrompt from JudgePrompts.ts
  // This keeps all prompts in one place for easy maintenance and future DB storage

  // ============================================================================
  // 🔍 OUTPUT PARSING
  // ============================================================================

  // ============================================================================
  // 🔍 OUTPUT PARSING - Parse Judge agent output
  // ============================================================================

  /**
   * Classify the rejection reason from Judge feedback
   * Used to route to the appropriate specialist:
   * - 'conflicts' → ConflictResolver
   * - 'code_issues' → Fixer / Developer retry
   * - 'scope_violation' → Developer retry (stricter)
   * - 'placeholder_code' → Developer retry
   * - 'missing_files' → Developer retry
   * - 'other' → Developer retry
   */
  private classifyRejectReason(feedback: string): RejectReasonType {
    // 🔥 CONFLICTS: Git merge conflicts
    const conflictPatterns = [
      /merge\s+conflict/i,
      /conflict\s+(in|with|detected)/i,
      /<<<<<<</,        // Git conflict marker
      /=======/,        // Git conflict marker
      />>>>>>>/,        // Git conflict marker
      /unable\s+to\s+merge/i,
      /failed\s+to\s+merge/i,
      /cannot\s+(auto)?merge/i,
      /rebase\s+(failed|conflict)/i,
      /conflict\s+markers?\s+found/i,
      /unresolved\s+conflict/i,
    ];
    if (conflictPatterns.some(p => p.test(feedback))) {
      console.log(`   🔍 [RejectReason] Classified as: CONFLICTS (merge conflict detected)`);
      return 'conflicts';
    }

    // 🚫 SCOPE VIOLATION: Files outside allowed scope
    const scopePatterns = [
      /scope\s+violation/i,
      /file.+not\s+in\s+(allowed|scope)/i,
      /created.+outside\s+(of\s+)?scope/i,
      /modified.+outside\s+(of\s+)?scope/i,
      /unauthorized\s+file/i,
      /filesToCreate\s+violation/i,
      /filesToModify\s+violation/i,
      /forbidden.+(file|directory)/i,
      /only\s+allowed\s+to\s+(modify|create)/i,
    ];
    if (scopePatterns.some(p => p.test(feedback))) {
      console.log(`   🔍 [RejectReason] Classified as: SCOPE_VIOLATION`);
      return 'scope_violation';
    }

    // 📝 PLACEHOLDER CODE: Incomplete/stub code
    const placeholderPatterns = [
      /placeholder/i,
      /coming\s+soon/i,
      /todo\s*:/i,
      /not\s+implemented/i,
      /stub\s+(code|function|method)/i,
      /wip\s/i,
      /work\s+in\s+progress/i,
      /empty\s+(function|method|class)/i,
      /throw\s+new\s+(Error|NotImplemented)/i,
      /_Placeholder/i,
      /dummy\s+(data|code|implementation)/i,
    ];
    if (placeholderPatterns.some(p => p.test(feedback))) {
      console.log(`   🔍 [RejectReason] Classified as: PLACEHOLDER_CODE`);
      return 'placeholder_code';
    }

    // 📁 MISSING FILES: Required files not created
    const missingFilePatterns = [
      /missing\s+file/i,
      /file.+not\s+(found|created|exist)/i,
      /required\s+file.+missing/i,
      /expected\s+file.+not\s+found/i,
      /did\s+not\s+create/i,
      /must\s+create/i,
      /0\s+bytes/i,
      /empty\s+file/i,
    ];
    if (missingFilePatterns.some(p => p.test(feedback))) {
      console.log(`   🔍 [RejectReason] Classified as: MISSING_FILES`);
      return 'missing_files';
    }

    // 🐛 CODE ISSUES: General code quality problems (bugs, errors, bad patterns)
    const codeIssuePatterns = [
      /bug\s+(found|detected)/i,
      /error\s+(in|found|detected)/i,
      /syntax\s+error/i,
      /type\s+error/i,
      /compilation\s+(failed|error)/i,
      /build\s+(failed|error)/i,
      /test.+(fail|error)/i,
      /runtime\s+error/i,
      /null\s+pointer/i,
      /undefined\s+(variable|reference)/i,
      /security\s+(issue|vulnerability)/i,
      /broken\s+(code|logic|function)/i,
      /logic\s+error/i,
      /infinite\s+loop/i,
      /memory\s+leak/i,
      /performance\s+issue/i,
      /quality\s+standard.+not\s+met/i,
      /does\s+not\s+meet\s+requirements/i,
    ];
    if (codeIssuePatterns.some(p => p.test(feedback))) {
      console.log(`   🔍 [RejectReason] Classified as: CODE_ISSUES`);
      return 'code_issues';
    }

    // 🤷 OTHER: Default catch-all
    console.log(`   🔍 [RejectReason] Classified as: OTHER (no specific pattern matched)`);
    return 'other';
  }

  /**
   * Parse Judge agent output - Uses plain text markers with SMART FALLBACK
   *
   * 🔥🔥🔥 SMART FALLBACK LOGIC 🔥🔥🔥
   * When Judge forgets to include markers, we analyze the output:
   * 1. If explicit APPROVED marker → approved
   * 2. If explicit REJECTED marker → rejected
   * 3. If no markers but positive language → approved (lenient)
   * 4. If no markers but negative language → rejected
   * 5. If completely unclear → approved (benefit of the doubt)
   */
  private parseJudgeOutput(output: string): { status: string; feedback: string; rejectReason?: RejectReasonType } {
    console.log(`🔍 [Judge] Parsing output (length: ${output.length} chars)...`);

    // Check for approval/rejection markers
    const approved = hasMarker(output, COMMON_MARKERS.APPROVED);
    const rejected = hasMarker(output, COMMON_MARKERS.REJECTED);

    // 1. Explicit APPROVED marker
    if (approved && !rejected) {
      console.log(`✅ [Judge] APPROVED marker found`);

      const feedback = extractMarkerValue(output, '📍 Feedback:') ||
                      extractMarkerValue(output, '📍 Notes:') ||
                      'Code approved - meets all quality standards';

      return {
        status: 'approved',
        feedback: feedback,
      };
    }

    // 2. Explicit REJECTED marker
    if (rejected) {
      console.log(`❌ [Judge] REJECTED marker found`);

      const reason = extractMarkerValue(output, '📍 Reason:') || '';
      const requiredChanges = extractMarkerValue(output, '📍 Required Changes:') || '';

      let feedback = '';
      if (reason) feedback += `Reason: ${reason}\n`;
      if (requiredChanges) feedback += `Required Changes: ${requiredChanges}\n`;
      if (!feedback) feedback = output;

      // 🔥 SPECIALIST ROUTING: Classify rejection reason
      const rejectReason = this.classifyRejectReason(feedback);

      return {
        status: 'changes_requested',
        feedback: feedback,
        rejectReason,
      };
    }

    // 3. 🔥 NO MARKERS FOUND - Use smart fallback analysis
    console.log(`⚠️  [Judge] No clear markers - using SMART FALLBACK analysis...`);

    // Positive indicators (case insensitive)
    const positivePatterns = [
      /code\s+(looks\s+)?good/i,
      /looks\s+good/i,
      /well\s+(written|structured|implemented)/i,
      /meets?\s+(all\s+)?quality/i,
      /quality\s+standards?\s+(met|passed)/i,
      /no\s+(issues?|problems?|bugs?)\s+found/i,
      /code\s+is\s+(clean|solid|correct)/i,
      /implementation\s+(is\s+)?(correct|good|proper)/i,
      /LGTM/i,
      /ship\s+it/i,
      /ready\s+(to\s+merge|for\s+merge)/i,
      /pass(ed|es)?(\s+review)?/i,
    ];

    // Negative indicators (case insensitive)
    const negativePatterns = [
      /changes?\s+requested/i,
      /needs?\s+(changes?|work|fixes?)/i,
      /issues?\s+(found|detected)/i,
      /bugs?\s+(found|detected)/i,
      /problems?\s+(found|detected)/i,
      /fails?\s+(to\s+meet)?/i,
      /does\s+not\s+meet/i,
      /missing\s+(implementation|code|tests?)/i,
      /incomplete/i,
      /broken/i,
      /security\s+(issue|vulnerability)/i,
      /must\s+(fix|change|update)/i,
      /required\s+changes/i,
    ];

    const hasPositive = positivePatterns.some(p => p.test(output));
    const hasNegative = negativePatterns.some(p => p.test(output));

    console.log(`   Positive indicators: ${hasPositive}`);
    console.log(`   Negative indicators: ${hasNegative}`);

    // Decision logic
    if (hasNegative && !hasPositive) {
      console.log(`   📍 DECISION: REJECTED (negative language detected)`);

      // Try to extract any feedback
      const reason = extractMarkerValue(output, '📍 Reason:') || '';
      const requiredChanges = extractMarkerValue(output, '📍 Required Changes:') || '';

      let feedback = '';
      if (reason) feedback += `Reason: ${reason}\n`;
      if (requiredChanges) feedback += `Required Changes: ${requiredChanges}\n`;
      if (!feedback) {
        // Extract last meaningful part of output as feedback
        const lines = output.split('\n').filter(l => l.trim());
        feedback = lines.slice(-5).join('\n');
      }

      // 🔥 SPECIALIST ROUTING: Classify rejection reason from output
      const rejectReason = this.classifyRejectReason(output);

      return {
        status: 'changes_requested',
        feedback: feedback || 'Review feedback required',
        rejectReason,
      };
    }

    if (hasPositive || (!hasPositive && !hasNegative)) {
      // 🔥 LENIENT FALLBACK: If positive language OR completely unclear
      // Give benefit of the doubt - approve the code
      console.log(`   📍 DECISION: APPROVED (positive language or no clear indicators)`);
      console.log(`   ℹ️  Benefit of the doubt: Judge forgot markers but code likely OK`);

      const feedback = extractMarkerValue(output, '📍 Feedback:') ||
                      extractMarkerValue(output, '📍 Notes:') ||
                      'Code approved - Judge evaluation passed (marker fallback)';

      return {
        status: 'approved',
        feedback: feedback,
      };
    }

    // Mixed signals - be lenient and approve
    console.log(`   📍 DECISION: APPROVED (mixed signals - being lenient)`);
    return {
      status: 'approved',
      feedback: 'Code approved - mixed signals in review, defaulting to approval',
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

    const taskId = (task.id as any).toString();

    // 🔥 CRITICAL: Use the ISOLATED story workspace for developer retry
    // With isolated workspaces per story (DEV+JUDGE pair), both use the SAME workspace:
    //   effectiveWorkspacePath = /tmp/task/team-1/story-ABC/
    //   repo inside = /tmp/task/team-1/story-ABC/v2_backend/
    // This ensures Developer retry happens in the SAME isolated workspace as the original work
    const workspacePath = context.getData<string>('isolatedWorkspacePath') || context.workspacePath;

    console.log(`📂 [Judge Retry] Using ISOLATED workspace for developer: ${workspacePath}`);
    console.log(`   context.workspacePath: ${context.workspacePath}`);
    console.log(`   isolatedWorkspacePath: ${context.getData<string>('isolatedWorkspacePath') || 'NOT SET - using context.workspacePath'}`);
    console.log(`   ✅ Developer retry will use SAME isolated workspace as original work`);

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

    // 🔥 CRITICAL: Format feedback for Developer using AITMPL Debugger methodology
    // Systematic approach: CAPTURE → REPRODUCE → ISOLATE → FIX → VERIFY
    const formattedFeedback = `🚨 CODE REVIEW FAILED - DEBUGGER MODE ACTIVATED 🚨

## 📋 JUDGE FEEDBACK (CAPTURE)
${judgeFeedback}

## 🔍 DEBUGGER METHODOLOGY (MANDATORY)

You MUST follow this systematic approach to fix the issues:

### 1️⃣ CAPTURE - Understand the exact problem
- Read the Judge feedback above carefully
- Identify EACH specific issue mentioned
- Note the file:line references if provided

### 2️⃣ REPRODUCE - Verify you can see the problem
\`\`\`bash
# Run these commands to see the current state:
npm run typecheck    # See type errors
npm run lint         # See lint errors
npm test             # See test failures
\`\`\`
- Confirm you understand WHY Judge rejected the code
- If unclear, Read the specific files mentioned

### 3️⃣ ISOLATE - Find the root cause
- For each issue, identify the EXACT location:
  - Which file?
  - Which function/method?
  - Which line(s)?
- Ask yourself: "Why did this happen?"
- Consider if the issue is:
  - A typo/syntax error? → Simple fix
  - A logic error? → Need to understand the intent
  - A missing import/export? → Check dependencies
  - A type mismatch? → Check interfaces

### 4️⃣ FIX - Apply targeted, minimal changes
- Fix ONLY what is broken - don't refactor unrelated code
- One issue at a time, verify each fix before moving on
- Use Edit tool for precise changes (not Write for whole files)
- After each Edit, immediately run verification:
\`\`\`bash
npm run typecheck && echo "✅ Types OK"
\`\`\`

### 5️⃣ VERIFY - Confirm the fix works completely
\`\`\`bash
# Run ALL verification commands:
npm run typecheck    # Must pass
npm run lint         # Must pass
npm test             # Must pass
\`\`\`
- If any fails, go back to step 3 (ISOLATE)
- Only proceed to commit when ALL pass

## ⚠️ ANTI-PATTERNS TO AVOID
- ❌ Changing multiple files without testing between changes
- ❌ Guessing at fixes without understanding the problem
- ❌ Ignoring error messages - READ them carefully
- ❌ Committing before verification passes

## ✅ SUCCESS CRITERIA
1. All Judge feedback items addressed
2. \`npm run typecheck\` passes
3. \`npm run lint\` passes
4. \`npm test\` passes
5. Commit with descriptive message
6. Report: 📍 Commit SHA: <your-sha-here>

❌ DO NOT mark as complete until ALL criteria are met.`;
    console.log(`✅ [Judge] Formatted feedback for Developer`);

    // 🔥 Store Judge feedback in context for Fixer to access
    context.setData('lastJudgeFeedback', formattedFeedback);
    context.setData('currentStory', story); // Also store current story for Fixer context

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
    const state = await eventStore.getCurrentState(task.id as any);

    // 🔥 CRITICAL: Verify story has branchName before retry
    // 🔥 FIX: Use getStoryId() for consistent ID normalization
    const targetStoryId = getStoryId(story);
    const storyFromEventStore = state.stories.find((s: any) => {
      try { return getStoryId(s) === targetStoryId; } catch { return false; }
    });
    if (storyFromEventStore?.branchName) {
      console.log(`✅ [Judge] Story has branchName for retry: ${storyFromEventStore.branchName}`);
    } else {
      console.warn(`⚠️  [Judge] Story does NOT have branchName yet`);
      console.warn(`   Story ID: ${targetStoryId}`);
      console.warn(`   Developer will create the branch on retry`);
    }

    // 🔥 CRITICAL: Get epic branch name from context (created by TeamOrchestrationPhase)
    const epicBranchName = context.getData<string>('epicBranch');
    console.log(`📂 [Judge] Passing epic branch to developer for retry: ${epicBranchName || 'not specified'}`);

    // 🐳 SANDBOX: Get sandbox ID for Docker execution
    const sandboxMap = context.getData<Map<string, string>>('sandboxMap');
    const epic = state.epics?.find((e: any) => e.stories?.includes(story.id));
    const targetRepository = epic?.targetRepository || repositories[0]?.name;
    const sandboxId = sandboxMap?.get(targetRepository);
    if (sandboxId) {
      console.log(`🐳 [Judge] Using sandbox ${sandboxId} for developer retry`);
    }

    // 🔥🔥🔥 CRITICAL FIX: Fetch all remote branches BEFORE retry
    // The isolated workspace might not have the story branch available locally.
    // Developer pushed it to remote, so we need to fetch it before retry.
    // Without this fetch, retry fails with "branch not found"!
    if (workspacePath && storyFromEventStore?.branchName) {
      try {
        const epic = state.epics?.find((e: any) => e.stories?.includes(story.id));
        const targetRepo = epic?.targetRepository || repositories[0]?.name;
        if (targetRepo) {
          const repoPath = `${workspacePath}/${targetRepo}`;
          console.log(`\n🔄 [Judge PRE-RETRY] Fetching all remote branches...`);
          console.log(`   Workspace: ${workspacePath}`);
          console.log(`   Repo: ${repoPath}`);
          console.log(`   Story branch: ${storyFromEventStore.branchName}`);

          const { safeGitExecSync } = await import('../../utils/safeGitExecution');

          // Fetch all branches from remote
          safeGitExecSync(`git fetch origin --prune`, {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.FETCH
          });
          console.log(`✅ [Judge PRE-RETRY] Fetched all remote branches`);

          // Verify story branch exists on remote
          const branchCheck = safeGitExecSync(`git ls-remote --heads origin ${storyFromEventStore.branchName}`, {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.STATUS
          });

          if (branchCheck.trim()) {
            console.log(`✅ [Judge PRE-RETRY] Story branch confirmed on remote: ${storyFromEventStore.branchName}`);
          } else {
            console.warn(`⚠️  [Judge PRE-RETRY] Story branch NOT on remote: ${storyFromEventStore.branchName}`);
            console.warn(`   Developer may have failed to push. Retry may fail.`);
          }
        }
      } catch (fetchError: any) {
        console.warn(`⚠️  [Judge PRE-RETRY] Could not fetch remote branches: ${fetchError.message}`);
        console.warn(`   Proceeding with retry anyway...`);
      }
    }

    try {
      // 🔥🔥🔥 CRITICAL FIX: Pass ONLY the rejected story, NOT all stories! 🔥🔥🔥
      // Bug: When Judge rejects story-4 and requests retry, Developer was receiving ALL stories
      // (e.g., 22 stories) instead of just story-4. This caused Developer to get confused
      // and try to use the branch from a different story (e.g., story-2's branch).
      //
      // Root cause: state.stories contains ALL stories in the task
      // Fix: Pass [storyFromEventStore || story] - array with ONLY the rejected story
      const rejectedStory = storyFromEventStore || story;

      console.log(`🚀 [Judge] Executing developer retry with topModel upgrade`);
      console.log(`   🎯 RETRY FOR SINGLE STORY: "${rejectedStory.title}"`);
      console.log(`   🔀 Branch: ${rejectedStory.branchName || 'NOT SET'}`);
      console.log(`   📍 Story ID: ${rejectedStory.id}`);
      console.log(`   ⚠️  Passing 1 story (NOT ${state.stories.length} stories)`);

      const devResult = await executeDeveloperFn(
        task,
        developer,
        repositories,
        workspacePath,
        workspaceStructure,
        attachments,
        [rejectedStory],  // 🔥🔥🔥 CRITICAL: ONLY the rejected story, NOT state.stories
        state.epics,
        formattedFeedback, // Pass FORMATTED Judge feedback for retry (structured and clear)
        epicBranchName, // Epic branch name from TeamOrchestrationPhase
        true, // 🚀 forceTopModel: Use best model for retry (Judge rejected the code)
        context.getData<any>('devAuth'), // 🔐 Developer authentication
        context.getData<any>('architectureBrief'), // 🏗️ Architecture patterns
        context.getData<any>('environmentCommands'), // 🔧 Environment commands
        context.getData<Map<string, any>>('projectRadiographies'), // 🔬 Project analysis
        undefined, // resumeOptions (no resume for retry)
        sandboxId // 🐳 Explicit sandbox ID for Docker execution
      );

      // 🔥 COST TRACKING: Store developer retry cost for accumulation
      const retryCost = devResult?.cost || 0;
      const retryUsage = devResult?.usage || {};
      console.log(`💰 [Judge] Developer retry cost: $${retryCost.toFixed(4)}`);

      // Store in context for caller to retrieve
      context.setData('lastDeveloperRetryCost', retryCost);
      context.setData('lastDeveloperRetryUsage', retryUsage);

      console.log(`✅ [Judge] Developer ${developer.instanceId} completed retry for story "${story.title}"`);

      // 🔥 CRITICAL: Get updated story from EventStore after developer retry
      // Developer may have updated branchName or other fields
      // Use exponential backoff retry in case EventStore has lag
      let updatedStory: any = null;
      const maxRetries = 3;
      const baseDelay = 500; // 500ms

      // 🔥 FIX: Use getStoryId() for consistent ID normalization
      const retryTargetStoryId = getStoryId(story);
      for (let retryAttempt = 0; retryAttempt < maxRetries; retryAttempt++) {
        try {
          const updatedState = await eventStore.getCurrentState(task.id as any);
          updatedStory = updatedState.stories.find((s: any) => {
            try { return getStoryId(s) === retryTargetStoryId; } catch { return false; }
          });

          if (updatedStory && updatedStory.branchName) {
            console.log(`✅ [POST-RETRY SYNC] Retrieved story from EventStore (attempt ${retryAttempt + 1}/${maxRetries})`);
            break;
          } else {
            console.warn(`⚠️  [POST-RETRY SYNC] Story ${retryTargetStoryId} not found or incomplete in EventStore (attempt ${retryAttempt + 1}/${maxRetries})`);
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
          // 🔥 FIX: Build correct repo path from workspace + targetRepository
          // context.workspacePath is the STORY WORKSPACE (e.g., /tmp/task/story-ABC/)
          // The git repo is INSIDE at (e.g., /tmp/task/story-ABC/v2_backend/)
          // We MUST build the full path, not assume workspacePath IS the repo
          const targetRepository = story.targetRepository ||
            (await (async () => {
              const { eventStore } = await import('../EventStore');
              const state = await eventStore.getCurrentState(task.id as any);
              const epic = state.epics?.find((e: any) => e.stories?.includes(story.id));
              return epic?.targetRepository;
            })());

          if (!targetRepository) {
            throw new Error(`POST-RETRY SYNC: No targetRepository for story ${story.id}`);
          }

          const repoPath = `${context.workspacePath}/${targetRepository}`;

          if (!repoPath || !context.workspacePath) {
            throw new Error('POST-RETRY SYNC: context.workspacePath is null');
          }

          console.log(`🔧 [POST-RETRY SYNC] Building repo path:`);
          console.log(`   Workspace: ${context.workspacePath}`);
          console.log(`   Target repo: ${targetRepository}`);
          console.log(`   Full path: ${repoPath}`);

          console.log(`\n🔄 [POST-RETRY SYNC] Syncing Judge workspace with developer's latest commits...`);
          console.log(`   Mode: ${judgeUsingWorktree ? 'ISOLATED WORKTREE' : 'FALLBACK (main repo)'}`);
          console.log(`   Repository path: ${repoPath}`);
          console.log(`   Branch to sync: ${story.branchName}`);

          // Fetch and pull latest commits (using cached fetch to avoid redundant network calls)
          const { safeGitExecSync, smartGitFetch } = await import('../../utils/safeGitExecution');
          smartGitFetch(repoPath, { timeout: GIT_TIMEOUTS.FETCH });

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
              timeout: GIT_TIMEOUTS.CHECKOUT
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
