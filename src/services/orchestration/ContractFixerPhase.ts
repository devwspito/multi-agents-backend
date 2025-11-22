import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import crypto from 'crypto';

/**
 * Contract Fixer Phase
 *
 * Fixes frontend-backend integration issues detected by Contract Testing Phase.
 * Only executes when Contract Testing detects integration errors.
 *
 * Responsibilities:
 * 1. Receive integration error details from Contract Testing
 * 2. Analyze the root cause (missing endpoint, CORS, payload mismatch, etc.)
 * 3. Fix the issue (create routes, configure CORS, align payloads)
 * 4. Commit and push fixes
 * 5. Allow Contract Testing to retry
 *
 * SMART RETRY LOGIC:
 * - Allows multiple attempts if errors are DIFFERENT (different error hash)
 * - Limits to MAX_RETRIES (3) if the SAME error persists
 * - Allows continuation if unable to fix after max retries
 */
export class ContractFixerPhase extends BasePhase {
  readonly name = 'contract-fixer';
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
   * Skip if Contract Testing didn't fail OR if we've exceeded max retries for same error
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;
    const e2eErrors = context.getData<string>('e2eErrors');
    const e2eErrorType = context.getData<string>('e2eErrorType');
    const shouldRunFixer = context.getData<boolean>('shouldRunContractFixer');

    console.log(`🔧 [ContractFixer] shouldSkip() called - Checking context data:`, {
      hasE2eErrors: !!e2eErrors,
      e2eErrorsLength: e2eErrors?.length || 0,
      e2eErrorType: e2eErrorType,
      shouldRunFixer,
    });

    // Don't run if no errors or not explicitly requested
    if (!e2eErrors || !shouldRunFixer) {
      console.log(`❌ [SKIP] Contract Fixer will be skipped:`, {
        reason: !e2eErrors ? 'No contract errors found in context' : 'Not requested to run',
        e2eErrors: e2eErrors ? 'present' : 'missing',
        shouldRunFixer,
      });
      return true;
    }

    // Calculate error hash
    const currentErrorHash = this.calculateErrorHash(e2eErrors, e2eErrorType || 'unknown');

    // Get fixer state from task
    const fixerState = task.orchestration.contractFixer;
    const lastErrorHash = fixerState?.lastErrorHash;
    const attempts = fixerState?.attempts || 0;

    console.log(`🔧 [ContractFixer] Retry analysis:`, {
      currentErrorHash,
      lastErrorHash,
      attempts,
      maxRetries: this.MAX_RETRIES,
      errorChanged: currentErrorHash !== lastErrorHash,
    });

    // If error is DIFFERENT, allow retry (reset attempts)
    if (lastErrorHash && currentErrorHash !== lastErrorHash) {
      console.log(`✅ [ContractFixer] Error changed - allowing retry (resetting attempt counter)`);
      console.log(`   Old error hash: ${lastErrorHash}`);
      console.log(`   New error hash: ${currentErrorHash}`);
      return false; // Execute fixer
    }

    // If SAME error and exceeded max retries, skip
    if (attempts >= this.MAX_RETRIES && currentErrorHash === lastErrorHash) {
      console.log(`❌ [SKIP] Contract Fixer exceeded max retries (${this.MAX_RETRIES}) for same error`);
      console.log(`   Error hash: ${currentErrorHash}`);
      console.log(`   Will allow continuation with documented errors`);

      // Mark that we've given up, allow continuation
      context.setData('contractFixerGaveUp', true);
      context.setData('contractFixerMaxRetriesReached', true);

      return true; // Skip - we tried enough times
    }

    console.log(`✅ [ContractFixer] Will execute - attempt ${attempts + 1}/${this.MAX_RETRIES}`);
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

    console.log(`\n🔧 [ContractFixer] Starting Contract Fixer`);
    console.log(`   Error type: ${e2eErrorType}`);
    console.log(`   Error hash: ${currentErrorHash}`);
    console.log(`   Will attempt to fix integration issues`);

    // Initialize or update phase state
    if (!task.orchestration.contractFixer) {
      task.orchestration.contractFixer = {
        agent: 'contract-fixer',
        status: 'pending',
        attempts: 0,
        errorHistory: [],
      } as any;
    }

    // Check if error changed - reset attempts if so
    const lastErrorHash = task.orchestration.contractFixer!.lastErrorHash;
    if (lastErrorHash && lastErrorHash !== currentErrorHash) {
      console.log(`🔄 [ContractFixer] Error changed - resetting attempt counter`);
      task.orchestration.contractFixer!.attempts = 0;
    }

    // Increment attempts
    const currentAttempt = (task.orchestration.contractFixer!.attempts || 0) + 1;
    task.orchestration.contractFixer!.attempts = currentAttempt;
    task.orchestration.contractFixer!.lastErrorHash = currentErrorHash;

    console.log(`   Attempt: ${currentAttempt}/${this.MAX_RETRIES}`);

    // Record error in history
    if (!task.orchestration.contractFixer!.errorHistory) {
      task.orchestration.contractFixer!.errorHistory = [];
    }
    task.orchestration.contractFixer!.errorHistory.push({
      errorHash: currentErrorHash,
      errorType: e2eErrorType,
      attempt: currentAttempt,
      timestamp: new Date(),
    });

    const startTime = new Date();
    task.orchestration.contractFixer!.status = 'in_progress';
    task.orchestration.contractFixer!.startedAt = startTime;
    await task.save();

    NotificationService.emitAgentStarted(taskId, 'Contract Fixer');

    await LogService.agentStarted('contract-fixer', taskId, {
      phase: 'e2e',
      metadata: {
        errorType: e2eErrorType,
      },
    });

    try {
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

      // Build prompt for Contract Fixer
      const prompt = `You are the Contract Fixer Agent. The Contract Testing phase detected integration issues between frontend and backend.

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

Remember: Use tools immediately. Read files, Edit/Write fixes, Bash commit and push. Don't just describe what to do - DO IT.

**Contract Fixing Guidelines**:
- Prioritize fixing integration issues that block the entire flow (API contracts, shared types, communication)
- If there are multiple integration points failing, fix them in order of criticality
- Focus on making services communicate correctly - detailed error handling can come later
- Test your fixes incrementally if possible (fix one integration point, verify, move to next)`;

      // Execute Contract Fixer
      const result = await this.executeAgentFn(
        'contract-fixer',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Contract Fixer',
        undefined, // sessionId
        undefined  // fork
      );

      console.log(`✅ [ContractFixer] Fixer execution complete`);

      // Parse fixer output
      const parsed = this.parseFixerOutput(result.output || '');

      console.log(`📊 [ContractFixer] Parsed result:`, {
        fixed: parsed.fixed,
        filesModifiedCount: parsed.filesModified.length,
        changesCount: parsed.changes.length,
      });

      if (parsed.fixed) {
        console.log(`✅ [ContractFixer] Successfully fixed integration errors`);
        console.log(`   Files modified: ${parsed.filesModified.length > 0 ? parsed.filesModified.join(', ') : 'unknown'}`);

        // Update task with success
        task.orchestration.contractFixer!.status = 'completed';
        task.orchestration.contractFixer!.completedAt = new Date();
        task.orchestration.contractFixer!.output = result.output;
        task.orchestration.contractFixer!.sessionId = result.sessionId;
        task.orchestration.contractFixer!.usage = result.usage;
        task.orchestration.contractFixer!.cost_usd = result.cost;
        task.orchestration.contractFixer!.fixed = true;
        task.orchestration.contractFixer!.filesModified = parsed.filesModified;
        task.orchestration.contractFixer!.changes = parsed.changes;

        // Update costs
        task.orchestration.totalCost += result.cost;
        task.orchestration.totalTokens +=
          (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

        await task.save();

        NotificationService.emitAgentCompleted(
          taskId,
          'Contract Fixer',
          `Fixed ${e2eErrorType} errors: ${parsed.changes.length > 0 ? parsed.changes.join(', ') : 'See logs'}`
        );

        await LogService.agentCompleted('contract-fixer', taskId, {
          phase: 'e2e',
          metadata: {
            errorType: e2eErrorType,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
          },
        });

        // Mark to run Contract Testing again
        context.setData('shouldRunE2ETesting', true);
        context.setData('shouldRunContractFixer', false);

        return {
          success: true,
          data: {
            fixed: true,
            filesModified: parsed.filesModified,
            changes: parsed.changes,
            shouldRetryContractTesting: true,
          },
        };
      } else {
        console.log(`❌ [ContractFixer] Could not fix integration errors`);

        // Update task with failure
        task.orchestration.contractFixer!.status = 'failed';
        task.orchestration.contractFixer!.completedAt = new Date();
        task.orchestration.contractFixer!.output = result.output;
        task.orchestration.contractFixer!.error = 'Could not fix integration errors';
        task.orchestration.contractFixer!.fixed = false;
        await task.save();

        NotificationService.emitAgentMessage(
          taskId,
          'Contract Fixer',
          `⚠️ Contract Fixer attempted to fix ${e2eErrorType} errors but was unsuccessful. Integration issues will be documented in final report.`
        );

        await LogService.agentFailed('contract-fixer', taskId, new Error('Could not fix integration errors'), {
          phase: 'e2e',
        });

        // Mark that Contract Fixer failed on this attempt
        const attempts = task.orchestration.contractFixer!.attempts || 0;
        const maxRetriesReached = attempts >= this.MAX_RETRIES;

        context.setData('contractFixerFailed', true);
        context.setData('shouldRunContractFixer', false);

        if (maxRetriesReached) {
          console.log(`⚠️  [ContractFixer] Max retries reached (${this.MAX_RETRIES}) - allowing continuation with documented errors`);
          context.setData('contractFixerMaxRetriesReached', true);
          context.setData('shouldRunE2ETesting', false); // Don't retry Contract Testing
        } else {
          // Still have retries left, can try Contract Testing again
          context.setData('shouldRunE2ETesting', true);
        }

        return {
          success: false,
          error: maxRetriesReached
            ? 'Contract Fixer reached max retries - allowing continuation'
            : 'Contract Fixer could not resolve integration errors',
          data: {
            fixed: false,
            maxRetriesReached,
            shouldRetryContractTesting: !maxRetriesReached,
          },
        };
      }
    } catch (error: any) {
      console.error(`❌ [ContractFixer] Critical error: ${error.message}`);

      // Update task with error
      task.orchestration.contractFixer!.status = 'failed';
      task.orchestration.contractFixer!.completedAt = new Date();
      task.orchestration.contractFixer!.error = error.message;
      task.orchestration.contractFixer!.fixed = false;
      await task.save();

      await LogService.agentFailed('contract-fixer', taskId, error, {
        phase: 'e2e',
      });

      context.setData('contractFixerFailed', true);
      context.setData('e2eAttempt', 2);

      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Parse Contract Fixer output (expects JSON)
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
      console.warn(`⚠️ Failed to parse Contract Fixer output as JSON`);
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
