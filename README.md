# Multi-Agent Software Development Platform

Enterprise-grade autonomous development platform powered by **Claude Agent SDK**.

## 🎯 Overview

This platform orchestrates 6 specialized AI agents to complete complex software development tasks autonomously using the **official Claude Agent SDK from Anthropic**.

## 🤖 The 6 Specialized Agents

Each agent follows the official Claude Agent SDK loop:

1. **Product Manager** - Requirements analysis & specifications
2. **Project Manager** - Task breakdown & sprint planning
3. **Tech Lead** - Architecture design & technical guidance
4. **Senior Developer** - Complex feature implementation & code review
5. **Junior Developer** - UI components & simple features
6. **QA Engineer** - Final quality gate (NOTHING ships without QA approval)

## 🏗️ Architecture

```
agents-software-arq/
├── .claude/                # Claude Code configuration
├── backend/                # TypeScript backend with Claude Agent SDK
│   ├── src/
│   │   ├── config/         # Environment & database config
│   │   ├── models/         # MongoDB models (User, Task)
│   │   ├── routes/         # Express API routes
│   │   ├── services/       # AgentService (Claude Agent SDK core)
│   │   ├── middleware/     # Authentication & security
│   │   └── index.ts        # Application entry point
│   ├── deploy-vultr.sh     # One-command deployment
│   └── README.md           # Backend documentation
├── CLAUDE.md               # Project instructions & standards
├── MIGRATION.md            # Migration guide from old backend
└── LICENSE
```

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- MongoDB (Atlas recommended)
- Claude API Key from [console.anthropic.com](https://console.anthropic.com)
- GitHub OAuth App credentials

### Local Development

```bash
cd backend

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials

# Start development server
npm run dev
```

### Production Deployment (Vultr)

```bash
# Create Ubuntu 24.04 server on Vultr
# Then run in server console:

bash <(curl -s https://raw.githubusercontent.com/devwspito/multi-agents-backend/main/backend/deploy-vultr.sh)
```

That's it! Your platform will be running with:
- ✅ Claude Agent SDK
- ✅ TypeScript backend
- ✅ MongoDB connection
- ✅ Nginx reverse proxy
- ✅ PM2 process manager
- ✅ Auto-restart on reboot

## 📚 API Endpoints

### Authentication
```bash
GET  /api/auth/github              # Initiate GitHub OAuth
GET  /api/auth/github/callback     # OAuth callback
GET  /api/auth/me                  # Get current user
POST /api/auth/logout              # Logout
```

### Tasks
```bash
GET    /api/tasks                  # List all tasks
POST   /api/tasks                  # Create new task
GET    /api/tasks/:id              # Get task details
POST   /api/tasks/:id/start        # Start agent orchestration
GET    /api/tasks/:id/status       # Get orchestration progress
GET    /api/tasks/:id/orchestration # Get detailed logs
DELETE /api/tasks/:id              # Delete task
```

## 🔧 How It Works

### Agent Orchestration Flow

```
User creates task
      ↓
Product Manager analyzes requirements
      ↓
Project Manager breaks into stories
      ↓
Tech Lead designs architecture
      ↓
Senior Developer implements features
      ↓
Junior Developer implements UI
      ↓
QA Engineer validates (FINAL GATE)
      ↓
Task completed ✅
```

### Agent Loop (Official Claude Agent SDK)

Each agent follows this loop:

1. **Gather Context**
   - Agentic search through files
   - Read relevant documentation
   - Analyze previous agent outputs
   - Use subagents for parallel work

2. **Take Action**
   - Execute bash commands (real execution)
   - Read/Write/Edit files (real file system)
   - Generate code
   - Use MCP tools for external integrations

3. **Verify Work**
   - Run tests
   - Check linting
   - Visual feedback (screenshots)
   - LLM as judge for quality

4. **Repeat**
   - Continue until task is complete
   - Automatic context compaction
   - Self-correction on errors

## 🛡️ Security & Compliance

- **GDPR Compliant**: No PII in logs, encrypted data at rest
- **WCAG 2.1 AA**: Accessibility-first development
- **JWT Authentication**: Secure token-based auth
- **Rate Limiting**: API protection against abuse
- **Input Sanitization**: MongoDB injection prevention

## 📖 Documentation

- [Backend README](./backend/README.md) - Detailed backend documentation
- [CLAUDE.md](./CLAUDE.md) - Project instructions & standards
- [MIGRATION.md](./MIGRATION.md) - Migration guide from old backend
- [Claude Agent SDK Docs](https://docs.anthropic.com/en/api/agent-sdk/overview)

## 🔑 Environment Variables

See `backend/.env.example` for all required environment variables:

- `MONGODB_URI` - MongoDB connection string
- `ANTHROPIC_API_KEY` - Claude API key
- `GITHUB_CLIENT_ID` - GitHub OAuth app ID
- `GITHUB_CLIENT_SECRET` - GitHub OAuth app secret
- `JWT_SECRET` - JWT signing secret (min 32 chars)
- `SESSION_SECRET` - Session secret (min 32 chars)
- `FRONTEND_URL` - Frontend URL for CORS
- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment (development/production)

## 🤝 Contributing

This project uses the official Claude Agent SDK. Key principles:

1. **Use official tools**: Never reinvent what the SDK provides
2. **Follow the agent loop**: Gather → Act → Verify → Repeat
3. **Real execution**: Real bash, real file system, real tools
4. **Security first**: No PII in logs, hash sensitive data
5. **Test coverage**: Maintain >85% coverage

## 📄 License

MIT License - See [LICENSE](./LICENSE) file for details

## 🆘 Support

- [GitHub Issues](https://github.com/devwspito/multi-agents-backend/issues)
- [Claude Agent SDK Docs](https://docs.anthropic.com/en/api/agent-sdk/overview)
- [Anthropic Support](https://support.anthropic.com)

---

**Built with** [Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-claude-agent-sdk) **by Anthropic**
