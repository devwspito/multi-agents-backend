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
  dockerImage: string;        // e.g., "ghcr.io/cirruslabs/flutter:stable"
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
  "dockerImage": "exact docker image (e.g., ghcr.io/cirruslabs/flutter:stable)",
  "ecosystem": "flutter|node|python|jvm|go|rust",
  "confidence": "high|medium|low",
  "reasoning": "one sentence explanation",
  "checkFile": "pubspec.yaml|package.json|go.mod|Cargo.toml|requirements.txt",
  "projectName": "valid_project_name_for_language",
  "createCmd": "complete command to create project",
  "installCmd": "command to install dependencies",
  "devCmd": "REQUIRED: command to start dev server binding to 0.0.0.0",
  "devPort": 8080
}

MANDATORY devCmd EXAMPLES (you MUST return one of these or similar):
- Flutter: "flutter run -d web-server --web-port=8080 --web-hostname=0.0.0.0"
- React/Vite: "npm run dev -- --host 0.0.0.0 --port 3000"
- Next.js: "npm run dev"
- Express: "npm run dev || npm start"
- Python Flask: "flask run --host=0.0.0.0 --port=5000"
- Python Django: "python manage.py runserver 0.0.0.0:8000"
- FastAPI: "uvicorn main:app --host 0.0.0.0 --port 8000"
- Go: "go run ."
- Rust: "cargo run"

CRITICAL NAMING RULES:
- Dart/Flutter: Use snake_case (lowercase with underscores). "app-pasos-frontend" → "app_pasos_frontend"
- npm/Node.js: Use kebab-case (lowercase with hyphens). "AppPasos" → "app-pasos"
- Python: Use snake_case. "my-project" → "my_project"
- Rust/Cargo: Use snake_case. "my-app" → "my_app"
- Go: Use lowercase, no special chars. "MyApp" → "myapp"

CRITICAL: createCmd MUST include the --project-name flag with the VALID project name for that language!
Example for Flutter: "flutter create . --project-name app_pasos_frontend --org com.example --overwrite"

DOCKER IMAGES:
- Flutter/Dart → ghcr.io/cirruslabs/flutter:stable
- Node/TypeScript → node:20-bookworm
- Python → python:3.12-bookworm
- Go → golang:1.22-bookworm
- Rust → rust:1.75-bookworm
- Java → eclipse-temurin:21-jdk
- Unknown → ubuntu:22.04

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
          dockerImage: 'ghcr.io/cirruslabs/flutter:stable',
          ecosystem: 'flutter',
          confidence: 'medium',
          reasoning: 'Fallback: detected flutter/dart keywords',
          checkFile: 'pubspec.yaml',
          createCmd: 'flutter create . --org com.example --project-name app --overwrite',
          installCmd: 'flutter pub get',
          devCmd: 'flutter run -d web-server --web-port=8080 --web-hostname=0.0.0.0',
          devPort: 8080,
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

    return result;
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
      dockerImage: 'ghcr.io/cirruslabs/flutter:stable',
      ecosystem: 'flutter',
      confidence: 'high',
      reasoning: 'Detected pubspec.yaml file',
      checkFile: 'pubspec.yaml',
      projectName: projectName,
      createCmd: `flutter create . --project-name ${projectName} --org com.example --overwrite`,
      installCmd: 'flutter pub get',
      // 🔥 LIGHTWEIGHT: Build once + static serve (saves 4-8GB RAM)
      devCmd: 'flutter build web && cd build/web && python3 -m http.server 8080',
      devPort: 8080,
    };
  }

  /**
   * Detect Node.js from package.json
   */
  private detectNodeFromPackageJson(repoPath: string, _repoName: string): DetectedLanguage {
    let framework = 'unknown';
    let devCmd = 'npm run dev || npm start';
    let devPort = 3000;

    // Try to read package.json to determine framework
    const packageJsonPath = path.join(repoPath, 'package.json');
    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

        if (deps['next']) {
          framework = 'nextjs';
          devCmd = 'npm run dev -- -p 5000';
          devPort = 5000; // Avoid conflict with host port 3000/3001
        } else if (deps['react']) {
          framework = 'react';
          devCmd = 'npm run dev -- --host 0.0.0.0 --port 5000 || npm start';
          devPort = 5000; // Avoid conflict with host
        } else if (deps['express']) {
          framework = 'express';
          devCmd = 'PORT=4001 npm run dev || PORT=4001 npm start';
          devPort = 4001; // Avoid conflict with agents-backend on 3001
        } else if (deps['vue']) {
          framework = 'vue';
          devCmd = 'npm run dev -- --host 0.0.0.0';
          devPort = 5173;
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
        dockerImage: 'ghcr.io/cirruslabs/flutter:stable',
        ecosystem: 'flutter',
        confidence: 'medium',
        reasoning: 'Detected flutter in repo name',
        checkFile: 'pubspec.yaml',
        projectName: projectName,
        createCmd: `flutter create . --project-name ${projectName} --org com.example --overwrite`,
        installCmd: 'flutter pub get',
        // 🔥 LIGHTWEIGHT: Build once + static serve (saves 4-8GB RAM)
        devCmd: 'flutter build web && cd build/web && python3 -m http.server 8080',
        devPort: 8080,
      };
    }

    // Backend patterns
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
        devCmd: 'npm run dev || npm start',
        devPort: 3001,
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
    };
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const languageDetectionService = new LanguageDetectionService();
export default languageDetectionService;
