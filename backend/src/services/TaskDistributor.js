const ClaudeService = require('./ClaudeService');

class TaskDistributor {
  constructor() {
    this.claudeService = new ClaudeService();
    this.teamCapabilities = {
      'frontend': {
        technologies: ['React', 'Vue.js', 'Angular', 'HTML', 'CSS', 'JavaScript', 'TypeScript'],
        responsibilities: ['UI/UX', 'Client-side logic', 'State management', 'Responsive design'],
        agents: ['senior-developer', 'junior-developer'],
        outputStyles: ['student-impact', 'accessibility-audit']
      },
      'backend': {
        technologies: ['Node.js', 'Python', 'Java', 'APIs', 'Databases', 'Microservices'],
        responsibilities: ['API development', 'Database design', 'Business logic', 'Data processing'],
        agents: ['senior-developer', 'tech-lead'],
        outputStyles: ['compliance-review', 'educational-report']
      },
      'mobile': {
        technologies: ['React Native', 'iOS', 'Android', 'Flutter', 'Mobile APIs'],
        responsibilities: ['Mobile apps', 'Platform-specific features', 'Mobile UX'],
        agents: ['senior-developer', 'junior-developer'],
        outputStyles: ['accessibility-audit', 'student-impact']
      },
      'devops': {
        technologies: ['Docker', 'Kubernetes', 'CI/CD', 'Infrastructure', 'Monitoring'],
        responsibilities: ['Deployment', 'Infrastructure', 'CI/CD pipelines', 'Monitoring'],
        agents: ['tech-lead', 'senior-developer'],
        outputStyles: ['educational-report', 'compliance-review']
      },
      'qa': {
        technologies: ['Testing frameworks', 'Automation', 'Accessibility testing'],
        responsibilities: ['Quality assurance', 'Testing', 'Compliance validation'],
        agents: ['qa-engineer'],
        outputStyles: ['accessibility-audit', 'compliance-review']
      }
    };
  }

  /**
   * Distribute a task across appropriate teams and repositories
   */
  async distributeTask(taskAnalysis, repositories) {
    const distribution = {
      taskId: this.generateTaskId(),
      originalTask: taskAnalysis,
      teamAssignments: {},
      coordinationPlan: {},
      dependencies: [],
      estimatedTimeline: {}
    };

    try {
      // Analyze which teams are needed based on repositories and task requirements
      const requiredTeams = this.identifyRequiredTeams(taskAnalysis, repositories);
      
      // Create detailed assignments for each team
      for (const team of requiredTeams) {
        distribution.teamAssignments[team.name] = await this.createTeamAssignment(
          team, 
          taskAnalysis, 
          repositories,
          requiredTeams
        );
      }

      // Analyze inter-team dependencies
      distribution.dependencies = this.analyzeDependencies(distribution.teamAssignments);
      
      // Create coordination plan
      distribution.coordinationPlan = await this.createCoordinationPlan(
        distribution.teamAssignments,
        distribution.dependencies
      );

      // Estimate timeline
      distribution.estimatedTimeline = this.estimateTimeline(
        distribution.teamAssignments,
        distribution.dependencies
      );

      return distribution;
      
    } catch (error) {
      throw new Error(`Task distribution failed: ${error.message}`);
    }
  }

  /**
   * Identify which teams are required for the task
   */
  identifyRequiredTeams(taskAnalysis, repositories) {
    const requiredTeams = [];
    const repositoryTeams = new Set();

    // Get teams from repository assignments
    repositories.forEach(repo => {
      if (repo.team) {
        repositoryTeams.add(repo.team);
      } else {
        // Infer team from repository type/technologies
        const inferredTeam = this.inferTeamFromRepository(repo);
        if (inferredTeam) repositoryTeams.add(inferredTeam);
      }
    });

    // Add teams based on task analysis
    if (taskAnalysis.repositoriesNeeded) {
      taskAnalysis.repositoriesNeeded.forEach(repoNeed => {
        if (repoNeed.team) {
          repositoryTeams.add(repoNeed.team);
        }
      });
    }

    // Convert to team objects with capabilities
    repositoryTeams.forEach(teamName => {
      if (this.teamCapabilities[teamName]) {
        requiredTeams.push({
          name: teamName,
          capabilities: this.teamCapabilities[teamName],
          repositories: repositories.filter(repo => 
            repo.team === teamName || this.inferTeamFromRepository(repo) === teamName
          )
        });
      }
    });

    // Always include QA if not already included
    if (!requiredTeams.find(team => team.name === 'qa')) {
      requiredTeams.push({
        name: 'qa',
        capabilities: this.teamCapabilities.qa,
        repositories: [] // QA works across all repositories
      });
    }

    return requiredTeams;
  }

  /**
   * Infer team assignment from repository characteristics
   */
  inferTeamFromRepository(repository) {
    const technologies = repository.metadata?.technologies || [];
    const repoType = repository.type?.toLowerCase();

    // Frontend indicators
    if (repoType === 'frontend' || 
        technologies.some(tech => ['React', 'Vue.js', 'Angular'].includes(tech))) {
      return 'frontend';
    }

    // Mobile indicators
    if (repoType === 'mobile' || 
        technologies.some(tech => ['React Native', 'iOS', 'Android', 'Flutter'].includes(tech))) {
      return 'mobile';
    }

    // Backend indicators
    if (repoType === 'backend' || repoType === 'api' ||
        technologies.some(tech => ['Node.js', 'Python', 'Express', 'API'].includes(tech))) {
      return 'backend';
    }

    // DevOps indicators
    if (repoType === 'infrastructure' || repoType === 'devops' ||
        technologies.some(tech => ['Docker', 'Kubernetes'].includes(tech))) {
      return 'devops';
    }

    // Default to backend if uncertain
    return 'backend';
  }

  /**
   * Create detailed assignment for a specific team
   */
  async createTeamAssignment(team, taskAnalysis, repositories, allTeams) {
    const teamRepositories = repositories.filter(repo => 
      team.repositories.includes(repo) || repo.team === team.name
    );

    // Build team-specific context
    const teamContext = this.buildTeamContext(team, taskAnalysis, teamRepositories);
    
    // Generate detailed tasks using Claude
    const taskBreakdown = await this.generateTeamTaskBreakdown(team, teamContext, taskAnalysis);

    return {
      team: team.name,
      agent: this.selectAgentForTeam(team.name, taskAnalysis.complexity),
      repositories: teamRepositories.map(repo => repo.name),
      tasks: taskBreakdown.tasks,
      deliverables: taskBreakdown.deliverables,
      priority: this.calculatePriority(team, taskAnalysis),
      estimatedHours: taskBreakdown.estimatedHours,
      complexity: taskBreakdown.complexity,
      dependencies: taskBreakdown.dependencies,
      outputStyle: this.selectOutputStyle(team.name, taskAnalysis),
      educationalImpact: taskBreakdown.educationalImpact,
      complianceRequirements: this.getComplianceRequirements(team.name, taskAnalysis)
    };
  }

  /**
   * Generate detailed task breakdown for a team using Claude
   */
  async generateTeamTaskBreakdown(team, teamContext, taskAnalysis) {
    const prompt = `
# Team Task Breakdown Analysis

## Team: ${team.name.toUpperCase()}
**Capabilities**: ${team.capabilities.responsibilities.join(', ')}
**Technologies**: ${team.capabilities.technologies.join(', ')}

## Original Task
${taskAnalysis.description || 'Task breakdown needed'}

## Team Context
${teamContext}

## Analysis Required
Break down this task for the ${team.name} team. Provide a JSON response with:

1. **tasks**: Specific actionable tasks for this team
2. **deliverables**: What this team will produce
3. **estimatedHours**: Time estimate for completion
4. **complexity**: Task complexity (low/medium/high)
5. **dependencies**: What this team needs from other teams
6. **educationalImpact**: How this work affects student experience
7. **testingRequirements**: What testing is needed

## Output Format
\`\`\`json
{
  "tasks": [
    "Create student dashboard component",
    "Implement grade display functionality",
    "Add accessibility features for screen readers"
  ],
  "deliverables": [
    "React components for student dashboard",
    "Unit tests with >90% coverage",
    "Accessibility documentation"
  ],
  "estimatedHours": 12,
  "complexity": "medium",
  "dependencies": [
    {
      "team": "backend",
      "requirement": "Student data API endpoints",
      "description": "Need API to fetch student grades and progress"
    }
  ],
  "educationalImpact": {
    "learningOutcomes": ["Improved grade visibility", "Better student engagement"],
    "accessibilityImprovements": ["Screen reader support", "Keyboard navigation"],
    "targetAudience": "Undergraduate students"
  },
  "testingRequirements": {
    "unitTests": true,
    "integrationTests": true,
    "accessibilityTests": true,
    "coverageTarget": 90
  }
}
\`\`\`

Consider educational best practices, accessibility requirements, and student-centered design.
`;

    try {
      const result = await this.claudeService.runClaudeCommand(prompt, null, 'project-manager');
      return this.parseTaskBreakdown(result.output);
    } catch (error) {
      // Fallback to basic task breakdown
      return this.createFallbackTaskBreakdown(team, taskAnalysis);
    }
  }

  /**
   * Build context for team assignment
   */
  buildTeamContext(team, taskAnalysis, repositories) {
    const repoContext = repositories.map(repo => `
**${repo.name}**:
- Type: ${repo.type || 'Unknown'}
- Technologies: ${repo.metadata?.technologies?.join(', ') || 'Not specified'}
- Has Tests: ${repo.metadata?.hasTests ? 'Yes' : 'No'}
- Structure: ${repo.metadata?.structure?.type || 'Unknown'}
`).join('\n');

    return `
## Repository Context
${repoContext}

## Team Responsibilities
${team.capabilities.responsibilities.map(r => `- ${r}`).join('\n')}

## Educational Requirements
- Ensure WCAG 2.1 AA accessibility compliance
- Implement FERPA-compliant data handling
- Focus on student learning outcomes
- Consider diverse learner needs

## Quality Standards
- Follow educational technology best practices
- Implement comprehensive testing
- Ensure cross-browser compatibility
- Document educational impact
`;
  }

  /**
   * Analyze dependencies between team assignments
   */
  analyzeDependencies(teamAssignments) {
    const dependencies = [];

    for (const [teamName, assignment] of Object.entries(teamAssignments)) {
      if (assignment.dependencies) {
        assignment.dependencies.forEach(dep => {
          dependencies.push({
            from: teamName,
            to: dep.team,
            type: dep.type || 'implementation',
            requirement: dep.requirement,
            description: dep.description,
            priority: this.calculateDependencyPriority(dep),
            blocking: dep.blocking || false
          });
        });
      }
    }

    // Add implicit dependencies
    const implicitDeps = this.identifyImplicitDependencies(teamAssignments);
    dependencies.push(...implicitDeps);

    return dependencies;
  }

  /**
   * Identify implicit dependencies between teams
   */
  identifyImplicitDependencies(teamAssignments) {
    const implicitDeps = [];

    // Frontend typically depends on backend
    if (teamAssignments.frontend && teamAssignments.backend) {
      implicitDeps.push({
        from: 'frontend',
        to: 'backend',
        type: 'api_contract',
        requirement: 'API endpoints and data contracts',
        description: 'Frontend needs backend APIs to be defined',
        priority: 'high',
        blocking: true
      });
    }

    // Mobile typically depends on backend
    if (teamAssignments.mobile && teamAssignments.backend) {
      implicitDeps.push({
        from: 'mobile',
        to: 'backend',
        type: 'api_contract',
        requirement: 'Mobile-optimized API endpoints',
        description: 'Mobile app needs backend API support',
        priority: 'high',
        blocking: true
      });
    }

    // DevOps typically comes after development
    if (teamAssignments.devops && (teamAssignments.frontend || teamAssignments.backend)) {
      ['frontend', 'backend', 'mobile'].forEach(team => {
        if (teamAssignments[team]) {
          implicitDeps.push({
            from: 'devops',
            to: team,
            type: 'deployment',
            requirement: 'Deployable artifacts',
            description: `DevOps needs ${team} code to be ready for deployment`,
            priority: 'medium',
            blocking: false
          });
        }
      });
    }

    // QA depends on all development teams
    if (teamAssignments.qa) {
      ['frontend', 'backend', 'mobile'].forEach(team => {
        if (teamAssignments[team]) {
          implicitDeps.push({
            from: 'qa',
            to: team,
            type: 'testing',
            requirement: 'Testable code and documentation',
            description: `QA needs ${team} implementation for testing`,
            priority: 'high',
            blocking: false
          });
        }
      });
    }

    return implicitDeps;
  }

  /**
   * Create coordination plan between teams
   */
  async createCoordinationPlan(teamAssignments, dependencies) {
    const coordinationPlan = {
      phases: [],
      communicationPlan: {},
      integrationPoints: [],
      riskMitigation: {}
    };

    // Determine execution phases based on dependencies
    coordinationPlan.phases = this.determineExecutionPhases(teamAssignments, dependencies);

    // Create communication plan
    coordinationPlan.communicationPlan = this.createCommunicationPlan(teamAssignments);

    // Identify integration points
    coordinationPlan.integrationPoints = this.identifyIntegrationPoints(teamAssignments, dependencies);

    // Risk mitigation strategies
    coordinationPlan.riskMitigation = this.createRiskMitigationPlan(dependencies);

    return coordinationPlan;
  }

  /**
   * Determine execution phases based on dependencies
   */
  determineExecutionPhases(teamAssignments, dependencies) {
    const phases = [];
    const teams = Object.keys(teamAssignments);
    const processed = new Set();

    // Phase 1: Teams with no dependencies (typically backend)
    const independentTeams = teams.filter(team => 
      !dependencies.some(dep => dep.from === team && dep.blocking)
    );
    
    if (independentTeams.length > 0) {
      phases.push({
        phase: 1,
        name: 'Foundation',
        teams: independentTeams,
        description: 'Independent implementation phase',
        parallelExecution: true
      });
      independentTeams.forEach(team => processed.add(team));
    }

    // Phase 2: Teams that depend on Phase 1 (typically frontend, mobile)
    const dependentTeams = teams.filter(team => 
      !processed.has(team) && 
      dependencies.some(dep => dep.from === team && processed.has(dep.to))
    );

    if (dependentTeams.length > 0) {
      phases.push({
        phase: 2,
        name: 'Integration',
        teams: dependentTeams,
        description: 'Teams that integrate with foundation',
        parallelExecution: true
      });
      dependentTeams.forEach(team => processed.add(team));
    }

    // Phase 3: Remaining teams (typically DevOps, QA)
    const remainingTeams = teams.filter(team => !processed.has(team));
    
    if (remainingTeams.length > 0) {
      phases.push({
        phase: 3,
        name: 'Validation',
        teams: remainingTeams,
        description: 'Testing, deployment, and validation',
        parallelExecution: false
      });
    }

    return phases;
  }

  /**
   * Helper methods
   */

  generateTaskId() {
    return `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  selectAgentForTeam(teamName, complexity) {
    const agentMapping = {
      'frontend': complexity === 'high' ? 'senior-developer' : 'junior-developer',
      'backend': 'senior-developer',
      'mobile': complexity === 'high' ? 'senior-developer' : 'junior-developer',
      'devops': 'tech-lead',
      'qa': 'qa-engineer'
    };

    return agentMapping[teamName] || 'senior-developer';
  }

  calculatePriority(team, taskAnalysis) {
    const priorityMapping = {
      'backend': 'high', // Usually foundational
      'qa': 'high', // Critical for quality
      'frontend': 'medium',
      'mobile': 'medium',
      'devops': 'low' // Usually last
    };

    return priorityMapping[team.name] || 'medium';
  }

  selectOutputStyle(teamName, taskAnalysis) {
    const styleMapping = {
      'frontend': 'student-impact',
      'backend': 'compliance-review',
      'mobile': 'accessibility-audit',
      'devops': 'educational-report',
      'qa': 'accessibility-audit'
    };

    return styleMapping[teamName] || 'educational-report';
  }

  getComplianceRequirements(teamName, taskAnalysis) {
    const baseRequirements = ['FERPA compliance', 'WCAG 2.1 AA accessibility'];
    
    const teamSpecificRequirements = {
      'frontend': [...baseRequirements, 'Screen reader compatibility', 'Mobile accessibility'],
      'backend': [...baseRequirements, 'Data encryption', 'API security', 'Audit logging'],
      'mobile': [...baseRequirements, 'Mobile accessibility', 'App store compliance'],
      'devops': [...baseRequirements, 'Infrastructure security', 'Deployment compliance'],
      'qa': [...baseRequirements, 'Testing documentation', 'Quality metrics']
    };

    return teamSpecificRequirements[teamName] || baseRequirements;
  }

  parseTaskBreakdown(output) {
    try {
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }
      throw new Error('No JSON found in task breakdown');
    } catch (error) {
      throw new Error(`Failed to parse task breakdown: ${error.message}`);
    }
  }

  createFallbackTaskBreakdown(team, taskAnalysis) {
    return {
      tasks: [`Implement ${team.name} components for task`],
      deliverables: [`${team.name} implementation`],
      estimatedHours: 8,
      complexity: 'medium',
      dependencies: [],
      educationalImpact: {
        learningOutcomes: ['General educational improvement'],
        accessibilityImprovements: ['Standard accessibility features'],
        targetAudience: 'Students'
      },
      testingRequirements: {
        unitTests: true,
        integrationTests: true,
        accessibilityTests: true,
        coverageTarget: 80
      }
    };
  }

  calculateDependencyPriority(dependency) {
    if (dependency.blocking) return 'critical';
    if (dependency.type === 'api_contract') return 'high';
    return 'medium';
  }

  createCommunicationPlan(teamAssignments) {
    return {
      standupFrequency: 'daily',
      integrationMeetings: 'twice_weekly',
      reviewCycles: 'weekly',
      stakeholderUpdates: 'weekly'
    };
  }

  identifyIntegrationPoints(teamAssignments, dependencies) {
    return dependencies.filter(dep => dep.type === 'api_contract' || dep.type === 'integration');
  }

  createRiskMitigationPlan(dependencies) {
    return {
      communicationRisks: 'Regular standup meetings',
      technicalRisks: 'Proof of concept implementations',
      timelineRisks: 'Parallel development where possible'
    };
  }

  estimateTimeline(teamAssignments, dependencies) {
    const totalHours = Object.values(teamAssignments)
      .reduce((sum, assignment) => sum + (assignment.estimatedHours || 8), 0);

    return {
      totalEstimatedHours: totalHours,
      parallelEstimate: Math.max(...Object.values(teamAssignments).map(a => a.estimatedHours || 8)),
      sequentialEstimate: totalHours,
      recommendedApproach: 'parallel'
    };
  }
}

module.exports = TaskDistributor;