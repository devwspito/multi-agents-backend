/**
 * Recover Orphan Projects from MongoDB
 * Fixes projects that were not migrated but have tasks referencing them
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

// Orphan project IDs found in tasks table
const ORPHAN_PROJECT_IDS = [
  '68ebb925b74e685dd8050b9c',
  '68ecbb9646e1d888b503a5a2',
  '68f3b4674f033ad865cda782',
  '68f3b48b4f033ad865cda798',
];

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

async function recover() {
  console.log('🔍 Recovering orphan projects from MongoDB...\n');

  initDb();
  const sqlite = getDb();
  sqlite.pragma('foreign_keys = OFF');

  const mongoClient = new MongoClient(MONGODB_URI!, {
    serverSelectionTimeoutMS: 30000,
  });
  await mongoClient.connect();
  const mongoDb = mongoClient.db();
  console.log('✅ Connected to MongoDB\n');

  const projectsCollection = mongoDb.collection('projects');

  const insertProject = sqlite.prepare(`
    INSERT OR IGNORE INTO projects (id, name, description, type, status, user_id, api_key, webhook_api_key, dev_auth, settings, stats, token_stats, is_active, created_at, updated_at)
    VALUES (@id, @name, @description, @type, @status, @user_id, @api_key, @webhook_api_key, @dev_auth, @settings, @stats, @token_stats, @is_active, @created_at, @updated_at)
  `);

  let recovered = 0;
  let notFound = 0;

  for (const projectId of ORPHAN_PROJECT_IDS) {
    console.log(`📦 Looking for project: ${projectId}`);

    try {
      const doc = await projectsCollection.findOne({ _id: new ObjectId(projectId) });

      if (doc) {
        const transformed = {
          id: toId(doc._id),
          name: doc.name || 'Recovered Project',
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
        };

        insertProject.run(transformed);
        console.log(`   ✅ Recovered: ${doc.name || 'Unnamed'}`);
        recovered++;
      } else {
        console.log(`   ⚠️ Not found in MongoDB - may have been deleted`);
        notFound++;
      }
    } catch (err: any) {
      console.error(`   ❌ Error: ${err.message}`);
    }
  }

  sqlite.pragma('foreign_keys = ON');
  await mongoClient.close();
  closeDb();

  console.log('\n' + '='.repeat(50));
  console.log('📊 RECOVERY SUMMARY');
  console.log('='.repeat(50));
  console.log(`Recovered: ${recovered}`);
  console.log(`Not found: ${notFound}`);
  console.log('='.repeat(50));

  if (notFound > 0) {
    console.log('\n⚠️ Some projects were deleted from MongoDB before migration.');
    console.log('   Those tasks will remain orphaned (no project name will show).');
  }
}

recover().catch(err => {
  console.error('❌ Recovery failed:', err);
  process.exit(1);
});
