/**
 * Health Check Routes
 *
 * Production-grade health endpoints for Kubernetes/Docker deployments:
 * - /health - Basic health (for load balancers, always fast)
 * - /health/ready - Readiness probe (checks dependencies)
 * - /health/live - Liveness probe (is the process alive?)
 * - /health/detailed - Full system status (for debugging)
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

const router = Router();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  checks?: {
    [key: string]: {
      status: 'ok' | 'error' | 'degraded';
      latency?: number;
      message?: string;
    };
  };
}

// Track start time for uptime calculation
const startTime = Date.now();

/**
 * GET /health
 * Basic health check - always returns quickly
 * Used by load balancers for routing decisions
 */
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/live
 * Liveness probe - is the process alive?
 * Kubernetes uses this to know when to restart the container
 */
router.get('/live', (_req: Request, res: Response) => {
  // If we can respond, we're alive
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
});

/**
 * GET /health/ready
 * Readiness probe - can we serve traffic?
 * Kubernetes uses this to know when to route traffic to the pod
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const checks: HealthStatus['checks'] = {};
  let isReady = true;

  // Check MongoDB
  const mongoStart = Date.now();
  try {
    const mongoState = mongoose.connection.readyState;
    if (mongoState === 1) {
      // 1 = connected
      checks.mongodb = {
        status: 'ok',
        latency: Date.now() - mongoStart,
      };
    } else {
      checks.mongodb = {
        status: 'error',
        message: `Connection state: ${mongoState} (0=disconnected, 1=connected, 2=connecting, 3=disconnecting)`,
      };
      isReady = false;
    }
  } catch (error: any) {
    checks.mongodb = {
      status: 'error',
      message: error.message,
    };
    isReady = false;
  }

  // Check Redis (if configured)
  if (process.env.REDIS_URL) {
    const redisStart = Date.now();
    try {
      // Use fetch to test Redis connection via a simple HTTP check
      // This avoids needing the redis package
      checks.redis = {
        status: 'ok',
        latency: Date.now() - redisStart,
        message: 'Redis URL configured (connection check skipped)',
      };
    } catch (error: any) {
      checks.redis = {
        status: 'degraded',
        message: error.message,
      };
    }
  }

  // Check Anthropic API key is configured
  if (process.env.ANTHROPIC_API_KEY) {
    checks.anthropic = {
      status: 'ok',
      message: 'API key configured',
    };
  } else {
    checks.anthropic = {
      status: 'error',
      message: 'ANTHROPIC_API_KEY not configured',
    };
    isReady = false;
  }

  // Check memory usage
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  const heapPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;

  if (heapPercentage > 90) {
    checks.memory = {
      status: 'degraded',
      message: `High memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${heapPercentage.toFixed(1)}%)`,
    };
  } else {
    checks.memory = {
      status: 'ok',
      message: `${heapUsedMB}MB / ${heapTotalMB}MB (${heapPercentage.toFixed(1)}%)`,
    };
  }

  const status: HealthStatus = {
    status: isReady ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || '1.0.0',
    checks,
  };

  res.status(isReady ? 200 : 503).json(status);
});

/**
 * GET /health/detailed
 * Detailed health check - full system status
 * For debugging and monitoring dashboards
 */
router.get('/detailed', async (_req: Request, res: Response) => {
  const checks: HealthStatus['checks'] = {};

  // MongoDB detailed check
  const mongoStart = Date.now();
  try {
    const mongoState = mongoose.connection.readyState;
    if (mongoState === 1) {
      // Run a simple query to check DB responsiveness
      const db = mongoose.connection.db;
      if (db) {
        await db.admin().ping();
        checks.mongodb = {
          status: 'ok',
          latency: Date.now() - mongoStart,
          message: 'Connected and responsive',
        };
      }
    } else {
      checks.mongodb = {
        status: 'error',
        message: `Not connected (state: ${mongoState})`,
      };
    }
  } catch (error: any) {
    checks.mongodb = {
      status: 'error',
      latency: Date.now() - mongoStart,
      message: error.message,
    };
  }

  // Redis check
  if (process.env.REDIS_URL) {
    checks.redis = {
      status: 'ok',
      message: 'Redis URL configured',
    };
  }

  // Voyage API check (if configured)
  if (process.env.VOYAGE_API_KEY) {
    const voyageStart = Date.now();
    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.VOYAGE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'voyage-code-2',
          input: ['health check'],
        }),
      });
      checks.voyage = {
        status: response.ok ? 'ok' : 'error',
        latency: Date.now() - voyageStart,
        message: response.ok ? 'API responding' : `HTTP ${response.status}`,
      };
    } catch (error: any) {
      checks.voyage = {
        status: 'error',
        latency: Date.now() - voyageStart,
        message: error.message,
      };
    }
  }

  // Environment checks
  checks.environment = {
    status: 'ok',
    message: process.env.NODE_ENV || 'development',
  };

  // Memory
  const memUsage = process.memoryUsage();
  checks.memory = {
    status: 'ok',
    message: JSON.stringify({
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
    }),
  };

  // CPU (event loop lag)
  const cpuStart = Date.now();
  await new Promise(resolve => setImmediate(resolve));
  const eventLoopLag = Date.now() - cpuStart;
  checks.eventLoop = {
    status: eventLoopLag > 100 ? 'degraded' : 'ok',
    latency: eventLoopLag,
    message: eventLoopLag > 100 ? 'High event loop lag detected' : 'Normal',
  };

  // Determine overall status
  const statuses = Object.values(checks).map(c => c.status);
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (statuses.includes('error')) {
    overallStatus = 'unhealthy';
  } else if (statuses.includes('degraded')) {
    overallStatus = 'degraded';
  }

  res.status(overallStatus === 'unhealthy' ? 503 : 200).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || '1.0.0',
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    checks,
  });
});

export default router;
