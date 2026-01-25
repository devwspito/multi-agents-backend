# Guía de Deployment: Multi-Agent Platform en Google Cloud VM

> **Fecha**: Enero 2025
> **VM**: Google Cloud - 32GB RAM ARM64
> **Dominio**: multiagent.duckdns.org
> **IP**: 35.225.224.17

---

## Tabla de Contenidos

1. [Requisitos Previos](#1-requisitos-previos)
2. [Crear la VM en Google Cloud](#2-crear-la-vm-en-google-cloud)
3. [Configurar DuckDNS](#3-configurar-duckdns)
4. [Script de Instalación Completo](#4-script-de-instalación-completo)
5. [Configurar HTTPS con Caddy](#5-configurar-https-con-caddy)
6. [Configurar Firewall](#6-configurar-firewall)
7. [Verificación](#7-verificación)
8. [Comandos Útiles](#8-comandos-útiles)
9. [Troubleshooting](#9-troubleshooting)
10. [Seguridad](#10-seguridad)

---

## 1. Requisitos Previos

### En tu máquina local necesitas:
- [ ] Archivo `.env` con todas las credenciales
- [ ] `gcloud` CLI instalado y configurado
- [ ] GitHub Personal Access Token (PAT) con permisos de repo

### Credenciales necesarias en `.env`:
```env
ANTHROPIC_API_KEY=sk-ant-...
JWT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_APP_ID=...
GITHUB_PRIVATE_KEY=...
REDIS_URL=... (opcional)
```

---

## 2. Crear la VM en Google Cloud

### Opción A: Google Cloud Console
1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Compute Engine → VM instances → Create Instance
3. Configuración recomendada:
   - **Nombre**: `multi-agent-vm`
   - **Región**: `us-central1-b`
   - **Tipo de máquina**: `e2-standard-8` (8 vCPU, 32GB RAM)
   - **Boot disk**: Ubuntu 22.04 LTS, 100GB SSD
   - **Firewall**: Permitir HTTP y HTTPS

### Opción B: gcloud CLI
```bash
gcloud compute instances create multi-agent-vm \
    --zone=us-central1-b \
    --machine-type=e2-standard-8 \
    --image-family=ubuntu-2204-lts \
    --image-project=ubuntu-os-cloud \
    --boot-disk-size=100GB \
    --boot-disk-type=pd-ssd \
    --tags=http-server,https-server
```

### Conectar a la VM
```bash
gcloud compute ssh multi-agent-vm --zone=us-central1-b
```

---

## 3. Configurar DuckDNS

1. Ve a [https://www.duckdns.org](https://www.duckdns.org)
2. Login con Google/GitHub
3. Crea un subdominio: `multiagent`
4. Apunta a la IP de tu VM: `35.225.224.17`
5. Resultado: `multiagent.duckdns.org` → `35.225.224.17`

---

## 4. Script de Instalación Completo

> ⚠️ **IMPORTANTE**: Reemplaza las variables con tus credenciales reales

### Ejecutar en la VM:

```bash
#!/bin/bash
set -e

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  🚀 Multi-Agent Platform - Setup Script                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"

# 1. Instalar dependencias básicas
echo "📦 Instalando dependencias..."
sudo apt update && sudo apt install -y curl git docker.io docker-compose build-essential

# 2. Configurar Docker
echo "🐳 Configurando Docker..."
sudo systemctl enable docker && sudo systemctl start docker
sudo usermod -aG docker $USER

# 3. Instalar Node.js 20
echo "📗 Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Clonar repositorios (reemplaza GITHUB_TOKEN)
echo "📥 Clonando repositorios..."
cd ~
git clone https://YOUR_GITHUB_TOKEN@github.com/devwspito/multi-agents-backend.git agents-software-arq
git clone https://YOUR_GITHUB_TOKEN@github.com/devwspito/mult-agents-frontend.git multi-agent-frontend

# 5. Crear .env del backend
echo "📝 Creando .env..."
cd ~/agents-software-arq
cat > .env << 'ENVFILE'
NODE_ENV=production
PORT=3001
BASE_URL=http://localhost:3001

# JWT
JWT_SECRET=YOUR_JWT_SECRET
JWT_ACCESS_EXPIRE=1h
JWT_REFRESH_SECRET=YOUR_REFRESH_SECRET
JWT_REFRESH_EXPIRE=7d
JWT_EXPIRE=7d

# Claude API
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY

# Workspace
WORKSPACE_BASE=./workspaces
UPLOAD_DIR=./uploads
AGENT_WORKSPACE_DIR=/home/$USER/agent-workspace-prod

# Docker (Linux = host mode)
DOCKER_USE_BRIDGE_MODE=false

# Redis (opcional)
REDIS_URL=

# GitHub OAuth
GITHUB_CLIENT_ID=YOUR_GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET=YOUR_GITHUB_CLIENT_SECRET

# GitHub App
GITHUB_APP_ID=YOUR_GITHUB_APP_ID
GITHUB_PRIVATE_KEY="YOUR_GITHUB_PRIVATE_KEY"
GITHUB_WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET
GITHUB_INSTALLATION_ID=YOUR_INSTALLATION_ID

# Security
SESSION_SECRET=your-session-secret
REQUIRE_EMAIL_VERIFICATION=false

# Feature Flags
ENABLE_PERFORMANCE_CACHE=true
ENABLE_FILE_CONTENT_CACHE=true
ENABLE_CIRCUIT_BREAKER=true
ENABLE_GITHUB_RATE_LIMITER=true
ENABLE_GITHUB_CHECKS=true
ENABLE_ENHANCED_GIT_EXECUTION=true
ENABLE_AGGRESSIVE_COMPACTION=true
ENABLE_DYNAMIC_PARALLELISM=true

# Actualizar con IP pública
FRONTEND_URL=https://multiagent.duckdns.org
ENVFILE

# 6. Instalar y compilar backend
echo "🔨 Compilando backend..."
npm install && npm run build

# 7. Configurar frontend
echo "🎨 Configurando frontend..."
cd ~/multi-agent-frontend
cat > .env << 'EOF'
REACT_APP_API_URL=https://multiagent.duckdns.org
REACT_APP_SOCKET_URL=https://multiagent.duckdns.org
EOF
npm install && npm run build
sudo npm install -g serve

# 8. Crear servicios systemd
echo "⚙️ Creando servicios systemd..."

sudo tee /etc/systemd/system/agents-backend.service > /dev/null << SVCEOF
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

sudo tee /etc/systemd/system/agents-frontend.service > /dev/null << SVCEOF
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

# 9. Iniciar servicios
echo "🚀 Iniciando servicios..."
sudo systemctl daemon-reload
sudo systemctl enable agents-backend agents-frontend
sudo systemctl start agents-backend
sleep 5
sudo systemctl start agents-frontend

# 10. Crear workspace
mkdir -p ~/agent-workspace-prod

echo ""
echo "✅ Backend y Frontend instalados!"
echo "   Backend: http://localhost:3001"
echo "   Frontend: http://localhost:3000"
```

---

## 5. Configurar HTTPS con Caddy

### Instalar Caddy:
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

### Configurar Caddyfile:
```bash
sudo tee /etc/caddy/Caddyfile << 'EOF'
multiagent.duckdns.org {
    # API Backend
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # WebSocket (Socket.io)
    handle /socket.io/* {
        reverse_proxy localhost:3001
    }

    # Frontend (todo lo demás)
    handle {
        reverse_proxy localhost:3000
    }
}
EOF
```

### Iniciar Caddy:
```bash
sudo systemctl restart caddy
sudo systemctl enable caddy
```

---

## 6. Configurar Firewall

### Abrir puertos necesarios en GCP:
```bash
# HTTP/HTTPS para Caddy
gcloud compute firewall-rules create allow-https-caddy \
    --allow tcp:80,tcp:443 \
    --source-ranges 0.0.0.0/0 \
    --description "Allow HTTP/HTTPS for Caddy"
```

### Puertos utilizados:
| Puerto | Servicio | Acceso |
|--------|----------|--------|
| 80 | Caddy (HTTP→HTTPS redirect) | Público |
| 443 | Caddy (HTTPS) | Público |
| 3000 | Frontend (serve) | Solo localhost |
| 3001 | Backend (Node.js) | Solo localhost |

---

## 7. Verificación

### Verificar servicios:
```bash
# Estado de todos los servicios
sudo systemctl status agents-backend
sudo systemctl status agents-frontend
sudo systemctl status caddy

# Verificar puertos
sudo netstat -tlpn | grep -E '3000|3001|80|443'
```

### Verificar en navegador:
- **https://multiagent.duckdns.org** - Debería mostrar el frontend
- **https://multiagent.duckdns.org/api/health** - Debería responder JSON

### Verificar certificado SSL:
```bash
curl -I https://multiagent.duckdns.org
# Debería mostrar HTTP/2 200 y headers de seguridad
```

---

## 8. Comandos Útiles

### Logs:
```bash
# Backend logs
sudo journalctl -u agents-backend -f

# Frontend logs
sudo journalctl -u agents-frontend -f

# Caddy logs
sudo journalctl -u caddy -f
```

### Reiniciar servicios:
```bash
sudo systemctl restart agents-backend
sudo systemctl restart agents-frontend
sudo systemctl restart caddy
```

### Actualizar código:
```bash
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
```

---

## 9. Troubleshooting

### Error: "502 Bad Gateway"
```bash
# Verificar que backend está corriendo
sudo systemctl status agents-backend
sudo journalctl -u agents-backend -n 50
```

### Error: "Connection refused"
```bash
# Verificar firewall de GCP
gcloud compute firewall-rules list

# Verificar que servicios escuchan en puertos correctos
sudo netstat -tlpn
```

### Error: "SSL certificate problem"
```bash
# Verificar que Caddy obtuvo el certificado
sudo journalctl -u caddy | grep -i certificate

# Forzar renovación
sudo caddy reload --config /etc/caddy/Caddyfile
```

### WebSocket no conecta
```bash
# Verificar que Caddy está proxying /socket.io
curl -I https://multiagent.duckdns.org/socket.io/

# Verificar logs de backend para conexiones WebSocket
sudo journalctl -u agents-backend | grep -i socket
```

---

## 10. Seguridad

### ✅ Medidas implementadas:
- [x] HTTPS con certificado automático (Let's Encrypt via Caddy)
- [x] Servicios internos solo en localhost
- [x] JWT authentication
- [x] Docker sandboxing para agentes

### ⚠️ Recomendaciones adicionales:
- [ ] Rotar GitHub PAT regularmente
- [ ] Configurar fail2ban para SSH
- [ ] Habilitar 2FA en Google Cloud
- [ ] Backup regular de `/home/$USER/agents-software-arq/data/`

### 🔒 Si necesitas restringir acceso por IP:
```bash
# Crear regla solo para tu IP
gcloud compute firewall-rules create allow-my-ip-only \
    --allow tcp:80,tcp:443 \
    --source-ranges TU_IP/32 \
    --description "Solo mi IP"

# Eliminar regla pública
gcloud compute firewall-rules delete allow-https-caddy
```

---

## Arquitectura Final

```
┌─────────────────────────────────────────────────────────────┐
│                      INTERNET                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Google Cloud VM                           │
│                   (35.225.224.17)                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                  Caddy (HTTPS)                         │ │
│  │              multiagent.duckdns.org                    │ │
│  │                   :80, :443                            │ │
│  └────────────────────────┬───────────────────────────────┘ │
│                           │                                  │
│           ┌───────────────┼───────────────┐                 │
│           │               │               │                 │
│           ▼               ▼               ▼                 │
│    ┌──────────┐    ┌──────────┐    ┌──────────┐            │
│    │ Frontend │    │ Backend  │    │ Socket.io│            │
│    │  :3000   │    │  :3001   │    │  :3001   │            │
│    │  (serve) │    │ (Node.js)│    │(WebSocket)│            │
│    └──────────┘    └────┬─────┘    └──────────┘            │
│                         │                                    │
│                         ▼                                    │
│                 ┌───────────────┐                           │
│                 │    Docker     │                           │
│                 │   Sandboxes   │                           │
│                 │ (agent-sandbox│                           │
│                 │   containers) │                           │
│                 └───────────────┘                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    SQLite DB                           │ │
│  │              ~/agents-software-arq/data/               │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## URLs Finales

| Servicio | URL |
|----------|-----|
| **Frontend** | https://multiagent.duckdns.org |
| **API** | https://multiagent.duckdns.org/api |
| **WebSocket** | wss://multiagent.duckdns.org/socket.io |
| **Health Check** | https://multiagent.duckdns.org/api/health |

---

*Documentación generada: Enero 2025*
