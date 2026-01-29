# Known Limitations

## 🚨 CRITICAL: Task Re-execution Not Supported

### The Problem

**Re-running the orchestrator on a completed/failed task is NOT supported.**

Once a task has been executed by the orchestrator (regardless of outcome: completed, failed, or interrupted), launching a new orchestration on the same task will cause **unpredictable behavior**.

### Why This Happens

1. **State Pollution**: The task already has orchestration state (phases completed, agent outputs, event history)
2. **Context Contamination**: EventStore contains previous execution data that will be mixed with new execution
3. **Phase Confusion**: Phases may read stale data from previous runs
4. **Git State**: Branches, commits, and PRs from previous run may conflict
5. **Sandbox Collisions**: Previous sandbox artifacts may interfere

### What Breaks

| Component | Issue |
|-----------|-------|
| `OrchestrationContext` | Loads previous state, doesn't reset cleanly |
| `EventStore` | Accumulates events from multiple runs |
| `Phase Results` | Previous phase results affect new decisions |
| `Git Branches` | May already exist from previous run |
| `PRs` | Duplicate PRs or conflicts |
| `Sandbox` | Port conflicts, stale processes |

### Current Behavior (UNDEFINED)

When you re-run orchestration on an existing task:
- ❌ Some phases may skip (think they already ran)
- ❌ Some phases may fail (conflicting state)
- ❌ Some phases may duplicate work (create duplicate PRs)
- ❌ EventStore will have mixed data from both runs
- ❌ Cost tracking will be incorrect
- ❌ Final status may be inconsistent

### What IS Supported

| Scenario | Supported | How |
|----------|-----------|-----|
| **New task** | ✅ Yes | Create new task, run orchestrator |
| **View completed task** | ✅ Yes | Read-only access to results |
| **Re-launch sandbox** | ⚠️ Partial | `/api/sandbox/relaunch/:taskId` - starts dev servers only |
| **Continue after failure** | ❌ No | Must create new task |
| **Resume interrupted task** | ❌ No | Must create new task |
| **Re-run specific phase** | ❌ No | Not implemented |

### The Relaunch Endpoint

The `/api/sandbox/relaunch/:taskId` endpoint is **NOT** task re-execution. It only:
1. Scans the existing workspace for repos
2. Creates a new sandbox container
3. Installs dependencies
4. Starts dev servers

It does **NOT**:
- Re-run any agents
- Re-execute phases
- Modify code
- Create commits/PRs
- Update task state

### Future Work Required

To properly support task continuation, we would need:

1. **Clean State Reset**
   ```typescript
   // NOT IMPLEMENTED
   async function resetTaskForReExecution(taskId: string) {
     // Clear EventStore for this task
     // Reset orchestration state
     // Clean up git branches
     // Remove previous PRs
     // Clear sandbox artifacts
   }
   ```

2. **Checkpoint System**
   ```typescript
   // NOT IMPLEMENTED
   interface OrchestrationCheckpoint {
     taskId: string;
     completedPhases: string[];
     phaseOutputs: Record<string, any>;
     gitState: { branch: string; lastCommit: string };
     resumePoint: string;
   }
   ```

3. **Idempotent Phases**
   - Each phase would need to check if its work is already done
   - Skip gracefully if artifacts exist
   - Handle partial completion

4. **Event Versioning**
   - Tag events with execution run ID
   - Filter events by run when reading

### Workaround: Manual Task Continuation

If you need to "continue" work on a task:

1. **Create a new task** with reference to the original
2. **Copy the workspace** (or use same repos)
3. **Start fresh orchestration** on the new task
4. **Link tasks** in your tracking system

```bash
# Example: "Continue" a failed task
# 1. Note the repos/branch from original task
# 2. Create new task with same repos
# 3. Provide context about what was already done in the prompt
```

### Impact Assessment

| Risk Level | Area |
|------------|------|
| 🔴 Critical | Data integrity (mixed event history) |
| 🔴 Critical | Cost tracking (double counting) |
| 🟠 High | Git state (conflicts, duplicate PRs) |
| 🟠 High | User confusion (inconsistent status) |
| 🟡 Medium | Resource waste (duplicate work) |

### Acceptance of Limitation

**This limitation is ACCEPTED for the current version.**

Rationale:
- Task re-execution is an edge case
- Proper implementation requires significant refactoring
- Workaround (new task) is available
- Focus is on completing new tasks reliably

### Status

- **Status**: Known Limitation (Accepted)
- **Priority**: Low (workaround available)
- **Estimated Effort**: 20-30 hours to implement properly
- **Target Version**: Not scheduled

---

*Last Updated: 2025-01-30*
*Author: Development Team*
