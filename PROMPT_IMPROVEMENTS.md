# 🎯 Prompt Improvements - Critical Analysis

**Fecha**: 2025-01-09
**Contexto**: Análisis de prompts actuales para identificar mejoras críticas basadas en problemas reales observados

---

## 🔥 Problemas Críticos Identificados

### 1. **Developer NO Ejecuta Verificaciones** (RESUELTO PARCIALMENTE)

**Problema Observado**:
```
📊 Log Real:
❌ TYPECHECK_PASSED: ❌
❌ TESTS_PASSED: ❌
❌ LINT_PASSED: ❌
✅ Commit SHA: a577e1e4... (commit exitoso)
❌ DEVELOPER_FINISHED_SUCCESSFULLY: ❌
```

Developer:
- ✅ Lee archivos correctamente
- ✅ Implementa código
- ✅ Hace commit y push
- ❌ **NO ejecuta npm run typecheck/test/lint**
- ❌ **NO outputea markers**

**Causa Raíz**:
- Prompt tiene instrucciones CLARAS pero están al final
- Sonnet 4.5 está "tomando atajos" y no lee hasta el final
- El agent prioriza "terminar rápido" sobre "seguir proceso completo"

**Solución Implementada** ✅:
```typescript
prompt: `🚨🚨🚨 CRITICAL: YOU MUST OUTPUT THESE 5 MARKERS OR YOUR WORK IS REJECTED:
1. ✅ TYPECHECK_PASSED
2. ✅ TESTS_PASSED
3. ✅ LINT_PASSED
4. 📍 Commit SHA: [SHA]
5. ✅ DEVELOPER_FINISHED_SUCCESSFULLY

WITHOUT ALL 5 MARKERS, JUDGE WILL IMMEDIATELY REJECT YOUR WORK - NO EXCEPTIONS.
```

Movimos el WARNING al **principio absoluto** del prompt.

**Resultado Esperado**: Agent ve los markers PRIMERO, antes de cualquier otra instrucción.

---

### 2. **Judge Puede Ser Demasiado Permisivo/Estricto**

**Problema**:
Judge actualmente dice:
```
APPROVE if:
- ✅ Requirements fully implemented
- ✅ Architecture follows patterns
- ✅ No obvious logic bugs
- ✅ Reasonably maintainable
```

**Issue**: "Reasonably maintainable" es MUY subjetivo.

**Mejora Recomendada**:

```markdown
## 🎯 Approval Criteria (EXPLICIT)

### ✅ APPROVE if ALL are true:
1. **Requirements**: Story acceptance criteria 100% met
2. **Functionality**: Code actually works (no logic bugs)
3. **Security**: No obvious vulnerabilities (SQL injection, XSS, hardcoded secrets)
4. **Patterns**: Uses existing codebase patterns (doesn't reinvent wheel)

### ❌ REJECT if ANY are true:
1. **Incomplete**: Missing story requirements (even 1)
2. **Broken**: Logic bugs that will cause runtime errors
3. **Security Risk**: SQL injection, XSS, exposed credentials
4. **Anti-patterns**: Violates codebase architecture significantly

### ⚠️ APPROVE WITH WARNINGS if:
- Minor code style issues (not covered by lint)
- Could be more efficient but works
- Documentation could be better

🚨 BIAS ALERT: Default to APPROVE unless you have SPECIFIC, ACTIONABLE reasons to reject.

❌ BAD REJECT: "Code could be more maintainable"
✅ GOOD REJECT: "Missing error handling for null userId - will crash on line 42"

❌ BAD REJECT: "Function is too long"
✅ GOOD REJECT: "Function does 3 different things (save user, send email, log event) - violates single responsibility"
```

**Razón**: Criterios más objetivos = menos variabilidad entre reviews.

---

### 3. **QA Redundante con Developer Checks**

**Problema Actual**:
- Developer ejecuta: `npm run typecheck`, `npm test`, `npm run lint`
- Judge valida: Requirements, architecture, security
- QA ejecuta: `npm test`, `npm run lint`, `npm run build`

**Redundancia**: QA re-ejecuta tests/lint que Developer ya ejecutó.

**Mejora Recomendada**:

```markdown
# QA Engineer - Focus on INTEGRATION, not unit tests

## ⚡ NEW: Developer Already Ran Unit Tests

Developer agent executed:
- ✅ TypeScript compilation (npm run typecheck) - PASSED
- ✅ Unit tests (npm test) - PASSED
- ✅ Linting (npm run lint) - PASSED

**DO NOT re-run these. Focus on higher-level validation.**

## 🎯 What YOU Should Validate

### 1. Integration Testing (PRIMARY FOCUS)
```bash
# If integration tests exist, run them
Bash("npm run test:integration")
Bash("npm run test:e2e")
```

### 2. Build Verification
```bash
# Ensure production build succeeds
Bash("npm run build")
```

### 3. Runtime Validation (if applicable)
```bash
# Start server and verify it responds
Bash("npm start &")
sleep 5
Bash("curl http://localhost:3000/health")
```

### 4. Smoke Testing
- Does the feature actually work end-to-end?
- Can you manually test the happy path?
- Are there any obvious runtime errors?

## ❌ DO NOT (Developer Already Did)
- ❌ Re-run unit tests (Developer verified ✅)
- ❌ Re-run linting (Developer verified ✅)
- ❌ Re-check TypeScript compilation (Developer verified ✅)

## 🎯 Approval Criteria

APPROVE if:
- ✅ Build succeeds (if applicable)
- ✅ Integration tests pass (if exist)
- ✅ No runtime errors in smoke test

REJECT if:
- ❌ Build fails
- ❌ Integration tests fail
- ❌ Runtime errors detected
```

**Resultado**: QA se enfoca en **integración**, no en redundar unit tests.

---

### 4. **Tech Lead Puede Crear Stories Demasiado Grandes**

**Problema Observado**:
Tech Lead a veces crea stories que toman >4 horas, violando el principio de "1-3 horas por story".

**Mejora Recomendada**:

```markdown
# Tech Lead - Story Sizing Guidelines

## 🎯 STORY SIZE RULES (MANDATORY)

### ✅ GOOD Story Size: 1-3 hours
- Changes 1-3 files
- Implements 1 specific feature
- Has clear acceptance criteria
- Can be tested independently

### ⚠️ BORDERLINE Story Size: 3-4 hours
- Changes 4-5 files
- May need extra time for testing
- Acceptable if story is simple

### ❌ TOO LARGE Story Size: >4 hours
- Changes >5 files
- Multiple features in one story
- Complex dependencies
- **SPLIT INTO SMALLER STORIES**

## 🔥 AUTOMATIC COMPLEXITY DETECTION

Before creating a story, check:
1. **File Count**: filesToModify + filesToCreate > 5? → TOO LARGE
2. **Feature Count**: Does description have "AND" multiple times? → SPLIT
3. **Dependencies**: Does story depend on 2+ other stories? → RECONSIDER

## Example: SPLITTING A LARGE STORY

❌ **BAD** (Too Large):
```json
{
  "id": "story-1",
  "title": "Implement user authentication system",
  "filesToModify": [
    "src/auth/login.ts",
    "src/auth/register.ts",
    "src/auth/password-reset.ts",
    "src/auth/session.ts",
    "src/middleware/auth.ts",
    "src/routes/auth.ts",
    "src/utils/jwt.ts",
    "src/models/User.ts"
  ],
  "estimatedComplexity": "complex" // 8 files = 8+ hours
}
```

✅ **GOOD** (Split into 3 stories):
```json
[
  {
    "id": "story-1",
    "title": "Implement user registration endpoint",
    "filesToCreate": ["src/auth/register.ts"],
    "filesToModify": ["src/routes/auth.ts", "src/models/User.ts"],
    "estimatedComplexity": "simple" // 3 files = 2 hours
  },
  {
    "id": "story-2",
    "title": "Implement user login endpoint",
    "filesToCreate": ["src/auth/login.ts", "src/utils/jwt.ts"],
    "filesToModify": ["src/routes/auth.ts"],
    "estimatedComplexity": "simple" // 3 files = 2 hours
  },
  {
    "id": "story-3",
    "title": "Implement authentication middleware",
    "filesToCreate": ["src/middleware/auth.ts", "src/auth/session.ts"],
    "filesToModify": ["src/routes/protected.ts"],
    "estimatedComplexity": "moderate" // 3 files = 3 hours
  }
]
```

## 🚨 VALIDATION BEFORE OUTPUT

Before outputting your epic/story JSON, validate:
```typescript
for (const story of epic.stories) {
  const fileCount =
    (story.filesToModify?.length || 0) +
    (story.filesToCreate?.length || 0);

  if (fileCount > 5) {
    console.error(`❌ Story ${story.id} has ${fileCount} files - TOO LARGE!`);
    console.error(`   SPLIT into multiple stories (max 5 files each)`);
    // DO NOT output this story - split it first
  }
}
```

🎯 **Result**: Developer success rate increases dramatically with smaller stories.
```

---

### 5. **Fixer No Sabe Cuándo Detenerse**

**Problema**: Fixer puede entrar en loops infinitos intentando arreglar el mismo error.

**Mejora Recomendada**:

```markdown
# Fixer - Max Attempts and Escalation

## 🎯 FIX ATTEMPT LIMITS (MANDATORY)

You have **MAXIMUM 2 FIX ATTEMPTS** per error.

### Attempt 1: Quick Fix
- Analyze error message
- Apply common fix pattern
- Test fix immediately
- If successful → DONE
- If failed → Attempt 2

### Attempt 2: Deeper Fix
- Read more context files
- Understand root cause
- Apply comprehensive fix
- Test fix immediately
- If successful → DONE
- If failed → ESCALATE

### After 2 Failed Attempts: ESCALATE
```json
{
  "fixSuccessful": false,
  "attemptsUsed": 2,
  "escalateToHuman": true,
  "blockers": [
    "Specific blocker 1",
    "Specific blocker 2"
  ],
  "filesAnalyzed": ["file1.ts", "file2.ts"],
  "fixesAttempted": [
    "Attempt 1: Added missing import",
    "Attempt 2: Changed type definition"
  ],
  "recommendations": "Possible solutions for human developer"
}
```

## 🚨 LOOP PREVENTION

Track what you've already tried:
```typescript
const attemptedFixes = [];

// Attempt 1
attemptedFixes.push("Added import statement");
// If failed...

// Attempt 2
if (attemptedFixes.includes("Added import statement")) {
  // Don't try same fix again
  // Try something different
}
```

## ❌ FORBIDDEN: Infinite Loops
- ❌ Trying same fix 3+ times
- ❌ "Let me try one more time..."
- ❌ Fixing errors that keep reappearing

✅ REQUIRED: Know when to give up
- After 2 attempts → Escalate
- If error is beyond your scope → Escalate immediately
- If you need human decision → Escalate
```

---

### 6. **Product Manager Puede Ser Demasiado Ambicioso**

**Problema**: PM crea demasiados epics o epics demasiado grandes.

**Mejora Recomendada**:

```markdown
# Product Manager - Epic Sizing Guidelines

## 🎯 EPIC SIZE RULES

### Ideal Task Size: 2-4 Epics
- Each epic = 3-5 stories
- Total stories: 6-20 stories
- Total time: 10-60 hours of dev work

### ⚠️ If User Request is TOO LARGE
User says: "Build a complete e-commerce platform with user auth, product catalog, shopping cart, checkout, payment processing, admin dashboard, analytics, and email notifications"

**DO NOT** create 1 epic with 50 stories.

**INSTEAD**:
1. Identify MVP scope (what's ABSOLUTELY necessary?)
2. Create Phase 1 with 2-3 core epics
3. Output recommendation for phased approach

```json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "User Authentication",
      "phaseRecommendation": "Phase 1 - MVP"
    },
    {
      "id": "epic-2",
      "name": "Product Catalog",
      "phaseRecommendation": "Phase 1 - MVP"
    }
  ],
  "futureEpics": [
    "Shopping Cart (Phase 2)",
    "Payment Processing (Phase 2)",
    "Admin Dashboard (Phase 3)",
    "Analytics (Phase 3)"
  ],
  "recommendation": "This is a 3-month project. Starting with Phase 1 MVP (user auth + product catalog). Recommend iterative approach."
}
```

## 🚨 VALIDATION

Before outputting epics:
1. Count total stories across all epics
2. If >25 stories → TOO LARGE
3. Split into phases or reduce scope
4. Communicate with user about scope

```

---

## 📊 Summary of Improvements

| Agent | Problem | Improvement | Priority |
|-------|---------|-------------|----------|
| **Developer** | No ejecuta verificaciones | ✅ IMPLEMENTADO: Warning al principio | 🔥 CRITICAL |
| **Judge** | Criterios subjetivos | Criterios más objetivos + bias alert | 🔥 HIGH |
| **QA** | Redundancia con Developer | Focus en integration, no unit tests | ⚠️ MEDIUM |
| **Tech Lead** | Stories demasiado grandes | Validation: max 5 files per story | 🔥 HIGH |
| **Fixer** | Loops infinitos | Max 2 attempts + escalation | ⚠️ MEDIUM |
| **PM** | Epics demasiado ambiciosos | Epic sizing + phased approach | ⚠️ MEDIUM |

---

## 🎯 Implementación Recomendada

### Fase 1: CRÍTICO (Hacer YA) ✅
1. ✅ Developer warning (YA IMPLEMENTADO)
2. **Judge criteria improvement** (30 min)
3. **Tech Lead story size validation** (45 min)

### Fase 2: IMPORTANTE (Esta Semana)
4. **QA redundancy fix** (30 min)
5. **Fixer loop prevention** (20 min)

### Fase 3: MEJORÍA (Próxima Semana)
6. **PM epic sizing** (30 min)

---

## 🔧 Patrón General de Mejora

Todos los prompts deben seguir este patrón:

```markdown
# Agent Name

🚨🚨🚨 CRITICAL SUCCESS CRITERIA (AT TOP)
- What you MUST output
- What will cause IMMEDIATE rejection

[Rest of prompt...]

## ❌ VALIDATION BEFORE OUTPUT
[Self-check list the agent must verify]

## 🚨 COMMON MISTAKES TO AVOID
[List of mistakes observed in production]
```

**Razón**: Agents leen más el principio del prompt que el final. Información crítica debe estar arriba.

---

## 📈 Métricas de Éxito

Después de implementar mejoras, medir:

1. **Developer Marker Compliance**: % de developers que outputean los 5 markers
   - Actual: ~40% (estimado)
   - Target: >95%

2. **Judge Consistency**: Varianza en criterios de approval
   - Actual: Alto (subjetivo)
   - Target: Bajo (objetivo)

3. **Story Size**: Average files per story
   - Actual: Desconocido
   - Target: 3-5 files (1-3 hours work)

4. **Fixer Success Rate**: % de fixes exitosos sin escalation
   - Actual: Desconocido
   - Target: >70% (30% escalation es OK)

5. **QA Redundancy Time**: Time spent on redundant tests
   - Actual: ~40% del tiempo QA (estimado)
   - Target: <10% (focus en integration)

---

**Next Steps**: Implementar mejoras de Fase 1 (Judge + Tech Lead validation)
