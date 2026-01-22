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

import { Task, ITask } from '../../models/Task';
import { FailedExecution, FailureType } from '../../models/FailedExecution';
import { NotificationService } from '../NotificationService';
import { AgentActivityService } from '../AgentActivityService';
import { OrchestrationContext } from './Phase';
import { AgentModelConfig } from '../../config/ModelConfigurations';

// MCP Tools
import { createCustomToolsServer } from '../../tools/customTools';
import { createExtraToolsServer } from '../../tools/extraTools';
import { createExploratoryToolsServer } from '../../tools/exploratoryTools';
import { createAutonomousToolsServer } from '../../tools/autonomousTools';

// Smart Context & Memory
import { SmartContextInjector, AgentPhase } from '../SmartContextInjector';
import { AgentMemoryBridge } from '../AgentMemoryBridge';
import { granularMemoryService } from '../GranularMemoryService';

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
}

/**
 * Result from executeDeveloper
 */
export interface DeveloperExecutionResult {
  output?: string;
  cost?: number;
  sdkSessionId?: string;
  lastMessageUuid?: string;
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
    },
    contextOverride?: OrchestrationContext,
    skipOptimization?: boolean,
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    resumeOptions?: ResumeOptions
  ): Promise<AgentExecutionResult> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const { getAgentDefinition, getAgentDefinitionWithSpecialization, getAgentModel } = await import('./AgentDefinitions');

    // Get repository type from task or context for developer specialization
    let repositoryType: 'frontend' | 'backend' | 'unknown' = 'unknown';
    if (taskId && agentType === 'developer') {
      try {
        const task = await Task.findById(taskId).populate('projectId');
        if (task?.projectId) {
          const project = task.projectId as any;
          if (project.repositories && project.repositories.length > 0) {
            const types = project.repositories.map((r: any) => r.type).filter(Boolean);
            if (types.length === 0) {
              repositoryType = 'unknown';
            } else {
              const validType = types.find((t: string) => t === 'backend' || t === 'frontend');
              repositoryType = validType || 'unknown';
            }
          } else if (project.repository) {
            repositoryType = project.repository.type || 'unknown';
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

    // Model configuration - using ALL_OPUS_CONFIG (hardcoded)
    const configs = await import('../../config/ModelConfigurations');
    const modelConfig: AgentModelConfig = configs.ALL_OPUS_CONFIG;
    console.log(`🔥 [AgentExecutor] Using ALL_OPUS_CONFIG for agent: ${agentType}`);

    // Dynamic model routing or static config
    let model: string;
    let modelAlias: string;
    let thinkingBudget = 0;

    if (DynamicModelRouter.isEnabled() && !skipOptimization) {
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
      modelAlias = getAgentModel(agentType, modelConfig);
      model = configs.getExplicitModelId(modelAlias);
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

      const memoryBridge = AgentMemoryBridge.getInstance();
      await memoryBridge.initialize(workspacePath);

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

      // Granular memory from MongoDB
      if (taskId) {
        try {
          const taskDoc = await Task.findById(taskId).select('projectId').lean();
          if (taskDoc?.projectId) {
            const projectId = taskDoc.projectId.toString();

            const granularMemories = await granularMemoryService.getPhaseMemories({
              projectId,
              taskId,
              phaseType: phase,
              limit: 30,
            });

            if (granularMemories.length > 0) {
              smartContextBlock += granularMemoryService.formatForPrompt(
                granularMemories,
                'GRANULAR MEMORY (What you did before - USE THIS!)'
              );
            }

            const errorsToAvoid = await granularMemoryService.getErrorsToAvoid({ projectId, taskId, limit: 5 });
            if (errorsToAvoid.length > 0) {
              smartContextBlock += '\n\n🚫 ERRORS TO AVOID (from previous runs):\n';
              for (const err of errorsToAvoid) {
                smartContextBlock += `• ${err.title}\n`;
                if (err.error?.avoidanceRule) {
                  smartContextBlock += `  → ${err.error.avoidanceRule}\n`;
                }
              }
            }

            const patterns = await granularMemoryService.getPatternsAndConventions({ projectId, limit: 10 });
            if (patterns.length > 0) {
              smartContextBlock += '\n\n📏 PROJECT CONVENTIONS:\n';
              for (const p of patterns) {
                smartContextBlock += `• ${p.title}: ${p.content.substring(0, 200)}\n`;
              }
            }
          }
        } catch (memError: any) {
          console.warn(`⚠️ [AgentExecutor] Granular memory error: ${memError.message}`);
        }
      }

      // File-based memory
      const memories = memoryBridge.recallForPhase(phase, 8);
      if (memories.length > 0) {
        smartContextBlock += memoryBridge.formatForPrompt(memories, 'ADDITIONAL MEMORIES FROM FILE SYSTEM');
      }
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

    for (let sdkAttempt = 1; sdkAttempt <= MAX_SDK_RETRIES; sdkAttempt++) {
      try {
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
        const queryOptions: any = {
          cwd: workspacePath,
          model,
          permissionMode: effectivePermissionMode,
          env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
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

        const stream = query({ prompt: effectivePrompt as any, options: queryOptions });

        // Start execution tracking
        if (taskId) {
          ExecutionControlService.startExecution(taskId, agentType, 'executing');
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
                  }
                } else if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  const result = block.content || '';

                  if (taskId && toolUseId) {
                    const pendingCall = pendingToolCalls.get(toolUseId);
                    if (pendingCall) {
                      AgentActivityService.processToolResult(taskId, agentType, pendingCall.name, pendingCall.input, result);
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
                  AgentActivityService.processToolResult(taskId, agentType, pendingCall.name, pendingCall.input, result);

                  const isError = (message as any).is_error === true;
                  StreamingService.streamToolComplete(taskId, agentType, pendingCall.name, toolUseId, result, 0, !isError);

                  if (!isError && (pendingCall.name === 'Edit' || pendingCall.name === 'Write')) {
                    const filePath = pendingCall.input?.file_path || pendingCall.input?.path;
                    if (filePath) {
                      StreamingService.streamFileChange(taskId, agentType, filePath, pendingCall.name === 'Write' ? 'created' : 'modified');
                    }
                  }

                  if (pendingCall.name === 'Bash') {
                    StreamingService.streamCommandOutput(taskId, agentType, pendingCall.input?.command || '', {
                      stdout: typeof result === 'string' ? result : JSON.stringify(result),
                      exitCode: isError ? 1 : 0
                    });
                  }

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

            // Usage accumulation
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

        // Calculate cost
        const usage = accumulatedUsage.input_tokens > 0 || accumulatedUsage.output_tokens > 0
          ? accumulatedUsage
          : ((finalResult as any)?.usage || {});

        const inputTokens = usage.input_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
        const cacheReadTokens = usage.cache_read_input_tokens || 0;

        const { MODEL_PRICING } = await import('../../config/ModelConfigurations');
        const pricing = MODEL_PRICING[modelAlias as keyof typeof MODEL_PRICING];

        if (!pricing) {
          throw new Error(`No pricing found for model alias "${modelAlias}"`);
        }

        const inputPricePerMillion = pricing.inputPerMillion;
        const outputPricePerMillion = pricing.outputPerMillion;

        const inputCost = (inputTokens * inputPricePerMillion) / 1_000_000;
        const outputCost = (outputTokens * outputPricePerMillion) / 1_000_000;
        const cacheCreationCost = (cacheCreationTokens * inputPricePerMillion * 1.25) / 1_000_000;
        const cacheReadCost = (cacheReadTokens * inputPricePerMillion * 0.1) / 1_000_000;
        const cost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

        console.log(`💰 [AgentExecutor] ${agentType} cost: $${cost.toFixed(4)}`);

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
        };
      } catch (error: any) {
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
      const failedExecution = new FailedExecution({
        taskId: params.taskId,
        agentType: params.agentType,
        agentName: params.agentName,
        prompt: params.prompt.substring(0, 50000), // Limit prompt size
        workspacePath: params.workspacePath,
        model: params.model,
        permissionMode: params.permissionMode,
        error: {
          message: params.error.message,
          code: params.error.code,
          stack: params.error.stack?.substring(0, 5000),
          isTimeout: params.error.isTimeout || false,
          isLoopDetection: params.error.isLoopDetection || false,
          isHistoryOverflow: params.error.isHistoryOverflow || false,
          isUserAbort: params.error.isUserAbort || false,
        },
        diagnostics: params.diagnostics,
        failureType: this.classifyFailure(params.error),
        createdAt: new Date(),
      });

      await failedExecution.save();
      console.log(`💾 [AgentExecutor] Saved failed execution for retry: ${failedExecution._id}`);
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
