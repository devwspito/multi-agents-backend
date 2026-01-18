/**
 * Unified Judge Types - Single source of truth for Judge-related interfaces
 *
 * Consolidates duplicate definitions from:
 * - DevelopersPhase.ts (JudgeResult with 14 properties)
 * - JudgePhase.ts (JudgeResult with 13 properties)
 *
 * This file should be imported by both phases to ensure type consistency.
 */

/**
 * Result from Judge evaluation
 *
 * This is THE canonical definition - use this everywhere.
 */
export interface JudgeResult {
  /** Whether the code/work was approved */
  approved: boolean;

  /** Quality score (0-100, 60+ is passing) */
  score?: number;

  /** Feedback explaining the decision */
  feedback: string;

  /** Files that were verified during review */
  filesVerified?: string[];

  /** Issues found during review */
  issues?: string[];

  /** Suggestions for improvement */
  suggestions?: string[];

  /** Cost of the Judge agent execution */
  cost?: number;

  /** Token usage details */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };

  /** Whether human review is required (e.g., Judge error) */
  requiresHumanReview?: boolean;

  /** Error message if evaluation failed */
  evaluationError?: string;

  /** Story ID being evaluated (for Developer Judge) */
  storyId?: string;

  /** Commit SHA being evaluated */
  commitSHA?: string;

  /** Branch name being evaluated */
  branchName?: string;
}

/**
 * Judge evaluation context - input to Judge
 */
export interface JudgeEvaluationContext {
  /** Type of judge evaluation */
  type: JudgeType;

  /** Workspace path for file access */
  workspacePath: string | null;

  /** Task ID for tracking */
  taskId: string;

  /** Available repositories */
  repositories?: RepositoryInfo[];

  // Planning Judge context
  /** Epics to evaluate (Planning Judge) */
  epics?: EpicInfo[];
  /** Task title (Planning Judge) */
  taskTitle?: string;
  /** Task description (Planning Judge) */
  taskDescription?: string;

  // TechLead Judge context
  /** Architecture output to evaluate (TechLead Judge) */
  architectureOutput?: any;
  /** Epic context (TechLead Judge) */
  epicContext?: any;
  /** Total epics in task (TechLead Judge) */
  totalEpicsInTask?: number;
  /** Current epic index (TechLead Judge) */
  currentEpicIndex?: number;

  // Developer Judge context
  /** Story being evaluated (Developer Judge) */
  story?: StoryInfo;
  /** Developer info (Developer Judge) */
  developer?: DeveloperInfo;
  /** Commit SHA to review (Developer Judge) */
  commitSHA?: string;
  /** Branch name (Developer Judge) */
  branchName?: string;
  /** Files modified (Developer Judge) */
  filesModified?: string[];
  /** Files created (Developer Judge) */
  filesCreated?: string[];
}

/**
 * Judge types - matches evaluation context types
 */
export type JudgeType = 'planning' | 'tech-lead' | 'developer' | 'story' | 'epic' | 'integration';

/**
 * Minimal repository info for Judge
 */
export interface RepositoryInfo {
  name: string;
  path: string;
  type?: string;
  url?: string;
}

/**
 * Minimal epic info for Judge
 */
export interface EpicInfo {
  id: string;
  title: string;
  description?: string;
  targetRepository?: string;
  filesToModify?: string[];
  filesToCreate?: string[];
}

/**
 * Minimal story info for Judge
 */
export interface StoryInfo {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  epicId?: string;
}

/**
 * Minimal developer info for Judge
 */
export interface DeveloperInfo {
  id: string;
  name?: string;
  instanceId?: string;
}

/**
 * Judge input for Developer Judge (from Developer output)
 */
export interface JudgeInput {
  /** Commit SHA to review */
  commitSHA: string;

  /** Branch name */
  branchName: string;

  /** Files to review */
  filesToReview: string[];

  /** Story context */
  story: {
    id: string;
    title: string;
    acceptanceCriteria?: string[];
  };

  /** Epic context */
  epic: {
    id: string;
    name: string;
    targetRepository: string;
  };

  /** Workspace path for file access */
  workspacePath: string;

  /** Type of judge evaluation */
  judgeType: JudgeType;
}

/**
 * Default passing score threshold
 */
export const JUDGE_PASS_THRESHOLD = 60;

/**
 * Default score when approved by default (parsing failure, etc.)
 */
export const JUDGE_DEFAULT_SCORE = 70;

/**
 * Check if a score passes the threshold
 */
export function isPassingScore(score: number | undefined): boolean {
  return (score ?? 0) >= JUDGE_PASS_THRESHOLD;
}

/**
 * Create a default approval result
 */
export function createDefaultApproval(reason: string): JudgeResult {
  return {
    approved: true,
    feedback: reason,
    score: JUDGE_DEFAULT_SCORE,
  };
}

/**
 * Create a rejection result
 */
export function createRejection(feedback: string, issues?: string[]): JudgeResult {
  return {
    approved: false,
    feedback,
    score: 0,
    issues,
  };
}
