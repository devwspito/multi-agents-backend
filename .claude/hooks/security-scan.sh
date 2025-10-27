#!/bin/bash
# Security scan hook - Basic security checks (Agent SDK version)
# Simplified version that works without stdin JSON input

set -e

echo "🔒 Running security scan..."

# Get repository path from first argument or use current directory
REPO_PATH="${1:-.}"

cd "$REPO_PATH" || exit 0

FINDINGS=0

# 1. Check for hardcoded secrets (basic patterns)
echo "🔍 Checking for hardcoded secrets..."
if grep -rn --include="*.js" --include="*.ts" --include="*.jsx" --include="*.tsx" \
    -E "(password|secret|api[_-]?key|token|private[_-]?key)\s*=\s*['\"]" . 2>/dev/null | head -5; then
    echo "⚠️  Found potential hardcoded secrets"
    FINDINGS=$((FINDINGS + 1))
fi

# 2. Check for exposed .env files
echo "🔍 Checking for exposed .env files..."
if find . -name ".env" -type f 2>/dev/null | grep -v node_modules | head -5; then
    echo "⚠️  Found .env files (ensure they're in .gitignore)"
    FINDINGS=$((FINDINGS + 1))
fi

# 3. Check package.json for known vulnerable dependencies (if npm available)
if [[ -f "package.json" ]] && command -v npm &> /dev/null; then
    echo "🔍 Checking npm dependencies for vulnerabilities..."
    if timeout 60 npm audit --production 2>&1 | grep -E "(high|critical)" | head -10; then
        echo "⚠️  Found high/critical vulnerabilities in dependencies"
        FINDINGS=$((FINDINGS + 1))
    fi
fi

# 4. Check for eval() usage (security risk)
echo "🔍 Checking for dangerous eval() usage..."
if grep -rn --include="*.js" --include="*.ts" \
    -E "eval\s*\(" . 2>/dev/null | grep -v node_modules | head -5; then
    echo "⚠️  Found eval() usage (potential security risk)"
    FINDINGS=$((FINDINGS + 1))
fi

# Summary
echo ""
if [[ $FINDINGS -eq 0 ]]; then
    echo "✅ No security issues found"
    exit 0
else
    echo "⚠️  Found $FINDINGS potential security issue(s)"
    echo "💡 Review findings above and address before deployment"
    exit 0  # Don't block orchestration, just inform
fi
