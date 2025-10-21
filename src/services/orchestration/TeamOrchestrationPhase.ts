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
      // Get EPICS from Project Manager - MUST support recovery after restart
      let projectManagerEpics = context.getData<any[]>('epics') || [];

      // CRITICAL: Always check task model for epics (recovery after restart)
      if (projectManagerEpics.length === 0) {
        const epicsFromTask = (task.orchestration.projectManager as any)?.epics || [];
        if (epicsFromTask && epicsFromTask.length > 0) {
          // Restore epics to context for this execution
          context.setData('epics', epicsFromTask);
          projectManagerEpics = [...epicsFromTask]; // Create new array
          console.log(`🔄 [TeamOrchestration] RECOVERY: Restored ${epicsFromTask.length} epic(s) from database after restart`);
        }
      }

      // Final validation - MUST have epics to proceed
      if (!projectManagerEpics || projectManagerEpics.length === 0) {
        // Check if ProjectManager phase completed
        const pmStatus = task.orchestration.projectManager?.status;
        if (pmStatus !== 'completed') {
          throw new Error(`Cannot start TeamOrchestration: Project Manager phase is ${pmStatus || 'not started'}. Must complete Project Manager first.`);
        }
        throw new Error('No epics found from Project Manager - cannot create teams. Database may be corrupted or Project Manager output was invalid.');
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

      // 🔥 CIRCUIT BREAKER: Stop if too many teams fail
      const failureRate = failedTeams.length / teamResults.length;
      const failureThreshold = parseFloat(process.env.TEAM_FAILURE_THRESHOLD || '0.5'); // 50% default

      if (failureRate > failureThreshold && teamResults.length > 1) {
        const { CircuitBreakerError } = await import('./RetryService');

        console.error(`\n❌ [CIRCUIT BREAKER] Too many teams failed: ${failedTeams.length}/${teamResults.length} (${(failureRate * 100).toFixed(1)}%)`);
        console.error(`   Threshold: ${(failureThreshold * 100).toFixed(0)}%`);
        console.error(`   Aborting orchestration to prevent further cost accumulation\n`);

        // Notify frontend
        NotificationService.emitNotification(taskId, 'circuit_breaker_triggered', {
          failedTeams: failedTeams.length,
          totalTeams: teamResults.length,
          threshold: failureThreshold,
          message: `Circuit breaker: ${failedTeams.length}/${teamResults.length} teams failed`
        });

        throw new CircuitBreakerError(
          failedTeams.length,
          teamResults.length,
          failureThreshold
        );
      }

      console.log(`\n✅ [TeamOrchestration] ${successfulTeams.length}/${teamResults.length} team(s) completed successfully`);
      if (failedTeams.length > 0) {
        console.log(`❌ [TeamOrchestration] ${failedTeams.length} team(s) failed`);
      }

      // Store results in task
      (context.task.orchestration as any).teamOrchestration.status = failedTeams.length === 0 ? 'completed' : 'partial';
      (context.task.orchestration as any).teamOrchestration.completedAt = new Date();

      // 🔥 CRITICAL: Aggregate costs AND token usage from all teams for proper breakdown display
      let totalTechLeadCost = 0;
      let totalJudgeCost = 0;
      let totalDevelopersCost = 0;
      let totalQACost = 0;

      // Token tracking for each agent type
      let techLeadTokens = { input: 0, output: 0 };
      let judgeTokens = { input: 0, output: 0 };
      let developersTokens = { input: 0, output: 0 };
      let qaTokens = { input: 0, output: 0 };

      (context.task.orchestration as any).teamOrchestration.teams = teamResults.map((result, idx) => {
        if (result.status === 'fulfilled' && result.value.teamCosts) {
          const costs = result.value.teamCosts;

          // Accumulate costs and tokens from each team
          totalTechLeadCost += costs.techLead || 0;
          totalJudgeCost += costs.judge || 0;
          totalDevelopersCost += costs.developers || 0;
          totalQACost += costs.qa || 0;

          // Accumulate token usage
          if (costs.techLeadUsage) {
            techLeadTokens.input += costs.techLeadUsage.input || 0;
            techLeadTokens.output += costs.techLeadUsage.output || 0;
          }
          if (costs.judgeUsage) {
            judgeTokens.input += costs.judgeUsage.input || 0;
            judgeTokens.output += costs.judgeUsage.output || 0;
          }
          if (costs.developersUsage) {
            developersTokens.input += costs.developersUsage.input || 0;
            developersTokens.output += costs.developersUsage.output || 0;
          }
          if (costs.qaUsage) {
            qaTokens.input += costs.qaUsage.input || 0;
            qaTokens.output += costs.qaUsage.output || 0;
          }

          return {
            epicId: projectManagerEpics[idx].id,
            epicTitle: projectManagerEpics[idx].title,
            status: result.value.success ? 'completed' : 'failed',
            error: result.value.error,
            costs: costs, // Store individual team costs
          };
        } else if (result.status === 'fulfilled') {
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

      // Update aggregated costs AND token usage in the main orchestration fields for breakdown display
      if (totalTechLeadCost > 0) {
        if (!task.orchestration.techLead) {
          task.orchestration.techLead = { agent: 'tech-lead', status: 'completed' } as any;
        }
        // Preserve existing usage data if it exists, or create new
        if (!task.orchestration.techLead.usage) {
          task.orchestration.techLead.usage = {
            input_tokens: techLeadTokens.input,
            output_tokens: techLeadTokens.output,
          };
        }
        task.orchestration.techLead.cost_usd = totalTechLeadCost;
        console.log(`💰 Total Tech Lead cost across all teams: $${totalTechLeadCost.toFixed(4)}`);
      }

      if (totalJudgeCost > 0) {
        if (!task.orchestration.judge) {
          task.orchestration.judge = { agent: 'judge', status: 'completed' } as any;
        }
        if (!task.orchestration.judge!.usage) {
          task.orchestration.judge!.usage = {
            input_tokens: judgeTokens.input,
            output_tokens: judgeTokens.output,
          };
        }
        task.orchestration.judge!.cost_usd = totalJudgeCost;
        console.log(`💰 Total Judge cost across all teams: $${totalJudgeCost.toFixed(4)}`);
      }

      if (totalQACost > 0) {
        if (!task.orchestration.qaEngineer) {
          task.orchestration.qaEngineer = { agent: 'qa-engineer', status: 'completed' } as any;
        }
        if (!task.orchestration.qaEngineer!.usage) {
          task.orchestration.qaEngineer!.usage = {
            input_tokens: qaTokens.input,
            output_tokens: qaTokens.output,
          };
        }
        task.orchestration.qaEngineer!.cost_usd = totalQACost;
        console.log(`💰 Total QA cost across all teams: $${totalQACost.toFixed(4)}`);
      }

      // Also track developers cost separately
      if (totalDevelopersCost > 0) {
        console.log(`💰 Total Developers cost across all teams: $${totalDevelopersCost.toFixed(4)}`);
        // Note: Developers cost is not shown separately in the breakdown UI
      }

      // For developers, add to team array
      if (totalDevelopersCost > 0 && !task.orchestration.team) {
        task.orchestration.team = [];
      }

      // 🔥 CRITICAL: Accumulate ALL team costs to the main orchestration total
      const totalTeamsCost = totalTechLeadCost + totalJudgeCost + totalDevelopersCost + totalQACost;
      if (totalTeamsCost > 0) {
        task.orchestration.totalCost = (task.orchestration.totalCost || 0) + totalTeamsCost;
        console.log(`💰 [TeamOrchestration] Total cost from all teams: $${totalTeamsCost.toFixed(4)}`);
        console.log(`💰 [TeamOrchestration] Running orchestration total: $${task.orchestration.totalCost.toFixed(4)}`);
      }

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
  ): Promise<{
    success: boolean;
    error?: string;
    teamCosts?: {
      techLead: number;
      developers: number;
      judge: number;
      qa: number;
      total: number;
      techLeadUsage?: { input: number; output: number };
      developersUsage?: { input: number; output: number };
      judgeUsage?: { input: number; output: number };
      qaUsage?: { input: number; output: number };
    };
    epicId?: string;
  }> {
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
      // 🔥 UNIQUE BRANCH NAMING: Include taskId + timestamp + random suffix to prevent ANY conflicts
      const taskShortId = (parentContext.task._id as any).toString().slice(-8); // Last 8 chars of taskId
      const timestamp = Date.now();
      const randomSuffix = Math.random().toString(36).substring(2, 8);
      const epicSlug = epic.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(); // Sanitize epic id
      const branchName = `epic/${taskShortId}-${epicSlug}-${timestamp}-${randomSuffix}`;
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
      // 🔥 CRITICAL: Add the unique branchName to the epic object
      const epicWithBranch = { ...epic, branchName: branchName };
      teamContext.setData('teamEpic', epicWithBranch);
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

      // Initialize cost tracking for this team
      const teamCosts = {
        techLead: 0,
        developers: 0,
        judge: 0,
        qa: 0,
        total: 0
      };

      // Tech Lead: Design architecture for this epic
      console.log(`\n[Team ${teamNumber}] Phase 1: Tech Lead (Architecture)`);
      const techLeadResult = await techLeadPhase.execute(teamContext);
      if (!techLeadResult.success) {
        throw new Error(`Tech Lead failed: ${techLeadResult.error}`);
      }
      // Track Tech Lead cost and tokens (check both metadata and metrics)
      const techLeadCost = Number(techLeadResult.metadata?.cost || techLeadResult.metrics?.cost_usd || 0);
      const techLeadUsage = {
        input: Number(techLeadResult.metadata?.input_tokens || techLeadResult.metrics?.input_tokens || 0),
        output: Number(techLeadResult.metadata?.output_tokens || techLeadResult.metrics?.output_tokens || 0),
      };
      if (techLeadCost > 0) {
        (teamCosts as any).techLead = techLeadCost;
        (teamCosts as any).techLeadUsage = techLeadUsage;
        console.log(`💰 [Team ${teamNumber}] Tech Lead cost: $${techLeadCost.toFixed(4)} (${techLeadUsage.input + techLeadUsage.output} tokens)`);
      }

      // Developers: Implement the epic
      console.log(`\n[Team ${teamNumber}] Phase 2: Developers (Implementation)`);
      const developersResult = await developersPhase.execute(teamContext);
      if (!developersResult.success) {
        throw new Error(`Developers failed: ${developersResult.error}`);
      }
      // Track Developers cost and tokens (includes individual developer costs)
      if (developersResult.metadata?.cost) {
        (teamCosts as any).developers = developersResult.metadata.cost;
        (teamCosts as any).developersUsage = {
          input: Number(developersResult.metadata?.input_tokens || 0),
          output: Number(developersResult.metadata?.output_tokens || 0),
        };
        console.log(`💰 [Team ${teamNumber}] Developers cost: $${developersResult.metadata.cost.toFixed(4)}`);
      }
      // Track Judge costs and tokens (from within DevelopersPhase)
      if (developersResult.metadata?.judgeCost) {
        (teamCosts as any).judge = developersResult.metadata.judgeCost;
        (teamCosts as any).judgeUsage = {
          input: Number(developersResult.metadata?.judge_input_tokens || 0),
          output: Number(developersResult.metadata?.judge_output_tokens || 0),
        };
        console.log(`💰 [Team ${teamNumber}] Judge cost: $${developersResult.metadata.judgeCost.toFixed(4)}`);
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
      // Track QA cost and tokens (check both metadata and metrics)
      const qaCost = Number(qaResult.metadata?.cost || qaResult.metrics?.cost_usd || 0);
      const qaUsage = {
        input: Number(qaResult.metadata?.input_tokens || qaResult.metrics?.input_tokens || 0),
        output: Number(qaResult.metadata?.output_tokens || qaResult.metrics?.output_tokens || 0),
      };
      if (qaCost > 0) {
        (teamCosts as any).qa = qaCost;
        (teamCosts as any).qaUsage = qaUsage;
        console.log(`💰 [Team ${teamNumber}] QA cost: $${qaCost.toFixed(4)} (${qaUsage.input + qaUsage.output} tokens)`);
      }

      // Calculate total team cost
      teamCosts.total = teamCosts.techLead + teamCosts.developers + teamCosts.judge + teamCosts.qa;
      console.log(`💰 [Team ${teamNumber}] Total team cost: $${teamCosts.total.toFixed(4)}`);

      console.log(`\n✅ [Team ${teamNumber}] Completed successfully for epic: ${epic.title}!\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ Team ${teamNumber} completed epic: ${epic.title}`
      );

      // 🚀 AUTO-CREATE PULL REQUEST
      // Now that epic is complete, create a PR for user to review and merge
      await this.createPullRequest(epic, branchName, workspacePath, parentContext.repositories, taskId);

      return {
        success: true,
        teamCosts: teamCosts,
        epicId: epic.id
      };
    } catch (error: any) {
      console.error(`\n❌ [Team ${teamNumber}] Failed for epic ${epic.title}: ${error.message}\n`);
      NotificationService.emitConsoleLog(
        taskId,
        'error',
        `❌ Team ${teamNumber} failed (epic: ${epic.title}): ${error.message}`
      );

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Create Pull Request for completed epic
   *
   * Automatically creates a PR from epic branch to main branch
   * so user just needs to review and merge (no manual branch management)
   */
  private async createPullRequest(
    epic: any,
    epicBranch: string,
    workspacePath: string | null,
    repositories: any[],
    taskId: string
  ): Promise<void> {
    if (!workspacePath || repositories.length === 0) {
      console.log(`⚠️  [PR] No workspace/repository - skipping PR creation`);
      return;
    }

    try {
      const { execSync } = require('child_process');
      const { NotificationService } = await import('../NotificationService');

      const targetRepo = epic.targetRepository || repositories[0]?.name || repositories[0]?.full_name;
      const repoPath = `${workspacePath}/${targetRepo}`;

      console.log(`\n📬 [PR] Creating Pull Request for epic: ${epic.title}`);
      console.log(`   Branch: ${epicBranch} → main`);
      console.log(`   Repository: ${targetRepo}`);

      // Check if GitHub CLI is available (and install if needed)
      const ghAvailable = await this.ensureGitHubCLI();
      if (!ghAvailable) {
        console.log(`⚠️  [PR] GitHub CLI not available - showing manual instructions`);
        const prTitle = `Epic: ${epic.title}`;
        console.log(`\n📋 [PR] Manual PR instructions:`);
        console.log(`   1. Push branch: git push -u origin ${epicBranch}`);
        console.log(`   2. Go to your repository on GitHub`);
        console.log(`   3. Create a new Pull Request`);
        console.log(`   4. Base: main ← Compare: ${epicBranch}`);
        console.log(`   5. Title: ${prTitle}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📋 Epic completed! Create PR manually: ${epicBranch} → main`
        );
        return;
      }

      // Push epic branch to remote
      try {
        execSync(`cd "${repoPath}" && git push -u origin ${epicBranch}`, { encoding: 'utf8' });
        console.log(`✅ [PR] Pushed ${epicBranch} to remote`);
      } catch (pushError: any) {
        console.error(`❌ [PR] Failed to push branch: ${pushError.message}`);
        NotificationService.emitConsoleLog(
          taskId,
          'warn',
          `⚠️  Could not push ${epicBranch} - PR creation skipped. Push manually and create PR.`
        );
        return;
      }

      // Create PR using GitHub CLI
      const prTitle = `Epic: ${epic.title}`;
      const prBody = `## 🎯 Epic Summary\n\n${epic.description || 'No description provided'}\n\n## 📊 Details\n\n- **Complexity**: ${epic.estimatedComplexity || 'Unknown'}\n- **Stories**: ${epic.stories?.length || 0}\n- **Affected Repositories**: ${epic.affectedRepositories?.join(', ') || targetRepo}\n\n## ✅ Validation\n\n- ✅ Code reviewed by Judge (per story)\n- ✅ Integration tested by QA Engineer\n- ✅ All stories merged to epic branch\n\n## 📝 Instructions\n\n1. Review the changes\n2. Approve and merge this PR\n3. Epic will be deployed to production\n\n---\n🤖 Generated with Multi-Agent Platform`;

      try {
        const prOutput = execSync(
          `cd "${repoPath}" && gh pr create --base main --head ${epicBranch} --title "${prTitle}" --body "${prBody}"`,
          { encoding: 'utf8' }
        );

        // Extract PR URL from output
        const prUrlMatch = prOutput.match(/https:\/\/github\.com\/[^\s]+/);
        const prUrl = prUrlMatch ? prUrlMatch[0] : 'PR created (URL not found)';

        console.log(`✅ [PR] Pull Request created successfully!`);
        console.log(`   URL: ${prUrl}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📬 Pull Request created: ${prUrl}`
        );

        // Store PR URL in epic metadata
        const { eventStore } = await import('../EventStore');
        await eventStore.append({
          taskId: taskId as any,
          eventType: 'TeamCompleted' as any, // Store PR info in TeamCompleted event
          agentName: 'team-orchestration',
          payload: {
            epicId: epic.id,
            epicTitle: epic.title,
            prUrl: prUrl,
            epicBranch: epicBranch,
            prCreated: true
          }
        });

      } catch (ghError: any) {
        // GitHub CLI not available or other error
        console.warn(`⚠️  [PR] Could not create PR automatically: ${ghError.message}`);
        console.log(`\n📋 [PR] Manual PR instructions:`);
        console.log(`   1. Go to your repository`);
        console.log(`   2. Create a new Pull Request`);
        console.log(`   3. Base: main ← Compare: ${epicBranch}`);
        console.log(`   4. Title: ${prTitle}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `📋 Epic completed! Create PR manually: ${epicBranch} → main`
        );
      }

    } catch (error: any) {
      console.error(`❌ [PR] Unexpected error creating PR: ${error.message}`);
      // Non-critical - don't fail the whole epic
    }
  }

  /**
   * Ensure GitHub CLI is available
   *
   * Checks if gh is installed, and attempts to install it if not
   * Returns true if gh is available, false otherwise
   */
  private async ensureGitHubCLI(): Promise<boolean> {
    try {
      const { execSync } = require('child_process');

      // Check if gh is already installed
      try {
        execSync('gh --version', { encoding: 'utf8', stdio: 'pipe' });
        console.log(`✅ [PR] GitHub CLI (gh) is available`);
        return true;
      } catch (checkError) {
        console.log(`⚠️  [PR] GitHub CLI (gh) not found - attempting to install...`);
      }

      // Attempt to install based on OS
      const platform = process.platform;

      if (platform === 'darwin') {
        // macOS - use Homebrew
        console.log(`📦 [PR] Installing GitHub CLI via Homebrew...`);
        try {
          execSync('brew install gh', { encoding: 'utf8', stdio: 'inherit' });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] Homebrew not available or installation failed`);
        }
      } else if (platform === 'linux') {
        // Linux - try apt-get (Debian/Ubuntu)
        console.log(`📦 [PR] Installing GitHub CLI via apt-get...`);
        try {
          execSync('sudo apt-get update && sudo apt-get install -y gh', {
            encoding: 'utf8',
            stdio: 'inherit'
          });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] apt-get not available or installation failed`);
        }
      } else if (platform === 'win32') {
        // Windows - use winget
        console.log(`📦 [PR] Installing GitHub CLI via winget...`);
        try {
          execSync('winget install --id GitHub.cli', { encoding: 'utf8', stdio: 'inherit' });
          console.log(`✅ [PR] GitHub CLI installed successfully`);
          return true;
        } catch (installError) {
          console.warn(`⚠️  [PR] winget not available or installation failed`);
        }
      }

      // Installation failed or unsupported platform
      console.log(`⚠️  [PR] Could not auto-install GitHub CLI`);
      console.log(`💡 [PR] Install manually: https://cli.github.com/manual/installation`);
      return false;

    } catch (error: any) {
      console.error(`❌ [PR] Error checking/installing GitHub CLI: ${error.message}`);
      return false;
    }
  }
}
