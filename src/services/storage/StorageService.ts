/**
 * StorageService - Cloud Storage Abstraction
 *
 * Handles file storage using Firebase Storage (or other providers)
 * Replaces local filesystem storage for:
 * - User uploads
 * - Workspace files (git repos)
 * - Build artifacts
 * - Logs
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import type { Bucket } from '@google-cloud/storage';
import { Readable } from 'stream';
import path from 'path';
import crypto from 'crypto';

// Initialize Firebase Admin if not already initialized
if (getApps().length === 0) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : null;

  if (serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });
  }
}

interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  public?: boolean;
}

interface StorageFile {
  name: string;
  path: string;
  size: number;
  contentType: string;
  url: string;
  createdAt: Date;
}

class StorageService {
  private bucket: Bucket | null = null;
  private basePath: string;

  constructor() {
    this.basePath = process.env.STORAGE_BASE_PATH || '';

    try {
      if (getApps().length > 0) {
        this.bucket = getStorage().bucket();
      }
    } catch (error) {
      console.warn('Firebase Storage not initialized. Using fallback.');
    }
  }

  /**
   * Check if storage is available
   */
  isAvailable(): boolean {
    return this.bucket !== null;
  }

  /**
   * Generate a unique file path
   */
  private generatePath(folder: string, filename: string): string {
    const timestamp = Date.now();
    const hash = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(filename);
    const basename = path.basename(filename, ext);
    const safeName = basename.replace(/[^a-zA-Z0-9-_]/g, '_');

    return path.join(this.basePath, folder, `${timestamp}-${hash}-${safeName}${ext}`);
  }

  /**
   * Upload a file from buffer
   */
  async uploadBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
    options: UploadOptions = {}
  ): Promise<StorageFile> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const filePath = this.generatePath(folder, filename);
    const file = this.bucket.file(filePath);

    await file.save(buffer, {
      contentType: options.contentType || 'application/octet-stream',
      metadata: {
        metadata: options.metadata || {},
      },
    });

    if (options.public) {
      await file.makePublic();
    }

    const [metadata] = await file.getMetadata();
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return {
      name: filename,
      path: filePath,
      size: Number(metadata.size) || buffer.length,
      contentType: metadata.contentType || options.contentType || 'application/octet-stream',
      url: options.public ? `https://storage.googleapis.com/${this.bucket.name}/${filePath}` : url,
      createdAt: new Date(metadata.timeCreated || Date.now()),
    };
  }

  /**
   * Upload a file from stream
   */
  async uploadStream(
    stream: Readable,
    folder: string,
    filename: string,
    options: UploadOptions = {}
  ): Promise<StorageFile> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const filePath = this.generatePath(folder, filename);
    const file = this.bucket.file(filePath);

    return new Promise((resolve, reject) => {
      const writeStream = file.createWriteStream({
        contentType: options.contentType || 'application/octet-stream',
        metadata: {
          metadata: options.metadata || {},
        },
      });

      stream.pipe(writeStream);

      writeStream.on('error', reject);
      writeStream.on('finish', async () => {
        try {
          if (options.public) {
            await file.makePublic();
          }

          const [metadata] = await file.getMetadata();
          const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
          });

          resolve({
            name: filename,
            path: filePath,
            size: Number(metadata.size) || 0,
            contentType: metadata.contentType || options.contentType || 'application/octet-stream',
            url: options.public ? `https://storage.googleapis.com/${this.bucket!.name}/${filePath}` : url,
            createdAt: new Date(metadata.timeCreated || Date.now()),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Download a file as buffer
   */
  async downloadBuffer(filePath: string): Promise<Buffer> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const file = this.bucket.file(filePath);
    const [buffer] = await file.download();
    return buffer;
  }

  /**
   * Download a file as stream
   */
  downloadStream(filePath: string): Readable {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const file = this.bucket.file(filePath);
    return file.createReadStream();
  }

  /**
   * Delete a file
   */
  async delete(filePath: string): Promise<void> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const file = this.bucket.file(filePath);
    await file.delete({ ignoreNotFound: true });
  }

  /**
   * Delete all files in a folder
   */
  async deleteFolder(folder: string): Promise<number> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const [files] = await this.bucket.getFiles({
      prefix: path.join(this.basePath, folder),
    });

    await Promise.all(files.map(file => file.delete({ ignoreNotFound: true })));
    return files.length;
  }

  /**
   * List files in a folder
   */
  async listFiles(folder: string): Promise<StorageFile[]> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const [files] = await this.bucket.getFiles({
      prefix: path.join(this.basePath, folder),
    });

    return Promise.all(
      files.map(async (file) => {
        const [metadata] = await file.getMetadata();
        const [url] = await file.getSignedUrl({
          action: 'read',
          expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
        });

        return {
          name: path.basename(file.name),
          path: file.name,
          size: Number(metadata.size) || 0,
          contentType: metadata.contentType || 'application/octet-stream',
          url,
          createdAt: new Date(metadata.timeCreated || Date.now()),
        };
      })
    );
  }

  /**
   * Check if a file exists
   */
  async exists(filePath: string): Promise<boolean> {
    if (!this.bucket) {
      return false;
    }

    const file = this.bucket.file(filePath);
    const [exists] = await file.exists();
    return exists;
  }

  /**
   * Get a signed URL for temporary access
   */
  async getSignedUrl(filePath: string, expiresInMs: number = 3600000): Promise<string> {
    if (!this.bucket) {
      throw new Error('Storage not initialized');
    }

    const file = this.bucket.file(filePath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInMs,
    });
    return url;
  }

  // ==========================================
  // Workspace-specific methods
  // ==========================================

  /**
   * Save workspace file (for git repos, build artifacts, etc.)
   */
  async saveWorkspaceFile(
    taskId: string,
    relativePath: string,
    content: Buffer | string
  ): Promise<StorageFile> {
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const folder = `workspaces/${taskId}`;

    return this.uploadBuffer(buffer, folder, relativePath, {
      metadata: {
        taskId,
        originalPath: relativePath,
      },
    });
  }

  /**
   * Get workspace file
   */
  async getWorkspaceFile(taskId: string, relativePath: string): Promise<Buffer> {
    const filePath = path.join(this.basePath, 'workspaces', taskId, relativePath);
    return this.downloadBuffer(filePath);
  }

  /**
   * Delete entire workspace
   */
  async deleteWorkspace(taskId: string): Promise<number> {
    return this.deleteFolder(`workspaces/${taskId}`);
  }

  // ==========================================
  // Upload-specific methods
  // ==========================================

  /**
   * Save user upload
   */
  async saveUpload(
    userId: string,
    file: Buffer,
    filename: string,
    contentType: string
  ): Promise<StorageFile> {
    const folder = `uploads/${userId}`;

    return this.uploadBuffer(file, folder, filename, {
      contentType,
      metadata: {
        userId,
        originalFilename: filename,
      },
    });
  }

  /**
   * Get user uploads
   */
  async getUserUploads(userId: string): Promise<StorageFile[]> {
    return this.listFiles(`uploads/${userId}`);
  }
}

// Singleton instance
export const storageService = new StorageService();
export default storageService;
