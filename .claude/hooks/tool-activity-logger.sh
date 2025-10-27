#!/bin/bash
# Tool activity logger - Audit trail for all tool usage
# Helps debug issues and track agent behavior

set -e

# Read hook input
input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // "unknown"')
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# Create logs directory if it doesn't exist
log_dir="$CLAUDE_PROJECT_DIR/.claude/logs"
mkdir -p "$log_dir"

# Log file path
log_file="$log_dir/activity.log"

# Format timestamp
timestamp=$(date '+%Y-%m-%d %H:%M:%S')

# Log entry
if [[ -n "$file_path" ]]; then
    echo "[$timestamp] Tool: $tool_name | File: $file_path" >> "$log_file"
else
    echo "[$timestamp] Tool: $tool_name" >> "$log_file"
fi

# Optional: Log rotation (keep last 1000 lines)
if [[ $(wc -l < "$log_file") -gt 1000 ]]; then
    tail -n 1000 "$log_file" > "$log_file.tmp"
    mv "$log_file.tmp" "$log_file"
fi

exit 0
