/**
 * ProjectRadiographyService
 *
 * Complete "X-Ray" of a project - understands EVERYTHING about the codebase
 * BEFORE the agent runs. This provides comprehensive context so agents
 * don't need to do exploratory searches.
 *
 * LANGUAGE/FRAMEWORK AGNOSTIC - Works with:
 * - JavaScript/TypeScript (React, Vue, Angular, Express, NestJS, Next.js)
 * - Python (Django, FastAPI, Flask)
 * - Ruby (Rails, Sinatra)
 * - Go (Gin, Echo, Fiber)
 * - Java (Spring Boot)
 * - PHP (Laravel, Symfony)
 * - Rust (Actix, Rocket)
 * - And any other language/framework
 *
 * What it discovers:
 * - Project language and ecosystem
 * - Full directory structure
 * - All key files with summaries
 * - Entry points
 * - Routes/Endpoints
 * - Models/Schemas
 * - Services/Controllers
 * - Configuration files
 * - Testing setup
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ============ INTERFACES ============

export interface ProjectRadiography {
  // Core identification
  projectType: ProjectType;
  language: LanguageInfo;
  framework: FrameworkInfo;

  // Structure
  directoryStructure: DirectoryNode;
  sourceDirectories: string[];  // Main source dirs (src/, app/, lib/, etc.)

  // Files by category
  keyFiles: KeyFile[];
  entryPoints: string[];
  configFiles: ConfigFile[];

  // Code elements (language agnostic)
  routes: RouteInfo[];          // API routes, web routes
  models: ModelInfo[];          // Database models, schemas, entities
  services: ServiceInfo[];      // Services, controllers, handlers
  views: ViewInfo[];            // Components, templates, views
  utilities: UtilityInfo[];     // Helpers, utils, libs
  tests: TestInfo[];            // Test files

  // Dependencies (from package.json, requirements.txt, Gemfile, go.mod, etc.)
  dependencies: DependencyInfo;

  // Configuration
  configuration: ConfigurationInfo;
  conventions: ConventionInfo;

  // Summary
  summary: string;
  generatedAt: Date;
}

export type ProjectType = 'backend' | 'frontend' | 'fullstack' | 'mobile' | 'library' | 'cli' | 'unknown';

export interface LanguageInfo {
  primary: string;              // 'typescript', 'python', 'go', 'ruby', 'java', 'php', 'rust', etc.
  secondary?: string[];         // Other languages used
  extensions: string[];         // File extensions used (.ts, .py, .go, .rb, etc.)
}

export interface FrameworkInfo {
  name: string;                 // 'react', 'django', 'rails', 'spring', 'express', etc.
  version?: string;
  ecosystem: string;            // 'node', 'python', 'ruby', 'jvm', 'go', 'php', 'rust'
}

export interface DependencyInfo {
  file: string;                 // package.json, requirements.txt, Gemfile, go.mod, etc.
  manager: string;              // npm, pip, bundler, go, maven, composer, cargo
  dependencies: string[];       // Main dependencies
  devDependencies: string[];    // Dev dependencies
  scripts?: Record<string, string>;  // Build scripts
}

export interface DirectoryNode {
  name: string;
  type: 'file' | 'directory';
  children?: DirectoryNode[];
  fileCount?: number;
}

export interface KeyFile {
  path: string;
  category: string;             // 'config', 'entry', 'model', 'route', 'view', 'service', 'test', etc.
  description: string;
  size?: number;
}

export interface ConfigFile {
  path: string;
  type: string;                 // 'build', 'lint', 'test', 'env', 'ci', etc.
  description: string;
}

export interface RouteInfo {
  method: string;               // 'GET', 'POST', 'PUT', 'DELETE', '*'
  path: string;
  file: string;
  handler?: string;
}

export interface ViewInfo {
  name: string;
  file: string;
  type: string;                 // 'component', 'page', 'template', 'partial', etc.
  framework?: string;           // 'react', 'vue', 'erb', 'jinja', etc.
}

export interface ModelInfo {
  name: string;
  file: string;
  type: string;                 // 'mongoose', 'sequelize', 'django', 'activerecord', 'gorm', etc.
  fields?: string[];
  relationships?: string[];
}

export interface ServiceInfo {
  name: string;
  file: string;
  type: string;                 // 'service', 'controller', 'handler', 'resolver', etc.
  methods?: string[];
}

export interface UtilityInfo {
  name: string;
  file: string;
  category: string;             // 'helper', 'util', 'lib', 'middleware', etc.
  exports?: string[];
}

export interface TestInfo {
  file: string;
  type: string;                 // 'unit', 'integration', 'e2e', 'spec'
  framework: string;            // 'jest', 'pytest', 'rspec', 'go test', etc.
}

export interface ConfigurationInfo {
  linting: string[];            // eslint, rubocop, pylint, golangci-lint, etc.
  formatting: string[];         // prettier, black, gofmt, etc.
  testing: string[];            // jest, pytest, rspec, etc.
  ci: string[];                 // github actions, gitlab ci, etc.
  containerization: string[];   // docker, kubernetes, etc.
  envFiles: string[];
}

export interface ConventionInfo {
  namingConvention: string;     // camelCase, snake_case, PascalCase, kebab-case
  fileStructure: string;        // src-based, app-based, flat, domain-driven
  codeStyle: string;            // functional, OOP, mixed
}

// ============ LANGUAGE DETECTION PATTERNS ============

const LANGUAGE_PATTERNS: Record<string, {
  extensions: string[];
  depFiles: string[];
  frameworks: { pattern: RegExp; name: string; ecosystem: string }[];
}> = {
  typescript: {
    extensions: ['.ts', '.tsx'],
    depFiles: ['package.json', 'tsconfig.json'],
    frameworks: [
      { pattern: /react|next/, name: 'react', ecosystem: 'node' },
      { pattern: /vue|nuxt/, name: 'vue', ecosystem: 'node' },
      { pattern: /angular/, name: 'angular', ecosystem: 'node' },
      { pattern: /express/, name: 'express', ecosystem: 'node' },
      { pattern: /nestjs|@nestjs/, name: 'nestjs', ecosystem: 'node' },
      { pattern: /fastify/, name: 'fastify', ecosystem: 'node' },
    ],
  },
  javascript: {
    extensions: ['.js', '.jsx', '.mjs'],
    depFiles: ['package.json'],
    frameworks: [
      { pattern: /react|next/, name: 'react', ecosystem: 'node' },
      { pattern: /vue|nuxt/, name: 'vue', ecosystem: 'node' },
      { pattern: /express/, name: 'express', ecosystem: 'node' },
    ],
  },
  python: {
    extensions: ['.py'],
    depFiles: ['requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py'],
    frameworks: [
      { pattern: /django/, name: 'django', ecosystem: 'python' },
      { pattern: /fastapi/, name: 'fastapi', ecosystem: 'python' },
      { pattern: /flask/, name: 'flask', ecosystem: 'python' },
      { pattern: /tornado/, name: 'tornado', ecosystem: 'python' },
    ],
  },
  ruby: {
    extensions: ['.rb', '.erb'],
    depFiles: ['Gemfile', 'Gemfile.lock'],
    frameworks: [
      { pattern: /rails/, name: 'rails', ecosystem: 'ruby' },
      { pattern: /sinatra/, name: 'sinatra', ecosystem: 'ruby' },
      { pattern: /hanami/, name: 'hanami', ecosystem: 'ruby' },
    ],
  },
  go: {
    extensions: ['.go'],
    depFiles: ['go.mod', 'go.sum'],
    frameworks: [
      { pattern: /gin-gonic/, name: 'gin', ecosystem: 'go' },
      { pattern: /echo/, name: 'echo', ecosystem: 'go' },
      { pattern: /fiber/, name: 'fiber', ecosystem: 'go' },
      { pattern: /chi/, name: 'chi', ecosystem: 'go' },
    ],
  },
  java: {
    extensions: ['.java'],
    depFiles: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    frameworks: [
      { pattern: /spring/, name: 'spring', ecosystem: 'jvm' },
      { pattern: /quarkus/, name: 'quarkus', ecosystem: 'jvm' },
      { pattern: /micronaut/, name: 'micronaut', ecosystem: 'jvm' },
    ],
  },
  kotlin: {
    extensions: ['.kt', '.kts'],
    depFiles: ['build.gradle.kts'],
    frameworks: [
      { pattern: /spring/, name: 'spring', ecosystem: 'jvm' },
      { pattern: /ktor/, name: 'ktor', ecosystem: 'jvm' },
    ],
  },
  php: {
    extensions: ['.php'],
    depFiles: ['composer.json', 'composer.lock'],
    frameworks: [
      { pattern: /laravel/, name: 'laravel', ecosystem: 'php' },
      { pattern: /symfony/, name: 'symfony', ecosystem: 'php' },
      { pattern: /codeigniter/, name: 'codeigniter', ecosystem: 'php' },
    ],
  },
  rust: {
    extensions: ['.rs'],
    depFiles: ['Cargo.toml', 'Cargo.lock'],
    frameworks: [
      { pattern: /actix/, name: 'actix', ecosystem: 'rust' },
      { pattern: /rocket/, name: 'rocket', ecosystem: 'rust' },
      { pattern: /axum/, name: 'axum', ecosystem: 'rust' },
    ],
  },
  csharp: {
    extensions: ['.cs'],
    depFiles: ['*.csproj', '*.sln'],
    frameworks: [
      { pattern: /aspnetcore|asp\.net/, name: 'aspnet', ecosystem: 'dotnet' },
    ],
  },
  swift: {
    extensions: ['.swift'],
    depFiles: ['Package.swift'],
    frameworks: [
      { pattern: /vapor/, name: 'vapor', ecosystem: 'swift' },
    ],
  },
  dart: {
    extensions: ['.dart'],
    depFiles: ['pubspec.yaml', 'pubspec.lock'],
    frameworks: [
      { pattern: /flutter/, name: 'flutter', ecosystem: 'flutter' },
      { pattern: /dart_frog/, name: 'dart_frog', ecosystem: 'dart' },
      { pattern: /shelf/, name: 'shelf', ecosystem: 'dart' },
    ],
  },
};

// ============ SERVICE ============

export class ProjectRadiographyService {
  private workspacePath: string;
  private radiography: ProjectRadiography;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.radiography = this.createEmptyRadiography();
  }

  /**
   * Perform complete project radiography
   */
  static async scan(workspacePath: string): Promise<ProjectRadiography> {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`PROJECT RADIOGRAPHY - Complete Analysis`);
    console.log(`${'='.repeat(60)}`);
    console.log(`Path: ${workspacePath}`);

    const service = new ProjectRadiographyService(workspacePath);
    await service.performScan();

    console.log(`${'='.repeat(60)}\n`);
    return service.radiography;
  }

  /**
   * Main scanning method - LANGUAGE AGNOSTIC
   */
  private async performScan(): Promise<void> {
    const startTime = Date.now();

    // 1. Detect language by analyzing files (most accurate)
    console.log(`\n[1/8] Detecting language and ecosystem...`);
    this.detectLanguageAndEcosystem();
    console.log(`   Language: ${this.radiography.language.primary}`);
    console.log(`   Framework: ${this.radiography.framework.name} (${this.radiography.framework.ecosystem})`);

    // 2. Scan directory structure
    console.log(`[2/8] Scanning directory structure...`);
    this.radiography.directoryStructure = this.scanDirectory(this.workspacePath, 0, 4);
    this.radiography.sourceDirectories = this.findSourceDirectories();
    console.log(`   Found ${this.countFiles(this.radiography.directoryStructure)} files`);
    console.log(`   Source dirs: ${this.radiography.sourceDirectories.join(', ') || 'root'}`);

    // 3. Read dependencies
    console.log(`[3/8] Reading dependencies...`);
    this.radiography.dependencies = this.readDependencies();
    console.log(`   Manager: ${this.radiography.dependencies.manager}`);
    console.log(`   Dependencies: ${this.radiography.dependencies.dependencies.length}`);

    // 4. Find configuration files
    console.log(`[4/8] Finding configuration...`);
    this.radiography.configuration = this.findConfiguration();
    this.radiography.configFiles = this.findConfigFiles();

    // 5. Find code elements
    console.log(`[5/8] Finding routes/endpoints...`);
    this.radiography.routes = this.findRoutes();
    console.log(`   Found ${this.radiography.routes.length} routes`);

    console.log(`[6/8] Finding models/schemas...`);
    this.radiography.models = this.findModels();
    console.log(`   Found ${this.radiography.models.length} models`);

    console.log(`[7/8] Finding services, views, utilities...`);
    this.radiography.services = this.findServices();
    this.radiography.views = this.findViews();
    this.radiography.utilities = this.findUtilities();
    console.log(`   Services: ${this.radiography.services.length}, Views: ${this.radiography.views.length}, Utils: ${this.radiography.utilities.length}`);

    // 8. Find entry points and key files
    console.log(`[8/8] Finding entry points and key files...`);
    this.radiography.entryPoints = this.findEntryPoints();
    this.radiography.keyFiles = this.findKeyFiles();
    this.radiography.conventions = this.detectConventions();
    console.log(`   Entry points: ${this.radiography.entryPoints.length}`);
    console.log(`   Key files: ${this.radiography.keyFiles.length}`);

    // Generate summary
    this.radiography.summary = this.generateSummary();
    this.radiography.generatedAt = new Date();

    const duration = Date.now() - startTime;
    console.log(`\nRadiography completed in ${duration}ms`);
  }

  // ============ LANGUAGE DETECTION (AGNOSTIC) ============

  private detectLanguageAndEcosystem(): void {
    // Count files by extension to determine primary language
    const extensionCounts: Record<string, number> = {};

    try {
      const result = execSync(
        `find "${this.workspacePath}" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/vendor/*" ! -path "*/venv/*" ! -path "*/__pycache__/*" 2>/dev/null | head -500`,
        { encoding: 'utf8', timeout: 10000 }
      );

      const files = result.trim().split('\n').filter(f => f);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (ext) {
          extensionCounts[ext] = (extensionCounts[ext] || 0) + 1;
        }
      }
    } catch (e) {
      // Fallback to checking dependency files
    }

    // Determine language based on extension counts AND dependency files
    let primaryLanguage = 'unknown';
    let extensions: string[] = [];
    let maxCount = 0;

    for (const [lang, info] of Object.entries(LANGUAGE_PATTERNS)) {
      // Check if dependency files exist
      const hasDepFile = info.depFiles.some(depFile => {
        if (depFile.includes('*')) {
          // Wildcard pattern - check with glob
          try {
            const result = execSync(`find "${this.workspacePath}" -maxdepth 2 -name "${depFile}" 2>/dev/null | head -1`, { encoding: 'utf8' });
            return result.trim().length > 0;
          } catch (e) {
            return false;
          }
        }
        return fs.existsSync(path.join(this.workspacePath, depFile));
      });

      // Count files with this language's extensions
      const count = info.extensions.reduce((sum, ext) => sum + (extensionCounts[ext] || 0), 0);

      if (hasDepFile && count > maxCount) {
        maxCount = count;
        primaryLanguage = lang;
        extensions = info.extensions;
      }
    }

    // Detect framework from dependencies
    let frameworkName = 'unknown';
    let ecosystem = 'unknown';
    const depContent = this.readDependencyFileContent();

    if (primaryLanguage !== 'unknown' && LANGUAGE_PATTERNS[primaryLanguage]) {
      for (const fw of LANGUAGE_PATTERNS[primaryLanguage].frameworks) {
        if (fw.pattern.test(depContent)) {
          frameworkName = fw.name;
          ecosystem = fw.ecosystem;
          break;
        }
      }
      if (ecosystem === 'unknown') {
        ecosystem = LANGUAGE_PATTERNS[primaryLanguage].frameworks[0]?.ecosystem || primaryLanguage;
      }
    }

    // Determine project type
    const frontendKeywords = ['react', 'vue', 'angular', 'svelte', 'next', 'nuxt'];
    const backendKeywords = ['express', 'fastapi', 'django', 'rails', 'spring', 'gin', 'echo', 'laravel'];
    const mobileKeywords = ['react-native', 'expo', 'flutter', 'swift', 'kotlin'];

    const isFrontend = frontendKeywords.some(kw => frameworkName.includes(kw) || depContent.includes(kw));
    const isBackend = backendKeywords.some(kw => frameworkName.includes(kw) || depContent.includes(kw));
    const isMobile = mobileKeywords.some(kw => frameworkName.includes(kw) || depContent.includes(kw));

    if (isMobile) {
      this.radiography.projectType = 'mobile';
    } else if (isFrontend && isBackend) {
      this.radiography.projectType = 'fullstack';
    } else if (isFrontend) {
      this.radiography.projectType = 'frontend';
    } else if (isBackend) {
      this.radiography.projectType = 'backend';
    } else {
      this.radiography.projectType = 'library';
    }

    this.radiography.language = {
      primary: primaryLanguage,
      extensions,
    };

    this.radiography.framework = {
      name: frameworkName,
      ecosystem,
    };
  }

  private readDependencyFileContent(): string {
    const depFiles = [
      'package.json',
      'requirements.txt',
      'Pipfile',
      'pyproject.toml',
      'Gemfile',
      'go.mod',
      'pom.xml',
      'build.gradle',
      'composer.json',
      'Cargo.toml',
    ];

    for (const depFile of depFiles) {
      const filePath = path.join(this.workspacePath, depFile);
      if (fs.existsSync(filePath)) {
        try {
          return fs.readFileSync(filePath, 'utf8').toLowerCase();
        } catch (e) {
          continue;
        }
      }
    }
    return '';
  }

  // ============ DIRECTORY STRUCTURE ============

  private scanDirectory(dirPath: string, depth: number, maxDepth: number): DirectoryNode {
    const name = path.basename(dirPath);

    // Skip certain directories
    const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '__pycache__'];
    if (skipDirs.includes(name)) {
      return { name, type: 'directory', children: [], fileCount: 0 };
    }

    try {
      const stats = fs.statSync(dirPath);

      if (stats.isFile()) {
        return { name, type: 'file' };
      }

      if (depth >= maxDepth) {
        // Count files instead of listing them
        const fileCount = this.countFilesInDir(dirPath);
        return { name, type: 'directory', fileCount };
      }

      const children = fs.readdirSync(dirPath)
        .filter(child => !child.startsWith('.') || child === '.env')
        .map(child => this.scanDirectory(path.join(dirPath, child), depth + 1, maxDepth))
        .filter(child => child.type === 'file' || (child.children && child.children.length > 0) || child.fileCount);

      return { name, type: 'directory', children };
    } catch (e) {
      return { name, type: 'directory', children: [] };
    }
  }

  private countFilesInDir(dirPath: string): number {
    try {
      const result = execSync(
        `find "${dirPath}" -type f ! -path "*/node_modules/*" ! -path "*/.git/*" 2>/dev/null | wc -l`,
        { encoding: 'utf8', timeout: 5000 }
      );
      return parseInt(result.trim()) || 0;
    } catch (e) {
      return 0;
    }
  }

  private countFiles(node: DirectoryNode): number {
    if (node.type === 'file') return 1;
    if (node.fileCount) return node.fileCount;
    if (!node.children) return 0;
    return node.children.reduce((sum, child) => sum + this.countFiles(child), 0);
  }

  // ============ SOURCE DIRECTORIES ============

  private findSourceDirectories(): string[] {
    const commonSourceDirs = [
      'src', 'app', 'lib', 'source', 'sources',  // General
      'cmd', 'pkg', 'internal',                   // Go
      'app', 'config', 'db', 'lib',               // Ruby/Rails
      'src/main', 'src/test',                     // Java
    ];

    const found: string[] = [];
    for (const dir of commonSourceDirs) {
      if (fs.existsSync(path.join(this.workspacePath, dir))) {
        found.push(dir);
      }
    }

    return found.length > 0 ? found : ['.'];
  }

  // ============ DEPENDENCIES (LANGUAGE AGNOSTIC) ============

  private readDependencies(): DependencyInfo {
    // Try each package manager in order
    const managers = [
      { file: 'package.json', manager: 'npm', parser: this.parsePackageJson.bind(this) },
      { file: 'requirements.txt', manager: 'pip', parser: this.parseRequirementsTxt.bind(this) },
      { file: 'Pipfile', manager: 'pipenv', parser: this.parsePipfile.bind(this) },
      { file: 'pyproject.toml', manager: 'poetry', parser: this.parsePyprojectToml.bind(this) },
      { file: 'Gemfile', manager: 'bundler', parser: this.parseGemfile.bind(this) },
      { file: 'go.mod', manager: 'go', parser: this.parseGoMod.bind(this) },
      { file: 'pom.xml', manager: 'maven', parser: this.parsePomXml.bind(this) },
      { file: 'build.gradle', manager: 'gradle', parser: this.parseBuildGradle.bind(this) },
      { file: 'composer.json', manager: 'composer', parser: this.parseComposerJson.bind(this) },
      { file: 'Cargo.toml', manager: 'cargo', parser: this.parseCargoToml.bind(this) },
    ];

    for (const { file, manager, parser } of managers) {
      const filePath = path.join(this.workspacePath, file);
      if (fs.existsSync(filePath)) {
        try {
          const result = parser(filePath);
          return { file, manager, ...result };
        } catch (e) {
          // Continue to next
        }
      }
    }

    return { file: 'none', manager: 'unknown', dependencies: [], devDependencies: [] };
  }

  private parsePackageJson(filePath: string): { dependencies: string[]; devDependencies: string[]; scripts?: Record<string, string> } {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      dependencies: Object.keys(content.dependencies || {}).slice(0, 50),
      devDependencies: Object.keys(content.devDependencies || {}).slice(0, 30),
      scripts: content.scripts,
    };
  }

  private parseRequirementsTxt(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps = content.split('\n')
      .filter(line => line.trim() && !line.startsWith('#'))
      .map(line => line.split('==')[0].split('>=')[0].split('<=')[0].trim())
      .slice(0, 50);
    return { dependencies: deps, devDependencies: [] };
  }

  private parsePipfile(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];
    const devDeps: string[] = [];

    let section = '';
    for (const line of content.split('\n')) {
      if (line.startsWith('[packages]')) section = 'packages';
      else if (line.startsWith('[dev-packages]')) section = 'dev';
      else if (line.startsWith('[')) section = '';
      else if (section && line.includes('=')) {
        const dep = line.split('=')[0].trim();
        if (dep) {
          if (section === 'packages') deps.push(dep);
          else if (section === 'dev') devDeps.push(dep);
        }
      }
    }

    return { dependencies: deps.slice(0, 50), devDependencies: devDeps.slice(0, 30) };
  }

  private parsePyprojectToml(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];

    // Simple extraction - look for dependencies array
    const depMatch = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (depMatch) {
      const depSection = depMatch[1];
      const matches = depSection.match(/"([^"]+)"/g);
      if (matches) {
        deps.push(...matches.map(m => m.replace(/"/g, '').split('>=')[0].split('==')[0].trim()));
      }
    }

    return { dependencies: deps.slice(0, 50), devDependencies: [] };
  }

  private parseGemfile(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];
    const devDeps: string[] = [];

    let inDevGroup = false;
    for (const line of content.split('\n')) {
      if (line.includes('group :development') || line.includes('group :test')) {
        inDevGroup = true;
      } else if (line.trim() === 'end') {
        inDevGroup = false;
      } else if (line.includes('gem ')) {
        const match = line.match(/gem\s+['"]([^'"]+)['"]/);
        if (match) {
          if (inDevGroup) devDeps.push(match[1]);
          else deps.push(match[1]);
        }
      }
    }

    return { dependencies: deps.slice(0, 50), devDependencies: devDeps.slice(0, 30) };
  }

  private parseGoMod(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];

    const requireMatch = content.match(/require\s*\(([\s\S]*?)\)/);
    if (requireMatch) {
      const lines = requireMatch[1].split('\n');
      for (const line of lines) {
        const match = line.trim().match(/^([^\s]+)/);
        if (match && !match[1].startsWith('//')) {
          deps.push(match[1]);
        }
      }
    }

    return { dependencies: deps.slice(0, 50), devDependencies: [] };
  }

  private parsePomXml(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];

    const depMatches = content.match(/<artifactId>([^<]+)<\/artifactId>/g);
    if (depMatches) {
      deps.push(...depMatches.map(m => m.replace(/<\/?artifactId>/g, '')));
    }

    return { dependencies: deps.slice(0, 50), devDependencies: [] };
  }

  private parseBuildGradle(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];

    const depMatches = content.match(/implementation\s*['"]([^'"]+)['"]/g);
    if (depMatches) {
      deps.push(...depMatches.map(m => {
        const match = m.match(/['"]([^'"]+)['"]/);
        return match ? match[1].split(':')[1] || match[1] : '';
      }).filter(Boolean));
    }

    return { dependencies: deps.slice(0, 50), devDependencies: [] };
  }

  private parseComposerJson(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      dependencies: Object.keys(content.require || {}).slice(0, 50),
      devDependencies: Object.keys(content['require-dev'] || {}).slice(0, 30),
    };
  }

  private parseCargoToml(filePath: string): { dependencies: string[]; devDependencies: string[] } {
    const content = fs.readFileSync(filePath, 'utf8');
    const deps: string[] = [];
    const devDeps: string[] = [];

    let section = '';
    for (const line of content.split('\n')) {
      if (line.startsWith('[dependencies]')) section = 'deps';
      else if (line.startsWith('[dev-dependencies]')) section = 'dev';
      else if (line.startsWith('[')) section = '';
      else if (section && line.includes('=')) {
        const dep = line.split('=')[0].trim();
        if (dep && !dep.startsWith('#')) {
          if (section === 'deps') deps.push(dep);
          else if (section === 'dev') devDeps.push(dep);
        }
      }
    }

    return { dependencies: deps.slice(0, 50), devDependencies: devDeps.slice(0, 30) };
  }

  // ============ CONFIGURATION (LANGUAGE AGNOSTIC) ============

  private findConfiguration(): ConfigurationInfo {
    return {
      linting: this.findLintingTools(),
      formatting: this.findFormattingTools(),
      testing: this.findTestingTools(),
      ci: this.findCITools(),
      containerization: this.findContainerization(),
      envFiles: this.findEnvFiles(),
    };
  }

  private findLintingTools(): string[] {
    const tools: string[] = [];
    const linters = [
      { file: '.eslintrc', name: 'eslint' },
      { file: '.eslintrc.js', name: 'eslint' },
      { file: '.eslintrc.json', name: 'eslint' },
      { file: '.pylintrc', name: 'pylint' },
      { file: 'setup.cfg', name: 'flake8' },  // Often contains flake8 config
      { file: '.rubocop.yml', name: 'rubocop' },
      { file: '.golangci.yml', name: 'golangci-lint' },
      { file: 'phpcs.xml', name: 'phpcs' },
      { file: 'clippy.toml', name: 'clippy' },
    ];

    for (const { file, name } of linters) {
      if (fs.existsSync(path.join(this.workspacePath, file)) && !tools.includes(name)) {
        tools.push(name);
      }
    }
    return tools;
  }

  private findFormattingTools(): string[] {
    const tools: string[] = [];
    const formatters = [
      { file: '.prettierrc', name: 'prettier' },
      { file: '.prettierrc.json', name: 'prettier' },
      { file: 'pyproject.toml', name: 'black', check: (c: string) => c.includes('[tool.black]') },
      { file: '.editorconfig', name: 'editorconfig' },
    ];

    for (const { file, name, check } of formatters) {
      const filePath = path.join(this.workspacePath, file);
      if (fs.existsSync(filePath)) {
        if (check) {
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            if (check(content) && !tools.includes(name)) tools.push(name);
          } catch (e) { /* ignore */ }
        } else if (!tools.includes(name)) {
          tools.push(name);
        }
      }
    }

    // Go has gofmt by default
    if (this.radiography.language.primary === 'go' && !tools.includes('gofmt')) {
      tools.push('gofmt');
    }

    return tools;
  }

  private findTestingTools(): string[] {
    const tools: string[] = [];
    const testers = [
      { file: 'jest.config.js', name: 'jest' },
      { file: 'jest.config.ts', name: 'jest' },
      { file: 'vitest.config.ts', name: 'vitest' },
      { file: 'pytest.ini', name: 'pytest' },
      { file: 'conftest.py', name: 'pytest' },
      { file: 'spec', name: 'rspec', isDir: true },
      { file: '.rspec', name: 'rspec' },
      { file: 'phpunit.xml', name: 'phpunit' },
    ];

    for (const { file, name, isDir } of testers) {
      const filePath = path.join(this.workspacePath, file);
      const exists = isDir ? fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() : fs.existsSync(filePath);
      if (exists && !tools.includes(name)) {
        tools.push(name);
      }
    }

    // Go has built-in testing
    if (this.radiography.language.primary === 'go' && !tools.includes('go test')) {
      tools.push('go test');
    }

    return tools;
  }

  private findCITools(): string[] {
    const tools: string[] = [];
    const ci = [
      { file: '.github/workflows', name: 'github-actions', isDir: true },
      { file: '.gitlab-ci.yml', name: 'gitlab-ci' },
      { file: 'Jenkinsfile', name: 'jenkins' },
      { file: '.circleci', name: 'circleci', isDir: true },
      { file: '.travis.yml', name: 'travis' },
      { file: 'azure-pipelines.yml', name: 'azure-devops' },
    ];

    for (const { file, name, isDir } of ci) {
      const filePath = path.join(this.workspacePath, file);
      const exists = isDir ? fs.existsSync(filePath) && fs.statSync(filePath).isDirectory() : fs.existsSync(filePath);
      if (exists && !tools.includes(name)) {
        tools.push(name);
      }
    }
    return tools;
  }

  private findContainerization(): string[] {
    const tools: string[] = [];
    if (fs.existsSync(path.join(this.workspacePath, 'Dockerfile'))) tools.push('docker');
    if (fs.existsSync(path.join(this.workspacePath, 'docker-compose.yml'))) tools.push('docker-compose');
    if (fs.existsSync(path.join(this.workspacePath, 'docker-compose.yaml'))) tools.push('docker-compose');
    if (fs.existsSync(path.join(this.workspacePath, 'kubernetes')) ||
        fs.existsSync(path.join(this.workspacePath, 'k8s'))) {
      tools.push('kubernetes');
    }
    return tools;
  }

  private findEnvFiles(): string[] {
    const envFiles: string[] = [];
    try {
      const files = fs.readdirSync(this.workspacePath);
      for (const file of files) {
        if (file.startsWith('.env')) {
          envFiles.push(file);
        }
      }
    } catch (e) { /* ignore */ }
    return envFiles;
  }

  private findConfigFiles(): ConfigFile[] {
    const configs: ConfigFile[] = [];

    const configPatterns = [
      { file: 'tsconfig.json', type: 'build', desc: 'TypeScript configuration' },
      { file: 'package.json', type: 'build', desc: 'Node.js project configuration' },
      { file: 'requirements.txt', type: 'build', desc: 'Python dependencies' },
      { file: 'Gemfile', type: 'build', desc: 'Ruby dependencies' },
      { file: 'go.mod', type: 'build', desc: 'Go module configuration' },
      { file: 'pom.xml', type: 'build', desc: 'Maven configuration' },
      { file: 'build.gradle', type: 'build', desc: 'Gradle configuration' },
      { file: 'Cargo.toml', type: 'build', desc: 'Rust Cargo configuration' },
      { file: 'composer.json', type: 'build', desc: 'PHP Composer configuration' },
      { file: 'Makefile', type: 'build', desc: 'Make build configuration' },
      { file: 'Dockerfile', type: 'container', desc: 'Docker container definition' },
      { file: 'docker-compose.yml', type: 'container', desc: 'Docker Compose configuration' },
    ];

    for (const { file, type, desc } of configPatterns) {
      if (fs.existsSync(path.join(this.workspacePath, file))) {
        configs.push({ path: file, type, description: desc });
      }
    }

    return configs;
  }

  // ============ ROUTES (LANGUAGE AGNOSTIC) ============

  private findRoutes(): RouteInfo[] {
    const routes: RouteInfo[] = [];
    const lang = this.radiography.language.primary;

    // Different patterns for different languages/frameworks
    const patterns: { regex: RegExp; extractor: (match: RegExpMatchArray, file: string) => RouteInfo | null }[] = [];

    // Node.js/Express patterns
    if (lang === 'typescript' || lang === 'javascript') {
      patterns.push(
        { regex: /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi, extractor: this.extractExpressRoute.bind(this) },
        { regex: /app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi, extractor: this.extractExpressRoute.bind(this) },
        { regex: /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`]?([^'"`\)]+)['"`]?\s*\)/gi, extractor: this.extractDecoratorRoute.bind(this) },
      );
    }

    // Python patterns
    if (lang === 'python') {
      patterns.push(
        { regex: /@app\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi, extractor: this.extractFlaskRoute.bind(this) },
        { regex: /@router\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi, extractor: this.extractFastAPIRoute.bind(this) },
        { regex: /path\s*\(\s*['"]([^'"]+)['"]/gi, extractor: this.extractDjangoRoute.bind(this) },
      );
    }

    // Ruby patterns
    if (lang === 'ruby') {
      patterns.push(
        { regex: /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi, extractor: this.extractRailsRoute.bind(this) },
        { regex: /resources?\s+:(\w+)/gi, extractor: this.extractRailsResource.bind(this) },
      );
    }

    // Go patterns
    if (lang === 'go') {
      patterns.push(
        { regex: /\.(GET|POST|PUT|PATCH|DELETE)\s*\(\s*['"]([^'"]+)['"]/gi, extractor: this.extractGoRoute.bind(this) },
        { regex: /HandleFunc\s*\(\s*['"]([^'"]+)['"].*?(GET|POST|PUT|DELETE)?/gi, extractor: this.extractGoHandleFunc.bind(this) },
      );
    }

    // Find route files
    const extensions = this.radiography.language.extensions.join('|').replace(/\./g, '\\.');
    try {
      const result = execSync(
        `find "${this.workspacePath}" -type f \\( -regex ".*\\(${extensions}\\)" \\) 2>/dev/null | grep -E "(route|controller|handler|view|api|endpoint)" | grep -v node_modules | grep -v vendor | grep -v venv | head -50`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const files = result.trim().split('\n').filter(f => f);

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf8');
          const relativePath = file.replace(this.workspacePath + '/', '');

          for (const { regex, extractor } of patterns) {
            let match;
            regex.lastIndex = 0;
            while ((match = regex.exec(content)) !== null) {
              const route = extractor(match, relativePath);
              if (route && !routes.some(r => r.method === route.method && r.path === route.path)) {
                routes.push(route);
              }
            }
          }
        } catch (e) { /* skip */ }
      }
    } catch (e) { /* ignore */ }

    return routes.slice(0, 100);
  }

  private extractExpressRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractDecoratorRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractFlaskRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractFastAPIRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractDjangoRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: '*', path: '/' + match[1], file };
  }

  private extractRailsRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractRailsResource(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: 'CRUD', path: '/' + match[1], file };
  }

  private extractGoRoute(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[1].toUpperCase(), path: match[2], file };
  }

  private extractGoHandleFunc(match: RegExpMatchArray, file: string): RouteInfo | null {
    return { method: match[2]?.toUpperCase() || '*', path: match[1], file };
  }

  // ============ MODELS (LANGUAGE AGNOSTIC) ============

  private findModels(): ModelInfo[] {
    const models: ModelInfo[] = [];
    const lang = this.radiography.language.primary;

    // Model directory patterns by language
    const modelDirs = {
      typescript: ['models', 'entities', 'schemas'],
      javascript: ['models', 'entities', 'schemas'],
      python: ['models', 'entities', 'schemas'],
      ruby: ['app/models'],
      go: ['models', 'internal/models', 'pkg/models'],
      java: ['entities', 'models', 'domain'],
      php: ['Models', 'Entity'],
      rust: ['models', 'entities'],
    };

    const dirs = modelDirs[lang as keyof typeof modelDirs] || ['models'];

    for (const dir of dirs) {
      try {
        const result = execSync(
          `find "${this.workspacePath}" -type f -path "*/${dir}/*" \\( ${this.radiography.language.extensions.map(e => `-name "*${e}"`).join(' -o ')} \\) 2>/dev/null | grep -v node_modules | grep -v vendor | grep -v venv | head -30`,
          { encoding: 'utf8', timeout: 10000 }
        );

        const files = result.trim().split('\n').filter(f => f);

        for (const file of files) {
          const name = path.basename(file, path.extname(file));
          if (name === 'index' || name === '__init__') continue;

          try {
            const content = fs.readFileSync(file, 'utf8');
            const modelType = this.detectModelType(content, lang);
            const fields = this.extractModelFields(content, lang);
            const relationships = this.extractModelRelationships(content, lang);

            models.push({
              name,
              file: file.replace(this.workspacePath + '/', ''),
              type: modelType,
              fields: fields.length > 0 ? fields : undefined,
              relationships: relationships.length > 0 ? relationships : undefined,
            });
          } catch (e) {
            models.push({
              name,
              file: file.replace(this.workspacePath + '/', ''),
              type: 'unknown',
            });
          }
        }
      } catch (e) { /* ignore */ }
    }

    return models;
  }

  private detectModelType(content: string, lang: string): string {
    if (lang === 'typescript' || lang === 'javascript') {
      if (content.includes('mongoose')) return 'mongoose';
      if (content.includes('sequelize')) return 'sequelize';
      if (content.includes('typeorm')) return 'typeorm';
      if (content.includes('prisma')) return 'prisma';
    }
    if (lang === 'python') {
      if (content.includes('models.Model')) return 'django';
      if (content.includes('Base') && content.includes('Column')) return 'sqlalchemy';
    }
    if (lang === 'ruby') {
      if (content.includes('ApplicationRecord') || content.includes('ActiveRecord')) return 'activerecord';
    }
    if (lang === 'go') {
      if (content.includes('gorm')) return 'gorm';
    }
    return 'unknown';
  }

  private extractModelFields(content: string, _lang: string): string[] {
    const fields: string[] = [];

    // TypeScript/Mongoose
    const tsMatches = content.match(/(\w+)\s*:\s*(string|number|boolean|Date|ObjectId|Schema\.Types)/g);
    if (tsMatches) {
      fields.push(...tsMatches.slice(0, 15).map(m => m.split(':')[0].trim()));
    }

    // Python/Django
    const pyMatches = content.match(/(\w+)\s*=\s*models\.\w+Field/g);
    if (pyMatches) {
      fields.push(...pyMatches.slice(0, 15).map(m => m.split('=')[0].trim()));
    }

    // Ruby/ActiveRecord (t.string, etc in migrations or schema)
    const rbMatches = content.match(/t\.(\w+)\s+['":](\w+)/g);
    if (rbMatches) {
      fields.push(...rbMatches.slice(0, 15).map(m => {
        const match = m.match(/['":](\\w+)/);
        return match ? match[1] : '';
      }).filter(Boolean));
    }

    return [...new Set(fields)];
  }

  private extractModelRelationships(content: string, _lang: string): string[] {
    const relationships: string[] = [];

    // Mongoose refs
    const mongooseRefs = content.match(/ref:\s*['"](\w+)['"]/g);
    if (mongooseRefs) {
      relationships.push(...mongooseRefs.map(m => m.match(/['"](\w+)['"]/)?.[1] || '').filter(Boolean));
    }

    // Rails associations
    const railsAssocs = content.match(/(belongs_to|has_many|has_one)\s+:(\w+)/g);
    if (railsAssocs) {
      relationships.push(...railsAssocs.map(m => m.split(':')[1]?.trim() || '').filter(Boolean));
    }

    // Django ForeignKey
    const djangoFKs = content.match(/ForeignKey\s*\(\s*['"]?(\w+)['"]?/g);
    if (djangoFKs) {
      relationships.push(...djangoFKs.map(m => m.match(/\(\s*['"]?(\w+)/)?.[1] || '').filter(Boolean));
    }

    return [...new Set(relationships)];
  }

  // ============ SERVICES (LANGUAGE AGNOSTIC) ============

  private findServices(): ServiceInfo[] {
    const services: ServiceInfo[] = [];

    // Service patterns we search for (used in grep below)
    // '**/services/**/*', '**/service/**/*', '**/*Service*', '**/controllers/**/*', '**/handlers/**/*'

    try {
      const extensions = this.radiography.language.extensions.map(e => `-name "*${e}"`).join(' -o ');
      const result = execSync(
        `find "${this.workspacePath}" -type f \\( ${extensions} \\) 2>/dev/null | grep -iE "(service|controller|handler)" | grep -v node_modules | grep -v vendor | grep -v venv | grep -v test | grep -v spec | head -30`,
        { encoding: 'utf8', timeout: 10000 }
      );

      const files = result.trim().split('\n').filter(f => f);

      for (const file of files) {
        const name = path.basename(file, path.extname(file));
        if (name === 'index' || name === '__init__') continue;

        try {
          const content = fs.readFileSync(file, 'utf8');
          const methods = this.extractMethods(content);
          const type = file.includes('controller') ? 'controller' :
                       file.includes('handler') ? 'handler' : 'service';

          services.push({
            name,
            file: file.replace(this.workspacePath + '/', ''),
            type,
            methods: methods.length > 0 ? methods.slice(0, 10) : undefined,
          });
        } catch (e) {
          services.push({
            name,
            file: file.replace(this.workspacePath + '/', ''),
            type: 'service',
          });
        }
      }
    } catch (e) { /* ignore */ }

    return services;
  }

  private extractMethods(content: string): string[] {
    const methods: string[] = [];

    // TypeScript/JavaScript methods
    const tsMatches = content.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/g);
    if (tsMatches) {
      methods.push(...tsMatches.map(m => m.match(/(\w+)\s*\(/)?.[1] || '').filter(Boolean));
    }

    // Python methods
    const pyMatches = content.match(/def\s+(\w+)\s*\(/g);
    if (pyMatches) {
      methods.push(...pyMatches.map(m => m.match(/def\s+(\w+)/)?.[1] || '').filter(Boolean));
    }

    // Ruby methods
    const rbMatches = content.match(/def\s+(\w+)/g);
    if (rbMatches) {
      methods.push(...rbMatches.map(m => m.replace('def ', '').trim()));
    }

    // Go functions/methods
    const goMatches = content.match(/func\s+(?:\([^)]+\)\s+)?(\w+)/g);
    if (goMatches) {
      methods.push(...goMatches.map(m => m.match(/(\w+)\s*$/)?.[1] || '').filter(Boolean));
    }

    return [...new Set(methods)].filter(m => !['constructor', '__init__', 'new', 'New'].includes(m));
  }

  // ============ VIEWS (LANGUAGE AGNOSTIC) ============

  private findViews(): ViewInfo[] {
    const views: ViewInfo[] = [];
    const lang = this.radiography.language.primary;

    // View patterns by language
    const viewDirs: { dir: string; type: string; fw?: string }[] = [];

    if (lang === 'typescript' || lang === 'javascript') {
      viewDirs.push(
        { dir: 'components', type: 'component', fw: 'react' },
        { dir: 'pages', type: 'page', fw: 'react' },
        { dir: 'views', type: 'view', fw: 'vue' },
      );
    }
    if (lang === 'ruby') {
      viewDirs.push({ dir: 'app/views', type: 'template', fw: 'erb' });
    }
    if (lang === 'python') {
      viewDirs.push({ dir: 'templates', type: 'template', fw: 'jinja' });
    }
    if (lang === 'php') {
      viewDirs.push(
        { dir: 'resources/views', type: 'template', fw: 'blade' },
        { dir: 'templates', type: 'template', fw: 'twig' },
      );
    }

    for (const { dir, type, fw } of viewDirs) {
      try {
        const result = execSync(
          `find "${this.workspacePath}" -type f -path "*/${dir}/*" 2>/dev/null | grep -v node_modules | grep -v vendor | head -30`,
          { encoding: 'utf8', timeout: 10000 }
        );

        const files = result.trim().split('\n').filter(f => f);

        for (const file of files) {
          const name = path.basename(file, path.extname(file));
          if (name === 'index' || name === '__init__' || name.startsWith('_')) continue;

          views.push({
            name,
            file: file.replace(this.workspacePath + '/', ''),
            type,
            framework: fw,
          });
        }
      } catch (e) { /* ignore */ }
    }

    return views.slice(0, 50);
  }

  // ============ UTILITIES (LANGUAGE AGNOSTIC) ============

  private findUtilities(): UtilityInfo[] {
    const utilities: UtilityInfo[] = [];

    const utilDirs = ['utils', 'util', 'helpers', 'lib', 'common', 'shared'];

    for (const dir of utilDirs) {
      try {
        const extensions = this.radiography.language.extensions.map(e => `-name "*${e}"`).join(' -o ');
        const result = execSync(
          `find "${this.workspacePath}" -type f -path "*/${dir}/*" \\( ${extensions} \\) 2>/dev/null | grep -v node_modules | grep -v vendor | grep -v venv | head -20`,
          { encoding: 'utf8', timeout: 10000 }
        );

        const files = result.trim().split('\n').filter(f => f);

        for (const file of files) {
          const name = path.basename(file, path.extname(file));
          if (name === 'index' || name === '__init__') continue;

          utilities.push({
            name,
            file: file.replace(this.workspacePath + '/', ''),
            category: dir,
          });
        }
      } catch (e) { /* ignore */ }
    }

    return utilities.slice(0, 30);
  }

  // ============ ENTRY POINTS (LANGUAGE AGNOSTIC) ============

  private findEntryPoints(): string[] {
    const entryPoints: string[] = [];

    const entryPatterns: Record<string, string[]> = {
      typescript: ['src/index.ts', 'src/main.ts', 'src/app.ts', 'index.ts', 'main.ts', 'src/server.ts'],
      javascript: ['src/index.js', 'src/main.js', 'src/app.js', 'index.js', 'main.js', 'server.js'],
      python: ['main.py', 'app.py', 'manage.py', 'run.py', 'wsgi.py', 'asgi.py', '__main__.py'],
      ruby: ['config.ru', 'app.rb', 'config/application.rb'],
      go: ['main.go', 'cmd/main.go', 'cmd/server/main.go'],
      java: ['Application.java', 'Main.java', 'App.java'],
      php: ['index.php', 'public/index.php', 'artisan'],
      rust: ['src/main.rs', 'main.rs'],
    };

    const lang = this.radiography.language.primary;
    const patterns = entryPatterns[lang] || [];

    for (const pattern of patterns) {
      const filePath = path.join(this.workspacePath, pattern);
      if (fs.existsSync(filePath)) {
        entryPoints.push(pattern);
      }
    }

    return entryPoints;
  }

  // ============ KEY FILES ============

  private findKeyFiles(): KeyFile[] {
    const keyFiles: KeyFile[] = [];

    // Entry points
    for (const entry of this.radiography.entryPoints) {
      keyFiles.push({ path: entry, category: 'entry', description: 'Application entry point' });
    }

    // Config files
    for (const config of this.radiography.configFiles) {
      keyFiles.push({ path: config.path, category: 'config', description: config.description });
    }

    // Models
    for (const model of this.radiography.models.slice(0, 10)) {
      keyFiles.push({
        path: model.file,
        category: 'model',
        description: `${model.name} (${model.type})${model.relationships ? ` refs: ${model.relationships.join(', ')}` : ''}`,
      });
    }

    // Services
    for (const service of this.radiography.services.slice(0, 10)) {
      keyFiles.push({
        path: service.file,
        category: 'service',
        description: `${service.name}${service.methods ? ` (${service.methods.slice(0, 3).join(', ')})` : ''}`,
      });
    }

    return keyFiles;
  }

  // ============ CONVENTIONS ============

  private detectConventions(): ConventionInfo {
    const srcDirs = this.radiography.sourceDirectories;
    let fileStructure = 'flat';
    if (srcDirs.includes('src')) fileStructure = 'src-based';
    else if (srcDirs.includes('app')) fileStructure = 'app-directory';
    else if (srcDirs.includes('lib')) fileStructure = 'lib-based';

    const namingConvention = this.detectNamingConvention();

    // Detect code style from patterns
    let codeStyle = 'mixed';
    if (this.radiography.services.length > 0) {
      codeStyle = 'OOP';
    }
    if (this.radiography.utilities.length > 0 && this.radiography.services.length === 0) {
      codeStyle = 'functional';
    }

    return { namingConvention, fileStructure, codeStyle };
  }

  private detectNamingConvention(): string {
    const extensions = this.radiography.language.extensions.join('|').replace(/\./g, '');
    try {
      const result = execSync(
        `find "${this.workspacePath}" -type f -regex ".*\\.\\(${extensions}\\)" 2>/dev/null | grep -v node_modules | grep -v vendor | head -30`,
        { encoding: 'utf8', timeout: 5000 }
      );

      const files = result.trim().split('\n').filter(f => f);
      const baseNames = files.map(f => path.basename(f, path.extname(f)));

      const hasPascalCase = baseNames.some(n => /^[A-Z][a-z]+[A-Z]/.test(n));
      const hasCamelCase = baseNames.some(n => /^[a-z]+[A-Z]/.test(n));
      const hasKebabCase = baseNames.some(n => /^[a-z]+-[a-z]+/.test(n));
      const hasSnakeCase = baseNames.some(n => /^[a-z]+_[a-z]+/.test(n));

      if (hasSnakeCase) return 'snake_case';
      if (hasPascalCase) return 'PascalCase';
      if (hasKebabCase) return 'kebab-case';
      if (hasCamelCase) return 'camelCase';
      return 'mixed';
    } catch (e) {
      return 'unknown';
    }
  }

  // ============ SUMMARY ============

  private generateSummary(): string {
    const r = this.radiography;

    let summary = `## Project Summary\n\n`;
    summary += `**Type**: ${r.projectType}\n`;
    summary += `**Language**: ${r.language.primary}\n`;
    summary += `**Framework**: ${r.framework.name} (${r.framework.ecosystem})\n`;
    summary += `**Structure**: ${r.conventions.fileStructure}\n\n`;

    if (r.routes.length > 0) {
      summary += `### API/Routes\n`;
      summary += `- **Routes**: ${r.routes.length}\n`;
    }

    if (r.models.length > 0) {
      summary += `### Data\n`;
      summary += `- **Models**: ${r.models.length} (${r.models.slice(0, 5).map(m => m.name).join(', ')})\n`;
    }

    if (r.services.length > 0) {
      summary += `### Logic\n`;
      summary += `- **Services**: ${r.services.length}\n`;
    }

    if (r.views.length > 0) {
      summary += `### Views\n`;
      summary += `- **Views**: ${r.views.length}\n`;
    }

    summary += `\n### Configuration\n`;
    summary += `- **Linting**: ${r.configuration.linting.join(', ') || 'none'}\n`;
    summary += `- **Testing**: ${r.configuration.testing.join(', ') || 'none'}\n`;
    summary += `- **CI/CD**: ${r.configuration.ci.join(', ') || 'none'}\n`;

    return summary;
  }

  // ============ FORMATTING FOR PROMPTS ============

  /**
   * Format radiography for agent prompts - LANGUAGE AGNOSTIC
   */
  static formatForPrompt(radiography: ProjectRadiography): string {
    let output = `
## PROJECT RADIOGRAPHY (Complete Analysis)

${radiography.summary}

### Project Info
- **Type**: ${radiography.projectType}
- **Language**: ${radiography.language.primary}${radiography.language.secondary?.length ? ` (also: ${radiography.language.secondary.join(', ')})` : ''}
- **Framework**: ${radiography.framework.name} (${radiography.framework.ecosystem})
- **Source Directories**: ${radiography.sourceDirectories.join(', ') || '.'}

### Key Files
${radiography.keyFiles.slice(0, 15).map(f => `- **${f.path}** (${f.category}): ${f.description}`).join('\n')}

### Entry Points
${radiography.entryPoints.map(e => `- ${e}`).join('\n') || '- Not detected'}

`;

    if (radiography.routes.length > 0) {
      output += `### Routes/Endpoints (${radiography.routes.length} total)
${radiography.routes.slice(0, 15).map(r => `- \`${r.method} ${r.path}\` → ${r.file}${r.handler ? ` (${r.handler})` : ''}`).join('\n')}

`;
    }

    if (radiography.models.length > 0) {
      output += `### Models/Schemas (${radiography.models.length} total)
${radiography.models.slice(0, 10).map(m => `- **${m.name}** (${m.type}) → ${m.file}${m.relationships ? ` [refs: ${m.relationships.join(', ')}]` : ''}${m.fields ? ` fields: ${m.fields.slice(0, 5).join(', ')}` : ''}`).join('\n')}

`;
    }

    if (radiography.services.length > 0) {
      output += `### Services/Controllers (${radiography.services.length} total)
${radiography.services.slice(0, 10).map(s => `- **${s.name}** (${s.type}) → ${s.file}${s.methods ? ` methods: ${s.methods.slice(0, 5).join(', ')}` : ''}`).join('\n')}

`;
    }

    if (radiography.views.length > 0) {
      output += `### Views/Components (${radiography.views.length} total)
${radiography.views.slice(0, 15).map(v => `- **${v.name}** (${v.type}${v.framework ? `, ${v.framework}` : ''}) → ${v.file}`).join('\n')}

`;
    }

    if (radiography.utilities.length > 0) {
      output += `### Utilities/Helpers (${radiography.utilities.length} total)
${radiography.utilities.slice(0, 10).map(u => `- **${u.name}** (${u.category}) → ${u.file}`).join('\n')}

`;
    }

    // Dependencies summary
    output += `### Dependencies
- **Package Manager**: ${radiography.dependencies.manager}
- **Main Dependencies**: ${radiography.dependencies.dependencies.slice(0, 15).join(', ')}
${radiography.dependencies.devDependencies.length > 0 ? `- **Dev Dependencies**: ${radiography.dependencies.devDependencies.slice(0, 10).join(', ')}` : ''}

`;

    // Configuration
    output += `### Configuration & Tooling
- **Linting**: ${radiography.configuration.linting.join(', ') || 'none'}
- **Formatting**: ${radiography.configuration.formatting.join(', ') || 'none'}
- **Testing**: ${radiography.configuration.testing.join(', ') || 'none'}
- **CI/CD**: ${radiography.configuration.ci.join(', ') || 'none'}
- **Containers**: ${radiography.configuration.containerization.join(', ') || 'none'}
${radiography.configuration.envFiles.length > 0 ? `- **Env Files**: ${radiography.configuration.envFiles.join(', ')}` : ''}

`;

    // Conventions
    output += `### Conventions
- **Naming**: ${radiography.conventions.namingConvention}
- **File Structure**: ${radiography.conventions.fileStructure}
- **Code Style**: ${radiography.conventions.codeStyle}

**IMPORTANT**: Follow these existing patterns exactly. Code that doesn't match the project conventions will be rejected.
`;

    return output;
  }

  // ============ HELPERS ============

  private createEmptyRadiography(): ProjectRadiography {
    return {
      projectType: 'unknown',
      language: {
        primary: 'unknown',
        extensions: [],
      },
      framework: {
        name: 'unknown',
        ecosystem: 'unknown',
      },
      directoryStructure: { name: '', type: 'directory', children: [] },
      sourceDirectories: [],
      keyFiles: [],
      entryPoints: [],
      configFiles: [],
      routes: [],
      models: [],
      services: [],
      views: [],
      utilities: [],
      tests: [],
      dependencies: {
        file: 'none',
        manager: 'unknown',
        dependencies: [],
        devDependencies: [],
      },
      configuration: {
        linting: [],
        formatting: [],
        testing: [],
        ci: [],
        containerization: [],
        envFiles: [],
      },
      conventions: {
        namingConvention: 'unknown',
        fileStructure: 'unknown',
        codeStyle: 'unknown',
      },
      summary: '',
      generatedAt: new Date(),
    };
  }
}

export default ProjectRadiographyService;
