#!/bin/bash
# Render Build Script - Installs dependencies including Claude Code CLI

set -e  # Exit on error

echo "📦 Installing npm dependencies (includes Claude Code CLI)..."
npm install

echo "✅ Verifying Claude Code installation..."
npx claude --version || echo "⚠️ Claude Code installed but verification failed"

echo "🏗️ Build completed successfully"
