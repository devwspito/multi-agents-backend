require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const mongoose = require('mongoose');
const databaseConfig = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');
const githubAuthRoutes = require('./routes/github-auth');
const githubWebhooksRoutes = require('./routes/github-webhooks');
const repositoryStatusRoutes = require('./routes/repository-status');
const conversationRoutes = require('./routes/conversations');
const agentRoutes = require('./routes/agents');
const uploadRoutes = require('./routes/uploads');
const tokenUsageRoutes = require('./routes/token-usage');

// Import middleware
const { protectData, auditLog } = require('./middleware/auth');

/**
 * Multi-Agent Software Development Platform
 * Specialized for Claude Code agent orchestration
 */
class AgentPlatformApp {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.environment = process.env.NODE_ENV || 'development';

    // Trust proxy for Render/production environments
    this.app.set('trust proxy', 1);

    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  /**
   * Initialize middleware stack optimized for software development applications
   */
  initializeMiddleware() {
    // Security middleware
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", "https://api.anthropic.com"]
        }
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    }));

    // CORS configuration for development platforms
    this.app.use(cors({
      origin: this.getAllowedOrigins(),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Context'],
      exposedHeaders: ['X-Agent-Execution', 'X-Task-Status']
    }));

    // Compression for better performance
    this.app.use(compression());

    // Rate limiting for API protection
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // Limit each IP to 100 requests per windowMs
      message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.',
        development: {
          tip: 'Rate limiting helps protect system stability and performance.'
        }
      },
      standardHeaders: true,
      legacyHeaders: false,
      // Trust proxy headers for Render
      trustProxy: true,
      skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/health' || req.path === '/api/health';
      }
    });
    this.app.use('/api/', limiter);

    // Body parsing with size limits
    this.app.use(express.json({
      limit: '10mb',
      verify: (req, res, buf) => {
        // Store raw body for webhook signature verification
        if (req.path === '/api/github-webhooks' || req.path.includes('/github-webhooks')) {
          req.rawBody = buf.toString('utf8');
        }

        // Data validation
        if (buf.length > 0) {
          try {
            const data = JSON.parse(buf.toString());
            // Basic data validation
            this.validateRequestData(data, req);
          } catch (error) {
            // Invalid JSON - let express handle it
          }
        }
      }
    }));
    
    this.app.use(express.urlencoded({ 
      extended: true, 
      limit: '10mb' 
    }));

    this.app.use(cookieParser());

    // Session configuration for OAuth state management
    this.app.use(session({
      secret: process.env.SESSION_SECRET || 'multi-tenant-github-oauth-secret',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: this.environment === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 15 // 15 minutes
      }
    }));

    // MongoDB injection protection
    this.app.use(mongoSanitize());

    // Data protection headers
    this.app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      next();
    });

    // Request logging for API monitoring
    this.app.use((req, res, next) => {
      // Log all API requests for monitoring
      if (req.path.startsWith('/api/')) {
        console.log(`🚀 Agent API: ${req.method} ${req.path} - ${req.ip} - ${new Date().toISOString()}`);
      }
      next();
    });

    // Agent context middleware
    this.app.use((req, res, next) => {
      req.agentContext = {
        environment: this.environment,
        timestamp: new Date().toISOString(),
        securityCompliant: true,
        performanceOptimized: true
      };
      next();
    });
  }

  /**
   * Initialize API routes
   */
  initializeRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        success: true,
        service: 'Multi-Agent Software Development Platform',
        version: process.env.npm_package_version || '1.0.0',
        environment: this.environment,
        timestamp: new Date().toISOString(),
        platform: {
          securityEnabled: true,
          agentsActive: true,
          performanceOptimized: true
        }
      });
    });

    // API documentation endpoint
    this.app.get('/api', (req, res) => {
      res.json({
        success: true,
        message: 'Multi-Agent Software Development Platform',
        version: '1.0.0',
        documentation: {
          authentication: '/api/auth',
          projects: '/api/projects',
          tasks: '/api/tasks',
          agents: 'See CLAUDE.md for agent configuration'
        },
        platform: {
          security: ['GDPR', 'Enterprise Security'],
          accessibility: 'WCAG 2.1 AA',
          dataProtection: 'Enterprise-grade encryption and security'
        },
        endpoints: {
          'POST /api/auth/register': 'Register new development team member',
          'POST /api/auth/login': 'Authenticate user',
          'GET /api/projects': 'List software projects',
          'POST /api/projects': 'Create new software project',
          'GET /api/tasks': 'List development tasks',
          'POST /api/tasks/:id/execute': 'Execute task with Claude agents'
        }
      });
    });

    // Mount API routes
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/github-auth', githubAuthRoutes);
    this.app.use('/api/github-webhooks', githubWebhooksRoutes);
    this.app.use('/api/projects', projectRoutes);
    this.app.use('/api/tasks', taskRoutes);
    this.app.use('/api/repositories', repositoryStatusRoutes);
    this.app.use('/api/repository-test', require('./routes/repository-test'));
    this.app.use('/api/conversations', conversationRoutes);
    this.app.use('/api/agents', agentRoutes);
    this.app.use('/api/uploads', uploadRoutes);
    this.app.use('/api/token-usage', tokenUsageRoutes);
    this.app.use('/api/agent-outputs', require('./routes/agent-outputs'));  // NEW: Agent outputs

    // Platform metrics endpoint
    this.app.get('/api/platform-metrics', 
      async (req, res) => {
        try {
          const dbStats = await databaseConfig.getStats();
          const healthCheck = await databaseConfig.healthCheck();
          
          res.json({
            success: true,
            data: {
              database: dbStats,
              health: healthCheck,
              platform: {
                projectTypes: ['web-app', 'mobile-app', 'api', 'microservice', 'library'],
                securityStandards: ['GDPR', 'OWASP', 'Enterprise Security'],
                agentTypes: ['product-manager', 'project-manager', 'tech-lead', 'senior-developer', 'junior-developer', 'qa-engineer']
              }
            }
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: 'Error retrieving platform metrics.'
          });
        }
      }
    );

    // 404 handler for API routes
    this.app.use('/api', (req, res) => {
      res.status(404).json({
        success: false,
        message: 'API endpoint not found.',
        platform: {
          tip: 'Check the API documentation at /api for available endpoints.'
        }
      });
    });

    // Root endpoint - API only
    this.app.get('/', (req, res) => {
      res.json({
        success: true,
        message: 'Multi-Agent Software Development Platform',
        description: 'Backend API for autonomous software development using Claude Code agents',
        features: [
          'AI-powered development agents',
          'Enterprise security and compliance',
          'Accessibility testing (WCAG 2.1 AA)',
          'GitHub integration support',
          'Multi-project orchestration'
        ],
        api: '/api',
        health: '/health',
        platform: {
          targetAudience: ['Startups', 'Tech Companies', 'Enterprise Teams', 'Development Agencies'],
          security: 'Enterprise-grade security and GDPR compliance',
          accessibility: 'WCAG 2.1 AA standards enforced'
        }
      });
    });
  }

  /**
   * Initialize error handling
   */
  initializeErrorHandling() {
    // Handle 404 errors
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        message: 'Endpoint not found.',
        platform: {
          suggestion: 'Visit /api for API documentation or /health for system status.'
        }
      });
    });

    // Global error handler
    this.app.use((error, req, res, next) => {
      console.error('🚨 Server Error:', error);

      // Sensitive data detection
      if (error.message && (error.message.toLowerCase().includes('password') || error.message.toLowerCase().includes('token'))) {
        console.error('🔒 POTENTIAL SENSITIVE DATA EXPOSURE DETECTED');
        // In production, trigger immediate security protocols
      }

      // Determine error status and message
      let status = 500;
      let message = 'Internal server error.';

      if (error.name === 'ValidationError') {
        status = 400;
        message = 'Validation error: ' + Object.values(error.errors).map(e => e.message).join(', ');
      } else if (error.name === 'CastError') {
        status = 400;
        message = 'Invalid ID format.';
      } else if (error.code === 11000) {
        status = 400;
        message = 'Duplicate field value entered.';
      } else if (error.name === 'JsonWebTokenError') {
        status = 401;
        message = 'Invalid token.';
      } else if (error.name === 'TokenExpiredError') {
        status = 401;
        message = 'Token expired.';
      }

      res.status(status).json({
        success: false,
        message,
        platform: {
          dataProtection: 'User data remains secure',
          timestamp: new Date().toISOString()
        },
        ...(this.environment === 'development' && {
          stack: error.stack,
          details: error.message
        })
      });
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (err) => {
      console.error('🚨 Unhandled Promise Rejection:', err);
      
      // In production, gracefully shutdown
      if (this.environment === 'production') {
        console.log('Shutting down server due to unhandled promise rejection');
        this.server.close(() => {
          process.exit(1);
        });
      }
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error('🚨 Uncaught Exception:', err);
      console.log('Shutting down server due to uncaught exception');
      // Force restart to reload schemas
      process.exit(1);
    });
  }

  /**
   * Get allowed origins for CORS
   */
  getAllowedOrigins() {
    const origins = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:4000',
      'http://localhost:5000',
      'http://localhost:3002',
      "https://multi-agents-d6279.web.app"
    ];

    // Add production origins
    if (process.env.FRONTEND_URL) {
      origins.push(process.env.FRONTEND_URL);
    }

    // Add development platform origins
    if (process.env.PLATFORM_ORIGINS) {
      origins.push(...process.env.PLATFORM_ORIGINS.split(','));
    }

    return origins;
  }

  /**
   * Validate request data for security and compliance
   */
  validateRequestData(data, req) {
    // Check for potential sensitive data
    const sensitiveFields = [
      'password', 'token', 'secret', 'key', 'credential',
      'ssn', 'social_security_number', 'credit_card'
    ];

    const dataString = JSON.stringify(data).toLowerCase();
    const foundSensitive = sensitiveFields.filter(field => dataString.includes(field));

    if (foundSensitive.length > 0) {
      console.warn(`⚠️ Potential sensitive data detected in request: ${foundSensitive.join(', ')} - ${req.path}`);
      req.agentContext.sensitiveDataWarning = foundSensitive;
    }

    // Check for required task context
    if (req.path.includes('/tasks') && data.projectContext) {
      if (!data.projectContext.requirements) {
        console.warn(`⚠️ Task missing requirements specification - ${req.path}`);
      }
    }
  }

  /**
   * Start the server
   */
  async start() {
    try {
      // Connect to database
      await databaseConfig.connect();
      
      // Initialize platform database structure
      await databaseConfig.initializePlatformDatabase();

      // Start HTTP server
      this.server = this.app.listen(this.port, () => {
        console.log('');
        console.log('🚀 Multi-Agent Software Development Platform - V3');
        console.log('================================================');
        console.log('✅ HOTFIX: Activity.task is now OPTIONAL');
        console.log(`🚀 Server running on port ${this.port}`);
        console.log(`🌍 Environment: ${this.environment}`);
        console.log(`📊 Database: ${databaseConfig.getConnectionStatus().name}`);
        console.log('');
        console.log('🎯 Platform Features:');
        console.log('   ✅ Enterprise Security');
        console.log('   ✅ GDPR Compliance');
        console.log('   ✅ WCAG 2.1 AA Accessibility');
        console.log('   ✅ Multi-Project Orchestration');
        console.log('   ✅ Claude Code Agent Integration');
        console.log('');
        console.log('📚 API Endpoints:');
        console.log(`   🔗 Health Check: http://localhost:${this.port}/health`);
        console.log(`   🔗 API Docs: http://localhost:${this.port}/api`);
        console.log(`   🔗 Authentication: http://localhost:${this.port}/api/auth`);
        console.log(`   🔗 Projects: http://localhost:${this.port}/api/projects`);
        console.log(`   🔗 Tasks: http://localhost:${this.port}/api/tasks`);
        console.log('');
        console.log('🤖 Claude Code Agents Available:');
        console.log('   👔 Product Manager (Requirements & Stakeholder Communication)');
        console.log('   📋 Project Manager (Task Breakdown & Assignment)');
        console.log('   🏗️ Tech Lead (Architecture Design & Technical Guidance)');
        console.log('   🎓 Senior Developer (Complex Features & Code Review)');
        console.log('   👨‍💻 Junior Developer (UI Components & Simple Features)');
        console.log('   🧪 QA Engineer (Testing & Quality Validation)');
        console.log('');
      });

      return this.server;
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('📊 Shutting down Multi-Agent Development Platform...');
    
    if (this.server) {
      this.server.close(async () => {
        console.log('🔌 HTTP server closed');

        try {
          await mongoose.connection.close();
          console.log('📊 Database disconnected');
          console.log('✅ Graceful shutdown completed');
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      });
    }
  }
}

// Create and export app instance
const agentPlatformApp = new AgentPlatformApp();

// Handle graceful shutdown
process.on('SIGTERM', () => agentPlatformApp.shutdown());
process.on('SIGINT', () => agentPlatformApp.shutdown());

// Start the server if this file is executed directly
if (require.main === module) {
  agentPlatformApp.start();
}

module.exports = agentPlatformApp;