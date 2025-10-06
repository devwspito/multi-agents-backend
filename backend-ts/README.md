# Multi-Agent Software Development Platform (TypeScript)

Enterprise-grade autonomous development platform powered by **Claude Agent SDK**.

## 🎯 Overview

This backend uses the **official Claude Agent SDK** to orchestrate 6 specialized AI agents that work together to complete software development tasks:

1. **Product Manager** - Requirements analysis
2. **Project Manager** - Task breakdown and planning
3. **Tech Lead** - Architecture design
4. **Senior Developer** - Complex feature implementation
5. **Junior Developer** - UI and simple features
6. **QA Engineer** - Final quality gate

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- MongoDB (local or Atlas)
- Claude API Key (from console.anthropic.com)
- GitHub OAuth App credentials

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your credentials
nano .env
```

### Development

```bash
# Start development server with hot reload
npm run dev

# Type checking
npm run typecheck

# Build for production
npm run build

# Start production server
npm start
```

## 📚 API Endpoints

### Authentication

```bash
# Initiate GitHub OAuth
GET /api/auth/github

# GitHub OAuth callback (automatic)
GET /api/auth/github/callback

# Get current user
GET /api/auth/me
Authorization: Bearer <token>

# Logout
POST /api/auth/logout
```

### Tasks

```bash
# Get all tasks
GET /api/tasks
Authorization: Bearer <token>

# Get specific task
GET /api/tasks/:id
Authorization: Bearer <token>

# Create task
POST /api/tasks
Authorization: Bearer <token>
Content-Type: application/json
{
  "title": "Build authentication system",
  "description": "Implement JWT-based authentication with GitHub OAuth",
  "priority": "high"
}

# Start agent orchestration
POST /api/tasks/:id/start
Authorization: Bearer <token>

# Get orchestration status
GET /api/tasks/:id/status
Authorization: Bearer <token>

# Get detailed orchestration logs
GET /api/tasks/:id/orchestration
Authorization: Bearer <token>

# Delete task
DELETE /api/tasks/:id
Authorization: Bearer <token>
```

## 🤖 How Claude Agent SDK Works

This platform uses the **official Claude Agent SDK** which follows the agent loop:

### 1. Gather Context
- Agentic search through files and code
- Semantic search when needed
- Subagents for parallel work
- Automatic context compaction

### 2. Take Action
- **Tools**: Read, Write, Edit, Bash, Grep, Glob
- **Code generation**: Python, TypeScript, etc.
- **MCPs**: Integrations with external services
- **Bash scripts**: Real command execution

### 3. Verify Work
- **Rules-based feedback**: Linting, type checking
- **Visual feedback**: Screenshots, renders
- **LLM as judge**: Quality assessment

### 4. Repeat
Agents iterate until the task is complete.

## 🏗️ Architecture

```
backend-ts/
├── src/
│   ├── config/           # Configuration
│   │   ├── env.ts        # Environment variables (Zod validation)
│   │   └── database.ts   # MongoDB connection
│   ├── models/           # MongoDB models
│   │   ├── User.ts
│   │   ├── Task.ts
│   │   └── Project.ts
│   ├── routes/           # Express routes
│   │   ├── auth.ts
│   │   └── tasks.ts
│   ├── services/         # Business logic
│   │   └── AgentService.ts  # Claude Agent SDK orchestration
│   ├── middleware/       # Express middleware
│   │   └── auth.ts       # JWT authentication
│   └── index.ts          # Application entry point
├── package.json
├── tsconfig.json
└── README.md
```

## 🔐 Environment Variables

```bash
# MongoDB
MONGODB_URI=mongodb+srv://...

# Claude API
ANTHROPIC_API_KEY=sk-ant-api03-...

# GitHub OAuth
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# Security
JWT_SECRET=your-super-secret-jwt-key-min-32-chars
SESSION_SECRET=your-session-secret-key-min-32-chars

# Frontend
FRONTEND_URL=https://your-frontend.web.app

# Server
PORT=3001
NODE_ENV=development
```

## 📊 Agent Orchestration Flow

```
User creates task
      ↓
Product Manager analyzes requirements
      ↓
Project Manager breaks down into stories
      ↓
Tech Lead designs architecture
      ↓
Senior Developer implements complex features
      ↓
Junior Developer implements UI
      ↓
QA Engineer validates (FINAL GATE)
      ↓
Task completed ✅
```

## 🚀 Deployment (Vultr)

See `deploy-vultr.sh` for one-command deployment.

```bash
# On Vultr server console:
bash <(curl -s https://raw.githubusercontent.com/YOUR_REPO/main/backend-ts/deploy-vultr.sh)
```

## 📝 TypeScript Features

- ✅ Full type safety with strict mode
- ✅ Zod validation for runtime type checking
- ✅ Mongoose models with TypeScript interfaces
- ✅ Express with typed requests/responses
- ✅ Hot reload with tsx watch
- ✅ Source maps for debugging

## 🔧 Development Tools

```bash
# Type checking
npm run typecheck

# Linting (when configured)
npm run lint

# Testing (when configured)
npm test
```

## 📖 Learn More

- [Claude Agent SDK Documentation](https://docs.anthropic.com/en/api/agent-sdk/overview)
- [Building Agents with Claude](https://www.anthropic.com/engineering/building-agents-with-claude-agent-sdk)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
- [Express.js Guide](https://expressjs.com/en/guide/routing.html)

## 🤝 Contributing

This is a migration to the official Claude Agent SDK. All agents now use real Claude Code capabilities:
- ✅ Real bash execution
- ✅ Real file operations
- ✅ Real code generation
- ✅ Persistent file system
- ✅ Context management
- ✅ Subagent orchestration

## 📄 License

MIT
