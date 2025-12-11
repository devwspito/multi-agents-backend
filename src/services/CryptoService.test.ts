import { describe, it, expect } from '@jest/globals';
import { CryptoService } from './CryptoService';

describe('CryptoService', () => {
  describe('encrypt/decrypt', () => {
    it('should encrypt and decrypt a value correctly', () => {
      const original = 'sk-ant-api03-my-secret-token-12345';
      const encrypted = CryptoService.encrypt(original);
      const decrypted = CryptoService.decrypt(encrypted);

      expect(encrypted).not.toBe(original);
      expect(encrypted).toMatch(/^enc:/);
      expect(decrypted).toBe(original);
    });

    it('should generate different ciphertexts for same plaintext (random IV)', () => {
      const original = 'same-value-to-encrypt';
      const encrypted1 = CryptoService.encrypt(original);
      const encrypted2 = CryptoService.encrypt(original);

      // Different IVs should produce different ciphertexts
      expect(encrypted1).not.toBe(encrypted2);

      // Both should decrypt to the same value
      expect(CryptoService.decrypt(encrypted1)).toBe(original);
      expect(CryptoService.decrypt(encrypted2)).toBe(original);
    });

    it('should handle empty strings', () => {
      expect(CryptoService.encrypt('')).toBe('');
      expect(CryptoService.decrypt('')).toBe('');
    });

    it('should handle null gracefully', () => {
      expect(CryptoService.encrypt(null as any)).toBe(null);
      expect(CryptoService.decrypt(null as any)).toBe(null);
    });

    it('should handle undefined gracefully', () => {
      expect(CryptoService.encrypt(undefined as any)).toBe(undefined);
      expect(CryptoService.decrypt(undefined as any)).toBe(undefined);
    });

    it('should return plain text for backwards compatibility (not encrypted)', () => {
      const plainText = 'sk-ant-api03-old-plain-text-token';
      const decrypted = CryptoService.decrypt(plainText);
      expect(decrypted).toBe(plainText);
    });

    it('should not double-encrypt already encrypted values', () => {
      const original = 'my-secret';
      const encrypted = CryptoService.encrypt(original);
      const doubleEncrypted = CryptoService.encrypt(encrypted);

      // Should not add another enc: prefix
      expect(doubleEncrypted).toBe(encrypted);
    });

    it('should handle special characters', () => {
      const specialChars = 'token!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
      const encrypted = CryptoService.encrypt(specialChars);
      const decrypted = CryptoService.decrypt(encrypted);

      expect(decrypted).toBe(specialChars);
    });

    it('should handle unicode characters', () => {
      const unicode = 'token-with-unicode-chars';
      const encrypted = CryptoService.encrypt(unicode);
      const decrypted = CryptoService.decrypt(encrypted);

      expect(decrypted).toBe(unicode);
    });

    it('should handle long strings', () => {
      const longString = 'a'.repeat(10000);
      const encrypted = CryptoService.encrypt(longString);
      const decrypted = CryptoService.decrypt(encrypted);

      expect(decrypted).toBe(longString);
    });
  });

  describe('isEncrypted', () => {
    it('should detect encrypted values', () => {
      const encrypted = CryptoService.encrypt('test');
      expect(CryptoService.isEncrypted(encrypted)).toBe(true);
    });

    it('should detect plain text values', () => {
      expect(CryptoService.isEncrypted('plain-text-token')).toBe(false);
      expect(CryptoService.isEncrypted('sk-ant-api03-xxx')).toBe(false);
    });

    it('should handle null/undefined', () => {
      expect(CryptoService.isEncrypted(null as any)).toBe(false);
      expect(CryptoService.isEncrypted(undefined as any)).toBe(false);
    });

    it('should handle empty string', () => {
      expect(CryptoService.isEncrypted('')).toBe(false);
    });
  });

  describe('hashPassword/verifyPassword', () => {
    it('should hash and verify passwords correctly', async () => {
      const password = 'MySecureP@ssw0rd123!';
      const hash = await CryptoService.hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash.startsWith('$2b$')).toBe(true); // bcrypt prefix

      const isValid = await CryptoService.verifyPassword(password, hash);
      expect(isValid).toBe(true);
    });

    it('should reject wrong passwords', async () => {
      const password = 'correct-password';
      const hash = await CryptoService.hashPassword(password);

      const isValid = await CryptoService.verifyPassword('wrong-password', hash);
      expect(isValid).toBe(false);
    });

    it('should generate different hashes for same password (salted)', async () => {
      const password = 'same-password';
      const hash1 = await CryptoService.hashPassword(password);
      const hash2 = await CryptoService.hashPassword(password);

      // Different salts should produce different hashes
      expect(hash1).not.toBe(hash2);

      // Both should verify correctly
      expect(await CryptoService.verifyPassword(password, hash1)).toBe(true);
      expect(await CryptoService.verifyPassword(password, hash2)).toBe(true);
    });
  });

  describe('encryptFields/decryptFields', () => {
    it('should encrypt specified fields only', () => {
      const obj = {
        token: 'secret-token',
        name: 'public-name',
        apiKey: 'secret-api-key',
      };

      const encrypted = CryptoService.encryptFields(obj, ['token', 'apiKey']);

      expect(CryptoService.isEncrypted(encrypted.token)).toBe(true);
      expect(CryptoService.isEncrypted(encrypted.apiKey)).toBe(true);
      expect(encrypted.name).toBe('public-name'); // Not encrypted
    });

    it('should decrypt specified fields only', () => {
      const original = {
        token: 'secret-token',
        name: 'public-name',
      };

      const encrypted = CryptoService.encryptFields(original, ['token']);
      const decrypted = CryptoService.decryptFields(encrypted, ['token']);

      expect(decrypted.token).toBe('secret-token');
      expect(decrypted.name).toBe('public-name');
    });

    it('should handle null fields gracefully', () => {
      const obj = {
        token: null as any,
        name: 'public',
      };

      const encrypted = CryptoService.encryptFields(obj, ['token']);
      expect(encrypted.token).toBeNull();
    });
  });

  describe('generateToken', () => {
    it('should generate random tokens', () => {
      const token1 = CryptoService.generateToken();
      const token2 = CryptoService.generateToken();

      expect(token1).not.toBe(token2);
      expect(token1.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('should support custom length', () => {
      const token = CryptoService.generateToken(16);
      expect(token.length).toBe(32); // 16 bytes = 32 hex chars
    });

    it('should support prefix', () => {
      const token = CryptoService.generateToken(32, 'sk_');
      expect(token.startsWith('sk_')).toBe(true);
      expect(token.length).toBe(64 + 3); // 64 hex chars + 3 prefix chars
    });
  });

  describe('secureCompare', () => {
    it('should return true for equal strings', () => {
      expect(CryptoService.secureCompare('same', 'same')).toBe(true);
      expect(CryptoService.secureCompare('token123', 'token123')).toBe(true);
    });

    it('should return false for different strings', () => {
      expect(CryptoService.secureCompare('one', 'two')).toBe(false);
      expect(CryptoService.secureCompare('token123', 'token124')).toBe(false);
    });

    it('should return false for different lengths', () => {
      expect(CryptoService.secureCompare('short', 'longer-string')).toBe(false);
    });

    it('should handle non-strings', () => {
      expect(CryptoService.secureCompare(null as any, 'test')).toBe(false);
      expect(CryptoService.secureCompare('test', undefined as any)).toBe(false);
    });
  });
});
