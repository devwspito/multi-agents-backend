/**
 * CoreFileTools - Native file operations as MCP tools
 *
 * Exposes Claude Code-level file operations directly to agents:
 * - Read: Read files with line numbers and offset support
 * - Write: Create new files
 * - Edit: Edit existing files with string replacement
 * - Glob: Find files by pattern
 * - Grep: Search file contents with regex
 *
 * These are the fundamental tools that make agents truly autonomous.
 */

import * as fs from 'fs';
import * as path from 'path';
import globCallback from 'glob';
import { execSync } from 'child_process';
import { z } from 'zod';

// Promisified glob wrapper
function glob(pattern: string, options: globCallback.IOptions = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    globCallback(pattern, options, (err, matches) => {
      if (err) reject(err);
      else resolve(matches);
    });
  });
}

// ==================== SCHEMAS ====================

const ReadSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to read'),
  offset: z.number().optional().describe('Line number to start reading from (1-indexed)'),
  limit: z.number().optional().describe('Number of lines to read')
});

const WriteSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to create'),
  content: z.string().describe('Content to write to the file')
});

const EditSchema = z.object({
  file_path: z.string().describe('Absolute path to the file to edit'),
  old_string: z.string().describe('The exact string to replace'),
  new_string: z.string().describe('The replacement string'),
  replace_all: z.boolean().optional().default(false).describe('Replace all occurrences')
});

const GlobSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.test.ts")'),
  path: z.string().optional().describe('Base directory to search from'),
  ignore: z.array(z.string()).optional().describe('Patterns to ignore')
});

const GrepSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory or file to search in'),
  type: z.string().optional().describe('File type filter (e.g., "ts", "js", "py")'),
  context_lines: z.number().optional().default(0).describe('Lines of context around matches'),
  max_results: z.number().optional().default(100).describe('Maximum number of results'),
  case_insensitive: z.boolean().optional().default(false).describe('Case insensitive search')
});

// ==================== TYPES ====================

export interface ReadResult {
  content: string;
  lines: number;
  truncated: boolean;
  file_path: string;
}

export interface WriteResult {
  success: boolean;
  file_path: string;
  bytes_written: number;
}

export interface EditResult {
  success: boolean;
  file_path: string;
  replacements: number;
  preview?: string;
}

export interface GlobResult {
  files: string[];
  count: number;
  pattern: string;
}

export interface GrepMatch {
  file: string;
  line: number;
  column: number;
  content: string;
  context_before?: string[];
  context_after?: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  count: number;
  files_searched: number;
  truncated: boolean;
}

// ==================== IMPLEMENTATION ====================

export class CoreFileTools {
  private workspaceRoot: string;
  private readFiles: Set<string> = new Set(); // Track read files for Edit safety
  private maxFileSize: number = 10 * 1024 * 1024; // 10MB
  private maxLines: number = 2000;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Read a file with optional line offset and limit
   * Returns content with line numbers like `cat -n`
   */
  async read(params: z.infer<typeof ReadSchema>): Promise<ReadResult> {
    const { file_path, offset = 1, limit = this.maxLines } = params;

    // Security: Prevent path traversal
    const resolvedPath = this.resolvePath(file_path);
    this.validatePath(resolvedPath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const stats = fs.statSync(resolvedPath);
    if (stats.isDirectory()) {
      throw new Error(`Cannot read directory: ${file_path}. Use Glob to list directory contents.`);
    }

    if (stats.size > this.maxFileSize) {
      throw new Error(`File too large (${stats.size} bytes). Max: ${this.maxFileSize} bytes`);
    }

    // Read file content
    const fullContent = fs.readFileSync(resolvedPath, 'utf-8');
    const allLines = fullContent.split('\n');

    // Apply offset and limit
    const startLine = Math.max(1, offset) - 1;
    const endLine = Math.min(allLines.length, startLine + limit);
    const selectedLines = allLines.slice(startLine, endLine);

    // Format with line numbers (like cat -n)
    const numberedContent = selectedLines
      .map((line, idx) => {
        const lineNum = startLine + idx + 1;
        const padding = ' '.repeat(Math.max(0, 6 - String(lineNum).length));
        // Truncate very long lines
        const truncatedLine = line.length > 2000 ? line.substring(0, 2000) + '...' : line;
        return `${padding}${lineNum}\t${truncatedLine}`;
      })
      .join('\n');

    // Track that this file was read (for Edit safety)
    this.readFiles.add(resolvedPath);

    return {
      content: numberedContent,
      lines: selectedLines.length,
      truncated: endLine < allLines.length,
      file_path: resolvedPath
    };
  }

  /**
   * Write a new file
   * Will NOT overwrite existing files unless they were read first
   */
  async write(params: z.infer<typeof WriteSchema>): Promise<WriteResult> {
    const { file_path, content } = params;

    const resolvedPath = this.resolvePath(file_path);
    this.validatePath(resolvedPath);

    // Safety check: If file exists, it must have been read first
    if (fs.existsSync(resolvedPath) && !this.readFiles.has(resolvedPath)) {
      throw new Error(
        `File exists but was not read first: ${file_path}. ` +
        `Use Read tool first to verify file contents before overwriting.`
      );
    }

    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write file
    fs.writeFileSync(resolvedPath, content, 'utf-8');
    this.readFiles.add(resolvedPath); // Mark as known

    return {
      success: true,
      file_path: resolvedPath,
      bytes_written: Buffer.byteLength(content, 'utf-8')
    };
  }

  /**
   * Edit an existing file by replacing strings
   * File MUST be read first for safety
   */
  async edit(params: z.infer<typeof EditSchema>): Promise<EditResult> {
    const { file_path, old_string, new_string, replace_all = false } = params;

    const resolvedPath = this.resolvePath(file_path);
    this.validatePath(resolvedPath);

    // Safety: Must read file first
    if (!this.readFiles.has(resolvedPath)) {
      throw new Error(
        `File was not read in this session: ${file_path}. ` +
        `Use Read tool first before editing.`
      );
    }

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${file_path}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf-8');

    // Check if old_string exists
    if (!content.includes(old_string)) {
      throw new Error(
        `String not found in file. The old_string must match exactly ` +
        `(including whitespace and indentation).`
      );
    }

    // Check uniqueness if not replace_all
    if (!replace_all) {
      const count = content.split(old_string).length - 1;
      if (count > 1) {
        throw new Error(
          `String found ${count} times. Either provide more context to make it unique, ` +
          `or use replace_all: true to replace all occurrences.`
        );
      }
    }

    // Perform replacement
    let newContent: string;
    let replacements: number;

    if (replace_all) {
      const count = content.split(old_string).length - 1;
      newContent = content.split(old_string).join(new_string);
      replacements = count;
    } else {
      newContent = content.replace(old_string, new_string);
      replacements = 1;
    }

    // Write back
    fs.writeFileSync(resolvedPath, newContent, 'utf-8');

    // Generate preview (show a few lines around the change)
    const preview = this.generateEditPreview(newContent, new_string);

    return {
      success: true,
      file_path: resolvedPath,
      replacements,
      preview
    };
  }

  /**
   * Find files matching a glob pattern
   */
  async glob(params: z.infer<typeof GlobSchema>): Promise<GlobResult> {
    const { pattern, path: basePath, ignore = [] } = params;

    const searchRoot = basePath
      ? this.resolvePath(basePath)
      : this.workspaceRoot;

    // Default ignores
    const defaultIgnores = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**'
    ];

    const files = await glob(pattern, {
      cwd: searchRoot,
      ignore: [...defaultIgnores, ...ignore],
      nodir: true,
      absolute: true
    });

    // Sort by modification time (most recent first)
    const sortedFiles = files
      .map((f: string) => ({ path: f, mtime: fs.statSync(f).mtime.getTime() }))
      .sort((a: { path: string; mtime: number }, b: { path: string; mtime: number }) => b.mtime - a.mtime)
      .map((f: { path: string; mtime: number }) => f.path);

    return {
      files: sortedFiles,
      count: sortedFiles.length,
      pattern
    };
  }

  /**
   * Search file contents using ripgrep or fallback
   */
  async grep(params: z.infer<typeof GrepSchema>): Promise<GrepResult> {
    const {
      pattern,
      path: searchPath,
      type,
      context_lines = 0,
      max_results = 100,
      case_insensitive = false
    } = params;

    const searchRoot = searchPath
      ? this.resolvePath(searchPath)
      : this.workspaceRoot;

    // Try ripgrep first (much faster)
    try {
      return await this.grepWithRipgrep(
        pattern, searchRoot, type, context_lines, max_results, case_insensitive
      );
    } catch {
      // Fallback to native implementation
      return await this.grepNative(
        pattern, searchRoot, type, context_lines, max_results, case_insensitive
      );
    }
  }

  // ==================== PRIVATE HELPERS ====================

  private resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return path.normalize(filePath);
    }
    return path.resolve(this.workspaceRoot, filePath);
  }

  private validatePath(resolvedPath: string): void {
    // Basic security: prevent obvious path traversal
    const normalized = path.normalize(resolvedPath);
    if (normalized.includes('..')) {
      // Allow if still within workspace
      if (!normalized.startsWith(this.workspaceRoot)) {
        throw new Error('Path traversal not allowed outside workspace');
      }
    }
  }

  private generateEditPreview(content: string, searchStr: string): string {
    const lines = content.split('\n');
    const targetIndex = lines.findIndex(l => l.includes(searchStr));

    if (targetIndex === -1) return '';

    const start = Math.max(0, targetIndex - 2);
    const end = Math.min(lines.length, targetIndex + 3);

    return lines.slice(start, end)
      .map((line, idx) => {
        const lineNum = start + idx + 1;
        return `${lineNum}\t${line}`;
      })
      .join('\n');
  }

  private async grepWithRipgrep(
    pattern: string,
    searchRoot: string,
    type: string | undefined,
    contextLines: number,
    maxResults: number,
    caseInsensitive: boolean
  ): Promise<GrepResult> {
    const args = ['rg', '--json'];

    if (caseInsensitive) args.push('-i');
    if (contextLines > 0) args.push(`-C${contextLines}`);
    if (type) args.push(`--type=${type}`);
    args.push(`--max-count=${maxResults}`);
    args.push('--');
    args.push(pattern);
    args.push(searchRoot);

    try {
      const output = execSync(args.join(' '), {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024 // 50MB
      });

      return this.parseRipgrepOutput(output, maxResults);
    } catch (error: any) {
      // rg returns exit code 1 for no matches
      if (error.status === 1) {
        return { matches: [], count: 0, files_searched: 0, truncated: false };
      }
      throw error;
    }
  }

  private parseRipgrepOutput(output: string, maxResults: number): GrepResult {
    const matches: GrepMatch[] = [];
    const filesSearched = new Set<string>();
    let truncated = false;

    const lines = output.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'match') {
          const data = obj.data;
          filesSearched.add(data.path.text);

          if (matches.length >= maxResults) {
            truncated = true;
            break;
          }

          matches.push({
            file: data.path.text,
            line: data.line_number,
            column: data.submatches?.[0]?.start || 0,
            content: data.lines.text.trim()
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return {
      matches,
      count: matches.length,
      files_searched: filesSearched.size,
      truncated
    };
  }

  private async grepNative(
    pattern: string,
    searchRoot: string,
    type: string | undefined,
    contextLines: number,
    maxResults: number,
    caseInsensitive: boolean
  ): Promise<GrepResult> {
    const matches: GrepMatch[] = [];
    const filesSearched = new Set<string>();

    const regex = new RegExp(pattern, caseInsensitive ? 'gi' : 'g');

    // Get all files
    const filePattern = type ? `**/*.${type}` : '**/*';
    const files = await glob(filePattern, {
      cwd: searchRoot,
      ignore: ['**/node_modules/**', '**/.git/**'],
      nodir: true,
      absolute: true
    });

    outer: for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        filesSearched.add(file);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const match = regex.exec(line);

          if (match) {
            if (matches.length >= maxResults) {
              break outer;
            }

            const result: GrepMatch = {
              file,
              line: i + 1,
              column: match.index,
              content: line.trim()
            };

            if (contextLines > 0) {
              result.context_before = lines.slice(Math.max(0, i - contextLines), i);
              result.context_after = lines.slice(i + 1, i + 1 + contextLines);
            }

            matches.push(result);
            regex.lastIndex = 0; // Reset regex
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }

    return {
      matches,
      count: matches.length,
      files_searched: filesSearched.size,
      truncated: matches.length >= maxResults
    };
  }

  /**
   * Mark a file as read (for external reads)
   */
  markAsRead(filePath: string): void {
    const resolved = this.resolvePath(filePath);
    this.readFiles.add(resolved);
  }

  /**
   * Get all files that have been read this session
   */
  getReadFiles(): string[] {
    return Array.from(this.readFiles);
  }

  /**
   * Clear the read files tracking (for testing)
   */
  clearReadTracking(): void {
    this.readFiles.clear();
  }
}

// ==================== MCP TOOL DEFINITIONS ====================

export function createCoreFileToolsServer(workspaceRoot?: string) {
  const tools = new CoreFileTools(workspaceRoot);

  return {
    name: 'core-file-tools',
    tools: [
      {
        name: 'read',
        description: `Read a file's contents with line numbers.
Returns content formatted with line numbers (like cat -n).
Use offset and limit for large files.
ALWAYS use this before editing a file.`,
        inputSchema: ReadSchema,
        handler: async (params: z.infer<typeof ReadSchema>) => tools.read(params)
      },
      {
        name: 'write',
        description: `Write content to a file.
Creates parent directories if needed.
For existing files, use Edit instead (requires Read first).`,
        inputSchema: WriteSchema,
        handler: async (params: z.infer<typeof WriteSchema>) => tools.write(params)
      },
      {
        name: 'edit',
        description: `Edit a file by replacing exact string matches.
REQUIRES: Read the file first (safety check).
Use replace_all: true for multiple replacements.
The old_string must match EXACTLY including whitespace.`,
        inputSchema: EditSchema,
        handler: async (params: z.infer<typeof EditSchema>) => tools.edit(params)
      },
      {
        name: 'glob',
        description: `Find files matching a glob pattern.
Examples: "**/*.ts", "src/**/*.test.ts", "**/auth*"
Results sorted by modification time (newest first).`,
        inputSchema: GlobSchema,
        handler: async (params: z.infer<typeof GlobSchema>) => tools.glob(params)
      },
      {
        name: 'grep',
        description: `Search file contents using regex.
Uses ripgrep when available (fast), falls back to native.
Use type to filter by file extension.
Returns file, line number, and matching content.`,
        inputSchema: GrepSchema,
        handler: async (params: z.infer<typeof GrepSchema>) => tools.grep(params)
      }
    ],
    instance: tools
  };
}

// ==================== CONVENIENCE EXPORTS ====================

export { ReadSchema, WriteSchema, EditSchema, GlobSchema, GrepSchema };
