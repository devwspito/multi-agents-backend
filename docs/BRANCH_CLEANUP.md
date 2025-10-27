# 🧹 Branch Cleanup System

## Problem

After orchestration completes, GitHub repositories get cluttered with dozens of branches:
- `epic/c0d33d27-epic-webhook-objectid-fix-1761242026720-9nmggb`
- `story/c0d33d27-epic-webhook-objectid-fix-story-2-1761242265667-15adh4`
- `story/c0d33d27-epic-webhook-event-expansion-story-5-1761243694268-67o1h8`
- ... and many more

**Result**: Impossible to know which branches are part of which epic, and when it's safe to delete them.

## Solution

Automated branch cleanup system that:
1. **Tracks** which story branches belong to each epic
2. **Cleans up** all branches after you merge the epic PR
3. **Provides preview** before deletion to avoid mistakes

---

## 🎯 How It Works

### 1. Automatic Tracking

The system automatically tracks branch relationships during orchestration:

```
Epic: epic/c0d33d27-webhook-improvements
  ├── story/webhook-story-1 (merged into epic)
  ├── story/webhook-story-2 (merged into epic)
  └── story/webhook-story-3 (merged into epic)
```

All relationships are stored in `task.orchestration.teamOrchestration.teams[]`.

### 2. Preview Cleanup

**Before** deleting anything, preview what would be deleted:

```bash
GET /api/cleanup/preview/:taskId
```

**Response:**
```json
{
  "message": "Preview: 12 branches would be deleted across 3 epic(s)",
  "taskId": "67890abc",
  "taskStatus": "completed",
  "epics": [
    {
      "epicId": "epic-1",
      "epicBranch": "epic/c0d33d27-webhook-improvements",
      "repository": "multi-agents-backend",
      "pullRequestNumber": 42,
      "storyBranches": [
        {
          "storyId": "story-1",
          "branchName": "story/webhook-story-1",
          "pullRequestNumber": 38,
          "merged": true
        }
      ],
      "branchesToDelete": [
        "epic/c0d33d27-webhook-improvements",
        "story/webhook-story-1",
        "story/webhook-story-2"
      ],
      "totalBranchCount": 3
    }
  ],
  "totalBranches": 12
}
```

### 3. Clean Up All Branches

**After** merging all epic PRs:

```bash
POST /api/cleanup/task/:taskId
```

**What happens:**
1. ✅ Deletes all story branches for each epic
2. ✅ Deletes epic branches
3. ✅ Keeps only `main` branch clean

**Response:**
```json
{
  "success": true,
  "message": "Cleanup complete: 12 branches deleted",
  "results": [
    {
      "epicId": "epic-1",
      "epicBranch": "epic/webhook-improvements",
      "success": true,
      "storyBranchesDeleted": 3
    }
  ],
  "summary": {
    "totalEpics": 3,
    "successfulCleanups": 3,
    "failedCleanups": 0,
    "totalBranchesDeleted": 12
  }
}
```

### 4. Clean Up Single Epic

If you want to clean up one epic at a time:

```bash
POST /api/cleanup/epic/:taskId/:epicId
```

**Use case**: You merged epic A's PR, but epic B's PR is still under review.

---

## 📖 Usage Guide

### Step 1: Complete Orchestration

Run your task normally:
```bash
POST /api/tasks/:taskId/start
```

Wait for orchestration to complete. You should see:
- ✅ QA phase completed
- ✅ Epic PRs created

### Step 2: Review and Merge PRs

Go to GitHub and review the epic PRs:
- Review code changes
- Run CI/CD checks
- Merge when ready

### Step 3: Preview Cleanup

**Before deleting**, preview what will be removed:

```bash
curl -X GET http://localhost:5001/api/cleanup/preview/67890abc \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Check the response to ensure you're deleting the right branches.

### Step 4: Run Cleanup

Delete all branches:

```bash
curl -X POST http://localhost:5001/api/cleanup/task/67890abc \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Result**: All epic and story branches deleted from GitHub.

---

## 🔒 Safety Features

### 1. Task Must Be Completed
```json
{
  "error": "Task is not completed yet",
  "hint": "Only completed tasks with merged PRs can be cleaned up"
}
```

### 2. Authorization Check
Only the task owner can clean up branches:
```json
{
  "error": "Not authorized to clean up this task"
}
```

### 3. Preview Before Delete
Always use `/preview` endpoint first to see what will be deleted.

### 4. Partial Failures Handled
If some branches fail to delete, you get a detailed report:
```json
{
  "results": [
    {
      "epicId": "epic-1",
      "success": true
    },
    {
      "epicId": "epic-2",
      "success": false,
      "error": "Branch not found"
    }
  ]
}
```

---

## 🛠️ API Reference

### Preview Cleanup
```http
GET /api/cleanup/preview/:taskId
Authorization: Bearer <token>
```

**Response**: List of branches that would be deleted

---

### Clean Up All Branches
```http
POST /api/cleanup/task/:taskId
Authorization: Bearer <token>
```

**Requirements**:
- Task must be completed
- User must own the task

**Response**: Cleanup summary with deleted branches

---

### Clean Up Single Epic
```http
POST /api/cleanup/epic/:taskId/:epicId
Authorization: Bearer <token>
```

**Use Case**: Incremental cleanup when only some PRs are merged

**Response**: Cleanup result for specific epic

---

## 📊 Example Workflow

### Scenario: 3 Epics with 4 Stories Each

1. **Orchestration completes**:
   - 3 epic branches created
   - 12 story branches created (4 per epic)
   - Total: 15 branches

2. **Preview cleanup**:
   ```bash
   GET /api/cleanup/preview/67890abc
   ```
   Output: "15 branches would be deleted across 3 epics"

3. **Merge PRs in GitHub**:
   - Epic 1 PR #42 → Merged ✅
   - Epic 2 PR #43 → Merged ✅
   - Epic 3 PR #44 → Merged ✅

4. **Run cleanup**:
   ```bash
   POST /api/cleanup/task/67890abc
   ```
   Output: "15 branches deleted"

5. **Final state**:
   - Only `main` branch remains
   - GitHub is clean and organized

---

## ❓ FAQ

### Q: What if I haven't merged the PRs yet?
**A**: The cleanup will still delete the branches. Only run cleanup AFTER merging PRs.

### Q: Can I undo cleanup?
**A**: No, branch deletion is permanent. Always use `/preview` first.

### Q: What if cleanup fails for some branches?
**A**: You'll get a detailed report showing which branches failed and why. You can re-run cleanup to retry failed branches.

### Q: Do I need to clean up manually?
**A**: No, but you **must** call the API endpoints. The system doesn't auto-cleanup to avoid deleting branches before PR review.

### Q: What if I only want to clean up one epic?
**A**: Use the `/epic/:taskId/:epicId` endpoint to clean up specific epics.

---

## 🔧 Troubleshooting

### Error: "No branch mappings found"

**Cause**: Task orchestration data is missing or corrupted.

**Solution**: Check that `task.orchestration.teamOrchestration.teams` exists.

### Error: "Failed to delete branch X"

**Possible causes**:
1. Branch was already deleted
2. GitHub token doesn't have permissions
3. Branch is protected

**Solution**: Check GitHub repository settings and token permissions.

### Error: "Task is not completed yet"

**Cause**: Cleanup only works on completed tasks.

**Solution**: Wait for orchestration to finish, then run cleanup.

---

## 🎯 Best Practices

1. **Always preview first**: Use `/preview` before running cleanup
2. **Merge PRs first**: Don't cleanup until all PRs are reviewed and merged
3. **Clean up incrementally**: Use `/epic` endpoint to clean one epic at a time
4. **Check results**: Review the cleanup summary to ensure all branches were deleted

---

## 🚀 Future Enhancements

Possible improvements:
1. **Auto-cleanup after PR merge**: GitHub webhook integration
2. **Batch cleanup**: Clean up multiple tasks at once
3. **Scheduled cleanup**: Daily job to clean up old merged branches
4. **Dry-run mode**: Test cleanup without actually deleting

---

## 📝 Summary

The Branch Cleanup System solves the problem of cluttered repositories after orchestration:

- ✅ **Tracks** epic → story relationships automatically
- ✅ **Previews** what will be deleted before action
- ✅ **Cleans up** all branches with one API call
- ✅ **Handles failures** gracefully with detailed reports
- ✅ **Protects** against accidental deletion with safety checks

**Result**: Clean, organized GitHub repositories with only meaningful branches.
