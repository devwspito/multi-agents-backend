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

    // 🔄 CONTINUATION: Never skip - always re-execute all phases with new context
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [ProductManager] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.productManager?.status === 'completed') {
      console.log(`[SKIP] Product Manager already completed - skipping re-execution (recovery mode)`);

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

      const prompt = `# Task to Analyze
${revisionSection}
## Task Details:
- **Title**: ${task.title}
- **Description**: ${task.description}
- **Priority**: ${task.priority}

## 🚨 CRITICAL: WORKSPACE LOCATION - READ THIS CAREFULLY

**⚠️  YOU ARE SANDBOXED IN THIS WORKSPACE: ${workspacePath}**

**ABSOLUTE RULE**: ONLY explore files inside this workspace path. NEVER explore outside.

The following repositories are cloned INSIDE your workspace:
${context.repositories.map(repo =>
  `- **${workspacePath}/${repo.name}** (${repo.type}) → GitHub: ${repo.githubRepoName}`
).join('\n')}

**✅ CORRECT Commands (stay inside workspace)**:
\`\`\`bash
# Navigate inside workspace
cd ${workspacePath}/${context.repositories[0]?.name || 'repo'} && ls -la

# Find files inside workspace
find ${workspacePath} -name "*.js" | head -20

# Read files using relative paths from your current directory
Read("${context.repositories[0]?.name || 'repo'}/src/App.jsx")

# Grep inside specific repo
Grep("pattern", "${context.repositories[0]?.name || 'repo'}/")
\`\`\`

**❌ INCORRECT Commands (exploring outside workspace - FORBIDDEN)**:
\`\`\`bash
# ❌ NEVER explore user's home directory
ls ~/Desktop
find ~ -name "*.js"

# ❌ NEVER explore system repositories outside workspace
ls /Users/luiscorrea/Desktop/mult-agent-software-project
Read("/Users/.../multi-agents-backend/src/file.js")

# ❌ NEVER use absolute paths outside workspace
find /Users -name "package.json"
\`\`\`

${repoInfo}${workspaceInfo}

🔍 **EXPLORATION CHECKLIST** - Do this BEFORE outputting JSON:
${context.repositories.map((repo, idx) =>
  `${idx + 1}. Bash("cd ${workspacePath}/${repo.name} && ls -la") - See ${repo.name} structure
${idx + 1}.b Bash("cd ${workspacePath}/${repo.name} && find . -type f | head -30") - List files
${idx + 1}.c Read("${repo.name}/package.json") - Understand ${repo.name} dependencies`
).join('\n')}

${task.attachments && task.attachments.length > 0 ? `📎 You have ${task.attachments.length} image(s) attached. Analyze them for visual requirements (UI mockups, diagrams, etc.).\n\n` : ''}## 🎯 NEW REQUIREMENT: Master Epic with Shared Contracts

You are creating a **MASTER EPIC** that will coordinate work across multiple repositories.

Your output must include:
1. **Global Naming Conventions** - Field names, formats, prefixes that ALL repos must follow
2. **Shared Contracts** - API endpoints, data types, interfaces that define cross-repo communication
3. **Repository Assignment** - Which repos are affected and what each will do

**Why this matters**:
- Without naming conventions: Backend uses "userId", Frontend uses "user_id" → 💥 CONFLICT
- Without contracts: Backend returns {id, name}, Frontend expects {userId, fullName} → 💥 MISMATCH
- With contracts: ALL teams use the same field names and API formats → ✅ CONSISTENCY

**Output format** (match exactly - valid JSON only):
\`\`\`json
{
  "masterEpic": {
    "id": "master-${task.title.toLowerCase().replace(/\\s+/g, '-')}-${Date.now()}",
    "title": "${task.title}",
    "globalNamingConventions": {
      "primaryIdField": "userId|productId|orderId (choose ONE convention for IDs)",
      "timestampFormat": "ISO8601|Unix|DateTime (choose ONE)",
      "errorCodePrefix": "AUTH_|USER_|API_ (choose ONE prefix)",
      "booleanFieldPrefix": "is|has|should (choose ONE for booleans)",
      "collectionNaming": "plural|singular (e.g., 'users' vs 'user')"
    },
    "sharedContracts": {
      "apiEndpoints": [
        {
          "method": "POST|GET|PUT|DELETE",
          "path": "/api/resource/action",
          "request": { "field1": "type", "field2": "type" },
          "response": { "field1": "type", "field2": "type" },
          "description": "What this endpoint does"
        }
      ],
      "sharedTypes": [
        {
          "name": "TypeName",
          "description": "What this type represents",
          "fields": {
            "fieldName": "MongoDB.ObjectId|String|Number|Date|Boolean",
            "anotherField": "type with description if needed"
          }
        }
      ],
      "eventSchemas": [
        {
          "name": "EventName",
          "description": "When this event is emitted",
          "payload": {
            "field1": "type",
            "field2": "type"
          }
        }
      ]
    },
    "affectedRepositories": ["exact-repo-name-1", "exact-repo-name-2"],
    "repositoryResponsibilities": {
      "backend": "What backend will implement (APIs, models, business logic)",
      "frontend": "What frontend will implement (UI, components, state management)"
    }
  },
  "complexity": "simple|moderate|complex|epic",
  "successCriteria": ["measurable criterion 1", "measurable criterion 2"],
  "recommendations": "Technical approach based on ACTUAL code exploration",
  "challenges": ["technical challenge 1", "technical challenge 2"]
}
\`\`\`

**CRITICAL RULES**:
1. **Naming Conventions MUST be specific**: NOT "use consistent naming" but "userId" (exact field name)
2. **API Contracts MUST be complete**: Include ALL request/response fields with types
3. **Shared Types MUST match database**: If backend stores "userId", contract must say "userId"
4. **One Source of Truth**: Master Epic is the ONLY place where naming/contracts are defined

**DO NOT** output anything else. **DO NOT** talk about what you would do. **ACT**: Use tools, explore code, output JSON.`;

      // 🔥 IMAGES: Convert task attachments to SDK format
      const attachments: any[] = [];
      if (task.attachments && task.attachments.length > 0) {
        console.log(`📎 [ProductManager] Processing ${task.attachments.length} attachment(s)`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 Product Manager: Processing ${task.attachments.length} attachment(s) for visual context`
        );

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
              NotificationService.emitConsoleLog(
                taskId,
                'info',
                `  ✅ Image attached: ${fileName} (${fileSizeKB} KB, ${mimeType})`
              );
            } else {
              console.warn(`  ⚠️ Image file not found: ${imagePath}`);
              NotificationService.emitConsoleLog(
                taskId,
                'warn',
                `  ⚠️ Image file not found: ${path.basename(attachmentUrl)}`
              );
            }
          } catch (error: any) {
            const fileName = path.basename(attachmentUrl);
            console.error(`  ❌ Failed to process image ${fileName}:`, error.message);
            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `  ❌ Failed to process image ${fileName}: ${error.message}`
            );
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

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n📋 PRODUCT MANAGER - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

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

      // 🔥 NEW: Parse and store Master Epic from Product Manager output
      let masterEpic = null;
      try {
        const jsonMatch = result.output.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.masterEpic) {
            masterEpic = parsed.masterEpic;
            console.log(`✅ [ProductManager] Extracted Master Epic: ${masterEpic.id}`);
            console.log(`   Global Naming Conventions: ${Object.keys(masterEpic.globalNamingConventions || {}).length} conventions`);
            console.log(`   Shared Contracts: ${(masterEpic.sharedContracts?.apiEndpoints || []).length} APIs, ${(masterEpic.sharedContracts?.sharedTypes || []).length} types`);
            console.log(`   Affected Repositories: ${masterEpic.affectedRepositories?.join(', ')}`);
          }
        }
      } catch (error: any) {
        console.warn(`⚠️  [ProductManager] Failed to parse Master Epic: ${error.message}`);
      }

      // Store phase data for next phases
      context.setData('productManagerOutput', result.output);
      context.setData('taskComplexity', complexityMatch?.[1]?.toLowerCase() || 'medium');
      context.setData('masterEpic', masterEpic); // 🔥 NEW: Pass Master Epic to Project Manager

      // 🔥 CRITICAL: Store processed attachments in context for ALL subsequent agents
      // This ensures images/multimedia travel through ALL agents with complete context
      if (attachments.length > 0) {
        context.setData('attachments', attachments);
        console.log(`📎 [ProductManager] Stored ${attachments.length} attachment(s) in context for all agents`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📦 Stored ${attachments.length} image(s) in context - will be passed to ALL subsequent agents (Project Manager, Tech Lead, Developers, QA)`
        );
      }

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
