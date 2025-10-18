# Orchestration Testing Guide

## Overview
This document outlines the testing procedure for the new phase-based orchestration system following Claude Agent SDK best practices.

## System Architecture

### Old System (DEPRECATED)
- ❌ `TeamOrchestrator.ts` - Monolithic file (~1800 lines)
- ❌ Senior/Junior developer distinction
- ❌ Polling-based approval
- ❌ Complex, hard to maintain

### New System (ACTIVE)
- ✅ `OrchestrationCoordinator.ts` - Clean phase-based coordinator
- ✅ Unified `developer` type (no senior/junior)
- ✅ Event-based approval (no polling)
- ✅ Modular phases in `/orchestration/`
- ✅ 100% SDK compliant

## Phase Execution Order

```
ProductManager    → Analyzes requirements
  ↓ Approval
ProjectManager    → Breaks into stories
  ↓ Approval
TechLead          → Designs architecture + creates branches + assigns files
  ↓ Approval
Developers        → Implements features (spawns multiple devs internally)
  ↓
Judge             → Evaluates code quality (retry mechanism, max 3 attempts)
  ↓ Approval
QA                → Integration testing
  ↓ Approval
Merge             → Creates PRs and coordinates merge
  ↓ Approval
```

## Test Procedure

### Prerequisites
1. Backend server running: `npm start`
2. Frontend dev server running: `cd multi-agents-frontend && npm run dev`
3. MongoDB running
4. At least one repository configured with GitHub token

### Test 1: Basic Orchestration Flow

**Objective**: Verify all phases execute sequentially with approval gates

**Steps**:
1. Create new task via frontend chat
2. Select repository (e.g., `multi-agents-backend`)
3. Send message: "Create a health check endpoint at /health that returns status and uptime"
4. Click "Start Orchestration"
5. **Expected**: Task status changes to `in_progress`

**Verify Phase 1: Product Manager**
- [ ] Console shows: `🚀 [ProductManager] Starting phase...`
- [ ] Agent uses tools: Read(), Grep(), Glob()
- [ ] Agent outputs JSON with complexity, success criteria, recommendations
- [ ] Frontend shows approval UI with "Approve/Reject" buttons
- [ ] Console shows: `⏸️  [Approval] Waiting for human approval`

**Action**: Click "Approve" in frontend

**Verify Phase 2: Project Manager**
- [ ] Console shows: `🚀 [ProjectManager] Starting phase...`
- [ ] Agent breaks task into stories (JSON output)
- [ ] Recommended team size specified (e.g., "developers": 1)
- [ ] Frontend shows approval UI again

**Action**: Click "Approve"

**Verify Phase 3: Tech Lead**
- [ ] Console shows: `🚀 [TechLead] Starting phase...`
- [ ] Agent creates git branch: `epic/health-check-endpoint`
- [ ] Agent specifies EXACT file paths to read/modify/create
- [ ] Output shows: `filesToRead`, `filesToModify`, `filesToCreate`
- [ ] Frontend shows approval UI

**Action**: Click "Approve"

**Verify Phase 4: Developers**
- [ ] Console shows: `🚀 [Developers] Starting phase...`
- [ ] Spawns developers based on team size
- [ ] Each developer executes with assigned story
- [ ] Developers use Edit() and Write() tools (NOT documentation)
- [ ] Git commits are created

**Verify Phase 5: Judge**
- [ ] Console shows: `🚀 [Judge] Starting phase...`
- [ ] Judge evaluates each story against 5 criteria:
  - [ ] Code exists (not documentation)
  - [ ] Code complete (no TODOs/stubs)
  - [ ] Requirements met
  - [ ] Follows patterns
  - [ ] Quality standards
- [ ] If any criterion fails → developer retries with feedback
- [ ] Max 3 attempts per story
- [ ] Frontend shows approval UI after all stories approved

**Action**: Click "Approve"

**Verify Phase 6: QA**
- [ ] Console shows: `🚀 [QA] Starting phase...`
- [ ] Runs: `npm test`, `npm run build`, `npm run lint`
- [ ] Reports test results
- [ ] Frontend shows approval UI

**Action**: Click "Approve"

**Verify Phase 7: Merge**
- [ ] Console shows: `🚀 [Merge] Starting phase...`
- [ ] Creates PR using `gh pr create`
- [ ] Detects any merge conflicts
- [ ] Provides PR URL
- [ ] Frontend shows final approval UI

**Action**: Click "Approve"

**Final Verification**:
- [ ] Task status changes to `completed`
- [ ] Console shows: `✅ Orchestration completed successfully!`
- [ ] PR exists on GitHub
- [ ] Branch contains all commits from developers
- [ ] Approval history logged in task.orchestration.approvalHistory

### Test 2: Auto-Approval

**Objective**: Verify auto-approval skips human approval gates

**Steps**:
1. Create new task
2. Before starting, configure auto-approval:
   - Click settings icon (⚙️) in console tabs
   - Enable "Auto-Approval"
   - Select phases: Product Manager, Project Manager, Tech Lead
3. Start orchestration
4. **Expected**: First 3 phases execute without pausing
5. **Expected**: Developers phase still requires approval (not auto-approved)

**Verify**:
- [ ] Auto-approved phases logged in approvalHistory with `autoApproved: true`
- [ ] Manual approval phases still pause orchestration
- [ ] Frontend shows auto-approval indicator in history

### Test 3: Judge Retry Mechanism

**Objective**: Verify Judge forces developers to fix code quality issues

**Steps**:
1. Create task: "Add user authentication with JWT"
2. Start orchestration
3. Approve all phases until Developers
4. **Expected**: Developer implements code
5. **Expected**: Judge evaluates code

**Simulate Failure** (for testing, manually modify developer prompt to write incomplete code):
- Judge detects code is incomplete (e.g., has TODO comments)
- Judge status: `changes_requested`
- Judge feedback: Specific issues (e.g., "Function `generateToken` has TODO comment on line 42")
- Developer receives feedback and retries
- Max 3 attempts

**Verify**:
- [ ] Judge evaluation stored in task.orchestration.judge.evaluations
- [ ] Developer retry count tracked
- [ ] After 3 failed attempts → story marked as `failed`
- [ ] Frontend shows Judge feedback in real-time

### Test 4: Multi-Repository (Frontend + Backend)

**Objective**: Verify parallel multi-repo support

**Steps**:
1. Create task: "Add user dashboard with backend API"
2. Select TWO repositories:
   - `multi-agents-backend`
   - `multi-agents-frontend`
3. Start orchestration
4. **Expected**: Tech Lead creates branches in BOTH repos
5. **Expected**: Developers work on both repos in parallel (internally)

**Verify**:
- [ ] task.orchestration.techLead.epicBranches contains entries for both repos
- [ ] Branch names tracked per repository
- [ ] Developers can read files from both repos
- [ ] PRs created for both repositories

### Test 5: Event-Based Approval (No Polling)

**Objective**: Verify approval uses events, not polling

**Steps**:
1. Start orchestration
2. Let it pause at approval gate
3. Open browser dev tools → Network tab
4. Wait 30 seconds
5. **Expected**: NO repeated HTTP requests polling for approval status
6. Click "Approve"
7. **Expected**: Orchestration continues immediately (<100ms latency)

**Verify**:
- [ ] No polling requests in network tab
- [ ] Approval event emitted: `approval:{taskId}:{phase}`
- [ ] Console shows: `📡 [Event] Emitting approval event`
- [ ] Orchestration resumes within 100ms

### Test 6: Context Compaction (Loop Prevention)

**Objective**: Verify context compaction prevents infinite loops

**Steps**:
1. Create complex task with 10+ stories
2. Start orchestration
3. Monitor memory usage
4. **Expected**: After 5 phases, context compaction triggers
5. Console shows: `🗜️  Context compaction triggered (5 phases completed)`

**Verify**:
- [ ] Context summarized to prevent overflow
- [ ] Essential information preserved
- [ ] No infinite loops occur

## Common Issues & Debugging

### Issue: Agent not using tools
**Symptom**: Agent outputs text instead of using Read()/Write()/Edit()
**Solution**: Check AgentDefinitions.ts prompts - reinforced prompts should force tool usage

### Issue: Developer writing documentation instead of code
**Symptom**: Developer creates README.md or writes TODO comments
**Solution**: Judge should catch this and force retry. If not, check Judge prompt.

### Issue: Approval timeout
**Symptom**: Phase waits 24 hours then fails
**Solution**: User must approve within 24 hours. Check frontend approval UI is visible.

### Issue: Branch name not saved
**Symptom**: GitHub errors about branch not found
**Solution**: Verify task.orchestration.techLead.epicBranches contains correct branch names per repo

## Performance Benchmarks

Expected timing (simple task, 1 story):
- Product Manager: ~30s
- Project Manager: ~20s
- Tech Lead: ~40s (includes git branch creation)
- Developer (1 story): ~60s
- Judge: ~20s
- QA: ~40s (includes npm test)
- Merge: ~30s
- **Total**: ~4-5 minutes with manual approvals

With auto-approval enabled:
- **Total**: ~3-4 minutes

## SDK Compliance Checklist

- [x] Uses `query()` from @anthropic-ai/claude-agent-sdk
- [x] Model: claude-haiku-4-5-20251001 for all agents
- [x] Single-mode execution (non-streaming)
- [x] Tool restrictions per agent type
- [x] Context compaction after 5 phases
- [x] Human feedback loop (approval gates)
- [x] Judge-based verification
- [x] Event-based flow (no polling)
- [x] Clear error handling and rollback
- [x] Cost tracking (usage tokens)

## Next Steps After Testing

1. [ ] Test with real GitHub repository
2. [ ] Verify PRs are created correctly
3. [ ] Test with complex multi-story tasks
4. [ ] Test error scenarios (network failures, API rate limits)
5. [ ] Performance optimization if needed
6. [ ] Delete TeamOrchestrator.ts after migration confirmed

## Migration Status

- ✅ OrchestrationCoordinator created
- ✅ AgentDefinitions with reinforced prompts
- ✅ JudgePhase with retry mechanism
- ✅ ApprovalPhase with event-based system
- ✅ DevelopersPhase updated (no senior/junior)
- ✅ executeAgent() using SDK query()
- ✅ routes/tasks.ts updated
- ⏳ End-to-end testing
- ⏳ Delete TeamOrchestrator.ts

---

**Last Updated**: 2025-10-16
**System Version**: 2.0.0 (Phase-based orchestration)
