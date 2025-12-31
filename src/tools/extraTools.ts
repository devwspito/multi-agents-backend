/**
 * Extra Tools - Additional MCP Tools for Claude Code-like functionality
 *
 * Implements tools that Claude Code has but our system was missing:
 * - WebSearch - Search the web
 * - TodoWrite - Task management
 * - NotebookEdit - Jupyter notebook support
 * - AskUserQuestion - (Autonomous mode - logs instead of asking)
 * - UpdatePlan - Dynamic plan updates (like Windsurf)
 * - BrowserPreview - Preview web apps (like Windsurf)
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
 * UpdatePlan Tool (Windsurf-style)
 * Dynamically update the execution plan during task execution
 */
const planStore: Map<string, {
  items: Array<{
    id: string;
    description: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    notes?: string;
    dependencies?: string[];
  }>;
  lastUpdated: Date;
  updatedBy: string;
}> = new Map();

export const updatePlanTool = tool(
  'update_plan',
  `Dynamically update the execution plan. Call this when:
- You learn new information that changes the plan
- You complete a step and need to mark it done
- You discover blockers or new dependencies
- The scope changes based on what you find

IMPORTANT: Update the plan BEFORE starting significant work, not after.`,
  {
    taskId: z.string().describe('Task identifier'),
    agentType: z.string().describe('Agent making the update'),
    action: z.enum(['add', 'update', 'remove', 'reorder']).describe('Type of plan change'),
    items: z.array(z.object({
      id: z.string().describe('Unique item identifier'),
      description: z.string().describe('What needs to be done'),
      status: z.enum(['pending', 'in_progress', 'completed', 'blocked']).describe('Current status'),
      notes: z.string().optional().describe('Additional context or findings'),
      dependencies: z.array(z.string()).optional().describe('IDs of items this depends on'),
    })).describe('Plan items to add/update'),
    reason: z.string().describe('Why is the plan being updated?'),
  },
  async (args) => {
    try {
      const existingPlan = planStore.get(args.taskId) || {
        items: [],
        lastUpdated: new Date(),
        updatedBy: args.agentType,
      };

      switch (args.action) {
        case 'add':
          existingPlan.items.push(...args.items);
          break;

        case 'update':
          for (const update of args.items) {
            const idx = existingPlan.items.findIndex(i => i.id === update.id);
            if (idx >= 0) {
              existingPlan.items[idx] = { ...existingPlan.items[idx], ...update };
            }
          }
          break;

        case 'remove':
          const idsToRemove = new Set(args.items.map(i => i.id));
          existingPlan.items = existingPlan.items.filter(i => !idsToRemove.has(i.id));
          break;

        case 'reorder':
          // Replace entire list with new order
          existingPlan.items = args.items;
          break;
      }

      existingPlan.lastUpdated = new Date();
      existingPlan.updatedBy = args.agentType;
      planStore.set(args.taskId, existingPlan);

      // Format for display
      const display = existingPlan.items.map((item, i) => {
        const icon = item.status === 'completed' ? '✅' :
                     item.status === 'in_progress' ? '🔄' :
                     item.status === 'blocked' ? '🚫' : '⬜';
        return `${icon} ${i + 1}. [${item.id}] ${item.description}${item.notes ? ` (${item.notes})` : ''}`;
      }).join('\n');

      console.log(`\n📋 [Plan Update] ${args.agentType} - ${args.reason}`);
      console.log(display);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: args.action,
              reason: args.reason,
              updatedBy: args.agentType,
              plan: {
                itemCount: existingPlan.items.length,
                pending: existingPlan.items.filter(i => i.status === 'pending').length,
                inProgress: existingPlan.items.filter(i => i.status === 'in_progress').length,
                completed: existingPlan.items.filter(i => i.status === 'completed').length,
                blocked: existingPlan.items.filter(i => i.status === 'blocked').length,
              },
              display,
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
 * BrowserPreview Tool (Windsurf-style)
 * Launch browser preview for web applications
 */
export const browserPreviewTool = tool(
  'browser_preview',
  `Open a browser preview for a running web server.
IMPORTANT: Only use this AFTER starting a web server with run_command.
Do NOT use for non-web applications (pygame, desktop apps, etc).`,
  {
    url: z.string().describe('URL to preview (e.g., http://localhost:3000)'),
    title: z.string().optional().describe('Title for the preview window'),
    waitForReady: z.boolean().default(true).describe('Wait for server to be ready'),
    timeout: z.number().default(10000).describe('Timeout in ms to wait for server'),
  },
  async (args) => {
    try {
      // Check if server is ready
      if (args.waitForReady) {
        let ready = false;
        const startTime = Date.now();

        while (!ready && (Date.now() - startTime) < args.timeout) {
          try {
            const response = await fetch(args.url, { method: 'HEAD' });
            if (response.ok || response.status < 500) {
              ready = true;
            }
          } catch {
            // Server not ready yet
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        if (!ready) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: false,
                  error: `Server at ${args.url} not ready after ${args.timeout}ms`,
                  suggestion: 'Ensure the web server is running before calling browser_preview',
                }, null, 2),
              },
            ],
          };
        }
      }

      // Try to open browser (cross-platform)
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const platform = process.platform;
      let command: string;

      if (platform === 'darwin') {
        command = `open "${args.url}"`;
      } else if (platform === 'win32') {
        command = `start "" "${args.url}"`;
      } else {
        command = `xdg-open "${args.url}" || sensible-browser "${args.url}" || x-www-browser "${args.url}"`;
      }

      await execAsync(command);

      console.log(`\n🌐 [Browser Preview] Opening ${args.url}${args.title ? ` - ${args.title}` : ''}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              title: args.title,
              message: `Browser preview opened for ${args.url}`,
              platform,
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
 * Think Tool (Devin-style)
 * Explicit reasoning scratchpad before critical decisions
 */
export const thinkTool = tool(
  'think',
  `Use this as a scratchpad for explicit reasoning before critical decisions.

MUST use in these situations:
1. Before git/GitHub decisions (branch, checkout, PR, merge)
2. When transitioning from exploration to code changes
3. Before reporting completion to verify all requirements met
4. When facing unexpected difficulties
5. Before making decisions critical for success

SHOULD use when:
- No clear next step
- Details are unclear but important
- Multiple approaches tried without success
- Opening images or viewing screenshots

The user will NOT see your thoughts - this is private reasoning space.`,
  {
    reasoning: z.string().describe('Your detailed reasoning and analysis'),
    context: z.string().optional().describe('What triggered this thinking'),
    conclusion: z.string().optional().describe('What you decided'),
    confidence: z.number().min(1).max(10).optional().describe('Confidence level 1-10'),
  },
  async (args) => {
    // Log thinking for debugging/analysis (not shown to user)
    console.log(`\n🧠 [Think] ${args.context || 'Reasoning...'}`);
    console.log(`   Confidence: ${args.confidence || 'N/A'}/10`);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            acknowledged: true,
            message: 'Reasoning recorded. Proceed with your decision.',
            summary: args.conclusion || 'No conclusion yet',
          }, null, 2),
        },
      ],
    };
  }
);

/**
 * Git Commit Retrieval Tool (Augment-style)
 * Search git history for similar changes
 */
export const gitCommitRetrievalTool = tool(
  'git_commit_retrieval',
  `Search git commit history to find how similar changes were made in the past.
Very useful for:
- Understanding how similar features were implemented
- Finding patterns for consistent code style
- Learning from past decisions
- Making better plans based on historical changes`,
  {
    query: z.string().describe('What to search for in commit history'),
    repoPath: z.string().describe('Path to the git repository'),
    limit: z.number().default(10).describe('Maximum commits to return'),
    author: z.string().optional().describe('Filter by author'),
    since: z.string().optional().describe('Only commits after this date (YYYY-MM-DD)'),
    pathFilter: z.string().optional().describe('Only commits touching this path'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Build git log command
      let cmd = `git log --oneline --all -n ${args.limit}`;

      if (args.author) {
        cmd += ` --author="${args.author}"`;
      }
      if (args.since) {
        cmd += ` --since="${args.since}"`;
      }
      if (args.pathFilter) {
        cmd += ` -- "${args.pathFilter}"`;
      }

      // Search with grep for the query
      cmd += ` --grep="${args.query}" --regexp-ignore-case`;

      const { stdout: grepResults } = await execAsync(cmd, {
        cwd: args.repoPath,
        maxBuffer: 1024 * 1024,
      });

      // If no grep results, try searching in diff content
      let commits = grepResults.trim().split('\n').filter(Boolean);

      if (commits.length === 0) {
        // Search in actual code changes
        const { stdout: diffResults } = await execAsync(
          `git log --oneline --all -n ${args.limit} -S "${args.query}"`,
          { cwd: args.repoPath, maxBuffer: 1024 * 1024 }
        );
        commits = diffResults.trim().split('\n').filter(Boolean);
      }

      // Get details for each commit
      const detailedCommits = [];
      for (const commit of commits.slice(0, 5)) {
        const hash = commit.split(' ')[0];
        try {
          const { stdout: details } = await execAsync(
            `git show --stat --format="%H|%an|%ae|%s|%ad" --date=short ${hash}`,
            { cwd: args.repoPath, maxBuffer: 1024 * 1024 }
          );

          const lines = details.trim().split('\n');
          const [fullHash, author, _email, subject, date] = lines[0].split('|');
          const files = lines.slice(1, -1).map(l => l.trim()).filter(Boolean);

          detailedCommits.push({
            hash: fullHash?.substring(0, 8),
            author,
            date,
            subject,
            filesChanged: files.length,
            files: files.slice(0, 5),
          });
        } catch {
          // Skip commits we can't get details for
        }
      }

      console.log(`\n📜 [Git History] Found ${detailedCommits.length} relevant commits for "${args.query}"`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              query: args.query,
              totalFound: commits.length,
              commits: detailedCommits,
              tip: 'Use `git show <hash>` to see full commit details',
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
              query: args.query,
              error: error.message,
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Go To Definition Tool (Devin LSP-style)
 * Find where a symbol is defined
 */
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

/**
 * Go To References Tool (Devin LSP-style)
 * Find all usages of a symbol
 */
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

/**
 * Create MCP server with extra tools
 */
export function createExtraToolsServer() {
  return createSdkMcpServer({
    name: 'extra-tools',
    version: '3.0.0',
    tools: [
      webSearchTool,
      todoWriteTool,
      notebookEditTool,
      logUserMessageTool,
      webFetchTool,
      updatePlanTool,
      browserPreviewTool,
      thinkTool,
      gitCommitRetrievalTool,
      goToDefinitionTool,
      goToReferencesTool,
      // Competitor-inspired tools (Round 1)
      packageManagerTool,
      deploymentConfigTool,
      knowledgeBaseTool,
      codebaseRetrievalTool,
      exposePortTool,
      // Competitor-inspired tools (Round 2)
      semanticSearchTool,
      hoverSymbolTool,
      findAndEditTool,
      waitTool,
      undoEditTool,
      readLintsTool,
      reportEnvironmentIssueTool,
      generateDesignInspirationTool,
      // Competitor-inspired tools (Round 3 - Memory & Visual)
      memoryRecallTool,
      memoryRememberTool,
      memoryFeedbackTool,
      screenshotCaptureTool,
      trajectorySearchTool,
      inspectSiteTool,
    ],
  });
}

/**
 * Package Manager Tool (Augment-style)
 * Use package managers instead of manually editing package.json
 */
export const packageManagerTool = tool(
  'package_manager',
  `Execute package manager commands safely.
ALWAYS use this instead of manually editing package.json, requirements.txt, etc.

Rationale: Package managers automatically resolve versions, handle conflicts,
update lock files, and maintain consistency. Manual editing leads to version
mismatches and broken builds.

Supported package managers:
- npm/yarn/pnpm (JavaScript/Node.js)
- pip/poetry/conda (Python)
- cargo (Rust)
- go mod (Go)
- gem/bundler (Ruby)
- composer (PHP)
- dotnet (C#/.NET)`,
  {
    action: z.enum(['install', 'uninstall', 'update', 'list', 'audit']).describe('Package manager action'),
    packages: z.array(z.string()).optional().describe('Package names to install/uninstall'),
    packageManager: z.enum(['npm', 'yarn', 'pnpm', 'pip', 'poetry', 'cargo', 'go', 'gem', 'composer', 'dotnet']).describe('Which package manager to use'),
    workingDir: z.string().describe('Working directory with package manifest'),
    dev: z.boolean().optional().describe('Install as dev dependency'),
    global: z.boolean().optional().describe('Install globally'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let command = '';
      const packages = args.packages?.join(' ') || '';

      switch (args.packageManager) {
        case 'npm':
          switch (args.action) {
            case 'install': command = `npm install ${args.dev ? '--save-dev' : ''} ${args.global ? '-g' : ''} ${packages}`.trim(); break;
            case 'uninstall': command = `npm uninstall ${packages}`; break;
            case 'update': command = packages ? `npm update ${packages}` : 'npm update'; break;
            case 'list': command = 'npm list --depth=0'; break;
            case 'audit': command = 'npm audit'; break;
          }
          break;
        case 'yarn':
          switch (args.action) {
            case 'install': command = `yarn add ${args.dev ? '--dev' : ''} ${packages}`.trim(); break;
            case 'uninstall': command = `yarn remove ${packages}`; break;
            case 'update': command = packages ? `yarn upgrade ${packages}` : 'yarn upgrade'; break;
            case 'list': command = 'yarn list --depth=0'; break;
            case 'audit': command = 'yarn audit'; break;
          }
          break;
        case 'pip':
          switch (args.action) {
            case 'install': command = `pip install ${packages}`; break;
            case 'uninstall': command = `pip uninstall -y ${packages}`; break;
            case 'update': command = `pip install --upgrade ${packages}`; break;
            case 'list': command = 'pip list'; break;
            case 'audit': command = 'pip-audit'; break;
          }
          break;
        case 'cargo':
          switch (args.action) {
            case 'install': command = `cargo add ${packages}`; break;
            case 'uninstall': command = `cargo remove ${packages}`; break;
            case 'update': command = 'cargo update'; break;
            case 'list': command = 'cargo tree --depth 1'; break;
            case 'audit': command = 'cargo audit'; break;
          }
          break;
        default:
          throw new Error(`Package manager ${args.packageManager} not fully implemented yet`);
      }

      console.log(`\n📦 [Package Manager] ${command}`);

      const { stdout, stderr } = await execAsync(command, {
        cwd: args.workingDir,
        maxBuffer: 5 * 1024 * 1024,
        timeout: 120000, // 2 minute timeout
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              command,
              output: stdout.substring(0, 5000),
              warnings: stderr ? stderr.substring(0, 1000) : undefined,
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
              suggestion: 'Check if package manager is installed and packages exist',
            }, null, 2),
          },
        ],
      };
    }
  }
);

/**
 * Deployment Configuration Tool (Replit-style)
 * Configure and manage deployment settings
 */
export const deploymentConfigTool = tool(
  'deployment_config',
  `Configure deployment settings for the project.
Use this to set up:
- Build commands (compile TypeScript, bundle assets)
- Run commands (start production server)
- Environment variables (without exposing secrets)
- Port configuration`,
  {
    action: z.enum(['get', 'set', 'validate', 'deploy_preview']).describe('Configuration action'),
    buildCommand: z.string().optional().describe('Command to build the project'),
    runCommand: z.string().optional().describe('Command to start in production'),
    port: z.number().optional().describe('Port to expose'),
    envVars: z.array(z.object({
      key: z.string(),
      value: z.string().optional(),
      isSecret: z.boolean().optional(),
    })).optional().describe('Environment variables (secrets will be masked)'),
    projectPath: z.string().describe('Path to the project'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const configPath = path.join(args.projectPath, '.deployment.json');

      let config: any = {
        buildCommand: '',
        runCommand: '',
        port: 3000,
        envVars: [],
      };

      // Try to read existing config
      try {
        const existing = await fs.readFile(configPath, 'utf-8');
        config = JSON.parse(existing);
      } catch {
        // No existing config, use defaults
      }

      switch (args.action) {
        case 'get':
          // Mask secrets
          const safeConfig = {
            ...config,
            envVars: config.envVars?.map((v: any) => ({
              key: v.key,
              value: v.isSecret ? '***MASKED***' : v.value,
              isSecret: v.isSecret,
            })),
          };
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: true, config: safeConfig }, null, 2),
            }],
          };

        case 'set':
          if (args.buildCommand) config.buildCommand = args.buildCommand;
          if (args.runCommand) config.runCommand = args.runCommand;
          if (args.port) config.port = args.port;
          if (args.envVars) {
            // Merge env vars
            for (const newVar of args.envVars) {
              const idx = config.envVars.findIndex((v: any) => v.key === newVar.key);
              if (idx >= 0) {
                config.envVars[idx] = newVar;
              } else {
                config.envVars.push(newVar);
              }
            }
          }

          await fs.writeFile(configPath, JSON.stringify(config, null, 2));
          console.log(`\n🚀 [Deployment] Configuration saved to ${configPath}`);

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Deployment configuration saved',
                config: {
                  buildCommand: config.buildCommand,
                  runCommand: config.runCommand,
                  port: config.port,
                  envVarCount: config.envVars.length,
                },
              }, null, 2),
            }],
          };

        case 'validate':
          const issues: string[] = [];
          if (!config.runCommand) issues.push('Missing run command');
          if (!config.port) issues.push('Missing port configuration');

          // Check if package.json exists
          try {
            const pkgPath = path.join(args.projectPath, 'package.json');
            await fs.access(pkgPath);
            // package.json exists, good for npm commands
          } catch {
            if (config.buildCommand?.includes('npm') || config.runCommand?.includes('npm')) {
              issues.push('package.json not found but npm commands are configured');
            }
          }

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: issues.length === 0,
                valid: issues.length === 0,
                issues,
                config: { buildCommand: config.buildCommand, runCommand: config.runCommand, port: config.port },
              }, null, 2),
            }],
          };

        case 'deploy_preview':
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Deploy preview ready',
                steps: [
                  config.buildCommand ? `1. Build: ${config.buildCommand}` : '1. No build step',
                  `2. Run: ${config.runCommand}`,
                  `3. Expose port: ${config.port}`,
                ],
                tip: 'Use browser_preview after starting the server',
              }, null, 2),
            }],
          };
      }
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

/**
 * Knowledge Base Tool (Manus-style)
 * Access best practices and patterns for specific technologies
 */
const knowledgeBase: Record<string, { patterns: string[]; antiPatterns: string[]; tips: string[] }> = {
  typescript: {
    patterns: [
      'Use strict mode and enable all strict checks',
      'Prefer interfaces over type aliases for object shapes',
      'Use readonly for immutable properties',
      'Leverage discriminated unions for state management',
      'Use const assertions for literal types',
    ],
    antiPatterns: [
      'Avoid using `any` - use `unknown` instead',
      'Don\'t use `!` non-null assertion carelessly',
      'Avoid type assertions unless necessary',
      'Don\'t use enums - use const objects or unions',
    ],
    tips: [
      'Use `satisfies` operator for type-safe object literals',
      'Leverage template literal types for string patterns',
      'Use conditional types for complex type logic',
    ],
  },
  react: {
    patterns: [
      'Use functional components with hooks',
      'Keep components small and focused (< 200 lines)',
      'Use custom hooks to extract reusable logic',
      'Implement error boundaries for resilience',
      'Use React.memo() for expensive renders',
    ],
    antiPatterns: [
      'Avoid prop drilling - use context or state management',
      'Don\'t mutate state directly',
      'Avoid useEffect for derived state',
      'Don\'t use index as key for dynamic lists',
    ],
    tips: [
      'Use useCallback for event handlers passed to children',
      'Prefer useMemo for expensive calculations',
      'Use React.lazy() for code splitting',
    ],
  },
  nodejs: {
    patterns: [
      'Use async/await over callbacks or raw promises',
      'Implement proper error handling with try/catch',
      'Use environment variables for configuration',
      'Structure code in modules with clear responsibilities',
      'Use streaming for large data processing',
    ],
    antiPatterns: [
      'Avoid blocking the event loop',
      'Don\'t ignore promise rejections',
      'Avoid synchronous file operations in servers',
      'Don\'t store secrets in code',
    ],
    tips: [
      'Use cluster module for multi-core utilization',
      'Implement graceful shutdown handlers',
      'Use compression middleware for HTTP responses',
    ],
  },
  git: {
    patterns: [
      'Write descriptive commit messages (why, not just what)',
      'Keep commits atomic - one logical change per commit',
      'Use feature branches for new work',
      'Rebase feature branches before merging',
      'Tag releases with semantic versioning',
    ],
    antiPatterns: [
      'Never force push to shared branches',
      'Don\'t commit secrets or credentials',
      'Avoid committing large binary files',
      'Don\'t use generic messages like "fix" or "update"',
    ],
    tips: [
      'Use git hooks for pre-commit validation',
      'Squash commits before merging feature branches',
      'Use git bisect to find bugs',
    ],
  },
  security: {
    patterns: [
      'Validate and sanitize all user input',
      'Use parameterized queries to prevent SQL injection',
      'Implement rate limiting on APIs',
      'Use HTTPS for all communications',
      'Store passwords with bcrypt or argon2',
    ],
    antiPatterns: [
      'Never log sensitive data (passwords, tokens)',
      'Don\'t use eval() or dynamic code execution',
      'Avoid storing secrets in environment variables in production',
      'Don\'t trust client-side validation alone',
    ],
    tips: [
      'Use CSP headers to prevent XSS',
      'Implement CSRF protection for state-changing operations',
      'Run regular dependency audits',
    ],
  },
  testing: {
    patterns: [
      'Test behavior, not implementation',
      'Use descriptive test names that explain the scenario',
      'Follow Arrange-Act-Assert pattern',
      'Mock external dependencies',
      'Aim for high coverage of critical paths',
    ],
    antiPatterns: [
      'Don\'t test implementation details',
      'Avoid brittle tests that break with refactoring',
      'Don\'t skip tests to make CI pass',
      'Avoid testing third-party code',
    ],
    tips: [
      'Use property-based testing for edge cases',
      'Implement integration tests for critical flows',
      'Use test fixtures for consistent test data',
    ],
  },
};

export const knowledgeBaseTool = tool(
  'knowledge_base',
  `Access best practices and patterns for specific technologies.
Use this to:
- Get patterns to follow for a technology
- Learn anti-patterns to avoid
- Get tips for better code

Available topics: ${Object.keys(knowledgeBase).join(', ')}`,
  {
    topic: z.string().describe('Technology or topic to get knowledge about'),
    category: z.enum(['patterns', 'antiPatterns', 'tips', 'all']).default('all').describe('Category of knowledge'),
  },
  async (args) => {
    const topic = args.topic.toLowerCase();
    const knowledge = knowledgeBase[topic];

    if (!knowledge) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: `Topic "${args.topic}" not found`,
            availableTopics: Object.keys(knowledgeBase),
          }, null, 2),
        }],
      };
    }

    let result: any = { success: true, topic };

    if (args.category === 'all') {
      result = { ...result, ...knowledge };
    } else {
      result[args.category] = knowledge[args.category];
    }

    console.log(`\n📚 [Knowledge] Retrieved ${args.category} for ${topic}`);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

/**
 * Codebase Retrieval Tool (Augment-style)
 * Semantic search over the codebase
 */
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

/**
 * Expose Port Tool (Manus-style)
 * Make a local port publicly accessible
 */
export const exposePortTool = tool(
  'expose_port',
  `Expose a local port to make it publicly accessible.
Use this when:
- User needs to access the app from another device
- You need to share a preview with someone
- Testing webhooks that need a public URL

Note: In development, this may use tunneling services.`,
  {
    port: z.number().describe('Local port to expose'),
    protocol: z.enum(['http', 'https']).default('http').describe('Protocol to use'),
    projectPath: z.string().describe('Project path for context'),
  },
  async (args) => {
    try {
      // Check if the port is in use
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        await execAsync(`lsof -i :${args.port}`);
      } catch {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: `No service running on port ${args.port}`,
              suggestion: 'Start your server first, then expose the port',
            }, null, 2),
          }],
        };
      }

      // In a real implementation, this would use a tunneling service
      // For now, we'll return instructions
      console.log(`\n🌐 [Expose Port] Port ${args.port} requested for public access`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            port: args.port,
            localUrl: `${args.protocol}://localhost:${args.port}`,
            message: 'Port exposure configured',
            instructions: [
              `Local access: ${args.protocol}://localhost:${args.port}`,
              'For public access, consider using ngrok, cloudflared, or similar tunneling service',
              'Run: npx localtunnel --port ' + args.port,
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Semantic Search Tool (Devin/Cursor-style)
 * Find code by meaning, not exact text
 */
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

/**
 * Hover Symbol Tool (Devin LSP-style)
 */
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

/**
 * Find and Edit Tool (Devin-style) - Bulk regex-based editing
 */
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

/**
 * Wait Tool (Devin-style)
 */
export const waitTool = tool(
  'wait',
  'Wait for a specified number of seconds.',
  { seconds: z.number().describe('Seconds to wait'), reason: z.string().optional() },
  async (args) => {
    console.log(`\n⏳ [Wait] ${args.seconds}s${args.reason ? ` - ${args.reason}` : ''}`);
    await new Promise(resolve => setTimeout(resolve, args.seconds * 1000));
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, waited: args.seconds }, null, 2) }] };
  }
);

/**
 * Undo Edit Tool (Devin-style)
 */
export const undoEditTool = tool(
  'undo_edit',
  'Revert the last change made to a file using git checkout.',
  { filePath: z.string().describe('Path to file to undo') },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const path = await import('path');
      const execAsync = promisify(exec);
      const dir = path.dirname(args.filePath);
      const file = path.basename(args.filePath);

      await execAsync(`git -C "${dir}" checkout -- "${file}"`);
      console.log(`\n↩️ [Undo] Reverted ${file}`);

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: `Reverted ${file}` }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Read Lints Tool (Cursor-style)
 */
export const readLintsTool = tool(
  'read_lints',
  'Get linter errors from the workspace using ESLint.',
  { paths: z.array(z.string()).optional(), projectPath: z.string().describe('Project root') },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      let cmd = `cd "${args.projectPath}" && npx eslint --format json`;
      cmd += args.paths?.length ? ` ${args.paths.map(p => `"${p}"`).join(' ')}` : ' . --ext .ts,.tsx,.js,.jsx';
      cmd += ' 2>/dev/null || true';

      const { stdout } = await execAsync(cmd, { maxBuffer: 5 * 1024 * 1024, timeout: 60000 });

      let results: any[] = [];
      try { results = JSON.parse(stdout); } catch { return { content: [{ type: 'text', text: JSON.stringify({ success: true, errors: [], warnings: [] }, null, 2) }] }; }

      const errors: any[] = [], warnings: any[] = [];
      for (const file of results) {
        for (const msg of file.messages || []) {
          const item = { file: file.filePath.replace(args.projectPath, ''), line: msg.line, message: msg.message, rule: msg.ruleId };
          (msg.severity === 2 ? errors : warnings).push(item);
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ success: true, errorCount: errors.length, warningCount: warnings.length, errors: errors.slice(0, 20), warnings: warnings.slice(0, 10) }, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Report Environment Issue Tool (Devin-style)
 */
export const reportEnvironmentIssueTool = tool(
  'report_environment_issue',
  'Report environment issues that block progress.',
  {
    issue: z.string().describe('Description of the issue'),
    suggestion: z.string().optional(),
    severity: z.enum(['low', 'medium', 'high', 'blocker']).default('medium'),
  },
  async (args) => {
    console.log(`\n⚠️ [Env Issue] ${args.severity.toUpperCase()}: ${args.issue}`);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, reported: true, issue: args.issue, severity: args.severity }, null, 2) }] };
  }
);

/**
 * Generate Design Inspiration Tool (v0-style)
 */
export const generateDesignInspirationTool = tool(
  'generate_design_inspiration',
  'Generate design inspiration for UI/UX work.',
  {
    goal: z.string().describe('Product/feature goal'),
    style: z.enum(['minimal', 'modern', 'playful', 'corporate', 'bold', 'elegant']).optional(),
  },
  async (args) => {
    const styles: Record<string, any> = {
      minimal: { colors: ['#FFFFFF', '#F5F5F5', '#333333'], fonts: ['Inter', 'SF Pro'], patterns: ['Whitespace', 'Simple borders'] },
      modern: { colors: ['#0070F3', '#FFFFFF', '#171717'], fonts: ['Geist', 'Inter'], patterns: ['Gradients', 'Glassmorphism'] },
      playful: { colors: ['#FF6B6B', '#4ECDC4', '#FFE66D'], fonts: ['Poppins', 'Nunito'], patterns: ['Illustrations', 'Animations'] },
      corporate: { colors: ['#1E3A8A', '#FFFFFF', '#64748B'], fonts: ['IBM Plex Sans'], patterns: ['Professional grids'] },
      bold: { colors: ['#000000', '#FFFFFF', '#FF0000'], fonts: ['Bebas Neue', 'Oswald'], patterns: ['High contrast', 'Large type'] },
      elegant: { colors: ['#1A1A2E', '#F0E6D3', '#C9A959'], fonts: ['Playfair Display'], patterns: ['Serif typography', 'Premium feel'] },
    };

    const style = args.style || 'modern';
    console.log(`\n🎨 [Design] Generated ${style} inspiration for: ${args.goal}`);

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, goal: args.goal, style, inspiration: styles[style] }, null, 2) }] };
  }
);

// ============================================================================
// ROUND 3: Critical Missing Tools (Memory, Screenshot, Trajectory)
// ============================================================================

/**
 * Memory Recall Tool (Windsurf-style)
 * Retrieve relevant memories from past sessions
 */
export const memoryRecallTool = tool(
  'memory_recall',
  `Retrieve relevant memories from past sessions using semantic search.
ALWAYS call this at the START of every task to check for:
- Codebase patterns that were discovered before
- How similar errors were resolved
- Architectural decisions and their rationale
- Workflows that worked well

This helps avoid repeating mistakes and leverages past learnings.`,
  {
    projectId: z.string().describe('Project ID to search memories for'),
    query: z.string().describe('What you want to recall (semantic description)'),
    types: z.array(z.enum([
      'codebase_pattern',
      'error_resolution',
      'workflow_learned',
      'architecture_decision',
      'api_contract',
      'user_preference',
      'decision_rationale'
    ])).optional().describe('Filter by memory types'),
    limit: z.number().default(5).describe('Max memories to return'),
  },
  async (args) => {
    try {
      // Dynamic import to avoid circular dependencies
      const { memoryService } = await import('../services/MemoryService');

      const results = await memoryService.recall({
        projectId: args.projectId,
        query: args.query,
        types: args.types as any,
        limit: args.limit,
      });

      console.log(`\n🧠 [Memory Recall] Found ${results.length} relevant memories for "${args.query}"`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            query: args.query,
            memoriesFound: results.length,
            memories: results.map(r => ({
              id: r.memory._id,
              title: r.memory.title,
              type: r.memory.type,
              content: r.memory.content,
              importance: r.memory.importance,
              score: r.score,
              createdAt: r.memory.createdAt,
            })),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            suggestion: 'Memory service may not be initialized. Check MongoDB connection.',
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Memory Remember Tool (Windsurf-style)
 * Store learnings, patterns, and insights for future sessions
 */
export const memoryRememberTool = tool(
  'memory_remember',
  `Store a learning, pattern, or insight for future sessions.
Call this LIBERALLY when you discover:
- A codebase pattern that wasn't obvious
- How you resolved a tricky error
- A workflow that worked well
- An architectural decision and WHY
- User preferences for this project

Don't ask permission - just store valuable learnings!`,
  {
    projectId: z.string().describe('Project ID to store memory for'),
    type: z.enum([
      'codebase_pattern',
      'error_resolution',
      'workflow_learned',
      'architecture_decision',
      'api_contract',
      'user_preference',
      'decision_rationale'
    ]).describe('Type of memory'),
    title: z.string().describe('Short descriptive title'),
    content: z.string().describe('Detailed explanation of what you learned'),
    importance: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('How important is this memory'),
    taskId: z.string().optional().describe('Current task ID for context'),
    agentType: z.string().optional().describe('Agent type storing this memory'),
  },
  async (args) => {
    try {
      const { memoryService } = await import('../services/MemoryService');

      const memory = await memoryService.remember({
        projectId: args.projectId,
        type: args.type as any,
        title: args.title,
        content: args.content,
        importance: args.importance as any,
        source: {
          taskId: args.taskId,
          agentType: args.agentType,
        },
      });

      console.log(`\n🧠 [Memory Remember] Stored: "${args.title}" (${args.type}, ${args.importance})`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            memoryId: memory._id,
            title: args.title,
            type: args.type,
            importance: args.importance,
            message: 'Memory stored successfully. It will be available for future sessions.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Memory Feedback Tool (Windsurf-style)
 * Mark a memory as useful or not useful
 */
export const memoryFeedbackTool = tool(
  'memory_feedback',
  'Provide feedback on a retrieved memory to improve future relevance.',
  {
    memoryId: z.string().describe('ID of the memory to provide feedback on'),
    wasUseful: z.boolean().describe('Whether the memory was useful'),
  },
  async (args) => {
    try {
      const { memoryService } = await import('../services/MemoryService');

      await memoryService.feedback(args.memoryId, args.wasUseful);

      console.log(`\n🧠 [Memory Feedback] ${args.wasUseful ? '👍' : '👎'} for memory ${args.memoryId}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            memoryId: args.memoryId,
            wasUseful: args.wasUseful,
            message: 'Feedback recorded. This helps improve future memory relevance.',
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

/**
 * Screenshot Capture Tool (Windsurf/v0-style)
 * Capture screenshot of a running web application
 */
export const screenshotCaptureTool = tool(
  'screenshot_capture',
  `Capture a screenshot of a running web application.
Use this for:
- Visual testing and verification
- Documenting UI state
- Debugging layout issues
- Sharing progress with users`,
  {
    url: z.string().describe('URL to capture (e.g., http://localhost:3000)'),
    selector: z.string().optional().describe('CSS selector to capture specific element'),
    fullPage: z.boolean().default(false).describe('Capture full page or just viewport'),
    outputPath: z.string().optional().describe('Path to save screenshot'),
  },
  async (args) => {
    try {
      // Try to use puppeteer if available, otherwise fallback to CLI screenshot
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Check if puppeteer is available by trying to require it
      let usePuppeteer = false;
      try {
        require.resolve('puppeteer');
        usePuppeteer = true;
      } catch {
        // Puppeteer not installed, will use alternative
      }

      if (usePuppeteer) {
        // Dynamic require to avoid TypeScript compilation issues
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        await page.goto(args.url, { waitUntil: 'networkidle0', timeout: 30000 });

        const screenshotOptions: any = {
          fullPage: args.fullPage,
        };

        if (args.outputPath) {
          screenshotOptions.path = args.outputPath;
        }

        if (args.selector) {
          const element = await page.$(args.selector);
          if (element) {
            await element.screenshot(screenshotOptions);
          }
        } else {
          await page.screenshot(screenshotOptions);
        }

        await browser.close();
        console.log(`\n📸 [Screenshot] Captured ${args.url}${args.selector ? ` (${args.selector})` : ''}`);
      } else {
        // Fallback: Use curl to verify the page is accessible
        await execAsync(`curl -s -o /dev/null -w "%{http_code}" "${args.url}"`);
        console.log(`\n📸 [Screenshot] Puppeteer not installed. Verified ${args.url} is accessible.`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: true,
              url: args.url,
              message: 'Page verified accessible. Install puppeteer for actual screenshots.',
              suggestion: 'Run: npm install puppeteer',
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            url: args.url,
            selector: args.selector,
            fullPage: args.fullPage,
            savedTo: args.outputPath || 'Buffer (not saved to disk)',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
            suggestion: error.message.includes('ECONNREFUSED')
              ? 'Server may not be running. Start the dev server first.'
              : 'Check if the URL is correct and accessible.',
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Trajectory Search Tool (Windsurf-style)
 * Search past agent actions and decisions in current session
 */
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

/**
 * Inspect Site Tool (v0-style)
 * Analyze website structure and design patterns
 */
export const inspectSiteTool = tool(
  'inspect_site',
  `Analyze a website's structure, design patterns, and implementation.
Use this to:
- Understand existing site architecture
- Extract design patterns and colors
- Identify technologies used
- Get inspiration for implementation`,
  {
    url: z.string().describe('URL to inspect'),
    aspects: z.array(z.enum([
      'structure',
      'colors',
      'typography',
      'layout',
      'components',
      'technologies',
      'accessibility'
    ])).default(['structure', 'technologies']).describe('What aspects to analyze'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Use curl to fetch the page
      const { stdout: html } = await execAsync(
        `curl -s -L --max-time 10 "${args.url}" | head -c 50000`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      const analysis: any = {
        url: args.url,
        success: true,
      };

      if (args.aspects.includes('structure')) {
        const headings = html.match(/<h[1-6][^>]*>.*?<\/h[1-6]>/gi)?.slice(0, 10) || [];
        const sections = html.match(/<(section|main|article|nav|header|footer)[^>]*>/gi)?.length || 0;
        analysis.structure = { headings: headings.length, sections };
      }

      if (args.aspects.includes('technologies')) {
        const techs: string[] = [];
        if (html.includes('react')) techs.push('React');
        if (html.includes('vue')) techs.push('Vue');
        if (html.includes('angular')) techs.push('Angular');
        if (html.includes('next')) techs.push('Next.js');
        if (html.includes('tailwind')) techs.push('Tailwind CSS');
        if (html.includes('bootstrap')) techs.push('Bootstrap');
        analysis.technologies = techs;
      }

      if (args.aspects.includes('colors')) {
        const colors = html.match(/#[0-9a-fA-F]{3,6}|rgb\([^)]+\)|hsl\([^)]+\)/gi)?.slice(0, 10) || [];
        analysis.colors = [...new Set(colors)];
      }

      console.log(`\n🔍 [Inspect Site] Analyzed ${args.url}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(analysis, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            url: args.url,
            error: error.message,
          }, null, 2),
        }],
      };
    }
  }
);

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
    updatePlanTool,
    browserPreviewTool,
    thinkTool,
    gitCommitRetrievalTool,
    goToDefinitionTool,
    goToReferencesTool,
    // Competitor-inspired tools (Round 1)
    packageManagerTool,
    deploymentConfigTool,
    knowledgeBaseTool,
    codebaseRetrievalTool,
    exposePortTool,
    // Competitor-inspired tools (Round 2)
    semanticSearchTool,
    hoverSymbolTool,
    findAndEditTool,
    waitTool,
    undoEditTool,
    readLintsTool,
    reportEnvironmentIssueTool,
    generateDesignInspirationTool,
    // Competitor-inspired tools (Round 3 - Memory & Visual)
    memoryRecallTool,
    memoryRememberTool,
    memoryFeedbackTool,
    screenshotCaptureTool,
    trajectorySearchTool,
    inspectSiteTool,
  ];
}
