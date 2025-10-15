# 🎯 Sistema Completo de Aprobaciones Interactivas + Auto Pilot

## ✅ IMPLEMENTADO: Cost Approval
- CostApprovalPhase pausa después de TechLead
- WebSocket emite evento → CostApprovalCard en chat
- User aprueba → continúa a developers
- **FUNCIONAL END-TO-END**

---

## 🚧 FALTA: Clarifications System

### Problema
- Agentes NO pueden pausar y preguntar al usuario
- No hay mecanismo para `await askUser(question)`

### Solución

#### 1. **Clarifications Helper** (agentes lo usan)

**Archivo:** `src/services/ClarificationsHelper.ts` (NUEVO)

```typescript
export class ClarificationsHelper {
  /**
   * Agent asks user a question and PAUSES execution
   * Returns user's answer when they respond
   */
  static async askUser(
    taskId: string,
    agentName: string,
    question: string,
    options?: {
      context?: string;
      suggestions?: string[];
    }
  ): Promise<string> {
    const task = await Task.findById(taskId);
    if (!task) throw new Error('Task not found');

    // Check if auto-pilot mode
    if (task.orchestration.autoPilotMode) {
      console.log(`🚁 [Auto Pilot] Skipping clarification - using default`);
      return 'Continue with best judgment';
    }

    // Create clarification ID
    const clarificationId = `clarif-${Date.now()}`;

    // Save to task
    task.orchestration.pendingClarification = {
      id: clarificationId,
      agent: agentName,
      question,
      context: options?.context,
      suggestions: options?.suggestions,
      askedAt: new Date(),
      answered: false
    };
    task.orchestration.status = 'awaiting_clarification';
    await task.save();

    console.log(`❓ [${agentName}] Asking user: ${question}`);

    // Emit WebSocket
    NotificationService.emitClarificationRequired(taskId, {
      id: clarificationId,
      agent: agentName,
      question,
      context: options?.context,
      suggestions: options?.suggestions
    });

    // WAIT for user response (poll database)
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        const updatedTask = await Task.findById(taskId);
        const clarif = updatedTask?.orchestration.pendingClarification;

        if (clarif && clarif.id === clarificationId && clarif.answered) {
          clearInterval(interval);
          console.log(`✅ [${agentName}] User responded: ${clarif.userResponse}`);
          resolve(clarif.userResponse!);
        }
      }, 2000); // Check every 2 seconds
    });
  }
}
```

#### 2. **Endpoint /clarify** (YA EXISTE - solo actualizar)

**Archivo:** `src/routes/tasks.ts` - línea ~1290

```typescript
router.post('/:id/clarify', authenticate, async (req: AuthRequest, res) => {
  const { clarificationId, response } = req.body;
  const task = await Task.findById(taskId);

  if (!task?.orchestration.pendingClarification) {
    return res.status(400).json({ success: false, message: 'No pending clarification' });
  }

  const clarif = task.orchestration.pendingClarification;
  if (clarif.id !== clarificationId) {
    return res.status(400).json({ success: false, message: 'Invalid clarification ID' });
  }

  // Mark as answered
  clarif.answered = true;
  clarif.answeredAt = new Date();
  clarif.userResponse = response;
  task.orchestration.status = 'in_progress';

  await task.save();

  console.log(`✅ [Clarification] User responded: ${response}`);

  return res.json({
    success: true,
    message: 'Clarification received, agent will continue'
  });
});
```

#### 3. **Uso en Agentes**

Cualquier agente puede usar:

```typescript
// En developer, tech-lead, etc.
const userAnswer = await ClarificationsHelper.askUser(
  taskId,
  'Developer',
  'Should I use REST API or GraphQL for this endpoint?',
  {
    context: 'Building user authentication service',
    suggestions: ['REST API', 'GraphQL', 'Both']
  }
);

// Execution PAUSED here until user responds
console.log(`User chose: ${userAnswer}`);
```

---

## 🚧 FALTA: PR Approval

### Problema
- Merge Coordinator hace merge sin pedir permiso
- User no ve los PRs antes del merge

### Solución

#### 1. **PRApprovalPhase** (antes de MergePhase)

**Archivo:** `src/services/orchestration/PRApprovalPhase.ts` (NUEVO)

```typescript
export class PRApprovalPhase implements Phase {
  async execute(context: OrchestrationContext): Promise<void> {
    const { task } = context;
    const taskId = (task._id as any).toString();

    // Check auto-pilot
    if (task.orchestration.autoPilotMode) {
      console.log(`🚁 [Auto Pilot] Skipping PR approval - auto-merging`);
      return;
    }

    // Get all PRs from task
    const pullRequests = task.pullRequests || [];
    if (pullRequests.length === 0) {
      console.log('⚠️  No PRs found - skipping approval');
      return;
    }

    console.log(`\n🔀 =============== PR APPROVAL PHASE ===============`);
    console.log(`📋 Found ${pullRequests.length} pull requests for review`);

    // Check if already approved
    if (task.orchestration.manualReview?.status === 'approved') {
      console.log(`✅ [PR Approval] Already approved - continuing to merge`);
      return;
    }

    // NOT APPROVED - PAUSE
    task.orchestration.status = 'pending_approval';
    await task.save();

    console.log(`⏸️  [PR Approval] Waiting for user to review PRs...`);

    // Emit WebSocket with PR data
    NotificationService.emitPRApprovalRequired(taskId, {
      pullRequests: pullRequests.map(pr => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        status: pr.status,
        branch: pr.branch,
        commits: pr.commits?.length || 0,
        filesChanged: pr.filesChanged || 0,
        additions: pr.additions || 0,
        deletions: pr.deletions || 0
      }))
    });

    // STOP PIPELINE
    throw new Error('PR_APPROVAL_PENDING');
  }
}
```

#### 2. **Agregar a Pipeline**

`TeamOrchestrator.ts`:

```typescript
new DevelopersPhase(executeDeveloperFn),
new QAPhase(...),
new PRApprovalPhase(), // 🔀 PAUSE HERE if not approved
new MergePhase(),
```

#### 3. **Endpoint /review/approve** (YA EXISTE)

Ya funciona, solo necesita llamar `orchestrateTask()` de nuevo después de aprobar.

---

## 🚁 Auto Pilot Mode

### Toggle en Frontend

**Archivo:** `Chat.jsx` - Header actions

```jsx
const [autoPilotMode, setAutoPilotMode] = useState(false);

const handleToggleAutoPilot = async () => {
  if (!currentTask) return;

  try {
    await taskService.toggleAutoPilot(currentTask._id, !autoPilotMode);
    setAutoPilotMode(!autoPilotMode);
    showSuccess(autoPilotMode ? 'Auto Pilot disabled' : 'Auto Pilot enabled');
  } catch (error) {
    showError('Failed to toggle Auto Pilot');
  }
};

// UI
<button
  onClick={handleToggleAutoPilot}
  className={`auto-pilot-toggle ${autoPilotMode ? 'active' : ''}`}
  title="Auto Pilot Mode - Skip all approvals"
>
  {autoPilotMode ? '🚁 Auto Pilot ON' : '✋ Manual Mode'}
</button>
```

### Backend Endpoint

**Archivo:** `src/routes/tasks.ts`

```typescript
router.post('/:id/toggle-autopilot', authenticate, async (req, res) => {
  const { enabled } = req.body;
  const task = await Task.findById(taskId);

  task.orchestration.autoPilotMode = enabled;
  await task.save();

  console.log(`🚁 [Auto Pilot] ${enabled ? 'ENABLED' : 'DISABLED'} for task ${taskId}`);

  return res.json({
    success: true,
    autoPilotMode: enabled
  });
});
```

### Lógica de Skip

Cada fase chequea:

```typescript
// En CostApprovalPhase
if (task.orchestration.autoPilotMode) {
  console.log(`🚁 [Auto Pilot] Skipping cost approval`);
  return; // Continue immediately
}

// En PRApprovalPhase
if (task.orchestration.autoPilotMode) {
  console.log(`🚁 [Auto Pilot] Skipping PR approval - auto-merging`);
  return;
}

// En ClarificationsHelper.askUser()
if (task.orchestration.autoPilotMode) {
  return 'Continue with best judgment'; // Default answer
}
```

---

## 📋 Checklist de Implementación

### Clarifications
- [ ] Crear `ClarificationsHelper.ts`
- [ ] Actualizar endpoint `/clarify`
- [ ] Agregar ejemplo de uso en developer
- [ ] Emitir WebSocket event
- [ ] Frontend: Renderizar ClarificationCard

### PR Approval
- [ ] Crear `PRApprovalPhase.ts`
- [ ] Agregar a pipeline antes de MergePhase
- [ ] Emitir WebSocket con lista de PRs
- [ ] Actualizar `/review/approve` para reanudar
- [ ] Frontend: Renderizar PRApprovalCard

### Auto Pilot
- [ ] Agregar toggle en Chat.jsx header
- [ ] Crear endpoint `/toggle-autopilot`
- [ ] Agregar checks en todas las fases de aprobación
- [ ] ClarificationsHelper retorna default si auto-pilot
- [ ] UI: Indicador visual cuando auto-pilot está ON

---

## 🎯 Flujo Completo

```
User crea Task
   ↓
Product Manager analiza
   ↓
Tech Lead crea epics/stories
   ↓
💰 Cost Approval Phase
   ├── Auto Pilot ON → Skip
   └── Manual → Pause → User approves → Continue
   ↓
Developers trabajan
   ├── Need clarification? → askUser() → Pause → Answer → Continue
   └── Code implementation
   ↓
QA valida
   ↓
🔀 PR Approval Phase
   ├── Auto Pilot ON → Skip
   └── Manual → Pause → User reviews PRs → Approve → Continue
   ↓
Merge Coordinator hace merge
   ↓
✅ Task Complete
```
