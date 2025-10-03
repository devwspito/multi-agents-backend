# Multi-Agent Software Development Platform

## 🎯 Project Overview
Enterprise-grade autonomous development platform using Claude Code for comprehensive software development with automated multi-agent orchestration.

## 📋 Essential Bash Commands

### Development & Testing
```bash
npm install                 # Install dependencies
npm test                   # Run test suite (>85% coverage required)
npm run lint              # ESLint code quality checks
npm run build             # Production build validation
```

### Database & Server
```bash
npm start                 # Start development server
node backend/src/app.js   # Run backend server directly
```

### Git Workflow
```bash
git status                # Check repository status
git add .                 # Stage changes
git commit -m "message"   # Commit with message
gh pr create              # Create pull request
```

## 📁 Core Files and Architecture

### Backend Structure
```
backend/src/
├── app.js                 # Main Express application
├── models/                # MongoDB/Mongoose models
│   ├── Task.js           # Task model with orchestration
│   ├── User.js           # User authentication model
│   └── Project.js        # Project management model
├── routes/               # API route handlers
│   ├── tasks.js          # Task management endpoints
│   ├── auth.js           # Authentication endpoints
│   └── conversations.js  # Chat system endpoints
├── services/             # Business logic services
│   ├── ClaudeService.js  # Claude Code integration
│   └── AgentOrchestrator.js # Multi-agent coordination
└── middleware/           # Express middleware
    └── auth.js           # Authentication & security
```

### Frontend Integration Points
```
- REST API endpoints at /api/*
- JWT authentication system
- Multi-agent task orchestration
- Real-time progress monitoring
```

## 🎨 Code Style Guidelines

### JavaScript/Node.js Standards
```javascript
// Use async/await, not callbacks
const result = await someAsyncFunction();

// Destructure imports
const { authenticate, protectData } = require('./middleware/auth');

// Use meaningful variable names
const userAuthenticationToken = generateToken(user);

// Handle errors properly
try {
  await riskyOperation();
} catch (error) {
  logger.error('Operation failed', { error: error.message });
  throw error;
}
```

### Security Requirements
- NO sensitive data in logs or console outputs
- Hash user IDs and PII before storage
- Use parameterized database queries
- Validate and sanitize all inputs
- JWT tokens for authentication

## 🧪 Testing Instructions

### Test Commands
```bash
npm test                  # Run full test suite
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests only
npm run test:coverage    # Generate coverage report
```

### Test Requirements
- Minimum 85% code coverage
- Unit tests for all business logic
- Integration tests for API endpoints
- Security tests for authentication flows

## 🤖 Available Claude Code Agents

### Automatic Multi-Agent Orchestration
Every task automatically goes through ALL 6 agents in sequence:

1. **product-manager** - Requirements analysis and specifications
2. **project-manager** - Task breakdown and planning  
3. **tech-lead** - Architecture design and technical guidance
4. **senior-developer** - Complex feature implementation
5. **junior-developer** - UI components and simple features
6. **qa-engineer** - Testing and quality validation

### Usage
```bash
# Start automatic orchestration (all 6 agents run automatically)
POST /api/tasks/:id/start

# Monitor progress
GET /api/tasks/:id/status

# View detailed orchestration logs
GET /api/tasks/:id/orchestration
```

## 📝 Repository Etiquette

### Before Making Changes
1. **Always run the test suite first**: `npm test`
2. **Check code style**: `npm run lint`  
3. **Read recent commits**: `git log --oneline -10`
4. **Understand the orchestration flow**: Review `/backend/src/routes/tasks.js`

### Development Workflow
1. Create feature branch: `git checkout -b feature/description`
2. Make focused, atomic commits
3. Test thoroughly before pushing
4. Create descriptive pull requests
5. **Never** commit sensitive data or API keys

### Multi-Agent System Guidelines
- **Automatic orchestration**: Never manually assign agents
- **Single responsibility**: Each agent has a specific role
- **Sequential execution**: All 6 agents run in fixed order
- **Background processing**: Orchestration runs non-blocking
- **Image support**: Only images (JPG, PNG, GIF, WebP) up to 10MB

### Key Principles
- **Security first**: No PII in logs, hash sensitive data
- **Test coverage**: Maintain >85% coverage
- **Documentation**: Update this file when adding features
- **Performance**: Monitor orchestration execution times
- **Accessibility**: Follow WCAG 2.1 AA standards

### Emergency Commands
```bash
# Stop all processes
pkill -f "node backend"

# Reset database (development only)
npm run db:reset

# Clear logs
npm run logs:clear
```

## 🏗️ Enterprise Development Hierarchy

### Real-World Development Team Structure

```
🎯 Product Manager (Chief Product Officer level)
├── Analyzes business stakeholder requirements
├── Defines product specifications and objectives
├── Prioritizes features based on business impact
└── Communicates with executive leadership

    ↓ Requirements & Priorities

📋 Project Manager (Engineering Manager level)  
├── Breaks down business epics into implementable stories
├── Manages sprint planning and development cycles
├── Coordinates with business calendar and milestones
└── Reports progress to business stakeholders

    ↓ Epic Breakdown & Sprint Planning

🏗️ Tech Lead (Senior Engineering Manager level)
├── Receives epics from Project Manager
├── Designs technical architecture for software systems
├── Assigns stories to Senior Developers
├── Ensures security and performance compliance at architecture level
└── Mentors Senior Developers on technical best practices

    ↓ Story Assignment & Technical Guidance

🎓 Senior Developer (Senior Software Engineer level)
├── Implements complex software features (API integration, data processing)
├── Reviews ALL Junior Developer code before merge
├── Ensures GDPR/security compliance in implementations
├── Mentors Junior Developers with technical context
└── Escalates to Tech Lead when needed

    ↓ Code Review & Mentorship

👨‍💻 Junior Developer (Software Engineer level)
├── Implements UI components and simple software features
├── Follows senior guidance and coding standards
├── Writes unit tests with business context
├── Learns technical domain knowledge through implementation
└── Code MUST be reviewed by Senior before merge

    ↓ Implementation & Learning

🧪 QA Engineer (Quality Assurance Engineer level)
├── FINAL GATE - nothing goes to production without QA approval
├── Tests software workflows and user journeys
├── Validates WCAG 2.1 AA accessibility compliance
├── Performs security and performance testing
├── Validates system integration functionality
└── Signs off on quality and performance metrics
```

## 🔄 Software Development Workflow

### Epic → Story → Implementation Flow

1. **Product Manager** receives business requirement from stakeholders
   - Analyzes business objectives and user needs
   - Defines acceptance criteria with business context
   - Prioritizes based on business impact

2. **Project Manager** breaks epic into implementable stories
   - Creates stories following user journey patterns
   - Estimates complexity considering technical requirements
   - Plans sprints aligned with business milestones

3. **Tech Lead** receives epic and designs implementation
   - Architects solution considering security and performance
   - Assigns stories to Senior Developers based on expertise
   - Ensures technical design supports business scalability

4. **Senior Developer** implements complex features and reviews junior work
   - Implements API integrations, data processing, system architecture
   - Reviews EVERY line of junior code for quality and security
   - Provides mentorship with technical domain context

5. **Junior Developer** implements under senior supervision
   - Builds UI components, simple CRUD operations
   - Follows accessibility guidelines and coding standards
   - Learns through implementation and senior feedback

6. **QA Engineer** validates everything before production
   - Tests complete software user journeys
   - Validates accessibility for diverse user needs
   - Confirms GDPR/security compliance
   - **NOTHING deploys without QA sign-off**

## 📚 Software Development Standards

### Data Privacy & Security
```javascript
// ✅ CORRECT - GDPR compliant logging
logger.info(`Processing request for user ${hashUserId(userId)}`);

// ❌ WRONG - Privacy violation
logger.info(`Processing request for ${user.email}`);
```

### Accessibility-First Development
```javascript
// ✅ CORRECT - WCAG 2.1 AA compliant
<button 
  aria-label={`Submit ${formTitle} form`}
  aria-describedby="submit-help"
  className="focus:ring-2 focus:ring-blue-500"
>
  Submit Form
</button>

// ❌ WRONG - Accessibility violations
<div onClick={submitForm}>Submit</div>
```

### Business Context Requirements
```javascript
// ✅ CORRECT - Business impact documented
const calculateMetrics = (data, weights) => {
  /**
   * Business Objective: Calculate weighted performance metrics
   * Accessibility: Supports screen reader announcements for calculations
   * Security: No PII stored in calculation process
   */
  return data.reduce((metric, item, index) => {
    return metric + (item.value * weights[index]);
  }, 0) / weights.reduce((sum, weight) => sum + weight, 0);
};
```

## 🛡️ Enterprise Compliance Requirements

### GDPR (Data Privacy Protection)
- NO user PII in logs, error messages, or client-side code
- ALL user data must be encrypted at rest (AES-256)
- Database queries must use parameterized statements
- Audit trail required for all user data access

### Security Standards (Enterprise Protection)
- Authentication and authorization workflows
- Minimal data collection and retention policies
- Security-first UI considerations
- Regular security audits and notifications

### WCAG 2.1 AA (Accessibility)
- All interactive elements must be keyboard accessible
- Color contrast ratio minimum 4.5:1
- Screen reader compatibility required
- Support for browser zoom up to 200%

### Software Testing Standards
- Unit test coverage minimum 85%
- Integration tests for business workflows
- Accessibility testing with automated tools
- Performance testing for peak usage scenarios

## 🔧 Agent Configuration

### Product Manager (claude-opus-4-1-20250805)
```yaml
description: "Analyzes requirements and defines product specifications"
tools: [Read, Grep, WebSearch]
restrictions: [no_code_modification]
focus: [requirements_analysis, stakeholder_communication]
```

### Project Manager (claude-opus-4-1-20250805)
```yaml
description: "Breaks down epics into implementable stories"
tools: [Read, Write, Edit, Grep]
restrictions: [no_implementation_code]
focus: [task_breakdown, sprint_planning]
```

### Tech Lead (claude-opus-4-1-20250805)
```yaml
description: "Designs technical architecture and mentors development team"
tools: [Read, Write, Edit, Bash, Grep, Glob]
restrictions: [architecture_only, no_direct_implementation]
focus: [system_design, technical_guidance]
```

### Senior Developer (claude-opus-4-1-20250805)
```yaml
description: "Implements complex features and reviews all junior code"
tools: [Read, Write, Edit, Bash, Grep, Glob, Git]
restrictions: [complex_features_only, must_review_junior_code]
focus: [complex_implementation, code_review, mentorship]
```

### Junior Developer (claude-sonnet-4-5-20250929)
```yaml
description: "Implements UI components and simple features under supervision"
tools: [Read, Write, Edit, Bash]
restrictions: [simple_features_only, requires_senior_review]
focus: [ui_components, simple_crud, learning]
```

### QA Engineer (claude-sonnet-4-5-20250929)
```yaml
description: "Final quality gate with comprehensive testing and validation"
tools: [Read, Bash, BrowserAutomation, AccessibilityTools]
restrictions: [testing_only, final_approval_authority]
focus: [testing, compliance_validation, quality_gates]
```

## 🎯 Business Success Metrics

### Product Impact KPIs
- Business objective achievement rate
- Accessibility compliance score (>95%)
- User engagement improvement
- Time-to-market reduction

### Development Quality Metrics
- Code review cycle time (Senior → Junior feedback loop)
- Security compliance pass rate
- Accessibility defect density
- GDPR/Security violation rate (target: 0)

### Team Performance Indicators
- Junior developer skill progression
- Senior mentorship effectiveness
- Cross-functional collaboration rating
- Technical domain knowledge growth

## 🚀 Quick Start Commands

```bash
# Start development environment
claude

# Analyze new business requirement
/product-manager "implement user authentication system"

# Break down epic into implementable stories  
/project-manager "user-authentication-epic"

# Design technical architecture
/tech-lead "authentication-architecture" 

# Senior implements complex features
/senior-developer "authentication-backend"

# Junior implements UI under supervision
/junior-developer "user-dashboard-ui"

# QA validates complete workflow
/qa-engineer "authentication-complete-flow"
```

## 📈 Enterprise Deployment Pipeline

```yaml
stages:
  - security_compliance_scan  # Automated vulnerability detection
  - accessibility_testing     # WCAG 2.1 AA validation  
  - business_workflow_test    # User journey testing
  - senior_code_review        # Human senior review required
  - qa_final_sign_off         # QA final approval
  - gradual_user_rollout      # Phased deployment
```

---

This configuration creates a realistic enterprise development team hierarchy for any software project, following Claude Code best practices while maintaining rigorous security compliance and quality standards.