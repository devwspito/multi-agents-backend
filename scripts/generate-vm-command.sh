#!/bin/bash
#
# Genera el comando de setup para la VM usando tu .env local
# EJECUTAR DESDE TU MÁQUINA LOCAL (no la VM)
#
# Uso:
#   ./scripts/generate-vm-command.sh
#
# Resultado: Te muestra los comandos para ejecutar en la VM
#

set -e

# Colores
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Cargar .env local
if [ -f ".env" ]; then
  source .env 2>/dev/null || true
elif [ -f "../.env" ]; then
  source ../.env 2>/dev/null || true
else
  echo "❌ No encontré archivo .env"
  exit 1
fi

# Verificar variables críticas
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "❌ ANTHROPIC_API_KEY no está definida en .env"
  exit 1
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  🚀 Generador de Comandos para VM                              ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo -e "${YELLOW}Copia y pega estos comandos en tu VM:${NC}"
echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""

cat << 'SETUPCMD'
# 1. Instalar dependencias básicas
sudo apt update && sudo apt install -y curl git docker.io docker-compose build-essential

# 2. Configurar Docker
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker $USER

# 3. Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Clonar repositorios
cd ~
SETUPCMD

# GitHub token para repos privados
if [ -n "$GITHUB_TOKEN" ]; then
  echo "git clone https://${GITHUB_TOKEN}@github.com/Luiscorea10/agents-software-arq.git"
  echo "git clone https://${GITHUB_TOKEN}@github.com/Luiscorea10/multi-agent-frontend.git"
else
  echo "git clone https://github.com/Luiscorea10/agents-software-arq.git"
  echo "git clone https://github.com/Luiscorea10/multi-agent-frontend.git"
fi

echo ""
echo "# 5. Crear .env del backend"
echo "cd ~/agents-software-arq"
echo "cat > .env << 'ENVFILE'"

# Generar .env completo (sin MongoDB)
cat << ENVEOF
NODE_ENV=production
PORT=3001
BASE_URL=http://localhost:3001

# JWT
JWT_SECRET=${JWT_SECRET:-your-super-secure-jwt-secret}
JWT_ACCESS_EXPIRE=1h
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET:-your-refresh-secret}
JWT_REFRESH_EXPIRE=7d
JWT_EXPIRE=7d

# Claude API
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}

# Workspace
WORKSPACE_BASE=./workspaces
UPLOAD_DIR=./uploads
AGENT_WORKSPACE_DIR=/home/\$USER/agent-workspace-prod

# Docker (Linux = host mode)
DOCKER_USE_BRIDGE_MODE=false

# Redis
REDIS_URL=${REDIS_URL:-}

# GitHub OAuth
GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-}
GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-}

# GitHub App
GITHUB_APP_ID=${GITHUB_APP_ID:-}
GITHUB_PRIVATE_KEY="${GITHUB_PRIVATE_KEY:-}"
GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET:-}
GITHUB_INSTALLATION_ID=${GITHUB_INSTALLATION_ID:-}

# Security
SESSION_SECRET=${SESSION_SECRET:-your-session-secret}
REQUIRE_EMAIL_VERIFICATION=false
RATE_LIMIT_WINDOW=900000

# Feature Flags
ENABLE_PERFORMANCE_CACHE=true
ENABLE_FILE_CONTENT_CACHE=true
ENABLE_CIRCUIT_BREAKER=true
ENABLE_GITHUB_RATE_LIMITER=true
ENABLE_GITHUB_CHECKS=true
ENABLE_ENHANCED_GIT_EXECUTION=true
ENABLE_AGGRESSIVE_COMPACTION=true
ENABLE_DYNAMIC_PARALLELISM=true

# Encryption
ENV_ENCRYPTION_KEY=${ENV_ENCRYPTION_KEY:-}

# Voyage AI
VOYAGE_API_KEY=${VOYAGE_API_KEY:-}
API_KEYS=${API_KEYS:-sk-test-key}

# Firebase
FIREBASE_STORAGE_BUCKET=${FIREBASE_STORAGE_BUCKET:-}
FIREBASE_SERVICE_ACCOUNT=${FIREBASE_SERVICE_ACCOUNT:-}
ENVEOF

echo "ENVFILE"
echo ""

cat << 'RESTCMD'
# Actualizar FRONTEND_URL con IP pública
PUBLIC_IP=$(curl -s ifconfig.me)
echo "FRONTEND_URL=http://${PUBLIC_IP}:3000" >> .env

# 6. Instalar y compilar backend
npm install && npm run build

# 7. Configurar frontend
cd ~/multi-agent-frontend
PUBLIC_IP=$(curl -s ifconfig.me)
cat > .env << EOF
REACT_APP_API_URL=http://${PUBLIC_IP}:3001
REACT_APP_SOCKET_URL=http://${PUBLIC_IP}:3001
EOF
npm install && npm run build
sudo npm install -g serve

# 8. Crear servicios systemd
sudo tee /etc/systemd/system/agents-backend.service > /dev/null << 'SVCEOF'
[Unit]
Description=Multi-Agent Backend
After=network.target docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=/home/$USER/agents-software-arq
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SVCEOF

sudo tee /etc/systemd/system/agents-frontend.service > /dev/null << 'SVCEOF'
[Unit]
Description=Multi-Agent Frontend
After=network.target agents-backend.service

[Service]
Type=simple
User=$USER
WorkingDirectory=/home/$USER/multi-agent-frontend
ExecStart=/usr/bin/serve -s build -l 3000
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

# Reemplazar $USER en los servicios
sudo sed -i "s/\$USER/$USER/g" /etc/systemd/system/agents-backend.service
sudo sed -i "s/\$USER/$USER/g" /etc/systemd/system/agents-frontend.service

# 9. Iniciar servicios
sudo systemctl daemon-reload
sudo systemctl enable agents-backend agents-frontend
sudo systemctl start agents-backend
sleep 5
sudo systemctl start agents-frontend

# 10. Crear workspace
mkdir -p ~/agent-workspace-prod

# 11. Verificar
echo ""
echo "✅ Instalación completada!"
echo ""
PUBLIC_IP=$(curl -s ifconfig.me)
echo "🌐 Frontend: http://${PUBLIC_IP}:3000"
echo "🔧 Backend:  http://${PUBLIC_IP}:3001"
echo ""
echo "📜 Comandos útiles:"
echo "   sudo systemctl status agents-backend"
echo "   sudo systemctl status agents-frontend"
echo "   journalctl -u agents-backend -f"
RESTCMD

echo ""
echo "════════════════════════════════════════════════════════════════"
echo ""
echo -e "${GREEN}✅ Copia todo lo anterior y pégalo en tu VM${NC}"
echo ""
