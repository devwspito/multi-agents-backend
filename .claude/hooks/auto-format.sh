#!/bin/bash
# Auto-format hook - Formats code after editing

set -e

# Read hook input
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]] || [[ ! -f "$file_path" ]]; then
    exit 0
fi

echo "🔧 Formatting $file_path..."

# Format based on file extension
case "$file_path" in
    *.js|*.jsx|*.ts|*.tsx)
        if command -v prettier >/dev/null 2>&1; then
            prettier --write "$file_path" 2>/dev/null || {
                echo "⚠️  Prettier formatting failed, continuing anyway"
                exit 0
            }
            echo "✅ Formatted with Prettier"
        else
            echo "ℹ️  Prettier not installed, skipping JS/TS formatting"
        fi
        ;;
    *.py)
        if command -v black >/dev/null 2>&1; then
            black "$file_path" 2>/dev/null || {
                echo "⚠️  Black formatting failed, continuing anyway"
                exit 0
            }
            echo "✅ Formatted with Black"
        else
            echo "ℹ️  Black not installed, skipping Python formatting"
        fi
        ;;
    *.go)
        if command -v gofmt >/dev/null 2>&1; then
            gofmt -w "$file_path" 2>/dev/null || {
                echo "⚠️  gofmt formatting failed, continuing anyway"
                exit 0
            }
            echo "✅ Formatted with gofmt"
        else
            echo "ℹ️  gofmt not installed, skipping Go formatting"
        fi
        ;;
    *.rs)
        if command -v rustfmt >/dev/null 2>&1; then
            rustfmt "$file_path" 2>/dev/null || {
                echo "⚠️  rustfmt formatting failed, continuing anyway"
                exit 0
            }
            echo "✅ Formatted with rustfmt"
        else
            echo "ℹ️  rustfmt not installed, skipping Rust formatting"
        fi
        ;;
    *)
        # Not a formattable file type
        exit 0
        ;;
esac

exit 0
