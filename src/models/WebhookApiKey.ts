import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';

export interface IWebhookApiKey extends Document {
  apiKey: string;
  projectId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  rateLimit: number;
  lastUsedAt?: Date;
  requestCount: number;
  createdAt: Date;
  updatedAt: Date;
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
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    rateLimit: {
      type: Number,
      default: 60,
    },
    lastUsedAt: {
      type: Date,
      default: null,
    },
    requestCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

webhookApiKeySchema.statics.generateApiKey = function (): string {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `whk_${randomBytes}`;
};

webhookApiKeySchema.statics.validateApiKey = async function (
  key: string
): Promise<IWebhookApiKey | null> {
  if (!key || typeof key !== 'string') {
    return null;
  }

  try {
    // Fetch all active keys for comparison
    const candidates = await this.find({ isActive: true }).lean();

    // Use constant-time comparison to prevent timing attacks
    for (const candidate of candidates) {
      try {
        if (
          crypto.timingSafeEqual(
            Buffer.from(key),
            Buffer.from(candidate.apiKey)
          )
        ) {
          return candidate as IWebhookApiKey;
        }
      } catch (e) {
        // Length mismatch or other comparison error, continue
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error('Error validating API key:', error);
    return null;
  }
};

export const WebhookApiKey = mongoose.model<IWebhookApiKey>(
  'WebhookApiKey',
  webhookApiKeySchema
);
