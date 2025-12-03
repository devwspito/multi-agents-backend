import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { hasMarker, extractMarkerValue } from './utils/MarkerValidator';
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
      // 🔥 CRITICAL EARLY VALIDATION: All repositories MUST have type assigned
      console.log(`\n🔍 [ProductManager] CRITICAL: Validating repository types...`);
      const repositoriesWithoutType = context.repositories.filter(r => !r.type);

      if (repositoriesWithoutType.length > 0) {
        const repoNames = repositoriesWithoutType.map(r => r.name || r.githubRepoName).join(', ');
        console.error(`\n❌ [ProductManager] CRITICAL ERROR: Repositories without type assigned!`);
        console.error(`   Repositories: ${repoNames}`);
        console.error(`   🔥 EACH repository MUST have 'type' field: 'backend', 'frontend', 'mobile', or 'shared'`);
        console.error(`   📋 Please update repositories in MongoDB before creating tasks`);
        console.error(`\n   Example fix:\n   await Repository.updateOne({ name: '${repositoriesWithoutType[0].name}' }, { $set: { type: 'backend' } });`);

        // Mark task as failed
        task.status = 'failed';
        task.orchestration.productManager.status = 'failed';
        task.orchestration.productManager.error = `Repositories without type: ${repoNames}. Cannot proceed without knowing repository types.`;
        await task.save();

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Task FAILED: Repositories [${repoNames}] have no type assigned. Update MongoDB: { type: 'backend' | 'frontend' | 'mobile' | 'shared' }`
        );

        throw new Error(`CRITICAL: Repositories [${repoNames}] missing required 'type' field. Cannot create epics without knowing repository types. Task marked as FAILED.`);
      }

      console.log(`   ✅ All ${context.repositories.length} repositories have valid types`);
      context.repositories.forEach(r => {
        const emoji = r.type === 'backend' ? '🔧' : r.type === 'frontend' ? '🎨' : r.type === 'mobile' ? '📱' : '📦';
        console.log(`      ${emoji} ${r.name || r.githubRepoName}: ${r.type.toUpperCase()}`);
      });

      // Build repositories information (available for prompt customization)
      void context.repositories; // Repository info used in prompt below
      void workspaceStructure; // Workspace structure used in prompt below

      // Previous output for revision (if any) - ALWAYS include if exists (for continuations)
      const previousOutput = task.orchestration.productManager.output;

      let revisionSection = '';
      if (previousOutput) {
        revisionSection = `

# Previous Analysis Available
Your previous analysis is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      // Get problem analysis from context if available
      const problemAnalysis = context.getData<any>('problemAnalysis');

      let problemAnalysisSection = '';
      if (problemAnalysis) {
        problemAnalysisSection = `
## 🧠 Problem Analysis (from Problem Analyst)

### Problem Statement:
${problemAnalysis.problemStatement || 'Not available'}

### Solution Architecture:
${problemAnalysis.solutionApproach || 'Not available'}

### Technical Analysis:
${problemAnalysis.technicalAnalysis || 'Not available'}

### Success Criteria:
${problemAnalysis.successCriteria?.map((c: string) => `- ${c}`).join('\n') || 'Not available'}

### Identified Risks:
${problemAnalysis.risks?.map((r: string) => `- ⚠️ ${r}`).join('\n') || 'None identified'}

### Implementation Strategy:
${problemAnalysis.implementationStrategy || 'Not available'}

**USE THIS ANALYSIS** to create better, more informed epics and stories that address the real problem and follow the recommended architecture.
`;
      }

      const prompt = `# Product Manager - Requirements Analysis
${revisionSection}${problemAnalysisSection}
## Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}
Priority: ${task.priority}

## Workspace: ${workspacePath}
Repositories:
${context.repositories.map(r => `- ${r.name}/ (${r.type})`).join('\n')}

## 🎯 INSTRUCTIONS (Be efficient):

1. **EXPLORE** (max 2 min): Check repos, understand structure
2. **ANALYZE**: Define naming conventions & contracts for cross-repo consistency
3. **OUTPUT JSON**: Master epic with shared specifications

${task.attachments && task.attachments.length > 0 ? `📎 ${task.attachments.length} image(s) attached - analyze for requirements\n` : ''}
${problemAnalysis ? `⚠️ Use Problem Analysis above to inform your epic creation\n` : ''}

## JSON OUTPUT ONLY:
\`\`\`json
{
  "masterEpic": {
    "id": "master-${task.title.toLowerCase().replace(/\\s+/g, '-')}",
    "title": "${task.title}",
    "globalNamingConventions": {
      "primaryIdField": "userId|id|_id (choose one)",
      "timestampFormat": "ISO8601|Unix (choose one)",
      "errorCodePrefix": "ERR_|ERROR_ (choose one)",
      "booleanFieldPrefix": "is|has (choose one)",
      "collectionNaming": "plural|singular"
    },
    "sharedContracts": {
      "apiEndpoints": [
        {
          "method": "GET|POST|PUT|DELETE",
          "path": "/api/path",
          "request": {"field": "type"},
          "response": {"field": "type"},
          "description": "Purpose"
        }
      ],
      "sharedTypes": [
        {
          "name": "TypeName",
          "description": "Purpose",
          "fields": {"field": "String|Number|Boolean|Date|ObjectId"}
        }
      ]
    },
    "affectedRepositories": ["repo1", "repo2"],
    "repositoryResponsibilities": {
      "backend": "APIs, models, logic",
      "frontend": "UI, state, components"
    }
  },
  "complexity": "simple|moderate|complex|epic",
  "successCriteria": ["criterion 1", "criterion 2"],
  "recommendations": "Technical approach",
  "challenges": ["challenge 1", "challenge 2"],
  "identifiedFiles": {
    "backend": {
      "filesToModify": ["src/path/to/existing/file.ts"],
      "filesToCreate": ["src/path/to/new/file.ts"],
      "filesToRead": ["src/path/to/reference.ts"]
    },
    "frontend": {
      "filesToModify": ["src/path/to/existing/file.tsx"],
      "filesToCreate": ["src/path/to/new/file.tsx"],
      "filesToRead": ["src/path/to/reference.tsx"]
    }
  }
}
\`\`\`

**RULES**:
- Explore FIRST: Use ls, find, Read, Grep to find REAL file paths
- **MANDATORY**: identifiedFiles MUST contain actual file paths you found
- Be SPECIFIC: Real paths like "src/hooks/useMaterials.js" not "src/hooks/*"
- Complete contracts: All fields with types
- Act quickly: Max 3 min exploration
- **NO EMPTY ARRAYS**: Every repo must have at least 1 file path`;

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

      // 🔥 NEW: Parse and store Master Epic + identifiedFiles from Product Manager output
      // Now using plain text markers instead of JSON
      let masterEpic = null;
      let identifiedFiles: Record<string, { filesToModify: string[]; filesToCreate: string[]; filesToRead: string[] }> = {};

      // Check for completion marker
      if (hasMarker(result.output, '✅ EPIC_DEFINED')) {
        console.log(`✅ [ProductManager] Epic defined successfully`);

        // Extract Epic ID
        const epicId = extractMarkerValue(result.output, '📍 Epic ID:');
        if (epicId) {
          masterEpic = { id: epicId };
          console.log(`✅ [ProductManager] Extracted Epic ID: ${epicId}`);
        }

        // Try to parse any JSON sections in the output for structured data
        // (the agent may still include JSON for complex data structures)
        try {
          const jsonMatch = result.output.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed.masterEpic) {
              masterEpic = parsed.masterEpic;
              console.log(`   Global Naming Conventions: ${Object.keys(masterEpic.globalNamingConventions || {}).length} conventions`);
              console.log(`   Shared Contracts: ${(masterEpic.sharedContracts?.apiEndpoints || []).length} APIs, ${(masterEpic.sharedContracts?.sharedTypes || []).length} types`);
              console.log(`   Affected Repositories: ${masterEpic.affectedRepositories?.join(', ')}`);
            }

            // 🔥 CRITICAL: Extract identifiedFiles for ProjectManager
            if (parsed.identifiedFiles) {
              identifiedFiles = parsed.identifiedFiles;
              console.log(`✅ [ProductManager] Extracted identifiedFiles:`);
              for (const [repo, files] of Object.entries(identifiedFiles)) {
                const f = files as { filesToModify: string[]; filesToCreate: string[]; filesToRead: string[] };
                const totalFiles = (f.filesToModify?.length || 0) + (f.filesToCreate?.length || 0) + (f.filesToRead?.length || 0);
                console.log(`   ${repo}: ${totalFiles} files (modify: ${f.filesToModify?.length || 0}, create: ${f.filesToCreate?.length || 0}, read: ${f.filesToRead?.length || 0})`);
              }
            } else {
              console.warn(`⚠️  [ProductManager] NO identifiedFiles in output - ProjectManager will need to explore codebase`);
            }
          }
        } catch (error: any) {
          console.warn(`⚠️  [ProductManager] Failed to parse optional JSON sections: ${error.message}`);
        }
      } else {
        console.warn(`⚠️  [ProductManager] No EPIC_DEFINED marker found - epic may not be complete`);
      }

      // Store phase data for next phases
      context.setData('productManagerOutput', result.output);
      context.setData('taskComplexity', complexityMatch?.[1]?.toLowerCase() || 'medium');
      context.setData('masterEpic', masterEpic); // 🔥 Pass Master Epic to Project Manager
      context.setData('identifiedFiles', identifiedFiles); // 🔥 CRITICAL: Pass identified files to Project Manager

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
