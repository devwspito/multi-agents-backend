#!/usr/bin/env npx ts-node

/**
 * Setup Vector Search Index for MongoDB Atlas
 *
 * This script creates the vector search index required for semantic memory search.
 * Run once after deploying to a new environment.
 *
 * Usage:
 *   npx ts-node scripts/setup-vector-index.ts
 *
 * Requirements:
 *   - MongoDB Atlas M10+ cluster (vector search not available on free tier)
 *   - MONGODB_URI environment variable set
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const VECTOR_INDEX_DEFINITION = {
  name: 'memory_vector_index',
  type: 'vectorSearch',
  definition: {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: 1536, // OpenAI and Voyage both use 1536
        similarity: 'cosine',
      },
      {
        type: 'filter',
        path: 'projectId',
      },
      {
        type: 'filter',
        path: 'archived',
      },
      {
        type: 'filter',
        path: 'type',
      },
      {
        type: 'filter',
        path: 'importance',
      },
    ],
  },
};

async function createVectorIndex() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error('❌ MONGODB_URI environment variable is not set');
    process.exit(1);
  }

  console.log('🔌 Connecting to MongoDB Atlas...');

  try {
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    if (!db) {
      throw new Error('Database connection not established');
    }

    // Ensure collection exists by inserting and removing a dummy document
    console.log('📦 Ensuring memories collection exists...');
    const collection = db.collection('memories');

    try {
      // Check if collection exists
      const collections = await db.listCollections({ name: 'memories' }).toArray();
      if (collections.length === 0) {
        console.log('   Creating memories collection...');
        await db.createCollection('memories');
        console.log('   ✅ Collection created');
      } else {
        console.log('   ✅ Collection already exists');
      }
    } catch (collError: any) {
      console.log('   ⚠️  Could not verify collection:', collError.message);
    }

    // Check if index already exists
    console.log('🔍 Checking for existing vector index...');

    try {
      const existingIndexes = await collection.listSearchIndexes().toArray();
      const existingVectorIndex = existingIndexes.find(
        (idx: any) => idx.name === 'memory_vector_index'
      );

      if (existingVectorIndex) {
        console.log('⚠️  Vector index already exists. Skipping creation.');
        console.log('   Index name:', existingVectorIndex.name);
        console.log('   Status:', existingVectorIndex.status);
        await mongoose.disconnect();
        return;
      }
    } catch (error: any) {
      // listSearchIndexes might not be available on all MongoDB versions
      console.log('⚠️  Could not check existing indexes:', error.message);
    }

    // Create the vector search index
    console.log('🚀 Creating vector search index...');
    console.log('   Index name:', VECTOR_INDEX_DEFINITION.name);
    console.log('   Dimensions:', 1536);
    console.log('   Similarity:', 'cosine');

    try {
      // Method 1: Using createSearchIndex (Atlas)
      await collection.createSearchIndex(VECTOR_INDEX_DEFINITION as any);
      console.log('✅ Vector search index created successfully!');
    } catch (error: any) {
      if (error.message?.includes('already exists')) {
        console.log('⚠️  Index already exists');
      } else if (error.message?.includes('not supported') || error.codeName === 'CommandNotSupported') {
        console.error('\n❌ Vector search is not supported on this MongoDB deployment.');
        console.error('   Vector search requires:');
        console.error('   - MongoDB Atlas M10+ cluster');
        console.error('   - MongoDB 6.0+ with Atlas Search enabled');
        console.error('\n   For local development, the memory system will use text search fallback.');
        console.error('   Semantic search will work once deployed to Atlas M10+.');
      } else {
        throw error;
      }
    }

    console.log('\n📋 Next steps:');
    console.log('   1. Set VOYAGE_API_KEY or OPENAI_API_KEY for embeddings');
    console.log('   2. The memory system will now use semantic search');
    console.log('   3. Agents can use remember/recall tools');

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

// Run the script
createVectorIndex();
