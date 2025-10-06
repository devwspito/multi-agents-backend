# Migración a Claude Agent SDK TypeScript

## ✅ Completado

Se ha creado un nuevo backend **backend-ts/** que usa el **Claude Agent SDK oficial** de Anthropic.

### Cambios principales:

1. **TypeScript puro** con validación Zod
2. **Claude Agent SDK oficial** (no emulador)
3. **6 agentes especializados** con el SDK real
4. **Sistema de archivos real** para los agentes
5. **Bash real** ejecutado por los agentes
6. **Context management automático** del SDK
7. **Subagents nativos** para paralelización

## 📁 Estructura nueva

```
backend-ts/
├── src/
│   ├── config/
│   │   ├── env.ts              # Validación Zod de env vars
│   │   └── database.ts         # MongoDB connection
│   ├── models/
│   │   ├── User.ts             # Modelo de usuario
│   │   └── Task.ts             # Modelo de tarea con orchestration
│   ├── routes/
│   │   ├── auth.ts             # GitHub OAuth
│   │   └── tasks.ts            # CRUD + orchestration
│   ├── services/
│   │   └── AgentService.ts     # 🔥 CORE - Claude Agent SDK
│   ├── middleware/
│   │   └── auth.ts             # JWT authentication
│   └── index.ts                # Express app
├── package.json
├── tsconfig.json
├── deploy-vultr.sh             # Deploy automático
└── README.md
```

## 🚀 Próximos pasos

### 1. Probar localmente

```bash
cd backend-ts

# Instalar dependencias
npm install

# Copiar .env
cp .env.example .env

# Editar con tus credenciales
nano .env

# Ejecutar en desarrollo
npm run dev
```

### 2. Desplegar en Vultr

```bash
# En la consola de Vultr:
bash <(curl -s https://raw.githubusercontent.com/devwspito/multi-agents-backend/main/backend-ts/deploy-vultr.sh)
```

### 3. Actualizar frontend

El frontend necesita apuntar a la nueva API:

```javascript
// Cambiar en tu frontend
const API_URL = 'http://TU_IP_VULTR'; // o https si configuras SSL
```

### 4. Migrar datos (opcional)

Si tienes datos en el backend antiguo, puedes migrarlos:

```bash
# TODO: Crear script de migración de datos
# Por ahora, los usuarios tendrán que volver a autenticarse
```

## 🔄 Diferencias clave

### Antes (backend/)
- ❌ Emulador casero de Claude Code
- ❌ No tiene file system real
- ❌ No tiene bash real
- ❌ Reinventa el wheel
- ❌ JavaScript sin tipos

### Ahora (backend-ts/)
- ✅ Claude Agent SDK oficial
- ✅ File system real para agentes
- ✅ Bash real ejecutado
- ✅ Usa todo el trabajo de Anthropic
- ✅ TypeScript con validación

## 📊 API Endpoints

Los endpoints son los mismos, solo cambia la implementación interna:

```bash
# Auth
POST /api/auth/github
GET  /api/auth/github/callback
GET  /api/auth/me

# Tasks
GET    /api/tasks              # Listar tasks
POST   /api/tasks              # Crear task
GET    /api/tasks/:id          # Ver task
POST   /api/tasks/:id/start    # 🔥 Iniciar orchestration
GET    /api/tasks/:id/status   # Ver progreso
GET    /api/tasks/:id/orchestration  # Ver detalles
DELETE /api/tasks/:id          # Eliminar task
```

## 🤖 Cómo funcionan los agentes ahora

### Agent Loop oficial:

```
1. Gather context
   - Agentic search (Grep, Glob)
   - Read files
   - Semantic search (opcional)
   - Subagents en paralelo

2. Take action
   - Tools (Bash, Edit, Write)
   - Code generation
   - MCP servers
   - Real bash execution

3. Verify work
   - Rules (linting, tests)
   - Visual feedback
   - LLM as judge

4. Repeat until done
```

### Ejemplo de orchestration:

```typescript
// Crear tarea
POST /api/tasks
{
  "title": "Build login system",
  "description": "Implement JWT authentication with GitHub OAuth"
}

// Iniciar agentes
POST /api/tasks/:id/start

// Los 6 agentes se ejecutan en secuencia:
// 1. product-manager   → Analiza requirements
// 2. project-manager   → Desglosa en stories
// 3. tech-lead         → Diseña arquitectura
// 4. senior-developer  → Implementa backend
// 5. junior-developer  → Implementa UI
// 6. qa-engineer       → Valida TODO (FINAL GATE)
```

## 🔐 Variables de entorno

Necesitas configurar en `.env`:

```bash
MONGODB_URI=mongodb+srv://...
ANTHROPIC_API_KEY=sk-ant-api03-...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
JWT_SECRET=min-32-chars
SESSION_SECRET=min-32-chars
FRONTEND_URL=https://...
PORT=3001
NODE_ENV=production
```

## 📚 Recursos

- [Claude Agent SDK Docs](https://docs.anthropic.com/en/api/agent-sdk/overview)
- [Building Agents Article](https://www.anthropic.com/engineering/building-agents-with-claude-agent-sdk)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

## ✅ Testing

```bash
cd backend-ts

# Type check
npm run typecheck

# Build
npm run build

# Run
npm start
```

## 🎯 Próxima fase

1. ✅ Migración completa a TypeScript + SDK
2. ⏳ Testing local
3. ⏳ Deploy en Vultr
4. ⏳ Conectar frontend
5. ⏳ Testing end-to-end
6. ⏳ Agregar features (MCP servers, etc.)

---

**La migración está lista. Hora de probar y desplegar! 🚀**
