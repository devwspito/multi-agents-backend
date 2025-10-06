#!/usr/bin/env bash
# Build script for Render to install Claude Code

echo "🚀 Starting Render build with Claude Code installation..."

# Install dependencies
npm install

# Try to install Claude Code globally
echo "📦 Attempting to install Claude Code..."
npm install -g @anthropic-ai/claude-code || {
    echo "⚠️ Global install failed, trying local..."
    npm install @anthropic-ai/claude-code
}

# Check if Claude Code is available
if command -v claude &> /dev/null; then
    echo "✅ Claude Code installed successfully!"
    claude --version
else
    echo "❌ Claude Code installation failed"

    # Try alternative: download binary directly
    echo "🔄 Attempting direct binary download..."
    curl -o /tmp/claude https://claude-code-binary-url.com/claude
    chmod +x /tmp/claude
    export PATH="/tmp:$PATH"
fi

echo "🏁 Build completed"