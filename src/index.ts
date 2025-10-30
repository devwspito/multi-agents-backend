import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import cookieParser from 'cookie-parser';
import path from 'path';
import { env } from './config/env';
import { connectDatabase } from './config/database';
import { WorkspaceCleanupScheduler } from './services/WorkspaceCleanupScheduler';

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
        origin: [env.FRONTEND_URL, 'http://localhost:3000', 'http://localhost:5177'],
        credentials: true,
        methods: ['GET', 'POST'],
      },
      path: '/ws/notifications',
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

    // CORS
    this.app.use(
      cors({
        origin: [env.FRONTEND_URL, 'http://localhost:3000', "http://localhost:5177", "http://localhost:5173", "https://multi-agents-d6279.web.app"],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
      })
    );

    // Compression
    this.app.use(compression());

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Cookie parsing
    this.app.use(cookieParser());

    // Serve static files from uploads directory (for task attachments/images)
    this.app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

    // MongoDB injection prevention
    this.app.use(mongoSanitize());

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100,
      message: {
        success: false,
        message: 'Too many requests from this IP. Please try again later.',
      },
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => {
        return req.path === '/health' || req.path === '/api/health';
      },
    });

    this.app.use('/api/', limiter);
  }

  /**
   * Inicializa rutas
   */
  private initializeRoutes(): void {
    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.json({
        success: true,
        message: 'Multi-Agent Platform is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

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

    // API routes
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

        // Re-emitir logs históricos acumulados (para sobrevivir refresh)
        try {
          const { Task } = await import('./models/Task');
          const task = await Task.findById(taskId).select('logs orchestration status').lean();

          if (task) {
            // 1. Emitir logs históricos uno por uno
            if (task.logs && task.logs.length > 0) {
              console.log(`📜 Re-emitting ${task.logs.length} historical logs to socket ${socket.id}`);
              task.logs.forEach((log: any) => {
                socket.emit('console:log', {
                  level: log.level,
                  message: log.message,
                  timestamp: log.timestamp,
                });
              });
            }

            // 2. Si hay aprobación pendiente, re-emitir evento
            // Detectamos aprobación pendiente cuando:
            // - Task está in_progress
            // - El último log menciona "Waiting for human approval"
            if (task.status === 'in_progress' && task.logs && task.logs.length > 0) {
              const lastLog = task.logs[task.logs.length - 1];
              if (lastLog.message && lastLog.message.includes('Waiting for human approval')) {
                // Extraer el nombre de la fase del mensaje (ej: "Product Manager")
                const match = lastLog.message.match(/Waiting for human approval of: (.+)$/);
                if (match) {
                  const phaseName = match[1].trim();
                  const phase = phaseName.replace(/\s+/g, ''); // "Product Manager" -> "ProductManager"

                  console.log(`⏸️  Re-emitting approval_required for ${phaseName} to socket ${socket.id}`);
                  socket.emit('notification', {
                    type: 'approval_required',
                    data: {
                      phase: phase,
                      phaseName: phaseName,
                      agentName: phase,
                      approvalType: 'planning',
                      timestamp: new Date(),
                    },
                  });
                }
              }
            }
          }
        } catch (error) {
          console.error(`❌ Error re-emitting historical data for task ${taskId}:`, error);
        }
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
      // Conectar a MongoDB
      await connectDatabase();

      // 🔄 Auto-recover interrupted orchestrations
      console.log('🔄 Checking for interrupted orchestrations...');
      const { OrchestrationRecoveryService } = await import('./services/orchestration/OrchestrationRecoveryService');
      const recoveryService = new OrchestrationRecoveryService();

      // Run recovery in background (don't block server startup)
      recoveryService.recoverAllInterruptedOrchestrations().catch((error) => {
        console.error('❌ Orchestration recovery failed:', error);
      });

      // Inicializar middleware
      this.initializeMiddleware();

      // Inicializar rutas
      this.initializeRoutes();

      // Inicializar manejo de errores
      this.initializeErrorHandling();

      // Inicializar WebSocket
      this.initializeWebSocket();

      // Iniciar servidor HTTP
      this.httpServer.listen(this.port, () => {
        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('🚀 Multi-Agent Platform Started');
        console.log('═══════════════════════════════════════════');
        console.log(`📍 Port: ${this.port}`);
        console.log(`🌍 Environment: ${env.NODE_ENV}`);
        console.log(`🤖 Claude Agent SDK: Ready`);
        console.log(`💾 MongoDB: Connected`);
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
