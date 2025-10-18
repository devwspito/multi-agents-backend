import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
export type AgentType = 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'judge' | 'qa-engineer' | 'merge-coordinator' | 'fixer';
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
  assignedTo?: string; // instanceId del developer (ej: "dev-1")
  priority: number;
  estimatedComplexity: StoryComplexity;
  status: TaskStatus;
  dependencies?: string[]; // IDs de otras stories que deben completarse primero

  // Multi-repo support
  repositoryId?: string; // Which repository this story targets
  repositoryName?: string; // Human-readable repository name (e.g., "backend", "frontend")

  // GitHub integration
  branchName?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;

  // Execution details
  output?: string;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;

  // Judge review
  judgeStatus?: ReviewStatus; // Judge evaluation result
  judgeComments?: string; // Judge feedback
  judgeIterations?: number; // Retry count
}

/**
 * TeamMember - Developer
 * Instancia dinámica de un agente developer
 */
export interface ITeamMember {
  agentType: 'developer';
  instanceId: string; // "dev-1", "dev-2", etc.
  assignedStories: string[]; // Story IDs asignados
  status: 'idle' | 'working' | 'completed' | 'blocked';

  // GitHub integration
  pullRequests: number[]; // PRs creados por este developer

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

  // Human approval
  approved?: boolean; // User must approve before continuing
  approval?: {
    status: 'pending' | 'approved' | 'rejected';
    approvedBy?: mongoose.Types.ObjectId;
    approvedAt?: Date;
    requestedAt?: Date;
  };
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
      developers: number;
      reasoning: string;
    };
  };

  // Fase 3: Tech Lead (único)
  techLead: IAgentStep & {
    architectureDesign?: string;
    teamComposition?: {
      developers: number;
      reasoning: string;
    };
    storyAssignments?: {
      storyId: string;
      assignedTo: string; // instanceId (dev-1, dev-2, etc.)
    }[];
    // Branch tracking per repository
    epicBranches?: {
      epicId: string;
      repositoryId: string;
      repositoryName: string;
      branchName: string;
    }[];
  };

  // Fase 4: Development Team (MÚLTIPLES - dinámico)
  team?: ITeamMember[];

  // Fase 4.5: Judge (evalúa código de developers)
  judge?: IAgentStep & {
    evaluations?: {
      storyId: string;
      developerId: string;
      status: ReviewStatus;
      feedback: string;
      iteration: number;
    }[];
  };

  // Fase 4.7: Fixer (arregla errores reportados por QA)
  fixer?: IAgentStep & {
    errorType?: string; // lint, build, test
    filesModified?: string[];
    changes?: string[];
    fixed?: boolean;
  };

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

  // Control de ejecución (pausar/reanudar/cancelar)
  paused?: boolean; // Usuario pausó manualmente la orquestación
  pausedAt?: Date;
  pausedBy?: mongoose.Types.ObjectId;
  cancelRequested?: boolean; // Usuario solicitó cancelación
  cancelRequestedAt?: Date;
  cancelRequestedBy?: mongoose.Types.ObjectId;

  // Auto-aprobación opcional
  autoApprovalEnabled?: boolean; // Flag general para habilitar auto-aprobación
  autoApprovalPhases?: ('product-manager' | 'project-manager' | 'tech-lead' | 'development' | 'judge' | 'qa-engineer' | 'merge-coordinator')[]; // Fases que se auto-aprueban

  // Historial de aprobaciones
  approvalHistory?: {
    phase: string;
    phaseName: string;
    approved: boolean;
    approvedBy?: mongoose.Types.ObjectId;
    approvedAt: Date;
    comments?: string;
    autoApproved?: boolean; // Indica si fue auto-aprobado
  }[];
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

  // Console logs para ConsoleViewer (persistidos para sobrevivir refresh)
  logs?: {
    level: 'log' | 'info' | 'warn' | 'error';
    message: string;
    timestamp: Date;
  }[];

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
    judgeStatus: {
      type: String,
      enum: ['pending', 'approved', 'changes_requested', 'not_required'],
      default: 'not_required',
    },
    judgeComments: String,
    judgeIterations: { type: Number, default: 0 },
  },
  { _id: false }
);

const teamMemberSchema = new Schema<ITeamMember>(
  {
    agentType: {
      type: String,
      enum: ['developer'],
      required: true,
    },
    instanceId: { type: String, required: true },
    assignedStories: [String],
    status: {
      type: String,
      enum: ['idle', 'working', 'completed', 'blocked'],
      default: 'idle',
    },
    pullRequests: [Number],
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
      enum: ['product-manager', 'project-manager', 'tech-lead', 'developer', 'judge', 'qa-engineer', 'merge-coordinator', 'fixer'],
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
          developers: Number,
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
          developers: Number,
          reasoning: String,
        },
        storyAssignments: [{
          storyId: String,
          assignedTo: String,
        }],
      },
      team: [teamMemberSchema],
      judge: {
        agent: { type: String, default: 'judge' },
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
        evaluations: [{
          storyId: String,
          developerId: String,
          status: { type: String, enum: ['approved', 'changes_requested'] },
          feedback: String,
          iteration: Number,
          timestamp: Date,
        }],
      },
      fixer: {
        agent: { type: String, default: 'fixer' },
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
        errorType: String,
        filesModified: [String],
        changes: [String],
        fixed: Boolean,
      },
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
      paused: {
        type: Boolean,
        default: false,
      },
      pausedAt: Date,
      pausedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      cancelRequested: {
        type: Boolean,
        default: false,
      },
      cancelRequestedAt: Date,
      cancelRequestedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
      autoApprovalEnabled: {
        type: Boolean,
        default: false, // ❌ Auto-aprobación DESHABILITADA por defecto - requiere configuración explícita del usuario
      },
      autoApprovalPhases: {
        type: [String],
        enum: ['product-manager', 'project-manager', 'tech-lead', 'development', 'judge', 'qa-engineer', 'merge-coordinator'],
        default: [], // ❌ Sin fases auto-aprobadas por defecto - usuario debe seleccionar manualmente
      },
      approvalHistory: [{
        phase: String,
        phaseName: String,
        approved: Boolean,
        approvedBy: {
          type: Schema.Types.ObjectId,
          ref: 'User',
        },
        approvedAt: Date,
        comments: String,
        autoApproved: Boolean,
      }],
    },
    attachments: [String],
    tags: [String],
    logs: [{
      level: {
        type: String,
        enum: ['log', 'info', 'warn', 'error'],
        required: true,
      },
      message: {
        type: String,
        required: true,
      },
      timestamp: {
        type: Date,
        default: Date.now,
      },
    }],
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
