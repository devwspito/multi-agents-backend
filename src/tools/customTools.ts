import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

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

      // Ensure we're in the repo
      await execAsync(`cd "${args.repoPath}" && git fetch origin`);

      // Create branch from base
      await execAsync(
        `cd "${args.repoPath}" && git checkout ${args.baseBranch} && git pull && git checkout -b ${branchName}`
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
    ],
  });
}
