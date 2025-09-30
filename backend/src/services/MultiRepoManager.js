const fs = require('fs').promises;
const path = require('path');
const { promisify } = require('util');
const { exec } = require('child_process');
const execAsync = promisify(exec);
const GitHubIntegration = require('./GitHubIntegration');

class MultiRepoManager {
  constructor() {
    this.githubIntegration = new GitHubIntegration();
    this.workspaceBase = process.env.WORKSPACE_BASE || './workspaces';
  }

  /**
   * Create a multi-repository workspace for a project
   */
  async createMultiRepoWorkspace(projectId, repositories) {
    const workspaceId = `project-${projectId}-${Date.now()}`;
    const workspacePath = path.join(this.workspaceBase, workspaceId);
    
    try {
      // Create workspace directory
      await fs.mkdir(workspacePath, { recursive: true });
      
      // Clone all repositories
      const clonedRepos = await Promise.all(
        repositories.map(repo => this.cloneRepository(repo, workspacePath))
      );
      
      // Set up inter-repository links and shared configuration
      await this.setupWorkspaceConfiguration(workspacePath, clonedRepos);
      
      return {
        id: workspaceId,
        path: workspacePath,
        repositories: clonedRepos,
        createdAt: new Date(),
        status: 'ready'
      };
      
    } catch (error) {
      // Cleanup on failure
      await this.cleanupWorkspace(workspacePath);
      throw new Error(`Failed to create multi-repo workspace: ${error.message}`);
    }
  }

  /**
   * Clone a single repository into the workspace
   */
  async cloneRepository(repository, workspacePath) {
    const repoDir = path.join(workspacePath, repository.name);
    
    try {
      // Clone repository
      const cloneCommand = `git clone ${repository.githubUrl} ${repoDir}`;
      await execAsync(cloneCommand);
      
      // Checkout specific branch if specified
      if (repository.branch && repository.branch !== 'main' && repository.branch !== 'master') {
        await execAsync(`git checkout ${repository.branch}`, { cwd: repoDir });
      }
      
      // Set up repository metadata
      const repoMetadata = await this.analyzeRepository(repoDir);
      
      return {
        ...repository,
        localPath: repoDir,
        metadata: repoMetadata,
        status: 'ready',
        currentBranch: repository.branch || 'main'
      };
      
    } catch (error) {
      throw new Error(`Failed to clone repository ${repository.name}: ${error.message}`);
    }
  }

  /**
   * Analyze repository structure and dependencies
   */
  async analyzeRepository(repoPath) {
    try {
      const metadata = {
        technologies: [],
        dependencies: {},
        structure: {},
        hasTests: false,
        hasCI: false,
        packageManager: null
      };

      // Check for package.json (Node.js)
      const packageJsonPath = path.join(repoPath, 'package.json');
      if (await this.fileExists(packageJsonPath)) {
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
        metadata.technologies.push('Node.js');
        metadata.dependencies.npm = {
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {}
        };
        metadata.packageManager = 'npm';
        
        // Detect framework
        if (packageJson.dependencies?.react) metadata.technologies.push('React');
        if (packageJson.dependencies?.vue) metadata.technologies.push('Vue.js');
        if (packageJson.dependencies?.angular) metadata.technologies.push('Angular');
        if (packageJson.dependencies?.express) metadata.technologies.push('Express');
        if (packageJson.dependencies?.next) metadata.technologies.push('Next.js');
      }

      // Check for requirements.txt (Python)
      const requirementsPath = path.join(repoPath, 'requirements.txt');
      if (await this.fileExists(requirementsPath)) {
        metadata.technologies.push('Python');
        const requirements = await fs.readFile(requirementsPath, 'utf8');
        metadata.dependencies.pip = requirements.split('\n').filter(line => line.trim());
      }

      // Check for Dockerfile
      const dockerfilePath = path.join(repoPath, 'Dockerfile');
      if (await this.fileExists(dockerfilePath)) {
        metadata.technologies.push('Docker');
      }

      // Check for CI/CD configurations
      const ciPaths = [
        '.github/workflows',
        '.gitlab-ci.yml',
        'jenkins.yml',
        '.travis.yml'
      ];
      
      for (const ciPath of ciPaths) {
        if (await this.fileExists(path.join(repoPath, ciPath))) {
          metadata.hasCI = true;
          break;
        }
      }

      // Analyze directory structure
      metadata.structure = await this.analyzeDirectoryStructure(repoPath);
      
      // Check for test directories
      const testDirs = ['test', 'tests', '__tests__', 'spec'];
      for (const testDir of testDirs) {
        if (await this.fileExists(path.join(repoPath, testDir))) {
          metadata.hasTests = true;
          break;
        }
      }

      return metadata;
      
    } catch (error) {
      console.warn(`Failed to analyze repository ${repoPath}:`, error.message);
      return {
        technologies: ['Unknown'],
        dependencies: {},
        structure: {},
        hasTests: false,
        hasCI: false
      };
    }
  }

  /**
   * Analyze directory structure to understand project layout
   */
  async analyzeDirectoryStructure(repoPath) {
    const structure = {
      type: 'unknown',
      srcDir: null,
      testDir: null,
      configFiles: [],
      hasPublicDir: false,
      hasBuildDir: false
    };

    try {
      const entries = await fs.readdir(repoPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          switch (entry.name) {
            case 'src':
            case 'lib':
              structure.srcDir = entry.name;
              break;
            case 'test':
            case 'tests':
            case '__tests__':
              structure.testDir = entry.name;
              break;
            case 'public':
            case 'static':
              structure.hasPublicDir = true;
              break;
            case 'build':
            case 'dist':
            case 'out':
              structure.hasBuildDir = true;
              break;
          }
        } else {
          // Check for important config files
          if (entry.name.includes('config') || 
              entry.name.includes('.json') ||
              entry.name.includes('.yml') ||
              entry.name.includes('.yaml')) {
            structure.configFiles.push(entry.name);
          }
        }
      }

      // Determine project type based on structure
      if (structure.hasPublicDir && structure.srcDir) {
        structure.type = 'frontend';
      } else if (structure.configFiles.some(f => f.includes('server') || f.includes('api'))) {
        structure.type = 'backend';
      } else if (structure.srcDir) {
        structure.type = 'library';
      }

      return structure;
      
    } catch (error) {
      return structure;
    }
  }

  /**
   * Create feature branches across all repositories
   */
  async createFeatureBranches(workspace, taskId, baseBranch = 'main') {
    const branchName = `feature/task-${taskId}`;
    const results = [];

    for (const repo of workspace.repositories) {
      try {
        // Ensure we're on the base branch
        await execAsync(`git checkout ${baseBranch}`, { cwd: repo.localPath });
        
        // Pull latest changes
        await execAsync('git pull origin HEAD', { cwd: repo.localPath });
        
        // Create and checkout feature branch
        await execAsync(`git checkout -b ${branchName}`, { cwd: repo.localPath });
        
        results.push({
          repository: repo.name,
          success: true,
          branch: branchName,
          baseBranch
        });
        
      } catch (error) {
        results.push({
          repository: repo.name,
          success: false,
          error: error.message,
          branch: branchName
        });
      }
    }

    return {
      branchName,
      results,
      allSuccessful: results.every(r => r.success)
    };
  }

  /**
   * Generate unified diff across all repositories
   */
  async generateUnifiedDiff(workspace, baseBranch = 'main') {
    const allDiffs = [];
    let totalChanges = {
      repositories: 0,
      filesModified: 0,
      linesAdded: 0,
      linesRemoved: 0
    };

    for (const repo of workspace.repositories) {
      try {
        const repoDiff = await this.getRepositoryDiff(repo, baseBranch);
        
        if (repoDiff.hasChanges) {
          allDiffs.push(repoDiff);
          totalChanges.repositories++;
          totalChanges.filesModified += repoDiff.filesModified;
          totalChanges.linesAdded += repoDiff.linesAdded;
          totalChanges.linesRemoved += repoDiff.linesRemoved;
        }
        
      } catch (error) {
        console.warn(`Failed to get diff for ${repo.name}:`, error.message);
      }
    }

    return {
      totalChanges,
      repositoryDiffs: allDiffs,
      hasChanges: allDiffs.length > 0,
      unifiedDiff: this.formatUnifiedDiff(allDiffs)
    };
  }

  /**
   * Get diff for a specific repository
   */
  async getRepositoryDiff(repository, baseBranch = 'main') {
    try {
      // Get diff against base branch
      const { stdout: diff } = await execAsync(
        `git diff ${baseBranch}...HEAD`, 
        { cwd: repository.localPath }
      );

      // Get status of modified files
      const { stdout: status } = await execAsync(
        'git status --porcelain', 
        { cwd: repository.localPath }
      );

      // Parse diff statistics
      const diffStats = this.parseDiffStats(diff);
      
      return {
        repository: repository.name,
        repositoryType: repository.type || 'unknown',
        team: repository.team,
        diff,
        status: this.parseGitStatus(status),
        filesModified: diffStats.filesModified,
        linesAdded: diffStats.linesAdded,
        linesRemoved: diffStats.linesRemoved,
        hasChanges: diff.length > 0,
        changes: this.parseFileChanges(diff)
      };
      
    } catch (error) {
      return {
        repository: repository.name,
        diff: '',
        status: [],
        filesModified: 0,
        linesAdded: 0,
        linesRemoved: 0,
        hasChanges: false,
        error: error.message
      };
    }
  }

  /**
   * Commit and push changes across all repositories
   */
  async commitAndPushChanges(workspace, commitMessage, branchName) {
    const results = [];

    for (const repo of workspace.repositories) {
      try {
        // Check if there are changes to commit
        const { stdout: status } = await execAsync('git status --porcelain', { 
          cwd: repo.localPath 
        });

        if (status.trim()) {
          // Add all changes
          await execAsync('git add .', { cwd: repo.localPath });
          
          // Commit changes
          await execAsync(`git commit -m "${commitMessage}"`, { 
            cwd: repo.localPath 
          });
          
          // Push to remote
          await execAsync(`git push origin ${branchName}`, { 
            cwd: repo.localPath 
          });
          
          results.push({
            repository: repo.name,
            success: true,
            committed: true,
            pushed: true
          });
        } else {
          results.push({
            repository: repo.name,
            success: true,
            committed: false,
            message: 'No changes to commit'
          });
        }
        
      } catch (error) {
        results.push({
          repository: repo.name,
          success: false,
          error: error.message
        });
      }
    }

    return {
      commitMessage,
      branchName,
      results,
      allSuccessful: results.every(r => r.success)
    };
  }

  /**
   * Create pull requests across all repositories
   */
  async createPullRequests(workspace, branchName, title, description, baseBranch = 'main') {
    const pullRequests = [];

    for (const repo of workspace.repositories) {
      try {
        // Check if repository has changes
        const repoDiff = await this.getRepositoryDiff(repo, baseBranch);
        
        if (repoDiff.hasChanges) {
          const prData = await this.githubIntegration.createPullRequest(
            repo.owner,
            repo.name,
            {
              title: `${title} - ${repo.name}`,
              description: `${description}\n\n## Repository: ${repo.name}\n## Changes:\n- ${repoDiff.filesModified} files modified\n- ${repoDiff.linesAdded} lines added\n- ${repoDiff.linesRemoved} lines removed`,
              head: branchName,
              base: baseBranch
            }
          );
          
          pullRequests.push({
            repository: repo.name,
            success: true,
            pullRequest: prData,
            url: prData.html_url,
            number: prData.number
          });
        } else {
          pullRequests.push({
            repository: repo.name,
            success: true,
            pullRequest: null,
            message: 'No changes, PR not created'
          });
        }
        
      } catch (error) {
        pullRequests.push({
          repository: repo.name,
          success: false,
          error: error.message
        });
      }
    }

    return {
      title,
      branchName,
      baseBranch,
      pullRequests,
      totalPRs: pullRequests.filter(pr => pr.pullRequest).length
    };
  }

  /**
   * Setup workspace configuration and shared resources
   */
  async setupWorkspaceConfiguration(workspacePath, repositories) {
    // Create workspace configuration file
    const workspaceConfig = {
      repositories: repositories.map(repo => ({
        name: repo.name,
        type: repo.type,
        team: repo.team,
        localPath: repo.localPath,
        technologies: repo.metadata?.technologies || []
      })),
      createdAt: new Date(),
      sharedResources: {}
    };

    await fs.writeFile(
      path.join(workspacePath, 'workspace.json'),
      JSON.stringify(workspaceConfig, null, 2)
    );

    // Set up shared configuration if needed
    await this.setupSharedConfiguration(workspacePath, repositories);
  }

  /**
   * Setup shared configuration between repositories
   */
  async setupSharedConfiguration(workspacePath, repositories) {
    // Create shared directory for common resources
    const sharedDir = path.join(workspacePath, 'shared');
    await fs.mkdir(sharedDir, { recursive: true });

    // Create shared Claude Code configuration
    const claudeConfig = {
      subagents: {},
      outputStyles: {},
      mcpServers: {},
      hooks: {}
    };

    // Add team-specific configurations
    const teams = [...new Set(repositories.map(repo => repo.team).filter(Boolean))];
    
    for (const team of teams) {
      claudeConfig.subagents[`${team}-developer`] = {
        description: `${team} development team specialist`,
        model: 'claude-3-sonnet-20240229',
        allowedTools: ['read_file', 'write_file', 'execute_bash', 'grep', 'glob']
      };
    }

    await fs.writeFile(
      path.join(sharedDir, 'claude-config.json'),
      JSON.stringify(claudeConfig, null, 2)
    );
  }

  /**
   * Helper methods
   */
  
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  parseGitStatus(status) {
    return status.split('\n')
      .filter(line => line.trim())
      .map(line => ({
        status: line.substring(0, 2),
        file: line.substring(3)
      }));
  }

  parseDiffStats(diff) {
    const lines = diff.split('\n');
    let linesAdded = 0;
    let linesRemoved = 0;
    const filesModified = new Set();

    for (const line of lines) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        const filePath = line.substring(4);
        if (filePath !== '/dev/null') {
          filesModified.add(filePath);
        }
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        linesAdded++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        linesRemoved++;
      }
    }

    return {
      filesModified: filesModified.size,
      linesAdded,
      linesRemoved
    };
  }

  parseFileChanges(diff) {
    const changes = [];
    const lines = diff.split('\n');
    let currentFile = null;
    let currentHunk = null;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile) changes.push(currentFile);
        currentFile = {
          file: line.match(/b\/(.+)$/)?.[1] || 'unknown',
          hunks: []
        };
      } else if (line.startsWith('@@') && currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        currentHunk = {
          header: line,
          lines: []
        };
      } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
        currentHunk.lines.push(line);
      }
    }

    if (currentHunk) currentFile.hunks.push(currentHunk);
    if (currentFile) changes.push(currentFile);

    return changes;
  }

  formatUnifiedDiff(repositoryDiffs) {
    let unifiedDiff = '# Multi-Repository Changes\n\n';
    
    for (const repoDiff of repositoryDiffs) {
      unifiedDiff += `## Repository: ${repoDiff.repository}\n`;
      unifiedDiff += `**Type**: ${repoDiff.repositoryType}\n`;
      unifiedDiff += `**Team**: ${repoDiff.team}\n`;
      unifiedDiff += `**Files Modified**: ${repoDiff.filesModified}\n`;
      unifiedDiff += `**Lines Added**: ${repoDiff.linesAdded}\n`;
      unifiedDiff += `**Lines Removed**: ${repoDiff.linesRemoved}\n\n`;
      unifiedDiff += '```diff\n';
      unifiedDiff += repoDiff.diff;
      unifiedDiff += '\n```\n\n';
    }

    return unifiedDiff;
  }

  async cleanupWorkspace(workspacePath) {
    try {
      await execAsync(`rm -rf "${workspacePath}"`);
    } catch (error) {
      console.warn(`Failed to cleanup workspace ${workspacePath}:`, error.message);
    }
  }
}

module.exports = MultiRepoManager;