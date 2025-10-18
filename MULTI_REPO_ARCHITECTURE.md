# 🌐 Multi-Repository Parallel Architecture

**Version**: 2.0.0
**Date**: 2025-10-16
**Status**: ✅ **ACTIVE**

---

## 🎯 Overview

The orchestration system supports **parallel work across multiple repositories simultaneously**. All agents have access to ALL repositories in a unified workspace.

---

## 📁 Workspace Architecture

### Single Workspace, Multiple Repos

```
/tmp/agent-workspace/task-{taskId}/
├── backend/                    ← Repository 1 (cloned)
│   ├── .git/
│   ├── src/
│   ├── package.json
│   └── ...
├── frontend/                   ← Repository 2 (cloned)
│   ├── .git/
│   ├── src/
│   ├── package.json
│   └── ...
└── mobile/                     ← Repository 3 (if exists)
    ├── .git/
    ├── src/
    └── ...
```

**Key Points**:
- ✅ ALL repositories are cloned into a SINGLE workspace directory
- ✅ Each repository maintains its own `.git` directory
- ✅ Agents can navigate between repos using `cd`
- ✅ File paths are RELATIVE to each repository root

---

## 🤖 Agent Access to Repositories

### OrchestrationContext

All agents receive the same context with:

```typescript
class OrchestrationContext {
  repositories: Repository[];  // ALL repositories
  workspacePath: string;        // Path to unified workspace
  task: ITask;
  // ...
}
```

### Available to ALL Agents

Every agent (PM, PjM, TL, Devs, Judge, QA, Merge) has access to:

1. **`context.repositories`** - Full list of all repositories with metadata
2. **`context.workspacePath`** - Path to workspace containing all cloned repos
3. **SDK Tools** - Can use `Bash()`, `Read()`, `Grep()` to access ANY repo

Example:
```typescript
// Product Manager can analyze ALL repos
Bash("ls -la")  // Shows: backend/ frontend/ mobile/
Bash("cd backend && find src -name '*.ts' | head -20")
Bash("cd frontend && cat package.json")
```

---

## 🔀 Multi-Repo Workflow

### Phase 1: Product Manager

**Responsibility**: Analyze ALL repositories to understand the full system

```typescript
// PM analyzes complexity considering all repos
{
  "complexity": "complex",
  "affectedRepositories": ["backend", "frontend"],
  "recommendations": "Need to modify authentication in both repos"
}
```

### Phase 2: Project Manager

**Responsibility**: Break work into stories, identify which repo(s) each story affects

```typescript
{
  "stories": [
    {
      "id": "story-1",
      "title": "Add JWT authentication to backend API",
      "affectedRepositories": ["backend"],
      // ...
    },
    {
      "id": "story-2",
      "title": "Create login UI in frontend",
      "affectedRepositories": ["frontend"],
      // ...
    },
    {
      "id": "story-3",
      "title": "Connect frontend login to backend API",
      "affectedRepositories": ["backend", "frontend"],
      "dependencies": ["story-1", "story-2"]
      // ...
    }
  ]
}
```

### Phase 3: Tech Lead

**Responsibility**:
1. Create branches in EACH affected repository
2. Assign EXACT file paths PER repository
3. Organize parallel work

```typescript
{
  "epicBranches": [
    {
      "epicId": "story-1",
      "repositoryId": "68ecbb9646e1d888b503a5a5",
      "repositoryName": "backend",
      "branchName": "feature/jwt-auth"
    },
    {
      "epicId": "story-2",
      "repositoryId": "68ecbb9646e1d888b503a5a7",
      "repositoryName": "frontend",
      "branchName": "feature/login-ui"
    }
  ],
  "storyAssignments": [
    {
      "storyId": "story-1",
      "assignedTo": "dev-1",
      "repositoryId": "68ecbb9646e1d888b503a5a5",
      "repositoryName": "backend",
      "filesToRead": ["src/services/AuthService.ts"],
      "filesToModify": ["src/routes/auth.ts"],
      "filesToCreate": ["src/middleware/jwt.ts"]
    },
    {
      "storyId": "story-2",
      "assignedTo": "dev-2",
      "repositoryId": "68ecbb9646e1d888b503a5a7",
      "repositoryName": "frontend",
      "filesToRead": ["src/contexts/AuthContext.tsx"],
      "filesToModify": ["src/pages/Login.tsx"],
      "filesToCreate": ["src/services/authApi.ts"]
    }
  ]
}
```

**CRITICAL**: File paths are RELATIVE to repository root, NOT workspace root:
- ✅ Correct: `"src/services/AuthService.ts"` (relative to backend/)
- ❌ Wrong: `"backend/src/services/AuthService.ts"` (includes repo name)

### Phase 4: Developers

**Execution**: Developers work in PARALLEL on different repositories

```bash
# Developer 1 working on backend
cd workspace/backend
git checkout -b feature/jwt-auth
# Edit files in backend/src/...
git add .
git commit -m "Implement JWT auth"
git push origin feature/jwt-auth

# Developer 2 working on frontend (PARALLEL)
cd workspace/frontend
git checkout -b feature/login-ui
# Edit files in frontend/src/...
git add .
git commit -m "Create login UI"
git push origin feature/login-ui
```

**Key Points**:
- ✅ Developers can work on different repos simultaneously
- ✅ Each repo has its own git branch
- ✅ Changes are isolated per repository
- ✅ Developers use `cd` to navigate between repos

### Phase 5: Judge

**Responsibility**: Evaluate code quality in ALL affected repositories

```typescript
// Judge verifies changes in each repo
Bash("cd backend && grep -r 'TODO' src/")  // Check for TODOs
Bash("cd frontend && grep -r 'TODO' src/")

Read("backend/src/routes/auth.ts")  // Verify implementation
Read("frontend/src/pages/Login.tsx")
```

### Phase 6: QA

**Responsibility**: Test integration ACROSS repositories

```bash
# QA runs tests in each repo
cd backend && npm test
cd frontend && npm test

# QA verifies integration
cd backend && npm start &  # Start backend server
cd frontend && npm run build  # Build frontend with backend API
```

### Phase 7: Merge

**Responsibility**: Create PRs for EACH affected repository

```typescript
{
  "prsCreated": [
    {
      "repositoryName": "backend",
      "prNumber": 123,
      "prUrl": "https://github.com/user/backend/pull/123",
      "branch": "feature/jwt-auth"
    },
    {
      "repositoryName": "frontend",
      "prNumber": 456,
      "prUrl": "https://github.com/user/frontend/pull/456",
      "branch": "feature/login-ui"
    }
  ]
}
```

---

## 🚀 Parallel Execution

### Story-Level Parallelism

Multiple developers can work on different stories in different repos simultaneously:

```
Time →
────────────────────────────────────────
dev-1: [story-1: backend auth]
dev-2: [story-2: frontend UI]
dev-3: [story-3: mobile UI]
────────────────────────────────────────
```

### Repository-Level Parallelism

Single story can be split across repos and worked on in parallel:

```
story-auth-full:
  ├── story-auth-backend (dev-1)   ← Parallel
  └── story-auth-frontend (dev-2)  ← Parallel
```

---

## 🔧 Implementation Details

### 1. OrchestrationCoordinator Setup

```typescript
private async setupWorkspace(taskId: string, repositories: any[]): Promise<string> {
  const taskWorkspace = path.join(this.workspaceDir, `task-${taskId}`);
  fs.mkdirSync(taskWorkspace, { recursive: true });

  // Clone ALL repositories into workspace
  for (const repo of repositories) {
    await this.githubService.cloneRepository(
      repo.githubRepoName,
      repo.githubBranch || 'main',
      repo.githubToken,
      taskWorkspace
    );
  }

  return taskWorkspace;
}
```

### 2. Context Initialization

```typescript
const context = new OrchestrationContext(task, repositories, workspacePath);
// All phases receive this context with ALL repositories
```

### 3. Agent Execution

```typescript
const result = await query({
  model: fullModelId,
  messages: [{ role: 'user', content: finalPrompt }],
  tools: tools as any,
  cwd: workspacePath,  // ← Agents start in workspace root
  // Can cd to any repo: cd backend, cd frontend, etc.
});
```

---

## ✅ Verification Checklist

**Multi-Repo Support**:
- [x] All repositories cloned to single workspace
- [x] OrchestrationContext includes all repositories
- [x] All agents have access to all repos via context
- [x] IStory model includes `repositoryId` and `repositoryName`
- [x] TechLead assigns repository per story
- [x] Developers can work on any repo in workspace
- [x] Judge evaluates code across all repos
- [x] QA tests integration between repos
- [x] Merge creates PRs per affected repo

**Parallelism**:
- [x] Multiple stories can execute in parallel (different repos)
- [x] Dependency resolution prevents conflicts
- [x] Git branches isolated per repository
- [x] Each repo maintains independent git history

---

## 🎯 Example: Full-Stack Feature

**Task**: "Add user authentication system"

### Repositories Involved
- `backend` - API and database
- `frontend` - User interface
- `mobile` - Mobile app (optional)

### Orchestration Flow

1. **Product Manager**:
   ```json
   {
     "complexity": "complex",
     "affectedRepositories": ["backend", "frontend"],
     "recommendations": "Need JWT in backend, login UI in frontend"
   }
   ```

2. **Project Manager**:
   ```json
   {
     "stories": [
       {
         "id": "story-1",
         "title": "Backend JWT implementation",
         "affectedRepositories": ["backend"]
       },
       {
         "id": "story-2",
         "title": "Frontend login page",
         "affectedRepositories": ["frontend"]
       },
       {
         "id": "story-3",
         "title": "Integration testing",
         "affectedRepositories": ["backend", "frontend"],
         "dependencies": ["story-1", "story-2"]
       }
     ]
   }
   ```

3. **Tech Lead**:
   ```json
   {
     "epicBranches": [
       {
         "repositoryName": "backend",
         "branchName": "feature/jwt-auth"
       },
       {
         "repositoryName": "frontend",
         "branchName": "feature/login-ui"
       }
     ],
     "storyAssignments": [
       {
         "storyId": "story-1",
         "assignedTo": "dev-1",
         "repositoryName": "backend",
         "filesToModify": ["src/routes/auth.ts"]
       },
       {
         "storyId": "story-2",
         "assignedTo": "dev-2",
         "repositoryName": "frontend",
         "filesToModify": ["src/pages/Login.tsx"]
       }
     ]
   }
   ```

4. **Developers** (PARALLEL):
   - dev-1 works in `backend/`
   - dev-2 works in `frontend/`
   - Both can work simultaneously

5. **Judge**: Verifies both repos

6. **QA**: Tests integration between backend and frontend

7. **Merge**: Creates PRs in both repos

---

## 📊 Benefits

✅ **Parallel Development**: Multiple devs on different repos simultaneously
✅ **Unified Context**: All agents see the full system
✅ **Flexible Architecture**: Can work on 1 or N repositories
✅ **Git Isolation**: Each repo maintains independent git history
✅ **Cross-Repo Testing**: QA can test integration between repos
✅ **Organized PRs**: Separate PRs per repository

---

**Architecture Status**: ✅ Fully Implemented
**Tested**: Multi-repo parallel execution supported
**Production Ready**: Yes

---

*This architecture enables true full-stack development with multiple developers working across multiple repositories in parallel.*
