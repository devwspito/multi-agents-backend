import mongoose, { Document, Schema } from 'mongoose';
import { CryptoService } from '../services/CryptoService';

export interface IProject extends Document {
  name: string;
  description?: string;
  type?: string;
  status?: string;
  userId: mongoose.Types.ObjectId;
  apiKey?: string; // Project-specific Anthropic API key (falls back to user's defaultApiKey)
  webhookApiKey?: string; // Webhook API Key for external error reporting (format: sk-<random>)

  // ========================================
  // Developer Authentication Configuration
  // For developers to test authenticated endpoints
  // IMPORTANT: DELETE method is ALWAYS BLOCKED for safety
  // ========================================
  // SIMPLIFIED: 2 methods only (token OR credentials)
  devAuth?: {
    // Authentication method: 'none' | 'token' | 'credentials'
    method: 'none' | 'token' | 'credentials';

    // === For 'token' method ===
    // User provides a pre-generated token (API key, bearer token, OAuth token)
    token?: string;                   // ENCRYPTED
    tokenType?: 'bearer' | 'api-key' | 'basic' | 'custom';
    tokenHeader?: string;             // Header name (default: Authorization)
    tokenPrefix?: string;             // Prefix (default: "Bearer ")

    // === For 'credentials' method ===
    // System curls login endpoint to get token dynamically
    loginEndpoint?: string;           // e.g., "http://localhost:3001/api/auth/login"
    loginMethod?: 'POST' | 'GET';     // Usually POST
    credentials?: {                   // User credentials
      username?: string;              // Can be email or username
      password?: string;              // ENCRYPTED
    };
    loginContentType?: string;        // Default: application/json
    tokenResponsePath?: string;       // JSON path to extract token, e.g., "data.token"
  };

  // Decryption methods
  getDecryptedApiKey(): string | undefined;
  getDecryptedDevAuth(): {
    method: string;
    token?: string;
    tokenType?: string;
    tokenHeader?: string;
    tokenPrefix?: string;
    loginEndpoint?: string;
    loginMethod?: string;
    credentials?: { username?: string; password?: string };
    loginContentType?: string;
    tokenResponsePath?: string;
  } | undefined;

  // Settings
  settings?: {
    defaultBranch?: string;
    autoDeployment?: boolean;
    requiredReviews?: number;
    educationalContext?: string;
    complianceLevel?: string;
    // Webhook error notifications
    errorNotifications?: {
      enabled?: boolean;
      channels?: Array<{
        type: 'email' | 'webhook' | 'slack';
        enabled: boolean;
        config: {
          email?: string;
          webhookUrl?: string;
          webhookSecret?: string;
          slackWebhookUrl?: string;
          slackChannel?: string;
        };
      }>;
    };
  };

  // Stats
  stats?: {
    totalTasks?: number;
    completedTasks?: number;
    activeTasks?: number;
    pendingReviews?: number;
  };

  // Token Stats
  tokenStats?: {
    byModel?: any;
    byAgent?: any;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalTokens?: number;
    totalCost?: number;
    lastUpdated?: Date;
  };

  // Metadata
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const projectSchema = new Schema<IProject>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ['web-app', 'mobile-app', 'api', 'microservice', 'library', 'saas', 'educational', 'learning-management', 'assessment', 'analytics'],
      default: 'web-app',
    },
    status: {
      type: String,
      enum: ['planning', 'active', 'on-hold', 'completed', 'archived'],
      default: 'planning',
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    apiKey: {
      type: String,
      required: false,
      select: false, // Don't include in queries by default (security)
    },
    webhookApiKey: {
      type: String,
      required: false,
      unique: true, // Each project gets unique webhook API key
      sparse: true, // Allow null values (not all projects need webhooks)
      select: false, // Don't include in queries by default (security)
    },
    // Developer Authentication - allows developers to test authenticated endpoints
    // SIMPLIFIED: 2 methods only (token OR credentials)
    // DELETE method is ALWAYS BLOCKED for safety
    devAuth: {
      method: {
        type: String,
        enum: ['none', 'token', 'credentials'],
        default: 'none',
      },
      // === For 'token' method ===
      token: {
        type: String,
        select: false, // Security: ENCRYPTED, don't include in queries
      },
      tokenType: {
        type: String,
        enum: ['bearer', 'api-key', 'basic', 'custom'],
        default: 'bearer',
      },
      tokenHeader: {
        type: String,
        default: 'Authorization',
      },
      tokenPrefix: {
        type: String,
        default: 'Bearer ',
      },
      // === For 'credentials' method ===
      loginEndpoint: String,
      loginMethod: {
        type: String,
        enum: ['POST', 'GET'],
        default: 'POST',
      },
      credentials: {
        username: String,
        password: {
          type: String,
          select: false, // Security: ENCRYPTED, don't include in queries
        },
      },
      loginContentType: {
        type: String,
        default: 'application/json',
      },
      tokenResponsePath: {
        type: String,
        default: 'token',
      },
    },
    settings: {
      defaultBranch: { type: String, default: 'main' },
      autoDeployment: { type: Boolean, default: false },
      requiredReviews: { type: Number, default: 1 },
      educationalContext: { type: String, default: 'general' },
      complianceLevel: { type: String, default: 'basic' },
      errorNotifications: {
        enabled: { type: Boolean, default: true },
        channels: [{
          type: { type: String, enum: ['email', 'webhook', 'slack'], required: true },
          enabled: { type: Boolean, default: true },
          config: {
            email: String,
            webhookUrl: String,
            webhookSecret: String,
            slackWebhookUrl: String,
            slackChannel: String,
          },
        }],
      },
    },
    stats: {
      totalTasks: { type: Number, default: 0 },
      completedTasks: { type: Number, default: 0 },
      activeTasks: { type: Number, default: 0 },
      pendingReviews: { type: Number, default: 0 },
    },
    tokenStats: {
      byModel: { type: Schema.Types.Mixed, default: {} },
      byAgent: { type: Schema.Types.Mixed, default: {} },
      totalInputTokens: { type: Number, default: 0 },
      totalOutputTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      totalCost: { type: Number, default: 0 },
      lastUpdated: { type: Date },
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

// Index for efficient queries
projectSchema.index({ userId: 1, isActive: 1 });
projectSchema.index({ webhookApiKey: 1 }); // Fast lookup by webhook API key
projectSchema.index({ userId: 1, status: 1 });
projectSchema.index({ userId: 1, type: 1 });

// ============================================
// Pre-save Hook: Encrypt sensitive fields
// ============================================
projectSchema.pre('save', function (next) {
  // Encrypt apiKey if modified and not already encrypted
  if (this.isModified('apiKey') && this.apiKey) {
    if (!CryptoService.isEncrypted(this.apiKey)) {
      this.apiKey = CryptoService.encrypt(this.apiKey);
    }
  }

  // Encrypt devAuth.token if modified and not already encrypted
  if (this.isModified('devAuth.token') && this.devAuth?.token) {
    if (!CryptoService.isEncrypted(this.devAuth.token)) {
      this.devAuth.token = CryptoService.encrypt(this.devAuth.token);
    }
  }

  // Encrypt devAuth.credentials.password if modified and not already encrypted
  if (this.isModified('devAuth.credentials.password') && this.devAuth?.credentials?.password) {
    if (!CryptoService.isEncrypted(this.devAuth.credentials.password)) {
      this.devAuth.credentials.password = CryptoService.encrypt(this.devAuth.credentials.password);
    }
  }

  next();
});

// ============================================
// Instance Methods: Decrypt sensitive fields
// ============================================
projectSchema.methods.getDecryptedApiKey = function (): string | undefined {
  return this.apiKey ? CryptoService.decrypt(this.apiKey) : undefined;
};

projectSchema.methods.getDecryptedDevAuth = function () {
  if (!this.devAuth || this.devAuth.method === 'none') {
    return undefined;
  }

  return {
    method: this.devAuth.method,
    // Decrypt token if present
    token: this.devAuth.token ? CryptoService.decrypt(this.devAuth.token) : undefined,
    tokenType: this.devAuth.tokenType,
    tokenHeader: this.devAuth.tokenHeader,
    tokenPrefix: this.devAuth.tokenPrefix,
    // Credentials with decrypted password
    loginEndpoint: this.devAuth.loginEndpoint,
    loginMethod: this.devAuth.loginMethod,
    credentials: this.devAuth.credentials ? {
      username: this.devAuth.credentials.username,
      password: this.devAuth.credentials.password
        ? CryptoService.decrypt(this.devAuth.credentials.password)
        : undefined,
    } : undefined,
    loginContentType: this.devAuth.loginContentType,
    tokenResponsePath: this.devAuth.tokenResponsePath,
  };
};

export const Project = mongoose.model<IProject>('Project', projectSchema);
