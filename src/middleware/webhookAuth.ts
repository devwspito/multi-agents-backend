import { Request, Response, NextFunction } from 'express';
import { WebhookApiKey } from '../models/WebhookApiKey';

export interface WebhookAuthRequest extends Request {
  webhookAuth?: {
    apiKeyDoc: any;
    projectId: string;
  };
}

/**
 * Middleware para autenticar requests de webhooks usando API key
 */
export async function authenticateWebhook(
  req: WebhookAuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extraer API key desde headers
    const apiKey =
      (req.headers['x-api-key'] as string) ||
      req.headers.authorization?.replace('Bearer ', '');

    const clientIp = (req.ip || req.headers['x-forwarded-for'] || 'unknown') as string;

    if (!apiKey) {
      console.warn(
        `❌ Failed webhook auth: missing key | ip=${clientIp}`
      );
      res.status(401).json({
        success: false,
        error: 'API key required. Provide via X-API-Key header or Authorization: Bearer token',
      });
      return;
    }

    // Validar API key con comparación constant-time
    const apiKeyDoc = await WebhookApiKey.validateApiKey(apiKey);

    if (!apiKeyDoc) {
      const keyPreview = apiKey.substring(0, 10);
      console.warn(
        `❌ Failed webhook auth: invalid key=[${keyPreview}...] | ip=${clientIp}`
      );
      res.status(401).json({
        success: false,
        error: 'Invalid or inactive API key',
      });
      return;
    }

    // Actualizar timestamp y contador
    await WebhookApiKey.updateOne(
      { _id: apiKeyDoc._id },
      {
        lastUsedAt: new Date(),
        $inc: { requestCount: 1 },
      }
    );

    // Log de autenticación exitosa
    const keyPreview = apiKey.substring(0, 10);
    console.log(
      `✅ Webhook auth success: project=${apiKeyDoc.projectId} key=[${keyPreview}...] | ip=${clientIp}`
    );

    // Adjuntar contexto de webhook al request
    req.webhookAuth = {
      apiKeyDoc,
      projectId: apiKeyDoc.projectId.toString(),
    };

    next();
  } catch (error) {
    const clientIp = (req.ip || req.headers['x-forwarded-for'] || 'unknown') as string;
    console.error(`❌ Webhook authentication error | ip=${clientIp}:`, error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed',
    });
  }
}
