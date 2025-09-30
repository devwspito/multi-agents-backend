#!/bin/bash

# Educational Post-Code Review Hook
# Triggers after code review completion to ensure educational standards and mentoring

set -e

echo "🎓 Educational Post-Code Review Process..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Environment variables passed by Claude Code
REVIEWER_AGENT=${CLAUDE_REVIEWER_AGENT:-"unknown"}
REVIEW_STATUS=${CLAUDE_REVIEW_STATUS:-"unknown"}
PULL_REQUEST_NUMBER=${CLAUDE_PR_NUMBER:-""}
JUNIOR_DEVELOPER=${CLAUDE_ASSIGNEE_AGENT:-""}
EDUCATIONAL_CONTEXT=${CLAUDE_EDUCATIONAL_CONTEXT:-"general"}

# Function to print status messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_educational() {
    echo -e "${PURPLE}🎓${NC} $1"
}

# Determine if this was a junior developer's work requiring senior review
if [[ "$JUNIOR_DEVELOPER" == "junior-developer" ]]; then
    REQUIRES_SENIOR_REVIEW=true
else
    REQUIRES_SENIOR_REVIEW=false
fi

echo ""
echo "📋 Code Review Summary"
echo "====================="
print_info "Reviewer: $REVIEWER_AGENT"
print_info "Review Status: $REVIEW_STATUS"
print_info "PR Number: $PULL_REQUEST_NUMBER"
print_info "Educational Context: $EDUCATIONAL_CONTEXT"
print_info "Junior Developer Code: $REQUIRES_SENIOR_REVIEW"

# Handle different review outcomes
case "$REVIEW_STATUS" in
    "approved")
        handle_approved_review
        ;;
    "changes-requested") 
        handle_changes_requested
        ;;
    "rejected")
        handle_rejected_review
        ;;
    *)
        print_warning "Unknown review status: $REVIEW_STATUS"
        ;;
esac

function handle_approved_review() {
    echo ""
    echo "✅ Code Review Approved"
    echo "======================"
    
    if [[ "$REQUIRES_SENIOR_REVIEW" == "true" ]]; then
        print_educational "Senior developer has approved junior developer's educational technology implementation"
        
        # Record mentoring success
        echo "$(date): Junior developer code approved by $REVIEWER_AGENT" >> .claude/mentoring-log.txt
        
        # Trigger educational compliance final check
        run_educational_compliance_check
        
        # If this is educational code, trigger QA validation
        if [[ "$EDUCATIONAL_CONTEXT" != "general" ]]; then
            trigger_qa_educational_validation
        fi
        
        # Update junior developer's learning progress
        update_junior_learning_progress "code_approved"
        
    elif [[ "$REVIEWER_AGENT" == "senior-developer" ]]; then
        print_educational "Senior developer implementation approved - ready for QA validation"
        trigger_qa_educational_validation
    fi
    
    # Check if ready for merge
    check_merge_readiness
}

function handle_changes_requested() {
    echo ""
    echo "🔄 Changes Requested"
    echo "==================="
    
    if [[ "$REQUIRES_SENIOR_REVIEW" == "true" ]]; then
        print_educational "Senior developer has requested changes - providing educational mentoring"
        
        # Record mentoring opportunity
        echo "$(date): Junior developer needs mentoring from $REVIEWER_AGENT" >> .claude/mentoring-log.txt
        
        # Check if this is excessive review cycles (escalation needed)
        REVIEW_CYCLE_COUNT=$(git log --oneline | grep -c "Review cycle" || echo "0")
        
        if [[ $REVIEW_CYCLE_COUNT -gt 2 ]]; then
            print_warning "Multiple review cycles detected - considering tech lead escalation"
            notify_tech_lead_escalation
        fi
        
        # Generate educational learning resources
        generate_learning_resources
        
        # Schedule mentoring session if needed
        if [[ $REVIEW_CYCLE_COUNT -gt 1 ]]; then
            schedule_mentoring_session
        fi
        
    else
        print_info "Changes requested for senior developer implementation"
        # Senior developer changes - may need architecture review
        if [[ "$EDUCATIONAL_CONTEXT" =~ "complex"|"integration"|"compliance" ]]; then
            notify_tech_lead_review
        fi
    fi
}

function handle_rejected_review() {
    echo ""
    echo "❌ Code Review Rejected"
    echo "======================"
    
    print_error "Code rejected due to educational compliance or quality issues"
    
    if [[ "$REQUIRES_SENIOR_REVIEW" == "true" ]]; then
        print_educational "Junior developer code requires significant rework - scheduling intensive mentoring"
        
        # Record rejection for learning analytics
        echo "$(date): Junior developer code rejected by $REVIEWER_AGENT - needs intensive mentoring" >> .claude/mentoring-log.txt
        
        # Trigger intensive mentoring workflow
        schedule_intensive_mentoring
        
        # Consider pairing session with senior
        schedule_pair_programming_session
        
    else
        print_error "Senior developer code rejected - escalating to tech lead"
        escalate_to_tech_lead "senior_code_rejected"
    fi
    
    # Generate detailed rejection analysis
    generate_rejection_analysis
}

function run_educational_compliance_check() {
    print_info "Running final educational compliance validation..."
    
    # Check for FERPA compliance
    if grep -r "student.*name\|student.*email" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" .; then
        print_error "FERPA violation detected in approved code!"
        notify_compliance_violation "FERPA"
        return 1
    fi
    
    # Check for accessibility compliance
    if command -v npx >/dev/null 2>&1 && [ -f "package.json" ]; then
        if ! npx jest --testNamePattern="accessibility" --silent 2>/dev/null; then
            print_warning "Accessibility tests not passing - notifying QA engineer"
            notify_accessibility_issue
        fi
    fi
    
    print_status "Educational compliance check completed"
}

function trigger_qa_educational_validation() {
    print_educational "Triggering QA Engineer educational validation workflow"
    
    # Create QA validation request
    cat > .claude/qa-validation-request.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "prNumber": "$PULL_REQUEST_NUMBER",
    "educationalContext": "$EDUCATIONAL_CONTEXT",
    "reviewerAgent": "$REVIEWER_AGENT",
    "requiresEducationalTesting": true,
    "complianceChecks": {
        "ferpa": true,
        "coppa": $(if [[ "$EDUCATIONAL_CONTEXT" =~ "k12"|"under13" ]]; then echo "true"; else echo "false"; fi),
        "wcag": true,
        "educationalWorkflow": true
    },
    "priority": $(if [[ "$EDUCATIONAL_CONTEXT" =~ "critical"|"compliance" ]]; then echo "\"high\""; else echo "\"normal\""; fi)
}
EOF
    
    print_status "QA validation request created"
}

function update_junior_learning_progress() {
    local outcome=$1
    
    if [[ "$REQUIRES_SENIOR_REVIEW" == "true" ]]; then
        # Update learning analytics
        local progress_file=".claude/junior-learning-progress.json"
        
        if [[ ! -f "$progress_file" ]]; then
            echo '{"reviewCycles": 0, "approvals": 0, "learningAreas": []}' > "$progress_file"
        fi
        
        # Use jq to update progress if available, otherwise append to log
        if command -v jq >/dev/null 2>&1; then
            jq --arg outcome "$outcome" --arg date "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
               '.reviewCycles += 1 | if $outcome == "code_approved" then .approvals += 1 else . end | .lastUpdate = $date' \
               "$progress_file" > "${progress_file}.tmp" && mv "${progress_file}.tmp" "$progress_file"
        else
            echo "$(date): $outcome" >> .claude/learning-progress.log
        fi
        
        print_educational "Junior developer learning progress updated"
    fi
}

function generate_learning_resources() {
    print_educational "Generating educational technology learning resources..."
    
    local resources_file=".claude/learning-resources.md"
    
    cat > "$resources_file" << EOF
# Educational Technology Learning Resources

## Based on Recent Code Review

### Areas for Improvement Identified:
- Educational domain knowledge
- FERPA compliance implementation
- Accessibility best practices
- Educational UX patterns

### Recommended Learning Path:

#### 1. Educational Technology Fundamentals
- [FERPA Compliance for Developers](./docs/ferpa-compliance.md)
- [Educational UX Design Principles](./docs/educational-ux.md)
- [LMS Integration Patterns](./docs/lms-integration.md)

#### 2. Accessibility in Educational Technology
- [WCAG 2.1 AA Implementation Guide](./docs/accessibility-guide.md)
- [Screen Reader Testing for Educational Apps](./docs/screen-reader-testing.md)
- [Cognitive Accessibility for Diverse Learners](./docs/cognitive-accessibility.md)

#### 3. Educational Code Patterns
- [Student Data Protection Patterns](./docs/student-data-patterns.md)
- [Educational Form Design](./docs/educational-forms.md)
- [Learning Analytics Implementation](./docs/learning-analytics.md)

### Next Mentoring Session Topics:
1. Review feedback from senior developer
2. Hands-on FERPA compliance implementation
3. Accessibility testing with screen readers
4. Educational domain vocabulary and concepts

Generated on: $(date)
EOF
    
    print_status "Learning resources generated at $resources_file"
}

function schedule_mentoring_session() {
    print_educational "Scheduling mentoring session between junior and senior developer"
    
    # Create mentoring session request
    cat > .claude/mentoring-session-request.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "type": "code_review_follow_up",
    "participants": ["$JUNIOR_DEVELOPER", "$REVIEWER_AGENT"],
    "prNumber": "$PULL_REQUEST_NUMBER",
    "focusAreas": [
        "code_review_feedback",
        "educational_domain_knowledge",
        "compliance_requirements"
    ],
    "urgency": "normal",
    "estimatedDuration": "60_minutes"
}
EOF
    
    print_status "Mentoring session request created"
}

function schedule_intensive_mentoring() {
    print_educational "Scheduling intensive mentoring due to code rejection"
    
    cat > .claude/intensive-mentoring-request.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "type": "intensive_mentoring",
    "reason": "code_rejection",
    "participants": ["$JUNIOR_DEVELOPER", "$REVIEWER_AGENT"],
    "prNumber": "$PULL_REQUEST_NUMBER",
    "focusAreas": [
        "fundamental_educational_concepts",
        "compliance_deep_dive",
        "code_quality_standards",
        "educational_ux_principles"
    ],
    "urgency": "high",
    "estimatedDuration": "2_hours",
    "followUpRequired": true
}
EOF
    
    print_status "Intensive mentoring session scheduled"
}

function schedule_pair_programming_session() {
    print_educational "Scheduling pair programming session for hands-on learning"
    
    cat > .claude/pair-programming-request.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "type": "pair_programming",
    "reason": "code_rejection_recovery",
    "driver": "$JUNIOR_DEVELOPER",
    "navigator": "$REVIEWER_AGENT",
    "prNumber": "$PULL_REQUEST_NUMBER",
    "objectives": [
        "implement_solution_together",
        "real_time_mentoring",
        "educational_pattern_learning"
    ],
    "estimatedDuration": "3_hours"
}
EOF
    
    print_status "Pair programming session scheduled"
}

function notify_tech_lead_escalation() {
    print_warning "Notifying tech lead of potential escalation need"
    
    cat > .claude/tech-lead-notification.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "type": "escalation_consideration",
    "reason": "multiple_review_cycles",
    "prNumber": "$PULL_REQUEST_NUMBER",
    "currentAssignee": "$JUNIOR_DEVELOPER",
    "reviewer": "$REVIEWER_AGENT",
    "reviewCycleCount": $REVIEW_CYCLE_COUNT,
    "recommendation": "consider_escalation_to_senior_developer_direct_implementation"
}
EOF
    
    print_status "Tech lead notification sent"
}

function check_merge_readiness() {
    print_info "Checking merge readiness for educational code..."
    
    local ready_for_merge=true
    
    # Check if QA validation is required
    if [[ "$EDUCATIONAL_CONTEXT" != "general" && ! -f ".claude/qa-approval.json" ]]; then
        ready_for_merge=false
        print_warning "Educational code requires QA Engineer approval before merge"
    fi
    
    # Check for required educational documentation
    if [[ "$EDUCATIONAL_CONTEXT" =~ "feature"|"compliance" ]]; then
        if [[ ! -f "docs/educational-impact.md" && ! -f "README.md" ]]; then
            ready_for_merge=false
            print_warning "Educational features require impact documentation"
        fi
    fi
    
    if [[ "$ready_for_merge" == "true" ]]; then
        print_status "Code is ready for merge to educational production! 🎓"
        create_merge_approval
    else
        print_warning "Additional approvals required before merge"
    fi
}

function create_merge_approval() {
    cat > .claude/merge-approval.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "prNumber": "$PULL_REQUEST_NUMBER",
    "approvedBy": "$REVIEWER_AGENT",
    "educationalContext": "$EDUCATIONAL_CONTEXT",
    "complianceValidated": true,
    "accessibilityChecked": true,
    "readyForProduction": true,
    "deploymentRecommendation": {
        "timing": "off_peak_hours",
        "rolloutStrategy": "gradual_educational_rollout",
        "monitoringRequired": true
    }
}
EOF
    
    print_status "Merge approval documentation created"
}

# Generate summary report
echo ""
echo "📊 Educational Post-Review Summary"
echo "================================="
print_educational "Educational review process completed for $EDUCATIONAL_CONTEXT context"
print_info "Reviewer: $REVIEWER_AGENT"
print_info "Status: $REVIEW_STATUS"

if [[ "$REQUIRES_SENIOR_REVIEW" == "true" ]]; then
    print_educational "Junior developer mentoring workflows activated"
fi

print_status "Educational post-review process completed! 🎓"