/**
 * IDE Tools - Editor, planning, and control flow tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Session stores for stateful tools
const todoStore: Map<string, any[]> = new Map();
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
