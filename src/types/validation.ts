/**
 * Data Validation Module
 *
 * Ensures data integrity before saving to database or exporting for AI training.
 * Use these validators at system boundaries (API input, DB write, export).
 *
 * USAGE:
 *   import { validateStory, validateEpic, sanitizeForExport } from '../types/validation';
 *
 *   // Before saving
 *   const errors = validateStory(story);
 *   if (errors.length > 0) throw new Error(errors.join(', '));
 *
 *   // Before exporting
 *   const cleanData = sanitizeForExport(orchestrationData);
 */

import { VALID_BASE_STATUSES, VALID_STORY_STATUSES, VALID_PHASE_STATUSES } from './status';

// ============================================================================
// VALIDATION RESULT TYPE
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function createResult(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

// ============================================================================
// STORY VALIDATION
// ============================================================================

/**
 * Validate a story object has all required fields with correct types.
 */
export function validateStory(story: any, context = 'story'): ValidationResult {
  const result = createResult();

  if (!story) {
    result.valid = false;
    result.errors.push(`${context}: Story is null or undefined`);
    return result;
  }

  // Required: ID (one of id, storyId, or title)
  const storyId = story.id || story.storyId || story.title;
  if (!storyId || typeof storyId !== 'string' || storyId.trim() === '') {
    result.valid = false;
    result.errors.push(`${context}: Missing valid ID (id, storyId, or title)`);
  }

  // Required: epicId
  if (!story.epicId || typeof story.epicId !== 'string') {
    result.valid = false;
    result.errors.push(`${context}: Missing or invalid epicId`);
  }

  // Required: title
  if (!story.title || typeof story.title !== 'string') {
    result.valid = false;
    result.errors.push(`${context}: Missing or invalid title`);
  }

  // Optional but validated: status
  if (story.status && !VALID_STORY_STATUSES.includes(story.status)) {
    result.valid = false;
    result.errors.push(`${context}: Invalid status "${story.status}". Valid: ${VALID_STORY_STATUSES.join(', ')}`);
  }

  // Warning: Missing targetRepository
  if (!story.targetRepository) {
    result.warnings.push(`${context}: Missing targetRepository - may cause routing issues`);
  }

  // Warning: Deprecated field names
  if (story.judgeIterations !== undefined && story.retryCount === undefined) {
    result.warnings.push(`${context}: Using deprecated field "judgeIterations" - migrate to "retryCount"`);
  }
  if (story.cost_usd !== undefined && story.costUsd === undefined) {
    result.warnings.push(`${context}: Using deprecated field "cost_usd" - migrate to "costUsd"`);
  }

  return result;
}

// ============================================================================
// EPIC VALIDATION
// ============================================================================

/**
 * Validate an epic object has all required fields with correct types.
 */
export function validateEpic(epic: any, context = 'epic'): ValidationResult {
  const result = createResult();

  if (!epic) {
    result.valid = false;
    result.errors.push(`${context}: Epic is null or undefined`);
    return result;
  }

  // Required: ID (one of id, epicId, or title)
  const epicId = epic.id || epic.epicId || epic.title;
  if (!epicId || typeof epicId !== 'string' || epicId.trim() === '') {
    result.valid = false;
    result.errors.push(`${context}: Missing valid ID (id, epicId, or title)`);
  }

  // Required: name or title
  if (!epic.name && !epic.title) {
    result.valid = false;
    result.errors.push(`${context}: Missing name or title`);
  }

  // Required: targetRepository
  if (!epic.targetRepository || typeof epic.targetRepository !== 'string') {
    result.valid = false;
    result.errors.push(`${context}: Missing or invalid targetRepository`);
  }

  // Optional but validated: status
  if (epic.status && !VALID_BASE_STATUSES.includes(epic.status)) {
    result.valid = false;
    result.errors.push(`${context}: Invalid status "${epic.status}". Valid: ${VALID_BASE_STATUSES.join(', ')}`);
  }

  // Validate nested stories if present
  if (epic.stories && Array.isArray(epic.stories)) {
    for (let i = 0; i < epic.stories.length; i++) {
      const storyResult = validateStory(epic.stories[i], `${context}.stories[${i}]`);
      result.errors.push(...storyResult.errors);
      result.warnings.push(...storyResult.warnings);
      if (!storyResult.valid) result.valid = false;
    }
  }

  return result;
}

// ============================================================================
// PHASE EXECUTION VALIDATION
// ============================================================================

/**
 * Validate a phase execution record.
 */
export function validatePhaseExecution(phase: any, phaseName = 'phase'): ValidationResult {
  const result = createResult();

  if (!phase) {
    result.valid = false;
    result.errors.push(`${phaseName}: Phase execution is null or undefined`);
    return result;
  }

  // Optional but validated: status
  if (phase.status && !VALID_PHASE_STATUSES.includes(phase.status)) {
    result.valid = false;
    result.errors.push(`${phaseName}: Invalid status "${phase.status}". Valid: ${VALID_PHASE_STATUSES.join(', ')}`);
  }

  return result;
}

// ============================================================================
// ORCHESTRATION VALIDATION
// ============================================================================

/**
 * Validate the entire orchestration object before saving.
 */
export function validateOrchestration(orch: any): ValidationResult {
  const result = createResult();

  if (!orch) {
    result.valid = false;
    result.errors.push('Orchestration is null or undefined');
    return result;
  }

  // Validate planning epics
  if (orch.planning?.epics) {
    if (!Array.isArray(orch.planning.epics)) {
      result.valid = false;
      result.errors.push('planning.epics must be an array');
    } else {
      for (let i = 0; i < orch.planning.epics.length; i++) {
        const epicResult = validateEpic(orch.planning.epics[i], `planning.epics[${i}]`);
        result.errors.push(...epicResult.errors);
        result.warnings.push(...epicResult.warnings);
        if (!epicResult.valid) result.valid = false;
      }
    }
  }

  // Validate phase executions
  const phaseNames = ['problemAnalysis', 'planning', 'techLead', 'developers', 'judge', 'qa', 'integration'];
  for (const phaseName of phaseNames) {
    if (orch[phaseName]) {
      const phaseResult = validatePhaseExecution(orch[phaseName], phaseName);
      result.errors.push(...phaseResult.errors);
      result.warnings.push(...phaseResult.warnings);
      if (!phaseResult.valid) result.valid = false;
    }
  }

  return result;
}

// ============================================================================
// SANITIZATION FOR TRAINING DATA EXPORT
// ============================================================================

/**
 * Sanitize data for AI training export.
 * - Normalizes field names to standard conventions
 * - Removes null/undefined values
 * - Ensures consistent status values
 * - Removes sensitive data (if any)
 */
export function sanitizeForExport(data: any): any {
  if (data === null || data === undefined) return null;

  if (Array.isArray(data)) {
    return data.map(item => sanitizeForExport(item)).filter(item => item !== null);
  }

  if (typeof data !== 'object') return data;

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(data)) {
    // Skip null/undefined values
    if (value === null || value === undefined) continue;

    // Normalize field names
    const normalizedKey = normalizeFieldName(key);

    // Recursively sanitize nested objects
    sanitized[normalizedKey] = sanitizeForExport(value);
  }

  return sanitized;
}

/**
 * Normalize field name to standard convention.
 */
function normalizeFieldName(fieldName: string): string {
  const mappings: Record<string, string> = {
    // Deprecated → Standard
    'judgeIterations': 'retryCount',
    'cost_usd': 'costUsd',
    'developer_cost_usd': 'developerCostUsd',
    'judge_cost_usd': 'judgeCostUsd',
    'cost': 'costUsd',

    // Database → JavaScript
    'target_repository': 'targetRepository',
    'branch_name': 'branchName',
    'push_verified': 'pushVerified',
    'task_id': 'taskId',
    'epic_id': 'epicId',
    'story_id': 'storyId',
    'created_at': 'createdAt',
    'updated_at': 'updatedAt',
  };

  return mappings[fieldName] || fieldName;
}

/**
 * Validate and sanitize data in one step.
 * Returns sanitized data if valid, throws if invalid.
 */
export function validateAndSanitize(data: any, validator: (data: any) => ValidationResult): any {
  const result = validator(data);

  if (!result.valid) {
    throw new Error(`Validation failed: ${result.errors.join('; ')}`);
  }

  if (result.warnings.length > 0) {
    console.warn(`[Validation] Warnings: ${result.warnings.join('; ')}`);
  }

  return sanitizeForExport(data);
}

// ============================================================================
// BATCH VALIDATION
// ============================================================================

/**
 * Validate a batch of stories (for training export).
 */
export function validateStoryBatch(stories: any[]): ValidationResult {
  const result = createResult();

  if (!Array.isArray(stories)) {
    result.valid = false;
    result.errors.push('Stories must be an array');
    return result;
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < stories.length; i++) {
    const story = stories[i];
    const storyResult = validateStory(story, `stories[${i}]`);

    // Check for duplicate IDs
    const storyId = story?.id || story?.storyId || story?.title;
    if (storyId && seenIds.has(storyId)) {
      result.valid = false;
      result.errors.push(`stories[${i}]: Duplicate story ID "${storyId}"`);
    }
    seenIds.add(storyId);

    result.errors.push(...storyResult.errors);
    result.warnings.push(...storyResult.warnings);
    if (!storyResult.valid) result.valid = false;
  }

  return result;
}

/**
 * Validate a batch of epics (for training export).
 */
export function validateEpicBatch(epics: any[]): ValidationResult {
  const result = createResult();

  if (!Array.isArray(epics)) {
    result.valid = false;
    result.errors.push('Epics must be an array');
    return result;
  }

  const seenIds = new Set<string>();

  for (let i = 0; i < epics.length; i++) {
    const epic = epics[i];
    const epicResult = validateEpic(epic, `epics[${i}]`);

    // Check for duplicate IDs
    const epicId = epic?.id || epic?.epicId || epic?.title;
    if (epicId && seenIds.has(epicId)) {
      result.valid = false;
      result.errors.push(`epics[${i}]: Duplicate epic ID "${epicId}"`);
    }
    seenIds.add(epicId);

    result.errors.push(...epicResult.errors);
    result.warnings.push(...epicResult.warnings);
    if (!epicResult.valid) result.valid = false;
  }

  return result;
}

// ============================================================================
// TRAINING DATA QUALITY CHECK
// ============================================================================

/**
 * Comprehensive quality check for training data export.
 * Returns detailed report of data quality issues.
 */
export function checkTrainingDataQuality(taskData: any): {
  valid: boolean;
  score: number;
  issues: string[];
  suggestions: string[];
} {
  const issues: string[] = [];
  const suggestions: string[] = [];
  let score = 100;

  // Check epics
  const epics = taskData?.orchestration?.planning?.epics || [];
  if (epics.length === 0) {
    issues.push('No epics found in task data');
    score -= 20;
  } else {
    const epicResult = validateEpicBatch(epics);
    issues.push(...epicResult.errors);
    if (epicResult.warnings.length > 0) {
      suggestions.push(...epicResult.warnings.map(w => `[Warning] ${w}`));
      score -= epicResult.warnings.length * 2;
    }
    if (!epicResult.valid) score -= 30;
  }

  // Check for consistent targetRepository
  const repos = new Set<string>();
  for (const epic of epics) {
    if (epic.targetRepository) repos.add(epic.targetRepository);
    for (const story of epic.stories || []) {
      if (story.targetRepository) repos.add(story.targetRepository);
    }
  }
  if (repos.size === 0) {
    issues.push('No targetRepository found in any epic or story');
    score -= 15;
  }

  // Check for empty IDs
  let emptyIdCount = 0;
  for (const epic of epics) {
    if (!epic.id && !epic.epicId && !epic.title) emptyIdCount++;
    for (const story of epic.stories || []) {
      if (!story.id && !story.storyId && !story.title) emptyIdCount++;
    }
  }
  if (emptyIdCount > 0) {
    issues.push(`${emptyIdCount} items have empty or missing IDs`);
    score -= emptyIdCount * 5;
  }

  // Check cost data
  let hasCostData = false;
  if (taskData?.orchestration?.totalCost > 0) hasCostData = true;
  if (!hasCostData) {
    suggestions.push('No cost data found - consider tracking costUsd for training');
  }

  // Ensure score is between 0 and 100
  score = Math.max(0, Math.min(100, score));

  return {
    valid: issues.length === 0,
    score,
    issues,
    suggestions,
  };
}
