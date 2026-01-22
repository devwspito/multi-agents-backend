/**
 * Database Configuration
 *
 * SQLite database initialization (replaced MongoDB)
 */

import { initializeDatabase, closeDatabase } from '../database/index.js';

let isInitialized = false;

/**
 * Initialize SQLite database
 */
export async function connectDatabase(): Promise<void> {
  try {
    if (isInitialized) {
      console.log('✅ SQLite already initialized');
      return;
    }

    // Initialize SQLite database and create tables
    initializeDatabase();
    isInitialized = true;

    console.log('✅ SQLite database initialized successfully');

    // Handle graceful shutdown
    let sigintCount = 0;
    process.on('SIGINT', () => {
      sigintCount++;
      if (sigintCount >= 2) {
        // Second Ctrl+C = force shutdown
        console.log('\n🔌 Force shutdown - closing SQLite connection...');
        closeDatabase();
        console.log('🔌 SQLite connection closed');
        process.exit(0);
      } else {
        console.log('\n⚠️  Press Ctrl+C again to shutdown');
        // Reset count after 3 seconds
        setTimeout(() => { sigintCount = 0; }, 3000);
      }
    });
  } catch (error) {
    console.error('❌ Failed to initialize SQLite database:', error);
    process.exit(1);
  }
}

/**
 * Check if database is initialized
 */
export function isMongoConnected(): boolean {
  // For SQLite, we're always "connected" once initialized
  return isInitialized;
}

/**
 * Wait for database connection (immediate for SQLite)
 */
export async function waitForMongoConnection(_timeoutMs: number = 30000): Promise<boolean> {
  // SQLite is synchronous, so we're immediately ready
  return isInitialized;
}

/**
 * Disconnect database
 */
export async function disconnectDatabase(): Promise<void> {
  closeDatabase();
  isInitialized = false;
}
