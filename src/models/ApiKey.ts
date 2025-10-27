import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

export interface IApiKey extends Document {
  keyPrefix: string; // 'ak_live_' or 'ak_test_'
  keyHash: string; // bcrypt hashed API key
  projectId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  name: string; // User-friendly name
  scopes: string[]; // ['read', 'write', 'admin']
  rateLimit: {
    requestsPerHour: number;
    requestsPerDay: number;
    currentHourRequests: number;
    currentDayRequests: number;
    hourResetAt: Date;
    dayResetAt: Date;
  };
  expiresAt?: Date;
  lastUsedAt?: Date;
  totalRequests: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  // Instance methods
  checkRateLimit(): { allowed: boolean; resetAt: Date };
  incrementUsage(): Promise<void>;
  isExpired(): boolean;
}

interface IApiKeyStaticMethods {
  generateApiKey(): Promise<string>;
  hashApiKey(plainKey: string): Promise<string>;
  verifyApiKey(plainKey: string, hash: string): Promise<boolean>;
}

type ApiKeyModelType = mongoose.Model<IApiKey> & IApiKeyStaticMethods;

const apiKeySchema = new Schema<IApiKey, ApiKeyModelType>(
  {
    keyPrefix: {
      type: String,
      required: true,
      index: true,
    },
    keyHash: {
      type: String,
      required: true,
      unique: true,
      select: false, // Don't include in queries by default (security)
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
    },
    scopes: {
      type: [String],
      default: ['read'],
    },
    rateLimit: {
      requestsPerHour: {
        type: Number,
        required: true,
        default: 1000,
      },
      requestsPerDay: {
        type: Number,
        required: true,
        default: 10000,
      },
      currentHourRequests: {
        type: Number,
        default: 0,
      },
      currentDayRequests: {
        type: Number,
        default: 0,
      },
      hourResetAt: {
        type: Date,
        default: () => new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      },
      dayResetAt: {
        type: Date,
        default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
      },
    },
    expiresAt: {
      type: Date,
    },
    lastUsedAt: {
      type: Date,
    },
    totalRequests: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Composite indexes for efficient queries
apiKeySchema.index({ keyPrefix: 1, isActive: 1 });
apiKeySchema.index({ projectId: 1, isActive: 1 });

// TTL index for automatic cleanup of expired keys (6 months after expiration)
apiKeySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 15552000, sparse: true }
);

// Static method: Generate API key
apiKeySchema.statics.generateApiKey = async function (): Promise<string> {
  const env = process.env.NODE_ENV === 'production' ? 'live' : 'test';
  const randomPart = crypto.randomBytes(24).toString('base64url');
  return `ak_${env}_${randomPart}`;
};

// Static method: Hash API key using bcrypt
apiKeySchema.statics.hashApiKey = async function (plainKey: string): Promise<string> {
  return bcrypt.hash(plainKey, 10);
};

// Static method: Verify API key against hash
apiKeySchema.statics.verifyApiKey = async function (plainKey: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plainKey, hash);
};

// Instance method: Check if current request is within rate limits
apiKeySchema.methods.checkRateLimit = function (): { allowed: boolean; resetAt: Date } {
  const now = new Date();

  // Reset hourly counter if needed
  if (this.rateLimit.hourResetAt < now) {
    this.rateLimit.currentHourRequests = 0;
    this.rateLimit.hourResetAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
  }

  // Reset daily counter if needed
  if (this.rateLimit.dayResetAt < now) {
    this.rateLimit.currentDayRequests = 0;
    this.rateLimit.dayResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now
  }

  // Check if within both hourly and daily limits
  const allowed =
    this.rateLimit.currentHourRequests < this.rateLimit.requestsPerHour &&
    this.rateLimit.currentDayRequests < this.rateLimit.requestsPerDay;

  // Return the sooner reset time
  const resetAt =
    this.rateLimit.hourResetAt < this.rateLimit.dayResetAt
      ? this.rateLimit.hourResetAt
      : this.rateLimit.dayResetAt;

  return { allowed, resetAt };
};

// Instance method: Increment usage counters
apiKeySchema.methods.incrementUsage = async function (): Promise<void> {
  const now = new Date();

  // Reset hourly counter if needed
  if (this.rateLimit.hourResetAt < now) {
    this.rateLimit.currentHourRequests = 0;
    this.rateLimit.hourResetAt = new Date(now.getTime() + 60 * 60 * 1000);
  }

  // Reset daily counter if needed
  if (this.rateLimit.dayResetAt < now) {
    this.rateLimit.currentDayRequests = 0;
    this.rateLimit.dayResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }

  // Increment counters
  this.rateLimit.currentHourRequests += 1;
  this.rateLimit.currentDayRequests += 1;
  this.totalRequests += 1;
  this.lastUsedAt = now;

  // Save changes
  await this.save();
};

// Instance method: Check if API key has expired
apiKeySchema.methods.isExpired = function (): boolean {
  if (!this.expiresAt) {
    return false; // No expiration date means it never expires
  }
  return this.expiresAt < new Date();
};

export const ApiKey = mongoose.model<IApiKey, ApiKeyModelType>('ApiKey', apiKeySchema);
