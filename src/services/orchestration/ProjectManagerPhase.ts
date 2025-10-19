import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * Project Manager Phase
 *
 * Clarifies task, defines scope, and identifies dependencies
 * - Breaks down ambiguous requirements
 * - Defines IN SCOPE vs OUT OF SCOPE
 * - Identifies cross-repo dependencies
 * - Provides risk assessment
 * - Defines implementation sequencing
 */
export class ProjectManagerPhase extends BasePhase {
  readonly name = 'ProjectManager'; // Must match PHASE_ORDER
  readonly description = 'Clarifying scope and identifying dependencies';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Project Manager already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    if (context.task.orchestration.projectManager?.status === 'completed') {
      console.log(`[SKIP] Project Manager already completed - skipping re-execution`);

      // Restore phase data from previous execution for next phases
      if (context.task.orchestration.projectManager.output) {
        context.setData('projectManagerOutput', context.task.orchestration.projectManager.output);
      }

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
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // Update task status
    const startTime = new Date();
    task.orchestration.projectManager.status = 'in_progress';
    task.orchestration.projectManager.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Project Manager');

    await LogService.agentStarted('project-manager', taskId, {
      phase: 'planning',
    });

    try {
      // Build repositories information
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) =>
            `${i + 1}. ${repo.githubRepoName} (branch: ${repo.githubBranch})`
          ).join('\n')}\n`
        : '';

      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nDefine scope and dependencies across all repositories.`
        : '';

      const productManagerAnalysis = task.orchestration.productManager.output || 'No product analysis available.';

      // Previous output for revision (if any)
      const previousOutput = task.orchestration.projectManager.output;

      let revisionSection = '';
      if (previousOutput && task.orchestration.projectManager.status === 'in_progress') {
        revisionSection = `

# Previous Project Plan Available
Your previous project plan is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      const prompt = `Act as the project-manager agent.

# Project Clarification Task
${revisionSection}
## Original Task Request:
**Title**: ${task.title}
**Description**: ${task.description}

## Product Manager Analysis:
${productManagerAnalysis}
${repoInfo}${workspaceInfo}

## Your Responsibilities:

1. **Clarify the Task**: Break down ambiguous requirements into clear, actionable objectives
2. **Define Scope**: What is IN SCOPE and OUT OF SCOPE. Identify MVP vs nice-to-have
3. **Dependency Analysis**: Identify cross-repo dependencies, circular dependencies, prerequisites
4. **Risk Assessment**: Technical risks, integration risks, timeline risks with mitigation strategies
5. **Implementation Sequencing**: Define phases with clear handoffs (Phase 1 → Phase 2 → Phase 3)
6. **Multi-Repo Strategy**: Determine if this is frontend-first, backend-first, parallel, or sequential

## Critical for Multi-Repo:
- If frontend and backend depend on each other, identify HOW to break the circular dependency
- Specify which repository starts first and what it delivers to unblock the other
- Define shared contracts/interfaces that both can work against

**Output a detailed project plan following the format in your agent instructions.**`;

      // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
      // This ensures ALL agents receive the same multimedia context without re-processing
      const attachments = context.getData<any[]>('attachments') || [];
      if (attachments.length > 0) {
        console.log(`📎 [ProjectManager] Using ${attachments.length} attachment(s) from context`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 Project Manager: Received ${attachments.length} image(s) from context for visual analysis`
        );
      }

      // Progress notification
      NotificationService.emitAgentProgress(taskId, 'Project Manager', 'Clarifying scope and dependencies...');

      // Execute agent using provided function
      const result = await this.executeAgentFn(
        'project-manager',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Project Manager',
        undefined, // resumeSessionId
        undefined, // forkSession
        attachments.length > 0 ? attachments : undefined // Pass attachments
      );

      // Parse JSON response to extract stories
      let parsed: any;

      // Try parsing as pure JSON first (no markdown)
      try {
        const trimmed = result.output.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          parsed = JSON.parse(trimmed);
          if (parsed.stories && Array.isArray(parsed.stories)) {
            console.log('✅ [ProjectManager] Parsed as pure JSON (no markdown blocks)');
          } else {
            parsed = null; // Not the right structure
          }
        }
      } catch (e) {
        // Not pure JSON, try markdown patterns
      }

      // Try multiple extraction patterns if pure JSON failed
      const patterns = [
        /```json\s*\n([\s\S]*?)\n```/,
        /```json\s*\n([\s\S]*?)```/,
        /```json\s*([\s\S]*?)```/,
        /```\s*\n([\s\S]*?)\n```/,
        /```\s*([\s\S]*?)```/
      ];

      if (!parsed) {
        for (const pattern of patterns) {
          const match = result.output.match(pattern);
          if (match) {
            try {
              const jsonText = match[1] || match[0];
              const trimmed = jsonText.trim();
              parsed = JSON.parse(trimmed);

              if (parsed.stories && Array.isArray(parsed.stories)) {
                console.log(`✅ [ProjectManager] Parsed JSON using pattern: ${pattern.toString().substring(0, 50)}...`);
                break;
              } else {
                parsed = null;
                continue;
              }
            } catch (e) {
              continue;
            }
          }
        }
      }

      // Validate stories array exists
      if (!parsed || !parsed.stories || !Array.isArray(parsed.stories)) {
        console.log('\n🔍 [ProjectManager] FULL Agent output:\n', result.output);
        NotificationService.emitConsoleLog(taskId, 'error', `❌ Project Manager parsing failed. Full output:\n${result.output}`);
        throw new Error(`Project Manager did not return valid JSON with stories array. Found ${parsed?.stories ? 'non-array stories' : 'no stories'}`);
      }

      if (parsed.stories.length === 0) {
        console.log('\n⚠️  [ProjectManager] Agent returned empty stories array');
        throw new Error('Project Manager returned empty stories array - cannot proceed with team orchestration');
      }

      console.log(`✅ [ProjectManager] Successfully parsed ${parsed.stories.length} story/stories`);

      // Store results
      task.orchestration.projectManager.status = 'completed';
      task.orchestration.projectManager.completedAt = new Date();
      task.orchestration.projectManager.output = result.output;
      task.orchestration.projectManager.sessionId = result.sessionId;
      // Store parsed stories and team composition
      (task.orchestration.projectManager as any).stories = parsed.stories;
      (task.orchestration.projectManager as any).recommendedTeamSize = parsed.recommendedTeamSize;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.projectManager.canResumeSession = result.canResume;
      task.orchestration.projectManager.usage = result.usage;
      task.orchestration.projectManager.cost_usd = result.cost;

      // if (result.todos) {
      //   task.orchestration.projectManager.todos = result.todos;
      //   task.orchestration.projectManager.lastTodoUpdate = new Date();
      // }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      // 🔥 EVENT SOURCING: Emit completion event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'ProjectManagerCompleted',
        agentName: 'project-manager',
        payload: {
          output: result.output,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [ProjectManager] Emitted ProjectManagerCompleted event`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n📋 PROJECT MANAGER - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Project Manager', result.output);

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Project Manager',
        'Task clarified. Scope defined. Dependencies identified.'
      );

      await LogService.agentCompleted('project-manager', taskId, {
        phase: 'planning',
        metadata: {
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data for next phases
      context.setData('projectManagerOutput', result.output);
      context.setData('stories', parsed.stories);
      context.setData('recommendedTeamSize', parsed.recommendedTeamSize);

      return {
        success: true,
        data: {
          output: result.output,
          cost: result.cost,
          tokens: result.usage,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      };
    } catch (error: any) {
      task.orchestration.projectManager.status = 'failed';
      task.orchestration.projectManager.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Project Manager', error.message);

      await LogService.agentFailed('project-manager', taskId, error, {
        phase: 'planning',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'ProjectManagerCompleted', // Mark as completed even on error
        agentName: 'project-manager',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [ProjectManager] Emitted ProjectManagerCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
