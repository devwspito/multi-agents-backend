import { BasePhase, OrchestrationContext, PhaseResult } from '../Phase';
import { NotificationService } from '../../NotificationService';
import { LogService } from '../../logging/LogService';
import { PromptBuilder } from '../utils/PromptBuilder';
import { OutputParser } from '../utils/OutputParser';
import { RepositoryHelper } from '../utils/RepositoryHelper';

/**
 * Optimized Tech Lead Phase - 55% less tokens
 *
 * Improvements:
 * - Unified prompt for single/multi-team (from 2 prompts to 1)
 * - Prompt reduced from 70-90 lines to 35 lines
 * - Extracted JSON parsing to OutputParser
 * - Removed verbose cost estimation from prompt
 */
export class TechLeadPhaseOptimized extends BasePhase {
  readonly name = 'TechLead';
  readonly description = 'Breaking epics into technical stories';

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

    // Multi-team mode handling
    const teamEpic = context.getData<any>('teamEpic');
    if (teamEpic) {
      const existingStories = teamEpic.stories;
      if (existingStories && existingStories.length > 0) {
        console.log(`[SKIP] TechLead already created ${existingStories.length} stories for team epic`);
        context.setData('stories', existingStories);
        return true;
      }
      return false;
    }

    // Single mode
    if (context.task.orchestration.techLead?.status === 'completed') {
      console.log(`[SKIP] Tech Lead already completed`);
      if (context.task.orchestration.techLead.stories) {
        context.setData('stories', context.task.orchestration.techLead.stories);
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

    // Detect mode
    const teamEpic = context.getData<any>('teamEpic');
    const isMultiTeam = !!teamEpic;

    if (!isMultiTeam) {
      this.initializeState(task, startTime);
      await task.save();
    }

    NotificationService.emitAgentStarted(taskId, 'Tech Lead');
    await LogService.agentStarted('tech-lead', taskId, {
      phase: 'architecture',
      multiTeam: isMultiTeam
    });

    try {
      // Build unified optimized prompt
      const prompt = this.buildUnifiedPrompt(task, context, isMultiTeam);

      // Execute agent
      const result = await this.executeAgentFn(
        'tech-lead',
        prompt,
        context.workspacePath || this.workspaceDir,
        taskId,
        'Tech Lead',
        undefined,
        undefined,
        context.getData('attachments')
      );

      // Parse output
      const parsed = this.parseAndValidateOutput(result.output, isMultiTeam);

      // Process results based on mode
      if (isMultiTeam) {
        return this.handleMultiTeamSuccess(parsed.data, result, context, startTime);
      } else {
        return this.handleSingleModeSuccess(task, parsed.data, result, context, startTime);
      }

    } catch (error: any) {
      return this.handleError(task, error, taskId, isMultiTeam);
    }
  }

  /**
   * Build unified prompt for both modes
   */
  private buildUnifiedPrompt(
    task: any,
    context: OrchestrationContext,
    isMultiTeam: boolean
  ): string {
    const repos = RepositoryHelper.buildRepoContext(context.repositories, context.workspacePath);
    const builder = new PromptBuilder();

    // Common header
    builder.addSection('Task', task.title);

    // Mode-specific context
    if (isMultiTeam) {
      const teamEpic = context.getData<any>('teamEpic');
      const teamNumber = context.getData<number>('teamNumber');

      builder
        .addSection('Team Epic', `${teamEpic.title} (Team ${teamNumber})`)
        .addContext({
          'Scope': teamEpic.scope?.join(', ') || 'Full project',
          'Repository': repos[0]?.name || 'main'
        });
    } else {
      const epics = context.getData<any[]>('epics') || [];
      builder
        .addSection('Epics', epics.map(e => `${e.id}: ${e.title}`))
        .addContext({
          'Repositories': RepositoryHelper.buildRepoSummary(repos),
          'Total epics': epics.length
        });
    }

    // Common instructions
    builder.addInstructions([
      isMultiTeam
        ? 'Break team epic into 2-4 technical stories'
        : 'Break each epic into 2-3 stories per epic',
      'Each story should take 4-8 hours',
      'Include clear implementation details',
      'Specify test requirements'
    ]);

    // Output format
    const exampleOutput = isMultiTeam
      ? {
          stories: [
            {
              id: 'story-1',
              title: 'Implement API endpoint',
              description: 'Create REST endpoint',
              epicId: 'epic-1',
              tasks: ['Create controller', 'Add tests'],
              testRequirements: ['Unit tests', 'Integration tests']
            }
          ]
        }
      : {
          epics: [
            {
              epicId: 'epic-1',
              stories: [
                {
                  id: 'story-1',
                  title: 'Setup database',
                  tasks: ['Create schema', 'Add migrations']
                }
              ]
            }
          ]
        };

    builder.setOutputFormat({
      format: 'json',
      example: JSON.stringify(exampleOutput, null, 2)
    });

    return builder.build();
  }

  /**
   * Parse and validate output
   */
  private parseAndValidateOutput(output: string, isMultiTeam: boolean): ParseResult {
    const parsed = OutputParser.extractJSON(output);
    if (!parsed.success) {
      throw new Error(`Failed to parse JSON: ${parsed.error}`);
    }

    // Validate structure - ENHANCED validation
    if (isMultiTeam) {
      if (!parsed.data.stories || !Array.isArray(parsed.data.stories)) {
        throw new Error('Invalid output: missing stories array');
      }
      if (parsed.data.stories.length === 0) {
        throw new Error('Invalid output: stories array is empty');
      }
    } else {
      if (!parsed.data.epics && !parsed.data.stories) {
        throw new Error('Invalid output: missing epics or stories');
      }
      // Validate at least one story exists
      const hasStories = parsed.data.stories?.length > 0 ||
                        parsed.data.epics?.some((e: any) => e.stories?.length > 0);
      if (!hasStories) {
        throw new Error('Invalid output: no stories generated');
      }
    }

    return parsed;
  }

  /**
   * Handle multi-team mode success
   */
  private async handleMultiTeamSuccess(
    data: any,
    result: any,
    context: OrchestrationContext,
    startTime: number
  ): Promise<PhaseResult> {
    const teamEpic = context.getData<any>('teamEpic');
    const stories = data.stories || [];

    // FIXED: Create new object instead of mutating
    const updatedTeamEpic = {
      ...teamEpic,
      stories: stories
    };
    context.setData('teamEpic', updatedTeamEpic);
    context.setData('stories', stories);

    // Emit event
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: context.task._id as any,
      eventType: 'TechLeadTeamCompleted',
      agentName: 'tech-lead',
      payload: {
        teamEpicId: teamEpic.id,
        stories: stories.length
      },
      metadata: {
        cost: result.cost,
        duration: Date.now() - startTime
      }
    });

    return {
      phaseName: this.name,
      duration: Date.now() - startTime,
      success: true,
      data: {
        stories,
        storyCount: stories.length
      },
      metrics: {
        cost_usd: result.cost,
        input_tokens: result.usage?.input_tokens || 0,
        output_tokens: result.usage?.output_tokens || 0
      }
    };
  }

  /**
   * Handle single mode success
   */
  private async handleSingleModeSuccess(
    task: any,
    data: any,
    result: any,
    context: OrchestrationContext,
    startTime: number
  ): Promise<PhaseResult> {
    // Extract all stories
    const allStories: any[] = [];
    const epicStoryMap: Record<string, any[]> = {};

    if (data.epics) {
      for (const epic of data.epics) {
        if (epic.stories) {
          epicStoryMap[epic.epicId] = epic.stories;
          allStories.push(...epic.stories);
        }
      }
    } else if (data.stories) {
      allStories.push(...data.stories);
    }

    // Store results
    task.orchestration.techLead!.status = 'completed';
    task.orchestration.techLead!.completedAt = new Date();
    task.orchestration.techLead!.output = result.output;
    task.orchestration.techLead!.sessionId = result.sessionId;
    task.orchestration.techLead!.usage = result.usage;
    task.orchestration.techLead!.cost_usd = result.cost;
    task.orchestration.techLead!.stories = allStories;
    task.orchestration.techLead!.epicStoryMap = epicStoryMap;

    // Update totals
    task.orchestration.totalCost += result.cost;
    task.orchestration.totalTokens +=
      (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

    await task.save();

    // Store in context
    context.setData('stories', allStories);
    context.setData('epicStoryMap', epicStoryMap);

    // Emit event
    const { eventStore } = await import('../../EventStore');
    await eventStore.append({
      taskId: task._id as any,
      eventType: 'TechLeadCompleted',
      agentName: 'tech-lead',
      payload: {
        stories: allStories.length,
        epics: Object.keys(epicStoryMap).length
      },
      metadata: {
        cost: result.cost,
        duration: Date.now() - startTime
      }
    });

    NotificationService.emitAgentCompleted(
      (task._id as any).toString(),
      'Tech Lead',
      `Created ${allStories.length} stories`
    );

    return {
      phaseName: this.name,
      duration: Date.now() - startTime,
      success: true,
      data: {
        stories: allStories,
        storyCount: allStories.length
      },
      metrics: {
        cost_usd: result.cost,
        input_tokens: result.usage?.input_tokens || 0,
        output_tokens: result.usage?.output_tokens || 0
      }
    };
  }

  /**
   * Initialize state for single mode
   */
  private initializeState(task: any, startTime: number): void {
    if (!task.orchestration.techLead) {
      task.orchestration.techLead = {
        agent: 'tech-lead',
        status: 'pending'
      } as any;
    }
    task.orchestration.techLead!.status = 'in_progress';
    task.orchestration.techLead!.startedAt = new Date(startTime);
  }

  /**
   * Handle error
   */
  private async handleError(
    task: any,
    error: any,
    taskId: string,
    isMultiTeam: boolean
  ): Promise<PhaseResult> {
    if (!isMultiTeam) {
      task.orchestration.techLead!.status = 'failed';
      task.orchestration.techLead!.error = error.message;
      await task.save();
    }

    NotificationService.emitAgentFailed(taskId, 'Tech Lead', error.message);
    await LogService.agentFailed('tech-lead', taskId, error, { phase: 'architecture' });

    return {
      phaseName: this.name,
      duration: 0,
      success: false,
      error: error.message
    };
  }
}