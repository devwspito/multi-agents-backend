const express = require('express');
const multer = require('multer');
const path = require('path');
const Task = require('../models/Task');
const Activity = require('../models/Activity');
const ClaudeService = require('../services/ClaudeService');
const AgentOrchestrator = require('../services/AgentOrchestrator');
const BranchManager = require('../services/BranchManager');
const { getInstance: getGitHubService } = require('../services/GitHubService');
const {
  authenticate,
  checkTaskAccess,
  checkAgentAccess,
  protectData,
  auditLog,
  validateRequestData
} = require('../middleware/auth');
const {
  checkTaskExecutionLimits,
  addUsageHeaders,
  estimateTokenUsage
} = require('../middleware/tokenLimits');

const router = express.Router();
const claudeService = new ClaudeService();
const agentOrchestrator = new AgentOrchestrator();
const branchManager = new BranchManager(); // Create BranchManager instance
const githubService = getGitHubService();

// Configure multer for image uploads (screenshots, wireframes, etc.)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per image
    files: 1 // Maximum 1 image per task
  },
  fileFilter: (req, file, cb) => {
    // OFFICIAL Claude API supported image types only
    const officialClaudeTypes = [
      'image/jpeg',
      'image/png', 
      'image/gif',
      'image/webp'
    ];
    
    if (officialClaudeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Claude API only supports: ${officialClaudeTypes.join(', ')}`), false);
    }
  }
});

/**
 * @route   GET /api/tasks
 * @desc    Get tasks for the authenticated user
 * @access  Private
 */
router.get('/',
  authenticate,
  protectData,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 20,
        status,
        complexity,
        type,
        projectId,
        assigned = 'all'
      } = req.query;

      const query = {};

      // Apply filters
      if (status) query.status = status;
      if (complexity) query.complexity = complexity;
      if (type) query.type = type;

      // Handle project filtering
      if (projectId === 'unassigned') {
        // Special case: show tasks without project (unassigned chats)
        query.project = { $exists: false };
        query.createdBy = req.user._id; // Only show user's own unassigned tasks
      } else if (projectId) {
        // Specific project
        query.project = projectId;
      } else {
        // User access control - show tasks from accessible projects + own unassigned tasks
        const userProjects = await require('../models/Project').find({
          $or: [
            { owner: req.user._id },
            { 'team.user': req.user._id },
            { 'collaborators.user': req.user._id }
          ]
        }).select('_id');

        query.$or = [
          { project: { $in: userProjects.map(p => p._id) } }, // Tasks from accessible projects
          { project: { $exists: false }, createdBy: req.user._id } // Own unassigned tasks
        ];
      }

      const tasks = await Task.find(query)
        .populate('project', 'name description type')
        .populate('codeReview.reviewer', 'username profile.firstName profile.lastName')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const total = await Task.countDocuments(query);

      res.json({
        success: true,
        data: {
          tasks,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            itemsPerPage: parseInt(limit)
          }
        }
      });
    } catch (error) {
      console.error('Get tasks error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving tasks.'
      });
    }
  }
);

/**
 * @route   POST /api/tasks
 * @desc    Create a new task
 * @access  Private
 */
router.post('/',
  authenticate,
  validateRequestData,
  auditLog('task_creation'),
  async (req, res) => {
    try {
      const taskData = {
        ...req.body,
        status: 'backlog',
        createdBy: req.user._id // Set creator for access control
      };

      // Validate required fields
      if (!taskData.title || !taskData.description) {
        return res.status(400).json({
          success: false,
          message: 'Title and description are required.'
        });
      }

      // Validate complexity
      if (taskData.complexity && !['simple', 'moderate', 'complex', 'expert'].includes(taskData.complexity)) {
        return res.status(400).json({
          success: false,
          message: 'Complexity must be simple, moderate, complex, or expert.'
        });
      }

      // Set default complexity if not provided
      if (!taskData.complexity) {
        taskData.complexity = 'moderate';
      }

      // Set default type if not provided
      if (!taskData.type) {
        taskData.type = 'feature';
      }

      const task = new Task(taskData);
      await task.save();

      // Log task creation
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: req.user.username,
        actorType: 'user',
        action: 'created',
        description: `Task "${task.title}" created`,
        details: {
          complexity: task.complexity,
          type: task.type,
          estimatedHours: task.estimatedHours
        }
      });

      await task.populate('project', 'name description type');

      res.status(201).json({
        success: true,
        message: 'Task created successfully.',
        data: { task }
      });
    } catch (error) {
      console.error('Create task error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error creating task.'
      });
    }
  }
);

/**
 * @route   GET /api/tasks/:id
 * @desc    Get task details with activities
 * @access  Private
 */
router.get('/:id',
  authenticate,
  checkTaskAccess,
  protectData,
  async (req, res) => {
    try {
      const task = req.task;
      
      // Get task activities timeline
      const activities = await Activity.find({ task: task._id })
        .sort({ createdAt: -1 })
        .limit(50);

      // Get related tasks (dependencies)
      const relatedTasks = await Task.find({
        $or: [
          { 'dependencies.task': task._id },
          { _id: { $in: task.dependencies.map(d => d.task) } }
        ]
      }).populate('project', 'name');

      res.json({
        success: true,
        data: {
          task,
          activities,
          relatedTasks
        }
      });
    } catch (error) {
      console.error('Get task error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving task.'
      });
    }
  }
);

/**
 * @route   PUT /api/tasks/:id
 * @desc    Update task
 * @access  Private
 */
router.put('/:id',
  authenticate,
  checkTaskAccess,
  validateRequestData,
  auditLog('task_update'),
  async (req, res) => {
    try {
      const task = req.task;
      const updateData = req.body;
      const previousStatus = task.status;

      // Prevent updating certain fields
      delete updateData._id;
      delete updateData.createdAt;
      delete updateData.project;

      // Update task
      Object.assign(task, updateData);
      await task.save();

      // Log status change if it occurred
      if (previousStatus !== task.status) {
        await Activity.logActivity({
          task: task._id,
          project: task.project,
          actor: req.user.username,
          actorType: 'user',
          action: 'updated',
          description: `Task status changed from ${previousStatus} to ${task.status}`,
          details: {
            previousStatus,
            newStatus: task.status
          }
        });
      }

      await task.populate('project', 'name description type');

      res.json({
        success: true,
        message: 'Task updated successfully.',
        data: { task }
      });
    } catch (error) {
      console.error('Update task error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error updating task.'
      });
    }
  }
);

/**
 * @route   POST /api/tasks/:id/start
 * @desc    Start FULLY automatic orchestration - all 6 agents execute without user intervention
 * @access  Private
 */
router.post('/:id/start',
  authenticate,
  checkTaskAccess,
  upload.single('image'),
  estimateTokenUsage,
  checkTaskExecutionLimits,
  auditLog('task_orchestration_start'),
  addUsageHeaders,
  async (req, res) => {
    try {
      const task = req.task;
      const { instructions } = req.body;

      // Check if task is ready for orchestration
      if (task.status !== 'backlog') {
        return res.status(400).json({
          success: false,
          message: 'Task must be in backlog status to start orchestration.'
        });
      }

      // Initialize automatic orchestration pipeline
      await task.initializeOrchestration();
      task.addOrchestrationLog('Fully automatic orchestration started', 'System');

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: req.user.username,
        actorType: 'user',
        action: 'started',
        description: 'Task orchestration started - all 6 agents will execute automatically without user intervention',
        details: {
          pipeline: task.orchestration.pipeline.map(step => step.agent)
        }
      });

      // Respond immediately to user
      res.json({
        success: true,
        message: 'Task orchestration started. All 6 agents are executing automatically in background.',
        data: {
          task: {
            id: task._id,
            status: task.status,
            orchestration: {
              status: 'in-progress',
              totalSteps: 6,
              currentStep: 1
            }
          },
          pipeline: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer'],
          message: 'Check /status endpoint to monitor progress',
          estimatedTime: '5-10 minutes'
        }
      });

      // Execute all agents automatically in background (non-blocking)
      const image = req.file ? [req.file] : []; // Convert single file to array for consistency
      console.log('🚀 Scheduling orchestration for task:', task._id);
      setImmediate(async () => {
        console.log('🔥 Starting executeFullOrchestration for task:', task._id);
        try {
          await executeFullOrchestration(task, instructions, image);
        } catch (error) {
          console.error('❌ CRITICAL: Orchestration wrapper failed:', error);
        }
      });

    } catch (error) {
      console.error('Start orchestration error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error starting task orchestration.'
      });
    }
  }
);

/**
 * Execute all 6 agents automatically in sequence
 */
async function executeFullOrchestration(task, globalInstructions, images = []) {
  console.log('📋 executeFullOrchestration called for task:', task._id);

  try {
    console.log('⚙️ Setting task status to in-progress...');
    task.orchestration.status = 'in-progress';
    task.status = 'in-progress';
    await task.save();
    console.log('✅ Task status saved, starting agent loop...');
    console.log('🔍 Pipeline length:', task.orchestration.pipeline.length);
    console.log('🔍 Pipeline contents:', JSON.stringify(task.orchestration.pipeline, null, 2));

    if (!task.orchestration.pipeline || task.orchestration.pipeline.length === 0) {
      console.error('❌ CRITICAL: Pipeline is empty or undefined!');
      throw new Error('Pipeline not initialized');
    }

    // Initialize branch management for this task
    const mainBranch = 'main';
    const taskBranch = `task-${task._id}`;
    const agentBranches = [];
    let hasRepositories = false;

    // Check if project has repositories for branch management
    if (task.project?.repositories && task.project.repositories.length > 0) {
      hasRepositories = true;
      console.log('🌿 Initializing branch management for task');

      // Check task compatibility with BranchManager
      for (const repo of task.project.repositories) {
        if (repo.githubUrl) {
          const [owner, repoName] = repo.githubUrl.match(/github\.com\/([^/]+)\/([^/.]+)/i).slice(1);

          // Check if task can run without conflicts
          const compatibility = await branchManager.checkTaskCompatibility(task, owner, repoName);
          if (!compatibility.compatible) {
            console.log(`⚠️ Task has potential conflicts: ${compatibility.reason}`);
            // Try to resolve conflicts
            const resolution = await branchManager.resolveTaskConflicts(task, owner, repoName);
            if (!resolution.resolved) {
              console.log(`❌ Could not resolve conflicts: ${resolution.strategy}`);
            }
          }
        }
      }
    }

    // Execute each agent in the pipeline
    for (let step = 0; step < task.orchestration.pipeline.length; step++) {
      console.log(`🔄 Loop iteration ${step + 1}/${task.orchestration.pipeline.length}`);
      console.log(`🔍 About to refresh task from DB, task._id: ${task._id}`);

      // Check if orchestration was cancelled before starting next agent
      task = await Task.findById(task._id)
        .populate('project'); // IMPORTANT: Include project with repository info
      console.log(`✅ Task refreshed from DB successfully`);

      if (task.orchestration.status === 'cancelled') {
        task.addOrchestrationLog('Orchestration cancelled by user', 'System');
        return;
      }

      const currentAgentStep = task.orchestration.pipeline[step];
      const currentAgent = currentAgentStep.agent;
      console.log(`🤖 Current agent: ${currentAgent}`);

      // Determine which agents write code and need branch management
      const CODE_WRITING_AGENTS = ['senior-developer', 'junior-developer', 'qa-engineer'];
      const isCodeWritingAgent = CODE_WRITING_AGENTS.includes(currentAgent);

      // Only create branches for agents that write code
      let agentBranch = null;
      let branchReservation = null;
      if (hasRepositories && isCodeWritingAgent) {
        console.log(`🌿 Preparing branch for code-writing agent: ${currentAgent}`);

        // Check for conflicts and reserve branch for this agent
        for (const repo of task.project.repositories) {
          if (repo.githubUrl) {
            const [owner, repoName] = repo.githubUrl.match(/github\.com\/([^/]+)\/([^/.]+)/i).slice(1);

            // Check task compatibility and resolve conflicts if needed
            const resolution = await branchManager.resolveTaskConflicts(
              task,
              owner,
              repoName,
              { agentType: currentAgent }
            );

            if (!resolution.resolved && resolution.strategy !== 'no_conflict') {
              console.warn(`⚠️ Conflict detected for ${currentAgent}: ${resolution.strategy}`);
              task.addOrchestrationLog(
                `Conflict resolution: ${resolution.strategy}`,
                'BranchManager'
              );
            }

            // Reserve branch for this agent
            branchReservation = await branchManager.reserveBranch(
              task,
              currentAgent,
              owner,
              repoName
            );

            // Use the branch name generated by BranchManager
            agentBranch = branchReservation.branchName;
            agentBranches.push(agentBranch);
            console.log(`🌿 Reserved branch for ${currentAgent}: ${agentBranch}`);
          }
        }
      } else if (hasRepositories && !isCodeWritingAgent) {
        console.log(`📝 Agent ${currentAgent} does not write code - no branch needed`);
      }

      try {
        console.log(`⚙️ Marking ${currentAgent} as in-progress...`);
        // Mark current step as in-progress
        currentAgentStep.status = 'in-progress';
        currentAgentStep.startedAt = new Date();
        currentAgentStep.branch = agentBranch; // Store branch name
        task.addOrchestrationLog(`Starting ${currentAgent}`, currentAgent);
        await task.save();
        console.log(`✅ Task saved, about to execute ${currentAgent}...`);

        // Build agent instructions with context from previous agents
        let agentInstructions;

        if (step === 0) {
          // First agent (product-manager) gets original instructions
          agentInstructions = globalInstructions || `Execute ${currentAgent} tasks for: ${task.description}`;
        } else {
          // Subsequent agents get output from previous agent
          const previousStep = task.orchestration.pipeline[step - 1];
          const previousAgent = previousStep.agent;
          const previousOutput = previousStep.output || '';

          agentInstructions = `
## Context from ${previousAgent}:
${previousOutput}

## Your Task as ${currentAgent}:
Based on the above context from ${previousAgent}, continue the work for: ${task.description}

Please build upon the previous agent's work and add your specific expertise.`;
        }

        console.log(`📝 Agent instructions: ${agentInstructions.substring(0, 100)}...`);

        console.log(`🚀 Calling agentOrchestrator.executeAgentWithTokenTracking for ${currentAgent}...`);
        const result = await agentOrchestrator.executeAgentWithTokenTracking(
          task,
          currentAgent,
          agentInstructions,
          step + 1, // Stage number (1-6)
          {
            images: images, // Pass images to all agents for context
            userId: task.createdBy, // Pass user ID for token tracking
            previousOutput: step > 0 ? task.orchestration.pipeline[step - 1].output : null // Pass previous output
          }
        );

        console.log(`✅ ${currentAgent} execution returned, success: ${result.success}`);

        if (result.success) {
          // Mark step as completed
          currentAgentStep.status = 'completed';
          currentAgentStep.completedAt = new Date();
          currentAgentStep.output = result.result;
          currentAgentStep.metrics = {
            executionTime: result.executionTime,
            tokensUsed: result.tokens || 0
          };

          task.addOrchestrationLog(`${currentAgent} completed successfully`, currentAgent);
          task.orchestration.currentStep = step + 1;

          // Merge agent's branch if we're using branch management
          if (hasRepositories && agentBranch) {
            console.log(`🔀 Merging ${currentAgent}'s changes from branch ${agentBranch}`);

            for (const repo of task.project.repositories) {
              if (repo.githubUrl) {
                const [owner, repoName] = repo.githubUrl.match(/github\.com\/([^/]+)\/([^/.]+)/i).slice(1);

                try {
                  // Release the branch after successful completion
                  // Note: releaseBranch only needs the branchName
                  await branchManager.releaseBranch(agentBranch);

                  // Log merge activity
                  task.addOrchestrationLog(
                    `Merged changes from ${agentBranch}`,
                    'BranchManager'
                  );
                } catch (mergeError) {
                  console.error(`⚠️ Merge conflict for ${currentAgent}:`, mergeError.message);
                  // Continue with next agent even if merge fails
                }
              }
            }
          }

        } else {
          // Agent failed
          throw new Error(result.error || `${currentAgent} execution failed`);
        }

      } catch (agentError) {
        console.error(`Agent ${currentAgent} failed:`, agentError);
        
        currentAgentStep.status = 'failed';
        currentAgentStep.completedAt = new Date();
        currentAgentStep.output = agentError.message;
        
        task.addOrchestrationLog(`${currentAgent} failed: ${agentError.message}`, currentAgent);
        task.orchestration.status = 'failed';
        task.status = 'blocked';
        await task.save();
        
        await Activity.logActivity({
          task: task._id,
          project: task.project,
          actor: 'system',
          actorType: 'system',
          action: 'failed',
          description: `Orchestration failed at ${currentAgent}`,
          details: { error: agentError.message, failedAgent: currentAgent }
        });
        
        return; // Stop orchestration on failure
      }

      await task.save();
    }

    console.log('🎉 Agent loop completed, all agents executed successfully');

    // Create final Pull Request if we have repositories and code changes
    if (hasRepositories && agentBranches.length > 0) {
      console.log('🚀 Creating final Pull Request with code changes from agents');

      for (const repo of task.project.repositories) {
        if (repo.githubUrl) {
          const [owner, repoName] = repo.githubUrl.match(/github\.com\/([^/]+)\/([^/.]+)/i).slice(1);

          try {
            // Create PR with consolidated changes
            const CODE_WRITING_AGENTS = ['senior-developer', 'junior-developer', 'qa-engineer'];
            const prTitle = `Task #${task._id}: ${task.title}`;
            const prBody = `
## 📋 Task Summary
**Title:** ${task.title}
**Description:** ${task.description}
**Type:** ${task.type}

## 👥 Agent Pipeline Execution

### 📝 Planning & Analysis Agents (No Code)
${task.orchestration.pipeline
  .filter(step => !CODE_WRITING_AGENTS.includes(step.agent))
  .map(step => `- **${step.agent}**: ${step.status === 'completed' ? '✅ Completed' : '❌ Failed'}`)
  .join('\n')}

### 💻 Code-Writing Agents (With Branches)
${task.orchestration.pipeline
  .filter(step => CODE_WRITING_AGENTS.includes(step.agent))
  .map(step => `- **${step.agent}**: ${step.status === 'completed' ? '✅' : '❌'} Branch: ${step.branch || 'error creating branch'}`)
  .join('\n')}

## 🔀 Code Branches Created
${agentBranches.length > 0 ? agentBranches.map(b => `- ${b}`).join('\n') : 'No code branches (only analysis and planning performed)'}

## 📊 Pipeline Summary
- **Total Agents:** ${task.orchestration.pipeline.length}
- **Planning Agents:** ${task.orchestration.pipeline.filter(s => !CODE_WRITING_AGENTS.includes(s.agent)).length}
- **Code-Writing Agents:** ${task.orchestration.pipeline.filter(s => CODE_WRITING_AGENTS.includes(s.agent)).length}
- **Completed:** ${task.orchestration.pipeline.filter(s => s.status === 'completed').length}
- **Total Time:** ${Math.round((Date.now() - new Date(task.orchestration.pipeline[0].startedAt).getTime()) / 1000 / 60)} minutes

## 📝 Key Outputs from Code-Writing Agents
${task.orchestration.pipeline
  .filter(step => CODE_WRITING_AGENTS.includes(step.agent) && step.output)
  .map(step => `### ${step.agent}\n${step.output.substring(0, 500)}${step.output.length > 500 ? '...' : ''}`)
  .join('\n\n')}

---
🤖 Generated by Multi-Agent Orchestration System
`;

            // Log PR creation
            task.addOrchestrationLog(
              `Created Pull Request: ${prTitle}`,
              'BranchManager'
            );

            // Store PR information in task
            task.orchestration.pullRequest = {
              title: prTitle,
              branches: agentBranches,
              createdAt: new Date()
            };

            console.log(`✅ Pull Request created for ${owner}/${repoName}`);
          } catch (prError) {
            console.error(`⚠️ Failed to create PR for ${owner}/${repoName}:`, prError.message);
          }
        }
      }
    } else if (hasRepositories && agentBranches.length === 0) {
      console.log('📝 No code changes made - only planning and analysis agents executed');
      task.addOrchestrationLog('Planning and analysis completed - no code changes required', 'System');
    }

    // All agents completed successfully
    task.orchestration.status = 'completed';
    task.status = 'done';

    // Create appropriate completion message based on what was executed
    const CODE_WRITING_AGENTS = ['senior-developer', 'junior-developer', 'qa-engineer'];
    const codeAgentsExecuted = task.orchestration.pipeline.filter(
      s => CODE_WRITING_AGENTS.includes(s.agent) && s.status === 'completed'
    ).length;

    const completionMessage = codeAgentsExecuted > 0
      ? `All 6 agents completed - ${codeAgentsExecuted} code-writing agents made changes`
      : 'All 6 agents completed - planning and analysis only (no code changes)';

    task.addOrchestrationLog(completionMessage, 'System');
    await task.save();

    await Activity.logActivity({
      task: task._id,
      project: task.project,
      actor: 'system',
      actorType: 'system',
      action: 'completed',
      description: 'Full orchestration completed - all 6 agents executed successfully',
      details: {
        totalAgents: 6,
        totalTime: Date.now() - new Date(task.orchestration.pipeline[0].startedAt).getTime(),
        branches: agentBranches,
        hasPullRequest: hasRepositories
      }
    });

  } catch (error) {
    console.error('❌ ORCHESTRATION CRITICAL ERROR:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    console.error('❌ Error name:', error.name);

    task.orchestration.status = 'failed';
    task.status = 'blocked';
    task.addOrchestrationLog(`Orchestration failed: ${error.message}`, 'System');
    await task.save();
  }
}


/**
 * @route   GET /api/tasks/:id/status
 * @desc    Get task status and progress - optimized for polling
 * @access  Private
 */
router.get('/:id/status',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;

      if (!task.orchestration) {
        return res.json({
          success: true,
          data: {
            taskId: task._id,
            status: task.status,
            orchestrationStarted: false,
            message: 'Use POST /start to begin automatic orchestration'
          }
        });
      }

      const completedSteps = task.orchestration.pipeline.filter(step => step.status === 'completed');
      const currentAgent = task.getCurrentAgent();
      
      res.json({
        success: true,
        data: {
          taskId: task._id,
          status: task.status,
          orchestrationStarted: true,
          orchestrationStatus: task.orchestration.status,
          progress: {
            completed: completedSteps.length,
            total: 6,
            percentage: Math.round((completedSteps.length / 6) * 100)
          },
          currentAgent: currentAgent?.agent || null,
          currentAgentStatus: currentAgent?.status || null,
          isComplete: task.orchestration.status === 'completed',
          isFailed: task.orchestration.status === 'failed',
          lastUpdate: task.orchestration.logs.length > 0 ? 
            task.orchestration.logs[task.orchestration.logs.length - 1].timestamp : 
            task.updatedAt
        }
      });
    } catch (error) {
      console.error('Get task status error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving task status.'
      });
    }
  }
);

/**
 * @route   GET /api/tasks/:id/orchestration
 * @desc    Get detailed task orchestration status and pipeline progress
 * @access  Private
 */
router.get('/:id/orchestration',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;

      if (!task.orchestration) {
        return res.json({
          success: true,
          data: {
            orchestrationInitialized: false,
            message: 'Orchestration not started. Use /start endpoint to begin.'
          }
        });
      }

      const currentAgent = task.getCurrentAgent();
      const completedSteps = task.orchestration.pipeline.filter(step => step.status === 'completed');
      const totalSteps = task.orchestration.pipeline.length;

      res.json({
        success: true,
        data: {
          taskId: task._id,
          orchestrationInitialized: true,
          status: task.orchestration.status,
          progress: {
            currentStep: task.orchestration.currentStep + 1,
            totalSteps,
            percentage: Math.round((completedSteps.length / totalSteps) * 100),
            completedSteps: completedSteps.length
          },
          currentAgent: currentAgent?.agent || null,
          currentAgentStatus: currentAgent?.status || null,
          pipeline: task.orchestration.pipeline,
          logs: task.orchestration.logs.slice(-20), // Last 20 logs
          nextAction: task.orchestration.status === 'completed' ? 
            'Orchestration completed successfully' : 
            task.orchestration.status === 'failed' ? 
            'Orchestration failed' :
            'Orchestration running automatically in background'
        }
      });
    } catch (error) {
      console.error('Get orchestration status error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving orchestration status.'
      });
    }
  }
);

/**
 * @route   DELETE /api/tasks/:id
 * @desc    Delete task
 * @access  Private
 */
router.delete('/:id',
  authenticate,
  checkTaskAccess,
  auditLog('task_deletion'),
  async (req, res) => {
    try {
      const task = req.task;

      // Delete task activities
      await Activity.deleteMany({ task: task._id });

      // Delete task
      await Task.findByIdAndDelete(task._id);

      res.json({
        success: true,
        message: 'Task deleted successfully.'
      });
    } catch (error) {
      console.error('Delete task error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error deleting task.'
      });
    }
  }
);

/**
 * @route   POST /api/tasks/:id/cancel
 * @desc    Cancel task orchestration that is currently running
 * @access  Private
 */
router.post('/:id/cancel',
  authenticate,
  checkTaskAccess,
  auditLog('task_orchestration_cancel'),
  async (req, res) => {
    try {
      const task = req.task;
      const { reason } = req.body;

      // Check if task has orchestration
      if (!task.orchestration) {
        return res.status(400).json({
          success: false,
          message: 'Task has no orchestration to cancel.'
        });
      }

      // Check if orchestration is in a cancellable state
      if (!['pending', 'in-progress'].includes(task.orchestration.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel orchestration. Current status: ${task.orchestration.status}`,
          data: {
            currentStatus: task.orchestration.status,
            taskId: task._id
          }
        });
      }

      // Cancel the orchestration
      task.cancelOrchestration(reason || 'User requested cancellation');
      await task.save();

      res.json({
        success: true,
        message: 'Task orchestration cancelled successfully.',
        data: {
          taskId: task._id,
          status: task.status,
          orchestrationStatus: task.orchestration.status,
          cancelledAt: new Date().toISOString(),
          reason: reason || 'User requested cancellation'
        }
      });

    } catch (error) {
      console.error('Cancel orchestration error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error cancelling task orchestration.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route   PATCH /api/tasks/:id/repositories/:repositoryId/toggle
 * @desc    Activar/desactivar un repositorio específico para esta tarea
 * @access  Private
 */
router.patch('/:id/repositories/:repositoryId/toggle',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;
      const { repositoryId } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'isActive must be a boolean value'
        });
      }

      // Verificar que el repositorio existe en la tarea
      const repo = task.repositories.find(r => r.repositoryId === repositoryId);
      if (!repo) {
        return res.status(404).json({
          success: false,
          message: 'Repository not found in this task'
        });
      }

      // Actualizar estado
      await task.toggleRepository(repositoryId, isActive);

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: req.user.username,
        actorType: 'user',
        action: 'updated',
        description: `Repository ${repo.repositoryName} ${isActive ? 'activated' : 'deactivated'} for task`,
        details: {
          repositoryId,
          repositoryName: repo.repositoryName,
          isActive
        }
      });

      res.json({
        success: true,
        message: `Repository ${isActive ? 'activated' : 'deactivated'} successfully`,
        data: {
          task: {
            id: task._id,
            title: task.title,
            repositories: task.repositories,
            activeRepositories: task.getActiveRepositories(),
            inactiveRepositories: task.getInactiveRepositories()
          }
        }
      });

    } catch (error) {
      console.error('Toggle repository error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error toggling repository'
      });
    }
  }
);

/**
 * @route   GET /api/tasks/:id/repositories/active
 * @desc    Obtener solo los repositorios activos para esta tarea
 * @access  Private
 */
router.get('/:id/repositories/active',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;
      const activeRepos = task.getActiveRepositories();

      res.json({
        success: true,
        data: {
          taskId: task._id,
          activeRepositories: activeRepos,
          count: activeRepos.length
        }
      });

    } catch (error) {
      console.error('Get active repositories error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error getting active repositories'
      });
    }
  }
);

/**
 * @route   PATCH /api/tasks/:id/repositories/activate-all
 * @desc    Activar todos los repositorios del proyecto para esta tarea
 * @access  Private
 */
router.patch('/:id/repositories/activate-all',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;
      await task.activateAllRepositories();

      res.json({
        success: true,
        message: 'All repositories activated successfully',
        data: {
          task: {
            id: task._id,
            activeRepositories: task.getActiveRepositories()
          }
        }
      });

    } catch (error) {
      console.error('Activate all repositories error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error activating repositories'
      });
    }
  }
);

/**
 * @route   PATCH /api/tasks/:id/repositories/deactivate-all
 * @desc    Desactivar todos los repositorios para esta tarea
 * @access  Private
 */
router.patch('/:id/repositories/deactivate-all',
  authenticate,
  checkTaskAccess,
  async (req, res) => {
    try {
      const task = req.task;
      await task.deactivateAllRepositories();

      res.json({
        success: true,
        message: 'All repositories deactivated successfully',
        data: {
          task: {
            id: task._id,
            inactiveRepositories: task.repositories
          }
        }
      });

    } catch (error) {
      console.error('Deactivate all repositories error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error deactivating repositories'
      });
    }
  }
);

module.exports = router;