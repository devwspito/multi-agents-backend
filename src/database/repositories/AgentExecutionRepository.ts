/**
 * Agent Execution Repository
 *
 * Tracks full agent executions for recovery and training data.
 * One row per agent execution with complete context.
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';
import crypto from 'crypto';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface IAgentExecution {
  id: string;
  taskId: string;
  projectId?: string;
  storyId?: string;
  epicId?: string;
  agentType: string;
  agentInstanceId?: string;
  modelId: string;
  phaseName: string;
  prompt: string;
  promptHash: string;
  workspacePath?: string;
  targetRepository?: string;
  branchName?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  status: ExecutionStatus;
  turnsCompleted: number;
  messagesReceived: number;
  finalOutput?: string;
  errorMessage?: string;
  errorType?: string;
  sessionId?: string;
  checkpointId?: string;
  recoverable: boolean;
  createdAt: Date;
}

interface ExecutionRow {
  id: string;
  task_id: string;
  project_id: string | null;
  story_id: string | null;
  epic_id: string | null;
  agent_type: string;
  agent_instance_id: string | null;
  model_id: string;
  phase_name: string;
  prompt: string;
  prompt_hash: string;
  workspace_path: string | null;
  target_repository: string | null;
  branch_name: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  status: string;
  turns_completed: number;
  messages_received: number;
  final_output: string | null;
  error_message: string | null;
  error_type: string | null;
  session_id: string | null;
  checkpoint_id: string | null;
  recoverable: number;
  created_at: string;
}

function rowToExecution(row: ExecutionRow): IAgentExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id || undefined,
    storyId: row.story_id || undefined,
    epicId: row.epic_id || undefined,
    agentType: row.agent_type,
    agentInstanceId: row.agent_instance_id || undefined,
    modelId: row.model_id,
    phaseName: row.phase_name,
    prompt: row.prompt,
    promptHash: row.prompt_hash,
    workspacePath: row.workspace_path || undefined,
    targetRepository: row.target_repository || undefined,
    branchName: row.branch_name || undefined,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    durationMs: row.duration_ms || undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    costUsd: row.cost_usd,
    status: row.status as ExecutionStatus,
    turnsCompleted: row.turns_completed,
    messagesReceived: row.messages_received,
    finalOutput: row.final_output || undefined,
    errorMessage: row.error_message || undefined,
    errorType: row.error_type || undefined,
    sessionId: row.session_id || undefined,
    checkpointId: row.checkpoint_id || undefined,
    recoverable: row.recoverable === 1,
    createdAt: new Date(row.created_at),
  };
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').substring(0, 16);
}

export class AgentExecutionRepository {
  /**
   * Start a new execution (status = 'running')
   */
  static create(data: {
    taskId: string;
    projectId?: string;
    storyId?: string;
    epicId?: string;
    agentType: string;
    agentInstanceId?: string;
    modelId: string;
    phaseName: string;
    prompt: string;
    workspacePath?: string;
    targetRepository?: string;
    branchName?: string;
    sessionId?: string;
  }): IAgentExecution {
    const id = generateId();
    const timestamp = now();
    const promptHash = hashPrompt(data.prompt);

    const stmt = db.prepare(`
      INSERT INTO agent_executions (
        id, task_id, project_id, story_id, epic_id,
        agent_type, agent_instance_id, model_id, phase_name,
        prompt, prompt_hash, workspace_path, target_repository, branch_name,
        started_at, status, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.projectId || null,
      data.storyId || null,
      data.epicId || null,
      data.agentType,
      data.agentInstanceId || null,
      data.modelId,
      data.phaseName,
      data.prompt,
      promptHash,
      data.workspacePath || null,
      data.targetRepository || null,
      data.branchName || null,
      timestamp,
      'running',
      data.sessionId || null,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Find by ID
   */
  static findById(id: string): IAgentExecution | null {
    const stmt = db.prepare(`SELECT * FROM agent_executions WHERE id = ?`);
    const row = stmt.get(id) as ExecutionRow | undefined;
    return row ? rowToExecution(row) : null;
  }

  /**
   * Find all executions for a task
   */
  static findByTaskId(taskId: string): IAgentExecution[] {
    const stmt = db.prepare(`SELECT * FROM agent_executions WHERE task_id = ? ORDER BY started_at ASC`);
    const rows = stmt.all(taskId) as ExecutionRow[];
    return rows.map(rowToExecution);
  }

  /**
   * Find running executions for a task
   */
  static findRunning(taskId: string): IAgentExecution[] {
    const stmt = db.prepare(`SELECT * FROM agent_executions WHERE task_id = ? AND status = 'running' ORDER BY started_at ASC`);
    const rows = stmt.all(taskId) as ExecutionRow[];
    return rows.map(rowToExecution);
  }

  /**
   * Update execution progress (turns, messages)
   */
  static updateProgress(id: string, turnsCompleted: number, messagesReceived: number): boolean {
    const stmt = db.prepare(`
      UPDATE agent_executions SET
        turns_completed = ?,
        messages_received = ?
      WHERE id = ?
    `);
    const result = stmt.run(turnsCompleted, messagesReceived, id);
    return result.changes > 0;
  }

  /**
   * Complete execution successfully
   */
  static complete(id: string, data: {
    finalOutput?: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd: number;
    turnsCompleted: number;
    messagesReceived: number;
  }): boolean {
    const timestamp = now();
    const execution = this.findById(id);
    if (!execution) return false;

    const durationMs = new Date().getTime() - execution.startedAt.getTime();

    const stmt = db.prepare(`
      UPDATE agent_executions SET
        status = 'completed',
        completed_at = ?,
        duration_ms = ?,
        input_tokens = ?,
        output_tokens = ?,
        cache_read_tokens = ?,
        cache_creation_tokens = ?,
        cost_usd = ?,
        turns_completed = ?,
        messages_received = ?,
        final_output = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      timestamp,
      durationMs,
      data.inputTokens,
      data.outputTokens,
      data.cacheReadTokens || 0,
      data.cacheCreationTokens || 0,
      data.costUsd,
      data.turnsCompleted,
      data.messagesReceived,
      data.finalOutput || null,
      id
    );

    return result.changes > 0;
  }

  /**
   * Mark execution as failed
   */
  static fail(id: string, errorMessage: string, errorType?: string): boolean {
    const timestamp = now();
    const execution = this.findById(id);
    if (!execution) return false;

    const durationMs = new Date().getTime() - execution.startedAt.getTime();

    const stmt = db.prepare(`
      UPDATE agent_executions SET
        status = 'failed',
        completed_at = ?,
        duration_ms = ?,
        error_message = ?,
        error_type = ?
      WHERE id = ?
    `);

    const result = stmt.run(timestamp, durationMs, errorMessage, errorType || null, id);
    return result.changes > 0;
  }

  /**
   * Mark execution as timeout
   */
  static timeout(id: string): boolean {
    return this.fail(id, 'Execution timed out', 'timeout');
  }

  /**
   * Get execution statistics for a task
   */
  static getStats(taskId: string): {
    total: number;
    completed: number;
    failed: number;
    totalCost: number;
    totalTokens: number;
    avgDurationMs: number;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(cost_usd) as total_cost,
        SUM(input_tokens + output_tokens) as total_tokens,
        AVG(duration_ms) as avg_duration
      FROM agent_executions
      WHERE task_id = ?
    `);
    const row = stmt.get(taskId) as any;
    return {
      total: row.total || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
      totalCost: row.total_cost || 0,
      totalTokens: row.total_tokens || 0,
      avgDurationMs: row.avg_duration || 0,
    };
  }

  /**
   * Find executions for training data export
   */
  static findForTraining(options: {
    startDate?: string;
    endDate?: string;
    status?: ExecutionStatus;
    agentType?: string;
    limit?: number;
    offset?: number;
  } = {}): IAgentExecution[] {
    let sql = `SELECT * FROM agent_executions WHERE 1=1`;
    const params: any[] = [];

    if (options.startDate) {
      sql += ` AND started_at >= ?`;
      params.push(options.startDate);
    }
    if (options.endDate) {
      sql += ` AND started_at <= ?`;
      params.push(options.endDate);
    }
    if (options.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    }
    if (options.agentType) {
      sql += ` AND agent_type = ?`;
      params.push(options.agentType);
    }

    sql += ` ORDER BY started_at ASC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }
    if (options.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as ExecutionRow[];
    return rows.map(rowToExecution);
  }
}

export default AgentExecutionRepository;
