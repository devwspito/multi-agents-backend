/**
 * Quick Task Execution Repository
 *
 * Stores team-lite executions for retry/resume capabilities.
 * Extends the execution checkpoint concept with quick-task specific fields.
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type QuickTaskStatus = 'running' | 'completed' | 'failed' | 'paused';

export interface IQuickTaskExecution {
  id: string;
  taskId: string;
  command: string;
  mode: 'code' | 'explore' | 'ask' | 'plan';
  model: 'opus' | 'sonnet' | 'haiku';
  status: QuickTaskStatus;

  // SDK session for resume
  sdkSessionId?: string;
  lastMessageUuid?: string;
  canResume: boolean;

  // Workspace context
  workspacePath: string;
  sandboxId?: string;

  // Execution results
  output?: string;
  filesModified: string[];
  filesCreated: string[];
  toolsUsed: string[];
  turnsCompleted: number;

  // Cost tracking
  cost: number;
  duration: number;

  // Judge result (if enabled)
  judgeApproved?: boolean;
  judgeFeedback?: string;

  // Error info (for retry)
  error?: string;
  errorStack?: string;

  // Timestamps
  startedAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface QuickTaskExecutionRow {
  id: string;
  task_id: string;
  command: string;
  mode: string;
  model: string;
  status: string;
  sdk_session_id: string | null;
  last_message_uuid: string | null;
  can_resume: number;
  workspace_path: string;
  sandbox_id: string | null;
  output: string | null;
  files_modified: string | null;
  files_created: string | null;
  tools_used: string | null;
  turns_completed: number;
  cost: number;
  duration: number;
  judge_approved: number | null;
  judge_feedback: string | null;
  error: string | null;
  error_stack: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToExecution(row: QuickTaskExecutionRow): IQuickTaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    command: row.command,
    mode: row.mode as IQuickTaskExecution['mode'],
    model: row.model as IQuickTaskExecution['model'],
    status: row.status as QuickTaskStatus,
    sdkSessionId: row.sdk_session_id || undefined,
    lastMessageUuid: row.last_message_uuid || undefined,
    canResume: row.can_resume === 1,
    workspacePath: row.workspace_path,
    sandboxId: row.sandbox_id || undefined,
    output: row.output || undefined,
    filesModified: parseJSON(row.files_modified, []),
    filesCreated: parseJSON(row.files_created, []),
    toolsUsed: parseJSON(row.tools_used, []),
    turnsCompleted: row.turns_completed,
    cost: row.cost,
    duration: row.duration,
    judgeApproved: row.judge_approved !== null ? row.judge_approved === 1 : undefined,
    judgeFeedback: row.judge_feedback || undefined,
    error: row.error || undefined,
    errorStack: row.error_stack || undefined,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class QuickTaskExecutionRepository {
  /**
   * Initialize table (called on startup)
   */
  static initialize(): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quick_task_executions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        command TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'code',
        model TEXT NOT NULL DEFAULT 'sonnet',
        status TEXT NOT NULL DEFAULT 'running',
        sdk_session_id TEXT,
        last_message_uuid TEXT,
        can_resume INTEGER NOT NULL DEFAULT 0,
        workspace_path TEXT NOT NULL,
        sandbox_id TEXT,
        output TEXT,
        files_modified TEXT DEFAULT '[]',
        files_created TEXT DEFAULT '[]',
        tools_used TEXT DEFAULT '[]',
        turns_completed INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0,
        judge_approved INTEGER,
        judge_feedback TEXT,
        error TEXT,
        error_stack TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Index for fast lookup by task
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quick_task_executions_task_id
      ON quick_task_executions(task_id)
    `);

    // Index for finding resumable executions
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_quick_task_executions_status
      ON quick_task_executions(status)
    `);
  }

  /**
   * Find by ID
   */
  static findById(id: string): IQuickTaskExecution | null {
    const stmt = db.prepare(`SELECT * FROM quick_task_executions WHERE id = ?`);
    const row = stmt.get(id) as QuickTaskExecutionRow | undefined;
    if (!row) return null;
    return rowToExecution(row);
  }

  /**
   * Find latest execution for a task
   */
  static findLatestByTaskId(taskId: string): IQuickTaskExecution | null {
    const stmt = db.prepare(`
      SELECT * FROM quick_task_executions
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(taskId) as QuickTaskExecutionRow | undefined;
    if (!row) return null;
    return rowToExecution(row);
  }

  /**
   * Find all executions for a task (history)
   */
  static findByTaskId(taskId: string, limit: number = 20): IQuickTaskExecution[] {
    const stmt = db.prepare(`
      SELECT * FROM quick_task_executions
      WHERE task_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(taskId, limit) as QuickTaskExecutionRow[];
    return rows.map(rowToExecution);
  }

  /**
   * Find running execution for a task
   */
  static findRunningByTaskId(taskId: string): IQuickTaskExecution | null {
    const stmt = db.prepare(`
      SELECT * FROM quick_task_executions
      WHERE task_id = ? AND status = 'running'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(taskId) as QuickTaskExecutionRow | undefined;
    if (!row) return null;
    return rowToExecution(row);
  }

  /**
   * Find paused execution that can be resumed
   */
  static findResumableByTaskId(taskId: string): IQuickTaskExecution | null {
    const stmt = db.prepare(`
      SELECT * FROM quick_task_executions
      WHERE task_id = ? AND status = 'paused' AND can_resume = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(taskId) as QuickTaskExecutionRow | undefined;
    if (!row) return null;
    return rowToExecution(row);
  }

  /**
   * Find failed execution for retry
   */
  static findFailedByTaskId(taskId: string): IQuickTaskExecution | null {
    const stmt = db.prepare(`
      SELECT * FROM quick_task_executions
      WHERE task_id = ? AND status = 'failed'
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(taskId) as QuickTaskExecutionRow | undefined;
    if (!row) return null;
    return rowToExecution(row);
  }

  /**
   * Create a new execution
   */
  static create(data: {
    taskId: string;
    command: string;
    mode: 'code' | 'explore' | 'ask' | 'plan';
    model: 'opus' | 'sonnet' | 'haiku';
    workspacePath: string;
    sandboxId?: string;
  }): IQuickTaskExecution {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO quick_task_executions (
        id, task_id, command, mode, model, status,
        can_resume, workspace_path, sandbox_id,
        turns_completed, cost, duration,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'running', 0, ?, ?, 0, 0, 0, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.command,
      data.mode,
      data.model,
      data.workspacePath,
      data.sandboxId || null,
      timestamp,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Update execution progress (during execution)
   */
  static updateProgress(id: string, data: {
    sdkSessionId?: string;
    lastMessageUuid?: string;
    canResume?: boolean;
    turnsCompleted?: number;
    filesModified?: string[];
    filesCreated?: string[];
    toolsUsed?: string[];
    cost?: number;
  }): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE quick_task_executions SET
        sdk_session_id = COALESCE(?, sdk_session_id),
        last_message_uuid = COALESCE(?, last_message_uuid),
        can_resume = COALESCE(?, can_resume),
        turns_completed = COALESCE(?, turns_completed),
        files_modified = COALESCE(?, files_modified),
        files_created = COALESCE(?, files_created),
        tools_used = COALESCE(?, tools_used),
        cost = COALESCE(?, cost),
        updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      data.sdkSessionId || null,
      data.lastMessageUuid || null,
      data.canResume !== undefined ? (data.canResume ? 1 : 0) : null,
      data.turnsCompleted ?? null,
      data.filesModified ? toJSON(data.filesModified) : null,
      data.filesCreated ? toJSON(data.filesCreated) : null,
      data.toolsUsed ? toJSON(data.toolsUsed) : null,
      data.cost ?? null,
      timestamp,
      id
    );

    return result.changes > 0;
  }

  /**
   * Mark execution as completed
   */
  static markCompleted(id: string, data: {
    output: string;
    filesModified: string[];
    filesCreated: string[];
    toolsUsed: string[];
    turnsCompleted: number;
    cost: number;
    duration: number;
    judgeApproved?: boolean;
    judgeFeedback?: string;
  }): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE quick_task_executions SET
        status = 'completed',
        output = ?,
        files_modified = ?,
        files_created = ?,
        tools_used = ?,
        turns_completed = ?,
        cost = ?,
        duration = ?,
        judge_approved = ?,
        judge_feedback = ?,
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      data.output,
      toJSON(data.filesModified),
      toJSON(data.filesCreated),
      toJSON(data.toolsUsed),
      data.turnsCompleted,
      data.cost,
      data.duration,
      data.judgeApproved !== undefined ? (data.judgeApproved ? 1 : 0) : null,
      data.judgeFeedback || null,
      timestamp,
      timestamp,
      id
    );

    return result.changes > 0;
  }

  /**
   * Mark execution as failed
   */
  static markFailed(id: string, data: {
    error: string;
    errorStack?: string;
    output?: string;
    filesModified?: string[];
    filesCreated?: string[];
    cost?: number;
    duration: number;
    sdkSessionId?: string;
    canResume?: boolean;
  }): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE quick_task_executions SET
        status = 'failed',
        error = ?,
        error_stack = ?,
        output = COALESCE(?, output),
        files_modified = COALESCE(?, files_modified),
        files_created = COALESCE(?, files_created),
        cost = COALESCE(?, cost),
        duration = ?,
        sdk_session_id = COALESCE(?, sdk_session_id),
        can_resume = COALESCE(?, can_resume),
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      data.error,
      data.errorStack || null,
      data.output || null,
      data.filesModified ? toJSON(data.filesModified) : null,
      data.filesCreated ? toJSON(data.filesCreated) : null,
      data.cost ?? null,
      data.duration,
      data.sdkSessionId || null,
      data.canResume !== undefined ? (data.canResume ? 1 : 0) : null,
      timestamp,
      timestamp,
      id
    );

    return result.changes > 0;
  }

  /**
   * Mark execution as paused (for resume later)
   */
  static markPaused(id: string, data: {
    sdkSessionId: string;
    lastMessageUuid?: string;
    output?: string;
    filesModified?: string[];
    filesCreated?: string[];
    turnsCompleted?: number;
    cost?: number;
    duration: number;
  }): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE quick_task_executions SET
        status = 'paused',
        sdk_session_id = ?,
        last_message_uuid = ?,
        can_resume = 1,
        output = COALESCE(?, output),
        files_modified = COALESCE(?, files_modified),
        files_created = COALESCE(?, files_created),
        turns_completed = COALESCE(?, turns_completed),
        cost = COALESCE(?, cost),
        duration = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      data.sdkSessionId,
      data.lastMessageUuid || null,
      data.output || null,
      data.filesModified ? toJSON(data.filesModified) : null,
      data.filesCreated ? toJSON(data.filesCreated) : null,
      data.turnsCompleted ?? null,
      data.cost ?? null,
      data.duration,
      timestamp,
      id
    );

    return result.changes > 0;
  }

  /**
   * Delete old executions (cleanup)
   */
  static cleanupOld(daysOld: number = 7): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      DELETE FROM quick_task_executions
      WHERE status IN ('completed', 'failed')
      AND created_at < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get execution statistics for a task
   */
  static getStats(taskId: string): {
    total: number;
    completed: number;
    failed: number;
    totalCost: number;
    totalDuration: number;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(cost) as total_cost,
        SUM(duration) as total_duration
      FROM quick_task_executions
      WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as any;
    return {
      total: row.total || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
      totalCost: row.total_cost || 0,
      totalDuration: row.total_duration || 0,
    };
  }
}

export default QuickTaskExecutionRepository;
