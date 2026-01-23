#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Installation Verification Script
# ============================================================================
# Run this script to verify all components are installed and working
#
# Usage:
#   ./verify-install.sh
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════════════════════${NC}"
}

check() {
    local name="$1"
    local cmd="$2"
    local required="${3:-true}"

    if eval "$cmd" &>/dev/null; then
        echo -e "   ${GREEN}✅${NC} $name"
        return 0
    else
        if [ "$required" = "true" ]; then
            echo -e "   ${RED}❌${NC} $name"
            ((ERRORS++))
        else
            echo -e "   ${YELLOW}⚠️${NC}  $name (optional)"
            ((WARNINGS++))
        fi
        return 1
    fi
}

version_check() {
    local name="$1"
    local cmd="$2"
    local result

    result=$(eval "$cmd" 2>/dev/null || echo "not installed")
    echo -e "   ${GREEN}✅${NC} $name: $result"
}

header "Multi-Agent Platform - System Verification"
echo ""

# ============================================================================
# 1. Core Dependencies
# ============================================================================
echo -e "${BLUE}[1/6] Core Dependencies${NC}"

check "Node.js installed" "command -v node"
if command -v node &>/dev/null; then
    version_check "Node.js version" "node -v"
fi

check "npm installed" "command -v npm"
check "Git installed" "command -v git"
check "curl installed" "command -v curl"

# ============================================================================
# 2. Docker (Sandbox System)
# ============================================================================
echo ""
echo -e "${BLUE}[2/6] Docker (Sandbox System)${NC}"

check "Docker installed" "command -v docker"
check "Docker daemon running" "docker info"
check "Docker Compose available" "docker compose version"

# Check sandbox images
if docker info &>/dev/null; then
    echo ""
    echo "   Sandbox Images:"

    IMAGES=("node:20-bookworm-slim" "python:3.11-slim-bookworm" "golang:1.21-bookworm" "rust:1.75-slim-bookworm" "dart:stable")

    for img in "${IMAGES[@]}"; do
        if docker images --format "{{.Repository}}:{{.Tag}}" | grep -q "^$img$"; then
            SIZE=$(docker images --format "{{.Size}}" "$img" 2>/dev/null | head -1)
            echo -e "      ${GREEN}✅${NC} $img ($SIZE)"
        else
            echo -e "      ${YELLOW}⚠️${NC}  $img (not pulled)"
            ((WARNINGS++))
        fi
    done
fi

# ============================================================================
# 3. MongoDB
# ============================================================================
echo ""
echo -e "${BLUE}[3/6] MongoDB${NC}"

check "MongoDB installed" "command -v mongod"
check "MongoDB service running" "systemctl is-active mongod"

if command -v mongod &>/dev/null; then
    version_check "MongoDB version" "mongod --version | head -n1 | grep -oP 'v\d+\.\d+\.\d+'"
fi

# ============================================================================
# 4. Directory Structure
# ============================================================================
echo ""
echo -e "${BLUE}[4/6] Directory Structure${NC}"

check "/app exists" "[ -d /app ]"
check "/mnt/data exists" "[ -d /mnt/data ]"
check "/mnt/data/agent-workspace exists" "[ -d /mnt/data/agent-workspace ]"
check "/mnt/data/logs exists" "[ -d /mnt/data/logs ]"

# Check disk space
if [ -d "/mnt/data" ]; then
    DISK_FREE=$(df -h /mnt/data | awk 'NR==2 {print $4}')
    DISK_USED=$(df -h /mnt/data | awk 'NR==2 {print $5}')
    echo -e "   ${GREEN}ℹ️${NC}  Disk space: $DISK_FREE free ($DISK_USED used)"
fi

# ============================================================================
# 5. Configuration
# ============================================================================
echo ""
echo -e "${BLUE}[5/6] Configuration${NC}"

check ".env file exists" "[ -f /app/.env ]"
check "ecosystem.config.js exists" "[ -f /app/ecosystem.config.js ]"

# Check required environment variables
if [ -f /app/.env ]; then
    echo ""
    echo "   Environment Variables:"

    # Check each required variable
    REQUIRED_VARS=("MONGODB_URI" "ANTHROPIC_API_KEY" "JWT_SECRET" "AGENT_WORKSPACE_DIR")
    OPTIONAL_VARS=("GITHUB_CLIENT_ID" "GITHUB_CLIENT_SECRET")

    for var in "${REQUIRED_VARS[@]}"; do
        VALUE=$(grep "^$var=" /app/.env 2>/dev/null | cut -d'=' -f2-)
        if [ -n "$VALUE" ] && [ "$VALUE" != "" ]; then
            # Mask sensitive values
            if [[ "$var" == *"KEY"* ]] || [[ "$var" == *"SECRET"* ]]; then
                MASKED="${VALUE:0:8}..."
            else
                MASKED="$VALUE"
            fi
            echo -e "      ${GREEN}✅${NC} $var = $MASKED"
        else
            echo -e "      ${RED}❌${NC} $var (not set)"
            ((ERRORS++))
        fi
    done

    for var in "${OPTIONAL_VARS[@]}"; do
        VALUE=$(grep "^$var=" /app/.env 2>/dev/null | cut -d'=' -f2-)
        if [ -n "$VALUE" ] && [ "$VALUE" != "" ]; then
            echo -e "      ${GREEN}✅${NC} $var (configured)"
        else
            echo -e "      ${YELLOW}⚠️${NC}  $var (not set - optional)"
            ((WARNINGS++))
        fi
    done
fi

# ============================================================================
# 6. Application Status
# ============================================================================
echo ""
echo -e "${BLUE}[6/6] Application Status${NC}"

check "PM2 installed" "command -v pm2"

# Check if app is running
if command -v pm2 &>/dev/null; then
    PM2_STATUS=$(pm2 jlist 2>/dev/null | jq -r '.[0].pm2_env.status' 2>/dev/null || echo "not running")
    if [ "$PM2_STATUS" = "online" ]; then
        echo -e "   ${GREEN}✅${NC} Application running (PM2)"

        # Show uptime
        UPTIME=$(pm2 jlist 2>/dev/null | jq -r '.[0].pm2_env.pm_uptime' 2>/dev/null || echo "0")
        if [ "$UPTIME" != "0" ]; then
            UPTIME_HUMAN=$(date -d @$((UPTIME/1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "N/A")
            echo -e "   ${GREEN}ℹ️${NC}  Started: $UPTIME_HUMAN"
        fi
    else
        echo -e "   ${YELLOW}⚠️${NC}  Application not running"
        ((WARNINGS++))
    fi
fi

# Health check
echo ""
echo "   API Health Check:"
HEALTH_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health 2>/dev/null || echo "000")

if [ "$HEALTH_RESPONSE" = "200" ]; then
    echo -e "      ${GREEN}✅${NC} API responding (HTTP $HEALTH_RESPONSE)"

    # Get detailed health
    HEALTH_JSON=$(curl -s http://localhost:3001/api/health 2>/dev/null || echo "{}")
    echo "      Response: $HEALTH_JSON"
else
    echo -e "      ${YELLOW}⚠️${NC}  API not responding (HTTP $HEALTH_RESPONSE)"
    ((WARNINGS++))
fi

# Sandbox status
echo ""
echo "   Sandbox Status:"
SANDBOX_RESPONSE=$(curl -s http://localhost:3001/api/sandbox/status 2>/dev/null || echo "{}")

if echo "$SANDBOX_RESPONSE" | grep -q '"success":true'; then
    DOCKER_AVAILABLE=$(echo "$SANDBOX_RESPONSE" | jq -r '.dockerAvailable' 2>/dev/null || echo "unknown")
    ACTIVE_SANDBOXES=$(echo "$SANDBOX_RESPONSE" | jq -r '.activeSandboxes' 2>/dev/null || echo "0")

    echo -e "      ${GREEN}✅${NC} Sandbox service online"
    echo -e "      Docker available: $DOCKER_AVAILABLE"
    echo -e "      Active sandboxes: $ACTIVE_SANDBOXES"
else
    echo -e "      ${YELLOW}⚠️${NC}  Sandbox service not responding"
    ((WARNINGS++))
fi

# ============================================================================
# Summary
# ============================================================================
header "Verification Summary"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}   ✅ All checks passed! System is ready.${NC}"
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}   ⚠️  $WARNINGS warning(s), but system should work.${NC}"
else
    echo -e "${RED}   ❌ $ERRORS error(s) and $WARNINGS warning(s) found.${NC}"
    echo ""
    echo "   Please fix the errors above before using the system."
fi

echo ""
echo "   Errors:   $ERRORS"
echo "   Warnings: $WARNINGS"
echo ""

# Return appropriate exit code
if [ $ERRORS -gt 0 ]; then
    exit 1
else
    exit 0
fi
