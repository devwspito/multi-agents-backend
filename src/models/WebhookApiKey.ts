import mongoose, { Document, Schema } from 'mongoose';
import crypto from 'crypto';

export interface IWebhookApiKey extends Document {
  apiKey: string;
  projectId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  rateLimit: number;

  // Task Configuration for auto-generated tasks
  // Determines which model configuration to use (standard/premium/max)
  // ErrorDetective will always use the topModel from the selected config
  taskConfig: 'standard' | 'premium' | 'max';

  lastUsedAt?: Date;
  requestCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IWebhookApiKeyStatics {
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
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    rateLimit: {
      type: Number,
      default: 60,
    },
    taskConfig: {
      type: String,
      enum: ['standard', 'premium', 'max'],
      default: 'standard', // Balanced configuration by default
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

/**
 * Genera una API key única con prefijo whk_
 */
webhookApiKeySchema.statics.generateApiKey = function (): string {
  const randomBytes = crypto.randomBytes(32).toString('hex');
  return `whk_${randomBytes}`;
};

/**
 * Valida una API key usando comparación constant-time
 * Previene timing attacks
 */
webhookApiKeySchema.statics.validateApiKey = async function (
  key: string
): Promise<IWebhookApiKey | null> {
  if (!key || typeof key !== 'string') {
    return null;
  }

  try {
    // Buscar todas las keys activas
    const candidates = await this.find({ isActive: true }).lean();

    // Comparación constant-time para prevenir timing attacks
    for (const candidate of candidates) {
      try {
        if (
          crypto.timingSafeEqual(Buffer.from(key), Buffer.from(candidate.apiKey))
        ) {
          return candidate as IWebhookApiKey;
        }
      } catch (e) {
        // Length mismatch, continuar
        continue;
      }
    }

    return null;
  } catch (error) {
    console.error('Error validating API key:', error);
    return null;
  }
};

export const WebhookApiKey = mongoose.model<
  IWebhookApiKey,
  mongoose.Model<IWebhookApiKey> & IWebhookApiKeyStatics
>('WebhookApiKey', webhookApiKeySchema);
