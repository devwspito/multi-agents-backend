const mongoose = require('mongoose');

/**
 * Database configuration and connection management
 */
class DatabaseConfig {
  constructor() {
    this.connectionString = process.env.MONGODB_URI;
    this.options = {
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      family: 4, // Use IPv4, skip trying IPv6
      bufferCommands: false, // Disable mongoose buffering
    };
  }

  /**
   * Connect to MongoDB database
   */
  async connect() {
    try {
      await mongoose.connect(this.connectionString, this.options);
      
      console.log('📊 MongoDB connected successfully');
      console.log(`🔗 Database: ${mongoose.connection.name}`);
      
      // Set up connection event listeners
      this.setupEventListeners();
      
      return mongoose.connection;
    } catch (error) {
      console.error('❌ MongoDB connection error:', error.message);
      process.exit(1);
    }
  }

  /**
   * Set up database event listeners
   */
  setupEventListeners() {
    mongoose.connection.on('error', (error) => {
      console.error('❌ MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected');
    });

    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected');
    });

    // Graceful shutdown
    process.on('SIGINT', async () => {
      try {
        await mongoose.connection.close();
        console.log('📊 MongoDB connection closed through app termination');
        process.exit(0);
      } catch (error) {
        console.error('❌ Error closing MongoDB connection:', error);
        process.exit(1);
      }
    });
  }

  /**
   * Get connection status
   */
  getConnectionStatus() {
    const states = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    
    return {
      status: states[mongoose.connection.readyState],
      host: mongoose.connection.host,
      port: mongoose.connection.port,
      name: mongoose.connection.name
    };
  }

  /**
   * Initialize platform database
   */
  async initializePlatformDatabase() {
    return this.initializeDatabase();
  }

  /**
   * Initialize database with collections and indexes
   */
  async initializeDatabase() {
    try {
      // Create collections if they don't exist
      const collections = ['users', 'projects', 'tasks', 'activities'];
      
      for (const collection of collections) {
        const exists = await mongoose.connection.db.listCollections({ name: collection }).hasNext();
        if (!exists) {
          await mongoose.connection.db.createCollection(collection);
          console.log(`📚 Created ${collection} collection`);
        }
      }

      // Skip index creation for now
      // await this.createIndexes();
      
      console.log('🚀 Platform database initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing platform database:', error);
      throw error;
    }
  }

  /**
   * Create indexes optimized for development workflows
   */
  async createIndexes() {
    try {
      const db = mongoose.connection.db;

      // User indexes for platform access patterns
      try {
        await db.collection('users').createIndex(
          { 'organization.type': 1, 'specializations': 1 },
          { name: 'platform_users_idx' }
        );
      } catch (error) {
        if (error.code === 85) {
          // Index exists with different name, drop and recreate
          await db.collection('users').dropIndex('educational_users_idx');
          await db.collection('users').createIndex(
            { 'organization.type': 1, 'specializations': 1 },
            { name: 'platform_users_idx' }
          );
        } else {
          throw error;
        }
      }

      await db.collection('users').createIndex(
        { 'permissions.compliance.ferpaAccess': 1 },
        { name: 'ferpa_access_idx' }
      );

      // Project indexes for platform filtering
      await db.collection('projects').createIndex(
        { type: 1, 'metadata.targetAudience': 1 },
        { name: 'platform_projects_idx' }
      );

      await db.collection('projects').createIndex(
        { 'compliance.ferpa': 1, 'compliance.coppa': 1 },
        { name: 'compliance_projects_idx' }
      );

      // Task indexes for agent assignment and development workflows
      await db.collection('tasks').createIndex(
        { assignedAgent: 1, complexity: 1, status: 1 },
        { name: 'agent_assignment_idx' }
      );

      await db.collection('tasks').createIndex(
        { priority: 1, type: 1 },
        { name: 'task_priority_idx' }
      );

      await db.collection('tasks').createIndex(
        { 'compliance.ferpaReview.required': 1, 'compliance.ferpaReview.completed': 1 },
        { name: 'ferpa_compliance_idx' }
      );

      await db.collection('tasks').createIndex(
        { 'testing.accessibilityTests.required': 1, 'testing.accessibilityTests.status': 1 },
        { name: 'accessibility_testing_idx' }
      );

      // Activity indexes for audit trails and analytics
      await db.collection('activities').createIndex(
        { agentType: 1, action: 1, createdAt: -1 },
        { name: 'agent_analytics_idx' }
      );

      await db.collection('activities').createIndex(
        { 'educational.complianceFlags.type': 1, createdAt: -1 },
        { name: 'compliance_audit_idx' }
      );

      // Token Usage indexes for analytics and cost tracking
      await db.collection('tokenusages').createIndex(
        { user: 1, timestamp: -1 },
        { name: 'user_usage_idx' }
      );

      await db.collection('tokenusages').createIndex(
        { model: 1, agentType: 1, timestamp: -1 },
        { name: 'model_agent_usage_idx' }
      );

      await db.collection('tokenusages').createIndex(
        { user: 1, model: 1, timestamp: -1 },
        { name: 'user_model_usage_idx' }
      );

      await db.collection('tokenusages').createIndex(
        { timestamp: 1 },
        { name: 'token_usage_ttl_idx', expireAfterSeconds: 7776000 } // 90 days TTL
      );

      console.log('📊 Platform indexes created successfully');
    } catch (error) {
      console.error('❌ Error creating platform indexes:', error);
      throw error;
    }
  }

  /**
   * Health check for database connection
   */
  async healthCheck() {
    try {
      await mongoose.connection.db.admin().ping();
      return {
        status: 'healthy',
        connection: this.getConnectionStatus(),
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        error: error.message,
        connection: this.getConnectionStatus(),
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Get database statistics for monitoring
   */
  async getStats() {
    try {
      const db = mongoose.connection.db;
      const stats = await db.stats();
      
      // Get collection counts
      const collections = await Promise.all([
        db.collection('users').countDocuments(),
        db.collection('projects').countDocuments(),
        db.collection('tasks').countDocuments(),
        db.collection('activities').countDocuments()
      ]);

      return {
        database: {
          name: stats.db,
          collections: stats.collections,
          dataSize: stats.dataSize,
          storageSize: stats.storageSize,
          indexes: stats.indexes,
          indexSize: stats.indexSize
        },
        collections: {
          users: collections[0],
          projects: collections[1],
          tasks: collections[2],
          activities: collections[3]
        },
        connection: this.getConnectionStatus()
      };
    } catch (error) {
      throw new Error(`Error getting database stats: ${error.message}`);
    }
  }

  /**
   * Platform data cleanup utilities
   */
  async cleanupTestData() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Cannot cleanup data in production environment');
    }

    try {
      // Only allow in development/test environments
      await mongoose.connection.db.collection('activities').deleteMany({
        actor: { $regex: /^test-/ }
      });

      await mongoose.connection.db.collection('tasks').deleteMany({
        title: { $regex: /^test-/i }
      });

      await mongoose.connection.db.collection('projects').deleteMany({
        name: { $regex: /^test-/i }
      });

      console.log('🧹 Test data cleaned up successfully');
    } catch (error) {
      console.error('❌ Error cleaning up test data:', error);
      throw error;
    }
  }

  /**
   * Backup platform data
   */
  async backupPlatformData(outputPath) {
    try {
      const collections = ['users', 'projects', 'tasks', 'activities'];
      const backup = {};

      for (const collection of collections) {
        backup[collection] = await mongoose.connection.db
          .collection(collection)
          .find({})
          .toArray();
      }

      // In a real implementation, save to file or cloud storage
      console.log(`📦 Platform data backup created: ${Object.keys(backup).length} collections`);
      
      return backup;
    } catch (error) {
      console.error('❌ Error backing up platform data:', error);
      throw error;
    }
  }

  /**
   * Validate platform data integrity
   */
  async validatePlatformIntegrity() {
    try {
      const issues = [];

      // Check for orphaned tasks
      const orphanedTasks = await mongoose.connection.db.collection('tasks').aggregate([
        {
          $lookup: {
            from: 'projects',
            localField: 'project',
            foreignField: '_id',
            as: 'projectData'
          }
        },
        {
          $match: {
            projectData: { $size: 0 }
          }
        }
      ]).toArray();

      if (orphanedTasks.length > 0) {
        issues.push(`Found ${orphanedTasks.length} orphaned tasks`);
      }

      // Check for activities without tasks
      const orphanedActivities = await mongoose.connection.db.collection('activities').aggregate([
        {
          $match: {
            task: { $exists: true }
          }
        },
        {
          $lookup: {
            from: 'tasks',
            localField: 'task',
            foreignField: '_id',
            as: 'taskData'
          }
        },
        {
          $match: {
            taskData: { $size: 0 }
          }
        }
      ]).toArray();

      if (orphanedActivities.length > 0) {
        issues.push(`Found ${orphanedActivities.length} orphaned activities`);
      }

      // Check for missing task data
      const incompleteTasks = await mongoose.connection.db.collection('tasks').countDocuments({
        $and: [
          { type: 'feature' },
          { status: { $exists: false } }
        ]
      });

      if (incompleteTasks > 0) {
        issues.push(`Found ${incompleteTasks} tasks missing status data`);
      }

      return {
        healthy: issues.length === 0,
        issues,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error validating platform data integrity: ${error.message}`);
    }
  }
}

// Export singleton instance
const databaseConfig = new DatabaseConfig();

module.exports = databaseConfig;