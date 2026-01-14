/**
 * SmartCacheLayer Tests
 *
 * Tests for the intelligent caching system with LRU eviction,
 * TTL-based expiration, and file-based invalidation.
 */

import { SmartCacheLayer } from './SmartCacheLayer';

describe('SmartCacheLayer', () => {
  let cache: SmartCacheLayer;

  beforeEach(() => {
    // Reset singleton for each test
    (SmartCacheLayer as any).instance = null;
    cache = SmartCacheLayer.getInstance({
      maxSize: 1024 * 1024, // 1MB
      maxEntries: 100,
      defaultTTL: 1000, // 1 second for faster tests
      cleanupInterval: 60000,
      enableFileWatch: false,
    });
  });

  afterEach(() => {
    cache.stop(); // Stop cleanup timer
    cache.clear();
    (SmartCacheLayer as any).instance = null;
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SmartCacheLayer.getInstance();
      const instance2 = SmartCacheLayer.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('set and get', () => {
    it('should store and retrieve a value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should store complex objects', () => {
      const obj = { name: 'test', data: [1, 2, 3], nested: { a: 1 } };
      cache.set('complex', obj);
      expect(cache.get('complex')).toEqual(obj);
    });

    it('should handle null and undefined values', () => {
      cache.set('null', null);
      cache.set('undefined', undefined);
      expect(cache.get('null')).toBeNull();
      expect(cache.get('undefined')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('should return true for existing key', () => {
      cache.set('exists', 'value');
      expect(cache.has('exists')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return false for expired key', async () => {
      cache.set('expiring', 'value', { ttl: 50 });
      expect(cache.has('expiring')).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cache.has('expiring')).toBe(false);
    });
  });

  describe('size', () => {
    it('should return 0 for empty cache', () => {
      expect(cache.size()).toBe(0);
    });

    it('should return correct count after adding items', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
      expect(cache.size()).toBe(3);
    });

    it('should decrease count after delete', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.delete('key1');
      expect(cache.size()).toBe(1);
    });
  });

  describe('delete', () => {
    it('should remove an existing key', () => {
      cache.set('toDelete', 'value');
      cache.delete('toDelete');
      expect(cache.get('toDelete')).toBeUndefined();
    });

    it('should not throw when deleting non-existent key', () => {
      expect(() => cache.delete('nonexistent')).not.toThrow();
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', async () => {
      cache.set('short-lived', 'value', { ttl: 50 });
      expect(cache.get('short-lived')).toBe('value');

      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cache.get('short-lived')).toBeUndefined();
    });

    it('should not expire entries before TTL', async () => {
      cache.set('longer-lived', 'value', { ttl: 500 });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(cache.get('longer-lived')).toBe('value');
    });
  });

  describe('getOrCompute', () => {
    it('should compute and cache value on miss', async () => {
      let computeCount = 0;
      const compute = async () => {
        computeCount++;
        return 'computed-value';
      };

      const result1 = await cache.getOrCompute('compute-key', compute);
      const result2 = await cache.getOrCompute('compute-key', compute);

      expect(result1).toBe('computed-value');
      expect(result2).toBe('computed-value');
      expect(computeCount).toBe(1); // Only computed once
    });

    it('should return cached value on hit', async () => {
      cache.set('existing', 'cached-value');

      const result = await cache.getOrCompute('existing', async () => 'new-value');
      expect(result).toBe('cached-value');
    });

    it('should recompute after expiration', async () => {
      let version = 1;
      const compute = async () => `version-${version++}`;

      const result1 = await cache.getOrCompute('expiring-compute', compute, { ttl: 50 });
      expect(result1).toBe('version-1');

      await new Promise(resolve => setTimeout(resolve, 100));

      const result2 = await cache.getOrCompute('expiring-compute', compute, { ttl: 50 });
      expect(result2).toBe('version-2');
    });
  });

  describe('getStats', () => {
    it('should track cache hits', () => {
      cache.set('key', 'value');
      cache.get('key');
      cache.get('key');

      const stats = cache.getStats();
      expect(stats.hits).toBeGreaterThanOrEqual(2);
    });

    it('should track cache misses', () => {
      cache.get('nonexistent1');
      cache.get('nonexistent2');

      const stats = cache.getStats();
      expect(stats.misses).toBeGreaterThanOrEqual(2);
    });

    it('should calculate hit rate', () => {
      cache.set('key', 'value');
      cache.get('key'); // hit
      cache.get('key'); // hit
      cache.get('miss'); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeGreaterThan(0);
    });
  });

  describe('tags', () => {
    it('should invalidate entries by tag', () => {
      cache.set('tagged1', 'value1', { tags: ['group-a'] });
      cache.set('tagged2', 'value2', { tags: ['group-a'] });
      cache.set('tagged3', 'value3', { tags: ['group-b'] });

      cache.invalidateByTag('group-a');

      expect(cache.get('tagged1')).toBeUndefined();
      expect(cache.get('tagged2')).toBeUndefined();
      expect(cache.get('tagged3')).toBe('value3');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string keys', () => {
      cache.set('', 'empty-key-value');
      expect(cache.get('')).toBe('empty-key-value');
    });

    it('should handle very long keys', () => {
      const longKey = 'a'.repeat(1000);
      cache.set(longKey, 'long-key-value');
      expect(cache.get(longKey)).toBe('long-key-value');
    });

    it('should handle special characters in keys', () => {
      const specialKey = 'key/with:special@chars#and$symbols';
      cache.set(specialKey, 'special-value');
      expect(cache.get(specialKey)).toBe('special-value');
    });
  });
});
