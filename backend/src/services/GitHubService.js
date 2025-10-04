const { Octokit } = require('@octokit/rest');
const { App } = require('@octokit/app');
const Activity = require('../models/Activity');
const BranchManager = require('./BranchManager');

/**
 * Multi-tenant GitHub Service with GitHub App integration
 * Supports both OAuth (user auth) and GitHub App (server operations)
 */
class GitHubService {
  constructor() {
    this.octokitInstances = new Map(); // Cache per-user Octokit instances
    this.appInstances = new Map(); // Cache per-installation App instances
    this.defaultBranch = 'main';
    this.branchManager = new BranchManager();
    this.initializeGitHubApp();
  }

  /**
   * Initialize GitHub App for server operations
   */
  initializeGitHubApp() {
    if (!process.env.GITHUB_APP_ID) {
      console.warn('⚠️ GitHub App not configured (GITHUB_APP_ID missing). Some features will be limited.');
      return;
    }

    if (!process.env.GITHUB_WEBHOOK_SECRET) {
      console.warn('⚠️ GitHub App not configured (GITHUB_WEBHOOK_SECRET missing). Webhooks will not work.');
      return;
    }

    // Get private key from environment variable or file
    let privateKey;

    if (process.env.GITHUB_PRIVATE_KEY) {
      // Production: Use environment variable (recommended)
      privateKey = process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n');
      console.log('📝 GitHub App: Using private key from GITHUB_PRIVATE_KEY environment variable');
    } else if (process.env.GITHUB_PRIVATE_KEY_PATH) {
      // Development: Use file path
      try {
        const fs = require('fs');
        privateKey = fs.readFileSync(process.env.GITHUB_PRIVATE_KEY_PATH, 'utf8');
        console.log('📝 GitHub App: Using private key from file:', process.env.GITHUB_PRIVATE_KEY_PATH);
      } catch (error) {
        console.error('❌ Failed to read GitHub App private key file:', error.message);
        return;
      }
    } else {
      console.warn('⚠️ GitHub App private key not configured. Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH.');
      return;
    }

    try {
      this.githubApp = new App({
        appId: process.env.GITHUB_APP_ID,
        privateKey: privateKey,
        webhooks: {
          secret: process.env.GITHUB_WEBHOOK_SECRET
        }
      });

      console.log('✅ GitHub App initialized successfully');
    } catch (error) {
      console.error('❌ Failed to initialize GitHub App:', error.message);
      console.warn('⚠️ GitHub App features will be disabled');
    }
  }

  /**
   * Get authenticated Octokit instance for a user (OAuth)
   */
  getOctokitForUser(userGitHubToken) {
    if (!userGitHubToken) {
      throw new Error('User GitHub token required for multi-tenant access');
    }

    // Cache instances per token for performance
    if (this.octokitInstances.has(userGitHubToken)) {
      return this.octokitInstances.get(userGitHubToken);
    }

    const octokit = new Octokit({
      auth: userGitHubToken,
    });

    this.octokitInstances.set(userGitHubToken, octokit);
    return octokit;
  }

  /**
   * Get authenticated Octokit instance for GitHub App (server operations)
   */
  async getOctokitForApp(installationId) {
    if (!this.githubApp) {
      throw new Error('GitHub App not configured. Cannot perform server operations.');
    }

    // Cache instances per installation
    if (this.appInstances.has(installationId)) {
      return this.appInstances.get(installationId);
    }

    const octokit = await this.githubApp.getInstallationOctokit(installationId);
    this.appInstances.set(installationId, octokit);
    return octokit;
  }

  /**
   * Get installation ID for a repository
   */
  async getInstallationId(repoOwner, repoName) {
    // This would typically be stored in your database when user installs your app
    // For now, we'll use a fallback or environment variable
    const installationId = process.env.GITHUB_INSTALLATION_ID;
    if (!installationId) {
      throw new Error(`GitHub App not installed for repository ${repoOwner}/${repoName}`);
    }
    return parseInt(installationId);
  }

  /**
   * Create a new repository for the user's project
   */
  async createRepository(project, userGitHubToken, organization = null) {
    const octokit = this.getOctokitForUser(userGitHubToken);
    try {
      const repoData = {
        name: this.sanitizeRepoName(project.name),
        description: `${project.description} - Educational Technology Project`,
        private: true,
        has_issues: true,
        has_projects: true,
        has_wiki: true,
        auto_init: true,
        gitignore_template: 'Node',
        license_template: 'mit'
      };

      let repo;
      if (organization) {
        repo = await octokit.repos.createInOrg({
          org: organization,
          ...repoData
        });
      } else {
        repo = await octokit.repos.createForAuthenticatedUser(repoData);
      }

      // Setup repository for educational development
      await this.setupEducationalRepository(repo.data);

      await Activity.logActivity({
        project: project._id,
        actor: 'github-service',
        actorType: 'system',
        action: 'created',
        description: `GitHub repository created: ${repo.data.full_name}`,
        details: {
          repositoryUrl: repo.data.html_url,
          repositoryName: repo.data.full_name
        }
      });

      return repo.data;
    } catch (error) {
      throw new Error(`Failed to create repository: ${error.message}`);
    }
  }

  /**
   * Setup repository with educational development structure
   */
  async setupEducationalRepository(repo) {
    const owner = repo.owner.login;
    const repoName = repo.name;

    try {
      // Create educational directory structure
      const files = [
        {
          path: 'docs/README.md',
          content: this.generateEducationalReadme()
        },
        {
          path: 'docs/EDUCATIONAL_REQUIREMENTS.md',
          content: this.generateEducationalRequirements()
        },
        {
          path: '.github/ISSUE_TEMPLATE/educational-feature.md',
          content: this.generateEducationalIssueTemplate()
        },
        {
          path: '.github/PULL_REQUEST_TEMPLATE.md',
          content: this.generateEducationalPRTemplate()
        },
        {
          path: '.github/workflows/educational-quality.yml',
          content: this.generateEducationalWorkflow()
        },
        {
          path: 'src/components/.gitkeep',
          content: '# Educational components directory'
        },
        {
          path: 'src/services/.gitkeep',
          content: '# Educational services directory'
        },
        {
          path: 'tests/accessibility/.gitkeep',
          content: '# Accessibility tests directory'
        },
        {
          path: 'tests/compliance/.gitkeep',
          content: '# FERPA/COPPA compliance tests directory'
        }
      ];

      // Create files in batches to avoid rate limiting
      for (const file of files) {
        await this.createFile(owner, repoName, file.path, file.content, `Add ${file.path}`);
        await this.delay(100); // Small delay between requests
      }

      // Setup branch protection for main branch
      await this.setupBranchProtection(owner, repoName);

      // Create labels for educational development
      await this.createEducationalLabels(owner, repoName);

    } catch (error) {
      console.warn(`Warning: Failed to fully setup repository structure: ${error.message}`);
    }
  }

  /**
   * Create a new branch for agent task with conflict management
   */
  async createAgentTaskBranch(task, agentType, repoOwner, repoName) {
    try {
      // Check repository availability and reserve branch
      const { branchName } = await this.branchManager.reserveBranch(
        task, agentType, repoOwner, repoName
      );

      // Get GitHub App installation for server operations
      const installationId = await this.getInstallationId(repoOwner, repoName);
      const octokit = await this.getOctokitForApp(installationId);

      // Get main branch SHA
      const mainBranch = await octokit.repos.getBranch({
        owner: repoOwner,
        repo: repoName,
        branch: this.defaultBranch
      });

      // Create new branch
      await octokit.git.createRef({
        owner: repoOwner,
        repo: repoName,
        ref: `refs/heads/${branchName}`,
        sha: mainBranch.data.commit.sha
      });

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: agentType,
        actorType: 'agent',
        agentType: agentType,
        action: 'branch-created',
        description: `Agent ${agentType} created branch: ${branchName}`,
        details: {
          branchName,
          baseBranch: this.defaultBranch,
          agentType,
          conflictPrevention: true
        }
      });

      return branchName;
    } catch (error) {
      // If conflict detected, queue the task
      if (error.message.includes('Repository busy')) {
        console.log(`📋 Queueing task due to conflict: ${task.title}`);
        
        await this.branchManager.queueAgentTask(
          task, agentType, repoOwner, repoName,
          () => this.createAgentTaskBranch(task, agentType, repoOwner, repoName)
        );

        return { queued: true, reason: error.message };
      }
      
      throw new Error(`Failed to create agent task branch: ${error.message}`);
    }
  }

  /**
   * Release branch when agent work is complete
   */
  async releaseAgentBranch(branchName) {
    try {
      await this.branchManager.releaseBranch(branchName);
      
      await Activity.logActivity({
        actor: 'github-service',
        actorType: 'system',
        action: 'branch-released',
        description: `Branch released: ${branchName}`,
        details: {
          branchName,
          conflictPrevention: true
        }
      });
    } catch (error) {
      console.error(`Failed to release branch ${branchName}: ${error.message}`);
    }
  }

  /**
   * Create pull request for completed task
   */
  async createPullRequest(task, repoOwner, repoName, branchName) {
    try {
      const pr = await this.octokit.pulls.create({
        owner: repoOwner,
        repo: repoName,
        title: this.generatePRTitle(task),
        body: this.generatePRBody(task),
        head: branchName,
        base: this.defaultBranch,
        draft: task.status !== 'review'
      });

      // Add educational labels
      await this.addEducationalLabels(repoOwner, repoName, pr.data.number, task);

      // Request review from appropriate team members
      await this.requestReviews(repoOwner, repoName, pr.data.number, task);

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: task.assignedAgent || 'system',
        actorType: 'agent',
        agentType: task.assignedAgent,
        action: 'pr-created',
        description: `Pull request created: #${pr.data.number}`,
        details: {
          prNumber: pr.data.number,
          prUrl: pr.data.html_url,
          title: pr.data.title
        }
      });

      return pr.data;
    } catch (error) {
      throw new Error(`Failed to create pull request: ${error.message}`);
    }
  }

  /**
   * Update pull request status and merge if approved
   */
  async updatePullRequest(repoOwner, repoName, prNumber, action, task) {
    try {
      switch (action) {
        case 'approve':
          await this.approvePullRequest(repoOwner, repoName, prNumber, task);
          break;
        case 'request-changes':
          await this.requestChanges(repoOwner, repoName, prNumber, task);
          break;
        case 'merge':
          await this.mergePullRequest(repoOwner, repoName, prNumber, task);
          break;
        default:
          throw new Error(`Unknown PR action: ${action}`);
      }
    } catch (error) {
      throw new Error(`Failed to update pull request: ${error.message}`);
    }
  }

  /**
   * Create GitHub issue for task tracking
   */
  async createIssue(task, repoOwner, repoName) {
    try {
      const issue = await this.octokit.issues.create({
        owner: repoOwner,
        repo: repoName,
        title: task.title,
        body: this.generateIssueBody(task),
        labels: this.getIssueLabels(task),
        assignees: task.assignedTo ? [task.assignedTo.username] : []
      });

      await Activity.logActivity({
        task: task._id,
        project: task.project,
        actor: 'github-service',
        actorType: 'system',
        action: 'created',
        description: `GitHub issue created: #${issue.data.number}`,
        details: {
          issueNumber: issue.data.number,
          issueUrl: issue.data.html_url
        }
      });

      return issue.data;
    } catch (error) {
      throw new Error(`Failed to create issue: ${error.message}`);
    }
  }

  /**
   * Get repository statistics for project dashboard
   */
  async getRepositoryStats(repoOwner, repoName) {
    try {
      const [repo, commits, prs, issues] = await Promise.all([
        this.octokit.repos.get({ owner: repoOwner, repo: repoName }),
        this.octokit.repos.listCommits({ owner: repoOwner, repo: repoName, per_page: 100 }),
        this.octokit.pulls.list({ owner: repoOwner, repo: repoName, state: 'all' }),
        this.octokit.issues.list({ owner: repoOwner, repo: repoName, state: 'all' })
      ]);

      return {
        repository: {
          name: repo.data.name,
          description: repo.data.description,
          url: repo.data.html_url,
          stars: repo.data.stargazers_count,
          forks: repo.data.forks_count,
          size: repo.data.size,
          language: repo.data.language,
          lastUpdated: repo.data.updated_at
        },
        activity: {
          totalCommits: commits.data.length,
          recentCommits: commits.data.slice(0, 10),
          totalPullRequests: prs.data.length,
          openPullRequests: prs.data.filter(pr => pr.state === 'open').length,
          totalIssues: issues.data.filter(issue => !issue.pull_request).length,
          openIssues: issues.data.filter(issue => !issue.pull_request && issue.state === 'open').length
        }
      };
    } catch (error) {
      throw new Error(`Failed to get repository stats: ${error.message}`);
    }
  }

  // Helper methods for educational development

  generateTaskBranchName(task) {
    const sanitizedTitle = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 50);
    
    return `feature/${task.complexity}/${sanitizedTitle}`;
  }

  /**
   * Get repository status for monitoring conflicts
   */
  getRepositoryStatus(repoOwner, repoName) {
    return this.branchManager.getRepositoryStatus(repoOwner, repoName);
  }

  /**
   * Get all repositories status for dashboard
   */
  getAllRepositoriesStatus() {
    return this.branchManager.getAllRepositoriesStatus();
  }

  /**
   * Force release a branch (admin function)
   */
  async forceReleaseBranch(branchName, reason) {
    return this.branchManager.forceReleaseBranch(branchName, reason);
  }

  generatePRTitle(task) {
    const typeEmoji = {
      'feature': '✨',
      'bug': '🐛',
      'enhancement': '⚡',
      'documentation': '📚',
      'testing': '🧪',
      'compliance': '🔒'
    };

    return `${typeEmoji[task.type] || '📝'} [${task.complexity.toUpperCase()}] ${task.title}`;
  }

  generatePRBody(task) {
    return `
## 📚 Educational Impact
**Learning Objectives**: ${task.educationalImpact?.learningObjectives?.join(', ') || 'N/A'}
**Target Audience**: ${task.educationalImpact?.targetAudience || 'N/A'}
**Expected Outcomes**: ${task.educationalImpact?.expectedOutcomes?.join(', ') || 'N/A'}

## 🎯 Task Description
${task.description}

## 🔧 Changes Made
- [ ] Implementation completed
- [ ] Tests added (>80% coverage)
- [ ] Accessibility compliance verified
- [ ] Educational workflows tested
- [ ] Documentation updated

## 🛡️ Compliance Checklist
- [ ] FERPA compliance: No student PII exposed
- [ ] COPPA compliance: Under-13 protections in place
- [ ] Accessibility: WCAG 2.1 AA standards met
- [ ] Security: Input validation and data protection

## 🧪 Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Accessibility tests pass
- [ ] Educational workflow tests pass
- [ ] Manual testing completed

## 📊 Metrics
**Complexity**: ${task.complexity}
**Estimated Hours**: ${task.estimatedHours || 'N/A'}
**Type**: ${task.type}

## 👥 Review Requirements
This PR requires review from:
- [ ] Senior Developer (for technical implementation)
- [ ] QA Engineer (for testing and compliance)
- [ ] Educational Stakeholder (for learning impact)

---
*This PR is part of educational technology development following FERPA/COPPA compliance and accessibility standards.*
`;
  }

  generateIssueBody(task) {
    return `
## 📚 Educational Context
**Type**: ${task.type}
**Complexity**: ${task.complexity}
**Priority**: ${task.priority}

## 🎯 Description
${task.description}

## 📋 Acceptance Criteria
${task.educationalImpact?.expectedOutcomes?.map(outcome => `- [ ] ${outcome}`).join('\n') || '- [ ] Feature implementation completed'}

## 🛡️ Compliance Requirements
${task.compliance?.ferpaReview.required ? '- [ ] FERPA compliance review' : ''}
${task.compliance?.coppaReview.required ? '- [ ] COPPA compliance review' : ''}
${task.testing?.accessibilityTests.required ? '- [ ] Accessibility testing (WCAG 2.1 AA)' : ''}

## 🔗 Related Information
**Estimated Hours**: ${task.estimatedHours || 'TBD'}
**Learning Objectives**: ${task.educationalImpact?.learningObjectives?.join(', ') || 'N/A'}
`;
  }

  getIssueLabels(task) {
    const labels = [
      `type:${task.type}`,
      `complexity:${task.complexity}`,
      `priority:${task.priority}`,
      'educational-tech'
    ];

    if (task.compliance?.ferpaReview.required) labels.push('compliance:ferpa');
    if (task.compliance?.coppaReview.required) labels.push('compliance:coppa');
    if (task.testing?.accessibilityTests.required) labels.push('accessibility');

    return labels;
  }

  async addEducationalLabels(repoOwner, repoName, prNumber, task) {
    try {
      const labels = this.getIssueLabels(task);
      await this.octokit.issues.addLabels({
        owner: repoOwner,
        repo: repoName,
        issue_number: prNumber,
        labels
      });
    } catch (error) {
      console.warn(`Failed to add labels: ${error.message}`);
    }
  }

  async requestReviews(repoOwner, repoName, prNumber, task) {
    try {
      const reviewers = [];
      
      // Always request senior developer review for complex tasks
      if (task.complexity === 'complex' || task.complexity === 'expert') {
        reviewers.push('senior-developer');
      }
      
      // Request QA review for testing or compliance tasks
      if (task.type === 'testing' || task.type === 'compliance') {
        reviewers.push('qa-engineer');
      }

      if (reviewers.length > 0) {
        await this.octokit.pulls.requestReviewers({
          owner: repoOwner,
          repo: repoName,
          pull_number: prNumber,
          team_reviewers: reviewers
        });
      }
    } catch (error) {
      console.warn(`Failed to request reviews: ${error.message}`);
    }
  }

  async createEducationalLabels(repoOwner, repoName) {
    const labels = [
      { name: 'educational-tech', color: '0e7db8', description: 'Educational technology feature' },
      { name: 'type:feature', color: '00ff00', description: 'New feature implementation' },
      { name: 'type:bug', color: 'ff0000', description: 'Bug fix' },
      { name: 'type:enhancement', color: 'ffff00', description: 'Enhancement to existing feature' },
      { name: 'type:documentation', color: '0000ff', description: 'Documentation update' },
      { name: 'type:testing', color: 'ff00ff', description: 'Testing related' },
      { name: 'type:compliance', color: '800080', description: 'Compliance requirement' },
      { name: 'complexity:simple', color: 'c5def5', description: 'Simple implementation' },
      { name: 'complexity:moderate', color: '7fc7ff', description: 'Moderate complexity' },
      { name: 'complexity:complex', color: '007fff', description: 'Complex implementation' },
      { name: 'complexity:expert', color: '003f7f', description: 'Expert level complexity' },
      { name: 'priority:low', color: 'e6e6e6', description: 'Low priority' },
      { name: 'priority:medium', color: 'ffcc00', description: 'Medium priority' },
      { name: 'priority:high', color: 'ff6600', description: 'High priority' },
      { name: 'priority:critical', color: 'cc0000', description: 'Critical priority' },
      { name: 'compliance:ferpa', color: '8b0000', description: 'FERPA compliance required' },
      { name: 'compliance:coppa', color: '4b0000', description: 'COPPA compliance required' },
      { name: 'accessibility', color: '663399', description: 'Accessibility requirement' }
    ];

    for (const label of labels) {
      try {
        await this.octokit.issues.createLabel({
          owner: repoOwner,
          repo: repoName,
          ...label
        });
      } catch (error) {
        if (!error.message.includes('already_exists')) {
          console.warn(`Failed to create label ${label.name}: ${error.message}`);
        }
      }
    }
  }

  // File and content generation methods
  generateEducationalReadme() {
    return `# Educational Technology Project

This repository contains an educational technology solution built with AI-powered development teams.

## 🎓 Educational Focus
- Learning-centered design
- Accessibility compliance (WCAG 2.1 AA)
- Student data protection (FERPA/COPPA)
- Evidence-based educational practices

## 🏗️ Development Structure
- **Frontend**: Student-facing interfaces
- **Backend**: Educational services and APIs
- **Tests**: Comprehensive testing including accessibility
- **Docs**: Educational requirements and compliance

## 🛡️ Compliance
This project follows educational technology standards:
- FERPA compliance for student data protection
- COPPA compliance for under-13 users
- WCAG 2.1 AA accessibility standards
- Educational privacy best practices

## 🚀 Getting Started
See [EDUCATIONAL_REQUIREMENTS.md](docs/EDUCATIONAL_REQUIREMENTS.md) for detailed setup instructions.
`;
  }

  generateEducationalRequirements() {
    return `# Educational Requirements

## Learning Objectives
All features must align with clear learning objectives and educational outcomes.

## Accessibility Standards
- WCAG 2.1 AA compliance minimum
- Screen reader compatibility
- Keyboard navigation support
- Color-blind friendly design

## Privacy & Compliance
- FERPA: Student educational records protection
- COPPA: Under-13 user data protection
- GDPR: EU user data processing (if applicable)

## Testing Requirements
- Unit tests: >80% coverage
- Integration tests: Critical paths
- Accessibility tests: Automated scanning
- Educational workflow tests: User journey validation

## Code Review Process
1. Junior developer implements
2. Senior developer reviews
3. QA engineer validates
4. Educational stakeholder approves
`;
  }

  generateEducationalIssueTemplate() {
    return `---
name: Educational Feature Request
about: Request a new educational technology feature
title: '[FEATURE] '
labels: 'type:feature, educational-tech'
assignees: ''
---

## 📚 Educational Context
**Learning Objectives**: 
**Target Audience**: 
**Expected Learning Outcomes**: 

## 🎯 Feature Description
A clear description of the educational feature needed.

## 📋 Acceptance Criteria
- [ ] 
- [ ] 
- [ ] 

## 🛡️ Compliance Requirements
- [ ] FERPA compliance review needed
- [ ] COPPA compliance review needed
- [ ] Accessibility testing required
- [ ] Educational workflow validation needed

## 📊 Success Metrics
How will we measure the educational impact of this feature?
`;
  }

  generateEducationalPRTemplate() {
    return `## 📚 Educational Impact
**Learning Objectives**: 
**Target Audience**: 
**Expected Outcomes**: 

## 🎯 Changes Made
- [ ] Implementation completed
- [ ] Tests added (>80% coverage)
- [ ] Accessibility compliance verified
- [ ] Educational workflows tested
- [ ] Documentation updated

## 🛡️ Compliance Checklist
- [ ] FERPA compliance: No student PII exposed
- [ ] COPPA compliance: Under-13 protections in place
- [ ] Accessibility: WCAG 2.1 AA standards met
- [ ] Security: Input validation and data protection

## 🧪 Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Accessibility tests pass
- [ ] Educational workflow tests pass

## 📊 Educational Metrics
**Complexity**: 
**Type**: 
**Priority**: 
`;
  }

  generateEducationalWorkflow() {
    return `name: Educational Quality Check

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  educational-quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run tests
        run: npm test
        
      - name: Check test coverage
        run: npm run coverage
        
      - name: Accessibility audit
        run: npm run test:accessibility
        
      - name: FERPA compliance check
        run: npm run audit:ferpa
        
      - name: Security audit
        run: npm audit --audit-level moderate
`;
  }

  // Utility methods
  sanitizeRepoName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  async createFile(owner, repo, path, content, message) {
    try {
      await this.octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString('base64')
      });
    } catch (error) {
      console.warn(`Failed to create file ${path}: ${error.message}`);
    }
  }

  async setupBranchProtection(owner, repo) {
    try {
      await this.octokit.repos.updateBranchProtection({
        owner,
        repo,
        branch: this.defaultBranch,
        required_status_checks: {
          strict: true,
          contexts: ['educational-quality']
        },
        enforce_admins: true,
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: true
        },
        restrictions: null
      });
    } catch (error) {
      console.warn(`Failed to setup branch protection: ${error.message}`);
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async approvePullRequest(repoOwner, repoName, prNumber, task) {
    await this.octokit.pulls.createReview({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
      event: 'APPROVE',
      body: 'Educational compliance and quality standards met. Approved for merge.'
    });
  }

  async requestChanges(repoOwner, repoName, prNumber, task) {
    await this.octokit.pulls.createReview({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
      event: 'REQUEST_CHANGES',
      body: 'Changes requested to meet educational technology standards.'
    });
  }

  async mergePullRequest(repoOwner, repoName, prNumber, task) {
    await this.octokit.pulls.merge({
      owner: repoOwner,
      repo: repoName,
      pull_number: prNumber,
      commit_title: `Merge educational feature: ${task.title}`,
      merge_method: 'squash'
    });

    await Activity.logActivity({
      task: task._id,
      project: task.project,
      actor: 'github-service',
      actorType: 'system',
      action: 'merged',
      description: `Pull request #${prNumber} merged successfully`,
      details: {
        prNumber,
        mergeMethod: 'squash'
      }
    });
  }
}

// Export singleton instance to avoid multiple GitHub App initializations
let instance = null;

module.exports = {
  getInstance: () => {
    if (!instance) {
      instance = new GitHubService();
    }
    return instance;
  },
  // For backward compatibility (deprecated)
  GitHubService
};