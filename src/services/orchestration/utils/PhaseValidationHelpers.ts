/**
 * Phase Validation Helpers
 *
 * Centralized validation utilities for orchestration phases to ensure:
 * - Fail-fast validation
 * - Clear error messages
 * - Consistent validation patterns across all phases
 * - Prevention of infinite retry loops
 */

import { OrchestrationContext } from '../Phase';
import { validateGitRemoteUrl } from '../../../utils/safeGitExecution';

/**
 * Validate retry limit hasn't been exceeded
 *
 * @param context - Orchestration context
 * @param phaseName - Name of the phase (e.g., 'planning', 'techLead', 'developers')
 * @param maxRetries - Maximum allowed retries (default: 3)
 * @throws Error if retry limit exceeded
 */
export function validateRetryLimit(
  context: OrchestrationContext,
  phaseName: string,
  maxRetries: number = 3
): number {
  const retryKey = `${phaseName}Retries`;
  const currentRetries = (context.getData<number>(retryKey) || 0);

  console.log(`\n🔍 [${phaseName}] Retry Limit Validation:`);
  console.log(`   Current retries: ${currentRetries}`);
  console.log(`   Maximum allowed: ${maxRetries}`);

  if (currentRetries >= maxRetries) {
    console.error(`\n❌❌❌ [${phaseName}] RETRY LIMIT EXCEEDED!`);
    console.error(`   Phase has already retried ${currentRetries} times`);
    console.error(`   Maximum allowed: ${maxRetries}`);
    console.error(`\n   🛑 STOPPING - HUMAN INTERVENTION REQUIRED`);

    throw new Error(
      `HUMAN_REQUIRED: ${phaseName} phase exceeded retry limit ` +
      `(${currentRetries}/${maxRetries}) - manual intervention needed`
    );
  }

  console.log(`✅ [${phaseName}] Retry limit check passed (${currentRetries}/${maxRetries})`);

  // Increment retry count for next time
  const nextRetries = currentRetries + 1;
  context.setData(retryKey, nextRetries);

  return currentRetries;
}

/**
 * Validate all epics have targetRepository assigned
 *
 * @param epics - Array of epics to validate
 * @param phaseName - Name of the phase performing validation
 * @throws Error if any epic is missing targetRepository
 */
export function validateEpicsHaveRepository(
  epics: any[],
  phaseName: string
): void {
  console.log(`\n🔍 [${phaseName}] Validating epic targetRepository fields...`);

  const epicsWithoutRepo = epics.filter((epic: any) => !epic.targetRepository);

  if (epicsWithoutRepo.length > 0) {
    console.error(`\n❌❌❌ [${phaseName}] CRITICAL VALIDATION ERROR!`);
    console.error(`   ${epicsWithoutRepo.length}/${epics.length} epic(s) have NO targetRepository`);
    console.error(`\n   💀 WE DON'T KNOW WHICH REPOSITORY THESE EPICS BELONG TO`);
    console.error(`\n   📋 Invalid epics:`);
    epicsWithoutRepo.forEach((epic: any) => {
      console.error(`      - Epic: ${epic.name || epic.id}`);
      console.error(`        ID: ${epic.id}`);
      console.error(`        targetRepository: ${epic.targetRepository || 'MISSING'}`);
    });

    throw new Error(
      `HUMAN_REQUIRED: ${epicsWithoutRepo.length} epic(s) have no targetRepository. ` +
      `Epics: ${epicsWithoutRepo.map((e: any) => e.name || e.id).join(', ')}`
    );
  }

  console.log(`✅ [${phaseName}] All ${epics.length} epic(s) have valid targetRepository`);
}

/**
 * Validate all repositories have valid git remote URLs
 *
 * 🔥 NOTE: This validation is now NON-BLOCKING (warning only).
 *
 * Git operations (commit, push, PR creation) are done via GitHub API
 * from the HOST/orchestrator, NOT from the sandbox/task workspace.
 * The sandbox only needs the code for development/preview.
 *
 * @param repositories - Array of repositories to validate
 * @param phaseName - Name of the phase performing validation
 * @param options - Validation options (passed to validateGitRemoteUrl)
 */
export async function validateRepositoryRemotes(
  repositories: any[],
  phaseName: string,
  options: {
    allowedHosts?: string[];
    allowedOrganizations?: string[];
    requireHttps?: boolean;
  } = {}
): Promise<void> {
  console.log(`\n🔍 [${phaseName}] Checking git remotes for ${repositories.length} repositories...`);
  console.log(`   ℹ️  Note: Git operations are done via GitHub API, not from workspace`);

  let reposWithRemote = 0;
  let reposWithoutRemote = 0;

  for (const repo of repositories) {
    if (!repo.localPath) {
      console.log(`   ⚠️ [${repo.name || 'unknown'}] No localPath - skipping`);
      reposWithoutRemote++;
      continue;
    }

    try {
      const validation = validateGitRemoteUrl(repo.localPath, {
        allowedHosts: options.allowedHosts || ['github.com', 'gitlab.com', 'bitbucket.org'],
        allowedOrganizations: options.allowedOrganizations,
        requireHttps: options.requireHttps !== false,
      });

      if (validation.valid) {
        console.log(`   ✅ [${repo.name || repo.githubRepoName}] Has remote: ${validation.remoteUrl}`);
        reposWithRemote++;
      } else {
        // Just log warning, don't fail
        console.log(`   ⚠️ [${repo.name || repo.githubRepoName}] No remote configured (OK - using GitHub API)`);
        reposWithoutRemote++;
      }
    } catch (error: any) {
      // Exception = no remote, that's OK
      console.log(`   ⚠️ [${repo.name || repo.githubRepoName}] No remote: ${error.message?.split('\n')[0] || 'unknown'}`);
      reposWithoutRemote++;
    }
  }

  // Summary - never throw, just inform
  console.log(`\n📊 [${phaseName}] Git remote summary:`);
  console.log(`   ✅ With remote: ${reposWithRemote}`);
  console.log(`   ⚠️ Without remote: ${reposWithoutRemote} (OK - git ops via GitHub API)`);
  console.log(`✅ [${phaseName}] Validation complete - proceeding`);
}

/**
 * Validate repository type assignments
 *
 * @param repositories - Array of repositories to validate
 * @param phaseName - Name of the phase performing validation
 * @throws Error if any repository is missing type
 */
export function validateRepositoryTypes(
  repositories: any[],
  phaseName: string
): void {
  console.log(`\n🔍 [${phaseName}] Validating repository type assignments...`);

  const repositoriesWithoutType = repositories.filter(r => !r.type);

  if (repositoriesWithoutType.length > 0) {
    console.error(`\n❌❌❌ [${phaseName}] REPOSITORY TYPE VALIDATION FAILED!`);
    console.error(`   ${repositoriesWithoutType.length}/${repositories.length} repository(ies) have NO type assigned`);
    console.error(`\n   💀 TYPE IS REQUIRED for repository classification`);
    console.error(`\n   📋 Repositories without type:`);
    repositoriesWithoutType.forEach((repo: any) => {
      console.error(`      - Repository: ${repo.name || repo.githubRepoName || 'unknown'}`);
      console.error(`        Path: ${repo.localPath || 'N/A'}`);
      console.error(`        Type: ${repo.type || 'MISSING'}`);
    });

    throw new Error(
      `HUMAN_REQUIRED: ${repositoriesWithoutType.length} repository(ies) have no type assigned. ` +
      `Repositories: ${repositoriesWithoutType.map((r: any) => r.name || r.githubRepoName).join(', ')}`
    );
  }

  console.log(`✅ [${phaseName}] All ${repositories.length} repositories have valid types`);
}

/**
 * Validate budget hasn't been exceeded
 *
 * @param context - Orchestration context
 * @param phaseName - Name of the phase
 * @param maxBudget - Maximum allowed budget in USD
 * @param budgetKey - Context key for tracking budget (default: '{phaseName}Cost')
 * @returns Current budget used
 * @throws Error if budget exceeded
 */
export function validateBudget(
  context: OrchestrationContext,
  phaseName: string,
  maxBudget: number,
  budgetKey?: string
): number {
  const key = budgetKey || `${phaseName}Cost`;
  const currentCost = context.getData<number>(key) || 0;

  console.log(`\n🔍 [${phaseName}] Budget Validation:`);
  console.log(`   Current cost: $${currentCost.toFixed(4)}`);
  console.log(`   Maximum budget: $${maxBudget.toFixed(2)}`);
  console.log(`   Remaining: $${(maxBudget - currentCost).toFixed(4)}`);

  if (currentCost >= maxBudget) {
    console.error(`\n❌❌❌ [${phaseName}] BUDGET EXCEEDED!`);
    console.error(`   Current cost: $${currentCost.toFixed(4)}`);
    console.error(`   Maximum budget: $${maxBudget.toFixed(2)}`);
    console.error(`\n   🛑 STOPPING - Budget exhausted`);

    throw new Error(
      `HUMAN_REQUIRED: ${phaseName} phase exceeded budget ` +
      `($${currentCost.toFixed(4)}/$${maxBudget.toFixed(2)})`
    );
  }

  const percentageUsed = (currentCost / maxBudget) * 100;
  if (percentageUsed > 80) {
    console.warn(`⚠️  [${phaseName}] Budget warning: ${percentageUsed.toFixed(1)}% used`);
  } else {
    console.log(`✅ [${phaseName}] Budget check passed (${percentageUsed.toFixed(1)}% used)`);
  }

  return currentCost;
}

/**
 * Validate required context keys exist
 *
 * Wrapper around ContextHelpers.validateRequiredContext with phase-specific logging
 *
 * @param context - Orchestration context
 * @param phaseName - Name of the phase
 * @param requiredKeys - Array of required context keys
 * @throws Error if any required key is missing
 */
export function validateRequiredPhaseContext(
  context: OrchestrationContext,
  phaseName: string,
  requiredKeys: string[]
): void {
  console.log(`\n🔍 [${phaseName}] Validating required context data...`);
  console.log(`   Required keys: ${requiredKeys.join(', ')}`);

  const missingKeys: string[] = [];
  for (const key of requiredKeys) {
    // 🔥 FIX: Check BOTH sharedData (via getData) AND direct context properties
    // Some data is stored as direct properties (e.g., context.repositories)
    // Others are in sharedData (e.g., context.getData('epics'))
    const valueFromSharedData = context.getData(key);
    const valueFromContext = (context as any)[key]; // Direct property access

    const value = valueFromSharedData !== undefined ? valueFromSharedData : valueFromContext;

    // 🔥 FIX: Also check if arrays are empty (empty array = missing data)
    if (value === undefined || value === null) {
      missingKeys.push(key);
    } else if (Array.isArray(value) && value.length === 0) {
      console.warn(`   ⚠️  [${phaseName}] ${key} is an empty array`);
      missingKeys.push(`${key} (empty)`);
    }
  }

  if (missingKeys.length > 0) {
    console.error(`\n❌❌❌ [${phaseName}] REQUIRED CONTEXT DATA MISSING!`);
    console.error(`   Missing keys: ${missingKeys.join(', ')}`);
    console.error(`   Required keys: ${requiredKeys.join(', ')}`);

    throw new Error(
      `HUMAN_REQUIRED: ${phaseName} phase missing required context data: ${missingKeys.join(', ')}`
    );
  }

  console.log(`✅ [${phaseName}] All required context data present`);
}
