/**
 * SmartRollback
 *
 * Automatic rollback when code breaks the build.
 * Restores to last known working state and allows retry
 * with a different approach.
 *
 * Features:
 * 1. Detect build failures
 * 2. Identify last working commit
 * 3. Stash/save current changes
 * 4. Rollback to working state
 * 5. Provide context for retry
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RollbackResult {
  success: boolean;
  rolledBackTo?: string; // commit SHA
  stashedChanges: boolean;
  stashName?: string;
  changesPreserved: string[];
  message: string;
}

export interface BuildStatus {
  compiles: boolean;
  testsPass: boolean;
  lintPasses: boolean;
  errors: string[];
  lastWorkingCommit?: string;
}

export class SmartRollback {
  /**
   * Check current build status
   */
  static async checkBuildStatus(workspacePath: string): Promise<BuildStatus> {
    const status: BuildStatus = {
      compiles: true,
      testsPass: true,
      lintPasses: true,
      errors: [],
    };

    // Check TypeScript compilation
    try {
      execSync('npx tsc --noEmit 2>&1', {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 60000,
      });
    } catch (error: any) {
      status.compiles = false;
      status.errors.push(`TypeScript: ${(error.stdout || error.message).substring(0, 500)}`);
    }

    // Check tests (quick mode)
    try {
      const packageJsonPath = path.join(workspacePath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        if (packageJson.scripts?.test) {
          execSync('npm test -- --passWithNoTests --watchAll=false 2>&1', {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 120000,
            env: { ...process.env, CI: 'true' },
          });
        }
      }
    } catch (error: any) {
      status.testsPass = false;
      status.errors.push(`Tests: ${(error.stdout || error.message).substring(0, 500)}`);
    }

    // Find last working commit if current is broken
    if (!status.compiles || !status.testsPass) {
      status.lastWorkingCommit = await this.findLastWorkingCommit(workspacePath);
    }

    return status;
  }

  /**
   * Find the last commit where build passed
   */
  static async findLastWorkingCommit(workspacePath: string, maxDepth: number = 10): Promise<string | undefined> {
    try {
      // Get recent commit SHAs
      const commits = execSync(`git log --oneline -${maxDepth} --format="%H"`, {
        cwd: workspacePath,
        encoding: 'utf8',
      }).trim().split('\n');

      // Check each commit (skip current)
      for (const commit of commits.slice(1)) {
        try {
          // Checkout commit temporarily
          execSync(`git stash`, { cwd: workspacePath, encoding: 'utf8' });
          execSync(`git checkout ${commit} --quiet`, { cwd: workspacePath, encoding: 'utf8' });

          // Try to compile
          try {
            execSync('npx tsc --noEmit 2>&1', {
              cwd: workspacePath,
              encoding: 'utf8',
              timeout: 30000,
            });

            // Restore original state
            execSync(`git checkout - --quiet`, { cwd: workspacePath, encoding: 'utf8' });
            try {
              execSync(`git stash pop --quiet`, { cwd: workspacePath, encoding: 'utf8' });
            } catch {
              // No stash to pop
            }

            console.log(`✅ [Rollback] Found last working commit: ${commit.substring(0, 8)}`);
            return commit;
          } catch {
            // This commit doesn't compile either, continue
            execSync(`git checkout - --quiet`, { cwd: workspacePath, encoding: 'utf8' });
            try {
              execSync(`git stash pop --quiet`, { cwd: workspacePath, encoding: 'utf8' });
            } catch {
              // No stash to pop
            }
          }
        } catch {
          // Git operation failed, try to recover
          try {
            execSync(`git checkout - --quiet`, { cwd: workspacePath, encoding: 'utf8' });
          } catch {
            // Already on original branch
          }
        }
      }
    } catch {
      // Git operations not available
    }

    return undefined;
  }

  /**
   * Perform smart rollback
   */
  static async rollback(
    workspacePath: string,
    targetCommit?: string
  ): Promise<RollbackResult> {
    console.log(`\n🔄 [Rollback] Starting smart rollback...`);

    const result: RollbackResult = {
      success: false,
      stashedChanges: false,
      changesPreserved: [],
      message: '',
    };

    try {
      // 1. Get current uncommitted changes
      const statusOutput = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf8',
      }).trim();

      const changedFiles = statusOutput.split('\n')
        .filter(l => l)
        .map(l => l.substring(3));

      result.changesPreserved = changedFiles;

      // 2. Stash current changes if any
      if (changedFiles.length > 0) {
        const stashName = `smart-rollback-${Date.now()}`;
        try {
          execSync(`git stash push -m "${stashName}"`, {
            cwd: workspacePath,
            encoding: 'utf8',
          });
          result.stashedChanges = true;
          result.stashName = stashName;
          console.log(`   📦 Stashed ${changedFiles.length} changed files`);
        } catch {
          console.log(`   ⚠️ Could not stash changes`);
        }
      }

      // 3. Find target commit if not specified
      if (!targetCommit) {
        targetCommit = await this.findLastWorkingCommit(workspacePath);
      }

      if (!targetCommit) {
        result.message = 'Could not find a working commit to rollback to';
        return result;
      }

      // 4. Reset to target commit (soft reset to keep changes staged)
      try {
        execSync(`git reset --soft ${targetCommit}`, {
          cwd: workspacePath,
          encoding: 'utf8',
        });
        result.rolledBackTo = targetCommit;
        console.log(`   ✅ Reset to commit: ${targetCommit.substring(0, 8)}`);
      } catch (error: any) {
        result.message = `Failed to reset: ${error.message}`;
        return result;
      }

      // 5. Verify build works now
      try {
        execSync('npx tsc --noEmit 2>&1', {
          cwd: workspacePath,
          encoding: 'utf8',
          timeout: 60000,
        });
        console.log(`   ✅ Build verified after rollback`);
      } catch {
        console.log(`   ⚠️ Build still failing after rollback`);
      }

      result.success = true;
      result.message = `Rolled back to ${targetCommit.substring(0, 8)}. Changes preserved in stash.`;

    } catch (error: any) {
      result.message = `Rollback failed: ${error.message}`;
    }

    return result;
  }

  /**
   * Restore stashed changes after fixing the approach
   */
  static async restoreStash(workspacePath: string, stashName?: string): Promise<boolean> {
    try {
      if (stashName) {
        // Find the stash by name
        const stashList = execSync('git stash list', {
          cwd: workspacePath,
          encoding: 'utf8',
        });

        const stashMatch = stashList.match(new RegExp(`(stash@\\{\\d+\\}).*${stashName}`));
        if (stashMatch) {
          execSync(`git stash pop ${stashMatch[1]}`, {
            cwd: workspacePath,
            encoding: 'utf8',
          });
          return true;
        }
      } else {
        // Pop the latest stash
        execSync('git stash pop', {
          cwd: workspacePath,
          encoding: 'utf8',
        });
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Generate instructions for retry after rollback
   */
  static generateRetryInstructions(result: RollbackResult, originalErrors: string[]): string {
    return `
## 🔄 AUTOMATIC ROLLBACK PERFORMED

Your changes broke the build. The system has rolled back to a working state.

### What happened:
- Build failed with errors
- Rolled back to commit: \`${result.rolledBackTo?.substring(0, 8) || 'unknown'}\`
- Your changes are preserved${result.stashedChanges ? ` in git stash "${result.stashName}"` : ''}

### Original errors that caused rollback:
\`\`\`
${originalErrors.join('\n').substring(0, 1000)}
\`\`\`

### Files that had changes:
${result.changesPreserved.map(f => `- ${f}`).join('\n')}

### What to do now:

1. **UNDERSTAND the error** - Read the error message above carefully
2. **PLAN a different approach** - Your original approach broke the build
3. **MAKE SMALLER CHANGES** - One file at a time, verify after each
4. **TEST FREQUENTLY** - Run \`npx tsc --noEmit\` after every edit

### To restore your original changes (if you want to try again):
\`\`\`bash
git stash pop
\`\`\`

### DO NOT:
- Make the same changes that caused the failure
- Skip verification steps
- Commit without testing

**Remember**: The build MUST pass. Take a different approach.
`;
  }

  /**
   * Create a recovery checkpoint before risky operations
   */
  static async createCheckpoint(workspacePath: string, label: string): Promise<string | null> {
    try {
      // Create a temporary commit or stash as checkpoint
      const checkpointName = `checkpoint-${label}-${Date.now()}`;

      // Check if there are changes to checkpoint
      const status = execSync('git status --porcelain', {
        cwd: workspacePath,
        encoding: 'utf8',
      }).trim();

      if (status) {
        execSync(`git stash push -m "${checkpointName}"`, {
          cwd: workspacePath,
          encoding: 'utf8',
        });
        console.log(`📍 [Rollback] Created checkpoint: ${checkpointName}`);
        return checkpointName;
      }

      return null;
    } catch {
      return null;
    }
  }
}
