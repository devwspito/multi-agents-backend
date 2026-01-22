/**
 * SQLite Database Connection and Schema
 *
 * Replaces MongoDB with SQLite for single-tenant deployment
 * Uses better-sqlite3 for synchronous operations
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Database path - stored in project data directory
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'app.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create database connection
const db: DatabaseType = new Database(DB_PATH);

// Enable foreign keys and WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/**
 * Initialize database schema
 * Creates all tables if they don't exist
 */
export function initializeDatabase(): void {
  // ============================================
  // USERS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      email TEXT NOT NULL,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_expiry TEXT,
      default_api_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);

  // ============================================
  // PROJECTS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'web-app',
      status TEXT DEFAULT 'planning',
      user_id TEXT NOT NULL,
      api_key TEXT,
      webhook_api_key TEXT UNIQUE,
      dev_auth TEXT,
      settings TEXT,
      stats TEXT,
      token_stats TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_webhook_api_key ON projects(webhook_api_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_is_active ON projects(is_active)`);

  // ============================================
  // REPOSITORIES TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      project_id TEXT NOT NULL,
      github_repo_url TEXT NOT NULL,
      github_repo_name TEXT NOT NULL,
      github_branch TEXT DEFAULT 'main',
      workspace_id TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      path_patterns TEXT,
      execution_order INTEGER,
      dependencies TEXT,
      env_variables TEXT,
      is_active INTEGER DEFAULT 1,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repositories_project_id ON repositories(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_repositories_workspace_id ON repositories(workspace_id)`);

  // ============================================
  // TASKS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      user_id TEXT NOT NULL,
      project_id TEXT,
      repository_ids TEXT,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      orchestration TEXT,
      attachments TEXT,
      tags TEXT,
      logs TEXT,
      activities TEXT,
      webhook_metadata TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)`);

  // ============================================
  // API KEYS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_prefix TEXT NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scopes TEXT DEFAULT '["read"]',
      requests_per_hour INTEGER DEFAULT 1000,
      requests_per_day INTEGER DEFAULT 10000,
      current_hour_requests INTEGER DEFAULT 0,
      current_day_requests INTEGER DEFAULT 0,
      hour_reset_at TEXT,
      day_reset_at TEXT,
      expires_at TEXT,
      last_used_at TEXT,
      total_requests INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id)`);

  // ============================================
  // OAUTH STATES TABLE (temporary storage)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      id TEXT PRIMARY KEY,
      state TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_states_state ON oauth_states(state)`);

  // ============================================
  // CONSOLE LOGS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'log',
      message TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_console_logs_task_id ON console_logs(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_console_logs_timestamp ON console_logs(timestamp)`);

  // ============================================
  // TASK LOGS TABLE (structured logs)
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      phase TEXT,
      agent_type TEXT,
      agent_instance_id TEXT,
      epic_id TEXT,
      epic_name TEXT,
      story_id TEXT,
      story_title TEXT,
      metadata TEXT,
      error_message TEXT,
      error_stack TEXT,
      error_code TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs_level ON task_logs(level)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs_category ON task_logs(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_task_logs_timestamp ON task_logs(timestamp)`);

  // ============================================
  // CONVERSATIONS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      task_id TEXT UNIQUE NOT NULL,
      user_id TEXT NOT NULL,
      messages TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_task_id ON conversations(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)`);

  // ============================================
  // MEMORIES TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      importance TEXT DEFAULT 'medium',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      context TEXT,
      embedding TEXT,
      embedding_model TEXT,
      source TEXT,
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT,
      usefulness REAL DEFAULT 0.5,
      expires_at TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived)`);

  // ============================================
  // EVENTS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      version INTEGER NOT NULL,
      user_id TEXT,
      agent_name TEXT,
      metadata TEXT,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_task_version ON events(task_id, version)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_task_id ON events(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)`);

  // ============================================
  // CODE SNAPSHOTS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      phase TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      epic_id TEXT,
      epic_name TEXT,
      story_id TEXT,
      story_title TEXT,
      repository_name TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      commit_hash TEXT,
      commit_message TEXT,
      file_changes TEXT,
      total_files_changed INTEGER DEFAULT 0,
      total_lines_added INTEGER DEFAULT 0,
      total_lines_deleted INTEGER DEFAULT 0,
      session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_snapshots_task_id ON code_snapshots(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_code_snapshots_timestamp ON code_snapshots(timestamp)`);

  // ============================================
  // EXECUTION CHECKPOINTS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_checkpoints (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT,
      agent_type TEXT NOT NULL,
      agent_name TEXT,
      phase_name TEXT,
      status TEXT DEFAULT 'active',
      workspace_path TEXT NOT NULL,
      model_id TEXT NOT NULL,
      turns_completed INTEGER DEFAULT 0,
      messages_received INTEGER DEFAULT 0,
      last_turn_at TEXT NOT NULL DEFAULT (datetime('now')),
      original_prompt TEXT NOT NULL,
      context_snapshot TEXT,
      git_state TEXT,
      files_modified TEXT DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_checkpoint_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_checkpoints_task_id ON execution_checkpoints(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_execution_checkpoints_status ON execution_checkpoints(status)`);

  // ============================================
  // FAILED EXECUTIONS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS failed_executions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT,
      agent_type TEXT NOT NULL,
      agent_name TEXT,
      phase_name TEXT,
      prompt TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      model_id TEXT NOT NULL,
      permission_mode TEXT DEFAULT 'bypassPermissions',
      failure_type TEXT NOT NULL,
      error_message TEXT NOT NULL,
      error_stack TEXT,
      messages_received INTEGER DEFAULT 0,
      history_messages INTEGER DEFAULT 0,
      turns_completed INTEGER DEFAULT 0,
      last_message_types TEXT DEFAULT '[]',
      stream_duration_ms INTEGER DEFAULT 0,
      retry_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 3,
      next_retry_at TEXT,
      last_retry_at TEXT,
      retry_history TEXT DEFAULT '[]',
      context_snapshot TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_executions_task_id ON failed_executions(task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_executions_retry_status ON failed_executions(retry_status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_failed_executions_failure_type ON failed_executions(failure_type)`);

  // ============================================
  // WEBHOOK API KEYS TABLE
  // ============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_api_keys (
      id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      rate_limit INTEGER DEFAULT 60,
      task_config TEXT DEFAULT 'standard',
      last_used_at TEXT,
      request_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_api_keys_api_key ON webhook_api_keys(api_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_webhook_api_keys_project_id ON webhook_api_keys(project_id)`);

  console.log('[SQLite] Database initialized at:', DB_PATH);
}

/**
 * Clean up expired OAuth states (older than 10 minutes)
 */
export function cleanupExpiredOAuthStates(): void {
  const stmt = db.prepare(`
    DELETE FROM oauth_states
    WHERE datetime(created_at) < datetime('now', '-10 minutes')
  `);
  stmt.run();
}

/**
 * Close database connection gracefully
 */
export function closeDatabase(): void {
  db.close();
  console.log('[SQLite] Database connection closed');
}

/**
 * Get database instance (for queries)
 */
export function getDb(): DatabaseType {
  return db;
}

// Aliases for compatibility
export const initDb = initializeDatabase;
export const closeDb = closeDatabase;

// Export database instance
export { db };
export type { DatabaseType };
export default db;
