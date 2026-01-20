# Plan de Corrección de Bugs - Priorizado

**Extraído de**: RECOVERY_SYSTEM_NOTES.md + INTEGRATION_PHASE_DESIGN.md
**Fecha**: 2026-01-20

---

## Prioridad 0: CRÍTICO (Bloquea el sistema)

### 0.1 MongoDB Bloqueando el Sistema
**Impacto**: Timeouts causan que el sistema se cuelgue
**Archivos**: PlanningPhase.ts, TechLeadPhase.ts, DevelopersPhase.ts, JudgePhase.ts, GranularMemoryService.ts

- [ ] Cambiar `await store()` a fire-and-forget en todas las fases
- [ ] Implementar buffer local en GranularMemoryService
- [ ] Crear fallback a JSONL local si MongoDB falla
- [ ] Añadir background sync a MongoDB (cada 5s)

**Estimación**: 2-3 horas

---

## Prioridad 1: ALTA (Causa pérdida de trabajo)

### 1.1 Git Local/Remote Desync
**Impacto**: Workspace local no tiene el código que está en GitHub
**Archivos**: TeamOrchestrationPhase.ts

- [ ] Hacer `git pull` después de cada push para mantener local sincronizado
- [ ] Verificar que local == remote después de cada operación
- [ ] Implementar `postMergeSync()` function

**Estimación**: 1 hora

### 1.2 Story Branch Naming Fallback Incorrecto
**Impacto**: Merges fallan porque buscan branches que no existen
**Archivo**: TeamOrchestrationPhase.ts línea 1669

- [ ] Arreglar fallback para usar execution-map/EventStore
- [ ] Buscar en git remoto como último recurso
- [ ] NO usar fallback incorrecto, solo warning

**Estimación**: 1-2 horas

### 1.3 Commits Sin Push
**Impacto**: Código existe localmente pero no llega a GitHub
**Archivo**: TeamOrchestrationPhase.ts

- [ ] Implementar `verifyStoryPushed()` después de cada story
- [ ] Añadir background checker para unpushed commits
- [ ] Warning si hay commits sin push por >5 minutos

**Estimación**: 1-2 horas

---

## Prioridad 2: MEDIA (Mejora reliability)

### 2.1 IntegrationPhase (NUEVA)
**Impacto**: Evita merge conflicts al combinar epics
**Archivos**: Nuevo IntegrationPhase.ts

- [ ] Crear ConflictResolver para index.ts files
- [ ] Crear IntegrationValidator (run build)
- [ ] Crear IntegrationDeveloper (fix TS errors)
- [ ] Integrar en OrchestrationCoordinator

**Estimación**: 4-6 horas (ya diseñado en INTEGRATION_PHASE_DESIGN.md)

### 2.2 ReconciliationService
**Impacto**: Auto-repara desync entre Git/MongoDB
**Archivo**: Nuevo ReconciliationService.ts

- [ ] Comparar estado git vs MongoDB
- [ ] Auto-corregir discrepancias
- [ ] Ejecutar al final de cada task

**Estimación**: 3-4 horas

### 2.3 EpicPRReconciliationPhase
**Impacto**: Asegura que todos los epics tengan PRs
**Archivo**: Nuevo EpicPRReconciliationPhase.ts

- [ ] Listar epic branches sin PR
- [ ] Crear PRs faltantes automáticamente
- [ ] Ejecutar después de AutoMergePhase

**Estimación**: 2-3 horas

### 2.4 Timeout != Fallo
**Impacto**: Evita marcar como fallido trabajo que solo fue lento
**Archivos**: Multiple phases

- [ ] Modificar lógica: timeout = "verificación inconclusa"
- [ ] Aumentar timeouts a 45-60 segundos
- [ ] 3 reintentos con 5s de espera
- [ ] Implementar `Promise.allSettled` para stories

**Estimación**: 2-3 horas

---

## Prioridad 3: MEJORAS (Nice to have)

### 3.1 GranularMemory Completo
**Impacto**: Mejor debugging y recovery
**Archivo**: GranularMemoryService.ts

- [ ] Integrar storeFileChange() en CADA Write/Edit
- [ ] Integrar logging en CADA git operation
- [ ] Llamar storeError() en CADA catch/timeout
- [ ] Crear checkpoints después de cada story
- [ ] Guardar agent transcripts completos

**Estimación**: 4-5 horas

### 3.2 LocalSnapshotService (Event Sourcing)
**Impacto**: Recovery completo desde archivos locales
**Archivo**: Nuevo LocalSnapshotService.ts

- [ ] Guardar CADA tool call y result
- [ ] Guardar CADA git operation
- [ ] Crear CLI para inspeccionar snapshots
- [ ] Implementar recovery desde snapshot

**Estimación**: 6-8 horas

### 3.3 GitRetryService
**Impacto**: Reintentos automáticos de operaciones git
**Archivo**: Nuevo GitRetryService.ts

- [ ] Circuit breaker pattern
- [ ] Exponential backoff
- [ ] Background processor para deferred operations
- [ ] Métricas de retry

**Estimación**: 4-5 horas

### 3.4 Frontend Improvements
**Impacto**: Mejor visibilidad del estado
**Archivos**: Frontend components

- [ ] PlanningVsRealityView component
- [ ] Highlight discrepancias
- [ ] Botón "Create Missing PR"
- [ ] Botón "Retry" para operaciones fallidas

**Estimación**: 6-8 horas

---

## Orden de Implementación Sugerido

### Fase 1: Estabilidad (Esta semana)
1. **P0.1** MongoDB fire-and-forget (URGENTE)
2. **P1.1** Git local/remote sync
3. **P1.2** Story branch naming fix
4. **P1.3** Verificar commits pusheados

### Fase 2: Recovery (Próxima semana)
5. **P2.1** IntegrationPhase
6. **P2.2** ReconciliationService
7. **P2.4** Timeout handling

### Fase 3: Mejoras (Siguientes semanas)
8. **P2.3** EpicPRReconciliationPhase
9. **P3.1** GranularMemory completo
10. **P3.2** LocalSnapshotService
11. **P3.3** GitRetryService
12. **P3.4** Frontend improvements

---

## Dependencias entre tareas

```
P0.1 (MongoDB) ──────────────────────────────────────────┐
                                                         │
P1.1 (Git sync) ─────┐                                   │
P1.2 (Branch names) ─┼──> P2.2 (Reconciliation) ─────────┤
P1.3 (Push verify) ──┘                                   │
                                                         ▼
P2.4 (Timeouts) ─────────────────────────────> P3.3 (GitRetry)
                                                         │
P2.1 (Integration) ───────> P2.3 (PR Reconcil) ──────────┤
                                                         │
P3.1 (GranularMem) ─────────> P3.2 (LocalSnapshot) ──────┘
```

---

## Quick Wins (< 30 min cada una)

1. **Aumentar timeouts** en git operations (15s → 60s)
2. **Añadir git fetch origin** antes de operaciones
3. **Log branchName** cuando se usa fallback
4. **Quitar `await`** de `granularMemoryService.store()` (fire-and-forget)

---

## Métricas de Éxito

| Métrica | Antes | Objetivo |
|---------|-------|----------|
| Tasks que completan sin intervención | ~60% | >90% |
| Epics con PRs creados | ~85% | 100% |
| Local/GitHub sync issues | Frecuente | Raro |
| MongoDB timeouts | Frecuente | 0 |
| Recovery manual necesario | Frecuente | Casi nunca |
