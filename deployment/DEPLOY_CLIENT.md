# Multi-Agent Platform - Guía de Deployment para Clientes

## Requisitos Previos

- Docker y Docker Compose instalados
- Cuenta de MongoDB Atlas
- Cuenta de Anthropic (API key)
- GitHub OAuth App

---

## Paso 1: Crear MongoDB Atlas (5 minutos)

1. Ir a [MongoDB Atlas](https://cloud.mongodb.com)
2. Crear cuenta o iniciar sesión
3. Crear nuevo cluster (gratuito o de pago)
4. En "Database Access": Crear usuario con contraseña
5. En "Network Access": Agregar IP `0.0.0.0/0` (o tu IP específica)
6. En "Database": Click "Connect" → "Connect your application"
7. Copiar el connection string

```
mongodb+srv://usuario:<password>@cluster.xxxxx.mongodb.net/?retryWrites=true&w=majority
```

Reemplaza `<password>` con tu contraseña real.

---

## Paso 2: Crear GitHub OAuth App (3 minutos)

1. Ir a [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "OAuth Apps" → "New OAuth App"
3. Completar:
   - **Application name**: Multi-Agent Platform (tu empresa)
   - **Homepage URL**: http://tu-dominio:3001
   - **Authorization callback URL**: http://tu-dominio:3001/api/auth/github/callback
4. Click "Register application"
5. Copiar **Client ID**
6. Click "Generate a new client secret" y copiarlo

---

## Paso 3: Configurar .env (2 minutos)

1. Descargar archivos de configuración:

```bash
mkdir multi-agents && cd multi-agents
curl -O https://raw.githubusercontent.com/<org>/agents-software-arq/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/<org>/agents-software-arq/main/.env.client.template
mv .env.client.template .env
```

2. Editar `.env` con tus valores:

```bash
nano .env  # o tu editor favorito
```

Valores requeridos:
- `MONGODB_URI` - Connection string de MongoDB Atlas
- `ANTHROPIC_API_KEY` - API key de Anthropic
- `GITHUB_CLIENT_ID` - Client ID de OAuth App
- `GITHUB_CLIENT_SECRET` - Client Secret de OAuth App
- `JWT_SECRET` - Generar con: `openssl rand -base64 32`

---

## Paso 4: Iniciar (1 minuto)

```bash
docker compose up -d
```

¡Listo! Tu plataforma está corriendo.

---

## Verificar

```bash
# Ver estado
docker ps

# Ver logs
docker logs -f agents-backend

# Health check
curl http://localhost:3001/api/health
```

---

## Comandos Útiles

```bash
# Parar
docker compose down

# Reiniciar
docker compose restart

# Actualizar a nueva versión
docker compose pull
docker compose up -d

# Ver logs en tiempo real
docker logs -f agents-backend
```

---

## Estructura de Datos

Los datos se guardan en:
- **MongoDB Atlas**: Base de datos (tareas, proyectos, usuarios)
- **Docker Volume `agents-workspace`**: Workspaces de los agentes

Para backup del workspace:
```bash
docker run --rm -v agents-workspace:/data -v $(pwd):/backup alpine tar cvf /backup/workspace-backup.tar /data
```

---

## Soporte

- Documentación: [Link a docs]
- Issues: [Link a GitHub Issues]
- Email: soporte@tuempresa.com
