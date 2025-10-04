#!/bin/bash
# Render Build Script - Installs dependencies and Claude Code CLI

set -e  # Exit on error

echo "📦 Installing npm dependencies..."
npm install

echo "🤖 Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

echo "✅ Verifying Claude Code installation..."
claude --version || echo "⚠️ Claude Code installed but not in PATH"

echo "🏗️ Build completed successfully"
