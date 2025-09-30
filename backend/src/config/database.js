const mongoose = require('mongoose');

/**
 * Database configuration and connection management
 */
class DatabaseConfig {
  constructor() {
    this.connectionString = process.env.MONGODB_URI || 'mongodb://localhost:27017/agents_software_arq';
    this.options = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      family: 4, // Use IPv4, skip trying IPv6
      bufferCommands: false, // Disable mongoose buffering
      bufferMaxEntries: 0, // Disable mongoose buffering
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
   * Initialize database with educational collections and indexes
   */
  async initializeEducationalDatabase() {
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

      // Create educational-specific indexes
      await this.createEducationalIndexes();
      
      console.log('🎓 Educational database initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing educational database:', error);
      throw error;
    }
  }

  /**
   * Create indexes optimized for educational workflows
   */
  async createEducationalIndexes() {
    try {
      const db = mongoose.connection.db;

      // User indexes for educational access patterns
      await db.collection('users').createIndex(
        { 'organization.type': 1, 'specializations': 1 },
        { name: 'educational_users_idx' }
      );

      await db.collection('users').createIndex(
        { 'permissions.compliance.ferpaAccess': 1 },
        { name: 'ferpa_access_idx' }
      );

      // Project indexes for educational filtering
      await db.collection('projects').createIndex(
        { type: 1, 'metadata.targetAudience': 1 },
        { name: 'educational_projects_idx' }
      );

      await db.collection('projects').createIndex(
        { 'compliance.ferpa': 1, 'compliance.coppa': 1 },
        { name: 'compliance_projects_idx' }
      );

      // Task indexes for agent assignment and educational workflows
      await db.collection('tasks').createIndex(
        { assignedAgent: 1, complexity: 1, status: 1 },
        { name: 'agent_assignment_idx' }
      );

      await db.collection('tasks').createIndex(
        { 'educationalImpact.targetAudience': 1, type: 1 },
        { name: 'educational_impact_idx' }
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

      console.log('📊 Educational indexes created successfully');
    } catch (error) {
      console.error('❌ Error creating educational indexes:', error);
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
   * Educational data cleanup utilities
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
   * Backup educational data
   */
  async backupEducationalData(outputPath) {
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
      console.log(`📦 Educational data backup created: ${Object.keys(backup).length} collections`);
      
      return backup;
    } catch (error) {
      console.error('❌ Error backing up educational data:', error);
      throw error;
    }
  }

  /**
   * Validate educational data integrity
   */
  async validateEducationalIntegrity() {
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

      // Check for missing educational compliance data
      const nonCompliantTasks = await mongoose.connection.db.collection('tasks').countDocuments({
        $and: [
          { type: 'feature' },
          { 'educationalImpact.learningObjectives': { $exists: false } }
        ]
      });

      if (nonCompliantTasks > 0) {
        issues.push(`Found ${nonCompliantTasks} tasks missing educational impact data`);
      }

      return {
        healthy: issues.length === 0,
        issues,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      throw new Error(`Error validating educational data integrity: ${error.message}`);
    }
  }
}

// Export singleton instance
const databaseConfig = new DatabaseConfig();

module.exports = databaseConfig;