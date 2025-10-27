import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';

export interface IWebhookApiKey extends Document {
  apiKey: string;
  projectId: mongoose.Types.ObjectId;
  name: string; // Client identifier
  isActive: boolean;
  rateLimit: number; // requests per minute
  lastUsedAt?: Date;
  requestCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface IWebhookApiKeyStatics {
  generateApiKey(): string;
  validateApiKey(key: string): Promise<IWebhookApiKey | null>;
}

const webhookApiKeySchema = new Schema<IWebhookApiKey>(
  {
    apiKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    rateLimit: {
      type: Number,
      default: 60, // 60 requests per minute
    },
    lastUsedAt: {
      type: Date,
    },
    requestCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

// Indexes for efficient queries
webhookApiKeySchema.index({ projectId: 1, isActive: 1 });

webhookApiKeySchema.statics.generateApiKey = function (): string {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `whk_${randomBytes}`;
};

webhookApiKeySchema.statics.validateApiKey = async function (key: string): Promise<IWebhookApiKey | null> {
  return this.findOne({ apiKey: key, isActive: true }).lean();
};

export const WebhookApiKey = mongoose.model<IWebhookApiKey, IWebhookApiKeyStatics>(
  'WebhookApiKey',
  webhookApiKeySchema
);
