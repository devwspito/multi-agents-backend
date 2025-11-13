---
project: Multi-Agent Software Development Platform
version: 1.0.0
sdk: Claude Agent SDK
architecture: Multi-agent orchestration with event sourcing
---

# Multi-Agent Software Development Platform

Autonomous software development system using Claude Agent SDK with multi-agent orchestration.

## 🎯 Project Overview

This system orchestrates multiple specialized Claude agents to handle the complete software development lifecycle - from requirements analysis to deployment. Each agent has a specific role and works collaboratively through an orchestration coordinator.

### Key Capabilities
- **Autonomous Development**: Complete features from requirements to pull requests
- **Multi-Team Orchestration**: Parallel development with isolated contexts
- **Intelligent Error Recovery**: Automatic fixes with specialized fixer agents
- **Cost-Aware Execution**: Budget tracking and model selection optimization
- **Event Sourcing**: Complete audit trail of all agent actions

## 🏗️ Architecture

### Backend
- **Runtime**: Node.js 18+ with TypeScript (strict mode)
- **Database**: MongoDB with Mongoose ODM
- **API**: Express.js REST API + Socket.io for real-time updates
- **Agents**: Claude Agent SDK with multi-agent orchestration
- **Git**: Safe git operations with timeout protection

### Frontend
- **Framework**: React 18 with Hooks
- **Real-time**: Socket.io client for live agent updates
- **Styling**: CSS modules with responsive design
- **State**: React Context + local component state

### Agent System
```
OrchestrationCoordinator (Orchestrator - routes only)
├── ProblemAnalystPhase     (Deep problem analysis)
├── ProductManagerPhase      (Requirements → Epics)
├── ProjectManagerPhase      (Epics → Stories)
├── TechLeadPhase           (Architecture design)
├── TeamOrchestrationPhase  (Parallel team execution)
│   ├── DevelopersPhase     (Code implementation)
│   ├── JudgePhase          (Code review)
│   └── QAPhase             (Testing & validation)
├── FixerPhase              (Bug fixes)
└── AutoMergePhase          (PR creation & merge)
```

## 📁 Directory Structure

```
/src
  /agents                    # Agent prompts and definitions (future .md files)
  /config                   # Configuration files
    ModelConfigurations.ts  # Model selection per agent
  /middleware              # Express middleware
    auth.ts                # API authentication
  /models                  # MongoDB schemas
    Task.ts                # Orchestration tasks
    Project.ts             # Projects
    Repository.ts          # Git repositories
    User.ts                # User accounts
  /routes                  # API endpoints
    projects.ts            # Project management
    tasks.ts               # Task orchestration
    repositories.ts        # Repository operations
  /services
    /orchestration         # Agent phases
      OrchestrationCoordinator.ts  # Main orchestrator
      Phase.ts             # Base phase interface
      *Phase.ts            # Individual agent phases
    /github              # GitHub integration
      PRManagementService.ts
      GitHubService.ts
    FailureAnalysisService.ts     # Structured error logging
    AgentPermissionService.ts     # Security & permissions
    ContextCompactionService.ts   # Context management
    NotificationService.ts        # Real-time updates
  /tools                   # Custom MCP tools
    customTools.ts         # Epic branches, tests, security
  /utils                   # Utilities
    safeGitExecution.ts   # Safe git operations
  index.ts                # Application entry point
```

## 🧪 Testing

### Run Tests
```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Watch mode (development)
npm run test:watch

# Coverage report
npm run test:coverage
```

### Test Structure
- Unit tests: `*.test.ts` alongside source files
- Integration tests: `/tests/integration/`
- E2E tests: `/tests/e2e/`

## 🔨 Build & Development

### Development Mode
```bash
# Start development server with hot reload
npm run dev

# The server runs on http://localhost:3001
# Frontend should be on http://localhost:3000
```

### Production Build
```bash
# Compile TypeScript
npm run build

# Start production server
npm start

# Combined (build + start)
npm run build && npm start
```

### Linting & Code Quality
```bash
# Run ESLint
npm run lint

# Auto-fix issues
npm run lint:fix

# Type check (no emit)
npm run type-check

# Check code quality with custom tool
npm run analyze-quality
```

## 📝 Code Conventions

### TypeScript Rules
1. **Strict Mode**: All code must pass `strict: true` type checking
2. **Explicit Types**: Avoid `any` - use proper types or `unknown`
3. **Interfaces over Types**: Prefer `interface` for object shapes
4. **Readonly when possible**: Use `readonly` for immutable properties
5. **Async/Await**: Never use callbacks or `.then()` - always `async/await`

### Naming Conventions
- **Variables/Functions**: `camelCase` (e.g., `executeAgent`, `taskId`)
- **Classes/Interfaces**: `PascalCase` (e.g., `OrchestrationCoordinator`, `IPhase`)
- **Constants**: `UPPER_SNAKE_CASE` (e.g., `MAX_RETRIES`, `AGENT_PERMISSIONS`)
- **Private Properties**: Prefix with `_` (e.g., `_compactionService`)
- **Files**: Match class name or descriptive camelCase (e.g., `Phase.ts`, `customTools.ts`)

### Error Handling
```typescript
// ✅ DO THIS: Try-catch with structured logging
try {
  await riskyOperation();
} catch (error: any) {
  await failureAnalysisService.logFailure(
    taskId,
    agentType,
    'operation-name',
    error,
    { context: 'additional info' }
  );
  throw error; // Re-throw for upstream handling
}

// ❌ DON'T DO THIS: Silent failures or string errors
try {
  await riskyOperation();
} catch (error) {
  console.log('error'); // Too vague
  return null; // Silent failure
}
```

### Comments
- **Document WHY, not WHAT**: Code should be self-explanatory
- **Use JSDoc for public APIs**: Functions, classes, interfaces
- **Explain complex logic**: Business rules, algorithms, workarounds
- **Link to sources**: Reference docs, articles, issues when relevant

```typescript
// ✅ GOOD: Explains WHY
// Using timeout because large repos can hang indefinitely on git fetch
// Anthropic SDK best practice: Let operations complete naturally, but have safety net
const result = await safeGitExec('git fetch origin', { timeout: 120000 });

// ❌ BAD: States the obvious
// Fetch from origin
const result = await safeGitExec('git fetch origin');
```

## 🔐 Security

### Secrets Management
- **Never commit secrets**: Use `.env` files (gitignored)
- **Environment variables**: All sensitive config in `process.env`
- **SecretsDetectionService**: Scans agent output for exposed secrets
- **Sanitize logs**: Never log API keys, tokens, passwords

### Git Operations
- **Always use safeGitExecution**: Wraps git commands with timeout protection
- **Opt-in timeouts**: Set `GIT_ENABLE_TIMEOUTS=true` if needed (default: no timeouts)
- **Branch protection**: Never force push to main/master
- **Approval required**: git push, git merge require explicit approval in production

### Agent Permissions
- **Deny-all, allowlist**: Each agent only gets tools it needs
- **Command blacklist**: Dangerous commands blocked (rm -rf, sudo, etc.)
- **Approval workflow**: Sensitive operations require confirmation
- **See**: `AgentPermissionService.ts` for full permission matrix

## 🤖 Agent Guidelines

### Tool Usage Philosophy
**Agents are DOERS, not TALKERS**

```typescript
// ✅ DO THIS: Use tools immediately
await Read('src/services/Phase.ts');
await Grep('OrchestrationContext', { path: 'src' });
const files = await Glob('**/*.ts');

// ❌ DON'T DO THIS: Describe instead of doing
"I would read the Phase.ts file to understand the context structure..."
"The system should search for OrchestrationContext references..."
```

### File Operations
1. **Always Read before Edit**: SDK requires reading files first
2. **Use Edit for changes**: Prefer Edit over Write for existing files
3. **Write for new files only**: Use Write only when creating new files
4. **Verify after changes**: Read the file again to confirm changes applied

### Git Workflow
1. **Feature branches**: Create from `main` with `feature/` prefix
2. **Descriptive commits**: Explain WHAT changed and WHY
3. **Small commits**: One logical change per commit
4. **Test before commit**: Run tests and linting
5. **Pull before push**: Always pull latest changes first

### Testing Strategy
1. **Test-first when possible**: Write failing test, then implementation
2. **Unit tests for logic**: Test pure functions and business logic
3. **Integration tests for APIs**: Test endpoint behavior
4. **E2E tests for workflows**: Test complete user journeys

## 🎛️ Configuration

### Model Selection
Models are configured per agent type in `ModelConfigurations.ts`:
- **Haiku**: Fast tasks (linting, simple analysis) - $0.25/$1.25 per MTok
- **Sonnet**: Standard tasks (development, review) - $3/$15 per MTok
- **Opus**: Complex tasks (architecture, problem analysis) - $15/$75 per MTok

### Task Presets
- **PERFORMANCE_OPTIMIZED**: All Haiku (fast, cheap)
- **STANDARD_CONFIG**: Mixed (balanced)
- **QUALITY_FOCUSED**: All Sonnet (reliable, good quality)
- **HAIKU_FIRST**: Haiku with Sonnet fallback
- **SONNET_FOR_ALL**: All Sonnet (consistent quality)

### Context Compaction
- **Threshold**: Triggers at 80% of context window
- **Strategy**: Automatic summarization using SDK `/compact` command
- **Frequency**: Checked after each agent execution
- **See**: `ContextCompactionService.ts`

## 🔧 Custom Tools (MCP)

### Available Tools
1. **create_epic_branch**: Create standardized git branches for epics
2. **run_integration_tests**: Execute integration tests with structured results
3. **analyze_code_quality**: Run ESLint and return metrics
4. **validate_security_compliance**: GDPR, auth, dependencies, secrets scanning

### Tool Design Principles
- **Single responsibility**: Each tool does ONE thing well
- **Zod validation**: All inputs validated with schemas
- **Structured output**: Always return JSON with `success` boolean
- **Error handling**: Graceful failures with clear error messages
- **Composable**: Tools can be chained together

## 📊 Monitoring & Observability

### Logging Levels
- **Error**: Failures, exceptions (always logged)
- **Warn**: Degraded performance, recoverable issues
- **Info**: Important events (phase start/complete, major decisions)
- **Debug**: Detailed execution (tool calls, turns) - only when debugging

### Real-time Updates
- **Socket.io events**: Live progress updates to frontend
- **NotificationService**: Emits console logs, phase changes, errors
- **Event types**: `console-log`, `phase-start`, `phase-complete`, `error`, `progress`

### Failure Analysis
- **FailureAnalysisService**: Structured error classification
- **Anthropic Diagnostic Questions**: Applied automatically
  - Is the agent missing critical information?
  - Can you add formal rules to identify/fix failures?
  - Are the tools sufficiently creative and flexible?
- **Statistics**: Track failure patterns by category, severity, agent type

## 🚀 Deployment

### Environment Variables
```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...      # Anthropic API key
MONGODB_URI=mongodb://...          # MongoDB connection string
PORT=3001                          # API server port

# Optional
GIT_ENABLE_TIMEOUTS=false         # Enable git operation timeouts
LOG_LEVEL=info                    # Logging level
MAX_COST_PER_TASK=10.00          # Cost budget per task
ENABLE_AUTO_MERGE=false          # Auto-merge approved PRs
```

### Production Checklist
- [ ] All tests passing (`npm test`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] Linting clean (`npm run lint`)
- [ ] Environment variables configured
- [ ] MongoDB accessible
- [ ] Git credentials configured
- [ ] GitHub API token set (if using GitHub integration)
- [ ] Monitoring/logging configured
- [ ] Secrets detection enabled

## 📚 Additional Resources

### Documentation
- [Claude Agent SDK Docs](https://docs.claude.com/en/api/agent-sdk/overview)
- [Anthropic Best Practices](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Skywork AI Best Practices](https://skywork.ai/blog/claude-agent-sdk-best-practices-ai-agents-2025/)

### Internal Documentation
- `SDK_COMPLIANCE_COMPLETE.md` - SDK compliance verification
- `FINAL_COMPLIANCE_VERIFICATION.md` - Detailed compliance checklist
- `TOOLS_AUDIT_REPORT.md` - Custom tools audit
- `100_PERCENT_COMPLIANCE_ANALYSIS.md` - Path to 100% compliance

## 💡 Tips for Agents

### When You're Stuck
1. Use `Grep` to find similar implementations
2. Read test files to understand expected behavior
3. Check CLAUDE.md (this file) for conventions
4. Use `WebSearch` for technology-specific questions
5. Ask for clarification if requirements are ambiguous

### Best Practices
- **Explore first, act second**: Understand the codebase before making changes
- **Test as you go**: Run tests frequently during development
- **Commit often**: Small, atomic commits with clear messages
- **Document decisions**: Explain WHY in comments and commit messages
- **Think about users**: Consider edge cases and error handling

### Common Pitfalls to Avoid
- ❌ Editing files without reading them first
- ❌ Making large changes without testing
- ❌ Committing without running linting
- ❌ Force pushing to shared branches
- ❌ Hardcoding secrets or configuration
- ❌ Ignoring TypeScript errors
- ❌ Writing untested code

---

**Last Updated**: 2025-01-09
**Maintained By**: Orchestration Team
**SDK Version**: Claude Agent SDK (latest)
