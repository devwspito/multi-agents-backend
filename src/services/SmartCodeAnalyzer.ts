/**
 * SmartCodeAnalyzer
 *
 * Intelligently analyzes code to understand:
 * 1. Dependencies between files
 * 2. Impact of changes (what else needs to be updated)
 * 3. Related files that should be read together
 * 4. Type definitions needed
 * 5. Test files that need updates
 *
 * This helps agents make informed decisions about what to read/modify.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FileAnalysis {
  file: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  dependencies: string[]; // Files this file depends on
  dependents: string[]; // Files that depend on this file
  relatedTests: string[];
  relatedTypes: string[];
  complexity: 'simple' | 'moderate' | 'complex';
}

export interface ImportInfo {
  source: string;
  names: string[];
  isDefault: boolean;
  isType: boolean;
  resolvedPath?: string;
}

export interface ExportInfo {
  name: string;
  type: 'function' | 'class' | 'const' | 'interface' | 'type' | 'default';
  isAsync?: boolean;
}

export interface ImpactAnalysis {
  directlyAffected: string[];
  indirectlyAffected: string[];
  testsToRun: string[];
  suggestedReads: string[];
  riskLevel: 'low' | 'medium' | 'high';
  warnings: string[];
}

export class SmartCodeAnalyzer {
  private static fileCache: Map<string, FileAnalysis> = new Map();

  /**
   * Analyze a single file
   */
  static analyzeFile(filePath: string, workspacePath: string): FileAnalysis {
    const cacheKey = `${workspacePath}:${filePath}`;

    // Check cache (invalidate after 5 minutes)
    const cached = this.fileCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);

    if (!fs.existsSync(fullPath)) {
      return {
        file: filePath,
        imports: [],
        exports: [],
        dependencies: [],
        dependents: [],
        relatedTests: [],
        relatedTypes: [],
        complexity: 'simple',
      };
    }

    const content = fs.readFileSync(fullPath, 'utf8');

    const analysis: FileAnalysis = {
      file: filePath,
      imports: this.extractImports(content, fullPath),
      exports: this.extractExports(content),
      dependencies: [],
      dependents: [],
      relatedTests: this.findRelatedTests(filePath, workspacePath),
      relatedTypes: this.findRelatedTypes(content, fullPath, workspacePath),
      complexity: this.analyzeComplexity(content),
    };

    // Resolve dependencies
    analysis.dependencies = analysis.imports
      .filter(i => i.resolvedPath)
      .map(i => i.resolvedPath!)
      .filter(p => !p.includes('node_modules'));

    // Cache the result
    this.fileCache.set(cacheKey, analysis);

    return analysis;
  }

  /**
   * Analyze the impact of changing a file
   */
  static analyzeImpact(filePath: string, workspacePath: string): ImpactAnalysis {
    console.log(`🔍 [SmartAnalyzer] Analyzing impact of changes to ${filePath}...`);

    const analysis = this.analyzeFile(filePath, workspacePath);
    const directlyAffected: string[] = [];
    const indirectlyAffected: string[] = [];
    const warnings: string[] = [];

    // Find files that import this file
    try {
      const fileName = path.basename(filePath, path.extname(filePath));
      const result = execSync(
        `grep -r -l "from.*['\"].*${fileName}['\"]" "${workspacePath}" --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | head -20 || true`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (result) {
        const dependents = result.split('\n').filter(f => f && f !== filePath);
        directlyAffected.push(...dependents.map(f => path.relative(workspacePath, f)));
      }
    } catch {
      // Continue
    }

    // Find indirect effects (files that import the directly affected files)
    for (const affected of directlyAffected.slice(0, 5)) {
      try {
        const affectedName = path.basename(affected, path.extname(affected));
        const result = execSync(
          `grep -r -l "from.*['\"].*${affectedName}['\"]" "${workspacePath}" --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v node_modules | head -5 || true`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();

        if (result) {
          const indirect = result.split('\n')
            .filter(f => f && !directlyAffected.includes(f) && f !== filePath)
            .map(f => path.relative(workspacePath, f));
          indirectlyAffected.push(...indirect);
        }
      } catch {
        // Continue
      }
    }

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low';

    if (directlyAffected.length > 10 || filePath.includes('index.ts')) {
      riskLevel = 'high';
      warnings.push('This file is widely imported - changes may have broad impact');
    } else if (directlyAffected.length > 3) {
      riskLevel = 'medium';
    }

    if (analysis.exports.some(e => e.type === 'interface' || e.type === 'type')) {
      riskLevel = riskLevel === 'low' ? 'medium' : 'high';
      warnings.push('This file exports types/interfaces - changing signatures affects all importers');
    }

    // Suggest files to read before modifying
    const suggestedReads = [
      ...analysis.dependencies.slice(0, 5),
      ...directlyAffected.slice(0, 3),
      ...analysis.relatedTests.slice(0, 2),
    ];

    return {
      directlyAffected: [...new Set(directlyAffected)],
      indirectlyAffected: [...new Set(indirectlyAffected)],
      testsToRun: analysis.relatedTests,
      suggestedReads: [...new Set(suggestedReads)],
      riskLevel,
      warnings,
    };
  }

  /**
   * Get smart suggestions for what files to read for a task
   */
  static getSuggestedReads(
    targetFiles: string[],
    workspacePath: string,
    maxFiles: number = 10
  ): { file: string; reason: string; priority: number }[] {
    const suggestions: { file: string; reason: string; priority: number }[] = [];
    const seen = new Set<string>();

    for (const file of targetFiles) {
      if (seen.has(file)) continue;
      seen.add(file);

      const analysis = this.analyzeFile(file, workspacePath);

      // Add the target file itself
      suggestions.push({
        file,
        reason: 'Target file to modify',
        priority: 1,
      });

      // Add dependencies (what this file imports)
      for (const dep of analysis.dependencies.slice(0, 3)) {
        if (seen.has(dep)) continue;
        seen.add(dep);

        suggestions.push({
          file: dep,
          reason: `Imported by ${path.basename(file)}`,
          priority: 2,
        });
      }

      // Add related tests
      for (const test of analysis.relatedTests.slice(0, 2)) {
        if (seen.has(test)) continue;
        seen.add(test);

        suggestions.push({
          file: test,
          reason: `Test file for ${path.basename(file)}`,
          priority: 3,
        });
      }

      // Add type definitions
      for (const typeFile of analysis.relatedTypes.slice(0, 2)) {
        if (seen.has(typeFile)) continue;
        seen.add(typeFile);

        suggestions.push({
          file: typeFile,
          reason: `Type definitions used by ${path.basename(file)}`,
          priority: 2,
        });
      }
    }

    // Sort by priority and limit
    return suggestions
      .sort((a, b) => a.priority - b.priority)
      .slice(0, maxFiles);
  }

  /**
   * Extract imports from file content
   */
  private static extractImports(content: string, filePath: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    const baseDir = path.dirname(filePath);

    // Match import statements
    const importRegex = /import\s+(?:type\s+)?(?:(\{[^}]+\})|(\w+)(?:\s*,\s*(\{[^}]+\}))?)\s+from\s+['"]([^'"]+)['"]/g;

    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const namedImports = match[1] || match[3] || '';
      const defaultImport = match[2] || '';
      const source = match[4];
      const isType = content.substring(match.index, match.index + 15).includes('type');

      const names: string[] = [];

      if (defaultImport && !defaultImport.match(/^\{/)) {
        names.push(defaultImport);
      }

      if (namedImports) {
        const extracted = namedImports
          .replace(/[{}]/g, '')
          .split(',')
          .map(n => n.trim().split(' as ')[0].trim())
          .filter(n => n);
        names.push(...extracted);
      }

      // Resolve the import path
      let resolvedPath: string | undefined;
      if (source.startsWith('.')) {
        const resolved = path.resolve(baseDir, source);
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

        for (const ext of extensions) {
          if (fs.existsSync(resolved + ext)) {
            resolvedPath = resolved + ext;
            break;
          }
        }
      }

      imports.push({
        source,
        names,
        isDefault: !!defaultImport && !defaultImport.match(/^\{/),
        isType,
        resolvedPath,
      });
    }

    return imports;
  }

  /**
   * Extract exports from file content
   */
  private static extractExports(content: string): ExportInfo[] {
    const exports: ExportInfo[] = [];

    // Export function
    const funcMatches = content.matchAll(/export\s+(async\s+)?function\s+(\w+)/g);
    for (const match of funcMatches) {
      exports.push({
        name: match[2],
        type: 'function',
        isAsync: !!match[1],
      });
    }

    // Export class
    const classMatches = content.matchAll(/export\s+class\s+(\w+)/g);
    for (const match of classMatches) {
      exports.push({
        name: match[1],
        type: 'class',
      });
    }

    // Export const/let
    const constMatches = content.matchAll(/export\s+(?:const|let)\s+(\w+)/g);
    for (const match of constMatches) {
      exports.push({
        name: match[1],
        type: 'const',
      });
    }

    // Export interface
    const interfaceMatches = content.matchAll(/export\s+interface\s+(\w+)/g);
    for (const match of interfaceMatches) {
      exports.push({
        name: match[1],
        type: 'interface',
      });
    }

    // Export type
    const typeMatches = content.matchAll(/export\s+type\s+(\w+)/g);
    for (const match of typeMatches) {
      exports.push({
        name: match[1],
        type: 'type',
      });
    }

    // Default export
    if (content.includes('export default')) {
      exports.push({
        name: 'default',
        type: 'default',
      });
    }

    return exports;
  }

  /**
   * Find related test files
   */
  private static findRelatedTests(filePath: string, workspacePath: string): string[] {
    const tests: string[] = [];
    const baseName = path.basename(filePath, path.extname(filePath));

    // Common test file patterns
    const patterns = [
      `${baseName}.test.ts`,
      `${baseName}.test.tsx`,
      `${baseName}.spec.ts`,
      `${baseName}.spec.tsx`,
      `__tests__/${baseName}.ts`,
      `__tests__/${baseName}.test.ts`,
    ];

    const baseDir = path.dirname(path.join(workspacePath, filePath));

    for (const pattern of patterns) {
      const testPath = path.join(baseDir, pattern);
      if (fs.existsSync(testPath)) {
        tests.push(path.relative(workspacePath, testPath));
      }
    }

    return tests;
  }

  /**
   * Find related type definition files
   */
  private static findRelatedTypes(content: string, filePath: string, workspacePath: string): string[] {
    const types: string[] = [];

    // Look for type imports
    const typeImports = content.matchAll(/import\s+type\s+.*from\s+['"]([^'"]+)['"]/g);

    for (const match of typeImports) {
      const source = match[1];
      if (source.startsWith('.')) {
        const resolved = path.resolve(path.dirname(filePath), source);
        const extensions = ['.ts', '.d.ts', '/index.ts', '/index.d.ts'];

        for (const ext of extensions) {
          const full = resolved + ext;
          if (fs.existsSync(full)) {
            types.push(path.relative(workspacePath, full));
            break;
          }
        }
      }
    }

    return types;
  }

  /**
   * Analyze code complexity
   */
  private static analyzeComplexity(content: string): 'simple' | 'moderate' | 'complex' {
    const lines = content.split('\n').length;
    const functions = (content.match(/function\s+\w+/g) || []).length;
    const classes = (content.match(/class\s+\w+/g) || []).length;
    const conditionals = (content.match(/if\s*\(|switch\s*\(|\?\s*:/g) || []).length;

    const score = lines / 50 + functions * 2 + classes * 5 + conditionals;

    if (score > 20) return 'complex';
    if (score > 8) return 'moderate';
    return 'simple';
  }

  /**
   * Format analysis for agent prompt
   */
  static formatForPrompt(filePath: string, workspacePath: string): string {
    const analysis = this.analyzeFile(filePath, workspacePath);
    const impact = this.analyzeImpact(filePath, workspacePath);

    let output = `
### 📊 File Analysis: ${filePath}

**Complexity**: ${analysis.complexity}
**Exports**: ${analysis.exports.map(e => `${e.name} (${e.type})`).join(', ') || 'none'}
**Dependencies**: ${analysis.dependencies.length} files
**Risk Level**: ${impact.riskLevel}

`;

    if (impact.warnings.length > 0) {
      output += `**⚠️ Warnings**:
${impact.warnings.map(w => `- ${w}`).join('\n')}

`;
    }

    if (impact.suggestedReads.length > 0) {
      output += `**📖 Suggested reads before modifying**:
${impact.suggestedReads.slice(0, 5).map(f => `- ${f}`).join('\n')}

`;
    }

    if (analysis.relatedTests.length > 0) {
      output += `**🧪 Related tests** (update these too):
${analysis.relatedTests.map(t => `- ${t}`).join('\n')}
`;
    }

    return output;
  }

  /**
   * Clear the cache
   */
  static clearCache(): void {
    this.fileCache.clear();
  }
}
