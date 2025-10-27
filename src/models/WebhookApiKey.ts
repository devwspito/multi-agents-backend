import mongoose, { Document, Schema } from 'mongoose';

export interface IWebhookApiKey extends Document {
  apiKey: string; // Hashed API key for security
  projectId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  rateLimit: number; // Requests per minute
  isActive: boolean;
  lastUsedAt?: Date;
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
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    rateLimit: {
      type: Number,
      default: 60, // Default: 60 requests per minute
      min: 1,
      max: 10000,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    lastUsedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

export const WebhookApiKey = mongoose.model<IWebhookApiKey>('WebhookApiKey', webhookApiKeySchema);
