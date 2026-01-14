/**
 * Autonomous Tools - Tools for Autonomous Agent Operation
 *
 * These tools enable agents to work autonomously without blocking:
 * - Background task execution (builds, tests, deploys)
 * - Multimodal content processing
 * - Session management
 * - Memory operations
 * - Slash command execution
 *
 * Designed for maximum agent autonomy while maintaining observability.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { BackgroundTaskService } from '../services/BackgroundTaskService';
import { SessionService } from '../services/SessionService';
import { SlashCommandService } from '../services/SlashCommandService';

/**
 * Run Build in Background
 * Non-blocking build execution
 */
export const runBuildBackgroundTool = tool(
  'run_build_background',
  `Run a build process in the background without blocking.
Use this for:
- npm run build / yarn build
- TypeScript compilation
- Webpack/Vite/Rollup bundling
- Any long-running build process

Returns immediately with a task ID. Use check_background_task to monitor progress.`,
  {
    taskId: z.string().describe('Orchestration task ID'),
    cwd: z.string().describe('Working directory'),
    command: z.string().optional().describe('Build command (default: npm run build)'),
  },
  async (args) => {
    try {
      const task = await BackgroundTaskService.runBuild({
        taskId: args.taskId,
        cwd: args.cwd,
        command: args.command,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            backgroundTaskId: task.id,
            status: task.status,
            command: task.command,
            message: 'Build started in background. Use check_background_task to monitor.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Run Tests in Background
 * Non-blocking test execution
 */
export const runTestsBackgroundTool = tool(
  'run_tests_background',
  `Run tests in the background without blocking.
Use this for:
- Unit tests
- Integration tests
- E2E tests
- Any test suite that takes more than a few seconds

Returns immediately with a task ID.`,
  {
    taskId: z.string().describe('Orchestration task ID'),
    cwd: z.string().describe('Working directory'),
    command: z.string().optional().describe('Test command (default: npm test)'),
    pattern: z.string().optional().describe('Test file pattern'),
  },
  async (args) => {
    try {
      const task = await BackgroundTaskService.runTests({
        taskId: args.taskId,
        cwd: args.cwd,
        command: args.command,
        pattern: args.pattern,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            backgroundTaskId: task.id,
            status: task.status,
            command: task.command,
            message: 'Tests started in background. Use check_background_task to monitor.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Check Background Task Status
 */
export const checkBackgroundTaskTool = tool(
  'check_background_task',
  'Check the status of a background task. Returns current status and recent output.',
  {
    backgroundTaskId: z.string().describe('ID returned from run_*_background'),
    outputLines: z.number().optional().describe('Number of recent output lines to return'),
  },
  async (args) => {
    try {
      const task = BackgroundTaskService.getStatus(args.backgroundTaskId);

      if (!task) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Task ${args.backgroundTaskId} not found`,
            }, null, 2),
          }],
        };
      }

      const output = BackgroundTaskService.getOutput(args.backgroundTaskId, args.outputLines || 20);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            taskId: task.id,
            type: task.type,
            status: task.status,
            exitCode: task.exitCode,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            outputLines: output.length,
            recentOutput: output,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Wait for Background Task
 */
export const waitForBackgroundTaskTool = tool(
  'wait_for_background_task',
  'Wait for a background task to complete. Blocks until done or timeout.',
  {
    backgroundTaskId: z.string().describe('ID returned from run_*_background'),
    timeoutMs: z.number().optional().describe('Maximum time to wait in ms (default: 300000 = 5 min)'),
  },
  async (args) => {
    try {
      const task = await BackgroundTaskService.waitFor(
        args.backgroundTaskId,
        args.timeoutMs || 300000
      );

      if (!task) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `Task ${args.backgroundTaskId} not found`,
            }, null, 2),
          }],
        };
      }

      const output = BackgroundTaskService.getOutput(args.backgroundTaskId, 50);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: task.status === 'completed',
            taskId: task.id,
            status: task.status,
            exitCode: task.exitCode,
            error: task.error,
            duration: task.completedAt && task.startedAt
              ? task.completedAt.getTime() - task.startedAt.getTime()
              : undefined,
            recentOutput: output,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Cancel Background Task
 */
export const cancelBackgroundTaskTool = tool(
  'cancel_background_task',
  'Cancel a running background task.',
  {
    backgroundTaskId: z.string().describe('ID of task to cancel'),
  },
  async (args) => {
    try {
      const cancelled = BackgroundTaskService.cancel(args.backgroundTaskId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: cancelled,
            taskId: args.backgroundTaskId,
            message: cancelled ? 'Task cancelled' : 'Task not found or not running',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Execute Slash Command
 * Run predefined commands like /test, /review, /security
 */
export const executeSlashCommandTool = tool(
  'execute_slash_command',
  `Execute a slash command for specialized operations.
Available commands:
- /test [pattern] - Run and analyze tests
- /review [file] - Code review
- /security [scope] - Security audit
- /refactor [file] - Refactoring suggestions
- /docs [target] - Generate documentation
- /architect [component] - Design architecture
- /fix [issue] - Fix a specific issue
- /optimize [target] - Performance optimization

Use /help for full list.`,
  {
    command: z.string().describe('Slash command (e.g., "/test src/*.ts")'),
    taskId: z.string().optional().describe('Task ID for logging'),
  },
  async (args) => {
    try {
      const result = await SlashCommandService.execute(args.command, args.taskId);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: result.success,
            prompt: result.prompt,
            agentType: result.agentType,
            tools: result.tools,
            error: result.error,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * List Available Slash Commands
 */
export const listSlashCommandsTool = tool(
  'list_slash_commands',
  'List all available slash commands and their descriptions.',
  {},
  async () => {
    try {
      const commands = SlashCommandService.list();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            commands: commands.map(c => ({
              name: `/${c.name}`,
              description: c.description,
              usage: c.usage,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Session - Save Context
 * Store conversation context for later resumption
 */
export const saveSessionContextTool = tool(
  'save_session_context',
  `Save the current session context for later resumption.
Use this when:
- Completing a phase and want to preserve learnings
- Before a long-running operation
- To checkpoint progress`,
  {
    sessionId: z.string().describe('Session ID to save to'),
    context: z.record(z.any()).describe('Context data to save'),
  },
  async (args) => {
    try {
      await SessionService.updateContext(args.sessionId, args.context);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            sessionId: args.sessionId,
            message: 'Session context saved',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Session - Get Recent Messages
 * Retrieve conversation history for context
 */
export const getSessionMessagesTool = tool(
  'get_session_messages',
  'Get recent messages from a session for context.',
  {
    sessionId: z.string().describe('Session ID'),
    maxTokens: z.number().optional().describe('Max tokens worth of messages'),
  },
  async (args) => {
    try {
      const messages = await SessionService.getRecentMessages(
        args.sessionId,
        args.maxTokens || 50000
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            sessionId: args.sessionId,
            messageCount: messages.length,
            messages: messages.map(m => ({
              role: m.role,
              contentPreview: m.content.substring(0, 200),
              timestamp: m.timestamp,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Autonomous Decision Logger
 * Log decisions made autonomously for audit trail
 */
export const logAutonomousDecisionTool = tool(
  'log_autonomous_decision',
  `Log an autonomous decision for the audit trail.
Call this whenever you make a significant decision without user input:
- Choosing between approaches
- Skipping a step
- Using a fallback strategy
- Deciding to retry or fail`,
  {
    taskId: z.string().describe('Orchestration task ID'),
    decision: z.string().describe('What was decided'),
    reasoning: z.string().describe('Why this decision was made'),
    alternatives: z.array(z.string()).optional().describe('Other options considered'),
    confidence: z.number().min(0).max(1).optional().describe('Confidence level 0-1'),
  },
  async (args) => {
    try {
      // Log to console for now, would integrate with LogService
      console.log(`\n🤖 [Autonomous Decision] ${args.taskId}`);
      console.log(`   Decision: ${args.decision}`);
      console.log(`   Reasoning: ${args.reasoning}`);
      if (args.alternatives?.length) {
        console.log(`   Alternatives: ${args.alternatives.join(', ')}`);
      }
      if (args.confidence !== undefined) {
        console.log(`   Confidence: ${Math.round(args.confidence * 100)}%`);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            logged: true,
            decision: args.decision,
            message: 'Decision logged for audit trail',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Get All Running Background Tasks
 */
export const getRunningTasksTool = tool(
  'get_running_background_tasks',
  'Get all currently running background tasks.',
  {
    taskId: z.string().optional().describe('Filter by orchestration task ID'),
  },
  async (args) => {
    try {
      let tasks = BackgroundTaskService.getRunningTasks();

      if (args.taskId) {
        tasks = tasks.filter(t => t.taskId === args.taskId);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            count: tasks.length,
            tasks: tasks.map(t => ({
              id: t.id,
              type: t.type,
              status: t.status,
              command: t.command.substring(0, 50),
              startedAt: t.startedAt,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);

/**
 * Get all autonomous tools
 */
export function getAutonomousTools() {
  return [
    runBuildBackgroundTool,
    runTestsBackgroundTool,
    checkBackgroundTaskTool,
    waitForBackgroundTaskTool,
    cancelBackgroundTaskTool,
    executeSlashCommandTool,
    listSlashCommandsTool,
    saveSessionContextTool,
    getSessionMessagesTool,
    logAutonomousDecisionTool,
    getRunningTasksTool,
  ];
}

/**
 * Create MCP server with autonomous tools
 * For integration with OrchestrationCoordinator
 */
export function createAutonomousToolsServer() {
  return createSdkMcpServer({
    name: 'autonomous-tools',
    version: '1.0.0',
    tools: getAutonomousTools(),
  });
}
