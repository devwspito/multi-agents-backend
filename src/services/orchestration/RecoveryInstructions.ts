/**
 * RecoveryInstructions - Generates context-aware instructions
 * to help agents avoid repeating the same failure patterns.
 *
 * When an execution fails and is retried, we inject additional
 * instructions based on the failure type to guide the agent.
 */

import { FailureType } from '../../models/FailedExecution';

interface RecoveryContext {
  failureType: FailureType;
  turnsCompleted: number;
  messagesReceived: number;
  lastMessageTypes?: string[];
  filesModified?: string[];
  retryCount: number;
}

/**
 * Get recovery instructions based on failure type
 */
export function getRecoveryInstructions(context: RecoveryContext): string {
  const instructions: string[] = [];

  // Header
  instructions.push(`
## ⚠️ RECOVERY MODE - IMPORTANT INSTRUCTIONS

This execution is a RETRY after a previous failure. To succeed this time, you MUST follow these guidelines:
`);

  // Failure-specific instructions
  switch (context.failureType) {
    case 'timeout':
      instructions.push(getTimeoutRecoveryInstructions(context));
      break;

    case 'loop_detection':
      instructions.push(getLoopRecoveryInstructions(context));
      break;

    case 'history_overflow':
      instructions.push(getHistoryOverflowInstructions(context));
      break;

    case 'sdk_error':
    case 'api_error':
      instructions.push(getApiErrorInstructions(context));
      break;

    case 'git_error':
      instructions.push(getGitErrorInstructions(context));
      break;

    default:
      instructions.push(getGenericRecoveryInstructions(context));
  }

  // Common instructions for all retries
  instructions.push(getCommonRetryInstructions(context));

  return instructions.join('\n');
}

function getTimeoutRecoveryInstructions(context: RecoveryContext): string {
  return `
### 🕐 TIMEOUT RECOVERY (previous execution timed out after ${context.turnsCompleted} turns)

The previous execution ran out of time. To complete successfully:

1. **PRIORITIZE CRITICAL TASKS** - Focus on the most important parts first
2. **DON'T OVER-EXPLORE** - You have ${context.retryCount > 0 ? 'already explored this codebase' : 'limited time'}. Use what you know.
3. **MAKE INCREMENTAL PROGRESS** - Complete smaller pieces rather than planning big changes
4. **COMMIT EARLY** - Save your work frequently with git commits
5. **SKIP OPTIONAL STEPS** - If something is nice-to-have but not essential, skip it

${context.filesModified && context.filesModified.length > 0 ? `
**Previous progress:** You modified these files before timeout:
${context.filesModified.slice(0, 10).map(f => `- ${f}`).join('\n')}
${context.filesModified.length > 10 ? `... and ${context.filesModified.length - 10} more` : ''}
` : ''}
`;
}

function getLoopRecoveryInstructions(context: RecoveryContext): string {
  const lastTypes = context.lastMessageTypes?.slice(-5).join(' → ') || 'unknown';

  return `
### 🔄 LOOP RECOVERY (previous execution was stuck in a loop)

The previous execution got stuck repeating the same actions. To avoid this:

1. **MAKE VISIBLE PROGRESS EACH TURN** - Every turn, you MUST:
   - Edit a file, OR
   - Run a command that produces output, OR
   - Complete a task step

2. **DON'T READ THE SAME FILES REPEATEDLY** - If you've read a file, use what you learned
3. **DON'T ASK REPEATED QUESTIONS** - Make a decision and proceed
4. **TRACK YOUR PROGRESS** - Before each action, ask: "Is this different from my last action?"
5. **SET CLEAR MILESTONES** - Work toward concrete, verifiable goals

**Previous pattern that caused the loop:** ${lastTypes}

⚠️ If you find yourself wanting to do the same thing twice, STOP and try a different approach.
`;
}

function getHistoryOverflowInstructions(_context: RecoveryContext): string {
  return `
### 📜 CONTEXT OVERFLOW RECOVERY (previous execution had too much history)

The previous execution failed because too much context accumulated. To avoid this:

1. **START FRESH** - Don't try to recall previous conversation history
2. **FOCUS ON THE CURRENT TASK** - The task description contains everything you need
3. **MINIMIZE FILE READS** - Only read files directly related to your current step
4. **DON'T EXPLORE EXTENSIVELY** - You know the codebase structure, work on the task
5. **BE CONCISE** - Short, focused tool calls are better than long explorations

The task will provide all necessary context. Trust it and proceed directly.
`;
}

function getApiErrorInstructions(_context: RecoveryContext): string {
  return `
### 🌐 API ERROR RECOVERY (previous execution had API/connectivity issues)

The previous execution failed due to API errors. These are often transient. For this retry:

1. **PROCEED NORMALLY** - The issue was likely temporary
2. **SAVE WORK FREQUENTLY** - Commit changes to protect against future errors
3. **USE SIMPLER OPERATIONS** - If possible, break complex operations into smaller steps

This retry should work normally. If you encounter errors, report them clearly.
`;
}

function getGitErrorInstructions(_context: RecoveryContext): string {
  return `
### 🌿 GIT ERROR RECOVERY (previous execution had git issues)

The previous execution failed due to git problems. Before proceeding:

1. **CHECK GIT STATUS FIRST** - Run \`git status\` to understand current state
2. **RESOLVE CONFLICTS** - If there are merge conflicts, resolve them first
3. **CLEAN WORKING DIRECTORY** - Commit or stash any uncommitted changes
4. **VERIFY BRANCH** - Make sure you're on the correct branch
5. **PULL LATEST** - If needed, pull latest changes from remote

Start by verifying git state before making new changes.
`;
}

function getGenericRecoveryInstructions(context: RecoveryContext): string {
  return `
### ⚡ RETRY MODE (attempt ${context.retryCount + 1})

This is a retry of a previously failed execution. The failure was unexpected.

1. **START FRESH** - Approach the task with a clean slate
2. **WORK INCREMENTALLY** - Make small, verifiable progress
3. **SAVE FREQUENTLY** - Commit changes to protect against failures
4. **REPORT ISSUES** - If you encounter problems, describe them clearly
`;
}

function getCommonRetryInstructions(context: RecoveryContext): string {
  return `
---

### 📋 RETRY REQUIREMENTS (MUST FOLLOW)

1. **PRODUCE OUTPUT EVERY 3-5 TURNS** - Edit, commit, or complete something tangible
2. **DON'T REPEAT ACTIONS** - If an approach isn't working, try something different
3. **COMMIT PROGRESS** - Use git to save work after each significant change
4. **STAY FOCUSED** - Complete the requested task, don't add extras
5. **BE EFFICIENT** - You are on attempt ${context.retryCount + 1}. Make it count.

Remember: Progress > Perfection. A partial solution is better than no solution.

---
`;
}

/**
 * Check if recovery instructions should be injected
 */
export function shouldInjectRecoveryInstructions(
  failedExecution: { failureType: FailureType; retryCount: number } | null
): boolean {
  if (!failedExecution) {
    return false;
  }

  // Always inject for loop detection (most critical)
  if (failedExecution.failureType === 'loop_detection') {
    return true;
  }

  // Inject for all retries after first failure
  return failedExecution.retryCount > 0;
}
