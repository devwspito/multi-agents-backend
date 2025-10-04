const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const UserSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    validate: {
      validator: function(email) {
        return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(email);
      },
      message: 'Please enter a valid email'
    }
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  profile: {
    firstName: {
      type: String,
      required: true,
      trim: true
    },
    lastName: {
      type: String,
      required: true,
      trim: true
    },
    avatar: String,
    title: String,
    bio: String,
    timezone: {
      type: String,
      default: 'UTC'
    }
  },
  // GitHub OAuth Integration (Multi-tenant)
  github: {
    id: String, // GitHub user ID
    username: String, // GitHub username
    accessToken: {
      type: String,
      select: false // Never include in queries by default for security
    },
    refreshToken: {
      type: String,
      select: false
    },
    connectedAt: Date,
    lastSyncAt: Date,
    profile: {
      login: String,
      name: String,
      email: String,
      avatar_url: String,
      bio: String,
      company: String,
      location: String,
      public_repos: Number,
      followers: Number,
      following: Number
    }
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'developer', 'qa', 'viewer'],
    default: 'developer'
  },
  specializations: [{
    type: String,
    enum: [
      'frontend-development',
      'backend-development',
      'fullstack-development',
      'ui-ux-design',
      'qa-testing',
      'devops',
      'product-management',
      'project-management',
      'accessibility',
      'security'
    ]
  }],
  skills: {
    programmingLanguages: [String],
    frameworks: [String],
    tools: [String],
    cloudPlatforms: [{
      platform: {
        type: String,
        enum: ['aws', 'azure', 'gcp', 'digitalocean', 'heroku']
      },
      proficiency: {
        type: String,
        enum: ['beginner', 'intermediate', 'advanced', 'expert']
      }
    }]
  },
  preferences: {
    claudeModel: {
      type: String,
      enum: ['claude-3-haiku', 'claude-3-sonnet', 'claude-3-opus'],
      default: 'claude-3-sonnet'
    },
    autoAssignment: {
      type: Boolean,
      default: true
    },
    notificationSettings: {
      email: {
        type: Boolean,
        default: true
      },
      slack: {
        type: Boolean,
        default: false
      },
      inApp: {
        type: Boolean,
        default: true
      }
    },
    workingHours: {
      timezone: String,
      start: {
        type: String,
        default: '09:00'
      },
      end: {
        type: String,
        default: '17:00'
      },
      daysOfWeek: [{
        type: String,
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      }]
    }
  },
  organization: {
    name: String,
    type: {
      type: String,
      enum: ['startup', 'corporate', 'enterprise', 'agency', 'freelance', 'non-profit']
    },
    role: String,
    department: String
  },
  permissions: {
    projects: {
      create: {
        type: Boolean,
        default: false
      },
      read: {
        type: Boolean,
        default: true
      },
      update: {
        type: Boolean,
        default: false
      },
      delete: {
        type: Boolean,
        default: false
      }
    },
    tasks: {
      create: {
        type: Boolean,
        default: true
      },
      assign: {
        type: Boolean,
        default: false
      },
      review: {
        type: Boolean,
        default: false
      },
      approve: {
        type: Boolean,
        default: false
      }
    },
    agents: {
      junior: {
        type: Boolean,
        default: false
      },
      senior: {
        type: Boolean,
        default: false
      },
      qa: {
        type: Boolean,
        default: false
      },
      pm: {
        type: Boolean,
        default: false
      }
    }
  },
  activity: {
    lastLogin: Date,
    lastActivity: Date,
    loginCount: {
      type: Number,
      default: 0
    },
    projectsWorked: [{
      project: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Project'
      },
      hoursWorked: Number,
      lastActivity: Date
    }],
    tasksCompleted: {
      type: Number,
      default: 0
    },
    codeReviewsGiven: {
      type: Number,
      default: 0
    },
    averageTaskRating: {
      type: Number,
      min: 1,
      max: 5
    }
  },
  settings: {
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'auto'
    },
    language: {
      type: String,
      default: 'en'
    },
    dateFormat: {
      type: String,
      default: 'MM/dd/yyyy'
    },
    timeFormat: {
      type: String,
      enum: ['12h', '24h'],
      default: '12h'
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  lastPasswordChange: Date,
  // Refresh tokens for JWT authentication
  refreshTokens: [{
    token: {
      type: String,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    expiresAt: {
      type: Date,
      required: true
    },
    userAgent: String,
    ipAddress: String
  }]
}, {
  timestamps: true
});

// Indexes for performance (email and username already have unique: true)
UserSchema.index({ role: 1, isActive: 1 });
UserSchema.index({ specializations: 1 });
UserSchema.index({ 'organization.type': 1 });

// Virtual for full name
UserSchema.virtual('fullName').get(function() {
  return `${this.profile.firstName} ${this.profile.lastName}`;
});

// Pre-save middleware to hash password
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.lastPasswordChange = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
UserSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Method to generate access token (short-lived)
UserSchema.methods.generateAccessToken = function() {
  const payload = {
    id: this._id,
    username: this.username,
    email: this.email,
    role: this.role
  };

  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_ACCESS_EXPIRE || '1h'
  });
};

// Method to generate refresh token (long-lived)
UserSchema.methods.generateRefreshToken = function() {
  const payload = {
    id: this._id,
    type: 'refresh'
  };

  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRE || '7d'
  });
};

// Method to generate both tokens
UserSchema.methods.generateAuthTokens = async function(userAgent = '', ipAddress = '') {
  const accessToken = this.generateAccessToken();
  const refreshToken = this.generateRefreshToken();

  // Calculate expiration date (7 days from now by default)
  const expiresAt = new Date();
  const expireDays = parseInt(process.env.JWT_REFRESH_EXPIRE?.replace('d', '')) || 7;
  expiresAt.setDate(expiresAt.getDate() + expireDays);

  // Save refresh token to database
  this.refreshTokens.push({
    token: refreshToken,
    expiresAt,
    userAgent,
    ipAddress
  });

  // Keep only last 5 refresh tokens (security)
  if (this.refreshTokens.length > 5) {
    this.refreshTokens = this.refreshTokens.slice(-5);
  }

  await this.save();

  return { accessToken, refreshToken };
};

// Method to validate refresh token
UserSchema.methods.validateRefreshToken = function(token) {
  const refreshToken = this.refreshTokens.find(rt => rt.token === token);

  if (!refreshToken) {
    return { valid: false, reason: 'Token not found' };
  }

  if (new Date() > refreshToken.expiresAt) {
    return { valid: false, reason: 'Token expired' };
  }

  return { valid: true, refreshToken };
};

// Method to revoke refresh token
UserSchema.methods.revokeRefreshToken = async function(token) {
  this.refreshTokens = this.refreshTokens.filter(rt => rt.token !== token);
  await this.save();
};

// Method to revoke all refresh tokens (logout from all devices)
UserSchema.methods.revokeAllRefreshTokens = async function() {
  this.refreshTokens = [];
  await this.save();
};

// Method to check if user has permission
UserSchema.methods.hasPermission = function(resource, action) {
  if (this.role === 'admin') return true;
  
  const permissions = this.permissions[resource];
  return permissions && permissions[action];
};

// Method to check if user can access agent
UserSchema.methods.canAccessAgent = function(agentType) {
  if (this.role === 'admin') return true;
  
  const agentPermissions = {
    'junior-developer': this.permissions.agents.junior,
    'senior-developer': this.permissions.agents.senior,
    'qa-engineer': this.permissions.agents.qa,
    'product-manager': this.permissions.agents.pm,
    'project-manager': this.permissions.agents.pm
  };
  
  return agentPermissions[agentType] || false;
};

// Method to update activity
UserSchema.methods.updateActivity = async function() {
  this.activity.lastActivity = new Date();
  return this.save();
};

// Static method to find by credentials
UserSchema.statics.findByCredentials = async function(email, password) {
  const user = await this.findOne({ 
    email: email.toLowerCase(),
    isActive: true 
  });
  
  if (!user) {
    throw new Error('Invalid login credentials');
  }
  
  const isMatch = await user.comparePassword(password);
  
  if (!isMatch) {
    throw new Error('Invalid login credentials');
  }
  
  // Update login stats
  user.activity.lastLogin = new Date();
  user.activity.loginCount += 1;
  await user.save();
  
  return user;
};

// Static method to get users by specialization
UserSchema.statics.findBySpecialization = function(specialization) {
  return this.find({
    specializations: specialization,
    isActive: true
  }).select('-password');
};

module.exports = mongoose.model('User', UserSchema);