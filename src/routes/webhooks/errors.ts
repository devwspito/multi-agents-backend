/**
 * Webhook Error Notification Endpoint
 *
 * Receives error notifications from external client projects
 * Creates tasks automatically and triggers orchestration
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { authenticateWebhook, WebhookAuthRequest } from '../../middleware/webhookAuth';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { RepositoryRepository } from '../../database/repositories/RepositoryRepository.js';
// v1 OrchestrationCoordinator - battle-tested with full prompts
import { OrchestrationCoordinator } from '../../services/orchestration/OrchestrationCoordinator';
import { LogService } from '../../services/logging/LogService';
import { NotificationService } from '../../services/NotificationService';
import { ErrorDetectiveService } from '../../services/ErrorDetectiveService';
// Model config simplified: All agents use OPUS by default
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
 * Calculate error hash for deduplication
 * Uses SHA-256 hash of errorType + message
 */
function calculateErrorHash(errorType: string, message: string): string {
  const content = `${errorType}:${message}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Find existing task with same error in time window
 * Deduplication window: 1 hour
 */
function findDuplicateTask(
  projectId: string,
  errorHash: string
): any | null {
  // Use the findByWebhookHash helper which implements deduplication logic
  return TaskRepository.findByWebhookHash(projectId, errorHash);
}

/**
 * Rate limiter per API key
 */
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: (req: WebhookAuthRequest) => {
    if (!req.webhookAuth?.apiKeyDoc) return 60; // default
    // Rate limit is already in the apiKeyDoc from authentication
    return req.webhookAuth.apiKeyDoc.rateLimit || 60;
  },
  keyGenerator: (req: WebhookAuthRequest) => {
    return req.webhookAuth?.apiKeyDoc?.id || 'unknown';
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
      const apiKeyDoc = req.webhookAuth!.apiKeyDoc;

      console.log(`\n${'='.repeat(80)}`);
      console.log(`🚨 Webhook Error Notification Received`);
      console.log(`Project: ${projectId}`);
      console.log(`Error: ${errorType} - ${severity}`);
      console.log(`Message: ${message.substring(0, 100)}`);
      console.log(`Task Config: ${apiKeyDoc.taskConfig || 'standard'}`);
      console.log(`${'='.repeat(80)}\n`);

      // 🔍 Step 1: Analyze error using ErrorDetective (runs BEFORE task creation)
      console.log(`🕵️  Analyzing error with ErrorDetective...`);
      const errorDetective = new ErrorDetectiveService();

      const analysisResult = await errorDetective.analyzeError({
        errorLogs: message,
        stackTrace,
        environment: (metadata as any)?.environment || 'production',
        errorType,
        timestamp: new Date(),
        metadata,
      });

      if (!analysisResult.success) {
        console.error(`❌ ErrorDetective analysis failed: ${analysisResult.error}`);
        return res.status(500).json({
          success: false,
          error: 'Failed to analyze error',
          details: analysisResult.error,
        });
      }

      console.log(`✅ ErrorDetective analysis complete`);
      console.log(`   Severity: ${analysisResult.analysis?.severity}`);
      console.log(`   Root cause: ${analysisResult.analysis?.rootCause?.substring(0, 100)}...`);
      console.log(`   Cost: $${analysisResult.cost_usd?.toFixed(4)}`);

      // Use ErrorDetective's formatted task description
      const description = analysisResult.taskDescription!;

      // Map severity to priority (use analyzed severity, not client-provided)
      const priority = mapSeverityToPriority(analysisResult.analysis?.severity || severity);

      // Find active repositories for project (SQLite - synchronous)
      const repositories = RepositoryRepository.findByProjectId(projectId)
        .filter(r => r.isActive);

      if (repositories.length === 0) {
        console.warn(`⚠️  No active repositories found for project ${projectId}`);
        return res.status(400).json({
          success: false,
          error: 'No active repositories found for this project. Please configure repositories first.',
        });
      }

      // 🔄 DEDUPLICATION: Calculate error hash
      const errorHash = calculateErrorHash(errorType, message);

      // 🔍 Check for duplicate task in last hour
      const existingTask = await findDuplicateTask(projectId, errorHash);

      let task: any;

      if (existingTask) {
        // ♻️ DUPLICATE FOUND: Update existing task
        const occurrenceCount = (existingTask.webhookMetadata?.occurrenceCount || 1) + 1;

        // Update webhook metadata (SQLite - synchronous)
        const updatedWebhookMetadata = {
          ...existingTask.webhookMetadata,
          occurrenceCount,
          lastOccurrence: new Date(),
        };
        TaskRepository.update(existingTask.id, {
          webhookMetadata: updatedWebhookMetadata,
        });

        task = existingTask;
        const taskId = task.id;

        console.log(`♻️  Duplicate error detected - updating existing task ${taskId}`);
        console.log(`   Occurrence count: ${occurrenceCount}`);

        await LogService.info(`Duplicate error detected - count updated`, {
          taskId,
          category: 'system',
          metadata: {
            projectId,
            errorType,
            errorHash,
            occurrenceCount,
          },
        });

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `♻️  Duplicate error detected (occurrence #${occurrenceCount})`
        );

        // Return 200 with existing task info
        return res.status(200).json({
          success: true,
          taskId,
          taskUrl: `/api/tasks/${taskId}`,
          message: `Duplicate error detected. Existing task updated (occurrence #${occurrenceCount}).`,
          deduplicated: true,
          occurrenceCount,
        });
      } else {
        // ✨ NEW ERROR: Create new task
        // SIMPLIFIED: All agents use OPUS by default
        console.log(`📋 Creating task with OPUS model (default)`);

        // Create task (SQLite - synchronous)
        // Note: userId is empty for webhook-generated tasks
        task = TaskRepository.create({
          title: `[AUTO] ${analysisResult.analysis?.errorType || errorType}: ${message.substring(0, 80)}`,
          description,
          priority,
          projectId,
          repositoryIds: repositories.map((r) => r.id),
          userId: '', // Webhook tasks don't have a user
          tags: ['webhook', 'auto-generated', analysisResult.analysis?.severity || severity, 'error-detective'],
          orchestration: {
            planning: { agent: 'planning-agent', status: 'pending' },
            totalCost: analysisResult.cost_usd || 0, // Start with ErrorDetective cost
            totalTokens: analysisResult.usage?.total_tokens || 0,

            // Auto-approval configuration (no human approval needed for webhook errors)
            autoApprovalEnabled: true,
            autoApprovalPhases: [
              'planning-agent',
              'tech-lead',
              'team-orchestration',
              'development',
              'judge',
              'auto-merge',
            ],

            // Model config removed - All agents use OPUS by default
          },
          webhookMetadata: {
            errorHash,
            occurrenceCount: 1,
            firstOccurrence: new Date(),
            lastOccurrence: new Date(),
            source: 'webhook-errors',
            errorDetectiveAnalysis: analysisResult.analysis, // Store analysis for reference
          },
        });

        const taskId = task.id;

        console.log(`✨ New error - created task ${taskId}`);

        await LogService.info(`Webhook error notification received and task created`, {
          taskId,
          category: 'system',
          metadata: {
            projectId,
            errorType,
            severity,
            errorHash,
            repositoryCount: repositories.length,
          },
        });

        // Trigger v1 orchestration asynchronously
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

        // Return 201 with new task info
        return res.status(201).json({
          success: true,
          taskId,
          taskUrl: `/api/tasks/${taskId}`,
          message: 'Error notification received. Task created and orchestration started.',
          deduplicated: false,
          occurrenceCount: 1,
        });
      }

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
