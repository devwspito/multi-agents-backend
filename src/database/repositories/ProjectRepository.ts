/**
 * Project Repository
 *
 * Database operations for projects
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';
import { CryptoService } from '../../services/CryptoService.js';

export interface IDevAuth {
  method: 'none' | 'token' | 'credentials';
  token?: string;
  tokenType?: 'bearer' | 'api-key' | 'basic' | 'custom';
  tokenHeader?: string;
  tokenPrefix?: string;
  loginEndpoint?: string;
  loginMethod?: 'POST' | 'GET';
  credentials?: {
    username?: string;
    password?: string;
  };
  loginContentType?: string;
  tokenResponsePath?: string;
}

export interface IProjectSettings {
  defaultBranch?: string;
  autoDeployment?: boolean;
  autoRecoveryEnabled?: boolean;
  requiredReviews?: number;
  educationalContext?: string;
  complianceLevel?: string;
  errorNotifications?: {
    enabled?: boolean;
    channels?: Array<{
      type: 'email' | 'webhook' | 'slack';
      enabled: boolean;
      config: {
        email?: string;
        webhookUrl?: string;
        webhookSecret?: string;
        slackWebhookUrl?: string;
        slackChannel?: string;
      };
    }>;
  };
}

export interface IProjectStats {
  totalTasks?: number;
  completedTasks?: number;
  activeTasks?: number;
  pendingReviews?: number;
}

export interface ITokenStats {
  byModel?: any;
  byAgent?: any;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalTokens?: number;
  totalCost?: number;
  lastUpdated?: Date;
}

export interface IProject {
  id: string;
  _id?: string; // MongoDB compatibility alias for frontend
  name: string;
  description?: string;
  type?: string;
  status?: string;
  userId: string;
  apiKey?: string;
  webhookApiKey?: string;
  devAuth?: IDevAuth;
  settings?: IProjectSettings;
  stats?: IProjectStats;
  tokenStats?: ITokenStats;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  type: string | null;
  status: string | null;
  user_id: string;
  api_key: string | null;
  webhook_api_key: string | null;
  dev_auth: string | null;
  settings: string | null;
  stats: string | null;
  token_stats: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow, includeSecrets = false): IProject {
  const project: IProject = {
    id: row.id,
    _id: row.id, // MongoDB compatibility alias for frontend
    name: row.name,
    description: row.description || undefined,
    type: row.type || undefined,
    status: row.status || undefined,
    userId: row.user_id,
    settings: parseJSON(row.settings, undefined),
    stats: parseJSON(row.stats, undefined),
    tokenStats: parseJSON(row.token_stats, undefined),
    isActive: row.is_active === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };

  if (includeSecrets) {
    project.apiKey = row.api_key || undefined;
    project.webhookApiKey = row.webhook_api_key || undefined;
    project.devAuth = parseJSON(row.dev_auth, undefined);
  }

  return project;
}

export class ProjectRepository {
  /**
   * Find project by ID
   */
  static findById(id: string, includeSecrets = false): IProject | null {
    const stmt = db.prepare(`SELECT * FROM projects WHERE id = ?`);
    const row = stmt.get(id) as ProjectRow | undefined;
    if (!row) return null;

    return rowToProject(row, includeSecrets);
  }

  /**
   * Find projects by user ID
   */
  static findByUserId(userId: string, includeSecrets = false): IProject[] {
    const stmt = db.prepare(`SELECT * FROM projects WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC`);
    const rows = stmt.all(userId) as ProjectRow[];
    return rows.map(row => rowToProject(row, includeSecrets));
  }

  /**
   * Find project by webhook API key
   */
  static findByWebhookApiKey(webhookApiKey: string): IProject | null {
    const stmt = db.prepare(`SELECT * FROM projects WHERE webhook_api_key = ?`);
    const row = stmt.get(webhookApiKey) as ProjectRow | undefined;
    if (!row) return null;

    return rowToProject(row, true);
  }

  /**
   * Find projects by IDs and user ID (security check)
   */
  static findByIdsAndUser(ids: string[], userId: string, includeSecrets = false): IProject[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM projects WHERE id IN (${placeholders}) AND user_id = ? AND is_active = 1`);
    const rows = stmt.all(...ids, userId) as ProjectRow[];
    return rows.map(row => rowToProject(row, includeSecrets));
  }

  /**
   * Create a new project
   */
  static create(data: {
    name: string;
    description?: string;
    type?: string;
    status?: string;
    userId: string;
    apiKey?: string;
    webhookApiKey?: string;
    devAuth?: IDevAuth;
    settings?: IProjectSettings;
  }): IProject {
    const id = generateId();
    const timestamp = now();

    // Encrypt API key if provided
    let encryptedApiKey = data.apiKey;
    if (encryptedApiKey && !CryptoService.isEncrypted(encryptedApiKey)) {
      encryptedApiKey = CryptoService.encrypt(encryptedApiKey);
    }

    // Encrypt devAuth sensitive fields
    let devAuth = data.devAuth;
    if (devAuth) {
      devAuth = { ...devAuth };
      if (devAuth.token && !CryptoService.isEncrypted(devAuth.token)) {
        devAuth.token = CryptoService.encrypt(devAuth.token);
      }
      if (devAuth.credentials?.password && !CryptoService.isEncrypted(devAuth.credentials.password)) {
        devAuth.credentials = {
          ...devAuth.credentials,
          password: CryptoService.encrypt(devAuth.credentials.password),
        };
      }
    }

    const stmt = db.prepare(`
      INSERT INTO projects (
        id, name, description, type, status, user_id,
        api_key, webhook_api_key, dev_auth, settings, stats, token_stats,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.name,
      data.description || null,
      data.type || 'web-app',
      data.status || 'planning',
      data.userId,
      encryptedApiKey || null,
      data.webhookApiKey || null,
      toJSON(devAuth),
      toJSON(data.settings),
      toJSON({ totalTasks: 0, completedTasks: 0, activeTasks: 0, pendingReviews: 0 }),
      toJSON({ totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, totalCost: 0 }),
      1,
      timestamp,
      timestamp
    );

    return this.findById(id, true)!;
  }

  /**
   * Update project
   */
  static update(id: string, data: Partial<{
    name: string;
    description: string;
    type: string;
    status: string;
    apiKey: string;
    webhookApiKey: string;
    devAuth: IDevAuth;
    settings: IProjectSettings;
    stats: IProjectStats;
    tokenStats: ITokenStats;
    isActive: boolean;
  }>): IProject | null {
    const existing = this.findById(id, true);
    if (!existing) return null;

    // Encrypt API key if being updated
    let encryptedApiKey = data.apiKey;
    if (encryptedApiKey && !CryptoService.isEncrypted(encryptedApiKey)) {
      encryptedApiKey = CryptoService.encrypt(encryptedApiKey);
    }

    // Encrypt devAuth sensitive fields
    let devAuth = data.devAuth;
    if (devAuth) {
      devAuth = { ...devAuth };
      if (devAuth.token && !CryptoService.isEncrypted(devAuth.token)) {
        devAuth.token = CryptoService.encrypt(devAuth.token);
      }
      if (devAuth.credentials?.password && !CryptoService.isEncrypted(devAuth.credentials.password)) {
        devAuth.credentials = {
          ...devAuth.credentials,
          password: CryptoService.encrypt(devAuth.credentials.password),
        };
      }
    }

    const stmt = db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        description = COALESCE(?, description),
        type = COALESCE(?, type),
        status = COALESCE(?, status),
        api_key = COALESCE(?, api_key),
        webhook_api_key = COALESCE(?, webhook_api_key),
        dev_auth = COALESCE(?, dev_auth),
        settings = COALESCE(?, settings),
        stats = COALESCE(?, stats),
        token_stats = COALESCE(?, token_stats),
        is_active = COALESCE(?, is_active),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.name || null,
      data.description || null,
      data.type || null,
      data.status || null,
      encryptedApiKey || null,
      data.webhookApiKey || null,
      devAuth ? toJSON(devAuth) : null,
      data.settings ? toJSON(data.settings) : null,
      data.stats ? toJSON(data.stats) : null,
      data.tokenStats ? toJSON(data.tokenStats) : null,
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
      now(),
      id
    );

    return this.findById(id, true);
  }

  /**
   * Delete project (soft delete)
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`UPDATE projects SET is_active = 0, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Hard delete project
   */
  static hardDelete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM projects WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get decrypted API key
   */
  static getDecryptedApiKey(id: string): string | undefined {
    const stmt = db.prepare(`SELECT api_key FROM projects WHERE id = ?`);
    const row = stmt.get(id) as { api_key: string | null } | undefined;
    if (!row?.api_key) return undefined;
    return CryptoService.decrypt(row.api_key);
  }

  /**
   * Get decrypted devAuth
   */
  static getDecryptedDevAuth(id: string): IDevAuth | undefined {
    const stmt = db.prepare(`SELECT dev_auth FROM projects WHERE id = ?`);
    const row = stmt.get(id) as { dev_auth: string | null } | undefined;
    if (!row?.dev_auth) return undefined;

    const devAuth = parseJSON<IDevAuth>(row.dev_auth, { method: 'none' });
    if (devAuth.method === 'none') return undefined;

    // Decrypt sensitive fields
    if (devAuth.token) {
      devAuth.token = CryptoService.decrypt(devAuth.token);
    }
    if (devAuth.credentials?.password) {
      devAuth.credentials = {
        ...devAuth.credentials,
        password: CryptoService.decrypt(devAuth.credentials.password),
      };
    }

    return devAuth;
  }

  /**
   * Update token stats
   */
  static updateTokenStats(id: string, stats: Partial<ITokenStats>): void {
    const existing = this.findById(id, false);
    if (!existing) return;

    const currentStats = existing.tokenStats || {};
    const newStats = {
      ...currentStats,
      ...stats,
      lastUpdated: new Date(),
    };

    const stmt = db.prepare(`UPDATE projects SET token_stats = ?, updated_at = ? WHERE id = ?`);
    stmt.run(toJSON(newStats), now(), id);
  }

  /**
   * Increment project stats
   */
  static incrementStats(id: string, field: keyof IProjectStats, amount = 1): void {
    const existing = this.findById(id, false);
    if (!existing) return;

    const currentStats = existing.stats || {};
    const currentValue = (currentStats[field] as number) || 0;
    const newStats = {
      ...currentStats,
      [field]: currentValue + amount,
    };

    const stmt = db.prepare(`UPDATE projects SET stats = ?, updated_at = ? WHERE id = ?`);
    stmt.run(toJSON(newStats), now(), id);
  }

  /**
   * Count projects by user
   */
  static countByUser(userId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM projects WHERE user_id = ? AND is_active = 1`);
    const row = stmt.get(userId) as { count: number };
    return row.count;
  }
}

export default ProjectRepository;
