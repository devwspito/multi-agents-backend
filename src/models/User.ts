import mongoose, { Document, Schema } from 'mongoose';
import { CryptoService } from '../services/CryptoService';

export interface IUser extends Document {
  githubId: string;
  username: string;
  email: string;
  avatarUrl?: string;
  accessToken: string;      // GitHub OAuth token (NOT encrypted - GitHub handles security)
  refreshToken?: string;    // GitHub refresh token (NOT encrypted)
  tokenExpiry?: Date;
  defaultApiKey?: string;   // Anthropic API key (ENCRYPTED)
  createdAt: Date;
  updatedAt: Date;

  // Decryption methods (only for encrypted fields)
  getDecryptedApiKey(): string | undefined;
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
      select: false, // Security: Don't include in queries by default (encrypted)
    },
    refreshToken: {
      type: String,
      select: false, // Security: Don't include in queries by default (encrypted)
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

// ============================================
// Pre-save Hook: Encrypt sensitive fields
// ============================================
userSchema.pre('save', function (next) {
  // NOTE: accessToken and refreshToken are NOT encrypted
  // GitHub OAuth tokens are already secure by design

  // Only encrypt defaultApiKey (Anthropic API key)
  if (this.isModified('defaultApiKey') && this.defaultApiKey) {
    if (!CryptoService.isEncrypted(this.defaultApiKey)) {
      this.defaultApiKey = CryptoService.encrypt(this.defaultApiKey);
    }
  }

  next();
});

// ============================================
// Instance Methods: Decrypt sensitive fields
// ============================================
// Only Anthropic API key needs decryption
userSchema.methods.getDecryptedApiKey = function (): string | undefined {
  return this.defaultApiKey ? CryptoService.decrypt(this.defaultApiKey) : undefined;
};

export const User = mongoose.model<IUser>('User', userSchema);
