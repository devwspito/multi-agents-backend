/**
 * Centralized logging utilities for orchestration phases
 *
 * Replaces repetitive patterns like:
 *   console.log(`\n${'='.repeat(80)}`);
 *   console.log(`MESSAGE`);
 *   console.log(`${'='.repeat(80)}\n`);
 *
 * With cleaner calls:
 *   logSection('MESSAGE');
 */

/**
 * Log a decorated section header with borders
 */
export function logSection(
  message: string,
  options: { width?: number; char?: string; newlines?: boolean } = {}
): void {
  const { width = 80, char = '=', newlines = true } = options;
  const border = char.repeat(width);

  if (newlines) console.log('');
  console.log(border);
  console.log(message);
  console.log(border);
  if (newlines) console.log('');
}

/**
 * Log a phase start banner
 */
export function logPhaseStart(phaseName: string, taskId?: string): void {
  const taskInfo = taskId ? ` (Task: ${taskId.slice(-8)})` : '';
  logSection(`🚀 [${phaseName}] Phase Starting${taskInfo}`);
}

/**
 * Log a phase completion banner
 */
export function logPhaseComplete(phaseName: string, success: boolean): void {
  const emoji = success ? '✅' : '❌';
  const status = success ? 'COMPLETED' : 'FAILED';
  logSection(`${emoji} [${phaseName}] Phase ${status}`);
}

/**
 * Log a phase skip (already completed in memory)
 */
export function logPhaseSkip(phaseName: string, reason = 'already COMPLETED'): void {
  logSection(`🎯 [UNIFIED MEMORY] ${phaseName} phase ${reason}`);
}

/**
 * Log checkpoint recovery info
 */
export function logCheckpointRecovery(
  itemType: string,
  completedCount: number,
  completedIds: string[]
): void {
  logSection(
    `🔄 [CHECKPOINT RECOVERY] Found ${completedCount} completed ${itemType}(s)`,
    { width: 60 }
  );
  console.log(`   Completed: ${completedIds.join(', ')}`);
  console.log(`   Will resume with remaining ${itemType}s only`);
}

/**
 * Log a critical error with prominent formatting
 */
export function logCriticalError(context: string, details: string[]): void {
  console.error('');
  console.error('🚨'.repeat(40));
  console.error(`🚨 CRITICAL: ${context}`);
  details.forEach(detail => console.error(`🚨 ${detail}`));
  console.error('🚨'.repeat(40));
  console.error('');
}

/**
 * Log a warning section
 */
export function logWarning(message: string): void {
  console.warn(`⚠️  ${message}`);
}

/**
 * Log a success message
 */
export function logSuccess(message: string): void {
  console.log(`✅ ${message}`);
}

/**
 * Log an info message
 */
export function logInfo(message: string): void {
  console.log(`ℹ️  ${message}`);
}

/**
 * Log a preview of long output (agent responses, etc.)
 * Replaces repeated substring/length patterns
 */
export function logOutputPreview(
  label: string,
  output: string | undefined | null,
  options: { maxChars?: number; isError?: boolean } = {}
): void {
  const { maxChars = 1000, isError = false } = options;
  const logger = isError ? console.error : console.log;

  if (!output) {
    logger(`🔍 ${label}: NO OUTPUT!`);
    return;
  }

  logger(`\n🔍 ${label} (first ${maxChars} chars):`);
  logger(output.substring(0, maxChars));

  if (output.length > maxChars) {
    logger(`... (${output.length - maxChars} more chars)`);
  }
}
