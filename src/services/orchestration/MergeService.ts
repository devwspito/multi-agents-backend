/**
 * Merge Service
 *
 * Handles merging story branches into epic branches.
 * Includes conflict resolution with AI assistance.
 */

import { safeGitExecSync, fixGitRemoteAuth } from '../../utils/safeGitExecution';
import { GIT_TIMEOUTS, AGENT_TIMEOUTS } from './constants/Timeouts';
import { GitStatusParser } from '../../utils/GitStatusParser';
import { RetryService } from './RetryService';

export class MergeService {
  constructor(private executeAgentFn?: Function) {}

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
    console.log(`[Merge] ${story.branchName} → ${epic.branchName || `epic/${epic.id}`}`);

    if (!workspacePath) {
      throw new Error('Workspace path required for merge');
    }

    if (!story.branchName) {
      throw new Error(`Story ${story.id} has no branch`);
    }

    try {
      const { NotificationService } = await import('../NotificationService');

      // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
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
      // 🔥 CRITICAL: Use the unique branch name from epic, NOT a generic one
      const epicBranch = epic.branchName;

      if (!epicBranch) {
        throw new Error(`Epic ${epic.id} has no branchName - cannot merge`);
      }

      // 1. Checkout epic branch
      safeGitExecSync(`cd "${repoPath}" && git checkout ${epicBranch}`, { encoding: 'utf8' });

      // 2. Pull latest changes
      try {
        safeGitExecSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, {
          encoding: 'utf8',
          timeout: GIT_TIMEOUTS.FETCH,
        });
      } catch (pullError: any) {
        console.warn(`[Merge] Pull failed: ${pullError.message}`);
      }

      // 2.5. Handle untracked files
      try {
        const untrackedOutput = safeGitExecSync(`cd "${repoPath}" && git status --porcelain`, { encoding: 'utf8' });
        const untrackedFiles = GitStatusParser.getUntracked(untrackedOutput);

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

      // 3. Merge story branch with timeout protection
      console.log(`\n[STEP 3/4] Merging story branch into epic...`);
      console.log(`   Executing: git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`);
      const mergeOutput = safeGitExecSync(
        `cd "${repoPath}" && git merge --no-ff ${story.branchName} -m "Merge story: ${story.title}"`,
        { encoding: 'utf8' }
      );
      console.log(`✅ [Merge] MERGE SUCCESSFUL: ${story.branchName} → ${epicBranch}`);
      console.log(`   Git merge output:\n${mergeOutput}`);

      // 4. Push epic branch WITH TIMEOUT
      console.log(`\n[STEP 4/4] Pushing epic branch to remote...`);
      console.log(`   Executing: git push origin ${epicBranch}`);

      // 🔥 CRITICAL FIX: Remove token-based auth from remote URL before pushing
      // The remote may have an old/expired token that causes authentication failures
      console.log(`🔧 [Merge] Fixing git remote authentication...`);
      const authFixed = fixGitRemoteAuth(repoPath);
      if (authFixed) {
        console.log(`✅ [Merge] Git remote URL fixed to use credential helper`);
      } else {
        console.log(`ℹ️  [Merge] Git remote URL already clean (no token embedded)`);
      }

      // Verify current remote URL
      try {
        const currentRemote = safeGitExecSync('git remote get-url origin', { cwd: repoPath, encoding: 'utf8' });
        console.log(`📋 [Merge] Current remote URL: ${currentRemote.replace(/\/\/.*@/, '//*****@')}`);
      } catch (e) {
        console.warn(`⚠️  [Merge] Could not get current remote URL`);
      }

      // 🔥 CENTRALIZED: Uses RetryService for consistent retry logic
      const maxRetries = 3;
      try {
        await RetryService.executeWithRetry(
          async () => {
            const pushOutput = safeGitExecSync(
              `git push origin ${epicBranch}`,
              {
                cwd: repoPath,
                encoding: 'utf8',
                timeout: GIT_TIMEOUTS.FETCH // 90 seconds (network operation)
              }
            );
            console.log(`✅ [Merge] PUSH SUCCESSFUL: ${epicBranch} pushed to remote`);
            console.log(`   Git push output:\n${pushOutput}`);
            // Sync local with remote after push
            try {
              safeGitExecSync(`git pull origin ${epicBranch} --ff-only`, { cwd: repoPath, encoding: 'utf8', timeout: GIT_TIMEOUTS.CHECKOUT });
              console.log(`✅ [Merge] Local synced with remote`);
            } catch (_pullErr) {
              console.log(`   ℹ️ Pull skipped (already up to date)`);
            }
          },
          {
            maxRetries,
            initialDelayMs: 2000,
            backoffMultiplier: 2,
            onRetry: (attempt, error, delayMs) => {
              console.log(`📤 [Merge] Push retry ${attempt}/${maxRetries} after ${delayMs}ms: ${error.message}`);
            },
          }
        );
      } catch (lastError: any) {
        console.error(`❌ [Merge] CRITICAL: All ${maxRetries} push attempts failed!`);
        console.error(`   Epic branch: ${epicBranch}`);
        console.error(`   Repository: ${repoPath}`);
        console.error(`   Last error: ${lastError?.message}`);
        console.error(`   Epic branch has been merged LOCALLY but NOT pushed to remote`);
        console.error(`   This means the code is LOST if we continue`);
        console.error(`\n   🔧 Troubleshooting:`);
        console.error(`   1. Check GitHub authentication: gh auth status`);
        console.error(`   2. Check git credentials: git config --list | grep credential`);
        console.error(`   3. Manual push: cd "${repoPath}" && git push origin ${epicBranch}`);

        // 🔥 CRITICAL: DO NOT continue if push fails
        throw new Error(`Failed to push epic branch ${epicBranch} to remote after ${maxRetries} attempts: ${lastError?.message}`);
      }

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🔀 Merged story ${story.title} → ${epicBranch}`
      );

      // 5. Update story status
      story.mergedToEpic = true;
      story.mergedAt = new Date();

      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ [Merge] STORY MERGE COMPLETED SUCCESSFULLY`);
      console.log(`   Story: ${story.title || story.id}`);
      console.log(`   Story Branch: ${story.branchName}`);
      console.log(`   Epic Branch: ${epicBranch}`);
      console.log(`   Merged to Epic: ${story.mergedToEpic}`);
      console.log(`   Merged At: ${story.mergedAt}`);
      console.log(`${'='.repeat(80)}\n`);
    } catch (error: any) {
      console.error(`❌ [Merge] Failed to merge story ${story.id}: ${error.message}`);

      // Check if it's a merge conflict
      if (error.message.includes('CONFLICT') || error.message.includes('Recorded preimage')) {
        console.error(`🔥 [Merge] MERGE CONFLICT detected!`);
        console.error(`   Story: ${story.title}`);
        console.error(`   Branch: ${story.branchName}`);
        console.error(`   Epic: epic/${epic.id}`);

        // 🔥 ATTEMPT TO RESOLVE CONFLICT AUTOMATICALLY
        console.log(`\n🤖 [Merge] Attempting automatic conflict resolution...`);

        // 🔥 CRITICAL: epic MUST have targetRepository (no fallback)
        if (!epic.targetRepository) {
          throw new Error(`Epic ${epic.id} has no targetRepository - cannot resolve conflict`);
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

        // Get list of conflicted files
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
          try {
            // Try simple auto-resolution strategies
            console.log(`   🤖 Attempting simple conflict resolution...`);

            let allResolved = true;
            for (const file of conflictedFiles) {
              try {
                // Read the conflicted file
                const fileContent = safeGitExecSync(`cd "${repoPath}" && cat "${file}"`, {
                  encoding: 'utf8',
                });

                // Check if conflict markers exist
                if (fileContent.includes('<<<<<<<') && fileContent.includes('>>>>>>>')) {
                  // Try to resolve by keeping both changes (for additive conflicts)
                  // This works for imports, new functions, etc.
                  let resolved = fileContent;

                  // Simple resolution: remove conflict markers and keep both versions
                  // This is a basic strategy that works for additive changes
                  const conflictPattern = /<<<<<<< HEAD\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> [^\n]+/g;

                  resolved = resolved.replace(conflictPattern, (_match, head, incoming) => {
                    // Keep both versions (head first, then incoming)
                    // Remove exact duplicates
                    const headLines = head.split('\n').filter((l: string) => l.trim());
                    const incomingLines = incoming.split('\n').filter((l: string) => l.trim());

                    // Combine unique lines
                    const combined = [...headLines];
                    for (const line of incomingLines) {
                      if (!combined.includes(line)) {
                        combined.push(line);
                      }
                    }
                    return combined.join('\n');
                  });

                  // Check if all conflicts were resolved
                  if (!resolved.includes('<<<<<<<') && !resolved.includes('>>>>>>>')) {
                    // Write resolved file
                    const fs = require('fs');
                    fs.writeFileSync(`${repoPath}/${file}`, resolved, 'utf8');
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

              // Stage resolved files and continue merge
              safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
              safeGitExecSync(
                `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (auto-resolved conflicts)"`,
                { encoding: 'utf8' }
              );

              console.log(`   ✅ Merge completed with auto-resolved conflicts`);

              // Update story status
              story.status = 'completed';
              story.mergedToEpic = true;
              story.mergeConflict = false;
              story.mergeConflictAutoResolved = true;

              const { NotificationService } = await import('../NotificationService');
              NotificationService.emitConsoleLog(
                'system',
                'info',
                `✅ Story "${story.title}" merged with auto-resolved conflicts`
              );

              return; // Success!
            } else {
              console.log(`   ❌ Some conflicts could not be auto-resolved with regex`);
              console.log(`   🤖 Attempting AI-powered conflict resolution...`);

              // 🔥 CALL CONFLICT-RESOLVER AGENT
              if (this.executeAgentFn) {
                try {
                  const aiResolved = await this.resolveConflictsWithAI(
                    taskId,
                    story,
                    epic,
                    repoPath,
                    conflictedFiles,
                    sandboxId // 🐳 Pass sandbox ID for Docker execution
                  );

                  if (aiResolved.success) {
                    console.log(`   ✅ AI resolved all conflicts!`);

                    // Stage and commit
                    safeGitExecSync(`cd "${repoPath}" && git add .`, { encoding: 'utf8' });
                    safeGitExecSync(
                      `cd "${repoPath}" && git commit -m "Merge story: ${story.title} (AI-resolved conflicts)"`,
                      { encoding: 'utf8' }
                    );

                    console.log(`   ✅ Merge completed with AI-resolved conflicts`);

                    story.status = 'completed';
                    story.mergedToEpic = true;
                    story.mergeConflict = false;
                    story.mergeConflictAutoResolved = true;
                    story.mergeConflictResolvedByAI = true;

                    // 🔥 COST TRACKING: Store conflict resolution cost on story
                    story.conflictResolutionCost = aiResolved.cost || 0;
                    story.conflictResolutionUsage = aiResolved.usage || {};

                    const { NotificationService } = await import('../NotificationService');
                    NotificationService.emitConsoleLog(
                      'system',
                      'info',
                      `✅ Story "${story.title}" merged with AI-resolved conflicts (cost: $${aiResolved.cost?.toFixed(4) || 0})`
                    );

                    return; // Success!
                  } else {
                    console.log(`   ❌ AI could not resolve conflicts: ${aiResolved.error}`);
                    // Still track cost even on failure
                    story.conflictResolutionCost = (story.conflictResolutionCost || 0) + (aiResolved.cost || 0);
                  }
                } catch (aiError: any) {
                  console.error(`   ❌ AI resolution failed: ${aiError.message}`);
                }
              } else {
                console.log(`   ⚠️ executeAgentFn not available - cannot use AI resolution`);
              }
            }
          } catch (resolveError: any) {
            console.error(`   ❌ Auto-resolution failed: ${resolveError.message}`);
          }
        }

        // If ALL resolution methods failed, abort merge and mark for manual resolution
        console.log(`   📋 All automatic resolution methods failed - marking for manual resolution...`);
        try {
          safeGitExecSync(`cd "${repoPath}" && git merge --abort`, { encoding: 'utf8' });
          console.log(`   ✅ Aborted conflicted merge`);
        } catch (abortError) {
          console.error(`   ⚠️ Could not abort merge: ${abortError}`);
        }

        // Mark story as having conflict (don't throw - let other stories continue)
        story.mergeConflict = true;
        story.mergeConflictDetails = error.message;
        story.mergeConflictFiles = conflictedFiles;

        const { NotificationService } = await import('../NotificationService');
        NotificationService.emitConsoleLog(
          'system',
          'warn',
          `⚠️  Story "${story.title}" has merge conflicts that require manual resolution`
        );

        return; // Don't throw - let pipeline continue with other stories
      }

      throw error; // Re-throw non-conflict errors
    }
  }

  /**
   * 🤖 Resolve merge conflicts using AI agent
   *
   * Called when simple regex resolution fails. Uses the conflict-resolver agent
   * to intelligently merge conflicting code changes.
   *
   * @returns { success: boolean, cost?: number, usage?: any, error?: string }
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
    console.log(`   Story: ${story.title}`);
    console.log(`   Epic: ${epic.title || epic.id}`);
    console.log(`   Repository: ${repoPath}`);
    console.log(`   Conflicted files: ${conflictedFiles.join(', ')}`);

    if (!this.executeAgentFn) {
      return { success: false, error: 'executeAgentFn not available' };
    }

    // Read the conflicted files to show the agent
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

    // Build prompt for conflict-resolver agent
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
- Test that the file is valid syntax after resolution

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
        repoPath,  // workspacePath
        taskId,
        'ConflictResolver',
        undefined,  // sessionId
        undefined,  // fork
        undefined,  // attachments
        {
          maxIterations: 10,  // Give it enough iterations to resolve conflicts
          timeout: AGENT_TIMEOUTS.DEFAULT,  // 5 minutes for conflict resolution
          sandboxId, // 🐳 Explicit sandbox ID for Docker execution
        }
      );

      console.log(`   ✅ Agent completed`);
      console.log(`   💰 Cost: $${result.cost?.toFixed(4) || 0}`);
      console.log(`   📊 Tokens: ${(result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0)}`);

      // Check if agent reported success
      const output = result.output || '';
      if (output.includes('CONFLICT_RESOLVED') || output.includes('✅')) {
        // Verify no conflict markers remain in any file
        let allResolved = true;
        for (const file of conflictedFiles) {
          try {
            const filePath = `${repoPath}/${file}`;
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
              console.log(`   ⚠️ File ${file} still has conflict markers`);
              allResolved = false;
            }
          } catch (verifyError) {
            // File might have been deleted/moved, that's OK
          }
        }

        if (allResolved) {
          return {
            success: true,
            cost: result.cost,
            usage: result.usage,
          };
        } else {
          return {
            success: false,
            cost: result.cost,
            usage: result.usage,
            error: 'Agent reported success but conflict markers remain',
          };
        }
      } else if (output.includes('CONFLICT_UNRESOLVABLE') || output.includes('❌')) {
        const reason = output.match(/CONFLICT_UNRESOLVABLE:\s*(.+)/)?.[1] || 'Unknown reason';
        return {
          success: false,
          cost: result.cost,
          usage: result.usage,
          error: reason,
        };
      } else {
        // Ambiguous output - check files directly
        let allResolved = true;
        for (const file of conflictedFiles) {
          try {
            const filePath = `${repoPath}/${file}`;
            const content = fs.readFileSync(filePath, 'utf8');
            if (content.includes('<<<<<<<') || content.includes('>>>>>>>')) {
              allResolved = false;
              break;
            }
          } catch (verifyError) {
            // Continue checking other files
          }
        }

        return {
          success: allResolved,
          cost: result.cost,
          usage: result.usage,
          error: allResolved ? undefined : 'Conflict markers still present',
        };
      }
    } catch (agentError: any) {
      console.error(`   ❌ Agent error: ${agentError.message}`);
      return {
        success: false,
        error: agentError.message,
      };
    }
  }
}
