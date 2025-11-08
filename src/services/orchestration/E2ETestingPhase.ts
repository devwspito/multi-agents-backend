import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';

/**
 * E2E Testing Phase
 *
 * Tests real integration between frontend and backend when both repos are modified.
 * Only executes if task involves multiple repositories with cross-repo communication.
 *
 * Responsibilities:
 * 1. Detect if E2E testing is needed (frontend + backend changes)
 * 2. Analyze what endpoints were created/modified
 * 3. Setup both servers (backend + frontend)
 * 4. Execute real integration tests (API calls, UI interactions)
 * 5. Verify: endpoints exist, payloads correct, CORS works, auth works
 * 6. If errors detected → Call E2E Fixer
 * 7. Retry after fix
 */
export class E2ETestingPhase extends BasePhase {
  readonly name = 'e2e-testing';
  readonly description = 'Testing real frontend-backend integration';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if not multi-repo or if E2E already completed
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
      console.log(`[SKIP] E2E Testing - Only ${repositories.length} repository, no integration needed`);
      return true;
    }

    // Check if we have frontend + backend
    const hasFrontend = repositories.some(r => r.type === 'frontend');
    const hasBackend = repositories.some(r => r.type === 'backend');

    if (!hasFrontend || !hasBackend) {
      console.log(`[SKIP] E2E Testing - Missing frontend or backend repo (frontend: ${hasFrontend}, backend: ${hasBackend})`);
      return true;
    }

    // 🔄 CONTINUATION: Never skip - always re-execute to test new changes
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [E2ETesting] This is a CONTINUATION - will re-execute to test integration`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed
    if (context.task.orchestration.e2eTesting?.status === 'completed') {
      console.log(`[SKIP] E2E Testing already completed - skipping re-execution (recovery mode)`);

      // Restore phase data
      if (context.task.orchestration.e2eTesting.output) {
        context.setData('e2eTestingOutput', context.task.orchestration.e2eTesting.output);
      }
      context.setData('e2eTestingComplete', true);

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

    console.log(`\n🔗 [E2ETesting] Starting E2E integration testing`);
    console.log(`   Frontend + Backend integration test`);
    console.log(`   Repositories: ${repositories.length}`);

    // Initialize phase state
    if (!task.orchestration.e2eTesting) {
      task.orchestration.e2eTesting = {
        agent: 'e2e-tester',
        status: 'pending',
      } as any;
    }

    const startTime = new Date();
    task.orchestration.e2eTesting!.status = 'in_progress';
    task.orchestration.e2eTesting!.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'E2E Tester');

    await LogService.agentStarted('e2e-tester', taskId, {
      phase: 'e2e',
      metadata: {
        repositoryCount: repositories.length,
      },
    });

    try {
      // Get epics from context to understand what was implemented
      const epics = context.getData<any[]>('epics') || [];

      // Build epic summary for E2E tester
      const epicSummary = epics.map(epic => ({
        title: epic.title,
        description: epic.description,
        targetRepository: epic.targetRepository,
      }));

      // Build repository context
      const repoContext = repositories.map(repo => ({
        name: repo.githubRepoName.split('/').pop(),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? `${workspacePath}/${repo.githubRepoName.split('/').pop()}` : '',
        hasEnvVariables: repo.envVariables && repo.envVariables.length > 0,
      }));

      const frontendRepo = repoContext.find(r => r.type === 'frontend');
      const backendRepo = repoContext.find(r => r.type === 'backend');

      // Build prompt for E2E tester
      const prompt = `You are an E2E Testing Engineer specializing in frontend-backend integration testing.

# Task Context
**Task:** ${task.title}
**Description:** ${task.description}

# Repositories Available
${repoContext.map(r => `- **${r.name}** (${r.type}): ${r.path}
  - Env variables: ${r.hasEnvVariables ? '✅ Configured' : '❌ Not configured'}`).join('\n')}

# What Was Implemented (Epics)
${epicSummary.map((e, i) => `${i + 1}. **${e.title}** (${e.targetRepository})
   ${e.description}`).join('\n\n')}

# Your Mission

Test the **REAL INTEGRATION** between frontend and backend.

## Step-by-Step Process

### 1. Analyze Implementation
- Read backend route files to find new/modified endpoints
- Read frontend API call files to understand what the frontend expects
- Identify the contract: URLs, methods (GET/POST/PUT/DELETE), payloads, responses

### 2. Setup Servers
**Backend (${backendRepo?.name}):**
\`\`\`bash
cd ${backendRepo?.path}
# Environment variables are already injected in .env file
# Start backend server (detect stack first)
npm start || python app.py || java -jar target/*.jar || php artisan serve
\`\`\`

**Frontend (${frontendRepo?.name}):**
\`\`\`bash
cd ${frontendRepo?.path}
# Ensure frontend points to backend
# Check for API_URL or VITE_API_URL in .env
# Start frontend
npm run dev || npm start
\`\`\`

### 3. Execute Integration Tests

Test these scenarios:

**A. Endpoint Existence**
\`\`\`bash
# Test that endpoints respond (not 404)
curl http://localhost:8000/api/endpoint -v
\`\`\`

**B. Payload Validation**
- Send POST/PUT requests with the payload frontend sends
- Verify backend accepts it (no 400/422 validation errors)

**C. Response Format**
- Verify backend returns the format frontend expects
- Check field names match (camelCase vs snake_case)

**D. CORS Configuration**
- Verify frontend can call backend (no CORS errors)

**E. Authentication Flow**
- If endpoints require auth, test with valid tokens

### 4. Report Results

**Output JSON Format:**
\`\`\`json
{
  "integrationPass": true | false,
  "backendStarted": true | false,
  "frontendStarted": true | false,
  "endpointsTested": [
    {
      "method": "POST",
      "url": "/api/aula/lessons/:id/esquema",
      "status": 200 | 404 | 500,
      "success": true | false,
      "error": "404 Not Found - endpoint does not exist"
    }
  ],
  "corsIssues": [],
  "payloadMismatches": [
    {
      "endpoint": "/api/endpoint",
      "issue": "Backend expects 'user_id' but frontend sends 'userId'",
      "severity": "critical"
    }
  ],
  "authIssues": [],
  "recommendations": [
    "Fix endpoint route in backend: /api/aula/lessons/:id/esquema",
    "Add CORS origin for http://localhost:3000"
  ],
  "summary": "Integration test summary"
}
\`\`\`

## Critical Rules

1. **ALWAYS start both servers** - don't just analyze code
2. **Test REAL HTTP requests** - use curl or fetch
3. **If endpoints return 404 → FAILURE** - document exact URL that failed
4. **If CORS errors → FAILURE** - document origin issue
5. **If payload mismatch → FAILURE** - document field differences

## What to Look For

### Common Issues:
- ❌ Endpoint path mismatch (frontend calls /api/v1/user, backend has /api/users)
- ❌ HTTP method mismatch (frontend sends POST, backend expects PUT)
- ❌ Field name mismatch (camelCase vs snake_case)
- ❌ Missing CORS configuration
- ❌ Authentication not working (missing/invalid tokens)
- ❌ Port mismatch in frontend config

### Success Criteria:
- ✅ Backend starts without errors
- ✅ Frontend starts without errors
- ✅ All API calls return expected status codes (200, 201, etc.)
- ✅ Payloads are accepted by backend
- ✅ Responses match frontend expectations
- ✅ No CORS errors
- ✅ Authentication works (if applicable)

Remember: You are testing REAL integration. Start the servers, make the calls, verify the responses. Don't just read code - execute and test.

**E2E Testing Guidelines**:
- Test the most critical integration flows first (main user journeys, critical APIs)
- If setup/installation is taking too long (>3 minutes), document the delay and continue with available tests
- Focus on end-to-end functionality - detailed unit testing is not your responsibility
- If you find blocking issues, you can stop early and report NO-GO
- Document what you tested and what you couldn't test due to time/environment constraints`;

      // Execute E2E tester
      const result = await this.executeAgentFn(
        'e2e-tester',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'E2E Tester',
        undefined, // sessionId
        undefined, // fork
        undefined  // attachments
      );

      console.log(`✅ [E2ETesting] E2E testing complete`);

      // Parse results
      const integrationPass = this.detectE2ESuccess(result.output);

      // Store results
      task.orchestration.e2eTesting!.output = result.output;
      task.orchestration.e2eTesting!.sessionId = result.sessionId;
      task.orchestration.e2eTesting!.usage = result.usage;
      task.orchestration.e2eTesting!.cost_usd = result.cost;
      task.orchestration.e2eTesting!.integrationPass = integrationPass;

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🔗 E2E TESTING - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Check if E2E detected integration errors
      const e2eAttempt = context.getData<number>('e2eAttempt') || 1;
      const hasErrors = !integrationPass;

      if (hasErrors && e2eAttempt === 1) {
        // ❌ E2E FAILED ON ATTEMPT 1 → Call E2E Fixer
        console.log(`❌ [E2ETesting] Detected integration errors on attempt 1 - calling E2E Fixer`);

        const errorDetails = this.extractE2EErrors(result.output);

        context.setData('e2eErrors', errorDetails.errorOutput);
        context.setData('e2eErrorType', errorDetails.errorType);
        context.setData('e2eAttempt', 1);

        NotificationService.emitAgentMessage(
          taskId,
          'E2E Tester',
          `⚠️ E2E detected ${errorDetails.errorType} errors. Calling E2E Fixer to resolve...`
        );

        await LogService.warn(`E2E detected integration errors - E2E Fixer will attempt fix`, {
          taskId,
          category: 'integration',
          phase: 'e2e',
          metadata: {
            errorType: errorDetails.errorType,
            attempt: 1,
          },
        });

        task.orchestration.e2eTesting!.status = 'completed';
        task.orchestration.e2eTesting!.completedAt = new Date();
        await task.save();

        // Return success so E2E Fixer phase executes
        return {
          success: true,
          data: {
            e2eAttempt: 1,
            hasErrors: true,
            errorType: errorDetails.errorType,
          },
        };
      }

      // ✅ E2E PASSED OR ATTEMPT 2
      task.orchestration.e2eTesting!.status = 'completed';
      task.orchestration.e2eTesting!.completedAt = new Date();
      await task.save();

      NotificationService.emitAgentCompleted(
        taskId,
        'E2E Tester',
        integrationPass
          ? `✅ Integration test passed - frontend and backend communicate correctly`
          : `⚠️ Integration test completed with warnings (attempt ${e2eAttempt})`
      );

      await LogService.agentCompleted('e2e-tester', taskId, {
        phase: 'e2e',
        metadata: {
          integrationPass,
          attempt: e2eAttempt,
        },
      });

      context.setData('e2eTestingComplete', true);
      context.setData('e2eIntegrationPass', integrationPass);

      return {
        success: true,
        data: {
          integrationPass,
          output: result.output,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
        },
      };

    } catch (error: any) {
      console.error(`❌ [E2ETesting] Failed: ${error.message}`);

      task.orchestration.e2eTesting!.status = 'failed';
      task.orchestration.e2eTesting!.completedAt = new Date();
      task.orchestration.e2eTesting!.error = error.message;
      await task.save();

      NotificationService.emitAgentFailed(taskId, 'E2E Tester', error.message);

      await LogService.agentFailed('e2e-tester', taskId, error, {
        phase: 'e2e',
      });

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Detect if E2E tests passed
   */
  private detectE2ESuccess(e2eOutput: string): boolean {
    const lowerOutput = e2eOutput.toLowerCase();

    // Look for success indicators
    if (lowerOutput.includes('"integrationpass": true')) {
      return true;
    }

    // Look for failure indicators
    const failureIndicators = [
      '"integrationpass": false',
      '404 not found',
      'endpoint does not exist',
      'cors error',
      'payload mismatch',
      'backend failed to start',
      'frontend failed to start',
      'connection refused',
      'econnrefused',
    ];

    return !failureIndicators.some(indicator => lowerOutput.includes(indicator));
  }

  /**
   * Extract E2E error details
   */
  private extractE2EErrors(e2eOutput: string): {
    errorType: string;
    errorOutput: string;
  } {
    const lowerOutput = e2eOutput.toLowerCase();

    // Determine error type
    let errorType = 'integration';
    if (lowerOutput.includes('404') || lowerOutput.includes('endpoint does not exist')) {
      errorType = 'endpoint-not-found';
    } else if (lowerOutput.includes('cors')) {
      errorType = 'cors';
    } else if (lowerOutput.includes('payload mismatch') || lowerOutput.includes('field')) {
      errorType = 'payload-mismatch';
    } else if (lowerOutput.includes('auth')) {
      errorType = 'authentication';
    }

    // Extract relevant error section
    let errorOutput = e2eOutput;
    const summaryIndex = e2eOutput.indexOf('## Summary');
    if (summaryIndex > 0) {
      errorOutput = e2eOutput.substring(0, summaryIndex);
    }

    // Truncate if too long
    if (errorOutput.length > 3000) {
      errorOutput = errorOutput.substring(0, 3000) + '\n\n... (truncated)';
    }

    return { errorType, errorOutput };
  }
}
