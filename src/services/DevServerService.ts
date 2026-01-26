/**
 * DevServerService
 *
 * Manages development server instances for live preview functionality.
 * This service runs SEPARATELY from agent execution to avoid timeouts.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { NotificationService } from './NotificationService';
import { sandboxService } from './SandboxService';
import { eventStore } from './EventStore';

/**
 * Get extended PATH including common SDK locations
 * This helps find Flutter, Python, Node.js, etc. when running from Node.js
 */
function getExtendedPath(): string {
  const homedir = os.homedir();
  const existingPath = process.env.PATH || '';

  // Common SDK/tool locations that might not be in Node.js PATH
  const additionalPaths = [
    // Flutter
    `${homedir}/development/flutter/bin`,
    `${homedir}/.flutter/bin`,
    `${homedir}/flutter/bin`,
    `/opt/flutter/bin`,
    // FVM (Flutter Version Management)
    `${homedir}/fvm/default/bin`,
    `${homedir}/.fvm/flutter_sdk/bin`,
    // Homebrew
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // Python
    `${homedir}/.local/bin`,
    `${homedir}/.pyenv/shims`,
    // Node.js
    `${homedir}/.nvm/current/bin`,
    `${homedir}/.volta/bin`,
    // Android SDK
    `${homedir}/Library/Android/sdk/platform-tools`,
    `${homedir}/Library/Android/sdk/tools`,
    // General
    '/usr/bin',
    '/bin',
  ].filter(p => fs.existsSync(p)); // Only add paths that exist

  return [...new Set([...additionalPaths, ...existingPath.split(':')])].join(':');
}

/**
 * Find Flutter SDK path by checking common locations
 */
/**
 * SDK availability info
 */
interface SdkAvailability {
  available: boolean;
  sdkName: string;
  path?: string;
  version?: string;
  installInstructions?: string;
}

/**
 * SDK installation commands by platform
 */
const SDK_INSTALL_COMMANDS: Record<string, { mac: string; linux: string; description: string }> = {
  flutter: {
    mac: 'brew install --cask flutter',
    linux: 'snap install flutter --classic',
    description: 'Flutter SDK for mobile/web development',
  },
  nodejs: {
    mac: 'brew install node',
    linux: 'curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo apt-get install -y nodejs',
    description: 'Node.js JavaScript runtime',
  },
  python: {
    mac: 'brew install python3',
    linux: 'sudo apt-get install -y python3 python3-pip',
    description: 'Python programming language',
  },
};

/**
 * Install an SDK (runs install command)
 * Returns a stream of installation output
 */
async function installSdk(language: string): Promise<{ success: boolean; output: string; error?: string }> {
  const platform = process.platform === 'darwin' ? 'mac' : 'linux';
  const normalizedLang = language.toLowerCase();

  // Map variations to standard names
  const langMap: Record<string, string> = {
    dart: 'flutter',
    node: 'nodejs',
    javascript: 'nodejs',
    typescript: 'nodejs',
  };

  const sdkKey = langMap[normalizedLang] || normalizedLang;
  const installInfo = SDK_INSTALL_COMMANDS[sdkKey];

  if (!installInfo) {
    return {
      success: false,
      output: '',
      error: `No installation command available for: ${language}`,
    };
  }

  const command = platform === 'mac' ? installInfo.mac : installInfo.linux;
  console.log(`[DevServerService] Installing ${sdkKey}...`);
  console.log(`   Command: ${command}`);

  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout: 300000, // 5 minutes timeout for installation
      stdio: 'pipe',
      env: { ...process.env, PATH: getExtendedPath() },
    });

    console.log(`[DevServerService] ${sdkKey} installed successfully`);

    return {
      success: true,
      output: output,
    };
  } catch (error: any) {
    console.error(`[DevServerService] Failed to install ${sdkKey}:`, error.message);

    return {
      success: false,
      output: error.stdout || '',
      error: error.message || 'Installation failed',
    };
  }
}

/**
 * Get installation info for an SDK
 */
function getSdkInstallInfo(language: string): { command: string; description: string } | null {
  const platform = process.platform === 'darwin' ? 'mac' : 'linux';
  const normalizedLang = language.toLowerCase();

  const langMap: Record<string, string> = {
    dart: 'flutter',
    node: 'nodejs',
    javascript: 'nodejs',
    typescript: 'nodejs',
  };

  const sdkKey = langMap[normalizedLang] || normalizedLang;
  const installInfo = SDK_INSTALL_COMMANDS[sdkKey];

  if (!installInfo) return null;

  return {
    command: platform === 'mac' ? installInfo.mac : installInfo.linux,
    description: installInfo.description,
  };
}

/**
 * Check if a specific SDK/runtime is available
 */
function checkSdkAvailability(language: string): SdkAvailability {
  const extendedPath = getExtendedPath();

  switch (language.toLowerCase()) {
    case 'dart':
    case 'flutter': {
      const flutterPath = findFlutterPath();
      if (flutterPath) {
        try {
          const version = execSync(`"${flutterPath}" --version`, {
            encoding: 'utf8',
            timeout: 10000,
            env: { ...process.env, PATH: extendedPath },
          }).split('\n')[0];
          return {
            available: true,
            sdkName: 'Flutter',
            path: flutterPath,
            version: version.trim(),
          };
        } catch {
          return {
            available: true,
            sdkName: 'Flutter',
            path: flutterPath,
          };
        }
      }
      return {
        available: false,
        sdkName: 'Flutter',
        installInstructions: `Flutter SDK not found. Install with:
  - macOS: brew install --cask flutter
  - Or download from: https://docs.flutter.dev/get-started/install
  - Then set FLUTTER_SDK_PATH=/path/to/flutter in .env`,
      };
    }

    case 'nodejs':
    case 'node':
    case 'javascript':
    case 'typescript': {
      try {
        const nodePath = execSync('which node', {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, PATH: extendedPath },
        }).trim();
        const version = execSync('node --version', {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        return {
          available: true,
          sdkName: 'Node.js',
          path: nodePath,
          version,
        };
      } catch {
        return {
          available: false,
          sdkName: 'Node.js',
          installInstructions: `Node.js not found. Install with:
  - macOS: brew install node
  - Or use nvm: nvm install --lts`,
        };
      }
    }

    case 'python': {
      try {
        const pythonPath = execSync('which python3 || which python', {
          encoding: 'utf8',
          timeout: 5000,
          env: { ...process.env, PATH: extendedPath },
        }).trim();
        const version = execSync('python3 --version || python --version', {
          encoding: 'utf8',
          timeout: 5000,
        }).trim();
        return {
          available: true,
          sdkName: 'Python',
          path: pythonPath,
          version,
        };
      } catch {
        return {
          available: false,
          sdkName: 'Python',
          installInstructions: `Python not found. Install with:
  - macOS: brew install python3
  - Or use pyenv: pyenv install 3.11`,
        };
      }
    }

    default:
      return {
        available: true, // Assume available for unknown languages
        sdkName: language,
      };
  }
}

function findFlutterPath(): string | null {
  const homedir = os.homedir();

  // Check environment variable first
  if (process.env.FLUTTER_SDK_PATH) {
    const envPath = path.join(process.env.FLUTTER_SDK_PATH, 'bin', 'flutter');
    if (fs.existsSync(envPath)) {
      console.log(`[DevServerService] Using Flutter from FLUTTER_SDK_PATH: ${envPath}`);
      return envPath;
    }
  }

  // Common Flutter installation paths
  const possiblePaths = [
    `${homedir}/development/flutter/bin/flutter`,
    `${homedir}/.flutter/bin/flutter`,
    `${homedir}/flutter/bin/flutter`,
    `${homedir}/fvm/default/bin/flutter`,
    `${homedir}/.fvm/flutter_sdk/bin/flutter`,
    '/opt/flutter/bin/flutter',
    '/opt/homebrew/bin/flutter',
    '/usr/local/bin/flutter',
  ];

  for (const flutterPath of possiblePaths) {
    if (fs.existsSync(flutterPath)) {
      console.log(`[DevServerService] Found Flutter at: ${flutterPath}`);
      return flutterPath;
    }
  }

  // Try to find via `which flutter` with extended PATH
  try {
    const extendedPath = getExtendedPath();
    const result = execSync('which flutter', {
      env: { ...process.env, PATH: extendedPath },
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    if (result && fs.existsSync(result)) {
      console.log(`[DevServerService] Found Flutter via which: ${result}`);
      return result;
    }
  } catch {
    // which command failed, continue
  }

  return null;
}

interface DevServerInstance {
  taskId: string;
  process: ChildProcess | null;  // null for Docker-based servers
  port: number;
  framework: string;
  url: string;
  workspacePath: string;
  startedAt: Date;
  // 🐳 Docker support
  isDocker: boolean;
  containerName?: string;
  dockerPid?: number;  // PID of dev server inside container
}

class DevServerService extends EventEmitter {
  private servers: Map<string, DevServerInstance> = new Map();
  private usedPorts: Set<number> = new Set();
  // 🐳 Track Docker dev server processes
  private dockerProcesses: Map<string, ChildProcess> = new Map();

  /**
   * Detect framework from workspace
   */
  detectFramework(workspacePath: string): { framework: string; command: string; port: number } | null {
    // Check for package.json
    const packageJsonPath = path.join(workspacePath, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        // Vite
        if (deps.vite) {
          return { framework: 'vite', command: 'npm run dev', port: 5173 };
        }
        // Next.js
        if (deps.next) {
          return { framework: 'nextjs', command: 'npm run dev', port: 3000 };
        }
        // Create React App
        if (deps['react-scripts']) {
          return { framework: 'cra', command: 'npm start', port: 3000 };
        }
        // Vue CLI
        if (deps['@vue/cli-service']) {
          return { framework: 'vue', command: 'npm run serve', port: 8080 };
        }
        // Angular
        if (deps['@angular/core']) {
          return { framework: 'angular', command: 'npm start', port: 4200 };
        }
        // Generic Node.js
        if (pkg.scripts?.dev) {
          return { framework: 'node', command: 'npm run dev', port: 3000 };
        }
        if (pkg.scripts?.start) {
          return { framework: 'node', command: 'npm start', port: 3000 };
        }
      } catch (e) {
        console.error('[DevServerService] Error reading package.json:', e);
      }
    }

    // Check for pubspec.yaml (Flutter)
    const pubspecPath = path.join(workspacePath, 'pubspec.yaml');
    if (fs.existsSync(pubspecPath)) {
      return { framework: 'flutter', command: 'flutter run -d chrome', port: 5000 };
    }

    // Check for requirements.txt (Python)
    const requirementsPath = path.join(workspacePath, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      // Check for common frameworks
      const requirements = fs.readFileSync(requirementsPath, 'utf8');
      if (requirements.includes('django')) {
        return { framework: 'django', command: 'python manage.py runserver', port: 8000 };
      }
      if (requirements.includes('flask')) {
        return { framework: 'flask', command: 'flask run', port: 5000 };
      }
      if (requirements.includes('fastapi')) {
        return { framework: 'fastapi', command: 'uvicorn main:app --reload', port: 8000 };
      }
    }

    return null;
  }

  /**
   * Get next available port
   */
  private getAvailablePort(preferredPort: number): number {
    let port = preferredPort;
    while (this.usedPorts.has(port)) {
      port++;
    }
    return port;
  }

  /**
   * 🐳 Find the actual project directory inside Docker container
   * Searches for pubspec.yaml, package.json, etc. in /workspace subdirectories
   */
  private async findProjectDirInDocker(containerName: string, framework: string): Promise<string> {
    try {
      let searchFile = 'pubspec.yaml';
      if (['vite', 'nextjs', 'cra', 'node', 'vue', 'angular'].includes(framework)) {
        searchFile = 'package.json';
      } else if (['django', 'flask', 'fastapi'].includes(framework)) {
        searchFile = 'requirements.txt';
      }

      // Search for the project file
      const result = execSync(
        `docker exec ${containerName} bash -c 'find /workspace -maxdepth 3 -name "${searchFile}" -type f 2>/dev/null | head -5'`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      if (result) {
        const paths = result.split('\n').filter(p => p.trim());
        if (paths.length > 0) {
          // Get directory of the first found file
          const projectDir = path.dirname(paths[0]);
          console.log(`🐳 [DevServerService] Found ${searchFile} at: ${paths[0]}, using dir: ${projectDir}`);
          return projectDir;
        }
      }
    } catch (error) {
      console.log(`🐳 [DevServerService] Could not find project directory, using /workspace`);
    }
    return '/workspace';
  }

  /**
   * 🐳 Start a dev server INSIDE Docker container
   * Supports both host networking and bridge mode with dynamic port allocation
   */
  async startServerInDocker(
    taskId: string,
    containerName: string,
    framework: string,
    port: number,
    mappedPorts?: Record<string, string>  // 🔥 Dynamic port mappings from sandbox
  ): Promise<{ url: string; framework: string } | null> {
    // 🔥 Use dynamic port mapping if available (bridge mode)
    // mappedPorts format: { "8080": "32768" } means container:8080 -> host:32768
    const hostPort = mappedPorts?.[port.toString()] || port.toString();
    const url = `http://localhost:${hostPort}`;
    console.log(`🐳 [DevServerService] Port mapping: container ${port} -> host ${hostPort}`);

    // 🔍 Auto-detect the actual project directory
    const projectDir = await this.findProjectDirInDocker(containerName, framework);
    console.log(`🐳 [DevServerService] Using project directory: ${projectDir}`);

    // 🔥 AGNOSTIC: Try to get LLM-determined command from EventStore first
    let command: string = '';  // Will be set by EventStore or fallback
    let installFirst = '';
    let usedEventStore = false;

    try {
      const state = await eventStore.getCurrentState(taskId);
      if (state?.environmentConfig) {
        // Find matching config (by repo name or first available)
        const repoKeys = Object.keys(state.environmentConfig);
        const envConfig = repoKeys.length > 0 ? state.environmentConfig[repoKeys[0]] : null;

        if (envConfig?.runCommand) {
          command = envConfig.runCommand;
          installFirst = envConfig.installCommand ? `${envConfig.installCommand} 2>/dev/null || true && ` : '';
          usedEventStore = true;
          console.log(`🤖 [DevServerService] Using LLM-determined command from EventStore: ${command}`);
        }
      }
    } catch (err: any) {
      console.log(`⚠️ [DevServerService] Could not read from EventStore: ${err.message}`);
    }

    // Fallback to hardcoded commands if EventStore didn't have a command
    // NOTE: For Flutter, use build+serve (NOT flutter run which hangs)
    if (!usedEventStore) {
      console.log(`📦 [DevServerService] Using hardcoded command for framework: ${framework}`);
      switch (framework) {
        case 'flutter':
          installFirst = 'flutter pub get 2>/dev/null || true && ';
          command = `flutter build web && python3 -m http.server ${port} --directory build/web --bind 0.0.0.0`;
          break;
        case 'vite':
          installFirst = 'npm install 2>/dev/null || true && ';
          command = `npm run dev -- --port ${port} --host 0.0.0.0`;
          break;
        case 'nextjs':
          installFirst = 'npm install 2>/dev/null || true && ';
          command = `PORT=${port} npm run dev`;
          break;
        case 'cra':
          installFirst = 'npm install 2>/dev/null || true && ';
          command = `PORT=${port} npm start`;
          break;
        case 'node':
          installFirst = 'npm install 2>/dev/null || true && ';
          command = `PORT=${port} npm run dev 2>/dev/null || PORT=${port} npm start`;
          break;
        case 'django':
          installFirst = 'pip install -r requirements.txt 2>/dev/null || true && ';
          command = `python manage.py runserver 0.0.0.0:${port}`;
          break;
        case 'flask':
          installFirst = 'pip install -r requirements.txt 2>/dev/null || true && ';
          command = `flask run --host=0.0.0.0 --port=${port}`;
          break;
        case 'fastapi':
          installFirst = 'pip install -r requirements.txt 2>/dev/null || true && ';
          command = `uvicorn main:app --host 0.0.0.0 --port ${port} --reload`;
          break;
        default:
          // Generic: try npm run dev first, then npm start
          installFirst = 'npm install 2>/dev/null || true && ';
          command = `PORT=${port} npm run dev 2>/dev/null || PORT=${port} npm start`;
      }
    }

    const fullCommand = `${installFirst}${command}`;

    console.log(`🐳 [DevServerService] Starting ${framework} server in Docker container ${containerName}`);
    console.log(`   Project dir: ${projectDir}`);
    console.log(`   Command: ${fullCommand}`);
    console.log(`   Port: ${port}`);

    // Start the process using docker exec with -d for background
    // We run in foreground but capture output to detect when ready
    const dockerCmd = `docker exec -i ${containerName} bash -c 'cd ${projectDir} && ${fullCommand}'`;

    const proc = spawn('bash', ['-c', dockerCmd], {
      stdio: 'pipe',
      detached: false,
    });

    this.dockerProcesses.set(taskId, proc);

    const actualHostPort = parseInt(hostPort, 10);
    const instance: DevServerInstance = {
      taskId,
      process: proc,
      port: actualHostPort,  // 🔥 Store actual HOST port, not container port
      framework,
      url,
      workspacePath: projectDir,
      startedAt: new Date(),
      isDocker: true,
      containerName,
    };

    this.servers.set(taskId, instance);
    this.usedPorts.add(actualHostPort);  // 🔥 Track actual host port

    // Handle stdout - detect when server is ready
    proc.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log(`🐳 [DevServer:${taskId}] ${output}`);

      // Emit as console log for frontend
      NotificationService.emitConsoleLog(taskId, 'info', `[Preview] ${output.substring(0, 200)}`);

      // Detect when server is ready
      if (
        output.includes('Local:') ||
        output.includes('ready in') ||
        output.includes('started server') ||
        output.includes('Listening on') ||
        output.includes('Server running') ||
        output.includes('Running on') ||
        output.includes('http://') ||
        // Flutter specific
        output.includes('Flutter DevTools') ||
        output.includes('lib/main.dart is being served') ||
        output.includes('Running with') ||
        output.includes('is being served at') ||
        // Generic
        output.toLowerCase().includes('started') && output.toLowerCase().includes('server')
      ) {
        console.log(`🐳 [DevServerService] Server ready at ${url}`);
        NotificationService.emitDevServerReady(taskId, url, framework);
      }
    });

    // Handle stderr
    proc.stderr?.on('data', (data) => {
      const output = data.toString();
      // Many frameworks output to stderr even for normal messages
      console.log(`🐳 [DevServer:${taskId}] ${output}`);
      NotificationService.emitConsoleLog(taskId, 'info', `[Preview] ${output.substring(0, 200)}`);

      // Also check stderr for ready messages (Flutter uses stderr for some output)
      if (
        output.includes('Running on') ||
        output.includes('http://') ||
        output.includes('is being served')
      ) {
        console.log(`🐳 [DevServerService] Server ready at ${url}`);
        NotificationService.emitDevServerReady(taskId, url, framework);
      }
    });

    // Handle exit
    proc.on('exit', (code) => {
      console.log(`🐳 [DevServerService] Docker server for task ${taskId} exited with code ${code}`);
      this.servers.delete(taskId);
      this.usedPorts.delete(port);
      this.dockerProcesses.delete(taskId);
      NotificationService.emitDevServerStopped(taskId);
    });

    // Emit ready immediately for Docker since we're using host networking
    // The server will be accessible as soon as it starts binding
    setTimeout(() => {
      console.log(`🐳 [DevServerService] Emitting dev_server_ready for ${url}`);
      NotificationService.emitDevServerReady(taskId, url, framework);
    }, 5000);

    return { url, framework };
  }

  /**
   * Start a dev server for a task
   * 🐳 UPDATED: Automatically uses Docker if sandbox exists
   */
  async startServer(taskId: string, workspacePath: string, framework?: string): Promise<{ url: string; framework: string } | null> {
    // Check if server already running for this task
    if (this.servers.has(taskId)) {
      const existing = this.servers.get(taskId)!;
      console.log(`[DevServerService] Server already running for task ${taskId} at ${existing.url}`);
      return { url: existing.url, framework: existing.framework };
    }

    // Detect or use provided framework
    const detected = this.detectFramework(workspacePath);
    if (!detected && !framework) {
      console.error(`[DevServerService] Could not detect framework in ${workspacePath}`);
      return null;
    }

    const { command, port: preferredPort } = detected || { command: 'npm run dev', port: 3000 };
    const actualFramework = framework || detected?.framework || 'unknown';
    const port = this.getAvailablePort(preferredPort);
    const url = `http://localhost:${port}`;

    // 🐳 CHECK FOR DOCKER SANDBOX FIRST
    const sandbox = sandboxService.findSandboxForTask(taskId);
    if (sandbox && sandbox.instance.status === 'running') {
      console.log(`🐳 [DevServerService] Found running sandbox ${sandbox.sandboxId}, starting server inside Docker`);
      // 🔥 Pass dynamic port mappings for bridge mode
      return this.startServerInDocker(
        taskId,
        sandbox.instance.containerName,
        actualFramework,
        port,
        sandbox.instance.mappedPorts  // Dynamic port mappings from Docker
      );
    }

    // No sandbox found - continue with host execution
    console.log(`[DevServerService] No sandbox found for ${taskId}, starting server on host`);

    console.log(`[DevServerService] Starting ${actualFramework} server for task ${taskId}`);
    console.log(`   Workspace: ${workspacePath}`);
    console.log(`   Command: ${command}`);
    console.log(`   Port: ${port}`);

    // Parse command and handle special cases
    let [cmd, ...args] = command.split(' ');

    // Special handling for Flutter - find full path
    if (actualFramework === 'flutter') {
      const flutterPath = findFlutterPath();
      if (flutterPath) {
        cmd = flutterPath;
        console.log(`[DevServerService] Using Flutter at: ${flutterPath}`);
      } else {
        console.error(`[DevServerService] Flutter not found! Please install Flutter or set FLUTTER_SDK_PATH`);
        console.error(`   Searched locations: ~/development/flutter, ~/.flutter, /opt/flutter, etc.`);
        return null;
      }
    }

    // Add port override for common frameworks
    let portArgs: string[] = [];
    if (actualFramework === 'vite') {
      portArgs = ['--port', port.toString()];
    } else if (actualFramework === 'nextjs' || actualFramework === 'cra') {
      process.env.PORT = port.toString();
    } else if (actualFramework === 'flutter') {
      // Flutter web uses --web-port
      portArgs = ['--web-port', port.toString()];
    }

    // Get extended PATH for child process
    const extendedPath = getExtendedPath();
    console.log(`[DevServerService] Using extended PATH with ${extendedPath.split(':').length} entries`);

    const proc = spawn(cmd, [...args, ...portArgs], {
      cwd: workspacePath,
      shell: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        PORT: port.toString(),
        PATH: extendedPath,
        // Flutter specific
        FLUTTER_ROOT: findFlutterPath()?.replace('/bin/flutter', '') || '',
      },
    });

    const instance: DevServerInstance = {
      taskId,
      process: proc,
      port,
      framework: actualFramework,
      url,
      workspacePath,
      startedAt: new Date(),
      isDocker: false,  // 🐳 Host-based server
    };

    this.servers.set(taskId, instance);
    this.usedPorts.add(port);

    // Handle stdout
    proc.stdout?.on('data', (data) => {
      const output = data.toString();
      console.log(`[DevServer:${taskId}] ${output}`);

      // Detect when server is ready
      if (
        output.includes('Local:') ||
        output.includes('ready in') ||
        output.includes('started server') ||
        output.includes('Listening on') ||
        output.includes('Server running') ||
        // Flutter specific
        output.includes('Flutter DevTools') ||
        output.includes('lib/main.dart is being served') ||
        output.includes('Running with') ||
        output.includes('The Flutter DevTools debugger')
      ) {
        console.log(`[DevServerService] Server ready at ${url}`);
        NotificationService.emitDevServerReady(taskId, url, actualFramework);
      }
    });

    // Handle stderr
    proc.stderr?.on('data', (data) => {
      console.error(`[DevServer:${taskId}] ERROR: ${data}`);
    });

    // Handle exit
    proc.on('exit', (code) => {
      console.log(`[DevServerService] Server for task ${taskId} exited with code ${code}`);
      this.servers.delete(taskId);
      this.usedPorts.delete(port);
      NotificationService.emitDevServerStopped(taskId);
    });

    // Wait a bit for server to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    return { url, framework: actualFramework };
  }

  /**
   * Stop a dev server for a task
   * 🐳 Handles both Docker and host-based servers
   */
  stopServer(taskId: string): boolean {
    const instance = this.servers.get(taskId);
    if (!instance) {
      console.log(`[DevServerService] No server running for task ${taskId}`);
      return false;
    }

    console.log(`[DevServerService] Stopping server for task ${taskId} (docker=${instance.isDocker})`);

    // 🐳 Docker server: kill the process AND stop any running server in container
    if (instance.isDocker && instance.containerName) {
      // Kill the docker exec process
      if (instance.process) {
        instance.process.kill('SIGTERM');
      }

      // Also try to kill dev server processes inside container
      try {
        // Kill common dev server processes
        execSync(`docker exec ${instance.containerName} pkill -f "flutter run" 2>/dev/null || true`, { encoding: 'utf-8' });
        execSync(`docker exec ${instance.containerName} pkill -f "npm run" 2>/dev/null || true`, { encoding: 'utf-8' });
        execSync(`docker exec ${instance.containerName} pkill -f "node" 2>/dev/null || true`, { encoding: 'utf-8' });
        console.log(`🐳 [DevServerService] Killed processes inside container ${instance.containerName}`);
      } catch {
        // Ignore errors from pkill
      }

      this.dockerProcesses.delete(taskId);
    } else if (instance.process) {
      // Host server: kill the process
      instance.process.kill('SIGTERM');

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.servers.has(taskId) && instance.process) {
          instance.process.kill('SIGKILL');
        }
      }, 5000);
    }

    this.servers.delete(taskId);
    this.usedPorts.delete(instance.port);
    NotificationService.emitDevServerStopped(taskId);

    return true;
  }

  /**
   * Stop all servers
   */
  stopAllServers(): void {
    console.log(`[DevServerService] Stopping all ${this.servers.size} servers`);
    for (const taskId of this.servers.keys()) {
      this.stopServer(taskId);
    }
  }

  /**
   * Get server status for a task
   */
  getServerStatus(taskId: string): DevServerInstance | null {
    return this.servers.get(taskId) || null;
  }

  /**
   * Get all running servers
   */
  getAllServers(): Map<string, DevServerInstance> {
    return new Map(this.servers);
  }

  /**
   * Check if a specific SDK is available
   */
  checkSdk(language: string): SdkAvailability {
    return checkSdkAvailability(language);
  }

  /**
   * Check all supported SDKs
   */
  checkAllSdks(): Record<string, SdkAvailability> {
    return {
      nodejs: checkSdkAvailability('nodejs'),
      flutter: checkSdkAvailability('flutter'),
      python: checkSdkAvailability('python'),
    };
  }

  /**
   * Install an SDK on the server machine
   * WARNING: This runs shell commands, only use in trusted environments
   */
  async installSdk(language: string): Promise<{ success: boolean; output: string; error?: string }> {
    return installSdk(language);
  }

  /**
   * Get installation info for an SDK
   */
  getSdkInstallInfo(language: string): { command: string; description: string } | null {
    return getSdkInstallInfo(language);
  }
}

// Singleton instance
const devServerService = new DevServerService();

// Cleanup on process exit
process.on('SIGINT', () => devServerService.stopAllServers());
process.on('SIGTERM', () => devServerService.stopAllServers());

export default devServerService;
