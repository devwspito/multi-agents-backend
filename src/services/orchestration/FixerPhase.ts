import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { OutputParser } from './utils/OutputParser';
import { SemanticVerificationService } from '../SemanticVerificationService';
import { CodebaseKnowledge } from '../CodebaseDiscoveryService';
import { execSync } from 'child_process';

/**
 * Fixer Phase
 *
 * Automatically fixes build, lint, and test errors reported by QA.
 * Executes when QA fails on attempt 1 or attempt 2.
 *
 * Flow:
 * - **Attempt 1**: Standard Sonnet fixer
 *   1. QA (attempt 1) fails → Fixer called
 *   2. Fixer reads QA error output
 *   3. Fixer modifies code to fix errors
 *   4. Fixer commits changes
 *   5. Returns to QA (attempt 2)
 *
 * - **Attempt 2**: Last Chance Mode (Opus analyst + Sonnet fixer)
 *   1. QA (attempt 2) fails → Fixer called in Last Chance mode
 *   2. Opus analyst analyzes if errors are automatable
 *   3. If not automatable → escalate to human
 *   4. If automatable → Sonnet fixer applies targeted fixes
 *   5. Returns to QA (attempt 3 - final)
 *
 * Max budget (attempt 2): $3.00
 */
export class FixerPhase extends BasePhase {
  readonly name = 'Fixer';
  readonly description = 'Fixing QA-reported errors (lint, build, test)';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if QA didn't fail (no errors to fix)
   * Run on attempt 1 OR attempt 2
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const qaErrors = context.getData<string>('qaErrors');
    const qaAttempt = context.getData<number>('qaAttempt') || 1;
    const qaErrorType = context.getData<string>('qaErrorType');

    console.log(`🔧 [Fixer] shouldSkip() called - Checking context data:`, {
      hasQaErrors: !!qaErrors,
      qaErrorsLength: qaErrors?.length || 0,
      qaErrorType: qaErrorType,
      qaAttempt: qaAttempt,
      qaErrorsPreview: qaErrors ? qaErrors.substring(0, 100) + '...' : 'null'
    });

    // Run if QA failed on attempt 1 OR 2
    if (!qaErrors || (qaAttempt !== 1 && qaAttempt !== 2)) {
      console.log(`❌ [SKIP] Fixer will be skipped:`, {
        reason: !qaErrors ? 'No QA errors found in context' : `Wrong attempt number: ${qaAttempt}`,
        qaErrors: qaErrors ? 'present' : 'missing',
        qaAttempt: qaAttempt
      });
      return true;
    }

    if (qaAttempt === 1) {
      console.log(`✅ [Fixer] Will execute - QA errors found on attempt 1 (Standard mode)`);
    } else {
      console.log(`✅ [Fixer] Will execute - QA errors found on attempt 2 (Last Chance mode)`);
    }
    console.log(`   Error type: ${qaErrorType}`);
    console.log(`   Errors length: ${qaErrors.length} chars`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;
    const repositories = context.repositories;

    const qaErrors = context.getData<string>('qaErrors') || '';
    const qaErrorType = context.getData<string>('qaErrorType') || 'unknown';
    const qaAttempt = context.getData<number>('qaAttempt') || 1;

    console.log(`🔧 [Fixer] executePhase called - Starting to fix ${qaErrorType} errors`);
    console.log(`🔧 [Fixer] Context data:`, {
      hasQaErrors: !!qaErrors,
      qaErrorsPreview: qaErrors.substring(0, 200) + '...',
      qaErrorType: qaErrorType,
      qaAttempt: qaAttempt,
      taskId: taskId
    });

    // ⚡ LAST CHANCE MODE (Attempt 2): Opus analyst + targeted Sonnet fixer
    if (qaAttempt === 2) {
      console.log(`🚑 [Fixer] LAST CHANCE MODE activated (attempt 2)`);
      return await this.executeLastChanceMode(task, taskId, workspacePath, repositories, qaErrors, qaErrorType, context);
    }

    // 🔧 STANDARD MODE (Attempt 1): Normal Sonnet fixer
    console.log(`🔧 [Fixer] STANDARD MODE (attempt 1)`);
    return await this.executeStandardMode(task, taskId, workspacePath, repositories, qaErrors, qaErrorType, context);
  }

  /**
   * Standard Mode: Normal Sonnet fixer (attempt 1)
   */
  private async executeStandardMode(
    task: any,
    taskId: string,
    workspacePath: string | null,
    repositories: any[],
    qaErrors: string,
    qaErrorType: string,
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {

    // Initialize fixer step in task
    if (!task.orchestration.fixer) {
      task.orchestration.fixer = {
        agent: 'fixer',
        status: 'pending',
      } as any;
    }

    task.orchestration.fixer!.status = 'in_progress';
    task.orchestration.fixer!.startedAt = new Date();
    task.orchestration.fixer!.errorType = qaErrorType;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Fixer');

    await LogService.agentStarted('fixer', taskId, {
      phase: 'qa',
      metadata: {
        errorType: qaErrorType,
      },
    });

    // Get primary repository (where QA ran tests)
    const primaryRepo = repositories.length > 0 ? repositories[0] : null;
    if (!primaryRepo || !workspacePath) {
      return {
        success: false,
        error: 'No repository or workspace found',
      };
    }

    const repoPath = `${primaryRepo.name}`;

    // 🔥 Enhanced: Get rich context for smarter fixing
    const architectureBrief = context.getData<any>('architectureBrief');
    const currentStory = context.getData<any>('currentStory');
    const codebaseKnowledge = context.getData<CodebaseKnowledge>('codebaseKnowledge');
    const judgeFeedback = context.getData<string>('lastJudgeFeedback');

    // Get modified files from git
    let modifiedFiles: string[] = [];
    let gitDiff = '';
    try {
      const status = execSync('git diff --name-only HEAD~1 2>/dev/null || git diff --name-only', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000
      }).trim();
      modifiedFiles = status.split('\n').filter(f => f);

      // Get short diff for context
      gitDiff = execSync('git diff --stat HEAD~1 2>/dev/null || git diff --stat', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 5000
      }).trim();
    } catch {
      // Ignore git errors
    }

    // Run semantic verification to find anti-patterns
    let semanticSection = '';
    if (modifiedFiles.length > 0 && codebaseKnowledge) {
      const semanticResult = await SemanticVerificationService.verifyChanges(
        workspacePath!,
        modifiedFiles,
        codebaseKnowledge
      );
      if (semanticResult.violations.length > 0) {
        semanticSection = `
## 🔍 SEMANTIC ANTI-PATTERNS DETECTED

**These patterns are WRONG and must be fixed:**

${semanticResult.violations.map(v => `
### ❌ ${v.type.toUpperCase()} in \`${v.file}\`${v.line ? `:${v.line}` : ''}
- **Issue**: ${v.message}
- **Fix**: ${v.suggestion}
${v.codeSnippet ? `\`\`\`\n${v.codeSnippet}\n\`\`\`` : ''}
`).join('\n')}
`;
      }
    }

    // Build architecture patterns section
    let patternsSection = '';
    if (architectureBrief?.helperFunctions?.length > 0) {
      patternsSection = `
## 🏗️ REQUIRED PATTERNS (Use These!)

| Helper Function | File | What to Use | What NOT to Use |
|----------------|------|-------------|-----------------|
${architectureBrief.helperFunctions.slice(0, 10).map((h: any) =>
  `| \`${h.name}()\` | ${h.file} | ✅ ${h.usage} | ❌ ${h.antiPattern} |`
).join('\n')}

**🚨 If you used \`new Model()\` instead of \`createModel()\`, REPLACE IT.**
`;
    }

    // Build story context section
    let storySection = '';
    if (currentStory) {
      storySection = `
## 📖 CURRENT STORY CONTEXT

**Story**: ${currentStory.title || currentStory.id}
**Description**: ${(currentStory.description || '').substring(0, 500)}

${currentStory.acceptanceCriteria?.length > 0 ? `**Acceptance Criteria**:
${currentStory.acceptanceCriteria.map((ac: string, i: number) => `${i + 1}. ${ac}`).join('\n')}` : ''}
`;
    }

    // Build Judge feedback section
    let judgeSection = '';
    if (judgeFeedback) {
      judgeSection = `
## 🔴 JUDGE REJECTION FEEDBACK

The Judge rejected this code for these reasons:

${judgeFeedback}

**You MUST address each point above.**
`;
    }

    // Build prompt with full context
    const prompt = `# Fixer - Error Resolution (Full Context Mode)

## 📋 Error Type: ${qaErrorType}

## ❌ Errors Found:
\`\`\`
${qaErrors}
\`\`\`

${gitDiff ? `## 📁 Modified Files:
\`\`\`
${gitDiff}
\`\`\`` : ''}

${semanticSection}
${patternsSection}
${storySection}
${judgeSection}

## 🎯 FIXING STRATEGY (Follow This Order):

1. **UNDERSTAND THE ERRORS**
   - Read the error messages carefully
   - Identify the root cause (not just symptoms)

2. **CHECK PATTERNS** (CRITICAL!)
   - If error involves entity creation → Use helper functions from patterns above
   - If error involves imports → Check the file structure
   - If error involves types → Check the model definitions

3. **FIX SYSTEMATICALLY**
   - Syntax/compilation errors first
   - Import/module errors
   - Type errors
   - Anti-pattern violations (use helpers!)
   - Test failures

4. **VERIFY BEFORE COMMIT**
   - Run \`npm run build\` or \`npx tsc --noEmit\`
   - Run \`npm test\` if tests exist
   - Check that all errors are resolved

5. **COMMIT CHANGES**:
   \`\`\`bash
   cd ${repoPath}
   git add .
   git commit -m "fix: ${qaErrorType} errors - use proper patterns"
   git push origin HEAD
   \`\`\`

## ✅ SUCCESS CRITERIA:
- All errors resolved
- Code compiles without errors
- Uses correct helper functions (NOT \`new Model()\`)
- Tests pass (if applicable)
- Changes committed and pushed

## 📤 OUTPUT (JSON only):
{
  "fixed": true|false,
  "filesModified": ["file1.js", "file2.ts"],
  "changes": ["Fixed import", "Used createProject() instead of new Project()"],
  "patternsApplied": ["createProject", "createTeam"]
}

**Remember**: Quality > Speed. Fix the ROOT CAUSE, not just the symptoms.`;

    try {
      const result = await this.executeAgentFn(
        'fixer',
        prompt,
        workspacePath,
        taskId,
        'Fixer',
        undefined, // sessionId
        undefined, // fork
        undefined  // attachments
      );

      console.log(`📝 [Fixer] Output preview: ${result.output?.substring(0, 300)}...`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🔧 FIXER - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output || '(no output)'}\n\n${'='.repeat(80)}`
      );

      // Try to parse JSON output
      const parsed = this.parseFixerOutput(result.output || '');

      if (parsed.fixed) {
        console.log(`✅ [Fixer] Successfully fixed errors`);
        console.log(`   Files modified: ${parsed.filesModified.length > 0 ? parsed.filesModified.join(', ') : 'unknown'}`);

        // Update task with success
        task.orchestration.fixer!.status = 'completed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.output = result.output;
        task.orchestration.fixer!.sessionId = result.sessionId;
        task.orchestration.fixer!.usage = result.usage;
        task.orchestration.fixer!.cost_usd = result.cost;
        task.orchestration.fixer!.fixed = true;
        task.orchestration.fixer!.filesModified = parsed.filesModified;
        task.orchestration.fixer!.changes = parsed.changes;

        // Update costs
        task.orchestration.totalCost += result.cost;
        task.orchestration.totalTokens +=
          (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

        await task.save();

        NotificationService.emitAgentCompleted(
          taskId,
          'Fixer',
          `Fixed ${qaErrorType} errors: ${parsed.changes.length > 0 ? parsed.changes.join(', ') : 'See logs'}`
        );

        await LogService.agentCompleted('fixer', taskId, {
          phase: 'qa',
          metadata: {
            errorType: qaErrorType,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
          },
        });

        // Clear QA errors so QA attempt 2 can run
        context.setData('qaErrors', null);
        context.setData('qaAttempt', 2);

        return {
          success: true,
          data: {
            fixed: true,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
          },
        };
      } else {
        console.log(`❌ [Fixer] Could not fix errors`);

        // Update task with failure
        task.orchestration.fixer!.status = 'failed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.output = result.output;
        task.orchestration.fixer!.error = 'Could not fix errors';
        task.orchestration.fixer!.fixed = false;
        await task.save();

        NotificationService.emitAgentMessage(
          taskId,
          'Fixer',
          `⚠️ Fixer attempted to fix ${qaErrorType} errors but was unsuccessful. QA will create PRs with error documentation.`
        );

        await LogService.agentFailed('fixer', taskId, new Error('Could not fix errors'), {
          phase: 'qa',
        });

        // Mark that Fixer failed, so QA creates PRs with docs
        context.setData('fixerFailed', true);
        context.setData('qaAttempt', 2);

        return {
          success: false,
          error: 'Fixer could not resolve errors',
          data: {
            fixed: false,
          },
        };
      }
    } catch (error: any) {
      console.error(`❌ [Fixer] Critical error: ${error.message}`);

      // Update task with error
      task.orchestration.fixer!.status = 'failed';
      task.orchestration.fixer!.completedAt = new Date();
      task.orchestration.fixer!.error = error.message;
      task.orchestration.fixer!.fixed = false;
      await task.save();

      await LogService.agentFailed('fixer', taskId, error, {
        phase: 'qa',
      });

      context.setData('fixerFailed', true);
      context.setData('qaAttempt', 2);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Last Chance Mode: Opus analyst + targeted Sonnet fixer (attempt 2)
   * Max budget: $3.00
   */
  private async executeLastChanceMode(
    task: any,
    taskId: string,
    workspacePath: string | null,
    repositories: any[],
    qaErrors: string,
    qaErrorType: string,
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const MAX_BUDGET = 3.00;
    let totalCost = 0;
    let totalTokens = 0;

    console.log(`\n🚑 [LastChance] Starting Last Chance Recovery`);
    console.log(`   Error type: ${qaErrorType}`);
    console.log(`   Max budget: $${MAX_BUDGET}`);

    // Initialize fixer step with lastChance tracking
    if (!task.orchestration.fixer) {
      task.orchestration.fixer = { agent: 'fixer', status: 'pending' } as any;
    }

    task.orchestration.fixer!.status = 'in_progress';
    task.orchestration.fixer!.startedAt = new Date();
    task.orchestration.fixer!.errorType = qaErrorType;
    task.orchestration.fixer!.lastChanceMode = true;
    await task.save();

    NotificationService.emitConsoleLog(taskId, 'info', `🚑 Last Chance Recovery initiated (Opus analyst + Sonnet fixer)`);

    try {
      // ===== STEP 1: ANALYST (OPUS) - Analyze if automatable =====
      console.log(`\n📊 [LastChance] Step 1: Running Opus analyst`);
      NotificationService.emitConsoleLog(taskId, 'info', `📊 Analyzing errors with Opus to determine if automatable...`);

      const analysisPrompt = `You are a Senior Error Analysis Expert. Analyze the QA failure report to determine if errors can be automatically fixed.

# QA Failure Report

${qaErrors}

# Error Type
${qaErrorType}

# Your Mission

Analyze the QA report and determine:

1. **Are these errors automatable?**
   - ✅ YES for: lint errors, syntax errors, missing imports, jest→vitest migration, simple test failures
   - ❌ NO for: logic bugs, business logic errors, architecture issues, integration failures

2. **What specific fixes are needed?**
   - List exact files and line numbers
   - Describe the mechanical changes needed

3. **Can this be fixed in $3 budget?**
   - Estimate: lint fixes ($0.10), test migration ($0.50), imports ($0.20)

# Output Format (MANDATORY JSON)

If automatable:
\`\`\`json
{
  "automatable": true,
  "fixes": [
    {
      "file": "src/components/MessageMedia.jsx",
      "line": 81,
      "issue": "Lexical declaration in case block",
      "fix": "Wrap case block in curly braces",
      "difficulty": "easy",
      "estimatedCost": 0.10
    }
  ],
  "totalEstimatedCost": 0.80,
  "reasoning": "All errors are mechanical (lint rules, syntax) - can be auto-fixed",
  "recommendation": "PROCEED"
}
\`\`\`

If NOT automatable:
\`\`\`json
{
  "automatable": false,
  "reasoning": "Errors require business logic changes or architecture decisions",
  "recommendation": "ESCALATE_TO_HUMAN",
  "humanActionRequired": "Review test logic - requires domain knowledge"
}
\`\`\`

**CRITICAL**: Your first character must be { and last character must be }. Output ONLY valid JSON.`;

      const analysisResult = await this.executeAgentFn(
        'recovery-analyst',
        analysisPrompt,
        workspacePath,
        taskId,
        'Recovery Analyst',
        undefined,
        undefined,
        undefined
      );

      totalCost += analysisResult.cost || 0;
      totalTokens += (analysisResult.usage?.input_tokens || 0) + (analysisResult.usage?.output_tokens || 0);

      console.log(`📊 [LastChance] Analyst completed (cost: $${analysisResult.cost?.toFixed(2)})`);

      // Parse analysis result
      const analysis = this.parseAnalysisOutput(analysisResult.output || '');

      // Store analysis in task
      if (!task.orchestration.fixer!.lastChanceAnalysis) {
        task.orchestration.fixer!.lastChanceAnalysis = {};
      }
      task.orchestration.fixer!.lastChanceAnalysis = analysis;
      task.orchestration.fixer!.analysisCost = analysisResult.cost;
      await task.save();

      if (!analysis.automatable) {
        // Errors are NOT automatable - escalate to human
        console.log(`⚠️  [LastChance] Errors not automatable - escalating to human`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Recovery Analyst: Errors require human intervention - ${analysis.reasoning}`
        );

        task.orchestration.fixer!.status = 'completed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.fixed = false;
        task.orchestration.fixer!.escalated = true;
        task.orchestration.totalCost += totalCost;
        task.orchestration.totalTokens += totalTokens;
        await task.save();

        // Set qaAttempt to 3 so QA creates PRs
        context.setData('qaAttempt', 3);

        return {
          success: true,
          data: {
            automatable: false,
            escalated: true,
            reasoning: analysis.reasoning,
          },
          metrics: {
            cost_usd: totalCost,
          },
        };
      }

      // Check budget
      if (analysis.totalEstimatedCost && analysis.totalEstimatedCost > MAX_BUDGET) {
        console.log(`⚠️  [LastChance] Estimated cost ($${analysis.totalEstimatedCost}) exceeds budget ($${MAX_BUDGET})`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Recovery budget exceeded: $${analysis.totalEstimatedCost} > $${MAX_BUDGET} - escalating to human`
        );

        task.orchestration.fixer!.status = 'completed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.fixed = false;
        task.orchestration.fixer!.budgetExceeded = true;
        task.orchestration.totalCost += totalCost;
        task.orchestration.totalTokens += totalTokens;
        await task.save();

        context.setData('qaAttempt', 3);

        return {
          success: true,
          data: {
            automatable: true,
            budgetExceeded: true,
            escalated: true,
          },
          metrics: {
            cost_usd: totalCost,
          },
        };
      }

      // ===== STEP 2: FIXER (SONNET) - Apply fixes =====
      console.log(`\n🔧 [LastChance] Step 2: Running Sonnet fixer`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔧 Applying ${analysis.fixes?.length || 0} automated fixes...`
      );

      const primaryRepo = repositories.length > 0 ? repositories[0] : null;
      if (!primaryRepo) {
        return { success: false, error: 'No repository found' };
      }

      // 🔥 Enhanced: Get architecture patterns for Last Chance mode too
      const architectureBrief = context.getData<any>('architectureBrief');
      let patternsSection = '';
      if (architectureBrief?.helperFunctions?.length > 0) {
        patternsSection = `
# 🏗️ REQUIRED PATTERNS (Use These!)

| Helper Function | File | Usage |
|----------------|------|-------|
${architectureBrief.helperFunctions.slice(0, 8).map((h: any) =>
  `| \`${h.name}()\` | ${h.file} | ${h.usage} |`
).join('\n')}

**🚨 If any fix involves entity creation, USE the helper functions above, NOT \`new Model()\`.**
`;
      }

      const fixerPrompt = `You are a Targeted Fixer Agent with full codebase knowledge.

# Analysis from Recovery Analyst

${JSON.stringify(analysis, null, 2)}

# Fixes to Apply

${analysis.fixes?.map((fix: any, i: number) => `
## Fix ${i + 1}: ${fix.file}:${fix.line}

**Issue**: ${fix.issue}
**Fix**: ${fix.fix}
**Difficulty**: ${fix.difficulty}
`).join('\n')}

${patternsSection}

# Your Mission

Apply the fixes listed above:

1. **Read** each file mentioned
2. **Understand the context** - check imports, relationships
3. **Apply the fix** using Edit tool
4. **Use correct patterns** - helper functions, NOT \`new Model()\`
5. **Verify** - run \`npx tsc --noEmit\` if TypeScript
6. **Commit** your changes:
   \`\`\`bash
   cd ${primaryRepo.name}
   git add .
   git commit -m "fix: Apply Last Chance Recovery fixes - ${qaErrorType}"
   git push origin HEAD
   \`\`\`

7. **Output** JSON result

# Output Format (MANDATORY JSON)

\`\`\`json
{
  "fixed": true,
  "filesModified": ["src/components/MessageMedia.jsx"],
  "changes": ["Wrapped case blocks in curly braces", "Used createProject() instead of new Project()"],
  "patternsApplied": ["createProject"],
  "summary": "Applied 2 lint fixes"
}
\`\`\`

If you cannot fix:
\`\`\`json
{
  "fixed": false,
  "attemptedFixes": ["Tried to fix MessageMedia.jsx but file structure unexpected"],
  "summary": "Could not apply fixes - manual intervention needed"
}
\`\`\`

**CRITICAL**: Use tools immediately (Read, Edit, Bash). Output ONLY JSON at the end.`;

      const fixerResult = await this.executeAgentFn(
        'fixer',
        fixerPrompt,
        workspacePath,
        taskId,
        'Recovery Fixer',
        undefined,
        undefined,
        undefined
      );

      totalCost += fixerResult.cost || 0;
      totalTokens += (fixerResult.usage?.input_tokens || 0) + (fixerResult.usage?.output_tokens || 0);

      console.log(`🔧 [LastChance] Fixer completed (cost: $${fixerResult.cost?.toFixed(2)})`);

      // Emit full output
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🚑 LAST CHANCE RECOVERY - FULL OUTPUT\n${'='.repeat(80)}\n\n${fixerResult.output || '(no output)'}\n\n${'='.repeat(80)}`
      );

      // Parse fixer result
      const fixerParsed = this.parseFixerOutput(fixerResult.output || '');

      task.orchestration.fixer!.fixerCost = fixerResult.cost;
      task.orchestration.fixer!.totalCost = totalCost;
      task.orchestration.totalCost += totalCost;
      task.orchestration.totalTokens += totalTokens;

      if (fixerParsed.fixed) {
        console.log(`✅ [LastChance] Successfully fixed errors`);
        console.log(`   Files modified: ${fixerParsed.filesModified.join(', ')}`);
        console.log(`   Total cost: $${totalCost.toFixed(2)}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Last Chance Recovery complete - fixed ${fixerParsed.filesModified.length} files for $${totalCost.toFixed(2)}`
        );

        task.orchestration.fixer!.status = 'completed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.fixed = true;
        task.orchestration.fixer!.filesModified = fixerParsed.filesModified;
        task.orchestration.fixer!.changes = fixerParsed.changes;
        task.orchestration.fixer!.output = fixerResult.output;
        task.orchestration.fixer!.sessionId = fixerResult.sessionId;
        task.orchestration.fixer!.usage = fixerResult.usage;
        task.orchestration.fixer!.cost_usd = totalCost;
        await task.save();

        await LogService.agentCompleted('fixer', taskId, {
          phase: 'qa',
          metadata: {
            filesModified: fixerParsed.filesModified,
            changes: fixerParsed.changes,
            totalCost,
            lastChanceMode: true,
          },
        });

        // Clear errors and set qaAttempt to 3 for final QA run
        context.setData('qaErrors', null);
        context.setData('qaAttempt', 3);

        return {
          success: true,
          data: {
            fixed: true,
            filesModified: fixerParsed.filesModified,
            changes: fixerParsed.changes,
          },
          metrics: {
            cost_usd: totalCost,
            files_modified: fixerParsed.filesModified.length,
          },
        };
      } else {
        console.log(`❌ [LastChance] Could not fix errors`);

        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Last Chance Recovery Fixer could not apply fixes - errors will be documented in PR`
        );

        task.orchestration.fixer!.status = 'completed';
        task.orchestration.fixer!.completedAt = new Date();
        task.orchestration.fixer!.fixed = false;
        task.orchestration.fixer!.output = fixerResult.output;
        await task.save();

        await LogService.agentFailed('fixer', taskId, new Error('Could not apply fixes'), {
          phase: 'qa',
        });

        context.setData('fixerFailed', true);
        context.setData('qaAttempt', 3);

        return {
          success: false,
          error: 'Last Chance Recovery could not apply fixes',
          data: {
            fixed: false,
          },
          metrics: {
            cost_usd: totalCost,
          },
        };
      }
    } catch (error: any) {
      console.error(`❌ [LastChance] Critical error: ${error.message}`);

      task.orchestration.fixer!.status = 'failed';
      task.orchestration.fixer!.completedAt = new Date();
      task.orchestration.fixer!.error = error.message;
      task.orchestration.fixer!.fixed = false;
      task.orchestration.totalCost += totalCost;
      task.orchestration.totalTokens += totalTokens;
      await task.save();

      await LogService.agentFailed('fixer', taskId, error, {
        phase: 'qa',
      });

      context.setData('fixerFailed', true);
      context.setData('qaAttempt', 3);

      return {
        success: false,
        error: error.message,
        metrics: {
          cost_usd: totalCost,
        },
      };
    }
  }

  /**
   * Parse Analyst output (expects JSON)
   * 🔥 FIX: Use OutputParser instead of greedy regex
   */
  private parseAnalysisOutput(output: string): {
    automatable: boolean;
    fixes?: any[];
    totalEstimatedCost?: number;
    reasoning?: string;
    recommendation?: string;
  } {
    // 🔥 Use centralized OutputParser for robust JSON extraction
    const result = OutputParser.extractJSON(output);

    if (result.success && result.data) {
      const parsed = result.data;
      return {
        automatable: parsed.automatable === true,
        fixes: parsed.fixes || [],
        totalEstimatedCost: parsed.totalEstimatedCost || 0,
        reasoning: parsed.reasoning || '',
        recommendation: parsed.recommendation || '',
      };
    }

    console.warn(`⚠️ Failed to parse Analyst output as JSON: ${result.error}`);

    // Fallback: not automatable
    return {
      automatable: false,
      reasoning: 'Could not parse analysis - defaulting to not automatable',
    };
  }

  /**
   * Parse Fixer output (expects JSON)
   * 🔥 FIX: Use OutputParser instead of greedy regex
   */
  private parseFixerOutput(output: string): {
    fixed: boolean;
    changes: string[];
    filesModified: string[];
  } {
    // 🔥 Use centralized OutputParser for robust JSON extraction
    const result = OutputParser.extractJSON(output);

    if (result.success && result.data) {
      const parsed = result.data;

      // Ensure changes and filesModified are always arrays
      const changes = Array.isArray(parsed.changes) ? parsed.changes :
                     (parsed.changes ? [parsed.changes] : []);
      const filesModified = Array.isArray(parsed.filesModified) ? parsed.filesModified :
                           (parsed.filesModified ? [parsed.filesModified] : []);

      return {
        fixed: parsed.fixed === true,
        changes,
        filesModified,
      };
    }

    console.warn(`⚠️ Failed to parse Fixer output as JSON: ${result.error}`);

    // Fallback: check if output says "fixed"
    const fixed = output.toLowerCase().includes('fixed') && !output.toLowerCase().includes('could not fix');

    return {
      fixed,
      changes: [],
      filesModified: []
    };
  }
}
