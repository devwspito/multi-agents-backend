const mongoose = require('mongoose');

const ActivitySchema = new mongoose.Schema({
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  actor: {
    type: String,
    required: true
  },
  actorType: {
    type: String,
    enum: ['user', 'agent', 'system'],
    required: true
  },
  agentType: {
    type: String,
    enum: ['product-manager', 'project-manager', 'senior-developer', 'junior-developer', 'qa-engineer']
  },
  action: {
    type: String,
    enum: [
      'created',
      'assigned',
      'started',
      'updated',
      'completed',
      'reviewed',
      'approved',
      'rejected',
      'tested',
      'deployed',
      'blocked',
      'unblocked',
      'commented',
      'merged',
      'branch-created',
      'pr-created',
      'pr-updated',
      'code-generated',
      'test-run',
      'compliance-check',
      'failed'
    ],
    required: true
  },
  description: {
    type: String,
    required: true
  },
  details: {
    // Flexible object to store action-specific data
    previousStatus: String,
    newStatus: String,
    changes: mongoose.Schema.Types.Mixed,
    codeChanges: {
      filesModified: [String],
      linesAdded: Number,
      linesRemoved: Number,
      testsAdded: Number
    },
    reviewData: {
      score: Number,
      feedback: String,
      suggestions: [String],
      complianceIssues: [String]
    },
    deploymentData: {
      environment: String,
      version: String,
      success: Boolean,
      errors: [String]
    },
    testResults: {
      unitTests: {
        passed: Number,
        failed: Number,
        coverage: Number
      },
      integrationTests: {
        passed: Number,
        failed: Number
      },
      accessibilityTests: {
        wcagScore: Number,
        violations: [String]
      }
    },
    claudeExecution: {
      model: String,
      tokens: Number,
      executionTime: Number,
      success: Boolean,
      error: String
    }
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    sessionId: String,
    correlationId: String
  },
  educational: {
    learningOutcome: String,
    studentImpact: {
      type: String,
      enum: ['low', 'medium', 'high']
    },
    complianceFlags: [{
      type: {
        type: String,
        enum: ['ferpa', 'coppa', 'gdpr', 'accessibility']
      },
      severity: {
        type: String,
        enum: ['info', 'warning', 'error']
      },
      message: String
    }]
  }
}, {
  timestamps: true
});

// Indexes for querying activities
ActivitySchema.index({ task: 1, createdAt: -1 });
ActivitySchema.index({ project: 1, createdAt: -1 });
ActivitySchema.index({ actor: 1, actorType: 1 });
ActivitySchema.index({ agentType: 1, action: 1 });
ActivitySchema.index({ action: 1, createdAt: -1 });

// Virtual for human-readable activity description
ActivitySchema.virtual('summary').get(function() {
  const actionMessages = {
    'created': `${this.actor} created the task`,
    'assigned': `${this.actor} assigned task to ${this.details.assignedTo}`,
    'started': `${this.actor} started working on the task`,
    'completed': `${this.actor} completed the task`,
    'reviewed': `${this.actor} reviewed the code`,
    'approved': `${this.actor} approved the changes`,
    'rejected': `${this.actor} rejected the changes`,
    'tested': `${this.actor} ran tests`,
    'deployed': `${this.actor} deployed to ${this.details.deploymentData?.environment}`,
    'code-generated': `${this.actor} generated ${this.details.codeChanges?.linesAdded} lines of code`,
    'pr-created': `${this.actor} created pull request`,
    'merged': `${this.actor} merged the pull request`
  };
  
  return actionMessages[this.action] || `${this.actor} performed ${this.action}`;
});

// Static method to log activity
ActivitySchema.statics.logActivity = async function(activityData) {
  try {
    const activity = new this(activityData);
    await activity.save();
    return activity;
  } catch (error) {
    console.error('Error logging activity:', error);
    throw error;
  }
};

// Static method to get task timeline
ActivitySchema.statics.getTaskTimeline = async function(taskId) {
  return this.find({ task: taskId })
    .sort({ createdAt: 1 })
    .populate('task', 'title status')
    .lean();
};

// Static method to get agent performance metrics
ActivitySchema.statics.getAgentMetrics = async function(agentType, startDate, endDate) {
  const pipeline = [
    {
      $match: {
        agentType: agentType,
        createdAt: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: '$action',
        count: { $sum: 1 },
        avgExecutionTime: { $avg: '$details.claudeExecution.executionTime' },
        successRate: {
          $avg: {
            $cond: ['$details.claudeExecution.success', 1, 0]
          }
        }
      }
    }
  ];
  
  return this.aggregate(pipeline);
};

module.exports = mongoose.model('Activity', ActivitySchema);