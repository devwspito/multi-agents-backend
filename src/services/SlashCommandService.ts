/**
 * SlashCommandService - Claude Code Style Slash Commands
 *
 * Implements custom commands that can be invoked with /command syntax:
 * - /architect - Design system architecture
 * - /test - Run and analyze tests
 * - /review - Code review mode
 * - /security - Security audit
 * - /refactor - Refactoring suggestions
 * - /docs - Generate documentation
 *
 * Commands are defined as Markdown files in .claude/commands/
 * or registered programmatically.
 *
 * Reference: https://docs.claude.com/en/agent-sdk/slash-commands
 */

import path from 'path';
import fs from 'fs';
import { LogService } from './logging/LogService';

/**
 * Slash command definition
 */
export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  prompt: string; // The actual prompt to inject
  agentType?: string; // Specific agent to use
  tools?: string[]; // Tools to enable for this command
  flags?: Record<string, {
    type: 'string' | 'boolean' | 'number';
    description: string;
    default?: any;
  }>;
}

/**
 * Parsed command invocation
 */
export interface ParsedCommand {
  name: string;
  args: string[];
  flags: Record<string, any>;
  rawInput: string;
}

/**
 * Command execution result
 */
export interface CommandResult {
  success: boolean;
  prompt?: string;
  agentType?: string;
  tools?: string[];
  error?: string;
}

class SlashCommandServiceClass {
  private commands: Map<string, SlashCommand> = new Map();
  private commandsDir = path.join(process.cwd(), '.claude', 'commands');

  constructor() {
    this.registerBuiltInCommands();
    this.loadCustomCommands();
  }

  /**
   * Register built-in slash commands
   */
  private registerBuiltInCommands(): void {
    // /architect - System design
    this.register({
      name: 'architect',
      description: 'Design or analyze system architecture',
      usage: '/architect [component or feature]',
      examples: [
        '/architect authentication system',
        '/architect database schema for users',
      ],
      prompt: `You are a senior software architect. Analyze or design the architecture for: {args}

Consider:
1. Component structure and boundaries
2. Data flow between components
3. API contracts
4. Database schema if applicable
5. Scalability considerations
6. Security implications

Provide:
- High-level architecture diagram (as ASCII or description)
- Component responsibilities
- Interface definitions
- Trade-offs and alternatives considered`,
      agentType: 'tech-lead',
      tools: ['Read', 'Grep', 'Glob', 'WebSearch'],
    });

    // /test - Testing focus
    this.register({
      name: 'test',
      description: 'Run tests and analyze results',
      usage: '/test [file or pattern]',
      examples: [
        '/test',
        '/test src/services/*.test.ts',
      ],
      prompt: `Run and analyze tests. Focus: {args}

Steps:
1. Run the test command: npm test or appropriate for the project
2. Analyze failures in detail
3. Suggest fixes for failing tests
4. Check test coverage if available
5. Identify untested code paths

If no specific file given, run all tests.`,
      tools: ['Bash', 'Read', 'Grep', 'Glob'],
    });

    // /review - Code review
    this.register({
      name: 'review',
      description: 'Perform code review on files or changes',
      usage: '/review [file or git diff]',
      examples: [
        '/review src/services/AuthService.ts',
        '/review git diff HEAD~3',
      ],
      prompt: `Perform a thorough code review. Target: {args}

Review checklist:
1. **Security**: SQL injection, XSS, auth issues
2. **Performance**: N+1 queries, memory leaks, unnecessary iterations
3. **Maintainability**: Code clarity, naming, DRY violations
4. **Error handling**: Missing catches, unclear error messages
5. **Testing**: Is code testable? Missing edge cases?
6. **Types**: TypeScript strictness, any usage
7. **Documentation**: Missing JSDoc, unclear comments

Rate each category: 🟢 Good | 🟡 Minor issues | 🔴 Needs attention

End with prioritized action items.`,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    });

    // /security - Security audit
    this.register({
      name: 'security',
      description: 'Perform security audit',
      usage: '/security [scope]',
      examples: [
        '/security',
        '/security authentication flow',
      ],
      prompt: `Perform a comprehensive security audit. Scope: {args}

Check for:
1. **OWASP Top 10**
   - Injection flaws (SQL, NoSQL, Command, LDAP)
   - Broken authentication
   - Sensitive data exposure
   - XXE (XML External Entities)
   - Broken access control
   - Security misconfiguration
   - XSS (Cross-Site Scripting)
   - Insecure deserialization
   - Components with known vulnerabilities
   - Insufficient logging

2. **Secrets Management**
   - Hardcoded credentials
   - API keys in code
   - Insecure .env handling

3. **Dependencies**
   - Run: npm audit
   - Check for outdated packages

4. **Authentication & Authorization**
   - Token handling
   - Session management
   - Permission checks

Provide severity ratings: 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low`,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch'],
    });

    // /refactor - Refactoring suggestions
    this.register({
      name: 'refactor',
      description: 'Suggest refactoring improvements',
      usage: '/refactor [file or component]',
      examples: [
        '/refactor src/services/LegacyService.ts',
        '/refactor components/Dashboard',
      ],
      prompt: `Analyze and suggest refactoring for: {args}

Look for:
1. **Code smells**
   - Long methods (> 50 lines)
   - Deep nesting (> 3 levels)
   - Large files (> 300 lines)
   - God classes
   - Feature envy

2. **Design patterns**
   - Missing abstractions
   - Applicable patterns (Factory, Strategy, etc.)
   - Over-engineering

3. **Modernization**
   - Outdated syntax
   - Modern JS/TS features not used
   - Async/await instead of callbacks

4. **DRY violations**
   - Duplicated code
   - Similar logic that could be abstracted

Provide specific, actionable refactoring steps with code examples.`,
      tools: ['Read', 'Grep', 'Glob'],
    });

    // /docs - Documentation
    this.register({
      name: 'docs',
      description: 'Generate or update documentation',
      usage: '/docs [target]',
      examples: [
        '/docs src/services/PaymentService.ts',
        '/docs api endpoints',
      ],
      prompt: `Generate documentation for: {args}

Include:
1. **Overview**: What does this code do?
2. **API Reference**: Functions, methods, parameters
3. **Usage Examples**: How to use this code
4. **Dependencies**: What this depends on
5. **Side Effects**: What changes does this make?

Format as JSDoc comments for code, or Markdown for APIs.

Do NOT create separate .md files unless explicitly asked.`,
      tools: ['Read', 'Grep', 'Glob'],
    });

    // /explain - Code explanation
    this.register({
      name: 'explain',
      description: 'Explain code in detail',
      usage: '/explain [file or function]',
      examples: [
        '/explain src/utils/cryptoHelper.ts',
        '/explain the authentication flow',
      ],
      prompt: `Explain in detail: {args}

Provide:
1. **Purpose**: What problem does this solve?
2. **How it works**: Step-by-step explanation
3. **Key concepts**: Important patterns or algorithms used
4. **Dependencies**: What this relies on
5. **Gotchas**: Non-obvious behavior or edge cases

Use clear, beginner-friendly language.`,
      tools: ['Read', 'Grep', 'Glob'],
    });

    // /fix - Bug fixing mode
    this.register({
      name: 'fix',
      description: 'Focus on fixing a specific issue',
      usage: '/fix [description or error]',
      examples: [
        '/fix TypeError in handleSubmit',
        '/fix tests failing in AuthService',
      ],
      prompt: `Fix the following issue: {args}

Process:
1. **Understand**: What is the expected vs actual behavior?
2. **Locate**: Find the source of the problem
3. **Analyze**: Why is this happening?
4. **Fix**: Implement the fix
5. **Verify**: Run tests or verify the fix works
6. **Prevent**: Add guards to prevent recurrence

Show your debugging process and explain the fix.`,
      tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
    });

    // /optimize - Performance optimization
    this.register({
      name: 'optimize',
      description: 'Optimize code for performance',
      usage: '/optimize [file or function]',
      examples: [
        '/optimize src/services/DataService.ts',
        '/optimize database queries',
      ],
      prompt: `Optimize for performance: {args}

Analyze:
1. **Time complexity**: Big-O analysis
2. **Space complexity**: Memory usage
3. **Database**: N+1 queries, missing indexes
4. **Caching**: Opportunities for memoization
5. **Async**: Parallelization opportunities
6. **Bundle size**: For frontend code

Benchmark before and after if possible.
Prioritize: biggest impact with least risk.`,
      tools: ['Read', 'Grep', 'Glob', 'Bash'],
    });
  }

  /**
   * Load custom commands from .claude/commands/ directory
   */
  private loadCustomCommands(): void {
    if (!fs.existsSync(this.commandsDir)) {
      return;
    }

    const files = fs.readdirSync(this.commandsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      try {
        const filePath = path.join(this.commandsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const command = this.parseCommandFile(file.replace('.md', ''), content);
        if (command) {
          this.commands.set(command.name, command);
          console.log(`📝 Loaded custom command: /${command.name}`);
        }
      } catch (error: any) {
        console.error(`Failed to load command from ${file}:`, error.message);
      }
    }
  }

  /**
   * Parse a command markdown file
   */
  private parseCommandFile(name: string, content: string): SlashCommand | null {
    // Extract frontmatter if present
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
    let description = `Custom command: ${name}`;
    let agentType: string | undefined;
    let tools: string[] | undefined;

    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (descMatch) description = descMatch[1].trim();

      const agentMatch = frontmatter.match(/agent:\s*(.+)/);
      if (agentMatch) agentType = agentMatch[1].trim();

      const toolsMatch = frontmatter.match(/tools:\s*\[([^\]]+)\]/);
      if (toolsMatch) tools = toolsMatch[1].split(',').map(t => t.trim());

      content = content.replace(frontmatterMatch[0], '');
    }

    return {
      name,
      description,
      usage: `/${name} [args]`,
      examples: [],
      prompt: content.trim(),
      agentType,
      tools,
    };
  }

  /**
   * Register a command
   */
  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  /**
   * Get a command
   */
  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  /**
   * List all commands
   */
  list(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  /**
   * Parse a command string
   */
  parse(input: string): ParsedCommand | null {
    if (!input.startsWith('/')) {
      return null;
    }

    const parts = input.slice(1).split(/\s+/);
    const name = parts[0].toLowerCase();

    const command = this.commands.get(name);
    if (!command) {
      return null;
    }

    const args: string[] = [];
    const flags: Record<string, any> = {};

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.startsWith('--')) {
        const [flag, value] = part.slice(2).split('=');
        flags[flag] = value ?? true;
      } else if (part.startsWith('-')) {
        flags[part.slice(1)] = true;
      } else {
        args.push(part);
      }
    }

    return {
      name,
      args,
      flags,
      rawInput: input,
    };
  }

  /**
   * Execute a command
   */
  async execute(input: string, taskId?: string): Promise<CommandResult> {
    const parsed = this.parse(input);
    if (!parsed) {
      return {
        success: false,
        error: `Unknown command. Available: ${this.list().map(c => '/' + c.name).join(', ')}`,
      };
    }

    const command = this.commands.get(parsed.name)!;

    // Replace {args} in prompt with actual arguments
    const argsString = parsed.args.join(' ') || '(no specific target - analyze whole project)';
    const prompt = command.prompt.replace('{args}', argsString);

    if (taskId) {
      await LogService.info(`Slash command executed: /${parsed.name}`, {
        taskId,
        category: 'system',
        metadata: {
          command: parsed.name,
          args: parsed.args,
          flags: parsed.flags,
        },
      });
    }

    return {
      success: true,
      prompt,
      agentType: command.agentType,
      tools: command.tools,
    };
  }

  /**
   * Check if input is a slash command
   */
  isCommand(input: string): boolean {
    if (!input.startsWith('/')) return false;
    const name = input.slice(1).split(/\s+/)[0].toLowerCase();
    return this.commands.has(name);
  }

  /**
   * Get command help
   */
  getHelp(commandName?: string): string {
    if (commandName) {
      const cmd = this.commands.get(commandName);
      if (!cmd) return `Unknown command: /${commandName}`;

      return [
        `**/${cmd.name}** - ${cmd.description}`,
        '',
        `Usage: ${cmd.usage}`,
        '',
        'Examples:',
        ...cmd.examples.map(e => `  ${e}`),
      ].join('\n');
    }

    // List all commands
    const lines = ['**Available Slash Commands:**', ''];
    for (const cmd of this.commands.values()) {
      lines.push(`  /${cmd.name} - ${cmd.description}`);
    }
    lines.push('', 'Use /help [command] for details');

    return lines.join('\n');
  }

  /**
   * Reload custom commands
   */
  reloadCustomCommands(): void {
    // Clear custom commands (keep built-in)
    const builtIn = new Set([
      'architect', 'test', 'review', 'security',
      'refactor', 'docs', 'explain', 'fix', 'optimize',
    ]);

    for (const name of this.commands.keys()) {
      if (!builtIn.has(name)) {
        this.commands.delete(name);
      }
    }

    this.loadCustomCommands();
  }
}

// Singleton instance
export const SlashCommandService = new SlashCommandServiceClass();
