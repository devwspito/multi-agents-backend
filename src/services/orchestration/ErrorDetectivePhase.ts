import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * Error Detective Phase
 *
 * Analyzes external error logs and system issues BEFORE ProblemAnalyst
 * - Parses error logs and stack traces
 * - Identifies error patterns and root causes
 * - Correlates errors across distributed systems
 * - Extracts actionable insights for fixing
 *
 * This phase is triggered by webhook/API Key integrations for real-time error resolution
 */
export class ErrorDetectivePhase extends BasePhase {
  readonly name = 'ErrorDetective';
  readonly description = 'Analyzing error logs and identifying root causes';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if ErrorDetective already completed (recovery mode only)
   * OR if this task was not triggered by webhook (no error logs to analyze)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Skip if not triggered by webhook (no errorLogs in task)
    if (!task.description || !task.description.includes('ERROR_LOGS:')) {
      console.log(`[SKIP] ErrorDetective - Task not triggered by webhook (no error logs)`);
      return true;
    }

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.errorDetective?.status === 'completed') {
      console.log(`[SKIP] ErrorDetective already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution
      if (context.task.orchestration.errorDetective.output) {
        context.setData('errorDetectiveOutput', context.task.orchestration.errorDetective.output);
      }
      context.setData('errorDetectiveComplete', true);

      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;

    await LogService.info('ErrorDetective phase started - Analyzing error logs', {
      taskId,
      category: 'orchestration',
      phase: 'analysis',
    });

    // Track start time
    const startTime = new Date();

    // Initialize ErrorDetective state
    if (!task.orchestration.errorDetective) {
      task.orchestration.errorDetective = {
        agent: 'error-detective',
        status: 'pending',
      } as any;
    }

    task.orchestration.errorDetective!.status = 'in_progress';
    task.orchestration.errorDetective!.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Error Detective');

    await LogService.agentStarted('error-detective' as any, taskId, {
      phase: 'analysis',
    });

    try {
      // Extract error logs from task description
      const errorLogs = this.extractErrorLogs(task.description || '');
      const errorSource = this.extractErrorSource(task.description || '');
      const errorTimestamp = this.extractErrorTimestamp(task.description || '');

      console.log(`🔍 [ErrorDetective] Analyzing error from: ${errorSource}`);
      console.log(`📋 [ErrorDetective] Error logs length: ${errorLogs.length} chars`);

      await LogService.info(`Analyzing error from ${errorSource}`, {
        taskId,
        category: 'quality',
        phase: 'analysis',
        metadata: {
          errorSource,
          errorTimestamp,
          errorLogsLength: errorLogs.length,
        },
      });

      // Progress notification
      NotificationService.emitAgentProgress(
        taskId,
        'Error Detective',
        `Analyzing error logs from ${errorSource}...`
      );

      // Build prompt for Error Detective
      const prompt = `# Error Detective - Real-Time Error Analysis

## Error Source
**System**: ${errorSource}
**Timestamp**: ${errorTimestamp}
**Received**: ${new Date().toISOString()}

## Error Logs
\`\`\`
${errorLogs}
\`\`\`

---

## 🎯 YOUR MISSION

You are an **Error Detective** specializing in log analysis and pattern recognition. Analyze these production errors and provide actionable insights.

---

## 📋 ANALYSIS WORKFLOW

### STEP 1: Parse Error Logs (2 minutes)

1. **Extract error types**:
\`\`\`bash
# Example: Identify error patterns
echo "${errorLogs}" | grep -E "Error|Exception|Fatal|Critical"
\`\`\`

2. **Identify stack traces**:
   - Language detection (Node.js, Python, Java, etc.)
   - Parse stack frames (file, function, line number)
   - Identify originating error vs propagated errors

3. **Extract key information**:
   - Error message
   - Error code/type
   - Affected endpoint/function
   - Request parameters (if available)
   - User/session ID (if available)

---

### STEP 2: Pattern Recognition (3 minutes)

**Error Categories** (identify which applies):
- **Syntax/Type Errors**: TypeError, SyntaxError, undefined references
- **Runtime Errors**: NullPointerException, division by zero, index out of bounds
- **Network Errors**: Timeout, connection refused, DNS resolution failure
- **Database Errors**: Connection pool exhausted, query timeout, constraint violation
- **Auth Errors**: Unauthorized, forbidden, token expired
- **Business Logic Errors**: Validation failure, state conflict, race condition
- **Infrastructure Errors**: Out of memory, disk full, CPU throttling

**Common Patterns**:
- Is this a **recurring error** (same stack trace)?
- Is this a **cascading failure** (one error triggering others)?
- Is this **environment-specific** (staging vs production)?
- Is this **time-based** (happens at specific times, e.g., daily cron)?
- Is this **load-based** (happens under high traffic)?

---

### STEP 3: Root Cause Analysis (5 minutes)

**Investigate these areas**:

1. **Code Analysis**:
   - Which file/function is throwing the error?
   - What was the code trying to do when it failed?
   - Are there recent changes (git commits) to this file?

2. **Data Analysis**:
   - What input caused the error?
   - Is it a null/undefined value?
   - Is it invalid data format?
   - Is it missing required fields?

3. **System Analysis**:
   - Is this a resource exhaustion issue? (memory, CPU, connections)
   - Is this a timeout issue? (slow database, external API)
   - Is this a configuration issue? (missing env var, wrong endpoint)

4. **Dependency Analysis**:
   - Is an external service down? (API, database, cache)
   - Is a package/library causing the issue?
   - Is there a version mismatch?

---

### STEP 4: Timeline Correlation (2 minutes)

**Build error timeline**:
- When did this error first appear?
- Has error frequency increased recently?
- Was there a deployment/change before this started?
- Are there related errors in the same time window?

**Example correlation**:
\`\`\`
10:30 AM - Deploy v2.1.5 (added new validation)
10:35 AM - First "ValidationError: email required" appears
10:40 AM - Error rate spikes to 50 req/min
Conclusion: New validation breaking existing users without email
\`\`\`

---

### STEP 5: Hypothesis Formation (3 minutes)

**Formulate root cause hypothesis**:

Based on evidence:
1. **Primary hypothesis**: Most likely cause (80%+ confidence)
2. **Alternative hypotheses**: Other possible causes (20% confidence each)
3. **Evidence supporting each**: Stack trace, logs, timing, etc.

**Example**:
\`\`\`
Primary: Database connection pool exhausted due to missing .release() calls
Evidence:
- Error: "Pool is full" after 10 concurrent requests
- Stack trace points to UserService.getUsers()
- No .release() call in catch block (code review needed)
- Started after deployment that added pagination to getUsers()

Alternative: Database is slow, causing connection timeout
Evidence:
- Some queries take >30s (seen in logs)
- But error appears even on simple SELECT queries
- Less likely (30% confidence)
\`\`\`

---

### STEP 6: Solution Recommendations (5 minutes)

Provide **immediate fixes** and **long-term prevention**:

**Immediate Fix** (can be applied now):
\`\`\`typescript
// BEFORE (broken)
async function getUsers() {
  const conn = await pool.getConnection();
  const users = await conn.query('SELECT * FROM users');
  return users; // ❌ Connection never released!
}

// AFTER (fixed)
async function getUsers() {
  const conn = await pool.getConnection();
  try {
    const users = await conn.query('SELECT * FROM users');
    return users;
  } finally {
    conn.release(); // ✅ Always release connection
  }
}
\`\`\`

**Long-Term Prevention**:
1. Add automated tests: \`test('connection is released on error', async () => { ... })\`
2. Add monitoring: Alert when connection pool usage > 80%
3. Add retry logic: Exponential backoff for transient failures
4. Add circuit breaker: Stop calling failing service after N failures

---

### STEP 7: Monitoring Queries (2 minutes)

**Provide queries to detect recurrence**:

**Elasticsearch query**:
\`\`\`json
{
  "query": {
    "bool": {
      "must": [
        { "match": { "level": "error" } },
        { "match": { "message": "Pool is full" } }
      ],
      "filter": {
        "range": { "@timestamp": { "gte": "now-1h" } }
      }
    }
  },
  "aggs": {
    "error_count": { "date_histogram": { "field": "@timestamp", "interval": "5m" } }
  }
}
\`\`\`

**Regex pattern for log parsing**:
\`\`\`regex
/Error:?\s+(.*?)\\n.*?at\s+(\\w+)\s+\\((.+?):(\\d+):(\\d+)\\)/
Groups: [1] error message, [2] function, [3] file, [4] line, [5] column
\`\`\`

---

## ✅ SUCCESS CRITERIA

You are successful when:
- ✅ Error type is clearly identified
- ✅ Root cause hypothesis is supported by evidence
- ✅ Immediate fix is provided (code examples)
- ✅ Prevention strategies are outlined
- ✅ Monitoring queries are ready to use

---

## 📊 OUTPUT FORMAT (MANDATORY JSON)

Output ONLY valid JSON:

\`\`\`json
{
  "errorAnalysis": {
    "errorType": "DatabaseConnectionPoolExhausted",
    "severity": "critical",
    "affectedComponent": "UserService.getUsers()",
    "firstOccurrence": "2025-01-14T10:35:00Z",
    "errorRate": "50 errors/min",
    "stackTrace": {
      "originatingFile": "src/services/UserService.ts",
      "originatingFunction": "getUsers",
      "originatingLine": 42,
      "language": "TypeScript/Node.js"
    }
  },
  "rootCause": {
    "primaryHypothesis": "Database connection pool exhausted - missing .release() in catch block",
    "confidence": 85,
    "evidence": [
      "Error message: 'Pool is full'",
      "Stack trace points to UserService.getUsers()",
      "Code review shows no .release() in catch block",
      "Started after deployment v2.1.5"
    ],
    "alternativeHypotheses": [
      {
        "hypothesis": "Database is slow causing timeout",
        "confidence": 30,
        "evidence": ["Some queries take >30s"]
      }
    ]
  },
  "immediateFix": {
    "description": "Add connection.release() in finally block",
    "codeChanges": [
      {
        "file": "src/services/UserService.ts",
        "function": "getUsers",
        "changeSummary": "Wrap query in try-finally, add conn.release() in finally block",
        "estimatedEffort": "5 minutes"
      }
    ]
  },
  "preventionStrategies": [
    "Add automated test for connection release on error",
    "Add monitoring for connection pool usage (alert at >80%)",
    "Implement connection pool timeout (max wait: 10s)",
    "Add circuit breaker for database calls"
  ],
  "monitoringQueries": {
    "elasticsearchQuery": "{ query: { match: { message: 'Pool is full' } } }",
    "regexPattern": "/Error.*Pool is full/i"
  },
  "actionableInsights": [
    "Fix missing .release() call in UserService.getUsers() - URGENT",
    "Review all database functions for missing .release() calls",
    "Add connection pool monitoring dashboard"
  ],
  "estimatedImpact": {
    "usersAffected": "~500-1000 users/hour",
    "businessImpact": "Cannot fetch user profiles, blocking login flow",
    "urgency": "critical"
  }
}
\`\`\`

---

## ⚠️ CRITICAL RULES

**DO**:
- ✅ Focus on **actionable findings** (what can be fixed NOW)
- ✅ Provide **code examples** for immediate fixes
- ✅ Include **both** immediate fixes AND long-term prevention
- ✅ Explain **WHY** the error happens, not just WHAT
- ✅ Extract **specific file:line locations** from stack traces

**DON'T**:
- ❌ Generic advice ("check logs", "restart server")
- ❌ Speculation without evidence
- ❌ Vague recommendations ("improve error handling")
- ❌ Skip root cause analysis

---

## 🚀 TIME BUDGET

- **Step 1 (Parse)**: 2 minutes
- **Step 2 (Patterns)**: 3 minutes
- **Step 3 (Root Cause)**: 5 minutes
- **Step 4 (Timeline)**: 2 minutes
- **Step 5 (Hypothesis)**: 3 minutes
- **Step 6 (Solutions)**: 5 minutes
- **Step 7 (Monitoring)**: 2 minutes

**TOTAL**: ~20 minutes for comprehensive error analysis

---

Start immediately with STEP 1. Be precise, be actionable, be fast.`;

      // Execute Error Detective agent
      const result = await this.executeAgentFn(
        'error-detective',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Error Detective',
        undefined, // sessionId
        undefined, // fork
        undefined // attachments
      );

      // Store results
      task.orchestration.errorDetective!.status = 'completed';
      task.orchestration.errorDetective!.completedAt = new Date();
      task.orchestration.errorDetective!.output = result.output;
      task.orchestration.errorDetective!.sessionId = result.sessionId;
      task.orchestration.errorDetective!.usage = result.usage;
      task.orchestration.errorDetective!.cost_usd = result.cost;

      // Parse JSON output to extract metrics
      let errorType = 'unknown';
      let severity = 'medium';
      let rootCauseConfidence = 0;
      try {
        const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/) ||
                         result.output.match(/\{[\s\S]*"errorAnalysis"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          errorType = parsed.errorAnalysis?.errorType || 'unknown';
          severity = parsed.errorAnalysis?.severity || 'medium';
          rootCauseConfidence = parsed.rootCause?.confidence || 0;

          task.orchestration.errorDetective!.errorType = errorType;
          task.orchestration.errorDetective!.severity = severity;
          task.orchestration.errorDetective!.rootCauseConfidence = rootCauseConfidence;
          task.orchestration.errorDetective!.actionableInsights = parsed.actionableInsights || [];
        }
      } catch (parseError) {
        console.warn('[ErrorDetective] Failed to parse JSON output:', parseError);
      }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      // 🔥 EVENT SOURCING: Emit completion event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'ErrorDetectiveCompleted',
        agentName: 'error-detective',
        payload: {
          output: result.output,
          errorType,
          severity,
          rootCauseConfidence,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [ErrorDetective] Emitted ErrorDetectiveCompleted event`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🔍 ERROR DETECTIVE - ANALYSIS COMPLETE\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Error Detective', result.output);

      // Notify completion
      NotificationService.emitAgentCompleted(
        taskId,
        'Error Detective',
        `Error analysis complete. Type: ${errorType}, Severity: ${severity}, Confidence: ${rootCauseConfidence}%`
      );

      await LogService.agentCompleted('error-detective' as any, taskId, {
        phase: 'analysis',
        metadata: {
          errorType,
          severity,
          rootCauseConfidence,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data for next phases
      context.setData('errorDetectiveComplete', true);
      context.setData('errorType', errorType);
      context.setData('severity', severity);
      context.setData('rootCauseAnalysis', result.output);

      return {
        success: true,
        data: {
          output: result.output,
          errorType,
          severity,
          rootCauseConfidence,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          confidence: rootCauseConfidence,
        },
      };
    } catch (error: any) {
      // Save error state
      task.orchestration.errorDetective!.status = 'failed';
      task.orchestration.errorDetective!.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Error Detective', error.message);

      await LogService.agentFailed('error-detective' as any, taskId, error, {
        phase: 'analysis',
      });

      // 🔥 EVENT SOURCING: Emit failure event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'ErrorDetectiveCompleted',
        agentName: 'error-detective',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [ErrorDetective] Emitted ErrorDetectiveCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Extract error logs from task description
   * Format: ERROR_LOGS: <logs>
   */
  private extractErrorLogs(description: string): string {
    const match = description.match(/ERROR_LOGS:\s*([\s\S]*?)(?:\n\n|$)/);
    return match ? match[1].trim() : description;
  }

  /**
   * Extract error source from task description
   * Format: ERROR_SOURCE: <source>
   */
  private extractErrorSource(description: string): string {
    const match = description.match(/ERROR_SOURCE:\s*(.+)/);
    return match ? match[1].trim() : 'Unknown System';
  }

  /**
   * Extract error timestamp from task description
   * Format: ERROR_TIMESTAMP: <timestamp>
   */
  private extractErrorTimestamp(description: string): string {
    const match = description.match(/ERROR_TIMESTAMP:\s*(.+)/);
    return match ? match[1].trim() : new Date().toISOString();
  }
}
