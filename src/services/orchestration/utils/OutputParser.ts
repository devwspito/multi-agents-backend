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
    // CRITICAL: Strip ANSI codes FIRST before any parsing attempts
    const cleanedOutput = this.stripAnsiCodes(output);

    const patterns = [
      /```json\n?([\s\S]*?)\n?```/,
      /```\n?([\s\S]*?)\n?```/,
      /(\{[\s\S]*\})/,
      /(\[[\s\S]*\])/
    ];

    for (const pattern of patterns) {
      const match = cleanedOutput.match(pattern);
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
      const data = JSON.parse(cleanedOutput.trim());
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
      for (const [key, prop] of Object.entries(schema.properties as Record<string, any>)) {
        if (key in data && prop?.type) {
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
   * Strip ALL ANSI escape sequences from text
   * This is critical for parsing JSON that may contain terminal control codes
   */
  static stripAnsiCodes(text: string): string {
    // Comprehensive ANSI escape sequence patterns:
    // - \x1B[ followed by any parameters and final byte (CSI sequences)
    // - \x1B] followed by OSC sequences (Operating System Commands)
    // - \x1B followed by single character commands
    // - \x9B (8-bit CSI) followed by parameters
    return text
      // CSI sequences: \x1B[ ... <final byte> (includes colors, cursor, modes like ?2026h)
      .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
      // OSC sequences: \x1B] ... ST (string terminator \x1B\\ or \x07)
      .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, '')
      // Single character escapes: \x1B followed by single char
      .replace(/\x1B[NOPXZc^_]/g, '')
      // 8-bit CSI: \x9B ... <final byte>
      .replace(/\x9B[0-9;]*[A-Za-z]/g, '')
      // Any remaining escape sequences
      .replace(/\x1B./g, '')
      // Legacy pattern for good measure
      .replace(/\u001b\[[0-9;]*m/g, '');
  }

  /**
   * Clean and format output for storage
   */
  static cleanOutput(output: string, maxLength = 5000): string {
    // Remove ALL ANSI escape codes (comprehensive)
    let cleaned = this.stripAnsiCodes(output);

    // Remove excessive whitespace
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

    // Truncate if needed
    if (cleaned.length > maxLength) {
      cleaned = cleaned.substring(0, maxLength) + '\n\n... (truncated)';
    }

    return cleaned.trim();
  }

  /**
   * Extract JSON with robust fallback strategies
   *
   * Tries multiple strategies in order:
   * 1. Standard JSON patterns (```json blocks, { }, [ ])
   * 2. Balanced brace matching (handles malformed output)
   * 3. Cleaned output retry (strips markdown, extra text)
   *
   * @param output - Raw agent output
   * @param options - Extraction options
   */
  static extractJSONRobust<T = any>(
    output: string,
    options: {
      /** Field that must exist in result */
      requiredField?: string;
      /** Log extraction attempts */
      verbose?: boolean;
    } = {}
  ): ParseResult<T> {
    const { requiredField, verbose = false } = options;

    if (!output || output.trim().length === 0) {
      return { success: false, error: 'Empty output', rawOutput: output };
    }

    // CRITICAL: Strip ANSI codes FIRST before any parsing attempts
    const cleanedOutput = this.stripAnsiCodes(output);

    // Strategy 1: Standard extraction (already uses cleaned output internally)
    const standardResult = this.extractJSON(cleanedOutput);
    if (standardResult.success) {
      if (!requiredField || (standardResult.data && requiredField in standardResult.data)) {
        return standardResult as ParseResult<T>;
      }
      if (verbose) {
        console.log(`   📋 Standard extraction succeeded but missing required field: ${requiredField}`);
      }
    }

    // Strategy 2: Try brace matching for balanced JSON (on cleaned output)
    const candidates = this.findBalancedJSONBlocks(cleanedOutput);
    if (verbose) {
      console.log(`   📋 Found ${candidates.length} balanced JSON candidates`);
    }

    // Sort by size (largest first - more likely to be complete)
    candidates.sort((a, b) => b.length - a.length);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        if (!requiredField || requiredField in parsed) {
          if (verbose) {
            console.log(`   ✅ Brace-matching extraction succeeded`);
          }
          return { success: true, data: parsed, rawOutput: output };
        }
      } catch (e) {
        // Try next candidate
      }
    }

    // Strategy 3: Strip markdown and try again (on cleaned output)
    const stripped = cleanedOutput
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .replace(/^[^{[]*/, '') // Remove text before JSON
      .replace(/[^\]}]*$/, ''); // Remove text after JSON

    try {
      const parsed = JSON.parse(stripped);
      if (!requiredField || requiredField in parsed) {
        if (verbose) {
          console.log(`   ✅ Stripped extraction succeeded`);
        }
        return { success: true, data: parsed, rawOutput: output };
      }
    } catch (e) {
      // Fall through
    }

    return {
      success: false,
      error: `No valid JSON found${requiredField ? ` with required field '${requiredField}'` : ''}`,
      rawOutput: output,
    };
  }

  /**
   * Find all balanced JSON blocks in output using brace matching
   */
  private static findBalancedJSONBlocks(output: string): string[] {
    const candidates: string[] = [];

    for (let i = 0; i < output.length; i++) {
      if (output[i] === '{' || output[i] === '[') {
        const openChar = output[i];
        const closeChar = openChar === '{' ? '}' : ']';
        let depth = 0;
        let j = i;
        let inString = false;
        let escape = false;

        while (j < output.length) {
          const char = output[j];

          if (escape) {
            escape = false;
            j++;
            continue;
          }

          if (char === '\\') {
            escape = true;
            j++;
            continue;
          }

          if (char === '"') {
            inString = !inString;
            j++;
            continue;
          }

          if (!inString) {
            if (char === openChar) depth++;
            if (char === closeChar) depth--;

            if (depth === 0) {
              const block = output.substring(i, j + 1);
              if (block.length > 10) {
                candidates.push(block);
              }
              break;
            }
          }

          j++;
        }
      }
    }

    return candidates;
  }

  /**
   * Parse epics from agent output
   *
   * Handles various formats agents might use:
   * - JSON with "epics" array
   * - JSON with "plan" containing epics
   * - Direct array of epics
   */
  static parseEpics<T = any>(output: string): ParseResult<T[]> {
    const result = this.extractJSONRobust<any>(output, {
      verbose: true,
    });

    if (!result.success) {
      return { ...result, data: undefined } as ParseResult<T[]>;
    }

    const data = result.data;

    // Handle different structures
    if (Array.isArray(data)) {
      return { success: true, data, rawOutput: output };
    }

    if (data.epics && Array.isArray(data.epics)) {
      return { success: true, data: data.epics, rawOutput: output };
    }

    if (data.plan?.epics && Array.isArray(data.plan.epics)) {
      return { success: true, data: data.plan.epics, rawOutput: output };
    }

    return {
      success: false,
      error: 'Could not find epics array in parsed JSON',
      rawOutput: output,
    };
  }

  /**
   * Parse stories from agent output
   */
  static parseStories<T = any>(output: string): ParseResult<T[]> {
    const result = this.extractJSONRobust<any>(output);

    if (!result.success) {
      return { ...result, data: undefined } as ParseResult<T[]>;
    }

    const data = result.data;

    if (Array.isArray(data)) {
      return { success: true, data, rawOutput: output };
    }

    if (data.stories && Array.isArray(data.stories)) {
      return { success: true, data: data.stories, rawOutput: output };
    }

    if (data.userStories && Array.isArray(data.userStories)) {
      return { success: true, data: data.userStories, rawOutput: output };
    }

    return {
      success: false,
      error: 'Could not find stories array in parsed JSON',
      rawOutput: output,
    };
  }
}