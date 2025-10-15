/**
 * Code Viewing Routes
 * Endpoints para ver el código generado por los developers
 */

import express from 'express';
import RealTimeLogger from '../services/RealTimeLogger';
import path from 'path';
import fs from 'fs';

const router = express.Router();

/**
 * GET /api/code/:taskId
 * Obtiene todo el código generado para una tarea
 */
router.get('/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;

    // Leer el archivo de logs JSON
    const logsPath = path.join(process.cwd(), 'agent-logs', `${taskId}.json`);

    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: 'No logs found for this task' });
    }

    const logs = JSON.parse(fs.readFileSync(logsPath, 'utf-8'));

    // Filtrar solo las entradas de código
    const codeEntries = logs.filter((entry: any) =>
      entry.type === 'code' ||
      (entry.type === 'tool' && ['Write', 'Edit'].includes(entry.tool))
    );

    // Formatear para respuesta
    const response = {
      taskId,
      totalCodeEntries: codeEntries.length,
      entries: codeEntries.map((entry: any) => ({
        timestamp: entry.timestamp,
        agent: entry.agent,
        type: entry.type,
        action: entry.tool || entry.action,
        filePath: entry.filePath || entry.input?.file_path || entry.input?.path,
        language: entry.language,
        content: entry.code || entry.input?.content || entry.input?.new_string,
        description: entry.description
      }))
    };

    res.json(response);
  } catch (error: any) {
    console.error('[Code Route] Error:', error);
    res.status(500).json({ error: 'Failed to retrieve code logs' });
  }
});

/**
 * GET /api/code/:taskId/files
 * Lista todos los archivos creados/modificados
 */
router.get('/:taskId/files', async (req, res) => {
  try {
    const { taskId } = req.params;

    const logsPath = path.join(process.cwd(), 'agent-logs', `${taskId}.json`);

    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: 'No logs found for this task' });
    }

    const logs = JSON.parse(fs.readFileSync(logsPath, 'utf-8'));

    // Extraer archivos únicos
    const filesSet = new Set<string>();
    const fileDetails = new Map<string, any>();

    logs.forEach((entry: any) => {
      if (entry.type === 'tool' && ['Write', 'Edit'].includes(entry.tool)) {
        const filePath = entry.input?.file_path || entry.input?.path;
        if (filePath) {
          filesSet.add(filePath);
          if (!fileDetails.has(filePath)) {
            fileDetails.set(filePath, {
              path: filePath,
              firstModified: entry.timestamp,
              lastModified: entry.timestamp,
              operations: [],
              agents: new Set()
            });
          }

          const detail = fileDetails.get(filePath);
          detail.lastModified = entry.timestamp;
          detail.operations.push({
            type: entry.tool,
            timestamp: entry.timestamp,
            agent: entry.agent
          });
          detail.agents.add(entry.agent);
        }
      }
    });

    // Convertir a array
    const files = Array.from(fileDetails.values()).map(file => ({
      ...file,
      agents: Array.from(file.agents),
      totalOperations: file.operations.length
    }));

    res.json({
      taskId,
      totalFiles: files.length,
      files
    });
  } catch (error: any) {
    console.error('[Code Route] Error:', error);
    res.status(500).json({ error: 'Failed to retrieve file list' });
  }
});

/**
 * GET /api/code/:taskId/file
 * Obtiene el contenido específico de un archivo
 * Query param: path=/path/to/file
 */
router.get('/:taskId/file', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { path: filePath } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }

    const logsPath = path.join(process.cwd(), 'agent-logs', `${taskId}.json`);

    if (!fs.existsSync(logsPath)) {
      return res.status(404).json({ error: 'No logs found for this task' });
    }

    const logs = JSON.parse(fs.readFileSync(logsPath, 'utf-8'));

    // Buscar la última versión del archivo
    let lastContent = null;
    let history: any[] = [];

    logs.forEach((entry: any) => {
      if (entry.type === 'tool' && ['Write', 'Edit'].includes(entry.tool)) {
        const entryPath = entry.input?.file_path || entry.input?.path;
        if (entryPath === filePath) {
          history.push({
            timestamp: entry.timestamp,
            operation: entry.tool,
            agent: entry.agent,
            content: entry.tool === 'Write'
              ? entry.input?.content
              : entry.input?.new_string
          });

          if (entry.tool === 'Write') {
            lastContent = entry.input?.content;
          } else if (entry.tool === 'Edit' && lastContent) {
            // Intentar aplicar la edición (simplificado)
            lastContent = lastContent.replace(
              entry.input?.old_string,
              entry.input?.new_string
            );
          }
        }
      }
    });

    res.json({
      taskId,
      filePath,
      currentContent: lastContent,
      history,
      totalOperations: history.length
    });
  } catch (error: any) {
    console.error('[Code Route] Error:', error);
    res.status(500).json({ error: 'Failed to retrieve file content' });
  }
});

/**
 * GET /api/code/:taskId/stream
 * Server-Sent Events para ver código en tiempo real
 */
router.get('/:taskId/stream', (req, res) => {
  const { taskId } = req.params;

  // Configurar SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Listener para eventos de código
  const codeWriteHandler = (data: any) => {
    if (data.taskId === taskId) {
      res.write(`event: code:write\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  const codeEditHandler = (data: any) => {
    if (data.taskId === taskId) {
      res.write(`event: code:edit\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Suscribir a eventos
  NotificationService.on('agent:code:write', codeWriteHandler);
  NotificationService.on('agent:code:edit', codeEditHandler);

  // Keep-alive
  const keepAlive = setInterval(() => {
    res.write(':keepalive\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    NotificationService.off('agent:code:write', codeWriteHandler);
    NotificationService.off('agent:code:edit', codeEditHandler);
    clearInterval(keepAlive);
  });
});

// Import NotificationService type
import { NotificationService } from '../services/NotificationService';

export default router;