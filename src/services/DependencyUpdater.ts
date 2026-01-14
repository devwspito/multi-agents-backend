/**
 * DependencyUpdater - Intelligent dependency update service
 *
 * Analyzes and manages dependency updates with risk assessment,
 * compatibility checking, and safe update strategies.
 */

import * as fs from 'fs';
import * as path from 'path';

interface DependencyInfo {
  name: string;
  currentVersion: string;
  latestVersion: string;
  wantedVersion: string;
  updateType: UpdateType;
  hasBreakingChanges: boolean;
  securityAdvisories: SecurityAdvisory[];
  riskLevel: RiskLevel;
  changelog?: string;
  releaseDate?: string;
  downloads?: number;
}

type UpdateType = 'major' | 'minor' | 'patch' | 'prerelease' | 'current';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

interface SecurityAdvisory {
  id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  fixedIn: string;
  url: string;
}

interface UpdatePlan {
  phase: number;
  dependencies: DependencyInfo[];
  riskLevel: RiskLevel;
  estimatedImpact: string;
  testRequirements: string[];
  rollbackStrategy: string;
}

interface UpdateReport {
  summary: {
    totalDependencies: number;
    outdated: number;
    securityIssues: number;
    majorUpdates: number;
    minorUpdates: number;
    patchUpdates: number;
  };
  dependencies: DependencyInfo[];
  updatePlan: UpdatePlan[];
  recommendations: string[];
  incompatibilities: Incompatibility[];
}

interface Incompatibility {
  package1: string;
  package2: string;
  reason: string;
  resolution?: string;
}

interface UpdateResult {
  success: boolean;
  updatedPackages: string[];
  failedPackages: string[];
  errors: string[];
  backupPath?: string;
}

// Known breaking changes in popular packages
const KNOWN_BREAKING_CHANGES: Record<string, Record<string, string[]>> = {
  'react': {
    '18': [
      'ReactDOM.render replaced with createRoot',
      'Automatic batching changes',
      'Strict mode runs effects twice'
    ],
    '17': [
      'Event pooling removed',
      'New JSX transform'
    ]
  },
  'typescript': {
    '5': [
      'Decorator changes',
      'Enum narrowing stricter',
      'Module resolution changes'
    ]
  },
  'express': {
    '5': [
      'app.del() removed',
      'Path regex changes',
      'Promise rejection handling'
    ]
  },
  'mongoose': {
    '7': [
      'Callbacks removed',
      'strictQuery default changed',
      'Schema options changes'
    ],
    '8': [
      'ObjectId string cast stricter',
      'Query middleware changes'
    ]
  },
  'next': {
    '13': [
      'App router introduction',
      'Image component changes',
      'Font optimization changes'
    ],
    '14': [
      'Server actions stable',
      'Metadata API changes'
    ]
  },
  'node': {
    '18': [
      'fetch API built-in',
      'test runner built-in',
      'Watch mode'
    ],
    '20': [
      'Permission model',
      'Single executable apps',
      'Stable test runner'
    ]
  },
  '@types/node': {
    '18': ['Type changes for Node 18 APIs'],
    '20': ['Type changes for Node 20 APIs']
  }
};

// Known compatible version ranges
const COMPATIBILITY_MATRIX: Record<string, Record<string, string>> = {
  'react': {
    'react-dom': 'same',
    '@types/react': 'compatible',
    'react-router-dom': '>=6.0.0',
    'redux': '>=4.0.0'
  },
  'typescript': {
    '@types/node': '>=18.0.0',
    'ts-node': '>=10.0.0'
  },
  'next': {
    'react': '>=18.0.0',
    'react-dom': '>=18.0.0'
  },
  '@angular/core': {
    '@angular/common': 'same',
    '@angular/compiler': 'same',
    'rxjs': '>=7.0.0',
    'zone.js': '>=0.11.0'
  }
};

export class DependencyUpdater {
  private packageJsonPath: string = '';
  private backupDir: string;

  constructor(backupDir: string = '.dependency-backups') {
    this.backupDir = backupDir;
  }

  /**
   * Analyze dependencies for updates
   */
  async analyzeUpdates(projectPath: string): Promise<UpdateReport> {
    this.packageJsonPath = path.join(projectPath, 'package.json');

    if (!fs.existsSync(this.packageJsonPath)) {
      throw new Error('package.json not found');
    }

    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf-8'));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    const dependencies: DependencyInfo[] = [];

    for (const [name, version] of Object.entries(allDeps)) {
      const info = await this.analyzeDependency(name, version as string, projectPath);
      dependencies.push(info);
    }

    // Check for incompatibilities
    const incompatibilities = this.checkIncompatibilities(dependencies);

    // Generate update plan
    const updatePlan = this.generateUpdatePlan(dependencies);

    // Generate recommendations
    const recommendations = this.generateRecommendations(dependencies, incompatibilities);

    // Calculate summary
    const outdated = dependencies.filter(d => d.updateType !== 'current');
    const securityIssues = dependencies.filter(d => d.securityAdvisories.length > 0);

    return {
      summary: {
        totalDependencies: dependencies.length,
        outdated: outdated.length,
        securityIssues: securityIssues.length,
        majorUpdates: dependencies.filter(d => d.updateType === 'major').length,
        minorUpdates: dependencies.filter(d => d.updateType === 'minor').length,
        patchUpdates: dependencies.filter(d => d.updateType === 'patch').length
      },
      dependencies,
      updatePlan,
      recommendations,
      incompatibilities
    };
  }

  /**
   * Analyze a single dependency
   */
  async analyzeDependency(
    name: string,
    currentVersionSpec: string,
    projectPath: string
  ): Promise<DependencyInfo> {
    // Get actual installed version
    const installedVersion = this.getInstalledVersion(name, projectPath);
    const currentVersion = installedVersion || this.parseVersionSpec(currentVersionSpec);

    // Get latest version (would normally call npm registry)
    const latestVersion = this.getLatestVersion(name, currentVersion);
    const wantedVersion = this.getWantedVersion(currentVersionSpec, latestVersion);

    // Determine update type
    const updateType = this.determineUpdateType(currentVersion, latestVersion);

    // Check for breaking changes
    const hasBreakingChanges = this.hasBreakingChanges(name, currentVersion, latestVersion);

    // Check security advisories (simulated)
    const securityAdvisories = this.getSecurityAdvisories(name, currentVersion);

    // Assess risk
    const riskLevel = this.assessRisk(updateType, hasBreakingChanges, securityAdvisories);

    return {
      name,
      currentVersion,
      latestVersion,
      wantedVersion,
      updateType,
      hasBreakingChanges,
      securityAdvisories,
      riskLevel
    };
  }

  /**
   * Generate safe update plan
   */
  generateUpdatePlan(dependencies: DependencyInfo[]): UpdatePlan[] {
    const plan: UpdatePlan[] = [];

    // Phase 1: Security patches (critical)
    const securityUpdates = dependencies.filter(
      d => d.securityAdvisories.some(a => a.severity === 'critical' || a.severity === 'high')
    );
    if (securityUpdates.length > 0) {
      plan.push({
        phase: 1,
        dependencies: securityUpdates,
        riskLevel: 'high',
        estimatedImpact: 'Security vulnerabilities will be fixed',
        testRequirements: [
          'Run full test suite',
          'Verify security-sensitive functionality',
          'Check for regression'
        ],
        rollbackStrategy: 'Restore package.json and lock file from backup'
      });
    }

    // Phase 2: Patch updates (low risk)
    const patchUpdates = dependencies.filter(
      d => d.updateType === 'patch' && !securityUpdates.includes(d)
    );
    if (patchUpdates.length > 0) {
      plan.push({
        phase: 2,
        dependencies: patchUpdates,
        riskLevel: 'low',
        estimatedImpact: 'Bug fixes, minimal changes',
        testRequirements: [
          'Run unit tests',
          'Smoke test main functionality'
        ],
        rollbackStrategy: 'npm install with previous lock file'
      });
    }

    // Phase 3: Minor updates (medium risk)
    const minorUpdates = dependencies.filter(d => d.updateType === 'minor');
    if (minorUpdates.length > 0) {
      plan.push({
        phase: 3,
        dependencies: minorUpdates,
        riskLevel: 'medium',
        estimatedImpact: 'New features, possible deprecation warnings',
        testRequirements: [
          'Run full test suite',
          'Manual testing of affected features',
          'Check for deprecation warnings'
        ],
        rollbackStrategy: 'Restore from backup, clear node_modules'
      });
    }

    // Phase 4: Major updates (high risk)
    const majorUpdates = dependencies.filter(d => d.updateType === 'major');
    if (majorUpdates.length > 0) {
      // Group by risk and dependencies
      const lowRiskMajor = majorUpdates.filter(d => !d.hasBreakingChanges);
      const highRiskMajor = majorUpdates.filter(d => d.hasBreakingChanges);

      if (lowRiskMajor.length > 0) {
        plan.push({
          phase: 4,
          dependencies: lowRiskMajor,
          riskLevel: 'medium',
          estimatedImpact: 'Major version bump but no known breaking changes',
          testRequirements: [
            'Run full test suite',
            'Integration testing',
            'Review changelog'
          ],
          rollbackStrategy: 'Restore full backup'
        });
      }

      if (highRiskMajor.length > 0) {
        plan.push({
          phase: 5,
          dependencies: highRiskMajor,
          riskLevel: 'high',
          estimatedImpact: 'Breaking changes - code modifications likely required',
          testRequirements: [
            'Run full test suite',
            'Review all breaking changes',
            'Update code as needed',
            'End-to-end testing',
            'Performance testing'
          ],
          rollbackStrategy: 'Git branch strategy - update in separate branch'
        });
      }
    }

    return plan;
  }

  /**
   * Apply updates from plan
   */
  async applyUpdates(
    projectPath: string,
    plan: UpdatePlan,
    options: {
      dryRun?: boolean;
      createBackup?: boolean;
      runTests?: boolean;
    } = {}
  ): Promise<UpdateResult> {
    const { dryRun = false, createBackup = true } = options;
    const errors: string[] = [];
    const updatedPackages: string[] = [];
    const failedPackages: string[] = [];
    let backupPath: string | undefined;

    if (dryRun) {
      return {
        success: true,
        updatedPackages: plan.dependencies.map(d => d.name),
        failedPackages: [],
        errors: []
      };
    }

    // Create backup
    if (createBackup) {
      backupPath = await this.createBackup(projectPath);
    }

    // Read and update package.json
    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf-8'));

    for (const dep of plan.dependencies) {
      try {
        const targetVersion = `^${dep.latestVersion}`;

        if (packageJson.dependencies?.[dep.name]) {
          packageJson.dependencies[dep.name] = targetVersion;
          updatedPackages.push(dep.name);
        } else if (packageJson.devDependencies?.[dep.name]) {
          packageJson.devDependencies[dep.name] = targetVersion;
          updatedPackages.push(dep.name);
        } else {
          failedPackages.push(dep.name);
          errors.push(`${dep.name}: Not found in package.json`);
        }
      } catch (error: any) {
        failedPackages.push(dep.name);
        errors.push(`${dep.name}: ${error.message}`);
      }
    }

    // Write updated package.json
    if (updatedPackages.length > 0) {
      fs.writeFileSync(
        this.packageJsonPath,
        JSON.stringify(packageJson, null, 2) + '\n'
      );
    }

    return {
      success: errors.length === 0,
      updatedPackages,
      failedPackages,
      errors,
      backupPath
    };
  }

  /**
   * Check for known incompatibilities
   */
  checkIncompatibilities(dependencies: DependencyInfo[]): Incompatibility[] {
    const incompatibilities: Incompatibility[] = [];
    const depMap = new Map(dependencies.map(d => [d.name, d]));

    for (const [pkg, compatDeps] of Object.entries(COMPATIBILITY_MATRIX)) {
      const pkgInfo = depMap.get(pkg);
      if (!pkgInfo) continue;

      for (const [compatPkg, requirement] of Object.entries(compatDeps)) {
        const compatInfo = depMap.get(compatPkg);
        if (!compatInfo) continue;

        if (requirement === 'same') {
          // Must be same version
          if (pkgInfo.latestVersion !== compatInfo.latestVersion) {
            incompatibilities.push({
              package1: pkg,
              package2: compatPkg,
              reason: `${pkg} and ${compatPkg} should be the same version`,
              resolution: `Update both to ${pkgInfo.latestVersion}`
            });
          }
        } else if (requirement === 'compatible') {
          // Check major version compatibility
          const pkgMajor = parseInt(pkgInfo.latestVersion.split('.')[0]);
          const compatMajor = parseInt(compatInfo.latestVersion.split('.')[0]);
          if (Math.abs(pkgMajor - compatMajor) > 1) {
            incompatibilities.push({
              package1: pkg,
              package2: compatPkg,
              reason: `${pkg}@${pkgInfo.latestVersion} may not be compatible with ${compatPkg}@${compatInfo.latestVersion}`,
              resolution: 'Check type compatibility'
            });
          }
        } else if (requirement.startsWith('>=')) {
          // Minimum version requirement
          const minVersion = requirement.slice(2);
          if (this.compareVersions(compatInfo.latestVersion, minVersion) < 0) {
            incompatibilities.push({
              package1: pkg,
              package2: compatPkg,
              reason: `${pkg} requires ${compatPkg} ${requirement}`,
              resolution: `Update ${compatPkg} to at least ${minVersion}`
            });
          }
        }
      }
    }

    // Check for peer dependency issues
    for (const dep of dependencies) {
      if (dep.name.startsWith('@types/')) {
        const basePkg = dep.name.replace('@types/', '');
        const baseInfo = depMap.get(basePkg);
        if (baseInfo) {
          const typesMajor = parseInt(dep.latestVersion.split('.')[0]);
          const baseMajor = parseInt(baseInfo.latestVersion.split('.')[0]);
          if (typesMajor !== baseMajor) {
            incompatibilities.push({
              package1: dep.name,
              package2: basePkg,
              reason: `Type definitions major version (${typesMajor}) doesn't match package (${baseMajor})`,
              resolution: `Update ${dep.name} to match ${basePkg} version`
            });
          }
        }
      }
    }

    return incompatibilities;
  }

  /**
   * Format report as markdown
   */
  formatReport(report: UpdateReport): string {
    const lines: string[] = [
      '# Dependency Update Report',
      '',
      '## Summary',
      '',
      `- **Total Dependencies:** ${report.summary.totalDependencies}`,
      `- **Outdated:** ${report.summary.outdated}`,
      `- **Security Issues:** ${report.summary.securityIssues}`,
      `- **Major Updates:** ${report.summary.majorUpdates}`,
      `- **Minor Updates:** ${report.summary.minorUpdates}`,
      `- **Patch Updates:** ${report.summary.patchUpdates}`,
      ''
    ];

    // Security issues first
    const securityDeps = report.dependencies.filter(d => d.securityAdvisories.length > 0);
    if (securityDeps.length > 0) {
      lines.push('## Security Vulnerabilities', '');
      for (const dep of securityDeps) {
        lines.push(`### ${dep.name}`);
        for (const advisory of dep.securityAdvisories) {
          lines.push(`- **${advisory.severity.toUpperCase()}**: ${advisory.title}`);
          lines.push(`  - Fixed in: ${advisory.fixedIn}`);
        }
        lines.push('');
      }
    }

    // Update plan
    if (report.updatePlan.length > 0) {
      lines.push('## Update Plan', '');
      for (const phase of report.updatePlan) {
        lines.push(`### Phase ${phase.phase} (${phase.riskLevel} risk)`);
        lines.push('');
        lines.push('| Package | Current | Latest | Type |');
        lines.push('|---------|---------|--------|------|');
        for (const dep of phase.dependencies) {
          lines.push(
            `| ${dep.name} | ${dep.currentVersion} | ${dep.latestVersion} | ${dep.updateType} |`
          );
        }
        lines.push('');
        lines.push(`**Impact:** ${phase.estimatedImpact}`);
        lines.push('');
        lines.push('**Test Requirements:**');
        for (const req of phase.testRequirements) {
          lines.push(`- ${req}`);
        }
        lines.push('');
      }
    }

    // Breaking changes
    const breakingDeps = report.dependencies.filter(d => d.hasBreakingChanges);
    if (breakingDeps.length > 0) {
      lines.push('## Known Breaking Changes', '');
      for (const dep of breakingDeps) {
        const majorVersion = dep.latestVersion.split('.')[0];
        const changes = KNOWN_BREAKING_CHANGES[dep.name]?.[majorVersion];
        if (changes) {
          lines.push(`### ${dep.name} → v${majorVersion}`);
          for (const change of changes) {
            lines.push(`- ${change}`);
          }
          lines.push('');
        }
      }
    }

    // Incompatibilities
    if (report.incompatibilities.length > 0) {
      lines.push('## Potential Incompatibilities', '');
      for (const inc of report.incompatibilities) {
        lines.push(`- **${inc.package1}** ↔ **${inc.package2}**: ${inc.reason}`);
        if (inc.resolution) {
          lines.push(`  - Resolution: ${inc.resolution}`);
        }
      }
      lines.push('');
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push('## Recommendations', '');
      for (const rec of report.recommendations) {
        lines.push(`- ${rec}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupPath: string, projectPath: string): Promise<boolean> {
    try {
      const backupPkgJson = path.join(backupPath, 'package.json');
      const backupLockFile = path.join(backupPath, 'package-lock.json');

      if (fs.existsSync(backupPkgJson)) {
        fs.copyFileSync(backupPkgJson, path.join(projectPath, 'package.json'));
      }

      if (fs.existsSync(backupLockFile)) {
        fs.copyFileSync(backupLockFile, path.join(projectPath, 'package-lock.json'));
      }

      return true;
    } catch {
      return false;
    }
  }

  // Private helper methods

  private findLockFile(projectPath: string): string {
    const lockFiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
    for (const file of lockFiles) {
      const fullPath = path.join(projectPath, file);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
    return '';
  }

  private getInstalledVersion(name: string, projectPath: string): string {
    const pkgJsonPath = path.join(projectPath, 'node_modules', name, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        return pkgJson.version;
      } catch {
        // Ignore
      }
    }
    return '';
  }

  private parseVersionSpec(spec: string): string {
    // Remove ^ or ~ prefix and any range operators
    return spec.replace(/^[\^~>=<]+/, '').split(' ')[0];
  }

  private getLatestVersion(_name: string, currentVersion: string): string {
    // In a real implementation, this would call npm registry
    // For simulation, we'll increment the version
    const parts = currentVersion.split('.').map(p => parseInt(p) || 0);

    // Simulate some updates
    const hasUpdate = Math.random() > 0.3;
    if (hasUpdate) {
      const updateType = Math.random();
      if (updateType > 0.8) {
        parts[0]++; // Major
        parts[1] = 0;
        parts[2] = 0;
      } else if (updateType > 0.5) {
        parts[1]++; // Minor
        parts[2] = 0;
      } else {
        parts[2]++; // Patch
      }
    }

    return parts.join('.');
  }

  private getWantedVersion(spec: string, latestVersion: string): string {
    if (spec.startsWith('^')) {
      // Caret: allow minor and patch updates
      const current = this.parseVersionSpec(spec);
      const currentMajor = current.split('.')[0];
      const latestMajor = latestVersion.split('.')[0];
      if (currentMajor === latestMajor) {
        return latestVersion;
      }
      return current;
    } else if (spec.startsWith('~')) {
      // Tilde: allow patch updates only
      const current = this.parseVersionSpec(spec);
      const currentMinor = current.split('.').slice(0, 2).join('.');
      const latestMinor = latestVersion.split('.').slice(0, 2).join('.');
      if (currentMinor === latestMinor) {
        return latestVersion;
      }
      return current;
    }
    return this.parseVersionSpec(spec);
  }

  private determineUpdateType(current: string, latest: string): UpdateType {
    const currentParts = current.split('.').map(p => parseInt(p) || 0);
    const latestParts = latest.split('.').map(p => parseInt(p) || 0);

    if (current === latest) return 'current';
    if (latestParts[0] > currentParts[0]) return 'major';
    if (latestParts[1] > currentParts[1]) return 'minor';
    if (latestParts[2] > currentParts[2]) return 'patch';
    if (latest.includes('-')) return 'prerelease';
    return 'current';
  }

  private hasBreakingChanges(name: string, current: string, latest: string): boolean {
    const currentMajor = current.split('.')[0];
    const latestMajor = latest.split('.')[0];

    if (currentMajor === latestMajor) return false;

    // Check known breaking changes
    const knownChanges = KNOWN_BREAKING_CHANGES[name];
    if (knownChanges && knownChanges[latestMajor]) {
      return true;
    }

    // Major version bump generally implies breaking changes
    return parseInt(latestMajor) > parseInt(currentMajor);
  }

  private getSecurityAdvisories(name: string, version: string): SecurityAdvisory[] {
    // In a real implementation, this would query npm audit or similar
    // For simulation, we'll return empty for most packages
    const advisories: SecurityAdvisory[] = [];

    // Simulate some known vulnerabilities
    if (name === 'lodash' && this.compareVersions(version, '4.17.21') < 0) {
      advisories.push({
        id: 'GHSA-x5rq-j2xg-h7qm',
        severity: 'high',
        title: 'Prototype Pollution in lodash',
        fixedIn: '4.17.21',
        url: 'https://github.com/advisories/GHSA-x5rq-j2xg-h7qm'
      });
    }

    if (name === 'axios' && this.compareVersions(version, '1.6.0') < 0) {
      advisories.push({
        id: 'CVE-2023-45857',
        severity: 'moderate',
        title: 'Cross-Site Request Forgery in axios',
        fixedIn: '1.6.0',
        url: 'https://nvd.nist.gov/vuln/detail/CVE-2023-45857'
      });
    }

    return advisories;
  }

  private assessRisk(
    updateType: UpdateType,
    hasBreakingChanges: boolean,
    securityAdvisories: SecurityAdvisory[]
  ): RiskLevel {
    // Security issues increase risk
    if (securityAdvisories.some(a => a.severity === 'critical')) {
      return 'critical';
    }

    if (hasBreakingChanges) {
      return 'high';
    }

    if (updateType === 'major') {
      return 'high';
    }

    if (updateType === 'minor' || securityAdvisories.length > 0) {
      return 'medium';
    }

    return 'low';
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(p => parseInt(p) || 0);
    const parts2 = v2.split('.').map(p => parseInt(p) || 0);

    for (let i = 0; i < 3; i++) {
      if ((parts1[i] || 0) < (parts2[i] || 0)) return -1;
      if ((parts1[i] || 0) > (parts2[i] || 0)) return 1;
    }

    return 0;
  }

  private generateRecommendations(
    dependencies: DependencyInfo[],
    incompatibilities: Incompatibility[]
  ): string[] {
    const recommendations: string[] = [];

    // Security first
    const criticalSecurity = dependencies.filter(
      d => d.securityAdvisories.some(a => a.severity === 'critical')
    );
    if (criticalSecurity.length > 0) {
      recommendations.push(
        `URGENT: ${criticalSecurity.length} package(s) have critical security vulnerabilities`
      );
    }

    // Outdated major versions
    const majorOutdated = dependencies.filter(d => d.updateType === 'major');
    if (majorOutdated.length > 3) {
      recommendations.push(
        `Consider updating major versions gradually - ${majorOutdated.length} packages are multiple versions behind`
      );
    }

    // Incompatibilities
    if (incompatibilities.length > 0) {
      recommendations.push(
        `Resolve ${incompatibilities.length} dependency incompatibilities before updating`
      );
    }

    // Type definitions
    const typesDeps = dependencies.filter(d => d.name.startsWith('@types/'));
    const outdatedTypes = typesDeps.filter(d => d.updateType !== 'current');
    if (outdatedTypes.length > 0) {
      recommendations.push(
        `Update ${outdatedTypes.length} @types/* packages to match their corresponding packages`
      );
    }

    // General advice
    if (majorOutdated.length > 0) {
      recommendations.push('Create a separate branch for major updates to allow thorough testing');
    }

    recommendations.push('Run full test suite after each update phase');
    recommendations.push('Review changelogs for packages with breaking changes');

    return recommendations;
  }

  private async createBackup(projectPath: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `backup-${timestamp}`);

    fs.mkdirSync(backupPath, { recursive: true });

    // Backup package.json
    fs.copyFileSync(
      path.join(projectPath, 'package.json'),
      path.join(backupPath, 'package.json')
    );

    // Backup lock file if exists
    const lockFile = this.findLockFile(projectPath);
    if (lockFile) {
      fs.copyFileSync(
        lockFile,
        path.join(backupPath, path.basename(lockFile))
      );
    }

    return backupPath;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## DependencyUpdater - Intelligent Dependency Updates

Manages dependency updates with risk assessment and compatibility checking.

### Methods
- \`analyzeUpdates(path)\`: Full dependency analysis
- \`analyzeDependency(name, version, path)\`: Single package analysis
- \`generateUpdatePlan(dependencies)\`: Create phased update plan
- \`applyUpdates(path, plan, options)\`: Apply updates
- \`checkIncompatibilities(dependencies)\`: Find conflicts
- \`restoreFromBackup(backupPath, projectPath)\`: Undo changes

### Update Plan Phases
1. **Critical Security**: High-severity vulnerabilities
2. **Patch Updates**: Bug fixes, low risk
3. **Minor Updates**: New features, medium risk
4. **Major (Low Risk)**: No known breaking changes
5. **Major (High Risk)**: Known breaking changes

### Risk Levels
- **low**: Patch updates, safe to apply
- **medium**: Minor updates, review recommended
- **high**: Major updates or breaking changes
- **critical**: Security vulnerabilities

### Compatibility Matrix
- Tracks known compatible version ranges
- Detects @types/* version mismatches
- Identifies peer dependency conflicts

### Best Practices
- Always backup before updates
- Follow phased update plan
- Run tests after each phase
- Update @types/* with base packages
- Review breaking changes documentation
    `;
  }
}
