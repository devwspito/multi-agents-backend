const User = require('../models/User');

/**
 * Middleware to ensure user has GitHub connected
 */
const requireGitHubConnection = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('+github.accessToken');
    
    if (!user.github || !user.github.accessToken) {
      return res.status(400).json({
        success: false,
        message: 'GitHub account connection required',
        code: 'GITHUB_NOT_CONNECTED',
        data: {
          connectUrl: '/api/github-auth/url'
        }
      });
    }

    // Add GitHub token to request for use in services
    req.githubToken = user.github.accessToken;
    req.githubUser = user.github;
    
    next();
  } catch (error) {
    console.error('Error checking GitHub connection:', error);
    res.status(500).json({
      success: false,
      message: 'Error verifying GitHub connection'
    });
  }
};

/**
 * Get user's GitHub token (for services)
 */
const getUserGitHubToken = async (userId) => {
  try {
    const user = await User.findById(userId).select('+github.accessToken');
    
    if (!user.github || !user.github.accessToken) {
      throw new Error('User does not have GitHub connected');
    }
    
    return user.github.accessToken;
  } catch (error) {
    throw new Error(`Error getting user GitHub token: ${error.message}`);
  }
};

/**
 * Check if user has GitHub connected (boolean)
 */
const hasGitHubConnection = async (userId) => {
  try {
    const user = await User.findById(userId).select('github');
    return !!(user.github && user.github.id);
  } catch (error) {
    return false;
  }
};

module.exports = {
  requireGitHubConnection,
  getUserGitHubToken,
  hasGitHubConnection
};