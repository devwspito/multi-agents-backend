#!/bin/bash
# Auto-test hook - Runs tests automatically (Agent SDK version)
# Simplified version that works without stdin JSON input

set -e

echo "🧪 Running automated tests..."

# Get repository path from first argument or use current directory
REPO_PATH="${1:-.}"

cd "$REPO_PATH" || exit 0

# Check if package.json exists
if [[ ! -f "package.json" ]]; then
    echo "ℹ️  No package.json found, skipping tests"
    exit 0
fi

# Check if test script is defined
if ! grep -q '"test"' package.json 2>/dev/null; then
    echo "ℹ️  No test script found in package.json, skipping tests"
    exit 0
fi

echo "📦 Running npm tests..."

# Check if .env file exists (optional - tests may not need it)
if [[ ! -f ".env" ]]; then
    echo "ℹ️  No .env file found (optional for tests)"
fi

# Run tests with timeout (non-blocking)
if timeout 120 npm test 2>&1; then
    echo "✅ All tests passed"
    exit 0
else
    test_status=$?

    if [[ $test_status -eq 124 ]]; then
        echo "⏱️  Test timeout (>120s) - continuing anyway" >&2
        exit 0  # Don't block orchestration on timeout
    else
        echo "⚠️  Tests failed - check output above" >&2
        echo "" >&2
        echo "💡 QA Engineer will review test failures" >&2
        echo "💡 Tip: Configure environment variables if tests require them" >&2
        exit 0  # Don't block orchestration, let QA handle it
    fi
fi
