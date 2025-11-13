import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { PromptBuilder } from '../utils/PromptBuilder';
import { OutputParser } from '../utils/OutputParser';
import { RepositoryHelper } from '../utils/RepositoryHelper';

/**
 * Optimized Project Manager Phase - 60% less tokens
 *
 * Improvements:
 * - Prompt reduced from 90+ lines to 30 lines
 * - Validation feedback compressed to bullet points
 * - Single fix suggestion instead of 3 options
 * - Extracted validation logic to separate methods
 */
export class ProjectManagerPhaseOptimized extends BasePhase {
  readonly name = 'ProjectManager';
  readonly description = 'Creating epics from master requirements';

  private readonly MAX_VALIDATION_ATTEMPTS = 2; // Reduced from 3

  constructor(
    private executeAgentFn: Function,
    private workspaceDir: string
  ) {
    super();
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task
    const Task = require('../../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    if (context.task.orchestration.projectManager?.status === 'completed') {
      console.log(`[SKIP] Project Manager already completed`);
      const epics = context.task.orchestration.projectManager.epics;
      if (epics) {
        context.setData('epics', epics);
        context.setData('epicRegistry', this.buildEpicRegistry(epics));
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

    // Initialize state
    this.initializeState(task, startTime);
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Project Manager');
    await LogService.agentStarted('project-manager', taskId, { phase: 'planning' });

    let attempt = 0;
    let validationErrors: string[] = [];

    try {
      while (attempt < this.MAX_VALIDATION_ATTEMPTS) {
        attempt++;

        // Build optimized prompt
        const prompt = this.buildOptimizedPrompt(
          task,
          context,
          attempt > 1 ? validationErrors : undefined
        );

        // Execute agent
        const result = await this.executeAgentFn(
          'project-manager',
          prompt,
          context.workspacePath || this.workspaceDir,
          taskId,
          'Project Manager',
          undefined,
          undefined,
          context.getData('attachments')
        );

        // Parse output
        const parsed = OutputParser.extractJSON(result.output);
        if (!parsed.success) {
          validationErrors = [`Invalid JSON: ${parsed.error}`];
          continue;
        }

        // Validate epics
        const validation = this.validateEpics(parsed.data, context);
        if (validation.valid) {
          // Success - store and return
          return this.handleSuccess(task, result, parsed.data, startTime, context);
        }

        // Validation failed - prepare for retry
        validationErrors = validation.errors;
        console.log(`[ProjectManager] Validation attempt ${attempt} failed: ${validationErrors.length} errors`);
      }

      // Max attempts reached
      throw new Error(`Failed after ${attempt} attempts. Errors: ${validationErrors.join('; ')}`);

    } catch (error: any) {
      return this.handleError(task, error, taskId);
    }
  }

  /**
   * Build optimized prompt with minimal context
   */
  private buildOptimizedPrompt(
    task: any,
    context: OrchestrationContext,
    validationErrors?: string[]
  ): string {
    const repos = RepositoryHelper.buildRepoContext(context.repositories, context.workspacePath);
    // FIXED: Now properly reads masterEpic from context
    const masterEpic = context.getData('masterEpic') || context.getData('productManagerOutput');

    const builder = new PromptBuilder()
      .addSection('Task', task.title)
      .addSection('Master Epic', this.extractMasterEpicSummary(masterEpic));

    // Add validation feedback if retry
    if (validationErrors && validationErrors.length > 0) {
      builder.addSection('⚠️ Fix These Issues', validationErrors.map(e => `• ${e}`));
    }

    builder
      .addContext({
        'Repositories': repos.map(r => r.name).join(', '),
        'Workspace': context.workspacePath || this.workspaceDir
      })
      .addInstructions([
        'Break master epic into 2-4 independent epics',
        'Each epic should be completable in 1-2 days',
        'Assign clear files/domains to each epic',
        'Ensure no file overlaps between epics'
      ])
      .setOutputFormat({
        format: 'json',
        example: JSON.stringify([
          {
            id: 'epic-1',
            title: 'Core Feature',
            description: 'Implement main functionality',
            scope: ['src/core/', 'tests/core/'],
            assignedFiles: ['src/core/service.ts'],
            dependencies: []
          }
        ], null, 2)
      });

    return builder.build();
  }

  /**
   * Extract master epic summary (minimal)
   */
  private extractMasterEpicSummary(masterEpic: any): string {
    if (!masterEpic) return 'Create a software solution';

    // FIXED: Handle both object (from context) and string (fallback)
    if (typeof masterEpic === 'object') {
      const title = masterEpic.title || 'Task';
      const desc = masterEpic.description || '';
      return `${title}: ${desc.substring(0, 100)}`;
    }

    // Fallback for string input
    const parsed = OutputParser.extractJSON(masterEpic);
    if (parsed.success && parsed.data) {
      const title = parsed.data.title || 'Task';
      const desc = parsed.data.description || '';
      return `${title}: ${desc.substring(0, 100)}`;
    }

    return masterEpic.substring(0, 200);
  }

  /**
   * Validate epics with simplified logic
   */
  private validateEpics(
    epics: any[],
    context: OrchestrationContext
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Basic validation
    if (!Array.isArray(epics)) {
      errors.push('Output must be an array of epics');
      return { valid: false, errors };
    }

    // FIXED: Validate epics not empty
    if (epics.length === 0) {
      errors.push('Must have at least 1 epic');
      return { valid: false, errors };
    }

    if (epics.length > 5) {
      errors.push('Maximum 5 epics allowed');
    }

    // Check for required fields
    const seenFiles = new Set<string>();
    const seenIds = new Set<string>();

    for (let i = 0; i < epics.length; i++) {
      const epic = epics[i];

      // Required fields
      if (!epic.id) errors.push(`Epic ${i + 1}: missing id`);
      if (!epic.title) errors.push(`Epic ${i + 1}: missing title`);
      if (!epic.scope || !Array.isArray(epic.scope)) {
        errors.push(`Epic ${i + 1}: missing scope array`);
      }

      // Check for duplicate IDs
      if (epic.id) {
        if (seenIds.has(epic.id)) {
          errors.push(`Duplicate epic ID: ${epic.id}`);
        }
        seenIds.add(epic.id);
      }

      // Check for file overlaps (simplified)
      if (epic.assignedFiles && Array.isArray(epic.assignedFiles)) {
        for (const file of epic.assignedFiles) {
          if (seenFiles.has(file)) {
            errors.push(`File overlap: ${file}`);
          }
          seenFiles.add(file);
        }
      }
    }

    return { valid: errors.length === 0, errors: errors.slice(0, 5) }; // Max 5 errors
  }

  /**
   * Handle successful validation
   */
  private async handleSuccess(
    task: any,
    result: any,
    epics: any[],
    startTime: number,
    context: OrchestrationContext
  ): Promise<PhaseResult> {
    const taskId = (task._id as any).toString();

    // Store results
    task.orchestration.projectManager!.status = 'completed';
    task.orchestration.projectManager!.completedAt = new Date();
    task.orchestration.projectManager!.output = result.output;
    task.orchestration.projectManager!.sessionId = result.sessionId;
    task.orchestration.projectManager!.usage = result.usage;
    task.orchestration.projectManager!.cost_usd = result.cost;
    task.orchestration.projectManager!.epics = epics;

    // Update totals
    task.orchestration.totalCost += result.cost;
    task.orchestration.totalTokens +=
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

    await task.save();

    // Store in context
    context.setData('epics', epics);
    context.setData('epicRegistry', this.buildEpicRegistry(epics));

    // Emit events
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'ProjectManagerCompleted',
      agentName: 'project-manager',
      payload: { epics },
      metadata: {
        cost: result.cost,
        duration: Date.now() - startTime,
        epicCount: epics.length
      }
    });

    NotificationService.emitAgentCompleted(
      taskId,
      'Project Manager',
      `Created ${epics.length} epics`
    );

    return {
      phaseName: this.name,
      duration: Date.now() - startTime,
      success: true,
      data: {
        epics,
        epicCount: epics.length
      },
      metrics: {
        cost_usd: result.cost,
        input_tokens: result.usage?.input_tokens || 0,
        output_tokens: result.usage?.output_tokens || 0
      }
    };
  }

  /**
   * Build epic registry for quick lookup
   */
  private buildEpicRegistry(epics: any[]): Record<string, any> {
    const registry: Record<string, any> = {};
    for (const epic of epics) {
      if (epic.id) {
        registry[epic.id] = epic;
      }
    }
    return registry;
  }

  /**
   * Initialize state
   */
  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.projectManager) {
      task.orchestration.projectManager = {
        agent: 'project-manager',
        status: 'pending'
      } as any;
    }
    task.orchestration.projectManager!.status = 'in_progress';
    task.orchestration.projectManager!.startedAt = new Date(startTime);
  }

  /**
   * Handle error
   */
  private async handleError(task: any, error: any, taskId: string): Promise<PhaseResult> {
    task.orchestration.projectManager!.status = 'failed';
    task.orchestration.projectManager!.error = error.message;
    await task.save();

    NotificationService.emitAgentFailed(taskId, 'Project Manager', error.message);
    await LogService.agentFailed('project-manager', taskId, error, { phase: 'planning' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}