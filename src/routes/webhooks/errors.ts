/**
 * Webhook Error Notification Endpoint
 *
 * Receives error notifications from external client projects
 * Creates tasks automatically and triggers orchestration
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateWebhook, WebhookAuthRequest } from '../../middleware/webhookAuth';
import { Task } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { WebhookApiKey } from '../../models/WebhookApiKey';
import { OrchestrationCoordinator } from '../../services/orchestration/OrchestrationCoordinator';
import { LogService } from '../../services/logging/LogService';
import { NotificationService } from '../../services/NotificationService';
import { z } from 'zod';

const router = Router();
const orchestrationCoordinator = new OrchestrationCoordinator();

/**
 * Zod validation schema for webhook error payload
 */
const webhookErrorPayloadSchema = z.object({
  errorType: z.string().min(1).max(100),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  message: z.string().min(1).max(5000),
  stackTrace: z.string().max(10000).optional(),
  metadata: z.record(z.any()).optional(),
  repository: z.string().optional(),
});

export type WebhookErrorPayload = z.infer<typeof webhookErrorPayloadSchema>;

/**
 * Map severity to priority
 */
function mapSeverityToPriority(severity: string): 'low' | 'medium' | 'high' | 'critical' {
  const priorityMap: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
    'low': 'low',
    'medium': 'medium',
    'high': 'high',
    'critical': 'critical',
  };
  return priorityMap[severity] || 'medium';
}

/**
 * Extract validation errors from Zod error
 */
function getWebhookValidationErrors(error: z.ZodError) {
  return error.errors.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
  }));
}

/**
 * Rate limiter per API key
 */
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: async (req: WebhookAuthRequest) => {
    if (!req.webhookAuth?.apiKeyDoc) return 60; // default
    const apiKey = await WebhookApiKey.findById(req.webhookAuth.apiKeyDoc._id);
    return apiKey?.rateLimit || 60;
  },
  keyGenerator: (req: WebhookAuthRequest) => {
    return req.webhookAuth?.apiKeyDoc?._id?.toString() || 'unknown';
  },
  handler: (_req: Request, res: Response) => {
    const retryAfter = 60;
    res.set('Retry-After', retryAfter.toString());
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Please try again later.',
      retryAfter,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health check
    return req.path === '/health';
  },
});

/**
 * POST /api/webhooks/errors
 *
 * Receives error notifications from external client projects
 * Automatically creates tasks and triggers orchestration
 *
 * Authentication: X-API-Key or Bearer token (via authenticateWebhook middleware)
 * Rate Limiting: Per API key (from WebhookApiKey.rateLimit field)
 */
router.post(
  '/',
  authenticateWebhook,
  webhookRateLimiter,
  async (req: WebhookAuthRequest, res: Response) => {
    try {
      // Validate payload
      const payload = webhookErrorPayloadSchema.parse(req.body);

      const { errorType, severity, message, stackTrace, metadata } = payload;
      const projectId = req.webhookAuth!.projectId;

      console.log(`\n${'='.repeat(80)}`);
      console.log(`🚨 Webhook Error Notification Received`);
      console.log(`Project: ${projectId}`);
      console.log(`Error: ${errorType} - ${severity}`);
      console.log(`Message: ${message.substring(0, 100)}`);
      console.log(`${'='.repeat(80)}\n`);

      // Map severity to priority
      const priority = mapSeverityToPriority(severity);

      // Build task description
      const description = `**Error Type:** ${errorType}\n**Severity:** ${severity}\n**Message:** ${message}\n\n**Stack Trace:**\n\`\`\`\n${stackTrace?.substring(0, 10000) || 'N/A'}\n\`\`\`\n\n**Metadata:**\n\`\`\`json\n${JSON.stringify(metadata || {}, null, 2)}\n\`\`\``;

      // Find active repositories for project
      const repositories = await Repository.find({
        projectId,
        isActive: true,
      })
        .select('_id name')
        .lean();

      if (repositories.length === 0) {
        console.warn(`⚠️  No active repositories found for project ${projectId}`);
        return res.status(400).json({
          success: false,
          error: 'No active repositories found for this project. Please configure repositories first.',
        });
      }

      // Create task
      const task = await Task.create({
        title: `[AUTO] ${errorType}: ${message.substring(0, 100)}`,
        description,
        priority,
        projectId,
        repositoryIds: repositories.map((r) => r._id),
        status: 'pending',
        tags: ['webhook', 'auto-generated', severity],
        orchestration: {
          productManager: { agent: 'product-manager', status: 'pending' },
          projectManager: { agent: 'project-manager', status: 'pending' },
          totalCost: 0,
          totalTokens: 0,
        },
      });

      const taskId = (task._id as any).toString();

      await LogService.info(`Webhook error notification received and task created`, {
        taskId,
        category: 'system',
        metadata: {
          projectId,
          errorType,
          severity,
          repositoryCount: repositories.length,
        },
      });

      // Trigger orchestration asynchronously
      setImmediate(async () => {
        try {
          console.log(`🚀 Starting orchestration for webhook-generated task: ${taskId}`);
          await orchestrationCoordinator.orchestrateTask(taskId);

          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `✅ Orchestration started automatically from webhook error notification`
          );
        } catch (error: any) {
          console.error(`❌ Failed to start orchestration for task ${taskId}:`, error);
          await LogService.error(`Webhook orchestration failed`, {
            taskId,
            category: 'error',
            error,
          });
        }
      });

      // Return 201 immediately with task info
      return res.status(201).json({
        success: true,
        taskId,
        taskUrl: `/api/tasks/${taskId}`,
        message: 'Error notification received. Task created and orchestration started.',
      });

    } catch (error: any) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        const validationErrors = getWebhookValidationErrors(error);
        console.warn('Webhook payload validation failed:', validationErrors);
        return res.status(400).json({
          success: false,
          error: 'Invalid payload',
          validationErrors,
        });
      }

      console.error('Webhook error notification failed:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to process error notification',
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/webhooks/errors/health
 *
 * Health check endpoint for webhook monitoring
 * No authentication required
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    endpoint: '/api/webhooks/errors',
  });
});

export default router;
