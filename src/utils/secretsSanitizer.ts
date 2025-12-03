/**
 * SecretsSanitizer: Utility for detecting and sanitizing secrets in text
 *
 * Prevents accidental logging or exposure of sensitive data like:
 * - API keys
 * - Tokens
 * - Passwords
 * - Private keys
 * - Database connection strings
 * - JWT tokens
 */

export interface SecretPattern {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export class SecretsSanitizer {
  // Common secret patterns to detect
  private static readonly PATTERNS: SecretPattern[] = [
    // API Keys
    {
      name: 'Anthropic API Key',
      pattern: /sk-ant-api03-[A-Za-z0-9_-]{95}/gi,
      replacement: 'sk-ant-***REDACTED***',
    },
    {
      name: 'OpenAI API Key',
      pattern: /sk-[A-Za-z0-9]{48}/gi,
      replacement: 'sk-***REDACTED***',
    },
    {
      name: 'Generic API Key',
      pattern: /api[_-]?key[_-]?[:\s]*['"]?([A-Za-z0-9_-]{20,})['"]?/gi,
      replacement: 'api_key: ***REDACTED***',
    },

    // Tokens
    {
      name: 'Bearer Token',
      pattern: /Bearer\s+[A-Za-z0-9_-]{20,}/gi,
      replacement: 'Bearer ***REDACTED***',
    },
    {
      name: 'JWT Token',
      pattern: /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/gi,
      replacement: 'eyJ***REDACTED***',
    },
    {
      name: 'GitHub Token',
      pattern: /gh[pousr]_[A-Za-z0-9]{36}/gi,
      replacement: 'gh***REDACTED***',
    },

    // Passwords
    {
      name: 'Password in connection string',
      pattern: /password[=:]\s*['"]?([^'"\s@]+)['"]?/gi,
      replacement: 'password=***REDACTED***',
    },
    {
      name: 'Password field',
      pattern: /["']password["']\s*:\s*["']([^"']+)["']/gi,
      replacement: '"password": "***REDACTED***"',
    },

    // Database connection strings
    {
      name: 'MongoDB URI',
      pattern: /mongodb(\+srv)?:\/\/([^:]+):([^@]+)@/gi,
      replacement: 'mongodb://$2:***REDACTED***@',
    },
    {
      name: 'PostgreSQL URI',
      pattern: /postgres(?:ql)?:\/\/([^:]+):([^@]+)@/gi,
      replacement: 'postgresql://$1:***REDACTED***@',
    },
    {
      name: 'MySQL URI',
      pattern: /mysql:\/\/([^:]+):([^@]+)@/gi,
      replacement: 'mysql://$1:***REDACTED***@',
    },

    // AWS Credentials
    {
      name: 'AWS Access Key',
      pattern: /AKIA[0-9A-Z]{16}/gi,
      replacement: 'AKIA***REDACTED***',
    },
    {
      name: 'AWS Secret Key',
      pattern: /aws[_-]?secret[_-]?access[_-]?key[_-]?[:\s]*['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
      replacement: 'aws_secret_access_key: ***REDACTED***',
    },

    // Private Keys
    {
      name: 'RSA Private Key',
      pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/gi,
      replacement: '-----BEGIN RSA PRIVATE KEY-----\n***REDACTED***\n-----END RSA PRIVATE KEY-----',
    },
    {
      name: 'Private Key',
      pattern: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/gi,
      replacement: '-----BEGIN PRIVATE KEY-----\n***REDACTED***\n-----END PRIVATE KEY-----',
    },

    // Credit Cards (PCI Compliance)
    {
      name: 'Credit Card',
      pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
      replacement: '****-****-****-****',
    },

    // Email addresses in sensitive contexts
    {
      name: 'Email in auth context',
      pattern: /["']email["']\s*:\s*["']([^"'@]+@[^"']+)["']/gi,
      replacement: '"email": "***REDACTED***"',
    },
  ];

  /**
   * Sanitize text by replacing all detected secrets with redacted placeholders
   */
  static sanitize(text: string): string {
    let sanitized = text;

    for (const pattern of SecretsSanitizer.PATTERNS) {
      sanitized = sanitized.replace(pattern.pattern, pattern.replacement);
    }

    return sanitized;
  }

  /**
   * Sanitize an object by recursively sanitizing all string values
   */
  static sanitizeObject(obj: any): any {
    if (typeof obj === 'string') {
      return SecretsSanitizer.sanitize(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => SecretsSanitizer.sanitizeObject(item));
    }

    if (obj && typeof obj === 'object') {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(obj)) {
        // Also check if key name suggests it's a secret
        if (SecretsSanitizer.isSecretKey(key)) {
          sanitized[key] = '***REDACTED***';
        } else {
          sanitized[key] = SecretsSanitizer.sanitizeObject(value);
        }
      }
      return sanitized;
    }

    return obj;
  }

  /**
   * Check if a key name suggests it contains a secret
   */
  static isSecretKey(key: string): boolean {
    const lowerKey = key.toLowerCase();
    const secretKeywords = [
      'password',
      'passwd',
      'pwd',
      'secret',
      'token',
      'apikey',
      'api_key',
      'auth',
      'credential',
      'private',
      'jwt',
      'session',
    ];

    return secretKeywords.some((keyword) => lowerKey.includes(keyword));
  }

  /**
   * Detect if text contains potential secrets
   * Returns array of detected secret types
   */
  static detectSecrets(text: string): string[] {
    const detected: string[] = [];

    for (const pattern of SecretsSanitizer.PATTERNS) {
      if (pattern.pattern.test(text)) {
        detected.push(pattern.name);
        // Reset regex lastIndex after test
        pattern.pattern.lastIndex = 0;
      }
    }

    return detected;
  }

  /**
   * Check if text contains any secrets
   */
  static containsSecrets(text: string): boolean {
    return SecretsSanitizer.detectSecrets(text).length > 0;
  }

  /**
   * Sanitize environment variables object
   */
  static sanitizeEnv(env: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {};

    for (const [key, value] of Object.entries(env)) {
      if (SecretsSanitizer.isSecretKey(key)) {
        sanitized[key] = '***REDACTED***';
      } else {
        sanitized[key] = SecretsSanitizer.sanitize(value);
      }
    }

    return sanitized;
  }

  /**
   * Sanitize command line arguments
   * Particularly important for commands that may include secrets as flags
   */
  static sanitizeCommand(command: string): string {
    // Sanitize common patterns in commands
    let sanitized = command;

    // -p password, --password=secret, etc.
    sanitized = sanitized.replace(
      /(--?(?:password|passwd|pwd|token|key|secret)(?:=|\s+))(['"]?)([^\s'"]+)\2/gi,
      '$1***REDACTED***'
    );

    // Environment variable assignments: KEY=value
    sanitized = sanitized.replace(
      /([A-Z_]+(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[=])(['"]?)([^\s'"]+)\2/gi,
      '$1***REDACTED***'
    );

    // Apply general sanitization
    sanitized = SecretsSanitizer.sanitize(sanitized);

    return sanitized;
  }

  /**
   * Create a safe log entry by sanitizing the message and metadata
   */
  static createSafeLogEntry(message: string, metadata?: any): { message: string; metadata?: any } {
    return {
      message: SecretsSanitizer.sanitize(message),
      metadata: metadata ? SecretsSanitizer.sanitizeObject(metadata) : undefined,
    };
  }

  /**
   * Sanitize URLs (often contain tokens in query params or auth)
   */
  static sanitizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);

      // Sanitize username/password in URL
      if (urlObj.username || urlObj.password) {
        urlObj.username = urlObj.username ? '***REDACTED***' : '';
        urlObj.password = urlObj.password ? '***REDACTED***' : '';
      }

      // Sanitize sensitive query parameters
      const sensitiveParams = ['token', 'key', 'secret', 'password', 'auth', 'apikey', 'api_key'];
      for (const param of sensitiveParams) {
        if (urlObj.searchParams.has(param)) {
          urlObj.searchParams.set(param, '***REDACTED***');
        }
      }

      return urlObj.toString();
    } catch {
      // If URL parsing fails, apply general sanitization
      return SecretsSanitizer.sanitize(url);
    }
  }
}
