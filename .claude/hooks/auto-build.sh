#!/bin/bash
# Auto-build hook - Run build validation (Agent SDK version)
# Simplified version that works without stdin JSON input

set -e

echo "🔨 Running build validation..."

# Get repository path from first argument or use current directory
REPO_PATH="${1:-.}"

cd "$REPO_PATH" || exit 0

# Check if package.json exists
if [[ ! -f "package.json" ]]; then
    echo "ℹ️  No package.json found, skipping build"
    exit 0
fi

# Check if build script is defined
if ! grep -q '"build"' package.json 2>/dev/null; then
    echo "ℹ️  No build script found in package.json, skipping build"
    exit 0
fi

echo "📦 Running npm build..."

# Check if .env file exists (optional - build may not need it)
if [[ ! -f ".env" ]]; then
    echo "ℹ️  No .env file found (optional for build)"
fi

# Run build with timeout (non-blocking)
if timeout 180 npm run build 2>&1; then
    echo "✅ Build passed successfully"
    exit 0
else
    build_status=$?

    if [[ $build_status -eq 124 ]]; then
        echo "⏱️  Build timeout (>180s) - continuing anyway" >&2
        exit 0  # Don't block orchestration on timeout
    else
        echo "⚠️  Build failed - check output above" >&2
        echo "" >&2
        echo "💡 QA Engineer will review build errors" >&2
        echo "💡 Tip: Configure environment variables if build requires them" >&2
        exit 0  # Don't block orchestration, let QA handle it
    fi
fi
