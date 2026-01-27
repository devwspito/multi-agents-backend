/**
 * MergeStage - Handles merging story branches into epic branches
 *
 * Responsibilities:
 * - Merge story branch to epic branch
 * - Resolve conflicts (regex-based and AI-powered)
 * - Push merged changes to remote
 * - Cleanup story branches after merge
 */

import { safeGitExecSync, fixGitRemoteAuth } from '../../../../utils/safeGitExecution';
import { GIT_TIMEOUTS, AGENT_TIMEOUTS } from '../../constants/Timeouts';
import { unifiedMemoryService } from '../../../UnifiedMemoryService';
import { StoryPipelineContext, MergeStageResult } from '../types';
import { sandboxService } from '../../../SandboxService';
import { eventStore } from '../../../EventStore';

// Dependency files that require reinstall when changed
const DEPENDENCY_FILES: Record<string, { pattern: RegExp; installCmd: string; language: string }> = {
  'pubspec.yaml': { pattern: /pubspec\.yaml$/i, installCmd: 'flutter pub get', language: 'flutter' },
  'pubspec.lock': { pattern: /pubspec\.lock$/i, installCmd: 'flutter pub get', language: 'flutter' },
  'package.json': { pattern: /package\.json$/i, installCmd: 'npm install', language: 'nodejs' },
  'package-lock.json': { pattern: /package-lock\.json$/i, installCmd: 'npm install', language: 'nodejs' },
  'yarn.lock': { pattern: /yarn\.lock$/i, installCmd: 'yarn install', language: 'nodejs' },
  'pnpm-lock.yaml': { pattern: /pnpm-lock\.yaml$/i, installCmd: 'pnpm install', language: 'nodejs' },
  'requirements.txt': { pattern: /requirements\.txt$/i, installCmd: 'pip install -r requirements.txt', language: 'python' },
  'Pipfile.lock': { pattern: /Pipfile\.lock$/i, installCmd: 'pipenv sync', language: 'python' },
  'Cargo.toml': { pattern: /Cargo\.toml$/i, installCmd: 'cargo build', language: 'rust' },
  'go.mod': { pattern: /go\.mod$/i, installCmd: 'go mod download', language: 'go' },
};

export type ExecuteAgentFn = (
  agentType: string,
  prompt: string,
  workspacePath: string,
  taskId: string,
  label: string,
  sessionId?: string,
  fork?: boolean,
  attachments?: any[],
  options?: { maxIterations?: number; timeout?: number; sandboxId?: string } // 🐳 Added sandboxId
) => Promise<{ cost?: number; usage?: any; output?: string }>;

export class MergeStageExecutor {
  constructor(private executeAgentFn?: ExecuteAgentFn) {}

  /**
   * Execute the merge stage - merge story branch into epic branch
   */
  async execute(
    pipelineCtx: StoryPipelineContext,
    commitSHA: string
  ): Promise<MergeStageResult> {
    const {
      task, story, epic, repositories,
      effectiveWorkspacePath, taskId, normalizedEpicId, normalizedStoryId,
      sandboxId, // 🐳 Explicit sandbox ID for Docker execution
    } = pipelineCtx;

    console.log(`\n🔀 [MERGE STAGE] Merging story to epic branch: ${story.title}`);

    try {
      // Get updated story from event store
      const { eventStore } = await import('../../../EventStore');
      const updatedState = await eventStore.getCurrentState(task.id as any);
      const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

      // Merge to epic branch
      await this.mergeStoryToEpic(updatedStory, epic, effectiveWorkspacePath, repositories, taskId, sandboxId);

      // Checkpoint: Mark as merged_to_epic
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'merged_to_epic', {
        commitHash: commitSHA,
      });
      console.log(`📍 [CHECKPOINT] Story progress: merged_to_epic`);

      // 🔥 AUTO-REBUILD: Trigger rebuild for frameworks using static builds (Flutter, etc.)
      // This ensures LivePreview shows the latest code after merge
      await this.triggerAutoRebuild(taskId, sandboxId, effectiveWorkspacePath, repositories, epic);
      console.log(`📍 [AUTO-REBUILD] Triggered rebuild for LivePreview`);

      // Cleanup story branch
      if (effectiveWorkspacePath && repositories.length > 0 && epic.targetRepository) {
        await this.cleanupStoryBranch(effectiveWorkspacePath, repositories, epic, updatedStory);
      }

      // Get conflict resolution costs from story
      const storyForCosts = updatedStory || story;
      const conflictResolutionCost = (storyForCosts as any).conflictResolutionCost || 0;
      const conflictResolutionUsage = (storyForCosts as any).conflictResolutionUsage || { input_tokens: 0, output_tokens: 0 };

      console.log(`✅ [MERGE STAGE] Complete`);

      return {
        success: true,
        conflictResolutionCost,
        conflictResolutionUsage,
      };

    } catch (error: any) {
      console.error(`❌ [MERGE STAGE] Failed: ${error.message}`);
      return {
        success: false,
        conflictResolutionCost: 0,
        conflictResolutionUsage: { input_tokens: 0, output_tokens: 0 },
        error: error.message,
      };
    }
  }

  /**
   * Cleanup local and remote story branches after merge
   */
  private async cleanupStoryBranch(
    workspacePath: string,
    repositories: any[],
    epic: any,
    story: any
  ): Promise<void> {
    try {
      const targetRepo = repositories.find((r: any) =>
        r.name === epic.targetRepository ||
        r.full_name === epic.targetRepository ||
        r.githubRepoName === epic.targetRepository
      );

      if (targetRepo && story?.branchName) {
        const repoPath = `${workspacePath}/${targetRepo.name || targetRepo.full_name}`;
        const storyBranch = story.branchName;

        // Delete local branch
        try {
          safeGitExecSync(`cd "${repoPath}" && git branch -D ${storyBranch}`, { encoding: 'utf8' });
          console.log(`🧹 Cleaned up LOCAL story branch: ${storyBranch}`);
        } catch { /* Branch might not exist */ }

        // Delete remote branch
        try {
          safeGitExecSync(`cd "${repoPath}" && git push origin --delete ${storyBranch}`, {
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.CLONE
          });
          console.log(`🧹 Cleaned up REMOTE story branch: ${storyBranch}`);
        } catch { /* Branch might not exist on remote */ }
      }
    } catch (cleanupErr: any) {
      console.warn(`⚠️ Branch cleanup failed: ${cleanupErr.message}`);
    }
  }

  /**
   * Merge approved story branch into epic branch
   */
  async mergeStoryToEpic(
    story: any,
    epic: any,
    workspacePath: string | null,
    repositories: any[],
    taskId: string,
    sandboxId?: string // 🐳 Explicit sandbox ID for Docker execution
  ): Promise<void> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔀 [Merge] STARTING STORY TO EPIC MERGE`);
    console.log(`${'='.repeat(80)}`);
    console.log(`   Story: ${story.title || story.id}`);
    console.log(`   Story Branch: ${story.branchName}`);
    console.log(`   Epic: ${epic.title || epic.id}`);
    console.log(`   Epic Branch: ${epic.branchName || `epic/${epic.id}`}`);
    console.log(`${'='.repeat(80)}\n`);

    if (!workspacePath) {
      console.error(`❌ [Merge] No workspace path available`);
      throw new Error('Workspace path required for merge');
    }

    if (!story.branchName) {
      console.error(`❌ [Merge] Story has no branch name - cannot merge`);
      throw new Error(`Story ${story.id} has no branch`);
    }

    try {
      const { NotificationService } = await import('../../../NotificationService');

      if (!epic.targetRepository) {
        throw new Error(`Epic ${epic.id} has no targetRepository - cannot merge to main`);
      }

      const targetRepoObj = repositories.find(r =>
        r.name === epic.targetRepository ||
        r.full_name === epic.targetRepository ||
        r.githubRepoName === epic.targetRepository
      );

      if (!targetRepoObj) {
        throw new Error(`Repository ${epic.targetRepository} not found in context.repositories`);
      }

      const repoPath = `${workspacePath}/${targetRepoObj.name || targetRepoObj.full_name}`;
      const epicBranch = epic.branchName;

      if (!epicBranch) {
        throw new Error(`Epic ${epic.id} has no branchName - cannot merge`);
      }

      console.log(`📂 [Merge] Repository: ${epic.targetRepository}`);
      console.log(`📂 [Merge] Workspace Path: ${workspacePath}`);
      console.log(`📂 [Merge] Repo Path: ${repoPath}`);
      console.log(`📂 [Merge] Epic Branch: ${epicBranch}`);

      // Step 1: Checkout epic branch
      console.log(`\n[STEP 1/4] Checking out epic branch: ${epicBranch}...`);
      const checkoutOutput = safeGitExecSync(`cd "${repoPath}" && git checkout ${epicBranch}`, { encoding: 'utf8' });
      console.log(`✅ [Merge] Checked out ${epicBranch}`);
      console.log(`   Git output: ${checkoutOutput.substring(0, 100)}`);

      // Step 2: Pull latest changes
      console.log(`\n[STEP 2/5] Pulling latest changes from remote...`);
      try {
        const pullOutput = safeGitExecSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, {
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.FETCH,
        });
        console.log(`✅ [Merge] Pulled latest changes from ${epicBranch}`);
        console.log(`   Git output: ${pullOutput.substring(0, 100)}`);
      } catch (pullError: any) {
        console.warn(`⚠️  [Merge] Pull failed: ${pullError.message}`);
      }

      // Step 2.5: Handle untracked files that might block merge
      // This is critical for Flutter/other generators that create files in sandbox
      console.log(`\n[STEP 2.5/5] Checking for untracked files that might block merge...`);
      try {
        const untrackedOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, { encoding: 'utf8' });
        const untrackedFiles = untrackedOutput
          .split('\n')
          .filter((line: string) => line.startsWith('??'))
          .map((line: string) => line.substring(3).trim());

        if (untrackedFiles.length > 0) {
          console.log(`   Found ${untrackedFiles.length} untracked files (e.g., from flutter create)`);
          console.log(`   Files: ${untrackedFiles.slice(0, 5).join(', ')}${untrackedFiles.length > 5 ? '...' : ''}`);

          // Add all untracked files and commit them
          console.log(`   Adding and committing untracked files to prevent merge conflicts...`);
          safeGitExecSync(`cd "${repoPath}" && git add -A`, { encoding: 'utf8' });

          // Check if there's anything to commit
          const statusAfterAdd = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, { encoding: 'utf8' });
          if (statusAfterAdd.trim().length > 0) {
            safeGitExecSync(
              `cd "${repoPath}" && git commit -m "chore: Add generated files before merge (flutter create, etc.)"`,
              { encoding: 'utf8' }
            );
            console.log(`   ✅ Committed ${untrackedFiles.length} generated files`);
          } else {
            console.log(`   No changes to commit after staging`);
          }
        } else {
          console.log(`   No untracked files found, merge should proceed cleanly`);
        }
      } catch (untrackedError: any) {
        console.warn(`⚠️  [Merge] Error handling untracked files: ${untrackedError.message}`);
        // Continue anyway - the merge will fail if there are real conflicts
      }

      // Step 3: Merge story branch
      console.log(`\n[STEP 3/4] Merging story branch into epic...`);
      console.log(`   Executing: git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`);
      const mergeOutput = safeGitExecSync(
        `cd "${repoPath}" && git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`,
        { encoding: 'utf8' }
      );
      console.log(`✅ [Merge] MERGE SUCCESSFUL: ${story.branchName} → ${epicBranch}`);
      console.log(`   Git merge output:\n${mergeOutput}`);

      // Step 4: Push epic branch
      console.log(`\n[STEP 4/4] Pushing epic branch to remote...`);
      console.log(`   Executing: git push origin ${epicBranch}`);

      // Fix git remote authentication
      console.log(`🔧 [Merge] Fixing git remote authentication...`);
      const authFixed = fixGitRemoteAuth(repoPath);
      if (authFixed) {
        console.log(`✅ [Merge] Git remote URL fixed to use credential helper`);
      }

      // Push with retries
      await this.pushWithRetry(repoPath, epicBranch);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔀 Merged story ${story.title} → ${epicBranch}`
      );

      // Update story status
      story.mergedToEpic = true;
      story.mergedAt = new Date();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ [Merge] STORY MERGE COMPLETED SUCCESSFULLY`);
      console.log(`${'='.repeat(80)}\n`);

    } catch (error: any) {
      console.error(`❌ [Merge] Failed to merge story ${story.id}: ${error.message}`);

      // Check if it's a merge conflict
      if (error.message.includes('CONFLICT') || error.message.includes('Recorded preimage')) {
        await this.handleMergeConflict(error, story, epic, workspacePath, repositories, taskId, sandboxId);
        return;
      }

      throw error;
    }
  }

  /**
   * Push to remote with retry logic
   */
  private async pushWithRetry(repoPath: string, epicBranch: string, maxRetries = 3): Promise<void> {
    let pushSucceeded = false;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxRetries && !pushSucceeded; attempt++) {
      try {
        console.log(`📤 [Merge] Push attempt ${attempt}/${maxRetries}...`);
        const pushOutput = safeGitExecSync(
          `git push origin ${epicBranch}`,
          {
            cwd: repoPath,
            encoding: 'utf8',
            timeout: GIT_TIMEOUTS.FETCH
          }
        );
        console.log(`✅ [Merge] PUSH SUCCESSFUL: ${epicBranch} pushed to remote`);
        console.log(`   Git push output:\n${pushOutput}`);
        pushSucceeded = true;

        // Sync local with remote after push
        try {
          safeGitExecSync(`git pull origin ${epicBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
          console.log(`✅ [Merge] Local synced with remote`);
        } catch (_pullErr) {
          console.log(`   ℹ️ Pull skipped (already up to date)`);
        }
      } catch (pushError: any) {
        lastError = pushError;
        console.error(`❌ [Merge] Push attempt ${attempt} failed: ${pushError.message}`);

        if (attempt < maxRetries) {
          const delay = 2000 * attempt;
          console.log(`⏳ [Merge] Waiting ${delay/1000}s before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!pushSucceeded) {
      console.error(`❌ [Merge] CRITICAL: All ${maxRetries} push attempts failed!`);
      throw new Error(`Failed to push epic branch ${epicBranch} to remote after ${maxRetries} attempts: ${lastError?.message}`);
    }
  }

  /**
   * Handle merge conflict - try regex resolution, then AI resolution
   */
  private async handleMergeConflict(
    error: any,
    story: any,
    epic: any,
    workspacePath: string | null,
    repositories: any[],
    taskId: string,
    sandboxId?: string // 🐳 Explicit sandbox ID for Docker execution
  ): Promise<void> {
    console.error(`🔥 [Merge] MERGE CONFLICT detected!`);

    if (!epic.targetRepository) {
      throw new Error(`Epic ${epic.id} has no targetRepository - cannot resolve conflict`);
    }

    const targetRepoObj = repositories.find(r =>
      r.name === epic.targetRepository ||
      r.full_name === epic.targetRepository ||
      r.githubRepoName === epic.targetRepository
    );

    if (!targetRepoObj) {
      throw new Error(`Repository ${epic.targetRepository} not found`);
    }

    const repoPath = `${workspacePath}/${targetRepoObj.name || targetRepoObj.full_name}`;

    // Get conflicted files
    let conflictedFiles: string[] = [];
    try {
      const diffOutput = safeGitExecSync(`cd "${repoPath}" && git diff --name-only --diff-filter=U`, {
        encoding: 'utf8',
      });
      conflictedFiles = diffOutput.trim().split('\n').filter(f => f);
      console.log(`   📄 Conflicted files: ${conflictedFiles.join(', ')}`);
    } catch (diffError) {
      console.error(`   ⚠️ Could not get conflicted files: ${diffError}`);
    }

    if (conflictedFiles.length > 0) {
      // Try regex resolution first
      const regexResolved = await this.resolveConflictsWithRegex(repoPath, conflictedFiles, story);

      if (regexResolved) {
        // 🔄 Reinstall dependencies if pubspec.yaml/package.json was in conflicts
        await this.reinstallDependenciesIfNeeded(conflictedFiles, sandboxId, repoPath);
        return;
      }

      // Try AI resolution
      if (this.executeAgentFn) {
        const aiResolved = await this.resolveConflictsWithAI(taskId, story, epic, repoPath, conflictedFiles, sandboxId);

        if (aiResolved.success) {
          console.log(`   ✅ AI resolved all conflicts!`);

          // Stage and commit
          safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
          safeGitExecSync(
            `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (AI-resolved conflicts)"`,
            { encoding: 'utf8' }
          );

          // 🔄 Reinstall dependencies if pubspec.yaml/package.json was in conflicts
          await this.reinstallDependenciesIfNeeded(conflictedFiles, sandboxId, repoPath);

          story.status = 'completed';
          story.mergedToEpic = true;
          story.mergeConflict = false;
          story.mergeConflictAutoResolved = true;
          story.mergeConflictResolvedByAI = true;
          story.conflictResolutionCost = aiResolved.cost || 0;
          story.conflictResolutionUsage = aiResolved.usage || {};

          return;
        }
      }
    }

    // Abort merge and mark for manual resolution
    console.log(`   📋 All automatic resolution methods failed - marking for manual resolution...`);
    try {
      safeGitExecSync(`cd "${repoPath}" && git merge --abort`, { encoding: 'utf8' });
    } catch (abortError) {
      console.error(`   ⚠️ Could not abort merge: ${abortError}`);
    }

    story.mergeConflict = true;
    story.mergeConflictDetails = error.message;
    story.mergeConflictFiles = conflictedFiles;
  }

  /**
   * Try to resolve conflicts using regex-based approach
   */
  private async resolveConflictsWithRegex(
    repoPath: string,
    conflictedFiles: string[],
    story: any
  ): Promise<boolean> {
    console.log(`   🤖 Attempting simple conflict resolution...`);
    const fs = require('fs');

    let allResolved = true;
    for (const file of conflictedFiles) {
      try {
        const filePath = `${repoPath}/${file}`;
        const fileContent = fs.readFileSync(filePath, 'utf8');

        if (fileContent.includes('<<<<<<<') && fileContent.includes('>>>>>>>')) {
          let resolved = fileContent;

          const conflictPattern = /<<<<<<< HEAD\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> [^\n]+/g;

          resolved = resolved.replace(conflictPattern, (_match: string, head: string, incoming: string) => {
            const headLines = head.split('\n').filter((l: string) => l.trim());
            const incomingLines = incoming.split('\n').filter((l: string) => l.trim());

            const combined = [...headLines];
            for (const line of incomingLines) {
              if (!combined.includes(line)) {
                combined.push(line);
              }
            }
            return combined.join('\n');
          });

          if (!resolved.includes('<<<<<<<') && !resolved.includes('>>>>>>>')) {
            fs.writeFileSync(filePath, resolved, 'utf8');
            console.log(`   ✅ Resolved: ${file}`);
          } else {
            console.log(`   ❌ Could not fully resolve: ${file}`);
            allResolved = false;
          }
        }
      } catch (fileError: any) {
        console.error(`   ❌ Error resolving ${file}: ${fileError.message}`);
        allResolved = false;
      }
    }

    if (allResolved) {
      console.log(`   ✅ All conflicts resolved automatically!`);

      safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
      safeGitExecSync(
        `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (auto-resolved conflicts)"`,
        { encoding: 'utf8' }
      );

      story.status = 'completed';
      story.mergedToEpic = true;
      story.mergeConflict = false;
      story.mergeConflictAutoResolved = true;

      return true;
    }

    return false;
  }

  /**
   * Resolve merge conflicts using AI agent
   */
  async resolveConflictsWithAI(
    taskId: string,
    story: any,
    epic: any,
    repoPath: string,
    conflictedFiles: string[],
    sandboxId?: string // 🐳 Explicit sandbox ID for Docker execution
  ): Promise<{ success: boolean; cost?: number; usage?: any; error?: string }> {
    console.log(`\n🤖 [ConflictResolver] Starting AI-powered conflict resolution`);

    if (!this.executeAgentFn) {
      return { success: false, error: 'executeAgentFn not available' };
    }

    const fs = require('fs');
    const conflictDetails: string[] = [];

    for (const file of conflictedFiles) {
      try {
        const filePath = `${repoPath}/${file}`;
        const content = fs.readFileSync(filePath, 'utf8');
        conflictDetails.push(`\n### File: ${file}\n\`\`\`\n${content}\n\`\`\``);
      } catch (readError: any) {
        conflictDetails.push(`\n### File: ${file}\nError reading: ${readError.message}`);
      }
    }

    const prompt = `# Git Merge Conflict Resolution Required

## Context
- **Story**: ${story.title}
- **Story Branch**: ${story.branchName}
- **Epic**: ${epic.title || epic.id}
- **Epic Branch**: ${epic.branchName}
- **Repository Path**: ${repoPath}

## Conflicted Files (${conflictedFiles.length})
${conflictedFiles.map(f => `- ${f}`).join('\n')}

## Current File Contents (with conflict markers)
${conflictDetails.join('\n')}

## Your Task
1. Read each conflicted file carefully
2. Understand what each side (HEAD vs incoming) is trying to do
3. Merge the changes intelligently - keep BOTH sides' functionality when possible
4. Use Edit tool to remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)
5. Ensure the merged code compiles and makes sense

## Important Rules
- KEEP functionality from BOTH sides when possible
- For imports: combine all imports
- For functions: keep both if they have different names, merge if same name
- For types/interfaces: combine fields from both versions
- NEVER leave conflict markers in the file

## Output
After resolving ALL conflicts, output:
✅ CONFLICT_RESOLVED

If you cannot resolve a conflict, output:
❌ CONFLICT_UNRESOLVABLE: <reason>`;

    try {
      console.log(`   📝 Calling conflict-resolver agent...`);

      const result = await this.executeAgentFn(
        'conflict-resolver',
        prompt,
        repoPath,
        taskId,
        'ConflictResolver',
        undefined,
        undefined,
        undefined,
        {
          maxIterations: 10,
          timeout: AGENT_TIMEOUTS.DEFAULT,
          sandboxId, // 🐳 Explicit sandbox ID for Docker execution
        }
      );

      console.log(`   ✅ Agent completed`);
      console.log(`   💰 Cost: $${result.cost?.toFixed(4) || 0}`);

      const output = result.output || '';
      const allResolved = this.verifyNoConflictMarkers(repoPath, conflictedFiles, fs);

      if (output.includes('CONFLICT_RESOLVED') || output.includes('✅') || allResolved) {
        if (allResolved) {
          return { success: true, cost: result.cost, usage: result.usage };
        }
        return { success: false, cost: result.cost, usage: result.usage, error: 'Conflict markers remain' };
      }

      const reason = output.match(/CONFLICT_UNRESOLVABLE:\s*(.+)/)?.[1] || 'Unknown reason';
      return { success: false, cost: result.cost, usage: result.usage, error: reason };

    } catch (agentError: any) {
      console.error(`   ❌ Agent error: ${agentError.message}`);
      return { success: false, error: agentError.message };
    }
  }

  /**
   * Verify no conflict markers remain in files
   */
  private verifyNoConflictMarkers(repoPath: string, files: string[], fs: any): boolean {
    for (const file of files) {
      try {
        const content = fs.readFileSync(`${repoPath}/${file}`, 'utf8');
        if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
          return false;
        }
      } catch {
        // File might have been deleted/moved
      }
    }
    return true;
  }

  /**
   * 🔥 AUTO-REBUILD: Automatically rebuild after merge for frameworks using static builds
   *
   * This is AGNOSTIC - it reads rebuildCmd from EventStore's environmentConfig,
   * which was set by LanguageDetectionService based on LLM analysis.
   *
   * For frameworks with HMR (hot module replacement), rebuildCmd will be "echo 'HMR handles rebuild'"
   * which we skip. For static builds (Flutter Web), rebuildCmd will be "flutter build web".
   *
   * @param taskId - Task ID for notifications
   * @param sandboxId - Docker sandbox ID to run rebuild command
   * @param workspacePath - Local workspace path (not used, but kept for API consistency)
   * @param repositories - List of repositories
   * @param epic - Epic being merged into
   */
  private async triggerAutoRebuild(
    taskId: string,
    _sandboxId: string | undefined,
    _workspacePath: string | null,
    repositories: any[],
    epic: any
  ): Promise<void> {
    // Check if sandbox is running using SandboxService (which uses taskId for lookup)
    const sandbox = sandboxService.getSandbox(taskId);
    if (!sandbox) {
      console.log(`   ⚠️ [AutoRebuild] No sandbox running for task ${taskId} - skipping auto-rebuild`);
      return;
    }

    const { NotificationService } = await import('../../../NotificationService');

    // Find target repo name
    const targetRepoObj = repositories.find(r =>
      r.name === epic.targetRepository ||
      r.full_name === epic.targetRepository ||
      r.githubRepoName === epic.targetRepository
    );

    if (!targetRepoObj) {
      console.log(`   ⚠️ [AutoRebuild] Could not find target repo - skipping`);
      return;
    }

    const repoName = targetRepoObj.name || targetRepoObj.full_name;

    // 🔥 AGNOSTIC: Get rebuildCmd from EventStore's environmentConfig
    const state = await eventStore.getCurrentState(taskId as any);
    const envConfig = state.environmentConfig || {};
    const repoConfig = envConfig[repoName];

    if (!repoConfig) {
      console.log(`   ⚠️ [AutoRebuild] No environmentConfig for repo "${repoName}" - skipping`);
      return;
    }

    const rebuildCmd = repoConfig.rebuildCmd;
    const framework = repoConfig.framework || repoConfig.language || 'unknown';

    // Skip if no rebuildCmd or if it's just an echo (HMR handles rebuild)
    if (!rebuildCmd || rebuildCmd.startsWith("echo ")) {
      console.log(`   ℹ️ [AutoRebuild] Repo "${repoName}" uses HMR or has no rebuildCmd - skipping`);
      return;
    }

    console.log(`\n🔨 [AutoRebuild] Detected ${framework} project - triggering rebuild...`);
    console.log(`   Command: ${rebuildCmd}`);

    // Notify frontend that rebuild is starting
    NotificationService.emitNotification(taskId, 'rebuild_started', {
      framework,
      message: `Rebuilding ${framework} after merge...`,
    });

    try {
      const startTime = Date.now();

      // Execute rebuild command in sandbox (sandboxService.exec uses taskId for lookup)
      const result = await sandboxService.exec(taskId, rebuildCmd, {
        cwd: '/workspace',
        timeout: 300000, // 5 minutes for builds
      });

      const duration = Math.round((Date.now() - startTime) / 1000);

      if (result.exitCode === 0) {
        console.log(`   ✅ [AutoRebuild] ${framework} rebuild completed in ${duration}s`);

        // Notify frontend to refresh iframe
        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: true,
          duration,
          message: `${framework} rebuild complete! Refreshing preview...`,
        });

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 [AutoRebuild] ${framework} rebuilt after merge - preview updated`
        );
      } else {
        console.warn(`   ⚠️ [AutoRebuild] ${framework} rebuild failed (exit ${result.exitCode})`);
        console.warn(`      stderr: ${result.stderr?.substring(0, 300)}`);

        NotificationService.emitNotification(taskId, 'rebuild_complete', {
          framework,
          success: false,
          error: result.stderr?.substring(0, 200) || 'Build failed',
          message: `${framework} rebuild failed - manual refresh may be needed`,
        });
      }
    } catch (rebuildError: any) {
      console.error(`   ❌ [AutoRebuild] Error: ${rebuildError.message}`);

      NotificationService.emitNotification(taskId, 'rebuild_complete', {
        framework,
        success: false,
        error: rebuildError.message,
      });
    }
  }

  /**
   * 🔄 Reinstall dependencies in sandbox if dependency files were modified
   *
   * This handles the gap where conflict resolution changes pubspec.yaml/package.json
   * but the sandbox still has old dependencies installed.
   *
   * The HOST and SANDBOX share the same filesystem via volume mount,
   * so code changes are visible immediately. But dependency changes
   * (pubspec.yaml, package.json) require running install commands.
   */
  private async reinstallDependenciesIfNeeded(
    conflictedFiles: string[],
    sandboxId: string | undefined,
    _repoPath: string // Kept for future logging, sandbox uses /workspace
  ): Promise<void> {
    if (!sandboxId) {
      console.log(`   ⚠️ [Merge] No sandboxId - skipping dependency reinstall`);
      return;
    }

    // Find which dependency files were modified
    const modifiedDeps: Set<string> = new Set();
    for (const file of conflictedFiles) {
      for (const [depName, config] of Object.entries(DEPENDENCY_FILES)) {
        if (config.pattern.test(file)) {
          modifiedDeps.add(depName);
        }
      }
    }

    if (modifiedDeps.size === 0) {
      console.log(`   ℹ️ [Merge] No dependency files in conflicts - skip reinstall`);
      return;
    }

    console.log(`\n🔄 [Merge] Dependency files modified: ${Array.from(modifiedDeps).join(', ')}`);

    // Determine which install commands to run (dedupe by language)
    const commandsByLanguage: Map<string, string> = new Map();
    Array.from(modifiedDeps).forEach((depName) => {
      const config = DEPENDENCY_FILES[depName];
      if (config && !commandsByLanguage.has(config.language)) {
        commandsByLanguage.set(config.language, config.installCmd);
      }
    });

    // Execute install commands in sandbox
    for (const [language, installCmd] of Array.from(commandsByLanguage.entries())) {
      console.log(`   📦 [Merge] Reinstalling ${language} dependencies: ${installCmd}`);

      try {
        const result = await sandboxService.exec(sandboxId, installCmd, {
          cwd: '/workspace',
          timeout: 120000, // 2 minutes for install
        });

        if (result.exitCode === 0) {
          console.log(`   ✅ [Merge] ${language} dependencies reinstalled successfully`);
        } else {
          console.warn(`   ⚠️ [Merge] ${language} install returned exit code ${result.exitCode}`);
          console.warn(`      stdout: ${result.stdout?.substring(0, 200)}`);
          console.warn(`      stderr: ${result.stderr?.substring(0, 200)}`);
        }
      } catch (installError: any) {
        console.error(`   ❌ [Merge] Failed to reinstall ${language} deps: ${installError.message}`);
        // Don't throw - dependency reinstall failure shouldn't block merge
      }
    }
  }
}
