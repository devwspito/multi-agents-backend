# Configuración de Render para Claude Code

## 🔧 Configuración del Servicio en Render

### 1. Build Command
```bash
./render-build.sh
```

### 2. Start Command
```bash
npm start
```

### 3. Variables de Entorno Requeridas

#### Claude Code (REQUERIDO)
```bash
ANTHROPIC_API_KEY=sk-ant-api03-...
NODE_ENV=production
```

#### Base de Datos
```bash
MONGODB_URI=mongodb+srv://...
```

#### JWT y Seguridad
```bash
JWT_SECRET=tu-secret-key-seguro
SESSION_SECRET=tu-session-secret
```

#### Redis (Render)
```bash
REDIS_URL=rediss://red-d3ftv163jp1c73f9jgv0:amm4oqlcMPlV3tkZWJx9D9Ac9ZcF6RHk@oregon-keyvalue.render.com:6379
```

#### GitHub OAuth (Opcional)
```bash
GITHUB_CLIENT_ID=tu-github-client-id
GITHUB_CLIENT_SECRET=tu-github-client-secret
GITHUB_WEBHOOK_SECRET=tu-webhook-secret
GITHUB_PRIVATE_KEY_BASE64=tu-private-key-base64
GITHUB_APP_ID=tu-app-id
```

#### Frontend
```bash
FRONTEND_URL=https://multi-agents-d6279.web.app
```

#### Workspace y Uploads
```bash
WORKSPACE_BASE=/tmp/workspaces
UPLOAD_DIR=/tmp/uploads
```

## 🚀 Paso a Paso

### En el Dashboard de Render:

1. **Ve a tu servicio** `multi-agents-backend`

2. **Settings → Build & Deploy**
   - Build Command: `./render-build.sh`
   - Start Command: `npm start`

3. **Environment → Environment Variables**
   - Agrega `ANTHROPIC_API_KEY` con tu API key de Claude

4. **Manual Deploy**
   - Haz clic en "Manual Deploy" → "Deploy latest commit"

## ✅ Verificación

Después del deployment, revisa los logs:
```
📦 Installing npm dependencies...
🤖 Installing Claude Code CLI...
✅ Verifying Claude Code installation...
🏗️ Build completed successfully
```

Si ves estos mensajes, Claude Code está instalado correctamente.

## 🔍 Troubleshooting

### Error: "claude: not found"
- Verifica que el build script se ejecutó correctamente
- Revisa los logs de build en Render

### Error: "ANTHROPIC_API_KEY is required"
- Agrega la variable de entorno en Render Dashboard
- Redeploy el servicio

### Error: "Token limit exceeded"
- Verifica tu plan de Anthropic
- Revisa el consumo de tokens en el dashboard de Anthropic
