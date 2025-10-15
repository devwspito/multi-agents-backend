# Real-Time Task Control System Design

**Status**: 🔴 NOT IMPLEMENTED
**Priority**: HIGH
**Complexity**: MEDIUM

---

## 📋 THREE SCENARIOS TO HANDLE

### 1️⃣ ADD REQUIREMENTS MID-EXECUTION
**User says**: "Se me ha ocurrido que también quiero que tenga modo oscuro"

**Challenge**: Is it better to:
- A. Add to current epic (if it fits)
- B. Create new epic (if it's too different)
- C. Wait until task finishes and add as continuation

**Best Solution**: **Intelligent Evaluation by Tech Lead**

---

### 2️⃣ PAUSE (Edit Task)
**User wants to**:
- Stop temporarily (not cancel)
- Make changes or comments
- Continue later from where it stopped
- Agents should understand ALL context (what's done + what was paused)
- Avoid repeating work

**This is like "editing the task mid-execution"**

---

### 3️⃣ INTERRUPT (Cancel)
**User wants to**:
- Stop completely
- No intention to continue
- Cancel the task

---

## 🏗️ PROPOSED ARCHITECTURE

### New API Endpoints

#### 1. Add Requirement Mid-Execution
```
POST /api/tasks/:taskId/add-requirement
```

**Body**:
```json
{
  "requirement": "También quiero que tenga modo oscuro",
  "urgent": false
}
```

**Flow**:
1. Pauses orchestration gracefully
2. Saves current state
3. Sends new requirement to Tech Lead for evaluation
4. Tech Lead analyzes:
   - Can it be added to current epic? → Add story to existing epic
   - Needs separate epic? → Create new epic
   - Should wait? → Add to queue
5. Tech Lead returns decision
6. User approves plan
7. Orchestration continues with updated plan

**Response**:
```json
{
  "success": true,
  "decision": "add_to_current_epic",
  "message": "Tech Lead evaluated: This can be added as a new story to the current epic",
  "newStory": {
    "id": "story-5",
    "title": "Implement dark mode toggle",
    "assignedTo": "dev-2"
  }
}
```

---

#### 2. Pause Task
```
POST /api/tasks/:taskId/pause
```

**Body**:
```json
{
  "reason": "User wants to make changes",
  "userMessage": "Pensándolo mejor, creo que..."
}
```

**What Happens**:
1. Sets `task.status = 'paused'`
2. Saves `pausedAt`, `pausedBy`, `pauseReason`
3. Current agent finishes its current action (doesn't interrupt mid-operation)
4. Orchestration stops at next checkpoint
5. Emits WebSocket: `task_paused`
6. User can now modify requirements

**Response**:
```json
{
  "success": true,
  "message": "Task paused. You can now modify requirements and resume.",
  "pausedAt": "Phase: Development, Agent: Developer-2, Story: story-3"
}
```

---

#### 3. Resume Task
```
POST /api/tasks/:taskId/resume
```

**Body**:
```json
{
  "modifiedRequirements": "Ahora también quiero que tenga modo oscuro",
  "replanning": true
}
```

**What Happens**:
1. If `replanning: true`:
   - Calls Tech Lead with FULL context:
     ```
     Original task: [task.title]
     Already completed:
       - Product Manager ✅
       - Tech Lead ✅ (created 3 epics, 8 stories)
       - Developer-1 ✅ (completed story-1, story-2)
       - Developer-2 ⏸️ (paused on story-3)

     User added: "También quiero modo oscuro"

     Your job: Evaluate how to incorporate this:
     - Can story-3 be modified to include it?
     - Should we add a new story to current epic?
     - Should we create a separate epic?

     IMPORTANT: Don't repeat work already done!
     ```
   - Tech Lead evaluates and updates plan
   - User approves new plan
   - Orchestration continues

2. If `replanning: false`:
   - Just resumes from where it stopped
   - No changes to plan

**Response**:
```json
{
  "success": true,
  "message": "Task resumed with updated plan",
  "changes": {
    "newStories": ["story-9"],
    "modifiedStories": ["story-3"],
    "reasoning": "Tech Lead decided to add dark mode as a new story..."
  }
}
```

---

#### 4. Cancel Task
```
POST /api/tasks/:taskId/cancel
```

**Body**:
```json
{
  "reason": "User cancelled",
  "userMessage": "Ya no quiero continuar con esto"
}
```

**What Happens**:
1. Stops orchestration immediately
2. Sets `task.status = 'cancelled'`
3. Saves cancellation metadata
4. Emits WebSocket: `task_cancelled`
5. NO resume possible (task is done)

**Response**:
```json
{
  "success": true,
  "message": "Task cancelled successfully"
}
```

---

## 🎨 FRONTEND UI CHANGES

### Chat Header Additions

```jsx
<div className="chat-header">
  <h2>Task: {currentTask.title}</h2>

  {/* Status Badge */}
  <div className="task-status-badge">
    {currentTask.status === 'in_progress' && '🔄 In Progress'}
    {currentTask.status === 'paused' && '⏸️ Paused'}
    {currentTask.status === 'pending_approval' && '👤 Waiting Approval'}
  </div>

  {/* Control Buttons */}
  <div className="task-controls">
    {currentTask.status === 'in_progress' && (
      <>
        <button
          className="btn-pause"
          onClick={handlePauseTask}
          title="Pause to edit requirements"
        >
          ⏸️ Pause
        </button>

        <button
          className="btn-cancel"
          onClick={handleCancelTask}
          title="Cancel task completely"
        >
          ❌ Cancel
        </button>
      </>
    )}

    {currentTask.status === 'paused' && (
      <button
        className="btn-resume"
        onClick={handleResumeTask}
      >
        ▶️ Resume
      </button>
    )}
  </div>
</div>
```

### Add Requirement Input

```jsx
{/* Show when task is in_progress or paused */}
{currentTask && (currentTask.status === 'in_progress' || currentTask.status === 'paused') && (
  <div className="add-requirement-section">
    <input
      type="text"
      placeholder="💡 Add requirement: 'También quiero que...'"
      value={newRequirement}
      onChange={(e) => setNewRequirement(e.target.value)}
      onKeyPress={(e) => {
        if (e.key === 'Enter') {
          handleAddRequirement();
        }
      }}
    />
    <button onClick={handleAddRequirement}>
      ➕ Add Requirement
    </button>
  </div>
)}
```

---

## 🔄 ORCHESTRATOR CHANGES

### Check Pause at Every Phase

```typescript
// In orchestrateTask(), before each phase
private async checkPauseOrCancel(task: ITask): Promise<void> {
  // Refresh task from DB
  const freshTask = await Task.findById(task._id);

  if (freshTask.status === 'cancelled') {
    console.log(`❌ Task cancelled by user`);
    throw new Error('TASK_CANCELLED');
  }

  if (freshTask.status === 'paused') {
    console.log(`⏸️ Task paused by user`);
    throw new Error('TASK_PAUSED');
  }
}

// Before each phase:
await this.checkPauseOrCancel(task);
await this.executeProductManager(task, ...);

await this.checkPauseOrCancel(task);
await this.executeTechLead(task, ...);

// etc...
```

### Context Preservation for Resume

```typescript
interface ITaskSnapshot {
  pausedAt: Date;
  pausedPhase: string; // 'product_manager' | 'tech_lead' | 'development' | 'qa' | 'merge'
  pausedAgent?: string; // e.g., 'Developer-2'
  completedPhases: string[];
  completedStories: string[];
  inProgressStory?: string;

  // Agent outputs (for Tech Lead context)
  productManagerOutput?: string;
  projectManagerOutput?: string;
  techLeadOutput?: string;
}
```

Save snapshot when pausing:
```typescript
task.snapshot = {
  pausedAt: new Date(),
  pausedPhase: 'development',
  pausedAgent: 'Developer-2',
  completedPhases: ['product_manager', 'tech_lead'],
  completedStories: ['story-1', 'story-2'],
  inProgressStory: 'story-3',
  productManagerOutput: task.orchestration.productManager.output,
  projectManagerOutput: task.orchestration.projectManager.output,
  techLeadOutput: task.orchestration.techLead.output,
};
```

### Tech Lead Re-planning with Context

When user resumes with new requirements:

```typescript
const replanningSummary = `
# Task Re-planning Context

## Original Task
${task.title}

## What's Already Done ✅
${this.generateCompletedSummary(task)}

## Where We Paused ⏸️
Phase: ${task.snapshot.pausedPhase}
Agent: ${task.snapshot.pausedAgent}
Story: ${task.snapshot.inProgressStory}

## New Requirement from User
${newRequirement}

## Your Job
Evaluate how to incorporate the new requirement:

1. Can it be added to existing epics/stories?
2. Does it need a new epic?
3. Should we modify in-progress stories?
4. Can we continue from where we paused?

**CRITICAL**: Don't redo work already completed!

Completed stories: ${task.snapshot.completedStories.join(', ')}
In-progress story: ${task.snapshot.inProgressStory}

Provide an efficient plan that builds on existing work.
`;

const techLeadResult = await this.executeAgent(
  'tech-lead',
  replanningSummary,
  workspacePath,
  taskId,
  'Tech Lead (Re-planning)'
);
```

---

## 🎯 INTELLIGENT REQUIREMENT ADDITION

### Flow for "Se me ha ocurrido que..."

```
1. User types in add-requirement input:
   "También quiero que tenga modo oscuro"

2. Frontend calls:
   POST /api/tasks/:id/add-requirement
   Body: { requirement: "...", urgent: false }

3. Backend pauses orchestration gracefully:
   - Current agent finishes current operation
   - Saves state snapshot
   - Sets task.status = 'evaluating_new_requirement'

4. Backend calls Tech Lead:
   "User added new requirement mid-execution: '...'
    Current state: [snapshot]
    Evaluate: Can this be added to current epic or needs new epic?"

5. Tech Lead responds:
   Option A: "Can add as new story to epic-1"
   Option B: "Needs separate epic (different domain)"
   Option C: "Should modify story-3 (in progress)"

6. System shows decision to user in console:
   ┌─────────────────────────────────────┐
   │ 🤖 TECH LEAD EVALUATION             │
   │                                     │
   │ New requirement: "modo oscuro"      │
   │                                     │
   │ Decision: Add as new story          │
   │ Epic: epic-1 (UI Components)        │
   │ Story: story-9                      │
   │ Assigned: Developer-2               │
   │                                     │
   │ [❌ Reject] [✅ Approve & Continue] │
   └─────────────────────────────────────┘

7. User approves → Orchestration continues with updated plan
```

---

## 📊 TASK MODEL UPDATES

```typescript
interface ITask {
  // ... existing fields

  // Pause/Resume
  snapshot?: ITaskSnapshot;
  pausedAt?: Date;
  pausedBy?: mongoose.Types.ObjectId;
  pauseReason?: string;

  // Dynamic requirements
  additionalRequirements?: Array<{
    requirement: string;
    addedAt: Date;
    addedBy: mongoose.Types.ObjectId;
    status: 'pending_evaluation' | 'approved' | 'integrated';
    techLeadEvaluation?: string;
    integrationPlan?: any;
  }>;

  // Cancellation
  cancelledAt?: Date;
  cancelledBy?: mongoose.Types.ObjectId;
  cancellationReason?: string;
}
```

---

## 🔔 WEBSOCKET EVENTS

### New Events to Emit

```typescript
// When task paused
NotificationService.notifyTaskUpdate(taskId, {
  type: 'task_paused',
  data: {
    pausedAt: task.pausedAt,
    pausedPhase: task.snapshot.pausedPhase,
    pausedAgent: task.snapshot.pausedAgent,
    message: 'Task paused. You can now modify requirements.',
  },
});

// When new requirement is being evaluated
NotificationService.notifyTaskUpdate(taskId, {
  type: 'evaluating_new_requirement',
  data: {
    requirement: newRequirement,
    message: 'Tech Lead is evaluating how to incorporate this...',
  },
});

// When requirement evaluation complete
NotificationService.notifyTaskUpdate(taskId, {
  type: 'requirement_evaluation_complete',
  data: {
    decision: 'add_to_current_epic',
    newStory: { ... },
    message: 'Tech Lead decided to add as new story to epic-1',
  },
});

// When task cancelled
NotificationService.notifyTaskUpdate(taskId, {
  type: 'task_cancelled',
  data: {
    cancelledAt: task.cancelledAt,
    reason: task.cancellationReason,
  },
});
```

---

## 🎯 IMPLEMENTATION PRIORITY

### Phase 1: Basic Controls (MUST HAVE)
1. ✅ Cancel Task (easiest)
2. ✅ Pause Task
3. ✅ Resume Task (without re-planning)

### Phase 2: Intelligent Re-planning (NICE TO HAVE)
4. ✅ Add Requirement Mid-Execution
5. ✅ Tech Lead Re-planning with Context
6. ✅ Resume with Modified Requirements

### Phase 3: Advanced (FUTURE)
7. ✅ Edit In-Progress Stories
8. ✅ Rollback to Previous Phase
9. ✅ Merge Multiple Paused Tasks

---

## 📝 EXAMPLE USER FLOWS

### Flow 1: Add Requirement
```
User: "Implementa sistema de login"
→ Task starts
→ Product Manager ✅
→ Tech Lead ✅ (3 epics, 8 stories)
→ Developer-1 starts on story-1
→ Developer-2 starts on story-2

User types in add-requirement:
"También quiero que tenga modo oscuro"
→ System pauses gracefully
→ Tech Lead evaluates
→ Shows plan: "Add as story-9 in epic-1"
→ User approves
→ Developer-3 picks up story-9
→ Orchestration continues
```

### Flow 2: Pause & Modify
```
User: "Implementa dashboard"
→ Task starts
→ Product Manager ✅
→ Tech Lead ✅

User clicks "⏸️ Pause"
→ System pauses after Tech Lead
→ User modifies requirements in UI
→ User clicks "▶️ Resume with Re-planning"
→ Tech Lead re-evaluates with context
→ Shows updated plan
→ User approves
→ Orchestration continues with new plan
```

### Flow 3: Cancel
```
User: "Implementa chat"
→ Task starts
→ Product Manager ✅
→ Tech Lead ✅
→ Developer-1 working...

User clicks "❌ Cancel"
→ Confirmation modal: "Are you sure?"
→ User confirms
→ Developer-1 finishes current file (doesn't interrupt)
→ Task marked as 'cancelled'
→ No resume possible
```

---

## 🚀 NEXT STEPS TO IMPLEMENT

1. **Backend Routes** (2-3 hours)
   - POST /api/tasks/:id/pause
   - POST /api/tasks/:id/resume
   - POST /api/tasks/:id/cancel
   - POST /api/tasks/:id/add-requirement

2. **Orchestrator Changes** (3-4 hours)
   - Add checkPauseOrCancel() before each phase
   - Implement snapshot saving
   - Implement Tech Lead re-planning with context

3. **Task Model Updates** (1 hour)
   - Add pause/resume fields
   - Add additionalRequirements array
   - Add snapshot interface

4. **Frontend UI** (2-3 hours)
   - Add Pause/Resume/Cancel buttons
   - Add requirement input
   - Handle new WebSocket events
   - Show evaluation results

5. **Testing** (2 hours)
   - Test pause mid-execution
   - Test resume with re-planning
   - Test add requirement
   - Test cancel

**Total Estimated Time**: 10-13 hours

---

**Status**: 🔴 NOT IMPLEMENTED
**When Implemented**: User will have FULL CONTROL over task execution in real-time
