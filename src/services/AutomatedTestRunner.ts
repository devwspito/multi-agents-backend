/**
 * AutomatedTestRunner
 *
 * Runs automated tests before Judge reviews code.
 * This catches functional issues that semantic analysis can't detect.
 *
 * Supports:
 * - Jest (npm test)
 * - Pytest (pytest)
 * - Go tests (go test)
 * - Custom test commands from environmentCommands
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface TestResult {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  coverage?: number;
  duration: number;
  output: string;
  failedTestNames: string[];
  errorSummary?: string;
}

export interface TestRunConfig {
  command?: string; // Custom test command (from environmentCommands)
  timeout?: number; // Timeout in ms (default: 60000)
  targetFiles?: string[]; // Run tests only for these files
  coverageRequired?: boolean;
}

export class AutomatedTestRunner {
  /**
   * Run tests in a workspace
   */
  static async runTests(
    workspacePath: string,
    config?: TestRunConfig
  ): Promise<TestResult> {
    const startTime = Date.now();
    const timeout = config?.timeout || 60000; // 1 minute default

    console.log(`\n🧪 [TestRunner] Running tests in ${workspacePath}...`);

    // Detect test framework and command
    const testCommand = config?.command || this.detectTestCommand(workspacePath);

    if (!testCommand) {
      console.log(`   ⚠️ No test framework detected`);
      return {
        passed: true, // Don't fail if no tests
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
        duration: 0,
        output: 'No test framework detected',
        failedTestNames: [],
      };
    }

    console.log(`   📋 Test command: ${testCommand}`);

    try {
      // Run tests with timeout
      const output = execSync(testCommand, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout,
        stdio: 'pipe',
        env: {
          ...process.env,
          CI: 'true', // Disable interactive mode
          FORCE_COLOR: '0', // Disable colors for easier parsing
        },
      });

      const duration = Date.now() - startTime;
      const result = this.parseTestOutput(output, testCommand);

      console.log(`   ✅ Tests passed: ${result.passedTests}/${result.totalTests} in ${duration}ms`);

      return {
        ...result,
        passed: result.failedTests === 0,
        duration,
        output: output.substring(0, 5000), // Limit output size
      };
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const output = error.stdout || error.stderr || error.message || 'Test execution failed';

      console.log(`   ❌ Tests failed in ${duration}ms`);

      const result = this.parseTestOutput(output, testCommand);

      return {
        ...result,
        passed: false,
        duration,
        output: output.substring(0, 5000),
        errorSummary: this.extractErrorSummary(output),
      };
    }
  }

  /**
   * Detect the appropriate test command for a workspace
   */
  private static detectTestCommand(workspacePath: string): string | null {
    // Check for package.json (Node.js projects)
    const packageJsonPath = path.join(workspacePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts?.test) {
          return 'npm test -- --passWithNoTests 2>&1';
        }
      } catch {
        // Ignore parsing errors
      }
    }

    // Check for pytest.ini or conftest.py (Python)
    if (
      fs.existsSync(path.join(workspacePath, 'pytest.ini')) ||
      fs.existsSync(path.join(workspacePath, 'conftest.py')) ||
      fs.existsSync(path.join(workspacePath, 'tests'))
    ) {
      return 'pytest -v --tb=short 2>&1 || true';
    }

    // Check for go.mod (Go)
    if (fs.existsSync(path.join(workspacePath, 'go.mod'))) {
      return 'go test ./... -v 2>&1 || true';
    }

    // Check for Cargo.toml (Rust)
    if (fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) {
      return 'cargo test 2>&1 || true';
    }

    return null;
  }

  /**
   * Parse test output to extract results
   */
  private static parseTestOutput(output: string, command: string): Omit<TestResult, 'passed' | 'duration' | 'output'> {
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;
    let skippedTests = 0;
    const failedTestNames: string[] = [];

    // Jest/npm test format
    if (command.includes('npm') || command.includes('jest')) {
      // "Tests: X passed, Y failed, Z total"
      const testsMatch = output.match(/Tests:\s+(\d+)\s+passed,?\s*(\d+)?\s*failed?,?\s*(\d+)?\s*skipped?,?\s*(\d+)?\s*total/i);
      if (testsMatch) {
        passedTests = parseInt(testsMatch[1]) || 0;
        failedTests = parseInt(testsMatch[2]) || 0;
        skippedTests = parseInt(testsMatch[3]) || 0;
        totalTests = parseInt(testsMatch[4]) || (passedTests + failedTests + skippedTests);
      }

      // Alternative format: "X passing" "Y failing"
      const passingMatch = output.match(/(\d+)\s+passing/i);
      const failingMatch = output.match(/(\d+)\s+failing/i);
      if (passingMatch) passedTests = parseInt(passingMatch[1]);
      if (failingMatch) failedTests = parseInt(failingMatch[1]);
      if (passingMatch || failingMatch) totalTests = passedTests + failedTests;

      // Extract failed test names
      const failedMatches = output.matchAll(/FAIL\s+(.+\.test\.[tj]sx?)/g);
      for (const match of failedMatches) {
        failedTestNames.push(match[1]);
      }
    }

    // Pytest format
    if (command.includes('pytest')) {
      // "X passed, Y failed, Z skipped"
      const pytestMatch = output.match(/(\d+)\s+passed,?\s*(\d+)?\s*failed?,?\s*(\d+)?\s*skipped?/i);
      if (pytestMatch) {
        passedTests = parseInt(pytestMatch[1]) || 0;
        failedTests = parseInt(pytestMatch[2]) || 0;
        skippedTests = parseInt(pytestMatch[3]) || 0;
        totalTests = passedTests + failedTests + skippedTests;
      }

      // Extract failed test names
      const failedMatches = output.matchAll(/FAILED\s+([\w\/.]+::\w+)/g);
      for (const match of failedMatches) {
        failedTestNames.push(match[1]);
      }
    }

    // Go test format
    if (command.includes('go test')) {
      // "ok" or "FAIL"
      const okMatches = output.matchAll(/ok\s+\S+/g);
      const failMatches = output.matchAll(/FAIL\s+(\S+)/g);

      for (const _ of okMatches) passedTests++;
      for (const match of failMatches) {
        failedTests++;
        failedTestNames.push(match[1]);
      }
      totalTests = passedTests + failedTests;
    }

    return {
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      failedTestNames,
    };
  }

  /**
   * Extract a concise error summary from test output
   */
  private static extractErrorSummary(output: string): string {
    const lines = output.split('\n');
    const errorLines: string[] = [];

    let inErrorSection = false;

    for (const line of lines) {
      // Start of error section
      if (line.match(/FAIL|Error:|AssertionError|expect\(|TypeError|ReferenceError/i)) {
        inErrorSection = true;
      }

      if (inErrorSection) {
        errorLines.push(line);
        if (errorLines.length >= 20) break;
      }

      // End of error section
      if (inErrorSection && line.match(/^\s*$/)) {
        inErrorSection = false;
      }
    }

    return errorLines.join('\n').substring(0, 2000);
  }

  /**
   * Format test results for Judge prompt
   */
  static formatForJudge(result: TestResult): string {
    if (result.totalTests === 0) {
      return `
## 🧪 TEST RESULTS
⚠️ No tests detected in the codebase.
Consider: Should this story include tests?
`;
    }

    const statusEmoji = result.passed ? '✅' : '❌';

    let output = `
## 🧪 AUTOMATED TEST RESULTS

**Status**: ${statusEmoji} ${result.passed ? 'ALL TESTS PASSED' : 'TESTS FAILED'}
**Results**: ${result.passedTests}/${result.totalTests} passed (${result.failedTests} failed, ${result.skippedTests} skipped)
**Duration**: ${result.duration}ms
`;

    if (!result.passed && result.failedTestNames.length > 0) {
      output += `
### ❌ FAILED TESTS:
${result.failedTestNames.map(t => `- ${t}`).join('\n')}

### Error Details:
\`\`\`
${result.errorSummary || result.output.substring(0, 1500)}
\`\`\`

**Judge Instructions**:
- ❌ REJECT this code - tests are failing
- Include the failed test names in your feedback
- Developer must fix the failing tests before approval
`;
    }

    return output;
  }

  /**
   * Format test results for Developer retry feedback
   */
  static formatForDeveloper(result: TestResult): string {
    if (result.passed || result.totalTests === 0) return '';

    let output = `
## 🔴 YOUR CODE FAILED TESTS - FIX BEFORE CONTINUING

**${result.failedTests}** test(s) are failing. You MUST fix them.

### Failed Tests:
${result.failedTestNames.map(t => `- ${t}`).join('\n')}

### Error Output:
\`\`\`
${result.errorSummary || result.output.substring(0, 2000)}
\`\`\`

### Instructions:
1. Read the error messages carefully
2. Find the root cause in your code
3. Fix the issue
4. Run tests locally to verify: \`npm test\`
5. Commit the fix

⚠️ Do NOT proceed until tests pass. The Judge will automatically reject failing code.
`;

    return output;
  }

  /**
   * Quick check if tests exist
   */
  static hasTests(workspacePath: string): boolean {
    const testPatterns = [
      '**/*.test.ts',
      '**/*.test.js',
      '**/*.spec.ts',
      '**/*.spec.js',
      '**/test_*.py',
      '**/*_test.go',
    ];

    for (const pattern of testPatterns) {
      try {
        const result = execSync(
          `find "${workspacePath}" -path "*/node_modules" -prune -o -name "${pattern.split('/').pop()}" -print 2>/dev/null | head -1`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (result) return true;
      } catch {
        // Continue
      }
    }

    return false;
  }
}
