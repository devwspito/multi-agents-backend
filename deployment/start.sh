#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Start Services
# ============================================================================
# Usage: ./deployment/start.sh [--build] [--logs]
#
# Options:
#   --build  Force rebuild of Docker image
#   --logs   Attach to logs after starting
# ============================================================================

set -e

# Change to project root
cd "$(dirname "$0")/.."

echo "🚀 Starting Multi-Agent Platform..."

# Parse arguments
BUILD=""
LOGS=""
for arg in "$@"; do
  case $arg in
    --build)
      BUILD="--build"
      ;;
    --logs)
      LOGS="true"
      ;;
  esac
done

# Check if .env exists
if [ ! -f ".env" ]; then
  if [ -f ".env.production.template" ]; then
    echo "⚠️  No .env file found. Creating from template..."
    cp .env.production.template .env
    echo "   Please edit .env with client-specific values before continuing."
    exit 1
  else
    echo "❌ No .env file found and no template available."
    echo "   Create .env with required environment variables."
    exit 1
  fi
fi

# Check required environment variables
source .env
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "❌ ANTHROPIC_API_KEY is not set in .env"
  exit 1
fi

if [ -z "$JWT_SECRET" ]; then
  echo "❌ JWT_SECRET is not set in .env"
  exit 1
fi

# Start services
echo "   Using docker-compose.prod.yml..."
docker compose -f docker-compose.prod.yml up -d $BUILD

# Wait for services to be ready
echo ""
echo "⏳ Waiting for services to be ready..."
sleep 5

# Check health
HEALTH_STATUS=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"error"}')
if echo "$HEALTH_STATUS" | grep -q '"status":"ok"'; then
  echo "✅ Backend is healthy"
else
  echo "⚠️  Backend might not be ready yet. Check logs with: docker logs agents-backend"
fi

# Show status
echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                     Multi-Agent Platform Started                             ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "🌐 API: http://localhost:3001"
echo "📊 Health: http://localhost:3001/api/health"
echo ""

# Attach to logs if requested
if [ "$LOGS" = "true" ]; then
  echo "📋 Attaching to logs (Ctrl+C to exit)..."
  docker compose -f docker-compose.prod.yml logs -f
fi
