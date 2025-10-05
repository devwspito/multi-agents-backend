const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const { authenticate } = require('../middleware/auth');

/**
 * @route   GET /api/agent-outputs/:taskId
 * @desc    Get all agent outputs for a specific task
 * @access  Private
 */
router.get('/:taskId', authenticate, async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Task.findById(taskId)
      .select('title description orchestration.pipeline')
      .populate('project', 'name');

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    // Format the outputs for easy reading
    const outputs = task.orchestration.pipeline.map(step => ({
      agent: step.agent,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      executionTime: step.metrics?.executionTime,
      tokensUsed: step.metrics?.tokensUsed,
      output: step.output || 'No output available'
    }));

    res.json({
      success: true,
      task: {
        id: task._id,
        title: task.title,
        description: task.description,
        project: task.project?.name
      },
      outputs,
      summary: {
        totalAgents: outputs.length,
        completed: outputs.filter(o => o.status === 'completed').length,
        totalTokens: outputs.reduce((sum, o) => sum + (o.tokensUsed || 0), 0),
        totalTime: outputs.reduce((sum, o) => sum + (o.executionTime || 0), 0)
      }
    });

  } catch (error) {
    console.error('Error fetching agent outputs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agent outputs',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/agent-outputs/:taskId/:agent
 * @desc    Get specific agent output for a task
 * @access  Private
 */
router.get('/:taskId/:agent', authenticate, async (req, res) => {
  try {
    const { taskId, agent } = req.params;

    const task = await Task.findById(taskId)
      .select('orchestration.pipeline');

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found'
      });
    }

    const agentStep = task.orchestration.pipeline.find(step => step.agent === agent);

    if (!agentStep) {
      return res.status(404).json({
        success: false,
        message: `Agent ${agent} not found in pipeline`
      });
    }

    res.json({
      success: true,
      agent: agentStep.agent,
      status: agentStep.status,
      output: agentStep.output || 'No output available',
      metrics: agentStep.metrics,
      timing: {
        startedAt: agentStep.startedAt,
        completedAt: agentStep.completedAt
      }
    });

  } catch (error) {
    console.error('Error fetching agent output:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch agent output',
      error: error.message
    });
  }
});

module.exports = router;