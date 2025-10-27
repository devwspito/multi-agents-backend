# 📊 Evaluación: Sistema de Webhooks y API Keys

## ✅ Lo que está BIEN implementado

### 1. **Modelo de WebhookApiKey** (`src/models/WebhookApiKey.ts`)
**Calificación: 9/10**

✅ **Puntos fuertes:**
- ✅ Generación segura de API keys con `crypto.randomBytes(32)` + prefijo `whk_`
- ✅ Validación con comparación constant-time (`crypto.timingSafeEqual`) - previene timing attacks
- ✅ Rate limiting configurable por API key
- ✅ Tracking de uso (`lastUsedAt`, `requestCount`)
- ✅ Índices en campos críticos (`apiKey`, `projectId`, `isActive`)
- ✅ Soft delete con campo `isActive` en lugar de eliminar

**Estructura:**
```typescript
{
  apiKey: "whk_<64_hex_chars>",
  projectId: ObjectId,
  name: "My App Production",
  isActive: true,
  rateLimit: 60,  // requests per minute
  lastUsedAt: Date,
  requestCount: 0
}
```

---

### 2. **Middleware de Autenticación** (`src/middleware/webhookAuth.ts`)
**Calificación: 8.5/10**

✅ **Puntos fuertes:**
- ✅ Soporta múltiples métodos de autenticación:
  - Header `X-API-Key: whk_xxx`
  - Header `Authorization: Bearer whk_xxx`
- ✅ Logging detallado de autenticación (éxito/fallo)
- ✅ Tracking de IP del cliente (`x-forwarded-for`)
- ✅ Actualización automática de `lastUsedAt` y `requestCount`
- ✅ Manejo de errores robusto
- ✅ Inyecta contexto en `req.webhookAuth` para uso downstream

**Ejemplo de log:**
```
✅ Webhook auth success: project=123 key=[whk_abc123...] | ip=187.33.145.222
```

---

### 3. **Webhook de Errores** (`src/routes/webhooks/errors.ts`)
**Calificación: 9/10**

✅ **Puntos fuertes:**
- ✅ **Validación robusta** con Zod schema
- ✅ **Rate limiting** dinámico por API key
- ✅ **Creación automática de tasks** con prioridad basada en severidad
- ✅ **Orquestación automática** vía `setImmediate()` (no bloquea response)
- ✅ **Logging estructurado** con LogService
- ✅ **Health check** endpoint (`/health`)
- ✅ Respuesta inmediata 201 con `taskId` y `taskUrl`

**Payload esperado:**
```json
{
  "errorType": "TypeError",
  "severity": "critical",
  "message": "Cannot read property 'foo' of undefined",
  "stackTrace": "at file.js:123...",
  "metadata": {
    "userId": "123",
    "route": "/api/users"
  },
  "repository": "backend"
}
```

**Response:**
```json
{
  "success": true,
  "taskId": "68f1234567890abc",
  "taskUrl": "/api/tasks/68f1234567890abc",
  "message": "Error notification received. Task created and orchestration started."
}
```

---

### 4. **Rate Limiting**
**Calificación: 8/10**

✅ **Puntos fuertes:**
- ✅ Rate limit **configurable por API key** (campo `WebhookApiKey.rateLimit`)
- ✅ Ventana de 60 segundos
- ✅ Headers estándar (`RateLimit-*`)
- ✅ Header `Retry-After` en 429 responses
- ✅ Skip automático para `/health` endpoint

**Comportamiento:**
- Default: 60 requests/min
- Personalizable por API key
- Response 429 cuando se excede

---

### 5. **Webhook de GitHub** (`src/routes/webhooks/github.ts`)
**Calificación: 8/10**

✅ **Puntos fuertes:**
- ✅ Verificación de firma HMAC SHA-256
- ✅ Validación de evento `pull_request` + acción `closed` + `merged=true`
- ✅ Cleanup automático de branches epic + story branches
- ✅ Procesamiento asíncrono con `setImmediate()`
- ✅ Respuesta inmediata 200 a GitHub

**Configuración requerida:**
```bash
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
```

---

## ❌ Lo que FALTA o está MAL implementado

### 1. **NO HAY ENDPOINTS PARA GESTIONAR WEBHOOK API KEYS** ⚠️
**Severidad: CRÍTICA**

❌ **Problema:**
- No hay forma de crear WebhookApiKeys desde la API
- No hay forma de listar las keys de un proyecto
- No hay forma de revocar (desactivar) una key
- No hay forma de renovar/regenerar una key comprometida

**Impacto:**
- Los administradores deben crear keys **directamente en MongoDB** 😱
- No hay UI para gestionar keys
- No hay auditoría de quién creó qué key

**Solución necesaria:**
Crear endpoints en `/api/projects/:projectId/webhook-keys`:
```
POST   /api/projects/:projectId/webhook-keys       - Crear nueva key
GET    /api/projects/:projectId/webhook-keys       - Listar keys del proyecto
DELETE /api/projects/:projectId/webhook-keys/:keyId - Revocar key
POST   /api/projects/:projectId/webhook-keys/:keyId/regenerate - Regenerar key
```

---

### 2. **NO HAY DOCUMENTACIÓN DE USO** 📚
**Severidad: ALTA**

❌ **Problema:**
- Desarrolladores externos no saben cómo integrar el webhook
- No hay ejemplos de código (curl, Node.js, Python)
- No hay guía de troubleshooting

**Solución necesaria:**
Crear `docs/WEBHOOK_INTEGRATION_GUIDE.md` con:
- Cómo obtener una API key
- Ejemplos de código en múltiples lenguajes
- Troubleshooting común
- Rate limits y best practices

---

### 3. **VALIDACIÓN DE REPOSITORIO DÉBIL** ⚠️
**Severidad: MEDIA**

❌ **Problema:**
El webhook acepta un campo `repository` opcional pero **no lo usa**:
```typescript
repository: z.string().optional(),  // ← Se valida pero se ignora
```

**Impacto:**
- No se puede dirigir el error a un repositorio específico
- El task se crea con TODOS los repositorios del proyecto

**Solución:**
```typescript
// Si se proporciona repository, usarlo
const repositories = payload.repository
  ? await Repository.find({ projectId, name: payload.repository, isActive: true })
  : await Repository.find({ projectId, isActive: true });

if (repositories.length === 0 && payload.repository) {
  return res.status(400).json({
    error: `Repository "${payload.repository}" not found in project`,
  });
}
```

---

### 4. **FALTA DEDUPLICACIÓN DE ERRORES** 🔁
**Severidad: MEDIA**

❌ **Problema:**
Si la misma error ocurre 1000 veces en producción, **se crearán 1000 tasks**.

**Impacto:**
- Sobrecarga del sistema
- Costos de orquestación innecesarios
- Ruido en el dashboard

**Solución:**
Implementar deduplicación:
```typescript
// Hash del error para identificar duplicados
const errorHash = crypto.createHash('sha256')
  .update(`${errorType}:${message}`)
  .digest('hex');

// Buscar task reciente con mismo error
const existingTask = await Task.findOne({
  projectId,
  'metadata.errorHash': errorHash,
  status: { $in: ['pending', 'in_progress'] },
  createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }, // última hora
});

if (existingTask) {
  // Incrementar contador en lugar de crear nuevo task
  await Task.updateOne(
    { _id: existingTask._id },
    { $inc: { 'metadata.occurrenceCount': 1 } }
  );
  return res.json({ taskId: existingTask._id, deduplicated: true });
}
```

---

### 5. **FALTA WEBHOOK SIGNATURE PARA `/api/webhooks/errors`** 🔒
**Severidad: ALTA**

❌ **Problema:**
El webhook de errores **solo usa API key** sin verificación HMAC.

**Riesgo:**
- Si un atacante roba la API key, puede enviar requests maliciosos

**Mejora:**
Agregar verificación opcional de firma HMAC:
```typescript
// Cliente genera firma
const signature = crypto.createHmac('sha256', SECRET)
  .update(JSON.stringify(payload))
  .digest('hex');

// Headers del request
headers: {
  'X-API-Key': 'whk_xxx',
  'X-Signature': 'sha256=abc123...'
}
```

---

### 6. **NO HAY RETRY AUTOMÁTICO** ♻️
**Severidad: BAJA**

❌ **Problema:**
Si la orquestación falla después de crear el task, **no hay retry automático**.

**Solución:**
Agregar job queue con retries:
```typescript
import Queue from 'bull';

const orchestrationQueue = new Queue('orchestration');

// En el webhook
await orchestrationQueue.add({ taskId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 }
});
```

---

### 7. **LOGS NO INCLUYEN CATEGORÍA WEBHOOK** 📊
**Severidad: BAJA**

❌ **Problema:**
TaskLog.ts define categorías pero falta `'webhook'`:
```typescript
export type LogCategory =
  | 'orchestration'
  | 'agent'
  | ...
  // ❌ NO HAY 'webhook'
```

**Impacto:**
No se puede filtrar logs por origen webhook.

**Solución:**
```typescript
export type LogCategory =
  | 'webhook'          // ← AGREGAR
  | 'orchestration'
  ...
```

---

## 🎯 Resumen de Calificaciones

| Componente | Calificación | Estado |
|-----------|--------------|--------|
| Modelo WebhookApiKey | 9/10 | ✅ Excelente |
| Middleware Auth | 8.5/10 | ✅ Muy bueno |
| Webhook Errores | 9/10 | ✅ Excelente |
| Rate Limiting | 8/10 | ✅ Muy bueno |
| Webhook GitHub | 8/10 | ✅ Muy bueno |
| Gestión de Keys | 0/10 | ❌ **NO EXISTE** |
| Documentación | 0/10 | ❌ **NO EXISTE** |
| Deduplicación | 0/10 | ❌ Falta |
| HMAC Signature | 3/10 | ⚠️ Solo en GitHub |

**Calificación Global: 6.5/10**

---

## 🚀 Plan de Acción Prioritario

### **CRÍTICO** (Implementar YA)
1. ✅ Crear endpoints CRUD para WebhookApiKeys
2. ✅ Agregar documentación de integración

### **IMPORTANTE** (Próxima iteración)
3. ⚠️ Implementar deduplicación de errores
4. ⚠️ Mejorar validación de `repository` field
5. ⚠️ Agregar HMAC signature opcional

### **NICE TO HAVE** (Backlog)
6. ℹ️ Queue con retries automáticos
7. ℹ️ Dashboard de métricas de webhooks
8. ℹ️ Alertas cuando una key está cerca del rate limit

---

## 📝 Ejemplo de Uso Completo

### 1. Crear Webhook API Key (cuando exista el endpoint)
```bash
curl -X POST https://api.yourapp.com/api/projects/123/webhook-keys \
  -H "Authorization: Bearer <user_jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Frontend",
    "rateLimit": 120
  }'

# Response:
{
  "success": true,
  "apiKey": "whk_a1b2c3d4e5f6...",
  "keyId": "68f1234567890abc",
  "rateLimit": 120
}
```

### 2. Integrar en Cliente (Node.js)
```javascript
// error-reporter.js
const crypto = require('crypto');

async function reportError(error, metadata = {}) {
  const payload = {
    errorType: error.name,
    severity: classifySeverity(error),
    message: error.message,
    stackTrace: error.stack,
    metadata: {
      ...metadata,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
    }
  };

  try {
    const response = await fetch('https://api.yourapp.com/api/webhooks/errors', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.WEBHOOK_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`✅ Error reported, taskId: ${data.taskId}`);
    } else {
      console.error(`❌ Failed to report error: ${response.status}`);
    }
  } catch (err) {
    console.error('Error reporter failed:', err);
  }
}

// Uso
process.on('uncaughtException', (error) => {
  reportError(error, { source: 'uncaughtException' });
});

app.use((err, req, res, next) => {
  reportError(err, {
    route: req.path,
    method: req.method,
    userId: req.user?.id
  });
  res.status(500).json({ error: 'Internal server error' });
});
```

### 3. Integrar en Cliente (Python/Flask)
```python
# error_reporter.py
import os
import requests
import traceback
from datetime import datetime

WEBHOOK_URL = "https://api.yourapp.com/api/webhooks/errors"
API_KEY = os.getenv("WEBHOOK_API_KEY")

def report_error(error: Exception, metadata: dict = None):
    payload = {
        "errorType": type(error).__name__,
        "severity": classify_severity(error),
        "message": str(error),
        "stackTrace": traceback.format_exc(),
        "metadata": {
            **(metadata or {}),
            "timestamp": datetime.utcnow().isoformat(),
            "environment": os.getenv("FLASK_ENV", "production"),
        }
    }

    try:
        response = requests.post(
            WEBHOOK_URL,
            json=payload,
            headers={"X-API-Key": API_KEY},
            timeout=5
        )

        if response.ok:
            data = response.json()
            print(f"✅ Error reported, taskId: {data['taskId']}")
        else:
            print(f"❌ Failed to report error: {response.status_code}")
    except Exception as e:
        print(f"Error reporter failed: {e}")

# Uso en Flask
from flask import Flask, request
app = Flask(__name__)

@app.errorhandler(Exception)
def handle_exception(error):
    report_error(error, {
        "route": request.path,
        "method": request.method,
        "user_id": getattr(request, "user_id", None)
    })
    return {"error": "Internal server error"}, 500
```

---

## 🔐 Seguridad: Best Practices Actuales

### ✅ Lo que ya se hace bien:
1. **Constant-time comparison** previene timing attacks
2. **Rate limiting** previene abuse
3. **IP logging** para auditoría
4. **Soft delete** (isActive) en lugar de eliminar keys
5. **HMAC SHA-256** en webhook de GitHub

### ⚠️ Recomendaciones adicionales:
1. **Rotar keys regularmente** (agregar `expiresAt` field)
2. **Alertas de uso anómalo** (spike repentino de requests)
3. **Geolocation blocking** (opcional, bloquear IPs de países no autorizados)
4. **Scopes granulares** (key solo para ciertos repositories)

---

## 📈 Métricas Sugeridas (para Dashboard)

```typescript
interface WebhookMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  rateLimitHits: number;
  tasksCreated: number;
  topErrorTypes: Array<{ type: string; count: number }>;
  requestsByApiKey: Array<{ keyName: string; requests: number }>;
}
```

---

## ✅ Conclusión

**El sistema actual es FUNCIONAL pero INCOMPLETO.**

**Fortalezas:**
- 🔒 Seguridad bien implementada (constant-time, rate limiting)
- 🚀 Orquestación automática funciona correctamente
- 📊 Logging estructurado
- ⚡ Performance optimizada (async processing)

**Debilidades críticas:**
- ❌ **NO hay forma de crear API keys desde la API**
- ❌ **NO hay documentación para desarrolladores externos**
- ⚠️ Falta deduplicación de errores
- ⚠️ HMAC signature solo en GitHub webhook

**Recomendación:**
Implementar endpoints CRUD de WebhookApiKeys y documentación **antes de production release**. Sin esto, el sistema no es usable para integraciones externas.

**Tiempo estimado para completar funcionalidad faltante:**
- CRUD endpoints: 3-4 horas
- Documentación: 2 horas
- Deduplicación: 2-3 horas
- **Total: 7-9 horas de desarrollo**
