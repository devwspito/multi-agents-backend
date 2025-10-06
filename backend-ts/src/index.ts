import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { connectDatabase } from './config/database';

// Import routes
import authRoutes from './routes/auth';
import taskRoutes from './routes/tasks';

/**
 * Multi-Agent Software Development Platform
 * Powered by Claude Agent SDK
 */
class AgentPlatformApp {
  private app: express.Application;
  private port: number;

  constructor() {
    this.app = express();
    this.port = env.PORT;

    this.app.set('trust proxy', 1);
  }

  /**
   * Inicializa middleware
   */
  private initializeMiddleware(): void {
    // Security
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https://api.anthropic.com'],
          },
        },
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
        origin: [env.FRONTEND_URL, 'http://localhost:3000'],
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

    // API routes
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/tasks', taskRoutes);

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
   * Inicia el servidor
   */
  public async start(): Promise<void> {
    try {
      // Conectar a MongoDB
      await connectDatabase();

      // Inicializar middleware
      this.initializeMiddleware();

      // Inicializar rutas
      this.initializeRoutes();

      // Inicializar manejo de errores
      this.initializeErrorHandling();

      // Iniciar servidor
      this.app.listen(this.port, () => {
        console.log('');
        console.log('═══════════════════════════════════════════');
        console.log('🚀 Multi-Agent Platform Started');
        console.log('═══════════════════════════════════════════');
        console.log(`📍 Port: ${this.port}`);
        console.log(`🌍 Environment: ${env.NODE_ENV}`);
        console.log(`🤖 Claude Agent SDK: Ready`);
        console.log(`💾 MongoDB: Connected`);
        console.log('═══════════════════════════════════════════');
        console.log('');
      });

      // Graceful shutdown
      process.on('SIGTERM', this.shutdown.bind(this));
      process.on('SIGINT', this.shutdown.bind(this));
    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  }

  /**
   * Graceful shutdown
   */
  private async shutdown(): Promise<void> {
    console.log('\n🔌 Shutting down gracefully...');

    // Close database connection
    const { disconnectDatabase } = await import('./config/database');
    await disconnectDatabase();

    console.log('✅ Shutdown complete');
    process.exit(0);
  }
}

// Iniciar aplicación
const app = new AgentPlatformApp();
app.start();
