import { Schema, model, Document } from 'mongoose';

export interface IOAuthState extends Document {
  state: string;
  createdAt: Date;
}

const oauthStateSchema = new Schema<IOAuthState>(
  {
    state: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

// Crear índice TTL: documentos expirarán 10 minutos (600 segundos) después de createdAt
oauthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const OAuthState = model<IOAuthState>('OAuthState', oauthStateSchema);
