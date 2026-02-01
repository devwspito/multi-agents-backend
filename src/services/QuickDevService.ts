/**
 * QuickDevService
 *
 * Lightweight service for executing quick developer tasks in the Lite Team feature.
 * This runs OUTSIDE the orchestrator - no epic/story structure required.
 *
 * Flow:
 * 1. User types task in IDE tab (e.g., "connect auth with app.dart")
 * 2. This service builds a minimal prompt
 * 3. Calls Agent SDK directly (via AgentExecutorService)
 * 4. Agent executes code changes (NO commit/push - user does manually)
 * 5. Output streams to frontend via WebSocket
 *
 * Features:
 * - Execution persistence for retry/resume
 * - Session tracking for SDK resume capability
 * - Full execution history per task
 */

import { AgentExecutorService } from './orchestration/AgentExecutorService.js';
import { NotificationService } from './NotificationService.js';
import { eventStore } from './EventStore.js';
import { sandboxService } from './SandboxService.js';
import { buildPromptForMode, buildQuickJudgePrompt } from './QuickDevPromptBuilder.js';
import { safeGitExec } from '../utils/safeGitExecution.js';
import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { QuickTaskExecutionRepository, IQuickTaskExecution } from '../database/repositories/QuickTaskExecutionRepository.js';
import { autoRebuildService } from './AutoRebuildService.js';

export interface QuickTaskParams {
  taskId: string;
  command: string;           // User's task description
  enableJudge?: boolean;     // Optional: run Judge after dev completes
  commitMessage?: string;    // Optional: custom commit message
  model?: 'opus' | 'sonnet' | 'haiku';  // Optional: model selection (default: sonnet)
  mode?: 'code' | 'explore' | 'ask' | 'plan';  // Execution mode (default: code)
}

export interface QuickTaskResult {
  success: boolean;
  output: string;
  filesModified: string[];
  filesCreated: string[];
  commitSha?: string;
  cost: number;
  duration: number;
  judgeResult?: {
    approved: boolean;
    feedback: string;
  };
  error?: string;
  // New fields for retry/resume
  executionId: string;
  toolsUsed: string[];
  turnsCompleted: number;
  canResume: boolean;
}

export class QuickDevService {
  private static instance: QuickDevService;
  private agentExecutor: AgentExecutorService;

  private constructor() {
    this.agentExecutor = AgentExecutorService.getInstance();
  }

  public static getInstance(): QuickDevService {
    if (!QuickDevService.instance) {
      QuickDevService.instance = new QuickDevService();
    }
    return QuickDevService.instance;
  }

  /**
   * Execute a quick developer task
   *
   * This method:
   * 1. Creates execution record in database
   * 2. Gets workspace context from EventStore
   * 3. Builds a minimal prompt
   * 4. Executes the developer agent
   * 5. Stores session for resume capability
   * 6. Optionally runs Judge review
   * 7. Streams output via WebSocket
   */
  async executeQuickTask(params: QuickTaskParams): Promise<QuickTaskResult> {
    const { taskId, command, enableJudge, model = 'sonnet', mode = 'code' } = params;
    const startTime = Date.now();

    console.log(`[QuickDev] Starting quick task for ${taskId}: "${command}" | Mode: ${mode}`);

    // 1. Get workspace context FIRST (needed for execution record)
    const context = await this.getWorkspaceContext(taskId);
    if (!context) {
      throw new Error('No workspace found for this task. Make sure sandbox is running.');
    }

    // 2. Create execution record in database
    const execution = QuickTaskExecutionRepository.create({
      taskId,
      command,
      mode,
      model,
      workspacePath: context.workspacePath,
      sandboxId: context.sandboxId,
    });

    console.log(`[QuickDev] Created execution record: ${execution.id}`);

    // Emit start notification
    NotificationService.emitNotification(taskId, 'quick_task_started', {
      executionId: execution.id,
      command,
      mode,
      timestamp: new Date().toISOString(),
    });

    try {
      console.log(`[QuickDev] Workspace: ${context.workspacePath}, Sandbox: ${context.sandboxId}`);

      // 3. Get file list from workspace
      const fileList = await this.getWorkspaceFileList(taskId, context.workspacePath);

      // 4. Get current branch
      const currentBranch = await this.getCurrentBranch(context.repoPath || context.workspacePath);

      // 5. Build prompt based on mode
      const prompt = buildPromptForMode({
        command,
        workspacePath: context.workspacePath,
        repoPath: context.repoPath,
        fileList,
        currentBranch,
        targetRepository: context.targetRepository,
        mode,
      });

      // Map mode to agent type and name
      const agentConfig = this.getAgentConfigForMode(mode);
      console.log(`[QuickDev] Executing ${agentConfig.name} with model: ${model}`);

      // 6. Execute agent based on mode
      const devResult = await this.agentExecutor.executeAgent(
        agentConfig.type,               // agentType (varies by mode)
        prompt,                         // prompt
        context.repoPath || context.workspacePath,  // workspacePath
        taskId,                         // taskId
        agentConfig.name,               // agentName (varies by mode)
        undefined,                      // sessionId (new execution)
        false,                          // fork
        undefined,                      // attachments
        {
          timeout: 10 * 60 * 1000,      // 10 min max
          sandboxId: context.sandboxId, // For sandbox_bash
          model,                        // 🎯 User-selected model
        },
        undefined,                      // contextOverride
        false,                          // skipOptimization
        'bypassPermissions',            // permissionMode - trust the agent
      );

      console.log(`[QuickDev] ${agentConfig.name} completed. Output length: ${devResult.output.length}`);

      // 7. Update execution with session info for resume capability
      if (devResult.sessionId) {
        QuickTaskExecutionRepository.updateProgress(execution.id, {
          sdkSessionId: devResult.sessionId,
          lastMessageUuid: devResult.lastMessageUuid,
          canResume: true,
          turnsCompleted: devResult.turnsCompleted || 0,
          filesModified: devResult.filesModified,
          filesCreated: devResult.filesCreated,
          toolsUsed: devResult.toolsUsed || [],
          cost: devResult.cost || 0,
        });
      }

      // 8. Extract commit SHA if present (only relevant for code mode)
      const commitSha = mode === 'code' ? this.extractCommitSha(devResult.output) : undefined;

      // 9. Check for success marker based on mode
      const devSuccess = this.checkSuccessMarker(devResult.output, mode);

      // 9.5. 🔥 Auto-rebuild for code mode (Team-Lite needs this!)
      // Only trigger if files were modified and task succeeded
      if (mode === 'code' && devSuccess) {
        const allChangedFiles = [...devResult.filesModified, ...devResult.filesCreated];
        if (allChangedFiles.length > 0) {
          console.log(`[QuickDev] Triggering auto-rebuild for ${allChangedFiles.length} changed files...`);
          try {
            await autoRebuildService.triggerRebuildForChangedFiles(taskId, allChangedFiles);
          } catch (rebuildError: any) {
            console.warn(`[QuickDev] Auto-rebuild error (non-fatal): ${rebuildError.message}`);
            // Don't fail the task for rebuild errors
          }
        }
      }

      // 10. Optional: Run Judge review
      let judgeResult: QuickTaskResult['judgeResult'] | undefined;
      if (enableJudge && devSuccess) {
        judgeResult = await this.runQuickJudge(
          taskId,
          command,
          devResult.filesModified.concat(devResult.filesCreated),
          context.repoPath || context.workspacePath,
          context.sandboxId
        );
      }

      // 11. Calculate duration and cost
      const duration = Date.now() - startTime;
      const cost = devResult.cost || 0;

      // 12. Mark execution as completed
      QuickTaskExecutionRepository.markCompleted(execution.id, {
        output: devResult.output,
        filesModified: devResult.filesModified,
        filesCreated: devResult.filesCreated,
        toolsUsed: devResult.toolsUsed || [],
        turnsCompleted: devResult.turnsCompleted || 0,
        cost,
        duration,
        judgeApproved: judgeResult?.approved,
        judgeFeedback: judgeResult?.feedback,
      });

      // 13. Emit completion notification (include output for UI display)
      NotificationService.emitNotification(taskId, 'quick_task_completed', {
        executionId: execution.id,
        success: devSuccess,
        command,
        mode,
        output: devResult.output,  // 🎯 The agent's result - needed by frontend
        filesModified: devResult.filesModified,
        filesCreated: devResult.filesCreated,
        toolsUsed: devResult.toolsUsed || [],
        turnsCompleted: devResult.turnsCompleted || 0,
        commitSha,
        cost,
        duration,
        judgeApproved: judgeResult?.approved,
        canResume: !!devResult.sessionId,
        timestamp: new Date().toISOString(),
      });

      console.log(`[QuickDev] Task completed in ${duration}ms, cost: $${cost.toFixed(4)}`);

      return {
        success: devSuccess,
        output: devResult.output,
        filesModified: devResult.filesModified,
        filesCreated: devResult.filesCreated,
        commitSha,
        cost,
        duration,
        judgeResult,
        executionId: execution.id,
        toolsUsed: devResult.toolsUsed || [],
        turnsCompleted: devResult.turnsCompleted || 0,
        canResume: !!devResult.sessionId,
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[QuickDev] Error:`, error);

      // Mark execution as failed with error info
      QuickTaskExecutionRepository.markFailed(execution.id, {
        error: error.message,
        errorStack: error.stack,
        duration,
        canResume: false,
      });

      // Emit failure notification
      NotificationService.emitNotification(taskId, 'quick_task_failed', {
        executionId: execution.id,
        command,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        output: '',
        filesModified: [],
        filesCreated: [],
        cost: 0,
        duration,
        error: error.message,
        executionId: execution.id,
        toolsUsed: [],
        turnsCompleted: 0,
        canResume: false,
      };
    }
  }

  /**
   * Retry a failed quick task
   *
   * Creates a NEW execution with the same command from a failed execution.
   * Does NOT resume the SDK session - starts fresh.
   */
  async retryQuickTask(taskId: string, executionId?: string): Promise<QuickTaskResult> {
    console.log(`[QuickDev] Retrying task ${taskId}${executionId ? ` (execution: ${executionId})` : ''}`);

    // Find the execution to retry
    let execution: IQuickTaskExecution | null = null;

    if (executionId) {
      execution = QuickTaskExecutionRepository.findById(executionId);
    } else {
      // Find the latest failed execution for this task
      execution = QuickTaskExecutionRepository.findFailedByTaskId(taskId);
    }

    if (!execution) {
      throw new Error(`No failed execution found for task ${taskId}${executionId ? ` (execution: ${executionId})` : ''}`);
    }

    console.log(`[QuickDev] Retrying execution ${execution.id}: "${execution.command}"`);

    // Execute a new task with the same parameters
    return this.executeQuickTask({
      taskId: execution.taskId,
      command: execution.command,
      mode: execution.mode,
      model: execution.model,
    });
  }

  /**
   * Resume a paused quick task
   *
   * Resumes the SDK session from where it left off.
   * Requires the execution to have a valid sdkSessionId.
   */
  async resumeQuickTask(taskId: string, executionId?: string, additionalPrompt?: string): Promise<QuickTaskResult> {
    console.log(`[QuickDev] Resuming task ${taskId}${executionId ? ` (execution: ${executionId})` : ''}`);

    // Find the execution to resume
    let execution: IQuickTaskExecution | null = null;

    if (executionId) {
      execution = QuickTaskExecutionRepository.findById(executionId);
    } else {
      // Find the latest resumable execution for this task
      execution = QuickTaskExecutionRepository.findResumableByTaskId(taskId);
    }

    if (!execution) {
      throw new Error(`No resumable execution found for task ${taskId}`);
    }

    if (!execution.sdkSessionId) {
      throw new Error(`Execution ${execution.id} does not have a session ID - cannot resume`);
    }

    if (!execution.canResume) {
      throw new Error(`Execution ${execution.id} is not resumable`);
    }

    console.log(`[QuickDev] Resuming execution ${execution.id} with session ${execution.sdkSessionId}`);

    const startTime = Date.now();

    // Emit resume notification
    NotificationService.emitNotification(taskId, 'quick_task_resumed', {
      executionId: execution.id,
      command: execution.command,
      mode: execution.mode,
      timestamp: new Date().toISOString(),
    });

    try {
      // Get workspace context
      const context = await this.getWorkspaceContext(taskId);
      if (!context) {
        throw new Error('No workspace found for this task. Make sure sandbox is running.');
      }

      // Build resume prompt
      const resumePrompt = additionalPrompt || 'Please continue from where you left off.';

      const agentConfig = this.getAgentConfigForMode(execution.mode);

      // Execute agent with existing session ID to resume
      const devResult = await this.agentExecutor.executeAgent(
        agentConfig.type,
        resumePrompt,
        context.repoPath || context.workspacePath,
        taskId,
        agentConfig.name,
        execution.sdkSessionId,          // 🎯 Resume with existing session
        false,
        undefined,
        {
          timeout: 10 * 60 * 1000,
          sandboxId: context.sandboxId,
          model: execution.model,
        },
        undefined,
        false,
        'bypassPermissions',
      );

      // Update execution with new progress
      const updatedFilesModified = [...new Set([...execution.filesModified, ...devResult.filesModified])];
      const updatedFilesCreated = [...new Set([...execution.filesCreated, ...devResult.filesCreated])];
      const updatedToolsUsed = [...new Set([...(execution.toolsUsed || []), ...(devResult.toolsUsed || [])])];

      const duration = Date.now() - startTime + execution.duration;
      const cost = (execution.cost || 0) + (devResult.cost || 0);
      const turnsCompleted = (execution.turnsCompleted || 0) + (devResult.turnsCompleted || 0);

      const devSuccess = this.checkSuccessMarker(devResult.output, execution.mode);

      // Mark as completed or update progress
      if (devSuccess) {
        QuickTaskExecutionRepository.markCompleted(execution.id, {
          output: devResult.output,
          filesModified: updatedFilesModified,
          filesCreated: updatedFilesCreated,
          toolsUsed: updatedToolsUsed,
          turnsCompleted,
          cost,
          duration,
        });
      } else {
        QuickTaskExecutionRepository.updateProgress(execution.id, {
          sdkSessionId: devResult.sessionId || execution.sdkSessionId,
          lastMessageUuid: devResult.lastMessageUuid,
          canResume: !!devResult.sessionId,
          turnsCompleted,
          filesModified: updatedFilesModified,
          filesCreated: updatedFilesCreated,
          toolsUsed: updatedToolsUsed,
          cost,
        });
      }

      // Emit completion notification
      NotificationService.emitNotification(taskId, 'quick_task_completed', {
        executionId: execution.id,
        success: devSuccess,
        command: execution.command,
        mode: execution.mode,
        output: devResult.output,
        filesModified: updatedFilesModified,
        filesCreated: updatedFilesCreated,
        toolsUsed: updatedToolsUsed,
        turnsCompleted,
        cost,
        duration,
        canResume: !!devResult.sessionId,
        resumed: true,
        timestamp: new Date().toISOString(),
      });

      console.log(`[QuickDev] Resume completed in ${Date.now() - startTime}ms`);

      return {
        success: devSuccess,
        output: devResult.output,
        filesModified: updatedFilesModified,
        filesCreated: updatedFilesCreated,
        cost,
        duration,
        executionId: execution.id,
        toolsUsed: updatedToolsUsed,
        turnsCompleted,
        canResume: !!devResult.sessionId,
      };

    } catch (error: any) {
      const duration = Date.now() - startTime + execution.duration;
      console.error(`[QuickDev] Resume error:`, error);

      // Mark as failed
      QuickTaskExecutionRepository.markFailed(execution.id, {
        error: error.message,
        errorStack: error.stack,
        duration,
        sdkSessionId: execution.sdkSessionId,
        canResume: true, // May still be resumable
      });

      // Emit failure notification
      NotificationService.emitNotification(taskId, 'quick_task_failed', {
        executionId: execution.id,
        command: execution.command,
        error: error.message,
        duration,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        output: '',
        filesModified: execution.filesModified,
        filesCreated: execution.filesCreated,
        cost: execution.cost,
        duration,
        error: error.message,
        executionId: execution.id,
        toolsUsed: execution.toolsUsed,
        turnsCompleted: execution.turnsCompleted,
        canResume: true,
      };
    }
  }

  /**
   * Get execution history for a task
   */
  getExecutionHistory(taskId: string, limit: number = 20): IQuickTaskExecution[] {
    return QuickTaskExecutionRepository.findByTaskId(taskId, limit);
  }

  /**
   * Get the latest execution for a task
   */
  getLatestExecution(taskId: string): IQuickTaskExecution | null {
    return QuickTaskExecutionRepository.findLatestByTaskId(taskId);
  }

  /**
   * Get a specific execution by ID
   */
  getExecution(executionId: string): IQuickTaskExecution | null {
    return QuickTaskExecutionRepository.findById(executionId);
  }

  /**
   * Get execution statistics for a task
   */
  getExecutionStats(taskId: string) {
    return QuickTaskExecutionRepository.getStats(taskId);
  }

  /**
   * Get workspace context from Task, EventStore, and SandboxService
   *
   * Priority (same as orchestrator):
   * 1. Task.orchestration.workspacePath (set by orchestrator - AUTHORITATIVE)
   * 2. EventStore workspaces (has full workspace info)
   * 3. SandboxService (has workspacePath from running container)
   */
  private async getWorkspaceContext(taskId: string): Promise<{
    workspacePath: string;
    repoPath?: string;
    targetRepository?: string;
    sandboxId?: string;
  } | null> {
    try {
      // Get sandbox info - we need this regardless
      let sandbox = sandboxService.getSandbox(taskId);

      // If no direct sandbox, try to find setup sandbox (taskId-setup-*)
      if (!sandbox) {
        const found = sandboxService.findSandboxForTask(taskId);
        if (found?.instance) {
          sandbox = found.instance;
        }
      }

      // 1️⃣ PRIORITY: Task orchestration.workspacePath (set by orchestrator)
      try {
        const task = TaskRepository.findById(taskId);
        if (task?.orchestration?.workspacePath) {
          console.log(`[QuickDev] Using task.orchestration.workspacePath: ${task.orchestration.workspacePath}`);
          return {
            workspacePath: task.orchestration.workspacePath,
            repoPath: task.orchestration.workspacePath,
            sandboxId: sandbox?.containerId,
          };
        }
      } catch (e) {
        console.warn(`[QuickDev] Could not get task from repository:`, e);
      }

      // 2️⃣ FALLBACK: EventStore workspaces
      const state = await eventStore.getCurrentState(taskId);
      const workspace = state.workspaces?.[0];

      if (workspace) {
        console.log(`[QuickDev] Using EventStore workspace: ${workspace.workspacePath}`);
        return {
          workspacePath: workspace.workspacePath,
          repoPath: workspace.repoLocalPath,
          targetRepository: workspace.targetRepository,
          sandboxId: sandbox?.containerId,
        };
      }

      // 3️⃣ LAST RESORT: SandboxService (for standalone sandboxes)
      if (sandbox && sandbox.status === 'running') {
        console.log(`[QuickDev] Using SandboxService.workspacePath: ${sandbox.workspacePath}`);

        // The workspacePath in sandbox is the HOST path
        // The workDir is the CONTAINER path (usually /workspace)
        const containerWorkDir = sandbox.config?.workDir || '/workspace';

        return {
          workspacePath: containerWorkDir,  // Use container path for agent
          repoPath: sandbox.workspacePath,  // Host path for git operations
          sandboxId: sandbox.containerId,
        };
      }

      console.warn(`[QuickDev] No workspace found in Task, EventStore, or SandboxService for task ${taskId}`);
      return null;
    } catch (error) {
      console.error(`[QuickDev] Error getting workspace context:`, error);
      return null;
    }
  }

  /**
   * Get file list from workspace using sandbox exec
   */
  private async getWorkspaceFileList(taskId: string, _workspacePath: string): Promise<string> {
    try {
      // Try to use sandbox exec (command is a string, options is separate)
      const findCommand = `find /workspace -type f \\( -name "*.dart" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.vue" -o -name "*.py" -o -name "*.css" -o -name "*.html" -o -name "*.json" -o -name "*.yaml" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/build/*" -not -path "*/.dart_tool/*" 2>/dev/null | head -100`;

      const result = await sandboxService.exec(taskId, findCommand, { timeout: 10000 });

      if (result.exitCode === 0 && result.stdout) {
        return result.stdout;
      }

      return '(could not list files)';
    } catch (error) {
      console.warn(`[QuickDev] Error listing files:`, error);
      return '(could not list files)';
    }
  }

  /**
   * Get current git branch
   */
  private async getCurrentBranch(workspacePath: string): Promise<string> {
    try {
      const result = await safeGitExec('git branch --show-current', { cwd: workspacePath });
      return result.stdout?.trim() || 'main';
    } catch (error) {
      return 'main';
    }
  }

  /**
   * Extract commit SHA from agent output
   */
  private extractCommitSha(output: string): string | undefined {
    // Look for patterns like "Commit SHA: abc1234" or "[abc1234]"
    const patterns = [
      /Commit SHA:\s*([a-f0-9]{7,40})/i,
      /committed.*\[([a-f0-9]{7,40})\]/i,
      /push.*([a-f0-9]{7,40})/i,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return undefined;
  }

  /**
   * Get agent configuration based on execution mode
   */
  private getAgentConfigForMode(mode: string): { type: string; name: string } {
    switch (mode) {
      case 'explore':
        return { type: 'explorer', name: 'Quick Explorer' };
      case 'ask':
        return { type: 'assistant', name: 'Quick Assistant' };
      case 'plan':
        return { type: 'planner', name: 'Quick Planner' };
      case 'code':
      default:
        return { type: 'developer', name: 'Quick Dev' };
    }
  }

  /**
   * Check for success marker based on mode
   */
  private checkSuccessMarker(output: string, mode: string): boolean {
    switch (mode) {
      case 'explore':
        return output.includes('EXPLORE_COMPLETED');
      case 'ask':
        return output.includes('ASK_COMPLETED');
      case 'plan':
        return output.includes('PLAN_COMPLETED');
      case 'code':
      default:
        return output.includes('DEVELOPER_FINISHED_SUCCESSFULLY');
    }
  }

  /**
   * Run quick Judge review (optional)
   */
  private async runQuickJudge(
    taskId: string,
    taskDescription: string,
    changedFiles: string[],
    workspacePath: string,
    sandboxId?: string
  ): Promise<{ approved: boolean; feedback: string }> {
    console.log(`[QuickDev] Running Judge review...`);

    try {
      const prompt = buildQuickJudgePrompt({
        taskDescription,
        changedFiles,
        workspacePath,
      });

      const judgeResult = await this.agentExecutor.executeAgent(
        'judge',
        prompt,
        workspacePath,
        taskId,
        'Quick Judge',
        undefined,
        false,
        undefined,
        {
          timeout: 5 * 60 * 1000, // 5 min max
          sandboxId,
        },
        undefined,
        false,
        'bypassPermissions',
      );

      const approved = judgeResult.output.includes('JUDGE_APPROVED');
      const feedback = judgeResult.output;

      console.log(`[QuickDev] Judge ${approved ? 'approved' : 'rejected'}`);

      return { approved, feedback };
    } catch (error: any) {
      console.error(`[QuickDev] Judge error:`, error);
      return { approved: false, feedback: `Judge error: ${error.message}` };
    }
  }
}

// Export singleton instance
export const quickDevService = QuickDevService.getInstance();
