#!/bin/bash
# ============================================================================
# Multi-Agent Platform - Complete VM Setup Script
# ============================================================================
# This script installs EVERYTHING needed for the Multi-Agent Platform
# including the isolated Docker sandbox system.
#
# Run on: Ubuntu 22.04 LTS (Google Cloud VM)
#
# Usage:
#   curl -sSL https://raw.githubusercontent.com/<org>/agents-backend/main/deployment/setup-vm-complete.sh | sudo bash
#
#   Or locally:
#   chmod +x setup-vm-complete.sh
#   sudo ./setup-vm-complete.sh
# ============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
NODE_VERSION="20"
MONGODB_VERSION="7.0"
APP_DIR="/app"
DATA_DIR="/mnt/data"
LOG_FILE="/var/log/multiagent-setup.log"

# Log function
log() {
    echo -e "$1" | tee -a $LOG_FILE
}

header() {
    log ""
    log "${BLUE}╔══════════════════════════════════════════════════════════════════════════════╗${NC}"
    log "${BLUE}║  $1${NC}"
    log "${BLUE}╚══════════════════════════════════════════════════════════════════════════════╝${NC}"
    log ""
}

step() {
    log "${GREEN}[$(date '+%H:%M:%S')]${NC} $1"
}

warn() {
    log "${YELLOW}⚠️  $1${NC}"
}

error() {
    log "${RED}❌ $1${NC}"
    exit 1
}

success() {
    log "${GREEN}✅ $1${NC}"
}

# ============================================================================
# Pre-flight checks
# ============================================================================
header "Multi-Agent Platform - Complete Setup"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    error "Please run as root (sudo ./setup-vm-complete.sh)"
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
    VERSION=$VERSION_ID
else
    error "Cannot detect OS. This script requires Ubuntu 22.04+"
fi

if [ "$OS" != "ubuntu" ]; then
    warn "This script is optimized for Ubuntu. Your OS: $OS"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

log "Starting setup on $OS $VERSION"
log "Log file: $LOG_FILE"

# ============================================================================
# Step 1: System Update
# ============================================================================
header "Step 1/8: System Update"

step "Updating package lists..."
apt-get update >> $LOG_FILE 2>&1

step "Upgrading packages..."
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y >> $LOG_FILE 2>&1

step "Installing essential packages..."
apt-get install -y \
    curl \
    wget \
    git \
    build-essential \
    python3 \
    python3-pip \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common \
    apt-transport-https \
    unzip \
    jq \
    htop \
    ncdu \
    >> $LOG_FILE 2>&1

success "System updated and essential packages installed"

# ============================================================================
# Step 2: Install Node.js
# ============================================================================
header "Step 2/8: Node.js $NODE_VERSION Installation"

if command -v node &> /dev/null; then
    CURRENT_NODE=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$CURRENT_NODE" -ge "$NODE_VERSION" ]; then
        success "Node.js $(node -v) already installed"
    else
        step "Upgrading Node.js from v$CURRENT_NODE to v$NODE_VERSION..."
        curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >> $LOG_FILE 2>&1
        apt-get install -y nodejs >> $LOG_FILE 2>&1
    fi
else
    step "Installing Node.js $NODE_VERSION..."
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >> $LOG_FILE 2>&1
    apt-get install -y nodejs >> $LOG_FILE 2>&1
fi

# Install global npm packages
step "Installing global npm packages (pm2)..."
npm install -g pm2 >> $LOG_FILE 2>&1

success "Node.js $(node -v) and npm $(npm -v) installed"

# ============================================================================
# Step 3: Install Docker
# ============================================================================
header "Step 3/8: Docker Installation (Sandbox System)"

if command -v docker &> /dev/null; then
    success "Docker already installed: $(docker --version)"
else
    step "Installing Docker..."

    # Remove old versions
    apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true

    # Add Docker's official GPG key
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    # Set up repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker
    apt-get update >> $LOG_FILE 2>&1
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >> $LOG_FILE 2>&1

    success "Docker installed: $(docker --version)"
fi

# Ensure Docker is running
step "Ensuring Docker daemon is running..."
systemctl enable docker >> $LOG_FILE 2>&1
systemctl start docker >> $LOG_FILE 2>&1

# Add current user to docker group (if not root)
if [ -n "$SUDO_USER" ]; then
    usermod -aG docker $SUDO_USER
    log "   Added $SUDO_USER to docker group"
fi

# Configure Docker for better performance
step "Configuring Docker daemon..."
mkdir -p /etc/docker
cat > /etc/docker/daemon.json << 'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "storage-driver": "overlay2",
  "default-ulimits": {
    "nofile": {
      "Name": "nofile",
      "Hard": 65536,
      "Soft": 65536
    }
  }
}
EOF
systemctl restart docker >> $LOG_FILE 2>&1

success "Docker configured and running"

# ============================================================================
# Step 4: Pre-pull Sandbox Docker Images
# ============================================================================
header "Step 4/8: Pre-pulling Sandbox Images"

step "Pulling sandbox images (this may take a few minutes)..."

# Node.js sandbox (primary)
log "   Pulling node:20-bookworm-slim..."
docker pull node:20-bookworm-slim >> $LOG_FILE 2>&1

# Python sandbox
log "   Pulling python:3.11-slim-bookworm..."
docker pull python:3.11-slim-bookworm >> $LOG_FILE 2>&1

# Go sandbox
log "   Pulling golang:1.21-bookworm..."
docker pull golang:1.21-bookworm >> $LOG_FILE 2>&1

# Rust sandbox
log "   Pulling rust:1.75-slim-bookworm..."
docker pull rust:1.75-slim-bookworm >> $LOG_FILE 2>&1

# Flutter/Dart sandbox
log "   Pulling dart:stable..."
docker pull dart:stable >> $LOG_FILE 2>&1

success "Sandbox images pre-pulled"

# ============================================================================
# Step 5: Install MongoDB
# ============================================================================
header "Step 5/8: MongoDB $MONGODB_VERSION Installation"

if command -v mongod &> /dev/null; then
    success "MongoDB already installed"
else
    step "Installing MongoDB $MONGODB_VERSION..."

    # Import public key
    curl -fsSL https://www.mongodb.org/static/pgp/server-${MONGODB_VERSION}.asc | \
        gpg --dearmor -o /usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg

    # Add repository
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-${MONGODB_VERSION}.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/${MONGODB_VERSION} multiverse" | \
        tee /etc/apt/sources.list.d/mongodb-org-${MONGODB_VERSION}.list

    # Install
    apt-get update >> $LOG_FILE 2>&1
    apt-get install -y mongodb-org >> $LOG_FILE 2>&1

    # Enable and start
    systemctl enable mongod >> $LOG_FILE 2>&1
    systemctl start mongod >> $LOG_FILE 2>&1

    success "MongoDB $MONGODB_VERSION installed and running"
fi

# ============================================================================
# Step 6: Setup Directory Structure
# ============================================================================
header "Step 6/8: Directory Structure Setup"

# Check for persistent disk
if [ -b "/dev/sdb" ]; then
    step "Persistent disk detected at /dev/sdb"

    if ! mountpoint -q $DATA_DIR; then
        # Format if needed
        if ! blkid /dev/sdb | grep -q "TYPE="; then
            step "Formatting persistent disk..."
            mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0,discard /dev/sdb >> $LOG_FILE 2>&1
        fi

        # Create mount point and mount
        mkdir -p $DATA_DIR
        mount -o discard,defaults /dev/sdb $DATA_DIR

        # Add to fstab
        if ! grep -q "/dev/sdb" /etc/fstab; then
            echo "/dev/sdb $DATA_DIR ext4 discard,defaults,nofail 0 2" >> /etc/fstab
        fi

        success "Persistent disk mounted at $DATA_DIR"
    else
        success "Persistent disk already mounted"
    fi
else
    warn "No persistent disk found at /dev/sdb"
    step "Creating local data directory..."
    mkdir -p $DATA_DIR
fi

# Create directory structure
step "Creating directory structure..."
mkdir -p $DATA_DIR/agent-workspace
mkdir -p $DATA_DIR/mongodb-data
mkdir -p $DATA_DIR/backups
mkdir -p $DATA_DIR/logs
mkdir -p $APP_DIR

# Set permissions
if [ -n "$SUDO_USER" ]; then
    chown -R $SUDO_USER:$SUDO_USER $DATA_DIR
    chown -R $SUDO_USER:$SUDO_USER $APP_DIR
fi
chmod -R 755 $DATA_DIR

success "Directory structure created"
log "   - $DATA_DIR/agent-workspace (Task workspaces)"
log "   - $DATA_DIR/mongodb-data (MongoDB data)"
log "   - $DATA_DIR/backups (Automated backups)"
log "   - $DATA_DIR/logs (Application logs)"
log "   - $APP_DIR (Application code)"

# ============================================================================
# Step 7: Configure System Limits
# ============================================================================
header "Step 7/8: System Configuration"

step "Configuring system limits..."

# Increase file descriptors
cat >> /etc/security/limits.conf << 'EOF'
# Multi-Agent Platform limits
* soft nofile 65536
* hard nofile 65536
root soft nofile 65536
root hard nofile 65536
EOF

# Increase inotify limits (for file watching)
cat >> /etc/sysctl.conf << 'EOF'
# Multi-Agent Platform settings
fs.inotify.max_user_watches=524288
fs.inotify.max_user_instances=512
vm.max_map_count=262144
EOF
sysctl -p >> $LOG_FILE 2>&1

# Configure Git globally
step "Configuring Git..."
git config --global init.defaultBranch main
git config --global core.autocrlf input
git config --global credential.helper store
git config --global pull.rebase false

success "System configured"

# ============================================================================
# Step 8: Create .env Template
# ============================================================================
header "Step 8/8: Environment Configuration"

if [ ! -f "$APP_DIR/.env" ]; then
    step "Creating .env template..."
    cat > $APP_DIR/.env << 'EOF'
# ============================================================================
# Multi-Agent Platform - Environment Configuration
# ============================================================================
# Fill in the required values before starting the application
# ============================================================================

# Application
NODE_ENV=production
PORT=3001

# MongoDB
# Use local MongoDB or MongoDB Atlas connection string
MONGODB_URI=mongodb://localhost:27017/multiagent

# Anthropic API (REQUIRED)
# Get your key at: https://console.anthropic.com/
ANTHROPIC_API_KEY=

# GitHub OAuth (REQUIRED for GitHub integration)
# Create OAuth App: https://github.com/settings/developers
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3001/api/auth/github/callback

# Security
JWT_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_32
JWT_REFRESH_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_32
SESSION_SECRET=CHANGE_ME_GENERATE_WITH_openssl_rand_base64_32

# Workspace Configuration
AGENT_WORKSPACE_DIR=/mnt/data/agent-workspace

# Docker Sandbox Configuration
SANDBOX_ENABLED=true
SANDBOX_DEFAULT_IMAGE=node:20-bookworm-slim
SANDBOX_MEMORY_LIMIT=2g
SANDBOX_CPU_LIMIT=2

# Logging
LOG_LEVEL=info
LOG_FILE=/mnt/data/logs/app.log

# Optional: Frontend URL (for CORS)
FRONTEND_URL=http://localhost:3000

# Optional: Model Configuration
DEFAULT_MODEL=sonnet
MAX_COST_PER_TASK=10.00
EOF

    # Generate secrets
    JWT_SECRET=$(openssl rand -base64 32)
    JWT_REFRESH=$(openssl rand -base64 32)
    SESSION_SECRET=$(openssl rand -base64 32)

    sed -i "s/JWT_SECRET=CHANGE_ME.*/JWT_SECRET=$JWT_SECRET/" $APP_DIR/.env
    sed -i "s/JWT_REFRESH_SECRET=CHANGE_ME.*/JWT_REFRESH_SECRET=$JWT_REFRESH/" $APP_DIR/.env
    sed -i "s/SESSION_SECRET=CHANGE_ME.*/SESSION_SECRET=$SESSION_SECRET/" $APP_DIR/.env

    success ".env template created with auto-generated secrets"
else
    success ".env file already exists"
fi

# Create PM2 ecosystem file
step "Creating PM2 ecosystem configuration..."
cat > $APP_DIR/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'multiagent-backend',
    script: 'dist/index.js',
    cwd: '/app',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/mnt/data/logs/error.log',
    out_file: '/mnt/data/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};
EOF

# Create quick-start script
step "Creating quick-start script..."
cat > $APP_DIR/start.sh << 'EOF'
#!/bin/bash
cd /app
npm install --production
npm run build
pm2 start ecosystem.config.js
pm2 save
echo "Application started. Check status with: pm2 status"
EOF
chmod +x $APP_DIR/start.sh

# Create stop script
cat > $APP_DIR/stop.sh << 'EOF'
#!/bin/bash
pm2 stop all
pm2 delete all
echo "Application stopped"
EOF
chmod +x $APP_DIR/stop.sh

# Create logs script
cat > $APP_DIR/logs.sh << 'EOF'
#!/bin/bash
pm2 logs multiagent-backend
EOF
chmod +x $APP_DIR/logs.sh

success "Helper scripts created"

# ============================================================================
# Setup Complete!
# ============================================================================
header "Setup Complete!"

log ""
log "${GREEN}All components installed:${NC}"
log "   - Node.js $(node -v)"
log "   - npm $(npm -v)"
log "   - Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
log "   - MongoDB $(mongod --version | head -n1 | cut -d'v' -f3)"
log "   - PM2 $(pm2 -v)"
log "   - Git $(git --version | cut -d' ' -f3)"
log ""
log "${GREEN}Docker Sandbox Images:${NC}"
docker images --format "   - {{.Repository}}:{{.Tag}} ({{.Size}})"
log ""
log "${GREEN}Directory Structure:${NC}"
log "   $APP_DIR          - Application code"
log "   $DATA_DIR         - Persistent data"
log ""
log "${YELLOW}Next Steps:${NC}"
log ""
log "   1. Clone your repository:"
log "      ${BLUE}git clone <your-repo-url> $APP_DIR${NC}"
log ""
log "   2. Configure environment variables:"
log "      ${BLUE}nano $APP_DIR/.env${NC}"
log "      - Add ANTHROPIC_API_KEY"
log "      - Add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET"
log ""
log "   3. Start the application:"
log "      ${BLUE}cd $APP_DIR && ./start.sh${NC}"
log ""
log "   4. Check status:"
log "      ${BLUE}pm2 status${NC}"
log "      ${BLUE}curl http://localhost:3001/api/health${NC}"
log ""
log "${GREEN}Useful Commands:${NC}"
log "   pm2 logs              - View application logs"
log "   pm2 restart all       - Restart application"
log "   docker ps             - View running sandbox containers"
log "   htop                  - Monitor system resources"
log ""
log "${BLUE}Setup log saved to: $LOG_FILE${NC}"
log ""
