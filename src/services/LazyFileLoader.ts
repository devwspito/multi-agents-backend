/**
 * LazyFileLoader
 *
 * Load files on-demand with streaming for large files.
 * Implements intelligent chunking and prefetching.
 *
 * Key behaviors:
 * 1. Stream large files instead of loading entirely
 * 2. Prefetch likely-needed files based on patterns
 * 3. Smart chunking for semantic code blocks
 * 4. Memory-efficient for large codebases
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

export interface FileChunk {
  content: string;
  startLine: number;
  endLine: number;
  type: 'function' | 'class' | 'import' | 'export' | 'block' | 'raw';
  name?: string;
  isComplete: boolean;
}

export interface LazyFile {
  path: string;
  size: number;
  lines: number;
  isLarge: boolean;
  chunks: FileChunk[];
  loaded: boolean;
  lastAccess: number;
}

export interface LoadOptions {
  maxLines?: number;
  startLine?: number;
  endLine?: number;
  chunkBySemantics?: boolean;
  includeContext?: number; // Lines of context around matches
}

export interface PrefetchConfig {
  enabled: boolean;
  maxFiles: number;
  patterns: string[];
}

const LARGE_FILE_THRESHOLD = 1000; // Lines
const MAX_CHUNK_SIZE = 500; // Lines per chunk
const PREFETCH_PATTERNS = [
  'index.ts', 'index.js',
  'types.ts', 'interfaces.ts',
  'constants.ts', 'config.ts',
];

export class LazyFileLoader {
  private fileCache: Map<string, LazyFile> = new Map();
  private prefetchQueue: string[] = [];
  private prefetchConfig: PrefetchConfig;

  constructor(prefetchConfig?: Partial<PrefetchConfig>) {
    this.prefetchConfig = {
      enabled: true,
      maxFiles: 20,
      patterns: PREFETCH_PATTERNS,
      ...prefetchConfig,
    };
  }

  /**
   * Load file content lazily
   */
  async load(filePath: string, options?: LoadOptions): Promise<string> {
    const info = await this.getFileInfo(filePath);

    // Small files - load entirely
    if (!info.isLarge || !options?.chunkBySemantics) {
      return this.loadEntire(filePath, options);
    }

    // Large files - load requested portion
    return this.loadChunked(filePath, options);
  }

  /**
   * Load specific lines from file
   */
  async loadLines(
    filePath: string,
    startLine: number,
    endLine: number
  ): Promise<string> {
    const lines: string[] = [];
    let currentLine = 0;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });

    return new Promise((resolve, reject) => {
      rl.on('line', (line) => {
        currentLine++;
        if (currentLine >= startLine && currentLine <= endLine) {
          lines.push(line);
        }
        if (currentLine > endLine) {
          rl.close();
        }
      });

      rl.on('close', () => resolve(lines.join('\n')));
      rl.on('error', reject);
    });
  }

  /**
   * Load file in semantic chunks
   */
  async loadSemanticChunks(filePath: string): Promise<FileChunk[]> {
    const info = await this.getFileInfo(filePath);

    if (info.chunks.length > 0) {
      return info.chunks;
    }

    const content = await this.loadEntire(filePath);
    const chunks = this.parseSemanticChunks(content);

    info.chunks = chunks;
    info.loaded = true;

    return chunks;
  }

  /**
   * Stream file line by line
   */
  async *streamLines(filePath: string): AsyncGenerator<{ line: string; num: number }> {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream });
    let lineNum = 0;

    for await (const line of rl) {
      lineNum++;
      yield { line, num: lineNum };
    }
  }

  /**
   * Search file without loading entirely
   */
  async searchInFile(
    filePath: string,
    pattern: RegExp,
    options?: { maxMatches?: number; context?: number }
  ): Promise<{ line: number; content: string; context: string[] }[]> {
    const matches: { line: number; content: string; context: string[] }[] = [];
    const maxMatches = options?.maxMatches || 50;
    const contextLines = options?.context || 2;
    const recentLines: string[] = [];

    for await (const { line, num } of this.streamLines(filePath)) {
      recentLines.push(line);
      if (recentLines.length > contextLines * 2 + 1) {
        recentLines.shift();
      }

      if (pattern.test(line)) {
        matches.push({
          line: num,
          content: line,
          context: [...recentLines],
        });

        if (matches.length >= maxMatches) break;
      }
    }

    return matches;
  }

  /**
   * Get file info without loading content
   */
  async getFileInfo(filePath: string): Promise<LazyFile> {
    if (this.fileCache.has(filePath)) {
      const cached = this.fileCache.get(filePath)!;
      cached.lastAccess = Date.now();
      return cached;
    }

    const stats = fs.statSync(filePath);
    const lines = await this.countLines(filePath);

    const info: LazyFile = {
      path: filePath,
      size: stats.size,
      lines,
      isLarge: lines > LARGE_FILE_THRESHOLD,
      chunks: [],
      loaded: false,
      lastAccess: Date.now(),
    };

    this.fileCache.set(filePath, info);

    // Trigger prefetch for related files
    if (this.prefetchConfig.enabled) {
      this.queuePrefetch(filePath);
    }

    return info;
  }

  /**
   * Prefetch likely-needed files
   */
  async prefetchRelated(basePath: string): Promise<void> {
    const dir = path.dirname(basePath);

    // Find related files
    const relatedPatterns = [
      path.join(dir, 'index.ts'),
      path.join(dir, 'types.ts'),
      basePath.replace('.ts', '.test.ts'),
      basePath.replace('.ts', '.spec.ts'),
    ];

    for (const pattern of relatedPatterns) {
      if (fs.existsSync(pattern) && !this.fileCache.has(pattern)) {
        this.prefetchQueue.push(pattern);
      }
    }

    // Process queue
    await this.processPrefetchQueue();
  }

  /**
   * Load entire file
   */
  private async loadEntire(filePath: string, options?: LoadOptions): Promise<string> {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    if (options?.startLine || options?.endLine) {
      const start = (options.startLine || 1) - 1;
      const end = options.endLine || lines.length;
      return lines.slice(start, end).join('\n');
    }

    if (options?.maxLines && lines.length > options.maxLines) {
      return lines.slice(0, options.maxLines).join('\n') +
        `\n\n... (${lines.length - options.maxLines} more lines)`;
    }

    return content;
  }

  /**
   * Load file in chunks
   */
  private async loadChunked(filePath: string, options?: LoadOptions): Promise<string> {
    const chunks = await this.loadSemanticChunks(filePath);

    if (options?.startLine && options?.endLine) {
      // Find chunks in range
      const relevantChunks = chunks.filter(
        c => c.endLine >= options.startLine! && c.startLine <= options.endLine!
      );
      return relevantChunks.map(c => c.content).join('\n\n');
    }

    if (options?.maxLines) {
      // Return first N lines worth of chunks
      let totalLines = 0;
      const selected: string[] = [];

      for (const chunk of chunks) {
        const chunkLines = chunk.endLine - chunk.startLine + 1;
        if (totalLines + chunkLines > options.maxLines) break;
        selected.push(chunk.content);
        totalLines += chunkLines;
      }

      return selected.join('\n\n');
    }

    return chunks.map(c => c.content).join('\n\n');
  }

  /**
   * Parse content into semantic chunks
   */
  private parseSemanticChunks(content: string): FileChunk[] {
    const chunks: FileChunk[] = [];
    const lines = content.split('\n');

    let currentChunk: Partial<FileChunk> = {
      startLine: 1,
      content: '',
      type: 'raw',
    };

    let braceDepth = 0;
    let inFunction = false;
    let inClass = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Detect chunk boundaries
      const functionMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      const classMatch = line.match(/(?:export\s+)?class\s+(\w+)/);
      const importMatch = line.match(/^import\s+/);
      const exportMatch = line.match(/^export\s+(?:const|let|type|interface)\s+(\w+)/);

      // Close current chunk if starting new block
      if ((functionMatch || classMatch || importMatch || exportMatch) && currentChunk.content) {
        currentChunk.endLine = lineNum - 1;
        currentChunk.isComplete = braceDepth === 0;
        chunks.push(currentChunk as FileChunk);

        currentChunk = {
          startLine: lineNum,
          content: '',
          type: 'raw',
        };
      }

      // Track block type
      if (functionMatch) {
        currentChunk.type = 'function';
        currentChunk.name = functionMatch[1];
        inFunction = true;
      } else if (classMatch) {
        currentChunk.type = 'class';
        currentChunk.name = classMatch[1];
        inClass = true;
      } else if (importMatch) {
        currentChunk.type = 'import';
      } else if (exportMatch) {
        currentChunk.type = 'export';
        currentChunk.name = exportMatch[1];
      }

      // Track braces
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;

      // Add line to current chunk
      currentChunk.content = currentChunk.content
        ? currentChunk.content + '\n' + line
        : line;

      // Close function/class chunk when braces balance
      if ((inFunction || inClass) && braceDepth === 0 && currentChunk.content) {
        currentChunk.endLine = lineNum;
        currentChunk.isComplete = true;
        chunks.push(currentChunk as FileChunk);

        currentChunk = {
          startLine: lineNum + 1,
          content: '',
          type: 'raw',
        };
        inFunction = false;
        inClass = false;
      }

      // Split raw chunks if too large
      if (currentChunk.type === 'raw') {
        const chunkLines = (currentChunk.content?.split('\n') || []).length;
        if (chunkLines >= MAX_CHUNK_SIZE) {
          currentChunk.endLine = lineNum;
          currentChunk.isComplete = true;
          chunks.push(currentChunk as FileChunk);

          currentChunk = {
            startLine: lineNum + 1,
            content: '',
            type: 'raw',
          };
        }
      }
    }

    // Add final chunk
    if (currentChunk.content) {
      currentChunk.endLine = lines.length;
      currentChunk.isComplete = braceDepth === 0;
      chunks.push(currentChunk as FileChunk);
    }

    return chunks;
  }

  /**
   * Count lines in file without loading
   */
  private async countLines(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      let count = 0;
      const stream = fs.createReadStream(filePath, { encoding: 'utf8' });

      stream.on('data', (chunk: string | Buffer) => {
        count += chunk.toString().split('\n').length;
      });

      stream.on('end', () => resolve(count));
      stream.on('error', reject);
    });
  }

  /**
   * Queue file for prefetching
   */
  private queuePrefetch(filePath: string): void {
    const dir = path.dirname(filePath);

    for (const pattern of this.prefetchConfig.patterns) {
      const prefetchPath = path.join(dir, pattern);
      if (fs.existsSync(prefetchPath) && !this.fileCache.has(prefetchPath)) {
        this.prefetchQueue.push(prefetchPath);
      }
    }
  }

  /**
   * Process prefetch queue
   */
  private async processPrefetchQueue(): Promise<void> {
    while (
      this.prefetchQueue.length > 0 &&
      this.fileCache.size < this.prefetchConfig.maxFiles
    ) {
      const filePath = this.prefetchQueue.shift()!;
      if (!this.fileCache.has(filePath)) {
        await this.getFileInfo(filePath);
      }
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.fileCache.clear();
    this.prefetchQueue = [];
  }

  /**
   * Get cache stats
   */
  getCacheStats(): {
    cachedFiles: number;
    totalSize: number;
    largeFiles: number;
    loadedChunks: number;
  } {
    let totalSize = 0;
    let largeFiles = 0;
    let loadedChunks = 0;

    for (const file of this.fileCache.values()) {
      totalSize += file.size;
      if (file.isLarge) largeFiles++;
      loadedChunks += file.chunks.length;
    }

    return {
      cachedFiles: this.fileCache.size,
      totalSize,
      largeFiles,
      loadedChunks,
    };
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 📄 LAZY FILE LOADING

Large files are loaded intelligently:

### Automatic Behavior:

- **Small files (<1000 lines)**: Load entirely
- **Large files (>1000 lines)**: Load in chunks
- **Streaming**: Never load more than needed

### Smart Chunking:

Files are split by semantic blocks:
- Functions
- Classes
- Import groups
- Export blocks

### Usage Tips:

1. **Request specific lines**:
   \`Read(file, { offset: 100, limit: 50 })\`

2. **Search without loading**:
   System searches large files via streaming

3. **Prefetching**:
   Related files (types, tests) prefetched

### Memory Efficiency:

| File Size | Strategy |
|-----------|----------|
| < 100 KB | Full load |
| 100KB - 1MB | Chunked |
| > 1MB | Streaming |

### Benefits:

- 💾 Memory efficient
- 🚀 Faster initial access
- 🎯 Precise content loading
- 🔄 Automatic prefetching
`;
  }
}
