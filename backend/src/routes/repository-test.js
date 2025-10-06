const express = require('express');
const { Octokit } = require('@octokit/rest');
const User = require('../models/User');
const Project = require('../models/Project');
const repositoryService = require('../services/RepositoryService');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * @route   POST /api/repository-test/clone
 * @desc    Test cloning and reading a repository
 * @access  Private
 */
router.post('/clone', authenticate, async (req, res) => {
  try {
    const { projectId, repositoryName } = req.body;

    if (!projectId || !repositoryName) {
      return res.status(400).json({
        success: false,
        message: 'Project ID and repository name are required'
      });
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('🧪 TESTING REPOSITORY CLONE AND READ');
    console.log(`${'='.repeat(80)}`);
    console.log(`📁 Project ID: ${projectId}`);
    console.log(`📦 Repository: ${repositoryName}`);
    console.log(`👤 User: ${req.user.username}`);

    // Get project
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    // Find repository in project
    const repository = project.repositories.find(r => r.name === repositoryName);
    if (!repository) {
      return res.status(404).json({
        success: false,
        message: `Repository ${repositoryName} not found in project`
      });
    }

    // Get user with GitHub token
    const userWithToken = await User.findById(req.user._id).select('+github.accessToken +github.username');
    if (!userWithToken.github?.accessToken) {
      return res.status(401).json({
        success: false,
        message: 'GitHub authentication required'
      });
    }

    console.log(`\n📊 Repository Details:`);
    console.log(`   Name: ${repository.name}`);
    console.log(`   Owner: ${repository.owner || 'unknown'}`);
    console.log(`   URL: ${repository.githubUrl || 'missing'}`);

    // If no GitHub URL, try to get it from GitHub API
    if (!repository.githubUrl) {
      console.log(`\n⚠️ No GitHub URL found, fetching from API...`);

      const octokit = new Octokit({
        auth: userWithToken.github.accessToken
      });

      try {
        // Try with authenticated user as owner
        const { data: repoInfo } = await octokit.rest.repos.get({
          owner: repository.owner || userWithToken.github.username,
          repo: repository.name
        });

        repository.githubUrl = repoInfo.clone_url;
        repository.owner = repoInfo.owner.login;

        // Update project with the URL
        const repoIndex = project.repositories.findIndex(r => r.name === repositoryName);
        project.repositories[repoIndex].githubUrl = repoInfo.clone_url;
        project.repositories[repoIndex].owner = repoInfo.owner.login;
        await project.save();

        console.log(`✅ Updated repository URL: ${repoInfo.clone_url}`);

      } catch (apiError) {
        console.error(`❌ Failed to fetch repository from GitHub:`, apiError.message);
        return res.status(404).json({
          success: false,
          message: `Repository ${repository.name} not found on GitHub for user ${userWithToken.github.username}`
        });
      }
    }

    console.log(`\n🔄 Cloning repository...`);

    // Clone the repository
    const repoPath = await repositoryService.cloneRepository(
      repository.githubUrl,
      userWithToken.github.accessToken,
      projectId,
      repository.name
    );

    console.log(`✅ Repository cloned to: ${repoPath}`);

    // Read repository content
    console.log(`\n📖 Reading repository content...`);
    const content = await repositoryService.readRepositoryContent(repoPath);

    console.log(`\n📊 Repository Analysis:`);
    console.log(`   Total files: ${content.files.length}`);
    console.log(`   Has package.json: ${content.packageJson ? 'Yes' : 'No'}`);
    console.log(`   Has README: ${content.readme ? 'Yes' : 'No'}`);
    console.log(`   Main files: ${content.mainFiles.join(', ') || 'None found'}`);

    // Get languages
    const languages = await repositoryService.getLanguages(
      repository.owner || userWithToken.github.username,
      repository.name,
      userWithToken.github.accessToken
    );

    console.log(`\n💻 Languages:`);
    Object.entries(languages).forEach(([lang, bytes]) => {
      const percentage = (bytes / Object.values(languages).reduce((a, b) => a + b, 0) * 100).toFixed(1);
      console.log(`   ${lang}: ${percentage}%`);
    });

    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ REPOSITORY TEST COMPLETED SUCCESSFULLY');
    console.log(`${'='.repeat(80)}\n`);

    res.json({
      success: true,
      message: 'Repository successfully cloned and analyzed',
      data: {
        repository: {
          name: repository.name,
          owner: repository.owner,
          githubUrl: repository.githubUrl,
          path: repoPath
        },
        analysis: {
          totalFiles: content.files.length,
          hasPackageJson: !!content.packageJson,
          hasReadme: !!content.readme,
          mainFiles: content.mainFiles,
          languages,
          structure: content.structure
        },
        packageJson: content.packageJson,
        sampleFiles: content.files.slice(0, 10)
      }
    });

  } catch (error) {
    console.error(`\n❌ Repository test error:`, error);
    res.status(500).json({
      success: false,
      message: 'Failed to clone/read repository',
      error: error.message
    });
  }
});

/**
 * @route   POST /api/repository-test/read-file
 * @desc    Read a specific file from a cloned repository
 * @access  Private
 */
router.post('/read-file', authenticate, async (req, res) => {
  try {
    const { projectId, repositoryName, filePath } = req.body;

    if (!projectId || !repositoryName || !filePath) {
      return res.status(400).json({
        success: false,
        message: 'Project ID, repository name, and file path are required'
      });
    }

    const repoPath = require('path').join(
      process.cwd(),
      'workspaces',
      `project-${projectId}`,
      repositoryName
    );

    const fileContent = await repositoryService.readFile(repoPath, filePath);

    res.json({
      success: true,
      data: {
        filePath,
        content: fileContent,
        lines: fileContent.split('\n').length
      }
    });

  } catch (error) {
    console.error('Read file error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to read file',
      error: error.message
    });
  }
});

module.exports = router;