import mongoose, { Document, Schema } from 'mongoose';

export interface IProject extends Document {
  name: string;
  description?: string;
  type?: string;
  status?: string;
  userId: mongoose.Types.ObjectId;
  apiKey?: string; // Project-specific Anthropic API key (falls back to user's defaultApiKey)

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
projectSchema.index({ userId: 1, status: 1 });
projectSchema.index({ userId: 1, type: 1 });

export const Project = mongoose.model<IProject>('Project', projectSchema);
