/**
 * ConflictResolverPhase
 *
 * Specialist phase for resolving Git merge conflicts.
 * Called when Judge rejects code due to merge conflicts (rejectReason: 'conflicts').
 *
 * Flow:
 * 1. Judge rejects with rejectReason: 'conflicts'
 * 2. DevelopersPhase routes to ConflictResolverPhase
 * 3. ConflictResolver analyzes and resolves conflicts
 * 4. Judge RE-EVALUATES after resolution
 * 5. If approved → merge continues
 *    If rejected → back to normal rejection flow
 *
 * Responsibilities:
 * - Detect conflict markers in files
 * - Understand both sides of the conflict
 * - Make intelligent decisions about resolution
 * - Commit resolved files
 * - Push to remote
 */

import {
  BasePhase,
  OrchestrationContext,
  PhaseResult,
} from './Phase';
import { NotificationService } from '../NotificationService';
import { AgentActivityService } from '../AgentActivityService';
import { safeGitExecSync } from '../../utils/safeGitExecution';

// Git timeout for push operations (2 minutes)
const PUSH_TIMEOUT = 120000;
import * as fs from 'fs';
import * as path from 'path';

/**
 * ConflictResolverPhase
 *
 * Specialist agent for resolving Git merge conflicts.
 */
export class ConflictResolverPhase extends BasePhase {
  readonly name = 'ConflictResolver';
  readonly description = 'Resolving Git merge conflicts';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Main phase execution - resolve conflicts
   */
  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const taskId = this.getTaskIdString(context);
    const startTime = Date.now();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔧 [ConflictResolver] Starting conflict resolution`);
    console.log(`${'='.repeat(80)}\n`);

    AgentActivityService.emitMessage(taskId, 'ConflictResolver', '🔧 Starting conflict resolution...');

    // Get context data
    const story = context.getData<any>('story');
    const epic = context.getData<any>('epic');
    const storyBranchName = context.getData<string>('storyBranchName');
    const targetRepository = context.getData<string>('targetRepository');
    const judgeFeedback = context.getData<string>('judgeFeedback');
    const workspacePath = context.workspacePath;
    const sandboxId = context.getData<string>('sandboxId');

    if (!workspacePath || !targetRepository) {
      return {
        success: false,
        error: 'Missing workspacePath or targetRepository',
      };
    }

    const repoPath = path.join(workspacePath, targetRepository);

    console.log(`📋 Context:`);
    console.log(`   Story: ${story?.title || 'unknown'}`);
    console.log(`   Branch: ${storyBranchName || 'unknown'}`);
    console.log(`   Repository: ${targetRepository}`);
    console.log(`   Repo Path: ${repoPath}`);
    if (sandboxId) {
      console.log(`   🐳 Sandbox: ${sandboxId}`);
    }

    try {
      // Step 1: Detect conflicting files
      console.log(`\n🔍 [Step 1/4] Detecting conflicting files...`);
      const conflictFiles = this.detectConflictFiles(repoPath);

      if (conflictFiles.length === 0) {
        console.log(`   ℹ️ No conflict markers found in workspace`);
        console.log(`   Attempting to identify conflicts from git status...`);

        // Try to get conflict status from git
        const gitStatus = this.getGitConflictStatus(repoPath);
        if (gitStatus.length === 0) {
          console.log(`   ✅ No conflicts detected - may have been resolved already`);
          return {
            success: true,
            data: {
              resolvedFiles: [],
              alreadyResolved: true,
            },
          };
        }
        conflictFiles.push(...gitStatus);
      }

      console.log(`   Found ${conflictFiles.length} files with conflicts:`);
      conflictFiles.forEach(f => console.log(`   - ${f}`));

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔧 ConflictResolver found ${conflictFiles.length} conflicting files`
      );

      // Step 2: Build resolution prompt for agent
      console.log(`\n📝 [Step 2/4] Building resolution prompt...`);
      const prompt = this.buildResolutionPrompt(
        repoPath,
        conflictFiles,
        story,
        epic,
        storyBranchName,
        judgeFeedback
      );

      // Step 3: Execute conflict resolution agent
      console.log(`\n🤖 [Step 3/4] Executing ConflictResolver agent...`);
      AgentActivityService.emitMessage(taskId, 'ConflictResolver', `Resolving conflicts in ${conflictFiles.length} files...`);

      const agentResult = await this.executeAgentFn(
        'conflict-resolver',
        prompt,
        repoPath,
        taskId,
        'ConflictResolver',
        undefined, // sessionId
        undefined, // fork
        undefined, // attachments
        sandboxId ? { sandboxId } : undefined,
        undefined, // contextOverride
        undefined, // skipOptimization
        'bypassPermissions'
      );

      const duration = Date.now() - startTime;
      console.log(`   💰 ConflictResolver completed in ${duration}ms, cost: $${agentResult.cost?.toFixed(4) || '?'}`);

      // Step 4: Verify resolution
      console.log(`\n✅ [Step 4/4] Verifying resolution...`);
      const remainingConflicts = this.detectConflictFiles(repoPath);

      if (remainingConflicts.length > 0) {
        console.error(`   ❌ ${remainingConflicts.length} files still have conflicts:`);
        remainingConflicts.forEach(f => console.error(`   - ${f}`));

        AgentActivityService.emitMessage(
          taskId,
          'ConflictResolver',
          `❌ Could not resolve all conflicts (${remainingConflicts.length} remaining)`
        );

        return {
          success: false,
          error: `Could not resolve conflicts in: ${remainingConflicts.join(', ')}`,
          metadata: {
            cost: agentResult.cost || 0,
            input_tokens: agentResult.usage?.input_tokens || 0,
            output_tokens: agentResult.usage?.output_tokens || 0,
          },
        };
      }

      // Verify commit and push
      console.log(`   ✅ All conflicts resolved!`);
      console.log(`   Verifying commit and push...`);

      const commitVerified = this.verifyCommitAndPush(repoPath, storyBranchName || 'unknown');

      if (!commitVerified.success) {
        console.warn(`   ⚠️ Commit/push verification failed: ${commitVerified.error}`);
        // Try to commit and push ourselves
        try {
          safeGitExecSync(`git add -A`, { cwd: repoPath, encoding: 'utf8' });
          safeGitExecSync(
            `git commit -m "fix: Resolve merge conflicts [ConflictResolver]"`,
            { cwd: repoPath, encoding: 'utf8' }
          );
          safeGitExecSync(
            `git push origin ${storyBranchName} --force-with-lease`,
            { cwd: repoPath, encoding: 'utf8', timeout: PUSH_TIMEOUT }
          );
          console.log(`   ✅ Manually committed and pushed resolved files`);
        } catch (pushError: any) {
          console.error(`   ❌ Failed to push: ${pushError.message}`);
          return {
            success: false,
            error: `Conflicts resolved but push failed: ${pushError.message}`,
            metadata: {
              cost: agentResult.cost || 0,
              input_tokens: agentResult.usage?.input_tokens || 0,
              output_tokens: agentResult.usage?.output_tokens || 0,
            },
          };
        }
      }

      AgentActivityService.emitMessage(
        taskId,
        'ConflictResolver',
        `✅ Resolved conflicts in ${conflictFiles.length} files`
      );

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ ConflictResolver successfully resolved ${conflictFiles.length} conflicts`
      );

      return {
        success: true,
        data: {
          resolvedFiles: conflictFiles,
          conflictCount: conflictFiles.length,
        },
        metadata: {
          cost: agentResult.cost || 0,
          input_tokens: agentResult.usage?.input_tokens || 0,
          output_tokens: agentResult.usage?.output_tokens || 0,
        },
      };

    } catch (error: any) {
      console.error(`❌ [ConflictResolver] Failed: ${error.message}`);

      AgentActivityService.emitMessage(
        taskId,
        'ConflictResolver',
        `❌ Failed: ${error.message}`
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Detect files with Git conflict markers
   */
  private detectConflictFiles(repoPath: string): string[] {
    const conflictFiles: string[] = [];

    try {
      // Use grep to find conflict markers
      const grepResult = safeGitExecSync(
        `grep -rn "^<<<<<<< " --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.dart" --include="*.py" --include="*.java" --include="*.kt" . 2>/dev/null || true`,
        { cwd: repoPath, encoding: 'utf8', timeout: 30000 }
      );

      if (grepResult && grepResult.trim()) {
        const lines = grepResult.trim().split('\n');
        const files = new Set<string>();
        for (const line of lines) {
          const match = line.match(/^\.\/([^:]+):/);
          if (match) {
            files.add(match[1]);
          }
        }
        conflictFiles.push(...files);
      }
    } catch (error: any) {
      console.warn(`   ⚠️ Grep for conflicts failed: ${error.message}`);
    }

    return conflictFiles;
  }

  /**
   * Get conflict status from git
   */
  private getGitConflictStatus(repoPath: string): string[] {
    const conflictFiles: string[] = [];

    try {
      const status = safeGitExecSync(
        `git status --porcelain`,
        { cwd: repoPath, encoding: 'utf8' }
      );

      if (status) {
        const lines = status.split('\n');
        for (const line of lines) {
          // UU = both modified (conflict)
          // AA = both added (conflict)
          if (line.startsWith('UU ') || line.startsWith('AA ')) {
            conflictFiles.push(line.substring(3).trim());
          }
        }
      }
    } catch (error: any) {
      console.warn(`   ⚠️ Git status failed: ${error.message}`);
    }

    return conflictFiles;
  }

  /**
   * Build prompt for conflict resolution agent
   */
  private buildResolutionPrompt(
    repoPath: string,
    conflictFiles: string[],
    story: any,
    epic: any,
    storyBranchName: string | undefined,
    judgeFeedback: string | undefined
  ): string {
    // Read content of conflicting files
    const fileContents: string[] = [];
    for (const file of conflictFiles) {
      try {
        const filePath = path.join(repoPath, file);
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          fileContents.push(`### ${file}\n\`\`\`\n${content.substring(0, 5000)}\n\`\`\``);
        }
      } catch (err: any) {
        fileContents.push(`### ${file}\n(Could not read: ${err.message})`);
      }
    }

    return `# 🔧 GIT CONFLICT RESOLUTION TASK

## Context
- **Story**: ${story?.title || 'Unknown'}
- **Story ID**: ${story?.id || 'Unknown'}
- **Epic**: ${epic?.name || 'Unknown'}
- **Branch**: ${storyBranchName || 'Unknown'}
- **Repository Path**: ${repoPath}

## Judge Feedback
${judgeFeedback || 'Merge conflicts detected'}

## Conflicting Files (${conflictFiles.length})
${conflictFiles.map(f => `- ${f}`).join('\n')}

## File Contents with Conflicts
${fileContents.join('\n\n')}

---

## 🔧 CONFLICT RESOLUTION METHODOLOGY

### Step 1: IDENTIFY Conflicting Files
\`\`\`bash
git status  # Shows files marked as "both modified"
\`\`\`

### Step 2: UNDERSTAND Conflict Markers
Each conflict in a file looks like this:
\`\`\`
<<<<<<< HEAD
Code from the TARGET branch (epic branch)
This is what existed before your story changes
=======
Code from the INCOMING branch (story branch)
This is YOUR new feature code
>>>>>>> ${storyBranchName || 'story-branch'}
\`\`\`

### Step 3: RESOLUTION STRATEGY (CRITICAL)
**ALWAYS prefer the STORY changes** because they implement the new feature.

ONLY keep HEAD changes if:
- Story changes would break existing critical functionality
- Story changes conflict with another story already merged
- HEAD has bug fixes that story branch doesn't have

### Step 4: EDIT Each File
For each conflicting file:
1. Read the file using the Read tool
2. Find ALL conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`)
3. Decide which code to keep (usually STORY code)
4. Use Edit tool to replace the conflict block with resolved code
5. Verify NO conflict markers remain

### Step 5: VERIFY Resolution
\`\`\`bash
# Check no conflict markers remain
git diff --check

# Check file is syntactically valid (for Dart/TS/JS)
# dart analyze <file> OR npx tsc --noEmit
\`\`\`

### Step 6: COMMIT and PUSH
\`\`\`bash
git add -A
git commit -m "fix: Resolve merge conflicts [ConflictResolver]"
git push origin ${storyBranchName || 'HEAD'} --force-with-lease
\`\`\`

---

## ⚠️ COMMON MISTAKES TO AVOID

❌ **DON'T** leave any conflict markers in the file
❌ **DON'T** blindly choose one side without understanding
❌ **DON'T** break imports by choosing incompatible code
❌ **DON'T** forget to add/commit ALL resolved files

✅ **DO** read both versions carefully
✅ **DO** understand what each side is trying to do
✅ **DO** test the resolved code compiles
✅ **DO** keep the story feature functional

---

## 📋 OUTPUT FORMAT

After resolving, report:
\`\`\`
🔧 CONFLICT RESOLUTION SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Files Resolved: ${conflictFiles.length}
${conflictFiles.map(f => `  ✓ ${f}`).join('\n')}

Resolution Strategy: Kept STORY changes (new feature code)
Verification: ✓ No conflict markers remain
Commit: fix: Resolve merge conflicts [ConflictResolver]
Push: ✓ Pushed to origin/${storyBranchName || 'story-branch'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
\`\`\`

NOW: Use the Read and Edit tools to resolve each file, then commit and push.
`;
  }

  /**
   * Verify that changes were committed and pushed
   */
  private verifyCommitAndPush(repoPath: string, branchName: string): { success: boolean; error?: string } {
    try {
      // Check if there are uncommitted changes
      const status = safeGitExecSync(
        `git status --porcelain`,
        { cwd: repoPath, encoding: 'utf8' }
      );

      if (status && status.trim()) {
        return { success: false, error: 'Uncommitted changes remain' };
      }

      // Check if local is ahead of remote
      const aheadBehind = safeGitExecSync(
        `git rev-list --left-right --count origin/${branchName}...HEAD 2>/dev/null || echo "0 0"`,
        { cwd: repoPath, encoding: 'utf8' }
      );

      const [_behind, ahead] = aheadBehind.trim().split(/\s+/).map(Number);
      if (ahead > 0) {
        return { success: false, error: `Local is ${ahead} commits ahead - needs push` };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

export default ConflictResolverPhase;
