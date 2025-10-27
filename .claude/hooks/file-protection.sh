#!/bin/bash
# File protection hook - Prevents editing critical system files

set -e

# Read hook input
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
    exit 0
fi

# Protected system directories
PROTECTED_DIRS=(
    "/etc/*"
    "/usr/bin/*"
    "/usr/sbin/*"
    "/bin/*"
    "/sbin/*"
    "/System/*"
    "*/node_modules/*"
)

# Protected file patterns
PROTECTED_PATTERNS=(
    "*.production.*"
    "*prod*config*"
    "*.env.production"
    ".env.prod"
    "*credentials*"
    "*.key"
    "*.pem"
    "id_rsa*"
    "id_ed25519*"
)

# Check against protected directories
for pattern in "${PROTECTED_DIRS[@]}"; do
    if [[ "$file_path" == $pattern ]]; then
        echo "🚨 BLOCKED: Cannot modify protected system file" >&2
        echo "File: $file_path" >&2
        echo "Reason: Matches protected pattern: $pattern" >&2
        exit 2  # Block the operation
    fi
done

# Check against protected patterns
for pattern in "${PROTECTED_PATTERNS[@]}"; do
    if [[ "$file_path" == *$pattern* ]]; then
        echo "⚠️  WARNING: Attempting to modify sensitive file" >&2
        echo "File: $file_path" >&2
        echo "Pattern: $pattern" >&2
        echo "Requesting manual approval..." >&2

        # Ask for confirmation instead of blocking completely
        # (Claude will see this and ask the user)
        output=$(cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "ask",
    "permissionDecisionReason": "⚠️ Sensitive file detected: $file_path matches pattern $pattern. Confirm this operation is safe."
  }
}
EOF
)
        echo "$output"
        exit 0
    fi
done

# All checks passed
echo "✅ File protection check passed"
exit 0
