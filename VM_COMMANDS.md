# VM Commands - Quick Reference

Comandos para monitorizar y gestionar el servidor de producción.

---

## Logs

```bash
# Logs en tiempo real (CTRL+C para salir)
sudo journalctl -u agents-backend -f

# Últimos 100 logs
sudo journalctl -u agents-backend -n 100

# Logs de la última hora
sudo journalctl -u agents-backend --since "1 hour ago"

# Logs de hoy
sudo journalctl -u agents-backend --since today

# Buscar errores en logs
sudo journalctl -u agents-backend | grep -i error

# Logs de Caddy (proxy HTTPS)
sudo journalctl -u caddy -f
```

---

## Servicio Backend

```bash
# Estado
sudo systemctl status agents-backend

# Arrancar
sudo systemctl start agents-backend

# Parar
sudo systemctl stop agents-backend

# Reiniciar
sudo systemctl restart agents-backend

# Ver si está habilitado para auto-start
sudo systemctl is-enabled agents-backend
```

---

## Health Check

```bash
# Local
curl http://localhost:3001/health

# Con formato JSON bonito
curl -s http://localhost:3001/health | jq .

# Externo (via Caddy/HTTPS)
curl https://multiagent.duckdns.org/health
```

---

## Docker / Sandboxes

```bash
# Ver contenedores corriendo
docker ps

# Ver contenedores con formato limpio
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

# Ver TODOS los contenedores (incluso parados)
docker ps -a

# Logs de un contenedor específico
docker logs <container-id> --tail 100

# Logs en tiempo real de un contenedor
docker logs <container-id> -f

# Entrar a un contenedor (shell interactivo)
docker exec -it <container-id> bash

# Ver uso de recursos de contenedores
docker stats

# Limpiar contenedores parados
docker container prune -f

# Limpiar imágenes no usadas
docker image prune -f

# Limpiar TODO (contenedores, imágenes, volúmenes)
docker system prune -af
```

---

## Puertos y Procesos

```bash
# Ver qué usa el puerto 3001
sudo ss -tlnp | grep 3001

# Ver todos los puertos en uso
sudo ss -tlnp

# Ver procesos node
ps aux | grep node

# Matar proceso en puerto 3001
sudo fuser -k 3001/tcp

# Matar todos los procesos node
sudo pkill -9 -f node
```

---

## Sistema

```bash
# Uso de CPU y memoria (tiempo real)
htop
# o
top

# Uso de disco
df -h

# Memoria
free -h

# Uptime del sistema
uptime
```

---

## Deploy Rápido

```bash
# Deploy completo (copia y pega todo junto)
pm2 kill 2>/dev/null; \
sudo systemctl stop agents-backend && \
sudo systemctl mask agents-backend && \
sudo pkill -9 -f node; \
cd ~/agents-software-arq && \
git pull origin main && \
npm run build && \
sudo systemctl unmask agents-backend && \
sudo systemctl start agents-backend && \
sudo systemctl status agents-backend
```

---

## Troubleshooting

### Error: EADDRINUSE (puerto en uso)
```bash
# 1. Ver qué usa el puerto
sudo ss -tlnp | grep 3001

# 2. Matar PM2 si existe
pm2 kill

# 3. Matar proceso
sudo fuser -k 3001/tcp

# 4. Reiniciar
sudo systemctl restart agents-backend
```

### Bucle de reinicio (PM2 conflicto)
```bash
# Solución nuclear
pm2 kill
sudo systemctl stop agents-backend
sudo systemctl mask agents-backend
sudo pkill -9 -f node
sleep 2
sudo ss -tlnp | grep 3001  # Debe estar vacío
sudo systemctl unmask agents-backend
sudo systemctl start agents-backend
```

### Sandbox no arranca
```bash
# Ver logs del contenedor
docker ps  # Obtener container ID
docker logs <container-id> --tail 200

# Ver si hay error de imagen
docker ps --format "{{.Names}} {{.Image}}"

# Limpiar pool corrupto (si usa imagen incorrecta)
# Desde SQLite:
sqlite3 ~/agents-software-arq/data/app.db "SELECT * FROM sandbox_pool_state;"
sqlite3 ~/agents-software-arq/data/app.db "DELETE FROM sandbox_pool_state WHERE repo_name LIKE '%flutter%';"
```

---

## Alias Útiles

Agregar a `~/.bashrc`:

```bash
# Agregar estos alias
cat << 'EOF' >> ~/.bashrc

# Multi-Agent aliases
alias logs='sudo journalctl -u agents-backend -f'
alias status='sudo systemctl status agents-backend'
alias restart='sudo systemctl restart agents-backend'
alias health='curl -s http://localhost:3001/health | jq .'
alias dps='docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"'
alias deploy='cd ~/agents-software-arq && git pull && npm run build && sudo systemctl restart agents-backend'

EOF

# Recargar
source ~/.bashrc
```

Después puedes usar:
- `logs` - Ver logs en tiempo real
- `status` - Estado del servicio
- `restart` - Reiniciar servicio
- `health` - Health check
- `dps` - Ver contenedores Docker
- `deploy` - Deploy rápido

---

## URLs Importantes

| Recurso | URL |
|---------|-----|
| Frontend | https://multiagent.duckdns.org |
| Health | https://multiagent.duckdns.org/health |
| API | https://multiagent.duckdns.org/api/v1/... |

---

**Última actualización:** 2026-01-25
