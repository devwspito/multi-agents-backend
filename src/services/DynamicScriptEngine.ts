/**
 * DynamicScriptEngine - Runtime script generation for exploration
 *
 * This is the KEY DIFFERENTIATOR vs Claude Code.
 * Generates and executes custom exploration scripts in real-time:
 *
 * 1. Code Pattern Discovery - Find patterns across codebase
 * 2. Database Query Generation - Dynamic queries for any DB
 * 3. API Exploration - Discover and test endpoints
 * 4. Dependency Analysis - Map project dependencies
 * 5. Test Discovery - Find related tests for any code
 *
 * Unlike static tools, these scripts are GENERATED based on the task.
 */

import * as fs from 'fs';
import * as path from 'path';
import globCallback from 'glob';
import * as vm from 'vm';

// Promisified glob wrapper
function glob(pattern: string, options: globCallback.IOptions = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    globCallback(pattern, options, (err, matches) => {
      if (err) reject(err);
      else resolve(matches);
    });
  });
}

// ==================== TYPES ====================

export type ScriptType =
  | 'pattern-discovery'    // Find code patterns
  | 'dependency-trace'     // Trace dependencies
  | 'test-finder'          // Find related tests
  | 'api-explorer'         // Explore API endpoints
  | 'db-query'             // Database exploration
  | 'architecture-map'     // Map architecture
  | 'change-impact'        // Analyze impact of changes
  | 'code-flow'            // Trace code execution flow
  | 'security-scan'        // Security pattern detection
  | 'performance-hotspot'; // Find performance issues

export interface ScriptRequest {
  type: ScriptType;
  query: string;
  context?: {
    files?: string[];
    symbols?: string[];
    language?: string;
    framework?: string;
  };
  options?: {
    maxResults?: number;
    timeout?: number;
    deep?: boolean;
  };
}

export interface ScriptResult {
  success: boolean;
  type: ScriptType;
  query: string;
  script: string;
  output: any;
  executionTime: number;
  metadata?: {
    filesAnalyzed?: number;
    patternsFound?: number;
    confidence?: number;
  };
}

export interface DiscoveredPattern {
  pattern: string;
  locations: Array<{
    file: string;
    line: number;
    snippet: string;
  }>;
  frequency: number;
  category: string;
}

export interface DependencyNode {
  name: string;
  path: string;
  imports: string[];
  importedBy: string[];
  depth: number;
}

export interface APIEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  handler?: string;
  middleware?: string[];
  params?: string[];
}

// ==================== SCRIPT TEMPLATES ====================

const SCRIPT_TEMPLATES: Record<ScriptType, string> = {
  'pattern-discovery': `
// Pattern Discovery Script
// Query: {{QUERY}}
const patterns = [];
const files = await glob('{{GLOB_PATTERN}}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');
  const regex = new RegExp('{{PATTERN}}', 'g');
  let match;
  while ((match = regex.exec(content)) !== null) {
    patterns.push({
      file,
      line: content.substring(0, match.index).split('\\n').length,
      match: match[0],
      context: content.split('\\n')[content.substring(0, match.index).split('\\n').length - 1]
    });
  }
}
return patterns;
`,

  'dependency-trace': `
// Dependency Trace Script
// Target: {{QUERY}}
const deps = new Map();
const visited = new Set();

async function trace(modulePath, depth = 0) {
  if (visited.has(modulePath) || depth > 10) return;
  visited.add(modulePath);

  const content = fs.readFileSync(modulePath, 'utf-8');
  const imports = [...content.matchAll(/(?:import|require)\\s*(?:\\{[^}]*\\}|\\*|\\w+)?\\s*(?:from)?\\s*['"]([^'"]+)['"]/g)]
    .map(m => m[1])
    .filter(i => !i.startsWith('.') || true);

  deps.set(modulePath, { imports, depth });

  for (const imp of imports) {
    if (imp.startsWith('.')) {
      const resolved = path.resolve(path.dirname(modulePath), imp);
      const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];
      for (const ext of extensions) {
        const full = resolved + ext;
        if (fs.existsSync(full)) {
          await trace(full, depth + 1);
          break;
        }
      }
    }
  }
}

await trace('{{TARGET_FILE}}');
return Array.from(deps.entries()).map(([k, v]) => ({ path: k, ...v }));
`,

  'test-finder': `
// Test Finder Script
// Source: {{QUERY}}
const sourceFile = '{{SOURCE_FILE}}';
const baseName = path.basename(sourceFile, path.extname(sourceFile));
const patterns = [
  \`**/*\${baseName}*.test.*\`,
  \`**/*\${baseName}*.spec.*\`,
  \`**/test/*\${baseName}*\`,
  \`**/tests/*\${baseName}*\`,
  \`**/__tests__/*\${baseName}*\`
];

const tests = [];
for (const pattern of patterns) {
  const found = await glob(pattern, { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });
  tests.push(...found.map(f => ({ pattern, file: f })));
}

// Also search for imports of the source file
const allTests = await glob('**/*.{test,spec}.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });
for (const testFile of allTests) {
  const content = fs.readFileSync(path.join('{{ROOT}}', testFile), 'utf-8');
  if (content.includes(baseName)) {
    tests.push({ pattern: 'import-reference', file: testFile });
  }
}

return [...new Set(tests.map(t => t.file))].map(f => ({ file: f }));
`,

  'api-explorer': `
// API Explorer Script
// Framework: {{FRAMEWORK}}
const endpoints = [];
const files = await glob('**/*.{ts,js}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**', '**/dist/**'] });

const patterns = {
  express: [
    /(?:app|router)\\.(get|post|put|patch|delete|all)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g,
    /@(Get|Post|Put|Patch|Delete|All)\\s*\\(\\s*['"\`]?([^'"\`\\)]+)['"\`]?\\s*\\)/g
  ],
  fastify: [
    /fastify\\.(get|post|put|patch|delete)\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]/g
  ],
  nest: [
    /@(Get|Post|Put|Patch|Delete|All)\\s*\\(\\s*['"\`]?([^'"\`\\)]+)?['"\`]?\\s*\\)/g,
    /@Controller\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)/g
  ]
};

const relevantPatterns = patterns['{{FRAMEWORK}}'] || patterns.express;

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');
  const lines = content.split('\\n');

  for (const pattern of relevantPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\\n').length;
      endpoints.push({
        method: match[1]?.toUpperCase() || 'ROUTE',
        path: match[2] || '',
        file,
        line: lineNum,
        context: lines[lineNum - 1]?.trim()
      });
    }
    pattern.lastIndex = 0;
  }
}

return endpoints;
`,

  'db-query': `
// Database Query Generator Script
// Schema: {{QUERY}}
const schemas = [];
const files = await glob('**/*.{ts,js}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

const patterns = {
  mongoose: /new\\s+(?:mongoose\\.)?Schema\\s*\\(\\s*\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}/gs,
  prisma: /model\\s+(\\w+)\\s*\\{([^}]+)\\}/g,
  typeorm: /@Entity\\s*\\(.*?\\)[\\s\\S]*?class\\s+(\\w+)/g,
  sequelize: /sequelize\\.define\\s*\\(\\s*['"\`](\\w+)['"\`]/g
};

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');

  for (const [orm, pattern] of Object.entries(patterns)) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      schemas.push({
        orm,
        file,
        name: match[1] || 'Schema',
        definition: match[0].substring(0, 500)
      });
    }
    pattern.lastIndex = 0;
  }
}

return schemas;
`,

  'architecture-map': `
// Architecture Mapping Script
const structure = {
  layers: {},
  dependencies: [],
  entryPoints: [],
  modules: []
};

const files = await glob('**/*.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**', '**/dist/**'] });

// Detect layers
const layerPatterns = {
  controllers: /\\/(?:controllers?|routes?|api)\\//i,
  services: /\\/(?:services?|business|domain)\\//i,
  repositories: /\\/(?:repositories?|data|dal|models?)\\//i,
  utils: /\\/(?:utils?|helpers?|lib|common)\\//i,
  config: /\\/(?:config|settings)\\//i,
  middleware: /\\/(?:middleware|interceptors?)\\//i
};

for (const file of files) {
  for (const [layer, pattern] of Object.entries(layerPatterns)) {
    if (pattern.test(file)) {
      structure.layers[layer] = structure.layers[layer] || [];
      structure.layers[layer].push(file);
    }
  }
}

// Detect entry points
const entryPatterns = ['**/index.{ts,js}', '**/main.{ts,js}', '**/app.{ts,js}', '**/server.{ts,js}'];
for (const pattern of entryPatterns) {
  const entries = await glob(pattern, { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });
  structure.entryPoints.push(...entries);
}

return structure;
`,

  'change-impact': `
// Change Impact Analysis Script
// Changed file: {{QUERY}}
const changedFile = '{{TARGET_FILE}}';
const impacted = new Set();
const allFiles = await glob('**/*.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

const baseName = path.basename(changedFile, path.extname(changedFile));
const relativePath = path.relative('{{ROOT}}', changedFile);

for (const file of allFiles) {
  if (file === relativePath) continue;

  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');

  // Check direct imports
  if (content.includes(baseName) || content.includes(relativePath.replace(/\\.tsx?$/, ''))) {
    impacted.add(file);
  }
}

// Get test files that might be affected
const testPattern = \`**/*\${baseName}*.{test,spec}.*\`;
const tests = await glob(testPattern, { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });
tests.forEach(t => impacted.add(t));

return {
  changedFile,
  directlyImpacted: [...impacted].filter(f => !f.includes('.test.') && !f.includes('.spec.')),
  testsToRun: [...impacted].filter(f => f.includes('.test.') || f.includes('.spec.'))
};
`,

  'code-flow': `
// Code Flow Tracing Script
// Function: {{QUERY}}
const functionName = '{{FUNCTION_NAME}}';
const flows = [];
const files = await glob('**/*.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');
  const lines = content.split('\\n');

  // Find function definition
  const defPattern = new RegExp(\`(?:function|const|let|var)\\\\s+\${functionName}|\\\\.\${functionName}\\\\s*=\`, 'g');
  let match;
  while ((match = defPattern.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\\n').length;
    flows.push({
      type: 'definition',
      file,
      line: lineNum,
      context: lines[lineNum - 1]?.trim()
    });
  }

  // Find function calls
  const callPattern = new RegExp(\`(?<!function\\\\s+)(?<!const\\\\s+)\${functionName}\\\\s*\\\\(\`, 'g');
  while ((match = callPattern.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\\n').length;
    flows.push({
      type: 'call',
      file,
      line: lineNum,
      context: lines[lineNum - 1]?.trim()
    });
  }
}

return flows;
`,

  'security-scan': `
// Security Pattern Scanner Script
const issues = [];
const files = await glob('**/*.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

const securityPatterns = [
  { pattern: /eval\\s*\\(/g, severity: 'critical', message: 'Dangerous eval() usage' },
  { pattern: /innerHTML\\s*=/g, severity: 'high', message: 'Potential XSS via innerHTML' },
  { pattern: /dangerouslySetInnerHTML/g, severity: 'high', message: 'React dangerouslySetInnerHTML usage' },
  { pattern: /password\\s*[:=]\\s*['"][^'"]+['"]/gi, severity: 'critical', message: 'Hardcoded password' },
  { pattern: /api[_-]?key\\s*[:=]\\s*['"][^'"]+['"]/gi, severity: 'critical', message: 'Hardcoded API key' },
  { pattern: /exec\\s*\\(/g, severity: 'high', message: 'Shell command execution' },
  { pattern: /\\$\\{.*\\}/g, severity: 'medium', message: 'Template literal (check for injection)' },
  { pattern: /\\\\x[0-9a-f]{2}/gi, severity: 'medium', message: 'Hex escape sequence' }
];

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');
  const lines = content.split('\\n');

  for (const { pattern, severity, message } of securityPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\\n').length;
      issues.push({
        severity,
        message,
        file,
        line: lineNum,
        snippet: lines[lineNum - 1]?.trim().substring(0, 100)
      });
    }
    pattern.lastIndex = 0;
  }
}

return issues.sort((a, b) => {
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return order[a.severity] - order[b.severity];
});
`,

  'performance-hotspot': `
// Performance Hotspot Detection Script
const hotspots = [];
const files = await glob('**/*.{ts,tsx,js,jsx}', { cwd: '{{ROOT}}', ignore: ['**/node_modules/**'] });

const patterns = [
  { pattern: /\\.map\\s*\\([^)]+\\)\\.map\\s*\\(/g, type: 'chained-map', impact: 'medium' },
  { pattern: /for\\s*\\([^)]+\\)\\s*\\{[^}]*for\\s*\\(/g, type: 'nested-loop', impact: 'high' },
  { pattern: /JSON\\.parse\\s*\\(\\s*JSON\\.stringify/g, type: 'deep-clone', impact: 'medium' },
  { pattern: /await\\s+\\w+\\s*;\\s*await\\s+\\w+/g, type: 'sequential-await', impact: 'medium' },
  { pattern: /useEffect\\s*\\([^)]*\\[\\s*\\]/g, type: 'effect-no-deps', impact: 'low' },
  { pattern: /new\\s+RegExp\\s*\\(/g, type: 'dynamic-regex', impact: 'low' },
  { pattern: /\\.filter\\([^)]+\\)\\.map\\([^)]+\\)\\.filter/g, type: 'chained-array-ops', impact: 'medium' }
];

for (const file of files) {
  const content = fs.readFileSync(path.join('{{ROOT}}', file), 'utf-8');
  const lines = content.split('\\n');

  for (const { pattern, type, impact } of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNum = content.substring(0, match.index).split('\\n').length;
      hotspots.push({
        type,
        impact,
        file,
        line: lineNum,
        snippet: lines[lineNum - 1]?.trim().substring(0, 100)
      });
    }
    pattern.lastIndex = 0;
  }
}

return hotspots.sort((a, b) => {
  const order = { high: 0, medium: 1, low: 2 };
  return order[a.impact] - order[b.impact];
});
`
};

// ==================== ENGINE IMPLEMENTATION ====================

export class DynamicScriptEngine {
  private workspaceRoot: string;
  private scriptCache: Map<string, { script: string; result: any; timestamp: number }> = new Map();
  private cacheTimeout: number = 5 * 60 * 1000; // 5 minutes

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Generate and execute a dynamic exploration script
   */
  async execute(request: ScriptRequest): Promise<ScriptResult> {
    const startTime = Date.now();

    // Check cache
    const cacheKey = this.getCacheKey(request);
    const cached = this.scriptCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return {
        success: true,
        type: request.type,
        query: request.query,
        script: cached.script,
        output: cached.result,
        executionTime: 0,
        metadata: { fromCache: true } as any
      };
    }

    // Generate script
    const script = this.generateScript(request);

    // Execute script
    try {
      const output = await this.executeScript(script, request);

      // Cache result
      this.scriptCache.set(cacheKey, {
        script,
        result: output,
        timestamp: Date.now()
      });

      return {
        success: true,
        type: request.type,
        query: request.query,
        script,
        output,
        executionTime: Date.now() - startTime,
        metadata: this.extractMetadata(output)
      };
    } catch (error: any) {
      return {
        success: false,
        type: request.type,
        query: request.query,
        script,
        output: { error: error.message },
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * Generate a script from template
   */
  private generateScript(request: ScriptRequest): string {
    let template = SCRIPT_TEMPLATES[request.type];

    if (!template) {
      throw new Error(`Unknown script type: ${request.type}`);
    }

    // Replace placeholders
    template = template
      .replace(/\{\{ROOT\}\}/g, this.workspaceRoot)
      .replace(/\{\{QUERY\}\}/g, request.query)
      .replace(/\{\{PATTERN\}\}/g, this.escapeRegex(request.query))
      .replace(/\{\{GLOB_PATTERN\}\}/g, this.getGlobPattern(request))
      .replace(/\{\{TARGET_FILE\}\}/g, request.context?.files?.[0] || '')
      .replace(/\{\{SOURCE_FILE\}\}/g, request.context?.files?.[0] || '')
      .replace(/\{\{FUNCTION_NAME\}\}/g, request.context?.symbols?.[0] || request.query)
      .replace(/\{\{FRAMEWORK\}\}/g, request.context?.framework || 'express')
      .replace(/\{\{LANGUAGE\}\}/g, request.context?.language || 'typescript');

    return template;
  }

  /**
   * Execute script in sandboxed context
   */
  private async executeScript(script: string, request: ScriptRequest): Promise<any> {
    // Create sandbox context
    const sandbox = {
      fs,
      path,
      glob,
      console: {
        log: () => {},
        error: () => {},
        warn: () => {}
      },
      require: (mod: string) => {
        // Only allow safe modules
        const allowed = ['fs', 'path'];
        if (allowed.includes(mod)) {
          return require(mod);
        }
        throw new Error(`Module not allowed: ${mod}`);
      },
      setTimeout,
      Promise,
      Array,
      Object,
      JSON,
      Map,
      Set,
      RegExp,
      result: null
    };

    // Wrap script in async function
    const wrappedScript = `
      (async () => {
        ${script}
      })()
    `;

    // Execute with timeout
    const timeout = request.options?.timeout || 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Script execution timeout (${timeout}ms)`));
      }, timeout);

      try {
        const context = vm.createContext(sandbox);
        const result = vm.runInContext(wrappedScript, context, {
          timeout,
          filename: `dynamic-${request.type}.js`
        });

        Promise.resolve(result)
          .then(output => {
            clearTimeout(timer);
            resolve(output);
          })
          .catch(err => {
            clearTimeout(timer);
            reject(err);
          });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * Get glob pattern based on request
   */
  private getGlobPattern(request: ScriptRequest): string {
    const language = request.context?.language || 'typescript';

    const patterns: Record<string, string> = {
      typescript: '**/*.{ts,tsx}',
      javascript: '**/*.{js,jsx}',
      python: '**/*.py',
      go: '**/*.go',
      rust: '**/*.rs',
      java: '**/*.java',
      all: '**/*.{ts,tsx,js,jsx,py,go,rs,java}'
    };

    return patterns[language] || patterns.all;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Generate cache key
   */
  private getCacheKey(request: ScriptRequest): string {
    return `${request.type}:${request.query}:${JSON.stringify(request.context)}`;
  }

  /**
   * Extract metadata from output
   */
  private extractMetadata(output: any): Record<string, any> {
    if (!output) return {};

    if (Array.isArray(output)) {
      return {
        patternsFound: output.length,
        filesAnalyzed: new Set(output.map((o: any) => o.file)).size
      };
    }

    return {
      hasResults: Object.keys(output).length > 0
    };
  }

  /**
   * Clear script cache
   */
  clearCache(): void {
    this.scriptCache.clear();
  }

  /**
   * Get available script types
   */
  getAvailableTypes(): ScriptType[] {
    return Object.keys(SCRIPT_TEMPLATES) as ScriptType[];
  }

  /**
   * Create a custom script (for advanced use)
   */
  async executeCustom(script: string, timeout: number = 30000): Promise<any> {
    return this.executeScript(script, {
      type: 'pattern-discovery',
      query: 'custom',
      options: { timeout }
    });
  }
}

// ==================== CONVENIENCE FUNCTIONS ====================

/**
 * Quick pattern discovery
 */
export async function findPatterns(
  query: string,
  workspaceRoot: string = process.cwd()
): Promise<DiscoveredPattern[]> {
  const engine = new DynamicScriptEngine(workspaceRoot);
  const result = await engine.execute({
    type: 'pattern-discovery',
    query
  });
  return result.output || [];
}

/**
 * Quick dependency trace
 */
export async function traceDependencies(
  filePath: string,
  workspaceRoot: string = process.cwd()
): Promise<DependencyNode[]> {
  const engine = new DynamicScriptEngine(workspaceRoot);
  const result = await engine.execute({
    type: 'dependency-trace',
    query: filePath,
    context: { files: [filePath] }
  });
  return result.output || [];
}

/**
 * Quick API discovery
 */
export async function discoverAPIs(
  framework: string = 'express',
  workspaceRoot: string = process.cwd()
): Promise<APIEndpoint[]> {
  const engine = new DynamicScriptEngine(workspaceRoot);
  const result = await engine.execute({
    type: 'api-explorer',
    query: 'all endpoints',
    context: { framework }
  });
  return result.output || [];
}

/**
 * Quick security scan
 */
export async function scanSecurity(
  workspaceRoot: string = process.cwd()
): Promise<any[]> {
  const engine = new DynamicScriptEngine(workspaceRoot);
  const result = await engine.execute({
    type: 'security-scan',
    query: 'all'
  });
  return result.output || [];
}

export default DynamicScriptEngine;
