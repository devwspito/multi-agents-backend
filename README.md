# Multi-Agent Software Development Platform

Enterprise-grade autonomous development platform powered by **Claude Agent SDK**.

## 🎯 Overview

This platform orchestrates specialized AI agents to complete complex software development tasks autonomously using the **official Claude Agent SDK from Anthropic**.

The platform supports:
- **Dynamic Team Building** - Teams scale based on task complexity
- **Multi-Repository Projects** - Projects can have multiple repositories
- **Parallel Development** - Multiple developers working simultaneously
- **Automatic Conflict Resolution** - Merge Coordinator monitors all active tasks
- **Code Review Automation** - Seniors automatically review junior code

## 🤖 The Specialized Agents

Each agent uses the official Claude Agent SDK:

1. **Product Manager** - Requirements analysis & specifications
2. **Project Manager** - Epic breakdown into implementable stories
3. **Tech Lead** - Architecture design & team composition decisions
4. **Senior Developer** - Complex features & code review (multiple instances)
5. **Junior Developer** - UI components & simple features (multiple instances)
6. **QA Engineer** - Integration testing across all PRs
7. **Merge Coordinator** - Global conflict detection & resolution

## 🏗️ Architecture

```
agents-software-arq/
├── src/
│   ├── config/                      # Environment & database config
│   │   ├── database.ts
│   │   └── env.ts
│   ├── models/                      # MongoDB models
│   │   ├── User.ts
│   │   ├── Task.ts                  # Orchestration state
│   │   ├── Project.ts               # Logical project container
│   │   └── Repository.ts
│   ├── routes/                      # Express API routes
│   │   ├── auth.ts
│   │   ├── tasks.ts
│   │   ├── projects.ts
│   │   └── repositories.ts
│   ├── services/                    # Business logic
│   │   ├── TeamOrchestrator.ts      # Main orchestration
│   │   ├── MergeCoordinatorService.ts    # Global conflict observer
│   │   ├── MergeCoordinatorScheduler.ts  # Background monitoring
│   │   ├── GitHubService.ts              # Git operations
│   │   └── WorkspaceCleanupScheduler.ts
│   ├── middleware/                  # Authentication & security
│   │   └── auth.ts
│   └── index.ts                     # Application entry point
├── package.json
├── tsconfig.json
├── .env.example
├── CLAUDE.md                        # Project instructions & standards
└── README.md
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- MongoDB (Atlas recommended)
- Claude API Key from [console.anthropic.com](https://console.anthropic.com)
- GitHub OAuth App credentials

### Local Development

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Start development server
npm run dev
```

### Environment Variables

See `.env.example` for all required environment variables:

- `MONGODB_URI` - MongoDB connection string
- `ANTHROPIC_API_KEY` - Claude API key
- `GITHUB_CLIENT_ID` - GitHub OAuth app ID
- `GITHUB_CLIENT_SECRET` - GitHub OAuth app secret
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `SESSION_SECRET` - Session secret (min 32 chars)
- `FRONTEND_URL` - Frontend URL for CORS
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)

## 📚 API Endpoints

### Authentication
```bash
GET  /api/auth/github              # Initiate GitHub OAuth
GET  /api/auth/github/callback     # OAuth callback
GET  /api/auth/me                  # Get current user
POST /api/auth/logout              # Logout
```

### Projects
```bash
GET    /api/projects               # List all projects
POST   /api/projects               # Create new project
GET    /api/projects/:id           # Get project details
PUT    /api/projects/:id           # Update project
DELETE /api/projects/:id           # Delete project
```

### Repositories
```bash
GET    /api/repositories           # List repositories (filter by projectId)
POST   /api/repositories           # Add repository to project
GET    /api/repositories/:id       # Get repository details
PUT    /api/repositories/:id       # Update repository
POST   /api/repositories/:id/sync  # Sync with remote
DELETE /api/repositories/:id       # Delete repository
```

### Tasks
```bash
GET    /api/tasks                  # List all tasks
POST   /api/tasks                  # Create new task
GET    /api/tasks/:id              # Get task details
POST   /api/tasks/:id/start        # Start dynamic team orchestration
GET    /api/tasks/:id/status       # Get orchestration progress
GET    /api/tasks/:id/orchestration # Get detailed logs
DELETE /api/tasks/:id              # Delete task
```

## 🔧 How It Works

### Dynamic Team Orchestration Flow

```
User creates task
      ↓
Product Manager analyzes complexity
      ↓
Project Manager creates stories (dynamically)
      ↓
Tech Lead decides team composition (N seniors + M juniors)
      ↓
Development Team spawns (all work in parallel)
├── Senior Developer 1 → Story A → PR #1
├── Senior Developer 2 → Story B → PR #2
├── Junior Developer 1 → Story C → PR #3 (reviewed by Senior 1)
└── Junior Developer 2 → Story D → PR #4 (reviewed by Senior 2)
      ↓
QA Engineer tests integration of ALL PRs
      ↓
Merge Coordinator (runs every 5 min)
├── Monitors ALL repositories
├── Detects conflicts between PRs
├── Resolves with Claude AI
└── Creates merge strategy
      ↓
Task completed ✅
```

### Key Features

**1. Dynamic Team Building**
- Team size adapts to task complexity
- Multiple seniors and juniors work in parallel
- Each developer creates their own branch and PR

**2. Global Conflict Monitoring**
- Separate service monitors ALL repositories with active tasks
- Detects conflicts between PRs from different tasks
- Runs automatically every 5 minutes
- Uses Claude to suggest resolution strategies

**3. Automatic Code Reviews**
- Seniors automatically review all junior PRs
- Reviews include code quality, security, and patterns
- Juniors cannot merge without senior approval

**4. Integration Testing**
- QA creates temporary branch merging all PRs
- Tests complete integration before final merge
- Validates accessibility and compliance

### Agent Execution Loop

Each agent follows the Claude Agent SDK loop:

1. **Gather Context**
   - Search through files
   - Read documentation
   - Analyze previous agent outputs

2. **Take Action**
   - Execute bash commands
   - Read/Write/Edit files
   - Create branches and PRs

3. **Verify Work**
   - Run tests
   - Check linting
   - Validate output

4. **Repeat**
   - Continue until complete
   - Self-correction on errors

## 🛡️ Security & Compliance

- **GDPR Compliant**: No PII in logs, encrypted data at rest
- **WCAG 2.1 AA**: Accessibility-first development
- **JWT Authentication**: Secure token-based auth
- **Rate Limiting**: API protection against abuse
- **Input Sanitization**: MongoDB injection prevention

## 🔑 Key Technologies

- **Backend**: TypeScript + Express.js
- **Database**: MongoDB with Mongoose
- **AI**: Claude Agent SDK by Anthropic
- **Authentication**: GitHub OAuth + JWT
- **Version Control**: Git + GitHub API
- **Process Management**: Schedulers for background tasks

## 🤝 Contributing

This project uses the official Claude Agent SDK. Key principles:

1. **Dynamic teams**: Teams scale based on task complexity
2. **Real execution**: Real bash, real file system, real Git operations
3. **Security first**: No PII in logs, hash sensitive data
4. **Test coverage**: Maintain >85% coverage
5. **Parallel work**: Multiple developers working simultaneously

## 📄 License

MIT License - See [LICENSE](./LICENSE) file for details

## 🆘 Support

- [Claude Agent SDK Docs](https://docs.anthropic.com/en/api/agent-sdk/overview)
- [Anthropic Support](https://support.anthropic.com)

---

**Built with** [Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-claude-agent-sdk) **by Anthropic**
