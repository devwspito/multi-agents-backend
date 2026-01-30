import { BasePhase, OrchestrationContext, PhaseResult, updateTaskFireAndForget } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { getRoleInstructions } from '../../agents/ReadmeSystem';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { AgentActivityService } from '../AgentActivityService';
import { hasMarker, extractMarkerValue } from './utils/MarkerValidator';
import { RealisticCostEstimator } from '../RealisticCostEstimator';
import { CryptoService } from '../CryptoService';
import { ProjectRadiographyService, ProjectRadiography } from '../ProjectRadiographyService';
import { JudgePhase } from './JudgePhase';
import { sessionCheckpointService } from '../SessionCheckpointService';
// 🔥 REMOVED: granularMemoryService - SQLite (UnifiedMemoryService) is the single source of truth
import { AgentArtifactService } from '../AgentArtifactService';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 🏊 SANDBOX POOL - Intelligent sandbox reuse with conflict detection
import { sandboxPoolService } from '../SandboxPoolService';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { logSection } from './utils/LogHelpers';
import { isEmpty } from './utils/ArrayHelpers';
import { getEpicId, getStoryId, validateStoryIds } from './utils/IdNormalizer';
// 📦 Reusable Prompt Sections
import {
  SCOPE_BOUNDARY_SECTION,
  NO_PLACEHOLDERS_SECTION,
  ONE_DEV_ONE_STORY_SECTION,
  DECOMPOSITION_METHODOLOGY_SECTION,
} from '../../prompts/sections';

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
   * 🎯 UNIFIED MEMORY: Skip if Tech Lead already completed
   *
   * In multi-team mode, each team has its OWN epic.
   * UnifiedMemoryService tracks completion per-epic via markEpicTechLeadCompleted.
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const taskId = this.getTaskIdString(context);
    const teamEpic = context.getData<any>('teamEpic');

    // Multi-team mode: check epic-specific completion
    if (teamEpic) {
      console.log(`\n🎯 [TechLead.shouldSkip] Multi-team mode - Epic: ${teamEpic.id}`);

      // Check if THIS SPECIFIC EPIC's TechLead was completed
      const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
      const epicData = resumption?.executionMap?.epics?.find(
        (e: any) => e.epicId === teamEpic.id && e.techLeadCompleted
      );

      if (epicData) {
        logSection(`🎯 [UNIFIED MEMORY] TechLead for epic ${teamEpic.id} already COMPLETED`);
        // Restore stories if available
        await this.restoreStoriesOnSkip(context, epicData.stories);
        return true;
      }

      console.log(`   ❌ Epic TechLead not completed - must execute`);
      return false;
    }

    // Single-team mode: use centralized skip logic
    const skipResult = await checkPhaseSkip(context, { phaseName: 'TechLead' });

    if (skipResult.shouldSkip) {
      await this.restoreTechLeadData(context);
      return true;
    }

    console.log(`   ⏳ Phase pending - TechLead must execute`);
    return false;
  }

  /**
   * Restore ALL data when skipping due to epic completion (multi-team mode)
   *
   * 🔥 CRITICAL FIX: Must restore storyAssignments and teamComposition
   * Otherwise DevelopersPhase won't know which developers to spawn
   */
  private async restoreStoriesOnSkip(
    context: OrchestrationContext,
    epicStories?: Array<{ storyId: string; title: string; developerId?: string; status?: string }>
  ): Promise<void> {
    const taskId = this.getTaskIdString(context);
    const teamEpic = context.getData<any>('teamEpic');

    console.log(`\n🔄 [TechLead.restoreStoriesOnSkip] Restoring data for epic: ${teamEpic?.id || 'unknown'}`);

    // 1. Restore stories
    if (!isEmpty(epicStories)) {
      const stories = epicStories!.map(s => ({ id: s.storyId, title: s.title }));
      context.setData('stories', stories);
      console.log(`   ✅ Restored ${stories.length} stories`);

      // 2. Build storyAssignments from epicStories if developerId is available
      const storyAssignments = epicStories!
        .filter(s => s.developerId)
        .map(s => ({ storyId: s.storyId, assignedTo: s.developerId }));

      if (storyAssignments.length > 0) {
        context.setData('storyAssignments', storyAssignments);
        console.log(`   ✅ Restored ${storyAssignments.length} story assignments from epicStories`);
      }
    }

    // 3. Restore teamComposition from UnifiedMemory (CRITICAL for DevelopersPhase)
    try {
      const teamComp = await unifiedMemoryService.getTeamComposition(taskId);
      if (teamComp) {
        context.setData('teamComposition', teamComp);
        console.log(`   ✅ Restored teamComposition: ${teamComp.developers} developers`);
      } else {
        console.warn(`   ⚠️ No teamComposition found in UnifiedMemory`);
      }
    } catch (error: any) {
      console.warn(`   ⚠️ Failed to restore teamComposition: ${error.message}`);
    }

    // 4. Restore storyAssignments from UnifiedMemory if not already restored
    if (!context.getData<any[]>('storyAssignments') || context.getData<any[]>('storyAssignments')!.length === 0) {
      try {
        const assignments = await unifiedMemoryService.getStoryAssignments(taskId);
        if (assignments.length > 0) {
          // Filter to only this epic's stories if in multi-team mode
          const epicStoryIds = new Set(epicStories?.map(s => s.storyId) || []);
          const filteredAssignments = epicStoryIds.size > 0
            ? assignments.filter((a: { storyId: string }) => epicStoryIds.has(a.storyId))
            : assignments;

          context.setData('storyAssignments', filteredAssignments);
          console.log(`   ✅ Restored ${filteredAssignments.length} story assignments from UnifiedMemory`);
        } else {
          console.warn(`   ⚠️ No storyAssignments found in UnifiedMemory`);
        }
      } catch (error: any) {
        console.warn(`   ⚠️ Failed to restore storyAssignments: ${error.message}`);
      }
    }

    // 5. Fallback: Try EventStore for TeamCompositionDefined event
    if (!context.getData<any>('teamComposition') || !context.getData<any[]>('storyAssignments')) {
      try {
        const { eventStore } = await import('../EventStore');
        const events = await eventStore.getEvents(context.task.id as any);

        // Find TeamCompositionDefined for this epic
        const teamEvents = events.filter((e: any) =>
          e.eventType === 'TeamCompositionDefined' &&
          (!teamEpic || e.payload.epicId === teamEpic.id)
        );

        if (teamEvents.length > 0) {
          const teamEvent = teamEvents[teamEvents.length - 1]; // Use latest

          if (!context.getData<any>('teamComposition') && teamEvent.payload.developers) {
            context.setData('teamComposition', { developers: teamEvent.payload.developers });
            console.log(`   ✅ Restored teamComposition from EventStore: ${teamEvent.payload.developers} developers`);
          }

          if ((!context.getData<any[]>('storyAssignments') || context.getData<any[]>('storyAssignments')!.length === 0)
              && teamEvent.payload.storyAssignments) {
            context.setData('storyAssignments', teamEvent.payload.storyAssignments);
            console.log(`   ✅ Restored ${teamEvent.payload.storyAssignments.length} story assignments from EventStore`);
          }
        }
      } catch (error: any) {
        console.warn(`   ⚠️ EventStore fallback failed: ${error.message}`);
      }
    }

    // Final validation
    const finalAssignments = context.getData<any[]>('storyAssignments') || [];
    const finalComposition = context.getData<any>('teamComposition');

    if (finalAssignments.length === 0) {
      console.error(`   ❌ CRITICAL: No storyAssignments restored - DevelopersPhase will fail!`);
    }
    if (!finalComposition) {
      console.error(`   ❌ CRITICAL: No teamComposition restored - DevelopersPhase will fail!`);
    }

    console.log(`   📊 Final state: ${finalAssignments.length} assignments, ${finalComposition?.developers || 0} developers\n`);
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();
    const taskShortId = taskId.substring(0, 8); // For branch naming
    const workspacePath = context.workspacePath;
    const workspaceStructure = context.getData<string>('workspaceStructure') || '';

    // 🔥 MULTI-TEAM MODE: Check if we're in team mode BEFORE updating task
    const teamEpic = context.getData<any>('teamEpic');
    const multiTeamMode = !!teamEpic;

    // Update task status - 🔥 ALWAYS use atomic updates to avoid version conflicts
    const startTime = new Date();

    // 🔥 FIRE-AND-FORGET: Non-blocking update to avoid bottleneck
    updateTaskFireAndForget(task.id, {
      $set: {
        'orchestration.techLead.agent': 'tech-lead',
        'orchestration.techLead.status': 'in_progress',
        'orchestration.techLead.startedAt': startTime,
      },
    }, 'techLead in_progress');

    // Update in-memory object for subsequent code
    if (!task.orchestration.techLead) {
      task.orchestration.techLead = { agent: 'tech-lead', status: 'pending' } as any;
    }
    task.orchestration.techLead.status = 'in_progress';
    task.orchestration.techLead.startedAt = startTime;

    console.log(`📝 [TechLead] Initialized orchestration.techLead atomically${multiTeamMode ? ' (multi-team mode)' : ''}`);

    // 🔥 CRITICAL: Reload task to get latest version to avoid future conflicts
    const freshTask = TaskRepository.findById(task.id);
    if (freshTask) {
      Object.assign(task, freshTask);
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

        // 🐳 SANDBOX: Get sandbox ID for Docker execution
        const sandboxMap = context.getData<Map<string, string>>('sandboxMap');
        const sandboxId = sandboxMap?.get(targetRepo);
        if (sandboxId) {
          console.log(`   🐳 Sandbox: ${sandboxId}`);
        }
        // Store sandboxId in closure for later use in executeAgentFn
        context.setData('techLeadSandboxId', sandboxId);
      }

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

      // 🔥 SIMPLIFIED: Single unified prompt (always multi-team, sequential execution)
      const prompt = this.buildPrompt(teamEpic, repoInfo, workspaceInfo, workspacePath || process.cwd(), firstRepoName, epicBranch, masterEpic, context.repositories, architectureBrief, projectRadiographies, retrySection);

      // 🔥 CRITICAL: Retrieve processed attachments from context (shared from Planning phase)
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

      // 🐳 SANDBOX: Get sandbox ID for Docker execution (stored earlier in multi-team mode)
      const techLeadSandboxId = context.getData<string | undefined>('techLeadSandboxId');

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
        techLeadSandboxId ? { sandboxId: techLeadSandboxId } : undefined, // 🐳 options with sandboxId
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
        const error = new Error(`Tech Lead did not return valid epics array. Marker: ${architectureComplete ? 'FOUND' : 'MISSING'}`);
        (error as any).retryable = true;
        (error as any).violationType = 'INVALID_EPICS_ARRAY';
        throw error;
      }

      if (parsed.epics.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty epics array');
        const error = new Error('Tech Lead returned empty epics array - cannot proceed with development');
        (error as any).retryable = true;
        (error as any).violationType = 'EMPTY_EPICS_ARRAY';
        throw error;
      }

      // Validate storyAssignments[] exists (critical for developers)
      if (!parsed.storyAssignments || !Array.isArray(parsed.storyAssignments)) {
        console.log('\n🔍 [TechLead] Missing storyAssignments in output');
        const error = new Error('Tech Lead did not return storyAssignments array - developers need file paths');
        (error as any).retryable = true;
        (error as any).violationType = 'MISSING_STORY_ASSIGNMENTS';
        throw error;
      }

      if (parsed.storyAssignments.length === 0) {
        console.log('\n⚠️  [TechLead] Agent returned empty storyAssignments array');
        const error = new Error('Tech Lead returned empty storyAssignments - developers need work assignments');
        (error as any).retryable = true;
        (error as any).violationType = 'EMPTY_STORY_ASSIGNMENTS';
        throw error;
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
        const epicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer for consistent ID
        epic.stories.forEach((story: any) => {
          storiesMap[getStoryId(story)] = {
            id: getStoryId(story), // 🔥 CENTRALIZED: Use IdNormalizer
            title: story.title,
            description: story.description,
            epicId: epicId, // 🔥 CENTRALIZED: Use normalized epicId
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

      // 🔥 CRITICAL: VALIDATE and INHERIT targetRepository AND epicId for multi-team mode
      if (multiTeamMode && teamEpic) {
        console.log(`\n🔍 [TechLead] Validating and normalizing epics for multi-team mode...`);
        const teamEpicId = getEpicId(teamEpic); // Original ID from Planning

        for (const epic of parsed.epics) {
          // 🔥🔥🔥 CRITICAL FIX: Override agent-generated epicId with original Planning epicId
          // Without this, registerStories() fails because IDs don't match
          // Agent may generate "epic-1" but Planning registered "epic-backend-foundation"
          const agentEpicId = epic.id;
          if (agentEpicId !== teamEpicId) {
            console.log(`   🔄 [TechLead] Overriding agent epicId: "${agentEpicId}" → "${teamEpicId}"`);
            epic.id = teamEpicId;
            // Also update story epicIds to match
            for (const story of (epic.stories || [])) {
              if (story.epicId && story.epicId !== teamEpicId) {
                story.epicId = teamEpicId;
              }
            }
          }

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

        await eventStore.safeAppend({
          taskId: task.id as any,
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
        const normalizedEpicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer
        for (const story of epic.stories) {
          const normalizedStoryId = getStoryId(story);

          // 🔥🔥🔥 CRITICAL: TechLead creates story branch name BEFORE Developer starts 🔥🔥🔥
          // This ensures: 1) No race conditions 2) Developer knows exactly which branch to use
          const storySlug = story.title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 30);
          const storyHash = normalizedStoryId.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString(36).slice(-6);
          const storyBranchName = `story/${taskShortId}-${storySlug}-${storyHash}`;

          console.log(`   🌿 [TechLead] Assigned branch for story "${story.title}": ${storyBranchName}`);

          // Save to UnifiedMemoryService BEFORE emitting event
          unifiedMemoryService.saveStoryBranch(taskId, normalizedStoryId, storyBranchName);

          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryCreated',
            agentName: 'tech-lead',
            payload: {
              id: normalizedStoryId, // 🔥 CENTRALIZED: Use IdNormalizer
              epicId: normalizedEpicId, // 🔥 CENTRALIZED: Use normalized epicId
              title: story.title,
              description: story.description,
              priority: story.priority,
              complexity: story.estimatedComplexity,
              estimatedComplexity: story.estimatedComplexity, // For backward compatibility
              assignedTo: parsed.storyAssignments?.find((a: any) => a.storyId === normalizedStoryId)?.assignedTo,
              branchName: storyBranchName, // 🔥 CRITICAL: Branch assigned by TechLead
              filesToRead: story.filesToRead || [],
              filesToModify: story.filesToModify || [],
              filesToCreate: story.filesToCreate || [],
              dependencies: story.dependencies || [],
              targetRepository: epic.targetRepository, // 🔥 INHERIT from epic
            },
          });

          // 🔥 Also emit StoryBranchCreated for explicit branch tracking
          await eventStore.safeAppend({
            taskId: task.id as any,
            eventType: 'StoryBranchCreated',
            agentName: 'tech-lead',
            payload: {
              storyId: normalizedStoryId,
              branchName: storyBranchName,
              createdBy: 'tech-lead', // Flag that TechLead created it
            },
          });
        }
      }

      // Emit team composition event - INCLUDE storyAssignments for multi-team mode
      // 🔥 FIX Bug #10: Include epicId for proper filtering in recovery
      // Note: teamEpic is already declared at line ~108 in this function
      await eventStore.safeAppend({
        taskId: task.id as any,
        eventType: 'TeamCompositionDefined',
        agentName: 'tech-lead',
        payload: {
          ...parsed.teamComposition,
          epicId: teamEpic?.id || null,  // 🔥 FIX Bug #10: Tag event with epicId
          storyAssignments: parsed.storyAssignments || [],  // 🔥 FIX Bug #10: Include assignments
        },
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
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'EnvironmentConfigDefined',
          agentName: 'tech-lead',
          payload: parsed.environmentConfig,
        });

        // Store in task.orchestration for persistence (survives server restart)
        task.orchestration.environmentConfig = parsed.environmentConfig;
        // SQLite: No need for markModified, just update the task
        TaskRepository.modifyOrchestration(task.id, (orch) => ({
          ...orch,
          environmentConfig: parsed.environmentConfig,
        }));

        console.log(`✅ [TechLead] EnvironmentConfigDefined event emitted + stored in task`);
      } else {
        console.log(`⚠️  [TechLead] No environmentConfig in output - using defaults`);
      }

      // ⚖️ TECHLEAD JUDGE: Validate stories cover the EPIC (not the full requirement)
      // This is different from Supervisor - we only check if THIS epic is well broken down
      // 🔥 FIX: Pass workspacePath and repositories directly (context.workspacePath, context.repositories)
      //    Previously used task.orchestration?.workspacePath which was null, causing fallback to process.cwd()
      // 🐳 SANDBOX: Get sandbox ID for Docker execution
      const judgeSandboxId = context.getData<string | undefined>('techLeadSandboxId');
      const techLeadJudgeResult = await this.judgeTechLeadOutput(
        parsed,
        multiTeamMode ? teamEpic : null,
        taskId,
        task,
        workspacePath || process.cwd(),  // Use context.workspacePath from line 217
        context.repositories,            // Use context.repositories directly
        judgeSandboxId                   // 🐳 Explicit sandbox ID for Docker execution
      );

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

      // Store epics with string IDs for compatibility
      const epicsWithStringIds = parsed.epics.map((epic: any) => ({
        ...epic,
        stories: epic.stories.map((s: any) => s.id),
        targetRepository: epic.targetRepository || undefined,
      }));

      task.orchestration.techLead.architectureDesign = parsed.architectureDesign;
      task.orchestration.techLead.teamComposition = parsed.teamComposition;
      task.orchestration.techLead.storyAssignments = parsed.storyAssignments;

      // Store agent metadata
      task.orchestration.techLead.status = 'completed';
      task.orchestration.techLead.completedAt = new Date();
      task.orchestration.techLead.output = result.output;
      task.orchestration.techLead.sessionId = result.sessionId;
      task.orchestration.techLead.usage = result.usage;
      task.orchestration.techLead.cost_usd = result.cost;

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

        console.log(`✅ [Cost Estimation] Added to Tech Lead output`);
      } catch (error: any) {
        console.warn(`⚠️  [Cost Estimation] Failed: ${error.message} - Continuing without cost estimate`);
        task.orchestration.techLead.output += `\n\n---\n\n## 💰 Cost Estimate\n\n*Cost estimation unavailable: ${error.message}*`;
      }

      // 🔥 ATOMIC SAVE: Use findByIdAndUpdate to avoid version conflicts
      // This replaces task.save() which fails when document version changes during execution
      const completedAt = new Date();
      const atomicUpdate = {
        $set: {
          'orchestration.techLead.architectureDesign': parsed.architectureDesign,
          'orchestration.techLead.teamComposition': parsed.teamComposition,
          'orchestration.techLead.storyAssignments': parsed.storyAssignments,
          'orchestration.techLead.status': 'completed',
          'orchestration.techLead.completedAt': completedAt,
          'orchestration.techLead.output': task.orchestration.techLead.output,
          'orchestration.techLead.sessionId': result.sessionId,
          'orchestration.techLead.usage': result.usage,
          'orchestration.techLead.cost_usd': result.cost,
        },
        $inc: {
          'orchestration.totalCost': result.cost,
          'orchestration.totalTokens': (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
        },
      };

      updateTaskFireAndForget(task.id, atomicUpdate, 'techLead completed');
      console.log(`📝 [TechLead] Saved completion (fire-and-forget)`);

      // Update in-memory for subsequent code
      task.orchestration.techLead.status = 'completed';
      task.orchestration.techLead.completedAt = completedAt;

      // 📦 GITHUB BACKUP: Save architecture/stories to GitHub
      // MongoDB has the data (above), now push to GitHub for disaster recovery
      try {
        for (const epic of parsed.epics) {
          const epicRepo = epic.targetRepository || context.repositories?.[0]?.name;
          if (epicRepo) {
            // Save architecture/stories artifact
            const artifactResult = await AgentArtifactService.saveTechLeadArtifact(
              workspacePath || process.cwd(),
              epicRepo,
              taskId,
              epic.id,
              parsed.architectureDesign,
              epic.stories || []
            );
            if (artifactResult.success) {
              console.log(`📦 [TechLead] Artifacts saved to GitHub: ${artifactResult.filePath}`);
            }

            // Save Judge evaluation artifact for this epic
            const aiEval = techLeadJudgeResult.aiEvaluation;
            await AgentArtifactService.saveJudgeArtifact(
              workspacePath || process.cwd(),
              epicRepo,
              taskId,
              'techlead',
              epic.id, // entityId is the epic being judged
              {
                verdict: techLeadJudgeResult.approved ? 'approved' : 'rejected',
                score: aiEval?.score,
                feedback: aiEval?.reasoning || checksMessage,
                issues: aiEval?.issues,
                suggestions: aiEval?.suggestions,
              }
            );
            console.log(`📦 [TechLead] Judge evaluation saved to GitHub for epic ${epic.id}`);
          }
        }
      } catch (artifactError: any) {
        // Non-blocking - local save and MongoDB are the source of truth
        console.warn(`⚠️ [TechLead] GitHub backup failed (non-blocking): ${artifactError.message}`);
      }

      console.log(`📝 [TechLead] Emitted ${parsed.epics.length} EpicCreated + ${Object.keys(storiesMap).length} StoryCreated events`);

      // 🔥 CRITICAL FIX: Register stories and mark epic TechLead as completed in Unified Memory
      // This enables proper recovery tracking. Without this, getResumptionPoint() can't know
      // which epics have completed TechLead or what stories exist.
      for (const epic of parsed.epics) {
        const epicId = getEpicId(epic); // 🔥 CENTRALIZED: Use IdNormalizer
        const epicStories = (epic.stories || []).map((s: any) => ({
          id: getStoryId(s), // 🔥 CENTRALIZED: Use IdNormalizer
          title: s.title,
        }));
        // 🔥 VALIDATE: Fail fast if any story has no valid ID
        if (epicStories.length > 0) {
          validateStoryIds(epic.stories);
        }

        if (epicStories.length > 0) {
          await unifiedMemoryService.registerStories(taskId, epicId, epicStories);
          console.log(`📋 [TechLead] Registered ${epicStories.length} stories for epic ${epicId}`);
        }

        await unifiedMemoryService.markEpicTechLeadCompleted(taskId, epicId);
        console.log(`✅ [TechLead] Marked TechLead completed for epic ${epicId}`);

        // 🔥 CRITICAL FIX: Emit TechLeadCompleted event for EACH epic (not just one)
        // Without this, resume will only mark ONE epic as techLeadCompleted
        await eventStore.safeAppend({
          taskId: task.id as any,
          eventType: 'TechLeadCompleted',
          agentName: 'tech-lead',
          payload: {
            output: result.output,
            epicsCount: parsed.epics.length,
            storiesCount: epicStories.length,
            // 🔥 CRITICAL: Include epicId for this specific epic
            epicId,
            multiTeamMode,
          },
          metadata: {
            cost: result.cost ? result.cost / parsed.epics.length : 0, // Distribute cost across epics
            duration: Date.now() - startTime.getTime(),
          },
        });
        console.log(`💾 [TechLead] Emitted TechLeadCompleted event for epic ${epicId}`);
      }

      // 🔥 CRITICAL FOR RECOVERY: Save team composition and story assignments to Unified Memory
      // This ensures we can recreate the team on restart without re-running TechLead
      await unifiedMemoryService.saveTeamComposition(taskId, parsed.teamComposition);
      await unifiedMemoryService.saveStoryAssignments(taskId, parsed.storyAssignments);
      console.log(`💾 [TechLead] Saved team composition and story assignments to Unified Memory`);

      // 🏊 SANDBOX POOL: Update planned files for conflict detection
      // This enables sandbox reuse between tasks working on different files of the same project+repo
      try {
        const allPlannedFiles: string[] = [];
        for (const epic of parsed.epics) {
          for (const story of (epic.stories || [])) {
            if (story.filesToModify) allPlannedFiles.push(...story.filesToModify);
            if (story.filesToCreate) allPlannedFiles.push(...story.filesToCreate);
          }
        }

        if (allPlannedFiles.length > 0) {
          // Get projectId and repoName for pool lookup
          const projectId = task.projectId?.toString() || taskId;
          const primaryRepoName = context.repositories.length > 0
            ? context.repositories[0].name || context.repositories[0].githubRepoName
            : 'default';

          sandboxPoolService.updateTaskFiles(taskId, projectId, primaryRepoName, allPlannedFiles);
          console.log(`🏊 [TechLead] Updated sandbox pool: ${allPlannedFiles.length} planned files for conflict detection`);
        }
      } catch (poolError) {
        // Non-critical: sandbox pool update failure shouldn't break TechLead
        console.warn(`⚠️ [TechLead] Failed to update sandbox pool (non-critical):`, poolError);
      }

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

      // 🔥 REMOVED: granularMemoryService calls - SQLite (task.orchestration) tracks all TechLead state

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

      // 🔥 FIRE-AND-FORGET: Update failure status without blocking
      updateTaskFireAndForget(task.id, {
        $set: {
          'orchestration.techLead.status': 'failed',
          'orchestration.techLead.error': error.message,
        },
      }, 'techLead failed');
      task.orchestration.techLead.status = 'failed';
      task.orchestration.techLead.error = error.message;

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Tech Lead', error.message);

      await LogService.agentFailed('tech-lead', taskId, error, {
        phase: 'architecture',
      });

      // 🔥 EVENT SOURCING: Emit failure event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.safeAppend({
        taskId: task.id as any,
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
   * Build prompt for TechLead (epic breakdown into stories + dev assignment)
   * Includes Master Epic context and Architecture Brief from PlanningPhase
   */
  private buildPrompt(epic: any, repoInfo: string, _workspaceInfo: string, workspacePath: string, _firstRepo?: string, branchName?: string, masterEpic?: any, repositories?: any[], architectureBrief?: any, projectRadiographies?: Map<string, ProjectRadiography>, retrySection?: string): string {
    // 🔥 CRITICAL: Epic MUST have targetRepository - NO FALLBACKS
    if (!epic.targetRepository) {
      console.error(`\n❌❌❌ [TechLead] CRITICAL ERROR: Epic has NO targetRepository!`);
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

    // 🧠 CEREBRO: Inject role consciousness
    const roleInstructions = getRoleInstructions('tech_lead');

    return `${retrySection || ''}${roleInstructions}

---

# TECH LEAD TASK
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

${DECOMPOSITION_METHODOLOGY_SECTION}

${ONE_DEV_ONE_STORY_SECTION}

${SCOPE_BOUNDARY_SECTION}

${NO_PLACEHOLDERS_SECTION}

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
        "title": "First story",
        "description": "Technical details",
        "epicId": "${epic.id}",
        "priority": 1,
        "estimatedComplexity": "simple",
        "dependencies": [],
        "status": "pending",
        "filesToRead": ["src/models/User.ts"],
        "filesToModify": ["src/routes/auth.ts"],
        "filesToCreate": [],
        "acceptanceCriteria": ["Given X, When Y, Then Z"]
      },
      {
        "id": "${epic.id}-story-2",
        "title": "Second story",
        "description": "Technical details",
        "epicId": "${epic.id}",
        "priority": 2,
        "estimatedComplexity": "moderate",
        "dependencies": [],
        "status": "pending",
        "filesToRead": [],
        "filesToModify": ["src/services/auth.ts"],
        "filesToCreate": [],
        "acceptanceCriteria": ["Given A, When B, Then C"]
      },
      {
        "id": "${epic.id}-story-3",
        "title": "Third story",
        "description": "Technical details",
        "epicId": "${epic.id}",
        "priority": 3,
        "estimatedComplexity": "simple",
        "dependencies": [],
        "status": "pending",
        "filesToRead": [],
        "filesToModify": ["src/middleware/auth.ts"],
        "filesToCreate": [],
        "acceptanceCriteria": ["Given P, When Q, Then R"]
      }
    ],
    "status": "pending"
  }],
  "architectureDesign": "Technical design",
  "teamComposition": {"developers": 3, "reasoning": "3 stories = 3 devs (1 DEV = 1 STORY rule)"},
  "storyAssignments": [
    {"storyId": "${epic.id}-story-1", "assignedTo": "dev-1"},
    {"storyId": "${epic.id}-story-2", "assignedTo": "dev-2"},
    {"storyId": "${epic.id}-story-3", "assignedTo": "dev-3"}
  ]
}
\`\`\`

**⚠️ VALIDATION RULES (System will REJECT if violated):**
1. \`teamComposition.developers\` MUST equal number of stories
2. Each story MUST be assigned to a UNIQUE developer
3. \`acceptanceCriteria\`: Required array
4. \`filesToModify\` or \`filesToCreate\`: At least one must have files

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
  /**
   * 🔥 CRITICAL BUG FIX (2024-01): workspacePath and repositories MUST be passed from caller!
   * Previously, this method used task.orchestration?.workspacePath || process.cwd()
   * which resulted in Judge searching in the project directory instead of agent workspace.
   * Now we receive these explicitly from executePhase which has context.workspacePath.
   */
  private async judgeTechLeadOutput(
    parsed: any,
    epicContext: any,
    taskId: string,
    task: any,
    workspacePath: string,    // 🔥 FIX: Must be passed from caller (context.workspacePath)
    repositories: any[],      // 🔥 FIX: Must be passed from caller (context.repositories)
    sandboxId?: string        // 🐳 Explicit sandbox ID for Docker execution
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

    // 🔥 FIX: workspacePath and repositories are now passed as parameters
    // from the caller where context.workspacePath is available (correct agent workspace)
    // This fixes bug where Judge was searching in process.cwd() (project dir) instead of agent workspace

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
      sandboxId, // 🐳 Explicit sandbox ID for Docker execution
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

    // 🔥 UNIFIED MEMORY FALLBACK: Check local file as THIRD source of truth
    // Priority: 1) MongoDB (techLead object) 2) UnifiedMemory 3) EventStore
    const taskId = (context.task.id as any).toString();
    try {
      // Check UnifiedMemory for teamComposition if not in DB
      if (!techLead?.teamComposition) {
        const unifiedTeamComp = await unifiedMemoryService.getTeamComposition(taskId);
        if (unifiedTeamComp) {
          context.setData('teamComposition', unifiedTeamComp);
          console.log(`   🔄 Restored teamComposition from UnifiedMemory: ${unifiedTeamComp.developers} devs`);
        }
      }

      // Check UnifiedMemory for storyAssignments if not in DB
      if (!techLead?.storyAssignments || techLead.storyAssignments.length === 0) {
        const unifiedAssignments = await unifiedMemoryService.getStoryAssignments(taskId);
        if (unifiedAssignments.length > 0) {
          context.setData('storyAssignments', unifiedAssignments);
          console.log(`   🔄 Restored ${unifiedAssignments.length} story assignments from UnifiedMemory`);
        }
      }
    } catch (error: any) {
      console.log(`   ⚠️ UnifiedMemory recovery failed: ${error.message}`);
    }

    // Try to restore epics and storiesMap from EventStore (THIRD fallback)
    try {
      const { eventStore } = await import('../EventStore');
      const events = await eventStore.getEvents(context.task.id as any);

      // 🔥 FIX: Detect multi-team mode to filter stories by current epic
      const teamEpic = context.getData<any>('teamEpic');
      const multiTeamMode = !!teamEpic;

      const epicEvents = events.filter((e: any) => e.eventType === 'EpicCreated');
      let storyEvents = events.filter((e: any) => e.eventType === 'StoryCreated');

      // 🔥 FIX Bug #10: In multi-team mode, find TeamCompositionDefined for THIS epic
      // Each epic has its own TechLead that emits its own TeamCompositionDefined event
      let teamEvent: any;
      if (multiTeamMode && teamEpic?.id) {
        teamEvent = events.find((e: any) =>
          e.eventType === 'TeamCompositionDefined' && e.payload?.epicId === teamEpic.id
        );
        if (teamEvent) {
          console.log(`   🎯 [Multi-Team] Found TeamCompositionDefined for epic ${teamEpic.id}`);
        }
      }
      // Fallback to first event for single-team mode or if not found
      if (!teamEvent) {
        teamEvent = events.find((e: any) => e.eventType === 'TeamCompositionDefined');
      }

      // 🔥 CRITICAL FIX: In multi-team mode, ONLY restore stories for THIS EPIC
      // Without this filter, epic 2's developers would get stories from epic 1
      if (multiTeamMode && teamEpic?.id) {
        const totalStories = storyEvents.length;
        storyEvents = storyEvents.filter((e: any) => e.payload.epicId === teamEpic.id);
        console.log(`   🎯 [Multi-Team] Filtered stories: ${storyEvents.length}/${totalStories} for epic ${teamEpic.id}`);
      }

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

        // Also rebuild storyAssignments if not already restored
        if (!context.getData<any[]>('storyAssignments')) {
          const storyAssignments = storyEvents
            .filter((e: any) => e.payload.assignedTo)
            .map((e: any) => ({ storyId: e.payload.id, assignedTo: e.payload.assignedTo }));
          context.setData('storyAssignments', storyAssignments);
          console.log(`   🔄 Rebuilt ${storyAssignments.length} story assignments from EventStore`);
        }
      }

      // Only restore teamComposition from EventStore if not already restored
      if (teamEvent && !context.getData<any>('teamComposition')) {
        context.setData('teamComposition', teamEvent.payload);
        console.log(`   🔄 Restored teamComposition from EventStore: ${teamEvent.payload.developers} devs`);

        // 🔥 FIX Bug #10: Also extract storyAssignments from TeamCompositionDefined event
        // Now that TechLeadPhase includes storyAssignments in the event payload
        if (teamEvent.payload.storyAssignments && !context.getData<any[]>('storyAssignments')) {
          context.setData('storyAssignments', teamEvent.payload.storyAssignments);
          console.log(`   🔄 Restored ${teamEvent.payload.storyAssignments.length} story assignments from TeamCompositionDefined event`);
        }
      }
    } catch (error: any) {
      console.log(`   ⚠️ EventStore recovery failed: ${error.message}`);
    }
  }
}
