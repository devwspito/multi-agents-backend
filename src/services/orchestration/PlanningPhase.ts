import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { validateStoryOverlap, logOverlapValidation } from './utils/StoryOverlapValidator';
import { storageService } from '../storage/StorageService';
import { CodebaseDiscoveryService, CodebaseKnowledge } from '../CodebaseDiscoveryService';
import fs from 'fs';
import path from 'path';

/**
 * Planning Phase - Unified Planning (replaces ProblemAnalyst + ProductManager + ProjectManager)
 *
 * Uses `permissionMode: 'plan'` (read-only) for safe exploration.
 *
 * This phase combines:
 * 1. Deep problem analysis (from ProblemAnalyst)
 * 2. Epic creation with contracts (from ProductManager)
 * 3. Story breakdown with overlap detection (from ProjectManager)
 *
 * Benefits of unification:
 * - ONE exploration of the codebase (not 3x)
 * - No information loss between phases
 * - Proactive overlap detection (during planning, not after)
 * - Single coherent context for better quality output
 *
 * Output: Structured plan with epics and stories ready for TechLead
 */
export class PlanningPhase extends BasePhase {
  readonly name = 'Planning';
  readonly description = 'Unified planning: problem analysis, epic creation, and story breakdown';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Planning already completed (ONLY for recovery, NOT for continuations)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // CONTINUATION: Never skip - always re-execute with new context
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`\n[Planning] This is a CONTINUATION - will re-execute with additional requirements`);
      return false;
    }

    // RECOVERY: Skip if already completed
    if (context.task.orchestration.planning?.status === 'completed') {
      console.log(`[SKIP] Planning already completed - restoring context from previous execution`);

      // Restore phase data
      if (context.task.orchestration.planning.epics) {
        context.setData('epics', context.task.orchestration.planning.epics);
        context.setData('totalTeamsNeeded', context.task.orchestration.planning.epics.length);
      }
      if (context.task.orchestration.planning.analysis) {
        context.setData('problemAnalysis', context.task.orchestration.planning.analysis);
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
    const repositories = context.repositories;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`PLANNING PHASE - Unified Analysis & Epic Creation`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Task: ${task.title}`);
    console.log(`Repositories: ${repositories.map((r: any) => `${r.name} (${r.type})`).join(', ')}`);
    console.log(`Permission Mode: plan (read-only exploration)`);
    console.log(`${'='.repeat(80)}\n`);

    // Initialize phase state
    const startTime = new Date();
    if (!task.orchestration.planning) {
      task.orchestration.planning = {
        agent: 'planning-agent',
        status: 'pending',
      } as any;
    }

    // Initialize legacy fields for backward compatibility with TeamOrchestrationPhase
    if (!task.orchestration.productManager) {
      task.orchestration.productManager = {
        agent: 'planning-agent',
        status: 'pending',
      } as any;
    }
    if (!task.orchestration.projectManager) {
      task.orchestration.projectManager = {
        agent: 'planning-agent',
        status: 'pending',
      } as any;
    }
    if (!task.orchestration.techLead) {
      task.orchestration.techLead = {
        agent: 'tech-lead',
        status: 'pending',
      } as any;
    }

    task.orchestration.planning!.status = 'in_progress';
    task.orchestration.planning!.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Planning Agent');
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      'Planning Agent: Starting unified analysis (problem + epics + stories in ONE pass)...'
    );

    await LogService.agentStarted('planning-agent', taskId, {
      phase: 'planning',
      metadata: {
        taskTitle: task.title,
        repositoryCount: repositories.length,
        hasAttachments: task.attachments ? task.attachments.length > 0 : false,
      },
    });

    try {
      // CRITICAL: Validate repository types
      const repositoriesWithoutType = repositories.filter((r: any) => !r.type);
      if (repositoriesWithoutType.length > 0) {
        const repoNames = repositoriesWithoutType.map((r: any) => r.name || r.githubRepoName).join(', ');
        throw new Error(`CRITICAL: Repositories [${repoNames}] missing required 'type' field. Cannot proceed.`);
      }

      // Build repository info for prompt
      const repoInfo = repositories.map((repo: any, i: number) => {
        const typeEmoji = repo.type === 'backend' ? '' : repo.type === 'frontend' ? '' : '';
        return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}`;
      }).join('\n');

      // Previous context for continuations
      const previousOutput = task.orchestration.planning?.output;
      let previousContextSection = '';
      if (previousOutput) {
        previousContextSection = `
## Previous Planning Output (for context)
Your previous analysis is available for reference. Build upon it:
\`\`\`
${previousOutput.substring(0, 2000)}${previousOutput.length > 2000 ? '...(truncated)' : ''}
\`\`\`
`;
      }

      // Process attachments (Firebase Storage or legacy local files)
      const attachments: any[] = [];
      if (task.attachments && task.attachments.length > 0) {
        console.log(`Processing ${task.attachments.length} attachment(s)`);
        for (const attachmentPath of task.attachments) {
          try {
            let imageBuffer: Buffer | null = null;
            let filename: string;

            // Firebase Storage paths start with "uploads/" (no leading slash)
            if (attachmentPath.startsWith('uploads/') && storageService.isAvailable()) {
              // Download from Firebase Storage
              console.log(`  📥 Downloading from Firebase: ${attachmentPath}`);
              imageBuffer = await storageService.downloadBuffer(attachmentPath);
              filename = path.basename(attachmentPath);
            } else {
              // Legacy: try local filesystem
              let localPath: string;
              if (attachmentPath.startsWith('/uploads/')) {
                localPath = path.join(process.cwd(), attachmentPath);
              } else if (path.isAbsolute(attachmentPath)) {
                localPath = attachmentPath;
              } else {
                localPath = path.join(process.cwd(), attachmentPath);
              }

              if (fs.existsSync(localPath)) {
                imageBuffer = fs.readFileSync(localPath);
                filename = path.basename(localPath);
              } else {
                console.warn(`  ⚠️ File not found locally, skipping: ${attachmentPath}`);
                continue;
              }
            }

            if (imageBuffer) {
              const base64Image = imageBuffer.toString('base64');
              const ext = path.extname(filename).toLowerCase();
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
              console.log(`  ✅ Attached: ${filename}`);
            }
          } catch (error: any) {
            console.warn(`  ❌ Failed to process attachment: ${error.message}`);
          }
        }
        // Store for subsequent phases
        context.setData('attachments', attachments);
      }

      // 🔥 PROGRAMMATIC CODEBASE DISCOVERY (find helpers, patterns BEFORE agent runs)
      // This ensures we have RELIABLE knowledge about existing patterns
      console.log(`\n🔍 [PlanningPhase] Running programmatic codebase discovery...`);
      let codebaseKnowledge: CodebaseKnowledge | undefined;
      const effectiveWorkspacePath = workspacePath || process.cwd();
      try {
        codebaseKnowledge = await CodebaseDiscoveryService.discoverCodebase(effectiveWorkspacePath);
        // Store for subsequent phases (TechLead, Developer will use this)
        context.setData('codebaseKnowledge', codebaseKnowledge);
        console.log(`✅ [PlanningPhase] Discovered ${codebaseKnowledge.helperFunctions.length} helper functions, ${codebaseKnowledge.entityCreationRules.length} entity rules`);
      } catch (error: any) {
        console.warn(`⚠️ [PlanningPhase] Codebase discovery failed (will continue): ${error.message}`);
      }

      // Build the unified planning prompt (includes discovered patterns)
      const prompt = this.buildPlanningPrompt(task, repositories, repoInfo, previousContextSection, codebaseKnowledge);

      // Execute with bypassPermissions (like TechLead)
      // Note: 'plan' mode causes interactive behavior (asks questions)
      // We rely on the prompt to restrict the agent to read-only tools
      const result = await this.executeAgentFn(
        'planning-agent',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Planning Agent',
        undefined, // sessionId
        undefined, // fork
        attachments.length > 0 ? attachments : undefined,
        undefined, // options
        undefined, // contextOverride
        undefined, // skipOptimization
        'bypassPermissions' // Use bypassPermissions like TechLead - prompt restricts to read-only
      );

      console.log(`\nPlanning Agent completed. Parsing output...`);

      // Parse the structured output
      const parsed = this.parseOutput(result.output);

      if (!parsed.epics || parsed.epics.length === 0) {
        throw new Error('Planning Agent did not return valid epics. Cannot proceed.');
      }

      // Validate epics for overlaps
      const overlapResult = validateStoryOverlap(parsed.epics.map((e: any) => ({
        id: e.id,
        title: e.title,
        filesToModify: e.filesToModify || [],
        filesToCreate: e.filesToCreate || [],
        filesToRead: e.filesToRead || [],
      })));

      logOverlapValidation(overlapResult, taskId);

      if (!overlapResult.canRunInParallel) {
        console.warn(`\n[Planning] File overlaps detected - epics may need sequencing`);
        // Add dependencies for overlapping epics
        parsed.epics = this.addDependenciesForOverlaps(parsed.epics, overlapResult.conflicts);
      }

      // Enrich epics with repository info
      const enrichedEpics = this.enrichEpicsWithRepoInfo(parsed.epics, repositories);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`PLANNING COMPLETE`);
      console.log(`${'='.repeat(60)}`);
      console.log(`Total Epics: ${enrichedEpics.length}`);
      enrichedEpics.forEach((epic: any, i: number) => {
        const filesCount = (epic.filesToModify?.length || 0) + (epic.filesToCreate?.length || 0);
        console.log(`  ${i + 1}. ${epic.title} (${epic.targetRepository || 'unknown'}) - ${filesCount} files`);
      });
      console.log(`${'='.repeat(60)}\n`);

      // 🔥 CRITICAL: Re-fetch task from DB to avoid Mongoose version conflicts
      // During the agent execution (~2-3 min), WebSocket notifications may have updated the task
      const Task = require('../../models/Task').Task;
      const freshTask = await Task.findById(task._id);
      if (!freshTask) {
        throw new Error(`Task ${task._id} not found in database after agent execution`);
      }

      // Update fresh task with results
      freshTask.orchestration.planning = freshTask.orchestration.planning || {};
      freshTask.orchestration.planning.status = 'completed';
      freshTask.orchestration.planning.completedAt = new Date();
      freshTask.orchestration.planning.output = result.output;
      freshTask.orchestration.planning.epics = enrichedEpics;
      freshTask.orchestration.planning.analysis = parsed.analysis;

      // 🔥 MERGE: Combine agent's architectureBrief with programmatically discovered patterns
      // This ensures helperFunctions/entityCreationRules are ALWAYS present even if agent misses them
      const mergedArchitectureBrief = {
        ...parsed.architectureBrief,
        // Override with programmatic discovery (more reliable than agent discovery)
        ...(codebaseKnowledge ? CodebaseDiscoveryService.toArchitectureBriefFields(codebaseKnowledge) : {}),
      };
      freshTask.orchestration.planning.architectureBrief = mergedArchitectureBrief; // 🏗️ Architecture insights for TechLead/Developers
      freshTask.orchestration.planning.codebaseKnowledge = codebaseKnowledge; // 🔧 Raw programmatic discovery data
      freshTask.orchestration.planning.sessionId = result.sessionId;
      freshTask.orchestration.planning.usage = result.usage;
      freshTask.orchestration.planning.cost_usd = result.cost;

      // Update legacy fields for backward compatibility with TeamOrchestrationPhase
      freshTask.orchestration.productManager = freshTask.orchestration.productManager || {};
      freshTask.orchestration.productManager.status = 'completed';
      freshTask.orchestration.productManager.completedAt = new Date();
      freshTask.orchestration.productManager.output = result.output;

      freshTask.orchestration.projectManager = freshTask.orchestration.projectManager || {};
      freshTask.orchestration.projectManager.status = 'completed';
      freshTask.orchestration.projectManager.completedAt = new Date();
      freshTask.orchestration.projectManager.epics = enrichedEpics;
      freshTask.orchestration.projectManager.stories = enrichedEpics.flatMap((e: any) => e.stories || []);

      // NOTE: TechLead is NOT marked as completed here!
      // TechLead must still run to:
      // 1. Break epics into stories (with file paths)
      // 2. Define teamComposition (number of developers)
      // 3. Assign stories to developers (storyAssignments)
      // PlanningPhase only creates EPICS, TechLead creates STORIES from epics

      // Update costs
      freshTask.orchestration.totalCost = (freshTask.orchestration.totalCost || 0) + (result.cost || 0);
      freshTask.orchestration.totalTokens = (freshTask.orchestration.totalTokens || 0) +
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await freshTask.save();

      // Update context.task reference to fresh task
      context.task = freshTask;

      // Store in context for next phases
      context.setData('epics', enrichedEpics);
      context.setData('totalTeamsNeeded', enrichedEpics.length);
      context.setData('problemAnalysis', parsed.analysis);
      context.setData('architectureBrief', parsed.architectureBrief); // 🏗️ For TechLead and Developers
      context.setData('planningOutput', result.output);

      // Emit to console viewer
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\nPLANNING AGENT - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      NotificationService.emitAgentCompleted(taskId, 'Planning Agent', `Created ${enrichedEpics.length} epic(s)`);

      await LogService.agentCompleted('planning-agent', taskId, {
        phase: 'planning',
        metadata: {
          epicCount: enrichedEpics.length,
          cost: result.cost,
        },
      });

      // Event sourcing
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'PlanningCompleted',
        agentName: 'planning-agent',
        payload: {
          epicCount: enrichedEpics.length,
          epics: enrichedEpics.map((e: any) => ({ id: e.id, title: e.title, repository: e.targetRepository })),
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      return {
        success: true,
        data: {
          epics: enrichedEpics,
          analysis: parsed.analysis,
          architectureBrief: parsed.architectureBrief, // 🏗️ Architecture insights
          output: result.output,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      };

    } catch (error: any) {
      console.error(`\n[Planning] FAILED: ${error.message}`);

      task.orchestration.planning!.status = 'failed';
      task.orchestration.planning!.completedAt = new Date();
      task.orchestration.planning!.error = error.message;
      await task.save();

      NotificationService.emitAgentFailed(taskId, 'Planning Agent', error.message);

      await LogService.agentFailed('planning-agent', taskId, error, {
        phase: 'planning',
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Build the unified planning prompt
   * Format matches ProjectManagerPhase output for compatibility with TeamOrchestrationPhase
   */
  private buildPlanningPrompt(
    task: any,
    repositories: any[],
    repoInfo: string,
    previousContextSection: string,
    codebaseKnowledge?: CodebaseKnowledge
  ): string {
    const projectId = task.projectId?.toString() || '';
    const taskId = task._id?.toString() || '';

    // 🔥 DISCOVERED PATTERNS SECTION (from programmatic discovery)
    const discoveredPatternsSection = codebaseKnowledge
      ? CodebaseDiscoveryService.formatForPrompt(codebaseKnowledge)
      : '';

    const memoryContext = `
## 🧠 MEMORY CONTEXT (Use these IDs for memory tools)
- **Project ID**: \`${projectId}\`
- **Task ID**: \`${taskId}\`

Use these when calling \`recall()\` and \`remember()\` tools to leverage past learnings.
`;

    // Build repository assignment guidance
    const repoGuidance = repositories.length > 0 ? `
## 🔥 CRITICAL: Multi-Repo Epic Assignment Rules

**YOU MUST ASSIGN THE CORRECT REPOSITORY TO EACH EPIC BASED ON THE WORK TYPE**:

### 🔧 BACKEND EPICS → BACKEND REPOSITORIES
**Assign to BACKEND if the epic involves**:
- ✅ REST APIs, GraphQL endpoints, WebSocket servers
- ✅ Database models, schemas, migrations, queries
- ✅ Business logic, services, controllers
- ✅ Authentication, authorization, middleware
- ✅ Server-side validation, data processing

### 🎨 FRONTEND EPICS → FRONTEND REPOSITORIES
**Assign to FRONTEND if the epic involves**:
- ✅ UI components, views, pages, layouts
- ✅ Client-side state management (Redux, Context)
- ✅ Forms, user input, client-side validation
- ✅ Styling, CSS, animations, responsive design
- ✅ Client-side data fetching, caching

### 🚫 COMMON MISTAKES TO AVOID:
- ❌ Assigning API routes to frontend → WRONG (APIs = backend)
- ❌ Assigning React components to backend → WRONG (UI = frontend)
- ❌ Assigning ALL epics to the same repo → WRONG (analyze each epic)
- ❌ Using repository names that don't exist → WRONG (use EXACT names from list above)
` : '';

    return `# 🛑🛑🛑 STOP! READ THIS FIRST - MANDATORY RULES 🛑🛑🛑
${memoryContext}
## ⛔ FORBIDDEN BEHAVIORS - SYSTEM WILL CRASH IF YOU DO THESE:

1. **NEVER ASK QUESTIONS** - Not even one. Not "clarification questions". Not "before I proceed". NOTHING.
2. **NEVER OUTPUT TEXT BEFORE JSON** - Your FINAL output must START with {
3. **NEVER OUTPUT TEXT AFTER JSON** - Your FINAL output must END with }
4. **NEVER USE MARKDOWN** - No \`\`\`json blocks. No formatting. PURE JSON only.

❌ THIS WILL CRASH THE SYSTEM:
"Tengo algunas preguntas..."
"Before I proceed, I need to know..."
"Let me clarify a few things..."
"Here are my questions..."
\`\`\`json
{"epics": ...}
\`\`\`

✅ THIS IS CORRECT (your ENTIRE final output):
{"analysis":{...},"epics":[...],"assumptions":["I chose X because Y"]}

## 🤖 YOU ARE FULLY AUTONOMOUS

When requirements are unclear:
- MAKE THE BEST DECISION using industry best practices
- DOCUMENT your decision in the "assumptions" array
- PROCEED with implementation - NEVER stop to ask

Example: If unsure between Option A and Option B:
- ❌ WRONG: "Should I use Option A or B?"
- ✅ CORRECT: Choose the most robust option, add to assumptions: "Chose Option A because it's more scalable"

---

# UNIFIED PLANNING AGENT

You combine problem analysis and epic creation in ONE pass.
Your output feeds into TechLead (who will break epics into stories).

## TASK
**Title**: ${task.title}
**Description**: ${task.description || 'No description provided'}
**Priority**: ${task.priority}
${task.attachments?.length > 0 ? `**Attachments**: ${task.attachments.length} image(s) - analyze for requirements` : ''}

## REPOSITORIES
${repoInfo}
${repoGuidance}
${previousContextSection}
${discoveredPatternsSection}

## WORKFLOW

### Phase 1: DEEP ARCHITECTURE ANALYSIS (CRITICAL - 5-7 min)

**This is the MOST IMPORTANT phase. Poor architecture understanding = rejected PRs.**

#### 1.1 Analyze Recent Merged PRs (MANDATORY)
Run these commands to learn what the team accepts:
\`\`\`bash
# List last 10 merged PRs with details
gh pr list --state merged --limit 10 --json number,title,files,additions,deletions

# For each PR, see what files were changed and patterns used
gh pr view <number> --json files,commits
\`\`\`

**Learn from PRs**:
- What file naming conventions are used?
- How are tests structured?
- What code review comments were made?
- What patterns are consistently used?

#### 1.2 Analyze Data Models & Relationships
Find and understand ALL models:
\`\`\`bash
# Find all model definitions
Glob("**/models/**/*.ts", "**/entities/**/*.ts", "**/schema/**/*.ts")

# Find database relationships
Grep("references|belongsTo|hasMany|@ManyToOne|@OneToMany|Schema.Types.ObjectId")
\`\`\`

**Document**:
- Entity relationships (who references who)
- Required fields and validations
- Indexes and constraints

#### 1.3 Analyze Code Patterns & Conventions
\`\`\`bash
# Find existing patterns for similar features
Glob("**/controllers/**/*.ts", "**/services/**/*.ts", "**/routes/**/*.ts")

# Check for linting/formatting config
Read(".eslintrc*", ".prettierrc*", "tsconfig.json")
\`\`\`

**Document**:
- Naming conventions (camelCase, kebab-case, etc.)
- File organization patterns
- Error handling patterns
- Logging patterns
- Testing patterns

#### 1.4 Analyze API Patterns (if applicable)
\`\`\`bash
# Find existing API routes
Grep("router.get|router.post|app.get|@Get|@Post")

# Find middleware patterns
Grep("middleware|authenticate|authorize|validate")
\`\`\`

### Phase 2: Problem Analysis
Consider:
- What is the REAL problem?
- Success criteria
- Risks and edge cases
- Technical constraints
- **How does this fit with EXISTING architecture?**

### Phase 3: Create Epics (Following Existing Patterns)
For EACH epic:
- Concrete file paths (from your exploration)
- Clear scope
- Repository assignment (backend/frontend)
- Dependencies between epics
- **Follow naming conventions found in Phase 1**
- **Match testing patterns found in PRs**

## 🎯 REQUIRED EPIC FIELDS (TeamOrchestration WILL FAIL without these!)

Each epic MUST have:
- **targetRepository** (string): EXACT repository name from the list above (e.g., "${repositories[0]?.name || 'backend'}")
- **filesToModify** OR **filesToCreate**: At least ONE file path array MUST be non-empty
- **id**: Unique epic identifier
- **title**: Epic title
- **executionOrder**: 1 for backend/core, 2 for frontend/dependent

## CRITICAL RULES

1. **REAL FILE PATHS ONLY**: Use paths you found during exploration
2. **NO OVERLAPS**: Each file should only be in ONE epic
3. **REPOSITORY MATCH**: Backend work -> backend repo, Frontend work -> frontend repo
4. **DEPENDENCIES**: If epics share files, make one depend on the other

## YOUR FINAL OUTPUT (ONLY JSON, NOTHING ELSE)

After exploring the codebase, output EXACTLY this structure (no text before or after):

{"architectureBrief":{"codePatterns":{"namingConvention":"camelCase for variables, PascalCase for classes","fileStructure":"src/routes/, src/services/, src/models/","errorHandling":"Try-catch with LogService.error()","testing":"Jest with *.test.ts naming"},"dataModels":[{"name":"User","file":"src/models/User.ts","relationships":["has many Tasks","belongs to Organization"]},{"name":"Task","file":"src/models/Task.ts","relationships":["belongs to User","has one Orchestration"]}],"prInsights":{"recentPRs":3,"commonPatterns":["All PRs include tests","Use async/await consistently","Error messages are descriptive"],"rejectionReasons":["Missing tests","Breaking changes without migration"]},"helperFunctions":[{"name":"createProject","file":"src/utils/projectHelpers.ts","usage":"Use createProject() instead of new Project()","antiPattern":"new Project() misses required agent/team relationships"}],"entityCreationRules":[{"entity":"Project","mustUse":"createProject() from projectHelpers.ts","mustNotUse":"new Project() - missing relationships","requiredRelationships":["agents","teams","defaultTeam"]}],"conventions":["Use TypeScript strict mode","No any types","Document public APIs with JSDoc"]},"analysis":{"problemStatement":"Clear problem description","successCriteria":["criterion 1"],"risks":["risk 1"],"technicalApproach":"Solution approach following existing patterns"},"epics":[{"id":"epic-backend-api","title":"Create API Endpoints","description":"REST API for CRUD operations","targetRepository":"${repositories[0]?.name || 'backend'}","affectedRepositories":["${repositories[0]?.name || 'backend'}"],"filesToModify":["src/routes/index.ts"],"filesToCreate":["src/controllers/NewController.ts"],"filesToRead":["src/config/database.ts"],"estimatedComplexity":"moderate","dependencies":[],"executionOrder":1,"followsPatterns":["Uses existing route structure","Error handling matches LogService pattern"]},{"id":"epic-frontend-ui","title":"User Interface","description":"React components for the feature","targetRepository":"${repositories[1]?.name || repositories[0]?.name || 'frontend'}","affectedRepositories":["${repositories[1]?.name || repositories[0]?.name || 'frontend'}"],"filesToModify":["src/App.tsx"],"filesToCreate":["src/components/NewComponent.tsx"],"filesToRead":["src/api/client.ts"],"estimatedComplexity":"simple","dependencies":["epic-backend-api"],"executionOrder":2,"followsPatterns":["Component naming matches existing","Uses existing API client pattern"]}],"totalTeamsNeeded":2,"dependencies":{"cross_repo":["backend API must exist before frontend"],"external":[],"sequential":["epic-2 depends on epic-1"]},"risks":["Risk 1"],"outOfScope":["Out of scope item"],"assumptions":["Assumption 1 - I decided X because Y","Assumption 2 - Chose approach Z for scalability"]}

🛑 REMINDER: FIRST do DEEP ARCHITECTURE ANALYSIS (PRs, models, patterns), THEN output ONLY the JSON. NO questions. NO text. JUST JSON.`;
  }

  /**
   * Parse the agent output to extract structured data
   * Uses multiple extraction patterns (similar to TechLeadPhase)
   */
  private parseOutput(output: string): { epics: any[]; analysis: any; architectureBrief: any } {
    let parsed: any = { epics: [], analysis: null, architectureBrief: null };

    console.log(`\n🔍 [Planning] Parsing agent output (${output.length} chars)...`);

    // STEP 1: Try parsing as pure JSON first (if agent returns only JSON)
    try {
      const trimmed = output.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        parsed = JSON.parse(trimmed);
        if (parsed.epics && Array.isArray(parsed.epics)) {
          console.log('✅ [Planning] Parsed as pure JSON');
          if (parsed.architectureBrief) {
            console.log('✅ [Planning] Found architectureBrief with insights from existing code patterns');
          }
          return {
            epics: parsed.epics,
            analysis: parsed.analysis || null,
            architectureBrief: parsed.architectureBrief || null
          };
        }
      }
    } catch (e) {
      // Not pure JSON, continue
    }

    // STEP 2: Try multiple markdown patterns (most specific to least specific)
    const patterns = [
      /```json\s*\n([\s\S]*?)\n```/,       // ```json\n{...}\n``` (strict)
      /```json\s*\n([\s\S]*?)```/,         // ```json\n{...}``` (newline after json)
      /```json\s*([\s\S]*?)```/,           // ```json{...}``` (no newlines)
      /```\s*\n([\s\S]*?)\n```/,           // ```\n{...}\n``` (no json keyword)
      /```\s*([\s\S]*?)```/                // ``` {...} ``` (minimal)
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        try {
          const jsonText = match[1] || match[0];
          const trimmed = jsonText.trim();
          parsed = JSON.parse(trimmed);

          if (parsed.epics && Array.isArray(parsed.epics)) {
            console.log(`✅ [Planning] Parsed JSON using pattern: ${pattern.toString().substring(0, 40)}...`);
            return { epics: parsed.epics, analysis: parsed.analysis || null, architectureBrief: parsed.architectureBrief || null };
          } else {
            console.log(`⚠️  [Planning] Parsed JSON but missing epics array`);
            parsed = { epics: [], analysis: null, architectureBrief: null };
          }
        } catch (e) {
          console.log(`⚠️  [Planning] Failed pattern: ${pattern.toString().substring(0, 40)}...`);
        }
      }
    }

    // STEP 3: Final fallback - find the longest valid JSON object with "epics" key
    console.log('⚠️  [Planning] Standard patterns failed, trying fallback extraction...');

    const candidates: Array<{text: string, length: number}> = [];

    for (let i = 0; i < output.length; i++) {
      if (output[i] === '{') {
        let braceCount = 0;
        let j = i;
        let startFound = false;

        while (j < output.length) {
          if (output[j] === '{') {
            braceCount++;
            startFound = true;
          } else if (output[j] === '}') {
            braceCount--;
            if (startFound && braceCount === 0) {
              const candidate = output.substring(i, j + 1);
              if (candidate.includes('"epics"')) {
                candidates.push({ text: candidate, length: candidate.length });
              }
              break;
            }
          }
          j++;
        }
      }
    }

    // Sort by length (longest first) and try to parse
    candidates.sort((a, b) => b.length - a.length);

    for (const candidate of candidates) {
      try {
        const candidateParsed = JSON.parse(candidate.text);
        if (candidateParsed.epics && Array.isArray(candidateParsed.epics) && candidateParsed.epics.length > 0) {
          console.log(`✅ [Planning] Parsed JSON using fallback extraction (${candidate.length} chars)`);
          return { epics: candidateParsed.epics, analysis: candidateParsed.analysis || null, architectureBrief: candidateParsed.architectureBrief || null };
        }
      } catch (e) {
        // Not valid JSON, continue
      }
    }

    // STEP 4: Failed - log output for debugging
    console.error('❌ [Planning] All JSON extraction patterns failed');
    console.error('📋 [Planning] Agent output preview (first 2000 chars):');
    console.error(output.substring(0, 2000));
    if (output.length > 2000) {
      console.error(`... (${output.length - 2000} more chars)`);
    }

    return {
      epics: [],
      analysis: null,
      architectureBrief: null,
    };
  }

  /**
   * Add dependencies for overlapping epics and FORCE sequential execution
   *
   * CRITICAL: When epics have file overlaps, we MUST:
   * 1. Add dependency relationship
   * 2. Update executionOrder to ensure sequential execution
   *
   * Without updating executionOrder, epics with same order run in parallel
   * even if they have dependencies (dependencies are for informational purposes).
   */
  private addDependenciesForOverlaps(
    epics: any[],
    conflicts: Array<{ file: string; stories: string[] }>
  ): any[] {
    // Create a map of epic dependencies based on file conflicts
    const dependencyMap = new Map<string, Set<string>>();

    for (const conflict of conflicts) {
      const [firstEpic, ...laterEpics] = conflict.stories;
      for (const laterEpic of laterEpics) {
        if (!dependencyMap.has(laterEpic)) {
          dependencyMap.set(laterEpic, new Set());
        }
        dependencyMap.get(laterEpic)!.add(firstEpic);
      }
    }

    // Add dependencies AND update executionOrder to force sequential execution
    return epics.map(epic => {
      const deps = dependencyMap.get(epic.id);
      if (deps && deps.size > 0) {
        // 🔥 CRITICAL: Calculate the max executionOrder of dependencies
        // and set this epic's order to be AFTER all its dependencies
        const maxDependencyOrder = Math.max(
          ...Array.from(deps).map(depId => {
            const depEpic = epics.find(e => e.id === depId);
            return depEpic?.executionOrder || 1;
          })
        );

        const newExecutionOrder = maxDependencyOrder + 1;

        console.log(`⚠️  [Planning] Epic "${epic.id}" has file overlaps with dependencies.`);
        console.log(`   Dependencies: ${Array.from(deps).join(', ')}`);
        console.log(`   Forcing executionOrder: ${epic.executionOrder || 1} → ${newExecutionOrder}`);

        return {
          ...epic,
          dependencies: [...(epic.dependencies || []), ...Array.from(deps)],
          executionOrder: newExecutionOrder,
        };
      }
      return epic;
    });
  }

  /**
   * Enrich epics with repository information
   *
   * Priority order for targetRepository:
   * 1. epic.targetRepository (if agent provided it and it matches a known repo)
   * 2. epic.affectedRepositories[0] (if matches a known repo)
   * 3. Infer from file paths (backend keywords → backend repo, frontend keywords → frontend repo)
   * 4. Default to first repository
   */
  private enrichEpicsWithRepoInfo(epics: any[], repositories: any[]): any[] {
    return epics.map((epic, index) => {
      let targetRepo: any = null;

      // PRIORITY 1: Use targetRepository if agent already provided it
      if (epic.targetRepository) {
        targetRepo = repositories.find(r =>
          r.name === epic.targetRepository ||
          r.githubRepoName === epic.targetRepository
        );
        if (targetRepo) {
          console.log(`   ✅ Epic ${epic.id}: Using agent-provided targetRepository: ${targetRepo.name}`);
        }
      }

      // PRIORITY 2: Use affectedRepositories[0] if targetRepository not found
      if (!targetRepo && epic.affectedRepositories?.length > 0) {
        const affectedName = epic.affectedRepositories[0];
        targetRepo = repositories.find(r =>
          r.name === affectedName ||
          r.githubRepoName === affectedName
        );
        if (targetRepo) {
          console.log(`   ✅ Epic ${epic.id}: Using affectedRepositories[0]: ${targetRepo.name}`);
        }
      }

      // PRIORITY 3: Infer from file paths
      if (!targetRepo) {
        const allFiles = [...(epic.filesToModify || []), ...(epic.filesToCreate || [])];
        if (allFiles.length > 0) {
          const firstFile = allFiles[0].toLowerCase();
          if (firstFile.includes('backend') || firstFile.includes('api') || firstFile.includes('server') ||
              firstFile.includes('routes') || firstFile.includes('controllers') || firstFile.includes('models')) {
            targetRepo = repositories.find(r => r.type === 'backend');
          } else if (firstFile.includes('frontend') || firstFile.includes('components') ||
                     firstFile.includes('pages') || firstFile.includes('views') || firstFile.includes('.tsx') ||
                     firstFile.includes('.jsx') || firstFile.includes('src/app')) {
            targetRepo = repositories.find(r => r.type === 'frontend');
          }
          if (targetRepo) {
            console.log(`   ⚠️  Epic ${epic.id}: Inferred from file paths: ${targetRepo.name} (${targetRepo.type})`);
          }
        }
      }

      // PRIORITY 4: Default to first repository
      if (!targetRepo) {
        targetRepo = repositories[0];
        console.log(`   ⚠️  Epic ${epic.id}: Defaulting to first repository: ${targetRepo?.name}`);
      }

      // Preserve agent's executionOrder if provided, otherwise use index + 1
      const executionOrder = epic.executionOrder || (index + 1);

      return {
        ...epic,
        targetRepository: targetRepo?.name || epic.targetRepository,
        affectedRepositories: epic.affectedRepositories || [targetRepo?.name || epic.targetRepository],
        executionOrder,
        repoType: targetRepo?.type,
      };
    });
  }
}
