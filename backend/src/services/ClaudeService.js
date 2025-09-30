const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const Activity = require('../models/Activity');

const execAsync = promisify(exec);

class ClaudeService {
  constructor() {
    this.claudePath = 'claude'; // Assumes claude is in PATH
    this.workspaceBase = process.env.WORKSPACE_BASE || './workspaces';
    this.defaultModel = process.env.DEFAULT_CLAUDE_MODEL || 'claude-3-sonnet-20240229';
  }

  /**
   * Execute Claude Code command for a specific task
   */
  async executeTask(task, agent, instructions) {
    const startTime = Date.now();
    const workspacePath = await this.setupWorkspace(task);
    
    try {
      // Prepare agent-specific context
      const agentTemplate = await this.loadAgentTemplate(agent);
      const fullInstructions = this.buildInstructions(task, agent, instructions, agentTemplate);
      
      // Execute Claude Code
      const result = await this.runClaudeCommand(fullInstructions, workspacePath, agent);
      
      const executionTime = Date.now() - startTime;
      
      // Log successful execution
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: agent,
        actorType: 'agent',
        agentType: agent,
        action: 'code-generated',
        description: `${agent} executed task: ${task.title}`,
        details: {
          claudeExecution: {
            model: this.getModelForAgent(agent),
            tokens: result.tokens || 0,
            executionTime,
            success: true
          },
          codeChanges: result.codeChanges
        }
      });

      return {
        success: true,
        result: result.output,
        executionTime,
        workspace: workspacePath,
        codeChanges: result.codeChanges,
        artifacts: result.artifacts
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      
      // Log failed execution
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: agent,
        actorType: 'agent',
        agentType: agent,
        action: 'code-generated',
        description: `${agent} failed to execute task: ${task.title}`,
        details: {
          claudeExecution: {
            model: this.getModelForAgent(agent),
            executionTime,
            success: false,
            error: error.message
          }
        }
      });

      throw new Error(`Claude execution failed: ${error.message}`);
    }
  }

  /**
   * Run Claude Code review on submitted code
   */
  async reviewCode(task, reviewerAgent, codeFiles) {
    const startTime = Date.now();
    
    try {
      const reviewTemplate = await this.loadAgentTemplate(reviewerAgent);
      const reviewInstructions = this.buildReviewInstructions(task, codeFiles, reviewTemplate);
      
      const result = await this.runClaudeCommand(reviewInstructions, null, reviewerAgent);
      const executionTime = Date.now() - startTime;
      
      // Parse review results
      const review = this.parseReviewResult(result.output);
      
      // Log review activity
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: reviewerAgent,
        actorType: 'agent',
        agentType: reviewerAgent,
        action: 'reviewed',
        description: `Code review completed by ${reviewerAgent}`,
        details: {
          claudeExecution: {
            model: this.getModelForAgent(reviewerAgent),
            executionTime,
            success: true
          },
          reviewData: {
            score: review.score,
            feedback: review.summary,
            suggestions: review.suggestions,
            complianceIssues: review.complianceIssues
          }
        }
      });

      return review;
    } catch (error) {
      throw new Error(`Code review failed: ${error.message}`);
    }
  }

  /**
   * Generate tests for educational features
   */
  async generateTests(task, testType = 'unit') {
    const startTime = Date.now();
    
    try {
      const testInstructions = this.buildTestInstructions(task, testType);
      const result = await this.runClaudeCommand(testInstructions, null, 'qa-engineer');
      
      const executionTime = Date.now() - startTime;
      
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: 'qa-engineer',
        actorType: 'agent',
        agentType: 'qa-engineer',
        action: 'tested',
        description: `Generated ${testType} tests for ${task.title}`,
        details: {
          claudeExecution: {
            model: this.getModelForAgent('qa-engineer'),
            executionTime,
            success: true
          },
          testResults: {
            testType,
            filesGenerated: result.artifacts?.length || 0
          }
        }
      });

      return {
        tests: result.output,
        files: result.artifacts
      };
    } catch (error) {
      throw new Error(`Test generation failed: ${error.message}`);
    }
  }

  /**
   * Run accessibility compliance check
   */
  async checkAccessibility(task, componentFiles) {
    const startTime = Date.now();
    
    try {
      const accessibilityInstructions = this.buildAccessibilityInstructions(task, componentFiles);
      const result = await this.runClaudeCommand(accessibilityInstructions, null, 'qa-engineer');
      
      const executionTime = Date.now() - startTime;
      const complianceReport = this.parseAccessibilityResult(result.output);
      
      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: 'qa-engineer',
        actorType: 'agent',
        agentType: 'qa-engineer',
        action: 'compliance-check',
        description: `Accessibility compliance check completed`,
        details: {
          claudeExecution: {
            model: this.getModelForAgent('qa-engineer'),
            executionTime,
            success: true
          },
          testResults: {
            accessibilityTests: {
              wcagScore: complianceReport.wcagScore,
              violations: complianceReport.violations
            }
          }
        },
        educational: {
          complianceFlags: complianceReport.violations.map(v => ({
            type: 'accessibility',
            severity: v.severity,
            message: v.message
          }))
        }
      });

      return complianceReport;
    } catch (error) {
      throw new Error(`Accessibility check failed: ${error.message}`);
    }
  }

  /**
   * Setup workspace for task execution
   */
  async setupWorkspace(task) {
    const workspacePath = path.join(this.workspaceBase, `task-${task._id}`);
    
    try {
      await fs.mkdir(workspacePath, { recursive: true });
      
      // Copy relevant project files if they exist
      if (task.project.repository?.url) {
        await this.cloneRepository(task.project.repository.url, workspacePath);
      }
      
      // Create task-specific branch
      if (task.gitBranch) {
        await this.createBranch(workspacePath, task.gitBranch);
      }
      
      return workspacePath;
    } catch (error) {
      throw new Error(`Failed to setup workspace: ${error.message}`);
    }
  }

  /**
   * Load agent template with educational context
   */
  async loadAgentTemplate(agentType) {
    const templatePath = path.join(__dirname, '../../claude-templates/agents', `${agentType}.md`);
    
    try {
      const template = await fs.readFile(templatePath, 'utf8');
      return template;
    } catch (error) {
      // Return default template if specific one doesn't exist
      return this.getDefaultAgentTemplate(agentType);
    }
  }

  /**
   * Build comprehensive instructions for Claude Code
   */
  buildInstructions(task, agent, instructions, agentTemplate) {
    const educationalContext = this.buildEducationalContext(task);
    const complianceRequirements = this.buildComplianceRequirements(task);
    
    return `
${agentTemplate}

## Task Context
**Project Type**: ${task.project?.type || 'educational'}
**Task**: ${task.title}
**Description**: ${task.description}
**Complexity**: ${task.complexity}
**Type**: ${task.type}

## Educational Requirements
${educationalContext}

## Compliance Requirements
${complianceRequirements}

## Specific Instructions
${instructions}

## Success Criteria
- Code follows educational best practices
- Accessibility compliance (WCAG 2.1 AA minimum)
- Student data protection (FERPA compliant)
- Comprehensive testing (>80% coverage)
- Clear documentation for educational stakeholders

## Output Requirements
Please provide:
1. Implementation code
2. Test files
3. Documentation
4. Educational impact summary
5. Compliance checklist
`;
  }

  /**
   * Build review-specific instructions
   */
  buildReviewInstructions(task, codeFiles, reviewTemplate) {
    return `
${reviewTemplate}

## Code Review Task
**Task**: ${task.title}
**Complexity**: ${task.complexity}
**Educational Context**: ${task.educationalImpact?.learningObjectives?.join(', ') || 'General educational feature'}

## Files to Review
${codeFiles.map(file => `- ${file.path}`).join('\n')}

## Review Criteria
1. **Functionality (30%)**: Does the code work as intended?
2. **Educational Value (25%)**: Does it enhance learning outcomes?
3. **Accessibility (20%)**: WCAG 2.1 AA compliance
4. **Security & Privacy (15%)**: FERPA/COPPA compliance
5. **Code Quality (10%)**: Maintainability and standards

## Required Output Format
Please provide your review in JSON format:
{
  "score": 85,
  "status": "approved|changes-requested|rejected",
  "summary": "Overall review summary",
  "feedback": [
    {
      "category": "functionality|accessibility|security|quality",
      "severity": "info|warning|error|critical",
      "message": "Specific feedback",
      "file": "file path",
      "line": 10,
      "suggestion": "How to fix"
    }
  ],
  "suggestions": ["General improvement suggestions"],
  "complianceIssues": ["Any compliance violations"],
  "educationalImpact": "Assessment of educational value"
}
`;
  }

  /**
   * Parse review results from Claude output
   */
  parseReviewResult(output) {
    try {
      // Extract JSON from output (Claude might include additional text)
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // Fallback to manual parsing if JSON not found
      return {
        score: 70,
        status: 'changes-requested',
        summary: 'Review completed but format parsing failed',
        feedback: [],
        suggestions: ['Please review the output format'],
        complianceIssues: []
      };
    } catch (error) {
      throw new Error(`Failed to parse review result: ${error.message}`);
    }
  }

  /**
   * Run Claude Code command
   */
  async runClaudeCommand(instructions, workspacePath, agent) {
    const model = this.getModelForAgent(agent);
    const tempInstructionFile = path.join('/tmp', `claude-instructions-${Date.now()}.md`);
    
    try {
      // Write instructions to temporary file
      await fs.writeFile(tempInstructionFile, instructions);
      
      // Build Claude command
      const command = [
        this.claudePath,
        '--model', model,
        '--file', tempInstructionFile
      ];
      
      if (workspacePath) {
        command.push('--workspace', workspacePath);
      }
      
      // Execute command
      const { stdout, stderr } = await execAsync(command.join(' '), {
        cwd: workspacePath || process.cwd(),
        timeout: 300000 // 5 minutes timeout
      });
      
      // Parse output and extract information
      const result = this.parseClaudeOutput(stdout);
      
      return result;
    } catch (error) {
      throw new Error(`Claude command execution failed: ${error.message}`);
    } finally {
      // Clean up temporary file
      try {
        await fs.unlink(tempInstructionFile);
      } catch (cleanupError) {
        console.warn('Failed to cleanup temp file:', cleanupError.message);
      }
    }
  }

  /**
   * Parse Claude Code output
   */
  parseClaudeOutput(output) {
    return {
      output,
      tokens: this.extractTokenCount(output),
      codeChanges: this.extractCodeChanges(output),
      artifacts: this.extractArtifacts(output)
    };
  }

  /**
   * Get appropriate Claude model for agent type
   */
  getModelForAgent(agentType) {
    const modelMapping = {
      'junior-developer': 'claude-3-haiku-20240307',
      'senior-developer': 'claude-3-opus-20240229',
      'qa-engineer': 'claude-3-sonnet-20240229',
      'product-manager': 'claude-3-sonnet-20240229',
      'project-manager': 'claude-3-sonnet-20240229'
    };
    
    return modelMapping[agentType] || this.defaultModel;
  }

  /**
   * Build educational context for instructions
   */
  buildEducationalContext(task) {
    const context = [];
    
    if (task.educationalImpact?.learningObjectives) {
      context.push(`**Learning Objectives**: ${task.educationalImpact.learningObjectives.join(', ')}`);
    }
    
    if (task.educationalImpact?.targetAudience) {
      context.push(`**Target Audience**: ${task.educationalImpact.targetAudience}`);
    }
    
    if (task.educationalImpact?.expectedOutcomes) {
      context.push(`**Expected Outcomes**: ${task.educationalImpact.expectedOutcomes.join(', ')}`);
    }
    
    return context.join('\n');
  }

  /**
   * Build compliance requirements
   */
  buildComplianceRequirements(task) {
    const requirements = [];
    
    if (task.compliance?.ferpaReview.required) {
      requirements.push('- FERPA compliance: No student PII in logs or client-side code');
    }
    
    if (task.compliance?.coppaReview.required) {
      requirements.push('- COPPA compliance: Parental consent for under-13 users');
    }
    
    if (task.testing?.accessibilityTests.required) {
      const level = task.testing.accessibilityTests.wcagLevel.toUpperCase();
      requirements.push(`- Accessibility: WCAG 2.1 ${level} compliance required`);
    }
    
    return requirements.join('\n');
  }

  // Helper methods for parsing output
  extractTokenCount(output) {
    const tokenMatch = output.match(/Tokens used: (\d+)/);
    return tokenMatch ? parseInt(tokenMatch[1]) : 0;
  }

  extractCodeChanges(output) {
    // Simple heuristic - count lines that look like code changes
    const lines = output.split('\n');
    const addedLines = lines.filter(line => line.startsWith('+')).length;
    const removedLines = lines.filter(line => line.startsWith('-')).length;
    
    return {
      linesAdded: addedLines,
      linesRemoved: removedLines,
      filesModified: this.extractModifiedFiles(output)
    };
  }

  extractModifiedFiles(output) {
    const fileMatches = output.match(/(?:Created|Modified|Updated):\s*([^\n]+)/g);
    return fileMatches ? fileMatches.map(match => match.split(':')[1].trim()) : [];
  }

  extractArtifacts(output) {
    // Extract file paths that were created or modified
    return this.extractModifiedFiles(output);
  }

  getDefaultAgentTemplate(agentType) {
    return `# ${agentType.charAt(0).toUpperCase() + agentType.slice(1)} Agent

You are a ${agentType} specializing in educational technology development.

## Core Responsibilities
- Follow educational best practices
- Ensure accessibility compliance
- Protect student data privacy
- Create maintainable, testable code

## Educational Context
Always consider the learning impact of your work and prioritize student success.
`;
  }

  // Additional helper methods
  async cloneRepository(repoUrl, workspacePath) {
    try {
      await execAsync(`git clone ${repoUrl} ${workspacePath}`);
    } catch (error) {
      console.warn(`Failed to clone repository: ${error.message}`);
    }
  }

  async createBranch(workspacePath, branchName) {
    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd: workspacePath });
    } catch (error) {
      console.warn(`Failed to create branch: ${error.message}`);
    }
  }

  buildTestInstructions(task, testType) {
    return `
# Test Generation for Educational Feature

## Task: ${task.title}
**Type**: ${testType} tests
**Educational Context**: ${task.educationalImpact?.learningObjectives?.join(', ') || 'Educational feature'}

## Requirements
- Generate comprehensive ${testType} tests
- Include accessibility testing
- Test educational workflows
- Ensure student data protection
- Achieve >80% code coverage

## Focus Areas
1. Core functionality
2. Educational user flows
3. Accessibility compliance
4. Data privacy protection
5. Error handling and edge cases

Please generate test files with clear, educational context.
`;
  }

  buildAccessibilityInstructions(task, componentFiles) {
    return `
# Accessibility Compliance Check

## Task: ${task.title}
**Components**: ${componentFiles.map(f => f.name).join(', ')}
**Required Level**: WCAG 2.1 AA

## Check Requirements
1. Keyboard navigation support
2. Screen reader compatibility
3. Color contrast compliance
4. Form accessibility
5. Educational content accessibility

## Output Format
Please provide accessibility report in JSON:
{
  "wcagScore": 95,
  "level": "AA",
  "violations": [
    {
      "severity": "error|warning|info",
      "message": "Violation description",
      "element": "CSS selector",
      "fix": "How to resolve"
    }
  ],
  "recommendations": ["Improvement suggestions"]
}
`;
  }

  parseAccessibilityResult(output) {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return {
        wcagScore: 80,
        level: 'AA',
        violations: [],
        recommendations: ['Manual accessibility review recommended']
      };
    } catch (error) {
      throw new Error(`Failed to parse accessibility result: ${error.message}`);
    }
  }
}

module.exports = ClaudeService;