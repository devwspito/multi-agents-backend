# OpenCode Migration Plan

## Executive Summary

Migration from Claude Agent SDK to OpenCode SDK to eliminate ANSI escape code issues while maintaining 100% data quality for ML training on NVIDIA DGX Spark.

**Key Benefit:** OpenCode uses HTTP client/server architecture, eliminating terminal-related ANSI contamination entirely.

---

## Phase 1: Foundation & Proof of Concept

### 1.1 Install OpenCode SDK
```bash
npm install @opencode-ai/sdk
```

### 1.2 Create OpenCode Adapter Service
Create a new service that wraps OpenCode SDK and provides the same interface as our current AgentExecutorService.

```typescript
// src/services/opencode/OpenCodeExecutorService.ts
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk';
import type { Session, Message, Part } from '@opencode-ai/sdk';

export class OpenCodeExecutorService {
  private client: ReturnType<typeof createOpencodeClient>;

  async initialize() {
    this.client = await createOpencodeClient({
      hostname: '127.0.0.1',
      port: 4096,
      timeout: 5000,
    });
  }

  async executeAgent(params: AgentExecutionParams): Promise<AgentExecutionResult> {
    // Create session
    const session = await this.client.session.create({
      projectDirectory: params.workspacePath,
    });

    // Execute prompt
    const result = await this.client.session.prompt({
      sessionId: session.id,
      content: params.prompt,
    });

    // Map result to our format
    return this.mapToExecutionResult(session, result);
  }
}
```

### 1.3 Create Training Data Plugin
This plugin captures all granular data needed for ML training.

```typescript
// opencode-plugins/training-tracker/index.ts
import type { Plugin, ToolPart } from '@opencode-ai/sdk';

export const trainingTrackerPlugin: Plugin = {
  name: 'training-tracker',
  version: '1.0.0',

  hooks: {
    // Track tool execution start
    'tool.execute.before': async ({ tool, args }, context) => {
      const startTime = Date.now();
      context.state.toolStart = startTime;
      context.state.toolInput = args;
      context.state.toolName = tool.name;

      // Extract bash-specific fields
      if (tool.name === 'Bash') {
        context.state.bashCommand = args.command;
      }
      if (args.file_path) {
        context.state.filePath = args.file_path;
      }
    },

    // Track tool execution end
    'tool.execute.after': async ({ tool, result, error }, context) => {
      const endTime = Date.now();
      const durationMs = endTime - context.state.toolStart;

      // Record tool call
      await recordToolCall({
        toolName: context.state.toolName,
        toolInput: context.state.toolInput,
        toolOutput: result?.output,
        toolSuccess: !error,
        toolError: error?.message,
        bashCommand: context.state.bashCommand,
        bashExitCode: result?.exitCode,
        filePath: context.state.filePath,
        durationMs,
        callOrder: context.state.callOrder++,
      });
    },

    // Track session messages for turn-level data
    'chat.message': async ({ message, parts }, context) => {
      await recordTurn({
        turnNumber: context.state.turnNumber++,
        messageContent: extractTextContent(parts),
        toolCallsCount: countToolParts(parts),
        inputTokens: message.info.inputTokens,
        outputTokens: message.info.outputTokens,
      });
    },

    // Track session completion
    'session.idle': async ({ session }, context) => {
      await recordExecutionComplete({
        sessionId: session.id,
        finalOutput: extractFinalOutput(session.messages),
        totalCost: session.info.cost,
        totalTokens: session.info.tokenCount,
      });
    },
  },
};
```

---

## Phase 2: Adapter Layer

### 2.1 Create Interface Compatibility Layer

Maintain the same interface used by OrchestrationCoordinator and Phase classes.

```typescript
// src/services/opencode/OpenCodeAdapter.ts
import { OpenCodeExecutorService } from './OpenCodeExecutorService';
import { executionTracker } from '../training/ExecutionTracker';

export class OpenCodeAdapter {
  private executor: OpenCodeExecutorService;

  /**
   * Execute agent with same signature as current AgentExecutorService
   */
  async execute(
    agentType: string,
    prompt: string,
    workspacePath: string,
    taskId?: string,
    options?: AgentOptions
  ): Promise<AgentResult> {
    // Start tracking (same as current)
    const executionId = executionTracker.startExecution({
      taskId,
      agentType,
      modelId: options?.model || 'default',
      phaseName: options?.phaseName || 'unknown',
      prompt,
      workspacePath,
    });

    try {
      // Execute via OpenCode
      const result = await this.executor.executeAgent({
        prompt,
        workspacePath,
        model: options?.model,
        systemPrompt: options?.systemPrompt,
      });

      // Complete tracking
      executionTracker.completeExecution(taskId, {
        finalOutput: result.output,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.cost,
      });

      return result;
    } catch (error) {
      executionTracker.failExecution(taskId, error.message);
      throw error;
    }
  }
}
```

### 2.2 Message Part to Tool Call Mapping

Map OpenCode's Part types to our IToolCall interface.

```typescript
// src/services/opencode/PartMapper.ts

function mapToolPartToToolCall(part: ToolPart, context: MappingContext): IToolCall {
  const input = part.args || {};

  return {
    id: generateId(),
    executionId: context.executionId,
    turnId: context.turnId,
    taskId: context.taskId,
    toolName: part.name,
    toolUseId: part.id,
    toolInput: input,
    toolInputSummary: summarizeInput(input),
    toolOutput: part.result?.output,
    toolSuccess: part.state === 'completed',
    toolError: part.state === 'error' ? part.error?.message : undefined,
    filePath: extractFilePath(part.name, input),
    bashCommand: input.command,
    bashExitCode: part.result?.exitCode,
    durationMs: calculateDuration(part.metadata?.start, part.metadata?.end),
    callOrder: context.callOrder,
    startedAt: new Date(part.metadata?.start || Date.now()),
    completedAt: new Date(part.metadata?.end || Date.now()),
  };
}

function extractFilePath(toolName: string, input: any): string | undefined {
  // Read, Write, Edit tools have file_path
  if (input.file_path) return input.file_path;
  // Glob tool has path
  if (input.path) return input.path;
  return undefined;
}
```

---

## Phase 3: Repository Integration

### 3.1 Extend Repositories for OpenCode Data

The existing repositories (AgentExecutionRepository, AgentTurnRepository, ToolCallRepository) remain unchanged - they're already provider-agnostic.

### 3.2 Event Subscription for Real-time Tracking

```typescript
// src/services/opencode/EventTracker.ts

export class OpenCodeEventTracker {
  async subscribeToSession(sessionId: string, taskId: string) {
    const client = getOpenCodeClient();

    // Subscribe to server-sent events
    const eventStream = await client.global.event();

    for await (const event of eventStream) {
      switch (event.type) {
        case 'message.updated':
          await this.handleMessageUpdate(event, taskId);
          break;
        case 'session.updated':
          await this.handleSessionUpdate(event, taskId);
          break;
      }
    }
  }

  private async handleMessageUpdate(event: EventMessageUpdated, taskId: string) {
    const message = event.message;

    // Extract and record turn data
    for (const part of message.parts) {
      if (part.type === 'tool') {
        await this.recordToolCall(part, taskId);
      }
    }

    // Record turn
    executionTracker.updateTurnContent(
      taskId,
      extractTextFromParts(message.parts),
      { input: message.inputTokens, output: message.outputTokens }
    );
  }
}
```

---

## Phase 4: Phase Migration

### 4.1 Migration Order (Least to Most Critical)

1. **SandboxPhase** - Already disabled, good first test
2. **Planning Phase** - Simple prompt/response
3. **RecoveryPhase** - Error handling practice
4. **TeamOrchestrationPhase** - Parallel execution test
5. **DevelopersPhase** - Heavy tool usage
6. **JudgePhase** - Code review
7. **AutoMergePhase** - Final integration

### 4.2 Feature Flag for Gradual Rollout

```typescript
// src/config/feature-flags.ts

export const FEATURE_FLAGS = {
  USE_OPENCODE_SDK: {
    enabled: process.env.USE_OPENCODE_SDK === 'true',
    phases: [
      'Sandbox',  // Phase 1
      'Planning', // Phase 2
      // Add more as migration progresses
    ],
  },
};

// Usage in OrchestrationCoordinator
const executor = shouldUseOpenCode(phaseName)
  ? openCodeAdapter
  : claudeAgentExecutor;
```

---

## Phase 5: Training Data Validation

### 5.1 Parallel Recording Validation

During migration, run both SDKs in parallel and compare output:

```typescript
// src/services/opencode/ValidationService.ts

export class DataValidationService {
  async validateParity(taskId: string): Promise<ValidationReport> {
    const claudeData = await TrainingExportService.exportTask(taskId);
    const openCodeData = await OpenCodeExportService.exportTask(taskId);

    return {
      executionsMatch: this.compareExecutions(claudeData, openCodeData),
      turnsMatch: this.compareTurns(claudeData, openCodeData),
      toolCallsMatch: this.compareToolCalls(claudeData, openCodeData),
      missingFields: this.findMissingFields(claudeData, openCodeData),
      dataQualityScore: this.calculateQualityScore(claudeData, openCodeData),
    };
  }
}
```

### 5.2 Training Data Quality Checklist

Before marking migration complete, verify:

- [ ] All execution-level fields captured
- [ ] All turn-level fields captured
- [ ] All tool call fields captured (including bash-specific)
- [ ] Token usage matches within 1% tolerance
- [ ] Cost calculation matches
- [ ] Security observations still captured
- [ ] Export format unchanged for DGX compatibility

---

## Timeline Estimate

| Phase | Description | Dependencies |
|-------|-------------|--------------|
| **Phase 1** | Foundation & POC | None |
| **Phase 2** | Adapter Layer | Phase 1 |
| **Phase 3** | Repository Integration | Phase 2 |
| **Phase 4** | Phase Migration | Phase 3 |
| **Phase 5** | Validation | Phase 4 |

---

## Rollback Plan

If issues are discovered:

1. Feature flag can instantly revert to Claude SDK
2. Data repositories are SDK-agnostic (no data migration needed)
3. Training export format unchanged (DGX pipeline unaffected)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Missing data fields | Low | High | Parallel validation + plugin hooks |
| Token usage discrepancy | Low | Medium | Compare with Claude SDK during validation |
| Performance regression | Low | Medium | Benchmark before full rollout |
| OpenCode API changes | Medium | Medium | Pin SDK version, monitor changelog |

---

## Success Criteria

1. ✅ No ANSI escape code errors
2. ✅ 100% data field parity with current system
3. ✅ Training data quality score >= 95%
4. ✅ All phases migrated and tested
5. ✅ DGX training pipeline unchanged

---

## References

- [OpenCode SDK Documentation](https://opencode.ai/docs/sdk/)
- [OpenCode Plugins Guide](https://opencode.ai/docs/plugins/)
- [OpenCode Custom Tools](https://opencode.ai/docs/custom-tools/)
- [OpenCode TokenScope Plugin](https://github.com/ramtinJ95/opencode-tokenscope)
- [How Coding Agents Work: OpenCode Deep Dive](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)

---

**Created:** 2026-02-03
**Author:** Migration Planning
**Status:** Ready for Review
