/**
 * RateLimiter - Controla rate limits de Anthropic API por modelo
 *
 * Rate Limits por modelo (según docs.claude.com):
 * - Sonnet: 50 RPM, 30k ITPM, 8k OTPM
 * - Haiku: 50 RPM, 50k ITPM, 10k OTPM
 * - Opus: 50 RPM, 30k ITPM, 8k OTPM
 *
 * Usa sliding window de 1 minuto y cola de operaciones
 */

interface TokenUsage {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

interface ModelLimits {
  requestsPerMinute: number;
  inputTokensPerMinute: number;
  outputTokensPerMinute: number;
}

const MODEL_LIMITS: Record<string, ModelLimits> = {
  sonnet: {
    requestsPerMinute: 50,
    inputTokensPerMinute: 30000,
    outputTokensPerMinute: 8000,
  },
  haiku: {
    requestsPerMinute: 50,
    inputTokensPerMinute: 50000,
    outputTokensPerMinute: 10000,
  },
  opus: {
    requestsPerMinute: 50,
    inputTokensPerMinute: 30000,
    outputTokensPerMinute: 8000,
  },
};

export class RateLimiter {
  private usageHistory: Map<string, TokenUsage[]> = new Map(); // Por modelo
  private readonly SAFETY_MARGIN = 0.8; // Usar solo 80% del límite para seguridad
  private readonly WINDOW_MS = 60000; // 1 minuto

  /**
   * Espera hasta que haya capacidad disponible para ejecutar un agente
   * @param model - Modelo a usar (sonnet, haiku, opus)
   * @param estimatedInputTokens - Estimación de tokens de input (opcional)
   */
  async waitForCapacity(model: string, estimatedInputTokens: number = 8000): Promise<void> {
    const limits = MODEL_LIMITS[model] || MODEL_LIMITS.sonnet;

    while (true) {
      const usage = this.getCurrentUsage(model);

      // Calcular límites seguros (80%)
      const safeLimits = {
        requests: limits.requestsPerMinute * this.SAFETY_MARGIN,
        inputTokens: limits.inputTokensPerMinute * this.SAFETY_MARGIN,
        outputTokens: limits.outputTokensPerMinute * this.SAFETY_MARGIN,
      };

      // Verificar si tenemos capacidad
      const hasRequestCapacity = usage.requests < safeLimits.requests;
      const hasInputCapacity = usage.inputTokens + estimatedInputTokens < safeLimits.inputTokens;
      const hasOutputCapacity = usage.outputTokens < safeLimits.outputTokens;

      if (hasRequestCapacity && hasInputCapacity && hasOutputCapacity) {
        // Reservar 1 request
        this.recordRequest(model);
        return;
      }

      // No hay capacidad - esperar y limpiar history antigua
      console.log(`⏳ [Rate Limiter] Waiting for ${model} capacity...`, {
        usage,
        limits: safeLimits,
      });

      await new Promise((resolve) => setTimeout(resolve, 1000)); // Esperar 1 segundo
      this.cleanOldUsage(model);
    }
  }

  /**
   * Registra el uso real de tokens después de ejecutar un agente
   */
  recordUsage(model: string, inputTokens: number, outputTokens: number): void {
    const history = this.usageHistory.get(model) || [];
    history.push({
      timestamp: Date.now(),
      inputTokens,
      outputTokens,
    });
    this.usageHistory.set(model, history);

    // Limpiar entradas antiguas
    this.cleanOldUsage(model);

    console.log(`📊 [Rate Limiter] ${model} usage recorded:`, {
      inputTokens,
      outputTokens,
      total: this.getCurrentUsage(model),
    });
  }

  /**
   * Registra un request sin tokens (para reservar capacity)
   */
  private recordRequest(model: string): void {
    const history = this.usageHistory.get(model) || [];
    history.push({
      timestamp: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
    });
    this.usageHistory.set(model, history);
  }

  /**
   * Obtiene el uso actual en la ventana de 1 minuto
   */
  private getCurrentUsage(model: string): {
    requests: number;
    inputTokens: number;
    outputTokens: number;
  } {
    this.cleanOldUsage(model);
    const history = this.usageHistory.get(model) || [];

    return {
      requests: history.length,
      inputTokens: history.reduce((sum, u) => sum + u.inputTokens, 0),
      outputTokens: history.reduce((sum, u) => sum + u.outputTokens, 0),
    };
  }

  /**
   * Limpia entradas fuera de la ventana de 1 minuto
   */
  private cleanOldUsage(model: string): void {
    const history = this.usageHistory.get(model) || [];
    const cutoff = Date.now() - this.WINDOW_MS;
    const recent = history.filter((u) => u.timestamp > cutoff);
    this.usageHistory.set(model, recent);
  }

  /**
   * Obtiene stats para logging
   */
  getStats(): Record<string, any> {
    const stats: Record<string, any> = {};

    for (const model of Object.keys(MODEL_LIMITS)) {
      const usage = this.getCurrentUsage(model);
      const limits = MODEL_LIMITS[model];

      stats[model] = {
        usage,
        limits,
        percentUsed: {
          requests: ((usage.requests / limits.requestsPerMinute) * 100).toFixed(1) + '%',
          inputTokens: ((usage.inputTokens / limits.inputTokensPerMinute) * 100).toFixed(1) + '%',
          outputTokens: ((usage.outputTokens / limits.outputTokensPerMinute) * 100).toFixed(1) + '%',
        },
      };
    }

    return stats;
  }
}
