import { Request, Response, NextFunction } from 'express';
import { WebhookApiKey } from '../models/WebhookApiKey';

export interface WebhookAuthRequest extends Request {
  webhookAuth?: {
    projectId: string;
    apiKeyDoc: any;
  };
}

/**
 * Middleware to authenticate webhook requests using API key
 * Expects API key in X-API-Key header or Authorization: Bearer <key>
 */
export async function authenticateWebhook(req: WebhookAuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Extract API key from header
    const apiKey = extractApiKey(req);

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key required. Use X-API-Key header or Authorization: Bearer <key>',
      });
      return;
    }

    // Find API key document
    const apiKeyDoc = await WebhookApiKey.findOne({
      apiKey,
      isActive: true,
    }).populate('projectId');

    if (!apiKeyDoc) {
      res.status(401).json({
        success: false,
        error: 'Invalid or inactive API key',
      });
      return;
    }

    // Update last used timestamp
    apiKeyDoc.lastUsedAt = new Date();
    await apiKeyDoc.save();

    // Attach to request
    req.webhookAuth = {
      projectId: (apiKeyDoc.projectId._id as any).toString(),
      apiKeyDoc,
    };

    next();
  } catch (error) {
    console.error('Webhook authentication error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
    });
  }
}

/**
 * Extract API key from request headers
 */
function extractApiKey(req: Request): string | null {
  // From X-API-Key header
  const apiKeyHeader = req.headers['x-api-key'] as string;
  if (apiKeyHeader) {
    return apiKeyHeader;
  }

  // From Authorization: Bearer <key>
  const authHeader = req.headers.authorization as string;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return null;
}
