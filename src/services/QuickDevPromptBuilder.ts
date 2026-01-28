/**
 * QuickDevPromptBuilder
 *
 * Builds minimal prompts for quick developer tasks in the Lite Team feature.
 * This is intentionally simple - no epic/story structure, just task + workspace.
 *
 * IMPORTANT: Agent does NOT commit/push - user does it manually from Build tab.
 */

import { getInstructionSection, getRoleSummary } from '../agents/ReadmeSystem';

export interface QuickDevContext {
  command: string;           // User's task description
  workspacePath: string;     // Full path to workspace
  repoPath?: string;         // Path to repo within workspace
  fileList: string;          // ls output of workspace
  currentBranch?: string;    // Current git branch
  targetRepository?: string; // Repository name
  mode?: 'code' | 'explore' | 'ask' | 'plan';  // Execution mode
}

/**
 * Build minimal prompt for quick developer task
 */
export function buildQuickDevPrompt(ctx: QuickDevContext): string {
  // Get isolation rules (critical for safety)
  const isolationRules = getInstructionSection('isolation');

  // Get condensed developer role (shorter than full getRoleInstructions)
  const developerSummary = getRoleSummary('developer');

  return `# QUICK DEVELOPER TASK - LITE TEAM MODE

${isolationRules}

---

## YOUR ROLE
${developerSummary}

---

## YOUR TASK
**${ctx.command}**

---

## WORKSPACE CONTEXT
- **Working Directory**: ${ctx.repoPath || ctx.workspacePath}
- **Repository**: ${ctx.targetRepository || 'current'}
- **Branch**: ${ctx.currentBranch || 'main'}

### Files in workspace:
\`\`\`
${ctx.fileList}
\`\`\`

---

## WORKFLOW (FOLLOW EXACTLY)

### 1. UNDERSTAND
- Read the files you need to modify FIRST
- Understand the existing code structure

### 2. IMPLEMENT
- Make the required changes
- Use \`sandbox_bash\` for ALL shell commands (NOT Bash)
- Use \`Read\` before \`Edit\` for any file modification

### 3. VERIFY (if applicable)
- Run build/lint to check your changes:
  \`\`\`
  sandbox_bash(command="npm run build 2>&1 | head -50")
  # or for Flutter:
  sandbox_bash(command="flutter analyze 2>&1 | head -50")
  \`\`\`

### 4. FINISH
When your code changes are complete, output this marker:
\`\`\`
DEVELOPER_FINISHED_SUCCESSFULLY
\`\`\`

---

## RULES
- Use \`sandbox_bash\` for ALL commands (not \`Bash\`)
- Read files before editing them
- Keep changes focused on the task
- Output the success marker when done

---

## ⛔ PROHIBITED - DO NOT DO THIS
**DO NOT run git commit, git push, or any git write operations.**
The user will review your changes and commit/push manually from the UI.
Only make code changes - no git operations except \`git status\` or \`git diff\`.

---

## IMPORTANT
You are running in a sandbox container. All file operations and commands
should use \`sandbox_bash\`. The workspace is already cloned and ready.

Now complete the task: **${ctx.command}**
`;
}

/**
 * Build prompt for EXPLORE mode - read-only codebase exploration
 */
export function buildExplorePrompt(ctx: QuickDevContext): string {
  const isolationRules = getInstructionSection('isolation');

  return `# EXPLORE MODE - READ-ONLY CODEBASE ANALYSIS

${isolationRules}

---

## YOUR ROLE
You are a **Code Explorer** - you analyze and explain code WITHOUT making changes.
Your job is to help the user understand their codebase.

---

## USER'S QUESTION
**${ctx.command}**

---

## WORKSPACE CONTEXT
- **Working Directory**: ${ctx.repoPath || ctx.workspacePath}
- **Repository**: ${ctx.targetRepository || 'current'}
- **Branch**: ${ctx.currentBranch || 'main'}

### Files in workspace:
\`\`\`
${ctx.fileList}
\`\`\`

---

## ALLOWED TOOLS (READ-ONLY)
- \`Read\` - Read file contents
- \`Glob\` - Find files by pattern
- \`Grep\` - Search code content
- \`sandbox_bash\` - ONLY for read commands: ls, cat, find, git status, git log

## ⛔ PROHIBITED
- **NO** Edit, Write, or file modifications
- **NO** git commit, git push, or write operations
- **NO** npm install, pip install, or dependency changes
- **NO** running servers or executing code that changes state

---

## OUTPUT FORMAT
Provide a clear, helpful explanation:
1. Answer the user's question directly
2. Include relevant code snippets you found
3. Explain how the code works
4. Point to specific files and line numbers

End with:
\`\`\`
EXPLORE_COMPLETED
\`\`\`

Now explore the codebase to answer: **${ctx.command}**
`;
}

/**
 * Build prompt for ASK mode - question answering without actions
 */
export function buildAskPrompt(ctx: QuickDevContext): string {
  const isolationRules = getInstructionSection('isolation');

  return `# ASK MODE - ANSWER QUESTIONS ONLY

${isolationRules}

---

## YOUR ROLE
You are a **Technical Assistant** - you answer questions using your knowledge
and the codebase context. You do NOT perform any actions.

---

## USER'S QUESTION
**${ctx.command}**

---

## WORKSPACE CONTEXT
- **Repository**: ${ctx.targetRepository || 'current'}
- **Branch**: ${ctx.currentBranch || 'main'}

### Available files:
\`\`\`
${ctx.fileList}
\`\`\`

---

## ALLOWED TOOLS
- \`Read\` - Read file contents if needed for context
- \`Grep\` - Search for relevant code

## ⛔ PROHIBITED
- **NO** writing or modifying files
- **NO** running commands that change state
- **NO** git operations
- **NO** installing dependencies

---

## OUTPUT FORMAT
Answer the question directly and concisely:
1. Provide a clear answer
2. Include code examples if helpful
3. Reference specific files if relevant
4. Suggest next steps if applicable

End with:
\`\`\`
ASK_COMPLETED
\`\`\`

Now answer: **${ctx.command}**
`;
}

/**
 * Build prompt for PLAN mode - analysis and planning without execution
 */
export function buildPlanPrompt(ctx: QuickDevContext): string {
  const isolationRules = getInstructionSection('isolation');

  return `# PLAN MODE - ANALYZE AND PLAN (NO EXECUTION)

${isolationRules}

---

## YOUR ROLE
You are a **Technical Planner** - you analyze the codebase and create implementation plans.
You do NOT execute any changes - you ONLY provide a detailed plan.

---

## TASK TO PLAN
**${ctx.command}**

---

## WORKSPACE CONTEXT
- **Working Directory**: ${ctx.repoPath || ctx.workspacePath}
- **Repository**: ${ctx.targetRepository || 'current'}
- **Branch**: ${ctx.currentBranch || 'main'}

### Available files:
\`\`\`
${ctx.fileList}
\`\`\`

---

## ALLOWED TOOLS (READ-ONLY)
- \`Read\` - Read files to understand current implementation
- \`Glob\` - Find relevant files
- \`Grep\` - Search for patterns and dependencies
- \`sandbox_bash\` - ONLY for: ls, cat, find, git status, git diff

## ⛔ PROHIBITED
- **NO** Edit, Write, or file modifications
- **NO** running build, test, or deploy commands
- **NO** git commit, push, or branch operations
- **NO** installing or updating dependencies

---

## OUTPUT FORMAT
Provide a structured implementation plan:

### 1. Analysis
- What files need to be changed?
- What are the dependencies?
- What risks or challenges exist?

### 2. Implementation Steps
Number each step clearly:
1. First, do X because...
2. Then, modify Y to...
3. Finally, update Z with...

### 3. Files to Modify
List each file with what changes are needed:
- \`path/to/file.ts\` - Add function X, update import Y
- \`path/to/other.ts\` - Modify class Z

### 4. Testing Strategy
How should the changes be verified?

End with:
\`\`\`
PLAN_COMPLETED
\`\`\`

Now analyze and plan: **${ctx.command}**
`;
}

/**
 * Get the appropriate prompt builder based on mode
 */
export function buildPromptForMode(ctx: QuickDevContext): string {
  const mode = ctx.mode || 'code';

  switch (mode) {
    case 'explore':
      return buildExplorePrompt(ctx);
    case 'ask':
      return buildAskPrompt(ctx);
    case 'plan':
      return buildPlanPrompt(ctx);
    case 'code':
    default:
      return buildQuickDevPrompt(ctx);
  }
}

/**
 * Build minimal prompt for quick Judge review (optional)
 */
export function buildQuickJudgePrompt(ctx: {
  taskDescription: string;
  changedFiles: string[];
  workspacePath: string;
  commitSha?: string;
}): string {
  return `# QUICK CODE REVIEW - LITE TEAM MODE

## TASK COMPLETED
${ctx.taskDescription}

## FILES CHANGED
${ctx.changedFiles.map(f => `- ${f}`).join('\n')}

## YOUR JOB
1. Read each changed file
2. Check if the implementation matches the task
3. Look for obvious bugs or issues
4. Provide brief feedback

## OUTPUT FORMAT
If approved:
\`\`\`
JUDGE_APPROVED
Brief: Changes look good, task completed correctly.
\`\`\`

If issues found:
\`\`\`
JUDGE_NEEDS_CHANGES
Issues:
- Issue 1
- Issue 2
\`\`\`

Now review the changes.
`;
}
