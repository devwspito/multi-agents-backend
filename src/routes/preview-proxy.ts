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
 * Check if we're in host network mode (no port mapping needed)
 * In host mode: container ports ARE host ports (no Docker port mapping)
 */
const USE_HOST_NETWORK = process.env.DOCKER_USE_BRIDGE_MODE !== 'true';

/**
 * Get the host port for a given sandbox and container port
 *
 * In host network mode: the container port IS the host port (no mapping)
 * In bridge mode: uses mappedPorts from Docker
 */
function getHostPort(taskId: string, containerPort: string = '8080'): string | null {
  // 🔥 FIX: In host network mode, the container port IS the host port
  // No need to look up mappedPorts - just use the port directly
  if (USE_HOST_NETWORK) {
    console.log(`[Preview Proxy] Host network mode - using port ${containerPort} directly`);
    return containerPort;
  }

  // Bridge mode - need port mapping from sandbox service
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
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // 🔥 FIX: In host network mode, return common ports even without sandbox record
  if (USE_HOST_NETWORK) {
    // Common dev server ports
    const commonPorts = ['8080', '4001', '3000', '5173', '5000'];
    const previewUrls: Record<string, string> = {};

    for (const port of commonPorts) {
      previewUrls[port] = `${baseUrl}/api/v1/preview/${taskId}/port/${port}/`;
    }

    const found = sandboxService.findSandboxForTask(taskId);

    res.json({
      success: true,
      taskId,
      sandboxId: found?.sandboxId || 'host-network',
      status: found?.instance.status || 'running',
      mappedPorts: commonPorts.reduce((acc, p) => ({ ...acc, [p]: p }), {}),
      previewUrls,
      defaultPreviewUrl: `${baseUrl}/api/v1/preview/${taskId}/`,
      hostNetworkMode: true,
    });
    return;
  }

  // Bridge mode - need sandbox record
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

  // Build preview URLs for each mapped port
  const previewUrls: Record<string, string> = {};
  if (instance.mappedPorts) {
    for (const containerPort of Object.keys(instance.mappedPorts)) {
      previewUrls[containerPort] = `${baseUrl}/api/v1/preview/${taskId}/port/${containerPort}/`;
    }
  }

  res.json({
    success: true,
    taskId,
    sandboxId,
    status: instance.status,
    mappedPorts: instance.mappedPorts || {},
    previewUrls,
    defaultPreviewUrl: `${baseUrl}/api/v1/preview/${taskId}/`,
    hostNetworkMode: false,
  });
});

/**
 * Native HTTP proxy handler
 * Proxies requests to Docker containers without external dependencies
 *
 * 🔥 IMPORTANT: Rewrites <base href="/"> in HTML responses to the proxy path.
 * This is required for Flutter/React apps that use relative URLs.
 * Without this fix, the browser would request /flutter_bootstrap.js from root
 * instead of /api/v1/preview/{taskId}/port/{port}/flutter_bootstrap.js
 */
function proxyToContainer(
  req: Request,
  res: Response,
  hostPort: string,
  targetPath: string,
  proxyBasePath?: string
): void {
  const options: http.RequestOptions = {
    hostname: 'localhost',
    port: parseInt(hostPort, 10),
    path: targetPath || '/',
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${hostPort}`,
      // Remove accept-encoding to get uncompressed response for rewriting
      'accept-encoding': 'identity',
    },
  };

  console.log(`[Preview Proxy] ${req.method} → localhost:${hostPort}${targetPath}`);

  const proxyReq = http.request(options, (proxyRes) => {
    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const contentType = proxyRes.headers['content-type'] || '';
    const isHtml = contentType.includes('text/html');

    // 🔥 For HTML responses, buffer and rewrite base href
    if (isHtml && proxyBasePath) {
      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        let html = Buffer.concat(chunks).toString('utf-8');

        // Rewrite <base href="/"> to proxy path
        // This ensures all relative URLs resolve correctly through the proxy
        html = html.replace(
          /<base\s+href=["']\/["']/gi,
          `<base href="${proxyBasePath}"`
        );

        // Also handle base href="/" with spaces
        html = html.replace(
          /<base\s+href\s*=\s*["']\/["']/gi,
          `<base href="${proxyBasePath}"`
        );

        console.log(`[Preview Proxy] Rewrote base href to: ${proxyBasePath}`);

        // Remove content-encoding and set correct content-length
        const headers = { ...proxyRes.headers };
        delete headers['content-encoding'];
        delete headers['content-length'];
        headers['content-length'] = Buffer.byteLength(html).toString();

        res.writeHead(proxyRes.statusCode || 200, headers);
        res.end(html);
      });
      return;
    }

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

  // 🔥 Pass the proxy base path for HTML base href rewriting
  const proxyBasePath = `/api/v1/preview/${taskId}/port/${port}/`;
  proxyToContainer(req, res, hostPort, targetPath, proxyBasePath);
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

  // 🔥 Pass the proxy base path for HTML base href rewriting
  const proxyBasePath = `/api/v1/preview/${taskId}/port/${port}/`;
  proxyToContainer(req, res, hostPort, '/', proxyBasePath);
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

  // 🔥 Pass the proxy base path for HTML base href rewriting
  const proxyBasePath = `/api/v1/preview/${taskId}/`;
  proxyToContainer(req, res, hostPort, targetPath, proxyBasePath);
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

  // 🔥 Pass the proxy base path for HTML base href rewriting
  const proxyBasePath = `/api/v1/preview/${taskId}/`;
  proxyToContainer(req, res, hostPort, '/', proxyBasePath);
});

export default router;
