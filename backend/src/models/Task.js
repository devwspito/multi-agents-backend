const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: false // Optional to support unassigned chats
  },
  feature: {
    type: String,
    required: false // Optional for unassigned tasks
  },
  type: {
    type: String,
    enum: ['feature', 'bug', 'enhancement', 'documentation', 'testing', 'compliance'],
    required: true
  },
  complexity: {
    type: String,
    enum: ['simple', 'moderate', 'complex', 'expert'],
    required: true
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  status: {
    type: String,
    enum: ['backlog', 'assigned', 'in-progress', 'review', 'testing', 'done', 'blocked', 'cancelled'],
    default: 'backlog'
  },
  // Orchestration pipeline - automatic execution through all agents
  orchestration: {
    status: {
      type: String,
      enum: ['pending', 'in-progress', 'completed', 'failed', 'cancelled'],
      default: 'pending'
    },
    currentStep: {
      type: Number,
      default: 0
    },
    pipeline: [{
      agent: {
        type: String,
        enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer']
      },
      status: {
        type: String,
        enum: ['pending', 'in-progress', 'completed', 'failed', 'cancelled'],
        default: 'pending'
      },
      startedAt: Date,
      completedAt: Date,
      output: String,
      metrics: {
        executionTime: Number,
        tokensUsed: Number
      }
    }],
    logs: [String]
  },
  estimatedHours: {
    type: Number,
    min: 0.5,
    max: 40
  },
  actualHours: {
    type: Number,
    default: 0
  },
  gitBranch: {
    type: String
  },
  
  // Multi-repository support
  repositories: [{
    repositoryId: { type: String, required: true },
    repositoryName: { type: String, required: true },
    type: {
      type: String,
      enum: ['frontend', 'backend', 'mobile', 'api', 'infrastructure', 'documentation']
    },
    branch: { type: String },
    isActive: {
      type: Boolean,
      default: true // Por defecto todos los repos están activos
    },
    status: {
      type: String,
      enum: ['pending', 'in-progress', 'completed', 'blocked'],
      default: 'pending'
    },
    estimatedHours: { type: Number },
    actualHours: { type: Number, default: 0 },
    pullRequest: {
      number: Number,
      url: String,
      status: {
        type: String,
        enum: ['draft', 'open', 'closed', 'merged']
      }
    },
    changes: {
      filesModified: [{ type: String }],
      linesAdded: { type: Number, default: 0 },
      linesRemoved: { type: Number, default: 0 },
      diff: { type: String },
      lastUpdated: { type: Date }
    }
  }],
  // Legacy support
  pullRequest: {
    number: Number,
    url: String,
    status: {
      type: String,
      enum: ['draft', 'open', 'closed', 'merged']
    }
  },
  // Multi-repo task coordination
  coordination: {
    strategy: {
      type: String,
      enum: ['parallel', 'sequential', 'custom'],
      default: 'parallel'
    },
    phases: [{
      name: { type: String },
      repositories: [{ type: String }],
      dependencies: [{ type: String }],
      status: {
        type: String,
        enum: ['pending', 'in-progress', 'completed', 'blocked'],
        default: 'pending'
      }
    }],
    integrationPoints: [{
      fromRepository: { type: String },
      toRepository: { type: String },
      type: { type: String }, // api_contract, data_format, etc.
      description: { type: String },
      status: {
        type: String,
        enum: ['planned', 'implemented', 'validated'],
        default: 'planned'
      }
    }]
  },
  codeReview: {
    reviewer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'changes-requested', 'rejected']
    },
    feedback: [{
      comment: String,
      severity: {
        type: String,
        enum: ['info', 'warning', 'error', 'critical']
      },
      category: {
        type: String,
        enum: ['functionality', 'security', 'performance', 'maintainability', 'compliance']
      },
      resolved: {
        type: Boolean,
        default: false
      }
    }],
    attempts: {
      type: Number,
      default: 0
    },
    maxAttempts: {
      type: Number,
      default: 3
    }
  },
  testing: {
    unitTests: {
      required: {
        type: Boolean,
        default: true
      },
      coverage: {
        type: Number,
        min: 0,
        max: 100
      },
      status: {
        type: String,
        enum: ['pending', 'passed', 'failed']
      }
    },
    accessibilityTests: {
      required: {
        type: Boolean,
        default: true
      },
      wcagLevel: {
        type: String,
        enum: ['a', 'aa', 'aaa'],
        default: 'aa'
      },
      status: {
        type: String,
        enum: ['pending', 'passed', 'failed']
      }
    },
    integrationTests: {
      lmsCompatibility: [{
        platform: String,
        status: {
          type: String,
          enum: ['pending', 'passed', 'failed']
        }
      }]
    }
  },
  educationalImpact: {
    learningObjectives: [String],
    targetAudience: String,
    expectedOutcomes: [String],
    successMetrics: [String]
  },
  compliance: {
    ferpaReview: {
      required: {
        type: Boolean,
        default: false
      },
      completed: {
        type: Boolean,
        default: false
      },
      notes: String
    },
    coppaReview: {
      required: {
        type: Boolean,
        default: false
      },
      completed: {
        type: Boolean,
        default: false
      },
      notes: String
    }
  },
  dependencies: [{
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task'
    },
    type: {
      type: String,
      enum: ['blocks', 'blocked-by', 'related']
    }
  }],
  activities: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Activity'
  }],
  // NUEVO: Estadísticas de tokens y costos
  tokenStats: {
    totalInputTokens: {
      type: Number,
      default: 0
    },
    totalOutputTokens: {
      type: Number,
      default: 0
    },
    totalTokens: {
      type: Number,
      default: 0
    },
    totalCost: {
      type: Number,
      default: 0
    },
    byAgent: [{
      agent: {
        type: String,
        enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer']
      },
      model: {
        type: String,
        enum: ['opus', 'sonnet']
      },
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      totalTokens: { type: Number, default: 0 },
      cost: { type: Number, default: 0 },
      duration: { type: Number, default: 0 },
      completedAt: Date
    }],
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  // NUEVO: Referencia a los registros de uso de tokens
  tokenUsageRecords: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'TokenUsage'
  }],
  // User who created the task (for unassigned tasks access control)
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: false
  }
}, {
  timestamps: true
});

// Indexes for performance
TaskSchema.index({ project: 1, status: 1 });
TaskSchema.index({ assignedTo: 1, status: 1 });
TaskSchema.index({ createdBy: 1, project: 1 }); // For unassigned tasks queries
TaskSchema.index({ 'orchestration.status': 1, status: 1 });
TaskSchema.index({ 'orchestration.currentStep': 1 });
TaskSchema.index({ complexity: 1, priority: 1 });
TaskSchema.index({ 'pullRequest.status': 1 });

// Virtual for task progress
TaskSchema.virtual('progress').get(function() {
  if (this.repositories && this.repositories.length > 0) {
    // Multi-repo task progress
    const completedRepos = this.repositories.filter(repo => repo.status === 'completed').length;
    return Math.round((completedRepos / this.repositories.length) * 100);
  } else {
    // Single repo task progress
    const statusWeights = {
      'backlog': 0,
      'assigned': 10,
      'in-progress': 30,
      'review': 60,
      'testing': 80,
      'done': 100,
      'blocked': this.actualHours > 0 ? 25 : 0
    };
    return statusWeights[this.status] || 0;
  }
});

// Virtual for total estimated hours across all repositories
TaskSchema.virtual('totalEstimatedHours').get(function() {
  if (this.repositories && this.repositories.length > 0) {
    return this.repositories.reduce((total, repo) => total + (repo.estimatedHours || 0), 0);
  }
  return this.estimatedHours || 0;
});

// Virtual for total actual hours across all repositories
TaskSchema.virtual('totalActualHours').get(function() {
  if (this.repositories && this.repositories.length > 0) {
    return this.repositories.reduce((total, repo) => total + (repo.actualHours || 0), 0);
  }
  return this.actualHours || 0;
});

// Multi-repository methods
TaskSchema.methods.addRepository = function(repositoryData) {
  const repository = {
    repositoryId: repositoryData.repositoryId,
    repositoryName: repositoryData.repositoryName,
    type: repositoryData.type,
    branch: repositoryData.branch || this.gitBranch || 'main',
    estimatedHours: repositoryData.estimatedHours,
    status: 'pending'
  };

  this.repositories.push(repository);
  return repository;
};

TaskSchema.methods.updateRepositoryStatus = function(repositoryId, status, updateData = {}) {
  const repo = this.repositories.find(r => r.repositoryId === repositoryId);
  if (repo) {
    repo.status = status;
    
    // Update additional data if provided
    if (updateData.actualHours !== undefined) {
      repo.actualHours = updateData.actualHours;
    }
    if (updateData.pullRequest) {
      repo.pullRequest = updateData.pullRequest;
    }
    if (updateData.changes) {
      repo.changes = updateData.changes;
    }

    // Update overall task status based on repository statuses
    this.updateOverallStatus();
  }
};

TaskSchema.methods.updateOverallStatus = function() {
  if (!this.repositories || this.repositories.length === 0) {
    return; // Single repo task, don't modify status
  }

  const statuses = this.repositories.map(repo => repo.status);
  const allCompleted = statuses.every(status => status === 'completed');
  const anyInProgress = statuses.some(status => status === 'in-progress');
  const anyBlocked = statuses.some(status => status === 'blocked');

  if (allCompleted) {
    this.status = 'done';
  } else if (anyBlocked) {
    this.status = 'blocked';
  } else if (anyInProgress) {
    this.status = 'in-progress';
  } else {
    this.status = 'assigned';
  }
};

TaskSchema.methods.getRepositoriesByType = function(type) {
  return this.repositories.filter(repo => repo.type === type);
};

TaskSchema.methods.getRepositoryByName = function(repositoryName) {
  return this.repositories.find(repo => repo.repositoryName === repositoryName);
};

TaskSchema.methods.addIntegrationPoint = function(integrationData) {
  if (!this.coordination.integrationPoints) {
    this.coordination.integrationPoints = [];
  }

  const integrationPoint = {
    fromRepository: integrationData.fromRepository,
    toRepository: integrationData.toRepository,
    type: integrationData.type,
    description: integrationData.description,
    status: 'planned'
  };

  this.coordination.integrationPoints.push(integrationPoint);
  return integrationPoint;
};

TaskSchema.methods.updateIntegrationPointStatus = function(fromRepo, toRepo, status) {
  const integrationPoint = this.coordination.integrationPoints.find(
    ip => ip.fromRepository === fromRepo && ip.toRepository === toRepo
  );

  if (integrationPoint) {
    integrationPoint.status = status;
  }
};

TaskSchema.methods.generateUnifiedDiff = function() {
  if (!this.repositories || this.repositories.length === 0) {
    return null;
  }

  const unifiedDiff = {
    totalChanges: {
      repositories: this.repositories.length,
      filesModified: 0,
      linesAdded: 0,
      linesRemoved: 0
    },
    repositoryDiffs: []
  };

  this.repositories.forEach(repo => {
    if (repo.changes) {
      unifiedDiff.totalChanges.filesModified += repo.changes.filesModified?.length || 0;
      unifiedDiff.totalChanges.linesAdded += repo.changes.linesAdded || 0;
      unifiedDiff.totalChanges.linesRemoved += repo.changes.linesRemoved || 0;

      unifiedDiff.repositoryDiffs.push({
        repository: repo.repositoryName,
        type: repo.type,
        files: repo.changes.filesModified || [],
        linesAdded: repo.changes.linesAdded || 0,
        linesRemoved: repo.changes.linesRemoved || 0,
        diff: repo.changes.diff,
        pullRequest: repo.pullRequest
      });
    }
  });

  return unifiedDiff;
};

// Static methods for multi-repository tasks
TaskSchema.statics.findMultiRepoTasks = function() {
  return this.find({ 'repositories.0': { $exists: true } });
};

TaskSchema.statics.findTasksByRepository = function(repositoryName) {
  return this.find({ 'repositories.repositoryName': repositoryName });
};

TaskSchema.statics.findTasksByType = function(type) {
  return this.find({ 'repositories.type': type });
};

// NUEVO: Métodos para gestión de repositorios activos/inactivos por tarea
TaskSchema.methods.getActiveRepositories = function() {
  return this.repositories.filter(repo => repo.isActive !== false);
};

TaskSchema.methods.getInactiveRepositories = function() {
  return this.repositories.filter(repo => repo.isActive === false);
};

TaskSchema.methods.toggleRepository = function(repositoryId, isActive) {
  const repo = this.repositories.find(r => r.repositoryId === repositoryId);
  if (repo) {
    repo.isActive = isActive;
  }
  return this.save();
};

TaskSchema.methods.activateRepository = function(repositoryId) {
  return this.toggleRepository(repositoryId, true);
};

TaskSchema.methods.deactivateRepository = function(repositoryId) {
  return this.toggleRepository(repositoryId, false);
};

TaskSchema.methods.activateAllRepositories = function() {
  this.repositories.forEach(repo => {
    repo.isActive = true;
  });
  return this.save();
};

TaskSchema.methods.deactivateAllRepositories = function() {
  this.repositories.forEach(repo => {
    repo.isActive = false;
  });
  return this.save();
};

// Pre-save middleware to update coordination phases
TaskSchema.pre('save', function(next) {
  if (this.repositories && this.repositories.length > 1) {
    // Ensure coordination strategy is set for multi-repo tasks
    if (!this.coordination.strategy) {
      this.coordination.strategy = 'parallel';
    }

    // Auto-generate phases if not exist
    if (!this.coordination.phases || this.coordination.phases.length === 0) {
      this.generateCoordinationPhases();
    }
  }

  next();
});

TaskSchema.methods.generateCoordinationPhases = function() {
  const types = [...new Set(this.repositories.map(repo => repo.type))];

  // Simple phase generation: backend/api first, then frontend/mobile, then infrastructure/documentation
  const phases = [];

  const foundationTypes = types.filter(type => ['backend', 'api'].includes(type));
  if (foundationTypes.length > 0) {
    phases.push({
      name: 'Foundation',
      repositories: this.repositories
        .filter(repo => foundationTypes.includes(repo.type))
        .map(repo => repo.repositoryName),
      dependencies: [],
      status: 'pending'
    });
  }

  const clientTypes = types.filter(type => ['frontend', 'mobile'].includes(type));
  if (clientTypes.length > 0) {
    phases.push({
      name: 'Client Development',
      repositories: this.repositories
        .filter(repo => clientTypes.includes(repo.type))
        .map(repo => repo.repositoryName),
      dependencies: phases.length > 0 ? [phases[0].name] : [],
      status: 'pending'
    });
  }

  const supportTypes = types.filter(type => ['infrastructure', 'documentation'].includes(type));
  if (supportTypes.length > 0) {
    phases.push({
      name: 'Infrastructure & Documentation',
      repositories: this.repositories
        .filter(repo => supportTypes.includes(repo.type))
        .map(repo => repo.repositoryName),
      dependencies: phases.map(p => p.name),
      status: 'pending'
    });
  }

  this.coordination.phases = phases;
};

// Orchestration methods - automatic agent pipeline
TaskSchema.methods.initializeOrchestration = function() {
  const agentPipeline = [
    'product-manager',
    'project-manager', 
    'tech-lead',
    'senior-developer',
    'junior-developer',
    'qa-engineer'
  ];

  this.orchestration = {
    status: 'pending',
    currentStep: 0,
    pipeline: agentPipeline.map(agent => ({
      agent,
      status: 'pending'
    })),
    logs: []
  };

  this.status = 'assigned'; // Ready for orchestration
  return this.save();
};

TaskSchema.methods.getCurrentAgent = function() {
  if (!this.orchestration || !this.orchestration.pipeline) return null;
  return this.orchestration.pipeline[this.orchestration.currentStep];
};

TaskSchema.methods.advanceOrchestration = function(output, metrics = {}) {
  if (!this.orchestration || !this.orchestration.pipeline) return false;

  const currentStep = this.orchestration.pipeline[this.orchestration.currentStep];
  if (currentStep) {
    currentStep.status = 'completed';
    currentStep.completedAt = new Date();
    currentStep.output = output;
    currentStep.metrics = metrics;
  }

  // Move to next step
  this.orchestration.currentStep += 1;
  
  if (this.orchestration.currentStep >= this.orchestration.pipeline.length) {
    // All agents completed
    this.orchestration.status = 'completed';
    this.status = 'done';
    return false; // No more steps
  } else {
    // Mark next agent as in-progress
    const nextStep = this.orchestration.pipeline[this.orchestration.currentStep];
    nextStep.status = 'in-progress';
    nextStep.startedAt = new Date();
    return true; // Has next step
  }
};

TaskSchema.methods.failOrchestration = function(error) {
  if (!this.orchestration) return;
  
  const currentStep = this.orchestration.pipeline[this.orchestration.currentStep];
  if (currentStep) {
    currentStep.status = 'failed';
    currentStep.completedAt = new Date();
    currentStep.output = error;
  }

  this.orchestration.status = 'failed';
  this.status = 'blocked';
};

TaskSchema.methods.cancelOrchestration = function(reason = 'User cancelled') {
  if (!this.orchestration) return;
  
  // Cancel current step if it's in progress
  const currentStep = this.orchestration.pipeline[this.orchestration.currentStep];
  if (currentStep && currentStep.status === 'in-progress') {
    currentStep.status = 'cancelled';
    currentStep.completedAt = new Date();
    currentStep.output = reason;
  }

  // Mark all pending steps as cancelled
  this.orchestration.pipeline.forEach(step => {
    if (step.status === 'pending') {
      step.status = 'cancelled';
    }
  });

  this.orchestration.status = 'cancelled';
  this.status = 'cancelled';
  this.addOrchestrationLog(`Orchestration cancelled: ${reason}`, 'System');
};

TaskSchema.methods.addOrchestrationLog = function(message, agent) {
  if (!this.orchestration) {
    this.orchestration = { logs: [] };
  }
  
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${agent || 'System'}: ${message}`;
  this.orchestration.logs.push(logEntry);
  
  // Keep only last 100 log entries
  if (this.orchestration.logs.length > 100) {
    this.orchestration.logs = this.orchestration.logs.slice(-100);
  }
};

// NUEVO: Método para registrar uso de tokens de un agente
TaskSchema.methods.recordAgentTokenUsage = async function(agentData) {
  const TokenUsage = mongoose.model('TokenUsage');

  // Crear registro detallado
  const tokenUsage = await TokenUsage.create({
    user: this.createdBy,
    project: this.project,
    task: this._id,
    agentType: agentData.agent,
    model: agentData.model,
    inputTokens: agentData.inputTokens,
    outputTokens: agentData.outputTokens,
    totalTokens: agentData.inputTokens + agentData.outputTokens,
    estimatedCost: agentData.cost,
    requestType: 'orchestration',
    responseTime: agentData.duration,
    orchestrationWorkflowId: this.orchestration?.workflowId,
    agentStage: agentData.stage,
    duration: agentData.duration,
    operationType: agentData.operationType,
    repository: agentData.repository,
    artifacts: agentData.artifacts || [],
    success: agentData.status === 'success',
    errorMessage: agentData.errorMessage,
    startedAt: agentData.startedAt,
    completedAt: agentData.completedAt,
    timestamp: agentData.completedAt || new Date()
  });

  // Agregar a referencias
  this.tokenUsageRecords.push(tokenUsage._id);

  // Actualizar estadísticas de la tarea
  this.tokenStats.totalInputTokens += agentData.inputTokens;
  this.tokenStats.totalOutputTokens += agentData.outputTokens;
  this.tokenStats.totalTokens += (agentData.inputTokens + agentData.outputTokens);
  this.tokenStats.totalCost += agentData.cost;

  // Agregar/actualizar estadísticas por agente
  const agentStat = this.tokenStats.byAgent.find(a => a.agent === agentData.agent);
  if (agentStat) {
    agentStat.inputTokens += agentData.inputTokens;
    agentStat.outputTokens += agentData.outputTokens;
    agentStat.totalTokens += (agentData.inputTokens + agentData.outputTokens);
    agentStat.cost += agentData.cost;
    agentStat.duration += agentData.duration;
    agentStat.completedAt = agentData.completedAt;
  } else {
    this.tokenStats.byAgent.push({
      agent: agentData.agent,
      model: agentData.model,
      inputTokens: agentData.inputTokens,
      outputTokens: agentData.outputTokens,
      totalTokens: agentData.inputTokens + agentData.outputTokens,
      cost: agentData.cost,
      duration: agentData.duration,
      completedAt: agentData.completedAt
    });
  }

  this.tokenStats.lastUpdated = new Date();
  await this.save();

  // Actualizar estadísticas del proyecto
  const Project = mongoose.model('Project');
  const project = await Project.findById(this.project);
  if (project) {
    await project.updateTokenStats();
  }

  return tokenUsage;
};

// NUEVO: Método para obtener resumen de tokens
TaskSchema.methods.getTokenSummary = function() {
  return {
    total: {
      inputTokens: this.tokenStats.totalInputTokens,
      outputTokens: this.tokenStats.totalOutputTokens,
      totalTokens: this.tokenStats.totalTokens,
      cost: this.tokenStats.totalCost
    },
    byAgent: this.tokenStats.byAgent.map(agent => ({
      agent: agent.agent,
      model: agent.model,
      tokens: agent.totalTokens,
      cost: agent.cost,
      percentage: this.tokenStats.totalTokens > 0
        ? ((agent.totalTokens / this.tokenStats.totalTokens) * 100).toFixed(2)
        : 0
    })),
    lastUpdated: this.tokenStats.lastUpdated
  };
};


module.exports = mongoose.model('Task', TaskSchema);