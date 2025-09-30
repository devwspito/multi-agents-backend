const ClaudeService = require('./ClaudeService');
const MultiRepoManager = require('./MultiRepoManager');
const TaskDistributor = require('./TaskDistributor');
const GitHubIntegration = require('./GitHubIntegration');
const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);

class MultiProjectOrchestrator extends ClaudeService {
  constructor() {
    super();
    this.multiRepoManager = new MultiRepoManager();
    this.taskDistributor = new TaskDistributor();
    this.githubIntegration = new GitHubIntegration();
    this.headlessMode = true; // Enable headless Claude Code mode
  }

  /**
   * Execute a cross-repository task with team coordination
   */
  async executeMultiRepoTask(projectId, taskDescription, repositories, userPreferences = {}) {
    const startTime = Date.now();
    
    try {
      // 1. Analyze task requirements across repositories
      const taskAnalysis = await this.analyzeTaskRequirements(taskDescription, repositories);
      
      // 2. Create multi-repo workspace
      const workspace = await this.multiRepoManager.createMultiRepoWorkspace(projectId, repositories);
      
      // 3. Distribute task to appropriate teams
      const teamAssignments = await this.taskDistributor.distributeTask(taskAnalysis, repositories);
      
      // 4. Execute tasks in parallel across teams
      const executionResults = await this.executeTeamTasks(teamAssignments, workspace);
      
      // 5. Coordinate cross-repository changes
      const consolidatedChanges = await this.consolidateChanges(executionResults, workspace);
      
      // 6. Generate unified diff for user review
      const unifiedDiff = await this.generateUnifiedDiff(consolidatedChanges);
      
      const executionTime = Date.now() - startTime;
      
      return {
        success: true,
        taskAnalysis,
        teamAssignments,
        executionResults,
        consolidatedChanges,
        unifiedDiff,
        workspace: workspace.path,
        executionTime,
        readyForReview: true
      };
      
    } catch (error) {
      throw new Error(`Multi-repo task execution failed: ${error.message}`);
    }
  }

  /**
   * Analyze task requirements to determine which repositories and teams are needed
   */
  async analyzeTaskRequirements(taskDescription, repositories) {
    const analysisPrompt = `
# Task Requirement Analysis

## Task Description
${taskDescription}

## Available Repositories
${repositories.map(repo => `
- **${repo.name}** (${repo.type}): ${repo.description}
  - Technologies: ${repo.technologies?.join(', ') || 'Not specified'}
  - Current branch: ${repo.branch || 'main'}
`).join('\n')}

## Analysis Required
Please analyze this task and provide a JSON response with:

1. **repositoriesNeeded**: Which repositories will be modified
2. **teamAssignments**: Which development teams should work on which parts
3. **dependencies**: Cross-repository dependencies and coordination needs
4. **complexity**: Estimated complexity and time requirements
5. **riskAssessment**: Potential risks and mitigation strategies

## Output Format
\`\`\`json
{
  "repositoriesNeeded": [
    {
      "repoId": "frontend-repo",
      "reason": "UI changes needed for new feature",
      "estimatedChanges": "medium",
      "team": "frontend"
    }
  ],
  "teamAssignments": {
    "frontend": {
      "priority": "high",
      "tasks": ["Create new component", "Update routing"],
      "estimatedHours": 8
    },
    "backend": {
      "priority": "medium", 
      "tasks": ["Add API endpoints", "Update database schema"],
      "estimatedHours": 6
    }
  },
  "dependencies": [
    {
      "from": "frontend",
      "to": "backend",
      "type": "api_contract",
      "description": "Frontend needs new API endpoints"
    }
  ],
  "complexity": "medium",
  "riskAssessment": {
    "level": "low",
    "risks": ["Breaking changes to API"],
    "mitigations": ["Versioned API endpoints", "Backward compatibility"]
  },
  "coordinationStrategy": "backend_first"
}
\`\`\`
`;

    const result = await this.runClaudeCommand(analysisPrompt, null, 'project-manager');
    return this.parseTaskAnalysis(result.output);
  }

  /**
   * Execute tasks across multiple teams in coordination
   */
  async executeTeamTasks(teamAssignments, workspace) {
    const executionResults = {};
    
    // Determine execution order based on dependencies
    const executionOrder = this.determineExecutionOrder(teamAssignments);
    
    for (const phase of executionOrder) {
      const phaseResults = await Promise.all(
        phase.map(team => this.executeTeamPhase(team, teamAssignments[team.name], workspace))
      );
      
      // Store results and prepare for next phase
      phaseResults.forEach((result, index) => {
        executionResults[phase[index].name] = result;
      });
      
      // Coordinate between phases if needed
      if (executionOrder.indexOf(phase) < executionOrder.length - 1) {
        await this.coordinateBetweenPhases(executionResults, workspace);
      }
    }
    
    return executionResults;
  }

  /**
   * Execute a specific team's task
   */
  async executeTeamPhase(team, assignment, workspace) {
    const teamWorkspace = path.join(workspace.path, team.name);
    await fs.mkdir(teamWorkspace, { recursive: true });
    
    // Get team-specific repositories
    const teamRepos = workspace.repositories.filter(repo => 
      assignment.repositories?.includes(repo.name) || repo.team === team.name
    );
    
    // Build team-specific context
    const teamContext = this.buildTeamContext(team, assignment, teamRepos, workspace);
    
    try {
      // Execute task with appropriate agent
      const agentType = this.getAgentForTeam(team.name);
      const result = await this.executeTask(
        {
          title: assignment.title || `${team.name} implementation`,
          description: assignment.tasks.join('\n'),
          type: 'implementation',
          complexity: assignment.complexity || 'medium'
        },
        agentType,
        teamContext
      );
      
      return {
        team: team.name,
        success: true,
        result,
        changes: await this.extractTeamChanges(teamWorkspace),
        artifacts: result.artifacts || []
      };
      
    } catch (error) {
      return {
        team: team.name,
        success: false,
        error: error.message,
        changes: [],
        artifacts: []
      };
    }
  }

  /**
   * Build team-specific context for task execution
   */
  buildTeamContext(team, assignment, repositories, workspace) {
    const repoContext = repositories.map(repo => `
## Repository: ${repo.name}
- **Type**: ${repo.type}
- **Technologies**: ${repo.technologies?.join(', ') || 'Various'}
- **Path**: ${repo.localPath}
- **Current Status**: ${repo.status || 'Ready'}
`).join('\n');

    return `
# ${team.name.toUpperCase()} Team Assignment

## Task Overview
${assignment.tasks.map((task, i) => `${i + 1}. ${task}`).join('\n')}

## Priority Level
${assignment.priority || 'medium'}

## Estimated Time
${assignment.estimatedHours || 'TBD'} hours

## Repository Context
${repoContext}

## Cross-Team Dependencies
${assignment.dependencies?.map(dep => `- Depends on: ${dep.team} (${dep.description})`).join('\n') || 'None'}

## Team-Specific Instructions
- Follow ${team.name} team coding standards
- Ensure compatibility with existing ${team.name} architecture
- Include appropriate tests for ${team.name} components
- Consider ${team.name}-specific performance requirements

## Coordination Requirements
${assignment.coordinationNotes || 'Standard team coordination protocols'}

## Success Criteria
- All tasks completed successfully
- Code passes team-specific quality gates
- Integration points documented
- Ready for cross-team review
`;
  }

  /**
   * Consolidate changes from all teams into a coherent solution
   */
  async consolidateChanges(executionResults, workspace) {
    const allChanges = [];
    const conflicts = [];
    
    // Collect all changes
    for (const [team, result] of Object.entries(executionResults)) {
      if (result.success && result.changes) {
        allChanges.push({
          team,
          repository: result.repository,
          changes: result.changes,
          files: result.artifacts
        });
      }
    }
    
    // Detect conflicts and integration points
    const integrationAnalysis = await this.analyzeIntegrationPoints(allChanges);
    
    // Resolve conflicts if any
    if (integrationAnalysis.conflicts.length > 0) {
      const resolutionStrategy = await this.generateConflictResolution(integrationAnalysis.conflicts);
      return {
        changes: allChanges,
        conflicts: integrationAnalysis.conflicts,
        resolution: resolutionStrategy,
        integrationPoints: integrationAnalysis.integrationPoints,
        requiresManualReview: true
      };
    }
    
    return {
      changes: allChanges,
      conflicts: [],
      integrationPoints: integrationAnalysis.integrationPoints,
      requiresManualReview: false
    };
  }

  /**
   * Generate unified diff showing ALL changes across repositories
   */
  async generateUnifiedDiff(consolidatedChanges) {
    const unifiedDiff = {
      summary: {
        totalRepositories: consolidatedChanges.changes.length,
        totalFiles: consolidatedChanges.changes.reduce((acc, change) => acc + change.files.length, 0),
        hasConflicts: consolidatedChanges.conflicts.length > 0,
        requiresManualReview: consolidatedChanges.requiresManualReview
      },
      repositories: [],
      fullDiff: ''
    };

    for (const change of consolidatedChanges.changes) {
      const repoDiff = await this.generateRepositoryDiff(change);
      unifiedDiff.repositories.push(repoDiff);
      unifiedDiff.fullDiff += `\n# Repository: ${change.repository}\n${repoDiff.diff}\n`;
    }

    // Add integration points analysis
    if (consolidatedChanges.integrationPoints.length > 0) {
      unifiedDiff.integrationAnalysis = consolidatedChanges.integrationPoints;
    }

    // Add conflict resolution if needed
    if (consolidatedChanges.conflicts.length > 0) {
      unifiedDiff.conflicts = consolidatedChanges.conflicts;
      unifiedDiff.resolutionStrategy = consolidatedChanges.resolution;
    }

    return unifiedDiff;
  }

  /**
   * Generate diff for a specific repository
   */
  async generateRepositoryDiff(repoChange) {
    try {
      const { stdout: diff } = await execAsync('git diff HEAD', {
        cwd: repoChange.repository.localPath
      });

      const { stdout: status } = await execAsync('git status --porcelain', {
        cwd: repoChange.repository.localPath
      });

      return {
        repository: repoChange.repository.name,
        team: repoChange.team,
        diff,
        status: this.parseGitStatus(status),
        files: repoChange.files,
        hasChanges: diff.length > 0 || status.length > 0
      };
    } catch (error) {
      return {
        repository: repoChange.repository.name,
        team: repoChange.team,
        diff: '',
        status: [],
        files: [],
        hasChanges: false,
        error: error.message
      };
    }
  }

  /**
   * Create and coordinate deployment across all repositories
   */
  async deployMultiRepoChanges(projectId, taskId, approvedChanges, deploymentStrategy = 'coordinated') {
    const deploymentPlan = await this.createDeploymentPlan(approvedChanges, deploymentStrategy);
    
    try {
      const deploymentResults = {};
      
      // Execute deployment phases
      for (const phase of deploymentPlan.phases) {
        const phaseResults = await Promise.all(
          phase.repositories.map(repo => 
            this.deployRepositoryChanges(repo, phase.strategy)
          )
        );
        
        deploymentResults[phase.name] = phaseResults;
        
        // Validate phase before continuing
        const phaseValidation = await this.validateDeploymentPhase(phaseResults);
        if (!phaseValidation.success) {
          throw new Error(`Deployment phase ${phase.name} failed: ${phaseValidation.error}`);
        }
        
        // Wait for stabilization if specified
        if (phase.waitTime) {
          await new Promise(resolve => setTimeout(resolve, phase.waitTime));
        }
      }
      
      return {
        success: true,
        deploymentPlan,
        results: deploymentResults,
        timeline: this.generateDeploymentTimeline(deploymentResults)
      };
      
    } catch (error) {
      // Rollback if deployment fails
      await this.rollbackMultiRepoDeployment(deploymentPlan, deploymentResults);
      throw error;
    }
  }

  /**
   * Helper methods
   */
  
  parseTaskAnalysis(output) {
    try {
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      throw new Error('No JSON found in analysis output');
    } catch (error) {
      throw new Error(`Failed to parse task analysis: ${error.message}`);
    }
  }

  determineExecutionOrder(teamAssignments) {
    // Simple strategy: backend first, then frontend, then devops
    const order = [];
    const teams = Object.keys(teamAssignments);
    
    if (teams.includes('backend')) {
      order.push([{ name: 'backend' }]);
    }
    
    const frontendTeams = teams.filter(t => t.includes('frontend') || t.includes('mobile'));
    if (frontendTeams.length > 0) {
      order.push(frontendTeams.map(name => ({ name })));
    }
    
    const remainingTeams = teams.filter(t => !['backend'].includes(t) && !frontendTeams.includes(t));
    if (remainingTeams.length > 0) {
      order.push(remainingTeams.map(name => ({ name })));
    }
    
    return order;
  }

  getAgentForTeam(teamName) {
    const agentMapping = {
      'frontend': 'senior-developer',
      'backend': 'senior-developer', 
      'mobile': 'senior-developer',
      'devops': 'tech-lead',
      'qa': 'qa-engineer',
      'ui-ux': 'senior-developer'
    };
    
    return agentMapping[teamName] || 'senior-developer';
  }

  parseGitStatus(status) {
    return status.split('\n')
      .filter(line => line.trim())
      .map(line => ({
        status: line.substring(0, 2),
        file: line.substring(3)
      }));
  }

  async coordinateBetweenPhases(executionResults, workspace) {
    // Implement coordination logic between execution phases
    // This could involve updating shared interfaces, APIs, etc.
  }

  async extractTeamChanges(teamWorkspace) {
    // Extract changes made by a specific team
    try {
      const { stdout } = await execAsync('git diff --name-only', { cwd: teamWorkspace });
      return stdout.split('\n').filter(line => line.trim());
    } catch (error) {
      return [];
    }
  }

  async analyzeIntegrationPoints(allChanges) {
    // Analyze how changes from different teams integrate
    return {
      integrationPoints: [],
      conflicts: []
    };
  }

  async generateConflictResolution(conflicts) {
    // Generate strategy for resolving conflicts
    return {
      strategy: 'manual_review',
      steps: []
    };
  }

  async createDeploymentPlan(approvedChanges, strategy) {
    // Create deployment plan for coordinated deployment
    return {
      strategy,
      phases: [
        {
          name: 'backend',
          repositories: [],
          strategy: 'rolling'
        }
      ]
    };
  }

  async deployRepositoryChanges(repo, strategy) {
    // Deploy changes for a specific repository
    return {
      repository: repo.name,
      success: true
    };
  }

  async validateDeploymentPhase(phaseResults) {
    // Validate that a deployment phase completed successfully
    return {
      success: phaseResults.every(result => result.success)
    };
  }

  async rollbackMultiRepoDeployment(deploymentPlan, deploymentResults) {
    // Rollback deployment if something fails
  }

  generateDeploymentTimeline(deploymentResults) {
    // Generate timeline of deployment events
    return [];
  }
}

module.exports = MultiProjectOrchestrator;