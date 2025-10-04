const Project = require('../models/Project');
const Task = require('../models/Task');
const Activity = require('../models/Activity');
const AgentOrchestrator = require('./AgentOrchestrator');

class ProjectManager {
  constructor() {
    this.orchestrator = new AgentOrchestrator();
  }

  /**
   * Create a new educational project
   */
  async createProject(projectData, userId) {
    try {
      const project = new Project({
        ...projectData,
        owner: userId,
        collaborators: []
      });

      await project.save();

      // Log project creation activity
      await Activity.logActivity({
        project: project._id,
        actor: userId,
        actorType: 'user',
        action: 'created',
        description: `Project "${project.name}" created`,
        educational: {
          learningOutcome: `New ${project.type} project established`,
          studentImpact: 'high'
        }
      });

      return project;
    } catch (error) {
      throw new Error(`Failed to create project: ${error.message}`);
    }
  }

  /**
   * Break down project features into manageable tasks
   */
  async createTasksFromFeatures(projectId, userId) {
    try {
      const project = await Project.findById(projectId);
      if (!project) {
        throw new Error('Project not found');
      }

      const tasks = [];

      for (const feature of project.features) {
        if (feature.status === 'backlog') {
          // Use Claude to analyze feature and create microtasks
          const taskBreakdown = await this.orchestrator.analyzeFeature(feature, project);
          
          for (const taskData of taskBreakdown.tasks) {
            const task = new Task({
              ...taskData,
              project: projectId,
              feature: feature.name,
              educationalImpact: {
                learningObjectives: taskBreakdown.learningObjectives,
                targetAudience: project.metadata.targetAudience,
                expectedOutcomes: taskBreakdown.expectedOutcomes
              }
            });

            await task.save();
            tasks.push(task);

            // Log task creation
            await Activity.logActivity({
              task: task._id,
              project: projectId,
              actor: 'project-manager',
              actorType: 'agent',
              agentType: 'project-manager',
              action: 'created',
              description: `Task "${task.title}" created from feature "${feature.name}"`,
              details: {
                complexity: task.complexity,
                estimatedHours: task.estimatedHours
              }
            });
          }

          // Update feature status
          feature.status = 'in-progress';
        }
      }

      await project.save();
      return tasks;
    } catch (error) {
      throw new Error(`Failed to create tasks: ${error.message}`);
    }
  }

  /**
   * Assign tasks to appropriate team members or agents
   */
  async assignTasks(projectId) {
    try {
      const project = await Project.findById(projectId).populate('collaborators.user');
      const unassignedTasks = await Task.find({
        project: projectId,
        status: 'backlog'
      });

      for (const task of unassignedTasks) {
        const assignment = await this.determineTaskAssignment(task, project);
        
        task.assignedTo = assignment.userId;
        task.assignedAgent = assignment.agentType;
        task.status = 'assigned';

        await task.save();

        // Log assignment
        await Activity.logActivity({
          task: task._id,
          project: projectId,
          actor: 'project-manager',
          actorType: 'agent',
          agentType: 'project-manager',
          action: 'assigned',
          description: `Task assigned to ${assignment.agentType}`,
          details: {
            assignedTo: assignment.userId,
            assignedAgent: assignment.agentType,
            reasoning: assignment.reasoning
          }
        });
      }

      return unassignedTasks.length;
    } catch (error) {
      throw new Error(`Failed to assign tasks: ${error.message}`);
    }
  }

  /**
   * Determine the best assignment for a task
   */
  async determineTaskAssignment(task, project) {
    const assignment = {
      userId: null,
      agentType: null,
      reasoning: ''
    };

    // Assignment logic based on complexity and type
    switch (task.complexity) {
      case 'simple':
        assignment.agentType = 'junior-developer';
        assignment.reasoning = 'Simple task suitable for junior developer';
        break;
      
      case 'moderate':
        if (task.type === 'testing' || task.type === 'compliance') {
          assignment.agentType = 'qa-engineer';
          assignment.reasoning = 'Testing/compliance task requires QA expertise';
        } else {
          assignment.agentType = 'junior-developer';
          assignment.reasoning = 'Moderate task with senior review';
        }
        break;
      
      case 'complex':
      case 'expert':
        if (task.type === 'testing') {
          assignment.agentType = 'qa-engineer';
          assignment.reasoning = 'Complex testing requires QA expertise';
        } else {
          assignment.agentType = 'senior-developer';
          assignment.reasoning = 'Complex task requires senior expertise';
        }
        break;
    }

    // Assignment is handled automatically by orchestration
    // No manual user assignment needed
    return assignment;
  }

  /**
   * Monitor project progress and handle escalations
   */
  async monitorProgress(projectId) {
    try {
      const project = await Project.findById(projectId);
      const tasks = await Task.find({ project: projectId });
      
      const metrics = {
        totalTasks: tasks.length,
        completedTasks: tasks.filter(t => t.status === 'done').length,
        inProgress: tasks.filter(t => t.status === 'in-progress').length,
        blocked: tasks.filter(t => t.status === 'blocked').length,
        overdue: tasks.filter(t => this.isTaskOverdue(t)).length
      };

      // Check for issues requiring escalation
      const escalations = [];

      // Tasks blocked too long
      const longBlockedTasks = tasks.filter(t => 
        t.status === 'blocked' && 
        this.getDaysInStatus(t, 'blocked') > 2
      );

      if (longBlockedTasks.length > 0) {
        escalations.push({
          type: 'blocked-tasks',
          severity: 'high',
          message: `${longBlockedTasks.length} tasks blocked for over 2 days`,
          tasks: longBlockedTasks.map(t => t._id)
        });
      }

      // Code review cycles too high
      const highReviewCycleTasks = tasks.filter(t => 
        t.codeReview.attempts > 2
      );

      if (highReviewCycleTasks.length > 0) {
        escalations.push({
          type: 'review-cycles',
          severity: 'medium',
          message: `${highReviewCycleTasks.length} tasks with excessive review cycles`,
          tasks: highReviewCycleTasks.map(t => t._id)
        });

        // Auto-escalate to senior developer
        for (const task of highReviewCycleTasks) {
          await this.escalateToSenior(task);
        }
      }

      // Compliance issues
      const complianceTasks = tasks.filter(t => 
        (t.compliance.ferpaReview.required && !t.compliance.ferpaReview.completed) ||
        (t.compliance.coppaReview.required && !t.compliance.coppaReview.completed)
      );

      if (complianceTasks.length > 0) {
        escalations.push({
          type: 'compliance',
          severity: 'critical',
          message: `${complianceTasks.length} tasks pending compliance review`,
          tasks: complianceTasks.map(t => t._id)
        });
      }

      return {
        metrics,
        escalations,
        healthScore: this.calculateProjectHealth(metrics, escalations)
      };
    } catch (error) {
      throw new Error(`Failed to monitor progress: ${error.message}`);
    }
  }

  /**
   * Escalate task to senior developer
   */
  async escalateToSenior(task) {
    try {
      const originalAgent = task.assignedAgent;
      task.assignedAgent = 'senior-developer';
      task.status = 'assigned';
      task.codeReview.attempts = 0; // Reset review attempts

      await task.save();

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: 'project-manager',
        actorType: 'agent',
        agentType: 'project-manager',
        action: 'updated',
        description: `Task escalated from ${originalAgent} to senior-developer`,
        details: {
          previousAgent: originalAgent,
          newAgent: 'senior-developer',
          escalationReason: 'High review cycle count'
        },
        educational: {
          learningOutcome: 'Quality assurance through senior expertise',
          studentImpact: 'high'
        }
      });

      return task;
    } catch (error) {
      throw new Error(`Failed to escalate task: ${error.message}`);
    }
  }

  /**
   * Generate educational impact report
   */
  async generateEducationalReport(projectId) {
    try {
      const project = await Project.findById(projectId);
      const tasks = await Task.find({ project: projectId });
      const activities = await Activity.find({ project: projectId });

      const report = {
        project: {
          name: project.name,
          type: project.type,
          targetAudience: project.metadata.targetAudience,
          compliance: project.compliance
        },
        progress: {
          completionRate: (tasks.filter(t => t.status === 'done').length / tasks.length) * 100,
          totalFeatures: project.features.length,
          completedFeatures: project.features.filter(f => f.status === 'done').length
        },
        educationalImpact: {
          learningObjectives: [...new Set(tasks.flatMap(t => t.educationalImpact.learningObjectives || []))],
          accessibilityCompliance: this.assessAccessibilityCompliance(tasks),
          lmsIntegrations: project.lmsIntegrations.filter(lms => lms.enabled),
          complianceStatus: {
            ferpa: tasks.every(t => !t.compliance.ferpaReview.required || t.compliance.ferpaReview.completed),
            coppa: tasks.every(t => !t.compliance.coppaReview.required || t.compliance.coppaReview.completed)
          }
        },
        teamPerformance: await this.calculateTeamMetrics(activities),
        qualityMetrics: this.calculateQualityMetrics(tasks)
      };

      return report;
    } catch (error) {
      throw new Error(`Failed to generate report: ${error.message}`);
    }
  }

  // Helper methods
  isTaskOverdue(task) {
    if (!task.estimatedHours || !task.createdAt) return false;
    const estimatedCompletionDate = new Date(task.createdAt);
    estimatedCompletionDate.setHours(estimatedCompletionDate.getHours() + task.estimatedHours);
    return new Date() > estimatedCompletionDate && task.status !== 'done';
  }

  getDaysInStatus(task, status) {
    const activities = task.activities || [];
    const statusActivity = activities.find(a => a.details && a.details.newStatus === status);
    if (!statusActivity) return 0;
    return Math.floor((new Date() - statusActivity.createdAt) / (1000 * 60 * 60 * 24));
  }

  calculateProjectHealth(metrics, escalations) {
    let score = 100;
    
    // Deduct points for issues
    score -= escalations.filter(e => e.severity === 'critical').length * 30;
    score -= escalations.filter(e => e.severity === 'high').length * 20;
    score -= escalations.filter(e => e.severity === 'medium').length * 10;
    
    // Deduct for low completion rate
    const completionRate = (metrics.completedTasks / metrics.totalTasks) * 100;
    if (completionRate < 50) score -= 20;
    else if (completionRate < 75) score -= 10;
    
    return Math.max(0, score);
  }

  assessAccessibilityCompliance(tasks) {
    const accessibilityTasks = tasks.filter(t => t.testing.accessibilityTests.required);
    const passedTasks = accessibilityTasks.filter(t => t.testing.accessibilityTests.status === 'passed');
    
    return {
      total: accessibilityTasks.length,
      passed: passedTasks.length,
      compliance: accessibilityTasks.length > 0 ? (passedTasks.length / accessibilityTasks.length) * 100 : 100
    };
  }

  async calculateTeamMetrics(activities) {
    const agentMetrics = {};
    
    for (const activity of activities) {
      if (activity.agentType) {
        if (!agentMetrics[activity.agentType]) {
          agentMetrics[activity.agentType] = {
            tasksCompleted: 0,
            averageExecutionTime: 0,
            successRate: 0,
            activities: []
          };
        }
        agentMetrics[activity.agentType].activities.push(activity);
      }
    }
    
    // Calculate metrics for each agent type
    for (const [agentType, data] of Object.entries(agentMetrics)) {
      const completedTasks = data.activities.filter(a => a.action === 'completed');
      data.tasksCompleted = completedTasks.length;
      
      const executionTimes = data.activities
        .map(a => a.details?.claudeExecution?.executionTime)
        .filter(t => t);
      data.averageExecutionTime = executionTimes.length > 0 
        ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length 
        : 0;
        
      const successfulExecutions = data.activities.filter(a => a.details?.claudeExecution?.success);
      data.successRate = data.activities.length > 0 
        ? (successfulExecutions.length / data.activities.length) * 100 
        : 100;
    }
    
    return agentMetrics;
  }

  calculateQualityMetrics(tasks) {
    const metrics = {
      averageReviewCycles: 0,
      testCoverage: 0,
      complianceRate: 0,
      bugRate: 0
    };

    if (tasks.length === 0) return metrics;

    // Average review cycles
    const reviewCycles = tasks.map(t => t.codeReview.attempts || 0);
    metrics.averageReviewCycles = reviewCycles.reduce((a, b) => a + b, 0) / tasks.length;

    // Test coverage
    const coverageValues = tasks
      .map(t => t.testing.unitTests.coverage)
      .filter(c => c !== undefined);
    metrics.testCoverage = coverageValues.length > 0 
      ? coverageValues.reduce((a, b) => a + b, 0) / coverageValues.length 
      : 0;

    // Compliance rate
    const complianceTasks = tasks.filter(t => 
      t.compliance.ferpaReview.required || t.compliance.coppaReview.required
    );
    const compliantTasks = complianceTasks.filter(t => 
      (!t.compliance.ferpaReview.required || t.compliance.ferpaReview.completed) &&
      (!t.compliance.coppaReview.required || t.compliance.coppaReview.completed)
    );
    metrics.complianceRate = complianceTasks.length > 0 
      ? (compliantTasks.length / complianceTasks.length) * 100 
      : 100;

    // Bug rate (bugs vs total tasks)
    const bugTasks = tasks.filter(t => t.type === 'bug');
    metrics.bugRate = (bugTasks.length / tasks.length) * 100;

    return metrics;
  }
}

module.exports = ProjectManager;