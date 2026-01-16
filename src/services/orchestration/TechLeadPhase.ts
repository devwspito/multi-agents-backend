import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { AgentActivityService } from '../AgentActivityService';
import { hasMarker, extractMarkerValue } from './utils/MarkerValidator';
import { RealisticCostEstimator } from '../RealisticCostEstimator';
import { CryptoService } from '../CryptoService';
import { ProjectRadiographyService, ProjectRadiography } from '../ProjectRadiographyService';
import { JudgePhase } from './JudgePhase';
import { sessionCheckpointService } from '../SessionCheckpointService';
import { granularMemoryService } from '../GranularMemoryService';

/**
 * Tech Lead Phase
 *
 * Designs technical architecture and builds development team
 * - Breaks down epics into implementable stories
 * - Creates technical architecture design
 * - Decides team composition (number of developers)
 * - Assigns stories to team members
 */
export class TechLeadPhase extends BasePhase {
  readonly name = 'TechLead'; // Must match PHASE_ORDER
  readonly description = 'Designing architecture and building development team';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if Tech Lead already completed
   *
   * 🔥 CRITICAL: In multi-team mode, each team has its OWN epic!
   * We must check if TechLead was completed for THIS SPECIFIC EPIC,
   * not globally for any epic.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // 🔥 CRITICAL FIX: Detect multi-team mode FIRST
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    if (multiTeamMode) {
      console.log(`\n🎯 [TechLead.shouldSkip] Multi-team mode detected - Epic: ${teamEpic.id}`);
    }

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
      console.log(`🔄 [TechLead] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    // 🔥 CRITICAL FIX: In multi-team mode, techLead.status is GLOBAL, not per-epic!
    // We need to check EventStore for TechLeadCompleted event WITH THIS EPIC's ID
    if (context.task.orchestration.techLead?.status === 'completed') {
      if (multiTeamMode) {
        // In multi-team mode, check if TechLead was completed FOR THIS SPECIFIC EPIC
        console.log(`   ⚠️ Global techLead.status is 'completed', but checking if this specific epic (${teamEpic.id}) was completed...`);

        try {
          const { eventStore } = await import('../EventStore');
          const events = await eventStore.getEvents(context.task._id as any);
          const techLeadForThisEpic = events.find((e: any) =>
            e.eventType === 'TechLeadCompleted' &&
            !e.payload?.failed &&
            e.payload?.epicId === teamEpic.id
          );

          if (!techLeadForThisEpic) {
            console.log(`   ✅ No TechLeadCompleted event found for epic ${teamEpic.id} - will execute TechLead`);
            return false; // DO NOT SKIP - this epic hasn't had TechLead run yet
          }

          console.log(`   ✅ Found TechLeadCompleted for epic ${teamEpic.id} - will skip`);
        } catch (error: any) {
          console.log(`   ⚠️ Error checking EventStore: ${error.message} - will NOT skip to be safe`);
          return false;
        }
      }

      console.log(`[SKIP] Tech Lead already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution for next phases
      await this.restoreTechLeadData(context);

      return true;
    }

    // 🔥 SMART RECOVERY: If techLead was in_progress but has valid output + storyAssignments,
    // the agent finished but status wasn't saved before crash. Use the existing output.
    // 🔥 CRITICAL: In multi-team mode, techLead is GLOBAL - skip this check for subsequent teams
    const techLead = context.task.orchestration.techLead;
    if (!multiTeamMode && techLead?.status === 'in_progress' && techLead.storyAssignments && techLead.storyAssignments.length > 0 && techLead.output) {
      console.log(`\n🔄🔄🔄 [SMART RECOVERY] TechLead was in_progress but has ${techLead.storyAssignments.length} story assignment(s) + output`);
      console.log(`   → Using existing output instead of re-executing (saves ~5 min + $$)`);
      console.log(`   → Story assignments found: ${techLead.storyAssignments.map((a: any) => `${a.storyId} → ${a.assignedTo}`).join(', ')}`);

      // Mark as completed since we have valid output
      const Task = require('../../models/Task').Task;
      await Task.findByIdAndUpdate(context.task._id, {
        $set: {
          'orchestration.techLead.status': 'completed',
          'orchestration.techLead.completedAt': new Date(),
        }
      });

      // Restore phase data for next phases
      await this.restoreTechLeadData(context);

      NotificationService.emitConsoleLog(
        (context.task._id as any).toString(),
        'info',
        `🔄 SMART RECOVERY: TechLead already finished (${techLead.storyAssignments.length} story assignments) - skipping re-execution`
      );

      return true; // Skip re-execution
    }

    // 🔥 SMART RECOVERY: Check EventStore for TechLeadCompleted event (even if DB not updated)
    // 🔥 CRITICAL FIX: In multi-team mode, filter by epicId!
    try {
      const { eventStore } = await import('../EventStore');
      const events = await eventStore.getEvents(context.task._id as any);

      // 🔥 CRITICAL: In multi-team mode, only match events for THIS epic
      const techLeadCompletedEvent = multiTeamMode
        ? events.find((e: any) =>
            e.eventType === 'TechLeadCompleted' &&
            !e.payload?.failed &&
            e.payload?.epicId === teamEpic?.id
          )
        : events.find((e: any) => e.eventType === 'TechLeadCompleted' && !e.payload?.failed);

      if (techLeadCompletedEvent && techLeadCompletedEvent.payload?.epicsCount > 0) {
        const epicInfo = multiTeamMode ? ` (epic: ${teamEpic?.id})` : '';
        console.log(`\n🔄🔄🔄 [SMART RECOVERY] Found TechLeadCompleted event in EventStore${epicInfo}!`);
        console.log(`   → Epics: ${techLeadCompletedEvent.payload.epicsCount}, Stories: ${techLeadCompletedEvent.payload.storiesCount}`);
        console.log(`   → DB status: ${techLead?.status || 'not set'} - updating to completed`);

        // Mark as completed in DB
        const Task = require('../../models/Task').Task;
        await Task.findByIdAndUpdate(context.task._id, {
          $set: {
            'orchestration.techLead.status': 'completed',
            'orchestration.techLead.completedAt': new Date(),
          }
        });

        // Restore from events
        const epicEvents = events.filter((e: any) => e.eventType === 'EpicCreated');
        const storyEvents = events.filter((e: any) => e.eventType === 'StoryCreated');
        const teamEvent = events.find((e: any) => e.eventType === 'TeamCompositionDefined');

        if (epicEvents.length > 0) {
          const epics = epicEvents.map((e: any) => e.payload);
          context.setData('epics', epics);
          console.log(`   → Restored ${epics.length} epics from EventStore`);
        }

        if (storyEvents.length > 0) {
          const storiesMap: { [id: string]: any } = {};
          storyEvents.forEach((e: any) => {
            storiesMap[e.payload.id] = e.payload;
          });
          context.setData('storiesMap', storiesMap);

          // Build storyAssignments from story events
          const storyAssignments = storyEvents
            .filter(e => e.payload.assignedTo)
            .map(e => ({ storyId: e.payload.id, assignedTo: e.payload.assignedTo }));
          context.setData('storyAssignments', storyAssignments);
          console.log(`   → Restored ${Object.keys(storiesMap).length} stories, ${storyAssignments.length} assignments from EventStore`);
        }

        if (teamEvent) {
          context.setData('teamComposition', teamEvent.payload);
          console.log(`   → Restored teamComposition: ${teamEvent.payload.developers} developers`);
        }

        if (techLead?.output) {
          context.setData('techLeadOutput', techLead.output);
        }

        NotificationService.emitConsoleLog(
          (context.task._id as any).toString(),
          'info',
          `🔄 SMART RECOVERY: Restored TechLead from EventStore - ${epicEvents.length} epics, ${storyEvents.length} stories`
        );

        return true; // Skip re-execution
      }
    } catch (error: any) {
      console.log(`   ⚠️ EventStore recovery check failed: ${error.message}`);
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

    // 🔥 MULTI-TEAM MODE: Check if we're in team mode BEFORE updating task
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    // Update task status
    const startTime = new Date();
    if (!multiTeamMode) {
      // Single-team mode: update in-memory and save
      if (!task.orchestration.techLead) {
        task.orchestration.techLead = { agent: 'tech-lead', status: 'pending' } as any;
      }
      task.orchestration.techLead.status = 'in_progress';
      task.orchestration.techLead.startedAt = startTime;
      await task.save();
    } else {
      // 🔥 MULTI-TEAM: Use atomic $set to initialize techLead without version conflicts
      // This ensures the field exists for approval endpoint
      const Task = require('../../models/Task').Task;
      await Task.findByIdAndUpdate(task._id, {
        $set: {
          'orchestration.techLead.agent': 'tech-lead',
          'orchestration.techLead.status': 'in_progress',
          'orchestration.techLead.startedAt': startTime,
        },
      });
      console.log(`📝 [TechLead] Initialized orchestration.techLead atomically for multi-team mode`);
    }

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Tech Lead');

    // 🎯 ACTIVITY: Emit phase start for Activity tab
    const agentLabel = multiTeamMode ? `Tech Lead (Epic: ${teamEpic?.id || 'unknown'})` : 'Tech Lead';
    AgentActivityService.emitMessage(
      taskId,
      agentLabel,
      `🏗️ Starting architecture design${multiTeamMode ? ` for epic: ${teamEpic?.title}` : ''}...`
    );

    await LogService.agentStarted('tech-lead', taskId, {
      phase: 'architecture',
    });

    // 🔄 RETRY LOGIC: TechLead gets up to 3 attempts when violating rules
    const MAX_RETRIES = 3;
    let retryCount = 0;
    let lastError: any = null;

    while (retryCount < MAX_RETRIES) {
    try {
      if (retryCount > 0) {
        console.log(`\n🔄🔄🔄 [TechLead] RETRY ${retryCount}/${MAX_RETRIES - 1} - Fixing rule violations 🔄🔄🔄`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `🔄 TechLead Retry ${retryCount}/${MAX_RETRIES - 1}: ${lastError?.violationType || 'Rule violation'}`
        );
      }

      // Get epic branch if in multi-team mode
      const epicBranch = context.getData<string>('epicBranch');

      if (multiTeamMode) {
        // 🔥 CRITICAL: teamEpic MUST have targetRepository - NO FALLBACKS
        if (!teamEpic.targetRepository) {
          console.error(`\n❌❌❌ [TechLead] CRITICAL ERROR: Team Epic has NO targetRepository!`);
          console.error(`   Epic: ${teamEpic.title}`);
          console.error(`   Epic ID: ${teamEpic.id}`);
          console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THIS EPIC BELONGS TO`);
          console.error(`   💀 CANNOT EXECUTE TECHLEAD - WOULD BE ARBITRARY`);
          console.error(`\n   🛑 STOPPING PIPELINE - HUMAN INTERVENTION REQUIRED`);
          throw new Error(`HUMAN_REQUIRED: Team Epic ${teamEpic.id} has no targetRepository`);
        }

        // 🔥 NORMALIZE: Remove .git suffix if present (defensive coding)
        const { normalizeRepoName } = require('../../utils/safeGitExecution');
        const targetRepo = normalizeRepoName(teamEpic.targetRepository);
        const repoObj = context.repositories.find(r =>
          r.name === targetRepo || r.githubRepoName === targetRepo || r.full_name === targetRepo
        );

        console.log(`\n🎯 [TechLead] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
        console.log(`   Epic: ${teamEpic.title}`);
        console.log(`   Branch: ${epicBranch}`);

        // 🔥 CRITICAL: Validate repository and type
        if (!repoObj) {
          console.error(`   ❌ ERROR: Repository ${targetRepo} NOT FOUND in context`);
          console.error(`   Available repos: ${context.repositories.map(r => r.name || r.githubRepoName).join(', ')}`);
          throw new Error(`Repository ${targetRepo} not found in context.repositories`);
        }

        if (!repoObj.type) {
          console.error(`   ❌ ERROR: Repository ${targetRepo} has NO TYPE in database`);
          console.error(`   Please set 'type' field in MongoDB: 'backend', 'frontend', 'mobile', or 'shared'`);
          throw new Error(`Repository ${targetRepo} missing required 'type' field`);
        }

        const repoTypeEmoji = repoObj.type === 'backend' ? '🔧' : repoObj.type === 'frontend' ? '🎨' : repoObj.type === 'mobile' ? '📱' : '📦';

        console.log(`   Target Repo: ${repoTypeEmoji} ${targetRepo} (${repoObj.type.toUpperCase()})`);
        console.log(`   Complexity: ${teamEpic.estimatedComplexity}`);
        console.log(`   🔥 CRITICAL: Tech Lead will ONLY create stories for ${repoObj.type.toUpperCase()} tasks`);
      }

      // TODO: Add epicsIdentified to IAgentStep if needed
      // For now, extract epics from productManager output manually if needed
      const _epicsIdentified: string[] = []; // task.orchestration.productManager.epicsIdentified || [];
      void _epicsIdentified; // Marked as intentionally unused

      // Build repositories information with TYPE and ENVIRONMENT VARIABLES for multi-repo orchestration
      const repoInfo = context.repositories.length > 0
        ? `\n## Available Repositories:\n${context.repositories.map((repo, i) => {
            const typeEmoji = repo.type === 'backend' ? '🔧' : repo.type === 'frontend' ? '🎨' : '📦';
            const isDefault = i === 0 ? ' (default workspace)' : '';

            // 🔐 Extract environment variable NAMES (not values) for tech stack inference
            let envVarsSection = '';
            if (repo.envVariables && repo.envVariables.length > 0) {
              const envVarNames = repo.envVariables.map((env: any) => {
                // For secrets, only show the key name (value is encrypted)
                // For non-secrets, show key=value for context
                if (env.isSecret) {
                  return `   - ${env.key}=****** (configured)`;
                } else {
                  // Decrypt if encrypted, otherwise use as-is
                  const value = CryptoService.isEncrypted(env.value)
                    ? CryptoService.decrypt(env.value)
                    : env.value;
                  return `   - ${env.key}=${value}`;
                }
              }).join('\n');
              envVarsSection = `\n   **Environment Variables (platform-configured)**:\n${envVarNames}`;
            }

            // 🔥 CRITICAL: Include LOCAL PATH so agent knows where files actually are
            const localPath = `${workspacePath || process.cwd()}/${repo.name}`;
            return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})${isDefault}
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}
   - Execution Order: ${repo.executionOrder || 'not set'}
   - **LOCAL PATH**: \`${localPath}\` ← USE THIS for Glob/Read/Grep!${envVarsSection}`;
          }).join('\n')}\n`
        : '';

      const workspaceInfo = workspaceStructure
        ? `\n## Workspace Structure:\n\`\`\`\n${workspaceStructure}\`\`\`\n\nDesign architecture considering all repositories.`
        : '';

      // Previous output for revision (if any) - ALWAYS include if exists (for continuations)
      const previousOutput = task.orchestration.techLead.output;
      const hasRevision = !!previousOutput;

      let revisionSection = '';
      if (hasRevision) {
        revisionSection = `

# Previous Architecture Available
Your previous architecture design is available if needed for reference:
\`\`\`
${previousOutput}
\`\`\`
`;
      }

      // 🔥 MULTI-TEAM MODE: Different prompt for epic breakdown into stories
      const firstRepoName = context.repositories[0]?.full_name || context.repositories[0]?.githubRepoName || 'repository-name';

      // 🔥 NEW: Get Master Epic context for contract awareness
      const masterEpic = context.getData<any>('masterEpic');

      // 🏗️ Get Architecture Brief from PlanningPhase (if available)
      const architectureBrief = context.getData<any>('architectureBrief');

      // 🔬 Get Project Radiography from PlanningPhase (LANGUAGE AGNOSTIC analysis)
      const projectRadiographies = context.getData<Map<string, ProjectRadiography>>('projectRadiographies');

      // 🔄 RETRY FEEDBACK: Add error feedback if this is a retry
      let retrySection = '';
      if (retryCount > 0 && lastError) {
        if (lastError.violationType === '1DEV1STORY') {
          retrySection = `

# 🚨🚨🚨 PREVIOUS ATTEMPT FAILED - FIX REQUIRED 🚨🚨🚨

## ❌ ERROR: 1 DEVELOPER = 1 STORY RULE VIOLATED

Your previous output assigned MULTIPLE stories to the SAME developer. This is NOT allowed.

**What went wrong:**
${lastError.violations?.map(([devId, stories]: [string, string[]]) =>
  `- ${devId} was assigned ${stories.length} stories: ${stories.join(', ')}`
).join('\n') || 'Multiple stories per developer'}

**Total stories:** ${lastError.totalStories}
**Required developers:** ${lastError.totalStories} (one per story)

## ✅ HOW TO FIX:

1. Count your stories: If you have N stories, you need N developers
2. Assign EXACTLY ONE story per developer:
   - story-1 → dev-1
   - story-2 → dev-2
   - story-3 → dev-3
   - etc.

3. Update teamComposition.developers to equal the number of stories

**DO NOT** assign multiple stories to the same developer again.

---

`;
        } else if (lastError.violationType === 'FILE_OVERLAP') {
          retrySection = `

# 🚨🚨🚨 PREVIOUS ATTEMPT FAILED - FIX REQUIRED 🚨🚨🚨

## ❌ ERROR: FILE OVERLAP DETECTED BETWEEN STORIES

Your previous output had MULTIPLE stories modifying the SAME file(s). This causes merge conflicts.

**Files with conflicts:**
${lastError.conflicts?.map((c: any) =>
  `- ${c.file} → modified by: ${c.stories.join(', ')}`
).join('\n') || 'Multiple stories touch same files'}

## ✅ HOW TO FIX:

1. Each file should appear in ONLY ONE story's filesToModify/filesToCreate
2. If two features need the same file, combine them into ONE story
3. Or redesign to use different files (one per story)

**Examples:**
❌ WRONG:
  story-1: filesToModify: ["src/app.ts", "src/config.ts"]
  story-2: filesToModify: ["src/app.ts"]  ← CONFLICT!

✅ CORRECT:
  story-1: filesToModify: ["src/app.ts", "src/config.ts"]  ← all app.ts work here
  story-2: filesToModify: ["src/routes.ts"]  ← different file

---

`;
        } else if (lastError.violationType === 'TECHLEAD_JUDGE_REJECTION') {
          // ⚖️ TechLead Judge rejection - stories don't properly cover the epic
          const judgeFeedback = lastError.feedback || lastError.message?.replace('TECHLEAD_JUDGE_REJECTION:', '').trim() || '';
          const judgeReason = lastError.reason || lastError.message || '';

          retrySection = `

# 🚨🚨🚨 JUDGE REJECTED YOUR PLANNING - READ CAREFULLY! 🚨🚨🚨

## ❌ WHY YOU WERE REJECTED:

${judgeReason}

## 📋 SPECIFIC ISSUES TO FIX:

${judgeFeedback}

---

## 🔴 CRITICAL RULES (YOU VIOLATED THESE):

1. **FOLLOW THE EPIC'S FILE GUIDANCE:**
   - If epic says \`filesToCreate: []\` → DO NOT create new files!
   - If epic says \`filesToModify: ["models/X.js"]\` → ONLY modify that file!

2. **FOLLOW THE EPIC'S ARCHITECTURE PATTERN:**
   - If epic says "subdocument pattern" → Use subdocuments, NOT new collections
   - If epic says "extend existing model" → Modify the existing file, NOT create new

3. **USE THE EPIC'S PRE-DEFINED STORIES:**
   - The epic already has stories defined by Planning
   - Your job is to EXPAND them with details, NOT replace them

## ⚡ HOW TO FIX:

1. READ the epic specification at the start of this prompt
2. USE the exact files listed in \`filesToModify\`
3. DO NOT create files if \`filesToCreate: []\` is empty
4. FOLLOW the \`followsPatterns\` directive exactly

---

`;
        }
      }

      const memoryProjectId = task.projectId?.toString() || '';
      const memoryContext = `
## 🧠 MEMORY CONTEXT (Use these IDs for memory tools)
- **Project ID**: \`${memoryProjectId}\`
- **Task ID**: \`${taskId}\`

Use these when calling \`recall()\` and \`remember()\` tools.
`;

      // 🏗️ Build Architecture Brief section if available from PlanningPhase
      let architectureBriefSection = '';
      if (architectureBrief) {
        architectureBriefSection = `
## 🏗️ ARCHITECTURE BRIEF (from Planning Analysis)
**CRITICAL: Follow these patterns discovered from the codebase!**

${architectureBrief.codePatterns ? `### Code Patterns
- **Naming Convention**: ${architectureBrief.codePatterns.namingConvention || 'Not specified'}
- **File Structure**: ${architectureBrief.codePatterns.fileStructure || 'Not specified'}
- **Error Handling**: ${architectureBrief.codePatterns.errorHandling || 'Not specified'}
- **Testing**: ${architectureBrief.codePatterns.testing || 'Not specified'}` : ''}

${architectureBrief.dataModels?.length > 0 ? `### Data Models
${architectureBrief.dataModels.map((m: any) => `- **${m.name}** (${m.file}): ${m.relationships?.join(', ') || 'no relationships'}`).join('\n')}` : ''}

${architectureBrief.prInsights ? `### PR Insights (What Gets Approved)
- Recent PRs analyzed: ${architectureBrief.prInsights.recentPRs || 0}
- Common patterns: ${architectureBrief.prInsights.commonPatterns?.join(', ') || 'None specified'}
- Rejection reasons: ${architectureBrief.prInsights.rejectionReasons?.join(', ') || 'None specified'}` : ''}

${architectureBrief.conventions?.length > 0 ? `### Project Conventions
${architectureBrief.conventions.map((c: string) => `- ${c}`).join('\n')}` : ''}

${architectureBrief.helperFunctions?.length > 0 ? `### 🔧 HELPER FUNCTIONS (MANDATORY TO USE!)
| Function | File | Usage | Anti-Pattern |
|----------|------|-------|--------------|
${architectureBrief.helperFunctions.map((h: any) => `| \`${h.name}()\` | ${h.file} | ${h.usage} | ❌ ${h.antiPattern} |`).join('\n')}

**⚠️ Stories MUST specify these helpers. Developers MUST use them.**` : ''}

${architectureBrief.entityCreationRules?.length > 0 ? `### 📋 ENTITY CREATION RULES (CRITICAL!)
| Entity | MUST Use | NEVER Use |
|--------|----------|-----------|
${architectureBrief.entityCreationRules.map((r: any) => `| ${r.entity} | \`${r.mustUse || 'Check codebase'}\` | ❌ \`${r.mustNotUse}\` |`).join('\n')}

**🔴 Code that ignores these rules will be REJECTED by Judge.**` : ''}

**USE THESE PATTERNS** when creating stories - code that doesn't follow these patterns will be rejected.
`;
      }

      // 🔬 Build Project Radiography section (LANGUAGE AGNOSTIC)
      let radiographySection = '';
      if (projectRadiographies && projectRadiographies.size > 0) {
        radiographySection = `
## 🔬 PROJECT RADIOGRAPHY (Complete Codebase Analysis - READ CAREFULLY!)

**This is a programmatic X-Ray of the codebase. This data is MORE RELIABLE than exploration.**

`;
        for (const [repoName, radiography] of projectRadiographies.entries()) {
          radiographySection += `
### 📁 ${repoName}
${ProjectRadiographyService.formatForPrompt(radiography)}
`;
        }

        radiographySection += `
---
**⚠️ CRITICAL FOR STORY CREATION**:
- USE the routes, models, services listed above when writing stories
- MATCH the detected conventions (naming, file structure)
- INCLUDE the entry points in dependencies when relevant
- Reference ACTUAL file paths from the radiography
---
`;
      }

      // 💡 USER DIRECTIVES - Incorporate any user-injected instructions
      const directivesBlock = context.getDirectivesBlock('tech-lead');

      const prompt = multiTeamMode ? this.buildMultiTeamPrompt(teamEpic, repoInfo, workspaceInfo, workspacePath || process.cwd(), firstRepoName, epicBranch, masterEpic, context.repositories, architectureBrief, projectRadiographies) : `${retrySection}Act as the tech-lead agent.
${memoryContext}
${architectureBriefSection}
${radiographySection}
${directivesBlock}
# Architecture & Planning
${revisionSection}
## Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}

## Workspace: ${workspacePath}
${repoInfo}

## 🔍 CRITICAL: VALIDATE & EXPAND REQUIREMENTS (DO THIS FIRST!)

**Before creating stories, VALIDATE that the task is well-defined:**

### If the Task Description is VAGUE:
1. **Search for existing implementations:**
   \`\`\`bash
   # Find related code to understand what already exists
   Grep("related-keyword|feature-name")
   Glob("**/related-folder/**")
   \`\`\`

2. **Expand into a COMPREHENSIVE feature list:**
   - What data models are needed? (not just one - ALL of them)
   - What APIs/endpoints? (CRUD at minimum)
   - What UI components? (list, detail, forms, etc.)
   - What validations? (input, business rules)
   - What error handling?
   - What tests?

3. **Document your expansion:**
   Add an "inferredRequirements" section to your output explaining what you added.

### ⚠️ YOUR STORIES ARE TOO SHALLOW IF:
- You only create 1-2 stories for a complex feature
- A backend story has no corresponding frontend story
- No validation or error handling mentioned
- No tests specified
- You didn't include acceptance criteria

### ✅ A COMPLETE STORY BREAKDOWN INCLUDES:
- **Data Layer**: Models, schemas, migrations
- **API Layer**: Endpoints, validation, error responses
- **Service Layer**: Business logic, helpers
- **UI Layer**: Components, pages, forms
- **Integration**: How parts connect to each other
- **Testing**: Unit, integration, e2e tests

## 🎯 INSTRUCTIONS (Be concise and efficient):

1. **EXPLORE** (max 3 minutes): Scan codebase structure to find real file paths
2. **DISCOVER PATTERNS**: Search for existing helper functions (createProject, createUser, etc.)
3. **CREATE 2-4 EPICS**: Major feature groups
4. **CREATE 3-5 STORIES PER EPIC**: Each 1-3 hours of work with PATTERNS included

## 🔍 MANDATORY: PATTERN DISCOVERY (Before Creating Stories)
${this.getPatternDiscoveryCommands(context.repositories)}
**Stories MUST tell developers to use existing patterns/helpers instead of reinventing the wheel.**

## STORY FORMAT (MUST include all sections):
- **Acceptance Criteria**: Given/When/Then format
- **Files**: Exact paths to read/modify/create
- **Technical Details**: Functions, APIs, types to implement
- **🔧 PATTERNS TO USE**: Which existing functions to use
- **⚠️ ANTI-PATTERNS TO AVOID**: What NOT to do
- **Code Examples**: Show developer exactly HOW to implement
- **Testing**: What tests to write
- **Done Criteria**: Checklist for completion

## JSON OUTPUT ONLY:
\`\`\`json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "Epic Name",
      "description": "Brief description",
      "branchName": "epic/epic-name",
      "targetRepository": "${context.repositories[0]?.name || 'repository'}",
      "stories": [
        {
          "id": "story-1",
          "title": "Story title",
          "description": "Complete description with acceptance criteria and requirements",
          "epicId": "epic-1",
          "priority": 1,
          "estimatedComplexity": "simple|moderate|complex",
          "dependencies": [],
          "status": "pending",
          "filesToRead": ["real/path/file.ts"],
          "filesToModify": ["real/path/file2.ts"],
          "filesToCreate": ["real/path/new.ts"],
          "acceptanceCriteria": [
            "Given X, When Y, Then Z",
            "Given A, When B, Then C"
          ],
          "mustUseHelpers": [
            {"function": "createProject", "from": "src/utils/helpers.ts", "reason": "Sets up required relationships"}
          ],
          "antiPatterns": [
            {"bad": "new Project({ name })", "why": "Missing agents, teams, defaultTeam", "good": "await createProject({ name })"}
          ],
          "codeExamples": [
            {
              "description": "How to create a project correctly",
              "code": "const project = await createProject({ name, description });\\n// This automatically creates: agents, teams, defaultTeam",
              "doNot": "const project = new Project({ name }); // ❌ Missing relationships!"
            }
          ],
          "testRequirements": ["Unit test for createProject", "Integration test for API endpoint"]
        }
      ],
      "status": "pending"
    }
  ],
  "architectureDesign": "Technical architecture: system design, data flow, APIs, security, error handling",
  "teamComposition": {
    "developers": 3,
    "reasoning": "3 stories = 3 developers (1 DEV = 1 STORY rule)"
  },
  "storyAssignments": [
    {"storyId": "story-1", "assignedTo": "dev-1"},
    {"storyId": "story-2", "assignedTo": "dev-2"},
    {"storyId": "story-3", "assignedTo": "dev-3"}
  ]
}
\`\`\`

**🔥🔥🔥 CRITICAL RULES - SYSTEM WILL FAIL WITHOUT THESE 🔥🔥🔥**

**RULE 1: 1 DEVELOPER = 1 STORY**
- NEVER assign 2+ stories to same developer
- Number of developers MUST equal number of stories
- Example: 5 stories → 5 developers (dev-1 to dev-5)

**RULE 2: NO FILE OVERLAPS BETWEEN STORIES**
- NEVER have 2 stories modify the same file
- Each file can only appear in ONE story's filesToModify/filesToCreate
- If 2 features need same file → PUT THEM IN THE SAME STORY
- This prevents merge conflicts when developers work in parallel

❌ WRONG (will cause merge conflict):
  story-1: filesToModify: ["src/app.ts"]
  story-2: filesToModify: ["src/app.ts"]  ← SAME FILE!

✅ CORRECT (no overlap):
${this.getFileOverlapExamples(context.repositories)}

**RULES**:
- EXPLORE FIRST: Use ls, find, Read to get real file paths
- USE REAL PATHS: No placeholders
- COMPLETE STORIES: Each must include acceptance criteria, files, technical specs, tests
- 1:1 ASSIGNMENT: Each story to UNIQUE developer (story-1→dev-1, story-2→dev-2, etc.)
- NO OVERLAPS: Each file in only ONE story`;

      // 🔥 CRITICAL: Retrieve processed attachments from context (shared from ProductManager)
      // This ensures ALL agents receive the same multimedia context without re-processing
      const attachments = context.getData<any[]>('attachments') || [];
      if (attachments.length > 0) {
        console.log(`📎 [TechLead] Using ${attachments.length} attachment(s) from context`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📎 Tech Lead: Received ${attachments.length} image(s) from context for architecture design`
        );
      }

      // Progress notification

      NotificationService.emitAgentProgress(
        taskId,
        'Tech Lead',
        'Designing architecture and building team...'
      );

      // 🔄 SESSION RESUME: Check for existing checkpoint
      const existingCheckpoint = await sessionCheckpointService.loadCheckpoint(taskId, 'tech-lead');
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [TechLead] RESUMING from previous session...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Tech Lead: Resuming from previous session checkpoint`
        );
      }

      // Execute agent
      const result = await this.executeAgentFn(
        'tech-lead',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Tech Lead',
        undefined, // sessionId
        undefined, // fork
        attachments.length > 0 ? attachments : undefined, // attachments
        undefined, // options
        undefined, // contextOverride
        undefined, // skipOptimization
        undefined, // permissionMode
        resumeOptions // 🔄 Session resume options
      );

      // 🔄 Save checkpoint after agent starts (for mid-execution recovery)
      if (result.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'tech-lead',
          result.sdkSessionId,
          undefined, // No entityId for tech-lead phase
          result.lastMessageUuid
        );
      }

      // Parse response - now using plain text with markers + optional JSON for structured data
      let parsed: any = null;

      // STEP 0: Check for completion marker
      const architectureComplete = hasMarker(result.output, '✅ ARCHITECTURE_COMPLETE');
      if (architectureComplete) {
        console.log('✅ [TechLead] ARCHITECTURE_COMPLETE marker found');

        // Extract metadata from markers
        const totalStories = extractMarkerValue(result.output, '📍 Total Stories:');
        const epicId = extractMarkerValue(result.output, '📍 Epic ID:');

        if (totalStories) {
          console.log(`   Total Stories: ${totalStories}`);
        }
        if (epicId) {
          console.log(`   Epic ID: ${epicId}`);
        }
      } else {
        console.warn('⚠️  [TechLead] No ARCHITECTURE_COMPLETE marker - output may be incomplete');
      }

      // STEP 1: Try parsing as pure JSON first (backward compatibility)
      try {
        const trimmed = result.output.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          parsed = JSON.parse(trimmed);
          if (parsed.epics && Array.isArray(parsed.epics)) {
            console.log('✅ [TechLead] Parsed as pure JSON (backward compatibility)');
          } else {
            parsed = null;
          }
        }
      } catch (e) {
        // Not pure JSON, try markdown patterns
      }

      // Try multiple extraction patterns (most specific to least specific)
      const patterns = [
        /```json\s*\n([\s\S]*?)\n```/,       // ```json\n{...}\n``` (strict)
        /```json\s*\n([\s\S]*?)```/,         // ```json\n{...}``` (newline after json)
        /```json\s*([\s\S]*?)```/,           // ```json{...}``` (no newlines)
        /```\s*\n([\s\S]*?)\n```/,           // ```\n{...}\n``` (no json keyword)
        /```\s*([\s\S]*?)```/                // ``` {...} ``` (minimal)
      ];

      // Try markdown patterns if pure JSON failed
      if (!parsed) {
        for (const pattern of patterns) {
          const match = result.output.match(pattern);
          if (match) {
            try {
              // Use captured group if available, otherwise full match
              const jsonText = match[1] || match[0];
              const trimmed = jsonText.trim();
              parsed = JSON.parse(trimmed);

              // Verify it has the required structure
              if (parsed.epics && Array.isArray(parsed.epics)) {
                console.log(`✅ [TechLead] Parsed JSON using pattern: ${pattern.toString().substring(0, 50)}...`);
                break;
              } else {
                console.log(`⚠️  [TechLead] Parsed JSON but missing epics array with pattern: ${pattern.toString().substring(0, 50)}...`);
                parsed = null; // Reset and try next pattern
                continue;
              }
            } catch (e) {
              console.log(`⚠️  [TechLead] Failed to parse with pattern: ${pattern.toString().substring(0, 50)}...`);
              continue;
            }
          }
        }
      }

      // Final fallback: find the longest valid JSON object with "epics" key
      if (!parsed) {
        console.log('⚠️  [TechLead] Standard patterns failed, trying fallback extraction...');

        // Strategy: Find all positions where '{' appears, then try to parse from each position
        const output = result.output;
        const candidates: Array<{text: string, length: number}> = [];

        for (let i = 0; i < output.length; i++) {
          if (output[i] === '{') {
            // Try to find balanced braces from this position
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
                  // Found a complete object
                  const candidate = output.substring(i, j + 1);
                  candidates.push({ text: candidate, length: candidate.length });
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
              parsed = candidateParsed;
              console.log(`✅ [TechLead] Parsed JSON using fallback extraction (found ${candidate.length} char object with epics)`);
              break;
            }
          } catch (e) {
            // Not valid JSON, continue
          }
        }
      }

      if (!parsed) {
        console.log('❌ [TechLead] All JSON extraction patterns failed');
      }

      // Final validation - MUST have both epics[] and storyAssignments[]
      if (!parsed || !parsed.epics || !Array.isArray(parsed.epics)) {
        console.log('\n🔍 [TechLead] FULL Agent output:\n', result.output);
        NotificationService.emitConsoleLog(taskId, 'error', `❌ Tech Lead parsing failed. Full output:\n${result.output}`);
        throw new Error(`Tech Lead did not return valid epics array. Marker: ${architectureComplete ? 'FOUND' : 'MISSING'}`);
      }

      if (parsed.epics.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty epics array');
        throw new Error('Tech Lead returned empty epics array - cannot proceed with development');
      }

      // Validate storyAssignments[] exists (critical for developers)
      if (!parsed.storyAssignments || !Array.isArray(parsed.storyAssignments)) {
        console.log('\n🔍 [TechLead] Missing storyAssignments in output');
        throw new Error('Tech Lead did not return storyAssignments array - developers need file paths');
      }

      if (parsed.storyAssignments.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty storyAssignments array');
        throw new Error('Tech Lead returned empty storyAssignments - developers need work assignments');
      }

      console.log(`✅ [TechLead] Successfully parsed ${parsed.epics.length} epic(s) with ${parsed.storyAssignments.length} story assignment(s)`);

      // 🔥🔥🔥 STRICT VALIDATION: 1 DEVELOPER = 1 STORY (NEVER MORE) 🔥🔥🔥
      // Count stories per developer
      const storiesPerDev: { [devId: string]: string[] } = {};
      for (const assignment of parsed.storyAssignments) {
        const devId = assignment.assignedTo;
        if (!storiesPerDev[devId]) {
          storiesPerDev[devId] = [];
        }
        storiesPerDev[devId].push(assignment.storyId);
      }

      // Check for violations
      const violations = Object.entries(storiesPerDev).filter(([_, stories]) => stories.length > 1);
      if (violations.length > 0) {
        console.error(`\n❌❌❌ [TechLead] CRITICAL VIOLATION: 1 DEVELOPER = 1 STORY RULE BROKEN! ❌❌❌`);
        for (const [devId, stories] of violations) {
          console.error(`   Developer ${devId} has ${stories.length} stories: ${stories.join(', ')}`);
        }
        console.error(`\n   RULE: Each developer must have EXACTLY 1 story.`);
        console.error(`   Total stories: ${parsed.storyAssignments.length}`);
        console.error(`   Required developers: ${parsed.storyAssignments.length} (1 per story)`);
        console.error(`\n   TechLead must create ${parsed.storyAssignments.length} developers and assign 1 story to each.`);

        // 🔄 RETRY: Throw with specific error type for retry logic
        const error = new Error(
          `RULE_VIOLATION_1DEV1STORY: TechLead assigned multiple stories to same developer. ` +
          `Violations: ${violations.map(([d, s]) => `${d} has ${s.length} stories`).join('; ')}. ` +
          `Rule: 1 Developer = 1 Story. Need ${parsed.storyAssignments.length} developers.`
        );
        (error as any).retryable = true;
        (error as any).violationType = '1DEV1STORY';
        (error as any).violations = violations;
        (error as any).totalStories = parsed.storyAssignments.length;
        throw error;
      }

      // Validate teamComposition matches story count
      const requiredDevs = parsed.storyAssignments.length;
      const configuredDevs = parsed.teamComposition?.developers || 0;
      if (configuredDevs < requiredDevs) {
        console.error(`\n❌ [TechLead] teamComposition.developers (${configuredDevs}) < stories (${requiredDevs})`);
        console.error(`   Each story needs its own developer. Adjusting teamComposition...`);
        parsed.teamComposition = {
          ...parsed.teamComposition,
          developers: requiredDevs,
          reasoning: `Auto-adjusted: ${requiredDevs} stories = ${requiredDevs} developers (1:1 rule)`
        };
        console.log(`   ✅ Fixed: teamComposition.developers = ${requiredDevs}`);
      }

      console.log(`✅ [TechLead] 1 Dev = 1 Story validation passed: ${Object.keys(storiesPerDev).length} developers, ${parsed.storyAssignments.length} stories`);

      // Build complete stories map - Preserve all story data from Tech Lead
      const storiesMap: { [storyId: string]: any } = {};
      parsed.epics.forEach((epic: any) => {
        epic.stories.forEach((story: any) => {
          storiesMap[story.id] = {
            id: story.id,
            title: story.title,
            description: story.description,
            epicId: epic.id,
            priority: story.priority,
            estimatedComplexity: story.estimatedComplexity,
            status: 'pending',
            dependencies: story.dependencies || [],
            filesToModify: story.filesToModify || [],
            filesToCreate: story.filesToCreate || [],
            filesToRead: story.filesToRead || [],
          };
        });
      });

      // 🚨🚨🚨 CRITICAL: VALIDATE NO FILE OVERLAPS BETWEEN STORIES 🚨🚨🚨
      // If two stories modify the same file, it will cause merge conflicts
      console.log(`\n🔍 [TechLead] Validating story file overlaps...`);
      const { validateStoryOverlap, logOverlapValidation } = await import('./utils/StoryOverlapValidator');

      // Collect all stories from all epics for validation
      const allStories = parsed.epics.flatMap((epic: any) =>
        epic.stories.map((story: any) => ({
          id: story.id,
          title: story.title,
          filesToModify: story.filesToModify || [],
          filesToCreate: story.filesToCreate || [],
          filesToRead: story.filesToRead || [],
        }))
      );

      const overlapResult = validateStoryOverlap(allStories);
      logOverlapValidation(overlapResult, taskId);

      if (overlapResult.hasOverlap) {
        console.error(`\n❌❌❌ [TechLead] CRITICAL: FILE OVERLAP DETECTED! ❌❌❌`);
        console.error(`   This WILL cause merge conflicts when developers work in parallel!`);
        console.error(`\n   Conflicts found:`);
        for (const conflict of overlapResult.conflicts) {
          console.error(`   📄 ${conflict.file}`);
          console.error(`      → Modified by: ${conflict.stories.join(', ')}`);
        }
        console.error(`\n   ⚠️  TechLead must redesign stories to avoid file overlaps!`);
        console.error(`   💡 Options: 1) One file per story, 2) Sequential dependencies, 3) Vertical slicing`);

        // 🔄 RETRY: Throw with specific error type for retry logic
        const error = new Error(
          `RULE_VIOLATION_FILE_OVERLAP: ${overlapResult.conflicts.length} file(s) are modified by multiple stories. ` +
          `This will cause merge conflicts. ` +
          `Conflicts: ${overlapResult.conflicts.map(c => `${c.file} (${c.stories.join(', ')})`).join('; ')}`
        );
        (error as any).retryable = true;
        (error as any).violationType = 'FILE_OVERLAP';
        (error as any).conflicts = overlapResult.conflicts;
        throw error;
      }

      console.log(`✅ [TechLead] No file overlaps detected - parallel execution is safe`);

      // 🔥 CRITICAL: VALIDATE and INHERIT targetRepository for multi-team mode
      if (multiTeamMode && teamEpic) {
        console.log(`\n🔍 [TechLead] Validating targetRepository for multi-team epic...`);

        for (const epic of parsed.epics) {
          // 🔥 FIX: If agent didn't return targetRepository, inherit from teamEpic
          if (!epic.targetRepository) {
            console.warn(`⚠️  [TechLead] Epic ${epic.id} missing targetRepository in agent response`);
            console.log(`   📋 Inheriting from teamEpic: ${teamEpic.targetRepository}`);
            epic.targetRepository = teamEpic.targetRepository;
          }

          // 🔥 CRITICAL: Validate targetRepository is NOT null/undefined
          if (!epic.targetRepository) {
            console.error(`❌ [TechLead] Epic ${epic.id} has NO targetRepository!`);
            console.error(`   TeamEpic targetRepository: ${teamEpic.targetRepository || 'NULL'}`);
            console.error(`   Available repositories: ${context.repositories.map(r => r.name || r.githubRepoName).join(', ')}`);
            throw new Error(`Epic ${epic.id} missing targetRepository - cannot proceed without knowing target repository`);
          }

          console.log(`   ✅ Epic ${epic.id} → ${epic.targetRepository}`);
        }
      }

      // 🔥 EVENT SOURCING: Emit events instead of storing nested objects
      const { eventStore } = await import('../EventStore');

      // Emit epic events
      for (const epic of parsed.epics) {
        // 🔥 CRITICAL: targetRepository MUST exist at this point (validated above)
        if (!epic.targetRepository) {
          throw new Error(`Epic ${epic.id} has no targetRepository - this should have been caught earlier!`);
        }

        await eventStore.append({
          taskId: task._id as any,
          eventType: 'EpicCreated',
          agentName: 'tech-lead',
          payload: {
            id: epic.id,
            name: epic.name,
            description: epic.description,
            branchName: epic.branchName,
            stories: epic.stories.map((s: any) => s.id), // Story IDs only
            targetRepository: epic.targetRepository, // 🔥 NEVER undefined/null here
          },
        });

        // Emit story events for each story in this epic
        // 🔥 CRITICAL: Stories INHERIT targetRepository from their epic
        for (const story of epic.stories) {
          await eventStore.append({
            taskId: task._id as any,
            eventType: 'StoryCreated',
            agentName: 'tech-lead',
            payload: {
              id: story.id,
              epicId: epic.id,
              title: story.title,
              description: story.description,
              priority: story.priority,
              complexity: story.estimatedComplexity,
              estimatedComplexity: story.estimatedComplexity, // For backward compatibility
              assignedTo: parsed.storyAssignments?.find((a: any) => a.storyId === story.id)?.assignedTo,
              filesToRead: story.filesToRead || [],
              filesToModify: story.filesToModify || [],
              filesToCreate: story.filesToCreate || [],
              dependencies: story.dependencies || [],
              targetRepository: epic.targetRepository, // 🔥 INHERIT from epic
            },
          });
        }
      }

      // Emit team composition event
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TeamCompositionDefined',
        agentName: 'tech-lead',
        payload: parsed.teamComposition,
      });

      // 🔧 ENVIRONMENT CONFIG: Parse and emit if TechLead provided it
      // This contains project-specific commands (test, lint, typecheck, etc.)
      if (parsed.environmentConfig) {
        console.log(`📋 [TechLead] Environment config found - storing for developers`);
        console.log(`   Install: ${parsed.environmentConfig.installCommand || 'not specified'}`);
        console.log(`   Test: ${parsed.environmentConfig.testCommand || 'not specified'}`);
        console.log(`   Lint: ${parsed.environmentConfig.lintCommand || 'not specified'}`);
        console.log(`   Typecheck: ${parsed.environmentConfig.typecheckCommand || 'not specified'}`);

        // Emit EnvironmentConfigDefined event for TeamOrchestrationPhase
        await eventStore.append({
          taskId: task._id as any,
          eventType: 'EnvironmentConfigDefined',
          agentName: 'tech-lead',
          payload: parsed.environmentConfig,
        });

        // Store in task.orchestration for persistence (survives server restart)
        task.orchestration.environmentConfig = parsed.environmentConfig;
        task.markModified('orchestration.environmentConfig');

        console.log(`✅ [TechLead] EnvironmentConfigDefined event emitted + stored in task`);
      } else {
        console.log(`⚠️  [TechLead] No environmentConfig in output - using defaults`);
      }

      // ⚖️ TECHLEAD JUDGE: Validate stories cover the EPIC (not the full requirement)
      // This is different from Supervisor - we only check if THIS epic is well broken down
      const techLeadJudgeResult = await this.judgeTechLeadOutput(parsed, multiTeamMode ? teamEpic : null, taskId, task);

      if (!techLeadJudgeResult.approved) {
        console.error(`\n🚨 [TechLead] Judge rejected: ${techLeadJudgeResult.reason}`);

        // 🎯 ACTIVITY: Emit Judge rejection for Activity tab
        AgentActivityService.emitToolUse(taskId, 'TechLead', 'StoryValidation', {
          verdict: 'REJECTED',
          reason: techLeadJudgeResult.reason,
          storiesCount: techLeadJudgeResult.storiesCount,
          epicsCount: techLeadJudgeResult.epicsCount,
        });
        AgentActivityService.emitError(
          taskId,
          'TechLead',
          `⚖️ Judge rejected: ${techLeadJudgeResult.reason}`
        );
        NotificationService.emitAgentMessage(
          taskId,
          'TechLead',
          `⚖️ JUDGE REJECTED: ${techLeadJudgeResult.reason}\n${techLeadJudgeResult.feedback || ''}`
        );

        const error = new Error(`TECHLEAD_JUDGE_REJECTION: ${techLeadJudgeResult.reason}`);
        (error as any).retryable = true;
        (error as any).violationType = 'TECHLEAD_JUDGE_REJECTION';
        (error as any).feedback = techLeadJudgeResult.feedback;
        (error as any).reason = techLeadJudgeResult.reason; // Pass full rejection reason
        throw error;
      }

      // 🎯 ACTIVITY: Emit Judge approval with AI evaluation details for Activity tab
      const aiEval = techLeadJudgeResult.aiEvaluation;
      AgentActivityService.emitToolUse(taskId, 'TechLead', 'StoryValidation', {
        verdict: 'APPROVED',
        storiesCount: techLeadJudgeResult.storiesCount,
        epicsCount: techLeadJudgeResult.epicsCount,
        aiScore: aiEval?.score,
      });

      // Build detailed message showing AI evaluation results
      const checksMessage = aiEval ? [
        `🤖 AI Score: ${aiEval.score}/100`,
        `📝 ${aiEval.reasoning}`,
        aiEval.suggestions?.length > 0 ? `💡 Suggestions: ${aiEval.suggestions.slice(0, 2).join(', ')}` : null,
      ].filter(Boolean).join('\n') : `✅ ${techLeadJudgeResult.storiesCount} stories, ${techLeadJudgeResult.epicsCount} epic(s)`;

      AgentActivityService.emitMessage(
        taskId,
        'TechLead',
        `⚖️ Judge approved: ${techLeadJudgeResult.storiesCount} stories for ${techLeadJudgeResult.epicsCount} epic(s)\n${checksMessage}`
      );
      NotificationService.emitAgentMessage(
        taskId,
        'TechLead',
        `⚖️ JUDGE APPROVED\n${checksMessage}`
      );

      console.log(`✅ [TechLead] Judge approved - ${techLeadJudgeResult.storiesCount} stories for ${techLeadJudgeResult.epicsCount} epic(s)`);

      // ✅ BACKWARD COMPATIBILITY: Also store in Task model (will remove later)
      const epicsWithStringIds = parsed.epics.map((epic: any) => ({
        ...epic,
        stories: epic.stories.map((s: any) => s.id),
        targetRepository: epic.targetRepository || undefined,
      }));
      // TODO: Add epics and storiesMap to IAgentStep if needed
      // For now, store in output only
      // task.orchestration.techLead.epics = epicsWithStringIds;
      // task.orchestration.techLead.storiesMap = storiesMap;
      task.orchestration.techLead.architectureDesign = parsed.architectureDesign;
      task.orchestration.techLead.teamComposition = parsed.teamComposition;
      task.orchestration.techLead.storyAssignments = parsed.storyAssignments;
      // task.markModified('orchestration.techLead.epics');
      // task.markModified('orchestration.techLead.storiesMap');

      // Store agent metadata
      task.orchestration.techLead.status = 'completed';
      task.orchestration.techLead.completedAt = new Date();
      task.orchestration.techLead.output = result.output;
      task.orchestration.techLead.sessionId = result.sessionId;
      // TODO: Add canResumeSession, todos, lastTodoUpdate to IAgentStep if needed
      // task.orchestration.techLead.canResumeSession = result.canResume;
      task.orchestration.techLead.usage = result.usage;
      task.orchestration.techLead.cost_usd = result.cost;

      // if (result.todos) {
      //   task.orchestration.techLead.todos = result.todos;
      //   task.orchestration.techLead.lastTodoUpdate = new Date();
      // }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      // 💰 COST ESTIMATION (INFORMATIONAL) - No approval required
      console.log('\n💰 =============== COST ESTIMATION (INFORMATIONAL) ===============');
      const realisticCostEstimator = new RealisticCostEstimator();
      try {
        const costEstimate = await realisticCostEstimator.estimateRealistic(
          epicsWithStringIds,
          context.repositories || [],
          workspacePath
        );

        console.log(`\n💵 REALISTIC COST ESTIMATE:`);
        console.log(`   Total: $${costEstimate.totalEstimated.toFixed(2)}`);
        console.log(`   Range: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}`);
        console.log(`   Per story: $${costEstimate.perStoryEstimate.toFixed(2)}`);
        console.log(`   Duration: ${costEstimate.estimatedDuration} minutes`);
        console.log(`   Confidence: ${costEstimate.confidence}%`);
        console.log(`   Methodology: ${costEstimate.methodology}\n`);

        // Append cost estimate to Tech Lead output (informational)
        task.orchestration.techLead.output += `\n\n---\n\n## 💰 Cost Estimate (Informational)\n\n` +
          `**Total Estimated Cost**: $${costEstimate.totalEstimated.toFixed(2)}\n` +
          `**Range**: $${costEstimate.totalMinimum.toFixed(2)} - $${costEstimate.totalMaximum.toFixed(2)}\n` +
          `**Per Story**: $${costEstimate.perStoryEstimate.toFixed(2)}\n` +
          `**Stories**: ${costEstimate.storiesCount}\n` +
          `**Estimated Duration**: ${costEstimate.estimatedDuration} minutes\n` +
          `**Confidence**: ${costEstimate.confidence}%\n` +
          `**Methodology**: ${costEstimate.methodology}\n\n` +
          `*This is an informational estimate and does not require approval.*`;

        // TODO: Add costEstimate to IAgentStep if needed
        // For now, cost estimate is already appended to output above
        // task.orchestration.techLead.costEstimate = {
        //   estimated: costEstimate.totalEstimated,
        //   minimum: costEstimate.totalMinimum,
        //   maximum: costEstimate.totalMaximum,
        //   perStory: costEstimate.perStoryEstimate,
        //   duration: costEstimate.estimatedDuration,
        //   confidence: costEstimate.confidence,
        //   methodology: costEstimate.methodology,
        //   informationalOnly: true
        // };

        // 🔥 CRITICAL: Mark nested object as modified for Mongoose
        // task.markModified('orchestration.techLead.costEstimate');

        console.log(`✅ [Cost Estimation] Added to Tech Lead output (informational only)`);
      } catch (error: any) {
        console.warn(`⚠️  [Cost Estimation] Failed: ${error.message} - Continuing without cost estimate`);
        task.orchestration.techLead.output += `\n\n---\n\n## 💰 Cost Estimate\n\n*Cost estimation unavailable: ${error.message}*`;
      }

      // Save task (skip in multi-team mode to avoid version conflicts)
      if (!multiTeamMode) {
        await task.save();
      }

      // 🔥 EVENT SOURCING: Emit completion event
      // 🔥 CRITICAL FIX: Include epicId in multi-team mode so shouldSkip can filter correctly
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TechLeadCompleted',
        agentName: 'tech-lead',
        payload: {
          output: result.output,
          epicsCount: parsed.epics.length,
          storiesCount: Object.keys(storiesMap).length,
          // 🔥 CRITICAL: Include epicId for multi-team mode filtering
          epicId: multiTeamMode ? teamEpic?.id : undefined,
          multiTeamMode,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [TechLead] Emitted ${parsed.epics.length} EpicCreated + ${Object.keys(storiesMap).length} StoryCreated events`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🏗️ TECH LEAD - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // 🎯 ACTIVITY: Emit result for Activity tab (shows in UI)
      AgentActivityService.emitToolUse(taskId, agentLabel, 'ArchitectureDesign', {
        epics: parsed.epics.length,
        stories: Object.keys(storiesMap).length,
        developers: parsed.teamComposition.developers,
      });
      AgentActivityService.emitMessage(
        taskId,
        agentLabel,
        `✅ Architecture completed: ${parsed.epics.length} epic(s), ${Object.keys(storiesMap).length} stories, ${parsed.teamComposition.developers} developer(s)`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Tech Lead', result.output);

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Tech Lead',
        `Architecture designed. Team: ${parsed.teamComposition.developers} developers. Stories assigned.`
      );

      await LogService.agentCompleted('tech-lead', taskId, {
        phase: 'architecture',
        metadata: {
          developersCount: parsed.teamComposition.developers,
          epicsCount: parsed.epics.length,
          storiesCount: Object.keys(storiesMap).length,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data for next phases
      context.setData('epics', epicsWithStringIds);
      context.setData('storiesMap', storiesMap);
      context.setData('teamComposition', parsed.teamComposition);
      context.setData('storyAssignments', parsed.storyAssignments);
      context.setData('architectureDesign', parsed.architectureDesign);

      // 🔄 Mark checkpoint as completed (no resume needed)
      await sessionCheckpointService.markCompleted(taskId, 'tech-lead');

      // 🧠 GRANULAR MEMORY: Store TechLead decisions
      const projectId = task.projectId?.toString();
      if (projectId) {
        try {
          // Store progress marker
          await granularMemoryService.storeProgress({
            projectId,
            taskId,
            phaseType: 'tech-lead',
            agentType: 'tech-lead',
            epicId: multiTeamMode ? teamEpic?.id : undefined,
            status: 'completed',
            details: `Created ${Object.keys(storiesMap).length} stories, assigned to ${parsed.teamComposition.developers} developer(s)`,
          });

          // Store each story as a decision
          for (const [storyId, story] of Object.entries(storiesMap)) {
            const storyData = story as any;
            await granularMemoryService.storeDecision({
              projectId,
              taskId,
              phaseType: 'tech-lead',
              agentType: 'tech-lead',
              epicId: multiTeamMode ? teamEpic?.id : undefined,
              storyId,
              title: `Story: ${storyData.title || storyId}`,
              content: `Assigned to: ${storyData.assignedTo || 'unassigned'}\nComplexity: ${storyData.complexity || 'N/A'}\nFiles: ${storyData.filesToModify?.join(', ') || 'none'}`,
              importance: 'high',
            });
          }

          // Store architecture decision
          if (parsed.architectureDesign) {
            await granularMemoryService.storeDecision({
              projectId,
              taskId,
              phaseType: 'tech-lead',
              agentType: 'tech-lead',
              epicId: multiTeamMode ? teamEpic?.id : undefined,
              title: 'Architecture Design',
              content: typeof parsed.architectureDesign === 'string'
                ? parsed.architectureDesign.substring(0, 1000)
                : JSON.stringify(parsed.architectureDesign).substring(0, 1000),
              importance: 'critical',
            });
          }

          console.log(`🧠 [TechLead] Stored ${Object.keys(storiesMap).length + 2} memories (progress, stories, architecture)`);
        } catch (memError: any) {
          console.warn(`⚠️ [TechLead] Failed to store memories: ${memError.message}`);
        }
      }

      return {
        success: true,
        data: {
          epics: epicsWithStringIds,
          storiesMap,
          teamComposition: parsed.teamComposition,
          storyAssignments: parsed.storyAssignments,
          architectureDesign: parsed.architectureDesign,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          developers_count: parsed.teamComposition.developers,
          epics_count: parsed.epics.length,
          stories_count: Object.keys(storiesMap).length,
        },
      };
    } catch (error: any) {
      // 🔄 RETRY: Check if this error is retryable
      if (error.retryable && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        lastError = error;
        console.log(`\n⚠️  [TechLead] Retryable error caught: ${error.violationType}`);
        console.log(`   Will retry (${retryCount}/${MAX_RETRIES - 1})...`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️ TechLead rule violation: ${error.violationType}. Retrying (${retryCount}/${MAX_RETRIES - 1})...`
        );
        continue; // Go back to while loop
      }

      // Non-retryable error OR max retries reached
      if (error.retryable) {
        console.error(`\n❌❌❌ [TechLead] MAX RETRIES (${MAX_RETRIES}) REACHED - GIVING UP ❌❌❌`);
        console.error(`   Last error: ${error.violationType}`);
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ TechLead failed after ${MAX_RETRIES} attempts: ${error.violationType}`
        );
      }

      // Skip task updates in multi-team mode to avoid version conflicts
      if (!multiTeamMode) {
        task.orchestration.techLead.status = 'failed';
        task.orchestration.techLead.error = error.message;
        await task.save();
      }

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Tech Lead', error.message);

      await LogService.agentFailed('tech-lead', taskId, error, {
        phase: 'architecture',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TechLeadCompleted', // Mark as completed even on error
        agentName: 'tech-lead',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [TechLead] Emitted TechLeadCompleted event (error state)`);

      // 🔄 Mark checkpoint as failed
      await sessionCheckpointService.markFailed(taskId, 'tech-lead', undefined, error.message);

      return {
        success: false,
        error: error.message,
      };
    }
    } // End of while loop

    // Should never reach here (while loop always returns)
    return {
      success: false,
      error: 'Unexpected: TechLead execution loop exited without result',
    };
  }

  /**
   * Build prompt for Multi-Team mode (epic breakdown into stories + dev assignment)
   * 🔥 NEW: Includes Master Epic context for contract awareness
   * 🏗️ NEW: Includes Architecture Brief from PlanningPhase
   */
  private buildMultiTeamPrompt(epic: any, repoInfo: string, _workspaceInfo: string, workspacePath: string, _firstRepo?: string, branchName?: string, masterEpic?: any, repositories?: any[], architectureBrief?: any, projectRadiographies?: Map<string, ProjectRadiography>): string {
    // 🔥 CRITICAL: Epic MUST have targetRepository - NO FALLBACKS
    if (!epic.targetRepository) {
      console.error(`\n❌❌❌ [TechLead] CRITICAL ERROR: Epic has NO targetRepository in buildMultiTeamPrompt!`);
      console.error(`   Epic: ${epic.title || epic.name}`);
      console.error(`   Epic ID: ${epic.id}`);
      console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THIS EPIC BELONGS TO`);
      console.error(`   💀 CANNOT BUILD PROMPT - WOULD BE ARBITRARY`);
      console.error(`\n   🛑 STOPPING - HUMAN INTERVENTION REQUIRED`);
      throw new Error(`HUMAN_REQUIRED: Epic ${epic.id} has no targetRepository in buildMultiTeamPrompt`);
    }

    const targetRepo = epic.targetRepository;

    // 🔥 FIXED: Get REAL repository type from database instead of string heuristic
    const repoObj = repositories?.find(r =>
      r.name === targetRepo ||
      r.githubRepoName === targetRepo ||
      r.full_name === targetRepo
    );

    // 🔥 CRITICAL: Handle null type (repos without type assigned yet)
    if (!repoObj) {
      console.error(`❌ [TechLead] Repository ${targetRepo} NOT FOUND in context.repositories`);
      console.error(`   Available repos: ${repositories?.map(r => r.name || r.githubRepoName).join(', ')}`);
      throw new Error(`HUMAN_REQUIRED: Repository ${targetRepo} not found in context.repositories`);
    }

    if (!repoObj.type) {
      console.error(`❌ [TechLead] Repository ${targetRepo} has NO TYPE assigned in database!`);
      console.error(`   Please set type in MongoDB: 'backend', 'frontend', 'mobile', or 'shared'`);
      console.error(`   Tech Lead CANNOT work without knowing repository type - ABORTING`);
      throw new Error(`HUMAN_REQUIRED: Repository ${targetRepo} missing required 'type' field in database`);
    }

    const repoType = repoObj?.type ? repoObj.type.toUpperCase() : 'UNKNOWN';
    const repoTypeEmoji = repoObj?.type === 'backend' ? '🔧' : repoObj?.type === 'frontend' ? '🎨' : repoObj?.type === 'mobile' ? '📱' : '📦';

    // Master Epic context if available
    let masterEpicContext = '';
    if (masterEpic && epic.masterEpicId === masterEpic.id) {
      const namingConventions = epic.globalNamingConventions || masterEpic.globalNamingConventions || {};
      const sharedContracts = epic.sharedContracts || masterEpic.sharedContracts || {};
      const otherRepos = (masterEpic.affectedRepositories || []).filter((r: string) => r !== targetRepo);

      masterEpicContext = `
## Master Epic Context
**Master Epic**: ${masterEpic.title} (${masterEpic.id})
**Your Sub-Epic**: ${epic.id} (${repoType})
${otherRepos.length > 0 ? `**Other Teams**: ${otherRepos.join(', ')}` : ''}

### Naming Conventions (MANDATORY)
${Object.entries(namingConventions).map(([key, value]) => `- ${key}: ${value}`).join('\n')}

### Shared Contracts
${sharedContracts.apiEndpoints?.length > 0 ? `APIs: ${sharedContracts.apiEndpoints.map((api: any) => `${api.method} ${api.path}`).join(', ')}` : ''}
${sharedContracts.sharedTypes?.length > 0 ? `Types: ${sharedContracts.sharedTypes.map((t: any) => t.name).join(', ')}` : ''}

**CRITICAL**: Use exact field names and API signatures from contracts above.
`;
    }

    // 🔥 CRITICAL: Repository-specific guidance
    const repoGuidance = repoObj?.type === 'backend' ? `
## 🔧 BACKEND Repository - Focus On:
✅ **APIs & Endpoints**: Express routes, controllers, API handlers
✅ **Business Logic**: Services, models, database operations
✅ **Data Processing**: Validation, transformation, calculations
✅ **Server-Side**: Authentication, authorization, middleware
✅ **Database**: Schemas, queries, migrations, seeds
✅ **Tests**: Unit tests (Jest), integration tests, API tests

❌ **DO NOT** assign UI/frontend tasks (React components, CSS, pages, hooks)
❌ **DO NOT** assign client-side state management (Redux, Context, etc.)
` : repoObj?.type === 'frontend' ? `
## 🎨 FRONTEND Repository - Focus On:
✅ **UI Components**: React components, hooks, pages
✅ **State Management**: Redux, Context, local state
✅ **Styling**: CSS, styled-components, Tailwind
✅ **Client-Side**: Routing, forms, validation, API calls
✅ **User Experience**: Interactions, animations, responsiveness
✅ **Tests**: Component tests (Jest + RTL), E2E tests

❌ **DO NOT** assign backend tasks (APIs, database, server logic)
❌ **DO NOT** assign Express routes or MongoDB schemas
` : '';

    // 🏗️ Architecture Brief section from PlanningPhase (if available)
    let archBriefSection = '';
    if (architectureBrief) {
      archBriefSection = `
## 🏗️ ARCHITECTURE BRIEF (from Planning Analysis)
**CRITICAL: Follow these patterns discovered from the codebase!**

${architectureBrief.codePatterns ? `### Code Patterns
- **Naming Convention**: ${architectureBrief.codePatterns.namingConvention || 'Not specified'}
- **File Structure**: ${architectureBrief.codePatterns.fileStructure || 'Not specified'}
- **Error Handling**: ${architectureBrief.codePatterns.errorHandling || 'Not specified'}
- **Testing**: ${architectureBrief.codePatterns.testing || 'Not specified'}` : ''}

${architectureBrief.dataModels?.length > 0 ? `### Data Models
${architectureBrief.dataModels.map((m: any) => `- **${m.name}** (${m.file}): ${m.relationships?.join(', ') || 'no relationships'}`).join('\n')}` : ''}

${architectureBrief.prInsights ? `### PR Insights (What Gets Approved)
- Recent PRs analyzed: ${architectureBrief.prInsights.recentPRs || 0}
- Common patterns: ${architectureBrief.prInsights.commonPatterns?.join(', ') || 'None specified'}
- Requirements: ${architectureBrief.prInsights.requirements?.join(', ') || 'None specified'}` : ''}

${architectureBrief.conventions?.length > 0 ? `### Project Conventions
${architectureBrief.conventions.map((c: string) => `- ${c}`).join('\n')}` : ''}

${architectureBrief.helperFunctions?.length > 0 ? `### 🔧 HELPER FUNCTIONS (MANDATORY TO USE!)
| Function | File | Usage | Anti-Pattern |
|----------|------|-------|--------------|
${architectureBrief.helperFunctions.map((h: any) => `| \`${h.name}()\` | ${h.file} | ${h.usage} | ❌ ${h.antiPattern} |`).join('\n')}

**⚠️ Stories MUST specify these helpers. Developers MUST use them.**` : ''}

${architectureBrief.entityCreationRules?.length > 0 ? `### 📋 ENTITY CREATION RULES (CRITICAL!)
| Entity | MUST Use | NEVER Use |
|--------|----------|-----------|
${architectureBrief.entityCreationRules.map((r: any) => `| ${r.entity} | \`${r.mustUse || 'Check codebase'}\` | ❌ \`${r.mustNotUse}\` |`).join('\n')}

**🔴 Code that ignores these rules will be REJECTED by Judge.**` : ''}

**USE THESE PATTERNS** when creating stories - code that doesn't follow these patterns will be rejected.
`;
    }

    // 🔬 Build Project Radiography section for the TARGET repository
    let radiographySection = '';
    if (projectRadiographies) {
      // In multi-team mode, show ONLY the target repository's radiography
      const targetRadiography = projectRadiographies.get(targetRepo);
      if (targetRadiography) {
        radiographySection = `
## 🔬 PROJECT RADIOGRAPHY (${targetRepo} - Complete Analysis)

**This is a programmatic X-Ray of the codebase. This data is MORE RELIABLE than exploration.**

${ProjectRadiographyService.formatForPrompt(targetRadiography)}

---
**⚠️ CRITICAL FOR STORY CREATION**:
- USE the routes, models, services listed above when writing stories
- MATCH the detected conventions (naming, file structure)
- Reference ACTUAL file paths from the radiography
---
`;
      }
    }

    return `TECH LEAD - MULTI-TEAM MODE
${masterEpicContext}
${archBriefSection}
${radiographySection}
## Epic: ${epic.id} - ${epic.title}
**Complexity**: ${epic.estimatedComplexity}
**Target**: ${repoTypeEmoji} ${targetRepo} (${repoType})
**Branch**: ${branchName || `epic/${epic.id}`}

## Workspace: ${workspacePath}/${targetRepo}
${repoInfo}
${repoGuidance}

## 📋 EPIC SPECIFICATION (FROM PLANNING - FOLLOW EXACTLY!)

**CRITICAL: Planning has already defined the scope of this epic. You MUST follow it!**

${epic.stories?.length > 0 ? `### Pre-Defined Stories (IMPLEMENT THESE EXACTLY):
${epic.stories.map((s: any, i: number) => `
**Story ${i + 1}: ${s.id || s.title}**
- Title: ${s.title || 'N/A'}
- Description: ${s.description || 'N/A'}
${s.acceptanceCriteria?.length > 0 ? `- Acceptance Criteria:\n${s.acceptanceCriteria.map((ac: string) => `  • ${ac}`).join('\n')}` : ''}
`).join('\n')}
` : ''}

### File Guidance (MANDATORY):
${epic.filesToModify?.length > 0 ? `**FILES TO MODIFY (EXISTING):** ${epic.filesToModify.join(', ')}` : '**FILES TO MODIFY:** None specified'}
${epic.filesToCreate?.length > 0 ? `**FILES TO CREATE (NEW):** ${epic.filesToCreate.join(', ')}` : '**FILES TO CREATE:** [] (DO NOT create new files - only modify existing!)'}
${epic.filesToRead?.length > 0 ? `**FILES TO READ (for context):** ${epic.filesToRead.join(', ')}` : ''}

${epic.followsPatterns ? `### Architecture Pattern (MANDATORY):
**${epic.followsPatterns}**

You MUST follow this pattern. The Judge will REJECT any plan that deviates from it.
` : ''}

${epic.technicalNotes ? `### Technical Notes:
${epic.technicalNotes}
` : ''}

---

## 🔍 VALIDATE THE EPIC (DO THIS FIRST!)

**The epic has pre-defined stories above. Your job is to:**
1. **VERIFY** the stories are complete (add missing details if needed)
2. **EXPAND** only if the stories are too shallow (add acceptance criteria, file targets)
3. **DO NOT** change the architecture approach (follow filesToModify/filesToCreate)

### ⚠️ JUDGE WILL REJECT IF:
- You create files when \`filesToCreate: []\` (empty)
- You create a new model when epic says "modify existing model"
- You ignore the \`followsPatterns\` directive

### ✅ JUDGE WILL APPROVE IF:
- Stories match the epic's pre-defined scope
- Files modified/created match the epic's guidance
- Architecture follows the specified pattern

## 🎯 INSTRUCTIONS:
1. EXPLORE codebase (max 2 min): cd ${workspacePath}/${targetRepo} && find src
2. **DISCOVER PATTERNS**: Grep("createProject|createUser|new Project") to find existing helpers
3. **CRITICAL**: Only create stories appropriate for ${repoType} repository
4. BREAK INTO 2-5 STORIES (each 1-3 hours work) - include PATTERNS TO USE in each story
5. ASSIGN DEVELOPERS (1 dev per story)

## 🔧 STORY DESCRIPTIONS MUST INCLUDE:
- 🔧 **PATTERNS TO USE**: Which existing functions to use (e.g., "Use createProject() NOT new Project()")
- ⚠️ **ANTI-PATTERNS TO AVOID**: What NOT to do (code that compiles but won't work)

## JSON OUTPUT ONLY:
\`\`\`json
{
  "epics": [{
    "id": "${epic.id}",
    "name": "${epic.title}",
    "description": "Architecture",
    "branchName": "${branchName || `epic/${epic.id}`}",
    "targetRepository": "${targetRepo}",
    "stories": [
      {
        "id": "${epic.id}-story-1",
        "title": "Story title",
        "description": "Technical details: Functions/APIs to implement, 🔧 PATTERNS TO USE, ⚠️ ANTI-PATTERNS TO AVOID",
        "epicId": "${epic.id}",
        "priority": 1,
        "estimatedComplexity": "simple|moderate|complex",
        "dependencies": [],
        "status": "pending",
        "filesToRead": ["real/path.ts"],
        "filesToModify": ["real/path2.ts"],
        "filesToCreate": ["real/new.ts"],
        "acceptanceCriteria": [
          "Given X, When Y, Then Z",
          "Given A, When B, Then C"
        ]
      }
    ],
    "status": "pending"
  }],
  "architectureDesign": "Technical design",
  "teamComposition": {"developers": 1, "reasoning": "1 story = 1 developer (1:1 rule)"},
  "storyAssignments": [
    {"storyId": "${epic.id}-story-1", "assignedTo": "dev-1"}
  ]
}
\`\`\`

**⚠️ REQUIRED FIELDS (Judge will reject if missing):**
- \`acceptanceCriteria\`: Array of Given/When/Then statements (REQUIRED)
- \`filesToModify\` or \`filesToCreate\`: At least one must have files (REQUIRED)

**🔥🔥🔥 CRITICAL RULES 🔥🔥🔥**
1. **1 DEV = 1 STORY**: Number of developers = Number of stories
2. **NO FILE OVERLAPS**: Each file in only ONE story (prevents merge conflicts)

Explore first, then output JSON.`;
  }

  /**
   * ⚖️ TECHLEAD JUDGE: AI-powered evaluation of TechLead's work
   *
   * This Judge uses AI (haiku - cheap) to ACTUALLY EVALUATE:
   * - Is the architecture coherent and appropriate?
   * - Does the tech stack make sense for the project?
   * - Do the stories fully cover the epic requirements?
   * - Are dependencies correctly defined?
   * - Is there anything obviously wrong or missing?
   *
   * First does fast programmatic checks (fail fast, no cost).
   * Then uses AI to evaluate the quality of the work.
   */
  private async judgeTechLeadOutput(
    parsed: any,
    epicContext: any,
    taskId: string,
    task?: any
  ): Promise<{
    approved: boolean;
    reason?: string;
    feedback?: string;
    storiesCount: number;
    epicsCount: number;
    aiEvaluation?: {
      verdict: 'APPROVE' | 'REJECT';
      reasoning: string;
      issues: string[];
      suggestions: string[];
      score: number; // 0-100
    };
  }> {
    const epics = parsed.epics || [];
    const allStories = epics.flatMap((e: any) => e.stories || []);
    const epicContextTitle = epicContext?.title || epicContext?.name || 'all epics';

    AgentActivityService.emitMessage(taskId, 'TechLead-Judge', `⚖️ Starting AI evaluation for: "${epicContextTitle}"`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: Fast programmatic checks (fail fast, no AI cost)
    // ═══════════════════════════════════════════════════════════════════
    AgentActivityService.emitToolUse(taskId, 'TechLead-Judge', 'BasicChecks', {
      phase: 'Fast validation',
      epicsCount: epics.length,
      storiesCount: allStories.length,
    });

    // Basic existence checks
    if (epics.length === 0) {
      AgentActivityService.emitError(taskId, 'TechLead-Judge', '❌ FAST CHECK FAILED: No epics');
      return { approved: false, reason: 'No epics created', storiesCount: 0, epicsCount: 0 };
    }
    if (allStories.length === 0) {
      AgentActivityService.emitError(taskId, 'TechLead-Judge', '❌ FAST CHECK FAILED: No stories');
      return { approved: false, reason: 'No stories created', storiesCount: 0, epicsCount: epics.length };
    }
    if (!parsed.architectureDesign) {
      AgentActivityService.emitError(taskId, 'TechLead-Judge', '❌ FAST CHECK FAILED: No architecture');
      return { approved: false, reason: 'Missing architectureDesign', storiesCount: allStories.length, epicsCount: epics.length };
    }
    if (!parsed.teamComposition?.developers) {
      AgentActivityService.emitError(taskId, 'TechLead-Judge', '❌ FAST CHECK FAILED: No team composition');
      return { approved: false, reason: 'Missing teamComposition.developers', storiesCount: allStories.length, epicsCount: epics.length };
    }

    AgentActivityService.emitMessage(taskId, 'TechLead-Judge', `✅ Basic checks passed - proceeding to AI evaluation WITH TOOLS`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: AI Evaluation AS AGENT (with Read, Glob, Grep tools!)
    // 🔥 CRITICAL: Judge MUST have same tools as TechLead Agent
    // Without tools, Judge cannot verify if file paths exist or read code
    // ═══════════════════════════════════════════════════════════════════

    AgentActivityService.emitToolUse(taskId, 'TechLead-Judge', 'AIEvaluation', {
      phase: 'AI-powered quality assessment WITH TOOLS',
      evaluating: ['architecture', 'tech stack', 'story coverage', 'dependencies', 'file paths'],
      hasTools: true,
    });

    // Get workspace path for Judge to read files
    const workspacePath = task?.orchestration?.workspacePath || process.cwd();
    const repositories = task?.repositories || [];

    // Determine if this is a multi-epic task
    const totalEpicsInTask = task?.orchestration?.planning?.epics?.length || 1;
    const currentEpicIndex = epicContext ? (task?.orchestration?.planning?.epics?.findIndex((e: any) => e.id === epicContext.id) + 1) || 1 : 1;

    // 🏛️ UNIFIED: Use JudgePhase.evaluateWithType() for consistent judge execution
    const judgePhase = new JudgePhase(this.executeAgentFn);
    const judgeResult = await judgePhase.evaluateWithType({
      type: 'tech-lead',
      workspacePath,
      taskId,
      repositories,
      taskTitle: task?.title,
      taskDescription: task?.description,
      epicContext,
      architectureOutput: parsed,
      totalEpicsInTask,
      currentEpicIndex,
    });

    // Emit detailed evaluation results
    AgentActivityService.emitToolUse(taskId, 'TechLead-Judge', 'AIVerdict', {
      verdict: judgeResult.approved ? 'APPROVE' : 'REJECT',
      score: judgeResult.score,
      filesVerified: judgeResult.filesVerified?.length || 0,
      issuesCount: judgeResult.issues?.length || 0,
      cost: `$${judgeResult.cost?.toFixed(4) || '?'}`,
    });

    // Emit reasoning
    AgentActivityService.emitMessage(taskId, 'TechLead-Judge',
      `🤖 Judge Evaluation (score: ${judgeResult.score || 0}/100):\n` +
      `${judgeResult.feedback}\n\n` +
      (judgeResult.filesVerified && judgeResult.filesVerified.length > 0 ? `📁 Files Verified: ${judgeResult.filesVerified.slice(0, 5).join(', ')}${judgeResult.filesVerified.length > 5 ? '...' : ''}\n` : '') +
      (judgeResult.issues && judgeResult.issues.length > 0 ? `\n❌ Issues:\n${judgeResult.issues.map((i: string) => `  • ${i}`).join('\n')}` : '') +
      (judgeResult.suggestions && judgeResult.suggestions.length > 0 ? `\n💡 Suggestions:\n${judgeResult.suggestions.map((s: string) => `  • ${s}`).join('\n')}` : '')
    );

    // Approval requires both approved status AND score >= 60
    const approved = judgeResult.approved && (judgeResult.score || 0) >= 60;

    if (approved) {
      AgentActivityService.emitMessage(taskId, 'TechLead-Judge', `✅ APPROVED with score ${judgeResult.score}/100`);
    } else {
      AgentActivityService.emitError(taskId, 'TechLead-Judge',
        `❌ REJECTED (score: ${judgeResult.score}/100)\n` +
        `Reason: ${judgeResult.feedback}\n` +
        `Issues: ${judgeResult.issues?.join(', ')}`
      );
    }

    return {
      approved,
      reason: approved ? undefined : judgeResult.feedback,
      feedback: approved ? undefined : (judgeResult.issues || []).concat(judgeResult.suggestions || []).join('\n'),
      storiesCount: allStories.length,
      epicsCount: epics.length,
      aiEvaluation: {
        verdict: judgeResult.approved ? 'APPROVE' : 'REJECT',
        reasoning: judgeResult.feedback,
        issues: judgeResult.issues || [],
        suggestions: judgeResult.suggestions || [],
        score: judgeResult.score || 0,
      },
    };
  }

  /**
   * Generate repository-specific pattern discovery commands
   * Shows relevant search patterns based on repo type
   */
  private getPatternDiscoveryCommands(repositories: any[]): string {
    const hasBackend = repositories.some(r => r.type === 'backend');
    const hasFrontend = repositories.some(r => r.type === 'frontend');

    let commands = '```bash\n';

    if (hasBackend) {
      commands += `# 🔧 BACKEND helper functions for entity creation:
Grep("createProject|createUser|createTeam|new Project")
Grep("export.*function.*create|export.*class.*Service")
`;
    }

    if (hasFrontend) {
      commands += `# 🎨 FRONTEND patterns (hooks, contexts, services):
Grep("export.*function.*use[A-Z]|export.*const.*use[A-Z]")  # Custom hooks
Grep("createContext|useContext")  # Context patterns
Grep("export.*api|export.*fetch|axios")  # API service patterns
`;
    }

    commands += '```';
    return commands;
  }

  /**
   * Generate repository-specific file overlap examples
   * Shows frontend examples for frontend repos, backend for backend repos
   */
  private getFileOverlapExamples(repositories: any[]): string {
    const hasBackend = repositories.some(r => r.type === 'backend');
    const hasFrontend = repositories.some(r => r.type === 'frontend');

    if (hasFrontend && !hasBackend) {
      // Frontend only
      return `  story-1: filesToModify: ["src/components/UserList.tsx"]
  story-2: filesToModify: ["src/components/ProductList.tsx"]`;
    } else if (hasBackend && !hasFrontend) {
      // Backend only
      return `  story-1: filesToModify: ["src/routes/users.ts"]
  story-2: filesToModify: ["src/routes/products.ts"]`;
    } else {
      // Both or unknown - show mixed examples
      return `  story-1: filesToModify: ["src/routes/users.ts"]  ← backend story
  story-2: filesToModify: ["src/components/UserList.tsx"]  ← frontend story`;
    }
  }

  /**
   * Helper to restore TechLead data from task or EventStore for recovery
   */
  private async restoreTechLeadData(context: OrchestrationContext): Promise<void> {
    const techLead = context.task.orchestration.techLead;

    // Restore output if available
    if (techLead?.output) {
      context.setData('techLeadOutput', techLead.output);
    }

    // Restore storyAssignments if available
    if (techLead?.storyAssignments) {
      context.setData('storyAssignments', techLead.storyAssignments);
    }

    // Restore teamComposition if available
    if (techLead?.teamComposition) {
      context.setData('teamComposition', techLead.teamComposition);
    }

    // Restore architectureDesign if available
    if (techLead?.architectureDesign) {
      context.setData('architectureDesign', techLead.architectureDesign);
    }

    // Try to restore epics and storiesMap from EventStore
    try {
      const { eventStore } = await import('../EventStore');
      const events = await eventStore.getEvents(context.task._id as any);

      const epicEvents = events.filter((e: any) => e.eventType === 'EpicCreated');
      const storyEvents = events.filter((e: any) => e.eventType === 'StoryCreated');
      const teamEvent = events.find((e: any) => e.eventType === 'TeamCompositionDefined');

      if (epicEvents.length > 0) {
        const epics = epicEvents.map((e: any) => e.payload);
        context.setData('epics', epics);
        console.log(`   🔄 Restored ${epics.length} epic(s) from EventStore`);
      }

      if (storyEvents.length > 0) {
        const storiesMap: { [id: string]: any } = {};
        storyEvents.forEach((e: any) => {
          storiesMap[e.payload.id] = e.payload;
        });
        context.setData('storiesMap', storiesMap);
        console.log(`   🔄 Restored ${Object.keys(storiesMap).length} stories from EventStore`);

        // Also rebuild storyAssignments if not in DB
        if (!techLead?.storyAssignments || techLead.storyAssignments.length === 0) {
          const storyAssignments = storyEvents
            .filter((e: any) => e.payload.assignedTo)
            .map((e: any) => ({ storyId: e.payload.id, assignedTo: e.payload.assignedTo }));
          context.setData('storyAssignments', storyAssignments);
          console.log(`   🔄 Rebuilt ${storyAssignments.length} story assignments from EventStore`);
        }
      }

      if (teamEvent && !techLead?.teamComposition) {
        context.setData('teamComposition', teamEvent.payload);
        console.log(`   🔄 Restored teamComposition from EventStore: ${teamEvent.payload.developers} devs`);
      }
    } catch (error: any) {
      console.log(`   ⚠️ EventStore recovery failed: ${error.message}`);
    }
  }
}
