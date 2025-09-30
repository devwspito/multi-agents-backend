# Multi-Tenant GitHub OAuth Integration

## 🎯 Diseño Multi-Tenant

Este sistema permite que **múltiples usuarios** conecten sus **propias cuentas de GitHub** y trabajen con **sus propios repositorios**.

### ❌ Enfoque Anterior (Incorrecto)
```javascript
// Un solo token para todo el servidor
GITHUB_TOKEN=ghp_server_token
```

### ✅ Nuevo Enfoque (Correcto)
```javascript
// Cada usuario tiene su propio token OAuth
user.github.accessToken = "ghp_user_individual_token"
```

## 🔧 Configuración Required

### 1. Variables de Entorno
```bash
# GitHub OAuth App
GITHUB_CLIENT_ID=tu_github_oauth_client_id
GITHUB_CLIENT_SECRET=tu_github_oauth_client_secret

# Session management
SESSION_SECRET=tu_session_secret_muy_seguro

# Base URLs
BASE_URL=http://localhost:3000
FRONTEND_URL=http://localhost:3001
```

### 2. Crear GitHub OAuth App

1. Ve a GitHub Settings → Developer settings → OAuth Apps
2. Click "New OAuth App"
3. Configura:
   - Application name: "Tu App Multi-Tenant"
   - Homepage URL: `http://localhost:3001`
   - Authorization callback URL: `http://localhost:3000/api/github-auth/callback`

## 🔄 Flujo de Autenticación

### 1. Conectar GitHub
```http
GET /api/github-auth/url
Authorization: Bearer jwt_token

Response:
{
  "success": true,
  "data": {
    "authUrl": "https://github.com/login/oauth/authorize?client_id=...",
    "state": "user_id-timestamp-random"
  }
}
```

### 2. Callback GitHub
```http
GET /api/github-auth/callback?code=xxx&state=xxx

# Automáticamente:
# 1. Intercambia code por access_token
# 2. Obtiene perfil de GitHub del usuario
# 3. Guarda token en user.github.accessToken
# 4. Redirige al frontend con éxito
```

### 3. Estado de Conexión
```http
GET /api/github-auth/status
Authorization: Bearer jwt_token

Response:
{
  "success": true,
  "data": {
    "connected": true,
    "github": {
      "username": "usuario123",
      "profile": { ... },
      "connectedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

## 📋 Endpoints Disponibles

### GitHub Authentication
- `GET /api/github-auth/url` - Obtener URL de autorización
- `GET /api/github-auth/callback` - Callback OAuth
- `GET /api/github-auth/status` - Estado de conexión
- `GET /api/github-auth/repositories` - Repositorios del usuario
- `DELETE /api/github-auth/disconnect` - Desconectar GitHub

### Proyectos con GitHub
- `POST /api/projects` - Crear proyecto (requiere GitHub conectado)
- `GET /api/projects/:id/github` - Info GitHub del proyecto
- `POST /api/projects/:id/sync-github` - Sincronizar con GitHub

## 💾 Modelo de Usuario Actualizado

```javascript
const user = {
  username: "usuario123",
  email: "usuario@example.com",
  // ... otros campos
  
  // Integración GitHub Multi-tenant
  github: {
    id: "12345678",
    username: "usuario123",
    accessToken: "ghp_xxxxxxxxxxxx", // Token individual del usuario
    refreshToken: "ghr_xxxxxxxxxxxx",
    connectedAt: "2024-01-01T00:00:00.000Z",
    lastSyncAt: "2024-01-01T00:00:00.000Z",
    profile: {
      login: "usuario123",
      name: "Usuario Ejemplo",
      email: "usuario@example.com",
      avatar_url: "https://avatars.githubusercontent.com/u/12345678",
      bio: "Desarrollador Full Stack",
      company: "Mi Empresa",
      location: "Ciudad, País",
      public_repos: 25,
      followers: 100,
      following: 150
    }
  }
}
```

## 🔧 Uso en Servicios

### Antes (Incorrecto)
```javascript
class GitHubService {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN // ❌ Token global
    });
  }
}
```

### Después (Correcto)
```javascript
class GitHubService {
  getOctokitForUser(userGitHubToken) {
    return new Octokit({
      auth: userGitHubToken // ✅ Token del usuario específico
    });
  }
  
  async createRepository(project, userGitHubToken) {
    const octokit = this.getOctokitForUser(userGitHubToken);
    // Ahora usa el token del usuario para crear repos en SU cuenta
  }
}
```

### En las Rutas
```javascript
// Middleware que requiere GitHub conectado
router.post('/projects', 
  authenticate, 
  requireGitHubConnection, // ✅ Verifica que user tenga GitHub
  async (req, res) => {
    // req.githubToken está disponible
    const repo = await githubService.createRepository(
      projectData, 
      req.githubToken // ✅ Token del usuario autenticado
    );
  }
);
```

## 🔐 Seguridad

### 1. Tokens Protegidos
```javascript
// Los tokens NO se incluyen en consultas por defecto
const user = await User.findById(id); // github.accessToken no incluido

// Explícitamente incluir solo cuando sea necesario
const user = await User.findById(id).select('+github.accessToken');
```

### 2. Validación de Estado OAuth
```javascript
// Protección CSRF con state parameter
const state = `${userId}-${timestamp}-${random}`;
req.session.githubAuthState = state; // Guardado en sesión
// Verificado en callback
```

### 3. Permisos Granulares
```javascript
const scopes = [
  'repo',          // Acceso a repositorios
  'read:user',     // Leer perfil usuario
  'user:email'     // Leer email usuario
];
```

## 🚀 Beneficios del Diseño Multi-Tenant

### ✅ Ventajas
1. **Seguridad**: Cada usuario solo accede a SUS repos
2. **Escalabilidad**: No hay límites de rate limiting globales
3. **Autonomía**: Usuarios controlan sus propias conexiones
4. **Compliance**: Datos separados por usuario
5. **Flexibilidad**: Cada usuario puede tener diferentes permisos

### ❌ Problemas Resueltos
1. ~~Token global compartido~~
2. ~~Acceso no autorizado a repos~~
3. ~~Rate limiting compartido~~
4. ~~Dependencia de configuración del servidor~~
5. ~~Problemas de permisos entre usuarios~~

## 📊 Flujo Completo

```
1. Usuario se registra/login en la app
2. Usuario va a "Conectar GitHub" 
3. Redirigido a GitHub OAuth
4. Usuario autoriza los permisos
5. GitHub redirige con code
6. Backend intercambia code por access_token
7. Backend guarda token en user.github.accessToken
8. Usuario puede crear proyectos usando SUS repos
9. Cada operación usa el token del usuario específico
```

## 🔧 Migración

### Para Proyectos Existentes
```javascript
// Migrar proyectos existentes para asociarlos con usuarios
db.projects.updateMany(
  { owner: { $exists: false } },
  { $set: { owner: ObjectId("user_id") } }
);
```

### Variables de Entorno
```bash
# Remover (ya no necesarias)
# GITHUB_TOKEN=ghp_xxx
# GITHUB_APP_ID=xxx
# GITHUB_PRIVATE_KEY=xxx

# Agregar (nuevas requeridas)
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx
SESSION_SECRET=xxx
```

Este diseño transforma el sistema en una verdadera plataforma multi-tenant donde cada usuario mantiene control total sobre su cuenta de GitHub y sus repositorios.