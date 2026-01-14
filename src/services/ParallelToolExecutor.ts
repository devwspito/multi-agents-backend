/**
 * ParallelToolExecutor
 *
 * Execute independent tools in parallel for faster agent operations.
 * Analyzes tool dependencies and maximizes parallelism.
 *
 * Key behaviors:
 * 1. Analyze tool call dependencies
 * 2. Group independent tools for parallel execution
 * 3. Maintain result ordering for dependent tools
 * 4. Handle partial failures gracefully
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  dependsOn?: string[]; // IDs of tools this depends on
  priority?: number; // Higher = execute first
}

export interface ToolResult {
  id: string;
  name: string;
  success: boolean;
  result?: any;
  error?: string;
  duration: number;
  startedAt: number;
  completedAt: number;
}

export interface ExecutionPlan {
  batches: ToolCall[][];
  totalTools: number;
  parallelizable: number;
  sequential: number;
  estimatedSpeedup: number;
}

export interface ExecutionResult {
  results: ToolResult[];
  totalDuration: number;
  sequentialDuration: number;
  actualSpeedup: number;
  failedCount: number;
  plan: ExecutionPlan;
}

export interface ExecutorConfig {
  maxParallel: number;
  timeout: number;
  continueOnError: boolean;
  retryFailed: boolean;
  maxRetries: number;
}

const DEFAULT_CONFIG: ExecutorConfig = {
  maxParallel: 10,
  timeout: 30000,
  continueOnError: true,
  retryFailed: false,
  maxRetries: 2,
};

// Tool dependency knowledge
const TOOL_DEPENDENCIES: Record<string, string[]> = {
  // Edit depends on Read (must read file first)
  'Edit': ['Read'],
  // Write is independent
  'Write': [],
  // Grep is independent
  'Grep': [],
  // Glob is independent
  'Glob': [],
  // Bash may depend on previous Bash
  'Bash': [],
  // Read is independent
  'Read': [],
};

// Tools that can safely run in parallel
const PARALLELIZABLE_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
]);

// Tools that modify state (must be careful with parallelization)
const STATE_MODIFYING_TOOLS = new Set([
  'Edit', 'Write', 'Bash', 'NotebookEdit',
]);

export class ParallelToolExecutor {
  private config: ExecutorConfig;

  constructor(config: Partial<ExecutorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute tools with maximum parallelism
   */
  async execute(
    tools: ToolCall[],
    executor: (tool: ToolCall) => Promise<any>
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const results: ToolResult[] = [];

    // Create execution plan
    const plan = this.createExecutionPlan(tools);

    // Execute batches
    for (const batch of plan.batches) {
      const batchResults = await this.executeBatch(batch, executor);
      results.push(...batchResults);

      // Check for failures if not continuing on error
      if (!this.config.continueOnError) {
        const failed = batchResults.find(r => !r.success);
        if (failed) {
          break;
        }
      }
    }

    const totalDuration = Date.now() - startTime;
    const sequentialDuration = results.reduce((sum, r) => sum + r.duration, 0);

    return {
      results,
      totalDuration,
      sequentialDuration,
      actualSpeedup: sequentialDuration > 0 ? sequentialDuration / totalDuration : 1,
      failedCount: results.filter(r => !r.success).length,
      plan,
    };
  }

  /**
   * Create execution plan with dependency analysis
   */
  createExecutionPlan(tools: ToolCall[]): ExecutionPlan {
    const batches: ToolCall[][] = [];
    const completed = new Set<string>();
    const remaining = [...tools];
    let parallelizable = 0;
    let sequential = 0;

    while (remaining.length > 0) {
      // Find tools that can run now (dependencies satisfied)
      const ready: ToolCall[] = [];
      const notReady: ToolCall[] = [];

      for (const tool of remaining) {
        const deps = this.getDependencies(tool, tools);
        const depsCompleted = deps.every(d => completed.has(d));

        if (depsCompleted) {
          ready.push(tool);
        } else {
          notReady.push(tool);
        }
      }

      if (ready.length === 0 && notReady.length > 0) {
        // Circular dependency or missing dependency - break cycle
        console.warn(`⚠️ Circular dependency detected, forcing execution`);
        ready.push(notReady[0]);
        notReady.shift();
      }

      // Group parallelizable tools
      const parallelGroup: ToolCall[] = [];
      const sequentialGroup: ToolCall[] = [];

      for (const tool of ready) {
        if (this.canParallelize(tool, ready)) {
          parallelGroup.push(tool);
        } else {
          sequentialGroup.push(tool);
        }
      }

      // Create batch - parallel tools together, sequential one by one
      if (parallelGroup.length > 0) {
        batches.push(parallelGroup);
        parallelizable += parallelGroup.length;
        for (const tool of parallelGroup) {
          completed.add(tool.id);
        }
      }

      for (const tool of sequentialGroup) {
        batches.push([tool]);
        sequential++;
        completed.add(tool.id);
      }

      remaining.length = 0;
      remaining.push(...notReady);
    }

    // Calculate estimated speedup
    const avgBatchSize = tools.length > 0
      ? tools.length / batches.length
      : 1;

    return {
      batches,
      totalTools: tools.length,
      parallelizable,
      sequential,
      estimatedSpeedup: avgBatchSize,
    };
  }

  /**
   * Execute a batch of tools in parallel
   */
  private async executeBatch(
    batch: ToolCall[],
    executor: (tool: ToolCall) => Promise<any>
  ): Promise<ToolResult[]> {
    // Limit parallelism
    const chunks = this.chunkArray(batch, this.config.maxParallel);
    const results: ToolResult[] = [];

    for (const chunk of chunks) {
      const promises = chunk.map(tool => this.executeToolWithRetry(tool, executor));
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Execute single tool with retry
   */
  private async executeToolWithRetry(
    tool: ToolCall,
    executor: (tool: ToolCall) => Promise<any>
  ): Promise<ToolResult> {
    let lastError: string | undefined;
    let attempts = 0;
    const maxAttempts = this.config.retryFailed ? this.config.maxRetries + 1 : 1;

    while (attempts < maxAttempts) {
      attempts++;
      const startTime = Date.now();

      try {
        const result = await Promise.race([
          executor(tool),
          this.timeout(this.config.timeout),
        ]);

        return {
          id: tool.id,
          name: tool.name,
          success: true,
          result,
          duration: Date.now() - startTime,
          startedAt: startTime,
          completedAt: Date.now(),
        };
      } catch (error: any) {
        lastError = error.message || 'Unknown error';

        if (attempts < maxAttempts) {
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    return {
      id: tool.id,
      name: tool.name,
      success: false,
      error: lastError,
      duration: 0,
      startedAt: Date.now(),
      completedAt: Date.now(),
    };
  }

  /**
   * Get dependencies for a tool
   */
  private getDependencies(tool: ToolCall, allTools: ToolCall[]): string[] {
    const deps: string[] = [];

    // Explicit dependencies
    if (tool.dependsOn) {
      deps.push(...tool.dependsOn);
    }

    // Implicit dependencies based on tool type
    const implicitDeps = TOOL_DEPENDENCIES[tool.name] || [];
    for (const depType of implicitDeps) {
      // Find previous tools of the dependent type that affect same resource
      const resourceDeps = allTools.filter(t =>
        t.name === depType &&
        t.id !== tool.id &&
        this.affectsSameResource(t, tool)
      );
      deps.push(...resourceDeps.map(t => t.id));
    }

    return [...new Set(deps)];
  }

  /**
   * Check if two tools affect the same resource
   */
  private affectsSameResource(tool1: ToolCall, tool2: ToolCall): boolean {
    // Check file path arguments
    const path1 = tool1.args.file_path || tool1.args.path || '';
    const path2 = tool2.args.file_path || tool2.args.path || '';

    if (path1 && path2) {
      return path1 === path2;
    }

    return false;
  }

  /**
   * Check if tool can be parallelized with others
   */
  private canParallelize(tool: ToolCall, others: ToolCall[]): boolean {
    // Read-only tools can always be parallelized
    if (PARALLELIZABLE_TOOLS.has(tool.name)) {
      return true;
    }

    // State-modifying tools need more care
    if (STATE_MODIFYING_TOOLS.has(tool.name)) {
      // Can parallelize if operating on different files
      const toolPath = tool.args.file_path || tool.args.path || '';

      const conflicting = others.filter(other => {
        if (other.id === tool.id) return false;
        if (!STATE_MODIFYING_TOOLS.has(other.name)) return false;

        const otherPath = other.args.file_path || other.args.path || '';
        return toolPath === otherPath;
      });

      return conflicting.length === 0;
    }

    return false;
  }

  /**
   * Create timeout promise
   */
  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    });
  }

  /**
   * Chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Analyze tool calls for parallelization opportunities
   */
  static analyzeParallelization(tools: ToolCall[]): {
    canParallelize: number;
    mustSequence: number;
    suggestions: string[];
  } {
    let canParallelize = 0;
    let mustSequence = 0;
    const suggestions: string[] = [];

    for (const tool of tools) {
      if (PARALLELIZABLE_TOOLS.has(tool.name)) {
        canParallelize++;
      } else {
        mustSequence++;
      }
    }

    // Generate suggestions
    const readCalls = tools.filter(t => t.name === 'Read');
    if (readCalls.length > 3) {
      suggestions.push(`📚 ${readCalls.length} Read calls can run in parallel`);
    }

    const grepCalls = tools.filter(t => t.name === 'Grep');
    if (grepCalls.length > 2) {
      suggestions.push(`🔍 ${grepCalls.length} Grep calls can run in parallel`);
    }

    const editCalls = tools.filter(t => t.name === 'Edit');
    const uniqueFiles = new Set(editCalls.map(t => t.args.file_path));
    if (editCalls.length > uniqueFiles.size) {
      suggestions.push(`⚠️ Multiple edits to same file must be sequential`);
    } else if (editCalls.length > 1) {
      suggestions.push(`✏️ ${editCalls.length} Edits to different files can run in parallel`);
    }

    return { canParallelize, mustSequence, suggestions };
  }

  /**
   * Format execution result for display
   */
  static formatResult(result: ExecutionResult): string {
    const successCount = result.results.filter(r => r.success).length;
    const icon = result.failedCount === 0 ? '✅' : '⚠️';

    return `
## ${icon} Parallel Execution Result

- **Tools Executed**: ${result.results.length}
- **Successful**: ${successCount}
- **Failed**: ${result.failedCount}
- **Total Duration**: ${result.totalDuration}ms
- **Sequential Would Take**: ${result.sequentialDuration}ms
- **Actual Speedup**: ${result.actualSpeedup.toFixed(1)}x

### Execution Plan:
- **Batches**: ${result.plan.batches.length}
- **Parallelizable**: ${result.plan.parallelizable}
- **Sequential**: ${result.plan.sequential}
- **Estimated Speedup**: ${result.plan.estimatedSpeedup.toFixed(1)}x
`;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## ⚡ PARALLEL TOOL EXECUTION

Tools are automatically parallelized when safe:

### Parallelizable Tools:
- ✅ Read (multiple files)
- ✅ Grep (multiple searches)
- ✅ Glob (multiple patterns)
- ✅ WebFetch (multiple URLs)
- ✅ WebSearch (multiple queries)

### Sequential Tools:
- ⏳ Edit (same file must be sequential)
- ⏳ Write (same file must be sequential)
- ⏳ Bash (state-dependent)

### How It Works:

1. **Dependency Analysis**: Detects tool dependencies
2. **Batching**: Groups independent tools
3. **Parallel Execution**: Runs batch in parallel
4. **Result Ordering**: Maintains correct order

### Example Speedup:

\`\`\`
5 Read calls:
  Sequential: 500ms (100ms each)
  Parallel:   120ms (all at once)
  Speedup:    4.2x
\`\`\`

### Best Practices:

1. **Group reads at start**: Read all needed files first
2. **Independent searches**: Run greps in parallel
3. **Batch writes**: Edit different files together
4. **Avoid conflicts**: Don't edit same file in parallel
`;
  }
}
