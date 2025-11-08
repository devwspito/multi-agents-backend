/**
 * Git Operation Lock Service
 *
 * Ensures that git operations on the same repository are serialized
 * to prevent conflicts when multiple tasks work on the same repo.
 *
 * This is critical for maintaining 100% task independence.
 */

import { EventEmitter } from 'events';

interface LockRequest {
  taskId: string;
  repoPath: string;
  operation: string;
  timestamp: Date;
}

interface ActiveLock {
  taskId: string;
  repoPath: string;
  operation: string;
  acquiredAt: Date;
  timeoutId?: NodeJS.Timeout;
}

export class GitOperationLock {
  private static instance: GitOperationLock;
  private locks: Map<string, ActiveLock> = new Map();
  private queue: Map<string, LockRequest[]> = new Map();
  private eventEmitter: EventEmitter = new EventEmitter();

  // Maximum time a lock can be held (5 minutes)
  private readonly LOCK_TIMEOUT_MS = 5 * 60 * 1000;

  private constructor() {
    this.eventEmitter.setMaxListeners(100);
  }

  static getInstance(): GitOperationLock {
    if (!GitOperationLock.instance) {
      GitOperationLock.instance = new GitOperationLock();
    }
    return GitOperationLock.instance;
  }

  /**
   * Acquire a lock for git operations on a specific repository
   *
   * @param taskId - Task requesting the lock
   * @param repoPath - Repository path (acts as lock key)
   * @param operation - Description of the operation
   * @param timeoutMs - Custom timeout (default: 5 minutes)
   * @returns Promise that resolves when lock is acquired
   */
  async acquireLock(
    taskId: string,
    repoPath: string,
    operation: string,
    timeoutMs: number = this.LOCK_TIMEOUT_MS
  ): Promise<void> {
    const lockKey = this.normalizePath(repoPath);

    // Check if lock is already held by this task
    const currentLock = this.locks.get(lockKey);
    if (currentLock?.taskId === taskId) {
      console.log(`🔐 [GitLock] Task ${taskId} already holds lock for ${lockKey}`);
      return;
    }

    // If lock is available, acquire it immediately
    if (!currentLock) {
      this.setLock(lockKey, taskId, operation, timeoutMs);
      return;
    }

    // Lock is held by another task, queue this request
    console.log(`⏳ [GitLock] Task ${taskId} waiting for lock on ${lockKey} (held by ${currentLock.taskId})`);

    return new Promise((resolve, reject) => {
      const request: LockRequest = {
        taskId,
        repoPath: lockKey,
        operation,
        timestamp: new Date()
      };

      // Add to queue
      if (!this.queue.has(lockKey)) {
        this.queue.set(lockKey, []);
      }
      this.queue.get(lockKey)!.push(request);

      // Wait for lock release event
      const eventName = `lock-released:${lockKey}`;
      const timeout = setTimeout(() => {
        this.eventEmitter.removeListener(eventName, handler);
        this.removeFromQueue(lockKey, taskId);
        reject(new Error(`Lock acquisition timeout for ${lockKey} after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = () => {
        // Check if this task is next in queue
        const queue = this.queue.get(lockKey) || [];
        if (queue.length > 0 && queue[0].taskId === taskId) {
          clearTimeout(timeout);
          this.eventEmitter.removeListener(eventName, handler);

          // Remove from queue and acquire lock
          queue.shift();
          if (queue.length === 0) {
            this.queue.delete(lockKey);
          }

          this.setLock(lockKey, taskId, operation, timeoutMs);
          resolve();
        } else {
          // Not our turn yet, keep waiting
          this.eventEmitter.once(eventName, handler);
        }
      };

      this.eventEmitter.once(eventName, handler);
    });
  }

  /**
   * Release a lock held by a task
   */
  releaseLock(taskId: string, repoPath: string): void {
    const lockKey = this.normalizePath(repoPath);
    const currentLock = this.locks.get(lockKey);

    if (!currentLock) {
      return; // No lock to release
    }

    if (currentLock.taskId !== taskId) {
      console.warn(`⚠️ [GitLock] Task ${taskId} tried to release lock held by ${currentLock.taskId}`);
      return;
    }

    // Clear timeout if exists
    if (currentLock.timeoutId) {
      clearTimeout(currentLock.timeoutId);
    }

    // Remove lock
    this.locks.delete(lockKey);
    console.log(`🔓 [GitLock] Task ${taskId} released lock for ${lockKey}`);

    // Notify waiting tasks
    this.eventEmitter.emit(`lock-released:${lockKey}`);
  }

  /**
   * Release all locks held by a specific task (cleanup on task completion)
   */
  releaseAllTaskLocks(taskId: string): void {
    const locksToRelease: string[] = [];

    for (const [lockKey, lock] of this.locks.entries()) {
      if (lock.taskId === taskId) {
        locksToRelease.push(lockKey);
      }
    }

    for (const lockKey of locksToRelease) {
      this.releaseLock(taskId, lockKey);
    }

    if (locksToRelease.length > 0) {
      console.log(`🧹 [GitLock] Released ${locksToRelease.length} locks for task ${taskId}`);
    }

    // Also remove from all queues
    for (const [lockKey, queue] of this.queue.entries()) {
      const filtered = queue.filter(req => req.taskId !== taskId);
      if (filtered.length !== queue.length) {
        if (filtered.length === 0) {
          this.queue.delete(lockKey);
        } else {
          this.queue.set(lockKey, filtered);
        }
        console.log(`🧹 [GitLock] Removed task ${taskId} from queue for ${lockKey}`);
      }
    }
  }

  /**
   * Check if a repository is currently locked
   */
  isLocked(repoPath: string): boolean {
    const lockKey = this.normalizePath(repoPath);
    return this.locks.has(lockKey);
  }

  /**
   * Get lock info for a repository
   */
  getLockInfo(repoPath: string): ActiveLock | undefined {
    const lockKey = this.normalizePath(repoPath);
    return this.locks.get(lockKey);
  }

  /**
   * Get all active locks (for debugging)
   */
  getAllLocks(): Map<string, ActiveLock> {
    return new Map(this.locks);
  }

  /**
   * Get queue info for a repository
   */
  getQueueInfo(repoPath: string): LockRequest[] {
    const lockKey = this.normalizePath(repoPath);
    return this.queue.get(lockKey) || [];
  }

  private setLock(lockKey: string, taskId: string, operation: string, timeoutMs: number): void {
    // Set auto-release timeout
    const timeoutId = setTimeout(() => {
      console.warn(`⏰ [GitLock] Auto-releasing lock for ${lockKey} (timeout after ${timeoutMs}ms)`);
      this.releaseLock(taskId, lockKey);
    }, timeoutMs);

    const lock: ActiveLock = {
      taskId,
      repoPath: lockKey,
      operation,
      acquiredAt: new Date(),
      timeoutId
    };

    this.locks.set(lockKey, lock);
    console.log(`🔒 [GitLock] Task ${taskId} acquired lock for ${lockKey} (${operation})`);
  }

  private removeFromQueue(lockKey: string, taskId: string): void {
    const queue = this.queue.get(lockKey);
    if (queue) {
      const filtered = queue.filter(req => req.taskId !== taskId);
      if (filtered.length === 0) {
        this.queue.delete(lockKey);
      } else {
        this.queue.set(lockKey, filtered);
      }
    }
  }

  private normalizePath(path: string): string {
    // Normalize path to ensure consistency
    return path.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '');
  }
}

// Export singleton instance
export const gitLock = GitOperationLock.getInstance();