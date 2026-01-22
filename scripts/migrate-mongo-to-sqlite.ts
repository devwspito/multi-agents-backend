/**
 * MongoDB to SQLite Migration Script
 *
 * Migrates all data from MongoDB to SQLite
 * Run with: npx ts-node scripts/migrate-mongo-to-sqlite.ts
 */

import { MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';

// Load env BEFORE importing database
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found in environment');
  process.exit(1);
}

// Import after dotenv
import { initDb, getDb, closeDb } from '../src/database/index';

// Helper to convert MongoDB ObjectId to string
function toId(val: any): string {
  if (!val) return '';
  if (val instanceof ObjectId) return val.toHexString();
  if (typeof val === 'object' && val?._id) return toId(val._id);
  if (typeof val === 'object' && val?.toString) return val.toString();
  return String(val || '');
}

// Helper to convert Date to ISO string
function toISOString(val: any): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

// Helper to safely stringify JSON
function toJSON(val: any): string {
  try {
    return JSON.stringify(val || {});
  } catch {
    return '{}';
  }
}

async function migrate() {
  console.log('🚀 Starting MongoDB to SQLite migration...\n');

  // Initialize SQLite (creates tables if not exist)
  console.log('📂 Initializing SQLite database...');
  initDb();
  const sqlite = getDb();

  // Disable foreign key constraints for migration
  sqlite.pragma('foreign_keys = OFF');
  console.log('⚠️  Foreign key constraints disabled for migration');
  console.log('✅ SQLite database initialized with tables\n');

  // Connect to MongoDB
  console.log('📡 Connecting to MongoDB...');
  const mongoClient = new MongoClient(MONGODB_URI!);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(); // Use default database from URI
  console.log('✅ Connected to MongoDB\n');

  // List all collections
  const collections = await mongoDb.listCollections().toArray();
  console.log('📋 MongoDB Collections found:');
  collections.forEach(c => console.log(`   - ${c.name}`));
  console.log('');

  // Migration stats
  const stats: Record<string, { migrated: number; skipped: number; errors: number }> = {};

  // Helper function to migrate a collection
  async function migrateCollection(
    collectionName: string,
    tableName: string,
    transform: (doc: any) => Record<string, any> | null,
    insertSql: string
  ) {
    console.log(`\n📦 Migrating ${collectionName} → ${tableName}...`);
    stats[tableName] = { migrated: 0, skipped: 0, errors: 0 };

    try {
      const collection = mongoDb.collection(collectionName);
      console.log(`   Fetching documents...`);

      // Use toArray with a 5-minute timeout for large collections
      const docs = await Promise.race([
        collection.find({}).toArray(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout fetching documents')), 300000)
        )
      ]);

      console.log(`   Found ${docs.length} documents`);

      if (docs.length === 0) {
        console.log(`   ⏭️  No documents to migrate`);
        return;
      }

      const insert = sqlite.prepare(insertSql);

      // Process one at a time
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i];
        try {
          const transformed = transform(doc);
          if (transformed) {
            try {
              insert.run(transformed);
              stats[tableName].migrated++;
            } catch (err: any) {
              if (err.message?.includes('UNIQUE constraint') || err.message?.includes('PRIMARY KEY')) {
                stats[tableName].skipped++;
              } else {
                stats[tableName].errors++;
              }
            }
          }
        } catch (e: any) {
          console.error(`   ⚠️ Transform error on doc ${i}: ${e.message}`);
          stats[tableName].errors++;
        }

        // Progress every 100
        if ((i + 1) % 100 === 0 || i === docs.length - 1) {
          console.log(`   Progress: ${i + 1}/${docs.length}`);
        }
      }

      console.log(`   ✅ Migrated: ${stats[tableName].migrated}, Skipped: ${stats[tableName].skipped}, Errors: ${stats[tableName].errors}`);
    } catch (err: any) {
      console.error(`   ❌ Collection error: ${err.message}`);
    }
  }

  // ==================== MIGRATE USERS ====================
  // SQLite schema: id, github_id, username, email, avatar_url, access_token, refresh_token, token_expiry, default_api_key, created_at, updated_at
  await migrateCollection(
    'users',
    'users',
    (doc) => ({
      id: toId(doc._id),
      github_id: doc.githubId || doc.id?.toString() || toId(doc._id),
      username: doc.username || doc.login || 'unknown',
      email: doc.email || `${doc.username || 'user'}@example.com`,
      avatar_url: doc.avatar_url || doc.avatarUrl || null,
      access_token: doc.accessToken || '',
      refresh_token: doc.refreshToken || null,
      token_expiry: doc.tokenExpiresAt ? toISOString(doc.tokenExpiresAt) : null,
      default_api_key: doc.defaultApiKey || null,
      created_at: toISOString(doc.createdAt || doc.created_at),
      updated_at: toISOString(doc.updatedAt || doc.updated_at || doc.createdAt),
    }),
    `INSERT OR IGNORE INTO users (id, github_id, username, email, avatar_url, access_token, refresh_token, token_expiry, default_api_key, created_at, updated_at)
     VALUES (@id, @github_id, @username, @email, @avatar_url, @access_token, @refresh_token, @token_expiry, @default_api_key, @created_at, @updated_at)`
  );

  // ==================== MIGRATE PROJECTS ====================
  // SQLite schema: id, name, description, type, status, user_id, api_key, webhook_api_key, dev_auth, settings, stats, token_stats, is_active, created_at, updated_at
  await migrateCollection(
    'projects',
    'projects',
    (doc) => ({
      id: toId(doc._id),
      name: doc.name || 'Unnamed Project',
      description: doc.description || null,
      type: doc.type || 'web-app',
      status: doc.status || 'planning',
      user_id: toId(doc.userId || doc.user),
      api_key: doc.apiKey || null,
      webhook_api_key: doc.webhookApiKey || null,
      dev_auth: toJSON(doc.devAuth),
      settings: toJSON(doc.settings),
      stats: toJSON(doc.stats),
      token_stats: toJSON(doc.tokenStats),
      is_active: doc.isActive !== false ? 1 : 0,
      created_at: toISOString(doc.createdAt),
      updated_at: toISOString(doc.updatedAt || doc.createdAt),
    }),
    `INSERT OR IGNORE INTO projects (id, name, description, type, status, user_id, api_key, webhook_api_key, dev_auth, settings, stats, token_stats, is_active, created_at, updated_at)
     VALUES (@id, @name, @description, @type, @status, @user_id, @api_key, @webhook_api_key, @dev_auth, @settings, @stats, @token_stats, @is_active, @created_at, @updated_at)`
  );

  // ==================== MIGRATE REPOSITORIES ====================
  // SQLite schema: id, name, description, project_id, github_repo_url, github_repo_name, github_branch, workspace_id, type, path_patterns, execution_order, dependencies, env_variables, is_active, last_synced_at, created_at, updated_at
  await migrateCollection(
    'repositories',
    'repositories',
    (doc) => {
      const workspaceId = doc.workspaceId || `ws-${toId(doc._id).substring(0, 8)}`;
      return {
        id: toId(doc._id),
        name: doc.name || doc.fullName?.split('/')?.pop() || 'unknown',
        description: doc.description || null,
        project_id: toId(doc.projectId || doc.project),
        github_repo_url: doc.cloneUrl || doc.clone_url || doc.githubRepoUrl || `https://github.com/${doc.fullName || doc.name}`,
        github_repo_name: doc.fullName || doc.name || 'unknown/unknown',
        github_branch: doc.defaultBranch || doc.default_branch || doc.githubBranch || 'main',
        workspace_id: workspaceId,
        type: doc.type || 'backend',
        path_patterns: toJSON(doc.pathPatterns || []),
        execution_order: doc.executionOrder || 0,
        dependencies: toJSON(doc.dependencies || []),
        env_variables: toJSON(doc.envVariables || {}),
        is_active: doc.isActive !== false ? 1 : 0,
        last_synced_at: doc.lastSyncedAt ? toISOString(doc.lastSyncedAt) : null,
        created_at: toISOString(doc.createdAt),
        updated_at: toISOString(doc.updatedAt || doc.createdAt),
      };
    },
    `INSERT OR IGNORE INTO repositories (id, name, description, project_id, github_repo_url, github_repo_name, github_branch, workspace_id, type, path_patterns, execution_order, dependencies, env_variables, is_active, last_synced_at, created_at, updated_at)
     VALUES (@id, @name, @description, @project_id, @github_repo_url, @github_repo_name, @github_branch, @workspace_id, @type, @path_patterns, @execution_order, @dependencies, @env_variables, @is_active, @last_synced_at, @created_at, @updated_at)`
  );

  // ==================== MIGRATE TASKS ====================
  // SQLite schema: id, title, description, user_id, project_id, repository_ids, status, priority, orchestration, attachments, tags, logs, activities, webhook_metadata, completed_at, created_at, updated_at
  await migrateCollection(
    'tasks',
    'tasks',
    (doc) => ({
      id: toId(doc._id),
      title: doc.title || 'Untitled Task',
      description: doc.description || '',
      user_id: toId(doc.userId || doc.user),
      project_id: doc.projectId ? toId(doc.projectId) : null,
      repository_ids: toJSON(doc.repositoryIds || doc.repositories || []),
      status: doc.status || 'pending',
      priority: doc.priority || 'medium',
      orchestration: toJSON(doc.orchestration),
      attachments: toJSON(doc.attachments || []),
      tags: toJSON(doc.tags || []),
      logs: toJSON(doc.logs || []),
      activities: toJSON(doc.activities || []),
      webhook_metadata: toJSON(doc.webhookMetadata || {}),
      completed_at: doc.completedAt ? toISOString(doc.completedAt) : null,
      created_at: toISOString(doc.createdAt),
      updated_at: toISOString(doc.updatedAt || doc.createdAt),
    }),
    `INSERT OR IGNORE INTO tasks (id, title, description, user_id, project_id, repository_ids, status, priority, orchestration, attachments, tags, logs, activities, webhook_metadata, completed_at, created_at, updated_at)
     VALUES (@id, @title, @description, @user_id, @project_id, @repository_ids, @status, @priority, @orchestration, @attachments, @tags, @logs, @activities, @webhook_metadata, @completed_at, @created_at, @updated_at)`
  );

  // ==================== MIGRATE EVENTS ====================
  // SQLite schema: id, task_id, event_type, agent_name, payload, sequence_number, created_at
  await migrateCollection(
    'events',
    'events',
    (doc) => ({
      id: toId(doc._id),
      task_id: toId(doc.taskId || doc.task),
      event_type: doc.eventType || doc.type || 'unknown',
      agent_name: doc.agentName || doc.agent || null,
      payload: toJSON(doc.payload || doc.data),
      sequence_number: doc.sequenceNumber || doc.sequence || 0,
      created_at: toISOString(doc.createdAt || doc.timestamp),
    }),
    `INSERT OR IGNORE INTO events (id, task_id, event_type, agent_name, payload, sequence_number, created_at)
     VALUES (@id, @task_id, @event_type, @agent_name, @payload, @sequence_number, @created_at)`
  );

  // ==================== MIGRATE CONSOLE LOGS ====================
  // SQLite schema: id, task_id, level, message, metadata, created_at
  await migrateCollection(
    'consolelogs',
    'console_logs',
    (doc) => ({
      id: toId(doc._id),
      task_id: toId(doc.taskId || doc.task),
      level: doc.level || 'info',
      message: doc.message || '',
      metadata: toJSON(doc.metadata),
      created_at: toISOString(doc.createdAt || doc.timestamp),
    }),
    `INSERT OR IGNORE INTO console_logs (id, task_id, level, message, metadata, created_at)
     VALUES (@id, @task_id, @level, @message, @metadata, @created_at)`
  );

  // ==================== MIGRATE MEMORIES ====================
  // SQLite schema: id, project_id, type, importance, title, content, context, embedding, embedding_model, source, access_count, last_accessed_at, usefulness, expires_at, archived, created_at, updated_at
  await migrateCollection(
    'granularmemories',
    'memories',
    (doc) => ({
      id: toId(doc._id),
      project_id: toId(doc.projectId || doc.project || ''),
      type: doc.type || 'decision',
      importance: doc.importance || 'medium',
      title: doc.key || doc.title || 'Memory',
      content: doc.content || '',
      context: toJSON(doc.context || doc.metadata),
      embedding: null,
      embedding_model: null,
      source: doc.agent || doc.phase || null,
      access_count: 0,
      last_accessed_at: null,
      usefulness: 0.5,
      expires_at: null,
      archived: doc.isConsumed ? 1 : 0,
      created_at: toISOString(doc.createdAt),
      updated_at: toISOString(doc.updatedAt || doc.createdAt),
    }),
    `INSERT OR IGNORE INTO memories (id, project_id, type, importance, title, content, context, embedding, embedding_model, source, access_count, last_accessed_at, usefulness, expires_at, archived, created_at, updated_at)
     VALUES (@id, @project_id, @type, @importance, @title, @content, @context, @embedding, @embedding_model, @source, @access_count, @last_accessed_at, @usefulness, @expires_at, @archived, @created_at, @updated_at)`
  );

  // Re-enable foreign key constraints
  sqlite.pragma('foreign_keys = ON');
  console.log('\n✅ Foreign key constraints re-enabled');

  // Close connections
  console.log('🔒 Closing connections...');
  await mongoClient.close();
  closeDb();

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 MIGRATION SUMMARY');
  console.log('='.repeat(60));

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const [table, stat] of Object.entries(stats)) {
    console.log(`   ${table}: ${stat.migrated} migrated, ${stat.skipped} skipped, ${stat.errors} errors`);
    totalMigrated += stat.migrated;
    totalSkipped += stat.skipped;
    totalErrors += stat.errors;
  }

  console.log('='.repeat(60));
  console.log(`   TOTAL: ${totalMigrated} migrated, ${totalSkipped} skipped, ${totalErrors} errors`);
  console.log('='.repeat(60));

  if (totalErrors === 0) {
    console.log('\n✅ Migration completed successfully!');
    console.log('   You can now safely remove MONGODB_URI from your .env file.');
  } else {
    console.log('\n⚠️  Migration completed with some errors. Please review above.');
  }
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
