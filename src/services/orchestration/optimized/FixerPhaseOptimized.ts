import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { PromptBuilder } from '../utils/PromptBuilder';
import { OutputParser } from '../utils/OutputParser';

/**
 * Optimized Fixer Phase - Already efficient, minor improvements
 *
 * Improvements:
 * - Uses PromptBuilder for consistency
 * - Better error categorization
 * - Structured output parsing
 * - Clear success metrics
 */
export class FixerPhaseOptimized extends BasePhase {
  readonly name = 'Fixer';
  readonly description = 'Resolving QA-detected errors';

  constructor(
    private executeAgentFn: Function,
    private workspaceDir: string
  ) {
    super();
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    // FIXED: Run if QA detected errors and we haven't exceeded max attempts
    const qaErrors = context.getData<string>('qaErrors');
    const fixerAttempts = context.getData<number>('fixerAttempts') || 0;
    const MAX_FIXER_ATTEMPTS = 2;

    // Skip if no errors or exceeded max attempts
    if (!qaErrors || fixerAttempts >= MAX_FIXER_ATTEMPTS) {
      console.log(`[SKIP] Fixer: No errors or max attempts reached (${fixerAttempts}/${MAX_FIXER_ATTEMPTS})`);
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

    // Get error context
    const qaErrors = context.getData<string>('qaErrors');
    const errorType = context.getData<string>('qaErrorType') || 'unknown';

    if (!qaErrors) {
      return {
        success: false,
        error: 'No QA errors provided to fix'
      };
    }

    // Initialize state
    this.initializeState(task, startTime);
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Fixer');
    await LogService.agentStarted('fixer', taskId, {
      phase: 'error-resolution',
      errorType
    });

    try {
      // Build optimized prompt
      const prompt = this.buildOptimizedPrompt(errorType, qaErrors, context);

      // Execute fixer
      const result = await this.executeAgentFn(
        'fixer',
        prompt,
        context.workspacePath || this.workspaceDir,
        taskId,
        'Fixer',
        undefined,
        undefined,
        context.getData('attachments')
      );

      // Parse output
      const parsed = OutputParser.extractJSON(result.output);
      const fixData = parsed.success ? parsed.data : this.parseTextOutput(result.output);

      // Store results
      this.storeResults(task, result, fixData);
      await task.save();

      // Prepare for QA retry - FIXED: increment attempts and clear errors if fixed
      const currentAttempts = context.getData<number>('fixerAttempts') || 0;
      context.setData('fixerAttempts', currentAttempts + 1);
      context.setData('qaAttempt', (context.getData<number>('qaAttempt') || 1) + 1);
      context.setData('fixerApplied', true);
      context.setData('fixerOutput', fixData);

      // Clear errors if fix was successful
      if (fixData.fixed) {
        context.setData('qaErrors', null);
        context.setData('qaErrorType', null);
      }

      // Emit events
      await this.emitCompletionEvents(task, fixData, startTime);

      const fixedCount = fixData.filesFixed?.length || fixData.changes?.length || 0;
      NotificationService.emitAgentCompleted(
        taskId,
        'Fixer',
        `Applied fixes to ${fixedCount} files. QA will re-validate.`
      );

      return {
        success: true,
        data: {
          fixed: fixData.fixed || true,
          filesFixed: fixedCount,
          errorType,
          changes: fixData.changes
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          duration_ms: Date.now() - startTime
        }
      };

    } catch (error: any) {
      return this.handleError(task, error, taskId);
    }
  }

  /**
   * Build optimized prompt using PromptBuilder
   */
  private buildOptimizedPrompt(
    errorType: string,
    qaErrors: string,
    context: OrchestrationContext
  ): string {
    const strategy = this.getFixStrategy(errorType);

    return new PromptBuilder()
      .addSection('Error Type', errorType.toUpperCase())
      .addSection('QA Output', qaErrors.substring(0, 1500))
      .addContext({
        'Working directory': context.workspacePath || this.workspaceDir,
        'Priority': strategy.priority,
        'Common cause': strategy.commonCause
      })
      .addInstructions([
        '1. Analyze the error output',
        `2. Apply fix strategy: ${strategy.approach}`,
        '3. Verify fix compiles',
        '4. Document changes made'
      ])
      .addCriteria([
        'Fix root cause, not symptoms',
        'Make minimal changes',
        'Preserve existing functionality',
        'Add comments if fix is non-obvious'
      ])
      .setOutputFormat({
        format: 'json',
        schema: {
          fixed: true,
          errorType: 'string',
          rootCause: 'string',
          changes: [
            {
              file: 'path/to/file',
              line: 42,
              description: 'what was fixed'
            }
          ],
          verification: 'how you verified the fix'
        }
      })
      .build();
  }

  /**
   * Get fix strategy based on error type
   */
  private getFixStrategy(errorType: string): {
    priority: string;
    commonCause: string;
    approach: string;
  } {
    const strategies: Record<string, any> = {
      IMPORT: {
        priority: 'HIGH',
        commonCause: 'Missing or incorrect import paths',
        approach: 'Fix import statements and module references'
      },
      BUILD: {
        priority: 'HIGH',
        commonCause: 'Syntax errors or missing dependencies',
        approach: 'Fix syntax and ensure all deps are installed'
      },
      TEST: {
        priority: 'MEDIUM',
        commonCause: 'Broken tests or incorrect assertions',
        approach: 'Update test expectations or fix implementation'
      },
      TYPE: {
        priority: 'MEDIUM',
        commonCause: 'TypeScript type mismatches',
        approach: 'Add type annotations or fix type errors'
      },
      STARTUP: {
        priority: 'CRITICAL',
        commonCause: 'Missing modules or config issues',
        approach: 'Fix module resolution and startup sequence'
      },
      LINT: {
        priority: 'LOW',
        commonCause: 'Code style violations',
        approach: 'Apply linting fixes'
      }
    };

    return strategies[errorType] || {
      priority: 'MEDIUM',
      commonCause: 'Unknown issue',
      approach: 'Analyze and fix the root cause'
    };
  }

  /**
   * Parse text output if JSON parsing fails
   */
  private parseTextOutput(output: string): any {
    const result: any = {
      fixed: false,
      changes: []
    };

    // Check if fix was successful
    if (output.toLowerCase().includes('fixed') ||
        output.toLowerCase().includes('resolved') ||
        output.toLowerCase().includes('success')) {
      result.fixed = true;
    }

    // Extract file changes
    const filePattern = /(?:fixed|modified|updated)\s+([^\s]+\.(ts|js|tsx|jsx|json))/gi;
    let match;
    while ((match = filePattern.exec(output)) !== null) {
      result.changes.push({
        file: match[1],
        description: 'Fixed'
      });
    }

    return result;
  }

  /**
   * Initialize state
   */
  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.fixer) {
      task.orchestration.fixer = {
        agent: 'fixer',
        status: 'pending'
      } as any;
    }
    task.orchestration.fixer!.status = 'in_progress';
    task.orchestration.fixer!.startedAt = new Date(startTime);
  }

  /**
   * Store results
   */
  private storeResults(task: any, result: any, fixData: any): void {
    task.orchestration.fixer!.status = 'completed';
    task.orchestration.fixer!.completedAt = new Date();
    task.orchestration.fixer!.output = result.output;
    task.orchestration.fixer!.sessionId = result.sessionId;
    task.orchestration.fixer!.usage = result.usage;
    task.orchestration.fixer!.cost_usd = result.cost;
    task.orchestration.fixer!.fixesApplied = fixData;

    // Update totals
    task.orchestration.totalCost += result.cost;
    task.orchestration.totalTokens +=
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
  }

  /**
   * Emit completion events
   */
  private async emitCompletionEvents(task: any, fixData: any, startTime: number): Promise<void> {
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'FixerCompleted',
      agentName: 'fixer',
      payload: {
        fixed: fixData.fixed,
        changes: fixData.changes?.length || 0
      },
      metadata: {
        cost: task.orchestration.fixer!.cost_usd,
        duration: Date.now() - startTime
      }
    });

    await LogService.agentCompleted('fixer', (task._id as any).toString(), {
      phase: 'error-resolution',
      metadata: {
        fixed: fixData.fixed,
        changesCount: fixData.changes?.length || 0
      }
    });
  }

  /**
   * Handle error
   */
  private async handleError(task: any, error: any, taskId: string): Promise<PhaseResult> {
    task.orchestration.fixer!.status = 'failed';
    task.orchestration.fixer!.error = error.message;
    await task.save();

    // Even on error, allow QA to retry
    const context = { getData: () => null, setData: () => {} } as any;
    context.setData('qaAttempt', 2);

    NotificationService.emitAgentFailed(taskId, 'Fixer', error.message);
    await LogService.agentFailed('fixer', taskId, error, { phase: 'error-resolution' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}