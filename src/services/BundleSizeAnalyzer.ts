/**
 * BundleSizeAnalyzer - Bundle size analysis and optimization service
 *
 * Analyzes JavaScript/TypeScript bundle sizes, identifies large dependencies,
 * and provides optimization recommendations for reducing bundle size.
 */

import * as fs from 'fs';
import * as path from 'path';

interface PackageInfo {
  name: string;
  version: string;
  size: number;
  gzipSize: number;
  dependencyCount: number;
  usedExports: string[];
  totalExports: number;
  treeshakeable: boolean;
  alternatives: string[];
}

interface ImportAnalysis {
  file: string;
  imports: Array<{
    package: string;
    importedNames: string[];
    isDefaultImport: boolean;
    isNamespaceImport: boolean;
    estimatedSize: number;
    line: number;
  }>;
  totalEstimatedSize: number;
}

interface BundleReport {
  summary: {
    totalDependencies: number;
    totalSize: number;
    totalGzipSize: number;
    largestPackages: PackageInfo[];
    treeshakeableDeps: number;
    potentialSavings: number;
  };
  packages: PackageInfo[];
  imports: ImportAnalysis[];
  recommendations: Recommendation[];
  duplicates: DuplicatePackage[];
}

interface Recommendation {
  type: RecommendationType;
  priority: 'high' | 'medium' | 'low';
  package: string;
  currentSize: number;
  potentialSaving: number;
  description: string;
  action: string;
  alternative?: string;
}

type RecommendationType =
  | 'replace-with-smaller'
  | 'use-named-imports'
  | 'remove-unused'
  | 'use-dynamic-import'
  | 'tree-shake'
  | 'deduplicate'
  | 'use-native';

interface DuplicatePackage {
  name: string;
  versions: string[];
  totalSize: number;
  savingsIfDeduplicated: number;
}

// Known package sizes (in KB, rough estimates for common packages)
const PACKAGE_SIZES: Record<string, { full: number; gzip: number; treeshakeable: boolean }> = {
  'lodash': { full: 531, gzip: 71, treeshakeable: false },
  'lodash-es': { full: 531, gzip: 71, treeshakeable: true },
  'moment': { full: 288, gzip: 71, treeshakeable: false },
  'date-fns': { full: 75, gzip: 20, treeshakeable: true },
  'dayjs': { full: 7, gzip: 3, treeshakeable: true },
  'axios': { full: 53, gzip: 14, treeshakeable: false },
  'rxjs': { full: 329, gzip: 41, treeshakeable: true },
  'jquery': { full: 89, gzip: 31, treeshakeable: false },
  'react': { full: 7, gzip: 3, treeshakeable: false },
  'react-dom': { full: 130, gzip: 42, treeshakeable: false },
  'vue': { full: 63, gzip: 23, treeshakeable: true },
  'angular': { full: 167, gzip: 59, treeshakeable: true },
  '@angular/core': { full: 418, gzip: 89, treeshakeable: true },
  'underscore': { full: 69, gzip: 19, treeshakeable: false },
  'ramda': { full: 46, gzip: 11, treeshakeable: true },
  'immutable': { full: 64, gzip: 17, treeshakeable: false },
  'immer': { full: 16, gzip: 5, treeshakeable: true },
  'redux': { full: 7, gzip: 3, treeshakeable: true },
  '@reduxjs/toolkit': { full: 40, gzip: 13, treeshakeable: true },
  'mobx': { full: 57, gzip: 16, treeshakeable: true },
  'uuid': { full: 11, gzip: 4, treeshakeable: true },
  'nanoid': { full: 1, gzip: 0.5, treeshakeable: true },
  'classnames': { full: 1, gzip: 0.5, treeshakeable: false },
  'clsx': { full: 0.5, gzip: 0.3, treeshakeable: true },
  'chalk': { full: 38, gzip: 10, treeshakeable: false },
  'picocolors': { full: 2, gzip: 1, treeshakeable: true },
  'd3': { full: 271, gzip: 80, treeshakeable: true },
  'chart.js': { full: 197, gzip: 65, treeshakeable: true },
  'three': { full: 587, gzip: 152, treeshakeable: true },
  'socket.io-client': { full: 89, gzip: 29, treeshakeable: false },
  'firebase': { full: 896, gzip: 220, treeshakeable: true },
  'aws-sdk': { full: 2048, gzip: 512, treeshakeable: false },
  '@aws-sdk/client-s3': { full: 280, gzip: 70, treeshakeable: true },
  'express': { full: 208, gzip: 50, treeshakeable: false },
  'fastify': { full: 125, gzip: 35, treeshakeable: false },
  'mongoose': { full: 812, gzip: 180, treeshakeable: false },
  'typeorm': { full: 523, gzip: 120, treeshakeable: false },
  'prisma': { full: 45, gzip: 15, treeshakeable: true },
  'zod': { full: 57, gzip: 13, treeshakeable: true },
  'yup': { full: 41, gzip: 12, treeshakeable: true },
  'joi': { full: 148, gzip: 35, treeshakeable: false }
};

// Recommended alternatives for common heavy packages
const ALTERNATIVES: Record<string, string[]> = {
  'moment': ['date-fns', 'dayjs', 'luxon'],
  'lodash': ['lodash-es (tree-shakeable)', 'ramda', 'native methods'],
  'axios': ['native fetch', 'ky', 'redaxios'],
  'uuid': ['nanoid', 'crypto.randomUUID()'],
  'classnames': ['clsx'],
  'chalk': ['picocolors', 'kolorist'],
  'underscore': ['lodash-es', 'native methods'],
  'jquery': ['native DOM APIs', 'vanilla JS'],
  'aws-sdk': ['@aws-sdk/* (modular)'],
  'firebase': ['firebase/* (modular imports)'],
  'request': ['native fetch', 'node-fetch', 'got'],
  'bluebird': ['native Promise'],
  'async': ['native async/await']
};

export class BundleSizeAnalyzer {
  private packageJsonCache: Map<string, any> = new Map();

  /**
   * Analyze bundle for a project
   */
  async analyzeProject(projectPath: string): Promise<BundleReport> {
    const packageJsonPath = path.join(projectPath, 'package.json');

    if (!fs.existsSync(packageJsonPath)) {
      throw new Error('package.json not found');
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    // Analyze packages
    const packages: PackageInfo[] = [];
    for (const [name, version] of Object.entries(dependencies)) {
      const info = await this.analyzePackage(name, version as string, projectPath);
      if (info) packages.push(info);
    }

    // Analyze imports in source files
    const sourceFiles = this.collectSourceFiles(path.join(projectPath, 'src'));
    const imports: ImportAnalysis[] = [];
    for (const file of sourceFiles) {
      const analysis = await this.analyzeFileImports(file);
      imports.push(analysis);
    }

    // Detect duplicates
    const duplicates = this.detectDuplicates(projectPath);

    // Generate recommendations
    const recommendations = this.generateRecommendations(packages, imports);

    // Calculate summary
    const totalSize = packages.reduce((sum, p) => sum + p.size, 0);
    const totalGzipSize = packages.reduce((sum, p) => sum + p.gzipSize, 0);
    const treeshakeableDeps = packages.filter(p => p.treeshakeable).length;
    const potentialSavings = recommendations.reduce((sum, r) => sum + r.potentialSaving, 0);

    return {
      summary: {
        totalDependencies: packages.length,
        totalSize,
        totalGzipSize,
        largestPackages: packages.sort((a, b) => b.size - a.size).slice(0, 10),
        treeshakeableDeps,
        potentialSavings
      },
      packages,
      imports,
      recommendations,
      duplicates
    };
  }

  /**
   * Analyze a specific package
   */
  async analyzePackage(
    name: string,
    version: string,
    projectPath: string
  ): Promise<PackageInfo | null> {
    const knownInfo = PACKAGE_SIZES[name];
    const alternatives = ALTERNATIVES[name] || [];

    // Try to get actual size from node_modules
    let size = knownInfo?.full || 0;
    let gzipSize = knownInfo?.gzip || 0;
    let treeshakeable = knownInfo?.treeshakeable || false;

    const packagePath = path.join(projectPath, 'node_modules', name);
    if (fs.existsSync(packagePath)) {
      const actualSize = this.getDirectorySize(packagePath);
      if (actualSize > 0) {
        size = Math.round(actualSize / 1024); // KB
        gzipSize = Math.round(size * 0.3); // Rough gzip estimate
      }

      // Check if ES modules
      const pkgJson = this.getPackageJson(packagePath);
      if (pkgJson) {
        treeshakeable = !!(pkgJson.module || pkgJson.exports || pkgJson.type === 'module');
      }
    }

    // Count dependencies
    const pkgJsonPath = path.join(projectPath, 'node_modules', name, 'package.json');
    let dependencyCount = 0;
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        dependencyCount = Object.keys(pkgJson.dependencies || {}).length;
      } catch {
        // Ignore parse errors
      }
    }

    return {
      name,
      version,
      size,
      gzipSize,
      dependencyCount,
      usedExports: [], // Would need static analysis
      totalExports: 0,
      treeshakeable,
      alternatives
    };
  }

  /**
   * Analyze imports in a file
   */
  async analyzeFileImports(filePath: string): Promise<ImportAnalysis> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const imports: ImportAnalysis['imports'] = [];

    // Match import statements
    const importPattern = /import\s+(?:(\*\s+as\s+\w+)|(\w+)|\{([^}]+)\})\s+from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = importPattern.exec(content)) !== null) {
      const isNamespaceImport = !!match[1];
      const isDefaultImport = !!match[2];
      const namedImports = match[3];
      const packageName = match[4];
      const lineNum = content.slice(0, match.index).split('\n').length;

      // Skip relative imports
      if (packageName.startsWith('.')) continue;

      const importedNames: string[] = [];
      if (isDefaultImport) {
        importedNames.push('default');
      }
      if (namedImports) {
        importedNames.push(...namedImports.split(',').map(n => n.trim().split(/\s+as\s+/)[0]));
      }
      if (isNamespaceImport) {
        importedNames.push('*');
      }

      // Estimate size impact
      const pkgInfo = PACKAGE_SIZES[this.getBasePackageName(packageName)];
      let estimatedSize = pkgInfo?.full || 10; // Default 10KB if unknown

      // If using named imports on tree-shakeable package, estimate partial size
      if (pkgInfo?.treeshakeable && !isNamespaceImport && importedNames.length > 0 && !importedNames.includes('*')) {
        estimatedSize = Math.round(estimatedSize * 0.2 * importedNames.length);
      }

      imports.push({
        package: packageName,
        importedNames,
        isDefaultImport,
        isNamespaceImport,
        estimatedSize,
        line: lineNum
      });
    }

    const totalEstimatedSize = imports.reduce((sum, i) => sum + i.estimatedSize, 0);

    return {
      file: filePath,
      imports,
      totalEstimatedSize
    };
  }

  /**
   * Find heavy imports that could be optimized
   */
  findHeavyImports(report: BundleReport, thresholdKB: number = 50): ImportAnalysis['imports'][] {
    const heavy: ImportAnalysis['imports'][] = [];

    for (const fileAnalysis of report.imports) {
      const heavyInFile = fileAnalysis.imports.filter(i => i.estimatedSize >= thresholdKB);
      if (heavyInFile.length > 0) {
        heavy.push(heavyInFile);
      }
    }

    return heavy;
  }

  /**
   * Suggest code splitting opportunities
   */
  suggestCodeSplitting(report: BundleReport): string[] {
    const suggestions: string[] = [];

    // Find large packages that are only used in few files
    const packageUsage = new Map<string, string[]>();

    for (const fileAnalysis of report.imports) {
      for (const imp of fileAnalysis.imports) {
        const files = packageUsage.get(imp.package) || [];
        files.push(fileAnalysis.file);
        packageUsage.set(imp.package, files);
      }
    }

    for (const [pkg, files] of packageUsage) {
      const pkgInfo = report.packages.find(p => p.name === pkg);
      if (pkgInfo && pkgInfo.size > 100 && files.length <= 2) {
        suggestions.push(
          `Consider lazy loading '${pkg}' (${pkgInfo.size}KB) - only used in ${files.length} file(s)`
        );
      }
    }

    // Suggest splitting for route-based components
    const routeFiles = report.imports.filter(a =>
      a.file.includes('route') || a.file.includes('page') || a.file.includes('view')
    );

    if (routeFiles.length > 0) {
      suggestions.push(
        'Route-based components detected - consider React.lazy() or dynamic imports for route splitting'
      );
    }

    return suggestions;
  }

  /**
   * Format report as markdown
   */
  formatReport(report: BundleReport): string {
    const lines: string[] = [
      '# Bundle Size Analysis Report',
      '',
      '## Summary',
      '',
      `- **Total Dependencies:** ${report.summary.totalDependencies}`,
      `- **Total Size:** ${this.formatSize(report.summary.totalSize)}`,
      `- **Total Gzip Size:** ${this.formatSize(report.summary.totalGzipSize)}`,
      `- **Tree-shakeable Deps:** ${report.summary.treeshakeableDeps}`,
      `- **Potential Savings:** ${this.formatSize(report.summary.potentialSavings)}`,
      '',
      '## Largest Packages',
      '',
      '| Package | Size | Gzip | Tree-shakeable |',
      '|---------|------|------|----------------|'
    ];

    for (const pkg of report.summary.largestPackages) {
      lines.push(
        `| ${pkg.name} | ${this.formatSize(pkg.size)} | ${this.formatSize(pkg.gzipSize)} | ${pkg.treeshakeable ? 'Yes' : 'No'} |`
      );
    }

    if (report.duplicates.length > 0) {
      lines.push('', '## Duplicate Packages', '');
      for (const dup of report.duplicates) {
        lines.push(
          `- **${dup.name}**: ${dup.versions.join(', ')} (could save ${this.formatSize(dup.savingsIfDeduplicated)})`
        );
      }
    }

    if (report.recommendations.length > 0) {
      lines.push('', '## Recommendations', '');

      const highPriority = report.recommendations.filter(r => r.priority === 'high');
      const mediumPriority = report.recommendations.filter(r => r.priority === 'medium');

      if (highPriority.length > 0) {
        lines.push('', '### High Priority', '');
        for (const rec of highPriority) {
          lines.push(`- **${rec.package}** (${this.formatSize(rec.currentSize)}): ${rec.description}`);
          lines.push(`  - Action: ${rec.action}`);
          if (rec.alternative) {
            lines.push(`  - Alternative: ${rec.alternative}`);
          }
          lines.push(`  - Potential saving: ${this.formatSize(rec.potentialSaving)}`);
        }
      }

      if (mediumPriority.length > 0) {
        lines.push('', '### Medium Priority', '');
        for (const rec of mediumPriority) {
          lines.push(`- **${rec.package}**: ${rec.description}`);
          lines.push(`  - Action: ${rec.action}`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Compare two bundle reports
   */
  compareReports(
    before: BundleReport,
    after: BundleReport
  ): {
    sizeDelta: number;
    addedPackages: string[];
    removedPackages: string[];
    changedPackages: Array<{ name: string; before: number; after: number }>;
  } {
    const beforePkgs = new Map(before.packages.map(p => [p.name, p]));
    const afterPkgs = new Map(after.packages.map(p => [p.name, p]));

    const addedPackages: string[] = [];
    const removedPackages: string[] = [];
    const changedPackages: Array<{ name: string; before: number; after: number }> = [];

    for (const [name, pkg] of afterPkgs) {
      if (!beforePkgs.has(name)) {
        addedPackages.push(name);
      } else {
        const beforePkg = beforePkgs.get(name)!;
        if (Math.abs(beforePkg.size - pkg.size) > 1) {
          changedPackages.push({
            name,
            before: beforePkg.size,
            after: pkg.size
          });
        }
      }
    }

    for (const name of beforePkgs.keys()) {
      if (!afterPkgs.has(name)) {
        removedPackages.push(name);
      }
    }

    return {
      sizeDelta: after.summary.totalSize - before.summary.totalSize,
      addedPackages,
      removedPackages,
      changedPackages
    };
  }

  // Private helper methods

  private getBasePackageName(packagePath: string): string {
    // Handle scoped packages
    if (packagePath.startsWith('@')) {
      return packagePath.split('/').slice(0, 2).join('/');
    }
    return packagePath.split('/')[0];
  }

  private getDirectorySize(dirPath: string): number {
    let size = 0;

    try {
      const files = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const file of files) {
        const filePath = path.join(dirPath, file.name);

        if (file.isDirectory()) {
          if (file.name !== 'node_modules') {
            size += this.getDirectorySize(filePath);
          }
        } else {
          const stats = fs.statSync(filePath);
          size += stats.size;
        }
      }
    } catch {
      // Ignore errors
    }

    return size;
  }

  private getPackageJson(packagePath: string): any {
    const pkgJsonPath = path.join(packagePath, 'package.json');
    if (this.packageJsonCache.has(pkgJsonPath)) {
      return this.packageJsonCache.get(pkgJsonPath);
    }

    if (fs.existsSync(pkgJsonPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        this.packageJsonCache.set(pkgJsonPath, content);
        return content;
      } catch {
        return null;
      }
    }
    return null;
  }

  private collectSourceFiles(dir: string): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dir)) return files;

    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'build'].includes(entry.name)) {
            walk(fullPath);
          }
        } else {
          if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.test.')) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dir);
    return files;
  }

  private detectDuplicates(projectPath: string): DuplicatePackage[] {
    const duplicates: DuplicatePackage[] = [];
    const packageVersions = new Map<string, Set<string>>();

    // Walk node_modules to find duplicates
    const walkNodeModules = (dir: string, depth: number = 0) => {
      if (depth > 3) return; // Limit depth

      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.name === 'node_modules') {
          walkNodeModules(fullPath, depth + 1);
        } else if (!entry.name.startsWith('.')) {
          const pkgJson = this.getPackageJson(fullPath);
          if (pkgJson?.version) {
            const versions = packageVersions.get(entry.name) || new Set();
            versions.add(pkgJson.version);
            packageVersions.set(entry.name, versions);
          }

          // Check nested node_modules
          const nestedNM = path.join(fullPath, 'node_modules');
          if (fs.existsSync(nestedNM)) {
            walkNodeModules(nestedNM, depth + 1);
          }
        }
      }
    };

    walkNodeModules(path.join(projectPath, 'node_modules'));

    // Find packages with multiple versions
    for (const [name, versions] of packageVersions) {
      if (versions.size > 1) {
        const pkgInfo = PACKAGE_SIZES[name];
        const size = pkgInfo?.full || 10;

        duplicates.push({
          name,
          versions: Array.from(versions),
          totalSize: size * versions.size,
          savingsIfDeduplicated: size * (versions.size - 1)
        });
      }
    }

    return duplicates.sort((a, b) => b.savingsIfDeduplicated - a.savingsIfDeduplicated);
  }

  private generateRecommendations(
    packages: PackageInfo[],
    imports: ImportAnalysis[]
  ): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Check for packages with smaller alternatives
    for (const pkg of packages) {
      if (pkg.alternatives.length > 0 && pkg.size > 50) {
        const altName = pkg.alternatives[0];
        const altInfo = PACKAGE_SIZES[altName.split(' ')[0]];
        const potentialSaving = altInfo ? pkg.size - altInfo.full : pkg.size * 0.5;

        if (potentialSaving > 10) {
          recommendations.push({
            type: 'replace-with-smaller',
            priority: potentialSaving > 100 ? 'high' : 'medium',
            package: pkg.name,
            currentSize: pkg.size,
            potentialSaving,
            description: `${pkg.name} has smaller alternatives`,
            action: `Consider replacing with ${pkg.alternatives.join(' or ')}`,
            alternative: pkg.alternatives[0]
          });
        }
      }

      // Check for non-treeshakeable packages with namespace imports
      if (!pkg.treeshakeable) {
        for (const fileAnalysis of imports) {
          const pkgImports = fileAnalysis.imports.filter(i =>
            this.getBasePackageName(i.package) === pkg.name
          );

          for (const imp of pkgImports) {
            if (imp.isNamespaceImport && pkg.size > 100) {
              recommendations.push({
                type: 'use-named-imports',
                priority: 'medium',
                package: pkg.name,
                currentSize: pkg.size,
                potentialSaving: pkg.size * 0.7,
                description: `Namespace import of non-tree-shakeable package`,
                action: `Use named imports instead of "import * as ${pkg.name}"`
              });
            }
          }
        }
      }
    }

    // Check for native alternatives
    const nativeReplacements: Record<string, string> = {
      'uuid': 'crypto.randomUUID()',
      'lodash': 'Array/Object methods',
      'axios': 'fetch API',
      'bluebird': 'native Promise'
    };

    for (const [pkg, native] of Object.entries(nativeReplacements)) {
      const pkgInfo = packages.find(p => p.name === pkg);
      if (pkgInfo) {
        recommendations.push({
          type: 'use-native',
          priority: 'low',
          package: pkg,
          currentSize: pkgInfo.size,
          potentialSaving: pkgInfo.size,
          description: `${pkg} can be replaced with native APIs`,
          action: `Consider using ${native} instead`
        });
      }
    }

    // Sort by potential saving
    return recommendations.sort((a, b) => b.potentialSaving - a.potentialSaving);
  }

  private formatSize(kb: number): string {
    if (kb < 1) return `${Math.round(kb * 1024)}B`;
    if (kb < 1024) return `${Math.round(kb)}KB`;
    return `${(kb / 1024).toFixed(1)}MB`;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## BundleSizeAnalyzer - Bundle Analysis Service

Analyzes JavaScript bundle sizes and provides optimization recommendations.

### Methods
- \`analyzeProject(path)\`: Full project bundle analysis
- \`analyzePackage(name, version, path)\`: Single package analysis
- \`analyzeFileImports(path)\`: Analyze imports in a file
- \`findHeavyImports(report, thresholdKB)\`: Find imports over threshold
- \`suggestCodeSplitting(report)\`: Get code splitting suggestions
- \`compareReports(before, after)\`: Compare two analyses

### Report Contents
- Total dependencies and sizes
- Largest packages ranked
- Duplicate packages with versions
- Recommendations with priorities

### Recommendation Types
- **replace-with-smaller**: Package has lighter alternatives
- **use-named-imports**: Avoid namespace imports
- **use-dynamic-import**: Lazy load large packages
- **deduplicate**: Multiple versions detected
- **use-native**: Native API can replace package

### Best Practices
- Run before major releases
- Target packages > 100KB first
- Prefer tree-shakeable packages
- Use dynamic imports for routes
- Deduplicate nested dependencies
    `;
  }
}
