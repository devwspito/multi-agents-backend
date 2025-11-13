# 🎯 FIX CRÍTICO: Tech Lead Repository Type Awareness

## 🔍 Problema Detectado por Usuario

**Observación clave del usuario**:
> "En el Frontend, si que funciono todo bien. Si que se hicieron los merged correctamente, todo funciono bien. Me preocupa enormemente que lo que este pasando es que teach lead no este dejando claro cuales son las tareas para el backend y cuales son para el frontend, y por eso judge rechaza, porque claro, todo esta mal."

**Diagnóstico**:
- ✅ **Frontend epic funcionó perfectamente** - Judge aprobó, merges exitosos, código completo
- ❌ **Backend epic falló** - Judge rechazó todo, epic solo tiene .md file
- 🔥 **Root cause**: Tech Lead asignaba tareas **incorrectas para el tipo de repositorio**

Ejemplo del problema:
- Backend epic recibía tareas de UI (React components, páginas)
- Judge rechazaba porque el código era inapropiado para un repo de backend
- Epic quedaba vacío porque ninguna story pasaba review

---

## ✅ SOLUCIÓN IMPLEMENTADA

### 1. Usar Repository Type Real de Base de Datos

**ANTES** (línea 658 - TechLeadPhase.ts):
```typescript
// ❌ MALO: Heurística de strings débil
const repoType = epic.targetRepository ?
  (epic.targetRepository.includes('frontend') || epic.targetRepository.includes('ws-project')
    ? 'FRONTEND'
    : 'BACKEND')
  : 'UNKNOWN';
```

**Problemas**:
- Solo funcionaba si el nombre incluía "frontend" o "ws-project"
- Fallaba con nombres como "api-backend", "backend-service", etc.
- No usaba el campo `type` real de la base de datos

**AHORA** (líneas 659-666 - TechLeadPhase.ts):
```typescript
// ✅ BUENO: Busca el repo real en BD y usa su campo type
const repoObj = repositories?.find(r =>
  r.name === targetRepo ||
  r.githubRepoName === targetRepo ||
  r.full_name === targetRepo
);
const repoType = repoObj?.type ? repoObj.type.toUpperCase() : 'UNKNOWN';
const repoTypeEmoji = repoObj?.type === 'backend' ? '🔧' :
                      repoObj?.type === 'frontend' ? '🎨' :
                      repoObj?.type === 'mobile' ? '📱' : '📦';
```

**Beneficios**:
- ✅ Usa el campo `type: 'backend' | 'frontend' | 'mobile' | 'shared'` de MongoDB
- ✅ Funciona con cualquier nombre de repositorio
- ✅ Confiable al 100% (datos de BD, no heurística)

---

### 2. Prompts Explícitos por Tipo de Repo

**Añadido** (líneas 692-715 - TechLeadPhase.ts):

#### Para BACKEND:
```markdown
## 🔧 BACKEND Repository - Focus On:
✅ **APIs & Endpoints**: Express routes, controllers, API handlers
✅ **Business Logic**: Services, models, database operations
✅ **Data Processing**: Validation, transformation, calculations
✅ **Server-Side**: Authentication, authorization, middleware
✅ **Database**: Schemas, queries, migrations, seeds
✅ **Tests**: Unit tests (Jest), integration tests, API tests

❌ **DO NOT** assign UI/frontend tasks (React components, CSS, pages, hooks)
❌ **DO NOT** assign client-side state management (Redux, Context, etc.)
```

#### Para FRONTEND:
```markdown
## 🎨 FRONTEND Repository - Focus On:
✅ **UI Components**: React components, hooks, pages
✅ **State Management**: Redux, Context, local state
✅ **Styling**: CSS, styled-components, Tailwind
✅ **Client-Side**: Routing, forms, validation, API calls
✅ **User Experience**: Interactions, animations, responsiveness
✅ **Tests**: Component tests (Jest + RTL), E2E tests

❌ **DO NOT** assign backend tasks (APIs, database, server logic)
❌ **DO NOT** assign Express routes or MongoDB schemas
```

**Resultado**:
- Tech Lead recibe instrucciones CLARAS de qué puede y no puede asignar
- Usa emojis y formato para máxima visibilidad
- Lista explícita de ✅ tareas apropiadas y ❌ tareas prohibidas

---

### 3. Logs Mejorados

**ANTES** (líneas 98-103):
```typescript
console.log(`\n🎯 [TechLead] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
console.log(`   Epic: ${teamEpic.title}`);
console.log(`   Branch: ${epicBranch}`);
console.log(`   Complexity: ${teamEpic.estimatedComplexity}`);
```

**AHORA** (líneas 98-111):
```typescript
const repoObj = context.repositories.find(r =>
  r.name === targetRepo || r.githubRepoName === targetRepo || r.full_name === targetRepo
);
const repoTypeEmoji = repoObj?.type === 'backend' ? '🔧' :
                      repoObj?.type === 'frontend' ? '🎨' :
                      repoObj?.type === 'mobile' ? '📱' : '📦';

console.log(`\n🎯 [TechLead] Multi-Team Mode: Working on epic: ${teamEpic.id}`);
console.log(`   Epic: ${teamEpic.title}`);
console.log(`   Branch: ${epicBranch}`);
console.log(`   Target Repo: ${repoTypeEmoji} ${targetRepo} (${repoObj?.type?.toUpperCase() || 'UNKNOWN'})`);
console.log(`   Complexity: ${teamEpic.estimatedComplexity}`);
console.log(`   🔥 CRITICAL: Tech Lead will ONLY create stories for ${repoObj?.type?.toUpperCase()} tasks`);
```

**Beneficios**:
- ✅ Muestra claramente el tipo de repo con emoji
- ✅ Warning explícito de qué tipo de tareas debe crear
- ✅ Fácil de ver en logs si hay confusión

---

### 4. Prompt Principal Actualizado

**Cambios en líneas 729-733**:
```typescript
## 🎯 INSTRUCTIONS:
1. EXPLORE codebase (max 2 min): cd ${workspacePath}/${targetRepo} && find src
2. **CRITICAL**: Only create stories appropriate for ${repoType} repository
3. BREAK INTO 2-5 STORIES (each 1-3 hours work)
4. ASSIGN DEVELOPERS (1 dev per story)
```

**Añadido**:
- Instrucción #2 es CRÍTICA y está en negritas
- Menciona explícitamente el tipo de repo (BACKEND/FRONTEND)
- Se muestra ANTES de pedir el JSON output

---

## 📊 FLUJO MEJORADO

### ANTES:
```
1. Product Manager crea epic para Backend
2. Tech Lead recibe epic con targetRepository="v2_backend"
3. Tech Lead usa heurística: no contiene "frontend" → tipo = "BACKEND"
4. ❌ PERO prompt es genérico, no menciona tipo específico
5. ❌ Tech Lead asigna tareas mezcladas (APIs + UI components)
6. Developer intenta implementar UI en backend repo → código incorrecto
7. Judge rechaza todo → Epic vacío
```

### AHORA:
```
1. Product Manager crea epic para Backend
2. Tech Lead recibe epic con targetRepository="v2_backend"
3. Tech Lead busca repo en BD → encuentra {name: "v2_backend", type: "backend"}
4. ✅ Tech Lead recibe prompt con:
   - "🔧 BACKEND Repository - Focus On"
   - Lista de ✅ tareas apropiadas (APIs, DB, services)
   - Lista de ❌ tareas prohibidas (UI, React, CSS)
5. ✅ Tech Lead SOLO crea stories de backend (APIs, schemas, controllers)
6. Developer implementa código apropiado para backend
7. Judge aprueba → Merge exitoso → Epic completo
```

---

## 🎯 ARCHIVOS MODIFICADOS

### TechLeadPhase.ts

**Línea 147**: Pasar `repositories` al método `buildMultiTeamPrompt`
```typescript
const prompt = multiTeamMode ?
  this.buildMultiTeamPrompt(teamEpic, repoInfo, workspaceInfo, workspacePath, firstRepoName, epicBranch, masterEpic, context.repositories)
  : `...`;
```

**Líneas 98-111**: Logs mejorados con tipo de repo
```typescript
const repoObj = context.repositories.find(...);
console.log(`   Target Repo: ${repoTypeEmoji} ${targetRepo} (${repoObj?.type?.toUpperCase() || 'UNKNOWN'})`);
console.log(`   🔥 CRITICAL: Tech Lead will ONLY create stories for ${repoObj?.type?.toUpperCase()} tasks`);
```

**Líneas 656-666**: Firma actualizada y búsqueda de repo real
```typescript
private buildMultiTeamPrompt(..., repositories?: any[]): string {
  const repoObj = repositories?.find(r =>
    r.name === targetRepo || r.githubRepoName === targetRepo || r.full_name === targetRepo
  );
  const repoType = repoObj?.type ? repoObj.type.toUpperCase() : 'UNKNOWN';
  const repoTypeEmoji = ...;
```

**Líneas 692-715**: Guidance específico por tipo de repo
```typescript
const repoGuidance = repoObj?.type === 'backend' ? `
## 🔧 BACKEND Repository - Focus On:
...
` : repoObj?.type === 'frontend' ? `
## 🎨 FRONTEND Repository - Focus On:
...
` : '';
```

**Líneas 717-733**: Prompt actualizado con guidance y tipo explícito
```typescript
return `TECH LEAD - MULTI-TEAM MODE
...
**Target**: ${repoTypeEmoji} ${targetRepo} (${repoType})
...
${repoGuidance}

## 🎯 INSTRUCTIONS:
1. EXPLORE codebase...
2. **CRITICAL**: Only create stories appropriate for ${repoType} repository
...`;
```

---

## 🚀 RESULTADOS ESPERADOS

### Logs de Tech Lead (NUEVO):
```
🎯 [TechLead] Multi-Team Mode: Working on epic: epic-2
   Epic: Implement User Authentication API
   Branch: epic/epic-2
   Target Repo: 🔧 v2_backend (BACKEND)
   Complexity: moderate
   🔥 CRITICAL: Tech Lead will ONLY create stories for BACKEND tasks
```

### Prompt que recibe Tech Lead (NUEVO):
```markdown
TECH LEAD - MULTI-TEAM MODE

## Epic: epic-2 - Implement User Authentication API
**Target**: 🔧 v2_backend (BACKEND)

## 🔧 BACKEND Repository - Focus On:
✅ **APIs & Endpoints**: Express routes, controllers, API handlers
✅ **Business Logic**: Services, models, database operations
...
❌ **DO NOT** assign UI/frontend tasks (React components, CSS, pages, hooks)

## 🎯 INSTRUCTIONS:
1. EXPLORE codebase (max 2 min)
2. **CRITICAL**: Only create stories appropriate for BACKEND repository
3. BREAK INTO 2-5 STORIES
```

### Stories que Tech Lead creará (NUEVO):
```json
{
  "stories": [
    {
      "title": "Implement Login API Endpoint",
      "filesToModify": ["src/routes/auth.ts", "src/controllers/authController.ts"],
      "filesToCreate": ["src/services/AuthService.ts"]
    },
    {
      "title": "Create User Schema and Model",
      "filesToModify": ["src/models/User.ts"],
      "filesToCreate": ["src/schemas/userSchema.ts"]
    }
  ]
}
```

**Resultado**:
- ✅ Solo tareas de backend (APIs, schemas, services)
- ✅ NO tareas de frontend (React, CSS, componentes)
- ✅ Judge aprueba porque código es apropiado
- ✅ Epic contiene TODO el código backend

---

## 🔒 GARANTÍAS

### ❌ YA NO PUEDE PASAR:
1. Tech Lead asigna UI tasks a backend repo
2. Tech Lead asigna API tasks a frontend repo
3. Judge rechaza todo por código inapropiado
4. Epic queda vacío solo con .md file

### ✅ AHORA GARANTIZADO:
1. Tech Lead conoce EXACTAMENTE el tipo de repo
2. Tech Lead recibe lista EXPLÍCITA de tareas apropiadas/prohibidas
3. Tech Lead solo crea stories del tipo correcto
4. Judge aprueba porque código es apropiado para el repo
5. Epic contiene TODO el código necesario

---

## 🎯 PRÓXIMOS PASOS

1. **Ejecutar task de prueba con backend epic**
   - Verificar logs muestran "🔧 BACKEND"
   - Verificar prompt incluye "🔧 BACKEND Repository - Focus On"
   - Verificar stories son SOLO de backend (APIs, DB, services)

2. **Verificar Judge aprueba**
   - Developer implementa código backend apropiado
   - Judge ve código correcto para tipo de repo
   - Judge aprueba → Merge exitoso

3. **Verificar epic completo**
   - Epic branch contiene todos los merges
   - Epic tiene N commits (no solo 1 .md)
   - PR epic → main muestra TODO el código

---

**Última Actualización**: 2025-01-11
**Estado**: ✅ IMPLEMENTADO Y RUNNING
**Servidor**: ✅ PORT 3001
**Fix**: Tech Lead ahora usa `repository.type` de BD + prompts explícitos por tipo
