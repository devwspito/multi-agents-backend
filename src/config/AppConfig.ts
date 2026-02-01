/**
 * AppConfig
 *
 * Centralized application configuration from environment variables.
 * Replaces scattered process.env access across the codebase.
 *
 * Usage:
 *   import { AppConfig } from '../config/AppConfig';
 *   const workspaceDir = AppConfig.workspace.dir;
 *   const apiKey = AppConfig.anthropic.apiKey;
 *
 * Benefits:
 * - Single source of truth for all config values
 * - Type-safe access with defaults
 * - Validation on startup
 * - Easy to mock in tests
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Environment mode
 */
export type EnvMode = 'development' | 'production' | 'test';

/**
 * Get current environment mode
 */
function getEnvMode(): EnvMode {
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  return 'development';
}

/**
 * Parse boolean environment variable
 */
function parseBool(value: string | undefined, defaultValue: boolean = false): boolean {
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse integer environment variable
 */
function parseInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Application Configuration
 */
export const AppConfig = {
  /**
   * Current environment mode
   */
  env: getEnvMode(),

  /**
   * Whether running in production
   */
  isProduction: getEnvMode() === 'production',

  /**
   * Whether running in development
   */
  isDevelopment: getEnvMode() === 'development',

  /**
   * Whether running in test mode
   */
  isTest: getEnvMode() === 'test',

  /**
   * Server configuration
   */
  server: {
    port: parseInt(process.env.PORT, 3001),
    host: process.env.HOST || '0.0.0.0',
  },

  /**
   * Workspace configuration
   */
  workspace: {
    /**
     * Base directory for agent workspaces
     * Default: system temp directory + 'agent-workspace'
     */
    get dir(): string {
      return process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    },

    /**
     * Home-based workspace directory (for persistent storage)
     */
    get homeDir(): string {
      return path.join(os.homedir(), '.agent-workspace');
    },

    /**
     * Get workspace path for a specific task
     */
    getTaskDir(taskId: string): string {
      return path.join(this.dir, `task-${taskId}`);
    },
  },

  /**
   * Anthropic API configuration
   */
  anthropic: {
    /**
     * API key for Anthropic
     */
    get apiKey(): string | undefined {
      return process.env.ANTHROPIC_API_KEY;
    },

    /**
     * Whether API key is configured
     */
    get isConfigured(): boolean {
      return !!process.env.ANTHROPIC_API_KEY;
    },

    /**
     * Get masked API key for display
     */
    get maskedKey(): string {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return 'NOT_SET';
      if (key.length <= 8) return '****';
      return `${key.substring(0, 4)}****${key.substring(key.length - 4)}`;
    },
  },

  /**
   * Docker/Sandbox configuration
   */
  docker: {
    /**
     * Whether to use bridge network mode (vs host mode)
     * Default: false (use host mode)
     */
    get useBridgeMode(): boolean {
      return parseBool(process.env.DOCKER_USE_BRIDGE_MODE, false);
    },

    /**
     * Whether running in host network mode (no port mapping needed)
     */
    get useHostNetwork(): boolean {
      return !this.useBridgeMode;
    },

    /**
     * Default sandbox image
     */
    get sandboxImage(): string {
      return process.env.SANDBOX_IMAGE || 'agent-sandbox:latest';
    },
  },

  /**
   * Git configuration
   */
  git: {
    /**
     * Whether git timeouts are enabled
     */
    get enableTimeouts(): boolean {
      return parseBool(process.env.GIT_ENABLE_TIMEOUTS, false);
    },

    /**
     * GitHub token for API access
     */
    get githubToken(): string | undefined {
      return process.env.GITHUB_TOKEN;
    },

    /**
     * Whether GitHub is configured
     */
    get isGithubConfigured(): boolean {
      return !!process.env.GITHUB_TOKEN;
    },
  },

  /**
   * Database configuration
   */
  database: {
    /**
     * MongoDB URI
     */
    get mongoUri(): string | undefined {
      return process.env.MONGODB_URI;
    },

    /**
     * Redis URL
     */
    get redisUrl(): string | undefined {
      return process.env.REDIS_URL;
    },

    /**
     * SQLite database path
     */
    get sqlitePath(): string {
      return process.env.SQLITE_PATH || './data/orchestration.db';
    },
  },

  /**
   * Firebase/Storage configuration
   */
  storage: {
    /**
     * Firebase storage bucket
     */
    get firebaseBucket(): string | undefined {
      return process.env.FIREBASE_STORAGE_BUCKET;
    },
  },

  /**
   * Logging configuration
   */
  logging: {
    /**
     * Log level: debug, info, warn, error
     */
    get level(): 'debug' | 'info' | 'warn' | 'error' {
      const level = process.env.LOG_LEVEL?.toLowerCase();
      if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
        return level;
      }
      return 'info';
    },

    /**
     * Whether debug logging is enabled
     */
    get isDebug(): boolean {
      return this.level === 'debug' || parseBool(process.env.DEBUG, false);
    },

    /**
     * Whether to include timestamps in logs
     */
    get includeTimestamps(): boolean {
      return parseBool(process.env.LOG_TIMESTAMPS, false);
    },
  },

  /**
   * Cost/Budget configuration
   */
  budget: {
    /**
     * Maximum cost per task in USD
     */
    get maxCostPerTask(): number {
      return parseFloat(process.env.MAX_COST_PER_TASK || '10.00');
    },

    /**
     * Cost warning threshold (percentage)
     */
    get warningThreshold(): number {
      return parseInt(process.env.COST_WARNING_THRESHOLD, 80);
    },
  },

  /**
   * Feature flags
   */
  features: {
    /**
     * Enable auto-merge for approved PRs
     */
    get autoMergeEnabled(): boolean {
      return parseBool(process.env.ENABLE_AUTO_MERGE, false);
    },

    /**
     * Enable Team-Lite mode
     */
    get teamLiteEnabled(): boolean {
      return parseBool(process.env.ENABLE_TEAM_LITE, true);
    },

    /**
     * Enable preview proxy
     */
    get previewEnabled(): boolean {
      return parseBool(process.env.ENABLE_PREVIEW, true);
    },
  },

  /**
   * Validate required configuration
   * Call on startup to fail fast if config is missing
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check required config based on environment
    if (this.isProduction) {
      if (!this.anthropic.apiKey) {
        errors.push('ANTHROPIC_API_KEY is required in production');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },

  /**
   * Get configuration summary for logging
   */
  getSummary(): Record<string, any> {
    return {
      env: this.env,
      server: {
        port: this.server.port,
        host: this.server.host,
      },
      workspace: {
        dir: this.workspace.dir,
      },
      anthropic: {
        configured: this.anthropic.isConfigured,
        key: this.anthropic.maskedKey,
      },
      docker: {
        useBridgeMode: this.docker.useBridgeMode,
      },
      git: {
        enableTimeouts: this.git.enableTimeouts,
        githubConfigured: this.git.isGithubConfigured,
      },
      logging: {
        level: this.logging.level,
        debug: this.logging.isDebug,
      },
    };
  },
};

// Export type for use in other files
export type AppConfigType = typeof AppConfig;

export default AppConfig;
