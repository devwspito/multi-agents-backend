# 🔗 Frontend Integration Guide - Orchestration System

**Date**: 2025-10-16
**Backend Version**: 2.0.0 (Phase-based orchestration)

---

## 🚨 Critical Issue Found

### Error: "No repositories found for this task"

**Problem**: Tasks are being created without `repositoryIds`, causing orchestration to fail.

**Root Cause**: Frontend is creating tasks without associating them with repositories.

---

## ✅ Required Flow for Task Creation

### Step 1: Create Task with Repository

When creating a new task, **you MUST include at least one repository ID**:

```typescript
// ❌ WRONG - Will fail when starting orchestration
POST /api/tasks
{
  "title": "Implement user authentication",
  "description": "Add JWT authentication",
  "priority": "high"
  // Missing: repositoryIds
}

// ✅ CORRECT - Will work
POST /api/tasks
{
  "title": "Implement user authentication",
  "description": "Add JWT authentication",
  "priority": "high",
  "repositoryIds": ["68ecbb9646e1d888b503a5a5"] // ← REQUIRED
}
```

### Step 2: Get Available Repositories

Before creating a task, fetch available repositories:

```typescript
GET /api/repositories
Authorization: Bearer <jwt-token>

Response:
{
  "success": true,
  "data": [
    {
      "_id": "68ecbb9646e1d888b503a5a5",
      "name": "backend",
      "githubRepoName": "user/backend-repo",
      "githubBranch": "main",
      "githubToken": "ghp_...",
      "userId": "..."
    }
  ]
}
```

### Step 3: Start Orchestration

```typescript
POST /api/tasks/:id/start
{
  "description": "User's chat message describing what to build"
}

// Backend will now validate that task has repositories before starting
```

---

## 📋 Backend Validation (New in 2.0.0)

The `/api/tasks/:id/start` endpoint now validates repositories **before** starting orchestration:

```typescript
// Backend validation (automatic)
if (!task.repositoryIds || task.repositoryIds.length === 0) {
  return 400 Bad Request
  {
    "success": false,
    "message": "Cannot start orchestration: No repositories configured for this task",
    "error": "MISSING_REPOSITORIES",
    "hint": "Please configure at least one repository in the task settings before starting orchestration"
  }
}
```

---

## 🎯 Frontend UI Requirements

### Option 1: Repository Selection in Task Creation

Add repository selection to the task creation form:

```tsx
function CreateTaskForm() {
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const { data: repositories } = useRepositories();

  return (
    <form onSubmit={handleCreateTask}>
      <input name="title" placeholder="Task title" required />
      <textarea name="description" placeholder="Description" />

      {/* ✅ ADD THIS: Repository selection */}
      <Select
        multiple
        value={selectedRepos}
        onChange={setSelectedRepos}
        required // Make it required
      >
        {repositories?.map(repo => (
          <option key={repo._id} value={repo._id}>
            {repo.name} ({repo.githubRepoName})
          </option>
        ))}
      </Select>

      <button type="submit">Create Task</button>
    </form>
  );
}
```

### Option 2: Repository Configuration Before Starting

Allow users to configure repositories after task creation but before starting:

```tsx
function TaskDetailView({ taskId }) {
  const { data: task } = useTask(taskId);
  const [selectedRepos, setSelectedRepos] = useState(task?.repositoryIds || []);

  const handleStart = async () => {
    // Update task with selected repositories first
    await updateTask(taskId, { repositoryIds: selectedRepos });

    // Then start orchestration
    await startOrchestration(taskId, { description: chatMessage });
  };

  return (
    <div>
      {(!task?.repositoryIds || task.repositoryIds.length === 0) && (
        <Alert severity="warning">
          ⚠️ No repositories configured. Please select at least one repository before starting.
        </Alert>
      )}

      <Select
        multiple
        value={selectedRepos}
        onChange={setSelectedRepos}
      >
        {repositories?.map(repo => (
          <option key={repo._id} value={repo._id}>
            {repo.name}
          </option>
        ))}
      </Select>

      <button
        onClick={handleStart}
        disabled={selectedRepos.length === 0}
      >
        Start Orchestration
      </button>
    </div>
  );
}
```

---

## 🔍 Debugging: Check Task Configuration

### Get Task Details

```typescript
GET /api/tasks/:id

Response:
{
  "success": true,
  "data": {
    "_id": "68efc968796ea58af056ad78",
    "title": "My Task",
    "repositoryIds": [], // ← Empty = will fail!
    "status": "pending"
  }
}
```

### Update Task Repositories

```typescript
PATCH /api/tasks/:id
{
  "repositoryIds": ["68ecbb9646e1d888b503a5a5"]
}
```

---

## 🚀 Complete Flow Example

```typescript
// 1. Fetch available repositories
const repositories = await fetch('/api/repositories', {
  headers: { 'Authorization': `Bearer ${token}` }
}).then(r => r.json());

// 2. Create task WITH repository
const task = await fetch('/api/tasks', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    title: 'Implement user authentication',
    repositoryIds: [repositories.data[0]._id], // ✅ Include repository
    priority: 'high'
  })
}).then(r => r.json());

// 3. Start orchestration (will now work)
const result = await fetch(`/api/tasks/${task.data.task._id}/start`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    description: 'Add JWT-based authentication with login and signup endpoints'
  })
}).then(r => r.json());

console.log(result);
// {
//   "success": true,
//   "message": "Phase-based orchestration started (SDK compliant)",
//   "data": { ... }
// }
```

---

## ❌ Error Handling

### Error: MISSING_REPOSITORIES (400)

```json
{
  "success": false,
  "message": "Cannot start orchestration: No repositories configured for this task",
  "error": "MISSING_REPOSITORIES",
  "hint": "Please configure at least one repository in the task settings before starting orchestration"
}
```

**Solution**: Configure at least one repository for the task before starting.

### Error: No repositories found for this task (500)

```json
{
  "success": false,
  "message": "Orchestration failed",
  "error": "No repositories found for this task. Task has 1 repositoryIds configured, but none were found in the database."
}
```

**Solution**: The repository ID in `repositoryIds` doesn't exist. Verify repository exists in database.

---

## 🧪 Testing Checklist

- [ ] Frontend displays available repositories
- [ ] Task creation requires at least one repository
- [ ] Starting orchestration validates repositories
- [ ] Error messages are shown to user
- [ ] User can add/remove repositories after task creation
- [ ] Orchestration starts successfully with configured repositories

---

## 📞 Backend Changes (v2.0.0)

1. **NotificationService**: Added `emitTaskStarted()` and `emitTaskFailed()` methods
2. **OrchestrationCoordinator**: Improved error messages for missing repositories
3. **tasks.ts route**: Added validation for repositories before starting orchestration

---

## 🎯 Next Steps for Frontend Team

1. **Add repository selection to task creation UI**
2. **Show warning if task has no repositories**
3. **Disable "Start Orchestration" button if no repositories configured**
4. **Handle MISSING_REPOSITORIES error (400) gracefully**
5. **Test complete flow: create task → configure repos → start orchestration**

---

**Contact**: Backend team ready to assist with integration questions.
