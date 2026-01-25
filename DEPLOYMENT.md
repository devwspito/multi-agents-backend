# Deployment Guide - Multi-Agent Platform

Guía completa de instalación y despliegue del sistema Multi-Agent en Google Cloud VM.

## Tabla de Contenidos

1. [Requisitos Previos](#requisitos-previos)
2. [Configuración de la VM](#configuración-de-la-vm)
3. [Instalación del Sistema](#instalación-del-sistema)
4. [Configuración de Servicios](#configuración-de-servicios)
5. [Configuración de Caddy (HTTPS)](#configuración-de-caddy-https)
6. [Comandos de Operación](#comandos-de-operación)
7. [Troubleshooting](#troubleshooting)
8. [Problemas Conocidos y Soluciones](#problemas-conocidos-y-soluciones)

---

## Requisitos Previos

### Hardware (Google Cloud VM)
- **Machine type**: e2-standard-4 (4 vCPU, 16 GB RAM) mínimo
- **Disco**: 100 GB SSD
- **OS**: Ubuntu 22.04 LTS

### Software
- Node.js 20+
- Docker con soporte para contenedores Linux
- Git
- Caddy (reverse proxy con auto-SSL)

### Credenciales
- API Key de Anthropic (`ANTHROPIC_API_KEY`)
- GitHub App credentials (OAuth + App)
- Firebase service account (para storage)

---

## Configuración de la VM

### 1. Crear VM en Google Cloud

```bash
# Desde Google Cloud Console o gcloud CLI
gcloud compute instances create multiagent-vm \
  --machine-type=e2-standard-4 \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB \
  --boot-disk-type=pd-ssd \
  --tags=http-server,https-server
```

### 2. Configurar Firewall

```bash
# Permitir HTTP/HTTPS
gcloud compute firewall-rules create allow-http --allow tcp:80
gcloud compute firewall-rules create allow-https --allow tcp:443

# Puerto 3001 solo interno (Caddy hace proxy)
```

### 3. Configurar DNS

Apuntar dominio (ej: `multiagent.duckdns.org`) a la IP externa de la VM.

---

## Instalación del Sistema

### 1. Conectar a la VM

```bash
gcloud compute ssh multiagent-vm
# o
ssh user@multiagent.duckdns.org
```

### 2. Instalar Node.js 20

```bash
# Instalar NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# Instalar Node.js 20
nvm install 20
nvm use 20
nvm alias default 20

# Verificar
node --version  # v20.x.x
npm --version
```

### 3. Instalar Docker

```bash
# Instalar Docker
sudo apt-get update
sudo apt-get install -y docker.io docker-compose

# Agregar usuario al grupo docker
sudo usermod -aG docker $USER

# Reiniciar sesión para aplicar grupo
exit
# Reconectar SSH

# Verificar
docker --version
docker ps
```

### 4. Clonar Repositorio

```bash
cd ~
git clone https://github.com/tu-org/agents-software-arq.git
cd agents-software-arq
```

### 5. Configurar Variables de Entorno

```bash
# Copiar template
cp .env.example .env

# Editar con valores de producción
nano .env
```

**Variables críticas en producción:**

```bash
# .env (PRODUCCIÓN)
NODE_ENV=production
PORT=3001
BASE_URL=https://multiagent.duckdns.org
FRONTEND_URL=https://multiagent-frontend.duckdns.org

# API Keys (NUNCA commitear)
ANTHROPIC_API_KEY=sk-ant-api03-xxx
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
GITHUB_APP_ID=xxx
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----\n"

# Workspace (usar disco montado si es posible)
AGENT_WORKSPACE_DIR=/home/user/agent-workspace-prod

# Docker en Linux: usar host mode
DOCKER_USE_BRIDGE_MODE=false
```

### 6. Instalar Dependencias y Compilar

```bash
npm install
npm run build
```

### 7. Crear Directorios de Trabajo

```bash
mkdir -p ~/agent-workspace-prod
mkdir -p ~/agents-software-arq/data
```

---

## Configuración de Servicios

### 1. Crear Servicio Systemd

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
User=luiscorrea2368
WorkingDirectory=/home/luiscorrea2368/agents-software-arq
ExecStart=/home/luiscorrea2368/.nvm/versions/node/v20.18.3/bin/node dist/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

**IMPORTANTE**: Ajustar:
- `User=` con tu usuario
- `WorkingDirectory=` con la ruta correcta
- `ExecStart=` con la ruta completa a node (usar `which node`)

### 2. Habilitar y Arrancar Servicio

```bash
# Recargar systemd
sudo systemctl daemon-reload

# Habilitar auto-start
sudo systemctl enable agents-backend

# Arrancar
sudo systemctl start agents-backend

# Verificar
sudo systemctl status agents-backend
```

---

## Configuración de Caddy (HTTPS)

### 1. Instalar Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 2. Configurar Caddyfile

```bash
sudo nano /etc/caddy/Caddyfile
```

Contenido:

```caddyfile
multiagent.duckdns.org {
    # API Backend
    handle /api/* {
        reverse_proxy localhost:3001
    }

    # Socket.io
    handle /socket.io/* {
        reverse_proxy localhost:3001
    }

    # Health check
    handle /health {
        reverse_proxy localhost:3001
    }

    # Frontend (si está en el mismo servidor)
    handle {
        root * /home/user/multi-agent-frontend/dist
        try_files {path} /index.html
        file_server
    }
}
```

### 3. Reiniciar Caddy

```bash
sudo systemctl restart caddy
sudo systemctl status caddy
```

---

## Comandos de Operación

### Gestión del Servicio

```bash
# Estado
sudo systemctl status agents-backend

# Arrancar
sudo systemctl start agents-backend

# Parar
sudo systemctl stop agents-backend

# Reiniciar
sudo systemctl restart agents-backend

# Ver logs en tiempo real
sudo journalctl -u agents-backend -f

# Ver últimos 100 logs
sudo journalctl -u agents-backend -n 100
```

### Actualizar Código (Deploy)

```bash
cd ~/agents-software-arq

# 1. Parar servicio
sudo systemctl stop agents-backend

# 2. Actualizar código
git pull origin main

# 3. Instalar dependencias (si hay nuevas)
npm install

# 4. Compilar
npm run build

# 5. Arrancar servicio
sudo systemctl start agents-backend

# 6. Verificar
sudo systemctl status agents-backend
curl http://localhost:3001/health
```

### Health Check

```bash
# Local
curl http://localhost:3001/health

# Externo (HTTPS via Caddy)
curl https://multiagent.duckdns.org/health
```

---

## Troubleshooting

### Ver Procesos en Puerto 3001

```bash
# Ver qué usa el puerto
sudo ss -tlnp | grep 3001

# O con lsof
sudo lsof -i :3001
```

### Matar Proceso en Puerto

```bash
# Matar por puerto
sudo fuser -k 3001/tcp

# Matar todos los node
sudo pkill -9 -f node
```

### Ver Procesos Node

```bash
ps aux | grep node
```

### Revisar Logs de Errores

```bash
# Logs del servicio
sudo journalctl -u agents-backend -n 200 --no-pager

# Logs de Docker
docker logs <container-id>

# Logs de Caddy
sudo journalctl -u caddy -f
```

### Verificar Docker

```bash
# Contenedores corriendo
docker ps

# Todos los contenedores
docker ps -a

# Limpiar contenedores huérfanos
docker container prune -f
```

---

## Problemas Conocidos y Soluciones

### 1. EADDRINUSE: Puerto 3001 en Uso

**Síntomas:**
```
Error: listen EADDRINUSE: address already in use :::3001
```

**Causa:** Otro proceso está usando el puerto.

**Solución:**
```bash
# 1. Ver qué usa el puerto
sudo ss -tlnp | grep 3001

# 2. Si es PM2, deshabilitarlo
pm2 stop all
pm2 delete all

# 3. Matar proceso
sudo fuser -k 3001/tcp

# 4. Reiniciar servicio
sudo systemctl restart agents-backend
```

---

### 2. Bucle de Reinicio del Servicio (PM2 Conflicto)

**Síntomas:**
- Matas el proceso y vuelve a aparecer inmediatamente
- El puerto 3001 siempre está ocupado
- `ps aux | grep node` muestra proceso PM2

**Causa:** PM2 está corriendo en paralelo con systemd y reinicia procesos.

**Solución DEFINITIVA:**

```bash
# 1. Parar y deshabilitar PM2 completamente
pm2 stop all
pm2 delete all
pm2 kill

# 2. Desinstalar PM2 si no se usa
npm uninstall -g pm2

# 3. Si necesitas mantener PM2 para otro proyecto, al menos quita el startup
pm2 unstartup

# 4. Asegurarse que systemd está a cargo
sudo systemctl stop agents-backend
sudo pkill -9 -f node
sudo systemctl start agents-backend
```

**Solución TEMPORAL (si PM2 sigue reapareciendo):**

```bash
# 1. Deshabilitar restart de systemd temporalmente
sudo systemctl stop agents-backend
sudo systemctl mask agents-backend

# 2. Matar todo
pm2 kill
sudo pkill -9 -f node

# 3. Verificar puerto libre
sudo ss -tlnp | grep 3001  # Debe estar vacío

# 4. Rehabilitar y arrancar
sudo systemctl unmask agents-backend
sudo systemctl start agents-backend
```

---

### 3. Base de Datos Sincronizada entre Local y Producción

**Síntomas:**
- Tareas de producción aparecen en local
- Cambios locales afectan producción

**Causa:** El archivo `data/app.db` estaba trackeado en git.

**Solución:**

```bash
# 1. Agregar a .gitignore
echo "data/*.db" >> .gitignore
echo "data/*.db-shm" >> .gitignore
echo "data/*.db-wal" >> .gitignore

# 2. Eliminar de git (sin borrar archivo)
git rm --cached data/app.db
git rm --cached data/app.db-shm 2>/dev/null
git rm --cached data/app.db-wal 2>/dev/null

# 3. Commit
git add .gitignore
git commit -m "fix: remove database from git tracking"
git push
```

---

### 4. Flutter Sandbox Timeout (DevServer no arranca)

**Síntomas:**
```
Step 7: Waiting for dev server... (timeout)
flutter: command not found
```

**Causa 1:** Imagen Docker incorrecta (node en vez de flutter).

**Solución:**
```bash
# Verificar imagen del sandbox
docker ps --format "{{.Names}} {{.Image}}"

# Si usa node:20-bookworm para Flutter, eliminar pool corrupto
sqlite3 data/app.db "DELETE FROM sandbox_pool_state WHERE repo_name LIKE '%flutter%';"

# Destruir contenedor viejo
docker stop <container-id> && docker rm <container-id>
```

**Causa 2:** Pattern de detección faltante para `python3 -m http.server`.

**Solución:** Actualizar `SandboxPhase.ts` con pattern `'Serving HTTP on'`.

---

### 5. Permisos de Docker

**Síntomas:**
```
permission denied while trying to connect to the Docker daemon socket
```

**Solución:**
```bash
# Agregar usuario al grupo docker
sudo usermod -aG docker $USER

# Reiniciar sesión (logout/login o reboot)
exit
# Reconectar
```

---

### 6. Node.js No Encontrado por Systemd

**Síntomas:**
```
ExecStart: node: not found
```

**Causa:** Systemd no tiene acceso al PATH de NVM.

**Solución:** Usar ruta absoluta en el servicio:

```bash
# Encontrar ruta de node
which node
# Ejemplo: /home/user/.nvm/versions/node/v20.18.3/bin/node

# Usar en ExecStart del servicio
ExecStart=/home/user/.nvm/versions/node/v20.18.3/bin/node dist/index.js
```

---

### 7. Caddy No Obtiene Certificado SSL

**Síntomas:**
- HTTPS no funciona
- Certificado inválido

**Causa:** DNS no apunta a la VM o firewall bloquea puerto 80.

**Solución:**
```bash
# Verificar DNS
nslookup multiagent.duckdns.org

# Verificar firewall permite 80/443
sudo ufw status
sudo ufw allow 80
sudo ufw allow 443

# Reiniciar Caddy
sudo systemctl restart caddy
sudo journalctl -u caddy -f  # Ver logs de obtención de certificado
```

---

## Arquitectura de Producción

```
┌─────────────────────────────────────────────────────────────────┐
│                         INTERNET                                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Caddy (HTTPS :443)                            │
│                 multiagent.duckdns.org                          │
│                   Auto-SSL via Let's Encrypt                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 Backend Node.js (:3001)                          │
│                 agents-backend.service                          │
│                   (Systemd managed)                             │
└─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    SQLite DB    │ │     Docker      │ │   GitHub API    │
│   data/app.db   │ │   Sandboxes     │ │   (OAuth/App)   │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## Checklist de Deploy

- [ ] VM creada con suficientes recursos (4 vCPU, 16GB RAM)
- [ ] Node.js 20 instalado
- [ ] Docker instalado y usuario en grupo docker
- [ ] Repositorio clonado
- [ ] `.env` configurado con valores de producción
- [ ] `npm install && npm run build` ejecutado
- [ ] Directorios de trabajo creados
- [ ] Servicio systemd creado y habilitado
- [ ] Caddy configurado con dominio
- [ ] DNS apuntando a IP de VM
- [ ] Firewall permite 80/443
- [ ] Health check responde: `curl https://domain/health`
- [ ] PM2 deshabilitado (si existía previamente)
- [ ] Base de datos NO trackeada en git

---

## Contacto y Soporte

Para problemas no cubiertos en esta guía:
1. Revisar logs: `sudo journalctl -u agents-backend -n 500`
2. Verificar estado de Docker: `docker ps -a`
3. Verificar conectividad: `curl localhost:3001/health`

---

**Última actualización:** 2026-01-25
**Versión:** 2.0.0
