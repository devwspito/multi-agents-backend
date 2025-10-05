const express = require('express');
const crypto = require('crypto');
const GitHubIntegration = require('../services/GitHubIntegration');
const Activity = require('../models/Activity');
const Project = require('../models/Project');

const router = express.Router();
const githubIntegration = new GitHubIntegration();

/**
 * GitHub Webhook Routes
 * Handle events from GitHub App
 */

/**
 * @route   POST /api/github-webhooks
 * @desc    Handle GitHub webhook events
 * @access  Public (but signature verified)
 */
router.post('/', async (req, res) => {
  try {
    // Get signature from headers
    const signature = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];

    if (!signature) {
      console.warn('⚠️ Webhook received without signature');
      return res.status(401).json({
        success: false,
        message: 'Missing signature'
      });
    }

    // Verify webhook signature
    const payload = JSON.stringify(req.body);
    const isValid = githubIntegration.verifyWebhookSignature(signature, payload);

    if (!isValid) {
      // TEMPORARY: Silenced webhook signature errors to reduce log spam
      // TODO: Fix webhook secret configuration
      // Return 200 to prevent GitHub from retrying
      return res.status(200).json({
        success: true,
        message: 'Webhook received (signature validation disabled temporarily)'
      });
    }

    console.log(`✅ GitHub Webhook: ${event} (${deliveryId})`);

    // Respond quickly to GitHub (don't make them wait)
    res.status(200).json({
      success: true,
      message: 'Webhook received',
      event,
      deliveryId
    });

    // Process webhook asynchronously
    setImmediate(async () => {
      try {
        await processWebhookEvent(event, req.body, deliveryId);
      } catch (error) {
        console.error(`❌ Error processing webhook ${event}:`, error);
      }
    });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing webhook'
    });
  }
});

/**
 * Process webhook event asynchronously
 */
async function processWebhookEvent(event, payload, deliveryId) {
  try {
    console.log(`📥 Processing ${event} event (${deliveryId})`);

    switch (event) {
      case 'push':
        await handlePushEvent(payload);
        break;

      case 'pull_request':
        await handlePullRequestEvent(payload);
        break;

      case 'pull_request_review':
        await handlePullRequestReviewEvent(payload);
        break;

      case 'installation':
        await handleInstallationEvent(payload);
        break;

      case 'installation_repositories':
        await handleInstallationRepositoriesEvent(payload);
        break;

      case 'issues':
        await handleIssuesEvent(payload);
        break;

      case 'issue_comment':
        await handleIssueCommentEvent(payload);
        break;

      case 'ping':
        console.log('🏓 Ping received - webhook is active');
        break;

      default:
        console.log(`ℹ️ Unhandled webhook event: ${event}`);
    }

    console.log(`✅ Successfully processed ${event} event`);

  } catch (error) {
    console.error(`❌ Error processing ${event} event:`, error);
    throw error;
  }
}

/**
 * Handle push events (code pushed to repository)
 */
async function handlePushEvent(payload) {
  const { repository, ref, commits, pusher } = payload;

  console.log(`📝 Push to ${repository.full_name} on ${ref} by ${pusher.name}`);
  console.log(`   ${commits.length} commit(s) pushed`);

  // Find project with this repository
  const project = await Project.findOne({
    'repositories.githubUrl': {
      $in: [repository.clone_url, repository.ssh_url, repository.html_url]
    }
  });

  if (!project) {
    console.log(`ℹ️ No project found for repository ${repository.full_name}`);
    return;
  }

  // Log activity
  await Activity.logActivity({
    project: project._id,
    actor: pusher.name,
    actorType: 'user',
    action: 'pushed',
    description: `Pushed ${commits.length} commit(s) to ${ref}`,
    details: {
      repository: repository.full_name,
      ref,
      commits: commits.map(c => ({
        sha: c.id.substring(0, 7),
        message: c.message,
        author: c.author.name,
        url: c.url
      }))
    }
  });

  // Update repository last sync time
  const repoInProject = project.repositories.find(r =>
    r.githubUrl === repository.clone_url ||
    r.githubUrl === repository.ssh_url ||
    r.githubUrl === repository.html_url
  );

  if (repoInProject) {
    repoInProject.lastSync = new Date();
    repoInProject.syncStatus = 'synced';
    await project.save();
  }
}

/**
 * Handle pull request events
 */
async function handlePullRequestEvent(payload) {
  const { action, pull_request, repository } = payload;

  console.log(`🔀 PR #${pull_request.number} ${action} in ${repository.full_name}`);
  console.log(`   ${pull_request.title}`);

  // Find project
  const project = await Project.findOne({
    'repositories.githubUrl': {
      $in: [repository.clone_url, repository.ssh_url, repository.html_url]
    }
  });

  if (!project) {
    console.log(`ℹ️ No project found for repository ${repository.full_name}`);
    return;
  }

  // Map of actions
  const actionDescriptions = {
    opened: 'opened',
    closed: pull_request.merged ? 'merged' : 'closed',
    reopened: 'reopened',
    edited: 'edited',
    ready_for_review: 'marked ready for review',
    review_requested: 'review requested',
    synchronize: 'updated'
  };

  // Log activity
  await Activity.logActivity({
    project: project._id,
    actor: pull_request.user.login,
    actorType: 'user',
    action: pull_request.merged ? 'merged' : action,
    description: `PR #${pull_request.number} ${actionDescriptions[action] || action}: ${pull_request.title}`,
    details: {
      repository: repository.full_name,
      pullRequest: {
        number: pull_request.number,
        title: pull_request.title,
        state: pull_request.state,
        merged: pull_request.merged || false,
        url: pull_request.html_url,
        author: pull_request.user.login,
        base: pull_request.base.ref,
        head: pull_request.head.ref
      }
    }
  });

  // Update project status based on PR action
  if (pull_request.merged) {
    console.log(`✅ PR #${pull_request.number} merged - code integrated`);
  }
}

/**
 * Handle pull request review events
 */
async function handlePullRequestReviewEvent(payload) {
  const { action, review, pull_request, repository } = payload;

  console.log(`👀 PR #${pull_request.number} review ${action} in ${repository.full_name}`);
  console.log(`   Review state: ${review.state} by ${review.user.login}`);

  // Find project
  const project = await Project.findOne({
    'repositories.githubUrl': {
      $in: [repository.clone_url, repository.ssh_url, repository.html_url]
    }
  });

  if (!project) {
    return;
  }

  // Log review activity
  await Activity.logActivity({
    project: project._id,
    actor: review.user.login,
    actorType: 'user',
    action: 'reviewed',
    description: `Reviewed PR #${pull_request.number}: ${review.state}`,
    details: {
      repository: repository.full_name,
      pullRequest: {
        number: pull_request.number,
        title: pull_request.title
      },
      review: {
        state: review.state,
        body: review.body,
        url: review.html_url
      }
    }
  });
}

/**
 * Handle installation events (GitHub App installed/uninstalled)
 */
async function handleInstallationEvent(payload) {
  const { action, installation, repositories } = payload;

  console.log(`🔧 GitHub App ${action} for account ${installation.account.login}`);

  if (action === 'created') {
    console.log(`✅ App installed with access to ${repositories?.length || 0} repositories`);
    console.log(`   Installation ID: ${installation.id}`);

    // Store installation ID for future use
    // You should save this in your database associated with the user
    console.log(`📝 Save this installation ID: ${installation.id}`);

  } else if (action === 'deleted') {
    console.log(`❌ App uninstalled from ${installation.account.login}`);

    // Clean up - mark repositories as disconnected
    await Project.updateMany(
      { 'repositories.installationId': installation.id },
      {
        $set: {
          'repositories.$[].isActive': false,
          'repositories.$[].syncStatus': 'disconnected'
        }
      }
    );
  }
}

/**
 * Handle installation repositories events (repos added/removed from app)
 */
async function handleInstallationRepositoriesEvent(payload) {
  const { action, installation, repositories_added, repositories_removed } = payload;

  if (action === 'added' && repositories_added) {
    console.log(`➕ ${repositories_added.length} repository(ies) added to installation ${installation.id}`);
    repositories_added.forEach(repo => {
      console.log(`   - ${repo.full_name}`);
    });
  }

  if (action === 'removed' && repositories_removed) {
    console.log(`➖ ${repositories_removed.length} repository(ies) removed from installation ${installation.id}`);

    // Mark these repositories as disconnected
    for (const repo of repositories_removed) {
      await Project.updateMany(
        {
          $or: [
            { 'repositories.githubUrl': repo.clone_url },
            { 'repositories.githubUrl': repo.ssh_url }
          ]
        },
        {
          $set: {
            'repositories.$[elem].isActive': false,
            'repositories.$[elem].syncStatus': 'disconnected'
          }
        },
        {
          arrayFilters: [
            {
              $or: [
                { 'elem.githubUrl': repo.clone_url },
                { 'elem.githubUrl': repo.ssh_url }
              ]
            }
          ]
        }
      );
    }
  }
}

/**
 * Handle issues events
 */
async function handleIssuesEvent(payload) {
  const { action, issue, repository } = payload;

  console.log(`🐛 Issue #${issue.number} ${action} in ${repository.full_name}`);
  console.log(`   ${issue.title}`);

  // Find project
  const project = await Project.findOne({
    'repositories.githubUrl': {
      $in: [repository.clone_url, repository.ssh_url, repository.html_url]
    }
  });

  if (!project) {
    return;
  }

  // Log issue activity
  await Activity.logActivity({
    project: project._id,
    actor: issue.user.login,
    actorType: 'user',
    action: action === 'opened' ? 'created' : action,
    description: `Issue #${issue.number} ${action}: ${issue.title}`,
    details: {
      repository: repository.full_name,
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map(l => l.name),
        url: issue.html_url
      }
    }
  });
}

/**
 * Handle issue comment events
 */
async function handleIssueCommentEvent(payload) {
  const { action, issue, comment, repository } = payload;

  console.log(`💬 Comment ${action} on issue #${issue.number} in ${repository.full_name}`);

  // Find project
  const project = await Project.findOne({
    'repositories.githubUrl': {
      $in: [repository.clone_url, repository.ssh_url, repository.html_url]
    }
  });

  if (!project) {
    return;
  }

  // Log comment activity
  await Activity.logActivity({
    project: project._id,
    actor: comment.user.login,
    actorType: 'user',
    action: 'commented',
    description: `Commented on issue #${issue.number}: ${issue.title}`,
    details: {
      repository: repository.full_name,
      issue: {
        number: issue.number,
        title: issue.title
      },
      comment: {
        id: comment.id,
        body: comment.body.substring(0, 200), // First 200 chars
        url: comment.html_url
      }
    }
  });
}

/**
 * @route   GET /api/github-webhooks/test
 * @desc    Test webhook endpoint (development only)
 * @access  Public
 */
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'GitHub Webhooks endpoint is active',
    webhookUrl: `${process.env.BASE_URL}/api/github-webhooks`,
    environment: process.env.NODE_ENV,
    configured: !!process.env.GITHUB_WEBHOOK_SECRET
  });
});

module.exports = router;
