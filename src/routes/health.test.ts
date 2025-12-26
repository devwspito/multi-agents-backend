/**
 * Health Routes Tests
 *
 * Tests production-grade health check endpoints
 */

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import healthRoutes from './health';

describe('Health Routes', () => {
  let app: express.Application;

  beforeAll(() => {
    app = express();
    app.use('/health', healthRoutes);
  });

  describe('GET /health', () => {
    it('should return 200 with healthy status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('healthy');
      expect(response.body.timestamp).toBeDefined();
    });

    it('should respond quickly (under 100ms)', async () => {
      const start = Date.now();
      await request(app).get('/health');
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });
  });

  describe('GET /health/live', () => {
    it('should return 200 with alive status', async () => {
      const response = await request(app).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('alive');
      expect(response.body.uptime).toBeGreaterThanOrEqual(0);
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /health/ready', () => {
    it('should return health status with checks', async () => {
      const response = await request(app).get('/health/ready');

      // May be 200 or 503 depending on DB connection
      expect([200, 503]).toContain(response.status);
      expect(response.body.status).toBeDefined();
      expect(response.body.checks).toBeDefined();
      expect(response.body.version).toBeDefined();
    });

    it('should include MongoDB check', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.body.checks.mongodb).toBeDefined();
      expect(['ok', 'error', 'degraded']).toContain(response.body.checks.mongodb.status);
    });

    it('should include Anthropic API check', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.body.checks.anthropic).toBeDefined();
    });

    it('should include memory check', async () => {
      const response = await request(app).get('/health/ready');

      expect(response.body.checks.memory).toBeDefined();
      expect(response.body.checks.memory.message).toBeDefined();
    });
  });

  describe('GET /health/detailed', () => {
    it('should return detailed health information', async () => {
      const response = await request(app).get('/health/detailed');

      // May be 200 or 503 depending on services
      expect([200, 503]).toContain(response.status);
      expect(response.body.status).toBeDefined();
      expect(response.body.checks).toBeDefined();
      expect(response.body.node).toBeDefined();
      expect(response.body.platform).toBeDefined();
      expect(response.body.pid).toBeDefined();
    });

    it('should include environment check', async () => {
      const response = await request(app).get('/health/detailed');

      expect(response.body.checks.environment).toBeDefined();
    });

    it('should include memory details', async () => {
      const response = await request(app).get('/health/detailed');

      expect(response.body.checks.memory).toBeDefined();
    });

    it('should include event loop check', async () => {
      const response = await request(app).get('/health/detailed');

      expect(response.body.checks.eventLoop).toBeDefined();
      expect(response.body.checks.eventLoop.latency).toBeDefined();
    });
  });

  describe('Response format', () => {
    it('should always return JSON', async () => {
      const response = await request(app).get('/health');

      expect(response.headers['content-type']).toMatch(/json/);
    });

    it('should include timestamp in ISO format', async () => {
      const response = await request(app).get('/health');

      const timestamp = new Date(response.body.timestamp);
      expect(timestamp.toISOString()).toBe(response.body.timestamp);
    });
  });
});
