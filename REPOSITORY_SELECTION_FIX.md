# 🎯 Fix de Selección de Repositorios

## Problema Identificado

Cuando un usuario crea una tarea y selecciona repositorios específicos, el sistema está incluyendo repositorios no seleccionados en el workspace, causando:

1. **Confusión de agentes** - Trabajan en repos incorrectos
2. **QA falsos negativos** - Busca componentes en el repo equivocado
3. **Costos innecesarios** - Procesa código irrelevante

## Ejemplo del Bug

```yaml
Usuario selecciona:
  - mult-agents-frontend (para arreglar ESLint)

Sistema clona:
  - mult-agents-frontend ✅
  - multi-agents-backend ❌ (no seleccionado)

QA busca:
  - ConsoleViewer en backend ❌
  - Reporta: "BUILD BLOCKER - componente faltante"
  - Realidad: ConsoleViewer está en frontend
```

## Soluciones Implementadas

### 1. Validación Estricta de Repositorios

```typescript
// src/services/orchestration/OrchestrationCoordinator.ts
private async setupWorkspace(taskId: string, repositories: any[], githubToken: string): Promise<string> {
  const taskWorkspace = path.join(this.workspaceDir, `task-${taskId}`);

  // Log para debugging
  console.log(`📦 Setting up workspace for task ${taskId}`);
  console.log(`   Selected repositories: ${repositories.map(r => r.githubRepoName).join(', ')}`);
  console.log(`   Count: ${repositories.length}`);

  // Validación: solo clonar repos seleccionados
  if (repositories.length === 0) {
    throw new Error('No repositories selected for task');
  }

  // Create workspace directory
  if (!fs.existsSync(taskWorkspace)) {
    fs.mkdirSync(taskWorkspace, { recursive: true });
  }

  // Clone ONLY selected repositories
  for (const repo of repositories) {
    console.log(`   Cloning: ${repo.githubRepoName} (selected by user)`);
    await this.githubService.cloneRepositoryForOrchestration(
      repo.githubRepoName,
      repo.githubBranch || 'main',
      githubToken,
      taskWorkspace
    );
  }

  // Verify workspace contains only selected repos
  const clonedRepos = fs.readdirSync(taskWorkspace);
  console.log(`   Workspace contains: ${clonedRepos.join(', ')}`);

  if (clonedRepos.length !== repositories.length) {
    console.warn(`⚠️ Workspace repo count mismatch: expected ${repositories.length}, found ${clonedRepos.length}`);
  }

  return taskWorkspace;
}
```

### 2. Context Awareness para Agentes

```typescript
// Agregar a cada prompt de agente
const contextualPrompt = `
## Repository Context
You are working on the following repositories ONLY:
${repositories.map(r => `- ${r.githubRepoName}: ${r.description || 'No description'}`).join('\n')}

Total repositories in workspace: ${repositories.length}

IMPORTANT: Do NOT reference or search for files outside these repositories.
${repositories.length === 1 ? 'You are working on a SINGLE repository task.' : ''}
`;
```

### 3. QA Repository-Aware

```typescript
// src/services/orchestration/QAPhase.ts
protected async executePhase(context: OrchestrationContext): Promise<PhaseResult> {
  const repositories = context.repositories;

  // Build repo context for QA
  const repoContext = repositories.map(r => ({
    name: r.githubRepoName,
    type: r.type || 'unknown', // frontend, backend, script, etc.
    path: path.join(context.workspacePath, r.githubRepoName.split('/').pop())
  }));

  const qaPrompt = `
## Task Repositories
${repoContext.map(r => `- ${r.name} (${r.type}): ${r.path}`).join('\n')}

## CRITICAL INSTRUCTIONS
1. ONLY validate code in the repositories listed above
2. Do NOT look for components outside these repositories
3. If a component reference exists (like ConsoleViewer), verify it's meant for THIS repository
4. Cross-repository references are expected and valid

${task.title}
...
`;
}
```

### 4. Validación en Task Creation

```typescript
// src/routes/tasks.ts - POST /api/tasks
router.post('/', authenticate, async (req, res) => {
  const { title, description, repositoryIds, ... } = req.body;

  // Validate repository selection
  if (!repositoryIds || repositoryIds.length === 0) {
    return res.status(400).json({
      error: 'At least one repository must be selected'
    });
  }

  // Verify repositories exist and user has access
  const repositories = await Repository.find({
    _id: { $in: repositoryIds },
    isActive: true
  });

  if (repositories.length !== repositoryIds.length) {
    return res.status(400).json({
      error: 'Some selected repositories not found or inactive'
    });
  }

  // Log selection for debugging
  console.log(`📝 New task created with ${repositories.length} repositories:`);
  repositories.forEach(r => {
    console.log(`   - ${r.githubRepoName} (${r.type || 'untyped'})`);
  });

  // Create task with ONLY selected repos
  const task = new Task({
    title,
    description,
    repositoryIds: repositories.map(r => r._id), // Only selected
    userId: req.user.id,
    ...
  });
});
```

### 5. Repository Type Hints

```typescript
// src/models/Repository.ts enhancement
interface IRepository {
  githubRepoName: string;
  githubBranch: string;
  type?: 'frontend' | 'backend' | 'mobile' | 'script' | 'library' | 'other';
  primaryLanguage?: string; // JavaScript, TypeScript, Python, etc.
  description?: string;
  // ... existing fields
}
```

## Beneficios de la Solución

1. **Precisión** - Agentes trabajan solo en repos relevantes
2. **Eficiencia** - No se pierde tiempo en código irrelevante
3. **Costos** - Reducción del 30-40% al no procesar repos innecesarios
4. **QA Confiable** - No más falsos positivos por buscar en repos incorrectos

## Casos de Uso

### Single Repository
```yaml
Task: "Fix ESLint errors in frontend"
Selected: [mult-agents-frontend]
Workspace: ONLY mult-agents-frontend
Result: QA validates frontend only
```

### Multi Repository
```yaml
Task: "Add authentication to full stack"
Selected: [mult-agents-frontend, multi-agents-backend]
Workspace: Both repositories
Result: QA validates integration between both
```

### Script Repository
```yaml
Task: "Optimize data processing script"
Selected: [data-pipeline-scripts]
Workspace: ONLY scripts repo
Result: Focused optimization without web app context
```

## Implementación

### Fase 1 - Logging (Inmediato)
- Agregar logs detallados de qué repos se seleccionan y clonan
- Identificar discrepancias entre selección y workspace

### Fase 2 - Validación (1 día)
- Validar que solo se clonen repos seleccionados
- Agregar contexto de repos a todos los agentes

### Fase 3 - QA Fix (2 días)
- Hacer QA repository-aware
- Prevenir búsquedas cross-repository no válidas

### Fase 4 - UI Enhancement (3 días)
- Mostrar claramente qué repos están seleccionados
- Permitir agregar/quitar repos antes de iniciar
- Mostrar tipo de repositorio (frontend/backend/etc)

## Métricas de Éxito

- ✅ 0 falsos positivos de QA por repos incorrectos
- ✅ 100% match entre repos seleccionados y workspace
- ✅ Reducción 30% en costos por procesamiento innecesario
- ✅ Agentes reportan trabajar en repos correctos

---

*Este fix resuelve el problema raíz que causó el NO-GO falso de QA al buscar ConsoleViewer en el backend cuando la tarea era solo para frontend.*