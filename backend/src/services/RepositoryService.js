const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { Octokit } = require('@octokit/rest');

const execAsync = promisify(exec);

class RepositoryService {
  constructor() {
    this.workspacesDir = path.resolve(process.cwd(), 'workspaces');
  }

  /**
   * Clone a repository using GitHub access token
   */
  async cloneRepository(githubUrl, accessToken, projectId, repoName) {
    try {
      console.log(`📦 Cloning repository: ${repoName}`);

      // Create project workspace
      const projectDir = path.join(this.workspacesDir, `project-${projectId}`);
      await fs.mkdir(projectDir, { recursive: true });

      // Parse GitHub URL to get owner and repo
      const urlMatch = githubUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!urlMatch) {
        throw new Error(`Invalid GitHub URL: ${githubUrl}`);
      }

      const [, owner, repo] = urlMatch;
      const repoDir = path.join(projectDir, repoName);

      // Check if already cloned
      try {
        await fs.access(path.join(repoDir, '.git'));
        console.log(`✅ Repository already cloned: ${repoName}`);

        // Pull latest changes
        await execAsync('git pull', { cwd: repoDir });
        return repoDir;
      } catch {
        // Not cloned yet, proceed with cloning
      }

      // Clone using HTTPS with access token
      const authUrl = `https://${accessToken}@github.com/${owner}/${repo}.git`;

      const cloneCommand = `git clone ${authUrl} ${repoName}`;
      console.log(`🔧 Cloning from: github.com/${owner}/${repo}`);

      await execAsync(cloneCommand, {
        cwd: projectDir,
        timeout: 60000 // 60 second timeout
      });

      console.log(`✅ Successfully cloned: ${repoName}`);
      return repoDir;

    } catch (error) {
      console.error(`❌ Failed to clone repository ${repoName}:`, error.message);
      throw error;
    }
  }

  /**
   * Read repository content and structure
   */
  async readRepositoryContent(repoPath) {
    try {
      const content = {
        files: [],
        structure: {},
        readme: null,
        packageJson: null,
        mainFiles: []
      };

      // Get all files
      const { stdout } = await execAsync('find . -type f -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.java" -o -name "*.json" -o -name "*.md" | head -100', {
        cwd: repoPath
      });

      content.files = stdout.split('\n').filter(Boolean).map(f => f.replace('./', ''));

      // Read package.json if exists
      try {
        const packageJsonPath = path.join(repoPath, 'package.json');
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
        content.packageJson = JSON.parse(packageJsonContent);
      } catch {
        // No package.json
      }

      // Read README if exists
      try {
        const readmePaths = ['README.md', 'readme.md', 'README.MD'];
        for (const readmePath of readmePaths) {
          try {
            const fullPath = path.join(repoPath, readmePath);
            content.readme = await fs.readFile(fullPath, 'utf8');
            break;
          } catch {
            // Try next
          }
        }
      } catch {
        // No README
      }

      // Identify main files
      const mainFilePatterns = ['index.js', 'app.js', 'main.js', 'server.js', 'index.ts', 'app.ts', 'main.ts', 'server.ts'];
      for (const pattern of mainFilePatterns) {
        if (content.files.includes(pattern)) {
          content.mainFiles.push(pattern);
        }
        // Also check in src/
        if (content.files.includes(`src/${pattern}`)) {
          content.mainFiles.push(`src/${pattern}`);
        }
      }

      // Build directory structure
      content.structure = await this.buildDirectoryTree(repoPath);

      return content;

    } catch (error) {
      console.error(`❌ Failed to read repository content:`, error.message);
      throw error;
    }
  }

  /**
   * Build directory tree structure
   */
  async buildDirectoryTree(dirPath, level = 0, maxLevel = 3) {
    if (level > maxLevel) return {};

    const tree = {};

    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        // Skip hidden files and common ignore patterns
        if (item.name.startsWith('.') ||
            item.name === 'node_modules' ||
            item.name === '__pycache__' ||
            item.name === 'dist' ||
            item.name === 'build') {
          continue;
        }

        if (item.isDirectory()) {
          tree[item.name] = await this.buildDirectoryTree(
            path.join(dirPath, item.name),
            level + 1,
            maxLevel
          );
        } else {
          tree[item.name] = 'file';
        }
      }
    } catch (error) {
      console.error(`Error reading directory ${dirPath}:`, error.message);
    }

    return tree;
  }

  /**
   * Get repository info from GitHub API
   */
  async getRepositoryInfo(owner, repo, accessToken) {
    try {
      const octokit = new Octokit({
        auth: accessToken
      });

      const { data } = await octokit.rest.repos.get({
        owner,
        repo
      });

      return {
        name: data.name,
        full_name: data.full_name,
        description: data.description,
        clone_url: data.clone_url,
        ssh_url: data.ssh_url,
        html_url: data.html_url,
        default_branch: data.default_branch,
        language: data.language,
        languages_url: data.languages_url,
        stargazers_count: data.stargazers_count,
        forks_count: data.forks_count,
        open_issues_count: data.open_issues_count,
        size: data.size,
        created_at: data.created_at,
        updated_at: data.updated_at,
        topics: data.topics
      };

    } catch (error) {
      console.error(`❌ Failed to get repository info:`, error.message);
      throw error;
    }
  }

  /**
   * Read specific file from repository
   */
  async readFile(repoPath, filePath) {
    try {
      const fullPath = path.join(repoPath, filePath);
      const content = await fs.readFile(fullPath, 'utf8');
      return content;
    } catch (error) {
      console.error(`❌ Failed to read file ${filePath}:`, error.message);
      throw error;
    }
  }

  /**
   * Get repository languages
   */
  async getLanguages(owner, repo, accessToken) {
    try {
      const octokit = new Octokit({
        auth: accessToken
      });

      const { data } = await octokit.rest.repos.listLanguages({
        owner,
        repo
      });

      return data;
    } catch (error) {
      console.error(`❌ Failed to get repository languages:`, error.message);
      throw error;
    }
  }
}

module.exports = new RepositoryService();