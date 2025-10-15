import mongoose, { Document, Schema } from 'mongoose';

/**
 * Console Log Model
 * Stores all backend console logs for tasks
 */
export interface IConsoleLog extends Document {
  taskId: mongoose.Types.ObjectId;
  timestamp: Date;
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  createdAt: Date;
}

const consoleLogSchema = new Schema<IConsoleLog>({
  taskId: {
    type: Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true,
  },
  timestamp: {
    type: Date,
    required: true,
    default: Date.now,
  },
  level: {
    type: String,
    enum: ['log', 'info', 'warn', 'error'],
    required: true,
    default: 'log',
  },
  message: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Indexes for performance
consoleLogSchema.index({ taskId: 1, timestamp: -1 }); // Query logs by task, sorted by time
consoleLogSchema.index({ createdAt: 1 }); // For optional cleanup queries

export default mongoose.model<IConsoleLog>('ConsoleLog', consoleLogSchema);
