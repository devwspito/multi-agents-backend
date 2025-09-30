#!/bin/bash

# Educational Pre-Commit Hook
# Validates FERPA compliance, accessibility, and educational coding standards

set -e

echo "🎓 Running Educational Technology Pre-Commit Checks..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Track check results
FERPA_VIOLATIONS=0
ACCESSIBILITY_ISSUES=0
EDUCATIONAL_WARNINGS=0
TOTAL_ISSUES=0

# Function to print status messages
print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
    ((EDUCATIONAL_WARNINGS++))
}

print_error() {
    echo -e "${RED}✗${NC} $1"
    ((TOTAL_ISSUES++))
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Get list of modified files
MODIFIED_FILES=$(git diff --cached --name-only --diff-filter=ACM)

if [ -z "$MODIFIED_FILES" ]; then
    print_info "No files to check"
    exit 0
fi

print_info "Checking $(echo "$MODIFIED_FILES" | wc -l) modified files..."

# 1. FERPA Compliance Check
echo ""
echo "🔒 FERPA Compliance Validation"
echo "================================"

# Check for potential PII in code
PII_PATTERNS=(
    'student.*name'
    'student.*email'
    'student.*phone'
    'student.*ssn'
    'student.*social'
    'student.*address'
    'parent.*name'
    'parent.*email'
    '\.name\s*:'
    '\.email\s*:'
    '\.phone\s*:'
    'console\.log.*student\.'
    'logger\..*student\.'
    'alert.*student\.'
)

for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx|py|java|cs)$ ]]; then
        for pattern in "${PII_PATTERNS[@]}"; do
            if grep -iq "$pattern" "$file"; then
                print_error "Potential FERPA violation in $file: pattern '$pattern'"
                ((FERPA_VIOLATIONS++))
            fi
        done
    fi
done

# Check for proper student ID hashing
for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx)$ ]]; then
        # Look for unhashed student ID usage
        if grep -q "student\.id\|studentId\|student_id" "$file" && ! grep -q "hashStudentId\|hashedStudentId\|anonymizeId" "$file"; then
            print_warning "Potential unhashed student ID usage in $file - ensure proper anonymization"
        fi
    fi
done

if [ $FERPA_VIOLATIONS -eq 0 ]; then
    print_status "FERPA compliance check passed"
else
    print_error "Found $FERPA_VIOLATIONS potential FERPA violations"
fi

# 2. Accessibility Check
echo ""
echo "♿ Accessibility Standards Check"
echo "==============================="

# Check for accessibility violations in React/JSX files
ACCESSIBILITY_PATTERNS=(
    '<div.*onClick'  # Should use button instead
    '<img(?!.*alt)' # Images without alt text
    '<input(?!.*aria-label)(?!.*id.*<label)' # Inputs without labels
    '<button(?!.*aria-label)>.*</button>' # Buttons without labels
    'style={{.*color:.*}}' # Inline color styles (check for contrast)
    'onClick.*enter'  # Missing keyboard handlers
)

for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(jsx|tsx)$ ]]; then
        for pattern in "${ACCESSIBILITY_PATTERNS[@]}"; do
            if grep -q "$pattern" "$file"; then
                print_error "Accessibility issue in $file: pattern '$pattern'"
                ((ACCESSIBILITY_ISSUES++))
            fi
        done
        
        # Check for proper ARIA usage
        if grep -q "role=" "$file" && ! grep -q "aria-" "$file"; then
            print_warning "Found role attribute without ARIA labels in $file"
        fi
        
        # Check for educational context in components
        if grep -q "assignment\|grade\|course\|student" "$file" && ! grep -q "aria-label\|aria-describedby" "$file"; then
            print_warning "Educational component in $file may need accessibility improvements"
        fi
    fi
done

if [ $ACCESSIBILITY_ISSUES -eq 0 ]; then
    print_status "Accessibility check passed"
else
    print_error "Found $ACCESSIBILITY_ISSUES accessibility issues"
fi

# 3. Educational Coding Standards Check
echo ""
echo "📚 Educational Coding Standards"
echo "=============================="

# Check for educational context documentation
for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx)$ ]]; then
        # Check if educational functions have proper documentation
        if grep -q "function.*grade\|function.*student\|function.*course\|class.*Grade\|class.*Student\|class.*Course" "$file"; then
            if ! grep -q "@param\|@returns\|\/\*\*" "$file"; then
                print_warning "Educational function in $file missing documentation"
            fi
        fi
        
        # Check for educational error handling
        if grep -q "catch.*error\|throw new Error" "$file" && ! grep -q "EducationalError\|FERPAError\|AccessibilityError" "$file"; then
            print_warning "Consider using educational-specific error types in $file"
        fi
    fi
done

# 4. Performance Check for Educational Loads
echo ""
echo "⚡ Educational Performance Standards"
echo "=================================="

for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx)$ ]]; then
        # Check for potential performance issues in educational contexts
        if grep -q "\.map.*student\|\.filter.*student\|\.forEach.*student" "$file" && ! grep -q "useMemo\|useCallback\|React\.memo" "$file"; then
            print_warning "Consider performance optimization for student data processing in $file"
        fi
        
        # Check for proper loading states in educational UI
        if grep -q "fetch.*api.*student\|axios.*student\|api.*grade" "$file" && ! grep -q "loading\|isLoading\|pending" "$file"; then
            print_warning "API calls in $file should include loading states for educational UX"
        fi
    fi
done

# 5. Test Coverage Check
echo ""
echo "🧪 Educational Test Coverage"
echo "==========================="

for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx)$ ]] && [[ ! "$file" =~ \.test\.|\.spec\. ]]; then
        # Check if corresponding test file exists
        test_file1="${file%.*}.test.${file##*.}"
        test_file2="${file%.*}.spec.${file##*.}"
        test_file3="${file%/*}/__tests__/${file##*/}"
        
        if [[ ! -f "$test_file1" && ! -f "$test_file2" && ! -f "$test_file3" ]]; then
            # Check if this is an educational component that needs testing
            if grep -q "export.*function\|export.*class\|export default" "$file"; then
                print_warning "No test file found for $file - educational components require tests"
            fi
        fi
    fi
done

# 6. Educational Documentation Check
echo ""
echo "📖 Educational Documentation Standards"
echo "====================================="

for file in $MODIFIED_FILES; do
    if [[ "$file" =~ \.(js|jsx|ts|tsx)$ ]]; then
        # Check for learning objectives in educational components
        if grep -q "Assignment\|Grade\|Course\|Student.*Component\|Student.*Page" "$file"; then
            if ! grep -q "Learning.*Objective\|Educational.*Purpose\|Student.*Impact" "$file"; then
                print_warning "Educational component in $file should document learning objectives"
            fi
        fi
    fi
done

# 7. Run automated accessibility tests if available
if command -v npx >/dev/null 2>&1; then
    echo ""
    echo "🤖 Automated Accessibility Testing"
    echo "================================="
    
    # Run axe-core if available
    if [ -f "package.json" ] && grep -q "axe-core" "package.json"; then
        print_info "Running automated accessibility tests..."
        if npx jest --testNamePattern="accessibility" --silent 2>/dev/null; then
            print_status "Automated accessibility tests passed"
        else
            print_warning "Automated accessibility tests failed or not found"
        fi
    fi
fi

# Final Results
echo ""
echo "📊 Educational Quality Check Summary"
echo "=================================="

if [ $TOTAL_ISSUES -eq 0 ]; then
    print_status "All educational quality checks passed! ✨"
    print_info "FERPA violations: $FERPA_VIOLATIONS"
    print_info "Accessibility issues: $ACCESSIBILITY_ISSUES"  
    print_info "Educational warnings: $EDUCATIONAL_WARNINGS"
    
    if [ $EDUCATIONAL_WARNINGS -gt 0 ]; then
        echo ""
        print_info "Consider addressing the $EDUCATIONAL_WARNINGS warnings for better educational technology standards"
    fi
    
    echo ""
    print_status "🎓 Educational technology standards maintained!"
    print_status "Ready to improve student learning outcomes! 🚀"
    
    exit 0
else
    echo ""
    print_error "❌ Educational quality check failed!"
    print_error "Critical issues found: $TOTAL_ISSUES"
    print_error "FERPA violations: $FERPA_VIOLATIONS"
    print_error "Accessibility issues: $ACCESSIBILITY_ISSUES"
    
    echo ""
    print_error "🛑 Commit blocked for educational compliance"
    print_info "Fix the issues above and try committing again"
    print_info "Remember: Student data protection and accessibility are not optional!"
    
    exit 1
fi