# Bugs Críticos a Solucionar

## Fecha: 2026-01-23
## Tarea afectada: 09fb1502f00abc4638c73758 (Flutter Foundation)

---

## Bug #1: Story-5 - Fixer NUNCA se llamó tras CHANGES_REQUESTED

### Síntomas
- Judge evaluó story-5 y dio veredicto: **CHANGES_REQUESTED**
- El flujo debería haber sido: Judge → Fixer → Judge (re-evaluación)
- Pero Fixer **NUNCA fue invocado**
- La historia quedó en estado incompleto

### Timeline observado
```
17:38:48 - Judge Review: epic-flutter-foundation-story-5
           Verdict: CHANGES_REQUESTED
           (Aquí debería haber llamado a Fixer, pero no lo hizo)
```

### Archivos a investigar
- `src/services/orchestration/DevelopersPhase.ts` - flujo después de Judge verdict
- `src/services/orchestration/JudgePhase.ts` - cómo maneja CHANGES_REQUESTED
- `src/services/orchestration/FixerPhase.ts` - cuándo se invoca

### Causa probable
1. La lógica que detecta CHANGES_REQUESTED y llama a Fixer puede estar fallando
2. O el flujo DIRECT-TO-JUDGE no tiene la lógica de retry con Fixer
3. O hay una condición de carrera que marca la story como completada antes de llamar a Fixer

### Solución propuesta
- Verificar que después de CHANGES_REQUESTED se invoque Fixer
- Si el problema es conflicto de git específicamente, considerar llamar a un agente de resolución de conflictos en vez de pasar a Developer

### Prioridad: 🔴 CRÍTICA

---

## Bug #2: Story-3 - Merge a epic NUNCA se ejecutó tras Fixer approval

### Síntomas
- Story-3 (routing) pasó por el ciclo completo: Developer → Judge (CHANGES_REQUESTED) → Fixer → Judge (APPROVED)
- El veredicto final fue **APPROVED** después de 3 intentos
- Pero el **merge al epic branch NUNCA ocurrió**
- El push a GitHub **NUNCA se ejecutó**

### Timeline observado
```
Story 3: Create AppRouter in lib/core/router/app_router.dart
  - Developer: Completed ✓
  - Judge: CHANGES_REQUESTED (Attempt 1/3)
  - Fixer: Applied fixes ✓
  - Judge: CHANGES_REQUESTED (Attempt 2/3)
  - Fixer: Applied fixes ✓
  - Judge: APPROVED (Final - Attempt 3/3) ✓
  - Merge to epic: ❌ NUNCA OCURRIÓ
  - Push to GitHub: ❌ NUNCA OCURRIÓ
```

### Evidencia en git
```bash
# Commit de story-3 existe:
879824f feat(router): extract routing configuration to AppRouter

# Pero SOLO está en su story branch remoto:
remotes/origin/story/25044f1f-create-approuter-in-lib-core-r-hlofm3

# Y NO está en el epic branch
```

### Archivos a investigar
- `src/services/orchestration/DevelopersPhase.ts` línea ~1494
  - El `mergeResult` de `executeMergeStage()` NO se verifica por `success`
  - El código procede a marcar la story como completada SIN verificar si el merge funcionó

### Código con bug (DevelopersPhase.ts:1491-1534)
```typescript
if (judgeResult.approved) {
  const mergeResult = await this.executeMergeStage(pipelineCtx, commitSHA);

  // ❌ BUG: mergeResult.success NUNCA se verifica!
  // Si el merge falla, el código continúa como si hubiera funcionado

  await eventStore.safeAppend({ eventType: 'StoryCompleted', ... });
  await unifiedMemoryService.markStoryCompleted(taskId, ...);

  return { ... }; // Retorna "éxito" aunque el merge falló
}
```

### Solución propuesta
```typescript
if (judgeResult.approved) {
  const mergeResult = await this.executeMergeStage(pipelineCtx, commitSHA);

  // ✅ FIX: Verificar que el merge fue exitoso
  if (!mergeResult.success) {
    console.error(`❌ Merge FAILED: ${mergeResult.error}`);
    // Opción A: Reintentar el merge
    // Opción B: Marcar story como "approved_but_not_merged" para intervención manual
    throw new Error(`Story approved but merge failed: ${mergeResult.error}`);
  }

  // Solo marcar como completada si el merge funcionó
  await eventStore.safeAppend({ eventType: 'StoryCompleted', ... });
}
```

### Prioridad: 🔴 CRÍTICA

---

## Bug #3: Preview Sandbox - Selección automática incorrecta + Sin selección manual

### Síntomas
- El preview automáticamente eligió **team-5** (código template) en vez de **team-1** (código real)
- No hay forma de seleccionar manualmente qué sandbox usar para preview
- El sistema tiene múltiples workspaces (team-1 a team-9) y elige mal

### Causa
- `SandboxPoolService.ts` no tiene lógica para seleccionar el workspace correcto
- O la API de preview no expone qué workspace está usando
- Falta endpoint/UI para selección manual

### Solución propuesta

#### Backend
1. Agregar endpoint para listar workspaces disponibles en un sandbox:
```typescript
GET /api/sandbox/:taskId/workspaces
// Returns: [{ path, name, hasPreviewServer, language }]
```

2. Agregar endpoint para cambiar workspace activo para preview:
```typescript
POST /api/sandbox/:taskId/set-preview-workspace
// Body: { workspacePath: "/workspace/team-1-..." }
```

3. Mejorar la selección automática:
- Priorizar workspaces con archivos modificados recientemente
- Priorizar workspaces con servidor de preview activo
- Si hay múltiples, usar el que tenga más código (no template)

#### Frontend (LivePreview.jsx)
1. Agregar selector de workspace en la UI
2. Mostrar qué workspace está activo para el preview
3. Permitir cambiar manualmente

### Prioridad: 🟡 MEDIA (workaround: reiniciar preview manualmente desde team-1)

---

## Bug #4: Merge conflicts en sandbox no se resuelven correctamente

### Síntomas
- 3 archivos tenían markers de merge conflict (`||||||| 2af279b`)
- Los archivos tenían código duplicado/corrupto al final
- El merge local en sandbox no se completó correctamente

### Archivos afectados
- `lib/core/config/environment.dart`
- `lib/core/di/injection_container.dart`
- `lib/core/di/modules/network_module.dart`

### Solución aplicada (manual)
```bash
# Eliminamos todo desde el marker hacia abajo
sed -i '/^||||||| 2af279b/,$d' <archivo>
```

### Solución propuesta para el sistema
1. Después de un merge, verificar que no queden conflict markers
2. Si hay conflictos, llamar a un agente de resolución de conflictos
3. O implementar resolución automática con reglas (preferir incoming changes)

### Prioridad: 🟡 MEDIA

---

## Acciones Inmediatas Requeridas

### 1. Push story-5 a GitHub
```bash
# Story-5 está en el epic branch local pero no pushed
cd /workspace/team-1-.../app-pasos-frontend-flutter
git push origin epic/38c73758-epic-flutter-foundation-iebw38
```

### 2. Merge y push story-3
```bash
# Story-3 nunca fue mergeada al epic
git fetch origin
git merge origin/story/25044f1f-create-approuter-in-lib-core-r-hlofm3
git push origin epic/38c73758-epic-flutter-foundation-iebw38
```

### 3. Verificar PR #9 en GitHub
- Después del push, PR #9 debería tener todos los stories
- Verificar que los archivos están correctos

---

## Resumen de Bugs por Severidad

| # | Bug | Severidad | Impacto |
|---|-----|-----------|---------|
| 1 | Fixer no se llama tras CHANGES_REQUESTED | 🔴 CRÍTICA | Stories quedan incompletas |
| 2 | Merge no se ejecuta tras approval | 🔴 CRÍTICA | Código aprobado se pierde, €200+ desperdiciados |
| 3 | Preview sandbox mal seleccionado | 🟡 MEDIA | UX malo, workaround existe |
| 4 | Merge conflicts no resueltos | 🟡 MEDIA | Archivos corruptos en sandbox |

---

## Archivos del Backend a Modificar

1. **`src/services/orchestration/DevelopersPhase.ts`**
   - Línea ~1494: Verificar `mergeResult.success`
   - Agregar lógica para llamar Fixer después de CHANGES_REQUESTED

2. **`src/services/orchestration/JudgePhase.ts`**
   - Verificar flujo de CHANGES_REQUESTED → Fixer

3. **`src/services/SandboxPoolService.ts`**
   - Agregar selección inteligente de workspace
   - Agregar método para cambiar workspace activo

4. **`src/routes/sandbox.ts`**
   - Agregar endpoint GET /workspaces
   - Agregar endpoint POST /set-preview-workspace

---

## Bug #5: 🔴 CRÍTICO - Código se copia a workspace equivocado

### Síntomas
- Story-3 fue desarrollada en `/workspace/team-1-.../story-epic-flutter-foundation-story-3/`
- Story-5 se desarrolló en `/workspace/team-1-.../story-epic-flutter-foundation-story-5/`
- El código de story-3 **NUNCA llegó** a story-5
- Story-5 intentó usar código que story-3 debería haber creado (router)
- El merge entre stories dentro del mismo epic **NO FUNCIONA**

### Evidencia
```bash
# Story-3 workspace tiene el router:
/workspace/team-1-.../story-epic-flutter-foundation-story-3/app-pasos-frontend-flutter/lib/core/router/
  - app_router.dart ✅
  - routes.dart ✅

# Story-5 workspace NO tiene el router:
/workspace/team-1-.../story-epic-flutter-foundation-story-5/app-pasos-frontend-flutter/lib/core/router/
  - (vacío) ❌

# El código NUNCA se propagó entre workspaces
```

### Causa raíz
1. Cada story tiene su PROPIO workspace clonado
2. Cuando story-3 termina, su código queda en `/story-3/` pero NO se mergea al epic branch
3. Cuando story-5 inicia, clona desde el epic branch que NO tiene story-3
4. **No hay mecanismo para sincronizar workspaces entre stories del mismo epic**

### Flujo actual (INCORRECTO):
```
Story-3 completa en /story-3/
  → Judge APRUEBA
  → Merge a epic (FALLA SILENCIOSAMENTE)
  → Story-5 inicia desde epic (SIN código de story-3)
```

### Flujo correcto (ESPERADO):
```
Story-3 completa en /story-3/
  → Judge APRUEBA
  → Merge a epic branch (VERIFICAR ÉXITO)
  → Push a GitHub (VERIFICAR ÉXITO)
  → Story-5 hace pull del epic actualizado
  → Story-5 continúa con código de story-3 incluido
```

### Solución propuesta

#### 1. Verificar merge success (ya documentado en Bug #2)
```typescript
const mergeResult = await this.executeMergeStage(...);
if (!mergeResult.success) {
  throw new Error('Merge failed, cannot continue');
}
```

#### 2. Forzar pull antes de iniciar nueva story
```typescript
// En DevelopersPhase, antes de ejecutar cada story:
await this.syncEpicBranchFromRemote(epicBranch);
```

#### 3. Verificar que story dependencies estén mergeadas
```typescript
// Si story-5 depende de story-3:
if (!this.isStoryMergedToEpic('story-3', epicBranch)) {
  throw new Error('Dependency story-3 not merged yet');
}
```

### Prioridad: 🔴 CRÍTICA - Causa pérdida total de trabajo

---

## Bug #6: 🔴 CRÍTICO - No hay credenciales de GitHub en sandbox

### Síntomas
- `git push` falla con "could not read Username"
- El código se queda en el sandbox local pero NUNCA llega a GitHub
- PR #9 no tiene las stories completas

### Evidencia
```bash
$ git push origin epic/38c73758-epic-flutter-foundation-iebw38
fatal: could not read Username for 'https://github.com': No such device or address
```

### Causa
- El sandbox Docker no tiene `gh` CLI instalado
- No hay credenciales de git configuradas
- El sistema asume que push funcionará pero no hay autenticación

### Solución propuesta

#### Opción A: Configurar credenciales en sandbox
```bash
# Al crear sandbox, configurar git credential helper
git config --global credential.helper store
echo "https://oauth2:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
```

#### Opción B: Usar GitHub API para push
```typescript
// En lugar de git push, usar GitHub API
await githubService.pushBranch(repoOwner, repoName, branchName, commitSha);
```

#### Opción C: Push desde host (fuera del sandbox)
```typescript
// Copiar .git desde sandbox al host y hacer push desde ahí
await sandboxService.exportGitRepo(taskId, repoPath);
await gitService.pushFromHost(repoPath, branchName);
```

### Prioridad: 🔴 CRÍTICA - Sin esto, TODO el código se pierde

---

## Bug #7: Judge aprueba código que NO compila

### Síntomas
- Judge aprobó story-3 con `createAppRouter()` function
- Pero story-3 importaba archivos que NO existían:
  - `../../features/auth/presentation/screens/login_screen.dart` ❌
  - `../../features/auth/presentation/screens/register_screen.dart` ❌
  - `../constants/app_constants.dart` ❌

### Evidencia
```dart
// app_router.dart aprobado por Judge:
import '../../features/auth/presentation/screens/login_screen.dart';  // NO EXISTE
import '../../features/auth/presentation/screens/register_screen.dart'; // NO EXISTE
import '../constants/app_constants.dart';  // NO EXISTE
```

### Causa
- Judge evalúa calidad de código pero NO verifica que compila
- No hay paso de `flutter analyze` o `flutter build` después de Judge approval
- El código puede tener imports a archivos que otros stories deberían crear

### Solución propuesta

#### 1. Agregar verificación de compilación post-Judge
```typescript
// Después de Judge APPROVED:
if (judgeResult.approved) {
  const compileResult = await this.verifyCompiles(language, workspacePath);
  if (!compileResult.success) {
    // No aprobar si no compila
    judgeResult.approved = false;
    judgeResult.feedback += '\n\nCode does not compile: ' + compileResult.errors;
  }
}
```

#### 2. Hacer imports condicionales o crear stubs
```dart
// En app_router.dart, usar try-catch imports o placeholders
// O crear stubs automáticamente para imports faltantes
```

### Prioridad: 🟡 MEDIA - El código "aprobado" puede fallar en runtime

---

## Bug #8: ✅ ADDRESSED - Developer crea PLACEHOLDERS en vez de código REAL

### Estado: ✅ ADDRESSED (2026-01-23)

### Cambios realizados (AgentDefinitions.ts):

1. **TechLead Prompt**: Added "NO PLACEHOLDERS" section with forbidden patterns
2. **Developer Prompt**: Added explicit "FUNCTIONAL CODE ONLY" rules with examples
3. **Judge Prompt**: Added "PLACEHOLDER CODE DETECTION" with auto-reject logic

```
Judge now scans for:
- "Coming Soon", "TODO:", "WIP", "Placeholder"
- _PlaceholderScreen, _PlaceholderWidget
- Empty containers without functional elements
- Buttons without onPressed handlers
```

---

### Síntomas
- El Developer escribió pantallas con "Coming Soon" en lugar de UI real
- Login screen no tiene campos de email/password
- Register screen no tiene formulario
- Router usa `_PlaceholderScreen` genérico
- **El usuario paga €200+ y recibe placeholders**

### Evidencia
```dart
// login_screen.dart - ❌ PLACEHOLDER
class LoginScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          children: [
            const Icon(Icons.login, size: 64),
            const Text('Login Screen - Coming Soon'),  // ❌ NO ES UI REAL
          ],
        ),
      ),
    );
  }
}

// app_router.dart - ❌ PLACEHOLDER
GoRoute(
  path: Routes.splash,
  builder: (context, state) => const _PlaceholderScreen(title: 'Splash'),  // ❌
),
```

### Lo que DEBERÍA haber creado
```dart
// login_screen.dart - ✅ REAL
class LoginScreen extends StatefulWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Form(
        child: Column(
          children: [
            TextFormField(decoration: InputDecoration(labelText: 'Email')),
            TextFormField(obscureText: true, decoration: InputDecoration(labelText: 'Password')),
            ElevatedButton(onPressed: _handleLogin, child: Text('Login')),
          ],
        ),
      ),
    );
  }
}
```

### Causa raíz
1. **Prompt del Developer insuficiente**: No especifica que debe crear UI funcional
2. **Judge no valida funcionalidad**: Solo revisa que compile, no que tenga UI real
3. **No hay criterios de aceptación claros**: Stories dicen "crear login screen" pero no definen qué debe tener
4. **Sin screenshots de referencia**: Developer no sabe cómo debe verse la UI

### Solución propuesta

#### 1. Mejorar prompt del Developer
```typescript
// En DeveloperPrompt.md agregar:
## UI Implementation Rules
- NEVER use placeholder text like "Coming Soon", "TODO", "WIP"
- EVERY screen MUST have functional UI elements:
  - Forms must have real input fields with validation
  - Buttons must have real onPressed handlers
  - Lists must show real data (or mock data)
- If you don't know how to implement something, ASK - don't placeholder
```

#### 2. Judge debe verificar UI real
```typescript
// En JudgePhase.ts, agregar verificación:
const hasPlaceholders = await this.checkForPlaceholders(files);
if (hasPlaceholders.found) {
  return {
    approved: false,
    feedback: `Code contains placeholder text: ${hasPlaceholders.locations.join(', ')}`,
  };
}

async checkForPlaceholders(files: string[]): Promise<{ found: boolean; locations: string[] }> {
  const placeholderPatterns = [
    /Coming Soon/i,
    /TODO/i,
    /PLACEHOLDER/i,
    /WIP/i,
    /_PlaceholderScreen/,
  ];
  // ... check files for these patterns
}
```

#### 3. Agregar acceptance criteria a stories
```typescript
// En ProjectManager, al crear stories:
story.acceptanceCriteria = [
  'Login form must have email field with validation',
  'Login form must have password field (obscured)',
  'Submit button must trigger authentication',
  'Error messages must display on invalid input',
];
```

### Prioridad: 🔴 CRÍTICA - Sin esto, el sistema produce código inútil

---

## Resumen ACTUALIZADO de Bugs por Severidad

| # | Bug | Severidad | Impacto |
|---|-----|-----------|---------|
| 8 | Developer crea placeholders, no código real | 🔴 CRÍTICA | Usuario paga y no recibe nada útil |
| 1 | Fixer no se llama tras CHANGES_REQUESTED | 🔴 CRÍTICA | Stories quedan incompletas |
| 2 | Merge no se ejecuta tras approval | 🔴 CRÍTICA | Código aprobado se pierde |
| 5 | Código se copia a workspace equivocado | 🔴 CRÍTICA | Stories no se sincronizan |
| 6 | Sin credenciales GitHub en sandbox | 🔴 CRÍTICA | Push nunca funciona |
| 3 | Preview sandbox mal seleccionado | 🟡 MEDIA | UX malo |
| 4 | Merge conflicts no resueltos | 🟡 MEDIA | Archivos corruptos |
| 7 | Judge aprueba código que no compila | 🟡 MEDIA | Runtime errors |

---

## Bug #9: ✅ ADDRESSED - Developer excede el SCOPE de su story

### Estado: ✅ ADDRESSED (2026-01-23)

### Cambios realizados (AgentDefinitions.ts):

1. **TechLead Prompt**: Added "STRICT SCOPE BOUNDARIES" section
   - Stories MUST define filesToRead, filesToModify, filesToCreate
   - Developer can ONLY touch files explicitly listed

2. **Developer Prompt**: Added "SCOPE BOUNDARY RULES" section
   - Explicit forbidden patterns
   - STUB import pattern for cross-epic dependencies

3. **Judge Prompt**: Added "SCOPE VIOLATION DETECTION" with auto-reject
   - Compares created files against story's filesToCreate
   - Auto-rejects if developer creates files outside scope

```
If story says filesToCreate: ["app_router.dart"]
And developer also creates: ["login_screen.dart"]
→ AUTO-REJECT: "login_screen.dart belongs to different epic"
```

---

### Síntomas
- Story-3 de Epic 1 decía: "Create routing setup with go_router"
- El Developer creó `login_screen.dart` y `register_screen.dart`
- Esas screens pertenecen a **Epic 4** (Authentication Feature), NO a Epic 1 (Foundation)
- El Developer "expandió" su scope y creó archivos que NO le correspondían

### Evidencia de la planificación
```
Epic 1: Flutter Project Foundation and Dependencies
  - Story 3: "Create routing setup with go_router" ← SOLO SETUP, no screens

Epic 4: Authentication Feature with Login, Register, and Password Recovery
  - ← AQUÍ es donde van login_screen.dart y register_screen.dart
```

### Archivos creados que NO debían existir en Epic 1
- `lib/features/auth/presentation/screens/login_screen.dart` - Pertenece a Epic 4
- `lib/features/auth/presentation/screens/register_screen.dart` - Pertenece a Epic 4
- `lib/features/auth/presentation/screens/password_recovery_screen.dart` - Pertenece a Epic 4

### Consecuencias
1. **Conflictos futuros**: Cuando Epic 4 se ejecute, encontrará archivos que ya existen
2. **Código placeholder**: Como no era su scope, creó placeholders "Coming Soon"
3. **Responsabilidad difusa**: No se sabe quién debe completar esas screens
4. **Desperdicio de trabajo**: Epic 4 puede reescribir lo que Epic 1 ya hizo

### Causa raíz
1. **Developer no respeta boundaries**: Ve "routing" y decide crear todas las screens que el router referencia
2. **Prompt no especifica límites**: No dice "ONLY create routing infrastructure, NOT the screens"
3. **Sin validación de scope**: No hay verificación de que los archivos creados estén dentro del scope de la story

### Solución propuesta

#### 1. Agregar scope boundaries al prompt del Developer
```markdown
## SCOPE RULES - CRITICAL
- You MUST ONLY create files that are EXPLICITLY mentioned in your story
- If your story says "Create routing setup", create ONLY router configuration
- Do NOT create screens, widgets, or other files outside your story scope
- If you need a file that doesn't exist, use a STUB import, don't create the file
- Example of STUB: `// import 'login_screen.dart'; // TODO: Will be created by another epic`
```

#### 2. Validar archivos creados vs scope
```typescript
// En DeveloperAgent, después de que termine:
const filesCreated = await this.getCreatedFiles(workspacePath);
const filesInScope = this.getExpectedFilesFromStory(story);

const outOfScopeFiles = filesCreated.filter(f => !this.isInScope(f, filesInScope));
if (outOfScopeFiles.length > 0) {
  console.warn(`⚠️ Developer created files outside scope: ${outOfScopeFiles}`);
  // Opción A: Rechazar y pedir que elimine
  // Opción B: Mover a "staging" para cuando el epic correcto se ejecute
}
```

#### 3. Judge debe verificar scope compliance
```typescript
// En JudgePhase:
const storyScope = extractScope(story.title + story.description);
const filesChanged = await getFilesModified(commitSha);

for (const file of filesChanged) {
  if (!isFileInScope(file, storyScope)) {
    return {
      approved: false,
      feedback: `File ${file} is outside story scope. This file should be created by a different epic.`,
    };
  }
}
```

### Prioridad: 🔴 CRÍTICA - Causa trabajo duplicado y conflictos entre epics

---

## Resumen ACTUALIZADO de Bugs por Severidad

| # | Bug | Severidad | Impacto |
|---|-----|-----------|---------|
| 8 | Developer crea placeholders, no código real | 🔴 CRÍTICA | Usuario paga y no recibe nada útil |
| 9 | Developer excede scope de su story | 🔴 CRÍTICA | Crea archivos de otros epics, causa conflictos |
| 1 | Fixer no se llama tras CHANGES_REQUESTED | 🔴 CRÍTICA | Stories quedan incompletas |
| 2 | Merge no se ejecuta tras approval | 🔴 CRÍTICA | Código aprobado se pierde |
| 5 | Código se copia a workspace equivocado | 🔴 CRÍTICA | Stories no se sincronizan |
| 6 | Sin credenciales GitHub en sandbox | 🔴 CRÍTICA | Push nunca funciona |
| 3 | Preview sandbox mal seleccionado | 🟡 MEDIA | UX malo |
| 4 | Merge conflicts no resueltos | 🟡 MEDIA | Archivos corruptos |
| 7 | Judge aprueba código que no compila | 🟡 MEDIA | Runtime errors |

---

## Bug #10: ✅ SOLUCIONADO - storyAssignments NO SE PASAN en multi-team mode

### Estado: ✅ FIXED (2026-01-23)

### Cambios realizados (TechLeadPhase.ts):

1. **Línea ~858-869**: TeamCompositionDefined event ahora incluye `epicId` y `storyAssignments`
```typescript
await eventStore.safeAppend({
  eventType: 'TeamCompositionDefined',
  payload: {
    ...parsed.teamComposition,
    epicId: teamEpic?.id || null,  // 🔥 FIX: Tag event with epicId
    storyAssignments: parsed.storyAssignments || [],  // 🔥 FIX: Include assignments
  },
});
```

2. **Línea ~1888-1900**: Recovery filtra TeamCompositionDefined por epicId en multi-team mode
```typescript
// 🔥 FIX Bug #10: In multi-team mode, find TeamCompositionDefined for THIS epic
if (multiTeamMode && teamEpic?.id) {
  teamEvent = events.find((e: any) =>
    e.eventType === 'TeamCompositionDefined' && e.payload?.epicId === teamEpic.id
  );
}
```

3. **Línea ~1927-1932**: Recovery extrae storyAssignments del evento
```typescript
if (teamEvent.payload.storyAssignments && !context.getData<any[]>('storyAssignments')) {
  context.setData('storyAssignments', teamEvent.payload.storyAssignments);
}
```

---

### Síntomas (ANTES del fix)
- TechLead crea `storyAssignments` correctamente
- PERO en multi-team mode, los developers reciben `[]` (array vacío)
- Los developers NO saben qué story implementar
- Tienen que "buscar" o "adivinar" qué hacer

### Evidencia

**TechLead generó esto (task.orchestration.techLead.storyAssignments):**
```json
[
  { "storyId": "epic-auth-ui-story-1", "assignedTo": "dev-1" },
  { "storyId": "epic-auth-ui-story-2", "assignedTo": "dev-2" },
  ...
]
```

**Pero los eventos muestran storyAssignments: 0:**
```json
{ "eventType": "TeamCompositionDefined", "storyAssignments": 0 }  // ❌ VACÍO
{ "eventType": "TeamCompositionDefined", "storyAssignments": 0 }  // ❌ VACÍO
```

### Causa raíz (3 problemas)

#### 1. Evento NO guarda storyAssignments (TechLeadPhase.ts:859-864)
```typescript
await eventStore.safeAppend({
  eventType: 'TeamCompositionDefined',
  payload: parsed.teamComposition,  // ❌ SOLO teamComposition
  // FALTA: parsed.storyAssignments
});
```

#### 2. TechLead se ejecuta UNA VEZ para TODO el task
- TechLead crea storyAssignments para UN solo epic (el último que analizó)
- Pero hay 9 epics, cada uno con sus propias stories
- Los otros 8 epics NO tienen storyAssignments

#### 3. Contexto se pierde entre equipos en multi-team mode
```typescript
// DevelopersPhase.ts:364-366
const assignments = multiTeamMode
  ? context.getData<any[]>('storyAssignments') || []  // ← Contexto está VACÍO
  : task.orchestration.techLead.storyAssignments || [];
```

### Flujo actual (INCORRECTO)

```
1. PlanningPhase → Crea 9 epics con stories
2. TechLeadPhase → Analiza TODOS los epics, crea assignments para EL ÚLTIMO
3. TeamOrchestration → Para CADA epic:
   a. Crea nuevo contexto (VACÍO)
   b. Ejecuta TechLeadPhase.shouldSkip() → skips porque ya ejecutó
   c. Ejecuta DevelopersPhase
   d. context.getData('storyAssignments') → [] (VACÍO)
   e. Developers sin assignments → "buscan" qué hacer
```

### Flujo correcto (ESPERADO)

```
1. PlanningPhase → Crea 9 epics con stories
2. Para CADA epic:
   a. TechLeadPhase ejecuta PARA ESE EPIC
   b. Crea storyAssignments específicos para ese epic
   c. Guarda en evento Y en contexto
   d. DevelopersPhase lee assignments de ESE epic
   e. Cada developer sabe EXACTAMENTE qué story implementar
```

### Solución propuesta

#### Opción A: TechLead por Epic (mejor, más control)
```typescript
// En TeamOrchestrationPhase.ts, antes de DevelopersPhase:
// Ejecutar TechLead para ESTE epic específico
const techLeadResult = await techLeadPhase.executeForEpic(context, epic);
context.setData('storyAssignments', techLeadResult.storyAssignments);
```

#### Opción B: Guardar ALL assignments en evento (más simple)
```typescript
// TechLeadPhase.ts:859-864 - INCLUIR storyAssignments
await eventStore.safeAppend({
  eventType: 'TeamCompositionDefined',
  payload: {
    ...parsed.teamComposition,
    storyAssignments: parsed.storyAssignments,  // ✅ INCLUIR
  },
});
```

#### Opción C: Usar UnifiedMemory (ya existe intento, pero no funciona)
```typescript
// Asegurar que UnifiedMemory guarde storyAssignments POR EPIC
await unifiedMemoryService.saveStoryAssignments(taskId, epicId, assignments);
```

### Prioridad: 🔴 CRÍTICA - Sin esto, TODO el sistema de asignaciones falla

---

## Resumen ACTUALIZADO de Bugs por Severidad

| # | Bug | Severidad | Impacto |
|---|-----|-----------|---------|
| 10 | ✅ storyAssignments no se pasan en multi-team | ✅ FIXED | Developers sin instrucciones claras |
| 8 | ✅ Developer crea placeholders, no código real | ✅ ADDRESSED | Usuario paga y no recibe nada útil |
| 9 | ✅ Developer excede scope de su story | ✅ ADDRESSED | Crea archivos de otros epics, causa conflictos |
| 1 | Fixer no se llama tras CHANGES_REQUESTED | 🔴 CRÍTICA | Stories quedan incompletas |
| 2 | Merge no se ejecuta tras approval | 🔴 CRÍTICA | Código aprobado se pierde |
| 5 | Código se copia a workspace equivocado | 🔴 CRÍTICA | Stories no se sincronizan |
| 6 | Sin credenciales GitHub en sandbox | 🔴 CRÍTICA | Push nunca funciona |
| 3 | Preview sandbox mal seleccionado | 🟡 MEDIA | UX malo |
| 4 | Merge conflicts no resueltos | 🟡 MEDIA | Archivos corruptos |
| 7 | Judge aprueba código que no compila | 🟡 MEDIA | Runtime errors |

---

---

## 🔧 ARQUITECTURA REQUERIDA: Flujo de Judge con Especialistas

### Principio clave
El Judge puede rechazar por DOS razones diferentes que requieren diferentes respuestas:

### 1️⃣ Si Judge rechaza por CONFLICTOS DE GIT
```
Judge: CHANGES_REQUESTED (reason: merge conflicts)
    ↓
ConflictResolver Specialist (NO Developer)
    ↓
Judge RE-EVALÚA
    ↓
Si APPROVED:
  → Actualizar evento StoryCompleted
  → Commit final
  → Push a GitHub
  → Merge a epic branch
```

### 2️⃣ Si Judge rechaza por CÓDIGO (bugs, calidad, etc.)
```
Judge: CHANGES_REQUESTED (reason: code issues)
    ↓
Fixer Agent (ciclo normal de retry)
    ↓
Judge RE-EVALÚA
    ↓
(mismo flujo de approval)
```

### Flujo completo esperado
```
Developer completa story
    ↓
Judge evalúa
    ↓
┌─── APPROVED ───────────────────────────────────┐
│  → StoryCompleted event                        │
│  → Commit                                      │
│  → Push to GitHub                              │
│  → Merge to epic branch                        │
└────────────────────────────────────────────────┘
    ↓
┌─── CHANGES_REQUESTED ──────────────────────────┐
│  ¿Por qué?                                     │
│  ├─ Conflictos Git → ConflictResolver          │
│  ├─ Código malo → Fixer                        │
│  └─ Cualquier otro → Developer retry           │
│                                                │
│  Después del fix:                              │
│  → Judge RE-EVALÚA (obligatorio)               │
│  → Si aprueba: commit + push + merge           │
│  → Si rechaza: otro ciclo de fix               │
└────────────────────────────────────────────────┘
```

### Archivos a modificar para implementar esto
1. `DevelopersPhase.ts` - Detectar tipo de rechazo y llamar especialista correcto
2. `JudgePhase.ts` - Incluir `rejectReason` en el veredicto (conflicts vs code vs other)
3. **CREAR**: `ConflictResolverPhase.ts` - Especialista en merge conflicts

---

## Orden de Prioridad para Fixes

1. ~~**Bug #10**: storyAssignments no se pasan → developers "buscan" qué hacer (LA RAÍZ DEL PROBLEMA)~~ ✅ FIXED
2. ~~**Bug #8**: Developer crea placeholders → código inútil~~ ✅ ADDRESSED (TechLead + Developer + Judge prompts updated)
3. ~~**Bug #9**: Developer excede scope → conflictos entre epics~~ ✅ ADDRESSED (SCOPE BOUNDARY rules added)
4. **Bug #6**: Sin credenciales → NADA se sube a GitHub
5. **Bug #2**: Merge falla silenciosamente → código se pierde
6. **Bug #5**: Workspaces no se sincronizan → stories se pisan
7. **Bug #1**: Fixer no se llama → stories incompletas
8. **Bug #7**: Judge no verifica compilación
9. **Bug #4**: Merge conflicts no resueltos
10. **Bug #3**: Preview workspace mal seleccionado
