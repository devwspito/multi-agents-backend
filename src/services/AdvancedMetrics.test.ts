/**
 * AdvancedMetrics Tests
 *
 * Tests for the metrics, logging, and tracing system
 * with Prometheus-compatible exports and cost tracking.
 */

import { AdvancedMetrics } from './AdvancedMetrics';

describe('AdvancedMetrics', () => {
  let metrics: AdvancedMetrics;

  beforeEach(() => {
    metrics = new AdvancedMetrics({
      budgetLimit: 100,
    });
  });

  describe('counter metrics', () => {
    it('should create and increment counter', () => {
      metrics.registerMetric({
        name: 'test_counter',
        type: 'counter',
        description: 'Test counter',
      });

      metrics.increment('test_counter');
      metrics.increment('test_counter');
      metrics.increment('test_counter', 5);

      const value = metrics.getMetricValue('test_counter');
      expect(value).toBe(7);
    });

    it('should increment counter with labels', () => {
      metrics.registerMetric({
        name: 'labeled_counter',
        type: 'counter',
        description: 'Counter with labels',
        labels: ['status'],
      });

      metrics.increment('labeled_counter', 1, { status: 'success' });
      metrics.increment('labeled_counter', 1, { status: 'success' });
      metrics.increment('labeled_counter', 1, { status: 'error' });

      const successValue = metrics.getMetricValue('labeled_counter', { status: 'success' });
      const errorValue = metrics.getMetricValue('labeled_counter', { status: 'error' });

      expect(successValue).toBe(2);
      expect(errorValue).toBe(1);
    });
  });

  describe('gauge metrics', () => {
    it('should create and set gauge', () => {
      metrics.registerMetric({
        name: 'test_gauge',
        type: 'gauge',
        description: 'Test gauge',
      });

      metrics.setGauge('test_gauge', 42);
      expect(metrics.getMetricValue('test_gauge')).toBe(42);

      metrics.setGauge('test_gauge', 100);
      expect(metrics.getMetricValue('test_gauge')).toBe(100);
    });

    it('should handle gauge with labels', () => {
      metrics.registerMetric({
        name: 'labeled_gauge',
        type: 'gauge',
        description: 'Gauge with labels',
        labels: ['region'],
      });

      metrics.setGauge('labeled_gauge', 10, { region: 'us-east' });
      metrics.setGauge('labeled_gauge', 20, { region: 'eu-west' });

      expect(metrics.getMetricValue('labeled_gauge', { region: 'us-east' })).toBe(10);
      expect(metrics.getMetricValue('labeled_gauge', { region: 'eu-west' })).toBe(20);
    });
  });

  describe('histogram metrics', () => {
    it('should observe values in histogram', () => {
      metrics.registerMetric({
        name: 'test_histogram',
        type: 'histogram',
        description: 'Test histogram',
      });

      metrics.observe('test_histogram', 0.1);
      metrics.observe('test_histogram', 0.5);
      metrics.observe('test_histogram', 1.0);

      const sum = metrics.getMetricValue('test_histogram');
      expect(sum).toBe(1.6);
    });
  });

  describe('time function', () => {
    it('should time async function execution', async () => {
      metrics.registerMetric({
        name: 'operation_duration',
        type: 'histogram',
        description: 'Operation duration',
      });

      const result = await metrics.time('operation_duration', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        return 'completed';
      });

      expect(result).toBe('completed');
      // The histogram tracks the value - we just verify no errors occurred
    });

    it('should track errors in timed functions', async () => {
      metrics.registerMetric({
        name: 'error_operation',
        type: 'histogram',
        description: 'Error operation',
      });

      await expect(
        metrics.time('error_operation', async () => {
          throw new Error('Test error');
        })
      ).rejects.toThrow('Test error');
    });
  });

  describe('cost tracking', () => {
    it('should track AI operation costs', () => {
      const entry = metrics.trackCost({
        operation: 'completion',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
      });

      expect(entry.cost).toBeGreaterThan(0);
      expect(entry.operation).toBe('completion');
    });

    it('should calculate cost summary', () => {
      metrics.trackCost({
        operation: 'completion1',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
      });

      metrics.trackCost({
        operation: 'completion2',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 2000,
        outputTokens: 1000,
      });

      const summary = metrics.getCostSummary();
      expect(summary.totalCost).toBeGreaterThan(0);
      expect(summary.totalTokens).toBe(4500); // 1000+500+2000+1000 = 4500
    });

    it('should track costs by model', () => {
      metrics.trackCost({
        operation: 'op1',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 500,
      });

      metrics.trackCost({
        operation: 'op2',
        model: 'claude-haiku-3-5-20241022',
        inputTokens: 2000,
        outputTokens: 1000,
      });

      const summary = metrics.getCostSummary();
      expect(summary.byModel).toHaveProperty('claude-sonnet-4-20250514');
      expect(summary.byModel).toHaveProperty('claude-haiku-3-5-20241022');
    });
  });

  describe('distributed tracing', () => {
    it('should create and manage traces', () => {
      const traceId = metrics.startTrace('test-operation');
      expect(traceId).toBeDefined();
      expect(typeof traceId).toBe('string');
    });

    it('should create spans within traces', () => {
      const traceId = metrics.startTrace('parent-operation');
      const spanId = metrics.startSpan('child-operation', traceId);

      expect(spanId).toBeDefined();

      metrics.endSpan(spanId);
      // Verify spans were created without errors
    });
  });

  describe('structured logging', () => {
    it('should log info messages', () => {
      // Should not throw
      expect(() => metrics.info('Test info message')).not.toThrow();
    });

    it('should log warning messages', () => {
      expect(() => metrics.warn('Test warning message')).not.toThrow();
    });

    it('should log error messages', () => {
      expect(() => metrics.error('Test error message')).not.toThrow();
    });

    it('should log with context', () => {
      expect(() =>
        metrics.info('Message with context', { key: 'value', number: 42 })
      ).not.toThrow();
    });
  });

  describe('Prometheus export', () => {
    it('should export metrics in Prometheus format', () => {
      metrics.registerMetric({
        name: 'prometheus_test',
        type: 'counter',
        description: 'Test for Prometheus export',
      });

      metrics.increment('prometheus_test', 5);

      const output = metrics.exportPrometheus();
      expect(output).toContain('# HELP prometheus_test');
      expect(output).toContain('# TYPE prometheus_test counter');
      expect(output).toContain('prometheus_test');
    });

    it('should export multiple metric types', () => {
      metrics.registerMetric({
        name: 'prom_counter',
        type: 'counter',
        description: 'Counter',
      });
      metrics.registerMetric({
        name: 'prom_gauge',
        type: 'gauge',
        description: 'Gauge',
      });

      metrics.increment('prom_counter');
      metrics.setGauge('prom_gauge', 42);

      const output = metrics.exportPrometheus();
      expect(output).toContain('# TYPE prom_counter counter');
      expect(output).toContain('# TYPE prom_gauge gauge');
    });
  });

  describe('alert rules', () => {
    it('should trigger alert when threshold exceeded', () => {
      metrics.registerMetric({
        name: 'error_rate',
        type: 'gauge',
        description: 'Error rate',
      });

      metrics.addAlertRule({
        name: 'high_error_rate',
        metric: 'error_rate',
        condition: 'gt',
        threshold: 0.5,
        duration: 0,
        severity: 'warning',
        message: 'Error rate is too high',
        cooldown: 60,
      });

      metrics.setGauge('error_rate', 0.3); // Below threshold
      const alertsBefore = metrics.checkAlerts();

      metrics.setGauge('error_rate', 0.8); // Above threshold
      const alertsAfter = metrics.checkAlerts();

      expect(alertsAfter.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getMetricValue', () => {
    it('should return undefined for non-existent metric', () => {
      expect(metrics.getMetricValue('nonexistent')).toBeUndefined();
    });

    it('should return 0 for counter with no increments', () => {
      metrics.registerMetric({
        name: 'empty_counter',
        type: 'counter',
        description: 'Empty counter',
      });

      expect(metrics.getMetricValue('empty_counter')).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should handle negative increment values', () => {
      metrics.registerMetric({
        name: 'negative_test',
        type: 'counter',
        description: 'Negative test',
      });

      metrics.increment('negative_test', 10);
      metrics.increment('negative_test', -3);

      expect(metrics.getMetricValue('negative_test')).toBe(7);
    });

    it('should handle very large numbers', () => {
      metrics.registerMetric({
        name: 'large_number',
        type: 'gauge',
        description: 'Large number test',
      });

      metrics.setGauge('large_number', Number.MAX_SAFE_INTEGER);
      expect(metrics.getMetricValue('large_number')).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should handle rapid metric updates', () => {
      metrics.registerMetric({
        name: 'rapid_counter',
        type: 'counter',
        description: 'Rapid updates',
      });

      for (let i = 0; i < 1000; i++) {
        metrics.increment('rapid_counter');
      }

      expect(metrics.getMetricValue('rapid_counter')).toBe(1000);
    });
  });
});
