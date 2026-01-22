/**
 * Memory Repository
 *
 * Database operations for agent memories
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type MemoryType =
  | 'codebase_pattern'
  | 'error_resolution'
  | 'user_preference'
  | 'architecture_decision'
  | 'api_contract'
  | 'test_pattern'
  | 'dependency_info'
  | 'workflow_learned'
  | 'agent_insight';

export type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';

export interface IMemory {
  id: string;
  projectId: string;
  type: MemoryType;
  importance: MemoryImportance;
  title: string;
  content: string;
  context?: string;
  embedding?: number[];
  embeddingModel?: string;
  source: {
    taskId?: string;
    phase?: string;
    agentType?: string;
  };
  accessCount: number;
  lastAccessedAt?: Date;
  usefulness: number;
  expiresAt?: Date;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MemoryRow {
  id: string;
  project_id: string;
  type: string;
  importance: string;
  title: string;
  content: string;
  context: string | null;
  embedding: string | null;
  embedding_model: string | null;
  source: string | null;
  access_count: number;
  last_accessed_at: string | null;
  usefulness: number;
  expires_at: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

function rowToMemory(row: MemoryRow): IMemory {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as MemoryType,
    importance: row.importance as MemoryImportance,
    title: row.title,
    content: row.content,
    context: row.context || undefined,
    embedding: parseJSON(row.embedding, undefined),
    embeddingModel: row.embedding_model || undefined,
    source: parseJSON(row.source, {}),
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at) : undefined,
    usefulness: row.usefulness,
    expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
    archived: row.archived === 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class MemoryRepository {
  /**
   * Find memory by ID
   */
  static findById(id: string): IMemory | null {
    const stmt = db.prepare(`SELECT * FROM memories WHERE id = ?`);
    const row = stmt.get(id) as MemoryRow | undefined;
    if (!row) return null;

    return rowToMemory(row);
  }

  /**
   * Find memories by project ID
   */
  static findByProjectId(projectId: string, options?: {
    type?: MemoryType;
    importance?: MemoryImportance;
    archived?: boolean;
    limit?: number;
  }): IMemory[] {
    let sql = `SELECT * FROM memories WHERE project_id = ?`;
    const params: any[] = [projectId];

    if (options?.type) {
      sql += ` AND type = ?`;
      params.push(options.type);
    }

    if (options?.importance) {
      sql += ` AND importance = ?`;
      params.push(options.importance);
    }

    if (options?.archived !== undefined) {
      sql += ` AND archived = ?`;
      params.push(options.archived ? 1 : 0);
    } else {
      sql += ` AND archived = 0`;
    }

    sql += ` ORDER BY created_at DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Create a new memory
   */
  static create(data: {
    projectId: string;
    type: MemoryType;
    importance?: MemoryImportance;
    title: string;
    content: string;
    context?: string;
    embedding?: number[];
    embeddingModel?: string;
    source?: {
      taskId?: string;
      phase?: string;
      agentType?: string;
    };
    expiresAt?: Date;
  }): IMemory {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO memories (
        id, project_id, type, importance, title, content, context,
        embedding, embedding_model, source, access_count, usefulness,
        expires_at, archived, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.projectId,
      data.type,
      data.importance || 'medium',
      data.title,
      data.content,
      data.context || null,
      data.embedding ? toJSON(data.embedding) : null,
      data.embeddingModel || null,
      toJSON(data.source || {}),
      0,
      0.5,
      data.expiresAt?.toISOString() || null,
      0,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Update memory
   */
  static update(id: string, data: Partial<{
    type: MemoryType;
    importance: MemoryImportance;
    title: string;
    content: string;
    context: string;
    embedding: number[];
    embeddingModel: string;
    usefulness: number;
    archived: boolean;
  }>): IMemory | null {
    const stmt = db.prepare(`
      UPDATE memories SET
        type = COALESCE(?, type),
        importance = COALESCE(?, importance),
        title = COALESCE(?, title),
        content = COALESCE(?, content),
        context = COALESCE(?, context),
        embedding = COALESCE(?, embedding),
        embedding_model = COALESCE(?, embedding_model),
        usefulness = COALESCE(?, usefulness),
        archived = COALESCE(?, archived),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.type || null,
      data.importance || null,
      data.title || null,
      data.content || null,
      data.context || null,
      data.embedding ? toJSON(data.embedding) : null,
      data.embeddingModel || null,
      data.usefulness || null,
      data.archived !== undefined ? (data.archived ? 1 : 0) : null,
      now(),
      id
    );

    return this.findById(id);
  }

  /**
   * Increment access count
   */
  static incrementAccess(id: string): void {
    const stmt = db.prepare(`
      UPDATE memories SET
        access_count = access_count + 1,
        last_accessed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const timestamp = now();
    stmt.run(timestamp, timestamp, id);
  }

  /**
   * Update usefulness score
   */
  static updateUsefulness(id: string, delta: number): void {
    const memory = this.findById(id);
    if (!memory) return;

    const newUsefulness = Math.max(0, Math.min(1, memory.usefulness + delta));
    const stmt = db.prepare(`UPDATE memories SET usefulness = ?, updated_at = ? WHERE id = ?`);
    stmt.run(newUsefulness, now(), id);
  }

  /**
   * Archive memory
   */
  static archive(id: string): boolean {
    const stmt = db.prepare(`UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Delete memory
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM memories WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Search memories by text (simple substring match)
   */
  static search(projectId: string, query: string, limit = 10): IMemory[] {
    const stmt = db.prepare(`
      SELECT * FROM memories
      WHERE project_id = ?
      AND archived = 0
      AND (title LIKE ? OR content LIKE ?)
      ORDER BY usefulness DESC, access_count DESC
      LIMIT ?
    `);
    const pattern = `%${query}%`;
    const rows = stmt.all(projectId, pattern, pattern, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Find most useful memories
   */
  static findMostUseful(projectId: string, limit = 10): IMemory[] {
    const stmt = db.prepare(`
      SELECT * FROM memories
      WHERE project_id = ? AND archived = 0
      ORDER BY usefulness DESC, access_count DESC
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  /**
   * Clean up expired memories
   */
  static cleanupExpired(): number {
    const stmt = db.prepare(`DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`);
    const result = stmt.run(now());
    return result.changes;
  }

  /**
   * Count memories by project
   */
  static countByProject(projectId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM memories WHERE project_id = ? AND archived = 0`);
    const row = stmt.get(projectId) as { count: number };
    return row.count;
  }
}

export default MemoryRepository;
