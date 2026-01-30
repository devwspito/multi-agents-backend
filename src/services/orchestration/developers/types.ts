/**
 * DevelopersPhase Types
 *
 * Type definitions for Developer ↔ Judge communication and pipeline stages.
 *
 * FIELD NAMING CONVENTION:
 * - costUsd: Standardized cost field (use this)
 * - cost: Deprecated alias for backward compatibility
 * - retryCount: Standardized retry field
 * - iteration: Deprecated alias for retryCount
 */

import { OrchestrationContext } from '../Phase';
import { ProjectRadiography } from '../../ProjectRadiographyService';
import { RejectReasonType } from '../JudgePhase';

// ═══════════════════════════════════════════════════════════════════════════════
// 🔥 TYPED CONTRACTS: Developer ↔ Judge Communication
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Output from Developer after implementing a story.
 * This is the SINGLE SOURCE OF TRUTH for what Developer produced.
 */
export interface DeveloperOutput {
  /** Whether the developer completed successfully */
  success: boolean;
  /** The exact git commit SHA of the developer's work */
  commitSHA: string;
  /** The branch name where work was committed */
  branchName: string;
  /** List of files that were modified */
  filesModified: string[];
  /** List of files that were created */
  filesCreated: string[];
  /** Cost of the developer execution in USD (standardized name) */
  costUsd: number;
  /** @deprecated Use costUsd instead. Kept for backward compatibility. */
  cost?: number;
  /** Token usage for the developer */
  tokens: { input: number; output: number };
  /** When the developer completed */
  completedAt: Date;
  /** The story that was implemented */
  storyId: string;
  /** Raw agent response (for debugging) */
  rawResponse?: string;
}

/**
 * Input that Judge receives to evaluate Developer's work.
 * This is derived from DeveloperOutput to ensure consistency.
 */
export interface JudgeInput {
  /** The exact commit SHA to review (from DeveloperOutput.commitSHA) */
  commitSHA: string;
  /** The branch to review (from DeveloperOutput.branchName) */
  branchName: string;
  /** Files to review (from DeveloperOutput.filesModified + filesCreated) */
  filesToReview: string[];
  /** The story being evaluated */
  story: {
    id: string;
    title: string;
    acceptanceCriteria?: string[];
  };
  /** The epic context */
  epic: {
    id: string;
    name: string;
    targetRepository: string;
  };
  /** Path to the isolated workspace where code exists */
  workspacePath: string;
  /** Type of judge evaluation */
  judgeType: 'developer' | 'story' | 'epic' | 'integration';
}

/**
 * Result from Judge evaluation.
 */
export interface JudgeResult {
  /** Whether the code was approved */
  approved: boolean;
  /** Numeric score (0-100) */
  score: number;
  /** Detailed feedback from the judge */
  feedback: string;
  /** Whether human review is required (e.g., judge crashed) */
  requiresHumanReview?: boolean;
  /** Error message if evaluation failed */
  evaluationError?: string;
  /** Cost of the judge execution in USD (standardized name) */
  costUsd?: number;
  /** @deprecated Use costUsd instead. Kept for backward compatibility. */
  cost?: number;
  /** Token usage */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Current retry iteration (standardized name) */
  retryCount?: number;
  /** @deprecated Use retryCount instead. Kept for backward compatibility. */
  iteration?: number;
  /** Max retries allowed */
  maxRetries?: number;
}

/**
 * Helper to create JudgeInput from DeveloperOutput.
 * This ensures the handoff is consistent and type-safe.
 */
export function createJudgeInput(
  developerOutput: DeveloperOutput,
  story: JudgeInput['story'],
  epic: JudgeInput['epic'],
  workspacePath: string,
  judgeType: JudgeInput['judgeType'] = 'developer'
): JudgeInput {
  return {
    commitSHA: developerOutput.commitSHA,
    branchName: developerOutput.branchName,
    filesToReview: [...developerOutput.filesModified, ...developerOutput.filesCreated],
    story,
    epic,
    workspacePath,
    judgeType,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔥 STAGE-BASED PIPELINE: Modular execution for mid-story recovery
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parameters shared across all pipeline stages.
 * Extracted from executeIsolatedStoryPipeline to enable stage isolation.
 */
export interface StoryPipelineContext {
  task: any;
  story: any;
  developer: any;
  epic: any;
  repositories: any[];
  effectiveWorkspacePath: string;
  workspaceStructure: string;
  attachments: any[];
  state: any;
  context: OrchestrationContext;
  taskId: string;
  normalizedEpicId: string;
  normalizedStoryId: string;
  epicBranchName: string;
  devAuth?: any;
  architectureBrief?: any;
  environmentCommands?: any;
  projectRadiographies?: Map<string, ProjectRadiography>;
  // 🐳 SANDBOX: Explicit sandbox ID for Docker execution
  sandboxId?: string;
}

/**
 * Result from the Developer stage.
 * Contains everything needed for subsequent stages.
 */
export interface DeveloperStageResult {
  success: boolean;
  developerCost: number;
  developerTokens: { input: number; output: number };
  sdkSessionId?: string;
  output?: string;
  error?: string;
}

/**
 * Result from the Git Validation stage.
 * Confirms code is committed and pushed.
 */
export interface GitValidationStageResult {
  success: boolean;
  commitSHA: string | null;
  storyBranch: string | null;
  gitValidationPassed: boolean;
  error?: string;
}

/**
 * Result from the Judge stage.
 * Contains verdict and feedback.
 */
export interface JudgeStageResult {
  success: boolean;
  approved: boolean;
  judgeCost: number;
  judgeTokens: { input: number; output: number };
  feedback?: string;
  iteration?: number;
  maxRetries?: number;
  error?: string;
  /**
   * Reason for rejection - Used to route to appropriate specialist:
   * - 'conflicts' → ConflictResolver specialist
   * - 'code_issues' → Fixer specialist / Developer retry
   * - 'scope_violation' → Developer retry with strict rules
   * - 'placeholder_code' → Developer retry
   * - 'missing_files' → Developer retry
   * - 'other' → Developer retry
   */
  rejectReason?: RejectReasonType;
}

/**
 * Result from the Merge stage.
 * Confirms story branch merged to epic branch.
 */
export interface MergeStageResult {
  success: boolean;
  conflictResolutionCost: number;
  conflictResolutionUsage: { input_tokens: number; output_tokens: number };
  error?: string;
}
