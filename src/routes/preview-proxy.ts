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

import { Router, Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
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
 * Middleware to resolve sandbox and set target URL
 */
function resolveSandboxTarget(req: Request, res: Response, next: NextFunction) {
  const { taskId, port } = req.params;
  const containerPort = port || '8080';

  const hostPort = getHostPort(taskId, containerPort);
  if (!hostPort) {
    return res.status(404).json({
      success: false,
      error: 'Sandbox not found or no ports available',
      taskId,
      requestedPort: containerPort,
    });
  }

  // Store target info for the proxy middleware
  (req as any).proxyTarget = `http://localhost:${hostPort}`;
  (req as any).hostPort = hostPort;

  next();
}

/**
 * GET /api/preview/:taskId/info
 * Get sandbox preview information (ports, URLs, etc.)
 */
router.get('/:taskId/info', (req: Request, res: Response) => {
  const { taskId } = req.params;

  const found = sandboxService.findSandboxForTask(taskId);
  if (!found) {
    return res.status(404).json({
      success: false,
      error: 'Sandbox not found',
      taskId,
    });
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

  return res.json({
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
 * Dynamic proxy handler
 * Creates a proxy middleware on-the-fly for each request
 */
function proxyHandler(req: Request, res: Response, next: NextFunction) {
  const { taskId, port } = req.params;
  const containerPort = port || '8080';

  const hostPort = getHostPort(taskId, containerPort);
  if (!hostPort) {
    return res.status(404).json({
      success: false,
      error: 'Sandbox not found or no ports available',
      taskId,
      requestedPort: containerPort,
    });
  }

  const target = `http://localhost:${hostPort}`;

  // Get the path after the proxy prefix
  // For /api/preview/:taskId/some/path → /some/path
  // For /api/preview/:taskId/port/:port/some/path → /some/path
  let proxyPath = req.url;

  // Log the proxy request
  console.log(`[Preview Proxy] ${req.method} ${req.originalUrl} → ${target}${proxyPath}`);

  const proxyOptions: Options = {
    target,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    pathRewrite: (_path, _req) => {
      // The path is already correct after Express routing
      return proxyPath;
    },
    onError: (err, _req, res) => {
      console.error(`[Preview Proxy] Error: ${err.message}`);
      if (!res.headersSent) {
        (res as Response).status(502).json({
          success: false,
          error: 'Failed to proxy request to sandbox',
          details: err.message,
        });
      }
    },
    onProxyRes: (proxyRes, _req, _res) => {
      // Add CORS headers to proxied responses
      proxyRes.headers['access-control-allow-origin'] = '*';
      proxyRes.headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
      proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization';
    },
    logLevel: 'warn',
  };

  const proxy = createProxyMiddleware(proxyOptions);
  return proxy(req, res, next);
}

/**
 * Proxy routes with different path patterns
 *
 * /api/preview/:taskId/*              → proxy to default port (8080)
 * /api/preview/:taskId/port/:port/*   → proxy to specific port
 */

// Specific port proxy: /api/preview/:taskId/port/:port/*
router.use('/:taskId/port/:port/*', proxyHandler);
router.use('/:taskId/port/:port', proxyHandler);

// Default port proxy: /api/preview/:taskId/*
// Must come after /port/:port to avoid matching first
router.use('/:taskId/*', (req, res, next) => {
  // Skip if it's the /info endpoint
  if (req.params['0'] === 'info' || req.params['0']?.startsWith('port/')) {
    return next('route');
  }
  return proxyHandler(req, res, next);
});

router.use('/:taskId', (req, res, next) => {
  // Skip if it's the /info endpoint
  if (req.path.endsWith('/info')) {
    return next('route');
  }
  return proxyHandler(req, res, next);
});

export default router;
