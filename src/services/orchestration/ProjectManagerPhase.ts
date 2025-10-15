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

      // Check if this is a revision based on user feedback
      const feedbackHistory = task.orchestration.projectManager.feedbackHistory || [];
      const hasRevision = feedbackHistory.length > 0;
      const lastFeedback = hasRevision ? feedbackHistory[feedbackHistory.length - 1] : null;
      const previousOutput = task.orchestration.projectManager.output;

      let revisionSection = '';
      if (hasRevision && lastFeedback) {
        revisionSection = `

# ⚠️ REVISION REQUIRED (Attempt ${feedbackHistory.length + 1})

You previously provided a project plan, but the user requested changes.

## Your Previous Plan:
\`\`\`
${previousOutput || '(no previous output)'}
\`\`\`

## User Feedback:
"${lastFeedback.feedback}"

## What You Must Do:
1. **Read the feedback carefully** - understand what the user wants changed
2. **Apply the requested changes** - update your plan accordingly
3. **Keep what was good** - don't discard work that the user approved implicitly
4. **Provide updated plan** - make sure it addresses the feedback

**Important**: This is revision ${feedbackHistory.length + 1}. The user is waiting for you to apply their feedback.
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

      // 🔥 IMAGES: Convert task attachments to SDK format (same as Product Manager)
      const fs = require('fs');
      const path = require('path');
      const attachments: any[] = [];
      if (task.attachments && task.attachments.length > 0) {
        console.log(`📎 [ProjectManager] Processing ${task.attachments.length} attachment(s)`);

        for (const attachment of task.attachments) {
          // Only process images
          if (attachment.type === 'image') {
            try {
              // Convert URL path (/uploads/file.png) to filesystem path
              let imagePath: string;
              if (attachment.url.startsWith('/uploads/')) {
                imagePath = path.join(process.cwd(), attachment.url);
              } else if (path.isAbsolute(attachment.url)) {
                imagePath = attachment.url;
              } else {
                imagePath = path.join(process.cwd(), attachment.url);
              }

              console.log(`  🔍 Resolving image path: ${attachment.url} -> ${imagePath}`);

              if (fs.existsSync(imagePath)) {
                const imageBuffer = fs.readFileSync(imagePath);
                const base64Image = imageBuffer.toString('base64');

                attachments.push({
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: attachment.mimeType,
                    data: base64Image,
                  },
                });

                console.log(`  ✅ Attached image: ${attachment.originalName} (${(attachment.size / 1024).toFixed(1)} KB)`);
              } else {
                console.warn(`  ⚠️ Image file not found: ${imagePath}`);
              }
            } catch (error: any) {
              console.error(`  ❌ Failed to process image ${attachment.originalName}:`, error.message);
            }
          }
        }
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

      // Store results
      task.orchestration.projectManager.status = 'completed';
      task.orchestration.projectManager.completedAt = new Date();
      task.orchestration.projectManager.output = result.output;
      task.orchestration.projectManager.sessionId = result.sessionId;
      task.orchestration.projectManager.canResumeSession = result.canResume;
      task.orchestration.projectManager.usage = result.usage;
      task.orchestration.projectManager.cost_usd = result.cost;

      if (result.todos) {
        task.orchestration.projectManager.todos = result.todos;
        task.orchestration.projectManager.lastTodoUpdate = new Date();
      }

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
