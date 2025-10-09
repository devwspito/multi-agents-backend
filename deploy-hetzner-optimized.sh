#!/bin/bash

###############################################################################
# Multi-Agent Platform - Hetzner Dedicated Server Deployment (OPTIMIZED)
#
# Optimized for high-performance dedicated servers like AX41-NVMe
# - AMD Ryzen 5 3600 (6 cores / 12 threads)
# - 64 GB RAM
# - 2 x 512 GB NVMe SSD
#
# This script:
# - Configures PM2 in cluster mode (uses all CPU cores)
# - Optimizes Nginx for high throughput
# - Increases system limits for concurrent connections
# - Optional: Installs MongoDB locally for zero latency
# - Configures swap for better memory management
#
# Usage:
#   bash <(curl -s https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/deploy-hetzner-optimized.sh)
#
###############################################################################

set -e  # Exit on error

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error() { echo -e "${RED}❌ $1${NC}"; }
log_highlight() { echo -e "${MAGENTA}🚀 $1${NC}"; }

print_banner() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  🚀 Multi-Agent Platform - High-Performance Deployment"
    echo "  💪 Optimized for Hetzner AX41-NVMe and similar"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
}

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Please run as root (use sudo)"
        exit 1
    fi
}

detect_hardware() {
    log_highlight "Detecting hardware specifications..."

    CPU_CORES=$(nproc)
    RAM_GB=$(free -g | awk '/^Mem:/{print $2}')
    DISK_GB=$(df -BG / | awk 'NR==2 {print $2}' | sed 's/G//')

    echo ""
    log_info "Detected hardware:"
    echo "  CPU Cores: $CPU_CORES"
    echo "  RAM: ${RAM_GB}GB"
    echo "  Disk: ${DISK_GB}GB"
    echo ""

    # Determine PM2 instances (leave 2 cores for system)
    PM2_INSTANCES=$((CPU_CORES - 2))
    if [ $PM2_INSTANCES -lt 1 ]; then
        PM2_INSTANCES=1
    fi

    log_success "Will configure PM2 with $PM2_INSTANCES instances (cluster mode)"
}

gather_info() {
    log_info "Deployment configuration:"
    echo ""

    read -p "Domain (e.g., api.example.com): " DOMAIN
    read -p "Email for SSL: " EMAIL
    read -p "GitHub repository URL: " GITHUB_REPO
    read -p "GitHub branch (default: main): " GITHUB_BRANCH
    GITHUB_BRANCH=${GITHUB_BRANCH:-main}

    echo ""
    log_info "Database Configuration:"
    echo "  1) MongoDB Atlas (cloud, free tier)"
    echo "  2) MongoDB Local (this server, recommended for performance)"
    read -p "Choose option (1 or 2): " MONGODB_OPTION

    if [ "$MONGODB_OPTION" == "2" ]; then
        INSTALL_MONGODB_LOCAL=true
        MONGODB_URI="mongodb://localhost:27017/multi-agents"
        log_success "Will install MongoDB locally"
    else
        INSTALL_MONGODB_LOCAL=false
        read -p "Enter MongoDB Atlas connection string: " MONGODB_URI
    fi

    echo ""
    log_info "Claude API:"
    read -p "Anthropic API key: " ANTHROPIC_API_KEY

    echo ""
    log_info "GitHub OAuth:"
    read -p "GitHub Client ID: " GITHUB_CLIENT_ID
    read -sp "GitHub Client Secret: " GITHUB_CLIENT_SECRET
    echo ""

    JWT_SECRET=$(openssl rand -base64 32)
    SESSION_SECRET=$(openssl rand -base64 32)

    read -p "Frontend URL (e.g., https://app.example.com): " FRONTEND_URL

    echo ""
    log_info "Configuration summary:"
    echo "  Domain: $DOMAIN"
    echo "  MongoDB: $([ "$INSTALL_MONGODB_LOCAL" = true ] && echo "Local" || echo "Atlas")"
    echo "  PM2 instances: $PM2_INSTANCES (cluster mode)"
    echo ""
    read -p "Proceed? (y/n): " CONFIRM

    if [ "$CONFIRM" != "y" ]; then
        log_error "Deployment cancelled"
        exit 1
    fi
}

optimize_system_limits() {
    log_info "Optimizing system limits for high performance..."

    # Increase file descriptors
    cat >> /etc/security/limits.conf <<EOF

# Multi-Agent Platform - High Performance
* soft nofile 65535
* hard nofile 65535
* soft nproc 65535
* hard nproc 65535
EOF

    # Sysctl optimizations
    cat >> /etc/sysctl.conf <<EOF

# Multi-Agent Platform - Network & Performance Tuning
# Increase network buffers
net.core.rmem_max=134217728
net.core.wmem_max=134217728
net.ipv4.tcp_rmem=4096 87380 67108864
net.ipv4.tcp_wmem=4096 65536 67108864

# Increase connection limits
net.core.somaxconn=8192
net.ipv4.tcp_max_syn_backlog=8192

# Enable TCP Fast Open
net.ipv4.tcp_fastopen=3

# Optimize file system
fs.file-max=2097152
vm.swappiness=10
EOF

    sysctl -p >/dev/null 2>&1
    log_success "System limits optimized"
}

configure_swap() {
    log_info "Configuring swap (8GB)..."

    # Create swap if doesn't exist
    if [ ! -f /swapfile ]; then
        fallocate -l 8G /swapfile
        chmod 600 /swapfile
        mkswap /swapfile
        swapon /swapfile
        echo '/swapfile none swap sw 0 0' >> /etc/fstab
        log_success "Swap configured (8GB)"
    else
        log_info "Swap already exists"
    fi
}

update_system() {
    log_info "Updating system packages..."
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
    log_success "System updated"
}

install_nodejs() {
    log_info "Installing Node.js 20..."
    apt-get remove -y nodejs npm 2>/dev/null || true
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs

    NODE_VERSION=$(node --version)
    NPM_VERSION=$(npm --version)
    log_success "Node.js $NODE_VERSION, npm $NPM_VERSION installed"
}

install_tools() {
    log_info "Installing essential tools..."
    apt-get install -y \
        git curl wget build-essential \
        nginx certbot python3-certbot-nginx \
        ufw htop vim
    log_success "Essential tools installed"
}

install_mongodb_local() {
    if [ "$INSTALL_MONGODB_LOCAL" != true ]; then
        return
    fi

    log_info "Installing MongoDB locally..."

    # Import MongoDB GPG key
    curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
        gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor

    # Add MongoDB repository
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | \
        tee /etc/apt/sources.list.d/mongodb-org-7.0.list

    # Install MongoDB
    apt-get update -qq
    apt-get install -y mongodb-org

    # Start and enable MongoDB
    systemctl start mongod
    systemctl enable mongod

    log_success "MongoDB installed and running locally"
}

install_pm2() {
    log_info "Installing PM2..."
    npm install -g pm2
    log_success "PM2 installed"
}

configure_firewall() {
    log_info "Configuring firewall..."
    ufw --force enable
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow ssh
    ufw allow 'Nginx Full'
    log_success "Firewall configured"
}

clone_repository() {
    log_info "Cloning repository..."
    rm -rf /var/www/multi-agents
    mkdir -p /var/www
    cd /var/www
    git clone -b "$GITHUB_BRANCH" "$GITHUB_REPO" multi-agents
    cd multi-agents
    log_success "Repository cloned"
}

install_dependencies() {
    log_info "Installing dependencies..."
    cd /var/www/multi-agents
    npm ci --production
    log_success "Dependencies installed"
}

create_env_file() {
    log_info "Creating environment file..."
    cat > /var/www/multi-agents/.env <<EOF
PORT=3001
NODE_ENV=production

MONGODB_URI=$MONGODB_URI

ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY

GITHUB_CLIENT_ID=$GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=$GITHUB_CLIENT_SECRET
GITHUB_CALLBACK_URL=https://$DOMAIN/api/auth/github/callback

JWT_SECRET=$JWT_SECRET
SESSION_SECRET=$SESSION_SECRET

FRONTEND_URL=$FRONTEND_URL

AGENT_WORKSPACE_DIR=/var/www/multi-agents/workspaces
EOF
    chmod 600 /var/www/multi-agents/.env
    log_success "Environment file created"
}

create_workspace() {
    log_info "Creating workspace directory..."
    mkdir -p /var/www/multi-agents/workspaces
    chmod 755 /var/www/multi-agents/workspaces
    log_success "Workspace created"
}

build_application() {
    log_info "Building application..."
    cd /var/www/multi-agents
    npm run build
    log_success "Application built"
}

configure_nginx_optimized() {
    log_info "Configuring Nginx (high-performance)..."

    # Optimize main nginx config
    cat > /etc/nginx/nginx.conf <<EOF
user www-data;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx.pid;

events {
    worker_connections 8192;
    use epoll;
    multi_accept on;
}

http {
    # Basic Settings
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    keepalive_requests 100;
    types_hash_max_size 2048;
    server_tokens off;

    # Buffer sizes
    client_body_buffer_size 128k;
    client_max_body_size 10m;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 16k;

    # Timeouts
    client_body_timeout 12;
    client_header_timeout 12;
    send_timeout 10;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Logging
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript
               application/json application/javascript application/xml+rss;

    # Virtual Host Configs
    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
EOF

    # Site configuration
    cat > /etc/nginx/sites-available/multi-agents <<EOF
upstream backend {
    least_conn;
    server localhost:3001 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

server {
    listen 80;
    server_name $DOMAIN;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "no-referrer-when-downgrade" always;

    location / {
        proxy_pass http://backend;
        proxy_http_version 1.1;

        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_cache_bypass \$http_upgrade;
        proxy_buffering off;

        # Long timeouts for agent operations
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_read_timeout 600s;
    }
}
EOF

    ln -sf /etc/nginx/sites-available/multi-agents /etc/nginx/sites-enabled/
    rm -f /etc/nginx/sites-enabled/default

    nginx -t
    systemctl reload nginx
    log_success "Nginx configured for high performance"
}

setup_ssl() {
    log_info "Setting up SSL certificate..."
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email "$EMAIL" --redirect
    log_success "SSL installed"
}

start_application_cluster() {
    log_info "Starting application in cluster mode ($PM2_INSTANCES instances)..."
    cd /var/www/multi-agents

    pm2 delete multi-agents 2>/dev/null || true

    # Start in cluster mode
    pm2 start npm --name "multi-agents" -i $PM2_INSTANCES -- start

    pm2 save
    pm2 startup systemd -u root --hp /root

    log_success "Application running in cluster mode with $PM2_INSTANCES instances"
}

configure_monitoring() {
    log_info "Configuring monitoring..."

    # PM2 log rotation
    pm2 install pm2-logrotate
    pm2 set pm2-logrotate:max_size 50M
    pm2 set pm2-logrotate:retain 30
    pm2 set pm2-logrotate:compress true

    log_success "Monitoring configured"
}

setup_auto_updates() {
    log_info "Setting up automatic security updates..."
    apt-get install -y unattended-upgrades
    dpkg-reconfigure -plow unattended-upgrades
    log_success "Auto-updates configured"
}

create_update_script() {
    log_info "Creating update script..."
    cat > /usr/local/bin/update-multi-agents <<'EOF'
#!/bin/bash
set -e
echo "🔄 Updating Multi-Agent Platform..."
cd /var/www/multi-agents
git pull origin main
npm ci --production
npm run build
pm2 reload multi-agents
echo "✅ Update complete!"
EOF
    chmod +x /usr/local/bin/update-multi-agents
    log_success "Update script created"
}

create_monitoring_script() {
    log_info "Creating monitoring script..."
    cat > /usr/local/bin/monitor-multi-agents <<'EOF'
#!/bin/bash
echo "═══════════════════════════════════════"
echo "  Multi-Agent Platform - System Status"
echo "═══════════════════════════════════════"
echo ""
echo "🖥️  CPU & Memory:"
echo "---"
top -bn1 | head -5
echo ""
echo "💾 Disk Usage:"
echo "---"
df -h / | tail -1
echo ""
echo "🚀 PM2 Status:"
echo "---"
pm2 status
echo ""
echo "📊 PM2 Resources:"
echo "---"
pm2 describe multi-agents | grep -E "cpu|memory|uptime"
EOF
    chmod +x /usr/local/bin/monitor-multi-agents
    log_success "Monitoring script created"
}

print_summary() {
    echo ""
    echo "═══════════════════════════════════════════════════════════"
    echo "  🎉 HIGH-PERFORMANCE DEPLOYMENT COMPLETE!"
    echo "═══════════════════════════════════════════════════════════"
    echo ""
    log_success "Multi-Agent Platform is running in cluster mode!"
    echo ""
    echo "📍 Application: https://$DOMAIN"
    echo "💪 PM2 Instances: $PM2_INSTANCES (cluster mode)"
    echo "🖥️  CPU Cores: $CPU_CORES"
    echo "💾 RAM: ${RAM_GB}GB"
    if [ "$INSTALL_MONGODB_LOCAL" = true ]; then
        echo "🍃 MongoDB: Local (high performance)"
    else
        echo "🍃 MongoDB: Atlas (cloud)"
    fi
    echo ""
    echo "Useful commands:"
    echo "  pm2 status                    - Application status"
    echo "  pm2 monit                     - Real-time monitoring"
    echo "  pm2 logs multi-agents         - View logs"
    echo "  pm2 reload multi-agents       - Zero-downtime reload"
    echo "  update-multi-agents           - Update application"
    echo "  monitor-multi-agents          - System monitoring"
    echo "  htop                          - Resource monitor"
    echo ""
    echo "Configuration:"
    echo "  App: /var/www/multi-agents"
    echo "  Env: /var/www/multi-agents/.env"
    echo "  Nginx: /etc/nginx/sites-available/multi-agents"
    echo "  Workspaces: /var/www/multi-agents/workspaces"
    echo ""
    log_highlight "Your server is optimized for maximum performance! 🚀"
    echo ""
}

main() {
    print_banner
    check_root
    detect_hardware
    gather_info

    log_highlight "Starting high-performance deployment..."
    echo ""

    optimize_system_limits
    configure_swap
    update_system
    install_nodejs
    install_tools
    install_mongodb_local
    install_pm2
    configure_firewall
    clone_repository
    install_dependencies
    create_env_file
    create_workspace
    build_application
    configure_nginx_optimized
    setup_ssl
    start_application_cluster
    configure_monitoring
    setup_auto_updates
    create_update_script
    create_monitoring_script

    print_summary
}

main
