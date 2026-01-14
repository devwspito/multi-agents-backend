/**
 * CodebaseDiscoveryService
 *
 * Discovers codebase patterns PROGRAMMATICALLY (not via agent).
 * This ensures we have reliable information about:
 * - Helper functions (createProject, createUser, etc.)
 * - Entity creation patterns
 * - Model relationships
 * - Anti-patterns to avoid
 *
 * This info is passed to agents so they KNOW what to use.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface HelperFunction {
  name: string;
  file: string;
  signature?: string;
  usage: string;
  antiPattern: string;
}

export interface EntityCreationRule {
  entity: string;
  modelFile?: string;
  mustUse?: string;
  mustNotUse: string;
  requiredRelationships?: string[];
}

export interface CodebaseKnowledge {
  helperFunctions: HelperFunction[];
  entityCreationRules: EntityCreationRule[];
  serviceClasses: string[];
  modelFiles: string[];
  discoveredAt: Date;
}

export class CodebaseDiscoveryService {
  /**
   * Discover all helper functions and patterns in a codebase
   */
  static async discoverCodebase(workspacePath: string): Promise<CodebaseKnowledge> {
    console.log(`\n🔍 [CodebaseDiscovery] Starting discovery in: ${workspacePath}`);

    const knowledge: CodebaseKnowledge = {
      helperFunctions: [],
      entityCreationRules: [],
      serviceClasses: [],
      modelFiles: [],
      discoveredAt: new Date(),
    };

    try {
      // 1. Find all model files
      knowledge.modelFiles = this.findModelFiles(workspacePath);
      console.log(`   📦 Found ${knowledge.modelFiles.length} model files`);

      // 2. Find helper functions (createX, deleteX, updateX)
      knowledge.helperFunctions = await this.findHelperFunctions(workspacePath);
      console.log(`   🔧 Found ${knowledge.helperFunctions.length} helper functions`);

      // 3. Find service classes
      knowledge.serviceClasses = this.findServiceClasses(workspacePath);
      console.log(`   🏭 Found ${knowledge.serviceClasses.length} service classes`);

      // 4. Generate entity creation rules based on findings
      knowledge.entityCreationRules = this.generateEntityCreationRules(
        knowledge.modelFiles,
        knowledge.helperFunctions
      );
      console.log(`   📋 Generated ${knowledge.entityCreationRules.length} entity creation rules`);

    } catch (error: any) {
      console.error(`   ❌ Discovery error: ${error.message}`);
    }

    console.log(`✅ [CodebaseDiscovery] Discovery complete\n`);
    return knowledge;
  }

  /**
   * Find model files in the codebase
   */
  private static findModelFiles(workspacePath: string): string[] {
    const modelFiles: string[] = [];

    const patterns = [
      '**/models/**/*.ts',
      '**/models/**/*.js',
      '**/entities/**/*.ts',
      '**/schema/**/*.ts',
    ];

    for (const pattern of patterns) {
      try {
        const result = execSync(
          `find "${workspacePath}" -path "*/node_modules" -prune -o -path "${pattern.replace('**/', '')}" -type f -print 2>/dev/null || true`,
          { encoding: 'utf8', timeout: 10000 }
        ).trim();

        if (result) {
          const files = result.split('\n').filter(f => f && !f.includes('node_modules'));
          modelFiles.push(...files);
        }
      } catch (e) {
        // Continue on error
      }
    }

    // Use glob fallback
    try {
      const result = execSync(
        `find "${workspacePath}" -type f \\( -name "*.ts" -o -name "*.js" \\) -path "*/models/*" ! -path "*/node_modules/*" 2>/dev/null || true`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (result) {
        const files = result.split('\n').filter(f => f);
        for (const file of files) {
          if (!modelFiles.includes(file)) {
            modelFiles.push(file);
          }
        }
      }
    } catch (e) {
      // Continue
    }

    return [...new Set(modelFiles)];
  }

  /**
   * Find helper functions like createProject, createUser, etc.
   */
  private static async findHelperFunctions(workspacePath: string): Promise<HelperFunction[]> {
    const helpers: HelperFunction[] = [];

    // Pattern to find helper function definitions
    // Looks for: export function createX, export async function createX, etc.
    const searchPatterns = [
      { pattern: 'export.*function\\s+create[A-Z]\\w*', type: 'create' },
      { pattern: 'export.*const\\s+create[A-Z]\\w*\\s*=', type: 'create' },
      { pattern: 'async\\s+create[A-Z]\\w*\\s*\\(', type: 'create' },
      { pattern: 'static.*create[A-Z]\\w*\\s*\\(', type: 'create' },
    ];

    for (const { pattern } of searchPatterns) {
      try {
        const result = execSync(
          `grep -r -n -E "${pattern}" "${workspacePath}" --include="*.ts" --include="*.js" 2>/dev/null | grep -v node_modules | head -50 || true`,
          { encoding: 'utf8', timeout: 15000 }
        ).trim();

        if (result) {
          const lines = result.split('\n').filter(l => l);

          for (const line of lines) {
            const match = line.match(/^([^:]+):(\d+):(.+)$/);
            if (match) {
              const [, filePath, , content] = match;

              // Extract function name
              const nameMatch = content.match(/create[A-Z]\w*/);
              if (nameMatch) {
                const funcName = nameMatch[0];

                // Check if we already have this function
                if (helpers.some(h => h.name === funcName && h.file === filePath)) {
                  continue;
                }

                // Determine the entity from function name
                const entityName = funcName.replace('create', '');

                helpers.push({
                  name: funcName,
                  file: filePath.replace(workspacePath + '/', ''),
                  signature: content.trim().substring(0, 100),
                  usage: `Use ${funcName}() instead of new ${entityName}()`,
                  antiPattern: `new ${entityName}() - misses setup logic that ${funcName}() provides`,
                });
              }
            }
          }
        }
      } catch (e) {
        // Continue on error
      }
    }

    return helpers;
  }

  /**
   * Find service classes
   */
  private static findServiceClasses(workspacePath: string): string[] {
    const services: string[] = [];

    try {
      const result = execSync(
        `grep -r -l "class.*Service" "${workspacePath}" --include="*.ts" 2>/dev/null | grep -v node_modules | head -30 || true`,
        { encoding: 'utf8', timeout: 10000 }
      ).trim();

      if (result) {
        const files = result.split('\n').filter(f => f);

        for (const file of files) {
          // Extract service class names from file
          try {
            const content = fs.readFileSync(file, 'utf8');
            const classMatches = content.match(/class\s+(\w+Service)/g);
            if (classMatches) {
              for (const match of classMatches) {
                const className = match.replace('class ', '');
                if (!services.includes(className)) {
                  services.push(className);
                }
              }
            }
          } catch (e) {
            // Skip unreadable files
          }
        }
      }
    } catch (e) {
      // Continue
    }

    return services;
  }

  /**
   * Generate entity creation rules based on discovered patterns
   */
  private static generateEntityCreationRules(
    modelFiles: string[],
    helperFunctions: HelperFunction[]
  ): EntityCreationRule[] {
    const rules: EntityCreationRule[] = [];

    // Create rules for each model that has a helper function
    for (const modelFile of modelFiles) {
      const modelName = path.basename(modelFile, path.extname(modelFile));

      // Skip index files
      if (modelName === 'index') continue;

      // Find matching helper function
      const helper = helperFunctions.find(h =>
        h.name.toLowerCase().includes(modelName.toLowerCase()) ||
        modelName.toLowerCase().includes(h.name.replace('create', '').toLowerCase())
      );

      if (helper) {
        rules.push({
          entity: modelName,
          modelFile: modelFile,
          mustUse: `${helper.name}() from ${helper.file}`,
          mustNotUse: `new ${modelName}() - use ${helper.name}() instead`,
          requiredRelationships: [], // Could be enhanced by parsing model file
        });
      } else {
        // Model without helper - warn about direct instantiation
        rules.push({
          entity: modelName,
          modelFile: modelFile,
          mustNotUse: `Be careful with new ${modelName}() - check if a helper function exists`,
        });
      }
    }

    return rules;
  }

  /**
   * Format knowledge for inclusion in agent prompts
   */
  static formatForPrompt(knowledge: CodebaseKnowledge): string {
    if (knowledge.helperFunctions.length === 0 && knowledge.entityCreationRules.length === 0) {
      return ''; // No patterns discovered
    }

    let output = `
## 🔧 DISCOVERED CODEBASE PATTERNS (MANDATORY TO FOLLOW)

**These patterns were discovered automatically from the codebase. You MUST use them.**

`;

    // Helper functions section
    if (knowledge.helperFunctions.length > 0) {
      output += `### Helper Functions Found (USE THESE!)

| Function | File | Usage |
|----------|------|-------|
`;
      for (const helper of knowledge.helperFunctions.slice(0, 15)) {
        output += `| \`${helper.name}()\` | ${helper.file} | ${helper.usage} |\n`;
      }

      output += `
**⚠️ ANTI-PATTERNS TO AVOID:**
`;
      for (const helper of knowledge.helperFunctions.slice(0, 10)) {
        output += `- ❌ \`${helper.antiPattern}\`\n`;
      }
    }

    // Entity creation rules
    if (knowledge.entityCreationRules.length > 0) {
      const rulesWithMustUse = knowledge.entityCreationRules.filter(r => r.mustUse);
      if (rulesWithMustUse.length > 0) {
        output += `
### Entity Creation Rules

| Entity | MUST Use | NEVER Use |
|--------|----------|-----------|
`;
        for (const rule of rulesWithMustUse.slice(0, 15)) {
          output += `| ${rule.entity} | \`${rule.mustUse}\` | \`${rule.mustNotUse}\` |\n`;
        }
      }
    }

    output += `
**🔴 Stories that don't follow these patterns will be REJECTED by Judge.**
`;

    return output;
  }

  /**
   * Format knowledge for architectureBrief JSON
   */
  static toArchitectureBriefFields(knowledge: CodebaseKnowledge): {
    helperFunctions: HelperFunction[];
    entityCreationRules: EntityCreationRule[];
  } {
    return {
      helperFunctions: knowledge.helperFunctions,
      entityCreationRules: knowledge.entityCreationRules,
    };
  }
}
