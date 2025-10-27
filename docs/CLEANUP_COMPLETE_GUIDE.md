# 🧹 Complete Branch Cleanup System - Full Guide

## 📖 Table of Contents

1. [Overview](#overview)
2. [Problem Statement](#problem-statement)
3. [Features](#features)
4. [Setup](#setup)
5. [Usage](#usage)
6. [API Reference](#api-reference)
7. [GitHub Webhook Setup](#github-webhook-setup)
8. [Scheduled Cleanup](#scheduled-cleanup)
9. [Troubleshooting](#troubleshooting)

---

## Overview

Complete automated branch cleanup system with **3 cleanup modes**:

1. **🔧 Manual Cleanup** - On-demand via API
2. **🤖 Automatic Cleanup** - GitHub webhook triggers on PR merge
3. **⏰ Scheduled Cleanup** - Daily job cleans old branches

---

## Problem Statement

### Before Cleanup System

```
GitHub Branches (Total: 47 branches)
├── main
├── epic/c0d33d27-epic-webhook-objectid-fix-1761242026720-9nmggb
├── story/c0d33d27-epic-webhook-objectid-fix-story-2-1761242265667-15adh4
├── epic/c0d33d27-epic-webhook-observability-1761242162424-b10ow8
├── story/c0d33d27-epic-webhook-observability-story-4-1761243483385-lw8x79
├── epic/c0d33d27-epic-webhook-event-expansion-1761242162424-co5ntl
├── story/c0d33d27-epic-webhook-event-expansion-story-5-1761243694268-67o1h8
├── story/c0d33d27-epic-webhook-event-expansion-story-3-1761243311262-a5cd6o
... 40+ more branches
```

**Problems:**
- ❌ Can't tell which story belongs to which epic
- ❌ No idea which branches are safe to delete
- ❌ Manual cleanup takes hours
- ❌ Fear of deleting wrong branch

### After Cleanup System

```
GitHub Branches (Total: 1 branch)
└── main
```

**Result:**
- ✅ Automatic tracking of epic → story relationships
- ✅ One-click cleanup after PR merge
- ✅ Automatic cleanup via webhook
- ✅ Scheduled daily cleanup
- ✅ Clean, organized repository

---

## Features

### ✨ Feature 1: Manual Cleanup (API)

**What:** Call API endpoint to clean up branches on demand

**When to use:** After manually merging PRs in GitHub

**Endpoints:**
- `GET /api/cleanup/preview/:taskId` - Preview before deletion
- `POST /api/cleanup/task/:taskId` - Clean all branches
- `POST /api/cleanup/epic/:taskId/:epicId` - Clean single epic

**Example:**
```bash
# Preview
curl http://localhost:5001/api/cleanup/preview/67890abc \
  -H "Authorization: Bearer TOKEN"

# Clean up
curl -X POST http://localhost:5001/api/cleanup/task/67890abc \
  -H "Authorization: Bearer TOKEN"
```

---

### ✨ Feature 2: Automatic Cleanup (GitHub Webhook)

**What:** Automatically clean up branches when epic PR is merged

**When triggered:** GitHub sends webhook when PR merged

**Flow:**
1. You merge epic PR in GitHub UI
2. GitHub sends webhook to `/api/webhooks/github`
3. System detects epic branch merged
4. Finds all story branches for that epic
5. Deletes story branches + epic branch automatically

**Setup required:** Configure GitHub webhook (see below)

**Example webhook payload:**
```json
{
  "action": "closed",
  "pull_request": {
    "number": 42,
    "title": "Epic: Webhook Improvements",
    "head": { "ref": "epic/webhook-improvements" },
    "merged": true
  }
}
```

**Response:**
```json
{
  "message": "Cleanup triggered successfully",
  "taskId": "67890abc",
  "epicId": "epic-1",
  "branchName": "epic/webhook-improvements",
  "storyBranchesCount": 4
}
```

---

### ✨ Feature 3: Scheduled Cleanup (Cron)

**What:** Daily job cleans up old merged branches

**When:** Runs automatically at 2:00 AM every day

**What it cleans:**
- Completed tasks from last 30 days
- All epic and story branches for those tasks

**Control:**
```bash
# Check status
GET /api/cleanup/scheduled/status

# Run manually (for testing)
POST /api/cleanup/scheduled/run

# Response
{
  "isRunning": false,
  "schedulerActive": true,
  "nextRun": "Daily at 2:00 AM",
  "info": "Scheduled cleanup runs daily at 2:00 AM to clean up old branches"
}
```

**Logs:**
```
🧹 SCHEDULED CLEANUP STARTED
Time: 2025-01-24T02:00:00.000Z
═══════════════════════════════════════════

🔍 Finding completed tasks with mergeable branches...
📋 Found 15 completed task(s) to check

🧹 Processing task: 67890abc
   Title: Implement webhook system
   Completed: 2025-01-23T18:30:00.000Z
   📊 Found 3 epic(s) with branches
   🗑️  Cleaning epic: epic/webhook-improvements
   ✅ Deleted 4 branch(es)

✅ SCHEDULED CLEANUP COMPLETE
   Tasks processed: 15
   Branches deleted: 47
   Errors: 0
```

---

## Setup

### 1. Environment Variables

Add to `.env`:

```bash
# GitHub Webhook Secret (for auto-cleanup on PR merge)
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here

# Agent Workspace (where repos are cloned)
AGENT_WORKSPACE_DIR=/tmp/agent-workspace
```

### 2. Install Dependencies

```bash
npm install node-cron
```

### 3. Server Startup

The system starts automatically when server launches:

```
🚀 Multi-Agent Platform Started
═══════════════════════════════════════════
📍 Port: 5001
🌍 Environment: development
🤖 Claude Agent SDK: Ready
💾 MongoDB: Connected
🧹 Scheduled branch cleanup: Enabled (runs daily at 2:00 AM)
═══════════════════════════════════════════
```

---

## Usage

### Scenario 1: Manual Cleanup After PR Merge

**Step 1:** Complete orchestration
```bash
POST /api/tasks/67890abc/start
```

**Step 2:** QA creates epic PRs in GitHub

**Step 3:** Review and merge PRs manually in GitHub UI

**Step 4:** Preview cleanup
```bash
GET /api/cleanup/preview/67890abc
```

**Response:**
```json
{
  "message": "Preview: 12 branches would be deleted across 3 epic(s)",
  "epics": [
    {
      "epicBranch": "epic/webhook-improvements",
      "branchesToDelete": [
        "epic/webhook-improvements",
        "story/webhook-story-1",
        "story/webhook-story-2",
        "story/webhook-story-3"
      ],
      "totalBranchCount": 4
    }
  ],
  "totalBranches": 12
}
```

**Step 5:** Clean up
```bash
POST /api/cleanup/task/67890abc
```

**Result:** 12 branches deleted ✅

---

### Scenario 2: Automatic Cleanup via Webhook

**Step 1:** Configure GitHub webhook (one-time setup)

Go to: `https://github.com/your-org/your-repo/settings/hooks`

Add webhook:
- URL: `https://your-domain.com/api/webhooks/github`
- Content type: `application/json`
- Secret: Same as `GITHUB_WEBHOOK_SECRET` in `.env`
- Events: `Pull requests`

**Step 2:** Merge epic PR in GitHub UI

Click "Merge pull request" button

**Step 3:** Webhook triggers automatically

```
🎯 GitHub Webhook: PR Merged
Repository: your-org/your-repo
PR #42: Epic: Webhook Improvements
Branch: epic/webhook-improvements

✅ Found task: 67890abc
   Task title: Implement webhook system
   Task status: completed

🧹 Auto-cleanup triggered for epic: epic/webhook-improvements
   Story branches to delete: 3

✅ Auto-cleanup complete: 4 branches deleted
```

**Result:** Branches deleted automatically, no manual action needed! 🎉

---

### Scenario 3: Scheduled Cleanup

**No action required!** The system automatically:

1. Runs daily at 2:00 AM
2. Finds completed tasks from last 30 days
3. Cleans up all branches for those tasks
4. Logs results

**Check status:**
```bash
GET /api/cleanup/scheduled/status

{
  "isRunning": false,
  "schedulerActive": true,
  "nextRun": "Daily at 2:00 AM"
}
```

**Manual trigger (for testing):**
```bash
POST /api/cleanup/scheduled/run

{
  "message": "Scheduled cleanup started in background",
  "info": "Check server logs for progress"
}
```

---

## API Reference

### GET /api/cleanup/preview/:taskId

**Description:** Preview which branches would be deleted

**Auth:** Bearer token required

**Response:**
```json
{
  "message": "Preview: 15 branches would be deleted across 3 epic(s)",
  "taskId": "67890abc",
  "taskStatus": "completed",
  "epics": [
    {
      "epicId": "epic-1",
      "epicBranch": "epic/webhook-improvements",
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
        "epic/webhook-improvements",
        "story/webhook-story-1"
      ],
      "totalBranchCount": 2
    }
  ],
  "totalBranches": 15
}
```

---

### POST /api/cleanup/task/:taskId

**Description:** Delete all branches for a task

**Auth:** Bearer token required

**Requirements:**
- Task must be completed
- User must own the task

**Response:**
```json
{
  "success": true,
  "message": "Cleanup complete: 15 branches deleted",
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
    "totalBranchesDeleted": 15
  }
}
```

---

### POST /api/cleanup/epic/:taskId/:epicId

**Description:** Delete branches for a specific epic only

**Auth:** Bearer token required

**Use case:** Incremental cleanup when only some PRs are merged

**Response:**
```json
{
  "success": true,
  "message": "Cleanup complete: 4 branches deleted",
  "epicId": "epic-1",
  "epicBranch": "epic/webhook-improvements",
  "storyBranchesDeleted": 3,
  "totalBranchesDeleted": 4
}
```

---

### POST /api/webhooks/github

**Description:** GitHub webhook endpoint for automatic cleanup

**Auth:** GitHub signature verification

**Headers:**
```
X-GitHub-Event: pull_request
X-Hub-Signature-256: sha256=...
```

**Payload:**
```json
{
  "action": "closed",
  "pull_request": {
    "number": 42,
    "title": "Epic: Webhook Improvements",
    "head": { "ref": "epic/webhook-improvements" },
    "merged": true
  },
  "repository": {
    "full_name": "your-org/your-repo"
  }
}
```

**Response:**
```json
{
  "message": "Cleanup triggered successfully",
  "taskId": "67890abc",
  "epicId": "epic-1",
  "branchName": "epic/webhook-improvements",
  "storyBranchesCount": 3
}
```

---

### GET /api/webhooks/github/test

**Description:** Test if webhook endpoint is reachable

**Response:**
```json
{
  "message": "GitHub webhook endpoint is ready",
  "timestamp": "2025-01-24T10:30:00.000Z",
  "webhookSecretConfigured": true
}
```

---

### POST /api/cleanup/scheduled/run

**Description:** Manually trigger scheduled cleanup

**Auth:** Bearer token required

**Response:**
```json
{
  "message": "Scheduled cleanup started in background",
  "info": "Check server logs for progress"
}
```

---

### GET /api/cleanup/scheduled/status

**Description:** Get status of scheduled cleanup

**Auth:** Bearer token required

**Response:**
```json
{
  "isRunning": false,
  "schedulerActive": true,
  "nextRun": "Daily at 2:00 AM",
  "info": "Scheduled cleanup runs daily at 2:00 AM to clean up old branches"
}
```

---

## GitHub Webhook Setup

### Step 1: Get Your Server URL

Your webhook URL:
```
https://your-domain.com/api/webhooks/github
```

For development (using ngrok):
```bash
ngrok http 5001

# Copy the HTTPS URL (e.g., https://abc123.ngrok.io)
# Webhook URL: https://abc123.ngrok.io/api/webhooks/github
```

### Step 2: Create Webhook Secret

Generate a random secret:
```bash
openssl rand -hex 32

# Example output: ***REMOVED***
```

Add to `.env`:
```bash
GITHUB_WEBHOOK_SECRET=***REMOVED***
```

### Step 3: Configure in GitHub

1. Go to your repository
2. Click **Settings** → **Webhooks** → **Add webhook**
3. Fill in:
   - **Payload URL**: `https://your-domain.com/api/webhooks/github`
   - **Content type**: `application/json`
   - **Secret**: Paste the secret from Step 2
   - **Events**: Select "Let me select individual events" → Check **Pull requests**
   - **Active**: ✅ Checked
4. Click **Add webhook**

### Step 4: Test Webhook

Merge a test PR and check server logs:

```
🎯 GitHub Webhook: PR Merged
Repository: your-org/your-repo
PR #42: Test PR
Branch: epic/test-branch

✅ Found task: 67890abc
🧹 Auto-cleanup triggered
✅ Auto-cleanup complete: 4 branches deleted
```

If you see this, webhook is working! 🎉

---

## Scheduled Cleanup

### How It Works

**Cron Schedule:** `0 2 * * *` (Every day at 2:00 AM)

**Process:**
1. Finds completed tasks from last 30 days
2. Builds branch mappings for each task
3. Deletes epic + story branches
4. Logs results

**Example Log:**
```
🧹 SCHEDULED CLEANUP STARTED
Time: 2025-01-24T02:00:00.000Z

🔍 Finding completed tasks...
📋 Found 15 completed task(s) to check

🧹 Processing task: 67890abc
   ✅ Deleted 4 branch(es)

🧹 Processing task: 67890def
   ✅ Deleted 6 branch(es)

✅ SCHEDULED CLEANUP COMPLETE
   Tasks processed: 15
   Branches deleted: 47
   Errors: 0
```

### Manual Trigger

For testing or emergency cleanup:

```bash
POST /api/cleanup/scheduled/run

# Server logs will show:
🧹 Manual cleanup triggered
🔍 Finding completed tasks...
✅ Manual cleanup complete: 47 branches deleted
```

### Check Status

```bash
GET /api/cleanup/scheduled/status

{
  "isRunning": false,
  "schedulerActive": true,
  "nextRun": "Daily at 2:00 AM"
}
```

---

## Troubleshooting

### Error: "No branch mappings found"

**Cause:** Task orchestration data is missing

**Fix:**
```bash
# Check task data
GET /api/tasks/:taskId

# Verify teamOrchestration exists
task.orchestration.teamOrchestration.teams[]
```

---

### Error: "Failed to delete branch X"

**Possible causes:**
1. Branch already deleted
2. GitHub token lacks permissions
3. Branch is protected

**Fix:**
```bash
# Check GitHub permissions
# Ensure user has "delete_ref" permission

# Check if branch exists
curl -H "Authorization: Bearer TOKEN" \
  https://api.github.com/repos/owner/repo/branches/branch-name
```

---

### Error: "Invalid GitHub webhook signature"

**Cause:** Webhook secret mismatch

**Fix:**
1. Check `.env` file has correct secret
2. Verify GitHub webhook settings
3. Restart server after changing `.env`

---

### Webhook Not Triggering

**Debug steps:**

1. **Check GitHub webhook deliveries:**
   - Go to GitHub → Settings → Webhooks
   - Click on your webhook
   - Check "Recent Deliveries"
   - Look for green ✅ (success) or red ❌ (failure)

2. **Check server logs:**
   ```bash
   # Should see:
   🎯 GitHub Webhook: PR Merged
   ```

3. **Test webhook endpoint:**
   ```bash
   GET /api/webhooks/github/test

   {
     "message": "GitHub webhook endpoint is ready",
     "webhookSecretConfigured": true
   }
   ```

---

### Scheduled Cleanup Not Running

**Debug:**

```bash
# Check status
GET /api/cleanup/scheduled/status

# Response should show:
{
  "schedulerActive": true,  # ✅ Should be true
  "nextRun": "Daily at 2:00 AM"
}

# If false, check server logs for startup errors
```

---

## Summary

### ✅ What You Get

1. **Manual Cleanup** - Full control via API
2. **Automatic Cleanup** - Webhook triggers on PR merge
3. **Scheduled Cleanup** - Daily job cleans old branches
4. **Safety Features** - Preview, auth, error handling
5. **Complete Logs** - Track all cleanup operations

### 🎯 Best Practices

1. **Always preview first** - Use `/preview` before cleanup
2. **Set up webhook** - Automate cleanup on PR merge
3. **Let scheduler run** - Daily cleanup keeps repo clean
4. **Check logs** - Monitor cleanup operations
5. **Test in dev first** - Verify webhook works before production

### 🚀 Next Steps

1. Configure `.env` with `GITHUB_WEBHOOK_SECRET`
2. Set up GitHub webhook
3. Test with a sample PR
4. Let scheduled cleanup run overnight
5. Enjoy clean repositories! 🎉

---

**Documentation Version:** 1.0.0
**Last Updated:** January 24, 2025
**Author:** Multi-Agent Platform Team
