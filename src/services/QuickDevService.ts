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
 * 4. Agent executes, commits, and pushes
 * 5. Output streams to frontend via WebSocket
 */

import { AgentExecutorService } from './orchestration/AgentExecutorService';
import { NotificationService } from './NotificationService';
import { eventStore } from './EventStore';
import { sandboxService } from './SandboxService';
import { buildQuickDevPrompt, buildQuickJudgePrompt } from './QuickDevPromptBuilder';
import { safeGitExec } from '../utils/safeGitExecution';

export interface QuickTaskParams {
  taskId: string;
  command: string;           // User's task description
  enableJudge?: boolean;     // Optional: run Judge after dev completes
  commitMessage?: string;    // Optional: custom commit message
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
   * 1. Gets workspace context from EventStore
   * 2. Builds a minimal prompt
   * 3. Executes the developer agent
   * 4. Optionally runs Judge review
   * 5. Streams output via WebSocket
   */
  async executeQuickTask(params: QuickTaskParams): Promise<QuickTaskResult> {
    const { taskId, command, enableJudge } = params;
    const startTime = Date.now();

    console.log(`[QuickDev] Starting quick task for ${taskId}: "${command}"`);

    // Emit start notification
    NotificationService.emitNotification(taskId, 'quick_task_started', {
      command,
      timestamp: new Date().toISOString(),
    });

    try {
      // 1. Get workspace context
      const context = await this.getWorkspaceContext(taskId);
      if (!context) {
        throw new Error('No workspace found for this task. Make sure sandbox is running.');
      }

      console.log(`[QuickDev] Workspace: ${context.workspacePath}, Sandbox: ${context.sandboxId}`);

      // 2. Get file list from workspace
      const fileList = await this.getWorkspaceFileList(taskId, context.workspacePath);

      // 3. Get current branch
      const currentBranch = await this.getCurrentBranch(context.repoPath || context.workspacePath);

      // 4. Build prompt
      const prompt = buildQuickDevPrompt({
        command,
        workspacePath: context.workspacePath,
        repoPath: context.repoPath,
        fileList,
        currentBranch,
        targetRepository: context.targetRepository,
      });

      console.log(`[QuickDev] Executing developer agent...`);

      // 5. Execute developer agent
      const devResult = await this.agentExecutor.executeAgent(
        'developer',                    // agentType
        prompt,                         // prompt
        context.repoPath || context.workspacePath,  // workspacePath
        taskId,                         // taskId
        'Quick Dev',                    // agentName
        undefined,                      // sessionId
        false,                          // fork
        undefined,                      // attachments
        {
          timeout: 10 * 60 * 1000,      // 10 min max
          sandboxId: context.sandboxId, // For sandbox_bash
        },
        undefined,                      // contextOverride
        false,                          // skipOptimization
        'bypassPermissions',            // permissionMode - trust the agent
      );

      console.log(`[QuickDev] Developer completed. Output length: ${devResult.output.length}`);

      // 6. Extract commit SHA if present
      const commitSha = this.extractCommitSha(devResult.output);

      // 7. Check for success marker
      const devSuccess = devResult.output.includes('DEVELOPER_FINISHED_SUCCESSFULLY');

      // 8. Optional: Run Judge review
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

      // 9. Calculate duration and cost
      const duration = Date.now() - startTime;
      const cost = devResult.cost || 0;

      // 10. Emit completion notification
      NotificationService.emitNotification(taskId, 'quick_task_completed', {
        success: devSuccess,
        command,
        filesModified: devResult.filesModified,
        filesCreated: devResult.filesCreated,
        commitSha,
        cost,
        duration,
        judgeApproved: judgeResult?.approved,
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
      };

    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[QuickDev] Error:`, error);

      // Emit failure notification
      NotificationService.emitNotification(taskId, 'quick_task_failed', {
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
      };
    }
  }

  /**
   * Get workspace context from EventStore and SandboxService
   */
  private async getWorkspaceContext(taskId: string): Promise<{
    workspacePath: string;
    repoPath?: string;
    targetRepository?: string;
    sandboxId?: string;
  } | null> {
    try {
      // Get state from EventStore (use imported singleton)
      const state = await eventStore.getCurrentState(taskId);
      const workspace = state.workspaces?.[0];

      if (!workspace) {
        console.warn(`[QuickDev] No workspace in EventStore for task ${taskId}`);
        return null;
      }

      // Get sandbox info
      let sandboxId: string | undefined;
      try {
        const sandbox = sandboxService.getSandbox(taskId);
        sandboxId = sandbox?.containerId;
      } catch (e) {
        console.warn(`[QuickDev] Could not get sandbox info:`, e);
      }

      return {
        workspacePath: workspace.workspacePath,
        repoPath: workspace.repoLocalPath,
        targetRepository: workspace.targetRepository,
        sandboxId,
      };
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
