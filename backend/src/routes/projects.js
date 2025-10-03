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

      // Validate educational project requirements
      if (!projectData.type || !['educational', 'learning-management', 'assessment', 'analytics'].includes(projectData.type)) {
        return res.status(400).json({
          success: false,
          message: 'Project type must be educational, learning-management, assessment, or analytics.'
        });
      }

      // Create project with ProjectManager
      const project = await projectManager.createProject(projectData, req.user._id);

      // Setup GitHub repository if requested
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
        message: 'Educational project created successfully.',
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