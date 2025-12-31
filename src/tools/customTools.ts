import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { safeGitExec, safeFetch } from '../utils/safeGitExecution';

const execAsync = promisify(exec);

/**
 * Custom Tool: Create Epic Branch
 * Creates a new branch for an epic in a git repository
 */
export const createEpicBranchTool = tool(
  'create_epic_branch',
  'Create a new git branch for an epic with standardized naming',
  {
    epicId: z.string().describe('Epic ID (e.g., epic-auth)'),
    epicName: z.string().describe('Human-readable epic name'),
    repoPath: z.string().describe('Absolute path to repository'),
    baseBranch: z.string().default('main').describe('Base branch to create from'),
  },
  async (args) => {
    try {
      const branchName = `feature/${args.epicId}`;

      // Ensure we're in the repo - use safe fetch
      await safeFetch(args.repoPath);

      // Create branch from base - use safe git operations
      await safeGitExec(
        `cd "${args.repoPath}" && git checkout ${args.baseBranch} && git pull && git checkout -b ${branchName}`,
        { timeout: 30000 }
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              branchName,
              epicId: args.epicId,
              message: `Branch ${branchName} created successfully from ${args.baseBranch}`,
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Run Integration Tests
 * Runs integration tests and returns results
 */
export const runIntegrationTestsTool = tool(
  'run_integration_tests',
  'Run integration tests in a repository and return results',
  {
    repoPath: z.string().describe('Absolute path to repository'),
    testPattern: z.string().optional().describe('Test pattern (e.g., "*.integration.test.ts")'),
    timeout: z.number().default(300000).describe('Test timeout in milliseconds'),
  },
  async (args) => {
    try {
      const testCmd = args.testPattern
        ? `npm test -- ${args.testPattern}`
        : 'npm test';

      const { stdout, stderr } = await execAsync(
        `cd "${args.repoPath}" && ${testCmd}`,
        { timeout: args.timeout }
      );

      // Parse test results
      const passed = !stderr.includes('FAIL') && !stderr.includes('error');
      const testsMatch = stdout.match(/Tests:\s+(\d+)\s+passed/);
      const testCount = testsMatch ? parseInt(testsMatch[1]) : 0;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              passed,
              testCount,
              output: stdout,
              errors: stderr || null,
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
              passed: false,
              error: error.message,
              output: error.stdout || '',
              errors: error.stderr || '',
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Analyze Code Quality
 * Runs linting and static analysis
 */
export const analyzeCodeQualityTool = tool(
  'analyze_code_quality',
  'Analyze code quality using linters and static analysis tools',
  {
    repoPath: z.string().describe('Absolute path to repository'),
    paths: z.array(z.string()).optional().describe('Specific paths to analyze'),
  },
  async (args) => {
    try {
      const pathsToCheck = args.paths?.join(' ') || 'src/';

      // Run ESLint
      const { stdout: lintOutput } = await execAsync(
        `cd "${args.repoPath}" && npm run lint -- ${pathsToCheck} --format json`,
        { timeout: 60000 }
      ).catch(err => ({ stdout: err.stdout || '', stderr: err.stderr || '' }));

      let lintResults;
      try {
        lintResults = JSON.parse(lintOutput);
      } catch {
        lintResults = [];
      }

      const errorCount = lintResults.reduce((sum: number, file: any) => sum + (file.errorCount || 0), 0);
      const warningCount = lintResults.reduce((sum: number, file: any) => sum + (file.warningCount || 0), 0);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              errors: errorCount,
              warnings: warningCount,
              filesAnalyzed: lintResults.length,
              passed: errorCount === 0,
              details: lintResults,
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Execute Command
 * Execute shell commands with timeout support
 */
export const executeCommandTool = tool(
  'execute_command',
  'Execute shell commands with timeout (curl, wget, npm, etc.)',
  {
    command: z.string().describe('The shell command to execute'),
    workingDir: z.string().optional().describe('Working directory (defaults to repository root)'),
    timeout: z.number().default(60000).describe('Timeout in milliseconds (default: 60s)'),
    env: z.record(z.string()).optional().describe('Additional environment variables'),
  },
  async (args) => {
    try {
      const { stdout, stderr } = await execAsync(args.command, {
        cwd: args.workingDir,
        timeout: args.timeout,
        env: { ...process.env, ...args.env },
        maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              stdout,
              stderr,
              exitCode: 0,
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
              stdout: error.stdout || '',
              stderr: error.stderr || error.message,
              exitCode: error.code || -1,
              timedOut: error.killed || false,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Execute Streaming Command
 * Execute long-running commands with output streaming
 */
export const executeStreamingCommandTool = tool(
  'execute_streaming_command',
  'Execute long-running shell commands (npm install, build processes, etc.)',
  {
    command: z.string().describe('The shell command to execute'),
    workingDir: z.string().optional().describe('Working directory'),
    timeout: z.number().default(300000).describe('Timeout in milliseconds (default: 5min)'),
    env: z.record(z.string()).optional().describe('Additional environment variables'),
  },
  async (args) => {
    return new Promise((resolve) => {
      const outputChunks: string[] = [];
      const errorChunks: string[] = [];

      const child = spawn(args.command, [], {
        shell: true,
        cwd: args.workingDir,
        env: { ...process.env, ...args.env },
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              stdout: outputChunks.join(''),
              stderr: errorChunks.join(''),
              exitCode: -1,
              timedOut: true,
              error: 'Command timed out',
            }, null, 2),
          }],
        });
      }, args.timeout);

      child.stdout?.on('data', (data) => outputChunks.push(data.toString()));
      child.stderr?.on('data', (data) => errorChunks.push(data.toString()));

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        resolve({
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: code === 0,
              stdout: outputChunks.join(''),
              stderr: errorChunks.join(''),
              exitCode: code || 0,
              timedOut: false,
            }, null, 2),
          }],
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeoutId);
        resolve({
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
              stdout: outputChunks.join(''),
              stderr: errorChunks.join(''),
              exitCode: -1,
              timedOut: false,
            }, null, 2),
          }],
        });
      });
    });
  }
);

/**
 * Custom Tool: Validate Security Compliance
 * Checks for common security issues and compliance
 */
export const validateSecurityComplianceTool = tool(
  'validate_security_compliance',
  'Validate security compliance including GDPR, authentication, and vulnerability checks',
  {
    repoPath: z.string().describe('Absolute path to repository'),
    checkTypes: z.array(z.enum(['gdpr', 'auth', 'dependencies', 'secrets'])).default(['gdpr', 'auth', 'dependencies']),
  },
  async (args) => {
    try {
      const results: any = {
        success: true,
        checks: {},
        issues: [],
        passed: true,
      };

      // Check for GDPR compliance
      if (args.checkTypes.includes('gdpr')) {
        const { stdout } = await execAsync(
          `cd "${args.repoPath}" && grep -r "email\\|userId\\|personalData" --include="*.ts" --include="*.js" src/ || true`
        );

        const piiUsages = stdout.split('\n').filter(l => l.trim()).length;
        results.checks.gdpr = {
          piiReferences: piiUsages,
          recommendation: piiUsages > 0 ? 'Review PII handling for GDPR compliance' : 'No obvious PII detected',
        };
      }

      // Check authentication patterns
      if (args.checkTypes.includes('auth')) {
        const { stdout } = await execAsync(
          `cd "${args.repoPath}" && grep -r "password\\|token\\|jwt\\|auth" --include="*.ts" --include="*.js" src/ || true`
        );

        const authPatterns = stdout.split('\n').filter(l => l.trim()).length;
        results.checks.auth = {
          authReferences: authPatterns,
          passed: authPatterns > 0, // At least some auth is better than none
        };
      }

      // Check for known vulnerabilities in dependencies
      if (args.checkTypes.includes('dependencies')) {
        try {
          const { stdout: auditOutput } = await execAsync(
            `cd "${args.repoPath}" && npm audit --json`,
            { timeout: 30000 }
          );

          const auditResults = JSON.parse(auditOutput);
          const vulnerabilities = auditResults.metadata?.vulnerabilities || {};
          const critical = vulnerabilities.critical || 0;
          const high = vulnerabilities.high || 0;

          results.checks.dependencies = {
            critical,
            high,
            moderate: vulnerabilities.moderate || 0,
            low: vulnerabilities.low || 0,
            passed: critical === 0 && high === 0,
          };

          if (critical > 0 || high > 0) {
            results.passed = false;
            results.issues.push(`${critical} critical and ${high} high severity vulnerabilities found`);
          }
        } catch (error: any) {
          results.checks.dependencies = {
            error: 'Could not run npm audit',
            passed: false,
          };
        }
      }

      // Check for exposed secrets
      if (args.checkTypes.includes('secrets')) {
        const secretPatterns = [
          'API_KEY',
          'SECRET',
          'PASSWORD',
          'TOKEN',
          'PRIVATE_KEY',
        ];

        for (const pattern of secretPatterns) {
          const { stdout } = await execAsync(
            `cd "${args.repoPath}" && grep -r "${pattern}\\s*=" --include="*.ts" --include="*.js" src/ || true`
          );

          const matches = stdout.split('\n').filter(l => l.trim() && !l.includes('process.env'));
          if (matches.length > 0) {
            results.issues.push(`Potential hardcoded secret: ${pattern} (${matches.length} occurrences)`);
            results.passed = false;
          }
        }

        results.checks.secrets = {
          passed: results.issues.length === 0,
          scannedPatterns: secretPatterns.length,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(results, null, 2),
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

// ============================================================================
// MEMORY TOOLS - Persistent memory for agents
// ============================================================================

import { memoryService } from '../services/MemoryService';
import { MemoryType, MemoryImportance } from '../models/Memory';

/**
 * Custom Tool: Remember
 * Store a memory for future sessions
 */
export const rememberTool = tool(
  'remember',
  'Store a memory/insight for future sessions. Use this liberally to remember patterns, decisions, and learnings.',
  {
    projectId: z.string().describe('Project ID to associate this memory with'),
    type: z.enum([
      'codebase_pattern',
      'error_resolution',
      'user_preference',
      'architecture_decision',
      'api_contract',
      'test_pattern',
      'dependency_info',
      'workflow_learned',
      'agent_insight',
    ]).describe('Type of memory'),
    title: z.string().max(200).describe('Short title for the memory'),
    content: z.string().max(10000).describe('Full content of the memory'),
    context: z.string().optional().describe('Additional context (file paths, error messages, etc.)'),
    importance: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('How important is this memory'),
    taskId: z.string().optional().describe('Task ID that created this memory'),
    agentType: z.string().optional().describe('Agent type that created this memory'),
  },
  async (args) => {
    try {
      const memory = await memoryService.remember({
        projectId: args.projectId,
        type: args.type as MemoryType,
        title: args.title,
        content: args.content,
        context: args.context,
        importance: args.importance as MemoryImportance,
        source: {
          taskId: args.taskId,
          agentType: args.agentType,
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              memoryId: memory._id.toString(),
              title: memory.title,
              type: memory.type,
              message: `Memory stored successfully: "${memory.title}"`,
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Recall
 * Search for relevant memories using semantic search
 */
export const recallTool = tool(
  'recall',
  'Search for relevant memories from past sessions. Use this before starting work to recall patterns and learnings.',
  {
    projectId: z.string().describe('Project ID to search memories for'),
    query: z.string().describe('What are you looking for? Describe the topic or problem.'),
    types: z.array(z.enum([
      'codebase_pattern',
      'error_resolution',
      'user_preference',
      'architecture_decision',
      'api_contract',
      'test_pattern',
      'dependency_info',
      'workflow_learned',
      'agent_insight',
    ])).optional().describe('Filter by memory types'),
    minImportance: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Minimum importance level'),
    limit: z.number().default(5).describe('Maximum number of memories to return'),
  },
  async (args) => {
    try {
      const results = await memoryService.recall({
        projectId: args.projectId,
        query: args.query,
        types: args.types as MemoryType[] | undefined,
        minImportance: args.minImportance as MemoryImportance | undefined,
        limit: args.limit,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                memories: [],
                message: 'No relevant memories found for this query.',
              }, null, 2),
            },
          ],
        };
      }

      const formattedMemories = results.map(r => ({
        id: r.memory._id?.toString(),
        title: r.memory.title,
        type: r.memory.type,
        importance: r.memory.importance,
        content: r.memory.content,
        context: r.memory.context,
        relevanceScore: Math.round(r.score * 100) / 100,
        createdAt: r.memory.createdAt,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              memories: formattedMemories,
              count: formattedMemories.length,
              message: `Found ${formattedMemories.length} relevant memories.`,
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Memory Feedback
 * Mark a memory as useful or not useful
 */
export const memoryFeedbackTool = tool(
  'memory_feedback',
  'Provide feedback on whether a memory was useful. This helps improve future memory retrieval.',
  {
    memoryId: z.string().describe('ID of the memory'),
    wasUseful: z.boolean().describe('Was this memory useful for your task?'),
  },
  async (args) => {
    try {
      await memoryService.feedback(args.memoryId, args.wasUseful);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Feedback recorded: memory was ${args.wasUseful ? 'useful' : 'not useful'}`,
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
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Custom Tool: Type Check
 * Run TypeScript type checker and return structured results
 */
export const typeCheckTool = tool(
  'type_check',
  'Run TypeScript compiler in check mode (no emit) and return type errors. Critical for validating code before Judge review.',
  {
    repoPath: z.string().describe('Absolute path to repository'),
    files: z.array(z.string()).optional().describe('Specific files to check (omit for full project)'),
    strict: z.boolean().default(true).describe('Enable strict mode'),
  },
  async (args) => {
    try {
      let cmd = 'npx tsc --noEmit --pretty false';
      if (args.strict) cmd += ' --strict';
      if (args.files?.length) {
        cmd += ` ${args.files.join(' ')}`;
      }

      try {
        await execAsync(cmd, {
          cwd: args.repoPath,
          timeout: 120000, // 2 minutes
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer
        });

        // No errors - type check passed
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                passed: true,
                errorCount: 0,
                errors: [],
                message: 'All files passed type checking',
              }, null, 2),
            },
          ],
        };
      } catch (tscError: any) {
        // TypeScript outputs errors on stdout/stderr
        const output = tscError.stdout || tscError.stderr || tscError.message || '';

        // Parse error lines like: src/file.ts(10,5): error TS2322: Type 'string' is not assignable...
        const errorPattern = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm;
        const errors: Array<{
          file: string;
          line: number;
          column: number;
          severity: string;
          code: string;
          message: string;
        }> = [];

        let match;
        while ((match = errorPattern.exec(output)) !== null) {
          errors.push({
            file: match[1],
            line: parseInt(match[2], 10),
            column: parseInt(match[3], 10),
            severity: match[4],
            code: match[5],
            message: match[6],
          });
        }

        // Group errors by file for easier reading
        const errorsByFile: Record<string, typeof errors> = {};
        for (const err of errors) {
          if (!errorsByFile[err.file]) {
            errorsByFile[err.file] = [];
          }
          errorsByFile[err.file].push(err);
        }

        // If we couldn't parse any errors, include raw output
        const rawErrors = errors.length === 0 ? output.split('\n').filter((l: string) => l.includes('error')).slice(0, 20) : [];

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true, // Tool executed successfully
                passed: false, // But found type errors
                errorCount: errors.length || rawErrors.length,
                errors: errors.slice(0, 50), // Limit to 50 errors
                errorsByFile: Object.fromEntries(
                  Object.entries(errorsByFile).slice(0, 10) // Top 10 files with errors
                ),
                rawErrors: rawErrors,
                summary: `Found ${errors.length || rawErrors.length} type error(s) across ${Object.keys(errorsByFile).length} file(s)`,
                recommendation: 'Fix type errors before proceeding to Judge review',
              }, null, 2),
            },
          ],
        };
      }
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: error.message,
              suggestion: 'Ensure TypeScript is installed: npm install typescript',
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Create custom MCP server with all tools
 */
export function createCustomToolsServer() {
  return createSdkMcpServer({
    name: 'custom-dev-tools',
    version: '1.0.0',
    tools: [
      createEpicBranchTool,
      runIntegrationTestsTool,
      analyzeCodeQualityTool,
      validateSecurityComplianceTool,
      executeCommandTool,
      executeStreamingCommandTool,
      typeCheckTool,
      // Memory tools
      rememberTool,
      recallTool,
      memoryFeedbackTool,
    ],
  });
}

/**
 * Get all custom tools as array
 */
export function getCustomTools() {
  return [
    createEpicBranchTool,
    runIntegrationTestsTool,
    analyzeCodeQualityTool,
    validateSecurityComplianceTool,
    executeCommandTool,
    executeStreamingCommandTool,
    typeCheckTool,
    // Memory tools
    rememberTool,
    recallTool,
    memoryFeedbackTool,
  ];
}
