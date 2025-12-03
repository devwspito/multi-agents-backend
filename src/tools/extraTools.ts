/**
 * Extra Tools - Additional MCP Tools for Claude Code-like functionality
 *
 * Implements tools that Claude Code has but our system was missing:
 * - WebSearch - Search the web
 * - TodoWrite - Task management
 * - NotebookEdit - Jupyter notebook support
 * - AskUserQuestion - (Autonomous mode - logs instead of asking)
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * WebSearch Tool
 * Searches the web using a search API
 */
export const webSearchTool = tool(
  'web_search',
  'Search the web for information. Returns search results with titles, URLs, and snippets.',
  {
    query: z.string().describe('The search query'),
    maxResults: z.number().default(5).describe('Maximum number of results to return'),
  },
  async (args) => {
    try {
      // Use DuckDuckGo instant answer API (free, no API key required)
      const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json&no_html=1`;

      const response = await fetch(searchUrl);
      const data = await response.json() as {
        Abstract?: string;
        Heading?: string;
        AbstractURL?: string;
        RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
      };

      const results: any[] = [];

      // Add abstract if available
      if (data.Abstract) {
        results.push({
          title: data.Heading || 'Summary',
          url: data.AbstractURL || '',
          snippet: data.Abstract,
        });
      }

      // Add related topics
      if (data.RelatedTopics) {
        for (const topic of data.RelatedTopics.slice(0, args.maxResults - results.length)) {
          if (topic.Text) {
            results.push({
              title: topic.Text.split(' - ')[0] || 'Related',
              url: topic.FirstURL || '',
              snippet: topic.Text,
            });
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              resultCount: results.length,
              results,
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
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * TodoWrite Tool
 * Manages a task list for the current session
 */
const todoStore: Map<string, any[]> = new Map();

export const todoWriteTool = tool(
  'todo_write',
  'Create and manage a structured task list. Use to track progress on complex tasks.',
  {
    sessionId: z.string().describe('Session identifier for the todo list'),
    todos: z.array(z.object({
      content: z.string().describe('Task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).describe('Task status'),
      activeForm: z.string().describe('Present continuous form of the task'),
    })).describe('The complete todo list'),
  },
  async (args) => {
    try {
      todoStore.set(args.sessionId, args.todos);

      // Format for display
      const display = args.todos.map((todo, i) => {
        const icon = todo.status === 'completed' ? '✅' : todo.status === 'in_progress' ? '🔄' : '⬜';
        return `${icon} ${i + 1}. ${todo.content}`;
      }).join('\n');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: 'Todo list updated',
              display,
              stats: {
                total: args.todos.length,
                pending: args.todos.filter(t => t.status === 'pending').length,
                inProgress: args.todos.filter(t => t.status === 'in_progress').length,
                completed: args.todos.filter(t => t.status === 'completed').length,
              },
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
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * NotebookEdit Tool
 * Edit Jupyter notebook cells
 */
export const notebookEditTool = tool(
  'notebook_edit',
  'Edit Jupyter notebook (.ipynb) cells. Can replace, insert, or delete cells.',
  {
    notebookPath: z.string().describe('Path to the Jupyter notebook file'),
    cellIndex: z.number().describe('Index of the cell to edit (0-based)'),
    editMode: z.enum(['replace', 'insert', 'delete']).default('replace').describe('Edit operation'),
    cellType: z.enum(['code', 'markdown']).optional().describe('Cell type for insert/replace'),
    newSource: z.string().describe('New cell content'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');

      // Read notebook
      const content = await fs.readFile(args.notebookPath, 'utf-8');
      const notebook = JSON.parse(content);

      if (!notebook.cells || !Array.isArray(notebook.cells)) {
        throw new Error('Invalid notebook format');
      }

      switch (args.editMode) {
        case 'replace':
          if (args.cellIndex >= notebook.cells.length) {
            throw new Error(`Cell index ${args.cellIndex} out of range`);
          }
          notebook.cells[args.cellIndex].source = args.newSource.split('\n');
          if (args.cellType) {
            notebook.cells[args.cellIndex].cell_type = args.cellType;
          }
          break;

        case 'insert':
          const newCell = {
            cell_type: args.cellType || 'code',
            source: args.newSource.split('\n'),
            metadata: {},
            outputs: [],
            execution_count: null,
          };
          notebook.cells.splice(args.cellIndex, 0, newCell);
          break;

        case 'delete':
          if (args.cellIndex >= notebook.cells.length) {
            throw new Error(`Cell index ${args.cellIndex} out of range`);
          }
          notebook.cells.splice(args.cellIndex, 1);
          break;
      }

      // Write back
      await fs.writeFile(args.notebookPath, JSON.stringify(notebook, null, 2));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              operation: args.editMode,
              cellIndex: args.cellIndex,
              totalCells: notebook.cells.length,
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
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * LogUserMessage Tool
 * In autonomous mode, this logs what would be asked instead of blocking
 */
export const logUserMessageTool = tool(
  'log_user_message',
  'Log a message that would normally require user input. In autonomous mode, decisions are made automatically.',
  {
    message: z.string().describe('The message or question'),
    context: z.string().optional().describe('Additional context'),
    suggestedAction: z.string().optional().describe('Suggested action to take autonomously'),
  },
  async (args) => {
    console.log(`\n📝 [Autonomous Decision Point]`);
    console.log(`   Message: ${args.message}`);
    if (args.context) console.log(`   Context: ${args.context}`);
    if (args.suggestedAction) console.log(`   Action: ${args.suggestedAction}`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            mode: 'autonomous',
            message: 'Proceeding autonomously with suggested action',
            logged: {
              message: args.message,
              context: args.context,
              action: args.suggestedAction || 'Continuing with best judgment',
            },
          }, null, 2),
        },
      ],
    };
  }
);

/**
 * WebFetch Tool
 * Fetch and process web content
 */
export const webFetchTool = tool(
  'web_fetch',
  'Fetch content from a URL and optionally process it with a prompt',
  {
    url: z.string().describe('The URL to fetch'),
    prompt: z.string().optional().describe('Prompt to process the content'),
    maxLength: z.number().default(10000).describe('Maximum content length to return'),
  },
  async (args) => {
    try {
      const response = await fetch(args.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MultiAgentBot/1.0)',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      let content = await response.text();

      // Basic HTML to text conversion
      content = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Truncate if needed
      if (content.length > args.maxLength) {
        content = content.slice(0, args.maxLength) + '... [truncated]';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              contentLength: content.length,
              content: args.prompt
                ? `Content from ${args.url}:\n\n${content}\n\nProcess with: ${args.prompt}`
                : content,
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
              url: args.url,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Create MCP server with extra tools
 */
export function createExtraToolsServer() {
  return createSdkMcpServer({
    name: 'extra-tools',
    version: '1.0.0',
    tools: [
      webSearchTool,
      todoWriteTool,
      notebookEditTool,
      logUserMessageTool,
      webFetchTool,
    ],
  });
}

/**
 * Get all extra tools as array
 */
export function getExtraTools() {
  return [
    webSearchTool,
    todoWriteTool,
    notebookEditTool,
    logUserMessageTool,
    webFetchTool,
  ];
}
