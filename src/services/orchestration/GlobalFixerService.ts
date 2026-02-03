/**
 * GlobalFixerService
 *
 * Last-resort error recovery service that intercepts phase failures
 * BEFORE marking the task as failed.
 *
 * Uses OPUS for maximum intelligence in recovery attempts.
 *
 * Key principles:
 * - Last resort only (after phase's own retry logic fails)
 * - Max 2 attempts per phase to prevent infinite loops
 * - Tracked in SQLite for persistence across restarts
 */

import Anthropic from '@anthropic-ai/sdk';
import { MODEL_IDS } from '../../config/ModelConfigurations';
import { EnhancedJSONExtractor } from './utils/EnhancedJSONExtractor';
import { safeJSONParse } from './utils/OutputParser';
import db from '../../database/index';
import { generateId, now } from '../../database/utils';

// Types
export type FixableErrorType =
  | 'json_parsing'
  | 'validation'
  | 'timeout'
  | 'code_error'
  | 'unknown';

export interface FixAttemptRecord {
  id: string;
  taskId: string;
  phaseName: string;
  attemptCount: number;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

export interface FixResult {
  fixed: boolean;
  data?: any;
  error?: string;
  method?: string;
  attemptsMade: number;
}

// Initialize SQLite table for tracking fix attempts
function initializeFixerTable(): void {
  const createTable = `
    CREATE TABLE IF NOT EXISTS fixer_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      phase_name TEXT NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(task_id, phase_name)
    )
  `;
  db.exec(createTable);

  // Create index for faster lookups
  const createIndex = `
    CREATE INDEX IF NOT EXISTS idx_fixer_attempts_task_phase
    ON fixer_attempts(task_id, phase_name)
  `;
  db.exec(createIndex);
}

// Initialize table on module load
initializeFixerTable();

export class GlobalFixerService {
  private static readonly MAX_ATTEMPTS = 2;
  private static readonly MODEL = MODEL_IDS.OPUS; // Always use OPUS for fixer

  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic();
  }

  /**
   * Main entry point: Attempt to fix a phase failure
   */
  async attemptFix(
    taskId: string,
    phaseName: string,
    error: string,
    rawOutput?: string,
    requiredFields?: string[]
  ): Promise<FixResult> {
    console.log(`\n🔧 [GlobalFixer] Attempting to fix ${phaseName} failure...`);
    console.log(`🔧 [GlobalFixer] Error: ${error.substring(0, 200)}...`);

    // Check attempt count
    const attemptCount = this.getAttemptCount(taskId, phaseName);
    if (attemptCount >= GlobalFixerService.MAX_ATTEMPTS) {
      console.log(`🔧 [GlobalFixer] Max attempts (${GlobalFixerService.MAX_ATTEMPTS}) reached for ${phaseName}. Cannot fix.`);
      return {
        fixed: false,
        error: `Max fix attempts (${GlobalFixerService.MAX_ATTEMPTS}) reached`,
        attemptsMade: attemptCount,
      };
    }

    // Record this attempt
    this.recordAttempt(taskId, phaseName, error);
    const currentAttempt = attemptCount + 1;

    console.log(`🔧 [GlobalFixer] Attempt ${currentAttempt}/${GlobalFixerService.MAX_ATTEMPTS} using OPUS`);

    // Determine error type and strategy
    const errorType = this.classifyError(error, rawOutput);
    console.log(`🔧 [GlobalFixer] Error type: ${errorType}`);

    try {
      switch (errorType) {
        case 'json_parsing':
          if (!rawOutput) {
            return {
              fixed: false,
              error: 'No raw output available for JSON parsing fix',
              attemptsMade: currentAttempt,
            };
          }
          return await this.fixJSONParsing(rawOutput, requiredFields || ['epics'], currentAttempt);

        case 'validation':
          return await this.fixValidationError(error, rawOutput, requiredFields || [], currentAttempt);

        case 'timeout':
          // Timeouts should be handled by FailedExecutionRetryService
          console.log(`🔧 [GlobalFixer] Timeout errors are handled by FailedExecutionRetryService`);
          return {
            fixed: false,
            error: 'Timeout errors are handled by retry service',
            attemptsMade: currentAttempt,
          };

        default:
          return await this.fixGenericError(error, rawOutput, currentAttempt);
      }
    } catch (fixError: any) {
      console.error(`🔧 [GlobalFixer] Fix attempt failed:`, fixError.message);
      return {
        fixed: false,
        error: `Fixer error: ${fixError.message}`,
        attemptsMade: currentAttempt,
      };
    }
  }

  /**
   * Classify the error type to determine fix strategy
   */
  private classifyError(error: string, _rawOutput?: string): FixableErrorType {
    const errorLower = error.toLowerCase();

    // JSON parsing errors
    if (
      errorLower.includes('json') ||
      errorLower.includes('parse') ||
      errorLower.includes('valid epics') ||
      errorLower.includes('extraction')
    ) {
      return 'json_parsing';
    }

    // Validation errors
    if (
      errorLower.includes('validation') ||
      errorLower.includes('missing') ||
      errorLower.includes('required')
    ) {
      return 'validation';
    }

    // Timeout errors
    if (
      errorLower.includes('timeout') ||
      errorLower.includes('timed out')
    ) {
      return 'timeout';
    }

    return 'unknown';
  }

  /**
   * Fix JSON parsing failure using OPUS
   *
   * Strategy: Ask OPUS to extract the JSON from the raw output
   */
  private async fixJSONParsing(
    rawOutput: string,
    requiredFields: string[],
    attemptNumber: number
  ): Promise<FixResult> {
    console.log(`🔧 [GlobalFixer] Attempting JSON extraction with OPUS...`);

    // First, try EnhancedJSONExtractor one more time with more lenient settings
    const extractResult = EnhancedJSONExtractor.extract(rawOutput, {
      requiredFields: [],  // Don't require fields, just extract any valid JSON
      flexibleFields: requiredFields,
      verbose: true,
    });

    if (extractResult.success && extractResult.data) {
      // Check if we have the required fields (flexible search)
      let hasAllFields = true;
      for (const field of requiredFields) {
        const value = EnhancedJSONExtractor.findFieldAtAnyLevel(extractResult.data, field);
        if (!value || (Array.isArray(value) && value.length === 0)) {
          hasAllFields = false;
          break;
        }
      }

      if (hasAllFields) {
        console.log(`🔧 [GlobalFixer] EnhancedJSONExtractor succeeded on second pass!`);
        return {
          fixed: true,
          data: extractResult.data,
          method: 'enhanced_extractor_lenient',
          attemptsMade: attemptNumber,
        };
      }
    }

    // If EnhancedJSONExtractor still fails, use OPUS to extract
    console.log(`🔧 [GlobalFixer] Using OPUS to extract JSON...`);

    const prompt = `You are a JSON extraction specialist. Extract the JSON object from the following text.

The JSON should contain these fields: ${requiredFields.join(', ')}

RULES:
1. Return ONLY the JSON object, nothing else
2. Do NOT add any explanation or text
3. If the JSON is malformed, fix it
4. If fields are missing, return what you can find
5. Start your response with { and end with }

TEXT TO EXTRACT FROM:
---
${rawOutput.substring(0, 50000)}
---

JSON:`;

    try {
      const response = await this.anthropic.messages.create({
        model: GlobalFixerService.MODEL,
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        return {
          fixed: false,
          error: 'OPUS returned non-text response',
          attemptsMade: attemptNumber,
        };
      }

      const opusOutput = content.text.trim();

      // Try to parse OPUS output
      const opusExtract = EnhancedJSONExtractor.extract(opusOutput, {
        requiredFields,
        verbose: true,
      });

      if (opusExtract.success) {
        console.log(`✅ [GlobalFixer] OPUS successfully extracted JSON!`);
        return {
          fixed: true,
          data: opusExtract.data,
          method: 'opus_extraction',
          attemptsMade: attemptNumber,
        };
      }

      // Last resort: try direct parse
      try {
        const directParse = safeJSONParse(opusOutput);
        console.log(`✅ [GlobalFixer] OPUS output parsed directly!`);
        return {
          fixed: true,
          data: directParse,
          method: 'opus_direct_parse',
          attemptsMade: attemptNumber,
        };
      } catch {
        return {
          fixed: false,
          error: 'OPUS extraction did not produce valid JSON',
          attemptsMade: attemptNumber,
        };
      }
    } catch (apiError: any) {
      console.error(`🔧 [GlobalFixer] OPUS API error:`, apiError.message);
      return {
        fixed: false,
        error: `OPUS API error: ${apiError.message}`,
        attemptsMade: attemptNumber,
      };
    }
  }

  /**
   * Fix validation errors using OPUS
   */
  private async fixValidationError(
    error: string,
    rawOutput: string | undefined,
    requiredFields: string[],
    attemptNumber: number
  ): Promise<FixResult> {
    console.log(`🔧 [GlobalFixer] Attempting to fix validation error with OPUS...`);

    // If we have raw output, try to complete the missing parts
    if (rawOutput) {
      const prompt = `You are fixing a validation error in JSON output.

ERROR: ${error}

The JSON is missing required fields: ${requiredFields.join(', ')}

ORIGINAL OUTPUT:
---
${rawOutput.substring(0, 30000)}
---

RULES:
1. Return a COMPLETE JSON object with ALL required fields
2. Keep existing data intact
3. Add missing fields with reasonable default values based on context
4. Return ONLY JSON, no explanation

FIXED JSON:`;

      try {
        const response = await this.anthropic.messages.create({
          model: GlobalFixerService.MODEL,
          max_tokens: 16000,
          messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
          const fixedOutput = content.text.trim();
          const parseResult = EnhancedJSONExtractor.extract(fixedOutput, {
            requiredFields,
            verbose: true,
          });

          if (parseResult.success) {
            console.log(`✅ [GlobalFixer] OPUS fixed validation error!`);
            return {
              fixed: true,
              data: parseResult.data,
              method: 'opus_validation_fix',
              attemptsMade: attemptNumber,
            };
          }
        }
      } catch (apiError: any) {
        console.error(`🔧 [GlobalFixer] OPUS API error:`, apiError.message);
      }
    }

    return {
      fixed: false,
      error: 'Could not fix validation error',
      attemptsMade: attemptNumber,
    };
  }

  /**
   * Fix generic errors using OPUS
   */
  private async fixGenericError(
    error: string,
    rawOutput: string | undefined,
    attemptNumber: number
  ): Promise<FixResult> {
    console.log(`🔧 [GlobalFixer] Attempting to fix generic error with OPUS...`);

    // For generic errors, we can't do much without more context
    // But if we have raw output, try to extract whatever is there
    if (rawOutput) {
      const extractResult = EnhancedJSONExtractor.extract(rawOutput, {
        requiredFields: [],
        verbose: true,
      });

      if (extractResult.success && extractResult.data) {
        console.log(`✅ [GlobalFixer] Extracted partial data from raw output`);
        return {
          fixed: true,
          data: extractResult.data,
          method: 'partial_extraction',
          attemptsMade: attemptNumber,
        };
      }
    }

    return {
      fixed: false,
      error: `Generic error cannot be fixed: ${error.substring(0, 100)}`,
      attemptsMade: attemptNumber,
    };
  }

  /**
   * Get current attempt count for a task/phase combination
   */
  private getAttemptCount(taskId: string, phaseName: string): number {
    const stmt = db.prepare(`
      SELECT attempt_count FROM fixer_attempts
      WHERE task_id = ? AND phase_name = ?
    `);
    const row = stmt.get(taskId, phaseName) as { attempt_count: number } | undefined;
    return row?.attempt_count || 0;
  }

  /**
   * Record a fix attempt
   */
  private recordAttempt(taskId: string, phaseName: string, error: string): void {
    const timestamp = now();

    // Upsert attempt record
    const stmt = db.prepare(`
      INSERT INTO fixer_attempts (id, task_id, phase_name, attempt_count, last_error, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(task_id, phase_name) DO UPDATE SET
        attempt_count = attempt_count + 1,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);

    stmt.run(generateId(), taskId, phaseName, error.substring(0, 1000), timestamp, timestamp);
  }

  /**
   * Reset attempt count for a task (called when task restarts)
   */
  static resetAttempts(taskId: string): void {
    const stmt = db.prepare(`DELETE FROM fixer_attempts WHERE task_id = ?`);
    stmt.run(taskId);
    console.log(`🔧 [GlobalFixer] Reset attempts for task ${taskId}`);
  }

  /**
   * Get fixer statistics for a task
   */
  static getStats(taskId: string): FixAttemptRecord[] {
    const stmt = db.prepare(`
      SELECT * FROM fixer_attempts WHERE task_id = ?
    `);
    return stmt.all(taskId) as FixAttemptRecord[];
  }

  /**
   * Cleanup old fixer attempts (older than 7 days)
   */
  static cleanup(daysOld: number = 7): number {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    const stmt = db.prepare(`DELETE FROM fixer_attempts WHERE created_at < ?`);
    const result = stmt.run(cutoff);
    return result.changes;
  }
}

// Export singleton instance
export const globalFixerService = new GlobalFixerService();

export default globalFixerService;
