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
   * Skip if Project Manager already completed (ONLY for recovery, NOT for continuations)
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
      console.log(`🔄 [ProjectManager] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.projectManager?.status === 'completed') {
      console.log(`[SKIP] Project Manager already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution for next phases
      if (context.task.orchestration.projectManager.output) {
        context.setData('projectManagerOutput', context.task.orchestration.projectManager.output);

        // CRITICAL: Parse and restore epics to context for TeamOrchestration
        try {
          const outputText = context.task.orchestration.projectManager.output;
          const jsonMatch = outputText.match(/```json\s*([\s\S]*?)\s*```/);

          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1]);
            if (parsed.epics && Array.isArray(parsed.epics)) {
              // Validate and separate epics (same as normal execution)
              const validatedEpics = this.validateAndSeparateEpics(parsed.epics, context);
              context.setData('epics', validatedEpics);
              context.setData('totalTeamsNeeded', parsed.totalTeamsNeeded || validatedEpics.length);
              console.log(`✅ [ProjectManager] Restored ${validatedEpics.length} epic(s) from previous execution`);
            }
          }
        } catch (error) {
          console.warn(`⚠️  [ProjectManager] Failed to parse epics from previous output:`, error);
        }
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
      // Build repositories information with TYPE for multi-repo orchestration
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) => {
            const typeEmoji = repo.type === 'backend' ? '🔧' : repo.type === 'frontend' ? '🎨' : '📦';
            return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}
   - Execution Order: ${repo.executionOrder || 'not set'}`;
          }).join('\n')}\n
## 🔥 CRITICAL: Multi-Repo Epic Assignment Rules

**YOU MUST ASSIGN THE CORRECT REPOSITORY TO EACH EPIC BASED ON THE WORK TYPE**:

### 🔧 BACKEND EPICS → BACKEND REPOSITORIES
**Assign to BACKEND if the epic involves**:
- ✅ REST APIs, GraphQL endpoints, WebSocket servers
- ✅ Database models, schemas, migrations, queries
- ✅ Business logic, services, controllers
- ✅ Authentication, authorization, middleware
- ✅ Server-side validation, data processing
- ✅ Background jobs, cron tasks, workers
- ✅ Third-party API integrations (server-side)

### 🎨 FRONTEND EPICS → FRONTEND REPOSITORIES
**Assign to FRONTEND if the epic involves**:
- ✅ UI components, views, pages, layouts
- ✅ Client-side state management (Redux, Context)
- ✅ Forms, user input, client-side validation
- ✅ Styling, CSS, animations, responsive design
- ✅ Routing, navigation, browser APIs
- ✅ Client-side data fetching, caching
- ✅ User interactions, event handlers

### 📱 MOBILE EPICS → MOBILE REPOSITORIES
**Assign to MOBILE if the epic involves**:
- ✅ Native mobile UI, screens, navigation
- ✅ Device-specific features (camera, GPS, push notifications)
- ✅ Mobile-specific performance optimizations
- ✅ App store deployments, versioning

### 📦 SHARED/LIBRARY EPICS → SHARED REPOSITORIES
**Assign to SHARED if the epic involves**:
- ✅ Shared types, interfaces, utilities
- ✅ Common validation rules, constants
- ✅ Cross-platform helper functions

### ⚠️ MULTI-REPO EPICS (Rare - use with caution)
**ONLY assign multiple repositories if the epic requires SIMULTANEOUS changes in BOTH repos**:
- Example: New API endpoint (backend) + UI consuming it (frontend)
- In this case: "affectedRepositories": ["backend-name", "frontend-name"]
- The system will AUTOMATICALLY split this into 2 sub-epics

### 🚫 COMMON MISTAKES TO AVOID:
- ❌ Assigning API routes to frontend → WRONG (APIs = backend)
- ❌ Assigning React components to backend → WRONG (UI = frontend)
- ❌ Assigning ALL epics to the same repo → WRONG (analyze each epic)
- ❌ Using repository names that don't exist → WRONG (use EXACT names from list above)
`
        : '';

      // Workspace info for future use (if needed in prompt)
      void workspaceStructure; // Suppress unused variable warning

      const productManagerAnalysis = task.orchestration.productManager.output || 'No product analysis available.';

      // 🔥 CRITICAL: Get identifiedFiles from ProductManager (structured JSON)
      const identifiedFiles = context.getData<Record<string, { filesToModify: string[]; filesToCreate: string[]; filesToRead: string[] }>>('identifiedFiles') || {};
      let identifiedFilesSection = '';

      if (Object.keys(identifiedFiles).length > 0) {
        identifiedFilesSection = `
## 🔥 IDENTIFIED FILES FROM PRODUCT MANAGER (USE THESE):
\`\`\`json
${JSON.stringify(identifiedFiles, null, 2)}
\`\`\`
**CRITICAL**: These files were identified by Product Manager. Use them in your epics.
Each epic MUST include files from this list in filesToModify/filesToCreate/filesToRead.
`;
        console.log(`📋 [ProjectManager] Received ${Object.keys(identifiedFiles).length} repo(s) with identified files from ProductManager`);
      } else {
        console.warn(`⚠️  [ProjectManager] No identifiedFiles received from ProductManager - will need to explore codebase`);
      }

      // 🔥 VALIDATION FEEDBACK: If this is a retry after validation failure, prepend feedback
      const feedbackHistory = context.getData<string[]>('projectManagerFeedback') || [];
      let validationFeedbackSection = '';

      if (feedbackHistory.length > 0) {
        const latestFeedback = feedbackHistory[feedbackHistory.length - 1];
        validationFeedbackSection = `

${latestFeedback}

---

**Please correct the errors above and output the corrected JSON.**
`;
      }

      // Previous output for revision (if any)
      const previousOutput = task.orchestration.projectManager.output;

      let revisionSection = '';
      // ALWAYS include previous context if exists (for continuations), unless we have validation feedback (takes priority)
      if (previousOutput && !validationFeedbackSection) {
        revisionSection = `

# Previous Project Plan Available
Your previous project plan is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      const prompt = `# Project Manager - Scope & Dependencies
${validationFeedbackSection}${revisionSection}
## Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}

## Product Analysis:
${productManagerAnalysis}
${identifiedFilesSection}
## Workspace: ${workspacePath}
${repoInfo}

## 🎯 INSTRUCTIONS (Be efficient):

1. ${Object.keys(identifiedFiles).length > 0 ? '**USE IDENTIFIED FILES**: Product Manager already found the files - use them!' : '**EXPLORE** (max 2 min): Find real files in repos'}
2. **DEFINE EPICS**: Break into 3-5 major features with file paths
3. **AVOID OVERLAPS**: Each epic must touch different files
4. **OUTPUT JSON**: Epic plan with dependencies

## CRITICAL RULES:
- EVERY epic MUST have real file paths (no placeholders)
- ${Object.keys(identifiedFiles).length > 0 ? '**USE THE identifiedFiles ABOVE** - they are already validated' : 'Find real file paths using ls, find, Read'}
- NO two epics can modify the same files
- Backend repos: APIs, models, logic
- Frontend repos: UI, components, views

## Overlap Prevention:
If epics need same files, either:
1. MERGE them into one epic
2. SEQUENCE with dependencies
3. SPLIT into different files

## 🚨🚨🚨 CRITICAL: PURE JSON OUTPUT ONLY 🚨🚨🚨

YOUR ENTIRE RESPONSE MUST BE VALID JSON AND NOTHING ELSE.

⛔ ABSOLUTELY FORBIDDEN:
- NO markdown (no \`\`\`json blocks)
- NO text before JSON ("Let me analyze...", "Here's the plan...")
- NO text after JSON
- NO comments or explanations

✅ YOUR RESPONSE MUST:
- START with { (opening brace)
- END with } (closing brace)
- Be ONLY valid JSON

EXAMPLE OUTPUT (this is EXACTLY how your response should look):
{"epics":[{"id":"epic-backend-api","title":"Create User API Endpoints","description":"REST API for user CRUD operations","affectedRepositories":["v2_backend"],"filesToModify":["src/routes/users.ts","src/controllers/UserController.ts"],"filesToCreate":["src/models/User.ts"],"filesToRead":["src/config/database.ts"],"estimatedComplexity":"moderate","dependencies":[],"executionOrder":1},{"id":"epic-frontend-ui","title":"User Management UI","description":"React components for user management","affectedRepositories":["v2_frontend"],"filesToModify":["src/App.tsx"],"filesToCreate":["src/components/UserList.tsx"],"filesToRead":["src/api/client.ts"],"estimatedComplexity":"simple","dependencies":["epic-backend-api"],"executionOrder":2}],"totalTeamsNeeded":2,"dependencies":{"cross_repo":["backend API must exist before frontend"],"external":[],"sequential":["epic-2 depends on epic-1"]},"risks":[],"outOfScope":[],"assumptions":[]}

⚠️ FIRST explore the codebase, THEN output ONLY the JSON (no other text).`;

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

      // Parse JSON response - expecting PURE JSON (no markdown)
      let parsed: any;
      const trimmedOutput = result.output.trim();

      // STEP 1: Try parsing as pure JSON (EXPECTED case)
      try {
        parsed = JSON.parse(trimmedOutput);
        if (parsed.epics && Array.isArray(parsed.epics)) {
          console.log('✅ [ProjectManager] Parsed as pure JSON');
        } else {
          console.warn('⚠️  [ProjectManager] JSON parsed but missing epics array');
          parsed = null;
        }
      } catch (e) {
        console.warn('⚠️  [ProjectManager] Output is not pure JSON, trying fallback extraction...');
      }

      // STEP 2: Fallback - extract JSON from text (if model added text before/after)
      if (!parsed) {
        // Find JSON object starting with {"epics" anywhere in output
        const jsonPatterns = ['{"epics"', '{ "epics"', '{\n  "epics"', '{\n"epics"'];
        let jsonStartIndex = -1;

        for (const pattern of jsonPatterns) {
          jsonStartIndex = result.output.indexOf(pattern);
          if (jsonStartIndex !== -1) break;
        }

        if (jsonStartIndex !== -1) {
          try {
            const jsonSubstring = result.output.substring(jsonStartIndex);
            // Find matching closing brace by counting braces
            let braceCount = 0;
            let endIndex = 0;
            for (let i = 0; i < jsonSubstring.length; i++) {
              if (jsonSubstring[i] === '{') braceCount++;
              if (jsonSubstring[i] === '}') braceCount--;
              if (braceCount === 0) {
                endIndex = i + 1;
                break;
              }
            }
            if (endIndex > 0) {
              const jsonText = jsonSubstring.substring(0, endIndex);
              parsed = JSON.parse(jsonText);
              if (parsed.epics && Array.isArray(parsed.epics)) {
                console.log('⚠️  [ProjectManager] Extracted JSON from text (model did not output pure JSON)');
              } else {
                parsed = null;
              }
            }
          } catch (e) {
            // Continue to markdown fallback
          }
        }
      }

      // STEP 3: Last resort - try markdown blocks (deprecated but kept for safety)
      if (!parsed) {
        const markdownMatch = result.output.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (markdownMatch) {
          try {
            parsed = JSON.parse(markdownMatch[1].trim());
            if (parsed.epics && Array.isArray(parsed.epics)) {
              console.warn('⚠️  [ProjectManager] Parsed from markdown block (model should output pure JSON!)');
            } else {
              parsed = null;
            }
          } catch (e) {
            // Failed all attempts
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

      // 🔥 NEW: Validate epics and collect validation errors for retry
      const validationErrors = this.validateEpics(parsed.epics);

      if (validationErrors.length > 0) {
        console.error(`\n❌ [ProjectManager] Epic validation failed with ${validationErrors.length} error(s)`);
        validationErrors.forEach((err, i) => {
          console.error(`\n   Error ${i + 1}: ${err.epicId || 'unknown'}`);
          console.error(`   ${err.message}`);
        });

        // 🔥 AUTO-CORRECTION: Retry with feedback instead of failing
        const feedbackHistory = context.getData<string[]>('projectManagerFeedback') || [];
        const maxRetries = 3; // SDK-compliant: Give agent more opportunities to correct

        if (feedbackHistory.length < maxRetries) {
          console.log(`\n🔄 [ProjectManager] Attempting auto-correction (attempt ${feedbackHistory.length + 1}/${maxRetries})...`);

          // Build feedback for retry
          const feedback = this.buildValidationFeedback(validationErrors, parsed.epics);
          feedbackHistory.push(feedback);
          context.setData('projectManagerFeedback', feedbackHistory);

          // Update task with feedback for next attempt
          task.orchestration.projectManager.status = 'in_progress';
          task.orchestration.projectManager.output = result.output; // Keep previous output
          await task.save();

          // Emit notification
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️ Project Manager output needs correction. Retrying with feedback (attempt ${feedbackHistory.length}/${maxRetries})...`
          );

          // RECURSIVE RETRY: Re-execute Project Manager phase with feedback
          console.log(`\n🔄 [ProjectManager] Re-executing with validation feedback...\n`);
          return this.executePhase(context); // Retry with feedback in context
        } else {
          // 🔥 SDK-COMPLIANT: Check if there are CRITICAL errors (missing file paths)
          const criticalErrors = validationErrors.filter(e => e.type === 'missing_files');

          if (criticalErrors.length > 0) {
            // BLOCKING: Cannot proceed without file paths
            console.error(`\n❌ [ProjectManager] CRITICAL: Epics without file paths after ${maxRetries} retries`);
            console.error(`\n📋 SDK Best Practice: "Define clear rules to identify failures"`);
            console.error(`   Epic validation requires concrete file paths for overlap detection.`);
            console.error(`   Without file paths, we cannot validate if epics can run in parallel.\n`);

            throw new Error(
              `🚨 CRITICAL VALIDATION FAILURE (after ${maxRetries} retries)\n\n` +
              `❌ Epics without file paths cannot be validated for overlaps or dependencies.\n\n` +
              `The following epics are missing file paths:\n` +
              criticalErrors.map(err => `- ${err.epicId}: ${err.message}`).join('\n') +
              `\n\n💡 SDK COMPLIANCE: This validation enforces formal rules to prevent:\n` +
              `   - File conflicts (multiple developers editing same files)\n` +
              `   - Merge conflicts (parallel work on same codebase)\n` +
              `   - Inconsistent implementations (no shared contracts)\n\n` +
              `Task cannot proceed without file paths. Please review task requirements.`
            );
          }

          // Max retries reached - fail with detailed error
          console.error(`\n❌ [ProjectManager] Max retries (${maxRetries}) reached. Cannot auto-correct epics.`);
          throw new Error(
            `🚨 PROJECT MANAGER VALIDATION FAILED (after ${maxRetries} retries)\n\n` +
            `The following epics have validation errors:\n\n` +
            validationErrors.map(err => `- ${err.epicId}: ${err.message}`).join('\n') +
            `\n\nPlease review the task requirements and try again.`
          );
        }
      }

      // 🔥 VALIDATE AND SEPARATE EPICS BY REPOSITORY (with overlap detection)
      let validatedEpics: any[] = [];
      try {
        validatedEpics = this.validateAndSeparateEpics(parsed.epics, context);
        console.log(`✅ [ProjectManager] After validation: ${validatedEpics.length} epic(s) (separated by repository)`);
      } catch (overlapError: any) {
        // 🔥 OVERLAP DETECTED: Retry with feedback
        if (overlapError.message.includes('Epic overlap detected')) {
          // 🔥 CRITICAL: Use SEPARATE counter for overlap retries (not validation retries)
          const overlapRetries = context.getData<number>('projectManagerOverlapRetries') || 0;
          const maxOverlapRetries = 3; // 3 attempts to resolve overlaps

          if (overlapRetries < maxOverlapRetries) {
            console.log(`\n🔄 [ProjectManager] Overlap detected. Attempting auto-correction (overlap attempt ${overlapRetries + 1}/${maxOverlapRetries})...`);

            // Build overlap feedback
            const feedbackHistory = context.getData<string[]>('projectManagerFeedback') || [];
            const overlapFeedback = this.buildOverlapFeedback(overlapError.message, parsed.epics);
            feedbackHistory.push(overlapFeedback);
            context.setData('projectManagerFeedback', feedbackHistory);

            // Increment OVERLAP-specific retry counter
            context.setData('projectManagerOverlapRetries', overlapRetries + 1);

            // Update task
            task.orchestration.projectManager.status = 'in_progress';
            await task.save();

            // Emit notification
            NotificationService.emitConsoleLog(
              taskId,
              'warn',
              `⚠️ Epic overlap detected. Retrying with resolution strategies (overlap attempt ${overlapRetries + 1}/${maxOverlapRetries})...`
            );

            // RECURSIVE RETRY
            console.log(`\n🔄 [ProjectManager] Re-executing with overlap feedback...\n`);
            return this.executePhase(context);
          } else {
            // 🚨 CIRCUIT BREAKER: Max overlap retries reached - MUST STOP EXECUTION
            console.error(`\n${'🔥'.repeat(60)}`);
            console.error(`🔥 CIRCUIT BREAKER ACTIVATED`);
            console.error(`🔥 ProjectManager failed to resolve epic overlaps after ${maxOverlapRetries} attempts`);
            console.error(`🔥 CANNOT PROCEED - Overlapping epics would cause merge conflicts`);
            console.error(`🔥 ORCHESTRATION MUST STOP - TechLead/Developer phases will NOT execute`);
            console.error(`${'🔥'.repeat(60)}\n`);

            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `🔥 CIRCUIT BREAKER: ProjectManager could not resolve epic overlaps after ${maxOverlapRetries} attempts. Execution stopped.`
            );

            throw overlapError; // This will be caught by outer catch block and return success: false
          }
        } else {
          // Not an overlap error, re-throw
          throw overlapError;
        }
      }

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
      // 🚨 CRITICAL VALIDATION FAILURE CHECK
      // If this is a validation error (overlap or missing files), we MUST block execution
      const isValidationError = error.message.includes('EPIC OVERLAP DETECTED') ||
                                error.message.includes('CRITICAL VALIDATION FAILURE') ||
                                error.message.includes('max retries');

      if (isValidationError) {
        console.error(`\n${'🚨'.repeat(40)}`);
        console.error(`🚨 CRITICAL: VALIDATION FAILURE - EXECUTION BLOCKED`);
        console.error(`🚨 Project Manager failed to produce valid epics after retries`);
        console.error(`🚨 Error: ${error.message}`);
        console.error(`🚨 CANNOT PROCEED TO TECH LEAD PHASE`);
        console.error(`${'🚨'.repeat(40)}\n`);

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `🚨 CRITICAL VALIDATION FAILURE: ${error.message}`
        );
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `⛔ EXECUTION BLOCKED - Project Manager could not resolve epic conflicts`
        );
      }

      task.orchestration.projectManager.status = 'failed';
      task.orchestration.projectManager.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Project Manager', error.message);

      await LogService.agentFailed('project-manager', taskId, error, {
        phase: 'planning',
        validationError: isValidationError,
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
          validationError: isValidationError,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [ProjectManager] Emitted ProjectManagerCompleted event (error state)`);

      // 🔥 EXPLICIT BLOCK: Return success: false to ensure orchestration stops
      return {
        success: false,
        error: error.message,
        data: {
          validationError: isValidationError,
          blocked: true,
        },
      };
    }
  }

  /**
   * Validates epics and separates them by repository if needed
   *
   * If an epic spans multiple repositories, splits it into separate epics (one per repository)
   * Adds dependencies so backend epics execute before frontend epics
   * 🔥 NEW: Detects overlapping epics and enforces Master Epic contracts
   */
  private validateAndSeparateEpics(epics: any[], context: OrchestrationContext): any[] {
    const result: any[] = [];
    const repositories = context.repositories;

    if (repositories.length === 0) {
      console.log('⚠️  [ProjectManager] No repositories configured - skipping multi-repo validation');
      return epics;
    }

    // 🔥 NEW: Get Master Epic from context (created by Product Manager)
    const masterEpic = context.getData<any>('masterEpic');
    if (masterEpic) {
      console.log(`\n🎯 [ProjectManager] Master Epic detected: ${masterEpic.id}`);
      console.log(`   Title: ${masterEpic.title}`);
      console.log(`   Naming Conventions: ${Object.keys(masterEpic.globalNamingConventions || {}).length} defined`);
      console.log(`   Shared Contracts: ${(masterEpic.sharedContracts?.apiEndpoints || []).length} APIs, ${(masterEpic.sharedContracts?.sharedTypes || []).length} types`);
    }

    // 🔥 NEW: Initialize Epic Registry (tracks all epics by repository to detect overlaps)
    const epicRegistry = context.getData<Map<string, any[]>>('epicRegistry') || new Map();

    // Get repository execution order
    const executionOrder = getRepositoryExecutionOrder(repositories);
    console.log(`📋 [ProjectManager] Repository execution order: ${executionOrder.join(' → ')}`);

    // 🆕 SDK-COMPLIANT: Detect shared domains BEFORE processing individual epics
    const sharedDomains = this.detectSharedDomain(epics);

    if (sharedDomains.size > 0) {
      console.warn(`\n⚠️  [ProjectManager] Detected ${sharedDomains.size} shared domain(s) - epics likely modify same files:`);

      for (const [domainKey, domainEpics] of sharedDomains.entries()) {
        console.warn(`\n   📦 Domain "${domainKey}"`);
        console.warn(`      Epics (${domainEpics.length}):`);
        domainEpics.forEach(e => {
          console.warn(`      - ${e.id}: "${e.title}"`);
        });
        console.warn(`      ⚠️  WARNING: These epics share keywords and target the same repository`);
        console.warn(`      💡 LIKELY OUTCOME: File overlap will be detected during validation`);
        console.warn(`      💡 RECOMMENDATION: Consider MERGE or SEQUENCE strategies\n`);
      }

      // Build feedback warning for shared domains
      let domainWarning = `\n## ⚠️ Shared Domain Detection\n\n`;
      domainWarning += `SDK Best Practice: Multiple epics targeting the same domain often cause file conflicts.\n\n`;
      domainWarning += `Detected ${sharedDomains.size} domain group(s):\n\n`;

      for (const [domainKey, domainEpics] of sharedDomains.entries()) {
        domainWarning += `**Domain "${domainKey}"** (${domainEpics.length} epics):\n`;
        domainEpics.forEach(e => {
          domainWarning += `- ${e.id}: "${e.title}"\n`;
        });
        domainWarning += `\n💡 These epics share similar titles/keywords. They will likely modify the same files.\n`;
        domainWarning += `   Consider using MERGE or SEQUENCE strategies to avoid conflicts.\n\n`;
      }

      // Store warning in context (will be included in next retry if file overlap is detected)
      context.setData('sharedDomainWarning', domainWarning);
    }

    for (const epic of epics) {
      // Collect all files mentioned in the epic
      const allFiles = [
        ...(epic.filesToRead || []),
        ...(epic.filesToModify || []),
        ...(epic.filesToCreate || []),
      ];

      if (allFiles.length === 0) {
        // No files specified - keep epic as-is but add Master Epic metadata
        const enrichedEpic = {
          ...epic,
          masterEpicId: masterEpic?.id,
          globalNamingConventions: masterEpic?.globalNamingConventions,
          sharedContracts: masterEpic?.sharedContracts,
        };
        result.push(enrichedEpic);
        continue;
      }

      // 🔥 PRIORITY 1: Use explicit affectedRepositories from epic JSON if provided
      let affinity: ReturnType<typeof analyzeRepositoryAffinity>;

      if (epic.affectedRepositories && Array.isArray(epic.affectedRepositories) && epic.affectedRepositories.length > 0) {
        // Epic explicitly specified which repositories it affects
        console.log(`✅ [ProjectManager] Epic "${epic.id}" has explicit affectedRepositories:`, epic.affectedRepositories);

        // Build affinity object from explicit repositories
        const filesByRepository = new Map<string, string[]>();

        for (const repoName of epic.affectedRepositories) {
          // Assign all files to each specified repository
          filesByRepository.set(repoName, allFiles);
        }

        affinity = {
          primaryRepository: epic.affectedRepositories[0],
          affectedRepositories: epic.affectedRepositories,
          filesByRepository,
          isMultiRepo: epic.affectedRepositories.length > 1,
        };
      } else {
        // 🔥 PRIORITY 2: Infer repository from file paths using pathPatterns
        console.log(`⚠️  [ProjectManager] Epic "${epic.id}" has no explicit affectedRepositories - inferring from file paths...`);
        affinity = analyzeRepositoryAffinity(allFiles, repositories);
      }

      if (affinity.isMultiRepo) {
        // Epic spans multiple repositories - split it
        console.log(`⚠️  [ProjectManager] Epic "${epic.id}" spans multiple repos:`, affinity.affectedRepositories);

        for (const [_index, repoName] of affinity.affectedRepositories.entries()) {
          const filesForRepo = affinity.filesByRepository.get(repoName) || [];
          const repo = repositories.find(r => r.name === repoName);

          if (!repo) continue;

          // 🔥 NEW: Check for overlapping epics in this repository
          const existingEpics = epicRegistry.get(repoName) || [];
          const overlap = this.detectEpicOverlap(epic, existingEpics, filesForRepo);

          if (overlap) {
            console.error(`\n❌ [EPIC OVERLAP DETECTED]`);
            console.error(`   Repository: ${repoName}`);
            console.error(`   New Epic: ${epic.title}`);
            console.error(`   Conflicts with: ${overlap.title}`);
            console.error(`   Overlapping files: ${overlap.overlappingFiles.join(', ')}`);
            console.error(`\n   💡 SOLUTION: Merge these epics or adjust scope in Product Manager phase`);

            throw new Error(
              `Epic overlap detected in repository "${repoName}"!\n` +
              `New epic "${epic.title}" conflicts with existing epic "${overlap.title}".\n` +
              `Overlapping files: ${overlap.overlappingFiles.join(', ')}\n` +
              `Solution: These features should be combined into a single epic.`
            );
          }

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

          // 🔥 NEW: Enrich epic with Master Epic metadata
          const subEpic = {
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
            // 🔥 NEW: Master Epic metadata
            masterEpicId: masterEpic?.id,
            globalNamingConventions: masterEpic?.globalNamingConventions,
            sharedContracts: masterEpic?.sharedContracts,
          };

          result.push(subEpic);

          // 🔥 NEW: Register this epic to detect future overlaps
          if (!epicRegistry.has(repoName)) {
            epicRegistry.set(repoName, []);
          }
          epicRegistry.get(repoName)!.push(subEpic);
        }
      } else {
        // Epic is single-repo - just add metadata
        const repoName = affinity.primaryRepository;

        // 🔥 FIX: Validate repository name before overlap detection
        if (!repoName || repoName.trim() === '') {
          console.error(`\n⚠️  [ProjectManager] Epic "${epic.id}" has no repository assignment!`);
          console.error(`   Files detected: ${allFiles.join(', ')}`);
          console.error(`   Available repositories: ${repositories.map(r => r.name).join(', ')}`);

          // Try to infer repository from file paths
          let inferredRepo = 'unknown';
          if (allFiles.length > 0) {
            const firstFile = allFiles[0];
            if (firstFile.startsWith('backend/') || firstFile.includes('/backend/')) {
              inferredRepo = repositories.find(r => r.type === 'backend')?.name || 'backend';
            } else if (firstFile.startsWith('src/') && !firstFile.includes('backend')) {
              inferredRepo = repositories.find(r => r.type === 'frontend')?.name || 'frontend';
            }
          }

          console.warn(`   Inferring repository: ${inferredRepo}`);
          affinity.primaryRepository = inferredRepo;
        }

        // 🔥 NEW: Check for overlapping epics (use updated primaryRepository)
        const finalRepoName = affinity.primaryRepository; // Use updated value after inference
        const existingEpics = epicRegistry.get(finalRepoName) || [];
        const overlap = this.detectEpicOverlap(epic, existingEpics, allFiles);

        if (overlap) {
          console.error(`\n❌ [EPIC OVERLAP DETECTED]`);
          console.error(`   Repository: ${finalRepoName || 'unknown'}`);
          console.error(`   New Epic: ${epic.title}`);
          console.error(`   Conflicts with: ${overlap.title}`);
          console.error(`   Overlapping files: ${overlap.overlappingFiles.join(', ')}`);
          console.error(`\n   📋 HOW TO FIX THIS:`);
          console.error(`   Option 1: MERGE these epics into ONE epic that handles both features`);
          console.error(`   Option 2: SPLIT the file - refactor so each epic touches different files`);
          console.error(`   Option 3: SEQUENCE the epics - make one depend on the other (dependencies: ["${overlap.epicId}"])`);
          console.error(`   Option 4: ADJUST scope - remove overlapping files from one epic\n`);

          throw new Error(
            `Epic overlap detected in repository "${finalRepoName || 'unknown'}"!\n` +
            `New epic "${epic.title}" conflicts with existing epic "${overlap.title}".\n` +
            `Overlapping files: ${overlap.overlappingFiles.join(', ')}\n` +
            `Solution: These features should be combined into a single epic.`
          );
        }

        const enrichedEpic = {
          ...epic,
          targetRepository: finalRepoName,
          affectedRepositories: affinity.affectedRepositories,
          executionOrder: repositories.find(r => r.name === finalRepoName)?.executionOrder || 1,
          // 🔥 NEW: Master Epic metadata
          masterEpicId: masterEpic?.id,
          globalNamingConventions: masterEpic?.globalNamingConventions,
          sharedContracts: masterEpic?.sharedContracts,
        };

        result.push(enrichedEpic);

        // 🔥 FIX: Use finalRepoName (updated after inference) instead of repoName
        if (!epicRegistry.has(finalRepoName)) {
          epicRegistry.set(finalRepoName, []);
        }
        epicRegistry.get(finalRepoName)!.push(enrichedEpic);
      }
    }

    // 🔥 NEW: Store epic registry in context for future phases
    context.setData('epicRegistry', epicRegistry);

    // Sort epics by execution order
    result.sort((a, b) => (a.executionOrder || 999) - (b.executionOrder || 999));

    return result;
  }

  /**
   * 🔥 NEW: Validate epics and return array of validation errors
   */
  private validateEpics(epics: any[]): Array<{ epicId: string; message: string; type: string }> {
    const errors: Array<{ epicId: string; message: string; type: string }> = [];

    for (const epic of epics) {
      const allFiles = [
        ...(epic.filesToRead || []),
        ...(epic.filesToModify || []),
        ...(epic.filesToCreate || []),
      ];

      // Error 1: No file paths
      if (allFiles.length === 0) {
        errors.push({
          epicId: epic.id,
          message: `Epic "${epic.title}" has NO file paths. Add "filesToModify", "filesToCreate", or "filesToRead".`,
          type: 'missing_files',
        });
        continue; // Skip other checks for this epic
      }

      // Error 2: Placeholder paths
      const placeholderPatterns = [
        { pattern: /path\/to\//, name: 'path/to/' },
        { pattern: /example/i, name: 'example' },
        { pattern: /placeholder/i, name: 'placeholder' },
        { pattern: /TODO/i, name: 'TODO' },
        { pattern: /\.\.\./, name: '...' },
      ];

      for (const file of allFiles) {
        for (const { pattern, name } of placeholderPatterns) {
          if (pattern.test(file)) {
            errors.push({
              epicId: epic.id,
              message: `Epic "${epic.title}" has PLACEHOLDER path "${file}" (contains "${name}"). Replace with real file path from codebase.`,
              type: 'placeholder_path',
            });
          }
        }
      }
    }

    return errors;
  }

  /**
   * 🔥 NEW: Build feedback message for Project Manager retry
   */
  private buildValidationFeedback(
    errors: Array<{ epicId: string; message: string; type: string }>,
    epics: any[]
  ): string {
    let feedback = `# 🔄 VALIDATION FEEDBACK - Please Correct Your Epics\n\n`;
    feedback += `Your previous output had ${errors.length} validation error(s). Please fix them:\n\n`;

    // Group errors by type
    const missingFilesErrors = errors.filter(e => e.type === 'missing_files');
    const placeholderErrors = errors.filter(e => e.type === 'placeholder_path');

    if (missingFilesErrors.length > 0) {
      feedback += `## ❌ Epics Missing File Paths\n\n`;
      feedback += `These epics have NO file paths. You MUST explore the codebase and specify which files will be modified/created:\n\n`;
      missingFilesErrors.forEach(err => {
        const epic = epics.find(e => e.id === err.epicId);
        feedback += `### ${err.epicId}: ${epic?.title}\n`;
        feedback += `- **Problem**: ${err.message}\n`;
        feedback += `- **Fix**: Use Bash/Read tools to find relevant files, then add:\n`;
        feedback += `  \`\`\`json\n`;
        feedback += `  "filesToModify": ["backend/src/actual/file.js"],\n`;
        feedback += `  "filesToCreate": ["backend/src/new/file.js"]\n`;
        feedback += `  \`\`\`\n\n`;
      });
    }

    if (placeholderErrors.length > 0) {
      feedback += `## ❌ Epics with Placeholder Paths\n\n`;
      feedback += `These epics have placeholder paths. Replace them with REAL paths from the codebase:\n\n`;
      placeholderErrors.forEach(err => {
        feedback += `- ${err.message}\n`;
      });
      feedback += `\n**Action**: Explore the codebase to find actual file paths, then update your JSON.\n\n`;
    }

    feedback += `## ✅ What You Should Do\n\n`;
    feedback += `1. **Explore the codebase** using Bash/Read tools\n`;
    feedback += `2. **Identify actual files** that need to be modified/created for each epic\n`;
    feedback += `3. **Update your JSON** with real file paths\n`;
    feedback += `4. **Verify** that EVERY epic has at least one file in filesToModify/filesToCreate/filesToRead\n\n`;
    feedback += `**Remember**: Without file paths, the system cannot detect overlapping work or prevent merge conflicts.\n`;

    return feedback;
  }

  /**
   * 🔥 SDK-COMPLIANT: Build intelligent feedback for overlap errors
   *
   * SDK Best Practice: "Visual feedback" and "Diagnostic questions"
   *
   * Analyzes overlap ratio and suggests the best strategy:
   * - >70% overlap → MERGE (combine into one epic)
   * - 30-70% overlap → SEQUENCE (add dependencies)
   * - <30% overlap → SPLIT (refactor code)
   */
  private buildOverlapFeedback(errorMessage: string, _epics: any[]): string {
    let feedback = `# 🚨 CRITICAL ERROR: EPIC OVERLAP DETECTED - MUST FIX IMMEDIATELY\n\n`;
    feedback += `⛔ YOUR PREVIOUS OUTPUT WAS REJECTED due to file conflicts.\n\n`;

    // 🔥 EXTRACT EXACT CONFLICTING FILES from error message
    const extractConflictDetails = (msg: string) => {
      const result = {
        newEpic: '',
        conflictingEpic: '',
        overlappingFiles: [] as string[],
        repository: ''
      };

      // Extract repository
      const repoMatch = msg.match(/Repository: ([^\n]+)/);
      if (repoMatch) result.repository = repoMatch[1];

      // Extract epic names
      const newEpicMatch = msg.match(/New Epic: "([^"]+)"/);
      if (newEpicMatch) result.newEpic = newEpicMatch[1];

      const conflictMatch = msg.match(/Conflicts with: "([^"]+)"/);
      if (conflictMatch) result.conflictingEpic = conflictMatch[1];

      // Extract overlapping files
      const filesMatch = msg.match(/Overlapping files \((\d+)\):\n([\s\S]*?)(?:\n\n|$)/);
      if (filesMatch) {
        const filesText = filesMatch[2];
        result.overlappingFiles = filesText.split('\n')
          .map(line => line.trim().replace(/^[-•]\s*/, ''))
          .filter(line => line.length > 0);
      }

      return result;
    };

    const conflict = extractConflictDetails(errorMessage);

    // 🔥 SHOW EXACT FILES FIRST - This is what the agent needs to see immediately
    if (conflict.overlappingFiles.length > 0) {
      feedback += `## ⚠️ EXACT FILES CAUSING THE CONFLICT\n\n`;
      feedback += `**Repository**: ${conflict.repository}\n`;
      feedback += `**Epic 1**: "${conflict.newEpic}"\n`;
      feedback += `**Epic 2**: "${conflict.conflictingEpic}"\n\n`;
      feedback += `**Overlapping Files** (${conflict.overlappingFiles.length}):\n`;
      conflict.overlappingFiles.forEach(file => {
        feedback += `- \`${file}\` ← THIS FILE is in BOTH epics\n`;
      });
      feedback += `\n`;
    } else {
      feedback += `${errorMessage}\n\n`;
    }

    feedback += `## 🎯 IMMEDIATE ACTION REQUIRED\n\n`;
    feedback += `You have 3 options to fix this:\n\n`;

    if (conflict.overlappingFiles.length > 0) {
      feedback += `### Option 1: REMOVE conflicting files from one epic\n`;
      feedback += `\`\`\`json\n`;
      feedback += `// Remove ${conflict.overlappingFiles[0]} from "${conflict.conflictingEpic}":\n`;
      feedback += `{\n`;
      feedback += `  "id": "epic-2",\n`;
      feedback += `  "title": "${conflict.conflictingEpic}",\n`;
      feedback += `  "filesToModify": [] // ← Remove overlapping files, OR work on different files\n`;
      feedback += `}\n`;
      feedback += `\`\`\`\n\n`;

      feedback += `### Option 2: MERGE both epics into ONE\n`;
      feedback += `\`\`\`json\n`;
      feedback += `{\n`;
      feedback += `  "id": "epic-unified",\n`;
      feedback += `  "title": "${conflict.newEpic} + ${conflict.conflictingEpic}",\n`;
      feedback += `  "filesToModify": ${JSON.stringify(conflict.overlappingFiles)}\n`;
      feedback += `}\n`;
      feedback += `\`\`\`\n\n`;

      feedback += `### Option 3: ADD DEPENDENCIES (sequential execution)\n`;
      feedback += `\`\`\`json\n`;
      feedback += `[\n`;
      feedback += `  {"id": "epic-1", "title": "${conflict.newEpic}", "filesToModify": ${JSON.stringify(conflict.overlappingFiles)}},\n`;
      feedback += `  {"id": "epic-2", "title": "${conflict.conflictingEpic}", "dependencies": ["epic-1"]}\n`;
      feedback += `]\n`;
      feedback += `\`\`\`\n\n`;
    } else {
      feedback += `1. **MERGE** the conflicting epics into ONE epic\n`;
      feedback += `2. **REMOVE** overlapping files from one epic\n`;
      feedback += `3. **ADD DEPENDENCIES** so epics execute sequentially\n\n`;
    }

    feedback += `## ⚠️ WARNING\n\n`;
    feedback += `- The system CANNOT proceed with overlapping epics\n`;
    feedback += `- Multiple developers editing the same file → merge conflicts\n`;
    feedback += `- This is your retry attempt. Fix the overlap or the task will FAIL.\n\n`;

    feedback += `## 🎯 WHAT YOU MUST DO NOW\n\n`;
    feedback += `1. **CHOOSE** one of the 3 options above\n`;
    feedback += `2. **MODIFY** your JSON output to eliminate the overlap\n`;
    feedback += `3. **VERIFY** that NO two epics share the same files\n`;
    feedback += `4. **OUTPUT** the corrected JSON immediately\n\n`;
    feedback += `⚠️  **CRITICAL**: This is an automated validation - there is no negotiation.\n`;
    feedback += `If overlapping epics appear again, the task will FAIL.\n`;

    return feedback;
  }

  /**
   * 🆕 SDK-COMPLIANT: Detect if epics share the same domain/subsystem
   *
   * SDK Best Practice: "Provide more creative tools"
   *
   * Analyzes epic titles to detect shared keywords, indicating they likely
   * modify the same files even if file paths weren't specified yet.
   *
   * Returns: Map of domain groups (domainKey -> epics[])
   */
  private detectSharedDomain(epics: any[]): Map<string, any[]> {
    const domainGroups = new Map<string, any[]>();

    // Group epics by repository first
    const epicsByRepo = new Map<string, any[]>();
    for (const epic of epics) {
      const repos = epic.affectedRepositories || [];
      for (const repo of repos) {
        if (!epicsByRepo.has(repo)) {
          epicsByRepo.set(repo, []);
        }
        epicsByRepo.get(repo)!.push(epic);
      }
    }

    // Analyze each repository's epics for domain overlap
    for (const [repo, repoEpics] of epicsByRepo.entries()) {
      if (repoEpics.length <= 1) continue; // Single epic, no conflict possible

      // Extract meaningful keywords from titles
      const extractKeywords = (title: string): string[] => {
        return title
          .toLowerCase()
          .split(/\s+/)
          .filter(word => word.length > 4) // Only meaningful words (>4 chars)
          .filter(word => !['enhanced', 'improved', 'better', 'system', 'feature'].includes(word));
      };

      // Check if epics share keywords (same domain)
      for (let i = 0; i < repoEpics.length; i++) {
        const epic1 = repoEpics[i];
        const keywords1 = extractKeywords(epic1.title);

        if (keywords1.length === 0) continue; // No keywords to compare

        for (let j = i + 1; j < repoEpics.length; j++) {
          const epic2 = repoEpics[j];
          const keywords2 = extractKeywords(epic2.title);

          if (keywords2.length === 0) continue;

          // Calculate keyword overlap ratio
          const commonKeywords = keywords1.filter(k => keywords2.includes(k));
          const overlapRatio = commonKeywords.length / Math.min(keywords1.length, keywords2.length);

          // If 50%+ keywords overlap, likely same domain
          if (overlapRatio >= 0.5 && commonKeywords.length > 0) {
            const domainKey = `${repo}:${commonKeywords.join('-')}`;

            if (!domainGroups.has(domainKey)) {
              domainGroups.set(domainKey, []);
            }

            const group = domainGroups.get(domainKey)!;
            if (!group.includes(epic1)) group.push(epic1);
            if (!group.includes(epic2)) group.push(epic2);
          }
        }
      }
    }

    return domainGroups;
  }

  /**
   * 🔥 NEW: Detect if a new epic overlaps with existing epics in the same repository
   *
   * Returns the conflicting epic if overlap detected, null otherwise
   */
  private detectEpicOverlap(
    _newEpic: any,
    existingEpics: any[],
    newEpicFiles: string[]
  ): { title: string; epicId: string; overlappingFiles: string[] } | null {
    for (const existing of existingEpics) {
      const existingFiles = new Set([
        ...(existing.filesToModify || []),
        ...(existing.filesToCreate || []),
        // Note: filesToRead doesn't count as overlap (read-only)
      ]);

      const overlappingFiles: string[] = [];

      // Check if new epic modifies/creates files that existing epic already touches
      for (const file of newEpicFiles) {
        if (existingFiles.has(file)) {
          overlappingFiles.push(file);
        }
      }

      // If ANY file overlaps, epics conflict
      if (overlappingFiles.length > 0) {
        return {
          title: existing.title,
          epicId: existing.id,
          overlappingFiles,
        };
      }
    }

    return null; // No overlap
  }
}
