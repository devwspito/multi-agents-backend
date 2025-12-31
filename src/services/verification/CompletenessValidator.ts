/**
 * Completeness Validator
 *
 * Validates that ALL requirements from a story/epic were actually implemented.
 * This is the "did you do everything you were asked to do?" check.
 *
 * Key checks:
 * 1. Parse story requirements from description
 * 2. Verify each requirement has corresponding implementation
 * 3. Check that all mentioned endpoints exist
 * 4. Verify all UI elements mentioned are present
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface RequirementCheck {
  requirement: string;
  implemented: boolean;
  evidence?: string;
  missingIn?: string;
}

export interface CompletenessReport {
  storyId: string;
  storyTitle: string;
  totalRequirements: number;
  implementedCount: number;
  missingCount: number;
  completenessScore: number; // 0-100
  requirements: RequirementCheck[];
  isComplete: boolean;
  feedback: string;
}

export interface EndpointCheck {
  path: string;
  method: string;
  found: boolean;
  registeredInApp: boolean;
  file?: string;
}

export interface UIElementCheck {
  element: string;
  found: boolean;
  file?: string;
  hasOnClick?: boolean;
}

class CompletenessValidatorClass {

  /**
   * Validate completeness of a story implementation
   */
  async validateStory(
    repoPath: string,
    story: {
      id: string;
      title: string;
      description: string;
      acceptanceCriteria?: string[];
    }
  ): Promise<CompletenessReport> {
    console.log(`\n🔍 [Completeness] Validating story: ${story.id} - ${story.title}`);

    const requirements = this.extractRequirements(story);
    const checks: RequirementCheck[] = [];

    for (const req of requirements) {
      const check = await this.checkRequirement(repoPath, req);
      checks.push(check);
    }

    const implementedCount = checks.filter(c => c.implemented).length;
    const missingCount = checks.filter(c => !c.implemented).length;
    const completenessScore = requirements.length > 0
      ? Math.round((implementedCount / requirements.length) * 100)
      : 100;

    const isComplete = missingCount === 0;

    const feedback = this.generateFeedback(checks, isComplete);

    console.log(`   Score: ${completenessScore}% (${implementedCount}/${requirements.length} requirements)`);

    return {
      storyId: story.id,
      storyTitle: story.title,
      totalRequirements: requirements.length,
      implementedCount,
      missingCount,
      completenessScore,
      requirements: checks,
      isComplete,
      feedback,
    };
  }

  /**
   * Extract requirements from story description and acceptance criteria
   */
  private extractRequirements(story: {
    description: string;
    acceptanceCriteria?: string[]
  }): string[] {
    const requirements: string[] = [];

    // Extract from acceptance criteria
    if (story.acceptanceCriteria && story.acceptanceCriteria.length > 0) {
      requirements.push(...story.acceptanceCriteria);
    }

    // Extract API endpoints from description
    const endpointMatches = story.description.match(/(?:GET|POST|PUT|PATCH|DELETE)\s+\/[\w\/-]+/gi);
    if (endpointMatches) {
      requirements.push(...endpointMatches.map(e => `Endpoint: ${e}`));
    }

    // Extract "must" and "should" statements
    const mustMatches = story.description.match(/(?:must|should|needs to|has to)\s+[^.!?]+[.!?]/gi);
    if (mustMatches) {
      requirements.push(...mustMatches.map(m => m.trim()));
    }

    // Extract bullet points (- or *)
    const bulletMatches = story.description.match(/^[\s]*[-*]\s+[^\n]+/gm);
    if (bulletMatches) {
      requirements.push(...bulletMatches.map(b => b.replace(/^[\s]*[-*]\s+/, '').trim()));
    }

    // Extract numbered items
    const numberedMatches = story.description.match(/^\d+\.\s+[^\n]+/gm);
    if (numberedMatches) {
      requirements.push(...numberedMatches.map(n => n.replace(/^\d+\.\s+/, '').trim()));
    }

    // Deduplicate and filter short/empty
    const unique = [...new Set(requirements)]
      .filter(r => r.length > 10)
      .slice(0, 20); // Limit to 20 requirements

    return unique;
  }

  /**
   * Check if a specific requirement was implemented
   */
  private async checkRequirement(
    repoPath: string,
    requirement: string
  ): Promise<RequirementCheck> {
    // Endpoint requirements
    if (requirement.toLowerCase().startsWith('endpoint:')) {
      return this.checkEndpointRequirement(repoPath, requirement);
    }

    // Button/UI requirements
    if (requirement.toLowerCase().includes('button') ||
        requirement.toLowerCase().includes('click') ||
        requirement.toLowerCase().includes('form')) {
      return this.checkUIRequirement(repoPath, requirement);
    }

    // Function/method requirements
    if (requirement.toLowerCase().includes('function') ||
        requirement.toLowerCase().includes('method') ||
        requirement.toLowerCase().includes('implement')) {
      return this.checkCodeRequirement(repoPath, requirement);
    }

    // Generic keyword search
    return this.checkGenericRequirement(repoPath, requirement);
  }

  /**
   * Check if an endpoint requirement was implemented
   */
  private async checkEndpointRequirement(
    repoPath: string,
    requirement: string
  ): Promise<RequirementCheck> {
    // Parse "Endpoint: POST /api/users"
    const match = requirement.match(/(?:GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\/-]+)/i);
    if (!match) {
      return { requirement, implemented: false, missingIn: 'Could not parse endpoint' };
    }

    const [_method, endpointPath] = requirement.replace('Endpoint:', '').trim().split(/\s+/);

    try {
      // Search for route definition
      const grepResult = execSync(
        `grep -r "${endpointPath}" --include="*.ts" --include="*.js" "${repoPath}/src" 2>/dev/null || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      if (grepResult.includes(endpointPath)) {
        // Also check if route is registered in app.js/index.js
        const routeRegistered = this.checkRouteRegistered(repoPath, endpointPath);

        if (!routeRegistered) {
          return {
            requirement,
            implemented: false,
            evidence: `Route ${endpointPath} found but NOT registered in app.js`,
            missingIn: 'app.js or index.js'
          };
        }

        return {
          requirement,
          implemented: true,
          evidence: `Found route and registered in app`
        };
      }

      return {
        requirement,
        implemented: false,
        missingIn: 'No route file found for this endpoint'
      };
    } catch {
      return { requirement, implemented: false, missingIn: 'Error searching codebase' };
    }
  }

  /**
   * Check if a route is registered in app.js/index.js
   */
  private checkRouteRegistered(repoPath: string, endpointPath: string): boolean {
    const appFiles = ['app.js', 'app.ts', 'index.js', 'index.ts', 'server.js', 'server.ts'];
    const pathParts = endpointPath.split('/').filter(Boolean);
    const routeName = pathParts[1] || pathParts[0]; // e.g., "api" or "users"

    for (const appFile of appFiles) {
      const fullPath = path.join(repoPath, 'src', appFile);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        // Look for app.use('/api/...', ...) patterns
        if (content.includes(`'/${routeName}'`) ||
            content.includes(`"/${routeName}"`) ||
            content.includes(`\`/${routeName}\``)) {
          return true;
        }
      }
    }

    // Also check root level
    for (const appFile of appFiles) {
      const fullPath = path.join(repoPath, appFile);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.includes(`'/${routeName}'`) ||
            content.includes(`"/${routeName}"`)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check UI element requirements
   */
  private async checkUIRequirement(
    repoPath: string,
    requirement: string
  ): Promise<RequirementCheck> {
    // Extract key words from requirement
    const keywords = requirement
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !['must', 'should', 'have', 'with', 'that', 'this'].includes(w));

    try {
      // Search for button elements or onClick handlers
      const grepPattern = keywords.slice(0, 3).join('|');
      const grepResult = execSync(
        `grep -ri "(${grepPattern})" --include="*.tsx" --include="*.jsx" --include="*.vue" "${repoPath}/src" 2>/dev/null | head -20 || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      if (grepResult.trim()) {
        // Check if there's an onClick or event handler
        const hasHandler = grepResult.includes('onClick') ||
                          grepResult.includes('onSubmit') ||
                          grepResult.includes('@click') ||
                          grepResult.includes('handleClick');

        if (requirement.toLowerCase().includes('button') && !hasHandler) {
          return {
            requirement,
            implemented: false,
            evidence: 'Button found but no onClick handler',
            missingIn: 'onClick handler'
          };
        }

        return {
          requirement,
          implemented: true,
          evidence: `Found UI element matching keywords`
        };
      }

      return {
        requirement,
        implemented: false,
        missingIn: 'No UI component found for this requirement'
      };
    } catch {
      return { requirement, implemented: false, missingIn: 'Error searching UI files' };
    }
  }

  /**
   * Check code/function requirements
   */
  private async checkCodeRequirement(
    repoPath: string,
    requirement: string
  ): Promise<RequirementCheck> {
    const keywords = requirement
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4);

    try {
      // Search for function/method names
      const grepPattern = keywords.slice(0, 3).join('\\|');
      const grepResult = execSync(
        `grep -ri "\\(function\\|const\\|async\\).*\\(${grepPattern}\\)" --include="*.ts" --include="*.js" "${repoPath}/src" 2>/dev/null | head -10 || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      if (grepResult.trim()) {
        return {
          requirement,
          implemented: true,
          evidence: `Found code matching requirement keywords`
        };
      }

      return {
        requirement,
        implemented: false,
        missingIn: 'No implementation found'
      };
    } catch {
      return { requirement, implemented: false, missingIn: 'Error searching code' };
    }
  }

  /**
   * Generic requirement check using keyword search
   */
  private async checkGenericRequirement(
    repoPath: string,
    requirement: string
  ): Promise<RequirementCheck> {
    const keywords = requirement
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4 && !['must', 'should', 'have', 'with', 'that', 'this', 'when', 'then'].includes(w));

    if (keywords.length === 0) {
      return { requirement, implemented: true, evidence: 'No specific keywords to verify' };
    }

    try {
      // Search for any of the keywords
      const searchWord = keywords[0];
      const grepResult = execSync(
        `grep -ri "${searchWord}" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" "${repoPath}/src" 2>/dev/null | head -5 || true`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );

      if (grepResult.trim()) {
        return {
          requirement,
          implemented: true,
          evidence: `Found code matching "${searchWord}"`
        };
      }

      return {
        requirement,
        implemented: false,
        missingIn: `No code found for "${searchWord}"`
      };
    } catch {
      return { requirement, implemented: false, missingIn: 'Error searching' };
    }
  }

  /**
   * Generate feedback for the fixer agent
   */
  private generateFeedback(checks: RequirementCheck[], isComplete: boolean): string {
    if (isComplete) {
      return '✅ All requirements verified as implemented.';
    }

    const missing = checks.filter(c => !c.implemented);
    const lines = [
      `🚨 COMPLETENESS CHECK FAILED - ${missing.length} missing implementation(s):\n`
    ];

    for (const check of missing) {
      lines.push(`❌ ${check.requirement}`);
      if (check.missingIn) {
        lines.push(`   └── Missing in: ${check.missingIn}`);
      }
      if (check.evidence) {
        lines.push(`   └── Note: ${check.evidence}`);
      }
    }

    lines.push('\n📋 ACTION REQUIRED: Implement the missing requirements before merge.');

    return lines.join('\n');
  }
}

export const CompletenessValidator = new CompletenessValidatorClass();
