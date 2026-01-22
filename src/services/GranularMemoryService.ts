/**
 * GranularMemoryService - Core Memory System for Agent Orchestration
 *
 * This is the PRIMARY memory system that enables:
 * 1. Exact resumption - Agent knows exactly where it stopped and what it did
 * 2. Cross-phase knowledge - Later phases benefit from earlier learnings
 * 3. Error avoidance - Don't repeat mistakes from previous runs
 * 4. Pattern replication - Replicate successful approaches
 *
 * Architecture:
 * - Stores memories in LOCAL FILES (primary and only source)
 * - Each memory has type, content, and rich metadata
 * - Memories are scoped by project, task, phase, and optionally story
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';

// ==================== TYPES ====================

export type GranularMemoryType =
  | 'decision' | 'action' | 'progress' | 'error' | 'pattern'
  | 'convention' | 'file_change' | 'checkpoint' | 'learning' | 'context';

export type MemoryScope = 'project' | 'task' | 'phase' | 'epic' | 'story';

export interface GranularMemory {
  id: string;
  projectId: string;
  taskId?: string;
  scope: MemoryScope;
  phaseType?: string;
  epicId?: string;
  storyId?: string;
  agentType?: string;
  type: GranularMemoryType;
  title: string;
  content: string;
  importance: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  checkpoint?: {
    resumeData: any;
    completedActions: string[];
    pendingActions: string[];
  };
  fileChange?: {
    path: string;
    operation: 'create' | 'modify' | 'delete';
    summary: string;
  };
  error?: {
    message: string;
    solution?: string;
    avoidanceRule?: string;
  };
  usageCount: number;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
  archived: boolean;
}

// ==================== SERVICE ====================

export class GranularMemoryService {
  private static instance: GranularMemoryService;

  private constructor() {}

  static getInstance(): GranularMemoryService {
    if (!GranularMemoryService.instance) {
      GranularMemoryService.instance = new GranularMemoryService();
    }
    return GranularMemoryService.instance;
  }

  private getWorkspacePath(taskId: string): string {
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    return path.join(workspaceDir, `task-${taskId}`);
  }

  private getMemoryDir(taskId: string): string | null {
    const taskDir = this.getWorkspacePath(taskId);
    if (!fs.existsSync(taskDir)) return null;
    return path.join(taskDir, '.agent-memory', 'granular');
  }

  private ensureMemoryDir(taskId: string): string | null {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir) return null;
    try {
      if (!fs.existsSync(memDir)) {
        fs.mkdirSync(memDir, { recursive: true });
      }
      return memDir;
    } catch {
      return null;
    }
  }

  private saveToLocal(memory: GranularMemory, taskId: string): void {
    if (!taskId) return;
    const memDir = this.ensureMemoryDir(taskId);
    if (!memDir) return;

    try {
      const mainLogPath = path.join(memDir, 'memories.jsonl');
      const logEntry = JSON.stringify(memory) + '\n';
      fs.appendFileSync(mainLogPath, logEntry);

      const byTypeDir = path.join(memDir, 'by-type');
      if (!fs.existsSync(byTypeDir)) fs.mkdirSync(byTypeDir, { recursive: true });
      fs.appendFileSync(path.join(byTypeDir, `${memory.type}s.jsonl`), logEntry);

      if (memory.type === 'checkpoint') {
        const checkpointDir = path.join(memDir, 'checkpoints');
        if (!fs.existsSync(checkpointDir)) fs.mkdirSync(checkpointDir, { recursive: true });
        const checkpointName = [memory.phaseType || 'unknown', memory.epicId || '', memory.storyId || ''].filter(Boolean).join('-');
        fs.writeFileSync(path.join(checkpointDir, `${checkpointName}.json`), JSON.stringify(memory, null, 2));
      }
    } catch (error) {
      console.warn(`[GranularMemory] Failed to save locally: ${error}`);
    }
  }

  loadFromLocal(taskId: string, type?: GranularMemoryType): GranularMemory[] {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir || !fs.existsSync(memDir)) return [];

    const memories: GranularMemory[] = [];
    try {
      const logPath = type ? path.join(memDir, 'by-type', `${type}s.jsonl`) : path.join(memDir, 'memories.jsonl');
      if (!fs.existsSync(logPath)) return [];

      const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try { memories.push(JSON.parse(line)); } catch {}
      }
    } catch {}
    return memories;
  }

  loadCheckpointFromLocal(taskId: string, phaseType: string, epicId?: string, storyId?: string): GranularMemory | null {
    const memDir = this.getMemoryDir(taskId);
    if (!memDir || !fs.existsSync(memDir)) return null;

    try {
      const checkpointDir = path.join(memDir, 'checkpoints');
      if (!fs.existsSync(checkpointDir)) return null;
      const checkpointName = [phaseType, epicId || '', storyId || ''].filter(Boolean).join('-');
      const checkpointPath = path.join(checkpointDir, `${checkpointName}.json`);
      if (!fs.existsSync(checkpointPath)) return null;
      return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    } catch {
      return null;
    }
  }

  store(memory: Omit<GranularMemory, 'id' | 'usageCount' | 'createdAt' | 'updatedAt' | 'archived'>): GranularMemory {
    const localMemory: GranularMemory = {
      ...memory,
      id: uuidv4(),
      usageCount: 0,
      archived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (memory.taskId) this.saveToLocal(localMemory, memory.taskId);
    return localMemory;
  }

  storeFireAndForget(memory: Omit<GranularMemory, 'id' | 'usageCount' | 'createdAt' | 'updatedAt' | 'archived'>): void {
    try { this.store(memory); } catch {}
  }

  storeDecision(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'decision',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.9,
    });
  }

  storeAction(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    content: string;
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'action',
      title: params.title,
      content: params.content,
      importance: 'medium',
      confidence: 1.0,
    });
  }

  storeProgress(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    status: 'started' | 'in_progress' | 'completed' | 'failed';
    details: string;
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'progress',
      title: `${params.status.toUpperCase()}: ${params.storyId || params.epicId || params.phaseType}`,
      content: params.details,
      importance: params.status === 'completed' ? 'high' : 'medium',
      confidence: 1.0,
    });
  }

  storeError(params: {
    projectId: string;
    taskId?: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    errorMessage: string;
    solution?: string;
    avoidanceRule?: string;
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: 'task',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'error',
      title: `ERROR: ${params.errorMessage.substring(0, 100)}`,
      content: params.errorMessage,
      importance: 'high',
      confidence: 0.95,
      error: {
        message: params.errorMessage,
        solution: params.solution,
        avoidanceRule: params.avoidanceRule,
      },
    });
  }

  storeFileChange(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    filePath: string;
    operation: 'create' | 'modify' | 'delete';
    summary: string;
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.storyId ? 'story' : 'epic',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'file_change',
      title: `${params.operation.toUpperCase()}: ${params.filePath}`,
      content: params.summary,
      importance: 'medium',
      confidence: 1.0,
      fileChange: {
        path: params.filePath,
        operation: params.operation,
        summary: params.summary,
      },
    });
  }

  storeCheckpoint(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    agentType: string;
    epicId?: string;
    storyId?: string;
    title: string;
    resumeData: any;
    completedActions: string[];
    pendingActions: string[];
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.storyId ? 'story' : params.epicId ? 'epic' : 'phase',
      phaseType: params.phaseType,
      epicId: params.epicId,
      storyId: params.storyId,
      agentType: params.agentType,
      type: 'checkpoint',
      title: params.title,
      content: `Checkpoint: ${params.completedActions.length} completed, ${params.pendingActions.length} pending`,
      importance: 'critical',
      confidence: 1.0,
      checkpoint: {
        resumeData: params.resumeData,
        completedActions: params.completedActions,
        pendingActions: params.pendingActions,
      },
    });
  }

  storePattern(params: {
    projectId: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      scope: 'project',
      type: 'pattern',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.85,
    });
  }

  storeConvention(params: {
    projectId: string;
    title: string;
    content: string;
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      scope: 'project',
      type: 'convention',
      title: params.title,
      content: params.content,
      importance: 'high',
      confidence: 0.95,
    });
  }

  storeLearning(params: {
    projectId: string;
    taskId?: string;
    title: string;
    content: string;
    importance?: 'low' | 'medium' | 'high' | 'critical';
  }): GranularMemory {
    return this.store({
      projectId: params.projectId,
      taskId: params.taskId,
      scope: params.taskId ? 'task' : 'project',
      type: 'learning',
      title: params.title,
      content: params.content,
      importance: params.importance || 'medium',
      confidence: 0.8,
    });
  }

  getCheckpoint(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
  }): GranularMemory | null {
    if (!params.taskId) return null;
    return this.loadCheckpointFromLocal(params.taskId, params.phaseType, params.epicId, params.storyId);
  }

  getPhaseMemories(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    epicId?: string;
    limit?: number;
  }): GranularMemory[] {
    const limit = params.limit || 50;
    const memories = this.loadFromLocal(params.taskId);
    const filtered = memories.filter(m =>
      m.scope === 'project' ||
      m.taskId === params.taskId ||
      (params.phaseType && m.phaseType === params.phaseType) ||
      (params.epicId && m.epicId === params.epicId)
    );
    const importanceOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    filtered.sort((a, b) => (importanceOrder[b.importance] || 0) - (importanceOrder[a.importance] || 0));
    return filtered.slice(0, limit);
  }

  getCompletedStories(params: {
    projectId: string;
    taskId: string;
    epicId: string;
  }): string[] {
    const memories = this.loadFromLocal(params.taskId, 'progress');
    return memories
      .filter(m => m.epicId === params.epicId && m.title?.startsWith('COMPLETED:') && !m.archived)
      .map(m => m.storyId)
      .filter(Boolean) as string[];
  }

  getErrorsToAvoid(params: {
    projectId: string;
    taskId?: string;
    limit?: number;
  }): GranularMemory[] {
    if (!params.taskId) return [];
    const memories = this.loadFromLocal(params.taskId, 'error');
    const importanceOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    memories.sort((a, b) => (importanceOrder[b.importance] || 0) - (importanceOrder[a.importance] || 0));
    return memories.slice(0, params.limit || 10);
  }

  getPatternsAndConventions(params: {
    projectId: string;
    taskId?: string;
    limit?: number;
  }): GranularMemory[] {
    if (!params.taskId) return [];
    const memories = this.loadFromLocal(params.taskId);
    return memories
      .filter(m => (m.type === 'pattern' || m.type === 'convention') && !m.archived)
      .slice(0, params.limit || 20);
  }

  getFileChanges(params: {
    projectId: string;
    taskId: string;
    epicId?: string;
    storyId?: string;
  }): GranularMemory[] {
    const memories = this.loadFromLocal(params.taskId, 'file_change');
    let filtered = memories.filter(m => !m.archived);
    if (params.storyId) filtered = filtered.filter(m => m.storyId === params.storyId);
    else if (params.epicId) filtered = filtered.filter(m => m.epicId === params.epicId);
    return filtered;
  }

  getTaskCache(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    cacheTitle: string;
  }): GranularMemory | null {
    const memories = this.loadFromLocal(params.taskId, 'context');
    return memories.find(m =>
      m.phaseType === params.phaseType &&
      m.title === params.cacheTitle &&
      !m.archived
    ) || null;
  }

  getTaskCaches(params: {
    projectId: string;
    taskId: string;
    phaseType: string;
    cacheTitlePrefix?: string;
    limit?: number;
  }): GranularMemory[] {
    const memories = this.loadFromLocal(params.taskId, 'context');
    let filtered = memories.filter(m => m.phaseType === params.phaseType && !m.archived);
    if (params.cacheTitlePrefix) {
      filtered = filtered.filter(m => m.title?.startsWith(params.cacheTitlePrefix!));
    }
    return filtered.slice(0, params.limit || 10);
  }

  formatForPrompt(memories: GranularMemory[], title: string = 'AGENT MEMORY'): string {
    if (memories.length === 0) return '';
    const lines: string[] = [
      '\n' + '='.repeat(60),
      `AGENT_MEMORY: ${title}`,
      '='.repeat(60),
    ];
    const typeIcons: Record<string, string> = {
      decision: '[DECISION]',
      action: '[ACTION]',
      progress: '[PROGRESS]',
      error: '[ERROR]',
      pattern: '[PATTERN]',
      convention: '[CONVENTION]',
      file_change: '[FILE_CHANGE]',
      checkpoint: '[CHECKPOINT]',
      learning: '[LEARNING]',
      context: '[CONTEXT]',
    };
    const grouped: Record<string, GranularMemory[]> = {};
    for (const mem of memories) {
      if (!grouped[mem.type]) grouped[mem.type] = [];
      grouped[mem.type].push(mem);
    }
    for (const [type, entries] of Object.entries(grouped)) {
      lines.push(`\n${typeIcons[type] || '[MEMORY]'} ${type.toUpperCase()}:`);
      for (const entry of entries.slice(0, 5)) {
        lines.push(`   - ${entry.title}`);
        if (entry.content.length < 200) lines.push(`     ${entry.content}`);
      }
    }
    lines.push('='.repeat(60) + '\n');
    return lines.join('\n');
  }

  async commitAgentAction(params: {
    taskId: string;
    agentType: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
    actionTitle: string;
    actionDetails: string;
    filePaths?: string[];
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    const memDir = this.getMemoryDir(params.taskId);
    if (!memDir) return { success: false, error: 'No workspace found' };
    const repoDir = path.dirname(memDir);

    try {
      const { execSync } = await import('child_process');
      const status = execSync('git status --porcelain', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 30000,
      }).trim();
      if (!status) return { success: true, commitSha: 'no-changes' };

      if (params.filePaths?.length) {
        for (const fp of params.filePaths) {
          execSync(`git add "${fp}"`, { cwd: repoDir, timeout: 30000 });
        }
      } else {
        execSync('git add -A', { cwd: repoDir, timeout: 30000 });
      }

      const scope = [params.epicId, params.storyId].filter(Boolean).join('/');
      const msg = `[${params.agentType}] ${params.actionTitle}\n\nPhase: ${params.phaseType}${scope ? `\nScope: ${scope}` : ''}\n\n${params.actionDetails}\n\nAuto-committed by ${params.agentType} agent`;
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 30000,
      });
      const commitSha = execSync('git rev-parse HEAD', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      this.storeAction({
        projectId: '',
        taskId: params.taskId,
        phaseType: params.phaseType,
        agentType: params.agentType,
        epicId: params.epicId,
        storyId: params.storyId,
        title: `Git Commit: ${commitSha.substring(0, 7)}`,
        content: `SHA: ${commitSha}`,
      });

      return { success: true, commitSha };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async pushToRemote(params: {
    taskId: string;
    branch?: string;
    force?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    const memDir = this.getMemoryDir(params.taskId);
    if (!memDir) return { success: false, error: 'No workspace found' };
    const repoDir = path.dirname(memDir);

    try {
      const { execSync } = await import('child_process');
      const branch = params.branch || execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoDir,
        encoding: 'utf8',
        timeout: 10000,
      }).trim();

      execSync(`git push origin ${branch}${params.force ? ' --force' : ''}`.trim(), {
        cwd: repoDir,
        timeout: 120000,
      });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async commitAndPush(params: {
    taskId: string;
    agentType: string;
    phaseType: string;
    epicId?: string;
    storyId?: string;
    actionTitle: string;
    actionDetails: string;
    filePaths?: string[];
    branch?: string;
  }): Promise<{ success: boolean; commitSha?: string; error?: string }> {
    const commitResult = await this.commitAgentAction(params);
    if (!commitResult.success || commitResult.commitSha === 'no-changes') return commitResult;

    const pushResult = await this.pushToRemote({ taskId: params.taskId, branch: params.branch });
    if (!pushResult.success) {
      return { success: true, commitSha: commitResult.commitSha, error: `Push failed: ${pushResult.error}` };
    }
    return { success: true, commitSha: commitResult.commitSha };
  }

  consumeCheckpoint(_checkpointId: string): void {}
  cleanup(_projectId: string, _olderThanDays: number = 30): number { return 0; }
  deleteTaskMemories(_taskId: string, _keepProjectLevel: boolean = true): number { return 0; }

  // ==================== MONGODB SYNC STUBS (NO-OP) ====================
  // These methods existed for MongoDB sync and are now no-ops

  /**
   * Stub - MongoDB sync is removed
   */
  syncAllLocalToMongoDB(): { synced: number; errors: string[]; tasks: number } {
    return { synced: 0, errors: [], tasks: 0 };
  }

  /**
   * Stub - MongoDB sync is removed
   */
  syncLocalToMongoDB(_taskId: string): { synced: number; errors: string[] } {
    return { synced: 0, errors: [] };
  }
}

export const granularMemoryService = GranularMemoryService.getInstance();
