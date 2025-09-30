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
    enum: ['educational', 'learning-management', 'assessment', 'analytics'],
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
  team: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: {
      type: String,
      enum: ['product-manager', 'project-manager', 'senior-developer', 'junior-developer', 'qa-engineer']
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
      required: true
    },
    githubUrl: {
      type: String,
      required: true
    },
    owner: {
      type: String,
      required: true
    },
    branch: {
      type: String,
      default: 'main'
    },
    team: {
      type: String,
      enum: ['frontend', 'backend', 'mobile', 'devops', 'qa'],
      required: true
    },
    type: {
      type: String,
      enum: ['frontend', 'backend', 'mobile', 'api', 'infrastructure', 'documentation'],
      required: true
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
  // Enhanced team structure for multi-repo
  teams: [{
    name: {
      type: String,
      required: true
    },
    members: [{
      userId: { type: String },
      role: { 
        type: String, 
        enum: ['developer', 'lead', 'reviewer'],
        default: 'developer'
      },
      permissions: [{
        type: String,
        enum: ['read', 'write', 'admin', 'deploy']
      }]
    }],
    agent: {
      type: String,
      enum: ['junior-developer', 'senior-developer', 'tech-lead', 'qa-engineer'],
      default: 'senior-developer'
    },
    repositories: [{ type: String }] // Repository names assigned to this team
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
ProjectSchema.index({ 'team.user': 1 });
ProjectSchema.index({ type: 1, status: 1 });
ProjectSchema.index({ 'repositories.githubUrl': 1 });
ProjectSchema.index({ 'repositories.team': 1 });

// Virtual for completion percentage
ProjectSchema.virtual('completionPercentage').get(function() {
  if (this.stats.totalTasks === 0) return 0;
  return Math.round((this.stats.completedTasks / this.stats.totalTasks) * 100);
});

// Multi-repository methods
ProjectSchema.methods.addRepository = function(repositoryData) {
  // Validate team assignment
  const validTeams = ['frontend', 'backend', 'mobile', 'devops', 'qa'];
  if (!validTeams.includes(repositoryData.team)) {
    throw new Error(`Invalid team assignment: ${repositoryData.team}`);
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
    team: repositoryData.team,
    type: repositoryData.type || this.inferTypeFromTeam(repositoryData.team),
    technologies: repositoryData.technologies || [],
    accessToken: repositoryData.accessToken,
    installationId: repositoryData.installationId
  };

  this.repositories.push(repository);
  
  // Ensure team exists
  this.ensureTeamExists(repositoryData.team);
  
  return repository;
};

ProjectSchema.methods.removeRepository = function(repositoryId) {
  const repo = this.repositories.id(repositoryId);
  if (repo) {
    repo.remove();
  }
};

ProjectSchema.methods.getRepositoriesByTeam = function(teamName) {
  return this.repositories.filter(repo => repo.team === teamName);
};

ProjectSchema.methods.inferTypeFromTeam = function(team) {
  const typeMapping = {
    'frontend': 'frontend',
    'backend': 'backend',
    'mobile': 'mobile',
    'devops': 'infrastructure',
    'qa': 'testing'
  };
  return typeMapping[team] || 'backend';
};

ProjectSchema.methods.ensureTeamExists = function(teamName) {
  if (!this.teams.find(team => team.name === teamName)) {
    this.teams.push({
      name: teamName,
      members: [],
      agent: this.getDefaultAgentForTeam(teamName),
      repositories: []
    });
  }
};

ProjectSchema.methods.getDefaultAgentForTeam = function(teamName) {
  const agentMapping = {
    'frontend': 'senior-developer',
    'backend': 'senior-developer',
    'mobile': 'senior-developer',
    'devops': 'tech-lead',
    'qa': 'qa-engineer'
  };
  return agentMapping[teamName] || 'senior-developer';
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

// Pre-save middleware to ensure team consistency
ProjectSchema.pre('save', function(next) {
  // Ensure teams are created for each repository team
  const repoTeams = [...new Set(this.repositories.map(repo => repo.team))];
  
  repoTeams.forEach(teamName => {
    this.ensureTeamExists(teamName);
    
    // Update team's repository list
    const team = this.teams.find(t => t.name === teamName);
    if (team) {
      const teamRepos = this.repositories
        .filter(repo => repo.team === teamName)
        .map(repo => repo.name);
      team.repositories = teamRepos;
    }
  });

  next();
});

module.exports = mongoose.model('Project', ProjectSchema);