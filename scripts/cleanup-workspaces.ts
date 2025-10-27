#!/usr/bin/env tsx
/**
 * Workspace Cleanup Script
 *
 * Scans for and cleans up corrupted workspaces (tasks with system repositories)
 *
 * Usage:
 *   npm run cleanup-workspaces              # Dry run (preview only)
 *   npm run cleanup-workspaces -- --execute # Actually delete workspaces
 */

import { connectDatabase } from '../src/config/database';
import { WorkspaceCleanupService } from '../src/services/cleanup/WorkspaceCleanupService';
import path from 'path';
import os from 'os';

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = !args.includes('--execute');

  console.log('\n🧹 WORKSPACE CLEANUP SCRIPT');
  console.log(`${'='.repeat(80)}\n`);

  if (isDryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be made');
    console.log('   To actually clean up workspaces, run with: --execute\n');
  } else {
    console.log('🔥 EXECUTE MODE - Workspaces will be deleted\n');
  }

  try {
    // Connect to database
    console.log('📡 Connecting to MongoDB...');
    await connectDatabase();
    console.log('✅ MongoDB connected\n');

    // Initialize cleanup service
    const workspaceDir = process.env.AGENT_WORKSPACE_DIR || path.join(os.tmpdir(), 'agent-workspace');
    const cleanupService = new WorkspaceCleanupService(workspaceDir);

    console.log(`📁 Workspace directory: ${workspaceDir}\n`);

    // Run cleanup
    const result = await cleanupService.cleanupAllCorruptedWorkspaces(isDryRun);

    // Print summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 CLEANUP SUMMARY');
    console.log(`${'='.repeat(80)}`);
    console.log(`   Corrupted tasks found: ${result.corruptedTasksFound}`);
    console.log(`   Workspaces deleted: ${result.workspacesDeleted}`);
    console.log(`   Errors: ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.log(`\n❌ Errors encountered:`);
      result.errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. Task ${err.taskId}: ${err.error}`);
      });
    }

    if (result.corruptedTasks.length > 0) {
      console.log(`\n📋 Corrupted tasks:`);
      result.corruptedTasks.forEach((task, idx) => {
        console.log(`   ${idx + 1}. ${task.taskId} - ${task.title}`);
        console.log(`      System repos: ${task.corruptedRepos.join(', ')}`);
        console.log(`      Status: ${task.status}`);
      });
    }

    console.log(`\n${'='.repeat(80)}`);

    if (isDryRun && result.corruptedTasksFound > 0) {
      console.log(`\n💡 To execute cleanup, run: npm run cleanup-workspaces -- --execute`);
    } else if (!isDryRun && result.workspacesDeleted > 0) {
      console.log(`\n✅ Cleanup completed successfully!`);
    } else if (result.corruptedTasksFound === 0) {
      console.log(`\n✅ No corrupted workspaces found - system is clean!`);
    }

    console.log();

    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
