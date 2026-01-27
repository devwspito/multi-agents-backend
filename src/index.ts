import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { WorkspaceCleanupScheduler } from './services/WorkspaceCleanupScheduler';
import { setupConsoleInterceptor } from './utils/consoleInterceptor';
import { storageService } from './services/storage/StorageService';

// Import routes
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';
import projectRoutes from './routes/projects';
import repositoryRoutes from './routes/repositories';
import conversationRoutes from './routes/conversations';
import codeRoutes from './routes/code';
import analyticsRoutes from './routes/analytics';
import cleanupRoutes from './routes/cleanup';
import githubWebhookRoutes from './routes/webhooks/github';
import errorWebhookRoutes from './routes/webhooks/errors';
import commandRoutes from './routes/commands';
import diagnosticsRoutes from './routes/diagnostics';
import sdkHealthRoutes from './routes/sdk-health';
import healthRoutes from './routes/health';
import devServerRoutes from './routes/dev-server';
import sandboxRoutes from './routes/sandbox';
import previewProxyRoutes from './routes/preview-proxy';

/**
 * Multi-Agent Software Development Platform
 * Powered by Claude Agent SDK
 */
class AgentPlatformApp {
  private app: express.Application;
  private httpServer: any;
  private io: SocketServer;
  private port: number;
  private cleanupScheduler: WorkspaceCleanupScheduler;
  private isShuttingDown: boolean = false;

  constructor() {
    this.app = express();
    this.port = env.PORT;
    this.httpServer = createServer(this.app);

    // Initialize Socket.IO with CORS
    this.io = new SocketServer(this.httpServer, {
      cors: {
        origin: (_origin, callback) => {
          // Allow all origins temporarily for debugging
          callback(null, true);
        },
        credentials: true,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      },
      path: '/ws/notifications',
      transports: ['websocket', 'polling'], // Allow both transports
      allowEIO3: true, // Allow different Socket.IO versions
    });

    this.cleanupScheduler = new WorkspaceCleanupScheduler();

    this.app.set('trust proxy', 1);
  }

  /**
   * Inicializa middleware
   */
  private initializeMiddleware(): void {
    // Security
    this.app.use(
      helmet({
        contentSecurityPolicy: env.NODE_ENV === 'production' ? {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://api.anthropic.com'],
          },
        } : false, // Deshabilitar CSP en desarrollo
        hsts: {
          maxAge: 31536000,
          includeSubDomains: true,
          preload: true,
        },
      })
    );

    // CORS - More permissive for production issues
    const allowedOrigins = [
      env.FRONTEND_URL,
      'http://localhost:3000',
      'http://localhost:5177',
      'http://localhost:5173',
      'https://multi-agents-d6279.web.app',
      'https://multi-agents-d6279.firebaseapp.com' // Add Firebase alternate domain
    ];

    this.app.use(
      cors({
        origin: (_origin, callback) => {
          // Allow requests with no origin (like mobile apps or curl)
          if (!_origin) return callback(null, true);

          if (allowedOrigins.includes(_origin)) {
            callback(null, true);
          } else {
            console.warn(`⚠️ CORS: Blocked origin ${_origin}`);
            callback(null, true); // Temporarily allow all origins to debug
          }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
        exposedHeaders: ['X-Total-Count'],
        maxAge: 86400, // 24 hours
        preflightContinue: false,
        optionsSuccessStatus: 204
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Cookie parsing
    this.app.use(cookieParser());

    // Serve uploads from Firebase Storage (or local filesystem fallback)
    this.app.get('/uploads/*', async (req: Request, res: Response) => {
      try {
        // Extract path after /uploads/
        const filePath = req.path.substring(1); // Remove leading /

        // Get file extension for MIME type
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        // Try Firebase Storage first
        if (storageService.isAvailable()) {
          const exists = await storageService.exists(filePath);
          if (exists) {
            const buffer = await storageService.downloadBuffer(filePath);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year cache
            res.send(buffer);
            return;
          }
        }

        // Fallback to local filesystem (legacy)
        const localPath = path.join(process.cwd(), filePath);
        if (fs.existsSync(localPath)) {
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=31536000');
          res.sendFile(localPath);
          return;
        }

        res.status(404).json({ error: 'File not found' });
      } catch (error: any) {
        console.error('Error serving upload:', error.message);
        res.status(500).json({ error: 'Failed to serve file' });
      }
    });

    // Rate limiting - Increased for real-time polling and approval workflows
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000, // Increased from 100 to support polling + approvals
      message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.',
      },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        // Skip rate limiting for health checks and high-frequency endpoints
        const skipEndpoints = [
          '/health',
          '/api/health',
          '/status',           // Task status polling
          '/user-code-edit',   // Auto-accept polling
          '/approve/',         // Approval endpoints (critical path)
          '/preview/',         // 🔥 FIX: Flutter loads 100s of JS modules - don't rate limit
          '/dev-server/',      // Dev server polling
        ];
        return skipEndpoints.some(ep => req.path.includes(ep));
      },
    });

    this.app.use('/api/', limiter);
  }

  /**
   * Inicializa rutas
   */
  private initializeRoutes(): void {
    // Health check endpoints (production-grade)
    this.app.use('/health', healthRoutes);
    this.app.use('/api/health', healthRoutes); // Also mount at /api/health for consistency

    // GitHub OAuth URL endpoint (compatibilidad con frontend)
    this.app.get('/api/github-auth/url', (req: Request, res: Response) => {
      // Check if GitHub OAuth is configured
      if (env.GITHUB_CLIENT_ID === 'not-configured' || env.GITHUB_CLIENT_SECRET === 'not-configured') {
        res.status(501).json({
          success: false,
          message: 'GitHub OAuth is not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.',
        });
        return;
      }

      const crypto = require('crypto');
      const state = crypto.randomBytes(16).toString('hex');

      const params = new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: `${req.protocol}://${req.get('host')}/api/auth/github/callback`,
        scope: 'user:email',
        state,
      });

      const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

      res.json({
        success: true,
        url: authUrl,
      });
    });

    // API v1 routes (production-ready, versioned)
    this.app.use('/api/v1/auth', authRoutes);
    this.app.use('/api/v1/tasks', taskRoutes);
    this.app.use('/api/v1/projects', projectRoutes);
    this.app.use('/api/v1/repositories', repositoryRoutes);
    this.app.use('/api/v1/conversations', conversationRoutes);
    this.app.use('/api/v1/code', codeRoutes);
    this.app.use('/api/v1/analytics', analyticsRoutes);
    this.app.use('/api/v1/cleanup', cleanupRoutes);
    this.app.use('/api/v1/webhooks/github', githubWebhookRoutes);
    this.app.use('/api/v1/webhooks/errors', errorWebhookRoutes);
    this.app.use('/api/v1/commands', commandRoutes);
    this.app.use('/api/v1/diagnostics', diagnosticsRoutes);
    this.app.use('/api/v1/sdk-health', sdkHealthRoutes);
    this.app.use('/api/v1/dev-server', devServerRoutes);
    this.app.use('/api/v1/sandbox', sandboxRoutes);
    this.app.use('/api/v1/preview', previewProxyRoutes);

    // Legacy API routes (backward compatibility - will be deprecated)
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/tasks', taskRoutes);
    this.app.use('/api/projects', projectRoutes);
    this.app.use('/api/repositories', repositoryRoutes);
    this.app.use('/api/conversations', conversationRoutes);
    this.app.use('/api/code', codeRoutes);
    this.app.use('/api/analytics', analyticsRoutes);
    this.app.use('/api/cleanup', cleanupRoutes);
    this.app.use('/api/webhooks/github', githubWebhookRoutes);
    this.app.use('/api/webhooks/errors', errorWebhookRoutes);
    this.app.use('/api/commands', commandRoutes);
    this.app.use('/api/diagnostics', diagnosticsRoutes);
    this.app.use('/api/sdk-health', sdkHealthRoutes);
    this.app.use('/api/dev-server', devServerRoutes);
    this.app.use('/api/sandbox', sandboxRoutes);
    this.app.use('/api/preview', previewProxyRoutes);

    // 404 handler
    this.app.use((req: Request, res: Response) => {
      res.status(404).json({
        success: false,
        message: 'Endpoint not found',
        path: req.path,
      });
    });
  }

  /**
   * Inicializa manejo de errores
   */
  private initializeErrorHandling(): void {
    this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      console.error('🚨 Server Error:', err);

      const statusCode = (err as any).statusCode || 500;
      const message = env.NODE_ENV === 'production' ? 'Internal server error' : err.message;

      res.status(statusCode).json({
        success: false,
        message,
        ...(env.NODE_ENV === 'development' && { stack: err.stack }),
      });
    });
  }

  /**
   * Inicializa WebSocket para notificaciones en tiempo real
   */
  private initializeWebSocket(): void {
    this.io.on('connection', (socket) => {
      console.log(`🔌 Socket.IO client connected: ${socket.id}`);

      // Autenticación automática con token
      const token = socket.handshake.auth.token;
      if (token) {
        console.log(`✅ Socket authenticated with token: ${socket.id}`);
      }

      // Event: authenticate (para tasks específicas)
      socket.on('authenticate', (data: { token?: string; taskId?: string }) => {
        console.log(`🔐 Socket ${socket.id} requesting authentication`);

        if (data.taskId) {
          socket.join(`task:${data.taskId}`);
          console.log(`📌 Socket ${socket.id} joined room: task:${data.taskId}`);

          // Confirmar autenticación
          socket.emit('authenticated', {
            success: true,
            taskId: data.taskId,
            socketId: socket.id,
          });
        }
      });

      // Event: join-task (usado por ConsoleViewer)
      socket.on('join-task', async (taskId: string) => {
        console.log(`📌 Socket ${socket.id} joining task room: ${taskId}`);
        socket.join(`task:${taskId}`);

        // Confirmar que se unió al room
        socket.emit('task-joined', {
          success: true,
          taskId,
          socketId: socket.id,
        });

        // Re-emitir logs y actividades históricos (para sobrevivir refresh)
        try {
          const { TaskRepository } = await import('./database/repositories/TaskRepository.js');
          const task = TaskRepository.findById(taskId);

          if (task) {
            // 1. Emitir logs históricos uno por uno
            if (task.logs && task.logs.length > 0) {
              console.log(`📜 Re-emitting ${task.logs.length} historical logs to socket ${socket.id}`);
              task.logs.forEach((log: any) => {
                socket.emit('console:log', {
                  taskId: taskId, // CRITICAL: Include taskId for frontend filtering
                  level: log.level,
                  message: log.message,
                  timestamp: log.timestamp,
                });
              });
            }

            // 2. 🎯 Emitir actividades históricas para Activity tab (OpenCode-style)
            if (task.activities && task.activities.length > 0) {
              console.log(`📡 Re-emitting ${task.activities.length} historical activities to socket ${socket.id}`);
              task.activities.forEach((activity: any) => {
                socket.emit('agent:activity', {
                  taskId: taskId,
                  agentName: activity.agentName,
                  type: activity.type,
                  timestamp: activity.timestamp,
                  file: activity.file,
                  content: activity.content,
                  command: activity.command,
                  output: activity.output,
                  toolName: activity.toolName,
                  toolInput: activity.toolInput,
                  diff: activity.diff,
                });
              });
            }

            // 3. Si hay aprobación pendiente, re-emitir evento usando datos persistidos
            // 🔥 FIX: Skip re-emitting if the phase has auto-approval enabled
            const pendingApproval = task.orchestration?.pendingApproval;
            if (task.status === 'in_progress' && pendingApproval && pendingApproval.phase) {
              const autoApprovalEnabled = task.orchestration?.autoApprovalEnabled;
              const autoApprovalPhases = task.orchestration?.autoApprovalPhases || [];
              const phaseHasAutoApproval = autoApprovalEnabled && autoApprovalPhases.includes(pendingApproval.phase);

              if (phaseHasAutoApproval) {
                console.log(`✅ [WebSocket] Skipping approval_required re-emit - ${pendingApproval.phase} has auto-approval`);
                // Clear the stale pendingApproval since it will be auto-approved
                const { TaskRepository } = await import('./database/repositories/TaskRepository.js');
                TaskRepository.modifyOrchestration(taskId, (orch) => {
                  const { pendingApproval: _, ...rest } = orch as any;
                  return rest;
                });
              } else {
                console.log(`⏸️  Re-emitting approval_required from persisted data:`, {
                  phase: pendingApproval.phase,
                  phaseName: pendingApproval.phaseName,
                });
                socket.emit('notification', {
                  type: 'approval_required',
                  data: {
                    phase: pendingApproval.phase, // Already kebab-case
                    phaseName: pendingApproval.phaseName,
                    agentName: pendingApproval.phaseName,
                    approvalType: 'planning',
                    agentOutput: pendingApproval.agentOutput || {},
                    retryCount: pendingApproval.retryCount || 0,
                    timestamp: pendingApproval.timestamp || new Date(),
                  },
                });
              }
            }
          }
        } catch (error) {
          console.error(`❌ Error re-emitting historical data for task ${taskId}:`, error);
        }
      });

      // Event: join:task (usado por useAgentActivity hook - formato con colon)
      socket.on('join:task', async (data: { taskId: string }) => {
        const taskId = data.taskId;
        console.log(`📌 Socket ${socket.id} joining task room via join:task: ${taskId}`);
        socket.join(`task:${taskId}`);

        // Confirmar que se unió al room
        socket.emit('task-joined', {
          success: true,
          taskId,
          socketId: socket.id,
        });

        // Re-emitir logs históricos (igual que join-task)
        try {
          const { TaskRepository } = await import('./database/repositories/TaskRepository.js');
          const task = TaskRepository.findById(taskId);

          if (task && task.logs && task.logs.length > 0) {
            console.log(`📜 Re-emitting ${task.logs.length} historical logs to socket ${socket.id}`);
            task.logs.forEach((log: any) => {
              socket.emit('console:log', {
                taskId: taskId,
                level: log.level,
                message: log.message,
                timestamp: log.timestamp,
              });
            });
          }
        } catch (error) {
          console.error(`❌ Error re-emitting historical data:`, error);
        }
      });

      // Event: leave:task (usado por useAgentActivity hook)
      socket.on('leave:task', (data: { taskId: string }) => {
        const taskId = data.taskId;
        console.log(`📌 Socket ${socket.id} leaving task room: ${taskId}`);
        socket.leave(`task:${taskId}`);
      });

      // Event: identify (compatibilidad con frontend)
      socket.on('identify', (data: { userId: string }) => {
        console.log(`👤 Socket ${socket.id} identified as user: ${data.userId}`);
        socket.join(`user:${data.userId}`);
      });

      // Event: subscribe (suscribirse a eventos)
      socket.on('subscribe', (data: { eventType: string }) => {
        console.log(`📬 Socket ${socket.id} subscribed to: ${data.eventType}`);
        socket.join(`event:${data.eventType}`);
      });

      // Event: unsubscribe
      socket.on('unsubscribe', (data: { eventType: string }) => {
        console.log(`📪 Socket ${socket.id} unsubscribed from: ${data.eventType}`);
        socket.leave(`event:${data.eventType}`);
      });

      // Event: ping/pong (keep-alive)
      socket.on('ping', () => {
        socket.emit('pong');
      });

      // Event: disconnect
      socket.on('disconnect', (reason) => {
        console.log(`❌ Socket.IO client disconnected: ${socket.id} (${reason})`);
      });
    });

    // Exportar instancia global para usar en servicios
    (global as any).io = this.io;

    console.log('✅ Socket.IO server initialized');
  }

  /**
   * Inicia el servidor
   */
  public async start(): Promise<void> {
    try {
      // Initialize SQLite database
      await connectDatabase();

      // 🔄 Auto-recover interrupted orchestrations
      console.log('🔄 Checking for interrupted orchestrations...');
      const { OrchestrationRecoveryService } = await import('./services/orchestration/OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      // Run recovery in background (don't block server startup)
      recoveryService.recoverAllInterruptedOrchestrations().catch((error) => {
        console.error('❌ Orchestration recovery failed:', error);
      });
      console.log('✅ Auto-recovery of interrupted orchestrations is ENABLED');

      // 🔄 Start failed execution retry processor
      console.log('🔄 Starting failed execution retry service...');
      const { FailedExecutionRetryService } = await import('./services/FailedExecutionRetryService');
      FailedExecutionRetryService.startBackgroundProcessor(2 * 60 * 1000); // Check every 2 minutes
      console.log('✅ Failed execution retry service is ENABLED');

      // 🔄 Recover active execution checkpoints
      console.log('🔄 Checking for active execution checkpoints...');
      const { ExecutionCheckpointService } = await import('./services/ExecutionCheckpointService');
      ExecutionCheckpointService.recoverActiveExecutions().catch((error) => {
        console.error('❌ Checkpoint recovery failed:', error);
      });
      console.log('✅ Execution checkpoint recovery is ENABLED');

      // 🏥 Start health monitoring service
      console.log('🏥 Starting health monitoring service...');
      const { healthCheckService } = await import('./services/orchestration/HealthCheckService');
      healthCheckService.startPeriodicMonitoring(60000); // Check every 60 seconds
      console.log('✅ Health monitoring is ENABLED (checks every 60s, auto-recovery for stuck tasks)');

      // Inicializar middleware
      this.initializeMiddleware();

      // Inicializar rutas
      this.initializeRoutes();

      // Inicializar manejo de errores
      this.initializeErrorHandling();

      // Inicializar WebSocket
      this.initializeWebSocket();

      // Setup console interceptor for WebSocket log emission
      setupConsoleInterceptor();

      // Iniciar servidor HTTP
      this.httpServer.listen(this.port, () => {
        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('🚀 Multi-Agent Platform Started');
        console.log('═══════════════════════════════════════════');
        console.log(`📍 Port: ${this.port}`);
        console.log(`🌍 Environment: ${env.NODE_ENV}`);
        console.log(`🤖 Claude Agent SDK: Ready`);
        console.log(`💾 SQLite: Connected`);
        console.log(`🔀 Dynamic Team Orchestration: Enabled`);
        console.log(`🔌 WebSocket: ws://localhost:${this.port}/ws/notifications`);
        console.log('═══════════════════════════════════════════');
        console.log('');
      });

      // Iniciar schedulers
      this.cleanupScheduler.start();

      // 🧹 Start scheduled branch cleanup (runs daily at 2 AM)
      const { scheduledCleanup } = await import('./services/cleanup/ScheduledBranchCleanup');
      scheduledCleanup.start();
      console.log('🧹 Scheduled branch cleanup: Enabled (runs daily at 2:00 AM)');

      // 🐳 Initialize sandbox service (Docker isolation like Codex/Devin)
      const { sandboxService } = await import('./services/SandboxService');
      const dockerAvailable = await sandboxService.initialize();
      if (dockerAvailable) {
        console.log('🐳 Sandbox Service: Enabled (Docker isolation available)');

        // 🔄 Restore sandbox pool from SQLite (survives server restarts)
        const { sandboxPoolService } = await import('./services/SandboxPoolService');
        await sandboxPoolService.restoreFromDatabase();
        console.log('🔄 Sandbox Pool: Restored from SQLite');

        // 🌐 Restore project networks from SQLite (multi-service communication)
        const { projectNetworkService } = await import('./services/ProjectNetworkService');
        await projectNetworkService.restoreFromDatabase();
        console.log('🌐 Project Networks: Restored from SQLite');
      } else {
        console.log('⚠️  Sandbox Service: Docker not available, running in host mode');
      }

      // Graceful shutdown
      process.on('SIGTERM', () => this.shutdown());
      process.on('SIGINT', () => this.shutdown());
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    // Prevent multiple shutdown calls
    if (this.isShuttingDown) {
      return;
    }
    this.isShuttingDown = true;

    console.log('\n🔌 Shutting down gracefully...');

    // Set timeout to force exit if graceful shutdown takes too long
    const forceExitTimeout = setTimeout(() => {
      console.log('⚠️ Forcefully exiting after timeout');
      process.exit(1);
    }, 10000); // 10 seconds timeout

    try {
      // Close WebSocket connections
      this.io.close();
      console.log('🔌 WebSocket server closed');

      // Close HTTP server
      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer.close(() => {
            console.log('🌐 HTTP server closed');
            resolve();
          });
        });
      }

      // Stop schedulers
      this.cleanupScheduler.stop();

      // 🔥 IMPORTANT: Do NOT destroy sandboxes on shutdown!
      // Sandboxes persist for LivePreview and manual work.
      // User must manually destroy them from UI when done.
      console.log('🐳 Sandboxes preserved (not destroyed on shutdown)');

      // Close database connection
      const { disconnectDatabase } = await import('./config/database');
      await disconnectDatabase();

      console.log('✅ Shutdown complete');
      clearTimeout(forceExitTimeout);
      process.exit(0);
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
      clearTimeout(forceExitTimeout);
      process.exit(1);
    }
  }
}

// Iniciar aplicación
const app = new AgentPlatformApp();
app.start();
