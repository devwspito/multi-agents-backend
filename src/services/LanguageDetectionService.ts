/**
 * LanguageDetectionService
 *
 * Uses LLM to detect language/framework from task description.
 * 100% language-agnostic - no hardcoded patterns.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getExplicitModelId } from '../config/ModelConfigurations.js';
import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface DetectedLanguage {
  language: string;           // e.g., "dart", "typescript", "python", "rust"
  framework: string;          // e.g., "flutter", "react", "django", "actix"
  dockerImage: string;        // e.g., "ghcr.io/cirruslabs/flutter:3.24.0"
  ecosystem: string;          // e.g., "flutter", "node", "python"
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  // Project setup commands (LLM-determined, 100% agnostic)
  checkFile?: string;         // File that indicates project exists (e.g., "pubspec.yaml", "package.json")
  projectName?: string;       // 🔥 LLM-determined valid project name (e.g., "app_pasos_frontend" for Dart)
  createCmd?: string;         // Command to create new project WITH correct project name
  installCmd?: string;        // Command to install dependencies (e.g., "flutter pub get")
  devCmd?: string;            // Command to run dev server (e.g., "flutter run -d web-server")
  devPort?: number;           // Default port for dev server (e.g., 8080)
  runtimeInstallCmd?: string; // Command to install additional runtime dependencies (e.g., python3 for http.server)
  // 🔥 AGNOSTIC: Optional test command - runs if framework has default tests
  // If the framework generates tests by default (e.g., flutter create, create-react-app),
  // this command validates the project works before developers start writing code.
  testCmd?: string;           // e.g., "flutter test", "npm test", "pytest", "go test ./..."
  // 🔥 AGNOSTIC: Rebuild command for static builds
  // Used after code merges to rebuild the app (for frameworks using static build + serve pattern)
  // For frameworks with HMR (hot module replacement), this can be "echo 'HMR handles rebuild'"
  rebuildCmd?: string;        // e.g., "flutter build web", "npm run build", "cargo build"
}

export interface DetectionResult {
  primary: DetectedLanguage;
  secondary?: DetectedLanguage[];  // For multi-repo projects
  rawResponse?: string;
}

// ============================================================================
// Service
// ============================================================================

class LanguageDetectionService {
  private client: Anthropic | null = null;

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  /**
   * Detect language/framework from task description using LLM
   *
   * 🔥 FULLY AGNOSTIC: LLM determines EVERYTHING including:
   * - Docker image
   * - Valid project name (e.g., underscores for Dart, kebab-case for npm)
   * - Create command with correct flags
   * - Install/dev commands
   *
   * @param taskDescription - Task description from user
   * @param additionalContext - Optional additional context
   * @param repoNames - Optional array of repo names to generate valid project names for
   */
  async detectFromDescription(
    taskDescription: string,
    additionalContext?: string,
    repoNames?: string[]
  ): Promise<DetectionResult> {
    // 🔥 Include repo names in prompt so LLM can generate valid project names
    const repoContext = repoNames?.length
      ? `\nREPOSITORY NAMES (may need name conversion for the language):\n${repoNames.map(r => `- ${r}`).join('\n')}`
      : '';

    const prompt = `Analyze this task description and determine the programming language, framework, and appropriate Docker image.

TASK DESCRIPTION:
${taskDescription}
${repoContext}
${additionalContext ? `\nADDITIONAL CONTEXT:\n${additionalContext}` : ''}

RESPOND WITH THIS EXACT JSON STRUCTURE. ALL FIELDS ARE REQUIRED:
{
  "language": "dart|typescript|python|go|rust|java|kotlin|swift",
  "framework": "flutter|react|nextjs|django|fastapi|gin|express|none",
  "dockerImage": "exact docker image (e.g., ghcr.io/cirruslabs/flutter:3.24.0)",
  "ecosystem": "flutter|node|python|jvm|go|rust",
  "confidence": "high|medium|low",
  "reasoning": "one sentence explanation",
  "checkFile": "pubspec.yaml|package.json|go.mod|Cargo.toml|requirements.txt",
  "projectName": "valid_project_name_for_language",
  "createCmd": "complete command to create project",
  "installCmd": "command to install dependencies",
  "devCmd": "REQUIRED: command to start dev server binding to 0.0.0.0",
  "devPort": 8080,
  "testCmd": "OPTIONAL: command to run default tests if framework generates them",
  "runtimeInstallCmd": "REQUIRED FOR MULTI-RUNTIME: command to install this language runtime in ANY container",
  "rebuildCmd": "REQUIRED: command to rebuild after code changes (for static builds)"
}

MANDATORY devCmd EXAMPLES (you MUST return one of these or similar):
- Flutter: "flutter build web && python3 -m http.server 8080 --directory build/web --bind 0.0.0.0"
  ⚠️ NEVER use "flutter run" for Flutter - it hangs! ALWAYS use build+serve pattern above.
- React/Vite: "npm run dev -- --host 0.0.0.0 --port 3000"
- Next.js: "npm run dev"
- Express: "npm run dev || npm start"
- Python Flask: "flask run --host=0.0.0.0 --port=5000"
- Python Django: "python manage.py runserver 0.0.0.0:8000"
- FastAPI: "uvicorn main:app --host 0.0.0.0 --port 8000"
- Go: "go run ."
- Rust: "cargo run"

🔥 MANDATORY rebuildCmd - Command to rebuild the project after code changes.
This is used for frameworks with static builds where the dev server serves pre-built files.
After code is merged, rebuildCmd runs to update the served files.
EXAMPLES:
- Flutter (static build): "flutter build web" (rebuilds build/web which python http.server serves)
- React/Vite (HMR): "echo 'HMR handles rebuild'" (dev server has hot reload, no manual rebuild needed)
- Next.js (HMR): "echo 'HMR handles rebuild'" (dev server has hot reload)
- Express/Node: "echo 'No rebuild needed'" (watches files automatically)
- Python Flask/Django: "echo 'No rebuild needed'" (auto-reloads)
- Go: "go build ." (if using static binary)
- Rust: "cargo build"
NOTE: For frameworks with Hot Module Replacement (HMR), use "echo 'HMR handles rebuild'" since the dev server handles updates automatically.

OPTIONAL testCmd - If the framework/language generates default tests on project creation, include the test command.
This validates the project is correctly set up before developers start writing code.
Examples:
- Flutter: "flutter test" (flutter create generates widget_test.dart)
- React (CRA): "npm test -- --watchAll=false" (create-react-app generates App.test.js)
- Go: "go test ./..." (go modules have test support built-in)
- Python: "pytest" or "python -m pytest" (if pytest configured)
- Rust: "cargo test" (Cargo projects have test support built-in)
- Express/Node: Only if package.json has a "test" script that isn't "exit 0"

🔥 CRITICAL: runtimeInstallCmd - Command to install THIS language's runtime in ANY Docker container.
This is REQUIRED for multi-repo projects where different repos use different languages.
Example: If Flutter frontend and Node.js backend share one container, Node.js repo needs npm installed.

⚡ LIGHTWEIGHT PRINCIPLE: Always use DIRECT BINARY DOWNLOADS when possible (faster, no apt-get update).
MANDATORY examples (FAST - direct binaries):
- Node.js/TypeScript: "which node || (ARCH=$(uname -m) && NODE_ARCH=$([ \"$ARCH\" = \"aarch64\" ] && echo \"arm64\" || echo \"x64\") && curl -fsSL \"https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz\" | tar -xJ -C /usr/local --strip-components=1)"
- Go: "which go || (ARCH=$(uname -m) && GO_ARCH=$([ \"$ARCH\" = \"aarch64\" ] && echo \"arm64\" || echo \"amd64\") && curl -fsSL \"https://go.dev/dl/go1.22.0.linux-$GO_ARCH.tar.gz\" | tar -xz -C /usr/local && export PATH=$PATH:/usr/local/go/bin)"
- Rust: "which cargo || (curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y)"
- Flutter/Dart: Already in Flutter container - use "echo 'Flutter already installed'"

FALLBACK (only if binary not available):
- Python: "which python3 || (apt-get update && apt-get install -y python3 python3-pip python3-venv)"
- Java: "which java || (apt-get update && apt-get install -y openjdk-17-jdk)"

IMPORTANT: The container may be Ubuntu, Flutter, Node, or ANY base image. runtimeInstallCmd must work regardless!

CRITICAL NAMING RULES:
- Dart/Flutter: Use snake_case (lowercase with underscores). "app-pasos-frontend" → "app_pasos_frontend"
- npm/Node.js: Use kebab-case (lowercase with hyphens). "AppPasos" → "app-pasos"
- Python: Use snake_case. "my-project" → "my_project"
- Rust/Cargo: Use snake_case. "my-app" → "my_app"
- Go: Use lowercase, no special chars. "MyApp" → "myapp"

CRITICAL: createCmd MUST include the --project-name flag with the VALID project name for that language!
Example for Flutter: "flutter create . --project-name app_pasos_frontend --org com.example --overwrite"

HOST SYSTEM INFORMATION:
- OS: Debian 12 Bookworm
- Architecture: ARM64 (aarch64)
- All Docker images MUST support linux/arm64 architecture!

DOCKER IMAGES - MUST BE ARM64 COMPATIBLE:
- Flutter/Dart → ghcr.io/cirruslabs/flutter:3.24.0 (multi-arch ARM64/AMD64, stable version)
- Node/TypeScript → node:20-bookworm (OFFICIAL, multi-arch)
- Python → python:3.12-bookworm (OFFICIAL, multi-arch)
- Go → golang:1.22-bookworm (OFFICIAL, multi-arch)
- Rust → rust:1.75-bookworm (OFFICIAL, multi-arch)
- Java → eclipse-temurin:21-jdk (OFFICIAL Adoptium, multi-arch)
- .NET/C# → mcr.microsoft.com/dotnet/sdk:8.0 (OFFICIAL Microsoft, multi-arch)
- Ruby → ruby:3.3-bookworm (OFFICIAL, multi-arch)
- PHP → php:8.3-apache (OFFICIAL, multi-arch)
- Unknown → ubuntu:22.04 (OFFICIAL, multi-arch)

CRITICAL: Host is ARM64! All images MUST support linux/arm64.
CRITICAL: For Flutter, use ghcr.io/cirruslabs/flutter:3.24.0 (NOT :stable which has template bugs).

JSON RESPONSE:`;

    try {
      const client = this.getClient();
      const response = await client.messages.create({
        model: getExplicitModelId('haiku'),
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type');
      }

      // Strip markdown code fences if present
      let jsonStr = content.text.trim();
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      const parsed = JSON.parse(jsonStr);

      console.log(`🔍 [LanguageDetection] Detected: ${parsed.language}/${parsed.framework} → ${parsed.dockerImage}`);
      console.log(`   Confidence: ${parsed.confidence} | Reasoning: ${parsed.reasoning}`);
      if (parsed.projectName) {
        console.log(`   Project name: ${parsed.projectName}`);
      }
      if (parsed.createCmd) {
        console.log(`   Create command: ${parsed.createCmd}`);
      }
      if (parsed.devCmd) {
        console.log(`   Dev command: ${parsed.devCmd}`);
        console.log(`   Dev port: ${parsed.devPort}`);
      } else {
        console.warn(`   ⚠️ NO devCmd returned by LLM!`);
      }
      if (parsed.testCmd) {
        console.log(`   Test command: ${parsed.testCmd}`);
      }
      if (parsed.runtimeInstallCmd) {
        console.log(`   Runtime install: ${parsed.runtimeInstallCmd.substring(0, 60)}...`);
      } else {
        console.warn(`   ⚠️ NO runtimeInstallCmd returned - multi-runtime may fail!`);
      }
      if (parsed.rebuildCmd) {
        console.log(`   Rebuild command: ${parsed.rebuildCmd}`);
      }

      return {
        primary: {
          language: parsed.language || 'unknown',
          framework: parsed.framework || 'unknown',
          dockerImage: parsed.dockerImage || 'ubuntu:22.04',
          ecosystem: parsed.ecosystem || parsed.language || 'unknown',
          confidence: parsed.confidence || 'medium',
          reasoning: parsed.reasoning || '',
          // Project setup commands (100% LLM-determined)
          checkFile: parsed.checkFile || undefined,
          projectName: parsed.projectName || undefined, // 🔥 LLM-determined valid name
          createCmd: parsed.createCmd || undefined,
          installCmd: parsed.installCmd || undefined,
          devCmd: parsed.devCmd || undefined,
          devPort: typeof parsed.devPort === 'number' ? parsed.devPort : undefined,
          testCmd: parsed.testCmd || undefined, // 🔥 AGNOSTIC: Optional test command
          runtimeInstallCmd: parsed.runtimeInstallCmd || undefined, // 🔥 Install runtime in any container
          rebuildCmd: parsed.rebuildCmd || undefined, // 🔥 AGNOSTIC: Rebuild command for static builds
        },
        rawResponse: jsonStr,
      };
    } catch (error: any) {
      console.error(`❌ [LanguageDetection] Failed: ${error.message}`);

      // Fallback to basic keyword detection
      return this.fallbackDetection(taskDescription);
    }
  }

  /**
   * Fallback detection using simple keyword matching
   * Only used if LLM fails
   */
  private fallbackDetection(description: string): DetectionResult {
    const lower = description.toLowerCase();

    // Simple keyword matching as fallback (includes setup commands)
    const patterns: Array<{ keywords: string[]; result: DetectedLanguage }> = [
      {
        keywords: ['flutter', 'dart', 'pubspec'],
        result: {
          language: 'dart',
          framework: 'flutter',
          dockerImage: 'ghcr.io/cirruslabs/flutter:3.24.0',
          ecosystem: 'flutter',
          confidence: 'medium',
          reasoning: 'Fallback: detected flutter/dart keywords',
          checkFile: 'pubspec.yaml',
          createCmd: 'flutter create . --org com.example --project-name app --overwrite',
          installCmd: 'flutter pub get',
          devCmd: 'flutter build web && python3 -m http.server 8080 --directory build/web --bind 0.0.0.0',
          devPort: 8080,
          testCmd: 'flutter test',
          runtimeInstallCmd: 'echo "Flutter already in container"', // Flutter container has dart/flutter
          rebuildCmd: 'flutter clean && flutter build web', // Clean cache + rebuild static files
        },
      },
      {
        keywords: ['react', 'next', 'nextjs', 'typescript', 'node'],
        result: {
          language: 'typescript',
          framework: 'react',
          dockerImage: 'node:20-bookworm',
          ecosystem: 'node',
          confidence: 'medium',
          reasoning: 'Fallback: detected react/node keywords',
          checkFile: 'package.json',
          createCmd: 'npm init -y',
          installCmd: 'npm install',
          devCmd: 'npm run dev || npm start',
          devPort: 3000,
          // 🔥 Install Node.js in ANY container (works on Ubuntu, Flutter, Python, etc.)
          runtimeInstallCmd: 'which node || (ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && curl -fsSL "https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1)',
          rebuildCmd: "echo 'HMR handles rebuild'", // Node dev servers have hot reload
        },
      },
      {
        keywords: ['python', 'django', 'fastapi', 'flask'],
        result: {
          language: 'python',
          framework: 'unknown',
          dockerImage: 'python:3.12-bookworm',
          ecosystem: 'python',
          confidence: 'medium',
          reasoning: 'Fallback: detected python keywords',
          checkFile: 'requirements.txt',
          installCmd: 'pip install -r requirements.txt',
          devCmd: 'python -m flask run --host=0.0.0.0 --port=5000 || python manage.py runserver 0.0.0.0:8000',
          devPort: 5000,
          // 🔥 Install Python in ANY container
          runtimeInstallCmd: 'which python3 || (apt-get update && apt-get install -y python3 python3-pip python3-venv)',
          rebuildCmd: "echo 'Python auto-reloads'", // Flask/Django dev servers auto-reload
        },
      },
      {
        keywords: ['golang', 'go ', ' go,'],
        result: {
          language: 'go',
          framework: 'unknown',
          dockerImage: 'golang:1.21-bookworm',
          ecosystem: 'go',
          confidence: 'medium',
          reasoning: 'Fallback: detected go keywords',
          checkFile: 'go.mod',
          createCmd: 'go mod init app',
          installCmd: 'go mod download',
          devCmd: 'go run .',
          devPort: 8080,
          testCmd: 'go test ./...',
          // 🔥 Install Go in ANY container (detect arch dynamically)
          runtimeInstallCmd: 'which go || (ARCH=$(uname -m) && GO_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") && curl -fsSL "https://go.dev/dl/go1.22.0.linux-$GO_ARCH.tar.gz" | tar -xz -C /usr/local && ln -sf /usr/local/go/bin/go /usr/bin/go)',
          rebuildCmd: 'go build .', // Rebuild binary after code changes
        },
      },
      {
        keywords: ['rust', 'cargo'],
        result: {
          language: 'rust',
          framework: 'unknown',
          dockerImage: 'rust:1.75-bookworm',
          ecosystem: 'rust',
          confidence: 'medium',
          reasoning: 'Fallback: detected rust keywords',
          checkFile: 'Cargo.toml',
          createCmd: 'cargo init --force',
          installCmd: 'cargo fetch',
          devCmd: 'cargo run',
          devPort: 8080,
          testCmd: 'cargo test',
          // 🔥 Install Rust in ANY container
          runtimeInstallCmd: 'which cargo || (apt-get update && apt-get install -y curl && curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source $HOME/.cargo/env)',
          rebuildCmd: 'cargo build', // Rebuild binary after code changes
        },
      },
    ];

    for (const pattern of patterns) {
      if (pattern.keywords.some(kw => lower.includes(kw))) {
        console.log(`🔍 [LanguageDetection] Fallback detected: ${pattern.result.language}`);
        return { primary: pattern.result };
      }
    }

    // Ultimate fallback
    return {
      primary: {
        language: 'unknown',
        framework: 'unknown',
        dockerImage: 'ubuntu:22.04',
        ecosystem: 'unknown',
        confidence: 'low',
        reasoning: 'No language detected from description',
      },
    };
  }

  /**
   * Get Docker image for a detected language
   * Called by SandboxService/SandboxPoolService
   */
  getDockerImage(detected: DetectedLanguage): string {
    return detected.dockerImage;
  }

  /**
   * Detect language PER REPO using file-based detection FIRST, then LLM fallback
   *
   * PRIORITY:
   * 1. File-based detection (package.json, pubspec.yaml, etc.)
   * 2. LLM detection if no files found
   *
   * 🔥 ALSO: Resolves port conflicts between repos!
   *
   * @param taskDescription - Task description for LLM fallback
   * @param repos - Array of {name, type} for each repo
   * @param workspacePath - Path to workspace for file detection
   */
  async detectPerRepoWithFiles(
    taskDescription: string,
    repos: Array<{ name: string; type: string }>,
    workspacePath: string
  ): Promise<Record<string, DetectedLanguage>> {
    const result: Record<string, DetectedLanguage> = {};

    for (const repo of repos) {
      const repoPath = path.join(workspacePath, repo.name);

      console.log(`🔍 [LanguageDetection] Detecting for repo: ${repo.name}`);

      // PRIORITY 1: File-based detection (radiography)
      const fileDetected = this.detectFromFiles(repoPath, repo.name);

      if (fileDetected) {
        console.log(`   ✅ File-based: ${fileDetected.language}/${fileDetected.framework}`);
        result[repo.name] = fileDetected;
        continue;
      }

      // PRIORITY 2: LLM detection
      console.log(`   🤖 Using LLM fallback for ${repo.name}...`);
      try {
        const llmResult = await this.detectFromDescription(
          taskDescription,
          `Repository: ${repo.name}, Type: ${repo.type}`,
          [repo.name]
        );
        result[repo.name] = llmResult.primary;
      } catch (error: any) {
        console.warn(`   ⚠️ LLM detection failed: ${error.message}`);
        result[repo.name] = this.getDefaultFromRepoName(repo);
      }
    }

    // 🔥 FINAL SAFEGUARD: Ensure ALL repos have devCmd
    for (const repo of repos) {
      if (!result[repo.name] || !result[repo.name].devCmd) {
        console.log(`   ⚠️ No devCmd for ${repo.name}, applying default`);
        result[repo.name] = this.getDefaultFromRepoName(repo);
      }
    }

    // 🔥 PORT CONFLICT RESOLUTION: Ensure unique ports across all repos
    result[repos[0]?.name] && this.resolvePortConflicts(result);

    return result;
  }

  /**
   * 🔥 Resolve port conflicts between repos
   * Ensures each repo gets a unique port
   */
  private resolvePortConflicts(configs: Record<string, DetectedLanguage>): void {
    const usedPorts = new Set<number>();
    const portAssignments: Array<{ repoName: string; port: number }> = [];

    // First pass: collect all ports and detect conflicts
    for (const [repoName, config] of Object.entries(configs)) {
      const port = config.devPort || 3000;
      portAssignments.push({ repoName, port });
    }

    // Sort by priority: Flutter/frontend first (gets 8080), then backend (gets 4001)
    portAssignments.sort((a, b) => {
      const aName = a.repoName.toLowerCase();
      const bName = b.repoName.toLowerCase();
      // Flutter gets priority for 8080
      if (aName.includes('flutter')) return -1;
      if (bName.includes('flutter')) return 1;
      // Frontend gets priority over backend
      if (aName.includes('frontend') && !bName.includes('frontend')) return -1;
      if (bName.includes('frontend') && !aName.includes('frontend')) return 1;
      return 0;
    });

    // Second pass: assign unique ports
    const FALLBACK_PORTS = [8080, 4001, 3000, 5000, 5173, 8000, 8001, 9000];

    for (const assignment of portAssignments) {
      const config = configs[assignment.repoName];
      let port = config.devPort || 3000;

      // If port is already used, find a new one
      if (usedPorts.has(port)) {
        const repoName = assignment.repoName.toLowerCase();

        // Smart port selection based on repo type
        if (repoName.includes('backend') || repoName.includes('api') || repoName.includes('server')) {
          // Backend should use 4001
          port = 4001;
        } else if (repoName.includes('flutter')) {
          // Flutter should use 8080
          port = 8080;
        } else if (repoName.includes('frontend') || repoName.includes('web')) {
          // Other frontend should use 3000 or 5000
          port = 3000;
        }

        // If still conflict, find next available
        while (usedPorts.has(port)) {
          const nextPort = FALLBACK_PORTS.find(p => !usedPorts.has(p));
          if (nextPort) {
            port = nextPort;
          } else {
            port = 9000 + usedPorts.size;
          }
        }

        // Update the config with new port
        console.log(`   🔄 Port conflict: ${assignment.repoName} ${config.devPort} → ${port}`);
        config.devPort = port;

        // Update devCmd with new port
        if (config.devCmd) {
          config.devCmd = this.updateDevCmdPort(config.devCmd, port, config.ecosystem);
        }
      }

      usedPorts.add(port);
    }

    console.log(`   ✅ Final port assignments:`);
    for (const [repoName, config] of Object.entries(configs)) {
      console.log(`      ${repoName}: ${config.devPort}`);
    }
  }

  /**
   * Update devCmd to use a specific port
   */
  private updateDevCmdPort(devCmd: string, port: number, ecosystem: string): string {
    // Flutter
    if (devCmd.includes('flutter') || devCmd.includes('http.server')) {
      return devCmd.replace(/--web-port=\d+/, `--web-port=${port}`)
                   .replace(/http\.server \d+/, `http.server ${port}`);
    }

    // Node.js
    if (ecosystem === 'node') {
      // Express/generic node
      if (devCmd.includes('PORT=')) {
        return devCmd.replace(/PORT=\d+/g, `PORT=${port}`);
      }
      // Vite/React
      if (devCmd.includes('--port')) {
        return devCmd.replace(/--port[= ]\d+/, `--port ${port}`);
      }
      // Add PORT prefix if not present
      if (!devCmd.includes('PORT=')) {
        return `PORT=${port} ${devCmd}`;
      }
    }

    // Python
    if (devCmd.includes('--port=') || devCmd.includes('-p ')) {
      return devCmd.replace(/--port[= ]\d+/, `--port=${port}`)
                   .replace(/-p \d+/, `-p ${port}`);
    }

    return devCmd;
  }

  /**
   * Detect language from files in the repo (radiography)
   */
  private detectFromFiles(repoPath: string, repoName: string): DetectedLanguage | null {
    // Check if directory exists
    if (!fs.existsSync(repoPath)) {
      console.log(`   📁 Directory doesn't exist: ${repoPath}`);
      return null;
    }

    // File-based detection patterns
    const filePatterns: Array<{ file: string; result: DetectedLanguage }> = [
      {
        file: 'pubspec.yaml',
        result: this.detectFlutterFromPubspec(repoPath, repoName),
      },
      {
        file: 'package.json',
        result: this.detectNodeFromPackageJson(repoPath, repoName),
      },
      {
        file: 'go.mod',
        result: {
          language: 'go',
          framework: 'unknown',
          dockerImage: 'golang:1.22-bookworm',
          ecosystem: 'go',
          confidence: 'high',
          reasoning: 'Detected go.mod file',
          checkFile: 'go.mod',
          installCmd: 'go mod download',
          devCmd: 'go run .',
          devPort: 8080,
          testCmd: 'go test ./...',
          runtimeInstallCmd: 'which go || (ARCH=$(uname -m) && GO_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "amd64") && curl -fsSL "https://go.dev/dl/go1.22.0.linux-$GO_ARCH.tar.gz" | tar -xz -C /usr/local && ln -sf /usr/local/go/bin/go /usr/bin/go)',
          rebuildCmd: 'go build .', // Rebuild binary after code changes
        },
      },
      {
        file: 'Cargo.toml',
        result: {
          language: 'rust',
          framework: 'unknown',
          dockerImage: 'rust:1.75-bookworm',
          ecosystem: 'rust',
          confidence: 'high',
          reasoning: 'Detected Cargo.toml file',
          checkFile: 'Cargo.toml',
          installCmd: 'cargo fetch',
          devCmd: 'cargo run',
          devPort: 8080,
          testCmd: 'cargo test',
          runtimeInstallCmd: 'which cargo || (apt-get update && apt-get install -y curl && curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source $HOME/.cargo/env)',
          rebuildCmd: 'cargo build', // Rebuild binary after code changes
        },
      },
      {
        file: 'requirements.txt',
        result: {
          language: 'python',
          framework: 'unknown',
          dockerImage: 'python:3.12-bookworm',
          ecosystem: 'python',
          confidence: 'high',
          reasoning: 'Detected requirements.txt file',
          checkFile: 'requirements.txt',
          installCmd: 'pip install -r requirements.txt',
          devCmd: 'python -m flask run --host=0.0.0.0 --port=5000',
          devPort: 5000,
          runtimeInstallCmd: 'which python3 || (apt-get update && apt-get install -y python3 python3-pip python3-venv)',
          rebuildCmd: "echo 'Python auto-reloads'", // Flask/Django dev servers auto-reload
        },
      },
      {
        file: 'pyproject.toml',
        result: {
          language: 'python',
          framework: 'unknown',
          dockerImage: 'python:3.12-bookworm',
          ecosystem: 'python',
          confidence: 'high',
          reasoning: 'Detected pyproject.toml file',
          checkFile: 'pyproject.toml',
          installCmd: 'pip install -e .',
          devCmd: 'python -m flask run --host=0.0.0.0 --port=5000',
          devPort: 5000,
          testCmd: 'pytest',
          runtimeInstallCmd: 'which python3 || (apt-get update && apt-get install -y python3 python3-pip python3-venv)',
          rebuildCmd: "echo 'Python auto-reloads'", // Flask/Django dev servers auto-reload
        },
      },
    ];

    for (const pattern of filePatterns) {
      const filePath = path.join(repoPath, pattern.file);
      if (fs.existsSync(filePath)) {
        console.log(`   📄 Found ${pattern.file}`);
        return pattern.result;
      }
    }

    return null;
  }

  /**
   * Detect Flutter/Dart from pubspec.yaml
   */
  private detectFlutterFromPubspec(_repoPath: string, repoName: string): DetectedLanguage {
    // Convert repo name to valid Dart project name (snake_case)
    const projectName = repoName.replace(/-/g, '_').toLowerCase();

    return {
      language: 'dart',
      framework: 'flutter',
      dockerImage: 'ghcr.io/cirruslabs/flutter:3.24.0',
      ecosystem: 'flutter',
      confidence: 'high',
      reasoning: 'Detected pubspec.yaml file',
      checkFile: 'pubspec.yaml',
      projectName: projectName,
      // 🔥 CLEAN before create: Remove lib/ and build/ to prevent corrupted files from previous runs
      createCmd: `rm -rf lib/ build/ .dart_tool/ && flutter create . --project-name ${projectName} --org com.example --overwrite`,
      installCmd: 'flutter pub get',
      // 🔥 VALIDATION: Run analyze before build to catch static errors
      // Note: LateInitializationError is RUNTIME, analyze won't catch it
      // But analyze catches many other issues (undefined vars, type errors, etc.)
      // 🔥 LIGHTWEIGHT: Build once + static serve (saves 4-8GB RAM)
      // 🔥 VERIFY: Check main.dart.js exists and has content after build
      devCmd: 'flutter build web && python3 -m http.server 8080 --directory build/web --bind 0.0.0.0',
      devPort: 8080,
      // 🔥 AGNOSTIC: flutter create generates test/widget_test.dart by default
      testCmd: 'flutter test',
      // 🔥 Flutter container already has dart/flutter installed
      runtimeInstallCmd: 'echo "Flutter already in container"',
      rebuildCmd: 'flutter clean && flutter build web', // Clean cache + rebuild static files
    };
  }

  /**
   * Detect Node.js from package.json
   */
  private detectNodeFromPackageJson(repoPath: string, _repoName: string): DetectedLanguage {
    let framework = 'unknown';
    let devCmd = 'npm run dev || npm start';
    let devPort = 3000;
    let testCmd: string | undefined;

    // Try to read package.json to determine framework
    const packageJsonPath = path.join(repoPath, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
        const scripts = packageJson.scripts || {};

        // 🔥 Check if this is a BACKEND (has express, fastify, mongoose, etc.)
        const isBackend = deps['express'] || deps['fastify'] || deps['koa'] ||
                          deps['mongoose'] || deps['mongodb'] || deps['pg'] ||
                          deps['typeorm'] || deps['prisma'] || deps['sequelize'];

        if (deps['next']) {
          framework = 'nextjs';
          devCmd = 'npm run dev -- -p 5000';
          devPort = 5000; // Avoid conflict with host port 3000/3001
        } else if (deps['vue']) {
          framework = 'vue';
          devCmd = 'npm run dev -- --host 0.0.0.0 --port 5173';
          devPort = 5173;
        } else if (isBackend) {
          // 🔥 ANY backend indicator → use port 4001
          framework = deps['express'] ? 'express' : deps['fastify'] ? 'fastify' : 'node-backend';
          devCmd = 'PORT=4001 npm run dev || PORT=4001 npm start';
          devPort = 4001; // Avoid conflict with agents-backend on 3001
        } else if (deps['react']) {
          framework = 'react';
          devCmd = 'npm run dev -- --host 0.0.0.0 --port 5000 || npm start';
          devPort = 5000; // Avoid conflict with host
        }

        // 🔥 AGNOSTIC: Check if package.json has a valid test script
        // Only set testCmd if test script exists and isn't a placeholder
        const testScript = scripts.test;
        if (testScript &&
            !testScript.includes('exit 0') &&
            !testScript.includes('no test') &&
            !testScript.includes('Error: no test')) {
          testCmd = 'npm test -- --watchAll=false 2>/dev/null || npm test';
        }
      }
    } catch (error) {
      // Ignore parsing errors
    }

    return {
      language: 'typescript',
      framework: framework,
      dockerImage: 'node:20-bookworm',
      ecosystem: 'node',
      confidence: 'high',
      reasoning: `Detected package.json (${framework})`,
      checkFile: 'package.json',
      installCmd: 'npm install',
      devCmd: devCmd,
      devPort: devPort,
      testCmd: testCmd,
      // 🔥 Install Node.js in ANY container (works on Ubuntu, Flutter, Python, etc.)
      runtimeInstallCmd: 'which node || (ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && curl -fsSL "https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1)',
      rebuildCmd: "echo 'HMR handles rebuild'", // Node dev servers have hot reload (Vite, Webpack, etc.)
    };
  }

  /**
   * Get default configuration based on repo name patterns
   */
  private getDefaultFromRepoName(repo: { name: string; type: string }): DetectedLanguage {
    const name = repo.name.toLowerCase();

    // Flutter patterns
    if (name.includes('flutter') || name.includes('dart')) {
      const projectName = repo.name.replace(/-/g, '_').toLowerCase();
      return {
        language: 'dart',
        framework: 'flutter',
        dockerImage: 'ghcr.io/cirruslabs/flutter:3.24.0',
        ecosystem: 'flutter',
        confidence: 'medium',
        reasoning: 'Detected flutter in repo name',
        checkFile: 'pubspec.yaml',
        projectName: projectName,
        // 🔥 CLEAN before create: Remove lib/ and build/ to prevent corrupted files from previous runs
        createCmd: `rm -rf lib/ build/ .dart_tool/ && flutter create . --project-name ${projectName} --org com.example --overwrite`,
        installCmd: 'flutter pub get',
        // 🔥 VALIDATION: Run analyze before build to catch static errors
        // 🔥 LIGHTWEIGHT: Build once + static serve (saves 4-8GB RAM)
        // 🔥 VERIFY: Check main.dart.js exists and has content after build
        devCmd: 'flutter build web && python3 -m http.server 8080 --directory build/web --bind 0.0.0.0',
        devPort: 8080,
        // 🔥 AGNOSTIC: flutter create generates test/widget_test.dart by default
        testCmd: 'flutter test',
        runtimeInstallCmd: 'echo "Flutter already in container"',
        rebuildCmd: 'flutter clean && flutter build web', // Clean cache + rebuild static files
      };
    }

    // Backend patterns - use 4001 to avoid conflict with agents-backend (3001)
    if (name.includes('backend') || name.includes('api') || name.includes('server')) {
      return {
        language: 'typescript',
        framework: 'express',
        dockerImage: 'node:20-bookworm',
        ecosystem: 'node',
        confidence: 'medium',
        reasoning: 'Detected backend pattern in repo name',
        checkFile: 'package.json',
        installCmd: 'npm install',
        devCmd: 'PORT=4001 npm run dev || PORT=4001 npm start',
        devPort: 4001,
        runtimeInstallCmd: 'which node || (ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && curl -fsSL "https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1)',
        rebuildCmd: "echo 'HMR handles rebuild'", // Node dev servers have hot reload
      };
    }

    // Frontend patterns
    if (name.includes('frontend') || name.includes('web') || name.includes('client')) {
      return {
        language: 'typescript',
        framework: 'react',
        dockerImage: 'node:20-bookworm',
        ecosystem: 'node',
        confidence: 'medium',
        reasoning: 'Detected frontend pattern in repo name',
        checkFile: 'package.json',
        installCmd: 'npm install',
        devCmd: 'npm run dev -- --host 0.0.0.0 --port 3000 || npm start',
        devPort: 3000,
        runtimeInstallCmd: 'which node || (ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && curl -fsSL "https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1)',
        rebuildCmd: "echo 'HMR handles rebuild'", // Vite/Webpack dev servers have hot reload
      };
    }

    // Default to Node.js
    return {
      language: 'typescript',
      framework: 'unknown',
      dockerImage: 'node:20-bookworm',
      ecosystem: 'node',
      confidence: 'low',
      reasoning: 'Default fallback',
      checkFile: 'package.json',
      installCmd: 'npm install',
      devCmd: 'npm run dev || npm start',
      devPort: 3000,
      runtimeInstallCmd: 'which node || (ARCH=$(uname -m) && NODE_ARCH=$([ "$ARCH" = "aarch64" ] && echo "arm64" || echo "x64") && curl -fsSL "https://nodejs.org/dist/v20.11.0/node-v20.11.0-linux-$NODE_ARCH.tar.xz" | tar -xJ -C /usr/local --strip-components=1)',
      rebuildCmd: "echo 'HMR handles rebuild'", // Node dev servers have hot reload
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const languageDetectionService = new LanguageDetectionService();
export default languageDetectionService;
