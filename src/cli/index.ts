#!/usr/bin/env node
/**
 * Multi-Agent CLI
 *
 * Command-line interface for the multi-agent orchestration system.
 * Provides interactive and batch modes for autonomous development.
 *
 * Usage:
 *   agents run <taskId>          - Run orchestration for a task
 *   agents create <description>  - Create a new task and run it
 *   agents status <taskId>       - Check task status
 *   agents cancel <taskId>       - Cancel running task
 *   agents list                  - List recent tasks
 *   agents interactive           - Start interactive mode
 */

import { OrchestrationCoordinator } from '../services/orchestration/OrchestrationCoordinator';
import { Task } from '../models/Task';
import { Repository } from '../models/Repository';
import { connectDatabase } from '../config/database';
import readline from 'readline';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function banner(): void {
  console.log(`
${colors.cyan}╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ${colors.bright}🤖 Multi-Agent Orchestration System${colors.reset}${colors.cyan}                        ║
║   ${colors.dim}Autonomous Software Development${colors.reset}${colors.cyan}                            ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝${colors.reset}
`);
}

async function ensureDBConnection(): Promise<void> {
  try {
    await connectDatabase();
  } catch (error) {
    log('❌ Failed to connect to database. Make sure MongoDB is running.', 'red');
    process.exit(1);
  }
}

// Shared orchestration coordinator instance
const orchestrationCoordinator = new OrchestrationCoordinator();

async function runTask(taskId: string): Promise<void> {
  await ensureDBConnection();

  const task = await Task.findById(taskId);
  if (!task) {
    log(`❌ Task ${taskId} not found`, 'red');
    return;
  }

  log(`\n🚀 Starting orchestration for task: ${task.title}`, 'cyan');
  log(`   ID: ${taskId}`, 'dim');
  log(`   Description: ${task.description || 'N/A'}`, 'dim');

  try {
    // v1 OrchestrationCoordinator - battle-tested with full intelligent prompts
    await orchestrationCoordinator.orchestrateTask(taskId);
    log(`\n🎉 Orchestration completed!`, 'green');
  } catch (error: any) {
    log(`\n❌ Error: ${error.message}`, 'red');
  }
}

async function createAndRunTask(
  description: string,
  options: { projectId?: string; repositoryIds?: string[] }
): Promise<void> {
  await ensureDBConnection();

  // Find default project and repositories if not specified
  let repositoryIds = options.repositoryIds;
  if (!repositoryIds || repositoryIds.length === 0) {
    const repos = await Repository.find({ isActive: true }).limit(5);
    if (repos.length === 0) {
      log('❌ No repositories found. Please add a repository first.', 'red');
      return;
    }
    repositoryIds = repos.map(r => (r._id as any).toString());
    log(`📦 Using repositories: ${repos.map(r => r.name).join(', ')}`, 'dim');
  }

  // Create task
  const task = new Task({
    title: description.slice(0, 100),
    description,
    status: 'pending',
    repositoryIds,
    orchestration: {
      status: 'pending',
      currentPhase: null,
    },
  });

  await task.save();
  log(`\n✅ Task created: ${task._id}`, 'green');

  // Run it
  await runTask((task._id as any).toString());
}

async function getTaskStatus(taskId: string): Promise<void> {
  await ensureDBConnection();

  const task = await Task.findById(taskId);
  if (!task) {
    log(`❌ Task ${taskId} not found`, 'red');
    return;
  }

  log(`\n📋 Task: ${task.title}`, 'cyan');
  log(`   Status: ${task.status}`, task.status === 'completed' ? 'green' : 'yellow');
  log(`   Phase: ${task.orchestration.currentPhase || 'N/A'}`, 'dim');
  log(`   Cost: $${(task.orchestration.totalCost || 0).toFixed(4)}`, 'dim');
  log(`   Tokens: ${task.orchestration.totalTokens || 0}`, 'dim');
}

async function cancelTask(taskId: string): Promise<void> {
  await ensureDBConnection();

  const task = await Task.findByIdAndUpdate(
    taskId,
    { 'orchestration.cancelRequested': true },
    { new: true }
  );

  if (!task) {
    log(`❌ Task ${taskId} not found`, 'red');
    return;
  }

  log(`\n🛑 Cancellation requested for task: ${task.title}`, 'yellow');
}

async function listTasks(): Promise<void> {
  await ensureDBConnection();

  const tasks = await Task.find()
    .sort({ createdAt: -1 })
    .limit(10);

  if (tasks.length === 0) {
    log('\n📭 No tasks found', 'dim');
    return;
  }

  log('\n📋 Recent Tasks:', 'cyan');
  log('─'.repeat(80), 'dim');

  for (const task of tasks) {
    const statusColor = task.status === 'completed' ? 'green' : task.status === 'failed' ? 'red' : 'yellow';
    const statusIcon = task.status === 'completed' ? '✅' : task.status === 'failed' ? '❌' : '⏳';

    log(`${statusIcon} ${task._id}`, statusColor);
    log(`   ${task.title}`, 'bright');
    log(`   Status: ${task.status} | Cost: $${(task.orchestration.totalCost || 0).toFixed(4)} | Phase: ${task.orchestration.currentPhase || 'N/A'}`, 'dim');
    log('', 'reset');
  }
}

async function interactiveMode(): Promise<void> {
  await ensureDBConnection();

  banner();
  log('Type your request and press Enter. Type "exit" to quit.\n', 'dim');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question(`${colors.cyan}> ${colors.reset}`, async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        log('\n👋 Goodbye!', 'cyan');
        rl.close();
        process.exit(0);
        return;
      }

      if (trimmed.startsWith('/')) {
        // Handle slash commands
        await handleSlashCommand(trimmed);
      } else {
        // Treat as task description
        log('\n🤔 Creating and running task...', 'dim');
        await createAndRunTask(trimmed, {});
      }

      prompt();
    });
  };

  prompt();
}

async function handleSlashCommand(command: string): Promise<void> {
  const parts = command.slice(1).split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case 'status':
      if (args[0]) {
        await getTaskStatus(args[0]);
      } else {
        log('Usage: /status <taskId>', 'yellow');
      }
      break;

    case 'cancel':
      if (args[0]) {
        await cancelTask(args[0]);
      } else {
        log('Usage: /cancel <taskId>', 'yellow');
      }
      break;

    case 'list':
      await listTasks();
      break;

    case 'help':
      showInteractiveHelp();
      break;

    default:
      log(`Unknown command: ${cmd}. Type /help for available commands.`, 'yellow');
  }
}

function showInteractiveHelp(): void {
  log(`
${colors.cyan}Available Commands:${colors.reset}
  /status <taskId>  - Check task status
  /cancel <taskId>  - Cancel a running task
  /list             - List recent tasks
  /help             - Show this help
  exit              - Exit interactive mode

${colors.cyan}To create a new task:${colors.reset}
  Just type your request and press Enter.
  Example: "Add user authentication with JWT"
`, 'reset');
}

function showHelp(): void {
  console.log(`
${colors.cyan}Multi-Agent CLI${colors.reset}

${colors.bright}Usage:${colors.reset}
  agents <command> [options]

${colors.bright}Commands:${colors.reset}
  run <taskId>              Run orchestration for an existing task
  create <description>      Create a new task and run it
  status <taskId>           Check task status
  cancel <taskId>           Cancel a running task
  list                      List recent tasks
  interactive               Start interactive mode

${colors.bright}Options:${colors.reset}
  --help, -h                Show this help
  --version, -v             Show version

${colors.bright}Examples:${colors.reset}
  agents run 507f1f77bcf86cd799439011
  agents create "Add user authentication"
  agents interactive
`);
}

// Main CLI entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log('Multi-Agent CLI v2.0.0');
    return;
  }

  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case 'run':
      if (!commandArgs[0]) {
        log('❌ Please provide a task ID', 'red');
        return;
      }
      await runTask(commandArgs[0]);
      break;

    case 'create':
      if (!commandArgs[0]) {
        log('❌ Please provide a task description', 'red');
        return;
      }
      await createAndRunTask(commandArgs.join(' '), {});
      break;

    case 'status':
      if (!commandArgs[0]) {
        log('❌ Please provide a task ID', 'red');
        return;
      }
      await getTaskStatus(commandArgs[0]);
      break;

    case 'cancel':
      if (!commandArgs[0]) {
        log('❌ Please provide a task ID', 'red');
        return;
      }
      await cancelTask(commandArgs[0]);
      break;

    case 'list':
      await listTasks();
      break;

    case 'interactive':
    case 'i':
      await interactiveMode();
      break;

    default:
      log(`❌ Unknown command: ${command}`, 'red');
      showHelp();
  }
}

// Run if called directly
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

export { main, runTask, createAndRunTask, getTaskStatus, cancelTask, listTasks };
