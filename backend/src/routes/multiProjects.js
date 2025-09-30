const express = require('express');
const router = express.Router();
const Project = require('../models/Project');
const Task = require('../models/Task');
const MultiProjectOrchestrator = require('../services/MultiProjectOrchestrator');
const MultiRepoManager = require('../services/MultiRepoManager');
const GitHubIntegration = require('../services/GitHubIntegration');
const { authenticate } = require('../middleware/auth');

const orchestrator = new MultiProjectOrchestrator();
const repoManager = new MultiRepoManager();
const githubIntegration = new GitHubIntegration();

/**
 * @route   GET /api/multi-projects
 * @desc    Get all multi-repository projects for a user
 * @access  Private
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const projects = await Project.findByOwner(req.user.id)
      .populate('team.user', 'name email')
      .sort({ updatedAt: -1 });

    // Filter projects that have multiple repositories
    const multiProjects = projects.filter(project => 
      project.repositories && project.repositories.length > 0
    );

    res.json({
      success: true,
      count: multiProjects.length,
      data: multiProjects
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch multi-repository projects',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/multi-projects
 * @desc    Create a new multi-repository project
 * @access  Private
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const {
      name,
      description,
      repositories,
      settings = {},
      teams = []
    } = req.body;

    // Validate required fields
    if (!name || !repositories || repositories.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Name and at least one repository are required'
      });
    }

    // Create project
    const project = new Project({
      name,
      description,
      owner: req.user.id,
      type: 'educational',
      status: 'setup',
      settings: {
        defaultBranch: 'main',
        autoDeployment: false,
        requiredReviews: 1,
        educationalContext: 'general',
        complianceLevel: 'basic',
        ...settings
      }
    });

    // Add repositories
    for (const repoData of repositories) {
      try {
        // Validate GitHub URL and get repository info
        const repoInfo = await githubIntegration.getRepository(
          repoData.owner,
          repoData.name
        );

        project.addRepository({
          name: repoData.name,
          githubUrl: repoData.githubUrl,
          owner: repoData.owner,
          branch: repoData.branch || repoInfo.default_branch,
          team: repoData.team,
          type: repoData.type,
          technologies: Object.keys(repoInfo.languages || {}),
          accessToken: repoData.accessToken,
          installationId: repoData.installationId
        });
      } catch (repoError) {
        console.warn(`Failed to validate repository ${repoData.name}:`, repoError.message);
        // Still add the repository, but mark it as needing validation
        project.addRepository({
          ...repoData,
          syncStatus: 'error'
        });
      }
    }

    // Add team members if provided
    if (teams.length > 0) {
      project.team = teams;
    }

    await project.save();

    // Set up webhooks for repositories (in background)
    setImmediate(async () => {
      try {
        await this.setupProjectWebhooks(project);
      } catch (error) {
        console.warn('Failed to setup webhooks:', error.message);
      }
    });

    res.status(201).json({
      success: true,
      data: project,
      message: 'Multi-repository project created successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create multi-repository project',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/multi-projects/:id
 * @desc    Get a specific multi-repository project
 * @access  Private
 */
router.get('/:id', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('team.user', 'name email');

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Get project statistics
    await project.updateStats();

    // Get recent tasks
    const recentTasks = await Task.find({ project: project._id })
      .sort({ updatedAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        project,
        recentTasks,
        stats: project.stats
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch project details',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/multi-projects/:id/repositories
 * @desc    Add a repository to an existing project
 * @access  Private
 */
router.post('/:id/repositories', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const repoData = req.body;

    // Validate and add repository
    const repository = project.addRepository(repoData);
    await project.save();

    res.status(201).json({
      success: true,
      data: repository,
      message: 'Repository added successfully'
    });

  } catch (error) {
    res.status(400).json({
      success: false,
      message: 'Failed to add repository',
      error: error.message
    });
  }
});

/**
 * @route   DELETE /api/multi-projects/:id/repositories/:repoId
 * @desc    Remove a repository from a project
 * @access  Private
 */
router.delete('/:id/repositories/:repoId', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    project.removeRepository(req.params.repoId);
    await project.save();

    res.json({
      success: true,
      message: 'Repository removed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to remove repository',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/multi-projects/:id/tasks
 * @desc    Create a multi-repository task
 * @access  Private
 */
router.post('/:id/tasks', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const {
      title,
      description,
      repositories = [], // Repository assignments
      complexity = 'moderate',
      priority = 'medium',
      educationalImpact = {},
      compliance = {}
    } = req.body;

    // Execute multi-repository task analysis and distribution
    const taskAnalysis = await orchestrator.analyzeTaskRequirements(
      description,
      project.repositories
    );

    // Create task
    const task = new Task({
      title,
      description,
      project: project._id,
      feature: 'Multi-repository implementation',
      type: 'feature',
      complexity,
      priority,
      status: 'assigned',
      educationalImpact,
      compliance,
      coordination: {
        strategy: taskAnalysis.coordinationStrategy || 'parallel',
        phases: [],
        integrationPoints: taskAnalysis.integrationPoints || []
      }
    });

    // Add repository assignments
    for (const repoAssignment of repositories) {
      const projectRepo = project.repositories.find(
        repo => repo.name === repoAssignment.repositoryName
      );

      if (projectRepo) {
        task.addRepository({
          repositoryId: projectRepo._id.toString(),
          repositoryName: projectRepo.name,
          team: projectRepo.team,
          branch: repoAssignment.branch || project.settings.defaultBranch,
          assignedAgent: repoAssignment.assignedAgent,
          estimatedHours: repoAssignment.estimatedHours
        });
      }
    }

    await task.save();

    // Update project stats
    await project.updateStats();

    res.status(201).json({
      success: true,
      data: {
        task,
        taskAnalysis
      },
      message: 'Multi-repository task created successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to create multi-repository task',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/multi-projects/:id/tasks/:taskId/execute
 * @desc    Execute a multi-repository task
 * @access  Private
 */
router.post('/:id/tasks/:taskId/execute', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    const task = await Task.findById(req.params.taskId);

    if (!project || !task) {
      return res.status(404).json({
        success: false,
        message: 'Project or task not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { userPreferences = {} } = req.body;

    // Execute multi-repository task
    const executionResult = await orchestrator.executeMultiRepoTask(
      project._id,
      task.description,
      project.repositories,
      userPreferences
    );

    // Update task with execution results
    task.status = 'review';
    
    // Update repository statuses based on execution results
    if (executionResult.executionResults) {
      Object.entries(executionResult.executionResults).forEach(([team, result]) => {
        const teamRepos = task.getRepositoriesByTeam(team);
        teamRepos.forEach(repo => {
          task.updateRepositoryStatus(repo.repositoryId, 'completed', {
            changes: result.changes,
            actualHours: result.estimatedTime || 0
          });
        });
      });
    }

    await task.save();

    res.json({
      success: true,
      data: {
        task,
        executionResult
      },
      message: 'Multi-repository task executed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to execute multi-repository task',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/multi-projects/:id/tasks/:taskId/diff
 * @desc    Get unified diff for a multi-repository task
 * @access  Private
 */
router.get('/:id/tasks/:taskId/diff', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    const task = await Task.findById(req.params.taskId);

    if (!project || !task) {
      return res.status(404).json({
        success: false,
        message: 'Project or task not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Generate unified diff
    const unifiedDiff = task.generateUnifiedDiff();

    if (!unifiedDiff) {
      return res.status(404).json({
        success: false,
        message: 'No changes found for this task'
      });
    }

    res.json({
      success: true,
      data: unifiedDiff
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to generate unified diff',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/multi-projects/:id/tasks/:taskId/approve
 * @desc    Approve and deploy changes across all repositories
 * @access  Private
 */
router.post('/:id/tasks/:taskId/approve', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    const task = await Task.findById(req.params.taskId);

    if (!project || !task) {
      return res.status(404).json({
        success: false,
        message: 'Project or task not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const { 
      deploymentStrategy = 'coordinated',
      approvedRepositories = [], // Which repositories to deploy
      commitMessage 
    } = req.body;

    // Deploy changes across repositories
    const deploymentResult = await orchestrator.deployMultiRepoChanges(
      project._id,
      task._id,
      {
        repositories: approvedRepositories,
        commitMessage: commitMessage || `${task.title} - Multi-repo deployment`,
        strategy: deploymentStrategy
      }
    );

    // Update task status
    task.status = 'done';
    
    // Update repository statuses
    task.repositories.forEach(repo => {
      if (approvedRepositories.includes(repo.repositoryName) || approvedRepositories.length === 0) {
        task.updateRepositoryStatus(repo.repositoryId, 'completed');
      }
    });

    await task.save();
    await project.updateStats();

    res.json({
      success: true,
      data: {
        task,
        deploymentResult
      },
      message: 'Changes approved and deployed successfully'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to approve and deploy changes',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/multi-projects/:id/repositories/:repoName/branches
 * @desc    Get branches for a specific repository
 * @access  Private
 */
router.get('/:id/repositories/:repoName/branches', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const repository = project.repositories.find(repo => repo.name === req.params.repoName);

    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found in project'
      });
    }

    const branches = await githubIntegration.getBranches({
      owner: repository.owner,
      name: repository.name,
      accessToken: repository.accessToken
    });

    res.json({
      success: true,
      data: branches
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch repository branches',
      error: error.message
    });
  }
});

/**
 * @route   GET /api/multi-projects/:id/repositories/:repoName/compare/:base/:head
 * @desc    Compare two branches in a repository
 * @access  Private
 */
router.get('/:id/repositories/:repoName/compare/:base/:head', authenticate, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Check ownership
    if (project.owner.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const repository = project.repositories.find(repo => repo.name === req.params.repoName);

    if (!repository) {
      return res.status(404).json({
        success: false,
        message: 'Repository not found in project'
      });
    }

    const comparison = await githubIntegration.compareBranches(
      {
        owner: repository.owner,
        name: repository.name,
        accessToken: repository.accessToken
      },
      req.params.base,
      req.params.head
    );

    res.json({
      success: true,
      data: comparison
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to compare branches',
      error: error.message
    });
  }
});

// Helper method to setup webhooks
async function setupProjectWebhooks(project) {
  const webhookUrl = `${process.env.BASE_URL}/api/webhooks/github`;
  
  for (const repository of project.repositories) {
    try {
      const webhook = await githubIntegration.createWebhook(
        {
          owner: repository.owner,
          name: repository.name,
          accessToken: repository.accessToken
        },
        webhookUrl,
        ['push', 'pull_request', 'pull_request_review']
      );

      repository.webhookId = webhook.id;
    } catch (error) {
      console.warn(`Failed to create webhook for ${repository.name}:`, error.message);
    }
  }

  await project.save();
}

module.exports = router;