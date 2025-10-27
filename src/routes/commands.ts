import express, { Request, Response } from 'express';
import { CommandService, SlashCommand } from '../services/CommandService';
import { authenticate } from '../middleware/auth';
import { z } from 'zod';

const router = express.Router();

/**
 * Execute Slash Command Schema
 */
const executeCommandSchema = z.object({
  command: z.enum([
    'check-quality',
    'analyze-security',
    'review-pr',
    'run-tests',
    'estimate-complexity',
    'compact',
  ]),
  args: z.array(z.string()).optional().default([]),
  taskId: z.string().optional(),
});

/**
 * POST /api/commands/execute
 * Execute a slash command
 *
 * Body:
 * {
 *   "command": "check-quality" | "analyze-security" | "review-pr" | "run-tests" | "estimate-complexity" | "compact",
 *   "args": ["arg1", "arg2"],
 *   "taskId": "optional-task-id"
 * }
 */
router.post('/execute', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const body = executeCommandSchema.parse(req.body);

    console.log(`\n⚡ [CommandRoute] Executing command: /${body.command}`);
    console.log(`   Args: ${body.args.join(' ')}`);

    const result = await CommandService.executeCommand(
      body.command as SlashCommand,
      body.args,
      body.taskId
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error || 'Command execution failed',
        commandName: result.commandName,
        executionTime: result.executionTime,
      });
    }

    return res.json({
      success: true,
      commandName: result.commandName,
      output: result.output,
      executionTime: result.executionTime,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error executing command:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

/**
 * GET /api/commands/available
 * Get list of available slash commands
 */
router.get('/available', authenticate, async (_req: Request, res: Response): Promise<void> => {
  try {
    const availableCommands = CommandService.getAvailableCommands();

    const commandsWithHelp = availableCommands.map((commandName) => ({
      name: commandName,
      help: CommandService.getCommandHelp(commandName),
      exists: CommandService.commandExists(commandName),
    }));

    return res.json({
      success: true,
      commands: commandsWithHelp,
      count: availableCommands.length,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error getting available commands:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

/**
 * GET /api/commands/:commandName/help
 * Get help text for a specific command
 */
router.get('/:commandName/help', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const commandName = req.params.commandName as SlashCommand;

    const helpText = CommandService.getCommandHelp(commandName);

    if (!helpText) {
      return res.status(404).json({
        success: false,
        error: `Command not found: /${commandName}`,
      });
    }

    return res.json({
      success: true,
      commandName,
      help: helpText,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error getting command help:`, error);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
    });
  }
});

/**
 * POST /api/commands/check-quality
 * Shortcut for /check-quality command
 */
router.post('/check-quality', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.body;

    const result = await CommandService.executeCommand('check-quality', [], taskId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        executionTime: result.executionTime,
      });
    }

    return res.json({
      success: true,
      output: result.output,
      executionTime: result.executionTime,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error executing /check-quality:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/commands/analyze-security
 * Shortcut for /analyze-security command
 */
router.post('/analyze-security', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.body;

    const result = await CommandService.executeCommand('analyze-security', [], taskId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        executionTime: result.executionTime,
      });
    }

    return res.json({
      success: true,
      output: result.output,
      executionTime: result.executionTime,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error executing /analyze-security:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/commands/review-pr
 * Shortcut for /review-pr command
 */
router.post('/review-pr', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { prNumber, taskId } = req.body;

    if (!prNumber) {
      return res.status(400).json({
        success: false,
        error: 'PR number is required',
      });
    }

    const result = await CommandService.executeCommand(
      'review-pr',
      [prNumber.toString()],
      taskId
    );

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        executionTime: result.executionTime,
      });
    }

    return res.json({
      success: true,
      output: result.output,
      executionTime: result.executionTime,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error executing /review-pr:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/commands/run-tests
 * Shortcut for /run-tests command
 */
router.post('/run-tests', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { taskId } = req.body;

    const result = await CommandService.executeCommand('run-tests', [], taskId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        executionTime: result.executionTime,
      });
    }

    return res.json({
      success: true,
      output: result.output,
      executionTime: result.executionTime,
    });
  } catch (error: any) {
    console.error(`[CommandRoute] Error executing /run-tests:`, error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
