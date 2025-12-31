/**
 * SessionService - Claude Code Style Session Management
 *
 * Enables persistent sessions for agents:
 * - Save conversation context between runs
 * - Resume interrupted sessions
 * - Share context across related tasks
 * - Track session history and analytics
 *
 * This is what allows Claude Code to "remember" previous work
 * and continue seamlessly.
 */

import mongoose from 'mongoose';
import { LogService } from './logging/LogService';

/**
 * Session message for context preservation
 */
export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  toolCalls?: Array<{
    name: string;
    input: Record<string, any>;
    output: any;
  }>;
}

/**
 * Session state
 */
export interface SessionState {
  id: string;
  projectId: string;
  taskId?: string;
  agentType: string;
  messages: SessionMessage[];
  context: Record<string, any>; // Arbitrary context data
  workspacePath?: string;
  branchName?: string;
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'paused' | 'completed' | 'failed';
  tokenCount: number;
  cost: number;
}

/**
 * Session Schema for MongoDB
 */
const SessionSchema = new mongoose.Schema({
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  taskId: { type: mongoose.Schema.Types.ObjectId, index: true },
  agentType: { type: String, required: true },
  messages: [{
    role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    toolCalls: [{
      name: String,
      input: mongoose.Schema.Types.Mixed,
      output: mongoose.Schema.Types.Mixed,
    }],
  }],
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
  workspacePath: String,
  branchName: String,
  status: {
    type: String,
    enum: ['active', 'paused', 'completed', 'failed'],
    default: 'active',
  },
  tokenCount: { type: Number, default: 0 },
  cost: { type: Number, default: 0 },
}, {
  timestamps: true,
});

// Create indexes
SessionSchema.index({ projectId: 1, status: 1 });
SessionSchema.index({ taskId: 1, agentType: 1 });
SessionSchema.index({ createdAt: -1 });

// Register model if not already registered
const Session = mongoose.models.Session || mongoose.model('Session', SessionSchema);

class SessionServiceClass {
  /**
   * Create a new session
   */
  async createSession(params: {
    projectId: string;
    taskId?: string;
    agentType: string;
    workspacePath?: string;
    branchName?: string;
    initialContext?: Record<string, any>;
  }): Promise<SessionState> {
    const session = await Session.create({
      projectId: new mongoose.Types.ObjectId(params.projectId),
      taskId: params.taskId ? new mongoose.Types.ObjectId(params.taskId) : undefined,
      agentType: params.agentType,
      workspacePath: params.workspacePath,
      branchName: params.branchName,
      context: params.initialContext || {},
      messages: [],
      status: 'active',
      tokenCount: 0,
      cost: 0,
    });

    if (params.taskId) {
      await LogService.info(`Session created: ${session._id}`, {
        taskId: params.taskId,
        category: 'system',
        metadata: {
          sessionId: session._id.toString(),
          agentType: params.agentType,
        },
      });
    }

    return this.toSessionState(session);
  }

  /**
   * Get an existing session
   */
  async getSession(sessionId: string): Promise<SessionState | null> {
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return null;
    }

    const session = await Session.findById(sessionId);
    return session ? this.toSessionState(session) : null;
  }

  /**
   * Find active sessions for a project
   */
  async findActiveSessions(projectId: string): Promise<SessionState[]> {
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return [];
    }

    const sessions = await Session.find({
      projectId: new mongoose.Types.ObjectId(projectId),
      status: { $in: ['active', 'paused'] },
    }).sort({ updatedAt: -1 });

    return sessions.map(s => this.toSessionState(s));
  }

  /**
   * Find the most recent session for a task
   */
  async findSessionForTask(taskId: string, agentType?: string): Promise<SessionState | null> {
    if (!mongoose.Types.ObjectId.isValid(taskId)) {
      return null;
    }

    const query: any = {
      taskId: new mongoose.Types.ObjectId(taskId),
    };

    if (agentType) {
      query.agentType = agentType;
    }

    const session = await Session.findOne(query).sort({ updatedAt: -1 });
    return session ? this.toSessionState(session) : null;
  }

  /**
   * Add a message to the session
   */
  async addMessage(
    sessionId: string,
    message: Omit<SessionMessage, 'timestamp'>
  ): Promise<void> {
    await Session.findByIdAndUpdate(sessionId, {
      $push: {
        messages: {
          ...message,
          timestamp: new Date(),
        },
      },
      $set: { updatedAt: new Date() },
    });
  }

  /**
   * Add multiple messages (batch)
   */
  async addMessages(
    sessionId: string,
    messages: Array<Omit<SessionMessage, 'timestamp'>>
  ): Promise<void> {
    const timestampedMessages = messages.map(m => ({
      ...m,
      timestamp: new Date(),
    }));

    await Session.findByIdAndUpdate(sessionId, {
      $push: {
        messages: { $each: timestampedMessages },
      },
      $set: { updatedAt: new Date() },
    });
  }

  /**
   * Update session context
   */
  async updateContext(
    sessionId: string,
    contextUpdates: Record<string, any>
  ): Promise<void> {
    const updateObj: Record<string, any> = {
      updatedAt: new Date(),
    };

    for (const [key, value] of Object.entries(contextUpdates)) {
      updateObj[`context.${key}`] = value;
    }

    await Session.findByIdAndUpdate(sessionId, { $set: updateObj });
  }

  /**
   * Update session status
   */
  async updateStatus(
    sessionId: string,
    status: SessionState['status']
  ): Promise<void> {
    await Session.findByIdAndUpdate(sessionId, {
      $set: { status, updatedAt: new Date() },
    });
  }

  /**
   * Update token count and cost
   */
  async updateUsage(
    sessionId: string,
    tokenCount: number,
    cost: number
  ): Promise<void> {
    await Session.findByIdAndUpdate(sessionId, {
      $inc: { tokenCount, cost },
      $set: { updatedAt: new Date() },
    });
  }

  /**
   * Get recent messages for context (with token limit)
   */
  async getRecentMessages(
    sessionId: string,
    maxTokens: number = 100000
  ): Promise<SessionMessage[]> {
    const session = await Session.findById(sessionId);
    if (!session) return [];

    const messages = session.messages || [];
    const result: SessionMessage[] = [];
    let estimatedTokens = 0;

    // Start from most recent
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgTokens = Math.ceil(msg.content.length / 4); // Rough estimate

      if (estimatedTokens + msgTokens > maxTokens) {
        break;
      }

      result.unshift(msg);
      estimatedTokens += msgTokens;
    }

    return result;
  }

  /**
   * Compact session (summarize old messages)
   */
  async compactSession(sessionId: string): Promise<void> {
    const session = await Session.findById(sessionId);
    if (!session || session.messages.length < 20) return;

    // Keep last 10 messages, summarize the rest
    const messagesToSummarize = session.messages.slice(0, -10);
    const recentMessages = session.messages.slice(-10);

    // Create summary
    const summary = this.createMessageSummary(messagesToSummarize);

    // Replace messages with summary + recent
    await Session.findByIdAndUpdate(sessionId, {
      $set: {
        messages: [
          {
            role: 'system',
            content: `[Session Summary]\n${summary}`,
            timestamp: new Date(),
          },
          ...recentMessages,
        ],
        updatedAt: new Date(),
      },
    });

    // Log compaction if session has a taskId
    if (session.taskId) {
      await LogService.info(`Session compacted: ${sessionId}`, {
        taskId: session.taskId.toString(),
        category: 'system',
        metadata: {
          sessionId,
          originalMessageCount: session.messages.length,
          compactedCount: 11, // summary + 10 recent
        },
      });
    }
  }

  /**
   * Create a summary of messages
   */
  private createMessageSummary(messages: any[]): string {
    const toolCalls = messages
      .filter(m => m.toolCalls && m.toolCalls.length > 0)
      .flatMap(m => m.toolCalls)
      .map(t => t.name);

    const uniqueTools = [...new Set(toolCalls)];

    return [
      `Messages summarized: ${messages.length}`,
      `Tools used: ${uniqueTools.join(', ') || 'none'}`,
      `First message: ${messages[0]?.content?.substring(0, 100)}...`,
      `Key actions completed in this session.`,
    ].join('\n');
  }

  /**
   * Clone a session (for branching work)
   */
  async cloneSession(sessionId: string, newTaskId?: string): Promise<SessionState | null> {
    const original = await Session.findById(sessionId);
    if (!original) return null;

    const cloned = await Session.create({
      projectId: original.projectId,
      taskId: newTaskId ? new mongoose.Types.ObjectId(newTaskId) : original.taskId,
      agentType: original.agentType,
      workspacePath: original.workspacePath,
      branchName: original.branchName,
      context: { ...original.context },
      messages: [...original.messages],
      status: 'active',
      tokenCount: 0,
      cost: 0,
    });

    return this.toSessionState(cloned);
  }

  /**
   * Delete old sessions (cleanup)
   */
  async cleanupOldSessions(daysOld: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);

    const result = await Session.deleteMany({
      updatedAt: { $lt: cutoffDate },
      status: { $in: ['completed', 'failed'] },
    });

    return result.deletedCount || 0;
  }

  /**
   * Get session analytics
   */
  async getSessionAnalytics(projectId: string): Promise<{
    totalSessions: number;
    activeSessions: number;
    totalTokens: number;
    totalCost: number;
    avgMessagesPerSession: number;
  }> {
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return {
        totalSessions: 0,
        activeSessions: 0,
        totalTokens: 0,
        totalCost: 0,
        avgMessagesPerSession: 0,
      };
    }

    const sessions = await Session.find({
      projectId: new mongoose.Types.ObjectId(projectId),
    });

    const activeSessions = sessions.filter(s => s.status === 'active').length;
    const totalTokens = sessions.reduce((sum, s) => sum + (s.tokenCount || 0), 0);
    const totalCost = sessions.reduce((sum, s) => sum + (s.cost || 0), 0);
    const totalMessages = sessions.reduce((sum, s) => sum + (s.messages?.length || 0), 0);

    return {
      totalSessions: sessions.length,
      activeSessions,
      totalTokens,
      totalCost,
      avgMessagesPerSession: sessions.length > 0 ? Math.round(totalMessages / sessions.length) : 0,
    };
  }

  /**
   * Convert MongoDB document to SessionState
   */
  private toSessionState(doc: any): SessionState {
    return {
      id: doc._id.toString(),
      projectId: doc.projectId.toString(),
      taskId: doc.taskId?.toString(),
      agentType: doc.agentType,
      messages: doc.messages || [],
      context: doc.context || {},
      workspacePath: doc.workspacePath,
      branchName: doc.branchName,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      status: doc.status,
      tokenCount: doc.tokenCount || 0,
      cost: doc.cost || 0,
    };
  }
}

// Singleton instance
export const SessionService = new SessionServiceClass();
