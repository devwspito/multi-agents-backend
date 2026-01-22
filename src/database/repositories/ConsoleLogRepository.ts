/**
 * Console Log Repository
 *
 * Database operations for console logs
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';

export interface IConsoleLog {
  id: string;
  taskId: string;
  timestamp: Date;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  createdAt: Date;
}

interface ConsoleLogRow {
  id: string;
  task_id: string;
  timestamp: string;
  level: string;
  message: string;
  created_at: string;
}

function rowToConsoleLog(row: ConsoleLogRow): IConsoleLog {
  return {
    id: row.id,
    taskId: row.task_id,
    timestamp: new Date(row.timestamp),
    level: row.level as 'log' | 'info' | 'warn' | 'error',
    message: row.message,
    createdAt: new Date(row.created_at),
  };
}

export class ConsoleLogRepository {
  /**
   * Create a new console log entry
   */
  static create(data: {
    taskId: string;
    level: 'log' | 'info' | 'warn' | 'error';
    message: string;
    timestamp?: Date;
  }): IConsoleLog {
    const id = generateId();
    const timestamp = (data.timestamp || new Date()).toISOString();
    const createdAt = now();

    const stmt = db.prepare(`
      INSERT INTO console_logs (id, task_id, timestamp, level, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, data.taskId, timestamp, data.level, data.message, createdAt);

    return {
      id,
      taskId: data.taskId,
      timestamp: new Date(timestamp),
      level: data.level,
      message: data.message,
      createdAt: new Date(createdAt),
    };
  }

  /**
   * Find console logs by task ID
   */
  static findByTaskId(taskId: string, options?: { limit?: number; offset?: number }): IConsoleLog[] {
    let sql = `SELECT * FROM console_logs WHERE task_id = ? ORDER BY timestamp DESC`;
    const params: any[] = [taskId];

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options?.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as ConsoleLogRow[];
    return rows.map(rowToConsoleLog);
  }

  /**
   * Find console logs by task ID and level
   */
  static findByTaskIdAndLevel(taskId: string, level: 'log' | 'info' | 'warn' | 'error'): IConsoleLog[] {
    const stmt = db.prepare(`SELECT * FROM console_logs WHERE task_id = ? AND level = ? ORDER BY timestamp DESC`);
    const rows = stmt.all(taskId, level) as ConsoleLogRow[];
    return rows.map(rowToConsoleLog);
  }

  /**
   * Delete console logs by task ID
   */
  static deleteByTaskId(taskId: string): number {
    const stmt = db.prepare(`DELETE FROM console_logs WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Delete old console logs (cleanup)
   */
  static deleteOlderThan(date: Date): number {
    const stmt = db.prepare(`DELETE FROM console_logs WHERE created_at < ?`);
    const result = stmt.run(date.toISOString());
    return result.changes;
  }

  /**
   * Count logs by task
   */
  static countByTaskId(taskId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM console_logs WHERE task_id = ?`);
    const row = stmt.get(taskId) as { count: number };
    return row.count;
  }

  /**
   * Bulk create console logs
   */
  static bulkCreate(logs: Array<{
    taskId: string;
    level: 'log' | 'info' | 'warn' | 'error';
    message: string;
    timestamp?: Date;
  }>): number {
    const stmt = db.prepare(`
      INSERT INTO console_logs (id, task_id, timestamp, level, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const createdAt = now();
    let count = 0;

    const insertMany = db.transaction((items: typeof logs) => {
      for (const item of items) {
        const id = generateId();
        const timestamp = (item.timestamp || new Date()).toISOString();
        stmt.run(id, item.taskId, timestamp, item.level, item.message, createdAt);
        count++;
      }
    });

    insertMany(logs);
    return count;
  }
}

export default ConsoleLogRepository;
