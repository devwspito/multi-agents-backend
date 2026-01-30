/**
 * AgentExecutorService
 *
 * Extracted from OrchestrationCoordinator to reduce file size.
 * This service handles the actual execution of Claude agents using the SDK.
 *
 * Main methods:
 * - executeAgent(): Generic agent execution with SDK
 * - executeDeveloper(): Specialized developer agent execution
 *
 * Following SDK best practices:
 * - Single query() call per agent action
 * - Context injection for all agents
 * - Cost tracking and usage accumulation
 * - Session management for resume capability
 */

import { TaskRepository, ITask } from '../../database/repositories/TaskRepository.js';
import { FailedExecutionRepository, FailureType } from '../../database/repositories/FailedExecutionRepository.js';
import { NotificationService } from '../NotificationService';
import { AgentActivityService } from '../AgentActivityService';
import { OrchestrationContext } from './Phase';
import { getExplicitModelId, calculateCost, ClaudeModel } from '../../config/ModelConfigurations';

// MCP Tools
import { createCustomToolsServer } from '../../tools/customTools';
import { createExtraToolsServer } from '../../tools/extraTools';
import { createExploratoryToolsServer } from '../../tools/exploratoryTools';
import { createAutonomousToolsServer } from '../../tools/autonomousTools';

// 🐳 Sandbox Service for Docker container execution
import { sandboxService } from '../SandboxService';
import { dockerBashHook, setDockerHookContext } from '../DockerBashHook';
import { setSandboxContext, clearSandboxContext } from '../../tools/categories/sandboxTools';

// Smart Context & Memory
import { SmartContextInjector, AgentPhase } from '../SmartContextInjector';
import { unifiedMemoryService } from '../UnifiedMemoryService';
// 🔥 REMOVED: AgentMemoryBridge, granularMemoryService - SQLite is single source of truth

// Autonomous Services
import { SessionService } from '../SessionService';
import { AgentHooksService } from '../AgentHooksService';
import { ExecutionControlService } from '../ExecutionControlService';
import { StreamingService } from '../StreamingService';

// Advanced AI Features
import { ExtendedThinkingService } from '../ExtendedThinkingService';
import { DynamicModelRouter } from '../DynamicModelRouter';

// Timeouts
import { AGENT_TIMEOUTS } from './constants/Timeouts';

// 🎯 Training Data: Granular execution tracking for ML training
import { executionTracker } from '../training/ExecutionTracker';

// 🔒 Security: Passive vulnerability detection (non-blocking)
import { securityAgentService } from '../security/SecurityAgentService';

/**
 * Parameters for saveFailedExecution
 */
interface SaveFailedExecutionParams {
  taskId?: string;
  agentType: string;
  agentName?: string;
  prompt: string;
  workspacePath: string;
  model: string;
  permissionMode: string;
  error: any;
  diagnostics: {
    messagesReceived: number;
    historyMessages: number;
    turnsCompleted: number;
    lastMessageTypes: string[];
    streamDurationMs: number;
  };
  context?: OrchestrationContext;
}

/**
 * Resume options for continuing from interrupted execution
 */
export interface ResumeOptions {
  resumeSessionId?: string;    // SDK session ID to resume from
  resumeAtMessage?: string;    // Specific message UUID to resume from
  isResume?: boolean;          // Flag indicating this is a resume
}

/**
 * Result from executeAgent
 */
export interface AgentExecutionResult {
  output: string;
  usage: any;
  cost: number;
  stopReason?: string;
  sessionId?: string;
  canResume: boolean;
  rawResult: any;
  allMessages: any[];
  executionDuration: number;
  sdkSessionId?: string;
  lastMessageUuid?: string;
  // 🔥 NEW: Granular tracking for recovery
  filesModified: string[];   // Files edited during execution (Edit tool)
  filesCreated: string[];    // Files created from scratch (Write tool)
  toolsUsed: string[];       // Tools used (Edit, Write, Bash, etc.)
  turnsCompleted: number;    // Number of SDK turns completed
}

/**
 * Result from executeDeveloper
 */
export interface DeveloperExecutionResult {
  output?: string;
  cost?: number;
  usage?: any;
  sdkSessionId?: string;
  lastMessageUuid?: string;
  // 🔥 NEW: Granular tracking for recovery
  filesModified?: string[];   // Files edited
  filesCreated?: string[];    // Files created from scratch
  toolsUsed?: string[];
  turnsCompleted?: number;
}

/**
 * Parameters for executeDeveloper method
 */
export interface ExecuteDeveloperParams {
  task: ITask;
  member: any;
  repositories: any[];
  workspacePath: string;
  workspaceStructure: string;
  attachments?: any[];
  stories?: any[];
  epics?: any[];
  judgeFeedback?: string;
  epicBranchName?: string;
  forceTopModel?: boolean;
  devAuth?: any;
  architectureBrief?: any;
  environmentCommands?: any;
  projectRadiographies?: Map<string, any>;
  resumeOptions?: ResumeOptions;
  // Function to get directives (passed from OrchestrationCoordinator)
  getDirectivesForAgent: (taskId: string, agentType: string) => Promise<string>;
}

export class AgentExecutorService {
  private static instance: AgentExecutorService;

  private constructor() {}

  public static getInstance(): AgentExecutorService {
    if (!AgentExecutorService.instance) {
      AgentExecutorService.instance = new AgentExecutorService();
    }
    return AgentExecutorService.instance;
  }

  /**
   * Execute an agent using the Claude SDK
   *
   * This is the main entry point for running any type of agent.
   * It handles:
   * - Model selection (dynamic routing or static config)
   * - Smart context injection
   * - Pre/post execution hooks
   * - Session management
   * - Cost tracking
   * - Loop detection
   * - Timeout management
   *
   * @param agentType - Type of agent (developer, tech-lead, judge, etc.)
   * @param prompt - The task prompt for the agent
   * @param workspacePath - Path to the workspace directory
   * @param taskId - Optional task ID for tracking
   * @param agentName - Optional display name for the agent
   * @param sessionId - Optional session ID for context persistence
   * @param fork - Whether to fork the session (unused)
   * @param attachments - Optional image attachments
   * @param options - Optional execution options (maxIterations, timeout)
   * @param contextOverride - Optional context override
   * @param skipOptimization - Skip budget optimization (for retries)
   * @param permissionMode - SDK permission mode
   * @param resumeOptions - Options for resuming from interrupted execution
   */
  public async executeAgent(
    agentType: string,
    prompt: string,
    workspacePath: string,
    taskId?: string,
    _agentName?: string,
    sessionId?: string,
    _fork?: boolean,
    attachments?: any[],
    _options?: {
      maxIterations?: number;
      timeout?: number;
      sandboxId?: string;  // 🐳 Explicit sandbox ID for Docker execution
      model?: 'opus' | 'sonnet' | 'haiku';  // 🎯 Explicit model override (for Lite Team)
    },
    contextOverride?: OrchestrationContext,
    skipOptimization?: boolean,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    resumeOptions?: ResumeOptions
  ): Promise<AgentExecutionResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { getAgentDefinition, getAgentDefinitionWithSpecialization } = await import('./AgentDefinitions');

    // Get repository type from task or context for developer specialization
    let repositoryType: 'frontend' | 'backend' | 'unknown' = 'unknown';
    if (taskId && agentType === 'developer') {
      try {
        const task = TaskRepository.findById(taskId);
        if (task?.projectId) {
          const { ProjectRepository } = await import('../../database/repositories/ProjectRepository.js');
          const project = ProjectRepository.findById(task.projectId);
          if (project?.type) {
            repositoryType = project.type === 'frontend' || project.type === 'backend' ? project.type : 'unknown';
          }
        }
      } catch (error: any) {
        console.warn(`[AgentExecutorService] Failed to get repository type: ${error.message}`);
      }
    }

    // Get agent configuration with specialization
    const needsSpecialization = agentType === 'developer';
    const agentDef = needsSpecialization
      ? getAgentDefinitionWithSpecialization(agentType, repositoryType)
      : getAgentDefinition(agentType);

    if (!agentDef) {
      throw new Error(`Agent type "${agentType}" not found in agent definitions`);
    }

    // Model selection logic
    let model: string;
    let modelAlias: string = 'opus';
    let thinkingBudget = 0;

    // 🎯 EXPLICIT MODEL OVERRIDE (for Lite Team user selection)
    if (_options?.model) {
      modelAlias = _options.model;
      model = getExplicitModelId(modelAlias);
      AgentActivityService.emitMessage(taskId || '', agentType, `🎯 Model: ${modelAlias.toUpperCase()} (user selected)`);
    } else if (DynamicModelRouter.isEnabled() && !skipOptimization) {
      const modelSelection = DynamicModelRouter.selectModel(taskId, agentType, prompt, { forceTopModel: skipOptimization });
      model = modelSelection.modelId;
      modelAlias = modelSelection.tier;

      const routingMsg = `🎯 Model: ${modelSelection.tier.toUpperCase()} | Complexity: ${(modelSelection.complexity * 100).toFixed(0)}% | ${modelSelection.reason}`;
      AgentActivityService.emitMessage(taskId || '', agentType, routingMsg);

      thinkingBudget = ExtendedThinkingService.getThinkingBudget(taskId, agentType, prompt, {});
      if (thinkingBudget > 0) {
        AgentActivityService.emitMessage(taskId || '', agentType, `🧠 Extended Thinking: ${thinkingBudget.toLocaleString()} token budget`);
      }
    } else {
      // Default: All agents use OPUS
      modelAlias = 'opus';
      model = getExplicitModelId(modelAlias);
    }

    // Validate workspacePath
    if (typeof workspacePath !== 'string') {
      throw new Error(`CRITICAL: workspacePath must be a string, received ${typeof workspacePath}`);
    }

    AgentActivityService.emitMessage(taskId || '', agentType, `🤖 Starting ${agentType}`);
    NotificationService.emitConsoleLog(taskId || '', 'info', `[AgentExecutor] Starting ${agentType} | Model: ${modelAlias}`);

    // Pre-execution hooks
    const executionStartTime = Date.now();
    try {
      const preHookResult = await AgentHooksService.runPreExecutionHooks({
        agentType,
        taskId: taskId || 'unknown',
        workspacePath,
        prompt: prompt.substring(0, 500),
      });

      if (preHookResult.blocked) {
        throw new Error(`Agent blocked by pre-execution hook: ${preHookResult.reason}`);
      }
    } catch (hookError: any) {
      if (hookError.message?.includes('blocked by pre-execution')) {
        throw hookError;
      }
      console.warn(`⚠️ [AgentExecutor] Pre-hook error (non-critical): ${hookError.message}`);
    }

    // Session context
    let sessionContext: any = {};
    if (sessionId && taskId) {
      try {
        const existingSession = await SessionService.getSession(sessionId);
        if (existingSession?.context) {
          sessionContext = existingSession.context;
        }
      } catch (sessionError: any) {
        console.warn(`⚠️ [AgentExecutor] Session load error: ${sessionError.message}`);
      }
    }

    // Smart context injection
    let smartContextBlock = '';
    try {
      const contextInjector = SmartContextInjector.getInstance();
      await contextInjector.initialize(workspacePath);

      // 🔥 REMOVED: AgentMemoryBridge - SQLite is single source of truth

      const phaseMapping: Record<string, AgentPhase> = {
        'planning-agent': 'planning-agent',
        'tech-lead': 'tech-lead',
        'developer': 'developer',
        'judge': 'judge',
        'verification-fixer': 'verification-fixer',
        'recovery-analyst': 'recovery-analyst',
        'auto-merge': 'auto-merge'
      };

      const phase = phaseMapping[agentType] || 'developer';
      const injectedContext = await contextInjector.generateContext({
        phase,
        taskDescription: prompt.substring(0, 500),
        workspacePath,
        focusAreas: []
      });

      smartContextBlock = injectedContext.formattedContext;

      // 🔥 DISK PERSISTENCE REMOVED - SQLite is the single source of truth
      // All memory is now in task.orchestration (SQLite) via UnifiedMemoryService
    } catch (contextError) {
      console.warn(`⚠️ [AgentExecutor] Smart context generation failed:`, contextError);
    }

    // Build prompt content
    let promptContent: string | AsyncGenerator;

    if (attachments && attachments.length > 0) {
      const content: any[] = [
        { type: 'text', text: `${agentDef.prompt}\n\n${smartContextBlock}\n\n${prompt}` }
      ];

      for (const attachment of attachments) {
        if (attachment.type === 'image' && attachment.source) {
          content.push({ type: 'image', source: attachment.source });
        }
      }

      promptContent = (async function*() {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content }
        };
      })();
    } else {
      promptContent = `${agentDef.prompt}\n\n${smartContextBlock}\n\n${prompt}`;
    }

    // SDK retry mechanism
    const MAX_SDK_RETRIES = 3;
    let lastError: any = null;
    let sandboxContextConfigured = false; // 🐳 Moved outside try for scope in catch

    for (let sdkAttempt = 1; sdkAttempt <= MAX_SDK_RETRIES; sdkAttempt++) {
      try {
        // Reset sandbox context for each retry attempt
        sandboxContextConfigured = false;
        if (sdkAttempt > 1) {
          console.log(`\n🔄 [AgentExecutor] SDK RETRY attempt ${sdkAttempt}/${MAX_SDK_RETRIES}`);
          const delay = Math.min(5000 * Math.pow(2, sdkAttempt - 2), 30000);
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        // Get API key
        let apiKey: string | undefined = process.env.ANTHROPIC_API_KEY;
        if (taskId && contextOverride) {
          const contextApiKey = contextOverride.getData('anthropicApiKey') as string | undefined;
          if (contextApiKey) {
            apiKey = contextApiKey;
          }
        }

        if (!apiKey) {
          throw new Error('No Anthropic API key available for agent execution.');
        }

        // Permission mode
        const effectivePermissionMode = permissionMode || 'bypassPermissions';

        // Create MCP servers
        const customToolsServer = createCustomToolsServer();
        const extraToolsServer = createExtraToolsServer();
        const exploratoryToolsServer = createExploratoryToolsServer();
        const autonomousToolsServer = createAutonomousToolsServer();

        // Build query options
        const baseEnv = { ...process.env, ANTHROPIC_API_KEY: apiKey };

        const queryOptions: any = {
          cwd: workspacePath,
          model,
          permissionMode: effectivePermissionMode,
          env: baseEnv,
          mcpServers: {
            'custom-dev-tools': customToolsServer,
            'extra-tools': extraToolsServer,
            'exploratory-tools': exploratoryToolsServer,
            'autonomous-tools': autonomousToolsServer,
          },
        };

        // Session resume
        if (resumeOptions?.isResume && resumeOptions?.resumeSessionId) {
          queryOptions.resume = resumeOptions.resumeSessionId;
          if (resumeOptions.resumeAtMessage) {
            queryOptions.resumeSessionAt = resumeOptions.resumeAtMessage;
          }
        }

        // Extended thinking
        if (thinkingBudget > 0) {
          queryOptions.maxThinkingTokens = thinkingBudget;
        }

        const effectivePrompt = (resumeOptions?.isResume && resumeOptions?.resumeSessionId)
          ? 'Continue your work from where you left off. Complete any remaining tasks.'
          : promptContent;

        // 🐳 DOCKER BASH HOOK: Intercept Bash commands and redirect to Docker
        // This is the official SDK hook approach - transparent to the agent
        if (taskId) {
          let containerName: string | null = null;
          const explicitSandboxId = _options?.sandboxId;

          // 🔥 FIX: Extract repoName EARLY so it's available for context setting
          // workspacePath format: /path/to/workspace/repo-name
          const repoName = workspacePath.split('/').pop() || '';

          // 1️⃣ PRIORITY: Use explicit sandboxId if provided
          if (explicitSandboxId) {
            const explicitSandbox = sandboxService.getSandbox(explicitSandboxId);
            if (explicitSandbox && explicitSandbox.status === 'running') {
              containerName = explicitSandbox.containerName;
              sandboxContextConfigured = true;
              console.log(`🐳 [AgentExecutor] Using explicit sandbox ${explicitSandboxId}: ${containerName}`);
            } else {
              console.warn(`⚠️ [AgentExecutor] Explicit sandbox ${explicitSandboxId} not found or not running`);
            }
          }

          // 2️⃣ FALLBACK: Try to find sandbox for this task
          if (!containerName) {
            const existingSandbox = sandboxService.getSandbox(taskId);
            if (existingSandbox && existingSandbox.status === 'running') {
              containerName = existingSandbox.containerName;
              sandboxContextConfigured = true;
              console.log(`🐳 [AgentExecutor] Found task sandbox for ${agentType}: ${containerName}`);
            }
          }

          // 3️⃣ FALLBACK: Try sandbox ID pattern taskId-setup-repoName
          if (!containerName) {
            // sandboxId format: taskId-setup-repo-name
            const expectedSandboxId = repoName ? `${taskId}-setup-${repoName}` : null;

            if (expectedSandboxId) {
              const exactSandbox = sandboxService.getSandbox(expectedSandboxId);
              if (exactSandbox && exactSandbox.status === 'running') {
                containerName = exactSandbox.containerName;
                sandboxContextConfigured = true;
                console.log(`🐳 [AgentExecutor] Found sandbox for repo ${repoName}: ${containerName}`);
              }
            }
          }

          // 4️⃣ LAST FALLBACK: Find any running setup sandbox for this task
          if (!containerName) {
            const allSandboxes = sandboxService.getAllSandboxes();
            for (const [sandboxId, sandbox] of allSandboxes) {
              if (sandboxId.startsWith(`${taskId}-setup-`) && sandbox.status === 'running') {
                containerName = sandbox.containerName;
                sandboxContextConfigured = true;
                console.log(`🐳 [AgentExecutor] Using fallback sandbox for ${agentType}: ${containerName}`);
                break;
              }
            }
          }

          if (containerName) {
            // 🔥 FIX: Use /workspace/${repoName} NOT /workspace
            // Repos are cloned to /workspace/<repoName>/ inside container
            const containerWorkDir = repoName ? `/workspace/${repoName}` : '/workspace';

            // Set context for the Docker hook (for Bash tool interception)
            setDockerHookContext({
              taskId,
              containerName,
              workspacePath: containerWorkDir,
            });

            // 🔧 FIX: Also set context for sandbox_bash tool (uses different context)
            setSandboxContext({
              taskId,
              sandboxId: taskId,  // sandbox_bash uses taskId to find sandbox
              workspacePath: containerWorkDir,
              repoName,  // 🔥 Pass repoName for defaultWorkDir calculation
            });

            // Add PreToolUse hook to intercept Bash commands
            queryOptions.hooks = dockerBashHook.createHooksConfig(taskId);
            console.log(`🐳 [AgentExecutor] Docker Bash hook configured - commands will be redirected to container`);
          } else if (sandboxService.isDockerAvailable()) {
            console.log(`⚠️ [AgentExecutor] No sandbox found for ${agentType}, commands will run on host`);
          }
        }

        const stream = query({ prompt: effectivePrompt as any, options: queryOptions });

        // Start execution tracking
        if (taskId) {
          ExecutionControlService.startExecution(taskId, agentType, 'executing');

          // 🎯 Training Data: Start granular execution tracking
          executionTracker.startExecution({
            taskId,
            agentType,
            modelId: model,
            phaseName: agentType, // Phase name = agent type for now
            prompt: typeof promptContent === 'string' ? promptContent : prompt,
            workspacePath,
            sessionId,
          });
        }

        // Start streaming
        let streamId: string | null = null;
        if (taskId) {
          streamId = StreamingService.startStream(taskId, agentType);
        }

        // Stream consumption
        let finalResult: any = null;
        const allMessages: any[] = [];
        let turnCount = 0;
        let messagesWithoutToolUse = 0;
        const MAX_MESSAGES_WITHOUT_TOOL_USE = 100;
        let agentStarted = false;
        const pendingToolCalls = new Map<string, { name: string; input: any }>();
        let historyMessagesReceived = 0;

        // 🔥 NEW: Granular tracking for recovery
        const filesModifiedSet = new Set<string>();  // Files edited (Edit tool)
        const filesCreatedSet = new Set<string>();   // Files created (Write tool)
        const toolsUsedSet = new Set<string>();      // Unique tools used

        // Token accumulation for cost calculation
        const accumulatedUsage = {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        };

        const MAX_HISTORY_MESSAGES = 200;
        const startTime = Date.now();

        let sdkSessionId: string | undefined;
        let lastMessageUuid: string | undefined;

        // Watchdog timer
        const MESSAGE_TIMEOUT_MS = 10 * 60 * 1000;
        const TOTAL_TIMEOUT_MS = AGENT_TIMEOUTS.TOTAL_MAX;
        let lastMessageTime = Date.now();
        let watchdogTriggered = false;
        let totalTimeoutTriggered = false;

        const watchdogInterval = setInterval(() => {
          const timeSinceLastMessage = Date.now() - lastMessageTime;
          const totalElapsed = Date.now() - startTime;

          if (timeSinceLastMessage > MESSAGE_TIMEOUT_MS) {
            watchdogTriggered = true;
          }

          if (totalElapsed > TOTAL_TIMEOUT_MS && !totalTimeoutTriggered) {
            totalTimeoutTriggered = true;
          }
        }, 30000);

        try {
          for await (const message of stream) {
            lastMessageTime = Date.now();

            if (watchdogTriggered) {
              const error = new Error(`Agent ${agentType} stream timeout - watchdog triggered`);
              (error as any).isTimeout = true;
              throw error;
            }

            if (totalTimeoutTriggered) {
              const error = new Error(`Agent ${agentType} exceeded maximum execution time`);
              (error as any).isTimeout = true;
              throw error;
            }

            // Mid-execution intervention
            if (taskId) {
              if (ExecutionControlService.shouldAbort(taskId)) {
                const error = new Error(`Agent ${agentType} aborted by supervisor/user`);
                (error as any).isUserAbort = true;
                throw error;
              }

              if (ExecutionControlService.shouldPause(taskId)) {
                await ExecutionControlService.waitForResume(taskId);
                if (ExecutionControlService.shouldAbort(taskId)) {
                  const error = new Error(`Agent ${agentType} aborted after pause`);
                  (error as any).isUserAbort = true;
                  throw error;
                }
              }

              ExecutionControlService.updateState(taskId, { turnCount });
            }

            allMessages.push(message);

            // Session capture
            const msgSessionId = (message as any).session_id;
            const msgUuid = (message as any).uuid;
            if (msgSessionId && !sdkSessionId) {
              sdkSessionId = msgSessionId;
            }
            if (msgUuid) {
              lastMessageUuid = msgUuid;
            }

            const messageType = (message as any).type;
            const messageContent = (message as any).message?.content || [];

            // Process tool activity
            if (Array.isArray(messageContent)) {
              for (const block of messageContent) {
                if (block.type === 'tool_use') {
                  const tool = block.name || 'unknown';
                  const input = block.input || {};
                  const toolId = block.id;

                  if (toolId) {
                    pendingToolCalls.set(toolId, { name: tool, input });
                  }

                  if (taskId) {
                    AgentActivityService.emitToolUse(taskId, agentType, tool, input);
                    // 🎯 Training Data: Track tool call start
                    if (toolId) {
                      executionTracker.startToolCall(taskId, {
                        toolName: tool,
                        toolUseId: toolId,
                        toolInput: input,
                      });
                    }
                  }
                } else if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  const result = block.content || '';

                  if (taskId && toolUseId) {
                    const pendingCall = pendingToolCalls.get(toolUseId);
                    if (pendingCall) {
                      AgentActivityService.processToolResult(taskId, agentType, pendingCall.name, pendingCall.input, result);
                      // 🎯 Training Data: Track tool call completion
                      executionTracker.completeToolCall(taskId, {
                        toolUseId,
                        toolOutput: typeof result === 'string' ? result : JSON.stringify(result),
                        toolSuccess: true,
                      });
                      pendingToolCalls.delete(toolUseId);
                    }
                  }
                }
              }
            }

            const hasToolActivity =
              messageType === 'result' ||
              messageType === 'turn_start' ||
              (Array.isArray(messageContent) && messageContent.some((block: any) =>
                block.type === 'tool_use' || block.type === 'tool_result'
              ));

            if (messageType === 'turn_start') {
              if (!agentStarted) {
                agentStarted = true;
              }
              // 🎯 Training Data: Track turn start
              if (taskId) {
                executionTracker.startTurn(taskId, 'assistant');
              }
            }

            if (!agentStarted) {
              historyMessagesReceived++;
              if (historyMessagesReceived >= MAX_HISTORY_MESSAGES) {
                const error = new Error(`Agent ${agentType} failed to start: ${historyMessagesReceived} messages without turn_start`);
                (error as any).isHistoryOverflow = true;
                throw error;
              }
              continue;
            }

            if (hasToolActivity) {
              messagesWithoutToolUse = 0;
            } else {
              messagesWithoutToolUse++;
              if (messagesWithoutToolUse >= MAX_MESSAGES_WITHOUT_TOOL_USE) {
                const loopError = new Error(`Agent ${agentType} stuck in loop: ${messagesWithoutToolUse} messages without tool activity`);
                (loopError as any).isLoopDetection = true;
                (loopError as any).isNonRetryable = true;
                throw loopError;
              }
            }

            if ((message as any).type === 'turn_start') {
              turnCount++;
              if (taskId) {
                NotificationService.emitConsoleLog(taskId, 'info', `🔄 Turn ${turnCount} - Agent working...`);
              }
            }

            // Tool use logging
            if ((message as any).type === 'tool_use') {
              const tool = (message as any).name || 'unknown';
              const input = (message as any).input || {};
              const toolId = (message as any).id;

              if (toolId) {
                pendingToolCalls.set(toolId, { name: tool, input });
              }

              if (taskId) {
                AgentActivityService.emitToolUse(taskId, agentType, tool, input);
                StreamingService.streamToolStart(taskId, agentType, tool, toolId || 'unknown', input);
              }
            }

            // Tool result logging
            if ((message as any).type === 'tool_result') {
              const result = (message as any).content || (message as any).result || '';
              const toolUseId = (message as any).tool_use_id;

              if (taskId && toolUseId) {
                const pendingCall = pendingToolCalls.get(toolUseId);
                if (pendingCall) {
                  // 🔥 TRACK: Add tool to used set
                  toolsUsedSet.add(pendingCall.name);

                  AgentActivityService.processToolResult(taskId, agentType, pendingCall.name, pendingCall.input, result);

                  const isError = (message as any).is_error === true;
                  StreamingService.streamToolComplete(taskId, agentType, pendingCall.name, toolUseId, result, 0, !isError);

                  // 🎯 Training Data: Track tool call completion with full details
                  const bashExitCode = pendingCall.name === 'Bash' ? (isError ? 1 : 0) : undefined;
                  executionTracker.completeToolCall(taskId, {
                    toolUseId,
                    toolOutput: typeof result === 'string' ? result : JSON.stringify(result),
                    toolSuccess: !isError,
                    toolError: isError ? (typeof result === 'string' ? result : 'Tool execution failed') : undefined,
                    bashExitCode,
                  });

                  // 🔥 TRACK: Separate created vs modified files
                  if (!isError) {
                    const filePath = pendingCall.input?.file_path || pendingCall.input?.path || pendingCall.input?.notebook_path;
                    if (filePath) {
                      if (pendingCall.name === 'Write') {
                        // New file created from scratch
                        filesCreatedSet.add(filePath);
                        StreamingService.streamFileChange(taskId, agentType, filePath, 'created');
                      } else if (pendingCall.name === 'Edit' || pendingCall.name === 'NotebookEdit') {
                        // Existing file modified
                        filesModifiedSet.add(filePath);
                        StreamingService.streamFileChange(taskId, agentType, filePath, 'modified');
                      }
                    }
                  }

                  if (pendingCall.name === 'Bash') {
                    StreamingService.streamCommandOutput(taskId, agentType, pendingCall.input?.command || '', {
                      stdout: typeof result === 'string' ? result : JSON.stringify(result),
                      exitCode: isError ? 1 : 0
                    });
                  }

                  // 🔒 Security: Analyze tool result for vulnerabilities (non-blocking)
                  securityAgentService.analyzeToolResult({
                    taskId,
                    executionId: executionTracker.getExecutionId(taskId) || undefined,
                    toolCallId: toolUseId,
                    toolName: pendingCall.name,
                    toolInput: pendingCall.input,
                    toolOutput: typeof result === 'string' ? result : JSON.stringify(result),
                    toolSuccess: !isError,
                    agentType,
                    phaseName: agentType,
                  });

                  pendingToolCalls.delete(toolUseId);
                }
              }
            }

            // Text streaming
            if ((message as any).type === 'text') {
              const text = (message as any).text || '';
              if (text.length > 0 && streamId) {
                StreamingService.streamToken(streamId, text);
              }
            }

            // Content block streaming
            if (Array.isArray(messageContent)) {
              for (const block of messageContent) {
                if (block.type === 'text' && block.text && streamId) {
                  StreamingService.streamToken(streamId, block.text);
                }
              }
            }

            // Cost tracking is done at the end using accumulated tokens
            // SDK doesn't emit system messages with cost - we calculate from tokens

            // Usage accumulation (kept for logging, not used for cost calculation)
            const msgUsage = (message as any).usage || (message as any).message?.usage || (message as any).data?.usage;
            if (msgUsage) {
              if (msgUsage.input_tokens) accumulatedUsage.input_tokens += msgUsage.input_tokens;
              if (msgUsage.output_tokens) accumulatedUsage.output_tokens += msgUsage.output_tokens;
              if (msgUsage.cache_creation_input_tokens) accumulatedUsage.cache_creation_input_tokens += msgUsage.cache_creation_input_tokens;
              if (msgUsage.cache_read_input_tokens) accumulatedUsage.cache_read_input_tokens += msgUsage.cache_read_input_tokens;
            }

            if (message.type === 'result') {
              finalResult = message;

              if (streamId) {
                StreamingService.endStream(streamId);
              }
            }
          }
        } catch (streamError: any) {
          if (streamId) {
            StreamingService.endStream(streamId);
          }
          clearInterval(watchdogInterval);

          if (taskId) {
            ExecutionControlService.endExecution(taskId);

            // 🎯 Training Data: Track execution failure
            const errorType = streamError.isTimeout ? 'timeout' :
              streamError.isLoopDetection ? 'loop_detection' :
              streamError.isHistoryOverflow ? 'history_overflow' :
              streamError.isUserAbort ? 'user_abort' : 'stream_error';
            executionTracker.failExecution(taskId, streamError.message || 'Stream error', errorType);
          }

          if (streamError.isLoopDetection || streamError.isNonRetryable) {
            throw streamError;
          }

          // Save failed execution
          await this.saveFailedExecution({
            taskId,
            agentType,
            agentName: _agentName,
            prompt: typeof promptContent === 'string' ? promptContent : prompt,
            workspacePath,
            model,
            permissionMode: effectivePermissionMode,
            error: streamError,
            diagnostics: {
              messagesReceived: allMessages.length,
              historyMessages: historyMessagesReceived,
              turnsCompleted: turnCount,
              lastMessageTypes: allMessages.slice(-20).map(m => (m as any).type),
              streamDurationMs: Date.now() - startTime,
            },
            context: contextOverride,
          });

          throw streamError;
        }

        clearInterval(watchdogInterval);

        if (taskId) {
          ExecutionControlService.endExecution(taskId);
        }

        // Extract output
        const output = this.extractOutputText(finalResult, allMessages) || '';

        // 🔥 FIX: Calculate REAL cost from accumulated tokens
        // The SDK doesn't emit system messages with cost, so we calculate from tokens
        const inputTokens = accumulatedUsage.input_tokens;
        const outputTokens = accumulatedUsage.output_tokens;

        // Also check finalResult.usage in case we missed some tokens
        const finalUsage = (finalResult as any)?.usage;
        const totalInputTokens = Math.max(inputTokens, finalUsage?.input_tokens || 0);
        const totalOutputTokens = Math.max(outputTokens, finalUsage?.output_tokens || 0);

        // Calculate cost from tokens using actual model pricing
        const cost = calculateCost(modelAlias as ClaudeModel, totalInputTokens, totalOutputTokens);

        console.log(`💰 [AgentExecutor] ${agentType} COST: $${cost.toFixed(4)} (calculated from ${totalInputTokens.toLocaleString()} in + ${totalOutputTokens.toLocaleString()} out tokens)`);
        console.log(`   📊 Model: ${modelAlias} | Pricing: input=$${modelAlias === 'opus' ? '15' : '3'}/M, output=$${modelAlias === 'opus' ? '75' : '15'}/M`);

        // 🔥 SAVE REAL COST TO SQLite
        if (taskId && (cost > 0 || totalInputTokens > 0)) {
          unifiedMemoryService.addCost(taskId, cost, totalInputTokens + totalOutputTokens);
          console.log(`   💾 Cost saved: $${cost.toFixed(4)}`);
        }

        // Post-execution hooks
        const executionDuration = Date.now() - executionStartTime;
        try {
          await AgentHooksService.runPostExecutionHooks({
            agentType,
            taskId: taskId || 'unknown',
            workspacePath,
            success: true,
            output: output.substring(0, 1000),
            duration: executionDuration,
            cost,
            tokens: inputTokens + outputTokens,
          });
        } catch (postHookError: any) {
          console.warn(`⚠️ [AgentExecutor] Post-hook error: ${postHookError.message}`);
        }

        // Save session
        if (sessionId && taskId) {
          try {
            await SessionService.updateContext(sessionId, {
              lastAgentType: agentType,
              lastOutput: output.substring(0, 2000),
              lastCost: cost,
              lastTokens: inputTokens + outputTokens,
              totalExecutions: (sessionContext.totalExecutions || 0) + 1,
              totalCost: (sessionContext.totalCost || 0) + cost,
              updatedAt: new Date().toISOString(),
            });
          } catch (sessionSaveError: any) {
            console.warn(`⚠️ [AgentExecutor] Session save error: ${sessionSaveError.message}`);
          }
        }

        // Record statistics
        AgentHooksService.recordExecution({
          agentType,
          duration: executionDuration,
          success: true,
          cost,
          tokens: inputTokens + outputTokens,
        });

        // 🐳 CLEANUP: Clear Docker hook context after successful execution
        if (sandboxContextConfigured) {
          setDockerHookContext(null);
          clearSandboxContext();  // 🔧 FIX: Also clear sandbox_bash context
          console.log(`🐳 [AgentExecutor] Docker hook context cleared for ${agentType}`);
        }

        // 🎯 Training Data: Complete execution tracking with final stats
        if (taskId) {
          executionTracker.completeExecution(taskId, {
            finalOutput: output.substring(0, 50000), // Limit size
            inputTokens: accumulatedUsage.input_tokens,
            outputTokens: accumulatedUsage.output_tokens,
            cacheReadTokens: accumulatedUsage.cache_read_input_tokens,
            cacheCreationTokens: accumulatedUsage.cache_creation_input_tokens,
            costUsd: cost,
          });
        }

        return {
          output,
          usage: (finalResult as any)?.usage || {},
          cost,
          stopReason: (finalResult as any)?.stop_reason,
          sessionId,
          canResume: !!sdkSessionId,
          rawResult: finalResult,
          allMessages,
          executionDuration,
          sdkSessionId,
          lastMessageUuid,
          // 🔥 NEW: Granular tracking for recovery
          filesModified: Array.from(filesModifiedSet),
          filesCreated: Array.from(filesCreatedSet),
          toolsUsed: Array.from(toolsUsedSet),
          turnsCompleted: turnCount,
        };
      } catch (error: any) {
        // 🐳 CLEANUP: Clear Docker hook context on error
        if (sandboxContextConfigured) {
          setDockerHookContext(null);
          clearSandboxContext();  // 🔧 FIX: Also clear sandbox_bash context
        }

        console.error(`❌ [AgentExecutor] ${agentType} failed (attempt ${sdkAttempt}/${MAX_SDK_RETRIES}):`, error.message);

        lastError = error;

        if (error.isNonRetryable || error.isLoopDetection) {
          throw error;
        }

        const isRetryableError = (
          error.message?.includes('Unterminated string in JSON') ||
          error.message?.includes('JSON') ||
          error.message?.includes('ECONNRESET') ||
          error.message?.includes('ETIMEDOUT') ||
          error.message?.includes('socket hang up') ||
          error.constructor.name === 'SyntaxError'
        );

        if (isRetryableError && sdkAttempt < MAX_SDK_RETRIES) {
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error(`${agentType} failed after ${MAX_SDK_RETRIES} attempts`);
  }

  /**
   * Extract text output from SDK query result
   */
  private extractOutputText(result: any, allMessages?: any[]): string {
    const outputs: string[] = [];

    // Strategy 1: Extract from finalResult.content
    if (result?.content && Array.isArray(result.content)) {
      const textBlocks = result.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text);

      if (textBlocks.length > 0) {
        outputs.push(...textBlocks);
      }
    }

    // Strategy 2: Search all messages for assistant responses
    if (allMessages && allMessages.length > 0) {
      for (const msg of allMessages) {
        if (msg?.message?.role === 'assistant' && msg?.message?.content) {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            const textBlocks = content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text);

            if (textBlocks.length > 0) {
              outputs.push(...textBlocks);
            }
          }
        }

        if (msg?.content && Array.isArray(msg.content)) {
          const textBlocks = msg.content
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text);

          if (textBlocks.length > 0) {
            outputs.push(...textBlocks);
          }
        }
      }
    }

    // Strategy 3: Fallback
    if (outputs.length === 0 && result) {
      if (typeof result.text === 'string') {
        outputs.push(result.text);
      }
      if (typeof result.output === 'string') {
        outputs.push(result.output);
      }
    }

    return outputs.join('\n\n').trim();
  }

  /**
   * Save failed execution for later retry
   */
  private async saveFailedExecution(params: SaveFailedExecutionParams): Promise<void> {
    try {
      const failedExecution = FailedExecutionRepository.create({
        taskId: params.taskId || '',
        agentType: params.agentType,
        agentName: params.agentName,
        prompt: params.prompt.substring(0, 50000), // Limit prompt size
        workspacePath: params.workspacePath,
        modelId: params.model || '',
        permissionMode: params.permissionMode,
        failureType: this.classifyFailure(params.error),
        errorMessage: params.error.message || 'Unknown error',
        errorStack: params.error.stack?.substring(0, 5000),
        messagesReceived: params.diagnostics?.messagesReceived || 0,
        historyMessages: params.diagnostics?.historyMessages || 0,
        turnsCompleted: params.diagnostics?.turnsCompleted || 0,
        lastMessageTypes: params.diagnostics?.lastMessageTypes || [],
        streamDurationMs: params.diagnostics?.streamDurationMs || 0,
      });

      console.log(`💾 [AgentExecutor] Saved failed execution for retry: ${failedExecution.id}`);
    } catch (saveError: any) {
      console.error(`❌ [AgentExecutor] Failed to save execution for retry: ${saveError.message}`);
    }
  }

  /**
   * Classify failure type for analytics
   */
  private classifyFailure(error: any): FailureType {
    if (error.isTimeout) return 'timeout';
    if (error.isLoopDetection) return 'loop_detection';
    if (error.isHistoryOverflow) return 'history_overflow';
    if (error.message?.includes('JSON')) return 'sdk_error';
    if (error.message?.includes('ECONNRESET')) return 'api_error';
    return 'unknown';
  }
}

// Export singleton instance
export const agentExecutorService = AgentExecutorService.getInstance();
