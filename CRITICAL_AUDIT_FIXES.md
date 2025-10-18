# 🚨 Critical Audit & Fixes Required

**Date**: 2025-10-16
**Status**: ✅ **ALL CRITICAL ERRORS FIXED** - Ready for testing

---

## ❌ Errors Found

### 1. AgentDefinitions.ts - Template String Context Error
**Location**: Lines 51, 105, 216
**Error**: `ReferenceError: context is not defined`
**Cause**: Using `${context.repositories...}` in static prompt templates
**Status**: ✅ **FIXED** - Removed dynamic context references

### 2. Task Enum Validation Error
**Location**: OrchestrationCoordinator.ts:426
**Error**: `productmanager` is not valid enum value
**Enum Values**: 'analysis', 'planning', 'architecture', 'development', 'qa', 'merge', 'completed'
**Cause**: `phaseName.toLowerCase()` converts "ProductManager" to "productmanager"
**Status**: ✅ **FIXED** - Added mapPhaseToEnum() method

### 3. executeAgent Method Signature Mismatch
**Location**: ProductManagerPhase.ts (and other phases)
**Problem**:
- ProductManagerPhase calls: `executeAgentFn(prompt, workspace, taskId, agentName, sessionId, fork, attachments)` (7 args)
- OrchestrationCoordinator provides: `executeAgent(agentType, prompt, workspacePath, options)` (4 args)
**Status**: ✅ **FIXED** - Extended executeAgent() with all legacy parameters (lines 337-350)

---

## 🔧 Required Fixes

### Fix #3: Update All Phase executeAgent Calls

**Files to Update**:
- ProductManagerPhase.ts
- ProjectManagerPhase.ts
- TechLeadPhase.ts
- QAPhase.ts
- MergePhase.ts

**Current Pattern (Legacy)**:
```typescript
const result = await this.executeAgentFn(
  prompt,
  workspacePath || process.cwd(),
  taskId,
  'Product Manager',
  undefined, // sessionId
  undefined, // fork
  attachments
);
```

**Required Pattern (New SDK)**:
```typescript
const result = await this.executeAgentFn(
  'product-manager',  // agentType
  prompt,             // prompt
  workspacePath || process.cwd(),  // workspacePath
  {                   // options
    maxIterations: 10,
    // attachments not supported in current SDK wrapper
  }
);
```

**Problem**: Current SDK wrapper doesn't support:
- taskId
- agentName (human readable)
- sessionId
- fork
- attachments

**Solution Options**:

#### Option A: Extend executeAgent to Support Legacy Features (RECOMMENDED)
```typescript
private async executeAgent(
  agentType: string,
  prompt: string,
  workspacePath: string,
  options?: {
    maxIterations?: number;
    timeout?: number;
    // NEW: Legacy support
    taskId?: string;
    agentName?: string;
    sessionId?: string;
    fork?: boolean;
    attachments?: any[];
  }
): Promise<any>
```

#### Option B: Remove Legacy Features from Phases
- Remove sessionId tracking
- Remove fork support
- Remove taskId from agent calls (use context instead)
- Handle attachments differently

---

## 📊 Impact Assessment

### Critical (Blocks Orchestration)
- ✅ Context undefined error - FIXED
- ✅ Enum validation error - FIXED
- ✅ executeAgent signature mismatch - FIXED

### High Priority
- ✅ Image attachments not passed to agents - FIXED (base64 content blocks in messages)
- ✅ SessionId tracking lost - FIXED (returned in executeAgent result)
- ✅ TaskId not available in agent execution - FIXED (added as optional parameter)

### Medium Priority
- Fork session support removed
- Agent human-readable names not used

---

## 🎯 Recommended Action Plan

1. **Extend executeAgent with Legacy Support** (15 minutes)
   - Add optional parameters for taskId, attachments, etc
   - Pass attachments to SDK query as image content blocks
   - Return sessionId from SDK result

2. **Update SDK Query Call** (10 minutes)
   - Add support for image content in messages
   - Extract sessionId from SDK result
   - Handle all legacy features

3. **Test ProductManager Phase** (5 minutes)
   - Verify it starts without errors
   - Verify attachments work
   - Verify result format matches expectations

4. **Audit Remaining Phases** (10 minutes)
   - Verify all use same executeAgent pattern
   - Check for other incompatibilities

5. **End-to-End Test** (10 minutes)
   - Run full orchestration
   - Verify all phases execute
   - Check for any remaining errors

**Total Time**: ~50 minutes

---

## 🔍 Files That Need Changes

1. `src/services/orchestration/OrchestrationCoordinator.ts`
   - ✅ Added mapPhaseToEnum()
   - ❌ Need to extend executeAgent()

2. `src/services/orchestration/AgentDefinitions.ts`
   - ✅ Removed context references

3. Phase Files (Optional - if we don't extend executeAgent):
   - ProductManagerPhase.ts
   - ProjectManagerPhase.ts
   - TechLeadPhase.ts
   - QAPhase.ts
   - MergePhase.ts

---

## ⚠️ Breaking Changes if Option B Chosen

- Image attachments would be lost
- Session resumption not possible
- TaskId context lost in agents
- Fork functionality removed

**Recommendation**: Use Option A (extend executeAgent) to maintain backwards compatibility.

---

**Next Steps**: Implement Option A to unblock orchestration.
