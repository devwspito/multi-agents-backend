/**
 * 🚨 PRODUCTIVITY MONITOR
 * Previene que los developers gasten tiempo y dinero sin producir nada
 * NUNCA MÁS: 11 minutos, $1.20, 0 archivos modificados
 */

interface ActivityMetrics {
  toolUses: Map<string, number>;
  lastProductiveAction: Date | null;
  totalTokens: number;
  totalCost: number;
  filesModified: Set<string>;
  startTime: Date;
  // 🔥 Dynamic limits from Tech Lead
  maxReadsAllowed?: number;
  expectedFiles?: string[];
}

interface ProductivityLimits {
  maxReadsWithoutWrite: number;      // Máximo de Reads sin Write/Edit
  maxTokensWithoutProgress: number;   // Máximo tokens sin acción productiva
  maxTimeWithoutProgress: number;     // Máximo tiempo (ms) sin progreso
  maxCostWithoutOutput: number;       // Máximo costo ($) sin output
  checkInterval: number;               // Intervalo de verificación (ms)
}

export class ProductivityMonitor {
  private metrics: Map<string, ActivityMetrics> = new Map();

  private readonly DEFAULT_LIMITS: ProductivityLimits = {
    maxReadsWithoutWrite: 8,           // Máximo 8 Reads sin Write/Edit (más estricto)
    maxTokensWithoutProgress: 4000,    // Máximo 4k tokens sin progreso (más estricto)
    maxTimeWithoutProgress: 60000,     // Máximo 1 minuto sin progreso (MÁS ESTRICTO)
    maxCostWithoutOutput: 0.15,        // Máximo $0.15 sin output (más estricto)
    checkInterval: 30000,               // Verificar cada 30 segundos
  };

  /**
   * Inicia el monitoreo para un agente
   * @param options.maxReadsAllowed - Dynamic limit from Tech Lead (overrides default)
   * @param options.expectedFiles - Files that Tech Lead expects developer to modify
   */
  startMonitoring(
    agentId: string,
    agentType: string,
    options?: {
      maxReadsAllowed?: number;
      expectedFiles?: string[];
    }
  ): void {
    const maxReads = options?.maxReadsAllowed || this.DEFAULT_LIMITS.maxReadsWithoutWrite;

    console.log(`🔍 [ProductivityMonitor] Starting monitoring for ${agentType} (${agentId})`);
    if (options?.maxReadsAllowed) {
      console.log(`   📊 Dynamic limit from Tech Lead: Max ${maxReads} reads`);
    }
    if (options?.expectedFiles && options.expectedFiles.length > 0) {
      console.log(`   📁 Expected files (${options.expectedFiles.length}): ${options.expectedFiles.join(', ')}`);
    }

    this.metrics.set(agentId, {
      toolUses: new Map(),
      lastProductiveAction: null,
      totalTokens: 0,
      totalCost: 0,
      filesModified: new Set(),
      startTime: new Date(),
      maxReadsAllowed: maxReads,
      expectedFiles: options?.expectedFiles,
    });
  }

  /**
   * Registra uso de herramienta
   */
  recordToolUse(agentId: string, toolName: string, input?: any): void {
    const metrics = this.metrics.get(agentId);
    if (!metrics) {
      console.warn(`⚠️ [ProductivityMonitor] No metrics found for agent: ${agentId}`);
      return;
    }

    // Incrementar contador de herramienta
    const currentCount = metrics.toolUses.get(toolName) || 0;
    metrics.toolUses.set(toolName, currentCount + 1);

    console.log(`📊 [ProductivityMonitor] Tool use recorded: ${toolName} (count: ${currentCount + 1})`);

    // Si es una herramienta productiva, actualizar última acción
    if (this.isProductiveTool(toolName)) {
      metrics.lastProductiveAction = new Date();

      // Si es Write/Edit, registrar archivo modificado
      if ((toolName === 'Write' || toolName === 'Edit') && input?.file_path) {
        metrics.filesModified.add(input.file_path);
        console.log(`✅ [ProductivityMonitor] Productive action: ${toolName} on ${input.file_path}`);
        console.log(`   Total files modified: ${metrics.filesModified.size}`);
      } else if (toolName === 'Write' || toolName === 'Edit') {
        console.warn(`⚠️ [ProductivityMonitor] ${toolName} tool without file_path:`, input);
      }
    }
  }

  /**
   * Actualiza métricas de tokens/costo
   */
  updateMetrics(agentId: string, tokens: number, cost: number): void {
    const metrics = this.metrics.get(agentId);
    if (!metrics) return;

    metrics.totalTokens += tokens;
    metrics.totalCost += cost;
  }

  /**
   * Verifica si el agente está siendo productivo
   * @returns {ProductivityCheck} Resultado de la verificación
   */
  checkProductivity(agentId: string): ProductivityCheck {
    const metrics = this.metrics.get(agentId);
    if (!metrics) {
      return { isProductive: true, reason: null, shouldAbort: false };
    }

    const now = new Date();
    const elapsedTime = now.getTime() - metrics.startTime.getTime();
    const timeSinceLastProductive = metrics.lastProductiveAction
      ? now.getTime() - metrics.lastProductiveAction.getTime()
      : elapsedTime;

    // Obtener contadores de herramientas
    const readCount = metrics.toolUses.get('Read') || 0;
    const writeCount = metrics.toolUses.get('Write') || 0;
    const editCount = metrics.toolUses.get('Edit') || 0;
    const productiveActions = writeCount + editCount;

    // 🔥 USE DYNAMIC LIMIT from Tech Lead (if provided)
    const maxReadsAllowed = metrics.maxReadsAllowed || this.DEFAULT_LIMITS.maxReadsWithoutWrite;

    // VERIFICACIÓN 1: Demasiados Reads sin Write/Edit (límite dinámico)
    if (readCount > maxReadsAllowed && productiveActions === 0) {
      const techLeadGuidance = metrics.maxReadsAllowed
        ? `Tech Lead specified ${maxReadsAllowed} max reads`
        : `Default limit: ${this.DEFAULT_LIMITS.maxReadsWithoutWrite} reads`;

      return {
        isProductive: false,
        reason: `${readCount} Reads without any Write/Edit actions (${techLeadGuidance})`,
        shouldAbort: true,
        metrics: {
          reads: readCount,
          writes: writeCount,
          edits: editCount,
          filesModified: metrics.filesModified.size,
          totalTokens: metrics.totalTokens,
          totalCost: metrics.totalCost,
          elapsedTime: Math.round(elapsedTime / 1000),
        }
      };
    }

    // VERIFICACIÓN 2: Demasiado tiempo sin progreso
    if (timeSinceLastProductive > this.DEFAULT_LIMITS.maxTimeWithoutProgress && productiveActions === 0) {
      return {
        isProductive: false,
        reason: `${Math.round(timeSinceLastProductive / 1000)}s without productive action`,
        shouldAbort: true,
        metrics: {
          reads: readCount,
          writes: writeCount,
          edits: editCount,
          filesModified: metrics.filesModified.size,
          totalTokens: metrics.totalTokens,
          totalCost: metrics.totalCost,
          elapsedTime: Math.round(elapsedTime / 1000),
        }
      };
    }

    // VERIFICACIÓN 3: Demasiado costo sin output
    if (metrics.totalCost > this.DEFAULT_LIMITS.maxCostWithoutOutput && metrics.filesModified.size === 0) {
      return {
        isProductive: false,
        reason: `$${metrics.totalCost.toFixed(4)} spent without modifying any files`,
        shouldAbort: true,
        metrics: {
          reads: readCount,
          writes: writeCount,
          edits: editCount,
          filesModified: metrics.filesModified.size,
          totalTokens: metrics.totalTokens,
          totalCost: metrics.totalCost,
          elapsedTime: Math.round(elapsedTime / 1000),
        }
      };
    }

    // VERIFICACIÓN 4: Demasiados tokens sin archivos modificados
    if (metrics.totalTokens > this.DEFAULT_LIMITS.maxTokensWithoutProgress && metrics.filesModified.size === 0) {
      return {
        isProductive: false,
        reason: `${metrics.totalTokens} tokens without modifying any files`,
        shouldAbort: true,
        metrics: {
          reads: readCount,
          writes: writeCount,
          edits: editCount,
          filesModified: metrics.filesModified.size,
          totalTokens: metrics.totalTokens,
          totalCost: metrics.totalCost,
          elapsedTime: Math.round(elapsedTime / 1000),
        }
      };
    }

    // Si llegamos aquí, el agente está siendo productivo
    return {
      isProductive: true,
      reason: null,
      shouldAbort: false,
      metrics: {
        reads: readCount,
        writes: writeCount,
        edits: editCount,
        filesModified: metrics.filesModified.size,
        totalTokens: metrics.totalTokens,
        totalCost: metrics.totalCost,
        elapsedTime: Math.round(elapsedTime / 1000),
      }
    };
  }

  /**
   * Obtiene resumen final de productividad
   */
  getFinalReport(agentId: string): ProductivityReport {
    const metrics = this.metrics.get(agentId);
    if (!metrics) {
      return {
        wasProductive: false,
        filesModified: [],
        totalCost: 0,
        totalTokens: 0,
        totalTime: 0,
        toolUsage: {},
      };
    }

    const elapsedTime = new Date().getTime() - metrics.startTime.getTime();
    const toolUsage: Record<string, number> = {};
    metrics.toolUses.forEach((count, tool) => {
      toolUsage[tool] = count;
    });

    return {
      wasProductive: metrics.filesModified.size > 0,
      filesModified: Array.from(metrics.filesModified),
      totalCost: metrics.totalCost,
      totalTokens: metrics.totalTokens,
      totalTime: Math.round(elapsedTime / 1000),
      toolUsage,
    };
  }

  /**
   * Limpia métricas de un agente
   */
  cleanup(agentId: string): void {
    this.metrics.delete(agentId);
  }

  /**
   * Determina si una herramienta es productiva
   */
  private isProductiveTool(toolName: string): boolean {
    const productiveTools = [
      'Write',
      'Edit',
      'NotebookEdit',
      'Bash',  // Solo si modifica archivos
      'SlashCommand',
      'Task',  // Lanza otros agentes
    ];

    return productiveTools.includes(toolName);
  }
}

// Tipos exportados
export interface ProductivityCheck {
  isProductive: boolean;
  reason: string | null;
  shouldAbort: boolean;
  metrics?: {
    reads: number;
    writes: number;
    edits: number;
    filesModified: number;
    totalTokens: number;
    totalCost: number;
    elapsedTime: number;
  };
}

export interface ProductivityReport {
  wasProductive: boolean;
  filesModified: string[];
  totalCost: number;
  totalTokens: number;
  totalTime: number;
  toolUsage: Record<string, number>;
}

// Singleton instance
const productivityMonitor = new ProductivityMonitor();
export default productivityMonitor;