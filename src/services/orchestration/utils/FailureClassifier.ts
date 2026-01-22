/**
 * Failure Classifier - AGGRESSIVE recovery-first approach
 *
 * PHILOSOPHY:
 * Stories should ONLY fail for TWO reasons:
 * 1. Judge explicitly rejects the code (legitimate failure)
 * 2. Claude API is down/rate limited (out of our control)
 *
 * EVERYTHING ELSE must be retried or recovered:
 * - Network errors → Retry infinitely with backoff
 * - Timeout → Retry with longer timeout
 * - Git errors → Retry/recover
 * - Missing work → Detect and recover (auto-commit)
 * - Developer doesn't commit → Auto-commit
 * - Developer doesn't push → Auto-push
 */

import { WorkspaceDetectionResult } from './GitCommitHelper';

/**
 * Categories of failure - only 2 are terminal
 */
export enum FailureCategory {
  // ═══════════════════════════════════════════════════════════════════════════
  // TERMINAL FAILURES - These are the ONLY acceptable reasons to fail
  // ═══════════════════════════════════════════════════════════════════════════

  /** Judge explicitly rejected the code - LEGITIMATE FAILURE */
  JUDGE_REJECTED = 'JUDGE_REJECTED',

  /** Claude API error (rate limit, server error, etc) - OUT OF CONTROL */
  CLAUDE_API_ERROR = 'CLAUDE_API_ERROR',

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE - These MUST be retried/recovered, never allowed to fail
  // ═══════════════════════════════════════════════════════════════════════════

  /** Network/connection issue - MUST RETRY */
  NETWORK_ERROR = 'NETWORK_ERROR',

  /** Operation timed out - MUST RETRY with longer timeout */
  TIMEOUT = 'TIMEOUT',

  /** Git operation failed - MUST RETRY/RECOVER */
  GIT_ERROR = 'GIT_ERROR',

  /** Work exists but not committed - MUST AUTO-COMMIT */
  UNCOMMITTED_WORK = 'UNCOMMITTED_WORK',

  /** Work exists but not pushed - MUST AUTO-PUSH */
  UNPUSHED_WORK = 'UNPUSHED_WORK',

  /** Developer retries exhausted but work may exist - MUST RECOVER */
  RETRY_EXHAUSTED = 'RETRY_EXHAUSTED',

  /** Unknown error - ASSUME RECOVERABLE, try everything */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Recovery strategy - most should be RETRY or RECOVER
 */
export enum RecoveryStrategy {
  /** Retry the operation immediately */
  RETRY_IMMEDIATE = 'RETRY_IMMEDIATE',

  /** Retry with exponential backoff */
  RETRY_WITH_BACKOFF = 'RETRY_WITH_BACKOFF',

  /** Retry with increased timeout */
  RETRY_WITH_MORE_TIME = 'RETRY_WITH_MORE_TIME',

  /** Auto-commit uncommitted work, then proceed */
  AUTO_COMMIT_AND_CONTINUE = 'AUTO_COMMIT_AND_CONTINUE',

  /** Auto-push unpushed work, then proceed */
  AUTO_PUSH_AND_CONTINUE = 'AUTO_PUSH_AND_CONTINUE',

  /** Try to salvage any work and send to Judge */
  SALVAGE_AND_JUDGE = 'SALVAGE_AND_JUDGE',

  /** Terminal: Judge rejected - this is a legitimate failure */
  ACCEPT_FAILURE_JUDGE_REJECTED = 'ACCEPT_FAILURE_JUDGE_REJECTED',

  /** Terminal: Claude API error - out of our control */
  ACCEPT_FAILURE_API_ERROR = 'ACCEPT_FAILURE_API_ERROR',
}

/**
 * Detailed failure analysis result
 */
export interface FailureAnalysis {
  category: FailureCategory;
  strategy: RecoveryStrategy;
  confidence: 'high' | 'medium' | 'low';
  evidence: string[];
  recommendations: string[];

  /** Whether this failure is terminal (no more recovery possible) */
  isTerminal: boolean;

  /** Whether to call Judge (if work exists) */
  shouldCallJudge: boolean;

  /** Whether to retry the operation */
  shouldRetry: boolean;

  /** Retry delay in ms (if shouldRetry) */
  retryDelay?: number;

  /** Max additional retries to attempt */
  maxAdditionalRetries?: number;
}

/**
 * Context for failure analysis
 */
export interface FailureContext {
  /** The error that was thrown */
  error: Error | string;
  /** Number of retries already attempted */
  retriesAttempted: number;
  /** Maximum retries configured */
  maxRetries: number;
  /** Developer agent output (if available) */
  developerOutput?: string;
  /** Workspace detection results (if available) */
  workspaceDetection?: WorkspaceDetectionResult;
  /** Whether any commits exist on the branch */
  hasCommitsOnBranch?: boolean;
  /** Time elapsed for the operation */
  elapsedTimeMs?: number;
  /** Configured timeout */
  timeoutMs?: number;
  /** Phase where failure occurred */
  phase?: 'developer' | 'judge' | 'merge' | 'other';
  /** Whether Judge already evaluated and rejected */
  judgeRejected?: boolean;
}

/**
 * Patterns for error classification
 */
const PATTERNS = {
  CLAUDE_API: [
    /anthropic/i,
    /rate.?limit/i,
    /overloaded/i,
    /529/,
    /529\s/,
    /api.*error/i,
    /authentication.*failed/i,
    /invalid.*api.*key/i,
    /quota.*exceeded/i,
    /capacity/i,
    /service.*unavailable/i,
  ],
  TIMEOUT: [
    /timed?.?out/i,
    /timeout/i,
    /ETIMEDOUT/i,
    /operation took too long/i,
    /exceeded.*time/i,
    /deadline/i,
  ],
  NETWORK: [
    /ECONNREFUSED/i,
    /ENOTFOUND/i,
    /ECONNRESET/i,
    /ENETUNREACH/i,
    /network/i,
    /connection refused/i,
    /could not resolve/i,
    /fetch failed/i,
    /socket hang up/i,
    /EPROTO/i,
    /certificate/i,
  ],
  GIT: [
    /git.*fail/i,
    /merge conflict/i,
    /CONFLICT/,
    /cannot merge/i,
    /not a git repository/i,
    /refusing to merge/i,
    /fatal:/i,
    /Already up to date/i,
  ],
};

/**
 * Aggressive retry limits - we want to succeed, not fail
 */
const AGGRESSIVE_LIMITS = {
  /** Max retries for network errors */
  NETWORK_MAX_RETRIES: 10,
  /** Max retries for timeout errors */
  TIMEOUT_MAX_RETRIES: 5,
  /** Max retries for git errors */
  GIT_MAX_RETRIES: 5,
  /** Max retries for unknown errors */
  UNKNOWN_MAX_RETRIES: 3,
  /** Base delay for backoff (ms) */
  BASE_DELAY: 5000,
  /** Max delay for backoff (ms) */
  MAX_DELAY: 60000,
};

/**
 * Classify a failure and determine recovery strategy
 *
 * AGGRESSIVE APPROACH: Assume everything is recoverable unless proven otherwise
 */
export function classifyFailure(context: FailureContext): FailureAnalysis {
  const errorMessage = typeof context.error === 'string' ? context.error : context.error.message;
  const evidence: string[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // TERMINAL CHECK 1: Did Judge explicitly reject?
  // ═══════════════════════════════════════════════════════════════════════════
  if (context.judgeRejected) {
    evidence.push('Judge explicitly rejected the code');
    return {
      category: FailureCategory.JUDGE_REJECTED,
      strategy: RecoveryStrategy.ACCEPT_FAILURE_JUDGE_REJECTED,
      confidence: 'high',
      evidence,
      recommendations: ['Code quality issue - needs human review', 'Story requirements may need clarification'],
      isTerminal: true,
      shouldCallJudge: false,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TERMINAL CHECK 2: Is this a Claude API error?
  // ═══════════════════════════════════════════════════════════════════════════
  if (isClaudeAPIError(errorMessage)) {
    evidence.push(`Claude API error detected: ${errorMessage.substring(0, 100)}`);

    // Even for API errors, retry a few times (might be transient)
    if (context.retriesAttempted < 3) {
      return {
        category: FailureCategory.CLAUDE_API_ERROR,
        strategy: RecoveryStrategy.RETRY_WITH_BACKOFF,
        confidence: 'high',
        evidence,
        recommendations: ['Retry with exponential backoff', 'API may recover'],
        isTerminal: false,
        shouldCallJudge: false,
        shouldRetry: true,
        retryDelay: calculateBackoff(context.retriesAttempted),
        maxAdditionalRetries: 3 - context.retriesAttempted,
      };
    }

    // Only terminal after multiple retries
    return {
      category: FailureCategory.CLAUDE_API_ERROR,
      strategy: RecoveryStrategy.ACCEPT_FAILURE_API_ERROR,
      confidence: 'high',
      evidence,
      recommendations: ['Claude API unavailable after retries', 'Wait and retry later'],
      isTerminal: true,
      shouldCallJudge: false,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE: Check for work that exists but isn't committed/pushed
  // ═══════════════════════════════════════════════════════════════════════════
  if (context.workspaceDetection?.hasUncommittedFiles || context.workspaceDetection?.hasUntrackedFiles) {
    evidence.push(`Found ${context.workspaceDetection.totalChanges} uncommitted/untracked files`);
    evidence.push(`Modified: ${context.workspaceDetection.modifiedFiles.join(', ') || 'none'}`);

    return {
      category: FailureCategory.UNCOMMITTED_WORK,
      strategy: RecoveryStrategy.AUTO_COMMIT_AND_CONTINUE,
      confidence: 'high',
      evidence,
      recommendations: ['Auto-commit all changes', 'Auto-push to branch', 'Send to Judge'],
      isTerminal: false,
      shouldCallJudge: true,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE: Work exists on branch but something else failed
  // ═══════════════════════════════════════════════════════════════════════════
  if (context.hasCommitsOnBranch) {
    evidence.push('Commits exist on branch');

    return {
      category: FailureCategory.UNPUSHED_WORK,
      strategy: RecoveryStrategy.SALVAGE_AND_JUDGE,
      confidence: 'high',
      evidence,
      recommendations: ['Work exists on branch', 'Send directly to Judge', 'Skip failed developer retry'],
      isTerminal: false,
      shouldCallJudge: true,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE: Network error - MUST RETRY
  // ═══════════════════════════════════════════════════════════════════════════
  if (isNetworkError(errorMessage)) {
    evidence.push(`Network error: ${errorMessage.substring(0, 100)}`);

    const remainingRetries = AGGRESSIVE_LIMITS.NETWORK_MAX_RETRIES - context.retriesAttempted;
    if (remainingRetries > 0) {
      return {
        category: FailureCategory.NETWORK_ERROR,
        strategy: RecoveryStrategy.RETRY_WITH_BACKOFF,
        confidence: 'high',
        evidence,
        recommendations: ['Network issue - retry with backoff', `${remainingRetries} retries remaining`],
        isTerminal: false,
        shouldCallJudge: false,
        shouldRetry: true,
        retryDelay: calculateBackoff(context.retriesAttempted),
        maxAdditionalRetries: remainingRetries,
      };
    }

    // Even after max retries, try to salvage any work
    evidence.push('Max network retries exhausted - attempting salvage');
    return {
      category: FailureCategory.NETWORK_ERROR,
      strategy: RecoveryStrategy.SALVAGE_AND_JUDGE,
      confidence: 'medium',
      evidence,
      recommendations: ['Network retries exhausted', 'Attempting to salvage any work'],
      isTerminal: false,
      shouldCallJudge: true,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE: Timeout - MUST RETRY with more time
  // ═══════════════════════════════════════════════════════════════════════════
  if (isTimeoutError(errorMessage, context)) {
    evidence.push(`Timeout: ${errorMessage.substring(0, 100)}`);

    const remainingRetries = AGGRESSIVE_LIMITS.TIMEOUT_MAX_RETRIES - context.retriesAttempted;
    if (remainingRetries > 0) {
      return {
        category: FailureCategory.TIMEOUT,
        strategy: RecoveryStrategy.RETRY_WITH_MORE_TIME,
        confidence: 'high',
        evidence,
        recommendations: ['Timeout - retry with longer limit', `${remainingRetries} retries remaining`],
        isTerminal: false,
        shouldCallJudge: false,
        shouldRetry: true,
        retryDelay: 2000, // Short delay, the issue is timeout not rate limiting
        maxAdditionalRetries: remainingRetries,
      };
    }

    // Even after max retries, try to salvage any work
    evidence.push('Max timeout retries exhausted - attempting salvage');
    return {
      category: FailureCategory.TIMEOUT,
      strategy: RecoveryStrategy.SALVAGE_AND_JUDGE,
      confidence: 'medium',
      evidence,
      recommendations: ['Timeout retries exhausted', 'Attempting to salvage any work'],
      isTerminal: false,
      shouldCallJudge: true,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECOVERABLE: Git error - MUST RETRY/RECOVER
  // ═══════════════════════════════════════════════════════════════════════════
  if (isGitError(errorMessage)) {
    evidence.push(`Git error: ${errorMessage.substring(0, 100)}`);

    const remainingRetries = AGGRESSIVE_LIMITS.GIT_MAX_RETRIES - context.retriesAttempted;
    if (remainingRetries > 0) {
      return {
        category: FailureCategory.GIT_ERROR,
        strategy: RecoveryStrategy.RETRY_IMMEDIATE,
        confidence: 'high',
        evidence,
        recommendations: ['Git error - retry', `${remainingRetries} retries remaining`],
        isTerminal: false,
        shouldCallJudge: false,
        shouldRetry: true,
        retryDelay: 1000,
        maxAdditionalRetries: remainingRetries,
      };
    }

    // Try to salvage
    evidence.push('Max git retries exhausted - attempting salvage');
    return {
      category: FailureCategory.GIT_ERROR,
      strategy: RecoveryStrategy.SALVAGE_AND_JUDGE,
      confidence: 'medium',
      evidence,
      recommendations: ['Git retries exhausted', 'Attempting to salvage any work'],
      isTerminal: false,
      shouldCallJudge: true,
      shouldRetry: false,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNKNOWN: Assume recoverable, try everything
  // ═══════════════════════════════════════════════════════════════════════════
  evidence.push(`Unknown error: ${errorMessage.substring(0, 100)}`);

  const remainingRetries = AGGRESSIVE_LIMITS.UNKNOWN_MAX_RETRIES - context.retriesAttempted;
  if (remainingRetries > 0) {
    return {
      category: FailureCategory.UNKNOWN,
      strategy: RecoveryStrategy.RETRY_WITH_BACKOFF,
      confidence: 'low',
      evidence,
      recommendations: ['Unknown error - retry with backoff', `${remainingRetries} retries remaining`],
      isTerminal: false,
      shouldCallJudge: false,
      shouldRetry: true,
      retryDelay: calculateBackoff(context.retriesAttempted),
      maxAdditionalRetries: remainingRetries,
    };
  }

  // Last resort: try to salvage ANY work
  evidence.push('All retries exhausted - final salvage attempt');
  return {
    category: FailureCategory.UNKNOWN,
    strategy: RecoveryStrategy.SALVAGE_AND_JUDGE,
    confidence: 'low',
    evidence,
    recommendations: [
      'All retries exhausted',
      'Final attempt: salvage any existing work',
      'If no work found, this will be marked as failed',
    ],
    isTerminal: false,
    shouldCallJudge: true,
    shouldRetry: false,
  };
}

/**
 * Check if error is from Claude API
 */
function isClaudeAPIError(errorMessage: string): boolean {
  return PATTERNS.CLAUDE_API.some((p) => p.test(errorMessage));
}

/**
 * Check if error is a network error
 */
function isNetworkError(errorMessage: string): boolean {
  return PATTERNS.NETWORK.some((p) => p.test(errorMessage));
}

/**
 * Check if error is a timeout
 */
function isTimeoutError(errorMessage: string, context: FailureContext): boolean {
  if (PATTERNS.TIMEOUT.some((p) => p.test(errorMessage))) {
    return true;
  }
  // Check if elapsed time is near timeout
  if (context.elapsedTimeMs && context.timeoutMs) {
    const timeoutThreshold = context.timeoutMs * 0.9;
    if (context.elapsedTimeMs >= timeoutThreshold) {
      return true;
    }
  }
  return false;
}

/**
 * Check if error is a git error
 */
function isGitError(errorMessage: string): boolean {
  return PATTERNS.GIT.some((p) => p.test(errorMessage));
}

/**
 * Calculate exponential backoff delay
 */
function calculateBackoff(attempt: number): number {
  const delay = AGGRESSIVE_LIMITS.BASE_DELAY * Math.pow(2, attempt);
  return Math.min(delay, AGGRESSIVE_LIMITS.MAX_DELAY);
}

/**
 * Log failure analysis with clear terminal vs recoverable indication
 */
export function logFailureAnalysis(
  storyTitle: string,
  storyId: string,
  analysis: FailureAnalysis
): void {
  const terminalEmoji = analysis.isTerminal ? '💀' : '🔄';
  const strategyEmoji: Record<RecoveryStrategy, string> = {
    [RecoveryStrategy.RETRY_IMMEDIATE]: '🔁',
    [RecoveryStrategy.RETRY_WITH_BACKOFF]: '⏳',
    [RecoveryStrategy.RETRY_WITH_MORE_TIME]: '⏱️',
    [RecoveryStrategy.AUTO_COMMIT_AND_CONTINUE]: '📝',
    [RecoveryStrategy.AUTO_PUSH_AND_CONTINUE]: '📤',
    [RecoveryStrategy.SALVAGE_AND_JUDGE]: '🔧',
    [RecoveryStrategy.ACCEPT_FAILURE_JUDGE_REJECTED]: '❌',
    [RecoveryStrategy.ACCEPT_FAILURE_API_ERROR]: '🚫',
  };

  console.log(`\n${'='.repeat(80)}`);
  console.log(`${terminalEmoji} [FAILURE ANALYSIS] ${storyTitle}`);
  console.log(`   Story ID: ${storyId}`);
  console.log(`   Category: ${analysis.category}`);
  console.log(`   Strategy: ${strategyEmoji[analysis.strategy]} ${analysis.strategy}`);
  console.log(`   Terminal: ${analysis.isTerminal ? 'YES - WILL FAIL' : 'NO - WILL RECOVER'}`);
  console.log(`   Should retry: ${analysis.shouldRetry ? `YES (delay: ${analysis.retryDelay}ms)` : 'NO'}`);
  console.log(`   Should call Judge: ${analysis.shouldCallJudge ? 'YES' : 'NO'}`);
  console.log(`   Evidence:`);
  analysis.evidence.forEach((e) => console.log(`     - ${e}`));
  console.log(`   Recommendations:`);
  analysis.recommendations.forEach((r) => console.log(`     - ${r}`));
  console.log(`${'='.repeat(80)}`);
}

/**
 * Helper to check if a failure is terminal (story should actually fail)
 */
export function isTerminalFailure(analysis: FailureAnalysis): boolean {
  return analysis.isTerminal;
}

/**
 * Get human-readable failure reason for terminal failures only
 */
export function getTerminalFailureReason(analysis: FailureAnalysis): string | null {
  if (!analysis.isTerminal) return null;

  switch (analysis.category) {
    case FailureCategory.JUDGE_REJECTED:
      return 'Code was rejected by Judge - quality/requirements not met';
    case FailureCategory.CLAUDE_API_ERROR:
      return 'Claude API unavailable after multiple retries';
    default:
      return 'Unknown terminal failure';
  }
}
