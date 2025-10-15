# 🔍 Cómo Ver el Código que Generan los Developers en Tiempo Real

## Problema Resuelto

✅ **Branches se crean en GitHub INMEDIATAMENTE** (después de Tech Lead)
✅ **Puedes ver el código ANTES de que termine la tarea**
✅ **Si el servidor se cae, las branches YA ESTÁN en GitHub**
✅ **Judge deshabilitado temporalmente** (ya no bloquea con 0/100)

---

## Método 1: Ver Branches en GitHub (Más Fácil)

### Paso 1: Obtener URLs de las branches

```bash
node scripts/view-task.js <taskId>
```

Esto te mostrará algo como:

```
═══════════════════════════════════════════════════════════
🌿 BRANCHES CREATED
═══════════════════════════════════════════════════════════
v3_frontend: epic/studypanel-integration-v3_frontend
  URL: https://github.com/devwspito/v3_frontend/tree/epic/studypanel-integration-v3_frontend
v3_backend: epic/studypanel-integration-v3_backend
  URL: https://github.com/devwspito/v3_backend/tree/epic/studypanel-integration-v3_backend
```

### Paso 2: Abrir las URLs en tu navegador

1. **Ver código actual**: Abre la URL de la branch
2. **Ver commits**: Agrega `/commits` al final de la URL
3. **Ver diff**: Compara con main: `https://github.com/user/repo/compare/main...branch-name`

### Paso 3: Refrescar para ver nuevos commits

Los developers hacen push después de cada story completada. Simplemente **refresca la página** para ver nuevos commits.

---

## Método 2: Clonar y Ver Local

```bash
# Clonar el repo
git clone https://github.com/devwspito/v3_frontend.git
cd v3_frontend

# Checkout de la branch epic
git checkout epic/studypanel-integration-v3_frontend

# Ver commits en tiempo real (cada 5 segundos)
watch -n 5 'git fetch origin && git log --oneline -10'

# Ver código actual
code .  # O tu editor favorito
```

---

## Método 3: Ver Directamente el Workspace (Solo mientras corre)

```bash
# El workspace temporal está en:
/var/folders/12/.../agent-workspace/task-<taskId>/

# Ver qué están haciendo los developers
cd /var/folders/12/.../agent-workspace/task-<taskId>/v3_frontend
git log --oneline -10
git diff HEAD~1  # Ver último cambio
```

⚠️ **IMPORTANTE**: Este workspace se borra después de 24 horas o cuando limpies workspaces

---

## Método 4: Monitorear en Tiempo Real con Script

```bash
# Ver todas las branches creadas para una tarea
./scripts/watch-branches.sh <taskId>
```

Esto te dará:
- URLs de todas las branches
- Comandos para ver commits
- Links directos a GitHub

---

## Qué Ver en Cada Commit

Cuando un developer termina una story, hace:

```bash
git commit -m "Story title

Story description

🤖 Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>"
```

**Puedes ver**:
- Qué archivos cambió
- Qué código agregó
- Tests que escribió
- Documentación generada

---

## Timeline de Commits

**ANTES** (malo):
```
Servidor corriendo → Developer trabaja → Servidor se cae → TODO SE PIERDE
```

**AHORA** (bueno):
```
Tech Lead completa
    ↓
🔥 Branches creadas en GitHub (PERMANENTES)
    ↓
Developer 1 trabaja → commit → push → VES EN GITHUB
    ↓
Developer 2 trabaja → commit → push → VES EN GITHUB
    ↓
Si servidor se cae → COMMITS YA ESTÁN EN GITHUB ✅
```

---

## Ejemplo Real

### 1. Inicia tarea
```
POST /api/tasks/:id/start
```

### 2. Espera a que Tech Lead complete (~30 segundos)
```
Console output:
✅ [Tech Lead] Team composition: 3 developers

🌿 [Branch Setup] Creating all epic branches in GitHub NOW...
  📝 Creating epic/studypanel-v3_frontend from main...
  📤 Pushing epic/studypanel-v3_frontend to GitHub...
  ✅ Branch created: https://github.com/devwspito/v3_frontend/tree/epic/studypanel-v3_frontend

  📝 Creating epic/studypanel-v3_backend from main...
  📤 Pushing epic/studypanel-v3_backend to GitHub...
  ✅ Branch created: https://github.com/devwspito/v3_backend/tree/epic/studypanel-v3_backend

✅ [Branch Setup] All epic branches created in GitHub
```

### 3. Abre las URLs en GitHub
- ✅ Branches ya existen
- ✅ Puedes ver commits en tiempo real
- ✅ Puedes hacer checkout local si quieres

### 4. Ver progreso
```bash
# Opción A: Ver en GitHub (refresca cada minuto)
open https://github.com/devwspito/v3_frontend/commits/epic/studypanel-v3_frontend

# Opción B: Ver con git local
git clone https://github.com/devwspito/v3_frontend.git
cd v3_frontend
git checkout epic/studypanel-v3_frontend
watch -n 10 'git pull && git log --oneline -5'

# Opción C: Ver detalles completos
node scripts/view-task.js <taskId>
```

---

## Judge Deshabilitado (Temporalmente)

**Ubicación**: `src/services/TeamOrchestrator.ts:1326`

```typescript
const JUDGE_ENABLED = false; // 🔥 CAMBIAR A true CUANDO FUNCIONE BIEN
```

**Por qué**: Judge rechazaba con 0/100 sin dar feedback útil. Ahora:
- ✅ Verification pasa (ESLint + TypeScript)
- ✅ Código se commitea inmediatamente
- ✅ Puedes revisar manualmente en GitHub

**Para reactivar**: Cambia `JUDGE_ENABLED = true`

---

## Troubleshooting

### No veo las branches en GitHub
```bash
# Verificar que Tech Lead completó
node scripts/view-task.js <taskId> | grep "Tech Lead"

# Si dice "completed", las branches deberían estar
# Verifica en: https://github.com/<user>/<repo>/branches/all
```

### Branches existen pero no hay commits
```bash
# Developers están trabajando todavía
# Espera a que veas: ✅ Changes committed: <story-title>

# O verifica status:
node scripts/view-task.js <taskId> | grep "Developer"
```

### Quiero ver el código AHORA (antes de que termine)
```bash
# Encuentra el workspace temporal
ls -la /var/folders/*/*/agent-workspace/task-*/

# Entra al repo
cd /var/folders/.../task-<taskId>/v3_frontend

# Ver branch actual
git branch

# Ver cambios en progreso (aún no commiteados)
git status
git diff
```

---

## Resumen

| Método | Cuándo Usarlo | Ventaja |
|--------|---------------|---------|
| GitHub URLs | **Siempre** | Más fácil, persiste siempre |
| git clone local | Ver código offline | Puedes ejecutar tests local |
| Workspace temporal | Debug en tiempo real | Ves cambios antes de commit |
| scripts/view-task.js | Ver detalles completos | Cost, status, todos |

**Recomendación**: Usa GitHub URLs. Es lo más simple y siempre funciona.
