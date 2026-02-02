/**
 * Repository Repository
 *
 * Database operations for git repositories
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';
import { CryptoService } from '../../services/CryptoService.js';

export interface IEnvVariable {
  key: string;
  value: string;
  isSecret: boolean;
  description?: string;
}

export interface IRepository {
  id: string;
  name: string;
  description?: string;
  projectId: string;
  githubRepoUrl: string;
  githubRepoName: string;
  githubBranch: string;
  workspaceId: string;
  type: 'backend' | 'frontend' | 'mobile' | 'shared';
  pathPatterns: string[];
  executionOrder?: number;
  dependencies?: string[];
  envVariables: IEnvVariable[];
  isActive: boolean;
  lastSyncedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface RepositoryRow {
  id: string;
  name: string;
  description: string | null;
  project_id: string;
  github_repo_url: string;
  github_repo_name: string;
  github_branch: string;
  workspace_id: string;
  type: string;
  path_patterns: string | null;
  execution_order: number | null;
  dependencies: string | null;
  env_variables: string | null;
  is_active: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRepository(row: RepositoryRow, decryptSecrets = false): IRepository {
  // Parse env variables
  let envVariables: IEnvVariable[] = parseJSON(row.env_variables, []);

  // Decrypt secret env variables if requested
  if (decryptSecrets && envVariables.length > 0) {
    envVariables = envVariables.map(envVar => {
      if (envVar.isSecret && envVar.value && CryptoService.isEncrypted(envVar.value)) {
        try {
          return { ...envVar, value: CryptoService.decrypt(envVar.value) };
        } catch (error: any) {
          console.warn(`[RepositoryRepository] Failed to decrypt env var ${envVar.key}:`, error.message);
          return envVar;
        }
      }
      return envVar;
    });
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description || undefined,
    projectId: row.project_id,
    githubRepoUrl: row.github_repo_url,
    githubRepoName: row.github_repo_name,
    githubBranch: row.github_branch,
    workspaceId: row.workspace_id,
    type: row.type as 'backend' | 'frontend' | 'mobile' | 'shared',
    pathPatterns: parseJSON(row.path_patterns, []),
    executionOrder: row.execution_order || undefined,
    dependencies: parseJSON(row.dependencies, undefined),
    envVariables,
    isActive: row.is_active === 1,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class RepositoryRepository {
  /**
   * Find repository by ID
   * @param decryptSecrets - If true, decrypts secret environment variables
   */
  static findById(id: string, decryptSecrets = false): IRepository | null {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE id = ?`);
    const row = stmt.get(id) as RepositoryRow | undefined;
    if (!row) return null;

    return rowToRepository(row, decryptSecrets);
  }

  /**
   * Find repositories by project ID
   * @param decryptSecrets - If true, decrypts secret environment variables
   */
  static findByProjectId(projectId: string, decryptSecrets = false): IRepository[] {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE project_id = ? AND is_active = 1 ORDER BY execution_order, created_at`);
    const rows = stmt.all(projectId) as RepositoryRow[];
    return rows.map(row => rowToRepository(row, decryptSecrets));
  }

  /**
   * Find repository by workspace ID
   * @param decryptSecrets - If true, decrypts secret environment variables
   */
  static findByWorkspaceId(workspaceId: string, decryptSecrets = false): IRepository | null {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE workspace_id = ?`);
    const row = stmt.get(workspaceId) as RepositoryRow | undefined;
    if (!row) return null;

    return rowToRepository(row, decryptSecrets);
  }

  /**
   * Find repository by GitHub repo name
   * @param decryptSecrets - If true, decrypts secret environment variables
   */
  static findByGithubRepoName(projectId: string, githubRepoName: string, decryptSecrets = false): IRepository | null {
    const stmt = db.prepare(`SELECT * FROM repositories WHERE project_id = ? AND github_repo_name = ?`);
    const row = stmt.get(projectId, githubRepoName) as RepositoryRow | undefined;
    if (!row) return null;

    return rowToRepository(row, decryptSecrets);
  }

  /**
   * Create a new repository
   */
  static create(data: {
    name: string;
    description?: string;
    projectId: string;
    githubRepoUrl: string;
    githubRepoName: string;
    githubBranch?: string;
    workspaceId: string;
    type: 'backend' | 'frontend' | 'mobile' | 'shared';
    pathPatterns?: string[];
    executionOrder?: number;
    dependencies?: string[];
    envVariables?: IEnvVariable[];
  }): IRepository {
    const id = generateId();
    const timestamp = now();

    // Encrypt secret environment variables
    let envVariables = data.envVariables || [];
    if (envVariables.length > 0) {
      envVariables = envVariables.map(envVar => {
        if (envVar.isSecret && envVar.value && !CryptoService.isEncrypted(envVar.value)) {
          return { ...envVar, value: CryptoService.encrypt(envVar.value) };
        }
        return envVar;
      });
    }

    const stmt = db.prepare(`
      INSERT INTO repositories (
        id, name, description, project_id,
        github_repo_url, github_repo_name, github_branch, workspace_id,
        type, path_patterns, execution_order, dependencies, env_variables,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      data.description || null,
      data.projectId,
      data.githubRepoUrl,
      data.githubRepoName,
      data.githubBranch || 'main',
      data.workspaceId,
      data.type,
      toJSON(data.pathPatterns || []),
      data.executionOrder || null,
      toJSON(data.dependencies || []),
      toJSON(envVariables),
      1,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Update repository
   */
  static update(id: string, data: Partial<{
    name: string;
    description: string;
    githubRepoUrl: string;
    githubRepoName: string;
    githubBranch: string;
    type: 'backend' | 'frontend' | 'mobile' | 'shared';
    pathPatterns: string[];
    executionOrder: number;
    dependencies: string[];
    envVariables: IEnvVariable[];
    isActive: boolean;
    lastSyncedAt: Date;
  }>): IRepository | null {
    const existing = this.findById(id);
    if (!existing) return null;

    // Encrypt secret environment variables
    let envVariables = data.envVariables;
    if (envVariables && envVariables.length > 0) {
      envVariables = envVariables.map(envVar => {
        if (envVar.isSecret && envVar.value && !CryptoService.isEncrypted(envVar.value)) {
          return { ...envVar, value: CryptoService.encrypt(envVar.value) };
        }
        return envVar;
      });
    }

    const stmt = db.prepare(`
      UPDATE repositories SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        github_repo_url = COALESCE(?, github_repo_url),
        github_repo_name = COALESCE(?, github_repo_name),
        github_branch = COALESCE(?, github_branch),
        type = COALESCE(?, type),
        path_patterns = COALESCE(?, path_patterns),
        execution_order = COALESCE(?, execution_order),
        dependencies = COALESCE(?, dependencies),
        env_variables = COALESCE(?, env_variables),
        is_active = COALESCE(?, is_active),
        last_synced_at = COALESCE(?, last_synced_at),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.name || null,
      data.description || null,
      data.githubRepoUrl || null,
      data.githubRepoName || null,
      data.githubBranch || null,
      data.type || null,
      data.pathPatterns ? toJSON(data.pathPatterns) : null,
      data.executionOrder || null,
      data.dependencies ? toJSON(data.dependencies) : null,
      envVariables ? toJSON(envVariables) : null,
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
      data.lastSyncedAt ? data.lastSyncedAt.toISOString() : null,
      now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Delete repository (soft delete)
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`UPDATE repositories SET is_active = 0, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Hard delete repository
   */
  static hardDelete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM repositories WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Update last synced timestamp
   */
  static updateLastSynced(id: string): void {
    const stmt = db.prepare(`UPDATE repositories SET last_synced_at = ?, updated_at = ? WHERE id = ?`);
    const timestamp = now();
    stmt.run(timestamp, timestamp, id);
  }

  /**
   * Get decrypted environment variables
   */
  static getDecryptedEnvVariables(id: string): IEnvVariable[] {
    const repo = this.findById(id);
    if (!repo) return [];

    return repo.envVariables.map(envVar => {
      if (envVar.isSecret && envVar.value) {
        return { ...envVar, value: CryptoService.decrypt(envVar.value) };
      }
      return envVar;
    });
  }

  /**
   * Count repositories by project
   */
  static countByProject(projectId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM repositories WHERE project_id = ? AND is_active = 1`);
    const row = stmt.get(projectId) as { count: number };
    return row.count;
  }

  /**
   * Find multiple repositories by IDs
   * @param decryptSecrets - If true, decrypts secret environment variables
   */
  static findByIds(ids: string[], decryptSecrets = false): IRepository[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM repositories WHERE id IN (${placeholders}) AND is_active = 1`);
    const rows = stmt.all(...ids) as RepositoryRow[];
    return rows.map(row => rowToRepository(row, decryptSecrets));
  }
}

export default RepositoryRepository;
