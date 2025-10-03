const mongoose = require('mongoose');

/**
 * Agent Conversation Model
 * Persists chat conversations between users and Claude Code agents
 */
const AgentConversationSchema = new mongoose.Schema({
  // Core identifiers
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
    index: true
  },
  repositoryId: {
    type: String,
    index: true // For conversations specific to a repository
  },
  agentType: {
    type: String,
    enum: [
      'product-manager',
      'project-manager', 
      'tech-lead',
      'senior-developer',
      'junior-developer',
      'qa-engineer'
    ],
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Conversation thread
  messages: [{
    id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toString()
    },
    role: {
      type: String,
      enum: ['user', 'agent'],
      required: true
    },
    content: {
      type: String,
      required: true
    },
    timestamp: {
      type: Date,
      default: Date.now
    },
    attachments: [{
      type: {
        type: String,
        enum: ['image', 'code', 'document', 'wireframe', 'design']
      },
      filename: String,
      originalName: String,
      url: String,
      size: Number,
      mimeType: String,
      metadata: mongoose.Schema.Types.Mixed
    }],
    // For structured agent responses
    structured: {
      type: {
        type: String,
        enum: ['code-generation', 'review', 'analysis', 'planning']
      },
      data: mongoose.Schema.Types.Mixed
    }
  }],

  // Claude execution context
  claudeExecution: {
    model: {
      type: String,
      default: 'claude-3-sonnet-20240229'
    },
    workspacePath: String,
    instructions: String, // Full instructions sent to Claude
    executionTime: Number, // milliseconds
    success: {
      type: Boolean,
      default: true
    },
    error: String,
    claudeSessionId: String // If Claude provides session tracking
  },

  // Execution results
  result: {
    generatedFiles: [{
      path: String,
      content: String,
      action: {
        type: String,
        enum: ['create', 'update', 'delete']
      }
    }],
    modifiedFiles: [String],
    pullRequestUrl: String,
    testResults: {
      framework: String,
      passed: Number,
      failed: Number,
      coverage: Number,
      details: mongoose.Schema.Types.Mixed
    },
    codeQuality: {
      score: Number, // 0-100
      issues: [String],
      linting: mongoose.Schema.Types.Mixed
    },
    deploymentStatus: {
      type: String,
      enum: ['pending', 'success', 'failed', 'skipped']
    },
    artifacts: [{
      type: String, // documentation, tests, configs
      path: String,
      description: String
    }]
  },

  // Conversation metadata
  status: {
    type: String,
    enum: ['active', 'completed', 'failed', 'archived'],
    default: 'active'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical'],
    default: 'medium'
  },
  tags: [String], // For categorization and search
  
  // Summary for quick reference
  summary: {
    title: String,
    description: String,
    keyDecisions: [String],
    outcomes: [String]
  },

  // Performance metrics
  metrics: {
    messageCount: {
      type: Number,
      default: 0
    },
    userMessageCount: {
      type: Number,
      default: 0
    },
    agentMessageCount: {
      type: Number,
      default: 0
    },
    totalExecutionTime: {
      type: Number,
      default: 0
    },
    averageResponseTime: Number, // milliseconds
    successRate: Number // 0-1
  },

  // Collaboration
  participants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    role: String,
    joinedAt: {
      type: Date,
      default: Date.now
    },
    permissions: {
      canView: {
        type: Boolean,
        default: true
      },
      canEdit: {
        type: Boolean,
        default: false
      },
      canExecute: {
        type: Boolean,
        default: false
      }
    }
  }],

  // Archival and retention
  archivedAt: Date,
  retentionPolicy: {
    type: String,
    enum: ['standard', 'extended', 'permanent'],
    default: 'standard'
  }

}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
AgentConversationSchema.index({ taskId: 1, agentType: 1 });
AgentConversationSchema.index({ projectId: 1, status: 1 });
AgentConversationSchema.index({ userId: 1, createdAt: -1 });
AgentConversationSchema.index({ status: 1, updatedAt: -1 });
AgentConversationSchema.index({ tags: 1 });
AgentConversationSchema.index({ 'messages.timestamp': -1 });

// Virtual for conversation duration
AgentConversationSchema.virtual('duration').get(function() {
  if (this.messages && this.messages.length > 1) {
    const firstMessage = this.messages[0];
    const lastMessage = this.messages[this.messages.length - 1];
    return new Date(lastMessage.timestamp) - new Date(firstMessage.timestamp);
  }
  return 0;
});

// Virtual for latest message
AgentConversationSchema.virtual('latestMessage').get(function() {
  if (this.messages && this.messages.length > 0) {
    return this.messages[this.messages.length - 1];
  }
  return null;
});

// Methods
AgentConversationSchema.methods.addMessage = function(role, content, attachments = [], structured = null) {
  const message = {
    role,
    content,
    timestamp: new Date(),
    attachments,
    structured
  };
  
  this.messages.push(message);
  
  // Update metrics
  this.metrics.messageCount = this.messages.length;
  this.metrics.userMessageCount = this.messages.filter(m => m.role === 'user').length;
  this.metrics.agentMessageCount = this.messages.filter(m => m.role === 'agent').length;
  
  return message;
};

AgentConversationSchema.methods.updateExecutionResult = function(executionData) {
  this.claudeExecution = {
    ...this.claudeExecution,
    ...executionData
  };
  
  if (executionData.executionTime) {
    this.metrics.totalExecutionTime += executionData.executionTime;
    this.metrics.averageResponseTime = this.metrics.totalExecutionTime / this.metrics.agentMessageCount;
  }
  
  // Update success rate
  const successfulExecutions = this.messages.filter(m => 
    m.role === 'agent' && this.claudeExecution.success
  ).length;
  this.metrics.successRate = successfulExecutions / this.metrics.agentMessageCount;
};

AgentConversationSchema.methods.archive = function() {
  this.status = 'archived';
  this.archivedAt = new Date();
};

AgentConversationSchema.methods.generateSummary = function() {
  // Basic summary generation - can be enhanced with AI later
  const userMessages = this.messages.filter(m => m.role === 'user');
  const agentMessages = this.messages.filter(m => m.role === 'agent');
  
  this.summary = {
    title: `${this.agentType} conversation for task`,
    description: `Conversation with ${userMessages.length} user messages and ${agentMessages.length} agent responses`,
    keyDecisions: [], // To be populated by AI analysis later
    outcomes: []
  };
};

// Static methods
AgentConversationSchema.statics.findByTask = function(taskId, agentType = null) {
  const query = { taskId };
  if (agentType) query.agentType = agentType;
  return this.find(query).sort({ createdAt: -1 });
};

AgentConversationSchema.statics.findActiveConversations = function(userId) {
  return this.find({ 
    userId, 
    status: 'active' 
  }).sort({ updatedAt: -1 });
};

AgentConversationSchema.statics.getConversationMetrics = function(projectId, timeRange = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - timeRange);
  
  return this.aggregate([
    {
      $match: {
        projectId: new mongoose.Types.ObjectId(projectId),
        createdAt: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$agentType',
        totalConversations: { $sum: 1 },
        totalMessages: { $sum: '$metrics.messageCount' },
        avgExecutionTime: { $avg: '$metrics.averageResponseTime' },
        successRate: { $avg: '$metrics.successRate' }
      }
    }
  ]);
};

// Pre-save middleware
AgentConversationSchema.pre('save', function(next) {
  // Update summary before saving
  if (this.isModified('messages')) {
    this.generateSummary();
  }
  next();
});

const AgentConversation = mongoose.model('AgentConversation', AgentConversationSchema);

module.exports = AgentConversation;