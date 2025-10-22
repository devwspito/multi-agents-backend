import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import {
  analyzeRepositoryAffinity,
  getRepositoryExecutionOrder,
} from '../../utils/repositoryDetection';

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

      // Parse JSON response to extract EPICS (not stories)
      let parsed: any;

      // Try parsing as pure JSON first (no markdown)
      try {
        const trimmed = result.output.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          parsed = JSON.parse(trimmed);
          if (parsed.epics && Array.isArray(parsed.epics)) {
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

              if (parsed.epics && Array.isArray(parsed.epics)) {
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

      // Validate epics array exists
      if (!parsed || !parsed.epics || !Array.isArray(parsed.epics)) {
        console.log('\n🔍 [ProjectManager] FULL Agent output:\n', result.output);
        NotificationService.emitConsoleLog(taskId, 'error', `❌ Project Manager parsing failed. Full output:\n${result.output}`);
        throw new Error(`Project Manager did not return valid JSON with epics array. Found ${parsed?.epics ? 'non-array epics' : 'no epics'}`);
      }

      if (parsed.epics.length === 0) {
        console.log('\n⚠️  [ProjectManager] Agent returned empty epics array');
        throw new Error('Project Manager returned empty epics array - cannot proceed with team orchestration');
      }

      console.log(`✅ [ProjectManager] Successfully parsed ${parsed.epics.length} epic(s) - will create ${parsed.epics.length} team(s)`);

      // 🔥 VALIDATE AND SEPARATE EPICS BY REPOSITORY
      const validatedEpics = this.validateAndSeparateEpics(parsed.epics, context);
      console.log(`✅ [ProjectManager] After validation: ${validatedEpics.length} epic(s) (separated by repository)`);

      // Update parsed epics with validated ones
      parsed.epics = validatedEpics;
      parsed.totalTeamsNeeded = validatedEpics.length;

      // Store results
      task.orchestration.projectManager.status = 'completed';
      task.orchestration.projectManager.completedAt = new Date();
      task.orchestration.projectManager.output = result.output;
      task.orchestration.projectManager.sessionId = result.sessionId;
      // Store parsed epics and total teams needed
      (task.orchestration.projectManager as any).epics = parsed.epics;
      (task.orchestration.projectManager as any).totalTeamsNeeded = parsed.totalTeamsNeeded || parsed.epics.length;
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
      context.setData('epics', parsed.epics);
      context.setData('totalTeamsNeeded', parsed.totalTeamsNeeded || parsed.epics.length);

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

  /**
   * Validates epics and separates them by repository if needed
   *
   * If an epic spans multiple repositories, splits it into separate epics (one per repository)
   * Adds dependencies so backend epics execute before frontend epics
   */
  private validateAndSeparateEpics(epics: any[], context: OrchestrationContext): any[] {
    const result: any[] = [];
    const repositories = context.repositories;

    if (repositories.length === 0) {
      console.log('⚠️  [ProjectManager] No repositories configured - skipping multi-repo validation');
      return epics;
    }

    // Get repository execution order
    const executionOrder = getRepositoryExecutionOrder(repositories);
    console.log(`📋 [ProjectManager] Repository execution order: ${executionOrder.join(' → ')}`);

    for (const epic of epics) {
      // Collect all files mentioned in the epic
      const allFiles = [
        ...(epic.filesToRead || []),
        ...(epic.filesToModify || []),
        ...(epic.filesToCreate || []),
      ];

      if (allFiles.length === 0) {
        // No files specified - keep epic as-is
        result.push(epic);
        continue;
      }

      // Analyze repository affinity
      const affinity = analyzeRepositoryAffinity(allFiles, repositories);

      if (affinity.isMultiRepo) {
        // Epic spans multiple repositories - split it
        console.log(`⚠️  [ProjectManager] Epic "${epic.id}" spans multiple repos:`, affinity.affectedRepositories);

        for (const [index, repoName] of affinity.affectedRepositories.entries()) {
          const filesForRepo = affinity.filesByRepository.get(repoName) || [];
          const repo = repositories.find(r => r.name === repoName);

          if (!repo) continue;

          // Calculate dependencies: if this is not the first repo in execution order, depend on previous repos
          const repoDependencies: string[] = [];
          const repoExecIndex = executionOrder.indexOf(repoName);

          // Add previous repos in execution order as dependencies
          if (repoExecIndex > 0) {
            for (let i = 0; i < repoExecIndex; i++) {
              const prevRepo = executionOrder[i];
              // Only add if that repo is also affected by this epic
              if (affinity.affectedRepositories.includes(prevRepo)) {
                repoDependencies.push(`${epic.id}-${prevRepo}`);
              }
            }
          }

          // Also include epic's original dependencies
          repoDependencies.push(...(epic.dependencies || []));

          result.push({
            ...epic,
            id: `${epic.id}-${repoName}`,
            title: `[${repoName.toUpperCase()}] ${epic.title}`,
            targetRepository: repoName,
            affectedRepositories: [repoName],
            filesToRead: (epic.filesToRead || []).filter((f: string) => filesForRepo.includes(f)),
            filesToModify: (epic.filesToModify || []).filter((f: string) => filesForRepo.includes(f)),
            filesToCreate: (epic.filesToCreate || []).filter((f: string) => filesForRepo.includes(f)),
            dependencies: repoDependencies.length > 0 ? repoDependencies : undefined,
            executionOrder: repo.executionOrder || repoExecIndex + 1,
          });
        }
      } else {
        // Epic is single-repo - just add metadata
        result.push({
          ...epic,
          targetRepository: affinity.primaryRepository,
          affectedRepositories: affinity.affectedRepositories,
          executionOrder: repositories.find(r => r.name === affinity.primaryRepository)?.executionOrder || 1,
        });
      }
    }

    // Sort epics by execution order
    result.sort((a, b) => (a.executionOrder || 999) - (b.executionOrder || 999));

    return result;
  }
}
