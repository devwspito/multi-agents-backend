/**
 * Verification Phase
 *
 * Runs AFTER TeamOrchestration completes (after all epics/stories are implemented).
 * This is the final quality gate before AutoMerge.
 *
 * Key responsibilities:
 * 1. Completeness Check - Did we implement ALL story requirements?
 * 2. Coherence Check - Are routes registered? Frontend-backend connected?
 * 3. Integration Check - Do the pieces work together?
 *
 * If verification fails:
 * - Returns detailed feedback
 * - TeamOrchestration can use Fixer agent to address issues
 * - Loop: Verification → Fix → Verification until pass or max attempts
 */

import { BasePhase, OrchestrationContext, PhaseResult, createSuccessResult, createErrorResult } from './Phase';
import { isEmpty, isNotEmpty } from './utils/ArrayHelpers';
import { CompletenessValidator, CompletenessReport } from '../verification/CompletenessValidator';
import { CoherenceChecker, CoherenceReport } from '../verification/CoherenceChecker';
import { QualityGates, QualityGateResult } from '../QualityGates';
import { LogService } from '../logging/LogService';
import { NotificationService } from '../NotificationService';
import { OutputParser } from './utils/OutputParser';
import { IStory, IEpic, TaskRepository } from '../../database/repositories/TaskRepository.js';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { getEpicId } from './utils/IdNormalizer';

export interface VerificationResult {
  epicId: string;
  storyId?: string;
  completeness: CompletenessReport | null;
  coherence: CoherenceReport | null;
  qualityGates: QualityGateResult | null;
  passed: boolean;
  issues: string[];
  feedback: string;
}

export interface VerificationPhaseData {
  totalEpics: number;
  verifiedEpics: number;
  passedEpics: number;
  failedEpics: number;
  results: VerificationResult[];
  overallPassed: boolean;
  consolidatedFeedback: string;
}

/**
 * Maximum number of fix attempts before proceeding to AutoMerge anyway
 */
const MAX_FIX_ATTEMPTS = 2;

export class VerificationPhase extends BasePhase {
  readonly name = 'Verification';
  readonly description = 'Verifying implementation completeness and full-stack coherence';

  constructor(private executeAgentFn?: Function) {
    super();
  }

  /**
   * 🎯 UNIFIED MEMORY: Skip if verification already completed
   *
   * Uses SkipLogicHelper for consistent skip behavior.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    // Use centralized skip logic
    const skipResult = await checkPhaseSkip(context, { phaseName: 'Verification' });

    if (skipResult.shouldSkip) {
      return true;
    }

    // Check if TeamOrchestration completed (prerequisite)
    const teamOrchStatus = (context.task.orchestration as any).teamOrchestration?.status;
    if (teamOrchStatus !== 'completed' && teamOrchStatus !== 'partial') {
      console.log(`   ⏭️ TeamOrchestration must complete before Verification (current: ${teamOrchStatus || 'not started'})`);
      return true;
    }

    console.log(`   ❌ Phase not completed - Verification must execute`);
    return false;
  }

  /**
   * Main execution method with Fixer loop
   *
   * Flow:
   * 1. Run verification checks
   * 2. If passed → return success
   * 3. If failed → call Fixer agent with feedback
   * 4. Retry verification (up to MAX_FIX_ATTEMPTS)
   * 5. After max attempts → return success with warnings (soft-fail)
   *    This allows AutoMerge to proceed for human review
   */
  protected async executePhase(context: OrchestrationContext): Promise<PhaseResult> {
    const startTime = Date.now();
    const taskId = (context.task.id as any)?.toString() || '';

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✅ [Verification] Starting implementation verification...`);
    console.log(`   Max fix attempts: ${MAX_FIX_ATTEMPTS}`);
    console.log(`${'═'.repeat(60)}`);

    const workspacePath = context.workspacePath;
    if (!workspacePath) {
      return createErrorResult(this.name, startTime, 'No workspace path available');
    }

    // Get completed epics from TeamOrchestration
    const teamOrchResult = context.getPhaseResult('TeamOrchestration');
    if (!teamOrchResult || !teamOrchResult.success) {
      return createErrorResult(this.name, startTime, 'TeamOrchestration phase did not complete successfully');
    }

    // Get epics from planning phase
    const epics: IEpic[] = context.task.orchestration.planning?.epics || [];
    if (isEmpty(epics)) {
      console.log(`⚠️ [Verification] No epics to verify`);
      return createSuccessResult(this.name, startTime, {
        totalEpics: 0,
        verifiedEpics: 0,
        passedEpics: 0,
        failedEpics: 0,
        results: [],
        overallPassed: true,
        consolidatedFeedback: 'No epics to verify',
      });
    }

    // ============================================================
    // VERIFICATION + FIXER LOOP
    // ============================================================
    let lastVerificationResult: VerificationPhaseData | null = null;
    let fixAttempt = 0;

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS + 1; attempt++) {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`🔄 [Verification] Attempt ${attempt}/${MAX_FIX_ATTEMPTS + 1}`);
      console.log(`${'─'.repeat(50)}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔍 Verification attempt ${attempt}/${MAX_FIX_ATTEMPTS + 1}`
      );

      // Run verification checks
      const verificationResult = await this.runVerificationChecks(context, epics, workspacePath);
      lastVerificationResult = verificationResult;

      // Store in context for potential use by other phases
      context.setData('verificationResults', verificationResult.results);
      context.setData('verificationPassed', verificationResult.overallPassed);
      context.setData('verificationFeedback', verificationResult.consolidatedFeedback);

      if (verificationResult.overallPassed) {
        // ✅ PASSED: All checks passed
        console.log(`\n✅ [Verification] All checks PASSED on attempt ${attempt}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Verification PASSED - all ${verificationResult.passedEpics} epics verified`
        );

        await LogService.info('Verification passed', {
          taskId,
          category: 'orchestration',
          metadata: {
            attempt,
            passedEpics: verificationResult.passedEpics,
          },
        });

        return createSuccessResult(this.name, startTime, verificationResult);
      }

      // ❌ FAILED: Some checks failed
      console.log(`\n❌ [Verification] ${verificationResult.failedEpics} epic(s) failed verification`);

      // If we've exhausted fix attempts, use soft-fail
      if (attempt > MAX_FIX_ATTEMPTS) {
        console.log(`\n⚠️ [Verification] Max fix attempts (${MAX_FIX_ATTEMPTS}) reached`);
        console.log(`   Proceeding to AutoMerge for human review...`);

        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️ Verification found ${verificationResult.failedEpics} issue(s) after ${MAX_FIX_ATTEMPTS} fix attempts.\n` +
          `   Proceeding to AutoMerge for human review.`
        );

        await LogService.warn('Verification soft-fail: max attempts reached', {
          taskId,
          category: 'orchestration',
          metadata: {
            attempts: MAX_FIX_ATTEMPTS,
            failedEpics: verificationResult.failedEpics,
            issues: verificationResult.results.filter(r => !r.passed).map(r => ({
              epicId: r.epicId,
              issueCount: r.issues.length,
            })),
          },
        });

        // ⚡ SOFT-FAIL: Return success with warnings to allow AutoMerge
        return createSuccessResult(this.name, startTime, {
          ...verificationResult,
          softFail: true,
        }, {
          warnings: [
            `Verification found ${verificationResult.failedEpics} issue(s) but proceeding for human review`,
            ...verificationResult.results.filter(r => !r.passed).map(r =>
              `Epic ${r.epicId}: ${r.issues.length} issue(s)`
            ),
          ],
        });
      }

      // 🔧 FIXER: Attempt to fix issues
      fixAttempt++;
      console.log(`\n🔧 [Verification] Calling Fixer agent (attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS})`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔧 Running Verification Fixer (attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS})...`
      );

      const fixerSuccess = await this.runVerificationFixer(
        context,
        verificationResult,
        workspacePath,
        fixAttempt
      );

      if (!fixerSuccess) {
        console.log(`⚠️ [Verification] Fixer could not resolve all issues`);
      } else {
        console.log(`✅ [Verification] Fixer applied changes, re-verifying...`);
      }
    }

    // Should never reach here, but return last result just in case
    return createSuccessResult(this.name, startTime, lastVerificationResult!);
  }

  /**
   * Run all verification checks on epics
   * Extracted from original executePhase for reuse in loop
   */
  private async runVerificationChecks(
    context: OrchestrationContext,
    epics: IEpic[],
    workspacePath: string
  ): Promise<VerificationPhaseData> {
    const results: VerificationResult[] = [];
    let passedCount = 0;
    let failedCount = 0;

    // Verify each epic
    for (const epic of epics) {
      console.log(`\n📋 [Verification] Verifying Epic: ${epic.id} - ${epic.title}`);

      const epicResult = await this.verifyEpic(context, epic, workspacePath);
      results.push(epicResult);

      if (epicResult.passed) {
        passedCount++;
        console.log(`   ✅ Epic ${epic.id} PASSED`);
      } else {
        failedCount++;
        console.log(`   ❌ Epic ${epic.id} FAILED (${epicResult.issues.length} issues)`);
      }
    }

    const overallPassed = failedCount === 0;
    const consolidatedFeedback = this.consolidateFeedback(results, overallPassed);

    console.log(`\n📊 Summary: ${passedCount}/${epics.length} epics passed`);

    return {
      totalEpics: epics.length,
      verifiedEpics: epics.length,
      passedEpics: passedCount,
      failedEpics: failedCount,
      results,
      overallPassed,
      consolidatedFeedback,
    };
  }

  /**
   * Run Fixer agent to resolve verification issues
   *
   * @returns true if fixer made changes, false if it couldn't fix
   */
  private async runVerificationFixer(
    context: OrchestrationContext,
    verificationResult: VerificationPhaseData,
    workspacePath: string,
    attempt: number
  ): Promise<boolean> {
    const taskId = (context.task.id as any)?.toString() || '';

    if (!this.executeAgentFn) {
      console.log(`⚠️ [Verification] No executeAgentFn available - cannot run fixer`);
      NotificationService.emitConsoleLog(
        taskId,
        'warn',
        `⚠️ Fixer not available - skipping fix attempt`
      );
      return false;
    }

    const failedEpics = verificationResult.results.filter(r => !r.passed);
    const primaryRepo = context.repositories[0];

    if (!primaryRepo) {
      console.log(`⚠️ [Verification] No repository available`);
      return false;
    }

    // 💡 Get any injected directives for verification-fixer
    const directivesBlock = context.getDirectivesBlock('verification-fixer');

    // 🏗️ Get architectureBrief from context for pattern-aware fixes
    const architectureBrief = context.getData<any>('architectureBrief');
    if (architectureBrief) {
      console.log(`🏗️ [Verification] Architecture brief available - fixer will follow project patterns`);
    }

    // Build detailed prompt for fixer (with directives prepended)
    const fixerPrompt = this.buildFixerPrompt(verificationResult, failedEpics, primaryRepo.name, attempt, architectureBrief);
    const prompt = directivesBlock + fixerPrompt;

    try {
      NotificationService.emitAgentStarted(taskId, 'Verification Fixer');

      const result = await this.executeAgentFn(
        'verification-fixer',
        prompt,
        workspacePath,
        taskId,
        'Verification Fixer',
        undefined,
        undefined,
        undefined
      );

      // Emit full output to console
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🔧 VERIFICATION FIXER OUTPUT\n${'='.repeat(80)}\n\n${result.output || '(no output)'}\n\n${'='.repeat(80)}`
      );

      // Parse fixer result
      const parsed = this.parseFixerOutput(result.output || '');

      // Update costs
      const cost = result.cost || 0;
      context.task.orchestration.totalCost = (context.task.orchestration.totalCost || 0) + cost;
      context.task.orchestration.totalTokens = (context.task.orchestration.totalTokens || 0) +
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
      TaskRepository.update(context.task.id, context.task);

      if (parsed.fixed) {
        console.log(`✅ [Verification] Fixer applied ${parsed.filesModified.length} changes`);
        NotificationService.emitAgentCompleted(
          taskId,
          'Verification Fixer',
          `Fixed ${parsed.filesModified.length} file(s): ${parsed.changes.slice(0, 3).join(', ')}`
        );

        await LogService.info('Verification fixer applied changes', {
          taskId,
          category: 'orchestration',
          metadata: {
            attempt,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
            cost,
          },
        });

        return true;
      } else {
        console.log(`⚠️ [Verification] Fixer could not resolve issues`);
        NotificationService.emitAgentMessage(
          taskId,
          'Verification Fixer',
          `⚠️ Could not automatically fix all issues. ${parsed.changes.length > 0 ? `Attempted: ${parsed.changes.join(', ')}` : ''}`
        );

        return false;
      }
    } catch (error: any) {
      console.error(`❌ [Verification] Fixer error: ${error.message}`);
      NotificationService.emitAgentError(taskId, 'Verification Fixer', error.message);

      await LogService.error('Verification fixer failed', {
        taskId,
        category: 'orchestration',
        error,
        metadata: { attempt },
      });

      return false;
    }
  }

  /**
   * Build the prompt for the Verification Fixer agent
   * Enhanced with project context, validation steps, and best practices
   */
  private buildFixerPrompt(
    verificationResult: VerificationPhaseData,
    failedEpics: VerificationResult[],
    repoName: string,
    attempt: number,
    architectureBrief?: any // 🏗️ Architecture insights from PlanningPhase
  ): string {
    const issuesList = failedEpics.map((epic, i) => {
      const completenessIssues = epic.completeness && !epic.completeness.isComplete
        ? epic.completeness.requirements.filter(r => !r.implemented).map(r =>
            `  - [COMPLETENESS] ${r.requirement}\n    Missing in: ${r.missingIn || 'unknown'}`
          ).join('\n')
        : '';

      const coherenceIssues = epic.coherence && !epic.coherence.isCoherent
        ? epic.coherence.issues.map(issue =>
            `  - [${issue.severity.toUpperCase()}] ${issue.description}\n    File: ${issue.file}\n    Fix: ${issue.fix}`
          ).join('\n')
        : '';

      return `## Epic ${i + 1}: ${epic.epicId}

### Issues Found:
${epic.issues.map(issue => `- ${issue}`).join('\n')}

${completenessIssues ? `### Completeness Issues:\n${completenessIssues}\n` : ''}
${coherenceIssues ? `### Coherence Issues:\n${coherenceIssues}\n` : ''}`;
    }).join('\n\n');

    return `# Verification Fixer - Attempt ${attempt}/${MAX_FIX_ATTEMPTS}

You are the **Verification Fixer** agent. Your job is to fix implementation issues found during verification.
This is a **high-quality, enterprise-grade** service. Your fixes must be thorough and validated.

---

## 📊 Verification Report

**Summary:**
- Total Epics: ${verificationResult.totalEpics}
- Passed: ${verificationResult.passedEpics}
- Failed: ${verificationResult.failedEpics}

## ❌ Failed Epics (${failedEpics.length})

${issuesList}

${architectureBrief ? `---

## 🏗️ PROJECT PATTERNS (Follow These When Fixing!)

${architectureBrief.codePatterns ? `- **Naming**: ${architectureBrief.codePatterns.namingConvention || 'Not specified'}
- **File Structure**: ${architectureBrief.codePatterns.fileStructure || 'Not specified'}
- **Error Handling**: ${architectureBrief.codePatterns.errorHandling || 'Not specified'}
- **Testing**: ${architectureBrief.codePatterns.testing || 'Not specified'}` : ''}

${architectureBrief.conventions?.length > 0 ? `**Project Conventions**:
${architectureBrief.conventions.map((c: string) => `- ${c}`).join('\n')}` : ''}

⚠️ Your fixes MUST follow these patterns or they will be rejected again.
` : ''}
---

## 🔧 STEP-BY-STEP WORKFLOW

### Step 1: Pull Latest & Understand Context
\`\`\`bash
cd ${repoName}
git pull origin HEAD
\`\`\`

Then read key files to understand:
- **package.json** - dependencies, scripts available
- **App entry point** (src/index.ts, src/app.ts, etc.) - how routes are registered
- **Existing patterns** - how similar routes/components are structured

### Step 2: Fix Issues (Priority Order)

1. **🚨 CRITICAL - Route Registration**
   - If a route file exists in \`src/routes/\` but is NOT registered in app.js/index.ts:
     - Read the app entry point
     - Add \`import xxxRoutes from './routes/xxx'\`
     - Add \`app.use('/api/xxx', xxxRoutes)\`

2. **🚨 CRITICAL - Missing Imports**
   - Check for any import errors in the issue list
   - Add missing imports from correct paths

3. **⚠️ Completeness Issues**
   - For missing endpoints: Create the route handler
   - For missing UI elements: Add the component/button with handler
   - Follow existing patterns in the codebase

4. **⚠️ Coherence Issues**
   - Ensure frontend API URLs match backend routes exactly
   - Check field names match between frontend and backend

### Step 3: 🧹 UNUSED CODE CLEANER (MANDATORY)

After making fixes, scan for and remove unused code:

\`\`\`bash
cd ${repoName}

# 1. Find unused imports (JavaScript/TypeScript)
grep -rn "^import" src/ | head -20
# Then check if each imported item is actually used

# 2. Look for unused variables (lint will catch most)
npm run lint 2>&1 | grep -i "unused" || true

# 3. Find TODO/FIXME that should be addressed
grep -rn "TODO\|FIXME\|HACK\|XXX" src/ | head -10 || true
\`\`\`

**REMOVE UNUSED CODE PATTERNS:**
| Pattern | Action |
|---------|--------|
| \`import { X } from 'y'\` where X is never used | Remove import or unused specifier |
| \`const x = ...\` where x is never used | Remove entire statement |
| \`function foo() {}\` that is never called | Remove entire function |
| Dead code after \`return\`, \`throw\`, \`break\` | Remove unreachable code |
| Commented-out code blocks | Remove entirely (use git history) |
| Empty try/catch blocks | Add proper error handling or remove |

**⚠️ DO NOT remove:**
- Exports that might be used by other modules
- Public API methods even if unused internally
- Type definitions/interfaces (they have no runtime cost)

### Step 4: Validate Your Fixes
\`\`\`bash
cd ${repoName}

# Check TypeScript compiles
npm run build 2>&1 || npm run typecheck 2>&1 || npx tsc --noEmit

# Check lint passes (if available)
npm run lint 2>&1 || true

# Run tests (if available)
npm test 2>&1 || npm run test 2>&1 || true
\`\`\`

**⚠️ IMPORTANT**: If build/lint fails, FIX those errors before committing!

### Step 5: Commit & Push (Only if validation passes)
\`\`\`bash
cd ${repoName}
git add .
git commit -m "fix(verification): Auto-fix verification issues - attempt ${attempt}

- [List specific fixes made]

🤖 Generated with Claude Code (Verification Fixer)
Co-Authored-By: Claude <noreply@anthropic.com>"

git push origin HEAD
\`\`\`

---

## 🔍 RESEARCH CAPABILITIES

If you need to look up documentation or find solutions:
- Use **WebFetch** to read official documentation (React, Express, etc.)
- Use **WebSearch** to find solutions for specific error patterns

---

## 📤 OUTPUT FORMAT (MANDATORY JSON)

After completing ALL steps above, output ONLY this JSON:

\`\`\`json
{
  "fixed": true,
  "filesModified": ["src/app.ts", "src/routes/users.ts"],
  "changes": [
    "Registered userRoutes in app.ts line 45",
    "Added missing import for AuthService"
  ],
  "validationPassed": true,
  "summary": "Fixed 2 verification issues, build passes"
}
\`\`\`

If you cannot fix all issues:
\`\`\`json
{
  "fixed": false,
  "filesModified": ["src/app.ts"],
  "changes": ["Registered userRoutes in app.ts"],
  "remainingIssues": ["Button handler requires UI design decision"],
  "validationPassed": true,
  "summary": "Partially fixed - 1 issue needs human decision"
}
\`\`\`

If validation fails:
\`\`\`json
{
  "fixed": false,
  "filesModified": ["src/routes/users.ts"],
  "changes": ["Attempted to add endpoint"],
  "validationError": "TypeScript error: Property 'x' does not exist",
  "validationPassed": false,
  "summary": "Fix attempted but build failed - needs investigation"
}
\`\`\`

---

**CRITICAL REMINDERS**:
1. ✅ Use tools (Read, Edit, Bash) to make ACTUAL changes
2. ✅ VALIDATE your fixes before committing (run build/lint)
3. ✅ Follow existing code patterns in the repository
4. ✅ Output ONLY the final JSON (first char = \`{\`, last char = \`}\`)
5. ❌ Do NOT commit if validation fails
`;
  }

  /**
   * Parse Fixer agent output
   */
  private parseFixerOutput(output: string): {
    fixed: boolean;
    filesModified: string[];
    changes: string[];
  } {
    const result = OutputParser.extractJSON(output);

    if (result.success && result.data) {
      const parsed = result.data;

      const filesModified = Array.isArray(parsed.filesModified) ? parsed.filesModified :
                           (parsed.filesModified ? [parsed.filesModified] : []);
      const changes = Array.isArray(parsed.changes) ? parsed.changes :
                     (parsed.changes ? [parsed.changes] : []);

      return {
        fixed: parsed.fixed === true,
        filesModified,
        changes,
      };
    }

    console.warn(`⚠️ Failed to parse Fixer output as JSON: ${result.error}`);

    // Fallback: check if output mentions "fixed"
    const fixed = output.toLowerCase().includes('fixed') &&
                  !output.toLowerCase().includes('could not fix') &&
                  !output.toLowerCase().includes('cannot fix');

    return {
      fixed,
      filesModified: [],
      changes: [],
    };
  }

  /**
   * Verify a single epic
   */
  private async verifyEpic(
    context: OrchestrationContext,
    epic: IEpic,
    workspacePath: string
  ): Promise<VerificationResult> {
    const issues: string[] = [];
    let completenessReport: CompletenessReport | null = null;
    let coherenceReport: CoherenceReport | null = null;
    let qualityGatesReport: QualityGateResult | null = null;

    // Find repository path for this epic
    const repoName = epic.targetRepository || context.repositories[0]?.name;
    const normalizedEpicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer
    if (!repoName) {
      console.error(`❌ [Verification] Cannot verify epic ${normalizedEpicId} - no targetRepository and no repositories in context`);
      return {
        epicId: normalizedEpicId,
        passed: false,
        completeness: null,
        coherence: null,
        qualityGates: null,
        issues: ['No repository specified for verification'],
        feedback: 'Cannot verify epic - no repository found in context or epic configuration.',
      };
    }
    const repoPath = `${workspacePath}/${repoName}`;

    // Get all stories from planning or techLead phase
    const allStories: IStory[] = context.task.orchestration.planning?.stories ||
                                 context.task.orchestration.techLead?.stories || [];

    // 1. Run Completeness Check on each story in this epic
    const epicStoryIds = epic.stories || []; // These are string IDs
    const epicStories = allStories.filter(s => epicStoryIds.includes(s.id));

    for (const story of epicStories) {
      try {
        const storyReport = await CompletenessValidator.validateStory(repoPath, {
          id: story.id,
          title: story.title,
          description: story.description,
          acceptanceCriteria: story.acceptanceCriteria,
        });

        if (!storyReport.isComplete) {
          issues.push(`Story ${story.id}: ${storyReport.missingCount} missing requirement(s)`);
          completenessReport = storyReport; // Store last failed report
        }
      } catch (error: any) {
        console.warn(`⚠️ [Verification] Error checking story ${story.id}:`, error.message);
      }
    }

    // 2. Run Coherence Check on the repository
    try {
      coherenceReport = await CoherenceChecker.checkCoherence(repoPath);

      if (!coherenceReport.isCoherent) {
        const criticalIssues = coherenceReport.issues.filter(i => i.severity === 'critical');
        for (const issue of criticalIssues) {
          issues.push(`[${issue.category}] ${issue.description}`);
        }
      }
    } catch (error: any) {
      console.warn(`⚠️ [Verification] Error checking coherence:`, error.message);
    }

    // 3. Run Quality Gates Check (compilation, linting, tests, security)
    try {
      console.log(`   🚦 [Verification] Running quality gates for epic ${epic.id}...`);

      // Get modified files from epic stories (cast to any for optional properties)
      const modifiedFiles = epicStories.flatMap((s: any) => [
        ...(s.filesToModify || []),
        ...(s.filesToCreate || []),
      ]);

      qualityGatesReport = await QualityGates.runAllGates({
        workspacePath: repoPath,
        modifiedFiles,
        minCoverage: 70,
        strictMode: false, // Don't block on TODOs
      });

      if (!qualityGatesReport.passed) {
        for (const gate of qualityGatesReport.blockingGates) {
          issues.push(`[Quality Gate] ${gate} failed`);
        }
        // Add recommendations
        for (const rec of qualityGatesReport.recommendations.slice(0, 3)) {
          issues.push(rec);
        }
      }
    } catch (error: any) {
      console.warn(`⚠️ [Verification] Error running quality gates:`, error.message);
    }

    // Determine if epic passed
    const passed = isEmpty(issues);

    // Generate feedback
    let feedback = '';
    if (!passed) {
      feedback = this.generateEpicFeedback(epic, issues, completenessReport, coherenceReport);
      // Add quality gates feedback
      if (qualityGatesReport && !qualityGatesReport.passed) {
        feedback += `\n\n${QualityGates.formatForPrompt(qualityGatesReport)}`;
      }
    } else {
      feedback = `✅ Epic ${normalizedEpicId} passed all verification checks (score: ${qualityGatesReport?.overallScore || 100}/100).`;
    }

    return {
      epicId: normalizedEpicId,
      completeness: completenessReport,
      coherence: coherenceReport,
      qualityGates: qualityGatesReport,
      passed,
      issues,
      feedback,
    };
  }

  /**
   * Generate detailed feedback for a failed epic
   */
  private generateEpicFeedback(
    epic: IEpic,
    issues: string[],
    completeness: CompletenessReport | null,
    coherence: CoherenceReport | null
  ): string {
    const lines: string[] = [];

    lines.push(`\n🚨 VERIFICATION FAILED for Epic: ${epic.id} - ${epic.title}`);
    lines.push(`${'─'.repeat(50)}`);

    if (isNotEmpty(issues)) {
      lines.push(`\n❌ ${issues.length} issue(s) found:\n`);
      for (const issue of issues) {
        lines.push(`  • ${issue}`);
      }
    }

    if (completeness && !completeness.isComplete) {
      lines.push(`\n📋 COMPLETENESS ISSUES:`);
      lines.push(completeness.feedback);
    }

    if (coherence && !coherence.isCoherent) {
      lines.push(`\n🔗 COHERENCE ISSUES:`);
      lines.push(coherence.feedback);
    }

    lines.push(`\n${'─'.repeat(50)}`);
    lines.push(`📝 ACTION: Fix these issues and re-run verification.`);

    return lines.join('\n');
  }

  /**
   * Consolidate feedback from all epic verifications
   */
  private consolidateFeedback(results: VerificationResult[], overallPassed: boolean): string {
    if (overallPassed) {
      return '✅ All epics passed verification. Ready for merge.';
    }

    const failedResults = results.filter(r => !r.passed);
    const lines: string[] = [];

    lines.push(`\n${'═'.repeat(60)}`);
    lines.push(`🚨 VERIFICATION FAILED - ${failedResults.length} epic(s) have issues`);
    lines.push(`${'═'.repeat(60)}\n`);

    for (const result of failedResults) {
      lines.push(result.feedback);
      lines.push('');
    }

    lines.push(`\n${'═'.repeat(60)}`);
    lines.push(`📝 REQUIRED ACTIONS:`);
    lines.push(`1. Review each issue above`);
    lines.push(`2. Fix the missing implementations or coherence issues`);
    lines.push(`3. Commit and push fixes`);
    lines.push(`4. Re-run verification`);
    lines.push(`${'═'.repeat(60)}`);

    return lines.join('\n');
  }
}
