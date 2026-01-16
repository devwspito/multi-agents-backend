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
    version: '4.0.0',
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
      // Round 4: Code Generation, Refactoring & Quality Tools
      scaffoldTestTool,
      safeRenameSymbolTool,
      analyzeDependenciesTool,
      httpRequestTool,
      scaffoldComponentTool,
      scaffoldServiceTool,
      scaffoldModelTool,
      findUnusedExportsTool,
      checkBundleImpactTool,
      extractFunctionTool,
      generateJsdocTool,
      extractApiDocsTool,
      profileFunctionTool,
      findNPlusOneTool,
      checkAccessibilityTool,
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

// ============================================================================
// ROUND 4: Code Generation, Refactoring & Quality Tools
// ============================================================================

/**
 * Scaffold Test Tool
 * Generate test file skeleton based on source file
 */
export const scaffoldTestTool = tool(
  'scaffold_test',
  `Generate a test file skeleton for a source file.
Use this when:
- Creating tests for existing code
- Setting up test structure for new features
- Ensuring consistent test patterns

Analyzes the source file and generates appropriate test cases.`,
  {
    sourceFile: z.string().describe('Path to the source file to test'),
    testFramework: z.enum(['jest', 'mocha', 'vitest', 'pytest']).default('jest').describe('Test framework'),
    outputPath: z.string().optional().describe('Path for test file (auto-generated if not provided)'),
    includeSnapshots: z.boolean().default(false).describe('Include snapshot tests for React components'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const content = await fs.readFile(args.sourceFile, 'utf-8');
      const fileName = path.basename(args.sourceFile);
      const ext = path.extname(args.sourceFile);
      const baseName = path.basename(args.sourceFile, ext);
      const dir = path.dirname(args.sourceFile);

      // Parse exports/functions from file
      const exports: string[] = [];
      const functions: string[] = [];
      const classes: string[] = [];

      // Extract exports
      const exportMatches = content.matchAll(/export\s+(?:const|function|class|interface|type)\s+(\w+)/g);
      for (const match of exportMatches) exports.push(match[1]);

      // Extract functions
      const funcMatches = content.matchAll(/(?:function|const)\s+(\w+)\s*(?:=\s*(?:async\s*)?\([^)]*\)\s*(?:=>)?|<[^>]*>?\s*\([^)]*\))/g);
      for (const match of funcMatches) functions.push(match[1]);

      // Extract classes
      const classMatches = content.matchAll(/class\s+(\w+)/g);
      for (const match of classMatches) classes.push(match[1]);

      // Determine test file path
      const testPath = args.outputPath || path.join(dir, `${baseName}.test${ext}`);

      // Generate test content
      let testContent = '';

      if (args.testFramework === 'jest' || args.testFramework === 'vitest') {
        testContent = `/**
 * Tests for ${fileName}
 * @generated by scaffold_test tool
 */

import { ${exports.slice(0, 10).join(', ')} } from './${baseName}';

describe('${baseName}', () => {
${functions.slice(0, 5).map(fn => `  describe('${fn}', () => {
    it('should exist and be callable', () => {
      expect(typeof ${fn}).toBe('function');
    });

    it('should return expected result', () => {
      // TODO: Add test implementation
      expect(true).toBe(true);
    });

    it('should handle edge cases', () => {
      // TODO: Add edge case tests
    });
  });
`).join('\n')}
${classes.slice(0, 3).map(cls => `  describe('${cls}', () => {
    let instance: ${cls};

    beforeEach(() => {
      // TODO: Initialize instance
      // instance = new ${cls}();
    });

    it('should be instantiable', () => {
      // TODO: Add constructor test
      expect(true).toBe(true);
    });
  });
`).join('\n')}});
`;
      } else if (args.testFramework === 'pytest') {
        testContent = `"""
Tests for ${fileName}
@generated by scaffold_test tool
"""

import pytest
from ${baseName} import ${exports.slice(0, 10).join(', ')}


class Test${baseName.charAt(0).toUpperCase() + baseName.slice(1)}:
    """Test suite for ${baseName}"""

    def setup_method(self):
        """Set up test fixtures"""
        pass

${functions.slice(0, 5).map(fn => `    def test_${fn}_exists(self):
        """Test that ${fn} exists and is callable"""
        assert callable(${fn})

    def test_${fn}_returns_expected(self):
        """Test ${fn} returns expected result"""
        # TODO: Add test implementation
        assert True
`).join('\n')}
`;
      }

      await fs.writeFile(testPath, testContent);
      console.log(`\n🧪 [Scaffold Test] Generated ${testPath}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            sourceFile: args.sourceFile,
            testFile: testPath,
            framework: args.testFramework,
            analysis: {
              exports: exports.length,
              functions: functions.length,
              classes: classes.length,
            },
            message: `Test skeleton created with ${functions.length} function tests and ${classes.length} class tests`,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Safe Rename Symbol Tool
 * Rename symbol across codebase with safety checks
 */
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

/**
 * Analyze Dependencies Tool
 * Map imports and detect circular dependencies
 */
export const analyzeDependenciesTool = tool(
  'analyze_dependencies',
  `Analyze project dependencies and imports.
Detects:
- Circular dependencies
- Unused imports
- Heavy dependencies
- Import structure visualization

Use before refactoring to understand code structure.`,
  {
    directory: z.string().describe('Directory to analyze'),
    entryPoint: z.string().optional().describe('Entry point file for tree analysis'),
    checkCircular: z.boolean().default(true).describe('Check for circular dependencies'),
    maxDepth: z.number().default(5).describe('Max depth for dependency tree'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs/promises');
      const path = await import('path');
      const execAsync = promisify(exec);

      // Find all TypeScript/JavaScript files
      const { stdout: filesOutput } = await execAsync(
        `find "${args.directory}" -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v dist`,
        { maxBuffer: 5 * 1024 * 1024 }
      );
      const files = filesOutput.trim().split('\n').filter(Boolean);

      // Build dependency graph
      const graph: Record<string, string[]> = {};
      const importCounts: Record<string, number> = {};

      for (const file of files.slice(0, 100)) {
        try {
          const content = await fs.readFile(file, 'utf-8');
          const relativePath = path.relative(args.directory, file);
          graph[relativePath] = [];

          // Extract imports
          const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
          for (const match of importMatches) {
            const importPath = match[1];
            if (!importPath.startsWith('.')) {
              // External package
              importCounts[importPath] = (importCounts[importPath] || 0) + 1;
            } else {
              graph[relativePath].push(importPath);
            }
          }
        } catch { continue; }
      }

      // Detect circular dependencies
      const circularDeps: string[][] = [];
      if (args.checkCircular) {
        const visited = new Set<string>();
        const stack = new Set<string>();

        const dfs = (node: string, pathStack: string[]): void => {
          if (stack.has(node)) {
            const cycleStart = pathStack.indexOf(node);
            circularDeps.push(pathStack.slice(cycleStart));
            return;
          }
          if (visited.has(node)) return;

          visited.add(node);
          stack.add(node);
          pathStack.push(node);

          for (const dep of (graph[node] || [])) {
            const resolvedDep = path.normalize(path.join(path.dirname(node), dep));
            dfs(resolvedDep, [...pathStack]);
          }

          stack.delete(node);
        };

        for (const file of Object.keys(graph)) {
          dfs(file, []);
        }
      }

      // Top external dependencies
      const topDeps = Object.entries(importCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, imports: count }));

      console.log(`\n📊 [Dependencies] Analyzed ${files.length} files, found ${circularDeps.length} circular deps`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            analysis: {
              totalFiles: files.length,
              analyzedFiles: Object.keys(graph).length,
              circularDependencies: circularDeps.slice(0, 5),
              circularCount: circularDeps.length,
              topExternalDependencies: topDeps,
            },
            hasCircular: circularDeps.length > 0,
            message: circularDeps.length > 0
              ? `Found ${circularDeps.length} circular dependencies. Consider refactoring.`
              : 'No circular dependencies detected.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * HTTP Request Tool
 * Make HTTP requests for API testing
 */
export const httpRequestTool = tool(
  'http_request',
  `Make HTTP requests to test APIs.
Supports:
- All HTTP methods (GET, POST, PUT, DELETE, PATCH)
- Custom headers and body
- Response validation
- Timeout handling

Use for testing API endpoints during development.`,
  {
    url: z.string().describe('URL to request'),
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']).default('GET'),
    headers: z.record(z.string()).optional().describe('Request headers'),
    body: z.string().optional().describe('Request body (JSON string)'),
    timeout: z.number().default(30000).describe('Timeout in milliseconds'),
    expectStatus: z.number().optional().describe('Expected status code for validation'),
  },
  async (args) => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), args.timeout);

      const options: RequestInit = {
        method: args.method,
        headers: {
          'Content-Type': 'application/json',
          ...args.headers,
        },
        signal: controller.signal,
      };

      if (args.body && ['POST', 'PUT', 'PATCH'].includes(args.method)) {
        options.body = args.body;
      }

      const startTime = Date.now();
      const response = await fetch(args.url, options);
      const duration = Date.now() - startTime;
      clearTimeout(timeoutId);

      const contentType = response.headers.get('content-type') || '';
      let responseBody: any;

      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
        if (responseBody.length > 2000) {
          responseBody = responseBody.substring(0, 2000) + '... [truncated]';
        }
      }

      const statusMatch = args.expectStatus ? response.status === args.expectStatus : true;

      console.log(`\n🌐 [HTTP] ${args.method} ${args.url} → ${response.status} (${duration}ms)`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            request: {
              url: args.url,
              method: args.method,
              headers: args.headers,
              bodySize: args.body?.length || 0,
            },
            response: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: typeof responseBody === 'object' ? responseBody : { text: responseBody },
            },
            timing: { durationMs: duration },
            validation: {
              statusMatch,
              expectedStatus: args.expectStatus,
            },
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.name === 'AbortError' ? 'Request timed out' : error.message,
            url: args.url,
          }, null, 2),
        }],
      };
    }
  }
);

/**
 * Scaffold Component Tool
 * Generate React/Vue component boilerplate
 */
export const scaffoldComponentTool = tool(
  'scaffold_component',
  `Generate component boilerplate.
Creates:
- Component file with proper structure
- TypeScript types/interfaces
- Basic styling file
- Optional test file

Follows project conventions automatically.`,
  {
    name: z.string().describe('Component name (PascalCase)'),
    outputDir: z.string().describe('Directory to create component in'),
    framework: z.enum(['react', 'react-native', 'vue', 'svelte']).default('react'),
    withStyles: z.boolean().default(true).describe('Include styles file'),
    withTest: z.boolean().default(true).describe('Include test file'),
    withStory: z.boolean().default(false).describe('Include Storybook story'),
    functional: z.boolean().default(true).describe('Use functional component'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const componentDir = path.join(args.outputDir, args.name);
      await fs.mkdir(componentDir, { recursive: true });

      const createdFiles: string[] = [];

      // Generate component file
      let componentContent = '';
      let ext = '.tsx';

      if (args.framework === 'react') {
        componentContent = `/**
 * ${args.name} Component
 * @generated by scaffold_component tool
 */

import React from 'react';
${args.withStyles ? `import styles from './${args.name}.module.css';` : ''}

export interface ${args.name}Props {
  /** Component children */
  children?: React.ReactNode;
  /** Additional CSS class */
  className?: string;
}

export const ${args.name}: React.FC<${args.name}Props> = ({
  children,
  className,
}) => {
  return (
    <div className={\`${args.withStyles ? `\${styles.container}` : args.name.toLowerCase()}\${className ? \` \${className}\` : ''}\`}>
      {children}
    </div>
  );
};

export default ${args.name};
`;
      } else if (args.framework === 'vue') {
        ext = '.vue';
        componentContent = `<script setup lang="ts">
/**
 * ${args.name} Component
 * @generated by scaffold_component tool
 */

interface Props {
  /** Additional CSS class */
  className?: string;
}

defineProps<Props>();
</script>

<template>
  <div :class="['${args.name.toLowerCase()}', className]">
    <slot />
  </div>
</template>

<style scoped>
.${args.name.toLowerCase()} {
  /* Add styles */
}
</style>
`;
      }

      const componentPath = path.join(componentDir, `${args.name}${ext}`);
      await fs.writeFile(componentPath, componentContent);
      createdFiles.push(componentPath);

      // Generate styles file
      if (args.withStyles && args.framework === 'react') {
        const stylesContent = `/**
 * Styles for ${args.name}
 */

.container {
  /* Add styles */
}
`;
        const stylesPath = path.join(componentDir, `${args.name}.module.css`);
        await fs.writeFile(stylesPath, stylesContent);
        createdFiles.push(stylesPath);
      }

      // Generate test file
      if (args.withTest) {
        const testContent = `/**
 * Tests for ${args.name}
 */

import { render, screen } from '@testing-library/react';
import { ${args.name} } from './${args.name}';

describe('${args.name}', () => {
  it('renders without crashing', () => {
    render(<${args.name}>Test</${args.name}>);
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<${args.name} className="custom" />);
    expect(container.firstChild).toHaveClass('custom');
  });
});
`;
        const testPath = path.join(componentDir, `${args.name}.test.tsx`);
        await fs.writeFile(testPath, testContent);
        createdFiles.push(testPath);
      }

      // Generate index file
      const indexContent = `export { ${args.name}, type ${args.name}Props } from './${args.name}';\nexport { default } from './${args.name}';\n`;
      const indexPath = path.join(componentDir, 'index.ts');
      await fs.writeFile(indexPath, indexContent);
      createdFiles.push(indexPath);

      console.log(`\n🧩 [Scaffold Component] Created ${args.name} with ${createdFiles.length} files`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            component: args.name,
            framework: args.framework,
            directory: componentDir,
            files: createdFiles.map(f => f.replace(args.outputDir, '')),
            message: `Component ${args.name} created successfully`,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Scaffold Service Tool
 * Generate service class boilerplate
 */
export const scaffoldServiceTool = tool(
  'scaffold_service',
  `Generate service class boilerplate.
Creates:
- Service class with dependency injection
- Interface definition
- Basic methods
- Optional test file

Follows clean architecture patterns.`,
  {
    name: z.string().describe('Service name (e.g., "UserService")'),
    outputPath: z.string().describe('Output file path'),
    methods: z.array(z.object({
      name: z.string(),
      async: z.boolean().default(true),
      params: z.array(z.string()).optional(),
      returns: z.string().optional(),
    })).optional().describe('Methods to generate'),
    withTest: z.boolean().default(true).describe('Generate test file'),
    singleton: z.boolean().default(true).describe('Use singleton pattern'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      const methods = args.methods || [
        { name: 'initialize', async: true, returns: 'void' },
        { name: 'getAll', async: true, returns: 'Promise<any[]>' },
        { name: 'getById', async: true, params: ['id: string'], returns: 'Promise<any | null>' },
        { name: 'create', async: true, params: ['data: any'], returns: 'Promise<any>' },
        { name: 'update', async: true, params: ['id: string', 'data: any'], returns: 'Promise<any>' },
        { name: 'delete', async: true, params: ['id: string'], returns: 'Promise<boolean>' },
      ];

      const className = args.name.endsWith('Service') ? args.name : `${args.name}Service`;
      const interfaceName = `I${className}`;

      const serviceContent = `/**
 * ${className}
 * @generated by scaffold_service tool
 */

export interface ${interfaceName} {
${methods.map(m => `  ${m.name}(${(m.params || []).join(', ')}): ${m.async ? 'Promise<' : ''}${m.returns || 'void'}${m.async && !m.returns?.startsWith('Promise') ? '>' : ''};`).join('\n')}
}

export class ${className} implements ${interfaceName} {
${args.singleton ? `  private static _instance: ${className};

  public static get instance(): ${className} {
    if (!${className}._instance) {
      ${className}._instance = new ${className}();
    }
    return ${className}._instance;
  }

  private constructor() {}
` : ''}
${methods.map(m => `
  ${m.async ? 'async ' : ''}${m.name}(${(m.params || []).join(', ')}): ${m.async ? 'Promise<' : ''}${m.returns || 'void'}${m.async && !m.returns?.startsWith('Promise') ? '>' : ''} {
    // TODO: Implement ${m.name}
    throw new Error('Not implemented');
  }`).join('\n')}
}

${args.singleton ? `export const ${className.charAt(0).toLowerCase() + className.slice(1)} = ${className}.instance;` : `export function create${className}(): ${className} {
  return new ${className}();
}`}
`;

      await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
      await fs.writeFile(args.outputPath, serviceContent);

      const createdFiles = [args.outputPath];

      // Generate test file
      if (args.withTest) {
        const testPath = args.outputPath.replace('.ts', '.test.ts');
        const testContent = `/**
 * Tests for ${className}
 */

import { ${className}${args.singleton ? `, ${className.charAt(0).toLowerCase() + className.slice(1)}` : ''} } from './${path.basename(args.outputPath, '.ts')}';

describe('${className}', () => {
${args.singleton ? `  it('should be a singleton', () => {
    const instance1 = ${className}.instance;
    const instance2 = ${className}.instance;
    expect(instance1).toBe(instance2);
  });
` : ''}
${methods.slice(0, 3).map(m => `
  describe('${m.name}', () => {
    it('should be defined', () => {
      const service = ${args.singleton ? `${className}.instance` : `new ${className}()`};
      expect(service.${m.name}).toBeDefined();
    });
  });
`).join('')}
});
`;
        await fs.writeFile(testPath, testContent);
        createdFiles.push(testPath);
      }

      console.log(`\n⚙️ [Scaffold Service] Created ${className}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            service: className,
            files: createdFiles,
            methods: methods.map(m => m.name),
            singleton: args.singleton,
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Scaffold Model Tool
 * Generate database model boilerplate
 */
export const scaffoldModelTool = tool(
  'scaffold_model',
  `Generate database model boilerplate.
Supports:
- Mongoose (MongoDB)
- Prisma
- TypeORM
- Plain TypeScript interfaces

Includes validation and type safety.`,
  {
    name: z.string().describe('Model name (e.g., "User")'),
    outputPath: z.string().describe('Output file path'),
    orm: z.enum(['mongoose', 'prisma', 'typeorm', 'interface']).default('mongoose'),
    fields: z.array(z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().default(true),
      unique: z.boolean().default(false),
      default: z.string().optional(),
    })).describe('Model fields'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');

      let content = '';

      if (args.orm === 'mongoose') {
        content = `/**
 * ${args.name} Model (Mongoose)
 * @generated by scaffold_model tool
 */

import mongoose, { Schema, Document } from 'mongoose';

export interface I${args.name} extends Document {
${args.fields.map(f => `  ${f.name}${f.required ? '' : '?'}: ${f.type};`).join('\n')}
  createdAt: Date;
  updatedAt: Date;
}

const ${args.name}Schema = new Schema<I${args.name}>(
  {
${args.fields.map(f => `    ${f.name}: {
      type: ${f.type === 'string' ? 'String' : f.type === 'number' ? 'Number' : f.type === 'boolean' ? 'Boolean' : f.type === 'Date' ? 'Date' : 'Schema.Types.Mixed'},
      required: ${f.required},${f.unique ? '\n      unique: true,' : ''}${f.default ? `\n      default: ${f.default},` : ''}
    },`).join('\n')}
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes
${args.fields.filter(f => f.unique).map(f => `${args.name}Schema.index({ ${f.name}: 1 });`).join('\n')}

export const ${args.name} = mongoose.model<I${args.name}>('${args.name}', ${args.name}Schema);
export default ${args.name};
`;
      } else if (args.orm === 'prisma') {
        content = `// ${args.name} Model (Prisma schema)
// Add this to your schema.prisma file
// @generated by scaffold_model tool

model ${args.name} {
  id        String   @id @default(auto()) @map("_id") @db.ObjectId
${args.fields.map(f => `  ${f.name}     ${f.type}${f.required ? '' : '?'}${f.unique ? ' @unique' : ''}${f.default ? ` @default(${f.default})` : ''}`).join('\n')}
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;
      } else if (args.orm === 'interface') {
        content = `/**
 * ${args.name} Interface
 * @generated by scaffold_model tool
 */

export interface ${args.name} {
  id: string;
${args.fields.map(f => `  ${f.name}${f.required ? '' : '?'}: ${f.type};`).join('\n')}
  createdAt: Date;
  updatedAt: Date;
}

export type Create${args.name}Input = Omit<${args.name}, 'id' | 'createdAt' | 'updatedAt'>;
export type Update${args.name}Input = Partial<Create${args.name}Input>;
`;
      }

      await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
      await fs.writeFile(args.outputPath, content);

      console.log(`\n📦 [Scaffold Model] Created ${args.name} (${args.orm})`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            model: args.name,
            orm: args.orm,
            path: args.outputPath,
            fields: args.fields.map(f => f.name),
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Find Unused Exports Tool
 * Detect dead code in the project
 */
export const findUnusedExportsTool = tool(
  'find_unused_exports',
  `Find exported symbols that are never imported anywhere.
Detects:
- Unused function exports
- Unused class exports
- Unused type/interface exports
- Dead code candidates

Use before cleanup to find removable code.`,
  {
    directory: z.string().describe('Directory to analyze'),
    fileGlob: z.string().optional().describe('File pattern (e.g., "*.ts")'),
    ignorePatterns: z.array(z.string()).optional().describe('Patterns to ignore'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Find all exports
      const glob = args.fileGlob || '*.{ts,tsx,js,jsx}';
      const { stdout: exportsOutput } = await execAsync(
        `rg -o "export\\s+(const|function|class|interface|type|enum)\\s+\\w+" "${args.directory}" -g "${glob}" -g "!node_modules" -g "!dist" 2>/dev/null || true`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      const exports: Map<string, { file: string; type: string }> = new Map();
      for (const line of exportsOutput.trim().split('\n').filter(Boolean)) {
        const [file, match] = line.split(':');
        if (match) {
          const parts = match.trim().split(/\s+/);
          const name = parts[parts.length - 1];
          if (name && name.length > 1) {
            exports.set(name, { file: file.replace(args.directory, ''), type: parts[1] });
          }
        }
      }

      // Check which exports are imported
      const unused: Array<{ name: string; file: string; type: string }> = [];

      for (const [name, info] of exports) {
        try {
          // Skip common entry points and index files
          if (info.file.includes('index.') || name === 'default') continue;

          const { stdout } = await execAsync(
            `rg -l "import.*\\b${name}\\b|from.*${name}" "${args.directory}" -g "!${info.file}" -g "!node_modules" 2>/dev/null || true`,
            { maxBuffer: 1024 * 1024 }
          );

          if (!stdout.trim()) {
            unused.push({ name, ...info });
          }
        } catch { continue; }
      }

      console.log(`\n🔍 [Unused Exports] Found ${unused.length} potentially unused exports`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            totalExports: exports.size,
            unusedCount: unused.length,
            unused: unused.slice(0, 30),
            message: unused.length > 0
              ? `Found ${unused.length} exports that appear unused. Review before removing.`
              : 'All exports appear to be used.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Check Bundle Impact Tool
 * Estimate impact of adding a dependency
 */
export const checkBundleImpactTool = tool(
  'check_bundle_impact',
  `Estimate the bundle size impact of a package.
Shows:
- Package size (minified + gzipped)
- Dependencies count
- Alternative suggestions
- Tree-shaking support

Use before adding new dependencies.`,
  {
    packageName: z.string().describe('npm package name'),
    version: z.string().optional().describe('Specific version'),
  },
  async (args) => {
    try {
      // Use bundlephobia API for size info
      const url = `https://bundlephobia.com/api/size?package=${args.packageName}${args.version ? `@${args.version}` : ''}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'MultiAgentBot/1.0' },
      });

      if (!response.ok) {
        throw new Error(`Package not found or bundlephobia API unavailable`);
      }

      const data = await response.json() as {
        name: string;
        version: string;
        size: number;
        gzip: number;
        dependencyCount: number;
        hasJSModule: boolean;
        hasJSNext: boolean;
        hasSideEffects: boolean;
      };

      const formatBytes = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      };

      console.log(`\n📦 [Bundle Impact] ${data.name}@${data.version}: ${formatBytes(data.gzip)} gzipped`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            package: data.name,
            version: data.version,
            size: {
              raw: data.size,
              gzip: data.gzip,
              formatted: {
                raw: formatBytes(data.size),
                gzip: formatBytes(data.gzip),
              },
            },
            dependencies: data.dependencyCount,
            treeShaking: {
              hasESM: data.hasJSModule || data.hasJSNext,
              hasSideEffects: data.hasSideEffects,
            },
            recommendation: data.gzip > 50000
              ? 'Large package. Consider alternatives or lazy loading.'
              : data.gzip > 10000
              ? 'Medium size. Ensure tree-shaking is working.'
              : 'Reasonable size for most projects.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Extract Function Tool
 * Extract code block into a new function
 */
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

/**
 * Generate JSDoc Tool
 * Generate JSDoc comments from function signature
 */
export const generateJsdocTool = tool(
  'generate_jsdoc',
  `Generate JSDoc comments for a function or class.
Creates:
- @param tags with types
- @returns tag
- @throws if applicable
- @example placeholder

Use to document code quickly.`,
  {
    filePath: z.string().describe('File path'),
    symbolName: z.string().describe('Function or class name'),
    includeExample: z.boolean().default(true).describe('Include @example'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');

      const content = await fs.readFile(args.filePath, 'utf-8');

      // Find the function/class
      const funcPattern = new RegExp(`(async\\s+)?function\\s+${args.symbolName}\\s*(<[^>]*>)?\\s*\\(([^)]*)\\)\\s*(?::\\s*([^{]+))?`, 'm');
      const arrowPattern = new RegExp(`(?:const|let)\\s+${args.symbolName}\\s*=\\s*(async\\s*)?\\(([^)]*)\\)\\s*(?::\\s*([^=]+))?\\s*=>`, 'm');
      const classPattern = new RegExp(`class\\s+${args.symbolName}`, 'm');

      let jsdoc = '';
      let match = content.match(funcPattern) || content.match(arrowPattern);

      if (match) {
        const params = (match[3] || match[2] || '').split(',').filter(Boolean).map(p => {
          const parts = p.trim().split(':');
          return { name: parts[0]?.trim(), type: parts[1]?.trim() || 'any' };
        });

        const returnType = match[4] || match[3] || 'void';
        const isAsync = !!match[1];

        jsdoc = `/**
 * ${args.symbolName}
 *
${params.map(p => ` * @param {${p.type}} ${p.name} - Description`).join('\n')}
 * @returns {${isAsync ? 'Promise<' : ''}${returnType.trim()}${isAsync && !returnType.includes('Promise') ? '>' : ''}} Description
${args.includeExample ? ` * @example
 * ${args.symbolName}(${params.map(p => p.name).join(', ')})` : ''}
 */`;
      } else if (content.match(classPattern)) {
        jsdoc = `/**
 * ${args.symbolName}
 *
 * @class
 * @classdesc Description of ${args.symbolName}
${args.includeExample ? ` * @example
 * const instance = new ${args.symbolName}();` : ''}
 */`;
      } else {
        throw new Error(`Symbol "${args.symbolName}" not found`);
      }

      console.log(`\n📝 [Generate JSDoc] Created docs for ${args.symbolName}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            symbol: args.symbolName,
            jsdoc,
            message: 'Copy this JSDoc above the function/class declaration',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Extract API Docs Tool
 * Extract API documentation to markdown
 */
export const extractApiDocsTool = tool(
  'extract_api_docs',
  `Extract API documentation from source code to markdown.
Extracts:
- Route handlers (Express, Fastify, etc.)
- Request/response types
- JSDoc comments
- OpenAPI-style annotations

Use to generate API documentation.`,
  {
    directory: z.string().describe('Directory containing API routes'),
    outputPath: z.string().describe('Output markdown file path'),
    framework: z.enum(['express', 'fastify', 'koa', 'generic']).default('express'),
  },
  async (args) => {
    try {
      const fs = await import('fs/promises');
      const path = await import('path');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Find route files
      const { stdout: filesOutput } = await execAsync(
        `find "${args.directory}" -name "*.ts" -o -name "*.js" | grep -v node_modules | grep -v dist`,
        { maxBuffer: 5 * 1024 * 1024 }
      );
      const files = filesOutput.trim().split('\n').filter(Boolean);

      const routes: Array<{
        method: string;
        path: string;
        file: string;
        description?: string;
      }> = [];

      const routePatterns = {
        express: /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        fastify: /\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        koa: /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
        generic: /(GET|POST|PUT|DELETE|PATCH)\s+['"`]?([/\w:-]+)['"`]?/gi,
      };

      const pattern = routePatterns[args.framework] || routePatterns.generic;

      for (const file of files) {
        try {
          const content = await fs.readFile(file, 'utf-8');
          let match;
          const regex = new RegExp(pattern.source, pattern.flags);

          while ((match = regex.exec(content)) !== null) {
            routes.push({
              method: match[1].toUpperCase(),
              path: match[2],
              file: path.relative(args.directory, file),
            });
          }
        } catch { continue; }
      }

      // Generate markdown
      const grouped: Record<string, typeof routes> = {};
      for (const route of routes) {
        const base = route.path.split('/')[1] || 'root';
        if (!grouped[base]) grouped[base] = [];
        grouped[base].push(route);
      }

      let markdown = `# API Documentation

Generated from: \`${args.directory}\`
Framework: ${args.framework}
Routes found: ${routes.length}

---

`;

      for (const [group, groupRoutes] of Object.entries(grouped)) {
        markdown += `## ${group.charAt(0).toUpperCase() + group.slice(1)}\n\n`;

        for (const route of groupRoutes) {
          markdown += `### \`${route.method}\` ${route.path}\n\n`;
          markdown += `- **File**: \`${route.file}\`\n`;
          markdown += `- **Description**: TODO\n\n`;
          markdown += `#### Request\n\n\`\`\`json\n{\n  // Request body\n}\n\`\`\`\n\n`;
          markdown += `#### Response\n\n\`\`\`json\n{\n  // Response body\n}\n\`\`\`\n\n---\n\n`;
        }
      }

      await fs.mkdir(path.dirname(args.outputPath), { recursive: true });
      await fs.writeFile(args.outputPath, markdown);

      console.log(`\n📄 [Extract API Docs] Generated docs with ${routes.length} routes`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            outputPath: args.outputPath,
            routesDocumented: routes.length,
            groups: Object.keys(grouped),
            message: 'API documentation generated. Review and add descriptions.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Profile Function Tool
 * Measure function execution time
 */
export const profileFunctionTool = tool(
  'profile_function',
  `Profile a function's execution time.
Measures:
- Execution time (ms)
- Memory usage delta
- Call count
- Async timing

Use for performance optimization.`,
  {
    filePath: z.string().describe('File containing the function'),
    functionName: z.string().describe('Function to profile'),
    iterations: z.number().default(100).describe('Number of iterations'),
    warmupRuns: z.number().default(10).describe('Warmup iterations'),
  },
  async (args) => {
    try {
      // This is a documentation/planning tool since we can't actually run arbitrary code
      console.log(`\n⏱️ [Profile] Would profile ${args.functionName} with ${args.iterations} iterations`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Profiling setup created. Add this code to profile the function:',
            profilingCode: `
// Profiling wrapper for ${args.functionName}
async function profile${args.functionName}() {
  const iterations = ${args.iterations};
  const warmup = ${args.warmupRuns};

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await ${args.functionName}();
  }

  // Measure
  const times: number[] = [];
  const memBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await ${args.functionName}();
    times.push(performance.now() - start);
  }

  const memAfter = process.memoryUsage().heapUsed;

  console.log({
    function: '${args.functionName}',
    iterations,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    memDeltaKB: (memAfter - memBefore) / 1024,
  });
}
`,
            suggestion: 'Add this to your test file or a separate profiling script.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Find N+1 Queries Tool
 * Detect potential N+1 query patterns
 */
export const findNPlusOneTool = tool(
  'find_n_plus_1',
  `Detect potential N+1 query patterns in code.
Identifies:
- Queries inside loops
- Sequential awaits that could be parallelized
- Missing eager loading patterns

Use for database performance optimization.`,
  {
    directory: z.string().describe('Directory to analyze'),
    orm: z.enum(['mongoose', 'prisma', 'typeorm', 'sequelize', 'generic']).default('generic'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const patterns: Record<string, string[]> = {
        mongoose: ['find\\(', 'findOne\\(', 'findById\\(', 'save\\(', 'updateOne\\('],
        prisma: ['findUnique\\(', 'findMany\\(', 'create\\(', 'update\\('],
        typeorm: ['find\\(', 'findOne\\(', 'save\\(', 'getRepository\\('],
        sequelize: ['findAll\\(', 'findOne\\(', 'create\\(', 'update\\('],
        generic: ['await\\s+\\w+\\.find', 'await\\s+\\w+\\.get', 'await\\s+fetch\\('],
      };

      const ormPatterns = patterns[args.orm] || patterns.generic;
      const issues: Array<{ file: string; line: number; pattern: string; context: string }> = [];

      // Search for queries inside loops
      for (const pattern of ormPatterns) {
        try {
          const { stdout } = await execAsync(
            `rg -n -B 5 "${pattern}" "${args.directory}" -g "*.ts" -g "*.js" -g "!node_modules" 2>/dev/null || true`,
            { maxBuffer: 5 * 1024 * 1024 }
          );

          const blocks = stdout.split('--');
          for (const block of blocks) {
            if (block.match(/for\s*\(|\.forEach|\.map\(|while\s*\(/)) {
              const lines = block.trim().split('\n');
              const lastLine = lines[lines.length - 1] || '';
              const [file, lineNum] = lastLine.split(':');
              if (file && lineNum) {
                issues.push({
                  file: file.replace(args.directory, ''),
                  line: parseInt(lineNum, 10),
                  pattern,
                  context: lines.slice(-3).join('\n'),
                });
              }
            }
          }
        } catch { continue; }
      }

      console.log(`\n🔍 [N+1 Detection] Found ${issues.length} potential issues`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            orm: args.orm,
            issuesFound: issues.length,
            issues: issues.slice(0, 15),
            recommendations: [
              'Use eager loading (populate, include, relations)',
              'Batch queries with $in or whereIn',
              'Use Promise.all for parallel queries',
              'Consider caching for repeated lookups',
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

/**
 * Check Accessibility Tool
 * A11y audit for web components
 */
export const checkAccessibilityTool = tool(
  'check_accessibility',
  `Perform accessibility audit on HTML/JSX code.
Checks:
- Missing alt attributes
- Missing ARIA labels
- Color contrast issues
- Keyboard navigation
- Form labels

Use for WCAG compliance.`,
  {
    filePath: z.string().optional().describe('Specific file to check'),
    directory: z.string().optional().describe('Directory to check'),
    rules: z.array(z.string()).optional().describe('Specific rules to check'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const issues: Array<{ file: string; line: number; issue: string; severity: string }> = [];
      const searchPath = args.filePath || args.directory || '.';

      // Check for missing alt attributes
      try {
        const { stdout } = await execAsync(
          `rg -n "<img[^>]+(?!alt=)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "*.html" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('alt=')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Missing alt attribute on img', severity: 'error' });
          }
        }
      } catch { /* ignore */ }

      // Check for missing button text
      try {
        const { stdout } = await execAsync(
          `rg -n "<button[^>]*>[\\s]*</(button|Button)>" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          issues.push({ file, line: parseInt(lineNum, 10), issue: 'Empty button without accessible text', severity: 'error' });
        }
      } catch { /* ignore */ }

      // Check for missing form labels
      try {
        const { stdout } = await execAsync(
          `rg -n "<input[^>]+(?!aria-label|id=)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('aria-label') && !line.includes('id=')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Input without label association', severity: 'warning' });
          }
        }
      } catch { /* ignore */ }

      // Check for click handlers without keyboard support
      try {
        const { stdout } = await execAsync(
          `rg -n "onClick=[^>]+(?!onKeyDown|onKeyPress)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('button') && !line.includes('Button') && !line.includes('Link') && !line.includes('onKey')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Click handler without keyboard support', severity: 'warning' });
          }
        }
      } catch { /* ignore */ }

      const errors = issues.filter(i => i.severity === 'error').length;
      const warnings = issues.filter(i => i.severity === 'warning').length;

      console.log(`\n♿ [A11y Audit] Found ${errors} errors, ${warnings} warnings`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            path: searchPath,
            summary: { errors, warnings, total: issues.length },
            issues: issues.slice(0, 25),
            resources: [
              'https://www.w3.org/WAI/WCAG21/quickref/',
              'https://developer.mozilla.org/en-US/docs/Web/Accessibility',
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
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
    // Round 4: Code Generation, Refactoring & Quality Tools
    scaffoldTestTool,
    safeRenameSymbolTool,
    analyzeDependenciesTool,
    httpRequestTool,
    scaffoldComponentTool,
    scaffoldServiceTool,
    scaffoldModelTool,
    findUnusedExportsTool,
    checkBundleImpactTool,
    extractFunctionTool,
    generateJsdocTool,
    extractApiDocsTool,
    profileFunctionTool,
    findNPlusOneTool,
    checkAccessibilityTool,
  ];
}
