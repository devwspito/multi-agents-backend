/**
 * Tool Call Repository
 *
 * Tracks every tool call made by agents for recovery and training.
 * Full input/output capture for each tool invocation.
 */

import db from '../index.js';
import { generateId, now, toJSON, parseJSON } from '../utils.js';

export interface IToolCall {
  id: string;
  executionId: string;
  turnId: string;
  taskId: string;
  toolName: string;
  toolUseId?: string;
  toolInput: any;
  toolInputSummary?: string;
  filePath?: string;
  bashCommand?: string;
  bashExitCode?: number;
  toolOutput?: string;
  toolOutputLength?: number;
  toolSuccess: boolean;
  toolError?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  callOrder: number;
  createdAt: Date;
}

interface ToolCallRow {
  id: string;
  execution_id: string;
  turn_id: string;
  task_id: string;
  tool_name: string;
  tool_use_id: string | null;
  tool_input: string;
  tool_input_summary: string | null;
  file_path: string | null;
  bash_command: string | null;
  bash_exit_code: number | null;
  tool_output: string | null;
  tool_output_length: number | null;
  tool_success: number;
  tool_error: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  call_order: number;
  created_at: string;
}

function rowToToolCall(row: ToolCallRow): IToolCall {
  return {
    id: row.id,
    executionId: row.execution_id,
    turnId: row.turn_id,
    taskId: row.task_id,
    toolName: row.tool_name,
    toolUseId: row.tool_use_id || undefined,
    toolInput: parseJSON(row.tool_input, {}),
    toolInputSummary: row.tool_input_summary || undefined,
    filePath: row.file_path || undefined,
    bashCommand: row.bash_command || undefined,
    bashExitCode: row.bash_exit_code ?? undefined,
    toolOutput: row.tool_output || undefined,
    toolOutputLength: row.tool_output_length || undefined,
    toolSuccess: row.tool_success === 1,
    toolError: row.tool_error || undefined,
    startedAt: new Date(row.started_at),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    durationMs: row.duration_ms || undefined,
    callOrder: row.call_order,
    createdAt: new Date(row.created_at),
  };
}

function generateInputSummary(toolName: string, input: any): string {
  switch (toolName) {
    case 'Read':
      return `Read ${input.file_path || input.filePath || 'unknown'}`;
    case 'Write':
      return `Write ${input.file_path || input.filePath || 'unknown'}`;
    case 'Edit':
      return `Edit ${input.file_path || input.filePath || 'unknown'}`;
    case 'Bash':
      const cmd = input.command || '';
      return `Bash: ${cmd.substring(0, 50)}${cmd.length > 50 ? '...' : ''}`;
    case 'Grep':
      return `Grep "${input.pattern || ''}" in ${input.path || '.'}`;
    case 'Glob':
      return `Glob ${input.pattern || '*'}`;
    default:
      return `${toolName}`;
  }
}

// Maximum output size to store (100KB)
const MAX_OUTPUT_SIZE = 100 * 1024;

function truncateOutput(output: string | undefined): string | null {
  if (!output) return null;
  if (output.length <= MAX_OUTPUT_SIZE) return output;
  return output.substring(0, MAX_OUTPUT_SIZE) + `\n... [truncated, total ${output.length} chars]`;
}

export class ToolCallRepository {
  /**
   * Create a new tool call (at start of tool execution)
   */
  static create(data: {
    executionId: string;
    turnId: string;
    taskId: string;
    toolName: string;
    toolUseId?: string;
    toolInput: any;
    callOrder: number;
  }): IToolCall {
    const id = generateId();
    const timestamp = now();

    const inputJson = toJSON(data.toolInput) || '{}';
    const inputSummary = generateInputSummary(data.toolName, data.toolInput);

    // Extract file path for file operations
    let filePath: string | null = null;
    if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(data.toolName)) {
      filePath = data.toolInput?.file_path || data.toolInput?.filePath || null;
    }

    // Extract bash command
    let bashCommand: string | null = null;
    if (data.toolName === 'Bash') {
      bashCommand = data.toolInput?.command || null;
    }

    const stmt = db.prepare(`
      INSERT INTO tool_calls (
        id, execution_id, turn_id, task_id, tool_name, tool_use_id,
        tool_input, tool_input_summary, file_path, bash_command,
        started_at, call_order, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.executionId,
      data.turnId,
      data.taskId,
      data.toolName,
      data.toolUseId || null,
      inputJson,
      inputSummary,
      filePath,
      bashCommand,
      timestamp,
      data.callOrder,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Find by ID
   */
  static findById(id: string): IToolCall | null {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE id = ?`);
    const row = stmt.get(id) as ToolCallRow | undefined;
    return row ? rowToToolCall(row) : null;
  }

  /**
   * Complete a tool call with result
   */
  static complete(id: string, data: {
    toolOutput?: string;
    toolSuccess: boolean;
    toolError?: string;
    bashExitCode?: number;
  }): boolean {
    const timestamp = now();
    const toolCall = this.findById(id);
    if (!toolCall) return false;

    const durationMs = new Date().getTime() - toolCall.startedAt.getTime();
    const truncatedOutput = truncateOutput(data.toolOutput);

    const stmt = db.prepare(`
      UPDATE tool_calls SET
        tool_output = ?,
        tool_output_length = ?,
        tool_success = ?,
        tool_error = ?,
        bash_exit_code = ?,
        completed_at = ?,
        duration_ms = ?
      WHERE id = ?
    `);

    const result = stmt.run(
      truncatedOutput,
      data.toolOutput?.length || 0,
      data.toolSuccess ? 1 : 0,
      data.toolError || null,
      data.bashExitCode ?? null,
      timestamp,
      durationMs,
      id
    );

    return result.changes > 0;
  }

  /**
   * Find all tool calls for an execution
   */
  static findByExecutionId(executionId: string): IToolCall[] {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE execution_id = ? ORDER BY started_at ASC, call_order ASC`);
    const rows = stmt.all(executionId) as ToolCallRow[];
    return rows.map(rowToToolCall);
  }

  /**
   * Find all tool calls for a turn
   */
  static findByTurnId(turnId: string): IToolCall[] {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY call_order ASC`);
    const rows = stmt.all(turnId) as ToolCallRow[];
    return rows.map(rowToToolCall);
  }

  /**
   * Find all tool calls for a task
   */
  static findByTaskId(taskId: string): IToolCall[] {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE task_id = ? ORDER BY started_at ASC`);
    const rows = stmt.all(taskId) as ToolCallRow[];
    return rows.map(rowToToolCall);
  }

  /**
   * Find tool calls by tool name
   */
  static findByToolName(taskId: string, toolName: string): IToolCall[] {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE task_id = ? AND tool_name = ? ORDER BY started_at ASC`);
    const rows = stmt.all(taskId, toolName) as ToolCallRow[];
    return rows.map(rowToToolCall);
  }

  /**
   * Find failed tool calls
   */
  static findFailed(taskId: string): IToolCall[] {
    const stmt = db.prepare(`SELECT * FROM tool_calls WHERE task_id = ? AND tool_success = 0 ORDER BY started_at ASC`);
    const rows = stmt.all(taskId) as ToolCallRow[];
    return rows.map(rowToToolCall);
  }

  /**
   * Get tool usage statistics for a task
   */
  static getStats(taskId: string): {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    toolCounts: Record<string, number>;
    avgDurationMs: number;
  } {
    const countStmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN tool_success = 1 THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN tool_success = 0 THEN 1 ELSE 0 END) as failed,
        AVG(duration_ms) as avg_duration
      FROM tool_calls
      WHERE task_id = ?
    `);
    const countRow = countStmt.get(taskId) as any;

    const toolStmt = db.prepare(`
      SELECT tool_name, COUNT(*) as count
      FROM tool_calls
      WHERE task_id = ?
      GROUP BY tool_name
    `);
    const toolRows = toolStmt.all(taskId) as { tool_name: string; count: number }[];

    const toolCounts: Record<string, number> = {};
    for (const row of toolRows) {
      toolCounts[row.tool_name] = row.count;
    }

    return {
      totalCalls: countRow.total || 0,
      successfulCalls: countRow.successful || 0,
      failedCalls: countRow.failed || 0,
      toolCounts,
      avgDurationMs: countRow.avg_duration || 0,
    };
  }

  /**
   * Get the tool call sequence for an execution (for training)
   */
  static getToolSequence(executionId: string): string[] {
    const stmt = db.prepare(`SELECT tool_name FROM tool_calls WHERE execution_id = ? ORDER BY started_at ASC, call_order ASC`);
    const rows = stmt.all(executionId) as { tool_name: string }[];
    return rows.map(r => r.tool_name);
  }

  /**
   * Get the next call order for a turn
   */
  static getNextCallOrder(turnId: string): number {
    const stmt = db.prepare(`SELECT MAX(call_order) as max_order FROM tool_calls WHERE turn_id = ?`);
    const row = stmt.get(turnId) as { max_order: number | null };
    return (row.max_order || 0) + 1;
  }
}

export default ToolCallRepository;
