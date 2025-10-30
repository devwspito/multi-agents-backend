/**
 * SDK Health Check Route
 * Critical diagnostics for Claude Agent SDK issues on Render
 */

import { Router } from 'express';
import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const router = Router();

/**
 * GET /api/sdk-health
 * Deep diagnostic check for SDK issues
 */
router.get('/', async (_req, res) => {
  const diagnostics: any = {
    timestamp: new Date().toISOString(),
    environment: {
      // System info
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      nodeVersionParsed: process.versions,

      // Memory (critical for Render)
      memory: {
        totalMB: Math.round(os.totalmem() / 1024 / 1024),
        freeMB: Math.round(os.freemem() / 1024 / 1024),
        usedMB: Math.round((os.totalmem() - os.freemem()) / 1024 / 1024),
        heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },

      // CPU
      cpus: os.cpus().length,
      loadAverage: os.loadavg(),

      // Process limits
      ulimit: {},

      // Environment variables
      env: {
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
        RENDER_SERVICE_NAME: process.env.RENDER_SERVICE_NAME,
        RENDER_INSTANCE_ID: process.env.RENDER_INSTANCE_ID,
        IS_PULL_REQUEST: process.env.IS_PULL_REQUEST,
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        apiKeyLength: process.env.ANTHROPIC_API_KEY?.length || 0,
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USER: process.env.USER,
      },
    },

    sdk: {
      checks: [],
    },

    childProcess: {
      canSpawn: false,
      spawnTest: null,
    },
  };

  // Check ulimits (process limits)
  try {
    const { execSync } = require('child_process');
    diagnostics.environment.ulimit = {
      openFiles: execSync('ulimit -n', { encoding: 'utf8' }).trim(),
      maxProcesses: execSync('ulimit -u', { encoding: 'utf8' }).trim(),
      maxMemoryKB: execSync('ulimit -m', { encoding: 'utf8' }).trim(),
      virtualMemoryKB: execSync('ulimit -v', { encoding: 'utf8' }).trim(),
    };
  } catch (e: any) {
    diagnostics.environment.ulimit.error = e.message;
  }

  // 1. Check if SDK is installed
  try {
    const sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
    diagnostics.sdk.checks.push({
      test: 'SDK module exists',
      success: true,
      path: sdkPath,
    });

    // Check SDK package.json
    const pkgPath = path.join(path.dirname(sdkPath), '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      diagnostics.sdk.version = pkg.version;
      diagnostics.sdk.checks.push({
        test: 'SDK package.json readable',
        success: true,
        version: pkg.version,
      });
    }
  } catch (e: any) {
    diagnostics.sdk.checks.push({
      test: 'SDK module exists',
      success: false,
      error: e.message,
    });
  }

  // 2. Test if we can spawn child processes (critical for SDK)
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('echo', ['test'], {
        timeout: 5000,
      });

      let output = '';
      child.stdout.on('data', (data) => {
        output += data.toString();
      });

      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          diagnostics.childProcess.canSpawn = true;
          diagnostics.childProcess.spawnTest = {
            success: true,
            output: output.trim(),
          };
          resolve(true);
        } else {
          reject(new Error(`Exit code: ${code}`));
        }
      });
    });

    diagnostics.sdk.checks.push({
      test: 'Can spawn child processes',
      success: true,
    });
  } catch (e: any) {
    diagnostics.childProcess.spawnTest = {
      success: false,
      error: e.message,
    };
    diagnostics.sdk.checks.push({
      test: 'Can spawn child processes',
      success: false,
      error: e.message,
    });
  }

  // 3. Test SDK import (not execution)
  try {
    const { query } = require('@anthropic-ai/claude-agent-sdk');
    diagnostics.sdk.checks.push({
      test: 'SDK import successful',
      success: true,
      hasQuery: typeof query === 'function',
    });
  } catch (e: any) {
    diagnostics.sdk.checks.push({
      test: 'SDK import successful',
      success: false,
      error: e.message,
      stack: e.stack,
    });
  }

  // 4. Check file system permissions
  const testDir = '/tmp/sdk-test-' + Date.now();
  try {
    fs.mkdirSync(testDir);
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'test');
    fs.rmSync(testDir, { recursive: true });
    diagnostics.sdk.checks.push({
      test: 'File system write permissions',
      success: true,
      testPath: testDir,
    });
  } catch (e: any) {
    diagnostics.sdk.checks.push({
      test: 'File system write permissions',
      success: false,
      error: e.message,
    });
  }

  // 5. Test minimal SDK execution (if API key exists)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { query } = require('@anthropic-ai/claude-agent-sdk');

      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('SDK query timeout after 10s')), 10000);
      });

      // Create SDK test promise
      const sdkTestPromise = new Promise(async (resolve, reject) => {
        try {
          console.log('🧪 [SDK Health] Starting SDK query test...');

          const stream = query({
            prompt: 'Reply with exactly: OK',
            options: {
              cwd: process.cwd(),
              model: 'claude-haiku-4-5-20251001',
              maxTurns: 1,
              permissionMode: 'bypassPermissions',
              env: {
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
                PATH: process.env.PATH,
                HOME: process.env.HOME || '/tmp',
              },
            },
          });

          let messageCount = 0;
          let errorFound = false;
          let errorDetail = null;

          for await (const message of stream) {
            messageCount++;

            if ((message as any).is_error) {
              errorFound = true;
              errorDetail = {
                type: message.type,
                result: (message as any).result,
                message: (message as any).error || (message as any).error_message,
              };
            }

            if (message.type === 'result') {
              if (errorFound) {
                reject(new Error(`SDK error: ${JSON.stringify(errorDetail)}`));
              } else {
                resolve({ success: true, messageCount });
              }
              return;
            }
          }
        } catch (e: any) {
          reject(e);
        }
      });

      // Race between timeout and SDK test
      const result = await Promise.race([sdkTestPromise, timeoutPromise]);

      diagnostics.sdk.checks.push({
        test: 'SDK query execution',
        success: true,
        result,
      });
    } catch (e: any) {
      diagnostics.sdk.checks.push({
        test: 'SDK query execution',
        success: false,
        error: e.message,
        isTimeout: e.message.includes('timeout'),
        stack: e.stack?.split('\n').slice(0, 5).join('\n'),
      });
    }
  } else {
    diagnostics.sdk.checks.push({
      test: 'SDK query execution',
      success: false,
      error: 'No API key configured',
    });
  }

  // Calculate overall health
  const totalChecks = diagnostics.sdk.checks.length;
  const successfulChecks = diagnostics.sdk.checks.filter((c: any) => c.success).length;
  const healthScore = Math.round((successfulChecks / totalChecks) * 100);

  diagnostics.summary = {
    healthScore,
    totalChecks,
    successfulChecks,
    failedChecks: totalChecks - successfulChecks,
    status: healthScore === 100 ? 'healthy' : healthScore >= 60 ? 'degraded' : 'unhealthy',
    recommendation: getRecommendation(diagnostics),
  };

  // Return appropriate status code
  const statusCode = healthScore === 100 ? 200 : healthScore >= 60 ? 206 : 503;

  res.status(statusCode).json({
    success: healthScore >= 60,
    diagnostics,
  });
});

function getRecommendation(diagnostics: any): string {
  const failed = diagnostics.sdk.checks.filter((c: any) => !c.success);

  if (failed.length === 0) {
    return 'SDK is fully operational';
  }

  const recommendations: string[] = [];

  if (failed.some((c: any) => c.test === 'Can spawn child processes')) {
    recommendations.push('Child process spawning failed - this is critical for SDK operation on Render');
  }

  if (failed.some((c: any) => c.test === 'SDK query execution')) {
    const execCheck = failed.find((c: any) => c.test === 'SDK query execution');
    if (execCheck?.isTimeout) {
      recommendations.push('SDK query timed out - possible network or resource constraints');
    } else {
      recommendations.push('SDK query failed - check logs for detailed error');
    }
  }

  if (diagnostics.environment.memory.freeMB < 512) {
    recommendations.push(`Low memory: ${diagnostics.environment.memory.freeMB}MB free - consider upgrading Render instance`);
  }

  return recommendations.join('; ');
}

export default router;