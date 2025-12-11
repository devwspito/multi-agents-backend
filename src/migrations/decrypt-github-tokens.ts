/**
 * Migration: Decrypt GitHub tokens
 *
 * This migration decrypts GitHub accessToken and refreshToken fields
 * that were previously encrypted. GitHub OAuth tokens don't need encryption
 * as GitHub handles security at token generation.
 *
 * Run with: npx tsx src/migrations/decrypt-github-tokens.ts
 */

import mongoose from 'mongoose';
import { CryptoService } from '../services/CryptoService';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function decryptGitHubTokens(): Promise<{ total: number; decrypted: number; errors: number }> {
  log('\n👤 Decrypting GitHub tokens in Users...', 'cyan');

  const { User } = await import('../models/User');

  // Get all users with accessToken and refreshToken
  const users = await User.find({}).select('+accessToken +refreshToken');
  log(`   Found ${users.length} users to check`);

  let decrypted = 0;
  let errors = 0;

  for (const user of users) {
    try {
      let changed = false;

      // Decrypt accessToken if encrypted
      if (user.accessToken && CryptoService.isEncrypted(user.accessToken)) {
        const decryptedToken = CryptoService.decrypt(user.accessToken);
        user.accessToken = decryptedToken;
        changed = true;
        log(`   🔓 Decrypting accessToken for: ${user.username}`, 'yellow');
      }

      // Decrypt refreshToken if encrypted
      if (user.refreshToken && CryptoService.isEncrypted(user.refreshToken)) {
        const decryptedToken = CryptoService.decrypt(user.refreshToken);
        user.refreshToken = decryptedToken;
        changed = true;
        log(`   🔓 Decrypting refreshToken for: ${user.username}`, 'yellow');
      }

      if (changed) {
        // Skip validation to avoid hooks
        await user.save({ validateBeforeSave: false });
        decrypted++;
        log(`   ✅ Decrypted tokens for user: ${user.username}`, 'green');
      }
    } catch (error: any) {
      errors++;
      log(`   ❌ Error decrypting tokens for ${user.username}: ${error.message}`, 'red');
    }
  }

  return { total: users.length, decrypted, errors };
}

async function main() {
  log('╔══════════════════════════════════════════════════════════╗', 'cyan');
  log('║     DECRYPT GITHUB TOKENS MIGRATION                      ║', 'cyan');
  log('║                                                          ║', 'cyan');
  log('║  GitHub tokens no longer need encryption.                ║', 'cyan');
  log('║  GitHub handles security at token generation.            ║', 'cyan');
  log('╚══════════════════════════════════════════════════════════╝', 'cyan');

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/orchestration';
  log(`\n📡 Connecting to MongoDB: ${mongoUri.split('@').pop()}...`, 'yellow');

  try {
    await mongoose.connect(mongoUri);
    log('✅ Connected to MongoDB\n', 'green');
  } catch (error: any) {
    log(`❌ Failed to connect to MongoDB: ${error.message}`, 'red');
    process.exit(1);
  }

  try {
    // Decrypt GitHub tokens
    const result = await decryptGitHubTokens();

    // Summary
    log('\n╔══════════════════════════════════════════════════════════╗', 'green');
    log('║                    MIGRATION COMPLETE                     ║', 'green');
    log('╠══════════════════════════════════════════════════════════╣', 'green');
    log(`║  Users checked:    ${result.total.toString().padStart(5)}                                ║`, 'green');
    log(`║  Users decrypted:  ${result.decrypted.toString().padStart(5)}                                ║`, 'green');
    log(`║  Errors:           ${result.errors.toString().padStart(5)}                                ║`, result.errors > 0 ? 'red' : 'green');
    log('╚══════════════════════════════════════════════════════════╝', 'green');

    if (result.errors > 0) {
      log('\n⚠️  Some users had errors. Check the logs above.', 'yellow');
    }
  } catch (error: any) {
    log(`\n❌ Migration failed: ${error.message}`, 'red');
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    log('\n📡 Disconnected from MongoDB', 'yellow');
  }
}

// Run migration
main().catch(console.error);
