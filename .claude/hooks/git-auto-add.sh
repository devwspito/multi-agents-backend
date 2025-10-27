#!/bin/bash
# Git auto-add hook - Automatically stage files after edits
# Improves git workflow by auto-staging modified files

set -e

# Read hook input
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
    exit 0
fi

# Check if we're in a git repository
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    # Not a git repo, exit silently
    exit 0
fi

# Check if file exists and is tracked by git
if [[ ! -f "$file_path" ]]; then
    exit 0
fi

# Auto-add the file to staging area
if git add "$file_path" 2>/dev/null; then
    echo "✅ Git: Staged $file_path"
else
    # If git add fails, don't block the operation
    exit 0
fi

# Show current git status (brief)
changed_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
if [[ "$changed_files" -gt 0 ]]; then
    echo "📊 Git: $changed_files file(s) staged for commit"
fi

exit 0
