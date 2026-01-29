/**
 * SandboxRelaunchService
 *
 * 🔥 Executes SandboxPhase EXACTLY like the orchestrator does.
 * No more duplicated logic - just call SandboxPhase.execute()
 *
 * Used by: /api/sandbox/relaunch/:taskId endpoint
 */

import { TaskRepository } from '../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../database/repositories/RepositoryRepository.js';
import { eventStore } from './EventStore.js';
import { SandboxPhase } from './orchestration/SandboxPhase.js';
import { OrchestrationContext } from './orchestration/Phase.js';
import { agentExecutorService } from './orchestration/AgentExecutorService.js';
import { NotificationService } from './NotificationService.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

export interface RelaunchResult {
  success: boolean;
  sandbox?: {
    taskId: string;
    containerId?: string;
    containerName?: string;
    status?: string;
    workspacePath?: string;
    mappedPorts?: Record<string, string>;
  };
  servers?: Record<string, { started: boolean; verified: boolean; url?: string; error?: string }>;
  error?: string;
}

class SandboxRelaunchService {
  private static instance: SandboxRelaunchService;

  static getInstance(): SandboxRelaunchService {
    if (!SandboxRelaunchService.instance) {
      SandboxRelaunchService.instance = new SandboxRelaunchService();
    }
    return SandboxRelaunchService.instance;
  }

  /**
   * Relaunch sandbox by executing SandboxPhase directly
   *
   * This does EXACTLY what the orchestrator does:
   * 1. Creates OrchestrationContext
   * 2. Creates SandboxPhase with executeAgent wrapper
   * 3. Calls SandboxPhase.execute()
   */
  async relaunchSandbox(taskId: string): Promise<RelaunchResult> {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔄 [SandboxRelaunchService] Relaunching sandbox for task ${taskId}`);
    console.log(`   Using SandboxPhase.execute() - SAME as orchestrator`);
    console.log(`${'='.repeat(70)}\n`);

    NotificationService.emitConsoleLog(taskId, 'info', '🔄 Relaunching sandbox using SandboxPhase...');

    try {
      // 1. Get task from database
      const task = TaskRepository.findById(taskId);
      if (!task) {
        return { success: false, error: `Task not found: ${taskId}` };
      }

      // 2. Get repositories from task or EventStore
      let repositories: any[] = [];

      // First try EventStore
      const state = await eventStore.getCurrentState(taskId);

      // Try to get repos from various sources
      const stateRepos = (state as any).repositories;
      const orchestrationRepos = (task.orchestration as any)?.repositories;

      if (stateRepos?.length > 0) {
        repositories = stateRepos;
        console.log(`   📦 Got ${repositories.length} repo(s) from EventStore.repositories`);
      } else if (orchestrationRepos?.length > 0) {
        repositories = orchestrationRepos;
        console.log(`   📦 Got ${repositories.length} repo(s) from task.orchestration.repositories`);
      } else if (task.repositoryIds && task.repositoryIds.length > 0) {
        // Load from RepositoryRepository
        repositories = task.repositoryIds
          .map(id => RepositoryRepository.findById(id.toString()))
          .filter(r => r !== null);
        console.log(`   📦 Got ${repositories.length} repo(s) from RepositoryRepository`);
      }

      // 3. Determine workspace path
      let workspacePath = '';

      // Try EventStore first
      if (state.workspaces?.[0]) {
        workspacePath = state.workspaces[0].repoLocalPath || state.workspaces[0].workspacePath;
      }

      // Fallback: search disk
      if (!workspacePath) {
        const workspaceBase = process.env.AGENT_WORKSPACE_PATH || path.join(os.homedir(), 'agent-workspace-prod');
        const possiblePaths = [
          path.join(workspaceBase, `task-${taskId}`),
          path.join(workspaceBase, taskId),
        ];

        for (const possiblePath of possiblePaths) {
          if (fs.existsSync(possiblePath)) {
            workspacePath = possiblePath;
            console.log(`   📁 Found workspace on disk: ${workspacePath}`);
            break;
          }
        }
      }

      if (!workspacePath || !fs.existsSync(workspacePath)) {
        return { success: false, error: `Workspace not found for task ${taskId}` };
      }

      console.log(`   📁 Workspace: ${workspacePath}`);

      // 4. If no repositories found in DB, scan workspace directory
      if (repositories.length === 0) {
        console.log(`   🔍 No repos in DB - scanning workspace...`);
        repositories = this.scanWorkspaceForRepos(workspacePath);
        console.log(`   📦 Found ${repositories.length} repo(s) on disk`);
      }

      // Set local paths
      repositories.forEach(repo => {
        repo.localPath = path.join(workspacePath, repo.name);
      });

      console.log(`   📦 Repositories:`);
      repositories.forEach(r => console.log(`      - ${r.name} (${r.type || 'unknown'})`));

      // 5. Create OrchestrationContext (SAME as orchestrator)
      const context = new OrchestrationContext(task, repositories, workspacePath);
      console.log(`   ✅ OrchestrationContext created`);

      // 6. Create executeAgent wrapper (SAME as orchestrator)
      const executeAgentWithContext = (
        agentType: string,
        prompt: string,
        agentWorkspacePath: string,
        agentTaskId?: string,
        agentName?: string,
        sessionId?: string,
        fork?: boolean,
        attachments?: any[],
        options?: { maxIterations?: number; timeout?: number }
      ) => {
        return agentExecutorService.executeAgent(
          agentType,
          prompt,
          agentWorkspacePath,
          agentTaskId,
          agentName,
          sessionId,
          fork,
          attachments,
          options,
          context
        );
      };

      // 7. Create SandboxPhase (SAME as orchestrator)
      const sandboxPhase = new SandboxPhase(executeAgentWithContext);

      // 8. Execute SandboxPhase (SAME as orchestrator)
      console.log(`   🐳 Executing SandboxPhase...`);
      NotificationService.emitConsoleLog(taskId, 'info', '🐳 Running SandboxPhase.execute()...');

      const result = await sandboxPhase.execute(context);

      console.log(`   📊 SandboxPhase result: success=${result.success}`);

      if (result.success) {
        NotificationService.emitConsoleLog(taskId, 'info', '✅ Sandbox relaunched successfully via SandboxPhase');

        return {
          success: true,
          sandbox: {
            taskId,
            containerId: context.getData('containerId'),
            containerName: context.getData('containerName'),
            status: 'running',
            workspacePath,
            mappedPorts: context.getData('mappedPorts'),
          },
          servers: context.getData('devServerResults'),
        };
      } else {
        NotificationService.emitConsoleLog(taskId, 'error', `❌ SandboxPhase failed: ${result.error}`);

        return {
          success: false,
          error: result.error || 'SandboxPhase execution failed',
          servers: result.data?.devServers,
        };
      }

    } catch (error: any) {
      console.error(`[SandboxRelaunchService] Error:`, error);
      NotificationService.emitConsoleLog(taskId, 'error', `❌ Relaunch error: ${error.message}`);

      return {
        success: false,
        error: error.message || 'Failed to relaunch sandbox',
      };
    }
  }

  /**
   * Scan workspace directory for repositories
   */
  private scanWorkspaceForRepos(workspacePath: string): any[] {
    const repos: any[] = [];

    try {
      const entries = fs.readdirSync(workspacePath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        const subDir = path.join(workspacePath, entry.name);
        let repoType = 'unknown';
        let language = 'unknown';

        // Detect type by files present
        if (fs.existsSync(path.join(subDir, 'pubspec.yaml'))) {
          repoType = 'frontend';
          language = 'flutter';
        } else if (fs.existsSync(path.join(subDir, 'package.json'))) {
          // Check if it's backend or frontend
          try {
            const pkgJson = JSON.parse(fs.readFileSync(path.join(subDir, 'package.json'), 'utf-8'));
            const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
            if (deps.express || deps.fastify || deps.koa || deps['@nestjs/core']) {
              repoType = 'backend';
            } else if (deps.react || deps.vue || deps.angular || deps.svelte) {
              repoType = 'frontend';
            } else {
              repoType = 'fullstack';
            }
          } catch {
            repoType = 'fullstack';
          }
          language = 'nodejs';
        } else if (fs.existsSync(path.join(subDir, 'requirements.txt')) || fs.existsSync(path.join(subDir, 'pyproject.toml'))) {
          repoType = 'backend';
          language = 'python';
        } else if (fs.existsSync(path.join(subDir, 'go.mod'))) {
          repoType = 'backend';
          language = 'go';
        }

        // Only add if we detected a known language
        if (language !== 'unknown') {
          repos.push({
            name: entry.name,
            type: repoType,
            language,
            url: '', // No URL for disk-recovered repos
          });
        }
      }
    } catch (err) {
      console.error(`[SandboxRelaunchService] Error scanning workspace: ${err}`);
    }

    return repos;
  }
}

export const sandboxRelaunchService = SandboxRelaunchService.getInstance();
