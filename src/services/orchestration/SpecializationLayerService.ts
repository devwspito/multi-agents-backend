import fs from 'fs';
import path from 'path';

/**
 * Specialization Layer Service
 *
 * Dynamically injects specialized knowledge into developer agents based on repository type.
 * This allows a single 'developer' agent to be enhanced with frontend, backend, or mobile expertise.
 *
 * Flow:
 * 1. Base developer prompt (generic)
 * 2. + Specialization layer (frontend-developer.md, backend-architect.md, etc.)
 * 3. = Specialized developer agent
 */

export type RepositoryType = 'frontend' | 'backend' | 'mobile' | 'fullstack' | 'library' | 'unknown';

interface SpecializationLayer {
  primary: string;
  secondary?: string;
}

export class SpecializationLayerService {
  private agentsDir: string;

  constructor() {
    // Path to .claude/agents directory
    this.agentsDir = path.join(process.cwd(), '.claude', 'agents');
  }

  /**
   * Get specialization layer for a repository type
   */
  getSpecializationLayer(repoType: RepositoryType): string {
    const layers = this.getLayersForType(repoType);

    let specialization = '';

    // Add primary layer
    if (layers.primary) {
      const primaryContent = this.readAgentFile(layers.primary);
      if (primaryContent) {
        specialization += `\n\n## 🎯 SPECIALIZATION: ${repoType.toUpperCase()}\n\n`;
        specialization += primaryContent;
      }
    }

    // Add secondary layer (optional)
    if (layers.secondary) {
      const secondaryContent = this.readAgentFile(layers.secondary);
      if (secondaryContent) {
        specialization += `\n\n## 🏗️ ARCHITECTURE GUIDANCE\n\n`;
        specialization += secondaryContent;
      }
    }

    return specialization;
  }

  /**
   * Determine which specialization files to use for each repository type
   */
  private getLayersForType(repoType: RepositoryType): SpecializationLayer {
    switch (repoType) {
      case 'frontend':
        return {
          primary: 'frontend-developer.md',
          secondary: 'premium/architect-review.md',
        };

      case 'backend':
        return {
          primary: 'senior-developer.md', // Use senior-developer as backend baseline
          secondary: 'premium/backend-architect.md',
        };

      case 'mobile':
        return {
          primary: 'senior-developer.md',
          // TODO: Add mobile-specific specialization when available
        };

      case 'fullstack':
        return {
          primary: 'premium/fullstack-developer.md',
        };

      case 'library':
        return {
          primary: 'senior-developer.md',
          secondary: 'premium/documentation-expert.md',
        };

      default:
        // No specialization for unknown types
        return { primary: '' };
    }
  }

  /**
   * Read agent file content
   */
  private readAgentFile(filename: string): string | null {
    try {
      const filePath = path.join(this.agentsDir, filename);

      if (!fs.existsSync(filePath)) {
        console.warn(`[SpecializationLayer] File not found: ${filename}`);
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');

      // Remove frontmatter (--- ... ---)
      const withoutFrontmatter = content.replace(/^---[\s\S]*?---\n/, '');

      return withoutFrontmatter.trim();
    } catch (error: any) {
      console.error(`[SpecializationLayer] Error reading ${filename}:`, error.message);
      return null;
    }
  }

  /**
   * Get enhanced prompt for a developer agent
   *
   * @param basePrompt - Base developer prompt from AgentDefinitions
   * @param repoType - Type of repository (frontend, backend, etc.)
   * @returns Enhanced prompt with specialization layer
   */
  getEnhancedPrompt(basePrompt: string, repoType: RepositoryType): string {
    if (repoType === 'unknown') {
      return basePrompt;
    }

    const specialization = this.getSpecializationLayer(repoType);

    if (!specialization) {
      return basePrompt;
    }

    return `${basePrompt}

${specialization}`;
  }

  /**
   * Detect repository type from package.json or project structure
   *
   * @param repoPath - Path to repository
   * @returns Detected repository type
   */
  static detectRepositoryType(repoPath: string): RepositoryType {
    try {
      const packageJsonPath = path.join(repoPath, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

        // Check dependencies for indicators
        const deps = {
          ...packageJson.dependencies,
          ...packageJson.devDependencies,
        };

        // Frontend indicators
        if (deps.react || deps.vue || deps['@angular/core'] || deps.svelte) {
          return 'frontend';
        }

        // Backend indicators
        if (deps.express || deps.fastify || deps['@nestjs/core'] || deps.koa) {
          return 'backend';
        }

        // Mobile indicators
        if (deps['react-native'] || deps['@react-native-community']) {
          return 'mobile';
        }

        // Fullstack indicators
        if (deps.next || deps.nuxt || deps['@remix-run/node']) {
          return 'fullstack';
        }

        // Library indicators
        if (packageJson.main || packageJson.module || packageJson.exports) {
          return 'library';
        }
      }

      // Check for common file structures
      if (fs.existsSync(path.join(repoPath, 'src', 'components'))) {
        return 'frontend';
      }

      if (fs.existsSync(path.join(repoPath, 'src', 'routes')) ||
          fs.existsSync(path.join(repoPath, 'src', 'controllers'))) {
        return 'backend';
      }

      return 'unknown';
    } catch (error) {
      console.error('[SpecializationLayer] Error detecting repository type:', error);
      return 'unknown';
    }
  }
}
