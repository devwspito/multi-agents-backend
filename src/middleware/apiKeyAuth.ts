import { Request, Response, NextFunction } from 'express';
import { ApiKey } from '../models/ApiKey';
import { Logger } from '../utils/logger';

export interface ApiKeyRequest extends Request {
  apiKey?: {
    id: string;
    projectId: string;
    userId: string;
    scopes: string[];
  };
  user?: {
    id: string;
  };
}

/**
 * Middleware para autenticar requests usando API Key
 * Soporta tanto 'Authorization: Bearer <key>' como 'X-API-Key' headers
 */
export async function apiKeyAuth(req: ApiKeyRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Extraer API key del request
    const apiKeyValue = extractApiKey(req);

    if (!apiKeyValue) {
      res.status(400).json({
        success: false,
        message: 'API key required',
      });
      return;
    }

    // Validar formato del API key
    if (!isValidApiKeyFormat(apiKeyValue)) {
      res.status(401).json({
        success: false,
        message: 'Invalid API key format',
      });
      return;
    }

    // Extraer prefix (primeros 16 caracteres)
    const keyPrefix = apiKeyValue.substring(0, 16);

    // Buscar API key en base de datos usando el prefix
    const apiKey = await ApiKey.findOne({
      keyPrefix,
      isActive: true,
    }).select('+keyHash');

    if (!apiKey) {
      Logger.debug('API key lookup failed', { keyPrefix });
      res.status(401).json({
        success: false,
        message: 'Invalid API key',
      });
      return;
    }

    // Verificar hash del API key usando bcrypt (prevención timing attacks)
    const isValid = await ApiKey.verifyApiKey(apiKeyValue, apiKey.keyHash);
    if (!isValid) {
      Logger.debug('API key hash verification failed', {
        apiKeyId: apiKey._id.toString(),
      });
      res.status(401).json({
        success: false,
        message: 'Invalid API key',
      });
      return;
    }

    // Verificar si el API key ha expirado
    if (apiKey.isExpired()) {
      Logger.debug('API key expired', {
        apiKeyId: apiKey._id.toString(),
        expiresAt: apiKey.expiresAt,
      });
      res.status(401).json({
        success: false,
        message: 'API key expired',
      });
      return;
    }

    // Verificar rate limit
    const rateLimitCheck = apiKey.checkRateLimit();
    if (!rateLimitCheck.allowed) {
      Logger.warn('API key rate limit exceeded', {
        apiKeyId: apiKey._id.toString(),
        hourlyRequests: apiKey.rateLimit.currentHourRequests,
        dailyRequests: apiKey.rateLimit.currentDayRequests,
      });
      res.status(429).json({
        success: false,
        message: 'Rate limit exceeded',
        resetAt: rateLimitCheck.resetAt,
      });
      res.set('X-RateLimit-Reset', rateLimitCheck.resetAt.toISOString());
      return;
    }

    // Incrementar contadores de uso
    await apiKey.incrementUsage();

    // Adjuntar información del API key al request
    req.apiKey = {
      id: apiKey._id.toString(),
      projectId: apiKey.projectId.toString(),
      userId: apiKey.userId.toString(),
      scopes: apiKey.scopes,
    };

    // Compatibilidad con middleware de autenticación existente
    req.user = {
      id: apiKey.userId.toString(),
    };

    // Configurar headers de rate limit
    const remaining =
      apiKey.rateLimit.requestsPerHour - apiKey.rateLimit.currentHourRequests;
    res.set({
      'X-RateLimit-Limit': apiKey.rateLimit.requestsPerHour.toString(),
      'X-RateLimit-Remaining': remaining.toString(),
      'X-RateLimit-Reset': rateLimitCheck.resetAt.toISOString(),
    });

    Logger.debug('API key authenticated successfully', {
      apiKeyId: apiKey._id.toString(),
      projectId: apiKey.projectId.toString(),
    });

    next();
  } catch (error) {
    Logger.error('API key authentication error', error as Error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
}

/**
 * Extrae el API key del request
 * Soporta: 'Authorization: Bearer <key>' y 'X-API-Key' headers
 */
function extractApiKey(req: Request): string | null {
  // Desde header Authorization
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Desde header X-API-Key
  const apiKeyHeader = req.headers['x-api-key'];
  if (typeof apiKeyHeader === 'string') {
    return apiKeyHeader;
  }

  return null;
}

/**
 * Valida el formato del API key
 * Debe comenzar con 'ak_live_' o 'ak_test_'
 */
function isValidApiKeyFormat(apiKey: string): boolean {
  return apiKey.startsWith('ak_live_') || apiKey.startsWith('ak_test_');
}

/**
 * Middleware helper para validar scopes específicos
 * Uso: app.get('/admin', requireScope('admin'), handler)
 */
export function requireScope(...requiredScopes: string[]) {
  return (req: ApiKeyRequest, res: Response, next: NextFunction) => {
    if (!req.apiKey) {
      res.status(401).json({
        success: false,
        message: 'Authentication required',
      });
      return;
    }

    const hasScope = requiredScopes.some((scope) => req.apiKey?.scopes.includes(scope));

    if (!hasScope) {
      Logger.warn('Insufficient permissions for API key', {
        apiKeyId: req.apiKey.id,
        requiredScopes,
        currentScopes: req.apiKey.scopes,
      });
      res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
        required: requiredScopes,
      });
      return;
    }

    next();
  };
}
