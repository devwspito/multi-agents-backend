import { Task, ITask } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { GitHubService } from '../GitHubService';
import { PRManagementService } from '../github/PRManagementService';
import { ContextCompactionService } from '../ContextCompactionService';
import { NotificationService } from '../NotificationService';
import { OrchestrationContext, IPhase, PhaseResult } from './Phase';
import { ProductManagerPhase } from './ProductManagerPhase';
import { ProjectManagerPhase } from './ProjectManagerPhase';
import { TechLeadPhase } from './TechLeadPhase';
import { DevelopersPhase } from './DevelopersPhase';
import { JudgePhase } from './JudgePhase';
import { QAPhase } from './QAPhase';
import { ApprovalPhase } from './ApprovalPhase';
import { TeamOrchestrationPhase } from './TeamOrchestrationPhase';
import { AutoMergePhase } from './AutoMergePhase';
import { AgentModelConfig, getModelAlias } from '../../config/ModelConfigurations';

// 🔥 NEW: Best practice services
import { RetryService } from './RetryService';
// import { SchemaValidationService } from './SchemaValidation'; // Unused - available for future use
import { CostBudgetService } from './CostBudgetService';
import { SecretsDetectionService } from './SecretsDetectionService';

import path from 'path';
import os from 'os';
import fs from 'fs';
import { execSync } from 'child_process';

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
  private readonly prManagementService: PRManagementService;
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
    'ProblemAnalyst',      // 0. Deep problem analysis and architecture
    'ProductManager',      // 1. Analyze requirements (Sonnet 4.5 orchestrator)
    'Approval',            // 1.5 Human approval gate
    'ProjectManager',      // 2. Break into epics (Sonnet 4.5 orchestrator)
    'Approval',            // 2.5 Human approval gate
    'TeamOrchestration',   // 3. Multi-team parallel execution (TechLead → Developers → Judge → QA per epic)
    'e2e-testing',          // 4. End-to-end integration testing (frontend-backend)
    'e2e-fixer',            // 4.5 Fix integration issues if E2E detected errors
    'Approval',            // 5. Human approval gate (final approval - all teams done + E2E passed)
    'AutoMerge',           // 6. Automatically merge PRs to main
  ];

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(this.workspaceDir);
    this.prManagementService = new PRManagementService(this.githubService);
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
        const gitDiff = execSync('git diff --stat', {
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
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎯 Starting orchestration for task: ${taskId}`);
    console.log(`${'='.repeat(80)}\n`);

    // Emitir log al frontend
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
        console.error(`❌ Repository lookup failed:`);
        console.error(`   Task ID: ${taskId}`);
        console.error(`   Task repositoryIds: ${JSON.stringify(task.repositoryIds)}`);
        console.error(`   Task userId: ${task.userId}`);

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

      // Get user's GitHub token for cloning
      const User = (await import('../../models/User')).User;
      const user = await User.findById(task.userId).select('accessToken defaultApiKey');
      if (!user || !user.accessToken) {
        throw new Error(
          `User GitHub token not found. User must connect their GitHub account before starting orchestration.`
        );
      }

      console.log(`✅ Found ${repositories.length} repositories for task`);
      NotificationService.emitConsoleLog(taskId, 'info', `✅ Found ${repositories.length} repositories for task`);

      // Setup workspace (pass user token for cloning)
      const workspacePath = await this.setupWorkspace(taskId, repositories, user.accessToken);
      const workspaceStructure = await this.getWorkspaceStructure(workspacePath);

      // Create orchestration context (shared state for all phases)
      const context = new OrchestrationContext(task, repositories, workspacePath);

      // 🔑 Get project-specific API key with fallback chain:
      // 1. Project API key (if set)
      // 2. User's default API key (if set)
      // 3. Environment variable (fallback)
      let anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      let apiKeySource = 'environment';

      // Get project to check for project-specific API key
      const ProjectModel = (await import('../../models/Project')).Project;
      const project = userProjects.length > 0 ? await ProjectModel.findById(userProjects[0]._id).select('+apiKey') : null;

      if (project?.apiKey) {
        anthropicApiKey = project.apiKey;
        apiKeySource = 'project';
        console.log(`🔑 Using project-specific API key (project: ${project.name})`);
      } else if (user.defaultApiKey) {
        anthropicApiKey = user.defaultApiKey;
        apiKeySource = 'user_default';
        console.log(`🔑 Using user's default API key`);
      } else {
        console.log(`🔑 Using environment API key (no project or user default set)`);
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

        // Log phase start
        NotificationService.emitConsoleLog(taskId, 'info', `🚀 Starting phase: ${phaseName}`);

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

              // Get current model config
              let currentModelConfig: AgentModelConfig = configs.STANDARD_CONFIG;
              if (task.orchestration?.modelConfig) {
                const { preset, customConfig } = task.orchestration.modelConfig;
                if (preset === 'custom' && customConfig) {
                  currentModelConfig = customConfig as AgentModelConfig;
                } else if (preset === 'max') {
                  currentModelConfig = configs.MAX_CONFIG;
                } else if (preset === 'premium') {
                  currentModelConfig = configs.PREMIUM_CONFIG;
                } else {
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

        // 🔥 SPECIAL HANDLING: QA → Fixer → QA retry loop
        if (phaseName === 'QA' && result.success && result.data?.hasErrors) {
          console.log(`🔧 [QA] QA detected errors - executing Fixer phase`);
          console.log(`   Error type: ${result.data?.errorType}`);
          console.log(`   QA Attempt: ${result.data?.qaAttempt}`);
          NotificationService.emitConsoleLog(taskId, 'info', `🔧 QA detected errors - executing Fixer to resolve`);

          // Execute Fixer
          const fixerPhase = this.createPhase('Fixer', context);
          console.log(`   Fixer phase created: ${fixerPhase ? 'YES' : 'NO'}`);

          if (fixerPhase) {
            console.log(`🔧 [Fixer] Starting Fixer execution...`);
            NotificationService.emitConsoleLog(taskId, 'info', `🔧 Starting Fixer agent to fix ${result.data?.errorType || 'detected'} errors...`);

            const fixerResult = await fixerPhase.execute(context);
            console.log(`🔧 [Fixer] Execution completed:`, {
              success: fixerResult.success,
              fixed: fixerResult.data?.fixed,
              filesModified: fixerResult.data?.filesModified
            });

            if (fixerResult.success && fixerResult.data?.fixed) {
              // Fixer succeeded - re-execute QA (attempt 2)
              console.log(`✅ [Fixer] Fixed errors - re-running QA (attempt 2)`);
              NotificationService.emitConsoleLog(taskId, 'info', `✅ Fixer completed - re-running QA tests`);

              const qaPhase2 = this.createPhase('QA', context);
              if (qaPhase2) {
                const qaResult2 = await qaPhase2.execute(context);

                if (!qaResult2.success) {
                  // QA attempt 2 failed
                  NotificationService.emitConsoleLog(taskId, 'error', `❌ QA attempt 2 failed: ${qaResult2.error}`);
                  await this.handlePhaseFailed(task, 'QA', qaResult2);
                  return;
                }

                // QA attempt 2 succeeded - continue
                console.log(`✅ [QA] Attempt 2 completed successfully`);
                NotificationService.emitConsoleLog(taskId, 'info', `✅ QA attempt 2 passed - PRs created`);
              }
            } else {
              // Fixer failed - QA already created PRs with error docs
              console.log(`⚠️  [Fixer] Could not fix errors - PRs created with error documentation`);
              NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ Fixer could not resolve all errors - PRs created with error documentation`);
            }
          }
        }

        // 🔥 SPECIAL HANDLING: e2e-testing → e2e-fixer → e2e-testing smart retry loop
        if (phaseName === 'e2e-testing' && result.success && result.data?.hasErrors) {
          console.log(`🔧 [E2ETesting] E2E detected integration errors - executing E2E Fixer phase`);
          console.log(`   Error type: ${result.data?.errorType}`);
          NotificationService.emitConsoleLog(taskId, 'info', `🔧 E2E Testing detected integration errors - executing E2E Fixer to resolve`);

          // Mark that E2E Fixer should run
          context.setData('shouldRunE2EFixer', true);

          // Loop: Execute Fixer → Test → Fixer... until fixed or max retries
          let retryCount = 0;
          const maxRetries = 3;
          let fixed = false;

          while (retryCount < maxRetries && !fixed) {
            console.log(`\n🔄 [E2E Loop] Iteration ${retryCount + 1}/${maxRetries}`);

            // Execute E2E Fixer
            const e2eFixerPhase = this.createPhase('e2e-fixer', context);
            if (!e2eFixerPhase) {
              console.log(`❌ [E2E Loop] Could not create E2E Fixer phase - breaking loop`);
              break;
            }

            const e2eFixerResult = await e2eFixerPhase.execute(context);
            console.log(`🔧 [E2EFixer] Execution completed:`, {
              success: e2eFixerResult.success,
              fixed: e2eFixerResult.data?.fixed,
              maxRetriesReached: e2eFixerResult.data?.maxRetriesReached,
            });

            // Check if max retries reached for same error
            if (e2eFixerResult.data?.maxRetriesReached) {
              console.log(`⚠️  [E2E Loop] Max retries reached for same error - allowing continuation with documented errors`);
              NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ E2E Fixer tried ${maxRetries} times but couldn't fix the same error - allowing continuation`);
              break;
            }

            // Check if fixer succeeded
            if (e2eFixerResult.success && e2eFixerResult.data?.fixed) {
              console.log(`✅ [E2EFixer] Fixed integration errors - re-running E2E Testing`);
              NotificationService.emitConsoleLog(taskId, 'info', `✅ E2E Fixer completed - re-running integration tests`);

              // Re-run E2E Testing
              const e2eTestingPhaseRetry = this.createPhase('e2e-testing', context);
              if (e2eTestingPhaseRetry) {
                const e2eTestingResultRetry = await e2eTestingPhaseRetry.execute(context);

                if (e2eTestingResultRetry.success) {
                  if (e2eTestingResultRetry.data?.hasErrors) {
                    // Still has errors - check if error changed
                    console.log(`⚠️  [E2E Loop] E2E Testing still reports errors - may be different error, continuing loop`);
                    context.setData('shouldRunE2EFixer', true);
                    retryCount++;
                  } else {
                    // No errors - success!
                    console.log(`✅ [E2E Loop] E2E Testing passed - integration verified`);
                    NotificationService.emitConsoleLog(taskId, 'info', `✅ E2E Testing passed - frontend-backend integration verified`);
                    fixed = true;
                    break;
                  }
                } else {
                  console.log(`❌ [E2E Loop] E2E Testing failed critically: ${e2eTestingResultRetry.error}`);
                  break;
                }
              }
            } else {
              // Fixer failed this iteration
              console.log(`⚠️  [E2EFixer] Could not fix on this attempt (${retryCount + 1}/${maxRetries})`);

              if (e2eFixerResult.data?.shouldRetryE2E) {
                // Can retry E2E Testing to see if error changed
                console.log(`🔄 [E2E Loop] Will retry E2E Testing to detect if error changed`);
                retryCount++;
              } else {
                // Don't retry
                console.log(`⏹️  [E2E Loop] Stopping retry loop`);
                break;
              }
            }
          }

          if (!fixed && retryCount >= maxRetries) {
            console.log(`⚠️  [E2E Loop] Completed ${maxRetries} iterations without full fix - allowing continuation with documented errors`);
            NotificationService.emitConsoleLog(taskId, 'warn', `⚠️ E2E testing completed with remaining integration issues - documented for review`);
          }
        }

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
      case 'ProblemAnalyst':
        return new (require('./ProblemAnalystPhase').ProblemAnalystPhase)(executeAgentWithContext);
      case 'ProductManager':
        return new ProductManagerPhase(executeAgentWithContext);

      case 'ProjectManager':
        return new ProjectManagerPhase(executeAgentWithContext);

      case 'TeamOrchestration':
        return new TeamOrchestrationPhase(
          executeAgentWithContext,
          this.executeDeveloper.bind(this),
          this.githubService,
          this.prManagementService,
          this.workspaceDir
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

      case 'QA':
        return new QAPhase(
          executeAgentWithContext,
          this.githubService,
          this.prManagementService,
          this.workspaceDir
        );

      case 'Fixer':
        return new (require('./FixerPhase').FixerPhase)(executeAgentWithContext);

      case 'e2e-testing':
        return new (require('./E2ETestingPhase').E2ETestingPhase)(executeAgentWithContext);

      case 'e2e-fixer':
        return new (require('./E2EFixerPhase').E2EFixerPhase)(executeAgentWithContext);

      case 'Approval':
        return new ApprovalPhase();

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
        repo.githubRepoName,
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
    contextOverride?: OrchestrationContext
  ): Promise<any> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { getAgentDefinition, getAgentDefinitionWithSpecialization, getAgentModel } = await import('./AgentDefinitions');

    // Get repository type from task or context for developer specialization
    let repositoryType: 'frontend' | 'backend' | 'mobile' | 'fullstack' | 'library' | 'unknown' = 'unknown';
    if (taskId && agentType === 'developer') {
      try {
        const task = await Task.findById(taskId).populate('projectId');
        if (task?.projectId) {
          const project = task.projectId as any;
          // Get repository type from the first repository (if multi-repo)
          if (project.repositories && project.repositories.length > 0) {
            repositoryType = project.repositories[0].type || 'unknown';
          } else if (project.repository) {
            repositoryType = project.repository.type || 'unknown';
          }
        }
      } catch (error: any) {
        console.warn(`[OrchestrationCoordinator] Failed to get repository type for specialization: ${error.message}`);
      }
    }

    // Get agent configuration with specialization for developers
    const agentDef = agentType === 'developer'
      ? getAgentDefinitionWithSpecialization(agentType, repositoryType)
      : getAgentDefinition(agentType);

    if (!agentDef) {
      throw new Error(`Agent type "${agentType}" not found in agent definitions`);
    }

    // Get model configuration from task if available
    // Always default to STANDARD_CONFIG if not specified
    const configs = await import('../../config/ModelConfigurations');
    let modelConfig: AgentModelConfig = configs.STANDARD_CONFIG; // Default to standard

    if (taskId) {
      const task = await Task.findById(taskId);
      if (task?.orchestration?.modelConfig) {
        const { preset, customConfig } = task.orchestration.modelConfig;
        console.log(`🎯 [ExecuteAgent] Task ${taskId} has modelConfig: preset=${preset}, hasCustomConfig=${!!customConfig}`);

        if (preset === 'custom' && customConfig) {
          modelConfig = customConfig as AgentModelConfig;
          console.log(`🎯 [ExecuteAgent] Using custom model configuration`);
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
            case 'standard':
            default:
              modelConfig = configs.STANDARD_CONFIG;
              console.log(`⚙️ [ExecuteAgent] Using STANDARD_CONFIG (Sonnet + Haiku)`);
              break;
          }
        }
      } else {
        console.log(`⚠️ [ExecuteAgent] Task ${taskId} has no modelConfig, using STANDARD_CONFIG as default`);
      }
    }

    // 🎯 AUTOMATIC OPTIMIZATION: Apply cost-performance optimization
    // This ensures critical agents get top model, executors get bottom model
    // Works with ANY config the user selected (MAX, PREMIUM, STANDARD, BALANCED, ECONOMY, CUSTOM)
    modelConfig = configs.optimizeConfigForBudget(modelConfig);
    console.log(`✨ [ExecuteAgent] Applied automatic optimization for agent: ${agentType}`);

    // 🔥 CRITICAL: Model optimization strategy without sacrificing quality
    let fullModelId: string;

    // Force certain agents to use better models for reliability
    const criticalAgents = ['qa-engineer', 'judge', 'fixer', 'e2e-fixer'];
    const shouldUpgrade = criticalAgents.includes(agentType);

    if (shouldUpgrade) {
      const topModel = configs.getTopModelFromConfig(modelConfig);
      fullModelId = topModel;
      console.log(`🚀 [ExecuteAgent] UPGRADING ${agentType} to top model for reliability: ${topModel}`);
    } else {
      fullModelId = getAgentModel(agentType, modelConfig);
    }

    const sdkModel = getModelAlias(fullModelId); // e.g., 'sonnet'

    console.log(`🤖 [ExecuteAgent] Starting ${agentType}`);
    console.log(`📁 [ExecuteAgent] Working directory: ${workspacePath}`);
    console.log(`📎 [ExecuteAgent] Attachments received: ${attachments ? attachments.length : 0}`);
    console.log(`🔧 [ExecuteAgent] Model selection for ${agentType}:`, {
      preset: taskId ? 'From task' : 'Default STANDARD_CONFIG',
      fullModelId: fullModelId,           // e.g., 'claude-sonnet-4-5-20250929'
      sdkAlias: sdkModel,                 // e.g., 'sonnet' (what gets sent to SDK)
      fromConfig: modelConfig[agentType as keyof AgentModelConfig]  // Show what config says
    });
    console.log(`🔧 [ExecuteAgent] Agent config:`, {
      agentType,
      fullModelId,
      hasAgentDef: !!agentDef,
      promptLength: prompt.length,
      workspaceExists: require('fs').existsSync(workspacePath),
    });

    // Build final prompt
    // When images are present, use generator function (required by SDK)
    let promptContent: string | AsyncGenerator;

    if (attachments && attachments.length > 0) {
      console.log(`📸 [ExecuteAgent] Building prompt with ${attachments.length} image(s) using generator`);

      const content: any[] = [
        {
          type: 'text',
          text: `${agentDef.prompt}\n\n${prompt}`
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
      // Simple string prompt when no images
      promptContent = `${agentDef.prompt}\n\n${prompt}`;
    }

    try {
      // Execute agent using SDK query() with correct API
      // https://docs.claude.com/en/api/agent-sdk/streaming-vs-single-mode

      // NO LIMIT on turns - agents need to explore codebase thoroughly
      // maxTurns = number of conversation rounds (user→assistant→tools→assistant)
      // Not "retry attempts" - it's legitimate exploration with tools

      // Let SDK manage everything - tools, turns, iterations
      console.log(`🤖 [ExecuteAgent] Starting ${agentType} agent with SDK`);

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

      // SDK query - minimal config, let SDK handle env inheritance
      console.log(`📡 [ExecuteAgent] Calling SDK query() with options:`, {
        cwd: workspacePath,
        model: sdkModel,
        fullModelId: fullModelId,
        permissionMode: 'bypassPermissions',
        hasPrompt: !!promptContent,
        apiKeySource,
      });

      let stream;
      try {
        stream = query({
          prompt: promptContent as any,
          options: {
            cwd: workspacePath,
            model: sdkModel, // Use SDK alias ('sonnet', 'haiku', 'opus'), NOT full ID
            // NO maxTurns limit - let Claude iterate freely (can handle 100k+ turns/min)
            permissionMode: 'bypassPermissions',
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey, // Use project/user-specific API key
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

      // 🔥 TIMEOUT PROTECTION: Prevent agents from hanging indefinitely
      // Max execution time: 10 minutes per agent
      const AGENT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

      // Simply collect the result - SDK handles everything
      let finalResult: any = null;
      const allMessages: any[] = [];
      let turnCount = 0;
      let lastMessageTime = Date.now();
      const MESSAGE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes without messages = stuck

      console.log(`🔄 [ExecuteAgent] Starting to consume stream messages (timeout: ${AGENT_TIMEOUT_MS / 1000}s)...`);

      // 🔥 CRITICAL: Monitor for stuck streams
      let warningIssued = false;
      const messageMonitor = setInterval(() => {
        const timeSinceLastMessage = Date.now() - lastMessageTime;

        // Issue warning at 2 minutes
        if (!warningIssued && timeSinceLastMessage > 2 * 60 * 1000) {
          console.warn(`⚠️  [ExecuteAgent] Stream slow - no messages for 2 minutes`);
          console.warn(`   Agent: ${agentType}`);
          console.warn(`   Turn count: ${turnCount}`);
          console.warn(`   Messages received: ${allMessages.length}`);
          NotificationService.emitConsoleLog(
            taskId || 'unknown',
            'warn',
            `⚠️ ${agentType} appears slow - checking for issues...`
          );
          warningIssued = true;
        }

        // Force recovery at 3 minutes
        if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
          console.error(`💀 [ExecuteAgent] Stream appears stuck - no messages for ${MESSAGE_TIMEOUT_MS / 1000}s`);
          console.error(`   Agent: ${agentType}`);
          console.error(`   Last activity: ${new Date(lastMessageTime).toISOString()}`);
          console.error(`   Turn count: ${turnCount}`);

          clearInterval(messageMonitor);

          // Throw error to trigger retry with top model
          const error = new Error(`Agent ${agentType} stream stuck - no messages for ${MESSAGE_TIMEOUT_MS / 1000}s`);
          (error as any).isTimeout = true;
          throw error;
        }
      }, 30000); // Check every 30 seconds

      try {
        // Wrap stream consumption with timeout using Promise.race
        await Promise.race([
          // Main stream processing
          (async () => {
            for await (const message of stream) {
              lastMessageTime = Date.now(); // Update last message time
              allMessages.push(message);

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
            console.log(`🔧 [${agentType}] Turn ${turnCount}: Using tool ${tool}`);

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
          })(), // End of main stream processing
          // Timeout promise
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Agent execution timeout after ${AGENT_TIMEOUT_MS / 1000}s`)),
              AGENT_TIMEOUT_MS
            )
          ),
        ]);

        // Clean up monitor on success
        clearInterval(messageMonitor);
      } catch (streamError: any) {
        // Clean up monitor on error
        clearInterval(messageMonitor);

        // Check if this is a timeout error or stuck stream
        const isTimeout = streamError.message?.includes('timeout') || streamError.message?.includes('stuck');

        console.error(`❌ [ExecuteAgent] Error consuming stream${isTimeout ? ' (TIMEOUT)' : ''}:`, {
          message: streamError.message,
          stack: streamError.stack,
          code: streamError.code,
          turnCount,
          lastMessages: allMessages.slice(-3),
          isTimeout,
        });

        // Re-throw with timeout flag for retry logic
        const error: any = new Error(streamError.message);
        error.isTimeout = isTimeout;
        error.turnCount = turnCount;
        error.agentType = agentType;
        throw error;
      }

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

      // 🔥 SECRETS DETECTION: Sanitize output before returning
      const { sanitized, warning } = SecretsDetectionService.sanitizeAgentOutput(
        agentType,
        output
      );

      if (warning) {
        console.warn(warning);
        if (taskId) {
          NotificationService.emitConsoleLog(taskId, 'warn', warning);
        }
      }

      // Calculate cost with ACTUAL pricing for Claude models (from official docs)
      // Claude 3.5 Sonnet (claude-sonnet-4-5-20250929) pricing:
      // - Input: $3 per MTok (million tokens)
      // - Output: $15 per MTok
      // Claude 3.5 Haiku (claude-haiku-4-5-20251001) pricing:
      // - Input: $1 per MTok
      // - Output: $5 per MTok
      // Claude Opus 4.1 (claude-opus-4-1-20250805) pricing:
      // - Input: $15 per MTok
      // - Output: $75 per MTok

      const inputTokens = (finalResult as any)?.usage?.input_tokens || 0;
      const outputTokens = (finalResult as any)?.usage?.output_tokens || 0;

      // Determine pricing based on actual model used
      let inputPricePerMillion = 3;   // Default to Sonnet pricing
      let outputPricePerMillion = 15;  // Default to Sonnet pricing

      // Get pricing from MODEL_PRICING based on the actual model ID
      const { MODEL_PRICING } = await import('../../config/ModelConfigurations');

      // Map SDK model to actual model name for pricing lookup
      let actualModel: string;
      if (fullModelId.includes('haiku')) {
        actualModel = 'claude-3-5-haiku-20241022';
      } else if (fullModelId.includes('opus')) {
        actualModel = 'claude-3-opus-20240229';
      } else {
        actualModel = 'claude-3-5-sonnet-20241022'; // Default
      }

      if (MODEL_PRICING[actualModel as keyof typeof MODEL_PRICING]) {
        const pricing = MODEL_PRICING[actualModel as keyof typeof MODEL_PRICING];
        inputPricePerMillion = pricing.inputPerMillion;
        outputPricePerMillion = pricing.outputPerMillion;
      }

      console.log(`   Using model: ${actualModel} (${sdkModel})`)

      // Calculate cost: price is per million tokens, so divide by 1,000,000
      const cost = (inputTokens * inputPricePerMillion / 1_000_000) + (outputTokens * outputPricePerMillion / 1_000_000);

      console.log(`💰 [ExecuteAgent] ${agentType} cost calculation:`);
      console.log(`   Input tokens: ${inputTokens} @ $${inputPricePerMillion}/MTok = $${(inputTokens * inputPricePerMillion / 1_000_000).toFixed(4)}`);
      console.log(`   Output tokens: ${outputTokens} @ $${outputPricePerMillion}/MTok = $${(outputTokens * outputPricePerMillion / 1_000_000).toFixed(4)}`);
      console.log(`   Total cost: $${cost.toFixed(4)}`);

      return {
        output: sanitized, // Use sanitized output
        usage: (finalResult as any)?.usage || {},
        cost: cost,
        stopReason: (finalResult as any)?.stop_reason,
        sessionId: sessionId,
        canResume: false,
        rawResult: finalResult,
        allMessages,
      };
    } catch (error: any) {
      console.error(`❌ [ExecuteAgent] ${agentType} failed:`, error.message);
      console.error(`❌ [ExecuteAgent] Error type:`, error.constructor.name);
      console.error(`❌ [ExecuteAgent] Error code:`, error.code);
      console.error(`❌ [ExecuteAgent] Exit code:`, error.exitCode);
      console.error(`❌ [ExecuteAgent] Signal:`, error.signal);
      console.error(`❌ [ExecuteAgent] Full error object:`, JSON.stringify(error, null, 2));
      console.error(`❌ [ExecuteAgent] Stack:`, error.stack);

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
    epicBranchName?: string // Epic branch name from TeamOrchestrationPhase
  ): Promise<{ output?: string; cost?: number } | void> {
    const taskId = (task._id as any).toString();

    // Get all stories for this developer
    if (!stories || stories.length === 0) {
      console.warn(`⚠️  [Developer ${member.instanceId}] No stories provided, skipping`);
      return;
    }

    // Get epics from EventStore or fallback to techLead
    const epicsList = epics || (task.orchestration.techLead as any)?.epics || [];
    if (epicsList.length === 0) {
      console.error(`❌ [Developer ${member.instanceId}] No epics available (EventStore or TechLead)`);
      throw new Error('No epics available - cannot determine target repositories');
    }

    const assignedStories = member.assignedStories || [];

    console.log(`👨‍💻 [Developer ${member.instanceId}] Starting work on ${assignedStories.length} stories`);

    // 🔥 IMPORTANT: When called from isolated story pipeline, only process ONE story
    // assignedStories will contain exactly 1 story ID
    let lastResult: { output?: string; cost?: number } | undefined;

    for (const storyId of assignedStories) {
      const story = stories.find((s: any) => s.id === storyId);
      if (!story) {
        console.warn(`⚠️  [Developer ${member.instanceId}] Story ${storyId} not found, skipping`);
        continue;
      }

      console.log(`📝 [Developer ${member.instanceId}] Working on story: ${story.title}`);

      // 🔥 CRITICAL FIX: Get epic to find target repository (use EventStore epics)
      const epic = epicsList.find((e: any) => e.id === story.epicId);
      if (!epic) {
        console.error(`❌ [Developer ${member.instanceId}] Epic ${story.epicId} not found for story ${storyId}`);
        throw new Error(`Epic ${story.epicId} not found - cannot determine target repository`);
      }

      // Get target repository from epic
      // Priority: epic.targetRepository > first repo's githubRepoName > first repo's name
      const targetRepository = epic.targetRepository || repositories[0]?.githubRepoName || repositories[0]?.name;
      if (!targetRepository) {
        console.error(`❌ [Developer ${member.instanceId}] No target repository defined for epic ${epic.id}`);
        throw new Error(`Epic ${epic.id} has no targetRepository - cannot execute developer`);
      }

      // 🔥 CRITICAL FIX: Extract repo name from full path (e.g., "devwspito/v2_frontend" → "v2_frontend")
      // Git clones repos with just the repo name, not the full owner/repo path
      const repoName = targetRepository.includes('/')
        ? targetRepository.split('/').pop()
        : targetRepository;

      console.log(`📂 [Developer ${member.instanceId}] Target repository: ${targetRepository}`);
      console.log(`📂 [Developer ${member.instanceId}] Repository directory: ${repoName}`);
      console.log(`📂 [Developer ${member.instanceId}] Workspace: ${workspacePath}`);

      // Build developer prompt - Rich context per SDK philosophy
      let prompt = `# Story: ${story.title}

${story.description}

## 🎯 TARGET REPOSITORY: ${targetRepository}
**CRITICAL**: You MUST work ONLY in the "${targetRepository}" directory.
- All file paths must start with: ${targetRepository}/
- Navigate to this repository first: cd ${workspacePath}/${targetRepository}
- DO NOT modify files in other repositories`;

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
5. NO documentation, NO explanations - JUST FIX THE CODE

**This is a RETRY attempt. Focus on fixing what was rejected.**
`;
      }

      // Prefix all file paths with repository name
      const prefixPath = (f: string) => `${targetRepository}/${f}`;

      // Generate branch name for this story (flat naming to avoid git ref conflicts)
      // Git doesn't allow both 'epic/epic-1' and 'epic/epic-1/story-1' to exist
      // 🔥 UNIQUE BRANCH NAMING: Include taskId + timestamp + random suffix to prevent ANY conflicts
      const taskShortId = taskId.slice(-8); // Last 8 chars of taskId
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const storySlug = story.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(); // Sanitize story id
      const branchName = `story/${taskShortId}-${storySlug}-${timestamp}-${randomSuffix}`;

      // 1️⃣ Create feature branch for this story BEFORE developer starts
      console.log(`\n🌿 [Developer ${member.instanceId}] Creating story branch: ${branchName}`);

      try {
        const { execSync } = require('child_process');
        const repoPath = `${workspacePath}/${repoName}`;

        // First, ensure we're on the epic base branch WITH LATEST CHANGES
        // 🔥 CRITICAL FIX: Use the actual epic branch name from TeamOrchestrationPhase
        // Epic branch names are unique with timestamp (e.g., epic/358cdca9-epic-1-1761118801698-l5tvun)
        const epicBranch = epicBranchName || epic.branchName || `epic/${epic.id}`;
        console.log(`📂 [Developer ${member.instanceId}] Epic branch to use: ${epicBranch}`);

        try {
          execSync(`cd "${repoPath}" && git checkout ${epicBranch}`, { encoding: 'utf8' });
          console.log(`✅ [Developer ${member.instanceId}] Checked out epic branch: ${epicBranch}`);

          // 🔥 CRITICAL: Pull latest changes from epic branch
          // This ensures story branches include changes from previously merged stories
          try {
            // Add timeout to prevent hanging on git pull
            execSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, {
              encoding: 'utf8',
              timeout: 30000, // 30 seconds timeout
              killSignal: 'SIGKILL'
            });
            console.log(`✅ [Developer ${member.instanceId}] Pulled latest changes from ${epicBranch}`);
            console.log(`   Story will include all previously merged stories`);
          } catch (pullError: any) {
            // Pull might fail if branch doesn't exist remotely yet (first story in epic)
            // Or if timeout is exceeded
            if (pullError.signal === 'SIGKILL' || pullError.code === 'ETIMEDOUT') {
              console.warn(`⏰ [Developer ${member.instanceId}] Git pull timed out after 30s - likely branch doesn't exist on remote`);
            } else {
              console.warn(`⚠️  [Developer ${member.instanceId}] Pull failed (branch might not be on remote yet): ${pullError.message}`);
            }
            // Continue anyway - the branch might not exist remotely yet
          }
        } catch (epicCheckoutError) {
          console.warn(`⚠️  [Developer ${member.instanceId}] Epic branch ${epicBranch} doesn't exist, using current branch`);
        }

        // Create story branch from epic branch
        try {
          execSync(`cd "${repoPath}" && git checkout -b ${branchName}`, { encoding: 'utf8' });
          console.log(`✅ [Developer ${member.instanceId}] Created story branch: ${branchName}`);
        } catch (branchError: any) {
          // Branch might already exist
          if (branchError.message.includes('already exists')) {
            execSync(`cd "${repoPath}" && git checkout ${branchName}`, { encoding: 'utf8' });
            console.log(`✅ [Developer ${member.instanceId}] Checked out existing branch: ${branchName}`);
          } else {
            throw branchError;
          }
        }

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🌿 Developer ${member.instanceId}: Working on branch ${branchName}`
        );
      } catch (gitError: any) {
        console.error(`❌ [Developer ${member.instanceId}] Failed to create branch: ${gitError.message}`);
        throw new Error(`Git branch creation failed: ${gitError.message}`);
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

## Your task:
${judgeFeedback ? 'Fix the code based on Judge feedback above.' : 'Implement this story completely with production-ready code. Work iteratively - read, edit, verify, repeat.'}

## 🚨 MANDATORY: Git workflow (MUST DO):
⚠️ **You are already on branch: ${branchName}** (branch was created for you)

After writing code, you MUST:
1. cd ${targetRepository}
2. git add .
3. git commit -m "Implement: ${story.title}"
4. git push origin ${branchName}

**CRITICAL: You MUST commit and push your code. Judge will review your branch.**`;

      // 🔥 DEBUG: Log if attachments are being passed
      if (attachments && attachments.length > 0) {
        console.log(`📎 [Developer ${member.instanceId}] Passing ${attachments.length} attachment(s) to agent SDK`);
      } else {
        console.log(`⚠️  [Developer ${member.instanceId}] NO attachments to pass (attachments: ${JSON.stringify(attachments)})`);
      }

      try {
        // Execute developer agent - SDK uses workspace root
        const result = await this.executeAgent(
          'developer',
          prompt,
          workspacePath, // Let SDK access workspace root
          taskId,
          `Developer ${member.instanceId}`,
          undefined, // sessionId
          undefined, // fork
          attachments // Pass images for visual context
        );

        console.log(`✅ [Developer ${member.instanceId}] Completed story: ${story.title}`);
        console.log(`📊 [Developer ${member.instanceId}] Cost: $${result.cost?.toFixed(4) || 0}`);

        // Store result for return (isolated pipeline uses single-story execution)
        lastResult = { output: result.output, cost: result.cost };

        // 2️⃣ Verify that code was pushed to the story branch
        console.log(`\n🔍 [Developer ${member.instanceId}] Verifying git push to branch ${branchName}...`);

        try {
          const { execSync } = require('child_process');
          const repoPath = `${workspacePath}/${repoName}`;

          // 🔥 CRITICAL: Add timeout to prevent hanging on git ls-remote
          // This command can hang waiting for credentials or network issues
          const GIT_TIMEOUT_MS = 10000; // 10 seconds max for git operations

          // Check if branch exists on remote WITH TIMEOUT
          const remoteBranches = execSync(
            `cd "${repoPath}" && timeout 10 git ls-remote --heads origin ${branchName} 2>/dev/null || echo ""`,
            {
              encoding: 'utf8',
              timeout: GIT_TIMEOUT_MS
            }
          );

          if (remoteBranches.includes(branchName)) {
            console.log(`✅ [Developer ${member.instanceId}] Branch ${branchName} found on remote`);

            // Check if there are commits (also with timeout)
            try {
              const commitCount = execSync(
                `cd "${repoPath}" && timeout 5 git rev-list --count ${branchName} 2>/dev/null || echo "0"`,
                {
                  encoding: 'utf8',
                  timeout: 5000
                }
              ).trim();
              console.log(`✅ [Developer ${member.instanceId}] Branch has ${commitCount} commit(s)`);
            } catch (e) {
              console.log(`⚠️  [Developer ${member.instanceId}] Could not count commits (timeout or error)`);
            }

            NotificationService.emitConsoleLog(
              taskId,
              'info',
              `✅ Developer ${member.instanceId}: Code pushed successfully to ${branchName}`
            );
          } else {
            console.warn(`⚠️  [Developer ${member.instanceId}] Branch ${branchName} NOT found on remote - developer may have skipped git push or verification timed out`);
            NotificationService.emitConsoleLog(
              taskId,
              'warn',
              `⚠️  Developer ${member.instanceId}: Branch ${branchName} not pushed to remote (or verification timed out)`
            );
          }
        } catch (verifyError: any) {
          // If timeout or other error, log but don't fail
          console.warn(`⚠️  [Developer ${member.instanceId}] Could not verify git push (timeout after 10s or error): ${verifyError.message}`);
          console.warn(`⚠️  [Developer ${member.instanceId}] Continuing anyway - push verification is non-critical`);
        }

        // 🔥 CRITICAL DEBUG: Show EXACTLY what code Developer wrote
        console.log(`\n${'='.repeat(80)}`);
        console.log(`📝 DEVELOPER ${member.instanceId} - CODE CHANGES VERIFICATION`);
        console.log(`${'='.repeat(80)}`);

        try {
          const { execSync } = require('child_process');
          const repoPath = `${workspacePath}/${repoName}`;

          // 🔥 IMPORTANT: Developer already committed, so we need to see the LAST commit
          // git diff would be empty because changes are already committed
          // Use git show HEAD to see what was in the last commit

          // Show files that were modified in last commit
          const modifiedFiles = execSync(`cd "${repoPath}" && git show --name-only --pretty=format: HEAD`, { encoding: 'utf8' });
          console.log(`\n📂 Modified files in last commit:\n${modifiedFiles || '(no files modified)'}`);

          // Show actual code changes in last commit (full diff)
          const diffOutput = execSync(`cd "${repoPath}" && git show HEAD`, { encoding: 'utf8' });
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

        console.log(`🌿 [Developer ${member.instanceId}] Story branch saved: ${branchName}`);

        // 🔥 EVENT SOURCING: Update story with branch name
        const { eventStore } = await import('../EventStore');
        await eventStore.append({
          taskId: task._id as any,
          eventType: 'StoryBranchCreated',
          agentName: 'developer',
          payload: {
            storyId: story.id,
            branchName: branchName,
            developerId: member.instanceId,
          },
        });

        console.log(`📝 [EventStore] StoryBranchCreated event emitted for ${branchName}`);

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

    // Calculate REAL total cost by summing all agent costs
    const realTotalCost = breakdown.reduce((sum, item) => sum + item.cost, 0);
    const realTotalTokens = totalInputTokens + totalOutputTokens;

    // Update task with REAL totals
    task.orchestration.totalCost = realTotalCost;
    task.orchestration.totalTokens = realTotalTokens;
    await task.save();

    // Emit orchestration completed with detailed cost summary
    NotificationService.emitOrchestrationCompleted((task._id as any).toString(), {
      totalCost: realTotalCost,
      totalTokens: realTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      cacheCreationTokens: cacheCreationTokens > 0 ? cacheCreationTokens : undefined,
      cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
      breakdown,
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log(`✅ Orchestration completed successfully!`);
    console.log(`💰 Total Cost: $${realTotalCost.toFixed(4)}`);
    console.log(`🎯 Total Tokens: ${realTotalTokens.toLocaleString()}`);
    console.log(`📊 Cost Breakdown:`);
    breakdown.forEach(item => {
      console.log(`   - ${item.phase}: $${item.cost.toFixed(4)}`);
    });
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
