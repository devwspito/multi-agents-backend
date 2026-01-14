/**
 * DeveloperSelfCheckService
 *
 * Comprehensive pre-commit verification that Developer agents MUST pass.
 * This catches issues BEFORE code is submitted for Judge review.
 *
 * Runs:
 * 1. TypeScript compilation (tsc --noEmit)
 * 2. Linting (eslint)
 * 3. Unit tests (npm test)
 * 4. Import verification (all imports resolve)
 * 5. Semantic pattern checks
 *
 * If ANY check fails, Developer must fix before committing.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SelfCheckResult {
  passed: boolean;
  checks: {
    typescript: CheckResult;
    lint: CheckResult;
    tests: CheckResult;
    imports: CheckResult;
    patterns: CheckResult;
  };
  summary: string;
  blockingErrors: string[];
  warnings: string[];
  fixSuggestions: string[];
}

export interface CheckResult {
  passed: boolean;
  output?: string;
  errors?: string[];
  duration: number;
}

export interface SelfCheckConfig {
  workspacePath: string;
  modifiedFiles?: string[];
  skipTests?: boolean;
  timeout?: number;
  environmentCommands?: {
    typecheck?: string;
    lint?: string;
    test?: string;
  };
}

export class DeveloperSelfCheckService {
  /**
   * Run all self-checks before committing
   */
  static async runAllChecks(config: SelfCheckConfig): Promise<SelfCheckResult> {
    console.log(`\n🔍 [SelfCheck] Running pre-commit verification...`);

    const results: SelfCheckResult = {
      passed: true,
      checks: {
        typescript: { passed: true, duration: 0 },
        lint: { passed: true, duration: 0 },
        tests: { passed: true, duration: 0 },
        imports: { passed: true, duration: 0 },
        patterns: { passed: true, duration: 0 },
      },
      summary: '',
      blockingErrors: [],
      warnings: [],
      fixSuggestions: [],
    };

    // 1. TypeScript compilation check
    results.checks.typescript = await this.checkTypeScript(config);
    if (!results.checks.typescript.passed) {
      results.passed = false;
      results.blockingErrors.push(...(results.checks.typescript.errors || []));
    }

    // 2. Lint check
    results.checks.lint = await this.checkLint(config);
    if (!results.checks.lint.passed) {
      // Lint errors are warnings, not blocking
      results.warnings.push(...(results.checks.lint.errors || []));
    }

    // 3. Test check (if not skipped)
    if (!config.skipTests) {
      results.checks.tests = await this.checkTests(config);
      if (!results.checks.tests.passed) {
        results.passed = false;
        results.blockingErrors.push(...(results.checks.tests.errors || []));
      }
    }

    // 4. Import verification
    if (config.modifiedFiles && config.modifiedFiles.length > 0) {
      results.checks.imports = await this.checkImports(config);
      if (!results.checks.imports.passed) {
        results.passed = false;
        results.blockingErrors.push(...(results.checks.imports.errors || []));
      }
    }

    // 5. Pattern verification
    if (config.modifiedFiles && config.modifiedFiles.length > 0) {
      results.checks.patterns = await this.checkPatterns(config);
      if (!results.checks.patterns.passed) {
        results.passed = false;
        results.blockingErrors.push(...(results.checks.patterns.errors || []));
      }
    }

    // Generate summary
    const passedCount = Object.values(results.checks).filter(c => c.passed).length;
    const totalCount = Object.keys(results.checks).length;

    results.summary = results.passed
      ? `✅ All ${passedCount} checks passed`
      : `❌ ${totalCount - passedCount}/${totalCount} checks failed`;

    console.log(`   ${results.summary}`);

    return results;
  }

  /**
   * Check TypeScript compilation
   */
  private static async checkTypeScript(config: SelfCheckConfig): Promise<CheckResult> {
    const startTime = Date.now();
    const command = config.environmentCommands?.typecheck || 'npx tsc --noEmit';

    console.log(`   📦 TypeScript check: ${command}`);

    try {
      execSync(command, {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: config.timeout || 60000,
        stdio: 'pipe',
      });

      return {
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      const errors = this.parseTypeScriptErrors(output);

      console.log(`   ❌ TypeScript: ${errors.length} errors`);

      return {
        passed: false,
        output,
        errors,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Check linting
   */
  private static async checkLint(config: SelfCheckConfig): Promise<CheckResult> {
    const startTime = Date.now();

    // Check if eslint config exists
    const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', 'eslint.config.js'];
    const hasEslint = eslintConfigs.some(c => fs.existsSync(path.join(config.workspacePath, c)));

    if (!hasEslint) {
      return { passed: true, duration: 0, output: 'No ESLint config found' };
    }

    const command = config.environmentCommands?.lint || 'npx eslint . --ext .ts,.tsx,.js,.jsx --max-warnings 0';

    console.log(`   🔍 Lint check...`);

    try {
      execSync(command, {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: config.timeout || 60000,
        stdio: 'pipe',
      });

      return {
        passed: true,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      const errors = this.parseLintErrors(output);

      console.log(`   ⚠️ Lint: ${errors.length} issues`);

      return {
        passed: false,
        output,
        errors,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Check tests
   */
  private static async checkTests(config: SelfCheckConfig): Promise<CheckResult> {
    const startTime = Date.now();

    // Check if package.json has test script
    const packageJsonPath = path.join(config.workspacePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { passed: true, duration: 0, output: 'No package.json found' };
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (!packageJson.scripts?.test) {
        return { passed: true, duration: 0, output: 'No test script defined' };
      }
    } catch {
      return { passed: true, duration: 0 };
    }

    const command = config.environmentCommands?.test || 'npm test -- --passWithNoTests --watchAll=false';

    console.log(`   🧪 Test check...`);

    try {
      const output = execSync(command, {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: config.timeout || 120000,
        stdio: 'pipe',
        env: { ...process.env, CI: 'true' },
      });

      return {
        passed: true,
        output,
        duration: Date.now() - startTime,
      };
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      const errors = this.parseTestErrors(output);

      console.log(`   ❌ Tests: ${errors.length} failures`);

      return {
        passed: false,
        output,
        errors,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Check that all imports resolve
   */
  private static async checkImports(config: SelfCheckConfig): Promise<CheckResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    console.log(`   📥 Import check...`);

    for (const file of config.modifiedFiles || []) {
      const fullPath = path.isAbsolute(file) ? file : path.join(config.workspacePath, file);

      if (!fs.existsSync(fullPath) || !file.match(/\.(ts|tsx|js|jsx)$/)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf8');

        // Extract import statements
        const importMatches = content.matchAll(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/g);

        for (const match of importMatches) {
          const importPath = match[1];

          // Skip node_modules imports
          if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
            continue;
          }

          // Resolve the import
          const baseDir = path.dirname(fullPath);
          let resolvedPath = path.resolve(baseDir, importPath);

          // Try common extensions
          const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
          let found = false;

          for (const ext of extensions) {
            if (fs.existsSync(resolvedPath + ext)) {
              found = true;
              break;
            }
          }

          if (!found) {
            errors.push(`${file}: Cannot resolve import '${importPath}'`);
          }
        }
      } catch (error: any) {
        errors.push(`${file}: Error reading file - ${error.message}`);
      }
    }

    if (errors.length > 0) {
      console.log(`   ❌ Imports: ${errors.length} unresolved`);
    }

    return {
      passed: errors.length === 0,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Check for anti-patterns in modified files
   */
  private static async checkPatterns(config: SelfCheckConfig): Promise<CheckResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    console.log(`   🔍 Pattern check...`);

    const antiPatterns = [
      { pattern: /console\.(log|debug)\s*\(/g, message: 'console.log left in code', severity: 'warning' },
      { pattern: /\/\/\s*TODO:/gi, message: 'TODO comment left in code', severity: 'warning' },
      { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g, message: 'Empty catch block', severity: 'error' },
      { pattern: /:\s*any\b/g, message: 'Using any type', severity: 'warning' },
      { pattern: /debugger;/g, message: 'debugger statement left in code', severity: 'error' },
      { pattern: /\.only\s*\(/g, message: '.only() in tests', severity: 'error' },
    ];

    for (const file of config.modifiedFiles || []) {
      const fullPath = path.isAbsolute(file) ? file : path.join(config.workspacePath, file);

      if (!fs.existsSync(fullPath) || !file.match(/\.(ts|tsx|js|jsx)$/)) {
        continue;
      }

      // Skip test files for some patterns
      const isTestFile = file.includes('.test.') || file.includes('.spec.');

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        for (const { pattern, message, severity } of antiPatterns) {
          // Skip console.log check in test files
          if (isTestFile && message.includes('console.log')) continue;

          let match;
          pattern.lastIndex = 0; // Reset regex

          while ((match = pattern.exec(content)) !== null) {
            const lineNum = content.substring(0, match.index).split('\n').length;
            const lineContent = lines[lineNum - 1]?.trim() || '';

            // Skip if in comment
            if (lineContent.startsWith('//') || lineContent.startsWith('*')) continue;

            if (severity === 'error') {
              errors.push(`${file}:${lineNum}: ${message}`);
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (errors.length > 0) {
      console.log(`   ❌ Patterns: ${errors.length} issues`);
    }

    return {
      passed: errors.length === 0,
      errors,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Parse TypeScript errors from output
   */
  private static parseTypeScriptErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Match TypeScript error format: file.ts(line,col): error TS1234: message
      if (line.includes('error TS')) {
        errors.push(line.trim());
      }
    }

    return errors.slice(0, 20); // Limit to 20 errors
  }

  /**
   * Parse lint errors from output
   */
  private static parseLintErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Match ESLint error format
      if (line.match(/^\s*\d+:\d+\s+(error|warning)/)) {
        errors.push(line.trim());
      }
    }

    return errors.slice(0, 20);
  }

  /**
   * Parse test errors from output
   */
  private static parseTestErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');

    let inFailSection = false;

    for (const line of lines) {
      if (line.includes('FAIL') || line.includes('✕')) {
        inFailSection = true;
      }

      if (inFailSection && line.trim()) {
        errors.push(line.trim());
        if (errors.length >= 20) break;
      }

      if (line.includes('Test Suites:') || line.includes('Tests:')) {
        inFailSection = false;
      }
    }

    return errors;
  }

  /**
   * Format results for Developer prompt injection
   */
  static formatForDeveloper(result: SelfCheckResult): string {
    if (result.passed) {
      return `
## ✅ PRE-COMMIT VERIFICATION PASSED

All checks passed. You can proceed to commit your changes.

${Object.entries(result.checks).map(([name, check]) =>
  `- ${check.passed ? '✅' : '⚠️'} ${name}: ${check.passed ? 'passed' : check.errors?.length + ' issues'} (${check.duration}ms)`
).join('\n')}
`;
    }

    return `
## ❌ PRE-COMMIT VERIFICATION FAILED

You MUST fix these errors before committing:

### Blocking Errors:
${result.blockingErrors.map(e => `- ${e}`).join('\n')}

${result.warnings.length > 0 ? `### Warnings (should fix):
${result.warnings.slice(0, 10).map(w => `- ${w}`).join('\n')}` : ''}

### Instructions:
1. Fix ALL blocking errors listed above
2. Run the checks again to verify
3. Only commit after all checks pass

⚠️ DO NOT commit until these issues are resolved!
`;
  }

  /**
   * Generate fix suggestions based on errors
   */
  static generateFixSuggestions(result: SelfCheckResult): string[] {
    const suggestions: string[] = [];

    for (const error of result.blockingErrors) {
      if (error.includes('Cannot find module') || error.includes('Cannot resolve import')) {
        suggestions.push('Check import paths - make sure the file exists and path is correct');
      }
      if (error.includes('error TS')) {
        suggestions.push('Fix TypeScript type errors - check types and add missing type annotations');
      }
      if (error.includes('Empty catch block')) {
        suggestions.push('Add error handling in catch blocks - at least log the error');
      }
      if (error.includes('.only()')) {
        suggestions.push('Remove .only() from tests - this prevents other tests from running');
      }
    }

    return [...new Set(suggestions)]; // Dedupe
  }
}
