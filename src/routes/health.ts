/**
 * Health Check Routes
 */

import { Router, Request, Response } from 'express';
import Redis from 'ioredis';
import { storageService } from '../services/storage/StorageService';
import { productionMonitoring } from '../services/ProductionMonitoringService';
import { getDb } from '../database/index.js';

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

const startTime = Date.now();

router.get('/', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString(), uptime: Math.floor((Date.now() - startTime) / 1000) });
});

router.get('/ready', async (_req: Request, res: Response) => {
  const checks: HealthStatus['checks'] = {};
  let isReady = true;

  // Check SQLite
  const sqliteStart = Date.now();
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    checks.sqlite = { status: 'ok', latency: Date.now() - sqliteStart };
  } catch (error: any) {
    checks.sqlite = { status: 'error', message: error.message };
    isReady = false;
  }

  // Check Redis (if configured)
  if (process.env.REDIS_URL) {
    checks.redis = { status: 'ok', message: 'Redis URL configured' };
  }

  // Check Anthropic API key
  if (process.env.ANTHROPIC_API_KEY) {
    checks.anthropic = { status: 'ok', message: 'API key configured' };
  } else {
    checks.anthropic = { status: 'error', message: 'ANTHROPIC_API_KEY not configured' };
    isReady = false;
  }

  // Memory check
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  const heapPercentage = (memUsage.heapUsed / memUsage.heapTotal) * 100;
  checks.memory = {
    status: heapPercentage > 90 ? 'degraded' : 'ok',
    message: heapUsedMB + 'MB / ' + heapTotalMB + 'MB (' + heapPercentage.toFixed(1) + '%)',
  };

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || '1.0.0',
    checks,
  });
});

router.get('/detailed', async (_req: Request, res: Response) => {
  const checks: HealthStatus['checks'] = {};

  // SQLite check
  const sqliteStart = Date.now();
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    checks.sqlite = { status: 'ok', latency: Date.now() - sqliteStart, message: 'Connected and responsive' };
  } catch (error: any) {
    checks.sqlite = { status: 'error', latency: Date.now() - sqliteStart, message: error.message };
  }

  // Redis check
  if (process.env.REDIS_URL) {
    const redisStart = Date.now();
    try {
      const client = new Redis(process.env.REDIS_URL, { connectTimeout: 5000, lazyConnect: true });
      await client.connect();
      await client.ping();
      await client.quit();
      checks.redis = { status: 'ok', latency: Date.now() - redisStart, message: 'Connected and responding' };
    } catch (error: any) {
      checks.redis = { status: 'error', latency: Date.now() - redisStart, message: error.message };
    }
  }

  // Firebase Storage
  if (process.env.FIREBASE_STORAGE_BUCKET) {
    const firebaseStart = Date.now();
    try {
      if (storageService.isAvailable()) {
        await storageService.listFiles('health-check');
        checks.firebase = { status: 'ok', latency: Date.now() - firebaseStart, message: 'Storage accessible' };
      } else {
        checks.firebase = { status: 'error', message: 'Storage not initialized' };
      }
    } catch (error: any) {
      checks.firebase = { status: 'error', latency: Date.now() - firebaseStart, message: error.message };
    }
  }

  // Anthropic API
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
        body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      checks.anthropic = { status: response.ok ? 'ok' : (response.status === 401 ? 'error' : 'degraded'), latency: Date.now() - anthropicStart, message: response.ok ? 'API responding' : 'HTTP ' + response.status };
    } catch (error: any) {
      checks.anthropic = { status: 'error', latency: Date.now() - anthropicStart, message: error.message };
    }
  }

  // GitHub
  if (process.env.GITHUB_APP_ID && process.env.GITHUB_PRIVATE_KEY) {
    checks.github = { status: 'ok', message: 'GitHub App configured' };
  } else if (process.env.GITHUB_CLIENT_ID) {
    checks.github = { status: 'degraded', message: 'Only OAuth configured' };
  }

  // Voyage API
  if (process.env.VOYAGE_API_KEY) {
    const voyageStart = Date.now();
    try {
      const response = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.VOYAGE_API_KEY },
        body: JSON.stringify({ model: 'voyage-code-2', input: ['health check'] }),
      });
      checks.voyage = { status: response.ok ? 'ok' : 'error', latency: Date.now() - voyageStart, message: response.ok ? 'API responding' : 'HTTP ' + response.status };
    } catch (error: any) {
      checks.voyage = { status: 'error', latency: Date.now() - voyageStart, message: error.message };
    }
  }

  checks.environment = { status: 'ok', message: process.env.NODE_ENV || 'development' };

  const memUsage = process.memoryUsage();
  checks.memory = {
    status: 'ok',
    message: JSON.stringify({
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
    }),
  };

  const cpuStart = Date.now();
  await new Promise(resolve => setImmediate(resolve));
  const eventLoopLag = Date.now() - cpuStart;
  checks.eventLoop = { status: eventLoopLag > 100 ? 'degraded' : 'ok', latency: eventLoopLag, message: eventLoopLag > 100 ? 'High lag' : 'Normal' };

  const statuses = Object.values(checks).map(c => c.status);
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (statuses.includes('error')) overallStatus = 'unhealthy';
  else if (statuses.includes('degraded')) overallStatus = 'degraded';

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

router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await productionMonitoring.getMetricsSummary();
    res.json({
      timestamp: new Date().toISOString(),
      ...metrics,
      costsFormatted: {
        daily: '$' + metrics.costs.daily.toFixed(2),
        limit: '$' + metrics.costs.limit.toFixed(2),
        percentage: metrics.costs.percentage.toFixed(1) + '%',
        status: metrics.costs.percentage >= 100 ? 'exceeded' : metrics.costs.percentage >= 80 ? 'warning' : 'healthy',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve metrics', message: error.message });
  }
});

export default router;
