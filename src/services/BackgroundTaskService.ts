/**
 * BackgroundTaskService - Non-blocking Task Execution
 *
 * Enables running long-running operations without blocking the main agent:
 * - Build processes
 * - Test suites
 * - Deployments
 * - File indexing
 * - Large git operations
 *
 * Like Claude Code's background task system, allows agents to continue
 * working while tasks run in the background.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { NotificationService } from './NotificationService';

export interface BackgroundTask {
  id: string;
  taskId: string; // Orchestration task ID
  type: 'bash' | 'build' | 'test' | 'deploy' | 'index' | 'custom';
  command: string;
  cwd: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt?: Date;
  completedAt?: Date;
  output: string[];
  error?: string;
  exitCode?: number;
  process?: ChildProcess;
  onComplete?: (task: BackgroundTask) => void;
}

class BackgroundTaskServiceClass extends EventEmitter {
  private tasks: Map<string, BackgroundTask> = new Map();
  private maxConcurrent = 5;
  private runningCount = 0;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  /**
   * Start a background task
   */
  async start(params: {
    taskId: string;
    type: BackgroundTask['type'];
    command: string;
    cwd: string;
    onComplete?: (task: BackgroundTask) => void;
    timeout?: number;
  }): Promise<BackgroundTask> {
    const id = `bg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const task: BackgroundTask = {
      id,
      taskId: params.taskId,
      type: params.type,
      command: params.command,
      cwd: params.cwd,
      status: 'pending',
      output: [],
      onComplete: params.onComplete,
    };

    this.tasks.set(id, task);

    // Check if we can start immediately or need to queue
    if (this.runningCount < this.maxConcurrent) {
      await this.executeTask(task, params.timeout);
    } else {
      // Queue for later execution
      console.log(`\n⏳ [Background] Task ${id} queued (${this.runningCount}/${this.maxConcurrent} running)`);
    }

    return task;
  }

  /**
   * Execute a task
   */
  private async executeTask(task: BackgroundTask, timeout?: number): Promise<void> {
    this.runningCount++;
    task.status = 'running';
    task.startedAt = new Date();

    console.log(`\n🔄 [Background] Starting: ${task.command.substring(0, 50)}...`);

    NotificationService.emitConsoleLog(
      task.taskId,
      'info',
      `🔄 Background task started: ${task.type}`
    );

    const childProc = spawn('sh', ['-c', task.command], {
      cwd: task.cwd,
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    task.process = childProc;

    // Handle stdout
    childProc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      task.output.push(...lines);

      // Keep output buffer manageable
      if (task.output.length > 1000) {
        task.output = task.output.slice(-500);
      }

      // Emit real-time updates
      this.emit('output', { taskId: task.id, data: data.toString() });
    });

    // Handle stderr
    childProc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(Boolean);
      task.output.push(...lines.map(l => `[stderr] ${l}`));
    });

    // Handle completion
    childProc.on('close', (code: number | null) => {
      this.runningCount--;
      task.completedAt = new Date();
      task.exitCode = code ?? -1;
      task.status = code === 0 ? 'completed' : 'failed';
      task.process = undefined;

      const duration = task.completedAt.getTime() - (task.startedAt?.getTime() || 0);

      console.log(`\n${task.status === 'completed' ? '✅' : '❌'} [Background] ${task.type} completed in ${Math.round(duration / 1000)}s`);

      NotificationService.emitConsoleLog(
        task.taskId,
        task.status === 'completed' ? 'info' : 'error',
        `${task.status === 'completed' ? '✅' : '❌'} Background ${task.type} ${task.status} (exit: ${code})`
      );

      // Call completion callback
      if (task.onComplete) {
        task.onComplete(task);
      }

      // Emit completion event
      this.emit('complete', task);

      // Process queued tasks
      this.processQueue();
    });

    // Handle errors
    childProc.on('error', (err: Error) => {
      this.runningCount--;
      task.status = 'failed';
      task.error = err.message;
      task.completedAt = new Date();
      task.process = undefined;

      console.error(`\n❌ [Background] Task error: ${err.message}`);

      this.emit('error', { taskId: task.id, error: err });
      this.processQueue();
    });

    // Set timeout if specified
    if (timeout) {
      setTimeout(() => {
        if (task.status === 'running') {
          this.cancel(task.id);
        }
      }, timeout);
    }
  }

  /**
   * Process queued tasks
   */
  private processQueue(): void {
    if (this.runningCount >= this.maxConcurrent) return;

    const pending = Array.from(this.tasks.values())
      .filter(t => t.status === 'pending')
      .sort((a, b) => this.tasks.get(a.id)!.id.localeCompare(this.tasks.get(b.id)!.id));

    for (const task of pending) {
      if (this.runningCount >= this.maxConcurrent) break;
      this.executeTask(task);
    }
  }

  /**
   * Get task status
   */
  getStatus(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks for an orchestration task
   */
  getTasksForOrchestration(orchestrationTaskId: string): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.taskId === orchestrationTaskId);
  }

  /**
   * Get task output
   */
  getOutput(taskId: string, lastN?: number): string[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];

    return lastN ? task.output.slice(-lastN) : task.output;
  }

  /**
   * Cancel a running task
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    if (task.process) {
      task.process.kill('SIGTERM');
      setTimeout(() => {
        if (task.process) {
          task.process.kill('SIGKILL');
        }
      }, 5000);
    }

    task.status = 'cancelled';
    task.completedAt = new Date();
    this.runningCount--;

    console.log(`\n🛑 [Background] Task ${taskId} cancelled`);

    this.emit('cancelled', task);
    this.processQueue();

    return true;
  }

  /**
   * Wait for a task to complete
   */
  async waitFor(taskId: string, timeout?: number): Promise<BackgroundTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return task;
    }

    return new Promise((resolve) => {
      const timeoutId = timeout ? setTimeout(() => {
        this.removeListener('complete', handler);
        resolve(task);
      }, timeout) : undefined;

      const handler = (completedTask: BackgroundTask) => {
        if (completedTask.id === taskId) {
          if (timeoutId) clearTimeout(timeoutId);
          this.removeListener('complete', handler);
          resolve(completedTask);
        }
      };

      this.on('complete', handler);
    });
  }

  /**
   * Run a build in background
   */
  async runBuild(params: {
    taskId: string;
    cwd: string;
    command?: string;
  }): Promise<BackgroundTask> {
    return this.start({
      taskId: params.taskId,
      type: 'build',
      command: params.command || 'npm run build',
      cwd: params.cwd,
      timeout: 10 * 60 * 1000, // 10 minutes
    });
  }

  /**
   * Run tests in background
   */
  async runTests(params: {
    taskId: string;
    cwd: string;
    command?: string;
    pattern?: string;
  }): Promise<BackgroundTask> {
    let command = params.command || 'npm test';
    if (params.pattern) {
      command += ` -- ${params.pattern}`;
    }

    return this.start({
      taskId: params.taskId,
      type: 'test',
      command,
      cwd: params.cwd,
      timeout: 15 * 60 * 1000, // 15 minutes
    });
  }

  /**
   * Run deployment in background
   */
  async runDeploy(params: {
    taskId: string;
    cwd: string;
    command: string;
  }): Promise<BackgroundTask> {
    return this.start({
      taskId: params.taskId,
      type: 'deploy',
      command: params.command,
      cwd: params.cwd,
      timeout: 30 * 60 * 1000, // 30 minutes
    });
  }

  /**
   * Get running task count
   */
  getRunningCount(): number {
    return this.runningCount;
  }

  /**
   * Get all running tasks
   */
  getRunningTasks(): BackgroundTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'running');
  }

  /**
   * Clean up old completed tasks
   */
  cleanup(maxAge: number = 3600000): number {
    const cutoff = Date.now() - maxAge;
    let cleaned = 0;

    for (const [id, task] of this.tasks) {
      if (
        (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') &&
        task.completedAt &&
        task.completedAt.getTime() < cutoff
      ) {
        this.tasks.delete(id);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Get task statistics
   */
  getStats(): {
    total: number;
    running: number;
    pending: number;
    completed: number;
    failed: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      running: tasks.filter(t => t.status === 'running').length,
      pending: tasks.filter(t => t.status === 'pending').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    };
  }
}

// Singleton instance
export const BackgroundTaskService = new BackgroundTaskServiceClass();
