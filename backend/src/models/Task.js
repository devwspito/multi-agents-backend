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
    required: true
  },
  feature: {
    type: String,
    required: true
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
    enum: ['backlog', 'assigned', 'in-progress', 'review', 'testing', 'done', 'blocked'],
    default: 'backlog'
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  assignedAgent: {
    type: String,
    enum: ['junior-developer', 'senior-developer', 'qa-engineer', 'product-manager', 'project-manager']
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
    team: { type: String, required: true },
    branch: { type: String },
    assignedAgent: { 
      type: String,
      enum: ['junior-developer', 'senior-developer', 'qa-engineer', 'tech-lead']
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
    reviewerAgent: {
      type: String,
      enum: ['senior-developer', 'qa-engineer']
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
  }]
}, {
  timestamps: true
});

// Indexes for performance
TaskSchema.index({ project: 1, status: 1 });
TaskSchema.index({ assignedTo: 1, status: 1 });
TaskSchema.index({ assignedAgent: 1, status: 1 });
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
    team: repositoryData.team,
    branch: repositoryData.branch || this.gitBranch || 'main',
    assignedAgent: repositoryData.assignedAgent,
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

TaskSchema.methods.getRepositoriesByTeam = function(teamName) {
  return this.repositories.filter(repo => repo.team === teamName);
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
        team: repo.team,
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

TaskSchema.statics.findTasksByTeam = function(teamName) {
  return this.find({ 'repositories.team': teamName });
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
  const teams = [...new Set(this.repositories.map(repo => repo.team))];
  
  // Simple phase generation: backend first, then frontend/mobile, then devops/qa
  const phases = [];
  
  if (teams.includes('backend')) {
    phases.push({
      name: 'Foundation',
      repositories: this.repositories
        .filter(repo => repo.team === 'backend')
        .map(repo => repo.repositoryName),
      dependencies: [],
      status: 'pending'
    });
  }

  const clientTeams = teams.filter(team => ['frontend', 'mobile'].includes(team));
  if (clientTeams.length > 0) {
    phases.push({
      name: 'Client Development',
      repositories: this.repositories
        .filter(repo => clientTeams.includes(repo.team))
        .map(repo => repo.repositoryName),
      dependencies: phases.length > 0 ? [phases[0].name] : [],
      status: 'pending'
    });
  }

  const supportTeams = teams.filter(team => ['devops', 'qa'].includes(team));
  if (supportTeams.length > 0) {
    phases.push({
      name: 'Validation & Deployment',
      repositories: this.repositories
        .filter(repo => supportTeams.includes(repo.team))
        .map(repo => repo.repositoryName),
      dependencies: phases.map(p => p.name),
      status: 'pending'
    });
  }

  this.coordination.phases = phases;
};

module.exports = mongoose.model('Task', TaskSchema);