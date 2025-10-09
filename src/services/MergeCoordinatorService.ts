import { query, type Options, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { Task, IPRConflict } from '../models/Task';
import { Repository } from '../models/Repository';
import { GitHubService } from './GitHubService';
import path from 'path';
import os from 'os';

/**
 * MergeCoordinatorService - Observa múltiples tasks en paralelo
 *
 * Este servicio se ejecuta SEPARADAMENTE de las orchestraciones individuales.
 * Monitorea TODOS los repositorios con tasks activas y resuelve conflictos.
 *
 * Ejecución:
 * - Se ejecuta cada X minutos (via scheduler)
 * - Busca tasks activas por repository
 * - Detecta conflictos entre PRs
 * - Resuelve conflictos automáticamente con Claude
 * - Crea estrategia de merge óptima
 */
export class MergeCoordinatorService {
  private readonly workspaceDir: string;
  private readonly githubService: GitHubService;

  constructor() {
    this.workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    this.githubService = new GitHubService(this.workspaceDir);
  }

  /**
   * Monitorea TODOS los repositories con tasks activas
   */
  async monitorAllRepositories(): Promise<void> {
    console.log(`🔀 [Merge Coordinator] Starting repository scan...`);

    try {
      // Obtener todos los repositorios con tasks activas
      const activeTasks = await Task.find({
        status: 'in_progress',
        repositoryIds: { $exists: true, $ne: [] },
      });

      // Obtener IDs únicos de todos los repositorios
      const repositoryIds = new Set<string>();
      for (const task of activeTasks) {
        if (task.repositoryIds) {
          task.repositoryIds.forEach((id: any) => repositoryIds.add(id.toString()));
        }
      }

      console.log(`  Found ${repositoryIds.size} repositories with active tasks`);

      // Monitorear cada repository
      for (const repositoryId of repositoryIds) {
        await this.monitorRepository(repositoryId);
      }

      console.log(`✅ [Merge Coordinator] Repository scan complete`);
    } catch (error) {
      console.error(`❌ [Merge Coordinator] Error scanning repositories:`, error);
    }
  }

  /**
   * Monitorea un repository específico
   */
  async monitorRepository(repositoryId: string): Promise<void> {
    console.log(`🔍 [Merge Coordinator] Analyzing repository: ${repositoryId}`);

    try {
      const repository = await Repository.findById(repositoryId);
      if (!repository) return;

      // Buscar TODAS las tasks activas que incluyan este repo
      const activeTasks = await Task.find({
        repositoryIds: repositoryId,
        status: 'in_progress',
        'orchestration.team': { $exists: true, $ne: [] },
      }).populate('userId');

      if (activeTasks.length === 0) {
        console.log(`  No active tasks with teams in this repository`);
        return;
      }

      console.log(`  Found ${activeTasks.length} active tasks`);

      // Extraer TODOS los PRs de TODAS las tasks
      const allPRs: { taskId: string; prNumber: number; branchName: string | undefined }[] = [];

      for (const task of activeTasks) {
        const team = task.orchestration.team || [];
        const stories = task.orchestration.projectManager?.stories || [];

        for (const member of team) {
          for (const prNumber of member.pullRequests) {
            const story = stories.find((s) => s.pullRequestNumber === prNumber);
            allPRs.push({
              taskId: (task._id as any).toString(),
              prNumber,
              branchName: story?.branchName,
            });
          }
        }
      }

      console.log(`  Total PRs across all tasks: ${allPRs.length}`);

      if (allPRs.length < 2) {
        console.log(`  Not enough PRs to check for conflicts`);
        return;
      }

      // Detectar conflictos entre PRs
      const conflicts = await this.detectConflicts(repository, activeTasks[0].userId, allPRs);

      if (conflicts.length === 0) {
        console.log(`  ✅ No conflicts detected`);
        return;
      }

      console.log(`  ⚠️ Found ${conflicts.length} conflicts`);

      // Resolver conflictos
      await this.resolveConflicts(repository, activeTasks, conflicts);

      console.log(`✅ [Merge Coordinator] Repository analysis complete`);
    } catch (error) {
      console.error(`❌ [Merge Coordinator] Error monitoring repository:`, error);
    }
  }

  /**
   * Detecta conflictos entre PRs
   */
  private async detectConflicts(
    repository: any,
    userId: any,
    prs: { taskId: string; prNumber: number; branchName: string | undefined }[]
  ): Promise<IPRConflict[]> {
    const conflicts: IPRConflict[] = [];

    console.log(`    Checking ${prs.length} PRs for conflicts...`);

    // Comparar cada par de PRs
    for (let i = 0; i < prs.length; i++) {
      for (let j = i + 1; j < prs.length; j++) {
        const pr1 = prs[i];
        const pr2 = prs[j];

        try {
          // Obtener archivos modificados en cada PR
          const files1 = await this.githubService.getPRFiles(repository, userId._id.toString(), pr1.prNumber);
          const files2 = await this.githubService.getPRFiles(repository, userId._id.toString(), pr2.prNumber);

          // Detectar archivos en común
          const overlappingFiles = this.githubService.findOverlappingFiles(files1, files2);

          if (overlappingFiles.length > 0) {
            const severity = this.assessConflictSeverity(overlappingFiles);

            conflicts.push({
              pr1: pr1.prNumber,
              pr2: pr2.prNumber,
              overlappingFiles,
              severity,
              autoResolvable: severity === 'low' || severity === 'medium',
            });

            console.log(`      ⚠️ Conflict: PR #${pr1.prNumber} vs PR #${pr2.prNumber} (${overlappingFiles.length} files)`);
          }
        } catch (error) {
          console.error(`      Error checking PR #${pr1.prNumber} vs #${pr2.prNumber}:`, error);
        }
      }
    }

    return conflicts;
  }

  /**
   * Evalúa la severidad de un conflicto
   */
  private assessConflictSeverity(overlappingFiles: string[]): 'low' | 'medium' | 'high' | 'critical' {
    const fileCount = overlappingFiles.length;

    // Archivos críticos
    const criticalFiles = ['package.json', 'tsconfig.json', 'Dockerfile', '.env'];
    const hasCriticalFiles = overlappingFiles.some((f) =>
      criticalFiles.some((cf) => f.endsWith(cf))
    );

    if (hasCriticalFiles) return 'critical';
    if (fileCount > 10) return 'high';
    if (fileCount > 5) return 'medium';
    return 'low';
  }

  /**
   * Resuelve conflictos usando Claude
   */
  private async resolveConflicts(
    repository: any,
    tasks: any[],
    conflicts: IPRConflict[]
  ): Promise<void> {
    console.log(`    🤖 Resolving ${conflicts.length} conflicts with Claude...`);

    for (const conflict of conflicts) {
      try {
        // Si es auto-resolvable, intentar resolución automática
        if (conflict.autoResolvable) {
          const resolution = await this.autoResolveConflict(repository, tasks[0].userId, conflict);
          conflict.resolution = resolution;
          console.log(`      ✅ Auto-resolved: PR #${conflict.pr1} vs #${conflict.pr2}`);
        } else {
          // Conflictos complejos requieren intervención manual
          conflict.resolution = `Manual resolution required. Critical conflict in files: ${conflict.overlappingFiles.join(', ')}`;
          console.log(`      ⚠️ Manual resolution needed: PR #${conflict.pr1} vs #${conflict.pr2}`);
        }

        // Guardar conflicto en las tasks afectadas
        await this.saveConflictToTasks(tasks, conflict);
      } catch (error) {
        console.error(`      Error resolving conflict:`, error);
      }
    }
  }

  /**
   * Resolución automática de conflictos con Claude
   */
  private async autoResolveConflict(
    repository: any,
    userId: any,
    conflict: IPRConflict
  ): Promise<string> {
    console.log(`        Analyzing conflict with Claude...`);

    try {
      // Obtener diffs de ambos PRs para los archivos en conflicto
      const diffs: { file: string; pr1Diff: string; pr2Diff: string }[] = [];

      for (const filename of conflict.overlappingFiles) {
        const pr1Diff = await this.githubService.getPRFileDiff(
          repository,
          userId._id.toString(),
          conflict.pr1,
          filename
        );
        const pr2Diff = await this.githubService.getPRFileDiff(
          repository,
          userId._id.toString(),
          conflict.pr2,
          filename
        );

        diffs.push({ file: filename, pr1Diff, pr2Diff });
      }

      // Preparar prompt para Claude
      const prompt = `# Merge Conflict Resolution

## Conflict Details:
- **PR #${conflict.pr1}** vs **PR #${conflict.pr2}**
- **Overlapping Files**: ${conflict.overlappingFiles.join(', ')}
- **Severity**: ${conflict.severity}

## File Diffs:

${diffs
  .map(
    (d) => `### File: ${d.file}

**PR #${conflict.pr1} changes:**
\`\`\`diff
${d.pr1Diff}
\`\`\`

**PR #${conflict.pr2} changes:**
\`\`\`diff
${d.pr2Diff}
\`\`\`
`
  )
  .join('\n')}

## Your Mission:
Analyze these conflicting changes and provide:

1. **Conflict Analysis**: What parts are conflicting?
2. **Resolution Strategy**: How to merge both changes preserving all functionality?
3. **Merge Order**: Which PR should merge first, and what rebase is needed?
4. **Risk Assessment**: Any risks in the proposed resolution?

Provide a clear, actionable resolution strategy.`;

      // Ejecutar Claude
      const result = await this.executeAgent(prompt);

      return result.output;
    } catch (error: any) {
      return `Failed to auto-resolve: ${error.message}`;
    }
  }

  /**
   * Guarda el conflicto en las tasks afectadas
   */
  private async saveConflictToTasks(tasks: any[], conflict: IPRConflict): Promise<void> {
    for (const task of tasks) {
      const team = task.orchestration.team || [];

      // Verificar si esta task tiene alguno de los PRs en conflicto
      const hasConflict = team.some(
        (m: any) => m.pullRequests.includes(conflict.pr1) || m.pullRequests.includes(conflict.pr2)
      );

      if (hasConflict) {
        if (!task.orchestration.mergeCoordinator) {
          task.orchestration.mergeCoordinator = {
            agent: 'merge-coordinator',
            status: 'in_progress',
            conflictsDetected: [],
          };
        }

        // Agregar conflicto si no existe
        const existingConflict = task.orchestration.mergeCoordinator.conflictsDetected?.find(
          (c: IPRConflict) => c.pr1 === conflict.pr1 && c.pr2 === conflict.pr2
        );

        if (!existingConflict) {
          task.orchestration.mergeCoordinator.conflictsDetected = [
            ...(task.orchestration.mergeCoordinator.conflictsDetected || []),
            conflict,
          ];
        }

        await task.save();
      }
    }
  }

  /**
   * Ejecuta Claude para resolución de conflictos
   */
  private async executeAgent(prompt: string): Promise<{ output: string; usage: any }> {
    const agentDefinition: AgentDefinition = {
      description: 'Merge conflict resolution specialist',
      tools: ['Read', 'Grep'],
      prompt: `You are a Merge Coordinator specialist resolving Git conflicts.

Your responsibilities:
- Analyze conflicting code changes
- Provide intelligent merge strategies
- Ensure no functionality is lost
- Recommend merge order

Always provide actionable resolution steps.`,
      model: 'sonnet',
    };

    try {
      const sdkOptions: Options = {
        cwd: this.workspaceDir,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: agentDefinition.prompt,
        },
        agents: { 'merge-coordinator': agentDefinition },
        allowedTools: agentDefinition.tools,
        permissionMode: 'bypassPermissions',
        maxTurns: 20,
      };

      let output = '';
      let usage: any = null;

      const queryResult = query({
        prompt,
        options: sdkOptions,
      });

      for await (const message of queryResult) {
        if (message.type === 'assistant') {
          const textContent = message.message.content.find((c: any) => c.type === 'text');
          if (textContent) {
            output += textContent.text + '\n';
          }
        }

        if (message.type === 'result') {
          usage = message.usage;
          if (message.subtype === 'success') {
            output = message.result;
          }
        }
      }

      return { output: output.trim(), usage };
    } catch (error) {
      console.error(`❌ Error executing merge coordinator agent:`, error);
      throw error;
    }
  }
}
