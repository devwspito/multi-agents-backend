import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { GitHubService } from '../GitHubService';
import { PRManagementService } from '../github/PRManagementService';
import { LogService } from '../logging/LogService';
import { HookService } from '../HookService';
import path from 'path';

/**
 * Optimized QA Engineer Phase following Anthropic best practices
 *
 * Key improvements:
 * - Minimal context (reduced from 600+ to <100 lines)
 * - Structured JSON output
 * - Parallel execution where possible
 * - Clear decision criteria
 * - Fast fail on critical errors
 */
export class QAPhaseOptimized extends BasePhase {
  readonly name = 'QA';
  readonly description = 'Efficient quality validation and PR creation';

  constructor(
    private executeAgentFn: Function,
    private githubService: GitHubService,
    private prManagementService: PRManagementService,
    private workspaceDir: string
  ) {
    super();
  }

  /**
   * Skip logic remains the same for compatibility
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const qaAttempt = context.getData<number>('qaAttempt') || 1;
    const isRetryAfterFixer = qaAttempt === 2;
    const isContinuation = context.task.orchestration.continuations?.length > 0;

    if (isContinuation || isRetryAfterFixer) {
      return false; // Don't skip
    }

    // Skip if already completed (recovery mode)
    if (context.task.orchestration.qaEngineer?.status === 'completed') {
      console.log(`[SKIP] QA already completed - recovery mode`);
      if (context.task.orchestration.qaEngineer.output) {
        context.setData('qaEngineerOutput', context.task.orchestration.qaEngineer.output);
      }
      context.setData('qaComplete', true);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const startTime = Date.now();
    const task = context.task;
    const taskId = (task._id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;

    // Initialize QA state
    this.initializeQAState(task, startTime);
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'QA Engineer');
    await LogService.agentStarted('qa-engineer', taskId, { phase: 'qa' });

    try {
      // 1. GATHER CONTEXT (minimal)
      const essentials = await this.gatherEssentialContext(context);

      // 2. RUN PRE-VALIDATION HOOKS (parallel)
      const hookResults = await this.runValidationHooks(repositories, taskId);

      // 3. MERGE BRANCHES
      const mergeResult = await this.mergeEpicBranches(
        essentials.branches,
        repositories,
        workspacePath
      );

      // 4. EXECUTE QA VALIDATION (optimized prompt)
      const qaResult = await this.executeQAValidation(
        essentials,
        mergeResult,
        hookResults,
        context
      );

      // 5. PROCESS RESULTS
      const processedResult = this.processQAResult(qaResult, context);

      // 6. HANDLE ERRORS OR CREATE PRS
      if (processedResult.hasErrors && processedResult.isFirstAttempt) {
        return this.handleQAErrors(processedResult, context, taskId);
      }

      // 7. CREATE PULL REQUESTS
      const prResults = await this.createPullRequests(
        task,
        repositories,
        workspacePath,
        essentials.branches
      );

      // 8. FINALIZE
      return this.finalizePhase(
        task,
        qaResult,
        prResults,
        essentials,
        startTime,
        context
      );

    } catch (error: any) {
      return this.handlePhaseError(task, error, taskId);
    }
  }

  /**
   * Gather only essential context for QA
   */
  private async gatherEssentialContext(context: OrchestrationContext) {
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(context.task._id as any);

    // Get epic branches
    const epics = state.epics || [];
    const contextEpicBranch = context.getData<string>('epicBranch');

    const branches = epics
      .map((epic: any) => epic.branchName || contextEpicBranch || `epic/${epic.id}`)
      .filter(Boolean) as string[];

    const { normalizeRepoName } = require('../../utils/safeGitExecution');
    return {
      branches,
      workDir: context.workspacePath || this.workspaceDir,
      repos: context.repositories.map(r => ({
        name: normalizeRepoName(r.githubRepoName.split('/').pop() || ''),
        path: context.workspacePath
          ? path.join(context.workspacePath, normalizeRepoName(r.githubRepoName.split('/').pop() || ''))
          : ''
      })),
      attachments: context.getData<any[]>('attachments') || []
    };
  }

  /**
   * Run validation hooks in parallel
   */
  private async runValidationHooks(repositories: any[], taskId: string) {
    const hooks = [];

    if (HookService.hookExists('auto-test') && repositories.length > 0) {
      hooks.push(
        HookService.executeAutoTest(repositories[0].localPath, taskId)
          .then(r => ({ type: 'test', result: r }))
      );
    }

    if (HookService.hookExists('auto-build') && repositories.length > 0) {
      hooks.push(
        HookService.executeAutoBuild(repositories[0].localPath, taskId)
          .then(r => ({ type: 'build', result: r }))
      );
    }

    return Promise.all(hooks);
  }

  /**
   * Merge epic branches locally
   */
  private async mergeEpicBranches(
    branches: string[],
    repositories: any[],
    workspacePath: string | undefined
  ) {
    if (!repositories.length || !workspacePath) {
      return { success: true, conflicts: [] };
    }

    const primaryRepo = repositories[0];
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const integrationBranch = `integration-test-${timestamp}-${randomSuffix}`;
    const primaryRepoPath = path.join(workspacePath, primaryRepo.name);

    await this.githubService.createIntegrationBranch(
      primaryRepoPath,
      primaryRepo.githubBranch || 'main',
      integrationBranch
    );

    return this.githubService.mergeMultiplePRsLocally(
      primaryRepoPath,
      branches
    );
  }

  /**
   * Execute QA validation with optimized prompt
   */
  private async executeQAValidation(
    essentials: any,
    mergeResult: any,
    hookResults: any[],
    context: OrchestrationContext
  ) {
    const taskId = (context.task._id as any).toString();

    // OPTIMIZED PROMPT (following Anthropic best practices)
    const prompt = `# QA Validation

## Context
- Working directory: ${essentials.workDir}
- Repository: ${essentials.repos[0]?.path || essentials.workDir}
- Branches merged: ${essentials.branches.length}
${!mergeResult.success ? `- ⚠️ Merge conflicts auto-resolved` : ''}

## Execute Tests (Time limits enforced)
1. Verify directory: pwd && ls -la (5s)
2. Install deps if needed: [ ! -d "node_modules" ] && npm ci || echo "Ready" (30s)
3. Run build: npm run build 2>&1 | head -100 (60s)
4. Run tests: npm test -- --watchAll=false --maxWorkers=2 2>&1 | head -200 (120s)
5. Check types: npx tsc --noEmit 2>&1 | head -50 (30s)

## Decision Criteria
APPROVE if: Build works, <30% test failures, no crashes
REJECT if: Build fails, >30% test failures, runtime crashes

## Required Output Format
\`\`\`json
{
  "decision": "GO|NO-GO",
  "build": {"status": "PASS|FAIL", "reason": "one-line"},
  "tests": {"status": "PASS|FAIL|NONE", "reason": "one-line"},
  "runtime": {"status": "PASS|FAIL", "reason": "one-line"},
  "issues": ["issue1", "issue2"],
  "recommendation": "one-sentence"
}
\`\`\`

Start immediately. Focus on functionality over style.`;

    const result = await this.executeAgentFn(
      'qa-engineer',
      prompt,
      essentials.workDir,
      taskId,
      'QA Engineer',
      undefined,
      undefined,
      essentials.attachments.length > 0 ? essentials.attachments : undefined
    );

    // Store result in task
    const task = context.task;
    task.orchestration.qaEngineer!.status = 'completed';
    task.orchestration.qaEngineer!.completedAt = new Date();
    task.orchestration.qaEngineer!.output = result.output;
    task.orchestration.qaEngineer!.sessionId = result.sessionId;
    task.orchestration.qaEngineer!.usage = result.usage;
    task.orchestration.qaEngineer!.cost_usd = result.cost;

    // Update costs
    task.orchestration.totalCost += result.cost;
    task.orchestration.totalTokens +=
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

    await task.save();

    // Emit event
    const { eventStore } = await import('../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'QACompleted',
      agentName: 'qa-engineer',
      payload: {
        output: result.output,
        epicsBranches: essentials.branches.length,
      },
      metadata: {
        cost: result.cost,
        duration: Date.now() - Date.parse(task.orchestration.qaEngineer!.startedAt as any),
      },
    });

    // Emit to console
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🧪 QA Validation Complete\n${result.output}`
    );

    return result;
  }

  /**
   * Process QA result to detect errors
   */
  private processQAResult(qaResult: any, context: OrchestrationContext) {
    const output = qaResult.output.toLowerCase();
    const qaAttempt = context.getData<number>('qaAttempt') || 1;

    // Try to parse JSON result
    let structuredResult: any = null;
    try {
      const jsonMatch = qaResult.output.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        structuredResult = JSON.parse(jsonMatch[1]);
      }
    } catch (e) {
      // Fallback to text analysis
    }

    // Detect errors from structured result or text
    const hasErrors = structuredResult
      ? structuredResult.decision === 'NO-GO'
      : this.detectErrorsFromText(output);

    const errorType = this.categorizeError(output);

    return {
      hasErrors,
      errorType,
      isFirstAttempt: qaAttempt === 1,
      structuredResult,
      rawOutput: qaResult.output
    };
  }

  /**
   * Detect errors from text output
   */
  private detectErrorsFromText(output: string): boolean {
    const errorPatterns = [
      'build failed', 'compilation error', 'test failed',
      'npm err!', 'syntaxerror', 'typeerror', 'cannot find module',
      'server failed to start', 'no-go'
    ];
    return errorPatterns.some(pattern => output.includes(pattern));
  }

  /**
   * Categorize error type
   */
  private categorizeError(output: string): string {
    if (output.includes('cannot find module') || output.includes('import')) {
      return 'IMPORT';
    }
    if (output.includes('build') || output.includes('compilation')) {
      return 'BUILD';
    }
    if (output.includes('test')) {
      return 'TEST';
    }
    if (output.includes('type') || output.includes('ts')) {
      return 'TYPE';
    }
    return 'UNKNOWN';
  }

  /**
   * Handle QA errors by preparing for Fixer
   */
  private handleQAErrors(processedResult: any, context: OrchestrationContext, taskId: string) {
    console.log(`❌ QA detected ${processedResult.errorType} errors - calling Fixer`);

    context.setData('qaErrors', processedResult.rawOutput.substring(0, 2000));
    context.setData('qaErrorType', processedResult.errorType);
    context.setData('qaAttempt', 1);

    NotificationService.emitAgentMessage(
      taskId,
      'QA Engineer',
      `⚠️ QA detected ${processedResult.errorType} errors. Calling Fixer...`
    );

    return {
      success: true,
      data: {
        qaAttempt: 1,
        hasErrors: true,
        errorType: processedResult.errorType,
      },
    };
  }

  /**
   * Create pull requests for epic branches
   */
  private async createPullRequests(
    task: any,
    repositories: any[],
    workspacePath: string | undefined,
    branches: string[]
  ) {
    const taskId = (task._id as any).toString();

    await LogService.info('Creating Pull Requests', {
      taskId,
      category: 'pr',
      phase: 'qa',
      metadata: { branchCount: branches.length },
    });

    return this.prManagementService.createEpicPRs(
      task,
      repositories,
      workspacePath
    );
  }

  /**
   * Finalize phase with results
   */
  private finalizePhase(
    task: any,
    qaResult: any,
    prResults: any[],
    essentials: any,
    startTime: number,
    context: OrchestrationContext
  ) {
    const taskId = (task._id as any).toString();
    const successfulPRs = prResults.filter((r) => r.success).length;

    NotificationService.emitAgentCompleted(
      taskId,
      'QA Engineer',
      `Tested ${essentials.branches.length} branches. Created ${successfulPRs} PRs.`
    );

    context.setData('qaComplete', true);
    context.setData('prResults', prResults);

    return {
      success: true,
      data: {
        output: qaResult.output,
        epicBranchesTested: essentials.branches.length,
        prsCreated: successfulPRs,
      },
      metrics: {
        cost_usd: qaResult.cost,
        input_tokens: qaResult.usage?.input_tokens || 0,
        output_tokens: qaResult.usage?.output_tokens || 0,
        prs_created: successfulPRs,
        branches_tested: essentials.branches.length,
        duration_ms: Date.now() - startTime,
      },
    };
  }

  /**
   * Initialize QA state in task
   */
  private initializeQAState(task: any, startTime: number) {
    if (!task.orchestration.qaEngineer) {
      task.orchestration.qaEngineer = {
        agent: 'qa-engineer',
        status: 'pending',
      } as any;
    }
    task.orchestration.qaEngineer!.status = 'in_progress';
    task.orchestration.qaEngineer!.startedAt = new Date(startTime);
  }

  /**
   * Handle phase error
   */
  private async handlePhaseError(task: any, error: any, taskId: string) {
    task.orchestration.qaEngineer!.status = 'failed';
    task.orchestration.qaEngineer!.error = error.message;
    await task.save();

    NotificationService.emitAgentFailed(taskId, 'QA Engineer', error.message);
    await LogService.agentFailed('qa-engineer', taskId, error, { phase: 'qa' });

    // Emit completion event even on error
    const { eventStore } = await import('../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'QACompleted',
      agentName: 'qa-engineer',
      payload: { error: error.message, failed: true },
      metadata: { error: error.message },
    });

    return {
      success: false,
      error: error.message,
    };
  }
}