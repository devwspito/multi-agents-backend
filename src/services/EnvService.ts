import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { IEnvVariable } from '../models/Repository';

/**
 * Environment Variables Management Service
 *
 * Handles .env file generation and encryption for repository-specific environment variables.
 * Each repository can have its own set of environment variables that are injected
 * when the repository is cloned to the workspace.
 *
 * Security:
 * - Sensitive variables (isSecret: true) are encrypted at rest in MongoDB
 * - .env files are generated at runtime in workspace (never committed)
 * - Encryption uses AES-256-GCM with environment-specific secret key
 */
export class EnvService {
  private static readonly ENCRYPTION_ALGORITHM = 'aes-256-gcm';
  private static readonly ENCRYPTION_KEY = EnvService.getEncryptionKey();

  /**
   * Get encryption key from environment or generate a default one
   * IMPORTANT: In production, use a strong random key from env variable
   */
  private static getEncryptionKey(): Buffer {
    const keyFromEnv = process.env.ENV_ENCRYPTION_KEY;

    if (keyFromEnv) {
      // Use key from environment (base64 encoded)
      return Buffer.from(keyFromEnv, 'base64');
    }

    // Development fallback (NOT FOR PRODUCTION)
    console.warn('⚠️  ENV_ENCRYPTION_KEY not set, using default key (NOT SECURE FOR PRODUCTION)');
    return crypto.scryptSync('default-encryption-key-change-in-production', 'salt', 32);
  }

  /**
   * Encrypt a secret value for storage in MongoDB
   */
  static encryptValue(plaintext: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, this.ENCRYPTION_KEY, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    // Return: iv:authTag:encrypted
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypt a secret value from MongoDB
   */
  static decryptValue(encrypted: string): string {
    try {
      const parts = encrypted.split(':');
      if (parts.length !== 3) {
        throw new Error('Invalid encrypted format');
      }

      const [ivHex, authTagHex, encryptedText] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, this.ENCRYPTION_KEY, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('❌ Decryption failed:', error);
      throw new Error('Failed to decrypt environment variable');
    }
  }

  /**
   * Generate .env file content from environment variables
   * Handles decryption of secret variables
   */
  static generateEnvFileContent(envVariables: IEnvVariable[]): string {
    if (!envVariables || envVariables.length === 0) {
      return '# No environment variables configured for this repository\n';
    }

    let content = '# Environment Variables\n';
    content += '# Generated automatically by Multi-Agent Platform\n';
    content += '# DO NOT COMMIT THIS FILE\n\n';

    for (const envVar of envVariables) {
      // Add description as comment if available
      if (envVar.description) {
        content += `# ${envVar.description}\n`;
      }

      // Decrypt value if it's a secret
      const value = envVar.isSecret
        ? this.decryptValue(envVar.value)
        : envVar.value;

      content += `${envVar.key}=${value}\n`;

      if (envVar.description) {
        content += '\n'; // Extra newline after documented variables
      }
    }

    return content;
  }

  /**
   * Write .env file to repository workspace
   * @param repositoryPath - Path to cloned repository
   * @param envVariables - Environment variables to write
   */
  static async writeEnvFile(
    repositoryPath: string,
    envVariables: IEnvVariable[]
  ): Promise<void> {
    if (!envVariables || envVariables.length === 0) {
      console.log('ℹ️  No environment variables to write');
      return;
    }

    try {
      const envFilePath = path.join(repositoryPath, '.env');
      const content = this.generateEnvFileContent(envVariables);

      await fs.writeFile(envFilePath, content, 'utf8');

      console.log(`✅ Created .env file with ${envVariables.length} variable(s): ${envFilePath}`);
    } catch (error: any) {
      console.error('❌ Failed to write .env file:', error);
      throw new Error(`Failed to create .env file: ${error.message}`);
    }
  }

  /**
   * Validate environment variable key format
   * Must be uppercase alphanumeric with underscores
   */
  static isValidEnvKey(key: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(key);
  }

  /**
   * Validate environment variables before saving
   */
  static validateEnvVariables(envVariables: IEnvVariable[]): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const envVar of envVariables) {
      if (!envVar.key) {
        errors.push('Environment variable key cannot be empty');
        continue;
      }

      if (!this.isValidEnvKey(envVar.key)) {
        errors.push(`Invalid key format: ${envVar.key} (must be uppercase alphanumeric with underscores)`);
      }

      if (envVar.value === undefined || envVar.value === null) {
        errors.push(`Value for ${envVar.key} cannot be empty`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Prepare environment variables for storage
   * Encrypts secret values before saving to MongoDB
   */
  static prepareForStorage(envVariables: IEnvVariable[]): IEnvVariable[] {
    return envVariables.map(envVar => ({
      ...envVar,
      value: envVar.isSecret ? this.encryptValue(envVar.value) : envVar.value,
    }));
  }

  /**
   * Check if .env file exists in repository
   */
  static async envFileExists(repositoryPath: string): Promise<boolean> {
    try {
      const envFilePath = path.join(repositoryPath, '.env');
      await fs.access(envFilePath);
      return true;
    } catch {
      return false;
    }
  }
}
