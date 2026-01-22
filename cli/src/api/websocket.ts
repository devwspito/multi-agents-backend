/**
 * WebSocket Client
 * Real-time updates from the Multi-Agent Backend
 */

import { io, Socket } from 'socket.io-client';
import { configStore } from '../utils/config.js';
import { EventEmitter } from 'events';

export interface LogMessage {
  taskId: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  timestamp: string;
}

export interface PhaseUpdate {
  taskId: string;
  phase: string;
  status: 'started' | 'completed' | 'failed' | 'waiting_approval';
  message?: string;
}

export interface TaskUpdate {
  taskId: string;
  status: string;
  progress?: number;
  currentPhase?: string;
}

export interface ApprovalRequest {
  taskId: string;
  phase: string;
  title: string;
  description: string;
  data?: any;
}

export interface AgentActivity {
  taskId: string;
  agentName: string;
  message: string;
  timestamp: string;
}

class WebSocketClient extends EventEmitter {
  private socket: Socket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private subscribedTasks: Set<string> = new Set();

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const apiUrl = configStore.getApiUrl();
      const token = configStore.getAuthToken();

      if (!token) {
        reject(new Error('Not authenticated'));
        return;
      }

      this.socket = io(apiUrl, {
        path: '/ws/notifications',
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
      });

      this.socket.on('connect', () => {
        this.reconnectAttempts = 0;
        this.emit('connected');

        // Re-subscribe to tasks
        this.subscribedTasks.forEach(taskId => {
          this.socket?.emit('subscribe:task', taskId);
        });

        resolve();
      });

      this.socket.on('disconnect', (reason) => {
        this.emit('disconnected', reason);
      });

      this.socket.on('connect_error', (error) => {
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          reject(error);
        }
        this.emit('error', error);
      });

      // Task events
      this.socket.on('console-log', (data: LogMessage) => {
        this.emit('log', data);
      });

      this.socket.on('phase-start', (data: PhaseUpdate) => {
        this.emit('phase-start', data);
      });

      this.socket.on('phase-complete', (data: PhaseUpdate) => {
        this.emit('phase-complete', data);
      });

      this.socket.on('task-update', (data: TaskUpdate) => {
        this.emit('task-update', data);
      });

      this.socket.on('task-completed', (data: { taskId: string }) => {
        this.emit('task-completed', data);
      });

      this.socket.on('task-failed', (data: { taskId: string; error: string }) => {
        this.emit('task-failed', data);
      });

      // Approval events
      this.socket.on('approval_required', (data: ApprovalRequest) => {
        this.emit('approval-required', data);
      });

      this.socket.on('approval_processed', (data: { taskId: string; phase: string; approved: boolean }) => {
        this.emit('approval-processed', data);
      });

      // Agent activity
      this.socket.on('agent-message', (data: AgentActivity) => {
        this.emit('agent-message', data);
      });

      // Progress updates
      this.socket.on('progress', (data: { taskId: string; phase: string; progress: number; message: string }) => {
        this.emit('progress', data);
      });
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
      this.subscribedTasks.clear();
    }
  }

  subscribeToTask(taskId: string): void {
    this.subscribedTasks.add(taskId);
    if (this.socket?.connected) {
      this.socket.emit('subscribe:task', taskId);
    }
  }

  unsubscribeFromTask(taskId: string): void {
    this.subscribedTasks.delete(taskId);
    if (this.socket?.connected) {
      this.socket.emit('unsubscribe:task', taskId);
    }
  }

  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }
}

export const wsClient = new WebSocketClient();
export default wsClient;
