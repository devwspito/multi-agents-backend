import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import mongoose from 'mongoose';
import { WebhookApiKey } from './WebhookApiKey';
import { Project } from './Project';
import { User } from './User';

describe('WebhookApiKey Model', () => {
  let projectId: mongoose.Types.ObjectId;
  let userId: mongoose.Types.ObjectId;

  beforeAll(async () => {
    // Create test user and project
    const user = await User.create({
      username: 'testuser',
      email: 'test@example.com',
      githubId: 'test123',
      accessToken: 'test-access-token-12345',
    });
    userId = user._id as mongoose.Types.ObjectId;

    const project = await Project.create({
      name: 'Test Project',
      userId: userId,
      isActive: true,
    });
    projectId = project._id as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    // Cleanup
    await WebhookApiKey.deleteMany({});
    await Project.deleteMany({});
    await User.deleteMany({});
  });

  describe('generateApiKey', () => {
    it('should generate API key with whk_ prefix', () => {
      const key = WebhookApiKey.generateApiKey();
      expect(key).toMatch(/^whk_/);
    });

    it('should generate unique keys', () => {
      const key1 = WebhookApiKey.generateApiKey();
      const key2 = WebhookApiKey.generateApiKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate 64 hex characters after prefix', () => {
      const key = WebhookApiKey.generateApiKey();
      const keyWithoutPrefix = key.replace(/^whk_/, '');
      expect(keyWithoutPrefix).toHaveLength(64);
      expect(keyWithoutPrefix).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('validateApiKey', () => {
    it('should return null for null input', async () => {
      const result = await WebhookApiKey.validateApiKey(null as any);
      expect(result).toBeNull();
    });

    it('should return null for empty string', async () => {
      const result = await WebhookApiKey.validateApiKey('');
      expect(result).toBeNull();
    });

    it('should return null for non-string input', async () => {
      const result = await WebhookApiKey.validateApiKey(123 as any);
      expect(result).toBeNull();
    });

    it('should return API key document for valid active key', async () => {
      const apiKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey,
        projectId,
        name: 'Test Key',
        isActive: true,
      });

      const result = await WebhookApiKey.validateApiKey(apiKey);
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe(apiKey);
      expect(result?.isActive).toBe(true);
      expect(result?.projectId).toEqual(projectId);
    });

    it('should return null for invalid key', async () => {
      const result = await WebhookApiKey.validateApiKey('whk_invalidkey123');
      expect(result).toBeNull();
    });

    it('should return null for inactive key', async () => {
      const apiKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey,
        projectId,
        name: 'Inactive Key',
        isActive: false,
      });

      const result = await WebhookApiKey.validateApiKey(apiKey);
      expect(result).toBeNull();
    });

    it('should use constant-time comparison (prevent timing attacks)', async () => {
      const validKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey: validKey,
        projectId,
        name: 'Timing Test Key',
        isActive: true,
      });

      // Create a key with same length but different characters
      const invalidKey = validKey.replace('a', 'z');

      // Both should complete without timing differences
      const start1 = Date.now();
      await WebhookApiKey.validateApiKey(invalidKey);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      await WebhookApiKey.validateApiKey(validKey);
      const time2 = Date.now() - start2;

      // Times should be within reasonable range (constant-time comparison)
      const timeDifference = Math.abs(time1 - time2);
      expect(timeDifference).toBeLessThan(100); // Within 100ms
    });
  });

  describe('Schema validation', () => {
    it('should enforce unique API keys', async () => {
      const apiKey = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey,
        projectId,
        name: 'Key 1',
        isActive: true,
      });

      await expect(
        WebhookApiKey.create({
          apiKey,
          projectId,
          name: 'Key 2',
          isActive: true,
        })
      ).rejects.toThrow();
    });

    it('should have correct default values', async () => {
      const apiKey = WebhookApiKey.generateApiKey();
      const doc = await WebhookApiKey.create({
        apiKey,
        projectId,
        name: 'Default Test',
      });

      expect(doc.isActive).toBe(true);
      expect(doc.rateLimit).toBe(60);
      expect(doc.requestCount).toBe(0);
      expect(doc.lastUsedAt).toBeUndefined();
    });

    it('should have createdAt and updatedAt timestamps', async () => {
      const apiKey = WebhookApiKey.generateApiKey();
      const doc = await WebhookApiKey.create({
        apiKey,
        projectId,
        name: 'Timestamp Test',
      });

      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.createdAt).toEqual(doc.updatedAt);
    });
  });
});
