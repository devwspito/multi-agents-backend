import Anthropic from '@anthropic-ai/sdk';
import { getAgentDefinition } from './orchestration/AgentDefinitions';
import { PREMIUM_CONFIG } from '../config/ModelConfigurations';

/**
 * ErrorDetective Service
 *
 * Standalone service (NOT a phase) that analyzes raw error logs from external systems.
 * Creates structured error analysis to be used as task input for orchestration.
 *
 * FLOW:
 * 1. External system sends error via webhook
 * 2. ErrorDetective analyzes error (this service)
 * 3. Analysis is used to create a Task
 * 4. Task runs through normal orchestration (starting from ProblemAnalyst)
 *
 * WHY NOT A PHASE:
 * - Phases run WITHIN a task
 * - ErrorDetective runs BEFORE task creation
 * - It provides the initial input for orchestration
 */

export interface ErrorAnalysisInput {
  errorLogs: string;
  stackTrace?: string;
  environment?: 'production' | 'staging' | 'development';
  errorType?: string;
  timestamp?: Date;
  metadata?: Record<string, any>;
}

export interface ErrorAnalysisOutput {
  success: boolean;
  analysis?: {
    errorType: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    rootCause: string;
    affectedComponents: string[];
    reproducibilityConfidence: number; // 0-100
    fixRecommendations: string[];
    estimatedEffort: 'low' | 'medium' | 'high';
    relatedFiles: string[];
    possibleDuplicates?: string[];
  };
  taskDescription?: string; // Formatted description for task creation
  error?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  cost_usd?: number;
}

export class ErrorDetectiveService {
  private anthropic: Anthropic;

  constructor(apiKey?: string) {
    this.anthropic = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
    });
  }

  /**
   * Analyze error logs and produce structured analysis
   * Uses model from task configuration (always topModel for critical error analysis)
   */
  async analyzeError(input: ErrorAnalysisInput): Promise<ErrorAnalysisOutput> {
    try {
      console.log(`🔍 [ErrorDetective] Starting error analysis...`);
      console.log(`   Environment: ${input.environment || 'unknown'}`);
      console.log(`   Error type: ${input.errorType || 'unknown'}`);

      // Get agent definition and model
      const agentDef = getAgentDefinition('error-detective');
      if (!agentDef) {
        throw new Error('Agent definition not found for error-detective');
      }
      const model = PREMIUM_CONFIG['error-detective'];

      // Build analysis prompt
      const prompt = this.buildAnalysisPrompt(input);

      console.log(`🤖 [ErrorDetective] Using model: ${model}`);

      // Execute agent
      const startTime = Date.now();
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 8000,
        temperature: 0,
        system: agentDef.prompt,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const duration = Date.now() - startTime;

      // Extract text response
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text response from error-detective agent');
      }

      const output = textContent.text;

      // Parse JSON output
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/) || output.match(/{[\s\S]*}/);
      if (!jsonMatch) {
        console.error(`❌ [ErrorDetective] No JSON found in response`);
        return {
          success: false,
          error: 'Failed to parse error analysis - no JSON output found',
        };
      }

      const analysis = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      // Calculate cost
      const cost = this.calculateCost(model, response.usage);

      console.log(`✅ [ErrorDetective] Analysis complete in ${duration}ms`);
      console.log(`   Error type: ${analysis.errorType}`);
      console.log(`   Severity: ${analysis.severity}`);
      console.log(`   Confidence: ${analysis.reproducibilityConfidence}%`);
      console.log(`   Cost: $${cost.toFixed(4)}`);

      // Build task description from analysis
      const taskDescription = this.formatTaskDescription(analysis, input);

      return {
        success: true,
        analysis,
        taskDescription,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        },
        cost_usd: cost,
      };
    } catch (error: any) {
      console.error(`❌ [ErrorDetective] Analysis failed:`, error);
      return {
        success: false,
        error: error.message || 'Error analysis failed',
      };
    }
  }

  /**
   * Build detailed analysis prompt
   */
  private buildAnalysisPrompt(input: ErrorAnalysisInput): string {
    return `# Error Analysis Request

## Error Logs
\`\`\`
${input.errorLogs}
\`\`\`

${input.stackTrace ? `## Stack Trace
\`\`\`
${input.stackTrace}
\`\`\`
` : ''}

## Context
- **Environment**: ${input.environment || 'unknown'}
- **Error Type**: ${input.errorType || 'unknown'}
- **Timestamp**: ${input.timestamp ? input.timestamp.toISOString() : 'unknown'}

${input.metadata ? `## Additional Metadata
\`\`\`json
${JSON.stringify(input.metadata, null, 2)}
\`\`\`
` : ''}

---

## Your Task

Analyze this error and provide a comprehensive analysis in JSON format.

**Output Format**:
\`\`\`json
{
  "errorType": "NullPointerException | TypeError | ReferenceError | NetworkError | DatabaseError | ...",
  "severity": "critical | high | medium | low",
  "rootCause": "Detailed explanation of the root cause",
  "affectedComponents": ["component1", "component2"],
  "reproducibilityConfidence": 85,
  "fixRecommendations": [
    "1. Check null safety in UserService.ts:42",
    "2. Add defensive null checks before accessing user.profile",
    "3. Add unit tests for null user scenarios"
  ],
  "estimatedEffort": "low | medium | high",
  "relatedFiles": ["src/services/UserService.ts", "src/models/User.ts"],
  "possibleDuplicates": ["Similar error occurred in PR #123"]
}
\`\`\`

**Analysis Guidelines**:
1. Identify the exact error type (be specific)
2. Assess severity based on:
   - Critical: Production outage, data loss, security breach
   - High: Major feature broken, performance degradation
   - Medium: Minor feature broken, workarounds available
   - Low: Edge case, cosmetic issue
3. Determine root cause (not just symptoms)
4. List ALL affected components/files
5. Rate reproducibility confidence (0-100%)
6. Provide actionable fix recommendations (prioritized)
7. Estimate fix effort (low: <2h, medium: 2-8h, high: >8h)
8. Identify related files that need changes
9. Check if this is a duplicate of known issues

Provide ONLY the JSON output, no additional text.`;
  }

  /**
   * Format analysis into task description
   */
  private formatTaskDescription(analysis: any, input: ErrorAnalysisInput): string {
    const lines = [
      `# 🔥 Production Error: ${analysis.errorType}`,
      '',
      `**Severity**: ${analysis.severity.toUpperCase()}`,
      `**Confidence**: ${analysis.reproducibilityConfidence}%`,
      `**Estimated Effort**: ${analysis.estimatedEffort}`,
      '',
      '## Root Cause',
      analysis.rootCause,
      '',
      '## Affected Components',
      ...analysis.affectedComponents.map((c: string) => `- ${c}`),
      '',
      '## Fix Recommendations',
      ...analysis.fixRecommendations.map((r: string, i: number) => `${i + 1}. ${r}`),
      '',
      '## Related Files',
      ...analysis.relatedFiles.map((f: string) => `- \`${f}\``),
      '',
      '## Error Logs',
      '```',
      input.errorLogs.substring(0, 500), // Truncate if too long
      input.errorLogs.length > 500 ? '... (truncated)' : '',
      '```',
    ];

    if (input.stackTrace) {
      lines.push('', '## Stack Trace', '```', input.stackTrace.substring(0, 500), '```');
    }

    if (analysis.possibleDuplicates && analysis.possibleDuplicates.length > 0) {
      lines.push('', '## Possible Duplicates', ...analysis.possibleDuplicates.map((d: string) => `- ${d}`));
    }

    return lines.join('\n');
  }

  /**
   * Calculate API cost based on usage
   */
  private calculateCost(model: string, usage: Anthropic.Messages.Usage): number {
    // Pricing per million tokens (as of Nov 2025)
    // Source: https://docs.anthropic.com/en/docs/about-claude/models
    const pricing: Record<string, { input: number; output: number }> = {
      'claude-opus-4-5-20251101': { input: 5, output: 25 },
      'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
      'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    };

    const modelPricing = pricing[model];
    if (!modelPricing) {
      throw new Error(
        `❌ [ErrorDetective] Unknown model "${model}" for cost calculation. ` +
        `Valid models: ${Object.keys(pricing).join(', ')}`
      );
    }

    const inputCost = (usage.input_tokens / 1_000_000) * modelPricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
  }
}
