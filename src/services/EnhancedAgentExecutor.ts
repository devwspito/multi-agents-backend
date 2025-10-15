/**
 * Enhanced Agent Executor
 *
 * Sigue EXACTAMENTE la documentación oficial del Claude Agent SDK
 * Captura TODO en tiempo real
 */

import { query, Options } from '@anthropic-ai/claude-agent-sdk';
import { NotificationService } from './NotificationService';
import RealTimeLogger from './RealTimeLogger';
import { AnalyticsService } from './AnalyticsService';
import { AgentType } from '../models/Task';
import { createCustomToolsServer } from '../tools/customTools';
import productivityMonitor from './ProductivityMonitor';

interface ExecutionResult {
  output: string;
  usage: any;
  cost: number;
  sessionId: string;
  todos?: any[];
  canResume: boolean;
  allContent: string[]; // TODO el contenido capturado
}

interface ToolUse {
  name: string;
  input: any;
  id: string;
}

interface ImageAttachment {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data?: string; // For base64
    url?: string;  // For URL
  };
}

class EnhancedAgentExecutor {
  private analyticsService: AnalyticsService;

  constructor() {
    this.analyticsService = new AnalyticsService();
  }

  /**
   * Execute an agent following SDK best practices
   * Captures EVERYTHING in real-time
   */
  async executeAgent(
    agentType: AgentType,
    prompt: string | any[], // String or array of content blocks (for images)
    workDir: string,
    taskId: string,
    agentName: string,
    options?: {
      resumeSessionId?: string;
      forkSession?: boolean;
      attachments?: ImageAttachment[]; // Image attachments
      // 🔥 Productivity monitoring options (from Tech Lead)
      maxReadsAllowed?: number;
      expectedFiles?: string[];
    }
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    console.log(`\n🚀 [${agentName}] Starting execution...`);

    // 🚨 INICIAR MONITOREO DE PRODUCTIVIDAD (Solo para developers)
    const isDeveloper = agentType === 'developer';
    if (isDeveloper) {
      productivityMonitor.startMonitoring(taskId, agentType, {
        maxReadsAllowed: options?.maxReadsAllowed,
        expectedFiles: options?.expectedFiles,
      });
      console.log(`🔍 [ProductivityMonitor] Monitoring enabled for ${agentName}`);
    }

    // Log the initial prompt
    const promptPreview = typeof prompt === 'string' ? prompt.substring(0, 200) : '[Content blocks with images]';
    RealTimeLogger.logDecision(taskId, agentName, 'Starting execution', promptPreview);

    // 🔥 FIX: Asegurar que el workDir sea el correcto y contenga los repos
    console.log(`📁 [${agentName}] Working directory: ${workDir}`);

    // Verificar que el directorio existe y es un repositorio
    const fs = require('fs');
    if (fs.existsSync(workDir)) {
      const contents = fs.readdirSync(workDir);
      console.log(`📂 [${agentName}] Directory contents:`, contents.slice(0, 20)); // Limit to first 20 items

      // Check if we're ALREADY IN a repository
      const isInRepo = contents.includes('.git');
      const hasSourceCode = contents.includes('src') || contents.includes('package.json');

      if (isInRepo) {
        console.log(`✅ [${agentName}] You are INSIDE a git repository`);
        if (hasSourceCode) {
          console.log(`✅ [${agentName}] Source code detected - ready to work!`);
        }
      } else {
        // We're in a parent directory, look for subdirectories that are repos
        const repos = contents.filter((item: string) => {
          const itemPath = `${workDir}/${item}`;
          try {
            return fs.statSync(itemPath).isDirectory() && fs.existsSync(`${itemPath}/.git`);
          } catch {
            return false;
          }
        });

        if (repos.length > 0) {
          console.log(`✅ [${agentName}] Found ${repos.length} repositories:`, repos);
        } else {
          console.warn(`⚠️ [${agentName}] NO REPOSITORIES FOUND in ${workDir}`);
          console.warn(`🔴 Expected to find git repositories but found none!`);
        }
      }
    } else {
      console.error(`❌ [${agentName}] Work directory does not exist: ${workDir}`);
    }

    // 🔥 STRICT SYSTEM PROMPT FOR DEVELOPERS
    let systemPrompt = `You are working in: ${workDir}

🚨 CRITICAL RULES - READ CAREFULLY:

1. **YOU ARE ALREADY IN THE REPOSITORY** - Your current directory IS the repository
2. **FILES ARE RIGHT HERE** - Run 'ls' to see them immediately
3. **DO NOT try to "cd" into subdirectories first** - you're already there
4. **WRITE ACTUAL CODE** - Modify .js, .ts, .jsx, .tsx, .css, .py files
5. **NO DOCUMENTATION FILES** - Never create .md files

**What to do:**
- First: Run 'ls' to see what files exist RIGHT HERE
- Then: Use Read/Edit/Write tools on those files DIRECTLY
- Example: If you see "src/", just do "Read src/index.ts" - don't cd first

**What NOT to do:**
- ❌ Don't create .md documentation files
- ❌ Don't try to "cd" to find the repo - you're IN it
- ❌ Don't write specs or plans - WRITE CODE`;

    // 🚨 EXTRA STRICT PROMPT FOR DEVELOPERS
    if (isDeveloper) {
      systemPrompt += `

🚨 🚨 🚨 DEVELOPER SPECIFIC RULES 🚨 🚨 🚨

**YOUR JOB IS TO MODIFY CODE FILES. NOTHING ELSE.**

You will be ABORTED and TERMINATED if you:
- ❌ Read too many files without making changes (limit: 10 reads)
- ❌ Take too long without writing code (limit: 2 minutes)
- ❌ Spend tokens without producing code (limit: 5000 tokens)
- ❌ Create .md documentation files instead of code

**MANDATORY WORKFLOW:**
1. Find the files you need to modify (max 3-5 Read operations)
2. IMMEDIATELY start using Edit/Write tools on those files
3. Continue editing until the feature is complete
4. Run tests if needed

**YOU MUST WRITE CODE WITHIN THE FIRST 30 SECONDS.**

If you're stuck or unsure, ASK in your response, but ALWAYS attempt to write code first.`;
    }

    const sdkOptions: Options = {
      cwd: workDir,
      systemPrompt,
      settingSources: ['project'], // Read from .claude/agents/
      permissionMode: 'acceptEdits',
      maxTurns: 100,
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: {
            GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
          },
        },
        'custom-dev-tools': createCustomToolsServer(),
      },
      ...(options?.resumeSessionId && {
        resume: options.resumeSessionId,
        ...(options.forkSession && { forkSession: true }),
      }),
    };

    let output = '';
    let usage: any = null;
    let sessionId = '';
    let todos: any[] = [];
    let canResume = false;
    let totalCost = 0;
    const allContent: string[] = [];
    let tokensSinceLastCheck = 0;
    const PRODUCTIVITY_CHECK_INTERVAL = 50; // Verificar cada 50 tokens

    try {
      // 🔥 Build prompt using Streaming Input Mode for image support
      let queryResult: AsyncIterable<any>;

      if (options?.attachments && options.attachments.length > 0) {
        // Streaming Input Mode with images (AsyncGenerator)
        console.log(`📎 [${agentName}] Using Streaming Input Mode with ${options.attachments.length} image(s)`);

        async function* generateMessages() {
          const promptText = typeof prompt === 'string' ? prompt : prompt[0]?.text || '';

          // Build content blocks: text + images
          const content: any[] = [
            {
              type: 'text',
              text: promptText
            }
          ];

          // Add all image attachments (safe to access - already checked in if condition)
          if (options?.attachments) {
            for (const attachment of options.attachments) {
              content.push({
                type: 'image',
                source: attachment.source
              });
            }
          }

          const attachmentCount = options?.attachments?.length || 0;
          console.log(`🖼️  [${agentName}] Yielding message with ${attachmentCount} image(s)`);

          // Yield the user message with images (following SDK format)
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: content
            },
            parent_tool_use_id: undefined as any // Optional field for SDK compatibility
          };
        }

        // Execute with streaming input (type assertion for SDK compatibility)
        queryResult = query({
          prompt: generateMessages() as any,
          options: sdkOptions,
        });
      } else {
        // Single Message Input (no images)
        const finalPrompt = typeof prompt === 'string' ? prompt : prompt[0]?.text || '';

        queryResult = query({
          prompt: finalPrompt,
          options: sdkOptions,
        });
      }

      // Process ALL stream events
      console.log(`🔄 [${agentName}] Starting to process SDK stream events...`);

      for await (const message of queryResult) {
        // 🚨 VERIFICACIÓN DE PRODUCTIVIDAD (Solo para developers)
        if (isDeveloper) {
          tokensSinceLastCheck++;

          // Verificar productividad cada N tokens
          if (tokensSinceLastCheck >= PRODUCTIVITY_CHECK_INTERVAL) {
            const check = productivityMonitor.checkProductivity(taskId);

            if (!check.isProductive && check.shouldAbort) {
              console.error(`\n🚨 [PRODUCTIVITY ABORT] ${agentName} is not being productive!`);
              console.error(`   Reason: ${check.reason}`);
              console.error(`   Metrics:`, check.metrics);

              // Notificar vía WebSocket
              NotificationService.emitAgentMessage(
                taskId,
                agentName,
                `🚨 **ABORTED: Unproductive agent**\nReason: ${check.reason}`
              );

              // Lanzar error para abortar
              throw new Error(`Agent aborted due to lack of productivity: ${check.reason}`);
            }

            tokensSinceLastCheck = 0;
          }
        }
        // 🔍 ALWAYS log SDK events with full content for debugging
        console.log(`\n═══════════════════════════════════════════════════════`);
        console.log(`[SDK Event] Type: ${message.type}`);
        console.log(`[SDK Event] Full content:`, JSON.stringify(message, null, 2));
        console.log(`═══════════════════════════════════════════════════════\n`);

        // Handle different message types
        switch (message.type) {
          case 'assistant':
            await this.handleAssistantMessage(
              message,
              taskId,
              agentName,
              allContent
            );
            sessionId = message.session_id;
            break;

          case 'tool_use' as any:
            await this.handleToolUse(
              message as any,
              taskId,
              agentName,
              todos,
              allContent
            );
            break;

          case 'stream_event':
            await this.handleStreamEvent(
              message as any,
              taskId,
              agentName,
              allContent
            );
            break;

          case 'result':
            const result = await this.handleResult(
              message,
              startTime,
              taskId,
              agentType,
              agentName
            );
            output = result.output;
            usage = result.usage;
            totalCost = result.cost;
            canResume = result.canResume;
            sessionId = message.session_id;
            break;

          case 'error' as any:
            RealTimeLogger.logError(taskId, agentName, `SDK Error: ${JSON.stringify(message)}`);
            throw new Error(`Agent execution failed: ${message}`);

          case 'system':
            // System messages (init, etc) - log silently if needed
            if (process.env.DEBUG_SDK === 'true') {
              console.log(`[SDK System]: ${message.subtype || 'unknown'}`, message);
            }
            break;

          case 'user':
            // User messages (prompts) - log silently if needed
            if (process.env.DEBUG_SDK === 'true') {
              console.log(`[SDK User Message]`, message);
            }
            break;

          default:
            // Log any unknown message types for debugging (only in debug mode)
            if (process.env.DEBUG_SDK === 'true') {
              console.log(`[Unknown Message Type]: ${(message as any).type}`, message);
            }
        }
      }

      // Save all logs to file
      RealTimeLogger.saveLogsToFile(taskId);

      // 🚨 GENERAR REPORTE FINAL DE PRODUCTIVIDAD (Solo para developers)
      if (isDeveloper) {
        const report = productivityMonitor.getFinalReport(taskId);
        console.log(`\n📊 [PRODUCTIVITY REPORT] ${agentName}:`);
        console.log(`   Files modified: ${report.filesModified.length}`);
        console.log(`   Total cost: $${report.totalCost.toFixed(4)}`);
        console.log(`   Total tokens: ${report.totalTokens}`);
        console.log(`   Total time: ${report.totalTime}s`);
        console.log(`   Tool usage:`, report.toolUsage);

        if (!report.wasProductive && report.filesModified.length === 0) {
          console.warn(`⚠️  [WARNING] Developer completed but modified NO files!`);
          NotificationService.emitAgentMessage(
            taskId,
            agentName,
            `⚠️ **WARNING**: Completed without modifying any files!\n💰 Cost: $${report.totalCost.toFixed(4)}\n⏱️ Time: ${report.totalTime}s`
          );
        }

        productivityMonitor.cleanup(taskId);
      }

      return {
        output,
        usage,
        cost: totalCost,
        sessionId,
        todos,
        canResume,
        allContent,
      };

    } catch (error: any) {
      console.error(`❌ [${agentName}] Execution failed:`, error);
      RealTimeLogger.logError(taskId, agentName, error.message, error.stack);

      // 🚨 REPORTE DE PRODUCTIVIDAD EN CASO DE ERROR
      if (isDeveloper) {
        const report = productivityMonitor.getFinalReport(taskId);
        console.error(`📊 [PRODUCTIVITY REPORT ON FAILURE]:`);
        console.error(`   Files modified: ${report.filesModified.length}`);
        console.error(`   Wasted cost: $${report.totalCost.toFixed(4)}`);
        console.error(`   Wasted tokens: ${report.totalTokens}`);
        console.error(`   Time wasted: ${report.totalTime}s`);
        productivityMonitor.cleanup(taskId);
      }

      // Record failure in analytics
      await this.analyticsService.recordExecution({
        taskId,
        agentType,
        status: 'failure',
        startedAt: new Date(startTime),
        completedAt: new Date(),
        duration: Date.now() - startTime,
        cost: 0,
        tokens: { input: 0, output: 0, cached: 0 },
        errorMessage: error.message,
      });

      throw error;
    }
  }

  /**
   * Handle assistant messages (text, thinking, tool use)
   */
  private async handleAssistantMessage(
    message: any,
    taskId: string,
    agentName: string,
    allContent: string[]
  ) {
    for (const content of message.message.content) {
      if (content.type === 'text') {
        const text = content.text;
        allContent.push(text);

        // Emit text in real-time
        if (text.trim()) {
          NotificationService.emitAgentMessage(taskId, agentName, text);

          // Log important decisions or explanations
          if (text.includes('Decision:') || text.includes('I will') || text.includes('I need to')) {
            RealTimeLogger.logDecision(taskId, agentName, 'Agent reasoning', text);
          }
        }
      } else if (content.type === 'thinking') {
        // Capture thinking blocks
        const thinking = content.thinking;
        allContent.push(`[THINKING] ${thinking}`);

        NotificationService.emitAgentMessage(
          taskId,
          agentName,
          `🤔 **Thinking:** ${thinking}`
        );
      } else if (content.type === 'tool_use') {
        // Handle inline tool use
        await this.processToolUse(
          content,
          taskId,
          agentName,
          allContent
        );
      }
    }
  }

  /**
   * Handle tool use events
   */
  private async handleToolUse(
    message: any,
    taskId: string,
    agentName: string,
    todos: any[],
    allContent: string[]
  ) {
    const toolName = message.name;
    const toolInput = message.input;
    const toolId = message.id;

    console.log(`\n🔧 [handleToolUse] Tool detected: ${toolName}`);
    console.log(`   Tool ID: ${toolId}`);
    console.log(`   Input keys: ${Object.keys(toolInput || {}).join(', ')}`);

    // 🚨 REGISTRAR HERRAMIENTA EN MONITOR DE PRODUCTIVIDAD
    console.log(`   📊 Registering tool use in ProductivityMonitor...`);
    productivityMonitor.recordToolUse(taskId, toolName, toolInput);
    console.log(`   ✅ Tool use registered\n`);

    // 🔥 MAXIMUM CONSOLE VISIBILITY - Show EVERYTHING
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🛠️ [${agentName}] USING TOOL: ${toolName}`);

    // Show details based on tool type
    if (toolName === 'Bash') {
      console.log(`📟 COMMAND: ${toolInput.command}`);
    } else if (toolName === 'Write') {
      console.log(`✍️ WRITING FILE: ${toolInput.file_path || toolInput.path}`);
      console.log(`📏 SIZE: ${toolInput.content?.length || 0} characters`);
      if (toolInput.content?.length < 500) {
        console.log(`📄 CONTENT:\n${toolInput.content}`);
      }
    } else if (toolName === 'Edit') {
      console.log(`✏️ EDITING FILE: ${toolInput.file_path || toolInput.path}`);
      console.log(`🔄 REPLACING: ${(toolInput.old_string || '').substring(0, 50)}...`);
      console.log(`➡️ WITH: ${(toolInput.new_string || '').substring(0, 50)}...`);
    } else if (toolName === 'Read') {
      console.log(`👁️ READING FILE: ${toolInput.file_path || toolInput.path}`);
    } else if (toolName === 'Grep') {
      console.log(`🔍 SEARCHING FOR: "${toolInput.pattern}"`);
      console.log(`📁 IN PATH: ${toolInput.path || 'current directory'}`);
    } else if (toolName === 'Glob') {
      console.log(`📂 FINDING FILES: ${toolInput.pattern}`);
    }
    console.log(`${'='.repeat(70)}\n`);

    // Log the tool use
    RealTimeLogger.logToolUse(taskId, agentName, toolName, toolInput);

    // Process specific tools
    await this.processToolUse(
      { name: toolName, input: toolInput, id: toolId },
      taskId,
      agentName,
      allContent,
      todos
    );
  }

  /**
   * Process specific tool uses
   */
  private async processToolUse(
    tool: ToolUse,
    taskId: string,
    agentName: string,
    allContent: string[],
    todos?: any[]
  ) {
    const { name, input } = tool;

    // Capture file operations
    if (name === 'Write') {
      const filePath = input.file_path || input.path;
      const content = input.content || '';

      allContent.push(`[WRITE FILE] ${filePath}`);
      allContent.push(content);

      RealTimeLogger.logCode(
        taskId,
        agentName,
        this.getFileLanguage(filePath),
        content,
        `Writing to ${filePath}`
      );

      // 🔥 MEJORADO: Mostrar el código COMPLETO en múltiples formatos
      console.log(`\n📝 [${agentName}] WRITING FILE: ${filePath}`);
      console.log(`📄 Content preview (first 500 chars):`);
      console.log('─'.repeat(60));
      console.log(content.substring(0, 500));
      console.log('─'.repeat(60));

      // Enviar por WebSocket con el código COMPLETO (no truncado para logs)
      const fullCodeMessage = `📝 **Creating file:** \`${filePath}\`
\`\`\`${this.getFileLanguage(filePath)}
${content.substring(0, 2000)}
\`\`\`${content.length > 2000 ? `\n... (${content.length - 2000} more characters)` : ''}`;

      NotificationService.emitAgentMessage(taskId, agentName, fullCodeMessage);

      // También emitir un evento específico para código
      NotificationService.emitCodeWrite(taskId, agentName, {
        filePath,
        content: content.substring(0, 5000), // Enviar más contenido
        language: this.getFileLanguage(filePath),
        timestamp: new Date(),
      });
    } else if (name === 'Edit') {
      const filePath = input.file_path || input.path;
      const oldString = input.old_string || '';
      const newString = input.new_string || '';

      allContent.push(`[EDIT FILE] ${filePath}`);
      allContent.push(`OLD: ${oldString}`);
      allContent.push(`NEW: ${newString}`);

      // 🔥 MEJORADO: Mostrar ediciones en consola
      console.log(`\n✏️ [${agentName}] EDITING FILE: ${filePath}`);
      console.log('─'.repeat(60));
      console.log('REPLACING:', oldString.substring(0, 100));
      console.log('WITH:', newString.substring(0, 100));
      console.log('─'.repeat(60));

      // Enviar cambios detallados por WebSocket
      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `✏️ **Editing file:** \`${filePath}\`
**Replacing:**
\`\`\`${this.getFileLanguage(filePath)}
${oldString.substring(0, 400)}
\`\`\`
**With:**
\`\`\`${this.getFileLanguage(filePath)}
${newString.substring(0, 400)}
\`\`\`${oldString.length > 400 || newString.length > 400 ? '\n... (truncated)' : ''}`
      );

      // Evento específico para ediciones
      NotificationService.emitCodeEdit(taskId, agentName, {
        filePath,
        oldContent: oldString,
        newContent: newString,
        timestamp: new Date(),
      });
    } else if (name === 'Bash') {
      allContent.push(`[COMMAND] ${input.command}`);

      // Special handling for git commands
      if (input.command.includes('git')) {
        this.handleGitCommand(taskId, agentName, input.command);
      }
    } else if (name === 'TodoWrite' && todos) {
      // Capture todos
      if (input.todos) {
        todos.length = 0; // Clear existing
        todos.push(...input.todos);

        NotificationService.emitAgentMessage(
          taskId,
          agentName,
          `📋 **Todo List Updated:**\n${todos
            .map(t => {
              const icon = t.status === 'completed' ? '✅' :
                          t.status === 'in_progress' ? '🔄' : '⏳';
              return `${icon} ${t.content}`;
            })
            .join('\n')}`
        );
      }
    } else if (name === 'Read') {
      allContent.push(`[READ FILE] ${input.file_path || input.path}`);

      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `👀 **Reading file:** \`${input.file_path || input.path}\``
      );
    } else if (name === 'Grep') {
      allContent.push(`[SEARCH] Pattern: ${input.pattern} in ${input.path || '.'}`);

      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `🔍 **Searching for:** \`${input.pattern}\` in \`${input.path || 'current directory'}\``
      );
    }
  }

  /**
   * Handle git commands specially
   */
  private handleGitCommand(taskId: string, agentName: string, command: string) {
    if (command.includes('checkout -b')) {
      const branch = command.match(/checkout -b ([\w\-\/]+)/)?.[1];
      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `🌿 **Creating branch:** ${branch}
🔗 View on GitHub: https://github.com/${process.env.GITHUB_ORG}/${branch}`
      );
    } else if (command.includes('push')) {
      const branch = command.match(/origin ([\w\-\/]+)/)?.[1];
      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `📤 **Pushed to GitHub:** ${branch}
✅ Branch now available on remote`
      );
    } else if (command.includes('commit')) {
      const message = command.match(/-m ["'](.+?)["']/)?.[1];
      NotificationService.emitAgentMessage(
        taskId,
        agentName,
        `💾 **Committed:** ${message || 'Changes committed'}`
      );
    }
  }

  /**
   * Handle stream events (tool results, etc.)
   */
  private async handleStreamEvent(
    message: any,
    taskId: string,
    agentName: string,
    allContent: string[]
  ) {
    const eventType = message.event_type;
    const eventData = message.data;

    if (eventType === 'tool_result' && eventData) {
      const toolName = eventData.tool_name || 'unknown';
      const result = eventData.result;
      const isError = eventData.is_error;

      if (isError) {
        allContent.push(`[TOOL ERROR] ${toolName}: ${result}`);
        RealTimeLogger.logError(taskId, agentName, `Tool error: ${toolName}`, result);
      } else {
        // Capture tool results
        if (typeof result === 'string') {
          allContent.push(`[TOOL RESULT] ${toolName}: ${result.substring(0, 1000)}`);
        }

        // Special handling for bash results
        if (toolName === 'Bash' && result) {
          NotificationService.emitAgentMessage(
            taskId,
            agentName,
            `💻 **Command output:**
\`\`\`bash
${String(result).substring(0, 500)}
\`\`\`${String(result).length > 500 ? '\n... (truncated)' : ''}`
          );
        }
      }
    }
  }

  /**
   * Handle final result
   */
  private async handleResult(
    message: any,
    startTime: number,
    taskId: string,
    agentType: AgentType,
    agentName: string
  ) {
    const usage = message.usage;
    const cost = message.total_cost_usd || 0;
    const canResume = message.subtype === 'success';

    // 🚨 ACTUALIZAR MÉTRICAS DE PRODUCTIVIDAD
    productivityMonitor.updateMetrics(
      taskId,
      (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
      cost
    );

    let output = '';
    if (message.subtype === 'success') {
      output = message.result;
    } else {
      throw new Error(`Agent execution failed: ${message.subtype}`);
    }

    // Record in analytics
    await this.analyticsService.recordExecution({
      taskId,
      agentType,
      status: 'success',
      startedAt: new Date(startTime),
      completedAt: new Date(),
      duration: Date.now() - startTime,
      cost,
      tokens: {
        input: usage?.input_tokens || 0,
        output: usage?.output_tokens || 0,
        cached: usage?.cache_read_input_tokens || 0,
      },
    });

    console.log(`✅ [${agentName}] Execution completed in ${Date.now() - startTime}ms`);
    console.log(`💰 Cost: $${cost.toFixed(4)}`);
    console.log(`📊 Tokens: ${usage?.input_tokens || 0} in, ${usage?.output_tokens || 0} out`);

    return {
      output,
      usage,
      cost,
      canResume,
    };
  }

  /**
   * Get language from file extension
   */
  private getFileLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();
    const langMap: { [key: string]: string } = {
      'ts': 'typescript',
      'tsx': 'tsx',
      'js': 'javascript',
      'jsx': 'jsx',
      'py': 'python',
      'java': 'java',
      'go': 'go',
      'rs': 'rust',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'swift': 'swift',
      'kt': 'kotlin',
      'md': 'markdown',
      'json': 'json',
      'yml': 'yaml',
      'yaml': 'yaml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'sql': 'sql',
      'sh': 'bash',
    };
    return langMap[ext || ''] || 'text';
  }
}

export default new EnhancedAgentExecutor();