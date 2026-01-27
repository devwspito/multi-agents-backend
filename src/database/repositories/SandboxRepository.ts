/**
 * Sandbox Repository
 *
 * Database operations for persistent sandbox storage.
 * Sandboxes survive backend restarts and are NEVER auto-destroyed.
 * Only manual destruction from UI is allowed.
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';
import type { SandboxConfig, SandboxInstance } from '../../services/SandboxService.js';

interface SandboxRow {
  id: string;
  task_id: string;
  container_id: string;
  container_name: string;
  image: string;
  workspace_path: string;
  status: string;
  config: string;
  mapped_ports: string | null;
  repo_name: string | null;
  sandbox_type: string | null;
  created_at: string;
  updated_at: string;
}

function rowToSandboxInstance(row: SandboxRow): SandboxInstance {
  return {
    taskId: row.task_id,
    containerId: row.container_id,
    containerName: row.container_name,
    image: row.image,
    workspacePath: row.workspace_path,
    status: row.status as 'creating' | 'running' | 'stopped' | 'error',
    config: parseJSON<SandboxConfig>(row.config, {
      image: row.image,
      memoryLimit: '4g',
      cpuLimit: '2',
      networkMode: 'host',
      workDir: '/workspace',
    }),
    mappedPorts: row.mapped_ports ? parseJSON<Record<string, string>>(row.mapped_ports, {}) : undefined,
    repoName: row.repo_name || undefined,
    sandboxType: row.sandbox_type as 'frontend' | 'backend' | 'fullstack' | undefined,
    createdAt: new Date(row.created_at),
  };
}

export class SandboxRepository {
  /**
   * Save or update a sandbox instance
   */
  static upsert(instance: SandboxInstance): void {
    const existing = this.findByTaskId(instance.taskId);
    const timestamp = now();

    if (existing) {
      // Update existing
      const stmt = db.prepare(`
        UPDATE sandboxes SET
          container_id = ?,
          container_name = ?,
          image = ?,
          workspace_path = ?,
          status = ?,
          config = ?,
          mapped_ports = ?,
          repo_name = ?,
          sandbox_type = ?,
          updated_at = ?
        WHERE task_id = ?
      `);

      stmt.run(
        instance.containerId,
        instance.containerName,
        instance.image,
        instance.workspacePath,
        instance.status,
        toJSON(instance.config),
        instance.mappedPorts ? toJSON(instance.mappedPorts) : null,
        instance.repoName || null,
        instance.sandboxType || null,
        timestamp,
        instance.taskId
      );

      console.log(`[SandboxRepository] Updated sandbox for task ${instance.taskId}`);
    } else {
      // Insert new
      const id = generateId();
      const stmt = db.prepare(`
        INSERT INTO sandboxes (
          id, task_id, container_id, container_name, image, workspace_path,
          status, config, mapped_ports, repo_name, sandbox_type, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        instance.taskId,
        instance.containerId,
        instance.containerName,
        instance.image,
        instance.workspacePath,
        instance.status,
        toJSON(instance.config),
        instance.mappedPorts ? toJSON(instance.mappedPorts) : null,
        instance.repoName || null,
        instance.sandboxType || null,
        timestamp,
        timestamp
      );

      console.log(`[SandboxRepository] Saved new sandbox for task ${instance.taskId}`);
    }
  }

  /**
   * Find sandbox by task ID
   */
  static findByTaskId(taskId: string): SandboxInstance | null {
    const stmt = db.prepare(`SELECT * FROM sandboxes WHERE task_id = ?`);
    const row = stmt.get(taskId) as SandboxRow | undefined;
    return row ? rowToSandboxInstance(row) : null;
  }

  /**
   * Find sandbox by container name
   */
  static findByContainerName(containerName: string): SandboxInstance | null {
    const stmt = db.prepare(`SELECT * FROM sandboxes WHERE container_name = ?`);
    const row = stmt.get(containerName) as SandboxRow | undefined;
    return row ? rowToSandboxInstance(row) : null;
  }

  /**
   * Get all sandboxes with a specific status
   */
  static findByStatus(status: 'creating' | 'running' | 'stopped' | 'error'): SandboxInstance[] {
    const stmt = db.prepare(`SELECT * FROM sandboxes WHERE status = ?`);
    const rows = stmt.all(status) as SandboxRow[];
    return rows.map(rowToSandboxInstance);
  }

  /**
   * Get all sandboxes
   */
  static findAll(): SandboxInstance[] {
    const stmt = db.prepare(`SELECT * FROM sandboxes ORDER BY created_at DESC`);
    const rows = stmt.all() as SandboxRow[];
    return rows.map(rowToSandboxInstance);
  }

  /**
   * Update sandbox status
   */
  static updateStatus(taskId: string, status: 'creating' | 'running' | 'stopped' | 'error'): boolean {
    const stmt = db.prepare(`
      UPDATE sandboxes SET status = ?, updated_at = ? WHERE task_id = ?
    `);
    const result = stmt.run(status, now(), taskId);
    return result.changes > 0;
  }

  /**
   * Update mapped ports
   */
  static updateMappedPorts(taskId: string, mappedPorts: Record<string, string>): boolean {
    const stmt = db.prepare(`
      UPDATE sandboxes SET mapped_ports = ?, updated_at = ? WHERE task_id = ?
    `);
    const result = stmt.run(toJSON(mappedPorts), now(), taskId);
    return result.changes > 0;
  }

  /**
   * Delete sandbox by task ID
   */
  static deleteByTaskId(taskId: string): boolean {
    const stmt = db.prepare(`DELETE FROM sandboxes WHERE task_id = ?`);
    const result = stmt.run(taskId);
    console.log(`[SandboxRepository] Deleted sandbox for task ${taskId}: ${result.changes > 0}`);
    return result.changes > 0;
  }

  /**
   * Delete sandbox by container name
   */
  static deleteByContainerName(containerName: string): boolean {
    const stmt = db.prepare(`DELETE FROM sandboxes WHERE container_name = ?`);
    const result = stmt.run(containerName);
    return result.changes > 0;
  }

  /**
   * Count sandboxes by status
   */
  static countByStatus(status: string): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM sandboxes WHERE status = ?`);
    const row = stmt.get(status) as { count: number };
    return row.count;
  }

  /**
   * Count total sandboxes
   */
  static count(): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM sandboxes`);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Find sandboxes that might belong to a task (prefix match)
   * Used for finding setup sandboxes (taskId-setup-repoName)
   */
  static findByTaskIdPrefix(taskIdPrefix: string): SandboxInstance[] {
    const stmt = db.prepare(`SELECT * FROM sandboxes WHERE task_id LIKE ? || '%'`);
    const rows = stmt.all(taskIdPrefix) as SandboxRow[];
    return rows.map(rowToSandboxInstance);
  }
}

export default SandboxRepository;
