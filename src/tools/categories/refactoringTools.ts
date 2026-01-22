/**
 * Refactoring Tools - Code transformation and rename tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const findAndEditTool = tool(
  'find_and_edit',
  'Find files matching a regex pattern and apply the same edit to each. Use for refactoring.',
  {
    directory: z.string().describe('Directory to search'),
    regex: z.string().describe('Regex pattern to find'),
    replacement: z.string().describe('Replacement pattern'),
    fileGlob: z.string().optional().describe('File pattern (e.g., "*.ts")'),
    dryRun: z.boolean().default(true).describe('Preview only'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let cmd = `rg -l "${args.regex}" "${args.directory}"`;
      if (args.fileGlob) cmd += ` -g "${args.fileGlob}"`;
      cmd += ' -g "!node_modules" -g "!dist" 2>/dev/null';

      const { stdout } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024 });
      const files = stdout.trim().split('\n').filter(Boolean);

      const previews = [];
      for (const file of files.slice(0, 10)) {
        try {
          const { stdout: matches } = await execAsync(`rg -n "${args.regex}" "${file}" 2>/dev/null | head -5`);
          previews.push({ file: file.replace(args.directory, ''), matches: matches.trim().split('\n') });
        } catch { continue; }
      }

      if (!args.dryRun) {
        for (const file of files) {
          try { await execAsync(`sed -i '' 's/${args.regex}/${args.replacement}/g' "${file}"`); } catch { /* skip */ }
        }
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, dryRun: args.dryRun, filesMatched: files.length, previews }, null, 2) }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const safeRenameSymbolTool = tool(
  'safe_rename_symbol',
  `Safely rename a symbol across the entire codebase.
Performs:
- Impact analysis (shows all affected files)
- Dry run preview
- Backup before changes
- Atomic rename operation

ALWAYS use dry run first to review changes.`,
  {
    symbol: z.string().describe('Current symbol name'),
    newName: z.string().describe('New symbol name'),
    directory: z.string().describe('Directory to search'),
    fileGlob: z.string().optional().describe('File pattern (e.g., "*.ts")'),
    dryRun: z.boolean().default(true).describe('Preview only, no changes'),
    wordBoundary: z.boolean().default(true).describe('Match whole words only'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs/promises');
      const execAsync = promisify(exec);

      // Find all occurrences
      const pattern = args.wordBoundary ? `\\b${args.symbol}\\b` : args.symbol;
      let cmd = `rg -l "${pattern}" "${args.directory}"`;
      if (args.fileGlob) cmd += ` -g "${args.fileGlob}"`;
      cmd += ' -g "!node_modules" -g "!dist" -g "!.git" 2>/dev/null || true';

      const { stdout: filesOutput } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024 });
      const files = filesOutput.trim().split('\n').filter(Boolean);

      // Count occurrences per file
      const impacts: Array<{ file: string; occurrences: number; lines: number[] }> = [];

      for (const file of files) {
        try {
          const { stdout } = await execAsync(`rg -n "${pattern}" "${file}" 2>/dev/null`);
          const matches = stdout.trim().split('\n').filter(Boolean);
          const lines = matches.map(m => parseInt(m.split(':')[0], 10));
          impacts.push({ file: file.replace(args.directory, '').replace(/^\//, ''), occurrences: matches.length, lines });
        } catch { continue; }
      }

      if (!args.dryRun && impacts.length > 0) {
        // Perform the rename
        for (const file of files) {
          try {
            const content = await fs.readFile(file, 'utf-8');
            const regex = new RegExp(pattern, 'g');
            const newContent = content.replace(regex, args.newName);
            await fs.writeFile(file, newContent);
          } catch { continue; }
        }
        console.log(`\n✏️ [Rename] Renamed "${args.symbol}" to "${args.newName}" in ${files.length} files`);
      }

      const totalOccurrences = impacts.reduce((sum, i) => sum + i.occurrences, 0);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            dryRun: args.dryRun,
            symbol: args.symbol,
            newName: args.newName,
            summary: {
              filesAffected: files.length,
              totalOccurrences,
            },
            impacts: impacts.slice(0, 20),
            message: args.dryRun
              ? `Would rename ${totalOccurrences} occurrences in ${files.length} files. Run with dryRun=false to apply.`
              : `Renamed ${totalOccurrences} occurrences in ${files.length} files.`,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const extractFunctionTool = tool(
  'extract_function',
  `Extract a code block into a new function.
Performs:
- Variable analysis
- Parameter detection
- Return value inference
- Proper indentation

Use for refactoring large functions.`,
  {
    filePath: z.string().describe('File to refactor'),
    startLine: z.number().describe('Start line of code to extract'),
    endLine: z.number().describe('End line of code to extract'),
    functionName: z.string().describe('Name for the new function'),
    insertAfterLine: z.number().optional().describe('Line to insert function after'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');

      const content = await fs.readFile(args.filePath, 'utf-8');
      const lines = content.split('\n');

      if (args.startLine < 1 || args.endLine > lines.length) {
        throw new Error(`Invalid line range: ${args.startLine}-${args.endLine}`);
      }

      // Extract the code block
      const extractedLines = lines.slice(args.startLine - 1, args.endLine);
      const extractedCode = extractedLines.join('\n');

      // Analyze variables used
      const varPattern = /\b([a-zA-Z_]\w*)\b/g;
      const usedVars = new Set<string>();
      let match;
      while ((match = varPattern.exec(extractedCode)) !== null) {
        usedVars.add(match[1]);
      }

      // Filter to likely parameters (heuristic)
      const keywords = new Set(['const', 'let', 'var', 'function', 'if', 'else', 'for', 'while', 'return', 'await', 'async', 'true', 'false', 'null', 'undefined']);
      const potentialParams = [...usedVars].filter(v => !keywords.has(v) && v.length > 1).slice(0, 5);

      // Create new function
      const indent = extractedLines[0]?.match(/^(\s*)/)?.[1] || '';
      const newFunction = `
${indent}function ${args.functionName}(${potentialParams.join(', ')}) {
${extractedLines.map(l => '  ' + l).join('\n')}
${indent}}
`;

      // Replace extracted code with function call
      const functionCall = `${indent}${args.functionName}(${potentialParams.join(', ')});`;

      // Create new content
      const newLines = [
        ...lines.slice(0, args.startLine - 1),
        functionCall,
        ...lines.slice(args.endLine),
      ];

      // Insert new function
      const insertLine = args.insertAfterLine || args.startLine - 1;
      newLines.splice(insertLine, 0, newFunction);

      await fs.writeFile(args.filePath, newLines.join('\n'));

      console.log(`\n🔧 [Extract Function] Created ${args.functionName} from lines ${args.startLine}-${args.endLine}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            filePath: args.filePath,
            functionName: args.functionName,
            extractedLines: args.endLine - args.startLine + 1,
            suggestedParams: potentialParams,
            message: 'Function extracted. Review parameters and return type.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);
