# Plan: Fix Cost Tracking en AgentExecutorService

## Resumen Ejecutivo

**Problema:** El cost tracking siempre muestra $0.0000 porque el código busca `message.usage` (tokens) pero el SDK de Claude Agent envía `message.cost` directamente en USD.

**Solución:** Cambiar la lógica para leer `message.cost` de mensajes de tipo `system` en lugar de calcular desde tokens.

---

## Análisis del Bug

### Código Actual (Incorrecto)

**Archivo:** `src/services/AgentExecutorService.ts` (~líneas 680-690)

```typescript
// El código actual intenta extraer usage (tokens) que NO existe
const msgUsage = (message as any).usage || {
  input_tokens: 0,
  output_tokens: 0
};

accumulatedInputTokens += msgUsage.input_tokens;
accumulatedOutputTokens += msgUsage.output_tokens;

// Luego intenta calcular costo desde tokens
const inputCost = (accumulatedInputTokens / 1_000_000) * modelPricing.inputPricePerMillion;
const outputCost = (accumulatedOutputTokens / 1_000_000) * modelPricing.outputPricePerMillion;
```

### Por qué falla

1. El SDK de Claude Agent **NO expone tokens individuales** en los mensajes
2. El SDK envía el **costo total acumulado en USD** directamente
3. El costo viene en mensajes de tipo `system` con propiedad `cost`

---

## Documentación del SDK

### Formato de Mensaje de Costo (Claude Agent SDK)

```typescript
// El SDK emite mensajes de tipo 'system' con costo acumulado
{
  type: 'system',
  cost: 0.0234,  // Costo acumulado en USD
  // ... otros campos
}
```

### Cómo el SDK Calcula el Costo

1. Claude Agent SDK tiene acceso interno a los tokens consumidos
2. Aplica los precios del modelo actual (Haiku, Sonnet, Opus)
3. Emite el costo acumulado en USD periódicamente vía mensajes `system`

### Precios por Modelo (Referencia)

| Modelo | Input ($/MTok) | Output ($/MTok) |
|--------|----------------|-----------------|
| Haiku  | $0.25          | $1.25           |
| Sonnet | $3.00          | $15.00          |
| Opus   | $15.00         | $75.00          |

---

## Implementación Propuesta

### Paso 1: Simplificar la Acumulación de Costo

```typescript
// ============ ANTES (Incorrecto) ============
const msgUsage = (message as any).usage || { input_tokens: 0, output_tokens: 0 };
accumulatedInputTokens += msgUsage.input_tokens;
accumulatedOutputTokens += msgUsage.output_tokens;

// ============ DESPUÉS (Correcto) ============
// El SDK envía el costo acumulado directamente en USD
if (message.type === 'system' && typeof (message as any).cost === 'number') {
  accumulatedCost = (message as any).cost; // El SDK ya lo acumula
}
```

### Paso 2: Actualizar la Estructura de Tracking

```typescript
// Simplificar - solo necesitamos el costo, no tokens
let accumulatedCost = 0; // USD directamente del SDK

// Eliminar estas variables (ya no necesarias):
// - accumulatedInputTokens
// - accumulatedOutputTokens
// - modelPricing (ya no calculamos nosotros)
```

### Paso 3: Actualizar el Objeto de Retorno

```typescript
return {
  // ... otros campos
  cost: {
    totalCost: accumulatedCost, // Directo del SDK
    // Opcional: mantener inputTokens/outputTokens como 0 para backward compatibility
    inputTokens: 0,  // No disponible desde SDK
    outputTokens: 0, // No disponible desde SDK
  }
};
```

### Paso 4: Actualizar la Base de Datos

```typescript
// Al guardar en DB, usar el costo del SDK directamente
await this.updateTaskCost(taskId, accumulatedCost);
```

---

## Mapa Completo de Cambios

### 🔴 Archivo Principal: `src/services/orchestration/AgentExecutorService.ts`

| Línea | Código Actual | Cambio Requerido |
|-------|--------------|------------------|
| ~682 | `const msgUsage = (message as any).usage \|\| (message as any).message?.usage \|\| (message as any).data?.usage;` | Cambiar a: `if (message.type === 'system' && (message as any).cost) { accumulatedCost = (message as any).cost; }` |
| ~683-688 | `if (msgUsage) { accumulatedUsage.input_tokens += ... }` | ELIMINAR - no necesario |
| ~745-747 | `const usage = accumulatedUsage.input_tokens > 0 ? accumulatedUsage : ...` | ELIMINAR - usar `accumulatedCost` directamente |
| ~749-752 | `const inputTokens = usage.input_tokens \|\| 0; ...` | ELIMINAR - SDK no provee tokens |
| ~754-765 | Cálculo manual con MODEL_PRICING | ELIMINAR - SDK ya calcula |
| ~761-765 | `const inputCost = (inputTokens * ...) / 1_000_000; ...` | REEMPLAZAR con: `const cost = accumulatedCost;` |
| ~777-781 | `unifiedMemoryService.addCost(taskId, cost, totalTokens);` | SIMPLIFICAR: `unifiedMemoryService.addCost(taskId, accumulatedCost, 0);` |

### 🟡 Archivos Dependientes (Verificar Compatibilidad)

| Archivo | Línea | Uso | Impacto |
|---------|-------|-----|---------|
| `src/services/UnifiedMemoryService.ts` | 740 | `addCost(taskId, cost, tokens)` | Bajo - Tokens pueden ser 0 |
| `src/services/UnifiedMemoryService.ts` | 743-744 | `totalCost: (orch.totalCost \|\| 0) + cost` | Ninguno - Ya usa cost directo |
| `src/services/orchestration/CostBudgetService.ts` | 64 | `task.orchestration.totalCost` | Ninguno - Solo lee totalCost |
| `src/services/RealisticCostEstimator.ts` | 59-60 | `COST_PER_1K_INPUT/OUTPUT` | NO TOCAR - Es para estimaciones, no tracking |
| `src/services/orchestration/utils/CostAccumulator.ts` | - | Tracking por categoría | Revisar - Puede necesitar ajuste |
| `src/database/repositories/TaskRepository.ts` | 81-86 | `usage?: { input_tokens, output_tokens }` | Opcional - Mantener para backward compat |

### 🟢 Archivos que NO Necesitan Cambios

| Archivo | Razón |
|---------|-------|
| `src/services/orchestration/CostBudgetService.ts` | Solo lee `totalCost`, no tokens |
| `src/routes/tasks/taskStatus.ts` | Retorna lo que está en DB |
| `src/services/RealisticCostEstimator.ts` | Estimador pre-ejecución, no tracking real |
| `src/services/orchestration/TeamOrchestrationPhase.ts` | Consume resultado de AgentExecutorService |
| `src/services/orchestration/DevelopersPhase.ts` | Consume resultado de AgentExecutorService |

### 🔵 CostAccumulator - Decisión Requerida

El `CostAccumulator` (líneas 27-127) tiene soporte para tokens:

```typescript
interface CategoryData {
  cost: number;
  tokens: TokenUsage;  // { input: number; output: number; }
}
```

**Opciones:**
1. **Mantener como está** - Pasar tokens como 0, costo directo del SDK
2. **Simplificar** - Eliminar tracking de tokens del CostAccumulator
3. **Estimar tokens** - Calcular inversamente desde costo (no recomendado)

**Recomendación:** Opción 1 - Mantener estructura, solo cambiar de dónde viene el costo

---

## Diff de Implementación

### Cambio 1: Loop de Mensajes (AgentExecutorService.ts:681-688)

```diff
- // Usage accumulation
- const msgUsage = (message as any).usage || (message as any).message?.usage || (message as any).data?.usage;
- if (msgUsage) {
-   if (msgUsage.input_tokens) accumulatedUsage.input_tokens += msgUsage.input_tokens;
-   if (msgUsage.output_tokens) accumulatedUsage.output_tokens += msgUsage.output_tokens;
-   if (msgUsage.cache_creation_input_tokens) accumulatedUsage.cache_creation_input_tokens += msgUsage.cache_creation_input_tokens;
-   if (msgUsage.cache_read_input_tokens) accumulatedUsage.cache_read_input_tokens += msgUsage.cache_read_input_tokens;
- }

+ // 🔥 Cost from SDK (system messages contain accumulated cost in USD)
+ if ((message as any).type === 'system') {
+   const systemCost = (message as any).cost;
+   if (typeof systemCost === 'number' && systemCost > 0) {
+     accumulatedCost = systemCost; // SDK accumulates, we just capture latest
+     console.log(`💰 [SDK Cost Update] ${agentType}: $${systemCost.toFixed(4)}`);
+   }
+ }
```

### Cambio 2: Cálculo de Costo (AgentExecutorService.ts:744-774)

```diff
- // Calculate cost
- const usage = accumulatedUsage.input_tokens > 0 || accumulatedUsage.output_tokens > 0
-   ? accumulatedUsage
-   : ((finalResult as any)?.usage || {});
-
- const inputTokens = usage.input_tokens || 0;
- const outputTokens = usage.output_tokens || 0;
- const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
- const cacheReadTokens = usage.cache_read_input_tokens || 0;
-
- const { MODEL_PRICING } = await import('../../config/ModelConfigurations');
- const pricing = MODEL_PRICING[modelAlias as keyof typeof MODEL_PRICING];
-
- // 🔥 ALWAYS use Opus 4.5 pricing ($15 input, $75 output per MTok) for consistency
- const inputPricePerMillion = pricing?.inputPerMillion || 15;  // Opus 4.5 fallback
- const outputPricePerMillion = pricing?.outputPerMillion || 75; // Opus 4.5 fallback
-
- const inputCost = (inputTokens * inputPricePerMillion) / 1_000_000;
- const outputCost = (outputTokens * outputPricePerMillion) / 1_000_000;
- const cacheCreationCost = (cacheCreationTokens * inputPricePerMillion * 1.25) / 1_000_000;
- const cacheReadCost = (cacheReadTokens * inputPricePerMillion * 0.1) / 1_000_000;
- const cost = inputCost + outputCost + cacheCreationCost + cacheReadCost;
-
- // 🔥 DETAILED COST LOGGING
- console.log(`💰 [AgentExecutor] ${agentType} COST BREAKDOWN:`);
- console.log(`   📊 Model: ${modelAlias} → Pricing: $${inputPricePerMillion}/$${outputPricePerMillion} per MTok`);
- console.log(`   📥 Input tokens:  ${inputTokens.toLocaleString()} → $${inputCost.toFixed(4)}`);
- console.log(`   📤 Output tokens: ${outputTokens.toLocaleString()} → $${outputCost.toFixed(4)}`);
- console.log(`   💾 Cache create:  ${cacheCreationTokens.toLocaleString()} → $${cacheCreationCost.toFixed(4)}`);
- console.log(`   📖 Cache read:    ${cacheReadTokens.toLocaleString()} → $${cacheReadCost.toFixed(4)}`);
- console.log(`   💵 TOTAL: $${cost.toFixed(4)}`);

+ // 🔥 USE SDK COST DIRECTLY (no manual calculation needed)
+ const cost = accumulatedCost;
+ console.log(`💰 [AgentExecutor] ${agentType} FINAL COST: $${cost.toFixed(4)} (from SDK)`);
```

### Cambio 3: Declaración de Variable (AgentExecutorService.ts:~560)

```diff
+ let accumulatedCost = 0; // USD from Claude Agent SDK

- const accumulatedUsage = {
-   input_tokens: 0,
-   output_tokens: 0,
-   cache_creation_input_tokens: 0,
-   cache_read_input_tokens: 0,
- };
+ // Note: accumulatedUsage kept for backward compatibility but not used for cost
+ const accumulatedUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
```

### Cambio 4: Guardar en DB (AgentExecutorService.ts:777-781)

```diff
- // 🔥 SAVE COST TO SQLite
- if (taskId && cost > 0) {
-   const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;
-   unifiedMemoryService.addCost(taskId, cost, totalTokens);
-   console.log(`   💾 Cost saved to SQLite: $${cost.toFixed(4)} (${totalTokens.toLocaleString()} tokens)`);
- }

+ // 🔥 SAVE SDK COST TO SQLite
+ if (taskId && cost > 0) {
+   unifiedMemoryService.addCost(taskId, cost, 0); // Tokens not available from SDK
+   console.log(`   💾 Cost saved to SQLite: $${cost.toFixed(4)} (SDK direct)`);
+ }
```

---

## Ejemplo de Código Final

```typescript
// En AgentExecutorService.executeAgent()

let accumulatedCost = 0; // USD from SDK

for await (const message of agent) {
  // ... procesar otros tipos de mensaje ...

  // Capturar costo del SDK
  if ((message as any).type === 'system') {
    const systemCost = (message as any).cost;
    if (typeof systemCost === 'number' && systemCost > 0) {
      accumulatedCost = systemCost;
      console.log(`💰 [SDK Cost] ${agentType}: $${systemCost.toFixed(4)}`);
    }
  }
}

// Al final de la ejecución - usar costo directo del SDK
const cost = accumulatedCost;
console.log(`💰 [AgentExecutor] ${agentType} FINAL: $${cost.toFixed(4)}`);

if (taskId && cost > 0) {
  unifiedMemoryService.addCost(taskId, cost, 0);
}

return {
  output,
  usage: {}, // Empty - SDK doesn't provide token breakdown
  cost,
  // ...
};
```

---

## Consideraciones

### Backward Compatibility

Si otros sistemas dependen de `inputTokens` y `outputTokens`:
- Mantener los campos con valor 0
- Agregar campo `source: 'sdk-direct'` para indicar que tokens no están disponibles
- O calcular tokens inversamente: `tokens = cost / pricePerToken`

### Cálculo Inverso de Tokens (Opcional)

Si realmente se necesitan tokens para métricas:

```typescript
// Aproximación inversa (NO exacta debido a caché y batching)
const estimatedInputTokens = Math.round(
  (accumulatedCost * 0.7) / (modelPricing.inputPricePerMillion / 1_000_000)
);
const estimatedOutputTokens = Math.round(
  (accumulatedCost * 0.3) / (modelPricing.outputPricePerMillion / 1_000_000)
);
```

**Nota:** Esta aproximación asume 70% input, 30% output. NO es exacta.

---

## Testing

### Test Manual
1. Ejecutar un task simple
2. Verificar que el costo se muestra > $0.0000
3. Comparar con el dashboard de Anthropic para validar precisión

### Test Unitario
```typescript
describe('AgentExecutorService Cost Tracking', () => {
  it('should accumulate cost from SDK system messages', async () => {
    // Mock agent que emite mensajes system con cost
    const mockAgent = createMockAgent([
      { type: 'system', cost: 0.01 },
      { type: 'text', content: 'Working...' },
      { type: 'system', cost: 0.02 },
    ]);

    const result = await service.executeAgent(mockAgent, context);

    expect(result.cost.totalCost).toBe(0.02); // Último valor (acumulado por SDK)
  });
});
```

---

## Checklist de Implementación

### Fase 1: Cambios en AgentExecutorService.ts
- [ ] Agregar variable `let accumulatedCost = 0;` (~línea 560)
- [ ] Modificar loop de mensajes para capturar `message.type === 'system'` con `message.cost` (línea 681-688)
- [ ] Eliminar/comentar cálculo manual con MODEL_PRICING (líneas 745-765)
- [ ] Simplificar logging de costo (líneas 767-774)
- [ ] Actualizar guardado en SQLite - tokens = 0 (líneas 777-781)

### Fase 2: Verificación de Compatibilidad
- [ ] Verificar que `UnifiedMemoryService.addCost()` funciona con tokens=0
- [ ] Verificar que `CostBudgetService` lee `totalCost` correctamente
- [ ] Verificar que endpoints de API retornan el costo

### Fase 3: Testing
- [ ] Ejecutar task simple y verificar costo > $0.0000
- [ ] Comparar costo reportado con dashboard de Anthropic
- [ ] Verificar que el costo se persiste en SQLite
- [ ] Verificar que el frontend muestra el costo correctamente

### Fase 4: Cleanup (Opcional)
- [ ] Eliminar imports de MODEL_PRICING si ya no se usan
- [ ] Documentar en CLAUDE.md que el SDK provee costo directo
- [ ] Considerar deprecar tracking de tokens en CostAccumulator

---

## Rollback Plan

Si hay problemas, revertir a la versión anterior:

```bash
git checkout HEAD~1 -- src/services/orchestration/AgentExecutorService.ts
```

La versión anterior muestra $0.0000 pero no rompe funcionalidad.

---

## Archivos Tocados (Resumen)

| Archivo | Cambios | LOC Est. |
|---------|---------|----------|
| `AgentExecutorService.ts` | 4 bloques de código | ~40 líneas |
| Ningún otro archivo necesita cambios directos | - | - |

---

**Fecha de creación:** 2026-01-22
**Fecha de actualización:** 2026-01-22 (exploración completa)
**Estado:** Pendiente de implementación
**Prioridad:** Media (UX issue, no bloquea funcionalidad)
**Dependencia:** Ninguna (puede implementarse independientemente)
**Complejidad:** Baja - Solo un archivo principal, cambios aislados
**Riesgo:** Bajo - El SDK ya acumula el costo correctamente
