/**
 * SandboxService - Isolated Docker Environments per Task
 *
 * Creates and manages Docker containers for each task, providing
 * isolated execution environments like Codex/Devin.
 *
 * Architecture:
 * - Orchestrator runs on HOST (manages everything)
 * - Each task gets its own Docker container
 * - Commands execute inside the container
 * - Workspace is mounted as a volume
 * - EventStore tracks everything as usual
 *
 * 🔥 FULLY AUTONOMOUS:
 * - Auto-detects if Docker is installed
 * - Auto-installs Docker if missing
 * - Auto-starts Docker daemon if not running
 * - No manual setup required - runs on any VM/server
 */

import { spawn, exec, execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import { SandboxRepository } from '../database/repositories/SandboxRepository.js';

// ============================================================================
// Types
// ============================================================================

export interface SandboxConfig {
  /** Base Docker image to use */
  image: string;
  /** Memory limit (e.g., '2g', '4g') */
  memoryLimit?: string;
  /** CPU limit (e.g., '2' for 2 cores) */
  cpuLimit?: string;
  /** Environment variables to inject */
  envVars?: Record<string, string>;
  /** Additional packages to install on container start */
  packages?: string[];
  /** Working directory inside container */
  workDir?: string;
  /** Network mode: 'none' for isolated, 'bridge' for internet access */
  networkMode?: 'none' | 'bridge' | 'host';
  /** Port mappings (host:container) */
  ports?: string[];
  /**
   * Multiple workspace mounts for multi-repo projects
   * Format: { hostPath: containerPath }
   * Example: { '/host/backend': '/workspace/backend', '/host/frontend': '/workspace/frontend' }
   */
  workspaceMounts?: Record<string, string>;
}

export interface SandboxInstance {
  taskId: string;
  containerId: string;
  containerName: string;
  image: string;
  workspacePath: string;
  status: 'creating' | 'running' | 'stopped' | 'error';
  createdAt: Date;
  config: SandboxConfig;
  /** Mapped ports for dev server access */
  mappedPorts?: Record<string, string>;
  /** Repository name (e.g., 'app-pasos-frontend-flutter') */
  repoName?: string;
  /** Sandbox type for preview selection */
  sandboxType?: 'frontend' | 'backend' | 'fullstack';
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  executedIn: 'sandbox' | 'host';
}

export interface SandboxStatus {
  dockerAvailable: boolean;
  dockerVersion?: string;
  activeSandboxes: number;
  sandboxes: Map<string, SandboxInstance>;
}

// ============================================================================
// Default Configurations
// ============================================================================

/**
 * 🔥 AGNOSTIC APPROACH: Use language-specific images
 *
 * Each language uses its OWN optimal image.
 * The system detects what languages are in the repos and uses the right image.
 * For multi-language projects, uses the primary language's image and installs extras.
 */
const LANGUAGE_IMAGES: Record<string, string> = {
  // 🔥 USE OFFICIAL/MULTI-ARCH DOCKER IMAGES
  // Flutter: Use cirruslabs 3.24.0 (multi-arch, stable) - NOT :stable which has broken templates
  flutter: 'ghcr.io/cirruslabs/flutter:3.24.0', // Multi-arch, stable version
  dart: 'ghcr.io/cirruslabs/flutter:3.24.0',    // Same image, includes both Flutter and Dart
  nodejs: 'node:20-bookworm',             // OFFICIAL Docker Hub
  typescript: 'node:20-bookworm',         // OFFICIAL Docker Hub
  python: 'python:3.12-bookworm',         // OFFICIAL Docker Hub
  go: 'golang:1.22-bookworm',             // OFFICIAL Docker Hub
  rust: 'rust:1.75-bookworm',             // OFFICIAL Docker Hub
  java: 'eclipse-temurin:21-jdk',         // OFFICIAL (Adoptium)
  ruby: 'ruby:3.3-bookworm',              // OFFICIAL Docker Hub
  php: 'php:8.3-apache',                  // OFFICIAL Docker Hub
  dotnet: 'mcr.microsoft.com/dotnet/sdk:8.0', // OFFICIAL Microsoft
  // 🔥 Multi-runtime: Use Flutter image (Node.js installed at runtime)
  'multi-runtime': 'ghcr.io/cirruslabs/flutter:3.24.0',
  fullstack: 'ghcr.io/cirruslabs/flutter:3.24.0',
  // Default: Ubuntu with basic tools
  default: 'ubuntu:22.04',                // OFFICIAL Docker Hub
};

// Alias for backward compatibility
const DEFAULT_IMAGES = LANGUAGE_IMAGES;

// Network mode: 'host' for Linux (simple), 'bridge' for Mac (needs port mapping)
// Set DOCKER_USE_BRIDGE_MODE=true for Mac, false for Linux
const USE_BRIDGE_MODE = process.env.DOCKER_USE_BRIDGE_MODE === 'true';
const NETWORK_MODE: 'bridge' | 'host' = USE_BRIDGE_MODE ? 'bridge' : 'host';

const DEFAULT_CONFIG: SandboxConfig = {
  image: DEFAULT_IMAGES.default,
  memoryLimit: '4g',
  cpuLimit: '2',
  networkMode: NETWORK_MODE,
  workDir: '/workspace',
};

// ============================================================================
// SandboxService Class
// ============================================================================

class SandboxService extends EventEmitter {
  private sandboxes: Map<string, SandboxInstance> = new Map();
  private dockerAvailable: boolean = false;
  private dockerVersion: string | null = null;
  private initialized: boolean = false;

  constructor() {
    super();
  }

  // --------------------------------------------------------------------------
  // Initialization (FULLY AUTONOMOUS)
  // --------------------------------------------------------------------------

  /**
   * 🔥 FULLY AUTONOMOUS: Initialize Docker environment
   *
   * 1. Detect OS (Linux, macOS, Windows)
   * 2. Check if Docker is installed → Install if missing
   * 3. Check if Docker daemon is running → Start if not running
   * 4. Verify Docker is working
   *
   * No manual setup required - this runs on any fresh VM/server.
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) return this.dockerAvailable;

    const platform = os.platform();
    console.log(`[SandboxService] Initializing on ${platform}...`);

    try {
      // Step 1: Check if Docker is installed
      const dockerInstalled = this.isDockerInstalled();

      if (!dockerInstalled) {
        console.log(`[SandboxService] Docker not found, attempting auto-install...`);
        const installed = await this.installDocker();

        if (!installed) {
          console.warn(`[SandboxService] Could not install Docker, falling back to host execution`);
          this.dockerAvailable = false;
          this.initialized = true;
          return false;
        }
      }

      // Step 2: Check if Docker daemon is running
      const daemonRunning = await this.isDockerDaemonRunning();

      if (!daemonRunning) {
        console.log(`[SandboxService] Docker daemon not running, attempting to start...`);
        const started = await this.startDockerDaemon();

        if (!started) {
          console.warn(`[SandboxService] Could not start Docker daemon, falling back to host execution`);
          this.dockerAvailable = false;
          this.initialized = true;
          return false;
        }

        // Wait for daemon to be ready
        const daemonReady = await this.waitForDockerReady();
        if (!daemonReady) {
          console.warn(`[SandboxService] Docker daemon never became ready, falling back to host execution`);
          this.dockerAvailable = false;
          this.initialized = true;
          return false;
        }
      }

      // Step 3: Verify Docker is ACTUALLY working (docker info requires daemon, docker --version doesn't)
      try {
        execSync('docker info', { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 });
      } catch {
        console.warn(`[SandboxService] Docker daemon not responding, falling back to host execution`);
        this.dockerAvailable = false;
        this.initialized = true;
        return false;
      }

      const version = execSync('docker --version', { encoding: 'utf-8' }).trim();
      this.dockerVersion = version;
      this.dockerAvailable = true;
      console.log(`[SandboxService] ✅ Docker ready: ${version}`);

      // 🔥 IMPORTANT: Load existing sandboxes from SQLite (survive restarts)
      await this.loadSandboxesFromDatabase();

      this.initialized = true;
      this.emit('docker:ready', { version });
      return true;

    } catch (error: any) {
      console.error(`[SandboxService] Initialization failed: ${error.message}`);
      this.dockerAvailable = false;
      this.initialized = true;
      return false;
    }
  }

  /**
   * Check if Docker CLI is installed
   */
  private isDockerInstalled(): boolean {
    try {
      execSync('which docker || where docker', { encoding: 'utf-8', stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 🔥 AGNOSTIC: Get the correct Docker image based on detected language
   *
   * PlanningPhase already detects the project language using LLM analysis.
   * This method simply maps that language to the optimal Docker image.
   *
   * @param language - Language detected by PlanningPhase (flutter, nodejs, python, etc.)
   * @returns Docker image optimized for that language
   */
  private getImageForLanguage(language: string): string {
    const normalizedLang = language.toLowerCase();
    return LANGUAGE_IMAGES[normalizedLang] || LANGUAGE_IMAGES.default;
  }

  /**
   * Check if Docker daemon is running
   */
  private async isDockerDaemonRunning(): Promise<boolean> {
    try {
      execSync('docker info', { encoding: 'utf-8', stdio: 'pipe', timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 🔥 AUTO-INSTALL: Install Docker based on OS
   */
  private async installDocker(): Promise<boolean> {
    const platform = os.platform();
    console.log(`[SandboxService] Installing Docker on ${platform}...`);

    try {
      if (platform === 'linux') {
        // Linux: Use official Docker install script
        console.log(`[SandboxService] Running Docker install script for Linux...`);

        // Check if we have sudo access
        try {
          execSync('sudo -n true', { stdio: 'pipe' });
        } catch {
          console.warn(`[SandboxService] No sudo access, cannot auto-install Docker`);
          return false;
        }

        // Install Docker using official script
        execSync('curl -fsSL https://get.docker.com | sudo sh', {
          encoding: 'utf-8',
          stdio: 'inherit',
          timeout: 300000, // 5 minutes
        });

        // Add current user to docker group (avoid sudo for docker commands)
        const username = os.userInfo().username;
        try {
          execSync(`sudo usermod -aG docker ${username}`, { stdio: 'pipe' });
          console.log(`[SandboxService] Added ${username} to docker group`);
        } catch {
          console.warn(`[SandboxService] Could not add user to docker group`);
        }

        console.log(`[SandboxService] ✅ Docker installed on Linux`);
        return true;

      } else if (platform === 'darwin') {
        // macOS: Use Homebrew or Docker Desktop
        console.log(`[SandboxService] Installing Docker on macOS...`);

        // Check if Homebrew is available
        try {
          execSync('which brew', { stdio: 'pipe' });

          // Install Docker via Homebrew
          execSync('brew install --cask docker', {
            encoding: 'utf-8',
            stdio: 'inherit',
            timeout: 300000,
          });

          console.log(`[SandboxService] ✅ Docker Desktop installed via Homebrew`);
          console.log(`[SandboxService] ⚠️  Please open Docker Desktop manually the first time`);
          return true;
        } catch {
          console.warn(`[SandboxService] Homebrew not available, cannot auto-install Docker on macOS`);
          console.log(`[SandboxService] Please install Docker Desktop from: https://docker.com/products/docker-desktop`);
          return false;
        }

      } else if (platform === 'win32') {
        // Windows: Can't auto-install easily
        console.warn(`[SandboxService] Auto-install not supported on Windows`);
        console.log(`[SandboxService] Please install Docker Desktop from: https://docker.com/products/docker-desktop`);
        return false;
      }

      return false;
    } catch (error: any) {
      console.error(`[SandboxService] Docker installation failed: ${error.message}`);
      return false;
    }
  }

  /**
   * 🔥 AUTO-START: Start Docker daemon based on OS
   */
  private async startDockerDaemon(): Promise<boolean> {
    const platform = os.platform();
    console.log(`[SandboxService] Starting Docker daemon on ${platform}...`);

    try {
      if (platform === 'linux') {
        // Linux: Start via systemctl or service
        try {
          execSync('sudo systemctl start docker', { stdio: 'pipe', timeout: 30000 });
          console.log(`[SandboxService] ✅ Docker daemon started via systemctl`);
          return true;
        } catch {
          // Fallback to service command
          try {
            execSync('sudo service docker start', { stdio: 'pipe', timeout: 30000 });
            console.log(`[SandboxService] ✅ Docker daemon started via service`);
            return true;
          } catch {
            console.warn(`[SandboxService] Could not start Docker daemon`);
            return false;
          }
        }

      } else if (platform === 'darwin') {
        // macOS: Open Docker Desktop app
        try {
          execSync('open -a Docker', { stdio: 'pipe' });
          console.log(`[SandboxService] ✅ Docker Desktop starting...`);
          return true;
        } catch {
          console.warn(`[SandboxService] Could not start Docker Desktop`);
          console.log(`[SandboxService] Please open Docker Desktop manually`);
          return false;
        }

      } else if (platform === 'win32') {
        // Windows: Start Docker Desktop
        try {
          execSync('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"', { stdio: 'pipe' });
          console.log(`[SandboxService] ✅ Docker Desktop starting...`);
          return true;
        } catch {
          console.warn(`[SandboxService] Could not start Docker Desktop`);
          return false;
        }
      }

      return false;
    } catch (error: any) {
      console.error(`[SandboxService] Failed to start Docker daemon: ${error.message}`);
      return false;
    }
  }

  /**
   * Wait for Docker daemon to be ready (with timeout)
   */
  private async waitForDockerReady(maxWaitMs: number = 60000): Promise<boolean> {
    console.log(`[SandboxService] Waiting for Docker daemon to be ready...`);

    const startTime = Date.now();
    const checkInterval = 2000; // Check every 2 seconds

    while (Date.now() - startTime < maxWaitMs) {
      if (await this.isDockerDaemonRunning()) {
        console.log(`[SandboxService] ✅ Docker daemon is ready`);
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      process.stdout.write('.');
    }

    console.log('');
    console.warn(`[SandboxService] Docker daemon not ready after ${maxWaitMs / 1000}s`);
    return false;
  }

  /**
   * 🔥 STARTUP RECOVERY: Load sandboxes from SQLite and verify Docker containers
   *
   * On startup:
   * 1. Load all sandboxes from SQLite
   * 2. For each: check if Docker container still exists
   * 3. If exists and running: add to in-memory Map
   * 4. If exists but stopped: start it and add to Map
   * 5. If doesn't exist: remove from SQLite (container was manually removed)
   */
  private async loadSandboxesFromDatabase(): Promise<void> {
    try {
      const savedSandboxes = SandboxRepository.findAll();
      console.log(`[SandboxService] 🔄 Loading ${savedSandboxes.length} sandboxes from SQLite...`);

      for (const saved of savedSandboxes) {
        try {
          // Check if Docker container exists
          const inspectResult = await this.runDockerCommand([
            'inspect', '--format', '{{.State.Status}}', saved.containerName
          ]);
          const containerStatus = inspectResult.trim();

          console.log(`[SandboxService]   📦 ${saved.containerName}: Docker status = ${containerStatus}`);

          if (containerStatus === 'running') {
            // Container running - add to Map
            this.sandboxes.set(saved.taskId, saved);
            console.log(`[SandboxService]   ✅ Restored running sandbox: ${saved.taskId}`);

          } else if (containerStatus === 'exited' || containerStatus === 'stopped' || containerStatus === 'created') {
            // Container stopped - try to start it
            console.log(`[SandboxService]   ▶️ Starting stopped container: ${saved.containerName}`);
            await this.runDockerCommand(['start', saved.containerName]);
            saved.status = 'running';
            this.sandboxes.set(saved.taskId, saved);
            SandboxRepository.updateStatus(saved.taskId, 'running');
            console.log(`[SandboxService]   ✅ Restarted and restored sandbox: ${saved.taskId}`);

          } else {
            // Container in unexpected state - mark as error
            console.warn(`[SandboxService]   ⚠️ Container ${saved.containerName} in state: ${containerStatus}`);
            SandboxRepository.updateStatus(saved.taskId, 'error');
          }

        } catch (error: any) {
          // Container doesn't exist in Docker
          if (error.message?.includes('No such object') || error.message?.includes('Error: No such')) {
            console.log(`[SandboxService]   🗑️ Container ${saved.containerName} no longer exists, removing from DB`);
            SandboxRepository.deleteByTaskId(saved.taskId);
          } else {
            console.warn(`[SandboxService]   ⚠️ Error checking container ${saved.containerName}: ${error.message}`);
          }
        }
      }

      console.log(`[SandboxService] ✅ Loaded ${this.sandboxes.size} sandboxes from SQLite`);

    } catch (error: any) {
      console.error(`[SandboxService] ❌ Failed to load sandboxes from database: ${error.message}`);
    }
  }

  /**
   * Check if Docker is available
   */
  isDockerAvailable(): boolean {
    return this.dockerAvailable;
  }

  /**
   * Get Docker status info
   */
  getDockerInfo(): { available: boolean; version: string | null; platform: string } {
    return {
      available: this.dockerAvailable,
      version: this.dockerVersion,
      platform: os.platform(),
    };
  }

  // --------------------------------------------------------------------------
  // Sandbox Lifecycle
  // --------------------------------------------------------------------------

  /**
   * Create a new sandbox for a task
   *
   * 🔥 ARCHITECTURE (2026-01-23): Supports unified multi-repo sandboxes
   * - Pass workspaceMounts in customConfig to mount multiple repos
   * - Use language='multi-runtime' for unified sandbox with all SDKs
   *
   * @param taskId - Unique task identifier
   * @param workspacePath - Base workspace path (or first repo path)
   * @param language - Language hint or 'multi-runtime' for unified
   * @param customConfig - Config including workspaceMounts for multi-repo
   * @param repoName - Repository name (or 'unified' for multi-repo)
   * @param sandboxType - 'frontend' | 'backend' | 'fullstack' (auto-detected if not provided)
   */
  async createSandbox(
    taskId: string,
    workspacePath: string,
    language: string = 'nodejs',
    customConfig?: Partial<SandboxConfig>,
    repoName?: string,
    sandboxType?: 'frontend' | 'backend' | 'fullstack'
  ): Promise<SandboxInstance | null> {
    await this.initialize();

    if (!this.dockerAvailable) {
      console.warn(`[SandboxService] Docker not available, cannot create sandbox for task ${taskId}`);
      return null;
    }

    // 🔥 EXACT CHECK: Only reuse sandbox if EXACT taskId match or starts with taskId-
    // Never use partial matching (includes) - it causes cross-task contamination
    const existingDirect = this.sandboxes.get(taskId);
    if (existingDirect && existingDirect.status === 'running') {
      console.log(`[SandboxService] Sandbox already exists for task ${taskId}`);
      return existingDirect;
    }

    // Also check for sandboxes created with extended IDs (taskId-setup-repoName)
    // Only EXACT prefix match, never partial/includes
    for (const [sandboxId, sb] of this.sandboxes) {
      if (sandboxId.startsWith(`${taskId}-`) && sb.status === 'running') {
        console.log(`[SandboxService] 🔄 Found existing sandbox from previous run: ${sandboxId}`);
        return sb;
      }
    }

    // Always use Flutter base image (has everything we need)
    const baseImage = customConfig?.image || this.getImageForLanguage(language);

    const config: SandboxConfig = {
      ...DEFAULT_CONFIG,
      ...customConfig,
      // Override image with our resolved image (must come last)
      image: baseImage,
    };

    // Generate unique container name from full taskId
    // Use hash to avoid conflicts when multiple projects share same base taskId
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(taskId).digest('hex').substring(0, 12);
    const containerName = `agent-sandbox-${hash}`;

    // Extract repoName from taskId if not provided (format: taskId-setup-repoName)
    const extractedRepoName = repoName || this.extractRepoNameFromTaskId(taskId);

    // Auto-detect sandboxType from image or repoName
    const detectedType = sandboxType || this.detectSandboxType(config.image, extractedRepoName, language);

    console.log(`[SandboxService] Creating sandbox for task ${taskId}`);
    console.log(`   Image: ${config.image}`);
    console.log(`   Workspace: ${workspacePath}`);
    console.log(`   Container: ${containerName}`);
    console.log(`   RepoName: ${extractedRepoName || 'unknown'}`);
    console.log(`   Type: ${detectedType}`);

    const instance: SandboxInstance = {
      taskId,
      containerId: '',
      containerName,
      image: config.image,
      workspacePath,
      status: 'creating',
      createdAt: new Date(),
      config,
      repoName: extractedRepoName,
      sandboxType: detectedType,
    };

    this.sandboxes.set(taskId, instance);
    this.emit('sandbox:creating', { taskId, containerName });

    try {
      // Ensure workspace exists
      if (!fs.existsSync(workspacePath)) {
        fs.mkdirSync(workspacePath, { recursive: true });
      }

      // Cleanup: Remove any existing container with the same name
      // This handles cases where a previous container wasn't properly cleaned up
      try {
        await this.runDockerCommand(['rm', '-f', containerName]);
        console.log(`[SandboxService] Cleaned up existing container: ${containerName}`);
      } catch {
        // Container doesn't exist, which is fine
      }

      // Build docker run command
      const dockerArgs = this.buildDockerRunArgs(instance);

      console.log(`[SandboxService] Running: docker run ${dockerArgs.join(' ')}`);

      // Create and start container
      const containerId = await this.runDockerCommand(['run', ...dockerArgs]);

      instance.containerId = containerId.trim();
      instance.status = 'running';

      // Get mapped ports if any (dynamic port mapping)
      if (config.ports && config.ports.length > 0) {
        instance.mappedPorts = await this.getMappedPorts(instance.containerId);
        console.log(`[SandboxService] 🔌 Port mappings:`, instance.mappedPorts);
        // Log each mapping for clarity
        for (const [containerPort, hostPort] of Object.entries(instance.mappedPorts)) {
          console.log(`   📍 Container ${containerPort} → Host ${hostPort} (http://localhost:${hostPort})`);
        }
      }

      // 🔥 PERSIST TO SQLITE: Sandbox survives backend restarts
      SandboxRepository.upsert(instance);

      console.log(`[SandboxService] Sandbox created: ${instance.containerId.substring(0, 12)}`);
      this.emit('sandbox:created', { taskId, containerId: instance.containerId });

      // 🔥 Install Node.js at runtime (Flutter image doesn't have it)
      // This takes ~30 seconds but only happens once per container
      await this.installNodeJsIfNeeded(taskId, containerName);

      // Install additional packages if specified
      if (config.packages && config.packages.length > 0) {
        await this.installPackages(taskId, config.packages);
      }

      return instance;

    } catch (error: any) {
      console.error(`[SandboxService] Failed to create sandbox:`, error.message);
      instance.status = 'error';
      this.emit('sandbox:error', { taskId, error: error.message });
      return null;
    }
  }

  /**
   * Stop and remove a sandbox
   */
  async destroySandbox(taskId: string): Promise<boolean> {
    // 🔍 Use smart lookup to find sandbox
    const found = this.findSandboxForTask(taskId);
    if (!found) {
      console.log(`[SandboxService] No sandbox found for task ${taskId}`);
      return false;
    }

    const { sandboxId, instance } = found;
    console.log(`[SandboxService] Destroying sandbox ${sandboxId} for task ${taskId}`);

    try {
      // Stop container
      await this.runDockerCommand(['stop', '-t', '5', instance.containerName]).catch(() => {});

      // Remove container
      await this.runDockerCommand(['rm', '-f', instance.containerName]).catch(() => {});

      instance.status = 'stopped';
      this.sandboxes.delete(sandboxId); // Use resolved sandboxId

      // 🔥 REMOVE FROM SQLITE: Only happens on manual destruction
      SandboxRepository.deleteByTaskId(sandboxId);

      console.log(`[SandboxService] Sandbox ${sandboxId} destroyed for task ${taskId}`);
      this.emit('sandbox:destroyed', { taskId, sandboxId });

      return true;
    } catch (error: any) {
      console.error(`[SandboxService] Error destroying sandbox:`, error.message);
      return false;
    }
  }

  /**
   * Get sandbox instance for a task (direct lookup only)
   */
  getSandbox(taskId: string): SandboxInstance | undefined {
    return this.sandboxes.get(taskId);
  }

  /**
   * Extract repoName from taskId (format: taskId-setup-repoName)
   */
  private extractRepoNameFromTaskId(taskId: string): string | undefined {
    // Format: taskId-setup-repoName  →  taskId-setup-app-pasos-frontend-flutter
    const match = taskId.match(/-setup-(.+)$/);
    return match ? match[1] : undefined;
  }

  /**
   * Auto-detect sandbox type from image, repoName, or language
   */
  private detectSandboxType(
    image: string,
    repoName?: string,
    language?: string
  ): 'frontend' | 'backend' | 'fullstack' {
    // 1. Check image
    if (image.includes('flutter') || image.includes('dart')) {
      return 'frontend';
    }

    // 2. Check repoName
    if (repoName) {
      const lowerRepo = repoName.toLowerCase();
      if (lowerRepo.includes('frontend') || lowerRepo.includes('flutter') ||
          lowerRepo.includes('mobile') || lowerRepo.includes('web') ||
          lowerRepo.includes('client') || lowerRepo.includes('app-')) {
        return 'frontend';
      }
      if (lowerRepo.includes('backend') || lowerRepo.includes('api') ||
          lowerRepo.includes('server') || lowerRepo.includes('service')) {
        return 'backend';
      }
    }

    // 3. Check language
    if (language === 'flutter' || language === 'dart') {
      return 'frontend';
    }

    // Default to backend (most common for Node.js servers)
    return 'backend';
  }

  /**
   * 🎯 Find sandbox by type (frontend/backend) for a task
   * Use this for preview to find the correct sandbox when multiple repos exist
   */
  findSandboxByType(
    taskId: string,
    type: 'frontend' | 'backend' | 'fullstack'
  ): { sandboxId: string; instance: SandboxInstance } | undefined {
    // Search for sandbox matching taskId AND type
    for (const [sandboxId, sb] of this.sandboxes) {
      if ((sandboxId === taskId || sandboxId.includes(taskId) || taskId.includes(sandboxId.split('-setup-')[0])) &&
          sb.status === 'running' &&
          sb.sandboxType === type) {
        console.log(`[SandboxService] 🎯 Found ${type} sandbox: ${sandboxId}`);
        return { sandboxId, instance: sb };
      }
    }

    return undefined;
  }

  /**
   * 🔍 Get all sandboxes for a task (for listing available previews)
   */
  getAllSandboxesForTask(taskId: string): Array<{ sandboxId: string; instance: SandboxInstance }> {
    const results: Array<{ sandboxId: string; instance: SandboxInstance }> = [];

    for (const [sandboxId, sb] of this.sandboxes) {
      // Match by taskId prefix or full match
      const baseTaskId = taskId.split('-setup-')[0];
      const sbBaseTaskId = sandboxId.split('-setup-')[0];

      if (sandboxId === taskId ||
          sandboxId.startsWith(`${taskId}-`) ||
          baseTaskId === sbBaseTaskId) {
        if (sb.status === 'running') {
          results.push({ sandboxId, instance: sb });
        }
      }
    }

    return results;
  }

  /**
   * 🔍 SMART SANDBOX LOOKUP - Find sandbox using 4-level fallback
   * Use this when you need to find a sandbox that might have been created with
   * a different ID pattern (e.g., taskId-setup-repoName)
   */
  findSandboxForTask(taskId: string): { sandboxId: string; instance: SandboxInstance } | undefined {
    // 🔥 CRITICAL: Lookup must be EXACT to prevent cross-task contamination
    // Never use partial matching (includes) as it can match wrong containers

    // 1️⃣ PRIORITY: Direct lookup by taskId (EXACT match)
    let instance = this.sandboxes.get(taskId);
    if (instance && instance.status === 'running') {
      return { sandboxId: taskId, instance };
    }

    // 2️⃣ FALLBACK: Search for setup sandboxes (taskId-setup-* or taskId-repoName)
    // Only matches sandboxes that START WITH this exact taskId
    for (const [sandboxId, sb] of this.sandboxes) {
      if (sandboxId.startsWith(`${taskId}-`) && sb.status === 'running') {
        console.log(`[SandboxService] 🔍 Found related sandbox: ${sandboxId}`);
        return { sandboxId, instance: sb };
      }
    }

    // 3️⃣ LAST: Return any instance even if not running (for destroy operations)
    instance = this.sandboxes.get(taskId);
    if (instance) {
      return { sandboxId: taskId, instance };
    }

    // Search in non-running sandboxes (only exact prefix match)
    for (const [sandboxId, sb] of this.sandboxes) {
      if (sandboxId.startsWith(`${taskId}-`)) {
        return { sandboxId, instance: sb };
      }
    }

    return undefined;
  }

  /**
   * Get all active sandboxes
   */
  getAllSandboxes(): Map<string, SandboxInstance> {
    return this.sandboxes;
  }

  /**
   * 🔥 FIND AND START EXISTING SANDBOX (for retry/continue/resume)
   *
   * When a task is retried, continued, or resumed, we DON'T want to create a new
   * sandbox - we want to START the existing container that was created when the
   * task first started.
   *
   * This method:
   * 1. Generates the container name from taskId (deterministic)
   * 2. Checks if that container exists in Docker
   * 3. If exists but stopped: starts it and registers in our map
   * 4. If exists and running: just registers in our map
   * 5. Returns the sandbox instance or null if container doesn't exist
   *
   * @param taskId - The task ID to find the sandbox for
   * @param workspacePath - Workspace path (needed to reconstruct SandboxInstance)
   * @returns SandboxInstance if found and started, null otherwise
   */
  async findOrStartExistingSandbox(
    taskId: string,
    workspacePath: string
  ): Promise<SandboxInstance | null> {
    await this.initialize();

    if (!this.dockerAvailable) {
      console.warn(`[SandboxService] Docker not available for findOrStartExistingSandbox`);
      return null;
    }

    // 1. Check if already in our in-memory map and running
    const existingInMap = this.sandboxes.get(taskId);
    if (existingInMap && existingInMap.status === 'running') {
      console.log(`[SandboxService] ♻️ Sandbox already in map and running: ${taskId}`);
      return existingInMap;
    }

    // 2. Generate the container name (deterministic from taskId)
    const crypto = await import('crypto');
    const hash = crypto.createHash('md5').update(taskId).digest('hex').substring(0, 12);
    const containerName = `agent-sandbox-${hash}`;

    console.log(`[SandboxService] 🔍 Looking for existing container: ${containerName}`);

    try {
      // 3. Check if container exists in Docker (running or stopped)
      const inspectResult = await this.runDockerCommand(['inspect', '--format', '{{.State.Status}}', containerName]);
      const containerStatus = inspectResult.trim();

      console.log(`[SandboxService] 📦 Found container ${containerName} with status: ${containerStatus}`);

      // 4. If container is stopped/exited, start it
      if (containerStatus === 'exited' || containerStatus === 'stopped' || containerStatus === 'created') {
        console.log(`[SandboxService] ▶️ Starting stopped container: ${containerName}`);
        await this.runDockerCommand(['start', containerName]);
        console.log(`[SandboxService] ✅ Container started: ${containerName}`);
      } else if (containerStatus !== 'running') {
        // Container exists but in an unexpected state (paused, restarting, dead, etc.)
        console.warn(`[SandboxService] ⚠️ Container ${containerName} in unexpected state: ${containerStatus}`);
        // Try to remove and return null so a new one is created
        await this.runDockerCommand(['rm', '-f', containerName]).catch(() => {});
        return null;
      }

      // 5. Get container details to reconstruct SandboxInstance
      const containerIdResult = await this.runDockerCommand(['inspect', '--format', '{{.Id}}', containerName]);
      const imageResult = await this.runDockerCommand(['inspect', '--format', '{{.Config.Image}}', containerName]);

      const instance: SandboxInstance = {
        taskId,
        containerId: containerIdResult.trim(),
        containerName,
        image: imageResult.trim(),
        workspacePath,
        status: 'running',
        createdAt: new Date(), // Approximation, actual creation time is lost
        config: {
          image: imageResult.trim(),
          memoryLimit: '8g', // Default, actual limit is in container
          cpuLimit: '4',
          networkMode: 'host',
          workDir: '/workspace', // 🔥 FIX: Always set workDir to ensure correct Docker path
        },
        repoName: 'unified',
        sandboxType: 'fullstack',
      };

      // 6. Get mapped ports if any
      try {
        instance.mappedPorts = await this.getMappedPorts(instance.containerId);
        if (Object.keys(instance.mappedPorts).length > 0) {
          console.log(`[SandboxService] 🔌 Port mappings recovered:`, instance.mappedPorts);
        }
      } catch {
        // Port mapping not available, that's OK
      }

      // 7. Register in our in-memory map AND SQLite
      this.sandboxes.set(taskId, instance);
      SandboxRepository.upsert(instance);
      this.emit('sandbox:recovered', { taskId, containerName });

      console.log(`[SandboxService] ✅ Existing sandbox recovered and started: ${containerName}`);
      return instance;

    } catch (error: any) {
      // Container doesn't exist (docker inspect failed)
      if (error.message?.includes('No such object') || error.message?.includes('Error: No such')) {
        console.log(`[SandboxService] 📭 No existing container found for ${containerName}`);
        // Also check and clean up SQLite if there's a stale entry
        SandboxRepository.deleteByTaskId(taskId);
      } else {
        console.warn(`[SandboxService] ⚠️ Error checking for existing container: ${error.message}`);
      }
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Command Execution
  // --------------------------------------------------------------------------

  /**
   * Execute a command in the sandbox (or host if no sandbox)
   */
  async exec(
    taskId: string,
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      user?: string;  // 🔥 Run as specific user (e.g., 'root' for permission fixes)
    }
  ): Promise<CommandResult> {
    // 🔍 SMART SANDBOX LOOKUP (4-level fallback)
    let instance: SandboxInstance | undefined;

    // 1️⃣ PRIORITY: Direct lookup by taskId
    instance = this.sandboxes.get(taskId);

    // 2️⃣ FALLBACK: Search for setup sandboxes (taskId-setup-*)
    if (!instance || instance.status !== 'running') {
      for (const [sandboxId, sb] of this.sandboxes) {
        if (sandboxId.startsWith(`${taskId}-setup-`) && sb.status === 'running') {
          instance = sb;
          console.log(`[SandboxService] Found setup sandbox: ${sandboxId}`);
          break;
        }
      }
    }

    // 3️⃣ FALLBACK: Partial match on taskId
    if (!instance || instance.status !== 'running') {
      for (const [sandboxId, sb] of this.sandboxes) {
        if (sandboxId.includes(taskId) && sb.status === 'running') {
          instance = sb;
          console.log(`[SandboxService] Found partial match sandbox: ${sandboxId}`);
          break;
        }
      }
    }

    // If no sandbox found, execute on host
    if (!instance || instance.status !== 'running') {
      console.log(`[SandboxService] No running sandbox for task ${taskId}, executing on host`);
      return this.execOnHost(command, options);
    }

    // Execute in sandbox
    return this.execInSandbox(instance, command, options);
  }

  /**
   * Execute command in sandbox container
   */
  private async execInSandbox(
    instance: SandboxInstance,
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
      user?: string;  // 🔥 Run as specific user (e.g., 'root' for permission fixes)
    }
  ): Promise<CommandResult> {
    const startTime = Date.now();
    const workDir = options?.cwd || instance.config.workDir || '/workspace';

    // Build environment variables
    const envArgs: string[] = [];
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        envArgs.push('-e', `${key}=${value}`);
      }
    }

    // Build user args (for running as root to fix permissions)
    const userArgs: string[] = [];
    if (options?.user) {
      userArgs.push('-u', options.user);
    }

    // Build docker exec command
    const dockerArgs = [
      'exec',
      ...userArgs,  // 🔥 Add user args BEFORE -w
      '-w', workDir,
      ...envArgs,
      instance.containerName,
      'sh', '-c', command,
    ];

    return new Promise((resolve) => {
      const timeout = options?.timeout || 300000; // 5 min default
      let stdout = '';
      let stderr = '';
      let killed = false;

      const proc = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: killed ? 124 : (code ?? 1),
          stdout: stdout.trim(),
          stderr: killed ? 'Command timed out' : stderr.trim(),
          duration: Date.now() - startTime,
          executedIn: 'sandbox',
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout: '',
          stderr: error.message,
          duration: Date.now() - startTime,
          executedIn: 'sandbox',
        });
      });
    });
  }

  /**
   * Fallback: Execute command on host
   */
  private async execOnHost(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): Promise<CommandResult> {
    const startTime = Date.now();

    return new Promise((resolve) => {
      const timeout = options?.timeout || 300000;

      exec(
        command,
        {
          cwd: options?.cwd,
          timeout,
          env: { ...process.env, ...options?.env },
          maxBuffer: 50 * 1024 * 1024, // 50MB
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? (error as any).code || 1 : 0,
            stdout: stdout?.trim() || '',
            stderr: stderr?.trim() || '',
            duration: Date.now() - startTime,
            executedIn: 'host',
          });
        }
      );
    });
  }

  /**
   * Execute command synchronously in sandbox
   */
  execSync(
    taskId: string,
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): CommandResult {
    const startTime = Date.now();

    // 🔍 SMART SANDBOX LOOKUP (4-level fallback)
    const found = this.findSandboxForTask(taskId);

    // If no sandbox, execute on host
    if (!found || found.instance.status !== 'running') {
      console.log(`[SandboxService] execSync: No running sandbox for ${taskId}, executing on host`);
      return this.execSyncOnHost(command, options);
    }

    const { instance } = found;
    const workDir = options?.cwd || instance.config.workDir || '/workspace';

    // Build environment variables
    const envArgs: string[] = [];
    if (options?.env) {
      for (const [key, value] of Object.entries(options.env)) {
        envArgs.push('-e', `${key}=${value}`);
      }
    }

    try {
      const result = execSync(
        `docker exec -w "${workDir}" ${envArgs.join(' ')} ${instance.containerName} sh -c "${command.replace(/"/g, '\\"')}"`,
        {
          timeout: options?.timeout || 300000,
          maxBuffer: 50 * 1024 * 1024,
          encoding: 'utf-8',
        }
      );

      return {
        exitCode: 0,
        stdout: result.trim(),
        stderr: '',
        duration: Date.now() - startTime,
        executedIn: 'sandbox',
      };
    } catch (error: any) {
      return {
        exitCode: error.status || 1,
        stdout: error.stdout?.toString().trim() || '',
        stderr: error.stderr?.toString().trim() || error.message,
        duration: Date.now() - startTime,
        executedIn: 'sandbox',
      };
    }
  }

  /**
   * Fallback: Execute command synchronously on host
   */
  private execSyncOnHost(
    command: string,
    options?: {
      cwd?: string;
      timeout?: number;
      env?: Record<string, string>;
    }
  ): CommandResult {
    const startTime = Date.now();

    try {
      const result = execSync(command, {
        cwd: options?.cwd,
        timeout: options?.timeout || 300000,
        env: { ...process.env, ...options?.env },
        maxBuffer: 50 * 1024 * 1024,
        encoding: 'utf-8',
      });

      return {
        exitCode: 0,
        stdout: result.trim(),
        stderr: '',
        duration: Date.now() - startTime,
        executedIn: 'host',
      };
    } catch (error: any) {
      return {
        exitCode: error.status || 1,
        stdout: error.stdout?.toString().trim() || '',
        stderr: error.stderr?.toString().trim() || error.message,
        duration: Date.now() - startTime,
        executedIn: 'host',
      };
    }
  }

  // --------------------------------------------------------------------------
  // Environment Setup
  // --------------------------------------------------------------------------

  /**
   * Setup environment in sandbox (install deps, configure .env)
   */
  async setupEnvironment(
    taskId: string,
    options: {
      installCommand?: string;
      envVars?: Record<string, string>;
      envFilePath?: string;
      postSetupCommands?: string[];
    }
  ): Promise<{ success: boolean; logs: string[] }> {
    const logs: string[] = [];

    // 🔍 SMART SANDBOX LOOKUP
    const found = this.findSandboxForTask(taskId);
    if (!found) {
      logs.push('[ERROR] No sandbox found for task');
      return { success: false, logs };
    }

    const { instance } = found;
    logs.push(`[INFO] Setting up environment in sandbox ${instance.containerName}`);

    try {
      // 1. Write .env file if provided
      if (options.envVars && Object.keys(options.envVars).length > 0) {
        const envContent = Object.entries(options.envVars)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n');

        const envPath = options.envFilePath || `${instance.config.workDir}/.env`;

        // Write .env file inside container
        const writeResult = await this.exec(taskId, `cat > ${envPath} << 'ENVEOF'
${envContent}
ENVEOF`);

        if (writeResult.exitCode === 0) {
          logs.push(`[OK] Created .env file with ${Object.keys(options.envVars).length} variables`);
        } else {
          logs.push(`[WARN] Failed to create .env file: ${writeResult.stderr}`);
        }
      }

      // 2. Install dependencies
      if (options.installCommand) {
        logs.push(`[INFO] Running: ${options.installCommand}`);

        const installResult = await this.exec(taskId, options.installCommand, {
          timeout: 600000, // 10 min for npm install
        });

        if (installResult.exitCode === 0) {
          logs.push(`[OK] Dependencies installed successfully`);
        } else {
          logs.push(`[ERROR] Install failed: ${installResult.stderr}`);
          return { success: false, logs };
        }
      }

      // 3. Run post-setup commands
      if (options.postSetupCommands) {
        for (const cmd of options.postSetupCommands) {
          logs.push(`[INFO] Running: ${cmd}`);
          const result = await this.exec(taskId, cmd);

          if (result.exitCode === 0) {
            logs.push(`[OK] Command succeeded`);
          } else {
            logs.push(`[WARN] Command failed: ${result.stderr}`);
          }
        }
      }

      logs.push(`[DONE] Environment setup complete`);
      return { success: true, logs };

    } catch (error: any) {
      logs.push(`[ERROR] Setup failed: ${error.message}`);
      return { success: false, logs };
    }
  }

  /**
   * Install packages in sandbox
   */
  private async installPackages(taskId: string, packages: string[]): Promise<void> {
    // 🔍 SMART SANDBOX LOOKUP
    const found = this.findSandboxForTask(taskId);
    if (!found) return;

    const { instance } = found;
    console.log(`[SandboxService] Installing packages: ${packages.join(', ')}`);

    // Determine package manager based on image
    let installCmd: string;
    if (instance.image.includes('node') || instance.image.includes('flutter')) {
      installCmd = 'apt-get update && apt-get install -y';
    } else if (instance.image.includes('python')) {
      installCmd = 'pip install';
    } else {
      installCmd = 'apt-get update && apt-get install -y';
    }

    await this.exec(taskId, `${installCmd} ${packages.join(' ')}`, {
      timeout: 300000,
    });
  }

  /**
   * 🔥 Install Node.js in container at runtime
   *
   * The Flutter image doesn't have Node.js, so we install it on first use.
   * This takes ~30 seconds but only happens once per container.
   */
  private async installNodeJsIfNeeded(_taskId: string, containerName: string): Promise<void> {
    console.log(`[SandboxService] 📦 Installing Node.js in container...`);

    try {
      // Check if node is already installed
      const checkResult = await this.execInContainer(containerName, 'which node');
      if (checkResult.exitCode === 0) {
        console.log(`[SandboxService] ✅ Node.js already installed`);
        return;
      }
    } catch {
      // Node not found, proceed with install
    }

    try {
      // Install Node.js 20 LTS
      const installCmd = `
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
        apt-get install -y nodejs && \
        npm install -g npm@latest yarn pnpm
      `;

      const result = await this.execInContainer(containerName, installCmd, 120000);

      if (result.exitCode === 0) {
        console.log(`[SandboxService] ✅ Node.js installed successfully`);
      } else {
        console.warn(`[SandboxService] ⚠️ Node.js install returned code ${result.exitCode}`);
      }
    } catch (error: any) {
      console.error(`[SandboxService] ❌ Failed to install Node.js: ${error.message}`);
      // Don't throw - sandbox still works for Flutter/Dart
    }
  }

  /**
   * Execute command directly in container (by name, not taskId)
   */
  private async execInContainer(
    containerName: string,
    command: string,
    timeout: number = 60000
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const proc = spawn('docker', ['exec', containerName, 'sh', '-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGTERM');
      }, timeout);

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: killed ? 124 : (code ?? 1),
          stdout: stdout.trim(),
          stderr: killed ? 'Timeout' : stderr.trim(),
        });
      });

      proc.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout: '', stderr: error.message });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Helper Methods
  // --------------------------------------------------------------------------

  /**
   * Build docker run arguments
   */
  private buildDockerRunArgs(instance: SandboxInstance): string[] {
    const config = instance.config;
    const args: string[] = [
      '-d', // Detached
      '--name', instance.containerName,
      '--hostname', `sandbox-${instance.taskId.substring(0, 8)}`,
    ];

    // 🔥 CRITICAL: Run container as host user to avoid permission issues
    // Without this, files created in container are owned by root,
    // and git operations on host fail with "Permission denied"
    const uid = process.getuid?.() || 1000;
    const gid = process.getgid?.() || 1000;
    args.push('--user', `${uid}:${gid}`);
    console.log(`[SandboxService] Running container as user ${uid}:${gid} (matching host user)`);

    // Resource limits
    if (config.memoryLimit) {
      args.push('--memory', config.memoryLimit);
    }
    if (config.cpuLimit) {
      args.push('--cpus', config.cpuLimit);
    }

    // Network
    if (config.networkMode) {
      args.push('--network', config.networkMode);
    }

    // Mount workspaces
    // Priority 1: Multiple workspace mounts (multi-repo projects)
    if (config.workspaceMounts && Object.keys(config.workspaceMounts).length > 0) {
      for (const [hostPath, containerPath] of Object.entries(config.workspaceMounts)) {
        args.push('-v', `${hostPath}:${containerPath}`);
      }
    } else {
      // Priority 2: Single workspace mount (legacy)
      args.push('-v', `${instance.workspacePath}:${config.workDir || '/workspace'}`);
    }

    // Environment variables
    if (config.envVars) {
      for (const [key, value] of Object.entries(config.envVars)) {
        args.push('-e', `${key}=${value}`);
      }
    }

    // Port mappings
    if (config.ports) {
      for (const port of config.ports) {
        args.push('-p', port);
      }
    }

    // Working directory
    args.push('-w', config.workDir || '/workspace');

    // Image
    args.push(config.image);

    // Keep container running with tail
    args.push('tail', '-f', '/dev/null');

    return args;
  }

  /**
   * Run a docker command and return output
   */
  private async runDockerCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('docker', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Docker command failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Get mapped ports for a container
   */
  private async getMappedPorts(containerId: string): Promise<Record<string, string>> {
    try {
      const output = await this.runDockerCommand([
        'port', containerId,
      ]);

      const ports: Record<string, string> = {};
      for (const line of output.split('\n')) {
        const match = line.match(/(\d+)\/tcp -> .+:(\d+)/);
        if (match) {
          ports[match[1]] = match[2];
        }
      }
      return ports;
    } catch {
      return {};
    }
  }

  /**
   * Clean up orphaned containers that are NOT in our database
   * Call manually if needed - never called automatically
   */
  async cleanupOrphanedContainers(): Promise<void> {
    try {
      // Find all containers with our naming pattern
      const output = await this.runDockerCommand([
        'ps', '-a', '--filter', 'name=agent-sandbox-', '--format', '{{.Names}}',
      ]);

      if (!output) return;

      const containers = output.split('\n').filter(Boolean);
      const dbSandboxes = SandboxRepository.findAll();
      const knownContainers = new Set(dbSandboxes.map(s => s.containerName));

      for (const container of containers) {
        if (!knownContainers.has(container)) {
          console.log(`[SandboxService] Cleaning up orphaned container: ${container}`);
          await this.runDockerCommand(['rm', '-f', container]).catch(() => {});
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Get service status
   */
  getStatus(): SandboxStatus {
    return {
      dockerAvailable: this.dockerAvailable,
      dockerVersion: this.dockerVersion || undefined,
      activeSandboxes: this.sandboxes.size,
      sandboxes: this.sandboxes,
    };
  }

  /**
   * Cleanup all sandboxes (for shutdown)
   */
  async cleanup(): Promise<void> {
    console.log(`[SandboxService] Cleaning up ${this.sandboxes.size} sandboxes...`);

    const tasks = Array.from(this.sandboxes.keys());
    await Promise.all(tasks.map(taskId => this.destroySandbox(taskId)));

    console.log(`[SandboxService] Cleanup complete`);
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const sandboxService = new SandboxService();
export default sandboxService;
