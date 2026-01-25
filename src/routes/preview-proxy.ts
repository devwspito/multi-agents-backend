/**
 * Preview Proxy Routes
 *
 * Proxies requests to Docker sandbox containers for live preview.
 * This allows the frontend to access sandbox preview through the API
 * instead of requiring direct access to Docker's dynamic ports.
 *
 * Architecture:
 * Browser → Caddy (:443) → Backend (:3001) → Docker Container (localhost:32768+)
 *
 * URL format:
 * /api/preview/:taskId/*
 * /api/preview/:taskId/port/:port/*  (for specific ports)
 */

import { Router, Request, Response } from 'express';
import http from 'http';
import { sandboxService } from '../services/SandboxService.js';

const router = Router();

/**
 * Get the host port for a given sandbox and container port
 */
function getHostPort(taskId: string, containerPort: string = '8080'): string | null {
  const found = sandboxService.findSandboxForTask(taskId);
  if (!found) {
    console.log(`[Preview Proxy] No sandbox found for task ${taskId}`);
    return null;
  }

  const { instance } = found;
  if (!instance.mappedPorts) {
    console.log(`[Preview Proxy] No mapped ports for task ${taskId}`);
    return null;
  }

  const hostPort = instance.mappedPorts[containerPort];
  if (!hostPort) {
    // Try to find any available port
    const availablePorts = Object.values(instance.mappedPorts);
    if (availablePorts.length > 0) {
      console.log(`[Preview Proxy] Port ${containerPort} not found, using first available: ${availablePorts[0]}`);
      return availablePorts[0];
    }
    console.log(`[Preview Proxy] No ports available for task ${taskId}`);
    return null;
  }

  return hostPort;
}

/**
 * GET /api/preview/:taskId/info
 * Get sandbox preview information (ports, URLs, etc.)
 */
router.get('/:taskId/info', (req: Request, res: Response): void => {
  const taskId = req.params.taskId as string;

  const found = sandboxService.findSandboxForTask(taskId);
  if (!found) {
    res.status(404).json({
      success: false,
      error: 'Sandbox not found',
      taskId,
    });
    return;
  }

  const { sandboxId, instance } = found;
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // Build preview URLs for each mapped port
  const previewUrls: Record<string, string> = {};
  if (instance.mappedPorts) {
    for (const containerPort of Object.keys(instance.mappedPorts)) {
      previewUrls[containerPort] = `${baseUrl}/api/preview/${taskId}/port/${containerPort}/`;
    }
  }

  res.json({
    success: true,
    taskId,
    sandboxId,
    status: instance.status,
    mappedPorts: instance.mappedPorts || {},
    previewUrls,
    defaultPreviewUrl: `${baseUrl}/api/preview/${taskId}/`,
  });
});

/**
 * Native HTTP proxy handler
 * Proxies requests to Docker containers without external dependencies
 */
function proxyToContainer(
  req: Request,
  res: Response,
  hostPort: string,
  targetPath: string
): void {
  const options: http.RequestOptions = {
    hostname: 'localhost',
    port: parseInt(hostPort, 10),
    path: targetPath || '/',
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${hostPort}`,
    },
  };

  console.log(`[Preview Proxy] ${req.method} → localhost:${hostPort}${targetPath}`);

  const proxyReq = http.request(options, (proxyRes) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Copy status and headers from proxy response
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

    // Pipe the response body
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error(`[Preview Proxy] Error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        error: 'Failed to connect to sandbox',
        details: err.message,
      });
    }
  });

  // Set timeout
  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        error: 'Proxy request timeout',
      });
    }
  });

  // Pipe the request body if present
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

/**
 * Handle CORS preflight
 */
router.options('*', (_req: Request, res: Response): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

/**
 * Proxy with specific port: /api/preview/:taskId/port/:port/*
 */
router.all('/:taskId/port/:port/*', (req: Request, res: Response): void => {
  const taskId = req.params.taskId as string;
  const port = req.params.port as string;

  const hostPort = getHostPort(taskId, port);
  if (!hostPort) {
    res.status(404).json({
      success: false,
      error: 'Sandbox not found or port not available',
      taskId,
      requestedPort: port,
    });
    return;
  }

  // Extract the path after /port/:port/
  const fullPath = req.originalUrl;
  const portPathMatch = fullPath.match(/\/port\/\d+\/(.*)/);
  const targetPath = '/' + (portPathMatch?.[1] || '');

  proxyToContainer(req, res, hostPort, targetPath);
});

router.all('/:taskId/port/:port', (req: Request, res: Response): void => {
  const taskId = req.params.taskId as string;
  const port = req.params.port as string;

  const hostPort = getHostPort(taskId, port);
  if (!hostPort) {
    res.status(404).json({
      success: false,
      error: 'Sandbox not found or port not available',
      taskId,
      requestedPort: port,
    });
    return;
  }

  proxyToContainer(req, res, hostPort, '/');
});

/**
 * Proxy with default port (8080): /api/preview/:taskId/*
 */
router.all('/:taskId/*', (req: Request, res: Response): void => {
  const taskId = req.params.taskId as string;

  // Skip /info endpoint (handled above)
  if (req.path.endsWith('/info')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const hostPort = getHostPort(taskId, '8080');
  if (!hostPort) {
    res.status(404).json({
      success: false,
      error: 'Sandbox not found or no ports available',
      taskId,
    });
    return;
  }

  // Extract the path after /:taskId/
  const fullPath = req.originalUrl;
  const taskIdPattern = new RegExp(`/api/v?1?/?preview/${taskId}/(.*)$`);
  const match = fullPath.match(taskIdPattern);
  const targetPath = '/' + (match?.[1] || '');

  proxyToContainer(req, res, hostPort, targetPath);
});

router.all('/:taskId', (req: Request, res: Response): void => {
  const taskId = req.params.taskId as string;

  const hostPort = getHostPort(taskId, '8080');
  if (!hostPort) {
    res.status(404).json({
      success: false,
      error: 'Sandbox not found or no ports available',
      taskId,
    });
    return;
  }

  proxyToContainer(req, res, hostPort, '/');
});

export default router;
