/**
 * LanguageDetectionService
 *
 * Uses LLM to detect language/framework from task description.
 * 100% language-agnostic - no hardcoded patterns.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getExplicitModelId } from '../config/ModelConfigurations.js';

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
  createCmd?: string;         // Command to create new project (e.g., "flutter create . --force")
  installCmd?: string;        // Command to install dependencies (e.g., "flutter pub get")
  devCmd?: string;            // Command to run dev server (e.g., "flutter run -d web-server")
  devPort?: number;           // Default port for dev server (e.g., 8080)
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
   * Uses Haiku for speed and cost efficiency
   */
  async detectFromDescription(
    taskDescription: string,
    additionalContext?: string
  ): Promise<DetectionResult> {
    const prompt = `Analyze this task description and determine the programming language, framework, and appropriate Docker image.

TASK DESCRIPTION:
${taskDescription}

${additionalContext ? `ADDITIONAL CONTEXT:\n${additionalContext}` : ''}

RESPOND WITH RAW JSON ONLY. NO MARKDOWN CODE BLOCKS. NO BACKTICKS. NO EXPLANATION. JUST THE JSON OBJECT:
{
  "language": "the primary programming language (e.g., dart, typescript, python, go, rust, java, kotlin, swift)",
  "framework": "the framework if mentioned (e.g., flutter, react, nextjs, django, fastapi, gin)",
  "dockerImage": "the appropriate Docker image for this stack",
  "ecosystem": "the ecosystem/runtime (e.g., flutter, node, python, jvm, go)",
  "confidence": "high|medium|low",
  "reasoning": "brief explanation of detection",
  "checkFile": "file that indicates project exists (e.g., pubspec.yaml, package.json, go.mod, Cargo.toml, requirements.txt)",
  "createCmd": "command to create a NEW empty project (use --overwrite for flutter/dart, --force for rust/cargo, appropriate flags for other languages)",
  "installCmd": "command to install dependencies",
  "devCmd": "command to run the dev server (must bind to 0.0.0.0 for Docker)",
  "devPort": "default port number for the dev server (integer)"
}

GUIDELINES:
- Docker images: Flutter→ghcr.io/cirruslabs/flutter:stable, Node→node:20-bookworm, Python→python:3.12-bookworm, Go→golang:1.21-bookworm, Rust→rust:1.75-bookworm, Java→eclipse-temurin:21-jdk
- createCmd MUST handle non-empty directories: use --overwrite for flutter/dart, --force for rust/cargo, -y for npm
- devCmd MUST bind to 0.0.0.0 (not localhost) for Docker container access
- If unknown language → use ubuntu:22.04 and null for commands

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
      if (parsed.createCmd) {
        console.log(`   Setup: checkFile=${parsed.checkFile}, createCmd=${parsed.createCmd}`);
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
}

// ============================================================================
// Singleton Export
// ============================================================================

export const languageDetectionService = new LanguageDetectionService();
export default languageDetectionService;
