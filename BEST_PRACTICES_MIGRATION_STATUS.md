# ✅ Best Practices Migration - Status Report

**Fecha**: 2025-01-09
**Objetivo**: Migrar TODOS los agentes de JSON forzado a plain text markers (Anthropic SDK best practices)
**Progress**: 30% Completado

## 🎯 ¿Qué Hemos Logrado?

### ✅ 1. Infraestructura Core (COMPLETADO)

**Archivo**: `src/services/orchestration/utils/MarkerValidator.ts`

Creamos un utility centralizado para validación de markers robusta:

```typescript
// Tolerante a markdown formatting
hasMarker(output, '✅ TYPECHECK_PASSED')
// Funciona con:
// - "✅ TYPECHECK_PASSED"
// - "**✅ TYPECHECK_PASSED**"
// - "### ✅ TYPECHECK_PASSED"
// - "- ✅ TYPECHECK_PASSED"

// Extraer valores
extractMarkerValue(output, '📍 Commit SHA:')
// Returns: "abc123def456..."

// Validar múltiples markers
validateMarkers(output, [...markers])
// Returns: { allPresent, missing, present, results }
```

**Markers estandarizados**:
```typescript
export const COMMON_MARKERS = {
  // Development
  TYPECHECK_PASSED: '✅ TYPECHECK_PASSED',
  TESTS_PASSED: '✅ TESTS_PASSED',
  LINT_PASSED: '✅ LINT_PASSED',

  // Status
  SUCCESS: '✅ SUCCESS',
  FINISHED: '✅ FINISHED_SUCCESSFULLY',
  FAILED: '❌ FAILED',

  // Judge
  APPROVED: '✅ APPROVED',
  REJECTED: '❌ REJECTED',

  // Data
  COMMIT_SHA: '📍 Commit SHA:',
  EPIC_ID: '📍 Epic ID:',
  // ... etc
};
```

### ✅ 2. Developer Agent (COMPLETADO)

**Archivo**: `src/services/orchestration/AgentDefinitions.ts` (líneas 958-1048)

Developer agent YA TENÍA plain text markers (implementación iterativa):
- ✅ `TYPECHECK_PASSED`
- ✅ `TESTS_PASSED`
- ✅ `LINT_PASSED`
- ✅ `DEVELOPER_FINISHED_SUCCESSFULLY`
- 📍 `Commit SHA:`

**Validación**: `src/services/orchestration/DevelopersPhase.ts` (líneas 705-784)
- Usa `hasMarker()` centralizado
- Tolerante a markdown
- Extrae SHA con `extractMarkerValue()`

### ✅ 3. Problem Analyst Agent (COMPLETADO)

**Archivo**: `src/services/orchestration/AgentDefinitions.ts` (líneas 25-128)

**ANTES (JSON forzado)**:
```
## OUTPUT FORMAT (MANDATORY JSON)
Your ENTIRE response must be valid JSON:
```json
{
  "problemStatement": "...",
  "stakeholders": [...],
  ...
}
```
❌ NO text before or after JSON
```

**DESPUÉS (Plain text con markers)**:
```
## OUTPUT FORMAT (Plain Text with Markers)

⚠️ Following Anthropic SDK best practices, output natural language.
❌ DO NOT output JSON
✅ DO use markers to signal completion

**1. Problem Statement**
[Natural language]

**2. Stakeholders**
[List]

... [todas las secciones] ...

🔥 MANDATORY marker:
✅ ANALYSIS_COMPLETE
```

### ✅ 4. Product Manager Agent (COMPLETADO)

**Archivo**: `src/services/orchestration/AgentDefinitions.ts` (líneas 278-322)

**ANTES**: JSON estricto para Master Epic
**DESPUÉS**: Plain text estructurado

```
**Master Epic Overview**
Epic ID: epic-feature-timestamp
Title: Feature Name
Complexity: moderate
Repositories: backend, frontend

**Global Naming Conventions**:
- Primary ID: userId
- Timestamps: ISO8601
... etc

**Shared Contracts**:
API Endpoints:
POST /api/users
  Request: {email: string, password: string}
  Response: {userId: string, token: string}

Shared Types:
User
- userId: string
- email: string

... [continue] ...

📍 Epic ID: epic-feature-timestamp
✅ EPIC_DEFINED
```

### ✅ 5. Documentación (COMPLETADO)

**Archivos creados**:
1. `PLAIN_TEXT_VS_JSON.md` - Por qué plain text es mejor
2. `JSON_TO_MARKERS_MIGRATION.md` - Estrategia completa de migración
3. `DEVELOPER_OUTPUT_FIX.md` - Fix de markdown formatting
4. `BEST_PRACTICES_MIGRATION_STATUS.md` - Este documento

**Contenido clave**:
- Comparación plain text vs JSON
- Anthropic SDK best practices explained
- Templates de migración
- Estrategia por fases
- Markers estandarizados

---

## ⏳ ¿Qué Falta Por Hacer?

### 🔴 CRÍTICO - Agentes del Pipeline Principal

Estos agentes son CRÍTICOS para el flujo principal y DEBEN migrarse primero:

#### 1️⃣ **project-manager** (Crea stories)
- **Archivo**: `AgentDefinitions.ts` líneas ~365-483
- **Status**: ❌ AÚN FUERZA JSON
- **Output actual**: JSON con array de epics
- **Output deseado**: Plain text list de epics con markers
- **Marker requerido**: `✅ STORIES_CREATED`

**Ejemplo de output deseado**:
```
## Stories for Epic: epic-user-auth

Story 1: Setup User Database Model
ID: story-001
Branch: story/001-user-db-setup
Repository: backend
Files to modify:
- backend/src/models/User.ts
- backend/src/database/migrations/001-users.ts
Dependencies: none
Complexity: simple

Story 2: Implement Registration Endpoint
ID: story-002
Branch: story/002-registration-endpoint
Repository: backend
Files to modify:
- backend/src/routes/auth.ts
- backend/src/controllers/authController.ts
Dependencies: story-001
Complexity: moderate

... [all stories] ...

📍 Total Stories: 5
📍 Epic ID: epic-user-auth
✅ STORIES_CREATED
```

#### 2️⃣ **judge** (Code review)
- **Archivo**: `AgentDefinitions.ts` líneas ~1200-1400 (aprox)
- **Status**: ❌ AÚN FUERZA JSON
- **Output actual**: JSON con `{ approved: true/false, feedback: "..." }`
- **Output deseado**: Plain text review con `✅ APPROVED` o `❌ REJECTED`
- **Markers**: `✅ APPROVED` | `❌ REJECTED` + `📍 Reason:`

**Ejemplo de output deseado**:
```
## Code Review for story-001

**Quality Assessment**:
- Code structure: Excellent
- Error handling: Present and robust
- Test coverage: 85% (good)
- Security: Proper validation

**Findings**:
✅ All requirements met
✅ Follows codebase conventions
✅ No security vulnerabilities
✅ Good test coverage

**Verdict**: Code is production-ready

✅ APPROVED
```

O si hay problemas:
```
## Code Review for story-002

**Quality Assessment**:
- Code structure: Good
- Error handling: Missing in edge cases
- Test coverage: 45% (insufficient)

**Critical Issues**:
1. Missing password strength validation
2. No rate limiting on endpoint
3. Test coverage below 80% threshold

**Required Changes**:
- Add password validation (min 8 chars, special char)
- Implement rate limiting middleware
- Add tests for edge cases

❌ REJECTED
📍 Reason: Security vulnerabilities and insufficient tests
```

#### 3️⃣ **qa-engineer** (Testing)
- **Archivo**: `AgentDefinitions.ts` líneas ~1400-1600 (aprox)
- **Status**: ❌ AÚN FUERZA JSON
- **Output actual**: JSON con test results
- **Output deseado**: Plain text test report con markers
- **Markers**: `✅ QA_PASSED` | `❌ QA_FAILED`

#### 4️⃣ **tech-lead** (Architecture)
- **Archivo**: `AgentDefinitions.ts` líneas ~600-800 (aprox)
- **Status**: ❌ AÚN FUERZA JSON
- **Output actual**: JSON con epic breakdown
- **Output deseado**: Plain text architecture + stories
- **Marker**: `✅ ARCHITECTURE_COMPLETE`

### 🟡 MEDIO - Agentes Secundarios

Estos agentes son importantes pero no bloqueantes:

5. **fixer** - Bug fixes
6. **error-detective** - Error analysis
7. **contract-tester** - Contract validation
8. **test-creator** - Test generation
9. **recovery-analyst** - Failure recovery
10. **merge-coordinator** - PR management
11. **contract-fixer** - Contract fixes

### 🔵 BAJO - Phase Validations

Después de migrar los prompts, actualizar las validaciones:

1. ✅ **DevelopersPhase** - DONE
2. ❌ **ProductManagerPhase** - Parse epic output (buscar JSON.parse)
3. ❌ **ProjectManagerPhase** - Parse stories output
4. ❌ **JudgePhase** - Parse approval/rejection
5. ❌ **QAPhase** - Parse test results
6. ❌ **TechLeadPhase** - Parse architecture
7. ❌ **FixerPhase** - Parse fix status
8. ❌ Etc.

---

## 📋 Plan de Acción Recomendado

### Opción A: Manual (3-4 horas, MÁS CONTROL)

1. **Migrar agentes críticos uno por uno** (2 horas)
   - project-manager
   - judge
   - qa-engineer
   - tech-lead

2. **Actualizar Phase validations** (1 hora)
   - ProductManagerPhase
   - ProjectManagerPhase
   - JudgePhase
   - QAPhase

3. **Migrar agentes secundarios en batch** (30 mins)
   - fixer, error-detective, contract-tester, etc.
   - Usar mismo template para todos

4. **Testing completo** (30 mins)
   - Run build
   - Test con task real
   - Verificar logs

### Opción B: Semi-Automático (1-2 horas, MÁS RÁPIDO)

1. **Crear script de reemplazo**:
   ```bash
   # Buscar todas las secciones "OUTPUT FORMAT (MANDATORY JSON)"
   # Reemplazar con template estándar de plain text
   ```

2. **Definir templates por tipo de agente**:
   - Analysis agents (problem-analyst, tech-lead)
   - Creation agents (product-manager, project-manager)
   - Evaluation agents (judge, qa-engineer)
   - Fix agents (fixer, error-detective)

3. **Aplicar batch update**
4. **Actualizar Phase validations**
5. **Fix errors + test**

### Opción C: Incremental (RECOMENDADO para producción)

1. **Fase 1**: Migrar solo developer + judge (pipeline mínimo)
2. **Deploy y test en staging**
3. **Fase 2**: Migrar product-manager + project-manager
4. **Deploy y test**
5. **Fase 3**: Migrar resto de agentes
6. **Deploy final**

---

## 🔍 Cómo Identificar Qué Cambiar en Cada Fase

### En `AgentDefinitions.ts`:

**Buscar**:
```bash
grep -n "MANDATORY JSON\|ENTIRE RESPONSE MUST BE VALID JSON" src/services/orchestration/AgentDefinitions.ts
```

**Reemplazar**:
1. Quitar "YOUR ENTIRE RESPONSE MUST BE VALID JSON"
2. Quitar "❌ NO text before/after JSON"
3. Quitar ejemplos JSON (`\`\`\`json ... \`\`\``)
4. Agregar "## OUTPUT FORMAT (Plain Text with Markers)"
5. Agregar secciones estructuradas en texto
6. Agregar marker de completion: `✅ [AGENT]_COMPLETE`

### En `*Phase.ts`:

**Buscar**:
```bash
grep -rn "JSON.parse\|JSON.stringify" src/services/orchestration/*Phase.ts
```

**Reemplazar**:
1. Importar `hasMarker`, `extractMarkerValue`, `COMMON_MARKERS`
2. Reemplazar `JSON.parse()` con `hasMarker()` checks
3. Extraer valores específicos con `extractMarkerValue()`
4. Usar validación flexible (intención, no formato exacto)

---

## ✅ Checklist Final

Cuando hayas completado todo, verifica:

- [ ] Todos los agentes usan plain text (no JSON forzado)
- [ ] Todas las phases usan `MarkerValidator`
- [ ] Build pasa sin errores (`npm run build`)
- [ ] Test con task real funciona end-to-end
- [ ] Logs muestran markers siendo detectados
- [ ] No hay JSON.parse() en ninguna Phase
- [ ] Documentación actualizada
- [ ] Commit final con mensaje descriptivo

---

## 📊 Resumen del Estado Actual

**Progreso Total**: 30%

| Componente | Status | Completado |
|------------|--------|------------|
| **Infrastructure** | ✅ | 100% |
| MarkerValidator utility | ✅ | Done |
| Common markers defined | ✅ | Done |
| **Agent Prompts** | ⏳ | 3/14 (21%) |
| problem-analyst | ✅ | Done |
| product-manager | ✅ | Done |
| developer | ✅ | Done |
| project-manager | ❌ | TODO |
| judge | ❌ | TODO |
| qa-engineer | ❌ | TODO |
| tech-lead | ❌ | TODO |
| fixer | ❌ | TODO |
| Others (7 agents) | ❌ | TODO |
| **Phase Validations** | ⏳ | 1/10 (10%) |
| DevelopersPhase | ✅ | Done |
| ProductManagerPhase | ❌ | TODO |
| ProjectManagerPhase | ❌ | TODO |
| JudgePhase | ❌ | TODO |
| QAPhase | ❌ | TODO |
| Others (6 phases) | ❌ | TODO |
| **Testing** | ❌ | 0% |
| Build passes | ✅ | Yes |
| Real task test | ❌ | TODO |
| **Documentation** | ✅ | 100% |

---

## 🚀 Próximos Pasos Inmediatos

1. **Decidir approach** (Manual, Semi-auto, o Incremental)
2. **Empezar con judge** (crítico para pipeline)
3. **Continuar con project-manager** (crea stories)
4. **Actualizar JudgePhase validation**
5. **Test end-to-end**
6. **Iterar**

---

**Implementado Por**: Claude (Sonnet 4.5)
**Fecha**: 2025-01-09
**Status**: 🚧 30% COMPLETADO - LISTO PARA CONTINUAR
**Commit**: 858f749
