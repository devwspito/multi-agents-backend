import path from 'path';
import fs from 'fs';
import os from 'os';
import { LogService } from './logging/LogService';
import { OrchestrationCoordinator } from './orchestration/OrchestrationCoordinator';
import { Task } from '../models/Task';

/**
 * Slash Command Result
 */
export interface ICommandResult {
  success: boolean;
  commandName: string;
  output: string;
  error?: string;
  executionTime: number;
}

/**
 * Available Slash Commands
 */
export type SlashCommand =
  | 'check-quality'
  | 'analyze-security'
  | 'review-pr'
  | 'run-tests'
  | 'estimate-complexity'
  | 'compact';

/**
 * Command Service
 *
 * Executes slash commands from .claude/commands/ directory
 *
 * Slash commands are user-facing commands that trigger specialized agents:
 * - /check-quality: Code quality analysis (linting, formatting, complexity)
 * - /analyze-security: Security vulnerability scan (OWASP, dependencies)
 * - /review-pr: Pull request review (code review, test coverage)
 * - /run-tests: Run test suite and report results
 * - /estimate-complexity: Estimate task complexity and recommend team size
 * - /compact: Compact conversation history to reduce tokens
 */
export class CommandService {
  private static commandsDir = path.join(process.cwd(), '.claude', 'commands');

  /**
   * Execute a slash command
   *
   * @param commandName - Name of the command (without .md extension)
   * @param args - Arguments for the command
   * @param taskId - Task ID for context
   * @returns Command execution result
   */
  static async executeCommand(
    commandName: SlashCommand,
    args: string[] = [],
    taskId?: string
  ): Promise<ICommandResult> {
    const startTime = Date.now();
    const commandPath = path.join(this.commandsDir, `${commandName}.md`);

    // Check if command exists
    if (!fs.existsSync(commandPath)) {
      const error = `Command not found: ${commandPath}`;
      await LogService.warn(error, {
        taskId: taskId as any,
        category: 'orchestration',
        metadata: { commandName, commandPath },
      });

      return {
        success: false,
        commandName,
        output: '',
        error,
        executionTime: 0,
      };
    }

    console.log(`\n⚡ [CommandService] Executing command: /${commandName}`);
    if (args.length > 0) {
      console.log(`   Args: ${args.join(' ')}`);
    }

    try {
      // Read command definition
      const commandContent = fs.readFileSync(commandPath, 'utf-8');

      // Parse frontmatter to get agent type and configuration
      const frontmatterMatch = commandContent.match(/^---\n([\s\S]*?)\n---/);
      let prompt = commandContent;

      if (frontmatterMatch) {
        // Remove frontmatter from prompt
        prompt = commandContent.replace(/^---\n[\s\S]*?\n---\n/, '');
      }

      // Build command prompt with arguments
      let fullPrompt = prompt;
      if (args.length > 0) {
        fullPrompt += `\n\nArguments: ${args.join(' ')}`;
      }

      // Execute command using OrchestrationCoordinator
      let result: any;

      switch (commandName) {
        case 'check-quality':
          result = await this.executeCheckQuality(fullPrompt, taskId);
          break;

        case 'analyze-security':
          result = await this.executeAnalyzeSecurity(fullPrompt, taskId);
          break;

        case 'review-pr':
          result = await this.executeReviewPR(fullPrompt, args, taskId);
          break;

        case 'run-tests':
          result = await this.executeRunTests(fullPrompt, taskId);
          break;

        case 'estimate-complexity':
          result = await this.executeEstimateComplexity(fullPrompt, args, taskId);
          break;

        case 'compact':
          result = await this.executeCompact(fullPrompt, taskId);
          break;

        default:
          throw new Error(`Unknown command: ${commandName}`);
      }

      const executionTime = Date.now() - startTime;

      console.log(`   ✅ Command completed in ${executionTime}ms`);

      await LogService.info(`Command executed: /${commandName}`, {
        taskId: taskId as any,
        category: 'orchestration',
        metadata: {
          commandName,
          executionTime,
          hasArgs: args.length > 0,
        },
      });

      return {
        success: true,
        commandName,
        output: JSON.stringify(result, null, 2),
        executionTime,
      };
    } catch (error: any) {
      const executionTime = Date.now() - startTime;

      console.error(`   ❌ Command failed: ${error.message}`);

      await LogService.error(`Command failed: /${commandName}`, {
        taskId: taskId as any,
        category: 'orchestration',
        error,
        metadata: {
          commandName,
          executionTime,
        },
      });

      return {
        success: false,
        commandName,
        output: '',
        error: error.message,
        executionTime,
      };
    }
  }

  /**
   * Execute /check-quality command
   * Runs code quality analysis (linting, formatting, complexity)
   */
  private static async executeCheckQuality(
    prompt: string,
    taskId?: string
  ): Promise<any> {
    // Use judge agent for quality checks
    const coordinator = new OrchestrationCoordinator();
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

    return await coordinator.executeAgent(
      'judge',
      prompt,
      workspaceDir,
      taskId,
      'judge',
      undefined,
      false,
      [],
      {
        maxIterations: 10,
        timeout: 300000, // 5 minutes
      }
    );
  }

  /**
   * Execute /analyze-security command
   * Scans for security vulnerabilities (OWASP, dependencies)
   */
  private static async executeAnalyzeSecurity(
    prompt: string,
    taskId?: string
  ): Promise<any> {
    const coordinator = new OrchestrationCoordinator();
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

    // Use judge with security-focused prompt
    return await coordinator.executeAgent(
      'judge',
      `${prompt}\n\nFocus on OWASP API Security Top 10 vulnerabilities and dependency security.`,
      workspaceDir,
      taskId,
      'judge',
      undefined,
      false,
      [],
      {
        maxIterations: 15,
        timeout: 600000, // 10 minutes
      }
    );
  }

  /**
   * Execute /review-pr command
   * Reviews a pull request (code review, test coverage)
   */
  private static async executeReviewPR(
    prompt: string,
    args: string[],
    taskId?: string
  ): Promise<any> {
    const prNumber = args[0]; // First arg should be PR number

    if (!prNumber) {
      throw new Error('PR number is required: /review-pr <pr-number>');
    }

    const coordinator = new OrchestrationCoordinator();
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

    // Use judge agent for PR review
    return await coordinator.executeAgent(
      'judge',
      `${prompt}\n\nReview Pull Request #${prNumber}`,
      workspaceDir,
      taskId,
      'judge',
      undefined,
      false,
      [],
      {
        maxIterations: 20,
        timeout: 600000, // 10 minutes
      }
    );
  }

  /**
   * Execute /run-tests command
   * Runs test suite and reports results
   */
  private static async executeRunTests(
    prompt: string,
    taskId?: string
  ): Promise<any> {
    const coordinator = new OrchestrationCoordinator();
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

    // Use developer to run tests
    return await coordinator.executeAgent(
      'developer',
      `${prompt}\n\nRun the complete test suite and report results.`,
      workspaceDir,
      taskId,
      'developer',
      undefined,
      false,
      [],
      {
        maxIterations: 10,
        timeout: 600000, // 10 minutes
      }
    );
  }

  /**
   * Execute /estimate-complexity command
   * Estimates task complexity and recommends team size
   */
  private static async executeEstimateComplexity(
    prompt: string,
    args: string[],
    taskId?: string
  ): Promise<any> {
    const taskDescription = args.join(' ');

    if (!taskDescription) {
      throw new Error('Task description is required: /estimate-complexity <description>');
    }

    const coordinator = new OrchestrationCoordinator();
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');

    // Use tech-lead for complexity estimation
    return await coordinator.executeAgent(
      'tech-lead',
      `${prompt}\n\nTask: ${taskDescription}`,
      workspaceDir,
      taskId,
      'tech-lead',
      undefined,
      false,
      [],
      {
        maxIterations: 10,
        timeout: 300000, // 5 minutes
      }
    );
  }

  /**
   * Execute /compact command
   * Compacts conversation history to reduce token usage
   */
  private static async executeCompact(
    _prompt: string,
    taskId?: string
  ): Promise<any> {
    // This is a special command that doesn't use an agent
    // It directly manipulates the task's conversation history

    if (!taskId) {
      throw new Error('Task ID is required for /compact command');
    }

    const task = await Task.findById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // TODO: Implement conversation compaction logic
    // For now, just return a placeholder
    return {
      success: true,
      message: 'Conversation compaction not yet implemented',
      originalSize: 0,
      compactedSize: 0,
    };
  }

  /**
   * Check if a command exists
   */
  static commandExists(commandName: SlashCommand): boolean {
    const commandPath = path.join(this.commandsDir, `${commandName}.md`);
    return fs.existsSync(commandPath);
  }

  /**
   * Get all available commands
   */
  static getAvailableCommands(): SlashCommand[] {
    if (!fs.existsSync(this.commandsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.commandsDir);
    return files
      .filter((file) => file.endsWith('.md'))
      .map((file) => file.replace('.md', '') as SlashCommand);
  }

  /**
   * Get command help text
   */
  static getCommandHelp(commandName: SlashCommand): string | null {
    const commandPath = path.join(this.commandsDir, `${commandName}.md`);

    if (!fs.existsSync(commandPath)) {
      return null;
    }

    return fs.readFileSync(commandPath, 'utf-8');
  }
}
