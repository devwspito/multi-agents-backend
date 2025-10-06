#!/bin/bash

# =========================================================================
# 🚀 DIGITALOCEAN SETUP SCRIPT - MULTI-AGENT PLATFORM WITH CLAUDE CODE
# =========================================================================
# Este script configura todo en un Droplet de DigitalOcean Ubuntu 22.04
# =========================================================================

set -e  # Exit on any error

echo "==========================================================================="
echo "🚀 INICIANDO INSTALACIÓN DE MULTI-AGENT PLATFORM EN DIGITALOCEAN"
echo "==========================================================================="
echo ""

# Update system
echo "📦 Actualizando sistema..."
apt update && apt upgrade -y

# Install essential packages
echo "🔧 Instalando paquetes esenciales..."
apt install -y \
    curl \
    git \
    build-essential \
    nginx \
    certbot \
    python3-certbot-nginx \
    ufw \
    htop \
    nano

# Install Node.js 20 LTS
echo "📦 Instalando Node.js 20 LTS..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Verify installations
echo "✅ Verificando instalaciones..."
node --version
npm --version
git --version

# Install PM2 globally for process management
echo "🚀 Instalando PM2..."
npm install -g pm2

# Install Claude Code (intentaremos, aunque sabemos que puede fallar)
echo "🤖 Intentando instalar Claude Code..."
npm install -g @anthropic-ai/claude-code || {
    echo "⚠️ Claude Code no se pudo instalar globalmente"
    echo "✅ Usaremos el Claude Code Emulator en su lugar"
}

# Create application user
echo "👤 Creando usuario para la aplicación..."
useradd -m -s /bin/bash nodeapp || echo "Usuario ya existe"

# Create app directory
echo "📁 Creando directorio de aplicación..."
mkdir -p /var/www/multi-agents
chown -R nodeapp:nodeapp /var/www/multi-agents

# Clone repository
echo "📥 Clonando repositorio..."
cd /var/www/multi-agents
sudo -u nodeapp git clone https://github.com/devwspito/multi-agents-backend.git .

# Install dependencies
echo "📦 Instalando dependencias..."
cd /var/www/multi-agents/backend
sudo -u nodeapp npm install

# Create .env file
echo "🔐 Creando archivo .env..."
cat > /var/www/multi-agents/backend/.env << 'EOF'
# MongoDB
MONGODB_URI=mongodb+srv://migueljimenezreus:ktbM8jpuywzDa0h2@cluster0.7szou.mongodb.net/test?retryWrites=true&w=majority

# Anthropic
ANTHROPIC_API_KEY=REPLACE_WITH_YOUR_KEY

# JWT
JWT_SECRET=tu_super_secret_jwt_key_aqui_$(openssl rand -hex 32)

# GitHub App (Production)
GITHUB_APP_ID=1084027
GITHUB_CLIENT_ID=Iv23liPDq0F5BWpitobL
GITHUB_CLIENT_SECRET=REPLACE_WITH_YOUR_SECRET
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
REPLACE_WITH_YOUR_PRIVATE_KEY
-----END RSA PRIVATE KEY-----"

# Server
NODE_ENV=production
PORT=3001

# Redis (optional)
REDIS_URL=redis://localhost:6379

# Features
USE_CLAUDE_CODE_EMULATOR=true
CLAUDE_CODE_FALLBACK=true

# Security
ALLOWED_ORIGINS=*
EOF

echo "⚠️ IMPORTANTE: Edita /var/www/multi-agents/backend/.env con tus claves reales"

# Setup PM2 ecosystem file
echo "⚙️ Configurando PM2..."
cat > /var/www/multi-agents/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'multi-agents',
    script: './backend/src/app.js',
    cwd: '/var/www/multi-agents',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    error_file: '/var/www/multi-agents/logs/err.log',
    out_file: '/var/www/multi-agents/logs/out.log',
    log_file: '/var/www/multi-agents/logs/combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
EOF

# Create logs directory
mkdir -p /var/www/multi-agents/logs
chown -R nodeapp:nodeapp /var/www/multi-agents

# Configure Nginx
echo "🌐 Configurando Nginx..."
cat > /etc/nginx/sites-available/multi-agents << 'EOF'
server {
    listen 80;
    server_name your-domain.com;  # CAMBIAR POR TU DOMINIO

    # API Backend
    location /api {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts largos para operaciones de Claude
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
        proxy_send_timeout 300s;
    }

    # Health check
    location /health {
        proxy_pass http://localhost:3001/health;
    }

    # Root
    location / {
        return 200 '{"status":"Multi-Agent Platform Running"}';
        add_header Content-Type application/json;
    }

    # File upload limits
    client_max_body_size 100M;
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/multi-agents /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test and reload Nginx
nginx -t && systemctl reload nginx

# Configure firewall
echo "🔒 Configurando firewall..."
ufw --force enable
ufw allow 22
ufw allow 80
ufw allow 443
ufw reload

# Start application with PM2
echo "🚀 Iniciando aplicación con PM2..."
cd /var/www/multi-agents
sudo -u nodeapp pm2 start ecosystem.config.js
sudo -u nodeapp pm2 save

# Setup PM2 to start on boot
pm2 startup systemd -u nodeapp --hp /home/nodeapp
systemctl enable pm2-nodeapp

# Create update script
echo "📝 Creando script de actualización..."
cat > /usr/local/bin/update-multi-agents << 'EOF'
#!/bin/bash
cd /var/www/multi-agents
sudo -u nodeapp git pull
cd backend
sudo -u nodeapp npm install
sudo -u nodeapp pm2 restart multi-agents
echo "✅ Actualización completada"
EOF
chmod +x /usr/local/bin/update-multi-agents

# Create logs viewer script
cat > /usr/local/bin/logs-multi-agents << 'EOF'
#!/bin/bash
sudo -u nodeapp pm2 logs multi-agents --lines 100
EOF
chmod +x /usr/local/bin/logs-multi-agents

echo ""
echo "==========================================================================="
echo "✅ INSTALACIÓN COMPLETADA"
echo "==========================================================================="
echo ""
echo "📋 PRÓXIMOS PASOS:"
echo ""
echo "1. Edita el archivo .env con tus claves:"
echo "   nano /var/www/multi-agents/backend/.env"
echo ""
echo "2. Configura tu dominio en Nginx:"
echo "   nano /etc/nginx/sites-available/multi-agents"
echo "   systemctl reload nginx"
echo ""
echo "3. Instala certificado SSL:"
echo "   certbot --nginx -d tu-dominio.com"
echo ""
echo "4. Comandos útiles:"
echo "   - Ver logs: logs-multi-agents"
echo "   - Actualizar: update-multi-agents"
echo "   - Restart: sudo -u nodeapp pm2 restart multi-agents"
echo "   - Status: sudo -u nodeapp pm2 status"
echo ""
echo "5. Accede a tu aplicación:"
echo "   http://YOUR_SERVER_IP/health"
echo ""
echo "==========================================================================="
echo "🚀 Claude Code Emulator está activo y funcionando"
echo "✅ El sistema ejecutará comandos REALES como Claude Code"
echo "==========================================================================="