/**
 * BuildVerificationService - Automatic Code Verification
 *
 * Commercial-grade build verification that makes the system
 * competitive with Devin, Cursor, and Claude Code.
 *
 * This service ENFORCES verification at the orchestration level:
 * - Runs npm run typecheck / npm test / npm run lint automatically
 * - Parses errors and provides structured feedback
 * - Enables automatic retry with error context
 *
 * Philosophy: "Trust but verify" - even if agents claim success,
 * we verify independently before marking work complete.
 */

import { execSync } from 'child_process';
import { LogService } from './logging/LogService';

export interface VerificationCommand {
  name: string;
  command: string;
  timeout: number; // milliseconds
  required: boolean; // If required and fails, verification fails
  parseErrors: boolean; // Should we parse and structure errors
}

export interface VerificationError {
  file?: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
  rule?: string;
}

export interface VerificationResult {
  success: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
  errors: VerificationError[];
  timedOut: boolean;
}

export interface BuildVerificationReport {
  overall: boolean;
  results: Record<string, VerificationResult>;
  totalErrors: number;
  totalWarnings: number;
  summary: string;
  feedbackForAgent: string; // Structured feedback to give to the agent for retry
}

/**
 * Extended verification result that supports skipped commands
 */
export interface ExtendedVerificationResult extends VerificationResult {
  skipped?: boolean;
  skipReason?: string;
  warning?: string;
}

/**
 * Project configuration detected from reading project files
 * Language/framework agnostic - reads what the project defines
 */
export interface ProjectConfig {
  projectType: string;
  configFile: string;
  // Scripts/commands defined by the project itself
  scripts: {
    test?: string;
    build?: string;
    lint?: string;
    typecheck?: string;
  };
  // Detection results
  hasTestScript: boolean;
  hasTestFiles: boolean;
  testFilesFound: string[];
}

/**
 * Coverage thresholds for quality gates
 * These are industry-standard minimums
 */
export interface CoverageThresholds {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = {
  statements: 60,  // Minimum 60% statement coverage
  branches: 50,    // Minimum 50% branch coverage
  functions: 60,   // Minimum 60% function coverage
  lines: 60,       // Minimum 60% line coverage
};

/**
 * Default verification commands for common project types
 */
export const DEFAULT_VERIFICATION_COMMANDS: Record<string, VerificationCommand[]> = {
  'node-typescript': [
    {
      name: 'typecheck',
      command: 'npm run typecheck 2>&1 || npx tsc --noEmit 2>&1',
      timeout: 60000,
      required: true,
      parseErrors: true,
    },
    {
      name: 'lint',
      command: 'npm run lint 2>&1 || true',
      timeout: 60000,
      required: false,
      parseErrors: true,
    },
    {
      name: 'test',
      command: 'npm test -- --watchAll=false --passWithNoTests 2>&1',
      timeout: 300000,
      required: true,
      parseErrors: true,
    },
  ],
  'node-javascript': [
    {
      name: 'lint',
      command: 'npm run lint 2>&1 || true',
      timeout: 60000,
      required: false,
      parseErrors: true,
    },
    {
      name: 'test',
      command: 'npm test -- --watchAll=false --passWithNoTests 2>&1',
      timeout: 300000,
      required: true,
      parseErrors: true,
    },
  ],
  'python': [
    {
      name: 'typecheck',
      command: 'mypy . 2>&1 || true',
      timeout: 60000,
      required: false,
      parseErrors: true,
    },
    {
      name: 'lint',
      command: 'ruff check . 2>&1 || pylint . 2>&1 || true',
      timeout: 60000,
      required: false,
      parseErrors: true,
    },
    {
      name: 'test',
      command: 'pytest -v 2>&1 || python -m pytest -v 2>&1',
      timeout: 300000,
      required: true,
      parseErrors: true,
    },
  ],
  'go': [
    {
      name: 'build',
      command: 'go build ./... 2>&1',
      timeout: 120000,
      required: true,
      parseErrors: true,
    },
    {
      name: 'test',
      command: 'go test ./... -v 2>&1',
      timeout: 300000,
      required: true,
      parseErrors: true,
    },
  ],
};

class BuildVerificationServiceClass {
  /**
   * Configuration file patterns for different project types
   * Maps config file name → project type identifier
   */
  private readonly CONFIG_FILE_PATTERNS: Record<string, string> = {
    'package.json': 'node',
    'tsconfig.json': 'node-typescript',
    'requirements.txt': 'python',
    'pyproject.toml': 'python',
    'setup.py': 'python',
    'go.mod': 'go',
    'Cargo.toml': 'rust',
    'pom.xml': 'java-maven',
    'build.gradle': 'java-gradle',
    'build.gradle.kts': 'kotlin-gradle',
    'composer.json': 'php',
    'Gemfile': 'ruby',
    'mix.exs': 'elixir',
    'pubspec.yaml': 'dart',
    'CMakeLists.txt': 'cpp-cmake',
    'Makefile': 'make',
  };

  /**
   * Generic test file patterns (language agnostic)
   * These patterns work across most languages
   */
  private readonly TEST_FILE_PATTERNS: string[] = [
    '**/*.test.*',      // file.test.ts, file.test.js, file.test.py
    '**/*.spec.*',      // file.spec.ts, file.spec.rb
    '**/*_test.*',      // file_test.go, file_test.py
    '**/test_*.*',      // test_file.py
    '**/tests/**/*',    // tests/folder/
    '**/__tests__/**/*', // __tests__/folder/ (Jest convention)
    '**/test/**/*',     // test/folder/ (Java/Go convention)
    '**/*Test.java',    // MyClassTest.java
    '**/*Tests.cs',     // MyClassTests.cs
  ];

  /**
   * Analyze project configuration by READING project files
   * Language/framework agnostic - doesn't assume, reads what exists
   */
  async analyzeProject(repoPath: string): Promise<ProjectConfig> {
    const fs = require('fs');
    const path = require('path');

    // 1. Detect project type by which config files exist
    let projectType = 'unknown';
    let configFile = '';

    // Priority order matters (tsconfig.json before package.json)
    const priorityOrder = ['tsconfig.json', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];

    for (const file of priorityOrder) {
      if (fs.existsSync(path.join(repoPath, file))) {
        projectType = this.CONFIG_FILE_PATTERNS[file] || 'unknown';
        configFile = file;
        break;
      }
    }

    // Fallback: check other config files
    if (projectType === 'unknown') {
      for (const [file, type] of Object.entries(this.CONFIG_FILE_PATTERNS)) {
        if (fs.existsSync(path.join(repoPath, file))) {
          projectType = type;
          configFile = file;
          break;
        }
      }
    }

    // 2. Read scripts/commands from the config file
    const scripts = await this.extractScriptsFromConfig(repoPath, configFile);

    // 3. Search for test files generically
    const testFilesFound = await this.findTestFiles(repoPath);

    return {
      projectType,
      configFile,
      scripts,
      hasTestScript: !!scripts.test,
      hasTestFiles: testFilesFound.length > 0,
      testFilesFound,
    };
  }

  /**
   * Extract scripts/commands from project configuration file
   * Reads what the PROJECT defines, doesn't invent commands
   */
  private async extractScriptsFromConfig(
    repoPath: string,
    configFile: string
  ): Promise<ProjectConfig['scripts']> {
    const fs = require('fs');
    const path = require('path');

    const scripts: ProjectConfig['scripts'] = {};

    try {
      // Node.js projects (package.json)
      if (configFile === 'package.json' || configFile === 'tsconfig.json') {
        const pkgPath = path.join(repoPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          scripts.test = pkg.scripts?.test;
          scripts.build = pkg.scripts?.build;
          scripts.lint = pkg.scripts?.lint;
          scripts.typecheck = pkg.scripts?.typecheck || pkg.scripts?.['type-check'];
        }
      }

      // Python projects (pyproject.toml)
      if (configFile === 'pyproject.toml') {
        const tomlPath = path.join(repoPath, 'pyproject.toml');
        if (fs.existsSync(tomlPath)) {
          const content = fs.readFileSync(tomlPath, 'utf-8');
          // Basic TOML parsing for scripts section
          if (content.includes('[tool.pytest') || content.includes('pytest')) {
            scripts.test = 'pytest';
          }
          if (content.includes('[tool.mypy')) {
            scripts.typecheck = 'mypy .';
          }
          if (content.includes('[tool.ruff')) {
            scripts.lint = 'ruff check .';
          } else if (content.includes('[tool.pylint')) {
            scripts.lint = 'pylint .';
          }
        }
      }

      // Go projects (go.mod) - standard conventions
      if (configFile === 'go.mod') {
        scripts.test = 'go test ./...';
        scripts.build = 'go build ./...';
      }

      // Rust projects (Cargo.toml) - standard conventions
      if (configFile === 'Cargo.toml') {
        scripts.test = 'cargo test';
        scripts.build = 'cargo build';
        scripts.lint = 'cargo clippy';
      }

      // Java Maven (pom.xml)
      if (configFile === 'pom.xml') {
        scripts.test = 'mvn test';
        scripts.build = 'mvn package';
      }

      // Java/Kotlin Gradle
      if (configFile === 'build.gradle' || configFile === 'build.gradle.kts') {
        scripts.test = './gradlew test';
        scripts.build = './gradlew build';
      }

    } catch (error) {
      console.warn(`⚠️ [BuildVerification] Could not parse ${configFile}:`, error);
    }

    return scripts;
  }

  /**
   * Find test files using generic patterns
   * Works across all languages/frameworks
   */
  async findTestFiles(repoPath: string): Promise<string[]> {
    const { glob } = require('glob');

    try {
      const allTestFiles: string[] = [];

      for (const pattern of this.TEST_FILE_PATTERNS) {
        const matches = await glob(pattern, {
          cwd: repoPath,
          ignore: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/.git/**'],
          nodir: true,
        });
        allTestFiles.push(...matches);
      }

      // Deduplicate
      const uniqueFiles = [...new Set(allTestFiles)];

      console.log(`🔍 [BuildVerification] Found ${uniqueFiles.length} test files in ${repoPath}`);

      return uniqueFiles.slice(0, 20); // Limit to first 20 for reporting
    } catch (error) {
      console.warn(`⚠️ [BuildVerification] Error searching for test files:`, error);
      return [];
    }
  }

  /**
   * Get dynamic verification commands based on project analysis
   * Uses what the project defines, skips what's not configured
   */
  getVerificationCommands(config: ProjectConfig): VerificationCommand[] {
    const commands: VerificationCommand[] = [];

    // TypeCheck - only if project has it configured
    if (config.scripts.typecheck) {
      commands.push({
        name: 'typecheck',
        command: config.projectType.includes('node')
          ? 'npm run typecheck 2>&1'
          : `${config.scripts.typecheck} 2>&1`,
        timeout: 60000,
        required: true,
        parseErrors: true,
      });
    } else if (config.projectType === 'node-typescript') {
      // TypeScript project without typecheck script - use tsc directly
      commands.push({
        name: 'typecheck',
        command: 'npx tsc --noEmit 2>&1',
        timeout: 60000,
        required: true,
        parseErrors: true,
      });
    }

    // Lint - only if project has it configured
    if (config.scripts.lint) {
      commands.push({
        name: 'lint',
        command: config.projectType.includes('node')
          ? 'npm run lint 2>&1 || true'
          : `${config.scripts.lint} 2>&1 || true`,
        timeout: 60000,
        required: false,
        parseErrors: true,
      });
    }

    // Test - ONLY if project has test configuration
    if (config.hasTestScript) {
      let testCommand = '';

      if (config.projectType.includes('node')) {
        // Node.js: use npm test with appropriate flags
        testCommand = 'npm test -- --passWithNoTests 2>&1';
      } else if (config.scripts.test) {
        testCommand = `${config.scripts.test} 2>&1`;
      }

      if (testCommand) {
        commands.push({
          name: 'test',
          command: testCommand,
          timeout: 300000,
          required: true,
          parseErrors: true,
        });

        // Add coverage check for Node.js projects with Jest
        if (config.projectType.includes('node')) {
          commands.push({
            name: 'coverage',
            command: `npm test -- --coverage --passWithNoTests 2>&1 | grep -E "(Statements|Branches|Functions|Lines)" || echo "Coverage data not available"`,
            timeout: 300000,
            required: false, // Warning only
            parseErrors: true,
          });
        }
      }
    }
    // Note: If no test script, we DON'T add a test command
    // The verifyBuild method will report it as "skipped"

    // Security Audit - for Node.js projects
    if (config.projectType.includes('node')) {
      commands.push({
        name: 'security-audit',
        command: 'npm audit --audit-level=high 2>&1 || echo "AUDIT_ISSUES_FOUND"',
        timeout: 60000,
        required: false, // Warning only, doesn't fail the build
        parseErrors: true,
      });
    } else if (config.projectType === 'python') {
      // Python: use pip-audit or safety
      commands.push({
        name: 'security-audit',
        command: 'pip-audit 2>&1 || safety check 2>&1 || echo "No security audit tool available"',
        timeout: 60000,
        required: false,
        parseErrors: true,
      });
    }

    return commands;
  }

  /**
   * Legacy method for backwards compatibility
   */
  detectProjectType(repoPath: string): string {
    const fs = require('fs');
    const path = require('path');

    if (fs.existsSync(path.join(repoPath, 'tsconfig.json'))) {
      return 'node-typescript';
    }
    if (fs.existsSync(path.join(repoPath, 'package.json'))) {
      return 'node-javascript';
    }
    if (fs.existsSync(path.join(repoPath, 'requirements.txt')) ||
        fs.existsSync(path.join(repoPath, 'pyproject.toml'))) {
      return 'python';
    }
    if (fs.existsSync(path.join(repoPath, 'go.mod'))) {
      return 'go';
    }
    return 'unknown';
  }

  /**
   * Run a single verification command
   */
  async runVerificationCommand(
    repoPath: string,
    cmd: VerificationCommand
  ): Promise<VerificationResult> {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let exitCode = -1;
    let timedOut = false;

    try {
      console.log(`🔍 [BuildVerification] Running ${cmd.name}: ${cmd.command}`);

      const result = execSync(cmd.command, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: cmd.timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CI: 'true', // Tell tools we're in CI mode
          FORCE_COLOR: '0', // Disable color codes for cleaner parsing
        },
      });

      stdout = result || '';
      exitCode = 0;
    } catch (error: any) {
      stdout = error.stdout || '';
      stderr = error.stderr || error.message || '';
      exitCode = error.status || error.code || 1;
      // Check multiple indicators of timeout
      timedOut = error.killed ||
                 error.code === 'ETIMEDOUT' ||
                 error.signal === 'SIGTERM' ||
                 (error.message && error.message.includes('ETIMEDOUT'));

      if (timedOut) {
        console.warn(`⏰ [BuildVerification] ${cmd.name} timed out after ${cmd.timeout}ms`);
      }
    }

    const duration = Date.now() - startTime;
    const output = stdout + stderr;

    // Parse errors if needed
    const errors = cmd.parseErrors
      ? this.parseErrors(output, cmd.name)
      : [];

    const success = exitCode === 0 || (!cmd.required && exitCode !== 0);

    console.log(`${success ? '✅' : '❌'} [BuildVerification] ${cmd.name}: exitCode=${exitCode}, errors=${errors.length}, duration=${duration}ms`);

    return {
      success,
      command: cmd.command,
      exitCode,
      stdout,
      stderr,
      duration,
      errors,
      timedOut,
    };
  }

  /**
   * Parse errors from command output
   */
  parseErrors(output: string, _commandType: string): VerificationError[] {
    const errors: VerificationError[] = [];

    // TypeScript errors: src/file.ts(10,5): error TS2345: ...
    const tsErrorRegex = /([^(\s]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)/g;
    let match: RegExpExecArray | null;
    while ((match = tsErrorRegex.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4] as 'error' | 'warning',
        rule: match[5],
        message: match[6],
      });
    }

    // TSC style: src/file.ts:10:5 - error TS2345: ...
    const tscStyleRegex = /([^:\s]+):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)/g;
    while ((match = tscStyleRegex.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: match[4] as 'error' | 'warning',
        rule: match[5],
        message: match[6],
      });
    }

    // ESLint errors: /path/file.ts:10:5: Error: ...
    const eslintRegex = /([^:\s]+):(\d+):(\d+):\s*(Error|Warning):\s*(.+)\s*\[?([\w/-]+)?\]?/gi;
    while ((match = eslintRegex.exec(output)) !== null) {
      // Capture values to avoid null issues in callback
      const file = match[1];
      const line = parseInt(match[2]);
      const column = parseInt(match[3]);
      const severity = match[4].toLowerCase() as 'error' | 'warning';
      const message = match[5];
      const rule = match[6] || undefined;

      // Avoid duplicates
      if (!errors.find(e => e.file === file && e.line === line)) {
        errors.push({ file, line, column, severity, message, rule });
      }
    }

    // Jest test failures: FAIL src/file.test.ts
    const jestFailRegex = /FAIL\s+([^\s]+)/g;
    while ((match = jestFailRegex.exec(output)) !== null) {
      errors.push({
        file: match[1],
        severity: 'error',
        message: `Test file failed: ${match[1]}`,
      });
    }

    // Generic error patterns for other languages
    // Python: File "file.py", line 10, ...
    const pythonErrorRegex = /File "([^"]+)", line (\d+).*\n\s*(.+)/g;
    while ((match = pythonErrorRegex.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        severity: 'error',
        message: match[3],
      });
    }

    // Go: file.go:10:5: ...
    const goErrorRegex = /([^:\s]+\.go):(\d+):(\d+):\s*(.+)/g;
    while ((match = goErrorRegex.exec(output)) !== null) {
      errors.push({
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        severity: 'error',
        message: match[4],
      });
    }

    return errors;
  }

  /**
   * Run full verification for a repository
   * Now uses dynamic project analysis instead of hardcoded commands
   */
  async verifyBuild(
    repoPath: string,
    taskId: string,
    customCommands?: VerificationCommand[]
  ): Promise<BuildVerificationReport> {
    // 1. Analyze project to understand its configuration
    const projectConfig = await this.analyzeProject(repoPath);

    // 2. Get verification commands based on what the project actually has
    const commands = customCommands || this.getVerificationCommands(projectConfig);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔧 [BuildVerification] Starting verification for: ${repoPath}`);
    console.log(`   Project type: ${projectConfig.projectType} (config: ${projectConfig.configFile})`);
    console.log(`   Test script configured: ${projectConfig.hasTestScript ? '✅ YES' : '⏭️ NO'}`);
    console.log(`   Test files found: ${projectConfig.hasTestFiles ? `✅ ${projectConfig.testFilesFound.length} files` : '⏭️ NONE'}`);
    console.log(`   Commands to run: ${commands.length > 0 ? commands.map(c => c.name).join(', ') : '(none configured)'}`);
    console.log(`${'='.repeat(60)}`);

    const results: Record<string, ExtendedVerificationResult> = {};
    let totalErrors = 0;
    let totalWarnings = 0;
    let overallSuccess = true;

    // 3. Handle case where no test script is configured
    if (!projectConfig.hasTestScript) {
      // Report test as skipped, not failed
      results['test'] = {
        success: true, // Not a failure - just not configured
        skipped: true,
        skipReason: projectConfig.hasTestFiles
          ? 'Test files found but no test script configured in project'
          : 'No tests configured in this project',
        warning: projectConfig.hasTestFiles
          ? `Found ${projectConfig.testFilesFound.length} test file(s) but no test script. Consider adding a "test" script.`
          : undefined,
        command: 'N/A',
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 0,
        errors: [],
        timedOut: false,
      };

      console.log(`⏭️ [BuildVerification] test: SKIPPED - ${results['test'].skipReason}`);
      if (results['test'].warning) {
        console.log(`   ⚠️ ${results['test'].warning}`);
      }
    }

    // 4. Run configured verification commands
    for (const cmd of commands) {
      const result = await this.runVerificationCommand(repoPath, cmd);
      results[cmd.name] = result;

      const cmdErrors = result.errors.filter(e => e.severity === 'error').length;
      const cmdWarnings = result.errors.filter(e => e.severity === 'warning').length;

      totalErrors += cmdErrors;
      totalWarnings += cmdWarnings;

      if (!result.success && cmd.required) {
        overallSuccess = false;
      }
    }

    // Generate summary
    const summary = this.generateSummary(results, overallSuccess);
    const feedbackForAgent = this.generateAgentFeedback(results, totalErrors);

    // Log to LogService
    await LogService.info('Build verification completed', {
      taskId,
      category: 'system',
      metadata: {
        projectType: projectConfig.projectType,
        configFile: projectConfig.configFile,
        hasTestScript: projectConfig.hasTestScript,
        hasTestFiles: projectConfig.hasTestFiles,
        overallSuccess,
        totalErrors,
        totalWarnings,
        commandResults: Object.entries(results).map(([name, r]) => ({
          name,
          success: r.success,
          skipped: (r as ExtendedVerificationResult).skipped || false,
          exitCode: r.exitCode,
          errors: r.errors.length,
        })),
      },
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 [BuildVerification] SUMMARY`);
    console.log(`   Overall: ${overallSuccess ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`   Errors: ${totalErrors}`);
    console.log(`   Warnings: ${totalWarnings}`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      overall: overallSuccess,
      results,
      totalErrors,
      totalWarnings,
      summary,
      feedbackForAgent,
    };
  }

  /**
   * Generate human-readable summary
   * Now supports skipped commands
   */
  private generateSummary(results: Record<string, ExtendedVerificationResult>, overall: boolean): string {
    const lines: string[] = [];
    lines.push(`Build Verification: ${overall ? 'PASSED ✅' : 'FAILED ❌'}`);
    lines.push('');

    for (const [name, result] of Object.entries(results)) {
      // Handle skipped commands
      if (result.skipped) {
        lines.push(`⏭️ ${name}: SKIPPED - ${result.skipReason}`);
        if (result.warning) {
          lines.push(`   ⚠️ ${result.warning}`);
        }
        continue;
      }

      const status = result.success ? '✅' : '❌';
      const errorCount = result.errors.filter(e => e.severity === 'error').length;
      lines.push(`${status} ${name}: ${errorCount} errors (exit code: ${result.exitCode})`);

      if (!result.success && result.errors.length > 0) {
        // Show first 3 errors
        for (const error of result.errors.slice(0, 3)) {
          const location = error.file && error.line ? `${error.file}:${error.line}` : 'unknown';
          lines.push(`   - ${location}: ${error.message}`);
        }
        if (result.errors.length > 3) {
          lines.push(`   ... and ${result.errors.length - 3} more errors`);
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Generate structured feedback for the agent to fix issues
   * Now handles skipped commands appropriately
   */
  private generateAgentFeedback(results: Record<string, ExtendedVerificationResult>, totalErrors: number): string {
    const lines: string[] = [];

    // Check for warnings from skipped tests
    const skippedWithWarning = Object.entries(results).filter(([_, r]) => r.skipped && r.warning);

    if (totalErrors === 0 && skippedWithWarning.length === 0) {
      return 'All verification checks passed. No action needed.';
    }

    if (totalErrors === 0 && skippedWithWarning.length > 0) {
      lines.push(`✅ BUILD PASSED with notes:\n`);
      for (const [name, result] of skippedWithWarning) {
        lines.push(`⚠️ ${name}: ${result.warning}`);
      }
      return lines.join('\n');
    }

    lines.push(`🚨 BUILD VERIFICATION FAILED - ${totalErrors} errors to fix:\n`);

    for (const [name, result] of Object.entries(results)) {
      // Skip skipped commands in error feedback
      if (result.skipped) continue;

      if (!result.success && result.errors.length > 0) {
        lines.push(`\n## ${name.toUpperCase()} ERRORS:\n`);

        // Group errors by file
        const errorsByFile: Record<string, VerificationError[]> = {};
        for (const error of result.errors) {
          const file = error.file || 'unknown';
          if (!errorsByFile[file]) {
            errorsByFile[file] = [];
          }
          errorsByFile[file].push(error);
        }

        for (const [file, errors] of Object.entries(errorsByFile)) {
          lines.push(`📁 ${file}:`);
          for (const error of errors.slice(0, 5)) { // Max 5 per file
            const location = error.line ? `:${error.line}` : '';
            lines.push(`   Line${location}: ${error.message}`);
          }
          if (errors.length > 5) {
            lines.push(`   ... and ${errors.length - 5} more errors in this file`);
          }
        }
      }
    }

    lines.push(`\n\n⚠️ FIX THESE ERRORS before committing. The code must compile and pass tests.`);
    lines.push(`Run verification commands again after fixing:`);
    for (const [name, result] of Object.entries(results)) {
      if (!result.skipped) {
        lines.push(`  - ${name}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Quick check if verification is likely to fail (fast check)
   * Useful before running full verification
   */
  async quickCheck(repoPath: string): Promise<{ likely_fails: boolean; reason?: string }> {
    const fs = require('fs');
    const path = require('path');

    // Check if node_modules exists for Node.js projects
    if (fs.existsSync(path.join(repoPath, 'package.json')) &&
        !fs.existsSync(path.join(repoPath, 'node_modules'))) {
      return { likely_fails: true, reason: 'node_modules not found - npm install not run' };
    }

    // Check for .env file if .env.example exists
    if (fs.existsSync(path.join(repoPath, '.env.example')) &&
        !fs.existsSync(path.join(repoPath, '.env'))) {
      return { likely_fails: true, reason: '.env file missing' };
    }

    return { likely_fails: false };
  }
}

// Singleton instance
export const BuildVerificationService = new BuildVerificationServiceClass();
