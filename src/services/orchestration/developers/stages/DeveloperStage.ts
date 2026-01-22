/**
 * DeveloperStage - Handles developer execution for stories
 *
 * Responsibilities:
 * - Execute developer agent for a story
 * - Track checkpoints (code_generating, code_written)
 * - Session resume support
 * - Rollback point creation
 */

import { NotificationService } from '../../../NotificationService';
import { sessionCheckpointService } from '../../../SessionCheckpointService';
import { unifiedMemoryService } from '../../../UnifiedMemoryService';
import { getStoryId, getEpicId } from '../../utils/IdNormalizer';
import { safeGitExecSync } from '../../../../utils/safeGitExecution';
import { StoryPipelineContext, DeveloperStageResult } from '../types';

export type ExecuteDeveloperFn = (
  task: any,
  developer: any,
  repositories: any[],
  workspacePath: string | null,
  workspaceStructure: string,
  attachments: any[],
  stories: any[],
  epics: any[],
  judgeFeedback?: string,
  epicBranchName?: string,
  forceTopModel?: boolean,
  devAuth?: any,
  architectureBrief?: any,
  environmentCommands?: any,
  projectRadiographies?: Map<string, any>,
  resumeOptions?: { isResume?: boolean; sessionId?: string; resumeSessionId?: string; resumeAtMessage?: string }
) => Promise<{
  cost?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  output?: string;
  sdkSessionId?: string;
  lastMessageUuid?: string;
}>;

export class DeveloperStageExecutor {
  constructor(private executeDeveloperFn: ExecuteDeveloperFn) {}

  /**
   * Execute the developer stage for a story
   */
  async execute(pipelineCtx: StoryPipelineContext): Promise<DeveloperStageResult> {
    const {
      task, story, developer, epic, repositories,
      effectiveWorkspacePath, workspaceStructure, attachments, state,
      taskId, normalizedEpicId, normalizedStoryId, epicBranchName,
      devAuth, architectureBrief, environmentCommands, projectRadiographies,
    } = pipelineCtx;

    console.log(`\n👨‍💻 [DEVELOPER STAGE] Starting for story: ${story.title}`);
    console.log(`   Developer: ${developer.instanceId}`);
    console.log(`   Epic Branch: ${epicBranchName}`);

    try {
      // Checkpoint: Mark story as "code_generating"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_generating');

      // Create rollback checkpoint before developer execution
      const checkpoint = await this.createRollbackCheckpoint(
        effectiveWorkspacePath,
        epic.targetRepository,
        taskId,
        developer,
        story,
        epic
      );
      if (checkpoint) {
        console.log(`🔄 [CHECKPOINT] Created: ${checkpoint.id} (${checkpoint.commitHash.substring(0, 7)})`);
      }

      // Check for existing session to resume
      const existingSessionCheckpoint = await sessionCheckpointService.loadCheckpoint(
        taskId,
        'developer',
        story.id
      );
      const resumeOptions = sessionCheckpointService.buildResumeOptions(existingSessionCheckpoint);

      if (resumeOptions?.isResume) {
        console.log(`\n🔄🔄🔄 [Developer ${developer.instanceId}] RESUMING from previous session...`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🔄 Developer ${developer.instanceId}: Resuming story "${story.title}" from checkpoint`
        );
      }

      // Emit start notification
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `👨‍💻 Developer ${developer.instanceId} starting: "${story.title}"`
      );

      // Execute Developer
      const developerResult = await this.executeDeveloperFn(
        task,
        developer,
        repositories,
        effectiveWorkspacePath,
        workspaceStructure,
        attachments,
        [story],
        state.epics,
        undefined,
        epicBranchName,
        undefined,
        devAuth,
        architectureBrief,
        environmentCommands,
        projectRadiographies,
        resumeOptions
      );

      // Save session checkpoint for potential resume
      if (developerResult?.sdkSessionId) {
        await sessionCheckpointService.saveCheckpoint(
          taskId,
          'developer',
          developerResult.sdkSessionId,
          getStoryId(story),
          developerResult.lastMessageUuid,
          {
            developerId: developer.instanceId,
            storyTitle: story.title,
            epicId: getEpicId(epic),
          }
        );
      }

      // Track cost and tokens
      const developerCost = developerResult?.cost || 0;
      const developerTokens = {
        input: developerResult?.usage?.input_tokens || 0,
        output: developerResult?.usage?.output_tokens || 0,
      };

      if (developerCost > 0) {
        console.log(`💰 [Developer ${developer.instanceId}] Cost: $${developerCost.toFixed(4)}`);
        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `✅ Developer ${developer.instanceId} finished: "${story.title}" ($${developerCost.toFixed(4)})`
        );
      }

      // Checkpoint: Mark story as "code_written"
      await unifiedMemoryService.saveStoryProgress(taskId, normalizedEpicId, normalizedStoryId, 'code_written', {
        sdkSessionId: developerResult?.sdkSessionId,
      });

      return {
        success: true,
        developerCost,
        developerTokens,
        sdkSessionId: developerResult?.sdkSessionId,
        output: developerResult?.output || '',
      };

    } catch (error: any) {
      console.error(`❌ [DEVELOPER STAGE] Failed: ${error.message}`);
      return {
        success: false,
        developerCost: 0,
        developerTokens: { input: 0, output: 0 },
        error: error.message,
      };
    }
  }

  /**
   * Create rollback checkpoint before developer execution
   */
  private async createRollbackCheckpoint(
    workspacePath: string,
    targetRepository: string,
    taskId: string,
    developer: any,
    story: any,
    epic: any
  ): Promise<{ id: string; commitHash: string } | null> {
    try {
      const { rollbackService } = await import('../../../RollbackService');
      const repoPath = `${workspacePath}/${targetRepository}`;

      return await rollbackService.createCheckpoint(
        repoPath,
        taskId,
        `Before ${developer.instanceId}: ${story.title}`,
        {
          phase: 'development',
          agentType: 'developer',
          agentInstanceId: developer.instanceId,
          storyId: getStoryId(story),
          storyTitle: story.title,
          epicId: getEpicId(epic),
          epicName: epic.name,
        }
      );
    } catch (error: any) {
      console.warn(`⚠️ Could not create rollback checkpoint: ${error.message}`);
      return null;
    }
  }

  /**
   * Verify developer work from git commits
   */
  async verifyDeveloperWorkFromGit(
    workspacePath: string | null,
    repoName: string,
    branchName: string,
    storyId: string
  ): Promise<{ commitSHA: string | null; hasCommits: boolean; commitCount: number; commitMessage?: string } | null> {
    if (!workspacePath) {
      console.warn(`⚠️ [GIT_VERIFY] No workspacePath - cannot verify git work`);
      return null;
    }

    const repoPath = `${workspacePath}/${repoName}`;

    try {
      // Check if branch exists locally
      const checkBranch = safeGitExecSync(`git branch --list "${branchName}"`, { cwd: repoPath });

      if (!checkBranch || checkBranch.trim() === '') {
        console.log(`🔍 [GIT_VERIFY] Branch ${branchName} not found locally, fetching...`);
        safeGitExecSync(`git fetch origin ${branchName}:${branchName} 2>/dev/null || true`, { cwd: repoPath });
      }

      // Get commits on branch
      const gitLogResult = safeGitExecSync(
        `git log ${branchName} --oneline -n 5 2>/dev/null || git log origin/${branchName} --oneline -n 5 2>/dev/null || echo ""`,
        { cwd: repoPath }
      );

      if (!gitLogResult || gitLogResult.trim() === '') {
        console.log(`📭 [GIT_VERIFY] No commits found on branch ${branchName}`);
        return { commitSHA: null, hasCommits: false, commitCount: 0 };
      }

      const commits = gitLogResult.trim().split('\n').filter(Boolean);
      const commitCount = commits.length;

      const latestCommitLine = commits[0];
      const shortSHA = latestCommitLine.split(' ')[0];

      // Get full SHA
      const fullSHA = safeGitExecSync(
        `git rev-parse ${shortSHA} 2>/dev/null || git rev-parse origin/${branchName} 2>/dev/null`,
        { cwd: repoPath }
      )?.trim();

      const commitMessage = latestCommitLine.substring(shortSHA.length + 1).trim();

      console.log(`✅ [GIT_VERIFY] Found ${commitCount} commits on branch ${branchName}`);
      console.log(`   Latest commit: ${fullSHA?.substring(0, 8)} - ${commitMessage}`);
      console.log(`   Story: ${storyId}`);

      return {
        commitSHA: fullSHA || shortSHA,
        hasCommits: true,
        commitCount,
        commitMessage
      };
    } catch (error: any) {
      console.error(`❌ [GIT_VERIFY] Error verifying git work:`, error.message);
      return null;
    }
  }
}
