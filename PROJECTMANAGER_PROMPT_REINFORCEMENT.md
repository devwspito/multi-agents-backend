# 🎯 ProjectManager Prompt Reinforcement - Repository Assignment

**Fecha**: 2025-01-11
**Objetivo**: Clarificar EXPLÍCITAMENTE cómo asignar repositorios a epics

## ❌ Problema Potencial

Aunque el código de ProjectManagerPhase **SÍ funciona correctamente** (lee `affectedRepositories` y asigna `targetRepository`), el **prompt del agente** no era suficientemente explícito sobre:

1. **Cómo decidir** qué epic va a qué repositorio
2. **Qué tipo de trabajo** corresponde a backend vs frontend
3. **Ejemplos concretos** de asignación correcta

**Riesgo**: El agente ProjectManager podría:
- Asignar APIs al frontend ❌
- Asignar componentes React al backend ❌
- Poner todos los epics en el mismo repo ❌

## ✅ Solución Aplicada

### 1. Sección Nueva: "CRITICAL: Multi-Repo Epic Assignment Rules"

**Ubicación**: `ProjectManagerPhase.ts` líneas 114-162

Agregado bloque de **50 líneas** con instrucciones CRISTALINAS:

```typescript
## 🔥 CRITICAL: Multi-Repo Epic Assignment Rules

**YOU MUST ASSIGN THE CORRECT REPOSITORY TO EACH EPIC BASED ON THE WORK TYPE**:

### 🔧 BACKEND EPICS → BACKEND REPOSITORIES
**Assign to BACKEND if the epic involves**:
- ✅ REST APIs, GraphQL endpoints, WebSocket servers
- ✅ Database models, schemas, migrations, queries
- ✅ Business logic, services, controllers
- ✅ Authentication, authorization, middleware
- ✅ Server-side validation, data processing
- ✅ Background jobs, cron tasks, workers
- ✅ Third-party API integrations (server-side)

### 🎨 FRONTEND EPICS → FRONTEND REPOSITORIES
**Assign to FRONTEND if the epic involves**:
- ✅ UI components, views, pages, layouts
- ✅ Client-side state management (Redux, Context)
- ✅ Forms, user input, client-side validation
- ✅ Styling, CSS, animations, responsive design
- ✅ Routing, navigation, browser APIs
- ✅ Client-side data fetching, caching
- ✅ User interactions, event handlers

### 📱 MOBILE EPICS → MOBILE REPOSITORIES
**Assign to MOBILE if the epic involves**:
- ✅ Native mobile UI, screens, navigation
- ✅ Device-specific features (camera, GPS, push notifications)
- ✅ Mobile-specific performance optimizations
- ✅ App store deployments, versioning

### 📦 SHARED/LIBRARY EPICS → SHARED REPOSITORIES
**Assign to SHARED if the epic involves**:
- ✅ Shared types, interfaces, utilities
- ✅ Common validation rules, constants
- ✅ Cross-platform helper functions

### ⚠️ MULTI-REPO EPICS (Rare - use with caution)
**ONLY assign multiple repositories if the epic requires SIMULTANEOUS changes in BOTH repos**:
- Example: New API endpoint (backend) + UI consuming it (frontend)
- In this case: `"affectedRepositories": ["backend-name", "frontend-name"]`
- The system will AUTOMATICALLY split this into 2 sub-epics

### 🚫 COMMON MISTAKES TO AVOID:
- ❌ Assigning API routes to frontend → WRONG (APIs = backend)
- ❌ Assigning React components to backend → WRONG (UI = frontend)
- ❌ Assigning ALL epics to the same repo → WRONG (analyze each epic)
- ❌ Using repository names that don't exist → WRONG (use EXACT names from list above)
```

### 2. Ejemplo JSON Mejorado

**Ubicación**: `ProjectManagerPhase.ts` líneas 236-261

**ANTES** (genérico):
```json
{
  "epics": [
    {
      "id": "epic-1",
      "title": "Feature name",
      "affectedRepositories": ["repo-name"],
      "filesToModify": ["src/real/file.js"]
    }
  ]
}
```

**AHORA** (concreto con 2 ejemplos reales):
```json
{
  "epics": [
    {
      "id": "epic-backend-api",
      "title": "Create User API Endpoints",
      "description": "REST API for user CRUD operations",
      "affectedRepositories": ["v2_backend"],
      "filesToModify": ["src/routes/users.ts", "src/controllers/UserController.ts"],
      "filesToCreate": ["src/models/User.ts", "src/services/UserService.ts"],
      "filesToRead": ["src/config/database.ts"],
      "estimatedComplexity": "moderate",
      "dependencies": [],
      "executionOrder": 1
    },
    {
      "id": "epic-frontend-user-ui",
      "title": "User Management UI",
      "description": "React components for user management",
      "affectedRepositories": ["v2_frontend"],
      "filesToModify": ["src/App.tsx", "src/routes/index.tsx"],
      "filesToCreate": ["src/components/UserList.tsx", "src/components/UserForm.tsx"],
      "filesToRead": ["src/api/client.ts"],
      "estimatedComplexity": "simple",
      "dependencies": ["epic-backend-api"],
      "executionOrder": 2
    }
  ]
}
```

**Beneficios**:
- ✅ Muestra backend vs frontend claramente
- ✅ Usa nombres REALES de repositorios
- ✅ Muestra dependency entre backend y frontend
- ✅ Usa paths TypeScript realistas

## 📊 Comparación Antes/Después

### Antes (3 líneas genéricas)
```
## Multi-Repo Orchestration Rules:
- Backend repositories (🔧) should handle: APIs, models, database, business logic
- Frontend repositories (🎨) should handle: UI components, views, client-side logic
- Each epic MUST specify which repository it affects in "affectedRepositories"
```

### Después (50 líneas específicas)
- ✅ **7 puntos** sobre qué va al backend
- ✅ **7 puntos** sobre qué va al frontend
- ✅ **4 puntos** sobre mobile
- ✅ **3 puntos** sobre shared
- ✅ **Sección de multi-repo** con ejemplo
- ✅ **4 errores comunes** a evitar
- ✅ **Ejemplo JSON concreto** con 2 epics reales

## 🎯 Casos de Uso Cubiertos

### Caso 1: Epic de APIs
```
Epic: "Create Authentication System"
Work: JWT tokens, login/register endpoints, password hashing
→ Backend repository ✅
```

### Caso 2: Epic de UI
```
Epic: "User Dashboard"
Work: Dashboard layout, charts, user profile component
→ Frontend repository ✅
```

### Caso 3: Epic Cross-Repo
```
Epic: "Real-time Notifications"
Work: WebSocket server (backend) + Toast component (frontend)
→ Both repositories ["v2_backend", "v2_frontend"] ✅
→ System splits into 2 sub-epics automatically
```

### Caso 4: Epic de Shared
```
Epic: "Type Definitions"
Work: TypeScript interfaces for API contracts
→ Shared repository ✅
```

## 🔄 Flujo Completo de Validación

```
┌─────────────────────────────────────────────────────────┐
│ 1. ProductManagerPhase                                  │
│    ✅ Valida que repos tengan type                      │
│    ✅ Falla si alguno es null                           │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 2. ProjectManagerPhase (AHORA REFORZADO)               │
│    ✅ Lee instrucciones EXPLÍCITAS de asignación       │
│    ✅ Sabe qué tipo de trabajo va a qué repo           │
│    ✅ Ve ejemplos concretos de backend vs frontend     │
│    ✅ Output: epics con affectedRepositories correcto  │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 3. ProjectManagerPhase (CÓDIGO)                        │
│    ✅ Lee epic.affectedRepositories del agente         │
│    ✅ Asigna targetRepository correctamente            │
│    ✅ Si multi-repo, divide en sub-epics               │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 4. TechLeadPhase                                       │
│    ✅ Hereda targetRepository del epic                 │
│    ✅ Stories heredan de epic                          │
└─────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────┐
│ 5. Developer                                           │
│    ✅ Usa story.targetRepository (heredado)           │
│    ✅ Ejecuta en repo correcto SIEMPRE                │
└─────────────────────────────────────────────────────────┘
```

## 📝 Testing Recomendado

### Test 1: Epic Mixto (Backend Work)
```
Task: "Implement user authentication"
Expected: ProjectManager debe crear epic en v2_backend
Verify: epic.affectedRepositories = ["v2_backend"]
```

### Test 2: Epic Mixto (Frontend Work)
```
Task: "Add login form with validation"
Expected: ProjectManager debe crear epic en v2_frontend
Verify: epic.affectedRepositories = ["v2_frontend"]
```

### Test 3: Task Multi-Repo
```
Task: "Create full user management system"
Expected: ProjectManager debe crear 2 epics:
  1. Backend API → v2_backend
  2. Frontend UI → v2_frontend
Verify: 2 epics separados con dependencia
```

### Test 4: Asignación Incorrecta
```
Scenario: Agente asigna React components a backend
Expected: Sistema falla porque archivos no existen
Verify: Error claro en logs
```

## 🎉 Resultado Esperado

Con estas instrucciones reforzadas, el agente ProjectManager debe:

✅ **Analizar cada epic** individualmente
✅ **Identificar el tipo de trabajo** (API vs UI vs Shared)
✅ **Asignar al repositorio correcto** basado en tipo
✅ **Usar nombres EXACTOS** de repositorios disponibles
✅ **Evitar errores comunes** (APIs en frontend, etc.)
✅ **Dividir correctamente** epics multi-repo

## 🔧 Archivos Modificados

| Archivo | Líneas | Cambio |
|---------|--------|--------|
| **ProjectManagerPhase.ts** | 114-162 | ✅ Nueva sección de instrucciones (50 líneas) |
| **ProjectManagerPhase.ts** | 236-261 | ✅ Ejemplo JSON con 2 epics concretos |

**Total**: 1 archivo, ~75 líneas modificadas

## 📚 Documentos Relacionados

- `REPOSITORY_FALLBACK_FIX_COMPLETE.md` - Fix del fallback peligroso
- `REPOSITORY_FALLBACK_BUG_ANALYSIS.md` - Análisis original del bug

---

**Estado**: ✅ **IMPLEMENTADO**
**Testing**: ⏳ Pendiente
**Impacto**: 🟢 Positivo - Mejora precisión de asignación de repos
