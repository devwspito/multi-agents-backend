/**
 * ProjectNetworkService - Multi-Service Docker Network Management
 *
 * This service manages Docker networks for projects that have both frontend and backend
 * repositories, enabling inter-service communication within the same project.
 *
 * Architecture:
 * ```
 * Project: app-pasos (has frontend + backend)
 * │
 * └── Docker Network: project-{projectId}-net
 *     ├── frontend-app-pasos-frontend (alias for frontend container)
 *     │   └── Can reach backend at: http://backend-app-pasos-backend:3001
 *     │
 *     └── backend-app-pasos-backend (alias for backend container)
 *         └── Can reach frontend at: http://frontend-app-pasos-frontend:3000
 * ```
 *
 * Usage:
 * - Called from OrchestrationCoordinator after sandbox is created
 * - Only activates for multi-service projects (has frontend AND backend repos)
 * - Single-service projects (only frontend OR only backend) are not affected
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import { ProjectNetworkRepository } from '../database/repositories/ProjectNetworkRepository.js';
import { IRepository } from '../database/repositories/RepositoryRepository.js';
import { SandboxInstance } from './SandboxService.js';

// ============================================================================
// Types
// ============================================================================

export interface MultiServiceInfo {
  isMultiService: boolean;
  frontendRepos: IRepository[];
  backendRepos: IRepository[];
  mobileRepos: IRepository[];
  sharedRepos: IRepository[];
}

export interface ContainerAlias {
  containerId: string;
  alias: string;
  repoType: string;
  repoName: string;
}

// ============================================================================
// ProjectNetworkService Class
// ============================================================================

class ProjectNetworkService extends EventEmitter {
  // In-memory cache of networks: projectId → networkName
  private networks: Map<string, string> = new Map();
  private isRestored: boolean = false;

  constructor() {
    super();
  }

  // --------------------------------------------------------------------------
  // Multi-Service Detection
  // --------------------------------------------------------------------------

  /**
   * Detect if a project is multi-service (has both frontend and backend)
   */
  detectMultiService(repositories: IRepository[]): MultiServiceInfo {
    const frontendRepos = repositories.filter(r => r.type === 'frontend');
    const backendRepos = repositories.filter(r => r.type === 'backend');
    const mobileRepos = repositories.filter(r => r.type === 'mobile');
    const sharedRepos = repositories.filter(r => r.type === 'shared');

    return {
      isMultiService: frontendRepos.length > 0 && backendRepos.length > 0,
      frontendRepos,
      backendRepos,
      mobileRepos,
      sharedRepos,
    };
  }

  // --------------------------------------------------------------------------
  // Network Management
  // --------------------------------------------------------------------------

  /**
   * Get deterministic network name for a project
   */
  getNetworkName(projectId: string): string {
    return `project-${projectId}-net`;
  }

  /**
   * Get container alias for a repository
   * Format: {type}-{repoName} e.g., "backend-app-pasos-backend"
   */
  getContainerAlias(repo: IRepository): string {
    return `${repo.type}-${repo.name || repo.githubRepoName}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-');
  }

  /**
   * Setup multi-service network if needed
   * Returns true if multi-service was set up, false otherwise
   */
  async setupIfNeeded(
    projectId: string,
    repositories: IRepository[],
    sandbox: SandboxInstance,
    currentRepo?: IRepository
  ): Promise<boolean> {
    const multiService = this.detectMultiService(repositories);

    if (!multiService.isMultiService) {
      return false;
    }

    console.log(`🌐 [ProjectNetwork] Multi-service detected for project ${projectId}`);
    console.log(`   Frontend repos: ${multiService.frontendRepos.map(r => r.name).join(', ')}`);
    console.log(`   Backend repos: ${multiService.backendRepos.map(r => r.name).join(', ')}`);

    // Ensure network exists
    const networkName = await this.ensureProjectNetwork(projectId);

    // Determine alias for current container
    const alias = currentRepo
      ? this.getContainerAlias(currentRepo)
      : `sandbox-${sandbox.containerId.slice(0, 8)}`;

    // Connect container to network
    await this.connectContainer(projectId, sandbox.containerId, alias);

    // Inject environment variables for service discovery
    await this.injectServiceDiscoveryEnvVars(
      sandbox.containerId,
      currentRepo?.type || 'unknown',
      multiService
    );

    this.emit('network:container-connected', {
      projectId,
      networkName,
      containerId: sandbox.containerId,
      alias,
    });

    return true;
  }

  /**
   * Create or get the Docker network for a project
   */
  async ensureProjectNetwork(projectId: string): Promise<string> {
    const networkName = this.getNetworkName(projectId);

    // Check in-memory cache first
    if (this.networks.has(projectId)) {
      return networkName;
    }

    // Check if network already exists in Docker
    try {
      const existing = execSync(
        `docker network inspect ${networkName} --format '{{.Id}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (existing) {
        this.networks.set(projectId, existing);

        // Persist to database
        ProjectNetworkRepository.upsert({
          projectId,
          networkId: existing,
          networkName,
          status: 'active',
        });

        console.log(`🌐 [ProjectNetwork] Using existing network: ${networkName}`);
        return networkName;
      }
    } catch {
      // Network doesn't exist, create it
    }

    // Create new network
    try {
      const networkId = execSync(
        `docker network create --driver bridge ${networkName}`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      this.networks.set(projectId, networkId);

      // Persist to database
      ProjectNetworkRepository.upsert({
        projectId,
        networkId,
        networkName,
        status: 'active',
      });

      console.log(`🌐 [ProjectNetwork] Created network: ${networkName} (${networkId.slice(0, 12)})`);
      this.emit('network:created', { projectId, networkName, networkId });

      return networkName;
    } catch (error: any) {
      console.error(`❌ [ProjectNetwork] Failed to create network ${networkName}:`, error.message);
      throw error;
    }
  }

  /**
   * Connect a container to the project network with an alias
   */
  async connectContainer(
    projectId: string,
    containerId: string,
    alias: string
  ): Promise<void> {
    const networkName = await this.ensureProjectNetwork(projectId);

    try {
      execSync(
        `docker network connect --alias ${alias} ${networkName} ${containerId}`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      // Update database
      ProjectNetworkRepository.addConnectedContainer(projectId, containerId);

      console.log(`🔗 [ProjectNetwork] Connected ${containerId.slice(0, 12)} to ${networkName} as "${alias}"`);
    } catch (error: any) {
      // Check if already connected
      if (error.message?.includes('already exists') || error.stderr?.includes('already exists')) {
        console.log(`🔗 [ProjectNetwork] Container ${containerId.slice(0, 12)} already connected to ${networkName}`);
        return;
      }
      console.error(`❌ [ProjectNetwork] Failed to connect container:`, error.message);
      throw error;
    }
  }

  /**
   * Disconnect a container from the project network
   */
  async disconnectContainer(projectId: string, containerId: string): Promise<void> {
    const networkName = this.getNetworkName(projectId);

    try {
      execSync(
        `docker network disconnect ${networkName} ${containerId}`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      // Update database
      ProjectNetworkRepository.removeConnectedContainer(projectId, containerId);

      console.log(`🔌 [ProjectNetwork] Disconnected ${containerId.slice(0, 12)} from ${networkName}`);
    } catch (error: any) {
      // Ignore if not connected
      if (!error.message?.includes('is not connected')) {
        console.warn(`⚠️ [ProjectNetwork] Error disconnecting container:`, error.message);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Service Discovery Environment Variables
  // --------------------------------------------------------------------------

  /**
   * Inject environment variables for service discovery
   */
  private async injectServiceDiscoveryEnvVars(
    containerId: string,
    repoType: string,
    multiService: MultiServiceInfo
  ): Promise<void> {
    const envVars: Record<string, string> = {};

    // If this is a frontend, provide backend URLs
    if (repoType === 'frontend' && multiService.backendRepos.length > 0) {
      const primaryBackend = multiService.backendRepos[0];
      const backendAlias = this.getContainerAlias(primaryBackend);

      envVars['BACKEND_URL'] = `http://${backendAlias}:3001`;
      envVars['API_URL'] = `http://${backendAlias}:3001/api`;
      envVars['BACKEND_HOST'] = backendAlias;
      envVars['BACKEND_PORT'] = '3001';
    }

    // If this is a backend, provide frontend URLs
    if (repoType === 'backend' && multiService.frontendRepos.length > 0) {
      const primaryFrontend = multiService.frontendRepos[0];
      const frontendAlias = this.getContainerAlias(primaryFrontend);

      envVars['FRONTEND_URL'] = `http://${frontendAlias}:3000`;
      envVars['CORS_ORIGIN'] = `http://${frontendAlias}:3000`;
    }

    // If this is mobile, also provide backend URLs
    if (repoType === 'mobile' && multiService.backendRepos.length > 0) {
      const primaryBackend = multiService.backendRepos[0];
      const backendAlias = this.getContainerAlias(primaryBackend);

      envVars['BACKEND_URL'] = `http://${backendAlias}:3001`;
      envVars['API_URL'] = `http://${backendAlias}:3001/api`;
    }

    // Inject env vars system-wide (agnostic - works for any language)
    if (Object.keys(envVars).length > 0) {
      try {
        // Build the injection script that handles missing files/directories
        const envLines = Object.entries(envVars)
          .map(([key, value]) => `${key}="${value}"`)
          .join('\\n');

        const exportLines = Object.entries(envVars)
          .map(([key, value]) => `export ${key}="${value}"`)
          .join('\\n');

        // Single robust script that:
        // 1. Creates /etc/environment if missing, appends vars
        // 2. Creates /root/.bashrc if missing, appends exports
        // 3. Creates /workspace if missing, writes .env file
        const script = `
          touch /etc/environment 2>/dev/null || true;
          echo -e "${envLines}" >> /etc/environment;
          touch /root/.bashrc 2>/dev/null || true;
          echo -e "# Multi-service discovery\\n${exportLines}" >> /root/.bashrc;
          mkdir -p /workspace 2>/dev/null || true;
          echo -e "${envLines}" > /workspace/.env.multi-service;
        `.replace(/\n/g, ' ');

        execSync(
          `docker exec ${containerId} bash -c '${script}'`,
          { encoding: 'utf-8', timeout: 10000 }
        );

        console.log(`📝 [ProjectNetwork] Injected service discovery env vars (system-wide):`);
        Object.entries(envVars).forEach(([key, value]) => {
          console.log(`   ${key}=${value}`);
        });
      } catch (error: any) {
        console.warn(`⚠️ [ProjectNetwork] Failed to inject env vars:`, error.message);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  /**
   * Remove project network (called when all sandboxes are destroyed)
   */
  async removeProjectNetwork(projectId: string): Promise<boolean> {
    const networkName = this.getNetworkName(projectId);

    try {
      execSync(
        `docker network rm ${networkName}`,
        { encoding: 'utf-8', timeout: 10000 }
      );

      this.networks.delete(projectId);
      ProjectNetworkRepository.delete(projectId);

      console.log(`🗑️ [ProjectNetwork] Removed network: ${networkName}`);
      this.emit('network:removed', { projectId, networkName });

      return true;
    } catch (error: any) {
      // Ignore if network doesn't exist
      if (error.message?.includes('No such network')) {
        this.networks.delete(projectId);
        ProjectNetworkRepository.delete(projectId);
        return true;
      }

      // Network has active endpoints - mark as cleaning
      if (error.message?.includes('has active endpoints')) {
        console.log(`⏳ [ProjectNetwork] Network ${networkName} has active containers, marking for cleanup`);
        const network = ProjectNetworkRepository.findByProjectId(projectId);
        if (network) {
          ProjectNetworkRepository.update(network.id, { status: 'cleaning' });
        }
        return false;
      }

      console.warn(`⚠️ [ProjectNetwork] Failed to remove network ${networkName}:`, error.message);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Recovery
  // --------------------------------------------------------------------------

  /**
   * Restore networks from database on server startup
   */
  async restoreFromDatabase(): Promise<void> {
    if (this.isRestored) {
      console.log('[ProjectNetwork] Already restored from database');
      return;
    }

    console.log('[ProjectNetwork] Restoring networks from SQLite...');

    try {
      const savedNetworks = ProjectNetworkRepository.findAllActive();
      console.log(`[ProjectNetwork] Found ${savedNetworks.length} saved networks in database`);

      for (const savedNetwork of savedNetworks) {
        // Verify the network still exists in Docker
        const exists = await this.verifyNetworkExists(savedNetwork.networkName);

        if (exists) {
          this.networks.set(savedNetwork.projectId, savedNetwork.networkId);
          console.log(`✅ [ProjectNetwork] Restored network: ${savedNetwork.networkName}`);
        } else {
          console.log(`⚠️ [ProjectNetwork] Network ${savedNetwork.networkName} not found, removing from database`);
          ProjectNetworkRepository.delete(savedNetwork.projectId);
        }
      }

      this.isRestored = true;
      console.log(`[ProjectNetwork] Restoration complete. ${this.networks.size} networks active`);
    } catch (error: any) {
      console.error('[ProjectNetwork] Error restoring from database:', error.message);
      this.isRestored = true;
    }
  }

  /**
   * Verify if a Docker network exists
   */
  private async verifyNetworkExists(networkName: string): Promise<boolean> {
    try {
      execSync(
        `docker network inspect ${networkName} --format '{{.Id}}'`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Status & Info
  // --------------------------------------------------------------------------

  /**
   * Get network status for a project
   */
  getNetworkStatus(projectId: string): {
    exists: boolean;
    networkName: string;
    connectedContainers: number;
  } | null {
    const network = ProjectNetworkRepository.findByProjectId(projectId);
    if (!network) {
      return null;
    }

    return {
      exists: this.networks.has(projectId),
      networkName: network.networkName,
      connectedContainers: network.connectedContainers.length,
    };
  }

  /**
   * Get all active networks
   */
  getAllNetworks(): Map<string, string> {
    return new Map(this.networks);
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalNetworks: number;
    activeInMemory: number;
    activeInDb: number;
  } {
    return {
      totalNetworks: this.networks.size,
      activeInMemory: this.networks.size,
      activeInDb: ProjectNetworkRepository.countActive(),
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const projectNetworkService = new ProjectNetworkService();
export default projectNetworkService;
