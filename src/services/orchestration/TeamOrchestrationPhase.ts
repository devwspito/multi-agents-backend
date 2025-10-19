import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import { TechLeadPhase } from './TechLeadPhase';
import { DevelopersPhase } from './DevelopersPhase';
// JudgePhase runs per-story inside DevelopersPhase, not as separate batch in multi-team mode
import { QAPhase } from './QAPhase';
import { GitHubService } from '../GitHubService';
import { PRManagementService } from '../github/PRManagementService';

/**
 * Team Orchestration Phase
 *
 * Implements Multi-Team parallel orchestration following Anthropic's recommendations
 * for complex problem-solving with Claude agents.
 *
 * Architecture:
 * - Receives epics from Project Manager (Sonnet orchestrator)
 * - Creates isolated team per epic
 * - Each team runs: TechLead → Developers → Judge → QA
 * - All teams execute in parallel (Promise.allSettled)
 * - Aggregates results from all teams
 *
 * Benefits:
 * - Avoids token limits by splitting work across teams
 * - Enables parallel execution for faster completion
 * - Each team focuses on single epic (reduces complexity)
 * - Better cost optimization (Haiku for execution)
 */
export class TeamOrchestrationPhase extends BasePhase {
  readonly name = 'TeamOrchestration';
  readonly description = 'Coordinating parallel teams for each epic';

  constructor(
    private executeAgentFn: Function,
    private executeDeveloperFn: Function,
    private githubService: GitHubService,
    private prManagementService: PRManagementService,
    private workspaceDir: string
  ) {
    super();
  }

  /**
   * Skip if all teams already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Check if TeamOrchestration step exists and is completed
    const teamOrchestration = (context.task.orchestration as any).teamOrchestration;
    if (teamOrchestration?.status === 'completed') {
      console.log(`[SKIP] TeamOrchestration already completed`);
      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();

    // Initialize teamOrchestration in task model
    if (!(context.task.orchestration as any).teamOrchestration) {
      (context.task.orchestration as any).teamOrchestration = {
        status: 'in_progress',
        startedAt: new Date(),
        teams: [],
      };
    }

    const startTime = new Date();
    (context.task.orchestration as any).teamOrchestration.status = 'in_progress';
    (context.task.orchestration as any).teamOrchestration.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Team Orchestration');

    await LogService.agentStarted('team-orchestration', taskId, {
      phase: 'multi-team',
    });

    try {
      // Get EPICS from Project Manager via context
      const projectManagerEpics = context.getData<any[]>('epics') || [];

      if (projectManagerEpics.length === 0) {
        // Fallback: try to get from task model directly
        const epicsFromTask = (task.orchestration.projectManager as any)?.epics || [];
        if (epicsFromTask.length > 0) {
          context.setData('epics', epicsFromTask);
          projectManagerEpics.push(...epicsFromTask);
        } else {
          throw new Error('No epics found from Project Manager - cannot create teams');
        }
      }

      console.log(`\n🎯 [TeamOrchestration] Found ${projectManagerEpics.length} epic(s) from Project Manager`);
      console.log(`   Creating ${projectManagerEpics.length} parallel team(s) - 1 team per epic...\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🎯 Creating ${projectManagerEpics.length} parallel teams (1 team per epic)`
      );

      // Create team execution promises (1 team per epic)
      const teamPromises = projectManagerEpics.map((epic: any, index: number) =>
        this.executeTeam(epic, index + 1, context)
      );

      // Execute all teams in parallel
      console.log(`\n🚀 [TeamOrchestration] Launching ${teamPromises.length} team(s) in parallel...\n`);
      const teamResults = await Promise.allSettled(teamPromises);

      // Aggregate results
      const successfulTeams = teamResults.filter(r => r.status === 'fulfilled' && r.value.success);
      const failedTeams = teamResults.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success));

      console.log(`\n✅ [TeamOrchestration] ${successfulTeams.length}/${teamResults.length} team(s) completed successfully`);
      if (failedTeams.length > 0) {
        console.log(`❌ [TeamOrchestration] ${failedTeams.length} team(s) failed`);
      }

      // Store results in task
      (context.task.orchestration as any).teamOrchestration.status = failedTeams.length === 0 ? 'completed' : 'partial';
      (context.task.orchestration as any).teamOrchestration.completedAt = new Date();
      (context.task.orchestration as any).teamOrchestration.teams = teamResults.map((result, idx) => {
        if (result.status === 'fulfilled') {
          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
          };
        } else {
          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: 'failed',
            error: (result as PromiseRejectedResult).reason?.message || 'Unknown error',
          };
        }
      });

      await task.save();

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Team Orchestration',
        `${successfulTeams.length}/${teamResults.length} teams completed successfully`
      );

      await LogService.agentCompleted('team-orchestration', taskId, {
        phase: 'multi-team',
        metadata: {
          totalTeams: teamResults.length,
          successfulTeams: successfulTeams.length,
          failedTeams: failedTeams.length,
        },
      });

      return {
        success: failedTeams.length === 0,
        data: {
          totalTeams: teamResults.length,
          successfulTeams: successfulTeams.length,
          failedTeams: failedTeams.length,
          teamResults: teamResults,
        },
        warnings: failedTeams.length > 0 ? [`${failedTeams.length} teams failed`] : undefined,
      };
    } catch (error: any) {
      (context.task.orchestration as any).teamOrchestration.status = 'failed';
      (context.task.orchestration as any).teamOrchestration.error = error.message;
      await task.save();

      NotificationService.emitAgentFailed(taskId, 'Team Orchestration', error.message);

      await LogService.agentFailed('team-orchestration', taskId, error, {
        phase: 'multi-team',
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Execute a single team for one epic
   *
   * Team pipeline:
   * 1. Create branch for epic
   * 2. TechLead divides epic into stories + assigns devs
   * 3. Developers implement (each dev works on 1 story)
   * 4. Judge reviews code
   * 5. QA tests integration
   */
  private async executeTeam(
    epic: any,
    teamNumber: number,
    parentContext: OrchestrationContext
  ): Promise<{ success: boolean; error?: string }> {
    const taskId = (parentContext.task._id as any).toString();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🏃 [Team ${teamNumber}] Starting execution for EPIC: ${epic.id}`);
    console.log(`   Epic: ${epic.title}`);
    console.log(`   Complexity: ${epic.estimatedComplexity}`);
    console.log(`   Repositories: ${epic.affectedRepositories?.join(', ') || 'Not specified'}`);
    console.log(`${'='.repeat(80)}\n`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      `\n🏃 Team ${teamNumber} starting epic: ${epic.title}\n`
    );

    try {
      // 1️⃣ Create branch for this epic
      const branchName = `epic/${epic.id}`;
      const workspacePath = parentContext.workspacePath;

      // Determine target repository (use first affected repo or first repo in context)
      const targetRepository = epic.affectedRepositories?.[0] || parentContext.repositories[0]?.name;

      if (workspacePath && targetRepository) {
        console.log(`\n🌿 [Team ${teamNumber}] Creating branch: ${branchName}`);
        console.log(`   Repository: ${targetRepository}`);

        // 🔥 FIX: Navigate into the actual repository directory
        const repoPath = `${workspacePath}/${targetRepository}`;

        try {
          // Navigate to repository and create branch
          const { execSync: exec } = await import('child_process');
          exec(`cd "${repoPath}" && git checkout -b ${branchName}`, { encoding: 'utf8' });
          console.log(`✅ [Team ${teamNumber}] Branch created: ${branchName}`);

          NotificationService.emitConsoleLog(
            taskId,
            'info',
            `✅ Team ${teamNumber}: Created branch ${branchName} in ${targetRepository}`
          );
        } catch (gitError: any) {
          // Branch might already exist
          console.log(`⚠️  [Team ${teamNumber}] Branch might already exist: ${gitError.message}`);
          try {
            const { execSync: exec } = await import('child_process');
            exec(`cd "${repoPath}" && git checkout ${branchName}`, { encoding: 'utf8' });
            console.log(`✅ [Team ${teamNumber}] Checked out existing branch: ${branchName}`);
          } catch (checkoutError: any) {
            console.error(`❌ [Team ${teamNumber}] Failed to create/checkout branch: ${checkoutError.message}`);
          }
        }
      }

      // 2️⃣ Create isolated context for this team
      const teamContext = new OrchestrationContext(
        parentContext.task,
        parentContext.repositories,
        parentContext.workspacePath
      );

      // Share workspace structure and attachments
      teamContext.setData('workspaceStructure', parentContext.getData('workspaceStructure'));
      teamContext.setData('attachments', parentContext.getData('attachments'));

      // Store epic for this team to work on (Tech Lead will divide into stories)
      teamContext.setData('teamEpic', epic);
      teamContext.setData('epicBranch', branchName);
      teamContext.setData('targetRepository', targetRepository); // 🔥 Pass repository name to team

      // Execute team pipeline
      const techLeadPhase = new TechLeadPhase(this.executeAgentFn);
      const developersPhase = new DevelopersPhase(
        this.executeDeveloperFn,
        this.executeAgentFn // For Judge execution inside DevelopersPhase
      );
      // Note: Judge phase runs per-story inside DevelopersPhase, not as a separate batch
      const qaPhase = new QAPhase(
        this.executeAgentFn,
        this.githubService,
        this.prManagementService,
        this.workspaceDir
      );

      // Tech Lead: Design architecture for this epic
      console.log(`\n[Team ${teamNumber}] Phase 1: Tech Lead (Architecture)`);
      const techLeadResult = await techLeadPhase.execute(teamContext);
      if (!techLeadResult.success) {
        throw new Error(`Tech Lead failed: ${techLeadResult.error}`);
      }

      // Developers: Implement the epic
      console.log(`\n[Team ${teamNumber}] Phase 2: Developers (Implementation)`);
      const developersResult = await developersPhase.execute(teamContext);
      if (!developersResult.success) {
        throw new Error(`Developers failed: ${developersResult.error}`);
      }

      // 🔥 SKIP Judge batch review - already done per-story in DevelopersPhase
      // Each story was reviewed by Judge immediately after developer completed it
      // Only approved stories were merged to epic branch
      console.log(`\n[Team ${teamNumber}] Phase 3: Judge (Code Review) - SKIPPED (already done per-story)`);

      // QA: Test integration
      console.log(`\n[Team ${teamNumber}] Phase 4: QA (Testing)`);
      const qaResult = await qaPhase.execute(teamContext);
      if (!qaResult.success) {
        throw new Error(`QA failed: ${qaResult.error}`);
      }

      console.log(`\n✅ [Team ${teamNumber}] Completed successfully for epic: ${epic.title}!\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ Team ${teamNumber} completed epic: ${epic.title}`
      );

      return { success: true };
    } catch (error: any) {
      console.error(`\n❌ [Team ${teamNumber}] Failed for epic ${epic.title}: ${error.message}\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'error',
        `❌ Team ${teamNumber} failed (epic: ${epic.title}): ${error.message}`
      );

      return { success: false, error: error.message };
    }
  }
}
