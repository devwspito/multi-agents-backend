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

  async shouldSkip(_context: OrchestrationContext): Promise<boolean> {
    // 🔥 SANDBOX ALWAYS RE-EXECUTES
    // Sandbox is ephemeral and must be recreated on every run/resume/retry
    // This ensures:
    // 1. Fresh Docker container with clean state
    // 2. No corrupted state from previous failed runs
    // 3. Judge always validates the environment
    //
    // The executePhase will handle cleanup of any existing containers
    this.logSkipDecision(false, 'Sandbox always re-executes (never skip)');
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
    const projectId = context.getData<string>('projectId') || context.task?.projectId?.toString() || taskId;
    // 🔥 FIX: workspacePath is a DIRECT property, not in sharedData
    const workspacePath = context.workspacePath || '';

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

      // 🔥 FIX: Use context.repositories (passed by OrchestrationCoordinator)
      // NOT task.orchestration.repositories (which doesn't exist yet)
      const repositories = context.repositories || [];
      if (repositories.length === 0) {
        console.log(`[SandboxPhase] ⚠️ No repositories in context`);
        console.log(`   context.repositories: ${JSON.stringify(context.repositories)}`);
        return {
          success: false,
          error: 'No repositories configured - cannot create sandbox',
        };
      }

      console.log(`[SandboxPhase] Found ${repositories.length} repositories in context`);
      repositories.forEach((r: any) => console.log(`   - ${r.name} (${r.type || 'unknown'})`));

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
      // STEP 2: DETECT LANGUAGE PER REPO (FILES FIRST, LLM FALLBACK)
      // =======================================================================
      console.log(`\n🔍 [SandboxPhase] Step 2: Detecting language PER REPO...`);
      console.log(`   📁 PRIORITY 1: File-based detection (package.json, pubspec.yaml, etc.)`);
      console.log(`   🤖 PRIORITY 2: LLM detection (if files not found)`);

      // 🔥 NEW: Detect language for EACH repo separately - FILES FIRST!
      const repoInfos = repositories.map((r: any) => ({
        name: r.name,
        type: r.type || 'unknown',
      }));

      const perRepoDetection = await languageDetectionService.detectPerRepoWithFiles(
        task.description || '',
        repoInfos,
        workspacePath  // 🔥 Pass workspace path for file detection
      );

      // Store per-repo detection in context for later use
      context.setData('perRepoDetection', perRepoDetection);

      // Use first repo's config for sandbox image (we'll use multi-runtime)
      // The actual per-repo commands will be applied in Step 4
      const firstRepo = repositories[0];
      llmDetected = perRepoDetection[firstRepo?.name] || {
        language: 'unknown',
        framework: 'unknown',
        dockerImage: 'ubuntu:22.04',
        ecosystem: 'unknown',
        confidence: 'low' as const,
        reasoning: 'No detection available',
      };

      // Log all detections
      console.log(`\n   🔍 Per-Repo LLM Detection:`);
      for (const [repoName, config] of Object.entries(perRepoDetection)) {
        console.log(`      ${repoName}: ${config.language}/${config.framework}`);
        console.log(`         Image: ${config.dockerImage}`);
        console.log(`         Install: ${config.installCmd || 'N/A'}`);
        console.log(`         Dev: ${config.devCmd || 'N/A'}`);
      }

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🤖 LLM detected ${Object.keys(perRepoDetection).length} repos with different languages`
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

      // Ports - collect ALL unique ports from ALL repos
      const portSet = new Set<number>();

      // 🔥 Add devPort from EACH repo (per-repo detection)
      for (const [repoName, repoConfig] of Object.entries(perRepoDetection)) {
        if (repoConfig.devPort) {
          portSet.add(repoConfig.devPort);
          console.log(`   📍 Port from ${repoName}: ${repoConfig.devPort}`);
        }
      }

      // 🔥 ALWAYS include common ports for dev servers
      portSet.add(3000);   // Node.js default
      portSet.add(3001);   // Alternative Node.js
      portSet.add(8000);   // Python/Django default
      portSet.add(8080);   // Flutter web preview (MANDATORY)

      const allPorts: string[] = Array.from(portSet).map(p => `0:${p}`);

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
      // 🔥 100% AGNOSTIC - PER-REPO LLM CONFIG
      // =======================================================================
      console.log(`\n📦 [SandboxPhase] Step 4: Setting up projects (PER-REPO LLM config)...`);

      // perRepoDetection was set in Step 2, use it directly

      for (const repoConfig of repoConfigs) {
        console.log(`\n   [${repoConfig.name}]`);

        // 🔥 GET CONFIG FOR THIS SPECIFIC REPO
        const repoLLM = perRepoDetection[repoConfig.name] || llmDetected;
        console.log(`      📋 Using ${repoLLM.language}/${repoLLM.framework} config`);

        // 🔥 AGNOSTIC: Install runtime for THIS repo (ubuntu:22.04 has no language tools)
        // Every repo needs its runtime installed since we use ubuntu base
        // 🛡️ FAULT-TOLERANT: Verify first, retry on failure, never block
        if (repoLLM.runtimeInstallCmd) {
          // 🔍 Check if runtime is already installed (avoid reinstalling)
          const runtimeChecks: Record<string, string> = {
            'Dart': 'which dart || test -f /opt/flutter/bin/dart',
            'Flutter': 'which flutter || test -f /opt/flutter/bin/flutter',
            'Node.js': 'which node',
            'Python': 'which python3',
            'Go': 'which go || test -f /usr/local/go/bin/go',
          };

          const checkCmd = runtimeChecks[repoLLM.language] || `which ${repoLLM.language.toLowerCase()}`;
          const checkResult = await sandboxService.exec(taskId, checkCmd, {
            cwd: '/workspace',
            timeout: 5000,
          });

          if (checkResult.exitCode === 0) {
            console.log(`      ✅ ${repoLLM.language} runtime already installed - skipping`);
            NotificationService.emitConsoleLog(taskId, 'info', `✅ [${repoConfig.name}] ${repoLLM.language} already available`);
          } else {
            // Runtime not installed - install with retries
            console.log(`      🔧 Installing ${repoLLM.language} runtime...`);
            console.log(`         Command: ${repoLLM.runtimeInstallCmd.substring(0, 80)}...`);
            NotificationService.emitConsoleLog(
              taskId,
              'info',
              `🔧 [${repoConfig.name}] Installing ${repoLLM.language} runtime (may take several minutes)...`
            );

            let runtimeInstalled = false;
            const MAX_RETRIES = 3;

            for (let attempt = 1; attempt <= MAX_RETRIES && !runtimeInstalled; attempt++) {
              if (attempt > 1) {
                console.log(`      🔄 Retry ${attempt}/${MAX_RETRIES}...`);
                NotificationService.emitConsoleLog(taskId, 'info', `🔄 [${repoConfig.name}] Retry ${attempt}/${MAX_RETRIES}...`);
              }

              // 🔥 Kill any stale apt processes before installing (prevent lock conflicts)
              await sandboxService.exec(taskId, 'pkill -9 apt-get 2>/dev/null || pkill -9 apt 2>/dev/null || rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock* 2>/dev/null || true', {
                cwd: '/workspace',
                timeout: 10000,
              });

              // 🔥 Wait for apt lock to be released (max 60s)
              await sandboxService.exec(taskId, 'for i in $(seq 1 60); do fuser /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 1; done', {
                cwd: '/workspace',
                timeout: 65000,
              });

              const runtimeResult = await sandboxService.exec(taskId, repoLLM.runtimeInstallCmd, {
                cwd: '/workspace',
                timeout: 1800000, // 30 min - runtime installs take long (Flutter, Node.js, etc.)
              });

              if (runtimeResult.exitCode === 0) {
                runtimeInstalled = true;
                console.log(`      ✅ Runtime installed successfully`);
                NotificationService.emitConsoleLog(taskId, 'info', `✅ [${repoConfig.name}] ${repoLLM.language} runtime ready`);
              } else if (attempt < MAX_RETRIES) {
                console.warn(`      ⚠️ Attempt ${attempt} failed, will retry...`);
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 5000));
              } else {
                // 🛑 CRITICAL: After all retries, FAIL THE PHASE
                console.error(`      ❌ Runtime install FAILED after ${MAX_RETRIES} attempts:`);
                console.error(`         stderr: ${runtimeResult.stderr?.substring(0, 200)}`);
                NotificationService.emitConsoleLog(
                  taskId,
                  'error',
                  `❌ [${repoConfig.name}] Runtime install failed after ${MAX_RETRIES} attempts - BLOCKING`
                );

                // 🛑 FAIL THE PHASE - cannot proceed without runtime
                return {
                  success: false,
                  error: `Runtime installation failed for ${repoConfig.name} (${repoLLM.language}) after ${MAX_RETRIES} attempts. Last error: ${runtimeResult.stderr?.substring(0, 200)}`,
                  metadata: { cost: 0 },
                };
              }
            }
          }
        } else {
          console.log(`      ⚠️ No runtimeInstallCmd provided by LLM - checking if runtime exists...`);
        }

        // 🔥 LLM provides checkFile for THIS repo
        const checkFile = repoLLM.checkFile;
        let projectExists = false;

        if (checkFile) {
          const checkPath = path.join(repoConfig.hostPath, checkFile);
          projectExists = fs.existsSync(checkPath);
          console.log(`      🔍 LLM checkFile: ${checkFile} → ${projectExists ? 'EXISTS' : 'NOT FOUND'}`);
        }

        if (projectExists) {
          // Project exists - run THIS repo's install command
          repoConfig.projectCreated = true;
          console.log(`      ✅ Project exists (${repoLLM.language})`);

          if (repoLLM.installCmd) {
            console.log(`      📦 Installing: ${repoLLM.installCmd}`);
            const installResult = await sandboxService.exec(taskId, repoLLM.installCmd, {
              cwd: repoConfig.containerPath,
            });

            if (installResult.exitCode === 0) {
              repoConfig.dependenciesInstalled = true;
              console.log(`      ✅ Dependencies installed`);
            } else {
              console.warn(`      ⚠️ Install warning: ${installResult.stderr?.substring(0, 100)}`);
            }
          }
        } else {
          // No project - run THIS repo's create command
          if (repoLLM.createCmd) {
            console.log(`      🆕 Creating project: ${repoLLM.createCmd}`);
            const createResult = await sandboxService.exec(taskId, repoLLM.createCmd, {
              cwd: repoConfig.containerPath,
            });

            if (createResult.exitCode === 0) {
              repoConfig.projectCreated = true;
              console.log(`      ✅ Project created`);

              // Now install dependencies for THIS repo
              if (repoLLM.installCmd) {
                console.log(`      📦 Installing: ${repoLLM.installCmd}`);
                const installResult = await sandboxService.exec(taskId, repoLLM.installCmd, {
                  cwd: repoConfig.containerPath,
                });
                if (installResult.exitCode === 0) {
                  repoConfig.dependenciesInstalled = true;
                  console.log(`      ✅ Dependencies installed`);
                }
              }
            } else {
              console.warn(`      ⚠️ Create failed: ${createResult.stderr?.substring(0, 100)}`);
            }
          } else {
            console.log(`      ⚠️ No createCmd from LLM - skipping project creation`);
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
      context.setData('detectedLanguage', llmDetected);  // 🔥 For PlanningPhase compatibility
      context.setData('unifiedSandboxId', taskId);
      context.setData('sandboxCreated', true);
      context.setData('environmentValidated', true);

      // 🔥 CRITICAL: Set sandboxMap and useSandbox for ALL downstream phases
      // TechLead, Developers, Judge, TeamOrchestration, Verification ALL read from sandboxMap
      const sandboxMap = new Map<string, string>();
      for (const repo of repoConfigs) {
        sandboxMap.set(repo.name, taskId);  // All repos point to unified sandbox
        console.log(`   📍 sandboxMap: ${repo.name} → ${taskId}`);
      }
      context.setData('sandboxMap', sandboxMap);
      context.setData('useSandbox', true);
      console.log(`✅ [SandboxPhase] Set sandboxMap with ${sandboxMap.size} repo(s) for downstream phases`);

      // 🔥 100% AGNOSTIC: Store per-repo sandbox configs from LLM
      // EACH repo gets its OWN config from perRepoDetection
      const repoSandboxConfigs: Record<string, {
        language: string;
        installCmd: string;
        devCmd?: string;
        devPort?: number;
        repoType: string;
      }> = {};

      // perRepoDetection was set in Step 2

      for (const repo of repoConfigs) {
        // 🔥 Use THIS repo's LLM config
        const repoLLM = perRepoDetection[repo.name] || llmDetected;
        repoSandboxConfigs[repo.name] = {
          language: repoLLM.language,
          installCmd: repoLLM.installCmd || '',
          devCmd: repoLLM.devCmd,
          devPort: repoLLM.devPort,
          repoType: repo.type,
        };
        console.log(`   📦 ${repo.name}: ${repoLLM.language}/${repoLLM.framework} (per-repo LLM)`);
      }

      context.setData('repoSandboxConfigs', repoSandboxConfigs);
      console.log(`✅ [SandboxPhase] Set repoSandboxConfigs for ${Object.keys(repoSandboxConfigs).length} repo(s) - per-repo LLM`);

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
      // 🔥 CRITICAL: Use per-repo config so each repo has its OWN runCommand
      const envConfig: Record<string, any> = {};
      // perRepoDetection was set in Step 2

      for (const repo of repoConfigs) {
        const repoLLM = perRepoDetection[repo.name] || llmDetected;
        envConfig[repo.name] = {
          language: repoLLM.language,
          framework: repoLLM.framework,
          installCommand: repoLLM.installCmd,
          runCommand: repoLLM.devCmd,
          devPort: repoLLM.devPort,
          dockerImage: repoLLM.dockerImage,
        };
        console.log(`   🔧 ${repo.name}: ${repoLLM.language} → ${repoLLM.devCmd || 'no devCmd'}`);
      }

      // 🔥 Store environmentConfig in context for direct access by downstream phases
      context.setData('environmentConfig', envConfig);
      console.log(`✅ [SandboxPhase] Set environmentConfig for ${Object.keys(envConfig).length} repo(s) - per-repo`);

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

      // =======================================================================
      // STEP 7: 🚀 START & VERIFY ALL DEV SERVERS
      // 🔥 FLOW:
      //   - Success → Planning (normal)
      //   - Crash → Planning (with crash info injected so devs fix it first)
      // =======================================================================
      console.log(`\n${'='.repeat(70)}`);
      console.log(`🚀 [SandboxPhase] Step 7: STARTING & VERIFYING ALL DEV SERVERS`);
      console.log(`   ⚠️ MANDATORY: Wait for compilation before proceeding`);
      console.log(`   Starting ${Object.keys(envConfig).length} server(s)...`);
      console.log(`${'='.repeat(70)}\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `🚀 Compiling ${Object.keys(envConfig).length} server(s)... (may take 2-5 min for Flutter)`
      );

      const serverResults: Record<string, {
        started: boolean;
        verified: boolean;
        url?: string;
        port?: number;
        error?: string;
        compilationLogs?: string;
      }> = {};

      // 🔥 VALIDATION: Check ALL repos have devCmd BEFORE starting servers
      const reposWithoutDevCmd: string[] = [];
      for (const [repoName, config] of Object.entries(envConfig)) {
        const repoConfig = config as any;
        if (!repoConfig.runCommand) {
          reposWithoutDevCmd.push(repoName);
        }
      }

      if (reposWithoutDevCmd.length > 0) {
        const errorMsg = `Missing devCmd/runCommand for: ${reposWithoutDevCmd.join(', ')}. The LLM must detect the correct dev command for each repository.`;
        console.error(`\n   🚨 CRITICAL VALIDATION FAILURE: ${errorMsg}`);
        NotificationService.emitConsoleLog(taskId, 'error', `🚨 ${errorMsg}`);

        // 🔥 BLOCK: Return failure - cannot proceed to Planning without dev commands
        return {
          success: false,
          error: errorMsg,
          data: {
            ...sandboxData,
            validationError: errorMsg,
            reposWithoutDevCmd,
          },
        };
      }

      // Start and WAIT for each repo's server
      for (const [repoName, config] of Object.entries(envConfig)) {
        const repoConfig = config as any;
        const devCmd = repoConfig.runCommand;
        const devPort = repoConfig.devPort || 3000;

        // devCmd is guaranteed to exist here due to validation above
        if (!devCmd) {
          console.log(`   ⚠️ [${repoName}] No devCmd - skipping`);
          serverResults[repoName] = { started: false, verified: false, error: 'No runCommand' };
          continue;
        }

        console.log(`\n   🚀 [${repoName}] Compiling...`);
        console.log(`      Command: ${devCmd}`);
        console.log(`      Port: ${devPort}`);

        NotificationService.emitConsoleLog(
          taskId,
          'info',
          `🚀 [${repoName}] Compiling on port ${devPort}...`
        );

        const repoDir = `/workspace/${repoName}`;
        const hostPort = sandbox.mappedPorts?.[devPort.toString()] || devPort;

        try {
          // Start server in background
          const startCmd = `cd ${repoDir} && nohup ${devCmd} > /tmp/${repoName}-server.log 2>&1 &`;
          await sandboxService.exec(taskId, startCmd, { cwd: repoDir, timeout: 30000 });

          // 🔥 POLL for compilation completion (up to 5 minutes)
          const MAX_WAIT_MS = 300000;
          const POLL_INTERVAL_MS = 5000;
          const startTime = Date.now();
          let serverReady = false;
          let compilationError = false;
          let lastLogs = '';

          while (Date.now() - startTime < MAX_WAIT_MS && !serverReady && !compilationError) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

            const logsResult = await sandboxService.exec(taskId, `cat /tmp/${repoName}-server.log 2>/dev/null | tail -100`, {
              cwd: '/workspace', timeout: 10000,
            });
            lastLogs = logsResult.stdout || '';

            // Success patterns
            if (lastLogs.includes('is being served at') || lastLogs.includes('Flutter DevTools') ||
                lastLogs.includes('Debug service listening') || lastLogs.includes('listening on') ||
                lastLogs.includes('Server running') || lastLogs.includes('Started on port') ||
                lastLogs.includes('ready on') || lastLogs.includes('server started')) {
              serverReady = true;
              console.log(`      ✅ [${repoName}] Compilation SUCCESS!`);
            }

            // Error patterns
            if (lastLogs.includes('Error:') || lastLogs.includes('error:') ||
                lastLogs.includes('Cannot find module') || lastLogs.includes('ENOENT') ||
                lastLogs.includes('compilation failed') || lastLogs.includes('Build failed') ||
                lastLogs.includes('Exception:') || lastLogs.includes('failed to compile')) {
              compilationError = true;
              console.log(`      ❌ [${repoName}] Compilation FAILED!`);
            }

            // Progress every 30s
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            if (elapsed % 30 === 0 && elapsed > 0) {
              console.log(`      ⏳ [${repoName}] Still compiling... (${elapsed}s)`);
              NotificationService.emitConsoleLog(taskId, 'info', `⏳ [${repoName}] Compiling... (${elapsed}s)`);
            }
          }

          // Verify server responds (with retry - server may need time to bind to port)
          let verified = false;
          if (serverReady) {
            const VERIFY_RETRIES = 5;
            const VERIFY_DELAY_MS = 2000; // 2 seconds between retries

            for (let attempt = 1; attempt <= VERIFY_RETRIES && !verified; attempt++) {
              try {
                // Wait before checking (give server time to bind)
                if (attempt > 1) {
                  await new Promise(resolve => setTimeout(resolve, VERIFY_DELAY_MS));
                }

                const verifyCmd = `curl -s -o /dev/null -w "%{http_code}" http://localhost:${devPort} 2>/dev/null || echo "000"`;
                const verifyResult = await sandboxService.exec(taskId, verifyCmd, { cwd: '/workspace', timeout: 10000 });
                const statusCode = parseInt(verifyResult.stdout.trim()) || 0;
                verified = statusCode >= 200 && statusCode < 500;

                if (!verified && attempt < VERIFY_RETRIES) {
                  console.log(`      ⏳ [${repoName}] Verification attempt ${attempt}/${VERIFY_RETRIES} - waiting for port ${devPort}...`);
                }
              } catch {
                if (attempt === VERIFY_RETRIES) {
                  console.log(`      ⚠️ [${repoName}] Curl verification failed after ${VERIFY_RETRIES} attempts`);
                }
              }
            }

            if (verified) {
              console.log(`      ✅ [${repoName}] Port ${devPort} verified and responding!`);
            }
          }

          // Store result
          if (serverReady && verified) {
            serverResults[repoName] = {
              started: true, verified: true,
              url: `http://localhost:${hostPort}`, port: devPort,
            };
            NotificationService.emitDevServerReady(taskId, `http://localhost:${hostPort}`, repoConfig.framework || 'unknown');
            NotificationService.emitConsoleLog(taskId, 'info', `✅ [${repoName}] Ready at http://localhost:${hostPort}`);
          } else {
            // Extract error message
            const errorMatch = lastLogs.match(/Error:.*$/m) || lastLogs.match(/error:.*$/m) ||
                              lastLogs.match(/Cannot find module.*$/m) || lastLogs.match(/Exception:.*$/m);
            const errorMsg = errorMatch ? errorMatch[0].substring(0, 300) : 'Compilation failed or timeout';

            serverResults[repoName] = {
              started: false, verified: false,
              url: `http://localhost:${hostPort}`, port: devPort,
              error: errorMsg,
              compilationLogs: lastLogs.substring(0, 1500),
            };
            NotificationService.emitConsoleLog(taskId, 'error', `❌ [${repoName}] ${errorMsg.substring(0, 100)}`);
          }

        } catch (err: any) {
          console.log(`      ❌ [${repoName}] Exception: ${err.message}`);
          serverResults[repoName] = {
            started: false, verified: false,
            error: err.message,
          };
        }
      }

      // Store results
      context.setData('devServerResults', serverResults);

      const successCount = Object.values(serverResults).filter(r => r.verified).length;
      const failedServers = Object.entries(serverResults).filter(([, r]) => !r.verified);
      const totalServers = Object.keys(serverResults).length;

      // Summary
      console.log(`\n   📊 Compilation Results:`);
      Object.entries(serverResults).forEach(([repo, result]) => {
        if (result.verified) {
          console.log(`      ✅ ${repo}: ${result.url}`);
        } else {
          console.log(`      ❌ ${repo}: ${result.error?.substring(0, 80)}`);
        }
      });

      console.log(`\n${'='.repeat(70)}`);

      // 🔥 BLOCK: If ANY server failed to start, the environment is NOT ready
      // User requirement: "No podemos salir de sandbox sin que el servidor esté arriba"
      if (failedServers.length > 0) {
        const errorMsg = `${failedServers.length}/${totalServers} dev server(s) failed to start. ALL servers must be running before proceeding.`;
        console.error(`\n🚨 [SandboxPhase] BLOCKING: ${errorMsg}`);

        // Emit failure event for frontend
        await eventStore.append({
          taskId,
          eventType: 'DevServersFailed',
          payload: {
            servers: serverResults,
            successCount,
            failedCount: failedServers.length,
            totalCount: totalServers,
            errors: failedServers.map(([repo, result]) => ({
              repository: repo,
              error: result.error || 'Unknown error',
              logs: result.compilationLogs?.substring(0, 500),
            })),
          },
        });

        NotificationService.emitConsoleLog(taskId, 'error', `🚨 ${errorMsg}`);

        // List all errors
        failedServers.forEach(([repo, result]) => {
          console.error(`   ❌ ${repo}: ${result.error?.substring(0, 100)}`);
          NotificationService.emitConsoleLog(taskId, 'error', `   ❌ ${repo}: ${result.error?.substring(0, 80)}`);
        });

        console.log(`${'='.repeat(70)}\n`);

        return {
          success: false,
          error: errorMsg,
          data: {
            ...sandboxData,
            devServers: serverResults,
            failedServers: failedServers.map(([repo, r]) => ({
              repository: repo,
              error: r.error,
              logs: r.compilationLogs?.substring(0, 500),
            })),
          },
        };
      }

      // All servers started successfully - emit success event
      await eventStore.append({
        taskId,
        eventType: 'DevServersStarted',
        payload: {
          servers: serverResults,
          successCount,
          failedCount: 0,
          totalCount: totalServers,
        },
      });

      NotificationService.emitNotification(taskId, 'DevServersStarted', {
        servers: serverResults,
        successCount,
        failedCount: 0,
      });

      console.log(`✅ [SandboxPhase] COMPLETE`);
      console.log(`   🚀 Servers: ${successCount}/${totalServers} verified - ALL RUNNING`);
      console.log(`${'='.repeat(70)}\n`);

      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `✅ SandboxPhase complete - All ${successCount} server(s) running`
      );

      return {
        success: true,
        data: {
          ...sandboxData,
          devServers: serverResults,
        },
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
