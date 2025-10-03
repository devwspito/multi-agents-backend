const tokenTrackingService = require('../services/TokenTrackingService');

/**
 * Middleware to check token limits before expensive operations
 */
const checkTokenLimits = (model = 'sonnet', estimatedTokens = 1000) => {
  return async (req, res, next) => {
    try {
      if (!req.user || !req.user.id) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required for token limit checking'
        });
      }

      // Check if user has enough tokens for the operation
      const limitCheck = await tokenTrackingService.checkUserLimits(
        req.user.id,
        model,
        estimatedTokens
      );

      if (!limitCheck.allowed) {
        return res.status(429).json({
          success: false,
          message: `Token limit exceeded: ${limitCheck.reason}`,
          error: 'TOKEN_LIMIT_EXCEEDED',
          details: {
            current: limitCheck.current,
            limit: limitCheck.limit,
            requested: limitCheck.requested,
            model: model
          }
        });
      }

      // Add limit info to request for logging
      req.tokenLimitInfo = limitCheck;
      next();
    } catch (error) {
      console.error('Error checking token limits:', error);
      // Don't block the request on token checking errors
      next();
    }
  };
};

/**
 * Middleware to estimate token usage based on request content
 */
const estimateTokenUsage = (req, res, next) => {
  try {
    let estimatedTokens = 1000; // Default baseline
    
    // Estimate based on task description length
    if (req.body.description) {
      estimatedTokens += Math.ceil(req.body.description.length / 4);
    }
    
    // Estimate based on instructions length
    if (req.body.instructions) {
      estimatedTokens += Math.ceil(req.body.instructions.length / 4);
    }
    
    // Add overhead for images
    if (req.file || req.files) {
      estimatedTokens += 500; // Additional tokens for image processing
    }
    
    // Add to request for use by other middleware
    req.estimatedTokens = estimatedTokens;
    next();
  } catch (error) {
    console.error('Error estimating token usage:', error);
    req.estimatedTokens = 1000; // Fallback estimate
    next();
  }
};

/**
 * Check limits for task execution (high token usage)
 */
const checkTaskExecutionLimits = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next();
    }

    // Get current usage for both models
    const opusLimits = await tokenTrackingService.checkUserLimits(req.user.id, 'opus', 0);
    const sonnetLimits = await tokenTrackingService.checkUserLimits(req.user.id, 'sonnet', 0);

    // Check if user is close to limits (80% threshold)
    const warnings = [];
    
    if (opusLimits.dailyUsage && opusLimits.dailyUsage.current / opusLimits.dailyUsage.limit > 0.8) {
      warnings.push('Approaching daily Opus token limit');
    }
    
    if (sonnetLimits.dailyUsage && sonnetLimits.dailyUsage.current / sonnetLimits.dailyUsage.limit > 0.8) {
      warnings.push('Approaching daily Sonnet token limit');
    }

    // Add warnings to response headers
    if (warnings.length > 0) {
      res.set('X-Token-Warnings', warnings.join('; '));
    }

    next();
  } catch (error) {
    console.error('Error checking task execution limits:', error);
    next();
  }
};

/**
 * Add usage info to response headers
 */
const addUsageHeaders = async (req, res, next) => {
  try {
    if (!req.user || !req.user.id) {
      return next();
    }

    // Get real-time metrics
    const metrics = await tokenTrackingService.getRealTimeMetrics(req.user.id);
    
    if (metrics.realTime) {
      res.set('X-Token-Usage-Opus', metrics.realTime.opus || 0);
      res.set('X-Token-Usage-Sonnet', metrics.realTime.sonnet || 0);
      res.set('X-Token-Cost-Today', (metrics.realTime.cost || 0).toFixed(6));
    }

    next();
  } catch (error) {
    console.error('Error adding usage headers:', error);
    next();
  }
};

module.exports = {
  checkTokenLimits,
  estimateTokenUsage,
  checkTaskExecutionLimits,
  addUsageHeaders
};