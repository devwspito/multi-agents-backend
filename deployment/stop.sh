#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Stop Services
# ============================================================================
# Usage: ./deployment/stop.sh [--clean]
#
# Options:
#   --clean  Remove containers and networks (keeps volumes/data)
# ============================================================================

cd "$(dirname "$0")/.."

echo "🛑 Stopping Multi-Agent Platform..."

if [ "$1" = "--clean" ]; then
  echo "   Removing containers and networks..."
  docker compose -f docker-compose.prod.yml down
else
  docker compose -f docker-compose.prod.yml stop
fi

echo ""
echo "✅ Services stopped"
echo ""
echo "Data is preserved at /mnt/data"
echo "To restart: ./deployment/start.sh"
