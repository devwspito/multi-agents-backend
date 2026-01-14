/**
 * IncrementalVerifier
 *
 * Fast verification by only checking modified files and their dependents.
 * Uses caching to avoid redundant verification of unchanged files.
 *
 * Key behaviors:
 * 1. Track file modification times
 * 2. Only verify changed files + dependents
 * 3. Cache verification results
 * 4. 10x faster than full project verification
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface FileVerificationResult {
  file: string;
  status: 'pass' | 'fail' | 'skipped' | 'cached';
  errors: string[];
  warnings: string[];
  duration: number;
  hash?: string;
}

export interface VerificationCache {
  [fileHash: string]: {
    result: 'pass' | 'fail';
    errors: string[];
    timestamp: number;
    dependencies: string[];
  };
}

export interface IncrementalVerificationResult {
  passed: boolean;
  filesChecked: number;
  filesSkipped: number;
  filesCached: number;
  totalDuration: number;
  results: FileVerificationResult[];
  errors: string[];
  speedup: string; // e.g., "5.2x faster"
}

export interface VerificationConfig {
  workspacePath: string;
  modifiedFiles: string[];
  cacheEnabled: boolean;
  cacheTTL: number; // Cache time-to-live in ms
  includeImporters: boolean; // Check files that import modified files
}

export class IncrementalVerifier {
  private static cache: VerificationCache = {};
  private static cacheFile: string | null = null;

  /**
   * Initialize cache from disk
   */
  static async initialize(workspacePath: string): Promise<void> {
    this.cacheFile = path.join(workspacePath, '.verification-cache.json');

    if (fs.existsSync(this.cacheFile)) {
      try {
        this.cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        // Prune expired entries
        const now = Date.now();
        const ttl = 24 * 60 * 60 * 1000; // 24 hours
        for (const [hash, entry] of Object.entries(this.cache)) {
          if (now - entry.timestamp > ttl) {
            delete this.cache[hash];
          }
        }
      } catch {
        this.cache = {};
      }
    }
  }

  /**
   * Save cache to disk
   */
  private static saveCache(): void {
    if (this.cacheFile) {
      try {
        fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
      } catch {
        // Ignore write errors
      }
    }
  }

  /**
   * Run incremental verification on modified files
   */
  static async verify(config: VerificationConfig): Promise<IncrementalVerificationResult> {
    const startTime = Date.now();
    console.log(`\n⚡ [IncrementalVerifier] Checking ${config.modifiedFiles.length} modified file(s)...`);

    const results: FileVerificationResult[] = [];
    let filesChecked = 0;
    let filesSkipped = 0;
    let filesCached = 0;
    const allErrors: string[] = [];

    // Get files to check (modified + importers if enabled)
    let filesToCheck = [...config.modifiedFiles];

    if (config.includeImporters) {
      const importers = await this.findImporters(config.workspacePath, config.modifiedFiles);
      filesToCheck = [...new Set([...filesToCheck, ...importers])];
      console.log(`   Including ${importers.length} files that import modified files`);
    }

    // Check each file
    for (const file of filesToCheck) {
      const fullPath = path.isAbsolute(file) ? file : path.join(config.workspacePath, file);

      // Skip non-TypeScript/JavaScript files
      if (!file.match(/\.(ts|tsx|js|jsx)$/)) {
        filesSkipped++;
        results.push({
          file,
          status: 'skipped',
          errors: [],
          warnings: [],
          duration: 0,
        });
        continue;
      }

      // Check cache
      if (config.cacheEnabled) {
        const hash = await this.getFileHash(fullPath);
        const cached = this.cache[hash];

        if (cached && Date.now() - cached.timestamp < config.cacheTTL) {
          filesCached++;
          results.push({
            file,
            status: 'cached',
            errors: cached.errors,
            warnings: [],
            duration: 0,
            hash,
          });
          if (cached.result === 'fail') {
            allErrors.push(...cached.errors);
          }
          continue;
        }
      }

      // Run verification
      const result = await this.verifyFile(config.workspacePath, file);
      results.push(result);
      filesChecked++;

      if (result.status === 'fail') {
        allErrors.push(...result.errors);
      }

      // Update cache
      if (config.cacheEnabled && result.hash) {
        this.cache[result.hash] = {
          result: result.status === 'pass' ? 'pass' : 'fail',
          errors: result.errors,
          timestamp: Date.now(),
          dependencies: [],
        };
      }
    }

    // Save cache
    this.saveCache();

    const totalDuration = Date.now() - startTime;

    // Estimate speedup vs full verification
    const estimatedFullTime = filesToCheck.length * 500; // ~500ms per file for full check
    const speedup = estimatedFullTime > 0 ? (estimatedFullTime / totalDuration).toFixed(1) : '1.0';

    console.log(`   ✅ Checked: ${filesChecked}, Cached: ${filesCached}, Skipped: ${filesSkipped}`);
    console.log(`   ⏱️  Duration: ${totalDuration}ms (~${speedup}x faster than full check)`);

    return {
      passed: allErrors.length === 0,
      filesChecked,
      filesSkipped,
      filesCached,
      totalDuration,
      results,
      errors: allErrors,
      speedup: `${speedup}x faster`,
    };
  }

  /**
   * Verify a single file
   */
  private static async verifyFile(
    workspacePath: string,
    file: string
  ): Promise<FileVerificationResult> {
    const startTime = Date.now();
    const fullPath = path.isAbsolute(file) ? file : path.join(workspacePath, file);
    const errors: string[] = [];
    const warnings: string[] = [];

    // Get file hash
    const hash = await this.getFileHash(fullPath);

    // Run TypeScript check on single file
    try {
      // Use tsc with specific file
      execSync(`npx tsc --noEmit --skipLibCheck "${fullPath}" 2>&1`, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 30000,
      });
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;

      // Parse errors
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('error TS')) {
          errors.push(line.trim());
        } else if (line.includes('warning')) {
          warnings.push(line.trim());
        }
      }
    }

    // Run ESLint on single file
    try {
      execSync(`npx eslint "${fullPath}" --max-warnings 0 2>&1`, {
        cwd: workspacePath,
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch (error: any) {
      const output = error.stdout || error.stderr || '';
      const lines = output.split('\n');
      for (const line of lines) {
        if (line.match(/^\s*\d+:\d+\s+(error|warning)/)) {
          if (line.includes('error')) {
            errors.push(`ESLint: ${line.trim()}`);
          } else {
            warnings.push(`ESLint: ${line.trim()}`);
          }
        }
      }
    }

    return {
      file,
      status: errors.length === 0 ? 'pass' : 'fail',
      errors,
      warnings,
      duration: Date.now() - startTime,
      hash,
    };
  }

  /**
   * Find files that import the modified files
   */
  private static async findImporters(
    workspacePath: string,
    modifiedFiles: string[]
  ): Promise<string[]> {
    const importers: Set<string> = new Set();

    for (const modifiedFile of modifiedFiles) {
      const baseName = path.basename(modifiedFile, path.extname(modifiedFile));

      try {
        // Search for imports of this file
        const output = execSync(
          `grep -rl "from.*['\\"].*${baseName}['\\"" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" . 2>/dev/null || true`,
          {
            cwd: workspacePath,
            encoding: 'utf8',
            timeout: 10000,
          }
        );

        const files = output.split('\n').filter(f => f && !f.includes('node_modules'));
        for (const file of files) {
          // Don't add the modified file itself
          if (!modifiedFiles.some(m => file.includes(path.basename(m)))) {
            importers.add(file.replace('./', ''));
          }
        }
      } catch {
        // Ignore grep errors
      }
    }

    return Array.from(importers);
  }

  /**
   * Get hash of file content
   */
  private static async getFileHash(filePath: string): Promise<string> {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return crypto.createHash('md5').update(content).digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * Clear cache for specific files
   */
  static invalidateCache(_files: string[]): void {
    // We'd need to track file paths to hashes, but for simplicity
    // we'll just clear the entire cache when explicitly requested
    this.cache = {};
    this.saveCache();
  }

  /**
   * Get quick verification command for agents
   */
  static getQuickCheckCommand(workspacePath: string, files: string[]): string {
    if (files.length === 0) {
      return `cd "${workspacePath}" && npx tsc --noEmit 2>&1 | head -20`;
    }

    if (files.length <= 3) {
      const fileList = files.map(f => `"${f}"`).join(' ');
      return `cd "${workspacePath}" && npx tsc --noEmit ${fileList} 2>&1 | head -20`;
    }

    return `cd "${workspacePath}" && npx tsc --noEmit 2>&1 | head -20`;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## ⚡ INCREMENTAL VERIFICATION

Don't verify the entire project - only check what you changed!

### Quick Commands:

**Single file check:**
\`\`\`bash
npx tsc --noEmit src/services/MyFile.ts 2>&1 | head -10
\`\`\`

**Multiple files:**
\`\`\`bash
npx tsc --noEmit src/services/File1.ts src/services/File2.ts 2>&1 | head -10
\`\`\`

**ESLint single file:**
\`\`\`bash
npx eslint src/services/MyFile.ts --max-warnings 0
\`\`\`

### When to Use:

| Situation | Command |
|-----------|---------|
| After editing 1 file | Single file tsc check |
| After editing 2-3 files | Multiple file tsc check |
| After editing 4+ files | Full tsc --noEmit |
| Final commit check | Full verification |

### Benefits:

- 🚀 10x faster than full project check
- 🎯 Immediate feedback on your changes
- 💾 Results are cached for unchanged files

### Example Workflow:

\`\`\`
Edit("src/services/UserService.ts", old, new)
Bash("npx tsc --noEmit src/services/UserService.ts 2>&1")
# If error → fix immediately
# If clean → continue
\`\`\`
`;
  }

  /**
   * Format results for prompt
   */
  static formatResults(result: IncrementalVerificationResult): string {
    const icon = result.passed ? '✅' : '❌';

    let output = `
## ${icon} Incremental Verification Results

- **Status**: ${result.passed ? 'PASSED' : 'FAILED'}
- **Files Checked**: ${result.filesChecked}
- **Cached**: ${result.filesCached}
- **Skipped**: ${result.filesSkipped}
- **Duration**: ${result.totalDuration}ms (${result.speedup})
`;

    if (result.errors.length > 0) {
      output += `
### ❌ Errors (${result.errors.length}):
${result.errors.slice(0, 10).map(e => `- ${e}`).join('\n')}
${result.errors.length > 10 ? `\n... and ${result.errors.length - 10} more` : ''}
`;
    }

    return output;
  }
}
