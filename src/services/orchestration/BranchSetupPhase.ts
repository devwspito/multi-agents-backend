import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { GitHubService } from '../GitHubService';
// Unused imports - phase is disabled (IStory incompatible with epic structure)
// import { LogService } from '../logging/LogService';
// import path from 'path';

/**
 * Branch Setup Phase
 *
 * Creates and pushes epic branches to GitHub BEFORE development starts
 * This ensures all work is backed up in real-time and prevents data loss
 *
 * Key responsibilities:
 * - Create epic branch per repository (format: epic/name-{reponame})
 * - Push empty branches to GitHub immediately
 * - Save branch metadata to epic.branches[] in database
 * - Developers will work on these pre-created branches
 */
export class BranchSetupPhase extends BasePhase {
  readonly name = 'BranchSetup'; // Must match PHASE_ORDER
  readonly description = 'Creating and pushing epic branches to GitHub';

  constructor(private _githubService: GitHubService) { // Prefixed with _ to indicate intentionally unused
    super();
  }

  /**
   * Skip if branches already created for all epics
   * NOTE: Currently skipped because IStory structure doesn't match epic structure needed
   */
  async shouldSkip(_context: OrchestrationContext): Promise<boolean> {
    // Skip this phase - IStory doesn't have branch properties like epics did
    console.log('✅ [SKIP] BranchSetup - Feature not compatible with IStory structure');
    return true;

    /* DISABLED - uncomment when IStory has branch support
    const task = context.task;

    // Refresh task from DB to get latest state
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔥 EVENT SOURCING: Rebuild state from events
    const { eventStore } = await import('../EventStore');
    const state = await eventStore.getCurrentState(context.task._id as any);
    const epics = state.epics;

    if (epics.length === 0) {
      // No epics to create branches for, skip
      return false;
    }

    // 🔥 Check if ALL epics have branchesCreated flag set (from events)
    const allEpicsHaveBranches = epics.every(epic => epic.branchesCreated === true);

    if (allEpicsHaveBranches) {
      console.log(`[SKIP] Branch Setup already completed - all epics have branchesCreated flag set (from events)`);

      // Restore phase data
      context.setData('branchesCreated', true);
      context.setData('branchCount', epics.length);

      return true;
    }

    console.log(`[NO SKIP] Branch Setup needed - ${epics.filter(e => !e.branchesCreated).length} epics without branches`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;
    const userId = task.userId.toString();

    if (!workspacePath) {
      return {
        success: false,
        error: 'Workspace path not available',
      };
    }

    await LogService.info('Branch Setup phase started - Creating epic branches', {
      taskId,
      category: 'orchestration',
      phase: 'architecture',
    });

    // Stories from Project Manager (not epics - that term is deprecated)
    const stories = task.orchestration.projectManager?.stories || [];
    const epics = stories; // Alias for backward compatibility

    if (epics.length === 0) {
      console.log('\n❌ [BranchSetup] CRITICAL ERROR: No epics found');
      console.log('   This usually means:');
      console.log('   1. Tech Lead agent failed to generate epics');
      console.log('   2. Tech Lead JSON parsing failed');
      console.log('   3. Epic events were not saved to database');
      console.log('\n🔍 Debugging info:');
      console.log(`   - task.orchestration.techLead exists: ${!!task.orchestration.techLead}`);
      console.log(`   - epics array length: ${epics.length}`);

      await LogService.error(
        'Branch Setup failed - No epics defined by Tech Lead',
        {
          taskId,
          category: 'orchestration',
          phase: 'architecture',
          metadata: {
            techLeadExists: !!task.orchestration.techLead,
            epicsLength: epics.length,
            suggestion: 'Check Tech Lead phase output and JSON parsing',
          },
        }
      );

      return {
        success: false,
        error: 'No epics defined by Tech Lead - check Tech Lead phase logs',
      };
    }

    try {
      console.log(`\n🌿 Creating and pushing epic branches to GitHub...`);

      for (const epic of epics) {
        console.log(`\n📋 Epic: ${epic.name}`);

        // Initialize branches array if not exists
        if (!epic.branches) {
          epic.branches = [];
        }

        // Get target repository for this epic
        const targetRepoName = epic.targetRepository;
        let targetRepos: any[] = [];

        if (targetRepoName) {
          // Epic specifies a specific repository
          const repo = repositories.find(
            (r) => r.full_name === targetRepoName || r.name === targetRepoName
          );
          if (repo) {
            targetRepos = [repo];
            console.log(`  🎯 Target repository: ${targetRepoName}`);
          } else {
            console.log(
              `  ⚠️ Repository "${targetRepoName}" not found, using all repositories`
            );
            targetRepos = repositories;
          }
        } else {
          // No specific repository, use all
          targetRepos = repositories;
          console.log(`  📦 Creating branches in all repositories`);
        }

        // Create branch in each target repository
        for (const repo of targetRepos) {
          const repoPath = path.join(workspacePath, repo.name);
          const branchName = `${epic.branchName}-${repo.name}`;

          console.log(`\n  📂 Repository: ${repo.name}`);
          console.log(`  🌿 Branch: ${branchName}`);

          try {
            // Check if branch already exists in database
            const existingBranch = epic.branches.find(
              (b: any) => b.repository === repo.name
            );

            if (existingBranch && existingBranch.pushed) {
              console.log(`  ✅ Branch already exists and pushed, skipping`);
              continue;
            }

            // Create branch locally
            await this.githubService.createBranch(repoPath, branchName);
            console.log(`  ✅ Created branch locally`);

            // Push branch to GitHub immediately (empty branch)
            await this.githubService.pushBranch(branchName, repoPath, userId);
            console.log(`  ✅ Pushed to GitHub`);

            // 🔥 EVENT SOURCING: Emit branch pushed event
            const { eventStore } = await import('../EventStore');
            await eventStore.append({
              taskId: task._id as any,
              eventType: 'BranchPushed',
              agentName: 'branch-setup',
              payload: {
                epicId: epic.id,
                epicName: epic.name,
                repository: repo.name,
                branchName: branchName,
              },
            });

            // ✅ BACKWARD COMPATIBILITY: Also save to Task model
            if (!existingBranch) {
              epic.branches.push({
                repository: repo.name,
                branchName: branchName,
                pushed: true,
              });
            } else {
              existingBranch.pushed = true;
              existingBranch.branchName = branchName;
            }

            task.markModified('orchestration.techLead.epics');
            await task.save();
            console.log(`  💾 Saved to database (+ event emitted)`);

            await LogService.success(`Branch created and pushed: ${branchName}`, {
              taskId,
              category: 'orchestration',
              phase: 'architecture',
              epicId: epic.id,
              epicName: epic.name,
              metadata: {
                repository: repo.name,
                branchName: branchName,
              },
            });
          } catch (error: any) {
            console.log(`  ❌ Failed to create/push branch: ${error.message}`);

            await LogService.error(
              `Branch creation failed: ${branchName}`,
              {
                taskId,
                category: 'orchestration',
                phase: 'architecture',
                epicId: epic.id,
                epicName: epic.name,
                metadata: {
                  repository: repo.name,
                  branchName: branchName,
                },
              },
              error
            );

            // Continue with other repositories even if one fails
            continue;
          }
        }

        // 🔥 CRITICAL: Set simple boolean flag for flow control (Mongoose persists this reliably)
        epic.branchesCreated = true;
        console.log(`  ✅ Epic branches completed - branchesCreated flag set to true`);
      }

      // 🔥 CRITICAL: Mark epics array as modified after updating all epic flags
      task.markModified('orchestration.techLead.epics');
      await task.save();

      // 🔥 CRITICAL: Emit BRANCH_SETUP_COMPLETED event for state validation
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'BranchSetupCompleted',
        agentName: 'branch-setup',
        payload: {
          epicsCount: epics.length,
          branchesCreated: epics.reduce((sum: number, e: any) => sum + (e.branches?.length || 0), 0),
        },
      });

      console.log(`\n✅ All epic branches created and pushed to GitHub`);

      await LogService.success('Branch Setup phase completed', {
        taskId,
        category: 'orchestration',
        phase: 'architecture',
        metadata: {
          epicsCount: epics.length,
          branchesCreated: epics.reduce(
            (sum: number, e: any) => sum + (e.branches?.length || 0),
            0
          ),
        },
      });

      // Store phase data
      context.setData('branchesCreated', true);
      context.setData(
        'branchCount',
        epics.reduce((sum: number, e: any) => sum + (e.branches?.length || 0), 0)
      );

      return {
        success: true,
        data: {
          epicsCount: epics.length,
          branchesCreated: epics.reduce(
            (sum: number, e: any) => sum + (e.branches?.length || 0),
            0
          ),
        },
        metrics: {
          epics_count: epics.length,
          branches_created: epics.reduce(
            (sum: number, e: any) => sum + (e.branches?.length || 0),
            0
          ),
        },
      };
    } catch (error: any) {
      await LogService.error('Branch Setup phase failed', {
        taskId,
        category: 'orchestration',
        phase: 'architecture',
      }, error);

      // 🔥 CRITICAL: Emit completion event to prevent infinite loop
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'BranchSetupCompleted',
        agentName: 'branch-setup',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [BranchSetup] Emitted BranchSetupCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
    */
  }

  protected async executePhase(_context: OrchestrationContext): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    // This should never execute since shouldSkip returns true
    return {
      success: true,
      data: { skipped: true }
    };
  }
}
