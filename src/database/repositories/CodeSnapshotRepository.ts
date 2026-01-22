/**
 * Code Snapshot Repository
 *
 * Database operations for code snapshots
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

export interface IFileChange {
  path: string;
  changeType: ChangeType;
  linesAdded: number;
  linesDeleted: number;
  diff?: string;
  content?: string;
}

export interface ICodeSnapshot {
  id: string;
  taskId: string;
  timestamp: Date;
  phase: 'development' | 'judge' | 'merge' | 'auto-merge';
  agentType: string;
  agentInstanceId: string;
  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;
  repositoryName: string;
  branchName: string;
  commitHash?: string;
  commitMessage?: string;
  fileChanges: IFileChange[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface CodeSnapshotRow {
  id: string;
  task_id: string;
  timestamp: string;
  phase: string;
  agent_type: string;
  agent_instance_id: string;
  epic_id: string | null;
  epic_name: string | null;
  story_id: string | null;
  story_title: string | null;
  repository_name: string;
  branch_name: string;
  commit_hash: string | null;
  commit_message: string | null;
  file_changes: string | null;
  total_files_changed: number;
  total_lines_added: number;
  total_lines_deleted: number;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCodeSnapshot(row: CodeSnapshotRow): ICodeSnapshot {
  return {
    id: row.id,
    taskId: row.task_id,
    timestamp: new Date(row.timestamp),
    phase: row.phase as 'development' | 'judge' | 'merge' | 'auto-merge',
    agentType: row.agent_type,
    agentInstanceId: row.agent_instance_id,
    epicId: row.epic_id || undefined,
    epicName: row.epic_name || undefined,
    storyId: row.story_id || undefined,
    storyTitle: row.story_title || undefined,
    repositoryName: row.repository_name,
    branchName: row.branch_name,
    commitHash: row.commit_hash || undefined,
    commitMessage: row.commit_message || undefined,
    fileChanges: parseJSON(row.file_changes, []),
    totalFilesChanged: row.total_files_changed,
    totalLinesAdded: row.total_lines_added,
    totalLinesDeleted: row.total_lines_deleted,
    sessionId: row.session_id || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class CodeSnapshotRepository {
  /**
   * Find by ID
   */
  static findById(id: string): ICodeSnapshot | null {
    const stmt = db.prepare(`SELECT * FROM code_snapshots WHERE id = ?`);
    const row = stmt.get(id) as CodeSnapshotRow | undefined;
    if (!row) return null;

    return rowToCodeSnapshot(row);
  }

  /**
   * Find by task ID
   */
  static findByTaskId(taskId: string, options?: { limit?: number }): ICodeSnapshot[] {
    let sql = `SELECT * FROM code_snapshots WHERE task_id = ? ORDER BY timestamp DESC`;
    const params: any[] = [taskId];

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as CodeSnapshotRow[];
    return rows.map(rowToCodeSnapshot);
  }

  /**
   * Find by agent instance
   */
  static findByAgentInstanceId(taskId: string, agentInstanceId: string): ICodeSnapshot[] {
    const stmt = db.prepare(`SELECT * FROM code_snapshots WHERE task_id = ? AND agent_instance_id = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, agentInstanceId) as CodeSnapshotRow[];
    return rows.map(rowToCodeSnapshot);
  }

  /**
   * Find by epic ID
   */
  static findByEpicId(taskId: string, epicId: string): ICodeSnapshot[] {
    const stmt = db.prepare(`SELECT * FROM code_snapshots WHERE task_id = ? AND epic_id = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, epicId) as CodeSnapshotRow[];
    return rows.map(rowToCodeSnapshot);
  }

  /**
   * Find by story ID
   */
  static findByStoryId(taskId: string, storyId: string): ICodeSnapshot[] {
    const stmt = db.prepare(`SELECT * FROM code_snapshots WHERE task_id = ? AND story_id = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, storyId) as CodeSnapshotRow[];
    return rows.map(rowToCodeSnapshot);
  }

  /**
   * Create a new code snapshot
   */
  static create(data: {
    taskId: string;
    phase: 'development' | 'judge' | 'merge' | 'auto-merge';
    agentType: string;
    agentInstanceId: string;
    repositoryName: string;
    branchName: string;
    epicId?: string;
    epicName?: string;
    storyId?: string;
    storyTitle?: string;
    commitHash?: string;
    commitMessage?: string;
    fileChanges: IFileChange[];
    sessionId?: string;
    timestamp?: Date;
  }): ICodeSnapshot {
    const id = generateId();
    const timestamp = (data.timestamp || new Date()).toISOString();
    const createdAt = now();

    // Calculate totals
    const totalFilesChanged = data.fileChanges.length;
    const totalLinesAdded = data.fileChanges.reduce((sum, f) => sum + f.linesAdded, 0);
    const totalLinesDeleted = data.fileChanges.reduce((sum, f) => sum + f.linesDeleted, 0);

    const stmt = db.prepare(`
      INSERT INTO code_snapshots (
        id, task_id, timestamp, phase, agent_type, agent_instance_id,
        epic_id, epic_name, story_id, story_title,
        repository_name, branch_name, commit_hash, commit_message,
        file_changes, total_files_changed, total_lines_added, total_lines_deleted,
        session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      timestamp,
      data.phase,
      data.agentType,
      data.agentInstanceId,
      data.epicId || null,
      data.epicName || null,
      data.storyId || null,
      data.storyTitle || null,
      data.repositoryName,
      data.branchName,
      data.commitHash || null,
      data.commitMessage || null,
      toJSON(data.fileChanges),
      totalFilesChanged,
      totalLinesAdded,
      totalLinesDeleted,
      data.sessionId || null,
      createdAt,
      createdAt
    );

    return this.findById(id)!;
  }

  /**
   * Delete by task ID
   */
  static deleteByTaskId(taskId: string): number {
    const stmt = db.prepare(`DELETE FROM code_snapshots WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Get task statistics
   */
  static getTaskStats(taskId: string): { totalSnapshots: number; totalFilesChanged: number; totalLinesAdded: number; totalLinesDeleted: number } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as totalSnapshots,
        SUM(total_files_changed) as totalFilesChanged,
        SUM(total_lines_added) as totalLinesAdded,
        SUM(total_lines_deleted) as totalLinesDeleted
      FROM code_snapshots
      WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as any;
    return {
      totalSnapshots: row.totalSnapshots || 0,
      totalFilesChanged: row.totalFilesChanged || 0,
      totalLinesAdded: row.totalLinesAdded || 0,
      totalLinesDeleted: row.totalLinesDeleted || 0,
    };
  }

  /**
   * Clean up old snapshots
   */
  static cleanupOld(daysOld: number = 30): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`DELETE FROM code_snapshots WHERE created_at < ?`);
    const result = stmt.run(cutoff);
    return result.changes;
  }
}

export default CodeSnapshotRepository;
