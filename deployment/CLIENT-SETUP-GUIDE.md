# Guía Completa de Configuración de VM para Cliente

## Índice
1. [Resumen de Arquitectura](#1-resumen-de-arquitectura)
2. [Prerequisitos](#2-prerequisitos)
3. [Paso 1: Crear VM en Google Cloud](#3-paso-1-crear-vm-en-google-cloud)
4. [Paso 2: Configurar Firewall](#4-paso-2-configurar-firewall)
5. [Paso 3: Configurar DNS (DuckDNS)](#5-paso-3-configurar-dns-duckdns)
6. [Paso 4: Instalar Software Base](#6-paso-4-instalar-software-base)
7. [Paso 5: Clonar y Configurar Aplicación](#7-paso-5-clonar-y-configurar-aplicación)
8. [Paso 6: Configurar Caddy (HTTPS)](#8-paso-6-configurar-caddy-https)
9. [Paso 7: Configurar Servicio Systemd](#9-paso-7-configurar-servicio-systemd)
10. [Paso 8: Desplegar Frontend](#10-paso-8-desplegar-frontend)
11. [Paso 9: Verificación Final](#11-paso-9-verificación-final)
12. [Mantenimiento y Operaciones](#12-mantenimiento-y-operaciones)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Resumen de Arquitectura

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              INTERNET                                        │
│                                                                              │
│   Usuario → https://cliente.duckdns.org (Frontend + API)                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ HTTPS (443)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Google Cloud VM (ARM64)                              │
│                         Debian 12 Bookworm                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   ┌──────────────────────────────────────────────────────────────────────┐  │
│   │                    CADDY (Reverse Proxy + SSL)                        │  │
│   │                    Puerto: 443 (HTTPS), 80 (redirect)                 │  │
│   │                    Auto-SSL via Let's Encrypt                         │  │
│   └──────────────────────────────────────────────────────────────────────┘  │
│                    │                              │                          │
│                    │ /api/*, /socket.io/*        │ /* (static files)        │
│                    ▼                              ▼                          │
│   ┌────────────────────────────┐    ┌────────────────────────────────────┐  │
│   │   Backend Node.js :3001    │    │    Frontend (Static Files)         │  │
│   │   agents-backend.service   │    │    /home/user/frontend/dist        │  │
│   └────────────────────────────┘    └────────────────────────────────────┘  │
│                    │                                                         │
│          ┌────────┴────────┬──────────────────┐                             │
│          ▼                 ▼                  ▼                              │
│   ┌─────────────┐   ┌─────────────┐   ┌─────────────────────────┐          │
│   │  SQLite DB  │   │   Docker    │   │      GitHub API         │          │
│   │ data/app.db │   │  Sandboxes  │   │   (OAuth + GitHub App)  │          │
│   └─────────────┘   └─────────────┘   └─────────────────────────┘          │
│                            │                                                 │
│                            ▼                                                 │
│                    ┌─────────────────────────────┐                          │
│                    │    Preview Proxy :8080+     │                          │
│                    │  /api/v1/preview/:taskId/   │                          │
│                    └─────────────────────────────┘                          │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### ¿Qué hace cada componente?

| Componente | Función |
|------------|---------|
| **Caddy** | Reverse proxy con SSL automático (Let's Encrypt). Redirige `/api/*` al backend y sirve frontend estático |
| **Backend Node.js** | API REST + Socket.io para tiempo real. Orquesta agentes Claude. Puerto 3001 |
| **Frontend** | React SPA compilado a archivos estáticos. Servido directamente por Caddy |
| **Docker Sandboxes** | Contenedores aislados donde los agentes ejecutan código (Flutter, Node, Python, etc.) |
| **Preview Proxy** | Proxy que permite ver la app que se está desarrollando en el sandbox |
| **DuckDNS** | DNS dinámico gratuito para apuntar dominio a IP de VM |

---

## 2. Prerequisitos

### 2.1 Cuentas Necesarias

| Servicio | URL | Para qué |
|----------|-----|----------|
| **Google Cloud** | https://console.cloud.google.com | Crear VM |
| **Anthropic** | https://console.anthropic.com | API Key para Claude |
| **GitHub** | https://github.com/settings/apps | OAuth App + GitHub App |
| **DuckDNS** | https://www.duckdns.org | DNS gratuito |

### 2.2 Credenciales a Obtener ANTES de Empezar

```bash
# 1. Anthropic API Key (REQUERIDO)
#    - Crear en: https://console.anthropic.com/account/keys
#    - Formato: sk-ant-api03-xxxxx
ANTHROPIC_API_KEY=sk-ant-api03-...

# 2. GitHub OAuth App (REQUERIDO para login)
#    - Crear en: https://github.com/settings/developers → OAuth Apps → New
#    - Homepage URL: https://cliente.duckdns.org
#    - Callback URL: https://cliente.duckdns.org/api/v1/auth/github/callback
GITHUB_CLIENT_ID=Ov23li...
GITHUB_CLIENT_SECRET=...

# 3. GitHub App (REQUERIDO para acceso a repos)
#    - Crear en: https://github.com/settings/apps → New GitHub App
#    - Permisos: Contents (Read/Write), Pull Requests (Read/Write), Issues (Read/Write)
#    - Callback URL: https://cliente.duckdns.org/api/v1/auth/github-app/callback
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_APP_CLIENT_SECRET=...
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# 4. DuckDNS Token
#    - Obtener en: https://www.duckdns.org (login con GitHub)
DUCKDNS_TOKEN=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 2.3 Herramientas Locales

```bash
# Instalar gcloud CLI (tu máquina local)
# macOS:
brew install google-cloud-sdk

# Linux:
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Autenticar
gcloud auth login
gcloud config set project <PROJECT_ID>
```

---

## 3. Paso 1: Crear VM en Google Cloud

### 3.1 Desde Google Cloud Console (UI)

1. Ir a **Compute Engine** → **VM instances** → **Create Instance**

2. Configurar:
   | Campo | Valor |
   |-------|-------|
   | Name | `cliente-multiagent` |
   | Region | `us-central1` (o más cercana al cliente) |
   | Zone | `us-central1-a` |
   | Machine type | `t2a-standard-4` (ARM64, 4 vCPU, 16 GB RAM) |
   | Boot disk | Debian 12 Bookworm **ARM64**, 100 GB SSD |
   | Firewall | ✅ Allow HTTP, ✅ Allow HTTPS |

3. Clic en **Create**

### 3.2 Desde CLI (Alternativa)

```bash
# Variables
CLIENT_NAME="acme"
REGION="us-central1"
ZONE="${REGION}-a"

# Crear VM ARM64
gcloud compute instances create ${CLIENT_NAME}-multiagent \
  --machine-type=t2a-standard-4 \
  --image-project=debian-cloud \
  --image-family=debian-12-arm64 \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --zone=$ZONE \
  --tags=http-server,https-server

# Obtener IP externa
gcloud compute instances describe ${CLIENT_NAME}-multiagent \
  --zone=$ZONE \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

### 3.3 Reservar IP Estática (Recomendado)

```bash
# Crear IP estática
gcloud compute addresses create ${CLIENT_NAME}-ip \
  --region=$REGION

# Ver IP asignada
gcloud compute addresses describe ${CLIENT_NAME}-ip \
  --region=$REGION \
  --format='get(address)'

# Asignar a VM existente (parar VM primero)
gcloud compute instances delete-access-config ${CLIENT_NAME}-multiagent \
  --zone=$ZONE \
  --access-config-name="External NAT"

gcloud compute instances add-access-config ${CLIENT_NAME}-multiagent \
  --zone=$ZONE \
  --address=<IP_ESTATICA>
```

---

## 4. Paso 2: Configurar Firewall

### 4.1 Reglas Requeridas

Google Cloud crea reglas por defecto para `http-server` y `https-server` tags, pero verificar:

```bash
# Ver reglas existentes
gcloud compute firewall-rules list

# Si no existen, crear:
gcloud compute firewall-rules create allow-http \
  --allow=tcp:80 \
  --target-tags=http-server \
  --description="Allow HTTP"

gcloud compute firewall-rules create allow-https \
  --allow=tcp:443 \
  --target-tags=https-server \
  --description="Allow HTTPS"
```

### 4.2 Puertos Usados

| Puerto | Servicio | Acceso |
|--------|----------|--------|
| 22 | SSH | Google Cloud IAP |
| 80 | HTTP | Público (redirect a HTTPS) |
| 443 | HTTPS | Público (Caddy) |
| 3001 | Backend | Solo localhost (Caddy proxy) |
| 8080+ | Sandbox Preview | Solo localhost (proxy) |

**IMPORTANTE**: Los puertos 3001 y 8080+ NO deben estar expuestos directamente. Caddy hace proxy.

---

## 5. Paso 3: Configurar DNS (DuckDNS)

### ¿Qué es DuckDNS?

DuckDNS es un servicio gratuito de DNS dinámico. Permite tener un subdominio como `cliente.duckdns.org` que apunta a la IP de tu VM.

**Ventajas**:
- Gratuito
- Certificado SSL automático con Caddy
- Funciona con IPs dinámicas (aunque en GCP son estáticas)

### 5.1 Registrar Subdominio

1. Ir a https://www.duckdns.org
2. Login con GitHub/Google
3. En "sub domain", escribir el nombre del cliente (ej: `acme-multiagent`)
4. Clic en "add domain"
5. Copiar el **token** que aparece arriba

### 5.2 Apuntar a IP de VM

Opción A: Desde la web de DuckDNS
- Escribir la IP de la VM en el campo "current ip"
- Clic en "update ip"

Opción B: Desde la VM (para automatizar)
```bash
# En la VM, actualizar IP automáticamente
curl "https://www.duckdns.org/update?domains=acme-multiagent&token=TU_TOKEN&ip="

# Respuesta esperada: OK
```

### 5.3 Verificar DNS

```bash
# Desde cualquier máquina
nslookup acme-multiagent.duckdns.org

# Debe mostrar la IP de tu VM
```

### 5.4 (Opcional) Auto-actualización de IP

Crear cron job en la VM por si la IP cambia:

```bash
# En la VM
crontab -e

# Agregar línea (actualiza cada 5 minutos)
*/5 * * * * curl -s "https://www.duckdns.org/update?domains=acme-multiagent&token=TU_TOKEN&ip=" > /dev/null
```

---

## 6. Paso 4: Instalar Software Base

### 6.1 Conectar a la VM

```bash
# Opción 1: gcloud SSH
gcloud compute ssh cliente-multiagent --zone=us-central1-a

# Opción 2: SSH directo (si configuraste claves)
ssh user@acme-multiagent.duckdns.org
```

### 6.2 Actualizar Sistema

```bash
sudo apt update && sudo apt upgrade -y
```

### 6.3 Instalar Node.js 20

```bash
# Instalar NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash

# Cargar NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Instalar Node.js 20
nvm install 20
nvm use 20
nvm alias default 20

# Verificar
node --version  # v20.x.x
npm --version
```

### 6.4 Instalar Docker

```bash
# Instalar Docker
sudo apt-get install -y docker.io docker-compose

# Agregar usuario al grupo docker
sudo usermod -aG docker $USER

# IMPORTANTE: Cerrar sesión y reconectar para aplicar grupo
exit
# Reconectar SSH

# Verificar
docker --version
docker ps  # Debe funcionar sin sudo
```

### 6.5 Instalar Git y Herramientas

```bash
sudo apt-get install -y git curl wget jq htop
```

---

## 7. Paso 5: Clonar y Configurar Aplicación

### 7.1 Clonar Repositorios

```bash
# Backend
cd ~
git clone https://github.com/tu-org/agents-software-arq.git
cd agents-software-arq

# Frontend (en otra carpeta)
cd ~
git clone https://github.com/tu-org/multi-agent-frontend.git
```

### 7.2 Crear Archivo .env para Backend

```bash
cd ~/agents-software-arq
nano .env
```

Contenido del `.env`:

```bash
# ============================================================================
# Multi-Agent Platform - Configuración de Producción
# ============================================================================

# Entorno
NODE_ENV=production
PORT=3001

# URLs públicas (CAMBIAR por dominio del cliente)
BASE_URL=https://acme-multiagent.duckdns.org
FRONTEND_URL=https://acme-multiagent.duckdns.org

# ============================================================================
# APIs Externas (REQUERIDAS)
# ============================================================================

# Anthropic API Key
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxx

# GitHub OAuth App
GITHUB_CLIENT_ID=Ov23lixxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_CALLBACK_URL=https://acme-multiagent.duckdns.org/api/v1/auth/github/callback

# GitHub App (para acceso a repos)
GITHUB_APP_ID=123456
GITHUB_APP_CLIENT_ID=Iv23lixxxxxxxxxx
GITHUB_APP_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----"

# ============================================================================
# Workspace y Docker
# ============================================================================

# Directorio donde se clonan los repos de los clientes
AGENT_WORKSPACE_DIR=/home/usuario/agent-workspace-prod

# Docker usa host network (NO bridge) - requerido para preview
DOCKER_USE_BRIDGE_MODE=false

# ============================================================================
# Seguridad
# ============================================================================

# Generar con: openssl rand -base64 32
JWT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
JWT_REFRESH_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SESSION_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ============================================================================
# Opcional
# ============================================================================

# Logging
LOG_LEVEL=info

# Modelo por defecto (haiku, sonnet, opus)
DEFAULT_MODEL=sonnet

# Límite de costo por tarea (USD)
MAX_COST_PER_TASK=50.00
```

### 7.3 Crear Directorio de Trabajo

```bash
mkdir -p ~/agent-workspace-prod
mkdir -p ~/agents-software-arq/data
```

### 7.4 Instalar Dependencias y Compilar

```bash
cd ~/agents-software-arq

# Backend
npm install
npm run build

# Verificar que compila sin errores
ls -la dist/  # Debe existir dist/index.js
```

### 7.5 Compilar Frontend

```bash
cd ~/multi-agent-frontend

# Crear .env para frontend
cat > .env << 'EOF'
VITE_API_URL=https://acme-multiagent.duckdns.org
VITE_WS_URL=wss://acme-multiagent.duckdns.org
EOF

# Instalar y compilar
npm install
npm run build

# Verificar
ls -la dist/  # Debe existir dist/index.html
```

---

## 8. Paso 6: Configurar Caddy (HTTPS)

### ¿Qué es Caddy?

Caddy es un servidor web moderno que:
- Obtiene certificados SSL automáticamente (Let's Encrypt)
- Actúa como reverse proxy
- Configuración simple

### 8.1 Instalar Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list

sudo apt update
sudo apt install caddy
```

### 8.2 Configurar Caddyfile

```bash
sudo nano /etc/caddy/Caddyfile
```

Contenido (CAMBIAR `acme-multiagent.duckdns.org` por el dominio del cliente):

```caddyfile
# ============================================================================
# Multi-Agent Platform - Caddy Configuration
# ============================================================================

acme-multiagent.duckdns.org {
    # ========================================================================
    # API Backend (Node.js :3001)
    # ========================================================================

    # API REST endpoints
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # Socket.io para WebSocket (tiempo real)
    handle /socket.io/* {
        reverse_proxy localhost:3001
    }

    # Health check endpoint
    handle /health {
        reverse_proxy localhost:3001
    }

    # ========================================================================
    # Frontend (Static Files)
    # ========================================================================

    handle {
        # Directorio donde está el frontend compilado
        root * /home/TU_USUARIO/multi-agent-frontend/dist

        # SPA: redirigir todo a index.html si no existe el archivo
        try_files {path} /index.html

        # Servir archivos estáticos
        file_server
    }

    # ========================================================================
    # Logging
    # ========================================================================
    log {
        output file /var/log/caddy/access.log
        format json
    }
}
```

**IMPORTANTE**: Cambiar `TU_USUARIO` por el nombre de usuario real (ej: `luiscorrea2368`).

### 8.3 Verificar Configuración

```bash
# Verificar sintaxis
sudo caddy validate --config /etc/caddy/Caddyfile

# Si hay errores, corregir el Caddyfile
```

### 8.4 Iniciar Caddy

```bash
# Reiniciar Caddy
sudo systemctl restart caddy

# Verificar estado
sudo systemctl status caddy

# Ver logs (para ver obtención de certificado SSL)
sudo journalctl -u caddy -f
```

### 8.5 Verificar Certificado SSL

Caddy obtiene el certificado automáticamente. Ver en los logs:

```
... successfully obtained certificate ...
```

O verificar desde navegador: https://acme-multiagent.duckdns.org (debe mostrar candado verde).

---

## 9. Paso 7: Configurar Servicio Systemd

### ¿Qué es Systemd?

Systemd es el sistema de inicio de Linux. Permite que el backend se inicie automáticamente al arrancar la VM y se reinicie si falla.

### 9.1 Crear Archivo de Servicio

```bash
sudo nano /etc/systemd/system/agents-backend.service
```

Contenido:

```ini
[Unit]
Description=Multi-Agent Backend
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
User=TU_USUARIO
WorkingDirectory=/home/TU_USUARIO/agents-software-arq
ExecStart=/home/TU_USUARIO/.nvm/versions/node/v20.18.3/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**IMPORTANTE**:
1. Cambiar `TU_USUARIO` por el nombre de usuario real
2. Verificar la ruta de Node.js con: `which node`

### 9.2 Activar y Arrancar Servicio

```bash
# Recargar configuración de systemd
sudo systemctl daemon-reload

# Habilitar auto-inicio al boot
sudo systemctl enable agents-backend

# Arrancar servicio
sudo systemctl start agents-backend

# Verificar estado
sudo systemctl status agents-backend
```

### 9.3 Comandos Útiles

```bash
# Ver estado
sudo systemctl status agents-backend

# Ver logs en tiempo real
sudo journalctl -u agents-backend -f

# Ver últimos 100 logs
sudo journalctl -u agents-backend -n 100

# Reiniciar
sudo systemctl restart agents-backend

# Parar
sudo systemctl stop agents-backend
```

---

## 10. Paso 8: Desplegar Frontend

El frontend ya está configurado para ser servido por Caddy (ver Paso 6).

### 10.1 Verificar Compilación

```bash
ls -la ~/multi-agent-frontend/dist/
# Debe contener: index.html, assets/, etc.
```

### 10.2 Permisos

```bash
chmod -R 755 ~/multi-agent-frontend/dist/
```

### 10.3 Actualizar Frontend (Cuando haya cambios)

```bash
cd ~/multi-agent-frontend
git pull origin main
npm install
npm run build
# No necesita reiniciar Caddy - sirve archivos estáticos
```

---

## 11. Paso 9: Verificación Final

### 11.1 Checklist de Verificación

```bash
# 1. Backend está corriendo
sudo systemctl status agents-backend
# Debe mostrar: active (running)

# 2. Health check local
curl http://localhost:3001/health
# Debe responder JSON con status ok

# 3. Caddy está corriendo
sudo systemctl status caddy
# Debe mostrar: active (running)

# 4. Health check externo (HTTPS)
curl https://acme-multiagent.duckdns.org/health
# Debe responder JSON con status ok

# 5. Docker funciona
docker ps
# Debe listar contenedores (puede estar vacío inicialmente)

# 6. Frontend carga
curl -I https://acme-multiagent.duckdns.org
# Debe responder: HTTP/2 200
```

### 11.2 Verificación desde Navegador

1. Abrir https://acme-multiagent.duckdns.org
2. Debe cargar la aplicación React
3. Clic en "Login with GitHub"
4. Debe redirigir a GitHub y volver autenticado
5. Crear un nuevo task y verificar que funciona

### 11.3 Verificar Logs si Hay Problemas

```bash
# Backend
sudo journalctl -u agents-backend -n 200 --no-pager

# Caddy
sudo journalctl -u caddy -n 100 --no-pager

# Docker
docker logs <container-id>
```

---

## 12. Mantenimiento y Operaciones

### 12.1 Actualizar Backend (Deploy)

```bash
cd ~/agents-software-arq

# 1. Parar servicio
sudo systemctl stop agents-backend

# 2. Actualizar código
git pull origin main

# 3. Instalar dependencias nuevas
npm install

# 4. Compilar
npm run build

# 5. Arrancar
sudo systemctl start agents-backend

# 6. Verificar
sudo systemctl status agents-backend
curl http://localhost:3001/health
```

### 12.2 Actualizar Frontend

```bash
cd ~/multi-agent-frontend
git pull origin main
npm install
npm run build
# No necesita reiniciar nada
```

### 12.3 Ver Uso de Recursos

```bash
# CPU y RAM
htop

# Disco
df -h

# Contenedores Docker
docker stats
```

### 12.4 Limpiar Contenedores Docker

```bash
# Ver todos los contenedores
docker ps -a

# Limpiar contenedores parados
docker container prune -f

# Limpiar imágenes no usadas
docker image prune -f
```

### 12.5 Backup de Base de Datos

```bash
# SQLite se guarda en:
# ~/agents-software-arq/data/app.db

# Backup manual
cp ~/agents-software-arq/data/app.db ~/backups/app-$(date +%Y%m%d).db
```

---

## 13. Troubleshooting

### 13.1 El backend no arranca

**Síntoma**: `systemctl status agents-backend` muestra error

**Verificar**:
```bash
# 1. Ver error específico
sudo journalctl -u agents-backend -n 50

# 2. Verificar que Node.js existe
which node
# Si usa NVM, la ruta es: ~/.nvm/versions/node/v20.x.x/bin/node

# 3. Verificar .env existe
cat ~/agents-software-arq/.env

# 4. Verificar dist/ existe
ls -la ~/agents-software-arq/dist/index.js
```

### 13.2 Caddy no obtiene certificado SSL

**Síntoma**: HTTPS no funciona, certificado inválido

**Verificar**:
```bash
# 1. DNS resuelve correctamente
nslookup acme-multiagent.duckdns.org
# Debe mostrar la IP de tu VM

# 2. Puerto 80 accesible (Let's Encrypt lo necesita)
sudo ufw status
# Si UFW está activo, permitir 80/443:
sudo ufw allow 80
sudo ufw allow 443

# 3. Ver logs de Caddy
sudo journalctl -u caddy -n 100 | grep -i "certificate\|error"
```

### 13.3 GitHub OAuth no funciona

**Síntoma**: Error al hacer login con GitHub

**Verificar**:
```bash
# 1. URLs en .env coinciden con GitHub App
cat ~/agents-software-arq/.env | grep GITHUB

# 2. Callback URL debe ser EXACTAMENTE:
# https://acme-multiagent.duckdns.org/api/v1/auth/github/callback

# 3. En GitHub, verificar que la app tiene los permisos correctos
```

### 13.4 Docker sandbox falla

**Síntoma**: Error al crear sandbox, "exec format error"

**Causa**: Imagen Docker no compatible con ARM64

**Solución**:
```bash
# Verificar arquitectura de VM
uname -m
# Debe ser: aarch64 (ARM64)

# Las imágenes Docker deben soportar ARM64
# Verificar imagen:
docker pull ghcr.io/cirruslabs/flutter:3.24.0
# Si falla con "no matching manifest", la imagen no soporta ARM64
```

### 13.5 Puerto 3001 ya en uso

**Síntoma**: `EADDRINUSE: address already in use :::3001`

**Solución**:
```bash
# Ver qué usa el puerto
sudo ss -tlnp | grep 3001

# Matar proceso
sudo fuser -k 3001/tcp

# Reiniciar servicio
sudo systemctl restart agents-backend
```

### 13.6 Preview del sandbox no carga

**Síntoma**: LivePreview muestra error o no carga

**Verificar**:
```bash
# 1. Sandbox está corriendo
docker ps | grep sandbox

# 2. Ver logs del sandbox
docker logs <sandbox-container-id>

# 3. Probar proxy manualmente
curl http://localhost:3001/api/v1/preview/<taskId>/info
```

---

## Checklist Final de Deploy

- [ ] VM creada (ARM64, 4+ vCPU, 16+ GB RAM)
- [ ] IP estática asignada
- [ ] DuckDNS configurado y resolviendo
- [ ] Node.js 20 instalado
- [ ] Docker instalado y usuario en grupo docker
- [ ] Backend clonado y compilado
- [ ] Frontend clonado y compilado
- [ ] `.env` configurado con todas las credenciales
- [ ] Caddy instalado y configurado
- [ ] Certificado SSL obtenido (candado verde)
- [ ] Servicio systemd creado y habilitado
- [ ] Health check responde: `curl https://dominio/health`
- [ ] Login con GitHub funciona
- [ ] Crear task de prueba funciona

---

**Última actualización**: 2026-01-26
**Versión**: 3.0.0
