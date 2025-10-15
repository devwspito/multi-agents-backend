# API Documentation for Frontend Developers

## Overview

This document describes the API endpoints available for the multi-agent software development platform. All endpoints require JWT authentication via the `Authorization: Bearer <token>` header.

**Base URL**: `http://localhost:3001/api`

---

## Authentication

### Login
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "user_id",
      "email": "user@example.com",
      "name": "User Name"
    }
  }
}
```

---

## Dashboard Endpoints (New - FASE 6)

### 1. Get Complete Dashboard Data
**Primary endpoint for the frontend dashboard**

```http
GET /api/tasks/:id/dashboard
Authorization: Bearer <token>
```

**Description**: Returns comprehensive dashboard data combining all task information, orchestration progress, activity timeline, anomalies, code changes, and costs.

**Response Example:**
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "task_id",
      "title": "Build user authentication system",
      "description": "Complete authentication with JWT",
      "status": "in_progress",
      "priority": "high",
      "createdAt": "2025-10-11T10:00:00Z",
      "startedAt": "2025-10-11T10:05:00Z"
    },
    "orchestration": {
      "currentPhase": "development",
      "productManager": {
        "status": "completed",
        "complexity": "medium",
        "epicsIdentified": ["Authentication Backend", "User Dashboard UI"],
        "completedAt": "2025-10-11T10:10:00Z"
      },
      "techLead": {
        "status": "completed",
        "epicsCount": 2,
        "storiesCount": 8,
        "developersCount": 2,
        "architectureDesign": "Complete technical architecture...",
        "completedAt": "2025-10-11T10:25:00Z"
      },
      "developers": {
        "totalDevelopers": 2,
        "activeStories": 3,
        "completedStories": 4,
        "failedStories": 1,
        "teamMembers": [
          {
            "instanceId": "dev-1",
            "assignedStories": ["story-1", "story-2", "story-3"],
            "completedStories": ["story-1", "story-2"]
          }
        ]
      },
      "qaEngineer": {
        "status": "pending",
        "prsCreated": 0
      },
      "costs": {
        "totalCostUSD": 2.45,
        "totalTokens": 125000,
        "pmCost": 0.35,
        "tlCost": 0.52,
        "devsCost": 1.48,
        "qaCost": 0.10
      }
    },
    "progress": {
      "currentPhase": "development",
      "overallProgress": 65,
      "phasesCompleted": ["analysis", "planning", "architecture"],
      "phasesRemaining": ["qa", "merge"],
      "storiesCompleted": 4,
      "storiesTotal": 8,
      "blockers": ["Judge scored story-3 at 35/100 (needs fixes)"],
      "warnings": ["dev-1 took 45 minutes on story-2 (expected < 30 min)"]
    },
    "timeline": [
      {
        "timestamp": "2025-10-11T12:30:00Z",
        "type": "judge_evaluation",
        "emoji": "⚖️",
        "title": "Judge Evaluation",
        "description": "Story evaluated: Create login endpoint",
        "severity": "success",
        "agent": "judge",
        "phase": "development"
      }
    ],
    "anomalies": [
      {
        "type": "low_judge_score",
        "severity": "high",
        "title": "Low Judge Score",
        "description": "Judge scored implementation at 35/100 (verdict: NEEDS_FIXES)",
        "timestamp": "2025-10-11T12:30:00Z",
        "affectedStory": "story-3"
      }
    ],
    "code": {
      "snapshotsCount": 6,
      "uniqueFilesChanged": 15,
      "totalLinesAdded": 450,
      "totalLinesDeleted": 80,
      "recentSnapshots": [
        {
          "timestamp": "2025-10-11T12:00:00Z",
          "agentInstanceId": "dev-1",
          "storyTitle": "Create login endpoint",
          "filesChanged": 3,
          "linesAdded": 120,
          "linesDeleted": 15
        }
      ],
      "topFiles": [
        {
          "path": "src/services/AuthService.ts",
          "totalLinesAdded": 200,
          "totalLinesDeleted": 30,
          "modifiedBy": ["dev-1", "dev-2"]
        }
      ]
    },
    "epics": [
      {
        "id": "epic-1",
        "name": "Authentication Backend",
        "description": "Complete backend authentication system",
        "branchName": "epic/authentication-backend",
        "targetRepository": "myrepo/backend",
        "status": "in_progress",
        "stories": [
          {
            "id": "story-1",
            "title": "Create login endpoint",
            "status": "completed",
            "priority": 1,
            "estimatedComplexity": "moderate",
            "assignedTo": "dev-1",
            "dependencies": []
          }
        ]
      }
    ],
    "generatedAt": "2025-10-11T12:35:00Z"
  }
}
```

**Use Case**: Load complete dashboard on initial page load or when user navigates to task detail view.

---

### 2. Get Status Summary (Lightweight - for Polling)
**Optimized for frequent polling**

```http
GET /api/tasks/:id/status-summary
Authorization: Bearer <token>
```

**Description**: Returns lightweight status summary for real-time updates. Designed for polling every 5-10 seconds.

**Response Example:**
```json
{
  "success": true,
  "data": {
    "status": "in_progress",
    "currentPhase": "development",
    "totalCost": 2.45,
    "totalTokens": 125000,
    "recentActivity": [
      {
        "timestamp": "2025-10-11T12:35:00Z",
        "level": "SUCCESS",
        "category": "developer",
        "message": "Story completed: Create login endpoint"
      }
    ],
    "alerts": 2,
    "lastUpdate": "2025-10-11T12:35:30Z"
  }
}
```

**Use Case**: Poll this endpoint every 5-10 seconds to update status badge, recent activity feed, and alert count.

---

### 3. Get Stories Status
**Detailed status of all stories**

```http
GET /api/tasks/:id/stories-status
Authorization: Bearer <token>
```

**Description**: Returns detailed information for all stories including assignments, dependencies, and status.

**Response Example:**
```json
{
  "success": true,
  "data": [
    {
      "id": "story-1",
      "title": "Create login endpoint",
      "description": "**Acceptance Criteria:**\n- Given a user with valid credentials...",
      "status": "completed",
      "epicId": "epic-1",
      "priority": 1,
      "estimatedComplexity": "moderate",
      "assignedTo": "dev-1",
      "dependencies": []
    }
  ],
  "count": 8
}
```

**Use Case**: Display stories table/kanban board with detailed information.

---

## Activity & Monitoring Endpoints (FASE 5)

### 4. Get Activity Timeline

```http
GET /api/tasks/:id/activity
Authorization: Bearer <token>
```

**Description**: Human-readable activity timeline with emojis and severity levels.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2025-10-11T12:30:00Z",
      "type": "agent_completed",
      "emoji": "✅",
      "title": "DEVELOPER Completed",
      "description": "Story completed: Create login endpoint",
      "agent": "developer",
      "phase": "development",
      "severity": "success"
    }
  ]
}
```

---

### 5. Get Anomalies

```http
GET /api/tasks/:id/anomalies
Authorization: Bearer <token>
```

**Description**: Detected anomalies and issues (slow agents, low scores, excessive retries).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "type": "low_judge_score",
      "severity": "high",
      "title": "Low Judge Score",
      "description": "Judge scored implementation at 35/100",
      "timestamp": "2025-10-11T12:30:00Z",
      "affectedAgent": "dev-1",
      "affectedStory": "story-3"
    }
  ],
  "count": 3
}
```

**Anomaly Types:**
- `slow_agent` - Agent taking > 30 minutes
- `low_judge_score` - Score < 50
- `excessive_retries` - > 3 retry attempts
- `verification_failures` - Multiple test failures
- `no_progress` - No activity in last 10 minutes

---

### 6. Get Progress Analysis

```http
GET /api/tasks/:id/progress
Authorization: Bearer <token>
```

**Description**: Progress analysis with phases, stories, blockers, and warnings.

**Response:**
```json
{
  "success": true,
  "data": {
    "taskId": "task_id",
    "currentPhase": "development",
    "overallProgress": 65,
    "phasesCompleted": ["analysis", "planning", "architecture"],
    "phasesRemaining": ["qa", "merge"],
    "storiesCompleted": 4,
    "storiesTotal": 8,
    "blockers": ["Judge rejected story-3 with score 35/100"],
    "warnings": ["dev-1 took 45 minutes on story-2"]
  }
}
```

---

### 7. Get Activity Report

```http
GET /api/tasks/:id/activity-report
Authorization: Bearer <token>
```

**Description**: Comprehensive activity report combining timeline, anomalies, progress, and code activity.

---

## Logging Endpoints (FASE 1)

### 8. Get Task Logs

```http
GET /api/tasks/:id/logs?level=ERROR&category=judge&limit=50
Authorization: Bearer <token>
```

**Query Parameters:**
- `level` - Filter by log level (INFO, SUCCESS, WARN, ERROR, DEBUG)
- `category` - Filter by category (orchestration, agent, developer, story, judge, quality, git, pr)
- `agentType` - Filter by agent (product-manager, tech-lead, developer, qa-engineer)
- `epicId` - Filter by epic ID
- `storyId` - Filter by story ID
- `limit` - Max results (default: 100)
- `startDate` - Filter from date (ISO 8601)
- `endDate` - Filter to date (ISO 8601)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2025-10-11T12:30:00Z",
      "level": "ERROR",
      "category": "judge",
      "message": "Judge rejected story with score 35/100",
      "phase": "development",
      "agentType": "judge",
      "storyId": "story-3",
      "storyTitle": "Create user dashboard",
      "metadata": {
        "score": 35,
        "verdict": "NEEDS_FIXES"
      }
    }
  ],
  "count": 15
}
```

---

## Code Tracking Endpoints (FASE 2)

### 9. Get Code Snapshots

```http
GET /api/tasks/:id/code-snapshots?storyId=story-1&limit=20
Authorization: Bearer <token>
```

**Query Parameters:**
- `agentInstanceId` - Filter by developer instance
- `epicId` - Filter by epic
- `storyId` - Filter by story
- `limit` - Max results (default: 100)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2025-10-11T12:00:00Z",
      "agentInstanceId": "dev-1",
      "storyTitle": "Create login endpoint",
      "repositoryName": "myrepo-backend",
      "branchName": "epic/authentication-backend",
      "fileChanges": [
        {
          "path": "src/services/AuthService.ts",
          "changeType": "created",
          "linesAdded": 120,
          "linesDeleted": 0,
          "diff": "diff --git a/src/services/AuthService.ts..."
        }
      ],
      "totalFilesChanged": 3,
      "totalLinesAdded": 120,
      "totalLinesDeleted": 15
    }
  ],
  "count": 6
}
```

---

### 10. Get Code Summary

```http
GET /api/tasks/:id/code-summary
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "snapshotsCount": 6,
    "uniqueFilesChanged": 15,
    "totalLinesAdded": 450,
    "totalLinesDeleted": 80,
    "snapshots": [...]
  }
}
```

---

### 11. Get File Changes

```http
GET /api/tasks/:id/file-changes
Authorization: Bearer <token>
```

**Description**: File-level changes sorted by impact (most changed files first).

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "path": "src/services/AuthService.ts",
      "changeType": "created",
      "totalLinesAdded": 200,
      "totalLinesDeleted": 30,
      "modifiedBy": ["dev-1", "dev-2"],
      "lastModified": "2025-10-11T12:30:00Z"
    }
  ],
  "count": 15
}
```

---

## Task Management Endpoints

### 12. Get All Tasks

```http
GET /api/tasks?status=in_progress&priority=high
Authorization: Bearer <token>
```

**Query Parameters:**
- `status` - Filter by status (pending, in_progress, completed, failed)
- `priority` - Filter by priority (low, medium, high, critical)
- `projectId` - Filter by project
- `repositoryId` - Filter by repository

---

### 13. Get Task by ID

```http
GET /api/tasks/:id
Authorization: Bearer <token>
```

---

### 14. Create Task

```http
POST /api/tasks
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Build user authentication system",
  "description": "Complete auth with JWT",
  "priority": "high",
  "repositoryIds": ["repo_id_1", "repo_id_2"]
}
```

---

### 15. Start Task Orchestration

```http
POST /api/tasks/:id/start
Authorization: Bearer <token>
Content-Type: application/json

{
  "description": "Build complete authentication system with login, register, password reset",
  "instructions": "Use JWT tokens, bcrypt for passwords, follow security best practices"
}
```

**Description**: Starts automatic orchestration - all 5 agents run sequentially (PM → TL → Devs → QA → Merge).

---

### 16. Get Task Status

```http
GET /api/tasks/:id/status
Authorization: Bearer <token>
```

---

### 17. Get Orchestration Details

```http
GET /api/tasks/:id/orchestration
Authorization: Bearer <token>
```

**Description**: Full orchestration data including all agent outputs, session IDs, todos, and costs.

---

## Recommended Frontend Implementation

### Initial Dashboard Load
1. Call `GET /api/tasks/:id/dashboard` to populate complete dashboard
2. Display task overview, orchestration status, timeline, anomalies, code stats, epics

### Real-time Updates (Polling)
1. Set up interval to call `GET /api/tasks/:id/status-summary` every 5-10 seconds
2. Update status badge, recent activity feed, alert count
3. If significant changes detected, reload full dashboard

### Story Board/Kanban View
1. Call `GET /api/tasks/:id/stories-status` to populate kanban columns
2. Group stories by status: pending, in_progress, completed, failed
3. Display priority, complexity, assigned developer

### Activity Timeline View
1. Call `GET /api/tasks/:id/activity` for full timeline
2. Display with emojis, timestamps, severity colors
3. Filter by agent type, phase, severity

### Alerts/Warnings Panel
1. Call `GET /api/tasks/:id/anomalies` for issues
2. Display critical/high severity anomalies prominently
3. Group by type: slow agents, low scores, retries

### Code Changes View
1. Call `GET /api/tasks/:id/file-changes` for file-level stats
2. Call `GET /api/tasks/:id/code-snapshots` for detailed diffs
3. Display top modified files with line stats

### Logs Viewer (Advanced)
1. Call `GET /api/tasks/:id/logs` with filters
2. Support filtering by level, category, agent, story
3. Display in table with timestamp, level badge, category, message

---

## Error Responses

All endpoints follow consistent error format:

```json
{
  "success": false,
  "message": "Error description"
}
```

**Common HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid token)
- `404` - Not Found (task doesn't exist)
- `500` - Internal Server Error

---

## WebSocket Support (Future)

Currently not implemented. All data is fetched via REST API with polling.

Future enhancement: WebSocket connection for real-time updates without polling.

---

## Rate Limiting

No rate limiting currently implemented for authenticated endpoints.

Recommended polling interval: **5-10 seconds** for status-summary endpoint.

---

## Notes for Frontend Developers

1. **Always use `/dashboard` endpoint for initial load** - it's optimized and returns everything in one request
2. **Use `/status-summary` for polling** - it's lightweight and designed for frequent updates
3. **All timestamps are in ISO 8601 format** - use `new Date(timestamp)` in JavaScript
4. **Anomalies array is pre-sorted by severity** - critical and high severity first
5. **Code snapshots include full diffs** - be careful with large files, diffs are truncated at 10KB
6. **Timeline is limited to last 20 events** in dashboard - use `/activity` endpoint for full timeline
7. **Top files are sorted by total changes** - most impactful files first
8. **Stories in epics maintain Tech Lead's original order** - don't re-sort unless user requests it

---

## Example: Complete Dashboard Component (React)

```javascript
import { useState, useEffect } from 'react';

function TaskDashboard({ taskId }) {
  const [dashboard, setDashboard] = useState(null);
  const [statusSummary, setStatusSummary] = useState(null);

  // Initial load
  useEffect(() => {
    fetch(`/api/tasks/${taskId}/dashboard`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(res => res.json())
      .then(data => setDashboard(data.data));
  }, [taskId]);

  // Polling for updates
  useEffect(() => {
    const interval = setInterval(() => {
      fetch(`/api/tasks/${taskId}/status-summary`, {
        headers: { Authorization: `Bearer ${token}` }
      })
        .then(res => res.json())
        .then(data => setStatusSummary(data.data));
    }, 5000); // Poll every 5 seconds

    return () => clearInterval(interval);
  }, [taskId]);

  return (
    <div>
      <h1>{dashboard?.task.title}</h1>
      <p>Status: {statusSummary?.status || dashboard?.task.status}</p>
      <p>Phase: {statusSummary?.currentPhase}</p>
      <p>Progress: {dashboard?.progress.overallProgress}%</p>
      <p>Alerts: {statusSummary?.alerts}</p>

      {/* Anomalies */}
      {dashboard?.anomalies.map(anomaly => (
        <div key={anomaly.timestamp} className={`alert-${anomaly.severity}`}>
          {anomaly.title}: {anomaly.description}
        </div>
      ))}

      {/* Timeline */}
      {dashboard?.timeline.map(event => (
        <div key={event.timestamp}>
          {event.emoji} {event.title} - {event.description}
        </div>
      ))}
    </div>
  );
}
```

---

**Last Updated**: 2025-10-11
**API Version**: 2.0
**Backend Framework**: Express + TypeScript
**Database**: MongoDB
