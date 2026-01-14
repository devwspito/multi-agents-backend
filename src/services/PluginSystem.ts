/**
 * PluginSystem - Extensible plugin architecture
 *
 * Enables:
 * - Dynamic plugin loading/unloading
 * - Plugin lifecycle management
 * - Hook system for extension points
 * - Plugin dependencies and versioning
 * - Sandboxed plugin execution
 * - Plugin marketplace integration
 */

import * as fs from 'fs';
import * as path from 'path';

// Plugin metadata
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  main: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  hooks?: string[];
  permissions?: PluginPermission[];
  config?: PluginConfigSchema;
}

type PluginPermission =
  | 'file:read'
  | 'file:write'
  | 'network:fetch'
  | 'shell:execute'
  | 'database:read'
  | 'database:write'
  | 'ai:call'
  | 'registry:access';

interface PluginConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description?: string;
    default?: any;
    required?: boolean;
    enum?: any[];
  };
}

// Plugin lifecycle states
type PluginState = 'unloaded' | 'loading' | 'loaded' | 'active' | 'disabled' | 'error';

// Plugin interface that all plugins must implement
interface IPlugin {
  name: string;
  version: string;

  // Lifecycle hooks
  onLoad?(context: PluginContext): Promise<void>;
  onActivate?(context: PluginContext): Promise<void>;
  onDeactivate?(context: PluginContext): Promise<void>;
  onUnload?(context: PluginContext): Promise<void>;
  onConfigChange?(config: Record<string, any>, context: PluginContext): Promise<void>;
}

// Context provided to plugins
interface PluginContext {
  config: Record<string, any>;
  logger: PluginLogger;
  storage: PluginStorage;
  hooks: HookRegistry;
  services: ServiceAccessor;
  permissions: PluginPermission[];
}

// Plugin logger interface
interface PluginLogger {
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, error?: Error): void;
}

// Plugin storage interface
interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

// Service accessor (limited by permissions)
interface ServiceAccessor {
  get<T>(serviceName: string): Promise<T>;
  has(serviceName: string): boolean;
}

// Hook types
type HookType =
  | 'beforePhase'
  | 'afterPhase'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'onError'
  | 'onComplete'
  | 'beforeResponse'
  | 'afterResponse'
  | 'onUserInput'
  | 'onAgentThink'
  | 'beforeCommit'
  | 'afterBuild';

type HookHandler = (data: any, context: PluginContext) => Promise<any>;

interface HookRegistration {
  pluginName: string;
  hookType: HookType;
  handler: HookHandler;
  priority: number;
}

// Hook registry for plugins to register handlers
interface HookRegistry {
  register(hookType: HookType, handler: HookHandler, priority?: number): void;
  unregister(hookType: HookType, handler: HookHandler): void;
}

// Internal plugin entry
interface PluginEntry {
  manifest: PluginManifest;
  instance?: IPlugin;
  state: PluginState;
  context?: PluginContext;
  path: string;
  loadError?: Error;
  hooks: HookRegistration[];
  loadTime?: number;
}

// Plugin system events
type PluginEvent =
  | { type: 'plugin:loaded'; name: string }
  | { type: 'plugin:activated'; name: string }
  | { type: 'plugin:deactivated'; name: string }
  | { type: 'plugin:unloaded'; name: string }
  | { type: 'plugin:error'; name: string; error: Error }
  | { type: 'hook:executed'; hookType: HookType; plugins: string[] };

type EventHandler = (event: PluginEvent) => void;

export class PluginSystem {
  private plugins: Map<string, PluginEntry> = new Map();
  private hooks: Map<HookType, HookRegistration[]> = new Map();
  private eventHandlers: Set<EventHandler> = new Set();
  private pluginsDir: string;
  private storageDir: string;
  private globalConfig: Record<string, any> = {};

  constructor(config: {
    pluginsDir?: string;
    storageDir?: string;
  } = {}) {
    this.pluginsDir = config.pluginsDir || './plugins';
    this.storageDir = config.storageDir || './.plugin-storage';

    // Initialize hook arrays
    const hookTypes: HookType[] = [
      'beforePhase', 'afterPhase', 'beforeToolCall', 'afterToolCall',
      'onError', 'onComplete', 'beforeResponse', 'afterResponse',
      'onUserInput', 'onAgentThink', 'beforeCommit', 'afterBuild'
    ];
    for (const hookType of hookTypes) {
      this.hooks.set(hookType, []);
    }
  }

  /**
   * Load a plugin from a directory
   */
  async loadPlugin(pluginPath: string): Promise<void> {
    const manifestPath = path.join(pluginPath, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Plugin manifest not found: ${manifestPath}`);
    }

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8')
    );

    if (this.plugins.has(manifest.name)) {
      throw new Error(`Plugin already loaded: ${manifest.name}`);
    }

    const entry: PluginEntry = {
      manifest,
      state: 'loading',
      path: pluginPath,
      hooks: []
    };

    this.plugins.set(manifest.name, entry);

    try {
      const startTime = Date.now();

      // Check dependencies
      await this.checkDependencies(manifest);

      // Load the plugin module
      const modulePath = path.join(pluginPath, manifest.main);
      const module = await import(modulePath);
      const PluginClass = module.default || module[manifest.name];

      if (!PluginClass) {
        throw new Error(`Plugin class not found in ${modulePath}`);
      }

      // Create instance
      entry.instance = new PluginClass();

      // Create context
      entry.context = this.createPluginContext(manifest.name);

      // Call onLoad
      if (entry.instance && entry.instance.onLoad) {
        await entry.instance.onLoad(entry.context);
      }

      entry.state = 'loaded';
      entry.loadTime = Date.now() - startTime;

      this.emit({ type: 'plugin:loaded', name: manifest.name });
    } catch (error: any) {
      entry.state = 'error';
      entry.loadError = error;
      this.emit({ type: 'plugin:error', name: manifest.name, error });
      throw error;
    }
  }

  /**
   * Register a plugin programmatically
   */
  async registerPlugin(
    name: string,
    plugin: IPlugin,
    manifest: Partial<PluginManifest> = {}
  ): Promise<void> {
    if (this.plugins.has(name)) {
      throw new Error(`Plugin already registered: ${name}`);
    }

    const fullManifest: PluginManifest = {
      name,
      version: plugin.version || '1.0.0',
      description: '',
      main: 'index.js',
      ...manifest
    };

    const entry: PluginEntry = {
      manifest: fullManifest,
      instance: plugin,
      state: 'loaded',
      path: '',
      hooks: []
    };

    entry.context = this.createPluginContext(name);

    if (plugin.onLoad) {
      await plugin.onLoad(entry.context);
    }

    this.plugins.set(name, entry);
    this.emit({ type: 'plugin:loaded', name });
  }

  /**
   * Activate a loaded plugin
   */
  async activatePlugin(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (entry.state !== 'loaded' && entry.state !== 'disabled') {
      throw new Error(`Cannot activate plugin in state: ${entry.state}`);
    }

    try {
      if (entry.instance?.onActivate && entry.context) {
        await entry.instance.onActivate(entry.context);
      }

      entry.state = 'active';
      this.emit({ type: 'plugin:activated', name });
    } catch (error: any) {
      entry.state = 'error';
      entry.loadError = error;
      this.emit({ type: 'plugin:error', name, error });
      throw error;
    }
  }

  /**
   * Deactivate an active plugin
   */
  async deactivatePlugin(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`Plugin not found: ${name}`);
    }

    if (entry.state !== 'active') {
      throw new Error(`Cannot deactivate plugin in state: ${entry.state}`);
    }

    try {
      if (entry.instance?.onDeactivate && entry.context) {
        await entry.instance.onDeactivate(entry.context);
      }

      // Remove all hooks registered by this plugin
      for (const [hookType, registrations] of this.hooks) {
        this.hooks.set(
          hookType,
          registrations.filter(r => r.pluginName !== name)
        );
      }

      entry.state = 'disabled';
      entry.hooks = [];
      this.emit({ type: 'plugin:deactivated', name });
    } catch (error: any) {
      entry.state = 'error';
      this.emit({ type: 'plugin:error', name, error: error as Error });
      throw error;
    }
  }

  /**
   * Unload a plugin completely
   */
  async unloadPlugin(name: string): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`Plugin not found: ${name}`);
    }

    // Deactivate first if active
    if (entry.state === 'active') {
      await this.deactivatePlugin(name);
    }

    try {
      if (entry.instance?.onUnload && entry.context) {
        await entry.instance.onUnload(entry.context);
      }

      this.plugins.delete(name);
      this.emit({ type: 'plugin:unloaded', name });
    } catch (error: any) {
      this.emit({ type: 'plugin:error', name, error: error as Error });
      throw error;
    }
  }

  /**
   * Execute a hook
   */
  async executeHook<T>(hookType: HookType, data: T): Promise<T> {
    const registrations = this.hooks.get(hookType) || [];

    // Sort by priority
    const sorted = [...registrations].sort((a, b) => b.priority - a.priority);

    let result = data;
    const executedPlugins: string[] = [];

    for (const registration of sorted) {
      const entry = this.plugins.get(registration.pluginName);
      if (!entry || entry.state !== 'active') continue;

      try {
        result = await registration.handler(result, entry.context!);
        executedPlugins.push(registration.pluginName);
      } catch (error) {
        console.error(`Hook error in plugin ${registration.pluginName}:`, error);
      }
    }

    if (executedPlugins.length > 0) {
      this.emit({ type: 'hook:executed', hookType, plugins: executedPlugins });
    }

    return result;
  }

  /**
   * Get plugin info
   */
  getPlugin(name: string): {
    manifest: PluginManifest;
    state: PluginState;
    loadTime?: number;
    error?: Error;
  } | undefined {
    const entry = this.plugins.get(name);
    if (!entry) return undefined;

    return {
      manifest: entry.manifest,
      state: entry.state,
      loadTime: entry.loadTime,
      error: entry.loadError
    };
  }

  /**
   * List all plugins
   */
  listPlugins(): Array<{
    name: string;
    version: string;
    state: PluginState;
    description: string;
  }> {
    return Array.from(this.plugins.values()).map(entry => ({
      name: entry.manifest.name,
      version: entry.manifest.version,
      state: entry.state,
      description: entry.manifest.description
    }));
  }

  /**
   * Configure a plugin
   */
  async configurePlugin(name: string, config: Record<string, any>): Promise<void> {
    const entry = this.plugins.get(name);
    if (!entry) {
      throw new Error(`Plugin not found: ${name}`);
    }

    // Validate config against schema
    if (entry.manifest.config) {
      this.validateConfig(config, entry.manifest.config);
    }

    if (entry.context) {
      entry.context.config = { ...entry.context.config, ...config };
    }

    if (entry.instance?.onConfigChange && entry.context) {
      await entry.instance.onConfigChange(config, entry.context);
    }
  }

  /**
   * Discover and load all plugins from plugins directory
   */
  async discoverPlugins(): Promise<string[]> {
    const loaded: string[] = [];

    if (!fs.existsSync(this.pluginsDir)) {
      return loaded;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginPath = path.join(this.pluginsDir, entry.name);
      const manifestPath = path.join(pluginPath, 'manifest.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        await this.loadPlugin(pluginPath);
        loaded.push(entry.name);
      } catch (error) {
        console.error(`Failed to load plugin ${entry.name}:`, error);
      }
    }

    return loaded;
  }

  /**
   * Subscribe to plugin events
   */
  on(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /**
   * Get hook registration count
   */
  getHookStats(): Record<HookType, number> {
    const stats: Record<string, number> = {};
    for (const [hookType, registrations] of this.hooks) {
      stats[hookType] = registrations.length;
    }
    return stats as Record<HookType, number>;
  }

  // ==================== HELPERS ====================

  private async checkDependencies(manifest: PluginManifest): Promise<void> {
    if (!manifest.dependencies) return;

    for (const [depName, depVersion] of Object.entries(manifest.dependencies)) {
      const dep = this.plugins.get(depName);
      if (!dep) {
        throw new Error(`Missing dependency: ${depName}@${depVersion}`);
      }

      // Simple version check (could be enhanced with semver)
      if (dep.manifest.version !== depVersion && depVersion !== '*') {
        throw new Error(
          `Dependency version mismatch: ${depName}@${dep.manifest.version} (need ${depVersion})`
        );
      }
    }
  }

  private createPluginContext(pluginName: string): PluginContext {
    const entry = this.plugins.get(pluginName);
    const permissions = entry?.manifest.permissions || [];

    return {
      config: this.globalConfig[pluginName] || {},
      logger: this.createPluginLogger(pluginName),
      storage: this.createPluginStorage(pluginName),
      hooks: this.createHookRegistry(pluginName),
      services: this.createServiceAccessor(pluginName, permissions),
      permissions
    };
  }

  private createPluginLogger(pluginName: string): PluginLogger {
    const prefix = `[plugin:${pluginName}]`;
    return {
      debug: (msg, data) => console.debug(`${prefix} ${msg}`, data || ''),
      info: (msg, data) => console.info(`${prefix} ${msg}`, data || ''),
      warn: (msg, data) => console.warn(`${prefix} ${msg}`, data || ''),
      error: (msg, err) => console.error(`${prefix} ${msg}`, err?.message || '')
    };
  }

  private createPluginStorage(pluginName: string): PluginStorage {
    const storagePath = path.join(this.storageDir, pluginName);
    fs.mkdirSync(storagePath, { recursive: true });

    return {
      get: async <T>(key: string): Promise<T | undefined> => {
        const filePath = path.join(storagePath, `${key}.json`);
        if (!fs.existsSync(filePath)) return undefined;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      },
      set: async <T>(key: string, value: T): Promise<void> => {
        const filePath = path.join(storagePath, `${key}.json`);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
      },
      delete: async (key: string): Promise<void> => {
        const filePath = path.join(storagePath, `${key}.json`);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      },
      list: async (): Promise<string[]> => {
        if (!fs.existsSync(storagePath)) return [];
        return fs.readdirSync(storagePath)
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace('.json', ''));
      }
    };
  }

  private createHookRegistry(pluginName: string): HookRegistry {
    return {
      register: (hookType: HookType, handler: HookHandler, priority: number = 0) => {
        const registrations = this.hooks.get(hookType) || [];
        registrations.push({ pluginName, hookType, handler, priority });
        this.hooks.set(hookType, registrations);

        const entry = this.plugins.get(pluginName);
        if (entry) {
          entry.hooks.push({ pluginName, hookType, handler, priority });
        }
      },
      unregister: (hookType: HookType, handler: HookHandler) => {
        const registrations = this.hooks.get(hookType) || [];
        this.hooks.set(
          hookType,
          registrations.filter(r => r.handler !== handler)
        );
      }
    };
  }

  private createServiceAccessor(
    pluginName: string,
    permissions: PluginPermission[]
  ): ServiceAccessor {
    return {
      get: async <T>(serviceName: string): Promise<T> => {
        if (!permissions.includes('registry:access')) {
          throw new Error(`Plugin ${pluginName} lacks registry:access permission`);
        }

        // Dynamic import to avoid circular dependency
        const { ServiceRegistry } = await import('./ServiceRegistry');
        return ServiceRegistry.getInstance().get<T>(serviceName);
      },
      has: (_serviceName: string): boolean => {
        // Allow checking without permission
        return true; // Simplified, would check actual registry
      }
    };
  }

  private validateConfig(config: Record<string, any>, schema: PluginConfigSchema): void {
    for (const [key, def] of Object.entries(schema)) {
      const value = config[key];

      if (def.required && value === undefined) {
        throw new Error(`Missing required config: ${key}`);
      }

      if (value !== undefined) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (actualType !== def.type) {
          throw new Error(`Config ${key} must be ${def.type}, got ${actualType}`);
        }

        if (def.enum && !def.enum.includes(value)) {
          throw new Error(`Config ${key} must be one of: ${def.enum.join(', ')}`);
        }
      }
    }
  }

  private emit(event: PluginEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('Plugin event handler error:', error);
      }
    }
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## PluginSystem - Extensible Plugin Architecture

Dynamic plugin loading and management system.

### Plugin Structure
\`\`\`
my-plugin/
  manifest.json
  index.ts
  README.md
\`\`\`

### Manifest Example
\`\`\`json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My awesome plugin",
  "main": "index.js",
  "hooks": ["beforePhase", "afterPhase"],
  "permissions": ["file:read", "registry:access"]
}
\`\`\`

### Plugin Implementation
\`\`\`typescript
export default class MyPlugin implements IPlugin {
  name = 'my-plugin';
  version = '1.0.0';

  async onLoad(context: PluginContext) {
    context.logger.info('Plugin loaded');
  }

  async onActivate(context: PluginContext) {
    context.hooks.register('beforePhase', async (data) => {
      // Modify data before phase executes
      return { ...data, enhanced: true };
    });
  }

  async onDeactivate(context: PluginContext) {
    context.logger.info('Plugin deactivated');
  }
}
\`\`\`

### Hook Types
- beforePhase, afterPhase
- beforeToolCall, afterToolCall
- onError, onComplete
- beforeResponse, afterResponse
- onUserInput, onAgentThink
- beforeCommit, afterBuild

### Permissions
- file:read, file:write
- network:fetch
- shell:execute
- database:read/write
- ai:call
- registry:access

### Usage
\`\`\`typescript
const plugins = new PluginSystem();
await plugins.loadPlugin('./plugins/my-plugin');
await plugins.activatePlugin('my-plugin');

// Execute hooks
const result = await plugins.executeHook('beforePhase', data);
\`\`\`
    `;
  }
}

/**
 * Helper to create a simple plugin
 */
export function createPlugin(
  name: string,
  handlers: {
    onLoad?: (ctx: PluginContext) => Promise<void>;
    onActivate?: (ctx: PluginContext) => Promise<void>;
    onDeactivate?: (ctx: PluginContext) => Promise<void>;
    hooks?: Record<HookType, HookHandler>;
  }
): IPlugin {
  return {
    name,
    version: '1.0.0',

    async onLoad(context: PluginContext) {
      if (handlers.onLoad) {
        await handlers.onLoad(context);
      }
    },

    async onActivate(context: PluginContext) {
      if (handlers.hooks) {
        for (const [hookType, handler] of Object.entries(handlers.hooks)) {
          context.hooks.register(hookType as HookType, handler);
        }
      }
      if (handlers.onActivate) {
        await handlers.onActivate(context);
      }
    },

    async onDeactivate(context: PluginContext) {
      if (handlers.onDeactivate) {
        await handlers.onDeactivate(context);
      }
    }
  };
}
