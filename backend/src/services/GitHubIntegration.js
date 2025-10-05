const { Octokit } = require('@octokit/rest');
const { createAppAuth } = require('@octokit/auth-app');
const fs = require('fs').promises;
const path = require('path');

class GitHubIntegration {
  constructor() {
    this.octokits = new Map(); // Store per-repository Octokit instances
    this.webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    this.appId = process.env.GITHUB_APP_ID;
    this.privateKey = process.env.GITHUB_PRIVATE_KEY;
  }

  /**
   * Get or create authenticated Octokit instance for a repository
   */
  async getOctokit(repository) {
    const key = `${repository.owner}/${repository.name}`;
    
    if (this.octokits.has(key)) {
      return this.octokits.get(key);
    }

    let octokit;

    if (repository.accessToken) {
      // Use personal access token
      octokit = new Octokit({
        auth: repository.accessToken
      });
    } else if (this.appId && this.privateKey) {
      // Use GitHub App authentication
      octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: this.appId,
          privateKey: this.privateKey,
          installationId: repository.installationId
        }
      });
    } else {
      throw new Error('No authentication method available for GitHub API');
    }

    this.octokits.set(key, octokit);
    return octokit;
  }

  /**
   * Create pull request for a repository
   */
  async createPullRequest(repository, pullRequestData) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.create({
        owner: repository.owner,
        repo: repository.name,
        title: pullRequestData.title,
        body: pullRequestData.description,
        head: pullRequestData.head,
        base: pullRequestData.base || 'main'
      });

      // Add labels if specified
      if (pullRequestData.labels && pullRequestData.labels.length > 0) {
        await octokit.rest.issues.addLabels({
          owner: repository.owner,
          repo: repository.name,
          issue_number: response.data.number,
          labels: pullRequestData.labels
        });
      }

      // Request reviewers if specified
      if (pullRequestData.reviewers) {
        await this.requestReviewers(repository, response.data.number, pullRequestData.reviewers);
      }

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to create pull request for ${repository.owner}/${repository.name}: ${error.message}`);
    }
  }

  /**
   * Request reviewers for a pull request
   */
  async requestReviewers(repository, pullNumber, reviewers) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const reviewerData = {};
      
      if (reviewers.users && reviewers.users.length > 0) {
        reviewerData.reviewers = reviewers.users;
      }
      
      if (reviewers.teams && reviewers.teams.length > 0) {
        reviewerData.team_reviewers = reviewers.teams;
      }

      if (Object.keys(reviewerData).length > 0) {
        await octokit.rest.pulls.requestReviewers({
          owner: repository.owner,
          repo: repository.name,
          pull_number: pullNumber,
          ...reviewerData
        });
      }
      
    } catch (error) {
      console.warn(`Failed to request reviewers for PR #${pullNumber}:`, error.message);
    }
  }

  /**
   * Get pull request details
   */
  async getPullRequest(repository, pullNumber) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.get({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullNumber
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to get pull request #${pullNumber}: ${error.message}`);
    }
  }

  /**
   * Get pull request diff
   */
  async getPullRequestDiff(repository, pullNumber) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.get({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullNumber,
        mediaType: {
          format: 'diff'
        }
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to get pull request diff #${pullNumber}: ${error.message}`);
    }
  }

  /**
   * Get all files changed in a pull request
   */
  async getPullRequestFiles(repository, pullNumber) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.listFiles({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullNumber
      });

      return response.data.map(file => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
        contents_url: file.contents_url,
        blob_url: file.blob_url
      }));
      
    } catch (error) {
      throw new Error(`Failed to get pull request files #${pullNumber}: ${error.message}`);
    }
  }

  /**
   * Create review comment on pull request
   */
  async createReviewComment(repository, pullNumber, comment) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.createReview({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullNumber,
        body: comment.body,
        event: comment.event || 'COMMENT', // APPROVE, REQUEST_CHANGES, COMMENT
        comments: comment.line_comments || []
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to create review comment: ${error.message}`);
    }
  }

  /**
   * Merge pull request
   */
  async mergePullRequest(repository, pullNumber, mergeMethod = 'merge') {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.pulls.merge({
        owner: repository.owner,
        repo: repository.name,
        pull_number: pullNumber,
        merge_method: mergeMethod // merge, squash, rebase
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to merge pull request #${pullNumber}: ${error.message}`);
    }
  }

  /**
   * Get repository information
   */
  async getRepository(owner, name) {
    try {
      const repository = { owner, name };
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.get({
        owner,
        repo: name
      });

      return {
        ...response.data,
        owner: response.data.owner.login,
        name: response.data.name,
        full_name: response.data.full_name,
        clone_url: response.data.clone_url,
        ssh_url: response.data.ssh_url,
        default_branch: response.data.default_branch,
        topics: response.data.topics || [],
        languages: await this.getRepositoryLanguages(repository)
      };
      
    } catch (error) {
      throw new Error(`Failed to get repository ${owner}/${name}: ${error.message}`);
    }
  }

  /**
   * Get repository languages
   */
  async getRepositoryLanguages(repository) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.listLanguages({
        owner: repository.owner,
        repo: repository.name
      });

      return response.data;
      
    } catch (error) {
      console.warn(`Failed to get repository languages:`, error.message);
      return {};
    }
  }

  /**
   * Create or update webhook for repository
   */
  async createWebhook(repository, webhookUrl, events = ['push', 'pull_request']) {
    try {
      const octokit = await this.getOctokit(repository);
      
      // Check if webhook already exists
      const existingWebhooks = await octokit.rest.repos.listWebhooks({
        owner: repository.owner,
        repo: repository.name
      });

      const existingWebhook = existingWebhooks.data.find(
        webhook => webhook.config.url === webhookUrl
      );

      if (existingWebhook) {
        // Update existing webhook
        const response = await octokit.rest.repos.updateWebhook({
          owner: repository.owner,
          repo: repository.name,
          hook_id: existingWebhook.id,
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: this.webhookSecret
          },
          events,
          active: true
        });

        return response.data;
      } else {
        // Create new webhook
        const response = await octokit.rest.repos.createWebhook({
          owner: repository.owner,
          repo: repository.name,
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: this.webhookSecret
          },
          events,
          active: true
        });

        return response.data;
      }
      
    } catch (error) {
      throw new Error(`Failed to create webhook for ${repository.owner}/${repository.name}: ${error.message}`);
    }
  }

  /**
   * Get repository branches
   */
  async getBranches(repository) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.listBranches({
        owner: repository.owner,
        repo: repository.name
      });

      return response.data.map(branch => ({
        name: branch.name,
        commit: branch.commit,
        protected: branch.protected
      }));
      
    } catch (error) {
      throw new Error(`Failed to get branches for ${repository.owner}/${repository.name}: ${error.message}`);
    }
  }

  /**
   * Compare two branches/commits
   */
  async compareBranches(repository, base, head) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.compareCommits({
        owner: repository.owner,
        repo: repository.name,
        base,
        head
      });

      return {
        status: response.data.status,
        ahead_by: response.data.ahead_by,
        behind_by: response.data.behind_by,
        total_commits: response.data.total_commits,
        commits: response.data.commits,
        files: response.data.files?.map(file => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch
        })) || []
      };
      
    } catch (error) {
      throw new Error(`Failed to compare ${base}...${head}: ${error.message}`);
    }
  }

  /**
   * Create deployment for repository
   */
  async createDeployment(repository, deploymentData) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.createDeployment({
        owner: repository.owner,
        repo: repository.name,
        ref: deploymentData.ref,
        environment: deploymentData.environment || 'production',
        description: deploymentData.description,
        auto_merge: deploymentData.auto_merge || false,
        required_contexts: deploymentData.required_contexts || []
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to create deployment: ${error.message}`);
    }
  }

  /**
   * Update deployment status
   */
  async updateDeploymentStatus(repository, deploymentId, status) {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.createDeploymentStatus({
        owner: repository.owner,
        repo: repository.name,
        deployment_id: deploymentId,
        state: status.state, // error, failure, inactive, in_progress, queued, pending, success
        description: status.description,
        target_url: status.target_url,
        environment_url: status.environment_url
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to update deployment status: ${error.message}`);
    }
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload, signature) {
    if (!this.webhookSecret) {
      throw new Error('Webhook secret not configured');
    }

    // Validate signature exists and has correct format
    if (!signature || typeof signature !== 'string') {
      return false;
    }

    const crypto = require('crypto');
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', this.webhookSecret)
      .update(payload, 'utf8')
      .digest('hex');

    // Check length before timingSafeEqual to avoid ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  }

  /**
   * Process webhook event
   */
  async processWebhookEvent(eventType, payload) {
    try {
      switch (eventType) {
        case 'push':
          return await this.handlePushEvent(payload);
        
        case 'pull_request':
          return await this.handlePullRequestEvent(payload);
        
        case 'pull_request_review':
          return await this.handlePullRequestReviewEvent(payload);
        
        case 'deployment':
          return await this.handleDeploymentEvent(payload);
        
        default:
          console.log(`Unhandled webhook event: ${eventType}`);
          return { handled: false };
      }
    } catch (error) {
      console.error(`Error processing webhook event ${eventType}:`, error);
      throw error;
    }
  }

  /**
   * Handle push webhook event
   */
  async handlePushEvent(payload) {
    const repository = {
      owner: payload.repository.owner.login,
      name: payload.repository.name
    };

    return {
      type: 'push',
      repository,
      ref: payload.ref,
      commits: payload.commits,
      pusher: payload.pusher,
      handled: true
    };
  }

  /**
   * Handle pull request webhook event
   */
  async handlePullRequestEvent(payload) {
    const repository = {
      owner: payload.repository.owner.login,
      name: payload.repository.name
    };

    return {
      type: 'pull_request',
      action: payload.action,
      repository,
      pull_request: payload.pull_request,
      handled: true
    };
  }

  /**
   * Handle pull request review webhook event
   */
  async handlePullRequestReviewEvent(payload) {
    const repository = {
      owner: payload.repository.owner.login,
      name: payload.repository.name
    };

    return {
      type: 'pull_request_review',
      action: payload.action,
      repository,
      pull_request: payload.pull_request,
      review: payload.review,
      handled: true
    };
  }

  /**
   * Handle deployment webhook event
   */
  async handleDeploymentEvent(payload) {
    const repository = {
      owner: payload.repository.owner.login,
      name: payload.repository.name
    };

    return {
      type: 'deployment',
      repository,
      deployment: payload.deployment,
      handled: true
    };
  }

  /**
   * Get file content from repository
   */
  async getFileContent(repository, filePath, ref = 'main') {
    try {
      const octokit = await this.getOctokit(repository);
      
      const response = await octokit.rest.repos.getContent({
        owner: repository.owner,
        repo: repository.name,
        path: filePath,
        ref
      });

      if (response.data.type === 'file') {
        return {
          content: Buffer.from(response.data.content, 'base64').toString('utf8'),
          sha: response.data.sha,
          size: response.data.size,
          encoding: response.data.encoding
        };
      } else {
        throw new Error(`Path ${filePath} is not a file`);
      }
      
    } catch (error) {
      throw new Error(`Failed to get file content ${filePath}: ${error.message}`);
    }
  }

  /**
   * Update file content in repository
   */
  async updateFileContent(repository, filePath, content, message, branch = 'main') {
    try {
      const octokit = await this.getOctokit(repository);
      
      // Get current file to get SHA
      let currentSha;
      try {
        const current = await this.getFileContent(repository, filePath, branch);
        currentSha = current.sha;
      } catch (error) {
        // File doesn't exist, will be created
        currentSha = null;
      }

      const response = await octokit.rest.repos.createOrUpdateFileContents({
        owner: repository.owner,
        repo: repository.name,
        path: filePath,
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
        ...(currentSha && { sha: currentSha })
      });

      return response.data;
      
    } catch (error) {
      throw new Error(`Failed to update file ${filePath}: ${error.message}`);
    }
  }
}

module.exports = GitHubIntegration;