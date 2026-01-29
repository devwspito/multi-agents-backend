/**
 * EnhancedJSONExtractor
 *
 * Robust JSON extraction with multiple strategies and diagnostics.
 * Handles common LLM output issues like text before/after JSON.
 */

export interface ExtractionResult<T = any> {
  success: boolean;
  data?: T;
  method?: 'pure_json' | 'markdown_block' | 'brace_matching' | 'text_stripped';
  error?: string;
  rawOutput?: string;
  diagnostics?: {
    inputLength: number;
    jsonCandidatesFound: number;
    textBeforeJson?: string;
    textAfterJson?: string;
    missingFields?: string[];
    foundFields?: string[];
    parseErrors?: string[];
  };
}

export interface ExtractionOptions {
  requiredFields?: string[];      // Fields that MUST exist at top level
  flexibleFields?: string[];      // Fields that can be at any nesting level
  verbose?: boolean;              // Log extraction attempts
}

export class EnhancedJSONExtractor {
  /**
   * Extract JSON with multiple strategies and good diagnostics
   */
  static extract<T = any>(
    output: string,
    options: ExtractionOptions = {}
  ): ExtractionResult<T> {
    const { requiredFields = [], flexibleFields = [], verbose = false } = options;
    const diagnostics: ExtractionResult['diagnostics'] = {
      inputLength: output.length,
      jsonCandidatesFound: 0,
      parseErrors: [],
    };

    if (verbose) {
      console.log(`\n[EnhancedJSONExtractor] Parsing output (${output.length} chars)...`);
    }

    // STEP 1: Try pure JSON (trimmed)
    const pureResult = this.tryPureJSON<T>(output, requiredFields, verbose);
    if (pureResult) {
      return {
        success: true,
        data: pureResult,
        method: 'pure_json',
        diagnostics,
      };
    }

    // STEP 2: Try markdown code blocks
    const markdownResult = this.tryMarkdownBlocks<T>(output, requiredFields, verbose, diagnostics);
    if (markdownResult) {
      return {
        success: true,
        data: markdownResult,
        method: 'markdown_block',
        diagnostics,
      };
    }

    // STEP 3: Strip text before first { and after last } (simple approach)
    const strippedResult = this.tryStripPreamble<T>(output, requiredFields, verbose, diagnostics);
    if (strippedResult) {
      return {
        success: true,
        data: strippedResult,
        method: 'text_stripped',
        diagnostics,
      };
    }

    // STEP 4: Balanced brace matching WITH string tracking (handles { } inside strings)
    const braceResult = this.tryBraceMatchingWithStringTracking<T>(
      output,
      requiredFields,
      flexibleFields,
      verbose,
      diagnostics
    );
    if (braceResult) {
      return {
        success: true,
        data: braceResult,
        method: 'brace_matching',
        diagnostics,
      };
    }

    // All strategies failed
    if (verbose) {
      console.error('[EnhancedJSONExtractor] All extraction strategies failed');
      console.error('[EnhancedJSONExtractor] Output preview:', output.substring(0, 500));
    }

    return {
      success: false,
      error: 'All JSON extraction strategies failed',
      rawOutput: output,
      diagnostics,
    };
  }

  /**
   * STEP 1: Try parsing as pure JSON
   */
  private static tryPureJSON<T>(
    output: string,
    requiredFields: string[],
    verbose: boolean
  ): T | null {
    try {
      const trimmed = output.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return null;
      }

      const parsed = JSON.parse(trimmed);

      // Check required fields
      for (const field of requiredFields) {
        if (!(field in parsed) || !Array.isArray(parsed[field]) || parsed[field].length === 0) {
          if (verbose) {
            console.log(`[EnhancedJSONExtractor] Pure JSON missing required field: ${field}`);
          }
          return null;
        }
      }

      if (verbose) {
        console.log('[EnhancedJSONExtractor] Parsed as pure JSON');
      }
      return parsed as T;
    } catch {
      return null;
    }
  }

  /**
   * STEP 2: Try markdown code blocks
   */
  private static tryMarkdownBlocks<T>(
    output: string,
    requiredFields: string[],
    verbose: boolean,
    diagnostics: ExtractionResult['diagnostics']
  ): T | null {
    const patterns = [
      /```json\s*\n([\s\S]*?)\n```/,
      /```json\s*\n([\s\S]*?)```/,
      /```json\s*([\s\S]*?)```/,
      /```\s*\n([\s\S]*?)\n```/,
      /```\s*([\s\S]*?)```/,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        try {
          const jsonText = (match[1] || match[0]).trim();
          const parsed = JSON.parse(jsonText);

          // Check required fields
          let hasAllRequired = true;
          for (const field of requiredFields) {
            if (!(field in parsed) || !Array.isArray(parsed[field]) || parsed[field].length === 0) {
              hasAllRequired = false;
              diagnostics?.parseErrors?.push(`Markdown block missing field: ${field}`);
              break;
            }
          }

          if (hasAllRequired) {
            if (verbose) {
              console.log(`[EnhancedJSONExtractor] Parsed via markdown pattern`);
            }
            return parsed as T;
          }
        } catch (e: any) {
          diagnostics?.parseErrors?.push(`Markdown parse error: ${e.message}`);
        }
      }
    }

    return null;
  }

  /**
   * STEP 3: Strip text before first { and after last }
   */
  private static tryStripPreamble<T>(
    output: string,
    requiredFields: string[],
    verbose: boolean,
    diagnostics: ExtractionResult['diagnostics']
  ): T | null {
    const firstBrace = output.indexOf('{');
    const lastBrace = output.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }

    // Store diagnostics about stripped text
    if (firstBrace > 0) {
      diagnostics!.textBeforeJson = output.substring(0, Math.min(firstBrace, 200));
    }
    if (lastBrace < output.length - 1) {
      diagnostics!.textAfterJson = output.substring(lastBrace + 1, Math.min(output.length, lastBrace + 201));
    }

    const jsonCandidate = output.substring(firstBrace, lastBrace + 1);

    try {
      const parsed = JSON.parse(jsonCandidate);

      // Check required fields
      for (const field of requiredFields) {
        if (!(field in parsed) || !Array.isArray(parsed[field]) || parsed[field].length === 0) {
          diagnostics?.parseErrors?.push(`Stripped JSON missing field: ${field}`);
          return null;
        }
      }

      if (verbose) {
        console.log(`[EnhancedJSONExtractor] Parsed via text stripping (removed ${firstBrace} chars before, ${output.length - lastBrace - 1} chars after)`);
      }
      return parsed as T;
    } catch (e: any) {
      diagnostics?.parseErrors?.push(`Strip parse error: ${e.message}`);
      return null;
    }
  }

  /**
   * STEP 4: Balanced brace matching WITH string tracking
   *
   * This handles the case where JSON contains strings with { or } characters,
   * which would break naive brace counting.
   */
  private static tryBraceMatchingWithStringTracking<T>(
    output: string,
    requiredFields: string[],
    flexibleFields: string[],
    verbose: boolean,
    diagnostics: ExtractionResult['diagnostics']
  ): T | null {
    const candidates: Array<{ text: string; start: number; end: number }> = [];

    let i = 0;
    while (i < output.length) {
      if (output[i] === '{') {
        // Found potential JSON start - try to find balanced end
        const result = this.findBalancedJSONEnd(output, i);
        if (result.end !== -1) {
          const candidate = output.substring(i, result.end + 1);
          candidates.push({ text: candidate, start: i, end: result.end });
          diagnostics!.jsonCandidatesFound = (diagnostics!.jsonCandidatesFound || 0) + 1;
        }
        // Move past this { to find other candidates
        i = result.end !== -1 ? result.end + 1 : i + 1;
      } else {
        i++;
      }
    }

    // Sort by length (longest first - more likely to be complete)
    candidates.sort((a, b) => b.text.length - a.text.length);

    if (verbose && candidates.length > 0) {
      console.log(`[EnhancedJSONExtractor] Found ${candidates.length} JSON candidates via brace matching`);
    }

    // Try to parse each candidate
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate.text);

        // Check required fields at top level
        let hasAllRequired = true;
        for (const field of requiredFields) {
          const value = parsed[field];
          if (!value || !Array.isArray(value) || value.length === 0) {
            // Try flexible search if field is in flexibleFields
            if (flexibleFields.includes(field)) {
              const flexValue = this.findFieldAtAnyLevel(parsed, field);
              if (!flexValue || !Array.isArray(flexValue) || flexValue.length === 0) {
                hasAllRequired = false;
                diagnostics?.parseErrors?.push(`Brace match missing field: ${field}`);
                break;
              }
            } else {
              hasAllRequired = false;
              diagnostics?.parseErrors?.push(`Brace match missing field: ${field}`);
              break;
            }
          }
        }

        if (hasAllRequired) {
          if (verbose) {
            console.log(`[EnhancedJSONExtractor] Parsed via brace matching (${candidate.text.length} chars)`);
          }
          // Store what was before/after for diagnostics
          if (candidate.start > 0) {
            diagnostics!.textBeforeJson = output.substring(0, Math.min(candidate.start, 200));
          }
          if (candidate.end < output.length - 1) {
            diagnostics!.textAfterJson = output.substring(candidate.end + 1, Math.min(output.length, candidate.end + 201));
          }
          return parsed as T;
        }
      } catch (e: any) {
        diagnostics?.parseErrors?.push(`Brace match parse error: ${e.message?.substring(0, 100)}`);
      }
    }

    return null;
  }

  /**
   * Find the end of a balanced JSON object starting at position `start`,
   * properly tracking string state to ignore { } inside strings.
   */
  private static findBalancedJSONEnd(
    output: string,
    start: number
  ): { end: number } {
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = start; i < output.length; i++) {
      const char = output[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === '\\' && inString) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            return { end: i };
          }
        }
      }
    }

    return { end: -1 };
  }

  /**
   * Find a field at any nesting level in parsed JSON
   */
  static findFieldAtAnyLevel(obj: any, fieldName: string): any | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    // Check current level
    if (fieldName in obj) {
      return obj[fieldName];
    }

    // Search nested objects
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
          // Search in array items
          for (const item of value) {
            const found = this.findFieldAtAnyLevel(item, fieldName);
            if (found !== undefined) {
              return found;
            }
          }
        } else {
          // Search in nested object
          const found = this.findFieldAtAnyLevel(value, fieldName);
          if (found !== undefined) {
            return found;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Get list of top-level fields in extracted JSON
   */
  static getTopLevelFields(data: any): string[] {
    if (!data || typeof data !== 'object') {
      return [];
    }
    return Object.keys(data);
  }
}

export default EnhancedJSONExtractor;
