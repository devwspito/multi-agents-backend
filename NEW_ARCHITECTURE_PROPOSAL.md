# Nueva Arquitectura: Flat Collections (Sin Nested Objects)

**Fecha**: 2025-10-14
**Razón**: Mongoose nested objects causan loops infinitos por persistencia no confiable

---

## ❌ Problema Actual (Arquitectura Nested)

```typescript
// ACTUAL: Todo nested en Task
Task {
  orchestration: {
    techLead: {
      epics: [{           // ⚠️ Nested array - NO persiste sin markModified()
        name: "Epic 1",
        stories: ["id1", "id2"],  // ⚠️ Nested array - NO persiste
        branches: [{...}],  // ⚠️ Nested array - NO persiste
      }],
      storiesMap: {       // ⚠️ Nested object - NO persiste
        "story1": {...}
      }
    }
  }
}
```

**Problemas**:
- ❌ `markModified()` necesario en 50+ lugares
- ❌ Olvidar un `markModified()` = loop infinito
- ❌ Arrays/objects nested no se persisten confiablemente
- ❌ Debugging imposible (¿cuál campo no se guardó?)

---

## ✅ Nueva Arquitectura (Flat Collections)

### 1. Modelo Epic (Colección separada)

```typescript
// models/Epic.ts
interface IEpic {
  _id: ObjectId;
  taskId: ObjectId;           // ✅ Referencia a Task
  name: string;
  description: string;
  branchName: string;

  // Story references (ObjectIds, no nested)
  storyIds: ObjectId[];       // ✅ Array de referencias, no objects

  // Status flags (primitives)
  branchesCreated: boolean;   // ✅ Boolean primitivo
  prCreated: boolean;         // ✅ Boolean primitivo

  // PR info (primitives)
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

### 2. Modelo Story (Colección separada)

```typescript
// models/Story.ts
interface IStory {
  _id: ObjectId;
  epicId: ObjectId;           // ✅ Referencia a Epic
  taskId: ObjectId;           // ✅ Referencia a Task

  title: string;
  description: string;

  // Assignment
  assignedTo?: string;        // Developer instance ID

  // Status (primitive)
  status: 'pending' | 'in_progress' | 'completed' | 'failed';

  // Metadata
  priority: number;
  complexity: string;
  dependencies: ObjectId[];   // ✅ Array de referencias a otras stories

  // Execution
  sessionId?: string;
  output?: string;
  error?: string;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

### 3. Task (Simplificado - solo referencias)

```typescript
// models/Task.ts (SIMPLIFIED)
interface ITask {
  _id: ObjectId;
  userId: ObjectId;
  title: string;
  description: string;

  // ✅ REFERENCIAS, no nested objects
  epicIds: ObjectId[];        // ✅ Referencias a Epic collection

  // ✅ ROOT-LEVEL FLAGS (confiables)
  techLeadCompleted: boolean;
  branchSetupCompleted: boolean;
  developmentCompleted: boolean;
  qaCompleted: boolean;
  mergeCompleted: boolean;

  // Status simple
  status: TaskStatus;
  currentPhase: string;

  // Agent metadata (SOLO primitivos)
  orchestration: {
    productManager: {
      status: string;
      output?: string;
      approved: boolean;      // ✅ Boolean primitivo
    },
    techLead: {
      status: string;
      output?: string;
      approved: boolean;      // ✅ Boolean primitivo
      // ❌ NO epics nested - usar epicIds en root
    },
    // ... otros agents
  };

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}
```

---

## 🔄 Flujo de Trabajo Nuevo

### Tech Lead Phase:
```typescript
// ANTES (nested):
task.orchestration.techLead.epics = [...]; // ⚠️ Necesita markModified()
await task.save();

// DESPUÉS (flat):
const epics = await Epic.insertMany([...]); // ✅ Persiste directamente
task.epicIds = epics.map(e => e._id);       // ✅ Solo IDs
task.techLeadCompleted = true;              // ✅ Boolean root-level
await task.save();                          // ✅ Sin markModified()
```

### Developers Phase:
```typescript
// ANTES (nested):
const epics = task.orchestration.techLead.epics || []; // ⚠️ Puede ser undefined
if (epic.stories === undefined) crash();

// DESPUÉS (flat):
const epics = await Epic.find({ taskId: task._id });  // ✅ Siempre válido
const stories = await Story.find({ epicId: epic._id }); // ✅ Siempre array
```

---

## 📊 Comparación

| Aspecto | Nested (Actual) | Flat (Propuesto) |
|---------|----------------|------------------|
| Persistencia | ❌ Requiere markModified() | ✅ Automática |
| Debugging | ❌ Imposible saber qué no se guardó | ✅ Cada collection es independiente |
| Queries | ❌ task.orchestration.techLead.epics[0] | ✅ Epic.findById() |
| Validación | ❌ Difícil validar nested | ✅ Schema validation por collection |
| Testing | ❌ Necesita mock de todo Task | ✅ Test Epic/Story independientes |
| Loops infinitos | ❌ Ocurren constantemente | ✅ Imposibles (no hay nested) |

---

## 🚀 Plan de Migración

### Fase 1: Crear Nuevos Modelos (1 hora)
- [ ] `models/Epic.ts` con schema flat
- [ ] `models/Story.ts` con schema flat
- [ ] Migration script para datos existentes

### Fase 2: Actualizar Task Model (30 min)
- [ ] Reemplazar `orchestration.techLead.epics` con `epicIds: ObjectId[]`
- [ ] Agregar boolean flags root-level
- [ ] Mantener compatibilidad temporal con campos viejos

### Fase 3: Actualizar Phases (2 horas)
- [ ] TechLeadPhase: Crear Epic/Story en collections separadas
- [ ] BranchSetupPhase: Leer Epic collection, actualizar flags
- [ ] DevelopersPhase: Leer Epic/Story collections
- [ ] QAPhase: Leer Epic collection
- [ ] Merge Phase: Leer Epic collection

### Fase 4: Testing (1 hora)
- [ ] Test unitario de cada phase con nueva arquitectura
- [ ] Test de flujo completo end-to-end
- [ ] Validar que NO hay loops

### Fase 5: Cleanup (30 min)
- [ ] Eliminar campos nested deprecated
- [ ] Eliminar markModified() calls obsoletos
- [ ] Update documentation

**Tiempo Total Estimado**: 5 horas

---

## 🎯 Beneficios Inmediatos

1. ✅ **CERO loops infinitos**: Sin nested objects, sin problemas de persistencia
2. ✅ **Debugging fácil**: Cada collection es independiente
3. ✅ **Código limpio**: No más markModified() en 50 lugares
4. ✅ **Performance**: Queries directas, no traversing de nested objects
5. ✅ **Escalabilidad**: Agregar nuevos campos es trivial

---

## ⚠️ Alternativa Rápida (Parche de Emergencia)

Si no quieres cambiar TODO ahora, puedo:

1. **Agregar validación estricta** antes de cada phase
2. **Forzar refresh** de DB antes de leer epics
3. **Logging detallado** de qué campos están undefined
4. **Auto-recovery**: Si epic.stories es undefined, re-ejecutar Tech Lead

Pero esto es **putting duct tape on a broken system**. La arquitectura flat es la solución real.

---

## 💬 Decisión

**Opción A**: Implementar arquitectura flat AHORA (5 horas de trabajo, solución permanente)

**Opción B**: Parche de emergencia (30 min, sigue siendo frágil)

**¿Qué prefieres?**
