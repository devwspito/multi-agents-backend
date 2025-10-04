const express = require('express');
const { getInstance: getGitHubService } = require('../services/GitHubService');

const router = express.Router();
const githubService = getGitHubService();

/**
 * Get status of all repositories (admin dashboard)
 */
router.get('/all', async (req, res) => {
  try {
    const repositoriesStatus = githubService.getAllRepositoriesStatus();
    
    res.json({
      success: true,
      data: {
        repositories: repositoriesStatus,
        summary: {
          totalRepositories: repositoriesStatus.length,
          activeRepositories: repositoriesStatus.filter(repo => repo.activeBranches.length > 0).length,
          queuedTasks: repositoriesStatus.reduce((sum, repo) => sum + repo.queuedTasks, 0),
          activeAgents: repositoriesStatus.reduce((sum, repo) => sum + repo.activeAgents.length, 0)
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get repositories status',
      error: error.message
    });
  }
});

/**
 * Get status of specific repository
 */
router.get('/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const status = githubService.getRepositoryStatus(owner, repo);
    
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get repository status',
      error: error.message
    });
  }
});

/**
 * Force release a branch (admin function)
 */
router.post('/force-release/:branchName', async (req, res) => {
  try {
    const { branchName } = req.params;
    const { reason } = req.body;
    
    await githubService.forceReleaseBranch(branchName, reason || 'Manual admin release');
    
    res.json({
      success: true,
      message: `Branch ${branchName} released successfully`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to release branch',
      error: error.message
    });
  }
});

/**
 * Emergency cleanup - release stale locks
 */
router.post('/emergency-cleanup', async (req, res) => {
  try {
    const { olderThanMinutes = 30 } = req.body;
    const releasedCount = await githubService.branchManager.emergencyCleanup(olderThanMinutes);
    
    res.json({
      success: true,
      message: `Emergency cleanup completed. Released ${releasedCount} stale locks.`,
      data: {
        releasedLocks: releasedCount,
        olderThanMinutes
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Emergency cleanup failed',
      error: error.message
    });
  }
});

module.exports = router;