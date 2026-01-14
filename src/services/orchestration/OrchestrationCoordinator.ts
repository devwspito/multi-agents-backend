import { Task, ITask } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { FailedExecution, FailureType } from '../../models/FailedExecution';
import { GitHubService } from '../GitHubService';
// PRManagementService REMOVED - AutoMergePhase creates its own instance
import { ContextCompactionService } from '../ContextCompactionService';
import { NotificationService } from '../NotificationService';
import { AgentActivityService } from '../AgentActivityService';
import { OrchestrationContext, IPhase, PhaseResult } from './Phase';
import { createTaskLogger } from '../../utils/structuredLogger';
import { PlanningPhase } from './PlanningPhase';
// Legacy phases REMOVED: ProductManagerPhase, ProjectManagerPhase, ProblemAnalystPhase
// These are replaced by unified PlanningPhase
import { TechLeadPhase } from './TechLeadPhase';
import { DevelopersPhase } from './DevelopersPhase';
import { JudgePhase } from './JudgePhase';
// QAPhase REMOVED - Judge handles all quality validation per-story
import { ApprovalPhase } from './ApprovalPhase';
import { TeamOrchestrationPhase } from './TeamOrchestrationPhase';
import { VerificationPhase } from './VerificationPhase';
import { AutoMergePhase } from './AutoMergePhase';
import { AgentModelConfig } from '../../config/ModelConfigurations';
import { safeGitExecSync } from '../../utils/safeGitExecution';

// 🔥 Best practice services
import { RetryService } from './RetryService';
import { CostBudgetService } from './CostBudgetService';

// 🎯 Claude Code level services integration
import { ServiceIntegrationHub, HubConfig } from '../ServiceIntegrationHub';

import path from 'path';
import os from 'os';
import fs from 'fs';

// 🔧 MCP Tools - Custom tools for enhanced agent capabilities
import { createCustomToolsServer } from '../../tools/customTools';
import { createExtraToolsServer } from '../../tools/extraTools';
import { createExploratoryToolsServer } from '../../tools/exploratoryTools';

// 🧠 Smart Context & Memory - Pre-execution intelligence for ALL agents
import { SmartContextInjector, AgentPhase } from '../SmartContextInjector';
import { AgentMemoryBridge } from '../AgentMemoryBridge';

/**
 * DeveloperProgress - Tracks developer execution in real-time
 */
interface DeveloperProgress {
  turnCount: number;
  toolCalls: {
    reads: number;
    edits: number;
    writes: number;
    gitCommits: number;
    lastActionTurn: number;
  };
  fileActivity: {
    filesModified: Set<string>;
    filesRead: Set<string>;
    lastGitDiff: string;
    lastGitStatus: string;
  };
  warnings: string[];
  startTime: number;
}

/**
 * OrchestrationCoordinator
 *
 * Main orchestration controller following Claude Agent SDK best practices:
 * - Core feedback loop: gather context → take action → verify work → repeat
 * - Phase-based architecture (each phase = isolated subagent context)
 * - Context compaction to prevent infinite loops
 * - Judge-based verification for quality gates
 * - Human-in-the-loop approval at each phase
 * - Multi-repository parallel support
 *
 * Based on Anthropic SDK documentation:
 * https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk
 * https://docs.claude.com/en/api/agent-sdk/subagents
 *
 * COMPLIANCE WITH SDK:
 * ✅ Subagents pattern (each phase = isolated context)
 * ✅ Context compaction (ContextCompactionService)
 * ✅ Verification (JudgePhase evaluates developer work)
 * ✅ Human feedback loop (ApprovalPhase at each step)
 * ✅ Parallel execution (multi-repo support)
 * ✅ Cost tracking (totalCost, totalTokens in Task model)
 * ✅ State management (OrchestrationContext shared between phases)
 */
export class OrchestrationCoordinator {
  private readonly workspaceDir: string;
  private readonly githubService: GitHubService;
  // prManagementService REMOVED - AutoMergePhase creates its own instance
  private readonly _compactionService: ContextCompactionService;

  /**
   * Ordered phases - executes sequentially with approval gates
   *
   * IMPORTANT: DO NOT execute phases in parallel at the top level.
   * Each phase may spawn internal parallelism (e.g., DevelopersPhase spawns multiple devs),
   * but phase-to-phase must be sequential for:
   * - Context building (each phase needs previous phase outputs)
   * - Git safety (branch creation before commits)
   * - Human approval gates (must wait for approval before next phase)
   */
  private readonly PHASE_ORDER = [
    'Planning',            // 1. Unified planning (Problem + Product + Project in one pass)
    'Approval',            // 2. Human approval gate (epics + stories)
    'TeamOrchestration',   // 3. Multi-team parallel execution (TechLead → Developers+Judge per epic)
    'Verification',        // 4. Verify completeness and coherence before merge
    'AutoMerge',           // 5. Merge approved PRs to main
  ];

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(this.workspaceDir);
    // prManagementService REMOVED - AutoMergePhase creates its own instance
    this._compactionService = new ContextCompactionService();
    void this._compactionService; // Available for future use
  }

  /**
   * Check developer progress to detect loops and inactivity
   *
   * Detects:
   * - Read/Write ratio too high (only reading, not coding)
   * - Idle time (many turns without Edit/Write)
   * - No file changes in git
   * - Execution timeout
   *
   * @deprecated - Not currently used, retained for future functionality
   */
  // @ts-ignore - Unused method retained for future functionality
  private async _checkDeveloperProgress(
    progress: DeveloperProgress,
    workspacePath: string,
    story: any,
    taskId: string
  ): Promise<void> {
    const { turnCount, toolCalls, fileActivity, warnings } = progress;
    const elapsedSeconds = Math.floor((Date.now() - progress.startTime) / 1000);

    // 1. Read/Write ratio check
    if (turnCount >= 20) {
      const totalWrites = toolCalls.edits + toolCalls.writes;

      // No writes at all after 20 turns
      if (totalWrites === 0 && toolCalls.reads > 15) {
        const message = `❌ Developer stuck: ${toolCalls.reads} reads, 0 writes after ${turnCount} turns`;
        console.error(message);
        NotificationService.emitConsoleLog(taskId, 'error', message);
        throw new Error(message);
      }

      // High read/write ratio
      if (totalWrites > 0) {
        const ratio = toolCalls.reads / totalWrites;
        if (ratio > 20 && turnCount > 30) {
          const message = `❌ Developer stuck in read loop: ratio ${ratio.toFixed(1)}:1 (reads:writes) after ${turnCount} turns`;
          console.error(message);
          NotificationService.emitConsoleLog(taskId, 'error', message);
          throw new Error(message);
        }

        // Warning at 10:1 ratio
        if (ratio > 10 && !warnings.includes('high-ratio')) {
          const warning = `⚠️  Turn ${turnCount}: High Read/Write ratio = ${ratio.toFixed(1)}:1 (developer reading too much, not coding enough)`;
          console.warn(warning);
          NotificationService.emitConsoleLog(taskId, 'warn', warning);
          warnings.push('high-ratio');
        }
      }
    }

    // 2. Idle time check (no Edit/Write activity)
    // SDK Philosophy: Let agents iterate naturally through their self-correcting loop
    // Only intervene if TRULY stuck (80+ turns idle)
    if (turnCount >= 80) {
      const idleTurns = turnCount - toolCalls.lastActionTurn;
      if (idleTurns > 80) {
        const message = `❌ Developer idle: ${idleTurns} turns without Edit/Write (likely stuck in loop)`;
        console.error(message);
        NotificationService.emitConsoleLog(taskId, 'error', message);
        throw new Error(message);
      }

      // Warning at 40 turns idle (gentle nudge, don't interrupt)
      if (idleTurns > 40 && !warnings.includes('idle')) {
        const warning = `⚠️  Turn ${turnCount}: ${idleTurns} turns without Edit/Write (still gathering context)`;
        console.warn(warning);
        NotificationService.emitConsoleLog(taskId, 'warn', warning);
        warnings.push('idle');
      }
    }

    // 3. Git diff check (verify real file changes)
    if (turnCount % 20 === 0 && turnCount >= 40) {
      try {
        const gitDiff = safeGitExecSync('git diff --stat', {
          cwd: workspacePath,
          encoding: 'utf-8',
          timeout: 5000
        });

        fileActivity.lastGitDiff = gitDiff;

        // No changes after 60 turns = stuck
        if (gitDiff.trim() === '' && turnCount > 60) {
          const message = `❌ Developer produced no file changes after ${turnCount} turns`;
          console.error(message);
          NotificationService.emitConsoleLog(taskId, 'error', message);
          throw new Error(message);
        }

        // Log progress
        if (gitDiff.trim() !== '') {
          console.log(`✅ [Developer] Turn ${turnCount}: Files modified:\n${gitDiff}`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Turn ${turnCount}: Files modified`);
        } else {
          const warning = `⚠️  Turn ${turnCount}: git diff is empty - no file changes yet`;
          console.warn(warning);
          NotificationService.emitConsoleLog(taskId, 'warn', warning);
        }
      } catch (error: any) {
        console.warn(`⚠️  Turn ${turnCount}: git diff check failed - ${error.message}`);
      }
    }

    // 4. Execution timeout (30 minutes - SDK needs time to iterate naturally)
    const maxExecutionSeconds = 30 * 60; // 30 min (increased from 15)
    if (elapsedSeconds > maxExecutionSeconds) {
      const message = `❌ Developer timeout: exceeded ${maxExecutionSeconds}s (${Math.floor(maxExecutionSeconds/60)} minutes)`;
      console.error(message);
      NotificationService.emitConsoleLog(taskId, 'error', message);
      throw new Error(message);
    }

    // 5. Expected files check
    if (turnCount % 25 === 0 && story.filesToModify && story.filesToModify.length > 0) {
      const expectedFiles = story.filesToModify;
      const actualFiles = Array.from(fileActivity.filesModified);
      const missingFiles = expectedFiles.filter((f: string) =>
        !actualFiles.some(af => af.includes(f))
      );

      if (missingFiles.length > 0 && turnCount > 50) {
        const warning = `⚠️  Turn ${turnCount}: Still missing ${missingFiles.length}/${expectedFiles.length} expected files`;
        console.warn(warning);
        NotificationService.emitConsoleLog(taskId, 'warn', warning);
      }
    }
  }

  /**
   * Main orchestration entry point
   *
   * Implements the core agent loop:
   * 1. Gather context (load task, repos, workspace)
   * 2. Execute phases sequentially with approval gates
   * 3. Verify work (Judge phase after Developers)
   * 4. Repeat if verification fails (retry mechanism in JudgePhase)
   *
   * @param taskId - Task ID to orchestrate
   */
  async orchestrateTask(taskId: string): Promise<void> {
    // Create structured logger for this task
    const log = createTaskLogger(taskId, 'analysis', 'planning-agent');

    log.info(`${'='.repeat(60)}`);
    log.info(`Starting orchestration for task: ${taskId}`);
    log.info(`${'='.repeat(60)}`);

    // Also emit to frontend
    NotificationService.emitConsoleLog(taskId, 'info', `🎯 Starting orchestration for task: ${taskId}`);

    try {
      // === GATHER CONTEXT ===
      const task = await Task.findById(taskId);
      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      // Load repositories
      // Note: Repository belongs to Project, not directly to User
      // So we don't filter by userId - just verify the IDs exist
      const repositories = await Repository.find({
        _id: { $in: task.repositoryIds || [] },
        isActive: true,
      });

      if (repositories.length === 0) {
        log.error(`Repository lookup failed`, {
          taskId,
          repositoryIds: task.repositoryIds,
          userId: task.userId?.toString(),
        });

        throw new Error(
          `No repositories found for this task. ` +
          `Task has ${task.repositoryIds?.length || 0} repositoryIds configured, ` +
          `but none were found in the database. ` +
          `This usually means the repositories were deleted or the IDs are incorrect. ` +
          `Please check the task configuration.`
        );
      }

      // Verify repositories belong to user's projects (security check)
      const Project = (await import('../../models/Project')).Project;
      const projectIds = [...new Set(repositories.map(r => r.projectId.toString()))];
      const userProjects = await Project.find({
        _id: { $in: projectIds },
        userId: task.userId,
      });

      if (userProjects.length !== projectIds.length) {
        throw new Error(
          `Security error: Some repositories belong to projects not owned by this user. ` +
          `User projects found: ${userProjects.length}, expected: ${projectIds.length}`
        );
      }

      // Get user's GitHub token for cloning (GitHub tokens NOT encrypted)
      const User = (await import('../../models/User')).User;
      const user = await User.findById(task.userId).select('+accessToken +defaultApiKey');
      if (!user || !user.accessToken) {
        throw new Error(
          `User GitHub token not found. User must connect their GitHub account before starting orchestration.`
        );
      }

      log.success(`Found ${repositories.length} repositories for task`, {
        repositories: repositories.map(r => r.name),
      });
      NotificationService.emitConsoleLog(taskId, 'info', `✅ Found ${repositories.length} repositories for task`);

      // Setup workspace (pass user token for cloning - NOT encrypted)
      const workspacePath = await this.setupWorkspace(taskId, repositories, user.accessToken);
      const workspaceStructure = await this.getWorkspaceStructure(workspacePath);

      // 🔥 FIX: Enrich repositories with localPath after cloning
      repositories.forEach((repo: any) => {
        repo.localPath = path.join(workspacePath, repo.name);
      });

      // Create orchestration context (shared state for all phases)
      const context = new OrchestrationContext(task, repositories, workspacePath);

      // 🔑 Get project-specific API key with fallback chain:
      // 1. Project API key (if set)
      // 2. User's default API key (if set)
      // 3. Environment variable (fallback)
      let anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      let apiKeySource = 'environment';

      // Get project to check for project-specific API key and dev auth config
      // Note: Sensitive fields are encrypted - use decryption methods
      const ProjectModel = (await import('../../models/Project')).Project;
      const project = userProjects.length > 0
        ? await ProjectModel.findById(userProjects[0]._id).select('+apiKey +devAuth.token +devAuth.credentials.password')
        : null;

      if (project?.apiKey) {
        // Use decryption method to get the actual API key
        anthropicApiKey = project.getDecryptedApiKey() || project.apiKey;
        apiKeySource = 'project';
        console.log(`🔑 Using project-specific API key (project: ${project.name})`);
      } else if (user.defaultApiKey) {
        // User model also has encryption - use decryption method
        anthropicApiKey = user.getDecryptedApiKey ? user.getDecryptedApiKey() : user.defaultApiKey;
        apiKeySource = 'user_default';
        console.log(`🔑 Using user's default API key`);
      } else {
        console.log(`🔑 Using environment API key (no project or user default set)`);
      }

      // 🔐 Store developer authentication config (if configured)
      // IMPORTANT: DELETE method is ALWAYS BLOCKED - developers can only use GET, PUT, POST
      // Uses decryption method to get decrypted tokens and credentials
      if (project?.devAuth && project.devAuth.method !== 'none') {
        const decryptedDevAuth = project.getDecryptedDevAuth();
        if (decryptedDevAuth) {
          context.setData('devAuth', {
            method: decryptedDevAuth.method,
            // For 'token' method
            token: decryptedDevAuth.token,
            tokenType: decryptedDevAuth.tokenType || 'bearer',
            tokenHeader: decryptedDevAuth.tokenHeader || 'Authorization',
            tokenPrefix: decryptedDevAuth.tokenPrefix || 'Bearer ',
            // For 'credentials' method
            loginEndpoint: decryptedDevAuth.loginEndpoint,
            loginMethod: decryptedDevAuth.loginMethod || 'POST',
            credentials: decryptedDevAuth.credentials,
            loginContentType: decryptedDevAuth.loginContentType || 'application/json',
            tokenResponsePath: decryptedDevAuth.tokenResponsePath || 'token',
          });
          console.log(`🔐 Developer authentication configured (method: ${decryptedDevAuth.method})`);
          if (decryptedDevAuth.method === 'credentials') {
            console.log(`   📝 Login endpoint: ${decryptedDevAuth.loginEndpoint}`);
          }
          console.log(`   ⚠️  DELETE method is BLOCKED for safety - only GET, PUT, POST allowed`);
        }
      }

      if (!anthropicApiKey) {
        throw new Error(
          `No Anthropic API key configured. Please set:\n` +
          `1. Project-specific API key (recommended for budget tracking), or\n` +
          `2. User default API key (in user settings), or\n` +
          `3. ANTHROPIC_API_KEY environment variable`
        );
      }

      // Store API key in context for agent execution
      context.setData('anthropicApiKey', anthropicApiKey);
      context.setData('apiKeySource', apiKeySource);
      context.setData('workspaceStructure', workspaceStructure);

      // 🎯 Initialize ServiceIntegrationHub for Claude Code level services
      const hubConfig: HubConfig = {
        workspacePath,
        projectId: project?._id?.toString() || taskId,
        enableMetrics: true,
        enableLearning: true,
        enableMemory: true,
      };
      const serviceHub = new ServiceIntegrationHub(hubConfig);

      try {
        await serviceHub.initialize();
        context.setData('serviceHub', serviceHub);
        console.log(`🎯 [Orchestration] ServiceIntegrationHub initialized with all services`);
        NotificationService.emitConsoleLog(taskId, 'info', `🎯 All Claude Code level services initialized`);
      } catch (hubError) {
        console.warn(`⚠️  [Orchestration] ServiceIntegrationHub initialization warning: ${hubError}`);
        // Continue without hub - graceful degradation
      }

      // Mark task as in progress
      task.status = 'in_progress';
      task.orchestration.currentPhase = 'analysis';
      await task.save();

      NotificationService.emitTaskStarted(taskId, {
        repositoriesCount: repositories.length,
        workspacePath,
      });

      // === EXECUTE PHASES SEQUENTIALLY WITH APPROVAL GATES ===
      for (const phaseName of this.PHASE_ORDER) {
        // 🔥 CRITICAL: Check for pause/cancel requests before each phase
        await task.save(); // Refresh task to get latest state
        const Task = require('../../models/Task').Task;
        const freshTask = await Task.findById(task._id);
        if (freshTask) {
          Object.assign(task, freshTask);
        }

        // Check if user requested pause
        if (task.orchestration.paused) {
          console.log(`⏸️  [Orchestration] Task paused by user - stopping after current phase`);
          NotificationService.emitConsoleLog(taskId, 'warn', `⏸️  Orchestration paused by user`);
          NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Task paused - will resume when server restarts or user resumes manually`);
          return; // Exit gracefully
        }

        // Check if user requested cancellation
        if (task.orchestration.cancelRequested) {
          console.log(`🛑 [Orchestration] Task cancellation requested - stopping immediately`);
          task.status = 'cancelled';
          task.orchestration.currentPhase = 'completed';
          await task.save();

          NotificationService.emitConsoleLog(taskId, 'error', `🛑 Task cancelled by user`);
          NotificationService.emitTaskFailed(taskId, { error: 'Task cancelled by user' });

          // 🔥 IMPORTANT: Clean up resources on cancellation
          CostBudgetService.cleanupTaskConfig(taskId);
          const { approvalEvents } = await import('../ApprovalEvents');
          approvalEvents.cleanupTask(taskId);
          console.log(`🧹 Cleaned up resources for cancelled task ${taskId}`);

          return; // Exit immediately
        }

        const phase = this.createPhase(phaseName, context);

        if (!phase) {
          console.warn(`⚠️  Phase "${phaseName}" not implemented, skipping...`);
          NotificationService.emitConsoleLog(taskId, 'warn', `⚠️  Phase "${phaseName}" not implemented, skipping...`);
          continue;
        }

        // 🔥 COST BUDGET CHECK: Verify we're within budget before executing
        const budgetCheck = await CostBudgetService.checkBudgetBeforePhase(
          task,
          phaseName,
          CostBudgetService.getPhaseEstimate(phaseName)
        );

        if (!budgetCheck.allowed) {
          console.error(`❌ [BUDGET] ${budgetCheck.reason}`);
          NotificationService.emitConsoleLog(taskId, 'error', `❌ ${budgetCheck.reason}`);
          throw new Error(budgetCheck.reason);
        }

        if (budgetCheck.warning) {
          console.warn(`⚠️ [BUDGET] ${budgetCheck.warning}`);
          NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ ${budgetCheck.warning}`);
        }

        // 💡 CHECK FOR PENDING DIRECTIVES
        // Directives are user-injected instructions that should be incorporated into agent behavior
        const directivesToInject = await this.consumeDirectivesForPhase(task, phaseName, taskId);
        if (directivesToInject.length > 0) {
          context.setData('injectedDirectives', directivesToInject);
          console.log(`💡 [Directive] Injected ${directivesToInject.length} directive(s) into ${phaseName} context`);
          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `💡 Injecting ${directivesToInject.length} user directive(s) into ${phaseName}`
          );
        }

        // Log phase start
        NotificationService.emitConsoleLog(taskId, 'info', `🚀 Starting phase: ${phaseName}`);

        // 🔥 CRITICAL: Update currentPhase in DB BEFORE executing
        // This ensures recovery knows where to resume from if server crashes
        task.orchestration.currentPhase = this.mapPhaseToEnum(phaseName);
        await task.save();
        console.log(`📍 [Orchestration] Phase tracking updated: ${phaseName} → ${task.orchestration.currentPhase}`);

        // Execute phase with retry logic for transient failures
        // 🔥 TIMEOUT RETRY STRATEGY: If agent times out, retry once with Opus (most powerful model)
        let result;
        try {
          result = await RetryService.executeWithRetry(
            () => phase.execute(context),
            {
              maxRetries: 3,
              onRetry: (attempt, error, delayMs) => {
                console.warn(`⚠️ [${phaseName}] Retry attempt ${attempt} after ${delayMs}ms. Error: ${error.message}`);
                NotificationService.emitConsoleLog(
                  taskId,
                  'warn',
                  `⚠️ Retrying ${phaseName} (attempt ${attempt}) after transient error: ${error.message}`
                );
              }
            }
          );
        } catch (error: any) {
          // Check if this is a timeout error
          if (error.isTimeout || error.message?.includes('timeout')) {
            console.error(`⏰ [${phaseName}] Agent execution timeout detected - retrying with top model from user's config`);

            // Get current model config to find the top model
            const task = await Task.findById(taskId);
            if (task) {
              const configs = await import('../../config/ModelConfigurations');

              // Get current model config (default to RECOMMENDED for optimal quality/cost)
              let currentModelConfig: AgentModelConfig = configs.RECOMMENDED_CONFIG;
              if (task.orchestration?.modelConfig) {
                const { preset, customConfig } = task.orchestration.modelConfig;
                if (preset === 'custom' && customConfig) {
                  currentModelConfig = customConfig as AgentModelConfig;
                } else if (preset === 'max') {
                  currentModelConfig = configs.MAX_CONFIG;
                } else if (preset === 'premium') {
                  currentModelConfig = configs.PREMIUM_CONFIG;
                } else if (preset === 'recommended') {
                  currentModelConfig = configs.RECOMMENDED_CONFIG;
                } else if (preset === 'standard') {
                  currentModelConfig = configs.STANDARD_CONFIG;
                }
              }

              // Find the most powerful model in the user's current config
              const topModel = configs.getTopModelFromConfig(currentModelConfig);
              const topModelName = topModel.includes('opus') ? 'Opus' :
                                  topModel.includes('sonnet') ? 'Sonnet' : 'Haiku';

              console.log(`🚀 [${phaseName}] Top model in user's config: ${topModelName}`);
              NotificationService.emitConsoleLog(
                taskId,
                'warn',
                `⏰ ${phaseName} timed out after 10 minutes - retrying with ${topModelName} (best model in your config)`
              );

              // Save current model config
              const previousModelConfig = task.orchestration.modelConfig;

              // Escalate to top model for all agents
              const escalatedConfig = configs.escalateConfigToTopModel(currentModelConfig);

              task.orchestration.modelConfig = {
                preset: 'custom',
                customConfig: escalatedConfig,
              };
              await task.save();

              console.log(`🚀 [${phaseName}] Escalated all agents to ${topModelName} for timeout retry`);

              try {
                // Retry with escalated config
                result = await phase.execute(context);

                console.log(`✅ [${phaseName}] Timeout retry with ${topModelName} succeeded!`);
                NotificationService.emitConsoleLog(
                  taskId,
                  'info',
                  `✅ ${phaseName} succeeded with ${topModelName} after timeout`
                );
              } catch (retryError: any) {
                console.error(`❌ [${phaseName}] Timeout retry with ${topModelName} also failed:`, retryError.message);

                // Restore previous model config
                task.orchestration.modelConfig = previousModelConfig;
                await task.save();

                throw retryError; // Re-throw to fail the phase
              }

              // Restore previous model config for next phases
              task.orchestration.modelConfig = previousModelConfig;
              await task.save();
            } else {
              throw error; // Can't retry without task
            }
          } else {
            throw error; // Non-timeout error, re-throw
          }
        }

        // QA, Fixer, contract-testing, contract-fixer loops REMOVED
        // Judge handles all quality validation per-story inside DevelopersPhase

        // Check if phase failed
        if (!result.success) {
          // 🚨 CRITICAL: Check if this is a validation error that blocks execution
          const isValidationError = result.data?.validationError === true ||
                                   result.data?.blocked === true ||
                                   (result.error && (
                                     result.error.includes('EPIC OVERLAP DETECTED') ||
                                     result.error.includes('CIRCUIT BREAKER') ||
                                     result.error.includes('CRITICAL VALIDATION FAILURE') ||
                                     result.error.includes('max retries')
                                   ));

          if (isValidationError) {
            console.error(`\n${'⛔'.repeat(60)}`);
            console.error(`⛔ ORCHESTRATION BLOCKED - VALIDATION FAILURE`);
            console.error(`⛔ Phase: ${phaseName}`);
            console.error(`⛔ Reason: ${result.error}`);
            console.error(`⛔ STATUS: Task execution STOPPED - will NOT proceed to next phase`);
            console.error(`${'⛔'.repeat(60)}\n`);

            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `⛔ ORCHESTRATION BLOCKED: ${phaseName} validation failed - execution stopped`
            );
          }

          // 🔥 ADDITIONAL CHECK: If this is ProjectManager failure, ENSURE we don't continue
          if (phaseName === 'ProjectManager') {
            console.error(`\n${'🛑'.repeat(60)}`);
            console.error(`🛑 CRITICAL: ProjectManager phase failed`);
            console.error(`🛑 Cannot proceed to TechLead without valid epics`);
            console.error(`🛑 Remaining phases (TechLead, Developers, QA) will NOT execute`);
            console.error(`${'🛑'.repeat(60)}\n`);

            NotificationService.emitConsoleLog(
              taskId,
              'error',
              `🛑 CRITICAL: ProjectManager failed - cannot create epics. Orchestration stopped.`
            );
          }

          // Phase failed - mark task as failed
          NotificationService.emitConsoleLog(taskId, 'error', `❌ Phase ${phaseName} failed: ${result.error}`);
          await this.handlePhaseFailed(task, phaseName, result);
          return; // 🔥 EXPLICIT STOP: No further phases will execute
        }

        // Check if phase needs approval (paused, not failed)
        if (result.needsApproval) {
          console.log(`⏸️  [${phaseName}] Paused - waiting for human approval`);
          NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Phase ${phaseName} paused - waiting for human approval`);
          return; // Exit orchestration, will resume when approval granted
        }

        // Phase succeeded - continue to next phase
        const wasSkipped = result.warnings?.includes('Phase was skipped');

        if (wasSkipped) {
          console.log(`⏭️  [${phaseName}] Skipped`);
          NotificationService.emitConsoleLog(taskId, 'info', `⏭️  Phase ${phaseName} skipped`);
        } else {
          console.log(`✅ [${phaseName}] Completed successfully`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Phase ${phaseName} completed successfully`);

          // 🔥 RATE LIMIT PROTECTION: Wait 2 seconds between phases to avoid Anthropic rate limits
          // Each agent makes many API calls, waiting prevents hitting limits
          if (phaseName !== 'Approval') {
            console.log(`⏱️  [Orchestration] Waiting 2s before next phase (rate limit protection)...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          // 🔥 CRITICAL: Store current phase name for ApprovalPhase
          // ApprovalPhase needs to know which phase just completed to check auto-approval
          // IMPORTANT: Only store if phase actually executed (not skipped)
          if (phaseName !== 'Approval') {
            context.setData('currentPhaseName', phaseName);
            console.log(`📝 Stored currentPhaseName in context: ${phaseName}`);
          }
        }

        // Context compaction to prevent context overflow
        await this.compactContextIfNeeded(context);
      }

      // === ALL PHASES COMPLETED ===
      await this.handleOrchestrationComplete(task, context);

    } catch (error: any) {
      console.error(`❌ Orchestration fatal error:`, error);
      await this.handleOrchestrationError(taskId, error);
    }
  }

  /**
   * Create phase instance based on phase name
   *
   * Each phase is a "subagent" with isolated context and specialized tools.
   * Following SDK pattern: each subagent has specific description and tool restrictions.
   */
  private createPhase(phaseName: string, context: OrchestrationContext): IPhase | null {
    // Create a wrapper for executeAgent that includes context
    const executeAgentWithContext = (
      agentType: string,
      prompt: string,
      workspacePath: string,
      taskId?: string,
      agentName?: string,
      sessionId?: string,
      fork?: boolean,
      attachments?: any[],
      options?: { maxIterations?: number; timeout?: number }
    ) => {
      // 🔥 VALIDATION: Ensure workspacePath is a string before passing to executeAgent
      if (typeof workspacePath !== 'string') {
        console.error(`❌ [executeAgentWithContext] workspacePath is not a string!`);
        console.error(`   Type: ${typeof workspacePath}`);
        console.error(`   Value: ${JSON.stringify(workspacePath)}`);
        throw new Error(`workspacePath must be a string, received: ${typeof workspacePath}`);
      }

      return this.executeAgent(
        agentType,
        prompt,
        workspacePath,
        taskId,
        agentName,
        sessionId,
        fork,
        attachments,
        options,
        context // Pass context for API key lookup
      );
    };

    switch (phaseName) {
      case 'Planning':
        return new PlanningPhase(executeAgentWithContext);

      // Legacy phases REMOVED: ProblemAnalyst, ProductManager, ProjectManager
      // Use PlanningPhase instead (unified planning)

      case 'TeamOrchestration':
        return new TeamOrchestrationPhase(
          executeAgentWithContext,
          this.executeDeveloper.bind(this)
          // githubService, prManagementService, workspaceDir REMOVED - were only used by QAPhase
        );

      case 'TechLead':
        return new TechLeadPhase(executeAgentWithContext);

      case 'Developers':
        return new DevelopersPhase(
          this.executeDeveloper.bind(this),
          executeAgentWithContext // For Judge execution
        );

      case 'Judge':
        return new JudgePhase(executeAgentWithContext);

      // QA, Fixer, TestCreator, contract-testing, contract-fixer REMOVED
      // Judge handles all quality validation per-story inside DevelopersPhase

      case 'Approval':
        return new ApprovalPhase();

      case 'Verification':
        return new VerificationPhase(executeAgentWithContext);

      case 'AutoMerge':
        return new AutoMergePhase(this.githubService);

      default:
        return null;
    }
  }

  /**
   * Setup workspace for multi-repo development
   * Clones ONLY the repositories selected by the user for this specific task
   */
  private async setupWorkspace(taskId: string, repositories: any[], githubToken: string): Promise<string> {
    const taskWorkspace = path.join(this.workspaceDir, `task-${taskId}`);

    console.log(`📦 Setting up workspace for task ${taskId}`);
    console.log(`   Selected repositories count: ${repositories.length}`);

    // Log which repositories will be cloned (for debugging)
    repositories.forEach((repo, index) => {
      console.log(`   ${index + 1}. ${repo.name} (${repo.githubRepoName})`);
    });

    // Create workspace directory
    if (!fs.existsSync(taskWorkspace)) {
      fs.mkdirSync(taskWorkspace, { recursive: true });
    }

    // Clone ONLY the selected repositories using user's GitHub token
    for (const repo of repositories) {
      console.log(`   🔄 Cloning: ${repo.githubRepoName} (branch: ${repo.githubBranch || 'main'})`);

      // 🔐 Inject environment variables if configured
      const envVariables = repo.envVariables && repo.envVariables.length > 0
        ? repo.envVariables
        : undefined;

      if (envVariables) {
        console.log(`   🔐 Repository has ${envVariables.length} environment variable(s) configured`);
      }

      await this.githubService.cloneRepositoryForOrchestration(
        repo.githubRepoUrl,
        repo.githubBranch || 'main',
        githubToken,  // Use user's token for all repos
        taskWorkspace,
        envVariables  // Inject .env file during cloning
      );
    }

    // Verify workspace contains only selected repos
    const clonedRepos = fs.readdirSync(taskWorkspace).filter(name => !name.startsWith('.'));
    console.log(`   📁 Workspace contents: ${clonedRepos.join(', ')}`);

    if (clonedRepos.length !== repositories.length) {
      console.warn(`⚠️  Workspace repo count mismatch!`);
      console.warn(`   Expected: ${repositories.length} repos`);
      console.warn(`   Found: ${clonedRepos.length} directories`);
      console.warn(`   This might indicate an issue with repository cloning`);
    }

    console.log(`✅ Workspace setup complete: ${taskWorkspace}`);
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `✅ Workspace ready with ${repositories.length} selected repositories: ${repositories.map(r => r.name).join(', ')}`
    );

    return taskWorkspace;
  }

  /**
   * Get workspace structure for agent context
   */
  private async getWorkspaceStructure(_workspacePath: string): Promise<string> {
    // TODO: Implement tree command or fs-based directory listing
    return 'Workspace structure loading...';
  }

  /**
   * Map phase names to Task enum values
   */
  private mapPhaseToEnum(phaseName: string): 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'completed' {
    const phaseMap: Record<string, 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'completed'> = {
      'ProblemAnalyst': 'analysis',
      'ProductManager': 'analysis',
      'Approval': 'analysis', // Approval after analysis
      'ProjectManager': 'planning',
      'TechLead': 'architecture',
      'Developers': 'development',
      'Judge': 'development',
      'QA': 'qa',
      'Merge': 'merge',
    };
    return phaseMap[phaseName] || 'analysis';
  }

  /**
   * Context compaction to prevent infinite loops (SDK best practice)
   *
   * When context grows too large:
   * - Summarize previous messages
   * - Keep only essential information
   * - Maintain phase results
   */
  /**
   * Consume pending directives that match the current phase
   *
   * Directives allow users to inject instructions mid-execution.
   * They are picked up before each phase and injected into agent context.
   *
   * @param task - The task document
   * @param phaseName - Current phase name (e.g., 'TeamOrchestration')
   * @param taskId - Task ID for logging
   * @returns Array of directives to inject into this phase
   */
  private async consumeDirectivesForPhase(
    task: ITask,
    phaseName: string,
    taskId: string
  ): Promise<Array<{ id: string; content: string; priority: string }>> {
    // Refresh task to get latest directives
    const freshTask = await Task.findById(task._id);
    if (!freshTask) return [];

    const pendingDirectives = freshTask.orchestration.pendingDirectives || [];
    if (pendingDirectives.length === 0) return [];

    // Filter directives that match this phase
    // A directive matches if:
    // 1. No targetPhase specified (applies to all), OR
    // 2. targetPhase matches current phase
    const matchingDirectives = pendingDirectives.filter(d => {
      if (d.consumed) return false;
      if (!d.targetPhase) return true; // No target = applies to all
      return d.targetPhase.toLowerCase() === phaseName.toLowerCase();
    });

    if (matchingDirectives.length === 0) return [];

    // Sort by priority: critical > high > normal > suggestion
    const priorityOrder: Record<string, number> = {
      'critical': 0,
      'high': 1,
      'normal': 2,
      'suggestion': 3,
    };
    matchingDirectives.sort((a, b) =>
      (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3)
    );

    // Mark directives as consumed and move to history
    const consumedDirectives: Array<{ id: string; content: string; priority: string }> = [];

    for (const directive of matchingDirectives) {
      directive.consumed = true;
      directive.injectedAt = new Date();

      consumedDirectives.push({
        id: directive.id,
        content: directive.content,
        priority: directive.priority,
      });

      // Emit consumed event
      NotificationService.emitDirectiveConsumed(taskId, {
        directiveId: directive.id,
        phaseName,
      });

      console.log(`💡 [Directive] Consumed "${directive.id}" for phase ${phaseName}`);
    }

    // Move consumed directives to history
    if (!freshTask.orchestration.directiveHistory) {
      freshTask.orchestration.directiveHistory = [];
    }
    freshTask.orchestration.directiveHistory.push(...matchingDirectives as any);

    // Remove consumed directives from pending
    freshTask.orchestration.pendingDirectives = pendingDirectives.filter(d => !d.consumed);

    freshTask.markModified('orchestration.pendingDirectives');
    freshTask.markModified('orchestration.directiveHistory');
    await freshTask.save();

    // Update the task reference with fresh data
    Object.assign(task.orchestration, freshTask.orchestration);

    return consumedDirectives;
  }

  /**
   * Get formatted directives block for a specific agent type
   *
   * This reads directly from the task's pendingDirectives to get
   * directives that apply to the given agent type.
   *
   * Note: This does NOT consume directives (they remain pending).
   * Consumption happens in consumeDirectivesForPhase at phase start.
   *
   * @param taskId - Task ID
   * @param agentType - Agent type (e.g., 'developer', 'verification-fixer')
   * @returns Formatted markdown block or empty string if no directives
   */
  private async getDirectivesForAgent(taskId: string, agentType: string): Promise<string> {
    try {
      const task = await Task.findById(taskId);
      if (!task) return '';

      const pendingDirectives = task.orchestration.pendingDirectives || [];
      if (pendingDirectives.length === 0) return '';

      // Filter directives that apply to this agent
      const matchingDirectives = pendingDirectives.filter(d => {
        if (d.consumed) return false;
        // No targetAgent = applies to all, OR matches this agent
        return !d.targetAgent || d.targetAgent === agentType;
      });

      if (matchingDirectives.length === 0) return '';

      // Format as markdown block with priority indicators
      const priorityEmoji: Record<string, string> = {
        'critical': '🚨',
        'high': '⚠️',
        'normal': '💡',
        'suggestion': '💭',
      };

      // Sort by priority
      const priorityOrder: Record<string, number> = {
        'critical': 0,
        'high': 1,
        'normal': 2,
        'suggestion': 3,
      };
      matchingDirectives.sort((a, b) =>
        (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3)
      );

      const formattedDirectives = matchingDirectives.map(d => {
        const emoji = priorityEmoji[d.priority] || '💡';
        return `${emoji} **[${d.priority.toUpperCase()}]** ${d.content}`;
      }).join('\n\n');

      return `
## 💡 USER DIRECTIVES (PRIORITIZE THESE)

The following instructions were injected by the user mid-execution.
**You MUST prioritize these directives** and incorporate them into your work.

${formattedDirectives}

---

`;
    } catch (error: any) {
      console.warn(`⚠️ [Directives] Failed to get directives: ${error.message}`);
      return '';
    }
  }

  /**
   * Compact context if needed using SDK native /compact command
   *
   * SDK provides native /compact: https://docs.claude.com/en/api/agent-sdk/slash-commands
   */
  private async compactContextIfNeeded(context: OrchestrationContext): Promise<void> {
    const phaseCount = context.phaseResults.size;

    // Check if compaction is needed based on conversation length
    if (phaseCount >= 5 && context.conversationHistory && context.conversationHistory.length > 20) {
      console.log(`🗜️  [Context Compaction] ${phaseCount} phases, ${context.conversationHistory.length} messages - using SDK /compact`);

      try {
        // Use SDK native /compact command
        const { query } = await import('@anthropic-ai/claude-agent-sdk');

        for await (const message of query({
          prompt: '/compact',
          options: { maxTurns: 1 }
        })) {
          if (message.type === 'system' && (message as any).subtype === 'compact_boundary') {
            console.log('✅ [Context Compaction] SDK compaction completed');
          }
        }
      } catch (error: any) {
        console.warn(`⚠️  [Context Compaction] Failed: ${error.message}`);
      }
    }
  }

  /**
   * Save a failed execution for later retry
   *
   * Persists all context needed to retry the execution:
   * - Agent type, prompt, workspace
   * - Failure type and diagnostics
   * - Context snapshot for retry
   */
  private async saveFailedExecution(params: {
    taskId?: string;
    agentType: string;
    agentName?: string;
    phaseName?: string;
    prompt: string;
    workspacePath: string;
    model: string;
    permissionMode?: string;
    error: Error & {
      isTimeout?: boolean;
      isHistoryOverflow?: boolean;
      isLoopDetection?: boolean;
    };
    diagnostics: {
      messagesReceived: number;
      historyMessages: number;
      turnsCompleted: number;
      lastMessageTypes: string[];
      streamDurationMs: number;
    };
    context?: OrchestrationContext;
  }): Promise<void> {
    try {
      // Determine failure type from error flags
      let failureType: FailureType = 'unknown';
      if (params.error.isTimeout) {
        failureType = 'timeout';
      } else if (params.error.isHistoryOverflow) {
        failureType = 'history_overflow';
      } else if (params.error.isLoopDetection) {
        failureType = 'loop_detection';
      } else if (params.error.message?.includes('SDK query failed')) {
        failureType = 'sdk_error';
      } else if (params.error.message?.includes('API') || params.error.message?.includes('rate limit')) {
        failureType = 'api_error';
      } else if (params.error.message?.includes('git')) {
        failureType = 'git_error';
      }

      // Get task for project ID
      let projectId;
      if (params.taskId) {
        const task = await Task.findById(params.taskId);
        projectId = task?.projectId;
      }

      // Snapshot context for retry (only essential data from sharedData)
      const contextSnapshot = params.context ? {
        epics: params.context.getData<any[]>('epics')?.slice(0, 10), // Limit size
        stories: params.context.getData<any[]>('stories')?.slice(0, 20),
        currentPhase: Array.from(params.context.phaseResults.keys()).pop(), // Last phase name
        taskId: params.context.task._id?.toString(),
        // Don't include full phaseResults - too large
      } : undefined;

      // Calculate retry delay based on failure type
      // Timeout/overflow: wait longer, Loop: don't auto-retry
      const retryDelayMs = failureType === 'loop_detection'
        ? null // Don't auto-retry loops
        : failureType === 'timeout' || failureType === 'history_overflow'
          ? 5 * 60 * 1000 // 5 minutes for heavy failures
          : 60 * 1000; // 1 minute for light failures

      const failedExec = new FailedExecution({
        taskId: params.taskId,
        projectId,
        agentType: params.agentType,
        agentName: params.agentName,
        phaseName: params.phaseName,
        prompt: params.prompt.substring(0, 50000), // Limit prompt size
        workspacePath: params.workspacePath,
        modelId: params.model,
        permissionMode: params.permissionMode || 'bypassPermissions',
        failureType,
        errorMessage: params.error.message,
        errorStack: params.error.stack?.substring(0, 5000),
        messagesReceived: params.diagnostics.messagesReceived,
        historyMessages: params.diagnostics.historyMessages,
        turnsCompleted: params.diagnostics.turnsCompleted,
        lastMessageTypes: params.diagnostics.lastMessageTypes.slice(-20),
        streamDurationMs: params.diagnostics.streamDurationMs,
        retryStatus: failureType === 'loop_detection' ? 'abandoned' : 'pending',
        retryCount: 0,
        maxRetries: 3,
        nextRetryAt: retryDelayMs ? new Date(Date.now() + retryDelayMs) : undefined,
        contextSnapshot,
      });

      await failedExec.save();

      console.log(`💾 [FailedExecution] Saved failed execution for retry:`);
      console.log(`   ID: ${failedExec._id}`);
      console.log(`   Agent: ${params.agentType}`);
      console.log(`   Failure: ${failureType}`);
      console.log(`   Retry status: ${failedExec.retryStatus}`);
      if (failedExec.nextRetryAt) {
        console.log(`   Next retry: ${failedExec.nextRetryAt.toISOString()}`);
      }

      // Emit notification for visibility
      if (params.taskId) {
        NotificationService.emitConsoleLog(
          params.taskId,
          'warn',
          `💾 Execution saved for retry: ${params.agentType} (${failureType})`
        );
      }
    } catch (saveError: any) {
      // Don't let save failure break the main error flow
      console.error(`❌ [FailedExecution] Failed to save:`, saveError.message);
    }
  }

  /**
   * Execute a single agent with SDK query function
   *
   * This is the low-level agent execution used by all phases.
   * Following SDK pattern: single query() call per agent action.
   *
   * SDK Documentation:
   * https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode
   *
   * Using single-mode (non-streaming) for reliability and simplicity.
   */
  public async executeAgent(
    agentType: string,
    prompt: string,
    workspacePath: string,
    taskId?: string,
    _agentName?: string,
    sessionId?: string,
    _fork?: boolean,
    attachments?: any[],
    _options?: {
      maxIterations?: number;
      timeout?: number;
    },
    contextOverride?: OrchestrationContext,
    skipOptimization?: boolean, // 🔥 Skip optimizeConfigForBudget (used for retry with forceTopModel)
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' // 🔥 SDK permission mode
  ): Promise<any> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { getAgentDefinition, getAgentDefinitionWithSpecialization, getAgentModel } = await import('./AgentDefinitions');

    // Get repository type from task or context for developer specialization
    // 🔥 ONLY 'frontend' | 'backend' | 'unknown' - NO OTHER TYPES EXIST
    let repositoryType: 'frontend' | 'backend' | 'unknown' = 'unknown';
    if (taskId && agentType === 'developer') {
      try {
        const task = await Task.findById(taskId).populate('projectId');
        if (task?.projectId) {
          const project = task.projectId as any;

          // 🔥 CRITICAL: Repository.type enum is ONLY 'backend' | 'frontend'
          if (project.repositories && project.repositories.length > 0) {
            const types = project.repositories.map((r: any) => r.type).filter(Boolean);

            if (types.length === 0) {
              // No types assigned, use unknown
              repositoryType = 'unknown';
            } else {
              // Use first valid type found (all must be backend or frontend)
              const validType = types.find((t: string) => t === 'backend' || t === 'frontend');
              repositoryType = validType || 'unknown';
            }
          } else if (project.repository) {
            repositoryType = project.repository.type || 'unknown';
          }
        }
      } catch (error: any) {
        console.warn(`[OrchestrationCoordinator] Failed to get repository type for specialization: ${error.message}`);
      }
    }

    // Get agent configuration with specialization
    // - Developers: get repository-specific specialization (frontend/backend)
    // - QA agents: get test-engineer specialization (always applied)
    const needsSpecialization = agentType === 'developer' || agentType === 'qa-engineer' || agentType === 'contract-tester';
    const agentDef = needsSpecialization
      ? getAgentDefinitionWithSpecialization(agentType, repositoryType)
      : getAgentDefinition(agentType);

    if (!agentDef) {
      throw new Error(`Agent type "${agentType}" not found in agent definitions`);
    }

    // Get model configuration from task if available
    // Default to RECOMMENDED_CONFIG for optimal quality/cost balance
    const configs = await import('../../config/ModelConfigurations');
    let modelConfig: AgentModelConfig = configs.RECOMMENDED_CONFIG; // Default to recommended

    if (taskId) {
      const task = await Task.findById(taskId);
      if (task?.orchestration?.modelConfig) {
        const { preset, customConfig } = task.orchestration.modelConfig;
        console.log(`🎯 [ExecuteAgent] Task ${taskId} has modelConfig: preset=${preset}, hasCustomConfig=${!!customConfig}`);

        if (preset === 'custom' && customConfig) {
          // Map DB camelCase keys to AgentModelConfig kebab-case keys
          modelConfig = configs.mapDbConfigToAgentModelConfig(customConfig);
          console.log(`🎯 [ExecuteAgent] Using custom model configuration (mapped from DB format)`);
        } else if (preset) {
          switch (preset) {
            case 'max':
              modelConfig = configs.MAX_CONFIG;
              console.log(`🚀 [ExecuteAgent] Using MAX_CONFIG (All Opus - Maximum Performance)`);
              break;
            case 'premium':
              modelConfig = configs.PREMIUM_CONFIG;
              console.log(`💎 [ExecuteAgent] Using PREMIUM_CONFIG (Opus + Sonnet)`);
              break;
            case 'recommended':
              modelConfig = configs.RECOMMENDED_CONFIG;
              console.log(`🌟 [ExecuteAgent] Using RECOMMENDED_CONFIG (Opus + Sonnet + Haiku - Optimal Balance)`);
              break;
            case 'standard':
              modelConfig = configs.STANDARD_CONFIG;
              console.log(`⚙️ [ExecuteAgent] Using STANDARD_CONFIG (Sonnet + Haiku)`);
              break;
            default:
              modelConfig = configs.RECOMMENDED_CONFIG;
              console.log(`🌟 [ExecuteAgent] Using RECOMMENDED_CONFIG (default)`);
              break;
          }
        }
      } else {
        console.log(`🌟 [ExecuteAgent] Task ${taskId} has no modelConfig, using RECOMMENDED_CONFIG as default`);
      }
    }

    // 🎯 AUTOMATIC OPTIMIZATION: Apply cost-performance optimization
    // This ensures critical agents get top model, executors get bottom model
    // Works with ANY config the user selected (MAX, PREMIUM, STANDARD, BALANCED, ECONOMY, CUSTOM)
    // 🔥 SKIP when forceTopModel is used (retry scenario - developer needs best model)
    if (!skipOptimization) {
      modelConfig = configs.optimizeConfigForBudget(modelConfig);
      console.log(`✨ [ExecuteAgent] Applied automatic optimization for agent: ${agentType}`);
    } else {
      console.log(`🚀 [ExecuteAgent] SKIPPING optimization (forceTopModel retry) - using topModel for: ${agentType}`);
    }

    // Get model alias from config ('sonnet', 'haiku', or 'opus')
    const modelAlias = getAgentModel(agentType, modelConfig);
    // Convert to explicit model ID for SDK (ensures we use latest 4.5 versions)
    const model = configs.getExplicitModelId(modelAlias);

    // 🔥 CRITICAL VALIDATION: workspacePath MUST be a string
    // The SDK's query() function requires options.cwd to be a string
    if (typeof workspacePath !== 'string') {
      console.error(`❌❌❌ [ExecuteAgent] CRITICAL ERROR: workspacePath is NOT a string!`);
      console.error(`   Type received: ${typeof workspacePath}`);
      console.error(`   Value: ${JSON.stringify(workspacePath)}`);
      console.error(`   Agent type: ${agentType}`);
      console.error(`   This would cause SDK error: "options.cwd property must be of type string"`);
      throw new Error(
        `CRITICAL: workspacePath must be a string, received ${typeof workspacePath}: ${JSON.stringify(workspacePath)}`
      );
    }

    console.log(`🤖 [ExecuteAgent] Starting ${agentType}`);
    console.log(`📁 [ExecuteAgent] Working directory: ${workspacePath}`);
    console.log(`📎 [ExecuteAgent] Attachments received: ${attachments ? attachments.length : 0}`);
    console.log(`🔧 [ExecuteAgent] Model: ${model} (from alias: ${modelAlias}) for ${agentType}`);

    // 🧠 SMART CONTEXT INJECTION - Pre-execution intelligence for ALL agents
    let smartContextBlock = '';
    try {
      const contextInjector = SmartContextInjector.getInstance();
      await contextInjector.initialize(workspacePath);

      const memoryBridge = AgentMemoryBridge.getInstance();
      await memoryBridge.initialize(workspacePath);

      // Map agent type to phase
      const phaseMapping: Record<string, AgentPhase> = {
        'planning-agent': 'problem-analyst',
        'product-manager': 'product-manager',
        'project-manager': 'project-manager',
        'tech-lead': 'tech-lead',
        'developer': 'developer',
        'judge': 'judge',
        'qa-engineer': 'qa-engineer',
        'fixer': 'fixer',
        'auto-merge': 'auto-merge'
      };

      const phase = phaseMapping[agentType] || 'developer';

      // Generate smart context
      const injectedContext = await contextInjector.generateContext({
        phase,
        taskDescription: prompt.substring(0, 500), // First 500 chars for context
        workspacePath,
        focusAreas: [] // Could extract from prompt
      });

      smartContextBlock = injectedContext.formattedContext;

      // Get relevant memories
      const memories = memoryBridge.recallForPhase(phase, 8);
      if (memories.length > 0) {
        smartContextBlock += memoryBridge.formatForPrompt(memories, 'RELEVANT MEMORIES FROM PREVIOUS PHASES');
      }

      console.log(`🧠 [ExecuteAgent] Smart context injected: ${smartContextBlock.length} chars`);
    } catch (contextError) {
      console.warn(`⚠️ [ExecuteAgent] Smart context generation failed (non-critical):`, contextError);
      // Continue without smart context - not a critical failure
    }

    // Build final prompt with smart context
    // When images are present, use generator function (required by SDK)
    let promptContent: string | AsyncGenerator;

    if (attachments && attachments.length > 0) {
      console.log(`📸 [ExecuteAgent] Building prompt with ${attachments.length} image(s) using generator`);

      const content: any[] = [
        {
          type: 'text',
          text: `${agentDef.prompt}\n\n${smartContextBlock}\n\n${prompt}`
        }
      ];

      for (const attachment of attachments) {
        if (attachment.type === 'image' && attachment.source) {
          content.push({
            type: 'image',
            source: attachment.source,
          });
        }
      }

      console.log(`📸 [ExecuteAgent] Content blocks: ${content.length} (${content.filter(c => c.type === 'image').length} images)`);

      // Generator function required by SDK for images
      promptContent = (async function*() {
        yield {
          type: "user" as const,
          message: {
            role: "user" as const,
            content,
          }
        };
      })();
    } else {
      // Simple string prompt when no images - include smart context
      promptContent = `${agentDef.prompt}\n\n${smartContextBlock}\n\n${prompt}`;
    }

    // 🔥 RETRY MECHANISM for SDK errors (JSON parsing, connection issues)
    const MAX_SDK_RETRIES = 3;
    let lastError: any = null;

    for (let sdkAttempt = 1; sdkAttempt <= MAX_SDK_RETRIES; sdkAttempt++) {
      try {
        if (sdkAttempt > 1) {
          console.log(`\n🔄 [ExecuteAgent] SDK RETRY attempt ${sdkAttempt}/${MAX_SDK_RETRIES} for ${agentType}`);
          // Wait before retry (exponential backoff)
          const delay = Math.min(5000 * Math.pow(2, sdkAttempt - 2), 30000);
          console.log(`   Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Execute agent using SDK query() with correct API
        // https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode

        // NO LIMIT on turns - agents need to explore codebase thoroughly
        // maxTurns = number of conversation rounds (user→assistant→tools→assistant)
        // Not "retry attempts" - it's legitimate exploration with tools

        // Let SDK manage everything - tools, turns, iterations
        console.log(`🤖 [ExecuteAgent] Starting ${agentType} agent with SDK (attempt ${sdkAttempt}/${MAX_SDK_RETRIES})`);

      // 🔑 Get API key from context (project-specific or user default)
      let apiKey: string | undefined = process.env.ANTHROPIC_API_KEY;
      let apiKeySource: string = 'environment';

      if (taskId && contextOverride) {
        const contextApiKey = contextOverride.getData('anthropicApiKey') as string | undefined;
        const contextSource = contextOverride.getData('apiKeySource') as string | undefined;

        if (contextApiKey) {
          apiKey = contextApiKey;
          apiKeySource = contextSource || 'context';
        }
      }

      console.log(`🔑 [ExecuteAgent] API Key check:`, {
        hasApiKey: !!apiKey,
        keyLength: apiKey?.length || 0,
        source: apiKeySource,
        nodeVersion: process.version,
        platform: process.platform,
      });

      if (!apiKey) {
        throw new Error(
          `No Anthropic API key available for agent execution. ` +
          `Please configure a project API key, user default API key, or ANTHROPIC_API_KEY environment variable.`
        );
      }

      // SDK query - with MCP tools for enhanced capabilities
      console.log(`📡 [ExecuteAgent] Calling SDK with model: ${model}`);
      console.log(`🔧 [ExecuteAgent] Including MCP tools: custom-dev-tools, extra-tools`);

      // 🔥 PERMISSION MODE: All agents use 'bypassPermissions' for autonomous execution
      // NOTE: 'plan' mode causes INTERACTIVE behavior (asks questions) - NOT suitable for autonomous agents
      // We rely on prompts to restrict agents to appropriate operations (read-only for planning, etc.)
      const effectivePermissionMode = permissionMode || 'bypassPermissions';

      console.log(`🔐 [ExecuteAgent] Permission mode: ${effectivePermissionMode}`);

      // Create MCP servers for custom tools
      const customToolsServer = createCustomToolsServer();
      const extraToolsServer = createExtraToolsServer();
      const exploratoryToolsServer = createExploratoryToolsServer();

      let stream;
      try {
        stream = query({
          prompt: promptContent as any,
          options: {
            cwd: workspacePath,
            model, // Explicit model ID: claude-haiku-4-5-*, claude-sonnet-4-5-*, claude-opus-4-5-*
            // NO maxTurns limit - let Claude iterate freely (can handle 100k+ turns/min)
            permissionMode: effectivePermissionMode,
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey, // Use project/user-specific API key
            },
            // 🔧 MCP Tools - Enhanced agent capabilities
            mcpServers: {
              'custom-dev-tools': customToolsServer,
              'extra-tools': extraToolsServer,
              'exploratory-tools': exploratoryToolsServer,
            },
          },
        });

        console.log(`✅ [ExecuteAgent] SDK query() call successful, stream created`);
      } catch (queryError: any) {
        console.error(`❌ [ExecuteAgent] Failed to create SDK stream:`, {
          message: queryError.message,
          stack: queryError.stack,
          code: queryError.code,
          fullError: queryError
        });
        throw new Error(`SDK query failed: ${queryError.message}`);
      }

      // 🔥 TRUST THE SDK: Let SDK handle all timeouts and error recovery
      // We simply consume the stream and collect messages
      let finalResult: any = null;
      const allMessages: any[] = [];
      let turnCount = 0;

      // 🔥 LOOP DETECTION: Detect stuck agents by counting messages without tool activity
      // SDK sends assistant/user messages that CONTAIN tool_use/tool_result as content blocks
      let messagesWithoutToolUse = 0;
      const MAX_MESSAGES_WITHOUT_TOOL_USE = 100; // Higher threshold - only catch truly stuck agents

      // 🔥 HISTORY DETECTION: Track if we've received first turn_start (agent is actually active)
      // SDK may send conversation history (assistant/user messages) before agent starts working
      let agentStarted = false;
      let historyMessagesReceived = 0;
      const MAX_HISTORY_MESSAGES = 200; // Fail-safe: abort if too much history without agent starting
      const startTime = Date.now();

      console.log(`🔄 [ExecuteAgent] Starting to consume stream messages...`);
      console.log(`   SDK will handle timeouts and error recovery automatically`);
      console.log(`   Loop detection: ${MAX_MESSAGES_WITHOUT_TOOL_USE} messages without tool activity`);
      console.log(`   History limit: ${MAX_HISTORY_MESSAGES} messages before agent must start`);

      // 🔥 EXTERNAL WATCHDOG: Timer that fires if no message received for too long
      // This catches cases where stream.next() blocks forever
      // No global timeout - trust the agent as long as it's making progress
      const MESSAGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max between messages
      let lastMessageTime = Date.now();
      let watchdogTriggered = false;

      const watchdogInterval = setInterval(() => {
        const timeSinceLastMessage = Date.now() - lastMessageTime;
        const totalElapsed = Date.now() - startTime;

        if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
          console.error(`\n${'='.repeat(80)}`);
          console.error(`🚨 WATCHDOG TIMEOUT: No message received in ${Math.floor(timeSinceLastMessage / 1000)}s`);
          console.error(`   Agent: ${agentType}`);
          console.error(`   Total elapsed: ${Math.floor(totalElapsed / 1000)}s`);
          console.error(`   Messages received: ${allMessages.length}`);
          console.error(`   Turns completed: ${turnCount}`);
          console.error(`${'='.repeat(80)}\n`);
          watchdogTriggered = true;
          // Note: We can't abort the stream from here, but we set a flag
          // The main loop will check this flag on each iteration
        }
      }, 30000); // Check every 30 seconds

      try {
        // Simple stream consumption - SDK handles everything
        for await (const message of stream) {
          // Update watchdog timer
          lastMessageTime = Date.now();

          // 🔥 CHECK WATCHDOG: If triggered while we were waiting, abort now
          if (watchdogTriggered) {
            const error = new Error(`Agent ${agentType} stream timeout - watchdog triggered`);
            (error as any).isTimeout = true;
            (error as any).isWatchdogTimeout = true;
            throw error;
          }
          allMessages.push(message);

          // 🔥 LOOP DETECTION: Check if this message contains tool activity
          const messageType = (message as any).type;
          const messageContent = (message as any).message?.content || [];

          // Check for tool activity in message content (SDK nests tool_use inside assistant messages)
          const hasToolActivity =
            messageType === 'result' ||
            messageType === 'turn_start' ||
            (Array.isArray(messageContent) && messageContent.some((block: any) =>
              block.type === 'tool_use' || block.type === 'tool_result'
            ));

          // 🔥 AGENT STARTED: First turn_start means agent is actively working
          if (messageType === 'turn_start') {
            if (!agentStarted) {
              console.log(`✅ [ExecuteAgent] Agent started after ${historyMessagesReceived} history messages`);
              agentStarted = true;
            }
          }

          // 🔥 HISTORY PROTECTION: Count messages before agent starts
          if (!agentStarted) {
            historyMessagesReceived++;

            // Fail-safe: too much history without agent starting
            if (historyMessagesReceived >= MAX_HISTORY_MESSAGES) {
              const lastFewTypes = allMessages.slice(-10).map(m => (m as any).type).join(', ');
              console.error(`\n${'='.repeat(80)}`);
              console.error(`🚨 HISTORY OVERFLOW: ${historyMessagesReceived} messages without agent starting`);
              console.error(`   Agent: ${agentType}`);
              console.error(`   Last 10 message types: ${lastFewTypes}`);
              console.error(`${'='.repeat(80)}\n`);

              const error = new Error(
                `Agent ${agentType} failed to start: ${historyMessagesReceived} messages without turn_start. ` +
                `SDK may be stuck replaying history. Last message types: ${lastFewTypes}`
              );
              (error as any).isHistoryOverflow = true;
              throw error;
            }

            // Don't count history messages toward loop detection - skip to next message
            continue;
          }

          if (hasToolActivity) {
            // Reset counter on tool activity
            messagesWithoutToolUse = 0;
          } else {
            // Increment counter for messages without tool activity
            messagesWithoutToolUse++;

            // Check if stuck (only after many messages without ANY tool use)
            if (messagesWithoutToolUse >= MAX_MESSAGES_WITHOUT_TOOL_USE) {
              const lastFewTypes = allMessages.slice(-10).map(m => (m as any).type).join(', ');
              console.error(`\n${'='.repeat(80)}`);
              console.error(`🚨 LOOP DETECTED: ${messagesWithoutToolUse} consecutive messages without tool activity`);
              console.error(`   Agent: ${agentType}`);
              console.error(`   Turn count: ${turnCount}`);
              console.error(`   Last 10 message types: ${lastFewTypes}`);
              console.error(`${'='.repeat(80)}\n`);

              if (taskId) {
                NotificationService.emitConsoleLog(
                  taskId,
                  'error',
                  `🚨 Agent ${agentType} stuck in loop - aborting after ${messagesWithoutToolUse} messages without tool activity`
                );
              }

              // Throw error to break out of the stream
              const loopError = new Error(
                `Agent ${agentType} stuck in loop: ${messagesWithoutToolUse} consecutive messages without tool activity. ` +
                `Last message types: ${lastFewTypes}`
              );
              (loopError as any).isLoopDetection = true;
              throw loopError;
            }
          }

          // 🔥 CRITICAL: Log FULL message if it has an error flag
          if ((message as any).is_error === true) {
            console.error(`\n${'='.repeat(80)}`);
            console.error(`🔥 ERROR MESSAGE DETECTED IN STREAM`);
            console.error(`${'='.repeat(80)}`);
            console.error(`Message type: ${message.type}`);
            console.error(`Full message object:`);
            console.error(JSON.stringify(message, null, 2));
            console.error(`${'='.repeat(80)}\n`);
          }

          // Log every message type for debugging
          if ((message as any).type !== 'tool_use' && (message as any).type !== 'tool_result' && (message as any).type !== 'text') {
            console.log(`📨 [ExecuteAgent] Received message type: ${message.type}`, {
              hasSubtype: !!(message as any).subtype,
              isError: !!(message as any).is_error,
            });
          }

          // 🔥 REAL-TIME VISIBILITY: Log what the agent is doing
          if ((message as any).type === 'turn_start') {
            turnCount++;
            console.log(`\n🔄 [${agentType}] Turn ${turnCount} started`);
            if (taskId) {
              NotificationService.emitConsoleLog(taskId, 'info', `🔄 Turn ${turnCount} - Agent working...`);
            }
          }

          if ((message as any).type === 'tool_use') {
            const tool = (message as any).name || 'unknown';
            const input = (message as any).input || {};
            // toolId available in (message as any).id for matching with result if needed
            console.log(`🔧 [${agentType}] Turn ${turnCount}: Using tool ${tool}`);

            // 🎯 Emit structured activity for real-time frontend display
            if (taskId) {
              // Emit tool use event (will be paired with result)
              AgentActivityService.emitToolUse(taskId, agentType, tool, input);
            }

            // Log file operations for visibility
            if (tool === 'Read' && input.file_path) {
              console.log(`   📖 Reading: ${input.file_path}`);
              if (taskId) {
                NotificationService.emitConsoleLog(taskId, 'info', `📖 Reading ${input.file_path}`);
              }
            } else if (tool === 'Edit' && input.file_path) {
              console.log(`   ✏️  Editing: ${input.file_path}`);
              if (taskId) {
                NotificationService.emitConsoleLog(taskId, 'info', `✏️ Editing ${input.file_path}`);
              }
            } else if (tool === 'Write' && input.file_path) {
              console.log(`   📝 Writing: ${input.file_path}`);
              if (taskId) {
                NotificationService.emitConsoleLog(taskId, 'info', `📝 Writing ${input.file_path}`);
              }
            } else if (tool === 'Bash' && input.command) {
              const cmd = input.command;

              // 🔥 DETAILED GIT LOGGING - Show full command for git operations
              if (cmd.includes('git')) {
                console.log(`   🌿 GIT COMMAND: ${cmd}`);
                if (taskId) {
                  NotificationService.emitConsoleLog(taskId, 'info', `🌿 GIT: ${cmd}`);
                }
              } else {
                const cmdPreview = cmd.substring(0, 80);
                console.log(`   💻 Running: ${cmdPreview}${cmd.length > 80 ? '...' : ''}`);
                if (taskId) {
                  NotificationService.emitConsoleLog(taskId, 'info', `💻 ${cmdPreview}${cmd.length > 80 ? '...' : ''}`);
                }
              }
            }
          }

          if ((message as any).type === 'tool_result') {
            const status = (message as any).is_error ? '❌' : '✅';
            const result = (message as any).content || (message as any).result || '';

            // 🔥 LOG TOOL RESULT - especially for git commands
            console.log(`${status} [${agentType}] Tool completed`);

            if (result && typeof result === 'string' && result.length > 0) {
              // Show result preview
              const resultPreview = result.substring(0, 200).replace(/\n/g, ' ');
              console.log(`   📤 Result: ${resultPreview}${result.length > 200 ? '...' : ''}`);
            }
          }

          if ((message as any).type === 'text') {
            const text = (message as any).text || '';
            if (text.length > 0) {
              const preview = text.substring(0, 100);
              console.log(`💬 [${agentType}] Agent says: ${preview}...`);
            }
          }

          if (message.type === 'result') {
            finalResult = message;

            // 🔥 CHECK FOR ERROR RESULT
            if ((message as any).is_error || (message as any).subtype === 'error') {
              console.error(`❌ [ExecuteAgent] SDK returned error result:`, {
                subtype: (message as any).subtype,
                is_error: (message as any).is_error,
                result: (message as any).result,
                error: (message as any).error,
                error_message: (message as any).error_message,
                fullMessage: JSON.stringify(message, null, 2),
              });
            }

            console.log(`✅ [ExecuteAgent] Agent ${agentType} completed after ${turnCount} turns`);
          }
        }
      } catch (streamError: any) {
        // Clear watchdog on error
        clearInterval(watchdogInterval);
        const streamDurationMs = Date.now() - startTime;
        const lastMessageTypes = allMessages.slice(-20).map(m => (m as any).type);

        console.error(`❌ [ExecuteAgent] Error consuming stream:`, {
          message: streamError.message,
          stack: streamError.stack,
          code: streamError.code,
          turnCount,
          streamDurationMs,
          lastMessages: allMessages.slice(-3),
          isLoopDetection: streamError.isLoopDetection || false,
          isTimeout: streamError.isTimeout || false,
          isHistoryOverflow: streamError.isHistoryOverflow || false,
        });

        // 🔥 LOOP DETECTION: Don't retry loop errors - they won't magically fix themselves
        if (streamError.isLoopDetection) {
          console.error(`🚨 [ExecuteAgent] Loop detected - NOT retrying (would just loop again)`);
          // Mark as non-retryable by adding specific flag
          streamError.isNonRetryable = true;
        }

        // 💾 PERSIST FAILED EXECUTION for later retry
        await this.saveFailedExecution({
          taskId,
          agentType,
          agentName: _agentName,
          prompt: typeof promptContent === 'string' ? promptContent : prompt,
          workspacePath,
          model,
          permissionMode: effectivePermissionMode,
          error: streamError,
          diagnostics: {
            messagesReceived: allMessages.length,
            historyMessages: historyMessagesReceived,
            turnsCompleted: turnCount,
            lastMessageTypes,
            streamDurationMs,
          },
          context: contextOverride,
        });

        // Re-throw - SDK already provides detailed error info
        throw streamError;
      }

      // Clear watchdog on successful completion
      clearInterval(watchdogInterval);

      console.log(`✅ [ExecuteAgent] ${agentType} completed successfully`);

      // 🔍 DEBUG: Log the structure of finalResult to understand what SDK returns
      console.log('\n🔍 [DEBUG] finalResult structure:');
      console.log('  - Type:', typeof finalResult);
      console.log('  - Keys:', finalResult ? Object.keys(finalResult) : 'null');
      console.log('  - Has content:', finalResult?.content ? 'yes' : 'no');
      if (finalResult?.content) {
        console.log('  - Content type:', Array.isArray(finalResult.content) ? 'array' : typeof finalResult.content);
        console.log('  - Content length:', Array.isArray(finalResult.content) ? finalResult.content.length : 'N/A');
      }
      console.log('  - Full finalResult:', JSON.stringify(finalResult, null, 2).substring(0, 500));

      // Extract output text from result
      const output = this.extractOutputText(finalResult, allMessages) || '';

      console.log(`\n📝 [ExecuteAgent] Extracted output length: ${output.length} chars`);
      console.log(`📝 [ExecuteAgent] Output preview: ${output.substring(0, 200)}...`);

      // Calculate cost with ACTUAL pricing for Claude models (from official docs)
      // Source: https://docs.anthropic.com/en/docs/about-claude/pricing
      //
      // Claude 4.5 Models (per million tokens):
      // - Haiku 4.5:  Input $1, Output $5
      // - Sonnet 4.5: Input $3, Output $15
      // - Opus 4.5:   Input $5, Output $25
      //
      // Prompt Caching (multipliers on input price):
      // - cache_creation_input_tokens: 1.25x input price
      // - cache_read_input_tokens: 0.1x input price

      const usage = (finalResult as any)?.usage || {};
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = usage.cache_read_input_tokens || 0;

      // Determine pricing based on model alias (haiku, sonnet, opus)
      const { MODEL_PRICING } = await import('../../config/ModelConfigurations');

      const pricing = MODEL_PRICING[modelAlias as keyof typeof MODEL_PRICING];
      if (!pricing) {
        throw new Error(
          `❌ [ExecuteAgent] No pricing found for model alias "${modelAlias}". ` +
          `Valid aliases: ${Object.keys(MODEL_PRICING).join(', ')}`
        );
      }
      const inputPricePerMillion = pricing.inputPerMillion;
      const outputPricePerMillion = pricing.outputPerMillion;

      console.log(`   Model: ${model} (alias: ${modelAlias})`);

      // Calculate cost including cache tokens
      // - Regular input: inputPrice
      // - Cache creation: 1.25x inputPrice
      // - Cache read: 0.1x inputPrice (big discount for reusing cache)
      const inputCost = (inputTokens * inputPricePerMillion) / 1_000_000;
      const outputCost = (outputTokens * outputPricePerMillion) / 1_000_000;
      const cacheCreationCost = (cacheCreationTokens * inputPricePerMillion * 1.25) / 1_000_000;
      const cacheReadCost = (cacheReadTokens * inputPricePerMillion * 0.1) / 1_000_000;
      const cost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

      console.log(`💰 [ExecuteAgent] ${agentType} cost calculation:`);
      console.log(`   Input tokens: ${inputTokens} @ $${inputPricePerMillion}/MTok = $${inputCost.toFixed(4)}`);
      console.log(`   Output tokens: ${outputTokens} @ $${outputPricePerMillion}/MTok = $${outputCost.toFixed(4)}`);
      if (cacheCreationTokens > 0) {
        console.log(`   Cache creation: ${cacheCreationTokens} @ $${(inputPricePerMillion * 1.25).toFixed(2)}/MTok = $${cacheCreationCost.toFixed(4)}`);
      }
      if (cacheReadTokens > 0) {
        console.log(`   Cache read: ${cacheReadTokens} @ $${(inputPricePerMillion * 0.1).toFixed(2)}/MTok = $${cacheReadCost.toFixed(4)}`);
      }
      console.log(`   Total cost: $${cost.toFixed(4)}`);

      return {
        output: output,
        usage: (finalResult as any)?.usage || {},
        cost: cost,
        stopReason: (finalResult as any)?.stop_reason,
        sessionId: sessionId,
        canResume: false,
        rawResult: finalResult,
        allMessages,
      };
      } catch (error: any) {
        console.error(`❌ [ExecuteAgent] ${agentType} failed (attempt ${sdkAttempt}/${MAX_SDK_RETRIES}):`, error.message);
        console.error(`❌ [ExecuteAgent] Error type:`, error.constructor.name);
        console.error(`❌ [ExecuteAgent] Error code:`, error.code);
        console.error(`❌ [ExecuteAgent] Exit code:`, error.exitCode);
        console.error(`❌ [ExecuteAgent] Signal:`, error.signal);
        console.error(`❌ [ExecuteAgent] Full error object:`, JSON.stringify(error, null, 2));
        console.error(`❌ [ExecuteAgent] Stack:`, error.stack);

        lastError = error;

        // 🔥 LOOP DETECTION: Never retry loop errors - they won't fix themselves
        if (error.isNonRetryable || error.isLoopDetection) {
          console.error(`🚨 [ExecuteAgent] Non-retryable error (loop detection or explicit flag) - failing immediately`);
          throw error;
        }

        // 🔥 Check if this is a retryable error (JSON parsing, connection issues)
        const isRetryableError = (
          error.message?.includes('Unterminated string in JSON') ||
          error.message?.includes('JSON') ||
          error.message?.includes('ECONNRESET') ||
          error.message?.includes('ETIMEDOUT') ||
          error.message?.includes('socket hang up') ||
          error.constructor.name === 'SyntaxError'
        );

        if (isRetryableError && sdkAttempt < MAX_SDK_RETRIES) {
          console.log(`🔄 [ExecuteAgent] Retryable error detected, will retry...`);
          console.log(`   Error: ${error.message}`);
          continue; // Retry
        }

        // Non-retryable error or max retries reached
        console.error(`❌ [ExecuteAgent] ${isRetryableError ? 'Max retries reached' : 'Non-retryable error'}`);

        // Check if workspace still exists
        const fs = require('fs');
        const workspaceStillExists = fs.existsSync(workspacePath);
        console.error(`❌ [ExecuteAgent] Workspace exists after error:`, workspaceStillExists);

        // Check if .env has API key
        const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
        console.error(`❌ [ExecuteAgent] ANTHROPIC_API_KEY still set:`, hasEnvKey);

        throw error;
      }
    }

    // This should never be reached (loop always returns or throws)
    throw lastError || new Error(`${agentType} failed after ${MAX_SDK_RETRIES} attempts`);
  }

  /**
   * Extract text output from SDK query result
   *
   * Tries multiple strategies to extract text from SDK messages:
   * 1. finalResult.content[] (standard SDK format)
   * 2. Search all messages for 'assistant' messages with text content
   * 3. Search all messages for any text blocks
   */
  private extractOutputText(result: any, allMessages?: any[]): string {
    const outputs: string[] = [];

    console.log('\n🔍 [extractOutputText] Starting extraction...');

    // Strategy 1: Extract from finalResult.content
    if (result?.content && Array.isArray(result.content)) {
      console.log('  ✅ Strategy 1: Found result.content array');
      const textBlocks = result.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text);

      if (textBlocks.length > 0) {
        outputs.push(...textBlocks);
        console.log(`  ✅ Extracted ${textBlocks.length} text block(s) from result.content`);
      }
    } else {
      console.log('  ⚠️  Strategy 1 failed: result.content not found or not array');
    }

    // Strategy 2: Search all messages for assistant responses
    if (allMessages && allMessages.length > 0) {
      console.log(`  🔍 Strategy 2: Searching ${allMessages.length} messages for assistant responses`);

      for (const msg of allMessages) {
        // Look for message.message.content (SDK might nest it)
        if (msg?.message?.role === 'assistant' && msg?.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            const textBlocks = content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text);

            if (textBlocks.length > 0) {
              outputs.push(...textBlocks);
              console.log(`  ✅ Found ${textBlocks.length} text block(s) in assistant message`);
            }
          }
        }

        // Also check top-level content
        if (msg?.content && Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text);

          if (textBlocks.length > 0) {
            outputs.push(...textBlocks);
            console.log(`  ✅ Found ${textBlocks.length} text block(s) in message.content`);
          }
        }
      }
    }

    // Strategy 3: Fallback - try to extract any text field
    if (outputs.length === 0 && result) {
      console.log('  ⚠️  Strategy 3: Fallback - searching for any text fields');

      // Try result.text
      if (typeof result.text === 'string') {
        outputs.push(result.text);
        console.log('  ✅ Found result.text');
      }

      // Try result.output
      if (typeof result.output === 'string') {
        outputs.push(result.output);
        console.log('  ✅ Found result.output');
      }
    }

    const finalOutput = outputs.join('\n\n').trim();
    console.log(`\n✅ [extractOutputText] Final output: ${finalOutput.length} chars`);

    return finalOutput;
  }

  /**
   * Execute a developer agent (specialized for code writing)
   *
   * Developers are restricted to:
   * - Read, Write, Edit, Bash, Grep, Glob tools
   * - MUST write code (not documentation)
   * - Work on assigned story with exact file paths
   */
  private async executeDeveloper(
    task: ITask,
    member: any,
    repositories: any[],
    workspacePath: string,
    _workspaceStructure: string,
    attachments?: any[], // Receive attachments from context
    stories?: any[], // Receive stories from event store
    epics?: any[], // Receive epics from event store
    judgeFeedback?: string, // Judge feedback for retry attempts
    _epicBranchName?: string, // Epic branch name from TeamOrchestrationPhase (unused - branches come from story.branchName)
    forceTopModel?: boolean, // 🔥 NEW: Force use of topModel (for retry after Judge rejection)
    devAuth?: any, // 🔐 Developer authentication config (token or credentials for testing endpoints)
    architectureBrief?: any, // 🏗️ Architecture insights from PlanningPhase (patterns, conventions, models)
    environmentCommands?: any // 🔧 Environment commands from TechLead (test, lint, typecheck, etc.)
  ): Promise<{ output?: string; cost?: number } | void> {
    const taskId = (task._id as any).toString();

    // 🚀 RETRY OPTIMIZATION: Use topModel when Judge rejected code
    if (forceTopModel && judgeFeedback) {
      const configs = await import('../../config/ModelConfigurations');

      // Get the actual AgentModelConfig from the task (default to RECOMMENDED)
      let actualConfig: typeof configs.RECOMMENDED_CONFIG = configs.RECOMMENDED_CONFIG;

      if (task.orchestration.modelConfig) {
        const { preset, customConfig } = task.orchestration.modelConfig;

        if (preset === 'custom' && customConfig) {
          actualConfig = configs.mapDbConfigToAgentModelConfig(customConfig);
        } else if (preset) {
          switch (preset) {
            case 'max': actualConfig = configs.MAX_CONFIG; break;
            case 'premium': actualConfig = configs.PREMIUM_CONFIG; break;
            case 'recommended': actualConfig = configs.RECOMMENDED_CONFIG; break;
            case 'standard': actualConfig = configs.STANDARD_CONFIG; break;
          }
        }
      }

      const topModel = configs.getTopModelFromConfig(actualConfig);
      const topModelName = topModel.includes('opus') ? 'Opus' :
                          topModel.includes('sonnet') ? 'Sonnet' : 'Haiku';

      console.log(`🚀 [Developer ${member.instanceId}] RETRY with topModel: ${topModelName}`);
      console.log(`   Reason: Judge rejected code, using best available model for retry`);

      // Temporarily override developer model to topModel
      const updatedConfig: typeof configs.RECOMMENDED_CONFIG = {
        ...actualConfig,
        'developer': topModel
      };

      // Save back with correct structure (preset + customConfig wrapper)
      task.orchestration.modelConfig = {
        preset: 'custom',
        customConfig: updatedConfig as any
      };
    }

    // 🔥🔥🔥 STRICT VALIDATION: 1 DEVELOPER = 1 STORY (NEVER MORE) 🔥🔥🔥
    if (!stories || stories.length === 0) {
      console.warn(`⚠️  [Developer ${member.instanceId}] No stories provided, skipping`);
      return;
    }

    if (stories.length > 1) {
      console.error(`❌❌❌ [CRITICAL VIOLATION] Developer ${member.instanceId} received ${stories.length} stories!`);
      console.error(`   Stories: ${stories.map((s: any) => s.id || s.title).join(', ')}`);
      console.error(`   RULE: 1 Developer = 1 Story. ALWAYS. NO EXCEPTIONS.`);
      throw new Error(
        `CRITICAL: Developer ${member.instanceId} received ${stories.length} stories. ` +
        `Rule violation: 1 Developer = 1 Story. Fix the calling code.`
      );
    }

    // Get epics from EventStore or fallback to techLead
    const epicsList = epics || (task.orchestration.techLead as any)?.epics || [];
    if (epicsList.length === 0) {
      console.error(`❌ [Developer ${member.instanceId}] No epics available (EventStore or TechLead)`);
      throw new Error('No epics available - cannot determine target repositories');
    }

    // 🔥 CRITICAL FIX: Use the `stories` parameter directly!
    // DevelopersPhase passes exactly the stories this developer should work on.
    // member.assignedStories is stale (has ALL stories from TechLead, not filtered).
    // When using isolated story pipeline, only 1 story is passed.
    const storiesToProcess = stories; // Use parameter directly, NOT member.assignedStories

    console.log(`👨‍💻 [Developer ${member.instanceId}] Starting work on ${storiesToProcess.length} stories`);

    let lastResult: { output?: string; cost?: number } | undefined;

    for (const story of storiesToProcess) {
      if (!story || !story.id) {
        console.warn(`⚠️  [Developer ${member.instanceId}] Invalid story object, skipping`);
        continue;
      }

      console.log(`📝 [Developer ${member.instanceId}] Working on story: ${story.title}`);

      // 🔥 CRITICAL FIX: Get target repository from STORY (inherited from epic in TechLeadPhase)
      // Stories now have targetRepository field directly - no need to look up epic
      const targetRepository = story.targetRepository;

      // 🔥 VALIDATION: targetRepository MUST exist (set by TechLeadPhase)
      if (!targetRepository) {
        console.error(`❌ [Developer ${member.instanceId}] Story ${story.id} has NO targetRepository!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Epic: ${story.epicId}`);
        console.error(`   Available repositories: ${repositories.map(r => r.name || r.githubRepoName).join(', ')}`);
        console.error(`   🔥 CRITICAL: This should have been set by TechLeadPhase - check EventStore`);

        // Mark task as failed instead of using dangerous fallback
        const Task = require('../../models/Task').Task;
        const dbTask = await Task.findById(task._id);
        if (dbTask) {
          dbTask.status = 'failed';
          dbTask.orchestration.developers = {
            status: 'failed',
            error: `Story ${story.id} missing targetRepository - data integrity issue`,
          };
          await dbTask.save();
        }

        throw new Error(`Story ${story.id} has no targetRepository - cannot execute developer. Task marked as FAILED.`);
      }

      // 🔥 CRITICAL FIX: Extract repo name from full path (e.g., "devwspito/v2_frontend" → "v2_frontend")
      // Git clones repos with just the repo name, not the full owner/repo path
      const { normalizeRepoName } = require('../../utils/safeGitExecution');
      const repoName = normalizeRepoName(
        targetRepository.includes('/')
          ? targetRepository.split('/').pop() || targetRepository
          : targetRepository
      );

      console.log(`📂 [Developer ${member.instanceId}] Target repository: ${targetRepository}`);
      console.log(`📂 [Developer ${member.instanceId}] Repository directory: ${repoName}`);
      console.log(`📂 [Developer ${member.instanceId}] Workspace: ${workspacePath}`);

      // Build developer prompt - Rich context per SDK philosophy
      const projectId = task.projectId?.toString() || '';

      // 💡 Get any injected directives for developers from task
      const directivesBlock = await this.getDirectivesForAgent(task._id as any, 'developer');

      // Extract story-specific guidance (from TechLead enhanced format)
      const storyHelpers = story.mustUseHelpers || [];
      const storyAntiPatterns = story.antiPatterns || [];
      const storyCodeExamples = story.codeExamples || [];
      const storyAcceptanceCriteria = story.acceptanceCriteria || [];

      // 🔍 Smart file analysis - understand dependencies and impact
      let fileAnalysisSection = '';
      const filesToModify = story.filesToModify || [];
      const filesToCreate = story.filesToCreate || [];

      if (filesToModify.length > 0 || filesToCreate.length > 0) {
        try {
          const { SmartCodeAnalyzer } = await import('../SmartCodeAnalyzer');
          const targetFiles = [...filesToModify, ...filesToCreate];
          const suggestions = SmartCodeAnalyzer.getSuggestedReads(targetFiles, workspacePath, 8);

          if (suggestions.length > 0) {
            fileAnalysisSection = `
## 📊 SMART FILE ANALYSIS

Before making changes, understand these file relationships:

| File | Why Read This |
|------|---------------|
${suggestions.map(s => `| \`${s.file}\` | ${s.reason} |`).join('\n')}

**Read these files first** to understand the existing patterns and avoid breaking changes.
`;
          }
        } catch (error: any) {
          console.log(`   ⚠️ Smart analysis skipped: ${error.message}`);
        }
      }

      let prompt = `${directivesBlock}# Story: ${story.title}

${story.description}

${storyAcceptanceCriteria.length > 0 ? `## ✅ ACCEPTANCE CRITERIA
${storyAcceptanceCriteria.map((ac: string, i: number) => `${i + 1}. ${ac}`).join('\n')}
` : ''}
${fileAnalysisSection}
${storyHelpers.length > 0 ? `## 🔧 REQUIRED HELPERS (YOU MUST USE THESE!)
${storyHelpers.map((h: any) => `- **\`${h.function}()\`** from \`${h.from}\`
  - Reason: ${h.reason}`).join('\n')}
` : ''}
${storyAntiPatterns.length > 0 ? `## ❌ ANTI-PATTERNS (DO NOT DO THIS!)
${storyAntiPatterns.map((ap: any) => `- ❌ BAD: \`${ap.bad}\`
  - Why: ${ap.why}
  - ✅ GOOD: \`${ap.good}\``).join('\n\n')}
` : ''}
${storyCodeExamples.length > 0 ? `## 📝 CODE EXAMPLES (Follow These!)
${storyCodeExamples.map((ex: any) => `### ${ex.description}
\`\`\`typescript
${ex.code}
\`\`\`
${ex.doNot ? `❌ DO NOT: \`${ex.doNot}\`` : ''}`).join('\n\n')}
` : ''}
## 🎯 TARGET REPOSITORY: ${targetRepository}
**CRITICAL**: You MUST work ONLY in the "${targetRepository}" directory.
- All file paths must start with: ${targetRepository}/
- Navigate to this repository first: cd ${workspacePath}/${targetRepository}
- DO NOT modify files in other repositories

## 🧠 MEMORY CONTEXT (Use these IDs for memory tools)
- **Project ID**: \`${projectId}\`
- **Task ID**: \`${taskId}\`
- **Story ID**: \`${story.id}\`

Use these when calling \`recall()\` and \`remember()\` tools.`;

      // 🏗️ Add Architecture Brief section from PlanningPhase
      if (architectureBrief) {
        prompt += `\n\n## 🏗️ ARCHITECTURE BRIEF (CRITICAL - Follow These Patterns!)

**This project has established patterns. You MUST follow them to get your PR approved.**

${architectureBrief.codePatterns ? `### Code Patterns (from existing codebase)
- **Naming Convention**: ${architectureBrief.codePatterns.namingConvention || 'Not specified'}
- **File Structure**: ${architectureBrief.codePatterns.fileStructure || 'Not specified'}
- **Error Handling**: ${architectureBrief.codePatterns.errorHandling || 'Not specified'}
- **Testing Pattern**: ${architectureBrief.codePatterns.testing || 'Not specified'}` : ''}

${architectureBrief.dataModels?.length > 0 ? `### Data Models (understand relationships before modifying)
${architectureBrief.dataModels.map((m: any) => `- **${m.name}** (${m.file}): ${m.relationships?.join(', ') || 'standalone'}`).join('\n')}` : ''}

${architectureBrief.prInsights ? `### What Gets Approved (from recent PRs)
- ${architectureBrief.prInsights.commonPatterns?.join('\n- ') || 'No patterns documented'}

**Rejection reasons to avoid**:
- ${architectureBrief.prInsights.rejectionReasons?.join('\n- ') || 'None documented'}` : ''}

${architectureBrief.conventions?.length > 0 ? `### Project Conventions
${architectureBrief.conventions.map((c: string) => `- ${c}`).join('\n')}` : ''}

${architectureBrief.helperFunctions?.length > 0 ? `### 🔧 MANDATORY HELPER FUNCTIONS (USE THESE!)
| Function | File | What to Use | What NOT to Use |
|----------|------|-------------|-----------------|
${architectureBrief.helperFunctions.map((h: any) => `| \`${h.name}()\` | ${h.file} | ✅ ${h.usage} | ❌ ${h.antiPattern} |`).join('\n')}

**🚨 CRITICAL: You MUST use these helper functions. DO NOT create entities manually!**` : ''}

${architectureBrief.entityCreationRules?.length > 0 ? `### 📋 ENTITY CREATION RULES (MANDATORY!)
| Entity | MUST Use | NEVER Use |
|--------|----------|-----------|
${architectureBrief.entityCreationRules.map((r: any) => `| ${r.entity} | ✅ \`${r.mustUse || 'Check codebase for helper'}\` | ❌ \`${r.mustNotUse}\` |`).join('\n')}

**🔴 FAILURE TO FOLLOW THESE RULES = AUTOMATIC REJECTION**
If you use \`new Model()\` instead of \`createModel()\`, the Judge will REJECT your code.` : ''}

⚠️ **Code that doesn't follow these patterns will be REJECTED by the Judge.**
`;
      }

      // Add Judge feedback if this is a retry
      if (judgeFeedback) {
        prompt += `\n\n## 🔄 JUDGE REJECTED YOUR PREVIOUS CODE - RETRY REQUIRED

### Judge Feedback (WHY IT WAS REJECTED):
${judgeFeedback}

### What You MUST Do:
1. Read the files you modified to see your previous code
2. Understand what the Judge said was wrong
3. Fix ONLY the issues mentioned
4. Write corrected code using Edit() or Write()
5. Commit your changes to the CURRENT branch
6. Push to the CURRENT branch
7. NO documentation, NO explanations - JUST FIX THE CODE

### ⚠️ CRITICAL - BRANCH RULES FOR RETRY:
- You are ALREADY on the correct branch: ${story.branchName || 'your story branch'}
- **DO NOT create a new branch** - work on the existing branch
- **DO NOT run git checkout -b** - the branch already exists
- Simply make your changes, commit, and push to the current branch
- The branch was already pushed in your previous attempt

**This is a RETRY attempt. Focus on fixing what was rejected. DO NOT create new branches.**
`;
      }

      // 🔐 Add devAuth section - either configured or not
      if (devAuth && devAuth.method !== 'none') {
        // ✅ DevAuth IS configured - developer can test authenticated endpoints
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔐 [Developer ${member.instanceId}] DevAuth configured: method=${devAuth.method} - Can test authenticated endpoints`
        );

        prompt += `\n\n## 🔐 API AUTHENTICATION (for testing endpoints)

**Method**: ${devAuth.method}
**Status**: ✅ CONFIGURED - You can test authenticated endpoints
`;
        if (devAuth.method === 'token') {
          prompt += `
**Token**: \`${devAuth.token}\`
**Type**: ${devAuth.tokenType || 'bearer'}
**Header**: ${devAuth.tokenHeader || 'Authorization'}
**Prefix**: "${devAuth.tokenPrefix || 'Bearer '}"

**Usage in curl**:
\`\`\`bash
curl -H "${devAuth.tokenHeader || 'Authorization'}: ${devAuth.tokenPrefix || 'Bearer '}${devAuth.token}" http://localhost:PORT/api/endpoint
\`\`\`

**Usage in code**:
\`\`\`javascript
const headers = { "${devAuth.tokenHeader || 'Authorization'}": "${devAuth.tokenPrefix || 'Bearer '}${devAuth.token}" };
fetch('/api/endpoint', { headers });
\`\`\`
`;
        } else if (devAuth.method === 'credentials') {
          prompt += `
**Login Endpoint**: ${devAuth.loginEndpoint}
**Login Method**: ${devAuth.loginMethod || 'POST'}
**Username**: ${devAuth.credentials?.username || ''}
**Password**: ${devAuth.credentials?.password || ''}
**Token Response Path**: ${devAuth.tokenResponsePath || 'token'}

**Step 1 - Login to get token**:
\`\`\`bash
TOKEN=$(curl -s -X ${devAuth.loginMethod || 'POST'} ${devAuth.loginEndpoint} \\
  -H "Content-Type: ${devAuth.loginContentType || 'application/json'}" \\
  -d '{"username":"${devAuth.credentials?.username}","password":"${devAuth.credentials?.password}"}' \\
  | jq -r '.${devAuth.tokenResponsePath || 'token'}')
\`\`\`

**Step 2 - Use token**:
\`\`\`bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:PORT/api/endpoint
\`\`\`
`;
        }
        prompt += `
⚠️ **CRITICAL**: DELETE method is ALWAYS FORBIDDEN - only use GET, POST, PUT, PATCH!

🔍 **If authentication fails**: Log the error clearly so we can debug the devAuth configuration.
`;
      } else {
        // ❌ DevAuth NOT configured - developer should continue but expect 401 errors
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️ [Developer ${member.instanceId}] DevAuth NOT configured - Authenticated endpoints will return 401. Developer will continue without auth testing.`
        );

        prompt += `\n\n## ⚠️ NO API AUTHENTICATION CONFIGURED

**Status**: ❌ NOT CONFIGURED - No authentication credentials provided

**What this means**:
- If you try to access protected endpoints, you will get **401 Unauthorized** errors
- This is EXPECTED - the project owner has not provided authentication credentials
- **DO NOT** let 401 errors block your work

**How to proceed**:
1. Write the code as if auth works (implement the logic correctly)
2. If you get 401 when testing → Log it and continue
3. Focus on code correctness, not on passing authentication
4. The auth testing will be done later when credentials are provided

**Example handling**:
\`\`\`javascript
// When testing and you get 401, log and continue
try {
  const response = await fetch('/api/protected');
  if (response.status === 401) {
    console.log('⚠️ 401 Unauthorized - No devAuth configured, skipping auth test');
    // Continue with your work
  }
} catch (error) {
  console.log('⚠️ Auth test skipped - no credentials configured');
}
\`\`\`

⚠️ **IMPORTANT**: Don't waste time trying to fix auth errors - just log them and move on!
`;
      }

      // 🔧 DYNAMIC VERIFICATION: Add project-specific verification commands and markers
      // This OVERRIDES the generic markers in AgentDefinitions.ts with project-specific ones
      if (environmentCommands) {
        console.log(`🔧 [Developer ${member.instanceId}] Adding dynamic verification commands from environmentConfig`);

        // Build the list of required markers based on available commands
        const markers: string[] = ['✅ ENVIRONMENT_READY (after setup commands succeed)'];
        const verificationSteps: string[] = [];

        // Typecheck (only if command exists and is not empty)
        if (environmentCommands.typecheck && environmentCommands.typecheck !== 'N/A') {
          markers.push('✅ TYPECHECK_PASSED');
          verificationSteps.push(`1. **Typecheck**: \`${environmentCommands.typecheck}\` → Output: ✅ TYPECHECK_PASSED`);
        } else {
          verificationSteps.push(`1. **Typecheck**: ⚠️ NOT CONFIGURED for this project - skip this marker`);
        }

        // Tests (only if command exists and is not empty)
        if (environmentCommands.test && environmentCommands.test !== 'N/A' && environmentCommands.test !== 'npm run build') {
          markers.push('✅ TESTS_PASSED');
          verificationSteps.push(`2. **Tests**: \`${environmentCommands.test}\` → Output: ✅ TESTS_PASSED`);
        } else {
          verificationSteps.push(`2. **Tests**: ⚠️ NOT CONFIGURED for this project - skip this marker`);
        }

        // Lint (only if command exists and is not empty)
        if (environmentCommands.lint && environmentCommands.lint !== 'N/A') {
          markers.push('✅ LINT_PASSED');
          verificationSteps.push(`3. **Lint**: \`${environmentCommands.lint}\` → Output: ✅ LINT_PASSED`);
        } else {
          verificationSteps.push(`3. **Lint**: ⚠️ NOT CONFIGURED for this project - skip this marker`);
        }

        // Build (only if command exists)
        if (environmentCommands.build) {
          verificationSteps.push(`4. **Build**: \`${environmentCommands.build}\` (verify build passes)`);
        }

        // Always required markers
        markers.push('✅ EXHAUSTIVE_VERIFICATION_PASSED (all verification loops complete)');
        markers.push('📍 Commit SHA: [40-character SHA]');
        markers.push('✅ DEVELOPER_FINISHED_SUCCESSFULLY');

        prompt += `

## 🔧 PROJECT-SPECIFIC VERIFICATION (OVERRIDES DEFAULT MARKERS)

**⚠️ IMPORTANT: This project has CUSTOM verification commands from TechLead.**
**Only use the markers listed below - ignore generic markers from system prompt.**

### Verification Commands for this project:
${verificationSteps.join('\n')}

### Required Markers (output ONLY these):
${markers.map((m, i) => `${i}. ${m}`).join('\n')}

### Workflow:
1. Run available verification commands
2. Output the corresponding marker ONLY if the command exists
3. If a command is "NOT CONFIGURED", skip that marker entirely
4. Always end with ✅ DEVELOPER_FINISHED_SUCCESSFULLY

**Example for this project:**
\`\`\`
${environmentCommands.install ? `Bash("${environmentCommands.install}")` : '# No install command'}
✅ ENVIRONMENT_READY

${environmentCommands.typecheck && environmentCommands.typecheck !== 'N/A' ?
  `Bash("${environmentCommands.typecheck}")
✅ TYPECHECK_PASSED` :
  '# No typecheck for this project'}

${environmentCommands.test && environmentCommands.test !== 'N/A' && environmentCommands.test !== 'npm run build' ?
  `Bash("${environmentCommands.test}")
✅ TESTS_PASSED` :
  '# No tests for this project'}

${environmentCommands.lint && environmentCommands.lint !== 'N/A' ?
  `Bash("${environmentCommands.lint}")
✅ LINT_PASSED` :
  '# No lint for this project'}

✅ EXHAUSTIVE_VERIFICATION_PASSED
git commit and push...
📍 Commit SHA: abc123...
✅ DEVELOPER_FINISHED_SUCCESSFULLY
\`\`\`
`;
      }

      // Prefix all file paths with repository name
      const prefixPath = (f: string) => `${targetRepository}/${f}`;

      // 🔥🔥🔥 DEVELOPER CREATES STORY BRANCH (simplified - no fetch/pull needed)
      // Developer creates a new branch locally and will push it after working
      const repoPath = `${workspacePath}/${repoName}`;

      // Generate unique branch name if not already set
      let branchName = story.branchName;
      const isRetry = !!branchName; // If branchName exists, this is a retry

      if (!branchName) {
        // First attempt - create new branch
        const taskShortId = taskId.slice(-8);
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const storySlug = story.id.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        branchName = `story/${taskShortId}-${storySlug}-${timestamp}-${randomSuffix}`;
      }

      console.log(`\n🌿 [Developer ${member.instanceId}] ${isRetry ? 'Resuming' : 'Creating'} story branch: ${branchName}`);

      try {
        if (isRetry) {
          // RETRY: Branch already exists, just checkout
          console.log(`   (Retry - branch already exists)`);
          try {
            safeGitExecSync(`git fetch origin ${branchName}`, { cwd: repoPath, encoding: 'utf8', timeout: 90000 });
          } catch (fetchErr: any) {
            console.warn(`   ⚠️ Fetch failed (continuing): ${fetchErr.message}`);
          }
          try {
            safeGitExecSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          } catch {
            safeGitExecSync(`git checkout -b ${branchName} origin/${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          }
          console.log(`✅ [Developer ${member.instanceId}] Checked out existing branch: ${branchName}`);
        } else {
          // FIRST ATTEMPT: Create new branch (no fetch/pull needed - branch doesn't exist yet!)
          safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
          console.log(`✅ [Developer ${member.instanceId}] Created new branch: ${branchName}`);
        }

        // Save branchName to story for later phases
        story.branchName = branchName;

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🌿 Developer ${member.instanceId}: Working on branch ${branchName}`
        );
      } catch (gitError: any) {
        console.error(`❌ [Developer ${member.instanceId}] Git branch operation failed: ${gitError.message}`);
        throw new Error(`Git branch failed for ${branchName}: ${gitError.message}`);
      }

      prompt += `

## Files to work with:

**Read these files first** (understand existing code):
${story.filesToRead && story.filesToRead.length > 0 ? story.filesToRead.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (explore as needed)'}

**Modify these existing files**:
${story.filesToModify && story.filesToModify.length > 0 ? story.filesToModify.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (none specified)'}

**Create these new files**:
${story.filesToCreate && story.filesToCreate.length > 0 ? story.filesToCreate.map((f: string) => `- ${prefixPath(f)}`).join('\n') : '- (none specified)'}

## Working directory:
You are in: ${workspacePath}
Target repository: ${targetRepository}/

All file paths must be prefixed with: ${targetRepository}/

## 🔄 ITERATIVE DEVELOPMENT WORKFLOW (CLAUDE CODE STYLE)

**You MUST follow this exact pattern for EVERY file:**

\`\`\`
┌─────────────────────────────────────────┐
│  1. READ file completely                │
│  2. EDIT with your changes              │
│  3. VERIFY: npx tsc --noEmit            │
│  4. If ERROR → FIX NOW, then verify     │
│  5. If CLEAN → next file or commit      │
└─────────────────────────────────────────┘
\`\`\`

**🚨 CRITICAL: After EVERY Edit(), run verification:**
\`\`\`bash
cd ${targetRepository} && npx tsc --noEmit 2>&1 | head -20
\`\`\`

**If you see an error:**
1. READ the error message (file:line)
2. FIX the issue IMMEDIATELY (don't continue)
3. VERIFY again
4. Only proceed when clean

**Example flow:**
\`\`\`
Read("${targetRepository}/src/services/MyService.ts")
Edit("${targetRepository}/src/services/MyService.ts", old, new)
Bash("cd ${targetRepository} && npx tsc --noEmit 2>&1 | head -20")
# If error → fix it, verify again
# If clean → proceed
\`\`\`

**DO NOT:**
- Skip verification after edits
- Continue to next file with errors
- Use @ts-ignore or // @ts-expect-error
- Commit code that doesn't compile

## 🔧 INLINE ERROR RECOVERY

When you see a TypeScript error, fix it IMMEDIATELY:

| Error Pattern | Fix |
|--------------|-----|
| \`Cannot find module 'X'\` | Add import: \`import { X } from './path'\` |
| \`Property 'X' does not exist\` | Check interface or use \`obj?.X\` |
| \`Type 'X' not assignable to 'Y'\` | Cast: \`value as Type\` or fix source |
| \`'X' is declared but never used\` | Remove or prefix with \`_\` |
| \`Object is possibly undefined\` | Add null check: \`if (x) { }\` |

**Error workflow:**
1. READ error (file:line:column)
2. READ that section of the file
3. UNDERSTAND why (missing import? wrong type? typo?)
4. FIX the root cause (not a workaround)
5. VERIFY with tsc again

## 🔍 ADAPTIVE EXPLORATION

**When unsure, EXPLORE first - don't guess!**

| Need | Search |
|------|--------|
| Find a file | \`Glob("**/FileName.ts")\` |
| Find a function | \`Grep("function funcName", path="src")\` |
| Find a type | \`Grep("interface TypeName", path="src")\` |
| Find usage | \`Grep("funcName(", path="src")\` |
| Find tests | \`Glob("**/*.test.ts")\` |

**Before creating anything new:**
1. Search if it exists
2. Find similar code for patterns
3. Understand the structure
4. THEN implement

## 🧪 MANDATORY: WRITE TESTS

For every function/class you create, you MUST write tests:

1. **Create test file** alongside source: \`MyService.test.ts\`
2. **Test cases required:**
   - Basic functionality (happy path)
   - Edge cases (empty strings, zero, null)
   - Error handling (invalid inputs)
3. **Run tests after writing:**
   \`\`\`bash
   cd ${targetRepository} && npm test -- --passWithNoTests
   \`\`\`
4. **Fix failing tests before committing**

**Test Template:**
\`\`\`typescript
import { MyFunction } from './MyFile';

describe('MyFunction', () => {
  it('should work with valid input', () => {
    expect(MyFunction('valid')).toBeDefined();
  });

  it('should handle empty input', () => {
    expect(MyFunction('')).toThrow();
  });

  it('should handle errors', () => {
    expect(() => MyFunction(null)).toThrow();
  });
});
\`\`\`

## 📚 LEARN FROM PATTERNS

**Before coding:**
1. Find similar implementations in codebase
2. Use existing helper functions (DON'T create new ones if they exist)
3. Follow the same patterns you find

**Example - finding helpers:**
\`\`\`
Grep("export function", path="src/utils")
Grep("export const", path="src/helpers")
\`\`\`

## 🚦 QUALITY CHECKLIST (Before Commit)

- [ ] Code compiles: \`npx tsc --noEmit\`
- [ ] Tests pass: \`npm test\`
- [ ] No console.log/debugger left in code
- [ ] No empty catch blocks
- [ ] Used existing helpers instead of creating new ones
- [ ] All imports resolve correctly

## Your task:
${judgeFeedback ? 'Fix the code based on Judge feedback above.' : 'Implement this story completely with production-ready code. Work iteratively - read, edit, verify, repeat.'}

## 🚨 MANDATORY: Git workflow (MUST DO):
⚠️ **You are already on branch: ${branchName}** (branch was created for you)

After writing code, you MUST follow this EXACT sequence:
1. cd ${targetRepository}
2. git add .
3. git commit -m "Implement: ${story.title}"
4. git push origin ${branchName}
5. **MANDATORY: Print commit SHA**:
   \`\`\`bash
   git rev-parse HEAD
   \`\`\`
   Then output: 📍 Commit SHA: <the-40-character-sha>

6. **MANDATORY: Verify push succeeded**:
   \`\`\`bash
   git ls-remote origin ${branchName}
   \`\`\`
   Check that output shows your commit SHA

7. **MANDATORY: Print SUCCESS marker**:
   Output exactly this line:
   ✅ DEVELOPER_FINISHED_SUCCESSFULLY

**CRITICAL RULES:**
- You MUST see "✅ DEVELOPER_FINISHED_SUCCESSFULLY" in your output
- Judge will ONLY review if you print this success marker
- If git push fails, retry it until it succeeds
- If you cannot push, print "❌ DEVELOPER_FAILED" and explain why`;

      // 🔥 DEBUG: Log if attachments are being passed
      if (attachments && attachments.length > 0) {
        console.log(`📎 [Developer ${member.instanceId}] Passing ${attachments.length} attachment(s) to agent SDK`);
      } else {
        console.log(`⚠️  [Developer ${member.instanceId}] NO attachments to pass (attachments: ${JSON.stringify(attachments)})`);
      }

      try {
        // Execute developer agent - SDK uses workspace root
        // 🔥 When forceTopModel=true (retry after Judge rejection), skip optimization
        // to ensure developer uses topModel instead of being downgraded to Haiku
        const result = await this.executeAgent(
          'developer',
          prompt,
          workspacePath, // Let SDK access workspace root
          taskId,
          `Developer ${member.instanceId}`,
          undefined, // sessionId
          undefined, // fork
          attachments, // Pass images for visual context
          undefined, // options
          undefined, // contextOverride
          forceTopModel // skipOptimization - when true, keeps topModel for retry
        );

        console.log(`✅ [Developer ${member.instanceId}] Completed story: ${story.title}`);
        console.log(`📊 [Developer ${member.instanceId}] Cost: $${result.cost?.toFixed(4) || 0}`);

        // Store result for return (isolated pipeline uses single-story execution)
        lastResult = { output: result.output, cost: result.cost };

        // 2️⃣ 🔥 CRITICAL: Verify developer finished successfully and pushed to remote
        // If verification fails, this story will be marked as failed (Judge cannot review)
        console.log(`\n🔍 [Developer ${member.instanceId}] Verifying git push to branch ${branchName}...`);

        // Wait for git push to propagate
        await new Promise(resolve => setTimeout(resolve, 3000));

        const repoPath = `${workspacePath}/${repoName}`;

        // Check developer output for success marker
        const developerOutput = result.output || '';
        const developerFinishedSuccessfully = developerOutput.includes('✅ DEVELOPER_FINISHED_SUCCESSFULLY');
        const developerFailed = developerOutput.includes('❌ DEVELOPER_FAILED');

        if (developerFailed) {
          console.error(`❌ [Developer ${member.instanceId}] Developer explicitly reported FAILURE`);
          throw new Error(`Developer ${member.instanceId} reported failure for story ${story.title}`);
        }

        if (!developerFinishedSuccessfully) {
          console.error(`❌ [Developer ${member.instanceId}] Developer did NOT report success marker`);
          console.error(`   Expected: "✅ DEVELOPER_FINISHED_SUCCESSFULLY"`);
          throw new Error(`Developer ${member.instanceId} did not report success for story ${story.title}`);
        }

        // Extract commit SHA
        const commitMatch = developerOutput.match(/📍\s*Commit SHA:\s*([a-f0-9]{40})/i);
        const commitSHA = commitMatch?.[1];

        if (!commitSHA) {
          console.error(`❌ [Developer ${member.instanceId}] Developer did NOT report commit SHA`);
          throw new Error(`Developer ${member.instanceId} did not report commit SHA for story ${story.title}`);
        }

        console.log(`✅ [Developer ${member.instanceId}] Commit SHA: ${commitSHA}`);

        // 🔥 CRITICAL: Verify branch EXISTS on remote (Judge cannot review non-existent branch)
        let branchExistsOnRemote = false;
        try {
          const lsRemoteOutput = safeGitExecSync(
            `git ls-remote --heads origin ${branchName}`,
            { cwd: repoPath, encoding: 'utf8', timeout: 15000 }
          );
          branchExistsOnRemote = lsRemoteOutput.trim().length > 0 && lsRemoteOutput.includes(branchName);
        } catch (lsError: any) {
          console.error(`❌ [Developer ${member.instanceId}] git ls-remote failed: ${lsError.message}`);
        }

        if (!branchExistsOnRemote) {
          console.error(`❌ [Developer ${member.instanceId}] Branch ${branchName} NOT found on remote!`);
          console.error(`   Developer reported success but branch is NOT on GitHub`);
          console.error(`   Judge CANNOT review non-existent branch`);

          NotificationService.emitConsoleLog(
            taskId,
            'error',
            `❌ Developer ${member.instanceId}: Branch ${branchName} NOT pushed to remote - story FAILED`
          );

          throw new Error(`Branch ${branchName} not found on remote - developer push failed`);
        }

        console.log(`✅ [Developer ${member.instanceId}] Branch ${branchName} verified on remote`);

        // 🔥 ADDITIONAL: Verify commit exists on remote
        let commitExistsOnRemote = false;
        try {
          safeGitExecSync(`git fetch origin`, { cwd: repoPath, encoding: 'utf8', timeout: 90000 });
          const containsOutput = safeGitExecSync(
            `git branch -r --contains ${commitSHA}`,
            { cwd: repoPath, encoding: 'utf8', timeout: 15000 }
          );
          commitExistsOnRemote = containsOutput.includes(`origin/${branchName}`);
        } catch (commitCheckError: any) {
          console.warn(`⚠️  [Developer ${member.instanceId}] Could not verify commit on remote: ${commitCheckError.message}`);
          // Don't fail if this check fails - branch existing is the critical check
          commitExistsOnRemote = true; // Assume OK if we can't check
        }

        if (!commitExistsOnRemote) {
          console.error(`❌ [Developer ${member.instanceId}] Commit ${commitSHA} NOT found on remote branch!`);
          throw new Error(`Commit ${commitSHA} not found on remote - developer push incomplete`);
        }

        console.log(`✅ [Developer ${member.instanceId}] Commit ${commitSHA.substring(0, 8)} verified on remote`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Developer ${member.instanceId}: Code pushed and verified on remote (${branchName})`
        );

        // 🔥 CRITICAL DEBUG: Show EXACTLY what code Developer wrote
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📝 DEVELOPER ${member.instanceId} - CODE CHANGES VERIFICATION`);
        console.log(`${'='.repeat(80)}`);

        try {
          const repoPath = `${workspacePath}/${repoName}`;

          // 🔥 IMPORTANT: Developer already committed, so we need to see the LAST commit
          // git diff would be empty because changes are already committed
          // Use git show HEAD to see what was in the last commit

          // Show files that were modified in last commit
          const modifiedFiles = safeGitExecSync(`cd "${repoPath}" && git show --name-only --pretty=format: HEAD`, { encoding: 'utf8' });
          console.log(`\n📂 Modified files in last commit:\n${modifiedFiles || '(no files modified)'}`);

          // Show actual code changes in last commit (full diff)
          const diffOutput = safeGitExecSync(`cd "${repoPath}" && git show HEAD`, { encoding: 'utf8' });
          console.log(`\n📝 LAST COMMIT DIFF:\n${diffOutput.substring(0, 2000)}...\n(truncated, full diff has ${diffOutput.length} chars)`);

          // Emit to frontend (full diff, no truncation)
          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `\n${'='.repeat(80)}\n📝 CODE CHANGES BY ${member.instanceId}\n${'='.repeat(80)}\n\nModified files:\n${modifiedFiles}\n\nFull diff:\n${diffOutput}\n${'='.repeat(80)}`
          );
        } catch (diffError: any) {
          console.error(`⚠️  Could not get git diff: ${diffError.message}`);
        }

        console.log(`${'='.repeat(80)}\n`);

        // 🔥 NEW: Run DeveloperSelfCheck for quality verification before Judge
        try {
          const { DeveloperSelfCheckService } = await import('../DeveloperSelfCheckService');
          const modifiedFilesList = safeGitExecSync(`cd "${repoPath}" && git show --name-only --pretty=format: HEAD`, { encoding: 'utf8' })
            .trim().split('\n').filter((f: string) => f);

          console.log(`\n🔍 [Developer ${member.instanceId}] Running pre-Judge quality verification...`);

          const selfCheckResult = await DeveloperSelfCheckService.runAllChecks({
            workspacePath: repoPath,
            modifiedFiles: modifiedFilesList,
            skipTests: true, // Tests will run in Judge phase
            timeout: 30000,
          });

          if (!selfCheckResult.passed) {
            console.log(`⚠️  [Developer ${member.instanceId}] Quality check found issues:`);
            selfCheckResult.blockingErrors.slice(0, 5).forEach(e => console.log(`   - ${e}`));

            // Store for Judge context
            NotificationService.emitConsoleLog(
              taskId,
              'warn',
              `⚠️  Developer ${member.instanceId} quality check:\n${DeveloperSelfCheckService.formatForDeveloper(selfCheckResult)}`
            );
          } else {
            console.log(`✅ [Developer ${member.instanceId}] Quality verification passed`);
            NotificationService.emitConsoleLog(
              taskId,
              'info',
              `✅ Developer ${member.instanceId}: Pre-Judge quality verification passed`
            );
          }
        } catch (selfCheckError: any) {
          console.warn(`⚠️  [Developer ${member.instanceId}] Self-check skipped: ${selfCheckError.message}`);
        }

        // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER (no truncation)
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `\n${'='.repeat(80)}\n👨‍💻 DEVELOPER ${member.instanceId} - FULL OUTPUT (Story: ${story.title})\n${'='.repeat(80)}\n\n${result.output || '(no output)'}\n\n${'='.repeat(80)}`
        );

        // Log developer output for debugging (truncated for console)
        if (result.output) {
          console.log(`\n📝 [Developer ${member.instanceId}] OUTPUT (truncated):\n${result.output.substring(0, 500)}...\n`);
        }

        // Update story status and branch name
        story.status = 'completed';
        story.completedBy = member.instanceId;
        story.completedAt = new Date();
        story.branchName = branchName; // Save branch name for QA

        console.log(`🌿 [Developer ${member.instanceId}] Story branch confirmed: ${branchName}`);

        // 🔥 EVENT SOURCING: Confirm story branch (TechLead created it, Developer confirms it was used)
        // This is idempotent - if TechLead already emitted this event, it just updates with same value
        const { eventStore } = await import('../EventStore');
        await eventStore.append({
          taskId: task._id as any,
          eventType: 'StoryBranchCreated',
          agentName: 'developer',
          payload: {
            storyId: story.id,
            branchName: branchName,
            developerId: member.instanceId,
            confirmedBy: 'developer', // Flag that this is confirmation, not creation
          },
        });

        console.log(`📝 [EventStore] Story branch confirmed in EventStore: ${branchName}`);

      } catch (error: any) {
        console.error(`❌ [Developer ${member.instanceId}] Failed on story ${story.title}:`, error.message);

        // 🔍 DEBUG: Log what developer was doing before failure
        console.log(`\n🔍 [Developer ${member.instanceId}] DEBUGGING - Check executeAgent output above for what developer said\n`);

        story.status = 'failed';
        story.error = error.message;
        throw error;
      }
    }

    // Mark developer as completed
    member.status = 'completed';
    await task.save();

    console.log(`✅ [Developer ${member.instanceId}] All stories completed`);

    // Return last result (for isolated story pipeline - contains commit SHA in output)
    return lastResult;
  }

  /**
   * Handle phase failure
   */
  private async handlePhaseFailed(task: ITask, phaseName: string, result: PhaseResult): Promise<void> {
    task.status = 'failed';
    // Map phase names to enum values
    task.orchestration.currentPhase = this.mapPhaseToEnum(phaseName);
    await task.save();

    NotificationService.emitTaskFailed((task._id as any).toString(), {
      phase: phaseName,
      error: result.error || 'Phase failed',
    });

    console.error(`❌ Orchestration failed at phase: ${phaseName}`);
  }

  /**
   * Handle orchestration completion
   */
  private async handleOrchestrationComplete(task: ITask, _context: OrchestrationContext): Promise<void> {
    task.status = 'completed';
    task.orchestration.currentPhase = 'completed';
    await task.save();

    // Calculate detailed cost breakdown by phase
    const breakdown: { phase: string; cost: number; inputTokens: number; outputTokens: number }[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Product Manager
    if (task.orchestration.productManager?.usage) {
      const pm = task.orchestration.productManager;
      breakdown.push({
        phase: 'Product Manager',
        cost: pm.cost_usd || 0,
        inputTokens: pm.usage?.input_tokens || 0,
        outputTokens: pm.usage?.output_tokens || 0,
      });
      totalInputTokens += pm.usage?.input_tokens || 0;
      totalOutputTokens += pm.usage?.output_tokens || 0;
      cacheCreationTokens += pm.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += pm.usage?.cache_read_input_tokens || 0;
    }

    // Project Manager
    if (task.orchestration.projectManager?.usage) {
      const pjm = task.orchestration.projectManager;
      breakdown.push({
        phase: 'Project Manager',
        cost: pjm.cost_usd || 0,
        inputTokens: pjm.usage?.input_tokens || 0,
        outputTokens: pjm.usage?.output_tokens || 0,
      });
      totalInputTokens += pjm.usage?.input_tokens || 0;
      totalOutputTokens += pjm.usage?.output_tokens || 0;
      cacheCreationTokens += pjm.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += pjm.usage?.cache_read_input_tokens || 0;
    }

    // Tech Lead
    if (task.orchestration.techLead?.usage) {
      const tl = task.orchestration.techLead;
      breakdown.push({
        phase: 'Tech Lead',
        cost: tl.cost_usd || 0,
        inputTokens: tl.usage?.input_tokens || 0,
        outputTokens: tl.usage?.output_tokens || 0,
      });
      totalInputTokens += tl.usage?.input_tokens || 0;
      totalOutputTokens += tl.usage?.output_tokens || 0;
      cacheCreationTokens += tl.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += tl.usage?.cache_read_input_tokens || 0;
    }

    // Developers (team)
    if (task.orchestration.team) {
      task.orchestration.team.forEach((dev, idx) => {
        if (dev.usage) {
          breakdown.push({
            phase: `Developer ${idx + 1}`,
            cost: dev.cost_usd || 0,
            inputTokens: dev.usage.input_tokens || 0,
            outputTokens: dev.usage.output_tokens || 0,
          });
          totalInputTokens += dev.usage.input_tokens || 0;
          totalOutputTokens += dev.usage.output_tokens || 0;
          cacheCreationTokens += dev.usage.cache_creation_input_tokens || 0;
          cacheReadTokens += dev.usage.cache_read_input_tokens || 0;
        }
      });
    }

    // Judge
    if (task.orchestration.judge?.usage) {
      const judge = task.orchestration.judge;
      breakdown.push({
        phase: 'Judge',
        cost: judge.cost_usd || 0,
        inputTokens: judge.usage?.input_tokens || 0,
        outputTokens: judge.usage?.output_tokens || 0,
      });
      totalInputTokens += judge.usage?.input_tokens || 0;
      totalOutputTokens += judge.usage?.output_tokens || 0;
      cacheCreationTokens += judge.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += judge.usage?.cache_read_input_tokens || 0;
    }

    // Fixer
    if (task.orchestration.fixer?.usage) {
      const fixer = task.orchestration.fixer;
      breakdown.push({
        phase: 'Fixer',
        cost: fixer.cost_usd || 0,
        inputTokens: fixer.usage?.input_tokens || 0,
        outputTokens: fixer.usage?.output_tokens || 0,
      });
      totalInputTokens += fixer.usage?.input_tokens || 0;
      totalOutputTokens += fixer.usage?.output_tokens || 0;
      cacheCreationTokens += fixer.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += fixer.usage?.cache_read_input_tokens || 0;
    }

    // QA Engineer
    if (task.orchestration.qaEngineer?.usage) {
      const qa = task.orchestration.qaEngineer;
      breakdown.push({
        phase: 'QA Engineer',
        cost: qa.cost_usd || 0,
        inputTokens: qa.usage?.input_tokens || 0,
        outputTokens: qa.usage?.output_tokens || 0,
      });
      totalInputTokens += qa.usage?.input_tokens || 0;
      totalOutputTokens += qa.usage?.output_tokens || 0;
      cacheCreationTokens += qa.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += qa.usage?.cache_read_input_tokens || 0;
    }

    // Calculate breakdown total cost
    const breakdownTotalCost = breakdown.reduce((sum, item) => sum + item.cost, 0);
    const breakdownTotalTokens = totalInputTokens + totalOutputTokens;

    // 🔥 COST TRACKING FIX: Use MAX of accumulated vs breakdown
    // The accumulated totalCost is more accurate because it's tracked during execution
    // The breakdown may be incomplete if some phases didn't save cost_usd
    const accumulatedCost = task.orchestration.totalCost || 0;
    const realTotalCost = Math.max(accumulatedCost, breakdownTotalCost);
    const realTotalTokens = breakdownTotalTokens; // Use breakdown for tokens (has all the details)

    // Log if there's a discrepancy
    if (accumulatedCost > 0 && Math.abs(accumulatedCost - breakdownTotalCost) > 0.001) {
      console.log(`\n⚠️  [CostTracking] Cost discrepancy detected:`);
      console.log(`   Accumulated during execution: $${accumulatedCost.toFixed(4)}`);
      console.log(`   Breakdown reconstruction:     $${breakdownTotalCost.toFixed(4)}`);
      console.log(`   Using higher value:           $${realTotalCost.toFixed(4)}`);
    }

    // Update task with final totals
    task.orchestration.totalCost = realTotalCost;
    task.orchestration.totalTokens = realTotalTokens;
    await task.save();

    // Collect PRs from epics
    const pullRequests: { epicName: string; prNumber: number; prUrl: string; repository: string }[] = [];
    const { eventStore } = await import('../EventStore');
    const currentState = await eventStore.getCurrentState(task._id as any);

    if (currentState.epics && Array.isArray(currentState.epics)) {
      for (const epic of currentState.epics) {
        if (epic.pullRequestNumber && epic.pullRequestUrl) {
          pullRequests.push({
            epicName: epic.name || `Epic ${epic.id}`,
            prNumber: epic.pullRequestNumber,
            prUrl: epic.pullRequestUrl,
            repository: epic.targetRepository || 'unknown',
          });
        }
      }
    }

    // Emit orchestration completed with detailed cost summary and PRs
    NotificationService.emitOrchestrationCompleted((task._id as any).toString(), {
      totalCost: realTotalCost,
      totalTokens: realTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
      cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
      breakdown,
      pullRequests: pullRequests.length > 0 ? pullRequests : undefined,
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ Orchestration completed successfully!`);
    console.log(`💰 Total Cost: $${realTotalCost.toFixed(4)}`);
    console.log(`🎯 Total Tokens: ${realTotalTokens.toLocaleString()}`);
    console.log(`📊 Cost Breakdown:`);
    breakdown.forEach(item => {
      console.log(`   - ${item.phase}: $${item.cost.toFixed(4)}`);
    });
    if (pullRequests.length > 0) {
      console.log(`\n📬 Pull Requests Created (click to review and merge):`);
      pullRequests.forEach(pr => {
        console.log(`   🔗 ${pr.epicName}: ${pr.prUrl}`);
      });
    }
    console.log(`${'='.repeat(80)}\n`);

    // 🔥 IMPORTANT: Clean up task-specific resources to prevent memory leaks
    const taskId = (task._id as any).toString();

    // Clean up cost budget config
    CostBudgetService.cleanupTaskConfig(taskId);
    console.log(`🧹 Cleaned up task-specific cost budget config for task ${taskId}`);

    // Clean up approval event listeners
    const { approvalEvents } = await import('../ApprovalEvents');
    approvalEvents.cleanupTask(taskId);
    console.log(`🧹 Cleaned up approval event listeners for task ${taskId}`);
  }

  /**
   * Handle orchestration error
   */
  private async handleOrchestrationError(taskId: string, error: Error): Promise<void> {
    const task = await Task.findById(taskId);
    if (task) {
      task.status = 'failed';
      await task.save();
    }

    NotificationService.emitTaskFailed(taskId, {
      error: error.message,
    });

    // 🔥 IMPORTANT: Clean up task-specific resources even on failure
    CostBudgetService.cleanupTaskConfig(taskId);
    console.log(`🧹 Cleaned up task-specific cost budget config for failed task ${taskId}`);

    // Clean up approval event listeners
    import('../ApprovalEvents').then(({ approvalEvents }) => {
      approvalEvents.cleanupTask(taskId);
      console.log(`🧹 Cleaned up approval event listeners for failed task ${taskId}`);
    });
  }
}
