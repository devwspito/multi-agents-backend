# 🔄 Plan de Refactor Completo - Sistema Multi-Agente

## 📋 Objetivo

Transformar el sistema actual para:
1. ✅ Eliminar diferenciación junior/senior → solo "developer"
2. ✅ Agregar Judge agent para evaluar código
3. ⚠️ Implementar retry con feedback del Judge
4. ⚠️ Agregar aprobación humana después de cada agente
5. ✅ Reforzar prompts: devs DEBEN escribir código real
6. ✅ Tech Lead: especificar archivos exactos a leer
7. ⚠️ Guardar nombres exactos de branches por repo
8. ⚠️ Asegurar multi-repo paralelo

## ✅ Cambios Completados

### 1. Modelo de Datos (Task.ts)
- ✅ Cambio `AgentType`: agregado 'developer' y 'judge', eliminado 'senior-developer' y 'junior-developer'
- ✅ `IStory`: agregado `judgeStatus`, `judgeComments`, `judgeIterations`
- ✅ `ITeamMember`: cambiado a solo `agentType: 'developer'`
- ✅ `IOrchestration`: agregado `judge` agent, `epicBranches` tracking
- ✅ `teamComposition`: cambiado de `seniors/juniors` a `developers`

### 2. Prompts de Agentes (TeamOrchestrator.ts - getAgentDefinitions())
- ✅ **project-manager**: actualizado para recomendar "developers" (no seniors/juniors)
- ✅ **tech-lead**: TOTALMENTE REESCRITO con:
  - Instrucciones para explorar codebase con Bash/Read/Grep
  - Crear branches con `git checkout -b`
  - Especificar archivos EXACTOS para cada story
  - Output JSON con `exactFilesToRead`, `exactFilesToModify`, `exactFilesToCreate`
  - Branch tracking por repositorio
- ✅ **developer**: UNIFICADO (eliminado senior/junior) con:
  - PROHIBICIÓN ABSOLUTA de crear documentación
  - OBLIGACIÓN de escribir código ejecutable
  - Ejemplos de código CORRECTO vs INCORRECTO
  - Advertencia: "IF YOU FAIL TO WRITE ACTUAL CODE, THE JUDGE WILL REJECT YOUR WORK"
- ✅ **judge**: CREADO con:
  - 5 criterios de evaluación estrictos
  - Output JSON estructurado con status (approved/changes_requested)
  - Feedback detallado file por file
  - Acciones concretas para retry

## ⚠️ Cambios Pendientes (Archivo Roto)

### 3. Código de Orquestación (TeamOrchestrator.ts)

**PROBLEMA**: El archivo se rompió en la línea 920 debido a un error de sintaxis en la string template.

**SOLUCIÓN NECESARIA**:

#### A. Restaurar función `executeTechLead()`

El prompt dinámico en línea 877-919 necesita actualizarse:

```typescript
const prompt = `# Architecture Design & Team Building

## Task:
${task.title}

## Stories to Implement:
${stories.map((s, i) => `${i + 1}. **${s.title}** (${s.estimatedComplexity})\n   ${s.description}`).join('\n')}

## Recommended Team Size:
- Developers: ${recommendedTeam?.developers || 2}
- Reasoning: ${recommendedTeam?.reasoning || 'Not specified'}
${workspaceInfo}

## Your Mission:
1. Design technical architecture
2. Decide final team composition (number of developers)
3. Assign each story to a specific developer (dev-1, dev-2, etc.)
4. For EACH story, specify EXACT files to read, modify, and create

**RESPOND ONLY WITH VALID JSON** in this exact format:
\`\`\`json
{
  "architectureDesign": "Technical design details...",
  "teamComposition": {
    "developers": 2,
    "reasoning": "Why this team size"
  },
  "storyAssignments": [
    {
      "storyId": "story-1",
      "assignedTo": "dev-1",
      "exactFilesToRead": ["src/services/AuthService.ts"],
      "exactFilesToModify": ["src/routes/auth.ts"],
      "exactFilesToCreate": ["src/middleware/authenticate.ts"]
    }
  ]
}
\`\`\`

**Rules**:
- Use instanceIds like "dev-1", "dev-2", "dev-3", etc.
- ALL stories MUST be assigned to developers
- For EACH assignment, specify EXACT files (full paths)`;
```

Cambiar también líneas 955 y 964 que usan `seniors`/`juniors`:

```typescript
// ANTES (línea 955):
console.log(`✅ [Tech Lead] Team composition: ${parsed.teamComposition.seniors} seniors, ${parsed.teamComposition.juniors} juniors`);

// DESPUÉS:
console.log(`✅ [Tech Lead] Team composition: ${parsed.teamComposition.developers} developers`);

// ANTES (línea 964):
`Architecture designed. Team: ${parsed.teamComposition.seniors} seniors, ${parsed.teamComposition.juniors} juniors. Stories assigned.`

// DESPUÉS:
`Architecture designed. Team: ${parsed.teamComposition.developers} developers. Stories assigned.`
```

#### B. Actualizar función `spawnDevelopmentTeam()` (líneas 980-1044)

Cambiar lógica de creación de team:

```typescript
private async spawnDevelopmentTeam(
  task: ITask,
  repositories: any[],
  workspacePath: string | null,
  workspaceStructure: string
): Promise<void> {
  console.log(`👥 [Development Team] Spawning team members...`);

  const composition = task.orchestration.techLead.teamComposition;
  const assignments = task.orchestration.techLead.storyAssignments || [];

  if (!composition) {
    throw new Error('Team composition not defined by Tech Lead');
  }

  const team: ITeamMember[] = [];

  // Crear developers (NO seniors/juniors)
  for (let i = 0; i < (composition.developers || 0); i++) {
    const instanceId = `dev-${i + 1}`;
    const assignedStories = assignments
      .filter((a) => a.assignedTo === instanceId)
      .map((a) => a.storyId);

    team.push({
      agentType: 'developer',
      instanceId,
      assignedStories,
      status: 'idle',
      pullRequests: [],
    });
  }

  task.orchestration.team = team;
  await task.save();

  console.log(`✅ Team spawned: ${team.length} developers`);

  // EJECUTAR SECUENCIALMENTE
  for (const member of team) {
    await this.executeDeveloper(task, member, repositories, workspacePath, workspaceStructure);
  }

  // NO HAY CODE REVIEWS de seniors → ahora es Judge
  // await this.executeCodeReviews(task, repositories, workspacePath); // ELIMINAR

  console.log(`✅ [Development Team] All stories implemented`);
}
```

#### C. Actualizar función `executeDeveloper()` (líneas 1048-1175)

Cambiar lógica:

```typescript
private async executeDeveloper(
  task: ITask,
  member: ITeamMember,
  repositories: any[],
  workspacePath: string | null,
  workspaceStructure: string
): Promise<void> {
  const taskId = (task._id as any).toString();
  const displayName = `Developer (${member.instanceId})`;

  console.log(`👨‍💻 [${member.instanceId}] Starting work on ${member.assignedStories.length} stories...`);

  member.status = 'working';
  member.startedAt = new Date();
  await task.save();

  NotificationService.emitAgentStarted(taskId, displayName);

  try {
    const stories = task.orchestration.projectManager.stories || [];

    for (const storyId of member.assignedStories) {
      const story = stories.find((s) => s.id === storyId);
      if (!story) continue;

      console.log(`  📝 [${member.instanceId}] Working on: ${story.title}`);
      NotificationService.emitAgentProgress(taskId, displayName, `Working on story: ${story.title}`);

      story.status = 'in_progress';
      story.startedAt = new Date();
      await task.save();

      // Crear branch para esta story
      const branchName = `${member.instanceId}/${storyId}`;
      const primaryRepo = repositories.length > 0 ? repositories[0] : null;

      if (primaryRepo && workspacePath) {
        const primaryRepoPath = path.join(workspacePath, primaryRepo.name);
        await this.githubService.createBranch(primaryRepoPath, branchName);
      }
      story.branchName = branchName;

      // Ejecutar developer con instrucciones EXACTAS de archivos
      const assignment = task.orchestration.techLead.storyAssignments?.find(a => a.storyId === storyId);
      const prompt = this.buildDeveloperPrompt(task, member, story, assignment, workspaceStructure);

      const result = await this.executeAgent(
        'developer',
        prompt,
        workspacePath || this.workspaceDir,
        taskId,
        displayName,
        task.attachments
      );

      // EVALUAR con JUDGE
      let judgeApproved = false;
      let retryCount = 0;
      const maxRetries = 3;

      while (!judgeApproved && retryCount < maxRetries) {
        const judgeResult = await this.executeJudge(task, story, member, workspacePath);

        if (judgeResult.status === 'approved') {
          judgeApproved = true;
          story.judgeStatus = 'approved';
          story.status = 'completed';
        } else {
          retryCount++;
          story.judgeIterations = retryCount;

          if (retryCount < maxRetries) {
            console.log(`⚠️ [Judge] Retry ${retryCount}/${maxRetries} for ${story.title}`);
            NotificationService.emitAgentProgress(taskId, displayName,
              `Judge requested changes (attempt ${retryCount}/${maxRetries}): ${judgeResult.feedback}`
            );

            // RETRY con feedback del Judge
            const retryPrompt = this.buildDeveloperRetryPrompt(task, story, judgeResult);
            const retryResult = await this.executeAgent(
              'developer',
              retryPrompt,
              workspacePath || this.workspaceDir,
              taskId,
              displayName,
              task.attachments
            );
          } else {
            story.judgeStatus = 'changes_requested';
            story.status = 'failed';
            throw new Error(`Story failed Judge evaluation after ${maxRetries} attempts: ${judgeResult.feedback}`);
          }
        }
      }

      // Commit + Push
      if (primaryRepo && workspacePath) {
        const primaryRepoPath = path.join(workspacePath, primaryRepo.name);
        await this.githubService.commitChanges(primaryRepoPath, `${story.title}\n\n${story.description}`);
        await this.githubService.pushBranch(branchName, primaryRepoPath, (task.userId as any)._id.toString());

        // Crear PR
        const repoDoc = await Repository.findById(primaryRepo.id);
        if (repoDoc) {
          const pr = await this.githubService.createPullRequest(repoDoc, (task.userId as any)._id.toString(), {
            title: `[${member.instanceId}] ${story.title}`,
            description: `${story.description}\n\n**Story**: ${storyId}\n**Developer**: ${member.instanceId}\n**Judge**: Approved`,
            branch: branchName,
          });

          story.pullRequestNumber = pr.number;
          story.pullRequestUrl = pr.url;
          member.pullRequests.push(pr.number);
        }
      }

      story.completedAt = new Date();
      await task.save();
    }

    member.status = 'completed';
    member.completedAt = new Date();
    await task.save();

    NotificationService.emitAgentCompleted(taskId, displayName,
      `Completed ${member.assignedStories.length} stories (all approved by Judge)`
    );
  } catch (error: any) {
    member.status = 'blocked';
    await task.save();
    NotificationService.emitAgentFailed(taskId, displayName, error.message);
    throw error;
  }
}
```

#### D. ELIMINAR función `executeCodeReviews()`

Ya no es necesaria - Judge reemplaza las code reviews

#### E. CREAR función `executeJudge()`

```typescript
private async executeJudge(
  task: ITask,
  story: IStory,
  developer: ITeamMember,
  workspacePath: string | null
): Promise<{status: ReviewStatus, feedback: string, issues: any[]}> {
  const taskId = (task._id as any).toString();

  const assignment = task.orchestration.techLead.storyAssignments?.find(a => a.storyId === story.id);

  const prompt = `# Judge Evaluation

## Story:
${story.title}

## Description:
${story.description}

## Developer:
${developer.instanceId}

## Expected Files:
- Files to Read: ${assignment?.exactFilesToRead?.join(', ') || 'Not specified'}
- Files to Modify: ${assignment?.exactFilesToModify?.join(', ') || 'Not specified'}
- Files to Create: ${assignment?.exactFilesToCreate?.join(', ') || 'Not specified'}

## Your Mission:
Evaluate if the developer wrote ACTUAL CODE (not documentation) and met all requirements.

Use your tools:
1. Read() to inspect files the developer created/modified
2. Grep("TODO|FIXME|Not implemented") to find incomplete code
3. Bash("npm test") to verify tests pass
4. Bash("npm run build") to verify code compiles

Respond ONLY with valid JSON:
\`\`\`json
{
  "status": "approved" | "changes_requested",
  "feedback": "Detailed feedback",
  "issues": [{
    "file": "path/to/file.ts",
    "severity": "critical",
    "issue": "Problem description",
    "suggestion": "How to fix"
  }],
  "mustFix": ["Action 1", "Action 2"]
}
\`\`\``;

  const result = await this.executeAgent(
    'judge',
    prompt,
    workspacePath || this.workspaceDir,
    taskId,
    'Judge',
    []
  );

  // Parse JSON response
  const jsonMatch = result.output.match(/```json\n([\s\S]*?)\n```/) || result.output.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    return {
      status: 'changes_requested',
      feedback: 'Judge did not return valid JSON',
      issues: []
    };
  }

  const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

  // Store evaluation
  if (!task.orchestration.judge) {
    task.orchestration.judge = {
      agent: 'judge',
      status: 'in_progress',
      evaluations: []
    } as any;
  }

  task.orchestration.judge.evaluations = task.orchestration.judge.evaluations || [];
  task.orchestration.judge.evaluations.push({
    storyId: story.id,
    developerId: developer.instanceId,
    status: parsed.status,
    feedback: parsed.feedback,
    iteration: story.judgeIterations || 0
  });

  await task.save();

  return {
    status: parsed.status,
    feedback: parsed.feedback,
    issues: parsed.issues || []
  };
}
```

#### F. CREAR función `buildDeveloperRetryPrompt()`

```typescript
private buildDeveloperRetryPrompt(
  task: ITask,
  story: IStory,
  judgeResult: {feedback: string, issues: any[], mustFix?: string[]}
): string {
  const assignment = task.orchestration.techLead.storyAssignments?.find(a => a.storyId === story.id);

  return `# RETRY: ${story.title}

## Judge Feedback:
${judgeResult.feedback}

## Critical Issues Found:
${judgeResult.issues.map(issue => `
- **${issue.file}** (${issue.severity}):
  - Problem: ${issue.issue}
  - Fix: ${issue.suggestion}
`).join('\n')}

## Must Fix:
${judgeResult.mustFix?.map((fix, i) => `${i + 1}. ${fix}`).join('\n') || 'See issues above'}

## Requirements (MUST MEET):
- Files to Read: ${assignment?.exactFilesToRead?.join(', ') || 'Not specified'}
- Files to Modify: ${assignment?.exactFilesToModify?.join(', ') || 'Not specified'}
- Files to Create: ${assignment?.exactFilesToCreate?.join(', ') || 'Not specified'}

## Your Mission:
FIX the issues identified by the Judge. Write ACTUAL CODE, not documentation.

This is attempt ${story.judgeIterations}. If you fail again, the story will be marked as failed.`;
}
```

## ⚠️ Cambios Adicionales Necesarios

### 4. Aprobación Humana Después de Cada Agente

Necesitamos crear un mecanismo de pausa en la orquestación:

```typescript
// En orchestrateTask(), después de cada fase:
await this.executeProductManager(task, workspacePath, workspaceStructure);

// PAUSE FOR HUMAN APPROVAL
task.orchestration.productManager.approval = {
  status: 'pending',
  requestedAt: new Date()
};
await task.save();
NotificationService.emitApprovalRequired(taskId, 'Product Manager', task.orchestration.productManager.output);

// Esperar aprobación (el endpoint /api/tasks/:id/approve cambiará el status)
while (task.orchestration.productManager.approval.status === 'pending') {
  await new Promise(resolve => setTimeout(resolve, 5000)); // Poll cada 5 segundos
  const freshTask = await Task.findById(task._id);
  if (freshTask) {
    task.orchestration.productManager.approval = freshTask.orchestration.productManager.approval;
  }
}

if (task.orchestration.productManager.approval.status === 'rejected') {
  throw new Error('Product Manager phase rejected by user');
}

// CONTINUE TO NEXT PHASE
await this.executeProjectManager(task, workspacePath, workspaceStructure);
```

### 5. Endpoint de Aprobación

Crear en `routes/tasks.ts`:

```typescript
// POST /api/tasks/:id/approve/:phase
router.post('/:id/approve/:phase', authenticate, async (req, res) => {
  try {
    const { id, phase } = req.params;
    const { approved } = req.body; // true/false

    const task = await Task.findById(id);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Actualizar aprobación según la fase
    const phaseMap: Record<string, string> = {
      'product-manager': 'productManager',
      'project-manager': 'projectManager',
      'tech-lead': 'techLead',
      'qa-engineer': 'qaEngineer'
    };

    const phaseName = phaseMap[phase];
    if (!phaseName || !task.orchestration[phaseName]) {
      return res.status(400).json({ error: 'Invalid phase' });
    }

    task.orchestration[phaseName].approval = {
      status: approved ? 'approved' : 'rejected',
      approvedBy: req.user._id,
      approvedAt: new Date(),
      requestedAt: task.orchestration[phaseName].approval?.requestedAt || new Date()
    };

    await task.save();

    res.json({
      success: true,
      phase,
      approved,
      message: `Phase ${phase} ${approved ? 'approved' : 'rejected'} successfully`
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
```

## 📊 Estado Actual

- ✅ Modelo de datos actualizado (Task.ts)
- ✅ Prompts de agentes actualizados (getAgentDefinitions())
- ❌ TeamOrchestrator.ts roto (sintaxis)
- ⚠️ Necesita:
  - Restaurar archivo
  - Aplicar cambios en funciones de orquestación
  - Crear función executeJudge()
  - Crear función buildDeveloperRetryPrompt()
  - Implementar aprobación humana
  - Crear endpoint de aprobación

## 🎯 Próximos Pasos

1. **INMEDIATO**: Restaurar TeamOrchestrator.ts desde git
2. Aplicar cambios A, B, C, D, E, F (funciones de orquestación)
3. Implementar aprobación humana (polling mechanism)
4. Crear endpoint `/api/tasks/:id/approve/:phase`
5. Testing completo del flujo

## 📝 Notas

- El Judge agent ahora reemplaza completamente el sistema de code reviews senior→junior
- Retry mechanism hasta 3 intentos con feedback específico
- Aprobación humana pausará la ejecución hasta que el usuario apruebe desde el frontend
- Multi-repo: Tech Lead crea branches por repositorio con `epicBranches` tracking
