const express = require('express');
const router = express.Router();
const { authenticate, protectData } = require('../middleware/auth');
const claudeIntegrationService = require('../services/ClaudeIntegrationService');
const aiRecommendationService = require('../services/AIRecommendationService');

// Store for execution tracking
const executions = new Map();
const executionLogs = new Map();

/**
 * Execute Claude Code agent
 */
router.post('/execute', authenticate, protectData, async (req, res) => {
  try {
    const {
      agentType,
      instructions,
      taskId,
      projectId,
      repositoryId,
      workspacePath
    } = req.body;

    // Validate required fields
    if (!agentType || !instructions) {
      return res.status(400).json({
        success: false,
        message: 'agentType and instructions are required',
        field: !agentType ? 'agentType' : 'instructions'
      });
    }

    // Validate agent type
    const validAgentTypes = [
      'product-manager',
      'project-manager',
      'tech-lead',
      'senior-developer',
      'junior-developer',
      'qa-engineer'
    ];

    if (!validAgentTypes.includes(agentType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid agent type',
        code: 'INVALID_AGENT_TYPE',
        field: 'agentType',
        details: `Valid types: ${validAgentTypes.join(', ')}`
      });
    }

    // Generate execution ID
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Initialize execution tracking
    executions.set(executionId, {
      executionId,
      agentType,
      status: 'queued',
      createdAt: new Date().toISOString(),
      userId: req.user._id,
      progress: 0
    });

    executionLogs.set(executionId, [
      `Execution ${executionId} created`,
      `Agent type: ${agentType}`,
      `Instructions: ${instructions.substring(0, 100)}...`,
      'Execution queued for processing'
    ]);

    // Start execution asynchronously
    setImmediate(async () => {
      try {
        // Update status to running
        const execution = executions.get(executionId);
        execution.status = 'running';
        execution.startedAt = new Date().toISOString();
        execution.progress = 10;
        
        const logs = executionLogs.get(executionId);
        logs.push('Starting agent execution...');
        logs.push('Analyzing instructions...');

        // Simulate Claude Code execution with realistic steps
        await simulateClaudeExecution(executionId, agentType, instructions, {
          taskId,
          projectId,
          repositoryId,
          workspacePath: workspacePath || '/tmp/workspace',
          userId: req.user._id
        });

      } catch (error) {
        console.error('Error in agent execution:', error);
        
        const execution = executions.get(executionId);
        if (execution) {
          execution.status = 'failed';
          execution.error = error.message;
          execution.completedAt = new Date().toISOString();
        }

        const logs = executionLogs.get(executionId);
        if (logs) {
          logs.push(`Error: ${error.message}`);
          logs.push('Execution failed');
        }
      }
    });

    res.status(201).json({
      success: true,
      data: {
        executionId,
        agentType,
        status: 'queued'
      }
    });

  } catch (error) {
    console.error('Error starting agent execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start agent execution',
      code: 'EXECUTION_START_ERROR'
    });
  }
});

/**
 * Get execution status
 */
router.get('/executions/:executionId', authenticate, async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = executions.get(executionId);

    if (!execution) {
      return res.status(404).json({
        success: false,
        message: 'Execution not found',
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    // Check if user has access to this execution
    if (execution.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this execution',
        code: 'ACCESS_DENIED'
      });
    }

    res.json({
      success: true,
      data: {
        executionId: execution.executionId,
        status: execution.status,
        progress: execution.progress,
        result: execution.result || null,
        error: execution.error || null,
        createdAt: execution.createdAt,
        startedAt: execution.startedAt || null,
        completedAt: execution.completedAt || null
      }
    });

  } catch (error) {
    console.error('Error getting execution status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get execution status',
      code: 'EXECUTION_STATUS_ERROR'
    });
  }
});

/**
 * Get execution logs
 */
router.get('/executions/:executionId/logs', authenticate, async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = executions.get(executionId);

    if (!execution) {
      return res.status(404).json({
        success: false,
        message: 'Execution not found',
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    // Check if user has access to this execution
    if (execution.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this execution',
        code: 'ACCESS_DENIED'
      });
    }

    const logs = executionLogs.get(executionId) || [];

    res.json({
      success: true,
      data: {
        logs
      }
    });

  } catch (error) {
    console.error('Error getting execution logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get execution logs',
      code: 'EXECUTION_LOGS_ERROR'
    });
  }
});

/**
 * Stream execution logs via SSE
 */
router.get('/executions/:executionId/logs/stream', authenticate, async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = executions.get(executionId);

    if (!execution) {
      return res.status(404).json({
        success: false,
        message: 'Execution not found',
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    // Check if user has access to this execution
    if (execution.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this execution',
        code: 'ACCESS_DENIED'
      });
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial logs
    const logs = executionLogs.get(executionId) || [];
    logs.forEach((log, index) => {
      res.write(`data: ${JSON.stringify({ type: 'log', content: log, index })}\n\n`);
    });

    // Send current execution status
    res.write(`data: ${JSON.stringify({ 
      type: 'status', 
      status: execution.status, 
      progress: execution.progress 
    })}\n\n`);

    let lastLogCount = logs.length;

    // Set up periodic check for new logs
    const checkForUpdates = setInterval(() => {
      const currentLogs = executionLogs.get(executionId) || [];
      const currentExecution = executions.get(executionId);
      
      if (!currentExecution) {
        clearInterval(checkForUpdates);
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Execution not found' })}\n\n`);
        res.end();
        return;
      }

      // Send new logs
      if (currentLogs.length > lastLogCount) {
        const newLogs = currentLogs.slice(lastLogCount);
        newLogs.forEach((log, index) => {
          res.write(`data: ${JSON.stringify({ 
            type: 'log', 
            content: log, 
            index: lastLogCount + index 
          })}\n\n`);
        });
        lastLogCount = currentLogs.length;
      }

      // Send status updates
      res.write(`data: ${JSON.stringify({ 
        type: 'status', 
        status: currentExecution.status, 
        progress: currentExecution.progress 
      })}\n\n`);

      // End stream if execution is complete
      if (['completed', 'failed', 'cancelled'].includes(currentExecution.status)) {
        clearInterval(checkForUpdates);
        res.write(`data: ${JSON.stringify({ 
          type: 'complete', 
          status: currentExecution.status,
          result: currentExecution.result,
          error: currentExecution.error
        })}\n\n`);
        res.end();
      }
    }, 1000); // Check every second

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(checkForUpdates);
    });

    req.on('aborted', () => {
      clearInterval(checkForUpdates);
    });

  } catch (error) {
    console.error('Error streaming execution logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to stream execution logs',
      code: 'EXECUTION_STREAM_ERROR'
    });
  }
});

/**
 * Cancel execution
 */
router.delete('/executions/:executionId', authenticate, async (req, res) => {
  try {
    const { executionId } = req.params;
    const execution = executions.get(executionId);

    if (!execution) {
      return res.status(404).json({
        success: false,
        message: 'Execution not found',
        code: 'EXECUTION_NOT_FOUND'
      });
    }

    // Check if user has access to this execution
    if (execution.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Access denied to this execution',
        code: 'ACCESS_DENIED'
      });
    }

    // Can only cancel running or queued executions
    if (!['queued', 'running'].includes(execution.status)) {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel execution in current status',
        code: 'INVALID_STATUS',
        details: `Current status: ${execution.status}`
      });
    }

    // Cancel execution
    execution.status = 'cancelled';
    execution.completedAt = new Date().toISOString();

    const logs = executionLogs.get(executionId);
    if (logs) {
      logs.push('Execution cancelled by user');
    }

    res.json({
      success: true,
      message: 'Execution cancelled successfully'
    });

  } catch (error) {
    console.error('Error cancelling execution:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel execution',
      code: 'EXECUTION_CANCEL_ERROR'
    });
  }
});

/**
 * Get agent recommendations
 */
router.post('/recommendations', authenticate, async (req, res) => {
  try {
    const { taskDescription, projectType } = req.body;

    if (!taskDescription) {
      return res.status(400).json({
        success: false,
        message: 'taskDescription is required',
        field: 'taskDescription'
      });
    }

    const recommendations = await aiRecommendationService.getAgentRecommendations(
      req.user._id,
      taskDescription,
      projectType
    );

    res.json({
      success: true,
      data: {
        recommendations,
        taskDescription,
        projectType
      }
    });

  } catch (error) {
    console.error('Error getting agent recommendations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get agent recommendations',
      code: 'RECOMMENDATIONS_ERROR'
    });
  }
});

/**
 * Get available agent types
 */
router.get('/types', authenticate, async (req, res) => {
  try {
    const agentTypes = [
      {
        type: 'product-manager',
        name: 'Product Manager',
        description: 'Analyzes requirements and communicates with stakeholders',
        capabilities: ['requirement-analysis', 'stakeholder-communication', 'feature-prioritization']
      },
      {
        type: 'project-manager',
        name: 'Project Manager',
        description: 'Breaks down tasks and manages project timelines',
        capabilities: ['task-breakdown', 'timeline-management', 'resource-planning']
      },
      {
        type: 'tech-lead',
        name: 'Tech Lead',
        description: 'Designs architecture and provides technical guidance',
        capabilities: ['architecture-design', 'technical-guidance', 'code-review']
      },
      {
        type: 'senior-developer',
        name: 'Senior Developer',
        description: 'Implements complex features and mentors junior developers',
        capabilities: ['complex-implementation', 'code-review', 'mentoring']
      },
      {
        type: 'junior-developer',
        name: 'Junior Developer',
        description: 'Implements UI components and simple features',
        capabilities: ['ui-components', 'simple-features', 'basic-testing']
      },
      {
        type: 'qa-engineer',
        name: 'QA Engineer',
        description: 'Performs testing and quality validation',
        capabilities: ['testing', 'quality-assurance', 'bug-detection']
      }
    ];

    res.json({
      success: true,
      data: agentTypes
    });

  } catch (error) {
    console.error('Error getting agent types:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get agent types',
      code: 'AGENT_TYPES_ERROR'
    });
  }
});

/**
 * Simulate Claude Code execution with realistic steps
 */
async function simulateClaudeExecution(executionId, agentType, instructions, context) {
  const execution = executions.get(executionId);
  const logs = executionLogs.get(executionId);

  try {
    // Phase 1: Initialization
    await delay(1000);
    execution.progress = 20;
    logs.push('Initializing workspace...');
    logs.push(`Working directory: ${context.workspacePath}`);

    // Phase 2: Analysis
    await delay(1500);
    execution.progress = 40;
    logs.push('Analyzing task requirements...');
    logs.push(`Agent ${agentType} processing instructions`);

    // Phase 3: Processing
    await delay(2000);
    execution.progress = 60;
    logs.push('Processing with Claude Code...');
    
    // Agent-specific processing
    const agentSpecificLogs = getAgentSpecificLogs(agentType, instructions);
    agentSpecificLogs.forEach(log => {
      logs.push(log);
    });

    // Phase 4: Implementation
    await delay(2500);
    execution.progress = 80;
    logs.push('Implementing solution...');
    logs.push('Generating code and documentation...');

    // Phase 5: Completion
    await delay(1000);
    execution.progress = 100;
    execution.status = 'completed';
    execution.completedAt = new Date().toISOString();
    
    // Generate realistic result based on agent type
    execution.result = generateAgentResult(agentType, instructions, context);
    
    logs.push('Execution completed successfully');
    logs.push(`Generated ${execution.result.files.length} files`);
    logs.push(`Task completed in ${Math.round((new Date() - new Date(execution.createdAt)) / 1000)}s`);

  } catch (error) {
    execution.status = 'failed';
    execution.error = error.message;
    execution.completedAt = new Date().toISOString();
    logs.push(`Execution failed: ${error.message}`);
  }
}

/**
 * Get agent-specific logs
 */
function getAgentSpecificLogs(agentType, instructions) {
  const logs = [];
  
  switch (agentType) {
    case 'product-manager':
      logs.push('Analyzing product requirements...');
      logs.push('Identifying stakeholder needs...');
      logs.push('Creating feature specifications...');
      break;
      
    case 'project-manager':
      logs.push('Breaking down tasks...');
      logs.push('Estimating timelines...');
      logs.push('Creating project plan...');
      break;
      
    case 'tech-lead':
      logs.push('Designing system architecture...');
      logs.push('Reviewing technical requirements...');
      logs.push('Creating technical specifications...');
      break;
      
    case 'senior-developer':
      logs.push('Analyzing code structure...');
      logs.push('Implementing complex logic...');
      logs.push('Writing comprehensive tests...');
      break;
      
    case 'junior-developer':
      logs.push('Creating UI components...');
      logs.push('Implementing basic functionality...');
      logs.push('Following coding standards...');
      break;
      
    case 'qa-engineer':
      logs.push('Creating test plans...');
      logs.push('Writing automated tests...');
      logs.push('Validating quality metrics...');
      break;
  }
  
  return logs;
}

/**
 * Generate realistic agent result
 */
function generateAgentResult(agentType, instructions, context) {
  const baseResult = {
    output: `Task completed successfully by ${agentType}`,
    success: true,
    files: [],
    metrics: {
      executionTime: Math.floor(Math.random() * 300000) + 60000, // 1-5 minutes
      linesOfCode: 0,
      testsWritten: 0
    }
  };

  switch (agentType) {
    case 'product-manager':
      baseResult.output = 'Product requirements analyzed and documented';
      baseResult.files = ['requirements.md', 'user-stories.md', 'acceptance-criteria.md'];
      break;
      
    case 'project-manager':
      baseResult.output = 'Project plan created with task breakdown';
      baseResult.files = ['project-plan.md', 'timeline.md', 'resource-allocation.md'];
      break;
      
    case 'tech-lead':
      baseResult.output = 'Technical architecture designed and documented';
      baseResult.files = ['architecture.md', 'technical-specs.md', 'api-design.md'];
      break;
      
    case 'senior-developer':
      baseResult.output = 'Complex feature implemented with tests';
      baseResult.files = ['component.jsx', 'service.js', 'component.test.js', 'README.md'];
      baseResult.metrics.linesOfCode = Math.floor(Math.random() * 500) + 100;
      baseResult.metrics.testsWritten = Math.floor(Math.random() * 10) + 3;
      break;
      
    case 'junior-developer':
      baseResult.output = 'UI component created with basic functionality';
      baseResult.files = ['Button.jsx', 'Button.css', 'Button.stories.js'];
      baseResult.metrics.linesOfCode = Math.floor(Math.random() * 200) + 50;
      baseResult.metrics.testsWritten = Math.floor(Math.random() * 5) + 1;
      break;
      
    case 'qa-engineer':
      baseResult.output = 'Comprehensive test suite created';
      baseResult.files = ['test-plan.md', 'e2e.test.js', 'integration.test.js', 'performance.test.js'];
      baseResult.metrics.testsWritten = Math.floor(Math.random() * 20) + 10;
      break;
  }

  return baseResult;
}

/**
 * Utility function for delays
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Cleanup old executions periodically
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  
  for (const [executionId, execution] of executions.entries()) {
    const createdAt = new Date(execution.createdAt).getTime();
    if (createdAt < oneHourAgo && ['completed', 'failed', 'cancelled'].includes(execution.status)) {
      executions.delete(executionId);
      executionLogs.delete(executionId);
    }
  }
}, 10 * 60 * 1000); // Run every 10 minutes

module.exports = router;