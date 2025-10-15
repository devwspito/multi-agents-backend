# 💰 Cost Approval Implementation Plan

## Problem
- Frontend has CostApprovalCard but backend NEVER asks for cost approval
- Orchestrator runs straight through without pausing for user confirmation
- Endpoints exist but aren't triggered by workflow

## Solution Architecture

### 1. **Cost Estimation Phase** (After TechLead, Before Developers)

**Location:** `TeamOrchestrator.ts` - after TechLead completes

```typescript
// After Tech Lead creates epics/stories
const epics = task.epics || [];
const totalStories = epics.reduce((sum, epic) => sum + (epic.stories?.length || 0), 0);

// Calculate cost estimate
const costEstimate = costEstimator.estimateTaskCost(task.description, {
  complexity: task.complexity,
  epicsCount: epics.length,
  storiesCount: totalStories,
  agents: ['product-manager', 'tech-lead', ...developers, 'qa-engineer', 'merge-coordinator']
});

// Save to task
task.orchestration.costEstimate = {
  estimated: costEstimate.totalEstimated,
  min: costEstimate.totalMinimum,
  max: costEstimate.totalMaximum,
  breakdown: {},
  complexity: task.complexity,
  estimatedDuration: `${costEstimate.estimatedDuration} minutes`,
  confidence: costEstimate.confidence,
  calculatedAt: new Date()
};

// Convert breakdown
costEstimate.byAgent.forEach(agent => {
  task.orchestration.costEstimate!.breakdown![agent.agent] = agent.estimated;
});

// Check if already approved
if (!task.orchestration.costEstimate.approvedAt) {
  // NOT APPROVED YET - PAUSE AND WAIT
  task.orchestration.status = 'pending_approval';
  await task.save();

  console.log(`⏸️  [Cost Approval] Waiting for user approval...`);
  console.log(`💰 Estimated cost: $${costEstimate.totalEstimated}`);

  // Emit WebSocket event to frontend
  NotificationService.emitCostApproval(taskId, {
    type: 'cost_approval',
    data: {
      estimated: costEstimate.totalEstimated,
      min: costEstimate.totalMinimum,
      max: costEstimate.totalMaximum,
      breakdown: task.orchestration.costEstimate.breakdown,
      complexity: task.complexity,
      estimatedDuration: costEstimate.estimatedDuration,
      confidence: costEstimate.confidence
    }
  });

  // STOP EXECUTION - User must approve via /api/tasks/:id/approve-cost
  return;
}

// If we reach here, cost is approved - continue to developers
console.log(`✅ [Cost Approval] Approved - continuing to developers`);
```

### 2. **NotificationService Addition**

**File:** `src/services/NotificationService.ts`

Add method:
```typescript
static emitCostApproval(taskId: string, data: any): void {
  const io = this.getIO();
  if (!io) return;

  io.to(`task:${taskId}`).emit('notification', {
    type: 'notification',
    notification: {
      type: 'cost_approval_required',
      data
    }
  });

  console.log(`📊 [WebSocket] Cost approval request sent to frontend`);
}
```

### 3. **Frontend Handling**

**File:** `Chat.jsx` - in WebSocket useEffect

Add case:
```javascript
case 'cost_approval_required':
  const costMessage = {
    id: `cost-${Date.now()}`,
    type: 'cost_approval',
    data: notification.data,
    timestamp: new Date()
  };
  setMessages(prev => [...prev, costMessage]);
  break;
```

This will automatically render CostApprovalCard in chat.

---

## Implementation Order

1. ✅ **NotificationService.emitCostApproval()** - Add WebSocket method
2. ✅ **TeamOrchestrator** - Add cost check after TechLead
3. ✅ **Frontend Chat.jsx** - Add WebSocket case
4. ✅ **Test Flow** - Create task → See cost approval card → Approve → Continues

---

## Testing Checklist

- [ ] Cost calculated after TechLead phase
- [ ] WebSocket event sent with correct data structure
- [ ] Frontend renders CostApprovalCard
- [ ] Approve button calls `/approve-cost` correctly
- [ ] Orchestrator resumes after approval
- [ ] Developers execute after approval
- [ ] Reject button cancels task

---

## Similar Pattern for Clarifications & PR Approval

**Clarifications:**
- Agent pauses when needs info
- Saves question to task.orchestration.pendingClarification
- Emits WebSocket → ClarificationCard shows
- `/clarify` endpoint provides answer and resumes

**PR Approval:**
- Merge Coordinator lists PRs
- Saves PR data to task.orchestration.pendingPRApproval
- Emits WebSocket → PRApprovalCard shows
- `/review/approve` merges and continues
