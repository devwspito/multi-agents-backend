# Plan: Developers Secuenciales con Pull del Epic

## Resumen Ejecutivo

**Problema:** Los developers trabajan en aislamiento (isolated), pero ejecutan secuencialmente. Esto causa que dev-2 no vea los cambios de dev-1, resultando en conflictos y reescritura de archivos.

**Solución:** Después de copiar el repo a workspace aislado, hacer `git pull origin <epic-branch>` para obtener los cambios de stories anteriores.

---

## Análisis del Bug

### Código Actual (Problemático)

**Archivo:** `src/services/orchestration/DevelopersPhase.ts`

**Línea 1131:** El repo se copia del SOURCE (original), no del epic con cambios.

```typescript
// Línea 1131 - PROBLEMA: Copia del SOURCE, no tiene cambios de stories anteriores
execSync(`cp -r "${sourceRepoPath}" "${isolatedRepoPath}"`, { encoding: 'utf8' });
```

### Por qué falla

1. `sourceRepoPath` = repo original clonado al inicio del task
2. Cada story copia ESTE mismo source
3. Story-2 copia el source SIN los cambios de story-1
4. Cuando story-2 toca el mismo archivo → CONFLICTO en merge

### Por qué el merge SÍ funciona (parcialmente)

El merge (líneas 3574-3581) sí hace pull del epic:

```typescript
// Líneas 3574-3581 - El merge SÍ hace pull, pero ya es tarde
const pullOutput = safeGitExecSync(`cd "${repoPath}" && git pull origin ${epicBranch}`, ...);
```

Pero esto es DURANTE el merge, cuando el story-2 ya reescribió los archivos de story-1.

---

## Flujo Actual vs Propuesto

### Flujo ACTUAL (Problemático)
```
story-1: cp -r SOURCE → trabajo → merge epic → push ✅
story-2: cp -r SOURCE → trabajo → merge epic → CONFLICTO! ❌
         ↑
         SOURCE no tiene cambios de story-1
```

### Flujo PROPUESTO
```
story-1: cp -r SOURCE → trabajo → merge epic → push ✅
story-2: cp -r SOURCE → git pull epic → trabajo → merge epic → push ✅
                        ↑
                        PULL trae cambios de story-1 del remote
```

---

## Mapa Completo de Cambios

### 🔴 Archivo Principal: `src/services/orchestration/DevelopersPhase.ts`

| Línea | Código Actual | Cambio Requerido |
|-------|--------------|------------------|
| 1131-1132 | `execSync(cp -r ...)` | Mantener, pero AGREGAR git pull después |
| 1133-1142 | Configura git remote | Mantener |
| **NUEVO** | N/A | **Agregar sync con epic branch después de línea 1142** |

### 🟢 Archivos que NO Necesitan Cambios

| Archivo | Razón |
|---------|-------|
| `mergeStoryToEpic()` (líneas 3568-3648) | Ya hace pull - está bien |
| `TeamOrchestrationPhase.ts` | No toca workspaces |
| `JudgePhase.ts` | Usa el workspace que recibe |
| `developers/stages/*` | Son stages internos, no tocan copy |

---

## Diff de Implementación

### Cambio Principal: Después de copiar repo (DevelopersPhase.ts:1142)

**Ubicación:** Después de `console.log('Git remote configured...')` en línea 1139

```diff
          try {
            const remoteUrl = execSync(`git -C "${sourceRepoPath}" remote get-url origin`, { encoding: 'utf8' }).trim();
            execSync(`git -C "${isolatedRepoPath}" remote set-url origin "${remoteUrl}"`, { encoding: 'utf8' });
            console.log(`   ✅ Git remote configured in isolated workspace`);
          } catch (remoteError: any) {
            console.warn(`   ⚠️ Could not set git remote: ${remoteError.message}`);
          }
+
+         // 🔥🔥🔥 SEQUENTIAL SYNC: Pull epic branch to get changes from previous stories 🔥🔥🔥
+         // This is CRITICAL for sequential execution - without this, story-2 won't see story-1's changes
+         const epicBranch = epic.branchName;
+         if (epicBranch) {
+           try {
+             console.log(`\n   🔄 [SEQUENTIAL SYNC] Syncing with epic branch: ${epicBranch}`);
+
+             // 1. Fetch latest from remote
+             execSync(`git -C "${isolatedRepoPath}" fetch origin`, { encoding: 'utf8', timeout: 60000 });
+             console.log(`   ✅ Fetched from origin`);
+
+             // 2. Checkout epic branch
+             execSync(`git -C "${isolatedRepoPath}" checkout ${epicBranch}`, { encoding: 'utf8' });
+             console.log(`   ✅ Checked out ${epicBranch}`);
+
+             // 3. Pull latest changes (this brings story-1's changes for story-2, etc.)
+             const pullOutput = execSync(`git -C "${isolatedRepoPath}" pull origin ${epicBranch}`, { encoding: 'utf8', timeout: 60000 });
+             console.log(`   ✅ Pulled latest from ${epicBranch}`);
+             if (pullOutput.includes('Already up to date')) {
+               console.log(`   ℹ️  No new changes from previous stories`);
+             } else {
+               console.log(`   📥 Received changes from previous stories:`);
+               console.log(`      ${pullOutput.substring(0, 200)}`);
+             }
+
+             console.log(`   🔄 [SEQUENTIAL SYNC] COMPLETE - workspace has all previous story changes\n`);
+           } catch (syncError: any) {
+             console.warn(`   ⚠️ [SEQUENTIAL SYNC] Could not sync with epic: ${syncError.message}`);
+             // Non-fatal: story can still work, but may have conflicts at merge time
+             if (syncError.message.includes('couldn\'t find remote ref')) {
+               console.log(`   ℹ️  Epic branch not on remote yet - this is likely story-1`);
+             }
+           }
+         }
        } else {
          console.log(`   ℹ️  Isolated workspace already exists`);
        }
```

---

## Código Completo del Cambio

### Función auxiliar (opcional, para limpieza)

```typescript
/**
 * Sync isolated workspace with epic branch from remote
 * This ensures sequential stories see changes from previous stories
 */
private async syncIsolatedWorkspaceWithEpic(
  isolatedRepoPath: string,
  epicBranch: string
): Promise<{ synced: boolean; changes: boolean; error?: string }> {
  try {
    console.log(`\n   🔄 [SEQUENTIAL SYNC] Syncing with epic branch: ${epicBranch}`);

    // 1. Fetch latest from remote
    execSync(`git -C "${isolatedRepoPath}" fetch origin`, { encoding: 'utf8', timeout: 60000 });

    // 2. Checkout epic branch (or create tracking branch if doesn't exist)
    try {
      execSync(`git -C "${isolatedRepoPath}" checkout ${epicBranch}`, { encoding: 'utf8' });
    } catch (checkoutError: any) {
      if (checkoutError.message.includes('did not match any file')) {
        // Branch doesn't exist locally, create from remote
        execSync(`git -C "${isolatedRepoPath}" checkout -b ${epicBranch} origin/${epicBranch}`, { encoding: 'utf8' });
      } else {
        throw checkoutError;
      }
    }

    // 3. Pull latest changes
    const pullOutput = execSync(`git -C "${isolatedRepoPath}" pull origin ${epicBranch}`, { encoding: 'utf8', timeout: 60000 });
    const hasChanges = !pullOutput.includes('Already up to date');

    console.log(`   ✅ [SEQUENTIAL SYNC] Complete - ${hasChanges ? 'received changes' : 'no new changes'}`);

    return { synced: true, changes: hasChanges };
  } catch (error: any) {
    console.warn(`   ⚠️ [SEQUENTIAL SYNC] Failed: ${error.message}`);
    return { synced: false, changes: false, error: error.message };
  }
}
```

---

## Diagrama de Flujo Final

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     TEAM ORCHESTRATION (Sequential)                      │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Story 1                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐│
│  │  cp -r   │ → │git pull  │ → │  dev-1   │ → │  merge   │ → │  push  ││
│  │  source  │   │ (no-op)  │   │  works   │   │ to epic  │   │ epic   ││
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └────────┘│
│                      ↑                                                   │
│              First story - no changes to pull                           │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Story 2                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐│
│  │  cp -r   │ → │git pull  │ → │  dev-2   │ → │  merge   │ → │  push  ││
│  │  source  │   │  EPIC!   │   │  works   │   │ to epic  │   │ epic   ││
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └────────┘│
│                      ↑                                                   │
│              🔥 PULL TRAE CAMBIOS DE STORY-1 🔥                          │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Story 3                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐│
│  │  cp -r   │ → │git pull  │ → │  dev-3   │ → │  merge   │ → │  push  ││
│  │  source  │   │  EPIC!   │   │  works   │   │ to epic  │   │ epic   ││
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘   └────────┘│
│                      ↑                                                   │
│        🔥 PULL TRAE CAMBIOS DE STORY-1 + STORY-2 🔥                      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Casos Edge

### 1. Story-1 (primer story)
- `git pull epic` hará "Already up to date" o fallará con "remote ref not found"
- **Manejo:** No fatal, simplemente continuar

### 2. Epic branch no existe en remote
- Puede pasar si TechLead no pusheó el epic branch
- **Manejo:** Log warning, continuar sin sync

### 3. Conflictos en pull
- Raro pero posible si hay cambios concurrentes
- **Manejo:** Abort el pull, dejar que el developer resuelva

### 4. 🔴 Story-N-1 FALLA → Story-N debe poder continuar

**Pregunta clave:** Si dev-1 falla, ¿dev-2 puede continuar?

**Respuesta: SÍ** - El comportamiento es idéntico a isolated mode:

```
Dev-1 FALLA:
├── mergeStoryToEpic() NO SE EJECUTA (líneas 3568-3648)
├── git push origin epic NO OCURRE
└── Epic branch NO tiene cambios de story-1

Dev-2 INICIA:
├── cp -r SOURCE → (mismo estado que isolated)
├── git pull epic → "Already up to date" o "remote ref not found"
│   └── Porque story-1 NUNCA se pusheó
├── Dev-2 trabaja normalmente
└── Resultado: Epic tiene story-2, no story-1 ✅
```

**Por qué funciona:**
1. El push a epic solo ocurre en `mergeStoryToEpic()` (línea 3634)
2. `mergeStoryToEpic()` solo se llama si el developer+judge terminan con éxito
3. Si story-1 falla, el push nunca ocurre
4. El `git pull` de story-2 no encuentra nada de story-1

**Verificación en código:**

```typescript
// DevelopersPhase.ts línea ~2450 - Merge solo si story exitosa
if (judgeResult.verdict === 'approved') {
  await this.mergeStoryToEpic(story, epic, workspacePath, repositories, taskId);
}
```

**Conclusión:** El sequential sync NO rompe la independencia de stories fallidas.
Story-N solo ve cambios de stories anteriores que fueron **EXITOSAS y PUSHEADAS**.

---

## Cambios en el Prompt del Developer

**Agregar instrucción clara en el prompt:**

```markdown
## Git Workflow

IMPORTANTE: Tu story branch YA está sincronizado con los últimos cambios del epic.
- NO necesitas hacer git pull del epic
- Trabaja directamente en tu story branch
- Al finalizar, tu código se mergeará automáticamente al epic

Si ves archivos que parecen de otras stories, ES CORRECTO - son cambios de developers anteriores.
```

---

## Checklist de Implementación

### Fase 1: Cambio Principal
- [ ] Abrir `src/services/orchestration/DevelopersPhase.ts`
- [ ] Localizar línea 1139-1142 (después de "Git remote configured")
- [ ] Agregar bloque de sync con epic branch
- [ ] Agregar logging claro para debugging

### Fase 2: Verificación
- [ ] Verificar que `execSync` tiene timeout adecuado
- [ ] Verificar manejo de error cuando epic branch no existe
- [ ] Verificar que no rompe story-1 (primer story)

### Fase 3: Testing
- [ ] Ejecutar task con 2 stories que tocan el mismo archivo
- [ ] Verificar que story-2 ve cambios de story-1
- [ ] Verificar que merge no tiene conflictos
- [ ] Verificar logs muestran "SEQUENTIAL SYNC"

### Fase 4: Cleanup
- [ ] Actualizar prompt del developer si es necesario
- [ ] Considerar extraer a función auxiliar para limpieza

---

## Rollback Plan

Si hay problemas, comentar el bloque de SEQUENTIAL SYNC:

```typescript
// 🔥🔥🔥 SEQUENTIAL SYNC: DISABLED FOR ROLLBACK 🔥🔥🔥
// const epicBranch = epic.branchName;
// if (epicBranch) { ... }
```

El flujo volverá a isolated mode (puede tener conflictos pero no rompe).

---

## Archivos Tocados (Resumen)

| Archivo | Líneas | LOC Agregadas | Impacto |
|---------|--------|---------------|---------|
| `DevelopersPhase.ts` | 1139-1142 | ~35 líneas | Alto |
| Ningún otro archivo | - | - | - |

---

## Dependencias

- **Requiere:** Push de story-N-1 antes de que story-N empiece su pull
- **Ya implementado:** El merge hace push (línea 3634)
- **Verificado:** Stories se ejecutan secuencialmente, no en paralelo

---

**Fecha de creación:** 2026-01-22
**Fecha de actualización:** 2026-01-22 (exploración completa)
**Estado:** Pendiente de implementación
**Prioridad:** Alta (bloquea ejecuciones multi-story)
**Complejidad:** Baja - Un solo punto de cambio, ~35 líneas
**Riesgo:** Bajo - El pull es no destructivo, worst case = "Already up to date"
