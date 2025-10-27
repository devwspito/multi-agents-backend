import { Request, Response, NextFunction } from 'express';
import { WebhookApiKey } from '../models/WebhookApiKey';

export interface WebhookAuthRequest extends Request {
  webhookAuth?: {
    apiKeyDoc: any;
    projectId: string;
  };
}

/**
 * Middleware para autenticar requests de webhook usando API key
 */
export async function authenticateWebhook(
  req: WebhookAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract API key from X-API-Key header or Authorization: Bearer header
    const apiKey =
      (req.headers['x-api-key'] as string) ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key required. Provide via X-API-Key header or Authorization: Bearer token',
      });
      return;
    }

    // Validate API key
    const apiKeyDoc = await WebhookApiKey.validateApiKey(apiKey);

    if (!apiKeyDoc) {
      console.warn(`Failed webhook auth attempt: ${apiKey.substring(0, 10)}...`);
      res.status(401).json({
        success: false,
        error: 'Invalid or inactive API key',
      });
      return;
    }

    // Update last used timestamp and increment request count
    await WebhookApiKey.updateOne(
      { _id: apiKeyDoc._id },
      {
        lastUsedAt: new Date(),
        $inc: { requestCount: 1 },
      }
    );

    // Attach webhook auth info to request
    req.webhookAuth = {
      apiKeyDoc,
      projectId: apiKeyDoc.projectId.toString(),
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
