#!/bin/bash

# ================================================================
# VULTR DEPLOYMENT - Multi-Agent Platform (TypeScript)
# ================================================================
# Powered by Claude Agent SDK
# ================================================================

set -e

echo "🚀 INICIANDO DESPLIEGUE EN VULTR..."

# 1. Actualizar sistema
echo "📦 Actualizando sistema..."
apt update && apt upgrade -y

# 2. Instalar dependencias base
echo "🔧 Instalando dependencias..."
apt install -y curl git build-essential nginx

# 3. Instalar Node.js 20
echo "📥 Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 4. Verificar versión de Node
echo "✅ Node version: $(node --version)"
echo "✅ NPM version: $(npm --version)"

# 5. Instalar PM2
echo "⚙️ Instalando PM2..."
npm install -g pm2

# 6. Clonar repositorio
echo "📂 Clonando repositorio..."
mkdir -p /var/www
cd /var/www
rm -rf multi-agents
git clone https://github.com/devwspito/multi-agents-backend.git multi-agents

# 7. Instalar dependencias TypeScript
echo "📚 Instalando dependencias..."
cd /var/www/multi-agents/backend-ts
npm install

# 8. Crear .env
echo "🔐 Creando variables de entorno..."
cat > .env << 'EOF'
MONGODB_URI=mongodb+srv://luifer1313correa:lol1313lol@cluster0.hjx7z.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
ANTHROPIC_API_KEY=sk-ant-api03-IWFZ0cV6mCMnLh70WOhqUz5NQnKy0IzE4s5kjxsFGb8Tl_9MdMNwyGZFCqR12sTT-vdmvDyJ4w-RvxMQgAA
GITHUB_CLIENT_ID=Ov23li1r0teSKy6wRCTj
GITHUB_CLIENT_SECRET=56e4aa7e967d7fe2bb967c09c59f8c78a27c3daa
JWT_SECRET=super-secret-jwt-key-12345-change-in-production-min-32-chars
SESSION_SECRET=session-secret-key-12345-change-in-production-min-32-chars
FRONTEND_URL=https://multi-agents-d6279.web.app
PORT=3001
NODE_ENV=production
EOF

# 9. Build TypeScript
echo "🏗️ Building TypeScript..."
npm run build

# 10. Configurar Nginx
echo "🌐 Configurando Nginx..."
cat > /etc/nginx/sites-available/default << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    add_header Access-Control-Allow-Origin "https://multi-agents-d6279.web.app" always;
    add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Origin, X-Requested-With, Content-Type, Accept, Authorization" always;
    add_header Access-Control-Allow-Credentials "true" always;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 600s;
        proxy_connect_timeout 600s;
        proxy_send_timeout 600s;
        proxy_cache_bypass $http_upgrade;
    }

    client_max_body_size 100M;
    client_body_timeout 600s;
}
EOF

nginx -t
systemctl restart nginx
systemctl enable nginx

# 11. Configurar firewall
echo "🔥 Configurando firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 12. Crear directorio para agentes
mkdir -p /tmp/agent-workspace

# 13. Iniciar con PM2
echo "🚀 Iniciando aplicación..."
cd /var/www/multi-agents/backend-ts
pm2 delete all 2>/dev/null || true
pm2 start dist/index.js --name "multi-agents-ts" --time
pm2 save
pm2 startup systemd -u root --hp /root

# 14. Resultado
echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ DESPLIEGUE COMPLETADO"
echo "════════════════════════════════════════════════════════"
echo ""
echo "🌐 Tu aplicación está en: http://$(curl -s ifconfig.me)"
echo ""
echo "📊 Comandos útiles:"
echo "   pm2 status           - Ver estado"
echo "   pm2 logs             - Ver logs"
echo "   pm2 restart all      - Reiniciar"
echo "   pm2 monit            - Monitor en tiempo real"
echo ""
echo "🔧 Archivos:"
echo "   App: /var/www/multi-agents/backend-ts/dist/index.js"
echo "   Env: /var/www/multi-agents/backend-ts/.env"
echo "   Nginx: /etc/nginx/sites-available/default"
echo ""
echo "🤖 Claude Agent SDK: ✅ ACTIVO"
echo "   - TypeScript: ✅"
echo "   - 6 Agentes especializados: ✅"
echo "   - Sistema de archivos real: ✅"
echo "   - Bash real: ✅"
echo "════════════════════════════════════════════════════════"
