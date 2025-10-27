#!/bin/bash
# Load task context hook - Loads orchestration state on session start

set -e

# Read hook input
input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // empty')
source=$(echo "$input" | jq -r '.source // "startup"')

echo "🚀 Loading task context for session: $session_id (source: $source)..."

# Try to find associated task from backend
BACKEND_URL="${BACKEND_URL:-http://localhost:4000}"

# Check if backend is running
if ! curl -s -f "$BACKEND_URL/health" >/dev/null 2>&1; then
    echo "ℹ️  Backend not running, skipping task context loading"
    exit 0
fi

# Try to find task by various methods
task_data=""

# Method 1: Find most recent in_progress task
task_data=$(curl -s "$BACKEND_URL/api/tasks?status=in_progress&limit=1&sort=-updatedAt" 2>/dev/null || echo "")

if [[ -z "$task_data" ]] || [[ "$task_data" == "[]" ]]; then
    # Method 2: Find most recent task overall
    task_data=$(curl -s "$BACKEND_URL/api/tasks?limit=1&sort=-updatedAt" 2>/dev/null || echo "")
fi

if [[ -z "$task_data" ]] || [[ "$task_data" == "[]" ]]; then
    echo "ℹ️  No active tasks found"
    exit 0
fi

# Extract task info
task_id=$(echo "$task_data" | jq -r '.[0]._id // empty' 2>/dev/null)
task_status=$(echo "$task_data" | jq -r '.[0].status // empty' 2>/dev/null)
current_phase=$(echo "$task_data" | jq -r '.[0].orchestration.currentPhase // empty' 2>/dev/null)

if [[ -z "$task_id" ]]; then
    echo "ℹ️  Could not parse task data"
    exit 0
fi

# Build context output
echo ""
echo "## 📋 Current Task Context"
echo ""
echo "**Task ID:** \`$task_id\`"
echo "**Status:** $task_status"
echo "**Current Phase:** $current_phase"
echo ""

# Show epic information if available
epics=$(echo "$task_data" | jq -r '.[0].orchestration.projectManagerResult.epics[]? | "- [\(.id)] \(.title) (repo: \(.targetRepository))"' 2>/dev/null)
if [[ -n "$epics" ]]; then
    echo "## 📦 Epics"
    echo ""
    echo "$epics"
    echo ""
fi

# Show current team orchestration state
team_state=$(echo "$task_data" | jq -r '.[0].orchestration.teamOrchestration.currentEpicIndex // 0' 2>/dev/null)
total_epics=$(echo "$task_data" | jq -r '.[0].orchestration.projectManagerResult.epics | length // 0' 2>/dev/null)

if [[ "$total_epics" -gt 0 ]]; then
    echo "## 🎯 Progress"
    echo ""
    echo "Epic: $((team_state + 1)) of $total_epics"
    echo ""
fi

# Show last error if exists
last_error=$(echo "$task_data" | jq -r '.[0].orchestration.error // empty' 2>/dev/null)
if [[ -n "$last_error" ]]; then
    echo "## ⚠️ Last Error"
    echo ""
    echo "\`\`\`"
    echo "$last_error"
    echo "\`\`\`"
    echo ""
fi

# Show git status
if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "## 📂 Git Status"
    echo ""
    echo "**Branch:** \`$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')\`"
    echo "**Last commit:** \`$(git log -1 --pretty=format:'%h - %s' 2>/dev/null || echo 'no commits')\`"
    echo ""

    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        echo "**Modified files:**"
        git diff --name-only HEAD 2>/dev/null | head -10 | sed 's/^/  - /' || echo "  - (unable to detect)"
        echo ""
    fi
fi

echo "✅ Task context loaded successfully"

exit 0
