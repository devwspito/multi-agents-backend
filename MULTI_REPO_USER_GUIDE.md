# Multi-Repository Architecture - User Guide

## 🎯 Overview

The Multi-Agent Platform now supports **true multi-repository workflows** where different teams can work on different repositories simultaneously, with automatic dependency management and cross-repository coordination.

## ✨ Key Features

### 1. **Multi-Repository Support**
- Each epic can target a specific repository
- Automatic PR creation in the correct repository
- Full context from all repositories during development

### 2. **Dependency Management**
- Explicit epic dependencies via `dependencies` field
- Conservative policy: Cross-repository epics execute sequentially by default
- Topological sorting ensures correct execution order
- Circular dependency detection

### 3. **Conservative Safety Policy**
- **Philosophy**: "Better safe than sorry"
- Cross-repository epics automatically execute sequentially
- Prevents race conditions (e.g., frontend starting before backend API is ready)
- Can be enhanced with smart AI-based dependency detection in the future

## 🏗️ Architecture Components

### 1. **IEpic Model Extensions**
```typescript
interface IEpic {
  // ... existing fields ...

  // NEW: Multi-repo support
  targetRepository?: string;  // Repository where changes are made
  dependencies?: string[];    // Epic IDs that must complete first
}
```

### 2. **DependencyResolver**
- Located: `src/services/dependencies/DependencyResolver.ts`
- **Features**:
  - Topological sort algorithm (DFS-based)
  - Circular dependency detection
  - Groups epics into execution levels
  - Clear error messages

### 3. **ConservativeDependencyPolicy**
- Located: `src/services/dependencies/ConservativeDependencyPolicy.ts`
- **Features**:
  - Automatically adds dependencies for cross-repo safety
  - Respects repository order (repositories[0] executes first)
  - Prevents cross-repository race conditions

### 4. **Updated Phases**
- **TechLeadPhase**: Instructs Tech Lead to specify `targetRepository` for each epic
- **DevelopersPhase**: Executes epics in dependency order
- **PRManagementService**: Creates PRs in the correct target repository

## 📖 How It Works

### Workflow Example: Backend + Frontend Task

**Scenario**: User requests "Add user profile feature with avatar upload"

#### 1. **Product Manager Phase**
Identifies epics:
- Backend API epic
- Frontend UI epic

#### 2. **Tech Lead Phase**
Breaks down into stories with target repositories:

```json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "Backend API - User Profile",
      "targetRepository": "owner/backend-repo",
      "stories": ["story-1", "story-2"],
      "dependencies": []  // No dependencies, can start first
    },
    {
      "id": "epic-2",
      "name": "Frontend UI - User Profile",
      "targetRepository": "owner/frontend-repo",
      "stories": ["story-3", "story-4"],
      "dependencies": []  // Tech Lead didn't specify
    }
  ]
}
```

#### 3. **Conservative Policy Application**
The system automatically adds cross-repo dependency:

```
📦 [Multi-Repo] Processing 2 epics across repositories
🔒 [Conservative Policy] Applied to ensure cross-repo safety
   Dependencies added: 1 epic affected
   - Frontend UI - User Profile: Conservative policy: owner/frontend-repo waits for owner/backend-repo
```

**Result**:
- `epic-2` now has `dependencies: ["epic-1"]`
- Frontend will wait for backend to complete

#### 4. **Dependency Resolution**
```
📋 [Dependency Resolution] Execution order established:
   1. Backend API - User Profile → owner/backend-repo
   2. Frontend UI - User Profile → owner/frontend-repo
```

#### 5. **Development Execution**
```
🚀 [Execution] Starting epic-by-epic execution (respecting dependencies)

📍 [Epic Backend API - User Profile] Starting execution
   Developers: dev-1, dev-2
✅ [Epic Backend API - User Profile] Completed

📍 [Epic Frontend UI - User Profile] Starting execution
   Developers: dev-3
✅ [Epic Frontend UI - User Profile] Completed
```

#### 6. **PR Creation**
```
🔀 [PR Management] Creating Pull Requests for completed epics (Multi-Repo)...
  📍 Epic "Backend API - User Profile" → Repository: owner/backend-repo
  🔀 Creating PR for epic: Backend API - User Profile
  ✅ PR created: #42 - https://github.com/owner/backend-repo/pull/42

  📍 Epic "Frontend UI - User Profile" → Repository: owner/frontend-repo
  🔀 Creating PR for epic: Frontend UI - User Profile
  ✅ PR created: #18 - https://github.com/owner/frontend-repo/pull/18
```

## 🔧 Technical Details

### Conservative Dependency Policy Rules

1. **Group epics by target repository**
2. **Establish repository order** (based on array position in `repositories`)
3. **Add sequential dependencies**:
   - Repo 2 epics depend on all Repo 1 epics
   - Repo 3 epics depend on all Repo 1 & 2 epics
   - etc.

### Dependency Resolution Algorithm

1. **Validate** all dependencies reference existing epics
2. **Detect** circular dependencies using DFS
3. **Topologically sort** epics using dependency graph
4. **Group into levels** for potential parallelization (future)

### Backward Compatibility

- **Optional fields**: `targetRepository` and `dependencies` are optional
- **Default behavior**: If `targetRepository` not specified, uses `repositories[0]`
- **Legacy tasks**: Existing tasks continue to work without changes
- **Single repository**: Conservative policy not applied (no overhead)

## 📊 Execution Logs

### Understanding Log Messages

**Multi-Repo Processing**:
```
📦 [Multi-Repo] Processing 3 epics across repositories
```
→ System detected multiple repositories

**Conservative Policy Applied**:
```
🔒 [Conservative Policy] Applied to ensure cross-repo safety
   Dependencies added: 2 epics affected
   - Epic Name: Conservative policy: frontend-repo waits for backend-repo
```
→ System automatically added cross-repo dependencies

**Conservative Policy Skipped**:
```
ℹ️  [Conservative Policy] Not applied (single repository)
```
→ All epics target same repository, no cross-repo coordination needed

**Dependency Resolution**:
```
📋 [Dependency Resolution] Execution order established:
   1. Backend Epic → owner/backend
   2. Frontend Epic → owner/frontend
```
→ Shows final execution order after dependency resolution

**Epic Execution**:
```
📍 [Epic Backend API] Starting execution
   Developers: dev-1, dev-2
✅ [Epic Backend API] Completed
```
→ Epics execute sequentially in dependency order

## 🚀 Future Enhancements (FASE 9 & 10)

### FASE 9: Parallel Execution (~90 min)
- Execute independent epics in parallel
- Use execution levels from DependencyResolver
- Significant performance improvement for independent work

### FASE 10: Smart Dependency Analysis (~120 min)
- AI-based code dependency detection
- Analyze imports, API calls, shared models
- Automatically detect when frontend depends on backend APIs
- More granular than conservative policy

## 🎯 Best Practices

### 1. **Repository Organization**
- Place most important/foundational repo first (e.g., backend)
- This becomes the default for epics without explicit `targetRepository`

### 2. **Explicit Dependencies**
- Tech Lead can specify explicit dependencies in the planning phase
- These override the conservative policy
- Useful when dependencies are known upfront

### 3. **Repository Naming**
- Use consistent naming (e.g., `full_name` from GitHub)
- Tech Lead will see available repositories in the prompt

### 4. **Monitoring**
- Watch for `[Conservative Policy]` logs to understand auto-added dependencies
- Check execution order to verify it matches expectations

## 📝 Example Scenarios

### Scenario 1: Pure Backend Task
```
Task: "Optimize database queries"
Repositories: [backend-repo, frontend-repo]

Result:
- Tech Lead creates 1 epic
- Epic targets backend-repo (default)
- Conservative policy NOT applied (single repo)
- No dependency overhead
```

### Scenario 2: Database + Backend + Frontend
```
Task: "Add user authentication system"
Repositories: [db-migrations, backend-api, frontend-app]

Result:
- Epic 1: Database migrations → db-migrations
- Epic 2: Backend auth API → backend-api
- Epic 3: Frontend login UI → frontend-app

Conservative Policy:
- Epic 2 waits for Epic 1 (backend waits for migrations)
- Epic 3 waits for Epic 1 & 2 (frontend waits for backend + DB)

Execution Order: Epic 1 → Epic 2 → Epic 3
```

### Scenario 3: Independent Features
```
Task: "Add newsletter signup and update documentation"
Repositories: [backend-repo, docs-repo]

Result:
- Epic 1: Newsletter API → backend-repo
- Epic 2: Update docs → docs-repo

Conservative Policy:
- Epic 2 waits for Epic 1 (docs waits for backend)

Note: In future with FASE 9, these could run in parallel
```

## 🐛 Troubleshooting

### Error: "Dependency resolution failed: Circular dependencies detected"
**Cause**: Epics have circular dependencies (A depends on B, B depends on A)
**Solution**:
- Review Tech Lead's epic definitions
- Remove circular dependencies
- Conservative policy should prevent this, but explicit dependencies can cause it

### Error: "Target repository not found"
**Cause**: Epic's `targetRepository` doesn't match any cloned repository
**Solution**:
- Check Tech Lead used exact repository names
- Verify repositories were cloned successfully
- Check workspace logs

### Warning: "No developers assigned to epic"
**Cause**: Tech Lead didn't assign any developers to an epic
**Solution**:
- Epic will be skipped
- Review Tech Lead's story assignments
- Check teamComposition matches number of stories

## 📚 Related Documentation

- **Implementation Plan**: `MULTI_REPO_IMPLEMENTATION_PLAN.md`
- **Architecture Refactoring**: `REFACTORING_SUMMARY.md`
- **Migration Guide**: `MIGRATION_GUIDE.md` (for Pipeline Architecture)

---

**Status**: ✅ Fully Implemented (FASE 1-8 Complete)

**Version**: 1.0.0

**Last Updated**: 2025-10-11
