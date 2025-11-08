import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { GitHubService } from '../GitHubService';
import { PRManagementService } from '../github/PRManagementService';
import { LogService } from '../logging/LogService';
import { HookService } from '../HookService';
import path from 'path';

/**
 * QA Engineer Phase
 *
 * Final quality gate with comprehensive testing and validation
 * - Creates integration branch
 * - Merges all epic branches locally
 * - Performs integration testing
 * - Creates Pull Requests after successful validation
 *
 * This is the FINAL GATE - nothing goes to production without QA approval
 */
export class QAPhase extends BasePhase {
  readonly name = 'QA'; // Must match PHASE_ORDER
  readonly description = 'Testing integration and creating Pull Requests';

  constructor(
    private executeAgentFn: Function,
    private githubService: GitHubService,
    private prManagementService: PRManagementService,
    private workspaceDir: string
  ) {
    super();
  }

  /**
   * Skip if QA Engineer already completed (ONLY for recovery, NOT for continuations or retry after Fixer)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    const qaAttempt = context.getData<number>('qaAttempt') || 1;
    const isRetryAfterFixer = qaAttempt === 2;

    // 🔄 CONTINUATION: Never skip - always re-execute to test new code
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [QA] This is a CONTINUATION - will re-execute to test new code`);
      return false; // DO NOT SKIP
    }

    // Don't skip if we're in retry mode after Fixer (attempt 2)
    if (isRetryAfterFixer) {
      console.log(`[QA] Retry mode after Fixer - will re-execute QA (attempt ${qaAttempt})`);
      return false;
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.qaEngineer?.status === 'completed') {
      console.log(`[SKIP] QA Engineer already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution
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
    const task = context.task;
    const taskId = (task._id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;

    // 🔥 MULTI-TEAM MODE: Detect if we're in team mode
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    if (multiTeamMode) {
      console.log(`🎯 [QA] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
    }

    await LogService.info('QA Engineer phase started - Integration testing', {
      taskId,
      category: 'orchestration',
      phase: 'qa',
    });

    // 🪝 HOOK: Execute auto-test before QA
    if (HookService.hookExists('auto-test') && repositories.length > 0) {
      console.log(`\n🪝 [QA] Running auto-test hook before QA validation...`);
      const testResult = await HookService.executeAutoTest(
        repositories[0].localPath,
        taskId
      );
      if (!testResult.success) {
        console.warn(`   ⚠️  Auto-test completed with failures`);
        // Store test results for QA agent to review
        context.setData('autoTestResult', testResult);
      }
    }

    // 🪝 HOOK: Execute auto-build to verify compilation
    if (HookService.hookExists('auto-build') && repositories.length > 0) {
      console.log(`\n🪝 [QA] Running auto-build hook to verify compilation...`);
      const buildResult = await HookService.executeAutoBuild(
        repositories[0].localPath,
        taskId
      );
      if (!buildResult.success) {
        console.warn(`   ⚠️  Auto-build failed`);
        context.setData('autoBuildResult', buildResult);
      }
    }

    // Track start time for duration calculation
    const startTime = new Date();

    // Check if this is a retry after Fixer
    const qaAttempt = context.getData<number>('qaAttempt') || 1;
    const isRetryAfterFixer = qaAttempt === 2;

    // Initialize QA Engineer state if not exists (skip in multi-team mode)
    if (!multiTeamMode) {
      if (!task.orchestration.qaEngineer) {
        task.orchestration.qaEngineer = {
          agent: 'qa-engineer',
          status: 'pending',
        } as any;
      }

      // If retry after Fixer, reset status to allow re-execution
      if (isRetryAfterFixer) {
        console.log(`🔄 [QA] Retry after Fixer - resetting QA state for re-execution`);
        task.orchestration.qaEngineer!.status = 'in_progress';
        task.orchestration.qaEngineer!.startedAt = startTime;
        // Keep previous output/error for history
        task.orchestration.qaEngineer!.previousAttempt = {
          output: task.orchestration.qaEngineer!.output,
          error: task.orchestration.qaEngineer!.error,
          completedAt: task.orchestration.qaEngineer!.completedAt
        };
      } else {
        task.orchestration.qaEngineer!.status = 'in_progress';
        task.orchestration.qaEngineer!.startedAt = startTime;
      }

      await task.save();
    }

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'QA Engineer');

    await LogService.agentStarted('qa-engineer', taskId, {
      phase: 'qa',
    });

    try {
      // 🔥 EVENT SOURCING: Get epics and their branches from EventStore
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task._id as any);
      const epics = state.epics || [];
      const stories = state.stories || [];

      console.log(`📋 [QA] Retrieved ${epics.length} epics and ${stories.length} stories from EventStore`);

      // 🔥 CRITICAL FIX: Use EPIC branches (not story branches)
      // Developers merge all stories into epic branches and push those
      // 🔥 CRITICAL: Use epic.branchName from TeamOrchestrationPhase (stored in context or EventStore)
      // Epic branches have unique timestamps (e.g., epic/358cdca9-epic-1-1761118801698-l5tvun)

      // Try to get epicBranch from context (for single-team mode)
      const contextEpicBranch = context.getData<string>('epicBranch');
      if (contextEpicBranch) {
        console.log(`📂 [QA] Found epic branch in context: ${contextEpicBranch}`);
      }

      const epicBranches = epics.map((epic: any) => {
        // Priority: 1) epic.branchName from EventStore, 2) context epicBranch, 3) fallback to constructed name
        const branch = epic.branchName || contextEpicBranch || `epic/${epic.id}`;
        console.log(`  - Epic ${epic.id}: using branch ${branch}`);
        return branch;
      }).filter(Boolean) as string[];

      // Also check if there are any recent epic branches with timestamps
      // Pattern: epic/{id}-{timestamp}-{randomSuffix}
      const epicBranchesWithTimestamps = stories
        .map((s: any) => s.epicBranch)
        .filter((branch: string) => branch && branch.startsWith('epic/'))
        .filter((branch: string, index: number, self: string[]) => self.indexOf(branch) === index); // unique

      // Combine both patterns
      const allEpicBranches = [...new Set([...epicBranches, ...epicBranchesWithTimestamps])];

      console.log(`🌿 [QA] Epic branches to test:`);
      allEpicBranches.forEach((branch: string) => {
        console.log(`  - ${branch}`);
      });
      console.log(`🌿 [QA] Total epic branches: ${allEpicBranches.length}`);

      // Use the combined epic branches for testing
      const branchesToTest = allEpicBranches;

      await LogService.info(`Testing integration of ${branchesToTest.length} epic branches`, {
        taskId,
        category: 'quality',
        phase: 'qa',
        metadata: {
          epicBranchesCount: branchesToTest.length,
          branches: branchesToTest,
        },
      });

      // Progress notification
      NotificationService.emitAgentProgress(
        taskId,
        'QA Engineer',
        `Testing integration of ${branchesToTest.length} epic branches...`
      );

      // Create integration branch in primary repo
      const primaryRepo = repositories.length > 0 ? repositories[0] : null;
      let mergeSuccess = true;
      let mergeConflicts: string[] = [];

      if (primaryRepo && workspacePath) {
        // 🔥 UNIQUE BRANCH NAMING: Use timestamp + random suffix to prevent conflicts
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const integrationBranch = `integration-test-${timestamp}-${randomSuffix}`;
        const primaryRepoPath = path.join(workspacePath, primaryRepo.name);

        await this.githubService.createIntegrationBranch(
          primaryRepoPath,
          primaryRepo.githubBranch || 'main', // Use githubBranch instead of branch
          integrationBranch
        );

        task.orchestration.qaEngineer!.integrationBranch = integrationBranch;

        // 🔥 NOTE: No need to fetch - we're working with local branches
        // The epic branches were already created and merged locally by Developers
        console.log(`🔄 [QA] Using local branches (no fetch needed)`);
        console.log(`   Epic branches are already in the local repository`);

        // Merge all epic branches locally
        const mergeResult = await this.githubService.mergeMultiplePRsLocally(
          primaryRepoPath,
          branchesToTest
        );

        if (!mergeResult.success) {
          await LogService.warn(`Conflicts detected in branches`, {
            taskId,
            category: 'git',
            phase: 'qa',
            metadata: {
              conflicts: mergeResult.conflicts,
              conflictCount: mergeResult.conflicts.length,
            },
          });
          mergeSuccess = false;
          mergeConflicts = mergeResult.conflicts;
        }
      }

      // Build repository context for QA
      const repoContext = repositories.map(repo => ({
        name: repo.githubRepoName.split('/').pop(),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? path.join(workspacePath, repo.githubRepoName.split('/').pop() || '') : ''
      }));

      // Execute QA agent
      const prompt = `# QA Engineer - Final Validation

## Task: ${task.title}

## Repos to Test (${repositories.length}):
${repoContext.map(r => `- ${r.name} at ${r.path}`).join('\n')}

## Epic Branches Merged:
${branchesToTest.map(b => `- ${b}`).join('\n')}

## 🎯 INSTRUCTIONS (Be thorough but efficient):

1. **RUN TESTS** (2 min max):
   - npm test or yarn test
   - Check build: npm run build
   - Verify lint: npm run lint

2. **TEST FUNCTIONALITY**:
   - Verify main features work
   - Check happy path first
   - Test error handling

3. **REPORT RESULTS**:
   - List what passed ✅
   - List any failures ❌
   - GO/NO-GO decision

## SUCCESS CRITERIA:
- Build compiles without errors
- Tests pass (or no tests exist)
- No critical runtime errors
- Main functionality works

## OUTPUT FORMAT:
1. Test Results: PASS/FAIL with details
2. Issues Found: List any bugs
3. Decision: GO (ready for PR) or NO-GO (needs fixes)

Be concise but thorough. Focus on functionality over perfection.`;

      // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
      // This ensures ALL agents receive the same multimedia context
      const attachments = context.getData<any[]>('attachments') || [];
      if (attachments.length > 0) {
        console.log(`📎 [QA] Using ${attachments.length} attachment(s) from context`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 QA Engineer: Received ${attachments.length} image(s) from context for quality validation`
        );
      }

      const result = await this.executeAgentFn(
        'qa-engineer',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        'QA Engineer',
        undefined, // sessionId
        undefined, // fork
        attachments.length > 0 ? attachments : undefined // attachments
      );

      // Store results
      task.orchestration.qaEngineer!.status = 'completed';
      task.orchestration.qaEngineer!.completedAt = new Date();
      task.orchestration.qaEngineer!.output = result.output;
      task.orchestration.qaEngineer!.sessionId = result.sessionId;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.qaEngineer!.canResumeSession = result.canResume;
      task.orchestration.qaEngineer!.usage = result.usage;
      task.orchestration.qaEngineer!.cost_usd = result.cost;
      task.orchestration.qaEngineer!.totalPRsTested = branchesToTest.length;

      // if (result.todos) {
      //   task.orchestration.qaEngineer!.todos = result.todos;
      //   task.orchestration.qaEngineer!.lastTodoUpdate = new Date();
      // }

      // Update costs (skip in multi-team mode to avoid conflicts)
      if (!multiTeamMode) {
        task.orchestration.totalCost += result.cost;
        task.orchestration.totalTokens +=
          (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

        await task.save();
      }

      // 🔥 EVENT SOURCING: Emit completion event (reuse eventStore from line 96)
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'QACompleted',
        agentName: 'qa-engineer',
        payload: {
          output: result.output,
          epicsBranches: branchesToTest.length,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [QA] Emitted QACompleted event`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🧪 QA ENGINEER - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'QA Engineer', result.output);

      // 🔥 CHECK IF QA DETECTED ERRORS (lint/build/test failures)
      const qaAttempt = context.getData<number>('qaAttempt') || 1;
      const hasErrors = this.detectQAErrors(result.output);

      if (hasErrors && qaAttempt === 1) {
        // ❌ QA FAILED ON ATTEMPT 1 → Call Fixer
        console.log(`❌ [QA] Detected errors on attempt 1 - calling Fixer`);

        const errorDetails = this.extractErrorDetails(result.output);

        console.log(`🔧 [QA] Setting context data for Fixer:`, {
          qaErrorsLength: errorDetails.errorOutput.length,
          qaErrorType: errorDetails.errorType,
          qaAttempt: 1
        });

        context.setData('qaErrors', errorDetails.errorOutput);
        context.setData('qaErrorType', errorDetails.errorType);
        context.setData('qaAttempt', 1);

        // Verify data was set
        console.log(`🔧 [QA] Context data verification:`, {
          qaErrorsSet: !!context.getData('qaErrors'),
          qaErrorTypeSet: context.getData('qaErrorType'),
          qaAttemptSet: context.getData('qaAttempt')
        });

        NotificationService.emitAgentMessage(
          taskId,
          'QA Engineer',
          `⚠️ QA detected ${errorDetails.errorType} errors. Calling Fixer to resolve...`
        );

        await LogService.warn(`QA detected errors - Fixer will attempt fix`, {
          taskId,
          category: 'quality',
          phase: 'qa',
          metadata: {
            errorType: errorDetails.errorType,
            attempt: 1,
          },
        });

        // Return success so Fixer phase executes
        return {
          success: true,
          data: {
            qaAttempt: 1,
            hasErrors: true,
            errorType: errorDetails.errorType,
          },
        };
      }

      // ✅ QA PASSED OR ATTEMPT 2 → Create PRs
      // Note: If errors exist after Fixer attempt, they're documented in QA output

      await LogService.info('Creating Pull Requests after QA validation', {
        taskId,
        category: 'pr',
        phase: 'qa',
        metadata: {
          epicBranchesCount: branchesToTest.length,
          qaAttempt,
          hasErrors,
        },
      });

      const prResults = await this.prManagementService.createEpicPRs(
        task,
        repositories,
        workspacePath
        // Note: If hasErrors, QA output already documents the errors
      );

      const successfulPRs = prResults.filter((r) => r.success).length;
      await LogService.success(`Created ${successfulPRs}/${prResults.length} Pull Requests`, {
        taskId,
        category: 'pr',
        phase: 'qa',
        metadata: {
          successfulPRs,
          totalPRs: prResults.length,
        },
      });

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'QA Engineer',
        `Integration testing complete. Tested ${branchesToTest.length} epic branches. Created ${successfulPRs} PRs.`
      );

      await LogService.agentCompleted('qa-engineer', taskId, {
        phase: 'qa',
        metadata: {
          epicBranchesTested: branchesToTest.length,
          prsCreated: successfulPRs,
          mergeSuccess,
          conflictsCount: mergeConflicts.length,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data
      context.setData('qaComplete', true);
      context.setData('prResults', prResults);
      context.setData('mergeConflicts', mergeConflicts);

      return {
        success: true,
        data: {
          output: result.output,
          epicBranchesTested: branchesToTest.length,
          prsCreated: successfulPRs,
          mergeSuccess,
          conflicts: mergeConflicts,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          prs_created: successfulPRs,
          branches_tested: branchesToTest.length,
        },
        warnings: !mergeSuccess ? [`Merge conflicts detected: ${mergeConflicts.join(', ')}`] : undefined,
      };
    } catch (error: any) {
      // Save error state (skip in multi-team mode to avoid conflicts)
      if (!multiTeamMode) {
        task.orchestration.qaEngineer!.status = 'failed';
        task.orchestration.qaEngineer!.error = error.message;
        await task.save();
      }

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'QA Engineer', error.message);

      await LogService.agentFailed('qa-engineer', taskId, error, {
        phase: 'qa',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'QACompleted', // Mark as completed even on error
        agentName: 'qa-engineer',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [QA] Emitted QACompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Detect if QA found errors (lint/build/test/startup failures)
   */
  private detectQAErrors(qaOutput: string): boolean {
    const errorIndicators = [
      // Lint errors
      'eslint',
      'lint error',
      // Build errors
      'build failed',
      'compilation error',
      // Test errors
      'test failed',
      'tests failed',
      // Syntax/Type errors
      'error ts',
      'typeerror',
      'syntaxerror',
      'npm err!',
      // JSON output indicators
      'testsPass": false',
      'buildSuccess": false',
      'lintSuccess": false',
      'serverStartSuccess": false',
      // Startup/Runtime errors (CRITICAL)
      'server failed to start',
      'application failed to start',
      'cannot find module',
      'module not found',
      'importerror',
      'modulenotfounderror',
      'failed to load',
      'error: cannot find',
      'uncaught exception',
      'unhandled rejection',
    ];

    const lowerOutput = qaOutput.toLowerCase();
    return errorIndicators.some((indicator) => lowerOutput.includes(indicator));
  }

  /**
   * Extract error details from QA output
   */
  private extractErrorDetails(qaOutput: string): {
    errorType: string;
    errorOutput: string;
  } {
    const lowerOutput = qaOutput.toLowerCase();

    // Determine error type (priority order: startup > lint > build > test)
    let errorType = 'unknown';
    if (lowerOutput.includes('server failed to start') ||
        lowerOutput.includes('application failed to start') ||
        lowerOutput.includes('cannot find module') ||
        lowerOutput.includes('module not found') ||
        lowerOutput.includes('importerror') ||
        lowerOutput.includes('modulenotfounderror') ||
        lowerOutput.includes('serverstartsuccess": false')) {
      errorType = 'startup';
    } else if (lowerOutput.includes('lint')) {
      errorType = 'lint';
    } else if (lowerOutput.includes('build') || lowerOutput.includes('compilation')) {
      errorType = 'build';
    } else if (lowerOutput.includes('test')) {
      errorType = 'test';
    }

    // Extract relevant error section (first 2000 chars or until "Summary")
    let errorOutput = qaOutput;
    const summaryIndex = qaOutput.indexOf('## Summary');
    if (summaryIndex > 0) {
      errorOutput = qaOutput.substring(0, summaryIndex);
    }

    // Truncate if too long
    if (errorOutput.length > 2000) {
      errorOutput = errorOutput.substring(0, 2000) + '\n\n... (truncated)';
    }

    return { errorType, errorOutput };
  }
}
