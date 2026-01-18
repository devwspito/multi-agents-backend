#!/bin/bash
# ============================================================================
# Multi-Agent Platform - ONE-COMMAND DEPLOYMENT
# ============================================================================
# Deploy a new client VM with a single command!
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/<org>/agents-software-arq/main/deployment/deploy.sh | sudo bash -s -- \
#     --anthropic-key "sk-ant-xxx" \
#     --github-client-id "xxx" \
#     --github-client-secret "xxx"
#
# Or locally:
#   sudo ./deploy.sh --anthropic-key "sk-ant-xxx" ...
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Defaults
APP_DIR="/app"
MOUNT_POINT="/mnt/data"
DISK_DEVICE="/dev/sdb"
REPO_URL="https://github.com/<org>/agents-software-arq.git"  # UPDATE THIS

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --anthropic-key)
      ANTHROPIC_API_KEY="$2"
      shift 2
      ;;
    --github-client-id)
      GITHUB_CLIENT_ID="$2"
      shift 2
      ;;
    --github-client-secret)
      GITHUB_CLIENT_SECRET="$2"
      shift 2
      ;;
    --github-app-id)
      GITHUB_APP_ID="$2"
      shift 2
      ;;
    --github-private-key)
      GITHUB_PRIVATE_KEY="$2"
      shift 2
      ;;
    --github-installation-id)
      GITHUB_INSTALLATION_ID="$2"
      shift 2
      ;;
    --voyage-key)
      VOYAGE_API_KEY="$2"
      shift 2
      ;;
    --frontend-url)
      FRONTEND_URL="$2"
      shift 2
      ;;
    --repo-url)
      REPO_URL="$2"
      shift 2
      ;;
    --skip-disk)
      SKIP_DISK="true"
      shift
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate required args
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo -e "${RED}❌ --anthropic-key is required${NC}"
  exit 1
fi

if [ -z "$GITHUB_CLIENT_ID" ] || [ -z "$GITHUB_CLIENT_SECRET" ]; then
  echo -e "${RED}❌ --github-client-id and --github-client-secret are required${NC}"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║        🚀 Multi-Agent Platform - One-Command Deployment                      ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# Step 1: Install Dependencies (Docker, Git)
# ============================================================================
echo -e "${GREEN}[1/5]${NC} Installing dependencies..."
apt-get update -qq

# Docker
if ! command -v docker &> /dev/null; then
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Git
apt-get install -y git -qq

echo "   ✅ Docker & Git installed"

# ============================================================================
# Step 2: Mount Persistent Disk
# ============================================================================
echo -e "${GREEN}[2/5]${NC} Setting up storage..."
if [ "$SKIP_DISK" != "true" ] && [ -b "$DISK_DEVICE" ]; then
  if ! mountpoint -q $MOUNT_POINT; then
    if ! blkid $DISK_DEVICE | grep -q "TYPE="; then
      mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard $DISK_DEVICE
    fi
    mkdir -p $MOUNT_POINT
    mount -o discard,defaults $DISK_DEVICE $MOUNT_POINT
    grep -q "$DISK_DEVICE" /etc/fstab || echo "$DISK_DEVICE $MOUNT_POINT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  fi
fi

mkdir -p $MOUNT_POINT/agent-workspace $MOUNT_POINT/mongodb-data $MOUNT_POINT/backups
echo "   ✅ Storage ready at $MOUNT_POINT"

# ============================================================================
# Step 3: Clone/Update Application
# ============================================================================
echo -e "${GREEN}[3/5]${NC} Setting up application..."
if [ -d "$APP_DIR/.git" ]; then
  cd $APP_DIR
  git pull --quiet
  echo "   ✅ Application updated"
else
  rm -rf $APP_DIR
  git clone --quiet --depth 1 $REPO_URL $APP_DIR
  echo "   ✅ Application cloned"
fi

# ============================================================================
# Step 4: Generate .env
# ============================================================================
echo -e "${GREEN}[4/5]${NC} Configuring environment..."
JWT_SECRET=$(openssl rand -base64 32)

cat > $APP_DIR/.env << ENVFILE
# ============================================================================
# Multi-Agent Platform - Production Configuration
# Generated: $(date)
# ============================================================================

# Server
NODE_ENV=production
PORT=3001
BASE_URL=http://localhost:3001
FRONTEND_URL=${FRONTEND_URL:-http://localhost:3000}

# API Keys
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
VOYAGE_API_KEY=${VOYAGE_API_KEY:-}

# GitHub OAuth
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET}

# GitHub App (optional)
GITHUB_APP_ID=${GITHUB_APP_ID:-}
GITHUB_PRIVATE_KEY=${GITHUB_PRIVATE_KEY:-}
GITHUB_INSTALLATION_ID=${GITHUB_INSTALLATION_ID:-}
GITHUB_WEBHOOK_SECRET=

# Security
JWT_SECRET=${JWT_SECRET}
JWT_REFRESH_SECRET=${JWT_SECRET}
SESSION_SECRET=${JWT_SECRET}

# Workspace (auto-configured)
AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace

# Cleanup (DISABLED by default)
WORKSPACE_AUTO_CLEANUP_ENABLED=false
WORKSPACE_MAX_AGE_HOURS=168

# Performance
ENABLE_PERFORMANCE_CACHE=true
ENABLE_FILE_CONTENT_CACHE=true
ENABLE_ENHANCED_GIT_EXECUTION=true
ENVFILE

echo "   ✅ Configuration generated"

# ============================================================================
# Step 5: Build & Start
# ============================================================================
echo -e "${GREEN}[5/5]${NC} Starting services..."
cd $APP_DIR
docker compose -f docker-compose.prod.yml up -d --build --quiet-pull 2>/dev/null

# Wait for health
sleep 10
for i in {1..30}; do
  if curl -s http://localhost:3001/api/health | grep -q '"status":"ok"'; then
    break
  fi
  sleep 2
done

echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                    ✅ Deployment Complete!                                   ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "🌐 API: http://localhost:3001"
echo "📊 Health: http://localhost:3001/api/health"
echo ""
echo "Useful commands:"
echo "  Logs:    docker logs -f agents-backend"
echo "  Stop:    cd $APP_DIR && ./deployment/stop.sh"
echo "  Restart: cd $APP_DIR && ./deployment/start.sh"
echo ""
