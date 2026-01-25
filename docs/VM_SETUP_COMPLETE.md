# Guía Completa: Deployment Multi-Agent Platform en Google Cloud VM

> **Última actualización**: Enero 2026
> **Probado en**: Google Cloud VM - Ubuntu 22.04 LTS

---

## Tabla de Contenidos

1. [Requisitos Previos](#1-requisitos-previos)
2. [Crear la VM en Google Cloud](#2-crear-la-vm-en-google-cloud)
3. [Configurar DuckDNS (Dominio Gratuito)](#3-configurar-duckdns-dominio-gratuito)
4. [Conectar a la VM](#4-conectar-a-la-vm)
5. [Instalar Dependencias](#5-instalar-dependencias)
6. [Clonar Repositorios](#6-clonar-repositorios)
7. [Configurar Backend (.env)](#7-configurar-backend-env)
8. [Compilar Backend](#8-compilar-backend)
9. [Configurar Frontend (.env)](#9-configurar-frontend-env)
10. [Compilar Frontend](#10-compilar-frontend)
11. [Crear Servicios Systemd](#11-crear-servicios-systemd)
12. [Configurar HTTPS con Caddy](#12-configurar-https-con-caddy)
13. [Configurar Firewall en GCP](#13-configurar-firewall-en-gcp)
14. [Configurar GitHub OAuth](#14-configurar-github-oauth)
15. [Iniciar Servicios](#15-iniciar-servicios)
16. [Verificación](#16-verificación)
17. [Comandos Útiles](#17-comandos-útiles)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. Requisitos Previos

### En tu máquina local necesitas:
- [ ] Cuenta de Google Cloud con billing habilitado
- [ ] `gcloud` CLI instalado y configurado
- [ ] Cuenta de GitHub
- [ ] API Key de Anthropic (Claude)

### Credenciales que necesitarás:
| Credencial | Dónde obtenerla |
|------------|-----------------|
| ANTHROPIC_API_KEY | https://console.anthropic.com |
| GITHUB_CLIENT_ID | GitHub OAuth App (paso 14) |
| GITHUB_CLIENT_SECRET | GitHub OAuth App (paso 14) |

---

## 2. Crear la VM en Google Cloud

### Opción A: Google Cloud Console (UI)

1. Ve a [Google Cloud Console](https://console.cloud.google.com)
2. Navega a: **Compute Engine → VM instances → Create Instance**
3. Configura:

| Campo | Valor |
|-------|-------|
| Nombre | `multi-agent-vm` |
| Región | `us-central1` (o la más cercana) |
| Zona | `us-central1-b` |
| Tipo de máquina | `e2-standard-8` (8 vCPU, 32GB RAM) |
| Boot disk | Ubuntu 22.04 LTS |
| Tamaño disco | 100GB SSD |
| Firewall | ✅ Permitir HTTP, ✅ Permitir HTTPS |

4. Click en **Create**

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

### Obtener IP pública

```bash
gcloud compute instances describe multi-agent-vm \
    --zone=us-central1-b \
    --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

**Anota esta IP**, la necesitarás para DuckDNS.

---

## 3. Configurar DuckDNS (Dominio Gratuito)

1. Ve a [https://www.duckdns.org](https://www.duckdns.org)
2. Login con Google o GitHub
3. Crea un subdominio (ej: `multiagent`)
4. En el campo IP, pon la IP pública de tu VM
5. Click en **update ip**

**Resultado**: `multiagent.duckdns.org` → `TU_IP_PUBLICA`

---

## 4. Conectar a la VM

```bash
gcloud compute ssh multi-agent-vm --zone=us-central1-b
```

O usando SSH directo:
```bash
ssh -i ~/.ssh/google_compute_engine TU_USUARIO@TU_IP_PUBLICA
```

---

## 5. Instalar Dependencias

Ejecuta estos comandos en la VM:

```bash
# Actualizar sistema
sudo apt update && sudo apt upgrade -y

# Instalar dependencias básicas
sudo apt install -y curl git build-essential

# Instalar Docker
sudo apt install -y docker.io docker-compose
sudo systemctl enable docker
sudo systemctl start docker
sudo usermod -aG docker $USER

# Instalar Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verificar instalaciones
node --version    # Debe mostrar v20.x.x
npm --version     # Debe mostrar 10.x.x
docker --version  # Debe mostrar Docker version 20.x.x
```

**IMPORTANTE**: Después de `usermod -aG docker $USER`, debes reconectar:

```bash
exit
# Vuelve a conectar
gcloud compute ssh multi-agent-vm --zone=us-central1-b
```

Verifica que Docker funciona sin sudo:
```bash
docker run --rm hello-world
```

---

## 6. Clonar Repositorios

```bash
cd ~

# Backend
git clone https://github.com/TU_USUARIO/agents-software-arq.git

# Frontend
git clone https://github.com/TU_USUARIO/multi-agent-frontend.git
```

**Si los repos son privados**, usa token:
```bash
git clone https://TU_GITHUB_TOKEN@github.com/TU_USUARIO/agents-software-arq.git
git clone https://TU_GITHUB_TOKEN@github.com/TU_USUARIO/multi-agent-frontend.git
```

---

## 7. Configurar Backend (.env)

```bash
cd ~/agents-software-arq

cat > .env << 'EOF'
# ===========================================
# MULTI-AGENT PLATFORM - PRODUCTION CONFIG
# ===========================================

NODE_ENV=production
PORT=3001

# Claude API (REQUERIDO)
ANTHROPIC_API_KEY=sk-ant-api03-TU_API_KEY_AQUI

# JWT Authentication (REQUERIDO - mínimo 32 caracteres)
JWT_SECRET=tu-super-secreto-jwt-de-produccion-minimo-32-chars
SESSION_SECRET=tu-super-secreto-session-de-produccion-32-chars
JWT_EXPIRE=7d

# URLs
FRONTEND_URL=https://TU_SUBDOMINIO.duckdns.org

# Workspace para agentes
AGENT_WORKSPACE_DIR=/home/$USER/agent-workspace-prod

# Docker (Linux usa host network)
DOCKER_USE_BRIDGE_MODE=false

# GitHub OAuth (configurar en paso 14)
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
EOF
```

**Edita el archivo** con tus valores reales:
```bash
nano .env
```

Reemplaza:
- `TU_API_KEY_AQUI` → Tu API key de Anthropic
- `TU_SUBDOMINIO` → Tu subdominio de DuckDNS
- Los secrets JWT deben ser únicos y seguros

---

## 8. Compilar Backend

```bash
cd ~/agents-software-arq

# Instalar dependencias
npm install

# Compilar TypeScript
npm run build

# Verificar que compiló
ls -la dist/
# Debe existir dist/index.js
```

---

## 9. Configurar Frontend (.env)

```bash
cd ~/multi-agent-frontend

cat > .env << 'EOF'
VITE_API_BASE_URL=https://TU_SUBDOMINIO.duckdns.org
VITE_SOCKET_URL=https://TU_SUBDOMINIO.duckdns.org
EOF
```

Reemplaza `TU_SUBDOMINIO` con tu subdominio de DuckDNS.

---

## 10. Compilar Frontend

```bash
cd ~/multi-agent-frontend

# Instalar dependencias
npm install

# Compilar para producción
npm run build

# Verificar que compiló
ls -la build/
# o
ls -la dist/
# (depende de tu configuración de Vite/React)

# Instalar serve globalmente
sudo npm install -g serve
```

---

## 11. Crear Servicios Systemd

### Backend Service

```bash
sudo tee /etc/systemd/system/agents-backend.service > /dev/null << EOF
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
EOF
```

### Frontend Service

```bash
sudo tee /etc/systemd/system/agents-frontend.service > /dev/null << EOF
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
EOF
```

**Nota**: Si tu frontend compila a `dist/` en lugar de `build/`, cambia `-s build` por `-s dist`.

### Recargar systemd

```bash
sudo systemctl daemon-reload
```

---

## 12. Configurar HTTPS con Caddy

### Instalar Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

### Configurar Caddyfile

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
TU_SUBDOMINIO.duckdns.org {
    # API Backend (todo /api/*)
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

**Edita el archivo** para poner tu subdominio:
```bash
sudo nano /etc/caddy/Caddyfile
```

### Habilitar Caddy

```bash
sudo systemctl enable caddy
sudo systemctl restart caddy
```

---

## 13. Configurar Firewall en GCP

```bash
# Permitir HTTP y HTTPS
gcloud compute firewall-rules create allow-http-https \
    --allow tcp:80,tcp:443 \
    --source-ranges 0.0.0.0/0 \
    --target-tags http-server,https-server \
    --description "Allow HTTP and HTTPS traffic"
```

O desde la consola de GCP:
1. Ve a **VPC Network → Firewall**
2. Verifica que existan reglas para puertos 80 y 443

---

## 14. Configurar GitHub OAuth

### Crear OAuth App en GitHub

1. Ve a [GitHub Developer Settings](https://github.com/settings/developers)
2. Click en **OAuth Apps → New OAuth App**
3. Configura:

| Campo | Valor |
|-------|-------|
| Application name | Multi-Agent Platform |
| Homepage URL | `https://TU_SUBDOMINIO.duckdns.org` |
| Authorization callback URL | `https://TU_SUBDOMINIO.duckdns.org/api/auth/github/callback` |

4. Click en **Register application**
5. Copia el **Client ID**
6. Click en **Generate a new client secret** y cópialo

### Actualizar .env del backend

```bash
cd ~/agents-software-arq
nano .env
```

Añade/actualiza:
```env
GITHUB_CLIENT_ID=Ov23liXXXXXXXXXXXXXX
GITHUB_CLIENT_SECRET=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 15. Iniciar Servicios

```bash
# Crear directorio de workspace
mkdir -p ~/agent-workspace-prod

# Habilitar servicios
sudo systemctl enable agents-backend agents-frontend

# Iniciar backend
sudo systemctl start agents-backend
sleep 5

# Verificar backend
sudo systemctl status agents-backend

# Iniciar frontend
sudo systemctl start agents-frontend

# Verificar frontend
sudo systemctl status agents-frontend

# Verificar Caddy
sudo systemctl status caddy
```

---

## 16. Verificación

### Verificar servicios localmente

```bash
# Backend health check
curl http://localhost:3001/api/health

# Frontend
curl http://localhost:3000
```

### Verificar HTTPS externamente

Desde tu navegador:
- **Frontend**: https://TU_SUBDOMINIO.duckdns.org
- **API Health**: https://TU_SUBDOMINIO.duckdns.org/api/health

### Verificar certificado SSL

```bash
curl -I https://TU_SUBDOMINIO.duckdns.org
# Debe mostrar HTTP/2 200
```

---

## 17. Comandos Útiles

### Logs en tiempo real

```bash
# Backend
sudo journalctl -u agents-backend -f

# Frontend
sudo journalctl -u agents-frontend -f

# Caddy
sudo journalctl -u caddy -f

# Todos juntos
sudo journalctl -u agents-backend -u agents-frontend -u caddy -f
```

### Reiniciar servicios

```bash
sudo systemctl restart agents-backend
sudo systemctl restart agents-frontend
sudo systemctl restart caddy
```

### Actualizar código

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

### Pre-descargar imágenes Docker (opcional)

```bash
docker pull node:20-bookworm
docker pull ghcr.io/cirruslabs/flutter:stable
docker pull python:3.12-bookworm
```

---

## 18. Troubleshooting

### Error: "502 Bad Gateway"

```bash
# Verificar que backend está corriendo
sudo systemctl status agents-backend
sudo journalctl -u agents-backend -n 50
```

### Error: "Connection refused"

```bash
# Verificar puertos
sudo netstat -tlpn | grep -E '3000|3001|80|443'

# Verificar firewall GCP
gcloud compute firewall-rules list
```

### Error: "JWT_SECRET must be at least 32 characters"

```bash
# Editar .env
nano ~/agents-software-arq/.env
# Asegúrate que JWT_SECRET y SESSION_SECRET tengan 32+ caracteres
```

### Error: Docker "permission denied"

```bash
# Verificar grupo docker
groups | grep docker

# Si no está, reconectar
exit
gcloud compute ssh multi-agent-vm --zone=us-central1-b
```

### SSL Certificate no genera

```bash
# Verificar logs de Caddy
sudo journalctl -u caddy | grep -i certificate

# Forzar reload
sudo caddy reload --config /etc/caddy/Caddyfile
```

---

## Arquitectura Final

```
┌─────────────────────────────────────────────────────────────┐
│                        INTERNET                              │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Google Cloud VM                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              Caddy (HTTPS + Auto SSL)                  │ │
│  │                    :80, :443                           │ │
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
│                 └───────────────┘                           │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    SQLite DB                           │ │
│  │              ~/agents-software-arq/data/               │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## Checklist Final

- [ ] VM creada y corriendo
- [ ] DuckDNS configurado con IP correcta
- [ ] Docker instalado y funcionando sin sudo
- [ ] Backend compilado y `.env` configurado
- [ ] Frontend compilado y `.env` configurado
- [ ] Servicios systemd creados y habilitados
- [ ] Caddy instalado y configurado
- [ ] Firewall GCP permite puertos 80 y 443
- [ ] GitHub OAuth App configurada con URLs de producción
- [ ] HTTPS funcionando (certificado SSL activo)
- [ ] Login con GitHub funciona

---

*Documentación generada: Enero 2026*
