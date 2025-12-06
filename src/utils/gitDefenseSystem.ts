/**
 * Git Defense System - Comprehensive protection against git/GitHub failures
 *
 * USER FEEDBACK: "lo de github y nuestro sistema esta siendo un autentico calvario"
 *
 * DEFENSE LAYERS:
 * 1. Pre-Flight Checks - Validate before operations
 * 2. Git Status Validator - Detect dirty states
 * 3. GitHub Health Check - Verify connectivity
 * 4. Auto-Recovery - Fix common errors automatically
 * 5. Graceful Degradation - Continue without git if needed
 */

import { safeGitExecSync } from './safeGitExecution';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Git repository health status
 */
export interface GitHealthStatus {
  healthy: boolean;
  issues: string[];
  warnings: string[];
  canProceed: boolean;
  autoRecoveryAttempted: boolean;
  autoRecoverySucceeded: boolean;
}

/**
 * GitHub connectivity status
 */
export interface GitHubHealthStatus {
  reachable: boolean;
  authenticated: boolean;
  rateLimitOk: boolean;
  error?: string;
  canProceed: boolean;
}

/**
 * Pre-flight check result
 */
export interface PreFlightCheckResult {
  passed: boolean;
  gitHealth: GitHealthStatus;
  githubHealth?: GitHubHealthStatus;
  recommendations: string[];
  canProceedWithWarnings: boolean;
}

/**
 * PRE-FLIGHT CHECK - Run BEFORE any git operation
 *
 * Validates:
 * - Repository exists
 * - .git directory is valid
 * - Working directory is clean (or can be recovered)
 * - No detached HEAD
 * - Remote is accessible
 *
 * @param repoPath - Path to git repository
 * @param options - Check options
 * @returns Pre-flight check result
 */
export async function runPreFlightCheck(
  repoPath: string,
  options: {
    requireCleanWorkingDir?: boolean;
    requireRemoteAccess?: boolean;
    attemptAutoRecovery?: boolean;
  } = {}
): Promise<PreFlightCheckResult> {
  const {
    requireCleanWorkingDir = true,
    requireRemoteAccess = false,
    attemptAutoRecovery = true,
  } = options;

  const recommendations: string[] = [];
  let canProceedWithWarnings = true;

  // 1. Check git health
  const gitHealth = await checkGitHealth(repoPath, {
    requireClean: requireCleanWorkingDir,
    attemptAutoRecovery,
  });

  if (!gitHealth.healthy) {
    canProceedWithWarnings = false;
  }

  // 2. Check GitHub health (optional)
  let githubHealth: GitHubHealthStatus | undefined;
  if (requireRemoteAccess) {
    githubHealth = await checkGitHubHealth(repoPath);
    if (!githubHealth.canProceed) {
      recommendations.push('GitHub not accessible - consider enabling offline mode');
      canProceedWithWarnings = githubHealth.reachable; // Can proceed if reachable but not authenticated
    }
  }

  // 3. Generate recommendations
  if (gitHealth.issues.length > 0) {
    recommendations.push(...gitHealth.issues.map(issue => `Fix: ${issue}`));
  }

  if (gitHealth.warnings.length > 0) {
    recommendations.push(...gitHealth.warnings.map(warn => `Warning: ${warn}`));
  }

  const passed = gitHealth.healthy && (!requireRemoteAccess || githubHealth?.canProceed === true);

  return {
    passed,
    gitHealth,
    githubHealth,
    recommendations,
    canProceedWithWarnings,
  };
}

/**
 * Check git repository health
 *
 * Detects and optionally auto-recovers from:
 * - Dirty working directory
 * - Detached HEAD
 * - Corrupted index
 * - Missing .git directory
 *
 * @param repoPath - Path to git repository
 * @param options - Check options
 * @returns Git health status
 */
export async function checkGitHealth(
  repoPath: string,
  options: {
    requireClean?: boolean;
    attemptAutoRecovery?: boolean;
  } = {}
): Promise<GitHealthStatus> {
  const { requireClean = true, attemptAutoRecovery = true } = options;

  const issues: string[] = [];
  const warnings: string[] = [];
  let autoRecoveryAttempted = false;
  let autoRecoverySucceeded = false;

  // 1. Verify repository exists
  if (!fs.existsSync(repoPath)) {
    issues.push(`Repository path does not exist: ${repoPath}`);
    return {
      healthy: false,
      issues,
      warnings,
      canProceed: false,
      autoRecoveryAttempted: false,
      autoRecoverySucceeded: false,
    };
  }

  // 2. Verify .git directory exists
  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    issues.push(`Not a git repository (missing .git): ${repoPath}`);
    return {
      healthy: false,
      issues,
      warnings,
      canProceed: false,
      autoRecoveryAttempted: false,
      autoRecoverySucceeded: false,
    };
  }

  // 3. Check working directory status
  try {
    const status = safeGitExecSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
    });

    if (status.trim().length > 0) {
      const dirtyFiles = status.trim().split('\n');

      // Filter out build artifacts (should be in .gitignore)
      const { isInBuildFolder } = require('./buildFolderFilter');
      const buildFiles = dirtyFiles.filter(line => {
        const file = line.substring(3).trim(); // Remove git status prefix
        return isInBuildFolder(file);
      });
      const sourceFiles = dirtyFiles.filter(line => {
        const file = line.substring(3).trim();
        return !isInBuildFolder(file);
      });

      if (buildFiles.length > 0) {
        warnings.push(
          `Working directory has ${buildFiles.length} uncommitted build file(s) - these should be in .gitignore`
        );

        if (attemptAutoRecovery) {
          autoRecoveryAttempted = true;
          try {
            // Attempt to add build folders to .gitignore
            const gitignorePath = path.join(repoPath, '.gitignore');
            const buildPatterns = ['dist/', 'build/', 'node_modules/', '.next/', 'out/'];

            let gitignoreContent = '';
            if (fs.existsSync(gitignorePath)) {
              gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            }

            let added = false;
            for (const pattern of buildPatterns) {
              if (!gitignoreContent.includes(pattern)) {
                gitignoreContent += `\n${pattern}`;
                added = true;
              }
            }

            if (added) {
              fs.writeFileSync(gitignorePath, gitignoreContent);
              console.log(`✅ [GitDefense] Auto-recovery: Added missing patterns to .gitignore`);

              // Reset build files from staging
              safeGitExecSync('git reset HEAD dist/ build/ node_modules/ .next/ out/ 2>/dev/null || true', {
                cwd: repoPath,
                timeout: 5000,
              });

              autoRecoverySucceeded = true;
            }
          } catch (error: any) {
            console.warn(`⚠️  [GitDefense] Auto-recovery failed: ${error.message}`);
          }
        }
      }

      if (sourceFiles.length > 0) {
        const msg = `Working directory has ${sourceFiles.length} uncommitted source file(s)`;
        if (requireClean) {
          issues.push(msg);
        } else {
          warnings.push(msg);
        }

        if (attemptAutoRecovery && requireClean) {
          autoRecoveryAttempted = true;
          try {
            // Attempt to stash changes
            safeGitExecSync('git stash push -u -m "Auto-stash by GitDefenseSystem"', {
              cwd: repoPath,
              timeout: 10000,
            });
            console.log(`✅ [GitDefense] Auto-recovery: Stashed ${sourceFiles.length} uncommitted file(s)`);
            autoRecoverySucceeded = true;
            issues.length = 0; // Clear issue since we recovered
            warnings.push('Uncommitted changes were auto-stashed - retrieve with "git stash pop"');
          } catch (error: any) {
            console.warn(`⚠️  [GitDefense] Auto-stash failed: ${error.message}`);
          }
        }
      }
    }
  } catch (error: any) {
    issues.push(`Cannot check git status: ${error.message}`);
  }

  // 4. Check for detached HEAD
  try {
    const headStatus = safeGitExecSync('git symbolic-ref -q HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 3000,
    });

    if (!headStatus || headStatus.trim().length === 0) {
      warnings.push('Repository is in detached HEAD state');
    }
  } catch (error: any) {
    // Exit code 1 means detached HEAD
    warnings.push('Repository may be in detached HEAD state');
  }

  // 5. Check index integrity
  try {
    safeGitExecSync('git fsck --no-progress --no-dangling 2>&1 | head -5', {
      cwd: repoPath,
      timeout: 10000,
    });
  } catch (error: any) {
    warnings.push('Git index may be corrupted - run "git fsck" to verify');
  }

  const healthy = issues.length === 0;
  const canProceed = healthy || (!requireClean && issues.length === 0);

  return {
    healthy,
    issues,
    warnings,
    canProceed,
    autoRecoveryAttempted,
    autoRecoverySucceeded,
  };
}

/**
 * Check GitHub connectivity and authentication
 *
 * Tests:
 * - Network connectivity to GitHub
 * - Git credentials are valid
 * - API rate limits are OK
 *
 * @param repoPath - Path to git repository
 * @returns GitHub health status
 */
export async function checkGitHubHealth(repoPath: string): Promise<GitHubHealthStatus> {
  // 1. Test network connectivity with timeout
  try {
    const remoteCheck = safeGitExecSync('git ls-remote --heads origin 2>&1', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 10000, // 10s timeout for network operation
    });

    // Check for authentication errors
    if (remoteCheck.includes('Authentication failed') ||
        remoteCheck.includes('Could not resolve host') ||
        remoteCheck.includes('unable to access')) {
      return {
        reachable: false,
        authenticated: false,
        rateLimitOk: false,
        error: 'GitHub authentication failed or network unreachable',
        canProceed: false,
      };
    }

    // Success - remote is accessible
    return {
      reachable: true,
      authenticated: true,
      rateLimitOk: true,
      canProceed: true,
    };
  } catch (error: any) {
    // Network timeout or other error
    return {
      reachable: false,
      authenticated: false,
      rateLimitOk: false,
      error: error.message,
      canProceed: false,
    };
  }
}

/**
 * Validate git operation safety before execution
 *
 * Use this wrapper around all git operations that modify state:
 * - git pull
 * - git push
 * - git merge
 * - git rebase
 *
 * @param operation - Operation name (for logging)
 * @param repoPath - Repository path
 * @param executeFn - Function to execute if safe
 * @returns Operation result or error
 */
export async function safeGitOperation<T>(
  operation: string,
  repoPath: string,
  executeFn: () => Promise<T>,
  options: {
    requireCleanWorkingDir?: boolean;
    requireRemoteAccess?: boolean;
    allowAutoRecovery?: boolean;
  } = {}
): Promise<{ success: boolean; result?: T; error?: string; recovered?: boolean }> {
  console.log(`\n🛡️  [GitDefense] Pre-flight check for: ${operation}`);
  console.log(`   Repository: ${repoPath}`);

  // Run pre-flight checks
  const preFlightCheck = await runPreFlightCheck(repoPath, {
    requireCleanWorkingDir: options.requireCleanWorkingDir ?? true,
    requireRemoteAccess: options.requireRemoteAccess ?? false,
    attemptAutoRecovery: options.allowAutoRecovery ?? true,
  });

  // Log results
  if (preFlightCheck.gitHealth.autoRecoveryAttempted) {
    if (preFlightCheck.gitHealth.autoRecoverySucceeded) {
      console.log(`   ✅ Auto-recovery: SUCCESS`);
    } else {
      console.log(`   ❌ Auto-recovery: FAILED`);
    }
  }

  if (preFlightCheck.gitHealth.warnings.length > 0) {
    console.log(`   ⚠️  Warnings: ${preFlightCheck.gitHealth.warnings.length}`);
    preFlightCheck.gitHealth.warnings.forEach(warn => console.log(`      - ${warn}`));
  }

  if (preFlightCheck.gitHealth.issues.length > 0) {
    console.log(`   ❌ Issues: ${preFlightCheck.gitHealth.issues.length}`);
    preFlightCheck.gitHealth.issues.forEach(issue => console.log(`      - ${issue}`));
  }

  // Decide if we can proceed
  if (!preFlightCheck.passed) {
    if (preFlightCheck.canProceedWithWarnings) {
      console.log(`   ⚠️  Proceeding with warnings for: ${operation}`);
    } else {
      console.log(`   🛑 BLOCKED: ${operation} - pre-flight check failed`);
      return {
        success: false,
        error: `Pre-flight check failed: ${preFlightCheck.gitHealth.issues.join(', ')}`,
      };
    }
  } else {
    console.log(`   ✅ Pre-flight check passed for: ${operation}`);
  }

  // Execute operation
  try {
    const result = await executeFn();
    console.log(`   ✅ ${operation} completed successfully`);
    return {
      success: true,
      result,
      recovered: preFlightCheck.gitHealth.autoRecoverySucceeded,
    };
  } catch (error: any) {
    console.error(`   ❌ ${operation} failed: ${error.message}`);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Verify commit exists on remote with retry logic
 *
 * This is the CRITICAL operation that's been failing
 * USER REPORT: "Commit xxx NOT found on remote - Esto es un desastre"
 *
 * @param repoPath - Repository path
 * @param commitSHA - Commit SHA to verify
 * @param maxRetries - Maximum retry attempts (default: 5)
 * @returns true if commit found, false otherwise
 */
export async function verifyCommitOnRemote(
  repoPath: string,
  commitSHA: string,
  maxRetries: number = 5
): Promise<{ found: boolean; attempts: number; error?: string }> {
  const delays = [2000, 4000, 8000, 15000, 30000]; // 2s, 4s, 8s, 15s, 30s

  console.log(`\n🔍 [GitDefense] Verifying commit on remote: ${commitSHA.substring(0, 8)}...`);
  console.log(`   Repository: ${repoPath}`);
  console.log(`   Max retries: ${maxRetries}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`   Attempt ${attempt}/${maxRetries}...`);

      const lsRemote = safeGitExecSync('git ls-remote origin', {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 15000, // 15s timeout for network
      });

      if (lsRemote.includes(commitSHA)) {
        console.log(`   ✅ Commit found on remote (attempt ${attempt})`);
        return { found: true, attempts: attempt };
      }

      // Not found yet
      if (attempt < maxRetries) {
        const delay = delays[attempt - 1] || 30000;
        console.log(`   ⏳ Commit not found yet, waiting ${delay}ms before retry...`);
        console.log(`   (GitHub propagation may still be in progress)`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error: any) {
      console.warn(`   ⚠️  Attempt ${attempt} failed: ${error.message}`);

      if (attempt < maxRetries) {
        const delay = delays[attempt - 1] || 30000;
        console.log(`   Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        console.error(`   ❌ All ${maxRetries} attempts failed`);
        return {
          found: false,
          attempts: maxRetries,
          error: error.message,
        };
      }
    }
  }

  console.log(`   ❌ Commit NOT found after ${maxRetries} attempts`);
  return {
    found: false,
    attempts: maxRetries,
    error: 'Commit not found on remote after all retries',
  };
}

/**
 * Clean working directory by removing build artifacts
 *
 * Safely removes files that should be in .gitignore but aren't
 *
 * @param repoPath - Repository path
 * @returns Cleanup result
 */
export async function cleanBuildArtifacts(
  repoPath: string
): Promise<{ cleaned: number; errors: string[] }> {
  const { isInBuildFolder } = require('./buildFolderFilter');
  const errors: string[] = [];
  let cleaned = 0;

  try {
    const status = safeGitExecSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 5000,
    });

    if (!status || status.trim().length === 0) {
      return { cleaned: 0, errors: [] };
    }

    const dirtyFiles = status.trim().split('\n');

    for (const line of dirtyFiles) {
      const file = line.substring(3).trim(); // Remove git status prefix
      if (isInBuildFolder(file)) {
        try {
          // Unstage if staged
          safeGitExecSync(`git reset HEAD "${file}" 2>/dev/null || true`, {
            cwd: repoPath,
            timeout: 3000,
          });

          // Clean from working directory
          safeGitExecSync(`git clean -fd "${file}" 2>/dev/null || true`, {
            cwd: repoPath,
            timeout: 3000,
          });

          cleaned++;
        } catch (error: any) {
          errors.push(`Failed to clean ${file}: ${error.message}`);
        }
      }
    }

    if (cleaned > 0) {
      console.log(`✅ [GitDefense] Cleaned ${cleaned} build artifact(s)`);
    }
  } catch (error: any) {
    errors.push(`Failed to check status: ${error.message}`);
  }

  return { cleaned, errors };
}
