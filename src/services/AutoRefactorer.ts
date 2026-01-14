/**
 * AutoRefactorer
 *
 * Automatically suggests code refactoring opportunities.
 * Identifies code smells, duplication, and improvement patterns.
 *
 * Key behaviors:
 * 1. Detect code smells (long functions, deep nesting, etc.)
 * 2. Find duplicate code across files
 * 3. Suggest design pattern applications
 * 4. Prioritize refactoring by impact
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CodeSmell {
  type: 'long_function' | 'deep_nesting' | 'duplicate_code' | 'large_class' |
        'god_object' | 'feature_envy' | 'primitive_obsession' | 'dead_code' |
        'complex_condition' | 'magic_number' | 'inconsistent_naming';
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line: number;
  endLine?: number;
  description: string;
  suggestion: string;
  effort: 'trivial' | 'easy' | 'moderate' | 'significant';
  impact: 'low' | 'medium' | 'high';
}

export interface DuplicateCode {
  hash: string;
  locations: { file: string; startLine: number; endLine: number }[];
  codeSnippet: string;
  similarity: number; // 0-100%
  linesCount: number;
  suggestion: string;
}

export interface RefactoringOpportunity {
  id: string;
  type: 'extract_function' | 'extract_class' | 'inline' | 'rename' |
        'move' | 'apply_pattern' | 'simplify' | 'consolidate';
  priority: number; // 1-10
  file: string;
  line?: number;
  description: string;
  benefits: string[];
  risks: string[];
  estimatedEffort: 'trivial' | 'easy' | 'moderate' | 'significant';
  suggestedCode?: string;
}

export interface RefactoringReport {
  analyzedFiles: number;
  totalLines: number;
  codeSmells: CodeSmell[];
  duplicates: DuplicateCode[];
  opportunities: RefactoringOpportunity[];
  healthScore: number; // 0-100
  recommendations: string[];
  timestamp: number;
}

// Thresholds for code smells
const THRESHOLDS = {
  maxFunctionLength: 50,
  maxClassLength: 300,
  maxNestingDepth: 4,
  maxConditionComplexity: 5,
  minDuplicateLines: 6,
  maxFileLength: 500,
  maxParameters: 5,
};

export class AutoRefactorer {
  /**
   * Analyze codebase and generate refactoring report
   */
  static async analyze(workspacePath: string, options?: {
    fileFilter?: string[];
    ignorePatterns?: string[];
    strictMode?: boolean;
  }): Promise<RefactoringReport> {
    console.log(`\n🔧 [AutoRefactorer] Analyzing codebase...`);

    const files = await this.findSourceFiles(workspacePath, options?.ignorePatterns);
    let totalLines = 0;
    const codeSmells: CodeSmell[] = [];
    const opportunities: RefactoringOpportunity[] = [];
    const codeBlocks: Map<string, { file: string; startLine: number; endLine: number; code: string }[]> = new Map();

    for (const file of files) {
      if (options?.fileFilter && !options.fileFilter.some(f => file.includes(f))) {
        continue;
      }

      try {
        const fullPath = path.join(workspacePath, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');
        totalLines += lines.length;

        // Detect code smells
        const fileSmells = this.detectCodeSmells(file, content, lines);
        codeSmells.push(...fileSmells);

        // Collect code blocks for duplicate detection
        this.collectCodeBlocks(file, lines, codeBlocks);

        // Generate opportunities from smells
        const fileOpportunities = this.generateOpportunities(file, fileSmells, content);
        opportunities.push(...fileOpportunities);

      } catch {
        // Skip files that can't be read
      }
    }

    // Detect duplicates
    const duplicates = this.detectDuplicates(codeBlocks);

    // Add duplicate-based opportunities
    for (const dup of duplicates) {
      opportunities.push({
        id: `dup-${dup.hash.substring(0, 8)}`,
        type: 'consolidate',
        priority: Math.min(10, Math.ceil(dup.linesCount / 5)),
        file: dup.locations[0].file,
        line: dup.locations[0].startLine,
        description: `Consolidate ${dup.locations.length} duplicate code blocks (${dup.linesCount} lines each)`,
        benefits: [
          `Reduce ${dup.linesCount * (dup.locations.length - 1)} lines of duplicated code`,
          'Single source of truth for this logic',
          'Easier maintenance',
        ],
        risks: ['Might need to handle slight variations'],
        estimatedEffort: dup.linesCount > 20 ? 'moderate' : 'easy',
      });
    }

    // Sort opportunities by priority
    opportunities.sort((a, b) => b.priority - a.priority);

    // Calculate health score
    const healthScore = this.calculateHealthScore(totalLines, codeSmells, duplicates);

    // Generate recommendations
    const recommendations = this.generateRecommendations(codeSmells, duplicates, opportunities);

    console.log(`   Analyzed ${files.length} files (${totalLines} lines)`);
    console.log(`   Found ${codeSmells.length} code smells`);
    console.log(`   Found ${duplicates.length} duplicate blocks`);
    console.log(`   Generated ${opportunities.length} refactoring opportunities`);
    console.log(`   Health score: ${healthScore}/100`);

    return {
      analyzedFiles: files.length,
      totalLines,
      codeSmells,
      duplicates,
      opportunities: opportunities.slice(0, 50), // Top 50
      healthScore,
      recommendations,
      timestamp: Date.now(),
    };
  }

  /**
   * Detect code smells in a file
   */
  private static detectCodeSmells(file: string, content: string, lines: string[]): CodeSmell[] {
    const smells: CodeSmell[] = [];

    // Check file length
    if (lines.length > THRESHOLDS.maxFileLength) {
      smells.push({
        type: 'large_class',
        severity: lines.length > 800 ? 'high' : 'medium',
        file,
        line: 1,
        description: `File has ${lines.length} lines (threshold: ${THRESHOLDS.maxFileLength})`,
        suggestion: 'Consider splitting into smaller modules',
        effort: 'significant',
        impact: 'high',
      });
    }

    // Detect long functions
    const functions = this.findFunctions(content);
    for (const func of functions) {
      if (func.lines > THRESHOLDS.maxFunctionLength) {
        smells.push({
          type: 'long_function',
          severity: func.lines > 100 ? 'high' : 'medium',
          file,
          line: func.startLine,
          endLine: func.endLine,
          description: `Function '${func.name}' has ${func.lines} lines (threshold: ${THRESHOLDS.maxFunctionLength})`,
          suggestion: 'Extract smaller helper functions',
          effort: 'moderate',
          impact: 'medium',
        });
      }

      // Check parameter count
      if (func.params > THRESHOLDS.maxParameters) {
        smells.push({
          type: 'primitive_obsession',
          severity: 'medium',
          file,
          line: func.startLine,
          description: `Function '${func.name}' has ${func.params} parameters (threshold: ${THRESHOLDS.maxParameters})`,
          suggestion: 'Consider using an options object',
          effort: 'easy',
          impact: 'low',
        });
      }
    }

    // Detect deep nesting
    let nestingDepth = 0;
    let maxNesting = 0;
    let maxNestingLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;

      nestingDepth += opens - closes;

      if (nestingDepth > maxNesting) {
        maxNesting = nestingDepth;
        maxNestingLine = i + 1;
      }
    }

    if (maxNesting > THRESHOLDS.maxNestingDepth) {
      smells.push({
        type: 'deep_nesting',
        severity: maxNesting > 6 ? 'high' : 'medium',
        file,
        line: maxNestingLine,
        description: `Maximum nesting depth is ${maxNesting} (threshold: ${THRESHOLDS.maxNestingDepth})`,
        suggestion: 'Use early returns, extract functions, or flatten conditions',
        effort: 'moderate',
        impact: 'medium',
      });
    }

    // Detect complex conditions
    const complexConditions = content.match(/if\s*\([^)]{100,}\)/g) || [];
    for (const condition of complexConditions) {
      const lineNum = this.findLineNumber(content, condition);
      smells.push({
        type: 'complex_condition',
        severity: 'medium',
        file,
        line: lineNum,
        description: 'Complex condition with many terms',
        suggestion: 'Extract condition into a named boolean variable or function',
        effort: 'easy',
        impact: 'medium',
      });
    }

    // Detect magic numbers
    const magicNumbers = content.matchAll(/(?<![a-zA-Z0-9_])(\d{2,})(?![a-zA-Z0-9_'"])/g);
    const seenNumbers = new Set<string>();

    for (const match of magicNumbers) {
      const num = match[1];
      if (!seenNumbers.has(num) && !['10', '100', '1000', '60', '24', '365'].includes(num)) {
        seenNumbers.add(num);
        const lineNum = this.findLineNumber(content, match[0]);
        smells.push({
          type: 'magic_number',
          severity: 'low',
          file,
          line: lineNum,
          description: `Magic number '${num}' without explanation`,
          suggestion: 'Extract to a named constant with descriptive name',
          effort: 'trivial',
          impact: 'low',
        });
      }
    }

    // Detect dead code (unused variables)
    const declarations = content.matchAll(/(?:const|let|var)\s+(\w+)\s*=/g);
    for (const match of declarations) {
      const varName = match[1];
      const regex = new RegExp(`\\b${varName}\\b`, 'g');
      const occurrences = (content.match(regex) || []).length;

      if (occurrences === 1 && !varName.startsWith('_')) {
        const lineNum = this.findLineNumber(content, match[0]);
        smells.push({
          type: 'dead_code',
          severity: 'low',
          file,
          line: lineNum,
          description: `Variable '${varName}' is declared but never used`,
          suggestion: 'Remove unused variable or prefix with _ if intentional',
          effort: 'trivial',
          impact: 'low',
        });
      }
    }

    return smells;
  }

  /**
   * Find functions in code
   */
  private static findFunctions(content: string): {
    name: string;
    startLine: number;
    endLine: number;
    lines: number;
    params: number;
  }[] {
    const functions: {
      name: string;
      startLine: number;
      endLine: number;
      lines: number;
      params: number;
    }[] = [];

    const lines = content.split('\n');
    let braceCount = 0;
    let currentFunc: { name: string; startLine: number; params: number } | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect function start
      const funcMatch = line.match(/(?:async\s+)?(?:function\s+(\w+)|(\w+)\s*[:=]\s*(?:async\s+)?(?:function|\([^)]*\)\s*(?:=>|\{)))/);

      if (funcMatch && !currentFunc) {
        const name = funcMatch[1] || funcMatch[2] || 'anonymous';
        const params = (line.match(/\(([^)]*)\)/)?.[1] || '').split(',').filter(p => p.trim()).length;

        currentFunc = { name, startLine: i + 1, params };
        braceCount = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      } else if (currentFunc) {
        braceCount += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;

        if (braceCount <= 0) {
          functions.push({
            ...currentFunc,
            endLine: i + 1,
            lines: i + 1 - currentFunc.startLine,
          });
          currentFunc = null;
          braceCount = 0;
        }
      }
    }

    return functions;
  }

  /**
   * Find line number for a code snippet
   */
  private static findLineNumber(content: string, snippet: string): number {
    const index = content.indexOf(snippet);
    if (index === -1) return 1;
    return content.substring(0, index).split('\n').length;
  }

  /**
   * Collect code blocks for duplicate detection
   */
  private static collectCodeBlocks(
    file: string,
    lines: string[],
    blocks: Map<string, { file: string; startLine: number; endLine: number; code: string }[]>
  ): void {
    const minLines = THRESHOLDS.minDuplicateLines;

    for (let i = 0; i <= lines.length - minLines; i++) {
      const block = lines.slice(i, i + minLines)
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('*'))
        .join('\n');

      if (block.length < 50) continue; // Skip trivial blocks

      // Simple hash
      const hash = this.simpleHash(block);

      if (!blocks.has(hash)) {
        blocks.set(hash, []);
      }

      blocks.get(hash)!.push({
        file,
        startLine: i + 1,
        endLine: i + minLines,
        code: block,
      });
    }
  }

  /**
   * Simple hash function
   */
  private static simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Detect duplicate code blocks
   */
  private static detectDuplicates(
    blocks: Map<string, { file: string; startLine: number; endLine: number; code: string }[]>
  ): DuplicateCode[] {
    const duplicates: DuplicateCode[] = [];

    for (const [hash, locations] of blocks) {
      // Only consider blocks that appear in multiple locations or files
      if (locations.length >= 2) {
        // Filter out overlapping blocks in the same file
        const uniqueLocations = this.filterOverlapping(locations);

        if (uniqueLocations.length >= 2) {
          const firstBlock = locations[0];
          duplicates.push({
            hash,
            locations: uniqueLocations.map(l => ({
              file: l.file,
              startLine: l.startLine,
              endLine: l.endLine,
            })),
            codeSnippet: firstBlock.code.substring(0, 200),
            similarity: 100,
            linesCount: THRESHOLDS.minDuplicateLines,
            suggestion: `Extract to shared function or utility`,
          });
        }
      }
    }

    // Sort by number of duplicates
    duplicates.sort((a, b) => b.locations.length - a.locations.length);

    return duplicates.slice(0, 20); // Top 20 duplicates
  }

  /**
   * Filter overlapping code blocks
   */
  private static filterOverlapping(
    locations: { file: string; startLine: number; endLine: number; code: string }[]
  ): { file: string; startLine: number; endLine: number; code: string }[] {
    const result: { file: string; startLine: number; endLine: number; code: string }[] = [];

    for (const loc of locations) {
      const overlaps = result.some(r =>
        r.file === loc.file &&
        Math.max(r.startLine, loc.startLine) <= Math.min(r.endLine, loc.endLine)
      );

      if (!overlaps) {
        result.push(loc);
      }
    }

    return result;
  }

  /**
   * Generate refactoring opportunities from smells
   */
  private static generateOpportunities(
    file: string,
    smells: CodeSmell[],
    _content: string
  ): RefactoringOpportunity[] {
    const opportunities: RefactoringOpportunity[] = [];

    for (const smell of smells) {
      switch (smell.type) {
        case 'long_function':
          opportunities.push({
            id: `extract-${file}-${smell.line}`,
            type: 'extract_function',
            priority: smell.severity === 'high' ? 8 : 6,
            file,
            line: smell.line,
            description: `Extract helper functions from long function`,
            benefits: ['Improved readability', 'Better testability', 'Reusable code'],
            risks: ['May need to pass more parameters'],
            estimatedEffort: 'moderate',
          });
          break;

        case 'large_class':
          opportunities.push({
            id: `split-${file}`,
            type: 'extract_class',
            priority: 9,
            file,
            description: `Split large file into smaller modules`,
            benefits: ['Single responsibility', 'Easier navigation', 'Better imports'],
            risks: ['Breaking changes to imports'],
            estimatedEffort: 'significant',
          });
          break;

        case 'deep_nesting':
          opportunities.push({
            id: `simplify-${file}-${smell.line}`,
            type: 'simplify',
            priority: 7,
            file,
            line: smell.line,
            description: `Reduce nesting with early returns or extraction`,
            benefits: ['Clearer logic flow', 'Easier debugging'],
            risks: ['Logic changes need testing'],
            estimatedEffort: 'moderate',
          });
          break;

        case 'complex_condition':
          opportunities.push({
            id: `extract-cond-${file}-${smell.line}`,
            type: 'extract_function',
            priority: 5,
            file,
            line: smell.line,
            description: `Extract complex condition to named function`,
            benefits: ['Self-documenting code', 'Reusable condition'],
            risks: ['Minor overhead'],
            estimatedEffort: 'easy',
          });
          break;

        case 'primitive_obsession':
          opportunities.push({
            id: `options-${file}-${smell.line}`,
            type: 'apply_pattern',
            priority: 4,
            file,
            line: smell.line,
            description: `Replace multiple parameters with options object`,
            benefits: ['Named parameters', 'Optional defaults', 'Easier to extend'],
            risks: ['Breaking change to callers'],
            estimatedEffort: 'easy',
          });
          break;
      }
    }

    return opportunities;
  }

  /**
   * Calculate health score
   */
  private static calculateHealthScore(
    totalLines: number,
    smells: CodeSmell[],
    duplicates: DuplicateCode[]
  ): number {
    let score = 100;

    // Deduct for smells
    for (const smell of smells) {
      const deduction = {
        critical: 10,
        high: 5,
        medium: 2,
        low: 1,
      }[smell.severity];
      score -= deduction;
    }

    // Deduct for duplicates
    for (const dup of duplicates) {
      score -= dup.locations.length * dup.linesCount * 0.1;
    }

    // Bonus for reasonable file sizes
    if (totalLines > 0) {
      const avgLinesPerFile = totalLines / Math.max(1, smells.filter(s => s.type === 'large_class').length || 1);
      if (avgLinesPerFile < 300) {
        score += 5;
      }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Generate recommendations
   */
  private static generateRecommendations(
    smells: CodeSmell[],
    duplicates: DuplicateCode[],
    opportunities: RefactoringOpportunity[]
  ): string[] {
    const recommendations: string[] = [];

    // Group smells by type
    const smellCounts = smells.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Top issues
    if (smellCounts['long_function'] > 3) {
      recommendations.push(`🎯 Focus on breaking down ${smellCounts['long_function']} long functions`);
    }

    if (smellCounts['large_class'] > 0) {
      recommendations.push(`📦 Consider splitting ${smellCounts['large_class']} large files`);
    }

    if (duplicates.length > 5) {
      const totalDupLines = duplicates.reduce((sum, d) => sum + d.linesCount * d.locations.length, 0);
      recommendations.push(`🔄 Eliminate ~${totalDupLines} lines of duplicated code`);
    }

    if (smellCounts['deep_nesting'] > 2) {
      recommendations.push(`⬆️ Flatten ${smellCounts['deep_nesting']} deeply nested code blocks`);
    }

    // Quick wins
    const quickWins = opportunities.filter(o => o.estimatedEffort === 'trivial' || o.estimatedEffort === 'easy');
    if (quickWins.length > 0) {
      recommendations.push(`⚡ ${quickWins.length} quick refactoring wins available`);
    }

    // High priority
    const highPriority = opportunities.filter(o => o.priority >= 8);
    if (highPriority.length > 0) {
      recommendations.push(`🔥 ${highPriority.length} high-priority refactorings recommended`);
    }

    return recommendations.slice(0, 5);
  }

  /**
   * Find source files
   */
  private static async findSourceFiles(workspacePath: string, ignorePatterns?: string[]): Promise<string[]> {
    const files: string[] = [];

    const walk = (dir: string, prefix: string = ''): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
            continue;
          }

          const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

          // Check ignore patterns
          if (ignorePatterns?.some(p => relativePath.includes(p))) {
            continue;
          }

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            walk(fullPath, relativePath);
          } else if (entry.name.match(/\.(ts|tsx|js|jsx)$/) && !entry.name.includes('.test.') && !entry.name.includes('.spec.')) {
            files.push(relativePath);
          }
        }
      } catch {
        // Ignore errors
      }
    };

    walk(workspacePath);
    return files;
  }

  /**
   * Format report for prompt
   */
  static formatReportForPrompt(report: RefactoringReport): string {
    const scoreIcon = report.healthScore >= 80 ? '🟢' :
                      report.healthScore >= 60 ? '🟡' :
                      report.healthScore >= 40 ? '🟠' : '🔴';

    let output = `
## 🔧 Refactoring Analysis Report

**Health Score**: ${scoreIcon} ${report.healthScore}/100
**Files Analyzed**: ${report.analyzedFiles}
**Total Lines**: ${report.totalLines.toLocaleString()}
**Code Smells**: ${report.codeSmells.length}
**Duplicates**: ${report.duplicates.length}
**Opportunities**: ${report.opportunities.length}

### 🎯 Top Recommendations:
${report.recommendations.map((r, i) => `${i + 1}. ${r}`).join('\n')}

### 🔥 High-Priority Refactorings:
`;

    const topOpportunities = report.opportunities.slice(0, 5);
    for (const opp of topOpportunities) {
      output += `
**${opp.description}**
- File: \`${opp.file}${opp.line ? `:${opp.line}` : ''}\`
- Type: ${opp.type}
- Effort: ${opp.estimatedEffort}
- Benefits: ${opp.benefits.slice(0, 2).join(', ')}
`;
    }

    if (report.duplicates.length > 0) {
      output += `\n### 🔄 Duplicate Code:\n`;
      for (const dup of report.duplicates.slice(0, 3)) {
        output += `- ${dup.locations.length}x in ${dup.locations.map(l => l.file).join(', ')} (${dup.linesCount} lines)\n`;
      }
    }

    return output;
  }

  /**
   * Generate instructions for agents
   */
  static generateInstructions(): string {
    return `
## 🔧 AUTO-REFACTORING

The system automatically detects refactoring opportunities:

### Code Smells Detected:

| Smell | Threshold | Action |
|-------|-----------|--------|
| Long Function | >50 lines | Extract helpers |
| Large File | >500 lines | Split module |
| Deep Nesting | >4 levels | Flatten/extract |
| Many Parameters | >5 params | Use options object |
| Magic Numbers | Hard-coded | Extract constants |
| Duplicate Code | >6 lines | Consolidate |

### Priority Levels:

- **9-10**: Critical - fix before adding features
- **7-8**: High - schedule for next sprint
- **5-6**: Medium - address when touching file
- **1-4**: Low - nice to have

### Refactoring Types:

- **extract_function**: Pull out reusable logic
- **extract_class**: Split large modules
- **consolidate**: Merge duplicates
- **simplify**: Flatten complex code
- **apply_pattern**: Use design patterns

### Health Score:

- 🟢 80-100: Excellent - well-maintained
- 🟡 60-79: Good - minor improvements needed
- 🟠 40-59: Fair - schedule refactoring
- 🔴 0-39: Poor - prioritize cleanup
`;
  }
}
