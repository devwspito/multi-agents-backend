# 🚀 Guía de Deployment en DigitalOcean

## ✅ Por qué DigitalOcean y NO Render

### Render NO puede ejecutar Claude Code porque:
- ❌ Contenedores inmutables (no puedes instalar después del build)
- ❌ Sin acceso root
- ❌ Claude Code no está en npm público
- ❌ No permite ejecución de comandos del sistema

### DigitalOcean SÍ puede porque:
- ✅ Control total del servidor
- ✅ Puedes instalar lo que quieras
- ✅ Acceso root completo
- ✅ Claude Code Emulator funciona perfectamente

## 📋 Pasos para Deployment

### 1. Crear Droplet en DigitalOcean

1. Ve a [DigitalOcean](https://www.digitalocean.com)
2. Crea un Droplet:
   - **Imagen**: Ubuntu 22.04 LTS
   - **Plan**: Basic ($12/mes mínimo recomendado)
   - **Región**: La más cercana a tus usuarios
   - **Autenticación**: SSH Key (más seguro)
   - **Nombre**: multi-agents-backend

### 2. Conectar por SSH

```bash
ssh root@YOUR_DROPLET_IP
```

### 3. Ejecutar Script de Instalación

```bash
# Descargar el script
wget https://raw.githubusercontent.com/devwspito/multi-agents-backend/main/backend/digitalocean-setup.sh

# Hacer ejecutable
chmod +x digitalocean-setup.sh

# Ejecutar
./digitalocean-setup.sh
```

### 4. Configurar Variables de Entorno

```bash
# Editar .env con tus claves reales
nano /var/www/multi-agents/backend/.env
```

Configura estas claves OBLIGATORIAS:
- `ANTHROPIC_API_KEY`: Tu API key de Anthropic
- `GITHUB_CLIENT_SECRET`: Tu secret de GitHub App
- `GITHUB_PRIVATE_KEY`: Tu private key de GitHub App

### 5. Configurar Dominio (Opcional)

Si tienes un dominio:

```bash
# Editar configuración de Nginx
nano /etc/nginx/sites-available/multi-agents

# Cambiar server_name your-domain.com por tu dominio real
# Guardar y salir

# Recargar Nginx
systemctl reload nginx

# Instalar certificado SSL
certbot --nginx -d tu-dominio.com
```

### 6. Verificar que Todo Funciona

```bash
# Ver logs
logs-multi-agents

# Verificar health endpoint
curl http://YOUR_SERVER_IP/health

# Ver status de PM2
sudo -u nodeapp pm2 status
```

## 🛠️ Comandos Útiles

### Ver Logs en Tiempo Real
```bash
logs-multi-agents
# o
sudo -u nodeapp pm2 logs multi-agents --lines 100
```

### Actualizar Aplicación
```bash
update-multi-agents
# o manualmente:
cd /var/www/multi-agents
sudo -u nodeapp git pull
cd backend
sudo -u nodeapp npm install
sudo -u nodeapp pm2 restart multi-agents
```

### Reiniciar Aplicación
```bash
sudo -u nodeapp pm2 restart multi-agents
```

### Ver Monitoreo
```bash
sudo -u nodeapp pm2 monit
```

## 🤖 Claude Code Emulator

El sistema usa automáticamente el **Claude Code Emulator** cuando Claude Code real no está disponible.

### Características del Emulator:
- ✅ Ejecuta comandos REALES del sistema
- ✅ Crea y edita archivos REALES
- ✅ Hace commits y PRs REALES
- ✅ Funciona IGUAL que Claude Code

### Cómo Funciona:
1. Recibe las instrucciones
2. Las envía a Claude API
3. Claude responde con comandos a ejecutar
4. El emulador ejecuta los comandos en el servidor
5. Devuelve los resultados

## 🔒 Seguridad

### Firewall Configurado
```bash
# Solo estos puertos están abiertos:
- 22 (SSH)
- 80 (HTTP)
- 443 (HTTPS)
```

### Aplicación corre como usuario sin privilegios
```bash
# La app corre como 'nodeapp', no como root
sudo -u nodeapp pm2 status
```

### SSL/TLS con Certbot
```bash
# Certificado gratuito de Let's Encrypt
certbot --nginx -d tu-dominio.com
```

## 🚨 Troubleshooting

### Si la aplicación no arranca:
```bash
# Ver logs de error
sudo -u nodeapp pm2 logs multi-agents --err --lines 50

# Verificar .env
cat /var/www/multi-agents/backend/.env | grep API_KEY

# Reiniciar PM2
sudo -u nodeapp pm2 kill
sudo -u nodeapp pm2 start /var/www/multi-agents/ecosystem.config.js
```

### Si Nginx da error:
```bash
# Test configuración
nginx -t

# Ver logs
tail -f /var/log/nginx/error.log

# Reiniciar
systemctl restart nginx
```

### Si MongoDB no conecta:
```bash
# Verificar connection string en .env
grep MONGODB_URI /var/www/multi-agents/backend/.env

# Test conexión
node -e "require('mongoose').connect('YOUR_MONGODB_URI').then(() => console.log('OK')).catch(e => console.error(e))"
```

## 💰 Costos Estimados

- **Droplet Basic**: $12-24/mes
- **Backups**: $2.40/mes (opcional pero recomendado)
- **Dominio**: $10-15/año (opcional)
- **Total**: ~$15-30/mes

## 🎯 Resultado Final

Con esta configuración tendrás:
- ✅ Multi-Agent Platform funcionando 24/7
- ✅ Claude Code Emulator ejecutando comandos REALES
- ✅ HTTPS con certificado SSL
- ✅ Logs y monitoreo con PM2
- ✅ Updates fáciles con un comando

## 📞 Soporte

Si tienes problemas:
1. Revisa los logs: `logs-multi-agents`
2. Verifica el .env tiene todas las claves
3. Asegúrate que MongoDB está accesible
4. Verifica que el puerto 3001 está funcionando: `curl localhost:3001/health`

---

**IMPORTANTE**: Claude Code Emulator funciona EXACTAMENTE igual que Claude Code. Ejecuta comandos reales, edita archivos reales, hace commits reales. La única diferencia es que usa la API en lugar de la CLI.