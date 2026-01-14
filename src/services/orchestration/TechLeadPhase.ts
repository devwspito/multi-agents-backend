import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { hasMarker, extractMarkerValue } from './utils/MarkerValidator';
import { RealisticCostEstimator } from '../RealisticCostEstimator';
import { CryptoService } from '../CryptoService';

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
      console.log(`🔄 [TechLead] This is a CONTINUATION - will re-execute with additional requirements`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.techLead?.status === 'completed') {
      console.log(`[SKIP] Tech Lead already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution for next phases
      if (context.task.orchestration.techLead.output) {
        context.setData('techLeadOutput', context.task.orchestration.techLead.output);
      }
      // TODO: Add epics and storiesMap to IAgentStep if needed
      // if (context.task.orchestration.techLead.epics) {
      //   context.setData('epics', context.task.orchestration.techLead.epics);
      // }
      // if (context.task.orchestration.techLead.storiesMap) {
      //   context.setData('storiesMap', context.task.orchestration.techLead.storiesMap);
      // }

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

    // 🔥 MULTI-TEAM MODE: Check if we're in team mode BEFORE updating task
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    // Update task status (skip in multi-team mode to avoid conflicts)
    const startTime = new Date();
    if (!multiTeamMode) {
      task.orchestration.techLead.status = 'in_progress';
      task.orchestration.techLead.startedAt = startTime;
      await task.save();
    }

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Tech Lead');

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

            return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})${isDefault}
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}
   - Execution Order: ${repo.executionOrder || 'not set'}${envVarsSection}`;
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
        }
      }

      const projectId = task.projectId?.toString() || '';
      const memoryContext = `
## 🧠 MEMORY CONTEXT (Use these IDs for memory tools)
- **Project ID**: \`${projectId}\`
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

      const prompt = multiTeamMode ? this.buildMultiTeamPrompt(teamEpic, repoInfo, workspaceInfo, workspacePath || process.cwd(), firstRepoName, epicBranch, masterEpic, context.repositories, architectureBrief) : `${retrySection}Act as the tech-lead agent.
${memoryContext}
${architectureBriefSection}
# Architecture & Planning
${revisionSection}
## Task: ${task.title}
${task.description ? `Description: ${task.description}` : ''}

## Workspace: ${workspacePath}
${repoInfo}

## 🎯 INSTRUCTIONS (Be concise and efficient):

1. **EXPLORE** (max 3 minutes): Scan codebase structure to find real file paths
2. **DISCOVER PATTERNS**: Search for existing helper functions (createProject, createUser, etc.)
3. **CREATE 2-4 EPICS**: Major feature groups
4. **CREATE 3-5 STORIES PER EPIC**: Each 1-3 hours of work with PATTERNS included

## 🔍 MANDATORY: PATTERN DISCOVERY (Before Creating Stories)
\`\`\`bash
# Find existing helper functions for entity creation:
Grep("createProject|createUser|createTeam|new Project")
Grep("export.*function.*create|export.*class.*Service")
\`\`\`
**If you find createX() functions, stories MUST tell developers to use them instead of new Model().**

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
  story-1: filesToModify: ["src/routes/users.ts"]
  story-2: filesToModify: ["src/routes/products.ts"]

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

      // Execute agent
      const result = await this.executeAgentFn(
        'tech-lead',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Tech Lead',
        undefined, // resumeSessionId
        undefined, // forkSession
        attachments.length > 0 ? attachments : undefined // Pass attachments
      );

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
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TechLeadCompleted',
        agentName: 'tech-lead',
        payload: {
          output: result.output,
          epicsCount: parsed.epics.length,
          storiesCount: Object.keys(storiesMap).length,
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
  private buildMultiTeamPrompt(epic: any, repoInfo: string, _workspaceInfo: string, workspacePath: string, _firstRepo?: string, branchName?: string, masterEpic?: any, repositories?: any[], architectureBrief?: any): string {
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

    return `TECH LEAD - MULTI-TEAM MODE
${masterEpicContext}
${archBriefSection}
## Epic: ${epic.id} - ${epic.title}
**Complexity**: ${epic.estimatedComplexity}
**Target**: ${repoTypeEmoji} ${targetRepo} (${repoType})
**Branch**: ${branchName || `epic/${epic.id}`}

## Workspace: ${workspacePath}/${targetRepo}
${repoInfo}
${repoGuidance}

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
        "description": "Complete with: Acceptance Criteria, Files, Functions/APIs, 🔧 PATTERNS TO USE, ⚠️ ANTI-PATTERNS TO AVOID, Tests, Done criteria",
        "epicId": "${epic.id}",
        "priority": 1,
        "estimatedComplexity": "simple|moderate|complex",
        "dependencies": [],
        "status": "pending",
        "filesToRead": ["real/path.ts"],
        "filesToModify": ["real/path2.ts"],
        "filesToCreate": ["real/new.ts"]
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

**🔥🔥🔥 CRITICAL RULES 🔥🔥🔥**
1. **1 DEV = 1 STORY**: Number of developers = Number of stories
2. **NO FILE OVERLAPS**: Each file in only ONE story (prevents merge conflicts)

Explore first, then output JSON.`;
  }
}
