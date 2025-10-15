# 🎯 Arquitectura Basada en SDK (Anthropic Official Guide)

## Principio: Dejar que el SDK haga su trabajo

Según la guía oficial de Anthropic, el SDK **ya maneja la complejidad interna**.

## 🔄 Agent Loop (Anthropic)

```
┌─────────────────┐
│ Gather Context  │ ← SDK maneja (Read, Grep, Glob)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Take Action    │ ← SDK maneja (Write, Edit, Bash)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Verify Work    │ ← Nosotros implementamos (Judge)
└─────────────────┘
```

## ✅ Lo que el SDK YA hace por nosotros

1. **Context Compaction** - Maneja contexto grande automáticamente
2. **Tool Execution** - Read, Write, Edit, Bash, Grep, Glob
3. **MCP Integrations** - GitHub API via MCP
4. **Error Handling** - Reintentos internos
5. **Streaming** - Eventos en tiempo real

## 🚫 Lo que NO debemos reimplementar

- ❌ Circuit breakers complejos (el SDK ya tiene retry logic)
- ❌ Progress monitors (el SDK emite eventos)
- ❌ Timeouts personalizados (el SDK maneja esto)
- ❌ Context management (el SDK usa context compaction)

## ✅ Lo que SÍ debemos implementar

1. **Flujo de agentes** - Orden de ejecución
2. **Judge pattern** - Verificación con otro LLM
3. **Aprobaciones humanas** - Pausas para review
4. **Persistencia** - Guardar resultados en DB

## 🎯 Arquitectura Simple y Correcta

```typescript
import { Agent } from '@anthropic-ai/agent-sdk';

class OrchestrationFlow {
  async execute(taskId: string) {
    const task = await Task.findById(taskId);

    // 1️⃣ Product Manager
    const pmAgent = new Agent({
      name: 'product-manager',
      workingDirectory: task.workspace,
      // SDK maneja TODO internamente
    });

    const pmResult = await pmAgent.run(task.prompt);
    task.productManager = { output: pmResult.output };
    await task.save();
    await this.requestApproval(task, 'PM');

    // 2️⃣ Tech Lead
    const tlAgent = new Agent({
      name: 'tech-lead',
      workingDirectory: task.workspace,
    });

    const tlResult = await tlAgent.run(buildTechLeadPrompt(task));
    const epics = JSON.parse(tlResult.output);
    task.techLead = { epics };
    await task.save();
    await this.requestApproval(task, 'TL');

    // 3️⃣ Developers (con Judge)
    for (const epic of epics) {
      await this.createBranch(epic.branchName);

      for (const story of epic.stories) {
        // Developer hace el trabajo
        const devAgent = new Agent({
          name: 'developer',
          workingDirectory: `${task.workspace}/${epic.repository}`,
        });

        const devResult = await devAgent.run(story.description);

        // ✅ VERIFY WORK (Judge Pattern - Anthropic recomienda)
        const judgeAgent = new Agent({
          name: 'judge',
          workingDirectory: `${task.workspace}/${epic.repository}`,
        });

        const judgeResult = await judgeAgent.run(
          `Review this implementation and verify it meets requirements:\n${devResult.output}`
        );

        if (!judgeResult.approved) {
          throw new Error(`Judge rejected story ${story.id}`);
        }

        story.status = 'completed';
      }
    }

    await this.requestApproval(task, 'Developers');

    // 4️⃣ QA
    const qaAgent = new Agent({
      name: 'qa-engineer',
      workingDirectory: task.workspace,
    });

    const qaResult = await qaAgent.run(buildQAPrompt(task));
    await this.requestApproval(task, 'QA');

    // 5️⃣ Merge
    await this.createPRs(task);
    await this.requestApproval(task, 'Merge');
    await this.mergePRs(task);

    task.status = 'completed';
    await task.save();
  }

  // Aprobación humana = simplemente pausar y esperar
  async requestApproval(task: Task, phase: string) {
    task.pendingApproval = phase;
    await task.save();

    // Emitir evento WebSocket
    NotificationService.emitApprovalRequired(task._id, phase);

    // Lanzar error especial que el endpoint captura
    throw new ApprovalPendingError(phase);
  }
}
```

## 📦 Attachments / Imágenes (ya funciona)

El SDK **ya soporta imágenes**. Solo pasarlas como attachments:

```typescript
const agent = new Agent({
  name: 'product-manager',
  workingDirectory: task.workspace,
});

// Pasar imágenes como attachments (SDK maneja streaming)
await agent.run(task.prompt, {
  attachments: task.attachments.map(att => ({
    type: 'image',
    data: fs.readFileSync(att.path),
    mimeType: att.mimeType
  }))
});
```

## 🔥 Circuit Breaker Mínimo

Solo necesitamos **evitar reintentos infinitos de NUESTRA orquestación**:

```typescript
class OrchestrationFlow {
  async execute(taskId: string) {
    const task = await Task.findById(taskId);

    // Circuit breaker simple: contar intentos de la fase actual
    if (!task.phaseAttempts) task.phaseAttempts = {};

    const currentPhase = this.getCurrentPhase(task);
    const attempts = task.phaseAttempts[currentPhase] || 0;

    if (attempts >= 3) {
      task.status = 'failed';
      task.error = `Phase ${currentPhase} failed after 3 attempts`;
      await task.save();
      throw new Error(`Circuit breaker: ${currentPhase} exceeded 3 attempts`);
    }

    task.phaseAttempts[currentPhase] = attempts + 1;
    await task.save();

    try {
      // Ejecutar fase...
      await this.executePhase(currentPhase, task);

      // Si tuvo éxito, resetear contador
      task.phaseAttempts[currentPhase] = 0;
      await task.save();

    } catch (error) {
      // Si falló, el contador ya está incrementado
      throw error;
    }
  }
}
```

## 🎯 Resumen: Lo que cambia

### ❌ ELIMINAR (el SDK ya lo hace)
- Event Sourcing
- DependencyResolver
- ProductivityMonitor
- Progress tracking manual
- Timeouts personalizados
- Context management manual
- 15 archivos de phases

### ✅ MANTENER (nosotros lo implementamos)
- Flujo de agentes (orden de ejecución)
- Judge pattern (verify work)
- Aprobaciones humanas (pausas)
- Persistencia (Task model)
- Circuit breaker simple (3 intentos por fase)

## 📊 Comparación

| Concepto | Actual | Según SDK Guide |
|----------|--------|-----------------|
| **Archivos** | 15+ phases | 1 orchestration file |
| **LOC** | ~5000 | ~300 |
| **Context management** | Manual (Event Store) | Automático (SDK) |
| **Error handling** | Try-catch en 20 lugares | SDK + circuit breaker simple |
| **Progress tracking** | ProductivityMonitor | SDK events |
| **Verify work** | WorkVerification service | Judge agent |
| **Attachments** | Custom logic | SDK built-in |

## 🚀 Resultado Final

**De 5000 líneas → 300 líneas**

Todo lo complejo (context, tools, streaming, MCP) lo maneja el SDK.

Nosotros solo:
1. Definir el flujo
2. Verificar con Judge
3. Pedir aprobación humana
4. Guardar en DB

**¿Es esta la arquitectura que quieres?** ✅
