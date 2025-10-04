const mongoose = require('mongoose');

const ProjectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['web-app', 'mobile-app', 'api', 'microservice', 'library', 'saas'],
    required: true
  },
  status: {
    type: String,
    enum: ['planning', 'in-progress', 'review', 'completed', 'on-hold'],
    default: 'planning'
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  collaborators: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: {
      type: String,
      enum: ['owner', 'contributor', 'viewer'],
      default: 'contributor'
    }
  }],
  repository: {
    url: String,
    branch: {
      type: String,
      default: 'main'
    }
  },
  // Multi-repository support
  repositories: [{
    name: {
      type: String,
      required: false
    },
    githubUrl: {
      type: String,
      required: false
    },
    owner: {
      type: String,
      required: false
    },
    branch: {
      type: String,
      default: 'main'
    },
    type: {
      type: String,
      enum: ['frontend', 'backend', 'mobile', 'api', 'infrastructure', 'documentation'],
      required: false
    },
    technologies: [{
      type: String
    }],
    accessToken: {
      type: String,
      select: false // Don't include in queries by default
    },
    installationId: {
      type: String
    },
    isActive: {
      type: Boolean,
      default: true
    },
    metadata: {
      hasTests: { type: Boolean, default: false },
      hasCI: { type: Boolean, default: false },
      packageManager: { type: String },
      structure: {
        type: { type: String },
        srcDir: { type: String },
        testDir: { type: String },
        configFiles: [{ type: String }]
      },
      dependencies: {
        npm: {
          dependencies: { type: mongoose.Schema.Types.Mixed },
          devDependencies: { type: mongoose.Schema.Types.Mixed }
        },
        pip: [{ type: String }]
      },
      languages: { type: mongoose.Schema.Types.Mixed }
    },
    webhookId: {
      type: String
    },
    lastSync: {
      type: Date
    },
    syncStatus: {
      type: String,
      enum: ['pending', 'syncing', 'synced', 'error'],
      default: 'pending'
    }
  }],
  // Project settings
  settings: {
    defaultBranch: {
      type: String,
      default: 'main'
    },
    autoDeployment: {
      type: Boolean,
      default: false
    },
    requiredReviews: {
      type: Number,
      default: 1
    },
    educationalContext: {
      type: String,
      enum: ['k12', 'higher_ed', 'corporate_training', 'general'],
      default: 'general'
    },
    complianceLevel: {
      type: String,
      enum: ['basic', 'ferpa', 'coppa', 'gdpr', 'enterprise'],
      default: 'basic'
    }
  },
  // Project statistics
  stats: {
    totalTasks: { type: Number, default: 0 },
    completedTasks: { type: Number, default: 0 },
    activeTasks: { type: Number, default: 0 },
    pendingReviews: { type: Number, default: 0 },
    lastActivity: { type: Date }
  },
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
    byModel: {
      opus: {
        inputTokens: { type: Number, default: 0 },
        outputTokens: { type: Number, default: 0 },
        totalTokens: { type: Number, default: 0 },
        cost: { type: Number, default: 0 }
      },
      sonnet: {
        inputTokens: { type: Number, default: 0 },
        outputTokens: { type: Number, default: 0 },
        totalTokens: { type: Number, default: 0 },
        cost: { type: Number, default: 0 }
      }
    },
    byAgent: {
      'product-manager': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } },
      'project-manager': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } },
      'tech-lead': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } },
      'senior-developer': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } },
      'junior-developer': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } },
      'qa-engineer': { tokens: { type: Number, default: 0 }, cost: { type: Number, default: 0 } }
    },
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  features: [{
    name: String,
    description: String,
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    estimatedHours: Number,
    status: {
      type: String,
      enum: ['backlog', 'in-progress', 'review', 'done'],
      default: 'backlog'
    }
  }],
  compliance: {
    ferpa: {
      type: Boolean,
      default: false
    },
    coppa: {
      type: Boolean,
      default: false
    },
    gdpr: {
      type: Boolean,
      default: false
    },
    accessibility: {
      type: String,
      enum: ['none', 'wcag-a', 'wcag-aa', 'wcag-aaa'],
      default: 'wcag-aa'
    }
  },
  lmsIntegrations: [{
    platform: {
      type: String,
      enum: ['canvas', 'moodle', 'blackboard', 'schoology', 'google-classroom']
    },
    apiKey: String,
    baseUrl: String,
    enabled: {
      type: Boolean,
      default: false
    }
  }],
  metadata: {
    targetAudience: {
      type: String,
      enum: ['k12', 'higher-ed', 'corporate', 'adult-learning']
    },
    subjectArea: [String],
    gradeLevels: [String]
  }
}, {
  timestamps: true
});

// Index for faster queries
ProjectSchema.index({ owner: 1, status: 1 });
ProjectSchema.index({ 'collaborators.user': 1 });
ProjectSchema.index({ type: 1, status: 1 });
ProjectSchema.index({ 'repositories.githubUrl': 1 });
ProjectSchema.index({ 'repositories.type': 1 });

// Virtual for completion percentage
ProjectSchema.virtual('completionPercentage').get(function() {
  if (this.stats.totalTasks === 0) return 0;
  return Math.round((this.stats.completedTasks / this.stats.totalTasks) * 100);
});

// Multi-repository methods
ProjectSchema.methods.addRepository = function(repositoryData) {
  // Validate repository type
  const validTypes = ['frontend', 'backend', 'mobile', 'api', 'infrastructure', 'documentation'];
  if (repositoryData.type && !validTypes.includes(repositoryData.type)) {
    throw new Error(`Invalid repository type: ${repositoryData.type}`);
  }

  // Extract owner and name from GitHub URL
  const urlMatch = repositoryData.githubUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!urlMatch) {
    throw new Error('Invalid GitHub URL format');
  }

  const repository = {
    name: repositoryData.name || urlMatch[2],
    githubUrl: repositoryData.githubUrl,
    owner: urlMatch[1],
    branch: repositoryData.branch || 'main',
    type: repositoryData.type || 'backend',
    technologies: repositoryData.technologies || [],
    accessToken: repositoryData.accessToken,
    installationId: repositoryData.installationId
  };

  this.repositories.push(repository);
  return repository;
};

ProjectSchema.methods.removeRepository = function(repositoryId) {
  const repo = this.repositories.id(repositoryId);
  if (repo) {
    repo.remove();
  }
};

ProjectSchema.methods.getRepositoriesByType = function(type) {
  return this.repositories.filter(repo => repo.type === type);
};

ProjectSchema.methods.updateStats = async function() {
  const Task = mongoose.model('Task');
  
  const stats = await Task.aggregate([
    { $match: { project: this._id } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 }
      }
    }
  ]);

  let totalTasks = 0;
  let completedTasks = 0;
  let activeTasks = 0;
  let pendingReviews = 0;

  stats.forEach(stat => {
    totalTasks += stat.count;
    
    switch (stat._id) {
      case 'completed':
        completedTasks += stat.count;
        break;
      case 'in_progress':
        activeTasks += stat.count;
        break;
      case 'review':
        pendingReviews += stat.count;
        break;
    }
  });

  this.stats = {
    totalTasks,
    completedTasks,
    activeTasks,
    pendingReviews,
    lastActivity: new Date()
  };

  await this.save();
};

// NUEVO: Método para actualizar estadísticas de tokens
ProjectSchema.methods.updateTokenStats = async function() {
  const TokenUsage = mongoose.model('TokenUsage');

  // Agregar por modelo
  const stats = await TokenUsage.aggregate([
    { $match: { project: this._id } },
    {
      $group: {
        _id: '$model',
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        totalTokens: { $sum: '$totalTokens' },
        cost: { $sum: '$estimatedCost' }
      }
    }
  ]);

  // Agregar por agente
  const agentStats = await TokenUsage.aggregate([
    { $match: { project: this._id } },
    {
      $group: {
        _id: '$agentType',
        tokens: { $sum: '$totalTokens' },
        cost: { $sum: '$estimatedCost' }
      }
    }
  ]);

  // Resetear estadísticas
  this.tokenStats.totalInputTokens = 0;
  this.tokenStats.totalOutputTokens = 0;
  this.tokenStats.totalTokens = 0;
  this.tokenStats.totalCost = 0;

  this.tokenStats.byModel.opus = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0
  };
  this.tokenStats.byModel.sonnet = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0
  };

  // Actualizar el proyecto
  stats.forEach(stat => {
    this.tokenStats.totalInputTokens += stat.inputTokens;
    this.tokenStats.totalOutputTokens += stat.outputTokens;
    this.tokenStats.totalTokens += stat.totalTokens;
    this.tokenStats.totalCost += stat.cost;

    if (stat._id === 'opus') {
      this.tokenStats.byModel.opus = {
        inputTokens: stat.inputTokens,
        outputTokens: stat.outputTokens,
        totalTokens: stat.totalTokens,
        cost: stat.cost
      };
    } else if (stat._id === 'sonnet') {
      this.tokenStats.byModel.sonnet = {
        inputTokens: stat.inputTokens,
        outputTokens: stat.outputTokens,
        totalTokens: stat.totalTokens,
        cost: stat.cost
      };
    }
  });

  agentStats.forEach(stat => {
    if (this.tokenStats.byAgent[stat._id]) {
      this.tokenStats.byAgent[stat._id] = {
        tokens: stat.tokens,
        cost: stat.cost
      };
    }
  });

  this.tokenStats.lastUpdated = new Date();

  await this.save();
};

// Static methods for multi-repository projects
ProjectSchema.statics.findByOwner = function(owner) {
  return this.find({ owner });
};

ProjectSchema.statics.findActiveProjects = function() {
  return this.find({ status: { $in: ['in-progress', 'planning'] } });
};

ProjectSchema.statics.findProjectsWithRepository = function(githubUrl) {
  return this.find({ 'repositories.githubUrl': githubUrl });
};

// Pre-save middleware
ProjectSchema.pre('save', function(next) {
  // Validation logic can be added here if needed
  next();
});

module.exports = mongoose.model('Project', ProjectSchema);