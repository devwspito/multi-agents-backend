/**
 * WorkspaceEnvironmentService
 *
 * Provides a REAL development environment for agents using Docker.
 * Creates isolated containers with all required services (MongoDB, Redis, etc.)
 *
 * Features:
 * - Auto-detect required services from package.json
 * - Generate docker-compose.yml dynamically
 * - Start/stop containers per task
 * - Provide connection URLs to developers
 * - Full cleanup on task completion
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';

// Service definitions for common dependencies
const SERVICE_DEFINITIONS: Record<string, DockerServiceConfig> = {
  mongodb: {
    image: 'mongo:6',
    port: 27017,
    healthCheck: 'mongosh --eval "db.adminCommand(\'ping\')"',
    envVar: 'DATABASE_URL',
    urlTemplate: 'mongodb://localhost:{port}/{dbName}',
  },
  redis: {
    image: 'redis:7-alpine',
    port: 6379,
    healthCheck: 'redis-cli ping',
    envVar: 'REDIS_URL',
    urlTemplate: 'redis://localhost:{port}',
  },
  postgres: {
    image: 'postgres:15-alpine',
    port: 5432,
    healthCheck: 'pg_isready -U postgres',
    envVar: 'DATABASE_URL',
    urlTemplate: 'postgresql://postgres:postgres@localhost:{port}/{dbName}',
    environment: {
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'postgres',
      POSTGRES_DB: 'devdb',
    },
  },
  mysql: {
    image: 'mysql:8',
    port: 3306,
    healthCheck: 'mysqladmin ping -h localhost',
    envVar: 'DATABASE_URL',
    urlTemplate: 'mysql://root:root@localhost:{port}/{dbName}',
    environment: {
      MYSQL_ROOT_PASSWORD: 'root',
      MYSQL_DATABASE: 'devdb',
    },
  },
  elasticsearch: {
    image: 'elasticsearch:8.11.0',
    port: 9200,
    healthCheck: 'curl -s http://localhost:9200/_cluster/health',
    envVar: 'ELASTICSEARCH_URL',
    urlTemplate: 'http://localhost:{port}',
    environment: {
      'discovery.type': 'single-node',
      'xpack.security.enabled': 'false',
    },
  },
};

// Supported project types
type ProjectType = 'nodejs' | 'python' | 'go' | 'rust' | 'java-maven' | 'java-gradle' | 'ruby' | 'php' | 'dotnet' | 'unknown';

// Project detection configuration
interface ProjectDetection {
  file: string;           // File that identifies this project type
  installCommand: string; // Command to install dependencies
  runCommand: string;     // Default command to run the project
  envFile: string;        // Environment file name
}

const PROJECT_DETECTIONS: Record<ProjectType, ProjectDetection> = {
  'nodejs': {
    file: 'package.json',
    installCommand: 'npm install',
    runCommand: 'npm run dev',
    envFile: '.env',
  },
  'python': {
    file: 'requirements.txt',
    installCommand: 'pip install -r requirements.txt',
    runCommand: 'python -m uvicorn main:app --reload', // FastAPI default
    envFile: '.env',
  },
  'go': {
    file: 'go.mod',
    installCommand: 'go mod download',
    runCommand: 'go run .',
    envFile: '.env',
  },
  'rust': {
    file: 'Cargo.toml',
    installCommand: 'cargo build',
    runCommand: 'cargo run',
    envFile: '.env',
  },
  'java-maven': {
    file: 'pom.xml',
    installCommand: 'mvn install -DskipTests',
    runCommand: 'mvn spring-boot:run',
    envFile: 'application.properties',
  },
  'java-gradle': {
    file: 'build.gradle',
    installCommand: 'gradle build -x test',
    runCommand: 'gradle bootRun',
    envFile: 'application.properties',
  },
  'ruby': {
    file: 'Gemfile',
    installCommand: 'bundle install',
    runCommand: 'bundle exec rails server',
    envFile: '.env',
  },
  'php': {
    file: 'composer.json',
    installCommand: 'composer install',
    runCommand: 'php artisan serve', // Laravel default
    envFile: '.env',
  },
  'dotnet': {
    file: '*.csproj',
    installCommand: 'dotnet restore',
    runCommand: 'dotnet run',
    envFile: 'appsettings.json',
  },
  'unknown': {
    file: '',
    installCommand: '',
    runCommand: '',
    envFile: '.env',
  },
};

// Dependency to service mapping - MULTI-LANGUAGE
const DEPENDENCY_TO_SERVICE: Record<string, string> = {
  // === JavaScript/TypeScript (package.json) ===
  // MongoDB
  'mongoose': 'mongodb',
  'mongodb': 'mongodb',
  'monk': 'mongodb',
  // Redis
  'redis': 'redis',
  'ioredis': 'redis',
  'bull': 'redis',
  'bullmq': 'redis',
  // PostgreSQL
  'pg': 'postgres',
  'postgres': 'postgres',
  'sequelize': 'postgres',
  'prisma': 'postgres',
  'typeorm': 'postgres',
  // MySQL
  'mysql': 'mysql',
  'mysql2': 'mysql',
  // Elasticsearch
  '@elastic/elasticsearch': 'elasticsearch',
  'elasticsearch': 'elasticsearch',

  // === Python (requirements.txt / pyproject.toml) ===
  'pymongo': 'mongodb',
  'motor': 'mongodb',
  'mongoengine': 'mongodb',
  'redis-py': 'redis',
  'aioredis': 'redis',
  'celery': 'redis',
  'psycopg2': 'postgres',
  'psycopg2-binary': 'postgres',
  'asyncpg': 'postgres',
  'sqlalchemy': 'postgres', // Default, could be others
  'django': 'postgres',     // Django commonly uses postgres
  'mysqlclient': 'mysql',
  'pymysql': 'mysql',
  'elasticsearch-py': 'elasticsearch',

  // === Go (go.mod) ===
  'go.mongodb.org/mongo-driver': 'mongodb',
  'github.com/go-redis/redis': 'redis',
  'github.com/redis/go-redis': 'redis',
  'github.com/lib/pq': 'postgres',
  'github.com/jackc/pgx': 'postgres',
  'gorm.io/driver/postgres': 'postgres',
  'github.com/go-sql-driver/mysql': 'mysql',
  'gorm.io/driver/mysql': 'mysql',
  'github.com/elastic/go-elasticsearch': 'elasticsearch',

  // === Java (pom.xml / build.gradle) ===
  'spring-boot-starter-data-mongodb': 'mongodb',
  'mongodb-driver': 'mongodb',
  'spring-boot-starter-data-redis': 'redis',
  'jedis': 'redis',
  'lettuce': 'redis',
  'spring-boot-starter-data-jpa': 'postgres',
  'postgresql': 'postgres',
  'mysql-connector-java': 'mysql',
  'spring-data-elasticsearch': 'elasticsearch',

  // === Ruby (Gemfile) ===
  'mongoid': 'mongodb',
  'mongo': 'mongodb',
  'sidekiq': 'redis',
  'resque': 'redis',
  'activerecord-postgresql-adapter': 'postgres',
  // 'mysql2' already mapped in JavaScript section
  'elasticsearch-ruby': 'elasticsearch',

  // === PHP (composer.json) ===
  'mongodb/mongodb': 'mongodb',
  'predis/predis': 'redis',
  'phpredis': 'redis',
  'doctrine/dbal': 'postgres',
  'laravel/framework': 'postgres', // Laravel commonly uses postgres
  'elasticsearch/elasticsearch': 'elasticsearch',
};

interface DockerServiceConfig {
  image: string;
  port: number;
  healthCheck: string;
  envVar: string;
  urlTemplate: string;
  environment?: Record<string, string>;
  volumes?: string[];
}

interface RunningContainer {
  name: string;
  containerId: string;
  port: number;
  service: string;
}

interface WorkspaceEnvironment {
  taskId: string;
  workspacePath: string;
  containers: RunningContainer[];
  ports: Map<string, number>;
  envUrls: Map<string, string>;
  dockerComposeFile?: string;
  ready: boolean;
}

class WorkspaceEnvironmentService {
  private environments: Map<string, WorkspaceEnvironment> = new Map();
  private basePort = 27000; // Start from high port to avoid conflicts
  private usedPorts: Set<number> = new Set();

  /**
   * Check if Docker is available
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      execSync('docker --version', { encoding: 'utf8', stdio: 'pipe' });
      execSync('docker compose version', { encoding: 'utf8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Setup complete development environment with Docker
   */
  async setupEnvironment(
    taskId: string,
    workspacePath: string,
    repositories: Array<{ name: string; type?: string; localPath?: string }>
  ): Promise<WorkspaceEnvironment> {
    console.log(`\n🐳 [WorkspaceEnv] Setting up Docker environment for task ${taskId}`);

    const env: WorkspaceEnvironment = {
      taskId,
      workspacePath,
      containers: [],
      ports: new Map(),
      envUrls: new Map(),
      ready: false,
    };

    // Check Docker availability
    const dockerAvailable = await this.isDockerAvailable();
    if (!dockerAvailable) {
      console.warn(`⚠️  [WorkspaceEnv] Docker not available - falling back to basic setup`);
      return this.setupBasicEnvironment(taskId, workspacePath, repositories);
    }

    try {
      // 1. Detect required services from all repositories
      const requiredServices = new Set<string>();
      for (const repo of repositories) {
        const repoPath = repo.localPath || path.join(workspacePath, repo.name);
        const services = this.detectRequiredServices(repoPath);
        services.forEach(s => requiredServices.add(s));
      }

      console.log(`   📋 [WorkspaceEnv] Detected services: ${Array.from(requiredServices).join(', ') || 'none'}`);

      // 2. Generate docker-compose.yml
      if (requiredServices.size > 0) {
        const composeFile = await this.generateDockerCompose(taskId, workspacePath, requiredServices);
        env.dockerComposeFile = composeFile;

        // 3. Start containers
        await this.startContainers(taskId, workspacePath, composeFile);

        // 4. Wait for services to be healthy
        await this.waitForServices(taskId, requiredServices);

        // 5. Get container info and ports
        const containerInfo = await this.getContainerInfo(taskId);
        env.containers = containerInfo;

        // 6. Generate environment URLs
        for (const service of requiredServices) {
          const config = SERVICE_DEFINITIONS[service];
          if (config) {
            const port = this.getAssignedPort(taskId, service);
            const url = config.urlTemplate
              .replace('{port}', String(port))
              .replace('{dbName}', `task_${taskId.slice(-8)}`);
            env.envUrls.set(config.envVar, url);
            env.ports.set(service, port);
          }
        }
      }

      // 7. Install dependencies and setup .env for each repo
      for (const repo of repositories) {
        const repoPath = repo.localPath || path.join(workspacePath, repo.name);
        await this.installDependencies(repoPath, repo.name);
        await this.setupEnvFile(repoPath, repo.name, repo.type, env.envUrls);
      }

      // 8. Assign ports for app services
      for (const repo of repositories) {
        const port = await this.findAvailablePort();
        env.ports.set(repo.name, port);
        console.log(`   📍 [WorkspaceEnv] Assigned app port ${port} to ${repo.name}`);
      }

      env.ready = true;
      this.environments.set(taskId, env);

      console.log(`✅ [WorkspaceEnv] Docker environment ready for task ${taskId}`);
      this.printEnvironmentSummary(env);

      return env;

    } catch (error: any) {
      console.error(`❌ [WorkspaceEnv] Failed to setup Docker environment: ${error.message}`);
      // Cleanup on failure
      await this.cleanup(taskId);
      throw error;
    }
  }

  /**
   * Fallback basic setup without Docker
   */
  private async setupBasicEnvironment(
    taskId: string,
    workspacePath: string,
    repositories: Array<{ name: string; type?: string; localPath?: string }>
  ): Promise<WorkspaceEnvironment> {
    const env: WorkspaceEnvironment = {
      taskId,
      workspacePath,
      containers: [],
      ports: new Map(),
      envUrls: new Map(),
      ready: false,
    };

    for (const repo of repositories) {
      const repoPath = repo.localPath || path.join(workspacePath, repo.name);
      await this.installDependencies(repoPath, repo.name);
      await this.setupEnvFile(repoPath, repo.name, repo.type, env.envUrls);

      const port = await this.findAvailablePort();
      env.ports.set(repo.name, port);
    }

    env.ready = true;
    this.environments.set(taskId, env);
    return env;
  }

  /**
   * Detect project type from files in repository
   */
  private detectProjectType(repoPath: string): ProjectType {
    // Check in priority order
    if (fs.existsSync(path.join(repoPath, 'package.json'))) return 'nodejs';
    if (fs.existsSync(path.join(repoPath, 'requirements.txt'))) return 'python';
    if (fs.existsSync(path.join(repoPath, 'pyproject.toml'))) return 'python';
    if (fs.existsSync(path.join(repoPath, 'go.mod'))) return 'go';
    if (fs.existsSync(path.join(repoPath, 'Cargo.toml'))) return 'rust';
    if (fs.existsSync(path.join(repoPath, 'pom.xml'))) return 'java-maven';
    if (fs.existsSync(path.join(repoPath, 'build.gradle'))) return 'java-gradle';
    if (fs.existsSync(path.join(repoPath, 'Gemfile'))) return 'ruby';
    if (fs.existsSync(path.join(repoPath, 'composer.json'))) return 'php';

    // Check for .csproj files (could be anywhere)
    try {
      const files = fs.readdirSync(repoPath);
      if (files.some(f => f.endsWith('.csproj'))) return 'dotnet';
    } catch { /* ignore */ }

    return 'unknown';
  }

  /**
   * Get run command for a project
   */
  getRunCommand(repoPath: string): { type: ProjectType; command: string } {
    const type = this.detectProjectType(repoPath);
    const config = PROJECT_DETECTIONS[type];
    return { type, command: config.runCommand };
  }

  /**
   * Detect required services from project dependencies (MULTI-LANGUAGE)
   */
  private detectRequiredServices(repoPath: string): string[] {
    const projectType = this.detectProjectType(repoPath);
    const services: string[] = [];

    console.log(`   🔍 [WorkspaceEnv] Detected project type: ${projectType}`);

    switch (projectType) {
      case 'nodejs':
        this.detectServicesFromPackageJson(repoPath, services);
        break;
      case 'python':
        this.detectServicesFromPython(repoPath, services);
        break;
      case 'go':
        this.detectServicesFromGoMod(repoPath, services);
        break;
      case 'java-maven':
        this.detectServicesFromPomXml(repoPath, services);
        break;
      case 'java-gradle':
        this.detectServicesFromGradle(repoPath, services);
        break;
      case 'ruby':
        this.detectServicesFromGemfile(repoPath, services);
        break;
      case 'php':
        this.detectServicesFromComposer(repoPath, services);
        break;
      default:
        // Try all detection methods for unknown projects
        this.detectServicesFromPackageJson(repoPath, services);
        this.detectServicesFromPython(repoPath, services);
    }

    return services;
  }

  private detectServicesFromPackageJson(repoPath: string, services: string[]): void {
    const packageJsonPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(packageJsonPath)) return;

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      this.matchDependencies(Object.keys(allDeps), services);
    } catch { /* ignore */ }
  }

  private detectServicesFromPython(repoPath: string, services: string[]): void {
    // Check requirements.txt
    const reqPath = path.join(repoPath, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      try {
        const content = fs.readFileSync(reqPath, 'utf8');
        const deps = content.split('\n')
          .map(line => line.split('==')[0].split('>=')[0].split('<=')[0].trim().toLowerCase())
          .filter(Boolean);
        this.matchDependencies(deps, services);
      } catch { /* ignore */ }
    }

    // Check pyproject.toml
    const pyprojectPath = path.join(repoPath, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        // Simple regex for dependencies in pyproject.toml
        const depMatches = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
        if (depMatches) {
          const deps = depMatches[1].match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '').split('[')[0].split('>=')[0].split('==')[0].trim()) || [];
          this.matchDependencies(deps, services);
        }
      } catch { /* ignore */ }
    }
  }

  private detectServicesFromGoMod(repoPath: string, services: string[]): void {
    const goModPath = path.join(repoPath, 'go.mod');
    if (!fs.existsSync(goModPath)) return;

    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      // Match require block and individual requires
      const deps: string[] = [];
      const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
      if (requireBlock) {
        const lines = requireBlock[1].split('\n');
        lines.forEach(line => {
          const match = line.trim().match(/^([^\s]+)/);
          if (match) deps.push(match[1]);
        });
      }
      // Single line requires
      const singleRequires = content.matchAll(/require\s+([^\s]+)/g);
      for (const match of singleRequires) {
        deps.push(match[1]);
      }
      this.matchDependencies(deps, services);
    } catch { /* ignore */ }
  }

  private detectServicesFromPomXml(repoPath: string, services: string[]): void {
    const pomPath = path.join(repoPath, 'pom.xml');
    if (!fs.existsSync(pomPath)) return;

    try {
      const content = fs.readFileSync(pomPath, 'utf8');
      // Simple artifact ID extraction
      const artifactIds = content.matchAll(/<artifactId>([^<]+)<\/artifactId>/g);
      const deps: string[] = [];
      for (const match of artifactIds) {
        deps.push(match[1]);
      }
      this.matchDependencies(deps, services);
    } catch { /* ignore */ }
  }

  private detectServicesFromGradle(repoPath: string, services: string[]): void {
    const gradlePath = path.join(repoPath, 'build.gradle');
    if (!fs.existsSync(gradlePath)) return;

    try {
      const content = fs.readFileSync(gradlePath, 'utf8');
      // Match implementation/compile dependencies
      const deps: string[] = [];
      const depMatches = content.matchAll(/(?:implementation|compile|runtimeOnly)\s*['"]([\w.:/-]+)['"]/g);
      for (const match of depMatches) {
        const parts = match[1].split(':');
        if (parts.length >= 2) deps.push(parts[1]); // artifactId
      }
      this.matchDependencies(deps, services);
    } catch { /* ignore */ }
  }

  private detectServicesFromGemfile(repoPath: string, services: string[]): void {
    const gemfilePath = path.join(repoPath, 'Gemfile');
    if (!fs.existsSync(gemfilePath)) return;

    try {
      const content = fs.readFileSync(gemfilePath, 'utf8');
      const deps: string[] = [];
      const gemMatches = content.matchAll(/gem\s+['"]([\w-]+)['"]/g);
      for (const match of gemMatches) {
        deps.push(match[1]);
      }
      this.matchDependencies(deps, services);
    } catch { /* ignore */ }
  }

  private detectServicesFromComposer(repoPath: string, services: string[]): void {
    const composerPath = path.join(repoPath, 'composer.json');
    if (!fs.existsSync(composerPath)) return;

    try {
      const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
      const allDeps = { ...composer.require, ...composer['require-dev'] };
      this.matchDependencies(Object.keys(allDeps), services);
    } catch { /* ignore */ }
  }

  private matchDependencies(deps: string[], services: string[]): void {
    for (const dep of deps) {
      const normalizedDep = dep.toLowerCase();
      // Check exact match
      const service = DEPENDENCY_TO_SERVICE[dep] || DEPENDENCY_TO_SERVICE[normalizedDep];
      if (service && !services.includes(service)) {
        services.push(service);
      }
      // Check partial match for Go packages
      for (const [key, svc] of Object.entries(DEPENDENCY_TO_SERVICE)) {
        if (normalizedDep.includes(key.toLowerCase()) && !services.includes(svc)) {
          services.push(svc);
        }
      }
    }
  }

  /**
   * Generate docker-compose.yml for the task
   */
  private async generateDockerCompose(
    taskId: string,
    workspacePath: string,
    services: Set<string>
  ): Promise<string> {
    const taskSuffix = taskId.slice(-8);
    const composeContent: any = {
      version: '3.8',
      services: {},
      networks: {
        [`task_${taskSuffix}_network`]: {
          driver: 'bridge',
        },
      },
    };

    for (const serviceName of services) {
      const config = SERVICE_DEFINITIONS[serviceName];
      if (!config) continue;

      const assignedPort = await this.findAvailablePort();
      this.setAssignedPort(taskId, serviceName, assignedPort);

      const serviceConfig: any = {
        image: config.image,
        container_name: `task_${taskSuffix}_${serviceName}`,
        ports: [`${assignedPort}:${config.port}`],
        networks: [`task_${taskSuffix}_network`],
        restart: 'unless-stopped',
      };

      if (config.environment) {
        serviceConfig.environment = config.environment;
      }

      if (config.healthCheck) {
        serviceConfig.healthcheck = {
          test: ['CMD-SHELL', config.healthCheck],
          interval: '5s',
          timeout: '5s',
          retries: 10,
        };
      }

      composeContent.services[serviceName] = serviceConfig;
    }

    const composeFilePath = path.join(workspacePath, `docker-compose.task-${taskSuffix}.yml`);
    const yaml = this.objectToYaml(composeContent);
    fs.writeFileSync(composeFilePath, yaml);

    console.log(`   📄 [WorkspaceEnv] Generated ${composeFilePath}`);
    return composeFilePath;
  }

  /**
   * Simple object to YAML converter
   */
  private objectToYaml(obj: any, indent: number = 0): string {
    const spaces = '  '.repeat(indent);
    let yaml = '';

    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;

      if (Array.isArray(value)) {
        yaml += `${spaces}${key}:\n`;
        for (const item of value) {
          if (typeof item === 'object') {
            yaml += `${spaces}  -\n${this.objectToYaml(item, indent + 2)}`;
          } else {
            yaml += `${spaces}  - ${item}\n`;
          }
        }
      } else if (typeof value === 'object') {
        yaml += `${spaces}${key}:\n${this.objectToYaml(value, indent + 1)}`;
      } else {
        yaml += `${spaces}${key}: ${value}\n`;
      }
    }

    return yaml;
  }

  /**
   * Start Docker containers
   */
  private async startContainers(_taskId: string, workspacePath: string, composeFile: string): Promise<void> {
    console.log(`   🚀 [WorkspaceEnv] Starting Docker containers...`);

    try {
      execSync(`docker compose -f "${composeFile}" up -d`, {
        cwd: workspacePath,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 120000, // 2 minutes
      });
      console.log(`   ✅ [WorkspaceEnv] Containers started`);
    } catch (error: any) {
      throw new Error(`Failed to start containers: ${error.message}`);
    }
  }

  /**
   * Wait for services to be healthy
   */
  private async waitForServices(taskId: string, services: Set<string>): Promise<void> {
    console.log(`   ⏳ [WorkspaceEnv] Waiting for services to be healthy...`);

    const maxWait = 60000; // 60 seconds
    const checkInterval = 2000;
    const startTime = Date.now();

    for (const serviceName of services) {
      const config = SERVICE_DEFINITIONS[serviceName];
      if (!config) continue;

      const port = this.getAssignedPort(taskId, serviceName);
      let healthy = false;

      while (Date.now() - startTime < maxWait && !healthy) {
        healthy = await this.isPortResponding(port);
        if (!healthy) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
      }

      if (healthy) {
        console.log(`   ✅ [WorkspaceEnv] ${serviceName} is healthy on port ${port}`);
      } else {
        console.warn(`   ⚠️  [WorkspaceEnv] ${serviceName} may not be fully ready`);
      }
    }
  }

  /**
   * Check if port is responding
   */
  private async isPortResponding(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(1000);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, 'localhost');
    });
  }

  /**
   * Get container info
   */
  private async getContainerInfo(taskId: string): Promise<RunningContainer[]> {
    const taskSuffix = taskId.slice(-8);
    const containers: RunningContainer[] = [];

    try {
      const output = execSync(
        `docker ps --filter "name=task_${taskSuffix}" --format "{{.ID}}|{{.Names}}|{{.Ports}}"`,
        { encoding: 'utf8' }
      );

      for (const line of output.trim().split('\n')) {
        if (!line) continue;
        const [id, name, ports] = line.split('|');
        const portMatch = ports?.match(/0\.0\.0\.0:(\d+)/);

        containers.push({
          containerId: id,
          name: name,
          port: portMatch ? parseInt(portMatch[1]) : 0,
          service: name.replace(`task_${taskSuffix}_`, ''),
        });
      }
    } catch {
      // No containers found
    }

    return containers;
  }

  /**
   * Install npm dependencies
   */
  private async installDependencies(repoPath: string, repoName: string): Promise<void> {
    const projectType = this.detectProjectType(repoPath);
    const config = PROJECT_DETECTIONS[projectType];

    if (projectType === 'unknown' || !config.installCommand) {
      console.log(`   ⚠️  [WorkspaceEnv] Unknown project type in ${repoName}, skipping dependency install`);
      return;
    }

    console.log(`   📦 [WorkspaceEnv] Installing dependencies for ${repoName} (${projectType})...`);
    console.log(`   📦 [WorkspaceEnv] Command: ${config.installCommand}`);

    try {
      execSync(config.installCommand, {
        cwd: repoPath,
        encoding: 'utf8',
        timeout: 300000, // 5 minutes
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`   ✅ [WorkspaceEnv] Dependencies installed for ${repoName}`);
    } catch (error: any) {
      console.error(`   ❌ [WorkspaceEnv] ${config.installCommand} failed for ${repoName}: ${error.message}`);
    }
  }

  /**
   * Get project info including type, run command, etc.
   */
  getProjectInfo(repoPath: string): {
    type: ProjectType;
    installCommand: string;
    runCommand: string;
    envFile: string;
  } {
    const type = this.detectProjectType(repoPath);
    const config = PROJECT_DETECTIONS[type];
    return {
      type,
      installCommand: config.installCommand,
      runCommand: config.runCommand,
      envFile: config.envFile,
    };
  }

  /**
   * Setup .env file with container URLs
   */
  private async setupEnvFile(
    repoPath: string,
    repoName: string,
    repoType?: string,
    envUrls?: Map<string, string>
  ): Promise<void> {
    const envPath = path.join(repoPath, '.env');
    const envExamplePath = path.join(repoPath, '.env.example');

    let envContent = '';

    // Start with .env.example if exists
    if (fs.existsSync(envExamplePath)) {
      envContent = fs.readFileSync(envExamplePath, 'utf8');
      console.log(`   📄 [WorkspaceEnv] Using .env.example as base for ${repoName}`);
    } else if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, 'utf8');
      console.log(`   📄 [WorkspaceEnv] Using existing .env for ${repoName}`);
    } else {
      // Generate basic content
      envContent = this.generateBasicEnvContent(repoName, repoType);
    }

    // Update with container URLs
    if (envUrls && envUrls.size > 0) {
      envContent += '\n# Docker container URLs (auto-generated)\n';
      for (const [key, value] of envUrls) {
        // Replace existing or append
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, `${key}=${value}`);
        } else {
          envContent += `${key}=${value}\n`;
        }
      }
    }

    fs.writeFileSync(envPath, envContent);
    console.log(`   ✅ [WorkspaceEnv] .env configured for ${repoName}`);
  }

  /**
   * Generate basic .env content
   */
  private generateBasicEnvContent(repoName: string, repoType?: string): string {
    const isBackend = repoType === 'backend' || repoName.toLowerCase().includes('backend');
    const isFrontend = repoType === 'frontend' || repoName.toLowerCase().includes('frontend');

    let content = `# Auto-generated by WorkspaceEnvironmentService\nNODE_ENV=development\n`;

    if (isBackend) {
      content += `PORT=3001\nJWT_SECRET=dev-secret-key-change-in-production\n`;
    }

    if (isFrontend) {
      content += `VITE_API_URL=http://localhost:3001\nREACT_APP_API_URL=http://localhost:3001\n`;
    }

    return content;
  }

  /**
   * Find available port
   */
  private async findAvailablePort(): Promise<number> {
    let port = this.basePort;
    while (this.usedPorts.has(port) || await this.isPortResponding(port)) {
      port++;
      if (port > this.basePort + 1000) {
        throw new Error('No available ports');
      }
    }
    this.usedPorts.add(port);
    return port;
  }

  // Port assignment storage
  private portAssignments: Map<string, Map<string, number>> = new Map();

  private setAssignedPort(taskId: string, service: string, port: number): void {
    if (!this.portAssignments.has(taskId)) {
      this.portAssignments.set(taskId, new Map());
    }
    this.portAssignments.get(taskId)!.set(service, port);
    this.usedPorts.add(port);
  }

  private getAssignedPort(taskId: string, service: string): number {
    return this.portAssignments.get(taskId)?.get(service) || 0;
  }

  /**
   * Print environment summary
   */
  private printEnvironmentSummary(env: WorkspaceEnvironment): void {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`📋 DEVELOPMENT ENVIRONMENT READY`);
    console.log(`${'═'.repeat(60)}`);

    if (env.containers.length > 0) {
      console.log(`\n🐳 Docker Containers:`);
      for (const container of env.containers) {
        console.log(`   • ${container.service}: localhost:${container.port}`);
      }
    }

    if (env.envUrls.size > 0) {
      console.log(`\n🔗 Connection URLs:`);
      for (const [key, value] of env.envUrls) {
        console.log(`   • ${key}=${value}`);
      }
    }

    console.log(`\n📍 App Ports:`);
    for (const [name, port] of env.ports) {
      if (!Object.keys(SERVICE_DEFINITIONS).includes(name)) {
        console.log(`   • ${name}: localhost:${port}`);
      }
    }

    console.log(`${'═'.repeat(60)}\n`);
  }

  /**
   * Cleanup environment - stop and remove containers
   */
  async cleanup(taskId: string): Promise<void> {
    const env = this.environments.get(taskId);

    console.log(`\n🧹 [WorkspaceEnv] Cleaning up environment for task ${taskId}...`);

    // Stop Docker containers
    if (env?.dockerComposeFile && fs.existsSync(env.dockerComposeFile)) {
      try {
        execSync(`docker compose -f "${env.dockerComposeFile}" down -v --remove-orphans`, {
          cwd: env.workspacePath,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 60000,
        });
        console.log(`   ✅ [WorkspaceEnv] Docker containers stopped and removed`);

        // Remove compose file
        fs.unlinkSync(env.dockerComposeFile);
      } catch (error: any) {
        console.warn(`   ⚠️  [WorkspaceEnv] Docker cleanup warning: ${error.message}`);
      }
    }

    // Free ports
    if (env) {
      for (const port of env.ports.values()) {
        this.usedPorts.delete(port);
      }
    }

    // Clean port assignments
    const taskPorts = this.portAssignments.get(taskId);
    if (taskPorts) {
      for (const port of taskPorts.values()) {
        this.usedPorts.delete(port);
      }
      this.portAssignments.delete(taskId);
    }

    this.environments.delete(taskId);
    console.log(`   ✅ [WorkspaceEnv] Environment cleaned up for task ${taskId}`);
  }

  /**
   * Get environment info for a task
   */
  getEnvironment(taskId: string): WorkspaceEnvironment | undefined {
    return this.environments.get(taskId);
  }

  /**
   * Get port for a service/app
   */
  getPort(taskId: string, name: string): number | undefined {
    return this.environments.get(taskId)?.ports.get(name);
  }

  /**
   * Check if environment is ready
   */
  isReady(taskId: string): boolean {
    return this.environments.get(taskId)?.ready || false;
  }
}

// Singleton instance
export const workspaceEnvironmentService = new WorkspaceEnvironmentService();
export default workspaceEnvironmentService;
