# Data Integrity Audit Report

**Date**: 2026-01-31
**Purpose**: Ensure data integrity for AI training data export
**Severity Scale**: CRITICAL > HIGH > MEDIUM > LOW

---

## Executive Summary

| Category | Critical | High | Medium | Total |
|----------|----------|------|--------|-------|
| Field Naming | 4 | 3 | 2 | 9 |
| Status Values | 2 | 1 | 1 | 4 |
| ID Handling | 1 | 2 | 1 | 4 |
| Case Conventions | 0 | 2 | 3 | 5 |
| **TOTAL** | **7** | **8** | **7** | **22** |

---

## 1. FIELD NAMING INCONSISTENCIES

### 1.1 Cost Fields (CRITICAL)

**Problem**: Same monetary value stored with different field names.

| Location | Field Name | Type |
|----------|------------|------|
| `EventStore.ts:150` | `totalCost` | number |
| `UnifiedMemoryService.ts:31` | `cost_usd` | string |
| `TaskRepository.ts:48` | `developerCost_usd` | number |
| `TaskRepository.ts:50` | `judgeCost_usd` | number |
| `AgentExecutionRepository.ts:36` | `costUsd` | number (camelCase) |
| `developers/types.ts:154` | `developerCost` | number |
| `developers/types.ts:180` | `judgeCost` | number |

**Training Data Impact**: AI will learn inconsistent patterns for cost tracking.

**STANDARD**:
```typescript
// In-memory (JavaScript): camelCase
costUsd: number;
developerCostUsd: number;
judgeCostUsd: number;

// In SQLite: snake_case
cost_usd REAL;
developer_cost_usd REAL;
judge_cost_usd REAL;
```

---

### 1.2 Pull Request Fields (CRITICAL)

**Problem**: PR information stored with multiple incompatible field names.

| Context | Number Field | URL Field |
|---------|--------------|-----------|
| Event payload | `prNumber` | `prUrl` |
| Epic/Task model | `pullRequestNumber` | `pullRequestUrl` |
| Return objects | `number` | `url` |
| Notifications | `prNumber` | `prUrl` |

**Files affected**:
- `EventStore.ts:36,73-74,701-702`
- `PRManagementService.ts:18-19,134-139`
- `UnifiedMemoryService.ts:175-178,455-456,472-473`
- `AutoMergePhase.ts:80-81,93-94`
- `TeamOrchestrationPhase.ts:1629-1630,1955-1956`

**Training Data Impact**: AI will see same PR referenced 3 different ways.

**STANDARD**:
```typescript
// Canonical form (stored on models)
pullRequestNumber: number;
pullRequestUrl: string;

// Short form (event payloads, function params)
prNumber: number;
prUrl: string;

// Object form (returns, PR info)
interface PRInfo {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
}
```

---

### 1.3 Retry Count Fields (HIGH)

**Problem**: Two different names for the same concept.

| Location | Field Name |
|----------|------------|
| `UnifiedMemoryService.ts:52,190,632` | `judgeIterations` |
| `UnifiedMemoryService.ts:69` | `retryCount` |
| `TaskRepository.ts:47` | `judgeIterations` |

**STANDARD**: Use `retryCount` everywhere (generic, reusable).

---

### 1.4 Complexity Fields (MEDIUM)

**Problem**: Two names accepted for the same field.

```typescript
// EventStore.ts:548-549
complexity: payload.complexity || payload.estimatedComplexity,
estimatedComplexity: payload.estimatedComplexity || payload.complexity,
```

**STANDARD**: Use `estimatedComplexity` (matches database schema).

---

### 1.5 Developer Assignment Fields (HIGH)

**Problem**: Who is assigned to a story has multiple field names.

| Location | Field Name |
|----------|------------|
| `EventStore.ts:98` | `assignedTo` |
| `TechLeadPhase.ts` | `developerId` |
| Event assignments | `storyAssignments: [{storyId, assignedTo}]` |

**Code Example** (TechLeadPhase.ts:862):
```typescript
.map(s => ({ storyId: s.storyId, assignedTo: s.developerId }));
// Reads developerId, writes as assignedTo - INCONSISTENT
```

**STANDARD**: Use `assignedTo` on story objects.

---

## 2. STATUS VALUE INCONSISTENCIES

### 2.1 Status Enum Explosion (CRITICAL)

**Problem**: Different files use different status values for the same concept.

| Context | Allowed Values |
|---------|----------------|
| Story status | `'pending' \| 'in_progress' \| 'completed' \| 'failed'` |
| Story progress | `'pending' \| 'in_progress' \| 'completed' \| 'failed' \| 'skipped'` |
| Phase status | `'pending' \| 'in_progress' \| 'completed' \| 'failed' \| 'waiting_approval' \| 'approved'` |
| Task status | `'pending' \| 'in_progress' \| 'completed' \| 'failed' \| 'cancelled' \| 'paused' \| 'interrupted'` |
| Judge result | `'approved' \| 'failed'` |
| PR state | `'open' \| 'merged' \| 'closed'` |
| Background task | `'pending' \| 'running' \| 'completed' \| 'failed' \| 'cancelled'` |

**Files affected**: 23+ files with status values

**Training Data Impact**: AI cannot learn consistent state machine patterns.

**STANDARD**: Create unified enum files:

```typescript
// src/types/status.ts

export type BaseStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type StoryStatus = BaseStatus;

export type PhaseStatus = BaseStatus | 'waiting_approval' | 'approved' | 'skipped';

export type TaskStatus = BaseStatus | 'cancelled' | 'paused';

export type JudgeVerdict = 'approved' | 'changes_requested' | 'rejected';

export type PRState = 'open' | 'merged' | 'closed';
```

---

### 2.2 Mixed Terminology (HIGH)

**Problem**: Same meaning, different words.

| Used | Should Be | Meaning |
|------|-----------|---------|
| `'running'` | `'in_progress'` | Currently executing |
| `'done'` | `'completed'` | Finished successfully |
| `'finished'` | `'completed'` | Finished successfully |
| `'rejected'` | `'failed'` | Did not pass (sometimes) |
| `'changes_requested'` | N/A | Keep as distinct from 'rejected' |

---

## 3. ID HANDLING INCONSISTENCIES

### 3.1 ID Extraction Patterns (CRITICAL - PARTIALLY FIXED)

**Problem**: Multiple patterns for extracting IDs from objects.

**IdNormalizer.ts** now centralizes this, but violations remain:

```typescript
// UnifiedMemoryService.ts:663 - STILL USES OLD PATTERN
e.id || e.epicId || e.title

// UnifiedMemoryService.ts:895-896 - DIFFERENT PATTERN
epic.name || epic.title
```

**Files still needing update**:
- `UnifiedMemoryService.ts` (3 places)
- `OrchestrationCoordinator.ts` (2 places)

---

### 3.2 ID Field Locations (MEDIUM)

**Problem**: Same ID stored in multiple fields.

| Object | Primary ID | Also stored as |
|--------|------------|----------------|
| Epic | `id` | `epicId` (on stories referencing it) |
| Story | `id` | `storyId` (in execution map) |
| Task | `id` | `taskId` (everywhere else) |

**This is acceptable** for foreign key references, but must be consistent.

---

## 4. CASE CONVENTION ISSUES

### 4.1 Database to JavaScript Mapping (HIGH)

**Problem**: Inconsistent mapping between SQLite snake_case and JS camelCase.

| SQLite Column | Expected JS | Sometimes Used |
|---------------|-------------|----------------|
| `cost_usd` | `costUsd` | `cost_usd` (leak) |
| `target_repository` | `targetRepository` | `target_repository` (leak) |
| `push_verified` | `pushVerified` | `push_verified` (leak) |

**Files with leaks**:
- `AgentExecutionRepository.ts:62,98`
- `ErrorDetectiveService.ts:52`
- `RealisticCostEstimator.ts:248`

**STANDARD**: ALWAYS convert at repository boundary:
```typescript
// Repository returns JS objects with camelCase
return {
  targetRepository: row.target_repository,
  costUsd: row.cost_usd,
  pushVerified: row.push_verified === 1,
};
```

---

## 5. FILES COLLECTION NAMING

### 5.1 Intention vs Action Based Names (MEDIUM)

**Problem**: TechLead uses intention-based, Developer uses action-based.

| Phase | Field Name | Meaning |
|-------|------------|---------|
| TechLead | `filesToModify` | Files that SHOULD be modified |
| TechLead | `filesToCreate` | Files that SHOULD be created |
| Developer | `filesModified` | Files that WERE modified |
| Developer | `filesCreated` | Files that WERE created |

**This is semantically correct** but needs documentation for AI training.

**STANDARD**: Keep both, document the distinction:
```typescript
// Planning phase (intention)
filesToModify: string[];  // Proposed by TechLead
filesToCreate: string[];  // Proposed by TechLead

// Execution phase (result)
filesModified: string[];  // Actually changed by Developer
filesCreated: string[];   // Actually created by Developer
```

---

## 6. ACTION PLAN

### Phase 1: Critical Fixes (Immediate)

1. **Create Status Enums** (`src/types/status.ts`)
   - Unified enums for all status values
   - Export and use everywhere

2. **Standardize Cost Fields**
   - Rename all to `costUsd`, `developerCostUsd`, `judgeCostUsd`
   - Update repositories to convert from snake_case

3. **Standardize PR Fields**
   - Use `pullRequestNumber`, `pullRequestUrl` on models
   - Use `prNumber`, `prUrl` in event payloads

4. **Complete IdNormalizer Migration**
   - Fix remaining 5 places not using IdNormalizer

### Phase 2: High Priority (This Week)

5. **Standardize Retry Count**
   - Rename `judgeIterations` → `retryCount`

6. **Fix Case Convention Leaks**
   - Audit all repository files
   - Ensure snake_case stays in DB layer

7. **Standardize Assignment Fields**
   - Use `assignedTo` consistently

### Phase 3: Medium Priority (Next Week)

8. **Document Field Mappings**
   - Create `FIELD_MAPPING.md` documenting all conventions

9. **Add Schema Validation**
   - Validate orchestration JSON before saving

10. **Add Training Data Sanitizer**
    - Pre-export validation to catch inconsistencies

---

## 7. VALIDATION QUERIES

Run these to verify fixes:

```sql
-- Check for snake_case leaks in logs
SELECT DISTINCT key FROM json_each(
  (SELECT metadata FROM system_logs LIMIT 1000)
) WHERE key LIKE '%_%';

-- Check status value distribution
SELECT status, COUNT(*) FROM story_progress GROUP BY status;

-- Check cost field naming
SELECT
  SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) as has_cost_usd,
  SUM(CASE WHEN developer_cost_usd IS NOT NULL THEN 1 ELSE 0 END) as has_dev_cost
FROM agent_executions;
```

---

## 8. TRAINING DATA EXPORT CHECKLIST

Before exporting for AI training:

- [ ] All status values use standardized enums
- [ ] All cost fields use `costUsd` naming
- [ ] All PR fields use consistent naming
- [ ] All IDs extracted via IdNormalizer
- [ ] No snake_case leaked into JSON
- [ ] All stories have `targetRepository`
- [ ] All epics have `targetRepository`
- [ ] No empty IDs ("" or undefined)
- [ ] No duplicate story IDs within task
- [ ] All timestamps in ISO 8601 format

---

**Report Generated By**: Claude Opus 4.5
**Next Review**: After Phase 1 fixes complete
