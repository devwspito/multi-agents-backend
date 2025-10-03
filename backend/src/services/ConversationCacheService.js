const Redis = require('ioredis');
const AgentConversation = require('../models/AgentConversation');

/**
 * Intelligent Conversation Cache Service
 * Provides high-performance caching and real-time synchronization
 */
class ConversationCacheService {
  constructor() {
    // Redis client for caching
    this.redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
      lazyConnect: true
    });

    // Cache configuration
    this.cacheConfig = {
      conversationTTL: 3600, // 1 hour
      messageTTL: 7200, // 2 hours
      userSessionTTL: 1800, // 30 minutes
      popularConversationsTTL: 600, // 10 minutes
      searchResultsTTL: 300 // 5 minutes
    };

    // Cache statistics
    this.stats = {
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0
    };

    this.setupRedisHandlers();
    console.log('💾 Conversation Cache Service initialized');
  }

  /**
   * Setup Redis event handlers
   */
  setupRedisHandlers() {
    this.redis.on('connect', () => {
      console.log('💾 Redis cache connected');
    });

    this.redis.on('error', (error) => {
      console.error('❌ Redis cache error:', error);
    });

    this.redis.on('reconnecting', () => {
      console.log('🔄 Redis cache reconnecting...');
    });
  }

  /**
   * Get conversation from cache or database
   */
  async getConversation(conversationId, useCache = true) {
    const cacheKey = `conversation:${conversationId}`;
    
    try {
      if (useCache) {
        // Try cache first
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.stats.hits++;
          console.log(`💾 Cache hit for conversation ${conversationId}`);
          return JSON.parse(cached);
        }
      }

      // Cache miss - get from database
      this.stats.misses++;
      console.log(`💾 Cache miss for conversation ${conversationId} - fetching from DB`);
      
      const conversation = await AgentConversation
        .findById(conversationId)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .populate('userId', 'name email avatar')
        .lean(); // Use lean for better performance

      if (conversation) {
        // Cache the result
        await this.cacheConversation(conversationId, conversation);
        return conversation;
      }

      return null;
    } catch (error) {
      console.error('Error getting conversation from cache:', error);
      // Fallback to database
      return await AgentConversation.findById(conversationId)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .populate('userId', 'name email avatar');
    }
  }

  /**
   * Cache conversation data
   */
  async cacheConversation(conversationId, conversation) {
    const cacheKey = `conversation:${conversationId}`;
    
    try {
      await this.redis.setex(
        cacheKey,
        this.cacheConfig.conversationTTL,
        JSON.stringify(conversation)
      );
      
      this.stats.writes++;
      
      // Cache conversation metadata separately for quick access
      await this.cacheConversationMetadata(conversationId, conversation);
      
      console.log(`💾 Cached conversation ${conversationId}`);
    } catch (error) {
      console.error('Error caching conversation:', error);
    }
  }

  /**
   * Cache conversation metadata for listing
   */
  async cacheConversationMetadata(conversationId, conversation) {
    const metadataKey = `conversation:meta:${conversationId}`;
    const metadata = {
      _id: conversation._id,
      agentType: conversation.agentType,
      status: conversation.status,
      messageCount: conversation.messages?.length || 0,
      lastMessage: conversation.messages?.length > 0 
        ? conversation.messages[conversation.messages.length - 1] 
        : null,
      updatedAt: conversation.updatedAt,
      taskId: conversation.taskId,
      projectId: conversation.projectId
    };

    try {
      await this.redis.setex(
        metadataKey,
        this.cacheConfig.conversationTTL,
        JSON.stringify(metadata)
      );
    } catch (error) {
      console.error('Error caching conversation metadata:', error);
    }
  }

  /**
   * Get user's active conversations with intelligent caching
   */
  async getUserActiveConversations(userId, useCache = true) {
    const cacheKey = `user:${userId}:active_conversations`;
    
    try {
      if (useCache) {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          this.stats.hits++;
          return JSON.parse(cached);
        }
      }

      // Cache miss - get from database
      this.stats.misses++;
      
      const conversations = await AgentConversation
        .findActiveConversations(userId)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .lean();

      // Cache the result
      await this.redis.setex(
        cacheKey,
        this.cacheConfig.userSessionTTL,
        JSON.stringify(conversations)
      );

      // Cache individual conversations too
      for (const conversation of conversations) {
        await this.cacheConversation(conversation._id, conversation);
      }

      return conversations;
    } catch (error) {
      console.error('Error getting user active conversations:', error);
      return [];
    }
  }

  /**
   * Add message to cached conversation
   */
  async addMessageToCache(conversationId, message) {
    const cacheKey = `conversation:${conversationId}`;
    
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const conversation = JSON.parse(cached);
        conversation.messages.push(message);
        conversation.updatedAt = new Date().toISOString();
        
        // Update cache
        await this.redis.setex(
          cacheKey,
          this.cacheConfig.conversationTTL,
          JSON.stringify(conversation)
        );

        // Update metadata
        await this.cacheConversationMetadata(conversationId, conversation);
        
        // Invalidate user's active conversations cache
        await this.invalidateUserConversationsCache(conversation.userId);
        
        console.log(`💾 Added message to cached conversation ${conversationId}`);
      }
    } catch (error) {
      console.error('Error adding message to cache:', error);
    }
  }

  /**
   * Update conversation status in cache
   */
  async updateConversationStatus(conversationId, status) {
    const cacheKey = `conversation:${conversationId}`;
    
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const conversation = JSON.parse(cached);
        conversation.status = status;
        conversation.updatedAt = new Date().toISOString();
        
        await this.redis.setex(
          cacheKey,
          this.cacheConfig.conversationTTL,
          JSON.stringify(conversation)
        );

        console.log(`💾 Updated conversation status in cache: ${conversationId} -> ${status}`);
      }
    } catch (error) {
      console.error('Error updating conversation status in cache:', error);
    }
  }

  /**
   * Cache search results
   */
  async cacheSearchResults(query, results, filters = {}) {
    const searchKey = this.generateSearchKey(query, filters);
    
    try {
      await this.redis.setex(
        searchKey,
        this.cacheConfig.searchResultsTTL,
        JSON.stringify({
          query,
          filters,
          results,
          timestamp: new Date().toISOString(),
          count: results.length
        })
      );
      
      console.log(`💾 Cached search results for query: ${query}`);
    } catch (error) {
      console.error('Error caching search results:', error);
    }
  }

  /**
   * Get cached search results
   */
  async getCachedSearchResults(query, filters = {}) {
    const searchKey = this.generateSearchKey(query, filters);
    
    try {
      const cached = await this.redis.get(searchKey);
      if (cached) {
        this.stats.hits++;
        return JSON.parse(cached);
      }
      
      this.stats.misses++;
      return null;
    } catch (error) {
      console.error('Error getting cached search results:', error);
      return null;
    }
  }

  /**
   * Generate search cache key
   */
  generateSearchKey(query, filters) {
    const filterString = Object.keys(filters)
      .sort()
      .map(key => `${key}:${filters[key]}`)
      .join('|');
    
    const searchString = `${query}|${filterString}`;
    return `search:${Buffer.from(searchString).toString('base64')}`;
  }

  /**
   * Cache popular/trending conversations
   */
  async cachePopularConversations(conversations) {
    const cacheKey = 'popular_conversations';
    
    try {
      await this.redis.setex(
        cacheKey,
        this.cacheConfig.popularConversationsTTL,
        JSON.stringify({
          conversations,
          timestamp: new Date().toISOString()
        })
      );
      
      console.log(`💾 Cached ${conversations.length} popular conversations`);
    } catch (error) {
      console.error('Error caching popular conversations:', error);
    }
  }

  /**
   * Get popular conversations from cache
   */
  async getPopularConversations() {
    try {
      const cached = await this.redis.get('popular_conversations');
      if (cached) {
        this.stats.hits++;
        return JSON.parse(cached);
      }
      
      this.stats.misses++;
      return null;
    } catch (error) {
      console.error('Error getting popular conversations:', error);
      return null;
    }
  }

  /**
   * Invalidate conversation cache
   */
  async invalidateConversation(conversationId) {
    const cacheKey = `conversation:${conversationId}`;
    const metaKey = `conversation:meta:${conversationId}`;
    
    try {
      await Promise.all([
        this.redis.del(cacheKey),
        this.redis.del(metaKey)
      ]);
      
      console.log(`💾 Invalidated cache for conversation ${conversationId}`);
    } catch (error) {
      console.error('Error invalidating conversation cache:', error);
    }
  }

  /**
   * Invalidate user's conversations cache
   */
  async invalidateUserConversationsCache(userId) {
    const cacheKey = `user:${userId}:active_conversations`;
    
    try {
      await this.redis.del(cacheKey);
      console.log(`💾 Invalidated user conversations cache for ${userId}`);
    } catch (error) {
      console.error('Error invalidating user conversations cache:', error);
    }
  }

  /**
   * Batch cache conversations
   */
  async batchCacheConversations(conversations) {
    const pipeline = this.redis.pipeline();
    
    try {
      for (const conversation of conversations) {
        const cacheKey = `conversation:${conversation._id}`;
        pipeline.setex(
          cacheKey,
          this.cacheConfig.conversationTTL,
          JSON.stringify(conversation)
        );
      }
      
      await pipeline.exec();
      this.stats.writes += conversations.length;
      
      console.log(`💾 Batch cached ${conversations.length} conversations`);
    } catch (error) {
      console.error('Error batch caching conversations:', error);
    }
  }

  /**
   * Preload user's likely-to-access conversations
   */
  async preloadUserConversations(userId) {
    try {
      // Get user's recent conversations
      const recentConversations = await AgentConversation
        .find({ userId })
        .sort({ updatedAt: -1 })
        .limit(10)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .lean();

      // Cache them
      await this.batchCacheConversations(recentConversations);
      
      console.log(`💾 Preloaded ${recentConversations.length} conversations for user ${userId}`);
    } catch (error) {
      console.error('Error preloading user conversations:', error);
    }
  }

  /**
   * Smart cache warming based on usage patterns
   */
  async warmCache() {
    try {
      console.log('🔥 Starting cache warming...');
      
      // Warm popular conversations
      const popularConversations = await AgentConversation
        .find({ status: 'active' })
        .sort({ 'metrics.messageCount': -1 })
        .limit(50)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .lean();

      await this.batchCacheConversations(popularConversations);
      await this.cachePopularConversations(popularConversations);

      // Warm recently active conversations
      const recentlyActive = await AgentConversation
        .find({ updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
        .sort({ updatedAt: -1 })
        .limit(100)
        .populate('taskId', 'title description status')
        .populate('projectId', 'name type status')
        .lean();

      await this.batchCacheConversations(recentlyActive);

      console.log(`🔥 Cache warming completed: ${popularConversations.length + recentlyActive.length} conversations cached`);
    } catch (error) {
      console.error('Error warming cache:', error);
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const hitRate = this.stats.hits / (this.stats.hits + this.stats.misses) * 100;
    
    return {
      ...this.stats,
      hitRate: isNaN(hitRate) ? 0 : hitRate.toFixed(2),
      config: this.cacheConfig
    };
  }

  /**
   * Clear all cache
   */
  async clearCache() {
    try {
      await this.redis.flushdb();
      
      // Reset stats
      this.stats = {
        hits: 0,
        misses: 0,
        writes: 0,
        evictions: 0
      };
      
      console.log('💾 Cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  /**
   * Monitor cache performance
   */
  startCacheMonitoring() {
    setInterval(() => {
      const stats = this.getCacheStats();
      console.log(`💾 Cache Stats - Hit Rate: ${stats.hitRate}%, Hits: ${stats.hits}, Misses: ${stats.misses}, Writes: ${stats.writes}`);
    }, 60000); // Every minute
  }

  /**
   * Cache cleanup - remove expired keys
   */
  async cleanup() {
    try {
      // Redis handles TTL automatically, but we can do additional cleanup
      const pattern = 'conversation:*';
      const keys = await this.redis.keys(pattern);
      
      console.log(`💾 Found ${keys.length} conversation cache keys`);
      
      // In a real implementation, you might want to check if conversations still exist
      // and remove orphaned cache entries
      
    } catch (error) {
      console.error('Error during cache cleanup:', error);
    }
  }
}

// Export singleton instance
const conversationCacheService = new ConversationCacheService();
module.exports = conversationCacheService;