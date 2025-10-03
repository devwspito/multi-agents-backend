const mongoose = require('mongoose');

/**
 * Token Usage Model
 * Tracks token consumption for both Claude models (Opus and Sonnet)
 */
const TokenUsageSchema = new mongoose.Schema({
  // User identification
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Task/Project association
  task: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    index: true
  },
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    index: true
  },

  // Agent information
  agentType: {
    type: String,
    enum: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer'],
    required: true,
    index: true
  },

  // Model usage
  model: {
    type: String,
    enum: ['opus', 'sonnet'],
    required: true,
    index: true
  },

  // Token metrics
  inputTokens: {
    type: Number,
    required: true,
    min: 0
  },
  outputTokens: {
    type: Number,
    required: true,
    min: 0
  },
  totalTokens: {
    type: Number,
    required: true,
    min: 0
  },

  // Cost calculation (in USD)
  estimatedCost: {
    type: Number,
    required: true,
    min: 0
  },

  // Request details
  requestType: {
    type: String,
    enum: ['orchestration', 'conversation', 'execution'],
    required: true
  },

  // Response metadata
  responseTime: {
    type: Number, // milliseconds
    min: 0
  },
  success: {
    type: Boolean,
    default: true
  },
  errorMessage: String,

  // NUEVO: Metadata de ejecución de orquestación
  orchestrationWorkflowId: {
    type: String,
    index: true
  },
  agentStage: {
    type: Number, // 1-6 (posición del agente en la orquestación)
    min: 1,
    max: 6
  },
  duration: {
    type: Number, // Milisegundos de duración de la ejecución
    min: 0
  },

  // NUEVO: Contexto adicional
  operationType: {
    type: String,
    enum: ['analysis', 'planning', 'design', 'implementation', 'testing', 'review'],
    index: true
  },
  repository: {
    type: String // Nombre del repositorio donde se trabajó
  },

  // NUEVO: Artefactos generados durante la ejecución
  artifacts: [{
    type: {
      type: String,
      enum: ['file', 'pull_request', 'issue', 'document', 'test']
    },
    name: String,
    url: String,
    linesAdded: Number,
    linesRemoved: Number
  }],

  // NUEVO: Timestamps detallados
  startedAt: {
    type: Date,
    index: true
  },
  completedAt: {
    type: Date
  },

  // Timestamps
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
TokenUsageSchema.index({ user: 1, timestamp: -1 });
TokenUsageSchema.index({ model: 1, timestamp: -1 });
TokenUsageSchema.index({ agentType: 1, model: 1 });
TokenUsageSchema.index({ 'timestamp': 1 }, { expireAfterSeconds: 7776000 }); // 90 days TTL

// NUEVO: Índices compuestos para queries granulares
TokenUsageSchema.index({ user: 1, project: 1 });
TokenUsageSchema.index({ project: 1, task: 1 });
TokenUsageSchema.index({ task: 1, agentType: 1 });
TokenUsageSchema.index({ user: 1, createdAt: -1 });
TokenUsageSchema.index({ project: 1, createdAt: -1 });
TokenUsageSchema.index({ orchestrationWorkflowId: 1, agentStage: 1 });

// Virtual for daily usage
TokenUsageSchema.virtual('dailyUsage').get(function() {
  return {
    date: this.timestamp.toISOString().split('T')[0],
    tokens: this.totalTokens,
    cost: this.estimatedCost
  };
});

/**
 * Static method to get user usage summary
 */
TokenUsageSchema.statics.getUserUsageSummary = async function(userId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const summary = await this.aggregate([
    {
      $match: {
        user: mongoose.Types.ObjectId(userId),
        timestamp: { $gte: startDate },
        success: true
      }
    },
    {
      $group: {
        _id: {
          model: '$model',
          agentType: '$agentType'
        },
        totalTokens: { $sum: '$totalTokens' },
        totalCost: { $sum: '$estimatedCost' },
        requestCount: { $sum: 1 },
        avgResponseTime: { $avg: '$responseTime' }
      }
    },
    {
      $group: {
        _id: '$_id.model',
        agents: {
          $push: {
            agentType: '$_id.agentType',
            totalTokens: '$totalTokens',
            totalCost: '$totalCost',
            requestCount: '$requestCount',
            avgResponseTime: '$avgResponseTime'
          }
        },
        modelTotalTokens: { $sum: '$totalTokens' },
        modelTotalCost: { $sum: '$totalCost' }
      }
    }
  ]);

  return summary;
};

/**
 * Static method to get daily usage trends
 */
TokenUsageSchema.statics.getDailyUsageTrends = async function(userId, days = 7) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const trends = await this.aggregate([
    {
      $match: {
        user: mongoose.Types.ObjectId(userId),
        timestamp: { $gte: startDate },
        success: true
      }
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          model: '$model'
        },
        dailyTokens: { $sum: '$totalTokens' },
        dailyCost: { $sum: '$estimatedCost' },
        requestCount: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.date': 1 }
    }
  ]);

  return trends;
};

/**
 * Static method to record token usage
 */
TokenUsageSchema.statics.recordUsage = async function(usageData) {
  const {
    userId,
    taskId,
    projectId,
    agentType,
    model,
    inputTokens,
    outputTokens,
    requestType,
    responseTime,
    success = true,
    errorMessage
  } = usageData;

  // Calculate total tokens
  const totalTokens = inputTokens + outputTokens;

  // Calculate estimated cost based on Claude pricing
  const estimatedCost = calculateTokenCost(model, inputTokens, outputTokens);

  const usage = new this({
    user: userId,
    task: taskId,
    project: projectId,
    agentType,
    model,
    inputTokens,
    outputTokens,
    totalTokens,
    estimatedCost,
    requestType,
    responseTime,
    success,
    errorMessage
  });

  return await usage.save();
};

/**
 * Calculate token cost based on current Claude pricing
 */
function calculateTokenCost(model, inputTokens, outputTokens) {
  // Claude pricing (as of 2024) - adjust as needed
  const pricing = {
    opus: {
      input: 0.000015,  // $15 per million input tokens
      output: 0.000075  // $75 per million output tokens
    },
    sonnet: {
      input: 0.000003,  // $3 per million input tokens
      output: 0.000015  // $15 per million output tokens
    }
  };

  const modelPricing = pricing[model];
  if (!modelPricing) {
    console.warn(`Unknown model for pricing: ${model}`);
    return 0;
  }

  const inputCost = (inputTokens / 1000000) * modelPricing.input;
  const outputCost = (outputTokens / 1000000) * modelPricing.output;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

module.exports = mongoose.model('TokenUsage', TokenUsageSchema);