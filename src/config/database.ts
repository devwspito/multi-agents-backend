import mongoose from 'mongoose';
import { env } from './env';

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL = 5000; // 5 seconds

export async function connectDatabase(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 5,
      socketTimeoutMS: 45000,
      serverSelectionTimeoutMS: 10000,
    });

    console.log('✅ MongoDB connected successfully');
    reconnectAttempts = 0; // Reset on successful connection

    mongoose.connection.on('error', (error) => {
      console.error('❌ MongoDB connection error:', error);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️ MongoDB disconnected - attempting reconnect...');
      attemptReconnect();
    });

    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB reconnected successfully');
      reconnectAttempts = 0;
    });

    // Only close MongoDB on SIGINT if it's a real shutdown (not just Ctrl+C in terminal)
    let sigintCount = 0;
    process.on('SIGINT', async () => {
      sigintCount++;
      if (sigintCount >= 2) {
        // Second Ctrl+C = force shutdown
        console.log('\n🔌 Force shutdown - closing MongoDB connection...');
        await mongoose.connection.close();
        console.log('🔌 MongoDB connection closed');
        process.exit(0);
      } else {
        console.log('\n⚠️  Press Ctrl+C again to shutdown (MongoDB still connected)');
        // Reset count after 3 seconds
        setTimeout(() => { sigintCount = 0; }, 3000);
      }
    });
  } catch (error) {
    console.error('❌ Failed to connect to MongoDB:', error);
    process.exit(1);
  }
}

async function attemptReconnect(): Promise<void> {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`❌ MongoDB: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
    return;
  }

  reconnectAttempts++;
  console.log(`🔄 MongoDB reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);

  setTimeout(async () => {
    try {
      if (mongoose.connection.readyState === 0) { // disconnected
        await mongoose.connect(env.MONGODB_URI, {
          maxPoolSize: 10,
          minPoolSize: 5,
          socketTimeoutMS: 45000,
          serverSelectionTimeoutMS: 10000,
        });
      }
    } catch (error) {
      console.error(`❌ MongoDB reconnect attempt ${reconnectAttempts} failed:`, error);
      attemptReconnect(); // Try again
    }
  }, RECONNECT_INTERVAL);
}

/**
 * Check if MongoDB is connected
 */
export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Wait for MongoDB connection (with timeout)
 */
export async function waitForMongoConnection(timeoutMs: number = 30000): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (isMongoConnected()) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return false;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close();
}
