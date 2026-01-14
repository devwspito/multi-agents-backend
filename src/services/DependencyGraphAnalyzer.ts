/**
 * DependencyGraphAnalyzer
 *
 * Builds and analyzes the dependency graph between files.
 * Helps agents understand the impact of their changes.
 *
 * Key behaviors:
 * 1. Build import/export graph from codebase
 * 2. Identify files affected by changes
 * 3. Detect circular dependencies
 * 4. Suggest safe edit order
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FileNode {
  path: string;
  imports: string[]; // Files this file imports
  importedBy: string[]; // Files that import this file
  exports: string[]; // Named exports
  isEntryPoint: boolean;
  moduleType: 'esm' | 'commonjs' | 'mixed';
}

export interface DependencyGraph {
  nodes: Map<string, FileNode>;
  entryPoints: string[];
  leafNodes: string[]; // Files with no imports
  circularDependencies: string[][];
  timestamp: number;
}

export interface ImpactAnalysis {
  file: string;
  directDependents: string[];
  indirectDependents: string[];
  totalAffected: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  warnings: string[];
  safeToEdit: boolean;
}

export interface EditOrderRecommendation {
  files: string[];
  order: { file: string; reason: string }[];
  warnings: string[];
}

export class DependencyGraphAnalyzer {
  private static graph: DependencyGraph | null = null;

  /**
   * Build dependency graph from workspace
   */
  static async buildGraph(workspacePath: string): Promise<DependencyGraph> {
    console.log(`\n🔗 [DependencyGraph] Building dependency graph...`);

    const graph: DependencyGraph = {
      nodes: new Map(),
      entryPoints: [],
      leafNodes: [],
      circularDependencies: [],
      timestamp: Date.now(),
    };

    // Find all TypeScript/JavaScript files
    const files = await this.findSourceFiles(workspacePath);
    console.log(`   Found ${files.length} source files`);

    // Build nodes for each file
    for (const file of files) {
      const node = await this.analyzeFile(workspacePath, file);
      graph.nodes.set(file, node);
    }

    // Resolve imports to file paths and build reverse dependencies
    for (const [filePath, node] of graph.nodes) {
      for (const importPath of node.imports) {
        const resolvedPath = this.resolveImport(workspacePath, filePath, importPath);
        if (resolvedPath && graph.nodes.has(resolvedPath)) {
          const importedNode = graph.nodes.get(resolvedPath)!;
          if (!importedNode.importedBy.includes(filePath)) {
            importedNode.importedBy.push(filePath);
          }
        }
      }
    }

    // Identify entry points (files not imported by others)
    for (const [filePath, node] of graph.nodes) {
      if (node.importedBy.length === 0 && !filePath.includes('.test.') && !filePath.includes('.spec.')) {
        graph.entryPoints.push(filePath);
        node.isEntryPoint = true;
      }
      if (node.imports.length === 0) {
        graph.leafNodes.push(filePath);
      }
    }

    // Detect circular dependencies
    graph.circularDependencies = this.detectCircularDependencies(graph);

    console.log(`   Entry points: ${graph.entryPoints.length}`);
    console.log(`   Leaf nodes: ${graph.leafNodes.length}`);
    console.log(`   Circular deps: ${graph.circularDependencies.length}`);

    this.graph = graph;
    return graph;
  }

  /**
   * Analyze a single file for imports/exports
   */
  private static async analyzeFile(workspacePath: string, filePath: string): Promise<FileNode> {
    const fullPath = path.join(workspacePath, filePath);
    const content = fs.readFileSync(fullPath, 'utf8');

    const imports: string[] = [];
    const exports: string[] = [];
    let moduleType: FileNode['moduleType'] = 'esm';

    // Find ES6 imports
    const importMatches = content.matchAll(/import\s+(?:{[^}]+}|[\w*]+|\*\s+as\s+\w+)\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      imports.push(match[1]);
    }

    // Find require() calls
    const requireMatches = content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of requireMatches) {
      imports.push(match[1]);
      moduleType = moduleType === 'esm' ? 'mixed' : 'commonjs';
    }

    // Find ES6 exports
    const exportMatches = content.matchAll(/export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g);
    for (const match of exportMatches) {
      exports.push(match[1]);
    }

    // Find named exports
    const namedExportMatches = content.matchAll(/export\s+{\s*([^}]+)\s*}/g);
    for (const match of namedExportMatches) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
      exports.push(...names);
    }

    return {
      path: filePath,
      imports: [...new Set(imports)], // Dedupe
      importedBy: [],
      exports: [...new Set(exports)],
      isEntryPoint: false,
      moduleType,
    };
  }

  /**
   * Find all source files in workspace
   */
  private static async findSourceFiles(workspacePath: string): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') {
            continue;
          }

          const fullPath = path.join(dir, entry.name);
          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.name.match(/\.(ts|tsx|js|jsx)$/)) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Resolve import path to file path
   */
  private static resolveImport(workspacePath: string, fromFile: string, importPath: string): string | null {
    // Skip node_modules imports
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null;
    }

    const fromDir = path.dirname(path.join(workspacePath, fromFile));
    let resolvedPath = path.resolve(fromDir, importPath);

    // Remove workspace path prefix
    resolvedPath = resolvedPath.replace(workspacePath + '/', '');

    // Try different extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
    for (const ext of extensions) {
      const testPath = resolvedPath + ext;
      if (fs.existsSync(path.join(workspacePath, testPath))) {
        return testPath;
      }
    }

    return null;
  }

  /**
   * Detect circular dependencies using DFS
   */
  private static detectCircularDependencies(graph: DependencyGraph): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const stack = new Set<string>();

    const dfs = (file: string, path: string[] = []): void => {
      if (stack.has(file)) {
        // Found cycle
        const cycleStart = path.indexOf(file);
        if (cycleStart >= 0) {
          cycles.push(path.slice(cycleStart).concat(file));
        }
        return;
      }

      if (visited.has(file)) return;

      visited.add(file);
      stack.add(file);

      const node = graph.nodes.get(file);
      if (node) {
        for (const imp of node.imports) {
          const resolved = this.resolveImportFromGraph(graph, file, imp);
          if (resolved) {
            dfs(resolved, [...path, file]);
          }
        }
      }

      stack.delete(file);
    };

    for (const file of graph.nodes.keys()) {
      dfs(file);
    }

    return cycles;
  }

  /**
   * Resolve import from cached graph
   */
  private static resolveImportFromGraph(graph: DependencyGraph, fromFile: string, importPath: string): string | null {
    if (!importPath.startsWith('.')) return null;

    const fromDir = path.dirname(fromFile);
    let resolvedPath = path.join(fromDir, importPath).replace(/\\/g, '/');

    // Normalize path
    const parts = resolvedPath.split('/');
    const normalized: string[] = [];
    for (const part of parts) {
      if (part === '..') {
        normalized.pop();
      } else if (part !== '.') {
        normalized.push(part);
      }
    }
    resolvedPath = normalized.join('/');

    // Try to find in graph
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
    for (const ext of extensions) {
      if (graph.nodes.has(resolvedPath + ext)) {
        return resolvedPath + ext;
      }
    }

    return null;
  }

  /**
   * Analyze impact of editing a file
   */
  static analyzeImpact(filePath: string): ImpactAnalysis {
    if (!this.graph) {
      return {
        file: filePath,
        directDependents: [],
        indirectDependents: [],
        totalAffected: 0,
        riskLevel: 'low',
        warnings: ['Dependency graph not built'],
        safeToEdit: true,
      };
    }

    const node = this.graph.nodes.get(filePath);
    if (!node) {
      return {
        file: filePath,
        directDependents: [],
        indirectDependents: [],
        totalAffected: 0,
        riskLevel: 'low',
        warnings: [`File ${filePath} not in graph`],
        safeToEdit: true,
      };
    }

    // Find all dependents (direct and indirect)
    const directDependents = [...node.importedBy];
    const indirectDependents: string[] = [];
    const visited = new Set<string>([filePath, ...directDependents]);

    const queue = [...directDependents];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentNode = this.graph.nodes.get(current);

      if (currentNode) {
        for (const dependent of currentNode.importedBy) {
          if (!visited.has(dependent)) {
            visited.add(dependent);
            indirectDependents.push(dependent);
            queue.push(dependent);
          }
        }
      }
    }

    const totalAffected = directDependents.length + indirectDependents.length;
    const warnings: string[] = [];

    // Determine risk level
    let riskLevel: ImpactAnalysis['riskLevel'] = 'low';
    if (totalAffected > 20) {
      riskLevel = 'critical';
      warnings.push(`High impact: ${totalAffected} files depend on this`);
    } else if (totalAffected > 10) {
      riskLevel = 'high';
      warnings.push(`Moderate impact: ${totalAffected} files depend on this`);
    } else if (totalAffected > 5) {
      riskLevel = 'medium';
    }

    // Check for circular dependencies
    const inCycle = this.graph.circularDependencies.some(cycle => cycle.includes(filePath));
    if (inCycle) {
      warnings.push('⚠️ File is part of circular dependency');
      if (riskLevel !== 'critical') riskLevel = 'high';
    }

    // Check if entry point
    if (node.isEntryPoint) {
      warnings.push('This is an entry point file');
    }

    return {
      file: filePath,
      directDependents,
      indirectDependents,
      totalAffected,
      riskLevel,
      warnings,
      safeToEdit: riskLevel !== 'critical',
    };
  }

  /**
   * Recommend edit order for multiple files
   */
  static recommendEditOrder(files: string[]): EditOrderRecommendation {
    if (!this.graph) {
      return {
        files,
        order: files.map(f => ({ file: f, reason: 'Graph not built' })),
        warnings: ['Dependency graph not available'],
      };
    }

    // Sort files by dependency order (edit leaves first)
    const sortedFiles: { file: string; reason: string }[] = [];
    const remaining = new Set(files);
    const warnings: string[] = [];

    // First pass: files with no dependencies on other files in the list
    while (remaining.size > 0) {
      let foundIndependent = false;

      for (const file of remaining) {
        const node = this.graph.nodes.get(file);
        if (!node) {
          sortedFiles.push({ file, reason: 'Not in graph' });
          remaining.delete(file);
          foundIndependent = true;
          continue;
        }

        // Check if this file depends on any remaining files
        const dependsOnRemaining = node.imports.some(imp => {
          const resolved = this.resolveImportFromGraph(this.graph!, file, imp);
          return resolved && remaining.has(resolved);
        });

        if (!dependsOnRemaining) {
          const dependentCount = node.importedBy.filter(d => remaining.has(d)).length;
          const reason = dependentCount > 0
            ? `Edit first: ${dependentCount} remaining files depend on this`
            : 'No dependencies on remaining files';

          sortedFiles.push({ file, reason });
          remaining.delete(file);
          foundIndependent = true;
        }
      }

      // Break circular dependency
      if (!foundIndependent && remaining.size > 0) {
        const next = remaining.values().next().value as string;
        sortedFiles.push({ file: next, reason: '⚠️ Circular dependency - edit carefully' });
        remaining.delete(next);
        warnings.push(`Circular dependency detected involving ${next}`);
      }
    }

    return {
      files,
      order: sortedFiles,
      warnings,
    };
  }

  /**
   * Format impact analysis for prompt
   */
  static formatImpactForPrompt(analysis: ImpactAnalysis): string {
    const riskIcons = {
      low: '🟢',
      medium: '🟡',
      high: '🟠',
      critical: '🔴',
    };

    let output = `
## 🔗 Dependency Impact: ${analysis.file}

**Risk Level**: ${riskIcons[analysis.riskLevel]} ${analysis.riskLevel.toUpperCase()}
**Total Files Affected**: ${analysis.totalAffected}
`;

    if (analysis.directDependents.length > 0) {
      output += `
**Direct Dependents** (${analysis.directDependents.length}):
${analysis.directDependents.slice(0, 5).map(d => `- ${d}`).join('\n')}
${analysis.directDependents.length > 5 ? `... and ${analysis.directDependents.length - 5} more` : ''}
`;
    }

    if (analysis.warnings.length > 0) {
      output += `
**Warnings**:
${analysis.warnings.map(w => `- ${w}`).join('\n')}
`;
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 🔗 DEPENDENCY AWARENESS

Before editing a file, understand its impact:

### Check Before Edit:

1. **Who imports this file?**
   - Changes may break importing files
   - More importers = higher risk

2. **What does this file export?**
   - Renaming/removing exports breaks importers
   - Adding is usually safe

3. **Circular dependencies?**
   - Be extra careful with circular deps
   - Changes may have unexpected effects

### Safe Edit Practices:

| Action | Risk | Precaution |
|--------|------|------------|
| Add new export | Low | None needed |
| Modify internal code | Low | Test the file |
| Change export signature | Medium | Check importers |
| Rename export | High | Update all importers |
| Delete export | Critical | Verify no usage first |

### High-Impact Files:

Files imported by many others are HIGH RISK:
- index.ts (barrel exports)
- utils/helpers
- shared types/interfaces
- config files

**Before editing these**, search for usage:
\`\`\`
Grep("import.*from.*'./utils'", path="src")
\`\`\`
`;
  }
}
