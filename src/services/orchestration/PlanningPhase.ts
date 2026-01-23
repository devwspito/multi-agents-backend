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
// 🔥 REMOVED: granularMemoryService - SQLite (UnifiedMemoryService) is the single source of truth
import { AgentArtifactService } from '../AgentArtifactService';
// 🎯 UNIFIED MEMORY - THE SINGLE SOURCE OF TRUTH
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 📦 Utility helpers
import { checkPhaseSkip } from './utils/SkipLogicHelper';
import { isEmpty } from './utils/ArrayHelpers';
// 🔥 REMOVED: getEpicId - was only used by granularMemoryService
// 📦 SQLite Repository
import { TaskRepository } from '../../database/repositories/TaskRepository';
import { sandboxService } from '../SandboxService';
import { sandboxPoolService } from '../SandboxPoolService';
import { languageDetectionService, DetectedLanguage } from '../LanguageDetectionService';
import { eventStore } from '../EventStore';
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

    // 🔍 LANGUAGE DETECTION: Use LLM to detect language/framework from task description
    // This is 100% language-agnostic - no hardcoded patterns needed
    let detectedLanguage: DetectedLanguage | null = null;
    const descriptionToAnalyze = task.description || task.title || '';
    console.log(`🔍 [Planning] Language detection - description length: ${descriptionToAnalyze.length}`);
    if (descriptionToAnalyze.length > 0) {
      console.log(`🔍 [Planning] Detecting language from task description using LLM...`);
      console.log(`   Input: "${descriptionToAnalyze.substring(0, 100)}${descriptionToAnalyze.length > 100 ? '...' : ''}"`);
      try {
        // 🔥 AGNOSTIC: Pass repo names so LLM can generate valid project names for the language
        const repoNames = repositories.map((r: any) => r.name);
        const detection = await languageDetectionService.detectFromDescription(
          descriptionToAnalyze,
          task.title, // Additional context
          repoNames   // 🔥 LLM will convert to valid names (snake_case for Dart, kebab-case for npm, etc.)
        );
        detectedLanguage = detection.primary;
        context.setData('detectedLanguage', detectedLanguage);
        console.log(`✅ [Planning] Language detected: ${detectedLanguage.language}/${detectedLanguage.framework}`);
        console.log(`   Docker image: ${detectedLanguage.dockerImage}`);
        console.log(`   Confidence: ${detectedLanguage.confidence}`);
        if (detectedLanguage.projectName) {
          console.log(`   Project name: ${detectedLanguage.projectName}`);
        }
        if (detectedLanguage.createCmd) {
          console.log(`   Create command: ${detectedLanguage.createCmd}`);
        }

        // 🔥 AGNOSTIC: Emit EnvironmentConfigDefined event with LLM-determined devCmd
        // This allows DevServerService to use the correct command for preview
        if (detectedLanguage.devCmd) {
          const envConfig: Record<string, any> = {};
          // Use generic key for single-repo or first repo for multi-repo
          const repoKey = repositories.length > 0 ? repositories[0].name : 'default';
          envConfig[repoKey] = {
            language: detectedLanguage.language,
            framework: detectedLanguage.framework,
            installCommand: detectedLanguage.installCmd,
            runCommand: detectedLanguage.devCmd,  // 🔥 LLM-determined dev server command
            devPort: detectedLanguage.devPort,
            dockerImage: detectedLanguage.dockerImage,
          };

          await eventStore.append({
            taskId,
            eventType: 'EnvironmentConfigDefined',
            payload: envConfig,
          });
          console.log(`✅ [Planning] Emitted EnvironmentConfigDefined with devCmd: ${detectedLanguage.devCmd}`);
        }
      } catch (error: any) {
        console.warn(`⚠️ [Planning] Language detection failed: ${error.message}`);
      }
    } else {
      console.warn(`⚠️ [Planning] No task description or title available for language detection`);
    }

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
      // 🔥 REMOVED: projectId declaration - was only used by granularMemoryService

      // 🔥 PROGRAMMATIC CODEBASE DISCOVERY WITH CACHING
      // Checks: 1) Context (retry) → 2) Granular Memory (restart) → 3) Fresh scan
      console.log(`\n🔍 [PlanningPhase] Checking for cached codebase discovery...`);
      let codebaseKnowledge: CodebaseKnowledge | undefined;

      // 1️⃣ Check context first (from previous retry in same execution)
      codebaseKnowledge = context.getData('codebaseKnowledge') as CodebaseKnowledge | undefined;

      // 🔥 REMOVED: granularMemoryService cache check - SQLite is single source of truth

      // 2️⃣ Fresh scan if no cache
      if (!codebaseKnowledge) {
        console.log(`🔍 [PlanningPhase] Running fresh codebase discovery...`);
        try {
          codebaseKnowledge = await CodebaseDiscoveryService.discoverCodebase(effectiveWorkspacePath);
          context.setData('codebaseKnowledge', codebaseKnowledge);
          console.log(`✅ [PlanningPhase] Discovered ${codebaseKnowledge.helperFunctions.length} helper functions, ${codebaseKnowledge.entityCreationRules.length} entity rules`);
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

      // 🔥 REMOVED: granularMemoryService cache check - SQLite is single source of truth

      // 2️⃣ Fresh scan for missing repositories
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
              // 🔥 REMOVED: granularMemoryService.store - SQLite is single source of truth
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

      // 📦 POST-PLANNING SETUP: Create project structure and install dependencies if needed
      // This runs AFTER Planning because Planning determines the tech stack
      const sandboxMap = await this.setupProjectIfNeeded(
        taskId,
        effectiveWorkspacePath,
        repositories,
        projectRadiographies,
        parsed.architectureBrief,
        detectedLanguage  // 🔍 LLM-detected language from task.description
      );

      // 🔗 CRITICAL: Store sandbox map in context for ALL phases (TechLead, Developers, Judge, QA, Fixer)
      // Each phase needs to know which Docker sandbox to use for each repository
      if (sandboxMap.size > 0) {
        context.setData('sandboxMap', sandboxMap);
        context.setData('useSandbox', true); // Mark that sandboxes are available
        console.log(`🐳 [Planning] Stored sandbox map in context: ${sandboxMap.size} repo(s)`);
      }

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
      await eventStore.safeAppend({
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

      // 🔥 REMOVED: granularMemoryService calls - SQLite (task.orchestration) tracks all planning state

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

  // --------------------------------------------------------------------------
  // 📦 PROJECT SETUP: Create projects and install dependencies after Planning
  // --------------------------------------------------------------------------

  /**
   * Setup project structure and dependencies after Planning determines the tech stack.
   *
   * 🔥 ARCHITECTURE (2026-01-23): ONE SANDBOX PER TASK
   * - Creates a SINGLE multi-runtime sandbox per task
   * - Mounts ALL repos into /workspace/{repo-name}/
   * - Frontend can use localhost:3001 to reach backend (same container!)
   * - Simpler networking, simpler debugging
   *
   * This method:
   * 1. For NEW projects (empty repos): Creates project structure (flutter create, npm init, etc.)
   * 2. For ALL projects: Installs dependencies if dependency files exist
   *
   * Called AFTER Planning completes because Planning determines what technologies to use.
   */
  private async setupProjectIfNeeded(
    taskId: string,
    workspacePath: string,
    repositories: any[],
    projectRadiographies: Map<string, any>,
    architectureBrief: any,
    llmDetectedLanguage: DetectedLanguage | null  // 🔍 LLM-detected language from task.description
  ): Promise<Map<string, string>> {  // 🔗 Returns: repoName -> sandboxId map
    console.log(`\n📦 [Planning] Post-planning setup: checking project dependencies...`);

    // Initialize sandbox service (auto-detects/installs Docker if needed)
    await sandboxService.initialize();

    // Check if sandbox is available
    if (!sandboxService.isDockerAvailable()) {
      console.log(`   ⚠️ Docker not available, skipping Docker setup (commands will run on host)`);
      // Continue anyway - we'll try to run commands on host as fallback
    }

    // Configuration for project setup by language
    // Note: dockerImage is ignored now - we use multi-runtime image for everything
    const setupConfig: Record<string, {
      checkFile: string;
      createCmd?: string;
      installCmd: string;
      postCmds?: string[];
      dockerImage: string; // Kept for backward compatibility, but ignored
    }> = {
      flutter: {
        checkFile: 'pubspec.yaml',
        createCmd: 'flutter create . --org com.example --project-name app --overwrite',
        installCmd: 'flutter pub get',
        postCmds: ['flutter doctor -v'],
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      dart: {
        checkFile: 'pubspec.yaml',
        createCmd: 'dart create . --overwrite',
        installCmd: 'dart pub get',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      node: {
        checkFile: 'package.json',
        createCmd: 'npm init -y',
        installCmd: 'npm install',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      typescript: {
        checkFile: 'package.json',
        createCmd: 'npm init -y && npm install typescript @types/node -D && npx tsc --init',
        installCmd: 'npm install',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      python: {
        checkFile: 'requirements.txt',
        installCmd: 'pip install -r requirements.txt',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      go: {
        checkFile: 'go.mod',
        createCmd: 'go mod init app',
        installCmd: 'go mod download',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
      rust: {
        checkFile: 'Cargo.toml',
        createCmd: 'cargo init --force',
        installCmd: 'cargo fetch',
        dockerImage: 'multi-runtime', // Ignored - using multi-runtime
      },
    };

    // Get projectId from task
    const task = TaskRepository.findById(taskId);
    const projectId = task?.projectId?.toString() || taskId;

    // ==========================================================================
    // 🔥 STEP 1: Create ONE sandbox per TASK with ALL repos mounted
    // ==========================================================================
    const unifiedSandboxId = taskId; // ONE sandbox ID for the whole task
    let sandbox: any = null;
    let sandboxCreated = false;

    if (sandboxService.isDockerAvailable() && repositories.length > 0) {
      console.log(`\n   🐳 [Planning] Creating UNIFIED sandbox for task (multi-runtime image)`);
      console.log(`      Task: ${taskId}`);
      console.log(`      Repos: ${repositories.map(r => r.name).join(', ')}`);

      // Build workspace mounts: each repo gets mounted at /workspace/{repo-name}
      const workspaceMounts: Record<string, string> = {};
      for (const repo of repositories) {
        const hostPath = path.join(workspacePath, repo.name);
        const containerPath = `/workspace/${repo.name}`;
        workspaceMounts[hostPath] = containerPath;
        console.log(`      Mount: ${hostPath} → ${containerPath}`);
      }

      // Collect ALL ports from ALL repos for the unified sandbox
      const allPorts: string[] = [];
      // Common preview ports
      allPorts.push('0:3000');  // React/Vue/Angular
      allPorts.push('0:3001');  // Node.js backend
      allPorts.push('0:5000');  // Python Flask
      allPorts.push('0:8080');  // General purpose
      allPorts.push('0:5173');  // Vite
      allPorts.push('0:8000');  // Python Django/FastAPI

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🐳 Creating unified sandbox for all repos (multi-runtime: Flutter + Node.js + Python)`
      );

      // 🔥 AGNOSTIC: Use LLM-determined Docker image (not hardcoded)
      // For empty repos, the LLM decides everything - language, image, commands
      const dockerImage = llmDetectedLanguage?.dockerImage || 'ghcr.io/cirruslabs/flutter:stable';
      const language = llmDetectedLanguage?.language || 'multi-runtime';

      console.log(`   🤖 [Planning] LLM-determined config:`);
      console.log(`      Language: ${language}`);
      console.log(`      Docker Image: ${dockerImage}`);
      if (llmDetectedLanguage?.createCmd) {
        console.log(`      Create Command: ${llmDetectedLanguage.createCmd}`);
      }

      // Use sandboxPoolService to create the unified sandbox
      const result = await sandboxPoolService.findOrCreateSandbox(
        taskId,
        projectId,
        'unified', // Special repo name indicating unified sandbox
        [], // plannedFiles - not used
        workspacePath, // Base workspace path
        language, // 🔥 LLM-determined language (not hardcoded)
        {
          image: dockerImage, // 🔥 LLM-determined Docker image
          networkMode: 'bridge',
          memoryLimit: '8g',
          cpuLimit: '4',
          ports: allPorts,
          workspaceMounts, // Mount all repos
        },
        'fullstack' // Unified sandbox handles all types
      );

      sandbox = result.sandbox;
      sandboxCreated = !!sandbox;

      if (sandbox) {
        console.log(`   ✅ [Planning] Unified sandbox created: ${sandbox.containerName}`);
        if (sandbox.mappedPorts && Object.keys(sandbox.mappedPorts).length > 0) {
          console.log(`      🔌 Mapped ports:`);
          for (const [containerPort, hostPort] of Object.entries(sandbox.mappedPorts)) {
            console.log(`         ${containerPort} → ${hostPort} (http://localhost:${hostPort})`);
          }
        }
      } else {
        console.warn(`   ⚠️ [Planning] Failed to create unified sandbox, will use host execution`);
      }
    }

    // ==========================================================================
    // 🔥 STEP 2: Setup each repo WITHIN the unified sandbox
    // ==========================================================================

    // 🔗 Track sandbox info for each repo (all point to same sandbox)
    interface SandboxInfo {
      repoName: string;
      repoType: 'backend' | 'frontend' | 'fullstack' | 'unknown';
      repoPath: string;
      language: string;
      sandboxId: string;
      mappedPorts: Record<string, string>;
    }
    const sandboxInfos: SandboxInfo[] = [];

    for (const repo of repositories) {
      const repoPath = path.join(workspacePath, repo.name);
      const containerRepoPath = `/workspace/${repo.name}`; // Path INSIDE container
      const radiography = projectRadiographies.get(repo.name);

      // 🔍 PRIORITY 1: Radiography detection (existing code is source of truth)
      let language = radiography?.language?.primary?.toLowerCase() || 'unknown';
      if (language !== 'unknown') {
        console.log(`   📊 [${repo.name}] Using radiography-detected language: ${language}`);
      }

      // PRIORITY 2: LLM detection from task.description (for empty/new repos only)
      if (language === 'unknown' && llmDetectedLanguage && llmDetectedLanguage.confidence !== 'low') {
        language = llmDetectedLanguage.language;
        console.log(`   🤖 [${repo.name}] Using LLM-detected language: ${language} (empty repo, ${llmDetectedLanguage.confidence} confidence)`);
      }

      // PRIORITY 3: Architecture brief (from planning output)
      if (language === 'unknown' && architectureBrief?.techStack) {
        const techStack = architectureBrief.techStack.toLowerCase();
        if (techStack.includes('flutter')) language = 'flutter';
        else if (techStack.includes('dart')) language = 'dart';
        else if (techStack.includes('typescript')) language = 'typescript';
        else if (techStack.includes('node') || techStack.includes('javascript')) language = 'node';
        else if (techStack.includes('python')) language = 'python';
        else if (techStack.includes('go') || techStack.includes('golang')) language = 'go';
        else if (techStack.includes('rust')) language = 'rust';
      }

      // PRIORITY 4: Direct file detection (fallback)
      if (language === 'unknown') {
        if (fs.existsSync(path.join(repoPath, 'pubspec.yaml'))) {
          const pubspec = fs.readFileSync(path.join(repoPath, 'pubspec.yaml'), 'utf-8');
          language = pubspec.includes('flutter:') ? 'flutter' : 'dart';
          console.log(`   🔍 [${repo.name}] Detected ${language} from pubspec.yaml`);
        } else if (fs.existsSync(path.join(repoPath, 'package.json'))) {
          const pkgJson = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
          language = pkgJson.devDependencies?.typescript || pkgJson.dependencies?.typescript ? 'typescript' : 'node';
          console.log(`   🔍 [${repo.name}] Detected ${language} from package.json`);
        } else if (fs.existsSync(path.join(repoPath, 'requirements.txt')) || fs.existsSync(path.join(repoPath, 'pyproject.toml'))) {
          language = 'python';
          console.log(`   🔍 [${repo.name}] Detected python from requirements.txt/pyproject.toml`);
        } else if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
          language = 'go';
          console.log(`   🔍 [${repo.name}] Detected go from go.mod`);
        } else if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) {
          language = 'rust';
          console.log(`   🔍 [${repo.name}] Detected rust from Cargo.toml`);
        }
      }

      // 🔍 PRIORITY: Use LLM-determined commands when available (100% agnostic)
      // BUT ONLY if the LLM-detected language MATCHES the repo's detected language
      const llmLanguageMatch = llmDetectedLanguage && (
        llmDetectedLanguage.language === language ||
        llmDetectedLanguage.framework === language ||
        llmDetectedLanguage.ecosystem === language
      );

      const llmConfig = llmLanguageMatch ? {
        checkFile: llmDetectedLanguage!.checkFile,
        createCmd: llmDetectedLanguage!.createCmd,
        installCmd: llmDetectedLanguage!.installCmd,
      } : null;
      const hardcodedConfig = setupConfig[language];

      // Merge: LLM takes priority, hardcoded as fallback
      const config = {
        checkFile: llmConfig?.checkFile || hardcodedConfig?.checkFile,
        createCmd: llmConfig?.createCmd || hardcodedConfig?.createCmd,
        installCmd: llmConfig?.installCmd || hardcodedConfig?.installCmd,
        postCmds: hardcodedConfig?.postCmds,
      };

      if (!config.checkFile) {
        console.log(`   ℹ️ [${repo.name}] No setup config for language: ${language}`);
        await this.createEnvIfNeeded(taskId, repoPath, repo.name, language, repo.type || 'unknown');
        continue;
      }

      // Log which config source we're using
      if (llmConfig?.createCmd) {
        console.log(`   🤖 [${repo.name}] Using LLM-determined setup commands (language match: ${language})`);
      } else if (llmDetectedLanguage && !llmLanguageMatch) {
        console.log(`   ⚠️ [${repo.name}] LLM language mismatch: repo=${language}, LLM=${llmDetectedLanguage.language}/${llmDetectedLanguage.framework} - using hardcoded config`);
      }
      if (!llmConfig?.createCmd && hardcodedConfig) {
        console.log(`   📦 [${repo.name}] Using hardcoded setup config for ${language}`);
      }

      const depFilePath = path.join(repoPath, config.checkFile);
      const depFileExists = fs.existsSync(depFilePath);

      // Determine if we need to create a new project
      const needsProjectCreation = !depFileExists && config.createCmd;

      // Track this repo's sandbox info (points to unified sandbox)
      if (sandboxCreated) {
        sandboxInfos.push({
          repoName: repo.name,
          repoType: repo.type || 'unknown',
          repoPath,
          language,
          sandboxId: unifiedSandboxId,
          mappedPorts: sandbox?.mappedPorts || {},
        });
      }

      // Use unified sandbox ID for exec
      const execId = sandboxCreated ? unifiedSandboxId : taskId;
      // Working directory inside container
      const cwdInContainer = sandboxCreated ? containerRepoPath : repoPath;

      if (needsProjectCreation) {
        // NEW PROJECT: Create project structure
        console.log(`   🆕 [${repo.name}] No ${config.checkFile} found - creating ${language} project...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🆕 Creating ${language} project in ${repo.name}...`
        );

        const createResult = await sandboxService.exec(execId, config.createCmd!, {
          cwd: cwdInContainer,
          timeout: 300000, // 5 minutes for project creation
        });

        if (createResult.exitCode === 0) {
          console.log(`   ✅ [${repo.name}] Project created successfully (executed in: ${createResult.executedIn})`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ ${language} project created in ${repo.name}`);
        } else {
          console.warn(`   ⚠️ [${repo.name}] Project creation failed: ${createResult.stderr}`);
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️ Project creation failed in ${repo.name} - developers will need to initialize manually`
          );
          await this.createEnvIfNeeded(taskId, repoPath, repo.name, language, repo.type || 'unknown');
          continue;
        }
      }

      // Check again after potential creation
      const depFileExistsNow = fs.existsSync(path.join(repoPath, config.checkFile));

      if (depFileExistsNow) {
        // Check if dependencies were already installed
        const alreadyInstalled = this.checkDependenciesInstalled(repoPath, language);

        if (alreadyInstalled && depFileExists) {
          console.log(`   ⏭️ [${repo.name}] Dependencies already installed (skipping)`);
          await this.createEnvIfNeeded(taskId, repoPath, repo.name, language, repo.type || 'unknown');
          continue;
        }

        // INSTALL DEPENDENCIES
        console.log(`   📦 [${repo.name}] Installing dependencies: ${config.installCmd}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📦 Installing dependencies in ${repo.name}: ${config.installCmd}`
        );

        const installResult = await sandboxService.exec(execId, config.installCmd, {
          cwd: cwdInContainer,
          timeout: 600000, // 10 minutes for install
        });

        if (installResult.exitCode === 0) {
          console.log(`   ✅ [${repo.name}] Dependencies installed successfully (executed in: ${installResult.executedIn})`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Dependencies installed in ${repo.name}`);

          // Run post-install commands if any
          if (config.postCmds) {
            for (const cmd of config.postCmds) {
              console.log(`   🔧 [${repo.name}] Running: ${cmd}`);
              const postResult = await sandboxService.exec(execId, cmd, {
                cwd: cwdInContainer,
                timeout: 60000,
              });
              console.log(`      → Exit code: ${postResult.exitCode}, executed in: ${postResult.executedIn}`);
            }
          }

          // 🚀 AUTO-START PREVIEW SERVER: Start dev server in background
          if (sandboxCreated) {
            const previewPort = await this.startPreviewServer(
              taskId,
              unifiedSandboxId, // Use unified sandbox ID
              language,
              repo.type || 'unknown',
              repoPath,
              repo.name
            );

            if (previewPort) {
              NotificationService.emitConsoleLog(
                taskId,
                'info',
                `🌐 Preview available at http://localhost:${previewPort} - agents can verify changes with curl`
              );
            }
          }
        } else {
          console.warn(`   ⚠️ [${repo.name}] Install failed (executed in: ${installResult.executedIn}): ${installResult.stderr}`);
          NotificationService.emitConsoleLog(
            taskId,
            'warn',
            `⚠️ Dependency installation failed in ${repo.name} - developers may need to install manually`
          );
        }
      } else {
        console.log(`   ℹ️ [${repo.name}] No ${config.checkFile} - skipping dependency install`);
      }

      // 🔐 Create .env template if missing
      await this.createEnvIfNeeded(taskId, repoPath, repo.name, language, repo.type || 'unknown');
    }

    // ==========================================================================
    // 🔥 STEP 3: Cross-project configuration (same container, simpler networking!)
    // ==========================================================================

    // 🔗 CROSS-PROJECT PORT INJECTION
    // In unified sandbox, all services run in SAME container, so frontend
    // can use localhost:3001 to reach backend directly!
    if (sandboxInfos.length > 0) {
      console.log(`\n   🔗 [Planning] Configuring cross-service communication (same container)`);
      console.log(`      Frontend can use localhost:3001 to reach backend - no port mapping needed!`);
      // Still run injection for external access from host
      await this.injectBackendPortsIntoFrontends(taskId, sandboxInfos);
    }

    // Log unified sandbox status
    if (sandboxCreated) {
      console.log(`\n   🐳 [Planning] UNIFIED SANDBOX STATUS:`);
      console.log(`      ID: ${unifiedSandboxId}`);
      console.log(`      Container: ${sandbox?.containerName}`);
      console.log(`      Repos mounted: ${repositories.length}`);
      console.log(`      Image: multi-runtime (Flutter + Node.js + Python)`);
      console.log(`      Sandbox will remain available for all subsequent phases`);
    }

    console.log(`\n📦 [Planning] Post-planning setup complete\n`);

    // 🔗 Return sandbox map: repoName -> sandboxId
    // ALL repos point to the SAME unified sandbox
    const sandboxMap = new Map<string, string>();
    for (const repo of repositories) {
      sandboxMap.set(repo.name, unifiedSandboxId);
      console.log(`   📍 Sandbox map: ${repo.name} → ${unifiedSandboxId} (unified)`);
    }

    return sandboxMap;
  }

  /**
   * 🔗 Inject backend's actual port into frontend .env files
   *
   * SMART APPROACH:
   * 1. Read backend's .env (or .env.example) to find configured PORT
   * 2. Read frontend's .env (or .env.example) to find API URL variables
   * 3. Replace the backend port in frontend's URLs with the actual mapped port
   *
   * This is intelligent because:
   * - We don't assume variable names
   * - We use the actual project configuration
   * - We handle .env.example as fallback
   */
  private async injectBackendPortsIntoFrontends(
    taskId: string,
    sandboxInfos: Array<{
      repoName: string;
      repoType: 'backend' | 'frontend' | 'fullstack' | 'unknown';
      repoPath: string;
      language: string;
      sandboxId: string;
      mappedPorts: Record<string, string>;
    }>
  ): Promise<void> {
    const backendInfos = sandboxInfos.filter(s => s.repoType === 'backend');
    const frontendInfos = sandboxInfos.filter(s => s.repoType === 'frontend');

    if (backendInfos.length === 0 || frontendInfos.length === 0) {
      console.log(`   ℹ️ [Planning] No backend/frontend pair found for port injection`);
      return;
    }

    const backendInfo = backendInfos[0];

    // 📖 STEP 1: Read backend's .env to find its configured PORT
    const backendConfiguredPort = this.readBackendPort(backendInfo.repoPath, backendInfo.repoName);
    console.log(`   📖 [${backendInfo.repoName}] Configured PORT: ${backendConfiguredPort || 'not found'}`);

    // 🔌 STEP 2: Find the actual host port from Docker mapping
    const backendPorts = backendInfo.mappedPorts;
    let backendHostPort: string | null = null;

    // First try to find the configured port in mappings
    if (backendConfiguredPort && backendPorts[backendConfiguredPort]) {
      backendHostPort = backendPorts[backendConfiguredPort];
      console.log(`   🔌 [Planning] Backend mapped: container:${backendConfiguredPort} → host:${backendHostPort}`);
    } else {
      // Fallback: try common backend ports
      const commonPorts = ['3001', '8000', '8080', '5000', '5001'];
      for (const port of commonPorts) {
        if (backendPorts[port]) {
          backendHostPort = backendPorts[port];
          console.log(`   🔌 [Planning] Backend mapped (fallback): container:${port} → host:${backendHostPort}`);
          break;
        }
      }
    }

    if (!backendHostPort) {
      // Last resort: use first available mapped port
      const firstPort = Object.entries(backendPorts)[0];
      if (firstPort) {
        backendHostPort = firstPort[1];
        console.log(`   🔌 [Planning] Backend mapped (first available): container:${firstPort[0]} → host:${backendHostPort}`);
      }
    }

    if (!backendHostPort) {
      console.warn(`   ⚠️ [Planning] Could not determine backend host port`);
      return;
    }

    // 📝 STEP 3: Update frontend .env files
    for (const frontendInfo of frontendInfos) {
      await this.updateFrontendEnvWithBackendPort(
        taskId,
        frontendInfo,
        backendInfo.repoName,
        backendConfiguredPort || '3001', // Port to search for in frontend .env
        backendHostPort                   // Actual host port to replace with
      );
    }
  }

  /**
   * Read the PORT configuration from a backend's .env or .env.example
   */
  private readBackendPort(repoPath: string, repoName: string): string | null {
    // Try .env first, then .env.example
    const envFiles = ['.env', '.env.example', '.env.local'];

    for (const envFile of envFiles) {
      const envPath = path.join(repoPath, envFile);
      if (fs.existsSync(envPath)) {
        try {
          const content = fs.readFileSync(envPath, 'utf-8');

          // Look for PORT=XXXX pattern
          const portMatch = content.match(/^PORT=(\d+)/m);
          if (portMatch) {
            console.log(`   📖 [${repoName}] Found PORT=${portMatch[1]} in ${envFile}`);
            return portMatch[1];
          }

          // Also check for common variations
          const serverPortMatch = content.match(/^(?:SERVER_PORT|APP_PORT|HTTP_PORT)=(\d+)/m);
          if (serverPortMatch) {
            console.log(`   📖 [${repoName}] Found port ${serverPortMatch[1]} in ${envFile}`);
            return serverPortMatch[1];
          }
        } catch (error: any) {
          console.warn(`   ⚠️ [${repoName}] Could not read ${envFile}: ${error.message}`);
        }
      }
    }

    // If no .env found, try to detect from code (package.json scripts, etc.)
    const packageJsonPath = path.join(repoPath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        // Check for port in scripts
        const scripts = pkg.scripts || {};
        for (const script of Object.values(scripts) as string[]) {
          const portMatch = script.match(/(?:--port|PORT=|:)(\d{4,5})/);
          if (portMatch) {
            console.log(`   📖 [${repoName}] Detected port ${portMatch[1]} from package.json scripts`);
            return portMatch[1];
          }
        }
      } catch {
        // Ignore
      }
    }

    return null;
  }

  /**
   * Update a frontend's .env file with the backend's actual port
   */
  private async updateFrontendEnvWithBackendPort(
    taskId: string,
    frontendInfo: { repoName: string; repoPath: string; language: string },
    backendRepoName: string,
    backendConfiguredPort: string,
    backendHostPort: string
  ): Promise<void> {
    // Find the frontend's .env (or create from .env.example)
    const envPath = path.join(frontendInfo.repoPath, '.env');
    const envExamplePath = path.join(frontendInfo.repoPath, '.env.example');

    let envContent: string | null = null;
    let sourceFile = '';

    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf-8');
      sourceFile = '.env';
    } else if (fs.existsSync(envExamplePath)) {
      // Copy .env.example to .env
      envContent = fs.readFileSync(envExamplePath, 'utf-8');
      sourceFile = '.env.example (copied to .env)';
      console.log(`   📋 [${frontendInfo.repoName}] Creating .env from .env.example`);
    }

    if (!envContent) {
      console.log(`   ℹ️ [${frontendInfo.repoName}] No .env or .env.example found`);
      return;
    }

    // 🔍 Find and replace URLs pointing to the backend port
    // Pattern: ANY_VAR=http(s)://localhost:BACKEND_PORT(optional path)
    const httpPattern = new RegExp(
      `^([A-Z_][A-Z0-9_]*=https?:\\/\\/localhost:)${backendConfiguredPort}(.*)$`,
      'gm'
    );
    const wsPattern = new RegExp(
      `^([A-Z_][A-Z0-9_]*=wss?:\\/\\/localhost:)${backendConfiguredPort}(.*)$`,
      'gm'
    );

    let updated = false;
    const originalContent = envContent;

    if (httpPattern.test(envContent)) {
      httpPattern.lastIndex = 0;
      envContent = envContent.replace(httpPattern, `$1${backendHostPort}$2`);
      updated = true;
    }

    if (wsPattern.test(envContent)) {
      wsPattern.lastIndex = 0;
      envContent = envContent.replace(wsPattern, `$1${backendHostPort}$2`);
      updated = true;
    }

    // Also try common backend ports if the configured port didn't match anything
    if (!updated && backendConfiguredPort !== '3001') {
      const fallbackPorts = ['3001', '8000', '8080', '5000'];
      for (const port of fallbackPorts) {
        const fallbackHttp = new RegExp(
          `^([A-Z_][A-Z0-9_]*=https?:\\/\\/localhost:)${port}(.*)$`,
          'gm'
        );
        const fallbackWs = new RegExp(
          `^([A-Z_][A-Z0-9_]*=wss?:\\/\\/localhost:)${port}(.*)$`,
          'gm'
        );

        if (fallbackHttp.test(envContent)) {
          fallbackHttp.lastIndex = 0;
          envContent = envContent.replace(fallbackHttp, `$1${backendHostPort}$2`);
          updated = true;
        }
        if (fallbackWs.test(envContent)) {
          fallbackWs.lastIndex = 0;
          envContent = envContent.replace(fallbackWs, `$1${backendHostPort}$2`);
          updated = true;
        }
      }
    }

    if (updated || sourceFile.includes('copied')) {
      fs.writeFileSync(envPath, envContent, 'utf-8');

      // Log what changed
      const changedLines: string[] = [];
      const origLines = originalContent.split('\n');
      const newLines = envContent.split('\n');
      for (let i = 0; i < newLines.length; i++) {
        if (origLines[i] !== newLines[i] && newLines[i].includes('localhost')) {
          changedLines.push(newLines[i].split('=')[0]);
        }
      }

      console.log(`   🔗 [${frontendInfo.repoName}] Updated from ${sourceFile}`);
      if (changedLines.length > 0) {
        console.log(`      Variables updated: ${changedLines.join(', ')}`);
      }
      console.log(`      Backend port: ${backendConfiguredPort} → ${backendHostPort}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔗 Connected ${frontendInfo.repoName} to ${backendRepoName} (port ${backendHostPort})`
      );
    } else {
      console.log(`   ℹ️ [${frontendInfo.repoName}] No backend URLs found to update in ${sourceFile}`);
    }
  }

  /**
   * Check if dependencies are already installed by looking for lock files or deps folders
   */
  private checkDependenciesInstalled(repoPath: string, language: string): boolean {
    const indicators: Record<string, string[]> = {
      flutter: ['pubspec.lock', '.dart_tool'],
      dart: ['pubspec.lock', '.dart_tool'],
      node: ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      typescript: ['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'],
      python: ['.venv', 'venv', '__pycache__'],
      go: ['go.sum'],
      rust: ['Cargo.lock', 'target'],
    };

    const indicatorFiles = indicators[language] || [];

    for (const indicator of indicatorFiles) {
      if (fs.existsSync(path.join(repoPath, indicator))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the preview/dev server command based on language and project type
   * Returns null if no preview command is applicable
   */
  private getPreviewCommand(language: string, repoType: string, repoPath: string): { command: string; port: number } | null {
    // Check for specific config files to determine the right command
    const hasVite = fs.existsSync(path.join(repoPath, 'vite.config.ts')) ||
                    fs.existsSync(path.join(repoPath, 'vite.config.js'));
    const hasNext = fs.existsSync(path.join(repoPath, 'next.config.js')) ||
                    fs.existsSync(path.join(repoPath, 'next.config.mjs'));
    const hasPackageJson = fs.existsSync(path.join(repoPath, 'package.json'));

    // Read package.json to check for dev script
    let packageJson: any = null;
    if (hasPackageJson) {
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8'));
      } catch {
        // Ignore parse errors
      }
    }

    const hasDevScript = packageJson?.scripts?.dev;
    const hasStartScript = packageJson?.scripts?.start;

    // Determine command based on language and framework
    switch (language) {
      case 'flutter':
        // 🔥 For Flutter, startPreviewServer handles build+serve separately
        // This command is only used if the server needs restart
        return {
          command: 'python3 -m http.server 8080 --bind 0.0.0.0',
          port: 8080
        };

      case 'node':
      case 'typescript':
        if (hasVite) {
          return { command: 'npm run dev -- --host 0.0.0.0', port: 5173 };
        }
        if (hasNext) {
          return { command: 'npm run dev -- -H 0.0.0.0', port: 3000 };
        }
        if (hasDevScript) {
          return { command: 'npm run dev', port: 3000 };
        }
        if (hasStartScript && repoType === 'backend') {
          return { command: 'npm start', port: 3001 };
        }
        return null; // No suitable dev command found

      case 'python':
        if (fs.existsSync(path.join(repoPath, 'manage.py'))) {
          return { command: 'python manage.py runserver 0.0.0.0:8000', port: 8000 };
        }
        if (fs.existsSync(path.join(repoPath, 'app.py')) || fs.existsSync(path.join(repoPath, 'main.py'))) {
          return { command: 'python -m flask run --host=0.0.0.0 --port=5000', port: 5000 };
        }
        return null;

      case 'go':
        if (fs.existsSync(path.join(repoPath, 'main.go'))) {
          return { command: 'go run . &', port: 8080 };
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Start preview server in Docker container (runs in background)
   * Returns the port number if successful, null otherwise
   */
  private async startPreviewServer(
    taskId: string,
    sandboxId: string,
    language: string,
    repoType: string,
    repoPath: string,
    repoName: string
  ): Promise<number | null> {
    const previewConfig = this.getPreviewCommand(language, repoType, repoPath);

    if (!previewConfig) {
      console.log(`   ℹ️ [${repoName}] No preview server configured for ${language}`);
      return null;
    }

    const { command, port } = previewConfig;

    console.log(`   🚀 [${repoName}] Starting preview server on port ${port}...`);
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🚀 Starting preview server for ${repoName} on port ${port}`
    );

    try {
      // 🔥 For Flutter: separate build from serve (build is slow, serve is fast)
      const isFlutter = language === 'flutter';

      if (isFlutter) {
        // Step 1: Build Flutter web (synchronous, can take 60-120 seconds)
        console.log(`   ⏳ [${repoName}] Building Flutter web (this may take 1-2 minutes)...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `⏳ Building Flutter web... (1-2 minutes)`
        );

        const buildResult = await sandboxService.exec(sandboxId, 'flutter build web --release 2>&1', {
          cwd: '/workspace',
          timeout: 180000, // 3 minutes for Flutter build
        });

        if (buildResult.exitCode !== 0) {
          console.warn(`   ⚠️ [${repoName}] Flutter build failed: ${buildResult.stderr || buildResult.stdout}`);
          return null;
        }

        console.log(`   ✅ [${repoName}] Flutter build complete!`);

        // Step 2: Start simple HTTP server in background
        // Note: Health check will verify if server is actually responding (agnostic approach)
        const serveCmd = `nohup python3 -m http.server ${port} --bind 0.0.0.0 > /tmp/preview-server.log 2>&1 &`;
        await sandboxService.exec(sandboxId, serveCmd, {
          cwd: '/workspace/build/web',
          timeout: 5000,
        });
      } else {
        // Non-Flutter: run dev server in background as before
        const bgCommand = `nohup ${command} > /tmp/preview-server.log 2>&1 &`;

        const result = await sandboxService.exec(sandboxId, bgCommand, {
          cwd: '/workspace',
          timeout: 30000, // 30 seconds to start
        });

        if (result.exitCode !== 0) {
          console.warn(`   ⚠️ [${repoName}] Failed to start preview server: ${result.stderr}`);
          return null;
        }
      }

      // Wait a bit for server to start
      const waitTime = isFlutter ? 2000 : 3000; // Flutter server starts fast after build
      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Check if server is responding (inside container)
      const healthCheck = await sandboxService.exec(sandboxId, `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} || echo "000"`, {
        cwd: '/workspace',
        timeout: 10000,
      });

      const statusCode = healthCheck.stdout.trim();

      // 🔥 CRITICAL: Get the HOST port (not container port) for the preview URL
      // With dynamic port mapping (0:PORT), the container port is mapped to a different host port
      const sandbox = sandboxService.getSandbox(sandboxId);
      const hostPort = sandbox?.mappedPorts?.[String(port)] || String(port);
      const previewUrl = `http://localhost:${hostPort}`;
      console.log(`   🔌 [${repoName}] Port mapping: container:${port} → host:${hostPort}`);
      // Map language to framework name for frontend display
      const frameworkMap: Record<string, string> = {
        flutter: 'Flutter Web',
        nodejs: 'Node.js',
        python: 'Python',
        default: language,
      };
      const framework = frameworkMap[language] || frameworkMap.default;

      if (statusCode !== '000' && statusCode !== '') {
        console.log(`   ✅ [${repoName}] Preview server started on port ${port} (status: ${statusCode})`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Preview server running at ${previewUrl}`
        );
        // 🔥 Emit dev_server_ready for frontend auto-connect
        NotificationService.emitDevServerReady(taskId, previewUrl, framework);
        return port;
      } else {
        // Health check failed - retry a few times for slow-starting servers
        console.log(`   ⏳ [${repoName}] Server not responding yet, retrying health check...`);

        let retrySuccess = false;
        for (let retry = 0; retry < 3; retry++) {
          await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 seconds between retries

          const retryCheck = await sandboxService.exec(sandboxId, `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port} || echo "000"`, {
            cwd: '/workspace',
            timeout: 10000,
          });

          const retryStatus = retryCheck.stdout.trim();
          console.log(`   🔄 [${repoName}] Retry ${retry + 1}/3: status=${retryStatus}`);

          if (retryStatus !== '000' && retryStatus !== '') {
            console.log(`   ✅ [${repoName}] Preview server responding after ${retry + 1} retries`);
            NotificationService.emitConsoleLog(
              taskId,
              'info',
              `✅ Preview server running at ${previewUrl}`
            );
            NotificationService.emitDevServerReady(taskId, previewUrl, framework);
            retrySuccess = true;
            return port;
          }
        }

        if (!retrySuccess) {
          // After all retries failed, check if process is at least running
          const psCheck = await sandboxService.exec(sandboxId, `pgrep -f "http.server" || pgrep -f "npm" || pgrep -f "node" || echo "none"`, {
            timeout: 5000,
          });

          if (psCheck.stdout.trim() !== 'none') {
            console.log(`   ⚠️ [${repoName}] Server process running but not responding - emitting anyway`);
            NotificationService.emitConsoleLog(
              taskId,
              'warn',
              `⚠️ Preview server starting... (may need more time)`
            );
            NotificationService.emitDevServerReady(taskId, previewUrl, framework);
            return port;
          } else {
            console.warn(`   ❌ [${repoName}] Preview server failed to start - no process found`);
            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `❌ Preview server failed to start for ${repoName}`
            );
            return null; // Don't emit dev_server_ready if server never started
          }
        }

        return null; // Should not reach here, but TypeScript needs this
      }
    } catch (error: any) {
      console.warn(`   ⚠️ [${repoName}] Preview server start error: ${error.message}`);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // 🔐 ENV TEMPLATE: Create .env files for new projects
  // --------------------------------------------------------------------------

  /**
   * Create a .env template for a new project based on its language/framework.
   *
   * Templates include:
   * - Common placeholders (PORT, DATABASE_URL, etc.)
   * - Language-specific variables
   * - Clear comments explaining each variable
   *
   * The .env file is created as a TEMPLATE - developers must fill in actual values.
   */
  private async createEnvIfNeeded(
    taskId: string,
    repoPath: string,
    repoName: string,
    language: string,
    repoType: 'backend' | 'frontend' | 'fullstack' | 'unknown'
  ): Promise<void> {
    const envPath = path.join(repoPath, '.env');
    const envExamplePath = path.join(repoPath, '.env.example');

    // Skip if .env or .env.example already exists
    if (fs.existsSync(envPath) || fs.existsSync(envExamplePath)) {
      console.log(`   ℹ️ [${repoName}] .env already exists - skipping template creation`);
      return;
    }

    // Generate template based on language and repo type
    const envContent = this.generateEnvTemplate(language, repoType, repoName);

    if (!envContent) {
      console.log(`   ℹ️ [${repoName}] No .env template for language: ${language}`);
      return;
    }

    try {
      // Create both .env (for immediate use) and .env.example (for git)
      fs.writeFileSync(envPath, envContent, 'utf-8');
      fs.writeFileSync(envExamplePath, envContent, 'utf-8');

      console.log(`   🔐 [${repoName}] Created .env template for ${language}/${repoType}`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔐 Created .env template in ${repoName} - fill in actual values before running`
      );

      // Also create .gitignore if it doesn't exist (to exclude .env)
      await this.ensureGitignore(repoPath, repoName);
    } catch (error: any) {
      console.warn(`   ⚠️ [${repoName}] Failed to create .env: ${error.message}`);
    }
  }

  /**
   * Generate .env template content based on language and repository type.
   *
   * Each template includes:
   * - Header with project name and generation date
   * - Required variables for the tech stack
   * - Optional variables with sensible defaults
   * - Comments explaining each section
   */
  private generateEnvTemplate(
    language: string,
    repoType: 'backend' | 'frontend' | 'fullstack' | 'unknown',
    repoName: string
  ): string | null {
    const timestamp = new Date().toISOString();
    const header = `# ============================================================================
# ${repoName} - Environment Configuration
# ============================================================================
# Generated by Multi-Agent Platform on ${timestamp}
#
# ⚠️  IMPORTANT: This is a TEMPLATE. Fill in actual values before running!
# ⚠️  NEVER commit this file to git with real secrets!
# ============================================================================

`;

    // Node.js / TypeScript Backend
    if ((language === 'node' || language === 'typescript') && repoType === 'backend') {
      return header + `# Application
NODE_ENV=development
PORT=3001

# Database (choose one and fill in)
# MongoDB
MONGODB_URI=mongodb://localhost:27017/${repoName}

# PostgreSQL (alternative)
# DATABASE_URL=postgresql://user:password@localhost:5432/${repoName}

# Authentication
JWT_SECRET=CHANGE_ME_use_openssl_rand_base64_32
JWT_REFRESH_SECRET=CHANGE_ME_use_openssl_rand_base64_32
SESSION_SECRET=CHANGE_ME_use_openssl_rand_base64_32

# External APIs (fill in as needed)
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# STRIPE_SECRET_KEY=sk_test_...

# OAuth (if using social login)
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=
# GOOGLE_CLIENT_ID=
# GOOGLE_CLIENT_SECRET=

# CORS
FRONTEND_URL=http://localhost:3000

# Logging
LOG_LEVEL=debug

# Redis (if using caching/sessions)
# REDIS_URL=redis://localhost:6379

# File Storage (if using uploads)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_S3_BUCKET=
# AWS_REGION=us-east-1
`;
    }

    // Node.js / TypeScript Frontend (React, Next.js, etc.)
    if ((language === 'node' || language === 'typescript') && repoType === 'frontend') {
      return header + `# Application
NODE_ENV=development
PORT=3000

# API Configuration
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_WS_URL=ws://localhost:3001

# For Create React App (use REACT_APP_ prefix)
# REACT_APP_API_URL=http://localhost:3001/api

# Authentication
NEXT_PUBLIC_AUTH_ENABLED=true

# Feature Flags
NEXT_PUBLIC_FEATURE_DARK_MODE=true
NEXT_PUBLIC_FEATURE_ANALYTICS=false

# Analytics (if using)
# NEXT_PUBLIC_GA_TRACKING_ID=G-XXXXXXXXXX
# NEXT_PUBLIC_MIXPANEL_TOKEN=

# External Services
# NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
# NEXT_PUBLIC_SENTRY_DSN=

# OAuth (client-side)
# NEXT_PUBLIC_GITHUB_CLIENT_ID=
# NEXT_PUBLIC_GOOGLE_CLIENT_ID=
`;
    }

    // Flutter / Dart
    if (language === 'flutter' || language === 'dart') {
      return header + `# API Configuration
API_BASE_URL=http://localhost:3001/api
WS_URL=ws://localhost:3001

# Environment
ENVIRONMENT=development

# Feature Flags
ENABLE_ANALYTICS=false
ENABLE_CRASHLYTICS=false

# API Keys (for Flutter apps, consider using --dart-define or .env with flutter_dotenv)
# GOOGLE_MAPS_API_KEY=
# FIREBASE_API_KEY=
# STRIPE_PUBLISHABLE_KEY=

# OAuth
# GOOGLE_CLIENT_ID=
# FACEBOOK_APP_ID=

# Deep Linking
APP_SCHEME=${repoName.toLowerCase().replace(/-/g, '')}
APP_HOST=app.example.com

# Note: For Flutter, install flutter_dotenv package:
# flutter pub add flutter_dotenv
# Then add .env to assets in pubspec.yaml
`;
    }

    // Python
    if (language === 'python') {
      return header + `# Application
FLASK_ENV=development
# Or for Django:
# DJANGO_SETTINGS_MODULE=${repoName}.settings.development
# DJANGO_SECRET_KEY=CHANGE_ME_use_secrets_token_hex_32

DEBUG=True
PORT=5000

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/${repoName}
# Or for SQLite:
# DATABASE_URL=sqlite:///db.sqlite3

# Redis (for Celery, caching)
# REDIS_URL=redis://localhost:6379

# Authentication
SECRET_KEY=CHANGE_ME_use_secrets_token_hex_32
JWT_SECRET_KEY=CHANGE_ME_use_secrets_token_hex_32

# CORS
CORS_ORIGINS=http://localhost:3000

# External APIs
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# Email (if using)
# SMTP_HOST=smtp.gmail.com
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASSWORD=

# AWS (if using)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_S3_BUCKET=
`;
    }

    // Go
    if (language === 'go') {
      return header + `# Application
APP_ENV=development
PORT=8080

# Database
DATABASE_URL=postgres://user:password@localhost:5432/${repoName}?sslmode=disable
# Or for MySQL:
# DATABASE_URL=mysql://user:password@localhost:3306/${repoName}

# Redis
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=CHANGE_ME_use_secure_random_string
JWT_EXPIRATION=24h

# CORS
ALLOWED_ORIGINS=http://localhost:3000

# Logging
LOG_LEVEL=debug
LOG_FORMAT=json

# External APIs
# ANTHROPIC_API_KEY=
# STRIPE_SECRET_KEY=
`;
    }

    // Rust
    if (language === 'rust') {
      return header + `# Application
RUST_ENV=development
RUST_LOG=debug
PORT=8080

# Database
DATABASE_URL=postgres://user:password@localhost:5432/${repoName}

# Redis
REDIS_URL=redis://localhost:6379

# Authentication
JWT_SECRET=CHANGE_ME_use_secure_random_string

# CORS
ALLOWED_ORIGINS=http://localhost:3000
`;
    }

    // Fullstack or unknown - basic template
    if (repoType === 'fullstack' || repoType === 'unknown') {
      return header + `# Application
NODE_ENV=development
PORT=3000

# Database
DATABASE_URL=mongodb://localhost:27017/${repoName}
# Or PostgreSQL:
# DATABASE_URL=postgresql://user:password@localhost:5432/${repoName}

# Authentication
JWT_SECRET=CHANGE_ME_generate_secure_secret
SESSION_SECRET=CHANGE_ME_generate_secure_secret

# API URLs
API_BASE_URL=http://localhost:3001/api

# External Services (fill in as needed)
# Add your API keys here
`;
    }

    return null;
  }

  /**
   * Ensure .gitignore exists and includes .env
   */
  private async ensureGitignore(repoPath: string, repoName: string): Promise<void> {
    const gitignorePath = path.join(repoPath, '.gitignore');

    // Essential patterns to ignore
    const essentialPatterns = [
      '# Environment files',
      '.env',
      '.env.local',
      '.env.*.local',
      '',
      '# Dependencies',
      'node_modules/',
      '.dart_tool/',
      'build/',
      'dist/',
      '',
      '# IDE',
      '.idea/',
      '.vscode/',
      '*.swp',
      '*.swo',
      '.DS_Store',
    ];

    if (fs.existsSync(gitignorePath)) {
      // Check if .env is already in .gitignore
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (!content.includes('.env')) {
        // Append .env to existing .gitignore
        const appendContent = '\n\n# Environment files (auto-added)\n.env\n.env.local\n.env.*.local\n';
        fs.appendFileSync(gitignorePath, appendContent, 'utf-8');
        console.log(`   📝 [${repoName}] Added .env to existing .gitignore`);
      }
    } else {
      // Create new .gitignore
      const content = essentialPatterns.join('\n');
      fs.writeFileSync(gitignorePath, content, 'utf-8');
      console.log(`   📝 [${repoName}] Created .gitignore with essential patterns`);
    }
  }
}
