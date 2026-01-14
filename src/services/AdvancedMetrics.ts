/**
 * AdvancedMetrics - Comprehensive metrics and logging service
 *
 * Provides:
 * - Performance metrics collection
 * - Structured logging with context
 * - Distributed tracing
 * - Real-time dashboards
 * - Alerting thresholds
 * - Cost tracking for AI operations
 */

import * as fs from 'fs';
import * as path from 'path';

// Metric types
type MetricType = 'counter' | 'gauge' | 'histogram' | 'summary';

interface MetricDefinition {
  name: string;
  type: MetricType;
  description: string;
  labels: string[];
  unit?: string;
}

interface MetricValue {
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

interface HistogramBucket {
  le: number; // Less than or equal
  count: number;
}

interface HistogramValue {
  buckets: HistogramBucket[];
  sum: number;
  count: number;
  labels: Record<string, string>;
}

// Log levels
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: Date;
  context: Record<string, any>;
  traceId?: string;
  spanId?: string;
  duration?: number;
  error?: Error;
}

// Trace and span for distributed tracing
interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error';
  attributes: Record<string, any>;
  events: SpanEvent[];
}

interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: Record<string, any>;
}

// Alert configuration
interface AlertRule {
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  duration: number; // Seconds
  severity: 'warning' | 'critical';
  message: string;
  cooldown: number; // Seconds between alerts
}

interface Alert {
  rule: AlertRule;
  triggeredAt: Date;
  value: number;
  resolved: boolean;
  resolvedAt?: Date;
}

// Cost tracking
interface CostEntry {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: Date;
  metadata?: Record<string, any>;
}

interface CostSummary {
  totalCost: number;
  byOperation: Record<string, number>;
  byModel: Record<string, number>;
  totalTokens: number;
  period: { start: Date; end: Date };
}

// Dashboard widget types
type WidgetType = 'counter' | 'gauge' | 'chart' | 'table' | 'alert-list';

interface DashboardWidget {
  id: string;
  type: WidgetType;
  title: string;
  metric?: string;
  query?: string;
  refreshInterval?: number;
}

interface Dashboard {
  name: string;
  widgets: DashboardWidget[];
  refreshInterval: number;
}

// Default histogram buckets for latency measurements
const LATENCY_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// Model costs (per 1M tokens)
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'haiku': { input: 0.25, output: 1.25 },
  'sonnet': { input: 3.0, output: 15.0 },
  'opus': { input: 15.0, output: 75.0 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'claude-3-sonnet': { input: 3.0, output: 15.0 },
  'claude-3-opus': { input: 15.0, output: 75.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 }
};

export class AdvancedMetrics {
  private metrics: Map<string, MetricDefinition> = new Map();
  private counters: Map<string, MetricValue[]> = new Map();
  private gauges: Map<string, MetricValue> = new Map();
  private histograms: Map<string, HistogramValue[]> = new Map();

  private logs: LogEntry[] = [];
  private maxLogSize: number = 10000;
  private logLevel: LogLevel = 'info';

  private traces: Map<string, TraceContext> = new Map();
  private activeSpans: Map<string, TraceContext> = new Map();

  private alertRules: AlertRule[] = [];
  private alerts: Alert[] = [];
  private alertCooldowns: Map<string, number> = new Map();

  private costs: CostEntry[] = [];
  private budgetLimit?: number;

  private dashboards: Map<string, Dashboard> = new Map();
  private outputDir?: string;

  constructor(config: {
    logLevel?: LogLevel;
    maxLogSize?: number;
    outputDir?: string;
    budgetLimit?: number;
  } = {}) {
    this.logLevel = config.logLevel || 'info';
    this.maxLogSize = config.maxLogSize || 10000;
    this.outputDir = config.outputDir;
    this.budgetLimit = config.budgetLimit;

    // Register default metrics
    this.registerDefaultMetrics();
  }

  // ==================== METRICS ====================

  /**
   * Register a new metric
   */
  registerMetric(definition: MetricDefinition): void {
    this.metrics.set(definition.name, definition);

    // Initialize storage based on type
    switch (definition.type) {
      case 'counter':
        this.counters.set(definition.name, []);
        break;
      case 'gauge':
        // Gauge starts undefined
        break;
      case 'histogram':
        this.histograms.set(definition.name, []);
        break;
    }
  }

  /**
   * Increment a counter
   */
  increment(name: string, value: number = 1, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') {
      throw new Error(`Counter metric not found: ${name}`);
    }

    const values = this.counters.get(name) || [];
    values.push({
      value,
      labels,
      timestamp: Date.now()
    });
    this.counters.set(name, values);
  }

  /**
   * Set a gauge value
   */
  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') {
      throw new Error(`Gauge metric not found: ${name}`);
    }

    this.gauges.set(this.getMetricKey(name, labels), {
      value,
      labels,
      timestamp: Date.now()
    });
  }

  /**
   * Record a histogram observation
   */
  observe(name: string, value: number, labels: Record<string, string> = {}): void {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'histogram') {
      throw new Error(`Histogram metric not found: ${name}`);
    }

    const values = this.histograms.get(name) || [];

    // Find or create histogram for these labels
    let histogram = values.find(h =>
      JSON.stringify(h.labels) === JSON.stringify(labels)
    );

    if (!histogram) {
      histogram = {
        buckets: LATENCY_BUCKETS.map(le => ({ le, count: 0 })),
        sum: 0,
        count: 0,
        labels
      };
      values.push(histogram);
      this.histograms.set(name, values);
    }

    // Update histogram
    histogram.sum += value;
    histogram.count++;
    for (const bucket of histogram.buckets) {
      if (value <= bucket.le) {
        bucket.count++;
      }
    }
  }

  /**
   * Time a function execution
   */
  async time<T>(
    metricName: string,
    fn: () => Promise<T>,
    labels: Record<string, string> = {}
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      this.observe(metricName, duration, { ...labels, status: 'success' });
      return result;
    } catch (error) {
      const duration = Date.now() - start;
      this.observe(metricName, duration, { ...labels, status: 'error' });
      throw error;
    }
  }

  /**
   * Get current metric value
   */
  getMetricValue(name: string, labels: Record<string, string> = {}): number | undefined {
    const metric = this.metrics.get(name);
    if (!metric) return undefined;

    switch (metric.type) {
      case 'counter':
        const counterValues = this.counters.get(name) || [];
        return counterValues
          .filter(v => this.labelsMatch(v.labels, labels))
          .reduce((sum, v) => sum + v.value, 0);

      case 'gauge':
        const gaugeValue = this.gauges.get(this.getMetricKey(name, labels));
        return gaugeValue?.value;

      case 'histogram':
        const histogramValues = this.histograms.get(name) || [];
        const histogram = histogramValues.find(h =>
          JSON.stringify(h.labels) === JSON.stringify(labels)
        );
        return histogram?.sum;

      default:
        return undefined;
    }
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus(): string {
    const lines: string[] = [];

    for (const [name, definition] of this.metrics) {
      lines.push(`# HELP ${name} ${definition.description}`);
      lines.push(`# TYPE ${name} ${definition.type}`);

      switch (definition.type) {
        case 'counter':
          const counterValues = this.counters.get(name) || [];
          const counterSums = new Map<string, number>();

          for (const v of counterValues) {
            const key = this.getMetricKey(name, v.labels);
            counterSums.set(key, (counterSums.get(key) || 0) + v.value);
          }

          for (const [key, sum] of counterSums) {
            const labelsStr = this.formatLabels(this.parseMetricKey(key).labels);
            lines.push(`${name}${labelsStr} ${sum}`);
          }
          break;

        case 'gauge':
          for (const [key, value] of this.gauges) {
            if (key.startsWith(name)) {
              const labelsStr = this.formatLabels(value.labels);
              lines.push(`${name}${labelsStr} ${value.value}`);
            }
          }
          break;

        case 'histogram':
          const histogramValues = this.histograms.get(name) || [];
          for (const h of histogramValues) {
            const labelsStr = this.formatLabels(h.labels);
            for (const bucket of h.buckets) {
              lines.push(`${name}_bucket${this.formatLabels({ ...h.labels, le: String(bucket.le) })} ${bucket.count}`);
            }
            lines.push(`${name}_bucket${this.formatLabels({ ...h.labels, le: '+Inf' })} ${h.count}`);
            lines.push(`${name}_sum${labelsStr} ${h.sum}`);
            lines.push(`${name}_count${labelsStr} ${h.count}`);
          }
          break;
      }
    }

    return lines.join('\n');
  }

  // ==================== LOGGING ====================

  /**
   * Log a message
   */
  log(level: LogLevel, message: string, context: Record<string, any> = {}): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
      traceId: this.getCurrentTraceId(),
      spanId: this.getCurrentSpanId()
    };

    this.logs.push(entry);

    // Trim logs if needed
    if (this.logs.length > this.maxLogSize) {
      this.logs = this.logs.slice(-this.maxLogSize);
    }

    // Output based on level
    this.outputLog(entry);
  }

  trace(message: string, context?: Record<string, any>): void {
    this.log('trace', message, context);
  }

  debug(message: string, context?: Record<string, any>): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: Record<string, any>): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log('warn', message, context);
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    this.log('error', message, { ...context, error: error?.message, stack: error?.stack });
  }

  fatal(message: string, error?: Error, context?: Record<string, any>): void {
    this.log('fatal', message, { ...context, error: error?.message, stack: error?.stack });
  }

  /**
   * Get recent logs
   */
  getLogs(options: {
    level?: LogLevel;
    limit?: number;
    since?: Date;
    traceId?: string;
  } = {}): LogEntry[] {
    let filtered = this.logs;

    if (options.level) {
      const levelOrder = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
      const minLevel = levelOrder.indexOf(options.level);
      filtered = filtered.filter(log => levelOrder.indexOf(log.level) >= minLevel);
    }

    if (options.since) {
      filtered = filtered.filter(log => log.timestamp >= options.since!);
    }

    if (options.traceId) {
      filtered = filtered.filter(log => log.traceId === options.traceId);
    }

    if (options.limit) {
      filtered = filtered.slice(-options.limit);
    }

    return filtered;
  }

  // ==================== TRACING ====================

  /**
   * Start a new trace
   */
  startTrace(name: string, attributes: Record<string, any> = {}): string {
    const traceId = this.generateId();
    const spanId = this.generateId();

    const trace: TraceContext = {
      traceId,
      spanId,
      name,
      startTime: Date.now(),
      status: 'ok',
      attributes,
      events: []
    };

    this.traces.set(traceId, trace);
    this.activeSpans.set(spanId, trace);

    return traceId;
  }

  /**
   * Start a new span within current trace
   */
  startSpan(name: string, parentSpanId?: string, attributes: Record<string, any> = {}): string {
    const spanId = this.generateId();
    const parentSpan = parentSpanId ? this.activeSpans.get(parentSpanId) : undefined;
    const traceId = parentSpan?.traceId || this.generateId();

    const span: TraceContext = {
      traceId,
      spanId,
      parentSpanId,
      name,
      startTime: Date.now(),
      status: 'ok',
      attributes,
      events: []
    };

    this.traces.set(spanId, span);
    this.activeSpans.set(spanId, span);

    return spanId;
  }

  /**
   * End a span
   */
  endSpan(spanId: string, status: 'ok' | 'error' = 'ok'): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.endTime = Date.now();
      span.status = status;
      this.activeSpans.delete(spanId);
    }
  }

  /**
   * Add event to current span
   */
  addSpanEvent(spanId: string, name: string, attributes?: Record<string, any>): void {
    const span = this.activeSpans.get(spanId);
    if (span) {
      span.events.push({
        name,
        timestamp: Date.now(),
        attributes
      });
    }
  }

  /**
   * Get trace by ID
   */
  getTrace(traceId: string): TraceContext | undefined {
    return this.traces.get(traceId);
  }

  // ==================== ALERTING ====================

  /**
   * Add an alert rule
   */
  addAlertRule(rule: AlertRule): void {
    this.alertRules.push(rule);
  }

  /**
   * Check all alert rules
   */
  checkAlerts(): Alert[] {
    const now = Date.now();
    const newAlerts: Alert[] = [];

    for (const rule of this.alertRules) {
      // Check cooldown
      const lastAlert = this.alertCooldowns.get(rule.name);
      if (lastAlert && (now - lastAlert) < rule.cooldown * 1000) {
        continue;
      }

      const value = this.getMetricValue(rule.metric);
      if (value === undefined) continue;

      let triggered = false;
      switch (rule.condition) {
        case 'gt': triggered = value > rule.threshold; break;
        case 'lt': triggered = value < rule.threshold; break;
        case 'eq': triggered = value === rule.threshold; break;
        case 'gte': triggered = value >= rule.threshold; break;
        case 'lte': triggered = value <= rule.threshold; break;
      }

      if (triggered) {
        const alert: Alert = {
          rule,
          triggeredAt: new Date(),
          value,
          resolved: false
        };
        this.alerts.push(alert);
        newAlerts.push(alert);
        this.alertCooldowns.set(rule.name, now);
      }
    }

    return newAlerts;
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return this.alerts.filter(a => !a.resolved);
  }

  // ==================== COST TRACKING ====================

  /**
   * Track AI operation cost
   */
  trackCost(entry: Omit<CostEntry, 'cost' | 'timestamp'>): CostEntry {
    const modelKey = entry.model.toLowerCase();
    const rates = MODEL_COSTS[modelKey] || MODEL_COSTS['sonnet'];

    const cost = (entry.inputTokens * rates.input + entry.outputTokens * rates.output) / 1_000_000;

    const fullEntry: CostEntry = {
      ...entry,
      cost,
      timestamp: new Date()
    };

    this.costs.push(fullEntry);

    // Increment cost counter
    this.increment('ai_operation_cost_total', cost, {
      operation: entry.operation,
      model: entry.model
    });

    this.increment('ai_tokens_total', entry.inputTokens + entry.outputTokens, {
      operation: entry.operation,
      model: entry.model,
      type: 'total'
    });

    // Check budget
    if (this.budgetLimit) {
      const totalCost = this.costs.reduce((sum, c) => sum + c.cost, 0);
      if (totalCost >= this.budgetLimit) {
        this.warn('Budget limit reached', { totalCost, limit: this.budgetLimit });
      }
    }

    return fullEntry;
  }

  /**
   * Get cost summary
   */
  getCostSummary(period?: { start: Date; end: Date }): CostSummary {
    let filtered = this.costs;

    if (period) {
      filtered = filtered.filter(c =>
        c.timestamp >= period.start && c.timestamp <= period.end
      );
    }

    const byOperation: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    let totalCost = 0;
    let totalTokens = 0;

    for (const entry of filtered) {
      totalCost += entry.cost;
      totalTokens += entry.inputTokens + entry.outputTokens;
      byOperation[entry.operation] = (byOperation[entry.operation] || 0) + entry.cost;
      byModel[entry.model] = (byModel[entry.model] || 0) + entry.cost;
    }

    return {
      totalCost,
      byOperation,
      byModel,
      totalTokens,
      period: period || {
        start: filtered[0]?.timestamp || new Date(),
        end: filtered[filtered.length - 1]?.timestamp || new Date()
      }
    };
  }

  // ==================== DASHBOARDS ====================

  /**
   * Create a dashboard
   */
  createDashboard(dashboard: Dashboard): void {
    this.dashboards.set(dashboard.name, dashboard);
  }

  /**
   * Get dashboard data
   */
  getDashboardData(name: string): Record<string, any> | undefined {
    const dashboard = this.dashboards.get(name);
    if (!dashboard) return undefined;

    const data: Record<string, any> = {
      name: dashboard.name,
      widgets: []
    };

    for (const widget of dashboard.widgets) {
      const widgetData: Record<string, any> = {
        id: widget.id,
        type: widget.type,
        title: widget.title
      };

      if (widget.metric) {
        widgetData.value = this.getMetricValue(widget.metric);
      }

      if (widget.type === 'alert-list') {
        widgetData.alerts = this.getActiveAlerts();
      }

      data.widgets.push(widgetData);
    }

    return data;
  }

  // ==================== EXPORT ====================

  /**
   * Export all metrics to JSON
   */
  exportJSON(): string {
    return JSON.stringify({
      metrics: Object.fromEntries(this.metrics),
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(this.histograms),
      costs: this.getCostSummary(),
      alerts: this.getActiveAlerts()
    }, null, 2);
  }

  /**
   * Save metrics to file
   */
  async saveToFile(): Promise<void> {
    if (!this.outputDir) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(this.outputDir, `metrics-${timestamp}.json`);

    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.writeFileSync(filename, this.exportJSON());
  }

  // ==================== HELPERS ====================

  private registerDefaultMetrics(): void {
    // Operation latency
    this.registerMetric({
      name: 'operation_duration_ms',
      type: 'histogram',
      description: 'Operation duration in milliseconds',
      labels: ['operation', 'status'],
      unit: 'ms'
    });

    // Request counter
    this.registerMetric({
      name: 'requests_total',
      type: 'counter',
      description: 'Total number of requests',
      labels: ['method', 'status']
    });

    // Active operations gauge
    this.registerMetric({
      name: 'active_operations',
      type: 'gauge',
      description: 'Number of active operations',
      labels: ['type']
    });

    // AI cost metrics
    this.registerMetric({
      name: 'ai_operation_cost_total',
      type: 'counter',
      description: 'Total AI operation cost in dollars',
      labels: ['operation', 'model'],
      unit: 'USD'
    });

    this.registerMetric({
      name: 'ai_tokens_total',
      type: 'counter',
      description: 'Total tokens processed',
      labels: ['operation', 'model', 'type']
    });

    // Error counter
    this.registerMetric({
      name: 'errors_total',
      type: 'counter',
      description: 'Total number of errors',
      labels: ['type', 'severity']
    });
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }

  private outputLog(entry: LogEntry): void {
    const prefix = `[${entry.timestamp.toISOString()}] [${entry.level.toUpperCase()}]`;
    const trace = entry.traceId ? ` [trace:${entry.traceId.slice(0, 8)}]` : '';
    const context = Object.keys(entry.context).length > 0
      ? ` ${JSON.stringify(entry.context)}`
      : '';

    const message = `${prefix}${trace} ${entry.message}${context}`;

    switch (entry.level) {
      case 'trace':
      case 'debug':
        console.debug(message);
        break;
      case 'info':
        console.info(message);
        break;
      case 'warn':
        console.warn(message);
        break;
      case 'error':
      case 'fatal':
        console.error(message);
        break;
    }
  }

  private getMetricKey(name: string, labels: Record<string, string>): string {
    const sortedLabels = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',');
    return `${name}{${sortedLabels}}`;
  }

  private parseMetricKey(key: string): { name: string; labels: Record<string, string> } {
    const match = key.match(/^([^{]+)\{([^}]*)\}$/);
    if (!match) return { name: key, labels: {} };

    const labels: Record<string, string> = {};
    if (match[2]) {
      for (const pair of match[2].split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) labels[k] = v;
      }
    }

    return { name: match[1], labels };
  }

  private formatLabels(labels: Record<string, string>): string {
    const pairs = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
    return pairs.length > 0 ? `{${pairs.join(',')}}` : '';
  }

  private labelsMatch(actual: Record<string, string>, filter: Record<string, string>): boolean {
    for (const [key, value] of Object.entries(filter)) {
      if (actual[key] !== value) return false;
    }
    return true;
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2, 15) +
           Math.random().toString(36).substring(2, 15);
  }

  private getCurrentTraceId(): string | undefined {
    const activeSpan = Array.from(this.activeSpans.values())[0];
    return activeSpan?.traceId;
  }

  private getCurrentSpanId(): string | undefined {
    const activeSpan = Array.from(this.activeSpans.values())[0];
    return activeSpan?.spanId;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## AdvancedMetrics - Metrics & Logging Service

Comprehensive observability for the platform.

### Metrics
\`\`\`typescript
const metrics = new AdvancedMetrics();

// Counter (monotonic increase)
metrics.increment('requests_total', 1, { method: 'GET' });

// Gauge (point-in-time value)
metrics.setGauge('active_operations', 5, { type: 'build' });

// Histogram (distribution)
metrics.observe('operation_duration_ms', 123, { operation: 'analyze' });

// Time a function
const result = await metrics.time('operation_duration_ms', async () => {
  return heavyOperation();
}, { operation: 'heavy' });
\`\`\`

### Logging
\`\`\`typescript
metrics.info('Operation started', { taskId: '123' });
metrics.warn('Slow operation', { duration: 5000 });
metrics.error('Operation failed', error, { taskId: '123' });
\`\`\`

### Cost Tracking
\`\`\`typescript
metrics.trackCost({
  operation: 'analyze',
  model: 'sonnet',
  inputTokens: 1000,
  outputTokens: 500
});

const summary = metrics.getCostSummary();
\`\`\`

### Distributed Tracing
\`\`\`typescript
const traceId = metrics.startTrace('process-task');
const spanId = metrics.startSpan('analyze', traceId);
metrics.addSpanEvent(spanId, 'started-analysis');
metrics.endSpan(spanId);
\`\`\`

### Alerting
\`\`\`typescript
metrics.addAlertRule({
  name: 'high-error-rate',
  metric: 'errors_total',
  condition: 'gt',
  threshold: 100,
  duration: 60,
  severity: 'critical'
});
\`\`\`

### Export
- \`exportPrometheus()\`: Prometheus format
- \`exportJSON()\`: JSON format
- \`saveToFile()\`: Persist to disk
    `;
  }
}
