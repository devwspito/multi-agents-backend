/**
 * Agent Artifact Service
 *
 * Saves agent work to local workspace and pushes to GitHub as backup.
 * This ensures all agent decisions/outputs are preserved even if workspace crashes.
 *
 * Each agent type saves different artifacts:
 * - Planning: epics.json with all epic definitions
 * - TechLead: epic-X-stories.json with architecture and stories
 * - Judges: evaluation-X.json with verdicts and feedback
 * - Developers: Already push code directly
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export type AgentType = 'planning' | 'techlead' | 'judge' | 'developer' | 'fixer' | 'explorer' | 'assistant' | 'planner';

export interface ArtifactMetadata {
  agentType: AgentType;
  taskId: string;
  timestamp: Date;
  phase?: string;
  epicId?: string;
  storyId?: string;
}

export interface SaveArtifactOptions {
  workspacePath: string;
  targetRepository: string;
  agentType: AgentType;
  artifactName: string;
  data: any;
  metadata: ArtifactMetadata;
  commitMessage?: string;
  branch?: string;
}

export class AgentArtifactService {
  private static readonly ARTIFACTS_DIR = '.agents';

  /**
   * Save artifact to local workspace and push to GitHub
   */
  static async saveAndPush(options: SaveArtifactOptions): Promise<{ success: boolean; filePath: string; error?: string }> {
    const {
      workspacePath,
      targetRepository,
      agentType,
      artifactName,
      data,
      metadata,
      commitMessage,
      branch = 'main'
    } = options;

    try {
      // Build paths
      const repoPath = path.join(workspacePath, targetRepository);
      const artifactsDir = path.join(repoPath, this.ARTIFACTS_DIR, agentType);
      const filePath = path.join(artifactsDir, `${artifactName}.json`);

      console.log(`\n📦 [AgentArtifact] Saving ${agentType} artifact: ${artifactName}`);
      console.log(`   Repository: ${targetRepository}`);
      console.log(`   Path: ${filePath}`);

      // Ensure directory exists
      if (!fs.existsSync(artifactsDir)) {
        fs.mkdirSync(artifactsDir, { recursive: true });
        console.log(`   ✅ Created directory: ${artifactsDir}`);
      }

      // Prepare artifact content
      const artifact = {
        _metadata: {
          ...metadata,
          savedAt: new Date().toISOString(),
          version: '1.0'
        },
        data
      };

      // Write to file
      fs.writeFileSync(filePath, JSON.stringify(artifact, null, 2), 'utf8');
      console.log(`   ✅ Saved to local: ${filePath}`);

      // Git add, commit, push
      const message = commitMessage || `[${agentType}] Save artifact: ${artifactName}`;

      try {
        // Check if we're on the right branch (generous timeouts for large projects)
        const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, encoding: 'utf8', timeout: 30000 }).trim(); // 30 sec

        if (currentBranch !== branch && branch !== 'main') {
          // If we need to be on a specific branch, try to checkout
          try {
            execSync(`git checkout ${branch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 120000 }); // 2 min
          } catch (e) {
            // Branch might not exist, create it
            execSync(`git checkout -b ${branch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 120000 }); // 2 min
          }
        }

        // Add the file
        execSync(`git add "${filePath}"`, { cwd: repoPath, encoding: 'utf8', timeout: 120000 }); // 2 min

        // Check if there are changes to commit
        const status = execSync('git status --porcelain', { cwd: repoPath, encoding: 'utf8', timeout: 120000 }); // 2 min

        if (status.trim().length > 0) {
          // Commit
          execSync(`git commit -m "${message}"`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 300000 }); // 5 min for hooks
          console.log(`   ✅ Committed: ${message}`);

          // Push
          const pushBranch = currentBranch !== 'HEAD' ? currentBranch : branch;
          execSync(`git push origin ${pushBranch}`, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe', timeout: 600000 }); // 10 min
          console.log(`   ✅ Pushed to GitHub (${pushBranch})`);
        } else {
          console.log(`   ℹ️ No changes to commit (file unchanged)`);
        }

      } catch (gitError: any) {
        console.warn(`   ⚠️ Git operation failed: ${gitError.message}`);
        console.warn(`   📁 Artifact saved locally but NOT pushed to GitHub`);
        // Don't fail - local save succeeded, git push is bonus
      }

      return { success: true, filePath };

    } catch (error: any) {
      console.error(`❌ [AgentArtifact] Failed to save: ${error.message}`);
      return { success: false, filePath: '', error: error.message };
    }
  }

  /**
   * Save Planning artifacts (epics)
   */
  static async savePlanningArtifact(
    workspacePath: string,
    targetRepository: string,
    taskId: string,
    epics: any[],
    taskTitle?: string,
    taskDescription?: string
  ): Promise<{ success: boolean; filePath: string }> {
    return this.saveAndPush({
      workspacePath,
      targetRepository,
      agentType: 'planning',
      artifactName: 'epics',
      data: {
        taskTitle,
        taskDescription,
        epicsCount: epics.length,
        epics
      },
      metadata: {
        agentType: 'planning',
        taskId,
        timestamp: new Date(),
        phase: 'planning'
      },
      commitMessage: `[Planning] Save ${epics.length} epic(s) for task`
    });
  }

  /**
   * Save TechLead artifacts (architecture + stories for an epic)
   */
  static async saveTechLeadArtifact(
    workspacePath: string,
    targetRepository: string,
    taskId: string,
    epicId: string,
    architectureOutput: any,
    stories: any[]
  ): Promise<{ success: boolean; filePath: string }> {
    return this.saveAndPush({
      workspacePath,
      targetRepository,
      agentType: 'techlead',
      artifactName: `epic-${epicId}-architecture`,
      data: {
        epicId,
        storiesCount: stories.length,
        architecture: architectureOutput,
        stories
      },
      metadata: {
        agentType: 'techlead',
        taskId,
        timestamp: new Date(),
        phase: 'techlead',
        epicId
      },
      commitMessage: `[TechLead] Save architecture for epic ${epicId}`
    });
  }

  /**
   * Save Judge evaluation artifacts
   */
  static async saveJudgeArtifact(
    workspacePath: string,
    targetRepository: string,
    taskId: string,
    judgeType: 'planning' | 'techlead' | 'developer',
    entityId: string, // epicId or storyId
    evaluation: {
      verdict: 'approved' | 'rejected';
      score?: number;
      feedback: string;
      filesVerified?: string[];
      issues?: string[];
      suggestions?: string[];
    }
  ): Promise<{ success: boolean; filePath: string }> {
    const artifactName = judgeType === 'developer'
      ? `story-${entityId}-evaluation`
      : `${judgeType}-${entityId}-evaluation`;

    return this.saveAndPush({
      workspacePath,
      targetRepository,
      agentType: 'judge',
      artifactName,
      data: {
        judgeType,
        entityId,
        ...evaluation
      },
      metadata: {
        agentType: 'judge',
        taskId,
        timestamp: new Date(),
        phase: 'judge',
        epicId: judgeType !== 'developer' ? entityId : undefined,
        storyId: judgeType === 'developer' ? entityId : undefined
      },
      commitMessage: `[Judge-${judgeType}] ${evaluation.verdict.toUpperCase()} - ${entityId}`
    });
  }

  /**
   * Load artifact from local workspace
   */
  static loadArtifact(
    workspacePath: string,
    targetRepository: string,
    agentType: AgentType,
    artifactName: string
  ): any | null {
    try {
      const repoPath = path.join(workspacePath, targetRepository);
      const filePath = path.join(repoPath, this.ARTIFACTS_DIR, agentType, `${artifactName}.json`);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error: any) {
      console.warn(`⚠️ [AgentArtifact] Failed to load ${artifactName}: ${error.message}`);
      return null;
    }
  }

  /**
   * List all artifacts of a type
   */
  static listArtifacts(
    workspacePath: string,
    targetRepository: string,
    agentType: AgentType
  ): string[] {
    try {
      const repoPath = path.join(workspacePath, targetRepository);
      const artifactsDir = path.join(repoPath, this.ARTIFACTS_DIR, agentType);

      if (!fs.existsSync(artifactsDir)) {
        return [];
      }

      return fs.readdirSync(artifactsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch (error) {
      return [];
    }
  }

  /**
   * Check if artifact exists
   */
  static artifactExists(
    workspacePath: string,
    targetRepository: string,
    agentType: AgentType,
    artifactName: string
  ): boolean {
    const repoPath = path.join(workspacePath, targetRepository);
    const filePath = path.join(repoPath, this.ARTIFACTS_DIR, agentType, `${artifactName}.json`);
    return fs.existsSync(filePath);
  }

  /**
   * Save orchestration timeline (story time of all phases)
   * Called after each phase completes to maintain a complete execution history
   */
  static async saveOrchestrationTimeline(
    workspacePath: string,
    targetRepository: string,
    taskId: string,
    timeline: {
      taskTitle: string;
      taskDescription?: string;
      startedAt: Date;
      currentPhase: string;
      phasesCompleted: Array<{
        phase: string;
        status: 'completed' | 'failed' | 'skipped';
        startedAt?: Date;
        completedAt?: Date;
        duration?: number;
        cost?: number;
        output?: string;
        error?: string;
      }>;
      epics?: Array<{
        id: string;
        title: string;
        status: string;
        storiesCount?: number;
        storiesCompleted?: number;
      }>;
      totalCost?: number;
      totalTokens?: number;
      errors?: string[];
      lastUpdated: Date;
    }
  ): Promise<{ success: boolean; filePath: string }> {
    return this.saveAndPush({
      workspacePath,
      targetRepository,
      agentType: 'planning', // Use 'planning' dir but with special name
      artifactName: 'orchestration-timeline',
      data: timeline,
      metadata: {
        agentType: 'planning',
        taskId,
        timestamp: new Date(),
        phase: timeline.currentPhase
      },
      commitMessage: `[Orchestration] Timeline update: ${timeline.currentPhase}`
    });
  }

  /**
   * Load orchestration timeline from local workspace
   * Used for recovery after server restart
   */
  static loadOrchestrationTimeline(
    workspacePath: string,
    targetRepository: string
  ): any | null {
    return this.loadArtifact(workspacePath, targetRepository, 'planning', 'orchestration-timeline');
  }
}

export default AgentArtifactService;
