import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import mongoose from 'mongoose';
import request from 'supertest';
import express, { Express } from 'express';
import { authenticateWebhook, WebhookAuthRequest } from './webhookAuth';
import { WebhookApiKey } from '../models/WebhookApiKey';
import { Project } from '../models/Project';
import { User } from '../models/User';

describe('authenticateWebhook Middleware', () => {
  let app: Express;
  let projectId: mongoose.Types.ObjectId;
  let userId: mongoose.Types.ObjectId;
  let validApiKey: string;
  let inactiveApiKey: string;

  beforeAll(async () => {
    // Create Express app with middleware
    app = express();
    app.use(express.json());
    app.use(authenticateWebhook);
    app.post('/webhook/test', (req: WebhookAuthRequest, res) => {
      res.json({
        success: true,
        projectId: req.webhookAuth?.projectId,
        apiKey: req.webhookAuth?.apiKeyDoc?.apiKey,
      });
    });

    // Create test user and project
    const user = await User.create({
      username: 'webhooktest',
      email: 'webhook@example.com',
      githubId: 'webhook123',
      accessToken: 'test-webhook-access-token-12345',
    });
    userId = user._id as mongoose.Types.ObjectId;

    const project = await Project.create({
      name: 'Webhook Test Project',
      userId: userId,
      isActive: true,
    });
    projectId = project._id as mongoose.Types.ObjectId;

    // Create active API key
    validApiKey = WebhookApiKey.generateApiKey();
    await WebhookApiKey.create({
      apiKey: validApiKey,
      projectId,
      name: 'Valid Test Key',
      isActive: true,
    });

    // Create inactive API key
    inactiveApiKey = WebhookApiKey.generateApiKey();
    await WebhookApiKey.create({
      apiKey: inactiveApiKey,
      projectId,
      name: 'Inactive Test Key',
      isActive: false,
    });
  });

  afterAll(async () => {
    // Cleanup
    await WebhookApiKey.deleteMany({});
    await Project.deleteMany({});
    await User.deleteMany({});
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Valid authentication', () => {
    it('should authenticate with X-API-Key header', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.projectId).toBe(projectId.toString());
    });

    it('should authenticate with Authorization Bearer header', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('Authorization', `Bearer ${validApiKey}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.projectId).toBe(projectId.toString());
    });

    it('should prefer X-API-Key over Authorization header', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey)
        .set('Authorization', 'Bearer invalid');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });
  });

  describe('Invalid authentication', () => {
    it('should return 401 for missing API key', async () => {
      const response = await request(app).post('/webhook/test');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('API key required');
    });

    it('should return 401 for invalid API key', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', 'whk_invalidkey123');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid or inactive API key');
    });

    it('should return 401 for inactive API key', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', inactiveApiKey);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid or inactive API key');
    });

    it('should return 401 for malformed Authorization header', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('Authorization', 'InvalidFormat token');

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Request context', () => {
    it('should attach webhookAuth object to request', async () => {
      const testApp = express();
      testApp.use(express.json());

      let capturedAuth: any;
      testApp.use(authenticateWebhook);
      testApp.post('/webhook/test', (req: WebhookAuthRequest, res) => {
        capturedAuth = req.webhookAuth;
        res.json({ success: true });
      });

      await request(testApp)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(capturedAuth).toBeDefined();
      expect(capturedAuth.projectId).toBe(projectId.toString());
      expect(capturedAuth.apiKeyDoc).toBeDefined();
      expect(capturedAuth.apiKeyDoc.apiKey).toBe(validApiKey);
    });

    it('should attach correct projectId to request', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(response.body.projectId).toBe(projectId.toString());
    });
  });

  describe('Timestamp and counter updates', () => {
    it('should update lastUsedAt timestamp on successful auth', async () => {
      const beforeAuth = new Date();

      const response = await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(response.status).toBe(200);

      const updated = await WebhookApiKey.findOne({ apiKey: validApiKey });
      expect(updated?.lastUsedAt).toBeDefined();
      expect(updated!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(
        beforeAuth.getTime()
      );
    });

    it('should increment requestCount on successful auth', async () => {
      const beforeCount = (await WebhookApiKey.findOne({ apiKey: validApiKey }))
        ?.requestCount || 0;

      await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      const after = await WebhookApiKey.findOne({ apiKey: validApiKey });
      expect(after?.requestCount).toBe(beforeCount + 1);
    });

    it('should increment requestCount multiple times', async () => {
      const newKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey: newKey,
        projectId,
        name: 'Counter Test Key',
        isActive: true,
      });

      const initial = await WebhookApiKey.findOne({ apiKey: newKey });
      expect(initial?.requestCount).toBe(0);

      // Make 5 requests
      for (let i = 0; i < 5; i++) {
        await request(app)
          .post('/webhook/test')
          .set('X-API-Key', newKey);
      }

      const final = await WebhookApiKey.findOne({ apiKey: newKey });
      expect(final?.requestCount).toBe(5);
    });
  });

  describe('Error handling', () => {
    it('should return 500 on database error', async () => {
      const testApp = express();
      testApp.use(express.json());

      // Mock middleware that throws an error
      testApp.use(async (req: WebhookAuthRequest, res, next) => {
        try {
          throw new Error('Database connection failed');
        } catch (error) {
          res.status(500).json({
            success: false,
            error: 'Authentication failed',
          });
        }
      });

      const response = await request(testApp)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
    });
  });

  describe('Audit logging', () => {
    it('should log successful authentication', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await request(app)
        .post('/webhook/test')
        .set('X-API-Key', validApiKey);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('✅ Webhook auth success')
      );

      consoleSpy.mockRestore();
    });

    it('should log failed authentication attempts', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      await request(app)
        .post('/webhook/test')
        .set('X-API-Key', 'whk_invalidkey');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('❌ Failed webhook auth')
      );

      consoleSpy.mockRestore();
    });

    it('should log missing API key attempts', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      await request(app).post('/webhook/test');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('❌ Failed webhook auth: missing key')
      );

      consoleSpy.mockRestore();
    });
  });
});
