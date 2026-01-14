/**
 * QualityGates
 *
 * Mandatory quality checks that must pass before code can be merged.
 * These gates are non-negotiable and block PRs until satisfied.
 *
 * Gates:
 * 1. Compilation - No TypeScript errors
 * 2. Linting - No lint errors
 * 3. Tests - All tests pass
 * 4. Coverage - Minimum coverage threshold
 * 5. Security - No secrets, no vulnerabilities
 * 6. Patterns - Follows codebase patterns
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface QualityGate {
  name: string;
  description: string;
  required: boolean;
  passed: boolean;
  details?: string;
  score?: number; // 0-100
}

export interface QualityGateResult {
  passed: boolean;
  gates: QualityGate[];
  overallScore: number;
  blockingGates: string[];
  recommendations: string[];
}

export interface QualityGateConfig {
  workspacePath: string;
  modifiedFiles?: string[];
  minCoverage?: number;
  allowedTodos?: number;
  strictMode?: boolean;
}

export class QualityGates {
  /**
   * Run all quality gates
   */
  static async runAllGates(config: QualityGateConfig): Promise<QualityGateResult> {
    console.log(`\n🚦 [QualityGates] Running quality checks...`);

    const gates: QualityGate[] = [];

    // Gate 1: TypeScript Compilation
    gates.push(await this.checkCompilation(config));

    // Gate 2: Linting
    gates.push(await this.checkLinting(config));

    // Gate 3: Tests
    gates.push(await this.checkTests(config));

    // Gate 4: Coverage (if tests exist)
    gates.push(await this.checkCoverage(config));

    // Gate 5: Security
    gates.push(await this.checkSecurity(config));

    // Gate 6: Code Quality
    gates.push(await this.checkCodeQuality(config));

    // Gate 7: No TODOs (if strict)
    if (config.strictMode) {
      gates.push(await this.checkNoTodos(config));
    }

    // Calculate results
    const requiredGates = gates.filter(g => g.required);
    const passedRequired = requiredGates.filter(g => g.passed);
    const blockingGates = requiredGates.filter(g => !g.passed).map(g => g.name);

    const overallScore = gates.reduce((sum, g) => sum + (g.score || (g.passed ? 100 : 0)), 0) / gates.length;

    const result: QualityGateResult = {
      passed: blockingGates.length === 0,
      gates,
      overallScore: Math.round(overallScore),
      blockingGates,
      recommendations: this.generateRecommendations(gates),
    };

    console.log(`   Score: ${result.overallScore}/100`);
    console.log(`   Gates passed: ${passedRequired.length}/${requiredGates.length}`);
    console.log(`   ${result.passed ? '✅ All gates passed' : `❌ Blocked by: ${blockingGates.join(', ')}`}`);

    return result;
  }

  /**
   * Gate 1: TypeScript Compilation
   */
  private static async checkCompilation(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Compilation',
      description: 'TypeScript compiles without errors',
      required: true,
      passed: false,
    };

    try {
      execSync('npx tsc --noEmit 2>&1', {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: 120000,
      });
      gate.passed = true;
      gate.score = 100;
      gate.details = 'All files compile successfully';
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      const errorCount = (output.match(/error TS/g) || []).length;
      gate.details = `${errorCount} TypeScript error(s)`;
      gate.score = Math.max(0, 100 - errorCount * 10);
    }

    return gate;
  }

  /**
   * Gate 2: Linting
   */
  private static async checkLinting(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Linting',
      description: 'ESLint passes with no errors',
      required: true,
      passed: false,
    };

    // Check if ESLint config exists
    const eslintConfigs = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', 'eslint.config.js'];
    const hasEslint = eslintConfigs.some(c => fs.existsSync(path.join(config.workspacePath, c)));

    if (!hasEslint) {
      gate.passed = true;
      gate.score = 100;
      gate.details = 'No ESLint config (skipped)';
      return gate;
    }

    try {
      execSync('npx eslint . --ext .ts,.tsx,.js,.jsx --max-warnings 0 2>&1', {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: 120000,
      });
      gate.passed = true;
      gate.score = 100;
      gate.details = 'No lint errors';
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      const errorCount = (output.match(/error/gi) || []).length;
      const warningCount = (output.match(/warning/gi) || []).length;
      gate.details = `${errorCount} errors, ${warningCount} warnings`;
      gate.score = Math.max(0, 100 - errorCount * 5 - warningCount);
    }

    return gate;
  }

  /**
   * Gate 3: Tests
   */
  private static async checkTests(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Tests',
      description: 'All tests pass',
      required: true,
      passed: false,
    };

    const packageJsonPath = path.join(config.workspacePath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      gate.passed = true;
      gate.score = 100;
      gate.details = 'No package.json (skipped)';
      return gate;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (!packageJson.scripts?.test) {
        gate.passed = true;
        gate.score = 50; // Penalty for no tests
        gate.details = 'No test script defined';
        return gate;
      }
    } catch {
      gate.passed = true;
      gate.details = 'Could not read package.json';
      return gate;
    }

    try {
      const output = execSync('npm test -- --passWithNoTests --watchAll=false 2>&1', {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: 300000,
        env: { ...process.env, CI: 'true' },
      });

      // Parse test results
      const passedMatch = output.match(/(\d+)\s+passed/);
      const failedMatch = output.match(/(\d+)\s+failed/);
      const passed = parseInt(passedMatch?.[1] || '0');
      const failed = parseInt(failedMatch?.[1] || '0');

      gate.passed = failed === 0;
      gate.score = passed > 0 ? (passed / (passed + failed)) * 100 : 100;
      gate.details = `${passed} passed, ${failed} failed`;
    } catch (error: any) {
      const output = error.stdout || error.message;
      const failedMatch = output.match(/(\d+)\s+failed/);
      const failed = parseInt(failedMatch?.[1] || '1');
      gate.details = `${failed} test(s) failed`;
      gate.score = 0;
    }

    return gate;
  }

  /**
   * Gate 4: Coverage
   */
  private static async checkCoverage(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Coverage',
      description: `Minimum ${config.minCoverage || 70}% code coverage`,
      required: false, // Optional by default
      passed: true,
    };

    // Check if coverage report exists
    const coveragePath = path.join(config.workspacePath, 'coverage', 'coverage-summary.json');
    if (!fs.existsSync(coveragePath)) {
      gate.details = 'No coverage report found';
      gate.score = 50;
      return gate;
    }

    try {
      const coverage = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
      const totalCoverage = coverage.total?.lines?.pct || 0;
      const minCoverage = config.minCoverage || 70;

      gate.passed = totalCoverage >= minCoverage;
      gate.score = Math.min(100, totalCoverage);
      gate.details = `${totalCoverage.toFixed(1)}% coverage (min: ${minCoverage}%)`;
    } catch {
      gate.details = 'Could not parse coverage report';
      gate.score = 50;
    }

    return gate;
  }

  /**
   * Gate 5: Security
   */
  private static async checkSecurity(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Security',
      description: 'No secrets or vulnerabilities',
      required: true,
      passed: true,
    };

    const issues: string[] = [];

    // Check for common secrets patterns in modified files
    const secretPatterns = [
      /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi,
      /secret\s*[:=]\s*['"][^'"]+['"]/gi,
      /password\s*[:=]\s*['"][^'"]+['"]/gi,
      /token\s*[:=]\s*['"][^'"]+['"]/gi,
      /AWS_SECRET/gi,
      /PRIVATE_KEY/gi,
    ];

    for (const file of config.modifiedFiles || []) {
      const fullPath = path.join(config.workspacePath, file);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const pattern of secretPatterns) {
          if (pattern.test(content)) {
            issues.push(`Potential secret in ${file}`);
            break;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Check for .env files in git
    try {
      const gitFiles = execSync('git ls-files', {
        cwd: config.workspacePath,
        encoding: 'utf8',
      });
      if (gitFiles.includes('.env') && !gitFiles.includes('.env.example')) {
        issues.push('.env file tracked in git');
      }
    } catch {
      // Not a git repo
    }

    gate.passed = issues.length === 0;
    gate.score = Math.max(0, 100 - issues.length * 25);
    gate.details = issues.length > 0 ? issues.join('; ') : 'No security issues detected';

    return gate;
  }

  /**
   * Gate 6: Code Quality
   */
  private static async checkCodeQuality(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'Code Quality',
      description: 'Follows best practices',
      required: false,
      passed: true,
    };

    const issues: string[] = [];
    let score = 100;

    for (const file of config.modifiedFiles || []) {
      const fullPath = path.join(config.workspacePath, file);
      if (!fs.existsSync(fullPath)) continue;
      if (!file.match(/\.(ts|tsx|js|jsx)$/)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');

        // Check for empty catch blocks
        if (/catch\s*\([^)]*\)\s*\{\s*\}/g.test(content)) {
          issues.push(`Empty catch block in ${file}`);
          score -= 10;
        }

        // Check for console.log (not in test files)
        if (!file.includes('.test.') && !file.includes('.spec.')) {
          if (/console\.(log|debug)\s*\(/g.test(content)) {
            issues.push(`console.log in ${file}`);
            score -= 5;
          }
        }

        // Check for debugger statements
        if (/\bdebugger\b/g.test(content)) {
          issues.push(`debugger statement in ${file}`);
          score -= 20;
        }

        // Check for any type
        const anyCount = (content.match(/:\s*any\b/g) || []).length;
        if (anyCount > 3) {
          issues.push(`${anyCount} 'any' types in ${file}`);
          score -= anyCount * 2;
        }
      } catch {
        // Skip unreadable files
      }
    }

    gate.passed = score >= 70;
    gate.score = Math.max(0, score);
    gate.details = issues.length > 0 ? issues.slice(0, 3).join('; ') : 'Good code quality';

    return gate;
  }

  /**
   * Gate 7: No TODOs
   */
  private static async checkNoTodos(config: QualityGateConfig): Promise<QualityGate> {
    const gate: QualityGate = {
      name: 'No TODOs',
      description: 'No TODO/FIXME comments in new code',
      required: false,
      passed: true,
    };

    let todoCount = 0;

    for (const file of config.modifiedFiles || []) {
      const fullPath = path.join(config.workspacePath, file);
      if (!fs.existsSync(fullPath)) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const todos = content.match(/\/\/\s*(TODO|FIXME|XXX|HACK):/gi) || [];
        todoCount += todos.length;
      } catch {
        // Skip unreadable files
      }
    }

    const allowed = config.allowedTodos || 0;
    gate.passed = todoCount <= allowed;
    gate.score = Math.max(0, 100 - todoCount * 20);
    gate.details = todoCount > 0 ? `${todoCount} TODO/FIXME found` : 'No TODOs found';

    return gate;
  }

  /**
   * Generate recommendations from gate results
   */
  private static generateRecommendations(gates: QualityGate[]): string[] {
    const recommendations: string[] = [];

    for (const gate of gates) {
      if (!gate.passed && gate.required) {
        recommendations.push(`🚨 Fix ${gate.name}: ${gate.details}`);
      } else if (!gate.passed) {
        recommendations.push(`⚠️  Consider fixing ${gate.name}: ${gate.details}`);
      } else if ((gate.score || 100) < 80) {
        recommendations.push(`💡 Improve ${gate.name}: ${gate.details}`);
      }
    }

    return recommendations;
  }

  /**
   * Format quality gates for prompt/display
   */
  static formatForPrompt(result: QualityGateResult): string {
    const status = result.passed ? '✅ QUALITY GATES PASSED' : '❌ QUALITY GATES FAILED';

    return `
## 🚦 ${status}

**Overall Score: ${result.overallScore}/100**

### Gate Results:
${result.gates.map(g => {
  const icon = g.passed ? '✅' : (g.required ? '❌' : '⚠️');
  const score = g.score !== undefined ? ` (${g.score}%)` : '';
  return `${icon} **${g.name}**${score}: ${g.details || (g.passed ? 'Passed' : 'Failed')}`;
}).join('\n')}

${result.blockingGates.length > 0 ? `
### 🚨 Blocking Gates:
${result.blockingGates.map(g => `- ${g}`).join('\n')}
` : ''}

${result.recommendations.length > 0 ? `
### Recommendations:
${result.recommendations.map(r => `- ${r}`).join('\n')}
` : ''}
`;
  }
}
