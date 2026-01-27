/**
 * QuickDevPromptBuilder
 *
 * Builds minimal prompts for quick developer tasks in the Lite Team feature.
 * This is intentionally simple - no epic/story structure, just task + workspace.
 */

import { getInstructionSection, getRoleSummary } from '../agents/ReadmeSystem';

export interface QuickDevContext {
  command: string;           // User's task description
  workspacePath: string;     // Full path to workspace
  repoPath?: string;         // Path to repo within workspace
  fileList: string;          // ls output of workspace
  currentBranch?: string;    // Current git branch
  targetRepository?: string; // Repository name
}

/**
 * Build minimal prompt for quick developer task
 */
export function buildQuickDevPrompt(ctx: QuickDevContext): string {
  // Get isolation rules (critical for safety)
  const isolationRules = getInstructionSection('isolation');

  // Get condensed developer role (shorter than full getRoleInstructions)
  const developerSummary = getRoleSummary('developer');

  // Generate commit message from task
  const commitMsg = generateCommitMessage(ctx.command);

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

### 3. VERIFY
- Run build/lint if applicable:
  \`\`\`
  sandbox_bash(command="npm run build 2>&1 | head -50")
  # or for Flutter:
  sandbox_bash(command="flutter analyze 2>&1 | head -50")
  \`\`\`

### 4. COMMIT & PUSH (MANDATORY)
When done, commit and push your changes:
\`\`\`
sandbox_bash(command="git add -A && git commit -m '${commitMsg}' && git push origin ${ctx.currentBranch || 'main'}")
\`\`\`

### 5. FINISH
Output this marker when complete:
\`\`\`
DEVELOPER_FINISHED_SUCCESSFULLY
\`\`\`

---

## RULES
- Use \`sandbox_bash\` for ALL commands (not \`Bash\`)
- Read files before editing them
- Keep changes focused on the task
- Always commit and push when done
- Output the success marker at the end

---

## IMPORTANT
You are running in a sandbox container. All file operations and commands
should use \`sandbox_bash\`. The workspace is already cloned and ready.

Now complete the task: **${ctx.command}**
`;
}

/**
 * Generate a conventional commit message from task description
 */
function generateCommitMessage(command: string): string {
  const lower = command.toLowerCase();

  // Determine commit type
  let type = 'feat';
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) {
    type = 'fix';
  } else if (lower.includes('refactor') || lower.includes('clean')) {
    type = 'refactor';
  } else if (lower.includes('style') || lower.includes('format')) {
    type = 'style';
  } else if (lower.includes('test')) {
    type = 'test';
  } else if (lower.includes('doc')) {
    type = 'docs';
  }

  // Truncate and clean the message
  const cleanMessage = command
    .replace(/['"]/g, '')
    .substring(0, 50)
    .trim();

  return `${type}: ${cleanMessage}`;
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
