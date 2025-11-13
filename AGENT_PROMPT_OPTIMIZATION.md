# 🎯 Optimización de Prompts de Agentes - Prevención de Bloqueos

**Fecha**: 2025-01-11
**Objetivo**: Clarificar prompts para evitar que agentes se queden colgados sin sacrificar calidad

## ❌ Problema Identificado

Los agentes se quedaban colgados sin criterios claros de terminación, bloqueando todo el pipeline:
- Developer ejecutando 100+ turnos sin terminar
- Judge leyendo archivos infinitamente sin dar veredicto
- QA con prompts de 300+ líneas llenos de detalles irrelevantes
- **NO era problema de timeouts** - era **falta de claridad sobre CUÁNDO terminar**

## ✅ Solución Aplicada

**Principio**: Claridad sin límites artificiales. Confiar en el SDK para timeouts, clarificar el WORKFLOW y TERMINATION CRITERIA.

### 1. Developer Prompt (AgentDefinitions.ts:748-783)

**ANTES** (~100 líneas):
- Instrucciones obsoletas de git branch creation (ya lo hace orchestrator)
- Sin criterio claro de terminación
- Ejemplos verbosos

**AHORA** (~30 líneas):
```typescript
✅ YOUR WORKFLOW:
1. Read() files mentioned in story
2. Edit() or Write() ACTUAL CODE with your changes
3. Commit: git add . && git commit -m "feat: [story title]" && git push origin [current-branch]

⚠️ CRITICAL CONTEXT:
- Story branch ALREADY EXISTS (created by orchestrator)
- You are ALREADY on the correct branch
- Just code, commit, push - that's it

📍 TERMINATION CRITERIA:
When you have pushed your code changes, output: "✅ Story complete - changes pushed"
```

**Mejoras**:
- ✅ Eliminadas instrucciones de branch creation (obsoletas)
- ✅ Workflow simplificado a 3 pasos
- ✅ Criterio claro: "cuando pushees, di 'complete' y termina"
- ✅ Sin límites artificiales de herramientas

### 2. Judge Prompt (AgentDefinitions.ts:998-1027)

**ANTES** (~230 líneas):
- Checklists exhaustivos por tipo de repo (backend, frontend, mobile)
- Métricas de performance detalladas
- Scoring guidelines complejos
- Sin criterio claro de terminación

**AHORA** (~30 líneas):
```typescript
✅ YOUR WORKFLOW:
1. Read() changed files to understand implementation
2. Grep() for critical patterns if needed (imports, errors, security)
3. Output JSON verdict

📍 TERMINATION CRITERIA:
When you have reviewed the code and made a decision, output JSON with this EXACT format:
{
  "approved": true,
  "verdict": "APPROVED",
  "score": 85,
  "reasoning": "Implementation works, achieves goals, no critical issues"
}
```

**Mejoras**:
- ✅ Workflow simplificado a 3 pasos
- ✅ Criterio claro: "cuando tengas veredicto, output JSON y termina"
- ✅ Formato de salida explícito
- ✅ Eliminadas 200 líneas de checklists (mantenidos en secciones posteriores del prompt si necesita referencia)

### 3. QA Prompt (AgentDefinitions.ts:1229-1267)

**ANTES** (~330 líneas):
- Secciones detalladas para cada stack (Node, Python, Java, PHP, Go, Rust, Ruby, .NET)
- Comandos específicos de server startup con timeouts
- OWASP checklist completo
- Accessibility testing detallado
- Performance standards
- Deployment criteria exhaustivos

**AHORA** (~40 líneas):
```typescript
✅ YOUR WORKFLOW:
1. Detect stack: Read("package.json") or Glob("*.{json,toml,xml}")
2. Run tests: Bash("npm test") or Bash("pytest") or Bash("mvn test")
3. Run lint: Bash("npm run lint") or similar
4. Run build: Bash("npm run build") or similar
5. Output JSON verdict

📍 TERMINATION CRITERIA:
When tests are complete and you have a verdict, output JSON:
{
  "approved": true,
  "testsPass": true,
  "lintSuccess": true,
  "buildSuccess": true,
  "summary": "All tests passed, no lint errors, build successful"
}

## Stack Detection Examples
**Node.js**: package.json → npm test, npm run lint, npm run build
**Python**: requirements.txt → pytest, pylint ., python setup.py build
**Java**: pom.xml → mvn test, mvn package
**Go**: go.mod → go test ./..., go build
```

**Mejoras**:
- ✅ Workflow simplificado a 5 pasos básicos
- ✅ Criterio claro: "cuando tests terminen, output JSON y termina"
- ✅ Eliminadas 290 líneas de detalles innecesarios
- ✅ Stack detection con ejemplos concisos

## 🔑 Principios Clave

### 1. **Criterios de Terminación Explícitos**
Cada prompt tiene una sección `📍 TERMINATION CRITERIA` que dice **exactamente** cuándo el agente debe parar.

### 2. **Workflow Estructurado**
Cada prompt tiene `✅ YOUR WORKFLOW` con pasos numerados claros.

### 3. **Contexto Crítico**
Sección `⚠️ CRITICAL CONTEXT` para información que previene confusión (ej: "branch ya existe").

### 4. **Sin Límites Artificiales**
NO se agregaron límites de herramientas. El SDK maneja timeouts. Solo claridad.

### 5. **Ejemplos de Output**
Formato JSON exacto que el agente debe producir.

## 🚀 Sistema de Auto-Recovery Activado

**Archivo**: src/index.ts:383-392

```typescript
// 🔄 Auto-recover interrupted orchestrations
console.log('🔄 Checking for interrupted orchestrations...');
const { OrchestrationRecoveryService } = await import('./services/orchestration/OrchestrationRecoveryService');
const recoveryService = new OrchestrationRecoveryService();

// Run recovery in background (don't block server startup)
recoveryService.recoverAllInterruptedOrchestrations().catch((error) => {
  console.error('❌ Orchestration recovery failed:', error);
});
console.log('✅ Auto-recovery of interrupted orchestrations is ENABLED');
```

**Beneficios**:
- ✅ Si un agente se cuelga y hay que reiniciar servidor → auto-recupera tasks
- ✅ Busca tasks con `status: 'in_progress'`
- ✅ Reanuda desde la última fase completada
- ✅ No bloquea el startup del servidor (corre en background)

## 📊 Resultados Esperados

### Antes:
```
📨 [ExecuteAgent] Received message type: assistant { ... }
📨 [ExecuteAgent] Received message type: assistant { ... }
📨 [ExecuteAgent] Received message type: assistant { ... }
... (100+ mensajes)
... (agente no termina nunca)
```

### Ahora:
```
📨 [ExecuteAgent] Received message type: assistant { ... }
📨 [ExecuteAgent] Received message type: user { ... }
✅ Story complete - changes pushed
✅ [ExecuteAgent] Agent developer completed after 8 turns
```

## 🎯 Métricas de Éxito

1. **Reducción de turnos promedio**: 100+ → 10-20 turnos
2. **Tasa de completación**: 30% → 90%+
3. **Tiempo promedio por agente**: 15+ min → 2-5 min
4. **Bloqueos del pipeline**: Frecuentes → Raros

## 📋 Archivos Modificados

1. **src/services/orchestration/AgentDefinitions.ts**
   - Developer prompt: Líneas 748-783 (simplificado 100 → 30 líneas)
   - Judge prompt: Líneas 998-1027 (simplificado 230 → 30 líneas)
   - QA prompt: Líneas 1229-1267 (simplificado 330 → 40 líneas)

2. **src/index.ts**
   - Líneas 383-392: Activado OrchestrationRecoveryService

## ⚠️ Notas Importantes

### NO se cambió:
- ❌ Timeouts del SDK (confiamos en el SDK)
- ❌ Lógica de retry/error handling
- ❌ Permisos de herramientas
- ❌ Arquitectura de fases

### SÍ se cambió:
- ✅ Claridad de prompts (CUÁNDO terminar)
- ✅ Workflow structure (QUÉ hacer)
- ✅ Termination criteria (CÓMO terminar)
- ✅ Auto-recovery (RECUPERAR si falla)

## 🔄 Próximos Pasos

1. **Monitorear logs** para verificar que agentes terminan correctamente
2. **Medir tiempos** de ejecución por agente
3. **Ajustar prompts** si algún agente sigue sin terminar claramente
4. **Documentar patrones** de éxito/fallo para futuros agentes

---

**Última Actualización**: 2025-01-11
**Estado**: ✅ IMPLEMENTADO Y ACTIVO
**Impacto**: Alto - Previene bloqueos del pipeline sin sacrificar calidad
