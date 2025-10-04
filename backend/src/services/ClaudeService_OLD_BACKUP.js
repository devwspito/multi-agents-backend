const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs').promises;
const path = require('path');
const Activity = require('../models/Activity');
const tokenTrackingService = require('./TokenTrackingService');
const crypto = require('crypto');

class ClaudeService {
  constructor() {
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.workspaceBase = process.env.WORKSPACE_BASE || './workspaces';
    this.defaultModel = process.env.DEFAULT_CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    this.supportedImageTypes = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
    this.maxTokens = 8192; // Default max tokens for responses
  }

  /**
   * Execute Claude Code command for a specific task with optional image support
   */
  async executeTask(task, agent, instructions, images = [], userId = null) {
    const startTime = Date.now();
    const workspacePath = await this.setupWorkspace(task);
    
    try {
      // Process uploaded images if any
      const processedImages = await this.processImages(images);
      
      // Prepare agent-specific context
      const agentTemplate = await this.loadAgentTemplate(agent);
      const fullInstructions = this.buildInstructions(task, agent, instructions, agentTemplate, processedImages);
      
      // Prepare task context for token tracking
      const taskContext = userId ? {
        userId: userId,
        taskId: task._id,
        projectId: task.project,
        requestType: 'orchestration'
      } : null;
      
      // Execute Claude Code
      const result = await this.runClaudeCommand(fullInstructions, workspacePath, agent, processedImages, taskContext);
      
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
        artifacts: result.artifacts,
        attachedImages: result.attachedImages,
        // NUEVO: Información de tokens para tracking granular
        tokenUsage: {
          agent: agent,
          model: result.model || this.getModelForAgent(agent),
          inputTokens: result.tokenUsage?.inputTokens || 0,
          outputTokens: result.tokenUsage?.outputTokens || 0,
          cost: this.calculateCost(
            this.getModelForAgent(agent),
            result.tokenUsage?.inputTokens || 0,
            result.tokenUsage?.outputTokens || 0
          ),
          duration: executionTime,
          startedAt: new Date(startTime),
          completedAt: new Date(),
          status: 'success'
        }
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
   * Process uploaded images for Claude Code
   */
  async processImages(images) {
    if (!images || images.length === 0) {
      return [];
    }

    const processedImages = [];
    
    for (const image of images) {
      try {
        // Validate image type
        const ext = path.extname(image.originalname).toLowerCase();
        if (!this.supportedImageTypes.includes(ext)) {
          throw new Error(`Unsupported image type: ${ext}`);
        }

        // Generate unique filename
        const filename = `${crypto.randomUUID()}${ext}`;
        const imagePath = path.join(this.uploadDir, filename);

        // Ensure upload directory exists
        await fs.mkdir(this.uploadDir, { recursive: true });

        // Save image
        await fs.writeFile(imagePath, image.buffer);

        processedImages.push({
          id: crypto.randomUUID(),
          originalName: image.originalname,
          filename,
          path: imagePath,
          size: image.size,
          mimeType: image.mimetype
        });
      } catch (error) {
        console.error(`Failed to process image ${image.originalname}:`, error.message);
        throw new Error(`Image processing failed: ${error.message}`);
      }
    }

    return processedImages;
  }

  /**
   * Build comprehensive instructions for Claude Code with image support
   */
  buildInstructions(task, agent, instructions, agentTemplate, processedImages = []) {
    const educationalContext = this.buildEducationalContext(task);
    const complianceRequirements = this.buildComplianceRequirements(task);
    const imageContext = this.buildImageContext(processedImages);
    
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

${imageContext}

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
   * Build image context for instructions
   */
  buildImageContext(processedImages) {
    if (!processedImages || processedImages.length === 0) {
      return '';
    }

    const imageList = processedImages.map(img => 
      `- ${img.originalName} (${img.mimeType}, ${Math.round(img.size / 1024)}KB)`
    ).join('\n');

    return `
## Attached Images
The following images have been provided for analysis and implementation guidance:
${imageList}

Please analyze these images and incorporate their requirements into your implementation. Consider:
- UI/UX design elements shown in the images
- Accessibility implications of visual elements
- Educational content structure and layout
- Any specific features or components visible in the images
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
   * Run Claude Code command with optional image support
   */
  async runClaudeCommand(instructions, workspacePath, agent, processedImages = [], taskContext = null) {
    const model = this.getModelForAgent(agent);
    const claudeCodeModel = this.getClaudeCodeModelName(model);
    const tempInstructionFile = path.join('/tmp', `claude-instructions-${Date.now()}.md`);
    const startTime = Date.now();
    
    try {
      // Check token limits before execution if task context is provided
      if (taskContext) {
        const estimatedInputTokens = Math.ceil(instructions.length / 4); // Rough estimation
        const limitCheck = await tokenTrackingService.checkUserLimits(
          taskContext.userId, 
          model, 
          estimatedInputTokens
        );
        
        if (!limitCheck.allowed) {
          throw new Error(`Token limit exceeded: ${limitCheck.reason}. Current: ${limitCheck.current}, Limit: ${limitCheck.limit}`);
        }
      }
      
      // Write instructions to temporary file
      await fs.writeFile(tempInstructionFile, instructions);
      
      // Build Claude command
      const command = [
        this.claudePath,
        '--model', claudeCodeModel,
        '--file', tempInstructionFile
      ];
      
      if (workspacePath) {
        command.push('--workspace', workspacePath);
      }

      // Add image attachments if any
      if (processedImages && processedImages.length > 0) {
        for (const image of processedImages) {
          command.push('--attach', image.path);
        }
      }
      
      // Execute command
      const { stdout, stderr } = await execAsync(command.join(' '), {
        cwd: workspacePath || process.cwd(),
        timeout: 300000 // 5 minutes timeout
      });
      
      const responseTime = Date.now() - startTime;
      
      // Parse output and extract information
      const result = this.parseClaudeOutput(stdout, stderr);
      
      // Extract token usage from Claude Code output
      const tokenUsage = this.extractTokenUsage(stdout, stderr);
      
      // Record token usage if task context is provided
      if (taskContext && tokenUsage) {
        try {
          await tokenTrackingService.recordAgentUsage({
            userId: taskContext.userId,
            taskId: taskContext.taskId,
            projectId: taskContext.projectId,
            agentType: agent,
            model: model,
            inputTokens: tokenUsage.inputTokens || 0,
            outputTokens: tokenUsage.outputTokens || 0,
            requestType: taskContext.requestType || 'orchestration',
            responseTime: responseTime,
            success: true
          });
        } catch (trackingError) {
          console.warn('Failed to record token usage:', trackingError.message);
        }
      }
      
      // Add metadata to result
      result.model = model;
      result.responseTime = responseTime;
      result.tokenUsage = tokenUsage;
      
      // Add image information to result
      if (processedImages.length > 0) {
        result.attachedImages = processedImages.map(img => ({
          id: img.id,
          originalName: img.originalName,
          size: img.size,
          mimeType: img.mimeType
        }));
      }
      
      return result;
    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      // Record failed usage if task context is provided
      if (taskContext) {
        try {
          await tokenTrackingService.recordAgentUsage({
            userId: taskContext.userId,
            taskId: taskContext.taskId,
            projectId: taskContext.projectId,
            agentType: agent,
            model: model,
            inputTokens: 0,
            outputTokens: 0,
            requestType: taskContext.requestType || 'orchestration',
            responseTime: responseTime,
            success: false,
            errorMessage: error.message
          });
        } catch (trackingError) {
          console.warn('Failed to record failed token usage:', trackingError.message);
        }
      }
      
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
  parseClaudeOutput(stdout, stderr = '') {
    return {
      output: stdout,
      stderr: stderr,
      tokens: this.extractTokenCount(stdout),
      codeChanges: this.extractCodeChanges(stdout),
      artifacts: this.extractArtifacts(stdout)
    };
  }

  /**
   * Extract token usage from Claude Code output
   */
  extractTokenUsage(stdout, stderr) {
    try {
      // Claude Code typically shows token usage in stderr or at the end of stdout
      const output = stdout + '\n' + stderr;
      
      // Look for token usage patterns that Claude Code might output
      const patterns = [
        /Input tokens:\s*(\d+)/i,
        /Output tokens:\s*(\d+)/i,
        /Total tokens:\s*(\d+)/i,
        /(\d+)\s*input tokens/i,
        /(\d+)\s*output tokens/i,
        /Token usage:\s*(\d+)\s*\/\s*(\d+)/i
      ];
      
      let inputTokens = 0;
      let outputTokens = 0;
      
      // Try to extract from various patterns
      const inputMatch = output.match(/Input tokens?:\s*(\d+)/i) || 
                        output.match(/(\d+)\s*input tokens?/i);
      const outputMatch = output.match(/Output tokens?:\s*(\d+)/i) || 
                         output.match(/(\d+)\s*output tokens?/i);
      
      if (inputMatch) {
        inputTokens = parseInt(inputMatch[1]);
      }
      
      if (outputMatch) {
        outputTokens = parseInt(outputMatch[1]);
      }
      
      // If we don't find specific input/output breakdown, estimate based on request
      if (inputTokens === 0 && outputTokens === 0) {
        // Estimate based on character count (rough approximation)
        const outputLength = stdout.length;
        outputTokens = Math.ceil(outputLength / 4); // Rough token estimation
        inputTokens = Math.ceil(outputLength / 6); // Assume input was smaller
      }
      
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      };
    } catch (error) {
      console.warn('Failed to extract token usage:', error.message);
      return {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      };
    }
  }

  /**
   * Get appropriate Claude model for agent type
   */
  getModelForAgent(agentType) {
    // Model mapping based on our optimized configuration
    const modelMapping = {
      // Planning agents use Opus (complex reasoning)
      'product-manager': 'opus',
      'project-manager': 'opus', 
      'tech-lead': 'opus',
      
      // Implementation agents use Sonnet (execution)
      'senior-developer': 'sonnet',
      'junior-developer': 'sonnet',
      'qa-engineer': 'sonnet'
    };
    
    return modelMapping[agentType] || 'sonnet'; // Default to sonnet
  }

  /**
   * Get Claude model name for API/CLI command
   */
  getClaudeCodeModelName(model) {
    const claudeCodeMapping = {
      'opus': 'claude-opus-4-1-20250805',      // Opus 4.1
      'sonnet': 'claude-sonnet-4-5-20250929'   // Sonnet 4.5
    };

    return claudeCodeMapping[model] || 'claude-sonnet-4-5-20250929';
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

  /**
   * Clean up processed images after task completion
   */
  async cleanupImages(processedImages) {
    if (!processedImages || processedImages.length === 0) {
      return;
    }

    for (const image of processedImages) {
      try {
        await fs.unlink(image.path);
      } catch (error) {
        console.warn(`Failed to cleanup image ${image.filename}:`, error.message);
      }
    }
  }

  /**
   * Get supported image types
   */
  getSupportedImageTypes() {
    return [...this.supportedImageTypes];
  }

  /**
   * Validate image file
   */
  validateImage(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (!this.supportedImageTypes.includes(ext)) {
      throw new Error(`Unsupported image type: ${ext}. Supported types: ${this.supportedImageTypes.join(', ')}`);
    }

    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      throw new Error(`Image too large: ${Math.round(file.size / 1024 / 1024)}MB. Maximum size: 10MB`);
    }

    return true;
  }

  /**
   * NUEVO: Calcular costo según modelo y tokens
   */
  calculateCost(model, inputTokens, outputTokens) {
    const prices = {
      'opus': {
        input: 15 / 1_000_000,  // $15 per 1M tokens
        output: 75 / 1_000_000   // $75 per 1M tokens
      },
      'sonnet': {
        input: 3 / 1_000_000,   // $3 per 1M tokens
        output: 15 / 1_000_000   // $15 per 1M tokens
      }
    };

    const pricing = prices[model];
    if (!pricing) return 0;

    const inputCost = inputTokens * pricing.input;
    const outputCost = outputTokens * pricing.output;

    return parseFloat((inputCost + outputCost).toFixed(6));
  }

  /**
   * NUEVO: Determinar tipo de operación según agente
   */
  getOperationType(agentType) {
    const operationMap = {
      'product-manager': 'analysis',
      'project-manager': 'planning',
      'tech-lead': 'design',
      'senior-developer': 'implementation',
      'junior-developer': 'implementation',
      'qa-engineer': 'testing'
    };
    return operationMap[agentType] || 'analysis';
  }
}

module.exports = ClaudeService;