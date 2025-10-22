/**
 * Schema Validation Service
 *
 * Implements Anthropic's best practice for validating agent outputs
 * using Zod schemas for type-safe parsing and validation.
 */

import { z } from 'zod';

// ============================================================================
// Project Manager Schemas
// ============================================================================

export const StorySchema = z.object({
  id: z.string().min(1),
  epicId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).optional(),
  assignedTo: z.string().optional(),
  priority: z.number().min(1).max(5),
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very_complex']),
  dependencies: z.array(z.string()).optional(),
  technicalNotes: z.string().optional(),
  affectedFiles: z.array(z.string()).optional(),
  testingNotes: z.string().optional(),
});

export const EpicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  objectives: z.array(z.string()).optional(),
  stories: z.array(StorySchema),
  priority: z.number().min(1).max(5),
  affectedRepositories: z.array(z.string()).optional(),
  assignedTeam: z.number().optional(),
});

export const ProjectManagerOutputSchema = z.object({
  epics: z.array(EpicSchema),
  totalTeamsNeeded: z.number().min(1).optional(),
  projectSummary: z.string().optional(),
  deliveryMilestones: z.array(z.object({
    milestone: z.string(),
    description: z.string(),
    targetDate: z.string().optional(),
  })).optional(),
});

// ============================================================================
// Tech Lead Schemas
// ============================================================================

export const TechLeadStorySchema = z.object({
  id: z.string().min(1),
  epicId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).optional(),
  technicalDetails: z.object({
    approach: z.string(),
    affectedComponents: z.array(z.string()),
    filesToModify: z.array(z.string()),
    estimatedLinesOfCode: z.number().optional(),
    testingStrategy: z.string().optional(),
  }).optional(),
  dependencies: z.array(z.string()).optional(),
  estimatedComplexity: z.enum(['trivial', 'simple', 'moderate', 'complex', 'very_complex']),
  assignedTo: z.string().optional(),
});

export const TechLeadEpicSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  technicalDesign: z.object({
    architecture: z.string(),
    dataFlow: z.string().optional(),
    components: z.array(z.string()),
    interfaces: z.array(z.string()).optional(),
    securityConsiderations: z.string().optional(),
    performanceConsiderations: z.string().optional(),
  }).optional(),
  stories: z.array(TechLeadStorySchema),
  branchName: z.string().optional(),
  estimatedDevelopmentDays: z.number().optional(),
});

export const TechLeadOutputSchema = z.object({
  epics: z.array(TechLeadEpicSchema),
  architectureNotes: z.string().optional(),
  riskAssessment: z.array(z.object({
    risk: z.string(),
    impact: z.enum(['low', 'medium', 'high']),
    mitigation: z.string(),
  })).optional(),
  recommendedTooling: z.array(z.string()).optional(),
});

// ============================================================================
// Developer Output Schema
// ============================================================================

export const DeveloperOutputSchema = z.object({
  success: z.boolean(),
  filesModified: z.array(z.string()).optional(),
  filesCreated: z.array(z.string()).optional(),
  testsAdded: z.number().optional(),
  linesOfCode: z.number().optional(),
  commitSHA: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  summary: z.string(),
  errorDetails: z.string().optional(),
});

// ============================================================================
// Judge Output Schema
// ============================================================================

export const JudgeReviewSchema = z.object({
  approved: z.boolean(),
  reviewComments: z.array(z.string()),
  codeQualityScore: z.number().min(0).max(10).optional(),
  suggestions: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    issue: z.string(),
    suggestion: z.string(),
  })).optional(),
  requiresChanges: z.boolean(),
  changeRequests: z.array(z.string()).optional(),
  securityIssues: z.array(z.string()).optional(),
  performanceIssues: z.array(z.string()).optional(),
});

// ============================================================================
// QA Output Schema
// ============================================================================

export const QATestResultSchema = z.object({
  testsPass: z.boolean(),
  buildSuccess: z.boolean(),
  lintSuccess: z.boolean(),
  testCoverage: z.number().min(0).max(100).optional(),
  failedTests: z.array(z.object({
    test: z.string(),
    error: z.string(),
    file: z.string().optional(),
  })).optional(),
  buildErrors: z.array(z.string()).optional(),
  lintErrors: z.array(z.string()).optional(),
  performanceMetrics: z.object({
    buildTime: z.number().optional(),
    testDuration: z.number().optional(),
    bundleSize: z.number().optional(),
  }).optional(),
  recommendation: z.enum(['pass', 'fail', 'conditional']),
  notes: z.string().optional(),
});

// ============================================================================
// Fixer Output Schema
// ============================================================================

export const FixerOutputSchema = z.object({
  fixed: z.boolean(),
  filesModified: z.array(z.string()).optional(),
  changes: z.array(z.string()).optional(),
  errorType: z.enum(['lint', 'build', 'test', 'unknown']),
  fixApplied: z.string().optional(),
  remainingIssues: z.array(z.string()).optional(),
});

// ============================================================================
// Validation Service
// ============================================================================

export class SchemaValidationService {
  /**
   * Validate Project Manager output
   */
  static validateProjectManagerOutput(output: string): z.infer<typeof ProjectManagerOutputSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return ProjectManagerOutputSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ Project Manager output validation failed:', error);
      return null;
    }
  }

  /**
   * Validate Tech Lead output
   */
  static validateTechLeadOutput(output: string): z.infer<typeof TechLeadOutputSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return TechLeadOutputSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ Tech Lead output validation failed:', error);
      return null;
    }
  }

  /**
   * Validate Developer output
   */
  static validateDeveloperOutput(output: string): z.infer<typeof DeveloperOutputSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return DeveloperOutputSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ Developer output validation failed:', error);
      return null;
    }
  }

  /**
   * Validate Judge review output
   */
  static validateJudgeOutput(output: string): z.infer<typeof JudgeReviewSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return JudgeReviewSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ Judge output validation failed:', error);
      return null;
    }
  }

  /**
   * Validate QA test results
   */
  static validateQAOutput(output: string): z.infer<typeof QATestResultSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return QATestResultSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ QA output validation failed:', error);
      return null;
    }
  }

  /**
   * Validate Fixer output
   */
  static validateFixerOutput(output: string): z.infer<typeof FixerOutputSchema> | null {
    try {
      const jsonMatch = this.extractJSON(output);
      if (!jsonMatch) return null;

      return FixerOutputSchema.parse(JSON.parse(jsonMatch));
    } catch (error) {
      console.error('❌ Fixer output validation failed:', error);
      return null;
    }
  }

  /**
   * Extract JSON from agent output
   */
  private static extractJSON(output: string): string | null {
    // Try to find JSON in code blocks
    const codeBlockMatch = output.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1];
    }

    // Try to find raw JSON
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }

    return null;
  }

  /**
   * Safe parse with fallback
   */
  static safeParse<T>(
    schema: z.ZodSchema<T>,
    data: unknown,
    fallback: T
  ): T {
    try {
      return schema.parse(data);
    } catch (error) {
      console.warn('Schema validation failed, using fallback:', error);
      return fallback;
    }
  }

  /**
   * Get validation errors as readable strings
   */
  static getValidationErrors(error: z.ZodError): string[] {
    return error.errors.map(err => {
      const path = err.path.join('.');
      return `${path}: ${err.message}`;
    });
  }
}