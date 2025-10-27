/**
 * Webhook Error Notification Endpoint with Rate Limiting
 *
 * Receives error notifications from external client projects
 * Automatically creates tasks and triggers orchestration
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticateWebhook, WebhookAuthRequest } from '../../middleware/webhookAuth';
import { Task } from '../../models/Task';
import { Repository } from '../../models/Repository';
import { WebhookApiKey } from '../../models/WebhookApiKey';
import { LogService } from '../../services/logging/LogService';
import { NotificationService } from '../../services/NotificationService';

const router = Router();

// ==================== Zod Schemas ====================

const WebhookErrorPayloadSchema = z.object({
  errorType: z.string().min(1).max(100),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  message: z.string().min(1).max(1000),
  stackTrace: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  repository: z.string().optional(),
});

type WebhookErrorPayload = z.infer<typeof WebhookErrorPayloadSchema>;

// ==================== Helper Functions ====================

/**
 * Map severity to task priority
 */
function mapSeverityToPriority(severity: string): number {
  const severityMap: Record<string, number> = {
    low: 3,
    medium: 2,
    high: 1,
    critical: 0,
  };
  return severityMap[severity.toLowerCase()] ?? 2;
}

/**
 * Validate webhook error payload
 */
function validateWebhookErrorPayload(data: any): WebhookErrorPayload {
  return WebhookErrorPayloadSchema.parse(data);
}

/**
 * Extract validation errors from Zod error
 */
function getWebhookValidationErrors(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.errors.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
  }));
}

/**
 * Sanitize error message for security
 */
function sanitizeErrorMessage(message: string): string {
  // Remove common sensitive patterns
  const sanitized = message
    .replace(/password[^,\n]*/gi, 'password: [REDACTED]')
    .replace(/secret[^,\n]*/gi, 'secret: [REDACTED]')
    .replace(/token[^,\n]*/gi, 'token: [REDACTED]')
    .replace(/api[_-]?key[^,\n]*/gi, 'api_key: [REDACTED]')
    .replace(/authorization[^,\n]*/gi, 'authorization: [REDACTED]');

  return sanitized;
}

// ==================== Rate Limiter ====================

const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: async (req: WebhookAuthRequest) => {
    if (!req.webhookAuth?.apiKeyDoc) return 60; // default
    const apiKey = await WebhookApiKey.findById(req.webhookAuth.apiKeyDoc._id);
    return apiKey?.rateLimit || 60;
  },
  keyGenerator: (req: WebhookAuthRequest) => {
    return req.webhookAuth?.apiKeyDoc?._id?.toString() || req.ip || '';
  },
  handler: (_req: WebhookAuthRequest, res: Response) => {
    const retryAfter = 60;
    res.status(429).set('Retry-After', retryAfter.toString()).json({
      success: false,
      error: 'Rate limit exceeded. Please try again later.',
      retryAfter,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ==================== Routes ====================

/**
 * POST /api/webhooks/errors
 *
 * Receives error notifications from external client projects
 * Automatically creates tasks and triggers orchestration
 *
 * Request headers:
 *   X-API-Key: <api-key> OR Authorization: Bearer <api-key>
 *
 * Request body:
 *   {
 *     "errorType": "NullPointerException",
 *     "severity": "high",
 *     "message": "Object reference not set to an instance of an object",
 *     "stackTrace": "...",
 *     "metadata": { "userId": "123", "endpoint": "/api/users" }
 *   }
 *
 * Success Response (201):
 *   {
 *     "success": true,
 *     "taskId": "64a1c2d3e4f5g6h7i8j9k0l1",
 *     "taskUrl": "/api/tasks/64a1c2d3e4f5g6h7i8j9k0l1",
 *     "message": "Error notification received. Task created and orchestration started."
 *   }
 *
 * Validation Error Response (400):
 *   {
 *     "success": false,
 *     "error": "Invalid payload",
 *     "validationErrors": [
 *       { "field": "severity", "message": "Invalid enum value" }
 *     ]
 *   }
 *
 * Rate Limit Response (429):
 *   {
 *     "success": false,
 *     "error": "Rate limit exceeded. Please try again later.",
 *     "retryAfter": 60
 *   }
 */
router.post(
  '/',
  authenticateWebhook,
  webhookRateLimiter,
  async (req: WebhookAuthRequest, res: Response) => {
    try {
      // Validate payload
      const payload = validateWebhookErrorPayload(req.body);

      const { errorType, severity, message, stackTrace, metadata } = payload;
      const projectId = req.webhookAuth!.projectId;

      console.log(`\n${'='.repeat(80)}`);
      console.log(`🚨 Webhook Error Notification Received`);
      console.log(`Project: ${projectId}`);
      console.log(`Error: ${errorType} - ${severity}`);
      console.log(`${'='.repeat(80)}\n`);

      // Map severity to priority
      const priority = mapSeverityToPriority(severity);

      // Sanitize error message and limit stacktrace
      const sanitizedMessage = sanitizeErrorMessage(message);
      const truncatedStackTrace = stackTrace ? stackTrace.substring(0, 10000) : 'N/A';

      // Build task description
      const description = `**Error Type:** ${errorType}\n**Severity:** ${severity}\n**Message:** ${sanitizedMessage}\n\n**Stack Trace:**\n\`\`\`\n${truncatedStackTrace}\n\`\`\`\n\n**Metadata:**\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\``;

      // Find repositories for project
      const repositories = await Repository.find({
        projectId,
        isActive: true,
      }).select('_id name').lean();

      if (repositories.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No active repositories found for this project. Please configure repositories first.',
        });
        return;
      }

      // Create task
      const task = await Task.create({
        title: `[AUTO] ${errorType}: ${sanitizedMessage.substring(0, 100)}`,
        description,
        priority,
        projectId,
        repositoryIds: repositories.map(r => r._id),
        status: 'pending',
        userId: req.webhookAuth!.apiKeyDoc.userId || projectId, // Use project owner
        tags: ['webhook', 'auto-generated', severity],
      });

      const taskId = (task._id as any).toString();

      await LogService.info(`Webhook error notification received`, {
        taskId,
        category: 'system',
        metadata: {
          projectId,
          errorType,
          severity,
          repositoryCount: repositories.length,
        },
      });

      // Trigger orchestration asynchronously (don't block response)
      setImmediate(async () => {
        try {
          console.log(`🚀 Starting orchestration for webhook-generated task: ${taskId}`);

          // Import OrchestrationCoordinator dynamically to avoid circular dependencies
          const { OrchestrationCoordinator } = await import('../../services/orchestration/OrchestrationCoordinator');
          const orchestrationCoordinator = new OrchestrationCoordinator();
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
            category: 'system',
            error,
          });
        }
      });

      // Return success immediately (async processing)
      res.status(201).json({
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
        res.status(400).json({
          success: false,
          error: 'Invalid payload',
          validationErrors,
        });
        return;
      }

      console.error('Webhook error notification failed:', error);
      res.status(500).json({
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
 *
 * Response (200):
 *   {
 *     "status": "healthy",
 *     "timestamp": "2024-01-15T10:30:45.123Z",
 *     "version": "1.0.0",
 *     "endpoint": "/api/webhooks/errors"
 *   }
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
