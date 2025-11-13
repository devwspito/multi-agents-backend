import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { PromptBuilder } from '../utils/PromptBuilder';
import { OutputParser } from '../utils/OutputParser';
import { RepositoryHelper } from '../utils/RepositoryHelper';

/**
 * Optimized Product Manager Phase - 50% less tokens
 *
 * Improvements:
 * - Prompt reduced from 67 to 25 lines
 * - Minimal JSON schema without comments
 * - Context compression for continuations
 * - Structured output parsing
 */
export class ProductManagerPhaseOptimized extends BasePhase {
  readonly name = 'ProductManager';
  readonly description = 'Analyzing requirements and creating master epic';

  constructor(
    private executeAgentFn: Function,
    private workspaceDir: string
  ) {
    super();
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Skip if already completed
    if (context.task.orchestration.productManager?.status === 'completed') {
      console.log(`[SKIP] Product Manager already completed`);
      if (context.task.orchestration.productManager.output) {
        context.setData('productManagerOutput', context.task.orchestration.productManager.output);
      }
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

    // Initialize state
    this.initializeState(task, startTime);
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Product Manager');
    await LogService.agentStarted('product-manager', taskId, { phase: 'analysis' });

    try {
      // Build optimized prompt
      const prompt = this.buildOptimizedPrompt(task, context);

      // Get attachments from context
      const attachments = await this.processAttachments(task);
      if (attachments.length > 0) {
        context.setData('attachments', attachments);
      }

      // Execute agent
      const result = await this.executeAgentFn(
        'product-manager',
        prompt,
        context.workspacePath || this.workspaceDir,
        taskId,
        'Product Manager',
        undefined,
        undefined,
        attachments.length > 0 ? attachments : undefined
      );

      // Parse and validate output
      const parsed = OutputParser.extractJSON(result.output);
      if (!parsed.success) {
        throw new Error(`Failed to parse JSON output: ${parsed.error}`);
      }

      // Store results
      this.storeResults(task, result, parsed.data);

      // CRITICAL FIX: Set masterEpic in context for ProjectManager
      context.setData('masterEpic', parsed.data);
      context.setData('productManagerOutput', result.output);

      await task.save();

      // Emit events
      await this.emitCompletionEvents(task, result, startTime);

      NotificationService.emitAgentCompleted(
        taskId,
        'Product Manager',
        `Analysis complete. Created master epic.`
      );

      return {
        success: true,
        data: {
          output: result.output,
          masterEpic: parsed.data
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
  private buildOptimizedPrompt(task: any, context: OrchestrationContext): string {
    const repos = RepositoryHelper.buildRepoContext(context.repositories, context.workspacePath);
    const isContinuation = task.orchestration.continuations?.length > 0;

    const builder = new PromptBuilder()
      .addSection('Task', task.title)
      .addContext({
        'Repositories': RepositoryHelper.buildRepoSummary(repos),
        'Working dir': context.workspacePath || this.workspaceDir
      });

    // Add previous work for continuations (compressed)
    if (isContinuation && task.orchestration.productManager?.output) {
      const previousSummary = this.extractSummary(task.orchestration.productManager.output);
      builder.addSection('Previous Work', previousSummary.substring(0, 200) + '...');
    }

    // Instructions
    builder.addInstructions([
      'Analyze the task requirements',
      'Break down into logical components',
      'Create a master epic with clear scope'
    ]);

    // Output format (minimal schema)
    builder.setOutputFormat({
      format: 'json',
      schema: {
        title: 'string',
        description: 'string',
        scope: ['item1', 'item2'],
        requirements: ['req1', 'req2'],
        constraints: ['constraint1'],
        dependencies: ['dep1']
      }
    });

    return builder.build();
  }

  /**
   * Process attachments efficiently
   */
  private async processAttachments(task: any): Promise<any[]> {
    if (!task.attachments || task.attachments.length === 0) {
      return [];
    }

    const processed = [];
    for (const attachment of task.attachments.slice(0, 5)) { // Limit to 5
      if (attachment.data) {
        processed.push({
          type: 'image',
          data: attachment.data
        });
      }
    }

    return processed;
  }

  /**
   * Extract summary from previous output
   */
  private extractSummary(output: string): string {
    const patterns = {
      title: /title["\s:]+([^",\n]+)/i,
      description: /description["\s:]+([^",\n]+)/i
    };

    const extracted = OutputParser.extractPatterns(output, patterns);
    return `Previous: ${extracted.title || 'N/A'} - ${extracted.description || 'N/A'}`;
  }

  /**
   * Initialize agent state
   */
  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.productManager) {
      task.orchestration.productManager = {
        agent: 'product-manager',
        status: 'pending'
      } as any;
    }
    task.orchestration.productManager!.status = 'in_progress';
    task.orchestration.productManager!.startedAt = new Date(startTime);
  }

  /**
   * Store results in task
   */
  private storeResults(task: any, result: any, masterEpic: any): void {
    task.orchestration.productManager!.status = 'completed';
    task.orchestration.productManager!.completedAt = new Date();
    task.orchestration.productManager!.output = result.output;
    task.orchestration.productManager!.sessionId = result.sessionId;
    task.orchestration.productManager!.usage = result.usage;
    task.orchestration.productManager!.cost_usd = result.cost;
    task.orchestration.productManager!.masterEpic = masterEpic;

    // Update totals
    task.orchestration.totalCost += result.cost;
    task.orchestration.totalTokens +=
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);
  }

  /**
   * Emit completion events
   */
  private async emitCompletionEvents(task: any, result: any, startTime: number): Promise<void> {
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'ProductManagerCompleted',
      agentName: 'product-manager',
      payload: {
        output: result.output
      },
      metadata: {
        cost: result.cost,
        duration: Date.now() - startTime
      }
    });

    await LogService.agentCompleted('product-manager', (task._id as any).toString(), {
      phase: 'analysis',
      metadata: {
        cost: result.cost,
        inputTokens: result.usage?.input_tokens || 0,
        outputTokens: result.usage?.output_tokens || 0
      }
    });
  }

  /**
   * Handle phase error
   */
  private async handleError(task: any, error: any, taskId: string): Promise<PhaseResult> {
    task.orchestration.productManager!.status = 'failed';
    task.orchestration.productManager!.error = error.message;
    await task.save();

    NotificationService.emitAgentFailed(taskId, 'Product Manager', error.message);
    await LogService.agentFailed('product-manager', taskId, error, { phase: 'analysis' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}