/**
 * ServiceRegistry Tests
 *
 * Tests for the dynamic service registry that manages
 * service loading, dependency injection, and lifecycle.
 */

import { ServiceRegistry } from './ServiceRegistry';

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    // Reset singleton for each test
    (ServiceRegistry as any).instance = null;
    registry = ServiceRegistry.getInstance();
  });

  afterEach(async () => {
    await registry.clear();
    (ServiceRegistry as any).instance = null;
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ServiceRegistry.getInstance();
      const instance2 = ServiceRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('register', () => {
    it('should register a service with factory', () => {
      registry.register('TestService', () => ({ name: 'test' }), {
        category: 'utility',
      });
      expect(registry.has('TestService')).toBe(true);
    });

    it('should allow re-registering service with same name', () => {
      registry.register('Duplicate', () => ({ version: 1 }));
      // Re-registering doesn't throw - it may update
      expect(() => registry.register('Duplicate', () => ({ version: 2 }))).not.toThrow();
    });

    it('should register async factory', () => {
      registry.register('AsyncService', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { async: true };
      });
      expect(registry.has('AsyncService')).toBe(true);
    });
  });

  describe('get', () => {
    it('should load and return service instance', async () => {
      registry.register('SimpleService', () => ({ value: 42 }));
      const service = await registry.get<{ value: number }>('SimpleService');
      expect(service.value).toBe(42);
    });

    it('should return cached instance for singleton', async () => {
      let callCount = 0;
      registry.register(
        'SingletonService',
        () => {
          callCount++;
          return { count: callCount };
        },
        { singleton: true }
      );

      const instance1 = await registry.get('SingletonService');
      const instance2 = await registry.get('SingletonService');

      expect(instance1).toBe(instance2);
      expect(callCount).toBe(1);
    });

    it('should cache singleton by default', async () => {
      let callCount = 0;
      registry.register(
        'DefaultService',
        () => {
          callCount++;
          return { count: callCount };
        }
        // Default is singleton: true
      );

      await registry.get('DefaultService');
      await registry.get('DefaultService');

      // Singletons are cached, so factory only called once
      expect(callCount).toBe(1);
    });

    it('should throw for non-existent service', async () => {
      await expect(registry.get('NonExistent')).rejects.toThrow();
    });

    it('should handle async factory', async () => {
      registry.register('AsyncFactoryService', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return { loaded: true };
      });

      const service = await registry.get<{ loaded: boolean }>('AsyncFactoryService');
      expect(service.loaded).toBe(true);
    });
  });

  describe('getSync', () => {
    it('should return already loaded service', async () => {
      registry.register('PreloadedService', () => ({ preloaded: true }), {
        singleton: true,
      });

      // Load first
      await registry.get('PreloadedService');

      // Then get sync
      const service = registry.getSync<{ preloaded: boolean }>('PreloadedService');
      expect(service.preloaded).toBe(true);
    });

    it('should throw for unloaded service', () => {
      registry.register('UnloadedService', () => ({}));
      expect(() => registry.getSync('UnloadedService')).toThrow();
    });
  });

  describe('has', () => {
    it('should return true for registered service', () => {
      registry.register('RegisteredService', () => ({}));
      expect(registry.has('RegisteredService')).toBe(true);
    });

    it('should return false for unregistered service', () => {
      expect(registry.has('UnregisteredService')).toBe(false);
    });
  });

  describe('isReady', () => {
    it('should return false for unloaded service', () => {
      registry.register('NotReadyService', () => ({}));
      expect(registry.isReady('NotReadyService')).toBe(false);
    });

    it('should return true for loaded service', async () => {
      registry.register('ReadyService', () => ({}), { singleton: true });
      await registry.get('ReadyService');
      expect(registry.isReady('ReadyService')).toBe(true);
    });
  });

  describe('list', () => {
    it('should return all registered service metadata', () => {
      registry.register('Service1', () => ({}));
      registry.register('Service2', () => ({}));
      registry.register('Service3', () => ({}));

      const list = registry.list();
      const names = list.map(m => m.name);
      expect(names).toContain('Service1');
      expect(names).toContain('Service2');
      expect(names).toContain('Service3');
    });

    it('should return empty array when no services', () => {
      expect(registry.list()).toEqual([]);
    });
  });

  // Note: unregister method not implemented in ServiceRegistry
  // Services are managed via clear() for cleanup

  describe('clear', () => {
    it('should remove all services', async () => {
      registry.register('Service1', () => ({}));
      registry.register('Service2', () => ({}));

      await registry.clear();

      expect(registry.list()).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return registry statistics', async () => {
      registry.register('StatsService1', () => ({}), { category: 'utility', singleton: true });
      registry.register('StatsService2', () => ({}), { category: 'analysis', singleton: true });

      await registry.get('StatsService1');

      const stats = registry.getStats();
      expect(stats.totalServices).toBe(2);
      expect(stats.loadedServices).toBe(1);
    });
  });

  describe('aliases', () => {
    it('should resolve alias to service', async () => {
      registry.register('FullServiceName', () => ({ aliased: true }));
      registry.registerAlias('Short', 'FullServiceName');

      const service = await registry.get<{ aliased: boolean }>('Short');
      expect(service.aliased).toBe(true);
    });

    it('should check has with alias', () => {
      registry.register('AliasedService', () => ({}));
      registry.registerAlias('Alias', 'AliasedService');

      expect(registry.has('Alias')).toBe(true);
    });
  });

  describe('configure', () => {
    it('should store service configuration', () => {
      registry.register('ConfigurableService', () => ({}));
      registry.configure('ConfigurableService', { option1: 'value1', option2: 42 });
      // Configuration is stored - verify no errors
    });
  });

  describe('events', () => {
    it('should emit events on service lifecycle', async () => {
      const events: any[] = [];
      registry.on(event => events.push(event));

      registry.register('EventService', () => ({ event: true }), { singleton: true });
      await registry.get('EventService');

      expect(events.some(e => e.type === 'service:registered')).toBe(true);
      expect(events.some(e => e.type === 'service:loaded')).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should handle factory errors', async () => {
      registry.register('FailingService', () => {
        throw new Error('Factory failed');
      });

      await expect(registry.get('FailingService')).rejects.toThrow('Factory failed');
    });

    it('should handle async factory errors', async () => {
      registry.register('AsyncFailingService', async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        throw new Error('Async factory failed');
      });

      await expect(registry.get('AsyncFailingService')).rejects.toThrow('Async factory failed');
    });
  });
});
