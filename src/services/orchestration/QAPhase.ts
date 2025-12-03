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

      // 🔥 FIX: Also try to get from epicBranchMapping (for multi-team mode)
      const epicBranchMapping = context.getData<Record<string, string>>('epicBranchMapping') || {};
      if (Object.keys(epicBranchMapping).length > 0) {
        console.log(`📂 [QA] Found epic branch mapping in context: ${JSON.stringify(epicBranchMapping)}`);
      }

      // 🔥 FIX: Also check BranchRegistry (if available)
      let epicBranchesFromRegistry: string[] = [];
      try {
        // Try to get branches from context's branch registry
        const branches = (context as any).branchRegistry;
        if (branches && branches instanceof Map) {
          epicBranchesFromRegistry = Array.from(branches.values())
            .filter((b: any) => b.type === 'epic')
            .map((b: any) => b.name);
          if (epicBranchesFromRegistry.length > 0) {
            console.log(`📂 [QA] Found ${epicBranchesFromRegistry.length} epic branches in BranchRegistry`);
          }
        }
      } catch (e) {
        // BranchRegistry not available
      }

      const epicBranches = epics.map((epic: any) => {
        // Priority: 1) epic.branchName from EventStore
        if (epic.branchName) {
          console.log(`  - Epic ${epic.id}: using branchName from EventStore: ${epic.branchName}`);
          return epic.branchName;
        }

        // 2) epicBranchMapping from context (multi-team mode)
        if (epicBranchMapping[epic.id]) {
          console.log(`  - Epic ${epic.id}: using branch from mapping: ${epicBranchMapping[epic.id]}`);
          return epicBranchMapping[epic.id];
        }

        // 3) BranchRegistry (look for epic branch containing this epic's id)
        const registeredBranch = epicBranchesFromRegistry.find(b => b.includes(epic.id));
        if (registeredBranch) {
          console.log(`  - Epic ${epic.id}: using branch from registry: ${registeredBranch}`);
          return registeredBranch;
        }

        // 4) Context epicBranch (single-team mode fallback)
        if (contextEpicBranch) {
          console.log(`  - Epic ${epic.id}: using context epicBranch: ${contextEpicBranch}`);
          return contextEpicBranch;
        }

        // 5) 🚨 NO FALLBACK - Log error instead of using constructed name
        console.error(`  ❌ Epic ${epic.id}: NO branchName found! Cannot use fallback.`);
        console.error(`     Epic may not have been processed by TeamOrchestration or Developers.`);
        console.error(`     Skipping this epic from QA testing.`);
        return null; // Will be filtered out
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
      const { normalizeRepoName } = require('../../utils/safeGitExecution');
      const repoContext = repositories.map(repo => ({
        name: normalizeRepoName(repo.githubRepoName.split('/').pop() || ''),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? path.join(workspacePath, normalizeRepoName(repo.githubRepoName.split('/').pop() || '')) : ''
      }));

      // Execute QA agent
      const prompt = `# QA Engineer - Final Validation

## Task: ${task.title}

## Working Directory: ${workspacePath || this.workspaceDir}

## Repos to Test (${repositories.length}):
${repoContext.map(r => `- ${r.name} at ${r.path}`).join('\n')}

## Epic Branches Merged:
${branchesToTest.length > 0 ? branchesToTest.map(b => `- ${b}`).join('\n') : '- No branches to merge (testing main/master branch directly)'}

${!mergeSuccess ? `## ⚠️ MERGE CONFLICTS DETECTED:
${mergeConflicts.map(c => `- ${c}`).join('\n')}

**Note: Conflicts were auto-resolved. Please verify the merge is correct.**
` : ''}

## 🎯 CRITICAL INSTRUCTIONS - EXECUTE IN THIS EXACT ORDER:

### STEP 1: Verify Current Directory (5 seconds)
\`\`\`bash
pwd
ls -la
\`\`\`

### STEP 2: Navigate to Project Root (10 seconds)
${repositories.length > 0 ? `\`\`\`bash
cd ${repoContext[0].path}
ls -la
\`\`\`

If package.json doesn't exist, try:
\`\`\`bash
find . -name "package.json" -type f | head -5
\`\`\`
Then cd to the correct directory.` : 'Already in correct directory'}

### STEP 3: Install Dependencies (30 seconds max)
\`\`\`bash
# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  npm install --legacy-peer-deps || npm install || echo "No package.json found"
fi
\`\`\`

### STEP 4: Run Build (1 minute max)
\`\`\`bash
# Try common build commands
npm run build || npm run compile || npm run tsc || echo "No build script"
\`\`\`

### STEP 5: Run Tests (2 minutes max)
\`\`\`bash
# Try common test commands
npm test -- --watchAll=false || npm run test:ci || npm run test || echo "No tests configured"
\`\`\`

### STEP 6: Check for TypeScript/Lint Errors (30 seconds)
\`\`\`bash
# Only if these scripts exist
npm run lint || npx tsc --noEmit || echo "No lint/type checking"
\`\`\`

### STEP 7: Verify Core Functionality (1 minute)
- If it's a web app: Check if dev server starts (npm run dev/start)
- If it's a library: Check if main exports work
- If it's a CLI: Check if help command works

## 🛑 DECISION CRITERIA (IMPORTANT):

### ✅ APPROVE (GO) if ALL of these are true:
1. Code compiles/builds without errors
2. No runtime crashes
3. Tests pass OR no tests exist
4. Main functionality appears to work

### ❌ REJECT (NO-GO) if ANY of these occur:
1. Build fails completely
2. Runtime crashes on startup
3. Critical tests fail (>50% failure rate)
4. Core functionality is broken

## 📋 OUTPUT FORMAT (MANDATORY JSON):

After completing all steps, output ONLY this JSON (no other text after):

\`\`\`json
{
  "summary": {
    "build": { "status": "PASS|FAIL", "reason": "one line" },
    "tests": { "status": "PASS|FAIL|NONE", "reason": "one line" },
    "lint": { "status": "PASS|FAIL|NONE", "reason": "one line" },
    "runtime": { "status": "PASS|FAIL", "reason": "one line" }
  },
  "issues": ["issue 1 description", "issue 2 description"],
  "decision": "GO|NO-GO",
  "reason": "one sentence explanation",
  "errorOutput": "full error output if any failures (truncated to 2000 chars)"
}
\`\`\`

**CRITICAL**: Your final output MUST be valid JSON inside \`\`\`json block. No text after the JSON.

## ⚠️ EDGE CASES:
- If no package.json exists, check for other build systems (Makefile, gradle, etc)
- If no tests exist, mark as PASS with note "No tests configured"
- If build takes >2 minutes, kill it and mark as FAIL
- Focus on FUNCTIONALITY over style issues

Start immediately with STEP 1. Be efficient and decisive.`;

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
   * Parse QA JSON output
   * 🔥 FIX: Try JSON first, fallback to regex if not parseable
   */
  private parseQAOutput(qaOutput: string): {
    parsed: boolean;
    decision?: string;
    hasErrors?: boolean;
    errorType?: string;
    errorOutput?: string;
    summary?: any;
  } {
    // Try to parse JSON output first
    try {
      const { OutputParser } = require('./utils/OutputParser');
      const result = OutputParser.extractJSON(qaOutput);

      if (result.success && result.data) {
        const data = result.data;
        const hasErrors = data.decision === 'NO-GO' ||
                         data.summary?.build?.status === 'FAIL' ||
                         data.summary?.tests?.status === 'FAIL' ||
                         data.summary?.lint?.status === 'FAIL' ||
                         data.summary?.runtime?.status === 'FAIL';

        // Determine error type from summary
        let errorType = 'unknown';
        if (data.summary?.runtime?.status === 'FAIL') errorType = 'startup';
        else if (data.summary?.lint?.status === 'FAIL') errorType = 'lint';
        else if (data.summary?.build?.status === 'FAIL') errorType = 'build';
        else if (data.summary?.tests?.status === 'FAIL') errorType = 'test';

        console.log(`📝 [QA] Parsed JSON output successfully - decision: ${data.decision}, hasErrors: ${hasErrors}`);

        return {
          parsed: true,
          decision: data.decision,
          hasErrors,
          errorType,
          errorOutput: data.errorOutput || data.reason || '',
          summary: data.summary,
        };
      }
    } catch (e) {
      console.log(`⚠️  [QA] Could not parse JSON output, falling back to regex`);
    }

    return { parsed: false };
  }

  /**
   * Detect if QA found errors (lint/build/test/startup failures)
   * 🔥 FIX: Try JSON parsing first, fallback to regex
   */
  private detectQAErrors(qaOutput: string): boolean {
    // Try JSON parsing first
    const parsed = this.parseQAOutput(qaOutput);
    if (parsed.parsed) {
      return parsed.hasErrors || false;
    }

    // Fallback to regex-based detection
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
      '"decision": "NO-GO"',
      '"status": "FAIL"',
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
   * 🔥 FIX: Try JSON parsing first, fallback to regex
   */
  private extractErrorDetails(qaOutput: string): {
    errorType: string;
    errorOutput: string;
  } {
    // Try JSON parsing first
    const parsed = this.parseQAOutput(qaOutput);
    if (parsed.parsed && parsed.errorType && parsed.errorOutput) {
      return {
        errorType: parsed.errorType,
        errorOutput: parsed.errorOutput,
      };
    }

    // Fallback to regex-based extraction
    const lowerOutput = qaOutput.toLowerCase();

    // Determine error type (priority order: startup > lint > build > test)
    let errorType = 'unknown';
    if (lowerOutput.includes('server failed to start') ||
        lowerOutput.includes('application failed to start') ||
        lowerOutput.includes('cannot find module') ||
        lowerOutput.includes('module not found') ||
        lowerOutput.includes('importerror') ||
        lowerOutput.includes('modulenotfounderror') ||
        lowerOutput.includes('serverstartsuccess": false') ||
        lowerOutput.includes('"runtime"') && lowerOutput.includes('"fail"')) {
      errorType = 'startup';
    } else if (lowerOutput.includes('lint') || (lowerOutput.includes('"lint"') && lowerOutput.includes('"fail"'))) {
      errorType = 'lint';
    } else if (lowerOutput.includes('build') || lowerOutput.includes('compilation') ||
               (lowerOutput.includes('"build"') && lowerOutput.includes('"fail"'))) {
      errorType = 'build';
    } else if (lowerOutput.includes('test') || (lowerOutput.includes('"tests"') && lowerOutput.includes('"fail"'))) {
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
