/**
 * User Repository
 *
 * Database operations for users
 */

import db from '../index.js';
import { generateId, now, stringToDate } from '../utils.js';
import { CryptoService } from '../../services/CryptoService.js';

export interface IUser {
  id: string;
  githubId: string;
  username: string;
  email: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  defaultApiKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: string;
  github_id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  access_token: string;
  refresh_token: string | null;
  token_expiry: string | null;
  default_api_key: string | null;
  created_at: string;
  updated_at: string;
}

function rowToUser(row: UserRow): IUser {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url || undefined,
    accessToken: row.access_token,
    refreshToken: row.refresh_token || undefined,
    tokenExpiry: stringToDate(row.token_expiry),
    defaultApiKey: row.default_api_key || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class UserRepository {
  /**
   * Find user by ID
   */
  static findById(id: string, includeSecrets = false): IUser | null {
    const columns = includeSecrets
      ? '*'
      : 'id, github_id, username, email, avatar_url, created_at, updated_at';

    const stmt = db.prepare(`SELECT ${columns} FROM users WHERE id = ?`);
    const row = stmt.get(id) as UserRow | undefined;
    if (!row) return null;

    // For non-secret queries, we need to add placeholder values
    if (!includeSecrets) {
      (row as any).access_token = '';
      (row as any).refresh_token = null;
      (row as any).token_expiry = null;
      (row as any).default_api_key = null;
    }

    return rowToUser(row);
  }

  /**
   * Find user by GitHub ID
   */
  static findByGithubId(githubId: string, includeSecrets = false): IUser | null {
    const columns = includeSecrets
      ? '*'
      : 'id, github_id, username, email, avatar_url, created_at, updated_at';

    const stmt = db.prepare(`SELECT ${columns} FROM users WHERE github_id = ?`);
    const row = stmt.get(githubId) as UserRow | undefined;
    if (!row) return null;

    if (!includeSecrets) {
      (row as any).access_token = '';
      (row as any).refresh_token = null;
      (row as any).token_expiry = null;
      (row as any).default_api_key = null;
    }

    return rowToUser(row);
  }

  /**
   * Find user by email
   */
  static findByEmail(email: string): IUser | null {
    const stmt = db.prepare(`SELECT * FROM users WHERE email = ?`);
    const row = stmt.get(email) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  /**
   * Create a new user
   */
  static create(data: {
    githubId: string;
    username: string;
    email: string;
    avatarUrl?: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    defaultApiKey?: string;
  }): IUser {
    const id = generateId();
    const timestamp = now();

    // Encrypt API key if provided
    let encryptedApiKey = data.defaultApiKey;
    if (encryptedApiKey && !CryptoService.isEncrypted(encryptedApiKey)) {
      encryptedApiKey = CryptoService.encrypt(encryptedApiKey);
    }

    const stmt = db.prepare(`
      INSERT INTO users (
        id, github_id, username, email, avatar_url,
        access_token, refresh_token, token_expiry, default_api_key,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.githubId,
      data.username,
      data.email,
      data.avatarUrl || null,
      data.accessToken,
      data.refreshToken || null,
      data.tokenExpiry?.toISOString() || null,
      encryptedApiKey || null,
      timestamp,
      timestamp
    );

    return this.findById(id, true)!;
  }

  /**
   * Update user
   */
  static update(id: string, data: Partial<{
    username: string;
    email: string;
    avatarUrl: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiry: Date;
    defaultApiKey: string;
  }>): IUser | null {
    const existing = this.findById(id, true);
    if (!existing) return null;

    // Encrypt API key if being updated
    let encryptedApiKey = data.defaultApiKey;
    if (encryptedApiKey && !CryptoService.isEncrypted(encryptedApiKey)) {
      encryptedApiKey = CryptoService.encrypt(encryptedApiKey);
    }

    const stmt = db.prepare(`
      UPDATE users SET
        username = COALESCE(?, username),
        email = COALESCE(?, email),
        avatar_url = COALESCE(?, avatar_url),
        access_token = COALESCE(?, access_token),
        refresh_token = COALESCE(?, refresh_token),
        token_expiry = COALESCE(?, token_expiry),
        default_api_key = COALESCE(?, default_api_key),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.username || null,
      data.email || null,
      data.avatarUrl || null,
      data.accessToken || null,
      data.refreshToken || null,
      data.tokenExpiry?.toISOString() || null,
      encryptedApiKey || null,
      now(),
      id
    );

    return this.findById(id, true);
  }

  /**
   * Find or create user by GitHub ID
   */
  static findOrCreate(data: {
    githubId: string;
    username: string;
    email: string;
    avatarUrl?: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: Date;
  }): IUser {
    const existing = this.findByGithubId(data.githubId, true);
    if (existing) {
      // Update tokens
      return this.update(existing.id, {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiry: data.tokenExpiry,
        avatarUrl: data.avatarUrl,
        username: data.username,
        email: data.email,
      })!;
    }
    return this.create(data);
  }

  /**
   * Delete user
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM users WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Get decrypted API key
   */
  static getDecryptedApiKey(id: string): string | undefined {
    const stmt = db.prepare(`SELECT default_api_key FROM users WHERE id = ?`);
    const row = stmt.get(id) as { default_api_key: string | null } | undefined;
    if (!row?.default_api_key) return undefined;
    return CryptoService.decrypt(row.default_api_key);
  }

  /**
   * Get access token (for GitHub API calls)
   */
  static getAccessToken(id: string): string | undefined {
    const stmt = db.prepare(`SELECT access_token FROM users WHERE id = ?`);
    const row = stmt.get(id) as { access_token: string } | undefined;
    return row?.access_token;
  }

  /**
   * Find any user with a valid access token
   */
  static findWithAccessToken(): IUser | null {
    const stmt = db.prepare(`SELECT * FROM users WHERE access_token IS NOT NULL AND access_token != '' LIMIT 1`);
    const row = stmt.get() as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }
}

export default UserRepository;
