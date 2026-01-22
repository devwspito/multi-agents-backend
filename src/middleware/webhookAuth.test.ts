import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import request from 'supertest';
import express, { Express } from 'express';
import { authenticateWebhook, WebhookAuthRequest } from './webhookAuth';
import { WebhookApiKeyRepository } from '../database/repositories/WebhookApiKeyRepository.js';
import { ProjectRepository } from '../database/repositories/ProjectRepository.js';
import { UserRepository } from '../database/repositories/UserRepository.js';
import { initDb, closeDb } from '../database/index.js';

describe('authenticateWebhook Middleware', () => {
  let app: Express;
  let projectId: string;
  let userId: string;
  let validApiKey: string;
  let inactiveApiKey: string;

  beforeAll(async () => {
    // Initialize database
    initDb();

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

    // Create test user and project with unique IDs per run
    const uniqueSuffix = Date.now().toString(36) + Math.random().toString(36).substring(2);
    const user = UserRepository.create({
      username: `webhooktest_${uniqueSuffix}`,
      email: `webhook_${uniqueSuffix}@example.com`,
      githubId: `webhook_${uniqueSuffix}`,
      accessToken: `test-webhook-access-token-${uniqueSuffix}`,
    });
    userId = user.id;

    const project = ProjectRepository.create({
      name: 'Webhook Test Project',
      userId: userId,
      isActive: true,
    });
    projectId = project.id;

    // Create active API key
    validApiKey = 'whk_' + Math.random().toString(36).substring(2, 15);
    WebhookApiKeyRepository.create({
      apiKey: validApiKey,
      projectId,
      name: 'Valid Test Key',
      isActive: true,
    });

    // Create inactive API key
    inactiveApiKey = 'whk_' + Math.random().toString(36).substring(2, 15);
    WebhookApiKeyRepository.create({
      apiKey: inactiveApiKey,
      projectId,
      name: 'Inactive Test Key',
      isActive: false,
    });
  });

  afterAll(async () => {
    // Cleanup
    WebhookApiKeyRepository.deleteByProjectId(projectId);
    ProjectRepository.delete(projectId);
    UserRepository.delete(userId);
    closeDb();
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
      expect(response.body.projectId).toBe(projectId);
    });

    it('should authenticate with Authorization Bearer header', async () => {
      const response = await request(app)
        .post('/webhook/test')
        .set('Authorization', `Bearer ${validApiKey}`);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.projectId).toBe(projectId);
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
      expect(capturedAuth.projectId).toBe(projectId);
      expect(capturedAuth.apiKeyDoc).toBeDefined();
      expect(capturedAuth.apiKeyDoc.apiKey).toBe(validApiKey);
    });
  });
});
