import crypto from 'crypto';
import bcrypt from 'bcrypt';

/**
 * Centralized Cryptography Service
 *
 * Provides encryption/decryption and password hashing for sensitive data.
 * Uses AES-256-GCM for two-way encryption (tokens, API keys).
 * Uses bcrypt for one-way hashing (passwords).
 *
 * Security Features:
 * - AES-256-GCM with random IV for each encryption
 * - Authentication tag prevents tampering
 * - Backwards compatibility: detects plain text vs encrypted
 * - bcrypt with 10 rounds for password hashing
 *
 * Usage:
 * - Two-way encryption: For tokens, API keys (need to use them later)
 * - One-way hashing: For passwords (only need to verify)
 */
export class CryptoService {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly ENCRYPTED_PREFIX = 'enc:'; // Marker for encrypted values
  private static readonly BCRYPT_ROUNDS = 10;

  /**
   * Get encryption key from environment or generate a development fallback.
   * IMPORTANT: In production, ENV_ENCRYPTION_KEY must be set!
   *
   * Generate a key with: openssl rand -base64 32
   */
  private static getEncryptionKey(): Buffer {
    const keyFromEnv = process.env.ENV_ENCRYPTION_KEY;

    if (keyFromEnv) {
      // Use key from environment (base64 encoded, 32 bytes)
      const key = Buffer.from(keyFromEnv, 'base64');
      if (key.length !== 32) {
        console.warn(`[CryptoService] ENV_ENCRYPTION_KEY should be 32 bytes (got ${key.length})`);
      }
      return key;
    }

    // Development fallback (NOT FOR PRODUCTION)
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENV_ENCRYPTION_KEY is required in production!');
    }

    console.warn('[CryptoService] ENV_ENCRYPTION_KEY not set - using development fallback (NOT SECURE)');
    return crypto.scryptSync('default-dev-encryption-key', 'salt', 32);
  }

  /**
   * Encrypt a plaintext value for secure storage.
   *
   * @param plaintext - The value to encrypt
   * @returns Encrypted string in format: enc:iv:authTag:ciphertext
   *
   * @example
   * const encrypted = CryptoService.encrypt('sk-ant-api03-xxx');
   * // Returns: enc:a1b2c3...:d4e5f6...:g7h8i9...
   */
  static encrypt(plaintext: string | null | undefined): string {
    // Handle null/undefined/empty
    if (!plaintext) {
      return plaintext as any;
    }

    // Already encrypted? Return as-is
    if (this.isEncrypted(plaintext)) {
      return plaintext;
    }

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.getEncryptionKey(), iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Format: enc:iv:authTag:ciphertext
    return `${this.ENCRYPTED_PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt an encrypted value from storage.
   *
   * Backwards Compatible: If value is not encrypted (no enc: prefix),
   * returns it as-is. This allows gradual migration of existing data.
   *
   * @param value - The encrypted value or plain text
   * @returns Decrypted plaintext
   *
   * @example
   * // Encrypted value
   * const token = CryptoService.decrypt('enc:a1b2...:d4e5...:g7h8...');
   *
   * // Plain text (backwards compatibility)
   * const legacy = CryptoService.decrypt('sk-ant-api03-xxx');
   * // Returns: sk-ant-api03-xxx
   */
  static decrypt(value: string | null | undefined): string {
    // Handle null/undefined/empty
    if (!value) {
      return value as any;
    }

    // Backwards compatibility: if not encrypted, return as-is
    if (!this.isEncrypted(value)) {
      return value;
    }

    try {
      // Remove prefix and split: iv:authTag:ciphertext
      const encrypted = value.slice(this.ENCRYPTED_PREFIX.length);
      const parts = encrypted.split(':');

      if (parts.length !== 3) {
        throw new Error('Invalid encrypted format: expected 3 parts');
      }

      const [ivHex, authTagHex, ciphertext] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.ALGORITHM, this.getEncryptionKey(), iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error: any) {
      console.error('[CryptoService] Decryption failed:', error.message);
      throw new Error('Failed to decrypt value. Check ENV_ENCRYPTION_KEY.');
    }
  }

  /**
   * Check if a value is already encrypted.
   *
   * @param value - The value to check
   * @returns true if value starts with 'enc:' prefix
   */
  static isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(this.ENCRYPTED_PREFIX);
  }

  /**
   * Hash a password using bcrypt (one-way).
   * Use this for passwords that only need verification, not retrieval.
   *
   * @param password - The password to hash
   * @returns bcrypt hash
   */
  static async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, this.BCRYPT_ROUNDS);
  }

  /**
   * Verify a password against a bcrypt hash.
   *
   * @param password - The password to verify
   * @param hash - The bcrypt hash to compare against
   * @returns true if password matches
   */
  static async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  /**
   * Encrypt an object's sensitive fields.
   * Useful for encrypting multiple fields at once.
   *
   * @param obj - Object to process
   * @param fields - Array of field names to encrypt
   * @returns New object with encrypted fields
   *
   * @example
   * const encrypted = CryptoService.encryptFields(
   *   { token: 'secret', name: 'public' },
   *   ['token']
   * );
   * // Returns: { token: 'enc:...', name: 'public' }
   */
  static encryptFields<T extends Record<string, any>>(obj: T, fields: (keyof T)[]): T {
    const result = { ...obj };
    for (const field of fields) {
      if (result[field] && typeof result[field] === 'string') {
        result[field] = this.encrypt(result[field]) as any;
      }
    }
    return result;
  }

  /**
   * Decrypt an object's encrypted fields.
   *
   * @param obj - Object to process
   * @param fields - Array of field names to decrypt
   * @returns New object with decrypted fields
   */
  static decryptFields<T extends Record<string, any>>(obj: T, fields: (keyof T)[]): T {
    const result = { ...obj };
    for (const field of fields) {
      if (result[field] && typeof result[field] === 'string') {
        result[field] = this.decrypt(result[field]) as any;
      }
    }
    return result;
  }

  /**
   * Generate a secure random token.
   * Useful for API keys, session tokens, etc.
   *
   * @param length - Number of bytes (default: 32)
   * @param prefix - Optional prefix (e.g., 'sk_', 'tok_')
   * @returns Random hex string with optional prefix
   */
  static generateToken(length: number = 32, prefix: string = ''): string {
    return prefix + crypto.randomBytes(length).toString('hex');
  }

  /**
   * Constant-time string comparison to prevent timing attacks.
   *
   * @param a - First string
   * @param b - Second string
   * @returns true if strings are equal
   */
  static secureCompare(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);

    if (bufA.length !== bufB.length) {
      // Compare against itself to maintain constant time
      crypto.timingSafeEqual(bufA, bufA);
      return false;
    }

    return crypto.timingSafeEqual(bufA, bufB);
  }
}
