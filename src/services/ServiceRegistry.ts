/**
 * ServiceRegistry - Dynamic service loading and management
 *
 * Central registry for all services with:
 * - Lazy loading on first use
 * - Dependency injection
 * - Service lifecycle management
 * - Configuration management
 * - Health checks
 */

import * as fs from 'fs';
import * as path from 'path';

// Service lifecycle states
type ServiceState = 'unloaded' | 'loading' | 'ready' | 'error' | 'stopped';

// Service metadata
interface ServiceMetadata {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  category: ServiceCategory;
  singleton: boolean;
  lazy: boolean;
  configSchema?: Record<string, any>;
}

type ServiceCategory =
  | 'caching'
  | 'analysis'
  | 'generation'
  | 'optimization'
  | 'orchestration'
  | 'ai'
  | 'utility';

// Service registration entry
interface ServiceEntry<T = any> {
  metadata: ServiceMetadata;
  factory: () => T | Promise<T>;
  instance?: T;
  state: ServiceState;
  config: Record<string, any>;
  lastError?: Error;
  loadTime?: number;
  usageCount: number;
  lastUsed?: Date;
}

// Service health status
interface ServiceHealth {
  name: string;
  state: ServiceState;
  uptime?: number;
  usageCount: number;
  lastUsed?: Date;
  memoryUsage?: number;
  errors: number;
}

// Registry statistics
interface RegistryStats {
  totalServices: number;
  loadedServices: number;
  errorServices: number;
  totalUsage: number;
  byCategory: Record<ServiceCategory, number>;
  memoryUsage: number;
}

// Events emitted by the registry
type RegistryEvent =
  | { type: 'service:registered'; name: string }
  | { type: 'service:loaded'; name: string; loadTime: number }
  | { type: 'service:error'; name: string; error: Error }
  | { type: 'service:stopped'; name: string }
  | { type: 'registry:cleared' };

type EventHandler = (event: RegistryEvent) => void;

export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private services: Map<string, ServiceEntry> = new Map();
  private aliases: Map<string, string> = new Map();
  private eventHandlers: Set<EventHandler> = new Set();
  private configs: Map<string, Record<string, any>> = new Map();
  private errorCounts: Map<string, number> = new Map();

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * Register a service
   */
  register<T>(
    name: string,
    factory: () => T | Promise<T>,
    metadata: Partial<ServiceMetadata> = {}
  ): void {
    const fullMetadata: ServiceMetadata = {
      name,
      version: '1.0.0',
      description: '',
      dependencies: [],
      category: 'utility',
      singleton: true,
      lazy: true,
      ...metadata
    };

    const entry: ServiceEntry<T> = {
      metadata: fullMetadata,
      factory,
      state: 'unloaded',
      config: this.configs.get(name) || {},
      usageCount: 0
    };

    this.services.set(name, entry);
    this.emit({ type: 'service:registered', name });

    // Eager load if not lazy
    if (!fullMetadata.lazy) {
      this.get(name).catch(err => {
        console.error(`Failed to eager load service ${name}:`, err);
      });
    }
  }

  /**
   * Register an alias for a service
   */
  registerAlias(alias: string, serviceName: string): void {
    if (!this.services.has(serviceName)) {
      throw new Error(`Cannot alias unknown service: ${serviceName}`);
    }
    this.aliases.set(alias, serviceName);
  }

  /**
   * Get a service instance (lazy loads if needed)
   */
  async get<T>(name: string): Promise<T> {
    // Resolve alias
    const serviceName = this.aliases.get(name) || name;
    const entry = this.services.get(serviceName);

    if (!entry) {
      throw new Error(`Service not found: ${name}`);
    }

    // Return existing instance if singleton and loaded
    if (entry.metadata.singleton && entry.instance && entry.state === 'ready') {
      entry.usageCount++;
      entry.lastUsed = new Date();
      return entry.instance as T;
    }

    // Load dependencies first
    for (const dep of entry.metadata.dependencies) {
      await this.get(dep);
    }

    // Load the service
    if (entry.state === 'unloaded' || entry.state === 'error') {
      entry.state = 'loading';
      const startTime = Date.now();

      try {
        const instance = await entry.factory();
        entry.instance = instance;
        entry.state = 'ready';
        entry.loadTime = Date.now() - startTime;
        this.emit({ type: 'service:loaded', name: serviceName, loadTime: entry.loadTime });
      } catch (error: any) {
        entry.state = 'error';
        entry.lastError = error;
        this.errorCounts.set(serviceName, (this.errorCounts.get(serviceName) || 0) + 1);
        this.emit({ type: 'service:error', name: serviceName, error });
        throw error;
      }
    }

    // Wait for loading to complete
    while (entry.state === 'loading') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Check for error state after loading completes
    const currentState = entry.state as ServiceState;
    if (currentState === 'error') {
      throw entry.lastError || new Error(`Service ${serviceName} failed to load`);
    }

    entry.usageCount++;
    entry.lastUsed = new Date();
    return entry.instance as T;
  }

  /**
   * Get service synchronously (throws if not loaded)
   */
  getSync<T>(name: string): T {
    const serviceName = this.aliases.get(name) || name;
    const entry = this.services.get(serviceName);

    if (!entry) {
      throw new Error(`Service not found: ${name}`);
    }

    if (entry.state !== 'ready' || !entry.instance) {
      throw new Error(`Service ${name} is not loaded. Use async get() first.`);
    }

    entry.usageCount++;
    entry.lastUsed = new Date();
    return entry.instance as T;
  }

  /**
   * Check if service is registered
   */
  has(name: string): boolean {
    const serviceName = this.aliases.get(name) || name;
    return this.services.has(serviceName);
  }

  /**
   * Check if service is loaded and ready
   */
  isReady(name: string): boolean {
    const serviceName = this.aliases.get(name) || name;
    const entry = this.services.get(serviceName);
    return entry?.state === 'ready';
  }

  /**
   * Stop and unload a service
   */
  async stop(name: string): Promise<void> {
    const serviceName = this.aliases.get(name) || name;
    const entry = this.services.get(serviceName);

    if (!entry) {
      throw new Error(`Service not found: ${name}`);
    }

    // Call stop method if service has one
    if (entry.instance && typeof (entry.instance as any).stop === 'function') {
      await (entry.instance as any).stop();
    }

    entry.instance = undefined;
    entry.state = 'stopped';
    this.emit({ type: 'service:stopped', name: serviceName });
  }

  /**
   * Reload a service
   */
  async reload(name: string): Promise<void> {
    await this.stop(name);
    await this.get(name);
  }

  /**
   * Set service configuration
   */
  configure(name: string, config: Record<string, any>): void {
    this.configs.set(name, config);
    const entry = this.services.get(name);
    if (entry) {
      entry.config = { ...entry.config, ...config };
    }
  }

  /**
   * Get service health status
   */
  getHealth(name: string): ServiceHealth {
    const serviceName = this.aliases.get(name) || name;
    const entry = this.services.get(serviceName);

    if (!entry) {
      throw new Error(`Service not found: ${name}`);
    }

    return {
      name: serviceName,
      state: entry.state,
      uptime: entry.loadTime ? Date.now() - (entry.lastUsed?.getTime() || 0) : undefined,
      usageCount: entry.usageCount,
      lastUsed: entry.lastUsed,
      errors: this.errorCounts.get(serviceName) || 0
    };
  }

  /**
   * Get all services health
   */
  getAllHealth(): ServiceHealth[] {
    return Array.from(this.services.keys()).map(name => this.getHealth(name));
  }

  /**
   * Get registry statistics
   */
  getStats(): RegistryStats {
    const byCategory: Record<ServiceCategory, number> = {
      caching: 0,
      analysis: 0,
      generation: 0,
      optimization: 0,
      orchestration: 0,
      ai: 0,
      utility: 0
    };

    let loadedCount = 0;
    let errorCount = 0;
    let totalUsage = 0;

    for (const entry of this.services.values()) {
      byCategory[entry.metadata.category]++;
      if (entry.state === 'ready') loadedCount++;
      if (entry.state === 'error') errorCount++;
      totalUsage += entry.usageCount;
    }

    return {
      totalServices: this.services.size,
      loadedServices: loadedCount,
      errorServices: errorCount,
      totalUsage,
      byCategory,
      memoryUsage: process.memoryUsage().heapUsed
    };
  }

  /**
   * List all registered services
   */
  list(): ServiceMetadata[] {
    return Array.from(this.services.values()).map(entry => entry.metadata);
  }

  /**
   * List services by category
   */
  listByCategory(category: ServiceCategory): ServiceMetadata[] {
    return Array.from(this.services.values())
      .filter(entry => entry.metadata.category === category)
      .map(entry => entry.metadata);
  }

  /**
   * Preload multiple services in parallel
   */
  async preload(names: string[]): Promise<void> {
    await Promise.all(names.map(name => this.get(name)));
  }

  /**
   * Clear all services
   */
  async clear(): Promise<void> {
    // Stop all services
    for (const name of this.services.keys()) {
      try {
        await this.stop(name);
      } catch {
        // Ignore stop errors during clear
      }
    }

    this.services.clear();
    this.aliases.clear();
    this.errorCounts.clear();
    this.emit({ type: 'registry:cleared' });
  }

  /**
   * Subscribe to registry events
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Emit an event
   */
  private emit(event: RegistryEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Event handler error:', error);
      }
    }
  }

  /**
   * Auto-discover and register services from directory
   */
  async autoDiscover(servicesDir: string): Promise<string[]> {
    const registered: string[] = [];

    if (!fs.existsSync(servicesDir)) {
      return registered;
    }

    const files = fs.readdirSync(servicesDir);

    for (const file of files) {
      if (!file.endsWith('.ts') && !file.endsWith('.js')) continue;
      if (file.includes('.test.') || file.includes('.spec.')) continue;
      if (file === 'ServiceRegistry.ts' || file === 'index.ts') continue;

      const serviceName = path.basename(file, path.extname(file));

      // Check if already registered
      if (this.services.has(serviceName)) continue;

      try {
        const modulePath = path.join(servicesDir, file);
        const module = await import(modulePath);

        // Look for default export or named export matching filename
        const ServiceClass = module.default || module[serviceName];

        if (ServiceClass && typeof ServiceClass === 'function') {
          this.register(
            serviceName,
            () => new ServiceClass(),
            {
              name: serviceName,
              category: this.inferCategory(serviceName),
              lazy: true,
              singleton: true
            }
          );
          registered.push(serviceName);
        }
      } catch (error) {
        console.warn(`Failed to auto-discover service ${serviceName}:`, error);
      }
    }

    return registered;
  }

  /**
   * Infer service category from name
   */
  private inferCategory(name: string): ServiceCategory {
    const lowerName = name.toLowerCase();

    if (lowerName.includes('cache')) return 'caching';
    if (lowerName.includes('analyzer') || lowerName.includes('profiler') || lowerName.includes('detector')) return 'analysis';
    if (lowerName.includes('generator') || lowerName.includes('explainer') || lowerName.includes('doc')) return 'generation';
    if (lowerName.includes('optimizer') || lowerName.includes('eliminator') || lowerName.includes('updater')) return 'optimization';
    if (lowerName.includes('orchestrat') || lowerName.includes('coordinator')) return 'orchestration';
    if (lowerName.includes('predict') || lowerName.includes('intent') || lowerName.includes('learning')) return 'ai';

    return 'utility';
  }

  /**
   * Create a scoped container with custom configuration
   */
  createScope(scopeConfig: Record<string, Record<string, any>>): ScopedServiceContainer {
    return new ScopedServiceContainer(this, scopeConfig);
  }

  /**
   * Generate service dependency graph
   */
  getDependencyGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const [name, entry] of this.services) {
      graph.set(name, entry.metadata.dependencies);
    }

    return graph;
  }

  /**
   * Check for circular dependencies
   */
  checkCircularDependencies(): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const dfs = (name: string, path: string[]): void => {
      if (recursionStack.has(name)) {
        const cycleStart = path.indexOf(name);
        cycles.push(path.slice(cycleStart));
        return;
      }

      if (visited.has(name)) return;

      visited.add(name);
      recursionStack.add(name);

      const entry = this.services.get(name);
      if (entry) {
        for (const dep of entry.metadata.dependencies) {
          dfs(dep, [...path, name]);
        }
      }

      recursionStack.delete(name);
    };

    for (const name of this.services.keys()) {
      dfs(name, []);
    }

    return cycles;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## ServiceRegistry - Dynamic Service Management

Central registry for loading and managing services.

### Registration
\`\`\`typescript
const registry = ServiceRegistry.getInstance();

registry.register('MyService', () => new MyService(), {
  category: 'utility',
  singleton: true,
  lazy: true,
  dependencies: ['OtherService']
});
\`\`\`

### Usage
\`\`\`typescript
// Async (recommended)
const service = await registry.get<MyService>('MyService');

// Sync (only if already loaded)
const service = registry.getSync<MyService>('MyService');
\`\`\`

### Categories
- caching, analysis, generation
- optimization, orchestration
- ai, utility

### Features
- Lazy loading on first use
- Singleton or factory pattern
- Dependency injection
- Health monitoring
- Auto-discovery from directory
- Circular dependency detection

### Best Practices
- Use lazy loading for heavy services
- Register dependencies before dependents
- Use preload() for critical services
- Monitor health with getStats()
    `;
  }
}

/**
 * Scoped container with custom configuration
 */
class ScopedServiceContainer {
  constructor(
    private parent: ServiceRegistry,
    private scopeConfig: Record<string, Record<string, any>>
  ) {}

  async get<T>(name: string): Promise<T> {
    // Apply scope-specific config before getting
    const config = this.scopeConfig[name];
    if (config) {
      this.parent.configure(name, config);
    }
    return this.parent.get<T>(name);
  }
}

/**
 * Decorator for auto-registration
 */
export function Service(metadata: Partial<ServiceMetadata> = {}) {
  return function<T extends { new(...args: any[]): {} }>(constructor: T) {
    const registry = ServiceRegistry.getInstance();
    registry.register(
      metadata.name || constructor.name,
      () => new constructor(),
      metadata
    );
    return constructor;
  };
}

/**
 * Initialize registry with all built-in services
 */
export async function initializeServices(): Promise<ServiceRegistry> {
  const registry = ServiceRegistry.getInstance();

  // Register core services
  registry.register('SmartCacheLayer', async () => {
    const { SmartCacheLayer } = await import('./SmartCacheLayer');
    return SmartCacheLayer.getInstance();
  }, { category: 'caching', singleton: true });

  registry.register('ParallelToolExecutor', async () => {
    const { ParallelToolExecutor } = await import('./ParallelToolExecutor');
    return new ParallelToolExecutor();
  }, { category: 'optimization', singleton: true });

  registry.register('LazyFileLoader', async () => {
    const { LazyFileLoader } = await import('./LazyFileLoader');
    return new LazyFileLoader();
  }, { category: 'utility', singleton: true });

  registry.register('CodeExplainer', async () => {
    const { CodeExplainer } = await import('./CodeExplainer');
    return new CodeExplainer();
  }, { category: 'generation', singleton: true });

  registry.register('DocGenerator', async () => {
    const { DocGenerator } = await import('./DocGenerator');
    return new DocGenerator();
  }, { category: 'generation', singleton: true });

  registry.register('TestCoverageAnalyzer', async () => {
    const { TestCoverageAnalyzer } = await import('./TestCoverageAnalyzer');
    return new TestCoverageAnalyzer();
  }, { category: 'analysis', singleton: true });

  registry.register('MigrationAssistant', async () => {
    const { MigrationAssistant } = await import('./MigrationAssistant');
    return new MigrationAssistant();
  }, { category: 'utility', singleton: true });

  registry.register('PerformanceProfiler', async () => {
    const { PerformanceProfiler } = await import('./PerformanceProfiler');
    return new PerformanceProfiler();
  }, { category: 'analysis', singleton: true });

  registry.register('DeadCodeEliminator', async () => {
    const { DeadCodeEliminator } = await import('./DeadCodeEliminator');
    return new DeadCodeEliminator();
  }, { category: 'optimization', singleton: true });

  registry.register('BundleSizeAnalyzer', async () => {
    const { BundleSizeAnalyzer } = await import('./BundleSizeAnalyzer');
    return new BundleSizeAnalyzer();
  }, { category: 'analysis', singleton: true });

  registry.register('DependencyUpdater', async () => {
    const { DependencyUpdater } = await import('./DependencyUpdater');
    return new DependencyUpdater();
  }, { category: 'optimization', singleton: true });

  registry.register('IntentPredictor', async () => {
    const { IntentPredictor } = await import('./IntentPredictor');
    return new IntentPredictor();
  }, { category: 'ai', singleton: true });

  // Register aliases
  registry.registerAlias('cache', 'SmartCacheLayer');
  registry.registerAlias('parallel', 'ParallelToolExecutor');
  registry.registerAlias('files', 'LazyFileLoader');
  registry.registerAlias('explain', 'CodeExplainer');
  registry.registerAlias('docs', 'DocGenerator');
  registry.registerAlias('coverage', 'TestCoverageAnalyzer');
  registry.registerAlias('migrate', 'MigrationAssistant');
  registry.registerAlias('profile', 'PerformanceProfiler');
  registry.registerAlias('deadcode', 'DeadCodeEliminator');
  registry.registerAlias('bundle', 'BundleSizeAnalyzer');
  registry.registerAlias('deps', 'DependencyUpdater');
  registry.registerAlias('intent', 'IntentPredictor');

  return registry;
}
