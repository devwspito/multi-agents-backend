# 🎯 Guía: Activación/Desactivación de Repositorios por Tarea

## 📋 Concepto

Permite al usuario **seleccionar qué repositorios del proyecto serán leídos** durante la ejecución de una tarea específica, optimizando el consumo de tokens y costos.

### Ejemplo Real:

```
Proyecto: E-commerce Platform
├── 📦 frontend (React)          [Active en proyecto]
├── 📦 backend-api (Node.js)     [Active en proyecto]
└── 📦 mobile-app (React Native) [Active en proyecto]

Tarea: "Implement JWT Authentication in Backend"
├── frontend           [❌ DESACTIVADO - No se leerá]
├── backend-api        [✅ ACTIVADO - Se leerá]
└── mobile-app         [❌ DESACTIVADO - No se leerá]

Resultado: Orquestador solo lee backend-api
Ahorro: ~66% de tokens en lectura de código
```

---

## 🔧 Implementación Backend (Ya Completada)

### 1. Modelo Task actualizado

**Campo agregado:**
```javascript
repositories: [{
  repositoryId: { type: String, required: true },
  repositoryName: { type: String, required: true },
  type: { type: String, enum: [...] },
  isActive: {
    type: Boolean,
    default: true  // ✅ Por defecto todos activos
  },
  // ... otros campos
}]
```

**Métodos agregados:**
```javascript
// Obtener solo repos activos
task.getActiveRepositories()

// Obtener repos inactivos
task.getInactiveRepositories()

// Activar/desactivar específico
task.toggleRepository(repositoryId, true/false)
task.activateRepository(repositoryId)
task.deactivateRepository(repositoryId)

// Activar/desactivar todos
task.activateAllRepositories()
task.deactivateAllRepositories()
```

---

## 🌐 Endpoints API Disponibles

### 1. **Toggle Individual Repository**
```http
PATCH /api/tasks/:taskId/repositories/:repositoryId/toggle
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "isActive": false
}
```

**Respuesta:**
```json
{
  "success": true,
  "message": "Repository deactivated successfully",
  "data": {
    "task": {
      "id": "task123",
      "title": "Implement JWT Authentication",
      "repositories": [
        {
          "repositoryId": "repo1",
          "repositoryName": "frontend",
          "isActive": false
        },
        {
          "repositoryId": "repo2",
          "repositoryName": "backend-api",
          "isActive": true
        }
      ],
      "activeRepositories": [
        {
          "repositoryId": "repo2",
          "repositoryName": "backend-api",
          "isActive": true
        }
      ],
      "inactiveRepositories": [
        {
          "repositoryId": "repo1",
          "repositoryName": "frontend",
          "isActive": false
        }
      ]
    }
  }
}
```

---

### 2. **Get Active Repositories**
```http
GET /api/tasks/:taskId/repositories/active
Authorization: Bearer YOUR_TOKEN
```

**Respuesta:**
```json
{
  "success": true,
  "data": {
    "taskId": "task123",
    "activeRepositories": [
      {
        "repositoryId": "repo2",
        "repositoryName": "backend-api",
        "type": "backend",
        "isActive": true
      }
    ],
    "count": 1
  }
}
```

---

### 3. **Activate All Repositories**
```http
PATCH /api/tasks/:taskId/repositories/activate-all
Authorization: Bearer YOUR_TOKEN
```

**Respuesta:**
```json
{
  "success": true,
  "message": "All repositories activated successfully",
  "data": {
    "task": {
      "id": "task123",
      "activeRepositories": [
        { "repositoryId": "repo1", "repositoryName": "frontend", "isActive": true },
        { "repositoryId": "repo2", "repositoryName": "backend-api", "isActive": true },
        { "repositoryId": "repo3", "repositoryName": "mobile-app", "isActive": true }
      ]
    }
  }
}
```

---

### 4. **Deactivate All Repositories**
```http
PATCH /api/tasks/:taskId/repositories/deactivate-all
Authorization: Bearer YOUR_TOKEN
```

---

## 💻 Implementación Frontend

### A. Componente de Lista de Repositorios

```jsx
function RepositorySelector({ task, onUpdate }) {
  const [repositories, setRepositories] = useState(task.repositories || []);
  const [loading, setLoading] = useState(false);

  async function toggleRepository(repoId, currentStatus) {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/tasks/${task.id}/repositories/${repoId}/toggle`,
        {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            isActive: !currentStatus
          })
        }
      );

      const data = await response.json();

      if (data.success) {
        setRepositories(data.data.task.repositories);
        onUpdate && onUpdate(data.data.task);
      }

    } catch (error) {
      console.error('Error toggling repository:', error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="repository-selector">
      <div className="section-header">
        <span>📦 Active Repositories for this Task</span>
        <button onClick={activateAll} className="btn-link">
          Enable All
        </button>
      </div>

      <div className="repo-list">
        {repositories.map(repo => (
          <div
            key={repo.repositoryId}
            className={`repo-item ${!repo.isActive ? 'inactive' : ''}`}
          >
            <input
              type="checkbox"
              checked={repo.isActive}
              onChange={() => toggleRepository(repo.repositoryId, repo.isActive)}
              disabled={loading}
            />
            <span className="repo-icon">
              {getRepoIcon(repo.type)}
            </span>
            <span className="repo-name">{repo.repositoryName}</span>
            <span className="repo-type">{repo.type}</span>
            {!repo.isActive && (
              <span className="badge inactive">Disabled</span>
            )}
          </div>
        ))}
      </div>

      <div className="info-box">
        <span className="icon">💡</span>
        <span>
          Disabling repositories reduces token usage.
          Only code from active repositories will be analyzed.
        </span>
      </div>
    </div>
  );
}
```

**CSS:**
```css
.repository-selector {
  padding: 16px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 8px;
  margin-bottom: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-weight: 600;
}

.repo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.repo-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 6px;
  border: 1px solid transparent;
  transition: all 0.2s;
}

.repo-item:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.1);
}

.repo-item.inactive {
  opacity: 0.5;
  background: rgba(255, 255, 255, 0.02);
}

.repo-item input[type="checkbox"] {
  width: 18px;
  height: 18px;
  cursor: pointer;
}

.repo-name {
  flex: 1;
  font-weight: 500;
}

.repo-type {
  font-size: 11px;
  color: #888;
  text-transform: uppercase;
  padding: 2px 8px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.badge.inactive {
  font-size: 11px;
  padding: 2px 8px;
  background: #ff6b6b;
  color: white;
  border-radius: 4px;
}

.info-box {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  background: rgba(59, 130, 246, 0.1);
  border-left: 3px solid #3b82f6;
  border-radius: 4px;
  font-size: 13px;
  color: #93c5fd;
}
```

---

### B. Integración en Modal de Crear Tarea

```jsx
function CreateTaskModal({ project, onClose, onTaskCreated }) {
  const [taskData, setTaskData] = useState({
    title: '',
    description: '',
    priority: 'medium',
    repositories: []
  });

  useEffect(() => {
    // Inicializar con todos los repos del proyecto activos
    if (project.repositories) {
      setTaskData(prev => ({
        ...prev,
        repositories: project.repositories.map(repo => ({
          repositoryId: repo._id,
          repositoryName: repo.name,
          type: repo.type,
          isActive: true  // Por defecto todos activos
        }))
      }));
    }
  }, [project]);

  function toggleRepository(repoId) {
    setTaskData(prev => ({
      ...prev,
      repositories: prev.repositories.map(repo =>
        repo.repositoryId === repoId
          ? { ...repo, isActive: !repo.isActive }
          : repo
      )
    }));
  }

  async function handleSubmit() {
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...taskData,
          project: project.id
        })
      });

      const data = await response.json();
      if (data.success) {
        onTaskCreated(data.data.task);
        onClose();
      }

    } catch (error) {
      console.error('Error creating task:', error);
    }
  }

  return (
    <div className="modal">
      <div className="modal-content">
        <h2>Create New Task</h2>

        <input
          type="text"
          placeholder="Task title"
          value={taskData.title}
          onChange={(e) => setTaskData({ ...taskData, title: e.target.value })}
        />

        <textarea
          placeholder="Task description"
          value={taskData.description}
          onChange={(e) => setTaskData({ ...taskData, description: e.target.value })}
        />

        {/* SECCIÓN DE REPOSITORIOS */}
        <div className="repository-selection">
          <h3>Select Repositories for this Task</h3>
          <p className="hint">
            💡 Choose which repositories will be analyzed. Fewer repositories = lower token costs.
          </p>

          {taskData.repositories.map(repo => (
            <div key={repo.repositoryId} className="repo-checkbox">
              <input
                type="checkbox"
                id={`repo-${repo.repositoryId}`}
                checked={repo.isActive}
                onChange={() => toggleRepository(repo.repositoryId)}
              />
              <label htmlFor={`repo-${repo.repositoryId}`}>
                <span className="repo-icon">{getRepoIcon(repo.type)}</span>
                <span className="repo-name">{repo.repositoryName}</span>
                <span className="repo-type">({repo.type})</span>
              </label>
            </div>
          ))}

          <div className="active-count">
            {taskData.repositories.filter(r => r.isActive).length} of {taskData.repositories.length} repositories active
          </div>
        </div>

        <div className="modal-actions">
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="btn-primary"
            disabled={taskData.repositories.filter(r => r.isActive).length === 0}
          >
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

### C. Indicador Visual en Lista de Tareas

```jsx
function TaskItem({ task }) {
  const activeRepos = task.repositories?.filter(r => r.isActive) || [];
  const totalRepos = task.repositories?.length || 0;

  return (
    <div className="task-item">
      <div className="task-header">
        <span className="task-status-icon">
          {task.status === 'completed' ? '✓' : '○'}
        </span>
        <span className="task-title">{task.title}</span>
      </div>

      <div className="task-metadata">
        {/* Indicador de repositorios activos */}
        <span className="repo-indicator">
          <span className="icon">📦</span>
          <span className="count">
            {activeRepos.length}/{totalRepos} repos
          </span>
          {activeRepos.length < totalRepos && (
            <span className="badge warning">Limited</span>
          )}
        </span>

        {/* Tokens y Cost */}
        <span className="tokens">Tokens: {task.tokens?.toLocaleString()}</span>
        <span className="cost">Cost: ${task.cost?.toFixed(2)}</span>
      </div>
    </div>
  );
}
```

---

## 🔄 Flujo de Usuario

### 1. **Al Crear Tarea**

```
Usuario crea nueva tarea "Implement JWT in Backend"
        ↓
Frontend muestra checkboxes con todos los repos del proyecto
        ↓
Usuario desmarca:
  ❌ frontend
  ❌ mobile-app
  ✅ backend-api (mantiene marcado)
        ↓
POST /api/tasks
{
  title: "Implement JWT in Backend",
  repositories: [
    { repositoryId: "repo1", isActive: false },  // frontend
    { repositoryId: "repo2", isActive: true },   // backend-api
    { repositoryId: "repo3", isActive: false }   // mobile-app
  ]
}
        ↓
Tarea creada con solo backend-api activo
```

---

### 2. **Al Ejecutar Orquestación**

```
Usuario: POST /api/tasks/:id/start
        ↓
Backend: executeFullOrchestration()
        ↓
Para cada agente (PM, PjM, TL, etc.):
  task.getActiveRepositories()  // Solo retorna [backend-api]
        ↓
Agente solo lee código de backend-api
        ↓
Ahorro: 66% tokens (2 de 3 repos ignorados)
```

---

### 3. **Cambiar Durante Vida de Tarea**

```
Usuario abre tarea existente
        ↓
Frontend muestra lista de repos con estado actual
        ↓
Usuario cambia:
  frontend: ❌ → ✅ (activar)
        ↓
PATCH /api/tasks/:id/repositories/:repoId/toggle
{ isActive: true }
        ↓
Próxima ejecución incluirá frontend
```

---

## 📊 Estimación de Ahorro de Tokens

### Ejemplo Real:

**Proyecto con 3 repositorios:**
- `frontend/` → 15,000 líneas de código
- `backend-api/` → 8,000 líneas de código
- `mobile-app/` → 12,000 líneas de código
- **Total**: 35,000 líneas

**Tarea: "Add JWT middleware to API"**
- Solo necesita: `backend-api/` (8,000 líneas)
- Ahorro: 77% de tokens en lectura de código

**Tokens estimados:**
- Con todos los repos: ~140,000 tokens (35K líneas × 4 tokens/línea)
- Solo backend: ~32,000 tokens (8K líneas × 4 tokens/línea)
- **Ahorro**: 108,000 tokens ≈ **$1.62 en Opus** o **$0.32 en Sonnet**

---

## 🎨 UI/UX Recomendaciones

### 1. **Indicadores Visuales Claros**
```
✅ frontend (React)          → Verde, checkbox marcado
❌ backend-api (Node.js)     → Gris, checkbox desmarcado
✅ mobile-app (React Native) → Verde, checkbox marcado

💡 2 of 3 repositories active
💰 Estimated savings: $0.54 per execution
```

### 2. **Presets Inteligentes**
```
[Backend Only]    → Solo repos de tipo 'backend', 'api'
[Frontend Only]   → Solo repos de tipo 'frontend', 'mobile'
[Full Stack]      → Todos los repos activos
[Custom]          → Selección manual
```

### 3. **Tooltips Informativos**
```
🛈 Disabling repositories reduces token usage and costs.
  Only code from active repositories will be analyzed
  by the AI agents during orchestration.
```

---

## ✅ Checklist de Implementación Frontend

- [ ] Crear componente `RepositorySelector`
- [ ] Agregar checkboxes en modal de crear tarea
- [ ] Mostrar indicador de repos activos en TaskItem
- [ ] Agregar botón "Edit Repositories" en detalles de tarea
- [ ] Implementar llamadas API para toggle
- [ ] Agregar loading states
- [ ] Mostrar estimación de ahorro de tokens
- [ ] Agregar confirmación antes de desactivar todos
- [ ] Implementar presets (Backend Only, Frontend Only, etc.)
- [ ] Agregar tooltips explicativos

---

## 🚀 Ejemplos de Uso

### Ejemplo 1: Tarea Solo Backend
```javascript
// Al crear tarea
const taskData = {
  title: "Implement JWT Authentication",
  description: "Add JWT middleware to Express API",
  repositories: [
    { repositoryId: "frontend-id", isActive: false },
    { repositoryId: "backend-id", isActive: true },
    { repositoryId: "mobile-id", isActive: false }
  ]
};

// Result: Solo lee backend-api
// Ahorro: ~66% tokens
```

### Ejemplo 2: Tarea Solo Frontend
```javascript
const taskData = {
  title: "Create Login Form Component",
  description: "Build responsive login form with validation",
  repositories: [
    { repositoryId: "frontend-id", isActive: true },
    { repositoryId: "backend-id", isActive: false },
    { repositoryId: "mobile-id", isActive: false }
  ]
};

// Result: Solo lee frontend
// Ahorro: ~66% tokens
```

### Ejemplo 3: Tarea Full Stack
```javascript
const taskData = {
  title: "Implement Complete User Registration Flow",
  description: "End-to-end user registration with email verification",
  repositories: [
    { repositoryId: "frontend-id", isActive: true },
    { repositoryId: "backend-id", isActive: true },
    { repositoryId: "mobile-id", isActive: true }
  ]
};

// Result: Lee todos los repos
// Sin ahorro (pero necesario para la tarea)
```

---

## 📈 Monitoreo y Métricas

El sistema de token tracking ya implementado registrará automáticamente:

```javascript
{
  "task": "task123",
  "repositories": [
    { "name": "backend-api", "isActive": true }
  ],
  "tokenUsage": {
    "totalTokens": 32000,
    "cost": 0.32,
    "repositoriesRead": 1,
    "repositoriesSkipped": 2
  }
}
```

---

## 🎯 Resumen

✅ **Backend completado**: Modelo, métodos, endpoints
✅ **Endpoints API**: 4 endpoints para gestión de repos
✅ **Ahorro potencial**: 50-80% tokens según selectividad
🔄 **Siguiente paso**: Implementar UI frontend

¿Necesitas ayuda con algún componente específico del frontend?
