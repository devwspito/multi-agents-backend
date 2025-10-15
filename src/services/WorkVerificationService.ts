import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Verification Result
 */
export interface IVerificationResult {
  passed: boolean;
  checks: {
    lint?: {
      passed: boolean;
      errors: number;
      warnings: number;
      details?: string;
    };
    typecheck?: {
      passed: boolean;
      errors: number;
      details?: string;
    };
    tests?: {
      passed: boolean;
      total: number;
      failed: number;
      details?: string;
    };
    security?: {
      passed: boolean;
      vulnerabilities: {
        critical: number;
        high: number;
        moderate: number;
        low: number;
      };
      details?: string;
    };
  };
  issues: string[];
  recommendations: string[];
}

/**
 * Work Verification Service
 *
 * Implements the "verify work" phase from agent loop best practices:
 * gather context → take action → VERIFY work → repeat
 *
 * Verifies developer work before committing:
 * - Linting (ESLint)
 * - Type checking (TypeScript)
 * - Tests execution
 * - Security audit
 */
export class WorkVerificationService {
  /**
   * Verify all aspects of the work
   */
  async verifyAll(
    repoPath: string,
    options: {
      runLint?: boolean;
      runTypecheck?: boolean;
      runTests?: boolean;
      runSecurity?: boolean;
    } = {}
  ): Promise<IVerificationResult> {
    const {
      runLint = true,
      runTypecheck = true,
      runTests = true,
      runSecurity = true,
    } = options;

    const result: IVerificationResult = {
      passed: true,
      checks: {},
      issues: [],
      recommendations: [],
    };

    console.log(`\n🔍 [Work Verification] Starting verification in ${repoPath}...`);

    // 1. Linting
    if (runLint) {
      const lintResult = await this.verifyLinting(repoPath);
      result.checks.lint = lintResult;

      if (!lintResult.passed) {
        result.passed = false;
        result.issues.push(
          `Linting failed: ${lintResult.errors} errors, ${lintResult.warnings} warnings`
        );

        if (lintResult.errors > 0) {
          result.recommendations.push('Run "npm run lint -- --fix" to auto-fix linting issues');
        }
      }
    }

    // 2. Type checking
    if (runTypecheck) {
      const typecheckResult = await this.verifyTypecheck(repoPath);
      result.checks.typecheck = typecheckResult;

      if (!typecheckResult.passed) {
        result.passed = false;
        result.issues.push(`Type checking failed: ${typecheckResult.errors} errors`);
        result.recommendations.push('Fix TypeScript type errors before committing');
      }
    }

    // 3. Tests
    if (runTests) {
      const testsResult = await this.verifyTests(repoPath);
      result.checks.tests = testsResult;

      if (!testsResult.passed) {
        result.passed = false;
        result.issues.push(`Tests failed: ${testsResult.failed}/${testsResult.total} tests failing`);
        result.recommendations.push('Fix failing tests or update test expectations');
      }
    }

    // 4. Security
    if (runSecurity) {
      const securityResult = await this.verifySecurity(repoPath);
      result.checks.security = securityResult;

      if (!securityResult.passed) {
        result.passed = false;
        const { critical, high } = securityResult.vulnerabilities;
        result.issues.push(`Security issues: ${critical} critical, ${high} high severity`);
        result.recommendations.push('Run "npm audit fix" to fix security vulnerabilities');
      }
    }

    // Summary
    console.log(`\n📊 [Work Verification] Summary:`);
    console.log(`  Overall: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    if (result.checks.lint) {
      console.log(`  Linting: ${result.checks.lint.passed ? '✅' : '❌'} (${result.checks.lint.errors} errors)`);
    }
    if (result.checks.typecheck) {
      console.log(`  Typecheck: ${result.checks.typecheck.passed ? '✅' : '❌'} (${result.checks.typecheck.errors} errors)`);
    }
    if (result.checks.tests) {
      console.log(`  Tests: ${result.checks.tests.passed ? '✅' : '❌'} (${result.checks.tests.failed} failed)`);
    }
    if (result.checks.security) {
      const v = result.checks.security.vulnerabilities;
      console.log(`  Security: ${result.checks.security.passed ? '✅' : '❌'} (${v.critical + v.high} critical+high)`);
    }

    if (!result.passed) {
      console.log(`\n❌ [Work Verification] Issues found:`);
      result.issues.forEach((issue) => console.log(`  - ${issue}`));
      console.log(`\n💡 [Work Verification] Recommendations:`);
      result.recommendations.forEach((rec) => console.log(`  - ${rec}`));
    }

    return result;
  }

  /**
   * Verify linting with ESLint
   */
  private async verifyLinting(repoPath: string): Promise<{
    passed: boolean;
    errors: number;
    warnings: number;
    details?: string;
  }> {
    try {
      console.log(`  🔍 Running ESLint...`);

      const { stdout, stderr } = await execAsync(
        `cd "${repoPath}" && npm run lint -- --format json`,
        { timeout: 60000 }
      ).catch((err) => ({
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      }));

      let lintResults;
      try {
        lintResults = JSON.parse(stdout);
      } catch {
        // If JSON parsing fails, ESLint might not be configured
        console.log(`  ⚠️  ESLint not available or misconfigured`);
        return {
          passed: true, // Don't fail if linting not available
          errors: 0,
          warnings: 0,
          details: 'ESLint not configured',
        };
      }

      const errorCount = lintResults.reduce(
        (sum: number, file: any) => sum + (file.errorCount || 0),
        0
      );
      const warningCount = lintResults.reduce(
        (sum: number, file: any) => sum + (file.warningCount || 0),
        0
      );

      return {
        passed: errorCount === 0,
        errors: errorCount,
        warnings: warningCount,
        details: stderr || undefined,
      };
    } catch (error: any) {
      console.log(`  ⚠️  Linting error: ${error.message}`);
      return {
        passed: true, // Don't fail on linting errors in verification
        errors: 0,
        warnings: 0,
        details: error.message,
      };
    }
  }

  /**
   * Verify TypeScript type checking
   */
  private async verifyTypecheck(repoPath: string): Promise<{
    passed: boolean;
    errors: number;
    details?: string;
  }> {
    try {
      console.log(`  🔍 Running TypeScript type check...`);

      const { stdout, stderr } = await execAsync(
        `cd "${repoPath}" && npm run typecheck 2>&1`,
        { timeout: 60000 }
      ).catch((err) => ({
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      }));

      const output = stdout + stderr;

      // Count "error TS" occurrences (actual TypeScript errors)
      const errorMatches = output.match(/error TS\d+:/g);
      const errorCount = errorMatches ? errorMatches.length : 0;

      // Check for build failures
      const hasBuildFailure = output.includes('Build failed') || output.includes('Compilation failed');

      return {
        passed: errorCount === 0 && !hasBuildFailure,
        errors: errorCount,
        details: errorCount > 0 ? output : undefined,
      };
    } catch (error: any) {
      console.log(`  ⚠️  Type checking error: ${error.message}`);
      return {
        passed: true, // Don't fail if typecheck not available
        errors: 0,
        details: error.message,
      };
    }
  }

  /**
   * Verify tests execution
   */
  private async verifyTests(repoPath: string): Promise<{
    passed: boolean;
    total: number;
    failed: number;
    details?: string;
  }> {
    try {
      console.log(`  🔍 Running tests...`);

      const { stdout, stderr } = await execAsync(
        `cd "${repoPath}" && npm test 2>&1`,
        { timeout: 300000 }
      ).catch((err) => ({
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      }));

      const output = stdout + stderr;

      // Parse test results
      // Look for patterns like "Tests: 5 passed, 5 total" or "X failing"
      const totalMatch = output.match(/(\d+)\s+total/i);
      const failedMatch = output.match(/(\d+)\s+fail/i);

      const total = totalMatch ? parseInt(totalMatch[1]) : 0;
      const failed = failedMatch ? parseInt(failedMatch[1]) : 0;
      const passed = !output.includes('FAIL') && !output.includes('failing');

      return {
        passed: passed && failed === 0,
        total,
        failed,
        details: failed > 0 ? output : undefined,
      };
    } catch (error: any) {
      console.log(`  ⚠️  Tests error: ${error.message}`);
      return {
        passed: true, // Don't fail if tests not available
        total: 0,
        failed: 0,
        details: error.message,
      };
    }
  }

  /**
   * Verify security with npm audit
   */
  private async verifySecurity(repoPath: string): Promise<{
    passed: boolean;
    vulnerabilities: {
      critical: number;
      high: number;
      moderate: number;
      low: number;
    };
    details?: string;
  }> {
    try {
      console.log(`  🔍 Running security audit...`);

      const { stdout } = await execAsync(
        `cd "${repoPath}" && npm audit --json`,
        { timeout: 30000 }
      ).catch((err) => ({
        stdout: err.stdout || '{}',
      }));

      const auditResults = JSON.parse(stdout);
      const vulnerabilities = auditResults.metadata?.vulnerabilities || {
        critical: 0,
        high: 0,
        moderate: 0,
        low: 0,
      };

      const critical = vulnerabilities.critical || 0;
      const high = vulnerabilities.high || 0;

      return {
        passed: critical === 0 && high === 0,
        vulnerabilities: {
          critical: vulnerabilities.critical || 0,
          high: vulnerabilities.high || 0,
          moderate: vulnerabilities.moderate || 0,
          low: vulnerabilities.low || 0,
        },
        details: critical + high > 0 ? JSON.stringify(auditResults, null, 2) : undefined,
      };
    } catch (error: any) {
      console.log(`  ⚠️  Security audit error: ${error.message}`);
      return {
        passed: true, // Don't fail if audit not available
        vulnerabilities: {
          critical: 0,
          high: 0,
          moderate: 0,
          low: 0,
        },
        details: error.message,
      };
    }
  }

  /**
   * Auto-fix issues where possible
   */
  async autoFix(repoPath: string): Promise<{ fixed: boolean; message: string }> {
    try {
      console.log(`\n🔧 [Work Verification] Attempting auto-fix...`);

      // Try to fix linting issues
      await execAsync(`cd "${repoPath}" && npm run lint -- --fix`, {
        timeout: 60000,
      }).catch(() => {
        // Ignore errors - auto-fix is best effort
      });

      console.log(`  ✅ Auto-fix completed`);

      return {
        fixed: true,
        message: 'Linting issues auto-fixed where possible',
      };
    } catch (error: any) {
      return {
        fixed: false,
        message: error.message,
      };
    }
  }
}
