/**
 * ProactiveIssueDetector
 *
 * Detects potential issues BEFORE the Developer starts coding.
 * This prevents wasted effort on approaches that won't work.
 *
 * Checks:
 * 1. Files to modify exist
 * 2. Dependencies are installed
 * 3. No conflicting changes in progress
 * 4. Required permissions/access
 * 5. Architecture compatibility
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface PotentialIssue {
  severity: 'blocker' | 'warning' | 'info';
  category: 'file' | 'dependency' | 'conflict' | 'permission' | 'architecture';
  message: string;
  suggestion: string;
  file?: string;
}

export interface PreflightCheckResult {
  canProceed: boolean;
  issues: PotentialIssue[];
  recommendations: string[];
  filesVerified: string[];
  dependenciesChecked: string[];
}

export interface PreflightConfig {
  workspacePath: string;
  filesToModify: string[];
  filesToCreate: string[];
  filesToRead: string[];
  requiredDependencies?: string[];
  storyDescription?: string;
}

export class ProactiveIssueDetector {
  /**
   * Run all preflight checks before Developer starts
   */
  static async runPreflightChecks(config: PreflightConfig): Promise<PreflightCheckResult> {
    console.log(`\n🔍 [Preflight] Running proactive issue detection...`);

    const result: PreflightCheckResult = {
      canProceed: true,
      issues: [],
      recommendations: [],
      filesVerified: [],
      dependenciesChecked: [],
    };

    // 1. Check files to modify exist
    const fileIssues = this.checkFilesExist(config);
    result.issues.push(...fileIssues);
    result.filesVerified = config.filesToModify.filter(f =>
      fs.existsSync(path.join(config.workspacePath, f))
    );

    // 2. Check files to create don't already exist
    const createIssues = this.checkFilesNotExist(config);
    result.issues.push(...createIssues);

    // 3. Check dependencies
    const depIssues = await this.checkDependencies(config);
    result.issues.push(...depIssues);

    // 4. Check for git conflicts
    const gitIssues = this.checkGitStatus(config);
    result.issues.push(...gitIssues);

    // 5. Check directory structure
    const structureIssues = this.checkDirectoryStructure(config);
    result.issues.push(...structureIssues);

    // 6. Analyze story for potential issues
    if (config.storyDescription) {
      const storyIssues = this.analyzeStoryForIssues(config.storyDescription, config);
      result.issues.push(...storyIssues);
    }

    // Determine if we can proceed
    const blockers = result.issues.filter(i => i.severity === 'blocker');
    result.canProceed = blockers.length === 0;

    // Generate recommendations
    result.recommendations = this.generateRecommendations(result.issues);

    console.log(`   ✅ Files verified: ${result.filesVerified.length}`);
    console.log(`   ⚠️  Issues found: ${result.issues.length} (${blockers.length} blockers)`);
    console.log(`   ${result.canProceed ? '✅ Can proceed' : '❌ Cannot proceed - fix blockers first'}`);

    return result;
  }

  /**
   * Check that files to modify exist
   */
  private static checkFilesExist(config: PreflightConfig): PotentialIssue[] {
    const issues: PotentialIssue[] = [];

    for (const file of config.filesToModify) {
      const fullPath = path.join(config.workspacePath, file);

      if (!fs.existsSync(fullPath)) {
        issues.push({
          severity: 'blocker',
          category: 'file',
          message: `File to modify does not exist: ${file}`,
          suggestion: `Create the file first, or check if the path is correct. Try: Glob("**/${path.basename(file)}")`,
          file,
        });
      }
    }

    for (const file of config.filesToRead) {
      const fullPath = path.join(config.workspacePath, file);

      if (!fs.existsSync(fullPath)) {
        issues.push({
          severity: 'warning',
          category: 'file',
          message: `File to read does not exist: ${file}`,
          suggestion: `This file might have a different path. Search for it: Glob("**/${path.basename(file)}")`,
          file,
        });
      }
    }

    return issues;
  }

  /**
   * Check that files to create don't already exist
   */
  private static checkFilesNotExist(config: PreflightConfig): PotentialIssue[] {
    const issues: PotentialIssue[] = [];

    for (const file of config.filesToCreate) {
      const fullPath = path.join(config.workspacePath, file);

      if (fs.existsSync(fullPath)) {
        issues.push({
          severity: 'warning',
          category: 'file',
          message: `File to create already exists: ${file}`,
          suggestion: `Either modify the existing file instead of creating, or use a different name`,
          file,
        });
      }

      // Check parent directory exists
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        issues.push({
          severity: 'info',
          category: 'file',
          message: `Parent directory doesn't exist for: ${file}`,
          suggestion: `Will need to create directory: mkdir -p ${path.dirname(file)}`,
          file,
        });
      }
    }

    return issues;
  }

  /**
   * Check dependencies are installed
   */
  private static async checkDependencies(config: PreflightConfig): Promise<PotentialIssue[]> {
    const issues: PotentialIssue[] = [];

    // Check node_modules exists
    const nodeModulesPath = path.join(config.workspacePath, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      issues.push({
        severity: 'blocker',
        category: 'dependency',
        message: 'node_modules not found - dependencies not installed',
        suggestion: 'Run: npm install',
      });
      return issues; // Can't check further without node_modules
    }

    // Check specific dependencies if provided
    for (const dep of config.requiredDependencies || []) {
      const depPath = path.join(nodeModulesPath, dep);
      if (!fs.existsSync(depPath)) {
        issues.push({
          severity: 'warning',
          category: 'dependency',
          message: `Required dependency not installed: ${dep}`,
          suggestion: `Run: npm install ${dep}`,
        });
      }
    }

    // Check package.json for common issues
    const packageJsonPath = path.join(config.workspacePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

        // Check for TypeScript if .ts files are being modified
        const hasTypeScript = config.filesToModify.some(f => f.endsWith('.ts') || f.endsWith('.tsx'));
        if (hasTypeScript && !packageJson.devDependencies?.typescript && !packageJson.dependencies?.typescript) {
          issues.push({
            severity: 'warning',
            category: 'dependency',
            message: 'TypeScript files detected but typescript not in dependencies',
            suggestion: 'Verify TypeScript is installed: npm install -D typescript',
          });
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return issues;
  }

  /**
   * Check git status for conflicts or uncommitted changes
   */
  private static checkGitStatus(config: PreflightConfig): PotentialIssue[] {
    const issues: PotentialIssue[] = [];

    try {
      // Check for uncommitted changes
      const status = execSync('git status --porcelain', {
        cwd: config.workspacePath,
        encoding: 'utf8',
        timeout: 5000,
      }).trim();

      if (status) {
        const lines = status.split('\n');
        const conflicts = lines.filter(l => l.startsWith('UU') || l.startsWith('AA'));
        const uncommitted = lines.filter(l => l.startsWith('M') || l.startsWith('A'));

        if (conflicts.length > 0) {
          issues.push({
            severity: 'blocker',
            category: 'conflict',
            message: `Git merge conflicts detected: ${conflicts.length} files`,
            suggestion: 'Resolve conflicts before proceeding: git status, then fix and git add',
          });
        }

        if (uncommitted.length > 5) {
          issues.push({
            severity: 'warning',
            category: 'conflict',
            message: `Many uncommitted changes: ${uncommitted.length} files`,
            suggestion: 'Consider committing or stashing changes before making more',
          });
        }
      }

      // Check if files to modify have uncommitted changes
      for (const file of config.filesToModify) {
        if (status.includes(file)) {
          issues.push({
            severity: 'warning',
            category: 'conflict',
            message: `File has uncommitted changes: ${file}`,
            suggestion: 'Commit or stash changes to this file first to avoid conflicts',
            file,
          });
        }
      }
    } catch {
      // Not a git repo or git not available
    }

    return issues;
  }

  /**
   * Check directory structure makes sense
   */
  private static checkDirectoryStructure(config: PreflightConfig): PotentialIssue[] {
    const issues: PotentialIssue[] = [];

    // Check for common directory patterns
    const allFiles = [...config.filesToModify, ...config.filesToCreate];

    for (const file of allFiles) {
      // Check for tests going in wrong place
      if (file.includes('.test.') || file.includes('.spec.')) {
        if (!file.includes('test') && !file.includes('__tests__') && !file.includes('spec')) {
          issues.push({
            severity: 'info',
            category: 'architecture',
            message: `Test file might be in wrong location: ${file}`,
            suggestion: 'Consider placing tests in __tests__ folder or alongside source with .test.ts extension',
            file,
          });
        }
      }

      // Check for services going in wrong place
      if (file.toLowerCase().includes('service') && !file.includes('services/')) {
        issues.push({
          severity: 'info',
          category: 'architecture',
          message: `Service file might belong in services/ folder: ${file}`,
          suggestion: 'Check project structure for where services should go',
          file,
        });
      }
    }

    return issues;
  }

  /**
   * Analyze story description for potential issues
   */
  private static analyzeStoryForIssues(description: string, config: PreflightConfig): PotentialIssue[] {
    const issues: PotentialIssue[] = [];
    const lowerDesc = description.toLowerCase();

    // Check for database-related work without models
    if ((lowerDesc.includes('database') || lowerDesc.includes('mongodb') || lowerDesc.includes('schema')) &&
        !config.filesToModify.some(f => f.includes('model'))) {
      issues.push({
        severity: 'info',
        category: 'architecture',
        message: 'Story mentions database but no model files in scope',
        suggestion: 'Check if model files need to be modified for this story',
      });
    }

    // Check for API work without routes
    if ((lowerDesc.includes('api') || lowerDesc.includes('endpoint') || lowerDesc.includes('route')) &&
        !config.filesToModify.some(f => f.includes('route'))) {
      issues.push({
        severity: 'info',
        category: 'architecture',
        message: 'Story mentions API but no route files in scope',
        suggestion: 'Check if route files need to be modified for this story',
      });
    }

    // Check for auth work
    if (lowerDesc.includes('auth') || lowerDesc.includes('login') || lowerDesc.includes('permission')) {
      issues.push({
        severity: 'info',
        category: 'architecture',
        message: 'Story involves authentication - extra security review recommended',
        suggestion: 'Ensure proper authentication patterns are used, no secrets hardcoded',
      });
    }

    return issues;
  }

  /**
   * Generate recommendations based on issues
   */
  private static generateRecommendations(issues: PotentialIssue[]): string[] {
    const recommendations: string[] = [];

    const blockers = issues.filter(i => i.severity === 'blocker');
    const warnings = issues.filter(i => i.severity === 'warning');

    if (blockers.length > 0) {
      recommendations.push(`🚨 Fix ${blockers.length} blocker(s) before starting`);
      blockers.forEach(b => recommendations.push(`   - ${b.suggestion}`));
    }

    if (warnings.length > 0) {
      recommendations.push(`⚠️  Address ${warnings.length} warning(s) to avoid issues`);
    }

    if (issues.some(i => i.category === 'file')) {
      recommendations.push('📁 Verify file paths with Glob before editing');
    }

    if (issues.some(i => i.category === 'dependency')) {
      recommendations.push('📦 Run npm install to ensure dependencies are up to date');
    }

    if (issues.some(i => i.category === 'conflict')) {
      recommendations.push('🌿 Clean git status before making changes');
    }

    return recommendations;
  }

  /**
   * Format preflight results for Developer prompt
   */
  static formatForPrompt(result: PreflightCheckResult): string {
    if (result.issues.length === 0) {
      return `
## ✅ PREFLIGHT CHECK PASSED

All files verified, dependencies checked, no conflicts detected.
Proceed with implementation.
`;
    }

    const blockers = result.issues.filter(i => i.severity === 'blocker');
    const warnings = result.issues.filter(i => i.severity === 'warning');
    const infos = result.issues.filter(i => i.severity === 'info');

    let output = `
## ${result.canProceed ? '⚠️ PREFLIGHT CHECK: WARNINGS' : '🚨 PREFLIGHT CHECK: BLOCKERS FOUND'}

`;

    if (blockers.length > 0) {
      output += `### 🚨 BLOCKERS (Must fix before proceeding!)
${blockers.map(b => `- **${b.message}**
  → ${b.suggestion}`).join('\n')}

`;
    }

    if (warnings.length > 0) {
      output += `### ⚠️ WARNINGS (Should address)
${warnings.map(w => `- ${w.message}
  → ${w.suggestion}`).join('\n')}

`;
    }

    if (infos.length > 0) {
      output += `### ℹ️ INFO (Good to know)
${infos.map(i => `- ${i.message}`).join('\n')}

`;
    }

    if (result.recommendations.length > 0) {
      output += `### 📋 RECOMMENDATIONS
${result.recommendations.map(r => `- ${r}`).join('\n')}
`;
    }

    return output;
  }
}
