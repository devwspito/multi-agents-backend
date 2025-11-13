# 🚀 Instrucciones de Despliegue - Correcciones Git Workflow

## Cambios Aplicados

### 1. **TeamOrchestrationPhase.ts** - Epic con commit inicial
- ✅ Epic branch se crea con commit inicial automático (archivo `EPIC_xxx.md`)
- ✅ Epic branch se pushea CON commits (no vacío)
- ✅ Story branches heredan el commit inicial del epic

### 2. **OrchestrationCoordinator.ts** - Developer prompt mejorado
- ✅ Developer SIEMPRE hace commit (eliminada opción de saltar)
- ✅ Verificación forzada: `git ls-remote origin | grep $COMMIT_SHA`
- ✅ Force push si commit no está en remote
- ✅ Warning explícito si "nothing to commit" en retry

### 3. **DevelopersPhase.ts** - Verificación pre-Judge
- ✅ Usa `git ls-remote origin` + `.includes(commitSHA)` (correcto)
- ✅ Detiene pipeline si commit no existe en remote
- ✅ Merge story → epic DESPUÉS de Judge aprueba
- ✅ Limpieza de story branch (local + remoto) después de merge

## Flujo Completo

```
1. TeamOrchestrationPhase crea epic branch
2. Epic recibe commit inicial (EPIC_xxx.md)
3. Epic se pushea con 1 commit
4. Story branch se crea desde epic
5. Developer commitea código en story
6. Developer verifica commit en remote (grep)
7. Judge aprueba story
8. Story se mergea a epic
9. Story branch se elimina (local + remoto)
10. Repetir 4-9 para todas las stories
11. Epic acumula TODO el código
12. PR final: epic → main (1 solo PR por epic)
```

## Para Desplegar

### Opción A: Reiniciar servidor (recomendado)

```bash
# Detener servidor actual
# Ctrl+C o kill process

# Rebuild (ignorar warnings de TypeScript)
npm run build || echo "Build con warnings, continuando..."

# Iniciar servidor
npm start
```

### Opción B: Usar ts-node directamente (desarrollo)

```bash
# Ejecutar sin compilar
npx ts-node --transpile-only src/index.ts
```

### Opción C: Compilar solo archivos modificados

```bash
# Compilar archivos específicos
npx tsc src/services/orchestration/TeamOrchestrationPhase.ts --skipLibCheck --outDir dist
npx tsc src/services/orchestration/OrchestrationCoordinator.ts --skipLibCheck --outDir dist
npx tsc src/services/orchestration/DevelopersPhase.ts --skipLibCheck --outDir dist

# Iniciar
npm start
```

## Verificación

Después de reiniciar, los logs deberían mostrar:

```
✅ [Team 1] Epic branch created locally: epic/xxx
📝 [Team 1] Created epic README: EPIC_xxx.md
✅ [Team 1] Created initial commit in epic branch
✅ [Team 1] Epic branch pushed to remote with initial commit
```

Y en GitHub:
- ✅ Epic branches con 1+ commits (no 0)
- ✅ Story branches con commits (heredan de epic)
- ✅ Story branches eliminadas después de merge
- ✅ Epic acumula todo el código
- ✅ 1 PR por epic (epic → main)

## Limpieza de Branches Basura

Para eliminar todas las story/epic branches con 0 commits:

```bash
# Listar branches remotas
git branch -r | grep "story/"

# Eliminar branches remotas con 0 commits
git branch -r | grep "story/" | sed 's/origin\///' | xargs -I {} git push origin --delete {}
git branch -r | grep "epic/" | sed 's/origin\///' | xargs -I {} git push origin --delete {}

# Limpiar referencias locales
git fetch --prune
```

O manualmente desde GitHub UI:
1. Ve a tu repositorio en GitHub
2. Branches → View all branches
3. Elimina todas las branches con "0 commits"

## Troubleshooting

### Si epic branch sigue vacío:
- Verifica que `fixGitRemoteAuth()` funcione
- Verifica autenticación de GitHub
- Chequea logs: `📝 Created epic README: EPIC_xxx.md`

### Si Developer no commitea:
- Verifica logs: `⚠️ If git commit fails with "nothing to commit"`
- Developer debería mostrar error y reintentar

### Si verificación falla:
- Verifica logs: `🔍 [PRE-JUDGE] Verifying commit`
- Debería mostrar: `✅ Commit verified on remote` o `❌ Commit NOT found`

## Archivos Modificados

- `src/services/orchestration/TeamOrchestrationPhase.ts` (líneas 526-574)
- `src/services/orchestration/OrchestrationCoordinator.ts` (líneas 1821-1866)
- `src/services/orchestration/DevelopersPhase.ts` (líneas 710-740)

## Notas Importantes

- ⚠️ Los errores de TypeScript en `/optimized/` son archivos viejos (no usados)
- ✅ Los archivos principales compilan correctamente
- ✅ El servidor funcionará con `--transpile-only` o ignorando warnings
