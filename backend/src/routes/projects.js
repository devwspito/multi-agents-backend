const express = require('express');
const Project = require('../models/Project');
const Task = require('../models/Task');
const Activity = require('../models/Activity');
const ProjectManager = require('../services/ProjectManager');
const AgentOrchestrator = require('../services/AgentOrchestrator');
const GitHubService = require('../services/GitHubService');
const {
  authenticate,
  authorize,
  checkPermission,
  checkProjectAccess,
  protectData,
  auditLog,
  validateRequestData
} = require('../middleware/auth');

const router = express.Router();
const projectManager = new ProjectManager();
const orchestrator = new AgentOrchestrator();
const githubService = new GitHubService();

/**
 * @route   GET /api/projects
 * @desc    Get all projects for the authenticated user
 * @access  Private
 */
router.get('/',
  authenticate,
  protectData,
  async (req, res) => {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        type,
        search
      } = req.query;

      const query = {};

      // Filter by user access (owner or collaborator)
      query.$or = [
        { owner: req.user._id },
        { 'collaborators.user': req.user._id }
      ];

      // Apply filters
      if (status) query.status = status;
      if (type) query.type = type;
      if (search) {
        query.$and = [
          query.$or ? { $or: query.$or } : {},
          {
            $or: [
              { name: { $regex: search, $options: 'i' } },
              { description: { $regex: search, $options: 'i' } }
            ]
          }
        ];
        delete query.$or;
      }

      const projects = await Project.find(query)
        .populate('owner', 'username profile.firstName profile.lastName')
        .populate('collaborators.user', 'username profile.firstName profile.lastName')
        .sort({ updatedAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .lean();

      const total = await Project.countDocuments(query);

      // Get additional stats for each project
      const projectsWithStats = await Promise.all(
        projects.map(async (project) => {
          const tasks = await Task.find({ project: project._id });
          
          return {
            ...project,
            stats: {
              totalTasks: tasks.length,
              completedTasks: tasks.filter(t => t.status === 'done').length,
              inProgressTasks: tasks.filter(t => t.status === 'in-progress').length,
              blockedTasks: tasks.filter(t => t.status === 'blocked').length,
              progress: tasks.length > 0 ? 
                (tasks.filter(t => t.status === 'done').length / tasks.length) * 100 : 0
            }
          };
        })
      );

      res.json({
        success: true,
        data: {
          projects: projectsWithStats,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / limit),
            totalItems: total,
            itemsPerPage: parseInt(limit)
          }
        }
      });
    } catch (error) {
      console.error('Get projects error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving projects.'
      });
    }
  }
);

/**
 * @route   POST /api/projects
 * @desc    Create a new educational project
 * @access  Private
 */
router.post('/',
  authenticate,
  checkPermission('projects', 'create'),
  validateRequestData,
  auditLog('project_creation'),
  async (req, res) => {
    try {
      const projectData = {
        ...req.body,
        owner: req.user._id
      };

      // Validate project type
      const validTypes = ['web-app', 'mobile-app', 'api', 'microservice', 'library', 'saas', 'educational', 'learning-management', 'assessment', 'analytics'];
      if (!projectData.type || !validTypes.includes(projectData.type)) {
        return res.status(400).json({
          success: false,
          message: `Project type must be one of: ${validTypes.join(', ')}.`
        });
      }

      // Create project with ProjectManager
      const project = await projectManager.createProject(projectData, req.user._id);

      // Process repositories if provided
      if (req.body.repositories && Array.isArray(req.body.repositories)) {
        for (const repoData of req.body.repositories) {
          try {
            // Infer repository type from language or user-provided type
            const inferredType = inferRepositoryType(repoData.language);

            const repositoryToAdd = {
              name: repoData.name,
              githubUrl: repoData.clone_url || repoData.ssh_url,
              owner: repoData.full_name?.split('/')[0] || req.user.username,
              branch: repoData.default_branch || 'main',
              type: repoData.type || inferredType,
              technologies: repoData.language ? [repoData.language] : [],
              isActive: true
            };

            project.repositories.push(repositoryToAdd);
          } catch (repoError) {
            console.warn(`Failed to add repository ${repoData.name}:`, repoError.message);
            // Continue adding other repositories
          }
        }

        await project.save();
      }

      // Setup GitHub repository if requested (legacy support)
      if (req.body.createRepository) {
        try {
          const repo = await githubService.createRepository(project, req.body.organization);
          project.repository = {
            url: repo.html_url,
            branch: 'main'
          };
          await project.save();
        } catch (repoError) {
          console.warn('Failed to create repository:', repoError.message);
          // Continue without repository - user can add it later
        }
      }

      // Populate project data for response
      await project.populate('owner', 'username profile.firstName profile.lastName');
      await project.populate('collaborators.user', 'username profile.firstName profile.lastName');

      res.status(201).json({
        success: true,
        message: 'Project created successfully.',
        data: { project }
      });
    } catch (error) {
      console.error('Create project error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error creating project.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Helper function to infer repository type from language
function inferRepositoryType(language) {
  const typeMapping = {
    'JavaScript': 'frontend',
    'TypeScript': 'frontend',
    'Python': 'backend',
    'Java': 'backend',
    'Go': 'backend',
    'Rust': 'backend',
    'Swift': 'mobile',
    'Kotlin': 'mobile',
    'Dart': 'mobile',
    'HTML': 'frontend',
    'CSS': 'frontend',
    'Dockerfile': 'infrastructure',
    'Shell': 'infrastructure'
  };

  return typeMapping[language] || 'backend';
}

/**
 * @route   GET /api/projects/:id
 * @desc    Get project details
 * @access  Private
 */
router.get('/:id',
  authenticate,
  checkProjectAccess,
  protectData,
  async (req, res) => {
    try {
      const project = req.project;
      
      // Get project tasks
      const tasks = await Task.find({ project: project._id })
        .populate('assignedTo', 'username profile.firstName profile.lastName')
        .sort({ createdAt: -1 });

      // Get recent activities
      const activities = await Activity.find({ project: project._id })
        .sort({ createdAt: -1 })
        .limit(20);

      // Get repository stats if repository exists
      let repositoryStats = null;
      if (project.repository?.url) {
        try {
          const [owner, repo] = project.repository.url.match(/github\.com\/([^\/]+)\/([^\/]+)/).slice(1);
          repositoryStats = await githubService.getRepositoryStats(owner, repo.replace('.git', ''));
        } catch (repoError) {
          console.warn('Failed to get repository stats:', repoError.message);
        }
      }

      // Calculate project metrics
      const metrics = {
        tasks: {
          total: tasks.length,
          byStatus: tasks.reduce((acc, task) => {
            acc[task.status] = (acc[task.status] || 0) + 1;
            return acc;
          }, {}),
          byComplexity: tasks.reduce((acc, task) => {
            acc[task.complexity] = (acc[task.complexity] || 0) + 1;
            return acc;
          }, {}),
          byType: tasks.reduce((acc, task) => {
            acc[task.type] = (acc[task.type] || 0) + 1;
            return acc;
          }, {})
        },
        features: {
          total: project.features.length,
          completed: project.features.filter(f => f.status === 'done').length,
          inProgress: project.features.filter(f => f.status === 'in-progress').length
        },
        collaborators: {
          total: project.collaborators?.length || 0
        }
      };

      res.json({
        success: true,
        data: {
          project,
          tasks,
          activities,
          metrics,
          repositoryStats
        }
      });
    } catch (error) {
      console.error('Get project error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving project.'
      });
    }
  }
);

/**
 * @route   PUT /api/projects/:id
 * @desc    Update project
 * @access  Private
 */
router.put('/:id',
  authenticate,
  checkProjectAccess,
  checkPermission('projects', 'update'),
  validateRequestData,
  auditLog('project_update'),
  async (req, res) => {
    try {
      const project = req.project;
      const updateData = req.body;

      // Prevent updating certain fields
      delete updateData.owner;
      delete updateData._id;
      delete updateData.createdAt;

      // Update project
      Object.assign(project, updateData);
      await project.save();

      await project.populate('owner', 'username profile.firstName profile.lastName');
      await project.populate('collaborators.user', 'username profile.firstName profile.lastName');

      res.json({
        success: true,
        message: 'Project updated successfully.',
        data: { project }
      });
    } catch (error) {
      console.error('Update project error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error updating project.'
      });
    }
  }
);

/**
 * @route   DELETE /api/projects/:id
 * @desc    Delete project
 * @access  Private
 */
router.delete('/:id',
  authenticate,
  checkProjectAccess,
  checkPermission('projects', 'delete'),
  auditLog('project_deletion'),
  async (req, res) => {
    try {
      const project = req.project;

      // Check if user is project owner
      if (project.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Only project owner can delete the project.'
        });
      }

      // Delete associated tasks and activities
      await Task.deleteMany({ project: project._id });
      await Activity.deleteMany({ project: project._id });

      // Delete project
      await Project.findByIdAndDelete(project._id);

      res.json({
        success: true,
        message: 'Project deleted successfully.'
      });
    } catch (error) {
      console.error('Delete project error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error deleting project.'
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/features/:featureIndex/implement
 * @desc    Implement a project feature using autonomous agents
 * @access  Private
 */
router.post('/:id/features/:featureIndex/implement',
  authenticate,
  checkProjectAccess,
  checkPermission('tasks', 'create'),
  auditLog('feature_implementation'),
  async (req, res) => {
    try {
      const project = req.project;
      const featureIndex = parseInt(req.params.featureIndex);
      
      if (featureIndex < 0 || featureIndex >= project.features.length) {
        return res.status(400).json({
          success: false,
          message: 'Invalid feature index.'
        });
      }

      const feature = project.features[featureIndex];
      
      if (feature.status !== 'backlog') {
        return res.status(400).json({
          success: false,
          message: 'Feature must be in backlog status to implement.'
        });
      }

      // Start autonomous implementation workflow
      const workflowResult = await orchestrator.orchestrateFeatureWorkflow(
        project,
        feature,
        req.user._id
      );

      // Update feature status
      project.features[featureIndex].status = 'in-progress';
      await project.save();

      res.json({
        success: true,
        message: 'Feature implementation workflow started.',
        data: {
          workflowId: workflowResult.workflowId,
          tasksCreated: workflowResult.tasks?.length || 0,
          estimatedCompletion: this.calculateEstimatedCompletion(workflowResult.tasks)
        }
      });
    } catch (error) {
      console.error('Feature implementation error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error starting feature implementation.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/tasks/create-from-features
 * @desc    Create tasks from project features
 * @access  Private
 */
router.post('/:id/tasks/create-from-features',
  authenticate,
  checkProjectAccess,
  checkPermission('tasks', 'create'),
  auditLog('tasks_from_features'),
  async (req, res) => {
    try {
      const project = req.project;
      
      // Use ProjectManager to create tasks from features
      const tasks = await projectManager.createTasksFromFeatures(project._id, req.user._id);

      res.json({
        success: true,
        message: `${tasks.length} tasks created from project features.`,
        data: { 
          tasks,
          summary: {
            totalTasks: tasks.length,
            byComplexity: tasks.reduce((acc, task) => {
              acc[task.complexity] = (acc[task.complexity] || 0) + 1;
              return acc;
            }, {}),
            estimatedHours: tasks.reduce((sum, task) => sum + (task.estimatedHours || 0), 0)
          }
        }
      });
    } catch (error) {
      console.error('Create tasks from features error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error creating tasks from features.'
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/assign-tasks
 * @desc    Auto-assign tasks to appropriate team members/agents
 * @access  Private
 */
router.post('/:id/assign-tasks',
  authenticate,
  checkProjectAccess,
  checkPermission('tasks', 'assign'),
  auditLog('task_assignment'),
  async (req, res) => {
    try {
      const project = req.project;
      
      const assignedCount = await projectManager.assignTasks(project._id);

      res.json({
        success: true,
        message: `${assignedCount} tasks assigned successfully.`,
        data: { assignedCount }
      });
    } catch (error) {
      console.error('Assign tasks error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error assigning tasks.'
      });
    }
  }
);

/**
 * @route   GET /api/projects/:id/progress
 * @desc    Get detailed project progress monitoring
 * @access  Private
 */
router.get('/:id/progress',
  authenticate,
  checkProjectAccess,
  async (req, res) => {
    try {
      const project = req.project;
      
      const progressData = await projectManager.monitorProgress(project._id);

      res.json({
        success: true,
        data: {
          project: {
            id: project._id,
            name: project.name,
            status: project.status
          },
          ...progressData
        }
      });
    } catch (error) {
      console.error('Get progress error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving progress data.'
      });
    }
  }
);

/**
 * @route   GET /api/projects/:id/educational-report
 * @desc    Generate comprehensive educational impact report
 * @access  Private
 */
router.get('/:id/educational-report',
  authenticate,
  checkProjectAccess,
  protectData,
  async (req, res) => {
    try {
      const project = req.project;
      
      const report = await projectManager.generateEducationalReport(project._id);

      res.json({
        success: true,
        data: { report }
      });
    } catch (error) {
      console.error('Educational report error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error generating educational report.'
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/repositories
 * @desc    Add repository to existing project
 * @access  Private
 */
router.post('/:id/repositories',
  authenticate,
  checkProjectAccess,
  auditLog('repository_added'),
  async (req, res) => {
    try {
      const project = req.project;
      const { id, name, full_name, clone_url, ssh_url, default_branch, language, type } = req.body;

      // Validate required fields
      if (!name || (!clone_url && !ssh_url)) {
        return res.status(400).json({
          success: false,
          message: 'Repository name and URL (clone_url or ssh_url) are required.'
        });
      }

      // Check if repository already exists in project
      const existingRepo = project.repositories.find(
        repo => repo.githubUrl === clone_url || repo.githubUrl === ssh_url
      );

      if (existingRepo) {
        return res.status(400).json({
          success: false,
          message: 'Repository already exists in this project.'
        });
      }

      // Infer repository type from language if not provided
      const inferredType = type || inferRepositoryType(language);

      // Add repository to project
      const newRepository = {
        name: name,
        githubUrl: clone_url || ssh_url,
        owner: full_name?.split('/')[0] || req.user.username,
        branch: default_branch || 'main',
        type: inferredType,
        technologies: language ? [language] : [],
        isActive: true,
        syncStatus: 'pending'
      };

      project.repositories.push(newRepository);
      await project.save();

      // Log activity
      await Activity.logActivity({
        project: project._id,
        actor: req.user.username,
        actorType: 'user',
        action: 'repository_added',
        description: `Repository "${name}" added to project`,
        details: {
          repositoryName: name,
          repositoryType: inferredType,
          language: language
        }
      });

      res.status(201).json({
        success: true,
        message: 'Repository added successfully.',
        data: {
          project: {
            _id: project._id,
            name: project.name,
            repositories: project.repositories
          }
        }
      });

    } catch (error) {
      console.error('Add repository error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error adding repository.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/repositories/:repoId/reconnect
 * @desc    Reconnect a disconnected repository
 * @access  Private
 */
router.post('/:id/repositories/:repoId/reconnect',
  authenticate,
  checkProjectAccess,
  auditLog('repository_reconnect'),
  async (req, res) => {
    try {
      const project = req.project;
      const { repoId } = req.params;

      // Find repository in project
      const repository = project.repositories.id(repoId);

      if (!repository) {
        return res.status(404).json({
          success: false,
          message: 'Repository not found in this project.'
        });
      }

      // Get user's GitHub access token
      const user = await User.findById(req.user._id).select('+github.accessToken');

      if (!user.github || !user.github.accessToken) {
        return res.status(400).json({
          success: false,
          message: 'GitHub account not connected. Please connect your GitHub account first.'
        });
      }

      try {
        // Initialize Octokit with user's token
        const { Octokit } = require('@octokit/rest');
        const octokit = new Octokit({
          auth: user.github.accessToken
        });

        // Extract owner and repo name from GitHub URL
        const urlMatch = repository.githubUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);

        if (!urlMatch) {
          return res.status(400).json({
            success: false,
            message: 'Invalid GitHub repository URL.'
          });
        }

        const [, owner, repoName] = urlMatch;

        // Test access by fetching repository info
        const { data: repoInfo } = await octokit.rest.repos.get({
          owner,
          repo: repoName
        });

        // Update repository status
        repository.isActive = true;
        repository.syncStatus = 'synced';
        repository.lastSync = new Date();

        // Update metadata if available
        if (repoInfo) {
          repository.metadata = {
            ...repository.metadata,
            hasTests: false, // Can be detected by analyzing repo structure
            hasCI: false,
            languages: {} // Can be fetched with octokit.rest.repos.listLanguages
          };
        }

        await project.save();

        // Log activity
        await Activity.logActivity({
          project: project._id,
          actor: req.user.username,
          actorType: 'user',
          action: 'repository_reconnected',
          description: `Repository "${repository.name}" reconnected successfully`,
          details: {
            repositoryName: repository.name,
            owner: owner,
            syncStatus: 'synced'
          }
        });

        res.json({
          success: true,
          message: 'Repository reconnected successfully.',
          data: {
            repository: {
              _id: repository._id,
              name: repository.name,
              isActive: repository.isActive,
              syncStatus: repository.syncStatus,
              lastSync: repository.lastSync
            }
          }
        });

      } catch (githubError) {
        console.error('GitHub API error:', githubError);

        // Update repository as disconnected
        repository.isActive = false;
        repository.syncStatus = 'error';
        await project.save();

        const errorMessage = githubError.status === 404
          ? 'Repository not found or no access. Please check permissions.'
          : githubError.status === 401
          ? 'GitHub authentication failed. Please reconnect your GitHub account.'
          : 'Failed to access repository. Please check your GitHub permissions.';

        return res.status(400).json({
          success: false,
          message: errorMessage,
          error: process.env.NODE_ENV === 'development' ? githubError.message : undefined
        });
      }

    } catch (error) {
      console.error('Reconnect repository error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error reconnecting repository.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route   POST /api/projects/:id/collaborators
 * @desc    Add collaborator to project
 * @access  Private
 */
router.post('/:id/collaborators',
  authenticate,
  checkProjectAccess,
  authorize('admin', 'manager'),
  auditLog('collaborator_added'),
  async (req, res) => {
    try {
      const project = req.project;
      const { userId, role } = req.body;

      if (!userId) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required.'
        });
      }

      const validRoles = ['owner', 'contributor', 'viewer'];
      const collaboratorRole = role || 'contributor';

      if (!validRoles.includes(collaboratorRole)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid role specified. Valid roles: owner, contributor, viewer.'
        });
      }

      // Check if user is already a collaborator
      const existingMember = project.collaborators.find(member =>
        member.user.toString() === userId
      );

      if (existingMember) {
        return res.status(400).json({
          success: false,
          message: 'User is already a collaborator.'
        });
      }

      // Add collaborator
      project.collaborators.push({ user: userId, role: collaboratorRole });
      await project.save();

      await project.populate('collaborators.user', 'username profile.firstName profile.lastName');

      res.json({
        success: true,
        message: 'Collaborator added successfully.',
        data: { collaborators: project.collaborators }
      });
    } catch (error) {
      console.error('Add collaborator error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error adding collaborator.'
      });
    }
  }
);

// Helper function to calculate estimated completion
const calculateEstimatedCompletion = (tasks) => {
  if (!tasks || tasks.length === 0) return null;
  
  const totalHours = tasks.reduce((sum, task) => sum + (task.estimatedHours || 0), 0);
  const averageHoursPerDay = 6; // Assuming 6 productive hours per day
  
  const estimatedDays = Math.ceil(totalHours / averageHoursPerDay);
  const completionDate = new Date();
  completionDate.setDate(completionDate.getDate() + estimatedDays);
  
  return {
    totalHours,
    estimatedDays,
    completionDate: completionDate.toISOString().split('T')[0]
  };
};

module.exports = router;