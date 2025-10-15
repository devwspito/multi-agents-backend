# Human-in-the-Loop Implementation Status

**Last Updated**: 2025-01-15

---

## ✅ COMPLETED

### 1. Data Model (Task.ts) ✅
- All interfaces created: `ICodeChange`, `IAgentOutput`, `IApproval`, `IAwaitingApproval`
- Task model extended with `approvalMode` and `awaitingApproval` fields
- All agent schemas updated (PM, TechLead, Developers, QA, MergeCoordinator, Judge)
- Each agent now has: `agentOutput`, `approval`, `retryCount`, `parentStepId`

### 2. Backend API (approvals.ts) ✅
Complete REST API with 4 endpoints:
- `GET /api/approvals/tasks/:taskId/step/:stepPath` - Get agent details
- `POST /api/approvals/tasks/:taskId/approve` - Approve with instructions
- `POST /api/approvals/tasks/:taskId/reject` - Reject with retry options
- `POST /api/approvals/tasks/:taskId/toggle-mode` - Toggle auto/human-in-loop

All TypeScript errors fixed ✅

### 3. Backend Orchestration Methods (TeamOrchestrator.ts) ✅
Three helper methods created:
- `saveAgentOutput()` - Captures prompt, response, reasoning, code changes
- `requestUserApproval()` - Pauses orchestration and emits WebSocket
- `checkAndRequestApproval()` - Checks mode and requests approval if needed

**Status**: Methods exist but NOT YET INTEGRATED into agent execution flow ⚠️

### 4. Frontend UI (ConsoleViewer.jsx) ✅
Complete inline approval component with:
- State management for `genericApproval` and `additionalInstructions`
- WebSocket listeners for `approval_required` and `approval_granted` events
- Approval handlers: `handleGenericApprove()` and `handleGenericReject()`
- Inline approval UI with expandable sections:
  - 📤 Prompt sent to agent
  - 📥 Agent response
  - 🧠 Agent reasoning
  - 💻 Code changes with diff preview
  - 📋 Proposal (for planners)
  - 🧪 Test results (for QA)
  - User instructions textarea
  - Three action buttons: Cancel, Retry, Approve

### 5. Frontend CSS (ConsoleViewer.css) ✅
Complete styling for Claude Code-style inline approvals:
- Generic approval styles with purple border
- Color-coded type badges (planning, code_change, test_results, evaluation, merge)
- Expandable section styles with arrow indicators
- Code change list with action badges (create, edit, delete)
- Diff preview with syntax highlighting
- Test results display
- User instructions input with focus states
- Retry button variant
- Responsive design

---

## ⚠️ PENDING INTEGRATION

### Critical: Agent Execution Flow Integration

The helper methods (`saveAgentOutput`, `requestUserApproval`, `checkAndRequestApproval`) are created but **NOT called** during agent execution. This means:

❌ Agents execute without capturing output
❌ No approval requests are sent
❌ Files are written immediately (no pause for approval)
❌ Human-in-loop mode has no effect

### What Needs to Happen:

#### 1. Integrate into Developer Execution
**Location**: `TeamOrchestrator.ts` → `executeDevelopers()` method

**Required Changes**:
```typescript
// BEFORE executing developer
const prompt = generateDeveloperPrompt(story, techDoc);

// Execute developer and capture output
const result = await executeAgent('developer', prompt, workDir, taskId, devName);

// ⚠️ ADD THIS:
// Save agent output for review
await this.saveAgentOutput(task, agentPath, {
  prompt,
  fullResponse: result.response,
  reasoning: result.reasoning,
  codeChanges: result.proposedChanges // NOT yet applied
});

// ⚠️ ADD THIS:
// Check if approval needed
const needsApproval = await this.checkAndRequestApproval(
  task,
  agentPath,
  devName,
  'code_change'
);

if (needsApproval) {
  throw new Error('AWAITING_USER_APPROVAL'); // Pause here
}

// ONLY AFTER APPROVAL: Apply file changes
await applyCodeChanges(result.proposedChanges, repoPath);
await gitCommitAndPush(repoPath);
```

#### 2. Integrate into Product Manager
**Location**: `executeProductManager()` method

**Required Changes**:
```typescript
// After PM generates proposal
await this.saveAgentOutput(task, 'orchestration.productManager', {
  prompt: pmPrompt,
  fullResponse: result.response,
  reasoning: result.reasoning,
  proposal: result.proposal // Epic breakdown
});

// Request approval
await this.checkAndRequestApproval(
  task,
  'orchestration.productManager',
  'product-manager',
  'planning'
);
```

#### 3. Integrate into Tech Lead
**Location**: `executeTechLead()` method

**Required Changes**:
```typescript
// After TechLead designs architecture
await this.saveAgentOutput(task, 'orchestration.techLead', {
  prompt: techLeadPrompt,
  fullResponse: result.response,
  reasoning: result.reasoning,
  proposal: result.architecture // Story breakdown + team composition
});

// Request approval
await this.checkAndRequestApproval(
  task,
  'orchestration.techLead',
  'tech-lead',
  'planning'
);
```

#### 4. Integrate into QA Engineer
**Location**: `executeQA()` method

**Required Changes**:
```typescript
// After QA runs tests
await this.saveAgentOutput(task, 'orchestration.qa', {
  prompt: qaPrompt,
  fullResponse: result.response,
  testResults: result.testResults
});

// Request approval
await this.checkAndRequestApproval(
  task,
  'orchestration.qa',
  'qa-engineer',
  'test_results'
);
```

#### 5. Integrate into Judge
**Location**: `executeJudge()` method

**Required Changes**:
```typescript
// After Judge evaluates
await this.saveAgentOutput(task, 'orchestration.judge', {
  prompt: judgePrompt,
  fullResponse: result.response,
  evaluation: result.evaluation
});

// Request approval
await this.checkAndRequestApproval(
  task,
  'orchestration.judge',
  'judge',
  'evaluation'
);
```

#### 6. Integrate into Merge Coordinator
**Location**: `executeMergeCoordinator()` method

**Required Changes**:
```typescript
// After Merge Coordinator plans merge
await this.saveAgentOutput(task, 'orchestration.mergeCoordinator', {
  prompt: mergePrompt,
  fullResponse: result.response,
  mergePlan: result.plan
});

// Request approval
await this.checkAndRequestApproval(
  task,
  'orchestration.mergeCoordinator',
  'merge-coordinator',
  'merge'
);
```

---

## 🎯 Expected Behavior After Integration

### Auto Mode (`approvalMode: 'auto'`)
1. Agents execute normally
2. No pauses for approval
3. Changes applied immediately
4. Fast execution (current behavior)

### Human-in-Loop Mode (`approvalMode: 'human-in-loop'`)
1. **Product Manager** executes → Shows proposal → Waits for approval
2. User reviews epic breakdown → Approves or modifies
3. **Tech Lead** executes → Shows architecture → Waits for approval
4. User reviews story assignments → Approves or modifies
5. **Developers** execute in parallel → Each shows code changes → Waits for approval
6. User reviews diffs for each developer → Approves, rejects, or retries with changes
7. **ONLY AFTER APPROVAL**: Files are written and committed
8. **QA** runs tests → Shows results → Waits for approval
9. **Judge** evaluates → Shows evaluation → Waits for approval
10. **Merge Coordinator** plans merge → Shows plan → Waits for approval
11. User approves → PRs merged to main

---

## 🚀 Next Steps (In Order)

1. ✅ ~~Fix TypeScript errors in approvals.ts~~ **DONE**
2. ✅ ~~Complete CSS styling for inline approvals~~ **DONE**
3. ⏳ **Integrate approval checks into all agent execution methods**
4. ⏳ Test approval flow end-to-end with a real task
5. ⏳ Add code diff generation for file changes
6. ⏳ Handle edge cases (errors during approval, timeout, disconnection)
7. ⏳ Add approval history/audit trail to UI

---

## 📝 Notes

- **Default Mode**: `human-in-loop` (user must explicitly opt into auto mode)
- **Real-time Toggle**: User can switch modes mid-execution (implemented in backend)
- **WebSocket Events**: Frontend already listening for `approval_required` and `approval_granted`
- **Retry Logic**: Backend supports retry with modifications (up to 3 attempts per agent)
- **Code Safety**: NO files written until user approves ✅

---

## 🔧 Technical Debt

1. **TypeScript Warnings**: Unused declarations for `saveAgentOutput` and `checkAndRequestApproval` - will resolve after integration
2. **Error Handling**: Need to handle `AWAITING_USER_APPROVAL` error gracefully in orchestrator
3. **Session Persistence**: If user refreshes page while awaiting approval, state should be preserved
4. **Notification Reliability**: Ensure WebSocket reconnection doesn't miss approval requests

---

## 📊 Progress Summary

| Component | Status | Progress |
|-----------|--------|----------|
| Data Model | ✅ Complete | 100% |
| API Endpoints | ✅ Complete | 100% |
| Backend Methods | ✅ Created | 100% |
| **Backend Integration** | ⚠️ **Pending** | **0%** |
| Frontend UI | ✅ Complete | 100% |
| Frontend CSS | ✅ Complete | 100% |
| **Overall System** | ⚠️ **Not Functional** | **70%** |

**Critical Path**: Backend integration is REQUIRED for system to work.

---

**Generated**: 2025-01-15
**Status**: Backend API and Frontend UI complete, awaiting orchestration integration
