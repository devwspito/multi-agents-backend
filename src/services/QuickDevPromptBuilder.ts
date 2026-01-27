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
