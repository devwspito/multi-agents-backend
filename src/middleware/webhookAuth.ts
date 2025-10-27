import { Request, Response, NextFunction } from 'express';
import { WebhookApiKey, IWebhookApiKey } from '../models/WebhookApiKey';

export interface WebhookAuthRequest extends Request {
  webhookAuth?: {
    apiKeyDoc: IWebhookApiKey;
    projectId: string;
  };
}

/**
 * Extract client IP address from request
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Redact API key for logging (show only first 10 chars and last 4 chars)
 */
function redactApiKey(key: string): string {
  if (key.length <= 14) {
    return '[REDACTED]';
  }
  return `${key.substring(0, 10)}..${key.substring(key.length - 4)}`;
}

/**
 * Middleware to authenticate webhook requests using API key
 */
export async function authenticateWebhook(
  req: WebhookAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const clientIp = getClientIp(req);
  const timestamp = new Date().toISOString();

  try {
    // Extract API key from X-API-Key header or Authorization: Bearer header
    let apiKey: string | undefined;

    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && typeof xApiKey === 'string') {
      apiKey = xApiKey;
    } else {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        apiKey = authHeader.substring(7);
      }
    }

    if (!apiKey) {
      console.warn(
        `❌ Failed webhook auth: missing_key | ip=${clientIp} | timestamp=${timestamp}`
      );
      res.status(401).json({
        success: false,
        error: 'API key required. Provide via X-API-Key header or Authorization: Bearer token',
      });
      return;
    }

    // Validate API key using constant-time comparison
    const apiKeyDoc = await WebhookApiKey.validateApiKey(apiKey);

    if (!apiKeyDoc) {
      console.warn(
        `❌ Failed webhook auth: invalid_key=[${redactApiKey(apiKey)}] | ip=${clientIp} | timestamp=${timestamp}`
      );
      res.status(401).json({
        success: false,
        error: 'Invalid or inactive API key',
      });
      return;
    }

    // Update last used timestamp and request count
    await WebhookApiKey.updateOne(
      { _id: apiKeyDoc._id },
      {
        lastUsedAt: new Date(),
        $inc: { requestCount: 1 },
      }
    );

    // Log successful authentication
    console.info(
      `✅ Successful webhook auth: key=[${redactApiKey(apiKey)}] | project=${apiKeyDoc.projectId} | ip=${clientIp} | timestamp=${timestamp}`
    );

    // Attach webhook auth context to request
    req.webhookAuth = {
      apiKeyDoc,
      projectId: (apiKeyDoc.projectId as any).toString(),
    };

    next();
  } catch (error) {
    console.error(
      `❌ Webhook authentication error | ip=${clientIp} | timestamp=${timestamp} | error:`,
      error
    );
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
    });
  }
}
