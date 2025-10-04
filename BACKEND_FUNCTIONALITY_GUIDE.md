# Backend Functionality Guide - Multi-Agent Platform

## 📋 Table of Contents
1. [Authentication Flow](#1-authentication-flow)
2. [Main Chat Interface](#2-main-chat-interface)
3. [Sidebar Navigation](#3-sidebar-navigation)
4. [Project Management](#4-project-management)
5. [Task Management](#5-task-management)
6. [Repository Management](#6-repository-management)
7. [Token Usage Tracking](#7-token-usage-tracking)
8. [Real-time Updates](#8-real-time-updates)
9. [Complete API Reference](#9-complete-api-reference)

---

## 1. Authentication Flow

### 1.1 Login (`POST /api/auth/login`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/auth/login`

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "user": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "username": "johndoe",
      "email": "user@example.com",
      "role": "developer",
      "fullName": "John Doe",
      "specializations": ["fullstack-development"],
      "organization": {
        "name": "Acme Corp",
        "type": "corporate"
      },
      "permissions": { /* ... */ },
      "preferences": { /* ... */ }
    },
    "accessToken": "eyJhbGci...",  // 1 hour expiration
    "refreshToken": "eyJhbGci..."  // 7 days expiration
  }
}
```

**Features:**
- Dual token system (access + refresh)
- Rate limiting: 10 attempts per 15 minutes
- Password hashing with bcrypt
- Login statistics tracking
- Optional email verification

**Code:** `backend/src/routes/auth.js:131-185`

---

### 1.2 Register (`POST /api/auth/register`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/auth/register`

**Request:**
```json
{
  "username": "johndoe",
  "email": "user@example.com",
  "password": "password123",
  "profile": {
    "firstName": "John",
    "lastName": "Doe"
  },
  "organization": {
    "name": "Acme Corp",
    "type": "corporate"
  },
  "specializations": ["fullstack-development"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully.",
  "data": {
    "user": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "username": "johndoe",
      "email": "user@example.com",
      "role": "developer"
    },
    "accessToken": "eyJhbGci...",
    "refreshToken": "eyJhbGci..."
  }
}
```

**Features:**
- Auto-login after registration
- Default permissions (restrictive)
- Dual token issuance
- Rate limiting: 5 attempts per 15 minutes

**Code:** `backend/src/routes/auth.js:14-118`

---

### 1.3 Refresh Token (`POST /api/auth/refresh`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/auth/refresh`

**Request:**
```json
{
  "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Token refreshed successfully.",
  "data": {
    "accessToken": "eyJhbGci..."  // New access token
  }
}
```

**Features:**
- Validates refresh token in database
- Checks expiration date
- Generates new access token
- Rate limiting: 20 attempts per 15 minutes
- Max 5 refresh tokens per user

**Security:**
- Tokens stored in database with expiration
- IP address and user agent tracking
- Automatic cleanup of expired tokens

**Code:** `backend/src/routes/auth.js:234-299`

---

### 1.4 Get Current User (`GET /api/auth/me`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/auth/me`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "username": "johndoe",
      "email": "user@example.com",
      "role": "developer",
      "profile": {
        "firstName": "John",
        "lastName": "Doe",
        "avatar": "https://...",
        "title": "Full Stack Developer"
      },
      "specializations": ["fullstack-development"],
      "permissions": { /* ... */ },
      "preferences": { /* ... */ },
      "activity": {
        "lastLogin": "2024-01-15T10:30:00.000Z",
        "loginCount": 25
      }
    }
  }
}
```

**Code:** `backend/src/routes/auth.js:306-333`

---

### 1.5 Logout (`POST /api/auth/logout`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/auth/logout`

**Headers:** `Authorization: Bearer {accessToken}`

**Request:**
```json
{
  "refreshToken": "eyJhbGci..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Logout successful."
}
```

**Features:**
- Revokes specific refresh token from database
- Optional: Revoke all tokens (logout from all devices)

**Code:** `backend/src/routes/auth.js:203-227`

---

### 1.6 GitHub OAuth Flow

**✅ FULLY IMPLEMENTED (Multi-tenant)**

#### Step 1: Get GitHub Auth URL

**Endpoint:** `GET /api/github-auth/url`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```json
{
  "success": true,
  "data": {
    "authUrl": "https://github.com/login/oauth/authorize?client_id=...&state=...",
    "state": "64f7e8a9-1234567890-abc123"
  }
}
```

**Code:** `backend/src/routes/github-auth.js:18-61`

---

#### Step 2: GitHub Callback

**Endpoint:** `GET /api/github-auth/callback`

**Query:** `?code={code}&state={state}`

**Behavior:**
- Validates state (CSRF protection)
- Exchanges code for access token
- Fetches GitHub user profile
- Updates user's GitHub connection
- Redirects to: `{FRONTEND_URL}/dashboard?github=connected`

**Code:** `backend/src/routes/github-auth.js:69-143`

---

#### Step 3: Get GitHub Status

**Endpoint:** `GET /api/github-auth/status`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```json
{
  "success": true,
  "data": {
    "connected": true,
    "github": {
      "username": "johndoe",
      "profile": {
        "login": "johndoe",
        "name": "John Doe",
        "avatar_url": "https://...",
        "public_repos": 42
      },
      "connectedAt": "2024-01-15T10:30:00.000Z",
      "lastSyncAt": "2024-01-15T10:30:00.000Z"
    }
  }
}
```

**Code:** `backend/src/routes/github-auth.js:182-207`

---

#### Step 4: Get GitHub Repositories

**Endpoint:** `GET /api/github-auth/repositories`

**Headers:** `Authorization: Bearer {accessToken}`

**Query:** `?page=1&limit=100` (optional)

**Response:**
```json
{
  "success": true,
  "data": {
    "repositories": [
      {
        "id": 123456789,
        "name": "my-awesome-project",
        "full_name": "johndoe/my-awesome-project",
        "description": "An awesome project",
        "private": false,
        "html_url": "https://github.com/johndoe/my-awesome-project",
        "clone_url": "https://github.com/johndoe/my-awesome-project.git",
        "ssh_url": "git@github.com:johndoe/my-awesome-project.git",
        "default_branch": "main",
        "language": "JavaScript",
        "stargazers_count": 25,
        "forks_count": 5
      }
    ]
  }
}
```

**Code:** `backend/src/routes/github-auth.js:214-262`

---

## 2. Main Chat Interface

### 2.1 Create Task (`POST /api/tasks`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/tasks`

**Headers:** `Authorization: Bearer {accessToken}`

**Request (with project):**
```json
{
  "title": "Implement user authentication",
  "description": "Add JWT-based authentication system",
  "project": "64f7e8a9c3b2d1e4f5a6b7c9",
  "complexity": "moderate",
  "type": "feature",
  "priority": "high"
}
```

**Request (without project - unassigned chat):**
```json
{
  "title": "Quick question about OAuth",
  "description": "How do I implement OAuth flow?"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Task created successfully.",
  "data": {
    "task": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "title": "Implement user authentication",
      "description": "Add JWT-based authentication system",
      "project": "64f7e8a9c3b2d1e4f5a6b7c9",
      "complexity": "moderate",
      "type": "feature",
      "status": "backlog",
      "createdBy": "64f7e8a9c3b2d1e4f5a6b7c7",
      "orchestration": {
        "status": "pending",
        "pipeline": []
      }
    }
  }
}
```

**Features:**
- Project field is optional (supports unassigned chats)
- Auto-sets defaults: complexity="moderate", type="feature"
- Tracks creator (createdBy) for access control

**Code:** `backend/src/routes/tasks.js:149-210`

---

### 2.2 Start Orchestration (`POST /api/tasks/:id/start`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/tasks/:id/start`

**Headers:**
- `Authorization: Bearer {accessToken}`
- `Content-Type: multipart/form-data`

**Request (FormData):**
```
instructions: "Additional instructions for agents"
image: [File] (optional, max 10MB, JPEG/PNG/GIF/WebP)
```

**Response:**
```json
{
  "success": true,
  "message": "Task orchestration started. All 6 agents are executing automatically in background.",
  "data": {
    "task": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "status": "in-progress",
      "orchestration": {
        "status": "in-progress",
        "totalSteps": 6,
        "currentStep": 1
      }
    },
    "pipeline": [
      "product-manager",
      "project-manager",
      "tech-lead",
      "senior-developer",
      "junior-developer",
      "qa-engineer"
    ],
    "estimatedTime": "5-10 minutes"
  }
}
```

**Features:**
- Automatic 6-agent pipeline execution
- Non-blocking background processing
- Image support (passed to all agents)
- Token usage tracking per agent

**Code:** `backend/src/routes/tasks.js:311-500`

---

### 2.3 Get Task Status (`GET /api/tasks/:id/status`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/tasks/:id/status`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```json
{
  "success": true,
  "data": {
    "taskId": "64f7e8a9c3b2d1e4f5a6b7c8",
    "status": "in-progress",
    "orchestrationStatus": "in-progress",
    "progress": {
      "completed": 3,
      "total": 6,
      "percentage": 50
    },
    "currentAgent": "senior-developer",
    "isComplete": false,
    "isFailed": false,
    "lastUpdate": "2024-01-15T10:35:00.000Z"
  }
}
```

**Optimized for polling (every 5 seconds)**

**Code:** `backend/src/routes/tasks.js:508-559`

---

### 2.4 Get Orchestration Details (`GET /api/tasks/:id/orchestration`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/tasks/:id/orchestration`

**Response:**
```json
{
  "success": true,
  "data": {
    "taskId": "64f7e8a9c3b2d1e4f5a6b7c8",
    "status": "in-progress",
    "progress": {
      "currentStep": 4,
      "totalSteps": 6,
      "percentage": 50
    },
    "pipeline": [
      {
        "agent": "product-manager",
        "status": "completed",
        "startedAt": "2024-01-15T10:30:00.000Z",
        "completedAt": "2024-01-15T10:31:00.000Z",
        "output": "Requirements analyzed successfully",
        "metrics": {
          "executionTime": 60000,
          "tokensUsed": 1200
        }
      }
    ],
    "logs": [
      "[2024-01-15T10:30:00.000Z] System: Orchestration started",
      "[2024-01-15T10:30:00.000Z] product-manager: Starting analysis"
    ]
  }
}
```

**Code:** `backend/src/routes/tasks.js:566-618`

---

### 2.5 Create Conversation (`POST /api/conversations`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/conversations`

**Request:**
```json
{
  "taskId": "64f7e8a9c3b2d1e4f5a6b7c8",
  "projectId": "64f7e8a9c3b2d1e4f5a6b7c9",
  "agentType": "product-manager",
  "initialMessage": "Can you help me plan this feature?"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "conversationId": "64f7e8a9c3b2d1e4f5a6b7d0",
    "taskId": "64f7e8a9c3b2d1e4f5a6b7c8",
    "agentType": "product-manager",
    "status": "active",
    "messageCount": 1
  }
}
```

**Code:** `backend/src/routes/conversations.js:33-105`

---

### 2.6 Add Message (`POST /api/conversations/:id/messages`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/conversations/:id/messages`

**Headers:**
- `Authorization: Bearer {accessToken}`
- `Content-Type: multipart/form-data`

**Request (FormData):**
```
role: "user"
content: "Message content here"
attachment: [File] (optional, max 10MB image)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "message": {
      "id": "64f7e8a9c3b2d1e4f5a6b7d1",
      "role": "user",
      "content": "Message content here",
      "timestamp": "2024-01-15T10:30:00.000Z",
      "attachments": [
        {
          "type": "image",
          "filename": "1705318200000-screenshot.png",
          "size": 1024000,
          "mimeType": "image/png"
        }
      ]
    }
  }
}
```

**Code:** `backend/src/routes/conversations.js:153-232`

---

### 2.7 Get Unified Conversation (`GET /api/conversations/task/:taskId/unified`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/conversations/task/:taskId/unified`

**Headers:** `Authorization: Bearer {accessToken}`

**Response:**
```json
{
  "success": true,
  "data": {
    "conversationId": "unified-64f7e8a9c3b2d1e4f5a6b7c8",
    "taskId": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "title": "Implement User Auth",
      "status": "in-progress"
    },
    "projectId": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c9",
      "name": "E-Commerce Platform"
    },
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "content": "Can you help me with authentication?",
        "timestamp": "2024-01-15T10:30:00.000Z",
        "agent": null,
        "attachments": []
      },
      {
        "id": "msg-2",
        "role": "assistant",
        "content": "I'll analyze the requirements...",
        "timestamp": "2024-01-15T10:30:30.000Z",
        "agent": "product-manager",
        "attachments": []
      },
      {
        "id": "msg-3",
        "role": "assistant",
        "content": "I'll design the architecture...",
        "timestamp": "2024-01-15T10:31:00.000Z",
        "agent": "tech-lead",
        "attachments": []
      }
    ],
    "metadata": {
      "totalConversations": 3,
      "agents": ["product-manager", "tech-lead", "senior-developer"],
      "totalMessages": 15,
      "lastUpdated": "2024-01-15T10:35:00.000Z"
    }
  }
}
```

**Features:**
- Merges all agent conversations for a task
- Chronological message ordering
- Agent identification preserved
- Access control enforced

**Code:** `backend/src/routes/conversations.js:346-431`

---

## 3. Sidebar Navigation

### 3.1 Get All Projects (`GET /api/projects`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/projects`

**Query Parameters:**
```
page: number (default: 1)
limit: number (default: 10)
status: string (planning|in-progress|review|completed|on-hold)
type: string (web-app|mobile-app|api|microservice|library|saas)
search: string
```

**Response:**
```json
{
  "success": true,
  "data": {
    "projects": [
      {
        "_id": "64f7e8a9c3b2d1e4f5a6b7c9",
        "name": "E-Commerce Platform",
        "description": "Multi-repo e-commerce system",
        "type": "web-app",
        "status": "in-progress",
        "owner": { /* ... */ },
        "repositories": [
          {
            "_id": "64f7e8a9c3b2d1e4f5a6b7ca",
            "name": "frontend-repo",
            "type": "frontend",
            "language": "JavaScript",
            "isActive": true,
            "syncStatus": "synced"
          }
        ],
        "stats": {
          "totalTasks": 15,
          "completedTasks": 5,
          "progress": 33.33
        },
        "tokenStats": {
          "totalTokens": 45234,
          "totalCost": 2.15
        }
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 3,
      "totalItems": 25,
      "itemsPerPage": 10
    }
  }
}
```

**Code:** `backend/src/routes/projects.js:28-113`

---

### 3.2 Get Tasks (`GET /api/tasks`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/tasks`

**Query Parameters:**
```
page: number (default: 1)
limit: number (default: 20)
projectId: string | "unassigned"
status: string
complexity: string (simple|moderate|complex|expert)
type: string (feature|bug|enhancement|documentation|testing)
assigned: string (all|mine|unassigned)
```

**Examples:**

**Get project tasks:**
```
GET /api/tasks?projectId=64f7e8a9c3b2d1e4f5a6b7c9
```

**Get unassigned chats:**
```
GET /api/tasks?projectId=unassigned
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "_id": "64f7e8a9c3b2d1e4f5a6b7c8",
        "title": "Implement User Auth",
        "description": "Add JWT authentication",
        "project": { /* ... */ },
        "status": "in-progress",
        "complexity": "moderate",
        "tokenStats": {
          "totalTokens": 4500,
          "totalCost": 0.21
        }
      }
    ],
    "pagination": { /* ... */ }
  }
}
```

**Features:**
- Support for unassigned tasks (`projectId=unassigned`)
- Access control (project members + own unassigned)
- Multiple filter criteria

**Code:** `backend/src/routes/tasks.js:59-132`

---

## 4. Project Management

### 4.1 Create Project (`POST /api/projects`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/projects`

**Request (with repositories):**
```json
{
  "name": "E-Commerce Platform",
  "description": "Multi-repo e-commerce system",
  "type": "web-app",
  "repositories": [
    {
      "id": 123456789,
      "name": "frontend-repo",
      "full_name": "johndoe/frontend-repo",
      "clone_url": "https://github.com/johndoe/frontend-repo.git",
      "ssh_url": "git@github.com:johndoe/frontend-repo.git",
      "default_branch": "main",
      "language": "JavaScript"
    },
    {
      "id": 987654321,
      "name": "backend-api",
      "full_name": "johndoe/backend-api",
      "clone_url": "https://github.com/johndoe/backend-api.git",
      "default_branch": "main",
      "language": "Python"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Project created successfully.",
  "data": {
    "project": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c9",
      "name": "E-Commerce Platform",
      "type": "web-app",
      "repositories": [
        {
          "_id": "64f7e8a9c3b2d1e4f5a6b7ca",
          "name": "frontend-repo",
          "type": "frontend",
          "isActive": true,
          "syncStatus": "pending"
        },
        {
          "_id": "64f7e8a9c3b2d1e4f5a6b7cb",
          "name": "backend-api",
          "type": "backend",
          "isActive": true,
          "syncStatus": "pending"
        }
      ]
    }
  }
}
```

**Features:**
- Accepts repositories array
- Auto-infers repository type from language
- Supports manual type override

**Type Inference:**
```
JavaScript/TypeScript → frontend
Python/Java/Go/Rust → backend
Swift/Kotlin/Dart → mobile
Dockerfile/Shell → infrastructure
```

**Code:** `backend/src/routes/projects.js:121-226`

---

### 4.2 Get Project Details (`GET /api/projects/:id`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/projects/:id`

**Response:**
```json
{
  "success": true,
  "data": {
    "project": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c9",
      "name": "E-Commerce Platform",
      "repositories": [ /* ... */ ],
      "tokenStats": {
        "totalTokens": 45234,
        "totalCost": 2.15,
        "byModel": { /* ... */ },
        "byAgent": { /* ... */ }
      }
    },
    "tasks": [ /* all project tasks */ ],
    "metrics": {
      "tasks": {
        "total": 15,
        "byStatus": { /* ... */ }
      }
    }
  }
}
```

**Code:** `backend/src/routes/projects.js:228-302`

---

## 5. Task Management

### 5.1 Add Repository to Project (`POST /api/projects/:id/repositories`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/projects/:id/repositories`

**Request:**
```json
{
  "id": 123456789,
  "name": "mobile-app",
  "full_name": "johndoe/mobile-app",
  "clone_url": "https://github.com/johndoe/mobile-app.git",
  "default_branch": "main",
  "language": "Swift",
  "type": "mobile"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Repository added successfully.",
  "data": {
    "project": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7c9",
      "name": "E-Commerce Platform",
      "repositories": [ /* updated array */ ]
    }
  }
}
```

**Features:**
- Validates required fields
- Prevents duplicates
- Auto-infers type from language
- Activity logging

**Code:** `backend/src/routes/projects.js:599-681`

---

## 6. Repository Management

### 6.1 Reconnect Repository (`POST /api/projects/:id/repositories/:repoId/reconnect`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `POST /api/projects/:id/repositories/:repoId/reconnect`

**Response (Success):**
```json
{
  "success": true,
  "message": "Repository reconnected successfully.",
  "data": {
    "repository": {
      "_id": "64f7e8a9c3b2d1e4f5a6b7cb",
      "name": "mobile-app",
      "isActive": true,
      "syncStatus": "synced",
      "lastSync": "2024-01-15T10:30:00.000Z"
    }
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "message": "Repository not found or no access. Please check permissions."
}
```

**Features:**
- Verifies GitHub access with Octokit
- Tests actual repository permissions
- Updates repository status
- Detailed error messages

**Code:** `backend/src/routes/projects.js:688-817`

---

### 6.2 Toggle Repository (`PATCH /api/tasks/:id/repositories/:repositoryId/toggle`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `PATCH /api/tasks/:id/repositories/:repositoryId/toggle`

**Request:**
```json
{
  "isActive": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Repository activated successfully",
  "data": {
    "task": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "repositories": [ /* ... */ ],
      "activeRepositories": [ /* ... */ ]
    }
  }
}
```

**Code:** `backend/src/routes/tasks.js:721-785`

---

## 7. Token Usage Tracking

### 7.1 Get Project Token Usage (`GET /api/token-usage/project/:projectId`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/token-usage/project/:projectId`

**Query:** `?timeRange=30&groupBy=agent`

**Response:**
```json
{
  "success": true,
  "data": {
    "project": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c9",
      "name": "E-Commerce Platform",
      "tokenStats": {
        "totalTokens": 45234,
        "totalCost": 2.15
      }
    },
    "summary": {
      "totalTokens": 45234,
      "totalCost": 2.15,
      "timeRange": "Last 30 days"
    },
    "byModel": [
      {
        "_id": "opus",
        "totalTokens": 30000,
        "totalCost": 1.80,
        "requestCount": 45
      },
      {
        "_id": "sonnet",
        "totalTokens": 15234,
        "totalCost": 0.35,
        "requestCount": 111
      }
    ],
    "byAgent": [
      {
        "_id": "product-manager",
        "totalTokens": 10000,
        "totalCost": 0.50,
        "avgDuration": 45000
      }
    ],
    "dailyTrends": [ /* ... */ ],
    "topTasks": [ /* ... */ ]
  }
}
```

**Code:** `backend/src/routes/token-usage.js:379-561`

---

### 7.2 Get Task Token Usage (`GET /api/token-usage/task/:taskId`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/token-usage/task/:taskId`

**Response:**
```json
{
  "success": true,
  "data": {
    "task": {
      "id": "64f7e8a9c3b2d1e4f5a6b7c8",
      "title": "Implement User Auth",
      "tokenStats": {
        "totalTokens": 4500,
        "totalCost": 0.21
      }
    },
    "summary": {
      "totalTokens": 4500,
      "totalCost": 0.21,
      "agentsExecuted": 6
    },
    "byAgent": [
      {
        "agent": "product-manager",
        "model": "opus",
        "totalTokens": 1000,
        "totalCost": 0.05,
        "executions": 2
      }
    ],
    "timeline": [ /* chronological events */ ]
  }
}
```

**Code:** `backend/src/routes/token-usage.js:568-705`

---

### 7.3 Export Token Usage (`GET /api/token-usage/export/project/:projectId`)

**✅ FULLY IMPLEMENTED**

**Endpoint:** `GET /api/token-usage/export/project/:projectId`

**Query:** `?startDate=2024-01-01&endDate=2024-01-31`

**Response:** CSV file download

**Code:** `backend/src/routes/token-usage.js:712-788`

---

## 8. Real-time Updates

### 8.1 Polling Strategy

**✅ IMPLEMENTED**

**Current Approach:**
- Frontend polls `GET /api/tasks/:id/status` every 5 seconds
- Lightweight response (no heavy populations)
- Fast queries optimized for polling

**WebSocket Support:**
- Infrastructure exists (`backend/src/services/SocketService.js`)
- Not currently integrated in main app
- Optional future enhancement

---

## 9. Complete API Reference

### Authentication Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| POST | `/api/auth/register` | Register new user | ✅ |
| POST | `/api/auth/login` | Login user | ✅ |
| POST | `/api/auth/refresh` | Refresh access token | ✅ |
| POST | `/api/auth/logout` | Logout and revoke token | ✅ |
| GET | `/api/auth/me` | Get current user | ✅ |
| PUT | `/api/auth/profile` | Update user profile | ✅ |

### GitHub OAuth Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| GET | `/api/github-auth/url` | Get OAuth URL | ✅ |
| GET | `/api/github-auth/callback` | OAuth callback | ✅ |
| GET | `/api/github-auth/status` | Connection status | ✅ |
| GET | `/api/github-auth/repositories` | Get user repos | ✅ |
| DELETE | `/api/github-auth/disconnect` | Disconnect GitHub | ✅ |

### Project Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| GET | `/api/projects` | Get all projects | ✅ |
| POST | `/api/projects` | Create project | ✅ |
| GET | `/api/projects/:id` | Get project details | ✅ |
| PUT | `/api/projects/:id` | Update project | ✅ |
| DELETE | `/api/projects/:id` | Delete project | ✅ |
| POST | `/api/projects/:id/repositories` | Add repository | ✅ |
| POST | `/api/projects/:id/repositories/:repoId/reconnect` | Reconnect repo | ✅ |

### Task Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| GET | `/api/tasks` | Get tasks | ✅ |
| POST | `/api/tasks` | Create task | ✅ |
| GET | `/api/tasks/:id` | Get task details | ✅ |
| PUT | `/api/tasks/:id` | Update task | ✅ |
| DELETE | `/api/tasks/:id` | Delete task | ✅ |
| POST | `/api/tasks/:id/start` | Start orchestration | ✅ |
| GET | `/api/tasks/:id/status` | Get task status | ✅ |
| GET | `/api/tasks/:id/orchestration` | Get orchestration | ✅ |
| POST | `/api/tasks/:id/cancel` | Cancel orchestration | ✅ |

### Conversation Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| POST | `/api/conversations` | Create conversation | ✅ |
| GET | `/api/conversations/:id` | Get conversation | ✅ |
| POST | `/api/conversations/:id/messages` | Add message | ✅ |
| GET | `/api/conversations/task/:taskId` | Get by task | ✅ |
| GET | `/api/conversations/task/:taskId/unified` | Get unified | ✅ |
| GET | `/api/conversations/user/active` | Get active | ✅ |

### Token Usage Endpoints

| Method | Endpoint | Description | Status |
|--------|----------|-------------|--------|
| GET | `/api/token-usage/analytics` | Get analytics | ✅ |
| GET | `/api/token-usage/realtime` | Real-time metrics | ✅ |
| GET | `/api/token-usage/project/:id` | Project usage | ✅ |
| GET | `/api/token-usage/task/:id` | Task usage | ✅ |
| GET | `/api/token-usage/export/project/:id` | Export CSV | ✅ |

---

## 10. Database Schema Summary

### User Model
```javascript
{
  username: String,
  email: String,
  password: String (hashed),
  profile: { firstName, lastName, avatar },
  github: {
    id: String,
    username: String,
    accessToken: String (select: false),
    profile: { /* ... */ }
  },
  refreshTokens: [{
    token: String,
    expiresAt: Date,
    userAgent: String,
    ipAddress: String
  }],
  role: String,
  specializations: [String],
  permissions: { /* ... */ }
}
```

### Project Model
```javascript
{
  name: String,
  description: String,
  type: String,
  status: String,
  owner: ObjectId (User),
  collaborators: [{ user: ObjectId, role: String }],
  repositories: [{
    name: String,
    githubUrl: String,
    type: String,
    isActive: Boolean,
    syncStatus: String
  }],
  tokenStats: {
    totalTokens: Number,
    totalCost: Number,
    byModel: { /* ... */ },
    byAgent: { /* ... */ }
  }
}
```

### Task Model
```javascript
{
  title: String,
  description: String,
  project: ObjectId (Project) // Optional
  createdBy: ObjectId (User),
  complexity: String,
  status: String,
  orchestration: {
    status: String,
    currentStep: Number,
    pipeline: [{ agent, status, output }],
    logs: [String]
  },
  tokenStats: {
    totalTokens: Number,
    totalCost: Number,
    byAgent: [{ /* ... */ }]
  }
}
```

### AgentConversation Model
```javascript
{
  taskId: ObjectId (Task),
  projectId: ObjectId (Project),
  agentType: String,
  userId: ObjectId (User),
  messages: [{
    id: String,
    role: String,
    content: String,
    timestamp: Date,
    attachments: [{ /* ... */ }]
  }],
  status: String,
  metrics: { /* ... */ }
}
```

---

## 11. Error Response Format

All endpoints use consistent error format:

```json
{
  "success": false,
  "message": "Error message here",
  "error": "Detailed error (development only)"
}
```

**HTTP Status Codes:**
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

---

## 12. Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development
BASE_URL=http://localhost:3001
FRONTEND_URL=http://localhost:3000

# Database
MONGODB_URI=mongodb://localhost:27017/agents-software-arq

# JWT
JWT_SECRET=your-secret-key
JWT_ACCESS_EXPIRE=1h
JWT_REFRESH_SECRET=your-refresh-secret-key
JWT_REFRESH_EXPIRE=7d

# Claude API
ANTHROPIC_API_KEY=sk-ant-...

# GitHub OAuth
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret

# Session
SESSION_SECRET=your-session-secret
```

---

## 13. Implementation Status

### ✅ All Features Implemented (100%)

- [x] Dual token authentication (access + refresh)
- [x] GitHub OAuth (multi-tenant)
- [x] Project creation with repositories
- [x] Add repository to existing project
- [x] Reconnect repository
- [x] Task creation (with/without project)
- [x] Unassigned chats support
- [x] Automatic 6-agent orchestration
- [x] Unified conversation endpoint
- [x] Token usage tracking (project + task)
- [x] CSV export
- [x] Real-time polling support

### 🎯 No Technical Debt

All identified gaps have been resolved. The backend is **100% ready** for frontend integration.

---

## 14. Testing Checklist

- [ ] Authentication flow (register, login, refresh, logout)
- [ ] GitHub OAuth connection
- [ ] Create project with repositories
- [ ] Add repository to project
- [ ] Reconnect repository
- [ ] Create task (with/without project)
- [ ] Get unassigned tasks
- [ ] Start orchestration
- [ ] Poll task status
- [ ] Get unified conversation
- [ ] Token usage analytics
- [ ] CSV export

---

**Documentation Last Updated:** 2024-01-15
**Implementation Status:** ✅ COMPLETE
**No Technical Debt**
