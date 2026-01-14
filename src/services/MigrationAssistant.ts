/**
 * MigrationAssistant - Intelligent migration assistance service
 *
 * Assists with code migrations: framework upgrades, API changes,
 * deprecation handling, and breaking change management.
 */

import * as fs from 'fs';
import * as path from 'path';

interface MigrationRule {
  id: string;
  name: string;
  description: string;
  from: string | RegExp;
  to: string | ((match: string, ...groups: string[]) => string);
  filePatterns: string[];
  breaking: boolean;
  manual?: boolean;
  documentation?: string;
}

interface MigrationPlan {
  id: string;
  name: string;
  description: string;
  fromVersion: string;
  toVersion: string;
  rules: MigrationRule[];
  preChecks: string[];
  postChecks: string[];
  estimatedChanges: number;
}

interface FileChange {
  file: string;
  line: number;
  column: number;
  original: string;
  replacement: string;
  ruleId: string;
  ruleName: string;
  breaking: boolean;
  manual: boolean;
}

interface MigrationReport {
  plan: MigrationPlan;
  changes: FileChange[];
  manualSteps: string[];
  warnings: string[];
  breakingChanges: FileChange[];
  estimatedEffort: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface ApplyResult {
  success: boolean;
  appliedChanges: number;
  skippedChanges: number;
  errors: string[];
  backupPath?: string;
}

// Common migration patterns for popular frameworks/libraries
const COMMON_MIGRATIONS: Record<string, MigrationPlan> = {
  'react-17-to-18': {
    id: 'react-17-to-18',
    name: 'React 17 to 18 Migration',
    description: 'Migrate from React 17 to React 18 with concurrent features',
    fromVersion: '17.x',
    toVersion: '18.x',
    rules: [
      {
        id: 'react-dom-render',
        name: 'ReactDOM.render to createRoot',
        description: 'Replace ReactDOM.render with createRoot API',
        from: /ReactDOM\.render\s*\(\s*(<[^,]+>)\s*,\s*([^)]+)\)/g,
        to: 'createRoot($2).render($1)',
        filePatterns: ['*.tsx', '*.jsx', '*.ts', '*.js'],
        breaking: true,
        documentation: 'https://react.dev/blog/2022/03/08/react-18-upgrade-guide'
      },
      {
        id: 'react-dom-import',
        name: 'Import createRoot',
        description: 'Add createRoot import from react-dom/client',
        from: /import\s+ReactDOM\s+from\s+['"]react-dom['"]/g,
        to: "import { createRoot } from 'react-dom/client'",
        filePatterns: ['*.tsx', '*.jsx', '*.ts', '*.js'],
        breaking: false
      },
      {
        id: 'use-effect-cleanup',
        name: 'useEffect cleanup warning',
        description: 'React 18 strict mode runs effects twice',
        from: /useEffect\s*\(\s*\(\)\s*=>\s*\{[^}]*\}\s*,\s*\[\s*\]\s*\)/g,
        to: (match) => match, // No change, just flag
        filePatterns: ['*.tsx', '*.jsx'],
        breaking: false,
        manual: true
      }
    ],
    preChecks: [
      'Ensure all dependencies are compatible with React 18',
      'Check for class component lifecycle methods that may behave differently',
      'Review usage of findDOMNode (deprecated)'
    ],
    postChecks: [
      'Run test suite to verify behavior',
      'Check for hydration warnings in SSR apps',
      'Verify Suspense boundaries work correctly'
    ],
    estimatedChanges: 0
  },
  'express-4-to-5': {
    id: 'express-4-to-5',
    name: 'Express 4 to 5 Migration',
    description: 'Migrate from Express 4 to Express 5',
    fromVersion: '4.x',
    toVersion: '5.x',
    rules: [
      {
        id: 'app-del-to-delete',
        name: 'app.del() to app.delete()',
        description: 'Replace deprecated app.del() with app.delete()',
        from: /app\.del\s*\(/g,
        to: 'app.delete(',
        filePatterns: ['*.ts', '*.js'],
        breaking: true
      },
      {
        id: 'res-send-status',
        name: 'res.send(status) change',
        description: 'res.send(status) no longer sets status code',
        from: /res\.send\s*\(\s*(\d{3})\s*\)/g,
        to: 'res.status($1).send()',
        filePatterns: ['*.ts', '*.js'],
        breaking: true
      },
      {
        id: 'path-regex',
        name: 'Path regex changes',
        description: 'Regular expressions in routes have changed',
        from: /app\.(get|post|put|delete|patch)\s*\(\s*\/[^/]*\([^)]*\)[^,]*/g,
        to: (match) => match,
        filePatterns: ['*.ts', '*.js'],
        breaking: true,
        manual: true
      }
    ],
    preChecks: [
      'Check for usage of removed middleware',
      'Verify path-to-regexp compatibility',
      'Review error handling middleware signatures'
    ],
    postChecks: [
      'Test all route handlers',
      'Verify error handling works correctly',
      'Check middleware execution order'
    ],
    estimatedChanges: 0
  },
  'typescript-4-to-5': {
    id: 'typescript-4-to-5',
    name: 'TypeScript 4 to 5 Migration',
    description: 'Migrate from TypeScript 4.x to 5.x',
    fromVersion: '4.x',
    toVersion: '5.x',
    rules: [
      {
        id: 'decorators-legacy',
        name: 'Legacy decorators',
        description: 'Update decorator syntax or enable experimentalDecorators',
        from: /@(\w+)\s*\n\s*(export\s+)?class/g,
        to: (match) => match,
        filePatterns: ['*.ts'],
        breaking: false,
        manual: true,
        documentation: 'https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/#decorators'
      },
      {
        id: 'enum-narrowing',
        name: 'Enum narrowing changes',
        description: 'TypeScript 5 has stricter enum narrowing',
        from: /if\s*\(\s*\w+\s*===\s*\w+\.\w+\s*\)/g,
        to: (match) => match,
        filePatterns: ['*.ts'],
        breaking: false,
        manual: true
      }
    ],
    preChecks: [
      'Update @types/* packages to latest versions',
      'Check for deprecated compiler options',
      'Review moduleResolution setting'
    ],
    postChecks: [
      'Run tsc --noEmit to check for type errors',
      'Verify build output is correct',
      'Test runtime behavior'
    ],
    estimatedChanges: 0
  },
  'mongoose-6-to-7': {
    id: 'mongoose-6-to-7',
    name: 'Mongoose 6 to 7 Migration',
    description: 'Migrate from Mongoose 6 to 7',
    fromVersion: '6.x',
    toVersion: '7.x',
    rules: [
      {
        id: 'strictquery-default',
        name: 'strictQuery default changed',
        description: 'strictQuery now defaults to false',
        from: /mongoose\.set\s*\(\s*['"]strictQuery['"]\s*,\s*true\s*\)/g,
        to: (match) => match,
        filePatterns: ['*.ts', '*.js'],
        breaking: true,
        manual: true
      },
      {
        id: 'remove-callback',
        name: 'Callback removal',
        description: 'Callbacks are no longer supported, use async/await',
        from: /\.(save|find|findOne|update|delete)\s*\([^)]*,\s*function\s*\(/g,
        to: (match) => match,
        filePatterns: ['*.ts', '*.js'],
        breaking: true,
        manual: true
      }
    ],
    preChecks: [
      'Remove all callback-style Mongoose operations',
      'Check for deprecated schema options',
      'Review index definitions'
    ],
    postChecks: [
      'Test all database operations',
      'Verify schema validations still work',
      'Check query behavior with new defaults'
    ],
    estimatedChanges: 0
  }
};

export class MigrationAssistant {
  private customMigrations: Map<string, MigrationPlan> = new Map();
  private backupDir: string;

  constructor(backupDir: string = '.migration-backups') {
    this.backupDir = backupDir;
  }

  /**
   * List available migration plans
   */
  listAvailableMigrations(): Array<{ id: string; name: string; description: string }> {
    const migrations = [
      ...Object.entries(COMMON_MIGRATIONS).map(([id, plan]) => ({
        id,
        name: plan.name,
        description: plan.description
      })),
      ...Array.from(this.customMigrations.entries()).map(([id, plan]) => ({
        id,
        name: plan.name,
        description: plan.description
      }))
    ];
    return migrations;
  }

  /**
   * Analyze codebase for migration needs
   */
  async analyzeMigration(
    projectPath: string,
    migrationId: string
  ): Promise<MigrationReport> {
    const plan = COMMON_MIGRATIONS[migrationId] || this.customMigrations.get(migrationId);

    if (!plan) {
      throw new Error(`Migration plan not found: ${migrationId}`);
    }

    const changes: FileChange[] = [];
    const manualSteps: string[] = [];
    const warnings: string[] = [];
    const breakingChanges: FileChange[] = [];

    // Collect all files matching patterns
    const files = await this.collectFiles(projectPath, plan.rules);

    // Analyze each file
    for (const file of files) {
      const fileChanges = await this.analyzeFile(file, plan.rules);
      changes.push(...fileChanges);

      for (const change of fileChanges) {
        if (change.breaking) {
          breakingChanges.push(change);
        }
        if (change.manual) {
          const step = `[${change.ruleName}] ${change.file}:${change.line} - Manual review required`;
          if (!manualSteps.includes(step)) {
            manualSteps.push(step);
          }
        }
      }
    }

    // Add pre-checks as warnings
    for (const check of plan.preChecks) {
      warnings.push(`PRE-CHECK: ${check}`);
    }

    // Calculate effort and risk
    const estimatedEffort = this.estimateEffort(changes, manualSteps);
    const riskLevel = this.assessRisk(breakingChanges, manualSteps);

    return {
      plan: { ...plan, estimatedChanges: changes.length },
      changes,
      manualSteps,
      warnings,
      breakingChanges,
      estimatedEffort,
      riskLevel
    };
  }

  /**
   * Apply migration changes automatically
   */
  async applyMigration(
    projectPath: string,
    report: MigrationReport,
    options: {
      dryRun?: boolean;
      skipManual?: boolean;
      createBackup?: boolean;
    } = {}
  ): Promise<ApplyResult> {
    const { dryRun = false, skipManual = true, createBackup = true } = options;
    const errors: string[] = [];
    let appliedChanges = 0;
    let skippedChanges = 0;
    let backupPath: string | undefined;

    // Create backup if requested
    if (createBackup && !dryRun) {
      backupPath = await this.createBackup(projectPath, report);
    }

    // Group changes by file
    const changesByFile = new Map<string, FileChange[]>();
    for (const change of report.changes) {
      if (skipManual && change.manual) {
        skippedChanges++;
        continue;
      }

      const existing = changesByFile.get(change.file) || [];
      existing.push(change);
      changesByFile.set(change.file, existing);
    }

    // Apply changes file by file
    for (const [file, fileChanges] of changesByFile) {
      try {
        if (dryRun) {
          appliedChanges += fileChanges.length;
          continue;
        }

        const applied = await this.applyFileChanges(file, fileChanges);
        appliedChanges += applied;
      } catch (error: any) {
        errors.push(`Error applying changes to ${file}: ${error.message}`);
      }
    }

    return {
      success: errors.length === 0,
      appliedChanges,
      skippedChanges,
      errors,
      backupPath
    };
  }

  /**
   * Create a custom migration plan
   */
  createCustomMigration(plan: MigrationPlan): void {
    this.customMigrations.set(plan.id, plan);
  }

  /**
   * Detect what migrations might be needed based on package.json
   */
  async detectNeededMigrations(projectPath: string): Promise<string[]> {
    const needed: string[] = [];
    const packageJsonPath = path.join(projectPath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      return needed;
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies
      };

      // Check React version
      if (deps.react) {
        const version = this.parseVersion(deps.react);
        if (version.major === 17) {
          needed.push('react-17-to-18');
        }
      }

      // Check Express version
      if (deps.express) {
        const version = this.parseVersion(deps.express);
        if (version.major === 4) {
          needed.push('express-4-to-5');
        }
      }

      // Check TypeScript version
      if (deps.typescript) {
        const version = this.parseVersion(deps.typescript);
        if (version.major === 4) {
          needed.push('typescript-4-to-5');
        }
      }

      // Check Mongoose version
      if (deps.mongoose) {
        const version = this.parseVersion(deps.mongoose);
        if (version.major === 6) {
          needed.push('mongoose-6-to-7');
        }
      }
    } catch {
      // Ignore parsing errors
    }

    return needed;
  }

  /**
   * Generate migration report as markdown
   */
  formatReport(report: MigrationReport): string {
    const lines: string[] = [
      `# Migration Report: ${report.plan.name}`,
      '',
      `**From:** ${report.plan.fromVersion} → **To:** ${report.plan.toVersion}`,
      '',
      `## Summary`,
      '',
      `- **Total Changes:** ${report.changes.length}`,
      `- **Breaking Changes:** ${report.breakingChanges.length}`,
      `- **Manual Steps Required:** ${report.manualSteps.length}`,
      `- **Estimated Effort:** ${report.estimatedEffort}`,
      `- **Risk Level:** ${report.riskLevel.toUpperCase()}`,
      ''
    ];

    if (report.warnings.length > 0) {
      lines.push('## Warnings', '');
      for (const warning of report.warnings) {
        lines.push(`- ⚠️ ${warning}`);
      }
      lines.push('');
    }

    if (report.breakingChanges.length > 0) {
      lines.push('## Breaking Changes', '');
      for (const change of report.breakingChanges) {
        lines.push(`### ${change.file}:${change.line}`);
        lines.push(`- **Rule:** ${change.ruleName}`);
        lines.push(`- **Original:** \`${change.original}\``);
        lines.push(`- **Replacement:** \`${change.replacement}\``);
        lines.push('');
      }
    }

    if (report.manualSteps.length > 0) {
      lines.push('## Manual Steps Required', '');
      for (const step of report.manualSteps) {
        lines.push(`- [ ] ${step}`);
      }
      lines.push('');
    }

    lines.push('## Post-Migration Checklist', '');
    for (const check of report.plan.postChecks) {
      lines.push(`- [ ] ${check}`);
    }

    return lines.join('\n');
  }

  /**
   * Rollback migration from backup
   */
  async rollback(backupPath: string, projectPath: string): Promise<boolean> {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    try {
      const backupFiles = this.getAllFiles(backupPath);

      for (const backupFile of backupFiles) {
        const relativePath = path.relative(backupPath, backupFile);
        const targetPath = path.join(projectPath, relativePath);

        const content = fs.readFileSync(backupFile, 'utf-8');
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, content, 'utf-8');
      }

      return true;
    } catch {
      return false;
    }
  }

  // Private helper methods

  private async collectFiles(projectPath: string, rules: MigrationRule[]): Promise<string[]> {
    const patterns = new Set<string>();
    for (const rule of rules) {
      for (const pattern of rule.filePatterns) {
        patterns.add(pattern);
      }
    }

    const files: string[] = [];
    const allFiles = this.getAllFiles(projectPath);

    for (const file of allFiles) {
      const ext = path.extname(file);
      for (const pattern of patterns) {
        if (pattern.startsWith('*')) {
          if (file.endsWith(pattern.slice(1))) {
            files.push(file);
            break;
          }
        } else if (ext === pattern || file.endsWith(pattern)) {
          files.push(file);
          break;
        }
      }
    }

    return files;
  }

  private getAllFiles(dir: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) return files;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip common directories
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', 'build', '.migration-backups'].includes(entry.name)) {
          continue;
        }
        files.push(...this.getAllFiles(fullPath));
      } else {
        files.push(fullPath);
      }
    }

    return files;
  }

  private async analyzeFile(filePath: string, rules: MigrationRule[]): Promise<FileChange[]> {
    const changes: FileChange[] = [];

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      for (const rule of rules) {
        // Check if file matches pattern
        const ext = path.extname(filePath);
        const matchesPattern = rule.filePatterns.some(pattern => {
          if (pattern.startsWith('*')) {
            return filePath.endsWith(pattern.slice(1));
          }
          return ext === pattern || filePath.endsWith(pattern);
        });

        if (!matchesPattern) continue;

        // Apply rule
        const from = typeof rule.from === 'string'
          ? new RegExp(rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
          : rule.from;

        let match;
        const regex = new RegExp(from.source, from.flags);

        while ((match = regex.exec(content)) !== null) {
          // Find line number
          const beforeMatch = content.slice(0, match.index);
          const lineNumber = beforeMatch.split('\n').length;
          const lineStart = beforeMatch.lastIndexOf('\n') + 1;
          const column = match.index - lineStart;

          // Calculate replacement
          let replacement: string;
          if (typeof rule.to === 'function') {
            replacement = rule.to(match[0], ...match.slice(1));
          } else {
            replacement = match[0].replace(from, rule.to);
          }

          changes.push({
            file: filePath,
            line: lineNumber,
            column,
            original: match[0],
            replacement,
            ruleId: rule.id,
            ruleName: rule.name,
            breaking: rule.breaking,
            manual: rule.manual || false
          });
        }
      }
    } catch {
      // File read error, skip
    }

    return changes;
  }

  private async applyFileChanges(filePath: string, changes: FileChange[]): Promise<number> {
    let content = fs.readFileSync(filePath, 'utf-8');
    let applied = 0;

    // Sort changes by position (reverse order to preserve positions)
    const sortedChanges = [...changes].sort((a, b) => {
      if (a.line !== b.line) return b.line - a.line;
      return b.column - a.column;
    });

    for (const change of sortedChanges) {
      if (change.manual) continue;

      // Simple replacement (could be enhanced with AST-based replacement)
      const newContent = content.replace(change.original, change.replacement);
      if (newContent !== content) {
        content = newContent;
        applied++;
      }
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    return applied;
  }

  private async createBackup(projectPath: string, report: MigrationReport): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `${report.plan.id}-${timestamp}`);

    fs.mkdirSync(backupPath, { recursive: true });

    // Only backup files that will be changed
    const filesToBackup = new Set(report.changes.map(c => c.file));

    for (const file of filesToBackup) {
      const relativePath = path.relative(projectPath, file);
      const backupFile = path.join(backupPath, relativePath);

      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      fs.copyFileSync(file, backupFile);
    }

    return backupPath;
  }

  private parseVersion(versionString: string): { major: number; minor: number; patch: number } {
    // Remove ^ or ~ prefix
    const cleaned = versionString.replace(/^[\^~]/, '');
    const parts = cleaned.split('.').map(p => parseInt(p, 10) || 0);

    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    };
  }

  private estimateEffort(changes: FileChange[], manualSteps: string[]): string {
    const autoChanges = changes.filter(c => !c.manual).length;
    const manualChanges = manualSteps.length;

    if (autoChanges + manualChanges === 0) return 'None';
    if (manualChanges === 0 && autoChanges < 10) return 'Low (< 1 hour)';
    if (manualChanges < 5 && autoChanges < 50) return 'Medium (1-4 hours)';
    if (manualChanges < 20 && autoChanges < 200) return 'High (1-2 days)';
    return 'Very High (> 2 days)';
  }

  private assessRisk(breakingChanges: FileChange[], manualSteps: string[]): 'low' | 'medium' | 'high' | 'critical' {
    const breakingCount = breakingChanges.length;
    const manualCount = manualSteps.length;

    if (breakingCount === 0 && manualCount === 0) return 'low';
    if (breakingCount < 5 && manualCount < 5) return 'medium';
    if (breakingCount < 20 && manualCount < 20) return 'high';
    return 'critical';
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## MigrationAssistant - Code Migration Service

Assists with code migrations including framework upgrades, API changes, and breaking change management.

### Available Migrations
- react-17-to-18: React 17 to 18 with concurrent features
- express-4-to-5: Express.js 4 to 5 migration
- typescript-4-to-5: TypeScript 4.x to 5.x
- mongoose-6-to-7: Mongoose 6 to 7

### Workflow
1. **Detect Needs**: \`detectNeededMigrations(projectPath)\` - Scan package.json for outdated packages
2. **Analyze**: \`analyzeMigration(projectPath, migrationId)\` - Get detailed report
3. **Review**: \`formatReport(report)\` - Generate markdown report
4. **Apply**: \`applyMigration(projectPath, report, options)\` - Apply changes
5. **Rollback**: \`rollback(backupPath, projectPath)\` - Revert if needed

### Options for applyMigration
- dryRun: Preview changes without applying
- skipManual: Skip changes requiring manual review
- createBackup: Create backup before applying

### Best Practices
- Always run in dryRun mode first
- Review all breaking changes before applying
- Complete manual steps after automatic migration
- Run tests after migration
- Keep backup until migration is verified
    `;
  }
}
