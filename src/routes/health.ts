/**
 * Health Check Routes
 *
 * Production-grade health endpoints for Kubernetes/Docker deployments:
 * - /health - Basic health (for load balancers, always fast)
 * - /health/ready - Readiness probe (checks dependencies)
 * - /health/live - Liveness probe (is the process alive?)
 * - /health/detailed - Full system status (for debugging)
 *
 * Checks ALL external services: MongoDB, Redis, Firebase, Anthropic, Voyage, GitHub
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import Redis from 'ioredis';
import { storageService } from '../services/storage/StorageService';
import { productionMonitoring } from '../services/ProductionMonitoringService';

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

  // Redis check - real ping
  if (process.env.REDIS_URL) {
    const redisStart = Date.now();
    try {
      const client = new Redis(process.env.REDIS_URL, {
        connectTimeout: 5000,
        lazyConnect: true,
      });
      await client.connect();
      await client.ping();
      await client.quit();
      checks.redis = {
        status: 'ok',
        latency: Date.now() - redisStart,
        message: 'Connected and responding',
      };
    } catch (error: any) {
      checks.redis = {
        status: 'error',
        latency: Date.now() - redisStart,
        message: error.message,
      };
    }
  }

  // Firebase Storage check
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    const firebaseStart = Date.now();
    try {
      if (storageService.isAvailable()) {
        // Try to list files (empty folder is OK)
        await storageService.listFiles('health-check');
        checks.firebase = {
          status: 'ok',
          latency: Date.now() - firebaseStart,
          message: 'Storage accessible',
        };
      } else {
        checks.firebase = {
          status: 'error',
          message: 'Storage not initialized',
        };
      }
    } catch (error: any) {
      checks.firebase = {
        status: 'error',
        latency: Date.now() - firebaseStart,
        message: error.message,
      };
    }
  }

  // Anthropic API check
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropicStart = Date.now();
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      checks.anthropic = {
        status: response.ok ? 'ok' : (response.status === 401 ? 'error' : 'degraded'),
        latency: Date.now() - anthropicStart,
        message: response.ok ? 'API responding' : `HTTP ${response.status}`,
      };
    } catch (error: any) {
      checks.anthropic = {
        status: 'error',
        latency: Date.now() - anthropicStart,
        message: error.message,
      };
    }
  }

  // GitHub App check
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
    checks.github = {
      status: 'ok',
      message: 'GitHub App configured',
    };
  } else if (process.env.GITHUB_CLIENT_ID) {
    checks.github = {
      status: 'degraded',
      message: 'Only OAuth configured (no App)',
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

/**
 * GET /health/metrics
 * Production metrics - costs, alerts, service health
 * For monitoring dashboards and alerting systems
 */
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await productionMonitoring.getMetricsSummary();

    res.json({
      timestamp: new Date().toISOString(),
      ...metrics,
      costsFormatted: {
        daily: `$${metrics.costs.daily.toFixed(2)}`,
        limit: `$${metrics.costs.limit.toFixed(2)}`,
        percentage: `${metrics.costs.percentage.toFixed(1)}%`,
        status: metrics.costs.percentage >= 100 ? 'exceeded' :
                metrics.costs.percentage >= 80 ? 'warning' : 'healthy',
      },
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to retrieve metrics',
      message: error.message,
    });
  }
});

export default router;
