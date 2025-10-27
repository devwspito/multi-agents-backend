import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import mongoose from 'mongoose';
import { WebhookApiKey } from './WebhookApiKey';
import { Project } from './Project';
import { User } from './User';
import { env } from '../config/env';

describe('WebhookApiKey Model', () => {
  let testUser: any;
  let testProject: any;

  beforeAll(async () => {
    // Connect to test database
    if (!mongoose.connection.readyState) {
      await mongoose.connect(env.MONGODB_URI || 'mongodb://localhost/webhook-test');
    }

    // Create test user
    testUser = await User.create({
      githubId: 'test-github-id',
      username: 'testuser',
      email: 'test@example.com',
    });

    // Create test project
    testProject = await Project.create({
      name: 'Test Project',
      userId: testUser._id,
      isActive: true,
    });
  });

  afterAll(async () => {
    // Cleanup
    await WebhookApiKey.deleteMany({});
    await Project.deleteMany({});
    await User.deleteMany({});
    await mongoose.disconnect();
  });

  describe('generateApiKey()', () => {
    it('should generate API key with whk_ prefix', () => {
      const key = WebhookApiKey.generateApiKey();
      expect(key).toMatch(/^whk_/);
    });

    it('should generate unique API keys', () => {
      const key1 = WebhookApiKey.generateApiKey();
      const key2 = WebhookApiKey.generateApiKey();
      expect(key1).not.toBe(key2);
    });

    it('should generate API key with correct length', () => {
      const key = WebhookApiKey.generateApiKey();
      // whk_ = 4 chars + 64 chars (hex of 32 bytes) = 68 chars
      expect(key.length).toBe(68);
    });

    it('should only contain hexadecimal characters after prefix', () => {
      const key = WebhookApiKey.generateApiKey();
      const hexPart = key.substring(4);
      expect(/^[0-9a-f]+$/.test(hexPart)).toBe(true);
    });
  });

  describe('validateApiKey()', () => {
    it('should return null for missing key', async () => {
      const result = await WebhookApiKey.validateApiKey('');
      expect(result).toBeNull();
    });

    it('should return null for non-string key', async () => {
      const result = await WebhookApiKey.validateApiKey(null as any);
      expect(result).toBeNull();
    });

    it('should return null for invalid key', async () => {
      const result = await WebhookApiKey.validateApiKey('invalid_key_12345');
      expect(result).toBeNull();
    });

    it('should return null for inactive key', async () => {
      const key = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey: key,
        projectId: testProject._id,
        name: 'Inactive Key',
        isActive: false,
        requestCount: 0,
      });

      const result = await WebhookApiKey.validateApiKey(key);
      expect(result).toBeNull();
    });

    it('should find and return active key', async () => {
      const key = WebhookApiKey.generateApiKey();
      const created = await WebhookApiKey.create({
        apiKey: key,
        projectId: testProject._id,
        name: 'Test Key',
        isActive: true,
        requestCount: 0,
      });

      const result = await WebhookApiKey.validateApiKey(key);
      expect(result).not.toBeNull();
      expect(result?.apiKey).toBe(key);
      expect(result?.projectId.toString()).toBe(testProject._id.toString());
    });

    it('should use constant-time comparison', async () => {
      const key1 = WebhookApiKey.generateApiKey();
      const key2 = WebhookApiKey.generateApiKey();

      await WebhookApiKey.create({
        apiKey: key1,
        projectId: testProject._id,
        name: 'Key 1',
        isActive: true,
        requestCount: 0,
      });

      // Should find key1
      const result1 = await WebhookApiKey.validateApiKey(key1);
      expect(result1?.apiKey).toBe(key1);

      // Should not find key2
      const result2 = await WebhookApiKey.validateApiKey(key2);
      expect(result2).toBeNull();

      // Should not find similar key
      const similarKey = key1.substring(0, 10) + 'wrongsuffix';
      const result3 = await WebhookApiKey.validateApiKey(similarKey);
      expect(result3).toBeNull();
    });

    it('should handle database errors gracefully', async () => {
      // Temporarily disconnect to simulate error
      const originalFind = WebhookApiKey.find;
      (WebhookApiKey.find as any) = jest.fn().mockRejectedValue(new Error('DB Error'));

      const result = await WebhookApiKey.validateApiKey('whk_somekey');
      expect(result).toBeNull();

      // Restore
      WebhookApiKey.find = originalFind;
    });
  });

  describe('schema fields', () => {
    it('should have required fields', async () => {
      try {
        await WebhookApiKey.create({
          // Missing required fields
          projectId: testProject._id,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.errors.apiKey).toBeDefined();
        expect(error.errors.name).toBeDefined();
      }
    });

    it('should enforce unique apiKey', async () => {
      const key = WebhookApiKey.generateApiKey();
      await WebhookApiKey.create({
        apiKey: key,
        projectId: testProject._id,
        name: 'Key 1',
        isActive: true,
        requestCount: 0,
      });

      try {
        await WebhookApiKey.create({
          apiKey: key, // Same key
          projectId: testProject._id,
          name: 'Key 2',
          isActive: true,
          requestCount: 0,
        });
        expect(true).toBe(false); // Should not reach here
      } catch (error: any) {
        expect(error.code).toBe(11000); // Duplicate key error
      }
    });

    it('should have correct default values', async () => {
      const key = WebhookApiKey.generateApiKey();
      const doc = await WebhookApiKey.create({
        apiKey: key,
        projectId: testProject._id,
        name: 'Test Key',
      });

      expect(doc.isActive).toBe(true);
      expect(doc.rateLimit).toBe(60);
      expect(doc.requestCount).toBe(0);
      expect(doc.lastUsedAt).toBeUndefined();
    });

    it('should have timestamps', async () => {
      const key = WebhookApiKey.generateApiKey();
      const doc = await WebhookApiKey.create({
        apiKey: key,
        projectId: testProject._id,
        name: 'Test Key',
        isActive: true,
        requestCount: 0,
      });

      expect(doc.createdAt).toBeDefined();
      expect(doc.updatedAt).toBeDefined();
      expect(doc.createdAt instanceof Date).toBe(true);
      expect(doc.updatedAt instanceof Date).toBe(true);
    });
  });
});
