import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { authenticateWebhook, WebhookAuthRequest } from './webhookAuth';
import { WebhookApiKey } from '../models/WebhookApiKey';
import { Project } from '../models/Project';
import { User } from '../models/User';
import { env } from '../config/env';

describe('webhookAuth Middleware', () => {
  let testUser: any;
  let testProject: any;
  let validApiKey: string;

  beforeAll(async () => {
    if (!mongoose.connection.readyState) {
      await mongoose.connect(env.MONGODB_URI || 'mongodb://localhost/webhook-test');
    }

    testUser = await User.create({
      githubId: 'test-github-id',
      username: 'testuser',
      email: 'test@example.com',
    });

    testProject = await Project.create({
      name: 'Test Project',
      userId: testUser._id,
      isActive: true,
    });

    validApiKey = WebhookApiKey.generateApiKey();
    await WebhookApiKey.create({
      apiKey: validApiKey,
      projectId: testProject._id,
      name: 'Test API Key',
      isActive: true,
      requestCount: 0,
    });
  });

  afterAll(async () => {
    await WebhookApiKey.deleteMany({});
    await Project.deleteMany({});
    await User.deleteMany({});
    await mongoose.disconnect();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createMockRequest = (overrides: Partial<Request> = {}): WebhookAuthRequest => {
    return {
      headers: {},
      ip: '127.0.0.1',
      socket: {
        remoteAddress: '127.0.0.1',
      } as any,
      ...overrides,
    } as any;
  };

  const createMockResponse = (): Response => {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    return res;
  };

  const mockNext = jest.fn();

  describe('Valid API Key', () => {
    it('should authenticate with valid X-API-Key header', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(req.webhookAuth).toBeDefined();
      expect(req.webhookAuth?.apiKeyDoc.apiKey).toBe(validApiKey);
      expect(req.webhookAuth?.projectId).toBe(testProject._id.toString());
    });

    it('should authenticate with valid Authorization Bearer token', async () => {
      const req = createMockRequest({
        headers: { authorization: `Bearer ${validApiKey}` },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(req.webhookAuth).toBeDefined();
      expect(req.webhookAuth?.apiKeyDoc.apiKey).toBe(validApiKey);
    });

    it('should prefer X-API-Key header over Authorization header', async () => {
      const invalidKey = 'invalid_key_123';
      const req = createMockRequest({
        headers: {
          'x-api-key': validApiKey,
          authorization: `Bearer ${invalidKey}`,
        },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(req.webhookAuth?.apiKeyDoc.apiKey).toBe(validApiKey);
    });

    it('should update lastUsedAt timestamp on successful auth', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
      });
      const res = createMockResponse();

      const beforeAuth = new Date();
      await authenticateWebhook(req, res, mockNext);
      const afterAuth = new Date();

      const updated = await WebhookApiKey.findOne({ apiKey: validApiKey });
      expect(updated?.lastUsedAt).toBeDefined();
      expect(updated!.lastUsedAt!.getTime()).toBeGreaterThanOrEqual(beforeAuth.getTime());
      expect(updated!.lastUsedAt!.getTime()).toBeLessThanOrEqual(afterAuth.getTime());
    });

    it('should increment requestCount on successful auth', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
      });
      const res = createMockResponse();

      const before = await WebhookApiKey.findOne({ apiKey: validApiKey });
      const initialCount = before?.requestCount || 0;

      await authenticateWebhook(req, res, mockNext);

      const after = await WebhookApiKey.findOne({ apiKey: validApiKey });
      expect(after?.requestCount).toBe(initialCount + 1);
    });
  });

  describe('Invalid API Key', () => {
    it('should reject request with invalid API key', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': 'invalid_key_123' },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid or inactive API key',
      });
      expect(mockNext).not.toHaveBeenCalled();
      expect(req.webhookAuth).toBeUndefined();
    });

    it('should reject request with malformed Bearer token', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer invalid_key_123' },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject inactive API keys', async () => {
      const inactiveKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey: inactiveKey,
        projectId: testProject._id,
        name: 'Inactive Key',
        isActive: false,
        requestCount: 0,
      });

      const req = createMockRequest({
        headers: { 'x-api-key': inactiveKey },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Missing API Key', () => {
    it('should reject request with no API key', async () => {
      const req = createMockRequest({
        headers: {},
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: expect.stringContaining('API key required'),
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject request with empty X-API-Key header', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': '' },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should reject request with empty Authorization header', async () => {
      const req = createMockRequest({
        headers: { authorization: 'Bearer ' },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
      });
      const res = createMockResponse();

      const originalUpdateOne = WebhookApiKey.updateOne;
      (WebhookApiKey.updateOne as any) = jest
        .fn()
        .mockRejectedValue(new Error('DB Error'));

      await authenticateWebhook(req, res, mockNext);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Authentication failed',
      });

      WebhookApiKey.updateOne = originalUpdateOne;
    });
  });

  describe('IP Address Extraction', () => {
    it('should extract IP from x-forwarded-for header', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const req = createMockRequest({
        headers: {
          'x-api-key': validApiKey,
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
        },
        ip: '127.0.0.1',
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('ip=192.168.1.1')
      );

      consoleSpy.mockRestore();
    });

    it('should use req.ip as fallback', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
        ip: '192.168.1.100',
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('ip=192.168.1.100')
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Logging', () => {
    it('should log successful authentication', async () => {
      const consoleSpy = jest.spyOn(console, 'info').mockImplementation();
      const req = createMockRequest({
        headers: { 'x-api-key': validApiKey },
        ip: '192.168.1.1',
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('✅ Successful webhook auth')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('ip=192.168.1.1')
      );

      consoleSpy.mockRestore();
    });

    it('should log failed authentication with redacted key', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const req = createMockRequest({
        headers: { 'x-api-key': 'invalid_key_12345' },
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('❌ Failed webhook auth')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[REDACTED]')
      );

      consoleSpy.mockRestore();
    });

    it('should log missing API key', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const req = createMockRequest({
        headers: {},
      });
      const res = createMockResponse();

      await authenticateWebhook(req, res, mockNext);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('missing_key')
      );

      consoleSpy.mockRestore();
    });
  });
});
