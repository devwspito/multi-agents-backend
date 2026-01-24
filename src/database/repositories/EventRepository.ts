/**
 * Event Repository
 *
 * Database operations for events (event sourcing)
 * Events are immutable - no updates or deletes allowed
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export type EventType =
  // Task lifecycle
  | 'TaskCreated'
  | 'TaskStarted'
  | 'TaskCompleted'
  | 'TaskFailed'
  | 'TaskCancelled'
  | 'TaskPaused'
  | 'TaskResumed'
  | 'OrchestrationFailed'
  // Sandbox events (runs BEFORE Planning)
  | 'SandboxStarted'
  | 'SandboxConfigured'
  | 'SandboxValidated'
  | 'SandboxFailed'
  // Planning events
  | 'PlanningStarted'
  | 'PlanningCompleted'
  | 'PlanningFailed'
  | 'PlanningApproved'
  | 'PlanningRejected'
  // Tech Lead events
  | 'TechLeadStarted'
  | 'TechLeadCompleted'
  | 'TechLeadFailed'
  | 'TechLeadApproved'
  | 'TechLeadRejected'
  | 'EpicCreated'
  | 'EpicBranchCreated'
  | 'StoryCreated'
  | 'TeamCompositionDefined'
  | 'EnvironmentConfigDefined'
  // Developer events
  | 'DeveloperStarted'
  | 'StoryStarted'
  | 'StoryBranchCreated'
  | 'StoryCompleted'
  | 'StoryPushVerified'
  | 'StoryFailed'
  | 'DevelopersCompleted'
  | 'StorySessionCheckpoint'
  // PR events
  | 'PRCreated'
  | 'PRApprovalRequested'
  | 'PRApproved'
  | 'PRRejected'
  | 'PRMerged'
  // Auto-Merge events
  | 'AutoMergeStarted'
  | 'AutoMergeCompleted'
  | 'AutoMergeFailed'
  // Team events
  | 'TeamDevelopersCompleted'
  | 'TechLeadTeamCompleted'
  // Legacy events (kept for backwards compatibility)
  | string;

export interface IEvent {
  id: string;
  taskId: string;
  eventType: EventType;
  payload: any;
  timestamp: Date;
  version: number;
  userId?: string;
  agentName?: string;
  metadata?: {
    cost?: number;
    duration?: number;
    error?: string;
    [key: string]: any;
  };
}

interface EventRow {
  id: string;
  task_id: string;
  event_type: string;
  payload: string;
  timestamp: string;
  version: number;
  user_id: string | null;
  agent_name: string | null;
  metadata: string | null;
}

function rowToEvent(row: EventRow): IEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    eventType: row.event_type as EventType,
    payload: parseJSON(row.payload, {}),
    timestamp: new Date(row.timestamp),
    version: row.version,
    userId: row.user_id || undefined,
    agentName: row.agent_name || undefined,
    metadata: parseJSON(row.metadata, undefined),
  };
}

export class EventRepository {
  /**
   * Find event by ID
   */
  static findById(id: string): IEvent | null {
    const stmt = db.prepare(`SELECT * FROM events WHERE id = ?`);
    const row = stmt.get(id) as EventRow | undefined;
    if (!row) return null;

    return rowToEvent(row);
  }

  /**
   * Find events by task ID
   */
  static findByTaskId(taskId: string, options?: { limit?: number; eventType?: EventType }): IEvent[] {
    let sql = `SELECT * FROM events WHERE task_id = ?`;
    const params: any[] = [taskId];

    if (options?.eventType) {
      sql += ` AND event_type = ?`;
      params.push(options.eventType);
    }

    sql += ` ORDER BY version ASC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Find events by task ID in reverse order (most recent first)
   */
  static findByTaskIdDesc(taskId: string, limit?: number): IEvent[] {
    let sql = `SELECT * FROM events WHERE task_id = ? ORDER BY version DESC`;
    const params: any[] = [taskId];

    if (limit) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Get next version number for task
   */
  static getNextVersion(taskId: string): number {
    const stmt = db.prepare(`SELECT MAX(version) as maxVersion FROM events WHERE task_id = ?`);
    const row = stmt.get(taskId) as { maxVersion: number | null };
    return (row.maxVersion || 0) + 1;
  }

  /**
   * Append event (immutable - creates new event)
   */
  static append(data: {
    taskId: string;
    eventType: EventType;
    payload: any;
    userId?: string;
    agentName?: string;
    metadata?: {
      cost?: number;
      duration?: number;
      error?: string;
      [key: string]: any;
    };
  }): IEvent {
    const id = generateId();
    const version = this.getNextVersion(data.taskId);
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO events (
        id, task_id, event_type, payload, timestamp, version,
        user_id, agent_name, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.taskId,
      data.eventType,
      toJSON(data.payload),
      timestamp,
      version,
      data.userId || null,
      data.agentName || null,
      data.metadata ? toJSON(data.metadata) : null
    );

    return this.findById(id)!;
  }

  /**
   * Get last event for task
   */
  static getLastEvent(taskId: string): IEvent | null {
    const stmt = db.prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY version DESC LIMIT 1`);
    const row = stmt.get(taskId) as EventRow | undefined;
    if (!row) return null;

    return rowToEvent(row);
  }

  /**
   * Get last event of specific type
   */
  static getLastEventOfType(taskId: string, eventType: EventType): IEvent | null {
    const stmt = db.prepare(`SELECT * FROM events WHERE task_id = ? AND event_type = ? ORDER BY version DESC LIMIT 1`);
    const row = stmt.get(taskId, eventType) as EventRow | undefined;
    if (!row) return null;

    return rowToEvent(row);
  }

  /**
   * Count events for task
   */
  static countByTaskId(taskId: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM events WHERE task_id = ?`);
    const row = stmt.get(taskId) as { count: number };
    return row.count;
  }

  /**
   * Get event summary for task
   */
  static getEventSummary(taskId: string): { eventType: string; count: number }[] {
    const stmt = db.prepare(`
      SELECT event_type as eventType, COUNT(*) as count
      FROM events
      WHERE task_id = ?
      GROUP BY event_type
      ORDER BY count DESC
    `);
    return stmt.all(taskId) as { eventType: string; count: number }[];
  }

  /**
   * Replay events (get all events for rebuilding state)
   */
  static replay(taskId: string, fromVersion?: number): IEvent[] {
    let sql = `SELECT * FROM events WHERE task_id = ?`;
    const params: any[] = [taskId];

    if (fromVersion !== undefined) {
      sql += ` AND version > ?`;
      params.push(fromVersion);
    }

    sql += ` ORDER BY version ASC`;

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Find events by event type across all tasks
   */
  static findByEventType(eventType: EventType, options?: { limit?: number; since?: Date }): IEvent[] {
    let sql = `SELECT * FROM events WHERE event_type = ?`;
    const params: any[] = [eventType];

    if (options?.since) {
      sql += ` AND timestamp >= ?`;
      params.push(options.since.toISOString());
    }

    sql += ` ORDER BY timestamp DESC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as EventRow[];
    return rows.map(rowToEvent);
  }

  /**
   * NOTE: Events are immutable - update and delete operations are intentionally not provided
   * Use the 'append' method to add new events that represent state changes
   */
}

export default EventRepository;
