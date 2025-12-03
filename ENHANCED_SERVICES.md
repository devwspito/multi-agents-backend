# Enhanced Services - Guía de Configuración

Este documento describe los nuevos servicios de mejora de rendimiento, confiabilidad e integración con GitHub.

## 🛡️ Diseño Seguro

**Todas las características están DESACTIVADAS por defecto**. El sistema funciona exactamente igual que antes hasta que actives las características explícitamente.

## 🚀 Características Disponibles

### 1. Circuit Breaker (`ENABLE_CIRCUIT_BREAKER=true`)
Previene fallos en cascada al detectar cuando un agente falla repetidamente.

**Cómo funciona:**
- Monitorea la tasa de fallos por tipo de agente
- Si >50% de las operaciones fallan en 1 minuto, "abre" el circuito
- Bloquea nuevas peticiones durante 30 segundos (cooldown)
- Prueba recuperación con "half-open" antes de cerrar

### 2. GitHub Rate Limiter (`ENABLE_GITHUB_RATE_LIMITER=true`)
Previene throttling de la API de GitHub al respetar los límites de tasa.

**Límites monitoreados:**
- Core API: 5000 requests/hora
- Search API: 30 requests/minuto
- Secondary (anti-abuse): 100 requests/minuto

### 3. GitHub Checks API (`ENABLE_GITHUB_CHECKS=true`)
Crea Check Runs en GitHub para mostrar el estado de las fases.

**Beneficios:**
- Feedback visual en PRs
- Bloqueo de merge si tests fallan
- Anotaciones de código en archivos

### 4. Performance Cache (`ENABLE_PERFORMANCE_CACHE=true`)
Caché multi-nivel con Redis para acelerar operaciones frecuentes.

**Datos cacheados:**
- Verificación de branches (5 min TTL)
- Metadata de repositorios (1 hora TTL)
- Información de PRs (2 min TTL)
- Resultados de diffs (5 min TTL)

### 5. Enhanced Git Execution (`ENABLE_ENHANCED_GIT_EXECUTION=true`)
Mejora las operaciones de git con retry automático y caché.

**Características:**
- Retry automático con backoff exponencial
- Integración con circuit breaker
- Caché de verificación de branches

### 6. Aggressive Compaction (`ENABLE_AGGRESSIVE_COMPACTION=true`)
Compacta el contexto de los agentes más temprano (65% vs 80%).

### 7. Dynamic Parallelism (`ENABLE_DYNAMIC_PARALLELISM=true`)
Ajusta el número de workers paralelos dinámicamente.

## 📝 Configuración

### Variables de Entorno

```bash
# Redis (requerido para la mayoría de características)
REDIS_URL=rediss://your-redis-url:6379

# Feature Flags (todos opcionales, false por defecto)
ENABLE_CIRCUIT_BREAKER=true
ENABLE_GITHUB_RATE_LIMITER=true
ENABLE_GITHUB_CHECKS=true
ENABLE_PERFORMANCE_CACHE=true
ENABLE_ENHANCED_GIT_EXECUTION=true
ENABLE_AGGRESSIVE_COMPACTION=true
ENABLE_DYNAMIC_PARALLELISM=true
```

### Ejemplo de .env

```bash
# ... otras variables existentes ...

# Redis
REDIS_URL=rediss://red-xxx:6379

# Habilitar todas las mejoras
ENABLE_CIRCUIT_BREAKER=true
ENABLE_GITHUB_RATE_LIMITER=true
ENABLE_PERFORMANCE_CACHE=true
ENABLE_ENHANCED_GIT_EXECUTION=true
```

## 🔍 Diagnóstico

### Endpoints

1. **Estado de servicios mejorados:**
   ```
   GET /api/diagnostics/enhanced-services
   ```

2. **Health check rápido:**
   ```
   GET /api/diagnostics/health
   ```

### Ejemplo de respuesta

```json
{
  "success": true,
  "overview": {
    "totalFeatures": 7,
    "enabledFeatures": 3,
    "mode": "enhanced"
  },
  "featureFlags": {
    "ENABLE_CIRCUIT_BREAKER": true,
    "ENABLE_PERFORMANCE_CACHE": true,
    "ENABLE_ENHANCED_GIT_EXECUTION": true
  },
  "services": {
    "redis": {
      "connected": true,
      "mode": "redis"
    },
    "circuitBreaker": {
      "enabled": true,
      "circuits": []
    }
  }
}
```

## 🔄 Fallback Automático

Si Redis no está disponible:
- El sistema usa caché en memoria
- Todas las funciones siguen funcionando
- Solo con menor rendimiento distribuido

## 📁 Archivos Creados

```
src/
├── config/
│   └── FeatureFlags.ts          # Configuración de feature flags
├── services/
│   ├── cache/
│   │   ├── RedisService.ts      # Conexión y operaciones Redis
│   │   └── PerformanceCacheService.ts  # Caché multi-nivel
│   ├── resilience/
│   │   └── CircuitBreakerService.ts    # Circuit breaker
│   ├── github/
│   │   ├── GitHubRateLimiter.ts        # Rate limiting
│   │   └── GitHubChecksService.ts      # GitHub Checks API
│   └── EnhancedServicesInitializer.ts  # Inicializador central
└── utils/
    └── enhancedGitExecution.ts  # Git mejorado con retry
```

## ⚠️ Troubleshooting

### Redis no conecta
1. Verifica que `REDIS_URL` sea correcto
2. El sistema usará caché en memoria automáticamente
3. Revisa logs: `⚠️  [Redis] Failed to connect`

### Circuit breaker bloqueando peticiones
1. Endpoint: `GET /api/diagnostics/enhanced-services`
2. Busca circuitos en estado "open"
3. Espera 30s para cooldown automático
4. O desactiva: `ENABLE_CIRCUIT_BREAKER=false`

### Rate limiter muy restrictivo
1. Revisa headers de GitHub en logs
2. Endpoint muestra límites actuales
3. Espera al reset automático

## 🎯 Recomendaciones

### Entorno de Desarrollo
```bash
# Solo lo esencial
ENABLE_PERFORMANCE_CACHE=true
```

### Entorno de Producción
```bash
# Todo habilitado
ENABLE_CIRCUIT_BREAKER=true
ENABLE_GITHUB_RATE_LIMITER=true
ENABLE_GITHUB_CHECKS=true
ENABLE_PERFORMANCE_CACHE=true
ENABLE_ENHANCED_GIT_EXECUTION=true
```

## 📊 Impacto Esperado

| Métrica | Sin mejoras | Con mejoras | Mejora |
|---------|-------------|-------------|--------|
| Git ops retry | 0% | +98% | Auto-recovery |
| Cache hit rate | 0% | 40-60% | Velocidad |
| Rate limit errors | Variable | ~0 | Estabilidad |
| Cascading failures | Posible | Prevenido | Confiabilidad |
