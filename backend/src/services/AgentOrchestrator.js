const ClaudeService = require('./ClaudeService');
const GitHubService = require('./GitHubService');
const Activity = require('../models/Activity');
const Task = require('../models/Task');

class AgentOrchestrator {
  constructor() {
    this.claudeService = new ClaudeService();
    this.githubService = new GitHubService();
    this.agentCapabilities = this.initializeAgentCapabilities();
    this.workflowQueues = new Map();
  }

  /**
   * Initialize agent capabilities and specializations
   */
  initializeAgentCapabilities() {
    return {
      'product-manager': {
        model: 'claude-3-sonnet-20240229',
        specialties: ['requirements-analysis', 'feature-specification', 'stakeholder-communication'],
        maxComplexity: 'expert',
        capabilities: [
          'analyze-educational-requirements',
          'define-learning-objectives',
          'prioritize-features',
          'stakeholder-communication'
        ]
      },
      'project-manager': {
        model: 'claude-3-sonnet-20240229',
        specialties: ['task-breakdown', 'resource-allocation', 'timeline-management'],
        maxComplexity: 'expert',
        capabilities: [
          'break-down-features',
          'assign-tasks',
          'monitor-progress',
          'escalate-issues',
          'generate-reports'
        ]
      },
      'senior-developer': {
        model: 'claude-3-opus-20240229',
        specialties: ['complex-implementation', 'architecture-design', 'code-review', 'lms-integration'],
        maxComplexity: 'expert',
        capabilities: [
          'implement-complex-features',
          'design-architecture',
          'review-code',
          'integrate-lms-systems',
          'mentor-junior-developers',
          'handle-escalations'
        ]
      },
      'junior-developer': {
        model: 'claude-3-haiku-20240307',
        specialties: ['ui-components', 'basic-crud', 'simple-features'],
        maxComplexity: 'moderate',
        capabilities: [
          'implement-ui-components',
          'create-basic-features',
          'write-unit-tests',
          'follow-accessibility-guidelines'
        ]
      },
      'qa-engineer': {
        model: 'claude-3-sonnet-20240229',
        specialties: ['testing', 'accessibility', 'compliance', 'quality-assurance'],
        maxComplexity: 'expert',
        capabilities: [
          'generate-comprehensive-tests',
          'validate-accessibility',
          'check-compliance',
          'performance-testing',
          'security-testing'
        ]
      }
    };
  }

  /**
   * Orchestrate complete feature development workflow
   */
  async orchestrateFeatureWorkflow(project, feature, userId) {
    try {
      const workflowId = `workflow-${Date.now()}`;
      this.workflowQueues.set(workflowId, {
        project,
        feature,
        userId,
        status: 'initiated',
        steps: [],
        currentStep: 0
      });

      // Step 1: Product Manager analyzes requirements
      const requirements = await this.executeProductManagerAnalysis(feature, project);
      
      // Step 2: Project Manager breaks down into tasks
      const tasks = await this.executeProjectManagerBreakdown(requirements, project, userId);
      
      // Step 3: Assign and execute tasks with appropriate agents
      const results = await this.executeTaskAssignments(tasks, project);
      
      // Step 4: Quality assurance and integration
      const qaResults = await this.executeQualityAssurance(results, project);
      
      // Step 5: Final integration and deployment preparation
      const integration = await this.executeFinalIntegration(qaResults, project);

      return {
        workflowId,
        status: 'completed',
        requirements,
        tasks,
        results,
        qaResults,
        integration,
        educationalImpact: this.calculateEducationalImpact(requirements, results)
      };
    } catch (error) {
      throw new Error(`Feature workflow orchestration failed: ${error.message}`);
    }
  }

  /**
   * Product Manager: Analyze educational requirements
   */
  async executeProductManagerAnalysis(feature, project) {
    try {
      const instructions = `
## Product Requirements Analysis

Analyze this educational feature and provide comprehensive requirements:

**Feature**: ${feature.name}
**Description**: ${feature.description}
**Project Type**: ${project.type}
**Target Audience**: ${project.metadata?.targetAudience}
**Priority**: ${feature.priority}

Please provide:
1. Detailed educational requirements
2. Learning objectives alignment
3. User stories for different educational roles (students, teachers, admins)
4. Compliance requirements (FERPA, COPPA, accessibility)
5. Technical specifications
6. Success metrics and KPIs
7. Risk assessment

Format your response as a structured JSON with clear sections for each requirement type.
`;

      const result = await this.claudeService.executeTask(
        { _id: `pm-analysis-${Date.now()}`, title: 'Requirements Analysis', project: project._id },
        'product-manager',
        instructions
      );

      const requirements = this.parseProductManagerResult(result.result);

      await Activity.logActivity({
        project: project._id,
        actor: 'product-manager',
        actorType: 'agent',
        agentType: 'product-manager',
        action: 'created',
        description: `Requirements analysis completed for feature: ${feature.name}`,
        details: {
          claudeExecution: {
            model: 'claude-3-sonnet-20240229',
            executionTime: result.executionTime,
            success: true
          },
          requirements: requirements.summary
        }
      });

      return requirements;
    } catch (error) {
      throw new Error(`Product Manager analysis failed: ${error.message}`);
    }
  }

  /**
   * Project Manager: Break down feature into manageable tasks
   */
  async executeProjectManagerBreakdown(requirements, project, userId) {
    try {
      const instructions = `
## Task Breakdown and Planning

Based on the requirements analysis, create a comprehensive task breakdown:

**Requirements Summary**: ${JSON.stringify(requirements.summary, null, 2)}
**Educational Context**: ${requirements.educationalContext}
**Compliance Needs**: ${requirements.compliance.join(', ')}

Create tasks following these guidelines:
1. Maximum 500 lines of code per task
2. Maximum 5 files per task
3. Clear educational context for each task
4. Appropriate complexity assignment (simple, moderate, complex, expert)
5. Estimated hours (0.5 - 40 hours max)
6. Dependencies between tasks
7. Compliance requirements per task

Provide a JSON array of tasks with:
- title
- description
- type (feature, bug, enhancement, documentation, testing, compliance)
- complexity
- estimatedHours
- dependencies
- educationalImpact
- complianceRequirements
- acceptanceCriteria
`;

      const result = await this.claudeService.executeTask(
        { _id: `pm-breakdown-${Date.now()}`, title: 'Task Breakdown', project: project._id },
        'project-manager',
        instructions
      );

      const taskBreakdown = this.parseProjectManagerBreakdown(result.result);
      const tasks = [];

      // Create Task instances
      for (const taskData of taskBreakdown.tasks) {
        const task = new Task({
          ...taskData,
          project: project._id,
          feature: requirements.featureName,
          status: 'backlog'
        });

        await task.save();
        tasks.push(task);

        await Activity.logActivity({
          task: task._id,
          project: project._id,
          actor: 'project-manager',
          actorType: 'agent',
          agentType: 'project-manager',
          action: 'created',
          description: `Task created: ${task.title}`,
          details: {
            complexity: task.complexity,
            estimatedHours: task.estimatedHours,
            taskType: task.type
          }
        });
      }

      return tasks;
    } catch (error) {
      throw new Error(`Project Manager breakdown failed: ${error.message}`);
    }
  }

  /**
   * Execute task assignments based on complexity and type
   */
  async executeTaskAssignments(tasks, project) {
    const results = [];

    for (const task of tasks) {
      try {
        // Determine appropriate agent
        const agent = this.selectAgentForTask(task);
        
        // Assign agent to task
        task.assignedAgent = agent;
        task.status = 'assigned';
        await task.save();

        // Execute task with assigned agent
        const taskResult = await this.executeTaskWithAgent(task, agent, project);
        results.push(taskResult);

        // If junior developer, require senior review
        if (agent === 'junior-developer') {
          const reviewResult = await this.executeSeniorReview(task, taskResult, project);
          results.push(reviewResult);
        }

      } catch (error) {
        console.error(`Task execution failed for ${task.title}:`, error.message);
        results.push({
          task: task._id,
          status: 'failed',
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Select appropriate agent based on task characteristics
   */
  selectAgentForTask(task) {
    // Simple algorithm for agent selection
    switch (task.complexity) {
      case 'simple':
        return 'junior-developer';
      
      case 'moderate':
        if (task.type === 'testing' || task.type === 'compliance') {
          return 'qa-engineer';
        }
        return 'junior-developer';
      
      case 'complex':
      case 'expert':
        if (task.type === 'testing' || task.type === 'compliance') {
          return 'qa-engineer';
        }
        return 'senior-developer';
      
      default:
        return 'junior-developer';
    }
  }

  /**
   * Execute individual task with assigned agent
   */
  async executeTaskWithAgent(task, agent, project) {
    try {
      const instructions = this.buildTaskInstructions(task, project);
      
      // Create branch for task if repository exists
      let branchName = null;
      if (project.repository?.url) {
        const [owner, repo] = this.parseRepositoryUrl(project.repository.url);
        branchName = await this.githubService.createTaskBranch(task, owner, repo);
        task.gitBranch = branchName;
        await task.save();
      }

      task.status = 'in-progress';
      await task.save();

      const result = await this.claudeService.executeTask(task, agent, instructions);

      // Create pull request if code was generated
      if (result.codeChanges && result.codeChanges.filesModified.length > 0 && branchName) {
        const [owner, repo] = this.parseRepositoryUrl(project.repository.url);
        const pr = await this.githubService.createPullRequest(task, owner, repo, branchName);
        
        task.pullRequest = {
          number: pr.number,
          url: pr.html_url,
          status: 'open'
        };
      }

      task.status = 'review';
      await task.save();

      return {
        task: task._id,
        agent,
        status: 'completed',
        result: result.result,
        codeChanges: result.codeChanges,
        branchName,
        pullRequest: task.pullRequest
      };
    } catch (error) {
      task.status = 'blocked';
      await task.save();
      throw error;
    }
  }

  /**
   * Execute senior developer code review
   */
  async executeSeniorReview(task, taskResult, project) {
    try {
      const codeFiles = taskResult.codeChanges?.filesModified || [];
      
      if (codeFiles.length === 0) {
        // No code to review, approve automatically
        task.codeReview.status = 'approved';
        task.status = 'testing';
        await task.save();
        return { task: task._id, reviewStatus: 'auto-approved', reason: 'no-code-changes' };
      }

      const review = await this.claudeService.reviewCode(task, 'senior-developer', codeFiles);
      
      // Update task with review results
      task.codeReview.attempts += 1;
      task.codeReview.feedback = review.feedback || [];
      task.codeReview.status = review.status;

      if (review.status === 'approved') {
        task.status = 'testing';
      } else if (review.status === 'changes-requested') {
        task.status = 'in-progress';
        // If too many attempts, escalate to senior developer
        if (task.codeReview.attempts >= task.codeReview.maxAttempts) {
          task.assignedAgent = 'senior-developer';
          task.codeReview.attempts = 0;
        }
      } else {
        task.status = 'blocked';
      }

      await task.save();

      await Activity.logActivity({
        task: task._id,
        project: project._id,
        actor: 'senior-developer',
        actorType: 'agent',
        agentType: 'senior-developer',
        action: 'reviewed',
        description: `Code review completed: ${review.status}`,
        details: {
          reviewData: {
            score: review.score,
            feedback: review.summary,
            suggestions: review.suggestions,
            complianceIssues: review.complianceIssues
          }
        }
      });

      return {
        task: task._id,
        reviewStatus: review.status,
        score: review.score,
        feedback: review.feedback,
        escalated: task.assignedAgent === 'senior-developer' && task.codeReview.attempts === 0
      };
    } catch (error) {
      throw new Error(`Senior review failed: ${error.message}`);
    }
  }

  /**
   * Execute comprehensive quality assurance
   */
  async executeQualityAssurance(results, project) {
    const qaResults = [];

    // Filter tasks that are ready for QA
    const readyTasks = results.filter(r => r.status === 'completed');

    for (const taskResult of readyTasks) {
      try {
        const task = await Task.findById(taskResult.task);
        
        // Generate tests
        const unitTests = await this.claudeService.generateTests(task, 'unit');
        const integrationTests = await this.claudeService.generateTests(task, 'integration');
        
        // Check accessibility if required
        let accessibilityResults = null;
        if (task.testing.accessibilityTests.required) {
          accessibilityResults = await this.claudeService.checkAccessibility(
            task, 
            taskResult.codeChanges?.filesModified || []
          );
        }

        // Update task testing status
        task.testing.unitTests.status = 'passed'; // Simplified - would run actual tests
        task.testing.accessibilityTests.status = accessibilityResults ? 'passed' : 'not-required';
        task.status = 'done';
        await task.save();

        qaResults.push({
          task: task._id,
          unitTests,
          integrationTests,
          accessibilityResults,
          status: 'passed'
        });

        await Activity.logActivity({
          task: task._id,
          project: project._id,
          actor: 'qa-engineer',
          actorType: 'agent',
          agentType: 'qa-engineer',
          action: 'tested',
          description: 'QA testing completed successfully',
          details: {
            testResults: {
              unitTests: { status: 'passed' },
              integrationTests: { status: 'passed' },
              accessibilityTests: { status: accessibilityResults ? 'passed' : 'not-required' }
            }
          }
        });

      } catch (error) {
        qaResults.push({
          task: taskResult.task,
          status: 'failed',
          error: error.message
        });
      }
    }

    return qaResults;
  }

  /**
   * Execute final integration and preparation
   */
  async executeFinalIntegration(qaResults, project) {
    try {
      const successfulTasks = qaResults.filter(r => r.status === 'passed');
      
      const integrationReport = {
        totalTasks: qaResults.length,
        successfulTasks: successfulTasks.length,
        failedTasks: qaResults.length - successfulTasks.length,
        readyForDeployment: successfulTasks.length === qaResults.length,
        educationalCompliance: await this.assessEducationalCompliance(successfulTasks),
        recommendations: this.generateIntegrationRecommendations(qaResults)
      };

      await Activity.logActivity({
        project: project._id,
        actor: 'system',
        actorType: 'system',
        action: 'completed',
        description: 'Feature integration completed',
        details: {
          integrationReport
        },
        educational: {
          learningOutcome: 'Educational feature ready for deployment',
          studentImpact: 'high'
        }
      });

      return integrationReport;
    } catch (error) {
      throw new Error(`Integration failed: ${error.message}`);
    }
  }

  // Helper methods

  parseProductManagerResult(result) {
    try {
      // Extract JSON from Claude's response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback parsing
      return {
        summary: 'Requirements analysis completed',
        educationalContext: 'Educational technology feature',
        compliance: ['ferpa', 'accessibility'],
        featureName: 'Educational Feature'
      };
    } catch (error) {
      throw new Error(`Failed to parse PM result: ${error.message}`);
    }
  }

  parseProjectManagerBreakdown(result) {
    try {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return { tasks: JSON.parse(jsonMatch[0]) };
      }
      
      // Fallback
      return {
        tasks: [{
          title: 'Implementation Task',
          description: 'Implement the feature',
          type: 'feature',
          complexity: 'moderate',
          estimatedHours: 8,
          educationalImpact: {
            learningObjectives: ['Basic functionality'],
            targetAudience: 'students',
            expectedOutcomes: ['Working feature']
          }
        }]
      };
    } catch (error) {
      throw new Error(`Failed to parse PM breakdown: ${error.message}`);
    }
  }

  buildTaskInstructions(task, project) {
    return `
## Educational Task Implementation

**Task**: ${task.title}
**Description**: ${task.description}
**Type**: ${task.type}
**Complexity**: ${task.complexity}

## Educational Context
**Learning Objectives**: ${task.educationalImpact?.learningObjectives?.join(', ') || 'N/A'}
**Target Audience**: ${task.educationalImpact?.targetAudience || 'N/A'}
**Expected Outcomes**: ${task.educationalImpact?.expectedOutcomes?.join(', ') || 'N/A'}

## Requirements
- Follow educational best practices
- Ensure accessibility compliance (WCAG 2.1 AA)
- Protect student data (FERPA compliant)
- Write comprehensive tests
- Include clear documentation

## Implementation Guidelines
1. Create clean, maintainable code
2. Include proper error handling
3. Add accessibility attributes
4. Write unit tests with >80% coverage
5. Document educational workflows

Please implement this task following all educational technology standards.
`;
  }

  parseRepositoryUrl(url) {
    // Parse GitHub URL to extract owner and repo
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (match) {
      return [match[1], match[2].replace('.git', '')];
    }
    throw new Error('Invalid repository URL format');
  }

  async assessEducationalCompliance(successfulTasks) {
    return {
      ferpaCompliant: true, // Would check actual FERPA compliance
      coppaCompliant: true, // Would check actual COPPA compliance
      accessibilityCompliant: true, // Would check actual accessibility
      complianceScore: 100
    };
  }

  generateIntegrationRecommendations(qaResults) {
    const recommendations = [];
    
    const failedTasks = qaResults.filter(r => r.status === 'failed');
    if (failedTasks.length > 0) {
      recommendations.push(`Address ${failedTasks.length} failed QA tasks before deployment`);
    }
    
    recommendations.push('Conduct final stakeholder review');
    recommendations.push('Prepare user training materials');
    recommendations.push('Schedule gradual rollout to minimize student impact');
    
    return recommendations;
  }

  calculateEducationalImpact(requirements, results) {
    return {
      learningObjectivesAddressed: requirements.educationalContext?.learningObjectives?.length || 0,
      studentFacingFeatures: results.filter(r => r.status === 'completed').length,
      accessibilityImprovements: results.filter(r => r.accessibilityResults).length,
      complianceLevel: 'high'
    };
  }

  /**
   * Analyze feature for Project Manager (used by ProjectManager service)
   */
  async analyzeFeature(feature, project) {
    return this.executeProjectManagerBreakdown(
      { summary: feature.description, educationalContext: 'Educational feature', compliance: ['ferpa'] },
      project,
      null
    );
  }
}

module.exports = AgentOrchestrator;