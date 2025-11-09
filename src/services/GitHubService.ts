import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { User } from '../models/User';
import { EnvService } from './EnvService';
import { IEnvVariable } from '../models/Repository';
import { safeGitExec, safePushBranch, safeFetch, safePull, safeVerifyRemoteBranch } from '../utils/safeGitExecution';

const execAsync = promisify(exec);

export interface GitHubPROptions {
  title: string;
  description: string;
  branch: string;
  baseBranch?: string;
}

/**
 * GitHubService - Maneja operaciones de GitHub para multi-tenant SaaS
 *
 * Capacidades:
 * - Clonar repos de usuarios
 * - Crear branches
 * - Commit y push
 * - Crear Pull Requests
 * - Cleanup de workspaces
 */
export class GitHubService {
  private baseWorkspaceDir: string;

  constructor(baseWorkspaceDir: string = '/tmp/agent-workspace') {
    this.baseWorkspaceDir = baseWorkspaceDir;
  }

  /**
   * Clona el repositorio de un proyecto en su workspace aislado
   * @param customPath - Ruta personalizada para clonar (útil para multi-repo)
   */
  async cloneRepository(project: any, userId: string, customPath?: string): Promise<string> {
    const user = await User.findById(userId);
    if (!user) throw new Error('User not found');

    const workspacePath = customPath || this.getWorkspacePath(project.workspaceId);

    // Verificar si ya existe
    try {
      await fs.access(workspacePath);
      console.log(`📂 Workspace already exists: ${workspacePath}`);
      return workspacePath;
    } catch {
      // No existe, clonar
    }

    try {
      // Crear directorio padre si no existe
      const parentDir = path.dirname(workspacePath);
      await fs.mkdir(parentDir, { recursive: true });

      console.log(`📥 Cloning ${project.githubRepoUrl} to ${workspacePath}...`);

      // Clonar usando el token del usuario
      const repoUrlWithToken = this.getAuthenticatedRepoUrl(project.githubRepoUrl, user.accessToken);

      // Use safe git operations with timeout
      await safeGitExec(`git clone ${repoUrlWithToken} ${workspacePath}`, {
        cwd: parentDir,
        timeout: 60000, // 60 seconds for clone
      });

      // Checkout al branch correcto
      if (project.githubBranch !== 'main' && project.githubBranch !== 'master') {
        await safeGitExec(`git checkout ${project.githubBranch}`, {
          cwd: workspacePath,
        });
      }

      console.log(`✅ Repository cloned successfully`);
      return workspacePath;
    } catch (error: any) {
      console.error('❌ Error cloning repository:', error);
      throw new Error(`Failed to clone repository: ${error.message}`);
    }
  }

  /**
   * Clona un repositorio para multi-repo orchestration
   * @param githubRepoName - Nombre del repositorio (e.g., "user/repo")
   * @param branch - Branch a clonar
   * @param githubToken - Token de acceso de GitHub
   * @param targetDir - Directorio donde clonar (el repo se clonará dentro de esta carpeta)
   * @returns Ruta al repositorio clonado
   */
  async cloneRepositoryForOrchestration(
    githubRepoName: string,
    branch: string,
    githubToken: string,
    targetDir: string,
    envVariables?: IEnvVariable[] // Optional environment variables to inject
  ): Promise<string> {
    // Extract repo name from "user/repo" format
    const repoName = githubRepoName.split('/').pop() || githubRepoName;
    const repoPath = path.join(targetDir, repoName);

    // Check if already cloned
    try {
      await fs.access(repoPath);
      console.log(`📂 Repository already cloned: ${repoPath}`);

      // If env variables provided and .env doesn't exist, create it
      if (envVariables && envVariables.length > 0) {
        const envExists = await EnvService.envFileExists(repoPath);
        if (!envExists) {
          console.log(`🔐 Injecting ${envVariables.length} environment variables...`);
          await EnvService.writeEnvFile(repoPath, envVariables);
        }
      }

      return repoPath;
    } catch {
      // Doesn't exist, clone it
    }

    // Retry logic for network errors (SSL, connection issues)
    const maxRetries = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📥 Cloning ${githubRepoName} (branch: ${branch}) to ${repoPath}... (attempt ${attempt}/${maxRetries})`);

        // Build authenticated GitHub URL
        const githubRepoUrl = `https://github.com/${githubRepoName}`;
        const authenticatedUrl = this.getAuthenticatedRepoUrl(githubRepoUrl, githubToken);

        // Clone repository with timeout protection
        await safeGitExec(`git clone -b ${branch} ${authenticatedUrl} ${repoName}`, {
          cwd: targetDir,
          timeout: 60000, // 60 seconds for clone
        });

        console.log(`✅ Repository cloned successfully: ${repoName}`);

        // 🔐 Inject environment variables if provided
        if (envVariables && envVariables.length > 0) {
          console.log(`🔐 Injecting ${envVariables.length} environment variables...`);
          await EnvService.writeEnvFile(repoPath, envVariables);
        }

        return repoPath;
      } catch (error: any) {
        lastError = error;
        console.error(`❌ Clone attempt ${attempt}/${maxRetries} failed:`, error.message);

        // If SSL or connection error and not last attempt, retry with exponential backoff
        if (attempt < maxRetries && (
          error.message.includes('SSL_ERROR') ||
          error.message.includes('unable to access') ||
          error.message.includes('Connection refused')
        )) {
          const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
          console.log(`⏳ Retrying in ${waitTime / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          continue;
        }

        // If not retryable or last attempt, throw
        break;
      }
    }

    console.error(`❌ All ${maxRetries} clone attempts failed for ${githubRepoName}`);
    throw new Error(`Failed to clone repository ${githubRepoName} after ${maxRetries} attempts: ${lastError.message}`);
  }

  /**
   * Crea un nuevo branch para trabajar
   */
  async createBranch(workspacePath: string, branchName: string): Promise<void> {
    try {
      // Asegurar que estamos en el branch base - use safe operations
      await safeFetch(workspacePath);
      await safePull(workspacePath);

      // Crear y checkout nuevo branch
      await safeGitExec(`git checkout -b ${branchName}`, { cwd: workspacePath });

      console.log(`✅ Created branch: ${branchName}`);
    } catch (error: any) {
      throw new Error(`Failed to create branch: ${error.message}`);
    }
  }

  /**
   * Hace commit de todos los cambios
   */
  async commitChanges(workspacePath: string, message: string): Promise<void> {
    try {
      // Configurar git user (usar info del usuario de GitHub) - safe local operations
      await safeGitExec('git config user.name "Multi-Agent Platform"', { cwd: workspacePath });
      await safeGitExec('git config user.email "noreply@multi-agents.dev"', { cwd: workspacePath });

      // Add all changes
      await safeGitExec('git add .', { cwd: workspacePath });

      // Check if there are changes to commit
      const { stdout: status } = await safeGitExec('git status --porcelain', { cwd: workspacePath });

      if (!status.trim()) {
        console.log('ℹ️ No changes to commit');
        return;
      }

      // Commit with safe execution
      await safeGitExec(`git commit -m "${this.escapeCommitMessage(message)}"`, {
        cwd: workspacePath,
      });

      console.log(`✅ Changes committed: ${message}`);
    } catch (error: any) {
      throw new Error(`Failed to commit changes: ${error.message}`);
    }
  }

  /**
   * Push del branch al repo remoto
   */
  async pushBranch(branchName: string, workspacePath: string, userId: string): Promise<void> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      // Push usando el token del usuario WITH TIMEOUT
      // 🔥 CRITICAL: Add timeout to prevent hanging
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execWithTimeout = promisify(exec);

      await Promise.race([
        execWithTimeout(`timeout 30 git push -u origin ${branchName} 2>&1`, {
          cwd: workspacePath,
          env: {
            ...process.env,
            GIT_ASKPASS: 'echo',
            GIT_USERNAME: user.username,
            GIT_PASSWORD: user.accessToken,
          },
          timeout: 30000 // 30 seconds max
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Git push timed out after 30 seconds')), 30000)
        )
      ]);

      console.log(`✅ Pushed branch: ${branchName}`);
    } catch (error: any) {
      throw new Error(`Failed to push branch: ${error.message}`);
    }
  }

  /**
   * Delete a remote branch from GitHub
   * Used for branch cleanup after epic/story merge
   */
  async deleteBranch(repositoryName: string, branchName: string): Promise<void> {
    try {
      // repositoryName format: "owner/repo"
      const [owner, repo] = repositoryName.split('/');

      if (!owner || !repo) {
        throw new Error(`Invalid repository name format: ${repositoryName}. Expected "owner/repo"`);
      }

      // Get any user's access token (we just need valid credentials)
      const user = await User.findOne({ accessToken: { $exists: true, $ne: null } });
      if (!user || !user.accessToken) {
        throw new Error('No user with GitHub access token found');
      }

      // Delete branch using GitHub API
      // DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${user.accessToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub API error (${response.status}): ${errorText}`);
      }

      console.log(`✅ Deleted branch: ${branchName} from ${repositoryName}`);
    } catch (error: any) {
      throw new Error(`Failed to delete branch ${branchName}: ${error.message}`);
    }
  }

  /**
   * Crea un Pull Request en GitHub
   */
  async createPullRequest(
    project: any,
    userId: string,
    options: GitHubPROptions
  ): Promise<{ url: string; number: number }> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const [owner, repo] = project.githubRepoName.split('/');
      const baseBranch = options.baseBranch || project.githubBranch;

      // Crear PR usando GitHub API
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          title: options.title,
          body: options.description,
          head: options.branch,
          base: baseBranch,
        }),
      });

      if (!response.ok) {
        const error: any = await response.json();
        throw new Error(error.message || 'Failed to create PR');
      }

      const pr: any = await response.json();

      console.log(`✅ Pull Request created: ${pr.html_url}`);

      return {
        url: pr.html_url,
        number: pr.number,
      };
    } catch (error: any) {
      console.error('❌ Error creating PR:', error);
      throw new Error(`Failed to create Pull Request: ${error.message}`);
    }
  }

  /**
   * Limpia el workspace de un proyecto
   */
  async cleanupWorkspace(workspaceId: string): Promise<void> {
    const workspacePath = this.getWorkspacePath(workspaceId);

    try {
      await fs.rm(workspacePath, { recursive: true, force: true });
      console.log(`🗑️ Cleaned workspace: ${workspaceId}`);
    } catch (error: any) {
      console.error(`⚠️ Error cleaning workspace ${workspaceId}:`, error.message);
      // No throw - cleanup is best effort
    }
  }

  /**
   * Limpia workspaces antiguos (más de 24 horas)
   */
  async cleanupOldWorkspaces(maxAgeHours: number = 24): Promise<void> {
    try {
      // Check if workspace directory exists
      try {
        await fs.access(this.baseWorkspaceDir);
      } catch {
        // Directory doesn't exist yet - nothing to clean up
        return;
      }

      const dirs = await fs.readdir(this.baseWorkspaceDir);
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000;

      for (const dir of dirs) {
        const dirPath = path.join(this.baseWorkspaceDir, dir);

        try {
          const stats = await fs.stat(dirPath);

          if (stats.isDirectory() && now - stats.mtimeMs > maxAge) {
            await fs.rm(dirPath, { recursive: true, force: true });
            console.log(`🗑️ Cleaned old workspace: ${dir}`);
          }
        } catch (error: any) {
          console.error(`⚠️ Error checking ${dir}:`, error.message);
        }
      }
    } catch (error: any) {
      console.error('⚠️ Error during workspace cleanup:', error.message);
    }
  }

  /**
   * Obtiene la ruta del workspace para un proyecto
   */
  private getWorkspacePath(workspaceId: string): string {
    return path.join(this.baseWorkspaceDir, workspaceId);
  }

  /**
   * Agrega autenticación a la URL del repo
   */
  private getAuthenticatedRepoUrl(repoUrl: string, accessToken: string): string {
    // Convert https://github.com/user/repo to https://token@github.com/user/repo
    return repoUrl.replace('https://github.com/', `https://${accessToken}@github.com/`);
  }

  /**
   * Escapa caracteres especiales en el mensaje de commit
   */
  private escapeCommitMessage(message: string): string {
    return message.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');
  }

  /**
   * Sincroniza el workspace con el repo remoto
   */
  async syncWorkspace(workspaceId: string): Promise<void> {
    const workspacePath = this.getWorkspacePath(workspaceId);

    try {
      // Use safe git operations with timeout
      await safeFetch(workspacePath);
      await safePull(workspacePath);
      console.log(`🔄 Workspace synced: ${workspaceId}`);
    } catch (error: any) {
      throw new Error(`Failed to sync workspace: ${error.message}`);
    }
  }

  /**
   * ====================================
   * PR MANAGEMENT METHODS
   * ====================================
   */

  /**
   * Obtiene información de un Pull Request
   */
  async getPR(repository: any, userId: string, prNumber: number): Promise<any> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const [owner, repo] = repository.githubRepoName.split('/');

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch PR: ${response.statusText}`);
      }

      return await response.json();
    } catch (error: any) {
      console.error('❌ Error fetching PR:', error);
      throw error;
    }
  }

  /**
   * Obtiene los archivos modificados en un Pull Request
   */
  async getPRFiles(repository: any, userId: string, prNumber: number): Promise<string[]> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const [owner, repo] = repository.githubRepoName.split('/');

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch PR files: ${response.statusText}`);
      }

      const files = (await response.json()) as any[];
      return files.map((f) => f.filename);
    } catch (error: any) {
      console.error('❌ Error fetching PR files:', error);
      throw error;
    }
  }

  /**
   * Mergea un Pull Request
   */
  async mergePR(
    repository: any,
    userId: string,
    prNumber: number,
    mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'
  ): Promise<void> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const [owner, repo] = repository.githubRepoName.split('/');

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${user.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          merge_method: mergeMethod,
        }),
      });

      if (!response.ok) {
        const error: any = await response.json();
        throw new Error(error.message || 'Failed to merge PR');
      }

      console.log(`✅ PR #${prNumber} merged successfully`);
    } catch (error: any) {
      console.error('❌ Error merging PR:', error);
      throw error;
    }
  }

  /**
   * Crea una rama de integración temporal para testing
   */
  async createIntegrationBranch(
    workspacePath: string,
    baseBranch: string,
    integrationBranchName: string
  ): Promise<void> {
    try {
      // Clean up any stale git locks
      const lockFile = `${workspacePath}/.git/index.lock`;
      const fs = require('fs');
      if (fs.existsSync(lockFile)) {
        console.log(`🧹 Removing stale git lock: ${lockFile}`);
        fs.unlinkSync(lockFile);
      }

      // Stash any uncommitted changes to avoid blocking checkout
      try {
        await safeGitExec('git stash', { cwd: workspacePath });
      } catch (stashError) {
        console.log('No changes to stash');
      }

      // First, check if base branch exists locally
      const branchExists = await safeGitExec(
        `git show-ref --verify --quiet refs/heads/${baseBranch} && echo "exists" || echo "not-exists"`,
        { cwd: workspacePath }
      ).then(r => r.stdout.trim() === 'exists').catch(() => false);

      if (branchExists) {
        // Branch exists, just checkout
        console.log(`📋 Checking out existing branch: ${baseBranch}`);
        await safeGitExec(`git checkout ${baseBranch}`, { cwd: workspacePath });
      } else {
        // Branch doesn't exist, checkout from main/master
        console.log(`📋 Branch ${baseBranch} doesn't exist, checking out from main`);
        try {
          await safeGitExec(`git checkout main`, { cwd: workspacePath });
        } catch {
          // Try master if main doesn't exist
          await safeGitExec(`git checkout master`, { cwd: workspacePath });
        }
      }

      // Crear nueva rama de integración
      await safeGitExec(`git checkout -b ${integrationBranchName}`, { cwd: workspacePath });

      console.log(`✅ Created integration branch: ${integrationBranchName}`);
    } catch (error: any) {
      throw new Error(`Failed to create integration branch: ${error.message}`);
    }
  }

  /**
   * Mergea múltiples PRs en una rama de integración para testing
   */
  async mergeMultiplePRsLocally(
    workspacePath: string,
    prBranches: string[]
  ): Promise<{ success: boolean; conflicts: string[] }> {
    const conflicts: string[] = [];

    for (const branchName of prBranches) {
      try {
        // Check if branch exists locally first
        const localBranchExists = await execAsync(
          `git show-ref --verify --quiet refs/heads/${branchName} && echo "exists" || echo "not-exists"`,
          { cwd: workspacePath }
        ).then(r => r.stdout.trim() === 'exists').catch(() => false);

        if (localBranchExists) {
          console.log(`📋 Branch ${branchName} exists locally, merging...`);
          // Merge the local branch directly with timeout protection
          await safeGitExec(`git merge ${branchName} --no-ff -m "Merge ${branchName} for integration testing"`, {
            cwd: workspacePath,
          });
        } else {
          console.log(`📋 Branch ${branchName} not found locally, skipping...`);
          // Branch doesn't exist locally, which is fine - it might not have been pushed
          continue;
        }

        console.log(`✅ Merged ${branchName} successfully`);
      } catch (error: any) {
        // Detectar conflictos de merge (múltiples indicadores)
        const errorMsg = error.message || '';
        const isMergeConflict =
          errorMsg.includes('CONFLICT') ||
          errorMsg.includes('Automatic merge failed') ||
          errorMsg.includes('Recorded preimage') ||
          errorMsg.includes('Merge conflict');

        if (isMergeConflict) {
          conflicts.push(branchName);
          console.log(`⚠️ Merge conflict detected when merging ${branchName}`);

          // Abortar el merge para limpiar el estado
          try {
            await safeGitExec('git merge --abort', { cwd: workspacePath });
          } catch (abortError) {
            console.warn(`⚠️ Could not abort merge (may already be clean)`);
          }
        } else {
          // Error no relacionado con conflictos - reportar pero continuar
          console.error(`❌ Error merging ${branchName} (non-conflict):`, errorMsg);
          conflicts.push(branchName);
        }
      }
    }

    return {
      success: conflicts.length === 0,
      conflicts,
    };
  }

  /**
   * Detecta conflictos entre archivos de diferentes PRs
   */
  findOverlappingFiles(files1: string[], files2: string[]): string[] {
    return files1.filter((file) => files2.includes(file));
  }

  /**
   * Obtiene el diff de un archivo específico en un PR
   */
  async getPRFileDiff(
    repository: any,
    userId: string,
    prNumber: number,
    filename: string
  ): Promise<string> {
    try {
      const user = await User.findById(userId);
      if (!user) throw new Error('User not found');

      const [owner, repo] = repository.githubRepoName.split('/');

      // Primero obtener la lista de archivos del PR
      const filesResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`,
        {
          headers: {
            Authorization: `Bearer ${user.accessToken}`,
            Accept: 'application/vnd.github.v3.diff',
          },
        }
      );

      if (!filesResponse.ok) {
        throw new Error(`Failed to fetch PR diff: ${filesResponse.statusText}`);
      }

      const files = (await filesResponse.json()) as any[];
      const file = files.find((f) => f.filename === filename);

      return file?.patch || '';
    } catch (error: any) {
      console.error('❌ Error fetching PR file diff:', error);
      throw error;
    }
  }

  /**
   * Aplica un rebase de una rama sobre otra
   */
  async rebaseBranch(
    workspacePath: string,
    sourceBranch: string,
    targetBranch: string
  ): Promise<{ success: boolean; conflicts: boolean }> {
    try {
      // Checkout a la rama source with timeout
      await safeGitExec(`git checkout ${sourceBranch}`, { cwd: workspacePath });

      // Fetch el target branch with timeout
      await safeGitExec(`git fetch origin ${targetBranch}`, {
        cwd: workspacePath,
        timeout: 15000, // 15 seconds for fetch
      });

      // Intentar rebase with timeout
      try {
        await safeGitExec(`git rebase origin/${targetBranch}`, { cwd: workspacePath });
        return { success: true, conflicts: false };
      } catch (error: any) {
        if (error.message.includes('CONFLICT')) {
          // Hay conflictos
          return { success: false, conflicts: true };
        }
        throw error;
      }
    } catch (error: any) {
      throw new Error(`Failed to rebase branch: ${error.message}`);
    }
  }

  /**
   * Aborta un rebase en progreso
   */
  async abortRebase(workspacePath: string): Promise<void> {
    try {
      await safeGitExec('git rebase --abort', { cwd: workspacePath });
      console.log('✅ Rebase aborted');
    } catch (error: any) {
      // No throw - puede que no haya rebase en progreso
      console.log('⚠️ No rebase to abort');
    }
  }
}
