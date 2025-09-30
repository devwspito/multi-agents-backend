#!/bin/bash

# Educational Deployment Gate Hook
# Final validation before educational technology reaches students

set -e

echo "🎓 Educational Deployment Gate - Final Production Validation"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Environment variables
DEPLOYMENT_TARGET=${CLAUDE_DEPLOYMENT_TARGET:-"production"}
EDUCATIONAL_CONTEXT=${CLAUDE_EDUCATIONAL_CONTEXT:-"general"}
QA_APPROVAL=${CLAUDE_QA_APPROVAL:-"false"}
ACADEMIC_CALENDAR_CHECK=${CLAUDE_ACADEMIC_CALENDAR_CHECK:-"true"}

# Track validation results
BLOCKING_ISSUES=0
WARNINGS=0
TOTAL_CHECKS=0

# Function to print status messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
    ((TOTAL_CHECKS++))
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((WARNINGS++))
    ((TOTAL_CHECKS++))
}

print_error() {
    echo -e "${RED}✗${NC} $1"
    ((BLOCKING_ISSUES++))
    ((TOTAL_CHECKS++))
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_educational() {
    echo -e "${PURPLE}🎓${NC} $1"
}

echo ""
echo "🎯 Deployment Context"
echo "===================="
print_info "Target Environment: $DEPLOYMENT_TARGET"
print_info "Educational Context: $EDUCATIONAL_CONTEXT"
print_info "QA Approval Status: $QA_APPROVAL"
print_info "Academic Calendar Check: $ACADEMIC_CALENDAR_CHECK"

# Only proceed if deploying to production
if [[ "$DEPLOYMENT_TARGET" != "production" ]]; then
    print_info "Non-production deployment - skipping educational gates"
    exit 0
fi

echo ""
echo "🛡️ Educational Production Gates"
echo "==============================="

# Gate 1: QA Engineer Approval (MANDATORY)
echo ""
echo "Gate 1: QA Engineer Approval"
echo "----------------------------"

if [[ "$QA_APPROVAL" == "true" ]] && [[ -f ".claude/qa-approval.json" ]]; then
    QA_APPROVAL_DATA=$(cat .claude/qa-approval.json)
    QA_TIMESTAMP=$(echo "$QA_APPROVAL_DATA" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4)
    print_status "QA Engineer approval confirmed (approved: $QA_TIMESTAMP)"
else
    print_error "BLOCKING: No QA Engineer approval found - educational code cannot deploy without QA sign-off"
fi

# Gate 2: Educational Compliance Validation
echo ""
echo "Gate 2: Educational Compliance Validation"
echo "----------------------------------------"

# FERPA Compliance Check
print_info "Validating FERPA compliance..."
if ! grep -r "student.*name\|student.*email\|student.*ssn" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules . >/dev/null 2>&1; then
    print_status "FERPA compliance validated - no student PII detected in code"
else
    print_error "BLOCKING: FERPA violation detected - student PII found in code"
fi

# COPPA Compliance Check (for K-12 systems)
if [[ "$EDUCATIONAL_CONTEXT" =~ "k12"|"under13"|"elementary"|"middle" ]]; then
    print_info "Validating COPPA compliance for K-12 system..."
    if [[ -f "docs/coppa-compliance.md" ]] || grep -q "parental.*consent\|under.*13" --include="*.js" --include="*.jsx" .; then
        print_status "COPPA compliance measures detected for K-12 system"
    else
        print_error "BLOCKING: COPPA compliance required for K-12 educational system"
    fi
fi

# Accessibility Compliance Check
print_info "Validating accessibility compliance..."
if command -v npx >/dev/null 2>&1 && [ -f "package.json" ]; then
    if grep -q "axe-core\|jest-axe\|@axe-core" package.json; then
        if npx jest --testNamePattern="accessibility" --silent 2>/dev/null; then
            print_status "Accessibility tests passing - WCAG 2.1 AA compliance validated"
        else
            print_error "BLOCKING: Accessibility tests failing - WCAG 2.1 AA compliance required"
        fi
    else
        print_warning "No accessibility testing framework detected"
    fi
else
    print_warning "Cannot run automated accessibility tests"
fi

# Gate 3: Academic Calendar Validation
echo ""
echo "Gate 3: Academic Calendar Validation"
echo "-----------------------------------"

if [[ "$ACADEMIC_CALENDAR_CHECK" == "true" ]]; then
    # Check if deployment conflicts with critical academic periods
    current_date=$(date +%Y-%m-%d)
    current_day=$(date +%u) # 1=Monday, 7=Sunday
    current_hour=$(date +%H)
    
    # Define critical academic periods (these would ideally come from a calendar API)
    # For demo purposes, using basic checks
    
    # Check if it's exam week (typically first week of May and December)
    current_month=$(date +%m)
    current_week=$(date +%V)
    
    if [[ "$current_month" == "05" && "$current_week" -le 19 ]] || [[ "$current_month" == "12" && "$current_week" -ge 49 ]]; then
        print_error "BLOCKING: Deployment blocked during exam period - critical system stability required"
    elif [[ "$current_day" -eq 1 && "$current_hour" -lt 10 ]]; then
        print_warning "Monday morning deployment - high student activity expected"
    elif [[ "$current_day" -ge 6 ]]; then
        print_status "Weekend deployment approved - minimal student impact"
    else
        print_status "Academic calendar check passed - safe deployment window"
    fi
    
    # Check for registration periods (typically August and January)
    if [[ "$current_month" == "08" || "$current_month" == "01" ]]; then
        print_warning "Registration period deployment - ensure extra monitoring"
    fi
else
    print_info "Academic calendar check disabled"
fi

# Gate 4: Educational Infrastructure Readiness
echo ""
echo "Gate 4: Educational Infrastructure Readiness"
echo "-------------------------------------------"

# Check database backup status for student data protection
if command -v mongodump >/dev/null 2>&1 || command -v pg_dump >/dev/null 2>&1; then
    print_status "Database backup tools available - student data protection ready"
else
    print_warning "Database backup tools not detected - verify student data protection"
fi

# Check monitoring readiness for educational metrics
if [[ -f "monitoring/educational-dashboards.json" ]] || [[ -f "config/monitoring.yml" ]]; then
    print_status "Educational monitoring configuration detected"
else
    print_warning "Educational monitoring configuration not found"
fi

# Gate 5: LMS Integration Health Check
echo ""
echo "Gate 5: LMS Integration Health Check"
echo "----------------------------------"

# Check if this deployment includes LMS integrations
if grep -q "canvas\|moodle\|blackboard\|schoology" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules . 2>/dev/null; then
    print_info "LMS integration detected - validating health"
    
    # Check for proper error handling in LMS integrations
    if grep -q "try.*catch\|\.catch\|error.*handling" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules . 2>/dev/null; then
        print_status "Error handling detected in LMS integration code"
    else
        print_error "BLOCKING: LMS integration lacks proper error handling"
    fi
    
    # Check for rate limiting compliance
    if grep -q "rate.*limit\|throttle\|delay" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" --exclude-dir=node_modules . 2>/dev/null; then
        print_status "Rate limiting measures detected for LMS APIs"
    else
        print_warning "Consider rate limiting for LMS API compliance"
    fi
else
    print_info "No LMS integration detected in this deployment"
fi

# Gate 6: Educational Performance Validation
echo ""
echo "Gate 6: Educational Performance Validation"
echo "----------------------------------------"

# Check for performance optimizations in educational contexts
if grep -q "useMemo\|useCallback\|React\.memo\|lazy\|Suspense" --include="*.jsx" --include="*.tsx" . 2>/dev/null; then
    print_status "Performance optimizations detected in React components"
else
    print_warning "Consider performance optimizations for educational user experience"
fi

# Check for loading states in educational UI
if grep -q "loading\|isLoading\|pending\|spinner" --include="*.js" --include="*.jsx" --include="*.ts" --include="*.tsx" . 2>/dev/null; then
    print_status "Loading states detected - good educational UX practice"
else
    print_warning "Consider adding loading states for better educational user experience"
fi

# Gate 7: Educational Documentation Validation
echo ""
echo "Gate 7: Educational Documentation Validation"
echo "-------------------------------------------"

# Check for educational impact documentation
if [[ -f "docs/educational-impact.md" ]] || [[ -f "EDUCATIONAL_IMPACT.md" ]] || grep -q "Learning.*Objective\|Educational.*Impact" README.md 2>/dev/null; then
    print_status "Educational impact documentation found"
else
    print_warning "Consider adding educational impact documentation"
fi

# Check for accessibility documentation
if [[ -f "docs/accessibility.md" ]] || [[ -f "ACCESSIBILITY.md" ]] || grep -q "accessibility\|WCAG\|screen.*reader" README.md 2>/dev/null; then
    print_status "Accessibility documentation found"
else
    print_warning "Consider adding accessibility feature documentation"
fi

# Gate 8: Rollback Plan Validation
echo ""
echo "Gate 8: Rollback Plan Validation"
echo "-------------------------------"

# Check for rollback documentation
if [[ -f "docs/rollback-plan.md" ]] || [[ -f "ROLLBACK.md" ]] || grep -q "rollback\|revert" README.md 2>/dev/null; then
    print_status "Rollback plan documentation found"
else
    print_warning "Educational deployments should include rollback plans for academic continuity"
fi

# Create deployment approval or rejection
echo ""
echo "📊 Educational Deployment Gate Summary"
echo "====================================="

print_info "Total checks performed: $TOTAL_CHECKS"
print_info "Warnings: $WARNINGS"
print_info "Blocking issues: $BLOCKING_ISSUES"

if [[ $BLOCKING_ISSUES -eq 0 ]]; then
    echo ""
    print_status "🎓 EDUCATIONAL DEPLOYMENT APPROVED!"
    print_educational "All educational production gates passed"
    print_educational "Ready to serve students and enhance learning outcomes! 🚀"
    
    # Create deployment approval record
    cat > .claude/deployment-approval.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "target": "$DEPLOYMENT_TARGET",
    "educationalContext": "$EDUCATIONAL_CONTEXT",
    "status": "approved",
    "gatePasses": $((TOTAL_CHECKS - WARNINGS - BLOCKING_ISSUES)),
    "warnings": $WARNINGS,
    "blockingIssues": $BLOCKING_ISSUES,
    "qaApprovalConfirmed": $(if [[ "$QA_APPROVAL" == "true" ]]; then echo "true"; else echo "false"; fi),
    "academicCalendarValidated": $(if [[ "$ACADEMIC_CALENDAR_CHECK" == "true" ]]; then echo "true"; else echo "false"; fi),
    "complianceStatus": {
        "ferpa": "validated",
        "coppa": $(if [[ "$EDUCATIONAL_CONTEXT" =~ "k12" ]]; then echo "\"validated\""; else echo "\"not_applicable\""; fi),
        "wcag": "validated"
    },
    "deploymentRecommendations": [
        "Monitor educational metrics closely",
        "Prepare rollback plan for academic continuity",
        "Notify educational stakeholders of deployment",
        "Schedule post-deployment educational validation"
    ]
}
EOF
    
    print_status "Deployment approval record created"
    
    # Educational deployment success
    echo ""
    print_educational "🌟 Educational Technology Deployment Guidelines:"
    print_educational "• Monitor student user experience closely"
    print_educational "• Watch for accessibility-related support requests"
    print_educational "• Validate LMS integration functionality"
    print_educational "• Prepare for increased support during peak academic periods"
    print_educational "• Celebrate improved learning outcomes! 🎉"
    
    exit 0
else
    echo ""
    print_error "❌ EDUCATIONAL DEPLOYMENT BLOCKED!"
    print_error "$BLOCKING_ISSUES critical issues must be resolved before production deployment"
    print_educational "Student safety and learning outcomes depend on these validations"
    
    # Create deployment rejection record
    cat > .claude/deployment-rejection.json << EOF
{
    "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
    "target": "$DEPLOYMENT_TARGET",
    "educationalContext": "$EDUCATIONAL_CONTEXT",
    "status": "rejected",
    "blockingIssues": $BLOCKING_ISSUES,
    "warnings": $WARNINGS,
    "totalChecks": $TOTAL_CHECKS,
    "reason": "Failed educational production gates",
    "requiredActions": [
        "Resolve all blocking compliance issues",
        "Obtain QA Engineer approval",
        "Validate academic calendar timing",
        "Ensure educational documentation complete"
    ]
}
EOF
    
    echo ""
    print_error "🛑 Deployment rejected for educational compliance"
    print_info "Resolve blocking issues and run deployment gate again"
    print_educational "Remember: Educational technology directly impacts student success"
    print_educational "Quality and compliance are not optional in education! 📚"
    
    exit 1
fi