import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type AgentType = 'product-manager' | 'project-manager' | 'tech-lead' | 'senior-developer' | 'junior-developer' | 'qa-engineer' | 'merge-coordinator';
export type StoryComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'epic';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'not_required';

/**
 * Story - Unidad de trabajo implementable
 * Creada dinámicamente por Project Manager
 */
export interface IStory {
  id: string;
  title: string;
  description: string;
  assignedTo?: string; // instanceId del developer (ej: "senior-dev-1")
  supervisedBy?: string; // Para juniors, el senior que supervisa
  priority: number;
  estimatedComplexity: StoryComplexity;
  status: TaskStatus;
  dependencies?: string[]; // IDs de otras stories que deben completarse primero

  // GitHub integration
  branchName?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;

  // Execution details
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;

  // Code review (para juniors)
  reviewedBy?: string; // Senior instanceId que revisó
  reviewStatus?: ReviewStatus;
  reviewComments?: string;
  reviewIterations?: number; // Cuántas veces tuvo que corregir
}

/**
 * TeamMember - Developer (Senior o Junior)
 * Instancia dinámica de un agente developer
 */
export interface ITeamMember {
  agentType: 'senior-developer' | 'junior-developer';
  instanceId: string; // "senior-dev-1", "junior-dev-2", etc.
  assignedStories: string[]; // Story IDs asignados
  status: 'idle' | 'working' | 'reviewing' | 'completed' | 'blocked';

  // GitHub integration
  pullRequests: number[]; // PRs creados por este developer
  reviewing?: number[]; // PRs que está revisando (seniors only)

  // Execution details
  sessionId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  cost_usd?: number;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * AgentStep - Para agentes únicos (PM, PjM, TL, QA, MC)
 */
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

/**
 * Conflict Detection
 */
export interface IPRConflict {
  pr1: number;
  pr2: number;
  overlappingFiles: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  autoResolvable: boolean;
  resolution?: string;
}

/**
 * Orchestration - Nueva estructura con team dinámico
 */
export interface IOrchestration {
  // Fase 1: Product Manager (único)
  productManager: IAgentStep & {
    taskComplexity?: 'small' | 'medium' | 'large' | 'epic';
    recommendedApproach?: string;
  };

  // Fase 2: Project Manager (único)
  projectManager: IAgentStep & {
    stories?: IStory[]; // Stories creadas dinámicamente
    totalStories?: number;
    recommendedTeamSize?: {
      seniors: number;
      juniors: number;
      reasoning: string;
    };
  };

  // Fase 3: Tech Lead (único)
  techLead: IAgentStep & {
    architectureDesign?: string;
    teamComposition?: {
      seniors: number;
      juniors: number;
      reasoning: string;
    };
    storyAssignments?: {
      storyId: string;
      assignedTo: string; // instanceId
      supervisedBy?: string; // Para juniors
    }[];
  };

  // Fase 4: Development Team (MÚLTIPLES - dinámico)
  team?: ITeamMember[];

  // Fase 5: QA Engineer (único)
  qaEngineer?: IAgentStep & {
    integrationBranch?: string; // Rama temporal con todos los PRs mergeados
    integrationTestResults?: any;
    totalPRsTested?: number;
  };

  // Fase 6: Merge Coordinator (único pero observa múltiples PRs)
  mergeCoordinator?: IAgentStep & {
    conflictsDetected?: IPRConflict[];
    resolutionStrategy?: string;
    finalPR?: {
      number: number;
      url: string;
      branch: string;
    };
  };

  // Métricas globales
  currentPhase?: 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'completed';
  totalCost: number;
  totalTokens: number;
}

/**
 * Task - Modelo principal
 */
export interface ITask extends Document {
  title: string;
  description?: string; // Opcional - se define cuando se inicia la tarea en el chat
  userId: mongoose.Types.ObjectId;
  projectId?: mongoose.Types.ObjectId;
  repositoryIds?: mongoose.Types.ObjectId[]; // Múltiples repositorios seleccionados
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';

  // Orchestration con team dinámico
  orchestration: IOrchestration;

  // Metadata
  attachments?: string[];
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Schemas

const storySchema = new Schema<IStory>(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    assignedTo: String,
    supervisedBy: String,
    priority: { type: Number, default: 1 },
    estimatedComplexity: {
      type: String,
      enum: ['trivial', 'simple', 'moderate', 'complex', 'epic'],
      default: 'moderate',
    },
    status: {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
      default: 'pending',
    },
    dependencies: [String],
    branchName: String,
    pullRequestNumber: Number,
    pullRequestUrl: String,
    output: String,
    error: String,
    startedAt: Date,
    completedAt: Date,
    reviewedBy: String,
    reviewStatus: {
      type: String,
      enum: ['pending', 'approved', 'changes_requested', 'not_required'],
      default: 'not_required',
    },
    reviewComments: String,
    reviewIterations: { type: Number, default: 0 },
  },
  { _id: false }
);

const teamMemberSchema = new Schema<ITeamMember>(
  {
    agentType: {
      type: String,
      enum: ['senior-developer', 'junior-developer'],
      required: true,
    },
    instanceId: { type: String, required: true },
    assignedStories: [String],
    status: {
      type: String,
      enum: ['idle', 'working', 'reviewing', 'completed', 'blocked'],
      default: 'idle',
    },
    pullRequests: [Number],
    reviewing: [Number],
    sessionId: String,
    usage: {
      input_tokens: Number,
      output_tokens: Number,
      cache_creation_input_tokens: Number,
      cache_read_input_tokens: Number,
    },
    cost_usd: Number,
    startedAt: Date,
    completedAt: Date,
  },
  { _id: false }
);

const agentStepSchema = new Schema<IAgentStep>(
  {
    agent: {
      type: String,
      enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer', 'merge-coordinator'],
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

const prConflictSchema = new Schema<IPRConflict>(
  {
    pr1: { type: Number, required: true },
    pr2: { type: Number, required: true },
    overlappingFiles: [String],
    severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      required: true,
    },
    autoResolvable: { type: Boolean, default: false },
    resolution: String,
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
      required: false, // Opcional - se define en el primer mensaje del chat
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
    repositoryIds: [{
      type: Schema.Types.ObjectId,
      ref: 'Repository',
    }],
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
      productManager: {
        type: agentStepSchema,
        default: () => ({ agent: 'product-manager', status: 'pending' }),
      },
      projectManager: {
        agent: { type: String, default: 'project-manager' },
        status: { type: String, default: 'pending' },
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
        stories: [storySchema],
        totalStories: Number,
        recommendedTeamSize: {
          seniors: Number,
          juniors: Number,
          reasoning: String,
        },
      },
      techLead: {
        agent: { type: String, default: 'tech-lead' },
        status: { type: String, default: 'pending' },
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
        architectureDesign: String,
        teamComposition: {
          seniors: Number,
          juniors: Number,
          reasoning: String,
        },
        storyAssignments: [{
          storyId: String,
          assignedTo: String,
          supervisedBy: String,
        }],
      },
      team: [teamMemberSchema],
      qaEngineer: {
        agent: { type: String, default: 'qa-engineer' },
        status: { type: String, default: 'pending' },
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
        integrationBranch: String,
        integrationTestResults: Schema.Types.Mixed,
        totalPRsTested: Number,
      },
      mergeCoordinator: {
        agent: { type: String, default: 'merge-coordinator' },
        status: { type: String, default: 'pending' },
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
        conflictsDetected: [prConflictSchema],
        resolutionStrategy: String,
        finalPR: {
          number: Number,
          url: String,
          branch: String,
        },
      },
      currentPhase: {
        type: String,
        enum: ['analysis', 'planning', 'architecture', 'development', 'qa', 'merge', 'completed'],
        default: 'analysis',
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
taskSchema.index({ repositoryIds: 1, status: 1 });
taskSchema.index({ 'orchestration.currentPhase': 1 });
taskSchema.index({ createdAt: -1 });

export const Task = mongoose.model<ITask>('Task', taskSchema);
