import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type AgentType = 'product-manager' | 'project-manager' | 'tech-lead' | 'senior-developer' | 'junior-developer' | 'qa-engineer';

export interface IAgentStep {
  agent: AgentType;
  status: TaskStatus;
  startedAt?: Date;
  completedAt?: Date;
  output?: string;
  error?: string;
  sessionId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_usd?: number;
}

export interface ITask extends Document {
  title: string;
  description: string;
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';

  // Agent orchestration
  orchestration: {
    pipeline: IAgentStep[];
    currentAgent?: AgentType;
    totalCost: number;
    totalTokens: number;
  };

  // Metadata
  attachments?: string[];
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const agentStepSchema = new Schema<IAgentStep>(
  {
    agent: {
      type: String,
      enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    startedAt: Date,
    completedAt: Date,
    output: String,
    error: String,
    sessionId: String,
    usage: {
      input_tokens: Number,
      output_tokens: Number,
      cache_creation_input_tokens: Number,
      cache_read_input_tokens: Number,
    },
    cost_usd: Number,
  },
  { _id: false }
);

const taskSchema = new Schema<ITask>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    orchestration: {
      pipeline: [agentStepSchema],
      currentAgent: {
        type: String,
        enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer'],
      },
      totalCost: {
        type: Number,
        default: 0,
      },
      totalTokens: {
        type: Number,
        default: 0,
      },
    },
    attachments: [String],
    tags: [String],
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
taskSchema.index({ userId: 1, status: 1 });
taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ createdAt: -1 });

export const Task = mongoose.model<ITask>('Task', taskSchema);
