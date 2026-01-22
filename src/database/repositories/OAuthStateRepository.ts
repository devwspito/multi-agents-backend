/**
 * OAuth State Repository
 *
 * Database operations for OAuth state tokens
 * Used for CSRF protection during OAuth flows
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';

export interface IOAuthState {
  id: string;
  state: string;
  createdAt: Date;
}

interface OAuthStateRow {
  id: string;
  state: string;
  created_at: string;
}

function rowToOAuthState(row: OAuthStateRow): IOAuthState {
  return {
    id: row.id,
    state: row.state,
    createdAt: new Date(row.created_at),
  };
}

export class OAuthStateRepository {
  /**
   * Create a new OAuth state
   */
  static create(state: string): IOAuthState {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`INSERT INTO oauth_states (id, state, created_at) VALUES (?, ?, ?)`);
    stmt.run(id, state, timestamp);

    return {
      id,
      state,
      createdAt: new Date(timestamp),
    };
  }

  /**
   * Find OAuth state by state value
   */
  static findByState(state: string): IOAuthState | null {
    const stmt = db.prepare(`SELECT * FROM oauth_states WHERE state = ?`);
    const row = stmt.get(state) as OAuthStateRow | undefined;
    if (!row) return null;

    return rowToOAuthState(row);
  }

  /**
   * Delete OAuth state by state value (after verification)
   */
  static deleteByState(state: string): boolean {
    const stmt = db.prepare(`DELETE FROM oauth_states WHERE state = ?`);
    const result = stmt.run(state);
    return result.changes > 0;
  }

  /**
   * Clean up expired states (older than 10 minutes)
   */
  static cleanupExpired(): number {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stmt = db.prepare(`DELETE FROM oauth_states WHERE created_at < ?`);
    const result = stmt.run(tenMinutesAgo);
    return result.changes;
  }

  /**
   * Verify and consume OAuth state
   * Returns true if state was valid, false otherwise
   * The state is deleted after verification
   */
  static verifyAndConsume(state: string): boolean {
    const oauthState = this.findByState(state);
    if (!oauthState) return false;

    // Check if state is not expired (10 minutes)
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    if (oauthState.createdAt.getTime() < tenMinutesAgo) {
      this.deleteByState(state);
      return false;
    }

    // Delete and return success
    this.deleteByState(state);
    return true;
  }
}

export default OAuthStateRepository;
