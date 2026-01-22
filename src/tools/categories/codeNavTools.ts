/**
 * Code Navigation Tools - LSP-style navigation and search tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const goToDefinitionTool = tool(
  'go_to_definition',
  `Find where a symbol (function, class, variable) is defined.
Use when you need to understand the implementation of something.`,
  {
    symbol: z.string().describe('The symbol name to find'),
    filePath: z.string().describe('File where the symbol is used'),
    language: z.enum(['typescript', 'javascript', 'python', 'go', 'rust', 'java']).optional(),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const path = await import('path');

      const dir = path.dirname(args.filePath);
      const lang = args.language || 'typescript';

      // Use ripgrep to find definitions
      let pattern: string;
      switch (lang) {
        case 'typescript':
        case 'javascript':
          pattern = `(function|const|let|var|class|interface|type|enum)\\s+${args.symbol}\\b`;
          break;
        case 'python':
          pattern = `(def|class)\\s+${args.symbol}\\b`;
          break;
        case 'go':
          pattern = `(func|type|var|const)\\s+${args.symbol}\\b`;
          break;
        case 'rust':
          pattern = `(fn|struct|enum|trait|type|const|static)\\s+${args.symbol}\\b`;
          break;
        case 'java':
          pattern = `(class|interface|enum|void|public|private|protected).*\\s+${args.symbol}\\s*[({]`;
          break;
        default:
          pattern = `\\b${args.symbol}\\b`;
      }

      const { stdout } = await execAsync(
        `rg -n --no-heading "${pattern}" "${dir}" 2>/dev/null | head -10`,
        { maxBuffer: 1024 * 1024 }
      );

      const matches = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [file, lineNum, ...content] = line.split(':');
        return {
          file,
          line: parseInt(lineNum, 10),
          content: content.join(':').trim(),
        };
      });

      console.log(`\n🔍 [Definition] Found ${matches.length} definitions for "${args.symbol}"`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              symbol: args.symbol,
              definitions: matches,
              tip: matches.length > 0 ? `Read ${matches[0].file}:${matches[0].line} for the definition` : 'No definitions found',
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              symbol: args.symbol,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const goToReferencesTool = tool(
  'go_to_references',
  `Find all places where a symbol is used.
Use when modifying code that might be used elsewhere.`,
  {
    symbol: z.string().describe('The symbol name to find references for'),
    directory: z.string().describe('Directory to search in'),
    fileGlob: z.string().optional().describe('File pattern (e.g., "*.ts")'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let cmd = `rg -n --no-heading "\\b${args.symbol}\\b" "${args.directory}"`;
      if (args.fileGlob) {
        cmd += ` -g "${args.fileGlob}"`;
      }
      cmd += ' 2>/dev/null | head -30';

      const { stdout } = await execAsync(cmd, { maxBuffer: 1024 * 1024 });

      const references = stdout.trim().split('\n').filter(Boolean).map(line => {
        const [file, lineNum, ...content] = line.split(':');
        return {
          file,
          line: parseInt(lineNum, 10),
          content: content.join(':').trim().substring(0, 100),
        };
      });

      // Group by file
      const byFile: Record<string, number[]> = {};
      for (const ref of references) {
        if (!byFile[ref.file]) byFile[ref.file] = [];
        byFile[ref.file].push(ref.line);
      }

      console.log(`\n📍 [References] Found ${references.length} references to "${args.symbol}" in ${Object.keys(byFile).length} files`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              symbol: args.symbol,
              totalReferences: references.length,
              fileCount: Object.keys(byFile).length,
              byFile,
              sample: references.slice(0, 10),
            }, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              symbol: args.symbol,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

export const codebaseRetrievalTool = tool(
  'codebase_retrieval',
  `Retrieve highly relevant code from the codebase using semantic search.
ALWAYS call this BEFORE editing files to understand:
- All symbols involved in the edit
- Related classes, functions, and types
- Imports and dependencies
- Usage patterns in the codebase`,
  {
    query: z.string().describe('What you want to find (semantic description)'),
    projectPath: z.string().describe('Path to the project'),
    includePatterns: z.array(z.string()).optional().describe('File patterns to include (e.g., ["*.ts", "*.tsx"])'),
    excludePatterns: z.array(z.string()).optional().describe('File patterns to exclude (e.g., ["*.test.ts", "node_modules"])'),
    maxResults: z.number().default(10).describe('Maximum results to return'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Build ripgrep command
      let cmd = `rg -l --type-add 'code:*.{ts,tsx,js,jsx,py,go,rs,java,cpp,c,h}' -t code`;

      // Add exclude patterns
      const defaultExcludes = ['node_modules', 'dist', 'build', '.git', '*.test.*', '*.spec.*'];
      const excludes = [...defaultExcludes, ...(args.excludePatterns || [])];
      for (const exclude of excludes) {
        cmd += ` -g '!${exclude}'`;
      }

      // Add include patterns if specified
      if (args.includePatterns && args.includePatterns.length > 0) {
        for (const pattern of args.includePatterns) {
          cmd += ` -g '${pattern}'`;
        }
      }

      // Search for the query terms
      const queryTerms = args.query.split(/\s+/).filter(t => t.length > 2);
      const searchPattern = queryTerms.join('|');
      cmd += ` -e '${searchPattern}' "${args.projectPath}" 2>/dev/null`;

      const { stdout: filesOutput } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024 });
      const files = filesOutput.trim().split('\n').filter(Boolean).slice(0, args.maxResults);

      // Get context from each file
      const results = [];
      for (const file of files) {
        try {
          // Get matching lines with context
          const { stdout: context } = await execAsync(
            `rg -n -C 2 -e '${searchPattern}' "${file}" 2>/dev/null | head -20`,
            { maxBuffer: 1024 * 1024 }
          );

          results.push({
            file: file.replace(args.projectPath, '').replace(/^\//, ''),
            matches: context.trim().split('\n').slice(0, 10),
          });
        } catch {
          results.push({ file: file.replace(args.projectPath, '').replace(/^\//, ''), matches: [] });
        }
      }

      console.log(`\n🔎 [Codebase Retrieval] Found ${results.length} relevant files for "${args.query}"`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            fileCount: results.length,
            results,
            tip: 'Read the most relevant files before making edits',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            query: args.query,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

export const semanticSearchTool = tool(
  'semantic_search',
  `Find code by meaning using semantic search.
Use when you need to:
- Explore unfamiliar codebases
- Ask "how/where/what" questions about behavior
- Find code by meaning rather than exact text

DON'T use for:
- Exact text matches (use grep)
- Reading known files (use read)
- Simple symbol lookups`,
  {
    query: z.string().describe('A complete question: "How does X work?", "Where is Y handled?"'),
    projectPath: z.string().describe('Path to project'),
    targetDirectory: z.string().optional().describe('Specific directory to search'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const terms = args.query
        .toLowerCase()
        .replace(/[?.,!]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 3 && !['what', 'where', 'how', 'does', 'the', 'this', 'that', 'with', 'from'].includes(t));

      const searchDir = args.targetDirectory || args.projectPath;
      const pattern = terms.slice(0, 5).join('|');

      const { stdout } = await execAsync(
        `rg -l -i -e '${pattern}' "${searchDir}" -g '!node_modules' -g '!dist' -g '!.git' 2>/dev/null | head -15`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      const files = stdout.trim().split('\n').filter(Boolean);
      const results = [];

      for (const file of files.slice(0, 5)) {
        try {
          const { stdout: context } = await execAsync(
            `rg -n -C 3 -i -e '${pattern}' "${file}" 2>/dev/null | head -30`,
            { maxBuffer: 1024 * 1024 }
          );
          results.push({
            file: file.replace(args.projectPath, '').replace(/^\//, ''),
            relevance: terms.filter(t => context.toLowerCase().includes(t)).length / terms.length,
            context: context.trim().split('\n').slice(0, 15),
          });
        } catch { continue; }
      }

      results.sort((a, b) => b.relevance - a.relevance);
      console.log(`\n🔍 [Semantic Search] Found ${results.length} relevant files for "${args.query}"`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, query: args.query, termsSearched: terms, results: results.slice(0, 5) }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const hoverSymbolTool = tool(
  'hover_symbol',
  'Get type/documentation information for a symbol.',
  {
    symbol: z.string().describe('Symbol name'),
    filePath: z.string().describe('File where symbol is used'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const path = await import('path');
      const execAsync = promisify(exec);
      const dir = path.dirname(args.filePath);

      const patterns = [
        `(interface|type|class)\\s+${args.symbol}`,
        `function\\s+${args.symbol}\\s*\\(`,
        `const\\s+${args.symbol}\\s*=`,
      ];

      const results: string[] = [];
      for (const pattern of patterns) {
        try {
          const { stdout } = await execAsync(
            `rg -n -A 5 "${pattern}" "${dir}" -g '*.ts' -g '*.tsx' 2>/dev/null | head -15`,
            { maxBuffer: 1024 * 1024 }
          );
          if (stdout.trim()) results.push(...stdout.trim().split('\n').slice(0, 8));
        } catch { continue; }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, symbol: args.symbol, typeInfo: results.slice(0, 12) }, null, 2) }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const trajectorySearchTool = tool(
  'trajectory_search',
  `Search through past actions and decisions in the current session.
Use this to:
- Find what was already tried
- Avoid repeating failed approaches
- Understand the path taken to current state`,
  {
    query: z.string().describe('What to search for in past actions'),
    actionTypes: z.array(z.string()).optional().describe('Filter by action types (e.g., ["edit", "bash", "read"])'),
    limit: z.number().default(10).describe('Max results'),
  },
  async (args) => {
    try {
      // This would integrate with the task logs in a real implementation
      // For now, return a placeholder that explains the concept
      console.log(`\n🔍 [Trajectory] Searching for "${args.query}" in session history`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            message: 'Trajectory search is available via task logs. Use LogService to query past actions.',
            tip: 'Check context.task.orchestration for phase history',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: error.message }, null, 2),
        }],
      };
    }
  }
);
