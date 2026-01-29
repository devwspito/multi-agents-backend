/**
 * Security Observation Repository
 *
 * Tracks security vulnerabilities detected by SecurityAgent.
 * Used for security training data and compliance reporting.
 */

import db from '../index.js';
import { generateId, now } from '../utils.js';

export type ObservationType = 'vulnerability' | 'warning' | 'secret' | 'info';
export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type SecurityCategory =
  | 'xss'
  | 'injection'
  | 'secrets'
  | 'path_traversal'
  | 'eval'
  | 'insecure_deps'
  | 'csrf'
  | 'auth_bypass'
  | 'sensitive_data'
  | 'insecure_config'
  | 'command_injection'
  | 'ssrf'
  | 'xxe'
  | 'deserialization'
  | 'other';

export interface ISecurityObservation {
  id: string;
  taskId: string;
  executionId?: string;
  toolCallId?: string;
  observationType: ObservationType;
  category: SecurityCategory;
  severity: Severity;
  filePath?: string;
  lineNumber?: number;
  codeSnippet?: string;
  description: string;
  recommendation?: string;
  owaspCategory?: string;
  cweId?: string;
  agentType?: string;
  phaseName?: string;
  detectedAt: Date;
  falsePositive: boolean;
  reviewedAt?: Date;
  reviewedBy?: string;
  createdAt: Date;
}

interface ObservationRow {
  id: string;
  task_id: string;
  execution_id: string | null;
  tool_call_id: string | null;
  observation_type: string;
  category: string;
  severity: string;
  file_path: string | null;
  line_number: number | null;
  code_snippet: string | null;
  description: string;
  recommendation: string | null;
  owasp_category: string | null;
  cwe_id: string | null;
  agent_type: string | null;
  phase_name: string | null;
  detected_at: string;
  false_positive: number;
  reviewed_at: string | null;
  reviewed_by: string | null;
  created_at: string;
}

function rowToObservation(row: ObservationRow): ISecurityObservation {
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id || undefined,
    toolCallId: row.tool_call_id || undefined,
    observationType: row.observation_type as ObservationType,
    category: row.category as SecurityCategory,
    severity: row.severity as Severity,
    filePath: row.file_path || undefined,
    lineNumber: row.line_number || undefined,
    codeSnippet: row.code_snippet || undefined,
    description: row.description,
    recommendation: row.recommendation || undefined,
    owaspCategory: row.owasp_category || undefined,
    cweId: row.cwe_id || undefined,
    agentType: row.agent_type || undefined,
    phaseName: row.phase_name || undefined,
    detectedAt: new Date(row.detected_at),
    falsePositive: row.false_positive === 1,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at) : undefined,
    reviewedBy: row.reviewed_by || undefined,
    createdAt: new Date(row.created_at),
  };
}

export class SecurityObservationRepository {
  /**
   * Create a new security observation
   */
  static create(data: {
    taskId: string;
    executionId?: string;
    toolCallId?: string;
    observationType: ObservationType;
    category: SecurityCategory;
    severity: Severity;
    filePath?: string;
    lineNumber?: number;
    codeSnippet?: string;
    description: string;
    recommendation?: string;
    owaspCategory?: string;
    cweId?: string;
    agentType?: string;
    phaseName?: string;
  }): ISecurityObservation {
    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO security_observations (
        id, task_id, execution_id, tool_call_id,
        observation_type, category, severity,
        file_path, line_number, code_snippet,
        description, recommendation, owasp_category, cwe_id,
        agent_type, phase_name, detected_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.executionId || null,
      data.toolCallId || null,
      data.observationType,
      data.category,
      data.severity,
      data.filePath || null,
      data.lineNumber || null,
      data.codeSnippet || null,
      data.description,
      data.recommendation || null,
      data.owaspCategory || null,
      data.cweId || null,
      data.agentType || null,
      data.phaseName || null,
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Find by ID
   */
  static findById(id: string): ISecurityObservation | null {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE id = ?`);
    const row = stmt.get(id) as ObservationRow | undefined;
    return row ? rowToObservation(row) : null;
  }

  /**
   * Find all observations for a task
   */
  static findByTaskId(taskId: string): ISecurityObservation[] {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE task_id = ? ORDER BY detected_at ASC`);
    const rows = stmt.all(taskId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Find observations by severity
   */
  static findBySeverity(taskId: string, severity: Severity): ISecurityObservation[] {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE task_id = ? AND severity = ? ORDER BY detected_at ASC`);
    const rows = stmt.all(taskId, severity) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Find critical and high severity observations
   */
  static findCriticalAndHigh(taskId: string): ISecurityObservation[] {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE task_id = ? AND severity IN ('critical', 'high') ORDER BY severity ASC, detected_at ASC`);
    const rows = stmt.all(taskId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Find observations by category
   */
  static findByCategory(taskId: string, category: SecurityCategory): ISecurityObservation[] {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE task_id = ? AND category = ? ORDER BY detected_at ASC`);
    const rows = stmt.all(taskId, category) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Find observations for a specific tool call
   */
  static findByToolCallId(toolCallId: string): ISecurityObservation[] {
    const stmt = db.prepare(`SELECT * FROM security_observations WHERE tool_call_id = ? ORDER BY detected_at ASC`);
    const rows = stmt.all(toolCallId) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Mark as false positive
   */
  static markFalsePositive(id: string, reviewedBy: string): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE security_observations SET
        false_positive = 1,
        reviewed_at = ?,
        reviewed_by = ?
      WHERE id = ?
    `);
    const result = stmt.run(timestamp, reviewedBy, id);
    return result.changes > 0;
  }

  /**
   * Mark as reviewed (not false positive)
   */
  static markReviewed(id: string, reviewedBy: string): boolean {
    const timestamp = now();
    const stmt = db.prepare(`
      UPDATE security_observations SET
        reviewed_at = ?,
        reviewed_by = ?
      WHERE id = ?
    `);
    const result = stmt.run(timestamp, reviewedBy, id);
    return result.changes > 0;
  }

  /**
   * Get security summary for a task
   */
  static getSummary(taskId: string): {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    falsePositives: number;
    reviewed: number;
    byCategory: Record<string, number>;
  } {
    const countStmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) as critical,
        SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN severity = 'medium' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN severity = 'low' THEN 1 ELSE 0 END) as low,
        SUM(CASE WHEN false_positive = 1 THEN 1 ELSE 0 END) as false_positives,
        SUM(CASE WHEN reviewed_at IS NOT NULL THEN 1 ELSE 0 END) as reviewed
      FROM security_observations
      WHERE task_id = ?
    `);
    const countRow = countStmt.get(taskId) as any;

    const categoryStmt = db.prepare(`
      SELECT category, COUNT(*) as count
      FROM security_observations
      WHERE task_id = ?
      GROUP BY category
    `);
    const categoryRows = categoryStmt.all(taskId) as { category: string; count: number }[];

    const byCategory: Record<string, number> = {};
    for (const row of categoryRows) {
      byCategory[row.category] = row.count;
    }

    return {
      total: countRow.total || 0,
      critical: countRow.critical || 0,
      high: countRow.high || 0,
      medium: countRow.medium || 0,
      low: countRow.low || 0,
      falsePositives: countRow.false_positives || 0,
      reviewed: countRow.reviewed || 0,
      byCategory,
    };
  }

  /**
   * Find all unreviewed observations
   */
  static findUnreviewed(taskId?: string): ISecurityObservation[] {
    let sql = `SELECT * FROM security_observations WHERE reviewed_at IS NULL`;
    const params: any[] = [];

    if (taskId) {
      sql += ` AND task_id = ?`;
      params.push(taskId);
    }

    sql += ` ORDER BY severity ASC, detected_at ASC`;

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as ObservationRow[];
    return rows.map(rowToObservation);
  }

  /**
   * Find observations for training export
   */
  static findForTraining(options: {
    startDate?: string;
    endDate?: string;
    excludeFalsePositives?: boolean;
    severity?: Severity;
    limit?: number;
  } = {}): ISecurityObservation[] {
    let sql = `SELECT * FROM security_observations WHERE 1=1`;
    const params: any[] = [];

    if (options.startDate) {
      sql += ` AND detected_at >= ?`;
      params.push(options.startDate);
    }
    if (options.endDate) {
      sql += ` AND detected_at <= ?`;
      params.push(options.endDate);
    }
    if (options.excludeFalsePositives) {
      sql += ` AND false_positive = 0`;
    }
    if (options.severity) {
      sql += ` AND severity = ?`;
      params.push(options.severity);
    }

    sql += ` ORDER BY detected_at ASC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as ObservationRow[];
    return rows.map(rowToObservation);
  }
}

export default SecurityObservationRepository;
