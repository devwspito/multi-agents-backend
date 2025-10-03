# 📚 **Backend API Documentation - Multi-Agent Platform**

## 📋 **Resumen Ejecutivo**

**Plataforma Multi-Agente** powered by **Claude Code** siguiendo las **mejores prácticas oficiales** de Anthropic. Sistema de **orquestación completamente automática** donde cada tarea pasa por TODOS los 6 sub-agentes de forma secuencial sin intervención manual.

---

## 🤖 **Motor Principal: Claude Code (Especificaciones Oficiales)**

### **✅ Configuración Oficial Claude Code**
El proyecto está **100% alineado** con las mejores prácticas oficiales de Claude Code:
- **Subagentes** configurados según especificaciones oficiales en `.claude/agents/`
- **CLAUDE.md** completo con bash commands, core files, y repository etiquette
- **Tools inheritance** - Todos los agentes heredan TODAS las herramientas disponibles
- **Model optimization** - Opus para planificación (razonamiento), Sonnet para implementación (ejecución)

### **🎯 Arquitectura de Orquestación Automática:**
```
USUARIO → CREA TAREA + IMAGEN → ORQUESTADOR AUTOMÁTICO → CLAUDE CODE
                                         ↓
                              Pipeline Automático Fijo:
                              1. product-manager
                              2. project-manager  
                              3. tech-lead
                              4. senior-developer
                              5. junior-developer
                              6. qa-engineer
                                         ↓
                              RESULTADOS + CÓDIGO
```

### **🔄 Flujo de Trabajo Optimizado:**
1. **Usuario crea tarea** (título, descripción) + **imagen opcional**
2. **Sistema inicia orquestación COMPLETAMENTE AUTOMÁTICA** de 6 agentes en background
3. **Cada agente ejecuta secuencialmente** con acceso a TODAS las herramientas
4. **Usuario monitorea progreso** en tiempo real vía polling
5. **Resultado final** cuando todos los agentes completan automáticamente

### **📋 Sub-Agentes Claude Code (Configuración Optimizada):**
```yaml
# Agentes de PLANIFICACIÓN (Claude Opus - Mayor capacidad de razonamiento)
├── product-manager.md     # Análisis de requisitos y especificaciones (model: opus)
├── project-manager.md     # Desglose de tareas y planificación (model: opus)
├── tech-lead.md          # Diseño de arquitectura técnica (model: opus)

# Agentes de IMPLEMENTACIÓN (Claude Sonnet - Ejecución eficiente)
├── senior-developer.md   # Implementación compleja + code review (model: sonnet)
├── junior-developer.md   # UI components + features simples (model: sonnet)
└── qa-engineer.md        # Testing y validación de calidad (model: sonnet)
```

### **🎯 Sistema de Tracking de Tokens**
**Control completo de consumo** para ambos modelos Claude:

```yaml
# TRACKING AUTOMÁTICO
├── TokenUsage.js          # Modelo de base de datos para uso de tokens
├── TokenTrackingService.js # Servicio centralizado de tracking
├── ClaudeService.js       # Integración con tracking en cada ejecución
└── token-usage.js         # API endpoints para consultas

# CARACTERÍSTICAS PRINCIPALES
├── ✅ Conteo preciso por modelo (Opus/Sonnet)
├── ✅ Límites diarios y mensuales por usuario
├── ✅ Cálculo de costos en tiempo real
├── ✅ Analytics y tendencias de uso
├── ✅ Exportación de datos (JSON/CSV)
├── ✅ Verificación de límites antes de ejecución
└── ✅ Headers HTTP con información de uso
```

**📊 Precios Claude (Actualizados 2024):**
```yaml
Claude Opus:
  input:  $15 per 1M tokens
  output: $75 per 1M tokens

Claude Sonnet:  
  input:  $3 per 1M tokens
  output: $15 per 1M tokens
```

**⚠️ IMPORTANTE**: 
- El usuario NUNCA asigna agentes manualmente
- Todos los agentes heredan TODAS las herramientas (sin restricciones)
- Orquestación es completamente automática y no-bloqueante
- Solo se soportan imágenes según especificaciones oficiales de Claude Code

---

## 🔐 **1. Autenticación**

### **POST /api/auth/register**
Registra un nuevo usuario en la plataforma.

**Request:**
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**Response 201:**
```json
{
  "success": true,
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refreshToken": "refresh_token_here",
  "user": {
    "_id": "676d1234567890abcdef1234",
    "name": "John Doe",
    "email": "john@example.com",
    "provider": "local",
    "permissions": ["read", "write"],
    "preferences": {
      "language": "en",
      "timezone": "UTC",
      "notifications": true
    },
    "activity": {
      "lastLogin": "2024-01-01T00:00:00.000Z",
      "projectsCount": 0,
      "tasksCompleted": 0
    }
  }
}
```

### **POST /api/auth/login**
Autentica un usuario existente.

**Request:**
```json
{
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**Response 200:** (Mismo formato que register)

### **POST /api/auth/refresh**
Renueva el token de acceso usando el refresh token.

**Request:**
```json
{
  "refreshToken": "refresh_token_here"
}
```

**Response 200:** (Mismo formato que login)

### **GET /api/auth/me**
Obtiene información del usuario autenticado.

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "_id": "676d1234567890abcdef1234",
    "name": "John Doe",
    "email": "john@example.com",
    "avatar": "https://avatar.url",
    "provider": "github",
    "permissions": ["read", "write", "admin"],
    "preferences": {
      "language": "es",
      "timezone": "Europe/Madrid",
      "notifications": false
    },
    "github": {
      "username": "johndoe",
      "avatarUrl": "https://github.com/johndoe.png"
    },
    "activity": {
      "lastLogin": "2024-01-01T12:30:00.000Z",
      "projectsCount": 8,
      "tasksCompleted": 45
    }
  }
}
```

---

## 🔗 **2. GitHub OAuth**

### **GET /api/github-auth/url**
Genera URL para autenticación con GitHub.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "url": "https://github.com/login/oauth/authorize?client_id=abc123&state=xyz789",
    "state": "xyz789"
  }
}
```

### **POST /api/github-auth/callback**
Procesa el callback de GitHub OAuth.

**Request:**
```json
{
  "code": "github_oauth_code",
  "state": "xyz789"
}
```

**Response 200:** (Mismo formato que login con datos de GitHub)

### **GET /api/github-auth/repositories**
Lista repositorios de GitHub del usuario.

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Query Parameters:**
- `page`: Número de página (default: 1)
- `limit`: Elementos por página (default: 20)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "repositories": [
      {
        "id": 123456789,
        "name": "my-awesome-project",
        "full_name": "johndoe/my-awesome-project",
        "html_url": "https://github.com/johndoe/my-awesome-project",
        "private": false,
        "default_branch": "main",
        "language": "JavaScript",
        "description": "An awesome project"
      }
    ],
    "total": 45,
    "page": 1,
    "limit": 20,
    "totalPages": 3
  }
}
```

---

## 📁 **3. Proyectos**

### **GET /api/projects**
Lista proyectos del usuario.

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Query Parameters:**
- `page`: Número de página (default: 1)
- `limit`: Elementos por página (default: 10)
- `status`: Filtrar por estado (`active`, `completed`, `archived`)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "projects": [
      {
        "_id": "676d1234567890abcdef5678",
        "name": "E-commerce Platform",
        "description": "Full-stack e-commerce solution",
        "owner": "676d1234567890abcdef1234",
        "projectType": "web-app",
        "status": "active",
        "repositories": [
          {
            "name": "frontend",
            "url": "https://github.com/johndoe/ecommerce-frontend",
            "branch": "main"
          }
        ],
        "team": ["676d1234567890abcdef1234"],
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T12:00:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
}
```

### **POST /api/projects**
Crea un nuevo proyecto.

**Headers:**
```
Authorization: Bearer <accessToken>
```

**Request:**
```json
{
  "name": "Mobile Shopping App",
  "description": "React Native shopping application",
  "projectType": "mobile-app",
  "repositories": [
    {
      "name": "mobile-app",
      "url": "https://github.com/johndoe/shopping-mobile",
      "branch": "develop"
    }
  ]
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "_id": "676d1234567890abcdef9999",
    "name": "Mobile Shopping App",
    "description": "React Native shopping application",
    "owner": "676d1234567890abcdef1234",
    "projectType": "mobile-app",
    "status": "active",
    "repositories": [
      {
        "name": "mobile-app",
        "url": "https://github.com/johndoe/shopping-mobile",
        "branch": "develop"
      }
    ],
    "team": ["676d1234567890abcdef1234"],
    "createdAt": "2024-01-01T13:00:00.000Z",
    "updatedAt": "2024-01-01T13:00:00.000Z"
  }
}
```

### **GET /api/projects/:id**
Obtiene un proyecto específico.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "_id": "676d1234567890abcdef5678",
    "name": "E-commerce Platform",
    // ... resto de campos del proyecto
  }
}
```

### **POST /api/projects/:id/repositories**
Añade un repositorio al proyecto.

**Request:**
```json
{
  "name": "backend-api",
  "url": "https://github.com/johndoe/ecommerce-backend",
  "branch": "main"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "repositoryId": "repo_internal_id_12345"
  }
}
```

---

## 📋 **4. Tareas y Orquestación Automática**

### **GET /api/tasks**
Lista tareas del usuario.

**Query Parameters:**
- `projectId`: Filtrar por proyecto
- `status`: Filtrar por estado
- `complexity`: Filtrar por complejidad
- `page`, `limit`: Paginación

**Response 200:**
```json
{
  "success": true,
  "data": {
    "tasks": [
      {
        "_id": "676d1234567890abcdef7777",
        "title": "Implement User Authentication",
        "description": "Add JWT-based authentication system",
        "project": "676d1234567890abcdef5678",
        "complexity": "moderate",
        "priority": "high",
        "status": "in-progress",
        "orchestration": {
          "status": "pending",
          "currentStep": 2,
          "pipeline": [
            { "agent": "product-manager", "status": "completed" },
            { "agent": "project-manager", "status": "in-progress" },
            { "agent": "tech-lead", "status": "pending" },
            { "agent": "senior-developer", "status": "pending" },
            { "agent": "junior-developer", "status": "pending" },
            { "agent": "qa-engineer", "status": "pending" }
          ]
        },
        "estimatedHours": 16,
        "createdAt": "2024-01-01T00:00:00.000Z",
        "updatedAt": "2024-01-01T12:00:00.000Z"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 2,
      "totalItems": 15,
      "itemsPerPage": 10
    }
  }
}
```

### **POST /api/tasks**
Crea una nueva tarea (sin asignar agents - se orquesta automáticamente).

**Request:**
```json
{
  "title": "Design Product Catalog UI",
  "description": "Create responsive product listing and detail pages",
  "project": "676d1234567890abcdef5678",
  "complexity": "moderate",
  "type": "feature",
  "priority": "medium",
  "feature": "catalog",
  "estimatedHours": 8
}
```

**Response 201:**
```json
{
  "success": true,
  "message": "Task created successfully.",
  "data": {
    "task": {
      "_id": "676d1234567890abcdef8888",
      "title": "Design Product Catalog UI",
      "description": "Create responsive product listing and detail pages",
      "status": "backlog",
      "complexity": "moderate",
      "orchestration": null
    }
  }
}
```

### **POST /api/tasks/:id/start** ⭐ SISTEMA COMPLETAMENTE AUTOMÁTICO
Inicia la ejecución COMPLETAMENTE AUTOMÁTICA de TODOS los 6 agents en background. El usuario solo llama este endpoint UNA vez y todos los agents se ejecutan automáticamente sin intervención adicional.

**Headers:**
```
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

**Request (Form Data):**
```javascript
FormData:
- instructions: "Optional global instructions for all agents"
- image: Screenshot.png // SOLO 1 imagen por tarea (campo 'image')

// Tipos soportados (Claude Code Official): image/jpeg, image/png, image/gif, image/webp
// Límite: 1 imagen máximo, 10MB
// Procesamiento: Automático base64 encoding para Claude Code
// IMPORTANTE: Solo imágenes - NO documentos o archivos de texto
```

**Response 200:**
```json
{
  "success": true,
  "message": "Task orchestration started. All 6 agents are executing automatically in background.",
  "data": {
    "task": {
      "id": "676d1234567890abcdef8888",
      "status": "assigned",
      "orchestration": {
        "status": "in-progress",
        "totalSteps": 6,
        "currentStep": 1
      }
    },
    "pipeline": ["product-manager", "project-manager", "tech-lead", "senior-developer", "junior-developer", "qa-engineer"],
    "message": "Check /status endpoint to monitor progress",
    "estimatedTime": "5-10 minutes"
  }
}
```

### **POST /api/tasks/:id/cancel** ⭐ CANCELAR ORQUESTACIÓN
Cancela la orquestación automática que está en ejecución. Útil si el usuario quiere detener el proceso.

**Headers:**
```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

**Request:**
```json
{
  "reason": "User requested cancellation" // Opcional - motivo de cancelación
}
```

**Response 200:**
```json
{
  "success": true,
  "message": "Task orchestration cancelled successfully.",
  "data": {
    "taskId": "676d1234567890abcdef8888",
    "status": "cancelled",
    "orchestrationStatus": "cancelled",
    "cancelledAt": "2024-01-01T10:45:00.000Z",
    "reason": "User requested cancellation"
  }
}
```

**Response 400 (Ya completada):**
```json
{
  "success": false,
  "message": "Cannot cancel orchestration. Current status: completed",
  "data": {
    "currentStatus": "completed",
    "taskId": "676d1234567890abcdef8888"
  }
}
```

### **GET /api/tasks/:id/status** ⭐ NUEVO - POLLING ENDPOINT
Endpoint optimizado para polling y monitoreo de progreso en tiempo real.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "taskId": "676d1234567890abcdef8888",
    "status": "in-progress",
    "orchestrationStarted": true,
    "orchestrationStatus": "in-progress",
    "progress": {
      "completed": 3,
      "total": 6,
      "percentage": 50
    },
    "currentAgent": "senior-developer",
    "currentAgentStatus": "in-progress",
    "isComplete": false,
    "isFailed": false,
    "lastUpdate": "2024-01-01T10:45:00.000Z"
  }
}
```

### **GET /api/tasks/:id/orchestration** ⭐ DETALLADO
Obtiene información detallada del estado y progreso de la orquestación automática.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "taskId": "676d1234567890abcdef8888",
    "orchestrationInitialized": true,
    "status": "in-progress",
    "progress": {
      "currentStep": 3,
      "totalSteps": 6,
      "percentage": 33,
      "completedSteps": 2
    },
    "currentAgent": "tech-lead",
    "currentAgentStatus": "in-progress",
    "pipeline": [
      { "agent": "product-manager", "status": "completed", "completedAt": "2024-01-01T10:30:00.000Z" },
      { "agent": "project-manager", "status": "completed", "completedAt": "2024-01-01T10:45:00.000Z" },
      { "agent": "tech-lead", "status": "in-progress", "startedAt": "2024-01-01T10:45:00.000Z" },
      { "agent": "senior-developer", "status": "pending" },
      { "agent": "junior-developer", "status": "pending" },
      { "agent": "qa-engineer", "status": "pending" }
    ],
    "logs": [
      "[2024-01-01T10:30:00.000Z] System: Fully automatic orchestration started",
      "[2024-01-01T10:30:05.000Z] product-manager: Starting product-manager",
      "[2024-01-01T10:30:20.000Z] product-manager: product-manager completed successfully",
      "[2024-01-01T10:30:25.000Z] project-manager: Starting project-manager"
    ],
    "nextAction": "Orchestration running automatically in background"
  }
}
```

---

### **📊 Resumen de Cambios en Endpoints**

#### **✅ ENDPOINTS FINALES OPTIMIZADOS:**
- `POST /api/tasks/:id/start` - **Orquestación COMPLETAMENTE AUTOMÁTICA** de 6 agentes + soporte imagen
- `POST /api/tasks/:id/cancel` - **Cancelar orquestación en ejecución** por solicitud del usuario
- `GET /api/tasks/:id/status` - **Polling optimizado** para monitoreo de progreso
- `GET /api/tasks/:id/orchestration` - **Información detallada** de orquestación y logs
- `POST /api/conversations` - **Chat post-automatización** con soporte imagen
- `POST /api/conversations/:id/messages` - **Mensajes iterativos** con imagen opcional

#### **🎯 ENDPOINTS DE TRACKING DE TOKENS:**
- `GET /api/token-usage/analytics` - **Analytics completos** de uso por modelo y agente
- `GET /api/token-usage/realtime` - **Métricas en tiempo real** de consumo actual
- `GET /api/token-usage/limits` - **Estado de límites** diarios y mensuales
- `GET /api/token-usage/summary` - **Resumen de uso** con filtros por modelo/agente
- `GET /api/token-usage/trends` - **Tendencias históricas** de consumo
- `GET /api/token-usage/export` - **Exportación de datos** (JSON/CSV)
- `GET /api/token-usage/cost-breakdown` - **Desglose de costos** por semana
- `POST /api/token-usage/estimate` - **Estimación de tokens** para entrada específica

#### **🔄 MEJORAS IMPLEMENTADAS:**
- **Imagen Support**: 1 imagen por tarea, 1 por mensaje (Claude Code specs)
- **Background Processing**: Orquestación no-bloqueante con `setImmediate()`
- **Tool Inheritance**: Agentes heredan TODAS las herramientas disponibles
- **Model Inheritance**: Agentes usan `model: inherit` para adaptarse al contexto

#### **❌ ENDPOINTS ELIMINADOS:**
- `POST /api/tasks/:id/execute` - **YA NO EXISTE** (ejecución completamente automática)
- `POST /api/tasks/:id/assign` - **YA NO EXISTE** (no hay asignación manual)

#### **🎯 FLUJO FRONTEND FINAL (Claude Code Optimized):**
```javascript
// 1. Crear tarea con imagen opcional
const formData = new FormData();
formData.append('title', 'Implement user authentication');
formData.append('description', 'Add login/register functionality');
formData.append('projectId', projectId);
if (screenshot) formData.append('image', screenshot); // Opcional

const task = await fetch('/api/tasks', {
  method: 'POST',
  body: formData
}).then(r => r.json());

// 2. Iniciar orquestación COMPLETAMENTE AUTOMÁTICA
const startData = new FormData();
startData.append('instructions', 'Follow security best practices');
if (wireframe) startData.append('image', wireframe); // Opcional

await fetch(`/api/tasks/${task.data._id}/start`, {
  method: 'POST',
  body: startData
});

// 3. Monitorear progreso automático (opcional)
const pollProgress = setInterval(async () => {
  const status = await fetch(`/api/tasks/${task.data._id}/status`)
    .then(r => r.json());
    
  console.log(`Progress: ${status.data.progress.percentage}%`);
  console.log(`Current Agent: ${status.data.currentAgent}`);
  
  if (status.data.isComplete || status.data.isFailed || status.data.orchestrationStatus === 'cancelled') {
    clearInterval(pollProgress);
    console.log('Orchestration finished!');
  }
}, 3000); // Poll cada 3 segundos

// 4. Cancelar orquestación (opcional)
const cancelOrchestration = async (reason) => {
  const response = await fetch(`/api/tasks/${task.data._id}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  
  if (response.ok) {
    clearInterval(pollProgress);
    console.log('Orchestration cancelled successfully');
  }
};

// ¡ESO ES TODO! Los 6 agents ejecutan automáticamente en background
// El usuario puede cancelar en cualquier momento si es necesario
```

#### **🔥 BENEFICIOS DEL SISTEMA FINAL:**
- **Zero Manual Intervention**: Usuario solo llama `/start` una vez
- **User Control**: Capacidad de cancelar orquestación en cualquier momento
- **Image Context**: Screenshots/wireframes para mejor contexto visual  
- **Background Execution**: Todos los agentes ejecutan automáticamente
- **Claude Code Compliance**: 100% alineado con mejores prácticas oficiales
- **Tool Flexibility**: Agentes tienen acceso a TODAS las herramientas
- **Real-time Monitoring**: Polling ligero y eficiente
- **Graceful Cancellation**: Sistema respeta cancelaciones del usuario inmediatamente

---

## 🏗️ **Claude Code Best Practices Implementadas**

### **📁 Estructura Oficial del Proyecto**
```
├── CLAUDE.md                    # Documentación oficial con bash commands y etiquette
├── .claude/
│   ├── agents/                  # Subagentes configurados oficialmente
│   │   ├── product-manager.md
│   │   ├── project-manager.md
│   │   ├── tech-lead.md
│   │   ├── senior-developer.md
│   │   ├── junior-developer.md
│   │   └── qa-engineer.md
│   ├── output-styles/           # Estilos personalizados disponibles
│   ├── hooks/                   # Hooks para automatización
│   └── settings.json           # Configuración del proyecto
└── backend/                     # Backend con orquestación automática
```

### **🤖 Configuración de Subagentes (Optimizada)**
```yaml
# Agentes de Planificación (Opus - Razonamiento complejo)
---
name: product-manager
description: Product Manager - Use PROACTIVELY for requirements analysis
model: opus
---

# Agentes de Implementación (Sonnet - Ejecución eficiente)
---
name: senior-developer
description: Expert Senior Developer - Use PROACTIVELY after code changes
model: sonnet
---

# No se especifica 'tools' para heredar TODAS las herramientas disponibles
```

### **🔧 Settings.json Optimizado**
```json
{
  "allowedTools": ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Git"],
  "agents": {
    // PLANIFICACIÓN (Opus - Razonamiento complejo)
    "product-manager": {
      "description": "Analyzes requirements and defines product specifications",
      "model": "opus"  // Sin 'tools' - hereda todas
    },
    "project-manager": {
      "description": "Breaks down epics into implementable stories", 
      "model": "opus"
    },
    "tech-lead": {
      "description": "Designs technical architecture and mentors development team",
      "model": "opus"
    },
    
    // IMPLEMENTACIÓN (Sonnet - Ejecución eficiente)
    "senior-developer": {
      "description": "Implements complex features and reviews all junior code",
      "model": "sonnet"
    },
    "junior-developer": {
      "description": "Implements UI components and simple features under supervision",
      "model": "sonnet"
    },
    "qa-engineer": {
      "description": "Final quality gate with comprehensive testing and validation",
      "model": "sonnet"
    }
  }
}
```

### **📋 CLAUDE.md Completo (Según Especificaciones)**
- **✅ Bash Commands**: Comandos específicos para desarrollo y testing
- **✅ Core Files**: Arquitectura backend documentada
- **✅ Code Style Guidelines**: Estándares JavaScript con ejemplos
- **✅ Testing Instructions**: Comandos y requisitos de cobertura
- **✅ Repository Etiquette**: Flujo de trabajo y principios clave

### **🎯 Beneficios de Seguir Mejores Prácticas Oficiales**
1. **Maximum Tool Access**: Agentes heredan todas las herramientas sin restricciones
2. **Proactive Delegation**: Descriptions optimizadas para delegación automática
3. **Context Preservation**: Model inheritance adapta agentes al contexto principal
4. **Official Compliance**: 100% alineado con documentación oficial de Anthropic
5. **Scalable Architecture**: Estructura preparada para crecimiento y mantenimiento

---
```json
{
  "success": true,
  "data": {
    "executionId": "exec_1704110400_xyz789abc"
  }
}
```

### **GET /api/tasks/:id/repositories/:repoId/status**
Obtiene el estado de un repositorio en una tarea.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "repositoryId": "repo_internal_id_12345",
    "status": "active",
    "lastSync": "2024-01-01T12:30:00.000Z",
    "branch": "feature/auth",
    "commits": 12,
    "hasChanges": true,
    "lastCommit": {
      "sha": "abc123def456",
      "message": "Add JWT middleware",
      "author": "John Doe",
      "date": "2024-01-01T12:00:00.000Z"
    }
  }
}
```

---

## 🤖 **5. Agentes Claude Code**

### **POST /api/agents/execute**
Ejecuta un agente Claude Code.

**Request:**
```json
{
  "agentType": "senior-developer",
  "instructions": "Implement a REST API for user management with CRUD operations",
  "taskId": "676d1234567890abcdef7777",
  "projectId": "676d1234567890abcdef5678",
  "workspacePath": "/Users/johndoe/projects/api"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "executionId": "exec_1704110400_xyz789abc",
    "agentType": "senior-developer",
    "status": "queued"
  }
}
```

### **GET /api/agents/executions/:executionId**
Obtiene el estado de una ejecución.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "executionId": "exec_1704110400_xyz789abc",
    "status": "running",
    "progress": 65,
    "result": null,
    "error": null,
    "createdAt": "2024-01-01T12:00:00.000Z",
    "startedAt": "2024-01-01T12:00:30.000Z",
    "completedAt": null
  }
}
```

**Response cuando completado:**
```json
{
  "success": true,
  "data": {
    "executionId": "exec_1704110400_xyz789abc",
    "status": "completed",
    "progress": 100,
    "result": {
      "output": "Complex feature implemented with tests",
      "success": true,
      "files": ["UserController.js", "UserService.js", "user.test.js", "README.md"],
      "metrics": {
        "executionTime": 245000,
        "linesOfCode": 450,
        "testsWritten": 12
      }
    },
    "error": null,
    "createdAt": "2024-01-01T12:00:00.000Z",
    "startedAt": "2024-01-01T12:00:30.000Z",
    "completedAt": "2024-01-01T12:04:35.000Z"
  }
}
```

### **GET /api/agents/executions/:executionId/logs**
Obtiene los logs de una ejecución.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "logs": [
      "Execution exec_1704110400_xyz789abc created",
      "Agent type: senior-developer",
      "Instructions: Implement a REST API for user management...",
      "Execution queued for processing",
      "Starting agent execution...",
      "Analyzing instructions...",
      "Initializing workspace...",
      "Working directory: /Users/johndoe/projects/api",
      "Analyzing task requirements...",
      "Agent senior-developer processing instructions",
      "Processing with Claude Code...",
      "Analyzing code structure...",
      "Implementing complex logic...",
      "Writing comprehensive tests...",
      "Implementing solution...",
      "Generating code and documentation...",
      "Execution completed successfully",
      "Generated 4 files",
      "Task completed in 245s"
    ]
  }
}
```

### **🆕 GET /api/agents/executions/:executionId/logs/stream**
Stream en tiempo real de logs via Server-Sent Events.

**Headers:**
```
Authorization: Bearer <accessToken>
Accept: text/event-stream
```

**Response (Event Stream):**
```
Content-Type: text/event-stream

data: {"type":"log","content":"Starting agent execution...","index":0}

data: {"type":"status","status":"running","progress":25}

data: {"type":"log","content":"Analyzing code structure...","index":1}

data: {"type":"status","status":"running","progress":50}

data: {"type":"complete","status":"completed","result":{"output":"Task completed","files":["file1.js"]}}
```

**Tipos de eventos:**
- `log`: Nuevo mensaje de log
- `status`: Actualización de estado/progreso  
- `complete`: Ejecución terminada
- `error`: Error en la ejecución

**Uso en Frontend:**
```javascript
const eventSource = new EventSource(
  `/api/agents/executions/${executionId}/logs/stream`,
  { headers: { Authorization: `Bearer ${token}` } }
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // data.type: 'log', 'status', 'complete', 'error'
};
```

### **DELETE /api/agents/executions/:executionId**
Cancela una ejecución en curso.

**Response 200:**
```json
{
  "success": true,
  "message": "Execution cancelled successfully"
}
```

### **GET /api/agents/types**
Lista los tipos de agentes disponibles.

**Response 200:**
```json
{
  "success": true,
  "data": [
    {
      "type": "product-manager",
      "name": "Product Manager",
      "description": "Analyzes requirements and communicates with stakeholders",
      "capabilities": ["requirement-analysis", "stakeholder-communication", "feature-prioritization"]
    },
    {
      "type": "project-manager", 
      "name": "Project Manager",
      "description": "Breaks down tasks and manages project timelines",
      "capabilities": ["task-breakdown", "timeline-management", "resource-planning"]
    },
    {
      "type": "tech-lead",
      "name": "Tech Lead", 
      "description": "Designs architecture and provides technical guidance",
      "capabilities": ["architecture-design", "technical-guidance", "code-review"]
    },
    {
      "type": "senior-developer",
      "name": "Senior Developer",
      "description": "Implements complex features and mentors junior developers", 
      "capabilities": ["complex-implementation", "code-review", "mentoring"]
    },
    {
      "type": "junior-developer",
      "name": "Junior Developer",
      "description": "Implements UI components and simple features",
      "capabilities": ["ui-components", "simple-features", "basic-testing"]
    },
    {
      "type": "qa-engineer",
      "name": "QA Engineer", 
      "description": "Performs testing and quality validation",
      "capabilities": ["testing", "quality-assurance", "bug-detection"]
    }
  ]
}
```

### **POST /api/agents/recommendations**
Obtiene recomendaciones de agentes para una tarea.

**Request:**
```json
{
  "taskDescription": "Create a user dashboard with real-time analytics and charts",
  "projectType": "web-app"
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "recommendations": [
      {
        "agentType": "senior-developer",
        "confidence": 0.85,
        "reasoning": "Complex feature requiring dashboard implementation and real-time data integration",
        "estimatedTime": "4-6 hours"
      },
      {
        "agentType": "junior-developer", 
        "confidence": 0.65,
        "reasoning": "Could handle UI components but may need guidance on real-time features",
        "estimatedTime": "8-12 hours"
      }
    ],
    "taskDescription": "Create a user dashboard with real-time analytics and charts",
    "projectType": "web-app"
  }
}
```

---

## 💬 **6. Conversaciones Post-Automatización**

### **🎯 Objetivo del Sistema de Chat:**
El sistema de conversaciones **NO es independiente**. Es una **extensión del sistema automático** para casos específicos:

#### **📋 Casos de Uso ÚNICOS:**
1. **Refinamientos Post-Automatización:** Después de que los 6 agents terminen automáticamente
2. **Modificaciones Menores:** Cambios específicos sin re-ejecutar toda la orquestación  
3. **Clarificaciones:** Explicaciones sobre decisiones técnicas tomadas por los agents
4. **Trabajo Continuo:** Nuevas funcionalidades sobre la tarea base ya completada

#### **⚠️ IMPORTANTE - Flujo Obligatorio:**
```
Task → POST /start (6 agents automáticos) → Resultado → Chat para refinamientos
```

**El chat NUNCA reemplaza la orquestación automática inicial. Es solo para trabajo POST-automatización.**

#### **📎 Soporte de Imágenes (Especificaciones Oficiales Claude Code):**
Tanto el sistema automático como el chat soportan imágenes según las especificaciones oficiales de Claude Code:

- **En Tareas (POST /start):** 1 imagen (screenshot, wireframe, mockup, UI design)
- **En Chat:** 1 imagen por mensaje (screenshots de errores, capturas, diseños)
- **Tipos Soportados (OFICIAL):** image/jpeg, image/png, image/gif, image/webp
- **Límites:** 10MB por imagen, **máximo 1 imagen por tarea** y **1 imagen por mensaje**
- **Formato API:** Base64 encoding automático para integración con Claude Code
- **Métodos Soportados:** Drag & drop, copy & paste (ctrl+v), file upload via API

---

### **🔗 Relación entre Sistemas**

#### **Sistema Automático (Primario):**
```javascript
// 1. Usuario crea tarea
POST /api/tasks → { title, description, project }

// 2. Usuario inicia automatización COMPLETA
POST /api/tasks/:id/start → Ejecuta TODOS los 6 agents automáticamente

// 3. Monitoreo (opcional)
GET /api/tasks/:id/status → Progreso en tiempo real

// RESULTADO: Tarea completamente implementada por los 6 agents
```

#### **Sistema de Chat (Secundario - Post-Automatización):**
```javascript
// 4. DESPUÉS de automatización completa, crear conversación para refinamientos
POST /api/conversations → { taskId: "completed_task_id", agentType, message }

// 5. Intercambio iterativo para ajustes menores
POST /api/conversations/:id/messages → Refinamientos específicos

// RESULTADO: Mejoras incrementales sobre el trabajo automático completado
```

#### **📊 Flujo Visual:**
```
┌─────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   TASK      │ ──▶│   AUTOMATIZACIÓN │ ──▶│  CHAT (OPCIONAL)│
│   Creada    │    │   6 Agents       │    │  Refinamientos  │
└─────────────┘    └──────────────────┘    └─────────────────┘
     Manual              Automático            Conversacional
```

---

### **GET /api/conversations**
Lista conversaciones del usuario.

**Query Parameters:**
- `taskId`: Filtrar por tarea
- `agentType`: Filtrar por tipo de agente
- `page`, `limit`: Paginación

**Response 200:**
```json
{
  "success": true,
  "data": {
    "conversations": [
      {
        "_id": "676d1234567890abcdef3333",
        "title": "Chat con Senior Developer - Auth Implementation",
        "agentType": "senior-developer",
        "taskId": "676d1234567890abcdef7777",
        "participants": ["676d1234567890abcdef1234"],
        "status": "active",
        "lastMessage": "Authentication system has been successfully implemented with JWT tokens.",
        "metrics": {
          "messageCount": 15,
          "averageResponseTime": 2500
        },
        "createdAt": "2024-01-01T10:00:00.000Z",
        "updatedAt": "2024-01-01T12:30:00.000Z"
      }
    ],
    "total": 5,
    "page": 1,
    "limit": 10,
    "totalPages": 1
  }
}
```

### **POST /api/conversations**
Crea una nueva conversación **VINCULADA A UNA TAREA COMPLETADA**.

**⚠️ Prerequisito:** La tarea debe haber completado su orquestación automática (status: 'done')

**Request:**
```json
{
  "taskId": "676d1234567890abcdef7777",  // ← OBLIGATORIO - Task que completó automatización
  "title": "Refinements after automatic orchestration",
  "agentType": "tech-lead",
  "initialMessage": "The authentication system looks good, but can you explain why you chose JWT over sessions?"
}
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "_id": "676d1234567890abcdef4444",
    "title": "Planning Product Catalog Architecture",
    "agentType": "tech-lead",
    "taskId": "676d1234567890abcdef7777",
    "participants": ["676d1234567890abcdef1234"],
    "status": "active",
    "messages": [
      {
        "role": "user",
        "content": "I need help designing the architecture for our product catalog system.",
        "timestamp": "2024-01-01T13:00:00.000Z"
      }
    ],
    "createdAt": "2024-01-01T13:00:00.000Z",
    "updatedAt": "2024-01-01T13:00:00.000Z"
  }
}
```

### **GET /api/conversations/:id**
Obtiene una conversación específica.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "_id": "676d1234567890abcdef3333",
    "title": "Chat con Senior Developer - Auth Implementation",
    "agentType": "senior-developer",
    "taskId": "676d1234567890abcdef7777",
    "participants": ["676d1234567890abcdef1234"],
    "messages": [
      {
        "_id": "msg_001",
        "role": "user",
        "content": "Can you implement JWT authentication for our API?",
        "timestamp": "2024-01-01T10:00:00.000Z"
      },
      {
        "_id": "msg_002", 
        "role": "agent",
        "content": "I'll implement a complete JWT authentication system for you. Let me start by creating the middleware and auth routes.",
        "timestamp": "2024-01-01T10:01:00.000Z",
        "metadata": {
          "executionId": "exec_1704110400_xyz789abc",
          "fileReferences": ["auth.middleware.js", "auth.routes.js"]
        }
      }
    ],
    "claudeExecutionContext": {
      "executionId": "exec_1704110400_xyz789abc",
      "status": "completed",
      "progress": 100,
      "workspace": "/Users/johndoe/projects/api"
    },
    "status": "completed",
    "metrics": {
      "messageCount": 15,
      "averageResponseTime": 2500,
      "userSatisfaction": 4.5
    },
    "createdAt": "2024-01-01T10:00:00.000Z",
    "updatedAt": "2024-01-01T12:30:00.000Z"
  }
}
```

### **GET /api/conversations/:id/messages**
Obtiene mensajes de una conversación.

**Query Parameters:**
- `page`, `limit`: Paginación (default: page=1, limit=50)

**Response 200:**
```json
{
  "success": true,
  "data": {
    "messages": [
      {
        "_id": "msg_001",
        "role": "user",
        "content": "Can you implement JWT authentication for our API?",
        "timestamp": "2024-01-01T10:00:00.000Z"
      },
      {
        "_id": "msg_002",
        "role": "agent", 
        "content": "I'll implement a complete JWT authentication system for you.",
        "timestamp": "2024-01-01T10:01:00.000Z",
        "metadata": {
          "executionId": "exec_1704110400_xyz789abc",
          "fileReferences": ["auth.middleware.js"],
          "codeBlocks": ["const jwt = require('jsonwebtoken');"]
        }
      }
    ],
    "total": 15,
    "page": 1,
    "limit": 50,
    "totalPages": 1
  }
}
```

### **POST /api/conversations/:id/messages**
Añade un mensaje a la conversación con archivos adjuntos opcionales.

**Headers:**
```
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

**Request (Form Data):**
```javascript
FormData:
- content: "Can you also add password hashing with bcrypt?"
- role: "user"
- attachment: Screenshot.png // SOLO 1 imagen por mensaje (campo 'attachment')

// Tipos soportados (Claude Code Official): image/jpeg, image/png, image/gif, image/webp  
// Límite: 1 imagen máximo por mensaje, 10MB
// Procesamiento: Automático base64 encoding para Claude Code
// IMPORTANTE: Solo imágenes - NO documentos o archivos de texto
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "_id": "msg_003",
    "role": "user",
    "content": "Can you also add password hashing with bcrypt?",
    "timestamp": "2024-01-01T12:35:00.000Z"
  }
}
```

### **POST /api/conversations/search**
Búsqueda semántica en conversaciones.

**Request:**
```json
{
  "query": "authentication JWT implementation",
  "filters": {
    "agentType": "senior-developer",
    "dateRange": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.000Z"
    }
  },
  "limit": 10
}
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "_id": "676d1234567890abcdef3333",
        "title": "Chat con Senior Developer - Auth Implementation",
        "agentType": "senior-developer",
        "relevanceScore": 0.95,
        "highlightedContent": "JWT **authentication** system implementation...",
        "lastMessage": "Authentication system completed successfully",
        "updatedAt": "2024-01-01T12:30:00.000Z"
      }
    ],
    "total": 3,
    "query": "authentication JWT implementation"
  }
}
```

### **GET /api/conversations/:id/similar**
Encuentra conversaciones similares.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "similar": [
      {
        "_id": "676d1234567890abcdef5555",
        "title": "OAuth Integration Discussion",
        "agentType": "tech-lead",
        "similarityScore": 0.78,
        "updatedAt": "2024-01-01T08:00:00.000Z"
      }
    ]
  }
}
```

---

## 📤 **7. Uploads**

### **POST /api/uploads/single**
Sube un archivo único.

**Headers:**
```
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

**Request:**
```
FormData con campo 'file'
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "id": "wireframe-1704110400-xyz789.png",
    "originalName": "login-wireframe.png",
    "filename": "wireframe-1704110400-xyz789.png",
    "mimetype": "image/png",
    "size": 2048576,
    "url": "/api/uploads/files/wireframe-1704110400-xyz789.png",
    "uploadedBy": "676d1234567890abcdef1234",
    "uploadedAt": "2024-01-01T13:00:00.000Z"
  }
}
```

### **POST /api/uploads/multiple**
Sube múltiples archivos.

**Request:**
```
FormData con campo 'files' (array)
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "design-1704110400-abc123.pdf",
        "originalName": "system-design.pdf",
        "filename": "design-1704110400-abc123.pdf",
        "mimetype": "application/pdf",
        "size": 5242880,
        "url": "/api/uploads/files/design-1704110400-abc123.pdf",
        "uploadedBy": "676d1234567890abcdef1234",
        "uploadedAt": "2024-01-01T13:05:00.000Z"
      }
    ],
    "count": 1
  }
}
```

### **GET /api/uploads/files/:filename**
Sirve un archivo subido.

**Response 200:**
```
Content-Type: image/png (o el tipo correspondiente)
Content-Length: 2048576
Cache-Control: public, max-age=31536000

[Datos binarios del archivo]
```

### **DELETE /api/uploads/files/:filename**
Elimina un archivo.

**Response 200:**
```json
{
  "success": true,
  "message": "File deleted successfully"
}
```

### **GET /api/uploads/info**
Obtiene información sobre límites de upload.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "maxFileSize": 10485760,
    "maxFiles": 5,
    "allowedTypes": [
      "image/jpeg",
      "image/png",
      "image/gif", 
      "image/webp",
      "image/svg+xml",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "application/json",
      "application/zip"
    ],
    "allowedExtensions": [
      ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
      ".pdf", ".txt", ".md", ".json", ".zip"
    ]
  }
}
```

---

## ⚙️ **8. Sistema**

### **GET /health**
Health check del sistema.

**Response 200:**
```json
{
  "success": true,
  "service": "Multi-Agent Software Development Platform",
  "version": "1.0.0",
  "environment": "development",
  "timestamp": "2024-01-01T13:00:00.000Z",
  "platform": {
    "securityEnabled": true,
    "agentsActive": true,
    "performanceOptimized": true
  }
}
```

### **GET /api**
Documentación básica de la API.

**Response 200:**
```json
{
  "success": true,
  "message": "Multi-Agent Software Development Platform",
  "version": "1.0.0",
  "documentation": {
    "authentication": "/api/auth",
    "projects": "/api/projects",
    "tasks": "/api/tasks",
    "agents": "See CLAUDE.md for agent configuration"
  },
  "endpoints": {
    "POST /api/auth/register": "Register new development team member",
    "POST /api/auth/login": "Authenticate user",
    "GET /api/projects": "List software projects",
    "POST /api/projects": "Create new software project",
    "GET /api/tasks": "List development tasks",
    "POST /api/tasks/:id/start": "Start FULLY AUTOMATIC orchestration of all 6 agents",
    "GET /api/tasks/:id/status": "Monitor automatic orchestration progress"
  }
}
```

### **GET /api/platform-metrics**
Métricas de la plataforma.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "database": {
      "status": "connected",
      "collections": 5,
      "totalDocuments": 1250
    },
    "health": {
      "uptime": 86400,
      "memory": "45.2MB",
      "cpu": "2.1%"
    },
    "platform": {
      "projectTypes": ["web-app", "mobile-app", "api", "microservice", "library"],
      "securityStandards": ["GDPR", "OWASP", "Enterprise Security"],
      "agentTypes": ["product-manager", "project-manager", "tech-lead", "senior-developer", "junior-developer", "qa-engineer"]
    }
  }
}
```

---

## 🚨 **Manejo de Errores**

Todos los endpoints siguen el mismo formato de error:

```json
{
  "success": false,
  "message": "Descripción del error",
  "code": "ERROR_CODE_UPPERCASE",
  "details": "Información adicional (opcional)",
  "field": "campo_que_causó_error (opcional)"
}
```

### **Códigos de Error Comunes:**

| Código | HTTP | Descripción |
|--------|------|-------------|
| `VALIDATION_ERROR` | 400 | Error de validación de datos |
| `UNAUTHORIZED` | 401 | Token faltante o inválido |
| `ACCESS_DENIED` | 403 | Sin permisos para el recurso |
| `NOT_FOUND` | 404 | Recurso no encontrado |
| `EMAIL_EXISTS` | 400 | Email ya registrado |
| `INVALID_CREDENTIALS` | 401 | Credenciales incorrectas |
| `EXECUTION_NOT_FOUND` | 404 | Ejecución no encontrada |
| `FILE_TOO_LARGE` | 400 | Archivo excede límite de tamaño |
| `INVALID_FILE_TYPE` | 400 | Tipo de archivo no permitido |

---

## 🔐 **Autenticación y Autorización**

### **Headers Requeridos:**
```
Authorization: Bearer <accessToken>
Content-Type: application/json
```

### **Rate Limiting:**
- 100 requests por IP cada 15 minutos
- Se aplica a todos los endpoints `/api/*`
- Exentos: `/health`, `/api/health`

### **CORS Configurado:**
- Orígenes permitidos: `localhost:3000`, `localhost:3001`, `localhost:3002`, `localhost:4000`, `localhost:5000`
- Métodos: `GET`, `POST`, `PUT`, `DELETE`, `OPTIONS`
- Headers: `Content-Type`, `Authorization`, `X-Agent-Context`

---

## 📊 **Paginación Estándar**

Todos los endpoints que devuelven listas usan:

**Query Parameters:**
- `page`: Número de página (default: 1)  
- `limit`: Elementos por página (default: 10)

**Response Format:**
```json
{
  "success": true,
  "data": {
    "items": [], // o "projects", "tasks", etc.
    "total": 25,
    "page": 1, 
    "limit": 10,
    "totalPages": 3
  }
}
```

---

## ⚡ **Funcionalidades en Tiempo Real (Fase 2)**

### **🔌 WebSocket Events**
```typescript
// Cliente → Servidor
interface ClientEvents {
  'join_conversation': { conversationId: string };
  'send_message': { conversationId: string, content: string };
  'start_typing': { conversationId: string };
  'stop_typing': { conversationId: string };
  'agent_execution_start': { executionId: string };
}

// Servidor → Cliente
interface ServerEvents {
  'new_message': { conversationId: string, message: object };
  'user_typing': { conversationId: string, userId: string };
  'agent_execution_progress': { executionId: string, progress: number };
  'agent_execution_completed': { executionId: string, result: object };
  'user_status_change': { userId: string, status: 'online' | 'offline' };
}
```

### **🔔 Sistema de Notificaciones**
```typescript
interface Notification {
  id: string;
  type: 'agent_execution_start' | 'agent_execution_success' | 'agent_execution_failure' | 'new_message' | 'code_review_request';
  title: string;
  message: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  read: boolean;
  createdAt: Date;
  data?: object;
}
```

---

## 📈 **Métricas y Analytics (Fase 3)**

### **📊 Dashboard Metrics**
```typescript
interface PlatformMetrics {
  overview: {
    totalProjects: number;
    activeTasks: number;
    completedTasks: number;
    totalExecutions: number;
  };
  agentPerformance: {
    [agentType: string]: {
      successRate: number;
      averageExecutionTime: number;
      totalExecutions: number;
    };
  };
  projectHealth: {
    projectId: string;
    tasksCompleted: number;
    averageTaskTime: number;
    riskLevel: 'low' | 'medium' | 'high';
  }[];
  recommendations: {
    type: string;
    priority: number;
    message: string;
    action?: string;
  }[];
}
```

---

## 🔧 **Configuración**

### **Variables de Entorno:**
```bash
# Core
NODE_ENV=development
PORT=3000

# Database
MONGODB_URI=mongodb://localhost:27017/agents-software-arq
JWT_SECRET=your-secret-key
SESSION_SECRET=your-session-secret

# GitHub OAuth
GITHUB_CLIENT_ID=Ghp_xxxxxxxxxxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional
FRONTEND_URL=http://localhost:3001
REDIS_URL=redis://localhost:6379
ANTHROPIC_API_KEY=your_claude_api_key
```

### **Dependencias Instaladas:**
```bash
npm install express mongoose jsonwebtoken bcryptjs cors helmet
npm install multer socket.io redis bull ioredis
npm install express-rate-limit express-mongo-sanitize compression
```

---

## 🚀 **Flujo de Trabajo Completo**

### **1. Autenticación**
```javascript
// Login → Almacenar token → Configurar headers HTTP
localStorage.setItem('token', response.accessToken);
axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
```

### **2. Crear Proyecto y Tarea**
```javascript
// Crear proyecto
const project = await api.post('/projects', projectData);

// Crear tarea en el proyecto
const task = await api.post('/tasks', {
  ...taskData,
  projectId: project.data._id
});
```

### **3. Ejecutar Orquestación Automática**
```javascript
// Iniciar ejecución COMPLETAMENTE AUTOMÁTICA de todos los 6 agents
const orchestration = await api.post(`/tasks/${task.data._id}/start`, {
  instructions: 'Implement user authentication system' // Opcional
});

// Monitorear progreso con polling simple
const pollProgress = setInterval(async () => {
  const status = await api.get(`/tasks/${task.data._id}/status`);
  
  console.log(`Progress: ${status.data.progress.percentage}%`);
  console.log(`Current Agent: ${status.data.currentAgent}`);
  
  if (status.data.isComplete) {
    clearInterval(pollProgress);
    console.log('All 6 agents completed successfully!');
  } else if (status.data.isFailed) {
    clearInterval(pollProgress);
    console.log('Orchestration failed');
  }
}, 5000);

// ¡ESO ES TODO! Los agents se ejecutan automáticamente en background
```

### **4. Conversaciones Post-Automatización (Opcional)**
```javascript
// SOLO después de que la automatización esté completa (status: 'done')
// Crear conversación para refinamientos sobre la tarea completada
const conversation = await api.post('/conversations', {
  taskId: task.data._id, // Task que YA completó su automatización
  title: 'Refinements after automatic implementation',
  agentType: 'senior-developer',
  initialMessage: 'The auth system looks good, but can you add OAuth integration?'
});

// Intercambio iterativo para ajustes menores
await api.post(`/conversations/${conversation.data._id}/messages`, {
  content: 'Also add password complexity validation',
  role: 'user'
});

// El agent responde y ejecuta solo los cambios específicos solicitados
```

### **5. Subir Archivos (Wireframes, Documentos)**
```javascript
const formData = new FormData();
formData.append('file', file);

const upload = await api.post('/uploads/single', formData, {
  headers: { 'Content-Type': 'multipart/form-data' }
});

// URL del archivo: upload.data.url
```

---

## ✅ **Resumen de Fases Implementadas**

### **📋 Fase 1: Persistencia de Conversaciones**
- ✅ Modelo AgentConversation completo
- ✅ CRUD de conversaciones y mensajes
- ✅ Búsqueda semántica avanzada
- ✅ Integración con ejecuciones Claude Code

### **⚡ Fase 2: Comunicación en Tiempo Real**
- ✅ WebSockets con Socket.IO
- ✅ Sistema de notificaciones push
- ✅ Cache Redis inteligente
- ✅ SSE para logs en tiempo real

### **📊 Fase 3: Analytics con IA**
- ✅ Servicios de ML para recomendaciones
- ✅ Analytics predictivos
- ✅ Métricas de rendimiento
- ✅ NLP para análisis de tareas

---

## 🎯 **Para el Frontend Team**

El backend está **100% completo** con todos los endpoints documentados. Pueden implementar:

1. **Slash-commands** usando los contratos exactos
2. **ToolsPanel** con datos reales de la API
3. **SSE para logs** en tiempo real
4. **WebSockets** para notificaciones
5. **Upload de archivos** con validación

**Todos los endpoints están funcionando y probados.**

---

**📄 Versión**: 3.0.0 - Documentación Completa  
**📅 Actualizado**: Enero 2025  
**🤖 Motor**: Claude Code con sub-agentes especializados