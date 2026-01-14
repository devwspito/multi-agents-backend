/**
 * ServiceIntegrationLayer - Connects all services with OrchestrationCoordinator
 *
 * Provides a unified interface for:
 * - Service initialization and coordination
 * - Hook integration with orchestration phases
 * - Metrics collection during orchestration
 * - Plugin lifecycle tied to orchestration
 * - Caching and performance optimization
 */

import { ServiceRegistry, initializeServices } from './ServiceRegistry';
import { AdvancedMetrics } from './AdvancedMetrics';
import { PluginSystem } from './PluginSystem';
import { SmartCacheLayer } from './SmartCacheLayer';
import { IntentPredictor } from './IntentPredictor';

// Integration configuration
interface IntegrationConfig {
  enableMetrics: boolean;
  enablePlugins: boolean;
  enableCaching: boolean;
  enableIntentPrediction: boolean;
  enablePerformanceProfiling: boolean;
  pluginsDir?: string;
  metricsOutputDir?: string;
  budgetLimit?: number;
  cacheMaxSize?: number;
}

// Orchestration phase context
interface PhaseContext {
  taskId: string;
  phaseName: string;
  agentType: string;
  input: Record<string, any>;
  startTime: number;
  traceId?: string;
  spanId?: string;
}

// Enhanced orchestration result
interface EnhancedResult {
  original: any;
  metrics: {
    duration: number;
    tokensUsed?: number;
    cost?: number;
  };
  predictions?: {
    nextPhase?: string;
    suggestedActions?: string[];
  };
  performance?: {
    bottlenecks?: string[];
    suggestions?: string[];
  };
}

// Service integration events
type IntegrationEvent =
  | { type: 'orchestration:start'; taskId: string }
  | { type: 'orchestration:complete'; taskId: string; success: boolean }
  | { type: 'phase:start'; taskId: string; phase: string }
  | { type: 'phase:complete'; taskId: string; phase: string; duration: number }
  | { type: 'phase:error'; taskId: string; phase: string; error: Error }
  | { type: 'budget:warning'; current: number; limit: number }
  | { type: 'performance:alert'; phase: string; issue: string };

type EventHandler = (event: IntegrationEvent) => void;

/**
 * Main integration layer connecting all services
 */
export class ServiceIntegrationLayer {
  private static instance: ServiceIntegrationLayer;
  private registry: ServiceRegistry;
  private metrics: AdvancedMetrics;
  private plugins: PluginSystem;
  private cache: SmartCacheLayer;
  private intentPredictor: IntentPredictor;
  private config: IntegrationConfig;
  private initialized: boolean = false;
  private eventHandlers: Set<EventHandler> = new Set();
  private activePhases: Map<string, PhaseContext> = new Map();

  private constructor(config: Partial<IntegrationConfig> = {}) {
    this.config = {
      enableMetrics: true,
      enablePlugins: true,
      enableCaching: true,
      enableIntentPrediction: true,
      enablePerformanceProfiling: true,
      ...config
    };

    // Initialize core components
    this.registry = ServiceRegistry.getInstance();
    this.metrics = new AdvancedMetrics({
      outputDir: config.metricsOutputDir,
      budgetLimit: config.budgetLimit
    });
    this.plugins = new PluginSystem({
      pluginsDir: config.pluginsDir
    });
    this.cache = SmartCacheLayer.getInstance({
      maxSize: config.cacheMaxSize || 100 * 1024 * 1024 // 100MB
    });
    this.intentPredictor = new IntentPredictor();
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<IntegrationConfig>): ServiceIntegrationLayer {
    if (!ServiceIntegrationLayer.instance) {
      ServiceIntegrationLayer.instance = new ServiceIntegrationLayer(config);
    }
    return ServiceIntegrationLayer.instance;
  }

  /**
   * Initialize all services
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize service registry with all services
    await initializeServices();

    // Register metrics and plugins as services
    this.registry.register('AdvancedMetrics', () => this.metrics, {
      category: 'utility',
      singleton: true
    });

    this.registry.register('PluginSystem', () => this.plugins, {
      category: 'utility',
      singleton: true
    });

    // Discover and load plugins
    if (this.config.enablePlugins) {
      await this.plugins.discoverPlugins();
    }

    // Setup metric hooks
    this.setupMetricHooks();

    // Setup performance monitoring
    this.setupPerformanceMonitoring();

    this.initialized = true;
    this.metrics.info('ServiceIntegrationLayer initialized');
  }

  /**
   * Wrap phase execution with metrics and hooks
   */
  async executePhase<T>(
    taskId: string,
    phaseName: string,
    agentType: string,
    executor: () => Promise<T>,
    input: Record<string, any> = {}
  ): Promise<EnhancedResult> {
    const context: PhaseContext = {
      taskId,
      phaseName,
      agentType,
      input,
      startTime: Date.now()
    };

    // Start trace
    if (this.config.enableMetrics) {
      context.traceId = this.metrics.startTrace(`phase:${phaseName}`);
      context.spanId = this.metrics.startSpan(phaseName, context.traceId, {
        taskId,
        agentType
      });
    }

    this.activePhases.set(`${taskId}:${phaseName}`, context);
    this.emit({ type: 'phase:start', taskId, phase: phaseName });

    // Execute plugin hooks before phase
    let enhancedInput = input;
    if (this.config.enablePlugins) {
      enhancedInput = await this.plugins.executeHook('beforePhase', {
        taskId,
        phase: phaseName,
        input
      });
    }

    // Check cache for similar operations
    let result: T;
    let fromCache = false;

    const cacheKey = this.generateCacheKey(phaseName, enhancedInput);
    if (this.config.enableCaching && this.cache.has(cacheKey)) {
      result = this.cache.get(cacheKey) as T;
      fromCache = true;
      this.metrics.increment('cache_hits_total', 1, { phase: phaseName });
    } else {
      try {
        // Execute the actual phase
        result = await this.metrics.time(
          'operation_duration_ms',
          executor,
          { phase: phaseName, taskId }
        );

        // Cache result if cacheable
        if (this.config.enableCaching && this.isCacheable(phaseName)) {
          this.cache.set(cacheKey, result, { ttl: 300000 }); // 5 min TTL
        }
      } catch (error: any) {
        this.handlePhaseError(context, error);
        throw error;
      }
    }

    // Execute plugin hooks after phase
    if (this.config.enablePlugins) {
      const hookResult = await this.plugins.executeHook('afterPhase', {
        taskId,
        phase: phaseName,
        result
      });
      result = hookResult.result as T;
    }

    const duration = Date.now() - context.startTime;

    // End span
    if (context.spanId) {
      this.metrics.endSpan(context.spanId);
    }

    // Record metrics
    this.recordPhaseMetrics(context, duration, fromCache);

    // Generate predictions
    const predictions = this.config.enableIntentPrediction
      ? this.generatePredictions(phaseName, result)
      : undefined;

    // Check performance
    const performance = this.config.enablePerformanceProfiling
      ? await this.checkPerformance(phaseName, duration)
      : undefined;

    this.activePhases.delete(`${taskId}:${phaseName}`);
    this.emit({ type: 'phase:complete', taskId, phase: phaseName, duration });

    return {
      original: result,
      metrics: {
        duration,
        tokensUsed: this.extractTokensFromResult(result),
        cost: this.calculateCost(result)
      },
      predictions,
      performance
    };
  }

  /**
   * Start orchestration tracking
   */
  startOrchestration(taskId: string, context: Record<string, any> = {}): string {
    const traceId = this.metrics.startTrace(`orchestration:${taskId}`, context);
    this.emit({ type: 'orchestration:start', taskId });
    this.metrics.setGauge('active_orchestrations', this.activePhases.size + 1);
    return traceId;
  }

  /**
   * Complete orchestration tracking
   */
  completeOrchestration(taskId: string, success: boolean): void {
    this.emit({ type: 'orchestration:complete', taskId, success });
    this.metrics.increment('orchestrations_total', 1, {
      status: success ? 'success' : 'failure'
    });
    this.metrics.setGauge('active_orchestrations', Math.max(0, this.activePhases.size - 1));
  }

  /**
   * Track AI operation cost
   */
  trackAICost(
    operation: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): void {
    this.metrics.trackCost({
      operation,
      model,
      inputTokens,
      outputTokens
    });

    // Check budget warning
    const summary = this.metrics.getCostSummary();
    if (this.config.budgetLimit && summary.totalCost >= this.config.budgetLimit * 0.9) {
      this.emit({
        type: 'budget:warning',
        current: summary.totalCost,
        limit: this.config.budgetLimit
      });
    }
  }

  /**
   * Get service from registry
   */
  async getService<T>(name: string): Promise<T> {
    return this.registry.get<T>(name);
  }

  /**
   * Subscribe to events
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Get integration status
   */
  getStatus(): {
    initialized: boolean;
    services: number;
    plugins: number;
    activePhases: number;
    cacheSize: number;
    orchestrationsTotal: number;
  } {
    return {
      initialized: this.initialized,
      services: this.registry.list().length,
      plugins: this.plugins.listPlugins().length,
      activePhases: this.activePhases.size,
      cacheSize: this.cache.size(),
      orchestrationsTotal: this.metrics.getMetricValue('orchestrations_total') || 0
    };
  }

  /**
   * Get comprehensive dashboard data
   */
  getDashboardData(): Record<string, any> {
    const costSummary = this.metrics.getCostSummary();
    const registryStats = this.registry.getStats();

    return {
      overview: {
        totalOrchestrations: this.metrics.getMetricValue('orchestrations_total'),
        activeOperations: this.activePhases.size,
        servicesLoaded: registryStats.loadedServices,
        pluginsActive: this.plugins.listPlugins().filter(p => p.state === 'active').length
      },
      costs: {
        total: costSummary.totalCost.toFixed(4),
        byModel: costSummary.byModel,
        tokensProcessed: costSummary.totalTokens
      },
      performance: {
        cacheHitRate: this.calculateCacheHitRate(),
        avgPhaseDuration: this.calculateAvgPhaseDuration()
      },
      alerts: this.metrics.getActiveAlerts(),
      recentLogs: this.metrics.getLogs({ limit: 10 })
    };
  }

  /**
   * Export all metrics
   */
  exportMetrics(format: 'json' | 'prometheus' = 'json'): string {
    return format === 'json'
      ? this.metrics.exportJSON()
      : this.metrics.exportPrometheus();
  }

  // ==================== PRIVATE METHODS ====================

  private setupMetricHooks(): void {
    // Setup alert rules
    this.metrics.addAlertRule({
      name: 'high-error-rate',
      metric: 'errors_total',
      condition: 'gt',
      threshold: 10,
      duration: 60,
      severity: 'critical',
      message: 'Error rate is too high',
      cooldown: 300
    });

    this.metrics.addAlertRule({
      name: 'budget-exceeded',
      metric: 'ai_operation_cost_total',
      condition: 'gt',
      threshold: this.config.budgetLimit || 100,
      duration: 1,
      severity: 'critical',
      message: 'AI operation budget exceeded',
      cooldown: 3600
    });

    // Register custom metrics
    this.metrics.registerMetric({
      name: 'phase_duration_ms',
      type: 'histogram',
      description: 'Phase execution duration',
      labels: ['phase', 'agent_type', 'cached']
    });

    this.metrics.registerMetric({
      name: 'cache_hits_total',
      type: 'counter',
      description: 'Cache hit count',
      labels: ['phase']
    });

    this.metrics.registerMetric({
      name: 'orchestrations_total',
      type: 'counter',
      description: 'Total orchestrations',
      labels: ['status']
    });

    this.metrics.registerMetric({
      name: 'active_orchestrations',
      type: 'gauge',
      description: 'Currently active orchestrations',
      labels: []
    });
  }

  private setupPerformanceMonitoring(): void {
    // Check alerts periodically
    setInterval(() => {
      const alerts = this.metrics.checkAlerts();
      for (const alert of alerts) {
        this.metrics.warn(`Alert triggered: ${alert.rule.name}`, {
          value: alert.value,
          threshold: alert.rule.threshold
        });
      }
    }, 60000); // Every minute
  }

  private handlePhaseError(context: PhaseContext, error: Error): void {
    if (context.spanId) {
      this.metrics.endSpan(context.spanId, 'error');
    }

    this.metrics.increment('errors_total', 1, {
      type: 'phase_error',
      severity: 'error'
    });

    this.metrics.error(`Phase ${context.phaseName} failed`, error, {
      taskId: context.taskId,
      phase: context.phaseName
    });

    this.emit({
      type: 'phase:error',
      taskId: context.taskId,
      phase: context.phaseName,
      error
    });
  }

  private recordPhaseMetrics(
    context: PhaseContext,
    duration: number,
    fromCache: boolean
  ): void {
    this.metrics.observe('phase_duration_ms', duration, {
      phase: context.phaseName,
      agent_type: context.agentType,
      cached: String(fromCache)
    });

    this.metrics.info(`Phase ${context.phaseName} completed`, {
      taskId: context.taskId,
      duration,
      cached: fromCache
    });
  }

  private generatePredictions(
    phaseName: string,
    _result: any
  ): { nextPhase?: string; suggestedActions?: string[] } {
    // Use intent predictor for suggestions
    const prediction = this.intentPredictor.predict(
      `completed ${phaseName} phase`
    );

    return {
      suggestedActions: prediction.suggestedActions.map(a => a.action)
    };
  }

  private async checkPerformance(
    phaseName: string,
    duration: number
  ): Promise<{ bottlenecks?: string[]; suggestions?: string[] } | undefined> {
    const bottlenecks: string[] = [];
    const suggestions: string[] = [];

    // Check for slow phases
    if (duration > 30000) {
      bottlenecks.push(`Phase ${phaseName} took ${duration}ms (>30s)`);
      suggestions.push('Consider breaking down into smaller operations');
      this.emit({
        type: 'performance:alert',
        phase: phaseName,
        issue: 'slow-execution'
      });
    }

    return bottlenecks.length > 0 ? { bottlenecks, suggestions } : undefined;
  }

  private generateCacheKey(phase: string, input: any): string {
    const inputHash = JSON.stringify(input).slice(0, 100);
    return `phase:${phase}:${inputHash}`;
  }

  private isCacheable(phaseName: string): boolean {
    // These phases produce deterministic results
    const cacheablePhases = [
      'analyze',
      'parse',
      'lint',
      'format',
      'type-check'
    ];
    return cacheablePhases.some(p => phaseName.toLowerCase().includes(p));
  }

  private extractTokensFromResult(result: any): number | undefined {
    if (typeof result === 'object' && result !== null) {
      return result.tokensUsed || result.usage?.total_tokens;
    }
    return undefined;
  }

  private calculateCost(result: any): number | undefined {
    const tokens = this.extractTokensFromResult(result);
    if (tokens) {
      // Rough estimate based on average model cost
      return (tokens * 3) / 1_000_000; // $3 per 1M tokens average
    }
    return undefined;
  }

  private calculateCacheHitRate(): number {
    const hits = this.metrics.getMetricValue('cache_hits_total') || 0;
    const total = this.metrics.getMetricValue('orchestrations_total') || 1;
    return hits / total;
  }

  private calculateAvgPhaseDuration(): number {
    // This would need histogram data analysis
    return 0; // Placeholder
  }

  private emit(event: IntegrationEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Integration event handler error:', error);
      }
    }
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## ServiceIntegrationLayer - Unified Service Coordination

Connects all services with the orchestration system.

### Initialization
\`\`\`typescript
const integration = ServiceIntegrationLayer.getInstance({
  enableMetrics: true,
  enablePlugins: true,
  enableCaching: true,
  budgetLimit: 10.00
});
await integration.initialize();
\`\`\`

### Phase Execution
\`\`\`typescript
const result = await integration.executePhase(
  taskId,
  'analyze',
  'ProblemAnalyst',
  async () => {
    // Phase implementation
    return analysis;
  },
  { requirement: '...' }
);

// Result includes:
// - original: the phase result
// - metrics: duration, tokens, cost
// - predictions: suggested next actions
// - performance: bottleneck warnings
\`\`\`

### Cost Tracking
\`\`\`typescript
integration.trackAICost('analyze', 'sonnet', 1000, 500);
const dashboard = integration.getDashboardData();
\`\`\`

### Events
\`\`\`typescript
integration.on(event => {
  switch (event.type) {
    case 'phase:start': ...
    case 'phase:complete': ...
    case 'budget:warning': ...
    case 'performance:alert': ...
  }
});
\`\`\`

### Metrics Export
\`\`\`typescript
// Prometheus format
const prometheus = integration.exportMetrics('prometheus');

// JSON format
const json = integration.exportMetrics('json');
\`\`\`
    `;
  }
}

/**
 * Convenience function to get the integration layer
 */
export function getIntegrationLayer(config?: Partial<IntegrationConfig>): ServiceIntegrationLayer {
  return ServiceIntegrationLayer.getInstance(config);
}
