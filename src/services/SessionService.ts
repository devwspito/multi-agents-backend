/**
 * SessionService - Session Management (In-Memory Implementation)
 */

import { LogService } from './logging/LogService';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolCalls?: Array<{ name: string; input: Record<string, any>; output: any; }>;
}

export interface SessionState {
  id: string;
  projectId: string;
  taskId?: string;
  agentType: string;
  messages: SessionMessage[];
  context: Record<string, any>;
  workspacePath?: string;
  branchName?: string;
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'paused' | 'completed' | 'failed';
  tokenCount: number;
  cost: number;
}

class SessionServiceClass {
  private sessions: Map<string, SessionState> = new Map();
  private idCounter = 0;

  async createSession(params: {
    projectId: string;
    taskId?: string;
    agentType: string;
    workspacePath?: string;
    branchName?: string;
    initialContext?: Record<string, any>;
  }): Promise<SessionState> {
    const id = 'session-' + (++this.idCounter) + '-' + Date.now();
    const session: SessionState = {
      id,
      projectId: params.projectId,
      taskId: params.taskId,
      agentType: params.agentType,
      workspacePath: params.workspacePath,
      branchName: params.branchName,
      context: params.initialContext || {},
      messages: [],
      status: 'active',
      tokenCount: 0,
      cost: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(id, session);
    if (params.taskId) {
      await LogService.info('Session created: ' + id, {
        taskId: params.taskId,
        category: 'system',
        metadata: { sessionId: id, agentType: params.agentType },
      });
    }
    return session;
  }

  async getSession(sessionId: string): Promise<SessionState | null> {
    return this.sessions.get(sessionId) || null;
  }

  async findActiveSessions(projectId: string): Promise<SessionState[]> {
    return Array.from(this.sessions.values())
      .filter(s => s.projectId === projectId && (s.status === 'active' || s.status === 'paused'));
  }

  async findSessionForTask(taskId: string, agentType?: string): Promise<SessionState | null> {
    const sessions = Array.from(this.sessions.values())
      .filter(s => s.taskId === taskId && (!agentType || s.agentType === agentType))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return sessions[0] || null;
  }

  async addMessage(sessionId: string, message: Omit<SessionMessage, 'timestamp'>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.messages.push({ ...message, timestamp: new Date() });
      session.updatedAt = new Date();
    }
  }

  async addMessages(sessionId: string, messages: Array<Omit<SessionMessage, 'timestamp'>>): Promise<void> {
    for (const msg of messages) await this.addMessage(sessionId, msg);
  }

  async updateContext(sessionId: string, contextUpdates: Record<string, any>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) { Object.assign(session.context, contextUpdates); session.updatedAt = new Date(); }
  }

  async updateStatus(sessionId: string, status: SessionState['status']): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) { session.status = status; session.updatedAt = new Date(); }
  }

  async updateUsage(sessionId: string, tokenCount: number, cost: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) { session.tokenCount += tokenCount; session.cost += cost; session.updatedAt = new Date(); }
  }

  async getRecentMessages(sessionId: string, maxTokens: number = 100000): Promise<SessionMessage[]> {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const result: SessionMessage[] = [];
    let estimatedTokens = 0;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = session.messages[i];
      const msgTokens = Math.ceil(msg.content.length / 4);
      if (estimatedTokens + msgTokens > maxTokens) break;
      result.unshift(msg);
      estimatedTokens += msgTokens;
    }
    return result;
  }

  async compactSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.messages.length < 20) return;
    const recentMessages = session.messages.slice(-10);
    session.messages = [{ role: 'system', content: '[Session Summary] Messages compacted', timestamp: new Date() }, ...recentMessages];
    session.updatedAt = new Date();
  }

  async cloneSession(sessionId: string, newTaskId?: string): Promise<SessionState | null> {
    const original = this.sessions.get(sessionId);
    if (!original) return null;
    const cloned = await this.createSession({
      projectId: original.projectId, taskId: newTaskId || original.taskId, agentType: original.agentType,
      workspacePath: original.workspacePath, branchName: original.branchName, initialContext: { ...original.context },
    });
    cloned.messages = [...original.messages];
    return cloned;
  }

  async cleanupOldSessions(_daysOld: number = 30): Promise<number> { return 0; }

  async getSessionAnalytics(projectId: string): Promise<{
    totalSessions: number; activeSessions: number; totalTokens: number; totalCost: number; avgMessagesPerSession: number;
  }> {
    const sessions = Array.from(this.sessions.values()).filter(s => s.projectId === projectId);
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      totalTokens: sessions.reduce((sum, s) => sum + s.tokenCount, 0),
      totalCost: sessions.reduce((sum, s) => sum + s.cost, 0),
      avgMessagesPerSession: sessions.length > 0 ? Math.round(sessions.reduce((sum, s) => sum + s.messages.length, 0) / sessions.length) : 0,
    };
  }
}

export const SessionService = new SessionServiceClass();
