const express = require('express');
const { Octokit } = require('@octokit/rest');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Multi-tenant GitHub OAuth Routes
 * Each user connects their own GitHub account
 */

/**
 * @route   GET /api/github-auth/url
 * @desc    Get GitHub OAuth authorization URL
 * @access  Private (requires user to be logged in)
 */
router.get('/url', authenticate, async (req, res) => {
  try {
    console.log('✅ GitHub OAuth URL request authenticated for user:', req.user.username);

    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = `${process.env.BASE_URL}/api/github-auth/callback`;

    if (!clientId) {
      console.error('❌ GitHub OAuth not configured - missing GITHUB_CLIENT_ID');
      return res.status(500).json({
        success: false,
        message: 'GitHub OAuth not configured'
      });
    }

    // Generate state parameter for security (CSRF protection)
    const state = `${req.user.id}-${Date.now()}-${Math.random().toString(36).substring(2)}`;
    
    // Store state in session or database for verification
    req.session.githubAuthState = state;

    const scopes = [
      'repo',          // Access to repositories
      'read:user',     // Read user profile
      'user:email'     // Read user email
    ].join(' ');

    const authUrl = `https://github.com/login/oauth/authorize?` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `state=${state}`;

    res.json({
      success: true,
      data: {
        authUrl,
        state
      }
    });
  } catch (error) {
    console.error('Error generating GitHub auth URL:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating GitHub authorization URL'
    });
  }
});

/**
 * @route   GET /api/github-auth/callback
 * @desc    Handle GitHub OAuth callback
 * @access  Public (but validates state)
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=oauth_denied`);
    }

    // Verify state parameter (CSRF protection)
    if (!state || !req.session.githubAuthState || state !== req.session.githubAuthState) {
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=invalid_state`);
    }

    // Extract user ID from state
    const userId = state.split('-')[0];
    
    // Exchange code for access token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code: code
      })
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('GitHub OAuth error:', tokenData);
      return res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=oauth_failed`);
    }

    // Get user's GitHub profile
    const octokit = new Octokit({
      auth: tokenData.access_token
    });

    const { data: githubUser } = await octokit.rest.users.getAuthenticated();

    // Update user with GitHub connection
    const user = await User.findByIdAndUpdate(userId, {
      'github.id': githubUser.id.toString(),
      'github.username': githubUser.login,
      'github.accessToken': tokenData.access_token,
      'github.refreshToken': tokenData.refresh_token,
      'github.connectedAt': new Date(),
      'github.lastSyncAt': new Date(),
      'github.profile': {
        login: githubUser.login,
        name: githubUser.name,
        email: githubUser.email,
        avatar_url: githubUser.avatar_url,
        bio: githubUser.bio,
        company: githubUser.company,
        location: githubUser.location,
        public_repos: githubUser.public_repos,
        followers: githubUser.followers,
        following: githubUser.following
      }
    }, { new: true }).select('-github.accessToken -github.refreshToken');

    // Clear the state from session
    delete req.session.githubAuthState;

    res.redirect(`${process.env.FRONTEND_URL}/dashboard?github=connected`);
  } catch (error) {
    console.error('Error in GitHub OAuth callback:', error);
    res.redirect(`${process.env.FRONTEND_URL}/dashboard?error=oauth_error`);
  }
});

/**
 * @route   DELETE /api/github-auth/disconnect
 * @desc    Disconnect user's GitHub account
 * @access  Private
 */
router.delete('/disconnect', authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, {
      $unset: {
        'github.id': 1,
        'github.username': 1,
        'github.accessToken': 1,
        'github.refreshToken': 1,
        'github.connectedAt': 1,
        'github.lastSyncAt': 1,
        'github.profile': 1
      }
    });

    res.json({
      success: true,
      message: 'GitHub account disconnected successfully'
    });
  } catch (error) {
    console.error('Error disconnecting GitHub:', error);
    res.status(500).json({
      success: false,
      message: 'Error disconnecting GitHub account'
    });
  }
});

/**
 * @route   GET /api/github-auth/status
 * @desc    Get user's GitHub connection status
 * @access  Private
 */
router.get('/status', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('github');
    
    const isConnected = !!(user.github && user.github.id);
    
    res.json({
      success: true,
      data: {
        connected: isConnected,
        github: isConnected ? {
          username: user.github.username,
          profile: user.github.profile,
          connectedAt: user.github.connectedAt,
          lastSyncAt: user.github.lastSyncAt
        } : null
      }
    });
  } catch (error) {
    console.error('Error getting GitHub status:', error);
    res.status(500).json({
      success: false,
      message: 'Error getting GitHub connection status'
    });
  }
});

/**
 * @route   GET /api/github-auth/repositories
 * @desc    Get user's GitHub repositories
 * @access  Private
 */
router.get('/repositories', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('+github.accessToken');
    
    if (!user.github || !user.github.accessToken) {
      return res.status(400).json({
        success: false,
        message: 'GitHub account not connected'
      });
    }

    const octokit = new Octokit({
      auth: user.github.accessToken
    });

    const { data: repositories } = await octokit.rest.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 100
    });

    res.json({
      success: true,
      data: {
        repositories: repositories.map(repo => ({
          id: repo.id,
          name: repo.name,
          full_name: repo.full_name,
          description: repo.description,
          private: repo.private,
          html_url: repo.html_url,
          clone_url: repo.clone_url,
          ssh_url: repo.ssh_url,
          default_branch: repo.default_branch,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          language: repo.language,
          stargazers_count: repo.stargazers_count,
          forks_count: repo.forks_count
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching repositories:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching GitHub repositories'
    });
  }
});

module.exports = router;