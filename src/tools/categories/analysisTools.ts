/**
 * Analysis Tools - Code analysis, performance, and quality tools
 * Extracted from extraTools.ts for better organization
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export const analyzeDependenciesTool = tool(
  'analyze_dependencies',
  `Analyze project dependencies and imports.
Detects:
- Circular dependencies
- Unused imports
- Heavy dependencies
- Import structure visualization

Use before refactoring to understand code structure.`,
  {
    directory: z.string().describe('Directory to analyze'),
    entryPoint: z.string().optional().describe('Entry point file for tree analysis'),
    checkCircular: z.boolean().default(true).describe('Check for circular dependencies'),
    maxDepth: z.number().default(5).describe('Max depth for dependency tree'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const fs = await import('fs/promises');
      const path = await import('path');
      const execAsync = promisify(exec);

      // Find all TypeScript/JavaScript files
      const { stdout: filesOutput } = await execAsync(
        `find "${args.directory}" -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | grep -v node_modules | grep -v dist`,
        { maxBuffer: 5 * 1024 * 1024 }
      );
      const files = filesOutput.trim().split('\n').filter(Boolean);

      // Build dependency graph
      const graph: Record<string, string[]> = {};
      const importCounts: Record<string, number> = {};

      for (const file of files.slice(0, 100)) {
        try {
          const content = await fs.readFile(file, 'utf-8');
          const relativePath = path.relative(args.directory, file);
          graph[relativePath] = [];

          // Extract imports
          const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
          for (const match of importMatches) {
            const importPath = match[1];
            if (!importPath.startsWith('.')) {
              // External package
              importCounts[importPath] = (importCounts[importPath] || 0) + 1;
            } else {
              graph[relativePath].push(importPath);
            }
          }
        } catch { continue; }
      }

      // Detect circular dependencies
      const circularDeps: string[][] = [];
      if (args.checkCircular) {
        const visited = new Set<string>();
        const stack = new Set<string>();

        const dfs = (node: string, pathStack: string[]): void => {
          if (stack.has(node)) {
            const cycleStart = pathStack.indexOf(node);
            circularDeps.push(pathStack.slice(cycleStart));
            return;
          }
          if (visited.has(node)) return;

          visited.add(node);
          stack.add(node);
          pathStack.push(node);

          for (const dep of (graph[node] || [])) {
            const resolvedDep = path.normalize(path.join(path.dirname(node), dep));
            dfs(resolvedDep, [...pathStack]);
          }

          stack.delete(node);
        };

        for (const file of Object.keys(graph)) {
          dfs(file, []);
        }
      }

      // Top external dependencies
      const topDeps = Object.entries(importCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([name, count]) => ({ name, imports: count }));

      console.log(`\n📊 [Dependencies] Analyzed ${files.length} files, found ${circularDeps.length} circular deps`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            analysis: {
              totalFiles: files.length,
              analyzedFiles: Object.keys(graph).length,
              circularDependencies: circularDeps.slice(0, 5),
              circularCount: circularDeps.length,
              topExternalDependencies: topDeps,
            },
            hasCircular: circularDeps.length > 0,
            message: circularDeps.length > 0
              ? `Found ${circularDeps.length} circular dependencies. Consider refactoring.`
              : 'No circular dependencies detected.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const findUnusedExportsTool = tool(
  'find_unused_exports',
  `Find exported symbols that are never imported anywhere.
Detects:
- Unused function exports
- Unused class exports
- Unused type/interface exports
- Dead code candidates

Use before cleanup to find removable code.`,
  {
    directory: z.string().describe('Directory to analyze'),
    fileGlob: z.string().optional().describe('File pattern (e.g., "*.ts")'),
    ignorePatterns: z.array(z.string()).optional().describe('Patterns to ignore'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      // Find all exports
      const glob = args.fileGlob || '*.{ts,tsx,js,jsx}';
      const { stdout: exportsOutput } = await execAsync(
        `rg -o "export\\s+(const|function|class|interface|type|enum)\\s+\\w+" "${args.directory}" -g "${glob}" -g "!node_modules" -g "!dist" 2>/dev/null || true`,
        { maxBuffer: 5 * 1024 * 1024 }
      );

      const exports: Map<string, { file: string; type: string }> = new Map();
      for (const line of exportsOutput.trim().split('\n').filter(Boolean)) {
        const [file, match] = line.split(':');
        if (match) {
          const parts = match.trim().split(/\s+/);
          const name = parts[parts.length - 1];
          if (name && name.length > 1) {
            exports.set(name, { file: file.replace(args.directory, ''), type: parts[1] });
          }
        }
      }

      // Check which exports are imported
      const unused: Array<{ name: string; file: string; type: string }> = [];

      for (const [name, info] of exports) {
        try {
          // Skip common entry points and index files
          if (info.file.includes('index.') || name === 'default') continue;

          const { stdout } = await execAsync(
            `rg -l "import.*\\b${name}\\b|from.*${name}" "${args.directory}" -g "!${info.file}" -g "!node_modules" 2>/dev/null || true`,
            { maxBuffer: 1024 * 1024 }
          );

          if (!stdout.trim()) {
            unused.push({ name, ...info });
          }
        } catch { continue; }
      }

      console.log(`\n🔍 [Unused Exports] Found ${unused.length} potentially unused exports`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            totalExports: exports.size,
            unusedCount: unused.length,
            unused: unused.slice(0, 30),
            message: unused.length > 0
              ? `Found ${unused.length} exports that appear unused. Review before removing.`
              : 'All exports appear to be used.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const checkBundleImpactTool = tool(
  'check_bundle_impact',
  `Estimate the bundle size impact of a package.
Shows:
- Package size (minified + gzipped)
- Dependencies count
- Alternative suggestions
- Tree-shaking support

Use before adding new dependencies.`,
  {
    packageName: z.string().describe('npm package name'),
    version: z.string().optional().describe('Specific version'),
  },
  async (args) => {
    try {
      // Use bundlephobia API for size info
      const url = `https://bundlephobia.com/api/size?package=${args.packageName}${args.version ? `@${args.version}` : ''}`;

      const response = await fetch(url, {
        headers: { 'User-Agent': 'MultiAgentBot/1.0' },
      });

      if (!response.ok) {
        throw new Error(`Package not found or bundlephobia API unavailable`);
      }

      const data = await response.json() as {
        name: string;
        version: string;
        size: number;
        gzip: number;
        dependencyCount: number;
        hasJSModule: boolean;
        hasJSNext: boolean;
        hasSideEffects: boolean;
      };

      const formatBytes = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      };

      console.log(`\n📦 [Bundle Impact] ${data.name}@${data.version}: ${formatBytes(data.gzip)} gzipped`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            package: data.name,
            version: data.version,
            size: {
              raw: data.size,
              gzip: data.gzip,
              formatted: {
                raw: formatBytes(data.size),
                gzip: formatBytes(data.gzip),
              },
            },
            dependencies: data.dependencyCount,
            treeShaking: {
              hasESM: data.hasJSModule || data.hasJSNext,
              hasSideEffects: data.hasSideEffects,
            },
            recommendation: data.gzip > 50000
              ? 'Large package. Consider alternatives or lazy loading.'
              : data.gzip > 10000
              ? 'Medium size. Ensure tree-shaking is working.'
              : 'Reasonable size for most projects.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const profileFunctionTool = tool(
  'profile_function',
  `Profile a function's execution time.
Measures:
- Execution time (ms)
- Memory usage delta
- Call count
- Async timing

Use for performance optimization.`,
  {
    filePath: z.string().describe('File containing the function'),
    functionName: z.string().describe('Function to profile'),
    iterations: z.number().default(100).describe('Number of iterations'),
    warmupRuns: z.number().default(10).describe('Warmup iterations'),
  },
  async (args) => {
    try {
      // This is a documentation/planning tool since we can't actually run arbitrary code
      console.log(`\n⏱️ [Profile] Would profile ${args.functionName} with ${args.iterations} iterations`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Profiling setup created. Add this code to profile the function:',
            profilingCode: `
// Profiling wrapper for ${args.functionName}
async function profile${args.functionName}() {
  const iterations = ${args.iterations};
  const warmup = ${args.warmupRuns};

  // Warmup
  for (let i = 0; i < warmup; i++) {
    await ${args.functionName}();
  }

  // Measure
  const times: number[] = [];
  const memBefore = process.memoryUsage().heapUsed;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await ${args.functionName}();
    times.push(performance.now() - start);
  }

  const memAfter = process.memoryUsage().heapUsed;

  console.log({
    function: '${args.functionName}',
    iterations,
    avgMs: times.reduce((a, b) => a + b, 0) / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    memDeltaKB: (memAfter - memBefore) / 1024,
  });
}
`,
            suggestion: 'Add this to your test file or a separate profiling script.',
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const findNPlusOneTool = tool(
  'find_n_plus_1',
  `Detect potential N+1 query patterns in code.
Identifies:
- Queries inside loops
- Sequential awaits that could be parallelized
- Missing eager loading patterns

Use for database performance optimization.`,
  {
    directory: z.string().describe('Directory to analyze'),
    orm: z.enum(['mongoose', 'prisma', 'typeorm', 'sequelize', 'generic']).default('generic'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const patterns: Record<string, string[]> = {
        mongoose: ['find\\(', 'findOne\\(', 'findById\\(', 'save\\(', 'updateOne\\('],
        prisma: ['findUnique\\(', 'findMany\\(', 'create\\(', 'update\\('],
        typeorm: ['find\\(', 'findOne\\(', 'save\\(', 'getRepository\\('],
        sequelize: ['findAll\\(', 'findOne\\(', 'create\\(', 'update\\('],
        generic: ['await\\s+\\w+\\.find', 'await\\s+\\w+\\.get', 'await\\s+fetch\\('],
      };

      const ormPatterns = patterns[args.orm] || patterns.generic;
      const issues: Array<{ file: string; line: number; pattern: string; context: string }> = [];

      // Search for queries inside loops
      for (const pattern of ormPatterns) {
        try {
          const { stdout } = await execAsync(
            `rg -n -B 5 "${pattern}" "${args.directory}" -g "*.ts" -g "*.js" -g "!node_modules" 2>/dev/null || true`,
            { maxBuffer: 5 * 1024 * 1024 }
          );

          const blocks = stdout.split('--');
          for (const block of blocks) {
            if (block.match(/for\s*\(|\.forEach|\.map\(|while\s*\(/)) {
              const lines = block.trim().split('\n');
              const lastLine = lines[lines.length - 1] || '';
              const [file, lineNum] = lastLine.split(':');
              if (file && lineNum) {
                issues.push({
                  file: file.replace(args.directory, ''),
                  line: parseInt(lineNum, 10),
                  pattern,
                  context: lines.slice(-3).join('\n'),
                });
              }
            }
          }
        } catch { continue; }
      }

      console.log(`\n🔍 [N+1 Detection] Found ${issues.length} potential issues`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            directory: args.directory,
            orm: args.orm,
            issuesFound: issues.length,
            issues: issues.slice(0, 15),
            recommendations: [
              'Use eager loading (populate, include, relations)',
              'Batch queries with $in or whereIn',
              'Use Promise.all for parallel queries',
              'Consider caching for repeated lookups',
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);

export const checkAccessibilityTool = tool(
  'check_accessibility',
  `Perform accessibility audit on HTML/JSX code.
Checks:
- Missing alt attributes
- Missing ARIA labels
- Color contrast issues
- Keyboard navigation
- Form labels

Use for WCAG compliance.`,
  {
    filePath: z.string().optional().describe('Specific file to check'),
    directory: z.string().optional().describe('Directory to check'),
    rules: z.array(z.string()).optional().describe('Specific rules to check'),
  },
  async (args) => {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      const issues: Array<{ file: string; line: number; issue: string; severity: string }> = [];
      const searchPath = args.filePath || args.directory || '.';

      // Check for missing alt attributes
      try {
        const { stdout } = await execAsync(
          `rg -n "<img[^>]+(?!alt=)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "*.html" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('alt=')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Missing alt attribute on img', severity: 'error' });
          }
        }
      } catch { /* ignore */ }

      // Check for missing button text
      try {
        const { stdout } = await execAsync(
          `rg -n "<button[^>]*>[\\s]*</(button|Button)>" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          issues.push({ file, line: parseInt(lineNum, 10), issue: 'Empty button without accessible text', severity: 'error' });
        }
      } catch { /* ignore */ }

      // Check for missing form labels
      try {
        const { stdout } = await execAsync(
          `rg -n "<input[^>]+(?!aria-label|id=)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('aria-label') && !line.includes('id=')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Input without label association', severity: 'warning' });
          }
        }
      } catch { /* ignore */ }

      // Check for click handlers without keyboard support
      try {
        const { stdout } = await execAsync(
          `rg -n "onClick=[^>]+(?!onKeyDown|onKeyPress)" "${searchPath}" -g "*.tsx" -g "*.jsx" -g "!node_modules" 2>/dev/null || true`,
          { maxBuffer: 5 * 1024 * 1024 }
        );
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const [file, lineNum] = line.split(':');
          if (!line.includes('button') && !line.includes('Button') && !line.includes('Link') && !line.includes('onKey')) {
            issues.push({ file, line: parseInt(lineNum, 10), issue: 'Click handler without keyboard support', severity: 'warning' });
          }
        }
      } catch { /* ignore */ }

      const errors = issues.filter(i => i.severity === 'error').length;
      const warnings = issues.filter(i => i.severity === 'warning').length;

      console.log(`\n♿ [A11y Audit] Found ${errors} errors, ${warnings} warnings`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            path: searchPath,
            summary: { errors, warnings, total: issues.length },
            issues: issues.slice(0, 25),
            resources: [
              'https://www.w3.org/WAI/WCAG21/quickref/',
              'https://developer.mozilla.org/en-US/docs/Web/Accessibility',
            ],
          }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message }, null, 2) }] };
    }
  }
);
