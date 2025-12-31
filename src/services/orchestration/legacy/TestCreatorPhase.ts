import { BasePhase, OrchestrationContext, PhaseResult } from './Phase';
import { NotificationService } from '../NotificationService';
import { LogService } from '../logging/LogService';
import path from 'path';

/**
 * Test Creator Phase
 *
 * Creates comprehensive test suites BEFORE QA validation
 * - Analyzes developer code from epic branches
 * - Identifies untested functions/components
 * - Creates tests following testing pyramid (70% unit, 20% integration, 10% E2E)
 * - Writes test files to appropriate locations
 * - Commits and pushes tests to epic branches
 *
 * This ensures QA and Contract Testing have tests to execute/validate
 */
export class TestCreatorPhase extends BasePhase {
  readonly name = 'TestCreator';
  readonly description = 'Creating comprehensive test suites';

  constructor(private executeAgentFn: Function) {
    super();
  }

  /**
   * Skip if TestCreator already completed (recovery mode only)
   */
  async shouldSkip(context: OrchestrationContext): Promise<boolean> {
    const task = context.task;

    // Refresh task from DB
    const Task = require('../../models/Task').Task;
    const freshTask = await Task.findById(task._id);
    if (freshTask) {
      context.task = freshTask;
    }

    // 🔄 CONTINUATION: Never skip - always create tests for new code
    const isContinuation = context.task.orchestration.continuations &&
                          context.task.orchestration.continuations.length > 0;

    if (isContinuation) {
      console.log(`🔄 [TestCreator] This is a CONTINUATION - will create tests for new code`);
      return false; // DO NOT SKIP
    }

    // 🛠️ RECOVERY: Skip if already completed (orchestration interrupted and restarting)
    if (context.task.orchestration.testCreator?.status === 'completed') {
      console.log(`[SKIP] TestCreator already completed - skipping re-execution (recovery mode)`);

      // Restore phase data from previous execution
      if (context.task.orchestration.testCreator.output) {
        context.setData('testCreatorOutput', context.task.orchestration.testCreator.output);
      }
      context.setData('testCreatorComplete', true);

      return true;
    }

    return false;
  }

  protected async executePhase(
    context: OrchestrationContext
  ): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
    const task = context.task;
    const taskId = (task._id as any).toString();
    const repositories = context.repositories;
    const workspacePath = context.workspacePath;

    await LogService.info('TestCreator phase started - Creating comprehensive test suites', {
      taskId,
      category: 'orchestration',
      phase: 'qa',
    });

    // Track start time
    const startTime = new Date();

    // Initialize TestCreator state
    if (!task.orchestration.testCreator) {
      task.orchestration.testCreator = {
        agent: 'test-creator',
        status: 'pending',
      } as any;
    }

    task.orchestration.testCreator!.status = 'in_progress';
    task.orchestration.testCreator!.startedAt = startTime;
    await task.save();

    // Notify agent started
    NotificationService.emitAgentStarted(taskId, 'Test Creator');

    await LogService.agentStarted('test-creator', taskId, {
      phase: 'qa',
    });

    try {
      // 🔥 EVENT SOURCING: Get epics and stories from EventStore
      const { eventStore } = await import('../EventStore');
      const state = await eventStore.getCurrentState(task._id as any);
      const epics = state.epics || [];
      const stories = state.stories || [];

      console.log(`📋 [TestCreator] Retrieved ${epics.length} epics and ${stories.length} stories from EventStore`);

      // Get epic branches (same logic as QA)
      const contextEpicBranch = context.getData<string>('epicBranch');
      const epicBranches = epics.map((epic: any) => {
        const branch = epic.branchName || contextEpicBranch || `epic/${epic.id}`;
        console.log(`  - Epic ${epic.id}: using branch ${branch}`);
        return { epicId: epic.id, branch, repository: epic.targetRepository };
      }).filter((item: any) => item.branch) as Array<{ epicId: string; branch: string; repository?: string }>;

      console.log(`🌿 [TestCreator] Epic branches to create tests for: ${epicBranches.length}`);

      await LogService.info(`Creating tests for ${epicBranches.length} epic branches`, {
        taskId,
        category: 'quality',
        phase: 'qa',
        metadata: {
          epicBranchesCount: epicBranches.length,
          branches: epicBranches.map(e => e.branch),
        },
      });

      // Progress notification
      NotificationService.emitAgentProgress(
        taskId,
        'Test Creator',
        `Analyzing ${epicBranches.length} epic branches to create tests...`
      );

      // Get repository information
      const { normalizeRepoName } = require('../../utils/safeGitExecution');
      const repoContext = repositories.map(repo => ({
        name: normalizeRepoName(repo.githubRepoName.split('/').pop() || ''),
        fullName: repo.githubRepoName,
        type: repo.type || 'unknown',
        path: workspacePath ? path.join(workspacePath, normalizeRepoName(repo.githubRepoName.split('/').pop() || '')) : '',
        branch: repo.githubBranch || 'main'
      }));

      // Build comprehensive prompt for Test Creator
      const prompt = `# Test Creator - Create Comprehensive Test Suites

## Task: ${task.title}

## Working Directory: ${workspacePath || process.cwd()}

## Repositories (${repositories.length}):
${repoContext.map(r => `- **${r.name}** (${r.type}) at ${r.path}`).join('\n')}

## Epic Branches to Test:
${epicBranches.map((e, i) => `${i + 1}. Epic \`${e.epicId}\`: Branch \`${e.branch}\` ${e.repository ? `(repo: ${e.repository})` : ''}`).join('\n')}

## Stories Implemented:
${stories.map((s: any, i: number) => `${i + 1}. **${s.title}** - ${s.description || 'No description'}`).join('\n')}

---

## 🎯 YOUR MISSION

You are a **Test Automation Expert**. Your job is to create COMPREHENSIVE TEST SUITES for the code that developers just implemented.

**CRITICAL**: QA and Contract Testing will execute/validate these tests. If you don't create them, QA will FAIL.

---

## 📋 WORKFLOW (Execute in this EXACT order)

### STEP 1: Analyze Developer Code (5 minutes)

For each epic branch:

1. **Navigate to repository**:
\`\`\`bash
cd ${repoContext[0]?.path || workspacePath}
git checkout ${epicBranches[0]?.branch || 'main'}
git log -5 --oneline  # See recent commits
\`\`\`

2. **Identify changed files**:
\`\`\`bash
# Get diff from main/master to epic branch
git diff main...${epicBranches[0]?.branch || 'HEAD'} --name-only

# Or list all non-test files
find src -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) ! -name "*.test.*" ! -name "*.spec.*"
\`\`\`

3. **Read key files to understand functionality**:
\`\`\`bash
# Example: Read main service/component files
cat src/services/UserService.ts
cat src/components/UserProfile.tsx
\`\`\`

4. **Check existing test coverage**:
\`\`\`bash
# Find existing test files
find . -name "*.test.*" -o -name "*.spec.*"

# If tests exist, analyze coverage
npm test -- --coverage --passWithNoTests 2>&1 | tail -30
\`\`\`

---

### STEP 2: Identify Test Gaps (2 minutes)

Create a mental checklist of what needs tests:

**Unit Tests (70%)** - Fast, isolated:
- ✅ Pure functions (utilities, helpers, validators)
- ✅ React components (rendering, props, events)
- ✅ Services/classes (business logic methods)
- ✅ API routes/controllers (request handlers)

**Integration Tests (20%)** - Module interactions:
- ✅ API endpoints (Supertest or fetch)
- ✅ Database operations (Mongoose/Prisma queries)
- ✅ React components with hooks/context
- ✅ Service layer integrations

**E2E Tests (10%)** - Critical flows ONLY:
- ✅ Login/Authentication
- ✅ Main user journey (e.g., create user → view profile)
- ⚠️ Only 1-2 E2E tests max (they're slow!)

---

### STEP 3: Create Test Files (10-15 minutes)

**Testing Framework Detection**:
- Check \`package.json\` for Jest, Vitest, Playwright, etc.
- Use existing test patterns if tests already exist

**File Naming Conventions**:
- **Jest/Vitest**: \`ComponentName.test.ts\` or \`service.spec.ts\`
- **Playwright**: \`tests/e2e/flow.spec.ts\`
- **Location**: Same directory as source file OR \`__tests__/\` folder

**Write Tests Using Write() tool**:

Example for React component:
\`\`\`typescript
// src/components/UserProfile.test.tsx
import { render, screen } from '@testing-library/react';
import UserProfile from './UserProfile';

describe('UserProfile', () => {
  it('renders user name', () => {
    render(<UserProfile name="John Doe" />);
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('handles missing name gracefully', () => {
    render(<UserProfile name="" />);
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });
});
\`\`\`

Example for API endpoint:
\`\`\`typescript
// src/routes/users.test.ts
import request from 'supertest';
import app from '../app';

describe('POST /api/users', () => {
  it('creates a new user', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ name: 'Alice', email: 'alice@example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Alice');
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/users')
      .send({ name: '' });

    expect(res.status).toBe(400);
  });
});
\`\`\`

**Use Write() for EACH test file**:
\`\`\`
Write('src/services/UserService.test.ts', content)
Write('src/components/UserProfile.test.tsx', content)
Write('tests/e2e/user-flow.spec.ts', content)
\`\`\`

---

### STEP 4: Verify Tests Run (5 minutes)

1. **Install test dependencies if needed**:
\`\`\`bash
# Check if test deps exist
grep -E "(jest|vitest|@testing-library)" package.json

# Install if missing (usually already installed)
npm install --save-dev @testing-library/react @testing-library/jest-dom
\`\`\`

2. **Run tests to verify they work**:
\`\`\`bash
npm test -- --passWithNoTests --maxWorkers=50% 2>&1 | tail -50
\`\`\`

3. **Check coverage**:
\`\`\`bash
npm test -- --coverage --passWithNoTests 2>&1 | grep -A 10 "Coverage summary"
\`\`\`

**Target**: Coverage >85% (statements, branches, functions, lines)

If coverage is low, add more unit tests for uncovered files.

---

### STEP 5: Commit and Push Tests (2 minutes)

For EACH epic branch:

\`\`\`bash
cd ${repoContext[0]?.path || workspacePath}
git checkout ${epicBranches[0]?.branch || 'main'}

# Stage test files
git add ./**/*.test.* ./**/*.spec.* tests/

# Commit with clear message
git commit -m "test: Add comprehensive test suite

- Unit tests for services and components
- Integration tests for API endpoints
- E2E tests for critical user flows
- Coverage: >85%

🤖 Generated by Test Creator"

# Push to remote
git push origin ${epicBranches[0]?.branch || 'main'}
\`\`\`

**Extract commit SHA** from git output (you'll need it for the report).

---

## ✅ SUCCESS CRITERIA

You are successful when:
- ✅ Tests exist for ALL major functions/components/routes
- ✅ Tests follow testing pyramid (70% unit, 20% integration, 10% E2E)
- ✅ All tests PASS when run (\`npm test\`)
- ✅ Coverage is >85% (check with \`--coverage\`)
- ✅ Tests are committed and pushed to epic branches
- ✅ QA can now execute these tests

---

## ⚠️ CRITICAL RULES

**DO**:
- ✅ Create tests for EVERY new file created by developers
- ✅ Use existing test patterns (check other .test.ts files)
- ✅ Mock external dependencies (APIs, databases)
- ✅ Write readable, maintainable tests
- ✅ Commit tests to the SAME epic branch as the code

**DON'T**:
- ❌ Skip testing "simple" functions (test everything)
- ❌ Create E2E tests for every feature (too slow - only critical flows)
- ❌ Leave tests failing (fix or remove broken tests)
- ❌ Forget to push (QA needs tests on remote branch)
- ❌ Test implementation details (test behavior, not internals)

---

## 📊 OUTPUT FORMAT (MANDATORY JSON)

After completing all steps, output:

\`\`\`json
{
  "testsCreated": {
    "unitTests": 15,
    "integrationTests": 5,
    "e2eTests": 2,
    "totalFiles": 22
  },
  "coverage": {
    "statements": 88.5,
    "branches": 84.2,
    "functions": 90.1,
    "lines": 87.8
  },
  "testsPassing": true,
  "testsFailingCount": 0,
  "epicBranchesUpdated": [
    {
      "epicId": "${epicBranches[0]?.epicId || 'epic-1'}",
      "branch": "${epicBranches[0]?.branch || 'main'}",
      "commitSHA": "abc123def456...",
      "testFilesAdded": ["UserService.test.ts", "UserProfile.test.tsx"],
      "pushed": true
    }
  ],
  "readyForQA": true,
  "summary": "Created 22 test files with 88.5% coverage. All tests passing."
}
\`\`\`

---

## 🚀 TIME BUDGET

- **Step 1 (Analyze)**: 5 minutes
- **Step 2 (Identify)**: 2 minutes
- **Step 3 (Create)**: 10-15 minutes (most important!)
- **Step 4 (Verify)**: 5 minutes
- **Step 5 (Commit)**: 2 minutes

**TOTAL**: ~25-30 minutes for comprehensive test suite

---

## 💡 REMEMBER

**QA Phase will execute your tests**. If you don't create them, QA will fail.

**Contract Testing will validate your integration tests**. Make sure API endpoint tests exist.

**You are the TESTING EXPERT**. Developers focus on features. You focus on QUALITY through comprehensive testing.

Start immediately with STEP 1.`;

      // Execute Test Creator agent
      const result = await this.executeAgentFn(
        'test-creator',
        prompt,
        workspacePath || process.cwd(),
        taskId,
        'Test Creator',
        undefined, // sessionId
        undefined, // fork
        undefined // attachments
      );

      // Store results
      task.orchestration.testCreator!.status = 'completed';
      task.orchestration.testCreator!.completedAt = new Date();
      task.orchestration.testCreator!.output = result.output;
      task.orchestration.testCreator!.sessionId = result.sessionId;
      task.orchestration.testCreator!.usage = result.usage;
      task.orchestration.testCreator!.cost_usd = result.cost;

      // Parse JSON output to extract metrics
      let testsCreated = 0;
      let coveragePercentage: number | string = 0;
      try {
        const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/) ||
                         result.output.match(/\{[\s\S]*"testsCreated"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
          testsCreated = (parsed.testsCreated?.unitTests || 0) +
                        (parsed.testsCreated?.integrationTests || 0) +
                        (parsed.testsCreated?.e2eTests || 0);

          // Coverage can be a number or a string (like "N/A")
          const rawCoverage = parsed.coverage?.statements;
          coveragePercentage = typeof rawCoverage === 'number' ? rawCoverage : (rawCoverage || 0);

          task.orchestration.testCreator!.testsCreated = testsCreated;
          task.orchestration.testCreator!.coveragePercentage = coveragePercentage;
        }
      } catch (parseError) {
        console.warn('[TestCreator] Failed to parse JSON output:', parseError);
      }

      // Update costs
      task.orchestration.totalCost += result.cost;
      task.orchestration.totalTokens +=
        (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0);

      await task.save();

      // 🔥 EVENT SOURCING: Emit completion event
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TestCreatorCompleted',
        agentName: 'test-creator',
        payload: {
          output: result.output,
          epicBranchesCount: epicBranches.length,
          testsCreated,
          coveragePercentage,
        },
        metadata: {
          cost: result.cost,
          duration: Date.now() - startTime.getTime(),
        },
      });

      console.log(`📝 [TestCreator] Emitted TestCreatorCompleted event`);

      // 🔥 EMIT FULL OUTPUT TO CONSOLE VIEWER
      NotificationService.emitConsoleLog(
        taskId,
        'info',
        `\n${'='.repeat(80)}\n🧪 TEST CREATOR - FULL OUTPUT\n${'='.repeat(80)}\n\n${result.output}\n\n${'='.repeat(80)}`
      );

      // Send output to chat
      NotificationService.emitAgentMessage(taskId, 'Test Creator', result.output);

      // Notify completion
      const coverageDisplay = typeof coveragePercentage === 'number'
        ? `${coveragePercentage.toFixed(1)}%`
        : coveragePercentage;

      NotificationService.emitAgentCompleted(
        taskId,
        'Test Creator',
        `Created tests for ${epicBranches.length} epic branches. Coverage: ${coverageDisplay}. Tests: ${testsCreated}`
      );

      await LogService.agentCompleted('test-creator', taskId, {
        phase: 'qa',
        metadata: {
          epicBranchesProcessed: epicBranches.length,
          testsCreated,
          coveragePercentage,
          cost: result.cost,
          inputTokens: result.usage?.input_tokens || 0,
          outputTokens: result.usage?.output_tokens || 0,
        },
      });

      // Store phase data
      context.setData('testCreatorComplete', true);
      context.setData('testsCreated', testsCreated);
      context.setData('coverage', coveragePercentage);

      return {
        success: true,
        data: {
          output: result.output,
          epicBranchesProcessed: epicBranches.length,
          testsCreated,
          coveragePercentage,
        },
        metrics: {
          cost_usd: result.cost,
          input_tokens: result.usage?.input_tokens || 0,
          output_tokens: result.usage?.output_tokens || 0,
          tests_created: testsCreated,
          coverage_percentage: coveragePercentage,
        },
      };
    } catch (error: any) {
      // Save error state
      task.orchestration.testCreator!.status = 'failed';
      task.orchestration.testCreator!.error = error.message;
      await task.save();

      // Notify failure
      NotificationService.emitAgentFailed(taskId, 'Test Creator', error.message);

      await LogService.agentFailed('test-creator', taskId, error, {
        phase: 'qa',
      });

      // 🔥 EVENT SOURCING: Emit failure event
      const { eventStore } = await import('../EventStore');
      await eventStore.append({
        taskId: task._id as any,
        eventType: 'TestCreatorCompleted',
        agentName: 'test-creator',
        payload: {
          error: error.message,
          failed: true,
        },
        metadata: {
          error: error.message,
        },
      });

      console.log(`📝 [TestCreator] Emitted TestCreatorCompleted event (error state)`);

      return {
        success: false,
        error: error.message,
      };
    }
  }
}
