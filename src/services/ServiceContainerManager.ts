/**
 * ServiceContainerManager
 *
 * Manages Docker containers for external services (MongoDB, Redis, PostgreSQL, etc.)
 * Spin up services automatically based on project dependencies.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { DetectedService } from './ServiceDetectionService.js';

const execAsync = promisify(exec);

export interface ServiceContainer {
  containerId: string;
  containerName: string;
  service: DetectedService;
  port: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: Date;
}

export interface ServiceContainerGroup {
  taskId: string;
  containers: ServiceContainer[];
  envVars: Record<string, string>;
}

// Port ranges for services (to avoid conflicts)
const SERVICE_PORT_RANGES: Record<string, { start: number; range: number }> = {
  mongodb: { start: 27100, range: 100 },      // 27100-27199
  redis: { start: 6400, range: 100 },         // 6400-6499
  postgresql: { start: 5500, range: 100 },    // 5500-5599
  mysql: { start: 3400, range: 100 },         // 3400-3499
  elasticsearch: { start: 9300, range: 100 }, // 9300-9399
  rabbitmq: { start: 5700, range: 100 },      // 5700-5799
};

// Track used ports to avoid conflicts
const usedPorts = new Map<number, string>(); // port -> taskId

class ServiceContainerManager {
  private containerGroups = new Map<string, ServiceContainerGroup>();

  /**
   * Start service containers for a task
   */
  async startServices(
    taskId: string,
    services: DetectedService[]
  ): Promise<ServiceContainerGroup> {
    console.log(`🐳 [ServiceContainerManager] Starting ${services.length} service(s) for task ${taskId.slice(0, 8)}...`);

    const containers: ServiceContainer[] = [];
    const envVars: Record<string, string> = {};

    for (const service of services) {
      try {
        const container = await this.startServiceContainer(taskId, service);
        containers.push(container);

        // Generate environment variables
        const uri = this.generateUri(service, container.port);
        envVars[service.envVar] = uri;

        // Add common aliases
        this.addEnvAliases(envVars, service, uri);

        console.log(`   ✅ ${service.type}: ${container.containerName} on port ${container.port}`);
      } catch (error: any) {
        console.error(`   ❌ ${service.type}: ${error.message}`);
        // Continue with other services
      }
    }

    const group: ServiceContainerGroup = {
      taskId,
      containers,
      envVars,
    };

    this.containerGroups.set(taskId, group);

    console.log(`🐳 [ServiceContainerManager] Started ${containers.length}/${services.length} services`);
    console.log(`   Environment variables: ${Object.keys(envVars).join(', ')}`);

    return group;
  }

  /**
   * Start a single service container
   */
  private async startServiceContainer(
    taskId: string,
    service: DetectedService
  ): Promise<ServiceContainer> {
    const port = this.allocatePort(taskId, service.type);
    const containerName = `svc-${service.type}-${taskId.slice(0, 12)}`;

    // Check if container already exists
    try {
      const { stdout: existingId } = await execAsync(
        `docker ps -aq -f name=${containerName}`
      );
      if (existingId.trim()) {
        // Remove existing container
        await execAsync(`docker rm -f ${containerName}`);
      }
    } catch {
      // Container doesn't exist, continue
    }

    // Build docker run command
    let dockerCmd = `docker run -d --name ${containerName}`;

    // Network mode - use host for simplicity on Linux
    const USE_BRIDGE_MODE = process.env.DOCKER_USE_BRIDGE_MODE === 'true';
    if (USE_BRIDGE_MODE) {
      dockerCmd += ` -p ${port}:${service.port}`;
    } else {
      dockerCmd += ` --network host`;
    }

    // Service-specific configuration
    switch (service.type) {
      case 'mongodb':
        if (!USE_BRIDGE_MODE) {
          dockerCmd += ` -e MONGO_PORT=${port}`;
          dockerCmd += ` ${service.image} mongod --port ${port}`;
        } else {
          dockerCmd += ` ${service.image}`;
        }
        break;

      case 'redis':
        if (!USE_BRIDGE_MODE) {
          dockerCmd += ` ${service.image} redis-server --port ${port}`;
        } else {
          dockerCmd += ` ${service.image}`;
        }
        break;

      case 'postgresql':
        dockerCmd += ` -e POSTGRES_USER=postgres`;
        dockerCmd += ` -e POSTGRES_PASSWORD=postgres`;
        dockerCmd += ` -e POSTGRES_DB=app`;
        if (!USE_BRIDGE_MODE) {
          // PostgreSQL: use -c port=X to set custom port
          dockerCmd += ` ${service.image} postgres -c port=${port}`;
        } else {
          dockerCmd += ` ${service.image}`;
        }
        break;

      case 'mysql':
        dockerCmd += ` -e MYSQL_ROOT_PASSWORD=root`;
        dockerCmd += ` -e MYSQL_DATABASE=app`;
        if (!USE_BRIDGE_MODE) {
          dockerCmd += ` ${service.image} --port=${port}`;
        } else {
          dockerCmd += ` ${service.image}`;
        }
        break;

      case 'elasticsearch':
        dockerCmd += ` -e "discovery.type=single-node"`;
        dockerCmd += ` -e "xpack.security.enabled=false"`;
        if (!USE_BRIDGE_MODE) {
          dockerCmd += ` -e "http.port=${port}"`;
        }
        dockerCmd += ` ${service.image}`;
        break;

      case 'rabbitmq':
        if (!USE_BRIDGE_MODE) {
          dockerCmd += ` -e RABBITMQ_NODE_PORT=${port}`;
        }
        dockerCmd += ` ${service.image}`;
        break;

      default:
        dockerCmd += ` ${service.image}`;
    }

    // Start container
    const { stdout } = await execAsync(dockerCmd);
    const containerId = stdout.trim().slice(0, 12);

    // Wait for service to be ready
    await this.waitForService(service.type, port, containerId);

    return {
      containerId,
      containerName,
      service,
      port: USE_BRIDGE_MODE ? service.port : port,
      status: 'running',
      startedAt: new Date(),
    };
  }

  /**
   * Wait for service to be ready
   */
  private async waitForService(
    type: string,
    port: number,
    containerId: string,
    maxWaitMs: number = 30000
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 1000;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Check if container is still running
        const { stdout: status } = await execAsync(
          `docker inspect -f '{{.State.Running}}' ${containerId}`
        );
        if (status.trim() !== 'true') {
          throw new Error('Container stopped');
        }

        // Service-specific health checks
        let healthy = false;
        switch (type) {
          case 'mongodb':
            try {
              await execAsync(`docker exec ${containerId} mongosh --port ${port} --eval "db.adminCommand('ping')"`);
              healthy = true;
            } catch {
              // Try legacy mongo shell
              try {
                await execAsync(`docker exec ${containerId} mongo --port ${port} --eval "db.adminCommand('ping')"`);
                healthy = true;
              } catch {
                // Not ready yet
              }
            }
            break;

          case 'redis':
            try {
              await execAsync(`docker exec ${containerId} redis-cli -p ${port} ping`);
              healthy = true;
            } catch {
              // Not ready yet
            }
            break;

          case 'postgresql':
            try {
              await execAsync(`docker exec ${containerId} pg_isready -p ${port}`);
              healthy = true;
            } catch {
              // Not ready yet
            }
            break;

          case 'mysql':
            try {
              await execAsync(`docker exec ${containerId} mysqladmin --port=${port} ping --password=root`);
              healthy = true;
            } catch {
              // Not ready yet
            }
            break;

          default:
            // Generic TCP check
            try {
              await execAsync(`nc -z localhost ${port}`);
              healthy = true;
            } catch {
              // Not ready yet
            }
        }

        if (healthy) {
          console.log(`   ⏱️ ${type} ready in ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Container not ready, continue waiting
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    // Timeout - but don't fail, service might still work
    console.warn(`   ⚠️ ${type} health check timeout after ${maxWaitMs}ms (continuing anyway)`);
  }

  /**
   * Allocate a unique port for a service
   */
  private allocatePort(taskId: string, serviceType: string): number {
    const range = SERVICE_PORT_RANGES[serviceType] || { start: 10000, range: 100 };

    for (let i = 0; i < range.range; i++) {
      const port = range.start + i;
      if (!usedPorts.has(port)) {
        usedPorts.set(port, taskId);
        return port;
      }
    }

    // Fallback - reuse port from same task
    for (const [port, tid] of usedPorts.entries()) {
      if (tid === taskId) {
        return port;
      }
    }

    // Emergency fallback
    return range.start;
  }

  /**
   * Generate connection URI for a service
   */
  private generateUri(service: DetectedService, port: number): string {
    switch (service.type) {
      case 'mongodb':
        return `mongodb://localhost:${port}/app`;
      case 'redis':
        return `redis://localhost:${port}`;
      case 'postgresql':
        return `postgresql://postgres:postgres@localhost:${port}/app`;
      case 'mysql':
        return `mysql://root:root@localhost:${port}/app`;
      case 'elasticsearch':
        return `http://localhost:${port}`;
      case 'rabbitmq':
        return `amqp://localhost:${port}`;
      default:
        return service.defaultUri.replace(`:${service.port}`, `:${port}`);
    }
  }

  /**
   * Add common environment variable aliases
   */
  private addEnvAliases(
    envVars: Record<string, string>,
    service: DetectedService,
    uri: string
  ): void {
    switch (service.type) {
      case 'mongodb':
        envVars['MONGO_URI'] = uri;
        envVars['MONGO_URL'] = uri;
        envVars['MONGODB_URL'] = uri;
        break;
      case 'redis':
        envVars['REDIS_URI'] = uri;
        break;
      case 'postgresql':
        envVars['POSTGRES_URL'] = uri;
        envVars['PG_CONNECTION_STRING'] = uri;
        envVars['PGHOST'] = 'localhost';
        envVars['PGPORT'] = uri.match(/:(\d+)\//)?.[1] || '5432';
        envVars['PGUSER'] = 'postgres';
        envVars['PGPASSWORD'] = 'postgres';
        envVars['PGDATABASE'] = 'app';
        break;
      case 'mysql':
        envVars['MYSQL_HOST'] = 'localhost';
        envVars['MYSQL_PORT'] = uri.match(/:(\d+)\//)?.[1] || '3306';
        envVars['MYSQL_USER'] = 'root';
        envVars['MYSQL_PASSWORD'] = 'root';
        envVars['MYSQL_DATABASE'] = 'app';
        break;
    }
  }

  /**
   * Stop and remove service containers for a task
   */
  async stopServices(taskId: string): Promise<void> {
    const group = this.containerGroups.get(taskId);
    if (!group) {
      return;
    }

    console.log(`🐳 [ServiceContainerManager] Stopping services for task ${taskId.slice(0, 8)}...`);

    for (const container of group.containers) {
      try {
        await execAsync(`docker rm -f ${container.containerName}`);
        console.log(`   ✅ Stopped ${container.service.type}`);

        // Release port
        for (const [port, tid] of usedPorts.entries()) {
          if (tid === taskId) {
            usedPorts.delete(port);
          }
        }
      } catch (error: any) {
        console.error(`   ❌ Failed to stop ${container.service.type}: ${error.message}`);
      }
    }

    this.containerGroups.delete(taskId);
  }

  /**
   * Get service containers for a task
   */
  getServices(taskId: string): ServiceContainerGroup | undefined {
    return this.containerGroups.get(taskId);
  }

  /**
   * Get environment variables for a task's services
   */
  getEnvVars(taskId: string): Record<string, string> {
    return this.containerGroups.get(taskId)?.envVars || {};
  }

  /**
   * Stop all service containers (cleanup on shutdown)
   */
  async stopAllServices(): Promise<void> {
    console.log(`🐳 [ServiceContainerManager] Stopping all service containers...`);

    const taskIds = Array.from(this.containerGroups.keys());
    for (const taskId of taskIds) {
      await this.stopServices(taskId);
    }
  }

  /**
   * Get container logs
   */
  async getContainerLogs(taskId: string, serviceType: string, lines: number = 50): Promise<string> {
    const group = this.containerGroups.get(taskId);
    if (!group) {
      return '';
    }

    const container = group.containers.find(c => c.service.type === serviceType);
    if (!container) {
      return '';
    }

    try {
      const { stdout } = await execAsync(
        `docker logs ${container.containerName} --tail ${lines} 2>&1`
      );
      return stdout;
    } catch {
      return '';
    }
  }
}

export const serviceContainerManager = new ServiceContainerManager();
export default serviceContainerManager;
