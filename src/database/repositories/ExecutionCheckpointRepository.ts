/**
 * Execution Checkpoint Repository
 *
 * Database operations for execution checkpoints
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type CheckpointStatus = 'active' | 'completed' | 'failed' | 'abandoned';

export interface IGitState {
  branch: string;
  lastCommitSha?: string;
  uncommittedChanges: boolean;
}

export interface IExecutionCheckpoint {
  id: string;
  taskId: string;
  projectId?: string;
  agentType: string;
  agentName?: string;
  phaseName?: string;
  status: CheckpointStatus;
  workspacePath: string;
  modelId: string;
  turnsCompleted: number;
  messagesReceived: number;
  lastTurnAt: Date;
  originalPrompt: string;
  contextSnapshot?: any;
  gitState?: IGitState;
  filesModified: string[];
  startedAt: Date;
  lastCheckpointAt: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface ExecutionCheckpointRow {
  id: string;
  task_id: string;
  project_id: string | null;
  agent_type: string;
  agent_name: string | null;
  phase_name: string | null;
  status: string;
  workspace_path: string;
  model_id: string;
  turns_completed: number;
  messages_received: number;
  last_turn_at: string;
  original_prompt: string;
  context_snapshot: string | null;
  git_state: string | null;
  files_modified: string | null;
  started_at: string;
  last_checkpoint_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToCheckpoint(row: ExecutionCheckpointRow): IExecutionCheckpoint {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id || undefined,
    agentType: row.agent_type,
    agentName: row.agent_name || undefined,
    phaseName: row.phase_name || undefined,
    status: row.status as CheckpointStatus,
    workspacePath: row.workspace_path,
    modelId: row.model_id,
    turnsCompleted: row.turns_completed,
    messagesReceived: row.messages_received,
    lastTurnAt: new Date(row.last_turn_at),
    originalPrompt: row.original_prompt,
    contextSnapshot: parseJSON(row.context_snapshot, undefined),
    gitState: parseJSON(row.git_state, undefined),
    filesModified: parseJSON(row.files_modified, []),
    startedAt: new Date(row.started_at),
    lastCheckpointAt: new Date(row.last_checkpoint_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class ExecutionCheckpointRepository {
  /**
   * Find by ID
   */
  static findById(id: string): IExecutionCheckpoint | null {
    const stmt = db.prepare(`SELECT * FROM execution_checkpoints WHERE id = ?`);
    const row = stmt.get(id) as ExecutionCheckpointRow | undefined;
    if (!row) return null;

    return rowToCheckpoint(row);
  }

  /**
   * Find by task ID
   */
  static findByTaskId(taskId: string): IExecutionCheckpoint[] {
    const stmt = db.prepare(`SELECT * FROM execution_checkpoints WHERE task_id = ? ORDER BY last_checkpoint_at DESC`);
    const rows = stmt.all(taskId) as ExecutionCheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  /**
   * Find active checkpoint for task
   */
  static findActiveByTaskId(taskId: string): IExecutionCheckpoint | null {
    const stmt = db.prepare(`SELECT * FROM execution_checkpoints WHERE task_id = ? AND status = 'active' ORDER BY last_checkpoint_at DESC LIMIT 1`);
    const row = stmt.get(taskId) as ExecutionCheckpointRow | undefined;
    if (!row) return null;

    return rowToCheckpoint(row);
  }

  /**
   * Find active checkpoints for recovery
   */
  static findActiveForRecovery(): IExecutionCheckpoint[] {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      SELECT * FROM execution_checkpoints
      WHERE status = 'active'
      AND last_checkpoint_at >= ?
      ORDER BY last_checkpoint_at DESC
    `);
    const rows = stmt.all(oneHourAgo) as ExecutionCheckpointRow[];
    return rows.map(rowToCheckpoint);
  }

  /**
   * Create a new checkpoint
   */
  static create(data: {
    taskId: string;
    projectId?: string;
    agentType: string;
    agentName?: string;
    phaseName?: string;
    workspacePath: string;
    modelId: string;
    originalPrompt: string;
    contextSnapshot?: any;
    gitState?: IGitState;
  }): IExecutionCheckpoint {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO execution_checkpoints (
        id, task_id, project_id, agent_type, agent_name, phase_name,
        status, workspace_path, model_id,
        turns_completed, messages_received, last_turn_at,
        original_prompt, context_snapshot, git_state, files_modified,
        started_at, last_checkpoint_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.projectId || null,
      data.agentType,
      data.agentName || null,
      data.phaseName || null,
      'active',
      data.workspacePath,
      data.modelId,
      0,
      0,
      timestamp,
      data.originalPrompt,
      toJSON(data.contextSnapshot || null),
      toJSON(data.gitState || null),
      toJSON([]),
      timestamp,
      timestamp,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Update checkpoint progress
   */
  static updateProgress(id: string, data: {
    turnsCompleted?: number;
    messagesReceived?: number;
    filesModified?: string[];
    contextSnapshot?: any;
    gitState?: IGitState;
  }): boolean {
    const checkpoint = this.findById(id);
    if (!checkpoint) return false;

    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE execution_checkpoints SET
        turns_completed = COALESCE(?, turns_completed),
        messages_received = COALESCE(?, messages_received),
        files_modified = COALESCE(?, files_modified),
        context_snapshot = COALESCE(?, context_snapshot),
        git_state = COALESCE(?, git_state),
        last_turn_at = ?,
        last_checkpoint_at = ?,
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.turnsCompleted || null,
      data.messagesReceived || null,
      data.filesModified ? toJSON(data.filesModified) : null,
      data.contextSnapshot ? toJSON(data.contextSnapshot) : null,
      data.gitState ? toJSON(data.gitState) : null,
      timestamp,
      timestamp,
      timestamp,
      id
    );

    return true;
  }

  /**
   * Mark checkpoint as completed
   */
  static markCompleted(id: string): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE execution_checkpoints SET
        status = 'completed',
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(timestamp, timestamp, id);
    return result.changes > 0;
  }

  /**
   * Mark checkpoint as failed
   */
  static markFailed(id: string): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE execution_checkpoints SET
        status = 'failed',
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(timestamp, timestamp, id);
    return result.changes > 0;
  }

  /**
   * Abandon checkpoint
   */
  static abandon(id: string): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE execution_checkpoints SET
        status = 'abandoned',
        completed_at = ?,
        updated_at = ?
      WHERE id = ?
    `);
    const result = stmt.run(timestamp, timestamp, id);
    return result.changes > 0;
  }

  /**
   * Clean up old completed checkpoints
   */
  static cleanupOld(daysOld: number = 1): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`
      DELETE FROM execution_checkpoints
      WHERE status IN ('completed', 'abandoned')
      AND completed_at < ?
    `);
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Delete by task ID
   */
  static deleteByTaskId(taskId: string): number {
    const stmt = db.prepare(`DELETE FROM execution_checkpoints WHERE task_id = ?`);
    const result = stmt.run(taskId);
    return result.changes;
  }
}

export default ExecutionCheckpointRepository;
