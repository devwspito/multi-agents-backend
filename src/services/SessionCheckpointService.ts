/**
 * SessionCheckpointService - Session Checkpoint Management (In-Memory)
 */

export interface SessionCheckpoint {
  taskId: string;
  phaseType: string;
  entityId?: string;
  sdkSessionId: string;
  lastMessageUuid?: string;
  status: 'active' | 'completed' | 'failed';
  startedAt: Date;
  updatedAt: Date;
  context?: Record<string, any>;
}

export class SessionCheckpointService {
  private static instance: SessionCheckpointService;
  private checkpoints: Map<string, SessionCheckpoint> = new Map();

  private constructor() {}

  static getInstance(): SessionCheckpointService {
    if (!SessionCheckpointService.instance) {
      SessionCheckpointService.instance = new SessionCheckpointService();
    }
    return SessionCheckpointService.instance;
  }

  private getKey(taskId: string, phaseType: string, entityId?: string): string {
    return [taskId, phaseType, entityId || ''].join('::');
  }

  async saveCheckpoint(
    taskId: string,
    phaseType: string,
    sdkSessionId: string,
    entityId?: string,
    lastMessageUuid?: string,
    context?: Record<string, any>
  ): Promise<SessionCheckpoint | null> {
    const key = this.getKey(taskId, phaseType, entityId);
    const checkpoint: SessionCheckpoint = {
      taskId,
      phaseType,
      entityId,
      sdkSessionId,
      lastMessageUuid,
      status: 'active',
      startedAt: this.checkpoints.get(key)?.startedAt || new Date(),
      updatedAt: new Date(),
      context,
    };
    this.checkpoints.set(key, checkpoint);
    console.log('[SessionCheckpoint] Saved: ' + phaseType + (entityId ? '/' + entityId : ''));
    return checkpoint;
  }

  async loadCheckpoint(taskId: string, phaseType: string, entityId?: string): Promise<SessionCheckpoint | null> {
    const key = this.getKey(taskId, phaseType, entityId);
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint && checkpoint.status === 'active') {
      console.log('[SessionCheckpoint] Loaded: ' + phaseType + (entityId ? '/' + entityId : ''));
      return checkpoint;
    }
    return null;
  }

  async markCompleted(taskId: string, phaseType: string, entityId?: string): Promise<void> {
    const key = this.getKey(taskId, phaseType, entityId);
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint) {
      checkpoint.status = 'completed';
      checkpoint.updatedAt = new Date();
    }
  }

  async markFailed(taskId: string, phaseType: string, entityId?: string, error?: string): Promise<void> {
    const key = this.getKey(taskId, phaseType, entityId);
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint) {
      checkpoint.status = 'failed';
      checkpoint.updatedAt = new Date();
      if (error && checkpoint.context) checkpoint.context.error = error;
    }
  }

  async updateLastMessage(taskId: string, phaseType: string, lastMessageUuid: string, entityId?: string): Promise<void> {
    const key = this.getKey(taskId, phaseType, entityId);
    const checkpoint = this.checkpoints.get(key);
    if (checkpoint) {
      checkpoint.lastMessageUuid = lastMessageUuid;
      checkpoint.updatedAt = new Date();
    }
  }

  async getActiveCheckpoints(taskId: string): Promise<SessionCheckpoint[]> {
    return Array.from(this.checkpoints.values()).filter(c => c.taskId === taskId && c.status === 'active');
  }

  async deleteAllForTask(taskId: string): Promise<void> {
    for (const [key, checkpoint] of this.checkpoints.entries()) {
      if (checkpoint.taskId === taskId) this.checkpoints.delete(key);
    }
  }

  buildResumeOptions(checkpoint: SessionCheckpoint | null): { resumeSessionId?: string; resumeAtMessage?: string; isResume?: boolean; } | undefined {
    if (!checkpoint || !checkpoint.sdkSessionId) return undefined;
    return { resumeSessionId: checkpoint.sdkSessionId, resumeAtMessage: checkpoint.lastMessageUuid, isResume: true };
  }
}

export const sessionCheckpointService = SessionCheckpointService.getInstance();
