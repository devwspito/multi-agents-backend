/**
 * Agent Turn Repository
 *
 * Tracks each turn of agent conversation for recovery and training.
 * One row per turn (assistant message, user message, tool result).
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';

export type TurnType = 'assistant' | 'user' | 'tool_result' | 'system';

export interface IAgentTurn {
  id: string;
  executionId: string;
  taskId: string;
  turnNumber: number;
  turnType: TurnType;
  messageContent?: string;
  messageRole?: string;
  hasToolCalls: boolean;
  toolCallsCount: number;
  timestamp: Date;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
}

interface TurnRow {
  id: string;
  execution_id: string;
  task_id: string;
  turn_number: number;
  turn_type: string;
  message_content: string | null;
  message_role: string | null;
  has_tool_calls: number;
  tool_calls_count: number;
  timestamp: string;
  duration_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

function rowToTurn(row: TurnRow): IAgentTurn {
  return {
    id: row.id,
    executionId: row.execution_id,
    taskId: row.task_id,
    turnNumber: row.turn_number,
    turnType: row.turn_type as TurnType,
    messageContent: row.message_content || undefined,
    messageRole: row.message_role || undefined,
    hasToolCalls: row.has_tool_calls === 1,
    toolCallsCount: row.tool_calls_count,
    timestamp: new Date(row.timestamp),
    durationMs: row.duration_ms || undefined,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: new Date(row.created_at),
  };
}

export class AgentTurnRepository {
  /**
   * Create a new turn
   */
  static create(data: {
    executionId: string;
    taskId: string;
    turnNumber: number;
    turnType: TurnType;
    messageContent?: string;
    messageRole?: string;
    hasToolCalls?: boolean;
    toolCallsCount?: number;
  }): IAgentTurn {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO agent_turns (
        id, execution_id, task_id, turn_number, turn_type,
        message_content, message_role, has_tool_calls, tool_calls_count,
        timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.executionId,
      data.taskId,
      data.turnNumber,
      data.turnType,
      data.messageContent || null,
      data.messageRole || null,
      data.hasToolCalls ? 1 : 0,
      data.toolCallsCount || 0,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Find by ID
   */
  static findById(id: string): IAgentTurn | null {
    const stmt = db.prepare(`SELECT * FROM agent_turns WHERE id = ?`);
    const row = stmt.get(id) as TurnRow | undefined;
    return row ? rowToTurn(row) : null;
  }

  /**
   * Find all turns for an execution
   */
  static findByExecutionId(executionId: string): IAgentTurn[] {
    const stmt = db.prepare(`SELECT * FROM agent_turns WHERE execution_id = ? ORDER BY turn_number ASC`);
    const rows = stmt.all(executionId) as TurnRow[];
    return rows.map(rowToTurn);
  }

  /**
   * Find all turns for a task
   */
  static findByTaskId(taskId: string): IAgentTurn[] {
    const stmt = db.prepare(`SELECT * FROM agent_turns WHERE task_id = ? ORDER BY timestamp ASC`);
    const rows = stmt.all(taskId) as TurnRow[];
    return rows.map(rowToTurn);
  }

  /**
   * Update turn with message content (after assistant responds)
   */
  static updateContent(id: string, messageContent: string, tokens?: { input: number; output: number }): boolean {
    let sql = `UPDATE agent_turns SET message_content = ?`;
    const params: any[] = [messageContent];

    if (tokens) {
      sql += `, input_tokens = ?, output_tokens = ?`;
      params.push(tokens.input, tokens.output);
    }

    sql += ` WHERE id = ?`;
    params.push(id);

    const stmt = db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes > 0;
  }

  /**
   * Update turn with tool calls info
   */
  static updateToolCalls(id: string, toolCallsCount: number): boolean {
    const stmt = db.prepare(`
      UPDATE agent_turns SET
        has_tool_calls = 1,
        tool_calls_count = ?
      WHERE id = ?
    `);
    const result = stmt.run(toolCallsCount, id);
    return result.changes > 0;
  }

  /**
   * Get the last turn number for an execution
   */
  static getLastTurnNumber(executionId: string): number {
    const stmt = db.prepare(`SELECT MAX(turn_number) as max_turn FROM agent_turns WHERE execution_id = ?`);
    const row = stmt.get(executionId) as { max_turn: number | null };
    return row.max_turn || 0;
  }

  /**
   * Get turn count for an execution
   */
  static getTurnCount(executionId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM agent_turns WHERE execution_id = ?`);
    const row = stmt.get(executionId) as { count: number };
    return row.count;
  }

  /**
   * Find turns with tool calls
   */
  static findWithToolCalls(executionId: string): IAgentTurn[] {
    const stmt = db.prepare(`SELECT * FROM agent_turns WHERE execution_id = ? AND has_tool_calls = 1 ORDER BY turn_number ASC`);
    const rows = stmt.all(executionId) as TurnRow[];
    return rows.map(rowToTurn);
  }
}

export default AgentTurnRepository;
