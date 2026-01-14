/**
 * DeadCodeEliminator - Dead code detection and removal service
 *
 * Identifies unused code (functions, variables, imports, exports, files)
 * and provides safe removal suggestions with dependency analysis.
 */

import * as fs from 'fs';
import * as path from 'path';

interface DeadCodeItem {
  type: DeadCodeType;
  name: string;
  file: string;
  line: number;
  code: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  safeToRemove: boolean;
  dependencies: string[];
  referencedBy: string[];
}

type DeadCodeType =
  | 'unused-function'
  | 'unused-variable'
  | 'unused-import'
  | 'unused-export'
  | 'unused-class'
  | 'unused-type'
  | 'unused-interface'
  | 'unused-file'
  | 'unreachable-code'
  | 'commented-code'
  | 'duplicate-code';

interface DeadCodeReport {
  summary: {
    totalItems: number;
    byType: Record<DeadCodeType, number>;
    safeToRemove: number;
    estimatedLinesRemovable: number;
    estimatedSizeReduction: string;
  };
  items: DeadCodeItem[];
  fileStats: FileDeadCodeStats[];
  suggestions: string[];
}

interface FileDeadCodeStats {
  file: string;
  deadCodeCount: number;
  deadCodeLines: number;
  totalLines: number;
  deadCodePercentage: number;
}

interface RemovalResult {
  success: boolean;
  removedItems: number;
  modifiedFiles: string[];
  errors: string[];
  backupPath?: string;
}

interface ReferenceMap {
  [identifier: string]: {
    definedIn: string;
    definedAt: number;
    references: Array<{ file: string; line: number }>;
  };
}

export class DeadCodeEliminator {
  private referenceMap: ReferenceMap = {};
  private exportMap: Map<string, Set<string>> = new Map(); // file -> exported symbols
  private importMap: Map<string, Map<string, string>> = new Map(); // file -> { symbol -> sourceFile }
  private backupDir: string;

  constructor(backupDir: string = '.dead-code-backups') {
    this.backupDir = backupDir;
  }

  /**
   * Analyze project for dead code
   */
  async analyzeProject(
    projectPath: string,
    options: {
      include?: string[];
      exclude?: string[];
      checkComments?: boolean;
      checkDuplicates?: boolean;
    } = {}
  ): Promise<DeadCodeReport> {
    const {
      include = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
      exclude = ['node_modules', 'dist', 'build', 'coverage', '*.test.*', '*.spec.*'],
      checkComments = true,
      checkDuplicates = false
    } = options;

    // Reset maps
    this.referenceMap = {};
    this.exportMap.clear();
    this.importMap.clear();

    // Collect files
    const files = this.collectFiles(projectPath, include, exclude);

    // First pass: build reference maps
    for (const file of files) {
      await this.buildReferenceMap(file);
    }

    // Second pass: detect dead code
    const items: DeadCodeItem[] = [];
    const fileStats: FileDeadCodeStats[] = [];

    for (const file of files) {
      const { deadItems, stats } = await this.analyzeFile(
        file,
        checkComments,
        checkDuplicates
      );
      items.push(...deadItems);
      fileStats.push(stats);
    }

    // Check for unused files
    const unusedFiles = await this.detectUnusedFiles(files);
    items.push(...unusedFiles);

    return this.generateReport(items, fileStats);
  }

  /**
   * Analyze single file for dead code
   */
  async analyzeFile(
    filePath: string,
    checkComments: boolean = true,
    checkDuplicates: boolean = false
  ): Promise<{ deadItems: DeadCodeItem[]; stats: FileDeadCodeStats }> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const deadItems: DeadCodeItem[] = [];

    // Detect unused imports
    deadItems.push(...this.detectUnusedImports(content, filePath));

    // Detect unused functions
    deadItems.push(...this.detectUnusedFunctions(content, filePath));

    // Detect unused variables
    deadItems.push(...this.detectUnusedVariables(content, filePath));

    // Detect unused exports
    deadItems.push(...this.detectUnusedExports(content, filePath));

    // Detect unused classes
    deadItems.push(...this.detectUnusedClasses(content, filePath));

    // Detect unused types/interfaces
    deadItems.push(...this.detectUnusedTypes(content, filePath));

    // Detect unreachable code
    deadItems.push(...this.detectUnreachableCode(content, filePath));

    // Optionally check for commented code
    if (checkComments) {
      deadItems.push(...this.detectCommentedCode(content, filePath));
    }

    // Optionally check for duplicates
    if (checkDuplicates) {
      deadItems.push(...this.detectDuplicateCode(content, filePath));
    }

    const deadCodeLines = deadItems.reduce((sum, item) => {
      return sum + item.code.split('\n').length;
    }, 0);

    return {
      deadItems,
      stats: {
        file: filePath,
        deadCodeCount: deadItems.length,
        deadCodeLines,
        totalLines: lines.length,
        deadCodePercentage: (deadCodeLines / lines.length) * 100
      }
    };
  }

  /**
   * Remove dead code from project
   */
  async removeDeadCode(
    _projectPath: string,
    report: DeadCodeReport,
    options: {
      dryRun?: boolean;
      onlyHighConfidence?: boolean;
      createBackup?: boolean;
      types?: DeadCodeType[];
    } = {}
  ): Promise<RemovalResult> {
    const {
      dryRun = false,
      onlyHighConfidence = true,
      createBackup = true,
      types
    } = options;

    const errors: string[] = [];
    const modifiedFiles = new Set<string>();
    let removedItems = 0;
    let backupPath: string | undefined;

    // Filter items to remove
    let itemsToRemove = report.items.filter(item => item.safeToRemove);

    if (onlyHighConfidence) {
      itemsToRemove = itemsToRemove.filter(item => item.confidence === 'high');
    }

    if (types && types.length > 0) {
      itemsToRemove = itemsToRemove.filter(item => types.includes(item.type));
    }

    if (dryRun) {
      return {
        success: true,
        removedItems: itemsToRemove.length,
        modifiedFiles: [...new Set(itemsToRemove.map(i => i.file))],
        errors: []
      };
    }

    // Create backup
    if (createBackup) {
      backupPath = await this.createBackup(itemsToRemove);
    }

    // Group by file
    const itemsByFile = new Map<string, DeadCodeItem[]>();
    for (const item of itemsToRemove) {
      const existing = itemsByFile.get(item.file) || [];
      existing.push(item);
      itemsByFile.set(item.file, existing);
    }

    // Process each file
    for (const [file, items] of itemsByFile) {
      try {
        const removed = await this.removeItemsFromFile(file, items);
        removedItems += removed;
        if (removed > 0) {
          modifiedFiles.add(file);
        }
      } catch (error: any) {
        errors.push(`Error processing ${file}: ${error.message}`);
      }
    }

    return {
      success: errors.length === 0,
      removedItems,
      modifiedFiles: Array.from(modifiedFiles),
      errors,
      backupPath
    };
  }

  /**
   * Get removal suggestions for specific item
   */
  getRemovalSuggestion(item: DeadCodeItem): string {
    const suggestions: Record<DeadCodeType, (item: DeadCodeItem) => string> = {
      'unused-function': (i) =>
        `Remove function '${i.name}' at ${path.basename(i.file)}:${i.line}`,
      'unused-variable': (i) =>
        `Remove variable '${i.name}' at ${path.basename(i.file)}:${i.line}`,
      'unused-import': (i) =>
        `Remove import '${i.name}' from ${path.basename(i.file)}`,
      'unused-export': (i) =>
        `Remove export of '${i.name}' or keep as internal at ${path.basename(i.file)}`,
      'unused-class': (i) =>
        `Remove class '${i.name}' at ${path.basename(i.file)}:${i.line}`,
      'unused-type': (i) =>
        `Remove type '${i.name}' at ${path.basename(i.file)}:${i.line}`,
      'unused-interface': (i) =>
        `Remove interface '${i.name}' at ${path.basename(i.file)}:${i.line}`,
      'unused-file': (i) =>
        `Consider deleting file ${path.basename(i.file)} (not imported anywhere)`,
      'unreachable-code': (i) =>
        `Remove unreachable code after ${i.reason} at ${path.basename(i.file)}:${i.line}`,
      'commented-code': (i) =>
        `Remove commented-out code at ${path.basename(i.file)}:${i.line}`,
      'duplicate-code': (i) =>
        `Extract duplicate code into shared function at ${path.basename(i.file)}:${i.line}`
    };

    return suggestions[item.type]?.(item) || `Remove ${item.type}: ${item.name}`;
  }

  /**
   * Format report as markdown
   */
  formatReport(report: DeadCodeReport): string {
    const lines: string[] = [
      '# Dead Code Analysis Report',
      '',
      '## Summary',
      '',
      `- **Total Dead Code Items:** ${report.summary.totalItems}`,
      `- **Safe to Remove:** ${report.summary.safeToRemove}`,
      `- **Estimated Lines Removable:** ${report.summary.estimatedLinesRemovable}`,
      `- **Estimated Size Reduction:** ${report.summary.estimatedSizeReduction}`,
      '',
      '### By Type',
      ''
    ];

    for (const [type, count] of Object.entries(report.summary.byType)) {
      if (count > 0) {
        lines.push(`- **${type}:** ${count}`);
      }
    }

    lines.push('', '## Files with Most Dead Code', '');

    const topFiles = report.fileStats
      .sort((a, b) => b.deadCodePercentage - a.deadCodePercentage)
      .slice(0, 10);

    lines.push('| File | Dead Code % | Items | Lines |');
    lines.push('|------|-------------|-------|-------|');

    for (const stat of topFiles) {
      if (stat.deadCodeCount > 0) {
        lines.push(
          `| ${path.basename(stat.file)} | ${stat.deadCodePercentage.toFixed(1)}% | ${stat.deadCodeCount} | ${stat.deadCodeLines} |`
        );
      }
    }

    // High-confidence items
    const highConfidence = report.items.filter(i => i.confidence === 'high' && i.safeToRemove);
    if (highConfidence.length > 0) {
      lines.push('', '## Safe to Remove (High Confidence)', '');
      for (const item of highConfidence.slice(0, 20)) {
        lines.push(`- ${this.getRemovalSuggestion(item)}`);
      }
      if (highConfidence.length > 20) {
        lines.push(`- ... and ${highConfidence.length - 20} more`);
      }
    }

    // Suggestions
    lines.push('', '## Recommendations', '');
    for (const suggestion of report.suggestions) {
      lines.push(`- ${suggestion}`);
    }

    return lines.join('\n');
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupPath: string): Promise<boolean> {
    if (!fs.existsSync(backupPath)) {
      throw new Error(`Backup not found: ${backupPath}`);
    }

    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(backupPath, 'manifest.json'), 'utf-8')
      );

      for (const entry of manifest.files) {
        const backupFile = path.join(backupPath, entry.backupName);
        if (fs.existsSync(backupFile)) {
          fs.copyFileSync(backupFile, entry.originalPath);
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  // Private helper methods

  private async buildReferenceMap(filePath: string): Promise<void> {
    const content = fs.readFileSync(filePath, 'utf-8');

    // Track exports
    const exports = new Set<string>();

    // Named exports
    const namedExports = content.matchAll(/export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g);
    for (const match of namedExports) {
      exports.add(match[1]);
      this.addDefinition(match[1], filePath, this.getLineNumber(content, match.index!));
    }

    // Export statements
    const exportStatements = content.matchAll(/export\s+\{\s*([^}]+)\s*\}/g);
    for (const match of exportStatements) {
      const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
      for (const name of names) {
        exports.add(name);
      }
    }

    // Default exports
    if (/export\s+default/.test(content)) {
      exports.add('default');
    }

    this.exportMap.set(filePath, exports);

    // Track imports
    const fileImports = new Map<string, string>();

    const importMatches = content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of importMatches) {
      const source = match[4];
      if (match[1]) {
        // Named imports
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
        for (const name of names) {
          fileImports.set(name, source);
          this.addReference(name, filePath, this.getLineNumber(content, match.index!));
        }
      } else if (match[2]) {
        // Default import
        fileImports.set(match[2], source);
        this.addReference(match[2], filePath, this.getLineNumber(content, match.index!));
      } else if (match[3]) {
        // Namespace import
        fileImports.set(match[3], source);
      }
    }

    this.importMap.set(filePath, fileImports);

    // Track internal references (function calls, variable usage)
    const identifierPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\b/g;
    let idMatch;
    while ((idMatch = identifierPattern.exec(content)) !== null) {
      const identifier = idMatch[1];
      // Skip keywords
      if (this.isKeyword(identifier)) continue;

      this.addReference(identifier, filePath, this.getLineNumber(content, idMatch.index));
    }
  }

  private addDefinition(name: string, file: string, line: number): void {
    if (!this.referenceMap[name]) {
      this.referenceMap[name] = {
        definedIn: file,
        definedAt: line,
        references: []
      };
    }
  }

  private addReference(name: string, file: string, line: number): void {
    if (!this.referenceMap[name]) {
      this.referenceMap[name] = {
        definedIn: '',
        definedAt: 0,
        references: []
      };
    }
    this.referenceMap[name].references.push({ file, line });
  }

  private getLineNumber(content: string, index: number): number {
    return content.slice(0, index).split('\n').length;
  }

  private isKeyword(word: string): boolean {
    const keywords = new Set([
      'const', 'let', 'var', 'function', 'class', 'interface', 'type', 'enum',
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
      'return', 'throw', 'try', 'catch', 'finally', 'new', 'delete', 'typeof',
      'instanceof', 'void', 'this', 'super', 'import', 'export', 'from', 'as',
      'default', 'async', 'await', 'yield', 'static', 'public', 'private',
      'protected', 'readonly', 'abstract', 'implements', 'extends', 'true',
      'false', 'null', 'undefined', 'NaN', 'Infinity'
    ]);
    return keywords.has(word);
  }

  private detectUnusedImports(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    // Find all imports
    const importMatches = content.matchAll(/import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/g);

    for (const match of importMatches) {
      const lineNum = this.getLineNumber(content, match.index!);
      const importedNames: string[] = [];

      if (match[1]) {
        // Named imports
        importedNames.push(...match[1].split(',').map(n => {
          const parts = n.trim().split(/\s+as\s+/);
          return parts[parts.length - 1]; // Use alias if present
        }));
      } else if (match[2]) {
        // Default import
        importedNames.push(match[2]);
      }

      for (const name of importedNames) {
        if (!name.trim()) continue;

        // Check if used elsewhere in the file (not in import statement)
        const restOfContent = content.slice(match.index! + match[0].length);
        const usagePattern = new RegExp(`\\b${name}\\b`);

        if (!usagePattern.test(restOfContent)) {
          items.push({
            type: 'unused-import',
            name,
            file: filePath,
            line: lineNum,
            code: match[0],
            confidence: 'high',
            reason: 'Import is not used in this file',
            safeToRemove: true,
            dependencies: [],
            referencedBy: []
          });
        }
      }
    }

    return items;
  }

  private detectUnusedFunctions(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    // Function declarations
    const functionMatches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\([^)]*\)/g);

    for (const match of functionMatches) {
      const name = match[1];
      const lineNum = this.getLineNumber(content, match.index!);
      const isExported = match[0].startsWith('export');

      // Check references
      const refs = this.referenceMap[name];
      const usageCount = refs?.references.filter(r =>
        r.file !== filePath || r.line !== lineNum
      ).length || 0;

      // If not exported and not used, it's dead
      if (!isExported && usageCount === 0) {
        items.push({
          type: 'unused-function',
          name,
          file: filePath,
          line: lineNum,
          code: this.extractFunctionCode(content, match.index!),
          confidence: 'high',
          reason: 'Function is never called',
          safeToRemove: true,
          dependencies: [],
          referencedBy: []
        });
      } else if (isExported && usageCount === 0) {
        // Exported but never imported anywhere
        items.push({
          type: 'unused-export',
          name,
          file: filePath,
          line: lineNum,
          code: match[0],
          confidence: 'medium',
          reason: 'Exported but never imported',
          safeToRemove: false, // Could be used externally
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private detectUnusedVariables(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    // Const/let/var declarations
    const varMatches = content.matchAll(/(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g);

    for (const match of varMatches) {
      const name = match[1];
      const lineNum = this.getLineNumber(content, match.index!);
      const isExported = match[0].startsWith('export');

      // Skip if starts with underscore (intentionally unused)
      if (name.startsWith('_')) continue;

      // Check references
      const refs = this.referenceMap[name];
      const usageCount = refs?.references.filter(r =>
        r.file !== filePath || r.line !== lineNum
      ).length || 0;

      if (!isExported && usageCount <= 1) { // 1 = the declaration itself
        items.push({
          type: 'unused-variable',
          name,
          file: filePath,
          line: lineNum,
          code: this.extractLineCode(content, match.index!),
          confidence: 'high',
          reason: 'Variable is declared but never used',
          safeToRemove: true,
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private detectUnusedExports(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];
    const exports = this.exportMap.get(filePath) || new Set();

    for (const exportName of exports) {
      if (exportName === 'default') continue;

      // Check if any other file imports this
      let isImported = false;
      for (const [file, imports] of this.importMap) {
        if (file === filePath) continue;
        for (const [name, source] of imports) {
          // Check if source resolves to this file
          if (name === exportName && this.resolveImport(source, file) === filePath) {
            isImported = true;
            break;
          }
        }
        if (isImported) break;
      }

      if (!isImported) {
        const match = content.match(new RegExp(`export\\s+(?:const|let|var|function|class)\\s+${exportName}`));
        if (match) {
          items.push({
            type: 'unused-export',
            name: exportName,
            file: filePath,
            line: this.getLineNumber(content, content.indexOf(match[0])),
            code: match[0],
            confidence: 'medium',
            reason: 'Export is not imported by any file in the project',
            safeToRemove: false,
            dependencies: [],
            referencedBy: []
          });
        }
      }
    }

    return items;
  }

  private detectUnusedClasses(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    const classMatches = content.matchAll(/(?:export\s+)?class\s+(\w+)/g);

    for (const match of classMatches) {
      const name = match[1];
      const lineNum = this.getLineNumber(content, match.index!);
      const isExported = match[0].startsWith('export');

      const refs = this.referenceMap[name];
      const usageCount = refs?.references.filter(r =>
        r.file !== filePath || r.line !== lineNum
      ).length || 0;

      if (!isExported && usageCount === 0) {
        items.push({
          type: 'unused-class',
          name,
          file: filePath,
          line: lineNum,
          code: this.extractClassCode(content, match.index!),
          confidence: 'high',
          reason: 'Class is never instantiated or referenced',
          safeToRemove: true,
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private detectUnusedTypes(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    // Types and interfaces
    const typeMatches = content.matchAll(/(?:export\s+)?(?:type|interface)\s+(\w+)/g);

    for (const match of typeMatches) {
      const name = match[1];
      const lineNum = this.getLineNumber(content, match.index!);
      const isExported = match[0].startsWith('export');

      const refs = this.referenceMap[name];
      const usageCount = refs?.references.filter(r =>
        r.file !== filePath || r.line !== lineNum
      ).length || 0;

      if (!isExported && usageCount === 0) {
        items.push({
          type: match[0].includes('interface') ? 'unused-interface' : 'unused-type',
          name,
          file: filePath,
          line: lineNum,
          code: this.extractTypeCode(content, match.index!),
          confidence: 'high',
          reason: `${match[0].includes('interface') ? 'Interface' : 'Type'} is never used`,
          safeToRemove: true,
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private detectUnreachableCode(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Code after return/throw/break/continue
      if (/^(return|throw|break|continue)\b/.test(line)) {
        // Check next non-empty, non-comment line
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (!nextLine || nextLine.startsWith('//') || nextLine.startsWith('/*')) continue;
          if (nextLine === '}' || nextLine === '});') break;

          // Found unreachable code
          items.push({
            type: 'unreachable-code',
            name: 'unreachable',
            file: filePath,
            line: j + 1,
            code: nextLine,
            confidence: 'high',
            reason: `Code after ${line.split(/\s/)[0]} statement`,
            safeToRemove: true,
            dependencies: [],
            referencedBy: []
          });
          break;
        }
      }
    }

    return items;
  }

  private detectCommentedCode(content: string, filePath: string): DeadCodeItem[] {
    const items: DeadCodeItem[] = [];

    // Multi-line comments that look like code
    const multiLineComments = content.matchAll(/\/\*[\s\S]*?\*\//g);
    for (const match of multiLineComments) {
      const comment = match[0];
      if (this.looksLikeCode(comment)) {
        items.push({
          type: 'commented-code',
          name: 'commented-code',
          file: filePath,
          line: this.getLineNumber(content, match.index!),
          code: comment.slice(0, 100) + (comment.length > 100 ? '...' : ''),
          confidence: 'medium',
          reason: 'Commented-out code should be removed (use version control)',
          safeToRemove: true,
          dependencies: [],
          referencedBy: []
        });
      }
    }

    // Single-line comments that look like code
    const lines = content.split('\n');
    let commentBlock: string[] = [];
    let commentStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//')) {
        if (commentBlock.length === 0) commentStart = i;
        commentBlock.push(line.slice(2).trim());
      } else {
        if (commentBlock.length >= 2) {
          const block = commentBlock.join('\n');
          if (this.looksLikeCode(block)) {
            items.push({
              type: 'commented-code',
              name: 'commented-code',
              file: filePath,
              line: commentStart + 1,
              code: block.slice(0, 100) + (block.length > 100 ? '...' : ''),
              confidence: 'low',
              reason: 'Consecutive comments that look like code',
              safeToRemove: false,
              dependencies: [],
              referencedBy: []
            });
          }
        }
        commentBlock = [];
      }
    }

    return items;
  }

  private detectDuplicateCode(content: string, filePath: string): DeadCodeItem[] {
    // Simplified duplicate detection
    const items: DeadCodeItem[] = [];
    const lines = content.split('\n');
    const chunks: Map<string, number[]> = new Map();

    // Create 5-line chunks
    for (let i = 0; i < lines.length - 5; i++) {
      const chunk = lines.slice(i, i + 5).map(l => l.trim()).join('\n');
      if (chunk.length < 50) continue; // Skip small chunks

      const existing = chunks.get(chunk) || [];
      existing.push(i + 1);
      chunks.set(chunk, existing);
    }

    // Find duplicates
    for (const [chunk, positions] of chunks) {
      if (positions.length > 1) {
        items.push({
          type: 'duplicate-code',
          name: 'duplicate',
          file: filePath,
          line: positions[0],
          code: chunk.slice(0, 100) + '...',
          confidence: 'low',
          reason: `Same code appears ${positions.length} times (lines: ${positions.join(', ')})`,
          safeToRemove: false,
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private async detectUnusedFiles(files: string[]): Promise<DeadCodeItem[]> {
    const items: DeadCodeItem[] = [];

    for (const file of files) {
      // Skip entry points, tests, configs
      const basename = path.basename(file);
      if (
        basename === 'index.ts' ||
        basename === 'index.js' ||
        basename.includes('.test.') ||
        basename.includes('.spec.') ||
        basename.includes('config')
      ) {
        continue;
      }

      // Check if any other file imports this
      let isImported = false;
      for (const [importingFile, imports] of this.importMap) {
        if (importingFile === file) continue;
        for (const [, source] of imports) {
          if (this.resolveImport(source, importingFile) === file) {
            isImported = true;
            break;
          }
        }
        if (isImported) break;
      }

      if (!isImported) {
        const content = fs.readFileSync(file, 'utf-8');
        items.push({
          type: 'unused-file',
          name: path.basename(file),
          file,
          line: 1,
          code: `File: ${path.basename(file)} (${content.split('\n').length} lines)`,
          confidence: 'low',
          reason: 'File is not imported by any other file',
          safeToRemove: false, // Could be an entry point
          dependencies: [],
          referencedBy: []
        });
      }
    }

    return items;
  }

  private looksLikeCode(text: string): boolean {
    const codePatterns = [
      /\bfunction\s+\w+/,
      /\bconst\s+\w+\s*=/,
      /\blet\s+\w+\s*=/,
      /\bif\s*\([^)]+\)\s*\{/,
      /\breturn\s+/,
      /\bawait\s+/,
      /\w+\.\w+\(/,
      /=>\s*\{/
    ];

    return codePatterns.some(p => p.test(text));
  }

  private extractFunctionCode(content: string, startIndex: number): string {
    let braceCount = 0;
    let started = false;
    let endIndex = startIndex;

    for (let i = startIndex; i < content.length; i++) {
      if (content[i] === '{') {
        braceCount++;
        started = true;
      }
      if (content[i] === '}') {
        braceCount--;
      }
      if (started && braceCount === 0) {
        endIndex = i + 1;
        break;
      }
    }

    return content.slice(startIndex, endIndex);
  }

  private extractClassCode(content: string, startIndex: number): string {
    return this.extractFunctionCode(content, startIndex);
  }

  private extractTypeCode(content: string, startIndex: number): string {
    // Types end at ; or next declaration
    const endMatch = content.slice(startIndex).match(/[;}\n](?=\s*(?:export|type|interface|const|let|var|function|class|$))/);
    const endIndex = endMatch ? startIndex + endMatch.index! + 1 : startIndex + 200;
    return content.slice(startIndex, endIndex);
  }

  private extractLineCode(content: string, startIndex: number): string {
    const lineEnd = content.indexOf('\n', startIndex);
    return content.slice(startIndex, lineEnd > 0 ? lineEnd : startIndex + 100);
  }

  private resolveImport(source: string, fromFile: string): string {
    if (source.startsWith('.')) {
      const dir = path.dirname(fromFile);
      let resolved = path.resolve(dir, source);

      // Try with extensions
      const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        if (fs.existsSync(resolved + ext)) {
          return resolved + ext;
        }
      }
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    }
    return source;
  }

  private async removeItemsFromFile(filePath: string, items: DeadCodeItem[]): Promise<number> {
    let content = fs.readFileSync(filePath, 'utf-8');
    let removed = 0;

    // Sort by line number descending to preserve positions
    const sortedItems = [...items].sort((a, b) => b.line - a.line);

    for (const item of sortedItems) {
      const lines = content.split('\n');

      if (item.type === 'unused-import') {
        // Remove entire import line or just the specific import
        const lineIndex = item.line - 1;
        if (lineIndex < lines.length) {
          lines.splice(lineIndex, 1);
          content = lines.join('\n');
          removed++;
        }
      } else if (item.type === 'commented-code' || item.type === 'unreachable-code') {
        // Remove the specific code
        content = content.replace(item.code, '');
        removed++;
      }
      // For functions, classes, etc., more careful removal would be needed
    }

    if (removed > 0) {
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    return removed;
  }

  private async createBackup(items: DeadCodeItem[]): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupDir, `backup-${timestamp}`);

    fs.mkdirSync(backupPath, { recursive: true });

    const filesToBackup = new Set(items.map(i => i.file));
    const manifest: { files: Array<{ originalPath: string; backupName: string }> } = {
      files: []
    };

    for (const file of filesToBackup) {
      const backupName = path.basename(file) + '.bak';
      fs.copyFileSync(file, path.join(backupPath, backupName));
      manifest.files.push({ originalPath: file, backupName });
    }

    fs.writeFileSync(
      path.join(backupPath, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return backupPath;
  }

  private collectFiles(
    dir: string,
    include: string[],
    exclude: string[]
  ): string[] {
    const files: string[] = [];

    const walk = (currentDir: string) => {
      if (!fs.existsSync(currentDir)) return;

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!exclude.some(ex => entry.name === ex || entry.name.includes(ex))) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(entry.name);
          const matchesInclude = include.some(inc =>
            inc.includes(ext) || entry.name.endsWith(inc.replace('**/*', ''))
          );
          const matchesExclude = exclude.some(ex =>
            entry.name.includes(ex.replace('*', ''))
          );

          if (matchesInclude && !matchesExclude) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dir);
    return files;
  }

  private generateReport(items: DeadCodeItem[], fileStats: FileDeadCodeStats[]): DeadCodeReport {
    const byType: Record<DeadCodeType, number> = {
      'unused-function': 0,
      'unused-variable': 0,
      'unused-import': 0,
      'unused-export': 0,
      'unused-class': 0,
      'unused-type': 0,
      'unused-interface': 0,
      'unused-file': 0,
      'unreachable-code': 0,
      'commented-code': 0,
      'duplicate-code': 0
    };

    for (const item of items) {
      byType[item.type]++;
    }

    const safeToRemove = items.filter(i => i.safeToRemove).length;
    const estimatedLines = items.reduce((sum, i) => sum + i.code.split('\n').length, 0);

    const suggestions: string[] = [];
    if (byType['unused-import'] > 10) {
      suggestions.push('Consider using an auto-import tool to manage imports');
    }
    if (byType['commented-code'] > 5) {
      suggestions.push('Remove commented code and rely on version control for history');
    }
    if (byType['unused-export'] > 10) {
      suggestions.push('Review public API - many exports are unused');
    }

    return {
      summary: {
        totalItems: items.length,
        byType,
        safeToRemove,
        estimatedLinesRemovable: estimatedLines,
        estimatedSizeReduction: `~${Math.round(estimatedLines * 50 / 1024)}KB`
      },
      items,
      fileStats,
      suggestions
    };
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## DeadCodeEliminator - Dead Code Detection

Identifies and removes unused code from the codebase.

### Detected Types
- **unused-function**: Functions never called
- **unused-variable**: Variables declared but not used
- **unused-import**: Imports not referenced
- **unused-export**: Exports never imported
- **unused-class**: Classes never instantiated
- **unused-type/interface**: Types never used
- **unused-file**: Files not imported anywhere
- **unreachable-code**: Code after return/throw
- **commented-code**: Commented-out code blocks

### Methods
- \`analyzeProject(path, options)\`: Full project analysis
- \`analyzeFile(path)\`: Single file analysis
- \`removeDeadCode(path, report, options)\`: Remove dead code
- \`restoreFromBackup(backupPath)\`: Undo removal

### Options
- \`dryRun\`: Preview without changes
- \`onlyHighConfidence\`: Only remove high-confidence items
- \`createBackup\`: Backup before removal
- \`types\`: Specific types to target

### Confidence Levels
- **high**: Safe to remove automatically
- **medium**: Review recommended
- **low**: Manual review required

### Best Practices
- Run analysis before major changes
- Start with high-confidence items
- Always create backups
- Review exports carefully (may be used externally)
    `;
  }
}
