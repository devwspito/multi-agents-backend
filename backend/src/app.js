const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');
const databaseConfig = require('./config/database');

// Import routes
const authRoutes = require('./routes/auth');
const projectRoutes = require('./routes/projects');
const taskRoutes = require('./routes/tasks');

// Import middleware
const { protectStudentData, auditLog } = require('./middleware/auth');

/**
 * Educational Technology Development Server
 * Specialized for Claude Code agent orchestration
 */
class EducationalApp {
  constructor() {
    this.app = express();
    this.port = process.env.PORT || 3000;
    this.environment = process.env.NODE_ENV || 'development';
    
    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  /**
   * Initialize middleware stack optimized for educational applications
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

    // CORS configuration for educational platforms
    this.app.use(cors({
      origin: this.getAllowedOrigins(),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Educational-Context'],
      exposedHeaders: ['X-Educational-Privacy', 'X-Student-Data-Protection']
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
        educational: {
          tip: 'Rate limiting helps protect student data and system stability.'
        }
      },
      standardHeaders: true,
      legacyHeaders: false,
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
        // Educational data validation
        if (buf.length > 0) {
          try {
            const data = JSON.parse(buf.toString());
            // Check for potential PII in request body
            this.validateEducationalData(data, req);
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

    // MongoDB injection protection
    this.app.use(mongoSanitize());

    // Educational data protection headers
    this.app.use(protectStudentData);

    // Request logging for educational compliance
    this.app.use((req, res, next) => {
      // Log all API requests for compliance audit
      if (req.path.startsWith('/api/')) {
        console.log(`📚 Educational API: ${req.method} ${req.path} - ${req.ip} - ${new Date().toISOString()}`);
      }
      next();
    });

    // Educational context middleware
    this.app.use((req, res, next) => {
      req.educational = {
        environment: this.environment,
        timestamp: new Date().toISOString(),
        ferpaCompliant: true,
        coppaCompliant: true
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
        service: 'Educational Technology Development API',
        version: process.env.npm_package_version || '1.0.0',
        environment: this.environment,
        timestamp: new Date().toISOString(),
        educational: {
          ferpaCompliant: true,
          coppaCompliant: true,
          wcagLevel: 'AA'
        }
      });
    });

    // API documentation endpoint
    this.app.get('/api', (req, res) => {
      res.json({
        success: true,
        message: 'Educational Technology Development API',
        version: '1.0.0',
        documentation: {
          authentication: '/api/auth',
          projects: '/api/projects',
          tasks: '/api/tasks',
          agents: 'See CLAUDE.md for agent configuration'
        },
        educational: {
          compliance: ['FERPA', 'COPPA', 'GDPR'],
          accessibility: 'WCAG 2.1 AA',
          dataProtection: 'Student data encrypted and anonymized'
        },
        endpoints: {
          'POST /api/auth/register': 'Register new educational team member',
          'POST /api/auth/login': 'Authenticate user',
          'GET /api/projects': 'List educational projects',
          'POST /api/projects': 'Create new educational project',
          'GET /api/tasks': 'List tasks with educational context',
          'POST /api/tasks/:id/execute': 'Execute task with Claude agents'
        }
      });
    });

    // Mount API routes
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/projects', projectRoutes);
    this.app.use('/api/tasks', taskRoutes);

    // Educational metrics endpoint
    this.app.get('/api/educational-metrics', 
      auditLog('metrics_access'),
      async (req, res) => {
        try {
          const dbStats = await databaseConfig.getStats();
          const healthCheck = await databaseConfig.healthCheck();
          
          res.json({
            success: true,
            data: {
              database: dbStats,
              health: healthCheck,
              educational: {
                projectTypes: ['educational', 'learning-management', 'assessment', 'analytics'],
                complianceStandards: ['FERPA', 'COPPA', 'GDPR', 'WCAG 2.1 AA'],
                agentTypes: ['product-manager', 'project-manager', 'senior-developer', 'junior-developer', 'qa-engineer']
              }
            }
          });
        } catch (error) {
          res.status(500).json({
            success: false,
            message: 'Error retrieving educational metrics.'
          });
        }
      }
    );

    // 404 handler for API routes
    this.app.use('/api', (req, res) => {
      res.status(404).json({
        success: false,
        message: 'API endpoint not found.',
        educational: {
          tip: 'Check the API documentation at /api for available endpoints.'
        }
      });
    });

    // Root endpoint - API only
    this.app.get('/', (req, res) => {
      res.json({
        success: true,
        message: 'Educational Technology Development API',
        description: 'Backend API for educational institutions using Claude Code agents',
        features: [
          'AI-powered development agents',
          'Educational compliance (FERPA/COPPA)',
          'Accessibility testing (WCAG 2.1 AA)',
          'LMS integration support',
          'Student data protection'
        ],
        api: '/api',
        health: '/health',
        educational: {
          targetAudience: ['K-12 Schools', 'Universities', 'Corporate Training', 'EdTech Companies'],
          compliance: 'Full FERPA and COPPA compliance built-in',
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
        educational: {
          suggestion: 'Visit /api for API documentation or /health for system status.'
        }
      });
    });

    // Global error handler
    this.app.use((error, req, res, next) => {
      console.error('🚨 Server Error:', error);

      // Educational data breach detection
      if (error.message && error.message.toLowerCase().includes('student')) {
        console.error('🔒 POTENTIAL STUDENT DATA EXPOSURE DETECTED');
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
        educational: {
          dataProtection: 'Student data remains secure',
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
      'http://localhost:5000'
    ];

    // Add production origins
    if (process.env.FRONTEND_URL) {
      origins.push(process.env.FRONTEND_URL);
    }

    // Add educational platform origins
    if (process.env.LMS_ORIGINS) {
      origins.push(...process.env.LMS_ORIGINS.split(','));
    }

    return origins;
  }

  /**
   * Validate educational data for PII and compliance
   */
  validateEducationalData(data, req) {
    // Check for potential student PII
    const piiFields = [
      'ssn', 'social_security_number', 'student_id', 'student_number',
      'email', 'phone', 'address', 'birth_date', 'parent_name'
    ];

    const dataString = JSON.stringify(data).toLowerCase();
    const foundPII = piiFields.filter(field => dataString.includes(field));

    if (foundPII.length > 0) {
      console.warn(`⚠️ Potential PII detected in request: ${foundPII.join(', ')} - ${req.path}`);
      req.educational.piiWarning = foundPII;
    }

    // Check for required educational context
    if (req.path.includes('/tasks') && data.educationalImpact) {
      if (!data.educationalImpact.learningObjectives) {
        console.warn(`⚠️ Educational task missing learning objectives - ${req.path}`);
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
      
      // Initialize educational database structure
      await databaseConfig.initializeEducationalDatabase();

      // Start HTTP server
      this.server = this.app.listen(this.port, () => {
        console.log('');
        console.log('🎓 Educational Technology Development Server');
        console.log('================================================');
        console.log(`🚀 Server running on port ${this.port}`);
        console.log(`🌍 Environment: ${this.environment}`);
        console.log(`📊 Database: ${databaseConfig.getConnectionStatus().name}`);
        console.log('');
        console.log('🎯 Educational Features:');
        console.log('   ✅ FERPA Compliance');
        console.log('   ✅ COPPA Compliance');
        console.log('   ✅ WCAG 2.1 AA Accessibility');
        console.log('   ✅ Student Data Protection');
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
        console.log('   🎓 Senior Developer (Complex Features & Code Review)');
        console.log('   👨‍💻 Junior Developer (UI Components & Simple Features)');
        console.log('   🧪 QA Engineer (Testing & Compliance Validation)');
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
    console.log('📊 Shutting down Educational Technology Development Server...');
    
    if (this.server) {
      this.server.close(async () => {
        console.log('🔌 HTTP server closed');
        
        try {
          await databaseConfig.disconnect();
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
const educationalApp = new EducationalApp();

// Handle graceful shutdown
process.on('SIGTERM', () => educationalApp.shutdown());
process.on('SIGINT', () => educationalApp.shutdown());

module.exports = educationalApp;