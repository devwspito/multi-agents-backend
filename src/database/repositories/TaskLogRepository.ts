/**
 * Task Log Repository
 *
 * Database operations for structured task logs
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type LogLevel = 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG';
export type LogCategory =
  | 'orchestration'
  | 'agent'
  | 'developer'
  | 'story'
  | 'epic'
  | 'judge'
  | 'quality'
  | 'git'
  | 'pr'
  | 'notification'
  | 'system'
  | 'auto_merge'
  | 'branch_cleanup'
  | 'webhook'
  | 'scheduled_cleanup'
  | 'integration'
  | 'error'
  | 'agent-failure'
  | 'security';

export interface ITaskLog {
  id: string;
  taskId: string;
  timestamp: Date;
  level: LogLevel;
  category: LogCategory;
  message: string;
  phase?: string;
  agentType?: string;
  agentInstanceId?: string;
  epicId?: string;
  epicName?: string;
  storyId?: string;
  storyTitle?: string;
  metadata?: Record<string, any>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  sessionId?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TaskLogRow {
  id: string;
  task_id: string;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  phase: string | null;
  agent_type: string | null;
  agent_instance_id: string | null;
  epic_id: string | null;
  epic_name: string | null;
  story_id: string | null;
  story_title: string | null;
  metadata: string | null;
  error_message: string | null;
  error_stack: string | null;
  error_code: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTaskLog(row: TaskLogRow): ITaskLog {
  const log: ITaskLog = {
    id: row.id,
    taskId: row.task_id,
    timestamp: new Date(row.timestamp),
    level: row.level as LogLevel,
    category: row.category as LogCategory,
    message: row.message,
    phase: row.phase || undefined,
    agentType: row.agent_type || undefined,
    agentInstanceId: row.agent_instance_id || undefined,
    epicId: row.epic_id || undefined,
    epicName: row.epic_name || undefined,
    storyId: row.story_id || undefined,
    storyTitle: row.story_title || undefined,
    metadata: parseJSON(row.metadata, undefined),
    sessionId: row.session_id || undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };

  if (row.error_message) {
    log.error = {
      message: row.error_message,
      stack: row.error_stack || undefined,
      code: row.error_code || undefined,
    };
  }

  return log;
}

export class TaskLogRepository {
  /**
   * Create a new task log entry
   */
  static create(data: {
    taskId: string;
    level: LogLevel;
    category: LogCategory;
    message: string;
    phase?: string;
    agentType?: string;
    agentInstanceId?: string;
    epicId?: string;
    epicName?: string;
    storyId?: string;
    storyTitle?: string;
    metadata?: Record<string, any>;
    error?: { message: string; stack?: string; code?: string };
    sessionId?: string;
    timestamp?: Date;
  }): ITaskLog {
    const id = generateId();
    const timestamp = (data.timestamp || new Date()).toISOString();
    const createdAt = now();

    const stmt = db.prepare(`
      INSERT INTO task_logs (
        id, task_id, timestamp, level, category, message,
        phase, agent_type, agent_instance_id,
        epic_id, epic_name, story_id, story_title,
        metadata, error_message, error_stack, error_code, session_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      timestamp,
      data.level,
      data.category,
      data.message,
      data.phase || null,
      data.agentType || null,
      data.agentInstanceId || null,
      data.epicId || null,
      data.epicName || null,
      data.storyId || null,
      data.storyTitle || null,
      toJSON(data.metadata || null),
      data.error?.message || null,
      data.error?.stack || null,
      data.error?.code || null,
      data.sessionId || null,
      createdAt,
      createdAt
    );

    return this.findById(id)!;
  }

  /**
   * Find task log by ID
   */
  static findById(id: string): ITaskLog | null {
    const stmt = db.prepare(`SELECT * FROM task_logs WHERE id = ?`);
    const row = stmt.get(id) as TaskLogRow | undefined;
    if (!row) return null;

    return rowToTaskLog(row);
  }

  /**
   * Find task logs by task ID
   */
  static findByTaskId(taskId: string, options?: {
    limit?: number;
    offset?: number;
    level?: LogLevel;
    category?: LogCategory;
  }): ITaskLog[] {
    let sql = `SELECT * FROM task_logs WHERE task_id = ?`;
    const params: any[] = [taskId];

    if (options?.level) {
      sql += ` AND level = ?`;
      params.push(options.level);
    }

    if (options?.category) {
      sql += ` AND category = ?`;
      params.push(options.category);
    }

    sql += ` ORDER BY timestamp DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }

  /**
   * Find task logs by agent type
   */
  static findByAgentType(taskId: string, agentType: string): ITaskLog[] {
    const stmt = db.prepare(`SELECT * FROM task_logs WHERE task_id = ? AND agent_type = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, agentType) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }

  /**
   * Find task logs by epic ID
   */
  static findByEpicId(taskId: string, epicId: string): ITaskLog[] {
    const stmt = db.prepare(`SELECT * FROM task_logs WHERE task_id = ? AND epic_id = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, epicId) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }

  /**
   * Find task logs by story ID
   */
  static findByStoryId(taskId: string, storyId: string): ITaskLog[] {
    const stmt = db.prepare(`SELECT * FROM task_logs WHERE task_id = ? AND story_id = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, storyId) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }

  /**
   * Find error logs for task
   */
  static findErrors(taskId: string): ITaskLog[] {
    const stmt = db.prepare(`SELECT * FROM task_logs WHERE task_id = ? AND level = 'ERROR' ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }

  /**
   * Delete task logs by task ID
   */
  static deleteByTaskId(taskId: string): number {
    const stmt = db.prepare(`DELETE FROM task_logs WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Delete old task logs (cleanup)
   */
  static deleteOlderThan(date: Date): number {
    const stmt = db.prepare(`DELETE FROM task_logs WHERE created_at < ?`);
    const result = stmt.run(date.toISOString());
    return result.changes;
  }

  /**
   * Count logs by task
   */
  static countByTaskId(taskId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM task_logs WHERE task_id = ?`);
    const row = stmt.get(taskId) as { count: number };
    return row.count;
  }

  /**
   * Get log summary for task
   */
  static getSummary(taskId: string): Record<LogLevel, number> {
    const stmt = db.prepare(`
      SELECT level, COUNT(*) as count
      FROM task_logs
      WHERE task_id = ?
      GROUP BY level
    `);
    const rows = stmt.all(taskId) as { level: string; count: number }[];

    const result: Record<LogLevel, number> = {
      INFO: 0,
      SUCCESS: 0,
      WARN: 0,
      ERROR: 0,
      DEBUG: 0,
    };

    for (const row of rows) {
      result[row.level as LogLevel] = row.count;
    }

    return result;
  }

  /**
   * Bulk create task logs
   */
  static bulkCreate(logs: Array<Parameters<typeof TaskLogRepository.create>[0]>): number {
    const stmt = db.prepare(`
      INSERT INTO task_logs (
        id, task_id, timestamp, level, category, message,
        phase, agent_type, agent_instance_id,
        epic_id, epic_name, story_id, story_title,
        metadata, error_message, error_stack, error_code, session_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const createdAt = now();

    const insertMany = db.transaction((items: typeof logs) => {
      for (const data of items) {
        const id = generateId();
        const timestamp = (data.timestamp || new Date()).toISOString();

        stmt.run(
          id,
          data.taskId,
          timestamp,
          data.level,
          data.category,
          data.message,
          data.phase || null,
          data.agentType || null,
          data.agentInstanceId || null,
          data.epicId || null,
          data.epicName || null,
          data.storyId || null,
          data.storyTitle || null,
          toJSON(data.metadata || null),
          data.error?.message || null,
          data.error?.stack || null,
          data.error?.code || null,
          data.sessionId || null,
          createdAt,
          createdAt
        );
        count++;
      }
    });

    insertMany(logs);
    return count;
  }
}

export default TaskLogRepository;
