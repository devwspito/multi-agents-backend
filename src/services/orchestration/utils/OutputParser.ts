/**
 * Shared utility for parsing structured output from agents
 * Handles JSON extraction, validation, and fallback strategies
 */

export interface ParseResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  rawOutput: string;
}

export class OutputParser {
  /**
   * Extract JSON from various formats
   */
  static extractJSON(output: string): ParseResult {
    const patterns = [
      /```json\n?([\s\S]*?)\n?```/,
      /```\n?([\s\S]*?)\n?```/,
      /(\{[\s\S]*\})/,
      /(\[[\s\S]*\])/
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        try {
          const jsonStr = match[1].trim();
          const data = JSON.parse(jsonStr);
          return { success: true, data, rawOutput: output };
        } catch (e) {
          continue;
        }
      }
    }

    // Try parsing entire output as JSON
    try {
      const data = JSON.parse(output.trim());
      return { success: true, data, rawOutput: output };
    } catch (e) {
      return {
        success: false,
        error: 'No valid JSON found in output',
        rawOutput: output
      };
    }
  }

  /**
   * Parse and validate structured output with schema
   */
  static parseWithSchema<T>(output: string, schema: any): ParseResult<T> {
    const result = this.extractJSON(output);
    if (!result.success) return result as ParseResult<T>;

    // Basic schema validation
    const validation = this.validateSchema(result.data, schema);
    if (!validation.valid) {
      return {
        success: false,
        error: `Schema validation failed: ${validation.errors.join(', ')}`,
        rawOutput: output
      };
    }

    return result as ParseResult<T>;
  }

  /**
   * Simple schema validation
   */
  private static validateSchema(data: any, schema: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties as any)) {
        if (key in data && prop.type) {
          const actualType = Array.isArray(data[key]) ? 'array' : typeof data[key];
          if (actualType !== prop.type && !(prop.type === 'array' && Array.isArray(data[key]))) {
            errors.push(`Field ${key} should be ${prop.type} but is ${actualType}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Extract specific patterns from text output
   */
  static extractPatterns(output: string, patterns: Record<string, RegExp>): Record<string, string | null> {
    const results: Record<string, string | null> = {};

    for (const [key, pattern] of Object.entries(patterns)) {
      const match = output.match(pattern);
      results[key] = match ? match[1] || match[0] : null;
    }

    return results;
  }

  /**
   * Parse decision-based output (GO/NO-GO, PASS/FAIL, etc)
   */
  static parseDecision(output: string): {
    decision: 'GO' | 'NO-GO' | 'UNKNOWN';
    confidence: number;
    reasons: string[];
  } {
    const lowerOutput = output.toLowerCase();

    // Check for explicit decision
    const goPatterns = [/decision:\s*go/i, /approved/i, /✅/];
    const noGoPatterns = [/decision:\s*no-?go/i, /rejected/i, /failed/i, /❌/];

    let decision: 'GO' | 'NO-GO' | 'UNKNOWN' = 'UNKNOWN';
    let confidence = 0;

    if (goPatterns.some(p => p.test(output))) {
      decision = 'GO';
      confidence = 0.9;
    } else if (noGoPatterns.some(p => p.test(output))) {
      decision = 'NO-GO';
      confidence = 0.9;
    }

    // Extract reasons
    const reasons: string[] = [];
    const reasonPattern = /(?:reason|because|due to|error|issue):\s*([^\n]+)/gi;
    let match;
    while ((match = reasonPattern.exec(output)) !== null) {
      reasons.push(match[1].trim());
    }

    return { decision, confidence, reasons };
  }

  /**
   * Parse test results from output
   */
  static parseTestResults(output: string): {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
    failedTests: string[];
  } {
    const result = {
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      failedTests: [] as string[]
    };

    // Common test output patterns
    const patterns = {
      jest: /Tests:\s*(\d+)\s*failed[,\s]*(\d+)\s*passed[,\s]*(\d+)\s*total/i,
      mocha: /(\d+)\s*passing.*(\d+)\s*failing/i,
      generic: /(\d+)\s*pass.*(\d+)\s*fail/i
    };

    for (const [_, pattern] of Object.entries(patterns)) {
      const match = output.match(pattern);
      if (match) {
        if (match[1]) result.failed = parseInt(match[1]);
        if (match[2]) result.passed = parseInt(match[2]);
        if (match[3]) result.total = parseInt(match[3]);
        break;
      }
    }

    // Extract failed test names
    const failedPattern = /(?:FAIL|✗|×)\s+([^\n]+)/g;
    let failMatch;
    while ((failMatch = failedPattern.exec(output)) !== null) {
      result.failedTests.push(failMatch[1].trim());
    }

    return result;
  }

  /**
   * Clean and format output for storage
   */
  static cleanOutput(output: string, maxLength = 5000): string {
    // Remove ANSI escape codes
    let cleaned = output.replace(/\u001b\[[0-9;]*m/g, '');

    // Remove excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Truncate if needed
    if (cleaned.length > maxLength) {
      cleaned = cleaned.substring(0, maxLength) + '\n\n... (truncated)';
    }

    return cleaned.trim();
  }
}