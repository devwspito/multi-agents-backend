/**
 * Task Repository (Refactored)
 *
 * Efficient database operations for tasks using SQLite.
 * The orchestration object is stored as JSON due to its complexity.
 *
 * Key features:
 * - Synchronous operations (SQLite advantage)
 * - Efficient partial updates for orchestration
 * - Built-in pagination and filtering
 * - Atomic operations for concurrent safety
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted';
export type AgentType = 'sandbox-setup' | 'planning-agent' | 'tech-lead' | 'developer' | 'judge' | 'auto-merge' | 'team-orchestration' | 'story-merge-agent' | 'git-flow-manager';
export type StoryComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'epic';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'not_required';

export interface IStory {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  assignedTo?: string;
  priority: number;
  estimatedComplexity: StoryComplexity;
  status: TaskStatus;
  dependencies?: string[];
  repositoryId?: string;
  repositoryName?: string;
  branchName?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  judgeStatus?: ReviewStatus;
  judgeComments?: string;
  judgeIterations?: number;
  cost_usd?: number;
  developerCost_usd?: number;
  judgeCost_usd?: number;
  judgeIterationCosts?: Array<{
    iteration: number;
    cost_usd: number;
    verdict: 'approved' | 'rejected';
  }>;
}

export interface IEpic {
  id: string;
  name: string;
  title?: string;
  description: string;
  branchName: string;
  stories: string[];
  branchesCreated: boolean;
  prCreated: boolean;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  targetRepository?: string;
  dependencies?: string[];
  pullRequestState?: 'pending' | 'open' | 'merged' | 'closed';
}

export interface ITeamMember {
  agentType: 'developer';
  instanceId: string;
  assignedStories: string[];
  status: 'idle' | 'working' | 'completed' | 'blocked';
  pullRequests: number[];
  sessionId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_usd?: number;
  startedAt?: Date;
  completedAt?: Date;
}

export interface IAgentStep {
  agent: AgentType;
  status: TaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
  sessionId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_usd?: number;
  approved?: boolean;
  approval?: {
    status: 'pending' | 'approved' | 'rejected';
    approvedBy?: string;
    approvedAt?: Date;
    requestedAt?: Date;
    comments?: string;
  };
}

export interface IDirective {
  id: string;
  content: string;
  priority: 'critical' | 'high' | 'normal' | 'suggestion';
  targetPhase?: string;
  targetAgent?: string;
  injectedAt?: Date;
  consumed: boolean;
  createdAt: Date;
  createdBy?: string;
}

export interface IApprovalHistoryEntry {
  phase: string;
  phaseName: string;
  approved: boolean;
  approvedBy: string;
  approvedAt: Date;
  comments?: string;
  autoApproved: boolean;
}

export interface IOrchestration {
  status?: TaskStatus;
  // 🐳 Sandbox phase (runs BEFORE Planning)
  sandbox?: IAgentStep & {
    sandboxId?: string;
    containerName?: string;
    dockerImage?: string;
    language?: string;
    framework?: string;
    validated?: boolean;
    judgeDetails?: string;
  };
  planning?: IAgentStep & {
    analysis?: any;
    epics?: IEpic[];
    stories?: IStory[];
    overlapValidation?: any;
    contextSummary?: string;
  };
  techLead: IAgentStep & {
    architectureDesign?: string;
    teamComposition?: {
      developers: number;
      reasoning: string;
    };
    storyAssignments?: {
      storyId: string;
      assignedTo: string;
    }[];
    epicBranches?: {
      epicId: string;
      repositoryId: string;
      repositoryName: string;
      branchName: string;
    }[];
    stories?: IStory[];
  };
  team?: ITeamMember[];
  judge?: IAgentStep & {
    evaluations?: {
      storyId: string;
      developerId: string;
      status: ReviewStatus;
      feedback: string;
      iteration: number;
      timestamp?: Date;
    }[];
  };
  recovery?: IAgentStep & {
    verifiedPRs?: any[];
    recoveryStatuses?: any[];
    allComplete?: boolean;
  };
  integration?: IAgentStep & {
    merged?: number;
    total?: number;
    mergeResults?: any[];
    buildSuccess?: boolean;
  };
  autoMerge?: IAgentStep & {
    results?: any[];
  };
  currentPhase?: string;
  workspacePath?: string; // 💾 Path to task workspace for debug and recovery
  phases?: any[];
  totalCost: number;
  totalTokens: number;
  costByPhase?: any;
  paused?: boolean;
  pausedAt?: Date;
  pausedBy?: string;
  cancelRequested?: boolean;
  cancelRequestedAt?: Date;
  cancelRequestedBy?: string;
  pendingDirectives?: IDirective[];
  directiveHistory?: IDirective[];
  autoApprovalEnabled?: boolean;
  autoApprovalPhases?: string[];
  supervisorThreshold?: number;
  pendingApproval?: {
    phase: string;
    phaseName: string;
    agentOutput?: any;
    retryCount?: number;
    timestamp?: Date;
  };
  modelConfig?: {
    preset?: string;
    customConfig?: any;
  };
  environmentConfig?: {
    installCommand?: string;
    runCommand?: string;
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    typecheckCommand?: string;
    defaultPort?: number;
    language?: string;
    framework?: string;
  };
  approvalHistory?: IApprovalHistoryEntry[];
  continuations?: any[];
  pendingIntegrationTask?: any;
  isMultiRepo?: boolean;
  humanIntervention?: any;
  branchRegistry?: any[];
  // 🔄 Checkpoint for crash recovery (persists OrchestrationContext state)
  checkpoint?: {
    branchRegistry?: Array<[string, any]>;
    sharedData?: Record<string, any>;
    phaseResults?: any[];
    savedAt?: Date;
  };
}

export interface ILog {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
}

export interface IActivity {
  agentName: string;
  type: 'read' | 'edit' | 'write' | 'bash' | 'think' | 'tool' | 'error' | 'message';
  timestamp: Date;
  file?: string;
  content?: string;
  command?: string;
  output?: string;
  toolName?: string;
  toolInput?: any;
  diff?: any;
}

export interface ITask {
  id: string;
  _id?: string; // MongoDB compatibility alias for frontend
  title: string;
  description?: string;
  userId: string;
  projectId?: string;
  repositoryIds?: string[];
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  orchestration: IOrchestration;
  attachments?: string[];
  tags?: string[];
  logs?: ILog[];
  activities?: IActivity[];
  webhookMetadata?: {
    errorHash?: string;
    occurrenceCount?: number;
    firstOccurrence?: Date;
    lastOccurrence?: Date;
    source?: string;
  };
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Internal Types
// ============================================================================

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  user_id: string;
  project_id: string | null;
  repository_ids: string | null;
  status: string;
  priority: string;
  orchestration: string;
  attachments: string | null;
  tags: string | null;
  logs: string | null;
  activities: string | null;
  webhook_metadata: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

const DEFAULT_ORCHESTRATION: IOrchestration = {
  techLead: {
    agent: 'tech-lead',
    status: 'pending',
  },
  currentPhase: 'planning',
  totalCost: 0,
  totalTokens: 0,
  autoApprovalEnabled: false,
  autoApprovalPhases: [],
  supervisorThreshold: 80,
};

function rowToTask(row: TaskRow): ITask {
  return {
    id: row.id,
    _id: row.id, // MongoDB compatibility alias for frontend
    title: row.title,
    description: row.description || undefined,
    userId: row.user_id,
    projectId: row.project_id || undefined,
    repositoryIds: parseJSON(row.repository_ids, undefined),
    status: row.status as TaskStatus,
    priority: row.priority as 'low' | 'medium' | 'high' | 'critical',
    orchestration: parseJSON(row.orchestration, { ...DEFAULT_ORCHESTRATION }),
    attachments: parseJSON(row.attachments, undefined),
    tags: parseJSON(row.tags, undefined),
    logs: parseJSON(row.logs, undefined),
    activities: parseJSON(row.activities, undefined),
    webhookMetadata: parseJSON(row.webhook_metadata, undefined),
    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// ============================================================================
// TaskRepository Class
// ============================================================================

export class TaskRepository {
  // ==========================================================================
  // Basic CRUD Operations
  // ==========================================================================

  /**
   * Find task by ID
   */
  static findById(id: string): ITask | null {
    const stmt = db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Find one task matching criteria (with ownership check)
   */
  static findOne(criteria: { id?: string; userId?: string }): ITask | null {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params: any[] = [];

    if (criteria.id) {
      sql += ` AND id = ?`;
      params.push(criteria.id);
    }
    if (criteria.userId) {
      sql += ` AND user_id = ?`;
      params.push(criteria.userId);
    }

    sql += ` LIMIT 1`;
    const stmt = db.prepare(sql);
    const row = stmt.get(...params) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Find all tasks with flexible filters
   */
  static findAll(filters: {
    userId?: string;
    status?: TaskStatus | TaskStatus[];
    priority?: string;
    projectId?: string;
    repositoryId?: string;
    createdAfter?: Date;
    limit?: number;
    offset?: number;
    orderBy?: 'created_at' | 'updated_at';
    orderDir?: 'ASC' | 'DESC';
  } = {}): ITask[] {
    let sql = `SELECT * FROM tasks WHERE 1=1`;
    const params: any[] = [];

    if (filters.userId) {
      sql += ` AND user_id = ?`;
      params.push(filters.userId);
    }

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        sql += ` AND status IN (${filters.status.map(() => '?').join(',')})`;
        params.push(...filters.status);
      } else {
        sql += ` AND status = ?`;
        params.push(filters.status);
      }
    }

    if (filters.priority) {
      sql += ` AND priority = ?`;
      params.push(filters.priority);
    }

    if (filters.projectId) {
      sql += ` AND project_id = ?`;
      params.push(filters.projectId);
    }

    if (filters.repositoryId) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(repository_ids) WHERE json_each.value = ?)`;
      params.push(filters.repositoryId);
    }

    if (filters.createdAfter) {
      sql += ` AND created_at >= ?`;
      params.push(filters.createdAfter.toISOString());
    }

    sql += ` ORDER BY ${filters.orderBy || 'updated_at'} ${filters.orderDir || 'DESC'}`;

    if (filters.limit) {
      sql += ` LIMIT ?`;
      params.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET ?`;
      params.push(filters.offset);
    }

    const stmt = db.prepare(sql);
    const rows = stmt.all(...params) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Create a new task
   */
  static create(data: {
    title: string;
    description?: string;
    userId: string;
    projectId?: string;
    repositoryIds?: string[];
    priority?: 'low' | 'medium' | 'high' | 'critical';
    orchestration?: Partial<IOrchestration>;
    attachments?: string[];
    tags?: string[];
    webhookMetadata?: any;
  }): ITask {
    const id = generateId();
    const timestamp = now();
    const orchestration = { ...DEFAULT_ORCHESTRATION, ...data.orchestration };

    const stmt = db.prepare(`
      INSERT INTO tasks (
        id, title, description, user_id, project_id, repository_ids,
        status, priority, orchestration, attachments, tags,
        logs, activities, webhook_metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.title,
      data.description || null,
      data.userId,
      data.projectId || null,
      toJSON(data.repositoryIds || []),
      'pending',
      data.priority || 'medium',
      toJSON(orchestration),
      toJSON(data.attachments || []),
      toJSON(data.tags || []),
      toJSON([]),
      toJSON([]),
      toJSON(data.webhookMetadata || null),
      timestamp,
      timestamp
    );

    return this.findById(id)!;
  }

  /**
   * Full update of task (use specific methods for partial updates)
   */
  static update(id: string, data: Partial<{
    title: string;
    description: string;
    status: TaskStatus;
    priority: 'low' | 'medium' | 'high' | 'critical';
    projectId: string;
    repositoryIds: string[];
    orchestration: IOrchestration;
    attachments: string[];
    tags: string[];
    logs: ILog[];
    activities: IActivity[];
    webhookMetadata: any;
    completedAt: Date;
  }>): ITask | null {
    const existing = this.findById(id);
    if (!existing) return null;

    // Build dynamic update query
    const updates: string[] = [];
    const params: any[] = [];

    if (data.title !== undefined) { updates.push('title = ?'); params.push(data.title); }
    if (data.description !== undefined) { updates.push('description = ?'); params.push(data.description); }
    if (data.status !== undefined) { updates.push('status = ?'); params.push(data.status); }
    if (data.priority !== undefined) { updates.push('priority = ?'); params.push(data.priority); }
    if (data.projectId !== undefined) { updates.push('project_id = ?'); params.push(data.projectId); }
    if (data.repositoryIds !== undefined) { updates.push('repository_ids = ?'); params.push(toJSON(data.repositoryIds)); }
    if (data.orchestration !== undefined) { updates.push('orchestration = ?'); params.push(toJSON(data.orchestration)); }
    if (data.attachments !== undefined) { updates.push('attachments = ?'); params.push(toJSON(data.attachments)); }
    if (data.tags !== undefined) { updates.push('tags = ?'); params.push(toJSON(data.tags)); }
    if (data.logs !== undefined) { updates.push('logs = ?'); params.push(toJSON(data.logs)); }
    if (data.activities !== undefined) { updates.push('activities = ?'); params.push(toJSON(data.activities)); }
    if (data.webhookMetadata !== undefined) { updates.push('webhook_metadata = ?'); params.push(toJSON(data.webhookMetadata)); }
    if (data.completedAt !== undefined) { updates.push('completed_at = ?'); params.push(data.completedAt.toISOString()); }

    if (updates.length === 0) return existing;

    updates.push('updated_at = ?');
    params.push(now());
    params.push(id);

    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...params);

    return this.findById(id);
  }

  /**
   * Delete task
   */
  static delete(id: string): boolean {
    const stmt = db.prepare(`DELETE FROM tasks WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Delete task with ownership verification
   */
  static deleteByIdAndUser(id: string, userId: string): boolean {
    const stmt = db.prepare(`DELETE FROM tasks WHERE id = ? AND user_id = ?`);
    const result = stmt.run(id, userId);
    return result.changes > 0;
  }

  // ==========================================================================
  // Specialized Query Methods
  // ==========================================================================

  /**
   * Find multiple tasks by IDs
   */
  static findByIds(ids: string[]): ITask[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Find tasks by user ID
   */
  static findByUserId(userId: string, options?: { status?: TaskStatus; limit?: number }): ITask[] {
    return this.findAll({ userId, status: options?.status, limit: options?.limit });
  }

  /**
   * Find tasks by project ID
   */
  static findByProjectId(projectId: string, options?: { status?: TaskStatus; limit?: number }): ITask[] {
    return this.findAll({ projectId, status: options?.status, limit: options?.limit });
  }

  /**
   * Find task by webhook hash (for deduplication)
   */
  static findByWebhookHash(projectId: string, errorHash: string): ITask | null {
    const stmt = db.prepare(`
      SELECT * FROM tasks
      WHERE project_id = ?
      AND json_extract(webhook_metadata, '$.errorHash') = ?
      AND status NOT IN ('completed', 'cancelled')
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get(projectId, errorHash) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Find interrupted tasks (for recovery)
   */
  static findInterrupted(): ITask[] {
    return this.findAll({ status: ['in_progress', 'interrupted'] as TaskStatus[] });
  }

  /**
   * Find tasks with pending approval
   */
  static findWithPendingApproval(): ITask[] {
    const stmt = db.prepare(`
      SELECT * FROM tasks
      WHERE json_extract(orchestration, '$.pendingApproval.phase') IS NOT NULL
      AND status = 'in_progress'
    `);
    const rows = stmt.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  // ==========================================================================
  // Efficient Partial Update Methods
  // ==========================================================================

  /**
   * Update status only (most common operation)
   */
  static updateStatus(id: string, status: TaskStatus, completedAt?: Date): boolean {
    const params: any[] = [status, now()];
    let sql = `UPDATE tasks SET status = ?, updated_at = ?`;

    if (completedAt) {
      sql += `, completed_at = ?`;
      params.push(completedAt.toISOString());
    }

    sql += ` WHERE id = ?`;
    params.push(id);

    const stmt = db.prepare(sql);
    return stmt.run(...params).changes > 0;
  }

  /**
   * Update orchestration object (atomic)
   */
  static updateOrchestration(id: string, orchestration: IOrchestration): boolean {
    const stmt = db.prepare(`UPDATE tasks SET orchestration = ?, updated_at = ? WHERE id = ?`);
    return stmt.run(toJSON(orchestration), now(), id).changes > 0;
  }

  /**
   * Update description and status (for task start)
   */
  static startTask(id: string, description: string): boolean {
    const stmt = db.prepare(`UPDATE tasks SET description = ?, status = 'in_progress', updated_at = ? WHERE id = ?`);
    return stmt.run(description, now(), id).changes > 0;
  }

  /**
   * Update repository IDs
   */
  static updateRepositoryIds(id: string, repositoryIds: string[]): boolean {
    const stmt = db.prepare(`UPDATE tasks SET repository_ids = ?, updated_at = ? WHERE id = ?`);
    return stmt.run(toJSON(repositoryIds), now(), id).changes > 0;
  }

  /**
   * Add attachment
   */
  static addAttachment(id: string, attachmentPath: string): boolean {
    const task = this.findById(id);
    if (!task) return false;

    const attachments = task.attachments || [];
    attachments.push(attachmentPath);

    const stmt = db.prepare(`UPDATE tasks SET attachments = ?, updated_at = ? WHERE id = ?`);
    return stmt.run(toJSON(attachments), now(), id).changes > 0;
  }

  // ==========================================================================
  // Log & Activity Methods (Optimized for Append Operations)
  // ==========================================================================

  /**
   * Append log entry (keeps last 1000)
   */
  static appendLog(id: string, log: ILog): boolean {
    const task = this.findById(id);
    if (!task) return false;

    const logs = (task.logs || []).slice(-999); // Keep last 999 + new one
    logs.push(log);

    const stmt = db.prepare(`UPDATE tasks SET logs = ?, updated_at = ? WHERE id = ?`);
    return stmt.run(toJSON(logs), now(), id).changes > 0;
  }

  /**
   * Append activity entry (keeps last 500)
   */
  static appendActivity(id: string, activity: IActivity): boolean {
    const task = this.findById(id);
    if (!task) return false;

    const activities = (task.activities || []).slice(-499);
    activities.push(activity);

    const stmt = db.prepare(`UPDATE tasks SET activities = ?, updated_at = ? WHERE id = ?`);
    return stmt.run(toJSON(activities), now(), id).changes > 0;
  }

  /**
   * Clear logs
   */
  static clearLogs(id: string): boolean {
    const stmt = db.prepare(`UPDATE tasks SET logs = '[]', updated_at = ? WHERE id = ?`);
    return stmt.run(now(), id).changes > 0;
  }

  // ==========================================================================
  // Orchestration Helper Methods
  // ==========================================================================

  /**
   * Update with orchestration modifier function (atomic read-modify-write)
   */
  static modifyOrchestration(id: string, modifier: (orch: IOrchestration) => IOrchestration): boolean {
    const task = this.findById(id);
    if (!task) return false;

    const modified = modifier(task.orchestration);
    return this.updateOrchestration(id, modified);
  }

  /**
   * Set auto-approval configuration
   */
  static setAutoApprovalConfig(id: string, config: {
    enabled: boolean;
    phases?: string[];
    supervisorThreshold?: number;
  }): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      autoApprovalEnabled: config.enabled,
      autoApprovalPhases: config.phases ?? orch.autoApprovalPhases,
      supervisorThreshold: config.supervisorThreshold ?? orch.supervisorThreshold,
    }));
  }

  /**
   * Update pending approval
   */
  static updatePendingApproval(id: string, approval: IOrchestration['pendingApproval']): boolean {
    return this.modifyOrchestration(id, (orch) => ({ ...orch, pendingApproval: approval }));
  }

  /**
   * Clear pending approval
   */
  static clearPendingApproval(id: string): boolean {
    return this.modifyOrchestration(id, (orch) => ({ ...orch, pendingApproval: undefined }));
  }

  /**
   * Add to approval history
   */
  static addApprovalHistory(id: string, entry: IApprovalHistoryEntry): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      approvalHistory: [...(orch.approvalHistory || []), entry],
    }));
  }

  /**
   * Add directive to task
   */
  static addDirective(id: string, directive: IDirective): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      pendingDirectives: [...(orch.pendingDirectives || []), directive],
    }));
  }

  /**
   * Update phase status
   */
  static updatePhaseStatus(
    id: string,
    phase: 'planning' | 'techLead' | 'judge' | 'recovery' | 'integration' | 'autoMerge',
    status: TaskStatus,
    extra?: Partial<IAgentStep>
  ): boolean {
    return this.modifyOrchestration(id, (orch) => {
      const phaseData = (orch[phase] || { agent: phase, status: 'pending' }) as IAgentStep;
      return {
        ...orch,
        [phase]: {
          ...phaseData,
          status,
          ...extra,
          ...(status === 'in_progress' && !phaseData.startedAt ? { startedAt: new Date() } : {}),
          ...(status === 'completed' ? { completedAt: new Date() } : {}),
        },
      };
    });
  }

  /**
   * Set pause state
   */
  static setPaused(id: string, paused: boolean, pausedBy?: string): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      paused,
      pausedAt: paused ? new Date() : undefined,
      pausedBy: paused ? pausedBy : undefined,
    }));
  }

  /**
   * Set cancel requested
   */
  static setCancelRequested(id: string, cancelRequested: boolean, cancelRequestedBy?: string): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      cancelRequested,
      cancelRequestedAt: cancelRequested ? new Date() : undefined,
      cancelRequestedBy: cancelRequested ? cancelRequestedBy : undefined,
    }));
  }

  /**
   * Add continuation record
   */
  static addContinuation(id: string, additionalRequirements: string, previousStatus: string): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      continuations: [...(orch.continuations || []), {
        timestamp: new Date(),
        additionalRequirements,
        previousStatus,
      }],
    }));
  }

  // ==========================================================================
  // Statistics Methods
  // ==========================================================================

  /**
   * Count tasks by status for user
   */
  static countByStatus(userId: string): Record<TaskStatus, number> {
    const stmt = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM tasks WHERE user_id = ?
      GROUP BY status
    `);
    const rows = stmt.all(userId) as { status: string; count: number }[];

    const result: Record<TaskStatus, number> = {
      pending: 0, in_progress: 0, completed: 0, failed: 0,
      cancelled: 0, paused: 0, interrupted: 0,
    };

    for (const row of rows) {
      result[row.status as TaskStatus] = row.count;
    }

    return result;
  }

  /**
   * Get task stats for project
   */
  static getProjectStats(projectId: string): {
    total: number;
    completed: number;
    active: number;
    failed: number;
  } {
    const stmt = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks WHERE project_id = ?
    `);
    return stmt.get(projectId) as any;
  }

  /**
   * Count total tasks
   */
  static count(filters?: { userId?: string; status?: TaskStatus }): number {
    let sql = `SELECT COUNT(*) as count FROM tasks WHERE 1=1`;
    const params: any[] = [];

    if (filters?.userId) {
      sql += ` AND user_id = ?`;
      params.push(filters.userId);
    }
    if (filters?.status) {
      sql += ` AND status = ?`;
      params.push(filters.status);
    }

    const stmt = db.prepare(sql);
    const row = stmt.get(...params) as { count: number };
    return row.count;
  }

  // ==========================================================================
  // Convenience Methods (for routes compatibility)
  // ==========================================================================

  /**
   * Find task by ID with user ownership check
   */
  static findByIdAndUser(id: string, userId: string): ITask | null {
    return this.findOne({ id, userId });
  }

  /**
   * Validate if string looks like a valid task ID
   * (24-char hex string for compatibility with MongoDB-style IDs)
   */
  static isValidId(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    // Accept 24-char hex (MongoDB-style) or any non-empty string
    return id.length > 0 && id.length <= 50;
  }

  /**
   * Update human intervention field in orchestration
   */
  static updateHumanIntervention(id: string, intervention: any): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      humanIntervention: intervention,
    }));
  }

  /**
   * Update auto-approval settings
   */
  static updateAutoApproval(
    id: string,
    enabled: boolean,
    phases?: string[],
    threshold?: number
  ): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      autoApprovalEnabled: enabled,
      autoApprovalPhases: phases ?? orch.autoApprovalPhases,
      supervisorThreshold: threshold ?? orch.supervisorThreshold,
    }));
  }

  /**
   * Update model config
   */
  static updateModelConfig(id: string, modelConfig: any): boolean {
    return this.modifyOrchestration(id, (orch) => ({
      ...orch,
      modelConfig,
    }));
  }

  /**
   * Add user code edit record
   */
  static addUserCodeEdit(id: string, editRecord: any): boolean {
    return this.modifyOrchestration(id, (orch) => {
      const userCodeEdits = (orch as any).userCodeEdits || [];
      return {
        ...orch,
        userCodeEdits: [...userCodeEdits, editRecord],
      };
    });
  }
}

export default TaskRepository;
