import { TaskRepository, ITask, IOrchestration } from '../../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../../database/repositories/RepositoryRepository.js';
import { GitHubService } from '../GitHubService';
import { NotificationService } from '../NotificationService';
import { AgentActivityService } from '../AgentActivityService';
import { AgentArtifactService } from '../AgentArtifactService';
import { OrchestrationContext, IPhase, PhaseResult, saveTaskFireAndForget, updateTaskFireAndForget, saveTaskCritical } from './Phase';
import { createTaskLogger } from '../../utils/structuredLogger';
import { PlanningPhase } from './PlanningPhase';
import { SandboxPhase } from './SandboxPhase';
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
import { RecoveryPhase } from './RecoveryPhase';
import { IntegrationPhase } from './IntegrationPhase';
import { AgentModelConfig } from '../../config/ModelConfigurations';
import { safeGitExecSync } from '../../utils/safeGitExecution';

// 🔥 Best practice services
import { RetryService } from './RetryService';
import { CostBudgetService } from './CostBudgetService';
import { eventStore } from '../EventStore';
import { contextCheckpointService } from './ContextCheckpointService';

import path from 'path';
import os from 'os';
import fs from 'fs';

// 🔒 ROBUSTNESS: Fault-tolerant utilities available at '../../utils/robustness'
// Import when needed: withCircuitBreaker, withRetry, validateWorkspacePath, validateTaskId, isOk, Result

// 🚀 Autonomous Services (only BackgroundTaskService and SlashCommandService used)
import { BackgroundTaskService } from '../BackgroundTaskService';
import { SlashCommandService } from '../SlashCommandService';

// 🎯 SQLITE IS THE SINGLE SOURCE OF TRUTH
// UnifiedMemoryService REMOVED - was causing bugs on server restart (memory lost)
// All phase/epic/story status is now tracked ONLY in task.orchestration (SQLite)

// 🔥 REFACTORED: Agent execution extracted to separate service
import { agentExecutorService, AgentExecutionResult, ResumeOptions } from './AgentExecutorService';

// 🔥 REFACTORED: Developer prompt building extracted to separate builder
import { DeveloperPromptBuilder } from './DeveloperPromptBuilder';

// 🏊 SANDBOX POOL: For task completion tracking
import { sandboxPoolService } from '../SandboxPoolService';

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
 * ✅ Context compaction (SDK native /compact command)
 * ✅ Verification (JudgePhase evaluates developer work)
 * ✅ Human feedback loop (ApprovalPhase at each step)
 * ✅ Parallel execution (multi-repo support)
 * ✅ Cost tracking (totalCost, totalTokens in Task model)
 * ✅ State management (OrchestrationContext shared between phases)
 */
export class OrchestrationCoordinator {
  private readonly workspaceDir: string;
  private readonly githubService: GitHubService;

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
    'Sandbox',             // 0. Create isolated Docker sandbox BEFORE anything else
    'Planning',            // 1. Unified planning (Problem + Product + Project in one pass)
    'Approval',            // 2. Human approval gate (epics + stories)
    'TeamOrchestration',   // 3. Multi-team parallel execution (TechLead → Developers+Judge per epic)
    'Recovery',            // 4. Verify all work is done, complete any pending work
    'Integration',         // 5. Merge all epic branches, resolve conflicts, fix build
    'AutoMerge',           // 6. Merge integration branch to main
  ];

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(this.workspaceDir);
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
      const task = TaskRepository.findById(taskId);

      if (!task) {
        throw new Error(`Task ${taskId} not found`);
      }

      // 🔍 Log task state from SQLite (THE SINGLE SOURCE OF TRUTH)
      const planningStatus = (task.orchestration as any)?.planning?.status;
      const techLeadStatus = (task.orchestration as any)?.techLead?.status;
      const teamStatus = (task.orchestration as any)?.teamOrchestration?.status;

      console.log(`\n📊 [SQLite] Task state loaded:`);
      console.log(`   Task ID: ${task.id}`);
      console.log(`   Status: ${task.status}`);
      console.log(`   currentPhase: ${task.orchestration?.currentPhase}`);
      console.log(`   planning.status: ${planningStatus || 'UNDEFINED'}`);
      console.log(`   techLead.status: ${techLeadStatus || 'UNDEFINED'}`);
      console.log(`   teamOrchestration.status: ${teamStatus || 'UNDEFINED'}`);

      // 🛑 CANCELLED CHECK: Do not orchestrate cancelled tasks
      if (task.status === 'cancelled') {
        console.log(`🛑 [Orchestration] Task ${taskId} is CANCELLED - skipping orchestration`);
        NotificationService.emitConsoleLog(taskId, 'warn', `🛑 Task was cancelled - orchestration skipped`);
        return;
      }

      // 🔄 RECOVERY DETECTION: Use SQLite data (not memory!)
      // A task is resuming if any phase has status 'completed'
      const completedPhases = this.getCompletedPhasesFromTask(task);
      const isRecovery = completedPhases.length > 0;

      if (isRecovery) {
        console.log(`\n${'🔄'.repeat(30)}`);
        console.log(`🔄 [RECOVERY MODE] Resuming task from SQLite state`);
        console.log(`🔄   Completed phases: ${completedPhases.join(', ')}`);
        console.log(`🔄   Current phase: ${task.orchestration?.currentPhase || 'unknown'}`);
        console.log(`${'🔄'.repeat(30)}\n`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 RECOVERY MODE: ${completedPhases.length} phases already completed. Will skip them.`
        );

        // Check for pending approval to re-emit
        if (task.orchestration?.pendingApproval?.phase) {
          console.log(`🔄   Found pending approval: ${task.orchestration.pendingApproval.phase}`);
          console.log(`🔄   Will re-emit approval_required when ApprovalPhase executes`);
        }
      } else {
        console.log(`✨ [NEW TASK] Starting fresh - no completed phases in SQLite`);
      }

      // 📋 EMIT TASK REQUEST TO ACTIVITY - First thing user sees
      const taskDescription = task.description || task.title || 'No description provided';
      AgentActivityService.emitMessage(
        taskId,
        'System',
        `📋 TASK: ${taskDescription}`
      );
      NotificationService.emitConsoleLog(taskId, 'info', `📋 Task request: ${taskDescription.substring(0, 200)}${taskDescription.length > 200 ? '...' : ''}`);

      // ⚡ OPTIMIZATION: Fetch Repositories + User (both depend only on task)
      const { UserRepository } = await import('../../database/repositories/UserRepository.js');
      const repositories = RepositoryRepository.findByIds(task.repositoryIds || []);
      const user = UserRepository.findById(task.userId, true); // includeSecrets=true for accessToken

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

      if (!user || !user.accessToken) {
        throw new Error(
          `User GitHub token not found. User must connect their GitHub account before starting orchestration.`
        );
      }

      // Verify repositories belong to user's projects (security check)
      const { ProjectRepository } = await import('../../database/repositories/ProjectRepository.js');
      const projectIds = [...new Set(repositories.map(r => r.projectId))];
      const userProjects = ProjectRepository.findByIdsAndUser(projectIds, task.userId, true);

      if (userProjects.length !== projectIds.length) {
        throw new Error(
          `Security error: Some repositories belong to projects not owned by this user. ` +
          `User projects found: ${userProjects.length}, expected: ${projectIds.length}`
        );
      }

      log.success(`Found ${repositories.length} repositories for task`, {
        repositories: repositories.map(r => r.name),
      });

      // 📦 EMIT REPOSITORIES TO ACTIVITY
      const repoNames = repositories.map((r: any) => r.name).join(', ');
      AgentActivityService.emitMessage(
        taskId,
        'System',
        `📦 Repositories: ${repoNames}`
      );
      NotificationService.emitConsoleLog(taskId, 'info', `✅ Found ${repositories.length} repositories: ${repoNames}`);

      // Setup workspace (pass user token for cloning - NOT encrypted)
      // 🏊 Use project-based workspace for sandbox reuse across tasks
      const projectId = task.projectId?.toString() || taskId;
      const workspacePath = await this.setupWorkspace(taskId, projectId, repositories, user.accessToken);
      const workspaceStructure = await this.getWorkspaceStructure(workspacePath);

      // 🔥🔥🔥 CRITICAL VALIDATION: workspacePath MUST be valid after setup 🔥🔥🔥
      // This validation ensures ALL downstream phases have correct workspace
      console.log(`\n🔍 [OrchestrationCoordinator] Workspace validation after setup:`);
      console.log(`   workspacePath: ${workspacePath || 'NULL/EMPTY ⚠️'}`);
      console.log(`   workspaceDir config: ${this.workspaceDir}`);

      if (!workspacePath || typeof workspacePath !== 'string' || workspacePath.length === 0) {
        console.error(`\n❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌`);
        console.error(`❌ [OrchestrationCoordinator] CRITICAL: workspacePath is invalid after setupWorkspace!`);
        console.error(`   Expected format: ${this.workspaceDir}/task-${taskId}`);
        console.error(`   Received: ${workspacePath} (${typeof workspacePath})`);
        console.error(`\n   🚨 ALL PHASES WILL FAIL without valid workspace:`);
        console.error(`   - Planning, TechLead will search in wrong directory`);
        console.error(`   - Developers will write code to wrong location`);
        console.error(`   - Judge will review wrong files`);
        console.error(`   - Git operations will fail completely`);
        console.error(`❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌❌\n`);

        throw new Error(
          `CRITICAL: Workspace setup failed - workspacePath is invalid. ` +
          `Task ${taskId} cannot proceed. ` +
          `Check AGENT_WORKSPACE_DIR environment variable (current: ${this.workspaceDir}) ` +
          `and ensure the directory is writable.`
        );
      }

      // Verify the path exists on disk
      if (!fs.existsSync(workspacePath)) {
        console.error(`❌ [OrchestrationCoordinator] Workspace path does not exist: ${workspacePath}`);
        throw new Error(`Workspace directory does not exist: ${workspacePath}`);
      }

      console.log(`   ✅ Workspace path valid and exists: ${workspacePath}`);

      // 🐳 SANDBOX CREATION MOVED TO PlanningPhase
      // PlanningPhase is the SINGLE source of truth for sandbox creation because:
      // 1. It creates sandboxes PER REPOSITORY (not just primary)
      // 2. It has correct language detection per repo
      // 3. It handles preview server setup
      // 4. No duplication - 100% control over where sandboxes are created
      console.log(`   ℹ️ Docker sandboxes will be created by PlanningPhase (per-repository)`);

      // 🔥 FIX: Enrich repositories with localPath after cloning
      repositories.forEach((repo: any) => {
        repo.localPath = path.join(workspacePath, repo.name);
      });

      // Create orchestration context (shared state for all phases)
      const context = new OrchestrationContext(task, repositories, workspacePath);
      console.log(`   ✅ OrchestrationContext created with workspacePath: ${context.workspacePath}`);

      // 🐳 Sandbox info will be set by PlanningPhase when it creates sandboxes
      // Initially set to false - PlanningPhase will update to true
      context.setData('useSandbox', false);

      // 🎯 Store completed phases for recovery context
      context.setData('completedPhases', completedPhases);
      context.setData('isRecovery', isRecovery);

      // 🔄 CHECKPOINT RESTORATION: Restore context from EventStore/checkpoint for crash recovery
      // Priority: 1. EventStore (most reliable), 2. Checkpoint snapshot, 3. Legacy branchRegistry
      const restoreResult = await contextCheckpointService.restoreContext(taskId, context);
      if (restoreResult.restored) {
        console.log(`🔄 [Checkpoint] Context restored from ${restoreResult.source}: ${restoreResult.details}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Context restored: ${restoreResult.details} (source: ${restoreResult.source})`
        );
      }

      // 🔑 Get project-specific API key with fallback chain:
      // 1. Project API key (if set)
      // 2. User's default API key (if set)
      // 3. Environment variable (fallback)
      let anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      let apiKeySource = 'environment';

      // Get project to check for project-specific API key and dev auth config
      // Note: Sensitive fields are encrypted - decryption is handled by the repository
      const project = userProjects.length > 0
        ? ProjectRepository.findById(userProjects[0].id, true) // includeSecrets=true
        : null;

      if (project?.apiKey) {
        // API key is already decrypted by repository when includeSecrets=true
        anthropicApiKey = project.apiKey;
        apiKeySource = 'project';
        console.log(`🔑 Using project-specific API key (project: ${project.name})`);
      } else if (user?.defaultApiKey) {
        // User API key is already decrypted by repository when includeSecrets=true
        anthropicApiKey = user.defaultApiKey;
        apiKeySource = 'user_default';
        console.log(`🔑 Using user's default API key`);
      } else {
        console.log(`🔑 Using environment API key (no project or user default set)`);
      }

      // 🔐 Store developer authentication config (if configured)
      // IMPORTANT: DELETE method is ALWAYS BLOCKED - developers can only use GET, PUT, POST
      // DevAuth is already decrypted by repository when includeSecrets=true
      if (project?.devAuth && project.devAuth.method !== 'none') {
        const devAuth = project.devAuth;
        context.setData('devAuth', {
          method: devAuth.method,
          // For 'token' method
          token: devAuth.token,
          tokenType: devAuth.tokenType || 'bearer',
          tokenHeader: devAuth.tokenHeader || 'Authorization',
          tokenPrefix: devAuth.tokenPrefix || 'Bearer ',
          // For 'credentials' method
          loginEndpoint: devAuth.loginEndpoint,
          loginMethod: devAuth.loginMethod || 'POST',
          credentials: devAuth.credentials,
          loginContentType: devAuth.loginContentType || 'application/json',
          tokenResponsePath: devAuth.tokenResponsePath || 'token',
        });
        console.log(`🔐 Developer authentication configured (method: ${devAuth.method})`);
        if (devAuth.method === 'credentials') {
          console.log(`   📝 Login endpoint: ${devAuth.loginEndpoint}`);
        }
        console.log(`   ⚠️  DELETE method is BLOCKED for safety - only GET, PUT, POST allowed`);
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

      // Mark task as in progress
      TaskRepository.update(task.id, { status: 'in_progress' });
      TaskRepository.modifyOrchestration(task.id, (orch) => ({
        ...orch,
        currentPhase: 'planning',
        startedAt: new Date(),
        workspacePath, // 💾 Save workspace path for debug and recovery
      }));
      task.status = 'in_progress';
      task.orchestration.currentPhase = 'planning';
      task.orchestration.workspacePath = workspacePath;

      // 🔥 SQLite IS THE SOURCE OF TRUTH - no separate memory needed
      NotificationService.emitTaskStarted(taskId, {
        repositoriesCount: repositories.length,
        workspacePath,
      });

      // === EXECUTE PHASES SEQUENTIALLY WITH APPROVAL GATES ===
      // ⚡ OPTIMIZATION: Cache phase statuses from SQLite once at start
      const cachedPhaseStatuses = this.getPhaseStatusesFromTask(task);
      console.log(`⚡ [SQLite] Cached ${cachedPhaseStatuses.size} phase statuses: ${JSON.stringify([...cachedPhaseStatuses.entries()])}`);

      for (const phaseName of this.PHASE_ORDER) {
        // ⚡ SIMPLE SKIP: Check ONLY SQLite status (no memory!)
        const shouldSkip = cachedPhaseStatuses.get(phaseName) === 'completed';

        if (shouldSkip) {
          console.log(`⚡ [${phaseName}] SKIP - already completed in SQLite`);
          NotificationService.emitConsoleLog(taskId, 'info', `⚡ Skip: ${phaseName} (already completed)`);
          continue;
        }

        // === ONLY REACH HERE IF PHASE WILL EXECUTE ===
        // Check pause/cancel (only for phases we'll actually run)
        const freshTask = TaskRepository.findById(task.id);

        if (freshTask?.orchestration?.paused) {
          console.log(`⏸️  [Orchestration] Task paused by user`);
          NotificationService.emitConsoleLog(taskId, 'warn', `⏸️  Task paused - will resume later`);
          return;
        }

        if (freshTask?.orchestration?.cancelRequested) {
          console.log(`🛑 [Orchestration] Task cancelled`);
          TaskRepository.update(task.id, { status: 'cancelled' });
          TaskRepository.modifyOrchestration(task.id, (orch) => ({
            ...orch,
            currentPhase: 'completed',
          }));
          task.status = 'cancelled';
          NotificationService.emitTaskFailed(taskId, { error: 'Task cancelled by user' });
          CostBudgetService.cleanupTaskConfig(taskId);
          const { approvalEvents } = await import('../ApprovalEvents');
          approvalEvents.cleanupTask(taskId);
          return;
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

        // Check phase's own custom shouldSkip logic (if any)
        if (phase.shouldSkip && typeof phase.shouldSkip === 'function') {
          const shouldSkipPhase = await phase.shouldSkip(context);
          if (shouldSkipPhase) {
            console.log(`⏭️  [${phaseName}] Custom skip logic triggered`);
            NotificationService.emitConsoleLog(taskId, 'info', `⏭️  Skipping ${phaseName} (custom logic)`);
            await this.syncSkippedPhaseToDb(taskId, phaseName, cachedPhaseStatuses);
            continue;
          }
        }

        // 🔥 CRITICAL: Update currentPhase in SQLite BEFORE executing
        // This ensures recovery knows where to resume from if server crashes
        const phaseEnum = this.mapPhaseToEnum(phaseName);
        TaskRepository.modifyOrchestration(task.id, (orch) => ({
          ...orch,
          currentPhase: phaseEnum,
          lastPhaseUpdate: new Date(),
        }));
        task.orchestration.currentPhase = phaseEnum; // Keep local copy in sync
        console.log(`📍 [Orchestration] Phase tracking updated: ${phaseName} → ${phaseEnum}`);

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
            const retryTask = TaskRepository.findById(taskId);
            if (retryTask) {
              const configs = await import('../../config/ModelConfigurations');

              // Get current model config (default to RECOMMENDED for optimal quality/cost)
              let currentModelConfig: AgentModelConfig = configs.ALL_OPUS_CONFIG;
              if (task.orchestration?.modelConfig) {
                const { preset, customConfig } = task.orchestration.modelConfig;
                if (preset === 'custom' && customConfig) {
                  currentModelConfig = customConfig as AgentModelConfig;
                } else if (preset === 'max') {
                  currentModelConfig = configs.ALL_OPUS_CONFIG;
                } else if (preset === 'premium') {
                  currentModelConfig = configs.ALL_OPUS_CONFIG;
                } else if (preset === 'recommended') {
                  currentModelConfig = configs.ALL_OPUS_CONFIG;
                } else if (preset === 'standard') {
                  currentModelConfig = configs.ALL_OPUS_CONFIG;
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
              saveTaskFireAndForget(task, 'escalate model config');

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
                saveTaskFireAndForget(task, 'restore model config after retry fail');

                throw retryError; // Re-throw to fail the phase
              }

              // Restore previous model config for next phases
              task.orchestration.modelConfig = previousModelConfig;
              saveTaskFireAndForget(task, 'restore model config');
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

          // Phase failed - mark task as failed (SQLite updated in handlePhaseFailed)
          NotificationService.emitConsoleLog(taskId, 'error', `❌ Phase ${phaseName} failed: ${result.error}`);
          await this.handlePhaseFailed(task, phaseName, result);
          return; // 🔥 EXPLICIT STOP: No further phases will execute
        }

        // Check if phase needs approval (paused, not failed)
        if (result.needsApproval) {
          // SQLite already has pendingApproval set by the phase
          console.log(`⏸️  [${phaseName}] Paused - waiting for human approval`);
          NotificationService.emitConsoleLog(taskId, 'info', `⏸️  Phase ${phaseName} paused - waiting for human approval`);
          return; // Exit orchestration, will resume when approval granted
        }

        // Phase succeeded - continue to next phase
        const wasSkipped = result.warnings?.includes('Phase was skipped');

        // 🔥 FIX: ALWAYS set currentPhaseName (even for skipped phases)
        // ApprovalPhase needs this to know what phase to approve
        // Recovery scenario: Planning is skipped but Approval still needs to run
        if (phaseName !== 'Approval') {
          context.setData('currentPhaseName', phaseName);
          console.log(`📝 Stored currentPhaseName in context: ${phaseName}${wasSkipped ? ' (skipped)' : ''}`);
        }

        if (wasSkipped) {
          console.log(`⏭️  [${phaseName}] Skipped`);
          NotificationService.emitConsoleLog(taskId, 'info', `⏭️  Phase ${phaseName} skipped`);
        } else {
          // Phase completed - status already saved to SQLite by the phase itself
          console.log(`✅ [${phaseName}] Completed successfully`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Phase ${phaseName} completed successfully`);

          // 📦 TIMELINE BACKUP: Save orchestration timeline to Local + GitHub
          // This ensures we have a complete history even if server crashes
          await this.saveOrchestrationTimeline(task, phaseName, context, workspacePath);

          // 💾 CHECKPOINT SAVE: Persist context state after each successful phase
          // Enables crash recovery by restoring branchRegistry, sharedData, phaseResults
          contextCheckpointService.saveCheckpoint(taskId, context);

          // 🔥 RATE LIMIT PROTECTION: Wait 2 seconds between phases to avoid Anthropic rate limits
          // Each agent makes many API calls, waiting prevents hitting limits
          if (phaseName !== 'Approval') {
            console.log(`⏱️  [Orchestration] Waiting 2s before next phase (rate limit protection)...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

          // 🚀 AUTOMATIC QUALITY GATES - Run tests and reviews after key phases
          await this.runAutomaticQualityGates(taskId, phaseName, context, workspacePath);
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
      case 'Sandbox':
        // 🐳 SandboxPhase runs FIRST - creates environment, Judge validates
        return new SandboxPhase(executeAgentWithContext);

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

      case 'Recovery':
        return new RecoveryPhase();

      case 'Integration':
        return new IntegrationPhase();

      case 'AutoMerge':
        return new AutoMergePhase(this.githubService);

      default:
        return null;
    }
  }

  /**
   * Setup workspace for multi-repo development
   * Clones ONLY the repositories selected by the user for this specific task
   * ⚡ OPTIMIZATION: Project-based workspace for sandbox reuse
   *
   * Structure:
   * {workspaceDir}/
   * ├── project-{projectId}/      ← Shared by all tasks of same project
   * │   ├── backend/              ← Each repo cloned once
   * │   ├── frontend/
   * │   └── mobile/
   * └── task-{taskId}/            ← Legacy (for tasks without projectId)
   */
  private async setupWorkspace(taskId: string, _projectId: string, repositories: any[], githubToken: string): Promise<string> {
    // 🔥 FIX: Always use task-based workspace for consistency with cleanup
    // Each task gets its own workspace: task-{taskId}
    const workspaceKey = `task-${taskId}`;
    const projectWorkspace = path.join(this.workspaceDir, workspaceKey);

    // ⚡ FAST PATH: Check if workspace already exists with all required repos
    if (fs.existsSync(projectWorkspace)) {
      const existingDirs = fs.readdirSync(projectWorkspace).filter(
        name => !name.startsWith('.') && !name.startsWith('team-')
      );
      const requiredRepos = repositories.map(r => r.name);
      const allReposExist = requiredRepos.every(repoName =>
        existingDirs.includes(repoName) &&
        fs.existsSync(path.join(projectWorkspace, repoName, '.git'))
      );

      if (allReposExist) {
        console.log(`⚡ [Workspace] Fast path - already exists with all ${repositories.length} repos`);
        console.log(`   📁 Using existing: ${projectWorkspace}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `⚡ Workspace already ready (fast recovery): ${repositories.map(r => r.name).join(', ')}`
        );
        return projectWorkspace;
      }
    }

    // SLOW PATH: Full workspace setup
    console.log(`📦 Setting up workspace for task ${taskId}`);
    console.log(`   Selected repositories count: ${repositories.length}`);

    // Log which repositories will be cloned (for debugging)
    repositories.forEach((repo, index) => {
      console.log(`   ${index + 1}. ${repo.name} (${repo.githubRepoName})`);
    });

    // Create workspace directory
    if (!fs.existsSync(projectWorkspace)) {
      fs.mkdirSync(projectWorkspace, { recursive: true });
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
        projectWorkspace,
        envVariables  // Inject .env file during cloning
      );
    }

    // Verify workspace contains only selected repos
    const clonedRepos = fs.readdirSync(projectWorkspace).filter(name => !name.startsWith('.'));
    console.log(`   📁 Workspace contents: ${clonedRepos.join(', ')}`);

    if (clonedRepos.length !== repositories.length) {
      console.warn(`⚠️  Workspace repo count mismatch!`);
      console.warn(`   Expected: ${repositories.length} repos`);
      console.warn(`   Found: ${clonedRepos.length} directories`);
      console.warn(`   This might indicate an issue with repository cloning`);
    }

    console.log(`✅ Workspace setup complete: ${projectWorkspace}`);
    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `✅ Workspace ready with ${repositories.length} selected repositories: ${repositories.map(r => r.name).join(', ')}`
    );

    return projectWorkspace;
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
  private mapPhaseToEnum(phaseName: string): 'planning' | 'architecture' | 'development' | 'merge' | 'auto-merge' | 'completed' | 'multi-team' {
    const phaseMap: Record<string, 'planning' | 'architecture' | 'development' | 'merge' | 'auto-merge' | 'completed' | 'multi-team'> = {
      // Planning phases
      'Planning': 'planning',
      'Approval': 'planning',
      'TeamOrchestration': 'multi-team',
      'TechLead': 'architecture',

      // Development phases
      'Developers': 'development',
      'Judge': 'development',

      // Merge phases
      'Merge': 'merge',
      'AutoMerge': 'auto-merge',
      'Verification': 'merge',
    };
    return phaseMap[phaseName] || 'planning';
  }

  /**
   * 🔧 FIX: Sync skipped phase status to MongoDB (OPTIMIZED)
   *
   * When a phase is skipped (because Unified Memory says it's completed),
   * we must also update the task.orchestration.[phase] field in MongoDB.
   * This is necessary because downstream phases (like TeamOrchestration)
   * validate phase completion by checking MongoDB, not Unified Memory.
   *
   * ⚡ OPTIMIZATION: Skip the MongoDB write if the phase is already marked
   * as completed in the cached task status. This avoids redundant writes
   * during retry scenarios.
   */
  private async syncSkippedPhaseToDb(
    taskId: string,
    phaseName: string,
    cachedPhaseStatuses?: Map<string, string>
  ): Promise<void> {
    // Map phase names to their MongoDB field paths
    const phaseFieldMap: Record<string, string> = {
      'Planning': 'orchestration.planning',
      'Approval': 'orchestration.approval',
      'TechLead': 'orchestration.techLead',
      'TeamOrchestration': 'orchestration.teamOrchestration',
      'Development': 'orchestration.development',
      'Developers': 'orchestration.development',
      'Judge': 'orchestration.judge',
      'AutoMerge': 'orchestration.autoMerge',
      'Merge': 'orchestration.merge',
      'Verification': 'orchestration.verification',
    };

    const fieldPath = phaseFieldMap[phaseName];
    if (!fieldPath) {
      console.log(`   ℹ️ No MongoDB field mapping for phase: ${phaseName}`);
      return;
    }

    // ⚡ OPTIMIZATION: Check cache first - skip write if already completed
    if (cachedPhaseStatuses?.get(phaseName) === 'completed') {
      console.log(`   ⚡ [${phaseName}] Already completed in MongoDB - skipping redundant sync`);
      return;
    }

    try {
      // Update the phase status in SQLite
      TaskRepository.modifyOrchestration(taskId, (orch: IOrchestration) => {
        const parts = fieldPath.split('.');
        const phaseKey = parts[parts.length - 1] as keyof IOrchestration;
        const phaseData = orch[phaseKey] as Record<string, unknown> | undefined;
        if (phaseData) {
          (phaseData as Record<string, unknown>).status = 'completed';
          (phaseData as Record<string, unknown>).skippedOnRecovery = true;
          (phaseData as Record<string, unknown>).skippedAt = new Date();
        }
        return orch;
      });

      console.log(`   ✅ [${phaseName}] Synced skipped phase to SQLite: ${fieldPath}.status = 'completed'`);
    } catch (error: any) {
      console.warn(`   ⚠️ [${phaseName}] Failed to sync skipped phase to DB:`, error.message);
      // Don't throw - this is a best-effort sync
    }
  }

  /**
   * ⚡ OPTIMIZATION: Load all phase statuses from MongoDB once at start
   * This avoids multiple queries/writes during retry skip logic
   */
  private getPhaseStatusesFromTask(task: any): Map<string, string> {
    const statuses = new Map<string, string>();
    const orchestration = task.orchestration || {};

    // 🔍 DIAGNOSTIC: Log the raw orchestration data
    console.log(`🔍 [getPhaseStatusesFromTask] Raw orchestration for task ${task.id}:`);
    console.log(`   planning.status = ${orchestration.planning?.status || 'UNDEFINED'}`);
    console.log(`   techLead.status = ${orchestration.techLead?.status || 'UNDEFINED'}`);
    console.log(`   teamOrchestration.status = ${orchestration.teamOrchestration?.status || 'UNDEFINED'}`);
    console.log(`   judge.status = ${orchestration.judge?.status || 'UNDEFINED'}`);

    const phases = [
      { name: 'Sandbox', field: (orchestration as any).sandbox },
      { name: 'Planning', field: orchestration.planning },
      { name: 'Approval', field: orchestration.approval },
      { name: 'TechLead', field: orchestration.techLead },
      { name: 'TeamOrchestration', field: orchestration.teamOrchestration },
      { name: 'Development', field: orchestration.development },
      { name: 'Developers', field: orchestration.development },
      { name: 'Judge', field: orchestration.judge },
      { name: 'Recovery', field: orchestration.recovery },
      { name: 'Integration', field: orchestration.integration },
      { name: 'AutoMerge', field: orchestration.autoMerge },
      { name: 'Merge', field: orchestration.merge },
      { name: 'Verification', field: orchestration.verification },
    ];

    for (const phase of phases) {
      if (phase.field?.status) {
        statuses.set(phase.name, phase.field.status);
      }
    }

    // 🔍 DIAGNOSTIC: Log what statuses were found
    console.log(`🔍 [getPhaseStatusesFromTask] Statuses found: ${JSON.stringify([...statuses.entries()])}`);

    return statuses;
  }

  /**
   * Get list of completed phases from SQLite task data
   */
  private getCompletedPhasesFromTask(task: ITask): string[] {
    const statuses = this.getPhaseStatusesFromTask(task);
    const completed: string[] = [];
    for (const [phase, status] of statuses.entries()) {
      if (status === 'completed') {
        completed.push(phase);
      }
    }
    return completed;
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
    const freshTask = TaskRepository.findById(task.id);
    if (!freshTask) return [];

    const pendingDirectives = freshTask.orchestration?.pendingDirectives || [];
    if (pendingDirectives.length === 0) return [];

    // Filter directives that match this phase
    // A directive matches if:
    // 1. No targetPhase specified (applies to all), OR
    // 2. targetPhase matches current phase
    interface PendingDirective {
      id: string;
      content: string;
      priority: string;
      consumed?: boolean;
      targetPhase?: string;
    }
    const matchingDirectives = pendingDirectives.filter((d: PendingDirective) => {
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
    matchingDirectives.sort((a: PendingDirective, b: PendingDirective) =>
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
    const directiveHistory = freshTask.orchestration.directiveHistory || [];
    directiveHistory.push(...matchingDirectives as any);

    // Remove consumed directives from pending
    const newPendingDirectives = pendingDirectives.filter((d: PendingDirective) => !d.consumed);

    // Fire-and-forget update to SQLite
    try {
      TaskRepository.modifyOrchestration(task.id, (orch: IOrchestration) => ({
        ...orch,
        pendingDirectives: newPendingDirectives,
        directiveHistory: directiveHistory as IOrchestration['directiveHistory'],
      }));
    } catch (err) {
      console.warn(`⚠️ [Directives] Failed to update directives: ${(err as Error).message}`);
    }

    // Update the task reference with fresh data
    task.orchestration.pendingDirectives = newPendingDirectives;
    task.orchestration.directiveHistory = directiveHistory;

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
      const task = TaskRepository.findById(taskId);
      if (!task) return '';

      const pendingDirectives = task.orchestration.pendingDirectives || [];
      if (pendingDirectives.length === 0) return '';

      interface AgentDirective {
        id: string;
        content: string;
        priority: string;
        consumed?: boolean;
        targetAgent?: string;
      }

      // Filter directives that apply to this agent
      const matchingDirectives = pendingDirectives.filter((d: AgentDirective) => {
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
      matchingDirectives.sort((a: AgentDirective, b: AgentDirective) =>
        (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3)
      );

      const formattedDirectives = matchingDirectives.map((d: AgentDirective) => {
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
   * 🚀 AUTOMATIC QUALITY GATES - Run tests and reviews after key phases
   *
   * Integrates BackgroundTaskService and SlashCommandService for:
   * - After TeamOrchestration: Run tests in background
   * - Before AutoMerge: Run code review
   * - After Verification: Run security audit
   *
   * These are non-blocking and additive - they don't stop the orchestration
   * but provide valuable feedback for the agents and human reviewers.
   */
  private async runAutomaticQualityGates(
    taskId: string,
    phaseName: string,
    context: OrchestrationContext,
    workspacePath: string
  ): Promise<void> {
    try {
      // 🧪 After TeamOrchestration: Run tests in background
      if (phaseName === 'TeamOrchestration') {
        console.log(`\n🧪 [Quality Gates] Running automatic tests after TeamOrchestration...`);
        NotificationService.emitConsoleLog(taskId, 'info', `🧪 Running automatic tests in background...`);

        // Start tests in background - doesn't block orchestration
        const testTask = await BackgroundTaskService.runTests({
          taskId,
          cwd: workspacePath,
          command: 'npm test -- --passWithNoTests 2>&1 || echo "Tests completed with some failures"',
        });

        console.log(`   📋 Background test task started: ${testTask.id}`);
        NotificationService.emitConsoleLog(taskId, 'info', `📋 Background test task: ${testTask.id}`);

        // Store test task ID in context for later reference
        context.setData('backgroundTestTaskId', testTask.id);

        // Also run /test command for detailed analysis (stored for agent reference)
        const testResult = await SlashCommandService.execute('/test', taskId);
        if (testResult.success && testResult.prompt) {
          context.setData('testAnalysisPrompt', testResult.prompt);
          console.log(`   ✅ Test analysis prompt generated`);
        }
      }

      // 📝 Before AutoMerge: Run code review
      if (phaseName === 'Verification') {
        console.log(`\n📝 [Quality Gates] Running automatic code review before AutoMerge...`);
        NotificationService.emitConsoleLog(taskId, 'info', `📝 Running code review...`);

        // Run /review command for the changes
        const reviewResult = await SlashCommandService.execute('/review git diff main...HEAD', taskId);
        if (reviewResult.success && reviewResult.prompt) {
          context.setData('codeReviewPrompt', reviewResult.prompt);
          console.log(`   ✅ Code review prompt generated`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Code review analysis ready`);
        }

        // Run /security command for security audit
        const securityResult = await SlashCommandService.execute('/security', taskId);
        if (securityResult.success && securityResult.prompt) {
          context.setData('securityAuditPrompt', securityResult.prompt);
          console.log(`   ✅ Security audit prompt generated`);
          NotificationService.emitConsoleLog(taskId, 'info', `✅ Security audit analysis ready`);
        }
      }

      // 📊 After any phase: Check background task status
      const bgTestId = context.getData('backgroundTestTaskId') as string | undefined;
      if (bgTestId && typeof bgTestId === 'string') {
        const testStatus = BackgroundTaskService.getStatus(bgTestId);
        if (testStatus) {
          if (testStatus.status === 'completed') {
            console.log(`   ✅ Background tests completed (exit: ${testStatus.exitCode})`);
            NotificationService.emitConsoleLog(
              taskId,
              testStatus.exitCode === 0 ? 'info' : 'warn',
              `🧪 Background tests ${testStatus.exitCode === 0 ? 'passed' : 'completed with issues'}`
            );
            // Store results in context
            context.setData('testResults', {
              status: testStatus.status,
              exitCode: testStatus.exitCode,
              output: testStatus.output.slice(-50), // Last 50 lines
            });
          } else if (testStatus.status === 'failed') {
            console.log(`   ❌ Background tests failed: ${testStatus.error}`);
            NotificationService.emitConsoleLog(taskId, 'error', `🧪 Background tests failed`);
          } else if (testStatus.status === 'running') {
            const runningTasks = BackgroundTaskService.getRunningCount();
            console.log(`   ⏳ Background tests still running (${runningTasks} tasks active)`);
          }
        }
      }

    } catch (error: any) {
      // Quality gates are non-critical - log but don't fail orchestration
      console.warn(`⚠️ [Quality Gates] Non-critical error: ${error.message}`);
      NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ Quality gate warning: ${error.message}`);
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
   * Execute a single agent with SDK query function
   *
   * 🔥 REFACTORED: Delegated to AgentExecutorService to reduce file size
   * This wrapper maintains backwards compatibility with existing code.
   *
   * @see AgentExecutorService.executeAgent for full implementation
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
      sandboxId?: string;  // 🐳 Explicit sandbox ID for Docker execution
    },
    contextOverride?: OrchestrationContext,
    skipOptimization?: boolean,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    resumeOptions?: ResumeOptions
  ): Promise<AgentExecutionResult> {
    // 🔥 DELEGATE to extracted service
    return agentExecutorService.executeAgent(
      agentType,
      prompt,
      workspacePath,
      taskId,
      _agentName,
      sessionId,
      _fork,
      attachments,
      _options,
      contextOverride,
      skipOptimization,
      permissionMode,
      resumeOptions
    );
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
    environmentCommands?: any, // 🔧 Environment commands from TechLead (test, lint, typecheck, etc.)
    projectRadiographies?: Map<string, any>, // 🔬 Language-agnostic project analysis from PlanningPhase
    // 🔄 SESSION RESUME: Continue from interrupted execution
    resumeOptions?: {
      resumeSessionId?: string;    // SDK session ID to resume from
      resumeAtMessage?: string;    // Specific message UUID to resume from
      isResume?: boolean;          // Flag indicating this is a resume
    },
    // 🐳 SANDBOX: Explicit sandbox ID for Docker execution
    sandboxId?: string
  ): Promise<{ output?: string; cost?: number; usage?: any; sdkSessionId?: string; lastMessageUuid?: string; filesModified?: string[]; filesCreated?: string[]; toolsUsed?: string[]; turnsCompleted?: number } | void> {
    const taskId = (task.id as any).toString();

    // 🚀 RETRY OPTIMIZATION: Use topModel when Judge rejected code
    if (forceTopModel && judgeFeedback) {
      const configs = await import('../../config/ModelConfigurations');

      // Get the actual AgentModelConfig from the task (default to RECOMMENDED)
      let actualConfig: typeof configs.ALL_OPUS_CONFIG = configs.ALL_OPUS_CONFIG;

      if (task.orchestration.modelConfig) {
        const { preset, customConfig } = task.orchestration.modelConfig;

        if (preset === 'custom' && customConfig) {
          actualConfig = configs.mapDbConfigToAgentModelConfig(customConfig);
        } else if (preset) {
          switch (preset) {
            case 'max': actualConfig = configs.ALL_OPUS_CONFIG; break;
            case 'premium': actualConfig = configs.ALL_OPUS_CONFIG; break;
            case 'recommended': actualConfig = configs.ALL_OPUS_CONFIG; break;
            case 'standard': actualConfig = configs.ALL_OPUS_CONFIG; break;
          }
        }
      }

      const topModel = configs.getTopModelFromConfig(actualConfig);
      const topModelName = topModel.includes('opus') ? 'Opus' :
                          topModel.includes('sonnet') ? 'Sonnet' : 'Haiku';

      console.log(`🚀 [Developer ${member.instanceId}] RETRY with topModel: ${topModelName}`);
      console.log(`   Reason: Judge rejected code, using best available model for retry`);

      // Temporarily override developer model to topModel
      const updatedConfig: typeof configs.ALL_OPUS_CONFIG = {
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

    let lastResult: { output?: string; cost?: number; usage?: any; sdkSessionId?: string; lastMessageUuid?: string; filesModified?: string[]; filesCreated?: string[]; toolsUsed?: string[]; turnsCompleted?: number } | undefined;

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

        // Mark task as failed instead of using dangerous fallback (fire-and-forget)
        updateTaskFireAndForget(task.id, { status: 'failed' }, 'mark failed - no targetRepository');

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

      // 🔥🔥🔥 BRANCH CREATION (FIRST - before prompt building)
      // Developer creates story branch locally and will push after working
      const repoPath = `${workspacePath}/${repoName}`;

      // Generate unique branch name if not already set
      let branchName = story.branchName;
      const isRetry = !!branchName; // If branchName exists, this is a retry

      if (!branchName) {
        // First attempt - create DETERMINISTIC branch name
        const taskShortId = taskId.slice(-8);
        const storySlug = story.id.replace(/[^a-z0-9]/gi, '-').toLowerCase().slice(0, 30);
        const storyHash = story.id.split('').reduce((a: number, c: string) => ((a << 5) - a + c.charCodeAt(0)) | 0, 0).toString(36).slice(-6);
        branchName = `story/${taskShortId}-${storySlug}-${storyHash}`;
      }

      console.log(`\n🌿 [Developer ${member.instanceId}] ${isRetry ? 'Resuming' : 'Creating'} story branch: ${branchName}`);

      try {
        if (isRetry) {
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
          try {
            safeGitExecSync(`git checkout -b ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
            console.log(`✅ [Developer ${member.instanceId}] Created new branch: ${branchName}`);
          } catch (createErr: any) {
            if (createErr.message.includes('already exists')) {
              console.log(`   ℹ️ Branch already exists (resume scenario), checking out...`);
              try {
                safeGitExecSync(`git checkout ${branchName}`, { cwd: repoPath, encoding: 'utf8' });
              } catch {
                safeGitExecSync(`git checkout -b ${branchName} origin/${branchName}`, { cwd: repoPath, encoding: 'utf8' });
              }
              console.log(`✅ [Developer ${member.instanceId}] Checked out existing branch: ${branchName}`);
            } else {
              throw createErr;
            }
          }
        }

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

      // 🔥 Build developer prompt using extracted builder (Rich context per SDK philosophy)
      const projectId = task.projectId?.toString() || '';
      const directivesBlock = await this.getDirectivesForAgent(task.id as any, 'developer');

      // Get project radiography for this repo
      let projectRadiography: any = undefined;
      if (projectRadiographies && projectRadiographies.size > 0) {
        projectRadiography = projectRadiographies.get(repoName) || projectRadiographies.get(targetRepository);
      }

      const prompt = await DeveloperPromptBuilder.build({
        story,
        targetRepository,
        repoName,
        workspacePath,
        projectId,
        taskId,
        memberId: member.instanceId,
        directivesBlock,
        branchName,
        judgeFeedback,
        devAuth,
        architectureBrief,
        projectRadiography,
        environmentCommands,
      });

      console.log(`📝 [Developer ${member.instanceId}] Prompt built (${prompt.length} chars)`);

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
        // 🔄 Pass resumeOptions for mid-execution recovery support
        const result = await this.executeAgent(
          'developer',
          prompt,
          workspacePath, // Let SDK access workspace root
          taskId,
          `Developer ${member.instanceId}`,
          undefined, // sessionId
          undefined, // fork
          attachments, // Pass images for visual context
          sandboxId ? { sandboxId } : undefined, // 🐳 Pass sandbox ID for Docker execution
          undefined, // contextOverride
          forceTopModel, // skipOptimization - when true, keeps topModel for retry
          undefined, // permissionMode
          resumeOptions // 🔄 Session resume options
        );

        console.log(`✅ [Developer ${member.instanceId}] Completed story: ${story.title}`);
        console.log(`📊 [Developer ${member.instanceId}] Cost: $${result.cost?.toFixed(4) || 0}`);

        // 🔄 Log session info for debugging
        if (result.sdkSessionId) {
          console.log(`🔄 [Developer ${member.instanceId}] SDK Session: ${result.sdkSessionId}`);
        }

        // Store result for return (isolated pipeline uses single-story execution)
        // 🔄 Include session data for mid-execution recovery
        // 🔥 Include granular tracking for recovery
        lastResult = {
          output: result.output,
          cost: result.cost,
          usage: result.usage,
          sdkSessionId: result.sdkSessionId,
          lastMessageUuid: result.lastMessageUuid,
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          toolsUsed: result.toolsUsed,
          turnsCompleted: result.turnsCompleted,
        };

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

        // 🔥 FIX: Check if StoryPushVerified event exists BEFORE requiring marker
        // If git push was already verified, we don't need the text marker
        let commitSHA: string | undefined;
        let gitVerifiedSuccess = false;

        try {
          const events = await eventStore.getEvents(taskId);
          const pushVerifiedEvent = events.find(
            (e: any) => e.eventType === 'StoryPushVerified' &&
            e.payload?.storyId === story.id &&
            e.payload?.commitSha
          );

          if (pushVerifiedEvent?.payload?.commitSha) {
            commitSHA = pushVerifiedEvent.payload.commitSha as string;
            gitVerifiedSuccess = true;
            console.log(`✅ [Developer ${member.instanceId}] Git push already verified via StoryPushVerified event`);
            console.log(`   Commit SHA: ${commitSHA}`);
            console.log(`   Branch: ${pushVerifiedEvent.payload.branchName}`);
          }
        } catch (eventErr: any) {
          console.warn(`⚠️ [Developer ${member.instanceId}] Could not check StoryPushVerified: ${eventErr.message}`);
        }

        // Only require marker if git wasn't verified via events
        if (!gitVerifiedSuccess && !developerFinishedSuccessfully) {
          console.error(`❌ [Developer ${member.instanceId}] Developer did NOT report success`);
          console.error(`   No StoryPushVerified event found AND no success marker in output`);
          console.error(`   Expected: "✅ DEVELOPER_FINISHED_SUCCESSFULLY" or verified git push`);
          throw new Error(`Developer ${member.instanceId} did not report success for story ${story.title}`);
        }

        // Extract commit SHA from output if not already found
        if (!commitSHA) {
          const commitMatch = developerOutput.match(/📍\s*Commit SHA:\s*([a-f0-9]{40})/i);
          commitSHA = commitMatch?.[1];
        }

        if (!commitSHA) {
          console.error(`❌ [Developer ${member.instanceId}] Could not determine commit SHA`);
          console.error(`   No StoryPushVerified event AND no commit SHA in output`);
          throw new Error(`Developer ${member.instanceId} did not report commit SHA for story ${story.title}`);
        }

        console.log(`✅ [Developer ${member.instanceId}] Commit SHA: ${commitSHA}`);

        // 🔥 CRITICAL: Verify branch EXISTS on remote (Judge cannot review non-existent branch)
        let branchExistsOnRemote = false;
        let verificationAttempts = 0;
        const maxVerificationAttempts = 3;
        const verificationTimeout = 45000; // 45 seconds - increased from 15s

        while (verificationAttempts < maxVerificationAttempts && !branchExistsOnRemote) {
          verificationAttempts++;
          try {
            console.log(`⏱️  [Developer ${member.instanceId}] Verifying branch on remote (attempt ${verificationAttempts}/${maxVerificationAttempts})...`);
            const lsRemoteOutput = safeGitExecSync(
              `git ls-remote --heads origin ${branchName}`,
              { cwd: repoPath, encoding: 'utf8', timeout: verificationTimeout }
            );
            branchExistsOnRemote = lsRemoteOutput.trim().length > 0 && lsRemoteOutput.includes(branchName);

            if (!branchExistsOnRemote && verificationAttempts < maxVerificationAttempts) {
              console.log(`⚠️  [Developer ${member.instanceId}] Branch not found yet, waiting 5s before retry...`);
              // Wait 5 seconds before retry (branch might still be propagating)
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          } catch (lsError: any) {
            const isTimeout = lsError.message?.includes('timed out') || lsError.message?.includes('timeout');
            console.error(`❌ [Developer ${member.instanceId}] git ls-remote failed (attempt ${verificationAttempts}): ${lsError.message}`);

            if (isTimeout && verificationAttempts < maxVerificationAttempts) {
              console.log(`⚠️  [Developer ${member.instanceId}] Timeout on verification, retrying in 5s...`);
              await new Promise(resolve => setTimeout(resolve, 5000));
            }
          }
        }

        if (!branchExistsOnRemote) {
          console.error(`❌ [Developer ${member.instanceId}] Branch ${branchName} NOT found on remote after ${verificationAttempts} attempts!`);
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
            { cwd: repoPath, encoding: 'utf8', timeout: 60000 }
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
        story.branchName = branchName; // Save branch name for downstream phases

        console.log(`🌿 [Developer ${member.instanceId}] Story branch confirmed: ${branchName}`);

        // 🔥 EVENT SOURCING: Confirm story branch (TechLead created it, Developer confirms it was used)
        // This is idempotent - if TechLead already emitted this event, it just updates with same value
        // Note: eventStore is already imported at the top of the file
        await eventStore.safeAppend({
          taskId: task.id as any,
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

    // Mark developer as completed (fire-and-forget)
    member.status = 'completed';
    saveTaskFireAndForget(task, 'developer completed');

    console.log(`✅ [Developer ${member.instanceId}] All stories completed`);

    // Return last result (for isolated story pipeline - contains commit SHA in output)
    return lastResult;
  }

  /**
   * Save orchestration timeline to Local + GitHub
   * Called after each phase completes to maintain execution history
   */
  private async saveOrchestrationTimeline(
    task: ITask,
    completedPhase: string,
    context: OrchestrationContext,
    workspacePath: string | null
  ): Promise<void> {
    try {
      const taskId = (task.id as any).toString();
      const repositories = context.repositories || [];
      const primaryRepo = repositories[0]?.name;

      if (!primaryRepo || !workspacePath) {
        console.log(`⚠️ [Timeline] Skipping - no repository or workspace path`);
        return;
      }

      // Build phases completed list
      const phasesCompleted: Array<{
        phase: string;
        status: 'completed' | 'failed' | 'skipped';
        completedAt?: Date;
        cost?: number;
      }> = [];

      // Check each phase status from task.orchestration
      const phaseMapping: { [key: string]: any } = {
        'Planning': task.orchestration.planning,
        'TechLead': task.orchestration.techLead,
        'Judge': task.orchestration.judge,
        'AutoMerge': task.orchestration.autoMerge,
      };

      for (const [phaseName, phaseData] of Object.entries(phaseMapping)) {
        if (phaseData?.status === 'completed') {
          phasesCompleted.push({
            phase: phaseName,
            status: 'completed',
            completedAt: phaseData.completedAt,
            cost: phaseData.cost_usd,
          });
        }
      }

      // Build epics summary
      const epics = (task.orchestration.planning?.epics || []).map((epic: any) => ({
        id: epic.id,
        title: epic.title,
        status: epic.status || 'pending',
        storiesCount: epic.stories?.length || 0,
      }));

      // Save timeline
      await AgentArtifactService.saveOrchestrationTimeline(
        workspacePath,
        primaryRepo,
        taskId,
        {
          taskTitle: task.title,
          taskDescription: task.description,
          startedAt: (task as any).createdAt || new Date(),
          currentPhase: completedPhase,
          phasesCompleted,
          epics,
          totalCost: task.orchestration.totalCost,
          totalTokens: task.orchestration.totalTokens,
          lastUpdated: new Date(),
        }
      );

      console.log(`📦 [Timeline] Saved after ${completedPhase} phase`);

      // 📦 EVENTS BACKUP: Save all EventStore events to Local + GitHub
      // This ensures MongoDB events are mirrored to Local for recovery
      await eventStore.backupEvents(task.id, workspacePath, primaryRepo);
      console.log(`📦 [EventStore] Events backed up after ${completedPhase} phase`);
    } catch (error: any) {
      // Non-blocking - timeline is backup, not critical
      console.warn(`⚠️ [Timeline] Failed to save (non-blocking): ${error.message}`);
    }
  }

  /**
   * Handle phase failure
   */
  private async handlePhaseFailed(task: ITask, phaseName: string, result: PhaseResult): Promise<void> {
    task.status = 'failed';
    // Map phase names to enum values (fire-and-forget - fail notification follows)
    task.orchestration.currentPhase = this.mapPhaseToEnum(phaseName);
    saveTaskFireAndForget(task, 'phase failed');

    NotificationService.emitTaskFailed((task.id as any).toString(), {
      phase: phaseName,
      error: result.error || 'Phase failed',
    });

    console.error(`❌ Orchestration failed at phase: ${phaseName}`);
  }

  /**
   * Handle orchestration completion
   */
  private async handleOrchestrationComplete(task: ITask, _context: OrchestrationContext): Promise<void> {
    const taskId = (task.id as any).toString();

    // 🐳 Cleanup sandbox (but don't delete for LivePreview access)
    const useSandbox = _context.getData<boolean>('useSandbox');
    if (useSandbox) {
      console.log(`   🐳 Sandbox remains active for LivePreview: task-${taskId.substring(0, 12)}`);
      // NOTE: We keep the sandbox running so users can preview the result
      // It will be cleaned up by workspace cleanup scheduler or manual stop
    }

    task.status = 'completed';
    task.orchestration.currentPhase = 'completed';
    await saveTaskCritical(task, 'orchestration completed');

    // 🏊 SANDBOX POOL: Mark task as completed to free up files for other tasks
    try {
      const projectId = task.projectId?.toString() || taskId;
      const primaryRepoName = _context.repositories.length > 0
        ? _context.repositories[0].name || _context.repositories[0].githubRepoName
        : 'default';
      sandboxPoolService.completeTask(taskId, projectId, primaryRepoName, true);
      console.log(`🏊 [Orchestration] Task completed in sandbox pool - files released for reuse`);
    } catch (poolError) {
      console.warn(`⚠️ [Orchestration] Failed to mark task completed in pool (non-critical):`, poolError);
    }

    // Calculate detailed cost breakdown by phase
    const breakdown: { phase: string; cost: number; inputTokens: number; outputTokens: number }[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Planning
    if (task.orchestration.planning?.usage) {
      const planning = task.orchestration.planning;
      breakdown.push({
        phase: 'Planning',
        cost: planning.cost_usd || 0,
        inputTokens: planning.usage?.input_tokens || 0,
        outputTokens: planning.usage?.output_tokens || 0,
      });
      totalInputTokens += planning.usage?.input_tokens || 0;
      totalOutputTokens += planning.usage?.output_tokens || 0;
      cacheCreationTokens += planning.usage?.cache_creation_input_tokens || 0;
      cacheReadTokens += planning.usage?.cache_read_input_tokens || 0;
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
    saveTaskFireAndForget(task, 'update cost/tokens');

    // Collect PRs from epics
    const pullRequests: { epicName: string; prNumber: number; prUrl: string; repository: string }[] = [];
    // Note: eventStore is already imported at the top of the file
    const currentState = await eventStore.getCurrentState(task.id as any);

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
    NotificationService.emitOrchestrationCompleted((task.id as any).toString(), {
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
    // Note: taskId already declared at top of function

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
    // Fire-and-forget status update - error notification follows
    updateTaskFireAndForget(taskId, { status: 'failed' }, 'orchestration error');

    NotificationService.emitTaskFailed(taskId, {
      error: error.message,
    });

    // 🔥 IMPORTANT: Clean up task-specific resources even on failure
    CostBudgetService.cleanupTaskConfig(taskId);
    console.log(`🧹 Cleaned up task-specific cost budget config for failed task ${taskId}`);

    // 🏊 SANDBOX POOL: Mark task as failed to release files for other tasks
    try {
      sandboxPoolService.completeTaskById(taskId, false);
      console.log(`🏊 Cleaned up sandbox pool for failed task ${taskId}`);
    } catch (poolError) {
      console.warn(`⚠️ Failed to cleanup sandbox pool for task ${taskId} (non-critical):`, poolError);
    }

    // Clean up approval event listeners
    import('../ApprovalEvents').then(({ approvalEvents }) => {
      approvalEvents.cleanupTask(taskId);
      console.log(`🧹 Cleaned up approval event listeners for failed task ${taskId}`);
    });
  }
}
