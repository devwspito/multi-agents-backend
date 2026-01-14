/**
 * LSP Tools - MCP Server for Language Server Protocol Features
 *
 * THIS IS A KEY DIFFERENTIATOR - IDE-level code intelligence for agents.
 *
 * Exposes LSP capabilities as MCP tools:
 * - Go to definition
 * - Find references
 * - Get type information
 * - Get completions
 * - Rename symbols
 * - Get diagnostics (errors/warnings)
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getLSPBridge } from '../services/LSPBridge';

// ==================== POSITION SCHEMA ====================

const PositionSchema = z.object({
  line: z.number().describe('Line number (0-indexed)'),
  character: z.number().describe('Character position (0-indexed)')
});

// ==================== LSP TOOLS ====================

/**
 * Go to definition tool
 */
export const gotoDefinitionTool = tool(
  'lsp_goto_definition',
  `Go to the definition of a symbol at a specific position in a file.

Returns the file path(s) and position(s) where the symbol is defined.
Works for functions, classes, variables, types, interfaces, etc.

This is like pressing F12 or Cmd+Click in an IDE.`,
  {
    filePath: z.string().describe('Path to the file'),
    position: PositionSchema.describe('Cursor position'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const locations = await lsp.goToDefinition(args.filePath, args.position);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            position: args.position,
            definitionsFound: locations.length,
            definitions: locations.map(loc => ({
              file: loc.uri.replace('file://', ''),
              line: loc.range.start.line,
              character: loc.range.start.character
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Find references tool
 */
export const findReferencesTool = tool(
  'lsp_find_references',
  `Find all references to a symbol at a specific position.

Returns all locations where the symbol is used across the codebase.
Useful for understanding impact of changes and code dependencies.

This is like pressing Shift+F12 in an IDE.`,
  {
    filePath: z.string().describe('Path to the file'),
    position: PositionSchema.describe('Cursor position'),
    includeDeclaration: z.boolean().default(true).describe('Include the declaration in results'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const locations = await lsp.findReferences(
        args.filePath,
        args.position,
        args.includeDeclaration
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            position: args.position,
            referencesFound: locations.length,
            references: locations.slice(0, 50).map(loc => ({
              file: loc.uri.replace('file://', ''),
              line: loc.range.start.line,
              character: loc.range.start.character
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Get hover information tool
 */
export const getHoverInfoTool = tool(
  'lsp_get_hover_info',
  `Get type information and documentation for a symbol at a position.

Returns:
- Type signature
- Documentation comments
- Parameter information

Like hovering over a symbol in an IDE.`,
  {
    filePath: z.string().describe('Path to the file'),
    position: PositionSchema.describe('Cursor position'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const hover = await lsp.getHoverInfo(args.filePath, args.position);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            position: args.position,
            info: hover ? {
              contents: hover.contents,
              range: hover.range
            } : null
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Get completions tool
 */
export const getCompletionsTool = tool(
  'lsp_get_completions',
  `Get code completion suggestions at a position.

Returns:
- Available methods/properties
- Functions
- Variables in scope
- Import suggestions

Like pressing Ctrl+Space in an IDE.`,
  {
    filePath: z.string().describe('Path to the file'),
    position: PositionSchema.describe('Cursor position'),
    maxResults: z.number().default(20).describe('Maximum completions to return'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const completions = await lsp.getCompletions(args.filePath, args.position);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            position: args.position,
            completionsFound: completions.length,
            completions: completions.slice(0, args.maxResults).map(c => ({
              label: c.label,
              kind: c.kind,
              detail: c.detail,
              documentation: c.documentation?.substring(0, 200)
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Get diagnostics tool
 */
export const getDiagnosticsTool = tool(
  'lsp_get_diagnostics',
  `Get errors and warnings for a file.

Returns all diagnostics from the language server:
- Syntax errors
- Type errors
- Linting warnings
- Security issues

Use this to check if code has errors before committing.`,
  {
    filePath: z.string().describe('Path to the file'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const diagnostics = await lsp.getDiagnostics(args.filePath);

      const errors = diagnostics.filter(d => d.severity === 'error');
      const warnings = diagnostics.filter(d => d.severity === 'warning');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            summary: {
              total: diagnostics.length,
              errors: errors.length,
              warnings: warnings.length
            },
            diagnostics: diagnostics.map(d => ({
              severity: d.severity,
              message: d.message,
              line: d.range.start.line,
              character: d.range.start.character,
              source: d.source,
              code: d.code
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Get document symbols tool
 */
export const getDocumentSymbolsTool = tool(
  'lsp_get_document_symbols',
  `Get all symbols (functions, classes, variables) in a file.

Returns the document outline:
- Classes and their methods
- Functions
- Constants and variables
- Interfaces and types

Like the Outline view in an IDE.`,
  {
    filePath: z.string().describe('Path to the file'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const symbols = await lsp.getDocumentSymbols(args.filePath);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            file: args.filePath,
            symbolsFound: symbols.length,
            symbols: symbols.map(s => ({
              name: s.name,
              kind: s.kind,
              line: s.location.range.start.line,
              container: s.containerName
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Workspace symbol search tool
 */
export const searchWorkspaceSymbolsTool = tool(
  'lsp_search_workspace_symbols',
  `Search for symbols across the entire workspace.

Find functions, classes, types by name pattern.
Much faster than grep for finding definitions.

Like pressing Cmd+T or Ctrl+P in an IDE.`,
  {
    query: z.string().describe('Symbol name to search for'),
    maxResults: z.number().default(30).describe('Maximum results to return'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const symbols = await lsp.getWorkspaceSymbols(args.query);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            symbolsFound: symbols.length,
            symbols: symbols.slice(0, args.maxResults).map(s => ({
              name: s.name,
              kind: s.kind,
              file: s.location.uri.replace('file://', ''),
              line: s.location.range.start.line,
              container: s.containerName
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

/**
 * Rename symbol tool
 */
export const renameSymbolTool = tool(
  'lsp_prepare_rename',
  `Prepare a symbol rename across the workspace.

Returns all files and locations that would be changed.
Does NOT perform the rename - just shows what would change.

Use this to safely plan refactoring.`,
  {
    filePath: z.string().describe('Path to the file'),
    position: PositionSchema.describe('Cursor position'),
    newName: z.string().describe('New name for the symbol'),
    workspacePath: z.string().optional().describe('Workspace root path')
  },
  async (args) => {
    try {
      const lsp = getLSPBridge(args.workspacePath);
      await lsp.initialize();

      const changes = await lsp.renameSymbol(args.filePath, args.position, args.newName);

      const fileCount = Object.keys(changes).length;
      let totalChanges = 0;
      for (const edits of Object.values(changes)) {
        totalChanges += edits.length;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            newName: args.newName,
            summary: {
              filesAffected: fileCount,
              totalChanges
            },
            changes: Object.entries(changes).map(([uri, edits]) => ({
              file: uri.replace('file://', ''),
              edits: edits.map(e => ({
                line: e.range.start.line,
                newText: e.newText
              }))
            }))
          }, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message
          }, null, 2)
        }]
      };
    }
  }
);

// ==================== MCP SERVER ====================

/**
 * Create LSP tools MCP server
 */
export function createLSPToolsServer() {
  return createSdkMcpServer({
    name: 'lsp-tools',
    version: '1.0.0',
    tools: [
      gotoDefinitionTool,
      findReferencesTool,
      getHoverInfoTool,
      getCompletionsTool,
      getDiagnosticsTool,
      getDocumentSymbolsTool,
      searchWorkspaceSymbolsTool,
      renameSymbolTool
    ]
  });
}

/**
 * Get all LSP tools as array
 */
export function getLSPTools() {
  return [
    gotoDefinitionTool,
    findReferencesTool,
    getHoverInfoTool,
    getCompletionsTool,
    getDiagnosticsTool,
    getDocumentSymbolsTool,
    searchWorkspaceSymbolsTool,
    renameSymbolTool
  ];
}
