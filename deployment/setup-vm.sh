#!/bin/bash
# VM Setup Script for AI Development Team
# Run as root on a fresh Ubuntu 22.04 VM

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  AI Development Team - VM Setup${NC}"
echo -e "${GREEN}========================================${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo ./setup-vm.sh)${NC}"
    exit 1
fi

# Get configuration from user
read -p "Enter domain name (e.g., client-name.aidevteam.com): " DOMAIN
read -p "Enter client name (for reference): " CLIENT_NAME
read -p "Enter admin email (for SSL certificates): " ADMIN_EMAIL

# Update system
echo -e "${YELLOW}Updating system packages...${NC}"
apt update && apt upgrade -y

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
apt install -y curl git nginx certbot python3-certbot-nginx ufw

# Install Node.js 20 LTS
echo -e "${YELLOW}Installing Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install MongoDB 7
echo -e "${YELLOW}Installing MongoDB 7...${NC}"
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | tee /etc/apt/sources.list.d/mongodb-org-7.0.list
apt update
apt install -y mongodb-org
systemctl start mongod
systemctl enable mongod

# Install PM2 for process management
echo -e "${YELLOW}Installing PM2...${NC}"
npm install -g pm2

# Create app user
echo -e "${YELLOW}Creating app user...${NC}"
useradd -m -s /bin/bash aidevteam || true
mkdir -p /home/aidevteam/app
chown -R aidevteam:aidevteam /home/aidevteam

# Clone or copy the application
echo -e "${YELLOW}Setting up application...${NC}"
# Note: Replace with actual git clone command
# git clone https://github.com/your-org/ai-dev-team.git /home/aidevteam/app

# Create environment file
echo -e "${YELLOW}Creating environment configuration...${NC}"
cat > /home/aidevteam/app/.env << EOF
# AI Development Team Configuration
NODE_ENV=production
PORT=3001

# MongoDB (local)
MONGODB_URI=mongodb://localhost:27017/aidevteam_${CLIENT_NAME}

# Anthropic API - CLIENT PROVIDES THIS
ANTHROPIC_API_KEY=

# GitHub OAuth - CREATE APP FOR CLIENT
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=https://${DOMAIN}/api/auth/github/callback

# JWT Secret (auto-generated)
JWT_SECRET=$(openssl rand -base64 32)

# Domain
DOMAIN=${DOMAIN}

# Security
CORS_ORIGIN=https://${DOMAIN}
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Health monitoring
HEALTH_CHECK_INTERVAL=60000
EOF

chown aidevteam:aidevteam /home/aidevteam/app/.env
chmod 600 /home/aidevteam/app/.env

# Configure Nginx
echo -e "${YELLOW}Configuring Nginx...${NC}"
cat > /etc/nginx/sites-available/aidevteam << EOF
upstream backend {
    server 127.0.0.1:3001;
    keepalive 32;
}

limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_conn_zone \$binary_remote_addr zone=conn_limit:10m;

server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$server_name\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    # SSL will be configured by certbot

    limit_req zone=api_limit burst=20 nodelay;
    limit_conn conn_limit 10;

    location /api/ {
        proxy_pass http://backend/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
    }

    location /socket.io/ {
        proxy_pass http://backend/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400s;
    }

    location /health {
        limit_req off;
        proxy_pass http://backend/health;
    }

    location ~ /\. {
        deny all;
    }
}
EOF

ln -sf /etc/nginx/sites-available/aidevteam /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Configure firewall
echo -e "${YELLOW}Configuring firewall...${NC}"
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 'Nginx Full'
ufw --force enable

# Get SSL certificate
echo -e "${YELLOW}Obtaining SSL certificate...${NC}"
certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m ${ADMIN_EMAIL}

# Create PM2 ecosystem file
cat > /home/aidevteam/app/ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'aidevteam',
    script: 'dist/index.js',
    cwd: '/home/aidevteam/app',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/home/aidevteam/logs/error.log',
    out_file: '/home/aidevteam/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# Create logs directory
mkdir -p /home/aidevteam/logs
chown -R aidevteam:aidevteam /home/aidevteam/logs

# Setup PM2 to start on boot
su - aidevteam -c "cd /home/aidevteam/app && npm install && npm run build"
su - aidevteam -c "pm2 start /home/aidevteam/app/ecosystem.config.js"
su - aidevteam -c "pm2 save"
env PATH=$PATH:/usr/bin pm2 startup systemd -u aidevteam --hp /home/aidevteam

# Restart services
echo -e "${YELLOW}Restarting services...${NC}"
nginx -t && systemctl restart nginx

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Setup Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "1. Add the Anthropic API key to /home/aidevteam/app/.env"
echo "2. Create a GitHub OAuth app for ${DOMAIN}"
echo "3. Add GitHub credentials to /home/aidevteam/app/.env"
echo "4. Restart the app: su - aidevteam -c 'pm2 restart aidevteam'"
echo ""
echo -e "${GREEN}Your API is available at: https://${DOMAIN}/api${NC}"
echo -e "${GREEN}Developers can connect using: aidev --api-url https://${DOMAIN}/api${NC}"
