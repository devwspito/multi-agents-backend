/**
 * Secrets Detection Service
 *
 * Implements Anthropic's best practice for preventing accidental
 * exposure of sensitive information in agent outputs.
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface DetectionResult {
  hasSecrets: boolean;
  detectedTypes: string[];
  sanitizedOutput: string;
  secretsCount: number;
}

export class SecretsDetectionService {
  /**
   * Common secret patterns to detect
   */
  private static readonly SECRET_PATTERNS: SecretPattern[] = [
    // API Keys
    {
      name: 'Anthropic API Key',
      pattern: /sk-ant-api\d{2}-[a-zA-Z0-9\-_]{40,}/gi,
      replacement: '[REDACTED_ANTHROPIC_KEY]'
    },
    {
      name: 'OpenAI API Key',
      pattern: /sk-[a-zA-Z0-9]{32,}/gi,
      replacement: '[REDACTED_OPENAI_KEY]'
    },
    {
      name: 'GitHub Personal Access Token',
      pattern: /ghp_[a-zA-Z0-9]{36}/gi,
      replacement: '[REDACTED_GITHUB_TOKEN]'
    },
    {
      name: 'GitHub OAuth Token',
      pattern: /gho_[a-zA-Z0-9]{36}/gi,
      replacement: '[REDACTED_GITHUB_OAUTH]'
    },
    {
      name: 'GitLab Personal Access Token',
      pattern: /glpat-[a-zA-Z0-9\-_]{20}/gi,
      replacement: '[REDACTED_GITLAB_TOKEN]'
    },
    {
      name: 'AWS Access Key',
      pattern: /AKIA[0-9A-Z]{16}/gi,
      replacement: '[REDACTED_AWS_ACCESS_KEY]'
    },
    {
      name: 'AWS Secret Key',
      pattern: /[a-zA-Z0-9/+=]{40}/gi,
      replacement: '[REDACTED_AWS_SECRET]'
    },
    {
      name: 'Google API Key',
      pattern: /AIza[a-zA-Z0-9_\-]{35}/gi,
      replacement: '[REDACTED_GOOGLE_API_KEY]'
    },
    {
      name: 'Stripe API Key',
      pattern: /(sk|pk)_(test|live)_[a-zA-Z0-9]{24,}/gi,
      replacement: '[REDACTED_STRIPE_KEY]'
    },
    {
      name: 'SendGrid API Key',
      pattern: /SG\.[a-zA-Z0-9_\-]{22}\.[a-zA-Z0-9_\-]{43}/gi,
      replacement: '[REDACTED_SENDGRID_KEY]'
    },
    {
      name: 'Twilio Auth Token',
      pattern: /SK[a-z0-9]{32}/gi,
      replacement: '[REDACTED_TWILIO_TOKEN]'
    },
    {
      name: 'Slack Token',
      pattern: /xox[baprs]-[0-9]{10,12}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}/gi,
      replacement: '[REDACTED_SLACK_TOKEN]'
    },

    // Database URLs
    {
      name: 'MongoDB Connection String',
      pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@[^\s]+/gi,
      replacement: 'mongodb://[REDACTED_CREDENTIALS]@[REDACTED_HOST]'
    },
    {
      name: 'PostgreSQL Connection String',
      pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@[^\s]+/gi,
      replacement: 'postgresql://[REDACTED_CREDENTIALS]@[REDACTED_HOST]'
    },
    {
      name: 'MySQL Connection String',
      pattern: /mysql:\/\/[^:]+:[^@]+@[^\s]+/gi,
      replacement: 'mysql://[REDACTED_CREDENTIALS]@[REDACTED_HOST]'
    },
    {
      name: 'Redis Connection String',
      pattern: /redis:\/\/:[^@]+@[^\s]+/gi,
      replacement: 'redis://:[REDACTED_PASSWORD]@[REDACTED_HOST]'
    },

    // JWT Tokens
    {
      name: 'JWT Token',
      pattern: /eyJ[a-zA-Z0-9_\-]+\.eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/gi,
      replacement: '[REDACTED_JWT_TOKEN]'
    },

    // Private Keys
    {
      name: 'RSA Private Key',
      pattern: /-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA )?PRIVATE KEY-----/gi,
      replacement: '[REDACTED_PRIVATE_KEY]'
    },
    {
      name: 'SSH Private Key',
      pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/gi,
      replacement: '[REDACTED_SSH_PRIVATE_KEY]'
    },

    // Environment Variables
    {
      name: 'Environment Variable with Secret',
      pattern: /(PASSWORD|SECRET|KEY|TOKEN|APIKEY|API_KEY|AUTH)=["']?[^\s"']+["']?/gi,
      replacement: '$1=[REDACTED]'
    },

    // Credit Cards
    {
      name: 'Credit Card Number',
      pattern: /\b(?:\d{4}[\s\-]?){3}\d{4}\b/gi,
      replacement: '[REDACTED_CARD_NUMBER]'
    },

    // Email/Password combos
    {
      name: 'Email with Password',
      pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}:[^\s]+/gi,
      replacement: '[REDACTED_EMAIL]:[REDACTED_PASSWORD]'
    },

    // Generic Secrets
    {
      name: 'Hexadecimal Secret',
      pattern: /\b[a-f0-9]{64}\b/gi, // SHA256 hashes, secrets
      replacement: '[REDACTED_HEX_SECRET]'
    },
    {
      name: 'Base64 Encoded Secret',
      pattern: /[A-Za-z0-9+/]{40,}={0,2}/g, // Long base64 strings
      replacement: '[REDACTED_BASE64_SECRET]'
    },
  ];

  /**
   * Detect and sanitize secrets in text
   */
  static detectAndSanitize(text: string): DetectionResult {
    let sanitizedOutput = text;
    const detectedTypes = new Set<string>();
    let secretsCount = 0;

    for (const secretPattern of this.SECRET_PATTERNS) {
      const matches = text.match(secretPattern.pattern);

      if (matches && matches.length > 0) {
        detectedTypes.add(secretPattern.name);
        secretsCount += matches.length;

        // Replace all occurrences
        sanitizedOutput = sanitizedOutput.replace(
          secretPattern.pattern,
          secretPattern.replacement
        );

        console.warn(`🔒 Detected ${matches.length} ${secretPattern.name}(s) - sanitized`);
      }
    }

    return {
      hasSecrets: secretsCount > 0,
      detectedTypes: Array.from(detectedTypes),
      sanitizedOutput,
      secretsCount,
    };
  }

  /**
   * Quick check if text contains secrets
   */
  static hasSecrets(text: string): boolean {
    return this.SECRET_PATTERNS.some(pattern =>
      pattern.pattern.test(text)
    );
  }

  /**
   * Sanitize agent output before storing
   */
  static sanitizeAgentOutput(
    agentType: string,
    output: string
  ): { sanitized: string; warning?: string } {
    const result = this.detectAndSanitize(output);

    if (result.hasSecrets) {
      const warning = `⚠️ [${agentType}] Detected and sanitized ${result.secretsCount} secret(s): ${result.detectedTypes.join(', ')}`;
      console.warn(warning);

      return {
        sanitized: result.sanitizedOutput,
        warning,
      };
    }

    return { sanitized: output };
  }

  /**
   * Validate environment variables don't contain secrets
   */
  static validateEnvironmentVariables(): void {
    const sensitiveEnvVars = [
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'DATABASE_URL',
      'JWT_SECRET',
      'AWS_SECRET_ACCESS_KEY',
    ];

    for (const envVar of sensitiveEnvVars) {
      if (process.env[envVar]) {
        // Check if it's exposed in logs
        if (process.env.LOG_LEVEL === 'debug') {
          console.warn(
            `⚠️ Warning: ${envVar} is set and LOG_LEVEL is debug. Ensure secrets are not logged.`
          );
        }
      }
    }
  }

  /**
   * Create a safe error message (removes secrets from error)
   */
  static sanitizeError(error: Error): Error {
    const sanitized = this.detectAndSanitize(error.message);

    if (sanitized.hasSecrets) {
      const safeError = new Error(sanitized.sanitizedOutput);
      safeError.name = error.name;
      safeError.stack = error.stack ? this.detectAndSanitize(error.stack).sanitizedOutput : undefined;
      return safeError;
    }

    return error;
  }

  /**
   * Sanitize JSON object (recursive)
   */
  static sanitizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return this.detectAndSanitize(obj).sanitizedOutput;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.sanitizeObject(item));
    }

    if (obj && typeof obj === 'object') {
      const sanitized: any = {};

      for (const [key, value] of Object.entries(obj)) {
        // Check if key name suggests sensitive data
        const sensitiveKeys = /password|secret|token|key|auth|credential|private/i;

        if (sensitiveKeys.test(key)) {
          sanitized[key] = '[REDACTED_BY_KEY_NAME]';
        } else {
          sanitized[key] = this.sanitizeObject(value);
        }
      }

      return sanitized;
    }

    return obj;
  }

  /**
   * Add custom secret pattern
   */
  static addCustomPattern(pattern: SecretPattern): void {
    this.SECRET_PATTERNS.push(pattern);
    console.log(`✅ Added custom secret pattern: ${pattern.name}`);
  }

  /**
   * Get statistics about detected secrets
   */
  static getDetectionStats(text: string): {
    totalSecrets: number;
    byType: Record<string, number>;
  } {
    const byType: Record<string, number> = {};
    let totalSecrets = 0;

    for (const pattern of this.SECRET_PATTERNS) {
      const matches = text.match(pattern.pattern);

      if (matches && matches.length > 0) {
        byType[pattern.name] = matches.length;
        totalSecrets += matches.length;
      }
    }

    return { totalSecrets, byType };
  }
}