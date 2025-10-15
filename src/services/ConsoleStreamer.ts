/**
 * Console Streamer Service
 *
 * Intercepta TODOS los console.log del backend y los envía
 * al frontend via WebSocket en tiempo real
 * También los persiste en MongoDB para historial
 */

import { NotificationService } from './NotificationService';
import ConsoleLog from '../models/ConsoleLog';

interface ConsoleLogEntry {
  timestamp: Date;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  taskId?: string;
}

class ConsoleStreamer {
  private originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };

  private currentTaskId: string | null = null;
  private logBuffer: ConsoleLogEntry[] = [];
  private maxBufferSize = 1000;
  private isIntercepting = false;

  /**
   * Verifica si ya está streaming para una tarea específica
   */
  isStreamingForTask(taskId: string): boolean {
    return this.currentTaskId === taskId && this.isIntercepting;
  }

  /**
   * Inicia la interceptación de console logs para una tarea específica
   */
  startStreaming(taskId: string): void {
    // Si ya está streaming para otra tarea, advertir
    if (this.currentTaskId && this.currentTaskId !== taskId) {
      this.originalConsole.warn(`⚠️ ConsoleStreamer: Switching from task ${this.currentTaskId} to ${taskId}`);
    }

    this.currentTaskId = taskId;

    if (!this.isIntercepting) {
      this.interceptConsole();
      this.isIntercepting = true;
    }
  }

  /**
   * Detiene la interceptación de logs para la tarea actual
   */
  stopStreaming(): void {
    this.currentTaskId = null;
    // No restauramos console para no romper otras tareas concurrentes
  }

  /**
   * Intercepta console.log, console.info, console.warn, console.error
   */
  private interceptConsole(): void {
    const self = this;

    // Intercept console.log
    console.log = function (...args: any[]) {
      self.originalConsole.log.apply(console, args);
      self.captureAndEmit('log', args);
    };

    // Intercept console.info
    console.info = function (...args: any[]) {
      self.originalConsole.info.apply(console, args);
      self.captureAndEmit('info', args);
    };

    // Intercept console.warn
    console.warn = function (...args: any[]) {
      self.originalConsole.warn.apply(console, args);
      self.captureAndEmit('warn', args);
    };

    // Intercept console.error
    console.error = function (...args: any[]) {
      self.originalConsole.error.apply(console, args);
      self.captureAndEmit('error', args);
    };
  }

  /**
   * Captura el mensaje y lo emite al frontend
   */
  private captureAndEmit(level: 'log' | 'info' | 'warn' | 'error', args: any[]): void {
    // Formatear mensaje
    const message = this.formatMessage(args);

    // Crear log entry
    const logEntry: ConsoleLogEntry = {
      timestamp: new Date(),
      level,
      message,
      taskId: this.currentTaskId || undefined,
    };

    // Agregar al buffer en memoria
    this.addToBuffer(logEntry);

    // Emitir al frontend si hay taskId activo
    if (this.currentTaskId) {
      this.emitToFrontend(this.currentTaskId, logEntry);

      // Persistir en DB (async, no bloqueante)
      this.saveToDatabase(this.currentTaskId, logEntry).catch(err => {
        // Usar console original para no causar loop infinito
        this.originalConsole.error('Failed to save log to DB:', err);
      });
    }
  }

  /**
   * Formatea argumentos de console.log en string
   */
  private formatMessage(args: any[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'string') {
          return arg;
        } else if (typeof arg === 'object') {
          try {
            // Intentar stringify, pero con límite de profundidad
            return JSON.stringify(arg, this.getCircularReplacer(), 2);
          } catch {
            return String(arg);
          }
        } else {
          return String(arg);
        }
      })
      .join(' ');
  }

  /**
   * Replacer para evitar referencias circulares en JSON.stringify
   */
  private getCircularReplacer() {
    const seen = new WeakSet();
    return (_key: string, value: any) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    };
  }

  /**
   * Agrega log al buffer en memoria (con límite de tamaño)
   */
  private addToBuffer(log: ConsoleLogEntry): void {
    this.logBuffer.push(log);

    // Mantener buffer size bajo control
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift(); // Eliminar el más antiguo
    }
  }

  /**
   * Persiste el log en MongoDB
   */
  private async saveToDatabase(taskId: string, log: ConsoleLogEntry): Promise<void> {
    try {
      await ConsoleLog.create({
        taskId,
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
      });
    } catch (error) {
      // No relanzar error para no interrumpir el flujo
      this.originalConsole.error('DB save failed:', error);
    }
  }

  /**
   * Emite log al frontend via WebSocket
   */
  private emitToFrontend(taskId: string, log: ConsoleLogEntry): void {
    const io = NotificationService.getIO();
    if (!io) return;

    // Emitir log individual
    io.to(`task:${taskId}`).emit('console:log', {
      timestamp: log.timestamp,
      level: log.level,
      message: log.message,
    });
  }

  /**
   * Obtiene todos los logs de una tarea desde la base de datos
   */
  async getTaskLogs(taskId: string, limit: number = 500): Promise<any[]> {
    try {
      const logs = await ConsoleLog.find({ taskId })
        .sort({ timestamp: 1 }) // Ordenar por tiempo ascendente
        .limit(limit)
        .lean();

      return logs.map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        message: log.message,
      }));
    } catch (error) {
      this.originalConsole.error('Failed to fetch logs from DB:', error);
      // Fallback: retornar logs del buffer en memoria
      return this.logBuffer.filter((log) => log.taskId === taskId).slice(-limit);
    }
  }

  /**
   * Obtiene los últimos N logs del buffer en memoria
   */
  getRecentLogs(limit: number = 100): ConsoleLogEntry[] {
    return this.logBuffer.slice(-limit);
  }

  /**
   * Limpia el buffer de logs
   */
  clearBuffer(): void {
    this.logBuffer = [];
  }

  /**
   * Restaura console.log original (útil para testing)
   */
  restore(): void {
    console.log = this.originalConsole.log;
    console.info = this.originalConsole.info;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.isIntercepting = false;
  }
}

// Singleton
export default new ConsoleStreamer();
