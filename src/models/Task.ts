import mongoose, { Document, Schema } from 'mongoose';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'paused';
export type AgentType = 'planning-agent' | 'problem-analyst' | 'product-manager' | 'project-manager' | 'tech-lead' | 'developer' | 'judge' | 'qa-engineer' | 'merge-coordinator' | 'fixer' | 'auto-merge' | 'e2e-tester' | 'contract-fixer' | 'team-orchestration' | 'test-creator' | 'contract-tester' | 'error-detective' | 'story-merge-agent' | 'git-flow-manager';
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
  cost_usd?: number; // Total cost for this story (dev + judge iterations + fixer)
  developerCost_usd?: number; // Cost of developer agent
  judgeCost_usd?: number; // Total cost of judge iterations
  fixerCost_usd?: number; // Cost of fixer agent (if used)
  judgeIterationCosts?: Array<{
    iteration: number;
    cost_usd: number;
    verdict: 'approved' | 'rejected';
  }>;
}

/**
 * Epic - Group of related stories
 * Created by ProductManager and used throughout orchestration
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

  // Legacy phases (kept for backward compatibility)
  // Fase 0: Problem Analyst (único) - Deep problem analysis
  problemAnalyst?: IAgentStep & {
    analysis?: any; // Structured analysis data
  };

  // Fase 1: Product Manager (único) - Legacy, but required for TeamOrchestrationPhase
  productManager: IAgentStep & {
    taskComplexity?: 'small' | 'medium' | 'large' | 'epic';
    recommendedApproach?: string;
  };

  // Fase 2: Project Manager (único) - Legacy, but required for compatibility
  projectManager: IAgentStep & {
    stories?: IStory[]; // Stories creadas dinámicamente
    totalStories?: number;
    recommendedTeamSize?: {
      developers: number;
      reasoning: string;
    };
    epics?: IEpic[]; // Epics from ProductManager
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
    stories?: IStory[]; // Stories passed from ProjectManager
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
    // Last Chance Mode (attempt 2) tracking
    lastChanceMode?: boolean;
    lastChanceAnalysis?: {
      automatable: boolean;
      fixes?: any[];
      totalEstimatedCost?: number;
      reasoning?: string;
      recommendation?: string;
    };
    analysisCost?: number;
    fixerCost?: number;
    totalCost?: number;
    escalated?: boolean;
    budgetExceeded?: boolean;
  };

  // Fase 5: QA Engineer (único)
  qaEngineer?: IAgentStep & {
    integrationBranch?: string; // Rama temporal con todos los PRs mergeados
    integrationTestResults?: any;
    totalPRsTested?: number;
    previousAttempt?: {
      output?: string;
      error?: string;
      completedAt?: Date;
    };
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

  // Fase 7: Auto Merge (automático - merge PRs a main después de QA) - NEW
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

  // Fase 7.5: Test Creator (creates comprehensive test suites before QA validation)
  testCreator?: IAgentStep & {
    testsCreated?: number; // Total test files created
    coveragePercentage?: number | string; // Code coverage achieved (target: >85%) or "N/A" message
    unitTests?: number;
    integrationTests?: number;
    e2eTests?: number;
  };

  // Fase 8: Contract Testing (verifies API contracts through static analysis)
  contractTesting?: IAgentStep & {
    contractsValid?: boolean;
    backendEndpoints?: number;
    frontendCalls?: number;
    contractIssues?: number;
  };

  // Fase 8.5: Contract Fixer (fixes integration issues detected by Contract Testing)
  contractFixer?: IAgentStep & {
    errorType?: string; // endpoint-not-found, cors, payload-mismatch, etc.
    filesModified?: string[];
    changes?: string[];
    fixed?: boolean;
    attempts?: number; // Number of fix attempts
    lastErrorHash?: string; // Hash of last error to detect if error changed
    errorHistory?: Array<{
      errorHash: string;
      errorType: string;
      attempt: number;
      timestamp: Date;
    }>;
  };

  // Fase 9: Error Detective (analyzes runtime errors and provides fix recommendations)
  errorDetective?: IAgentStep & {
    errorsAnalyzed?: number;
    fixesRecommended?: number;
    automationPossible?: boolean;
    errorType?: string;
    severity?: string;
    rootCauseConfidence?: number;
    actionableInsights?: string[];
  };

  // Legacy: Developer phase (used by optimized phases)
  developers?: IAgentStep & {
    storiesCompleted?: number;
    filesModified?: number;
  };

  // Métricas globales
  currentPhase?: 'analysis' | 'planning' | 'architecture' | 'development' | 'qa' | 'merge' | 'auto-merge' | 'e2e' | 'completed';
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
    fixer?: { cost_usd: number; tokens: number };
    qa?: { cost_usd: number; tokens: number };
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
  // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
  autoApprovalEnabled?: boolean; // Flag general para habilitar auto-aprobación
  autoApprovalPhases?: ('planning' | 'team-orchestration' | 'verification' | 'auto-merge')[]; // Fases que se auto-aprueban

  // Model configuration
  // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
  modelConfig?: {
    preset?: 'max' | 'premium' | 'recommended' | 'standard' | 'custom';
    customConfig?: {
      planning?: string;
      techLead?: string;
      developer?: string;
      judge?: string;
      fixer?: string;
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

const storySchema = new Schema<IStory>(
  {
    id: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    acceptanceCriteria: [String],
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
    // 🔥 Cost tracking per story
    cost_usd: { type: Number, default: 0 }, // Total cost for this story
    developerCost_usd: { type: Number, default: 0 }, // Cost of developer agent
    judgeCost_usd: { type: Number, default: 0 }, // Total cost of judge iterations
    fixerCost_usd: { type: Number, default: 0 }, // Cost of fixer agent (if used)
    judgeIterationCosts: [{
      iteration: Number,
      cost_usd: Number,
      verdict: { type: String, enum: ['approved', 'rejected'] },
    }],
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
      enum: ['planning-agent', 'problem-analyst', 'product-manager', 'project-manager', 'tech-lead', 'developer', 'judge', 'qa-engineer', 'merge-coordinator', 'fixer', 'auto-merge', 'e2e-tester', 'contract-fixer', 'team-orchestration', 'test-creator', 'contract-tester', 'error-detective', 'story-merge-agent', 'git-flow-manager'],
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
      enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled', 'paused'],
      default: 'pending',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    orchestration: {
      problemAnalyst: {
        agent: { type: String, default: 'problem-analyst' },
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
        analysis: Schema.Types.Mixed, // Structured analysis data
      },
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
      testCreator: {
        agent: { type: String, default: 'test-creator' },
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
        testsCreated: Number,
        coveragePercentage: Schema.Types.Mixed, // Can be Number or String ("N/A" message)
        unitTests: Number,
        integrationTests: Number,
        e2eTests: Number,
      },
      contractTesting: {
        agent: { type: String, default: 'contract-tester' },
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
        contractsValid: Boolean,
        backendEndpoints: Number,
        frontendCalls: Number,
        contractIssues: Number,
      },
      contractFixer: {
        agent: { type: String, default: 'contract-fixer' },
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
        attempts: Number,
        lastErrorHash: String,
        errorHistory: [{
          errorHash: String,
          errorType: String,
          attempt: Number,
          timestamp: Date,
        }],
      },
      currentPhase: {
        type: String,
        enum: ['analysis', 'planning', 'architecture', 'development', 'qa', 'merge', 'auto-merge', 'e2e', 'completed', 'multi-team', 'error-resolution', 'contract-testing'],
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
      // 🔥 Cost tracking by phase for visibility/debugging
      costByPhase: {
        planning: { cost_usd: Number, tokens: Number },
        approval: { cost_usd: Number, tokens: Number },
        techLead: { cost_usd: Number, tokens: Number },
        developers: { cost_usd: Number, tokens: Number },
        judge: { cost_usd: Number, tokens: Number },
        fixer: { cost_usd: Number, tokens: Number },
        qa: { cost_usd: Number, tokens: Number },
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
      // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
      autoApprovalPhases: {
        type: [String],
        enum: ['planning', 'team-orchestration', 'verification', 'auto-merge'],
        default: [], // ❌ Sin fases auto-aprobadas por defecto - usuario debe seleccionar manualmente
      },
      modelConfig: {
        preset: {
          type: String,
          enum: ['max', 'premium', 'recommended', 'standard', 'custom'],
          default: 'standard',
        },
        // Active phases from PHASE_ORDER: Planning → Approval → TeamOrchestration → Verification → AutoMerge
        customConfig: {
          planning: String,
          techLead: String,
          developer: String,
          judge: String,
          fixer: String,
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
