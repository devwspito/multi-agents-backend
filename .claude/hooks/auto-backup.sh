#!/bin/bash
# Auto-backup hook - Backup files before editing
# Prevents data loss by creating timestamped backups

set -e

# Read hook input
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
    exit 0
fi

# Only backup if file exists
if [[ ! -f "$file_path" ]]; then
    exit 0
fi

# Create backup directory if it doesn't exist
backup_dir="$CLAUDE_PROJECT_DIR/.claude/backups"
mkdir -p "$backup_dir"

# Generate timestamped backup filename
timestamp=$(date +%Y%m%d_%H%M%S)
filename=$(basename "$file_path")
backup_path="$backup_dir/${filename}.${timestamp}.bak"

# Create backup
cp "$file_path" "$backup_path" 2>/dev/null || {
    echo "⚠️  Failed to create backup for $file_path" >&2
    exit 0  # Don't block edit if backup fails
}

echo "✅ Backup created: $backup_path"

# Cleanup old backups (keep last 10 per file)
file_backups=$(ls -t "$backup_dir/${filename}".*.bak 2>/dev/null | tail -n +11)
if [[ -n "$file_backups" ]]; then
    echo "$file_backups" | xargs rm -f
    echo "🗑️  Cleaned up old backups"
fi

exit 0
