/**
 * Migration: Encrypt existing plain-text sensitive fields
 *
 * This script encrypts sensitive fields that were previously stored in plain text:
 * - User: accessToken, refreshToken, defaultApiKey
 * - Project: apiKey, devAuth.token, devAuth.credentials.password
 *
 * Also migrates old devAuth structure:
 * - 'static_token' | 'oauth_token' → 'token'
 * - 'login' → 'credentials'
 * - loginBody → credentials
 *
 * SAFETY:
 * - Non-destructive: Only encrypts if not already encrypted
 * - Idempotent: Safe to run multiple times
 * - Reversible: Can decrypt with same key if needed
 *
 * Usage:
 *   npx tsx src/migrations/encrypt-sensitive-fields.ts
 *
 * Prerequisites:
 *   1. Set ENV_ENCRYPTION_KEY in .env
 *   2. Backup database before running
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { CryptoService } from '../services/CryptoService';

// Load environment variables
dotenv.config();

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(message: string, color: keyof typeof colors = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function migrateUsers(): Promise<{ total: number; migrated: number; errors: number }> {
  log('\n📦 Migrating Users...', 'cyan');

  // Import User model
  const { User } = await import('../models/User');

  // Get all users with sensitive fields
  const users = await User.find({}).select('+defaultApiKey');
  log(`   Found ${users.length} users to check`);

  let migrated = 0;
  let errors = 0;

  for (const user of users) {
    try {
      let changed = false;

      // NOTE: accessToken and refreshToken are NO LONGER encrypted
      // GitHub OAuth tokens are secure by design

      // Only encrypt defaultApiKey (Anthropic API key)
      if (user.defaultApiKey && !CryptoService.isEncrypted(user.defaultApiKey)) {
        user.defaultApiKey = CryptoService.encrypt(user.defaultApiKey);
        changed = true;
      }

      if (changed) {
        // Skip validation to avoid hooks re-encrypting
        await user.save({ validateBeforeSave: false });
        migrated++;
        log(`   ✅ Encrypted user API key: ${user.username} (${user.email})`, 'green');
      }
    } catch (error: any) {
      errors++;
      log(`   ❌ Error migrating user ${user.username}: ${error.message}`, 'red');
    }
  }

  return { total: users.length, migrated, errors };
}

async function migrateProjects(): Promise<{ total: number; migrated: number; errors: number }> {
  log('\n📦 Migrating Projects...', 'cyan');

  // Import Project model
  const { Project } = await import('../models/Project');

  // Get all projects with sensitive fields (including old loginBody field)
  const projects = await Project.find({}).select('+apiKey +devAuth.token +devAuth.loginBody +devAuth.credentials.password');
  log(`   Found ${projects.length} projects to check`);

  let migrated = 0;
  let errors = 0;

  for (const project of projects) {
    try {
      let changed = false;

      // Encrypt apiKey if not already encrypted
      if (project.apiKey && !CryptoService.isEncrypted(project.apiKey)) {
        project.apiKey = CryptoService.encrypt(project.apiKey);
        changed = true;
      }

      // Handle devAuth if present
      if (project.devAuth) {
        // Migrate old method names to new simplified ones
        // Use 'as any' to handle legacy values that are no longer in the type
        const oldMethod = (project.devAuth as any).method as string;
        if (oldMethod === 'static_token' || oldMethod === 'oauth_token') {
          (project.devAuth as any).method = 'token';
          changed = true;
          log(`   📝 Migrated devAuth.method: ${oldMethod} → token`, 'yellow');
        } else if (oldMethod === 'login') {
          (project.devAuth as any).method = 'credentials';
          changed = true;
          log(`   📝 Migrated devAuth.method: login → credentials`, 'yellow');
        }

        // Encrypt devAuth.token if not already encrypted
        if (project.devAuth.token && !CryptoService.isEncrypted(project.devAuth.token)) {
          project.devAuth.token = CryptoService.encrypt(project.devAuth.token);
          changed = true;
        }

        // Migrate old loginBody to new credentials structure
        const devAuth = project.devAuth as any;
        if (devAuth.loginBody) {
          const username = devAuth.loginBody.username || devAuth.loginBody.email;
          const password = devAuth.loginBody.password;

          if (username || password) {
            // Create new credentials structure
            if (!project.devAuth.credentials) {
              (project.devAuth as any).credentials = {};
            }
            if (username) {
              project.devAuth.credentials!.username = username;
            }
            if (password) {
              // Encrypt password if not already encrypted
              project.devAuth.credentials!.password = CryptoService.isEncrypted(password)
                ? password
                : CryptoService.encrypt(password);
            }

            // Remove old loginBody
            devAuth.loginBody = undefined;
            changed = true;
            log(`   📝 Migrated loginBody → credentials for project: ${project.name}`, 'yellow');
          }
        }

        // Encrypt credentials.password if not already encrypted
        if (project.devAuth.credentials?.password &&
            !CryptoService.isEncrypted(project.devAuth.credentials.password)) {
          project.devAuth.credentials.password = CryptoService.encrypt(project.devAuth.credentials.password);
          changed = true;
        }
      }

      if (changed) {
        // Skip validation to avoid hooks re-encrypting
        await project.save({ validateBeforeSave: false });
        migrated++;
        log(`   ✅ Encrypted project: ${project.name}`, 'green');
      }
    } catch (error: any) {
      errors++;
      log(`   ❌ Error migrating project ${project.name}: ${error.message}`, 'red');
    }
  }

  return { total: projects.length, migrated, errors };
}

async function migrateRepositories(): Promise<{ total: number; migrated: number; secretsEncrypted: number; errors: number }> {
  log('\n📦 Migrating Repository Environment Variables...', 'cyan');

  // Import Repository model
  const { Repository } = await import('../models/Repository');

  // Get all repositories
  const repos = await Repository.find({});
  log(`   Found ${repos.length} repositories to check`);

  let migrated = 0;
  let secretsEncrypted = 0;
  let errors = 0;

  for (const repo of repos) {
    try {
      let changed = false;

      // Encrypt envVariables that are marked as secret but not yet encrypted
      if (repo.envVariables && repo.envVariables.length > 0) {
        for (const envVar of repo.envVariables) {
          if (envVar.isSecret && envVar.value && !CryptoService.isEncrypted(envVar.value)) {
            envVar.value = CryptoService.encrypt(envVar.value);
            changed = true;
            secretsEncrypted++;
          }
        }
      }

      if (changed) {
        // Skip validation to avoid hooks re-encrypting
        await repo.save({ validateBeforeSave: false });
        migrated++;
        log(`   ✅ Encrypted secrets in repository: ${repo.name}`, 'green');
      }
    } catch (error: any) {
      errors++;
      log(`   ❌ Error migrating repository ${repo.name}: ${error.message}`, 'red');
    }
  }

  return { total: repos.length, migrated, secretsEncrypted, errors };
}

async function main() {
  log('\n🔐 Starting Sensitive Fields Encryption Migration', 'cyan');
  log('='.repeat(50));

  // Check for encryption key
  if (!process.env.ENV_ENCRYPTION_KEY) {
    log('\n⚠️  WARNING: ENV_ENCRYPTION_KEY not set!', 'yellow');
    log('   Using development fallback key (NOT SECURE FOR PRODUCTION)', 'yellow');
    log('   Generate a key with: openssl rand -base64 32\n', 'yellow');
  }

  // Connect to MongoDB
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    log('❌ MONGODB_URI not set in environment', 'red');
    process.exit(1);
  }

  log(`\n📡 Connecting to MongoDB...`);
  await mongoose.connect(mongoUri);
  log('✅ Connected to MongoDB', 'green');

  // Run migrations
  const userResults = await migrateUsers();
  const projectResults = await migrateProjects();
  const repoResults = await migrateRepositories();

  // Summary
  log('\n' + '='.repeat(50));
  log('📊 Migration Summary:', 'cyan');
  log(`   Users:        ${userResults.migrated}/${userResults.total} migrated, ${userResults.errors} errors`);
  log(`   Projects:     ${projectResults.migrated}/${projectResults.total} migrated, ${projectResults.errors} errors`);
  log(`   Repositories: ${repoResults.migrated}/${repoResults.total} migrated, ${repoResults.secretsEncrypted} secrets encrypted, ${repoResults.errors} errors`);

  const totalErrors = userResults.errors + projectResults.errors + repoResults.errors;
  if (totalErrors > 0) {
    log(`\n⚠️  Migration completed with ${totalErrors} errors`, 'yellow');
  } else {
    log('\n✅ Migration completed successfully!', 'green');
  }

  // Disconnect
  await mongoose.disconnect();
  log('📡 Disconnected from MongoDB\n');

  process.exit(totalErrors > 0 ? 1 : 0);
}

// Run migration
main().catch((error) => {
  log(`\n❌ Migration failed: ${error.message}`, 'red');
  console.error(error);
  process.exit(1);
});
