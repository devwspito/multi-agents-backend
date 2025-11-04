import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import crypto from 'crypto';

/**
 * E2E Fixer Phase
 *
 * Fixes frontend-backend integration issues detected by E2E Testing Phase.
 * Only executes when E2E Testing detects integration errors.
 *
 * Responsibilities:
 * 1. Receive integration error details from E2E Testing
 * 2. Analyze the root cause (missing endpoint, CORS, payload mismatch, etc.)
 * 3. Fix the issue (create routes, configure CORS, align payloads)
 * 4. Commit and push fixes
 * 5. Allow E2E Testing to retry
 *
 * SMART RETRY LOGIC:
 * - Allows multiple attempts if errors are DIFFERENT (different error hash)
 * - Limits to MAX_RETRIES (3) if the SAME error persists
 * - Allows continuation if unable to fix after max retries
 */
export class E2EFixerPhase extends BasePhase {
  readonly name = 'E2EFixer';
  readonly description = 'Fixing frontend-backend integration issues';
  private readonly MAX_RETRIES = 3;

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Calculate SHA-256 hash of error for tracking
   */
  private calculateErrorHash(errorOutput: string, errorType: string): string {
    const content = `${errorType}:${errorOutput}`;
    return crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  }

  /**
   * Skip if E2E didn't fail OR if we've exceeded max retries for same error
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;
    const e2eErrors = context.getData<string>('e2eErrors');
    const e2eErrorType = context.getData<string>('e2eErrorType');
    const shouldRunFixer = context.getData<boolean>('shouldRunE2EFixer');

    console.log(`🔧 [E2EFixer] shouldSkip() called - Checking context data:`, {
      hasE2eErrors: !!e2eErrors,
      e2eErrorsLength: e2eErrors?.length || 0,
      e2eErrorType: e2eErrorType,
      shouldRunFixer,
    });

    // Don't run if no errors or not explicitly requested
    if (!e2eErrors || !shouldRunFixer) {
      console.log(`❌ [SKIP] E2E Fixer will be skipped:`, {
        reason: !e2eErrors ? 'No E2E errors found in context' : 'Not requested to run',
        e2eErrors: e2eErrors ? 'present' : 'missing',
        shouldRunFixer,
      });
      return true;
    }

    // Calculate error hash
    const currentErrorHash = this.calculateErrorHash(e2eErrors, e2eErrorType || 'unknown');

    // Get fixer state from task
    const fixerState = task.orchestration.e2eFixer;
    const lastErrorHash = fixerState?.lastErrorHash;
    const attempts = fixerState?.attempts || 0;

    console.log(`🔧 [E2EFixer] Retry analysis:`, {
      currentErrorHash,
      lastErrorHash,
      attempts,
      maxRetries: this.MAX_RETRIES,
      errorChanged: currentErrorHash !== lastErrorHash,
    });

    // If error is DIFFERENT, allow retry (reset attempts)
    if (lastErrorHash && currentErrorHash !== lastErrorHash) {
      console.log(`✅ [E2EFixer] Error changed - allowing retry (resetting attempt counter)`);
      console.log(`   Old error hash: ${lastErrorHash}`);
      console.log(`   New error hash: ${currentErrorHash}`);
      return false; // Execute fixer
    }

    // If SAME error and exceeded max retries, skip
    if (attempts >= this.MAX_RETRIES && currentErrorHash === lastErrorHash) {
      console.log(`❌ [SKIP] E2E Fixer exceeded max retries (${this.MAX_RETRIES}) for same error`);
      console.log(`   Error hash: ${currentErrorHash}`);
      console.log(`   Will allow continuation with documented errors`);

      // Mark that we've given up, allow continuation
      context.setData('e2eFixerGaveUp', true);
      context.setData('e2eFixerMaxRetriesReached', true);

      return true; // Skip - we tried enough times
    }

    console.log(`✅ [E2EFixer] Will execute - attempt ${attempts + 1}/${this.MAX_RETRIES}`);
    console.log(`   Error type: ${e2eErrorType}`);
    console.log(`   Error hash: ${currentErrorHash}`);
    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const workspacePath = context.workspacePath;
    const repositories = context.repositories;

    const e2eErrors = context.getData<string>('e2eErrors');
    const e2eErrorType = context.getData<string>('e2eErrorType') || 'integration';

    // Calculate error hash
    const currentErrorHash = this.calculateErrorHash(e2eErrors || '', e2eErrorType);

    console.log(`\n🔧 [E2EFixer] Starting E2E Fixer`);
    console.log(`   Error type: ${e2eErrorType}`);
    console.log(`   Error hash: ${currentErrorHash}`);
    console.log(`   Will attempt to fix integration issues`);

    // Initialize or update phase state
    if (!task.orchestration.e2eFixer) {
      task.orchestration.e2eFixer = {
        agent: 'e2e-fixer',
        status: 'pending',
        attempts: 0,
        errorHistory: [],
      } as any;
    }

    // Check if error changed - reset attempts if so
    const lastErrorHash = task.orchestration.e2eFixer!.lastErrorHash;
    if (lastErrorHash && lastErrorHash !== currentErrorHash) {
      console.log(`🔄 [E2EFixer] Error changed - resetting attempt counter`);
      task.orchestration.e2eFixer!.attempts = 0;
    }

    // Increment attempts
    const currentAttempt = (task.orchestration.e2eFixer!.attempts || 0) + 1;
    task.orchestration.e2eFixer!.attempts = currentAttempt;
    task.orchestration.e2eFixer!.lastErrorHash = currentErrorHash;

    console.log(`   Attempt: ${currentAttempt}/${this.MAX_RETRIES}`);

    // Record error in history
    if (!task.orchestration.e2eFixer!.errorHistory) {
      task.orchestration.e2eFixer!.errorHistory = [];
    }
    task.orchestration.e2eFixer!.errorHistory.push({
      errorHash: currentErrorHash,
      errorType: e2eErrorType,
      attempt: currentAttempt,
      timestamp: new Date(),
    });

    const startTime = new Date();
    task.orchestration.e2eFixer!.status = 'in_progress';
    task.orchestration.e2eFixer!.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'E2E Fixer');

    await LogService.agentStarted('e2e-fixer', taskId, {
      phase: 'e2e',
      metadata: {
        errorType: e2eErrorType,
      },
    });

    try {
      // Build repository context
      const repoContext = repositories.map(repo => ({
        name: repo.githubRepoName.split('/').pop(),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? `${workspacePath}/${repo.githubRepoName.split('/').pop()}` : '',
      }));

      const frontendRepo = repoContext.find(r => r.type === 'frontend');
      const backendRepo = repoContext.find(r => r.type === 'backend');

      // Build prompt for E2E Fixer
      const prompt = `You are the E2E Fixer Agent. The E2E Tester detected integration issues between frontend and backend.

# Integration Errors Detected

${e2eErrors}

# Error Type
${e2eErrorType}

# Repositories

**Frontend:** ${frontendRepo?.name} (${frontendRepo?.path})
**Backend:** ${backendRepo?.name} (${backendRepo?.path})

# Your Mission

Fix the integration issues reported above. Follow these steps:

## 1. Analyze the Error

Understand what went wrong:
- Missing endpoint? (404)
- CORS issue? (Access-Control-Allow-Origin)
- Payload mismatch? (Field name differences)
- Method mismatch? (POST vs PUT)
- Configuration issue? (Wrong URL)

## 2. Investigate

Use tools to understand the problem:
\`\`\`bash
# Find frontend API calls
Grep("fetch\\(", "${frontendRepo?.path}/**/*.{js,jsx,ts,tsx}")

# Find backend routes
Grep("router\\.(get|post|put|delete)", "${backendRepo?.path}/**/*.{js,ts}")

# Read files
Read("${frontendRepo?.path}/src/components/File.jsx")
Read("${backendRepo?.path}/routes/file.js")
\`\`\`

## 3. Fix the Issue

Based on error type, apply the appropriate fix:

### For Missing Endpoints (404):
1. Read frontend file to see what endpoint it expects
2. Find backend routes file (routes/*.js or app.js)
3. Add the missing route with proper handler
4. Example:
\`\`\`javascript
router.post('/api/lessons/:id/esquema', async (req, res) => {
  const { id } = req.params;
  const { esquema } = req.body;
  try {
    const result = await saveEsquema(id, esquema);
    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
\`\`\`

### For CORS Issues:
1. Find backend entry file (app.js, server.js, index.js)
2. Add CORS configuration:
\`\`\`javascript
const cors = require('cors');
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
\`\`\`

### For Payload Mismatches:
1. Standardize field names (prefer camelCase)
2. Update either frontend or backend to match
3. Usually fix backend to accept frontend's format

### For Method Mismatches:
1. Change backend route method to match frontend
2. Or update frontend fetch call

## 4. Commit and Push

\`\`\`bash
cd ${backendRepo?.path}
git add .
git commit -m "fix(integration): resolve ${e2eErrorType} issue"
git push
\`\`\`

## 5. Output Results

**MANDATORY JSON Structure:**

\`\`\`json
{
  "fixed": true,
  "issuesFixed": [
    {
      "type": "missing-endpoint",
      "description": "Added missing POST /api/lessons/:id/esquema endpoint",
      "filesModified": ["routes/aula.js"],
      "changes": "Created route handler for esquema submission"
    }
  ],
  "filesModified": ["routes/aula.js"],
  "changes": ["Added POST /api/lessons/:id/esquema route"],
  "recommendations": ["Test endpoint with curl to verify"],
  "summary": "Fixed missing endpoint - backend now responds to frontend requests"
}
\`\`\`

If you cannot fix the issue:
\`\`\`json
{
  "fixed": false,
  "attemptedFixes": ["Tried to add route but encountered database dependency"],
  "recommendations": ["Requires database migration - manual intervention needed"],
  "summary": "Could not auto-fix: requires schema changes"
}
\`\`\`

Remember: Use tools immediately. Read files, Edit/Write fixes, Bash commit and push. Don't just describe what to do - DO IT.`;

      // Execute E2E Fixer
      const result = await this.executeAgentFn(
        'e2e-fixer',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'E2E Fixer',
        undefined, // sessionId
        undefined  // fork
      );

      console.log(`✅ [E2EFixer] Fixer execution complete`);

      // Parse fixer output
      const parsed = this.parseFixerOutput(result.output || '');

      console.log(`📊 [E2EFixer] Parsed result:`, {
        fixed: parsed.fixed,
        filesModifiedCount: parsed.filesModified.length,
        changesCount: parsed.changes.length,
      });

      if (parsed.fixed) {
        console.log(`✅ [E2EFixer] Successfully fixed integration errors`);
        console.log(`   Files modified: ${parsed.filesModified.length > 0 ? parsed.filesModified.join(', ') : 'unknown'}`);

        // Update task with success
        task.orchestration.e2eFixer!.status = 'completed';
        task.orchestration.e2eFixer!.completedAt = new Date();
        task.orchestration.e2eFixer!.output = result.output;
        task.orchestration.e2eFixer!.sessionId = result.sessionId;
        task.orchestration.e2eFixer!.usage = result.usage;
        task.orchestration.e2eFixer!.cost_usd = result.cost;
        task.orchestration.e2eFixer!.fixed = true;
        task.orchestration.e2eFixer!.filesModified = parsed.filesModified;
        task.orchestration.e2eFixer!.changes = parsed.changes;

        // Update costs
        task.orchestration.totalCost += result.cost;
        task.orchestration.totalTokens +=
          (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

        await task.save();

        NotificationService.emitAgentCompleted(
          taskId,
          'E2E Fixer',
          `Fixed ${e2eErrorType} errors: ${parsed.changes.length > 0 ? parsed.changes.join(', ') : 'See logs'}`
        );

        await LogService.agentCompleted('e2e-fixer', taskId, {
          phase: 'e2e',
          metadata: {
            errorType: e2eErrorType,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
          },
        });

        // Mark to run E2E Testing again
        context.setData('shouldRunE2ETesting', true);
        context.setData('shouldRunE2EFixer', false);

        return {
          success: true,
          data: {
            fixed: true,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
            shouldRetryE2E: true,
          },
        };
      } else {
        console.log(`❌ [E2EFixer] Could not fix integration errors`);

        // Update task with failure
        task.orchestration.e2eFixer!.status = 'failed';
        task.orchestration.e2eFixer!.completedAt = new Date();
        task.orchestration.e2eFixer!.output = result.output;
        task.orchestration.e2eFixer!.error = 'Could not fix integration errors';
        task.orchestration.e2eFixer!.fixed = false;
        await task.save();

        NotificationService.emitAgentMessage(
          taskId,
          'E2E Fixer',
          `⚠️ E2E Fixer attempted to fix ${e2eErrorType} errors but was unsuccessful. Integration issues will be documented in final report.`
        );

        await LogService.agentFailed('e2e-fixer', taskId, new Error('Could not fix integration errors'), {
          phase: 'e2e',
        });

        // Mark that E2E Fixer failed on this attempt
        const attempts = task.orchestration.e2eFixer!.attempts || 0;
        const maxRetriesReached = attempts >= this.MAX_RETRIES;

        context.setData('e2eFixerFailed', true);
        context.setData('shouldRunE2EFixer', false);

        if (maxRetriesReached) {
          console.log(`⚠️  [E2EFixer] Max retries reached (${this.MAX_RETRIES}) - allowing continuation with documented errors`);
          context.setData('e2eFixerMaxRetriesReached', true);
          context.setData('shouldRunE2ETesting', false); // Don't retry E2E
        } else {
          // Still have retries left, can try E2E Testing again
          context.setData('shouldRunE2ETesting', true);
        }

        return {
          success: false,
          error: maxRetriesReached
            ? 'E2E Fixer reached max retries - allowing continuation'
            : 'E2E Fixer could not resolve integration errors',
          data: {
            fixed: false,
            maxRetriesReached,
            shouldRetryE2E: !maxRetriesReached,
          },
        };
      }
    } catch (error: any) {
      console.error(`❌ [E2EFixer] Critical error: ${error.message}`);

      // Update task with error
      task.orchestration.e2eFixer!.status = 'failed';
      task.orchestration.e2eFixer!.completedAt = new Date();
      task.orchestration.e2eFixer!.error = error.message;
      task.orchestration.e2eFixer!.fixed = false;
      await task.save();

      await LogService.agentFailed('e2e-fixer', taskId, error, {
        phase: 'e2e',
      });

      context.setData('e2eFixerFailed', true);
      context.setData('e2eAttempt', 2);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Parse E2E Fixer output (expects JSON)
   */
  private parseFixerOutput(output: string): {
    fixed: boolean;
    changes: string[];
    filesModified: string[];
  } {
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);

        // Ensure changes and filesModified are always arrays
        const changes = Array.isArray(parsed.changes) ? parsed.changes :
                       (parsed.changes ? [parsed.changes] : []);
        const filesModified = Array.isArray(parsed.filesModified) ? parsed.filesModified :
                             (parsed.filesModified ? [parsed.filesModified] : []);

        return {
          fixed: parsed.fixed === true,
          changes,
          filesModified,
        };
      }
    } catch (error) {
      console.warn(`⚠️ Failed to parse E2E Fixer output as JSON`);
    }

    // Fallback: check if output says "fixed"
    const fixed = output.toLowerCase().includes('fixed') && !output.toLowerCase().includes('could not fix');

    return {
      fixed,
      changes: [],
      filesModified: []
    };
  }
}
