const express = require('express');
const { Octokit } = require('@octokit/rest');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OAuthState = require('../models/OAuthState');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/**
 * Multi-tenant GitHub OAuth Routes
 * Each user connects their own GitHub account
 */

/**
 * @route   GET /api/github-auth/url
 * @desc    Get GitHub OAuth authorization URL
 * @access  Public (anyone can start OAuth flow)
 */
router.get('/url', async (req, res) => {
  try {
    console.log('🔓 GitHub OAuth URL request (public access)');

    const clientId = process.env.GITHUB_CLIENT_ID;
    const redirectUri = `${process.env.BASE_URL}/api/github-auth/callback`;

    if (!clientId) {
      console.error('❌ GitHub OAuth not configured - missing GITHUB_CLIENT_ID');
      return res.status(500).json({
        success: false,
        message: 'GitHub OAuth not configured'
      });
    }

    // Generate random state parameter for security (CSRF protection)
    const state = `gh-${Date.now()}-${Math.random().toString(36).substring(2)}`;

    // Store state in database for verification in callback (TTL: 10 minutes)
    await OAuthState.create({ state });
    console.log('💾 OAuth state saved to database');

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

    console.log('✅ GitHub OAuth URL generated successfully');

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

    console.log('📥 GitHub OAuth callback received');

    if (!code) {
      console.error('❌ No code provided in callback');
      return res.redirect(`${process.env.FRONTEND_URL}/?error=oauth_denied`);
    }

    // Verify state parameter (CSRF protection)
    if (!state) {
      console.error('❌ No state parameter provided');
      return res.redirect(`${process.env.FRONTEND_URL}/?error=invalid_state`);
    }

    // Check if state exists in database
    const storedState = await OAuthState.findOne({ state });
    if (!storedState) {
      console.error('❌ Invalid state parameter - not found in database or expired');
      return res.redirect(`${process.env.FRONTEND_URL}/?error=invalid_state`);
    }

    console.log('✅ State verified successfully');

    // Delete state from database (one-time use)
    await OAuthState.deleteOne({ state });

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
      console.error('❌ GitHub OAuth error:', tokenData);
      return res.redirect(`${process.env.FRONTEND_URL}/?error=oauth_failed`);
    }

    console.log('✅ GitHub access token obtained');

    // Get user's GitHub profile
    const octokit = new Octokit({
      auth: tokenData.access_token
    });

    const { data: githubUser } = await octokit.rest.users.getAuthenticated();
    console.log('✅ GitHub user profile fetched:', githubUser.login);

    // Get user's primary email
    const { data: emails } = await octokit.rest.users.listEmailsForAuthenticatedUser();
    const primaryEmail = emails.find(email => email.primary)?.email || githubUser.email;

    // Check if user already exists with this GitHub ID
    let user = await User.findOne({ 'github.id': githubUser.id.toString() });

    if (user) {
      // User exists - update their GitHub info
      console.log('✅ Existing user found, updating GitHub info');
      user.github = {
        id: githubUser.id.toString(),
        username: githubUser.login,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        connectedAt: user.github.connectedAt || new Date(),
        lastSyncAt: new Date(),
        profile: {
          login: githubUser.login,
          name: githubUser.name,
          email: primaryEmail,
          avatar_url: githubUser.avatar_url,
          bio: githubUser.bio,
          company: githubUser.company,
          location: githubUser.location,
          public_repos: githubUser.public_repos,
          followers: githubUser.followers,
          following: githubUser.following
        }
      };
      await user.save();
    } else {
      // User doesn't exist - create new user
      console.log('🆕 Creating new user from GitHub account');

      // Parse GitHub name into firstName and lastName
      let firstName = githubUser.login; // Default to username
      let lastName = '';

      if (githubUser.name) {
        const nameParts = githubUser.name.trim().split(' ');
        if (nameParts.length > 0) {
          firstName = nameParts[0];
          lastName = nameParts.slice(1).join(' ') || 'User';
        }
      } else {
        firstName = githubUser.login;
        lastName = 'User';
      }

      user = new User({
        username: githubUser.login,
        email: primaryEmail,
        password: Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2), // Random password
        role: 'developer',
        isActive: true,
        profile: {
          firstName: firstName,
          lastName: lastName,
          avatar: githubUser.avatar_url,
          bio: githubUser.bio || ''
        },
        permissions: {
          projects: {
            create: true,
            read: true,
            update: true,
            delete: true
          },
          tasks: {
            create: true,
            assign: true,
            review: true,
            approve: true
          },
          agents: {
            junior: true,
            senior: true,
            qa: true,
            pm: true
          }
        },
        github: {
          id: githubUser.id.toString(),
          username: githubUser.login,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          connectedAt: new Date(),
          lastSyncAt: new Date(),
          profile: {
            login: githubUser.login,
            name: githubUser.name,
            email: primaryEmail,
            avatar_url: githubUser.avatar_url,
            bio: githubUser.bio,
            company: githubUser.company,
            location: githubUser.location,
            public_repos: githubUser.public_repos,
            followers: githubUser.followers,
            following: githubUser.following
          }
        }
      });
      await user.save();
      console.log('✅ New user created successfully');
    }

    // Generate JWT token
    const jwtToken = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('✅ JWT token generated for user:', user.username);

    // Redirect to frontend with token
    res.redirect(`${process.env.FRONTEND_URL}/?token=${jwtToken}&github=connected`);
  } catch (error) {
    console.error('❌ Error in GitHub OAuth callback:', error);
    res.redirect(`${process.env.FRONTEND_URL}/?error=oauth_error`);
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
        repositories: repositories.map(repo => {
          // GARANTIZAR que siempre tengamos las URLs
          const full_name = repo.full_name || `${repo.owner?.login || 'unknown'}/${repo.name}`;
          const clone_url = repo.clone_url || `https://github.com/${full_name}`;
          const ssh_url = repo.ssh_url || `git@github.com:${full_name}.git`;
          const html_url = repo.html_url || `https://github.com/${full_name}`;

          return {
            id: repo.id,
            name: repo.name,
            full_name: full_name,
            description: repo.description,
            private: repo.private,
            html_url: html_url,
            clone_url: clone_url,
            ssh_url: ssh_url,
            default_branch: repo.default_branch || 'main',
            created_at: repo.created_at,
            updated_at: repo.updated_at,
            language: repo.language,
            stargazers_count: repo.stargazers_count,
            forks_count: repo.forks_count,
            owner: repo.owner?.login || full_name.split('/')[0]
          };
        })
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

/**
 * @route   POST /api/github-auth/fix-permissions
 * @desc    Fix permissions for existing GitHub OAuth users (temporary endpoint)
 * @access  Private
 */
router.post('/fix-permissions', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update permissions to full access
    user.permissions = {
      projects: {
        create: true,
        read: true,
        update: true,
        delete: true
      },
      tasks: {
        create: true,
        assign: true,
        review: true,
        approve: true
      },
      agents: {
        junior: true,
        senior: true,
        qa: true,
        pm: true
      }
    };

    await user.save();

    console.log('✅ Permissions fixed for user:', user.username);

    // Generate new JWT token with updated permissions
    const newToken = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      message: 'Permissions updated successfully. Please use the new token.',
      data: {
        permissions: user.permissions,
        token: newToken,
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      }
    });
  } catch (error) {
    console.error('Error fixing permissions:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating permissions'
    });
  }
});

module.exports = router;