/**
 * Diagnostics Router
 * Endpoints for testing and diagnosing SDK issues
 */

import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'os';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * GET /api/diagnostics/sdk
 * Test Claude SDK functionality
 */
router.get('/sdk', authenticate, async (_req: AuthRequest, res) => {
  const diagnostics: any = {
    timestamp: new Date().toISOString(),
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
      },
      env: {
        NODE_ENV: process.env.NODE_ENV,
        hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
        keyLength: process.env.ANTHROPIC_API_KEY?.length || 0,
      },
    },
    sdk: {
      installed: false,
      version: null,
      testResult: null,
    },
  };

  try {
    // Check if SDK is installed
    const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
    diagnostics.sdk.installed = true;

    // Get SDK version
    const packageJsonPath = path.join(
      path.dirname(sdkPath),
      '..',
      'package.json'
    );
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      diagnostics.sdk.version = packageJson.version;
    }

    // Test SDK with minimal query
    console.log('🧪 [Diagnostics] Testing SDK query...');

    const testPrompt = 'Reply with exactly: DIAGNOSTIC_TEST_OK';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      diagnostics.sdk.testResult = {
        success: false,
        error: 'No ANTHROPIC_API_KEY found',
      };
    } else {
      try {
        const stream = query({
          prompt: testPrompt,
          options: {
            cwd: process.cwd(),
            model: 'claude-haiku-4-5-20251001', // Use cheapest model for test
            maxTurns: 1,
            permissionMode: 'bypassPermissions',
            env: {
              ...process.env,
              ANTHROPIC_API_KEY: apiKey,
            },
          },
        });

        let testSuccess = false;
        let errorMessage = null;
        const messages: any[] = [];

        for await (const message of stream) {
          messages.push({
            type: message.type,
            isError: (message as any).is_error || false,
          });

          if (message.type === 'result') {
            if ((message as any).is_error) {
              errorMessage = (message as any).result || 'Unknown error';
            } else {
              testSuccess = true;
            }
          }
        }

        diagnostics.sdk.testResult = {
          success: testSuccess,
          error: errorMessage,
          messageCount: messages.length,
          messageTypes: messages.map(m => m.type),
        };
      } catch (sdkError: any) {
        diagnostics.sdk.testResult = {
          success: false,
          error: sdkError.message,
          stack: sdkError.stack,
        };
      }
    }

    // Return diagnostics
    res.json({
      success: true,
      diagnostics,
    });
  } catch (error: any) {
    diagnostics.error = {
      message: error.message,
      stack: error.stack,
    };

    res.status(500).json({
      success: false,
      diagnostics,
    });
  }
});

/**
 * GET /api/diagnostics/models
 * Test all model configurations
 */
router.get('/models', authenticate, async (_req: AuthRequest, res) => {
  const models = [
    { alias: 'haiku', id: 'claude-haiku-4-5-20251001' },
    { alias: 'sonnet', id: 'claude-sonnet-4-5-20250929' },
    { alias: 'opus', id: 'claude-opus-4-5-20251101' },
  ];

  const results: any[] = [];

  for (const model of models) {
    console.log(`🧪 [Diagnostics] Testing ${model.alias} model...`);

    try {
      const stream = query({
        prompt: 'Reply with exactly: OK',
        options: {
          cwd: process.cwd(),
          model: model.id,
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
          },
        },
      });

      let success = false;
      let error = null;

      for await (const message of stream) {
        if (message.type === 'result') {
          if ((message as any).is_error) {
            error = (message as any).result;
          } else {
            success = true;
          }
        }
      }

      results.push({
        model: model.alias,
        modelId: model.id,
        success,
        error,
      });
    } catch (err: any) {
      results.push({
        model: model.alias,
        modelId: model.id,
        success: false,
        error: err.message,
      });
    }
  }

  res.json({
    success: true,
    results,
    summary: {
      total: results.length,
      passed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    },
  });
});

/**
 * GET /api/diagnostics/health
 * Quick health check for the service
 */
router.get('/health', async (_req, res) => {
  try {
    res.json({
      success: true,
      healthy: true,
      timestamp: new Date().toISOString(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        unit: 'MB',
      },
      uptime: Math.round(process.uptime()),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      healthy: false,
      error: error.message,
    });
  }
});

export default router;