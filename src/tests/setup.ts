import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongoServer: MongoMemoryServer;

// Setup before all tests
beforeAll(async () => {
  // Create MongoDB Memory Server
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Connect to in-memory database
  await mongoose.connect(mongoUri);
  console.log('✅ Connected to in-memory MongoDB');
});

// Note: Individual test suites should handle their own cleanup in afterAll
// We don't clear collections between tests to preserve beforeAll data

// Cleanup after all tests
afterAll(async () => {
  // Disconnect from database
  await mongoose.disconnect();

  // Stop MongoDB Memory Server
  if (mongoServer) {
    await mongoServer.stop();
  }
  console.log('✅ Disconnected from in-memory MongoDB');
});

// Global test timeout
jest.setTimeout(30000);
