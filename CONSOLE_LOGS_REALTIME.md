# 🖥️ Console Logs en Tiempo Real

Sistema completo para ver **TODOS** los `console.log` del backend en el frontend, en tiempo real.

## ✅ Implementación Completa

### Backend

#### 1. **ConsoleStreamer** (`src/services/ConsoleStreamer.ts`)
Intercepta TODOS los console.log/info/warn/error del backend:

```typescript
import ConsoleStreamer from './services/ConsoleStreamer';

// Iniciar streaming para una tarea
ConsoleStreamer.startStreaming(taskId);

// Detener streaming
ConsoleStreamer.stopStreaming();

// Obtener logs históricos
const logs = ConsoleStreamer.getTaskLogs(taskId);
```

**Features:**
- ✅ Intercepta `console.log`, `console.info`, `console.warn`, `console.error`
- ✅ Envía logs via WebSocket en tiempo real
- ✅ Buffer de logs en memoria (últimos 1000)
- ✅ Maneja referencias circulares en objetos
- ✅ No rompe logs existentes en consola

#### 2. **Integración con TeamOrchestrator**
Automáticamente habilitado al iniciar una tarea:

```typescript
// En orchestrateTask()
ConsoleStreamer.startStreaming(taskId);
// Ahora TODOS los console.log se envían al frontend
```

#### 3. **Endpoint REST**
```
GET /api/tasks/:id/console-logs?limit=100
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2025-10-13T08:42:00.296Z",
      "level": "log",
      "message": "🚀 [Pipeline] Starting orchestration...",
      "taskId": "68ecbba346e1d888b503a5b4"
    }
  ],
  "count": 150,
  "total": 500
}
```

#### 4. **WebSocket Event**
```javascript
socket.on('console:log', (logData) => {
  console.log(logData);
  // {
  //   timestamp: Date,
  //   level: 'log' | 'info' | 'warn' | 'error',
  //   message: string
  // }
});
```

---

### Frontend

#### 1. **ConsoleViewer Component**
Ubicación: `src/components/logs/ConsoleViewer.jsx`

**Uso básico:**
```jsx
import ConsoleViewer from './components/logs/ConsoleViewer';

function TaskPage() {
  const taskId = '68ecbba346e1d888b503a5b4';

  return (
    <div>
      <h1>Task Execution</h1>
      <ConsoleViewer taskId={taskId} />
    </div>
  );
}
```

**Features:**
- ✅ Carga logs históricos al montar
- ✅ Recibe logs en tiempo real via WebSocket
- ✅ Auto-scroll automático (configurable)
- ✅ Filtros por nivel (all, log, info, warn, error)
- ✅ Botón para limpiar logs
- ✅ Exportar logs a archivo .txt
- ✅ Indicador de conexión
- ✅ Stats en footer (total, filtrados, errores, warnings)

#### 2. **Estilos incluidos**
`src/components/logs/ConsoleViewer.css`
- Dark theme estilo terminal
- Syntax highlighting por nivel
- Responsive (mobile-friendly)
- Scrollbar customizado

---

## 🚀 Ejemplo Completo

### Backend (Ya implementado):
```typescript
// En cualquier parte del backend
console.log('📁 Working directory:', workDir);
console.info('✅ Repository cloned successfully');
console.warn('⚠️  Branch already exists');
console.error('❌ Failed to push to GitHub');

// Todos estos aparecen en el frontend instantáneamente
```

### Frontend:
```jsx
import React from 'react';
import ConsoleViewer from './components/logs/ConsoleViewer';

function ChatPage({ taskId }) {
  return (
    <div className="chat-page">
      <div className="chat-messages">
        {/* Tu chat actual */}
      </div>

      {/* Agregar el viewer de console logs */}
      <div className="console-section">
        <ConsoleViewer taskId={taskId} />
      </div>
    </div>
  );
}
```

---

## 📊 Formato de Logs

### En Consola Backend:
```
🚀 [Pipeline] Starting orchestration for task: Visible-logs-frontend
📂 [Developer (dev-1)] Directory contents: ['.git', 'src', 'package.json']
✅ [Developer (dev-1)] You are INSIDE a git repository
📁 [Developer (dev-1)] Working directory: /path/to/repo
```

### En Frontend (mismo formato):
```
[08:42:00.296] [LOG] 🚀 [Pipeline] Starting orchestration for task: Visible-logs-frontend
[08:42:01.453] [INFO] 📂 [Developer (dev-1)] Directory contents: ['.git', 'src', 'package.json']
[08:42:01.567] [LOG] ✅ [Developer (dev-1)] You are INSIDE a git repository
[08:42:01.789] [LOG] 📁 [Developer (dev-1)] Working directory: /path/to/repo
```

---

## 🎨 Niveles de Log y Colores

| Nivel   | Color      | Uso                          |
|---------|------------|------------------------------|
| `log`   | Azul       | Información general          |
| `info`  | Verde      | Success messages             |
| `warn`  | Amarillo   | Advertencias                 |
| `error` | Rojo       | Errores (bg rojo suave)      |

---

## ⚙️ Configuración

### Backend:
- **Buffer size**: 1000 logs (configurable en `ConsoleStreamer.ts`)
- **Auto-start**: Habilitado en `TeamOrchestrator`
- **WebSocket room**: `task:${taskId}`

### Frontend:
- **Initial load**: 500 logs históricos
- **Auto-scroll**: Habilitado por defecto
- **Refresh rate**: Tiempo real (WebSocket)
- **Export format**: Plain text (.txt)

---

## 🔧 Testing

### Test manual:
1. Inicia una tarea desde el frontend
2. Abre el componente `ConsoleViewer`
3. Verifica que los logs aparezcan en tiempo real
4. Prueba los filtros y controles

### Test en backend:
```typescript
// En cualquier parte del código
console.log('🧪 Test log - should appear in frontend');
console.info('✅ This is an info message');
console.warn('⚠️  This is a warning');
console.error('❌ This is an error');
```

---

## 📦 Archivos Modificados/Creados

### Backend:
- ✅ `src/services/ConsoleStreamer.ts` (nuevo)
- ✅ `src/services/TeamOrchestrator.ts` (modificado)
- ✅ `src/routes/tasks.ts` (endpoint agregado)

### Frontend:
- ✅ `src/components/logs/ConsoleViewer.jsx` (nuevo)
- ✅ `src/components/logs/ConsoleViewer.css` (nuevo)

---

## 🐛 Troubleshooting

### Los logs no aparecen:
1. Verifica que el WebSocket esté conectado (indicador verde)
2. Revisa que `taskId` sea correcto
3. Verifica que el usuario esté autenticado
4. Chequea la consola del navegador por errores

### Logs duplicados:
- Normal si tienes múltiples pestañas abiertas
- Cada conexión recibe los mismos logs

### Performance:
- El buffer limita a 1000 logs máximo
- Si necesitas más, aumenta `maxBufferSize` en `ConsoleStreamer.ts`

---

## 🚀 Próximas Mejoras

- [ ] Búsqueda/filtro por texto
- [ ] Pausar/reanudar streaming
- [ ] Resaltar sintaxis para JSON/código
- [ ] Timestamps relativos (hace 2s, hace 1m)
- [ ] Persistencia en base de datos
- [ ] Logs por agente individual

---

## ✅ Resultado Final

Ahora puedes ver **EXACTAMENTE** lo que pasa en el backend, en tiempo real, desde el frontend. Cada `console.log`, `console.info`, `console.warn`, `console.error` aparece instantáneamente en la UI, con:

- ✅ Timestamps precisos
- ✅ Niveles coloreados
- ✅ Filtros y búsqueda
- ✅ Export a archivo
- ✅ Auto-scroll
- ✅ Stats en tiempo real

**¡Ya no necesitas mirar la consola del servidor!** 🎉
