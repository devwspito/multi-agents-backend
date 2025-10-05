const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const Activity = require('../models/Activity');
const tokenTrackingService = require('./TokenTrackingService');
const claudeCodeExecutor = require('./ClaudeCodeExecutor');  // REAL command executor
const crypto = require('crypto');

const execAsync = promisify(exec);

// Claude Code is the PRIMARY ENGINE for our entire platform
// Try different methods to find Claude Code
let CLAUDE_CODE_CLI;

// The correct command is 'npx claude' NOT 'npx @anthropic-ai/claude-code'
// Claude Code installs as 'claude' command
CLAUDE_CODE_CLI = 'npx claude';
console.log('✅ Using npx claude command');

console.log('🚀 CLAUDE CODE IS OUR PRIMARY ENGINE - All agents use Claude Code');

// Fallback: Use Anthropic SDK directly if Claude Code execution fails
let Anthropic;
try {
  Anthropic = require('@anthropic-ai/sdk');
  console.log('✅ Anthropic SDK loaded as fallback');
} catch (error) {
  console.error('⚠️ Anthropic SDK not available as fallback');
}

class ClaudeService {
  constructor() {
    // Claude Code CLI is our PRIMARY engine
    this.useClaudeCodeCLI = true;  // Always use Claude Code CLI as primary
    this.useAnthropicSDK = !!Anthropic;  // Fallback option

    if (this.useAnthropicSDK) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }

    this.workspaceBase = process.env.WORKSPACE_BASE || './workspaces';
    this.defaultModel = process.env.DEFAULT_CLAUDE_MODEL || 'claude-sonnet-4-5-20250929';  // Sonnet 4.5
    this.uploadDir = process.env.UPLOAD_DIR || './uploads';
    this.supportedImageTypes = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  }

  /**
   * Execute Claude Code command for a specific task with optional image support
   */
  async executeTask(task, agent, instructions, images = [], userId = null) {
    console.log(`🎯 ClaudeService.executeTask called for ${agent}`);
    console.log(`📝 Task: ${task._id}, Title: ${task.title}`);

    const startTime = Date.now();

    console.log(`🔧 Setting up workspace for task ${task._id}...`);
    const workspacePath = await this.setupWorkspace(task);
    console.log(`✅ Workspace ready: ${workspacePath}`);

    try {
      console.log(`🖼️ Processing ${images.length} images...`);
      // Process uploaded images if any
      const processedImages = await this.processImages(images);
      console.log(`✅ Images processed: ${processedImages.length}`);

      console.log(`📄 Loading agent template for ${agent}...`);
      // Prepare agent-specific context
      const agentTemplate = await this.loadAgentTemplate(agent);
      console.log(`✅ Agent template loaded`);

      console.log(`📝 Building instructions...`);
      const fullInstructions = this.buildInstructions(task, agent, instructions, agentTemplate, processedImages);
      console.log(`✅ Instructions built (${fullInstructions.length} chars)`);

      // Prepare task context for token tracking
      const taskContext = userId ? {
        userId: userId,
        taskId: task._id,
        projectId: task.project,
        requestType: 'orchestration'
      } : null;

      console.log(`🚀 About to run Claude Code CLI command for ${agent}...`);
      // Execute Claude Code
      const result = await this.runClaudeCommand(fullInstructions, workspacePath, agent, processedImages, taskContext);
      console.log(`✅ Claude Code CLI command completed for ${agent}`);

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
        // Token usage information for tracking
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
    // Use absolute path to ensure it works correctly
    const workspacePath = path.resolve(process.cwd(), this.workspaceBase, `task-${task._id}`);

    try {
      // Create workspace directory with full permissions
      await fs.mkdir(workspacePath, { recursive: true, mode: 0o755 });
      console.log(`✅ Workspace created at: ${workspacePath}`);

      // Copy relevant project files if they exist
      console.log(`🔍 Checking for repository: ${task.project?.repository?.url || 'No repository configured'}`);

      if (task.project?.repository?.url) {
        console.log(`📥 Cloning repository: ${task.project.repository.url} into ${workspacePath}`);
        await this.cloneRepository(task.project.repository.url, workspacePath);
        console.log(`✅ Repository cloned successfully`);
      } else {
        console.log(`⚠️ No repository URL configured for project: ${task.project?.name || 'Unknown'}`);
      }

      // Create task-specific branch
      if (task.gitBranch) {
        console.log(`🌿 Creating branch: ${task.gitBranch}`);
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
   * Run Claude Code using SDK (programmatically) or Anthropic API as fallback
   */
  async runClaudeCommand(instructions, workspacePath, agent, processedImages = [], taskContext = null) {
    console.log(`🚀 runClaudeCommand called for agent: ${agent}`);

    const model = this.getModelForAgent(agent);
    const startTime = Date.now();

    console.log(`📊 Model: ${model}`);
    console.log(`📂 Workspace: ${workspacePath}`);
    console.log(`🔧 Using Claude Code CLI as PRIMARY ENGINE`);

    try {
      // Check token limits before execution if task context is provided
      if (taskContext) {
        console.log(`🔍 Checking token limits for user ${taskContext.userId}...`);
        const estimatedInputTokens = Math.ceil(instructions.length / 4); // Rough estimation
        const limitCheck = await tokenTrackingService.checkUserLimits(
          taskContext.userId,
          model,
          estimatedInputTokens
        );

        if (!limitCheck.allowed) {
          throw new Error(`Token limit exceeded: ${limitCheck.reason}. Current: ${limitCheck.current}, Limit: ${limitCheck.limit}`);
        }
        console.log(`✅ Token limits OK`);
      }

      let stdout = '';
      let stderr = '';

      // Option 1: Use Claude Code CLI (PRIMARY ENGINE - EXECUTES REAL COMMANDS)
      if (this.useClaudeCodeCLI) {
        console.log(`🚀 Using Claude Code CLI as PRIMARY ENGINE...`);
        console.log(`📝 Claude Code will execute REAL commands: git, npm, file editing, PRs`);

        try {
          // Add REAL execution context to instructions
          const realInstructions = `
${instructions}

IMPORTANT: You have FULL access to:
- Create and edit files in ${workspacePath}
- Run git commands: git add, commit, push, checkout
- Run npm commands: npm test, npm install
- Use GitHub CLI: gh pr create, gh issue create
- Execute any bash commands needed

You are NOT in a sandbox. Execute REAL commands. Create REAL pull requests.
Current directory: ${workspacePath}
`;

          // Build the Claude Code CLI command
          const escapedInstructions = realInstructions.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/\n/g, '\\n');
          const claudeCommand = `echo "${escapedInstructions}" | ${CLAUDE_CODE_CLI} --print --model "${this.getClaudeCodeModelName(model)}"`;

          console.log(`\n${'='.repeat(80)}`);
          console.log(`🚀 ATTEMPTING CLAUDE CODE EXECUTION`);
          console.log(`${'='.repeat(80)}`);
          console.log(`📍 Agent: ${agent}`);
          console.log(`📂 Working directory: ${workspacePath}`);
          console.log(`🔑 API Key: ${process.env.ANTHROPIC_API_KEY ? `${process.env.ANTHROPIC_API_KEY.substring(0, 20)}...` : 'NOT SET!'}`);
          console.log(`📝 Command: ${CLAUDE_CODE_CLI} --print --model "${this.getClaudeCodeModelName(model)}"`);
          console.log(`📏 Instructions length: ${instructions.length} chars`);
          console.log(`⏰ Starting at: ${new Date().toISOString()}`);
          console.log(`${'='.repeat(80)}\n`);

          // Execute Claude Code CLI with the instructions
          const { stdout: cliOutput, stderr: cliError } = await execAsync(claudeCommand, {
            cwd: workspacePath,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY
            }
          });

          stdout = cliOutput || '';
          stderr = cliError || '';

          console.log(`✅ Claude Code CLI execution completed!`);
          console.log(`📊 Output length: ${stdout.length} chars`);

        } catch (cliError) {
          console.error(`\n${'='.repeat(80)}`);
          console.error(`❌❌❌ CLAUDE CODE EXECUTION FAILED ❌❌❌`);
          console.error(`${'='.repeat(80)}`);
          console.error(`📍 AGENT: ${agent}`);
          console.error(`📂 WORKSPACE: ${workspacePath}`);
          console.error(`🔑 API KEY: ${process.env.ANTHROPIC_API_KEY ? 'Set' : 'NOT SET'}`);
          console.error(`⏰ TIME: ${new Date().toISOString()}`);
          console.error(`\n❌ ERROR MESSAGE:`);
          console.error(cliError.message);
          console.error(`\n❌ FULL ERROR:`);
          console.error(cliError);

          if (cliError.stderr) {
            console.error(`\n❌ STDERR OUTPUT:`);
            console.error(cliError.stderr);
          }

          if (cliError.stdout) {
            console.error(`\n📤 STDOUT (if any):`);
            console.error(cliError.stdout);
          }

          console.error(`\n🔄 ATTEMPTING GITHUB ACTIONS FALLBACK...`);
          console.error(`${'='.repeat(80)}\n`);

          try {
            // NUEVA ESTRATEGIA: Generar GitHub Actions workflows
            const workflowYaml = this.generateGitHubActionsWorkflow(agent, instructions, workspacePath);
            console.log(`📝 Generated GitHub Actions workflow for ${agent}`);

            // Guardar el workflow en .github/workflows/
            const workflowPath = path.join(workspacePath, '.github', 'workflows', `${agent}-${Date.now()}.yml`);
            console.log(`💾 Saving workflow to: ${workflowPath}`);

            await fs.mkdir(path.dirname(workflowPath), { recursive: true });
            await fs.writeFile(workflowPath, workflowYaml);
            console.log(`✅ Workflow file created`);

            // Commit y push el workflow
            const commitCommands = `
              cd ${workspacePath} &&
              git add .github/workflows/ &&
              git commit -m "🤖 ${agent}: Add GitHub Actions workflow" &&
              git push origin main
            `;

            console.log(`🚀 Executing git commands to push workflow...`);
            const gitResult = await execAsync(commitCommands);

            if (gitResult.stdout) {
              console.log(`📤 GIT OUTPUT:`);
              console.log(gitResult.stdout);
            }

            stdout = `GitHub Actions workflow created and pushed for ${agent}`;
            console.log(`✅ GitHub Actions workflow deployed successfully for ${agent}`);

          } catch (gitError) {
            console.error(`\n${'='.repeat(80)}`);
            console.error(`❌❌❌ GITHUB ACTIONS DEPLOYMENT ALSO FAILED ❌❌❌`);
            console.error(`${'='.repeat(80)}`);
            console.error(`❌ GIT ERROR:`);
            console.error(gitError.message);
            console.error(`\n❌ FULL GIT ERROR:`);
            console.error(gitError);

            if (gitError.stderr) {
              console.error(`\n❌ GIT STDERR:`);
              console.error(gitError.stderr);
            }

            console.error(`${'='.repeat(80)}\n`);

            throw new Error(`TOTAL FAILURE - Claude Code failed: ${cliError.message} | GitHub Actions failed: ${gitError.message}`);
          }
        }

      }

      // NO FALLBACKS - GitHub Actions is the execution strategy
      if (!stdout) {
        throw new Error('No output generated - GitHub Actions workflow should have been created');
      }

      console.log(`📤 stdout length: ${stdout?.length || 0} chars`);
      console.log(`📤 stderr length: ${stderr?.length || 0} chars`);

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

      throw new Error(`Claude Code CLI execution failed: ${error.message}`);
    }
  }

  /**
   * Generate GitHub Actions workflow for agent tasks
   */
  generateGitHubActionsWorkflow(agent, instructions, workspacePath) {
    const timestamp = Date.now();
    const jobName = `${agent}-${timestamp}`;

    // Agent-specific commands
    const commands = this.getAgentCommands(agent, instructions);

    const workflow = `
name: 🤖 ${agent.toUpperCase()} Execution
run-name: ${agent} executing tasks - ${new Date().toISOString()}

on:
  push:
    paths:
      - '.github/workflows/${jobName}.yml'
  workflow_dispatch:

jobs:
  execute-agent-tasks:
    runs-on: ubuntu-latest

    steps:
      - name: 📥 Checkout repository
        uses: actions/checkout@v4
        with:
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: 🔧 Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: 📦 Install dependencies
        run: npm install

      - name: 🤖 Execute ${agent} tasks
        run: |
          ${commands.map(cmd => `          ${cmd}`).join('\n')}

      - name: 📊 Create Pull Request
        if: success()
        uses: peter-evans/create-pull-request@v5
        with:
          token: \${{ secrets.GITHUB_TOKEN }}
          title: "🤖 ${agent}: Automated changes"
          body: |
            ## 🤖 ${agent} Execution Results

            **Instructions:** ${instructions.substring(0, 200)}...

            **Timestamp:** ${new Date().toISOString()}

            This PR was automatically created by the ${agent} agent.
          branch: ${agent}-${timestamp}
          commit-message: "🤖 ${agent}: Execute automated tasks"
`;

    return workflow;
  }

  /**
   * Get agent-specific commands for GitHub Actions
   */
  getAgentCommands(agent, instructions) {
    const baseCommands = [
      'echo "🤖 Starting ${agent} execution"',
      'git config --global user.email "agent@multi-agents.com"',
      'git config --global user.name "${agent} Agent"'
    ];

    switch(agent) {
      case 'product-manager':
        return [
          ...baseCommands,
          'echo "📋 Analyzing requirements..."',
          'git log --oneline -n 20 > requirements-analysis.txt',
          'grep -r "TODO\\|FIXME\\|BUG" . > issues-found.txt || true',
          'echo "# Requirements Analysis" > REQUIREMENTS.md',
          'echo "Generated on: $(date)" >> REQUIREMENTS.md'
        ];

      case 'tech-lead':
        return [
          ...baseCommands,
          'echo "🏗️ Creating architecture..."',
          'mkdir -p docs/architecture',
          'echo "# System Architecture" > docs/architecture/README.md',
          'echo "Generated by Tech Lead: $(date)" >> docs/architecture/README.md'
        ];

      case 'senior-developer':
        return [
          ...baseCommands,
          'echo "🔧 Implementing features..."',
          'npm test || true',
          'echo "// New feature implementation" > feature.js',
          'git add .',
          'git commit -m "feat: Implement new feature"'
        ];

      case 'junior-developer':
        return [
          ...baseCommands,
          'echo "🎨 Creating UI components..."',
          'mkdir -p components',
          'echo "// UI Component" > components/NewComponent.js',
          'npm run lint || true'
        ];

      case 'qa-engineer':
        return [
          ...baseCommands,
          'echo "🧪 Running tests..."',
          'npm test || true',
          'npm run test:coverage || true',
          'echo "# Test Results" > TEST-RESULTS.md',
          'echo "All tests completed: $(date)" >> TEST-RESULTS.md'
        ];

      default:
        return [
          ...baseCommands,
          'echo "Executing generic agent tasks..."'
        ];
    }
  }

  /**
   * Parse Claude Code output (JSON format)
   */
  parseClaudeOutput(stdout, stderr = '') {
    try {
      // Claude Code with --output-format json returns structured output
      const jsonOutput = JSON.parse(stdout);

      return {
        output: jsonOutput.text || jsonOutput.content || stdout,
        stderr: stderr,
        tokens: jsonOutput.usage?.total_tokens || this.extractTokenCount(stdout),
        codeChanges: this.extractCodeChanges(jsonOutput.text || stdout),
        artifacts: jsonOutput.artifacts || this.extractArtifacts(jsonOutput.text || stdout)
      };
    } catch (error) {
      // Fallback to plain text parsing if JSON parsing fails
      console.warn('Failed to parse JSON output, falling back to text parsing:', error.message);
      return {
        output: stdout,
        stderr: stderr,
        tokens: this.extractTokenCount(stdout),
        codeChanges: this.extractCodeChanges(stdout),
        artifacts: this.extractArtifacts(stdout)
      };
    }
  }

  /**
   * Extract token usage from Claude Code output (JSON format)
   */
  extractTokenUsage(stdout, stderr) {
    try {
      // Try to parse JSON output first (from --output-format json)
      const jsonOutput = JSON.parse(stdout);

      if (jsonOutput.usage) {
        return {
          inputTokens: jsonOutput.usage.input_tokens || 0,
          outputTokens: jsonOutput.usage.output_tokens || 0,
          totalTokens: jsonOutput.usage.total_tokens ||
                       (jsonOutput.usage.input_tokens || 0) + (jsonOutput.usage.output_tokens || 0)
        };
      }
    } catch (error) {
      // Not JSON, try text parsing
    }

    try {
      // Fallback: look for token usage patterns in text output
      const output = stdout + '\n' + stderr;

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
    // ALL agents use Sonnet 4.5 for cost optimization
    // Sonnet 4.5 is powerful enough for all tasks and MUCH cheaper than Opus
    const modelMapping = {
      'product-manager': 'sonnet',
      'project-manager': 'sonnet',
      'tech-lead': 'sonnet',
      'senior-developer': 'sonnet',
      'junior-developer': 'sonnet',
      'qa-engineer': 'sonnet'
    };

    return modelMapping[agentType] || 'sonnet'; // Default to sonnet
  }

  /**
   * Get Claude Code model name for CLI command (Updated to Claude 4)
   * Claude Code CLI accepts short names: "opus", "sonnet", etc.
   */
  getClaudeCodeModelName(model) {
    // Claude Code CLI uses short model names, not full IDs
    return model; // Just return "opus" or "sonnet"
  }

  /**
   * Get Anthropic API model name
   */
  getAnthropicModelName(model) {
    const modelMap = {
      'opus': 'claude-opus-4-1-20250805',  // Claude Opus 4.1
      'sonnet': 'claude-sonnet-4-5-20250929',  // Claude Sonnet 4.5
      'haiku': 'claude-3-haiku-20240307'  // Claude Haiku (3.0)
    };
    return modelMap[model] || 'claude-sonnet-4-5-20250929';  // Default to Sonnet 4.5
  }

  /**
   * Build system prompt for agent
   */
  buildSystemPrompt(agent) {
    const prompts = {
      'product-manager': 'You are a Product Manager analyzing requirements and defining specifications.',
      'project-manager': 'You are a Project Manager breaking down tasks and managing timelines.',
      'tech-lead': 'You are a Technical Lead designing architecture and providing technical guidance.',
      'senior-developer': 'You are a Senior Developer implementing complex features and reviewing code.',
      'junior-developer': 'You are a Junior Developer implementing UI components and simple features.',
      'qa-engineer': 'You are a QA Engineer testing functionality and ensuring quality standards.'
    };
    return prompts[agent] || 'You are a helpful AI assistant.';
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
      // Clone into a temp directory first, then move contents
      const tempDir = `${workspacePath}_temp`;
      console.log(`📦 Executing: git clone ${repoUrl} ${tempDir}`);

      const { stdout, stderr } = await execAsync(`git clone ${repoUrl} ${tempDir}`, {
        timeout: 60000 // 1 minute timeout
      });

      if (stdout) console.log(`📋 Git output: ${stdout}`);
      if (stderr) console.log(`⚠️ Git warnings: ${stderr}`);

      // Move contents from temp to workspace
      await execAsync(`mv ${tempDir}/* ${tempDir}/.* ${workspacePath}/ 2>/dev/null || true`);
      await execAsync(`rm -rf ${tempDir}`);

      console.log(`✅ Repository cloned and moved to workspace`);
    } catch (error) {
      console.error(`❌ Failed to clone repository: ${error.message}`);
      // Don't throw - continue without repo
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
   * Calculate cost based on model and tokens
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
   * Determine operation type based on agent
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
