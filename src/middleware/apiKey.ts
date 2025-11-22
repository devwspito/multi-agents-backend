import { Request, Response, NextFunction } from 'express';

/**
 * API Key Authentication Middleware
 *
 * Used for webhook integrations and external system error reporting
 * Checks for valid API key in headers: X-API-Key or Authorization: Bearer <key>
 */

interface ApiKeyRequest extends Request {
  apiKeyAuth?: boolean;
  apiKeyId?: string;
}

/**
 * Authenticate using API Key
 * Supports two header formats:
 * 1. X-API-Key: sk-...
 * 2. Authorization: Bearer sk-...
 */
export function authenticateApiKey(
  req: ApiKeyRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    // Extract API key from headers
    const apiKeyHeader = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'] as string | undefined;

    let apiKey: string | null = null;

    // Try X-API-Key header first
    if (apiKeyHeader) {
      apiKey = apiKeyHeader;
    }
    // Fallback to Authorization: Bearer <key>
    else if (authHeader && authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7); // Remove 'Bearer ' prefix
    }

    // No API key provided
    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: 'API key required. Provide X-API-Key or Authorization: Bearer header',
      });
      return;
    }

    // Validate API key format (must start with sk- and be at least 32 chars)
    if (!apiKey.startsWith('sk-') || apiKey.length < 32) {
      res.status(401).json({
        success: false,
        error: 'Invalid API key format. Expected: sk-<random-string>',
      });
      return;
    }

    // Get valid API keys from environment
    const validApiKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);

    if (validApiKeys.length === 0) {
      console.error('[API Key Auth] No API keys configured in environment (API_KEYS env var)');
      res.status(500).json({
        success: false,
        error: 'API key authentication not configured on server',
      });
      return;
    }

    // Check if API key is valid
    const isValid = validApiKeys.includes(apiKey);

    if (!isValid) {
      console.warn(`[API Key Auth] Invalid API key attempt: ${apiKey.substring(0, 10)}...`);
      res.status(403).json({
        success: false,
        error: 'Invalid API key',
      });
      return;
    }

    // API key is valid - attach to request and continue
    req.apiKeyAuth = true;
    req.apiKeyId = apiKey.substring(0, 12); // Store prefix for logging

    console.log(`✅ [API Key Auth] Authenticated: ${req.apiKeyId}... (method: ${req.method} ${req.path})`);

    next();
  } catch (error: any) {
    console.error('[API Key Auth] Error during authentication:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication error',
    });
  }
}

/**
 * Generate a new API key
 * Format: sk-<random-64-chars>
 *
 * Usage:
 * const apiKey = generateApiKey();
 * console.log('New API key:', apiKey);
 * // Add to .env: API_KEYS=sk-abc123...,sk-def456...
 */
export function generateApiKey(): string {
  const randomBytes = require('crypto').randomBytes(32);
  const randomString = randomBytes.toString('hex'); // 64 hex chars
  return `sk-${randomString}`;
}

export { ApiKeyRequest };
