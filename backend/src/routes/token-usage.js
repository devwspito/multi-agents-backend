const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const tokenTrackingService = require('../services/TokenTrackingService');
const TokenUsage = require('../models/TokenUsage');
const Task = require('../models/Task');
const Project = require('../models/Project');

/**
 * @route   GET /api/token-usage/analytics
 * @desc    Get comprehensive token usage analytics for the authenticated user
 * @access  Private
 */
router.get('/analytics', authenticate, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    
    const analytics = await tokenTrackingService.getUserAnalytics(
      req.user.id, 
      parseInt(days)
    );
    
    res.json({
      success: true,
      data: analytics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch token usage analytics',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/realtime
 * @desc    Get real-time token usage metrics
 * @access  Private
 */
router.get('/realtime', authenticate, async (req, res) => {
  try {
    const metrics = await tokenTrackingService.getRealTimeMetrics(req.user.id);
    
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch real-time metrics',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/limits
 * @desc    Check current usage limits and status
 * @access  Private
 */
router.get('/limits', authenticate, async (req, res) => {
  try {
    const { model } = req.query;
    
    if (model) {
      // Check specific model limits
      const limitStatus = await tokenTrackingService.checkUserLimits(req.user.id, model);
      res.json({
        success: true,
        data: { [model]: limitStatus }
      });
    } else {
      // Check all model limits
      const limitsStatus = await tokenTrackingService.getCurrentLimitsStatus(req.user.id);
      res.json({
        success: true,
        data: limitsStatus
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to check usage limits',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/summary
 * @desc    Get usage summary by model and agent
 * @access  Private
 */
router.get('/summary', authenticate, async (req, res) => {
  try {
    const { days = 7, model, agentType } = req.query;
    
    const matchConditions = {
      user: req.user.id,
      timestamp: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
      success: true
    };
    
    if (model) matchConditions.model = model;
    if (agentType) matchConditions.agentType = agentType;
    
    const summary = await TokenUsage.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: {
            model: '$model',
            agentType: '$agentType',
            date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
          },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' },
          requestCount: { $sum: 1 },
          avgResponseTime: { $avg: '$responseTime' }
        }
      },
      {
        $group: {
          _id: {
            model: '$_id.model',
            agentType: '$_id.agentType'
          },
          dailyUsage: {
            $push: {
              date: '$_id.date',
              tokens: '$totalTokens',
              cost: '$totalCost',
              requests: '$requestCount',
              avgResponseTime: '$avgResponseTime'
            }
          },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$totalCost' },
          totalRequests: { $sum: '$requestCount' },
          avgResponseTime: { $avg: '$avgResponseTime' }
        }
      },
      { $sort: { '_id.model': 1, '_id.agentType': 1 } }
    ]);
    
    res.json({
      success: true,
      data: summary,
      period: `${days} days`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch usage summary',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/trends
 * @desc    Get usage trends over time
 * @access  Private
 */
router.get('/trends', authenticate, async (req, res) => {
  try {
    const { days = 14 } = req.query;
    
    const trends = await TokenUsage.getDailyUsageTrends(req.user.id, parseInt(days));
    
    res.json({
      success: true,
      data: trends
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch usage trends',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/export
 * @desc    Export detailed usage data
 * @access  Private
 */
router.get('/export', authenticate, async (req, res) => {
  try {
    const { 
      startDate, 
      endDate, 
      format = 'json',
      model,
      agentType
    } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'Start date and end date are required'
      });
    }
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date format'
      });
    }
    
    // Build query conditions
    const conditions = {
      user: req.user.id,
      timestamp: { $gte: start, $lte: end }
    };
    
    if (model) conditions.model = model;
    if (agentType) conditions.agentType = agentType;
    
    const usage = await TokenUsage.find(conditions)
      .sort({ timestamp: -1 })
      .limit(10000); // Limit to prevent huge exports
    
    if (format === 'csv') {
      const csvData = tokenTrackingService.convertToCSV(usage);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=token-usage-${start.toISOString().split('T')[0]}-to-${end.toISOString().split('T')[0]}.csv`);
      res.send(csvData);
    } else {
      res.json({
        success: true,
        data: usage,
        count: usage.length,
        period: {
          start: start.toISOString(),
          end: end.toISOString()
        }
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to export usage data',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/cost-breakdown
 * @desc    Get cost breakdown by model and time period
 * @access  Private
 */
router.get('/cost-breakdown', authenticate, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    
    const breakdown = await TokenUsage.aggregate([
      {
        $match: {
          user: req.user.id,
          timestamp: { $gte: startDate },
          success: true
        }
      },
      {
        $group: {
          _id: {
            model: '$model',
            week: { $week: '$timestamp' },
            year: { $year: '$timestamp' }
          },
          totalCost: { $sum: '$estimatedCost' },
          totalTokens: { $sum: '$totalTokens' },
          requestCount: { $sum: 1 },
          avgCostPerRequest: { $avg: '$estimatedCost' }
        }
      },
      {
        $group: {
          _id: '$_id.model',
          weeklyBreakdown: {
            $push: {
              week: '$_id.week',
              year: '$_id.year',
              cost: '$totalCost',
              tokens: '$totalTokens',
              requests: '$requestCount',
              avgCostPerRequest: '$avgCostPerRequest'
            }
          },
          totalCost: { $sum: '$totalCost' },
          totalTokens: { $sum: '$totalTokens' },
          totalRequests: { $sum: '$requestCount' }
        }
      },
      { $sort: { '_id': 1 } }
    ]);
    
    res.json({
      success: true,
      data: breakdown,
      period: `${days} days`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch cost breakdown',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/token-usage/estimate
 * @desc    Estimate token usage for a given input
 * @access  Private
 */
router.post('/estimate', authenticate, async (req, res) => {
  try {
    const { text, model = 'sonnet' } = req.body;
    
    if (!text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required for estimation'
      });
    }
    
    // Rough token estimation (1 token ≈ 4 characters)
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const estimatedOutputTokens = Math.ceil(estimatedInputTokens * 0.3); // Assume response is 30% of input
    const totalTokens = estimatedInputTokens + estimatedOutputTokens;
    
    // Calculate estimated cost
    const pricing = {
      opus: { input: 0.000015, output: 0.000075 },
      sonnet: { input: 0.000003, output: 0.000015 }
    };
    
    const modelPricing = pricing[model] || pricing.sonnet;
    const estimatedCost = 
      (estimatedInputTokens / 1000000) * modelPricing.input +
      (estimatedOutputTokens / 1000000) * modelPricing.output;
    
    res.json({
      success: true,
      data: {
        model,
        estimatedInputTokens,
        estimatedOutputTokens,
        totalTokens,
        estimatedCost: parseFloat(estimatedCost.toFixed(6)),
        inputLength: text.length
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to estimate token usage',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/token-usage/project/:projectId
 * @desc    Get detailed token usage for a specific project
 * @access  Private (project owner/collaborators)
 */
router.get('/project/:projectId', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { timeRange = '30', groupBy = 'agent' } = req.query;

    // Verify project access
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check if user has access to this project
    const hasAccess = project.owner.toString() === req.user.id ||
      project.collaborators.some(c => c.user.toString() === req.user.id);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this project'
      });
    }

    // Calculate date range
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(timeRange));

    // Get token usage records
    const tokenRecords = await TokenUsage.find({
      project: projectId,
      timestamp: { $gte: startDate }
    }).sort({ timestamp: -1 });

    // Aggregate by model
    const byModel = await TokenUsage.aggregate([
      {
        $match: {
          project: project._id,
          timestamp: { $gte: startDate },
          success: true
        }
      },
      {
        $group: {
          _id: '$model',
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          requestCount: { $sum: 1 }
        }
      }
    ]);

    // Aggregate by agent
    const byAgent = await TokenUsage.aggregate([
      {
        $match: {
          project: project._id,
          timestamp: { $gte: startDate },
          success: true
        }
      },
      {
        $group: {
          _id: '$agentType',
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          requestCount: { $sum: 1 },
          avgDuration: { $avg: '$duration' }
        }
      },
      {
        $sort: { totalCost: -1 }
      }
    ]);

    // Daily trends
    const dailyTrends = await TokenUsage.aggregate([
      {
        $match: {
          project: project._id,
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
          tokens: { $sum: '$totalTokens' },
          cost: { $sum: '$estimatedCost' },
          requests: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.date': 1 }
      }
    ]);

    // Tasks with most token usage
    const topTasks = await TokenUsage.aggregate([
      {
        $match: {
          project: project._id,
          timestamp: { $gte: startDate },
          success: true
        }
      },
      {
        $group: {
          _id: '$task',
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' }
        }
      },
      {
        $sort: { totalCost: -1 }
      },
      {
        $limit: 10
      }
    ]);

    // Populate task details
    const taskIds = topTasks.map(t => t._id).filter(id => id);
    const tasks = await Task.find({ _id: { $in: taskIds } }).select('title description status');
    const taskMap = {};
    tasks.forEach(t => {
      taskMap[t._id.toString()] = t;
    });

    const topTasksWithDetails = topTasks.map(t => ({
      taskId: t._id,
      title: t._id ? taskMap[t._id.toString()]?.title : 'N/A',
      totalTokens: t.totalTokens,
      totalCost: t.totalCost
    }));

    res.json({
      success: true,
      data: {
        project: {
          id: project._id,
          name: project.name,
          tokenStats: project.tokenStats
        },
        summary: {
          totalTokens: project.tokenStats.totalTokens,
          totalCost: project.tokenStats.totalCost,
          timeRange: `Last ${timeRange} days`,
          recordCount: tokenRecords.length
        },
        byModel,
        byAgent,
        dailyTrends,
        topTasks: topTasksWithDetails,
        recentRecords: tokenRecords.slice(0, 20).map(r => ({
          timestamp: r.timestamp,
          agent: r.agentType,
          model: r.model,
          tokens: r.totalTokens,
          cost: r.estimatedCost,
          duration: r.duration,
          operationType: r.operationType
        }))
      }
    });

  } catch (error) {
    console.error('Get project token usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving token usage'
    });
  }
});

/**
 * @route   GET /api/token-usage/task/:taskId
 * @desc    Get detailed token usage for a specific task
 * @access  Private
 */
router.get('/task/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;

    // Get task and verify access
    const task = await Task.findById(taskId).populate('project');
    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Check if user has access
    const project = task.project;
    const hasAccess = project.owner.toString() === req.user.id ||
      project.collaborators.some(c => c.user.toString() === req.user.id);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this task'
      });
    }

    // Get all token usage records for this task
    const tokenRecords = await TokenUsage.find({
      task: taskId
    }).sort({ timestamp: 1 });

    // Get orchestration workflow details
    const workflowRecords = await TokenUsage.aggregate([
      {
        $match: {
          task: task._id,
          orchestrationWorkflowId: { $exists: true }
        }
      },
      {
        $group: {
          _id: '$orchestrationWorkflowId',
          agents: {
            $push: {
              agent: '$agentType',
              stage: '$agentStage',
              model: '$model',
              tokens: '$totalTokens',
              cost: '$estimatedCost',
              duration: '$duration',
              startedAt: '$startedAt',
              completedAt: '$completedAt',
              operationType: '$operationType',
              artifacts: '$artifacts'
            }
          },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' },
          totalDuration: { $sum: '$duration' }
        }
      }
    ]);

    // Aggregate by agent for this task
    const byAgent = await TokenUsage.aggregate([
      {
        $match: {
          task: task._id,
          success: true
        }
      },
      {
        $group: {
          _id: {
            agent: '$agentType',
            model: '$model'
          },
          totalTokens: { $sum: '$totalTokens' },
          totalCost: { $sum: '$estimatedCost' },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
          avgDuration: { $avg: '$duration' },
          executions: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.agent': 1 }
      }
    ]);

    res.json({
      success: true,
      data: {
        task: {
          id: task._id,
          title: task.title,
          description: task.description,
          status: task.status,
          tokenStats: task.tokenStats
        },
        summary: {
          totalTokens: task.tokenStats.totalTokens,
          totalCost: task.tokenStats.totalCost,
          agentsExecuted: task.tokenStats.byAgent.length,
          recordCount: tokenRecords.length
        },
        orchestrationWorkflows: workflowRecords,
        byAgent: byAgent.map(a => ({
          agent: a._id.agent,
          model: a._id.model,
          totalTokens: a.totalTokens,
          totalCost: a.totalCost,
          inputTokens: a.inputTokens,
          outputTokens: a.outputTokens,
          avgDuration: Math.round(a.avgDuration),
          executions: a.executions
        })),
        timeline: tokenRecords.map(r => ({
          timestamp: r.timestamp,
          agent: r.agentType,
          model: r.model,
          tokens: r.totalTokens,
          cost: r.estimatedCost,
          duration: r.duration,
          operationType: r.operationType,
          repository: r.repository,
          success: r.success
        }))
      }
    });

  } catch (error) {
    console.error('Get task token usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error retrieving token usage'
    });
  }
});

/**
 * @route   GET /api/token-usage/export/project/:projectId
 * @desc    Export project token usage as CSV
 * @access  Private (project owner/collaborators)
 */
router.get('/export/project/:projectId', authenticate, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { startDate, endDate } = req.query;

    // Verify project access
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const hasAccess = project.owner.toString() === req.user.id ||
      project.collaborators.some(c => c.user.toString() === req.user.id);

    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this project'
      });
    }

    // Build date filter
    const dateFilter = { project: projectId };
    if (startDate) {
      dateFilter.timestamp = { $gte: new Date(startDate) };
    }
    if (endDate) {
      dateFilter.timestamp = { ...dateFilter.timestamp, $lte: new Date(endDate) };
    }

    // Get all records
    const records = await TokenUsage.find(dateFilter)
      .populate('task', 'title description')
      .sort({ timestamp: -1 });

    // Generate CSV
    const csvHeader = 'Timestamp,Task,Agent,Model,Input Tokens,Output Tokens,Total Tokens,Cost (USD),Duration (ms),Operation Type,Repository,Success,Error\n';

    const csvRows = records.map(r => {
      const taskTitle = r.task?.title || 'N/A';
      const errorMsg = r.errorMessage ? r.errorMessage.replace(/,/g, ';') : '';

      return [
        r.timestamp.toISOString(),
        `"${taskTitle.replace(/"/g, '""')}"`,
        r.agentType,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.totalTokens,
        r.estimatedCost.toFixed(6),
        r.duration || 0,
        r.operationType || 'N/A',
        r.repository || 'N/A',
        r.success ? 'Yes' : 'No',
        `"${errorMsg}"`
      ].join(',');
    }).join('\n');

    const csv = csvHeader + csvRows;

    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="token-usage-${project.name}-${Date.now()}.csv"`);
    res.send(csv);

  } catch (error) {
    console.error('Export token usage error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error exporting token usage'
    });
  }
});

module.exports = router;