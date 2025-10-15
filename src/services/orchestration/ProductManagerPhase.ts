import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import fs from 'fs';
import path from 'path';

/**
 * Product Manager Phase
 *
 * Analyzes business requirements and defines product specifications
 * - Evaluates task complexity
 * - Identifies success criteria
 * - Provides recommended approach
 */
export class ProductManagerPhase extends BasePhase {
  readonly name = 'ProductManager'; // Must match PHASE_ORDER
  readonly description = 'Analyzing requirements and defining product specifications';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Product Manager already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    if (context.task.orchestration.productManager?.status === 'completed') {
      console.log(`[SKIP] Product Manager already completed - skipping re-execution`);

      // Restore phase data from previous execution for next phases
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
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // Update task status
    const startTime = new Date();
    task.orchestration.productManager.status = 'in_progress';
    task.orchestration.productManager.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Product Manager');

    await LogService.agentStarted('product-manager', taskId, {
      phase: 'analysis',
    });

    try {
      // Build repositories information
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) =>
            `${i + 1}. ${repo.githubRepoName} (branch: ${repo.githubBranch})`
          ).join('\n')}\n`
        : '';

      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nAnalyze all repositories to understand the full system.`
        : '';

      // Previous output for revision (if any)
      const previousOutput = task.orchestration.productManager.output;

      let revisionSection = '';
      if (previousOutput && task.orchestration.productManager.status === 'in_progress') {
        revisionSection = `

# Previous Analysis Available
Your previous analysis is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      const prompt = `Act as the product-manager agent.

# Task Analysis
${revisionSection}
## Task Details:
- **Title**: ${task.title}
- **Description**: ${task.description}
- **Priority**: ${task.priority}
${repoInfo}${workspaceInfo}

## Your Mission:
Analyze this task and provide:
1. **Task Complexity** (small/medium/large/epic)
2. **Recommended Approach**
3. **Success Criteria**

Be thorough but concise.`;

      // 🔥 IMAGES: Convert task attachments to SDK format
      const attachments: any[] = [];
      if (task.attachments && task.attachments.length > 0) {
        console.log(`📎 [ProductManager] Processing ${task.attachments.length} attachment(s)`);

        for (const attachmentUrl of task.attachments) {
          // attachments are stored as URL strings
          try {
            // 🔥 FIX: Convert URL path (/uploads/file.png) to filesystem path
            // attachmentUrl is stored as "/uploads/filename.png" which is a URL path
            // We need to convert it to absolute filesystem path
            let imagePath: string;
            if (attachmentUrl.startsWith('/uploads/')) {
              // URL path like "/uploads/file.png" -> filesystem path
              imagePath = path.join(process.cwd(), attachmentUrl);
            } else if (path.isAbsolute(attachmentUrl)) {
              // Already absolute filesystem path
              imagePath = attachmentUrl;
            } else {
              // Relative path
              imagePath = path.join(process.cwd(), attachmentUrl);
            }

            console.log(`  🔍 Resolving image path: ${attachmentUrl} -> ${imagePath}`);

            if (fs.existsSync(imagePath)) {
              const imageBuffer = fs.readFileSync(imagePath);
              const base64Image = imageBuffer.toString('base64');

              // Detect mime type from file extension
              const ext = path.extname(imagePath).toLowerCase();
              let mimeType = 'image/jpeg';
              if (ext === '.png') mimeType = 'image/png';
              else if (ext === '.gif') mimeType = 'image/gif';
              else if (ext === '.webp') mimeType = 'image/webp';

              attachments.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64Image,
                },
              });

              const fileName = path.basename(imagePath);
              const fileSizeKB = (imageBuffer.length / 1024).toFixed(1);
              console.log(`  ✅ Attached image: ${fileName} (${fileSizeKB} KB)`);
            } else {
              console.warn(`  ⚠️ Image file not found: ${imagePath}`);
            }
          } catch (error: any) {
            const fileName = path.basename(attachmentUrl);
            console.error(`  ❌ Failed to process image ${fileName}:`, error.message);
          }
        }
      }

      // Progress notification
      NotificationService.emitAgentProgress(taskId, 'Product Manager', 'Analyzing requirements...');

      // Execute agent using provided function
      const result = await this.executeAgentFn(
        'product-manager',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Product Manager',
        undefined, // resumeSessionId
        undefined, // forkSession
        attachments.length > 0 ? attachments : undefined // Pass attachments
      );

      // Store results
      task.orchestration.productManager.status = 'completed';
      task.orchestration.productManager.completedAt = new Date();
      task.orchestration.productManager.output = result.output;
      task.orchestration.productManager.sessionId = result.sessionId;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.productManager.canResumeSession = result.canResume;
      task.orchestration.productManager.usage = result.usage;
      task.orchestration.productManager.cost_usd = result.cost;

      // if (result.todos) {
      //   task.orchestration.productManager.todos = result.todos;
      //   task.orchestration.productManager.lastTodoUpdate = new Date();
      // }

      // Extract complexity
      const complexityMatch = result.output.match(/complexity.*?(small|medium|large|epic)/i);
      if (complexityMatch) {
        (task.orchestration.productManager as any).taskComplexity = complexityMatch[1].toLowerCase();
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
        eventType: 'ProductManagerCompleted',
        agentName: 'product-manager',
        payload: {
          output: result.output,
          complexity: complexityMatch?.[1]?.toLowerCase() || 'medium',
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [ProductManager] Emitted ProductManagerCompleted event`);

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Product Manager', result.output);

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Product Manager',
        'Requirements analysis completed'
      );

      await LogService.agentCompleted('product-manager', taskId, {
        phase: 'analysis',
        metadata: {
          complexity: complexityMatch?.[1]?.toLowerCase() || 'medium',
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data for next phases
      context.setData('productManagerOutput', result.output);
      context.setData('taskComplexity', complexityMatch?.[1]?.toLowerCase() || 'medium');

      return {
        success: true,
        data: {
          output: result.output,
          complexity: complexityMatch?.[1]?.toLowerCase(),
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
      task.orchestration.productManager.status = 'failed';
      task.orchestration.productManager.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Product Manager', error.message);

      await LogService.agentFailed('product-manager', taskId, error, {
        phase: 'analysis',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'ProductManagerCompleted', // Mark as completed even on error
        agentName: 'product-manager',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [ProductManager] Emitted ProductManagerCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
