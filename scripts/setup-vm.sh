#!/bin/bash
#
# 🚀 Multi-Agent Platform - VM Setup Script
#
# USO:
#   curl -fsSL https://raw.githubusercontent.com/tu-usuario/agents-software-arq/main/scripts/setup-vm.sh | bash -s -- \
#     --anthropic-key "sk-ant-xxx" \
#     --github-token "ghp_xxx" \
#     --backend-repo "https://github.com/tu-usuario/agents-software-arq.git" \
#     --frontend-repo "https://github.com/tu-usuario/multi-agent-frontend.git"
#
# O descarga y ejecuta:
#   chmod +x setup-vm.sh
#   ./setup-vm.sh --anthropic-key "sk-ant-xxx" --github-token "ghp_xxx"
#

set -e

# ============================================================================
# COLORES
# ============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[✅]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[⚠️]${NC} $1"; }
log_error() { echo -e "${RED}[❌]${NC} $1"; }

# ============================================================================
# VALORES POR DEFECTO
# ============================================================================
ANTHROPIC_API_KEY=""
GITHUB_TOKEN=""
BACKEND_REPO="https://github.com/Luiscorea10/agents-software-arq.git"
FRONTEND_REPO="https://github.com/Luiscorea10/multi-agent-frontend.git"
INSTALL_DIR="$HOME"
BACKEND_PORT=3001
FRONTEND_PORT=3000
MONGODB_PORT=27017

# ============================================================================
# PARSEAR ARGUMENTOS
# ============================================================================
while [[ $# -gt 0 ]]; do
  case $1 in
    --anthropic-key)
      ANTHROPIC_API_KEY="$2"
      shift 2
      ;;
    --github-token)
      GITHUB_TOKEN="$2"
      shift 2
      ;;
    --backend-repo)
      BACKEND_REPO="$2"
      shift 2
      ;;
    --frontend-repo)
      FRONTEND_REPO="$2"
      shift 2
      ;;
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --anthropic-key KEY    Anthropic API key (required)"
      echo "  --github-token TOKEN   GitHub token for private repos"
      echo "  --backend-repo URL     Backend repository URL"
      echo "  --frontend-repo URL    Frontend repository URL"
      echo "  --install-dir DIR      Installation directory (default: \$HOME)"
      echo ""
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ============================================================================
# VALIDACIONES
# ============================================================================
if [ -z "$ANTHROPIC_API_KEY" ]; then
  log_error "Anthropic API key is required!"
  echo ""
  echo "Usage: $0 --anthropic-key 'sk-ant-xxx' [--github-token 'ghp_xxx']"
  exit 1
fi

# ============================================================================
# BANNER
# ============================================================================
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  🚀 Multi-Agent Platform - VM Setup                            ║"
echo "║  32GB RAM ARM64 Optimized                                      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ============================================================================
# 1. DEPENDENCIAS DEL SISTEMA
# ============================================================================
log_info "[1/9] Installing system dependencies..."

sudo apt update
sudo apt install -y \
  curl \
  git \
  docker.io \
  docker-compose \
  build-essential \
  ca-certificates \
  gnupg

log_success "System dependencies installed"

# ============================================================================
# 2. DOCKER
# ============================================================================
log_info "[2/9] Configuring Docker..."

sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER

# Aplicar grupo sin relogin
if ! groups | grep -q docker; then
  log_warn "Docker group added. Using sudo for docker commands in this session."
fi

log_success "Docker configured"

# ============================================================================
# 3. NODE.JS 20 LTS
# ============================================================================
log_info "[3/9] Installing Node.js 20 LTS..."

if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d 'v') -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt install -y nodejs
fi

log_success "Node.js $(node -v) installed"

# ============================================================================
# 4. MONGODB (Docker)
# ============================================================================
log_info "[4/9] Starting MongoDB..."

# Parar y eliminar si existe
sudo docker stop mongodb 2>/dev/null || true
sudo docker rm mongodb 2>/dev/null || true

# Crear volumen para persistencia
sudo docker volume create mongodb_data 2>/dev/null || true

# Iniciar MongoDB con persistencia
sudo docker run -d \
  --name mongodb \
  --restart unless-stopped \
  -p ${MONGODB_PORT}:27017 \
  -v mongodb_data:/data/db \
  mongo:6

# Esperar a que esté listo
log_info "Waiting for MongoDB to be ready..."
sleep 5
until sudo docker exec mongodb mongosh --eval "db.adminCommand('ping')" &>/dev/null; do
  sleep 2
done

log_success "MongoDB running on port ${MONGODB_PORT}"

# ============================================================================
# 5. CLONAR BACKEND
# ============================================================================
log_info "[5/9] Cloning backend repository..."

cd "$INSTALL_DIR"

# Limpiar instalación anterior
rm -rf agents-software-arq

# Construir URL con token si es privado
if [ -n "$GITHUB_TOKEN" ]; then
  # Insertar token en URL: https://TOKEN@github.com/user/repo.git
  BACKEND_URL=$(echo "$BACKEND_REPO" | sed "s|https://|https://${GITHUB_TOKEN}@|")
else
  BACKEND_URL="$BACKEND_REPO"
fi

git clone "$BACKEND_URL" agents-software-arq
cd agents-software-arq

log_success "Backend cloned"

# ============================================================================
# 6. CONFIGURAR BACKEND
# ============================================================================
log_info "[6/9] Configuring backend..."

# Crear .env
cat > .env << EOF
# === API Keys ===
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
GITHUB_TOKEN=${GITHUB_TOKEN}

# === Server ===
PORT=${BACKEND_PORT}
NODE_ENV=production

# === Database ===
MONGODB_URI=mongodb://localhost:${MONGODB_PORT}/agents

# === Paths ===
WORKSPACE_BASE_PATH=${INSTALL_DIR}/agent-workspace

# === Optional ===
# ENABLE_AUTO_MERGE=false
# MAX_COST_PER_TASK=50.00
EOF

# Crear directorio de workspace
mkdir -p "${INSTALL_DIR}/agent-workspace"

# Instalar dependencias
npm install

# Build
npm run build

log_success "Backend configured"

# ============================================================================
# 7. CLONAR FRONTEND
# ============================================================================
log_info "[7/9] Cloning frontend repository..."

cd "$INSTALL_DIR"

# Limpiar instalación anterior
rm -rf multi-agent-frontend

# Construir URL con token si es privado
if [ -n "$GITHUB_TOKEN" ]; then
  FRONTEND_URL=$(echo "$FRONTEND_REPO" | sed "s|https://|https://${GITHUB_TOKEN}@|")
else
  FRONTEND_URL="$FRONTEND_REPO"
fi

git clone "$FRONTEND_URL" multi-agent-frontend
cd multi-agent-frontend

log_success "Frontend cloned"

# ============================================================================
# 8. CONFIGURAR FRONTEND
# ============================================================================
log_info "[8/9] Configuring frontend..."

# Obtener IP pública
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s icanhazip.com 2>/dev/null || echo "localhost")

# Crear .env
cat > .env << EOF
REACT_APP_API_URL=http://${PUBLIC_IP}:${BACKEND_PORT}
REACT_APP_SOCKET_URL=http://${PUBLIC_IP}:${BACKEND_PORT}
EOF

# Instalar dependencias
npm install

# Build
npm run build

# Instalar serve globalmente para servir el build
sudo npm install -g serve

log_success "Frontend configured"

# ============================================================================
# 9. CREAR SERVICIOS SYSTEMD
# ============================================================================
log_info "[9/9] Creating systemd services..."

# Backend service
sudo tee /etc/systemd/system/agents-backend.service > /dev/null << EOF
[Unit]
Description=Multi-Agent Backend
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=$USER
WorkingDirectory=${INSTALL_DIR}/agents-software-arq
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# Frontend service
sudo tee /etc/systemd/system/agents-frontend.service > /dev/null << EOF
[Unit]
Description=Multi-Agent Frontend
After=network.target agents-backend.service

[Service]
Type=simple
User=$USER
WorkingDirectory=${INSTALL_DIR}/multi-agent-frontend
ExecStart=/usr/bin/serve -s build -l ${FRONTEND_PORT}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Recargar systemd
sudo systemctl daemon-reload

# Habilitar servicios para inicio automático
sudo systemctl enable agents-backend
sudo systemctl enable agents-frontend

# Iniciar servicios
sudo systemctl start agents-backend
sleep 5
sudo systemctl start agents-frontend

log_success "Systemd services created and started"

# ============================================================================
# CREAR SCRIPTS DE UTILIDAD
# ============================================================================
log_info "Creating utility scripts..."

# Script de status
cat > "${INSTALL_DIR}/agents-status.sh" << 'EOF'
#!/bin/bash
echo "=== Multi-Agent Platform Status ==="
echo ""
echo "📦 Services:"
systemctl status agents-backend --no-pager -l | head -5
echo ""
systemctl status agents-frontend --no-pager -l | head -5
echo ""
echo "🐳 Docker:"
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""
echo "💾 Disk:"
df -h / | tail -1
echo ""
echo "🧠 Memory:"
free -h | head -2
EOF
chmod +x "${INSTALL_DIR}/agents-status.sh"

# Script de logs
cat > "${INSTALL_DIR}/agents-logs.sh" << 'EOF'
#!/bin/bash
case "$1" in
  backend)
    journalctl -u agents-backend -f
    ;;
  frontend)
    journalctl -u agents-frontend -f
    ;;
  mongo)
    docker logs -f mongodb
    ;;
  *)
    echo "Usage: $0 {backend|frontend|mongo}"
    exit 1
    ;;
esac
EOF
chmod +x "${INSTALL_DIR}/agents-logs.sh"

# Script de restart
cat > "${INSTALL_DIR}/agents-restart.sh" << 'EOF'
#!/bin/bash
echo "Restarting services..."
sudo systemctl restart agents-backend
sleep 3
sudo systemctl restart agents-frontend
echo "Done!"
EOF
chmod +x "${INSTALL_DIR}/agents-restart.sh"

# Script de update
cat > "${INSTALL_DIR}/agents-update.sh" << 'EOF'
#!/bin/bash
echo "Updating Multi-Agent Platform..."

# Backend
cd ~/agents-software-arq
git pull
npm install
npm run build
sudo systemctl restart agents-backend

# Frontend
cd ~/multi-agent-frontend
git pull
npm install
npm run build
sudo systemctl restart agents-frontend

echo "Update complete!"
EOF
chmod +x "${INSTALL_DIR}/agents-update.sh"

# ============================================================================
# FIREWALL (opcional)
# ============================================================================
if command -v ufw &> /dev/null; then
  log_info "Configuring firewall..."
  sudo ufw allow ${FRONTEND_PORT}/tcp
  sudo ufw allow ${BACKEND_PORT}/tcp
  log_success "Firewall configured"
fi

# ============================================================================
# RESUMEN FINAL
# ============================================================================
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  ✅ INSTALLATION COMPLETE!                                      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "🌐 Access your platform:"
echo "   Frontend: http://${PUBLIC_IP}:${FRONTEND_PORT}"
echo "   Backend:  http://${PUBLIC_IP}:${BACKEND_PORT}"
echo ""
echo "📜 Utility commands:"
echo "   ~/agents-status.sh      - Check status"
echo "   ~/agents-logs.sh backend - View backend logs"
echo "   ~/agents-logs.sh frontend - View frontend logs"
echo "   ~/agents-restart.sh     - Restart all services"
echo "   ~/agents-update.sh      - Pull & rebuild from git"
echo ""
echo "🔧 Systemd commands:"
echo "   sudo systemctl status agents-backend"
echo "   sudo systemctl status agents-frontend"
echo "   sudo systemctl restart agents-backend"
echo ""
echo "⚠️  If services don't start, check logs:"
echo "   journalctl -u agents-backend -f"
echo ""
