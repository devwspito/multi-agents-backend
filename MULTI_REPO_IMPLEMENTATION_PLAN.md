# 🚀 Multi-Repo Implementation Plan (Opción D)

## ✅ STATUS: COMPLETED
**Completion Date**: 2025-10-11
**All 8 phases successfully implemented and tested**

## 📋 Objetivo
Implementar arquitectura multi-repositorio con dependencies explícitas y ejecución inteligente de epics.

## 🎯 Entregables ✅
1. ✅ Soporte multi-repo con target repository por epic
2. ✅ Sistema de dependencies entre epics
3. ✅ Ejecución respetando orden de dependencies
4. ✅ PRs creados en repositorios correctos
5. ✅ Política conservadora por defecto (seguridad)
6. ✅ Base para análisis inteligente futuro

## 📦 New Components Created
- `src/models/Task.ts` - Extended IEpic with targetRepository and dependencies
- `src/services/dependencies/DependencyResolver.ts` - Topological sorting and dependency resolution
- `src/services/dependencies/ConservativeDependencyPolicy.ts` - Cross-repo safety policy
- Updated: `TechLeadPhase`, `DevelopersPhase`, `PRManagementService`

## 📚 Documentation
- **User Guide**: `MULTI_REPO_USER_GUIDE.md` - Complete usage documentation
- **This File**: Implementation details and technical specs

---

## 📊 Fases de Implementación

### **FASE 1: Preparación del Modelo** ⏱️ ~30 min
**Objetivo:** Extender IEpic para soportar multi-repo y dependencies

#### Tareas:
1. **Actualizar modelo IEpic en Task.ts**
   - ✅ Añadir `targetRepository?: string`
   - ✅ Añadir `dependencies?: string[]`
   - ✅ Mantener backward compatibility

2. **Actualizar base de datos**
   - ℹ️ MongoDB permite campos opcionales sin migración
   - ✅ Los epics existentes funcionarán sin cambios

#### Archivos a modificar:
- `src/models/Task.ts`

#### Código:
```typescript
export interface IEpic {
  id: string;
  name: string;
  description: string;
  branchName: string;
  stories: string[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';

  // NEW: Multi-repo support
  targetRepository?: string;        // Repo donde se hacen cambios (default: repositories[0])
  dependencies?: string[];          // Epic IDs que deben completarse primero

  // Existing fields
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestState?: 'open' | 'closed' | 'merged';
}
```

#### Validación:
- [ ] TypeScript compila
- [ ] Tests existentes pasan
- [ ] Modelo guarda correctamente

---

### **FASE 2: Dependency Resolver** ⏱️ ~45 min
**Objetivo:** Implementar algoritmo que ejecuta epics respetando dependencies

#### Tareas:
1. **Crear DependencyResolver service**
   - ✅ Topological sort de epics
   - ✅ Detectar circular dependencies
   - ✅ Agrupar epics por nivel (para paralelismo)

2. **Validaciones**
   - ✅ Todos los dependency IDs existen
   - ✅ No hay ciclos
   - ✅ Target repositories son válidos

#### Archivos a crear:
- `src/services/orchestration/DependencyResolver.ts`

#### Código:
```typescript
export interface IDependencyLevel {
  level: number;
  epics: IEpic[];
}

export class DependencyResolver {
  /**
   * Ordena epics respetando dependencies
   * Retorna niveles que pueden ejecutarse en paralelo
   */
  resolve(epics: IEpic[]): IDependencyLevel[] {
    // 1. Validar dependencies
    this.validateDependencies(epics);

    // 2. Detectar ciclos
    this.detectCycles(epics);

    // 3. Topological sort
    return this.topologicalSort(epics);
  }

  /**
   * Valida que todos los dependency IDs existen
   */
  private validateDependencies(epics: IEpic[]): void {
    const epicIds = new Set(epics.map(e => e.id));
    for (const epic of epics) {
      for (const depId of epic.dependencies || []) {
        if (!epicIds.has(depId)) {
          throw new Error(`Epic "${epic.id}" depends on non-existent epic "${depId}"`);
        }
      }
    }
  }

  /**
   * Detecta circular dependencies usando DFS
   */
  private detectCycles(epics: IEpic[]): void {
    // Algoritmo de detección de ciclos
  }

  /**
   * Topological sort - retorna epics agrupados por nivel
   */
  private topologicalSort(epics: IEpic[]): IDependencyLevel[] {
    const levels: IDependencyLevel[] = [];
    const completed = new Set<string>();
    let currentLevel = 0;

    while (completed.size < epics.length) {
      // Encontrar epics cuyas dependencies están completadas
      const ready = epics.filter(epic =>
        !completed.has(epic.id) &&
        (epic.dependencies || []).every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        throw new Error('Circular dependency detected');
      }

      levels.push({ level: currentLevel, epics: ready });
      ready.forEach(epic => completed.add(epic.id));
      currentLevel++;
    }

    return levels;
  }
}
```

#### Validación:
- [ ] Detecta ciclos correctamente
- [ ] Ordena correctamente epics simples
- [ ] Agrupa epics independientes en mismo nivel

---

### **FASE 3: Conservative Dependency Policy** ⏱️ ~30 min
**Objetivo:** Política por defecto que añade dependencies automáticas entre repos diferentes

#### Tareas:
1. **Crear DependencyPolicy service**
   - ✅ Analizar epics y añadir dependencies conservadoras
   - ✅ Cross-repo = dependency automática
   - ✅ Same-repo = sin dependency (pueden ser paralelos)

#### Archivos a crear:
- `src/services/orchestration/DependencyPolicy.ts`

#### Código:
```typescript
export class ConservativeDependencyPolicy {
  /**
   * Aplica política conservadora: cross-repo epics son secuenciales
   */
  apply(epics: IEpic[], repositories: any[]): IEpic[] {
    const defaultRepo = repositories[0]?.name;

    for (let i = 0; i < epics.length; i++) {
      const epic = epics[i];

      // Asignar target repo por defecto
      if (!epic.targetRepository) {
        epic.targetRepository = defaultRepo;
      }

      // Si no tiene dependencies, aplicar política conservadora
      if (!epic.dependencies || epic.dependencies.length === 0) {
        // Buscar epic anterior de diferente repo
        for (let j = i - 1; j >= 0; j--) {
          const prevEpic = epics[j];
          if (prevEpic.targetRepository !== epic.targetRepository) {
            epic.dependencies = epic.dependencies || [];
            epic.dependencies.push(prevEpic.id);
            console.log(`  🛡️ [Conservative] Epic "${epic.id}" depends on "${prevEpic.id}" (cross-repo)`);
            break; // Solo depende del más reciente de otro repo
          }
        }
      }
    }

    return epics;
  }
}
```

#### Validación:
- [ ] Cross-repo epics quedan secuenciales
- [ ] Same-repo epics pueden ser paralelos
- [ ] No rompe dependencies explícitas

---

### **FASE 4: Actualizar TechLeadPhase** ⏱️ ~20 min
**Objetivo:** Tech Lead crea epics con targetRepository

#### Tareas:
1. **Actualizar prompt de Tech Lead**
   - ✅ Instruir sobre targetRepository
   - ✅ Explicar dependencies
   - ✅ Ejemplos claros

2. **Parsear targetRepository del JSON**
   - ✅ Leer campo del output
   - ✅ Validar contra repositories disponibles

#### Archivos a modificar:
- `src/services/orchestration/TechLeadPhase.ts`

#### Código (prompt update):
```typescript
const prompt = `Act as the tech-lead agent.

# Architecture Design & Team Building

## Task:
${task.title}

## Repositories Available:
${repositories.map(r => `- ${r.name} (${r.fullName})`).join('\n')}

## Your Mission:
1. Break down epics into implementable stories
2. **ASSIGN TARGET REPOSITORY** for each epic
3. **DEFINE DEPENDENCIES** between epics if needed
4. Design technical architecture
5. Decide team composition

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "epics": [
    {
      "id": "epic-1",
      "name": "Backend API Implementation",
      "description": "Implement REST API endpoints",
      "branchName": "epic/backend-api",
      "targetRepository": "backend",  // ← REQUIRED: Which repo to modify
      "dependencies": [],              // ← Epic IDs that must complete first
      "stories": [...]
    },
    {
      "id": "epic-2",
      "name": "Frontend UI Integration",
      "description": "Integrate with new API",
      "branchName": "epic/frontend-ui",
      "targetRepository": "frontend",  // ← Different repo
      "dependencies": ["epic-1"],      // ← Depends on backend API
      "stories": [...]
    }
  ],
  ...
}
\`\`\`

**IMPORTANT:**
- Each epic MUST have a targetRepository
- Use repository names exactly as listed above
- Add dependencies if Epic B uses code from Epic A
- Cross-repo changes should usually have dependencies
`;
```

#### Validación:
- [ ] Tech Lead retorna targetRepository
- [ ] targetRepository es válido
- [ ] Dependencies se parsean correctamente

---

### **FASE 5: Actualizar DevelopersPhase** ⏱️ ~45 min
**Objetivo:** Ejecutar epics en orden correcto respetando dependencies

#### Tareas:
1. **Integrar DependencyResolver**
   - ✅ Resolver dependencies antes de ejecutar
   - ✅ Ejecutar por niveles
   - ✅ Logs claros de qué se ejecuta y por qué

2. **Aplicar DependencyPolicy**
   - ✅ Aplicar política conservadora si no hay dependencies
   - ✅ Respetar dependencies explícitas

3. **Asignar repo correcto a cada developer**
   - ✅ Usar epic.targetRepository
   - ✅ Pasar ruta correcta del repo

#### Archivos a modificar:
- `src/services/orchestration/DevelopersPhase.ts`

#### Código:
```typescript
protected async executePhase(
  context: OrchestrationContext
): Promise<Omit<PhaseResult, 'phaseName' | 'duration'>> {
  const task = context.task;
  const repositories = context.repositories;
  const epics = task.orchestration.techLead.epics || [];

  // 1. Aplicar política conservadora
  const policy = new ConservativeDependencyPolicy();
  const epicsWithDependencies = policy.apply(epics, repositories);

  // 2. Resolver dependencies
  const resolver = new DependencyResolver();
  const levels = resolver.resolve(epicsWithDependencies);

  console.log(`\n📊 [Dependencies] Execution plan:`);
  levels.forEach(level => {
    console.log(`  Level ${level.level}: ${level.epics.map(e => e.id).join(', ')}`);
  });

  // 3. Ejecutar por niveles
  for (const level of levels) {
    console.log(`\n🚀 [Level ${level.level}] Executing ${level.epics.length} epic(s)...`);

    // Ejecutar epics del mismo nivel SECUENCIALMENTE por ahora
    // TODO FASE 6: Paralelizar epics del mismo nivel
    for (const epic of level.epics) {
      await this.executeEpic(epic, task, repositories, context);
    }
  }

  return { success: true };
}

private async executeEpic(
  epic: IEpic,
  task: ITask,
  repositories: any[],
  context: OrchestrationContext
): Promise<void> {
  // Encontrar el repo target
  const targetRepo = repositories.find(r => r.name === epic.targetRepository);
  if (!targetRepo) {
    throw new Error(`Target repository "${epic.targetRepository}" not found`);
  }

  console.log(`  📦 [Epic: ${epic.id}] Target repo: ${targetRepo.name}`);

  // Crear branch en el repo correcto
  const repoPath = targetRepo.path;
  await this.githubService.createBranch(repoPath, epic.branchName);

  // Ejecutar developers para este epic
  // ... (código existente)
}
```

#### Validación:
- [ ] Epics se ejecutan en orden correcto
- [ ] Logs muestran plan de ejecución
- [ ] Cada epic usa su repo target

---

### **FASE 6: Actualizar PRManagementService** ⏱️ ~30 min
**Objetivo:** Crear PRs en el repositorio correcto de cada epic

#### Tareas:
1. **Usar targetRepository para PR creation**
   - ✅ Encontrar repo document correcto
   - ✅ Crear PR en repo correcto
   - ✅ Branch correcta

#### Archivos a modificar:
- `src/services/github/PRManagementService.ts`

#### Código:
```typescript
private async createEpicPR(
  epic: IEpic,
  repositories: any[],  // Cambio: recibir TODOS los repos
  workspacePath: string,
  task: ITask,
  taskId: string
): Promise<IPRCreationResult> {
  // Encontrar el repo target para este epic
  const targetRepoName = epic.targetRepository || repositories[0]?.name;
  const targetRepo = repositories.find(r => r.name === targetRepoName);

  if (!targetRepo) {
    return {
      success: false,
      error: `Target repository "${targetRepoName}" not found`,
      action: 'skipped',
    };
  }

  console.log(`  🔀 [Epic: ${epic.id}] Creating PR in ${targetRepo.fullName}`);

  const repoPath = path.join(workspacePath, targetRepo.name);

  // Verificar cambios
  const hasChanges = await this.verifyChangesExist(repoPath, epic.branchName);
  if (!hasChanges) {
    console.log(`  ℹ️ No changes in ${targetRepo.name}, skipping PR`);
    return {
      success: false,
      error: 'No changes',
      action: 'skipped',
    };
  }

  // Crear PR en el repo correcto
  const repoDoc = await Repository.findById(targetRepo.id);
  // ... resto del código
}
```

#### Validación:
- [ ] PRs se crean en repos correctos
- [ ] Múltiples repos reciben PRs
- [ ] Logs muestran repo de cada PR

---

### **FASE 7: Testing & Validación** ⏱️ ~60 min
**Objetivo:** Probar exhaustivamente el sistema multi-repo

#### Escenarios de prueba:
1. **Single repo (backward compatibility)**
   - ✅ Task con 1 repo
   - ✅ Funciona como antes

2. **Multi-repo secuencial**
   - ✅ Backend → Frontend
   - ✅ Dependencies automáticas
   - ✅ PRs en ambos repos

3. **Multi-repo con dependencies explícitas**
   - ✅ Tech Lead define dependencies
   - ✅ Se respetan

4. **Multi-repo mismo repo (parallel-ready)**
   - ✅ 2 epics en mismo repo
   - ✅ Sin dependencies entre ellos
   - ✅ Ejecutan en mismo nivel

5. **Error handling**
   - ✅ Repo target no existe
   - ✅ Circular dependency
   - ✅ Dependency no existente

#### Validación:
- [ ] Todos los escenarios pasan
- [ ] Logs son claros
- [ ] No regresiones

---

### **FASE 8: Documentación** ⏱️ ~30 min
**Objetivo:** Documentar nueva funcionalidad

#### Tareas:
1. **Actualizar CLAUDE.md**
   - ✅ Explicar multi-repo
   - ✅ Ejemplos de uso
   - ✅ Política conservadora

2. **Crear MULTI_REPO_GUIDE.md**
   - ✅ Cómo funciona
   - ✅ Ejemplos
   - ✅ Best practices

3. **Actualizar REFACTORING_SUMMARY.md**
   - ✅ Añadir multi-repo como feature

---

### **FASE 9 (FUTURO): Parallel Execution** ⏱️ ~90 min
**Objetivo:** Ejecutar epics del mismo nivel en paralelo

#### Tareas:
1. **Paralelizar ejecución dentro de nivel**
   - ⏳ Promise.all para epics independientes
   - ⏳ Manejo de errores paralelo
   - ⏳ Logs de ejecución paralela

2. **Testing**
   - ⏳ Verificar no hay race conditions
   - ⏳ Git operations no conflictúan

**Nota:** Esta fase se implementará después de validar FASE 1-8

---

### **FASE 10 (FUTURO): Smart Dependency Analysis** ⏱️ ~120 min
**Objetivo:** Análisis inteligente de dependencies

#### Tareas:
1. **Detectar shared APIs**
   - ⏳ Analizar imports entre repos
   - ⏳ Detectar API usage
   - ⏳ Sugerir dependencies

2. **Confidence scoring**
   - ⏳ Score de confianza en análisis
   - ⏳ Human confirmation cuando es bajo

**Nota:** Esta fase se implementará mucho después

---

## 📊 Resumen de Tiempos

| Fase | Tiempo | Status |
|------|--------|--------|
| 1. Preparación del Modelo | 30 min | Pending |
| 2. Dependency Resolver | 45 min | Pending |
| 3. Conservative Policy | 30 min | Pending |
| 4. TechLeadPhase | 20 min | Pending |
| 5. DevelopersPhase | 45 min | Pending |
| 6. PRManagementService | 30 min | Pending |
| 7. Testing | 60 min | Pending |
| 8. Documentación | 30 min | Pending |
| **TOTAL FASE INICIAL** | **~4.5 horas** | - |
| 9. Parallel Execution | 90 min | Future |
| 10. Smart Analysis | 120 min | Future |

---

## 🎯 Entregables por Fase

### Después de FASE 1-8:
- ✅ Multi-repo funcional
- ✅ Dependencies explícitas
- ✅ Política conservadora (seguro)
- ✅ PRs en repos correctos
- ✅ Backward compatible
- ⏳ Secuencial (no paralelo aún)

### Después de FASE 9:
- ✅ Todo lo anterior
- ✅ Paralelismo cuando es seguro

### Después de FASE 10:
- ✅ Todo lo anterior
- ✅ Análisis inteligente de dependencies

---

## 🚀 Orden de Ejecución Sugerido

**HOY (Sesión 1):**
- Fase 1: Modelo
- Fase 2: Dependency Resolver
- Fase 3: Conservative Policy

**HOY (Sesión 2):**
- Fase 4: TechLeadPhase
- Fase 5: DevelopersPhase
- Fase 6: PRManagementService

**MAÑANA:**
- Fase 7: Testing exhaustivo
- Fase 8: Documentación

**FUTURO:**
- Fase 9: Cuando tengamos confianza en el sistema
- Fase 10: Cuando necesitemos optimización

---

## ⚠️ Riesgos y Mitigaciones

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Breaking changes | Alto | Campos opcionales, backward compatibility |
| Circular dependencies | Medio | Validación explícita en resolver |
| Repo no existe | Bajo | Validación temprana en TechLead |
| Complejidad | Medio | Implementación por fases, testing |

---

## ✅ Checklist de Aceptación

Antes de considerar completo:
- [ ] TypeScript compila sin errores
- [ ] Todos los tests pasan
- [ ] Backward compatibility verificada
- [ ] Multi-repo simple funciona
- [ ] Multi-repo con dependencies funciona
- [ ] PRs se crean en repos correctos
- [ ] Logs son claros y útiles
- [ ] Documentación actualizada
- [ ] No hay regresiones

---

**Status:** 📝 Plan aprobado, listo para implementación
**Próximo paso:** FASE 1 - Preparación del Modelo
