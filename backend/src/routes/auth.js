const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { authenticate, rateLimit, auditLog } = require('../middleware/auth');

const router = express.Router();

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user
 * @access  Public
 */
router.post('/register', 
  rateLimit(15 * 60 * 1000, 5), // 5 attempts per 15 minutes
  auditLog('user_registration'),
  async (req, res) => {
    try {
      const {
        username,
        email,
        password,
        profile,
        organization,
        specializations
      } = req.body;

      // Validation
      if (!username || !email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username, email, and password are required.'
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 6 characters long.'
        });
      }

      // Check if user already exists
      const existingUser = await User.findOne({
        $or: [{ email }, { username }]
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'User with this email or username already exists.'
        });
      }

      // Create user with default permissions
      const userData = {
        username,
        email,
        password,
        profile: {
          firstName: profile?.firstName || '',
          lastName: profile?.lastName || '',
          ...profile
        },
        organization: {
          name: organization?.name || '',
          type: organization?.type || 'corporate',
          ...organization
        },
        specializations: specializations || ['fullstack-development'],
        // Set default permissions for development environment
        permissions: {
          projects: {
            create: false,
            read: true,
            update: false,
            delete: false
          },
          tasks: {
            create: true,
            assign: false,
            review: false,
            approve: false
          },
          agents: {
            junior: false,
            senior: false,
            qa: false,
            pm: false
          }
        }
      };

      const user = new User(userData);
      await user.save();

      // Generate access and refresh tokens
      const { accessToken, refreshToken } = await user.generateAuthTokens(
        req.headers['user-agent'],
        req.ip
      );

      res.status(201).json({
        success: true,
        message: 'User registered successfully.',
        data: {
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            specializations: user.specializations,
            organization: user.organization
          },
          accessToken,
          refreshToken
        }
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error during registration.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post('/login',
  rateLimit(15 * 60 * 1000, 10), // 10 attempts per 15 minutes
  auditLog('user_login'),
  async (req, res) => {
    try {
      const { email, password } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          message: 'Email and password are required.'
        });
      }

      // Find user and validate credentials
      const user = await User.findByCredentials(email, password);

      // Check if user needs to verify email
      if (!user.emailVerified && process.env.REQUIRE_EMAIL_VERIFICATION === 'true') {
        return res.status(401).json({
          success: false,
          message: 'Please verify your email before logging in.'
        });
      }

      // Generate access and refresh tokens
      const { accessToken, refreshToken } = await user.generateAuthTokens(
        req.headers['user-agent'],
        req.ip
      );

      res.json({
        success: true,
        message: 'Login successful.',
        data: {
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            fullName: user.fullName,
            specializations: user.specializations,
            organization: user.organization,
            permissions: user.permissions,
            preferences: user.preferences
          },
          accessToken,
          refreshToken
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      
      // Generic error message to prevent user enumeration
      res.status(401).json({
        success: false,
        message: 'Invalid email or password.'
      });
    }
  }
);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user and revoke refresh token
 * @access  Private
 */
router.post('/logout',
  authenticate,
  auditLog('user_logout'),
  async (req, res) => {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        // Revoke the specific refresh token
        await req.user.revokeRefreshToken(refreshToken);
      }

      res.json({
        success: true,
        message: 'Logout successful.'
      });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error during logout.'
      });
    }
  }
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token using refresh token
 * @access  Public
 */
router.post('/refresh',
  rateLimit(15 * 60 * 1000, 20), // 20 attempts per 15 minutes
  async (req, res) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          message: 'Refresh token is required.'
        });
      }

      // Verify refresh token
      let decoded;
      try {
        decoded = jwt.verify(
          refreshToken,
          process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
        );
      } catch (error) {
        return res.status(401).json({
          success: false,
          message: 'Invalid or expired refresh token.'
        });
      }

      // Find user
      const user = await User.findById(decoded.id);

      if (!user || !user.isActive) {
        return res.status(401).json({
          success: false,
          message: 'User not found or inactive.'
        });
      }

      // Validate refresh token in database
      const validation = user.validateRefreshToken(refreshToken);

      if (!validation.valid) {
        return res.status(401).json({
          success: false,
          message: `Invalid refresh token: ${validation.reason}`
        });
      }

      // Generate new access token
      const accessToken = user.generateAccessToken();

      res.json({
        success: true,
        message: 'Token refreshed successfully.',
        data: {
          accessToken
        }
      });
    } catch (error) {
      console.error('Refresh token error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error refreshing token.'
      });
    }
  }
);

/**
 * @route   GET /api/auth/me
 * @desc    Get current user profile
 * @access  Private
 */
router.get('/me',
  authenticate,
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id)
        .select('-password')
        .populate('activity.projectsWorked.project', 'name description');

      res.json({
        success: true,
        data: {
          user: {
            id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            profile: user.profile,
            specializations: user.specializations,
            skills: user.skills,
            organization: user.organization,
            permissions: user.permissions,
            preferences: user.preferences,
            activity: user.activity,
            settings: user.settings,
            emailVerified: user.emailVerified,
            fullName: user.fullName
          }
        }
      });
    } catch (error) {
      console.error('Get profile error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error retrieving profile.'
      });
    }
  }
);

/**
 * @route   PUT /api/auth/profile
 * @desc    Update user profile
 * @access  Private
 */
router.put('/profile',
  authenticate,
  auditLog('profile_update'),
  async (req, res) => {
    try {
      const {
        profile,
        specializations,
        skills,
        preferences,
        settings
      } = req.body;

      const user = await User.findById(req.user._id);

      // Update allowed fields
      if (profile) {
        user.profile = { ...user.profile, ...profile };
      }

      if (specializations && Array.isArray(specializations)) {
        user.specializations = specializations;
      }

      if (skills) {
        user.skills = { ...user.skills, ...skills };
      }

      if (preferences) {
        user.preferences = { ...user.preferences, ...preferences };
      }

      if (settings) {
        user.settings = { ...user.settings, ...settings };
      }

      await user.save();

      res.json({
        success: true,
        message: 'Profile updated successfully.',
        data: {
          user: {
            id: user._id,
            profile: user.profile,
            specializations: user.specializations,
            skills: user.skills,
            preferences: user.preferences,
            settings: user.settings
          }
        }
      });
    } catch (error) {
      console.error('Profile update error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error updating profile.'
      });
    }
  }
);

/**
 * @route   PUT /api/auth/change-password
 * @desc    Change user password
 * @access  Private
 */
router.put('/change-password',
  authenticate,
  rateLimit(15 * 60 * 1000, 3), // 3 attempts per 15 minutes
  auditLog('password_change'),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;

      // Validation
      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: 'Current password and new password are required.'
        });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({
          success: false,
          message: 'New password must be at least 6 characters long.'
        });
      }

      const user = await User.findById(req.user._id);

      // Verify current password
      const isCurrentPasswordValid = await user.comparePassword(currentPassword);
      if (!isCurrentPasswordValid) {
        return res.status(400).json({
          success: false,
          message: 'Current password is incorrect.'
        });
      }

      // Check if new password is different
      const isSamePassword = await user.comparePassword(newPassword);
      if (isSamePassword) {
        return res.status(400).json({
          success: false,
          message: 'New password must be different from current password.'
        });
      }

      // Update password
      user.password = newPassword;
      await user.save();

      res.json({
        success: true,
        message: 'Password changed successfully.'
      });
    } catch (error) {
      console.error('Password change error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error changing password.'
      });
    }
  }
);

/**
 * @route   POST /api/auth/request-permissions
 * @desc    Request additional permissions for educational work
 * @access  Private
 */
router.post('/request-permissions',
  authenticate,
  auditLog('permission_request'),
  async (req, res) => {
    try {
      const { requestedPermissions, justification } = req.body;

      if (!requestedPermissions || !justification) {
        return res.status(400).json({
          success: false,
          message: 'Requested permissions and justification are required.'
        });
      }

      // In a real implementation, this would create a permission request
      // that administrators could approve/deny
      
      // For now, automatically grant basic development permissions
      const user = await User.findById(req.user._id);
      
      // Grant basic development permissions
      if (user.organization.type === 'corporate' || user.organization.type === 'startup') {
        user.permissions.agents.junior = true;
        user.permissions.tasks.assign = true;
        
        await user.save();
      }

      res.json({
        success: true,
        message: 'Permission request processed. Basic development permissions granted.',
        data: {
          permissions: user.permissions
        }
      });
    } catch (error) {
      console.error('Permission request error:', error);
      res.status(500).json({
        success: false,
        message: 'Server error processing permission request.'
      });
    }
  }
);


module.exports = router;