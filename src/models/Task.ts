import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'interrupted';
// Active agent types (legacy types removed: problem-analyst, product-manager, project-manager, qa-engineer, fixer, merge-coordinator, e2e-tester, contract-fixer, test-creator, contract-tester, error-detective)
export type AgentType = 'planning-agent' | 'tech-lead' | 'developer' | 'judge' | 'auto-merge' | 'team-orchestration' | 'story-merge-agent' | 'git-flow-manager';
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
  acceptanceCriteria?: string[]; // Acceptance criteria for verification
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

  // 🔥 Cost tracking per story
  cost_usd?: number; // Total cost for this story (dev + judge iterations)
  developerCost_usd?: number; // Cost of developer agent
  judgeCost_usd?: number; // Total cost of judge iterations
  judgeIterationCosts?: Array<{
    iteration: number;
    cost_usd: number;
    verdict: 'approved' | 'rejected';
  }>;
}

/**
 * Epic - Group of related stories
 * Created by Planning phase and used throughout orchestration
 */
export interface IEpic {
  id: string;
  name: string;
  title?: string; // Alias for name (some code uses title)
  description: string;
  branchName: string;
  stories: string[]; // Story IDs
  branchesCreated: boolean;
  prCreated: boolean;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  targetRepository?: string;
  dependencies?: string[]; // Epic dependencies for ordering
  pullRequestState?: 'pending' | 'open' | 'merged' | 'closed'; // PR management state
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
 * AgentStep - Para agentes únicos (Planning, TL, Judge, AutoMerge)
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
 * Directive - User instruction injected mid-execution
 * Allows users to provide real-time feedback that agents incorporate
 */
export interface IDirective {
  id: string;
  content: string;                    // The actual directive text
  priority: 'critical' | 'high' | 'normal' | 'suggestion';
  targetPhase?: string;               // Optional: inject only in specific phase
  targetAgent?: string;               // Optional: inject only for specific agent type
  injectedAt?: Date;                  // When it was consumed by an agent
  consumed: boolean;                  // Whether it's been processed
  createdAt: Date;
  createdBy?: mongoose.Types.ObjectId;
}

/**
 * Orchestration - Nueva estructura con team dinámico
 */
export interface IOrchestration {
  // UNIFIED PLANNING PHASE (replaces problemAnalyst + productManager + projectManager)
  planning?: IAgentStep & {
    analysis?: any;           // Structured problem analysis
    epics?: IEpic[];          // Epics with stories
    stories?: IStory[];       // All stories flattened
    overlapValidation?: any;  // File overlap detection results
    contextSummary?: string;  // Codebase exploration summary
  };


  // Fase 3: Tech Lead (único) - Used by TeamOrchestrationPhase
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
    stories?: IStory[]; // Stories passed from Planning phase
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


  // Fase 5: Recovery (verifica trabajo completado y detecta trabajo pendiente)
  recovery?: IAgentStep & {
    verifiedPRs?: {
      number: number;
      epicId: string;
      branchName: string;
      files: string[];
      status: 'complete' | 'incomplete' | 'needs_fix';
    }[];
    recoveryStatuses?: {
      epicId: string;
      status: 'complete' | 'incomplete' | 'needs_pr' | 'missing';
      action?: string;
    }[];
    allComplete?: boolean;
  };

  // Fase 6: Integration (merge de branches, resolución de conflictos, fix de build)
  integration?: IAgentStep & {
    merged?: number;
    total?: number;
    mergeResults?: {
      branch: string;
      success: boolean;
      conflicts?: string[];
    }[];
    buildSuccess?: boolean;
  };

  // Fase 7: Auto Merge (automático - merge PRs a main después de verificación)
  autoMerge?: IAgentStep & {
    results?: {
      success: boolean;
      merged: boolean;
      conflictsDetected: any[];
      conflictsResolved: number;
      needsHumanReview: boolean;
      error?: string;
      mergeCommitSha?: string;
    }[];
  };


  // Métricas globales
  currentPhase?: 'planning' | 'architecture' | 'development' | 'recovery' | 'integration' | 'merge' | 'auto-merge' | 'completed' | 'multi-team';
  phases?: any[]; // Array of phase objects with name, status, startedAt, approval
  totalCost: number;
  totalTokens: number;

  // 🔥 Cost tracking by phase for visibility/debugging
  costByPhase?: {
    planning?: { cost_usd: number; tokens: number };
    approval?: { cost_usd: number; tokens: number };
    techLead?: { cost_usd: number; tokens: number };
    developers?: { cost_usd: number; tokens: number };
    judge?: { cost_usd: number; tokens: number };
    autoMerge?: { cost_usd: number; tokens: number };
  };

  // Control de ejecución (pausar/reanudar/cancelar)
  paused?: boolean; // Usuario pausó manualmente la orquestación
  pausedAt?: Date;
  pausedBy?: mongoose.Types.ObjectId;
  cancelRequested?: boolean; // Usuario solicitó cancelación
  cancelRequestedAt?: Date;
  cancelRequestedBy?: mongoose.Types.ObjectId;

  // 💡 MID-EXECUTION DIRECTIVE INJECTION
  // Allows users to send instructions to agents while orchestration is running
  // Directives are picked up between phases and injected into agent prompts
  pendingDirectives?: IDirective[];
  directiveHistory?: IDirective[];  // Archive of consumed directives for audit trail

  // Auto-aprobación opcional
  // Phases: planning, tech-lead, team-orchestration, development, judge, recovery, integration, verification, auto-merge
  autoApprovalEnabled?: boolean; // Flag general para habilitar auto-aprobación
  autoApprovalPhases?: ('planning' | 'tech-lead' | 'team-orchestration' | 'development' | 'judge' | 'recovery' | 'integration' | 'verification' | 'verification-fixer' | 'auto-merge')[]; // Fases que se auto-aprueban
  supervisorThreshold?: number; // 0-100: Auto-approve when Supervisor score >= threshold (default 80)
  // 📌 Pending approval data for re-emit on socket reconnect
  pendingApproval?: {
    phase: string;
    phaseName: string;
    agentOutput?: any;
    retryCount?: number;
    timestamp?: Date;
  };

  // Model configuration
  // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Recovery → Integration → AutoMerge
  modelConfig?: {
    preset?: 'max' | 'premium' | 'recommended' | 'standard' | 'custom';
    customConfig?: {
      planning?: string;
      techLead?: string;
      developer?: string;
      judge?: string;
      verification?: string;
      autoMerge?: string;
    };
  };

  // 🔧 Environment configuration from TechLead
  // Contains project-specific commands (test, lint, typecheck, etc.)
  // Stored in DB for persistence across server restarts
  environmentConfig?: {
    installCommand?: string;
    runCommand?: string;
    buildCommand?: string;
    testCommand?: string;
    lintCommand?: string;
    typecheckCommand?: string;
    defaultPort?: number;
    language?: string;
    framework?: string;
  };

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

  // Continuations (for /continue endpoint)
  continuations?: {
    timestamp: Date;
    additionalRequirements: string;
    previousStatus: string;
  }[];

  // Integration Task Pattern: For multi-repo projects (backend + frontend)
  // Stores the definition for the follow-up Integration Task
  pendingIntegrationTask?: {
    title: string;
    description: string;
    targetRepository: string;
    integrationPoints: string[];
    filesToCreate: string[];
    status: 'pending' | 'created' | 'completed' | 'skipped';
    createdTaskId?: mongoose.Types.ObjectId;
    userNotified?: boolean;
  };

  // Flag indicating this is a multi-repo project
  isMultiRepo?: boolean;

  // 🆘 HUMAN INTERVENTION SYSTEM
  // When agents exhaust retries, they escalate to humans instead of silently failing
  humanIntervention?: {
    required: boolean;
    requestedAt?: Date;
    resolvedAt?: Date;

    // Context for the human
    phase: string;           // Which phase needs help
    storyId?: string;        // Which story (if applicable)
    agentType: AgentType;    // Which agent is stuck

    // Problem description
    reason: string;          // Why human intervention is needed
    attempts: number;        // How many times the agent tried
    lastFeedback: string;    // Last feedback/error from the agent
    filesInvolved?: string[]; // Files that were being worked on

    // Human response
    resolved?: boolean;
    resolution?: 'fixed_manually' | 'skip_story' | 'abort_task' | 'retry_with_guidance';
    humanGuidance?: string;  // Additional instructions from human
    resolvedBy?: mongoose.Types.ObjectId;
  };

  // 🌿 BRANCH REGISTRY: Persisted branch info for recovery across restarts
  // Stores all branches created during orchestration (epic, story, feature branches)
  branchRegistry?: {
    name: string;
    type: 'epic' | 'story' | 'feature' | 'hotfix';
    repository: string;
    epicId?: string;
    storyId?: string;
    createdAt: Date;
    pushed?: boolean;
    merged?: boolean;
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

  // 🎯 Activity events for OpenCode-style display (persisted for refresh survival)
  activities?: {
    agentName: string;
    type: 'read' | 'edit' | 'write' | 'bash' | 'think' | 'tool' | 'error' | 'message';
    timestamp: Date;
    file?: string;
    content?: string;
    command?: string;
    output?: string;
    toolName?: string;
    toolInput?: any;
    diff?: {
      oldContent?: string;
      newContent?: string;
      lines: {
        type: 'add' | 'remove' | 'context';
        content: string;
        oldNum?: number;
        newNum?: number;
      }[];
    };
  }[];

  // Webhook deduplication metadata
  webhookMetadata?: {
    errorHash?: string;
    occurrenceCount?: number;
    firstOccurrence?: Date;
    lastOccurrence?: Date;
    source?: string;
  };

  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Schemas

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
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'paused', 'interrupted'],
      default: 'pending',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    orchestration: {
      // NOTE: planning field is defined dynamically (Schema.Types.Mixed)
      // Active phases: planning, techLead, team, judge, autoMerge
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
      autoMerge: {
        agent: { type: String, default: 'auto-merge' },
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
        results: [{
          success: Boolean,
          merged: Boolean,
          conflictsDetected: [Schema.Types.Mixed],
          conflictsResolved: Number,
          needsHumanReview: Boolean,
          error: String,
          mergeCommitSha: String,
        }],
      },
      currentPhase: {
        type: String,
        enum: ['planning', 'architecture', 'development', 'merge', 'auto-merge', 'completed', 'multi-team'],
        default: 'planning',
      },
      totalCost: {
        type: Number,
        default: 0,
      },
      totalTokens: {
        type: Number,
        default: 0,
      },
      // 🔥 Cost tracking by phase for visibility/debugging
      costByPhase: {
        planning: { cost_usd: Number, tokens: Number },
        approval: { cost_usd: Number, tokens: Number },
        techLead: { cost_usd: Number, tokens: Number },
        developers: { cost_usd: Number, tokens: Number },
        judge: { cost_usd: Number, tokens: Number },
        autoMerge: { cost_usd: Number, tokens: Number },
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

      // 💡 MID-EXECUTION DIRECTIVE INJECTION
      pendingDirectives: [{
        id: { type: String, required: true },
        content: { type: String, required: true },
        priority: {
          type: String,
          enum: ['critical', 'high', 'normal', 'suggestion'],
          default: 'normal',
        },
        targetPhase: String,           // Optional: only inject in this phase
        targetAgent: String,           // Optional: only inject for this agent type
        injectedAt: Date,              // When consumed by an agent
        consumed: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now },
        createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      }],
      directiveHistory: [{             // Archive of consumed directives
        id: { type: String, required: true },
        content: { type: String, required: true },
        priority: String,
        targetPhase: String,
        targetAgent: String,
        injectedAt: Date,
        consumed: { type: Boolean, default: true },
        createdAt: Date,
        createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      }],

      autoApprovalEnabled: {
        type: Boolean,
        default: false, // ❌ Auto-aprobación DESHABILITADA por defecto - requiere configuración explícita del usuario
      },
      // Phases: planning, tech-lead, team-orchestration, development, judge, recovery, integration, verification, auto-merge
      autoApprovalPhases: {
        type: [String],
        enum: ['planning', 'tech-lead', 'team-orchestration', 'development', 'judge', 'recovery', 'integration', 'verification', 'verification-fixer', 'auto-merge'],
        default: [], // ❌ Sin fases auto-aprobadas por defecto - usuario debe seleccionar manualmente
      },
      // 📌 Pending approval data for re-emit on socket reconnect
      pendingApproval: {
        phase: String,
        phaseName: String,
        agentOutput: Schema.Types.Mixed,
        retryCount: { type: Number, default: 0 },
        timestamp: Date,
      },
      // 🤖 Supervisor auto-approval threshold (0-100)
      // When Supervisor score >= threshold, auto-approve without waiting for human
      supervisorThreshold: {
        type: Number,
        min: 0,
        max: 100,
        default: 80, // 80% compliance = auto-approve
      },
      modelConfig: {
        preset: {
          type: String,
          enum: ['max', 'premium', 'recommended', 'standard', 'custom'],
          default: 'standard',
        },
        // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Recovery → Integration → AutoMerge
        customConfig: {
          planning: String,
          techLead: String,
          developer: String,
          judge: String,
          verification: String,
          autoMerge: String,
        },
      },
      // 🔧 Environment configuration from TechLead (persisted for server restart recovery)
      environmentConfig: {
        installCommand: String,
        runCommand: String,
        buildCommand: String,
        testCommand: String,
        lintCommand: String,
        typecheckCommand: String,
        defaultPort: Number,
        language: String,
        framework: String,
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
      continuations: [{
        timestamp: Date,
        additionalRequirements: String,
        previousStatus: String,
      }],

      // Integration Task Pattern
      pendingIntegrationTask: {
        title: String,
        description: String,
        targetRepository: String,
        integrationPoints: [String],
        filesToCreate: [String],
        status: {
          type: String,
          enum: ['pending', 'created', 'completed', 'skipped'],
          default: 'pending',
        },
        createdTaskId: { type: Schema.Types.ObjectId, ref: 'Task' },
        userNotified: Boolean,
      },
      isMultiRepo: Boolean,

      // 🆘 HUMAN INTERVENTION SYSTEM
      humanIntervention: {
        required: { type: Boolean, default: false },
        requestedAt: Date,
        resolvedAt: Date,
        phase: String,
        storyId: String,
        agentType: String,
        reason: String,
        attempts: Number,
        lastFeedback: String,
        filesInvolved: [String],
        resolved: Boolean,
        resolution: {
          type: String,
          enum: ['fixed_manually', 'skip_story', 'abort_task', 'retry_with_guidance'],
        },
        humanGuidance: String,
        resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      },
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
    // 🎯 Activity events for OpenCode-style display (persisted for refresh survival)
    activities: [{
      agentName: String,
      type: {
        type: String,
        enum: ['read', 'edit', 'write', 'bash', 'think', 'tool', 'error', 'message'],
      },
      timestamp: {
        type: Date,
        default: Date.now,
      },
      file: String,
      content: String,
      command: String,
      output: String,
      toolName: String,
      toolInput: Schema.Types.Mixed,
      diff: {
        oldContent: String,
        newContent: String,
        lines: [{
          type: {
            type: String,
            enum: ['add', 'remove', 'context'],
          },
          content: String,
          oldNum: Number,
          newNum: Number,
        }],
      },
    }],
    // Webhook deduplication metadata
    webhookMetadata: {
      errorHash: String, // SHA-256 hash of errorType + message
      occurrenceCount: {
        type: Number,
        default: 1,
      },
      firstOccurrence: Date,
      lastOccurrence: Date,
      source: String, // 'webhook-errors', 'webhook-github', etc
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for performance
taskSchema.index({ userId: 1, status: 1 });
taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ repositoryIds: 1, status: 1 });
taskSchema.index({ 'webhookMetadata.errorHash': 1, projectId: 1, status: 1 }); // For deduplication
taskSchema.index({ 'orchestration.currentPhase': 1 });
taskSchema.index({ createdAt: -1 });

export const Task = mongoose.model<ITask>('Task', taskSchema);
