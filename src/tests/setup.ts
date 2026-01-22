/**
 * Test Setup - SQLite in-memory database for testing
 */

import { initDb, closeDb, getDb } from '../database/index';

// Setup before all tests
beforeAll(async () => {
  // Initialize SQLite database (uses file-based DB by default)
  initDb();
  console.log('✅ SQLite database initialized for tests');
});

// Cleanup after all tests
afterAll(async () => {
  // Close database connection
  closeDb();
  console.log('✅ SQLite database closed');
});

// Global test timeout
jest.setTimeout(30000);
