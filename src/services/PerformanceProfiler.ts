/**
 * PerformanceProfiler - Code performance analysis service
 *
 * Analyzes code for performance bottlenecks, complexity hotspots,
 * and optimization opportunities through static analysis.
 */

import * as fs from 'fs';
import * as path from 'path';

interface PerformanceIssue {
  type: PerformanceIssueType;
  severity: 'info' | 'warning' | 'critical';
  file: string;
  line: number;
  code: string;
  description: string;
  suggestion: string;
  estimatedImpact: string;
}

type PerformanceIssueType =
  | 'nested-loop'
  | 'n-plus-one'
  | 'large-bundle-import'
  | 'synchronous-io'
  | 'memory-leak-potential'
  | 'inefficient-regex'
  | 'unnecessary-rerender'
  | 'blocking-operation'
  | 'excessive-dom-manipulation'
  | 'missing-memoization'
  | 'large-array-operation'
  | 'string-concatenation-loop'
  | 'deep-object-clone'
  | 'sync-in-async-context';

interface ComplexityMetrics {
  file: string;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  linesOfCode: number;
  functionCount: number;
  maxNestingDepth: number;
  halsteadDifficulty: number;
  maintainabilityIndex: number;
}

interface ProfileReport {
  summary: {
    totalFiles: number;
    totalIssues: number;
    criticalIssues: number;
    warningIssues: number;
    infoIssues: number;
    averageComplexity: number;
    hotspots: string[];
  };
  issues: PerformanceIssue[];
  metrics: ComplexityMetrics[];
  recommendations: string[];
  estimatedImprovements: {
    category: string;
    potential: string;
    effort: string;
  }[];
}

interface FunctionProfile {
  name: string;
  file: string;
  line: number;
  complexity: number;
  estimatedTimeComplexity: string;
  estimatedSpaceComplexity: string;
  dependencies: string[];
  issues: PerformanceIssue[];
}

// Performance anti-patterns to detect
const PERFORMANCE_PATTERNS = {
  nestedLoops: {
    // Nested for/while loops (O(n²) or worse)
    pattern: /for\s*\([^)]+\)\s*\{[^}]*for\s*\([^)]+\)/gs,
    type: 'nested-loop' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Nested loops detected - potential O(n²) complexity',
    suggestion: 'Consider using a Map/Set for O(1) lookups, or restructure algorithm'
  },
  nPlusOne: {
    // Database queries inside loops
    pattern: /(?:for|while|\.forEach|\.map)\s*\([^)]*\)\s*(?:\{|=>)[^}]*(?:\.find|\.findOne|\.query|await.*fetch)/gs,
    type: 'n-plus-one' as PerformanceIssueType,
    severity: 'critical' as const,
    description: 'Potential N+1 query problem - database calls inside loop',
    suggestion: 'Batch queries using $in operator or eager loading'
  },
  largeBundleImport: {
    // Importing entire libraries
    pattern: /import\s+\*\s+as\s+\w+\s+from\s+['"](?:lodash|moment|rxjs)['"]/g,
    type: 'large-bundle-import' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Importing entire library - increases bundle size',
    suggestion: 'Use named imports or tree-shakable alternatives'
  },
  syncIO: {
    // Synchronous file operations
    pattern: /(?:fs\.readFileSync|fs\.writeFileSync|fs\.readdirSync|fs\.statSync|fs\.existsSync)\s*\(/g,
    type: 'synchronous-io' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Synchronous I/O operation blocks event loop',
    suggestion: 'Use async/await with fs.promises or async callbacks'
  },
  memoryLeak: {
    // Event listeners without cleanup
    pattern: /addEventListener\s*\([^)]+\)(?![^]*removeEventListener)/gs,
    type: 'memory-leak-potential' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Event listener without corresponding removal',
    suggestion: 'Add cleanup in useEffect return or componentWillUnmount'
  },
  inefficientRegex: {
    // Catastrophic backtracking patterns
    pattern: /new RegExp\s*\([^)]*(?:\.\*){2,}|\/(?:[^/]*(?:\.\*){2,}[^/]*)\/[gimsuy]*/g,
    type: 'inefficient-regex' as PerformanceIssueType,
    severity: 'critical' as const,
    description: 'Regex with potential catastrophic backtracking',
    suggestion: 'Refactor regex to avoid nested quantifiers'
  },
  unnecessaryRerender: {
    // Inline functions/objects in JSX
    pattern: /<\w+[^>]+(?:onClick|onChange|onSubmit)=\{(?:\(\)|function|\([^)]*\)\s*=>)[^}]+\}/g,
    type: 'unnecessary-rerender' as PerformanceIssueType,
    severity: 'info' as const,
    description: 'Inline function in JSX causes unnecessary re-renders',
    suggestion: 'Extract to useCallback or class method'
  },
  blockingOperation: {
    // Long synchronous operations
    pattern: /(?:JSON\.parse|JSON\.stringify)\s*\([^)]*(?:\w+|\[[^\]]+\])\s*\)/g,
    type: 'blocking-operation' as PerformanceIssueType,
    severity: 'info' as const,
    description: 'JSON operations can block on large data',
    suggestion: 'Consider streaming JSON parser for large payloads'
  },
  excessiveDOM: {
    // Multiple DOM manipulations
    pattern: /(?:document\.querySelector|document\.getElementById)[^;]*;[^;]*(?:document\.querySelector|document\.getElementById)/g,
    type: 'excessive-dom-manipulation' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Multiple DOM queries could be batched',
    suggestion: 'Cache DOM references or use document fragments'
  },
  missingMemo: {
    // Expensive calculations in render
    pattern: /(?:return|render)[^}]*(?:\.map|\.filter|\.reduce|\.sort)\s*\([^)]+\)(?![^]*useMemo)/gs,
    type: 'missing-memoization' as PerformanceIssueType,
    severity: 'info' as const,
    description: 'Array operation in render without memoization',
    suggestion: 'Wrap with useMemo to prevent recalculation on each render'
  },
  largeArrayOp: {
    // Operations on potentially large arrays
    pattern: /(?:\.sort\(\)|\.reverse\(\)|\.splice\()/g,
    type: 'large-array-operation' as PerformanceIssueType,
    severity: 'info' as const,
    description: 'In-place array mutation on potentially large array',
    suggestion: 'Consider using slice() before mutation to avoid side effects'
  },
  stringConcat: {
    // String concatenation in loops
    pattern: /(?:for|while)[^{]*\{[^}]*(?:\+=\s*['"`]|['"`]\s*\+)/g,
    type: 'string-concatenation-loop' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'String concatenation in loop - inefficient',
    suggestion: 'Use array.join() or template literals'
  },
  deepClone: {
    // Deep cloning with JSON
    pattern: /JSON\.parse\s*\(\s*JSON\.stringify/g,
    type: 'deep-object-clone' as PerformanceIssueType,
    severity: 'info' as const,
    description: 'JSON-based deep clone is slow for large objects',
    suggestion: 'Use structuredClone() or spread for shallow clone'
  },
  syncInAsync: {
    // Sync operations in async functions
    pattern: /async\s+(?:function|\([^)]*\)\s*=>)[^}]*(?:fs\.readFileSync|fs\.writeFileSync)/gs,
    type: 'sync-in-async-context' as PerformanceIssueType,
    severity: 'warning' as const,
    description: 'Synchronous operation inside async function',
    suggestion: 'Replace with async equivalent (fs.promises)'
  }
};

export class PerformanceProfiler {

  /**
   * Profile a single file for performance issues
   */
  async profileFile(filePath: string): Promise<{
    issues: PerformanceIssue[];
    metrics: ComplexityMetrics;
    functions: FunctionProfile[];
  }> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = this.detectIssues(content, filePath);
    const metrics = this.calculateMetrics(content, filePath);
    const functions = this.analyzeFunctions(content, filePath);

    return { issues, metrics, functions };
  }

  /**
   * Profile entire project
   */
  async profileProject(
    projectPath: string,
    options: {
      include?: string[];
      exclude?: string[];
      maxFiles?: number;
    } = {}
  ): Promise<ProfileReport> {
    const {
      include = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
      exclude = ['node_modules', 'dist', 'build', 'coverage'],
      maxFiles = 500
    } = options;

    const allIssues: PerformanceIssue[] = [];
    const allMetrics: ComplexityMetrics[] = [];
    const files = this.collectFiles(projectPath, include, exclude, maxFiles);

    for (const file of files) {
      try {
        const { issues, metrics } = await this.profileFile(file);
        allIssues.push(...issues);
        allMetrics.push(metrics);
      } catch {
        // Skip files that can't be analyzed
      }
    }

    return this.generateReport(allIssues, allMetrics);
  }

  /**
   * Analyze specific function for performance
   */
  analyzeFunction(code: string, functionName: string): FunctionProfile {
    const issues = this.detectIssues(code, 'inline');
    const complexity = this.calculateCyclomaticComplexity(code);
    const timeComplexity = this.estimateTimeComplexity(code);
    const spaceComplexity = this.estimateSpaceComplexity(code);
    const dependencies = this.extractDependencies(code);

    return {
      name: functionName,
      file: 'inline',
      line: 1,
      complexity,
      estimatedTimeComplexity: timeComplexity,
      estimatedSpaceComplexity: spaceComplexity,
      dependencies,
      issues
    };
  }

  /**
   * Get optimization suggestions for code
   */
  getOptimizationSuggestions(code: string): string[] {
    const suggestions: string[] = [];
    const issues = this.detectIssues(code, 'inline');

    // Group by type for consolidated suggestions
    const issuesByType = new Map<PerformanceIssueType, PerformanceIssue[]>();
    for (const issue of issues) {
      const existing = issuesByType.get(issue.type) || [];
      existing.push(issue);
      issuesByType.set(issue.type, existing);
    }

    for (const [type, typeIssues] of issuesByType) {
      if (typeIssues.length > 0) {
        const first = typeIssues[0];
        suggestions.push(
          `[${type}] ${first.description} (${typeIssues.length} occurrence${typeIssues.length > 1 ? 's' : ''}): ${first.suggestion}`
        );
      }
    }

    // Add general suggestions based on patterns
    if (code.includes('.map(') && code.includes('.filter(')) {
      suggestions.push(
        'Consider combining .map() and .filter() with .reduce() for single-pass iteration'
      );
    }

    if ((code.match(/async/g) || []).length > 3) {
      suggestions.push(
        'Multiple async operations could potentially be parallelized with Promise.all()'
      );
    }

    if (code.includes('new Date()') && code.includes('for')) {
      suggestions.push(
        'Date operations inside loops are expensive - consider caching Date instances'
      );
    }

    return suggestions;
  }

  /**
   * Compare two versions of code for performance changes
   */
  compareVersions(
    oldCode: string,
    newCode: string
  ): {
    improved: string[];
    degraded: string[];
    unchanged: string[];
  } {
    const oldIssues = this.detectIssues(oldCode, 'old');
    const newIssues = this.detectIssues(newCode, 'new');

    const oldTypes = new Set(oldIssues.map(i => i.type));
    const newTypes = new Set(newIssues.map(i => i.type));

    const improved: string[] = [];
    const degraded: string[] = [];
    const unchanged: string[] = [];

    for (const type of oldTypes) {
      if (!newTypes.has(type)) {
        improved.push(`Fixed: ${type}`);
      } else {
        unchanged.push(`Still present: ${type}`);
      }
    }

    for (const type of newTypes) {
      if (!oldTypes.has(type)) {
        degraded.push(`Introduced: ${type}`);
      }
    }

    // Compare complexity
    const oldComplexity = this.calculateCyclomaticComplexity(oldCode);
    const newComplexity = this.calculateCyclomaticComplexity(newCode);

    if (newComplexity < oldComplexity) {
      improved.push(`Complexity reduced: ${oldComplexity} → ${newComplexity}`);
    } else if (newComplexity > oldComplexity) {
      degraded.push(`Complexity increased: ${oldComplexity} → ${newComplexity}`);
    }

    return { improved, degraded, unchanged };
  }

  /**
   * Format report as markdown
   */
  formatReport(report: ProfileReport): string {
    const lines: string[] = [
      '# Performance Profile Report',
      '',
      '## Summary',
      '',
      `- **Files Analyzed:** ${report.summary.totalFiles}`,
      `- **Total Issues:** ${report.summary.totalIssues}`,
      `- **Critical:** ${report.summary.criticalIssues}`,
      `- **Warnings:** ${report.summary.warningIssues}`,
      `- **Info:** ${report.summary.infoIssues}`,
      `- **Average Complexity:** ${report.summary.averageComplexity.toFixed(1)}`,
      ''
    ];

    if (report.summary.hotspots.length > 0) {
      lines.push('### Hotspots (Files needing attention)', '');
      for (const hotspot of report.summary.hotspots) {
        lines.push(`- ${hotspot}`);
      }
      lines.push('');
    }

    if (report.issues.filter(i => i.severity === 'critical').length > 0) {
      lines.push('## Critical Issues', '');
      for (const issue of report.issues.filter(i => i.severity === 'critical')) {
        lines.push(`### ${issue.file}:${issue.line}`, '');
        lines.push(`**Type:** ${issue.type}`, '');
        lines.push(`**Description:** ${issue.description}`, '');
        lines.push(`**Code:**`);
        lines.push('```typescript');
        lines.push(issue.code.slice(0, 200) + (issue.code.length > 200 ? '...' : ''));
        lines.push('```');
        lines.push(`**Suggestion:** ${issue.suggestion}`, '');
        lines.push(`**Estimated Impact:** ${issue.estimatedImpact}`, '');
        lines.push('');
      }
    }

    lines.push('## Recommendations', '');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');

    lines.push('## Potential Improvements', '');
    lines.push('| Category | Potential | Effort |');
    lines.push('|----------|-----------|--------|');
    for (const imp of report.estimatedImprovements) {
      lines.push(`| ${imp.category} | ${imp.potential} | ${imp.effort} |`);
    }

    return lines.join('\n');
  }

  // Private helper methods

  private detectIssues(content: string, filePath: string): PerformanceIssue[] {
    const issues: PerformanceIssue[] = [];

    for (const [, config] of Object.entries(PERFORMANCE_PATTERNS)) {
      const regex = new RegExp(config.pattern.source, config.pattern.flags);
      let match;

      while ((match = regex.exec(content)) !== null) {
        const beforeMatch = content.slice(0, match.index);
        const lineNumber = beforeMatch.split('\n').length;

        issues.push({
          type: config.type,
          severity: config.severity,
          file: filePath,
          line: lineNumber,
          code: match[0],
          description: config.description,
          suggestion: config.suggestion,
          estimatedImpact: this.estimateImpact(config.type)
        });
      }
    }

    return issues;
  }

  private calculateMetrics(content: string, filePath: string): ComplexityMetrics {
    const lines = content.split('\n');
    const nonEmptyLines = lines.filter(l => l.trim().length > 0);

    return {
      file: filePath,
      cyclomaticComplexity: this.calculateCyclomaticComplexity(content),
      cognitiveComplexity: this.calculateCognitiveComplexity(content),
      linesOfCode: nonEmptyLines.length,
      functionCount: this.countFunctions(content),
      maxNestingDepth: this.calculateMaxNesting(content),
      halsteadDifficulty: this.calculateHalsteadDifficulty(content),
      maintainabilityIndex: this.calculateMaintainabilityIndex(content)
    };
  }

  private analyzeFunctions(content: string, filePath: string): FunctionProfile[] {
    const functions: FunctionProfile[] = [];
    const functionPattern = /(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(\w+)\s*\([^)]*\)\s*\{)/g;

    let match;

    while ((match = functionPattern.exec(content)) !== null) {
      const name = match[1] || match[2] || match[3];
      if (!name) continue;

      const beforeMatch = content.slice(0, match.index);
      const lineNumber = beforeMatch.split('\n').length;

      // Extract function body (simplified)
      const startIndex = match.index;
      const bodyStart = content.indexOf('{', startIndex);
      if (bodyStart === -1) continue;

      let braceCount = 1;
      let bodyEnd = bodyStart + 1;
      while (braceCount > 0 && bodyEnd < content.length) {
        if (content[bodyEnd] === '{') braceCount++;
        if (content[bodyEnd] === '}') braceCount--;
        bodyEnd++;
      }

      const functionBody = content.slice(startIndex, bodyEnd);

      functions.push({
        name,
        file: filePath,
        line: lineNumber,
        complexity: this.calculateCyclomaticComplexity(functionBody),
        estimatedTimeComplexity: this.estimateTimeComplexity(functionBody),
        estimatedSpaceComplexity: this.estimateSpaceComplexity(functionBody),
        dependencies: this.extractDependencies(functionBody),
        issues: this.detectIssues(functionBody, filePath)
      });
    }

    return functions;
  }

  private calculateCyclomaticComplexity(code: string): number {
    let complexity = 1;

    // Count decision points
    const patterns = [
      /\bif\b/g,
      /\belse\s+if\b/g,
      /\bfor\b/g,
      /\bwhile\b/g,
      /\bcase\b/g,
      /\bcatch\b/g,
      /\?\s*[^:]+:/g, // Ternary
      /&&/g,
      /\|\|/g
    ];

    for (const pattern of patterns) {
      const matches = code.match(pattern) || [];
      complexity += matches.length;
    }

    return complexity;
  }

  private calculateCognitiveComplexity(code: string): number {
    let complexity = 0;
    let nestingLevel = 0;
    const lines = code.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      // Structural complexity
      if (/\b(if|for|while|switch)\b/.test(trimmed)) {
        complexity += 1 + nestingLevel;
      }

      // Nesting
      if (trimmed.includes('{')) nestingLevel++;
      if (trimmed.includes('}')) nestingLevel = Math.max(0, nestingLevel - 1);

      // Breaks in linear flow
      if (/\b(break|continue|return|throw)\b/.test(trimmed)) {
        complexity++;
      }

      // Recursion (bonus complexity)
      const funcNameMatch = /\bfunction\s+(\w+)/.exec(code);
      if (funcNameMatch?.[1] && trimmed.includes(`${funcNameMatch[1]}(`)) {
        complexity += 2;
      }
    }

    return complexity;
  }

  private calculateMaxNesting(code: string): number {
    let maxNesting = 0;
    let currentNesting = 0;

    for (const char of code) {
      if (char === '{') {
        currentNesting++;
        maxNesting = Math.max(maxNesting, currentNesting);
      } else if (char === '}') {
        currentNesting = Math.max(0, currentNesting - 1);
      }
    }

    return maxNesting;
  }

  private calculateHalsteadDifficulty(code: string): number {
    // Simplified Halstead difficulty
    const operators = code.match(/[+\-*/%=<>!&|^~?:]+/g) || [];
    const operands = code.match(/\b[a-zA-Z_]\w*\b/g) || [];

    const uniqueOperators = new Set(operators).size;
    const uniqueOperands = new Set(operands).size;

    if (uniqueOperands === 0) return 0;

    return (uniqueOperators / 2) * (operands.length / uniqueOperands);
  }

  private calculateMaintainabilityIndex(code: string): number {
    const loc = code.split('\n').filter(l => l.trim()).length;
    const cc = this.calculateCyclomaticComplexity(code);
    const hv = Math.log2(loc * 10); // Simplified Halstead volume

    // Standard MI formula (simplified)
    const mi = 171 - 5.2 * Math.log(hv) - 0.23 * cc - 16.2 * Math.log(loc);

    return Math.max(0, Math.min(100, mi));
  }

  private countFunctions(code: string): number {
    const patterns = [
      /function\s+\w+/g,
      /(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g,
      /\w+\s*\([^)]*\)\s*\{/g
    ];

    let count = 0;
    for (const pattern of patterns) {
      count += (code.match(pattern) || []).length;
    }

    return count;
  }

  private estimateTimeComplexity(code: string): string {
    // Count nested loops
    const forMatches = code.match(/\bfor\b/g) || [];
    const whileMatches = code.match(/\bwhile\b/g) || [];
    const loopCount = forMatches.length + whileMatches.length;

    // Check for recursive patterns
    const hasRecursion = /(\w+)\s*\([^)]*\)[^}]*\1\s*\(/.test(code);

    // Check for nested loops
    const hasNestedLoops = /for[^{]*\{[^}]*for|while[^{]*\{[^}]*while/.test(code);

    if (hasRecursion) {
      if (code.includes('/2') || code.includes('>> 1')) {
        return 'O(log n)';
      }
      return 'O(2^n) or O(n!)';
    }

    if (hasNestedLoops) {
      const depth = this.countNestedLoopDepth(code);
      if (depth >= 3) return 'O(n³) or worse';
      if (depth === 2) return 'O(n²)';
    }

    if (loopCount > 0) return 'O(n)';

    return 'O(1)';
  }

  private countNestedLoopDepth(code: string): number {
    let maxDepth = 0;
    let currentDepth = 0;
    const lines = code.split('\n');

    for (const line of lines) {
      if (/\b(for|while)\b/.test(line)) {
        currentDepth++;
        maxDepth = Math.max(maxDepth, currentDepth);
      }
      if (line.includes('}')) {
        currentDepth = Math.max(0, currentDepth - 1);
      }
    }

    return maxDepth;
  }

  private estimateSpaceComplexity(code: string): string {
    // Check for array/object creation in loops
    if (/for[^{]*\{[^}]*(?:new\s+Array|\.push|\[\]|{})/s.test(code)) {
      return 'O(n)';
    }

    // Check for recursive calls with arrays
    if (/(\w+)\s*\([^)]*\)[^}]*\[\s*\.\.\.[^]]*\1\s*\(/.test(code)) {
      return 'O(n) - recursive with array copy';
    }

    // Check for large data structures
    if (/new\s+(?:Map|Set|Array)\s*\(/.test(code)) {
      return 'O(n)';
    }

    return 'O(1)';
  }

  private extractDependencies(code: string): string[] {
    const deps = new Set<string>();

    // Import statements
    const imports = code.matchAll(/import\s+(?:\{[^}]+\}|\*\s+as\s+\w+|\w+)\s+from\s+['"]([^'"]+)['"]/g);
    for (const match of imports) {
      deps.add(match[1]);
    }

    // Require statements
    const requires = code.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const match of requires) {
      deps.add(match[1]);
    }

    // Global references
    const globals = ['console', 'process', 'Buffer', 'setTimeout', 'setInterval', 'fetch'];
    for (const global of globals) {
      if (code.includes(global)) {
        deps.add(`global:${global}`);
      }
    }

    return Array.from(deps);
  }

  private estimateImpact(type: PerformanceIssueType): string {
    const impacts: Record<PerformanceIssueType, string> = {
      'nested-loop': 'High - O(n²) operations cause exponential slowdown',
      'n-plus-one': 'Critical - Database round-trips multiply latency',
      'large-bundle-import': 'Medium - Increases initial load time',
      'synchronous-io': 'High - Blocks entire event loop',
      'memory-leak-potential': 'High - Memory grows over time',
      'inefficient-regex': 'Critical - Can cause ReDoS (seconds to minutes)',
      'unnecessary-rerender': 'Low - Minor UI performance impact',
      'blocking-operation': 'Medium - Can block on large data',
      'excessive-dom-manipulation': 'Medium - Layout thrashing',
      'missing-memoization': 'Low - Redundant calculations',
      'large-array-operation': 'Low - In-place mutations can cause issues',
      'string-concatenation-loop': 'Medium - O(n²) string operations',
      'deep-object-clone': 'Medium - Slow for complex objects',
      'sync-in-async-context': 'Medium - Defeats async benefits'
    };

    return impacts[type] || 'Unknown';
  }

  private collectFiles(
    dir: string,
    include: string[],
    exclude: string[],
    maxFiles: number
  ): string[] {
    const files: string[] = [];

    const walk = (currentDir: string) => {
      if (files.length >= maxFiles) return;
      if (!fs.existsSync(currentDir)) return;

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (files.length >= maxFiles) return;

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (!exclude.some(ex => entry.name === ex || fullPath.includes(ex))) {
            walk(fullPath);
          }
        } else {
          const ext = path.extname(entry.name);
          if (include.some(inc => inc.includes(ext) || entry.name.endsWith(inc.replace('**/*', '')))) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dir);
    return files;
  }

  private generateReport(issues: PerformanceIssue[], metrics: ComplexityMetrics[]): ProfileReport {
    const criticalIssues = issues.filter(i => i.severity === 'critical');
    const warningIssues = issues.filter(i => i.severity === 'warning');
    const infoIssues = issues.filter(i => i.severity === 'info');

    const avgComplexity = metrics.length > 0
      ? metrics.reduce((sum, m) => sum + m.cyclomaticComplexity, 0) / metrics.length
      : 0;

    // Find hotspots (files with most issues or highest complexity)
    const fileIssueCount = new Map<string, number>();
    for (const issue of issues) {
      fileIssueCount.set(issue.file, (fileIssueCount.get(issue.file) || 0) + 1);
    }

    const hotspots = Array.from(fileIssueCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, count]) => `${path.basename(file)} (${count} issues)`);

    // Generate recommendations
    const recommendations: string[] = [];
    if (criticalIssues.length > 0) {
      recommendations.push('Address critical issues immediately - they can cause significant performance problems');
    }
    if (avgComplexity > 15) {
      recommendations.push('Consider refactoring complex functions - high complexity correlates with bugs');
    }
    if (issues.some(i => i.type === 'n-plus-one')) {
      recommendations.push('Implement query batching to fix N+1 problems');
    }
    if (issues.some(i => i.type === 'memory-leak-potential')) {
      recommendations.push('Add cleanup functions for event listeners');
    }

    // Estimate improvements
    const estimatedImprovements = [
      {
        category: 'Database Queries',
        potential: criticalIssues.filter(i => i.type === 'n-plus-one').length > 0 ? 'High' : 'Low',
        effort: 'Medium'
      },
      {
        category: 'Bundle Size',
        potential: issues.filter(i => i.type === 'large-bundle-import').length > 0 ? 'Medium' : 'Low',
        effort: 'Low'
      },
      {
        category: 'Runtime Performance',
        potential: criticalIssues.length > 0 ? 'High' : 'Medium',
        effort: 'High'
      }
    ];

    return {
      summary: {
        totalFiles: metrics.length,
        totalIssues: issues.length,
        criticalIssues: criticalIssues.length,
        warningIssues: warningIssues.length,
        infoIssues: infoIssues.length,
        averageComplexity: avgComplexity,
        hotspots
      },
      issues,
      metrics,
      recommendations,
      estimatedImprovements
    };
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## PerformanceProfiler - Code Performance Analysis

Analyzes code for performance bottlenecks and optimization opportunities.

### Issue Types Detected
- **nested-loop**: O(n²) or worse complexity
- **n-plus-one**: Database queries inside loops
- **large-bundle-import**: Full library imports
- **synchronous-io**: Blocking I/O operations
- **memory-leak-potential**: Missing event listener cleanup
- **inefficient-regex**: Catastrophic backtracking patterns
- **unnecessary-rerender**: Inline JSX functions

### Methods
- \`profileFile(path)\`: Analyze single file
- \`profileProject(path, options)\`: Analyze entire project
- \`analyzeFunction(code, name)\`: Profile specific function
- \`getOptimizationSuggestions(code)\`: Get improvement suggestions
- \`compareVersions(old, new)\`: Compare before/after

### Metrics Calculated
- Cyclomatic Complexity
- Cognitive Complexity
- Time/Space Complexity estimates
- Maintainability Index
- Nesting Depth

### Best Practices
- Focus on critical issues first
- Profile before and after changes
- Track metrics over time
- Address hotspots systematically
    `;
  }
}
