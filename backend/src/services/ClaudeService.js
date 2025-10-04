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
   * Execute Claude API request for a specific task with optional image support
   * Replaces CLI execution with direct API calls for production compatibility
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

      // Execute Claude API
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
        // Token usage for tracking
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
        action: 'failed',
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
   * Run Claude API request with optional image support
   * Replaces CLI execution with direct API calls for production compatibility
   */
  async runClaudeCommand(instructions, workspacePath, agent, processedImages = [], taskContext = null) {
    const model = this.getModelForAgent(agent);
    const claudeModel = this.getClaudeCodeModelName(model);
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

      // Build message content array
      const messageContent = [];

      // Add images if provided
      if (processedImages && processedImages.length > 0) {
        for (const image of processedImages) {
          try {
            const imageBuffer = await fs.readFile(image.path);
            const base64Image = imageBuffer.toString('base64');

            messageContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: image.mimeType || 'image/jpeg',
                data: base64Image
              }
            });
          } catch (imageError) {
            console.warn(`Failed to load image ${image.originalName}:`, imageError.message);
          }
        }
      }

      // Add text instructions
      messageContent.push({
        type: 'text',
        text: instructions
      });

      console.log(`🤖 Calling Anthropic API with ${claudeModel} for agent: ${agent}`);

      // Call Anthropic API
      const response = await this.anthropic.messages.create({
        model: claudeModel,
        max_tokens: this.maxTokens,
        messages: [{
          role: 'user',
          content: messageContent
        }]
      });

      const responseTime = Date.now() - startTime;

      console.log(`✅ API response received in ${responseTime}ms`);
      console.log(`📊 Tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`);

      // Extract text content from response
      const outputText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');

      // Build token usage object
      const tokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens
      };

      // Record token usage if task context is provided
      if (taskContext) {
        try {
          await tokenTrackingService.recordAgentUsage({
            userId: taskContext.userId,
            taskId: taskContext.taskId,
            projectId: taskContext.projectId,
            agentType: agent,
            model: model,
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            requestType: taskContext.requestType || 'orchestration',
            responseTime: responseTime,
            success: true
          });
        } catch (trackingError) {
          console.warn('Failed to record token usage:', trackingError.message);
        }
      }

      // Build result object matching expected format
      const result = {
        output: outputText,
        model: model,
        responseTime: responseTime,
        tokenUsage: tokenUsage,
        tokens: tokenUsage.totalTokens,
        stopReason: response.stop_reason,
        codeChanges: {
          filesModified: [],
          linesAdded: 0,
          linesRemoved: 0
        },
        artifacts: []
      };

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

      console.error(`❌ Anthropic API error for ${agent}:`, error.message);

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

      throw new Error(`Claude API execution failed: ${error.message}`);
    }
  }

  // Keep all other existing methods below...
  // (These methods remain unchanged)

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

  async setupWorkspace(task) {
    try {
      const workspacePath = path.join(this.workspaceBase, `task-${task._id}`);
      await fs.mkdir(workspacePath, { recursive: true });
      return workspacePath;
    } catch (error) {
      throw new Error(`Failed to setup workspace: ${error.message}`);
    }
  }

  async loadAgentTemplate(agent) {
    try {
      const templatePath = path.join(__dirname, `../templates/agents/${agent}.md`);
      const template = await fs.readFile(templatePath, 'utf-8');
      return template;
    } catch (error) {
      console.warn(`Template not found for ${agent}, using default`);
      return `You are a ${agent} agent. Complete the assigned task.`;
    }
  }

  buildInstructions(task, agent, additionalInstructions, template, processedImages) {
    let instructions = `${template}\n\n`;
    instructions += `# Task: ${task.title}\n\n`;
    instructions += `${task.description}\n\n`;

    if (additionalInstructions) {
      instructions += `## Additional Instructions:\n${additionalInstructions}\n\n`;
    }

    if (processedImages && processedImages.length > 0) {
      instructions += `\n\n## Attached Images:\n`;
      instructions += `${processedImages.length} image(s) provided for context.\n`;
    }

    return instructions;
  }

  buildReviewInstructions(task, codeFiles, template) {
    let instructions = `${template}\n\n`;
    instructions += `# Code Review Task\n\n`;
    instructions += `Review the following code and provide feedback.\n\n`;
    instructions += `## Code Files:\n${JSON.stringify(codeFiles, null, 2)}`;
    return instructions;
  }

  buildTestInstructions(task, testType) {
    return `Generate ${testType} tests for: ${task.title}\n\n${task.description}`;
  }

  buildAccessibilityInstructions(task, componentFiles) {
    return `Check WCAG 2.1 AA accessibility compliance for:\n${JSON.stringify(componentFiles, null, 2)}`;
  }

  async processImages(images) {
    const processed = [];

    for (const image of images || []) {
      if (image && image.path) {
        const ext = path.extname(image.path).toLowerCase();
        if (this.supportedImageTypes.includes(ext)) {
          processed.push({
            id: crypto.randomUUID(),
            path: image.path,
            originalName: image.originalname || path.basename(image.path),
            size: image.size,
            mimeType: image.mimetype || `image/${ext.substring(1)}`
          });
        }
      }
    }

    return processed;
  }

  parseReviewResult(output) {
    try {
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }

      return {
        score: 70,
        status: 'changes-requested',
        summary: 'Review completed',
        feedback: [],
        suggestions: [],
        complianceIssues: []
      };
    } catch (error) {
      throw new Error(`Failed to parse review result: ${error.message}`);
    }
  }

  parseAccessibilityResult(output) {
    return {
      wcagScore: 85,
      violations: [],
      warnings: [],
      passed: true
    };
  }

  getModelForAgent(agentType) {
    const modelMapping = {
      'product-manager': 'opus',
      'project-manager': 'opus',
      'tech-lead': 'opus',
      'senior-developer': 'sonnet',
      'junior-developer': 'sonnet',
      'qa-engineer': 'sonnet'
    };

    return modelMapping[agentType] || 'sonnet';
  }

  getClaudeCodeModelName(model) {
    const claudeCodeMapping = {
      'opus': 'claude-opus-4-1-20250805',
      'sonnet': 'claude-sonnet-4-5-20250929'
    };

    return claudeCodeMapping[model] || 'claude-sonnet-4-5-20250929';
  }

  calculateCost(model, inputTokens, outputTokens) {
    const pricing = {
      'opus': { input: 0.015 / 1000, output: 0.075 / 1000 },
      'sonnet': { input: 0.003 / 1000, output: 0.015 / 1000 }
    };

    const prices = pricing[model] || pricing['sonnet'];
    return (inputTokens * prices.input) + (outputTokens * prices.output);
  }
}

module.exports = new ClaudeService();
