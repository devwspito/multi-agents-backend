/**
 * Webhook API Key Repository
 *
 * Database operations for webhook API keys
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';
import crypto from 'crypto';

export interface IWebhookApiKey {
  id: string;
  apiKey: string;
  projectId: string;
  name: string;
  isActive: boolean;
  rateLimit: number;
  taskConfig: 'standard' | 'premium' | 'max';
  lastUsedAt?: Date;
  requestCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface WebhookApiKeyRow {
  id: string;
  api_key: string;
  project_id: string;
  name: string;
  is_active: number;
  rate_limit: number;
  task_config: string;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
  updated_at: string;
}

function rowToWebhookApiKey(row: WebhookApiKeyRow): IWebhookApiKey {
  return {
    id: row.id,
    apiKey: row.api_key,
    projectId: row.project_id,
    name: row.name,
    isActive: row.is_active === 1,
    rateLimit: row.rate_limit,
    taskConfig: row.task_config as 'standard' | 'premium' | 'max',
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    requestCount: row.request_count,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class WebhookApiKeyRepository {
  /**
   * Generate a new webhook API key
   */
  static generateApiKey(): string {
    const randomBytes = crypto.randomBytes(32).toString('hex');
    return `whk_${randomBytes}`;
  }

  /**
   * Find by ID
   */
  static findById(id: string): IWebhookApiKey | null {
    const stmt = db.prepare(`SELECT * FROM webhook_api_keys WHERE id = ?`);
    const row = stmt.get(id) as WebhookApiKeyRow | undefined;
    if (!row) return null;

    return rowToWebhookApiKey(row);
  }

  /**
   * Find by API key
   */
  static findByApiKey(apiKey: string): IWebhookApiKey | null {
    const stmt = db.prepare(`SELECT * FROM webhook_api_keys WHERE api_key = ? AND is_active = 1`);
    const row = stmt.get(apiKey) as WebhookApiKeyRow | undefined;
    if (!row) return null;

    return rowToWebhookApiKey(row);
  }

  /**
   * Find by project ID
   */
  static findByProjectId(projectId: string): IWebhookApiKey[] {
    const stmt = db.prepare(`SELECT * FROM webhook_api_keys WHERE project_id = ? ORDER BY created_at DESC`);
    const rows = stmt.all(projectId) as WebhookApiKeyRow[];
    return rows.map(rowToWebhookApiKey);
  }

  /**
   * Create a new webhook API key
   */
  static create(data: {
    projectId: string;
    name: string;
    apiKey?: string;
    isActive?: boolean;
    rateLimit?: number;
    taskConfig?: 'standard' | 'premium' | 'max';
  }): IWebhookApiKey {
    const id = generateId();
    const apiKey = data.apiKey || this.generateApiKey();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO webhook_api_keys (
        id, api_key, project_id, name, is_active, rate_limit, task_config,
        request_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      apiKey,
      data.projectId,
      data.name,
      data.isActive === false ? 0 : 1,
      data.rateLimit || 60,
      data.taskConfig || 'standard',
      0,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Validate API key using constant-time comparison
   */
  static validateApiKey(key: string): IWebhookApiKey | null {
    if (!key || typeof key !== 'string') {
      return null;
    }

    const stmt = db.prepare(`SELECT * FROM webhook_api_keys WHERE is_active = 1`);
    const candidates = stmt.all() as WebhookApiKeyRow[];

    for (const candidate of candidates) {
      try {
        if (crypto.timingSafeEqual(Buffer.from(key), Buffer.from(candidate.api_key))) {
          return rowToWebhookApiKey(candidate);
        }
      } catch {
        // Length mismatch, continue
        continue;
      }
    }

    return null;
  }

  /**
   * Increment request count and update last used
   */
  static incrementUsage(id: string): void {
    const stmt = db.prepare(`
      UPDATE webhook_api_keys SET
        request_count = request_count + 1,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const timestamp = now();
    stmt.run(timestamp, timestamp, id);
  }

  /**
   * Update webhook API key
   */
  static update(id: string, data: {
    name?: string;
    rateLimit?: number;
    taskConfig?: 'standard' | 'premium' | 'max';
    isActive?: boolean;
    apiKey?: string;
    requestCount?: number;
    lastUsedAt?: Date;
  }): IWebhookApiKey | null {
    const stmt = db.prepare(`
      UPDATE webhook_api_keys SET
        name = COALESCE(?, name),
        rate_limit = COALESCE(?, rate_limit),
        task_config = COALESCE(?, task_config),
        is_active = COALESCE(?, is_active),
        api_key = COALESCE(?, api_key),
        request_count = COALESCE(?, request_count),
        last_used_at = COALESCE(?, last_used_at),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.name || null,
      data.rateLimit || null,
      data.taskConfig || null,
      data.isActive !== undefined ? (data.isActive ? 1 : 0) : null,
      data.apiKey || null,
      data.requestCount !== undefined ? data.requestCount : null,
      data.lastUsedAt ? data.lastUsedAt.toISOString() : null,
      now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Deactivate webhook API key
   */
  static deactivate(id: string): boolean {
    const stmt = db.prepare(`UPDATE webhook_api_keys SET is_active = 0, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Delete webhook API key
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM webhook_api_keys WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete all API keys for a project
   */
  static deleteByProjectId(projectId: string): number {
    const stmt = db.prepare(`DELETE FROM webhook_api_keys WHERE project_id = ?`);
    const result = stmt.run(projectId);
    return result.changes;
  }
}

export default WebhookApiKeyRepository;
