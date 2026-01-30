/**
 * Centralized Field Naming Conventions
 *
 * CRITICAL: All field names MUST follow these conventions for data integrity.
 * This ensures consistent training data for AI models.
 *
 * RULES:
 * 1. JavaScript/TypeScript: camelCase (costUsd, pullRequestNumber)
 * 2. SQLite columns: snake_case (cost_usd, pull_request_number)
 * 3. Event payloads: short form (prNumber, not pullRequestNumber)
 * 4. Model properties: long form (pullRequestNumber, not prNumber)
 */

// ============================================================================
// COST FIELDS
// ============================================================================

/**
 * Cost tracking interface - use this for all monetary values.
 *
 * STANDARD NAMING:
 * - In-memory: costUsd (camelCase)
 * - Database: cost_usd (snake_case)
 */
export interface CostTracking {
  /** Total cost in USD */
  costUsd: number;

  /** Developer agent cost in USD */
  developerCostUsd?: number;

  /** Judge agent cost in USD */
  judgeCostUsd?: number;

  /** Fixer agent cost in USD (for retry/fix cycles) */
  fixerCostUsd?: number;
}

/**
 * Convert database cost fields to in-memory format.
 */
export function normalizeCostFields(dbRow: Record<string, any>): CostTracking {
  return {
    costUsd: dbRow.cost_usd ?? dbRow.costUsd ?? 0,
    developerCostUsd: dbRow.developer_cost_usd ?? dbRow.developerCostUsd ?? dbRow.developerCost_usd,
    judgeCostUsd: dbRow.judge_cost_usd ?? dbRow.judgeCostUsd ?? dbRow.judgeCost_usd,
    fixerCostUsd: dbRow.fixer_cost_usd ?? dbRow.fixerCostUsd,
  };
}

// ============================================================================
// PULL REQUEST FIELDS
// ============================================================================

/**
 * Pull Request information - canonical form for models.
 *
 * STANDARD NAMING:
 * - Model properties: pullRequestNumber, pullRequestUrl
 * - Event payloads: prNumber, prUrl
 * - Return objects: { number, url, state }
 */
export interface PullRequestInfo {
  /** PR number on GitHub */
  number: number;

  /** Full URL to the PR */
  url: string;

  /** Current state of the PR */
  state: 'open' | 'merged' | 'closed';
}

/**
 * Pull Request fields on Epic/Story models.
 */
export interface PullRequestFields {
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: 'open' | 'merged' | 'closed';
  prCreated?: boolean;
}

/**
 * Pull Request event payload (short form).
 */
export interface PREventPayload {
  prNumber: number;
  prUrl: string;
}

/**
 * Normalize PR fields from various formats to canonical form.
 */
export function normalizePRFields(data: Record<string, any>): PullRequestInfo | null {
  const number = data.pullRequestNumber ?? data.prNumber ?? data.number;
  const url = data.pullRequestUrl ?? data.prUrl ?? data.url;
  const state = data.pullRequestState ?? data.prState ?? data.state ?? 'open';

  if (!number || !url) return null;

  return { number, url, state };
}

// ============================================================================
// RETRY/ITERATION FIELDS
// ============================================================================

/**
 * Retry tracking - standardized field name.
 *
 * STANDARD: Use `retryCount` everywhere.
 * DEPRECATED: `judgeIterations` (legacy, will be removed)
 */
export interface RetryTracking {
  /** Number of retry attempts */
  retryCount: number;

  /** Maximum allowed retries */
  maxRetries?: number;
}

/**
 * Normalize retry fields from legacy formats.
 */
export function normalizeRetryFields(data: Record<string, any>): RetryTracking {
  return {
    retryCount: data.retryCount ?? data.judgeIterations ?? data.iterations ?? 0,
    maxRetries: data.maxRetries ?? data.maxIterations ?? 3,
  };
}

// ============================================================================
// DEVELOPER ASSIGNMENT FIELDS
// ============================================================================

/**
 * Assignment tracking - standardized field name.
 *
 * STANDARD: Use `assignedTo` on story objects.
 * DEPRECATED: `developerId` when referring to assignment (keep for developer info)
 */
export interface AssignmentTracking {
  /** ID of the assigned developer instance */
  assignedTo: string;
}

/**
 * Normalize assignment fields from various formats.
 */
export function normalizeAssignment(data: Record<string, any>): string | null {
  return data.assignedTo ?? data.developerId ?? data.assigned_to ?? null;
}

// ============================================================================
// COMPLEXITY FIELDS
// ============================================================================

/**
 * Story complexity levels.
 */
export type StoryComplexity = 'simple' | 'medium' | 'complex' | 'very_complex';

/**
 * STANDARD: Use `estimatedComplexity` everywhere.
 * DEPRECATED: `complexity` alone (ambiguous)
 */
export interface ComplexityTracking {
  estimatedComplexity: StoryComplexity;
}

/**
 * Normalize complexity fields from various formats.
 */
export function normalizeComplexity(data: Record<string, any>): StoryComplexity {
  const value = data.estimatedComplexity ?? data.complexity ?? 'medium';

  const validValues: StoryComplexity[] = ['simple', 'medium', 'complex', 'very_complex'];
  if (validValues.includes(value)) {
    return value as StoryComplexity;
  }

  // Map legacy values
  if (value === 'easy' || value === 'trivial') return 'simple';
  if (value === 'hard' || value === 'difficult') return 'complex';

  return 'medium';
}

// ============================================================================
// FILE COLLECTION FIELDS
// ============================================================================

/**
 * File tracking - intention vs action based naming.
 *
 * PLANNING (TechLead): filesToModify, filesToCreate, filesToRead
 * EXECUTION (Developer): filesModified, filesCreated, filesRead
 */
export interface PlannedFiles {
  /** Files that SHOULD be modified (from TechLead) */
  filesToModify: string[];

  /** Files that SHOULD be created (from TechLead) */
  filesToCreate: string[];

  /** Files that SHOULD be read for context */
  filesToRead?: string[];
}

export interface ExecutedFiles {
  /** Files that WERE modified (by Developer) */
  filesModified: string[];

  /** Files that WERE created (by Developer) */
  filesCreated: string[];

  /** Files that WERE read during execution */
  filesRead?: string[];
}

// ============================================================================
// DATABASE <-> JAVASCRIPT CONVERSION
// ============================================================================

/**
 * Standard field mappings: snake_case (DB) <-> camelCase (JS)
 */
export const FIELD_MAPPINGS: Record<string, string> = {
  // Cost fields
  'cost_usd': 'costUsd',
  'developer_cost_usd': 'developerCostUsd',
  'judge_cost_usd': 'judgeCostUsd',
  'total_cost': 'totalCost',

  // PR fields
  'pull_request_number': 'pullRequestNumber',
  'pull_request_url': 'pullRequestUrl',
  'pull_request_state': 'pullRequestState',
  'pr_created': 'prCreated',

  // Repository fields
  'target_repository': 'targetRepository',
  'branch_name': 'branchName',
  'push_verified': 'pushVerified',

  // Assignment fields
  'assigned_to': 'assignedTo',
  'developer_id': 'developerId',

  // Retry fields
  'retry_count': 'retryCount',
  'judge_iterations': 'judgeIterations', // deprecated

  // Time fields
  'created_at': 'createdAt',
  'updated_at': 'updatedAt',
  'completed_at': 'completedAt',
  'started_at': 'startedAt',

  // ID fields
  'task_id': 'taskId',
  'epic_id': 'epicId',
  'story_id': 'storyId',
  'session_id': 'sessionId',
  'execution_id': 'executionId',
};

/**
 * Convert snake_case database row to camelCase JavaScript object.
 */
export function dbRowToJs<T extends Record<string, any>>(row: Record<string, any>): T {
  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(row)) {
    const camelKey = FIELD_MAPPINGS[key] || snakeToCamel(key);
    result[camelKey] = value;
  }

  return result as T;
}

/**
 * Convert camelCase JavaScript object to snake_case for database.
 */
export function jsToDbRow(obj: Record<string, any>): Record<string, any> {
  const reverseMappings = Object.fromEntries(
    Object.entries(FIELD_MAPPINGS).map(([k, v]) => [v, k])
  );

  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = reverseMappings[key] || camelToSnake(key);
    result[snakeKey] = value;
  }

  return result;
}

// Helper functions
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
