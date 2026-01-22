/**
 * Package Tools - Package management, deployment, and knowledge tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const packageManagerTool = tool(
  'package_manager',
  `Execute package manager commands safely.
ALWAYS use this instead of manually editing package.json, requirements.txt, etc.

Rationale: Package managers automatically resolve versions, handle conflicts,
update lock files, and maintain consistency. Manual editing leads to version
mismatches and broken builds.

Supported package managers:
- npm/yarn/pnpm (JavaScript/Node.js)
- pip/poetry/conda (Python)
- cargo (Rust)
- go mod (Go)
- gem/bundler (Ruby)
- composer (PHP)
- dotnet (C#/.NET)`,
  {
    action: z.enum(['install', 'uninstall', 'update', 'list', 'audit']).describe('Package manager action'),
    packages: z.array(z.string()).optional().describe('Package names to install/uninstall'),
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry', 'cargo', 'go', 'gem', 'composer', 'dotnet']).describe('Which package manager to use'),
    workingDir: z.string().describe('Working directory with package manifest'),
    dev: z.boolean().optional().describe('Install as dev dependency'),
    global: z.boolean().optional().describe('Install globally'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let command = '';
      const packages = args.packages?.join(' ') || '';

      switch (args.packageManager) {
        case 'npm':
          switch (args.action) {
            case 'install': command = `npm install ${args.dev ? '--save-dev' : ''} ${args.global ? '-g' : ''} ${packages}`.trim(); break;
            case 'uninstall': command = `npm uninstall ${packages}`; break;
            case 'update': command = packages ? `npm update ${packages}` : 'npm update'; break;
            case 'list': command = 'npm list --depth=0'; break;
            case 'audit': command = 'npm audit'; break;
          }
          break;
        case 'yarn':
          switch (args.action) {
            case 'install': command = `yarn add ${args.dev ? '--dev' : ''} ${packages}`.trim(); break;
            case 'uninstall': command = `yarn remove ${packages}`; break;
            case 'update': command = packages ? `yarn upgrade ${packages}` : 'yarn upgrade'; break;
            case 'list': command = 'yarn list --depth=0'; break;
            case 'audit': command = 'yarn audit'; break;
          }
          break;
        case 'pip':
          switch (args.action) {
            case 'install': command = `pip install ${packages}`; break;
            case 'uninstall': command = `pip uninstall -y ${packages}`; break;
            case 'update': command = `pip install --upgrade ${packages}`; break;
            case 'list': command = 'pip list'; break;
            case 'audit': command = 'pip-audit'; break;
          }
          break;
        case 'cargo':
          switch (args.action) {
            case 'install': command = `cargo add ${packages}`; break;
            case 'uninstall': command = `cargo remove ${packages}`; break;
            case 'update': command = 'cargo update'; break;
            case 'list': command = 'cargo tree --depth 1'; break;
            case 'audit': command = 'cargo audit'; break;
          }
          break;
        default:
          throw new Error(`Package manager ${args.packageManager} not fully implemented yet`);
      }

      console.log(`\n📦 [Package Manager] ${command}`);

      const { stdout, stderr } = await execAsync(command, {
        cwd: args.workingDir,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 120000, // 2 minute timeout
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              command,
              output: stdout.substring(0, 5000),
              warnings: stderr ? stderr.substring(0, 1000) : undefined,
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: 'Check if package manager is installed and packages exist',
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const deploymentConfigTool = tool(
  'deployment_config',
  `Configure deployment settings for the project.
Use this to set up:
- Build commands (compile TypeScript, bundle assets)
- Run commands (start production server)
- Environment variables (without exposing secrets)
- Port configuration`,
  {
    action: z.enum(['get', 'set', 'validate', 'deploy_preview']).describe('Configuration action'),
    buildCommand: z.string().optional().describe('Command to build the project'),
    runCommand: z.string().optional().describe('Command to start in production'),
    port: z.number().optional().describe('Port to expose'),
    envVars: z.array(z.object({
      key: z.string(),
      value: z.string().optional(),
      isSecret: z.boolean().optional(),
    })).optional().describe('Environment variables (secrets will be masked)'),
    projectPath: z.string().describe('Path to the project'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const configPath = path.join(args.projectPath, '.deployment.json');

      let config: any = {
        buildCommand: '',
        runCommand: '',
        port: 3000,
        envVars: [],
      };

      // Try to read existing config
      try {
        const existing = await fs.readFile(configPath, 'utf-8');
        config = JSON.parse(existing);
      } catch {
        // No existing config, use defaults
      }

      switch (args.action) {
        case 'get':
          // Mask secrets
          const safeConfig = {
            ...config,
            envVars: config.envVars?.map((v: any) => ({
              key: v.key,
              value: v.isSecret ? '***MASKED***' : v.value,
              isSecret: v.isSecret,
            })),
          };
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, config: safeConfig }, null, 2),
            }],
          };

        case 'set':
          if (args.buildCommand) config.buildCommand = args.buildCommand;
          if (args.runCommand) config.runCommand = args.runCommand;
          if (args.port) config.port = args.port;
          if (args.envVars) {
            // Merge env vars
            for (const newVar of args.envVars) {
              const idx = config.envVars.findIndex((v: any) => v.key === newVar.key);
              if (idx >= 0) {
                config.envVars[idx] = newVar;
              } else {
                config.envVars.push(newVar);
              }
            }
          }

          await fs.writeFile(configPath, JSON.stringify(config, null, 2));
          console.log(`\n🚀 [Deployment] Configuration saved to ${configPath}`);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Deployment configuration saved',
                config: {
                  buildCommand: config.buildCommand,
                  runCommand: config.runCommand,
                  port: config.port,
                  envVarCount: config.envVars.length,
                },
              }, null, 2),
            }],
          };

        case 'validate':
          const issues: string[] = [];
          if (!config.runCommand) issues.push('Missing run command');
          if (!config.port) issues.push('Missing port configuration');

          // Check if package.json exists
          try {
            const pkgPath = path.join(args.projectPath, 'package.json');
            await fs.access(pkgPath);
            // package.json exists, good for npm commands
          } catch {
            if (config.buildCommand?.includes('npm') || config.runCommand?.includes('npm')) {
              issues.push('package.json not found but npm commands are configured');
            }
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: issues.length === 0,
                valid: issues.length === 0,
                issues,
                config: { buildCommand: config.buildCommand, runCommand: config.runCommand, port: config.port },
              }, null, 2),
            }],
          };

        case 'deploy_preview':
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Deploy preview ready',
                steps: [
                  config.buildCommand ? `1. Build: ${config.buildCommand}` : '1. No build step',
                  `2. Run: ${config.runCommand}`,
                  `3. Expose port: ${config.port}`,
                ],
                tip: 'Use browser_preview after starting the server',
              }, null, 2),
            }],
          };
      }
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

const knowledgeBase: Record<string, { patterns: string[]; antiPatterns: string[]; tips: string[] }> = {
  typescript: {
    patterns: [
      'Use strict mode and enable all strict checks',
      'Prefer interfaces over type aliases for object shapes',
      'Use readonly for immutable properties',
      'Leverage discriminated unions for state management',
      'Use const assertions for literal types',
    ],
    antiPatterns: [
      'Avoid using `any` - use `unknown` instead',
      'Don\'t use `!` non-null assertion carelessly',
      'Avoid type assertions unless necessary',
      'Don\'t use enums - use const objects or unions',
    ],
    tips: [
      'Use `satisfies` operator for type-safe object literals',
      'Leverage template literal types for string patterns',
      'Use conditional types for complex type logic',
    ],
  },
  react: {
    patterns: [
      'Use functional components with hooks',
      'Keep components small and focused (< 200 lines)',
      'Use custom hooks to extract reusable logic',
      'Implement error boundaries for resilience',
      'Use React.memo() for expensive renders',
    ],
    antiPatterns: [
      'Avoid prop drilling - use context or state management',
      'Don\'t mutate state directly',
      'Avoid useEffect for derived state',
      'Don\'t use index as key for dynamic lists',
    ],
    tips: [
      'Use useCallback for event handlers passed to children',
      'Prefer useMemo for expensive calculations',
      'Use React.lazy() for code splitting',
    ],
  },
  nodejs: {
    patterns: [
      'Use async/await over callbacks or raw promises',
      'Implement proper error handling with try/catch',
      'Use environment variables for configuration',
      'Structure code in modules with clear responsibilities',
      'Use streaming for large data processing',
    ],
    antiPatterns: [
      'Avoid blocking the event loop',
      'Don\'t ignore promise rejections',
      'Avoid synchronous file operations in servers',
      'Don\'t store secrets in code',
    ],
    tips: [
      'Use cluster module for multi-core utilization',
      'Implement graceful shutdown handlers',
      'Use compression middleware for HTTP responses',
    ],
  },
  git: {
    patterns: [
      'Write descriptive commit messages (why, not just what)',
      'Keep commits atomic - one logical change per commit',
      'Use feature branches for new work',
      'Rebase feature branches before merging',
      'Tag releases with semantic versioning',
    ],
    antiPatterns: [
      'Never force push to shared branches',
      'Don\'t commit secrets or credentials',
      'Avoid committing large binary files',
      'Don\'t use generic messages like "fix" or "update"',
    ],
    tips: [
      'Use git hooks for pre-commit validation',
      'Squash commits before merging feature branches',
      'Use git bisect to find bugs',
    ],
  },
  security: {
    patterns: [
      'Validate and sanitize all user input',
      'Use parameterized queries to prevent SQL injection',
      'Implement rate limiting on APIs',
      'Use HTTPS for all communications',
      'Store passwords with bcrypt or argon2',
    ],
    antiPatterns: [
      'Never log sensitive data (passwords, tokens)',
      'Don\'t use eval() or dynamic code execution',
      'Avoid storing secrets in environment variables in production',
      'Don\'t trust client-side validation alone',
    ],
    tips: [
      'Use CSP headers to prevent XSS',
      'Implement CSRF protection for state-changing operations',
      'Run regular dependency audits',
    ],
  },
  testing: {
    patterns: [
      'Test behavior, not implementation',
      'Use descriptive test names that explain the scenario',
      'Follow Arrange-Act-Assert pattern',
      'Mock external dependencies',
      'Aim for high coverage of critical paths',
    ],
    antiPatterns: [
      'Don\'t test implementation details',
      'Avoid brittle tests that break with refactoring',
      'Don\'t skip tests to make CI pass',
      'Avoid testing third-party code',
    ],
    tips: [
      'Use property-based testing for edge cases',
      'Implement integration tests for critical flows',
      'Use test fixtures for consistent test data',
    ],
  },
};

export const knowledgeBaseTool = tool(
  'knowledge_base',
  `Access best practices and patterns for specific technologies.
Use this to:
- Get patterns to follow for a technology
- Learn anti-patterns to avoid
- Get tips for better code

Available topics: ${Object.keys(knowledgeBase).join(', ')}`,
  {
    topic: z.string().describe('Technology or topic to get knowledge about'),
    category: z.enum(['patterns', 'antiPatterns', 'tips', 'all']).default('all').describe('Category of knowledge'),
  },
  async (args) => {
    const topic = args.topic.toLowerCase();
    const knowledge = knowledgeBase[topic];

    if (!knowledge) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Topic "${args.topic}" not found`,
            availableTopics: Object.keys(knowledgeBase),
          }, null, 2),
        }],
      };
    }

    let result: any = { success: true, topic };

    if (args.category === 'all') {
      result = { ...result, ...knowledge };
    } else {
      result[args.category] = knowledge[args.category];
    }

    console.log(`\n📚 [Knowledge] Retrieved ${args.category} for ${topic}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);
