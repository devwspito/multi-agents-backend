/**
 * Centralized Types Index
 *
 * Export all type definitions and utilities for consistent data handling.
 */

// Status enums and helpers
export {
  BaseStatus,
  StoryStatus,
  StoryProgressStage,
  PhaseStatus,
  TaskStatus,
  JudgeVerdict,
  PRState,
  BackgroundTaskStatus,
  isTerminalStatus,
  isSuccessStatus,
  isFailureStatus,
  isActiveStatus,
  normalizeStatus,
  VALID_BASE_STATUSES,
  VALID_STORY_STATUSES,
  VALID_PHASE_STATUSES,
  VALID_TASK_STATUSES,
  VALID_JUDGE_VERDICTS,
  VALID_PR_STATES,
} from './status';

// Field naming conventions and normalizers
export {
  CostTracking,
  normalizeCostFields,
  PullRequestInfo,
  PullRequestFields,
  PREventPayload,
  normalizePRFields,
  RetryTracking,
  normalizeRetryFields,
  AssignmentTracking,
  normalizeAssignment,
  StoryComplexity,
  ComplexityTracking,
  normalizeComplexity,
  PlannedFiles,
  ExecutedFiles,
  FIELD_MAPPINGS,
  dbRowToJs,
  jsToDbRow,
} from './fields';
