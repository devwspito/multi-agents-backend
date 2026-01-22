/**
 * Failed Execution Repository
 *
 * Database operations for failed agent executions
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type FailureType =
  | 'timeout'
  | 'history_overflow'
  | 'loop_detection'
  | 'sdk_error'
  | 'api_error'
  | 'git_error'
  | 'unknown';

export type RetryStatus =
  | 'pending'
  | 'scheduled'
  | 'retrying'
  | 'succeeded'
  | 'abandoned';

export interface IRetryAttempt {
  attemptedAt: Date;
  modelId: string;
  result: 'success' | 'failed';
  errorMessage?: string;
  durationMs: number;
}

export interface IFailedExecution {
  id: string;
  taskId: string;
  projectId?: string;
  agentType: string;
  agentName?: string;
  phaseName?: string;
  prompt: string;
  workspacePath: string;
  modelId: string;
  permissionMode?: string;
  failureType: FailureType;
  errorMessage: string;
  errorStack?: string;
  messagesReceived: number;
  historyMessages: number;
  turnsCompleted: number;
  lastMessageTypes: string[];
  streamDurationMs: number;
  retryStatus: RetryStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  lastRetryAt?: Date;
  retryHistory: IRetryAttempt[];
  contextSnapshot?: any;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface FailedExecutionRow {
  id: string;
  task_id: string;
  project_id: string | null;
  agent_type: string;
  agent_name: string | null;
  phase_name: string | null;
  prompt: string;
  workspace_path: string;
  model_id: string;
  permission_mode: string | null;
  failure_type: string;
  error_message: string;
  error_stack: string | null;
  messages_received: number;
  history_messages: number;
  turns_completed: number;
  last_message_types: string | null;
  stream_duration_ms: number;
  retry_status: string;
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  last_retry_at: string | null;
  retry_history: string | null;
  context_snapshot: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToFailedExecution(row: FailedExecutionRow): IFailedExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id || undefined,
    agentType: row.agent_type,
    agentName: row.agent_name || undefined,
    phaseName: row.phase_name || undefined,
    prompt: row.prompt,
    workspacePath: row.workspace_path,
    modelId: row.model_id,
    permissionMode: row.permission_mode || undefined,
    failureType: row.failure_type as FailureType,
    errorMessage: row.error_message,
    errorStack: row.error_stack || undefined,
    messagesReceived: row.messages_received,
    historyMessages: row.history_messages,
    turnsCompleted: row.turns_completed,
    lastMessageTypes: parseJSON(row.last_message_types, []),
    streamDurationMs: row.stream_duration_ms,
    retryStatus: row.retry_status as RetryStatus,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at) : undefined,
    lastRetryAt: row.last_retry_at ? new Date(row.last_retry_at) : undefined,
    retryHistory: parseJSON(row.retry_history, []),
    contextSnapshot: parseJSON(row.context_snapshot, undefined),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class FailedExecutionRepository {
  /**
   * Find by ID
   */
  static findById(id: string): IFailedExecution | null {
    const stmt = db.prepare(`SELECT * FROM failed_executions WHERE id = ?`);
    const row = stmt.get(id) as FailedExecutionRow | undefined;
    if (!row) return null;

    return rowToFailedExecution(row);
  }

  /**
   * Find all executions
   */
  static findAll(): IFailedExecution[] {
    const stmt = db.prepare(`SELECT * FROM failed_executions ORDER BY created_at DESC`);
    const rows = stmt.all() as FailedExecutionRow[];
    return rows.map(rowToFailedExecution);
  }

  /**
   * Find by task ID
   */
  static findByTaskId(taskId: string): IFailedExecution[] {
    const stmt = db.prepare(`SELECT * FROM failed_executions WHERE task_id = ? ORDER BY created_at DESC`);
    const rows = stmt.all(taskId) as FailedExecutionRow[];
    return rows.map(rowToFailedExecution);
  }

  /**
   * Find retryable executions
   */
  static findRetryable(): IFailedExecution[] {
    const stmt = db.prepare(`
      SELECT * FROM failed_executions
      WHERE retry_status = 'pending'
      AND retry_count < max_retries
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(now()) as FailedExecutionRow[];
    return rows.map(rowToFailedExecution);
  }

  /**
   * Create a new failed execution
   */
  static create(data: {
    taskId: string;
    projectId?: string;
    agentType: string;
    agentName?: string;
    phaseName?: string;
    prompt: string;
    workspacePath: string;
    modelId: string;
    permissionMode?: string;
    failureType: FailureType;
    errorMessage: string;
    errorStack?: string;
    messagesReceived?: number;
    historyMessages?: number;
    turnsCompleted?: number;
    lastMessageTypes?: string[];
    streamDurationMs?: number;
    maxRetries?: number;
    contextSnapshot?: any;
  }): IFailedExecution {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO failed_executions (
        id, task_id, project_id, agent_type, agent_name, phase_name,
        prompt, workspace_path, model_id, permission_mode,
        failure_type, error_message, error_stack,
        messages_received, history_messages, turns_completed,
        last_message_types, stream_duration_ms,
        retry_status, retry_count, max_retries,
        retry_history, context_snapshot,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.projectId || null,
      data.agentType,
      data.agentName || null,
      data.phaseName || null,
      data.prompt,
      data.workspacePath,
      data.modelId,
      data.permissionMode || 'bypassPermissions',
      data.failureType,
      data.errorMessage,
      data.errorStack || null,
      data.messagesReceived || 0,
      data.historyMessages || 0,
      data.turnsCompleted || 0,
      toJSON(data.lastMessageTypes || []),
      data.streamDurationMs || 0,
      'pending',
      0,
      data.maxRetries || 3,
      toJSON([]),
      toJSON(data.contextSnapshot || null),
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Record retry attempt
   */
  static recordRetryAttempt(id: string, attempt: IRetryAttempt): boolean {
    const execution = this.findById(id);
    if (!execution) return false;

    const retryHistory = execution.retryHistory;
    retryHistory.push(attempt);

    const newStatus = attempt.result === 'success' ? 'succeeded' :
                     execution.retryCount + 1 >= execution.maxRetries ? 'abandoned' : 'pending';

    const stmt = db.prepare(`
      UPDATE failed_executions SET
        retry_history = ?,
        retry_count = retry_count + 1,
        retry_status = ?,
        last_retry_at = ?,
        resolved_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    const timestamp = now();
    stmt.run(
      toJSON(retryHistory),
      newStatus,
      timestamp,
      attempt.result === 'success' ? timestamp : null,
      timestamp,
      id
    );

    return true;
  }

  /**
   * Schedule retry
   */
  static scheduleRetry(id: string, nextRetryAt: Date): boolean {
    const stmt = db.prepare(`
      UPDATE failed_executions SET
        retry_status = 'scheduled',
        next_retry_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(nextRetryAt.toISOString(), now(), id);
    return result.changes > 0;
  }

  /**
   * Mark as retrying
   */
  static markRetrying(id: string): boolean {
    const stmt = db.prepare(`UPDATE failed_executions SET retry_status = 'retrying', updated_at = ? WHERE id = ?`);
    const result = stmt.run(now(), id);
    return result.changes > 0;
  }

  /**
   * Abandon execution
   */
  static abandon(id: string): boolean {
    const stmt = db.prepare(`UPDATE failed_executions SET retry_status = 'abandoned', resolved_at = ?, updated_at = ? WHERE id = ?`);
    const timestamp = now();
    const result = stmt.run(timestamp, timestamp, id);
    return result.changes > 0;
  }

  /**
   * Get failure statistics
   */
  static getFailureStats(taskId?: string): { failureType: string; count: number; avgDurationMs: number }[] {
    let sql = `
      SELECT
        failure_type as failureType,
        COUNT(*) as count,
        AVG(stream_duration_ms) as avgDurationMs
      FROM failed_executions
    `;

    if (taskId) {
      sql += ` WHERE task_id = ?`;
    }

    sql += ` GROUP BY failure_type ORDER BY count DESC`;

    const stmt = db.prepare(sql);
    const rows = taskId ? stmt.all(taskId) : stmt.all();
    return rows as { failureType: string; count: number; avgDurationMs: number }[];
  }

  /**
   * Delete old resolved executions
   */
  static cleanupOld(daysOld: number = 7): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      DELETE FROM failed_executions
      WHERE retry_status IN ('succeeded', 'abandoned')
      AND resolved_at < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }
}

export default FailedExecutionRepository;
