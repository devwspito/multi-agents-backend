#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Initial Setup Script
# ============================================================================
# Run this script ONCE when setting up a new client VM
#
# Prerequisites:
#   - Google Cloud VM with Persistent Disk attached at /dev/sdb
#   - Ubuntu 22.04 LTS
#   - SSH access
#
# Usage:
#   chmod +x setup.sh
#   sudo ./setup.sh
# ============================================================================

set -e  # Exit on any error

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║          Multi-Agent Platform - Initial Setup                                ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run this script as root (sudo ./setup.sh)"
  exit 1
fi

# ============================================================================
# Step 1: Update System
# ============================================================================
echo "📦 Step 1/6: Updating system packages..."
apt-get update && apt-get upgrade -y

# ============================================================================
# Step 2: Install Docker
# ============================================================================
echo "🐳 Step 2/6: Installing Docker..."
if ! command -v docker &> /dev/null; then
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
    tee /etc/apt/sources.list.d/docker.list > /dev/null
  
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  
  # Add current user to docker group
  usermod -aG docker $SUDO_USER
  
  echo "✅ Docker installed"
else
  echo "✅ Docker already installed"
fi

# ============================================================================
# Step 3: Mount Persistent Disk
# ============================================================================
echo "💾 Step 3/6: Setting up Persistent Disk..."
DISK_DEVICE="/dev/sdb"
MOUNT_POINT="/mnt/data"

if [ ! -b "$DISK_DEVICE" ]; then
  echo "⚠️  Warning: $DISK_DEVICE not found. Skipping disk mount."
  echo "   For local development, create directory manually:"
  echo "   mkdir -p $MOUNT_POINT"
  mkdir -p $MOUNT_POINT
else
  # Check if disk is already mounted
  if mountpoint -q $MOUNT_POINT; then
    echo "✅ Persistent Disk already mounted at $MOUNT_POINT"
  else
    # Check if disk has a filesystem
    if ! blkid $DISK_DEVICE | grep -q "TYPE="; then
      echo "   Formatting disk (first time setup)..."
      mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard $DISK_DEVICE
    fi
    
    # Create mount point
    mkdir -p $MOUNT_POINT
    
    # Mount disk
    mount -o discard,defaults $DISK_DEVICE $MOUNT_POINT
    
    # Add to fstab for auto-mount
    if ! grep -q "$DISK_DEVICE" /etc/fstab; then
      echo "$DISK_DEVICE $MOUNT_POINT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
    fi
    
    echo "✅ Persistent Disk mounted at $MOUNT_POINT"
  fi
fi

# ============================================================================
# Step 4: Create Directory Structure
# ============================================================================
echo "📁 Step 4/6: Creating directory structure..."
mkdir -p $MOUNT_POINT/agent-workspace
mkdir -p $MOUNT_POINT/mongodb-data
mkdir -p $MOUNT_POINT/backups

# Set permissions
chown -R $SUDO_USER:$SUDO_USER $MOUNT_POINT
chmod -R 755 $MOUNT_POINT

echo "✅ Directories created:"
echo "   - $MOUNT_POINT/agent-workspace (Agent workspaces)"
echo "   - $MOUNT_POINT/mongodb-data (MongoDB data)"
echo "   - $MOUNT_POINT/backups (Local backups)"

# ============================================================================
# Step 5: Install Git
# ============================================================================
echo "🔧 Step 5/6: Installing Git..."
apt-get install -y git
echo "✅ Git installed"

# ============================================================================
# Step 6: Create .env file from template
# ============================================================================
echo "📝 Step 6/6: Setting up environment configuration..."
APP_DIR="/app"
mkdir -p $APP_DIR

if [ -f "$APP_DIR/.env" ]; then
  echo "✅ .env file already exists at $APP_DIR/.env"
  echo "   Review and update client-specific values before starting"
else
  if [ -f "$(dirname "$0")/../.env.production.template" ]; then
    cp "$(dirname "$0")/../.env.production.template" "$APP_DIR/.env"
    echo "✅ Created $APP_DIR/.env from template"
    echo ""
    echo "⚠️  IMPORTANT: Edit $APP_DIR/.env with client-specific values:"
    echo "   - ANTHROPIC_API_KEY"
    echo "   - GITHUB_CLIENT_ID & GITHUB_CLIENT_SECRET"
    echo "   - JWT_SECRET (generate with: openssl rand -base64 32)"
    echo ""
  else
    echo "⚠️  Template not found. Create .env manually at $APP_DIR/.env"
  fi
fi

# ============================================================================
# Setup Complete
# ============================================================================
echo ""
echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║                          ✅ Setup Complete!                                  ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "1. Copy the application to $APP_DIR:"
echo "   git clone <repo-url> $APP_DIR"
echo ""
echo "2. Configure environment variables:"
echo "   nano $APP_DIR/.env"
echo ""
echo "3. Start the platform:"
echo "   cd $APP_DIR"
echo "   ./deployment/start.sh"
echo ""
echo "4. Check status:"
echo "   docker ps"
echo "   curl http://localhost:3001/api/health"
echo ""
