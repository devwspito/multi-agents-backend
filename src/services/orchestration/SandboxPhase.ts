/**
 * SandboxPhase
 *
 * 🔥 CENTRALIZED SANDBOX CREATION - LLM DECIDES EVERYTHING
 *
 * This phase runs BEFORE PlanningPhase and is responsible for:
 * 1. Cloning all repositories
 * 2. Using LLM (LanguageDetectionService) to detect language/framework
 * 3. Creating the unified sandbox with correct Docker image
 * 4. Installing dependencies
 * 5. JUDGE validates the environment works (MANDATORY)
 * 6. Emitting SandboxConfigured event
 *
 * ⚠️ CRITICAL: If environment doesn't work, we DON'T proceed.
 * Judge MUST approve the environment before continuing.
 *
 * NO hardcoded fallbacks. NO radiography priority. 100% AGNOSTIC.
 * The LLM is the SINGLE SOURCE OF TRUTH for language detection.
 */

import { BasePhase, OrchestrationContext } from './Phase.js';
import { TaskRepository } from '../../database/repositories/TaskRepository.js';
import { eventStore } from '../EventStore.js';
import { languageDetectionService, DetectedLanguage } from '../LanguageDetectionService.js';
import { sandboxPoolService } from '../SandboxPoolService.js';
import { sandboxService } from '../SandboxService.js';
import { NotificationService } from '../NotificationService.js';
import { safeGitExecSync } from '../../utils/safeGitExecution.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

interface RepoConfig {
  name: string;
  url: string;
  type: 'frontend' | 'backend' | 'mobile' | 'shared' | 'fullstack' | 'unknown';
  language: DetectedLanguage;
  containerPath: string;
  hostPath: string;
  projectCreated: boolean;
  dependenciesInstalled: boolean;
}

interface SandboxPhaseData {
  repos: RepoConfig[];
  unifiedSandboxId: string;
  dockerImage: string;
  mappedPorts: Record<string, string>;
  environmentValidated: boolean;
}

// ============================================================================
// Judge Prompt for Sandbox Phase
// ============================================================================

export const SANDBOX_JUDGE_PROMPT = `You are the Sandbox Environment Judge. Your ONLY job is to validate that the development environment is correctly set up.

## Your Criteria (ALL must pass):

1. **Docker Container**: Is it running?
2. **Language Runtime**: Is the correct runtime installed (flutter, node, python, go, rust)?
3. **Dependencies**: Are project dependencies installed?
4. **Dev Server Ready**: Can the dev server command run (or at least the command exists)?

## Validation Commands:

Run these commands in the sandbox to verify:

For Flutter/Dart:
- \`which flutter\` - must return a path
- \`flutter --version\` - must show version
- If pubspec.yaml exists: \`cd /workspace/{repo} && flutter pub get\` - must succeed

For Node.js/TypeScript:
- \`which node\` - must return a path
- \`node --version\` - must show version
- If package.json exists: \`cd /workspace/{repo} && npm install\` - must succeed

For Python:
- \`which python3\` - must return a path
- \`python3 --version\` - must show version
- If requirements.txt exists: dependencies installed

## Your Response Format:

You MUST respond with this EXACT JSON structure:

\`\`\`json
{
  "approved": true,
  "checks": {
    "containerRunning": true,
    "runtimeInstalled": true,
    "dependenciesInstalled": true,
    "devServerReady": true
  },
  "details": "Explanation of what you verified",
  "fixSuggestion": null
}
\`\`\`

Or if something fails:

\`\`\`json
{
  "approved": false,
  "checks": {
    "containerRunning": true,
    "runtimeInstalled": false,
    "dependenciesInstalled": false,
    "devServerReady": false
  },
  "details": "Flutter command not found",
  "fixSuggestion": "Wrong Docker image used - needs Flutter SDK"
}
\`\`\`

Be STRICT. If ANY check fails, set approved=false.
The task CANNOT proceed without a valid environment.

Use the Bash tool to execute commands in the container and verify the environment.`;

// ============================================================================
// ExecuteAgent Function Type
// ============================================================================

type ExecuteAgentFn = (
  agentType: string,
  prompt: string,
  workspacePath: string,
  taskId: string,
  label: string,
  sessionId?: string,
  fork?: boolean,
  attachments?: any,
  options?: any,
  context?: OrchestrationContext
) => Promise<{ output: string; cost: number; usage: any }>;

// ============================================================================
// SandboxPhase Class
// ============================================================================

export class SandboxPhase extends BasePhase {
  readonly name = 'Sandbox';
  readonly description = 'Creates isolated sandbox environment with LLM-detected language/framework. Judge validates before proceeding.';

  private executeAgent: ExecuteAgentFn;

  constructor(executeAgent: ExecuteAgentFn) {
    super();
    this.executeAgent = executeAgent;
  }

  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const taskId = this.getTaskIdString(context);

    // Check if SandboxValidated event already exists (means Judge approved)
    const events = await eventStore.getEvents(taskId);
    const sandboxValidated = events.find(e => e.eventType === 'SandboxValidated');

    if (sandboxValidated) {
      this.logSkipDecision(true, 'Sandbox already validated by Judge');
      return true;
    }

    return false;
  }

  protected async executePhase(context: OrchestrationContext): Promise<{
    success: boolean;
    error?: string;
    warnings?: string[];
    data?: any;
    metadata?: { cost?: number; [key: string]: any };
  }> {
    const taskId = this.getTaskIdString(context);
    const projectId = context.getData<string>('projectId') || taskId;
    const workspacePath = context.getData<string>('workspacePath') || '';

    console.log(`\n${'='.repeat(70)}`);
    console.log(`🐳 [SandboxPhase] STARTING - LLM decides EVERYTHING, Judge validates`);
    console.log(`   ⚠️ NO ADVANCE WITHOUT JUDGE APPROVAL`);
    console.log(`${'='.repeat(70)}\n`);

    NotificationService.emitConsoleLog(
      taskId,
      'info',
      '🐳 SandboxPhase: Setting up isolated development environment'
    );

    let totalCost = 0;
    let sandbox: any = null;
    let llmDetected: DetectedLanguage | null = null;
    const repoConfigs: RepoConfig[] = [];

    try {
      // Get task and repositories
      const task = TaskRepository.findById(taskId);
      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      const repositories = (task.orchestration as any)?.repositories || [];
      if (repositories.length === 0) {
        console.log(`[SandboxPhase] ⚠️ No repositories configured`);
        return {
          success: false,
          error: 'No repositories configured - cannot create sandbox',
        };
      }

      // Ensure workspace exists
      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }

      // =======================================================================
      // STEP 1: Clone all repositories
      // =======================================================================
      console.log(`\n📦 [SandboxPhase] Step 1: Cloning ${repositories.length} repositories...`);

      for (const repo of repositories) {
        const repoPath = path.join(workspacePath, repo.name);

        if (fs.existsSync(path.join(repoPath, '.git'))) {
          console.log(`   ✅ [${repo.name}] Already cloned`);
          try {
            safeGitExecSync(`git -C "${repoPath}" pull --ff-only 2>/dev/null || true`, {
              encoding: 'utf8',
              timeout: 60000,
            });
          } catch {
            // Ignore
          }
        } else if (repo.url) {
          console.log(`   📥 [${repo.name}] Cloning...`);
          try {
            fs.mkdirSync(repoPath, { recursive: true });
            safeGitExecSync(`git clone "${repo.url}" "${repoPath}"`, {
              encoding: 'utf8',
              timeout: 120000,
            });
            console.log(`   ✅ [${repo.name}] Cloned`);
          } catch (error: any) {
            console.warn(`   ⚠️ [${repo.name}] Clone failed: ${error.message}`);
            if (!fs.existsSync(repoPath)) {
              fs.mkdirSync(repoPath, { recursive: true });
            }
          }
        } else {
          console.log(`   📁 [${repo.name}] Creating empty directory`);
          fs.mkdirSync(repoPath, { recursive: true });
        }
      }

      // =======================================================================
      // STEP 2: LLM detects language (SINGLE SOURCE OF TRUTH)
      // =======================================================================
      console.log(`\n🤖 [SandboxPhase] Step 2: LLM detecting language...`);

      const repoNames = repositories.map((r: any) => r.name);
      const detectionResult = await languageDetectionService.detectFromDescription(
        task.description || '',
        undefined,
        repoNames
      );

      llmDetected = detectionResult.primary;

      console.log(`\n   🔍 LLM Detection:`);
      console.log(`      Language: ${llmDetected.language}`);
      console.log(`      Framework: ${llmDetected.framework}`);
      console.log(`      Docker Image: ${llmDetected.dockerImage}`);
      console.log(`      Create: ${llmDetected.createCmd || 'N/A'}`);
      console.log(`      Install: ${llmDetected.installCmd || 'N/A'}`);
      console.log(`      Dev: ${llmDetected.devCmd || 'N/A'}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🤖 LLM: ${llmDetected.language}/${llmDetected.framework} → ${llmDetected.dockerImage}`
      );

      // =======================================================================
      // STEP 3: Create unified sandbox
      // =======================================================================
      console.log(`\n🐳 [SandboxPhase] Step 3: Creating sandbox...`);

      const workspaceMounts: Record<string, string> = {};

      for (const repo of repositories) {
        const hostPath = path.join(workspacePath, repo.name);
        const containerPath = `/workspace/${repo.name}`;
        workspaceMounts[hostPath] = containerPath;

        repoConfigs.push({
          name: repo.name,
          url: repo.url || '',
          type: repo.type || 'unknown',
          language: llmDetected,
          containerPath,
          hostPath,
          projectCreated: false,
          dependenciesInstalled: false,
        });
      }

      // Ports
      const allPorts: string[] = [];
      const devPort = llmDetected.devPort || 8080;
      allPorts.push(`0:${devPort}`);
      if (devPort !== 3000) allPorts.push('0:3000');
      if (devPort !== 3001) allPorts.push('0:3001');
      if (devPort !== 8000) allPorts.push('0:8000');

      console.log(`   Image: ${llmDetected.dockerImage}`);
      console.log(`   Ports: ${allPorts.join(', ')}`);

      const sandboxResult = await sandboxPoolService.findOrCreateSandbox(
        taskId,
        projectId,
        'unified',
        [],
        workspacePath,
        llmDetected.language,
        {
          image: llmDetected.dockerImage,
          networkMode: 'bridge',
          memoryLimit: '8g',
          cpuLimit: '4',
          ports: allPorts,
          workspaceMounts,
        },
        'fullstack'
      );

      if (!sandboxResult.sandbox) {
        throw new Error('Failed to create sandbox container');
      }

      sandbox = sandboxResult.sandbox;
      console.log(`   ✅ Container: ${sandbox.containerName}`);

      // =======================================================================
      // STEP 4: Create projects and install dependencies
      // =======================================================================
      console.log(`\n📦 [SandboxPhase] Step 4: Setting up projects...`);

      for (const repoConfig of repoConfigs) {
        const checkFile = llmDetected.checkFile || 'pubspec.yaml';
        const checkPath = path.join(repoConfig.hostPath, checkFile);

        console.log(`\n   [${repoConfig.name}]`);

        // Create project if needed
        if (!fs.existsSync(checkPath) && llmDetected.createCmd) {
          console.log(`      Creating project...`);

          const createResult = await sandboxService.exec(taskId, llmDetected.createCmd, {
            cwd: repoConfig.containerPath,
            timeout: 180000,
          });

          if (createResult.exitCode === 0) {
            repoConfig.projectCreated = true;
            console.log(`      ✅ Project created`);
          } else {
            console.warn(`      ⚠️ Create failed: ${createResult.stderr?.substring(0, 100)}`);
          }
        } else {
          repoConfig.projectCreated = true;
          console.log(`      ✅ Project exists`);
        }

        // Install dependencies
        if (llmDetected.installCmd) {
          console.log(`      Installing deps...`);

          const installResult = await sandboxService.exec(taskId, llmDetected.installCmd, {
            cwd: repoConfig.containerPath,
            timeout: 300000,
          });

          if (installResult.exitCode === 0) {
            repoConfig.dependenciesInstalled = true;
            console.log(`      ✅ Dependencies installed`);
          } else {
            console.warn(`      ⚠️ Install warning: ${installResult.stderr?.substring(0, 100)}`);
          }
        }
      }

      // =======================================================================
      // STEP 5: JUDGE validates environment (MANDATORY)
      // =======================================================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`⚖️ [SandboxPhase] Step 5: JUDGE VALIDATION`);
      console.log(`   ⚠️ Task CANNOT proceed without Judge approval`);
      console.log(`${'─'.repeat(70)}`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        '⚖️ Judge validating sandbox environment...'
      );

      // Build context for judge
      const repoList = repoConfigs.map(r =>
        `- ${r.name}: ${r.containerPath} (created: ${r.projectCreated}, deps: ${r.dependenciesInstalled})`
      ).join('\n');

      const judgePrompt = `${SANDBOX_JUDGE_PROMPT}

## Environment to Validate

**Container**: ${sandbox.containerName}
**Image**: ${llmDetected.dockerImage}
**Language**: ${llmDetected.language}
**Framework**: ${llmDetected.framework}

**Repositories**:
${repoList}

**Commands**:
- Create: ${llmDetected.createCmd || 'N/A'}
- Install: ${llmDetected.installCmd || 'N/A'}
- Dev: ${llmDetected.devCmd || 'N/A'}
- Port: ${llmDetected.devPort || 'N/A'}

## Instructions

1. Use Bash to run commands in the container (sandbox ID: ${taskId})
2. Verify the runtime is installed
3. Verify dependencies are available
4. Return your verdict as JSON

CRITICAL: If anything fails, return approved=false with fixSuggestion.`;

      // Execute judge
      const judgeResult = await this.executeAgent(
        'judge',
        judgePrompt,
        workspacePath,
        taskId,
        'sandbox-judge',
        undefined,
        false,
        undefined,
        { sandboxId: taskId },
        context
      );

      totalCost += judgeResult.cost || 0;

      // Parse judge response
      let judgeApproved = false;
      let judgeDetails = '';
      let judgeFix = '';

      try {
        const jsonMatch = judgeResult.output.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          judgeApproved = parsed.approved === true;
          judgeDetails = parsed.details || '';
          judgeFix = parsed.fixSuggestion || '';
        } else {
          // Try direct parse
          const parsed = JSON.parse(judgeResult.output.trim());
          judgeApproved = parsed.approved === true;
          judgeDetails = parsed.details || '';
          judgeFix = parsed.fixSuggestion || '';
        }
      } catch {
        // Fallback: look for keywords
        const output = judgeResult.output.toLowerCase();
        judgeApproved = output.includes('"approved": true') || output.includes('"approved":true');
        judgeDetails = 'Response parsing failed';
      }

      console.log(`\n   ⚖️ VERDICT: ${judgeApproved ? '✅ APPROVED' : '❌ REJECTED'}`);
      console.log(`   📝 ${judgeDetails}`);
      if (!judgeApproved && judgeFix) {
        console.log(`   🔧 Fix: ${judgeFix}`);
      }

      NotificationService.emitConsoleLog(
        taskId,
        judgeApproved ? 'info' : 'error',
        `⚖️ Judge: ${judgeApproved ? 'APPROVED' : 'REJECTED'} - ${judgeDetails}`
      );

      // =======================================================================
      // STEP 6: Result
      // =======================================================================

      if (!judgeApproved) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`❌ [SandboxPhase] FAILED - Judge rejected environment`);
        console.log(`   Cannot proceed until environment is fixed`);
        console.log(`${'='.repeat(70)}\n`);

        return {
          success: false,
          error: `Environment rejected: ${judgeFix || judgeDetails}`,
          metadata: { cost: totalCost },
        };
      }

      // Judge approved - save everything
      console.log(`\n📡 [SandboxPhase] Step 6: Saving configuration...`);

      const sandboxData: SandboxPhaseData = {
        repos: repoConfigs,
        unifiedSandboxId: taskId,
        dockerImage: llmDetected.dockerImage,
        mappedPorts: sandbox.mappedPorts || {},
        environmentValidated: true,
      };

      // Store in context
      context.setData('sandboxConfig', sandboxData);
      context.setData('llmDetectedLanguage', llmDetected);
      context.setData('unifiedSandboxId', taskId);
      context.setData('sandboxCreated', true);
      context.setData('environmentValidated', true);

      // Emit events
      await eventStore.append({
        taskId,
        eventType: 'SandboxConfigured',
        payload: {
          sandboxId: taskId,
          containerName: sandbox.containerName,
          dockerImage: llmDetected.dockerImage,
          language: llmDetected.language,
          framework: llmDetected.framework,
          repos: repoConfigs.map(r => ({
            name: r.name,
            type: r.type,
            containerPath: r.containerPath,
          })),
          mappedPorts: sandbox.mappedPorts,
          commands: {
            create: llmDetected.createCmd,
            install: llmDetected.installCmd,
            dev: llmDetected.devCmd,
            devPort: llmDetected.devPort,
          },
        },
      });

      await eventStore.append({
        taskId,
        eventType: 'SandboxValidated',
        payload: {
          approved: true,
          judgeDetails,
          validatedAt: new Date().toISOString(),
        },
      });

      // EnvironmentConfigDefined for DevServerService
      const envConfig: Record<string, any> = {};
      for (const repo of repoConfigs) {
        envConfig[repo.name] = {
          language: llmDetected.language,
          framework: llmDetected.framework,
          installCommand: llmDetected.installCmd,
          runCommand: llmDetected.devCmd,
          devPort: llmDetected.devPort,
          dockerImage: llmDetected.dockerImage,
        };
      }

      await eventStore.append({
        taskId,
        eventType: 'EnvironmentConfigDefined',
        payload: envConfig,
      });

      // Update task
      TaskRepository.modifyOrchestration(taskId, (orch) => ({
        ...orch,
        sandbox: {
          agent: 'sandbox-setup' as const,
          status: 'completed' as const,
          sandboxId: taskId,
          containerName: sandbox.containerName,
          dockerImage: llmDetected?.dockerImage,
          language: llmDetected?.language,
          framework: llmDetected?.framework,
          validated: true,
          judgeDetails,
        },
      }));

      console.log(`\n${'='.repeat(70)}`);
      console.log(`✅ [SandboxPhase] COMPLETE - Environment VALIDATED`);
      console.log(`   Ready for development`);
      console.log(`${'='.repeat(70)}\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ SandboxPhase complete - Environment validated, ready for Planning`
      );

      return {
        success: true,
        data: sandboxData,
        metadata: { cost: totalCost },
      };

    } catch (error: any) {
      console.error(`\n❌ [SandboxPhase] Failed: ${error.message}`);
      NotificationService.emitConsoleLog(
        taskId,
        'error',
        `❌ Sandbox failed: ${error.message}`
      );

      return {
        success: false,
        error: error.message,
        metadata: { cost: totalCost },
      };
    }
  }
}

export default SandboxPhase;
