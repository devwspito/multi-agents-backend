import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * Contract Testing Phase
 *
 * Lightweight alternative to E2E Testing - verifies API contracts WITHOUT starting servers.
 * Analyzes code to ensure frontend and backend communicate correctly.
 *
 * What it does:
 * 1. ✅ Reads backend routes/controllers to find API endpoints
 * 2. ✅ Reads frontend API calls (axios, fetch) to understand expectations
 * 3. ✅ Verifies contracts match: URLs, HTTP methods, payloads, response formats
 * 4. ✅ Detects common issues: 404s, CORS config, field mismatches (camelCase vs snake_case)
 * 5. ✅ Fast execution (~2-3 minutes, no server startup)
 *
 * What it does NOT do:
 * ❌ Does NOT start servers (avoids timeouts/hangs)
 * ❌ Does NOT execute real HTTP requests
 * ❌ Does NOT test runtime behavior
 *
 * Responsibilities:
 * - Static analysis of API contracts
 * - Detect integration issues before deployment
 * - If errors detected → Call Contract Fixer
 * - Retry after fix
 */
export class ContractTestingPhase extends BasePhase {
  readonly name = 'contract-testing';
  readonly description = 'Verifying API contracts (static analysis)';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if not multi-repo or if already completed
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;
    const repositories = context.repositories;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // Skip if only 1 repository
    if (repositories.length < 2) {
      console.log(`[SKIP] Contract Testing - Only ${repositories.length} repository, no integration needed`);
      return true;
    }

    // Check if we have frontend + backend
    const hasFrontend = repositories.some(r => r.type === 'frontend');
    const hasBackend = repositories.some(r => r.type === 'backend');

    if (!hasFrontend || !hasBackend) {
      console.log(`[SKIP] Contract Testing - Missing frontend or backend repo (frontend: ${hasFrontend}, backend: ${hasBackend})`);
      return true;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute to test new changes
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [ContractTesting] This is a CONTINUATION - will re-execute to verify contracts`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed
    if (context.task.orchestration.contractTesting?.status === 'completed') {
      console.log(`[SKIP] Contract Testing already completed - skipping re-execution (recovery mode)`);

      // Restore phase data
      if (context.task.orchestration.contractTesting.output) {
        context.setData('contractTestingOutput', context.task.orchestration.contractTesting.output);
      }
      context.setData('contractTestingComplete', true);

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
    const repositories = context.repositories;

    console.log(`\n📋 [ContractTesting] Starting API contract verification`);
    console.log(`   Static analysis only (no server startup)`);
    console.log(`   Repositories: ${repositories.length}`);

    // Initialize phase state
    if (!task.orchestration.contractTesting) {
      task.orchestration.contractTesting = {
        agent: 'contract-tester',
        status: 'pending',
      } as any;
    }

    const startTime = new Date();
    task.orchestration.contractTesting!.status = 'in_progress';
    task.orchestration.contractTesting!.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Contract Tester');

    await LogService.agentStarted('contract-tester', taskId, {
      phase: 'contract-testing',
      metadata: {
        repositoryCount: repositories.length,
      },
    });

    try {
      // Get epics from context to understand what was implemented
      const epics = context.getData<any[]>('epics') || [];

      // Build epic summary for contract tester
      const epicSummary = epics.map(epic => ({
        title: epic.title,
        description: epic.description,
        targetRepository: epic.targetRepository,
      }));

      // Build repository context
      const { normalizeRepoName } = require('../../utils/safeGitExecution');
      const repoContext = repositories.map(repo => ({
        name: normalizeRepoName(repo.githubRepoName.split('/').pop() || ''),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? `${workspacePath}/${normalizeRepoName(repo.githubRepoName.split('/').pop() || '')}` : '',
      }));

      const frontendRepo = repoContext.find(r => r.type === 'frontend');
      const backendRepo = repoContext.find(r => r.type === 'backend');

      // Build prompt for contract tester
      const prompt = `You are an API Contract Verification Engineer specializing in frontend-backend integration analysis.

# Task Context
**Task:** ${task.title}
**Description:** ${task.description}

# Repositories Available
${repoContext.map(r => `- **${r.name}** (${r.type}): ${r.path}`).join('\n')}

# What Was Implemented (Epics)
${epicSummary.map((e, i) => `${i + 1}. **${e.title}** (${e.targetRepository})
   ${e.description}`).join('\n\n')}

# Your Mission

Verify API contracts between frontend and backend through **STATIC CODE ANALYSIS ONLY**.

## ⚠️ CRITICAL: DO NOT START SERVERS
- ❌ Do NOT run \`npm start\`, \`npm run dev\`, or any server commands
- ❌ Do NOT execute HTTP requests (curl, fetch)
- ✅ DO analyze code files only

## Step-by-Step Process

### 1. Find Backend API Endpoints

**Backend (${backendRepo?.name}):**
\`\`\`bash
cd ${backendRepo?.path}

# Find route definitions
find . -name "*.ts" -o -name "*.js" | grep -E "(route|controller|api)" | head -20

# Read route files to extract:
# - Endpoint paths (e.g., /api/users, /api/posts/:id)
# - HTTP methods (GET, POST, PUT, DELETE)
# - Expected request payloads
# - Response formats
\`\`\`

Common patterns to look for:
\`\`\`javascript
// Express.js
router.post('/api/users', createUser);
app.get('/api/posts/:id', getPost);

// FastAPI (Python)
@app.post("/api/users")
def create_user(user: User):

// Django
path('api/users/', views.create_user)
\`\`\`

### 2. Find Frontend API Calls

**Frontend (${frontendRepo?.name}):**
\`\`\`bash
cd ${frontendRepo?.path}

# Find API service files
find . -name "*api*" -o -name "*service*" | grep -E "\.(ts|js|tsx|jsx)$" | head -20

# Read to extract:
# - API call URLs
# - HTTP methods
# - Payloads sent
# - Expected responses
\`\`\`

Common patterns:
\`\`\`javascript
// Axios
axios.post('/api/users', { name, email });
axios.get(\`/api/posts/\${id}\`);

// Fetch
fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });

// React Query
const { data } = useQuery('/api/posts');
\`\`\`

### 3. Verify Contracts Match

For each API interaction, verify:

**A. Endpoint Existence**
- Frontend calls: \`/api/users\`
- Backend has: \`/api/users\` ✅ or \`/api/user\` ❌

**B. HTTP Method Match**
- Frontend: \`POST /api/posts\`
- Backend: \`POST /api/posts\` ✅ or \`PUT /api/posts\` ❌

**C. Payload Structure**
- Frontend sends: \`{ userId: 123, postTitle: "..." }\`
- Backend expects: \`{ user_id: 123, post_title: "..." }\`
- ❌ Field name mismatch (camelCase vs snake_case)

**D. CORS Configuration**
\`\`\`bash
cd ${backendRepo?.path}

# Search for CORS setup
grep -r "cors" . --include="*.ts" --include="*.js" --include="*.py"

# Verify:
# - CORS middleware is configured
# - Allowed origins include frontend URL
\`\`\`

**E. Environment Variables**
- Check frontend has \`VITE_API_URL\` or \`REACT_APP_API_URL\`
- Check backend has required env vars (DATABASE_URL, etc.)

### 4. Report Results

**Output JSON Format:**
\`\`\`json
{
  "contractsValid": true | false,
  "backendEndpoints": [
    {
      "method": "POST",
      "path": "/api/users",
      "file": "src/routes/users.ts",
      "line": 42,
      "expectedPayload": "{ name: string, email: string }",
      "responseFormat": "{ id: number, name: string, email: string }"
    }
  ],
  "frontendCalls": [
    {
      "method": "POST",
      "path": "/api/users",
      "file": "src/services/api.ts",
      "line": 15,
      "payload": "{ name, email }",
      "expectedResponse": "{ id, name, email }"
    }
  ],
  "contractIssues": [
    {
      "type": "endpoint-not-found",
      "severity": "critical",
      "frontendCall": "POST /api/lessons/:id/esquema",
      "backendEndpoint": "NOT FOUND",
      "fix": "Add route in backend: router.post('/api/lessons/:id/esquema', handler)"
    },
    {
      "type": "payload-mismatch",
      "severity": "critical",
      "endpoint": "POST /api/users",
      "frontendSends": "{ userId: 123 }",
      "backendExpects": "{ user_id: 123 }",
      "fix": "Change backend to accept camelCase or frontend to use snake_case"
    }
  ],
  "corsConfigured": true | false,
  "envVariablesConfigured": {
    "frontend": true | false,
    "backend": true | false
  },
  "recommendations": [
    "Add missing endpoint: POST /api/lessons/:id/esquema in backend",
    "Configure CORS to allow http://localhost:3000",
    "Standardize field naming: use camelCase consistently"
  ],
  "summary": "Contract verification summary"
}
\`\`\`

## Critical Rules

1. ✅ **ONLY analyze code** - read files with Read, Grep, Glob
2. ❌ **NEVER start servers** - no npm start, npm run dev, or similar
3. ❌ **NEVER execute HTTP requests** - no curl, fetch, or network calls
4. ✅ **Focus on contract mismatches** - endpoints, methods, payloads, field names
5. ✅ **Be fast** - this should take 2-3 minutes maximum

## Common Issues to Detect

- ❌ Endpoint path mismatch (frontend: \`/api/v1/user\`, backend: \`/api/users\`)
- ❌ HTTP method mismatch (frontend: POST, backend: PUT)
- ❌ Field name mismatch (camelCase vs snake_case)
- ❌ Missing CORS configuration
- ❌ Missing environment variables
- ❌ Port mismatch in frontend config

## Success Criteria

- ✅ All frontend API calls have corresponding backend endpoints
- ✅ HTTP methods match
- ✅ Payload structures are compatible
- ✅ CORS is configured
- ✅ Environment variables are set

Remember: This is STATIC ANALYSIS. You verify contracts by reading code, not by executing servers or HTTP requests.`;

      // Execute contract tester
      const result = await this.executeAgentFn(
        'contract-tester',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Contract Tester',
        undefined, // sessionId
        undefined, // fork
        undefined  // attachments
      );

      console.log(`✅ [ContractTesting] Contract verification complete`);

      // Parse results
      const contractsValid = this.detectContractSuccess(result.output);

      // Store results
      task.orchestration.contractTesting!.output = result.output;
      task.orchestration.contractTesting!.sessionId = result.sessionId;
      task.orchestration.contractTesting!.usage = result.usage;
      task.orchestration.contractTesting!.cost_usd = result.cost;
      task.orchestration.contractTesting!.contractsValid = contractsValid;

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n📋 CONTRACT TESTING - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Check if contract testing detected integration errors
      const contractAttempt = context.getData<number>('contractAttempt') || 1;
      const hasErrors = !contractsValid;

      if (hasErrors && contractAttempt === 1) {
        // ❌ CONTRACT FAILED ON ATTEMPT 1 → Call Contract Fixer
        console.log(`❌ [ContractTesting] Detected contract mismatches on attempt 1 - calling Contract Fixer`);

        const errorDetails = this.extractContractErrors(result.output);

        context.setData('e2eErrors', errorDetails.errorOutput);
        context.setData('e2eErrorType', errorDetails.errorType);
        context.setData('e2eAttempt', 1);

        NotificationService.emitAgentMessage(
          taskId,
          'Contract Tester',
          `⚠️ Contract testing detected ${errorDetails.errorType} errors. Calling Contract Fixer to resolve...`
        );

        await LogService.warn(`Contract testing detected integration errors - Contract Fixer will attempt fix`, {
          taskId,
          category: 'integration',
          phase: 'contract-testing',
          metadata: {
            errorType: errorDetails.errorType,
            attempt: 1,
          },
        });

        task.orchestration.contractTesting!.status = 'completed';
        task.orchestration.contractTesting!.completedAt = new Date();
        await task.save();

        // Return success so Contract Fixer phase executes
        return {
          success: true,
          data: {
            contractAttempt: 1,
            hasErrors: true,
            errorType: errorDetails.errorType,
          },
        };
      }

      // ✅ CONTRACT PASSED OR ATTEMPT 2
      task.orchestration.contractTesting!.status = 'completed';
      task.orchestration.contractTesting!.completedAt = new Date();
      await task.save();

      NotificationService.emitAgentCompleted(
        taskId,
        'Contract Tester',
        contractsValid
          ? `✅ API contracts verified - frontend and backend interfaces match`
          : `⚠️ Contract verification completed with warnings (attempt ${contractAttempt})`
      );

      await LogService.agentCompleted('contract-tester', taskId, {
        phase: 'contract-testing',
        metadata: {
          contractsValid,
          attempt: contractAttempt,
        },
      });

      context.setData('contractTestingComplete', true);
      context.setData('contractsValid', contractsValid);

      return {
        success: true,
        data: {
          contractsValid,
          output: result.output,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      };

    } catch (error: any) {
      console.error(`❌ [ContractTesting] Failed: ${error.message}`);

      task.orchestration.contractTesting!.status = 'failed';
      task.orchestration.contractTesting!.completedAt = new Date();
      task.orchestration.contractTesting!.error = error.message;
      await task.save();

      NotificationService.emitAgentFailed(taskId, 'Contract Tester', error.message);

      await LogService.agentFailed('contract-tester', taskId, error, {
        phase: 'contract-testing',
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Detect if contract verification passed
   */
  private detectContractSuccess(contractOutput: string): boolean {
    const lowerOutput = contractOutput.toLowerCase();

    // Look for success indicators
    if (lowerOutput.includes('"contractsvalid": true')) {
      return true;
    }

    // Look for failure indicators
    const failureIndicators = [
      '"contractsvalid": false',
      'endpoint-not-found',
      'endpoint not found',
      'payload-mismatch',
      'payload mismatch',
      'method mismatch',
      'cors not configured',
      'missing cors',
      'critical',
    ];

    return !failureIndicators.some(indicator => lowerOutput.includes(indicator));
  }

  /**
   * Extract contract error details
   */
  private extractContractErrors(contractOutput: string): {
    errorType: string;
    errorOutput: string;
  } {
    const lowerOutput = contractOutput.toLowerCase();

    // Determine error type
    let errorType = 'contract-mismatch';
    if (lowerOutput.includes('endpoint-not-found') || lowerOutput.includes('endpoint not found')) {
      errorType = 'endpoint-not-found';
    } else if (lowerOutput.includes('cors')) {
      errorType = 'cors';
    } else if (lowerOutput.includes('payload-mismatch') || lowerOutput.includes('payload mismatch')) {
      errorType = 'payload-mismatch';
    } else if (lowerOutput.includes('method mismatch')) {
      errorType = 'method-mismatch';
    }

    // Extract relevant error section
    let errorOutput = contractOutput;
    const summaryIndex = contractOutput.indexOf('## Summary');
    if (summaryIndex > 0) {
      errorOutput = contractOutput.substring(0, summaryIndex);
    }

    // Truncate if too long
    if (errorOutput.length > 3000) {
      errorOutput = errorOutput.substring(0, 3000) + '\n\n... (truncated)';
    }

    return { errorType, errorOutput };
  }
}
