/**
 * RecoveryPhase
 *
 * Detects and completes any pending, failed, or lost work.
 * Uses GitHub PRs as the source of truth to verify what was actually completed.
 *
 * States:
 * - COMPLETE: PR exists with all expected files
 * - INCOMPLETE: PR missing some files, needs re-run
 * - NEEDS_PR: Branch exists but no PR, needs push + PR creation
 * - MISSING: No branch or PR, needs full re-run
 */

import {
  BasePhase,
  OrchestrationContext,
  PhaseResult,
} from './Phase';
import { execSync } from 'child_process';
import * as path from 'path';
import { NotificationService } from '../NotificationService';
import { safeJSONParse } from './utils/OutputParser';

/**
 * Verified PR information
 */
export interface VerifiedPR {
  number: number;
  epicId: string;
  branchName: string;
  files: string[];
  status: 'complete' | 'incomplete' | 'needs_fix';
  missingFiles?: string[];
}

/**
 * Epic recovery status
 */
interface EpicRecoveryStatus {
  epicId: string;
  epicTitle: string;
  status: 'complete' | 'incomplete' | 'needs_pr' | 'missing';
  pr?: VerifiedPR;
  branch?: string;
  missingFiles?: string[];
  action?: string;
}

export class RecoveryPhase extends BasePhase {
  readonly name = 'RecoveryPhase';
  readonly description = 'Detects and completes pending or failed work by verifying GitHub PRs';

  /**
   * Main phase execution
   */
  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const taskId = this.getTaskIdString(context);
    const startTime = Date.now();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔍 [RecoveryPhase] Verifying completion status of all epics`);
    console.log(`${'='.repeat(80)}\n`);

    // 1. Get workspace and repository info
    const workspacePath = context.workspacePath;
    if (!workspacePath) {
      return {
        success: false,
        error: 'No workspace path available',
      };
    }

    // Get epics from context
    const epics = context.getData<any[]>('epics') || [];
    if (epics.length === 0) {
      console.log(`ℹ️ No epics to verify - skipping`);
      return { success: true, data: { skipped: true, reason: 'no_epics' } };
    }

    const targetRepository = epics[0]?.targetRepository;
    if (!targetRepository) {
      return {
        success: false,
        error: 'No target repository found in epics',
      };
    }

    const repoPath = path.join(workspacePath, targetRepository);

    NotificationService.emitConsoleLog(taskId, 'info', `Verifying ${epics.length} epics in ${targetRepository}`);

    try {
      // 2. Fetch PRs from GitHub
      console.log(`\n📋 [Step 1/4] Fetching PRs from GitHub...`);
      const prs = await this.fetchGitHubPRs(repoPath);
      console.log(`   Found ${prs.length} open PRs`);

      // 2.5 🔥 CRITICAL: Verify story pushes against GitHub reality
      // This catches stories marked "completed" in EventStore but never actually pushed
      console.log(`\n🔍 [Step 2/4] Verifying story pushes against GitHub...`);
      try {
        const { eventStore } = await import('../EventStore');
        const unverifiedStories = await eventStore.getUnverifiedStories(context.task?.id as any);

        if (unverifiedStories.length > 0) {
          console.log(`   Found ${unverifiedStories.length} unverified stories - checking GitHub...`);
          const verifyResult = await eventStore.verifyAllPushes({
            taskId: context.task?.id as any,
            repoPath,
          });

          if (verifyResult.failed > 0) {
            console.log(`\n   🚨 ${verifyResult.failed} stories NOT on GitHub!`);
            console.log(`   These stories were marked completed but never pushed.`);
            // Store unverified stories in context for potential re-run
            context.setData('unverifiedStories', verifyResult.failures);
          }
        } else {
          console.log(`   ✅ All completed stories are push-verified`);
        }
      } catch (verifyErr: any) {
        console.warn(`   ⚠️ Could not verify story pushes: ${verifyErr.message}`);
      }

      // 3. Verify each epic
      console.log(`\n🔍 [Step 3/4] Verifying epic completion status...`);
      const recoveryStatuses: EpicRecoveryStatus[] = [];
      const verifiedPRs: VerifiedPR[] = [];

      for (const epic of epics) {
        const status = await this.verifyEpicStatus(epic, prs, repoPath);
        recoveryStatuses.push(status);

        if (status.pr && status.status === 'complete') {
          verifiedPRs.push(status.pr);
        }

        // Log status
        const emoji = status.status === 'complete' ? '✅' :
                      status.status === 'incomplete' ? '⚠️' :
                      status.status === 'needs_pr' ? '📝' : '❌';
        console.log(`   ${emoji} ${epic.title}: ${status.status.toUpperCase()}`);
        if (status.missingFiles?.length) {
          console.log(`      Missing: ${status.missingFiles.slice(0, 3).join(', ')}${status.missingFiles.length > 3 ? '...' : ''}`);
        }
      }

      // 4. Take recovery actions if needed
      console.log(`\n🔧 [Step 4/4] Taking recovery actions...`);
      const actionsTaken: string[] = [];
      let allComplete = true;

      for (const status of recoveryStatuses) {
        if (status.status !== 'complete') {
          allComplete = false;
        }

        switch (status.status) {
          case 'complete':
            // Nothing to do
            break;

          case 'incomplete':
            // PR exists but missing files - log for now (would need developer re-run)
            console.log(`   ⚠️ ${status.epicTitle}: PR #${status.pr?.number} incomplete`);
            console.log(`      Missing ${status.missingFiles?.length} files - manual intervention may be needed`);
            actionsTaken.push(`${status.epicTitle}: logged incomplete PR`);
            break;

          case 'needs_pr':
            // Branch exists, create PR
            console.log(`   📝 ${status.epicTitle}: Creating PR for branch ${status.branch}...`);
            try {
              const pr = await this.createPRForBranch(repoPath, status.branch!, status.epicTitle);
              console.log(`   ✅ Created PR #${pr.number}`);
              actionsTaken.push(`${status.epicTitle}: created PR #${pr.number}`);

              // Add to verified PRs
              verifiedPRs.push({
                number: pr.number,
                epicId: status.epicId,
                branchName: status.branch!,
                files: [], // Would need to fetch
                status: 'complete',
              });
            } catch (prErr: any) {
              console.error(`   ❌ Failed to create PR: ${prErr.message}`);
              actionsTaken.push(`${status.epicTitle}: failed to create PR`);
            }
            break;

          case 'missing':
            // No branch or PR - needs full re-run
            console.log(`   ❌ ${status.epicTitle}: No branch or PR found`);
            console.log(`      This epic needs to be re-developed`);
            actionsTaken.push(`${status.epicTitle}: marked as needing re-run`);
            break;
        }
      }

      // Store verified PRs in context for IntegrationPhase
      context.setData('verifiedPRs', verifiedPRs);
      context.setData('recoveryStatuses', recoveryStatuses);

      const duration = Date.now() - startTime;
      console.log(`\n${'='.repeat(80)}`);
      console.log(`${allComplete ? '✅' : '⚠️'} [RecoveryPhase] Completed in ${Math.round(duration / 1000)}s`);
      console.log(`   Complete: ${recoveryStatuses.filter(s => s.status === 'complete').length}/${epics.length}`);
      console.log(`   Actions taken: ${actionsTaken.length}`);
      console.log(`${'='.repeat(80)}\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `Recovery complete: ${recoveryStatuses.filter(s => s.status === 'complete').length}/${epics.length} epics verified`
      );

      return {
        success: true,
        data: {
          verifiedPRs,
          recoveryStatuses,
          actionsTaken,
          allComplete,
        },
      };
    } catch (error: any) {
      console.error(`❌ [RecoveryPhase] Error: ${error.message}`);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Fetch list of PRs from GitHub
   */
  private async fetchGitHubPRs(repoPath: string): Promise<Array<{
    number: number;
    headRefName: string;
    title: string;
    files?: string[];
  }>> {
    try {
      const output = execSync(
        `gh pr list --json number,headRefName,title --limit 100`,
        { cwd: repoPath, encoding: 'utf8', timeout: 30000 }
      );

      const prs = safeJSONParse(output);

      // Fetch files for each PR
      for (const pr of prs) {
        try {
          const filesOutput = execSync(
            `gh pr view ${pr.number} --json files`,
            { cwd: repoPath, encoding: 'utf8', timeout: 30000 }
          );
          const filesData = safeJSONParse(filesOutput);
          pr.files = filesData.files?.map((f: any) => f.path) || [];
        } catch (fileErr) {
          pr.files = [];
        }
      }

      return prs;
    } catch (error: any) {
      console.warn(`   ⚠️ Could not fetch PRs: ${error.message}`);
      return [];
    }
  }

  /**
   * Verify the status of an epic
   */
  private async verifyEpicStatus(
    epic: any,
    prs: Array<{ number: number; headRefName: string; title: string; files?: string[] }>,
    repoPath: string
  ): Promise<EpicRecoveryStatus> {
    const epicId = epic.id;
    const epicTitle = epic.title || `Epic ${epicId}`;
    const branchName = epic.branchName;

    // Expected files from epic (if defined in planning)
    const expectedFiles = epic.filesToCreate || epic.stories?.flatMap((s: any) => s.filesToCreate || []) || [];

    // Try to find PR for this epic
    const pr = prs.find(p =>
      p.headRefName === branchName ||
      p.headRefName.includes(epicId) ||
      p.title.toLowerCase().includes(epicId.toLowerCase())
    );

    if (pr) {
      // PR exists - check if complete
      const prFiles = pr.files || [];

      // If no expected files defined, consider complete
      if (expectedFiles.length === 0) {
        return {
          epicId,
          epicTitle,
          status: 'complete',
          pr: {
            number: pr.number,
            epicId,
            branchName: pr.headRefName,
            files: prFiles,
            status: 'complete',
          },
        };
      }

      // Check for missing files
      const missingFiles = expectedFiles.filter((f: string) => !prFiles.includes(f));

      if (missingFiles.length === 0) {
        return {
          epicId,
          epicTitle,
          status: 'complete',
          pr: {
            number: pr.number,
            epicId,
            branchName: pr.headRefName,
            files: prFiles,
            status: 'complete',
          },
        };
      } else {
        return {
          epicId,
          epicTitle,
          status: 'incomplete',
          pr: {
            number: pr.number,
            epicId,
            branchName: pr.headRefName,
            files: prFiles,
            status: 'incomplete',
            missingFiles,
          },
          missingFiles,
        };
      }
    }

    // No PR - check if branch exists on remote
    try {
      const remoteBranches = execSync(`git ls-remote --heads origin`, {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 30000,
      });

      if (branchName && remoteBranches.includes(branchName)) {
        return {
          epicId,
          epicTitle,
          status: 'needs_pr',
          branch: branchName,
          action: 'create_pr',
        };
      }

      // Check for any branch matching epic ID
      const matchingBranch = remoteBranches.split('\n')
        .map(line => line.split('\t')[1]?.replace('refs/heads/', ''))
        .find(b => b && b.includes(epicId));

      if (matchingBranch) {
        return {
          epicId,
          epicTitle,
          status: 'needs_pr',
          branch: matchingBranch,
          action: 'create_pr',
        };
      }
    } catch (branchErr) {
      // Could not check branches
    }

    // No branch or PR found
    return {
      epicId,
      epicTitle,
      status: 'missing',
      action: 're_run_epic',
    };
  }

  /**
   * Create a PR for an existing branch
   */
  private async createPRForBranch(
    repoPath: string,
    branchName: string,
    epicTitle: string
  ): Promise<{ number: number; url: string }> {
    const prTitle = `feat: ${epicTitle}`;
    const prBody = `## Summary\nAutomatically created PR for ${epicTitle}\n\n## Test Plan\n- Build passes\n- No merge conflicts`;

    const output = execSync(
      `gh pr create --base main --head "${branchName}" --title "${prTitle.replace(/"/g, '\\"')}" --body "${prBody.replace(/"/g, '\\"')}"`,
      { cwd: repoPath, encoding: 'utf8', timeout: 60000 }
    );

    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    const numberMatch = urlMatch?.[0].match(/\/pull\/(\d+)/);

    return {
      number: numberMatch ? parseInt(numberMatch[1]) : 0,
      url: urlMatch?.[0] || '',
    };
  }

  /**
   * Check if phase should be skipped
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    // Check if recovery was already completed
    const existingResult = context.getPhaseResult('RecoveryPhase');
    if (existingResult?.success) {
      this.logSkipDecision(true, 'Recovery already completed');
      return true;
    }

    // Check if there are any epics to verify
    const epics = context.getData<any[]>('epics') || [];
    if (epics.length === 0) {
      this.logSkipDecision(true, 'No epics to verify');
      return true;
    }

    return false;
  }
}

export default RecoveryPhase;
