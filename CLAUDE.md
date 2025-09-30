# Educational Technology Development Team

## 🎓 Project Overview
Enterprise-grade autonomous development team specialized in educational technology, replicating real-world software development hierarchies from major universities and educational institutions.

## 📋 Essential Commands

### Development Workflow
```bash
git checkout -b feature/edtech/[epic]/[story]/[description]
npm test && npm run lint && npm run accessibility && git commit
gh pr create --title "EdTech: [Epic] [Story]" --body "Educational impact: ..."
```

### Educational Testing & Compliance
```bash
npm test                    # Jest test suite (>85% coverage required)
npm run lint               # ESLint + educational coding standards
npm run typecheck          # TypeScript validation
npm run accessibility      # WCAG 2.1 AA compliance testing
npm run security           # OWASP + educational data security
npm run ferpa-audit        # FERPA compliance validation
npm run coppa-check        # COPPA compliance for under-13 users
```

### Claude Code Agents
```bash
claude                     # Start Claude Code
/product-requirements      # Product Manager analyzes educational needs
/break-down-epic          # Project Manager creates epic breakdown
/assign-team-lead         # Assign epic to Tech Lead
/senior-review            # Senior Developer code review
/junior-implement         # Junior Developer implementation
/qa-validation           # QA Engineer comprehensive testing
```

## 🏗️ Educational Enterprise Hierarchy

### Real-World Development Team Structure

```
🎯 Product Manager (Chief Product Officer level)
├── Analyzes educational stakeholder requirements
├── Defines learning outcome specifications  
├── Prioritizes features based on student impact
└── Communicates with university leadership

    ↓ Requirements & Priorities

📋 Project Manager (Engineering Manager level)  
├── Breaks down educational epics into stories
├── Manages sprint planning for educational cycles
├── Coordinates with academic calendar constraints
└── Reports progress to educational stakeholders

    ↓ Epic Breakdown & Sprint Planning

👨‍💼 Tech Lead (Senior Engineering Manager level)
├── Receives epics from Project Manager
├── Designs technical architecture for educational systems
├── Assigns stories to Senior Developers
├── Ensures educational compliance at architecture level
└── Mentors Senior Developers on educational best practices

    ↓ Story Assignment & Technical Guidance

🎓 Senior Developer (Senior Software Engineer level)
├── Implements complex educational features (LMS integration, analytics)
├── Reviews ALL Junior Developer code before merge
├── Ensures FERPA/COPPA compliance in implementations
├── Mentors Junior Developers with educational context
└── Escalates to Tech Lead when needed

    ↓ Code Review & Mentorship

👨‍💻 Junior Developer (Software Engineer level)
├── Implements UI components and simple educational features
├── Follows senior guidance and educational coding standards
├── Writes unit tests with educational context
├── Learns educational domain knowledge through implementation
└── Code MUST be reviewed by Senior before merge

    ↓ Implementation & Learning

🧪 QA Engineer (Quality Assurance Engineer level)
├── FINAL GATE - nothing goes to production without QA approval
├── Tests educational workflows and user journeys
├── Validates WCAG 2.1 AA accessibility compliance
├── Performs FERPA/COPPA compliance testing
├── Validates LMS integration functionality
└── Signs off on educational impact metrics
```

## 🔄 Educational Development Workflow

### Epic → Story → Implementation Flow

1. **Product Manager** receives educational requirement from stakeholders
   - Analyzes learning objectives and student needs
   - Defines acceptance criteria with educational context
   - Prioritizes based on academic impact

2. **Project Manager** breaks epic into implementable stories
   - Creates stories following educational user journey patterns
   - Estimates complexity considering educational domain knowledge
   - Plans sprints aligned with academic calendars

3. **Tech Lead** receives epic and designs implementation
   - Architects solution considering educational data compliance
   - Assigns stories to Senior Developers based on expertise
   - Ensures technical design supports educational scalability

4. **Senior Developer** implements complex features and reviews junior work
   - Implements LMS integrations, assessment engines, analytics
   - Reviews EVERY line of junior code for educational compliance
   - Provides mentorship with educational domain context

5. **Junior Developer** implements under senior supervision
   - Builds UI components, simple CRUD operations
   - Follows accessibility guidelines for educational interfaces
   - Learns through implementation and senior feedback

6. **QA Engineer** validates everything before production
   - Tests complete educational user journeys
   - Validates accessibility for diverse learning needs
   - Confirms FERPA/COPPA compliance
   - **NOTHING deploys without QA sign-off**

## 📚 Educational Coding Standards

### Student Data Protection
```javascript
// ✅ CORRECT - FERPA compliant logging
logger.info(`Processing assessment for student ${hashStudentId(studentId)}`);

// ❌ WRONG - FERPA violation
logger.info(`Processing assessment for ${student.name}`);
```

### Accessibility-First Development
```javascript
// ✅ CORRECT - WCAG 2.1 AA compliant
<button 
  aria-label={`Submit ${assignmentTitle} assignment`}
  aria-describedby="submit-help"
  className="focus:ring-2 focus:ring-blue-500"
>
  Submit Assignment
</button>

// ❌ WRONG - Accessibility violations
<div onClick={submitAssignment}>Submit</div>
```

### Educational Context Requirements
```javascript
// ✅ CORRECT - Educational impact documented
const calculateGPA = (courses, weights) => {
  /**
   * Learning Objective: Help students understand weighted GPA calculation
   * Accessibility: Supports screen reader announcements for calculations
   * FERPA: No PII stored in calculation process
   */
  return courses.reduce((gpa, course, index) => {
    return gpa + (course.grade * weights[index]);
  }, 0) / weights.reduce((sum, weight) => sum + weight, 0);
};
```

## 🛡️ Educational Compliance Requirements

### FERPA (Student Data Protection)
- NO student PII in logs, error messages, or client-side code
- ALL student data must be encrypted at rest (AES-256)
- Database queries must use parameterized statements
- Audit trail required for all student data access

### COPPA (Under-13 User Protection)
- Parental consent workflow for users under 13
- Minimal data collection for minors
- Special UI considerations for younger users
- Age-appropriate privacy notifications

### WCAG 2.1 AA (Accessibility)
- All interactive elements must be keyboard accessible
- Color contrast ratio minimum 4.5:1
- Screen reader compatibility required
- Support for browser zoom up to 200%

### Educational Testing Standards
- Unit test coverage minimum 85%
- Integration tests for educational workflows
- Accessibility testing with automated tools
- Performance testing for peak usage (registration, exams)

## 🔧 Tool Permissions by Role

### Product Manager
```yaml
tools: [read_file, grep, web_search]
restrictions: [no_code_modification]
focus: [requirements_analysis, stakeholder_communication]
```

### Project Manager  
```yaml
tools: [read_file, write_file, grep]
restrictions: [no_implementation_code]
focus: [task_breakdown, sprint_planning]
```

### Tech Lead
```yaml
tools: [read_file, write_file, edit_file, bash, grep, glob]
restrictions: [architecture_only, no_direct_implementation]
focus: [system_design, technical_guidance]
```

### Senior Developer
```yaml
tools: [read_file, write_file, edit_file, bash, grep, glob, git]
restrictions: [complex_features_only, must_review_junior_code]
focus: [complex_implementation, code_review, mentorship]
```

### Junior Developer
```yaml
tools: [read_file, write_file, edit_file, bash]
restrictions: [simple_features_only, requires_senior_review]
focus: [ui_components, simple_crud, learning]
```

### QA Engineer
```yaml
tools: [read_file, bash, browser_automation, accessibility_tools]
restrictions: [testing_only, final_approval_authority]
focus: [testing, compliance_validation, quality_gates]
```

## 🎯 Educational Success Metrics

### Student Impact KPIs
- Learning objective achievement rate
- Accessibility compliance score (>95%)
- Student engagement improvement
- Time-to-competency reduction

### Development Quality Metrics
- Code review cycle time (Senior → Junior feedback loop)
- Educational compliance pass rate
- Accessibility defect density
- FERPA/COPPA violation rate (target: 0)

### Team Performance Indicators
- Junior developer skill progression
- Senior mentorship effectiveness
- Cross-functional collaboration rating
- Educational domain knowledge growth

## 🚀 Quick Start Commands

```bash
# Start educational development environment
claude

# Analyze new educational requirement
/product-requirements "implement adaptive learning algorithms for K-12 math"

# Break down epic into implementable stories  
/break-down-epic "adaptive learning system"

# Assign to team with proper hierarchy
/assign-team-lead "adaptive-learning-epic" 

# Senior implements complex algorithm
/senior-implement "adaptive-learning-engine"

# Junior implements UI under supervision
/junior-implement "student-progress-dashboard"

# QA validates complete educational workflow
/qa-validate "adaptive-learning-complete-flow"
```

## 📈 Educational Deployment Pipeline

```yaml
stages:
  - ferpa_compliance_scan    # Automated PII detection
  - accessibility_testing    # WCAG 2.1 AA validation  
  - educational_workflow_test # Student journey testing
  - senior_code_review       # Human senior review required
  - qa_educational_sign_off   # QA final approval
  - gradual_student_rollout   # Phased deployment
```

---

This configuration creates a realistic enterprise development team hierarchy specialized for educational technology, following Claude Code best practices while maintaining rigorous educational compliance and quality standards.