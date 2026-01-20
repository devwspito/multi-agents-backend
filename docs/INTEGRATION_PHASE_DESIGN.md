# IntegrationPhase Design

## Problem Statement

When multiple teams develop epics in parallel, they each modify shared files (routes/index.ts, models/index.ts, app.ts, etc.). Simple git merge strategies fail because:

1. **--theirs overwrites** instead of combining exports
2. **--ours ignores** the new epic's changes
3. **Manual merge** requires understanding the codebase structure

## Proposed Solution: IntegrationPhase

A specialized phase that runs after all team PRs are created, handling:
1. Intelligent merge conflict resolution
2. Integration fixes (missing exports, type errors)
3. Build verification
4. Final cleanup

---

## Architecture

```
IntegrationPhase
├── MergeAnalyzer          (Analyzes PRs and determines merge order)
├── ConflictResolver       (Handles merge conflicts intelligently)
├── IntegrationValidator   (Runs build, identifies issues)
└── IntegrationDeveloper   (Fixes remaining issues)
```

---

## Phase 1: MergeAnalyzer

**Purpose**: Analyze all PRs and determine optimal merge order

**Input**: List of PR URLs/branches from completed epics

**Output**:
- Ordered list of branches to merge
- Predicted conflict files
- Dependency graph between epics

**Logic**:
```typescript
interface MergeAnalysis {
  mergeOrder: string[];           // Branches in order
  conflictFiles: string[];        // Files that will conflict
  sharedFiles: Map<string, string[]>; // file -> branches that modify it
  dependencies: Map<string, string[]>; // epic -> epics it depends on
}
```

**Merge Order Strategy**:
1. Foundation/infrastructure first (database, config)
2. Models second (dependencies for services)
3. Services/business logic third
4. Routes/controllers fourth
5. Real-time/socket last (depends on everything)

---

## Phase 2: ConflictResolver

**Purpose**: Intelligently resolve merge conflicts

**Key Insight**: Most conflicts in Node.js projects are in index.ts barrel files where we need to COMBINE exports, not choose one side.

### Conflict Patterns & Resolution Strategies

#### Pattern 1: Index.ts Barrel Exports
```typescript
// CONFLICT in src/models/index.ts
<<<<<<< HEAD
export { User } from './User';
export { Step } from './Step';
=======
export { User } from './User';
export { GroupGoal } from './GroupGoal';
>>>>>>> epic-goals

// RESOLUTION: Combine both
export { User } from './User';
export { Step } from './Step';
export { GroupGoal } from './GroupGoal';
```

#### Pattern 2: Route Registration
```typescript
// CONFLICT in src/routes/index.ts
<<<<<<< HEAD
router.use('/steps', stepsRoutes);
=======
router.use('/goals', goalsRoutes);
>>>>>>> epic-goals

// RESOLUTION: Include both
router.use('/steps', stepsRoutes);
router.use('/goals', goalsRoutes);
```

#### Pattern 3: Config Properties
```typescript
// CONFLICT in src/config/index.ts
<<<<<<< HEAD
const config = {
  port: 3001,
  jwtSecret: '...',
};
=======
const config = {
  port: 3001,
  socketCorsOrigin: '...',
};
>>>>>>> epic-realtime

// RESOLUTION: Merge properties
const config = {
  port: 3001,
  jwtSecret: '...',
  socketCorsOrigin: '...',
};
```

#### Pattern 4: Import Statements
```typescript
// CONFLICT in src/app.ts
<<<<<<< HEAD
import stepsRoutes from './routes/steps.routes';
=======
import goalsRoutes from './routes/goals.routes';
>>>>>>> epic-goals

// RESOLUTION: Include both imports
import stepsRoutes from './routes/steps.routes';
import goalsRoutes from './routes/goals.routes';
```

### ConflictResolver Implementation

```typescript
interface ConflictResolution {
  file: string;
  strategy: 'combine_exports' | 'merge_objects' | 'include_both' | 'manual';
  resolvedContent: string;
  confidence: number; // 0-1, low confidence = needs human review
}

class ConflictResolver {
  async resolveConflict(
    file: string,
    oursContent: string,
    theirsContent: string,
    baseContent: string
  ): Promise<ConflictResolution> {
    // Detect pattern based on file path and content
    if (file.endsWith('index.ts') && this.isBarrelFile(oursContent)) {
      return this.combineExports(oursContent, theirsContent);
    }
    if (file.includes('/config/')) {
      return this.mergeConfigObjects(oursContent, theirsContent);
    }
    if (file.includes('/routes/') && file.endsWith('index.ts')) {
      return this.combineRoutes(oursContent, theirsContent);
    }
    // ... more patterns

    return { strategy: 'manual', confidence: 0 };
  }
}
```

---

## Phase 3: IntegrationValidator

**Purpose**: Verify the merged codebase compiles and runs

**Steps**:
1. `npm install` - Ensure dependencies are installed
2. `npm run build` - TypeScript compilation
3. `npm run lint` - Code quality (optional, can fix)
4. `npm test` - Run tests (if any)

**Output**:
```typescript
interface ValidationResult {
  buildSuccess: boolean;
  errors: CompilerError[];
  warnings: CompilerWarning[];
  missingExports: string[];      // e.g., "AuthenticatedRequest not exported"
  missingFunctions: string[];    // e.g., "getSharingRoomName not found"
  typeErrors: TypeErrorInfo[];
}
```

---

## Phase 4: IntegrationDeveloper

**Purpose**: Fix remaining integration issues

**Common Issues & Fixes**:

| Issue | Detection | Fix |
|-------|-----------|-----|
| Missing type export | `TS2614: Module has no exported member` | Add export alias |
| Missing function | `TS2339: Property does not exist` | Implement function or fix import |
| Wrong import path | `TS2307: Cannot find module` | Fix import statement |
| Type mismatch | `TS2353: Object literal may only specify known properties` | Update interface |
| Merge conflict markers | `TS1185: Merge conflict marker encountered` | Remove conflict markers |

**Agent Prompt**:
```
You are an Integration Developer. Your job is to fix compilation errors
after merging multiple feature branches.

Given these TypeScript errors:
{errors}

Fix each error by:
1. Reading the affected file
2. Understanding what the code expects
3. Making minimal changes to fix the error
4. NOT changing business logic, only fixing integration issues

Common fixes:
- Add missing type exports/aliases
- Add missing utility functions referenced by handlers
- Fix import paths
- Remove merge conflict markers
- Update interfaces to include new fields
```

---

## Implementation as Mini-Team

Instead of one phase, use a small dedicated team:

```typescript
interface IntegrationTeam {
  coordinator: 'MergeCoordinator';  // Orchestrates the process
  agents: [
    'ConflictResolver',             // Handles git conflicts
    'IntegrationDeveloper',         // Fixes TS errors
    'BuildValidator'                // Verifies build works
  ];
}
```

### Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    IntegrationPhase                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. MergeCoordinator                                         │
│     ├── Fetch all completed PRs                              │
│     ├── Analyze merge order                                  │
│     └── Identify conflict-prone files                        │
│                                                              │
│  2. For each PR (in order):                                  │
│     ├── git merge --no-commit                                │
│     ├── If conflicts:                                        │
│     │   └── ConflictResolver resolves each file              │
│     ├── git add & commit                                     │
│     └── Continue to next PR                                  │
│                                                              │
│  3. BuildValidator                                           │
│     ├── npm install                                          │
│     ├── npm run build                                        │
│     └── Collect errors                                       │
│                                                              │
│  4. If errors:                                               │
│     └── IntegrationDeveloper                                 │
│         ├── Read error messages                              │
│         ├── Fix each error                                   │
│         ├── Re-run build                                     │
│         └── Repeat until clean                               │
│                                                              │
│  5. Final commit & push                                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Tools Needed

### 1. MergeAnalysisTool
```typescript
{
  name: 'analyze_merge_order',
  description: 'Analyze PRs and determine optimal merge order',
  input: { prUrls: string[] },
  output: MergeAnalysis
}
```

### 2. ConflictDetectionTool
```typescript
{
  name: 'detect_conflicts',
  description: 'Detect and categorize merge conflicts',
  input: { file: string },
  output: ConflictInfo
}
```

### 3. ConflictResolutionTool
```typescript
{
  name: 'resolve_conflict',
  description: 'Resolve a merge conflict using pattern-based strategy',
  input: { file: string, ours: string, theirs: string, base: string },
  output: ConflictResolution
}
```

### 4. BuildValidationTool
```typescript
{
  name: 'validate_build',
  description: 'Run TypeScript build and collect errors',
  input: { projectPath: string },
  output: ValidationResult
}
```

---

## Error Recovery

If IntegrationPhase fails:
1. **Conflict unresolvable** → Flag for human review, provide context
2. **Build fails repeatedly** → Create detailed error report, optionally create GitHub issue
3. **Test failures** → Document which tests fail and why

---

## Success Criteria

IntegrationPhase is complete when:
- [ ] All PRs merged to main
- [ ] No merge conflict markers in codebase
- [ ] `npm run build` passes
- [ ] All exports are properly connected
- [ ] Project structure is verified

---

## Example Run

```
[IntegrationPhase] Starting integration of 8 PRs

[MergeCoordinator] Analyzing PRs...
  - PR #2: Foundation (no dependencies)
  - PR #3: Database (depends on: Foundation)
  - PR #5: Auth (depends on: Database)
  - PR #8: Server (depends on: Auth)
  - PR #6: Steps (depends on: Server, Auth)
  - PR #4: Sharing (depends on: Server, Auth)
  - PR #7: Goals (depends on: Server, Auth)
  - PR #9: Realtime (depends on: Steps, Sharing, Goals)

[MergeCoordinator] Predicted conflict files:
  - src/models/index.ts (6 PRs modify)
  - src/routes/index.ts (5 PRs modify)
  - package.json (8 PRs modify)
  - tsconfig.json (3 PRs modify)

[ConflictResolver] Merging PR #2... OK (no conflicts)
[ConflictResolver] Merging PR #3... OK (no conflicts)
[ConflictResolver] Merging PR #5...
  - Conflict in src/models/index.ts
  - Strategy: combine_exports (confidence: 0.95)
  - Resolved: Added User export
[ConflictResolver] Merging PR #6...
  - Conflict in src/models/index.ts
  - Strategy: combine_exports (confidence: 0.95)
  - Resolved: Added Step export
...

[BuildValidator] Running npm run build...
  ERROR: src/controllers/goals.controller.ts(7): Cannot find 'AuthenticatedRequest'
  ERROR: src/socket/index.ts(5): Cannot find named export 'config'

[IntegrationDeveloper] Fixing 2 errors...
  - Added AuthenticatedRequest type alias to authenticate.ts
  - Fixed config import in socket/index.ts

[BuildValidator] Re-running npm run build... SUCCESS

[IntegrationPhase] Complete! Main branch is ready.
```

---

## Next Steps

1. Implement ConflictResolver with pattern matching
2. Create IntegrationDeveloper agent prompt
3. Add IntegrationPhase to orchestration flow
4. Test with real multi-team scenario
