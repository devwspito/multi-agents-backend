/**
 * GitHub Webhooks - Auto-cleanup on PR merge
 *
 * Listens to GitHub PR events and automatically cleans up branches when epic PRs are merged
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { Task } from '../../models/Task';
import { GitHubService } from '../../services/GitHubService';
import { BranchCleanupService } from '../../services/cleanup/BranchCleanupService';
import { LogService } from '../../services/logging/LogService';
import { NotificationService } from '../../services/NotificationService';
import path from 'path';
import os from 'os';

const router = Router();

/**
 * Verify GitHub webhook signature
 * Security: Ensures webhook requests actually come from GitHub
 */
function verifyGitHubSignature(payload: string, signature: string, secret: string): boolean {
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

/**
 * POST /api/webhooks/github
 *
 * GitHub webhook endpoint for PR events
 * Automatically triggers cleanup when epic PR is merged
 */
router.post('/', async (req: Request, res: Response): Promise<any> => {
  try {
    // Verify webhook signature
    const signature = req.headers['x-hub-signature-256'] as string;
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';

    if (!webhookSecret) {
      console.warn('⚠️  GITHUB_WEBHOOK_SECRET not configured - skipping signature verification');
    } else {
      const payload = JSON.stringify(req.body);
      if (!verifyGitHubSignature(payload, signature, webhookSecret)) {
        console.error('❌ Invalid GitHub webhook signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // Get event type
    const event = req.headers['x-github-event'] as string;

    // We only care about pull_request events
    if (event !== 'pull_request') {
      return res.status(200).json({ message: 'Event ignored (not a pull_request)' });
    }

    const { action, pull_request, repository } = req.body;

    // We only care about closed PRs
    if (action !== 'closed') {
      return res.status(200).json({ message: 'PR not closed, ignoring' });
    }

    // Was it merged?
    if (!pull_request.merged) {
      console.log(`ℹ️  PR #${pull_request.number} was closed without merging - no cleanup needed`);
      return res.status(200).json({ message: 'PR closed without merge, no cleanup needed' });
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🎯 GitHub Webhook: PR Merged`);
    console.log(`Repository: ${repository.full_name}`);
    console.log(`PR #${pull_request.number}: ${pull_request.title}`);
    console.log(`Branch: ${pull_request.head.ref}`);
    console.log(`${'='.repeat(80)}\n`);

    // Check if this is an epic branch
    const branchName = pull_request.head.ref;
    const isEpicBranch = branchName.startsWith('epic/');

    if (!isEpicBranch) {
      console.log(`ℹ️  Not an epic branch (${branchName}) - no cleanup needed`);
      return res.status(200).json({ message: 'Not an epic branch, no cleanup needed' });
    }

    // Find task that created this epic branch
    const task = await Task.findOne({
      'orchestration.teamOrchestration.teams.epic.branchName': branchName,
    });

    if (!task) {
      console.log(`⚠️  No task found for epic branch ${branchName}`);
      return res.status(200).json({ message: 'Task not found for this epic branch' });
    }

    const taskId = (task._id as any).toString();

    console.log(`✅ Found task: ${taskId}`);
    console.log(`   Task title: ${task.title}`);
    console.log(`   Task status: ${task.status}`);

    // Find the epic in teamOrchestration
    const teamOrch = (task.orchestration as any)?.teamOrchestration;
    if (!teamOrch || !teamOrch.teams) {
      console.log(`⚠️  No team orchestration data found`);
      return res.status(200).json({ message: 'No orchestration data found' });
    }

    const team = teamOrch.teams.find((t: any) => t.epic?.branchName === branchName);
    if (!team || !team.epic) {
      console.log(`⚠️  Epic not found in team orchestration`);
      return res.status(200).json({ message: 'Epic not found in orchestration data' });
    }

    const epicId = team.epic.id;

    await LogService.info(`GitHub webhook: Epic PR merged, triggering cleanup`, {
      taskId,
      category: 'webhook',
      metadata: {
        repository: repository.full_name,
        pullRequestNumber: pull_request.number,
        branchName,
        epicId,
      },
    });

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `🎯 Epic PR #${pull_request.number} merged - starting automatic cleanup`
    );

    // Setup cleanup service
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const githubService = new GitHubService(workspaceDir);
    const cleanupService = new BranchCleanupService(githubService);

    // Build branch mapping for this epic
    const mapping = {
      epicId: team.epic.id,
      epicBranch: team.epic.branchName,
      epicPullRequestNumber: pull_request.number,
      storyBranches: [],
      targetRepository: repository.full_name,
    };

    // Collect story branches from TechLead
    if (team.techLead?.stories) {
      for (const story of team.techLead.stories) {
        if (story.branchName) {
          (mapping.storyBranches as any).push({
            storyId: story.id,
            branchName: story.branchName,
            pullRequestNumber: story.pullRequestNumber,
            merged: story.status === 'completed',
          });
        }
      }
    }

    console.log(`\n🧹 Auto-cleanup triggered for epic: ${branchName}`);
    console.log(`   Story branches to delete: ${mapping.storyBranches.length}`);

    // Execute cleanup in background (don't block webhook response)
    setImmediate(async () => {
      try {
        await cleanupService.cleanupAllBranchesForEpic(taskId, epicId, mapping);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Auto-cleanup complete: ${mapping.storyBranches.length + 1} branches deleted`
        );

        await LogService.success(`Auto-cleanup completed via webhook`, {
          taskId,
          category: 'webhook',
          metadata: {
            epicId,
            branchesDeleted: mapping.storyBranches.length + 1,
          },
        });
      } catch (error: any) {
        console.error(`❌ Auto-cleanup failed: ${error.message}`);

        NotificationService.emitConsoleLog(
          taskId,
          'error',
          `❌ Auto-cleanup failed: ${error.message}`
        );

        await LogService.error(`Auto-cleanup failed via webhook`, {
          taskId,
          category: 'webhook',
          error,
          metadata: {
            epicId,
            errorMessage: error.message,
          },
        });
      }
    });

    // Return 200 immediately to GitHub
    res.status(200).json({
      message: 'Cleanup triggered successfully',
      taskId,
      epicId,
      branchName,
      storyBranchesCount: mapping.storyBranches.length,
    });

  } catch (error: any) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({
      error: 'Webhook processing failed',
      message: error.message,
    });
  }
});

/**
 * GET /api/webhooks/github/test
 *
 * Test endpoint to verify webhook is reachable
 */
router.get('/test', (_req: Request, res: Response) => {
  res.json({
    message: 'GitHub webhook endpoint is ready',
    timestamp: new Date().toISOString(),
    webhookSecretConfigured: !!process.env.GITHUB_WEBHOOK_SECRET,
  });
});

export default router;
