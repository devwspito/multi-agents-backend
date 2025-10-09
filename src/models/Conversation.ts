import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  attachments?: string[];
  agent?: string; // Para mensajes de agentes específicos
}

export interface IConversation extends Document {
  taskId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  messages: IMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    id: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['user', 'assistant', 'system'],
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    attachments: [String],
    agent: String,
  },
  { _id: false }
);

const conversationSchema = new Schema<IConversation>(
  {
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'Task',
      required: true,
      unique: true, // Una conversación por tarea
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    messages: [messageSchema],
  },
  {
    timestamps: true,
  }
);

// Índices para búsqueda rápida
conversationSchema.index({ taskId: 1, userId: 1 });
conversationSchema.index({ createdAt: -1 });

export const Conversation = mongoose.model<IConversation>('Conversation', conversationSchema);
