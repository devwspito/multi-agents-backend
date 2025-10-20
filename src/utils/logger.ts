import winston from 'winston';
import path from 'path';

/**
 * 📝 STRUCTURED LOGGING (Medium Priority Improvement)
 *
 * Winston logger con niveles y formatos estructurados.
 * Beneficios:
 * - Filtrar logs por nivel en producción
 * - Logs estructurados → fácil parsing/búsqueda
 * - Mejor debugging con contexto
 * - Rotación automática de archivos
 */

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

// Formato personalizado para consola (desarrollo)
const consoleFormat = printf(({ level, message, timestamp, ...metadata }: Record<string, any>) => {
  let msg = `${timestamp} [${level}] ${message}`;

  // Agregar metadata si existe
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }

  return msg;
});

// Configuración del logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    json() // JSON para archivos
  ),

  transports: [
    // Console output (desarrollo)
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        consoleFormat
      ),
    }),

    // Error logs (archivo)
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),

    // Combined logs (archivo)
    new winston.transports.File({
      filename: path.join(process.cwd(), 'logs', 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],

  // No salir en errores no capturados
  exitOnError: false,
});

// Helper methods para logs estructurados con contexto
export const Logger = {
  /**
   * Debug - Información detallada para debugging
   */
  debug(message: string, meta?: Record<string, any>) {
    logger.debug(message, meta);
  },

  /**
   * Info - Información general del flujo de la aplicación
   */
  info(message: string, meta?: Record<string, any>) {
    logger.info(message, meta);
  },

  /**
   * Warn - Advertencias que no interrumpen el flujo
   */
  warn(message: string, meta?: Record<string, any>) {
    logger.warn(message, meta);
  },

  /**
   * Error - Errores que necesitan atención
   */
  error(message: string, error?: Error | Record<string, any>) {
    if (error instanceof Error) {
      logger.error(message, {
        error: error.message,
        stack: error.stack,
      });
    } else {
      logger.error(message, error);
    }
  },

  /**
   * Agente - Log específico para operaciones de agentes
   */
  agent(agentType: string, message: string, meta?: Record<string, any>) {
    logger.info(`[${agentType}] ${message}`, meta);
  },

  /**
   * Task - Log específico para tareas
   */
  task(taskId: string, message: string, meta?: Record<string, any>) {
    logger.info(message, {
      taskId,
      ...meta,
    });
  },

  /**
   * Epic - Log específico para epics
   */
  epic(epicId: string, message: string, meta?: Record<string, any>) {
    logger.info(message, {
      epicId,
      ...meta,
    });
  },

  /**
   * Git - Log específico para operaciones git
   */
  git(operation: string, message: string, meta?: Record<string, any>) {
    logger.info(`[Git ${operation}] ${message}`, meta);
  },

  /**
   * API - Log específico para llamadas API
   */
  api(endpoint: string, message: string, meta?: Record<string, any>) {
    logger.info(`[API ${endpoint}] ${message}`, meta);
  },

  /**
   * Rate Limit - Log específico para rate limiting
   */
  rateLimit(model: string, message: string, meta?: Record<string, any>) {
    logger.info(`[Rate Limit ${model}] ${message}`, meta);
  },

  /**
   * WebSocket - Log específico para WebSocket
   */
  websocket(event: string, message: string, meta?: Record<string, any>) {
    logger.info(`[WebSocket ${event}] ${message}`, meta);
  },
};

export default logger;
