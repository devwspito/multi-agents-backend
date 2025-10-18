import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * Fixer Phase
 *
 * Automatically fixes build, lint, and test errors reported by QA.
 * Executes ONLY when QA fails on first attempt.
 *
 * Flow:
 * 1. QA (attempt 1) fails → Fixer called
 * 2. Fixer reads QA error output
 * 3. Fixer modifies code to fix errors
 * 4. Fixer commits changes
 * 5. Returns to QA (attempt 2)
 *
 * Max attempts: 1 (if Fixer fails, QA creates PRs with error docs)
 */
export class FixerPhase extends BasePhase {
  readonly name = 'Fixer';
  readonly description = 'Fixing QA-reported errors (lint, build, test)';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if QA didn't fail (no errors to fix)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const qaErrors = context.getData<string>('qaErrors');
    const qaAttempt = context.getData<number>('qaAttempt') || 1;

    // Only run if QA failed on attempt 1
    if (!qaErrors || qaAttempt !== 1) {
      console.log(`[SKIP] Fixer not needed (QA passed or already on attempt 2)`);
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
    const repositories = context.repositories;

    const qaErrors = context.getData<string>('qaErrors') || '';
    const qaErrorType = context.getData<string>('qaErrorType') || 'unknown';

    console.log(`🔧 [Fixer] Starting to fix ${qaErrorType} errors`);

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

    // Build prompt with QA errors
    const prompt = `# QA Detected Errors

## Error Type: ${qaErrorType}

## Error Output from QA:
\`\`\`
${qaErrors}
\`\`\`

## Your Task:
Fix ONLY the errors shown above. Read the files mentioned, fix the issues, commit your changes.

## Repository:
Working directory: ${workspacePath}
Target repository: ${repoPath}/

**CRITICAL**: After fixing, you MUST commit:
1. cd ${repoPath}
2. git add .
3. git commit -m "Fix ${qaErrorType} errors"
4. git push

Output your result as JSON with format specified in your instructions.`;

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
        console.log(`   Files modified: ${parsed.filesModified?.join(', ') || 'unknown'}`);

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
          `Fixed ${qaErrorType} errors: ${parsed.changes?.join(', ') || 'See logs'}`
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
   * Parse Fixer output (expects JSON)
   */
  private parseFixerOutput(output: string): {
    fixed: boolean;
    changes?: string[];
    filesModified?: string[];
  } {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          fixed: parsed.fixed === true,
          changes: parsed.changes || [],
          filesModified: parsed.filesModified || [],
        };
      }
    } catch (error) {
      console.warn(`⚠️ Failed to parse Fixer output as JSON`);
    }

    // Fallback: check if output says "fixed"
    const fixed = output.toLowerCase().includes('fixed') && !output.toLowerCase().includes('could not fix');

    return { fixed };
  }
}
