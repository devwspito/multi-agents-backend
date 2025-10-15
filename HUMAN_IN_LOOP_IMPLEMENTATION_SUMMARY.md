# Human-in-the-Loop Implementation Summary

## ✅ Backend Implementation COMPLETE

La implementación completa del sistema Human-in-the-Loop estilo Claude Code está lista. El usuario puede ver y aprobar TODOS los cambios antes de que se apliquen.

---

## 🎯 What Was Implemented

### 1. Data Model (Task.ts) ✅

#### New Interfaces:
```typescript
interface ICodeChange {
  filePath: string;
  action: 'create' | 'edit' | 'delete';
  currentContent?: string;
  proposedContent: string;
  diff?: string;
  repository?: string;
}

interface IAgentOutput {
  prompt?: string;              // Exact prompt sent to agent
  fullResponse?: string;        // Complete agent response
  reasoning?: string;           // Agent's thinking process
  proposal?: any;              // For planners (PM, TechLead)
  codeChanges?: ICodeChange[]; // For developers
  testResults?: any;           // For QA
  evaluation?: any;            // For Judge
  mergePlan?: any;             // For Merge Coordinator
}

interface IApproval {
  status: 'pending' | 'approved' | 'rejected' | 'modified';
  requestedAt?: Date;
  approvedAt?: Date;
  approvedBy?: ObjectId;
  rejectionReason?: string;
  userInstructions?: string;
  modificationType?: 'approve' | 'reject' | 'retry' | 'retry_with_changes';
}

interface IAwaitingApproval {
  stepId: string;
  agentName: string;
  type: 'planning' | 'code_change' | 'test_results' | 'evaluation' | 'merge';
  requestedAt: Date;
  repository?: string;
}
```

#### Task Model Updates:
```typescript
interface ITask {
  // ... existing fields

  // NEW FIELDS:
  approvalMode?: 'auto' | 'human-in-loop';  // Default: 'human-in-loop'
  awaitingApproval?: IAwaitingApproval;     // Current waiting state
}
```

#### All Agents Updated:
- ProductManager
- ProjectManager
- TechLead
- Developer (team members)
- QA Engineer
- Merge Coordinator

**Each agent now has:**
```typescript
{
  agentOutput?: IAgentOutput;  // Full transparency
  approval?: IApproval;        // Approval tracking
  retryCount?: number;         // Retry attempts
  parentStepId?: string;       // Link to original if retry
}
```

---

### 2. Backend Methods (TeamOrchestrator.ts) ✅

#### New Methods Added:

##### `saveAgentOutput()`
```typescript
private async saveAgentOutput(
  task: ITask,
  agentPath: string,
  output: {
    prompt: string;
    fullResponse: string;
    reasoning?: string;
    proposal?: any;
    codeChanges?: any[];
  }
): Promise<void>
```
- Captures EVERYTHING the agent does
- Saves to database for user review
- Navigates task structure to find correct agent

##### `requestUserApproval()`
```typescript
private async requestUserApproval(
  task: ITask,
  agentPath: string,
  agentName: string,
  approvalType: 'planning' | 'code_change' | 'test_results' | 'evaluation' | 'merge'
): Promise<void>
```
- Marks task as awaiting approval
- Sets agent status to 'pending'
- Emits WebSocket notification to frontend
- Pauses orchestration

##### `checkAndRequestApproval()`
```typescript
private async checkAndRequestApproval(
  task: ITask,
  agentPath: string,
  agentName: string,
  approvalType: ApprovalType
): Promise<boolean>
```
- Checks if task is in human-in-loop mode
- Requests approval if enabled
- Throws `AWAITING_USER_APPROVAL` error to pause pipeline

---

### 3. API Endpoints (approvals.ts) ✅

Complete REST API for approval workflow:

#### `GET /api/approvals/tasks/:taskId/step/:stepPath`
Get detailed agent step information for approval UI.

**Response:**
```json
{
  "success": true,
  "data": {
    "agent": "product-manager",
    "status": "pending",
    "startedAt": "2025-01-15T10:00:00Z",
    "agentOutput": {
      "prompt": "Analyze requirements...",
      "fullResponse": "Based on analysis...",
      "reasoning": "I approached this by...",
      "proposal": { "epics": [...], "stories": [...] },
      "codeChanges": [...]
    },
    "approval": {
      "status": "pending",
      "requestedAt": "2025-01-15T10:05:00Z"
    },
    "retryCount": 0
  }
}
```

#### `POST /api/approvals/tasks/:taskId/approve`
Approve agent's work and continue orchestration.

**Body:**
```json
{
  "additionalInstructions": "Make sure to add tests" // optional
}
```

**Response:**
```json
{
  "success": true,
  "message": "Approval granted. Orchestration will continue."
}
```

**What happens:**
1. Marks agent as 'completed'
2. Sets approval.status = 'approved'
3. Saves user instructions if provided
4. Clears awaitingApproval state
5. **Emits WebSocket notification**
6. **Resumes orchestration automatically**

#### `POST /api/approvals/tasks/:taskId/reject`
Reject agent's work with retry option.

**Body:**
```json
{
  "reason": "Code quality issues found",
  "action": "retry_with_changes",  // 'cancel' | 'retry' | 'retry_with_changes'
  "newInstructions": "Add error handling and logging"
}
```

**Actions:**
- **cancel**: Cancels entire task
- **retry**: Re-runs agent with same instructions
- **retry_with_changes**: Re-runs agent with user's new instructions

**What happens:**
1. Marks agent as 'rejected'
2. Saves rejection reason
3. If retry: Increments retryCount, clears output, re-runs agent
4. If cancel: Sets task status to 'cancelled'
5. **Emits WebSocket notification**
6. **Resumes orchestration if retry**

#### `POST /api/approvals/tasks/:taskId/toggle-mode`
Toggle between auto and human-in-loop mode.

**Body:**
```json
{
  "mode": "auto"  // or "human-in-loop"
}
```

**Special behavior:**
- If switching to 'auto' while awaiting approval → **auto-approves and continues**
- Allows real-time mode changes mid-execution

---

## 🔄 Complete Workflow Example

### Scenario: Developer Proposes Code Changes

```
1. Developer Agent Executes
   ├─ Analyzes story requirements
   ├─ Generates code for 3 files
   └─ Proposes changes (NO FILES WRITTEN YET)

2. System Captures Output
   ├─ Saves prompt sent to developer
   ├─ Saves full response + reasoning
   ├─ Generates diffs for each file
   └─ Saves to agentOutput in database

3. System Requests Approval
   ├─ Sets task.awaitingApproval = { ... }
   ├─ Marks developer status = 'pending'
   ├─ Throws 'AWAITING_USER_APPROVAL' error
   └─ ⏸️  ORCHESTRATION PAUSED

4. WebSocket Notifies Frontend
   ├─ Event: 'approval_required'
   ├─ Type: 'code_change'
   └─ Data: { agentName, agentOutput, ... }

5. User Reviews in UI
   ├─ Sees prompt sent to agent
   ├─ Sees agent's full response
   ├─ Sees code diffs (before/after)
   └─ Can add additional instructions

6a. User Approves ✅
    ├─ POST /api/approvals/tasks/:id/approve
    ├─ System applies file changes NOW
    ├─ Commits and pushes code
    ├─ Resumes orchestration
    └─ Continues to next agent

6b. User Rejects with Retry 🔄
    ├─ POST /api/approvals/tasks/:id/reject
    ├─ Agent output cleared
    ├─ Retry with new instructions
    ├─ Re-executes developer
    └─ Shows new proposal again

6c. User Cancels ❌
    ├─ POST /api/approvals/tasks/:id/reject (action: 'cancel')
    ├─ Task status = 'cancelled'
    ├─ Orchestration stops
    └─ No files changed
```

---

## 📊 Approval Types

### 1. Planning Approval
**Who:** Product Manager, Project Manager, Tech Lead

**User Sees:**
- Requirements analysis
- Epic breakdown
- Story assignments
- Architecture design
- Team composition

**User Can:**
- ✅ Approve and continue
- 🔄 Retry with modifications
- ❌ Cancel task

---

### 2. Code Change Approval
**Who:** Developers (all instances)

**User Sees:**
- Exact prompt sent to developer
- Full agent response
- Reasoning process
- **Code diffs for each file:**
  - `+ Create src/auth.ts` (new file)
  - `~ Edit src/index.ts` (modifications with diff)
  - `- Delete src/old.ts` (deletion)
- Side-by-side comparison

**User Can:**
- ✅ Approve → Files written & committed NOW
- 🔄 Retry with changes → Developer re-writes code
- ❌ Reject → No files touched

**Critical:** NO FILES ARE WRITTEN until user approves!

---

### 3. Test Results Approval
**Who:** QA Engineer

**User Sees:**
- Test execution results
- Pass/fail counts
- Coverage metrics
- Failed test details
- Recommendations

**User Can:**
- ✅ Approve if tests pass
- 🔄 Request fixes if tests fail
- ❌ Cancel if critical failures

---

### 4. Evaluation Approval
**Who:** Judge Agent

**User Sees:**
- Quality score
- Issues found
- Feedback
- Improvement suggestions

**User Can:**
- ✅ Approve and continue
- 🔄 Request improvements
- ❌ Reject and restart

---

### 5. Merge Approval
**Who:** Merge Coordinator

**User Sees:**
- Merge strategy
- Conflict detection
- PR order
- Resolution plan

**User Can:**
- ✅ Approve merge
- 🔄 Request different strategy
- ❌ Cancel merge

---

## 🎛️ Configuration Options

### Auto Mode (Opt-in)
```typescript
task.approvalMode = 'auto';
```
- No approvals required
- All agents execute automatically
- Files written immediately
- Fast execution

### Human-in-Loop Mode (Default)
```typescript
task.approvalMode = 'human-in-loop';  // DEFAULT
```
- User reviews every agent
- Approves every code change
- Can modify agent instructions
- Full control and transparency

### Real-Time Toggle
```typescript
// User can switch modes mid-execution
POST /api/approvals/tasks/:id/toggle-mode
{
  "mode": "auto"  // or "human-in-loop"
}
```

If switching to 'auto' while paused:
- Auto-approves current pending agent
- Continues immediately
- All future agents run automatically

---

## 🔒 Safety Features

### 1. No File Writes Until Approved
```typescript
// Developer proposes changes
const codeChanges = [
  { filePath: 'src/auth.ts', action: 'create', proposedContent: '...' }
];

// Saved to database
agent.agentOutput.codeChanges = codeChanges;

// ⏸️  PAUSED - waiting for approval

// ✅ USER APPROVES

// NOW files are written:
await applyCodeChanges(codeChanges, repoPath);
await commitChanges(repoPath, `Apply approved changes`);
```

### 2. No Commits Until Approved
- Code generation separated from git operations
- User reviews before ANY git commands
- Can reject without polluting history

### 3. No API Calls Until Approved (Future)
- Can extend to capture external API calls
- User reviews before execution
- Prevent unwanted operations

### 4. Rollback Support
- parentStepId links retries to originals
- Can revert to previous state
- Full audit trail

---

## 📡 WebSocket Events

### Frontend Listens For:
```typescript
socket.on('notification', (data) => {
  if (data.type === 'approval_required') {
    // Show approval UI
    showApprovalPanel(data.data);
  }
});
```

### Backend Emits:
```typescript
// Approval request
NotificationService.notifyTaskUpdate(taskId, {
  type: 'approval_required',
  data: {
    agentName: 'Developer-1',
    approvalType: 'code_change',
    agentPath: 'orchestration.team.0',
    agentOutput: { ... }
  }
});

// Approval granted
NotificationService.notifyTaskUpdate(taskId, {
  type: 'approval_granted',
  data: {
    agentName: 'Developer-1',
    additionalInstructions: '...'
  }
});

// Retry requested
NotificationService.notifyTaskUpdate(taskId, {
  type: 'approval_retry',
  data: {
    agentName: 'Developer-1',
    retryCount: 2,
    newInstructions: '...'
  }
});
```

---

## 🎨 Next Steps: Frontend Implementation

### Components Needed:

#### 1. ApprovalPanel Component
- Shows agent output
- Displays code diffs
- Approve/Reject buttons
- Additional instructions input

#### 2. CodeDiffViewer Component
- Side-by-side comparison
- Syntax highlighting
- Line-by-line changes
- File tree view

#### 3. AgentOutputViewer Component
- Prompt display
- Response display
- Reasoning display
- Structured proposal viewer

#### 4. Integration in ConsoleViewer
- Approval prompts appear in console
- Like Claude Code style
- Interactive buttons
- Real-time updates

---

## 📈 Success Metrics

✅ User sees 100% of agent outputs
✅ Zero unexpected file changes
✅ User can modify any agent's work
✅ Complete audit trail of all decisions
✅ Feels like Claude Code experience

---

## 🚀 Ready for Frontend

**Backend Status:** ✅ COMPLETE

**API Endpoints:** ✅ WORKING
- GET /api/approvals/tasks/:taskId/step/:stepPath
- POST /api/approvals/tasks/:taskId/approve
- POST /api/approvals/tasks/:taskId/reject
- POST /api/approvals/tasks/:taskId/toggle-mode

**Database:** ✅ READY
- All schemas updated
- Approval fields on all agents
- Task model extended

**WebSocket:** ✅ INTEGRATED
- Real-time notifications
- Approval events
- Status updates

**Next:** Build frontend components to display approvals and handle user interactions.

---

**Generated:** 2025-01-15
**System:** Multi-Agent Software Development Platform
**Feature:** Human-in-the-Loop Approval System (Claude Code Style)
