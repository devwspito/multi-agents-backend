# Human-in-the-Loop Architecture Design
**Claude Code Style Approval System**

## 🎯 Vision

Every agent shows their work to the user BEFORE executing changes. User can see, approve, reject, or modify at every step.

## 📋 Core Principles

1. **Show, Then Execute**: Agents propose changes, user approves, then changes are applied
2. **Full Visibility**: User sees EVERYTHING each agent generates (prompts, responses, diffs)
3. **User Control**: At any point, user can approve, reject, modify, or add instructions
4. **Auditability**: Complete transparency into every agent's thinking and actions

---

## 🔄 New Orchestration Flow

### Current Flow (Autonomous)
```
Product Manager → Tech Lead → Developers → QA → Merge → Done
(everything runs automatically)
```

### New Flow (Human-in-the-Loop)
```
Product Manager
  ↓ [generates requirements + epics]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]

Tech Lead
  ↓ [generates architecture + stories + team]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]

Developer 1
  ↓ [generates code proposal + shows diff]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]
  ✅ [ONLY NOW: write files + commit]

Developer 2
  ↓ [generates code proposal + shows diff]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]
  ✅ [ONLY NOW: write files + commit]

...repeat for all developers

QA Engineer
  ↓ [runs tests + shows results]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]

Judge (if needed)
  ↓ [evaluates work + shows feedback]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject / modify]

Merge Coordinator
  ↓ [shows merge plan]
  ⏸️  USER APPROVAL REQUIRED
  ↓ [user: approve / reject]
  ✅ [ONLY NOW: merge PRs]
```

---

## 🗄️ Data Model Changes

### 1. AgentStep Enhancement

Add fields to track approval state and full output:

```typescript
interface IAgentStep {
  // Existing fields
  agent: string;
  status: 'pending' | 'running' | 'awaiting_approval' | 'completed' | 'failed';
  startedAt?: Date;
  completedAt?: Date;

  // NEW: Full agent interaction capture
  agentOutput: {
    prompt: string;                    // Exact prompt sent to agent
    fullResponse: string;              // Complete agent response
    reasoning?: string;                // Agent's thinking process

    // For planners (PM, TechLead)
    proposal?: {
      epics?: any[];
      stories?: any[];
      requirements?: string;
      architecture?: string;
      teamSize?: number;
    };

    // For developers
    codeChanges?: {
      filePath: string;
      action: 'create' | 'edit' | 'delete';
      currentContent?: string;         // File before changes
      proposedContent: string;         // File after changes
      diff: string;                    // Unified diff format
    }[];

    // For QA
    testResults?: {
      passed: number;
      failed: number;
      details: string;
    };

    // For Judge
    evaluation?: {
      score: number;
      feedback: string;
      issues: string[];
    };
  };

  // NEW: Approval tracking
  approval: {
    status: 'pending' | 'approved' | 'rejected' | 'modified';
    approvedAt?: Date;
    approvedBy?: ObjectId;
    rejectionReason?: string;

    // User modifications
    userInstructions?: string;        // Additional instructions from user
    modificationType?: 'approve' | 'reject' | 'retry_with_changes';
  };

  // NEW: Re-execution tracking
  retryCount?: number;
  parentStepId?: string;              // If this is a retry, link to original
}
```

### 2. Task Model Updates

```typescript
interface ITask {
  // ... existing fields

  // NEW: Approval mode
  approvalMode: 'auto' | 'human-in-loop';  // Default: 'human-in-loop'

  // NEW: Current awaiting approval
  awaitingApproval?: {
    stepId: string;
    agentName: string;
    type: 'planning' | 'code_change' | 'test_results' | 'merge';
    requestedAt: Date;
  };
}
```

---

## 🏗️ Backend Implementation

### Phase 1: Capture Agent Output (Non-Breaking)

**1.1 Modify executeAgent() in TeamOrchestrator**

```typescript
private async executeAgent(
  agentType: string,
  prompt: string,
  workingDirectory: string,
  taskId: string,
  displayName: string,
  resumeSessionId?: string
): Promise<{
  result: string;           // Agent's final response
  fullOutput: string;       // Complete output including thinking
  filesChanged?: {          // Files the agent wants to modify
    path: string;
    action: 'create' | 'edit' | 'delete';
    proposedContent: string;
    diff?: string;
  }[];
}> {
  // Create agent step
  const stepId = await this.createAgentStep(taskId, displayName);

  // Save the prompt
  await this.saveAgentPrompt(stepId, prompt);

  // Execute agent (without file writes if in approval mode)
  const agentOutput = await agent.execute({
    prompt,
    workingDirectory,
    preventFileWrites: task.approvalMode === 'human-in-loop', // NEW FLAG
  });

  // Capture EVERYTHING
  await this.saveAgentOutput(stepId, {
    fullResponse: agentOutput.fullText,
    reasoning: agentOutput.thinking,
    filesChanged: agentOutput.proposedFileChanges,
  });

  // If human-in-loop, PAUSE here
  if (task.approvalMode === 'human-in-loop') {
    await this.requestUserApproval(taskId, stepId, displayName);
    throw new Error('AWAITING_USER_APPROVAL'); // Pauses pipeline
  }

  return agentOutput;
}
```

**1.2 File Write Prevention**

Modify SDK execution to capture file operations without executing them:

```typescript
// In agent execution wrapper
const capturedFileOps = [];

// Intercept Write tool calls
if (tool.name === 'Write' || tool.name === 'Edit') {
  if (preventFileWrites) {
    // Don't execute, just capture
    capturedFileOps.push({
      type: tool.name,
      path: tool.params.file_path,
      content: tool.params.content || tool.params.new_string,
      // Generate diff for Edit
      diff: tool.name === 'Edit'
        ? generateDiff(oldContent, newContent)
        : null,
    });

    // Return fake success
    return { success: true, captured: true };
  } else {
    // Execute normally
    return executeTool(tool);
  }
}
```

### Phase 2: Approval API Endpoints

**2.1 Request Approval Endpoint**

```typescript
// POST /api/tasks/:taskId/steps/:stepId/request-approval
// Called automatically when agent finishes

router.post('/:taskId/steps/:stepId/request-approval', async (req, res) => {
  const { taskId, stepId } = req.params;

  const task = await Task.findById(taskId);
  const step = task.agentSteps.id(stepId);

  // Mark as awaiting approval
  step.status = 'awaiting_approval';
  step.approval = {
    status: 'pending',
    requestedAt: new Date(),
  };

  task.awaitingApproval = {
    stepId: stepId,
    agentName: step.agent,
    type: determineApprovalType(step),
    requestedAt: new Date(),
  };

  await task.save();

  // Emit WebSocket event
  NotificationService.emitApprovalRequired(taskId, {
    stepId,
    agentName: step.agent,
    output: step.agentOutput,
  });

  res.json({ success: true });
});
```

**2.2 Approve Endpoint**

```typescript
// POST /api/tasks/:taskId/steps/:stepId/approve
// User approves agent's work

router.post('/:taskId/steps/:stepId/approve', async (req, res) => {
  const { taskId, stepId } = req.params;
  const { additionalInstructions } = req.body; // Optional user modifications

  const task = await Task.findById(taskId);
  const step = task.agentSteps.id(stepId);

  // Mark as approved
  step.status = 'completed';
  step.approval = {
    status: 'approved',
    approvedAt: new Date(),
    approvedBy: req.user._id,
    userInstructions: additionalInstructions,
  };

  // If this was a developer, NOW apply the file changes
  if (step.agentOutput.codeChanges) {
    await applyCodeChanges(step.agentOutput.codeChanges, repoPath);
    await commitChanges(repoPath, `Apply approved changes from ${step.agent}`);
  }

  task.awaitingApproval = null;
  await task.save();

  // Resume orchestration
  await orchestrateTask(taskId);

  res.json({ success: true });
});
```

**2.3 Reject Endpoint**

```typescript
// POST /api/tasks/:taskId/steps/:stepId/reject
// User rejects and optionally provides new instructions

router.post('/:taskId/steps/:stepId/reject', async (req, res) => {
  const { taskId, stepId } = req.params;
  const { reason, newInstructions, action } = req.body;
  // action: 'cancel' | 'retry' | 'retry_with_changes'

  const task = await Task.findById(taskId);
  const step = task.agentSteps.id(stepId);

  step.approval = {
    status: 'rejected',
    rejectionReason: reason,
    userInstructions: newInstructions,
    modificationType: action,
  };

  if (action === 'cancel') {
    task.status = 'cancelled';
    task.awaitingApproval = null;
  } else if (action === 'retry' || action === 'retry_with_changes') {
    // Re-run the agent with new instructions
    const newPrompt = newInstructions
      ? `${step.agentOutput.prompt}\n\nUSER FEEDBACK:\n${newInstructions}`
      : step.agentOutput.prompt;

    // Create new step for retry
    await retryAgentStep(taskId, step.agent, newPrompt, step._id);
  }

  await task.save();
  res.json({ success: true });
});
```

**2.4 Get Agent Step Details**

```typescript
// GET /api/tasks/:taskId/steps/:stepId
// Retrieve full agent output for UI display

router.get('/:taskId/steps/:stepId', async (req, res) => {
  const { taskId, stepId } = req.params;

  const task = await Task.findById(taskId);
  const step = task.agentSteps.id(stepId);

  res.json({
    success: true,
    data: {
      agent: step.agent,
      status: step.status,
      startedAt: step.startedAt,
      completedAt: step.completedAt,

      // Full output
      prompt: step.agentOutput.prompt,
      response: step.agentOutput.fullResponse,
      reasoning: step.agentOutput.reasoning,

      // Specific outputs
      proposal: step.agentOutput.proposal,
      codeChanges: step.agentOutput.codeChanges,
      testResults: step.agentOutput.testResults,
      evaluation: step.agentOutput.evaluation,

      // Approval state
      approval: step.approval,

      // Context
      retryCount: step.retryCount || 0,
      parentStepId: step.parentStepId,
    },
  });
});
```

---

## 🎨 Frontend Components

### 1. ApprovalPanel Component

**Location**: `multi-agent-frontend/src/components/approvals/ApprovalPanel.jsx`

```jsx
/**
 * Main approval interface - shows in console
 * Like Claude Code's approval UI
 */
const ApprovalPanel = ({ taskId, stepId, agentOutput, onApprove, onReject }) => {
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [additionalInstructions, setAdditionalInstructions] = useState('');

  return (
    <div className="approval-panel">
      <div className="approval-header">
        <span className="agent-name">{agentOutput.agentName}</span>
        <span className="approval-badge">Awaiting Approval</span>
      </div>

      {/* Quick summary */}
      <div className="approval-summary">
        {renderSummary(agentOutput)}
      </div>

      {/* Expandable full output */}
      <details open={showFullOutput}>
        <summary>View Full Output</summary>
        <AgentOutputViewer output={agentOutput} />
      </details>

      {/* For developers: show code diffs */}
      {agentOutput.codeChanges && (
        <CodeDiffViewer changes={agentOutput.codeChanges} />
      )}

      {/* User instructions */}
      <div className="user-instructions">
        <label>Additional Instructions (optional):</label>
        <textarea
          value={additionalInstructions}
          onChange={(e) => setAdditionalInstructions(e.target.value)}
          placeholder="Modify agent's approach, add requirements, etc..."
        />
      </div>

      {/* Actions */}
      <div className="approval-actions">
        <button onClick={() => onReject('cancel')}>
          ❌ Cancel Task
        </button>
        <button onClick={() => onReject('retry', additionalInstructions)}>
          🔄 Retry with Changes
        </button>
        <button onClick={() => onApprove(additionalInstructions)}>
          ✅ Approve & Continue
        </button>
      </div>
    </div>
  );
};
```

### 2. CodeDiffViewer Component

**Location**: `multi-agent-frontend/src/components/approvals/CodeDiffViewer.jsx`

```jsx
/**
 * Shows code changes in diff format
 * Like GitHub PR diffs or Claude Code diffs
 */
const CodeDiffViewer = ({ changes }) => {
  return (
    <div className="code-diff-viewer">
      <h4>Proposed Code Changes:</h4>

      {changes.map((change, idx) => (
        <div key={idx} className="file-change">
          <div className="file-header">
            <span className={`action ${change.action}`}>
              {change.action === 'create' && '+ Create'}
              {change.action === 'edit' && '~ Edit'}
              {change.action === 'delete' && '- Delete'}
            </span>
            <span className="file-path">{change.filePath}</span>
          </div>

          {/* Show diff for edits */}
          {change.action === 'edit' && change.diff && (
            <DiffView diff={change.diff} />
          )}

          {/* Show full content for creates */}
          {change.action === 'create' && (
            <CodeBlock
              language={detectLanguage(change.filePath)}
              code={change.proposedContent}
            />
          )}

          {/* Expandable side-by-side for edits */}
          <details>
            <summary>View Side-by-Side</summary>
            <SideBySideDiff
              before={change.currentContent}
              after={change.proposedContent}
            />
          </details>
        </div>
      ))}
    </div>
  );
};
```

### 3. AgentOutputViewer Component

**Location**: `multi-agent-frontend/src/components/approvals/AgentOutputViewer.jsx`

```jsx
/**
 * Shows complete agent output for transparency
 * Prompt + Response + Reasoning
 */
const AgentOutputViewer = ({ output }) => {
  return (
    <div className="agent-output-viewer">
      {/* Prompt sent to agent */}
      <div className="output-section">
        <h5>📤 Prompt Sent to Agent:</h5>
        <pre className="prompt-text">{output.prompt}</pre>
      </div>

      {/* Agent's thinking (if available) */}
      {output.reasoning && (
        <div className="output-section">
          <h5>🧠 Agent Reasoning:</h5>
          <pre className="reasoning-text">{output.reasoning}</pre>
        </div>
      )}

      {/* Agent's full response */}
      <div className="output-section">
        <h5>📥 Agent Response:</h5>
        <MarkdownRenderer content={output.fullResponse} />
      </div>

      {/* Structured outputs */}
      {output.proposal && (
        <div className="output-section">
          <h5>📋 Proposal:</h5>
          <ProposalViewer proposal={output.proposal} />
        </div>
      )}

      {output.testResults && (
        <div className="output-section">
          <h5>🧪 Test Results:</h5>
          <TestResultsViewer results={output.testResults} />
        </div>
      )}

      {output.evaluation && (
        <div className="output-section">
          <h5>⚖️ Evaluation:</h5>
          <EvaluationViewer evaluation={output.evaluation} />
        </div>
      )}
    </div>
  );
};
```

---

## 🔧 Implementation Steps

### Step 1: Data Model (Non-Breaking) ✅
- [ ] Update Task model with `approvalMode` field
- [ ] Enhance AgentStep with `agentOutput` and `approval` fields
- [ ] Add `awaitingApproval` to Task model
- [ ] Migration script for existing tasks

### Step 2: Backend Capture (Non-Breaking) ✅
- [ ] Modify `executeAgent()` to capture full output
- [ ] Implement file write interception
- [ ] Save prompts and responses to database
- [ ] Generate diffs for code changes

### Step 3: Approval APIs ✅
- [ ] POST `/tasks/:id/steps/:stepId/request-approval`
- [ ] POST `/tasks/:id/steps/:stepId/approve`
- [ ] POST `/tasks/:id/steps/:stepId/reject`
- [ ] GET `/tasks/:id/steps/:stepId`

### Step 4: Frontend Components ✅
- [ ] ApprovalPanel component
- [ ] CodeDiffViewer component
- [ ] AgentOutputViewer component
- [ ] Integrate into ConsoleViewer

### Step 5: Orchestration Changes ✅
- [ ] Pause after each agent when in human-in-loop mode
- [ ] Resume orchestration after approval
- [ ] Handle retries with modifications
- [ ] Apply file changes only after approval

### Step 6: Testing & Rollout 🚀
- [ ] Test with simple task end-to-end
- [ ] Test rejection and retry flow
- [ ] Test with complex multi-developer task
- [ ] Update documentation
- [ ] Deploy to production

---

## 📊 User Experience Flow

### Example: Developer Proposes Changes

```
[Console View]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👨‍💻 Developer-1 (Story: Implement user authentication)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Analysis complete
✅ Code generated
⏸️  AWAITING YOUR APPROVAL

📝 Proposed Changes (3 files):

  + Create  src/services/AuthService.ts
  ~ Edit    src/routes/auth.ts
  ~ Edit    src/middleware/auth.ts

[View Code Diff ▼]

┌─────────────────────────────────────────────┐
│ src/services/AuthService.ts (new file)     │
├─────────────────────────────────────────────┤
│ + export class AuthService {               │
│ +   async login(email: string, pwd: string)│
│ +   async register(email: string, pwd: str)│
│ +   private hashPassword(pwd: string)      │
│ + }                                        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ src/routes/auth.ts (modified)              │
├─────────────────────────────────────────────┤
│ - import { login } from '../utils/auth';   │
│ + import { AuthService } from '../services'│
│                                            │
│   router.post('/login', async (req, res) =>│
│ -   const result = await login(req.body);  │
│ +   const authService = new AuthService(); │
│ +   const result = await authService.login│
└─────────────────────────────────────────────┘

💬 Additional Instructions (optional):
┌─────────────────────────────────────────────┐
│                                            │
│ [Add any modifications or requirements]   │
│                                            │
└─────────────────────────────────────────────┘

[❌ Cancel] [🔄 Retry with Changes] [✅ Approve & Apply]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 🎛️ Configuration Options

Users can choose their workflow:

```typescript
// Full human-in-loop (default)
task.approvalMode = 'human-in-loop';
task.approvalConfig = {
  requireApprovalFor: [
    'planning',      // Product Manager, Tech Lead
    'code_changes',  // All Developers
    'testing',       // QA Engineer
    'evaluation',    // Judge
    'merge',         // Merge Coordinator
  ],
  allowModifications: true,
};

// Hybrid: Only approve code changes
task.approvalMode = 'human-in-loop';
task.approvalConfig = {
  requireApprovalFor: ['code_changes'], // Only devs need approval
  allowModifications: true,
};

// Full autopilot (opt-in)
task.approvalMode = 'auto';
task.autoPilotMode = true;
```

---

## 🔒 Security Considerations

1. **File Safety**: No files are written until user approves
2. **Git Safety**: No commits/pushes until user approves
3. **API Safety**: No external API calls without approval (optional)
4. **Rollback**: Keep copies of original files for easy rollback

---

## 📈 Success Metrics

- ✅ User sees 100% of agent outputs
- ✅ Zero unexpected file changes
- ✅ User can modify any agent's work
- ✅ Complete audit trail of all decisions
- ✅ Feels like Claude Code experience

---

**Status**: 📐 Design Complete - Ready for Implementation
**Next**: Start with Step 1 (Data Model Changes)
