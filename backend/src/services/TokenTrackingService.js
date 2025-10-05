const TokenUsage = require('../models/TokenUsage');

/**
 * Token Tracking Service
 * Centralizes token usage tracking and cost management for Claude models
 */
class TokenTrackingService {
  constructor() {
    // Cache for real-time usage tracking
    this.usageCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
    
    // Daily limits (configurable per user)
    this.defaultLimits = {
      free: {
        opus: { daily: 100000, monthly: 1000000 },  // Increased 10x for development/testing
        sonnet: { daily: 500000, monthly: 5000000 }  // Increased 10x
      },
      premium: {
        opus: { daily: 1000000, monthly: 10000000 },
        sonnet: { daily: 5000000, monthly: 50000000 }
      },
      enterprise: {
        opus: { daily: 10000000, monthly: 100000000 },
        sonnet: { daily: 50000000, monthly: 500000000 }
      }
    };

    console.log('🎯 Token Tracking Service initialized');
  }

  /**
   * Record token usage for an agent execution
   */
  async recordAgentUsage(params) {
    const {
      userId,
      taskId,
      projectId,
      agentType,
      model,
      inputTokens,
      outputTokens,
      requestType = 'orchestration',
      responseTime,
      success = true,
      errorMessage
    } = params;

    try {
      // Validate required parameters
      if (!userId || !agentType || !model || inputTokens === undefined || outputTokens === undefined) {
        throw new Error('Missing required parameters for token tracking');
      }

      // Record usage in database
      const usage = await TokenUsage.recordUsage({
        userId,
        taskId,
        projectId,
        agentType,
        model,
        inputTokens,
        outputTokens,
        requestType,
        responseTime,
        success,
        errorMessage
      });

      // Update cache
      this.updateUsageCache(userId, model, inputTokens + outputTokens, usage.estimatedCost);

      // Log usage for monitoring
      console.log(`🎯 Token usage recorded: ${agentType} (${model}) - ${inputTokens + outputTokens} tokens - $${usage.estimatedCost.toFixed(6)}`);

      return usage;
    } catch (error) {
      console.error('Error recording token usage:', error);
      throw error;
    }
  }

  /**
   * Check if user has exceeded their limits
   */
  async checkUserLimits(userId, model, requestedTokens = 0) {
    try {
      // Get user's tier (default to free)
      const userTier = await this.getUserTier(userId);
      const limits = this.defaultLimits[userTier] || this.defaultLimits.free;
      const modelLimits = limits[model];

      if (!modelLimits) {
        return { allowed: false, reason: `Unknown model: ${model}` };
      }

      // Check daily usage
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const dailyUsage = await TokenUsage.aggregate([
        {
          $match: {
            user: userId,
            model: model,
            timestamp: { $gte: today },
            success: true
          }
        },
        {
          $group: {
            _id: null,
            totalTokens: { $sum: '$totalTokens' }
          }
        }
      ]);

      const currentDailyTokens = dailyUsage[0]?.totalTokens || 0;
      const projectedDaily = currentDailyTokens + requestedTokens;

      if (projectedDaily > modelLimits.daily) {
        return {
          allowed: false,
          reason: 'Daily limit exceeded',
          current: currentDailyTokens,
          limit: modelLimits.daily,
          requested: requestedTokens
        };
      }

      // Check monthly usage
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const monthlyUsage = await TokenUsage.aggregate([
        {
          $match: {
            user: userId,
            model: model,
            timestamp: { $gte: monthStart },
            success: true
          }
        },
        {
          $group: {
            _id: null,
            totalTokens: { $sum: '$totalTokens' }
          }
        }
      ]);

      const currentMonthlyTokens = monthlyUsage[0]?.totalTokens || 0;
      const projectedMonthly = currentMonthlyTokens + requestedTokens;

      if (projectedMonthly > modelLimits.monthly) {
        return {
          allowed: false,
          reason: 'Monthly limit exceeded',
          current: currentMonthlyTokens,
          limit: modelLimits.monthly,
          requested: requestedTokens
        };
      }

      return {
        allowed: true,
        dailyUsage: {
          current: currentDailyTokens,
          limit: modelLimits.daily,
          remaining: modelLimits.daily - currentDailyTokens
        },
        monthlyUsage: {
          current: currentMonthlyTokens,
          limit: modelLimits.monthly,
          remaining: modelLimits.monthly - currentMonthlyTokens
        }
      };

    } catch (error) {
      console.error('Error checking user limits:', error);
      return { allowed: false, reason: 'Error checking limits' };
    }
  }

  /**
   * Get comprehensive usage analytics for a user
   */
  async getUserAnalytics(userId, days = 30) {
    try {
      // Get usage summary
      const summary = await TokenUsage.getUserUsageSummary(userId, days);
      
      // Get daily trends
      const trends = await TokenUsage.getDailyUsageTrends(userId, days);
      
      // Get current limits status
      const limitsStatus = await this.getCurrentLimitsStatus(userId);
      
      // Calculate efficiency metrics
      const efficiency = await this.calculateEfficiencyMetrics(userId, days);

      return {
        summary,
        trends,
        limitsStatus,
        efficiency,
        period: `${days} days`
      };
    } catch (error) {
      console.error('Error getting user analytics:', error);
      throw error;
    }
  }

  /**
   * Get real-time usage metrics
   */
  async getRealTimeMetrics(userId) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayUsage = await TokenUsage.aggregate([
        {
          $match: {
            user: userId,
            timestamp: { $gte: today },
            success: true
          }
        },
        {
          $group: {
            _id: {
              model: '$model',
              agentType: '$agentType'
            },
            tokens: { $sum: '$totalTokens' },
            cost: { $sum: '$estimatedCost' },
            requests: { $sum: 1 }
          }
        }
      ]);

      // Get cached data
      const cacheKey = `user_${userId}`;
      const cached = this.usageCache.get(cacheKey) || { opus: 0, sonnet: 0, cost: 0 };

      return {
        today: todayUsage,
        realTime: cached,
        timestamp: new Date()
      };
    } catch (error) {
      console.error('Error getting real-time metrics:', error);
      throw error;
    }
  }

  /**
   * Update usage cache for real-time tracking
   */
  updateUsageCache(userId, model, tokens, cost) {
    const cacheKey = `user_${userId}`;
    const cached = this.usageCache.get(cacheKey) || { opus: 0, sonnet: 0, cost: 0, timestamp: Date.now() };
    
    cached[model] = (cached[model] || 0) + tokens;
    cached.cost = (cached.cost || 0) + cost;
    cached.timestamp = Date.now();
    
    this.usageCache.set(cacheKey, cached);
    
    // Clean expired cache entries
    this.cleanExpiredCache();
  }

  /**
   * Clean expired cache entries
   */
  cleanExpiredCache() {
    const now = Date.now();
    for (const [key, value] of this.usageCache.entries()) {
      if (now - value.timestamp > this.cacheExpiry) {
        this.usageCache.delete(key);
      }
    }
  }

  /**
   * Get user tier (free, premium, enterprise)
   */
  async getUserTier(userId) {
    // TODO: Implement user tier logic based on subscription
    // For now, return 'free' as default
    return 'free';
  }

  /**
   * Get current limits status for all models
   */
  async getCurrentLimitsStatus(userId) {
    const opusStatus = await this.checkUserLimits(userId, 'opus');
    const sonnetStatus = await this.checkUserLimits(userId, 'sonnet');
    
    return {
      opus: opusStatus,
      sonnet: sonnetStatus
    };
  }

  /**
   * Calculate efficiency metrics
   */
  async calculateEfficiencyMetrics(userId, days = 30) {
    try {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);

      const metrics = await TokenUsage.aggregate([
        {
          $match: {
            user: userId,
            timestamp: { $gte: startDate },
            success: true
          }
        },
        {
          $group: {
            _id: '$agentType',
            avgTokensPerRequest: { $avg: '$totalTokens' },
            avgCostPerRequest: { $avg: '$estimatedCost' },
            avgResponseTime: { $avg: '$responseTime' },
            totalRequests: { $sum: 1 },
            successRate: { $avg: { $cond: ['$success', 1, 0] } }
          }
        }
      ]);

      return metrics;
    } catch (error) {
      console.error('Error calculating efficiency metrics:', error);
      return [];
    }
  }

  /**
   * Export usage data for billing/reporting
   */
  async exportUsageData(userId, startDate, endDate, format = 'json') {
    try {
      const usage = await TokenUsage.find({
        user: userId,
        timestamp: { $gte: startDate, $lte: endDate }
      }).sort({ timestamp: -1 });

      if (format === 'csv') {
        return this.convertToCSV(usage);
      }

      return usage;
    } catch (error) {
      console.error('Error exporting usage data:', error);
      throw error;
    }
  }

  /**
   * Convert usage data to CSV format
   */
  convertToCSV(usage) {
    const headers = [
      'timestamp', 'agentType', 'model', 'inputTokens', 
      'outputTokens', 'totalTokens', 'estimatedCost', 
      'requestType', 'responseTime', 'success'
    ];
    
    const csvData = [headers.join(',')];
    
    usage.forEach(record => {
      const row = [
        record.timestamp.toISOString(),
        record.agentType,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.estimatedCost,
        record.requestType,
        record.responseTime || 0,
        record.success
      ];
      csvData.push(row.join(','));
    });
    
    return csvData.join('\n');
  }
}

module.exports = new TokenTrackingService();