#!/usr/bin/env ts-node

/**
 * Branch Verification Script
 *
 * Verifies that all branches created during orchestration exist on remote
 * Can also perform emergency push if branches are missing
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

interface BranchStatus {
  name: string;
  existsLocally: boolean;
  existsOnRemote: boolean;
  type: 'epic' | 'story' | 'integration' | 'unknown';
}

class BranchVerifier {
  private repoPath: string;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || process.cwd();
    console.log(`🔍 Branch Verifier initialized in: ${this.repoPath}`);
  }

  /**
   * Get all local branches
   */
  private getLocalBranches(): string[] {
    try {
      const result = execSync('git branch -a', {
        cwd: this.repoPath,
        encoding: 'utf-8'
      });

      return result
        .split('\n')
        .map(b => b.trim().replace('* ', ''))
        .filter(b => b && !b.startsWith('remotes/'));
    } catch (error) {
      console.error('❌ Failed to get local branches:', error);
      return [];
    }
  }

  /**
   * Get all remote branches
   */
  private getRemoteBranches(): string[] {
    try {
      const result = execSync('git ls-remote --heads origin', {
        cwd: this.repoPath,
        encoding: 'utf-8'
      });

      return result
        .split('\n')
        .filter(line => line.includes('refs/heads/'))
        .map(line => {
          const match = line.match(/refs\/heads\/(.+)$/);
          return match ? match[1] : '';
        })
        .filter(Boolean);
    } catch (error) {
      console.error('❌ Failed to get remote branches:', error);
      return [];
    }
  }

  /**
   * Determine branch type
   */
  private getBranchType(branchName: string): 'epic' | 'story' | 'integration' | 'unknown' {
    if (branchName.startsWith('epic/')) return 'epic';
    if (branchName.startsWith('story/')) return 'story';
    if (branchName.startsWith('integration')) return 'integration';
    return 'unknown';
  }

  /**
   * Analyze all branches
   */
  public analyzeBranches(): {
    all: BranchStatus[];
    missing: BranchStatus[];
    orphaned: BranchStatus[];
  } {
    const localBranches = this.getLocalBranches();
    const remoteBranches = this.getRemoteBranches();

    console.log(`\n📊 Branch Analysis:`);
    console.log(`  Local branches: ${localBranches.length}`);
    console.log(`  Remote branches: ${remoteBranches.length}`);

    const all: BranchStatus[] = [];
    const missing: BranchStatus[] = [];
    const orphaned: BranchStatus[] = [];

    // Check all local branches
    for (const branch of localBranches) {
      if (branch === 'main' || branch === 'master') continue;

      const status: BranchStatus = {
        name: branch,
        existsLocally: true,
        existsOnRemote: remoteBranches.includes(branch),
        type: this.getBranchType(branch)
      };

      all.push(status);

      if (!status.existsOnRemote) {
        missing.push(status);
      }
    }

    // Check for orphaned remote branches
    for (const branch of remoteBranches) {
      if (branch === 'main' || branch === 'master') continue;

      if (!localBranches.includes(branch)) {
        const status: BranchStatus = {
          name: branch,
          existsLocally: false,
          existsOnRemote: true,
          type: this.getBranchType(branch)
        };
        orphaned.push(status);
      }
    }

    return { all, missing, orphaned };
  }

  /**
   * Push missing branches to remote
   */
  public async pushMissingBranches(branches: BranchStatus[]): Promise<number> {
    let pushed = 0;

    for (const branch of branches) {
      if (!branch.existsLocally || branch.existsOnRemote) continue;

      try {
        console.log(`\n🚀 Pushing ${branch.name} to remote...`);

        // Checkout branch
        execSync(`git checkout ${branch.name}`, {
          cwd: this.repoPath,
          stdio: 'pipe'
        });

        // Push to remote
        execSync(`git push -u origin ${branch.name}`, {
          cwd: this.repoPath,
          stdio: 'pipe'
        });

        console.log(`✅ Successfully pushed ${branch.name}`);
        pushed++;
      } catch (error: any) {
        console.error(`❌ Failed to push ${branch.name}:`, error.message);
      }
    }

    // Return to main
    try {
      execSync('git checkout main', {
        cwd: this.repoPath,
        stdio: 'pipe'
      });
    } catch (e) {
      // Ignore
    }

    return pushed;
  }

  /**
   * Generate report
   */
  public generateReport(analysis: ReturnType<typeof this.analyzeBranches>): void {
    console.log('\n' + '='.repeat(80));
    console.log('📋 BRANCH VERIFICATION REPORT');
    console.log('='.repeat(80));

    // Summary
    console.log('\n📊 SUMMARY:');
    console.log(`  Total branches: ${analysis.all.length}`);
    console.log(`  Missing on remote: ${analysis.missing.length} ❌`);
    console.log(`  Orphaned on remote: ${analysis.orphaned.length} ⚠️`);

    // Missing branches (CRITICAL)
    if (analysis.missing.length > 0) {
      console.log('\n❌ MISSING ON REMOTE (need push):');
      for (const branch of analysis.missing) {
        console.log(`  - ${branch.name} (${branch.type})`);
      }
    }

    // Orphaned branches (WARNING)
    if (analysis.orphaned.length > 0) {
      console.log('\n⚠️ ORPHANED ON REMOTE (no local copy):');
      for (const branch of analysis.orphaned) {
        console.log(`  - ${branch.name} (${branch.type})`);
      }
    }

    // Epic branches status
    const epicBranches = analysis.all.filter(b => b.type === 'epic');
    console.log('\n🎯 EPIC BRANCHES:');
    for (const branch of epicBranches) {
      const status = branch.existsOnRemote ? '✅' : '❌';
      console.log(`  ${status} ${branch.name}`);
    }

    // Story branches status
    const storyBranches = analysis.all.filter(b => b.type === 'story');
    if (storyBranches.length > 0) {
      console.log('\n📝 STORY BRANCHES:');
      for (const branch of storyBranches) {
        const status = branch.existsOnRemote ? '✅' : '❌';
        console.log(`  ${status} ${branch.name}`);
      }
    }

    console.log('\n' + '='.repeat(80));
  }

  /**
   * Fix all issues
   */
  public async fixAllIssues(): Promise<void> {
    const analysis = this.analyzeBranches();

    if (analysis.missing.length === 0) {
      console.log('\n✅ All branches are properly pushed to remote!');
      return;
    }

    console.log(`\n🔧 Found ${analysis.missing.length} branches that need to be pushed.`);
    console.log('Attempting to fix...\n');

    const pushed = await this.pushMissingBranches(analysis.missing);

    console.log(`\n✅ Fixed ${pushed}/${analysis.missing.length} branches`);

    if (pushed < analysis.missing.length) {
      console.log('⚠️ Some branches could not be pushed. Manual intervention may be required.');
    }
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);
  const repoPath = args[0] || process.cwd();
  const autoFix = args.includes('--fix');

  console.log('🚀 Branch Verification Tool');
  console.log('=' + '='.repeat(39));

  const verifier = new BranchVerifier(repoPath);
  const analysis = verifier.analyzeBranches();

  verifier.generateReport(analysis);

  if (autoFix && analysis.missing.length > 0) {
    console.log('\n🔧 AUTO-FIX MODE ENABLED');
    await verifier.fixAllIssues();
  } else if (analysis.missing.length > 0) {
    console.log('\n💡 TIP: Run with --fix flag to automatically push missing branches');
    console.log('   Example: npm run verify-branches -- --fix');
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}

export { BranchVerifier };