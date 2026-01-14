/**
 * SemanticVerificationService
 *
 * Automatically analyzes code changes to detect semantic issues BEFORE Judge reviews.
 * This catches anti-patterns that compile but don't work correctly.
 *
 * Examples of issues caught:
 * - Using `new Project()` instead of `createProject()`
 * - Missing required relationships/fields
 * - Incorrect import patterns
 * - Using deprecated APIs
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { CodebaseKnowledge, HelperFunction, EntityCreationRule } from './CodebaseDiscoveryService';

export interface SemanticViolation {
  type: 'anti_pattern' | 'missing_relationship' | 'wrong_import' | 'deprecated_api' | 'incomplete_entity';
  severity: 'error' | 'warning';
  file: string;
  line?: number;
  message: string;
  suggestion: string;
  codeSnippet?: string;
}

export interface VerificationResult {
  passed: boolean;
  violations: SemanticViolation[];
  summary: string;
  autoFixable: SemanticViolation[];
}

export class SemanticVerificationService {
  /**
   * Verify code changes against known patterns
   */
  static async verifyChanges(
    workspacePath: string,
    modifiedFiles: string[],
    codebaseKnowledge?: CodebaseKnowledge
  ): Promise<VerificationResult> {
    console.log(`\n🔬 [SemanticVerification] Analyzing ${modifiedFiles.length} files...`);

    const violations: SemanticViolation[] = [];

    for (const file of modifiedFiles) {
      const fullPath = path.isAbsolute(file) ? file : path.join(workspacePath, file);

      if (!fs.existsSync(fullPath)) {
        console.log(`   ⚠️ File not found: ${file}`);
        continue;
      }

      // Skip non-code files
      if (!file.match(/\.(ts|js|tsx|jsx)$/)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        // Check for anti-patterns if we have codebase knowledge
        if (codebaseKnowledge) {
          const antiPatternViolations = this.checkAntiPatterns(
            file,
            content,
            lines,
            codebaseKnowledge.helperFunctions,
            codebaseKnowledge.entityCreationRules
          );
          violations.push(...antiPatternViolations);
        }

        // Check for common issues regardless of codebase knowledge
        const commonViolations = this.checkCommonIssues(file, content, lines);
        violations.push(...commonViolations);

      } catch (error: any) {
        console.warn(`   ❌ Error analyzing ${file}: ${error.message}`);
      }
    }

    // Categorize violations
    const errors = violations.filter(v => v.severity === 'error');
    const warnings = violations.filter(v => v.severity === 'warning');
    const autoFixable = violations.filter(v => this.isAutoFixable(v));

    const passed = errors.length === 0;

    const summary = passed
      ? `✅ Semantic verification passed (${warnings.length} warnings)`
      : `❌ Semantic verification FAILED: ${errors.length} errors, ${warnings.length} warnings`;

    console.log(`   ${summary}`);

    if (errors.length > 0) {
      console.log(`\n   🔴 ERRORS (must fix):`);
      errors.forEach(e => console.log(`      - ${e.file}: ${e.message}`));
    }

    return {
      passed,
      violations,
      summary,
      autoFixable,
    };
  }

  /**
   * Check for anti-patterns based on discovered codebase knowledge
   */
  private static checkAntiPatterns(
    file: string,
    content: string,
    lines: string[],
    helperFunctions: HelperFunction[],
    entityRules: EntityCreationRule[]
  ): SemanticViolation[] {
    const violations: SemanticViolation[] = [];

    // Check each helper function for anti-pattern usage
    for (const helper of helperFunctions) {
      // Extract entity name from helper (e.g., createProject -> Project)
      const entityName = helper.name.replace(/^create/, '');

      // Check for direct instantiation anti-pattern: new EntityName(
      const antiPattern = new RegExp(`new\\s+${entityName}\\s*\\(`, 'g');
      let match;

      while ((match = antiPattern.exec(content)) !== null) {
        // Find line number
        const beforeMatch = content.substring(0, match.index);
        const lineNum = beforeMatch.split('\n').length;
        const lineContent = lines[lineNum - 1]?.trim() || '';

        // Skip if it's a comment
        if (lineContent.startsWith('//') || lineContent.startsWith('*')) {
          continue;
        }

        // Skip test files - they might legitimately test constructors
        if (file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__')) {
          continue;
        }

        violations.push({
          type: 'anti_pattern',
          severity: 'error',
          file,
          line: lineNum,
          message: `Using \`new ${entityName}()\` instead of \`${helper.name}()\``,
          suggestion: `Replace with: await ${helper.name}(...) from ${helper.file}`,
          codeSnippet: lineContent,
        });
      }
    }

    // Check entity creation rules
    for (const rule of entityRules) {
      if (!rule.mustUse) continue;

      // Check if the entity is being created without the required helper
      const directInstantiation = new RegExp(`new\\s+${rule.entity}\\s*\\(`, 'g');

      if (directInstantiation.test(content)) {
        // Already caught above, but add relationship warning
        if (rule.requiredRelationships && rule.requiredRelationships.length > 0) {
          const lineNum = this.findPatternLine(content, directInstantiation);

          violations.push({
            type: 'missing_relationship',
            severity: 'error',
            file,
            line: lineNum,
            message: `${rule.entity} created without required relationships: ${rule.requiredRelationships.join(', ')}`,
            suggestion: `Use ${rule.mustUse} which sets up: ${rule.requiredRelationships.join(', ')}`,
          });
        }
      }
    }

    return violations;
  }

  /**
   * Check for common semantic issues
   */
  private static checkCommonIssues(
    file: string,
    content: string,
    lines: string[]
  ): SemanticViolation[] {
    const violations: SemanticViolation[] = [];

    // Check for TODO/FIXME left in code
    const todoPattern = /\/\/\s*(TODO|FIXME|XXX|HACK):/gi;
    let match;

    while ((match = todoPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;
      const lineContent = lines[lineNum - 1]?.trim() || '';

      violations.push({
        type: 'incomplete_entity',
        severity: 'warning',
        file,
        line: lineNum,
        message: `Incomplete code: ${match[1]} found`,
        suggestion: 'Complete the implementation or remove the TODO',
        codeSnippet: lineContent,
      });
    }

    // Check for console.log left in production code (not test files)
    if (!file.includes('.test.') && !file.includes('.spec.')) {
      const consolePattern = /console\.(log|debug)\s*\(/g;

      while ((match = consolePattern.exec(content)) !== null) {
        const lineNum = content.substring(0, match.index).split('\n').length;
        const lineContent = lines[lineNum - 1]?.trim() || '';

        // Skip if it's commented out
        if (lineContent.startsWith('//')) continue;

        violations.push({
          type: 'deprecated_api',
          severity: 'warning',
          file,
          line: lineNum,
          message: `Debug console.${match[1]}() left in code`,
          suggestion: 'Use proper logging service or remove debug statements',
          codeSnippet: lineContent,
        });
      }
    }

    // Check for any type usage
    const anyPattern = /:\s*any\b/g;
    let anyCount = 0;

    while ((match = anyPattern.exec(content)) !== null) {
      anyCount++;
      if (anyCount <= 3) { // Only report first 3
        const lineNum = content.substring(0, match.index).split('\n').length;

        violations.push({
          type: 'wrong_import',
          severity: 'warning',
          file,
          line: lineNum,
          message: 'Using `any` type - loses type safety',
          suggestion: 'Use proper type or `unknown` if type is truly dynamic',
        });
      }
    }

    // Check for empty catch blocks
    const emptyCatchPattern = /catch\s*\([^)]*\)\s*\{\s*\}/g;

    while ((match = emptyCatchPattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\n').length;

      violations.push({
        type: 'incomplete_entity',
        severity: 'error',
        file,
        line: lineNum,
        message: 'Empty catch block - errors are silently swallowed',
        suggestion: 'Log the error or rethrow it',
      });
    }

    // Check for hardcoded secrets patterns
    const secretPatterns = [
      /api[_-]?key\s*[:=]\s*['"][^'"]{20,}['"]/gi,
      /password\s*[:=]\s*['"][^'"]+['"]/gi,
      /secret\s*[:=]\s*['"][^'"]{10,}['"]/gi,
      /token\s*[:=]\s*['"][^'"]{20,}['"]/gi,
    ];

    for (const pattern of secretPatterns) {
      if (pattern.test(content)) {
        violations.push({
          type: 'deprecated_api',
          severity: 'error',
          file,
          message: 'Possible hardcoded secret detected',
          suggestion: 'Use environment variables for secrets',
        });
        break; // Only report once per file
      }
    }

    return violations;
  }

  /**
   * Find the line number where a pattern matches
   */
  private static findPatternLine(content: string, pattern: RegExp): number {
    const match = pattern.exec(content);
    if (!match) return 0;

    const beforeMatch = content.substring(0, match.index);
    return beforeMatch.split('\n').length;
  }

  /**
   * Check if a violation can be auto-fixed
   */
  private static isAutoFixable(violation: SemanticViolation): boolean {
    // For now, only simple replacements are auto-fixable
    return violation.type === 'anti_pattern' && violation.suggestion.startsWith('Replace with:');
  }

  /**
   * Get modified files from git diff
   */
  static getModifiedFiles(workspacePath: string, baseBranch: string = 'main'): string[] {
    try {
      const result = execSync(
        `git diff --name-only ${baseBranch}...HEAD 2>/dev/null || git diff --name-only HEAD~5 2>/dev/null || true`,
        { cwd: workspacePath, encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (!result) return [];

      return result.split('\n').filter(f => f && f.match(/\.(ts|js|tsx|jsx)$/));
    } catch {
      return [];
    }
  }

  /**
   * Format violations for Judge prompt injection
   */
  static formatForJudge(result: VerificationResult): string {
    if (result.passed && result.violations.length === 0) {
      return '';
    }

    let output = `
## 🔬 AUTOMATED SEMANTIC VERIFICATION RESULTS

**Status**: ${result.passed ? '⚠️ PASSED WITH WARNINGS' : '❌ FAILED - MUST FIX'}

`;

    const errors = result.violations.filter(v => v.severity === 'error');
    const warnings = result.violations.filter(v => v.severity === 'warning');

    if (errors.length > 0) {
      output += `### 🔴 ERRORS (Blocking - Developer MUST fix these)\n\n`;
      for (const error of errors) {
        output += `- **${error.file}${error.line ? `:${error.line}` : ''}**: ${error.message}\n`;
        output += `  - Fix: ${error.suggestion}\n`;
        if (error.codeSnippet) {
          output += `  - Code: \`${error.codeSnippet.substring(0, 100)}\`\n`;
        }
        output += '\n';
      }
    }

    if (warnings.length > 0) {
      output += `### 🟡 WARNINGS (Should fix)\n\n`;
      for (const warning of warnings.slice(0, 5)) { // Limit to 5 warnings
        output += `- **${warning.file}${warning.line ? `:${warning.line}` : ''}**: ${warning.message}\n`;
      }
      if (warnings.length > 5) {
        output += `\n... and ${warnings.length - 5} more warnings\n`;
      }
    }

    output += `
**Judge Instructions**:
${errors.length > 0 ? '- ❌ REJECT this code - developer must fix the errors above' : '- ✅ Code can be approved if other criteria pass'}
${errors.length > 0 ? '- Include ALL errors in your rejection feedback' : ''}
`;

    return output;
  }

  /**
   * Format violations for Developer retry feedback
   */
  static formatForDeveloper(result: VerificationResult): string {
    if (result.passed) return '';

    let output = `
## 🔴 YOUR CODE HAS SEMANTIC ERRORS - FIX BEFORE CONTINUING

The automated verification found issues that MUST be fixed:

`;

    for (const error of result.violations.filter(v => v.severity === 'error')) {
      output += `### ❌ ${error.file}${error.line ? ` (line ${error.line})` : ''}\n`;
      output += `**Problem**: ${error.message}\n`;
      output += `**Fix**: ${error.suggestion}\n`;
      if (error.codeSnippet) {
        output += `**Your code**: \`${error.codeSnippet}\`\n`;
      }
      output += '\n';
    }

    output += `
⚠️ Do NOT proceed until these are fixed. The Judge will automatically reject code with these errors.
`;

    return output;
  }
}
