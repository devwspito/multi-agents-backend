/**
 * API Key Repository
 *
 * Database operations for API keys with rate limiting
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export interface IRateLimit {
  requestsPerHour: number;
  requestsPerDay: number;
  currentHourRequests: number;
  currentDayRequests: number;
  hourResetAt: Date;
  dayResetAt: Date;
}

export interface IApiKey {
  id: string;
  keyPrefix: string;
  keyHash: string;
  projectId: string;
  userId: string;
  name: string;
  scopes: string[];
  rateLimit: IRateLimit;
  expiresAt?: Date;
  lastUsedAt?: Date;
  totalRequests: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ApiKeyRow {
  id: string;
  key_prefix: string;
  key_hash: string;
  project_id: string;
  user_id: string;
  name: string;
  scopes: string;
  requests_per_hour: number;
  requests_per_day: number;
  current_hour_requests: number;
  current_day_requests: number;
  hour_reset_at: string;
  day_reset_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  total_requests: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToApiKey(row: ApiKeyRow): IApiKey {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    projectId: row.project_id,
    userId: row.user_id,
    name: row.name,
    scopes: JSON.parse(row.scopes),
    rateLimit: {
      requestsPerHour: row.requests_per_hour,
      requestsPerDay: row.requests_per_day,
      currentHourRequests: row.current_hour_requests,
      currentDayRequests: row.current_day_requests,
      hourResetAt: new Date(row.hour_reset_at),
      dayResetAt: new Date(row.day_reset_at),
    },
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
    totalRequests: row.total_requests,
    isActive: row.is_active === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class ApiKeyRepository {
  /**
   * Generate a new API key string
   */
  static generateApiKey(): string {
    const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
    const randomPart = crypto.randomBytes(24).toString('base64url');
    return `ak_${env}_${randomPart}`;
  }

  /**
   * Hash an API key
   */
  static async hashApiKey(plainKey: string): Promise<string> {
    return bcrypt.hash(plainKey, 10);
  }

  /**
   * Verify API key against hash
   */
  static async verifyApiKey(plainKey: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plainKey, hash);
  }

  /**
   * Find API key by ID
   */
  static findById(id: string): IApiKey | null {
    const stmt = db.prepare(`SELECT * FROM api_keys WHERE id = ?`);
    const row = stmt.get(id) as ApiKeyRow | undefined;
    if (!row) return null;

    return rowToApiKey(row);
  }

  /**
   * Find API key by prefix (for lookup during authentication)
   */
  static findByPrefix(prefix: string): IApiKey[] {
    const stmt = db.prepare(`SELECT * FROM api_keys WHERE key_prefix = ? AND is_active = 1`);
    const rows = stmt.all(prefix) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Find API keys by project ID
   */
  static findByProjectId(projectId: string): IApiKey[] {
    const stmt = db.prepare(`SELECT * FROM api_keys WHERE project_id = ? AND is_active = 1 ORDER BY created_at DESC`);
    const rows = stmt.all(projectId) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Find API keys by user ID
   */
  static findByUserId(userId: string): IApiKey[] {
    const stmt = db.prepare(`SELECT * FROM api_keys WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC`);
    const rows = stmt.all(userId) as ApiKeyRow[];
    return rows.map(rowToApiKey);
  }

  /**
   * Create a new API key
   * Returns both the key object and the plain text key (only returned once)
   */
  static async create(data: {
    projectId: string;
    userId: string;
    name: string;
    scopes?: string[];
    requestsPerHour?: number;
    requestsPerDay?: number;
    expiresAt?: Date;
  }): Promise<{ apiKey: IApiKey; plainKey: string }> {
    const id = generateId();
    const timestamp = now();
    const plainKey = this.generateApiKey();
    const keyHash = await this.hashApiKey(plainKey);
    const keyPrefix = plainKey.substring(0, 12); // ak_live_ or ak_test_

    const hourFromNow = new Date(Date.now() + 60 * 60 * 1000);
    const dayFromNow = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const stmt = db.prepare(`
      INSERT INTO api_keys (
        id, key_prefix, key_hash, project_id, user_id, name, scopes,
        requests_per_hour, requests_per_day, current_hour_requests, current_day_requests,
        hour_reset_at, day_reset_at, expires_at, total_requests, is_active,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      keyPrefix,
      keyHash,
      data.projectId,
      data.userId,
      data.name,
      JSON.stringify(data.scopes || ['read']),
      data.requestsPerHour || 1000,
      data.requestsPerDay || 10000,
      0,
      0,
      hourFromNow.toISOString(),
      dayFromNow.toISOString(),
      data.expiresAt?.toISOString() || null,
      0,
      1,
      timestamp,
      timestamp
    );

    return {
      apiKey: this.findById(id)!,
      plainKey,
    };
  }

  /**
   * Check if request is within rate limits
   */
  static checkRateLimit(id: string): { allowed: boolean; resetAt: Date } {
    const apiKey = this.findById(id);
    if (!apiKey) {
      return { allowed: false, resetAt: new Date() };
    }

    const now = new Date();
    let { currentHourRequests, currentDayRequests, hourResetAt, dayResetAt } = apiKey.rateLimit;

    // Reset hourly counter if needed
    if (hourResetAt < now) {
      currentHourRequests = 0;
      hourResetAt = new Date(now.getTime() + 60 * 60 * 1000);
    }

    // Reset daily counter if needed
    if (dayResetAt < now) {
      currentDayRequests = 0;
      dayResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }

    const allowed =
      currentHourRequests < apiKey.rateLimit.requestsPerHour &&
      currentDayRequests < apiKey.rateLimit.requestsPerDay;

    const resetAt = hourResetAt < dayResetAt ? hourResetAt : dayResetAt;

    return { allowed, resetAt };
  }

  /**
   * Increment usage counters
   */
  static incrementUsage(id: string): void {
    const apiKey = this.findById(id);
    if (!apiKey) return;

    const now = new Date();
    let { currentHourRequests, currentDayRequests, hourResetAt, dayResetAt } = apiKey.rateLimit;

    // Reset hourly counter if needed
    if (hourResetAt < now) {
      currentHourRequests = 0;
      hourResetAt = new Date(now.getTime() + 60 * 60 * 1000);
    }

    // Reset daily counter if needed
    if (dayResetAt < now) {
      currentDayRequests = 0;
      dayResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }

    const stmt = db.prepare(`
      UPDATE api_keys SET
        current_hour_requests = ?,
        current_day_requests = ?,
        hour_reset_at = ?,
        day_reset_at = ?,
        total_requests = total_requests + 1,
        last_used_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const timestamp = now.toISOString();
    stmt.run(
      currentHourRequests + 1,
      currentDayRequests + 1,
      hourResetAt.toISOString(),
      dayResetAt.toISOString(),
      timestamp,
      timestamp,
      id
    );
  }

  /**
   * Check if API key is expired
   */
  static isExpired(id: string): boolean {
    const apiKey = this.findById(id);
    if (!apiKey) return true;
    if (!apiKey.expiresAt) return false;
    return apiKey.expiresAt < new Date();
  }

  /**
   * Deactivate API key
   */
  static deactivate(id: string): boolean {
    const stmt = db.prepare(`UPDATE api_keys SET is_active = 0, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Delete API key
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM api_keys WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Update API key name or scopes
   */
  static update(id: string, data: { name?: string; scopes?: string[] }): IApiKey | null {
    const stmt = db.prepare(`
      UPDATE api_keys SET
        name = COALESCE(?, name),
        scopes = COALESCE(?, scopes),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.name || null,
      data.scopes ? JSON.stringify(data.scopes) : null,
      now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Authenticate with API key
   */
  static async authenticate(plainKey: string): Promise<IApiKey | null> {
    const prefix = plainKey.substring(0, 12);
    const candidates = this.findByPrefix(prefix);

    for (const candidate of candidates) {
      const isValid = await this.verifyApiKey(plainKey, candidate.keyHash);
      if (isValid) {
        if (this.isExpired(candidate.id)) {
          return null;
        }
        const { allowed } = this.checkRateLimit(candidate.id);
        if (!allowed) {
          return null;
        }
        this.incrementUsage(candidate.id);
        return candidate;
      }
    }

    return null;
  }
}

export default ApiKeyRepository;
