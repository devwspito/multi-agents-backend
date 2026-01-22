/**
 * Migrate Large Collections from MongoDB to SQLite
 * Handles tasks, events, and memories with batch processing
 */

import { MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not found');
  process.exit(1);
}

import { initDb, getDb, closeDb } from '../src/database/index';

// Helpers
function toId(val: any): string {
  if (!val) return '';
  if (val instanceof ObjectId) return val.toHexString();
  if (typeof val === 'object' && val?._id) return toId(val._id);
  if (typeof val === 'object' && val?.toString) return val.toString();
  return String(val || '');
}

function toISOString(val: any): string {
  if (!val) return new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') return val;
  return new Date().toISOString();
}

function toJSON(val: any): string {
  try {
    return JSON.stringify(val || {});
  } catch {
    return '{}';
  }
}

async function migrate() {
  console.log('🚀 Migrating large collections...\n');

  initDb();
  const sqlite = getDb();
  sqlite.pragma('foreign_keys = OFF');

  const mongoClient = new MongoClient(MONGODB_URI!, {
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 120000,
    connectTimeoutMS: 60000,
    maxPoolSize: 5,
  });
  await mongoClient.connect();
  const mongoDb = mongoClient.db();
  console.log('✅ Connected\n');

  const BATCH_SIZE = 20; // Smaller batches for large docs

  // ==================== TASKS ====================
  console.log('📦 Migrating tasks...');
  const tasksCollection = mongoDb.collection('tasks');
  const tasksCount = await tasksCollection.countDocuments();
  console.log(`   Total: ${tasksCount}`);

  const taskInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO tasks (id, title, description, user_id, project_id, repository_ids, status, priority, orchestration, attachments, tags, logs, activities, webhook_metadata, completed_at, created_at, updated_at)
    VALUES (@id, @title, @description, @user_id, @project_id, @repository_ids, @status, @priority, @orchestration, @attachments, @tags, @logs, @activities, @webhook_metadata, @completed_at, @created_at, @updated_at)
  `);

  let tasksMigrated = 0;
  let tasksSkipped = 0;

  for (let skip = 0; skip < tasksCount; skip += BATCH_SIZE) {
    let batch: any[];
    try {
      batch = await tasksCollection.find({}).skip(skip).limit(BATCH_SIZE).toArray();
    } catch (fetchErr: any) {
      console.error(`   ⚠️ Error fetching batch at ${skip}: ${fetchErr.message}`);
      continue;
    }

    for (const doc of batch) {
      try {
        const transformed = {
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
        };
        taskInsert.run(transformed);
        tasksMigrated++;
      } catch (err: any) {
        if (err.message?.includes('UNIQUE') || err.message?.includes('PRIMARY')) {
          tasksSkipped++;
        }
      }
    }
    console.log(`   Progress: ${Math.min(skip + BATCH_SIZE, tasksCount)}/${tasksCount}`);
  }
  console.log(`   ✅ Tasks: ${tasksMigrated} migrated, ${tasksSkipped} skipped\n`);

  // ==================== EVENTS ====================
  console.log('📦 Migrating events...');
  const eventsCollection = mongoDb.collection('events');
  const eventsCount = await eventsCollection.countDocuments();
  console.log(`   Total: ${eventsCount}`);

  const eventInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO events (id, task_id, event_type, agent_name, payload, sequence_number, created_at)
    VALUES (@id, @task_id, @event_type, @agent_name, @payload, @sequence_number, @created_at)
  `);

  let eventsMigrated = 0;
  let eventsSkipped = 0;

  for (let skip = 0; skip < eventsCount; skip += BATCH_SIZE) {
    const batch = await eventsCollection.find({}).skip(skip).limit(BATCH_SIZE).toArray();

    for (const doc of batch) {
      try {
        const transformed = {
          id: toId(doc._id),
          task_id: toId(doc.taskId || doc.task),
          event_type: doc.eventType || doc.type || 'unknown',
          agent_name: doc.agentName || doc.agent || null,
          payload: toJSON(doc.payload || doc.data),
          sequence_number: doc.sequenceNumber || doc.sequence || 0,
          created_at: toISOString(doc.createdAt || doc.timestamp),
        };
        eventInsert.run(transformed);
        eventsMigrated++;
      } catch (err: any) {
        if (err.message?.includes('UNIQUE') || err.message?.includes('PRIMARY')) {
          eventsSkipped++;
        }
      }
    }
    if ((skip + BATCH_SIZE) % 500 === 0 || skip + BATCH_SIZE >= eventsCount) {
      console.log(`   Progress: ${Math.min(skip + BATCH_SIZE, eventsCount)}/${eventsCount}`);
    }
  }
  console.log(`   ✅ Events: ${eventsMigrated} migrated, ${eventsSkipped} skipped\n`);

  // ==================== MEMORIES ====================
  console.log('📦 Migrating memories...');
  const memoriesCollection = mongoDb.collection('granularmemories');
  const memoriesCount = await memoriesCollection.countDocuments();
  console.log(`   Total: ${memoriesCount}`);

  const memoryInsert = sqlite.prepare(`
    INSERT OR IGNORE INTO memories (id, project_id, type, importance, title, content, context, embedding, embedding_model, source, access_count, last_accessed_at, usefulness, expires_at, archived, created_at, updated_at)
    VALUES (@id, @project_id, @type, @importance, @title, @content, @context, @embedding, @embedding_model, @source, @access_count, @last_accessed_at, @usefulness, @expires_at, @archived, @created_at, @updated_at)
  `);

  let memoriesMigrated = 0;
  let memoriesSkipped = 0;

  for (let skip = 0; skip < memoriesCount; skip += BATCH_SIZE) {
    const batch = await memoriesCollection.find({}).skip(skip).limit(BATCH_SIZE).toArray();

    for (const doc of batch) {
      try {
        const transformed = {
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
        };
        memoryInsert.run(transformed);
        memoriesMigrated++;
      } catch (err: any) {
        if (err.message?.includes('UNIQUE') || err.message?.includes('PRIMARY')) {
          memoriesSkipped++;
        }
      }
    }
    if ((skip + BATCH_SIZE) % 500 === 0 || skip + BATCH_SIZE >= memoriesCount) {
      console.log(`   Progress: ${Math.min(skip + BATCH_SIZE, memoriesCount)}/${memoriesCount}`);
    }
  }
  console.log(`   ✅ Memories: ${memoriesMigrated} migrated, ${memoriesSkipped} skipped\n`);

  // Cleanup
  sqlite.pragma('foreign_keys = ON');
  await mongoClient.close();
  closeDb();

  console.log('='.repeat(50));
  console.log('📊 SUMMARY');
  console.log('='.repeat(50));
  console.log(`Tasks: ${tasksMigrated} migrated, ${tasksSkipped} skipped`);
  console.log(`Events: ${eventsMigrated} migrated, ${eventsSkipped} skipped`);
  console.log(`Memories: ${memoriesMigrated} migrated, ${memoriesSkipped} skipped`);
  console.log('='.repeat(50));
  console.log('✅ Migration complete!');
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
