# Plan de Corrección de Bugs - Priorizado

**Extraído de**: RECOVERY_SYSTEM_NOTES.md + INTEGRATION_PHASE_DESIGN.md
**Fecha**: 2026-01-20
**Última actualización**: 2026-01-20

---

## Prioridad 0: CRÍTICO (Bloquea el sistema)

### 0.1 MongoDB Bloqueando el Sistema ✅ COMPLETADO
**Impacto**: Timeouts causan que el sistema se cuelgue
**Archivos**: GranularMemoryService.ts, EventStore.ts

- [x] Cambiar `await store()` a fire-and-forget en todas las fases
- [x] Implementar buffer local en GranularMemoryService
- [x] Crear fallback a JSONL local si MongoDB falla
- [x] Añadir background sync a MongoDB
- [x] EventStore LOCAL-FIRST: `append()` guarda LOCAL primero, MongoDB backup
- [x] EventStore LOCAL-FIRST: `getEvents()` lee LOCAL primero, MongoDB fallback
- [x] EventStore LOCAL-FIRST: `getEventsSince()` lee LOCAL primero

**Implementación**: Fire-and-forget con local-first. Guarda a disco inmediatamente, MongoDB en background.
EventStore ahora guarda eventos en `{workspace}/.agent-memory/events.jsonl` como fuente primaria.

---

## Prioridad 1: ALTA (Causa pérdida de trabajo)

### 1.1 Git Local/Remote Desync ❌ DESCARTADO
**Impacto**: Workspace local no tiene el código que está en GitHub
**Archivos**: TeamOrchestrationPhase.ts

- [ ] ~~Hacer `git pull` después de cada push para mantener local sincronizado~~
- [ ] ~~Verificar que local == remote después de cada operación~~
- [ ] ~~Implementar `postMergeSync()` function~~

**Razón de descarte**: `StoryPushVerified` verifica directamente contra GitHub. El workspace local desync no importa si verificamos contra GitHub (fuente de verdad).

### 1.2 Story Branch Naming Fallback Incorrecto ✅ YA ESTABA ARREGLADO
**Impacto**: Merges fallan porque buscan branches que no existen
**Archivo**: TeamOrchestrationPhase.ts línea 1695-1720

- [x] Arreglar fallback para usar execution-map/EventStore
- [x] Buscar en git remoto como último recurso
- [x] NO usar fallback incorrecto, solo warning

**Nota**: El código ya busca en `git branch -r` y NO usa el fallback incorrecto.

### 1.3 Commits Sin Push ✅ COMPLETADO
**Impacto**: Código existe localmente pero no llega a GitHub
**Archivos**: EventStore.ts, DevelopersPhase.ts, RecoveryPhase.ts

- [x] Implementar `verifyStoryPushed()` después de cada story
- [x] RecoveryPhase detecta stories no verificadas
- [ ] ~~Añadir background checker para unpushed commits~~ (RecoveryPhase lo cubre)

**Implementación**:
- Nuevo evento `StoryPushVerified` en EventStore
- `verifyStoryPush()` después de cada push en DevelopersPhase
- RecoveryPhase Step 2/4 verifica todas las stories contra GitHub

### 1.4 Stories No Registrándose en Execution-Map ✅ COMPLETADO
**Impacto**: Recovery no puede detectar qué stories están completas
**Archivos**: TechLeadPhase.ts

- [x] Diagnosticar por qué `registerStories()` no encontraba epics
- [x] Identificar causa raíz: TechLead genera epicIds propios (ej: "epic-1")
- [x] Planning registra epicIds diferentes (ej: "epic-backend-foundation")
- [x] Fix: Sobrescribir epicId del agente con epicId original de Planning

**Implementación**:
En TechLeadPhase.ts, después de parsear la respuesta del agente, se sobrescribe
`epic.id` y `story.epicId` con el ID original de Planning (`teamEpicId`).

---

## Prioridad 2: MEDIA (Mejora reliability)

### 2.1 IntegrationPhase (NUEVA) ✅ COMPLETADO
**Impacto**: Evita merge conflicts al combinar epics
**Archivos**: IntegrationPhase.ts

- [x] Crear ConflictResolver para index.ts files
- [x] Crear IntegrationValidator (run build)
- [x] Crear IntegrationDeveloper (fix TS errors)
- [x] Integrar en OrchestrationCoordinator

**Nota**: IntegrationPhase ya existe y está integrado.

### 2.2 ReconciliationService ⏳ PARCIALMENTE CUBIERTO
**Impacto**: Auto-repara desync entre Git/MongoDB
**Archivo**: RecoveryPhase.ts

- [x] Comparar estado git vs MongoDB (RecoveryPhase lo hace)
- [ ] Auto-corregir discrepancias (parcial - detecta pero no auto-corrige todo)
- [x] Ejecutar al final de cada task (RecoveryPhase corre antes de Integration)

**Nota**: RecoveryPhase cubre la mayoría de esto. Un ReconciliationService dedicado sería redundante.

### 2.3 EpicPRReconciliationPhase ⏳ PENDIENTE (Nice-to-have)
**Impacto**: Asegura que todos los epics tengan PRs
**Archivo**: Nuevo EpicPRReconciliationPhase.ts

- [ ] Listar epic branches sin PR
- [ ] Crear PRs faltantes automáticamente
- [ ] Ejecutar después de AutoMergePhase

**Nota**: RecoveryPhase ya detecta esto. Crear PRs automáticamente es el paso faltante.

### 2.4 Timeout != Fallo ✅ YA ESTABA BIEN
**Impacto**: Evita marcar como fallido trabajo que solo fue lento
**Archivos**: Multiple phases

- [x] Stories corren secuencialmente (una falla no bloquea otras)
- [x] TechLead timeout auto-continúa
- [ ] ~~Promise.allSettled~~ (no aplica - ejecución secuencial)

**Nota**: La ejecución secuencial ya maneja esto correctamente.

---

## Prioridad 3: MEJORAS (Nice to have)

### 3.1 GranularMemory Completo ⏳ PARCIALMENTE IMPLEMENTADO
**Impacto**: Mejor debugging y recovery
**Archivo**: GranularMemoryService.ts

- [x] Fire-and-forget implementado
- [x] Local-first storage
- [ ] Integrar storeFileChange() en CADA Write/Edit
- [ ] Integrar logging en CADA git operation
- [ ] Llamar storeError() en CADA catch/timeout

### 3.2 LocalSnapshotService (Event Sourcing) ⏳ PENDIENTE
**Impacto**: Recovery completo desde archivos locales
**Archivo**: Nuevo LocalSnapshotService.ts

- [ ] Guardar CADA tool call y result
- [ ] Guardar CADA git operation
- [ ] Crear CLI para inspeccionar snapshots
- [ ] Implementar recovery desde snapshot

**Nota**: GranularMemory + EventStore cubren parte de esto.

### 3.3 GitRetryService ⏳ PENDIENTE
**Impacto**: Reintentos automáticos de operaciones git
**Archivo**: Nuevo GitRetryService.ts

- [ ] Circuit breaker pattern
- [ ] Exponential backoff
- [ ] Background processor para deferred operations
- [ ] Métricas de retry

### 3.4 Frontend Improvements ⏳ PENDIENTE
**Impacto**: Mejor visibilidad del estado
**Archivos**: Frontend components

- [x] Recovery/Integration phases añadidos a UI
- [ ] PlanningVsRealityView component
- [ ] Highlight discrepancias
- [ ] Botón "Create Missing PR"
- [ ] Botón "Retry" para operaciones fallidas

---

## Resumen de Estado

| Prioridad | Total | Completado | Descartado | Pendiente |
|-----------|-------|------------|------------|-----------|
| P0 (Crítico) | 1 | 1 ✅ | 0 | 0 |
| P1 (Alta) | 4 | 3 ✅ | 1 ❌ | 0 |
| P2 (Media) | 4 | 2 ✅ | 0 | 2 ⏳ |
| P3 (Mejoras) | 4 | 0 | 0 | 4 ⏳ |
| Bugs Doc | 7 | 5 ✅ | 0 | 2 ⏳ |

**Bugs documentados arreglados**: BUG-001 (⏳), BUG-002 (✅v2), BUG-003 (⏳), BUG-004 (✅), BUG-005 (✅), BUG-006 (✅), BUG-007 (⏳)

---

## Métricas de Éxito (Actualizadas)

| Métrica | Antes | Después (Esperado) | Estado |
|---------|-------|-------------------|--------|
| MongoDB timeouts | Frecuente | Raro | ✅ Fire-and-forget |
| MongoDB crash = datos perdidos | Sí | No | ✅ EventStore local-first |
| Story push perdido | Frecuente | Detectable | ✅ StoryPushVerified |
| Branch names incorrectos | Ocasional | Raro | ✅ Git remote search |
| Git fetch redundante | ~4min/epic | <30s/epic | ✅ Cache 60s |
| Local/GitHub sync issues | Frecuente | N/A | ❌ Descartado (verificamos GitHub) |
| Stories no registradas | Siempre | Nunca | ✅ EpicId override en TechLead |

---

**Próximos pasos sugeridos**:
1. Validar mejoras con un task completo
2. Si hay issues, considerar GitRetryService
3. Frontend PlanningVsRealityView para debugging

---

## Bugs Pendientes (Documentados para corregir)

### BUG-001: Judge rechaza archivos vacíos legítimos (.gitkeep) ⏳ PENDIENTE
**Fecha detectado**: 2026-01-20
**Impacto**: Stories válidas son rechazadas incorrectamente
**Archivo**: JudgePhase.ts

**Descripción**:
El Judge verifica que los archivos requeridos existan y tengan contenido (`size > 0`).
Sin embargo, archivos como `.gitkeep` son **intencionalmente vacíos** (0 bytes) - su propósito
es permitir que git trackee directorios vacíos.

**Síntoma**:
```
❌ EMPTY: android/.gitkeep (0 bytes)
❌ EMPTY: ios/.gitkeep (0 bytes)
🚨 AUTOMATIC REJECTION: Developer did not create required files.
```

**Verificación**:
Los archivos SÍ existen en GitHub con 0 bytes (correcto para .gitkeep):
- `android/.gitkeep` ✅ existe, 0 bytes
- `ios/.gitkeep` ✅ existe, 0 bytes

**Fix propuesto**:
En JudgePhase.ts, modificar la verificación de archivos para:
1. Distinguir entre "archivo no existe" vs "archivo vacío"
2. Permitir archivos de 0 bytes si el nombre termina en `.gitkeep`
3. O simplemente verificar existencia (`fs.existsSync`) sin validar tamaño

**Workaround actual**:
Merge manual de la story branch al epic branch.

### BUG-002: SDK history_overflow pierde trabajo completado ✅ ARREGLADO (v2)
**Fecha detectado**: 2026-01-20
**Fecha fix v2**: 2026-01-21
**Impacto**: Trabajo completado por developer no se registra como exitoso
**Archivo**: OrchestrationCoordinator.ts, DevelopersPhase.ts

**Descripción**:
Cuando un developer completa su trabajo pero el historial de conversación es muy largo (200+ mensajes),
el SDK falla al intentar continuar (reportar éxito, pasar a Judge). Nuestro código detecta esto como
"history_overflow" y aborta, pero el trabajo YA ESTÁ COMPLETADO y pusheado a GitHub.

**Síntoma**:
```
❌ [ExecuteAgent] Error: Agent developer failed to start: 200 messages without turn_start.
   SDK may be stuck replaying history. Last message types: assistant, assistant, assistant...
💾 [FailedExecution] Saved failed execution for retry:
   Failure: history_overflow
```

**Verificación manual**:
1. El story branch existe en GitHub con commits del developer
2. Los archivos fueron creados correctamente
3. Working tree está limpio
4. Pero el sistema no registró el éxito

**Fix propuesto - DeveloperWorkVerifier helper**:
Crear un helper que se ejecute cuando falla un developer con `history_overflow`:

```typescript
// En DevelopersPhase.ts o nuevo DeveloperWorkVerifier.ts
async function verifyDeveloperWorkCompleted(
  workspacePath: string,
  storyBranch: string,
  epicBranch: string,
  expectedFiles: string[]
): Promise<{ completed: boolean; commits: string[]; files: string[] }> {

  // 1. Verificar si el story branch existe
  const branchExists = await git.branchExists(storyBranch);
  if (!branchExists) return { completed: false, commits: [], files: [] };

  // 2. Verificar commits nuevos (después del checkpoint)
  const commits = await git.getCommitsSince(checkpointCommit);
  if (commits.length === 0) return { completed: false, commits: [], files: [] };

  // 3. Verificar archivos creados/modificados
  const changedFiles = await git.getFilesChanged(checkpointCommit, 'HEAD');

  // 4. Si hay commits y archivos, el trabajo está completo
  return {
    completed: commits.length > 0 && changedFiles.length > 0,
    commits,
    files: changedFiles
  };
}
```

**Flujo de recuperación**:
1. Developer falla con `history_overflow`
2. Sistema llama `verifyDeveloperWorkCompleted()`
3. Si retorna `completed: true`:
   - Registrar story como completada en execution-map
   - Emitir evento `StoryCompleted`
   - Pasar directamente a Judge (skip retry del developer)
4. Si retorna `completed: false`:
   - Comportamiento actual (retry o human intervention)

**Integración en catch de executeAgent**:
```typescript
catch (error) {
  if (error.isHistoryOverflow && agentType === 'developer') {
    const verification = await verifyDeveloperWorkCompleted(...);
    if (verification.completed) {
      console.log(`✅ Developer work verified despite SDK failure`);
      // Registrar éxito y continuar a Judge
      return { success: true, recoveredFromOverflow: true };
    }
  }
  // ... resto del manejo de error
}
```

**Fix implementado (2026-01-21)**:
En el catch block de `executeIsolatedStoryPipeline()` en DevelopersPhase.ts:
1. Cuando falla el pipeline, verificamos si hay commits en git usando `verifyDeveloperWorkFromGit()`
2. Si hay commits, creamos un `recoveryPipelineCtx` y ejecutamos Judge directamente
3. Si Judge aprueba, ejecutamos Merge y emitimos `StoryCompleted`
4. Esto permite recuperar trabajo que fue completado pero cuyo registro falló

**Fix v2 (2026-01-21) - FORCE TO JUDGE**:
Problema adicional: Si developer reporta FAILED marker pero SÍ tiene commits, se abortaba la story.
Solución: Ahora verificamos git ANTES de respetar el FAILED marker.
1. En líneas 1801-1805: Ya no hacemos `return` temprano cuando hay FAILED marker
2. En líneas 1866-1872: Si hay commits Y FAILED marker, logueamos `[FORCE-JUDGE]` y continuamos a Judge
3. Git es la fuente de verdad: Si hay commits, dejamos que Judge evalúe el código

### BUG-003: Story ID mismatch entre Planning y ejecución ⏳ PENDIENTE
**Fecha detectado**: 2026-01-20
**Impacto**: Teams marcados como fallidos aunque stories completadas
**Archivo**: TeamOrchestrationPhase.ts, DevelopersPhase.ts

**Descripción**:
Planning genera stories con IDs como `story-ui-001`, pero durante ejecución se registran como
`epic-ui-foundation-story-1`. Al verificar completitud, no encuentra las stories porque los IDs no coinciden.

**Síntoma**:
```
📊 [Team 3] Story completion check:
   Total stories: 6
   Completed: 5

❌ Missing stories: story-ui-001, story-ui-002, story-ui-003... (TODOS)
```

**Causa raíz**:
Similar al bug de epicId en TechLead - Planning usa un esquema de IDs diferente al que usa
el sistema de ejecución y registro.

**Fix propuesto**:
1. En TeamOrchestrationPhase, normalizar los storyIds cuando se registran completados
2. O hacer el match por título/descripción en vez de ID exacto
3. O forzar que Planning genere IDs en el formato esperado

**Workaround actual**:
RecoveryPhase verificará contra GitHub y detectará stories completas por branch/commits.

### BUG-004: DevelopersCompleted emitido sin ejecución de developers ✅ ARREGLADO
**Fecha detectado**: 2026-01-21
**Impacto**: Epics completos sin código, dinero gastado sin resultado
**Archivo**: TeamOrchestrationPhase.ts, DevelopersPhase.ts

**Descripción**:
En algunos epics, el evento `DevelopersCompleted` se emite inmediatamente después de `TechLeadCompleted`
sin que DevelopersPhase ejecute ningún developer. El resultado es un epic branch sin código de stories.

**Síntoma** (en events.jsonl):
```
Version 100: TechLeadCompleted { epicId: "epic-auth-ui", team: 4 }
Version 101: DevelopersCompleted { epicId: "epic-auth-ui", team: 4, stories: 5 }
```
Sin ningún evento `StoryCompleted` entre ellos.

**Verificación manual**:
1. El epic branch existe en GitHub
2. Solo tiene commits de TechLead (arquitectura)
3. NO hay `src/components/auth/` ni ningún código de stories
4. NO hay directorios `story-*` en el team workspace local

**Epics afectados** (task 909bbf1b):
- Auth UI (team-4): TechLead APPROVED, 5 stories planificadas, 0 ejecutadas
- Goals UI (team-7): TechLead APPROVED, stories planificadas, 0 ejecutadas

**Causa raíz probable**:
En `TeamOrchestrationPhase.ts`, la lógica que verifica si hay stories pendientes puede estar
fallando silenciosamente o emitiendo `DevelopersCompleted` antes de que DevelopersPhase procese.

**Fix propuesto**:
1. Agregar guard en TeamOrchestrationPhase que verifique que AL MENOS una story se ejecutó
2. Verificar el array de stories antes de emitir DevelopersCompleted
3. Agregar logging más detallado del flujo TechLead -> Developers

**Fix implementado (2026-01-21)**:
En DevelopersPhase.ts, antes de emitir `DevelopersCompleted`:
1. Contamos stories ASIGNADAS vs stories REALMENTE COMPLETADAS (eventos `StoryCompleted` en EventStore)
2. Si `actuallyCompletedCount === 0 && assignedStoriesCount > 0`, emitimos con `failed: true`
3. Agregamos logging detallado para detectar cuando ocurre este problema
4. El evento ahora incluye tanto `storiesImplemented` (actual) como `storiesAssigned` (planificado)

### BUG-005: Developer acumula muchos archivos sin push y pierde trabajo ✅ ARREGLADO
**Fecha detectado**: 2026-01-21
**Impacto**: Trabajo perdido cuando developer falla a mitad de story
**Archivo**: OrchestrationCoordinator.ts (developer prompt)

**Descripción**:
Cuando un developer escribe múltiples archivos sin hacer push incremental, si ocurre un crash o timeout
a mitad de la story, TODO el trabajo no pusheado se pierde. Esto es crítico especialmente con stories
grandes que requieren modificar 5-10+ archivos.

**Síntoma**:
```
Developer escribe archivos A, B, C, D, E
SDK falla en archivo F
Archivos A-E están en local pero NUNCA fueron pusheados
Recovery no encuentra commits → Story marcada como fallida
```

**Fix implementado (2026-01-21)**:
En OrchestrationCoordinator.ts, prompt del developer:
1. Nueva regla "COMMIT AND PUSH INCREMENTALLY" (líneas 3008-3012)
2. Nueva regla "PUSH FREQUENCY RULE" (líneas 3014-3018) - máximo 2-3 archivos sin push
3. En workflow iterativo (líneas 3435-3445) - paso 5 y 6 ahora incluyen commit+push
4. Bloque "INCREMENTAL PUSH PATTERN" con ejemplo explícito

**Comportamiento esperado**:
```
Developer escribe archivo A → commit + push
Developer escribe archivos B, C → commit + push
Developer escribe archivos D, E → commit + push
Si falla en F → Recovery encuentra commits de A-E → Story puede pasar a Judge
```

### BUG-006: Recovery depende de MongoDB en vez de Local ✅ ARREGLADO
**Fecha detectado**: 2026-01-21
**Impacto**: Tasks interrumpidas no se recuperan si MongoDB está vacío/desincronizado
**Archivo**: OrchestrationRecoveryService.ts

**Descripción**:
El sistema de recovery al iniciar servidor buscaba tasks en MongoDB primero. Si MongoDB estaba
vacío o desincronizado, las tasks con estado `in_progress` en `.agent-memory/` local no se recuperaban.

**Síntoma**:
```
Server restart:
✅ [Recovery] No interrupted orchestrations found

Pero localmente existe:
/agent-workspace-prod/task-xxx/.agent-memory/execution-summary.md
  **Status:** in_progress
```

**Fix implementado (2026-01-21)**:
En OrchestrationRecoveryService.ts, método `recoverAllInterruptedOrchestrations()`:
1. Nuevo método `scanLocalWorkspacesForInterruptedTasks()` que escanea `agent-workspace-prod/task-*`
2. Lee `.agent-memory/execution-summary.md` para determinar status
3. Si local tiene tasks in_progress → Las recupera (incluso si no están en MongoDB)
4. MongoDB solo se consulta como FALLBACK si local no encuentra nada

**TODO pendiente**:
- Los endpoints `/resume` y `/retry` aún dependen de MongoDB
- Requiere refactor más grande para hacerlos local-first también

### BUG-007: No hay recovery cuando roadmap/planning está corrupto ⏳ PENDIENTE
**Fecha detectado**: 2026-01-21
**Impacto**: Trabajo completado se pierde y requiere upload manual a git
**Archivo**: RecoveryPhase.ts, OrchestrationRecoveryService.ts

**Descripción**:
Cuando el roadmap (planning data) está corrupto o incompleto, el sistema no puede continuar
la orchestration. Sin embargo, puede haber código ya completado en los workspaces locales
que nunca fue pusheado a git.

**Síntoma**:
```
Recovery intenta cargar roadmap/epics/stories
Roadmap corrupto o falta información
Recovery falla
Código existe en local pero no se pushea
Usuario tiene que hacer upload manual a git
```

**Fix propuesto**:
1. Cuando recovery falla por datos corruptos, escanear workspaces locales para trabajo no pusheado
2. Para cada team workspace, verificar:
   - ¿Hay commits locales no pusheados? (`git log origin/branch..HEAD`)
   - ¿Hay archivos modificados sin commit? (`git status`)
3. Si hay trabajo, intentar:
   - Auto-commit de cambios pendientes
   - Push a las branches correspondientes (story/epic branches)
4. Reportar al usuario qué se recuperó y qué branches tienen código

**Implementación sugerida**:
```typescript
async function emergencyGitRecovery(workspacePath: string): Promise<RecoveryReport> {
  // Scan all team directories
  const teams = fs.readdirSync(workspacePath).filter(d => d.startsWith('team-'));

  for (const team of teams) {
    // Check for uncommitted changes
    const status = git.status(teamPath);
    if (status.hasChanges) {
      git.add('.');
      git.commit('Emergency recovery: auto-commit pending changes');
    }

    // Check for unpushed commits
    const unpushed = git.log('origin/branch..HEAD');
    if (unpushed.length > 0) {
      git.push('origin', branch);
    }
  }
}
```

