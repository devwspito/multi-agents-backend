# Multi-Repository Orchestration System

## 🎯 Overview

This system enables autonomous software development across **multiple repositories** (backend, frontend, mobile) with **automatic repository detection** and **sequential orchestration**.

## ✨ Key Features

### 1. **Flexible Repository Configuration**
- User-defined repository types (`backend`, `frontend`, `mobile`, `shared`)
- Custom path patterns for file detection (uses `minimatch` glob patterns)
- Execution order configuration (which repo executes first)
- Dependency management between repositories

### 2. **Automatic Epic Separation**
- Project Manager analyzes file paths in epics
- Auto-splits multi-repo epics into separate epics (one per repository)
- Adds automatic dependencies based on execution order
- Example:
  ```
  Input: Epic 1 (backend + frontend files)

  Output:
    - Epic 1-backend (executionOrder: 1)
    - Epic 1-frontend (executionOrder: 2, depends on Epic 1-backend)
  ```

### 3. **Sequential Execution by Repository**
- Team Orchestration groups epics by `executionOrder`
- Executes groups sequentially (Phase 1 → Phase 2 → Phase 3)
- Within same phase, epics execute in parallel
- Typical flow:
  ```
  Phase 1: All backend epics (parallel among themselves)
    ↓ wait for completion
  Phase 2: All frontend epics (parallel among themselves)
    ↓ wait for completion
  Phase 3: Mobile/shared epics (if any)
  ```

### 4. **Repository Validation**
- Judge Phase validates files are in correct repository
- Prevents backend code in frontend repo (and vice versa)
- Provides clear feedback if repository mismatch detected

## 📊 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Project Model                                                │
│  └─ Repository[] (type, pathPatterns, executionOrder, ...)  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ ProjectManagerPhase                                          │
│  1. Receives epics from Claude                               │
│  2. Analyzes file paths using repositoryDetection utils      │
│  3. Splits multi-repo epics                                  │
│  4. Adds automatic dependencies                              │
│  5. Sorts by executionOrder                                  │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ TeamOrchestrationPhase                                       │
│  1. Groups epics by executionOrder                           │
│  2. Executes Phase 1 (all Order 1 epics in parallel)         │
│  3. Waits for Phase 1 completion                             │
│  4. Executes Phase 2 (all Order 2 epics in parallel)         │
│  5. Repeats until all phases complete                        │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ DevelopersPhase                                              │
│  - Works in repository-specific workspace                    │
│  - Creates branches in target repository                     │
│  - Commits only to target repository                         │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ JudgePhase                                                   │
│  - Validates files belong to target repository               │
│  - Rejects if code in wrong repository                       │
│  - Provides clear feedback for corrections                   │
└─────────────────────────────────────────────────────────────┘
```

## 🔧 Setup Guide

### Step 1: Configure Repositories in Project

When creating a project, define your repositories:

```typescript
// Backend Repository
{
  name: "multi-agents-backend",
  type: "backend",
  githubRepoUrl: "https://github.com/user/multi-agents-backend",
  pathPatterns: [
    "backend/**",
    "src/models/**",
    "src/routes/**",
    "src/services/**",
    "src/middleware/**",
    "**/*.test.ts"
  ],
  executionOrder: 1, // Execute first
}

// Frontend Repository
{
  name: "ws-project-frontend",
  type: "frontend",
  githubRepoUrl: "https://github.com/user/ws-project-frontend",
  pathPatterns: [
    "frontend/**",
    "src/components/**",
    "src/views/**",
    "src/hooks/**",
    "**/*.jsx",
    "**/*.tsx"
  ],
  executionOrder: 2, // Execute after backend
  dependencies: ["multi-agents-backend"], // Explicit dependency
}
```

### Step 2: Path Patterns Guide

Path patterns use [minimatch](https://github.com/isaacs/minimatch) syntax:

| Pattern | Matches |
|---------|---------|
| `backend/**` | All files in `backend/` directory |
| `src/models/**` | All files in `src/models/` directory |
| `**/*.ts` | All TypeScript files anywhere |
| `**/*.{tsx,jsx}` | All React files anywhere |
| `src/components/*.tsx` | React components in `src/components/` (not subdirs) |
| `**/test/**` | All files in any `test/` directory |

### Step 3: Set Execution Order

- **Order 1**: Backend repositories (APIs, database, business logic)
- **Order 2**: Frontend repositories (UI, components, views)
- **Order 3**: Mobile repositories (native apps)
- **Order 4**: Shared libraries (if any)

This ensures backend APIs exist before frontend tries to consume them.

## 💡 How It Works

### Example: Full-Stack Feature Implementation

**User Request:**
> "Add user authentication with login page"

**Project Manager Generates:**
```json
{
  "epics": [
    {
      "id": "epic-1",
      "title": "User Authentication",
      "filesToModify": [
        "src/models/User.ts",           // backend
        "src/routes/auth.ts",           // backend
        "src/components/LoginForm.tsx", // frontend
        "src/views/LoginPage.tsx"       // frontend
      ]
    }
  ]
}
```

**System Auto-Splits:**
```json
{
  "epics": [
    {
      "id": "epic-1-multi-agents-backend",
      "title": "[MULTI-AGENTS-BACKEND] User Authentication",
      "targetRepository": "multi-agents-backend",
      "executionOrder": 1,
      "filesToModify": [
        "src/models/User.ts",
        "src/routes/auth.ts"
      ]
    },
    {
      "id": "epic-1-ws-project-frontend",
      "title": "[WS-PROJECT-FRONTEND] User Authentication",
      "targetRepository": "ws-project-frontend",
      "executionOrder": 2,
      "dependencies": ["epic-1-multi-agents-backend"],
      "filesToModify": [
        "src/components/LoginForm.tsx",
        "src/views/LoginPage.tsx"
      ]
    }
  ]
}
```

**Execution Flow:**
1. ✅ Phase 1: Backend epic executes
   - Creates auth models and routes
   - Commits to `multi-agents-backend` repository
   - Creates PR for review

2. ⏳ Waits for Phase 1 completion

3. ✅ Phase 2: Frontend epic executes
   - Creates login components
   - Commits to `ws-project-frontend` repository
   - Creates PR for review

## 🚀 Benefits

### Performance
- ✅ Parallel execution within same phase
- ✅ No unnecessary waiting (frontend starts as soon as backend completes)
- ✅ Maintains multi-team parallelism where possible

### Correctness
- ✅ Backend APIs exist before frontend consumes them
- ✅ No circular dependencies between repositories
- ✅ Clear execution order prevents integration issues

### Developer Experience
- ✅ Automatic repository detection (no manual configuration per task)
- ✅ Clear error messages if files in wrong repository
- ✅ Flexible configuration per project

### Scalability
- ✅ Supports unlimited repositories
- ✅ Works with monorepos or separate repositories
- ✅ Extensible to mobile, microservices, etc.

## 📝 Configuration Examples

### Monorepo Setup

```typescript
[
  {
    name: "backend",
    type: "backend",
    localPath: "packages/backend",
    pathPatterns: ["packages/backend/**"],
    executionOrder: 1,
  },
  {
    name: "frontend",
    type: "frontend",
    localPath: "packages/frontend",
    pathPatterns: ["packages/frontend/**"],
    executionOrder: 2,
  }
]
```

### Microservices Setup

```typescript
[
  {
    name: "auth-service",
    type: "backend",
    pathPatterns: ["services/auth/**"],
    executionOrder: 1,
  },
  {
    name: "user-service",
    type: "backend",
    pathPatterns: ["services/users/**"],
    executionOrder: 1, // Parallel with auth-service
  },
  {
    name: "api-gateway",
    type: "backend",
    pathPatterns: ["services/gateway/**"],
    executionOrder: 2, // Depends on auth + user services
    dependencies: ["auth-service", "user-service"],
  },
  {
    name: "web-app",
    type: "frontend",
    pathPatterns: ["apps/web/**"],
    executionOrder: 3, // Depends on gateway
  }
]
```

## 🔍 Troubleshooting

### Epic not splitting correctly

**Problem:** Epic with both backend and frontend files executes as single epic

**Solution:**
1. Check repository `pathPatterns` cover all file paths
2. Verify file paths match pattern syntax (case-sensitive)
3. Check logs for: `[ProjectManager] Epic "X" spans multiple repos`

### Frontend executing before backend

**Problem:** Frontend epic runs before backend APIs exist

**Solution:**
1. Verify backend repository has `executionOrder: 1`
2. Verify frontend repository has `executionOrder: 2`
3. Check epic dependencies are set correctly

### Files in wrong repository

**Problem:** Judge rejects code because files are in wrong repository

**Solution:**
1. Check developer agent logs for file paths created
2. Verify pathPatterns match your actual directory structure
3. Ensure workspace paths are correct

## 🎓 Advanced Topics

### Custom Execution Order

You can define any execution order:

```typescript
{
  executionOrder: 1,  // Database migrations
  executionOrder: 2,  // Backend services
  executionOrder: 3,  // GraphQL API
  executionOrder: 4,  // Frontend application
  executionOrder: 5,  // E2E tests
}
```

### Conditional Dependencies

Use `dependencies` field for explicit control:

```typescript
{
  name: "frontend",
  dependencies: ["backend", "graphql-api"],
  // Will wait for both to complete, regardless of executionOrder
}
```

## 📚 References

- Implementation: `/src/utils/repositoryDetection.ts`
- Project Manager Integration: `/src/services/orchestration/ProjectManagerPhase.ts`
- Team Orchestration: `/src/services/orchestration/TeamOrchestrationPhase.ts`
- Repository Model: `/src/models/Repository.ts`

## 🔄 Migration from Hardcoded System

### Before (Hardcoded)

```typescript
// Repositories were hardcoded in repositoryDetection.ts
const REPOSITORIES = {
  BACKEND: 'backend',
  FRONTEND: 'ws-project-frontend',
};
```

### After (User-Configured)

```typescript
// Repositories are loaded from database
const repositories = await Repository.find({ projectId });
detectRepository(filePath, repositories);
```

### Migration Steps

1. Update existing projects to define repository configurations
2. Set `type` and `pathPatterns` for each repository
3. Set `executionOrder` (backend=1, frontend=2)
4. Test with existing tasks to verify correct behavior

## 🎉 Success Criteria

✅ Backend code only in backend repository
✅ Frontend code only in frontend repository
✅ Backend executes before frontend
✅ Parallel execution within same repository type
✅ Clear error messages for repository mismatches
✅ Flexible configuration per project

---

**Rollback Point:** `96e68b21ff5af61b1a378e6fdd7523890c992dd5`

If issues arise, rollback with:
```bash
git reset --hard 96e68b21ff5af61b1a378e6fdd7523890c992dd5
```
