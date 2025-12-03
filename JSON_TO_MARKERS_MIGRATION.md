# 🔄 JSON to Plain Text Markers - Complete Migration

**Fecha**: 2025-01-09
**Razón**: Seguir Anthropic SDK best practices - agentes comunican en texto, no JSON
**Alcance**: TODOS los 14 agentes + todas las phases de validación

## 🚨 Problema Detectado

**TODOS los agentes estaban forzados a outputear JSON**, violando Anthropic SDK best practices:

```typescript
// ❌ ANTI-PATTERN (lo que teníamos)
"## OUTPUT FORMAT (MANDATORY JSON)
Your ENTIRE response must be valid JSON:
```json
{
  "field1": "value",
  "field2": "value"
}
```

YOUR ENTIRE RESPONSE MUST BE VALID JSON AND NOTHING ELSE.
❌ NO explanations before JSON
❌ NO text after JSON"

// ✅ BEST PRACTICE (lo que debemos tener)
"## OUTPUT FORMAT (Plain Text with Markers)

⚠️ Following Anthropic SDK best practices, output natural language.
❌ DO NOT output JSON
✅ DO use markers to signal completion

Structure your response clearly:

**Section 1**
[Natural language explanation]

**Section 2**
[Natural language explanation]

🔥 MANDATORY: End with this marker:
✅ [AGENT]_COMPLETE"
```

## 📊 Agentes Afectados

Todos los 14 agentes requerían salida JSON:

1. ✅ **problem-analyst** - MIGRADO
2. ⏳ **product-manager** - TODO
3. ⏳ **project-manager** - TODO
4. ⏳ **tech-lead** - TODO
5. ✅ **developer** - YA TENÍA markers (iterative development)
6. ⏳ **fixer** - TODO
7. ⏳ **recovery-analyst** - TODO
8. ⏳ **judge** - TODO
9. ⏳ **qa-engineer** - TODO
10. ⏳ **contract-tester** - TODO
11. ⏳ **test-creator** - TODO
12. ⏳ **contract-fixer** - TODO
13. ⏳ **merge-coordinator** - TODO
14. ⏳ **error-detective** - TODO

## 🎯 Estrategia de Migración

### Fase 1: Agentes Críticos (PRIORIDAD)

Estos agentes son críticos para el pipeline principal:

#### 1️⃣ **product-manager** (Define epics)
- **Input**: Task description
- **Output**: Master Epic con shared contracts
- **Marker**: `✅ EPIC_DEFINED`
- **Challenge**: Necesita estructura de datos compleja (contracts, naming conventions)
- **Solution**: Usar secciones claras en texto + markers para campos clave

#### 2️⃣ **project-manager** (Crea stories)
- **Input**: Epic from product-manager
- **Output**: Lista de stories con dependencies
- **Marker**: `✅ STORIES_CREATED`
- **Challenge**: Array de stories con múltiples campos
- **Solution**: Formato de lista estructurada en texto

#### 3️⃣ **judge** (Code review)
- **Input**: Código del developer
- **Output**: APPROVED/REJECTED con feedback
- **Markers**: `✅ APPROVED` o `❌ REJECTED`
- **Challenge**: Actualmente usa JSON para approved boolean
- **Solution**: Plain text markers directos

#### 4️⃣ **qa-engineer** (Testing)
- **Input**: Código merged
- **Output**: Test results
- **Markers**: `✅ QA_PASSED` o `❌ QA_FAILED`
- **Challenge**: JSON para test details
- **Solution**: Texto natural con markers de status

### Fase 2: Agentes Secundarios

Estos agentes son importantes pero no bloqueantes:

- **tech-lead**: Architecture design
- **fixer**: Bug fixes
- **error-detective**: Error analysis
- **contract-tester**: Contract validation
- **test-creator**: Test generation
- **recovery-analyst**: Failure recovery

### Fase 3: Phases de Validación

Actualizar todas las phases que parsean JSON a usar `MarkerValidator`:

- ✅ `DevelopersPhase` - MIGRADO
- ⏳ `ProductManagerPhase` - TODO
- ⏳ `ProjectManagerPhase` - TODO
- ⏳ `JudgePhase` - TODO
- ⏳ `QAPhase` - TODO
- ⏳ `FixerPhase` - TODO
- ⏳ Etc.

## 🔧 Template de Migración

### Para Prompts (AgentDefinitions.ts)

**ANTES (JSON forzado)**:
```
## OUTPUT FORMAT (MANDATORY JSON)

Your ENTIRE response must be valid JSON:

\`\`\`json
{
  "field1": "value",
  "field2": "value"
}
\`\`\`

🎯 REMEMBER:
- Your FIRST character must be {
- Your LAST character must be }
- NO text before or after JSON
```

**DESPUÉS (Plain text con markers)**:
```
## OUTPUT FORMAT (Plain Text with Markers)

⚠️ IMPORTANT: Following Anthropic SDK best practices, output natural language with clear markers.
❌ DO NOT output JSON - agents communicate in plain text
✅ DO use markers to signal completion and key information

Structure your response in clear sections:

**1. [Section Name]**
[Natural language explanation]

**2. [Section Name]**
[Natural language explanation]

🔥 MANDATORY: End with this marker:
✅ [AGENT_NAME]_COMPLETE

Example:
"Based on my analysis...

**Problem Statement**
The core issue is...

**Solution**
I recommend...

✅ [AGENT_NAME]_COMPLETE"
```

### Para Validation (Phase files)

**ANTES (JSON parsing)**:
```typescript
const output = agentResult.output || '';

try {
  const parsed = JSON.parse(output);

  if (!parsed.field1 || !parsed.field2) {
    throw new Error('Missing required fields');
  }

  const field1 = parsed.field1;
  const field2 = parsed.field2;

  // Continue processing...
} catch (error) {
  console.error('Failed to parse JSON:', error);
  return { success: false };
}
```

**DESPUÉS (Marker validation)**:
```typescript
import { hasMarker, extractMarkerValue, COMMON_MARKERS } from './utils/MarkerValidator';

const output = agentResult.output || '';

// Check completion marker
const completed = hasMarker(output, COMMON_MARKERS.[AGENT]_COMPLETE);

if (!completed) {
  console.error('Agent did not complete successfully');
  console.error('Missing marker:', COMMON_MARKERS.[AGENT]_COMPLETE);
  return { success: false };
}

// Extract specific values if needed
const someValue = extractMarkerValue(output, '📍 Some Value:');

// Continue processing...
```

## 🎨 Markers Estandarizados

### Completion Markers (por agente)

```typescript
export const AGENT_MARKERS = {
  PROBLEM_ANALYST: '✅ ANALYSIS_COMPLETE',
  PRODUCT_MANAGER: '✅ EPIC_DEFINED',
  PROJECT_MANAGER: '✅ STORIES_CREATED',
  TECH_LEAD: '✅ ARCHITECTURE_COMPLETE',
  DEVELOPER: '✅ DEVELOPER_FINISHED_SUCCESSFULLY',
  JUDGE: '✅ APPROVED' | '❌ REJECTED',
  QA: '✅ QA_PASSED' | '❌ QA_FAILED',
  FIXER: '✅ FIX_APPLIED',
  // ... etc
};
```

### Data Extraction Markers

```typescript
export const DATA_MARKERS = {
  EPIC_ID: '📍 Epic ID:',
  STORY_ID: '📍 Story ID:',
  COMMIT_SHA: '📍 Commit SHA:',
  PR_NUMBER: '📍 PR Number:',
  BRANCH_NAME: '📍 Branch:',
  TEST_COUNT: '📍 Tests:',
  // ... etc
};
```

## 📋 Plan de Ejecución

### Paso 1: Actualizar Prompts Críticos (1-2 horas)

1. ✅ `problem-analyst` - DONE
2. `product-manager` - Define epics (CRÍTICO)
3. `project-manager` - Crea stories (CRÍTICO)
4. `judge` - Code review (CRÍTICO)
5. `qa-engineer` - Testing (CRÍTICO)

### Paso 2: Actualizar Phases de Validación (1 hora)

1. ✅ `DevelopersPhase` - DONE
2. `ProductManagerPhase` - Parse epic output
3. `ProjectManagerPhase` - Parse stories output
4. `JudgePhase` - Parse approval/rejection
5. `QAPhase` - Parse test results

### Paso 3: Actualizar Prompts Secundarios (30 mins)

6. `tech-lead`
7. `fixer`
8. `error-detective`
9. `contract-tester`
10. `test-creator`
11. `recovery-analyst`
12. `merge-coordinator`
13. `contract-fixer`

### Paso 4: Testing y Validación (1 hora)

1. Build TypeScript (`npm run build`)
2. Fix any compilation errors
3. Test con task real
4. Verificar logs de cada agente
5. Confirmar markers son detectados

## ⚠️ Consideraciones Especiales

### Product Manager: Contracts Complejos

El product-manager define **shared contracts** (API endpoints, types, naming conventions) que TODOS los developers deben seguir.

**Challenge**: Esto requiere estructura de datos compleja.

**Solution**: Usar formato estructurado en texto:

```
## Shared Contracts

### API Endpoints
POST /api/users/register
Request: { email: string, password: string }
Response: { userId: string, token: string }
Description: Register new user

GET /api/users/:id
Response: { userId: string, email: string, createdAt: string }
Description: Get user by ID

### Shared Types
Type: User
Fields:
  - userId: string (primary key)
  - email: string (unique)
  - createdAt: string (ISO8601)

### Naming Conventions
- Primary ID field: userId
- Timestamp format: ISO8601
- Error code prefix: USER_
- Boolean prefix: is, has, should

📍 Epic ID: epic-user-auth-20250109
✅ EPIC_DEFINED
```

### Project Manager: Multiple Stories

El project-manager crea múltiples stories con dependencies.

**Solution**: Lista numerada en texto:

```
## Stories Created

Story 1: Setup authentication database
Branch: story/001-auth-db-setup
Repository: backend
Dependencies: none
Tasks:
- Create User model
- Setup JWT middleware
- Add auth routes

Story 2: Implement registration endpoint
Branch: story/002-user-registration
Repository: backend
Dependencies: Story 1
Tasks:
- POST /api/users/register handler
- Validation logic
- Password hashing

... [continuar con todas las stories] ...

📍 Total Stories: 5
📍 Epic ID: epic-user-auth-20250109
✅ STORIES_CREATED
```

### Judge: Simple Approval

**Solution**: Direct marker en texto:

```
I've reviewed the code for story-001-auth-db-setup.

**Code Quality**: Excellent
- Clean separation of concerns
- Proper error handling
- Good test coverage

**Security**: Strong
- Passwords properly hashed
- Input validation present
- SQL injection protection

**Performance**: Good
- Efficient queries
- Proper indexes

**Verdict**: This code meets all requirements and follows best practices.

✅ APPROVED
```

O si hay problemas:

```
I've reviewed the code but found critical issues.

**Problems**:
1. Missing password validation (min 8 chars)
2. No rate limiting on auth endpoint
3. Error messages leak user existence

**Required Changes**:
1. Add password strength validation
2. Implement rate limiting middleware
3. Use generic error messages

❌ REJECTED
📍 Reason: Security vulnerabilities
```

## ✅ Beneficios de la Migración

1. **Sigue Best Practices**: Anthropic SDK recomienda texto, no JSON
2. **Más Robusto**: Tolerante a markdown formatting
3. **Debugging Más Fácil**: Humanos leen texto natural
4. **Menos Errores**: No más JSON syntax errors
5. **Más Natural para LLM**: Claude piensa en texto, no en data structures
6. **Mejor Logging**: Logs son human-readable
7. **Flexible**: Agente puede explicar SU DECISIÓN, no solo devolver datos

## 📊 Impacto Estimado

- **Código Afectado**: ~14 archivos (AgentDefinitions.ts + ~10 Phase files)
- **Líneas Modificadas**: ~2000 líneas
- **Tiempo Estimado**: 3-4 horas
- **Riesgo**: MEDIO (cambio fundamental pero bien diseñado)
- **Beneficio**: ALTO (mejora calidad, robustez, y sigue best practices)

## 🚀 Próximos Pasos

1. ✅ Crear `MarkerValidator` utility - DONE
2. ✅ Migrar `problem-analyst` prompt - DONE
3. ✅ Actualizar `DevelopersPhase` validation - DONE
4. ⏳ Migrar `product-manager` prompt - IN PROGRESS
5. ⏳ Actualizar `ProductManagerPhase` validation - TODO
6. ⏳ Continuar con agentes críticos (project-manager, judge, qa)
7. ⏳ Migrar agentes secundarios
8. ⏳ Testing completo del sistema
9. ⏳ Documentación final

---

**Implementado Por**: Claude (Sonnet 4.5)
**Aprobado Por**: Luis Correa
**Fecha Inicio**: 2025-01-09
**Status**: 🚧 EN PROGRESO (20% completado)
