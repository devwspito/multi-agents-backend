/**
 * Project Network Repository
 *
 * Database operations for persisting Docker network state for multi-service projects.
 * Networks enable communication between frontend and backend sandboxes.
 */

import db from '../index.js';
import { generateId, now, parseJSON, toJSON } from '../utils.js';

export interface IProjectNetwork {
  id: string;
  projectId: string;
  networkId: string;
  networkName: string;
  status: 'active' | 'cleaning' | 'removed';
  connectedContainers: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectNetworkRow {
  id: string;
  project_id: string;
  network_id: string;
  network_name: string;
  status: string;
  connected_containers: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProjectNetwork(row: ProjectNetworkRow): IProjectNetwork {
  return {
    id: row.id,
    projectId: row.project_id,
    networkId: row.network_id,
    networkName: row.network_name,
    status: row.status as 'active' | 'cleaning' | 'removed',
    connectedContainers: parseJSON(row.connected_containers, []),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class ProjectNetworkRepository {
  /**
   * Find network by project ID
   */
  static findByProjectId(projectId: string): IProjectNetwork | null {
    const stmt = db.prepare(`SELECT * FROM project_networks WHERE project_id = ?`);
    const row = stmt.get(projectId) as ProjectNetworkRow | undefined;
    if (!row) return null;
    return rowToProjectNetwork(row);
  }

  /**
   * Find all active networks
   */
  static findAllActive(): IProjectNetwork[] {
    const stmt = db.prepare(`SELECT * FROM project_networks WHERE status = 'active'`);
    const rows = stmt.all() as ProjectNetworkRow[];
    return rows.map(rowToProjectNetwork);
  }

  /**
   * Find all networks (for cleanup and recovery)
   */
  static findAll(): IProjectNetwork[] {
    const stmt = db.prepare(`SELECT * FROM project_networks`);
    const rows = stmt.all() as ProjectNetworkRow[];
    return rows.map(rowToProjectNetwork);
  }

  /**
   * Create or update project network
   */
  static upsert(data: {
    projectId: string;
    networkId: string;
    networkName: string;
    status?: 'active' | 'cleaning' | 'removed';
    connectedContainers?: string[];
  }): IProjectNetwork {
    const existing = this.findByProjectId(data.projectId);

    if (existing) {
      return this.update(existing.id, data)!;
    }

    const id = generateId();
    const timestamp = now();

    const stmt = db.prepare(`
      INSERT INTO project_networks (
        id, project_id, network_id, network_name,
        status, connected_containers, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.projectId,
      data.networkId,
      data.networkName,
      data.status || 'active',
      toJSON(data.connectedContainers || []),
      timestamp,
      timestamp
    );

    return this.findByProjectId(data.projectId)!;
  }

  /**
   * Update project network
   */
  static update(id: string, data: Partial<{
    networkId: string;
    networkName: string;
    status: 'active' | 'cleaning' | 'removed';
    connectedContainers: string[];
  }>): IProjectNetwork | null {
    const stmt = db.prepare(`
      UPDATE project_networks SET
        network_id = COALESCE(?, network_id),
        network_name = COALESCE(?, network_name),
        status = COALESCE(?, status),
        connected_containers = COALESCE(?, connected_containers),
        updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      data.networkId || null,
      data.networkName || null,
      data.status || null,
      data.connectedContainers ? toJSON(data.connectedContainers) : null,
      now(),
      id
    );

    const stmt2 = db.prepare(`SELECT * FROM project_networks WHERE id = ?`);
    const row = stmt2.get(id) as ProjectNetworkRow | undefined;
    return row ? rowToProjectNetwork(row) : null;
  }

  /**
   * Add container to connected containers list
   */
  static addConnectedContainer(projectId: string, containerId: string): void {
    const network = this.findByProjectId(projectId);
    if (!network) return;

    const containers = [...network.connectedContainers];
    if (!containers.includes(containerId)) {
      containers.push(containerId);
      this.update(network.id, { connectedContainers: containers });
    }
  }

  /**
   * Remove container from connected containers list
   */
  static removeConnectedContainer(projectId: string, containerId: string): void {
    const network = this.findByProjectId(projectId);
    if (!network) return;

    const containers = network.connectedContainers.filter(c => c !== containerId);
    this.update(network.id, { connectedContainers: containers });
  }

  /**
   * Delete project network record
   */
  static delete(projectId: string): boolean {
    const stmt = db.prepare(`DELETE FROM project_networks WHERE project_id = ?`);
    const result = stmt.run(projectId);
    return result.changes > 0;
  }

  /**
   * Delete all networks (for full cleanup)
   */
  static deleteAll(): number {
    const stmt = db.prepare(`DELETE FROM project_networks`);
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Count active networks
   */
  static countActive(): number {
    const stmt = db.prepare(`SELECT COUNT(*) as count FROM project_networks WHERE status = 'active'`);
    const row = stmt.get() as { count: number };
    return row.count;
  }
}

export default ProjectNetworkRepository;
