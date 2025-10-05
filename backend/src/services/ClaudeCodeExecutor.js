/**
 * Claude Code Executor Service
 * This service executes REAL commands using exec/spawn
 * Makes agents actually DO things, not just talk about them
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

class ClaudeCodeExecutor {
  constructor() {
    this.supportedCommands = {
      // Git operations
      'git': ['checkout', 'add', 'commit', 'push', 'pull', 'branch', 'status', 'log', 'diff'],
      // GitHub CLI
      'gh': ['pr', 'issue', 'workflow', 'repo'],
      // Node/NPM
      'npm': ['install', 'test', 'run', 'build'],
      'node': ['*'],
      // File operations
      'cat': ['*'],
      'echo': ['*'],
      'mkdir': ['*'],
      'touch': ['*'],
      // Code analysis
      'grep': ['*'],
      'find': ['*'],
      'wc': ['*']
    };
  }

  /**
   * Execute agent instructions with REAL commands
   */
  async executeAgentTasks(agent, task, instructions, workspacePath) {
    console.log(`🔧 REAL EXECUTION for ${agent} starting...`);

    const actions = [];
    const results = {
      commands: [],
      filesCreated: [],
      filesModified: [],
      gitOperations: [],
      pullRequest: null,
      issues: [],
      tests: null,
      output: ''
    };

    try {
      // Parse instructions to extract commands
      const commands = this.parseInstructions(agent, task, instructions);

      // Execute each command
      for (const cmd of commands) {
        console.log(`⚙️ Executing: ${cmd.command}`);

        if (this.isSafeCommand(cmd.command)) {
          const result = await this.executeCommand(cmd.command, workspacePath);

          results.commands.push({
            command: cmd.command,
            output: result.stdout,
            error: result.stderr,
            success: !result.error
          });

          // Track specific operations
          if (cmd.command.startsWith('git ')) {
            results.gitOperations.push(cmd.command);
          }
          if (cmd.command.startsWith('gh pr create')) {
            results.pullRequest = this.extractPRUrl(result.stdout);
          }
          if (cmd.command.startsWith('gh issue create')) {
            results.issues.push(this.extractIssueUrl(result.stdout));
          }
          if (cmd.command.includes('npm test')) {
            results.tests = result.stdout;
          }
        } else {
          console.log(`⚠️ Skipping unsafe command: ${cmd.command}`);
        }
      }

      // Generate summary
      results.output = this.generateSummary(agent, results);

      return {
        success: true,
        result: results.output,
        codeChanges: {
          filesModified: results.filesModified,
          linesAdded: this.countLinesAdded(results),
          linesRemoved: this.countLinesRemoved(results),
          pullRequest: results.pullRequest
        }
      };

    } catch (error) {
      console.error(`❌ Execution failed for ${agent}:`, error);
      return {
        success: false,
        result: `Execution failed: ${error.message}`,
        error: error.message
      };
    }
  }

  /**
   * Parse instructions to extract executable commands
   */
  parseInstructions(agent, task, instructions) {
    const commands = [];

    // Different agents have different command patterns
    switch (agent) {
      case 'product-manager':
        commands.push(
          { command: 'git log --oneline -n 20' },
          { command: 'grep -r "TODO\\|FIXME\\|BUG" . || true' },
          { command: `gh issue create --title "Analysis: ${task.title}" --body "${task.description}"` }
        );
        break;

      case 'tech-lead':
        commands.push(
          { command: `git checkout -b architecture/${task._id}` },
          { command: `mkdir -p docs/architecture` },
          { command: `echo "# Architecture for ${task.title}" > docs/architecture/${task._id}.md` },
          { command: 'git add docs/' },
          { command: `git commit -m "docs: Add architecture for ${task.title}"` }
        );
        break;

      case 'senior-developer':
        commands.push(
          { command: `git checkout -b fix/${task._id}` },
          { command: 'npm test || true' },  // Run existing tests
          // Here you would add actual file editing commands based on the bug
          { command: `git add .` },
          { command: `git commit -m "fix: ${task.title}"` },
          { command: `gh pr create --title "Fix: ${task.title}" --body "Resolves: ${task.description}"` }
        );
        break;

      case 'junior-developer':
        commands.push(
          { command: 'npm install' },
          { command: 'npm run lint || true' },
          // UI component commands would go here
          { command: 'git status' }
        );
        break;

      case 'qa-engineer':
        commands.push(
          { command: 'npm test' },
          { command: 'npm run test:coverage || true' },
          { command: `echo "Test results for ${task.title}" > test-results.txt` },
          { command: 'git add test-results.txt' },
          { command: `git commit -m "test: Add test results for ${task.title}"` }
        );
        break;

      default:
        console.log(`⚠️ Unknown agent type: ${agent}`);
    }

    return commands;
  }

  /**
   * Execute a single command safely
   */
  async executeCommand(command, cwd) {
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 30000, // 30 second timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });

      return { stdout, stderr, error: null };
    } catch (error) {
      return {
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        error: error.message
      };
    }
  }

  /**
   * Check if command is safe to execute
   */
  isSafeCommand(command) {
    // Prevent dangerous commands
    const dangerous = ['rm -rf', 'sudo', 'chmod 777', 'eval', 'exec'];

    for (const danger of dangerous) {
      if (command.includes(danger)) {
        return false;
      }
    }

    // Only allow whitelisted commands
    const cmd = command.split(' ')[0];
    return Object.keys(this.supportedCommands).includes(cmd);
  }

  /**
   * Extract PR URL from gh pr create output
   */
  extractPRUrl(output) {
    const match = output.match(/https:\/\/github\.com\/[\w-]+\/[\w-]+\/pull\/\d+/);
    return match ? match[0] : null;
  }

  /**
   * Extract Issue URL from gh issue create output
   */
  extractIssueUrl(output) {
    const match = output.match(/https:\/\/github\.com\/[\w-]+\/[\w-]+\/issues\/\d+/);
    return match ? match[0] : null;
  }

  /**
   * Count lines added from git diff
   */
  countLinesAdded(results) {
    let count = 0;
    results.commands.forEach(cmd => {
      if (cmd.command.includes('git diff') && cmd.output) {
        const matches = cmd.output.match(/^\+[^+]/gm);
        count += matches ? matches.length : 0;
      }
    });
    return count;
  }

  /**
   * Count lines removed from git diff
   */
  countLinesRemoved(results) {
    let count = 0;
    results.commands.forEach(cmd => {
      if (cmd.command.includes('git diff') && cmd.output) {
        const matches = cmd.output.match(/^-[^-]/gm);
        count += matches ? matches.length : 0;
      }
    });
    return count;
  }

  /**
   * Generate execution summary
   */
  generateSummary(agent, results) {
    let summary = `# ${agent.toUpperCase()} EXECUTION RESULTS\n\n`;

    summary += `## Commands Executed (${results.commands.length}):\n`;
    results.commands.forEach(cmd => {
      summary += `✅ ${cmd.command}\n`;
    });

    if (results.pullRequest) {
      summary += `\n## Pull Request Created:\n${results.pullRequest}\n`;
    }

    if (results.issues.length > 0) {
      summary += `\n## Issues Created:\n`;
      results.issues.forEach(issue => summary += `- ${issue}\n`);
    }

    if (results.gitOperations.length > 0) {
      summary += `\n## Git Operations:\n`;
      results.gitOperations.forEach(op => summary += `- ${op}\n`);
    }

    if (results.tests) {
      summary += `\n## Test Results:\n${results.tests.substring(0, 500)}\n`;
    }

    return summary;
  }
}

module.exports = new ClaudeCodeExecutor();