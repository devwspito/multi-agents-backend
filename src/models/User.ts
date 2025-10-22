import mongoose, { Document, Schema } from 'mongoose';

export interface IUser extends Document {
  githubId: string;
  username: string;
  email: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  defaultApiKey?: string; // Default Anthropic API key for all projects
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    githubId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    username: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    avatarUrl: {
      type: String,
    },
    accessToken: {
      type: String,
      required: true,
    },
    refreshToken: {
      type: String,
    },
    tokenExpiry: {
      type: Date,
    },
    defaultApiKey: {
      type: String,
      required: false,
      select: false, // Don't include in queries by default (security)
    },
  },
  {
    timestamps: true,
  }
);

export const User = mongoose.model<IUser>('User', userSchema);
