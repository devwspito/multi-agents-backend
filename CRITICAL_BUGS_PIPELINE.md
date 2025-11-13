# 🔴 CRITICAL BUGS - Developer-Judge Pipeline

**Fecha**: 2025-01-11
**Severidad**: 🔴 **CATASTRÓFICA**
**Estado**: 🔴 **ACTIVO - SISTEMA NO FUNCIONAL**

## 🎯 Síntomas

```
❌ [Judge] Story "Refactor TestPlayer" FAILED after 3 attempts
❌ [PRE-JUDGE] Commit f959ab0210147999c6fc265a6b7acdd500f491ec NOT found on remote!
   Branch: story/764bb3b5-epic-backend-attempt-contracts-story-6-1762883534654-3srsqv

📂 [Developer dev-3] Working on: epic-frontend-unified-attempt-display-story-3
📂 [Developer dev-3] Target repository: v2_frontend
🌿 [Developer dev-3] Creating story branch: story/764bb3b5-epic-frontend-unified-attempt-display-story-3-1762883644457-g4qu5f

❌ [PRE-JUDGE] Verifying commit in BACKEND branch (story-6)
❌ Developer working in FRONTEND story-3
❌ Verificación usa repositorio INCORRECTO
```

## 🔥 Bug #1: updatedStory es la ÚLTIMA Story, No la ACTUAL

**Ubicación**: DevelopersPhase.ts líneas 636-637

```typescript
const updatedState = await eventStore.getCurrentState(task._id as any);
const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);
//                  ↑ Busca por story.id, PERO...

// PROBLEMA: Si hay múltiples stories procesándose en paralelo,
// updatedState.stories puede tener TODAS las stories del task
// La que se encuentra puede NO ser la story actual si hay race conditions
```

**Uso Problemático** (línea 693, 767):

```typescript
console.log(`   Branch: ${updatedStory.branchName}`);  // ← Puede ser de OTRA story!
console.error(`   Branch: ${updatedStory.branchName}`); // ← Branch INCORRECTA
```

**Resultado**:
- Developer trabaja en `story-3` del frontend
- updatedStory apunta a `story-6` del backend (última actualizada)
- Verificación falla porque busca commit en branch equivocada

## 🔥 Bug #2: Fallback Usa repositories[0] (Siempre Frontend)

**Ubicación**: DevelopersPhase.ts líneas 702-720

```typescript
// Fallback: Try to get commit SHA from git (old way - not recommended)
if (!commitSHA) {
  console.warn(`⚠️  [PIPELINE] Falling back to git rev-parse HEAD (NOT RECOMMENDED)`);
  const targetRepo = repositories.length > 0 ? repositories[0] : null;
  //                                          ^^^^^^^^^^^^^^^^
  //                                          SIEMPRE PRIMER REPO = FRONTEND
```

**Problema**:
- Si Developer NO reporta commit SHA en output
- Sistema usa `repositories[0]` para obtener commit
- `repositories[0]` es SIEMPRE el primer repo del array
- Si array = `[v2_frontend, v2_backend]`, siempre usa frontend
- Aunque Developer esté trabajando en backend

**Resultado**:
- Developer trabaja en `v2_backend`
- Fallback lee commit de `v2_frontend`
- Commit SHA es del repo INCORRECTO
- Judge evalúa código incorrecto

## 🔥 Bug #3: Developer NO Hace Push al Remote

**Ubicación**: Developer agent prompt (AgentDefinitions.ts)

**Síntoma**:
```
⚠️  [PIPELINE] Developer did NOT report commit SHA in output
📍 [PIPELINE] Fallback commit SHA from git: f959ab0210147999c6fc265a6b7acdd500f491ec
❌ [PRE-JUDGE] Commit f959ab0210147999c6fc265a6b7acdd500f491ec NOT found on remote!
   This means Developer did NOT push commits successfully
```

**Problema**:
- Developer commitea localmente
- Developer NO hace `git push origin <branch>`
- Commit solo existe en workspace local
- Judge NO puede evaluar commit que no existe en GitHub

**Posibles Causas**:
1. Prompt no enfatiza suficientemente la necesidad de push
2. Developer falla al hacer push (permisos, red, etc.)
3. Developer reporta éxito ANTES de hacer push
4. Developer asume que alguien más hará el push

## 📊 Flujo Actual (Roto)

```
┌──────────────────────────────────────────────────────────┐
│ OrchestrationCoordinator                                 │
│   → story = currentStory (epic-frontend-story-3)        │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Developer Agent                                          │
│   → Receives story-3 (frontend)                         │
│   → Creates branch: story-3-frontend-xxx                │
│   → Makes changes                                        │
│   → git commit                                           │
│   → ❌ NO git push                                       │
│   → Reports: ✅ DEVELOPER_FINISHED_SUCCESSFULLY         │
│   → ❌ Does NOT report: 📍 Commit SHA: abc123           │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ DevelopersPhase - Post-Developer (líneas 636-720)       │
│   → updatedState = getCurrentState(task)                │
│   → updatedStory = find story by ID                     │
│   → ❌ BUG: updatedStory may be story-6 (backend)      │
│   → commitSHA not in output                             │
│   → ❌ Fallback: repositories[0] = frontend            │
│   → ❌ git rev-parse HEAD in WRONG repo                │
│   → commitSHA = abc123 (from WRONG repo/branch)         │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Pre-Judge Verification (líneas 733-779)                 │
│   → Verify commit abc123 exists on remote               │
│   → targetRepo = epic.targetRepository (frontend) ✅    │
│   → git ls-remote origin                                │
│   → Search for abc123 in output                         │
│   → ❌ NOT FOUND (commit never pushed)                  │
│   → ❌ ERROR: Branch = updatedStory.branchName          │
│   → ❌ Prints WRONG branch (story-6 backend)           │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Result                                                   │
│   ❌ Pipeline stops                                     │
│   ❌ Judge never runs                                   │
│   ❌ Story marked as failed                             │
│   ❌ User sees confusing error                          │
└──────────────────────────────────────────────────────────┘
```

## 🎯 Flujo Correcto (Esperado)

```
┌──────────────────────────────────────────────────────────┐
│ OrchestrationCoordinator                                 │
│   → story = currentStory (epic-frontend-story-3)        │
│   → targetRepo = story.targetRepository                 │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Developer Agent                                          │
│   → Creates branch: story-3-frontend-xxx                │
│   → Makes changes                                        │
│   → git add .                                            │
│   → git commit -m "message"                             │
│   → ✅ git push origin story-3-frontend-xxx             │
│   → ✅ Reports: 📍 Commit SHA: abc123def456            │
│   → Reports: ✅ DEVELOPER_FINISHED_SUCCESSFULLY         │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ DevelopersPhase - Post-Developer                        │
│   → Extract commitSHA from developer output ✅          │
│   → commitSHA = abc123def456 (from developer report)    │
│   → NO FALLBACK NEEDED ✅                               │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Pre-Judge Verification                                  │
│   → targetRepo = story.targetRepository ✅              │
│   → git ls-remote origin (in CORRECT repo)             │
│   → Search for abc123def456                             │
│   → ✅ FOUND (commit exists on remote)                 │
│   → ✅ Proceed to Judge                                │
└──────────────────────────────────────────────────────────┘
                    ↓
┌──────────────────────────────────────────────────────────┐
│ Judge                                                    │
│   → Evaluates commit abc123def456 ✅                    │
│   → Reviews CORRECT code ✅                             │
│   → Approves or rejects with feedback ✅                │
└──────────────────────────────────────────────────────────┘
```

## 🔧 Soluciones Propuestas

### Fix #1: Usar story Actual, No updatedStory

**DevelopersPhase.ts líneas 636-637**:

```typescript
// ❌ ANTES: Buscar en updatedState (puede ser stale)
const updatedState = await eventStore.getCurrentState(task._id as any);
const updatedStory = updatedState.stories.find((s: any) => s.id === story.id);

// ✅ DESPUÉS: Usar story directa del parámetro
// La story ya tiene toda la info necesaria (id, title, branchName, targetRepository)
// NO necesitamos buscarla en EventStore después de Developer
```

**Cambios necesarios**:
1. Usar `story` directamente en lugar de `updatedStory`
2. Si necesitamos `branchName`, obtenerla del event `StoryBranchCreated`
3. Validar que `story.branchName` existe antes de continuar

### Fix #2: Eliminar Fallback de repositories[0]

**DevelopersPhase.ts líneas 702-731**:

```typescript
// ❌ ANTES: Fallback a repositories[0]
if (!commitSHA) {
  const targetRepo = repositories.length > 0 ? repositories[0] : null;
  const repoPath = `${workspacePath}/${targetRepo.name}`;
  commitSHA = safeGitExecSync('git rev-parse HEAD', { cwd: repoPath }).trim();
}

// ✅ DESPUÉS: Usar story.targetRepository (ya heredado y validado)
if (!commitSHA) {
  if (!story.targetRepository) {
    throw new Error(`Story ${story.id} has no targetRepository - cannot get commit`);
  }

  const targetRepo = repositories.find(r =>
    r.name === story.targetRepository ||
    r.full_name === story.targetRepository ||
    r.githubRepoName === story.targetRepository
  );

  if (!targetRepo) {
    throw new Error(`Repository ${story.targetRepository} not found`);
  }

  const repoPath = `${workspacePath}/${targetRepo.name}`;

  // Checkout to story branch FIRST (critical!)
  safeGitExecSync(`git checkout ${story.branchName}`, { cwd: repoPath });
  commitSHA = safeGitExecSync('git rev-parse HEAD', { cwd: repoPath }).trim();
}
```

### Fix #3: Developer DEBE Hacer Push

**AgentDefinitions.ts - Developer Prompt**:

Agregar instrucciones EXPLÍCITAS:

```
## 🔥 CRITICAL: Git Push Requirements

After completing your work, you MUST:

1. ✅ Commit your changes:
   git add .
   git commit -m "descriptive message"

2. ✅ PUSH TO REMOTE (REQUIRED):
   git push origin <story-branch-name>

   ⚠️  WITHOUT THIS PUSH, JUDGE CANNOT REVIEW YOUR CODE
   ⚠️  THE PIPELINE WILL FAIL IF COMMIT IS NOT ON REMOTE

3. ✅ Report commit SHA in your output:
   echo "📍 Commit SHA: $(git rev-parse HEAD)"

4. ✅ Report success marker:
   echo "✅ DEVELOPER_FINISHED_SUCCESSFULLY"

Example final output:
```
git add .
git commit -m "Implement user authentication"
git push origin story/epic-1-backend-user-auth-story-1-xxx
📍 Commit SHA: abc123def456789...
✅ DEVELOPER_FINISHED_SUCCESSFULLY
```

If git push fails, report:
❌ DEVELOPER_FAILED: Could not push to remote
```

## 🚨 Impacto Actual

### Frecuencia
- ✅ Frontend stories: Pueden funcionar (si es el repo [0])
- ❌ Backend stories: SIEMPRE fallan (verificación busca en frontend)
- ❌ Multi-repo tasks: Completamente rotos

### Consecuencias
- ❌ Judge nunca evalúa código backend
- ❌ Pipeline se detiene sin feedback útil
- ❌ Developer commits quedan locales (se pierden)
- ❌ Branches huérfanas en GitHub
- ❌ Usuario ve errores confusos (branch incorrecta)

### Tasa de Éxito Estimada
- **Frontend**: ~30% (si Developer hace push Y es primer repo)
- **Backend**: ~0% (verificación siempre falla)
- **General**: ~15% (casi todo falla)

## 📝 Testing del Fix

### Test 1: Backend Story
```typescript
// Story: Backend API endpoint
// Epic: epic-backend-user-api
// Repository: v2_backend

// Expected:
✅ Developer works in v2_backend
✅ Developer pushes to story-backend-xxx branch
✅ Developer reports commit SHA
✅ Verification uses v2_backend repo
✅ Verification finds commit on remote
✅ Judge evaluates CORRECT code
```

### Test 2: Frontend Story
```typescript
// Story: Frontend component
// Epic: epic-frontend-user-ui
// Repository: v2_frontend

// Expected:
✅ Developer works in v2_frontend
✅ Developer pushes to story-frontend-xxx branch
✅ Developer reports commit SHA
✅ Verification uses v2_frontend repo
✅ Verification finds commit on remote
✅ Judge evaluates CORRECT code
```

### Test 3: Developer Sin Push
```typescript
// Developer commits but doesn't push

// Expected:
❌ Verification fails: commit not on remote
❌ Clear error: "Developer did NOT push"
❌ Pipeline stops BEFORE Judge
✅ No wrong code evaluated
```

## 🎯 Prioridad

**P0 - CRÍTICO - BLOQUEANTE**

El sistema NO es funcional con estos bugs:
1. Backend stories nunca pasan Judge
2. Verificación usa repos/branches incorrectas
3. Developer no hace push → código se pierde

**Sin estos fixes, el sistema es INESTABLE e IMPREDECIBLE** (como mencionaste).

---

**Estado**: 🔴 **ACTIVO - REQUIERE FIX INMEDIATO**
**Impacto**: 🔴 **CATASTRÓFICO - SISTEMA NO FUNCIONAL**
**ETA Fix**: 30 minutos (3 archivos)
