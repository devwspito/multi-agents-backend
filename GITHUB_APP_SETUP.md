# GitHub App Configuration Guide

## 🎯 GitHub App vs OAuth App

Tu plataforma necesita **AMBOS**:

### GitHub OAuth App (para login de usuarios)
- ✅ Permite que usuarios conecten sus cuentas
- ✅ Obtiene permisos para acceder a sus repos
- ✅ Usuario autoriza tu app manualmente

### GitHub App (para operaciones automáticas)
- ✅ Permite operaciones del servidor
- ✅ Crear ramas, commits, PRs automáticamente  
- ✅ Webhooks para sincronización
- ✅ GitHub Actions triggers

## 📋 Paso 1: Crear GitHub App

1. Ve a **GitHub Settings > Developer settings > GitHub Apps**
2. Click **"New GitHub App"**
3. Configuración básica:

```
App name: "Multi-Agent Development Platform"
Homepage URL: https://tu-dominio.com
User authorization callback URL: https://tu-dominio.com/auth/github/callback
Setup URL: https://tu-dominio.com/setup
Webhook URL: https://tu-dominio.com/webhooks/github
Webhook secret: tu_webhook_secret_muy_seguro
```

## 🔐 Paso 2: Permisos necesarios

### Repository permissions:
- **Contents**: Read & write (crear/modificar archivos)
- **Issues**: Write (crear issues para tasks)
- **Metadata**: Read (info básica del repo)
- **Pull requests**: Write (crear y gestionar PRs)
- **Actions**: Write (ejecutar GitHub Actions)
- **Checks**: Write (status checks)

### Organization permissions:
- **Members**: Read (si trabajas con organizaciones)

### User permissions:
- **Email addresses**: Read (para notificaciones)

## 🎣 Paso 3: Webhooks que necesitas

```json
{
  "events": [
    "push",
    "pull_request", 
    "pull_request_review",
    "check_run",
    "installation",
    "installation_repositories"
  ]
}
```

## 🔑 Paso 4: Variables de entorno

Después de crear la app, obtienes:

```env
# GitHub App
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
tu_private_key_completo_aqui
-----END PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=tu_webhook_secret

# GitHub OAuth (por separado)
GITHUB_CLIENT_ID=Iv1.tu_oauth_client_id
GITHUB_CLIENT_SECRET=tu_oauth_client_secret
```

## 🏗️ Paso 5: Instalación por cliente

Cada cliente debe **instalar tu GitHub App** en sus repositorios:

1. Cliente va a: `https://github.com/apps/tu-app-name`
2. Click "Install"
3. Selecciona repositorios donde quiere agentes
4. Tu app recibe `installation_id` automáticamente

## 🚀 Paso 6: Flujo completo

```javascript
// 1. Cliente hace OAuth login
POST /api/auth/github

// 2. Cliente instala GitHub App en sus repos
// (GitHub envía webhook installation)

// 3. Tu sistema puede trabajar automáticamente
// OAuth: Para leer repos del usuario
// GitHub App: Para crear ramas, PRs, actions

// 4. Agentes trabajan con gestión de conflictos
POST /api/tasks/execute
// -> Crea branch automáticamente
// -> Evita conflictos entre agentes
// -> Libera branch al terminar
```

## 📊 Endpoints de monitoreo

```bash
# Ver estado de todos los repositorios
GET /api/repositories/all

# Ver estado específico
GET /api/repositories/owner/repo-name

# Liberar rama manualmente (admin)
POST /api/repositories/force-release/branch-name

# Limpieza de emergencia
POST /api/repositories/emergency-cleanup
```

## ⚠️ Consideraciones importantes

### Límites de GitHub API
- **5000 requests/hour** por GitHub App
- **1000 requests/hour** por OAuth token
- Tu sistema maneja **múltiples clientes** → usa rate limiting

### Seguridad
- **Private key** debe estar bien protegida
- **Webhook secret** para verificar requests
- **Installation ID** se almacena por cliente

### Conflictos
- ✅ **BranchManager** previene conflictos entre agentes
- ✅ **Cola automática** cuando repositorio ocupado
- ✅ **Liberación automática** al terminar trabajo
- ✅ **Cleanup de emergencia** para locks antiguos

## 🔧 Testing

```bash
# 1. Instalar dependencias
npm install

# 2. Configurar .env con tus credenciales
cp .env.correct .env

# 3. Iniciar servidor
npm run dev

# 4. Probar status
curl http://localhost:3000/api/repositories/all
```

Tu plataforma ahora puede manejar **múltiples clientes** trabajando simultáneamente sin conflictos. 🎯