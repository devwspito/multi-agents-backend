import { BasePhase, OrchestrationContext, PhaseResult, saveTaskFireAndForget } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { AgentActivityService } from '../AgentActivityService';
import { validateStoryOverlap, logOverlapValidation } from './utils/StoryOverlapValidator';
import { storageService } from '../storage/StorageService';
import { CodebaseDiscoveryService, CodebaseKnowledge } from '../CodebaseDiscoveryService';
import { ProjectRadiographyService, ProjectRadiography } from '../ProjectRadiographyService';
import { JudgePhase } from './JudgePhase';
import { sessionCheckpointService } from '../SessionCheckpointService';
import { granularMemoryService } from '../GranularMemoryService';
import { AgentArtifactService } from '../AgentArtifactService';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { isEmpty } from './utils/ArrayHelpers';
import { getEpicId } from './utils/IdNormalizer';
// 📦 SQLite Repository
import { TaskRepository } from '../../database/repositories/TaskRepository';
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
   * 🎯 UNIFIED MEMORY: Skip if Planning already completed
   * Uses SkipLogicHelper for consistent skip behavior
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const taskId = this.getTaskIdString(context);

    // Use centralized skip logic
    const skipResult = await checkPhaseSkip(context, { phaseName: 'Planning' });

    if (skipResult.shouldSkip) {
      // Restore epics from unified memory or MongoDB
      await this.restoreEpicsOnSkip(context, taskId);
      return true;
    }

    console.log(`   ❌ Phase not completed - Planning must execute`);
    return false;
  }

  /**
   * Restore epics data when skipping (for downstream phases)
   */
  private async restoreEpicsOnSkip(context: OrchestrationContext, taskId: string): Promise<void> {
    const resumption = await unifiedMemoryService.getResumptionPoint(taskId);
    const memoryEpics = resumption?.executionMap?.epics;

    if (!isEmpty(memoryEpics)) {
      const epics = memoryEpics!.map(e => ({ id: e.epicId, title: e.title }));
      context.setData('epics', epics);
      context.setData('totalTeamsNeeded', epics.length);
      console.log(`   ✅ Restored ${epics.length} epics from unified memory`);
    } else if (context.task.orchestration.planning?.epics) {
      // Fallback to MongoDB
      const dbEpics = context.task.orchestration.planning.epics;
      context.setData('epics', dbEpics);
      context.setData('totalTeamsNeeded', dbEpics.length);
      console.log(`   ✅ Restored ${dbEpics.length} epics from MongoDB fallback`);
    }
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task.id as any).toString();
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

    if (!task.orchestration.techLead) {
      task.orchestration.techLead = {
        agent: 'tech-lead',
        status: 'pending',
      } as any;
    }

    task.orchestration.planning!.status = 'in_progress';
    task.orchestration.planning!.startedAt = startTime;
    saveTaskFireAndForget(task, 'planning in_progress');

    NotificationService.emitAgentStarted(taskId, 'Planning Agent');
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      'Planning Agent: Starting unified analysis (problem + epics + stories in ONE pass)...'
    );

    // 🎯 ACTIVITY: Emit Planning start for Activity tab
    AgentActivityService.emitMessage(
      taskId,
      'Planning',
      `📋 Starting unified analysis: problem analysis + epics + stories...`
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

      // Build repository info for prompt WITH LOCAL PATHS
      const effectiveWorkspace = workspacePath || process.cwd();
      const repoInfo = repositories.map((repo: any, i: number) => {
        const typeEmoji = repo.type === 'backend' ? '' : repo.type === 'frontend' ? '' : '';
        const localPath = `${effectiveWorkspace}/${repo.name}`;
        return `${i + 1}. **${repo.name}** (${typeEmoji} ${repo.type.toUpperCase()})
   - GitHub: ${repo.githubRepoName}
   - Branch: ${repo.githubBranch}
   - **LOCAL PATH**: \`${localPath}\` ← USE THIS for Glob/Read/Grep!`;
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

      // 🔄 RETRY LOGIC: Planning gets up to 3 attempts when Judge rejects
      const MAX_RETRIES = 3;
      let retryCount = 0;
      let lastError: any = null;
      const effectiveWorkspacePath = workspacePath || process.cwd();
      const projectId = task.projectId?.toString();

      // 🔥 PROGRAMMATIC CODEBASE DISCOVERY WITH CACHING
      // Checks: 1) Context (retry) → 2) Granular Memory (restart) → 3) Fresh scan
      console.log(`\n🔍 [PlanningPhase] Checking for cached codebase discovery...`);
      let codebaseKnowledge: CodebaseKnowledge | undefined;

      // 1️⃣ Check context first (from previous retry in same execution)
      codebaseKnowledge = context.getData('codebaseKnowledge') as CodebaseKnowledge | undefined;

      // 2️⃣ Check granular memory (from previous execution before restart)
      // 🔥 CRITICAL: Use getTaskCache (STRICT) - only loads cache for THIS EXACT TASK
      // This prevents loading stale cache from previous tasks where code may have changed
      if (!codebaseKnowledge && projectId) {
        try {
          const discoveryCache = await granularMemoryService.getTaskCache({
            projectId,
            taskId,
            phaseType: 'planning',
            cacheTitle: 'CodebaseDiscovery Cache',
          });
          if (discoveryCache?.content) {
            try {
              codebaseKnowledge = JSON.parse(discoveryCache.content) as CodebaseKnowledge;
              console.log(`✅ [Cache] Loaded codebaseKnowledge from granular memory (taskId: ${taskId})`);
              console.log(`   → ${codebaseKnowledge.helperFunctions?.length || 0} helpers, ${codebaseKnowledge.entityCreationRules?.length || 0} rules`);
              context.setData('codebaseKnowledge', codebaseKnowledge);
            } catch (parseErr) {
              console.warn(`⚠️ [Cache] Failed to parse cached discovery, will re-scan`);
            }
          }
        } catch (memErr: any) {
          console.warn(`⚠️ [Cache] Memory check failed: ${memErr.message}`);
        }
      }

      // 3️⃣ Fresh scan if no cache
      if (!codebaseKnowledge) {
        console.log(`🔍 [PlanningPhase] Running fresh codebase discovery...`);
        try {
          codebaseKnowledge = await CodebaseDiscoveryService.discoverCodebase(effectiveWorkspacePath);
          context.setData('codebaseKnowledge', codebaseKnowledge);
          console.log(`✅ [PlanningPhase] Discovered ${codebaseKnowledge.helperFunctions.length} helper functions, ${codebaseKnowledge.entityCreationRules.length} entity rules`);

          // Cache to granular memory for future restarts
          if (projectId) {
            try {
              await granularMemoryService.store({
                projectId,
                taskId,
                scope: 'task',
                phaseType: 'planning',
                agentType: 'planning-agent',
                type: 'context',
                title: 'CodebaseDiscovery Cache',
                content: JSON.stringify(codebaseKnowledge),
                importance: 'medium',
                confidence: 1.0,
              });
              console.log(`[Cache] Stored codebaseKnowledge in granular memory`);
            } catch (storeErr: any) {
              console.warn(`[Cache] Failed to store discovery: ${storeErr.message}`);
            }
          }
        } catch (error: any) {
          console.warn(`⚠️ [PlanningPhase] Codebase discovery failed (will continue): ${error.message}`);
        }
      } else {
        console.log(`⏭️ [PlanningPhase] Using cached codebase discovery (skipped re-scan)`);
      }

      // 🔬 PROJECT RADIOGRAPHY WITH CACHING
      console.log(`\n🔬 [PlanningPhase] Checking for cached project radiography...`);
      let projectRadiographies: Map<string, ProjectRadiography> = new Map();

      // 1️⃣ Check context first
      const contextRadiographies = context.getData('projectRadiographies') as Map<string, ProjectRadiography> | undefined;
      if (contextRadiographies && contextRadiographies.size > 0) {
        projectRadiographies = contextRadiographies;
        console.log(`✅ [Cache] Loaded ${projectRadiographies.size} radiographies from context`);
      }

      // 2️⃣ Check granular memory
      // 🔥 CRITICAL: Use getTaskCaches (STRICT) - only loads cache for THIS EXACT TASK
      // This prevents loading stale cache from previous tasks where code may have changed
      if (projectRadiographies.size === 0 && projectId) {
        try {
          const radiographyCaches = await granularMemoryService.getTaskCaches({
            projectId,
            taskId,
            phaseType: 'planning',
            cacheTitlePrefix: 'ProjectRadiography:',
            limit: 10,
          });
          if (radiographyCaches.length > 0) {
            for (const cache of radiographyCaches) {
              const repoName = cache.title?.replace('ProjectRadiography: ', '') || '';
              if (repoName && cache.content) {
                try {
                  const radiography = JSON.parse(cache.content) as ProjectRadiography;
                  projectRadiographies.set(repoName, radiography);
                } catch (parseErr) {
                  // Skip invalid cache
                }
              }
            }
            if (projectRadiographies.size > 0) {
              console.log(`✅ [Cache] Loaded ${projectRadiographies.size} radiographies from granular memory (taskId: ${taskId})`);
              context.setData('projectRadiographies', projectRadiographies);
            }
          }
        } catch (memErr: any) {
          console.warn(`⚠️ [Cache] Memory check failed: ${memErr.message}`);
        }
      }

      // 3️⃣ Fresh scan for missing repositories
      const missingRepos = repositories.filter((r: any) => !projectRadiographies.has(r.name));
      if (missingRepos.length > 0) {
        console.log(`🔬 [PlanningPhase] Scanning ${missingRepos.length} repository(s)...`);
        for (const repo of missingRepos) {
          const repoPath = path.join(effectiveWorkspacePath, repo.name);
          if (fs.existsSync(repoPath)) {
            try {
              console.log(`  📊 Scanning ${repo.name} (${repo.type})...`);
              const radiography = await ProjectRadiographyService.scan(repoPath);
              projectRadiographies.set(repo.name, radiography);
              console.log(`  ✅ ${repo.name}: ${radiography.language.primary}/${radiography.framework.name} - ${radiography.routes.length} routes, ${radiography.models.length} models, ${radiography.services.length} services`);

              // Cache to granular memory
              if (projectId) {
                try {
                  await granularMemoryService.store({
                    projectId,
                    taskId,
                    scope: 'task',
                    phaseType: 'planning',
                    agentType: 'planning-agent',
                    type: 'context',
                    title: `ProjectRadiography: ${repo.name}`,
                    content: JSON.stringify(radiography),
                    importance: 'medium',
                    confidence: 1.0,
                  });
                } catch (storeErr: any) {
                  // Non-critical
                }
              }
            } catch (error: any) {
              console.warn(`  ⚠️ ${repo.name}: Radiography failed (will continue): ${error.message}`);
            }
          } else {
            console.warn(`  ⚠️ ${repo.name}: Path not found at ${repoPath}`);
          }
        }
      } else {
        console.log(`⏭️ [PlanningPhase] Using cached radiography for all ${repositories.length} repositories (skipped re-scan)`);
      }

      // Store for subsequent phases (TechLead, Developer, etc.)
      context.setData('projectRadiographies', projectRadiographies);
      console.log(`✅ [PlanningPhase] Radiography complete: ${projectRadiographies.size}/${repositories.length} repositories`);
      if (missingRepos.length < repositories.length) {
        console.log(`   💾 ${repositories.length - missingRepos.length} from cache, ${missingRepos.length} freshly scanned`);
      }

      // 🔄 RETRY LOOP: Try up to MAX_RETRIES times
      while (retryCount < MAX_RETRIES) {
      try {
        if (retryCount > 0) {
          console.log(`\n🔄🔄🔄 [Planning] RETRY ${retryCount}/${MAX_RETRIES - 1} - Fixing Judge feedback 🔄🔄🔄`);
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `🔄 Planning Retry ${retryCount}/${MAX_RETRIES - 1}: ${lastError?.violationType || 'Judge rejection'}`
          );
        }

        // 🔄 Build retry section if this is a retry attempt
        let retrySection = '';
        if (lastError && retryCount > 0) {
          const judgeFeedback = lastError.feedback || '';
          const judgeReason = lastError.reason || lastError.message || '';

          retrySection = `

# 🚨🚨🚨 JUDGE REJECTED YOUR PLANNING - FIX THE ISSUES BELOW! 🚨🚨🚨

## ❌ WHY YOU WERE REJECTED:

${judgeReason}

## 📋 SPECIFIC ISSUES TO FIX:

${judgeFeedback}

---

## 🎯 HOW TO FIX:

1. **READ THE FEEDBACK CAREFULLY** - The Judge explained exactly what's missing
2. **ADD MISSING EPICS** - If scoring system is missing, add an epic for it
3. **COVER ALL ACTIVITY TYPES** - Tests, prácticos, miniquiz must be handled
4. **DEFINE PASS/FAIL CRITERIA** - What score constitutes "failing" an activity?
5. **INCLUDE RESET MECHANISM** - How do lives regenerate?

---

`;
        }

      // 💡 USER DIRECTIVES - Incorporate any user-injected instructions
      const directivesBlock = context.getDirectivesBlock('planning-agent');

      // Build the unified planning prompt (includes discovered patterns + radiography)
      const basePrompt = this.buildPlanningPrompt(task, repositories, repoInfo, previousContextSection, codebaseKnowledge, projectRadiographies);

      // Inject retry section and directives at the beginning of the prompt
      let prompt = basePrompt;
      if (retrySection) {
        prompt = retrySection + prompt;
      }
      if (directivesBlock) {
        prompt = prompt.replace(
          '## ⛔ FORBIDDEN BEHAVIORS',
          `${directivesBlock}\n## ⛔ FORBIDDEN BEHAVIORS`
        );
      }

      // 🔄 SESSION RESUME: Check for existing checkpoint from interrupted execution
      const existingCheckpoint = await sessionCheckpointService.loadCheckpoint(taskId, 'planning');
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [Planning] RESUMING from previous session: ${resumeOptions.resumeSessionId?.substring(0, 20)}...`);
        NotificationService.emitConsoleLog(taskId, 'info', `🔄 Planning Phase resuming from checkpoint`);
      }

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
        'bypassPermissions', // Use bypassPermissions like TechLead - prompt restricts to read-only
        resumeOptions // 🔄 Session resume options
      );

      // 🔄 Save session checkpoint for recovery (even on success - marks as completed)
      if (result.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'planning',
          result.sdkSessionId,
          undefined,
          result.lastMessageUuid
        );
      }

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

      // ⚖️ PLANNING JUDGE: Validate epics with AI evaluation AS AGENT (with tools!)
      // 🔥 Judge now has Read/Glob/Grep tools - can verify files exist itself
      // 🔥 CRITICAL: Pass effectiveWorkspacePath (context.workspacePath), NOT task.orchestration?.workspacePath
      //    task.orchestration?.workspacePath is often null, causing fallback to process.cwd() (WRONG!)
      const planningJudgeResult = await this.judgePlanningOutput(enrichedEpics, task, taskId, effectiveWorkspacePath, repositories);

      if (!planningJudgeResult.approved) {
        console.error(`\n🚨 [Planning] Judge rejected: ${planningJudgeResult.reason}`);

        // 🎯 ACTIVITY: Emit Judge rejection for Activity tab
        AgentActivityService.emitToolUse(taskId, 'Planning', 'EpicValidation', {
          verdict: 'REJECTED',
          reason: planningJudgeResult.reason,
          epicsCount: planningJudgeResult.epicsCount,
        });
        AgentActivityService.emitError(
          taskId,
          'Planning',
          `⚖️ Judge rejected: ${planningJudgeResult.reason}`
        );
        NotificationService.emitAgentMessage(
          taskId,
          'Planning',
          `⚖️ JUDGE REJECTED: ${planningJudgeResult.reason}\n${planningJudgeResult.feedback || ''}`
        );

        const error = new Error(`PLANNING_JUDGE_REJECTION: ${planningJudgeResult.reason}`);
        (error as any).retryable = true;
        (error as any).violationType = 'PLANNING_JUDGE_REJECTION';
        (error as any).feedback = planningJudgeResult.feedback;
        (error as any).reason = planningJudgeResult.reason; // Pass full rejection reason for retry
        throw error;
      }

      // 🎯 ACTIVITY: Emit Judge approval with validation details for Activity tab
      AgentActivityService.emitToolUse(taskId, 'Planning', 'EpicValidation', {
        verdict: 'APPROVED',
        epicsCount: planningJudgeResult.epicsCount,
        validations: planningJudgeResult.validations,
      });
      // Build detailed message showing what checks passed
      const v = planningJudgeResult.validations;
      const checksMessage = v ? [
        `✅ Epics created: ${v.epicTitles.join(', ')}`,
        `✅ Descriptions: ${v.hasDescriptions ? 'All have meaningful descriptions' : 'Some missing'}`,
        `✅ Complexity: ${v.hasEnoughEpicsForComplexity ? 'Appropriate epic count' : 'May need more epics'}`,
        v.hasFullStackCoverage !== 'N/A' ? `✅ Full-stack: ${v.hasFullStackCoverage ? 'Backend + Frontend covered' : 'Missing coverage'}` : null,
        `📊 Alignment: ${v.keywordAlignment}`,
      ].filter(Boolean).join('\n') : '';

      AgentActivityService.emitMessage(
        taskId,
        'Planning',
        `⚖️ Judge approved: ${planningJudgeResult.epicsCount} epic(s)\n${checksMessage}`
      );
      NotificationService.emitAgentMessage(
        taskId,
        'Planning',
        `⚖️ JUDGE APPROVED\n${checksMessage}`
      );

      console.log(`✅ [Planning] Judge approved - ${planningJudgeResult.epicsCount} epic(s)`);

      // 🔥 CRITICAL: Re-fetch task from DB to avoid stale data
      // During the agent execution (~2-3 min), WebSocket notifications may have updated the task
      const freshTask = TaskRepository.findById(task.id);
      if (!freshTask) {
        throw new Error(`Task ${task.id} not found in database after agent execution`);
      }

      // Update fresh task with results
      const planning = (freshTask.orchestration.planning || { agent: 'planning', status: 'pending' }) as any;
      planning.status = 'completed';
      planning.completedAt = new Date();
      planning.output = result.output;
      planning.epics = enrichedEpics;
      planning.analysis = parsed.analysis;

      // 🔥 MERGE: Combine agent's architectureBrief with programmatically discovered patterns
      // This ensures helperFunctions/entityCreationRules are ALWAYS present even if agent misses them
      const mergedArchitectureBrief = {
        ...parsed.architectureBrief,
        // Override with programmatic discovery (more reliable than agent discovery)
        ...(codebaseKnowledge ? CodebaseDiscoveryService.toArchitectureBriefFields(codebaseKnowledge) : {}),
      };
      planning.architectureBrief = mergedArchitectureBrief; // 🏗️ Architecture insights for TechLead/Developers
      planning.codebaseKnowledge = codebaseKnowledge; // 🔧 Raw programmatic discovery data
      planning.sessionId = result.sessionId;
      planning.usage = result.usage;
      planning.cost_usd = result.cost;
      freshTask.orchestration.planning = planning;

      // NOTE: TechLead is NOT marked as completed here!
      // TechLead must still run to:
      // 1. Break epics into stories (with file paths)
      // 2. Define teamComposition (number of developers)
      // 3. Assign stories to developers (storyAssignments)
      // PlanningPhase only creates EPICS, TechLead creates STORIES from epics

      // Update costs (fire-and-forget)
      freshTask.orchestration.totalCost = (freshTask.orchestration.totalCost || 0) + (result.cost || 0);
      freshTask.orchestration.totalTokens = (freshTask.orchestration.totalTokens || 0) +
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      saveTaskFireAndForget(freshTask, 'planning costs update');

      // 📦 GITHUB BACKUP: Save epics to GitHub as backup
      // MongoDB has the data (above), now push to GitHub for disaster recovery
      // 🔥 NOTE: Use effectiveWorkspacePath declared at line ~285 (already exists in scope)
      const primaryRepo = enrichedEpics[0]?.targetRepository || repositories[0]?.name;
      if (primaryRepo) {
        try {
          // Save epics artifact
          const artifactResult = await AgentArtifactService.savePlanningArtifact(
            effectiveWorkspacePath,
            primaryRepo,
            taskId,
            enrichedEpics,
            task.title,
            task.description
          );
          if (artifactResult.success) {
            console.log(`📦 [Planning] Artifacts saved to GitHub: ${artifactResult.filePath}`);
          }

          // Save Judge evaluation artifact
          const aiEval = planningJudgeResult.aiEvaluation;
          await AgentArtifactService.saveJudgeArtifact(
            effectiveWorkspacePath,
            primaryRepo,
            taskId,
            'planning',
            'planning-epics', // entityId for planning is the epics validation
            {
              verdict: planningJudgeResult.approved ? 'approved' : 'rejected',
              score: aiEval?.score,
              feedback: planningJudgeResult.feedback || aiEval?.reasoning || checksMessage,
              issues: aiEval?.issues,
              suggestions: aiEval?.suggestions,
            }
          );
          console.log(`📦 [Planning] Judge evaluation saved to GitHub`);
        } catch (artifactError: any) {
          // Non-blocking - local save and MongoDB are the source of truth
          console.warn(`⚠️ [Planning] GitHub backup failed (non-blocking): ${artifactError.message}`);
        }
      }

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

      // 🎯 ACTIVITY: Emit Planning result for Activity tab
      const totalStories = enrichedEpics.reduce((sum: number, e: any) => sum + (e.stories?.length || 0), 0);
      AgentActivityService.emitToolUse(taskId, 'Planning', 'UnifiedPlanning', {
        epics: enrichedEpics.length,
        stories: totalStories,
        repositories: repositories.length,
      });
      AgentActivityService.emitMessage(
        taskId,
        'Planning',
        `✅ Planning complete: ${enrichedEpics.length} epic(s), ${totalStories} stories`
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
        taskId: task.id as any,
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

      // 🔄 Mark checkpoint as completed (no resume needed)
      await sessionCheckpointService.markCompleted(taskId, 'planning');

      // 🧠 GRANULAR MEMORY: Store planning decisions and discoveries
      const projectId = task.projectId?.toString();
      if (projectId) {
        try {
          // Store progress marker
          await granularMemoryService.storeProgress({
            projectId,
            taskId,
            phaseType: 'planning',
            agentType: 'planning-agent',
            status: 'completed',
            details: `Created ${enrichedEpics.length} epic(s): ${enrichedEpics.map((e: any) => e.title).join(', ')}`,
          });

          // Store each epic as a decision
          for (const epic of enrichedEpics) {
            await granularMemoryService.storeDecision({
              projectId,
              taskId,
              phaseType: 'planning',
              agentType: 'planning-agent',
              epicId: getEpicId(epic), // 🔥 CENTRALIZED: Use IdNormalizer
              title: `Epic: ${epic.title}`,
              content: `Repository: ${epic.targetRepository}\nDescription: ${epic.description || 'N/A'}\nFiles to modify: ${epic.filesToModify?.join(', ') || 'none'}\nFiles to create: ${epic.filesToCreate?.join(', ') || 'none'}`,
              importance: 'high',
            });
          }

          // Store patterns from architectureBrief
          if (parsed.architectureBrief?.codePatterns) {
            const patterns = parsed.architectureBrief.codePatterns;
            await granularMemoryService.storePattern({
              projectId,
              title: 'Code Patterns Discovered',
              content: `Naming: ${patterns.namingConvention || 'N/A'}\nFile Structure: ${patterns.fileStructure || 'N/A'}\nError Handling: ${patterns.errorHandling || 'N/A'}\nTesting: ${patterns.testing || 'N/A'}`,
              importance: 'high',
            });
          }

          // Store conventions from codebaseKnowledge
          if (codebaseKnowledge?.helperFunctions?.length) {
            for (const helper of codebaseKnowledge.helperFunctions.slice(0, 5)) {
              await granularMemoryService.storeConvention({
                projectId,
                title: `Use ${helper.name}()`,
                content: `File: ${helper.file}\nUsage: ${helper.usage}\n${helper.antiPattern ? `Anti-pattern: ${helper.antiPattern}` : ''}`,
              });
            }
          }

          console.log(`🧠 [Planning] Stored ${enrichedEpics.length + 2} memories (progress, epics, patterns)`);
        } catch (memError: any) {
          console.warn(`⚠️ [Planning] Failed to store memories: ${memError.message}`);
        }
      }

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
      // 🔄 RETRY: Check if this error is retryable
      if (error.retryable && retryCount < MAX_RETRIES - 1) {
        retryCount++;
        lastError = error;
        console.log(`\n⚠️  [Planning] Retryable error caught: ${error.violationType}`);
        console.log(`   Will retry (${retryCount}/${MAX_RETRIES - 1})...`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️ Planning Judge rejected. Retrying (${retryCount}/${MAX_RETRIES - 1})...`
        );
        continue; // Go back to while loop
      }

      // Non-retryable error OR max retries reached
      if (error.retryable) {
        console.error(`\n❌❌❌ [Planning] MAX RETRIES (${MAX_RETRIES}) REACHED - GIVING UP ❌❌❌`);
        console.error(`   Last error: ${error.violationType}`);
        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Planning failed after ${MAX_RETRIES} attempts: ${error.violationType}`
        );
      }

      console.error(`\n[Planning] FAILED: ${error.message}`);

      task.orchestration.planning!.status = 'failed';
      task.orchestration.planning!.completedAt = new Date();
      task.orchestration.planning!.error = error.message;
      saveTaskFireAndForget(task, 'planning failed');

      NotificationService.emitAgentFailed(taskId, 'Planning Agent', error.message);

      await LogService.agentFailed('planning-agent', taskId, error, {
        phase: 'planning',
      });

      // 🔄 Mark checkpoint as failed
      await sessionCheckpointService.markFailed(taskId, 'planning', undefined, error.message);

      return {
        success: false,
        error: error.message,
      };
    }
    } // End of while loop

    // Should never reach here (while loop always returns)
    return {
      success: false,
      error: 'Unexpected: Planning execution loop exited without result',
    };

    } catch (outerError: any) {
      // Handle errors from setup phase (before while loop)
      // e.g., missing repository type, codebase discovery critical failure
      console.error(`\n[Planning] SETUP FAILED: ${outerError.message}`);

      task.orchestration.planning!.status = 'failed';
      task.orchestration.planning!.completedAt = new Date();
      task.orchestration.planning!.error = outerError.message;
      saveTaskFireAndForget(task, 'planning setup failed');

      NotificationService.emitAgentFailed(taskId, 'Planning Agent', outerError.message);

      await LogService.agentFailed('planning-agent', taskId, outerError, {
        phase: 'planning',
      });

      // 🔄 Mark checkpoint as failed
      await sessionCheckpointService.markFailed(taskId, 'planning', undefined, outerError.message);

      return {
        success: false,
        error: outerError.message,
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
    codebaseKnowledge?: CodebaseKnowledge,
    projectRadiographies?: Map<string, ProjectRadiography>
  ): string {
    const projectId = task.projectId?.toString() || '';
    const taskId = task.id?.toString() || '';

    // 🔥 DISCOVERED PATTERNS SECTION (from programmatic discovery)
    const discoveredPatternsSection = codebaseKnowledge
      ? CodebaseDiscoveryService.formatForPrompt(codebaseKnowledge)
      : '';

    // 🔬 PROJECT RADIOGRAPHY SECTION - Complete project X-Ray (LANGUAGE AGNOSTIC)
    let radiographySection = '';
    if (projectRadiographies && projectRadiographies.size > 0) {
      radiographySection = `
## 🔬 PROJECT RADIOGRAPHY (Complete Codebase X-Ray - READ THIS CAREFULLY!)

**This section contains the COMPLETE analysis of each repository. USE THIS DATA - it's more reliable than exploration.**

`;
      for (const [repoName, radiography] of projectRadiographies.entries()) {
        radiographySection += `
### 📁 ${repoName}
${ProjectRadiographyService.formatForPrompt(radiography)}
`;
      }

      radiographySection += `
---
**⚠️ CRITICAL**: The radiography above is the TRUTH about the project structure.
- DO NOT ignore this data and search blindly
- DO NOT assume patterns that contradict the radiography
- USE the routes, models, services listed above when planning epics
- MATCH the conventions detected (naming, file structure, code style)
---
`;
    }

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

## 🔍 CRITICAL: REQUIREMENT EXPANSION (DO THIS FIRST!)

**If the task title/description is VAGUE (like "gaming v3", "add dashboard", "improve auth"), YOU MUST EXPAND IT:**

### Step 1: Search for EXISTING Related Features
\`\`\`bash
# Find existing implementations of similar features
Grep("gaming|game|match|score|leaderboard")  # Search for related code
Glob("**/gaming/**", "**/game/**", "**/match/**")  # Find related directories
\`\`\`

### Step 2: Analyze What EXISTS vs What's MISSING
Ask yourself:
- What does v1/v2 have? What's the current state?
- What would make this a COMPLETE v3?
- What are users likely expecting?

### Step 3: Create a COMPREHENSIVE Feature Breakdown
A complete feature ALWAYS needs (check ALL that apply):

**🔧 BACKEND Components:**
- [ ] Data Models (database schemas, relationships)
- [ ] REST/GraphQL APIs (CRUD endpoints)
- [ ] Business Logic (services, validation rules)
- [ ] Real-time (WebSockets if needed)
- [ ] Background Jobs (if async processing needed)

**🎨 FRONTEND Components:**
- [ ] Pages/Views (main UI screens)
- [ ] Components (reusable UI elements)
- [ ] Forms (user input with validation)
- [ ] State Management (local/global state)
- [ ] API Integration (hooks, services)

**🔒 Cross-Cutting Concerns:**
- [ ] Authentication/Authorization (who can access?)
- [ ] Validation (input validation, business rules)
- [ ] Error Handling (user-friendly errors)
- [ ] Logging/Monitoring (for debugging)
- [ ] Tests (unit, integration, e2e)

### Step 4: Document Your Expanded Requirements
In your output JSON, include an "expandedRequirements" field:
\`\`\`json
{
  "expandedRequirements": {
    "originalRequest": "gaming v3",
    "existingFeatures": ["basic match system", "score tracking"],
    "inferredNeeds": [
      "Lives system - users need limited attempts",
      "Leaderboards - competitive ranking",
      "Match history - users want to see past games",
      "Rewards system - motivation to keep playing"
    ],
    "backendNeeds": ["Lives model", "Leaderboard API", "Match history API"],
    "frontendNeeds": ["Lives display component", "Leaderboard page", "Match history page"],
    "reasoning": "Analyzed existing gaming module and industry standards for gaming v3"
  }
}
\`\`\`

### ⚠️ RED FLAGS - Your plan is TOO SHALLOW if:
- You only create 1-2 epics for a complex feature
- Backend epic has no corresponding frontend epic (or vice versa)
- No tests or validation mentioned
- No error handling considered
- You didn't search for existing related code first

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
${radiographySection}

## WORKFLOW (Radiography-Guided)

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
${this.getRepoSpecificPatternDiscovery(repositories)}

**Document**:
- Naming conventions (camelCase, kebab-case, etc.)
- File organization patterns
- Error handling patterns
- Logging patterns
- Testing patterns

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
   * Generate repository-specific pattern discovery commands
   * Based on actual repo types in the project
   */
  private getRepoSpecificPatternDiscovery(repositories: any[]): string {
    const hasBackend = repositories.some(r => r.type === 'backend');
    const hasFrontend = repositories.some(r => r.type === 'frontend');

    let commands = '```bash\n';

    if (hasBackend) {
      commands += `# 🔧 BACKEND patterns (APIs, services, models)
Glob("**/controllers/**/*.ts", "**/services/**/*.ts", "**/routes/**/*.ts")
Glob("**/models/**/*.ts", "**/middleware/**/*.ts")
Grep("router.get|router.post|app.get|@Get|@Post")
Grep("middleware|authenticate|authorize|validate")
`;
    }

    if (hasFrontend) {
      commands += `# 🎨 FRONTEND patterns (components, hooks, pages)
Glob("**/components/**/*.tsx", "**/pages/**/*.tsx", "**/hooks/**/*.ts")
Glob("**/contexts/**/*.tsx", "**/services/**/*.ts", "**/utils/**/*.ts")
Grep("useState|useEffect|useContext|useMemo|useCallback")
Grep("export.*function|export.*const.*=.*\\(")
`;
    }

    // Always check for config files
    commands += `
# Check for linting/formatting config
Read(".eslintrc*", ".prettierrc*", "tsconfig.json")
\`\`\``;

    return commands;
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

  /**
   * ⚖️ PLANNING JUDGE: AI-powered validation of planning output
   *
   * Phase 1: Fast programmatic checks (fail fast, no AI cost)
   * Phase 2: AI evaluation AS AGENT with Read/Glob/Grep tools
   *
   * 🔥 CRITICAL: Judge is now a FULL AGENT with tools!
   * It can read files, search code, and verify everything itself.
   *
   * 🔥 CRITICAL BUG FIX (2024-01): workspacePath MUST be passed from caller!
   * Previously, this method used task.orchestration?.workspacePath || process.cwd()
   * which resulted in Judge searching in the project directory instead of agent workspace.
   * Now we receive workspacePath explicitly from executePhase which has context.workspacePath.
   */
  private async judgePlanningOutput(
    epics: any[],
    task: any,
    taskId: string,
    workspacePath: string,  // 🔥 FIX: Must be passed from caller (context.workspacePath)
    repositories: any[]     // 🔥 FIX: Also pass repositories directly
  ): Promise<{
    approved: boolean;
    reason?: string;
    feedback?: string;
    epicsCount: number;
    aiEvaluation?: {
      verdict: 'APPROVE' | 'REJECT';
      reasoning: string;
      issues: string[];
      suggestions: string[];
      score: number;
    };
    validations?: {
      hasEpics: boolean;
      hasDescriptions: boolean;
      hasEnoughEpicsForComplexity: boolean;
      hasFullStackCoverage: boolean | 'N/A';
      keywordAlignment: string;
      taskTitle: string;
      epicTitles: string[];
    };
  }> {
    // 🎯 ACTIVITY: Judge starting
    AgentActivityService.emitMessage(taskId, 'Planning-Judge', `⚖️ Starting validation of ${epics?.length || 0} epic(s)...`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: Fast programmatic checks (fail fast, no AI cost)
    // ═══════════════════════════════════════════════════════════════════
    AgentActivityService.emitToolUse(taskId, 'Planning-Judge', 'BasicChecks', {
      phase: 'Fast validation',
      epicsCount: epics?.length || 0,
    });

    // CHECK 1: Must have epics
    if (!epics || epics.length === 0) {
      AgentActivityService.emitError(taskId, 'Planning-Judge', '❌ FAST CHECK FAILED: No epics created');
      return {
        approved: false,
        reason: 'No epics created',
        feedback: 'Planning must create at least one epic to proceed',
        epicsCount: 0,
      };
    }

    // CHECK 2: Epics must have descriptions
    const epicsWithoutDescription = epics.filter((e: any) =>
      !e.description || e.description.length < 20
    );
    if (epicsWithoutDescription.length > epics.length * 0.5) {
      AgentActivityService.emitError(taskId, 'Planning-Judge', `❌ FAST CHECK FAILED: ${epicsWithoutDescription.length}/${epics.length} epics lack descriptions`);
      return {
        approved: false,
        reason: 'Most epics lack proper descriptions',
        feedback: `${epicsWithoutDescription.length}/${epics.length} epics have no description or descriptions too short (<20 chars).`,
        epicsCount: epics.length,
      };
    }

    AgentActivityService.emitMessage(taskId, 'Planning-Judge', `✅ Basic checks passed - proceeding to AI evaluation with tools`);

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: AI Evaluation AS AGENT (with Read, Glob, Grep tools!)
    // 🔥 CRITICAL: Judge MUST have same tools as Planning Agent
    // Without tools, Judge cannot verify if files exist or read code
    // ═══════════════════════════════════════════════════════════════════

    AgentActivityService.emitToolUse(taskId, 'Planning-Judge', 'AIEvaluation', {
      phase: 'AI-powered quality assessment WITH TOOLS',
      evaluating: ['epic coverage', 'scope completeness', 'alignment with task', 'full-stack coverage', 'dependencies'],
      hasTools: true,
    });

    // 🔥 FIX: workspacePath and repositories are now passed as parameters from executePhase
    // Previously used: task.orchestration?.workspacePath || process.cwd() (BUG: fell back to project dir!)
    // Now uses: context.workspacePath passed explicitly from caller
    console.log(`\n🔍 [Planning-Judge] Using workspace: ${workspacePath}`);
    console.log(`   Repositories: ${repositories.map((r: any) => r.name).join(', ')}`);
    console.log(`   ✅ This should be the AGENT workspace, not the project directory!`);

    // 🏛️ UNIFIED: Use JudgePhase.evaluateWithType() for consistent judge execution
    const judgePhase = new JudgePhase(this.executeAgentFn);
    const judgeResult = await judgePhase.evaluateWithType({
      type: 'planning',
      workspacePath,
      taskId,
      repositories,
      taskTitle: task.title || 'No title',
      taskDescription: task.description || 'No description',
      epics,
    });

    // Emit detailed evaluation results
    AgentActivityService.emitToolUse(taskId, 'Planning-Judge', 'AIVerdict', {
      verdict: judgeResult.approved ? 'APPROVE' : 'REJECT',
      score: judgeResult.score,
      filesVerified: judgeResult.filesVerified?.length || 0,
      issuesCount: judgeResult.issues?.length || 0,
      cost: `$${judgeResult.cost?.toFixed(4) || '?'}`,
    });

    // Emit reasoning
    AgentActivityService.emitMessage(taskId, 'Planning-Judge',
      `🤖 Judge Evaluation (score: ${judgeResult.score || 0}/100):\n` +
      `${judgeResult.feedback}\n\n` +
      (judgeResult.filesVerified && judgeResult.filesVerified.length > 0 ? `📁 Files Verified: ${judgeResult.filesVerified.join(', ')}\n` : '') +
      (judgeResult.issues && judgeResult.issues.length > 0 ? `\n❌ Issues:\n${judgeResult.issues.map((i: string) => `  • ${i}`).join('\n')}` : '') +
      (judgeResult.suggestions && judgeResult.suggestions.length > 0 ? `\n💡 Suggestions:\n${judgeResult.suggestions.map((s: string) => `  • ${s}`).join('\n')}` : '')
    );

    // Approval requires both approved status AND score >= 60
    const approved = judgeResult.approved && (judgeResult.score || 0) >= 60;

    if (approved) {
      AgentActivityService.emitMessage(taskId, 'Planning-Judge', `✅ APPROVED with score ${judgeResult.score}/100`);
    } else {
      AgentActivityService.emitError(taskId, 'Planning-Judge',
        `❌ REJECTED (score: ${judgeResult.score}/100)\n` +
        `Reason: ${judgeResult.feedback}\n` +
        `Issues: ${judgeResult.issues?.join(', ')}`
      );
    }

    return {
      approved,
      reason: approved ? undefined : judgeResult.feedback,
      feedback: approved ? undefined : (judgeResult.issues || []).concat(judgeResult.suggestions || []).join('\n'),
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
}
