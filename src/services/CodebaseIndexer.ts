/**
 * CodebaseIndexer - Pre-computed codebase index for instant searches
 *
 * Unlike Claude Code which explores on-demand, we PRE-INDEX the codebase
 * for instant retrieval. This is a key differentiator.
 *
 * Indexes:
 * 1. File structure and metadata
 * 2. Symbols (functions, classes, interfaces, types)
 * 3. Import/export relationships
 * 4. Code patterns and idioms
 * 5. Test coverage mapping
 * 6. Documentation
 *
 * The index is incrementally updated on file changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import * as crypto from 'crypto';

// ==================== TYPES ====================

export interface FileIndex {
  path: string;
  relativePath: string;
  size: number;
  mtime: number;
  hash: string;
  language: string;
  symbols: SymbolInfo[];
  imports: ImportInfo[];
  exports: ExportInfo[];
  testFile?: string;
  testedBy?: string[];
  docstrings: DocString[];
  complexity: number;
  lines: number;
}

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  visibility: 'public' | 'private' | 'protected';
  async: boolean;
  static: boolean;
  exported: boolean;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'method'
  | 'property';

export interface ImportInfo {
  source: string;
  specifiers: string[];
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
}

export interface ExportInfo {
  name: string;
  kind: 'named' | 'default' | 'all';
  source?: string;
  line: number;
}

export interface DocString {
  text: string;
  line: number;
  symbol?: string;
}

export interface CodebaseStats {
  totalFiles: number;
  totalLines: number;
  byLanguage: Record<string, number>;
  totalSymbols: number;
  avgComplexity: number;
  lastIndexed: Date;
  indexDuration: number;
}

export interface SearchResult {
  type: 'file' | 'symbol' | 'import' | 'content';
  file: FileIndex;
  match: string;
  line?: number;
  score: number;
  context?: string;
}

// ==================== INDEX STORAGE ====================

interface IndexData {
  version: string;
  root: string;
  created: Date;
  updated: Date;
  files: Map<string, FileIndex>;
  symbolIndex: Map<string, string[]>;  // symbol -> files
  importIndex: Map<string, string[]>;  // module -> files that import it
  stats: CodebaseStats;
}

// ==================== IMPLEMENTATION ====================

export class CodebaseIndexer {
  private static instance: CodebaseIndexer | null = null;

  private root: string;
  private index: IndexData | null = null;
  private indexPath: string;
  private isIndexing: boolean = false;
  private fileWatchers: Map<string, fs.FSWatcher> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingUpdates: Set<string> = new Set();

  private constructor(root: string = process.cwd()) {
    this.root = root;
    this.indexPath = path.join(root, '.codebase-index.json');
  }

  static getInstance(root?: string): CodebaseIndexer {
    if (!this.instance) {
      this.instance = new CodebaseIndexer(root);
    }
    return this.instance;
  }

  /**
   * Initialize or load the index
   */
  async initialize(): Promise<void> {
    // Try to load existing index
    if (fs.existsSync(this.indexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.index = this.deserializeIndex(data);

        // Check if index is stale (older than 1 hour)
        const age = Date.now() - new Date(this.index.updated).getTime();
        if (age > 60 * 60 * 1000) {
          await this.refresh();
        }
      } catch {
        await this.buildIndex();
      }
    } else {
      await this.buildIndex();
    }

    // Start watching for changes
    this.startWatching();
  }

  /**
   * Build complete index from scratch
   */
  async buildIndex(): Promise<void> {
    if (this.isIndexing) return;
    this.isIndexing = true;

    const startTime = Date.now();

    const files = await glob('**/*.{ts,tsx,js,jsx,py,go,rs,java}', {
      cwd: this.root,
      ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
      absolute: false
    });

    const fileIndex = new Map<string, FileIndex>();
    const symbolIndex = new Map<string, string[]>();
    const importIndex = new Map<string, string[]>();

    let totalLines = 0;
    let totalSymbols = 0;
    let totalComplexity = 0;
    const byLanguage: Record<string, number> = {};

    for (const file of files) {
      try {
        const indexed = await this.indexFile(path.join(this.root, file));
        fileIndex.set(indexed.relativePath, indexed);

        // Update stats
        totalLines += indexed.lines;
        totalSymbols += indexed.symbols.length;
        totalComplexity += indexed.complexity;
        byLanguage[indexed.language] = (byLanguage[indexed.language] || 0) + 1;

        // Build symbol index
        for (const symbol of indexed.symbols) {
          const existing = symbolIndex.get(symbol.name) || [];
          existing.push(indexed.relativePath);
          symbolIndex.set(symbol.name, existing);
        }

        // Build import index
        for (const imp of indexed.imports) {
          const existing = importIndex.get(imp.source) || [];
          existing.push(indexed.relativePath);
          importIndex.set(imp.source, existing);
        }
      } catch {
        // Skip files that can't be indexed
      }
    }

    // Build test mapping
    this.buildTestMapping(fileIndex);

    this.index = {
      version: '1.0.0',
      root: this.root,
      created: new Date(),
      updated: new Date(),
      files: fileIndex,
      symbolIndex,
      importIndex,
      stats: {
        totalFiles: files.length,
        totalLines,
        byLanguage,
        totalSymbols,
        avgComplexity: totalComplexity / files.length,
        lastIndexed: new Date(),
        indexDuration: Date.now() - startTime
      }
    };

    // Save index
    await this.saveIndex();
    this.isIndexing = false;
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string): Promise<FileIndex> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const stats = fs.statSync(filePath);
    const lines = content.split('\n');

    const language = this.detectLanguage(filePath);
    const symbols = this.extractSymbols(content, language);
    const imports = this.extractImports(content, language);
    const exports = this.extractExports(content, language);
    const docstrings = this.extractDocstrings(content, language);
    const complexity = this.calculateComplexity(content, language);

    return {
      path: filePath,
      relativePath: path.relative(this.root, filePath),
      size: stats.size,
      mtime: stats.mtime.getTime(),
      hash: crypto.createHash('md5').update(content).digest('hex'),
      language,
      symbols,
      imports,
      exports,
      docstrings,
      complexity,
      lines: lines.length
    };
  }

  /**
   * Detect language from file extension
   */
  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mapping: Record<string, string> = {
      '.ts': 'typescript',
      '.tsx': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascript',
      '.py': 'python',
      '.go': 'go',
      '.rs': 'rust',
      '.java': 'java'
    };
    return mapping[ext] || 'unknown';
  }

  /**
   * Extract symbols from code
   */
  private extractSymbols(content: string, language: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const lines = content.split('\n');

    if (language === 'typescript' || language === 'javascript') {
      // Functions
      const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
      let match;
      while ((match = funcPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: match[1],
          kind: 'function',
          line,
          endLine: this.findEndLine(lines, line - 1),
          async: match[0].includes('async'),
          visibility: 'public',
          static: false,
          exported: match[0].includes('export')
        });
      }

      // Classes
      const classPattern = /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g;
      while ((match = classPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: match[1],
          kind: 'class',
          line,
          endLine: this.findEndLine(lines, line - 1),
          async: false,
          visibility: 'public',
          static: false,
          exported: match[0].includes('export')
        });
      }

      // Interfaces
      const interfacePattern = /(?:export\s+)?interface\s+(\w+)/g;
      while ((match = interfacePattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: match[1],
          kind: 'interface',
          line,
          endLine: this.findEndLine(lines, line - 1),
          async: false,
          visibility: 'public',
          static: false,
          exported: match[0].includes('export')
        });
      }

      // Types
      const typePattern = /(?:export\s+)?type\s+(\w+)/g;
      while ((match = typePattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: match[1],
          kind: 'type',
          line,
          endLine: line,
          async: false,
          visibility: 'public',
          static: false,
          exported: match[0].includes('export')
        });
      }

      // Arrow functions (const name = async () => ...)
      const arrowPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/g;
      while ((match = arrowPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        symbols.push({
          name: match[1],
          kind: 'function',
          line,
          endLine: this.findEndLine(lines, line - 1),
          async: match[0].includes('async'),
          visibility: 'public',
          static: false,
          exported: match[0].includes('export')
        });
      }
    }

    return symbols;
  }

  /**
   * Extract imports from code
   */
  private extractImports(content: string, language: string): ImportInfo[] {
    const imports: ImportInfo[] = [];

    if (language === 'typescript' || language === 'javascript') {
      // ES imports
      const importPattern = /import\s+(?:(\w+)(?:\s*,\s*)?)?(?:\{([^}]+)\})?\s*(?:\*\s+as\s+(\w+))?\s*from\s+['"]([^'"]+)['"]/g;
      let match;
      while ((match = importPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        const specifiers: string[] = [];

        if (match[1]) specifiers.push(match[1]); // default import
        if (match[2]) specifiers.push(...match[2].split(',').map(s => s.trim().split(' ')[0]));
        if (match[3]) specifiers.push(match[3]); // namespace import

        imports.push({
          source: match[4],
          specifiers,
          isDefault: !!match[1],
          isNamespace: !!match[3],
          line
        });
      }

      // require()
      const requirePattern = /(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
      while ((match = requirePattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        const specifiers = match[1]
          ? match[1].split(',').map(s => s.trim())
          : [match[2]];

        imports.push({
          source: match[3],
          specifiers,
          isDefault: !match[1],
          isNamespace: false,
          line
        });
      }
    }

    return imports;
  }

  /**
   * Extract exports from code
   */
  private extractExports(content: string, language: string): ExportInfo[] {
    const exports: ExportInfo[] = [];

    if (language === 'typescript' || language === 'javascript') {
      // export default
      const defaultPattern = /export\s+default\s+(?:class\s+)?(\w+)/g;
      let match;
      while ((match = defaultPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        exports.push({ name: match[1], kind: 'default', line });
      }

      // named exports
      const namedPattern = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g;
      while ((match = namedPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        exports.push({ name: match[1], kind: 'named', line });
      }

      // export { ... }
      const bracketPattern = /export\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/g;
      while ((match = bracketPattern.exec(content)) !== null) {
        const line = content.substring(0, match.index).split('\n').length;
        const names = match[1].split(',').map(s => s.trim().split(' ')[0]);
        for (const name of names) {
          exports.push({
            name,
            kind: 'named',
            source: match[2],
            line
          });
        }
      }
    }

    return exports;
  }

  /**
   * Extract docstrings/comments
   */
  private extractDocstrings(content: string, _language: string): DocString[] {
    const docs: DocString[] = [];

    // JSDoc style
    const jsdocPattern = /\/\*\*\s*([\s\S]*?)\s*\*\//g;
    let match;
    while ((match = jsdocPattern.exec(content)) !== null) {
      const line = content.substring(0, match.index).split('\n').length;
      docs.push({
        text: match[1].replace(/\s*\*\s*/g, ' ').trim(),
        line
      });
    }

    return docs;
  }

  /**
   * Calculate cyclomatic complexity
   */
  private calculateComplexity(content: string, _language: string): number {
    let complexity = 1;

    // Count decision points
    const patterns = [
      /\bif\s*\(/g,
      /\belse\s+if\s*\(/g,
      /\bwhile\s*\(/g,
      /\bfor\s*\(/g,
      /\bswitch\s*\(/g,
      /\bcase\s+/g,
      /\bcatch\s*\(/g,
      /\?\s*[^:]+\s*:/g,  // ternary
      /&&/g,
      /\|\|/g
    ];

    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) complexity += matches.length;
    }

    return complexity;
  }

  /**
   * Find the end line of a block
   */
  private findEndLine(lines: string[], startLine: number): number {
    let braceCount = 0;
    let started = false;

    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];

      for (const char of line) {
        if (char === '{') {
          braceCount++;
          started = true;
        } else if (char === '}') {
          braceCount--;
          if (started && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return startLine + 1;
  }

  /**
   * Build test file mapping
   */
  private buildTestMapping(files: Map<string, FileIndex>): void {
    for (const [filePath, file] of files) {
      // Is this a test file?
      if (filePath.includes('.test.') || filePath.includes('.spec.')) {
        // Find the source file it tests
        const baseName = path.basename(filePath)
          .replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/, '');

        for (const [sourcePath, sourceFile] of files) {
          if (sourcePath.includes(baseName) &&
              !sourcePath.includes('.test.') &&
              !sourcePath.includes('.spec.')) {
            sourceFile.testedBy = sourceFile.testedBy || [];
            sourceFile.testedBy.push(filePath);
            file.testFile = sourcePath;
            break;
          }
        }
      }
    }
  }

  // ==================== SEARCH METHODS ====================

  /**
   * Search for a symbol by name
   */
  searchSymbol(query: string): SearchResult[] {
    if (!this.index) return [];

    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const [_filePath, file] of this.index.files) {
      for (const symbol of file.symbols) {
        if (symbol.name.toLowerCase().includes(queryLower)) {
          const score = symbol.name.toLowerCase() === queryLower ? 1 :
                       symbol.name.toLowerCase().startsWith(queryLower) ? 0.8 : 0.5;

          results.push({
            type: 'symbol',
            file,
            match: symbol.name,
            line: symbol.line,
            score,
            context: `${symbol.kind}: ${symbol.name}`
          });
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Search for files by pattern
   */
  searchFiles(query: string): SearchResult[] {
    if (!this.index) return [];

    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const [filePath, file] of this.index.files) {
      if (filePath.toLowerCase().includes(queryLower)) {
        const score = path.basename(filePath).toLowerCase().includes(queryLower) ? 1 : 0.5;

        results.push({
          type: 'file',
          file,
          match: filePath,
          score
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Find files that import a module
   */
  findImporters(moduleName: string): string[] {
    if (!this.index) return [];
    return this.index.importIndex.get(moduleName) || [];
  }

  /**
   * Find files containing a symbol
   */
  findSymbolLocations(symbolName: string): string[] {
    if (!this.index) return [];
    return this.index.symbolIndex.get(symbolName) || [];
  }

  /**
   * Get file by path
   */
  getFile(filePath: string): FileIndex | undefined {
    if (!this.index) return undefined;
    const relative = path.relative(this.root, filePath);
    return this.index.files.get(relative);
  }

  /**
   * Get all files
   */
  getAllFiles(): FileIndex[] {
    if (!this.index) return [];
    return Array.from(this.index.files.values());
  }

  /**
   * Get statistics
   */
  getStats(): CodebaseStats | null {
    return this.index?.stats || null;
  }

  // ==================== PERSISTENCE ====================

  /**
   * Save index to disk
   */
  private async saveIndex(): Promise<void> {
    if (!this.index) return;

    const serialized = {
      ...this.index,
      files: Array.from(this.index.files.entries()),
      symbolIndex: Array.from(this.index.symbolIndex.entries()),
      importIndex: Array.from(this.index.importIndex.entries())
    };

    fs.writeFileSync(this.indexPath, JSON.stringify(serialized, null, 2));
  }

  /**
   * Deserialize index from disk
   */
  private deserializeIndex(data: any): IndexData {
    return {
      ...data,
      files: new Map(data.files),
      symbolIndex: new Map(data.symbolIndex),
      importIndex: new Map(data.importIndex)
    };
  }

  // ==================== WATCHING ====================

  /**
   * Start watching for file changes
   */
  private startWatching(): void {
    // Watch src directory
    const srcDir = path.join(this.root, 'src');
    if (fs.existsSync(srcDir)) {
      this.watchDirectory(srcDir);
    }
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (filename && this.isIndexableFile(filename)) {
          this.pendingUpdates.add(path.join(dir, filename));
          this.scheduleUpdate();
        }
      });
      this.fileWatchers.set(dir, watcher);
    } catch {
      // Watching might not be supported
    }
  }

  private isIndexableFile(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'].includes(ext);
  }

  private scheduleUpdate(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      await this.processUpdates();
    }, 1000);
  }

  private async processUpdates(): Promise<void> {
    if (!this.index || this.pendingUpdates.size === 0) return;

    for (const filePath of this.pendingUpdates) {
      if (fs.existsSync(filePath)) {
        try {
          const indexed = await this.indexFile(filePath);
          this.index.files.set(indexed.relativePath, indexed);
        } catch {
          // Skip problematic files
        }
      } else {
        // File was deleted
        const relative = path.relative(this.root, filePath);
        this.index.files.delete(relative);
      }
    }

    this.index.updated = new Date();
    this.pendingUpdates.clear();
    await this.saveIndex();
  }

  /**
   * Force refresh the index
   */
  async refresh(): Promise<void> {
    await this.buildIndex();
  }

  /**
   * Stop watching and cleanup
   */
  dispose(): void {
    for (const watcher of this.fileWatchers.values()) {
      watcher.close();
    }
    this.fileWatchers.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }
}

export default CodebaseIndexer;
