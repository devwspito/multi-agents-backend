# 🎯 Final Migration Guide - Complete in 30 Minutes

**Status Actual**: 4/14 agents migrated (29%)
**Tiempo Estimado Restante**: 30 minutos
**Commits**: 2 commits hechos (858f749, 4a61835)

## ✅ Lo Que YA Está HECHO

### Infrastructure (100%)
- ✅ `MarkerValidator.ts` - Utility centralizado
- ✅ `COMMON_MARKERS` - Markers estandarizados
- ✅ `hasMarker()` - Tolerante a markdown
- ✅ `extractMarkerValue()` - Extrae datos
- ✅ `validateMarkers()` - Valida múltiples

### Agents Migrated (4/14 = 29%)
1. ✅ **problem-analyst** - `✅ ANALYSIS_COMPLETE`
2. ✅ **product-manager** - `✅ EPIC_DEFINED` + `📍 Epic ID:`
3. ✅ **developer** - `✅ DEVELOPER_FINISHED_SUCCESSFULLY` + all validation markers
4. ✅ **judge** - `✅ APPROVED` / `❌ REJECTED`

### Phase Validations (1/10 = 10%)
- ✅ **DevelopersPhase** - Usa `MarkerValidator`

### Documentation (100%)
- ✅ PLAIN_TEXT_VS_JSON.md
- ✅ JSON_TO_MARKERS_MIGRATION.md
- ✅ BEST_PRACTICES_MIGRATION_STATUS.md
- ✅ DEVELOPER_OUTPUT_FIX.md
- ✅ UNIVERSAL_OUTPUT_TEMPLATE.md
- ✅ GIT_PUSH_FIX.md

## ⏳ Lo Que FALTA (70%)

### 10 Agents Pendientes

**Lines con "YOUR ENTIRE RESPONSE MUST BE VALID JSON":**
- Line 493: **project-manager** (creates stories)
- Line 959: **tech-lead** (architecture)
- Line 1364: **fixer** (bug fixes)
- Line 1964: **qa-engineer** (testing)
- Line 2044: **contract-tester**
- Line 2239: **test-creator**
- Line 2336: **contract-fixer**
- Line 2439: **recovery-analyst**
- Line 2602: **error-detective** / **merge-coordinator** (need to verify)

### 9 Phase Validations Pendientes

Files que usan `JSON.parse()`:
- `ProductManagerPhase.ts`
- `ProjectManagerPhase.ts`
- `JudgePhase.ts`
- `QAPhase.ts`
- `TechLeadPhase.ts`
- `FixerPhase.ts`
- + otros 3-4 más

## 🚀 Plan de Acción Rápido (30 mins)

### PASO 1: Migrar Agentes Restantes (20 mins)

Para CADA agente, hacer este reemplazo simple:

**BUSCAR** (pattern que se repite):
```
YOUR ENTIRE RESPONSE MUST BE VALID JSON AND NOTHING ELSE.

⛔ ABSOLUTELY FORBIDDEN:
❌ NO markdown headers...
❌ NO explanations before JSON...
...
🚨 REMINDER: Your FIRST character must be { and your LAST character must be }
```

**REEMPLAZAR CON**:
```
## OUTPUT FORMAT (Plain Text with Markers)

⚠️ IMPORTANT: Following Anthropic SDK best practices, communicate in natural language.
❌ DO NOT output JSON - agents think in text
✅ DO use clear sections and completion markers

Structure your response clearly and end with:
✅ [AGENT_NAME]_COMPLETE

See examples in other agents (problem-analyst, judge, developer).
```

**Markers específicos por agente**:
- `project-manager`: `✅ STORIES_CREATED` + `📍 Total Stories:`
- `tech-lead`: `✅ ARCHITECTURE_COMPLETE`
- `fixer`: `✅ FIX_APPLIED` + `✅ FIX_VERIFIED`
- `qa-engineer`: `✅ QA_PASSED` / `❌ QA_FAILED`
- `contract-tester`: `✅ CONTRACTS_VALIDATED`
- `test-creator`: `✅ TESTS_CREATED`
- `contract-fixer`: `✅ CONTRACTS_FIXED`
- `recovery-analyst`: `✅ RECOVERY_PLAN_READY`
- `error-detective`: `✅ ANALYSIS_COMPLETE`
- `merge-coordinator`: `✅ MERGE_COMPLETE`

### PASO 2: Actualizar Phase Validations (10 mins)

Para CADA Phase que usa `JSON.parse()`:

1. **Importar MarkerValidator**:
```typescript
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';
```

2. **Reemplazar JSON.parse() con hasMarker()**:

**ANTES**:
```typescript
try {
  const parsed = JSON.parse(output);
  if (parsed.approved) {
    // ...
  }
} catch (error) {
  console.error('Invalid JSON');
}
```

**DESPUÉS**:
```typescript
const approved = hasMarker(output, COMMON_MARKERS.APPROVED);
const rejected = hasMarker(output, COMMON_MARKERS.REJECTED);

if (approved) {
  // ...
} else if (rejected) {
  const reason = extractMarkerValue(output, '📍 Reason:');
  // ...
}
```

### PASO 3: Build + Test (5 mins)

```bash
# Build
npm run build

# Fix any errors

# Test (optional)
npm start
# Create a task and watch logs
```

## 📋 Checklist Rápido

### Agents
- [x] problem-analyst
- [x] product-manager
- [x] developer
- [x] judge
- [ ] project-manager (LINE 493)
- [ ] tech-lead (LINE 959)
- [ ] fixer (LINE 1364)
- [ ] qa-engineer (LINE 1964)
- [ ] contract-tester (LINE 2044)
- [ ] test-creator (LINE 2239)
- [ ] contract-fixer (LINE 2336)
- [ ] recovery-analyst (LINE 2439)
- [ ] error-detective (LINE 2602)
- [ ] merge-coordinator (verify if separate)

### Phase Validations
- [x] DevelopersPhase
- [ ] ProductManagerPhase
- [ ] ProjectManagerPhase
- [ ] JudgePhase
- [ ] QAPhase
- [ ] TechLeadPhase
- [ ] FixerPhase
- [ ] ContractTesterPhase
- [ ] TestCreatorPhase
- [ ] Others (find with grep)

## 🔍 Quick Commands

### Find JSON.parse usages
```bash
grep -rn "JSON.parse" src/services/orchestration/*Phase.ts
```

### Find JSON output sections
```bash
grep -n "YOUR ENTIRE RESPONSE MUST BE VALID JSON" src/services/orchestration/AgentDefinitions.ts
```

### Test build
```bash
npm run build
```

### Git status
```bash
git status --short
```

## ✅ Final Result

When all done:
- 14/14 agents use plain text markers
- 10/10 phases use MarkerValidator
- No `JSON.parse()` in phases
- No "YOUR ENTIRE RESPONSE MUST BE VALID JSON" in prompts
- Build passes
- All following Anthropic SDK best practices

## 📊 Progress Tracking

Update this as you go:

**Agents**: 4/14 (29%) → Target: 14/14 (100%)
**Phases**: 1/10 (10%) → Target: 10/10 (100%)
**Time Spent**: 1.5 hours → Target: 2 hours total
**Commits**: 2 → Target: 1 final commit

---

**Start Time**: [Fill in when you start]
**Target Completion**: 30 minutes from start
**Status**: 🚧 READY TO COMPLETE
