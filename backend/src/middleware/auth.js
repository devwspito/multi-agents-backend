const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Authentication middleware
 */
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token or user not active.'
      });
    }

    // Update user activity
    await user.updateActivity();
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token.'
    });
  }
};

/**
 * Authorization middleware - check if user has required role
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please authenticate.'
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Insufficient permissions.'
      });
    }

    next();
  };
};

/**
 * Check if user has specific permission
 */
const checkPermission = (resource, action) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please authenticate.'
      });
    }

    if (!req.user.hasPermission(resource, action)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Missing ${resource}:${action} permission.`
      });
    }

    next();
  };
};

/**
 * Check if user can access specific agent type
 */
const checkAgentAccess = (agentType) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please authenticate.'
      });
    }

    if (!req.user.canAccessAgent(agentType)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Cannot access ${agentType} agent.`
      });
    }

    next();
  };
};

/**
 * Educational compliance middleware - ensures user has appropriate access for educational data
 */
const checkEducationalAccess = (complianceType) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please authenticate.'
      });
    }

    const complianceField = `${complianceType}Access`;
    
    if (!req.user.permissions.compliance[complianceField]) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Missing ${complianceType.toUpperCase()} compliance access.`
      });
    }

    next();
  };
};

/**
 * Rate limiting middleware for API endpoints
 */
const rateLimit = (windowMs = 15 * 60 * 1000, max = 100) => {
  const requests = new Map();

  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old requests
    const userRequests = requests.get(key) || [];
    const validRequests = userRequests.filter(timestamp => timestamp > windowStart);

    if (validRequests.length >= max) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil(windowMs / 1000)
      });
    }

    validRequests.push(now);
    requests.set(key, validRequests);
    next();
  };
};

/**
 * Educational data protection middleware
 */
const protectStudentData = (req, res, next) => {
  // Add headers for student data protection
  res.set({
    'X-Educational-Privacy': 'FERPA-Compliant',
    'X-Student-Data-Protection': 'Enabled',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });

  // Log access to educational data
  if (req.user) {
    console.log(`Educational data access: ${req.user.username} - ${req.method} ${req.path} - ${new Date().toISOString()}`);
  }

  next();
};

/**
 * Audit logging middleware for compliance
 */
const auditLog = (action) => {
  return (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function(data) {
      // Log the action after response is sent
      setImmediate(() => {
        try {
          const auditData = {
            timestamp: new Date().toISOString(),
            user: req.user ? {
              id: req.user._id,
              username: req.user.username,
              role: req.user.role
            } : null,
            action,
            method: req.method,
            path: req.path,
            query: req.query,
            ip: req.ip,
            userAgent: req.get('User-Agent'),
            statusCode: res.statusCode,
            success: res.statusCode < 400
          };

          // In production, this should go to a secure audit log system
          console.log('AUDIT LOG:', JSON.stringify(auditData));
        } catch (error) {
          console.error('Audit logging failed:', error);
        }
      });

      originalSend.call(this, data);
    };

    next();
  };
};

/**
 * Validate request body for educational requirements
 */
const validateEducationalData = (req, res, next) => {
  const body = req.body;

  // Check for potential PII in request
  const piiFields = ['ssn', 'social_security', 'student_id', 'email', 'phone', 'address'];
  const suspiciousPII = piiFields.some(field => 
    JSON.stringify(body).toLowerCase().includes(field)
  );

  if (suspiciousPII) {
    console.warn(`Potential PII detected in request from ${req.user?.username} to ${req.path}`);
    // In production, implement additional PII detection and scrubbing
  }

  // Validate educational context if required
  if (body.educationalImpact) {
    if (!body.educationalImpact.learningObjectives || !Array.isArray(body.educationalImpact.learningObjectives)) {
      return res.status(400).json({
        success: false,
        message: 'Educational impact must include learning objectives array.'
      });
    }

    if (!body.educationalImpact.targetAudience) {
      return res.status(400).json({
        success: false,
        message: 'Educational impact must include target audience.'
      });
    }
  }

  next();
};

/**
 * Project access middleware - check if user can access specific project
 */
const checkProjectAccess = async (req, res, next) => {
  try {
    const projectId = req.params.projectId || req.params.id;
    
    if (!projectId) {
      return res.status(400).json({
        success: false,
        message: 'Project ID is required.'
      });
    }

    const Project = require('../models/Project');
    const project = await Project.findById(projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found.'
      });
    }

    // Check if user is project owner or team member
    const isOwner = project.owner.toString() === req.user._id.toString();
    const isTeamMember = project.team.some(member => 
      member.user.toString() === req.user._id.toString()
    );

    if (!isOwner && !isTeamMember && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Not authorized for this project.'
      });
    }

    req.project = project;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error checking project access.',
      error: error.message
    });
  }
};

/**
 * Task access middleware - check if user can access specific task
 */
const checkTaskAccess = async (req, res, next) => {
  try {
    const taskId = req.params.taskId || req.params.id;
    
    if (!taskId) {
      return res.status(400).json({
        success: false,
        message: 'Task ID is required.'
      });
    }

    const Task = require('../models/Task');
    const task = await Task.findById(taskId).populate('project');

    if (!task) {
      return res.status(404).json({
        success: false,
        message: 'Task not found.'
      });
    }

    // Check project access first
    const project = task.project;
    const isOwner = project.owner.toString() === req.user._id.toString();
    const isTeamMember = project.team.some(member => 
      member.user.toString() === req.user._id.toString()
    );
    const isAssigned = task.assignedTo && task.assignedTo.toString() === req.user._id.toString();

    if (!isOwner && !isTeamMember && !isAssigned && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Not authorized for this task.'
      });
    }

    req.task = task;
    next();
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Error checking task access.',
      error: error.message
    });
  }
};

// Helper function to extract token from request
const extractToken = (req) => {
  const authHeader = req.header('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  // Also check for token in cookies (for web applications)
  if (req.cookies && req.cookies.token) {
    return req.cookies.token;
  }
  
  return null;
};

module.exports = {
  authenticate,
  authorize,
  checkPermission,
  checkAgentAccess,
  checkEducationalAccess,
  rateLimit,
  protectStudentData,
  auditLog,
  validateEducationalData,
  checkProjectAccess,
  checkTaskAccess
};