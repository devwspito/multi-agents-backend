#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Quick Deploy Script
# ============================================================================
# One-liner deployment for Google Cloud VM
#
# Usage (from fresh VM):
#   curl -sSL https://raw.githubusercontent.com/<org>/agents-backend/main/deployment/quick-deploy.sh | sudo bash -s -- \
#     --anthropic-key "sk-ant-..." \
#     --github-id "your-client-id" \
#     --github-secret "your-secret" \
#     --repo "https://github.com/org/repo.git"
#
# Or run locally:
#   ./quick-deploy.sh --anthropic-key "sk-ant-..." --repo "https://github.com/org/repo.git"
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Defaults
APP_DIR="/app"
BRANCH="main"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --anthropic-key) ANTHROPIC_KEY="$2"; shift 2 ;;
        --github-id) GITHUB_CLIENT_ID="$2"; shift 2 ;;
        --github-secret) GITHUB_CLIENT_SECRET="$2"; shift 2 ;;
        --repo) REPO_URL="$2"; shift 2 ;;
        --branch) BRANCH="$2"; shift 2 ;;
        --skip-setup) SKIP_SETUP="true"; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║          Multi-Agent Platform - Quick Deploy                                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

# ============================================================================
# Step 1: Run full setup if not skipped
# ============================================================================
if [ "$SKIP_SETUP" != "true" ]; then
    echo -e "${GREEN}[1/4]${NC} Running system setup..."

    # Download and run the complete setup script
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if [ -f "$SCRIPT_DIR/setup-vm-complete.sh" ]; then
        # Running locally
        bash "$SCRIPT_DIR/setup-vm-complete.sh"
    else
        # Running from curl
        curl -sSL https://raw.githubusercontent.com/<org>/agents-backend/main/deployment/setup-vm-complete.sh | bash
    fi
else
    echo -e "${YELLOW}[1/4]${NC} Skipping system setup (--skip-setup)"
fi

# ============================================================================
# Step 2: Clone repository
# ============================================================================
echo -e "${GREEN}[2/4]${NC} Setting up application..."

if [ -n "$REPO_URL" ]; then
    if [ -d "$APP_DIR/.git" ]; then
        echo "   Repository already exists, pulling latest..."
        cd $APP_DIR
        git fetch origin
        git checkout $BRANCH
        git pull origin $BRANCH
    else
        echo "   Cloning repository..."
        rm -rf $APP_DIR/*
        git clone --branch $BRANCH $REPO_URL $APP_DIR
    fi
else
    echo -e "${YELLOW}   No --repo specified, skipping clone${NC}"
fi

# ============================================================================
# Step 3: Configure environment
# ============================================================================
echo -e "${GREEN}[3/4]${NC} Configuring environment..."

cd $APP_DIR

# Update .env with provided values
if [ -n "$ANTHROPIC_KEY" ]; then
    sed -i "s/^ANTHROPIC_API_KEY=.*/ANTHROPIC_API_KEY=$ANTHROPIC_KEY/" .env
    echo "   ✅ Anthropic API key configured"
fi

if [ -n "$GITHUB_CLIENT_ID" ]; then
    sed -i "s/^GITHUB_CLIENT_ID=.*/GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID/" .env
    echo "   ✅ GitHub Client ID configured"
fi

if [ -n "$GITHUB_CLIENT_SECRET" ]; then
    sed -i "s/^GITHUB_CLIENT_SECRET=.*/GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET/" .env
    echo "   ✅ GitHub Client Secret configured"
fi

# Detect external IP and update callback URL
EXTERNAL_IP=$(curl -s http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip -H "Metadata-Flavor: Google" 2>/dev/null || curl -s ifconfig.me)
if [ -n "$EXTERNAL_IP" ]; then
    sed -i "s|^GITHUB_CALLBACK_URL=.*|GITHUB_CALLBACK_URL=http://$EXTERNAL_IP:3001/api/auth/github/callback|" .env
    sed -i "s|^FRONTEND_URL=.*|FRONTEND_URL=http://$EXTERNAL_IP:3000|" .env
    echo "   ✅ URLs configured for IP: $EXTERNAL_IP"
fi

# ============================================================================
# Step 4: Install and start
# ============================================================================
echo -e "${GREEN}[4/4]${NC} Installing dependencies and starting..."

# Install dependencies
echo "   Installing npm packages..."
npm install --production 2>&1 | tail -5

# Build
echo "   Building TypeScript..."
npm run build 2>&1 | tail -3

# Start with PM2
echo "   Starting application..."
pm2 delete all 2>/dev/null || true
pm2 start ecosystem.config.js

# Setup PM2 to start on boot
pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root 2>/dev/null || true

# Wait for startup
sleep 5

# Health check
echo ""
echo "   Checking health..."
HEALTH=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo '{"status":"error"}')

if echo "$HEALTH" | grep -q '"status"'; then
    echo -e "   ${GREEN}✅ Health check passed${NC}"
else
    echo -e "   ${YELLOW}⚠️ Health check pending. Check logs: pm2 logs${NC}"
fi

# ============================================================================
# Done!
# ============================================================================
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                    ✅ Deployment Complete!                                   ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "URLs:"
echo "   API:      http://$EXTERNAL_IP:3001"
echo "   Health:   http://$EXTERNAL_IP:3001/api/health"
echo "   Sandbox:  http://$EXTERNAL_IP:3001/api/sandbox/status"
echo ""
echo "Commands:"
echo "   pm2 status           - Check app status"
echo "   pm2 logs             - View logs"
echo "   pm2 restart all      - Restart app"
echo "   docker ps            - View sandbox containers"
echo ""

# Show PM2 status
pm2 status
